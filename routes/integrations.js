'use strict';

/**
 * /api/:brand_id/integrations
 *
 * GET    /            — list all integrations for a brand (status, last_sync — never raw credentials)
 * POST   /:platform   — save credentials, trigger initial sync
 * DELETE /:platform   — disconnect
 *
 * Supported platforms: shopify | locally | shipblu | meta | bosta
 */

const express   = require('express');
const crypto    = require('crypto');
const router    = express.Router({ mergeParams: true });
const db                                           = require('../db/db');
const { setIntegrationHealth, disconnectIntegration } = require('../db/db');
const { encryptJSON } = require('../middleware/encryption');
const { triggerSync } = require('../jobs/scheduler');
const shopify   = require('../integrations/shopify');
const shipblu   = require('../integrations/shipblu');
const bosta     = require('../integrations/bosta');     // BOSTA_INTEGRATION
const locally   = require('../integrations/locally');
const meta      = require('../integrations/meta');
// STEP9 — shared webhook helper for internal event logging + optional n8n fanout
const { fireLeadWebhook } = require('../lib/webhooks');

// ── GET /api/:brand_id/integrations ──────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const { brand_id } = req.params;
    const rows = db.getAllIntegrations(brand_id);

    // Prepare sync count query once and reuse
    const countStmt = db.db.prepare(
      'SELECT COUNT(*) AS cnt FROM sync_logs WHERE brand_id = ? AND platform = ?'
    );

    const safe = rows.map((r) => ({
      platform:         r.platform,
      status:           r.status,
      last_sync:        r.last_sync,
      token_expires_at: r.token_expires_at,
      health:           r.health         || null,
      last_tested_at:   r.last_tested_at || null,
      // Surface the human-readable error so the UI can show WHY a sync failed.
      // This is not a credential — it is the error string from the last sync log.
      error_message:    r.last_error      || null,
      // Total number of sync attempts (shown in settings card stats)
      sync_count:       countStmt.get(brand_id, r.platform)?.cnt || 0,
    }));

    res.json({ ok: true, integrations: safe });
  } catch (err) {
    console.error('[integrations] GET / error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to load integrations' });
  }
});

// ── GET /api/:brand_id/integrations/shopify/oauth-config ─────────────────────
// Returns whether Shopify OAuth env vars are configured on this server.
// Used by the frontend to decide whether to show the Connect button or a warning.
// SHOPIFY_OAUTH_FRONTEND
router.get('/shopify/oauth-config', (req, res) => {
  const configured = !!(process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET);
  res.json({
    ok:          true,
    configured,
    redirect_uri: configured
      ? (process.env.SHOPIFY_REDIRECT_URI || 'https://optimize-backend-production.up.railway.app/auth/shopify/callback')
      : null,
  });
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
      setIntegrationHealth(brand_id, 'shopify', 'ok', null);
    } else {
      setIntegrationHealth(brand_id, 'shopify', 'error', result.error || null);
    }

    res.json(result);
  } catch (err) {
    console.error('[integrations] POST /shopify/test error:', err.message);
    res.status(500).json({ ok: false, error: err.message || 'Connection test failed' });
  }
});

// ── POST /api/:brand_id/integrations/locally/test ────────────────────────────
// Re-tests stored Locally credentials without requiring a full reconnect.
// Returns ok + message or ok:false + error so the UI can surface the exact failure reason.
router.post('/locally/test', async (req, res) => {
  try {
    const { brand_id } = req.params;
    const row = db.getIntegration(brand_id, 'locally');
    if (!row || row.status === 'disconnected') {
      return res.status(400).json({ ok: false, error: 'Locally is not connected' });
    }

    const { decryptJSON } = require('../middleware/encryption');
    let creds;
    try {
      creds = decryptJSON(row.credentials);
    } catch (_) {
      return res.status(400).json({ ok: false, error: 'Stored credentials are corrupted — please reconnect Locally' });
    }

    let token;
    try {
      token = await locally.login(creds.email, creds.password);
    } catch (networkErr) {
      return res.json({ ok: false, error: `Network error reaching Locally: ${networkErr.message}` });
    }

    if (token) {
      // Credentials are valid — reset status to 'connected' so the scheduler
      // picks this brand up on its next run (was stuck in 'error' state).
      setIntegrationHealth(brand_id, 'locally', 'ok', null);
      db.updateIntegrationStatus(brand_id, 'locally', 'connected');
      res.json({ ok: true, message: 'Locally credentials verified — sync will resume on next cycle' });
    } else {
      const errMsg = 'Login rejected — email or password is incorrect. Click Reconnect to update credentials.';
      setIntegrationHealth(brand_id, 'locally', 'error', errMsg);
      res.json({ ok: false, error: errMsg });
    }
  } catch (err) {
    console.error('[integrations] POST /locally/test error:', err.message);
    res.status(500).json({ ok: false, error: err.message || 'Connection test failed' });
  }
});

