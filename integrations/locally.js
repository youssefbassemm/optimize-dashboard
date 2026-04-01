'use strict';

/**
 * Locally integration module
 *
 * Locally is an Egyptian showroom/retail portal (backend.locallyeg.com).
 * It has NO public API documentation. All endpoints are reverse-engineered
 * from the existing frontend dashboard code.
 *
 * Known endpoints (verified from dashboard source):
 *   POST /api/login                        { login, password } → { data: { token } }
 *   GET  /api/dashboard/partner/orders     Bearer auth → order list
 *   GET  /api/dashboard/partner/products   Bearer auth → product/inventory list
 *   POST /api/dashboard/partner/overview   Bearer auth + { start_date, end_date } → sales summary
 *
 * Auth:
 *   - Session token obtained by POSTing email + password to /api/login
 *   - Token returned in j.data?.token | j.token | j.access_token
 *   - Stored in memory only (never persisted to DB — re-authenticate each cycle)
 *   - Credentials (email + password) are stored encrypted in integrations table
 *
 * Sync: scheduled pull every 30 minutes (no webhooks from Locally).
 *
 * Fallback: if live API is unreachable, a CSV upload endpoint is available at
 *   POST /api/:brand_id/locally/upload
 *
 * ⚠ FRAGILE: Since this API is undocumented, it may change without notice.
 *   The normalizeOrder function handles multiple possible response shapes.
 */

const axios  = require('axios');
const { getIntegration, logSync, upsertOrder, upsertInventory, updateIntegrationStatus } = require('../db/db');
const { decryptJSON } = require('../middleware/encryption');

const BASE_URL = 'https://backend.locallyeg.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Auth ──────────────────────────────────────────────────────────────────────

/**
 * Login to Locally and return a Bearer token string.
 * Returns null if login fails.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<string|null>}
 */
async function login(email, password) {
  try {
    const res = await axios.post(
      `${BASE_URL}/api/login`,
      { login: email, password },
      { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 15000 }
    );
    const raw = res.data?.data?.token || res.data?.token || res.data?.access_token || null;
    if (!raw) {
      console.warn('[locally] login response had no token field:', JSON.stringify(res.data).slice(0, 200));
      return null;
    }
    return raw.startsWith('Bearer ') ? raw : `Bearer ${raw}`;
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error('[locally] login failed:', msg);
    return null;
  }
}

// ── Order normalization ───────────────────────────────────────────────────────

/**
 * Locally returns showroom (point-of-sale) transactions.
 * All showroom sales are fulfilled at point of sale — no shipping needed.
 *
 * This function handles multiple possible shapes of Locally order objects
 * since the API is undocumented and the structure may vary.
 */
function normalizeOrder(brandId, o, index) {
  // Try multiple field name patterns
  const id   = o.id || o.order_id || o.transaction_id || o.reference || `locally-${Date.now()}-${index}`;
  const name = o.customer_name || o.name || o.client_name
    || [o.first_name, o.last_name].filter(Boolean).join(' ')
    || 'Showroom Customer';
  const phone = o.phone || o.customer_phone || o.mobile || '';
  const city  = o.city || o.branch_city || o.store_city || 'Cairo';

  // Items — may be nested or flattened
  let rawItems = o.items || o.line_items || o.products || o.order_items || [];
  if (!Array.isArray(rawItems)) rawItems = [];
  const items = rawItems.map((it) => ({
    name:    it.name || it.title || it.product_name || 'Item',
    variant: it.variant || it.variant_name || it.size || null,
    qty:     Number(it.quantity || it.qty || 1),
    price:   parseFloat(it.price || it.unit_price || 0),
    sku:     it.sku || null,
  }));

  const total = parseFloat(
    o.total || o.total_price || o.amount || o.grand_total ||
    items.reduce((s, i) => s + i.price * i.qty, 0)
  ) || 0;

  // Payment method — normalise to 'cash' | 'card'
  const pmRaw = (o.payment_method || o.payment_type || o.payment || '').toLowerCase();
  const paymentMethod = pmRaw.includes('card') || pmRaw.includes('visa') || pmRaw.includes('credit')
    ? 'card' : 'cash';

  const createdAt = o.created_at || o.date || o.order_date || new Date().toISOString();

  return {
    brand_id:          brandId,
    source:            'locally',
    source_order_id:   String(id),
    customer_name:     name,
    phone,
    city,
    items:             JSON.stringify(items),
    total,
    currency:          'EGP',
    payment_method:    paymentMethod,
    financial_status:  'paid',             // showroom = paid at point of sale
    fulfillment_status: 'fulfilled',        // showroom = fulfilled immediately
    shipping:          JSON.stringify({ carrier: null, tracking_number: null, status: 'delivered', timeline: [] }),
    needs_action:      0,
    action_reason:     null,
    raw_data:          JSON.stringify(o),
    created_at:        createdAt,
  };
}

