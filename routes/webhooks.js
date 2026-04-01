'use strict';

/**
 * Webhook receivers for all third-party platforms.
 *
 * IMPORTANT: These routes receive the RAW request body (Buffer) before any
 * JSON parsing — HMAC signature verification requires the exact bytes that
 * Shopify signed. Mounted BEFORE global json() middleware in server.js.
 */

const express  = require('express');
const crypto   = require('crypto');
const router   = express.Router();
const shopify  = require('../integrations/shopify');
const shipblu  = require('../integrations/shipblu');
const { getIntegration } = require('../db/db');
const { decryptJSON }    = require('../middleware/encryption');

// ── Shopify ───────────────────────────────────────────────────────────────────

router.post(
  '/shopify/:brand_id',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const { brand_id }  = req.params;
    const rawBody       = req.body;
    const topic         = req.headers['x-shopify-topic']       || '';
    const hmacHeader    = req.headers['x-shopify-hmac-sha256'] || '';
    const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;

    // ── HMAC verification ─────────────────────────────────────────────────
    if (webhookSecret) {
      const digest = crypto
        .createHmac('sha256', webhookSecret)
        .update(rawBody)
        .digest('base64');

      const safe = (a, b) => {
        try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
        catch (_) { return false; }
      };

      if (!safe(digest, hmacHeader)) {
        console.warn(`[webhook/shopify] HMAC mismatch brand=${brand_id} topic=${topic}`);
        return res.status(401).json({ ok: false, error: 'Invalid HMAC signature' });
      }
    } else {
      console.warn('[webhook/shopify] SHOPIFY_WEBHOOK_SECRET not set — skipping HMAC check');
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (_) {
      return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
    }

    // Acknowledge immediately — Shopify expects 2xx within 5 seconds
    res.status(200).json({ ok: true });

    setImmediate(async () => {
      try {
        await shopify.handleWebhook(brand_id, topic, payload);
      } catch (err) {
        console.error(`[webhook/shopify] handler error topic=${topic}:`, err.message);
      }
    });
  }
);

// ── ShipBlu ───────────────────────────────────────────────────────────────────
//
// ShipBlu sends delivery status update events as POST requests.
// Auth: The merchant adds a custom header X-Webhook-Secret when registering
// the webhook in their ShipBlu dashboard. We verify it against the secret
// stored in their encrypted credentials.
//
// Webhook registration (merchant does this once in ShipBlu dashboard):
//   1. app.shipblu.com → Integrations → Webhooks → Add Webhook
//   2. Endpoint: https://your-server/api/webhooks/shipblu/:brand_id
//   3. Headers: { "X-Webhook-Secret": "<secret shown after API key connect>" }
//   4. Subscribed To: all delivery status events
//
// If no webhook_secret is stored (legacy or manual setup), we accept the
// request but log a warning. Set up the secret by reconnecting ShipBlu
// in Settings.

router.post(
  '/shipblu/:brand_id',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const { brand_id }    = req.params;
    const incomingSecret  = req.headers['x-webhook-secret'] || req.headers['x-shipblu-secret'] || '';
    const topic           = req.headers['x-shipblu-event']  || req.headers['x-event-type'] || 'status_update';

    // ── Secret verification ───────────────────────────────────────────────
    let storedSecret = null;
    try {
      const integration = getIntegration(brand_id, 'shipblu');
      if (integration && integration.credentials) {
        const creds  = decryptJSON(integration.credentials);
        storedSecret = creds.webhook_secret || null;
      }
    } catch (_) {}

    if (storedSecret) {
      // Use timing-safe comparison to prevent timing attacks
      let match = false;
      try {
        match = crypto.timingSafeEqual(
          Buffer.from(incomingSecret),
          Buffer.from(storedSecret)
        );
      } catch (_) {
        match = false;
      }

      if (!match) {
        console.warn(`[webhook/shipblu] invalid X-Webhook-Secret for brand=${brand_id}`);
        return res.status(401).json({ ok: false, error: 'Invalid webhook secret' });
      }
    } else {
      // No secret stored — accept but warn. This happens if the integration
      // was connected before webhook secrets were introduced, or if the merchant
      // hasn't registered the webhook yet.
      console.warn(`[webhook/shipblu] no webhook_secret stored for brand=${brand_id} — accepting unauthenticated request`);
    }

    // ── Parse body ────────────────────────────────────────────────────────
    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch (_) {
      return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
    }

    // Acknowledge immediately
    res.status(200).json({ ok: true });

    setImmediate(() => {
      try {
        const changes = shipblu.handleWebhook(brand_id, payload);
        console.log(`[webhook/shipblu] event=${topic} brand=${brand_id} changes=${changes}`);
      } catch (err) {
        console.error(`[webhook/shipblu] handler error brand=${brand_id}:`, err.message);
      }
    });
  }
);

module.exports = router;
