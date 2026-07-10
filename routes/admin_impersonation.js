'use strict';

/**
 * Admin impersonation routes — mounted at /api/admin in server.js.
 * All routes protected by requireAdminAuth (applied at server.js mount level).
 *
 *  POST /api/admin/brands/:brand_id/impersonate
 *    Body: { reason: string (min 20 chars) }
 *    Generates a 30-min impersonation JWT + persists the session audit row.
 *    Returns: { ok, token, session_id, brand_id, expires_in }
 *
 *  POST /api/admin/impersonation/end
 *    Body: { session_id: string }
 *    Revokes an active session before its JWT expires.
 *
 *  GET /api/admin/impersonation/sessions
 *    Optional query: brand_id, limit (max 100)
 *    Returns recent impersonation sessions for the audit trail.
 */

const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const db      = require('../db/db');

const JWT_SECRET = process.env.JWT_SECRET || 'replace-me-in-env';

// ── POST /api/admin/brands/:brand_id/impersonate ──────────────────────────────
router.post('/brands/:brand_id/impersonate', (req, res) => {
  const { brand_id } = req.params;
  const { reason }   = req.body || {};

  // Validate reason — must be at least 20 chars (audit trail quality gate)
  if (!reason || reason.trim().length < 20) {
    return res.status(400).json({
      ok:    false,
      error: 'reason must be at least 20 characters to ensure audit quality',
    });
  }

  const brand = db.getBrand(brand_id);
  if (!brand) {
    return res.status(404).json({ ok: false, error: `Brand "${brand_id}" not found` });
  }

  // Resolve the brand owner — we embed their userId in the JWT so the
  // brand API routes that call getUserById() have a valid user to load.
  const owner = db.db.prepare(`
    SELECT u.id FROM users u
    JOIN user_brands ub ON ub.user_id = u.id
    WHERE ub.brand_id = ? AND ub.role = 'owner'
    ORDER BY ub.created_at ASC LIMIT 1
  `).get(brand_id);

  const sessionId = crypto.randomUUID();
  const userId    = owner ? owner.id : 0;

  // Persist the audit row BEFORE signing the JWT so any DB error prevents issuance
  try {
    db.createImpersonationSession(sessionId, brand_id, userId, reason.trim());
  } catch (err) {
    console.error('[impersonation] failed to create session row:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to create impersonation session' });
  }

  // Sign a 30-minute JWT using the same secret as brand JWTs.
  // requireAuth in middleware/auth.js will verify this token and attach
  // req.user.impersonated_by so blockImpersonation can gate mutations.
  const EXPIRES_IN = 30 * 60; // 30 minutes in seconds
  const token = jwt.sign(
    {
      brandId:                  brand_id,
      userId,
      tier:                     brand.tier || 'free',
      impersonated_by:          'admin',
      impersonation_session_id: sessionId,
    },
    JWT_SECRET,
    { expiresIn: EXPIRES_IN }
  );

  // Audit event
  db.insertEvent(brand_id, null, 'admin_impersonation_start', {
    session_id: sessionId,
    reason:     reason.trim(),
  });

  console.log(`[impersonation] session started brand=${brand_id} session=${sessionId}`);

  return res.json({
    ok:          true,
    token,
    session_id:  sessionId,
    brand_id,
    expires_in:  EXPIRES_IN,
  });
});

// ── POST /api/admin/impersonation/end ─────────────────────────────────────────
router.post('/impersonation/end', (req, res) => {
  const { session_id } = req.body || {};
  if (!session_id) {
    return res.status(400).json({ ok: false, error: 'session_id is required' });
  }

  const session = db.getImpersonationSession(session_id);
  if (!session) {
    return res.status(404).json({ ok: false, error: `Session "${session_id}" not found` });
  }

  db.revokeImpersonationSession(session_id);

  // Audit event
  db.insertEvent(session.brand_id, null, 'admin_impersonation_end', {
    session_id,
    revoked_by: 'admin',
  });

  console.log(`[impersonation] session revoked session=${session_id} brand=${session.brand_id}`);

  return res.json({ ok: true, session_id, revoked: true });
});

// ── GET /api/admin/impersonation/sessions ─────────────────────────────────────
router.get('/impersonation/sessions', (req, res) => {
  const { brand_id } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

  try {
    let sql    = 'SELECT * FROM impersonation_sessions WHERE 1=1';
    const args = [];
    if (brand_id) { sql += ' AND brand_id = ?'; args.push(brand_id); }
    sql += ' ORDER BY started_at DESC LIMIT ?';
    args.push(limit);

    const sessions = db.db.prepare(sql).all(...args);
    return res.json({ ok: true, count: sessions.length, sessions });
  } catch (err) {
    console.error('[impersonation] sessions query error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to query sessions' });
  }
});

module.exports = router;
