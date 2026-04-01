'use strict';

/**
 * ShipBlu integration module
 *
 * ShipBlu is an Egyptian courier/logistics company.
 * API base: https://api.shipblu.com/api/v1
 *
 * Auth:
 *   - Merchants generate a permanent API key at app.shipblu.com → Integrations → API Key
 *   - The key does not expire unless the merchant explicitly regenerates it
 *   - Stored encrypted in integrations table as: { api_key: "...", webhook_secret: "..." }
 *   - No token_expires_at tracking needed
 *
 * Auth header format:
 *   ShipBlu accepts several formats. We try in order and permanently record
 *   which one works (stored in credentials.auth_scheme after first success):
 *     1. Authorization: Token {api_key}
 *     2. Authorization: Api-Key {api_key}
 *     3. Authorization: Basic {api_key}
 *
 * How it connects to orders:
 *   ShipBlu delivery order `reference` field = Shopify order name without '#'
 *   e.g. ShipBlu reference "1042" matches Shopify order "#1042"
 *
 *   We fetch all delivery orders from ShipBlu, then update orders_cache:
 *   - shipping JSON field: carrier, tracking_number, status, timeline
 *   - fulfillment_status: derived from ShipBlu status
 *   - needs_action: flagged on failed/returned
 *
 * Webhooks:
 *   ShipBlu supports webhook callbacks configured at app.shipblu.com → Integrations → Webhooks.
 *   We generate a webhook_secret at connect time. The merchant adds it as a custom header
 *   `X-Webhook-Secret` when registering the webhook. The receiver verifies it.
 *   Webhooks supplement the scheduled 30-minute poll.
 */

const axios  = require('axios');
const crypto = require('crypto');
const { db, getIntegration, logSync, updateIntegrationStatus } = require('../db/db');
const { decryptJSON, encryptJSON }                             = require('../middleware/encryption');

const BASE_URL = 'https://api.shipblu.com/api/v1';

// Auth header schemes to try, in priority order
const AUTH_SCHEMES = ['Token', 'Api-Key', 'Basic'];

// ── ShipBlu status mapping ────────────────────────────────────────────────────

const STATUS_MAP = {
  created:            { fulfillment: 'unfulfilled', action: false },
  pickup_requested:   { fulfillment: 'unfulfilled', action: false },
  out_for_pickup:     { fulfillment: 'unfulfilled', action: false },
  picked_up:          { fulfillment: 'shipped',     action: false },
  in_transit:         { fulfillment: 'shipped',     action: false },
  en_route:           { fulfillment: 'shipped',     action: false },
  out_for_delivery:   { fulfillment: 'shipped',     action: false },
  delivery_attempted: { fulfillment: 'failed',      action: true,  reason: 'Delivery attempt failed — customer not reachable' },
  delivered:          { fulfillment: 'fulfilled',   action: false },
  cancelled:          { fulfillment: 'failed',      action: false },
  return_to_origin:   { fulfillment: 'failed',      action: true,  reason: 'Returned to sender' },
  returned:           { fulfillment: 'failed',      action: true,  reason: 'Returned to sender' },
};

function mapStatus(sbStatus) {
  return STATUS_MAP[(sbStatus || '').toLowerCase()] || { fulfillment: 'shipped', action: false };
}

// ── API requests ──────────────────────────────────────────────────────────────

/**
 * Make a GET request to the ShipBlu API using a specific auth scheme.
 */
async function shipbluGet(path, apiKey, scheme, params = {}) {
  const res = await axios.get(`${BASE_URL}${path}`, {
    headers:  { Authorization: `${scheme} ${apiKey}`, Accept: 'application/json' },
    params,
    timeout:  15000,
  });
  return res.data;
}

/**
 * Test a single API key against ShipBlu to find which auth scheme works.
 * Tries each scheme in AUTH_SCHEMES order.
 *
 * @param {string} apiKey
 * @returns {Promise<string|null>}  the working scheme name, or null if all fail
 */
async function detectAuthScheme(apiKey) {
  for (const scheme of AUTH_SCHEMES) {
    try {
      await axios.get(`${BASE_URL}/delivery-orders/`, {
        headers: { Authorization: `${scheme} ${apiKey}`, Accept: 'application/json' },
        params:  { per_page: 1, page: 1 },
        timeout: 10000,
      });
      console.log(`[shipblu] auth scheme confirmed: ${scheme}`);
      return scheme;
    } catch (err) {
      const status = err.response?.status;
      if (status === 401 || status === 403) {
        console.log(`[shipblu] auth scheme ${scheme} rejected (${status})`);
        continue;
      }
      // Non-auth error (500, network, etc.) — scheme might still be correct
      // Accept it tentatively rather than ruling it out
      console.log(`[shipblu] auth scheme ${scheme} returned ${status} — accepting tentatively`);
      return scheme;
    }
  }
  return null;
}

/**
 * Test that an API key is valid before saving.
 * Returns true if any auth scheme succeeds, false if all return 401/403.
 *
 * @param {string} apiKey
 * @returns {Promise<boolean>}
 */
async function testConnection(apiKey) {
  const scheme = await detectAuthScheme(apiKey);
  return scheme !== null;
}

// ── Matching & updating orders ────────────────────────────────────────────────

/**
 * Match a ShipBlu delivery order to a row in orders_cache and update it.
 *
 * Matching strategy (first match wins):
 *   1. orders_cache.source_order_id = '#' + reference   (Shopify format "#1042")
 *   2. orders_cache.source_order_id = reference          ("1042")
 *   3. shipping JSON tracking_number matches
 */
