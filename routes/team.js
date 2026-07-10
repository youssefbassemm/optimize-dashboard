'use strict';

/**
 * /api/:brand_id/team
 *
 * GET  /              — list current members + pending invites
 * POST /invite        — invite a new member by email
 * POST /accept-invite — accept an invite token (public, no brand auth required)
 * DELETE /:user_id    — remove a member from the brand
 */

const express        = require('express');
const crypto         = require('crypto');
const bcrypt         = require('bcryptjs');
const router         = express.Router({ mergeParams: true });
const db             = require('../db/db');
const { sendMail }   = require('../lib/mailer');

const BCRYPT_ROUNDS   = 12;
const INVITE_TTL_HOURS = 48;

// ── GET /api/:brand_id/team ───────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const { brand_id } = req.params;
    const members = db.getTeamMembers(brand_id);
    const invites = db.getPendingInvites(brand_id);
    res.json({ ok: true, members, pending_invites: invites });
  } catch (err) {
    console.error('[team] GET error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to load team' });
  }
});

// ── POST /api/:brand_id/team/invite ──────────────────────────────────────────
// Creates an invite token and (when SMTP is configured) emails it.
// Returns the invite URL in non-production for testing.
router.post('/invite', async (req, res) => {
  const { brand_id } = req.params;
  const { email, role = 'member' } = req.body;

  if (!email) {
    return res.status(400).json({ ok: false, error: 'email is required' });
  }
  if (!['owner', 'admin', 'member'].includes(role)) {
    return res.status(400).json({ ok: false, error: 'role must be owner, admin, or member' });
  }

  const emailNorm = email.toLowerCase().trim();

  // Prevent inviting someone already on the team
  const existing = db.findUserByEmail(emailNorm);
  if (existing && db.userHasBrandAccess(existing.id, brand_id)) {
    return res.status(409).json({ ok: false, error: 'This person is already a member of this brand' });
  }

  try {
    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000).toISOString();
    const createdBy = req.user?.id || null;

    db.createTeamInvite(brand_id, emailNorm, role, tokenHash, expiresAt, createdBy);

    const brand     = db.getBrand(brand_id);
    const brandName = brand?.name || 'Optimize';
    const inviteUrl = `${process.env.SERVER_URL || ''}/accept-invite?token=${rawToken}`;

    const mailResult = await sendMail({
      to:      emailNorm,
      subject: `You've been invited to ${brandName} on Optimize`,
      html: `
        <p>Hi,</p>
        <p>You've been invited to join <strong>${brandName}</strong> on Optimize as a <strong>${role}</strong>.</p>
        <p><a href="${inviteUrl}" style="color:#C49A55;font-weight:bold">Accept invitation</a></p>
        <p>This invite expires in <strong>48 hours</strong>.</p>
        <p style="color:#888;font-size:12px">If the button above doesn't work, paste this URL into your browser:<br>${inviteUrl}</p>
      `,
      text: `You've been invited to ${brandName} on Optimize. Accept here: ${inviteUrl}\n\nExpires in 48 hours.`,
    });

    console.log(`[team] invite for ${emailNorm} to brand=${brand_id} — email ${mailResult.sent ? 'sent' : 'NOT sent: ' + mailResult.reason}`);

    const payload = { ok: true, message: `Invite sent to ${emailNorm}` };
    // Always surface invite URL for admin in non-production (dev convenience)
    // In production, also include it so the admin can manually share if SMTP fails
    payload.invite_url = process.env.NODE_ENV !== 'production' ? inviteUrl : undefined;
    if (!mailResult.sent) {
      payload.warning   = 'Email delivery failed — share the invite link manually.';
      payload.invite_url = inviteUrl;
    }

    res.status(201).json(payload);
  } catch (err) {
    console.error('[team] invite error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to create invite' });
  }
});

// ── DELETE /api/:brand_id/team/:user_id ──────────────────────────────────────
// Removes a member from the brand. Owners cannot remove themselves.
router.delete('/:user_id', (req, res) => {
  const { brand_id, user_id } = req.params;

  if (req.user?.id && String(req.user.id) === String(user_id)) {
    return res.status(400).json({ ok: false, error: 'You cannot remove yourself from the brand' });
  }

  try {
    db.db.prepare('DELETE FROM user_brands WHERE user_id = ? AND brand_id = ?')
      .run(user_id, brand_id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[team] delete member error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to remove member' });
  }
});

module.exports = router;

// ── POST /api/auth/accept-invite ─────────────────────────────────────────────
// This endpoint lives in routes/auth.js because it's a public route (no brand_id).
// Exported here for reference — the actual handler is in routes/auth.js.
