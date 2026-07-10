'use strict';

/**
 * POST /api/events
 *
 * Receives client-side events from the dashboard (fireClientEvent() calls) and
 * writes them to the internal events table + optional n8n fanout.
 *
 * Auth: requireAuth — only authenticated users can write events.
 *       No brand-ownership check is needed; brand_id is taken from the JWT,
 *       never from the request body (prevents cross-brand event injection).
 *
 * Rate limit: 30 requests per user per minute (in-memory; minute-boundary reset).
 *             Silently drops the request with 429 when the limit is exceeded.
 *             The limit is intentionally lenient — dashboard events are low-frequency.
 *
 * Body:  { event: string, payload?: object }
 * Reply: { ok: true }
 */

const express = require('express');
const router  = express.Router();

const { requireAuth } = require('../middleware/auth');
const { fireLeadWebhook } = require('../lib/webhooks');

// ── In-memory rate limiter ─────────────────────────────────────────────────────
// Map: userId → { windowStart: unixMin, count: number }
// windowStart is the current UTC minute as a unix integer (Math.floor(Date.now() / 60000)).
// On each request: if windowStart !== currentMinute reset; if count >= 30 reject.
//
const RATE_LIMIT     = 30;  // max requests per window
const _rateLimitMap  = new Map();

function _checkRateLimit(userId) {
  const nowMin = Math.floor(Date.now() / 60000);  // current UTC minute
  const entry  = _rateLimitMap.get(userId);

  if (!entry || entry.windowStart !== nowMin) {
    // New window — reset counter
    _rateLimitMap.set(userId, { windowStart: nowMin, count: 1 });
    return true;  // allow
  }

  if (entry.count >= RATE_LIMIT) {
    return false; // blocked
  }

  entry.count += 1;
  return true; // allow
}

// Prune stale entries every 5 minutes to prevent unbounded memory growth
setInterval(() => {
  const nowMin = Math.floor(Date.now() / 60000);
  for (const [uid, entry] of _rateLimitMap) {
    if (entry.windowStart < nowMin - 1) _rateLimitMap.delete(uid);
  }
}, 5 * 60 * 1000);

// ── POST /api/events ──────────────────────────────────────────────────────────

router.post('/', requireAuth, async (req, res) => {
  const userId  = req.user?.id;
  const brandId = req.user?.brandId;

  if (!brandId) {
    return res.status(400).json({ ok: false, error: 'No brand associated with this session' });
  }

  // Rate-limit check
  if (!_checkRateLimit(userId)) {
    return res.status(429).json({ ok: false, error: 'Rate limit exceeded — slow down' });
  }

  const { event, payload } = req.body || {};

  if (!event || typeof event !== 'string' || !event.trim()) {
    return res.status(400).json({ ok: false, error: 'event name is required' });
  }

  // XSS/injection safety: event name must be a safe identifier.
  // Allow: letters, digits, underscores, hyphens. Reject anything else.
  if (!/^[a-zA-Z0-9_\-]{1,64}$/.test(event.trim())) {
    return res.status(400).json({ ok: false, error: 'Invalid event name — use letters, digits, underscores, hyphens (max 64 chars)' });
  }

  // Merge brand/user context into payload — never trust client-supplied ids
  const enrichedPayload = {
    brand_id: brandId,
    user_id:  userId   || null,
    ...(typeof payload === 'object' && payload !== null ? payload : {}),
  };

  // Fire-and-forget — DB write happens synchronously inside fireLeadWebhook;
  // n8n post is async/detached. We don't await here so the response is instant.
  fireLeadWebhook(brandId, userId || null, event.trim(), enrichedPayload).catch(() => {});

  return res.json({ ok: true });
});

module.exports = router;
