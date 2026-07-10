'use strict';

// SHOPIFY_OAUTH_START / SHOPIFY_OAUTH_CALLBACK
//
// Standard Shopify OAuth 2.0 Authorization Code flow.
// No token copying required — brand just enters their store URL and approves.
//
// Flow:
//   GET /auth/shopify/start     → validate shop → generate nonce → redirect to Shopify
//   GET /auth/shopify/callback  → verify HMAC + nonce → exchange code → save token → redirect dashboard
//
// SHOPIFY_REDIRECT_URL — must be set to:
//   https://optimize-backend-production.up.railway.app/auth/shopify/callback
// Update this in the Shopify app dashboard before testing OAuth flow.

const express  = require('express');
const crypto   = require('crypto');
const axios    = require('axios');
const router   = express.Router();

const { db, setIntegrationHealth, logSync } = require('../db/db');
const { encryptJSON }                        = require('../middleware/encryption');
const { normaliseShop }                      = require('../integrations/shopify');
const { requireAuth }                        = require('../middleware/auth');

// ── OAuth nonce store ─────────────────────────────────────────────────────────
// In-memory map: nonce → { shop, brand_id, expires }
// Railway is single-instance — in-memory is safe. Expires after 10 minutes.
const _nonces = new Map();
const NONCE_TTL_MS = 10 * 60 * 1000;  // 10 minutes

/**
 * Store a nonce. extraData is merged into the entry and available in _consumeNonce().
 * Used to carry user-supplied client_id / client_secret through the OAuth round-trip
 * so no env vars are required for the dynamic connect flow.
 */
function _storeNonce(nonce, shop, brandId, extraData = {}) {
  _nonces.set(nonce, { shop, brand_id: brandId, expires: Date.now() + NONCE_TTL_MS, ...extraData });
}

function _consumeNonce(nonce) {
  const entry = _nonces.get(nonce);
  if (!entry) return null;
  _nonces.delete(nonce);
  if (Date.now() > entry.expires) return null;
  return entry;
}

// Prune expired nonces every 15 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of _nonces) {
    if (now > val.expires) _nonces.delete(key);
  }
}, 15 * 60 * 1000);

// ── Env helpers ───────────────────────────────────────────────────────────────

function getEnv() {
  const clientId     = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const scopes       = process.env.SHOPIFY_SCOPES       || 'read_orders,read_products,read_inventory,read_customers,read_fulfillments,read_shipping,read_returns,read_analytics';
  const redirectUri  = process.env.SHOPIFY_REDIRECT_URI || 'https://optimize-backend-production.up.railway.app/auth/shopify/callback';
  return { clientId, clientSecret, scopes, redirectUri };
}

// ── GET /auth/shopify/start ───────────────────────────────────────────────────
// Requires authentication. The authenticated user must own the brand_id in the query.

router.get('/start', requireAuth, (req, res) => {
  // SHOPIFY_OAUTH_START
  const { clientId, scopes, redirectUri } = getEnv();

  if (!clientId) {
    console.error('[shopify-oauth] SHOPIFY_CLIENT_ID is not set');
    return res.status(503).send('Shopify OAuth is not configured on this server. Set SHOPIFY_CLIENT_ID.');
  }

  const { shop: rawShop, brand_id: brandId } = req.query;

  if (!brandId) {
    return res.status(400).send('Missing brand_id parameter');
  }

  // BRAND_OWNERSHIP_CHECK — verify the authenticated user owns this brand.
  // Stub users (dev mode, AUTH_ENABLED=false) bypass the check.
  if (!req.user?._stub) {
    const jwtBrandId = req.user?.brandId;
    if (jwtBrandId) {
      if (jwtBrandId !== brandId) {
        return res.status(403).send('Access denied — token not valid for this brand');
      }
    } else {
      const { userHasBrandAccess } = require('../db/db');
      if (!userHasBrandAccess(req.user.id, brandId)) {
        return res.status(403).send('Access denied to this brand');
      }
    }
  }

  // Validate and normalise shop domain
  let shop;
  try {
    shop = normaliseShop(rawShop);
  } catch (err) {
    return res.status(400).send(`Invalid shop domain: ${err.message}`);
  }

  // Verify brand exists
  const brand = db.prepare('SELECT id FROM brands WHERE id = ?').get(brandId);
  if (!brand) {
    return res.status(400).send(`Brand "${brandId}" not found`);
  }

  // Generate cryptographically random nonce (state param) — CSRF protection
  const nonce = crypto.randomBytes(16).toString('hex');
  _storeNonce(nonce, shop, brandId);

  // Build Shopify OAuth URL
  const params = new URLSearchParams({
    client_id:    clientId,
    scope:        scopes,
    redirect_uri: redirectUri,
    state:        nonce,
  });

  const authUrl = `https://${shop}/admin/oauth/authorize?${params}`;
  console.log(`[shopify-oauth] redirecting brand=${brandId} shop=${shop} to Shopify OAuth`);
  res.redirect(authUrl);
});

