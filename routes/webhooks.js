'use strict';

/**
 * lib/webhooks.js — shared lead webhook helper.
 *
 * fireLeadWebhook(brandId, userId, eventName, payload)
 *   1. Writes to the internal events table SYNCHRONOUSLY — the event is always
 *      persisted regardless of whether n8n is reachable.
 *   2. Fires an async HTTP POST to N8N_WEBHOOK_URL (fire-and-forget).
 *      If the env var is unset the n8n step is skipped silently.
 *      Errors from the HTTP call are logged but never thrown.
 *
 * Used by:
 *   routes/auth.js          — new_signup, new_signup_high_revenue
 *   routes/integrations.js  — shopify_connected
 *   routes/meta_oauth.js    — instagram_connected
 *   routes/events.js        — client-side events forwarded from the dashboard
 *
 * Environment:
 *   N8N_WEBHOOK_URL — full n8n webhook URL (optional).
 *                     e.g. https://n8n.yourserver.com/webhook/optimize-lead
 *                     If unset, only the DB write happens (no external delivery).
 */

const db = require('../db/db');

/**
 * Write event to DB and optionally forward to n8n.
 *
 * @param {string}      brandId    — brand_id to record against
 * @param {string|null} userId     — user_id (may be null for system events)
 * @param {string}      eventName  — e.g. 'new_signup', 'shopify_connected'
 * @param {object}      [payload]  — JSON-serialisable props stored in payload column
 */
async function fireLeadWebhook(brandId, userId, eventName, payload = null) {
  // ── 1. Synchronous DB write ────────────────────────────────────────────────
  // Always happens — gives us a durable record even if n8n is down.
  try {
    db.insertEvent(brandId, userId || null, eventName, payload);
  } catch (dbErr) {
    // Log but don't abort — n8n delivery can still proceed.
    console.error(`[webhooks] insertEvent failed (${eventName}):`, dbErr.message);
  }

  // ── 2. Async n8n fanout ────────────────────────────────────────────────────
  // Fire-and-forget — caller never awaits this; errors are swallowed.
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return; // env not configured — skip silently

  const body = JSON.stringify({
    event:     eventName,
    brand_id:  brandId,
    user_id:   userId || null,
    fired_at:  new Date().toISOString(),
    ...(payload || {}),
  });

  // Detach from the current async context so the caller is never delayed.
  setImmediate(async () => {
    try {
      const resp = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal:  AbortSignal.timeout(8000), // 8 s — don't hang forever
      });
      if (!resp.ok) {
        console.warn(`[webhooks] n8n HTTP ${resp.status} for event=${eventName} brand=${brandId}`);
      } else {
        console.log(`[webhooks] n8n ✓ event=${eventName} brand=${brandId}`);
      }
    } catch (err) {
      // Network error, timeout, AbortError — all non-fatal
      console.warn(`[webhooks] n8n delivery failed (${eventName}): ${err.message}`);
    }
  });
}

module.exports = { fireLeadWebhook };
