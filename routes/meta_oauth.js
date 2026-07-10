'use strict';

/**
 * META_OAUTH — Instagram / Meta OAuth 2.0 flow.
 *
 * GET /auth/meta/start    — auth required; generates CSRF nonce; redirects to Meta OAuth dialog.
 * GET /auth/meta/callback — public (Meta redirects here); verifies state; exchanges code for
 *                           short-lived token; extends to 60-day long-lived token; stores
 *                           encrypted; redirects to /?instagram=connected.
 *
 * Environment vars (same as integrations/meta.js):
 *   META_APP_ID        — Facebook App ID
 *   META_APP_SECRET    — Facebook App Secret
 *   META_REDIRECT_URI  — defaults to https://optimize-backend-production.up.railway.app/auth/meta/callback
 *                        Must be registered in the Meta app's "Valid OAuth Redirect URIs".
 *
 * Scopes requested: instagram_basic, pages_show_list, pages_read_engagement, ads_read
 * (ads_read included so the same token works for Meta Ads sync if the brand upgrades to paid).
 *
 * Token lifetime: Meta issues short-lived tokens (~1h) via the code exchange.
 * We immediately extend to a long-lived token (~60 days) via the fb_exchange_token grant.
 * The token is stored encrypted in the integrations table; meta.js refreshes it before expiry.
 *
 * FLOW:
 *   1. Frontend calls QuickConnect.open('instagram')
 *   2. META_OAUTH_READY=true → user clicks "Continue with Meta"
 *   3. Frontend redirects to GET /auth/meta/start?return_to=dashboard
 *   4. Backend: generate nonce → redirect to facebook.com/dialog/oauth
 *   5. Meta redirects back to GET /auth/meta/callback?code=...&state=nonce
 *   6. Backend: verify nonce → exchange code → extend token → encrypt → store → sync
 *   7. Redirect to /?instagram=connected
 *   8. Dashboard detects query param → demo→real swap
 */

const express = require('express');
const crypto  = require('crypto');
const axios   = require('axios');
const router  = express.Router();

const { db, setIntegrationHealth, logSync } = require('../db/db');
const { encryptJSON }                        = require('../middleware/encryption');
const { requireAuth }                        = require('../middleware/auth');
// STEP9 — shared webhook helper for internal event logging + optional n8n fanout
const { fireLeadWebhook } = require('../lib/webhooks');

const META_GRAPH = 'https://graph.facebook.com/v19.0';
const SCOPES     = 'instagram_basic,pages_show_list,pages_read_engagement,ads_read,instagram_content_publish';

// ── Nonce store ────────────────────────────────────────────────────────────────
// In-memory: nonce → { brand_id, return_to, expires }
const _nonces  = new Map();
const NONCE_TTL = 10 * 60 * 1000; // 10 min

function _storeNonce(nonce, brandId, returnTo) {
  _nonces.set(nonce, { brand_id: brandId, return_to: returnTo, expires: Date.now() + NONCE_TTL });
}
function _consumeNonce(nonce) {
  const e = _nonces.get(nonce);
  if (!e) return null;
  _nonces.delete(nonce);
  return Date.now() > e.expires ? null : e;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _nonces) if (now > v.expires) _nonces.delete(k);
}, 15 * 60 * 1000);

// ── Env helpers ────────────────────────────────────────────────────────────────
function getEnv() {
  return {
    appId:       process.env.META_APP_ID,
    appSecret:   process.env.META_APP_SECRET,
    redirectUri: process.env.META_REDIRECT_URI
      || 'https://optimize-backend-production.up.railway.app/auth/meta/callback',
  };
}

// ── GET /auth/meta/start ───────────────────────────────────────────────────────
// Requires authentication. brand_id must be in query (used to associate the token).
router.get('/start', requireAuth, (req, res) => {
  const { appId, redirectUri } = getEnv();

  if (!appId) {
    console.error('[meta-oauth] META_APP_ID not set');
    return res.status(503).send(
      'Meta OAuth is not configured on this server. Set META_APP_ID and META_APP_SECRET.'
    );
  }

  const { brand_id: brandId, return_to: returnTo = 'dashboard' } = req.query;

  if (!brandId) return res.status(400).send('Missing brand_id parameter');

  // Brand ownership check
  if (!req.user?._stub) {
    const jwtBrandId = req.user?.brandId;
    if (jwtBrandId && jwtBrandId !== brandId) {
      return res.status(403).send('Access denied to this brand');
    }
    if (!jwtBrandId) {
      const { userHasBrandAccess } = require('../db/db');
      if (!userHasBrandAccess(req.user.id, brandId)) {
        return res.status(403).send('Access denied to this brand');
      }
    }
  }

  // Verify brand exists
  const brand = db.prepare('SELECT id FROM brands WHERE id = ?').get(brandId);
  if (!brand) return res.status(400).send(`Brand "${brandId}" not found`);

  const nonce = crypto.randomBytes(16).toString('hex');
  _storeNonce(nonce, brandId, returnTo);

  const params = new URLSearchParams({
    client_id:     appId,
    redirect_uri:  redirectUri,
    scope:         SCOPES,
    response_type: 'code',
    state:         nonce,
  });

  const authUrl = `https://www.facebook.com/v19.0/dialog/oauth?${params}`;
  console.log(`[meta-oauth] redirecting brand=${brandId} to Meta OAuth`);
  res.redirect(authUrl);
});

