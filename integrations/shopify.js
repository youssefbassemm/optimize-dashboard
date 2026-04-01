'use strict';

/**
 * Shopify integration module
 *
 * Auth method : Client Credentials Grant (Dev Dashboard apps)
 * Token URL   : POST https://{shop}/admin/oauth/access_token
 * Body        : grant_type=client_credentials&client_id=...&client_secret=...
 * Response    : { access_token, scope, expires_in: 86399 }
 * API header  : X-Shopify-Access-Token
 * API version : 2024-01
 *
 * Token lifecycle:
 *   - Tokens last ~24 h (expires_in ≈ 86399 seconds).
 *   - We refresh proactively when now >= expires_at − 5 minutes.
 *   - On 401 from a live API call we force-refresh once and retry.
 *   - client_secret is NEVER logged or returned to the frontend.
 *
 * Credential blob (encrypted at rest):
 *   { shop, client_id, client_secret, access_token, scope, expires_at }
 *   expires_at — Unix timestamp (seconds) when the current token expires.
 *
 * Quirks:
 *   - Pagination uses cursor-based page_info. Never use ?page=N.
 *   - Link header format: <URL>; rel="next", <URL>; rel="previous"
 *   - inventory_levels requires knowing location_ids first.
 *   - Webhook HMAC uses the app's client_secret (== API secret key).
 *   - Orders older than 60 days need status=any.
 */

const axios          = require('axios');
const { db, getIntegration, logSync, upsertOrder, upsertInventory, updateIntegrationStatus } = require('../db/db');
const { decryptJSON, encryptJSON } = require('../middleware/encryption');

const API_VERSION  = '2024-01';
const RATE_DELAY   = 520;            // ms between requests — safely under 2 req/s
const TOKEN_BUFFER = 5 * 60;        // seconds — refresh this early before expiry

// ── Low-level HTTP ────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Raw HTTP request with automatic rate-limit + server-error retry.
 * @private
 */
async function _httpRequest(url, options = {}, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await axios({ url, timeout: 15000, ...options });
    } catch (err) {
      const status = err.response?.status;

      if (status === 429) {
        const wait = (Number(err.response.headers['retry-after'] || 10)) * 1000;
        console.warn(`[shopify] 429 rate-limit — waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }

      if (attempt < retries && (!status || status >= 500)) {
        const backoff = Math.pow(2, attempt) * 1000;
        console.warn(`[shopify] attempt ${attempt + 1} failed (${status || 'network'}) — retrying in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }

      throw err;
    }
  }
}

// ── Token exchange ────────────────────────────────────────────────────────────

/**
 * Normalise a user-supplied shop string to "storename.myshopify.com".
 * Accepts: "storename", "storename.myshopify.com", "https://storename.myshopify.com/"
 */
function normaliseShop(raw) {
  let shop = (raw || '').trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '')
    .toLowerCase();

  if (!shop.includes('.')) {
    shop = `${shop}.myshopify.com`;
  }

  if (!shop.endsWith('.myshopify.com')) {
    throw new Error(`Invalid shop domain "${raw}" — must be a .myshopify.com store`);
  }

  return shop;
}

/**
 * Exchange client credentials for an access token.
 * @param {string} shop        — normalised, e.g. "storename.myshopify.com"
 * @param {string} clientId
 * @param {string} clientSecret — never logged
 * @returns {Promise<{ access_token: string, scope: string, expires_at: number }>}
 */
async function exchangeToken(shop, clientId, clientSecret) {
  const url = `https://${shop}/admin/oauth/access_token`;

  let res;
  try {
    res = await axios.post(url, new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
    }).toString(), {
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout:  15000,
    });
  } catch (err) {
    const status = err.response?.status;
    const body   = err.response?.data;

    if (status === 401 || status === 403) {
      throw new Error('Shopify rejected credentials — verify client_id and client_secret in your Dev Dashboard app');
    }
    if (status === 404) {
      throw new Error(`Shop "${shop}" not found — verify the shop domain is correct`);
    }

    const detail = body ? JSON.stringify(body) : err.message;
    throw new Error(`Token exchange failed (HTTP ${status || 'network'}): ${detail}`);
  }

  const { access_token, scope, expires_in } = res.data;

  if (!access_token) {
    throw new Error('Token exchange returned no access_token — unexpected Shopify response');
  }

  const expiresAt = Math.floor(Date.now() / 1000) + (Number(expires_in) || 86399);

  return { access_token, scope: scope || '', expires_at: expiresAt };
}

