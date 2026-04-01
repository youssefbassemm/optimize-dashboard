'use strict';

/**
 * Background job scheduler.
 *
 * Schedule:
 *   Every 6 hours   — full Shopify sync for every connected brand
 *   Every 30 min    — full Locally sync for every connected brand
 *   Every 30 min    — ShipBlu shipment poll (supplements webhooks)
 *   Every 2 hours   — Meta Ads + Instagram sync
 *   Every Sunday    — Meta token expiry check + auto-refresh
 *
 * Note: ShipBlu uses a permanent API key — no token expiry job needed.
 */

const cron    = require('node-cron');
const { db }  = require('../db/db');
const shopify = require('../integrations/shopify');
const locally = require('../integrations/locally');
const shipblu = require('../integrations/shipblu');
const meta    = require('../integrations/meta');

// ── Per-platform sync helpers ─────────────────────────────────────────────────

async function syncAllShopify() {
  console.log('[scheduler] running scheduled Shopify sync');
  const rows = db.prepare(
    "SELECT brand_id FROM integrations WHERE platform = 'shopify' AND status = 'connected'"
  ).all();
  for (const { brand_id } of rows) {
    try { await shopify.fullSync(brand_id); }
    catch (err) { console.error(`[scheduler] Shopify sync error brand=${brand_id}:`, err.message); }
  }
}

async function syncAllLocally() {
  console.log('[scheduler] running scheduled Locally sync');
  const rows = db.prepare(
    "SELECT brand_id FROM integrations WHERE platform = 'locally' AND status IN ('connected','warning')"
  ).all();
  for (const { brand_id } of rows) {
    try { await locally.fullSync(brand_id); }
    catch (err) { console.error(`[scheduler] Locally sync error brand=${brand_id}:`, err.message); }
  }
}

async function syncAllShipBlu() {
  console.log('[scheduler] running scheduled ShipBlu sync');
  // Only 'connected' — ShipBlu has no 'warning' state (permanent API key, no expiry)
  const rows = db.prepare(
    "SELECT brand_id FROM integrations WHERE platform = 'shipblu' AND status = 'connected'"
  ).all();
  for (const { brand_id } of rows) {
    try { await shipblu.fullSync(brand_id); }
    catch (err) { console.error(`[scheduler] ShipBlu sync error brand=${brand_id}:`, err.message); }
  }
}

async function syncAllMeta() {
  console.log('[scheduler] running scheduled Meta sync');
  const rows = db.prepare(
    "SELECT brand_id FROM integrations WHERE platform = 'meta' AND status IN ('connected','warning')"
  ).all();
  for (const { brand_id } of rows) {
    try { await meta.fullSync(brand_id); }
    catch (err) { console.error(`[scheduler] Meta sync error brand=${brand_id}:`, err.message); }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Trigger an immediate sync for a single brand and platform.
 * Called by the integrations route right after credentials are saved.
 */
async function triggerSync(brandId, platform = 'shopify') {
  console.log(`[scheduler] immediate ${platform} sync triggered for brand=${brandId}`);
  if (platform === 'shopify')  return shopify.fullSync(brandId);
  if (platform === 'locally')  return locally.fullSync(brandId);
  if (platform === 'shipblu')  return shipblu.fullSync(brandId);
  if (platform === 'meta')     return meta.fullSync(brandId);
}

/**
 * Start all scheduled jobs.
 * Call this once from server.js on startup.
 */
function startScheduler() {
  // Shopify — every 6 hours
  cron.schedule('0 */6 * * *', () => {
    syncAllShopify().catch((e) => console.error('[scheduler] syncAllShopify:', e.message));
  });

  // Locally — every 30 minutes
  cron.schedule('*/30 * * * *', () => {
    syncAllLocally().catch((e) => console.error('[scheduler] syncAllLocally:', e.message));
  });

  // ShipBlu polling — every 30 minutes (supplements webhooks)
  cron.schedule('*/30 * * * *', () => {
    syncAllShipBlu().catch((e) => console.error('[scheduler] syncAllShipBlu:', e.message));
  });

  // Meta Ads + Instagram — every 2 hours
  cron.schedule('0 */2 * * *', () => {
    syncAllMeta().catch((e) => console.error('[scheduler] syncAllMeta:', e.message));
  });

  // Meta token refresh check — every Sunday at 08:00
  cron.schedule('0 8 * * 0', () => {
    meta.checkTokenExpiry().catch((e) => console.error('[scheduler] checkTokenExpiry (Meta):', e.message));
  });

  console.log('[scheduler] started');
  console.log('  • Shopify      — every 6 hours');
  console.log('  • Locally      — every 30 minutes');
  console.log('  • ShipBlu poll — every 30 minutes');
  console.log('  • Meta Ads/IG  — every 2 hours');
  console.log('  • Meta token   — every Sunday 08:00');
}

module.exports = { startScheduler, triggerSync };
