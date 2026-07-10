'use strict';

/**
 * /api/cx/webhook — n8n callback endpoints (no brand auth).
 *
 * n8n calls these after processing a CX message:
 *
 *   POST /api/cx/webhook/sent      — message sent by WhatsApp provider
 *   POST /api/cx/webhook/delivered — delivery confirmed
 *   POST /api/cx/webhook/failed    — delivery failed
 *
 * Security: optional HMAC signature verification via CX_WEBHOOK_SECRET env var.
 * If not set, requests are accepted from any source (configure n8n IP allowlist instead).
 *
 * Payload: { message_id, n8n_execution_id?, reason? }
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const db      = require('../db/db');

// This router is mounted BEFORE global express.json() (to preserve raw body for HMAC).
// We add our own json parser so req.body is available.
router.use(express.json());

const CX_WEBHOOK_SECRET = process.env.CX_WEBHOOK_SECRET || null;

/**
 * Verify optional HMAC-SHA256 signature on n8n callbacks.
 * Header: X-CX-Signature: sha256=<hex>
 * Signed content: raw request body as UTF-8 string.
 */
function verifyCxSignature(req) {
  if (!CX_WEBHOOK_SECRET) return true; // No secret set — accept all
  const sig = req.headers['x-cx-signature'] || '';
  if (!sig.startsWith('sha256=')) return false;
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const expected = 'sha256=' + crypto.createHmac('sha256', CX_WEBHOOK_SECRET).update(body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ── POST /api/cx/webhook/sent ─────────────────────────────────────────────────
router.post('/sent', (req, res) => {
  if (!verifyCxSignature(req)) {
    return res.status(401).json({ ok: false, error: 'Invalid signature' });
  }

  const { message_id, n8n_execution_id } = req.body || {};
  if (!message_id) {
    return res.status(400).json({ ok: false, error: 'message_id required' });
  }

  try {
    db.updateCxMessageStatus(Number(message_id), 'sent', { n8n_execution_id: n8n_execution_id || null });
    console.log(`[cx-webhook] sent: message_id=${message_id} exec=${n8n_execution_id || 'n/a'}`);
    return res.json({ ok: true, message_id, status: 'sent' });
  } catch (err) {
    console.error('[cx-webhook] sent error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/cx/webhook/delivered ───────────────────────────────────────────
router.post('/delivered', (req, res) => {
  if (!verifyCxSignature(req)) {
    return res.status(401).json({ ok: false, error: 'Invalid signature' });
  }

  const { message_id } = req.body || {};
  if (!message_id) {
    return res.status(400).json({ ok: false, error: 'message_id required' });
  }

  try {
    db.updateCxMessageStatus(Number(message_id), 'delivered', {});
    console.log(`[cx-webhook] delivered: message_id=${message_id}`);
    return res.json({ ok: true, message_id, status: 'delivered' });
  } catch (err) {
    console.error('[cx-webhook] delivered error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/cx/webhook/failed ───────────────────────────────────────────────
router.post('/failed', (req, res) => {
  if (!verifyCxSignature(req)) {
    return res.status(401).json({ ok: false, error: 'Invalid signature' });
  }

  const { message_id, reason } = req.body || {};
  if (!message_id) {
    return res.status(400).json({ ok: false, error: 'message_id required' });
  }

  try {
    db.updateCxMessageStatus(Number(message_id), 'failed', { failed_reason: reason || null });
    console.log(`[cx-webhook] failed: message_id=${message_id} reason=${reason || 'n/a'}`);
    return res.json({ ok: true, message_id, status: 'failed' });
  } catch (err) {
    console.error('[cx-webhook] failed error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
