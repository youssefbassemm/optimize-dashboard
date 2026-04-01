'use strict';

/**
 * Meta (Facebook) Ads + Instagram integration module.
 *
 * Covers two surfaces:
 *   A) Meta Ads — campaign performance (spend, impressions, purchases, ROAS, CPA)
 *   B) Instagram Basic Display — follower count, media count, recent posts
 *
 * Auth:
 *   - Long-lived User Access Token stored encrypted in integrations table
 *   - Tokens last ~60 days; we extend them automatically 7 days before expiry
 *   - Credentials object: { access_token, ad_account_id, ig_user_id? }
 *     ad_account_id must be in "act_XXXXXXXX" format
 *
 * Meta Graph API base: https://graph.facebook.com/v19.0
 *
 * Endpoints used:
 *   GET /{ad_account_id}/insights
 *     ?fields=spend,impressions,actions,action_values
 *     &date_preset=<preset>
 *     &level=campaign
 *     → Campaign-level ad metrics
 *
 *   GET /me?fields=id,name
 *     → Verify token validity
 *
 *   GET /{ig_user_id}?fields=followers_count,media_count
 *     → Instagram profile metrics
 *
 *   GET /{ig_user_id}/media?fields=id,caption,media_type,timestamp,like_count,comments_count,thumbnail_url,media_url
 *     → Recent Instagram posts (limit 12)
 *
 * Token refresh:
 *   GET /oauth/access_token?grant_type=fb_exchange_token&client_id=...&client_secret=...&fb_exchange_token=...
 *   We call this when < 7 days remain (requires APP_ID + APP_SECRET in .env)
 *
 * Data stored:
 *   campaign_cache — one row per campaign per period (period = 'last_7d' etc.)
 *   ig_cache       — single rolling row per brand (replaced each sync)
 */

const axios = require('axios');
const { db, getIntegration, logSync, updateIntegrationStatus } = require('../db/db');
const { decryptJSON, encryptJSON } = require('../middleware/encryption');

const GRAPH_URL = 'https://graph.facebook.com/v19.0';

// Default date presets to fetch — stored separately so callers can override
const DEFAULT_PRESETS = ['last_7d', 'last_30d', 'this_month', 'last_month'];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function graphGet(path, params = {}) {
  const res = await axios.get(`${GRAPH_URL}${path}`, {
    params,
    timeout: 20000,
  });
  return res.data;
}

/**
 * Extract a named action value (e.g. "purchase") from Meta's actions array.
 * Meta returns: [ { action_type: "purchase", value: "12" }, ... ]
 */
function extractAction(actionsArr, actionType) {
  if (!Array.isArray(actionsArr)) return 0;
  const found = actionsArr.find((a) => a.action_type === actionType);
  return found ? parseFloat(found.value) || 0 : 0;
}

/**
 * Parse token expiry from debug endpoint.
 * Returns Unix timestamp or 0 on failure.
 */
async function getTokenExpiry(token, appId, appSecret) {
  try {
    const data = await graphGet('/debug_token', {
      input_token:  token,
      access_token: `${appId}|${appSecret}`,
    });
    return data?.data?.expires_at || 0;
  } catch (_) {
    return 0;
  }
}

// ── Token refresh ─────────────────────────────────────────────────────────────

/**
 * Exchange a short-lived or expiring token for a new long-lived one.
 * Requires META_APP_ID and META_APP_SECRET in .env.
 * Returns new token string, or null on failure.
 */
async function refreshToken(oldToken) {
  const appId     = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  if (!appId || !appSecret) {
    console.warn('[meta] META_APP_ID / META_APP_SECRET not set — cannot auto-refresh token');
    return null;
  }

  try {
    const res = await axios.get(`${GRAPH_URL}/oauth/access_token`, {
      params: {
        grant_type:       'fb_exchange_token',
        client_id:        appId,
        client_secret:    appSecret,
        fb_exchange_token: oldToken,
      },
      timeout: 15000,
    });
    return res.data?.access_token || null;
  } catch (err) {
    console.error('[meta] token refresh failed:', err.response?.data?.error?.message || err.message);
    return null;
  }
}

// ── Campaign insights ─────────────────────────────────────────────────────────

/**
 * Fetch campaign-level insights for one date preset and upsert into campaign_cache.
 * @param {string} brandId
 * @param {string} adAccountId   e.g. "act_123456789"
 * @param {string} token
 * @param {string} preset        e.g. "last_7d"
 * @returns {Promise<number>}    rows upserted
 */