const updateOrderShipping = db.transaction((brandId, sbOrder) => {
  const ref    = String(sbOrder.reference || sbOrder.order_number || '').replace(/^#/, '');
  const track  = sbOrder.tracking_number || '';
  const status = (sbOrder.status || '').toLowerCase();
  const mapped = mapStatus(status);

  // Build timeline from ShipBlu's status history if available
  const timeline = (sbOrder.status_updates || sbOrder.history || []).map((h) => ({
    status:    h.status || h.state,
    timestamp: h.created_at || h.timestamp || h.date,
    note:      h.comment || h.notes || h.failure_reason || '',
  }));

  if (!timeline.length) {
    timeline.push({ status, timestamp: sbOrder.updated_at || sbOrder.created_at, note: '' });
  }

  const shipping = JSON.stringify({
    carrier:         'shipblu',
    tracking_number: track || null,
    status,
    timeline,
  });

  const candidates = [`#${ref}`, ref, track].filter(Boolean);
  for (const candidate of candidates) {
    const result = db.prepare(`
      UPDATE orders_cache
      SET
        shipping           = ?,
        fulfillment_status = ?,
        needs_action       = ?,
        action_reason      = ?,
        updated_at         = datetime('now')
      WHERE brand_id = ?
        AND source_order_id = ?
    `).run(
      shipping,
      mapped.fulfillment,
      mapped.action ? 1 : 0,
      mapped.action ? (mapped.reason || null) : null,
      brandId,
      candidate
    );

    if (result.changes > 0) return result.changes;
  }

  return 0;
});

// ── Public integration functions ──────────────────────────────────────────────

/**
 * Fetch recent shipments from ShipBlu and update matching orders in orders_cache.
 *
 * @param {string} brandId
 * @param {string} apiKey      decrypted API key
 * @param {string} authScheme  e.g. "Token" — discovered at connect time
 * @returns {Promise<number>}  count of orders updated
 */
async function fetchShipments(brandId, apiKey, authScheme) {
  let page    = 1;
  let updated = 0;
  let hasMore = true;

  while (hasMore) {
    const data = await shipbluGet('/delivery-orders/', apiKey, authScheme, { limit: 100, page });

    const results = data.results || data.orders || data.shipments || (Array.isArray(data) ? data : []);
    if (!results.length) break;

    for (const sbOrder of results) {
      const changes = updateOrderShipping(brandId, sbOrder);
      if (changes > 0) updated++;
    }

    const totalCount = data.count || 0;
    hasMore = totalCount > page * 100 && results.length === 100;
    page++;
  }

  return updated;
}

/**
 * Full sync: fetch shipments and update orders_cache.
 * Never throws.
 */
async function fullSync(brandId) {
  console.log(`[shipblu] starting sync for brand=${brandId}`);

  const integration = getIntegration(brandId, 'shipblu');
  if (!integration || integration.status === 'disconnected') return;

  let creds;
  try {
    creds = decryptJSON(integration.credentials);
  } catch (err) {
    console.error('[shipblu] failed to decrypt credentials:', err.message);
    logSync(brandId, 'shipblu', 'error', 'Failed to decrypt stored credentials');
    return;
  }

  const { api_key, auth_scheme } = creds;

  if (!api_key) {
    updateIntegrationStatus(brandId, 'shipblu', 'error');
    logSync(brandId, 'shipblu', 'error', 'No API key found — reconnect ShipBlu in Settings');
    return;
  }

  // If we haven't detected the auth scheme yet, do it now and persist it
  let scheme = auth_scheme;
  if (!scheme) {
    scheme = await detectAuthScheme(api_key);
    if (!scheme) {
      const msg = 'ShipBlu API key rejected — regenerate key at app.shipblu.com → Integrations';
      console.error(`[shipblu] ${msg} brand=${brandId}`);
      updateIntegrationStatus(brandId, 'shipblu', 'error');
      logSync(brandId, 'shipblu', 'error', msg);
      return;
    }
    // Persist the working scheme so we don't probe on every sync
    creds.auth_scheme = scheme;
    db.prepare("UPDATE integrations SET credentials = ? WHERE brand_id = ? AND platform = 'shipblu'")
      .run(encryptJSON(creds), brandId);
  }

  let updatedCount = 0, error = null;
  try {
    updatedCount = await fetchShipments(brandId, api_key, scheme);
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      error = 'API key rejected by ShipBlu — regenerate key at app.shipblu.com → Integrations';
      updateIntegrationStatus(brandId, 'shipblu', 'error');
    } else {
      error = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    }
    console.error(`[shipblu] sync error for brand=${brandId}:`, error);
  }

  const statusResult = error ? 'error' : 'connected';
  logSync(brandId, 'shipblu', error ? 'error' : 'success', error, updatedCount);
  if (!error) updateIntegrationStatus(brandId, 'shipblu', 'connected');

  console.log(`[shipblu] sync done — orders_updated=${updatedCount} status=${statusResult}`);
}

/**
 * Handle an incoming ShipBlu webhook event.
 * Called from routes/webhooks.js after the X-Webhook-Secret header is verified.
 *
 * Logs the full raw payload on first receipt so the structure can be inspected
 * if the field names differ from what the API returns.
 */
function handleWebhook(brandId, payload) {
  // Log payload structure once to help diagnose field names in production
  console.log(`[shipblu] webhook event for brand=${brandId}:`, JSON.stringify(payload, null, 2));

  // ShipBlu webhook payloads may wrap the delivery order under different keys
  const order = payload.delivery_order || payload.shipment || payload.order || payload;

  const changes = updateOrderShipping(brandId, order);
  logSync(brandId, 'shipblu', 'success', null, changes);
  return changes;
}

module.exports = {
  testConnection,
  detectAuthScheme,
  fetchShipments,
  fullSync,
  handleWebhook,
  STATUS_MAP,
};