// ── POST /api/:brand_id/integrations/locally/resync ──────────────────────────
// Triggers a full Locally EG sync — identical logic to the scheduled background sync.
// Only inserts rows with source_order_id starting with 'loc-' (transaction hashes).
// Existing rows are cleared and re-inserted fresh from the API on every call;
// ON CONFLICT in upsertOrder() guarantees no duplicate source_order_id within a brand.
router.post('/locally/resync', async (req, res) => { // LOCALLY_RESYNC_ENDPOINT
  const { brand_id } = req.params;

  const integration = db.getIntegration(brand_id, 'locally');
  if (!integration) {
    return res.status(400).json({ success: false, error: 'Locally integration not found — connect it first in Settings' });
  }
  if (integration.status === 'disconnected') {
    return res.status(400).json({ success: false, error: 'Locally integration is disconnected — reconnect it in Settings' });
  }

  try {
    await locally.fullSync(brand_id);

    const log = db.getLastSyncLog(brand_id, 'locally');

    if (log?.status === 'error') {
      return res.status(500).json({
        success: false,
        error: log.error_message || 'Sync failed — check credentials',
      });
    }

    // Count loc-* rows now in DB — these are the distinct transactions fetched
    // from the Locally API during this sync. fetchOrders() cleared all prior
    // loc-* rows before reinserting, so this count equals the API's full history.
    const locCount = db.db.prepare(
      "SELECT COUNT(*) AS cnt FROM orders_cache WHERE brand_id = ? AND source = 'locally' AND source_order_id LIKE 'loc-%'"
    ).get(brand_id)?.cnt || 0;

    return res.json({
      success:        true,
      orders_synced:  locCount,
      orders_skipped: 0,
    });

  } catch (err) {
    console.error(`[integrations/locally/resync] unhandled error brand=${brand_id}:`, err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/:brand_id/integrations/meta/discover ────────────────────────────
// Re-runs ID discovery against the stored token and patches credentials in-place.
// Useful when a brand connected before auto-discovery was introduced, or when
// they've since added an IG Business Account to their Facebook Page.
router.post('/meta/discover', async (req, res) => {
  try {
    const { brand_id } = req.params;
    const row = db.getIntegration(brand_id, 'meta');

    if (!row || row.status === 'disconnected') {
      return res.status(400).json({ ok: false, error: 'Meta integration not connected' });
    }

    const { decryptJSON } = require('../middleware/encryption');
    let creds;
    try {
      creds = decryptJSON(row.credentials);
    } catch (_) {
      return res.status(400).json({ ok: false, error: 'Stored credentials corrupted — please reconnect' });
    }

    if (!creds.access_token) {
      return res.status(400).json({ ok: false, error: 'No access token stored' });
    }

    console.log(`[integrations] Meta /discover called for brand=${brand_id}`);
    const discovered = await meta.discoverIds(creds.access_token);

    // Patch credentials: overwrite with freshly discovered values
    let changed = false;
    if (discovered.page_id)      { creds.page_id = discovered.page_id; changed = true; }
    if (discovered.ig_user_id)   { creds.ig_user_id = discovered.ig_user_id; changed = true; }
    if (discovered.ad_account_id){ creds.ad_account_id = discovered.ad_account_id; changed = true; }

    if (changed) {
      const { encryptJSON } = require('../middleware/encryption');
      db.db.prepare(
        "UPDATE integrations SET credentials = ? WHERE brand_id = ? AND platform = 'meta'"
      ).run(encryptJSON(creds), brand_id);
      console.log(`[integrations] Meta credentials updated for brand=${brand_id}:`, {
        page_id: creds.page_id, ig_user_id: creds.ig_user_id, ad_account_id: creds.ad_account_id,
      });
    }

    res.json({
      ok: true,
      discovered,
      message: changed ? 'IDs discovered and saved — next sync will fetch Instagram and Ads data' : 'No new IDs discovered',
    });
  } catch (err) {
    console.error('[integrations] POST /meta/discover error:', err.message);
    res.status(500).json({ ok: false, error: err.message || 'Discovery failed' });
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
    const { shop, access_token, client_id, client_secret } = credentials;

    if (!shop) {
      return res.status(400).json({ ok: false, error: 'Shopify requires: shop (e.g. storename.myshopify.com)' });
    }
    if (!access_token && (!client_id || !client_secret)) {
      return res.status(400).json({
        ok: false,
        error: 'Provide either access_token (recommended — Custom App token) or both client_id and client_secret',
      });
    }

    // connect() validates the token/credentials against the live API then saves to DB
    let result;
    try {
      result = await shopify.connect(brand_id, {
        shop,
        accessToken:  access_token  || undefined,
        clientId:     client_id     || undefined,
        clientSecret: client_secret || undefined,
      });
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
    // LOCALLY_EG_CREDENTIAL_VALIDATION
    if (!credentials.email || !credentials.password) {
      return res.status(400).json({
        ok: false, error: 'Locally requires: email, password',
      });
    }

    // Test the credentials against the live Locally API before persisting.
    // login() returns a Bearer token string on success, or null on failure.
    let token;
    try {
      token = await locally.login(credentials.email, credentials.password);
    } catch (err) {
      console.error(`[integrations] Locally login test threw for brand=${brand_id}:`, err.message);
      return res.status(400).json({
        ok: false,
        error: 'Could not reach the Locally server — check your internet connection and try again',
      });
    }

    if (!token) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid Locally credentials — the email or password was rejected. Please double-check and try again.',
      });
    }

    // Stamp the credentials with a validation timestamp (informational only — not persisted to DB column)
    credentials._validated_at = new Date().toISOString();
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

  // ── BOSTA_INTEGRATION: validate API key before saving ────────────────────────
  if (platform === 'bosta') {
    if (!credentials.api_key) {
      return res.status(400).json({
        ok: false,
        error: 'Bosta requires: api_key — copy it from your Bosta Business dashboard → Settings → API Key',
      });
    }

    let valid;
    try {
      valid = await bosta.testConnection(credentials.api_key);
    } catch (_) {
      valid = false;
    }

    if (!valid) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid Bosta API key — verify it at your Bosta Business dashboard → Settings → API Key',
      });
    }

    delete credentials._token_exp;
  }

  if (platform === 'meta') {
    if (!credentials.access_token) {
      return res.status(400).json({
        ok: false, error: 'Meta requires: access_token',
      });
    }

    // TOKEN_VALIDATION — verify the token via GET /me before saving anything.
    // Without this, connect() succeeds even with an expired token, discovery
    // returns null IDs silently, and the integration is marked 'connected'
    // even though nothing will ever sync.
    //
    // Structured error codes:
    //   INVALID_TOKEN — token is expired, revoked, or malformed
    //   NO_PAGE       — token valid but no Facebook Pages found
    //   NO_INSTAGRAM  — token valid but no IG Business Account linked
    //   NO_AD_ACCOUNT — token valid but no Ad Account accessible
    console.log(`[integrations] Meta: verifying token for brand=${brand_id}`);
    let tokenCheck;
    try {
      tokenCheck = await meta.verifyToken(credentials.access_token);
    } catch (err) {
      return res.status(400).json({
        ok: false, error: 'API_ERROR',
        message: `Could not reach Meta API: ${err.message}`,
      });
    }
    if (!tokenCheck.ok) {
      console.error(`[integrations] Meta token invalid for brand=${brand_id}:`, tokenCheck.message);
      return res.status(400).json({
        ok: false, error: tokenCheck.error,
        message: tokenCheck.message,
      });
    }
    console.log(`[integrations] Meta: token verified userId=${tokenCheck.userId} name="${tokenCheck.name}" brand=${brand_id}`);

    // Normalise manually-provided ad_account_id to "act_XXXX" format
    if (credentials.ad_account_id && !String(credentials.ad_account_id).startsWith('act_')) {
      credentials.ad_account_id = `act_${credentials.ad_account_id}`;
    }

    // AUTO-DISCOVER IDs — call Meta Graph API to find page_id, ig_user_id,
    // and ad_account_id from the token so users don't have to hunt for numeric IDs.
    // User-provided values (from the form) always take precedence over discovered ones.
    console.log(`[integrations] Meta: discovering IDs for brand=${brand_id}`);
    let discovered = { page_id: null, ig_user_id: null, ad_account_id: null };
    try {
      discovered = await meta.discoverIds(credentials.access_token);
    } catch (err) {
      console.warn('[integrations] Meta ID discovery threw:', err.message);
    }

    if (discovered.page_id && !credentials.page_id) {
      credentials.page_id = discovered.page_id;
    }
    if (!credentials.ig_user_id && discovered.ig_user_id) {
      credentials.ig_user_id = discovered.ig_user_id;
      console.log(`[integrations] Meta: auto-discovered ig_user_id=${credentials.ig_user_id}`);
    }
    if (!credentials.ad_account_id && discovered.ad_account_id) {
      credentials.ad_account_id = discovered.ad_account_id;
      console.log(`[integrations] Meta: auto-discovered ad_account_id=${credentials.ad_account_id}`);
    }

    // Structured warnings for missing assets (not blocking — partial data still useful)
    if (!discovered.page_id && !credentials.page_id) {
      console.warn(`[integrations] Meta brand=${brand_id}: NO_PAGE — no Facebook Pages found. Ensure token has pages_read_engagement.`);
    }
    if (!credentials.ig_user_id) {
      console.warn(`[integrations] Meta brand=${brand_id}: NO_INSTAGRAM — ig_user_id not found. Ensure Facebook Page is linked to an Instagram Business Account.`);
    }
    if (!credentials.ad_account_id) {
      console.warn(`[integrations] Meta brand=${brand_id}: NO_AD_ACCOUNT — ad_account_id not found. Ensure token has ads_read permission.`);
    }
  }

  const SUPPORTED = ['shopify', 'locally', 'shipblu', 'bosta', 'meta'];
  if (!SUPPORTED.includes(platform)) {
    return res.status(400).json({ ok: false, error: `Unknown platform. Supported: ${SUPPORTED.join(', ')}` });
  }

  try {
    const encrypted = encryptJSON(credentials);

    // For ShipBlu/Bosta, token_expires_at is always NULL (permanent key)
    db.saveIntegration(brand_id, platform, encrypted, 'connected');

    // For platforms that were pre-validated, mark health as ok immediately
    if (platform === 'locally' || platform === 'shipblu' || platform === 'bosta' || platform === 'meta') {
      setIntegrationHealth(brand_id, platform, 'ok', null);
    }

    // Build the response payload
    const responsePayload = { ok: true, message: `${platform} connected — starting initial sync` };

    // For Meta: surface which IDs were discovered so the UI can confirm
    if (platform === 'meta') {
      responsePayload.meta_ids = {
        page_id:       credentials.page_id       || null,
        ig_user_id:    credentials.ig_user_id    || null,
        ad_account_id: credentials.ad_account_id || null,
      };
      const missing = [];
      if (!credentials.ig_user_id)    missing.push('ig_user_id (Instagram data unavailable)');
      if (!credentials.ad_account_id) missing.push('ad_account_id (Ads data unavailable)');
      if (missing.length) {
        responsePayload.warning = `Could not auto-discover: ${missing.join(', ')}. Check token permissions and re-connect.`;
      }
    }

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

    // STEP9 — fire platform_connected event (DB write + optional n8n fanout).
    // Fires for Shopify when connected via the manual credentials form.
    // (OAuth-connected Shopify fires from routes/shopify_oauth.js instead.)
    if (platform === 'shopify') {
      fireLeadWebhook(brand_id, null, 'shopify_connected', { platform, source: 'manual' }).catch(() => {});
    }

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

// ── DISCONNECT_STANDARDIZATION ────────────────────────────────────────────────
//
// One POST /:platform/disconnect handler per platform, all following the same contract:
//
//   1. Set status = 'disconnected'
//   2. Null out credentials, health, last_error, last_tested_at, last_sync, token_expires_at
//      (via disconnectIntegration — soft-disconnect, row is KEPT for UI reconnect state)
//   3. Per-platform cache decisions (documented per-handler — intentionally different):
//      - Shopify: cache kept (orders remain visible; re-sync on reconnect handles dedup)
//      - Locally: cache kept (same reasoning; fullSync clears and repopulates on reconnect)
//      - ShipBlu:  no data cache to clear (shipping column on orders_cache, not a separate table)
//      - Bosta:    no data cache to clear (same as ShipBlu)
//      - Meta:     no data cache to clear (campaign_cache + ig_cache stay for historical reference)
//   4. Return: { ok: true, platform, status: 'disconnected' }
//
// The DELETE /:platform fallback below handles any platform not listed here,
// keeping backward compatibility with any client calling the old route shape.

// Helper used by all five handlers — single source of truth.
function handleDisconnect(brand_id, platform, res) {
  try {
    const existing = db.getIntegration(brand_id, platform);

    if (!existing) {
      // Integration was never connected — respond with success (idempotent)
      return res.json({ ok: true, platform, status: 'disconnected', note: 'Integration was not connected' });
    }

    if (existing.status === 'disconnected') {
      // Already disconnected — idempotent success
      return res.json({ ok: true, platform, status: 'disconnected', note: 'Already disconnected' });
    }

    disconnectIntegration(brand_id, platform);
    console.log(`[integrations] ${platform} disconnected for brand=${brand_id}`);
    return res.json({ ok: true, platform, status: 'disconnected' });

  } catch (err) {
    console.error(`[integrations] disconnect error (${platform}) brand=${brand_id}:`, err.message);
    return res.status(500).json({ ok: false, error: `Failed to disconnect ${platform}` });
  }
}

// ── POST /api/:brand_id/integrations/shopify/disconnect ──────────────────────
router.post('/shopify/disconnect', (req, res) => {
  // SHOPIFY_DISCONNECT — cache intentionally retained. Orders remain visible
  // after disconnect so historical data is not lost. Re-sync on reconnect
  // uses updated_at filter and deduplicates by Shopify order ID.
  handleDisconnect(req.params.brand_id, 'shopify', res);
});

// ── POST /api/:brand_id/integrations/locally/disconnect ──────────────────────
router.post('/locally/disconnect', (req, res) => {
  // LOCALLY_DISCONNECT — cache retained (same reasoning as Shopify).
  // fullSync() on reconnect clears and repopulates all loc-* rows.
  handleDisconnect(req.params.brand_id, 'locally', res);
});

// ── POST /api/:brand_id/integrations/shipblu/disconnect ──────────────────────
router.post('/shipblu/disconnect', (req, res) => {
  // SHIPBLU_DISCONNECT — no separate data cache; shipping status lives in
  // orders_cache.shipping JSON column. Existing shipping data is preserved.
  handleDisconnect(req.params.brand_id, 'shipblu', res);
});

// ── POST /api/:brand_id/integrations/bosta/disconnect ────────────────────────
router.post('/bosta/disconnect', (req, res) => {
  // BOSTA_DISCONNECT — same as ShipBlu; no separate cache table.
  handleDisconnect(req.params.brand_id, 'bosta', res);
});

// ── POST /api/:brand_id/integrations/meta/disconnect ─────────────────────────
router.post('/meta/disconnect', (req, res) => {
  // META_DISCONNECT — campaign_cache and ig_cache rows are kept for historical
  // reference. They will be refreshed on reconnect.
  handleDisconnect(req.params.brand_id, 'meta', res);
});

// ── DELETE /api/:brand_id/integrations/:platform ─────────────────────────────
// Generic fallback — kept for backward compatibility.
// New code should call POST /:platform/disconnect instead.
router.delete('/:platform', (req, res) => {
  handleDisconnect(req.params.brand_id, req.params.platform, res);
});

module.exports = router;
