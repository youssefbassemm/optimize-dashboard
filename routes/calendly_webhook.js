'use strict';

/**
 * /api/calendly/webhook — Receive Calendly booking notifications.
 *
 * POST /api/calendly/webhook
 *   Called by Calendly when a prospect books a time slot.
 *   Matches the lead by email and updates booked_calendly=1.
 *   Fires a WhatsApp alert via n8n.
 *
 * Calendly sends: invitee.email, invitee.name, event.uri, etc.
 * See: https://developer.calendly.com/api-docs/webhook
 *
 * Auth: Optional HMAC-SHA256 signature via Calendly-Webhook-Signature header.
 *       Set CALENDLY_WEBHOOK_SECRET in env to enable verification.
 *       Without it, any POST is accepted (add IP allowlist in production).
 *
 * NOTE: This route MUST be mounted before express.json() in server.js so the
 * raw body is available for HMAC verification.
 */

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const { db: rawDb, markLeadCalendlyBooked } = require('../db/db');

// ── HMAC verification ─────────────────────────────────────────────────────────
function verifyCalendlySignature(req) {
  const secret = process.env.CALENDLY_WEBHOOK_SECRET;
  if (!secret) return true; // not configured — accept all

  const sig = req.headers['calendly-webhook-signature'] || '';
  if (!sig) return false;

  // Calendly uses t=<timestamp>,v1=<hmac>
  const parts  = Object.fromEntries(sig.split(',').map(p => p.split('=')));
  const ts     = parts.t;
  const v1     = parts.v1;
  if (!ts || !v1) return false;

  const payload  = ts + '.' + (req.rawBody || '');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}

// ── n8n fanout ────────────────────────────────────────────────────────────────
async function fireN8nBooking(payload) {
  const url = process.env.N8N_LEAD_WEBHOOK_URL;
  if (!url) return;
  try {
    const resp = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(8000),
    });
    if (!resp.ok) console.warn(`[calendly-webhook] n8n HTTP ${resp.status}`);
  } catch (err) {
    console.warn('[calendly-webhook] n8n failed (non-fatal):', err.message);
  }
}

// ── POST /api/calendly/webhook ────────────────────────────────────────────────
router.post('/', express.json(), express.text({ type: '*/*' }), (req, res) => {
  // Verify signature if configured
  if (!verifyCalendlySignature(req)) {
    console.warn('[calendly-webhook] signature mismatch — rejected');
    return res.status(403).json({ ok: false, error: 'Invalid signature' });
  }

  const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
  const event = body.event || '';

  // We only care about invitee.created (booking confirmed)
  if (event !== 'invitee.created') {
    return res.json({ ok: true, skipped: true, event });
  }

  const payload       = body.payload || {};
  const invitee       = payload.invitee || {};
  const eventResource = payload.event   || {};

  const email     = String(invitee.email || '').trim().toLowerCase();
  const name      = String(invitee.name  || '').trim();
  const eventUri  = String(eventResource.uri || invitee.event || '').trim();
  const startTime = eventResource.start_time || null;

  if (!email) {
    console.warn('[calendly-webhook] no email in payload');
    return res.json({ ok: true, skipped: true, reason: 'no_email' });
  }

  // Find lead by email (most recent)
  const lead = rawDb.prepare(
    'SELECT id, brand_name, contact_name, phone, revenue_range FROM leads WHERE email = ? ORDER BY created_at DESC LIMIT 1'
  ).get(email);

  if (lead) {
    try {
      markLeadCalendlyBooked(lead.id, eventUri || null);
      console.log(`[calendly-webhook] lead ${lead.id} (${email}) booked — event=${eventUri}`);
    } catch (err) {
      console.error('[calendly-webhook] DB update error:', err.message);
    }

    // Fire n8n booking alert (non-blocking)
    const serverUrl = process.env.SERVER_URL || 'https://optimize-backend-production.up.railway.app';
    fireN8nBooking({
      event:        'lead_booked_call',
      lead_id:      lead.id,
      brand_name:   lead.brand_name,
      contact_name: lead.contact_name,
      phone:        lead.phone,
      email,
      revenue_range: lead.revenue_range,
      event_uri:    eventUri,
      start_time:   startTime,
      booked_at:    new Date().toISOString(),
      admin_url:    `${serverUrl}/admin#form-leads`,
    }).catch(() => {});
  } else {
    console.warn(`[calendly-webhook] no lead found for email=${email}`);
  }

  return res.json({ ok: true, matched: !!lead, email });
});

module.exports = router;
