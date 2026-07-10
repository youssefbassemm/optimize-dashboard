'use strict';

/**
 * Locally integration module
 *
 * Portal: portal.locallyeg.com
 * API:    backend.locallyeg.com
 *
 * All endpoints verified April 2026 from portal JS bundle
 * (portal.locallyeg.com/assets/index-CQLd6sb6.js).
 *
 * ── Verified endpoints & HTTP methods ──────────────────────────────────────
 *
 *   POST /api/login
 *     Body:    { login: <email>, password }          ← field name is "login", not "email"
 *     Success: { success: true, token: "..." }
 *             OR { success: true, data: { token: "..." } }
 *     Failure: { success: false, message: "..." }
 *
 *   POST /api/dashboard/partner/orders               ← POST, NOT GET
 *     Body:    { jsonrpc: "2.0", id: null }          ← JSON-RPC envelope required
 *     Auth:    Authorization: Bearer <token>
 *     Success: data.result.status === 200 → data.result.data (array)
 *
 *   GET  /api/dashboard/partner/products             ← GET (no body)
 *     Auth:    Authorization: Bearer <token>
 *     Success: data (array)
 *
 *   POST /api/dashboard/partner/overview
 *     Body:    { start_date: "YYYY-MM-DD", end_date: "YYYY-MM-DD" }
 *     Auth:    Authorization: Bearer <token>
 *     Success: data.result.data → { total_sales, total_quantity_sold, commission_paid,
 *                                    you_receive, latest_orders[] }
 *
 *   POST /api/dashboard/partner/invoices
 *   POST /api/dashboard/partner/inbounds
 *     Both require POST + Bearer auth (available for future use)
 *
 * ── Auth ────────────────────────────────────────────────────────────────────
 *   Token obtained per-sync via POST /api/login.
 *   Stored in memory only — never persisted to DB.
 *   Credentials (email + password) stored AES-256-CBC encrypted in integrations table.
 *
 * ── Sync schedule ───────────────────────────────────────────────────────────
 *   Background: every 30 minutes via jobs/scheduler.js
 *   Manual: POST /api/:brand_id/locally/sync
 *   Fallback: POST /api/:brand_id/locally/upload (CSV import)
 *
 * ⚠ FRAGILE: API is undocumented and may change without notice.
 *   Selectors/field names are kept defensive with multiple fallbacks.
 */

const axios  = require('axios');
const crypto = require('crypto');
const { db: _rawDb, getIntegration, logSync, upsertOrder, upsertOrderItems, upsertInventory, updateIntegrationStatus, setIntegrationHealth } = require('../db/db');
const { decryptJSON } = require('../middleware/encryption');

const BASE_URL = 'https://backend.locallyeg.com';

// ── Stable order ID ───────────────────────────────────────────────────────────

/**
 * Return a stable source_order_id for a Locally order object.
 *
 * Priority:
 *   1. Real API-supplied identifier (id / order_id / transaction_id / reference)
 *   2. Content hash derived from (date, name/barcode, phone, total, barcode, quantity)
 *
 * FIELD REALITY (confirmed from Locally portal JS bundle, 2025-11-30):
 *   The /orders endpoint returns LINE-ITEM level objects — one entry per product
 *   sold. Fields: barcode, name (product name), quantity, price, total, order_date.
 *   There is NO order ID, NO customer name, NO phone anywhere in the API.
 *
 * HASH INPUTS — chosen to minimise false-deduplication of distinct transactions:
 *   date     → order_date (sale date)
 *   name     → product name (the only text identifier the API provides)
 *   barcode  → product barcode (differentiates same-named variants)
 *   total    → line total = price × quantity (encodes both price and qty)
 *   quantity → explicit quantity (extra differentiator for identical unit prices)
 *   phone    → always "" for Locally (no customer data), kept for compat with
 *              CSV imports which may have a phone number.
 *
 * LIMITATION: Two physically separate sales of the same product (same barcode,
 * same quantity, same unit price) on the same calendar day are INDISTINGUISHABLE
 * from the API and will be deduplicated to one row. This is unavoidable without
 * a stable server-side order ID.
 *
 * MIGRATION NOTE: Changing the hash inputs requires clearing all existing
 * loc-{hash} rows so they are re-inserted with the new hash on the next sync.
 * A migration block in migrations.js handles this (runs once).
 */
function stableLocallyId(o) {
  // order_name is the only stable server-assigned identifier in the Locally API.
  // Present on /overview latest_orders[] objects (e.g. "S00042", "P00015").
  // Absent from /orders line-item objects (which have no transaction identifier).
  const realId = o.id ?? o.order_id ?? o.transaction_id ?? o.reference ?? o.order_name;
  if (realId != null && realId !== '') return String(realId);

  const date    = (o.created_at || o.date || o.order_date || '').toString().slice(0, 10);
  const name    = (o.customer_name || o.name || o.client_name
    || [o.first_name, o.last_name].filter(Boolean).join(' ')
    || '').toLowerCase().trim();
  const phone   = (o.phone || o.customer_phone || o.mobile || '').replace(/\D/g, '').slice(-10);
  const total   = parseFloat(o.total || o.total_price || o.amount || o.grand_total || 0).toFixed(2);
  const barcode = String(o.barcode || '').trim();
  const qty     = String(parseInt(o.quantity || o.qty || 0, 10));

  const hash = crypto.createHash('sha256')
    .update(`${date}|${name}|${phone}|${total}|${barcode}|${qty}`)
    .digest('hex')
    .slice(0, 20);
  return `loc-${hash}`;
}

// ── Transaction grouping ──────────────────────────────────────────────────────

/**
 * Group flat /orders line-item rows into transaction-level arrays.
 *
 * The Locally /partner/orders endpoint returns ONE ROW PER PRODUCT LINE.
 * A customer buying 3 items in one sale generates 3 rows — there is no
 * transaction ID, customer ID, or register ID anywhere in the API.
 *
 * Grouping signal: the exact order_date timestamp.
 * In a POS system, all items in one basket are committed atomically — the
 * server assigns the same timestamp to every line item in that transaction.
 *
 * To be robust against sub-second clock jitter, we truncate to the minute:
 *   "2025-12-31 16:30:45" → "2025-12-31 16:30"
 *
 * Risk: two separate transactions within the same 60-second window in the
 * same showroom will be merged into one row. This is unavoidable without a
 * server-assigned transaction identifier. At typical single-showroom traffic,
 * this probability is very low.
 *
 * @param {object[]} lineItems  Raw objects from /partner/orders
 * @returns {object[][]}        Each sub-array = one transaction's line items
 */
function groupLineItemsIntoTransactions(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return [];

  const groups = new Map(); // minuteKey → [lineItems]

  for (const li of lineItems) {
    const rawDate = (li.order_date || li.created_at || li.date || '').toString().trim();

    let minuteKey = rawDate; // fallback: use raw string as-is
    try {
      const parsed = rawDate ? new Date(rawDate) : null;
      if (parsed && !isNaN(parsed.getTime())) {
        // Truncate to minute — YYYY-MM-DD HH:MM
        minuteKey = parsed.getFullYear() + '-'
          + String(parsed.getMonth() + 1).padStart(2, '0') + '-'
          + String(parsed.getDate()).padStart(2, '0') + ' '
          + String(parsed.getHours()).padStart(2, '0') + ':'
          + String(parsed.getMinutes()).padStart(2, '0');
      }
    } catch (_) {}

    if (!groups.has(minuteKey)) groups.set(minuteKey, []);
    groups.get(minuteKey).push(li);
  }

  return Array.from(groups.values());
}

/**
 * Build a single orders_cache row from a group of line items that belong to
 * the same transaction (same minute-level timestamp).
 *
 * @param {string}   brandId
 * @param {object[]} lineItemGroup  All line items for this transaction
 * @returns {object} Normalised row ready for upsertOrder()
 */