async function fetchCampaignInsights(brandId, adAccountId, token, preset) {
  const data = await graphGet(`/${adAccountId}/insights`, {
    access_token: token,
    fields:       'campaign_id,campaign_name,spend,impressions,actions,action_values',
    date_preset:  preset,
    level:        'campaign',
    limit:        500,
  });

  const rows = data.data || [];
  if (!rows.length) return 0;

  const upsert = db.prepare(`
    INSERT INTO campaign_cache
      (brand_id, campaign_id, campaign_name, spend, impressions, purchases, purchase_value, roas, cpa, period)
    VALUES
      (@brand_id, @campaign_id, @campaign_name, @spend, @impressions, @purchases, @purchase_value, @roas, @cpa, @period)
    ON CONFLICT(brand_id, campaign_id, period) DO UPDATE SET
      campaign_name  = excluded.campaign_name,
      spend          = excluded.spend,
      impressions    = excluded.impressions,
      purchases      = excluded.purchases,
      purchase_value = excluded.purchase_value,
      roas           = excluded.roas,
      cpa            = excluded.cpa,
      fetched_at     = datetime('now')
  `);

  let count = 0;
  const insertMany = db.transaction((items) => {
    for (const row of items) {
      const spend    = parseFloat(row.spend) || 0;
      const purchases = extractAction(row.actions, 'purchase')
                     || extractAction(row.actions, 'omni_purchase')
                     || extractAction(row.actions, 'offsite_conversion.fb_pixel_purchase');
      const purchaseValue = extractAction(row.action_values, 'purchase')
                          || extractAction(row.action_values, 'omni_purchase')
                          || extractAction(row.action_values, 'offsite_conversion.fb_pixel_purchase');
      const roas = spend > 0 ? purchaseValue / spend : 0;
      const cpa  = purchases > 0 ? spend / purchases : 0;

      upsert.run({
        brand_id:       brandId,
        campaign_id:    row.campaign_id,
        campaign_name:  row.campaign_name,
        spend,
        impressions:    parseInt(row.impressions) || 0,
        purchases,
        purchase_value: purchaseValue,
        roas:           parseFloat(roas.toFixed(4)),
        cpa:            parseFloat(cpa.toFixed(4)),
        period:         preset,
      });
      count++;
    }
  });

  insertMany(rows);
  return count;
}

// ── Instagram metrics ─────────────────────────────────────────────────────────

/**
 * Fetch Instagram follower count, media count, and recent 12 posts.
 * Upserts a single row into ig_cache (replaces previous row for brand).
 */
async function fetchInstagram(brandId, igUserId, token) {
  // Profile
  const profile = await graphGet(`/${igUserId}`, {
    access_token: token,
    fields:       'followers_count,media_count',
  });

  // Recent posts
  let recentPosts = [];
  try {
    const media = await graphGet(`/${igUserId}/media`, {
      access_token: token,
      fields:       'id,caption,media_type,timestamp,like_count,comments_count,thumbnail_url,media_url',
      limit:        12,
    });
    recentPosts = (media.data || []).map((m) => ({
      id:             m.id,
      caption:        (m.caption || '').slice(0, 280),
      media_type:     m.media_type,
      timestamp:      m.timestamp,
      like_count:     m.like_count    || 0,
      comments_count: m.comments_count || 0,
      thumbnail_url:  m.thumbnail_url || m.media_url || null,
    }));
  } catch (err) {
    console.warn('[meta] Instagram media fetch failed:', err.message);
  }

  // Delete old row and insert fresh
  db.prepare("DELETE FROM ig_cache WHERE brand_id = ?").run(brandId);
  db.prepare(`
    INSERT INTO ig_cache (brand_id, followers_count, media_count, recent_posts)
    VALUES (?, ?, ?, ?)
  `).run(
    brandId,
    profile.followers_count || 0,
    profile.media_count     || 0,
    JSON.stringify(recentPosts)
  );

  return { followers_count: profile.followers_count, media_count: profile.media_count, posts: recentPosts.length };
}

// ── Public integration functions ──────────────────────────────────────────────

/**
 * Full Meta sync: campaigns for all presets + Instagram (if ig_user_id configured).
 * Never throws.
 */