// ── Token lifecycle ───────────────────────────────────────────────────────────

/**
 * Return a valid Shopify access token for brandId, refreshing if expired.
 *
 * @param {string} brandId
 * @returns {Promise<{ token: string, shop: string }>}
 * @throws if integration is missing, credentials corrupt, or refresh fails.
 */
async function getValidShopifyAccessToken(brandId) {
  const integration = getIntegration(brandId, 'shopify');
  if (!integration || integration.status === 'disconnected') {
    throw new Error(`Shopify integration not connected for brand=${brandId}`);
  }

  let creds;
  try {
    creds = decryptJSON(integration.credentials);
  } catch (_) {
    throw new Error('Failed to decrypt Shopify credentials — reconnect in Settings');
  }

  const { shop, client_id, client_secret, access_token, expires_at } = creds;

  if (!shop || !client_id || !client_secret) {
    throw new Error('Incomplete Shopify credentials — reconnect in Settings');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const tokenValid = access_token && expires_at && (nowSec < expires_at - TOKEN_BUFFER);

  if (tokenValid) {
    return { token: access_token, shop };
  }

  // Token missing or about to expire — refresh
  console.log(`[shopify] refreshing token for brand=${brandId}`);
  const fresh = await exchangeToken(shop, client_id, client_secret);

  const updatedCreds = {
    ...creds,
    access_token: fresh.access_token,
    scope:        fresh.scope,
    expires_at:   fresh.expires_at,
  };

  // Persist updated token and expiry
  const expiresIso = new Date(fresh.expires_at * 1000).toISOString();
  db.prepare(
    "UPDATE integrations SET credentials = ?, token_expires_at = ?, status = 'connected' WHERE brand_id = ? AND platform = 'shopify'"
  ).run(encryptJSON(updatedCreds), expiresIso, brandId);

  console.log(`[shopify] token refreshed for brand=${brandId} — expires ${expiresIso}`);
  return { token: fresh.access_token, shop };
}

/**
 * Force-refresh the token regardless of expiry (called after a 401).
 * @private
 */
async function _forceRefreshToken(brandId) {
  const integration = getIntegration(brandId, 'shopify');
  const creds       = decryptJSON(integration.credentials);
  const { shop, client_id, client_secret } = creds;

  const fresh = await exchangeToken(shop, client_id, client_secret);
  const updatedCreds = { ...creds, access_token: fresh.access_token, scope: fresh.scope, expires_at: fresh.expires_at };
  const expiresIso   = new Date(fresh.expires_at * 1000).toISOString();

  db.prepare(
    "UPDATE integrations SET credentials = ?, token_expires_at = ?, status = 'connected' WHERE brand_id = ? AND platform = 'shopify'"
  ).run(encryptJSON(updatedCreds), expiresIso, brandId);

  return { token: fresh.access_token, shop };
}

// ── Public request helper ─────────────────────────────────────────────────────

/**
 * Make an authenticated Shopify Admin API request.
 *
 * Handles token refresh automatically — if the token is expired, it is
 * refreshed before the request. If a 401 is received mid-request, the token
 * is force-refreshed and the request is retried once.
 *
 * @param {object} opts
 * @param {string}  opts.brandId
 * @param {string}  [opts.method='GET']
 * @param {string}  opts.path      — e.g. '/orders.json'
 * @param {object}  [opts.query]   — URL query params (plain object)
 * @param {object}  [opts.body]    — request body (JSON)
 * @returns {Promise<import('axios').AxiosResponse>}
 */
async function shopifyRequest({ brandId, method = 'GET', path, query, body }) {
  let { token, shop } = await getValidShopifyAccessToken(brandId);

  const params = query ? '?' + new URLSearchParams(query).toString() : '';
  const url    = `https://${shop}/admin/api/${API_VERSION}${path}${params}`;
  const hdrs   = {
    'X-Shopify-Access-Token': token,
    'Content-Type':           'application/json',
  };

  try {
    return await _httpRequest(url, { method, headers: hdrs, data: body });
  } catch (err) {
    if (err.response?.status === 401) {
      console.warn(`[shopify] 401 mid-request for brand=${brandId} — force-refreshing token and retrying`);
      const refreshed = await _forceRefreshToken(brandId);
      hdrs['X-Shopify-Access-Token'] = refreshed.token;
      // Second attempt — if this also 401s, let it propagate
      return await _httpRequest(url, { method, headers: hdrs, data: body });
    }
    throw err;
  }
}

// ── Connection management ─────────────────────────────────────────────────────

/**
 * Connect a Shopify store for brandId using the client credentials grant.
 *
 * 1. Normalises the shop domain
 * 2. Exchanges credentials for an access token (validates they work)
 * 3. Encrypts and saves the full credential blob to the integrations table
 *
 * @param {string} brandId
 * @param {object} input   — { shop, client_id, client_secret }
 * @returns {Promise<{ shop: string, scope: string }>}  — client_secret never returned
 * @throws on bad credentials, unknown shop, network errors
 */
async function connect(brandId, { shop: rawShop, client_id, client_secret }) {
  const shop = normaliseShop(rawShop);

  // Exchange credentials — this validates they are correct before saving
  const { access_token, scope, expires_at } = await exchangeToken(shop, client_id, client_secret);

  const creds = { shop, client_id, client_secret, access_token, scope, expires_at };
  const encrypted    = encryptJSON(creds);
  const expiresIso   = new Date(expires_at * 1000).toISOString();

  // Upsert into integrations table
  db.prepare(`
    INSERT INTO integrations (brand_id, platform, credentials, status, token_expires_at)
    VALUES (?, 'shopify', ?, 'connected', ?)
    ON CONFLICT(brand_id, platform) DO UPDATE SET
      credentials      = excluded.credentials,
      status           = excluded.status,
      token_expires_at = excluded.token_expires_at,
      last_sync        = NULL
  `).run(brandId, encrypted, expiresIso);

  console.log(`[shopify] connected brand=${brandId} shop=${shop} scope=${scope}`);
  return { shop, scope };
}

// ── Test connection ───────────────────────────────────────────────────────────

/**
 * Test that the stored credentials are still valid.
 * Forces a token refresh then hits /shop.json.
 * Updates last_tested_at and last_error in the integrations row.
 *
 * @param {string} brandId
 * @returns {Promise<{ ok: boolean, shop: string, scope: string, error?: string }>}
 */
async function testConnection(brandId) {
  let shop, error;
  try {
    const tokenData = await getValidShopifyAccessToken(brandId);
    shop = tokenData.shop;

    const res = await shopifyRequest({ brandId, path: '/shop.json' });
    const shopName = res.data?.shop?.name || shop;

    // Mark last_tested_at
    db.prepare(
      "UPDATE integrations SET last_tested_at = datetime('now'), last_error = NULL WHERE brand_id = ? AND platform = 'shopify'"
    ).run(brandId);

    return { ok: true, shop: shopName, scope: res.data?.shop?.enabled_presentment_currencies || '' };

  } catch (err) {
    error = err.message;
    db.prepare(
      "UPDATE integrations SET last_tested_at = datetime('now'), last_error = ? WHERE brand_id = ? AND platform = 'shopify'"
    ).run(error, brandId);

    return { ok: false, shop: shop || '', error };
  }
}

// ── Standard header builder (for internal sub-functions) ─────────────────────

function _hdrs(token) {
  return {
    'X-Shopify-Access-Token': token,
    'Content-Type':           'application/json',
  };
}

/**
 * Extract next-page URL from a Shopify Link header.
 */
function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

// ── Order normalization ───────────────────────────────────────────────────────

function needsAction(order) {
  if (order.cancelled_at)                          return { flag: false };
  if (order.financial_status !== 'paid')           return { flag: false };
  if (order.fulfillment_status === 'fulfilled')    return { flag: false };

  const ageMs = Date.now() - new Date(order.created_at).getTime();
  if (ageMs > 48 * 60 * 60 * 1000) {
    return { flag: true, reason: 'Order paid but not shipped — over 48 hours old' };
  }
  return { flag: false };
}

function derivePaymentMethod(order) {
  const gw = (order.payment_gateway || '').toLowerCase();
  if (gw.includes('cash'))  return 'cash';
  if (gw.includes('cod'))   return 'cod';
  if (gw.includes('card') || gw.includes('stripe') || gw.includes('payfort')) return 'card';
  const names = (order.payment_gateway_names || []).join(' ').toLowerCase();
  if (names.includes('cash')) return 'cash';
  if (names.includes('cod'))  return 'cod';
  return gw || 'unknown';
}

function normalizeOrder(brandId, o) {
  const ship = o.shipping_address || o.billing_address || {};
  const cust = o.customer         || {};
  const addr = o.billing_address  || {};

  const customerName = ship.name
    || `${cust.first_name || ''} ${cust.last_name || ''}`.trim()
    || addr.name
    || 'Unknown';

  const phone = ship.phone || cust.phone || addr.phone || '';
  const city  = ship.city  || addr.city  || '';

  const items = (o.line_items || []).map((li) => ({
    name:    li.title,
    variant: li.variant_title || null,
    qty:     li.quantity,
    price:   parseFloat(li.price) || 0,
    sku:     li.sku || null,
  }));

  const shipping = {
    carrier:         null,
    tracking_number: null,
    status:          o.fulfillment_status || 'unfulfilled',
    timeline:        [],
  };

  const firstFulfillment = (o.fulfillments || [])[0];
  if (firstFulfillment) {
    shipping.tracking_number = firstFulfillment.tracking_number || null;
    shipping.carrier         = firstFulfillment.tracking_company || null;
  }

  const { flag, reason } = needsAction(o);

  return {
    brand_id:           brandId,
    source:             'shopify',
    source_order_id:    o.name || String(o.id),
    customer_name:      customerName,
    phone,
    city,
    items:              JSON.stringify(items),
    total:              parseFloat(o.total_price) || 0,
    currency:           o.currency || 'EGP',
    payment_method:     derivePaymentMethod(o),
    financial_status:   o.financial_status,
    fulfillment_status: o.fulfillment_status || 'unfulfilled',
    shipping:           JSON.stringify(shipping),
    needs_action:       flag ? 1 : 0,
    action_reason:      reason || null,
    raw_data:           JSON.stringify(o),
    created_at:         o.created_at,
  };
}

// ── Data fetching functions ───────────────────────────────────────────────────

/**
 * Fetch all orders from Shopify and upsert into orders_cache.
 * @param {string} brandId
 * @param {string} shopDomain   — e.g. "storename.myshopify.com"
 * @param {string} token        — valid access token
 * @param {string} [sinceDate]  — ISO8601 — only fetch orders created after this
 */
async function fetchOrders(brandId, shopDomain, token, sinceDate) {
  const base = `https://${shopDomain}/admin/api/${API_VERSION}`;
  const hdrs = _hdrs(token);

  const params = new URLSearchParams({
    status: 'any',
    limit:  '250',
    fields: [
      'id','name','created_at','updated_at','cancelled_at',
      'financial_status','fulfillment_status','fulfillments',
      'customer','shipping_address','billing_address',
      'line_items','total_price','currency',
      'payment_gateway','payment_gateway_names','tags',
    ].join(','),
  });
  if (sinceDate) params.set('created_at_min', sinceDate);

  let url   = `${base}/orders.json?${params}`;
  let count = 0;

  while (url) {
    await sleep(RATE_DELAY);
    const res    = await _httpRequest(url, { headers: hdrs });
    const orders = res.data.orders || [];

    for (const o of orders) {
      upsertOrder(normalizeOrder(brandId, o));
      count++;
    }

    url = parseNextLink(res.headers.link);
  }

  console.log(`[shopify] fetched ${count} orders for brand=${brandId}`);
  return count;
}

/**
 * Fetch all products and upsert into inventory_cache.
 * @param {string} brandId
 * @param {string} shopDomain
 * @param {string} token
 */
async function fetchProducts(brandId, shopDomain, token) {
  const base = `https://${shopDomain}/admin/api/${API_VERSION}`;
  const hdrs = _hdrs(token);

  let url   = `${base}/products.json?limit=250&fields=id,title,variants`;
  let count = 0;

  while (url) {
    await sleep(RATE_DELAY);
    const res      = await _httpRequest(url, { headers: hdrs });
    const products = res.data.products || [];

    for (const p of products) {
      for (const v of p.variants || []) {
        const sku = v.sku || `${p.id}-${v.id}`;
        upsertInventory({
          brand_id:     brandId,
          source:       'shopify',
          product_name: p.title,
          variant_name: v.title !== 'Default Title' ? v.title : null,
          sku,
          quantity:     v.inventory_quantity || 0,
          price:        parseFloat(v.price) || 0,
          raw_data:     JSON.stringify({ product_id: p.id, variant_id: v.id, ...v }),
        });
        count++;
      }
    }

    url = parseNextLink(res.headers.link);
  }

  console.log(`[shopify] fetched ${count} variants for brand=${brandId}`);
  return count;
}

/**
 * Refresh inventory quantities from the Inventory Levels API.
 * @param {string} brandId
 * @param {string} shopDomain
 * @param {string} token
 */
async function fetchInventoryLevels(brandId, shopDomain, token) {
  const base = `https://${shopDomain}/admin/api/${API_VERSION}`;
  const hdrs = _hdrs(token);

  await sleep(RATE_DELAY);
  const locRes    = await _httpRequest(`${base}/locations.json`, { headers: hdrs });
  const locations = locRes.data.locations || [];

  if (!locations.length) {
    console.warn('[shopify] no locations found — skipping inventory level sync');
    return 0;
  }

  const updateStmt = db.prepare(`
    UPDATE inventory_cache
    SET quantity = ?, updated_at = datetime('now')
    WHERE brand_id = ? AND source = 'shopify'
      AND json_extract(raw_data, '$.inventory_item_id') = ?
  `);

  let count = 0;
  for (const loc of locations) {
    let url = `${base}/inventory_levels.json?location_ids=${loc.id}&limit=250`;
    while (url) {
      await sleep(RATE_DELAY);
      const res    = await _httpRequest(url, { headers: hdrs });
      const levels = res.data.inventory_levels || [];

      const updateMany = db.transaction((lvls) => {
        for (const lvl of lvls) {
          updateStmt.run(lvl.available || 0, brandId, lvl.inventory_item_id);
          count++;
        }
      });
      updateMany(levels);

      url = parseNextLink(res.headers.link);
    }
  }

  console.log(`[shopify] updated ${count} inventory levels for brand=${brandId}`);
  return count;
}

/**
 * Register Shopify webhooks for real-time updates.
 * Safe to call repeatedly — skips topics already registered.
 * @param {string} brandId
 * @param {string} shopDomain
 * @param {string} token
 */
async function registerWebhooks(brandId, shopDomain, token) {
  const serverUrl = process.env.SERVER_URL;
  if (!serverUrl || serverUrl.includes('localhost')) {
    console.warn(
      '[shopify] SERVER_URL is localhost — webhook registration skipped. ' +
      'Set SERVER_URL to a public URL to enable real-time updates.'
    );
    return;
  }

  const base         = `https://${shopDomain}/admin/api/${API_VERSION}`;
  const hdrs         = _hdrs(token);
  const callbackBase = `${serverUrl}/api/webhooks/shopify/${brandId}`;

  const topics = ['orders/create', 'orders/updated', 'inventory_levels/update'];

  await sleep(RATE_DELAY);
  const existing   = await _httpRequest(`${base}/webhooks.json`, { headers: hdrs });
  const registered = (existing.data.webhooks || []).map((w) => w.topic);

  for (const topic of topics) {
    if (registered.includes(topic)) {
      console.log(`[shopify] webhook already registered: ${topic}`);
      continue;
    }
    await sleep(RATE_DELAY);
    try {
      await _httpRequest(`${base}/webhooks.json`, {
        method:  'POST',
        headers: hdrs,
        data: { webhook: { topic, address: callbackBase, format: 'json' } },
      });
      console.log(`[shopify] registered webhook: ${topic} → ${callbackBase}`);
    } catch (err) {
      console.error(`[shopify] failed to register webhook ${topic}:`, err.response?.data || err.message);
    }
  }
}

// ── Scheduled sync ────────────────────────────────────────────────────────────

/**
 * Full sync: orders (last 90 days) + products + inventory levels.
 * Scheduled entry point — called every 6 hours. Never throws.
 * @param {string} brandId
 */
async function fullSync(brandId) {
  console.log(`[shopify] starting full sync for brand=${brandId}`);

  const integration = getIntegration(brandId, 'shopify');
  if (!integration || integration.status === 'disconnected') {
    console.log(`[shopify] no active integration for brand=${brandId} — skipping`);
    return;
  }

  // Get a valid token — this refreshes automatically if expired
  let tokenData;
  try {
    tokenData = await getValidShopifyAccessToken(brandId);
  } catch (err) {
    console.error(`[shopify] cannot get token for brand=${brandId}:`, err.message);
    logSync(brandId, 'shopify', 'error', err.message);
    updateIntegrationStatus(brandId, 'shopify', 'error');
    return;
  }

  const { token, shop } = tokenData;
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  let orderCount   = 0;
  let variantCount = 0;
  let error        = null;

  try {
    orderCount   = await fetchOrders(brandId, shop, token, since);
    variantCount = await fetchProducts(brandId, shop, token);
    await fetchInventoryLevels(brandId, shop, token);
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      error = 'Access token rejected — reconnect Shopify in Settings';
      updateIntegrationStatus(brandId, 'shopify', 'error');
    } else {
      error = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    }
    console.error(`[shopify] sync error for brand=${brandId}:`, error);
  }

  logSync(brandId, 'shopify', error ? 'error' : 'success', error, orderCount + variantCount);
  if (!error) updateIntegrationStatus(brandId, 'shopify', 'connected');

  console.log(`[shopify] sync complete — orders=${orderCount} variants=${variantCount} status=${error ? 'error' : 'success'}`);
}