function buildTransactionRow(brandId, lineItemGroup) {
  const first   = lineItemGroup[0];
  const rawDate = (first.order_date || first.created_at || first.date || '').toString().trim();

  // Transaction total = sum of individual line totals
  const total = lineItemGroup.reduce(
    (sum, li) => sum + (parseFloat(li.total || li.price || 0)),
    0
  );

  // Total items = sum of quantities across all lines
  const totalItems = lineItemGroup.reduce(
    (sum, li) => sum + (parseInt(li.quantity || li.qty || 1, 10)),
    0
  );

  // Items array — one entry per product line
  const items = lineItemGroup.map((li) => ({
    name:    li.name || li.product_name || 'Item',
    variant: li.variant || li.variant_name || null,
    qty:     parseInt(li.quantity || li.qty || 1, 10),
    price:   parseFloat(li.price || li.unit_price || 0),
    sku:     li.barcode || li.sku || null,
  }));

  // Stable transaction ID: hash of (rawDate + sorted barcodes:qty:lineTotal)
  // Sorting ensures hash is order-independent within the same transaction.
  const barcodeKey = lineItemGroup
    .map((li) => `${li.barcode || ''}:${li.quantity || 1}:${parseFloat(li.total || 0).toFixed(2)}`)
    .sort()
    .join('|');
  const txHash = crypto.createHash('sha256')
    .update(`${rawDate}|${barcodeKey}`)
    .digest('hex')
    .slice(0, 20);
  const txId = `loc-${txHash}`;

  // Normalise date to ISO 8601
  let createdAt;
  try {
    const parsed = rawDate ? new Date(rawDate) : null;
    createdAt = (parsed && !isNaN(parsed.getTime()))
      ? parsed.toISOString()
      : new Date().toISOString();
  } catch (_) {
    createdAt = new Date().toISOString();
  }

  return {
    brand_id:           brandId,
    source:             'locally',
    source_order_id:    txId,
    customer_name:      'Showroom Customer',
    phone:              '',
    city:               'Cairo',
    items:              JSON.stringify(items),
    total:              parseFloat(total.toFixed(2)),
    total_items:        totalItems,
    currency:           'EGP',
    payment_method:     'cash',
    financial_status:   'paid',
    fulfillment_status: 'fulfilled',
    shipping:           JSON.stringify({ carrier: null, tracking_number: null, status: 'delivered', timeline: [] }),
    needs_action:       0,
    action_reason:      null,
    raw_data:           JSON.stringify(lineItemGroup),
    created_at:         createdAt,
    // _items used to populate order_items table — stripped before upsertOrder()
    _items:             items,
  };
}

// ── Auth ──────────────────────────────────────────────────────────────────────

/**
 * Login to Locally and return a Bearer token string.
 * Returns null if login fails (bad credentials or network failure).
 * Throws if a non-credential error occurs (caller should surface it).
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<string|null>}
 */
async function login(email, password) {
  // Field name verified from portal JS bundle: it's "login", not "email".
  // We try { login } first (confirmed correct), then { email } as fallback
  // in case the API field name ever changes.
  const attempts = [
    { login: email, password },   // ✓ confirmed — portal sends { login, password }
    { email,        password },   // fallback if API ever renames the field
  ];

  for (const body of attempts) {
    try {
      const res = await axios.post(
        `${BASE_URL}/api/login`,
        body,
        { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 15000 }
      );

      // Portal extracts: i.token || i.data?.token
      const raw = res.data?.token || res.data?.data?.token || res.data?.access_token || null;
      if (raw) {
        return raw.startsWith('Bearer ') ? raw : `Bearer ${raw}`;
      }

      // 200 response but no token — log what we got for debugging
      console.warn('[locally] login 200 but no token found. Response:', JSON.stringify(res.data).slice(0, 300));
      // Don't try next format — if the server accepted the body shape, the credentials themselves are wrong
      return null;

    } catch (err) {
      const status = err.response?.status;
      const msg    = err.response?.data?.message || err.message;

      if (status === 401) {
        // 401 = bad credentials (server understood the request format)
        // No point trying alternate body format
        console.error(`[locally] login rejected — invalid credentials (HTTP 401): ${msg}`);
        return null;
      }

      if (status === 422 || status === 400) {
        // 422/400 = validation error — body format wrong, try next format
        console.warn(`[locally] login body format rejected (HTTP ${status}), trying alternate format`);
        continue;
      }

      if (status === 403) {
        console.error(`[locally] login forbidden (HTTP 403) — account may be suspended: ${msg}`);
        return null;
      }

      if (status === 500) {
        // 500 usually means wrong body field — try next format
        const fieldErr = err.response?.data?.errors?.error || msg;
        console.warn(`[locally] login server error (HTTP 500): ${fieldErr} — trying alternate body format`);
        continue;
      }

      // Network-level error (ECONNREFUSED, timeout, etc.) — don't retry
      if (!status) {
        throw new Error(`Network error reaching Locally API: ${err.message}`);
      }

      // Unknown status — try next format
      console.warn(`[locally] login unexpected HTTP ${status}: ${msg}`);
    }
  }

  console.error('[locally] login failed with all attempted body formats');
  return null;
}

// ── Order normalization ───────────────────────────────────────────────────────

/**
 * Normalize a raw Locally order object into orders_cache format.
 * Locally orders are showroom (point-of-sale) transactions — always paid + fulfilled.
 */
