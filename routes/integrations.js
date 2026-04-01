'use strict';

/**
 * /api/:brand_id/integrations
 *
 * GET    /            — list all integrations for a brand (status, last_sync — never raw credentials)
 * POST   /:platform   — save credentials, trigger initial sync
 * DELETE /:platform   — disconnect
 *
 * Supported platforms: shopify | locally | shipblu | meta
 */

const express   = require('express');
const crypto    = require('crypto');
const router    = express.Router({ mergeParams: true });
const db        = require('../db/db');
const { encryptJSON } = require('../middleware/encryption');
const { triggerSync } = require('../jobs/scheduler');
const shopify   = require('../integrations/shopify');
const shipblu   = require('../integrations/shipblu');

// ── GET /api/:brand_id/integrations ──────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const { brand_id } = req.params;
    const rows = db.getAllIntegrations(brand_id);

    const safe = rows.map((r) => ({
      platform:         r.platform,
      status:           r.status,
      last_sync:        r.last_sync,
      token_expires_at: r.token_expires_at,
      health:           r.health         || null,
      last_tested_at:   r.last_tested_at || null,
      // Never return raw credentials or last_error to list endpoint
    }));

    res.json({ ok: true, integrations: safe });
  } catch (err) {
    console.error('[integrations] GET / error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to load integrations' });
  }
});

// ── GET /api/:brand_id/integrations/shopify/status ────────────────────────────
// Returns Shopify-specific token health without running a live API call.
router.get('/shopify/status', (req, res) => {
  try {
    const { brand_id } = req.params;
    const row = db.getIntegration(brand_id, 'shopify');

    if (!row || row.status === 'disconnected') {
      return res.json({ ok: true, connected: false });
    }

    const nowSec     = Math.floor(Date.now() / 1000);
    let expiresAt    = null;
    let secondsLeft  = null;

    if (row.token_expires_at) {
      expiresAt   = row.token_expires_at;
      const expSec = Math.floor(new Date(row.token_expires_at).getTime() / 1000);
      secondsLeft  = expSec - nowSec;
    }

    res.json({
      ok:             true,
      connected:      true,
      status:         row.status,
      health:         row.health         || 'unknown',
      last_sync:      row.last_sync      || null,
      last_tested_at: row.last_tested_at || null,
      last_error:     row.last_error     || null,
      token_expires_at: expiresAt,
      token_seconds_remaining: secondsLeft,
    });
  } catch (err) {
    console.error('[integrations] GET /shopify/status error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to load Shopify status' });
  }
});

// ── POST /api/:brand_id/integrations/shopify/test ─────────────────────────────
// Validates stored credentials by refreshing token + hitting /shop.json.
router.post('/shopify/test', async (req, res) => {
  try {
    const { brand_id } = req.params;

    const row = db.getIntegration(brand_id, 'shopify');
    if (!row || row.status === 'disconnected') {
      return res.status(400).json({ ok: false, error: 'Shopify not connected' });
    }

    const result = await shopify.testConnection(brand_id);

    if (result.ok) {
      db.prepare(
        "UPDATE integrations SET health = 'ok', last_error = NULL WHERE brand_id = ? AND platform = 'shopify'"
      ).run(brand_id);
    } else {
      db.prepare(
        "UPDATE integrations SET health = 'error', last_error = ? WHERE brand_id = ? AND platform = 'shopify'"
      ).run(result.error, brand_id);
    }

    res.json(result);
  } catch (err) {
    console.error('[integrations] POST /shopify/test error:', err.message);
    res.status(500).json({ ok: false, error: err.message || 'Connection test failed' });
  }
});