/**
 * Normalize a Locally product/variant into inventory_cache format.
 */
function normalizeProduct(brandId, p, index) {
  const productName = p.name || p.title || p.product_name || `Product ${index + 1}`;
  const variants    = p.variants || p.sizes || [p];

  return variants.map((v) => ({
    brand_id:     brandId,
    source:       'locally',
    product_name: productName,
    variant_name: v.variant || v.size || v.name || (v === p ? null : null),
    sku:          v.sku || `locally-${p.id || index}-${v.id || 0}`,
    quantity:     parseInt(v.stock || v.quantity || v.inventory_quantity || 0, 10),
    price:        parseFloat(v.price || p.price || 0),
    raw_data:     JSON.stringify(v),
  }));
}

// ── Public integration functions ──────────────────────────────────────────────

/**
 * Fetch all orders from Locally and upsert into orders_cache.
 * @param {string} brandId
 * @param {object} creds   { email, password }
 * @returns {Promise<number>}  count of orders upserted
 */
async function fetchOrders(brandId, creds) {
  const token = await login(creds.email, creds.password);
  if (!token) throw new Error('Locally login failed — check credentials');

  const res = await axios.get(`${BASE_URL}/api/dashboard/partner/orders`, {
    headers: { Authorization: token, Accept: 'application/json' },
    timeout: 20000,
  });

  // Handle multiple possible response shapes
  const orders = res.data?.result?.data || res.data?.orders || res.data?.data || res.data || [];
  if (!Array.isArray(orders)) {
    console.warn('[locally] unexpected orders response shape:', JSON.stringify(res.data).slice(0, 300));
    return 0;
  }

  let count = 0;
  orders.forEach((o, i) => {
    upsertOrder(normalizeOrder(brandId, o, i));
    count++;
  });

  console.log(`[locally] fetched ${count} orders for brand=${brandId}`);
  return count;
}

/**
 * Fetch all products from Locally and upsert into inventory_cache.
 */
async function fetchProducts(brandId, creds) {
  const token = await login(creds.email, creds.password);
  if (!token) throw new Error('Locally login failed — check credentials');

  const res = await axios.get(`${BASE_URL}/api/dashboard/partner/products`, {
    headers: { Authorization: token, Accept: 'application/json' },
    timeout: 20000,
  });

  const products = res.data?.result?.data || res.data?.products || res.data?.data || res.data || [];
  if (!Array.isArray(products)) {
    console.warn('[locally] unexpected products response shape');
    return 0;
  }

  let count = 0;
  products.forEach((p, i) => {
    const variants = normalizeProduct(brandId, p, i);
    variants.forEach((v) => { upsertInventory(v); count++; });
  });

  console.log(`[locally] fetched ${count} product variants for brand=${brandId}`);
  return count;
}

/**
 * Full sync: orders + products.
 * Never throws — errors are caught and logged.
 */