function normalizeOrder(brandId, o, _index) {
  // stableLocallyId: real API ID if present, otherwise a content hash.
  // Never uses Date.now() — prevents duplicate rows on repeated syncs.
  const id = stableLocallyId(o);

  // ── Field detection ───────────────────────────────────────────────────────
  //
  // The Locally /orders endpoint (confirmed from portal bundle 2025-11-30) returns
  // LINE-ITEM level objects — one entry per product sold — with these fields:
  //   barcode, name (product name), quantity, price, total, order_date
  //
  // There is NO customer data anywhere: customer_name, phone, mobile, customer are
  // absent from the entire portal codebase. The API simply does not expose it.
  //
  // We detect this format by the presence of `barcode` or absence of `customer_name`
  // and use appropriate fallbacks rather than misidentifying the product name as a
  // customer name.

  // ── Format detection ─────────────────────────────────────────────────────
  //
  // Three possible shapes arrive at this function:
  //
  //  A. overview latest_orders format (PRIMARY — best source of truth)
  //     Confirmed from Locally portal bundle (2025-11-30).
  //     Fields: order_name (stable ID), date, type, total_items, state, lines[]
  //     This is ORDER-LEVEL: one object = one customer transaction.
  //     order_name is a server-assigned identifier like "S00042" or "P00015".
  //
  //  B. /orders endpoint line-item format (DEPRECATED — no order ID)
  //     Fields: barcode, name (product), quantity, price, total, order_date
  //     This is PRODUCT-LEVEL: one object = one product line, no transaction ID.
  //
  //  C. CSV import / manual format
  //     Fields: customer_name, phone, city, items, total, date
  //

  const isOverviewFormat = o.order_name != null;                          // Format A
  const hasCustomerData  = !!(o.customer_name || o.phone || o.customer_phone || o.mobile);
  const isLineItemFormat = !isOverviewFormat && !hasCustomerData &&
                           (o.barcode != null || o.quantity != null);     // Format B
  // Format C: everything else (CSV)

  // ── Customer name ─────────────────────────────────────────────────────────
  // overview and line-item formats have no customer data — Locally does not
  // expose customer PII through any API endpoint.
  const customerName = hasCustomerData
    ? (o.customer_name || o.client_name
        || [o.first_name, o.last_name].filter(Boolean).join(' ')
        || 'Showroom Customer')
    : 'Showroom Customer';

  const phone = o.phone || o.customer_phone || o.mobile || '';
  const city  = o.city || o.branch_city || o.store_city || 'Cairo';

  // ── Items array ───────────────────────────────────────────────────────────
  let items = [];

  if (isOverviewFormat) {
    // Format A: parse o.lines[] (Odoo sale.order.line objects).
    // The portal passes lines[] through unchanged so the raw API fields are
    // preserved. Odoo line field names: product_id[1] (name), product_uom_qty
    // (qty), price_unit, price_subtotal. We try many aliases defensively.
    const rawLines = Array.isArray(o.lines) ? o.lines : [];
    items = rawLines.map((l) => ({
      name:    l.product_id?.[1] || l.product_name || l.name || l.display_name || 'Item',
      variant: l.variant || l.variant_name || null,
      qty:     Number(l.product_uom_qty || l.quantity || l.qty || 1),
      price:   parseFloat(l.price_unit || l.price || l.unit_price || 0),
      sku:     l.barcode || l.sku || (typeof l.product_id === 'string' ? l.product_id : null),
    }));
  } else if (isLineItemFormat) {
    // Format B: synthesise single-item array from top-level product fields
    items = [{
      name:    o.name || o.product_name || o.title || 'Item',
      variant: o.variant || o.variant_name || o.size || null,
      qty:     Number(o.quantity || o.qty || 1),
      price:   parseFloat(o.price || o.unit_price || 0),
      sku:     o.barcode || o.sku || null,
    }];
  } else {
    // Format C: nested items array (CSV import)
    const rawItems = o.items || o.line_items || o.products || o.order_items || [];
    const arr = Array.isArray(rawItems) ? rawItems : [];
    items = arr.map((it) => ({
      name:    it.name || it.title || it.product_name || 'Item',
      variant: it.variant || it.variant_name || it.size || null,
      qty:     Number(it.quantity || it.qty || 1),
      price:   parseFloat(it.price || it.unit_price || 0),
      sku:     it.sku || null,
    }));
  }

  // ── total_items ───────────────────────────────────────────────────────────
  // Overview: API provides total_items directly (use it; lines[] may be empty
  // if the API omits line detail for some orders).
  const apiTotalItems = isOverviewFormat ? parseInt(o.total_items || 0, 10) : 0;
  const totalItems = apiTotalItems > 0
    ? apiTotalItems
    : items.length > 0
      ? items.reduce((s, i) => s + (i.qty || 1), 0)
      : (parseInt(o.quantity || o.qty || 1, 10) || 1);

  const name = customerName;

  // ── Revenue ───────────────────────────────────────────────────────────────
  // Try many field names. For overview format, Odoo typically provides
  // amount_total on the sale.order object even if the portal doesn't map it.
  // lines[] price_subtotal fields are summed as a fallback.
  const linesTotal = items.reduce((s, i) => s + (parseFloat(i.price) || 0) * (i.qty || 1), 0);
  const total = parseFloat(
    o.amount_total || o.total_amount ||
    o.total || o.total_price || o.amount || o.grand_total ||
    (linesTotal > 0 ? linesTotal : undefined)
  ) || 0;

  // ── Payment method ────────────────────────────────────────────────────────
  const pmRaw = (o.payment_method || o.payment_type || o.payment || '').toLowerCase();
  const paymentMethod = (pmRaw.includes('card') || pmRaw.includes('visa') || pmRaw.includes('credit'))
    ? 'card' : 'cash';

  // ── Financial status ──────────────────────────────────────────────────────
  // Odoo/Locally sale.order states (confirmed from portal bundle):
  //   'draft'  = quotation, not yet confirmed → pending
  //   'sent'   = quotation sent, not yet confirmed → pending
  //   'sale'   = CONFIRMED SALE ORDER (active, will be fulfilled) → paid
  //   'done'   = locked/completed → paid
  //   'cancel' = cancelled → cancelled
  //
  // SAFE DEFAULT: for overview-format orders (those with order_name), we default
  // to 'paid' when state is absent or unrecognised. Locally is a showroom POS —
  // orders that appear in the API are confirmed transactions. Only explicit draft/
  // sent/cancel states should override this.
  //
  // Defaulting to 'pending' was wrong — it caused all API-synced orders to be
  // invisible to the dashboard's financial_status='paid' filter whenever the
  // Locally API omitted the state field (which it frequently does).
  const financialStatus = isOverviewFormat
    ? (
        o.state === 'cancel'                          ? 'cancelled'
        : (o.state === 'draft' || o.state === 'sent') ? 'pending'
        :                                               'paid'  // sale, done, or absent → paid
      )
    : 'paid';

  // ── Date ──────────────────────────────────────────────────────────────────
  // Normalise to ISO 8601. The Locally API may return dates in various formats
  // ("31 Dec 2025, 04:30 pm", "2025-12-31 16:30:00", epoch ms, etc.).
  // new Date() handles all of these; we then store a clean ISO string so that
  // SQLite date comparisons and JS Date filtering both work correctly.
  const rawDate = o.created_at || o.date || o.order_date || '';
  let createdAt;
  try {
    const parsed = rawDate ? new Date(rawDate) : null;
    createdAt = (parsed && !isNaN(parsed.getTime())) ? parsed.toISOString() : new Date().toISOString();
  } catch (_) {
    createdAt = new Date().toISOString();
  }

  return {
    brand_id:           brandId,
    source:             'locally',
    source_order_id:    id,
    customer_name:      name,
    phone,
    city,
    items:              JSON.stringify(items),
    total,
    total_items:        totalItems,
    currency:           'EGP',
    payment_method:     paymentMethod,
    financial_status:   financialStatus,
    fulfillment_status: 'fulfilled',
    shipping:           JSON.stringify({ carrier: null, tracking_number: null, status: 'delivered', timeline: [] }),
    needs_action:       0,
    action_reason:      null,
    raw_data:           JSON.stringify(o),
    created_at:         createdAt,
    // _items is NOT persisted to orders_cache — it's used by fetchOrders/
    // importCSV to populate the order_items table, then discarded.
    _items:             items,
  };
}

// ── Inventory normalisation helpers ───────────────────────────────────────────

/**
 * Trim and collapse internal whitespace; capitalise first character.
 * "  blue hoodie  " → "Blue hoodie"
 */