// ── POST /api/:brand_id/integrations/:platform ────────────────────────────────
router.post('/:platform', async (req, res) => {
  const { brand_id, platform } = req.params;
  const { credentials }        = req.body;

  if (!credentials || typeof credentials !== 'object') {
    return res.status(400).json({ ok: false, error: 'credentials object required' });
  }

  // ── Platform-specific validation + connect ───────────────────────────────

  if (platform === 'shopify') {
    const { shop, client_id, client_secret } = credentials;

    if (!shop || !client_id || !client_secret) {
      return res.status(400).json({
        ok: false,
        error: 'Shopify requires: shop (e.g. storename.myshopify.com), client_id, client_secret',
      });
    }

    // connect() normalises shop, exchanges token, saves to DB — throws on bad creds
    let result;
    try {
      result = await shopify.connect(brand_id, { shop, client_id, client_secret });
    } catch (err) {
      console.error(`[integrations] Shopify connect failed for brand=${brand_id}:`, err.message);
      return res.status(400).json({ ok: false, error: err.message });
    }

    // Respond before kicking off background work
    res.json({
      ok:      true,
      message: `Shopify connected (${result.shop}) — starting initial sync`,
      shop:    result.shop,
      scope:   result.scope,
    });

    // Register webhooks + trigger initial full sync in background
    setImmediate(async () => {
      try {
        const { token, shop: shopDomain } = await shopify.getValidShopifyAccessToken(brand_id);
        await shopify.registerWebhooks(brand_id, shopDomain, token);
      } catch (_) {}
      try {
        await triggerSync(brand_id, 'shopify');
      } catch (err) {
        console.error(`[integrations] Shopify initial sync failed brand=${brand_id}:`, err.message);
      }
    });

    return; // done — skip the generic save path below
  }

  if (platform === 'locally') {
    if (!credentials.email || !credentials.password) {
      return res.status(400).json({
        ok: false, error: 'Locally requires: email, password',
      });
    }
  }

  if (platform === 'shipblu') {
    if (!credentials.api_key) {
      return res.status(400).json({
        ok: false,
        error: 'ShipBlu requires: api_key — copy it from app.shipblu.com → Integrations → API Key',
      });
    }

    // Validate the API key before saving — try all auth schemes
    let valid;
    try {
      valid = await shipblu.testConnection(credentials.api_key);
    } catch (_) {
      valid = false;
    }

    if (!valid) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid API key — please verify the key at app.shipblu.com → Integrations → API Key tab',
      });
    }

    // Generate a webhook secret if not provided
    // This is shown to the merchant so they can register it in their ShipBlu webhook config
    if (!credentials.webhook_secret) {
      credentials.webhook_secret = crypto.randomBytes(24).toString('hex');
    }

    // No JWT expiry — clear it explicitly
    delete credentials._token_exp;
  }

  if (platform === 'meta') {
    if (!credentials.access_token) {
      return res.status(400).json({
        ok: false, error: 'Meta requires: access_token (and optionally ad_account_id, ig_user_id)',
      });
    }
    if (credentials.ad_account_id && !credentials.ad_account_id.startsWith('act_')) {
      credentials.ad_account_id = `act_${credentials.ad_account_id}`;
    }
  }

  const SUPPORTED = ['shopify', 'locally', 'shipblu', 'meta'];
  if (!SUPPORTED.includes(platform)) {
    return res.status(400).json({ ok: false, error: `Unknown platform. Supported: ${SUPPORTED.join(', ')}` });
  }

  try {
    const encrypted = encryptJSON(credentials);

    // For ShipBlu, token_expires_at is always NULL (permanent key)
    db.saveIntegration(brand_id, platform, encrypted, 'connected');

    // Build the response payload
    const responsePayload = { ok: true, message: `${platform} connected — starting initial sync` };

    // For ShipBlu: surface the generated webhook secret and setup instructions
    if (platform === 'shipblu') {
      const serverUrl   = (process.env.SERVER_URL || 'https://your-server-url').replace(/\/$/, '');
      const webhookUrl  = `${serverUrl}/api/webhooks/shipblu/${brand_id}`;
      responsePayload.webhook_instructions = {
        endpoint:       webhookUrl,
        secret:         credentials.webhook_secret,
        header_name:    'X-Webhook-Secret',
        header_value:   credentials.webhook_secret,
        steps: [
          'Go to app.shipblu.com → Integrations → Webhooks tab',
          'Click "Add Webhook"',
          `Set Endpoint URL to: ${webhookUrl}`,
          'Under Subscribed To, select all delivery status events',
          `Under Headers, add: X-Webhook-Secret = ${credentials.webhook_secret}`,
          'Click Add',
          'Webhooks are optional — without them, shipping data syncs every 30 minutes',
        ],
      };
    }

    res.json(responsePayload);

    // Trigger initial sync asynchronously
    setImmediate(async () => {
      try {
        await triggerSync(brand_id, platform);
      } catch (err) {
        console.error(`[integrations] initial sync error (${platform}) brand=${brand_id}:`, err.message);
      }
    });

  } catch (err) {
    console.error(`[integrations] save error (${platform}):`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── DELETE /api/:brand_id/integrations/:platform ──────────────────────────────
router.delete('/:platform', (req, res) => {
  try {
    const { brand_id, platform } = req.params;
    db.deleteIntegration(brand_id, platform);
    res.json({ ok: true, message: `${platform} disconnected` });
  } catch (err) {
    console.error('[integrations] DELETE error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to disconnect integration' });
  }
});

module.exports = router;