async function fullSync(brandId) {
  console.log(`[locally] starting sync for brand=${brandId}`);

  const integration = getIntegration(brandId, 'locally');
  if (!integration || integration.status === 'disconnected') return;

  let creds;
  try {
    creds = decryptJSON(integration.credentials);
  } catch (err) {
    console.error('[locally] failed to decrypt credentials:', err.message);
    logSync(brandId, 'locally', 'error', 'Failed to decrypt stored credentials');
    return;
  }

  let orderCount = 0, productCount = 0, error = null;

  try {
    orderCount   = await fetchOrders(brandId, creds);
    productCount = await fetchProducts(brandId, creds);
  } catch (err) {
    error = err.message;
    console.error(`[locally] sync error for brand=${brandId}:`, error);
    // Check if it's a login failure specifically
    if (error.includes('login failed') || error.includes('Login failed')) {
      updateIntegrationStatus(brandId, 'locally', 'error');
    }
  }

  const status = error ? 'error' : 'success';
  logSync(brandId, 'locally', status, error, orderCount + productCount);
  updateIntegrationStatus(brandId, 'locally', error ? 'error' : 'connected');

  console.log(`[locally] sync done — orders=${orderCount} products=${productCount} status=${status}`);
}

// ── CSV import (fallback) ─────────────────────────────────────────────────────

/**
 * Parse and import orders from a CSV buffer.
 *
 * Expected columns (header row required):
 *   date, customer_name, phone, city, items, total, payment_method
 *
 * "items" column should be a semicolon-separated list of "Name x Qty @ Price"
 * e.g.  "Blue Hoodie x 2 @ 750;Black Cap x 1 @ 350"
 *
 * @param {string} brandId
 * @param {Buffer|string} csvBuffer
 * @returns {{ count: number, errors: string[] }}
 */
function importCSV(brandId, csvBuffer) {
  const text   = csvBuffer.toString('utf8').trim();
  const lines  = text.split(/\r?\n/).filter(Boolean);

  if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row');

  // Parse header
  const header  = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const errors  = [];
  let count     = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const row  = {};
    header.forEach((col, j) => { row[col] = (cols[j] || '').trim(); });

    try {
      // Parse items column (semicolon-separated)
      const itemParts = (row.items || '').split(';').filter(Boolean);
      const items = itemParts.map((part) => {
        // Pattern: "Name x Qty @ Price"  or just "Name"
        const atMatch  = part.match(/^(.+?)\s*@\s*([\d.]+)$/);
        const xMatch   = atMatch
          ? atMatch[1].match(/^(.+?)\s*x\s*(\d+)$/i)
          : part.match(/^(.+?)\s*x\s*(\d+)$/i);
        return {
          name:  (xMatch ? xMatch[1] : (atMatch ? atMatch[1] : part)).trim(),
          qty:   xMatch ? parseInt(xMatch[2], 10) : 1,
          price: atMatch ? parseFloat(atMatch[2]) : 0,
        };
      });

      const paymentRaw = (row.payment_method || '').toLowerCase();
      const uniqueId   = `csv-${row.date || ''}-${row.customer_name || ''}-${i}`.replace(/\s+/g, '-');

      upsertOrder({
        brand_id:          brandId,
        source:            'locally',
        source_order_id:   uniqueId,
        customer_name:     row.customer_name || 'Unknown',
        phone:             row.phone         || '',
        city:              row.city          || '',
        items:             JSON.stringify(items),
        total:             parseFloat(row.total) || 0,
        currency:          'EGP',
        payment_method:    paymentRaw.includes('card') ? 'card' : 'cash',
        financial_status:  'paid',
        fulfillment_status: 'fulfilled',
        shipping:          JSON.stringify({ carrier: null, tracking_number: null, status: 'delivered', timeline: [] }),
        needs_action:      0,
        action_reason:     null,
        raw_data:          JSON.stringify(row),
        created_at:        row.date ? new Date(row.date).toISOString() : new Date().toISOString(),
      });
      count++;
    } catch (err) {
      errors.push(`Row ${i + 1}: ${err.message}`);
    }
  }

  logSync(brandId, 'locally', errors.length ? 'partial' : 'success', errors.join('; ') || null, count);
  return { count, errors };
}

module.exports = { login, fetchOrders, fetchProducts, fullSync, importCSV };