// ── POST /auth/shopify/start-dynamic ─────────────────────────────────────────
//
// Dynamic OAuth start — user supplies their own Client ID + Secret in the request
// body instead of relying on server env vars. Credentials are stored inside the
// state nonce and retrieved in the callback. No SHOPIFY_CLIENT_ID env var needed.
//
// Body: { shop, client_id, client_secret, brand_id }
// Returns: { ok: true, auth_url } — frontend should redirect the browser there.
//
// IMPORTANT: The Redirect URL in the Shopify app must point to:
//   https://optimize-backend-production.up.railway.app/auth/shopify/callback

router.post('/start-dynamic', requireAuth, (req, res) => {
  const { shop: rawShop, client_id, client_secret, brand_id: brandId } = req.body || {};

  if (!rawShop || !client_id || !client_secret || !brandId) {
    return res.status(400).json({ ok: false, error: 'Missing: shop, client_id, client_secret, brand_id' });
  }

  // Brand ownership check (same as GET /start)
  if (!req.user?._stub) {
    const jwtBrandId = req.user?.brandId;
    if (jwtBrandId && jwtBrandId !== brandId) {
      return res.status(403).json({ ok: false, error: 'Access denied to this brand' });
    }
  }

  let shop;
  try {
    shop = normaliseShop(rawShop);
  } catch (err) {
    return res.status(400).json({ ok: false, error: `Invalid shop domain: ${err.message}` });
  }

  if (!shop.endsWith('.myshopify.com')) {
    return res.status(400).json({ ok: false, error: 'Shop must be a .myshopify.com address' });
  }

  const { scopes, redirectUri } = getEnv();
  const nonce = crypto.randomBytes(16).toString('hex');

  // Store credentials inside the nonce — retrieved in /callback
  _storeNonce(nonce, shop, brandId, { client_id, client_secret });

  const params = new URLSearchParams({
    client_id,
    scope:        scopes,
    redirect_uri: redirectUri,
    state:        nonce,
  });

  const authUrl = `https://${shop}/admin/oauth/authorize?${params}`;
  console.log(`[shopify-oauth] dynamic start brand=${brandId} shop=${shop}`);
  res.json({ ok: true, auth_url: authUrl });
});

// ── GET /auth/shopify/callback ────────────────────────────────────────────────