async function fullSync(brandId) {
  console.log(`[meta] starting sync for brand=${brandId}`);

  const integration = getIntegration(brandId, 'meta');
  if (!integration || integration.status === 'disconnected') return;

  let creds;
  try {
    creds = decryptJSON(integration.credentials);
  } catch (err) {
    console.error('[meta] failed to decrypt credentials:', err.message);
    logSync(brandId, 'meta', 'error', 'Failed to decrypt stored credentials');
    return;
  }

  const { access_token, ad_account_id, ig_user_id } = creds;

  if (!access_token) {
    updateIntegrationStatus(brandId, 'meta', 'error');
    logSync(brandId, 'meta', 'error', 'No access_token in credentials');
    return;
  }

  // ── Auto-refresh token if expiring within 7 days ────────────────────────
  const appId     = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (appId && appSecret) {
    try {
      const expiresAt = await getTokenExpiry(access_token, appId, appSecret);
      const sevenDays = 7 * 24 * 3600;
      const remaining = expiresAt - Math.floor(Date.now() / 1000);

      if (expiresAt > 0 && remaining < sevenDays) {
        console.log(`[meta] token expires in ${Math.round(remaining / 86400)}d — refreshing`);
        const newToken = await refreshToken(access_token);
        if (newToken) {
          creds.access_token = newToken;
          db.prepare("UPDATE integrations SET credentials = ? WHERE brand_id = ? AND platform = 'meta'")
            .run(encryptJSON(creds), brandId);
          console.log('[meta] token refreshed and saved');
        }
      }
    } catch (err) {
      console.warn('[meta] token expiry check failed:', err.message);
    }
  }

  const token = creds.access_token;  // may have just been refreshed

  let totalRows = 0;
  let igResult  = null;
  let error     = null;

  // ── Campaign insights ──────────────────────────────────────────────────
  if (ad_account_id) {
    for (const preset of DEFAULT_PRESETS) {
      try {
        const n = await fetchCampaignInsights(brandId, ad_account_id, token, preset);
        totalRows += n;
        console.log(`[meta] preset=${preset} rows=${n}`);
      } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        console.error(`[meta] campaign fetch failed preset=${preset}:`, msg);
        error = error || msg;
      }
    }
  } else {
    console.warn('[meta] no ad_account_id — skipping campaign insights');
  }

  // ── Instagram ──────────────────────────────────────────────────────────
  if (ig_user_id) {
    try {
      igResult = await fetchInstagram(brandId, ig_user_id, token);
      console.log(`[meta] Instagram followers=${igResult.followers_count} posts=${igResult.posts}`);
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.error('[meta] Instagram fetch failed:', msg);
      error = error || msg;
    }
  }

  const status = error ? 'error' : 'connected';
  logSync(brandId, 'meta', error ? 'error' : 'success', error, totalRows);
  updateIntegrationStatus(brandId, 'meta', status);

  console.log(`[meta] sync done — campaign_rows=${totalRows} status=${status}`);
}

/**
 * Weekly check: look for tokens expiring within 7 days and attempt refresh.
 * If no app credentials configured, just flags status = 'warning'.
 */
async function checkTokenExpiry() {
  const rows = db.prepare(
    "SELECT brand_id, credentials FROM integrations WHERE platform = 'meta' AND status != 'disconnected'"
  ).all();

  const appId     = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  for (const row of rows) {
    let creds;
    try { creds = decryptJSON(row.credentials); } catch (_) { continue; }

    if (!creds.access_token) continue;

    let expiresAt = 0;
    if (appId && appSecret) {
      expiresAt = await getTokenExpiry(creds.access_token, appId, appSecret);
    }

    if (!expiresAt) continue;   // non-expiring or can't check

    const remaining = expiresAt - Math.floor(Date.now() / 1000);
    const days = Math.floor(remaining / 86400);

    if (remaining <= 0) {
      console.warn(`[meta] token EXPIRED for brand=${row.brand_id}`);
      db.prepare("UPDATE integrations SET status = 'error' WHERE brand_id = ? AND platform = 'meta'")
        .run(row.brand_id);
      logSync(row.brand_id, 'meta', 'error', 'Meta access token expired — reconnect in Settings');

    } else if (days < 7) {
      console.warn(`[meta] token expiring in ${days}d for brand=${row.brand_id} — attempting refresh`);
      const newToken = await refreshToken(creds.access_token);
      if (newToken) {
        creds.access_token = newToken;
        db.prepare("UPDATE integrations SET credentials = ? WHERE brand_id = ? AND platform = 'meta'")
          .run(encryptJSON(creds), row.brand_id);
        console.log(`[meta] token auto-refreshed for brand=${row.brand_id}`);
      } else {
        db.prepare("UPDATE integrations SET status = 'warning' WHERE brand_id = ? AND platform = 'meta'")
          .run(row.brand_id);
        logSync(row.brand_id, 'meta', 'error', `Meta token expires in ${days} days — reconnect in Settings`);
      }
    }
  }
}

/**
 * Return the latest cached campaign data for a brand.
 * @param {string} brandId
 * @param {string} period   e.g. "last_7d"
 * @returns {object[]}
 */
function getCampaigns(brandId, period = 'last_7d') {
  return db.prepare(`
    SELECT * FROM campaign_cache
    WHERE brand_id = ? AND period = ?
    ORDER BY spend DESC
  `).all(brandId, period);
}

/**
 * Return the latest cached Instagram data for a brand.
 * @param {string} brandId
 * @returns {object|null}
 */
function getInstagram(brandId) {
  const row = db.prepare(
    'SELECT * FROM ig_cache WHERE brand_id = ? ORDER BY fetched_at DESC LIMIT 1'
  ).get(brandId);

  if (!row) return null;
  try { row.recent_posts = JSON.parse(row.recent_posts); } catch (_) { row.recent_posts = []; }
  return row;
}

module.exports = {
  fetchCampaignInsights,
  fetchInstagram,
  fullSync,
  checkTokenExpiry,
  getCampaigns,
  getInstagram,
};