function normName(s) {
  if (!s) return '';
  const t = String(s).trim().replace(/\s+/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Standardise variant labels to canonical size abbreviations.
 * Returns null for blank / "Default Title" sentinel values.
 *
 * Examples:
 *   "small"     → "S"
 *   "X-Large"   → "XL"
 *   "Medium / Black"  → "M / Black"  (only the size word is replaced)
 */
function normVariant(s) {
  if (!s) return null;
  const raw = String(s).trim();
  if (!raw || raw.toLowerCase() === 'default title' || raw.toLowerCase() === 'default') return null;
  return raw
    .replace(/\bxxx-?\s*large\b/gi, 'XXXL')
    .replace(/\bxx-?\s*large\b/gi,  'XXL')
    .replace(/\bx-?\s*large\b/gi,   'XL')
    .replace(/\blarge\b/gi,         'L')
    .replace(/\bmedium\b/gi,        'M')
    .replace(/\bsmall\b/gi,         'S')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generate a stable fallback SKU for a Locally product that has no server-
 * assigned identifier.
 *
 * Uses the same algorithm as db.canonicalSku() so the migration can reproduce
 * the same SKU values for existing rows without importing db.js.
 *
 * Output example: "loc-a1b2c3d4e5f6g7h8"
 */
function fallbackSku(productName, variantName) {
  const key = `locally|${(productName || '').toLowerCase().trim().replace(/\s+/g, ' ')}|${(variantName || '').toLowerCase().trim().replace(/\s+/g, ' ')}`;
  return `loc-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

/**
 * Normalize a raw Locally product into one or more inventory_cache rows
 * (one row per variant/size).
 *
 * SKU assignment priority:
 *   1. Explicit SKU from the API (v.sku / p.sku) — always preferred
 *   2. fallbackSku(productName, variantName) — stable SHA-256 hash, NEVER index-based
 *
 * The old index-based fallback "locally-${index}-${vi}" was the root cause of
 * inventory duplication: array order changed between syncs → different index →
 * different SKU → new row instead of update.  The hash-based fallback is
 * deterministic: same product name + variant → same SKU on every sync.
 */
function normalizeProduct(brandId, p, index) {
  const productName = normName(p.name || p.title || p.product_name || `Product ${index + 1}`);
  const variants    = (Array.isArray(p.variants) && p.variants.length) ? p.variants
                    : (Array.isArray(p.sizes)    && p.sizes.length)    ? p.sizes
                    : [p];

  return variants.map((v, _vi) => {
    const rawVariant = v.variant || v.size || v.name || (variants.length > 1 ? `Variant ${_vi + 1}` : null);
    const variantName = normVariant(rawVariant);
    const realSku = (v.sku || p.sku || '').trim();
    const sku     = realSku || fallbackSku(productName, variantName || '');

    return {
      brand_id:     brandId,
      source:       'locally',
      product_name: productName,
      variant_name: variantName,
      sku,
      quantity:     parseInt(v.stock || v.quantity || v.inventory_quantity || 0, 10),
      price:        parseFloat(v.price || p.price || 0),
      raw_data:     JSON.stringify(v),
    };
  });
}

// ── Overview ──────────────────────────────────────────────────────────────────

/**
 * Fetch aggregate sales summary from POST /api/dashboard/partner/overview.
 * Supplementary — never blocks the main sync if it fails.
 *
 * Confirmed response fields (from portal bundle):
 *   total_sales, total_quantity_sold, commission_paid, you_receive, latest_orders[]
 *
 * @param {string} token   Full "Bearer <token>" string
 * @param {object} [range] { start_date, end_date } in "YYYY-MM-DD" format
 * @returns {Promise<object|null>}
 */
async function fetchOverview(token, range = {}) {
  try {
    const body = {
      start_date: range.start_date || new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10),
      end_date:   range.end_date   || new Date().toISOString().slice(0, 10),
    };

    const res = await axios.post(
      `${BASE_URL}/api/dashboard/partner/overview`,
      body,
      { headers: { Authorization: token, Accept: 'application/json', 'Content-Type': 'application/json' }, timeout: 20000 }
    );

    // Confirmed path from portal bundle: data.result.data
    const raw = res.data?.result?.data || res.data?.result || res.data?.data || res.data || null;
    if (!raw || typeof raw !== 'object') return null;

    return {
      // Confirmed field names from portal bundle
      total_revenue:      parseFloat(raw.total_sales       || raw.total_revenue || 0),
      total_quantity_sold: parseInt(raw.total_quantity_sold || raw.quantity      || 0, 10),
      commission_paid:    parseFloat(raw.commission_paid    || 0),
      you_receive:        parseFloat(raw.you_receive        || 0),
      latest_orders:      Array.isArray(raw.latest_orders)  ? raw.latest_orders : [],
      period_start:       body.start_date,
      period_end:         body.end_date,
    };
  } catch (err) {
    console.warn('[locally] fetchOverview failed (non-fatal):', err.response?.status || err.message);
    return null;
  }
}

// ── Fetch orders ──────────────────────────────────────────────────────────────

/**
 * Fetch all orders and upsert into orders_cache.
 *
 * CRITICAL: endpoint requires POST with JSON-RPC envelope, NOT GET.
 * Verified from portal bundle: kt.post("/api/dashboard/partner/orders", { jsonrpc:"2.0", id:null, ...params })
 * Response: data.result.status === 200 → data.result.data (array)
 *
 * @param {string} brandId
 * @param {object} creds         { email, password }
 * @param {string} [existingToken]  Reuse token from a prior login() call
 * @returns {Promise<number>}    Count of orders upserted
 */
async function fetchOrders(brandId, creds, existingToken = null) {
  const token = existingToken || await login(creds.email, creds.password);
  if (!token) throw new Error('Locally login failed — invalid credentials');

  let res;
  try {
    // JSON-RPC envelope required — plain POST body is not accepted.
    //
    // Confirmed from portal bundle (2025-11-30): the portal sends start_date + end_date
    // alongside jsonrpc/id.  The portal's default is CURRENT MONTH ONLY — which is why
    // without explicit dates the API returns a very small subset.
    //
    // We send a 5-year lookback to capture maximum history.  The API returns the FULL
    // matching dataset in one call — no server-side pagination exists (confirmed: zero
    // occurrences of page/limit/cursor/has_more/total_pages in the portal bundle).
    const today      = new Date().toISOString().slice(0, 10);
    const fiveYrsAgo = new Date(Date.now() - 5 * 365 * 86400000).toISOString().slice(0, 10);
    const reqBody    = { jsonrpc: '2.0', id: null, start_date: fiveYrsAgo, end_date: today };

    console.log(`[locally] fetchOrders request: start_date=${fiveYrsAgo} end_date=${today}`);

    res = await axios.post(
      `${BASE_URL}/api/dashboard/partner/orders`,
      reqBody,
      { headers: { Authorization: token, Accept: 'application/json', 'Content-Type': 'application/json' }, timeout: 30000 }
    );
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data?.message || err.message;
    if (status === 401 || status === 403) {
      throw new Error('Orders fetch failed — session token rejected (credentials may need reconnect)');
    }
    throw new Error(`Orders endpoint error (HTTP ${status || 'network'}): ${msg}`);
  }

  // Confirmed response path from portal bundle: data.result.status 200 → data.result.data
  // Use loose comparison (==) to handle both numeric 200 and string "200"
  let orders;
  if (res.data?.result?.status == 200) {  // eslint-disable-line eqeqeq
    orders = res.data.result.data;
  } else if (Array.isArray(res.data?.result?.data)) {
    orders = res.data.result.data;
  } else if (Array.isArray(res.data?.data)) {
    orders = res.data.data;
  } else if (Array.isArray(res.data)) {
    orders = res.data;
  } else {
    const shape = JSON.stringify(res.data).slice(0, 300);
    console.warn(`[locally] orders: unexpected response shape — ${shape}`);
    // Surface result message if available
    const resultMsg = res.data?.result?.message || res.data?.message;
    if (resultMsg) throw new Error(`Orders API returned: ${resultMsg}`);
    return 0;
  }

  if (!Array.isArray(orders)) {
    console.warn('[locally] orders: result data is not an array:', typeof orders);
    return 0;
  }

  // ── Diagnostic logging ────────────────────────────────────────────────────
  // Shows the raw API response shape so we can confirm:
  //   1. How many records the API actually returned
  //   2. What fields each record has
  //   3. The date range the API covered
  console.log(`[locally] fetchOrders raw response: ${orders.length} items from API`);
  if (orders.length > 0) {
    const firstItem = orders[0];
    console.log('[locally] first item fields:', Object.keys(firstItem).sort().join(', '));
    console.log('[locally] first item sample:', JSON.stringify(firstItem).slice(0, 400));

    // Log date range of received data
    const dateField = firstItem.order_date != null ? 'order_date'
                    : firstItem.created_at  != null ? 'created_at'
                    : firstItem.date        != null ? 'date' : null;
    if (dateField) {
      const dates = orders.map(o => (o[dateField] || '').toString().slice(0, 10)).filter(Boolean).sort();
      console.log(`[locally] date range in response: ${dates[0]} → ${dates[dates.length - 1]} (field: ${dateField})`);
    }
  }
  // ── End diagnostic ────────────────────────────────────────────────────────

  // ── Transaction grouping ─────────────────────────────────────────────────
  // Group the N line-item rows into M transaction rows (M ≤ N).
  // Items from the same POS transaction share the same minute-level timestamp;
  // they are collapsed into a single orders_cache row with the correct total.
  //
  // This fixes two metrics that were wrong with per-line-item storage:
  //   • order_count was inflated (counted line items, not transactions)
  //   • AOV = total_revenue / order_count was artificially low
  const txGroups = groupLineItemsIntoTransactions(orders);
  console.log(`[locally] grouped ${orders.length} line items → ${txGroups.length} transactions`);

  // Clear ALL existing loc-* rows for this brand before inserting the new
  // transaction-grouped rows. The old rows used per-line-item hashes; the new
  // rows use per-transaction hashes — they are distinct keys. Without this
  // clear, old line-item rows would accumulate alongside the new ones and
  // double the revenue.  imp-* and csv-* rows are preserved.
  try {
    const cleared = _rawDb.prepare(`
      DELETE FROM orders_cache
      WHERE brand_id = ? AND source = 'locally' AND source_order_id LIKE 'loc-%'
    `).run(brandId);
    if (cleared.changes > 0) {
      console.log(`[locally] cleared ${cleared.changes} prior loc-* rows (line-item format) before transaction upsert`);
    }
  } catch (cleanErr) {
    console.warn('[locally] loc-* pre-clear failed (non-fatal):', cleanErr.message);
  }

  let count = 0;
  for (const group of txGroups) {
    try {
      const txRow = buildTransactionRow(brandId, group);
      const { _items, ...row } = txRow;   // strip transient _items field
      upsertOrder(row);
      count++;

      // Write line items separately — failure here must NOT roll back the transaction count
      if (_items && _items.length > 0) {
        try {
          upsertOrderItems(brandId, 'locally', row.source_order_id, _items);
        } catch (itemErr) {
          console.warn(`[locally] order_items upsert failed for ${row.source_order_id}:`, itemErr.message);
        }
      }
    } catch (err) {
      console.error('[locally] failed to upsert transaction:', err.message);
    }
  }

  console.log(`[locally] orders: upserted ${count}/${txGroups.length} transactions (from ${orders.length} line items) for brand=${brandId}`);

  // API-SUPERSEDES-IMPORT: once a successful API sync delivers orders, any
  // imp-* / csv-* rows from prior manual CSV imports are superseded and must
  // be removed. Without this, both sets of rows (same real orders, different
  // IDs) co-exist and are both counted by the financial_status='paid' filter,
  // inflating revenue by the full import amount.
  if (count > 0) {
    try {
      const cleared = _rawDb.prepare(`
        DELETE FROM orders_cache
        WHERE brand_id = ? AND source = 'locally'
          AND (source_order_id LIKE 'imp-%' OR source_order_id LIKE 'csv-%')
      `).run(brandId);
      if (cleared.changes > 0) {
        console.log(`[locally] cleared ${cleared.changes} imp-*/csv-* rows superseded by API sync for brand=${brandId}`);
      }
    } catch (cleanErr) {
      console.warn('[locally] imp-*/csv-* post-clear failed (non-fatal):', cleanErr.message);
    }
  }

  return count;
}

// ── Fetch products ────────────────────────────────────────────────────────────

/**
 * Fetch all products/inventory and upsert into inventory_cache.
 * Confirmed: GET method (no body needed).
 *
 * @param {string} brandId
 * @param {object} creds
 * @param {string} [existingToken]
 * @returns {Promise<number>}  Count of inventory rows upserted
 */
async function fetchProducts(brandId, creds, existingToken = null) {
  const token = existingToken || await login(creds.email, creds.password);
  if (!token) throw new Error('Locally login failed — invalid credentials');

  let res;
  try {
    res = await axios.get(
      `${BASE_URL}/api/dashboard/partner/products`,
      { headers: { Authorization: token, Accept: 'application/json' }, timeout: 25000 }
    );
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data?.message || err.message;
    if (status === 401 || status === 403) {
      throw new Error('Products fetch failed — session token rejected');
    }
    throw new Error(`Products endpoint error (HTTP ${status || 'network'}): ${msg}`);
  }

  // Products endpoint returns the array more directly than orders
  const products = res.data?.result?.data || res.data?.data || res.data || [];
  if (!Array.isArray(products)) {
    console.warn('[locally] products: unexpected response shape:', JSON.stringify(res.data).slice(0, 300));
    return 0;
  }

  let count = 0;
  products.forEach((p, i) => {
    try {
      const variants = normalizeProduct(brandId, p, i);
      variants.forEach((v) => { upsertInventory(v); count++; });
    } catch (err) {
      console.error(`[locally] failed to upsert product index=${i}:`, err.message);
    }
  });

  console.log(`[locally] products: upserted ${count} variants from ${products.length} products for brand=${brandId}`);
  return count;
}

// ── Full sync ─────────────────────────────────────────────────────────────────

/**
 * Full sync: login once → fetch orders + products + overview.
 * Never throws — all errors are caught, logged to sync_logs, and surfaced
 * via integration health so the UI can show a precise failure reason.
 */
async function fullSync(brandId) {
  console.log(`[locally] starting sync for brand=${brandId}`);

  const integration = getIntegration(brandId, 'locally');
  if (!integration || integration.status === 'disconnected') {
    console.log(`[locally] skipping sync — brand=${brandId} not connected`);
    return;
  }

  // ── Decrypt credentials ───────────────────────────────────────────────────
  let creds;
  try {
    creds = decryptJSON(integration.credentials);
  } catch (err) {
    const msg = 'Credential decryption failed — reconnect Locally to reset stored credentials';
    console.error('[locally]', msg, err.message);
    logSync(brandId, 'locally', 'error', msg);
    updateIntegrationStatus(brandId, 'locally', 'error');
    setIntegrationHealth(brandId, 'locally', 'error', msg);
    return;
  }

  // ── Single login ──────────────────────────────────────────────────────────
  let token;
  try {
    token = await login(creds.email, creds.password);
  } catch (err) {
    const msg = `Network error reaching Locally: ${err.message}`;
    console.error(`[locally] ${msg}`);
    logSync(brandId, 'locally', 'error', msg);
    // Don't mark integration as error for network issues — it may be transient
    return;
  }

  if (!token) {
    const msg = 'Invalid Locally credentials — email or password rejected. Click Reconnect to update.';
    console.error(`[locally] ${msg} (brand=${brandId})`);
    logSync(brandId, 'locally', 'error', msg);
    updateIntegrationStatus(brandId, 'locally', 'error');
    setIntegrationHealth(brandId, 'locally', 'error', msg);
    return;
  }

  // ── Fetch data (independent — don't let one failure abort others) ─────────
  let orderCount = 0, productCount = 0, overview = null;
  const errors = [];

  // ── ORDER SOURCE: fetchOrders() via POST /partner/orders ──────────────────
  //
  // WHY NOT fetchOrderHistory():
  //   fetchOrderHistory() calls POST /partner/overview and reads latest_orders[].
  //   The Locally API's latest_orders field is limited to the N most-recent orders
  //   regardless of the date range in the request body (typical dashboard-overview
  //   behaviour). Calling it year-by-year still returns the same small set after
  //   deduplication — and the subsequent loc-* cleanup then deletes all historical
  //   data from previous syncs, leaving the DB nearly empty.
  //
  // WHY fetchOrders():
  //   POST /partner/orders with a 5-year date range is the ONLY Locally endpoint
  //   that returns the full transaction history. Confirmed from portal bundle: no
  //   pagination (no cursor/limit/has_more). All matching records come back in one
  //   response. Each row is a line-item (one per product per sale), not an order.
  //
  // TRADE-OFFS vs fetchOrderHistory():
  //   + Complete historical coverage (proven to work)
  //   + All rows get financial_status='paid' (correct for showroom POS)
  //   - Each transaction may become N rows (one per product line)
  //   - order_count metric is inflated; AOV is divided by line-item count, not
  //     transaction count — acceptable until Locally provides a proper orders API
  //
  // DEDUP WITH EXISTING DATA:
  //   Any order_name rows left over from a previous fetchOrderHistory sync
  //   are cleared first to prevent double-counting. The fetchOrders upsert is
  //   idempotent: same content-hash → same loc-* key → UPDATE not INSERT.

  // Clear order_name rows left by previous fetchOrderHistory runs.
  // After this cleanup, only loc-*, imp-*, csv-* rows remain.
  try {
    const cleared = _rawDb.prepare(`
      DELETE FROM orders_cache
      WHERE brand_id = ? AND source = 'locally'
        AND source_order_id NOT LIKE 'loc-%'
        AND source_order_id NOT LIKE 'imp-%'
        AND source_order_id NOT LIKE 'csv-%'
    `).run(brandId);
    if (cleared.changes > 0) {
      console.log(`[locally] cleared ${cleared.changes} order_name rows left by prior fetchOrderHistory sync`);
    }
  } catch (cleanErr) {
    console.warn('[locally] order_name cleanup failed (non-fatal):', cleanErr.message);
  }

  try {
    orderCount = await fetchOrders(brandId, creds, token);
    console.log(`[locally] fetchOrders complete — ${orderCount} line-item rows upserted for brand=${brandId}`);
  } catch (err) {
    errors.push(`Orders: ${err.message}`);
    console.error(`[locally] fetchOrders failed brand=${brandId}:`, err.message);
  }

  try {
    productCount = await fetchProducts(brandId, creds, token);
  } catch (err) {
    errors.push(`Products: ${err.message}`);
    console.error(`[locally] fetchProducts failed brand=${brandId}:`, err.message);
  }

  // Overview: aggregate stats for logging and cross-check only.
  // Not used as order source — see above.
  overview = await fetchOverview(token);
  if (overview) {
    console.log(`[locally] overview check — API total_revenue=${overview.total_revenue} qty=${overview.total_quantity_sold} period=${overview.period_start}→${overview.period_end}`);
    console.log(`[locally] db vs api: if these diverge, date-range mismatch or api limit suspected`);
  }

  // ── Outcome ───────────────────────────────────────────────────────────────
  const totalRecords = orderCount + productCount;
  let status, errorMsg;

  if (errors.length === 0) {
    status   = 'success';
    errorMsg = null;
  } else if (totalRecords > 0) {
    status   = 'partial';
    errorMsg = errors.join(' | ');
  } else {
    status   = 'error';
    errorMsg = errors.join(' | ');
  }

  logSync(brandId, 'locally', status, errorMsg, totalRecords);
  updateIntegrationStatus(brandId, 'locally', status === 'error' ? 'error' : 'connected');
  if (status !== 'error') {
    // LAST_SYNC_EXPLICIT — updateIntegrationStatus no longer advances last_sync;
    // advance it here so the dashboard shows the correct "last synced" timestamp.
    _rawDb.prepare(
      "UPDATE integrations SET last_sync = datetime('now') WHERE brand_id = ? AND platform = 'locally'"
    ).run(brandId);
    console.log(`[locally] last_sync advanced brand=${brandId}`);
  }
  setIntegrationHealth(
    brandId, 'locally',
    status === 'error' ? 'error' : (status === 'partial' ? 'warning' : 'ok'),
    errorMsg
  );

  console.log(`[locally] sync complete — line_items=${orderCount} products=${productCount} overview=${overview ? 'ok' : 'n/a'} status=${status} brand=${brandId}`);
}

// ── CSV import (fallback) ─────────────────────────────────────────────────────

/**
 * Parse and import orders from a CSV buffer.
 *
 * Expected columns (header row required):
 *   date, customer_name, phone, city, items, total, payment_method
 *
 * "items" column: semicolon-separated "Name x Qty @ Price"
 *   e.g. "Blue Hoodie x 2 @ 750;Black Cap x 1 @ 350"
 */
function importCSV(brandId, csvBuffer) {
  const text  = csvBuffer.toString('utf8').trim();
  const lines = text.split(/\r?\n/).filter(Boolean);

  if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row');

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const errors = [];
  let count    = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const row  = {};
    header.forEach((col, j) => { row[col] = (cols[j] || '').trim(); });

    try {
      const itemParts = (row.items || '').split(';').filter(Boolean);
      const items = itemParts.map((part) => {
        const atMatch = part.match(/^(.+?)\s*@\s*([\d.]+)$/);
        const xMatch  = atMatch
          ? atMatch[1].match(/^(.+?)\s*x\s*(\d+)$/i)
          : part.match(/^(.+?)\s*x\s*(\d+)$/i);
        return {
          name:  (xMatch ? xMatch[1] : (atMatch ? atMatch[1] : part)).trim(),
          qty:   xMatch ? parseInt(xMatch[2], 10) : 1,
          price: atMatch ? parseFloat(atMatch[2]) : 0,
        };
      });

      const paymentRaw  = (row.payment_method || '').toLowerCase();
      const totalItems  = items.length > 0 ? items.reduce((s, it) => s + (it.qty || 1), 0) : 1;
      const totalAmount = parseFloat(row.total) || 0;
      const uniqueId    = `csv-${row.date || ''}-${row.customer_name || ''}-${i}`.replace(/\s+/g, '-');

      upsertOrder({
        brand_id:           brandId,
        source:             'locally',
        source_order_id:    uniqueId,
        customer_name:      row.customer_name || 'Unknown',
        phone:              row.phone         || '',
        city:               row.city          || '',
        items:              JSON.stringify(items),
        total:              totalAmount,
        total_items:        totalItems,
        currency:           'EGP',
        payment_method:     paymentRaw.includes('card') ? 'card' : 'cash',
        financial_status:   'paid',
        fulfillment_status: 'fulfilled',
        shipping:           JSON.stringify({ carrier: null, tracking_number: null, status: 'delivered', timeline: [] }),
        needs_action:       0,
        action_reason:      null,
        raw_data:           JSON.stringify(row),
        created_at:         row.date ? new Date(row.date).toISOString() : new Date().toISOString(),
      });
      if (items.length > 0) {
        upsertOrderItems(brandId, 'locally', uniqueId, items);
      }
      count++;
    } catch (err) {
      errors.push(`Row ${i + 1}: ${err.message}`);
    }
  }

  logSync(brandId, 'locally', errors.length ? 'partial' : 'success', errors.join('; ') || null, count);
  return { count, errors };
}

// ── Locally portal export import ──────────────────────────────────────────────

/**
 * Import orders from a file exported directly from the Locally EG portal.
 *
 * DEDUPLICATION STRATEGY
 * ──────────────────────
 * • If an order-number / receipt column is detected in the file:
 *     source_order_id = that value (e.g. "S00042")
 *     This is EXACT and fully idempotent — re-importing the same file is safe.
 *     Orders already present from the API sync (fetchOrderHistory) share the
 *     same source_order_id, so they are merged, never duplicated.
 *
 * • If no order-number column is found:
 *     source_order_id = "imp-{sha256(date|total|items_summary).slice(0,20)}"
 *     LIMITATION: Two orders with identical date + total + items text on the
 *     same day will be treated as one order. The result report flags this.
 *     These hash IDs start with "imp-" and will NOT merge with API-sourced
 *     "loc-" hash rows even if they represent the same order.
 *
 * COLUMN AUTO-DETECTION
 * ─────────────────────
 * Headers are matched loosely (case-insensitive, partial match) so the
 * function works across different export versions and Arabic column names.
 * Required: at least one date column AND one total/amount column.
 * Preferred: an order-number column for stable deduplication.
 *
 * @param {string} brandId
 * @param {Buffer} fileBuffer
 * @returns {{
 *   found: number,
 *   imported: number,
 *   new_rows: number,
 *   updated_rows: number,
 *   errors: Array<{row:number, error:string}>,
 *   has_stable_id: boolean,
 *   id_column: string|null,
 *   detected_columns: object,
 *   warnings: string[]
 * }}
 */
function importLocallyExport(brandId, fileBuffer) {
  // Strip UTF-8 BOM (0xEF 0xBB 0xBF) — common in Windows-exported CSVs
  const text = fileBuffer.toString('utf8').replace(/^\uFEFF/, '').trim();
  const rawLines = text.split(/\r?\n/);
  const lines = rawLines.map((l) => l.trim()).filter(Boolean);

  if (lines.length < 2) {
    throw new Error('File must contain a header row and at least one data row');
  }

  // ── Separator detection ───────────────────────────────────────────────────
  // Prefer tab, then semicolon, then comma.
  const firstLine = lines[0];
  const sep = firstLine.includes('\t') ? '\t'
            : firstLine.split(';').length > firstLine.split(',').length ? ';'
            : ',';

  // ── CSV line parser ────────────────────────────────────────────────────────
  // Handles quoted fields containing the separator character.
  function parseLine(line) {
    const fields = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; continue; } // escaped quote
        inQ = !inQ;
        continue;
      }
      if (!inQ && c === sep) { fields.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    fields.push(cur.trim());
    return fields;
  }

  const rawHeader = parseLine(lines[0]);
  // Normalise header labels: lowercase, strip non-alphanumeric (keeps Arabic Unicode)
  const header = rawHeader.map((h) =>
    h.replace(/^"|"$/g, '').toLowerCase().replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
  );

  // ── Column detection ───────────────────────────────────────────────────────
  // Each call scans the header array for the first column whose name contains
  // any of the supplied pattern strings.
  function findCol(...patterns) {
    for (const p of patterns) {
      const idx = header.findIndex((h) => h.includes(p));
      if (idx !== -1) return idx;
    }
    return -1;
  }

  const C = {
    orderId:  findCol('order_name', 'order name', 'order no', 'order number', 'order#',
                      'receipt', 'invoice', 'transaction', 'ref no', 'رقم الطلب',
                      'رقم', 'order id', '#order'),
    date:     findCol('date', 'created_at', 'order_date', 'order date', 'تاريخ', 'time'),
    total:    findCol('total', 'amount', 'grand', 'مجموع', 'value', 'إجمالي', 'price'),
    items:    findCol('items', 'products', 'product', 'lines', 'qty', 'quantity',
                      'عدد', 'بضاعة', 'item'),
    status:   findCol('status', 'state', 'حالة'),
    type:     findCol('type', 'نوع'),
    customer: findCol('customer', 'client', 'customer name', 'عميل', 'اسم'),
    phone:    findCol('phone', 'mobile', 'tel', 'هاتف'),
    city:     findCol('city', 'location', 'branch', 'مدينة', 'فرع'),
    payment:  findCol('payment', 'method', 'طريقة', 'وسيلة'),
  };

  const hasStableId   = C.orderId !== -1;
  const idColumnLabel = hasStableId ? rawHeader[C.orderId] : null;
  const warnings      = [];

  if (!hasStableId) {
    warnings.push(
      'No order-number column was detected in this file. A content hash ' +
      '(date + total + items) is used as the deduplication key instead. ' +
      'Two different orders with an identical date, total, and items text ' +
      'on the same day will be stored as one row. For exact deduplication, ' +
      'ensure the export includes a column named "Order Name", "Receipt", ' +
      '"Invoice", or "Transaction" containing a unique order identifier.'
    );
  }

  if (C.date === -1) {
    throw new Error(
      `Required column not found: date. ` +
      `Detected headers: [${rawHeader.join(', ')}]. ` +
      `Expected a column named "date", "created_at", "order_date", or similar.`
    );
  }

  if (C.total === -1) {
    throw new Error(
      `Required column not found: total/amount. ` +
      `Detected headers: [${rawHeader.join(', ')}]. ` +
      `Expected a column named "total", "amount", "grand_total", or similar.`
    );
  }

  // ── Count baseline rows ────────────────────────────────────────────────────
  // Used after import to split new-inserts vs updates without per-row queries.
  const beforeCount = _rawDb.prepare(
    "SELECT COUNT(*) AS cnt FROM orders_cache WHERE brand_id = ? AND source = 'locally'"
  ).get(brandId).cnt;

  // ── Parse and upsert each data row ─────────────────────────────────────────
  const result = { found: 0, imported: 0, errors: [] };

  // COLLISION_GUARD — tracks hash keys already assigned in this import so that
  // two orders with identical date+total+items on the same day get distinct IDs.
  // Appending an occurrence counter makes the assignment deterministic: the same
  // file always produces the same sequence of IDs, so re-importing is still safe.
  const _hashOccurrences = new Map();

  for (let i = 1; i < lines.length; i++) {
    const fields = parseLine(lines[i]);
    // Skip truly blank lines
    if (fields.every((f) => !f)) continue;

    result.found++;

    try {
      const get = (idx) => (idx !== -1 && fields[idx]) ? fields[idx].trim() : '';

      const rawDate   = get(C.date);
      const rawTotal  = get(C.total);
      const rawId     = get(C.orderId);
      const rawItems  = get(C.items);
      const rawStatus = get(C.status);
      const rawType   = get(C.type);
      const custName  = get(C.customer) || 'Showroom Customer';
      const phone     = get(C.phone);
      const city      = get(C.city) || 'Cairo';
      const payment   = get(C.payment);

      if (!rawDate) {
        result.errors.push({ row: i + 1, error: 'Missing date value — row skipped' });
        continue;
      }

      // ── Date normalisation ───────────────────────────────────────────────
      // Convert common formats to ISO 8601 with T separator.
      // CRITICAL: date-only values (e.g. "2025-10-15") must include a time
      // component or SQLite string comparisons can exclude them on the exact
      // boundary day: "2026-04-12" < "2026-04-12T00:00:00.000Z" is TRUE, so
      // orders from the current day would be silently excluded from the period
      // filter. We append T00:00:00 to make boundary comparisons safe.
      let dateNorm = rawDate;
      if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(rawDate)) {
        // DD/MM/YYYY → YYYY-MM-DDT00:00:00
        const [d, m, y] = rawDate.split('/');
        dateNorm = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T00:00:00`;
      } else if (/^\d{4}-\d{2}-\d{2} /.test(rawDate)) {
        // "YYYY-MM-DD HH:MM:SS" → replace space with T
        dateNorm = rawDate.replace(' ', 'T');
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(dateNorm)) {
        // Date-only ISO string → add time component
        dateNorm = `${dateNorm}T00:00:00`;
      }
      // Anything else (already has T+time) — leave as-is

      // ── Total ────────────────────────────────────────────────────────────
      // Strip currency symbols, commas used as thousands separators
      const total = parseFloat(
        rawTotal.replace(/[^0-9.,-]/g, '').replace(/,(?=\d{3})/g, '').replace(',', '.')
      ) || 0;

      // ── Stable order ID ──────────────────────────────────────────────────
      let sourceOrderId;
      if (hasStableId && rawId) {
        sourceOrderId = rawId;
      } else {
        // Content hash: date (day precision) + total + first 80 chars of items text.
        // COLLISION_GUARD: if two rows share the same base hash (identical day, total,
        // and items), append an incrementing suffix to make each ID unique while
        // keeping the assignment deterministic (same file → same IDs on re-import).
        const hashBase  = `${dateNorm.slice(0, 10)}|${total.toFixed(2)}|${rawItems.slice(0, 80)}`;
        const occurrences = _hashOccurrences.get(hashBase) || 0;
        _hashOccurrences.set(hashBase, occurrences + 1);

        if (occurrences > 0) {
          console.warn(
            `[guardrail] locally_csv_collision brand=${brandId}` +
            ` date=${dateNorm.slice(0, 10)} total=${total.toFixed(2)}` +
            ` occurrence=${occurrences + 1} — distinct IDs assigned to prevent merge`
          );
        }

        const hashInput = occurrences > 0 ? `${hashBase}|${occurrences}` : hashBase;
        const hash      = crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 20);
        sourceOrderId   = `imp-${hash}`;
      }

      // ── Items ─────────────────────────────────────────────────────────────
      // Try to parse structured item strings (semicolon / Arabic comma separated).
      // Falls back to a single synthetic line-item if parsing yields nothing.
      let items = [];
      let totalItemQty = 0;

      if (rawItems) {
        const itemParts = rawItems.split(/[;،]/).map((p) => p.trim()).filter(Boolean);
        for (const part of itemParts) {
          const xMatch  = part.match(/^(.+?)\s*[xX×*]\s*(\d+)/);
          const atMatch = part.match(/@\s*([\d.]+)/);
          const name    = (xMatch ? xMatch[1] : part).trim() || 'Item';
          const qty     = xMatch ? parseInt(xMatch[2], 10) : 1;
          const price   = atMatch ? parseFloat(atMatch[1]) : 0;
          items.push({ name, qty, price, variant: null, sku: null });
          totalItemQty += qty;
        }
      }

      if (items.length === 0) {
        items        = [{ name: 'Showroom Sale', qty: 1, price: total, variant: null, sku: null }];
        totalItemQty = 1;
      }

      // ── Financial status ──────────────────────────────────────────────────
      // Odoo/Locally state vocabulary (same as normalizeOrder() above):
      //   'sale'   = confirmed sale order   → paid  ← WAS WRONG (mapped to pending)
      //   'done'   = locked/completed       → paid
      //   'draft'  = quotation              → pending
      //   'sent'   = quotation sent         → pending
      //   'cancel' = cancelled              → cancelled
      //
      // CRITICAL FIX: 'sale' must map to 'paid', not 'pending'.
      // The Locally portal export uses state='sale' for all confirmed/active orders.
      // Mapping it to 'pending' caused all imported rows to be excluded by the
      // dashboard query's `WHERE financial_status='paid'` filter → dashboard zeros.
      const stateRaw = (rawStatus || rawType || '').toLowerCase();
      const financialStatus =
        // Explicit cancellation
        (stateRaw.includes('cancel') || stateRaw.includes('ملغ'))  ? 'cancelled'
        // Explicit draft/quotation (not yet confirmed)
        : (stateRaw.includes('draft') || stateRaw.includes('sent') ||
           stateRaw.includes('مسودة'))                              ? 'pending'
        // Confirmed orders: 'sale', 'done', 'paid', 'complete', 'مكتمل', or empty
        // (showroom exports contain only completed transactions)
        :                                                             'paid';

      // ── Payment method ────────────────────────────────────────────────────
      const pmRaw = payment.toLowerCase();
      const paymentMethod = (pmRaw.includes('card') || pmRaw.includes('visa') ||
                             pmRaw.includes('credit') || pmRaw.includes('كارت')) ? 'card' : 'cash';

      const orderRow = {
        brand_id:           brandId,
        source:             'locally',
        source_order_id:    sourceOrderId,
        customer_name:      custName,
        phone,
        city,
        items:              JSON.stringify(items),
        total,
        total_items:        totalItemQty,
        currency:           'EGP',
        payment_method:     paymentMethod,
        financial_status:   financialStatus,
        fulfillment_status: 'fulfilled',
        shipping:           JSON.stringify({ carrier: null, tracking_number: null, status: 'delivered', timeline: [] }),
        needs_action:       0,
        action_reason:      null,
        raw_data:           JSON.stringify({ _import: true, _row: i, fields }),
        created_at:         dateNorm,
      };

      upsertOrder(orderRow);
      result.imported++;

      // Line items — failure here must not roll back the order count
      try {
        upsertOrderItems(brandId, 'locally', sourceOrderId, items);
      } catch (itemErr) {
        // Non-fatal — order row is stored, items table is supplementary
      }

    } catch (err) {
      result.errors.push({ row: i + 1, error: err.message });
    }
  }

  // ── Compute new vs updated ─────────────────────────────────────────────────
  const afterCount  = _rawDb.prepare(
    "SELECT COUNT(*) AS cnt FROM orders_cache WHERE brand_id = ? AND source = 'locally'"
  ).get(brandId).cnt;

  const newRows     = Math.max(0, afterCount - beforeCount);
  const updatedRows = Math.max(0, result.imported - newRows);

  // ── Clear obsolete loc-* hash rows ────────────────────────────────────────
  // loc-* rows were created by the old fetchOrders() path that used content
  // hashes as IDs. Imported rows (stable IDs or imp-* hashes) supersede them.
  // Deleting ensures the dashboard count is not inflated by stale shadows.
  let locRowsCleared = 0;
  if (result.imported > 0) {
    try {
      const purged = _rawDb.prepare(
        "DELETE FROM orders_cache WHERE brand_id = ? AND source = 'locally' AND source_order_id LIKE 'loc-%'"
      ).run(brandId);
      locRowsCleared = purged.changes;
      if (locRowsCleared > 0) {
        console.log(`[locally] importLocallyExport: cleared ${locRowsCleared} obsolete loc-* hash rows for brand=${brandId}`);
      }
    } catch (cleanErr) {
      console.warn('[locally] importLocallyExport: loc-* cleanup failed (non-fatal):', cleanErr.message);
    }

    // ── Record import timestamp on integrations row ──────────────────────────
    // locally_imported_at is set only when a successful import has occurred.
    // The sales route reads this field to populate channel_split.locally.imported_at
    // so the dashboard can show when data was last verified by a manual import.
    try {
      _rawDb.prepare(`
        UPDATE integrations
        SET locally_imported_at = datetime('now')
        WHERE brand_id = ? AND platform = 'locally'
      `).run(brandId);
    } catch (_) {
      // Column may not exist yet (migration hasn't run) — non-fatal
    }
  }

  // ── Log to sync_logs ──────────────────────────────────────────────────────
  const errCount = result.errors.length;
  logSync(
    brandId, 'locally',
    errCount > 0 && result.imported === 0 ? 'error'
    : errCount > 0                         ? 'partial'
    :                                        'success',
    errCount > 0 ? `${errCount} row(s) could not be parsed` : null,
    result.imported
  );

  return {
    found:             result.found,
    imported:          result.imported,
    new_rows:          newRows,
    updated_rows:      updatedRows,
    loc_rows_cleared:  locRowsCleared,
    errors:            result.errors,
    has_stable_id:     hasStableId,
    id_column:         idColumnLabel,
    detected_columns:  Object.fromEntries(
      Object.entries(C)
        .filter(([, v]) => v !== -1)
        .map(([k, v]) => [k, rawHeader[v]])
    ),
    warnings,
  };
}

module.exports = { login, fetchOrders, fetchProducts, fetchOverview, fullSync, importCSV, importLocallyExport };