router.get('/callback', async (req, res) => {
  // SHOPIFY_OAUTH_CALLBACK
  const serverUrl = (process.env.SERVER_URL || 'https://optimize-backend-production.up.railway.app').replace(/\/$/, '');
  const { clientId: envClientId, clientSecret: envClientSecret } = getEnv();

  const { code, shop: rawShop, state, hmac } = req.query;

  // ── Step 1: Consume nonce first — needed to get dynamic credentials ──────────
  const nonceEntry = _consumeNonce(state);
  if (!nonceEntry) {
    console.warn('[shopify-oauth] invalid or expired state nonce:', state);
    return res.status(400).send('OAuth state expired or invalid. Please start the connection again.');
  }

  // Credentials: nonce-stored (dynamic flow) takes priority over env vars
  const clientId     = nonceEntry.client_id     || envClientId;
  const clientSecret = nonceEntry.client_secret || envClientSecret;
  const { brand_id: brandId } = nonceEntry;

  if (!clientId || !clientSecret) {
    console.error('[shopify-oauth] no client credentials available');
    return res.status(503).send('Shopify credentials not configured. Set SHOPIFY_CLIENT_ID/SECRET or use the dynamic connect flow.');
  }

  // ── Step 2: Validate HMAC signature ─────────────────────────────────────────
  const queryParams = { ...req.query };
  delete queryParams.hmac;

  const message = Object.keys(queryParams)
    .sort()
    .map((k) => `${k}=${queryParams[k]}`)
    .join('&');

  const computedHmac = crypto
    .createHmac('sha256', clientSecret)
    .update(message)
    .digest('hex');

  if (!hmac || computedHmac !== hmac) {
    console.warn('[shopify-oauth] HMAC validation failed — possible CSRF or replay attack');
    return res.status(400).send('Invalid request signature. Please try connecting again.');
  }

  // Normalise and verify shop matches what we stored
  let shop;
  try {
    shop = normaliseShop(rawShop);
  } catch (_) {
    return res.status(400).send('Invalid shop domain in callback');
  }

  if (shop !== nonceEntry.shop) {
    console.warn(`[shopify-oauth] shop mismatch: stored=${nonceEntry.shop} received=${shop}`);
    return res.status(400).send('Shop domain mismatch. Please try connecting again.');
  }

  // ── Step 3: Exchange code for permanent access token ─────────────────────────
  let access_token, scope;
  try {
    const tokenRes = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      { client_id: clientId, client_secret: clientSecret, code },
      { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 15000 }
    );
    access_token = tokenRes.data.access_token;
    scope        = tokenRes.data.scope || '';

    if (!access_token) {
      throw new Error('Shopify returned no access_token');
    }
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[shopify-oauth] token exchange failed for brand=${brandId} shop=${shop}:`, detail);
    return res.redirect(`${serverUrl}/?shopify=error&reason=token_exchange`);
  }

  // ── Step 4: Encrypt the access token ────────────────────────────────────────
  // OAuth tokens are permanent — no expires_at, no client_secret needed
  // SHOPIFY_OAUTH_TOKEN_SOURCE
  const creds = {
    shop,
    access_token,
    scope,
    oauth: true,   // Flag: this is an OAuth token — never refresh via client_credentials
  };
  const encrypted = encryptJSON(creds);

  // ── Step 5: Save to integrations table ──────────────────────────────────────
  db.prepare(`
    INSERT INTO integrations (brand_id, platform, credentials, status, token_expires_at)
    VALUES (?, 'shopify', ?, 'connected', NULL)
    ON CONFLICT(brand_id, platform) DO UPDATE SET
      credentials      = excluded.credentials,
      status           = 'connected',
      token_expires_at = NULL,
      last_sync        = NULL
  `).run(brandId, encrypted);

  console.log(`[shopify-oauth] saved token for brand=${brandId} shop=${shop} scope=${scope}`);

  // ── Step 6: Set integration health ──────────────────────────────────────────
  setIntegrationHealth(brandId, 'shopify', 'ok', null);

  // ── Step 7: Trigger first sync in background ─────────────────────────────────
  setImmediate(async () => {
    try {
      const shopify = require('../integrations/shopify');
      const { triggerSync } = require('../jobs/scheduler');

      // Register webhooks first
      const { token, shop: shopDomain } = await shopify.getValidShopifyAccessToken(brandId);
      await shopify.registerWebhooks(brandId, shopDomain, token);

      // Full sync
      await triggerSync(brandId, 'shopify');
    } catch (err) {
      console.error(`[shopify-oauth] initial sync error for brand=${brandId}:`, err.message);
      logSync(brandId, 'shopify', 'error', err.message, 0);
    }
  });

  // ── Step 8: Redirect to dashboard with success param ─────────────────────────
  res.redirect(`${serverUrl}/?shopify=connected`);
});

module.exports = router;