// ── GET /auth/meta/callback ────────────────────────────────────────────────────
// Public — Meta redirects here after user approves.
router.get('/callback', async (req, res) => {
  const serverUrl   = (process.env.SERVER_URL || 'https://optimize-backend-production.up.railway.app').replace(/\/$/, '');
  const { appId, appSecret, redirectUri } = getEnv();
  const { code, state, error: metaError } = req.query;

  // User denied or Meta error
  if (metaError) {
    console.warn('[meta-oauth] Meta declined access:', metaError, req.query.error_description);
    return res.redirect(`${serverUrl}/?instagram=error&reason=denied`);
  }

  // Verify CSRF nonce
  const nonceEntry = _consumeNonce(state);
  if (!nonceEntry) {
    console.warn('[meta-oauth] invalid or expired state nonce');
    return res.redirect(`${serverUrl}/?instagram=error&reason=state`);
  }

  const { brand_id: brandId } = nonceEntry;

  if (!appId || !appSecret) {
    console.error('[meta-oauth] META_APP_ID / META_APP_SECRET not set');
    return res.redirect(`${serverUrl}/?instagram=error&reason=config`);
  }

  // ── Step 1: Exchange code for short-lived token ─────────────────────────────
  let shortToken;
  try {
    const r = await axios.get(`${META_GRAPH}/oauth/access_token`, {
      params: { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code },
      timeout: 15000,
    });
    shortToken = r.data.access_token;
    if (!shortToken) throw new Error('No access_token in response');
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.error(`[meta-oauth] code exchange failed brand=${brandId}:`, detail);
    return res.redirect(`${serverUrl}/?instagram=error&reason=token_exchange`);
  }

  // ── Step 2: Extend to 60-day long-lived token ───────────────────────────────
  let longToken, expiresIn;
  try {
    const r = await axios.get(`${META_GRAPH}/oauth/access_token`, {
      params: {
        grant_type:      'fb_exchange_token',
        client_id:       appId,
        client_secret:   appSecret,
        fb_exchange_token: shortToken,
      },
      timeout: 15000,
    });
    longToken = r.data.access_token;
    expiresIn = r.data.expires_in || (60 * 24 * 60 * 60); // default 60 days in seconds
    if (!longToken) throw new Error('No long-lived token in response');
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.error(`[meta-oauth] token extension failed brand=${brandId}:`, detail);
    // Fall back to short-lived token — sync will work for ~1h; meta.js will refresh
    longToken = shortToken;
    expiresIn = 3600;
  }

  // ── Step 3: Encrypt and store ────────────────────────────────────────────────
  const expiresAt   = new Date(Date.now() + expiresIn * 1000).toISOString();
  const credentials = { access_token: longToken, oauth: true };
  const encrypted   = encryptJSON(credentials);

  db.prepare(`
    INSERT INTO integrations (brand_id, platform, credentials, status, token_expires_at)
    VALUES (?, 'meta', ?, 'connected', ?)
    ON CONFLICT(brand_id, platform) DO UPDATE SET
      credentials      = excluded.credentials,
      status           = 'connected',
      token_expires_at = excluded.token_expires_at,
      sync_paused      = 0,
      last_sync        = NULL
  `).run(brandId, encrypted, expiresAt);

  setIntegrationHealth(brandId, 'meta', 'ok', null);
  console.log(`[meta-oauth] saved long-lived token brand=${brandId} expires=${expiresAt}`);

  // STEP9 — fire instagram_connected event (DB write + optional n8n fanout)
  fireLeadWebhook(brandId, null, 'instagram_connected', { source: 'oauth', expires_at: expiresAt }).catch(() => {});

  // ── Step 4: Discover IG account + trigger first sync in background ───────────
  setImmediate(async () => {
    try {
      const meta = require('../integrations/meta');
      // Run discover to populate page_id/ig_user_id in credentials
      await meta.discover(brandId, longToken);
      // Then full sync
      const { triggerSync } = require('../jobs/scheduler');
      await triggerSync(brandId, 'meta');
    } catch (err) {
      console.error(`[meta-oauth] post-connect sync error brand=${brandId}:`, err.message);
      logSync(brandId, 'meta', 'error', err.message, 0);
    }
  });

  // ── Step 5: Redirect to dashboard ───────────────────────────────────────────
  res.redirect(`${serverUrl}/?instagram=connected`);
});

module.exports = router;
