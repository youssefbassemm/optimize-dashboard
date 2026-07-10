'use strict';

/**
 * Shopify Admin API integration
 *
 * Primary transport:  GraphQL Admin API 2025-01
 * Webhook payloads:   REST JSON (Shopify always sends webhooks as REST; no choice)
 *
 * ── Authentication modes ────────────────────────────────────────────────────
 *   A. OAuth 2.0           permanent token, never expires
 *   B. Client Credentials  short-lived (~24 h), auto-refreshes before expiry
 *
 * ── Sync strategy ──────────────────────────────────────────────────────────
 *   1. Full sync on first connect  — all orders since 2020, all products
 *   2. Incremental on schedule     — orders updated since last_sync only
 *   3. Real-time via webhooks      — order create/update, inventory, products
 *   4. Webhook queue               — failed handlers retried with back-off
 *
 * ── Rate limiting ───────────────────────────────────────────────────────────
 *   GraphQL bucket: 1 000 query-cost points, restores at 50/s.
 *   We sleep RATE_DELAY ms between pages and back off on THROTTLED responses.
 */

const axios  = require('axios');
const crypto = require('crypto');
const {
  db,
  getIntegration,
  logSync,
  upsertOrder,
  upsertOrderItems,
  upsertInventory,
  updateIntegrationStatus,
  setIntegrationHealth,
  enqueueWebhook,
} = require('../db/db');
const { encryptJSON, decryptJSON } = require('../middleware/encryption');

// ── Constants ──────────────────────────────────────────────────────────────────

const API_VERSION = '2025-01';
const PAGE_SIZE   = 50;    // nodes per GQL page — keeps query cost ≈ 51 points
const RATE_DELAY  = 550;   // ms between paginated requests (safe under limits)

// ── Low-level helpers ──────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "gid://shopify/Order/1234567890" → "1234567890" */
function parseGid(gid) {
  return String(gid || '').split('/').pop();
}

function mapFinancialStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'paid' || s === 'partially_paid')         return 'paid';
  if (s === 'refunded' || s === 'partially_refunded') return 'refunded';
  if (s === 'voided')                                 return 'voided';
  return 'pending';
}

function mapFulfillmentStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'fulfilled') return 'fulfilled';
  if (s === 'partial')   return 'partial';
  if (s === 'restocked') return 'restocked';
  return 'unfulfilled';
}

// ── GraphQL client ─────────────────────────────────────────────────────────────

/**
 * Execute one Shopify GraphQL request.
 * Retries up to 3× on THROTTLED; throws on any other error.
 */
async function shopifyGQL(shop, token, query, variables = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await axios.post(
        `https://${shop}/admin/api/${API_VERSION}/graphql.json`,
        { query, variables },
        {
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) {
        const wait = parseInt(err.response?.headers?.['retry-after'] || '2', 10);
        console.warn(`[shopify] GQL 429 — waiting ${wait}s`);
        await sleep(wait * 1000);
        continue;
      }
      throw new Error(`Shopify GQL request failed (HTTP ${status || 'network'}): ${err.message}`);
    }

    const { data, errors, extensions } = res.data;

    if (errors?.some((e) => e.extensions?.code === 'THROTTLED')) {
      const wait = errors[0]?.extensions?.retryAfter || 2;
      console.warn(`[shopify] GQL THROTTLED — waiting ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }

    if (errors?.length) {
      throw new Error(`Shopify GQL: ${errors[0]?.message || JSON.stringify(errors[0])}`);
    }

    if (process.env.DEBUG_GQL === 'true' && extensions?.cost) {
      const { requestedQueryCost, throttleStatus } = extensions.cost;
      console.debug(`[shopify] GQL cost=${requestedQueryCost} available=${throttleStatus?.currentlyAvailable}`);
    }

    return data;
  }
  throw new Error('[shopify] GQL: max retries exceeded');
}

/**
 * Async generator that paginates through any Shopify GQL connection.
 * Yields arrays of nodes one page at a time.
 *
 * @param {string}   shop
 * @param {string}   token
 * @param {string}   query      must declare `$after: String` variable
 * @param {object}   baseVars   all variables except `after`
 * @param {Function} getConn    (data) → { pageInfo, edges }
 */
async function* gqlPages(shop, token, query, baseVars, getConn) {
  let cursor  = null;
  let hasMore = true;

  while (hasMore) {
    await sleep(RATE_DELAY);
    const data = await shopifyGQL(shop, token, query, { ...baseVars, after: cursor });
    const conn = getConn(data);
    if (!conn) break;

    const nodes = (conn.edges || []).map((e) => e.node);
    if (nodes.length > 0) yield nodes;

    hasMore = conn.pageInfo?.hasNextPage ?? false;
    cursor  = conn.pageInfo?.endCursor  ?? null;
  }
}

// ── GraphQL query strings ──────────────────────────────────────────────────────

// Sorted by UPDATED_AT so incremental sync captures all modified orders.
const ORDERS_QUERY = `
  query GetOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          name
          email
          phone
          createdAt
          updatedAt
          cancelledAt
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          lineItems(first: 50) {
            edges {
              node {
                title
                quantity
                sku
                originalUnitPriceSet { shopMoney { amount } }
                variant { id title }
              }
            }
          }
          shippingAddress { city province country countryCodeV2 }
          customer { id firstName lastName email phone }
          fulfillments {
            status
            createdAt
            trackingInfo { number company url }
          }
          paymentGatewayNames
          tags
          note
        }
      }
    }
  }