// ── Webhook handler ───────────────────────────────────────────────────────────

/**
 * Handle an incoming Shopify webhook event.
 * Called by routes/webhooks.js after HMAC verification.
 * @param {string} brandId
 * @param {string} topic
 * @param {object} payload
 */
async function handleWebhook(brandId, topic, payload) {
  console.log(`[shopify] webhook received: topic=${topic} brand=${brandId}`);

  if (topic === 'orders/create' || topic === 'orders/updated') {
    upsertOrder(normalizeOrder(brandId, payload));
    logSync(brandId, 'shopify', 'success', null, 1);
  }

  if (topic === 'inventory_levels/update') {
    db.prepare(`
      UPDATE inventory_cache
      SET quantity = ?, updated_at = datetime('now')
      WHERE brand_id = ? AND source = 'shopify'
        AND json_extract(raw_data, '$.inventory_item_id') = ?
    `).run(payload.available || 0, brandId, payload.inventory_item_id);
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Connection management
  connect,
  testConnection,
  normaliseShop,
  // Token management
  getValidShopifyAccessToken,
  exchangeToken,
  // Public request helper
  shopifyRequest,
  // Data functions
  fetchOrders,
  fetchProducts,
  fetchInventoryLevels,
  registerWebhooks,
  // Scheduled job
  fullSync,
  // Webhook handler
  handleWebhook,
};