`;

// inventory_item_id is stored per-variant so the inventory_levels/update
// webhook can resolve the correct inventory_cache row without a table scan.
const PRODUCTS_QUERY = `
  query GetProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          handle
          status
          variants(first: 100) {
            edges {
              node {
                id
                title
                sku
                price
                inventoryQuantity
                inventoryItem { id }
              }
            }
          }
        }
      }
    }
  }
`;

// ── Order normalisation ────────────────────────────────────────────────────────

/** Normalise a Shopify order from GQL format (scheduled sync). */
function normalizeOrderGQL(brandId, o) {
  const orderId  = parseGid(o.id);
  const customer = o.customer || {};
  const name = [customer.firstName, customer.lastName].filter(Boolean).join(' ')
    || o.email || 'Guest';

  const items = (o.lineItems?.edges || []).map((e) => ({
    name:    e.node.title,
    variant: e.node.variant?.title || null,
    qty:     e.node.quantity,
    price:   parseFloat(e.node.originalUnitPriceSet?.shopMoney?.amount || 0),
    sku:     e.node.sku || null,
  }));

  const totalItems        = items.reduce((s, i) => s + (i.qty || 1), 0);
  const total             = parseFloat(o.totalPriceSet?.shopMoney?.amount || 0);
  const currency          = o.totalPriceSet?.shopMoney?.currencyCode || 'EGP';
  const financialStatus   = mapFinancialStatus(o.displayFinancialStatus);
  const fulfillmentStatus = mapFulfillmentStatus(o.displayFulfillmentStatus);

  const fulfillments = o.fulfillments || [];
  const firstFull    = fulfillments[0] || {};
  const firstTrack   = (firstFull.trackingInfo || [])[0] || {};
  const shipping = {
    carrier:         firstTrack.company  || null,
    tracking_number: firstTrack.number   || null,
    tracking_url:    firstTrack.url      || null,
    status:          firstFull.status?.toLowerCase() || 'unfulfilled',
    timeline: fulfillments.map((f) => ({
      status:     f.status,
      created_at: f.createdAt,
      tracking:   (f.trackingInfo || [])[0] || null,
    })),
  };

  const pmRaw = (o.paymentGatewayNames || [])[0]?.toLowerCase() || '';
  const needsAction = financialStatus === 'pending' && fulfillmentStatus !== 'fulfilled' ? 1 : 0;

  return {
    brand_id:           brandId,
    source:             'shopify',
    source_order_id:    orderId,
    customer_name:      name,
    phone:              customer.phone || o.phone || '',
    city:               o.shippingAddress?.city || '',
    items:              JSON.stringify(items),
    total,
    total_items:        totalItems,
    currency,
    payment_method:     pmRaw.includes('cash') ? 'cash' : 'card',
    financial_status:   financialStatus,
    fulfillment_status: fulfillmentStatus,
    shipping:           JSON.stringify(shipping),
    needs_action:       needsAction,
    action_reason:      needsAction ? 'pending_payment' : null,
    raw_data:           JSON.stringify(o),
    created_at:         o.createdAt,
    _items:             items,
  };
}

/**
 * Normalise a Shopify order from REST/webhook format.
 * Shopify always delivers webhook payloads as REST JSON — this is unavoidable.
 */
function normalizeOrder(brandId, o) {
  const orderId  = String(o.id || '');
  const customer = o.customer || {};
  const name = [customer.first_name, customer.last_name].filter(Boolean).join(' ')
    || o.email || 'Guest';

  const items = (o.line_items || []).map((li) => ({
    name:    li.title,
    variant: li.variant_title || null,
    qty:     li.quantity,
    price:   parseFloat(li.price || 0),
    sku:     li.sku || null,
  }));

  const totalItems        = items.reduce((s, i) => s + (i.qty || 1), 0);
  const total             = parseFloat(o.total_price || 0);
  const currency          = o.currency || 'EGP';
  const financialStatus   = mapFinancialStatus(o.financial_status);
  const fulfillmentStatus = mapFulfillmentStatus(o.fulfillment_status);

  const fulfillments = o.fulfillments || [];
  const firstFull    = fulfillments[0] || {};
  const shipping = {
    carrier:         firstFull.tracking_company || null,
    tracking_number: firstFull.tracking_number  || null,
    tracking_url:    firstFull.tracking_url      || null,
    status:          firstFull.shipment_status   || 'unfulfilled',
    timeline: fulfillments.map((f) => ({
      status:     f.status,
      created_at: f.created_at,
      tracking:   f.tracking_number
        ? { number: f.tracking_number, company: f.tracking_company }
        : null,
    })),
  };

  const pmRaw       = (o.payment_gateway || '').toLowerCase();
  const needsAction = financialStatus === 'pending' && fulfillmentStatus !== 'fulfilled' ? 1 : 0;

  return {
    brand_id:           brandId,
    source:             'shopify',
    source_order_id:    orderId,
    customer_name:      name,
    phone:              customer.phone || o.billing_address?.phone || '',
    city:               o.shipping_address?.city || o.billing_address?.city || '',
    items:              JSON.stringify(items),
    total,
    total_items:        totalItems,
    currency,
    payment_method:     pmRaw.includes('cash') ? 'cash' : 'card',
    financial_status:   financialStatus,
    fulfillment_status: fulfillmentStatus,
    shipping:           JSON.stringify(shipping),
    needs_action:       needsAction,
    action_reason:      needsAction ? 'pending_payment' : null,
    raw_data:           JSON.stringify(o),
    created_at:         o.created_at,
    _items:             items,
  };
}

// ── Data fetchers (GraphQL) ────────────────────────────────────────────────────

/**
 * Fetch orders updated since `sinceDate` and upsert into orders_cache.
 *
 * Uses `updated_at` filter (not `created_at`) so status changes and
 * fulfillment updates are captured during incremental syncs.
 *
 * @param {string}      brandId
 * @param {string}      shop
 * @param {string}      token
 * @param {string|null} sinceDate  ISO timestamp; null = full historical fetch
 * @returns {Promise<number>}      rows upserted
 */
async function fetchOrders(brandId, shop, token, sinceDate = null) {
  const filter = sinceDate
    ? `updated_at:>"${sinceDate}"`
    : 'updated_at:>"2020-01-01T00:00:00Z"';

  let count = 0;

  for await (const page of gqlPages(
    shop, token, ORDERS_QUERY,
    { first: PAGE_SIZE, query: filter },
    (d) => d.orders
  )) {
    for (const o of page) {
      try {
        const normalized       = normalizeOrderGQL(brandId, o);
        const { _items, ...row } = normalized;
        upsertOrder(row);
        count++;
        if (_items?.length) {
          try { upsertOrderItems(brandId, 'shopify', row.source_order_id, _items); }
          catch (_) { /* non-fatal */ }
        }
      } catch (err) {
        console.error(`[shopify] order upsert failed id=${o.id}:`, err.message);
      }
    }
  }

  console.log(`[shopify] fetchOrders: ${count} upserted (filter="${filter}") brand=${brandId}`);
  return count;
}

/**
 * Fetch all products + variants; upsert into inventory_cache.
 *
 * CRITICAL FIX: The old REST implementation never stored `inventory_item_id`
 * in raw_data, so the `inventory_levels/update` webhook's UPDATE query matched
 * 0 rows every time. This version stores it explicitly:
 *   raw_data → { product_id, variant_id, inventory_item_id, ... }
 * The webhook handler can now do:
 *   WHERE json_extract(raw_data, '$.inventory_item_id') = payload.inventory_item_id
 *
 * `inventoryQuantity` is the aggregate across all locations. For single-location
 * stores (standard for Egyptian brands) this is exact. For multi-location stores,
 * the `inventory_levels/update` webhook corrects per-location quantities in real time.
 *
 * @returns {Promise<number>} variant rows upserted
 */
async function fetchProducts(brandId, shop, token) {
  let count = 0;

  for await (const page of gqlPages(
    shop, token, PRODUCTS_QUERY,
    { first: PAGE_SIZE },
    (d) => d.products
  )) {
    for (const p of page) {
      const productId = parseGid(p.id);
      for (const edge of (p.variants?.edges || [])) {
        const v   = edge.node;
        const sku = (v.sku && v.sku.trim()) || `${productId}-${parseGid(v.id)}`;
        try {
          upsertInventory({
            brand_id:     brandId,
            source:       'shopify',
            product_name: p.title,
            variant_name: v.title !== 'Default Title' ? v.title : null,
            sku,
            quantity:     v.inventoryQuantity || 0,
            price:        parseFloat(v.price) || 0,
            raw_data: JSON.stringify({
              product_id:        productId,
              variant_id:        parseGid(v.id),
              inventory_item_id: parseGid(v.inventoryItem?.id),  // ← webhook lookup key
              product_gid:       p.id,
              variant_gid:       v.id,
            }),
          });
          count++;
        } catch (err) {
          console.error(`[shopify] variant upsert failed ${v.id}:`, err.message);
        }
      }
    }
  }

  console.log(`[shopify] fetchProducts: ${count} variants upserted for brand=${brandId}`);
  return count;
}

// ── Webhook handler ────────────────────────────────────────────────────────────

/**
 * Process one Shopify webhook payload.
 *
 * Called by routes/webhooks.js inside setImmediate. If this throws, the caller
 * enqueues the payload in webhook_queue for automatic retry with back-off.
 */
async function handleWebhook(brandId, topic, payload) {
  switch (topic) {

    case 'orders/create':
    case 'orders/updated': {
      const normalized       = normalizeOrder(brandId, payload);
      const { _items, ...row } = normalized;
      upsertOrder(row);
      if (_items?.length) {
        try { upsertOrderItems(brandId, 'shopify', row.source_order_id, _items); }
        catch (_) { /* non-fatal */ }
      }
      logSync(brandId, 'shopify', 'success', null, 1);

      // CX Phase 4 — fire order_confirmed trigger on new orders only
      if (topic === 'orders/create') {
        const phone = payload.shipping_address?.phone || payload.customer?.phone || payload.billing_address?.phone || '';
        const name  = payload.customer?.first_name
          ? `${payload.customer.first_name} ${payload.customer.last_name || ''}`.trim()
          : (payload.shipping_address?.name || '');
        if (phone) {
          try {
            const { fireCxTrigger } = require('../lib/cx_trigger');
            fireCxTrigger(brandId, 'order_confirmed', {
              recipientPhone: phone,
              recipientName:  name || null,
              orderId:        String(payload.id || row.source_order_id),
              variables: {
                order_total: payload.total_price || row.total || '',
              },
            }).catch(() => {});
          } catch (_) { /* non-fatal */ }
        }
      }
      break;
    }

    case 'orders/cancelled': {
      db.prepare(`
        UPDATE orders_cache
        SET    financial_status   = 'voided',
               fulfillment_status = 'restocked',
               needs_action       = 0,
               updated_at         = datetime('now')
        WHERE  brand_id = ? AND source = 'shopify' AND source_order_id = ?
      `).run(brandId, String(payload.id || ''));
      break;
    }

    case 'products/update': {
      const productId = String(payload.id || '');
      for (const v of payload.variants || []) {
        const sku = (v.sku && v.sku.trim()) || `${productId}-${v.id}`;
        upsertInventory({
          brand_id:     brandId,
          source:       'shopify',
          product_name: payload.title,
          variant_name: v.title !== 'Default Title' ? v.title : null,
          sku,
          quantity:     v.inventory_quantity || 0,
          price:        parseFloat(v.price) || 0,
          raw_data: JSON.stringify({
            product_id:        productId,
            variant_id:        String(v.id),
            inventory_item_id: String(v.inventory_item_id || ''),
          }),
        });
      }
      break;
    }

    case 'products/delete': {
      db.prepare(`
        DELETE FROM inventory_cache
        WHERE  brand_id = ? AND source = 'shopify'
          AND  json_extract(raw_data, '$.product_id') = ?
      `).run(brandId, String(payload.id || ''));
      break;
    }

    case 'inventory_levels/update': {
      // This is the fix: we now find the row by inventory_item_id which
      // fetchProducts() stores in raw_data. Previously this matched 0 rows.
      const result = db.prepare(`
        UPDATE inventory_cache
        SET    quantity   = ?,
               updated_at = datetime('now')
        WHERE  brand_id = ? AND source = 'shopify'
          AND  json_extract(raw_data, '$.inventory_item_id') = ?
      `).run(
        payload.available ?? 0,
        brandId,
        String(payload.inventory_item_id || '')
      );

      if (result.changes === 0) {
        console.warn(
          `[shopify] inventory_levels/update: no row matched ` +
          `inventory_item_id=${payload.inventory_item_id} brand=${brandId}. ` +
          `Run a manual sync to rebuild the inventory cache.`
        );
      }
      break;
    }

    default:
      console.warn(`[shopify] unhandled webhook topic="${topic}" brand=${brandId}`);
  }
}

// ── Connection & token management ─────────────────────────────────────────────

function normaliseShop(raw) {
  return String(raw || '').replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase().trim();
}

// Scopes required by this integration.
// Must be pre-configured in Partner Dashboard → App → Configuration → Admin API integration
// before the client_credentials grant will return a usable token.
const REQUIRED_SCOPES = [
  'read_orders', 'read_products', 'read_inventory',
  'read_customers', 'read_fulfillments', 'read_shipping',
  'read_analytics',
].join(',');

async function exchangeToken(shop, clientId, clientSecret) {
  let res;
  try {
    res = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      {
        client_id:     clientId,
        client_secret: clientSecret,
        grant_type:    'client_credentials',
        scope:         REQUIRED_SCOPES,   // explicit scope request
      },
      { timeout: 15000 }
    );
  } catch (axiosErr) {
    // Parse the Shopify error body so we can return a specific error code
    const body     = axiosErr.response?.data || {};
    const errCode  = body.error || body.errors || '';
    const errDesc  = body.error_description || body.message || axiosErr.message;
    const status   = axiosErr.response?.status;

    console.error(`[shopify] exchangeToken failed shop=${shop} status=${status} error=${JSON.stringify(body)}`);

    // Attach a typed code so connect() can produce the right user-facing message
    const out      = new Error(String(errDesc || errCode || 'Token exchange failed'));
    out.shopifyErr = String(errCode).toLowerCase();
    out.status     = status;
    throw out;
  }

  const { access_token, scope, expires_in } = res.data;
  if (!access_token) {
    const out = new Error('Shopify returned no access_token — app may not be installed on this store');
    out.shopifyErr = 'no_token';
    throw out;
  }
  const expires_at = expires_in
    ? new Date(Date.now() + expires_in * 1000).toISOString()
    : null;
  return { access_token, scope: scope || '', expires_at };
}

async function getValidShopifyAccessToken(brandId) {
  const integration = getIntegration(brandId, 'shopify');
  if (!integration?.credentials) {
    throw new Error(`No Shopify credentials for brand=${brandId}`);
  }

  const creds = decryptJSON(integration.credentials);

  // OAuth tokens are permanent
  if (creds.oauth) return { token: creds.access_token, shop: creds.shop };

  // Client credentials: refresh if within 5-min of expiry
  const bufferMs = 5 * 60 * 1000;
  if (!creds.expires_at || new Date(creds.expires_at).getTime() - bufferMs > Date.now()) {
    return { token: creds.access_token, shop: creds.shop };
  }

  console.log(`[shopify] refreshing token for brand=${brandId}`);
  const refreshed = await exchangeToken(creds.shop, creds.client_id, creds.client_secret);
  const updated   = { ...creds, access_token: refreshed.access_token,
                       scope: refreshed.scope || creds.scope, expires_at: refreshed.expires_at };

  db.prepare(
    "UPDATE integrations SET credentials = ? WHERE brand_id = ? AND platform = 'shopify'"
  ).run(encryptJSON(updated), brandId);

  return { token: refreshed.access_token, shop: creds.shop };
}

/**
 * connect() — validate credentials, exchange for an access token, and save.
 *
 * Primary mode — Client credentials (Shopify Dev Dashboard apps):
 *   { shop, clientId, clientSecret }
 *   Shopify Partners / Dev Dashboard → Your App → API credentials
 *   → copy Client ID and Client Secret → paste here.
 *   Backend calls POST /admin/oauth/access_token with grant_type=client_credentials,
 *   stores the resulting token + the key pair so it can auto-refresh on expiry.
 *
 * Fallback mode — Direct access token (legacy custom-app installs):
 *   { shop, accessToken }
 *   Used only for stores where a shpat_ token was already issued.
 *   New installs should always use the client credentials path above.
 */
async function connect(brandId, { shop: rawShop, accessToken, clientId, clientSecret }) {
  const shop = normaliseShop(rawShop);

  let payload;

  if (clientId && clientSecret) {
    // ── Primary: client_credentials grant (Dev Dashboard apps) ───────────────
    let access_token, scope, expires_at;
    try {
      ({ access_token, scope, expires_at } = await exchangeToken(shop, clientId, clientSecret));
    } catch (err) {
      // Map typed Shopify error codes to user-facing messages
      const code = err.shopifyErr || '';
      if (code === 'invalid_client' || err.status === 401) {
        throw new Error('ERR_INVALID_CREDENTIALS');
      }
      if (code === 'invalid_scope' || code.includes('scope')) {
        throw new Error('ERR_MISSING_SCOPES');
      }
      if (code === 'no_token') {
        throw new Error('ERR_NOT_INSTALLED');
      }
      if (err.status === 404 || code === 'not_found') {
        throw new Error('ERR_STORE_NOT_FOUND');
      }
      throw new Error(`ERR_TOKEN_EXCHANGE: ${err.message}`);
    }

    // Verify the resulting token against the live API
    try {
      await shopifyGQL(shop, access_token, `{ shop { name } }`);
    } catch (err) {
      throw new Error(`ERR_API_VERIFY: ${err.message}`);
    }

    payload = { shop, client_id: clientId, client_secret: clientSecret,
                access_token, scope: scope || '', expires_at };
  } else if (accessToken) {
    // ── Fallback: direct access token (legacy shpat_ tokens) ─────────────────
    try {
      await shopifyGQL(shop, accessToken, `{ shop { name } }`);
    } catch (err) {
      throw new Error(`Invalid access token: ${err.message}`);
    }
    payload = { shop, access_token: accessToken, oauth: true, scope: '' };
  } else {
    throw new Error('Provide Client ID + Client Secret (from Shopify Dev Dashboard) to connect');
  }

  const existing = getIntegration(brandId, 'shopify');
  if (existing) {
    db.prepare(`
      UPDATE integrations
      SET    credentials = ?, status = 'connected', last_sync = NULL
      WHERE  brand_id = ? AND platform = 'shopify'
    `).run(encryptJSON(payload), brandId);
  } else {
    db.prepare(`
      INSERT INTO integrations (brand_id, platform, credentials, status)
      VALUES (?, 'shopify', ?, 'connected')
    `).run(brandId, encryptJSON(payload));
  }
  return { shop, scope };
}

async function testConnection(brandId) {
  const { token, shop } = await getValidShopifyAccessToken(brandId);
  const data = await shopifyGQL(shop, token,
    `{ shop { name email myshopifyDomain plan { displayName } } }`
  );
  return data.shop;
}

// ── Webhook registration ───────────────────────────────────────────────────────

const WEBHOOK_TOPICS = {
  'orders/create':           'ORDERS_CREATE',
  'orders/updated':          'ORDERS_UPDATED',
  'orders/cancelled':        'ORDERS_CANCELLED',
  'products/update':         'PRODUCTS_UPDATE',
  'products/delete':         'PRODUCTS_DELETE',
  'inventory_levels/update': 'INVENTORY_LEVELS_UPDATE',
};

async function registerWebhooks(brandId, shop, token) {
  const serverUrl = process.env.SERVER_URL;
  if (!serverUrl || serverUrl.includes('localhost')) {
    console.warn('[shopify] SERVER_URL not public — webhook registration skipped');
    return;
  }

  const callbackUrl = `${serverUrl}/api/webhooks/shopify/${brandId}`;

  const data = await shopifyGQL(shop, token, `{
    webhookSubscriptions(first: 50) {
      edges { node { id topic callbackUrl } }
    }
  }`);

  const registered = new Set(
    (data.webhookSubscriptions?.edges || []).map((e) => e.node.topic.toLowerCase())
  );

  const CREATE_MUT = `
    mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $callbackUrl: URL!) {
      webhookSubscriptionCreate(
        topic: $topic,
        webhookSubscription: { callbackUrl: $callbackUrl, format: JSON }
      ) {
        webhookSubscription { id topic }
        userErrors { field message }
      }
    }
  `;

  for (const [restTopic, gqlTopic] of Object.entries(WEBHOOK_TOPICS)) {
    if (registered.has(restTopic)) continue;
    await sleep(RATE_DELAY);
    try {
      const result = await shopifyGQL(shop, token, CREATE_MUT,
        { topic: gqlTopic, callbackUrl });
      const errs = result.webhookSubscriptionCreate?.userErrors || [];
      if (errs.length) {
        console.warn(`[shopify] webhook create error (${restTopic}):`, errs);
      } else {
        console.log(`[shopify] registered webhook: ${restTopic}`);
      }
    } catch (err) {
      console.warn(`[shopify] failed to register webhook ${restTopic}:`, err.message);
    }
  }
}

// ── Full / incremental sync ────────────────────────────────────────────────────

/**
 * Sync one brand.
 *
 * Incremental: if `integration.last_sync` is set, only orders with
 * `updated_at > last_sync` are fetched. Products are always fully refreshed
 * (the products/update webhook handles real-time changes in between syncs).
 *
 * `last_sync` is advanced only on success or partial success, so a failed
 * run retries the full window on the next schedule tick.
 */
async function fullSync(brandId) {
  // SYNC_LOG — structured: step → counts → failure point → last_sync outcome
  console.log(`[shopify] sync start brand=${brandId}`);

  const integration = getIntegration(brandId, 'shopify');
  if (!integration || integration.status === 'disconnected') {
    console.log(`[shopify] skipping — brand=${brandId} not connected`);
    return;
  }

  let token, shop;
  try {
    ({ token, shop } = await getValidShopifyAccessToken(brandId));
    console.log(`[shopify] auth ok shop=${shop} brand=${brandId}`);
  } catch (err) {
    const msg = `Auth error: ${err.message}`;
    console.error(`[shopify] step=auth FAILED brand=${brandId}:`, err.message);
    logSync(brandId, 'shopify', 'error', msg);
    updateIntegrationStatus(brandId, 'shopify', 'error');
    setIntegrationHealth(brandId, 'shopify', 'error', msg);
    // LAST_SYNC_EXPLICIT — do NOT advance last_sync on auth failure.
    // updateIntegrationStatus() no longer touches last_sync (db.js fix),
    // so the previous sinceDate is preserved for the next incremental run.
    return;
  }

  const sinceDate    = integration.last_sync || null;
  const syncType     = sinceDate ? 'incremental' : 'full';
  const errors       = [];
  let   orderCount   = 0;
  let   variantCount = 0;

  console.log(`[shopify] ${syncType} sync since=${sinceDate || 'all-time'} brand=${brandId}`);

  // ── Step 1: orders ────────────────────────────────────────────────────────
  try {
    console.log(`[shopify] step=orders start brand=${brandId}`);
    orderCount = await fetchOrders(brandId, shop, token, sinceDate);
    console.log(`[shopify] step=orders done rows=${orderCount} brand=${brandId}`);
  } catch (err) {
    errors.push(`Orders: ${err.message}`);
    console.error(`[shopify] step=orders FAILED brand=${brandId}:`, err.message);
  }

  // ── Step 2: products/inventory ────────────────────────────────────────────
  try {
    console.log(`[shopify] step=products start brand=${brandId}`);
    variantCount = await fetchProducts(brandId, shop, token);
    console.log(`[shopify] step=products done rows=${variantCount} brand=${brandId}`);
  } catch (err) {
    errors.push(`Products: ${err.message}`);
    console.error(`[shopify] step=products FAILED brand=${brandId}:`, err.message);
  }

  // ── Step 3: webhook registration (non-fatal) ──────────────────────────────
  try { await registerWebhooks(brandId, shop, token); }
  catch (err) { console.warn('[shopify] webhook registration (non-fatal):', err.message); }

  const total    = orderCount + variantCount;
  const status   = errors.length === 0 ? 'success' : total > 0 ? 'partial' : 'error';
  const errorMsg = errors.length ? errors.join(' | ') : null;

  logSync(brandId, 'shopify', status, errorMsg, total);
  updateIntegrationStatus(brandId, 'shopify', status === 'error' ? 'error' : 'connected');
  setIntegrationHealth(
    brandId, 'shopify',
    status === 'error' ? 'error' : status === 'partial' ? 'warning' : 'ok',
    errorMsg
  );

  // LAST_SYNC_EXPLICIT — advance last_sync ONLY when fetchOrders completed
  // without error.  last_sync is the lower-bound for the next incremental
  // fetchOrders call; advancing it after an order failure would permanently
  // skip the failed window.
  //
  // Products are always fetched in full (no last_sync dependency), so a
  // products-only failure does NOT block last_sync advancement.
  const ordersOk = !errors.some((e) => e.startsWith('Orders:'));
  if (ordersOk) {
    db.prepare(
      "UPDATE integrations SET last_sync = datetime('now') WHERE brand_id = ? AND platform = 'shopify'"
    ).run(brandId);
    console.log(`[shopify] last_sync advanced — next incremental from NOW brand=${brandId}`);
  } else {
    console.warn(
      `[shopify] last_sync NOT advanced — orders failed, next run re-fetches from ` +
      `since=${sinceDate || 'all-time'} brand=${brandId}`
    );
  }

  console.log(
    `[shopify] sync done — orders=${orderCount} variants=${variantCount}` +
    ` type=${syncType} status=${status} brand=${brandId}` +
    (errorMsg ? ` errors="${errorMsg}"` : '')
  );
}

// ── General-purpose REST helper (backward compat) ─────────────────────────────

async function shopifyRequest(shop, token, method, path, data = null) {
  const res = await axios({
    method,
    url: `https://${shop}/admin/api/${API_VERSION}${path}`,
    data,
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
  return res.data;
}

// ── Exports ────────────────────────────────────────────────────────────────────

module.exports = {
  normaliseShop,
  connect,
  testConnection,
  exchangeToken,
  getValidShopifyAccessToken,
  fetchOrders,
  fetchProducts,
  registerWebhooks,
  handleWebhook,
  fullSync,
  shopifyGQL,
  shopifyRequest,
};
