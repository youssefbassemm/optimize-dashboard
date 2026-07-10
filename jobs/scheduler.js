'use strict';

/**
 * Background job scheduler
 *
 * ── Schedule ────────────────────────────────────────────────────────────────
 *   Every 1 minute    — process webhook retry queue (failed handlers)
 *   Every 6 hours     — Shopify incremental sync (orders updated since last_sync)
 *   Every 30 minutes  — Locally full sync
 *   Every 30 minutes  — ShipBlu shipment poll (supplements webhooks)
 *   Every 2 hours     — Meta Ads + Instagram sync
 *   Every Sunday 8:00 — Meta token expiry check
 *
 * ── Incremental sync ────────────────────────────────────────────────────────
 *   Shopify fullSync() reads integration.last_sync and passes it to
 *   fetchOrders() as the `updated_at` lower bound. On first connect
 *   (last_sync = NULL) the full history since 2020 is fetched. After each
 *   successful run last_sync is advanced to NOW, so subsequent 6-hour ticks
 *   only pull the delta — dramatically reducing API usage and sync time.
 *
 * ── Webhook queue ────────────────────────────────────────────────────────────
 *   When a Shopify webhook handler throws (DB lock, transient error, etc.)
 *   the payload is persisted to webhook_queue instead of being dropped.
 *   processWebhookQueue() retries pending jobs with exponential back-off
 *   (1 → 2 → 4 → 8 → 16 min). After 5 failed attempts the row is moved
 *   to 'dead' status for manual inspection.
 */

const cron = require('node-cron');
const { db, getPendingWebhooks, ackWebhook, failWebhook, deleteExpiredSessions, deleteExpiredResetTokens } = require('../db/db');
const shopify = require('../integrations/shopify');
const locally = require('../integrations/locally');
const shipblu = require('../integrations/shipblu');
const meta    = require('../integrations/meta');
const { runFeedbackRequestCron, runReEngagementCron } = require('../lib/cx_trigger');

// ── Pause log — TIER_SYSTEM ───────────────────────────────────────────────────
//
// When a brand's integration has sync_paused=1 (set by freezePaidIntegrations on
// tier downgrade), the scheduler skips it. To avoid log spam on every 30-minute
// tick, we log the skip ONCE per brand per platform per day, then suppress until
// UTC midnight resets the Set.
//
// Key format: "<brand_id>:<platform>"
// Reset: daily cron at 00:00 UTC (see startScheduler below).
//
const _pauseLoggedToday = new Set();

/**
 * Check whether a brand's integration is paused.
 * Returns true and emits one log line per brand per day if paused.
 * Callers should `continue` (skip sync) when this returns true.
 *
 * @param {string} brand_id
 * @param {string} platform  'locally' | 'shipblu' | 'meta'
 * @returns {boolean}
 */
function _checkPaused(brand_id, platform) {
  const row = db.prepare(
    'SELECT sync_paused FROM integrations WHERE brand_id = ? AND platform = ?'
  ).get(brand_id, platform);

  if (!row?.sync_paused) return false;

  const key = `${brand_id}:${platform}`;
  if (!_pauseLoggedToday.has(key)) {
    _pauseLoggedToday.add(key);
    console.log(
      `[scheduler] skipping ${platform} sync — brand=${brand_id} sync_paused=1 (tier downgraded)`
    );
  }
  return true;
}

// ── Webhook queue processor ────────────────────────────────────────────────────

/**
 * Retry up to 20 pending webhook jobs per tick.
 * Each job is attempted synchronously in sequence so we don't overwhelm the DB.
 */
async function processWebhookQueue() {
  const pending = getPendingWebhooks(20);
  if (!pending.length) return;

  console.log(`[scheduler] webhook queue: ${pending.length} pending job(s)`);

  for (const job of pending) {
    let payload;
    try {
      payload = JSON.parse(job.payload);
    } catch (_) {
      // Corrupted payload — move straight to dead rather than retrying forever
      failWebhook(job.id, 'JSON parse error — corrupted payload');
      continue;
    }

    try {
      await shopify.handleWebhook(job.brand_id, job.topic, payload);
      ackWebhook(job.id);
      console.log(
        `[scheduler] webhook queue: ✓ id=${job.id} topic=${job.topic}` +
        ` brand=${job.brand_id} (attempt ${(job.attempts || 0) + 1})`
      );
    } catch (err) {
      failWebhook(job.id, err.message);
      console.warn(
        `[scheduler] webhook queue: ✗ id=${job.id} topic=${job.topic}` +
        ` brand=${job.brand_id} attempt=${(job.attempts || 0) + 1}: ${err.message}`
      );
    }
  }
}

// ── Global pause check — ADMIN PHASE 3 ────────────────────────────────────────
//
// If an admin has set system_settings.syncs_paused_globally = '1', ALL scheduled
// sync functions are skipped for every brand until the flag is cleared. This is
// useful for maintenance windows or emergency rate-limit situations.
// The check is inlined into each syncAll* function (not a shared helper) so that
// the platform name appears in the log message.

function _isGloballyPaused(platform) {
  try {
    const row = db.prepare("SELECT value FROM system_settings WHERE key = 'syncs_paused_globally'").get();
    if (row?.value === '1') {
      console.log(`[scheduler] ${platform} sync skipped — syncs_paused_globally=1 (admin hold)`);
      return true;
    }
  } catch (_) {}
  return false;
}

// ── Per-platform sync helpers ──────────────────────────────────────────────────

async function syncAllShopify() {
  if (_isGloballyPaused('shopify')) return;
  console.log('[scheduler] running Shopify sync');
  const rows = db.prepare(
    "SELECT brand_id FROM integrations WHERE platform = 'shopify' AND status = 'connected'"
  ).all();
  for (const { brand_id } of rows) {
    try { await shopify.fullSync(brand_id); }
    catch (err) { console.error(`[scheduler] Shopify sync error brand=${brand_id}:`, err.message); }
  }
}

async function syncAllLocally() {
  if (_isGloballyPaused('locally')) return;
  console.log('[scheduler] running Locally sync');
  const rows = db.prepare(`
    SELECT brand_id FROM integrations
    WHERE platform = 'locally'
      AND status IN ('connected', 'warning')
  `).all();
  for (const { brand_id } of rows) {
    // TIER_SYSTEM — skip brands whose integration is frozen (sync_paused=1).
    // Logged once per brand per day; see _checkPaused / _pauseLoggedToday.
    if (_checkPaused(brand_id, 'locally')) continue;
    try { await locally.fullSync(brand_id); }
    catch (err) { console.error(`[scheduler] Locally sync error brand=${brand_id}:`, err.message); }
  }
}

async function syncAllShipBlu() {
  if (_isGloballyPaused('shipblu')) return;
  console.log('[scheduler] running ShipBlu sync');
  const rows = db.prepare(
    "SELECT brand_id FROM integrations WHERE platform = 'shipblu' AND status = 'connected'"
  ).all();
  for (const { brand_id } of rows) {
    // TIER_SYSTEM — skip frozen integrations (sync_paused=1 set on downgrade).
    if (_checkPaused(brand_id, 'shipblu')) continue;
    try { await shipblu.fullSync(brand_id); }
    catch (err) { console.error(`[scheduler] ShipBlu sync error brand=${brand_id}:`, err.message); }
  }
}

async function syncAllMeta() {
  if (_isGloballyPaused('meta')) return;
  console.log('[scheduler] running Meta sync');
  const rows = db.prepare(
    "SELECT brand_id FROM integrations WHERE platform = 'meta' AND status IN ('connected','warning')"
  ).all();
  for (const { brand_id } of rows) {
    // TIER_SYSTEM — Meta sync is paid-only (campaigns / ads data).
    // Free users can connect Meta for Instagram basic display, but the background
    // sync (which writes campaign_cache + ig_cache) is gated.
    if (_checkPaused(brand_id, 'meta')) continue;
    try { await meta.fullSync(brand_id); }
    catch (err) { console.error(`[scheduler] Meta sync error brand=${brand_id}:`, err.message); }
  }
}

/**
 * Trigger an immediate sync across ALL connected brands for one platform.
 * Called by POST /api/admin/system/global-sync.
 * Never throws — logs errors only.
 *
 * @param {string} platform  'shopify'|'locally'|'shipblu'|'meta'
 */
async function triggerGlobalSync(platform = 'shopify') {
  console.log(`[scheduler] global ${platform} sync triggered by admin`);
  try {
    if (platform === 'shopify') return await syncAllShopify();
    if (platform === 'locally') return await syncAllLocally();
    if (platform === 'shipblu') return await syncAllShipBlu();
    if (platform === 'meta')    return await syncAllMeta();
  } catch (err) {
    console.error(`[scheduler] triggerGlobalSync error (${platform}):`, err.message);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Trigger an immediate sync for one brand + platform.
 * Called by the integrations route right after credentials are saved.
 * Never throws — errors are logged only.
 */
async function triggerSync(brandId, platform = 'shopify') {
  console.log(`[scheduler] immediate ${platform} sync triggered for brand=${brandId}`);
  try {
    if (platform === 'shopify') return await shopify.fullSync(brandId);
    if (platform === 'locally') return await locally.fullSync(brandId);
    if (platform === 'shipblu') return await shipblu.fullSync(brandId);
    if (platform === 'meta')    return await meta.fullSync(brandId);
  } catch (err) {
    console.error(`[scheduler] triggerSync error (${platform}) brand=${brandId}:`, err.message);
  }
}

/**
 * Start all cron jobs. Call once from server.js on startup.
 * Every callback uses .catch() so a single brand failure cannot crash the process.
 */
function startScheduler() {
  // Webhook retry queue — every minute
  cron.schedule('* * * * *', () => {
    processWebhookQueue().catch((e) =>
      console.error('[scheduler] processWebhookQueue:', e.message)
    );
  });

  // Shopify — every 6 hours (incremental after first run)
  cron.schedule('0 */6 * * *', () => {
    syncAllShopify().catch((e) => console.error('[scheduler] syncAllShopify:', e.message));
  });

  // Locally — every 30 minutes
  cron.schedule('*/30 * * * *', () => {
    syncAllLocally().catch((e) => console.error('[scheduler] syncAllLocally:', e.message));
  });

  // ShipBlu polling — every 30 minutes
  cron.schedule('*/30 * * * *', () => {
    syncAllShipBlu().catch((e) => console.error('[scheduler] syncAllShipBlu:', e.message));
  });

  // Meta Ads + Instagram — every 2 hours
  cron.schedule('0 */2 * * *', () => {
    syncAllMeta().catch((e) => console.error('[scheduler] syncAllMeta:', e.message));
  });

  // Meta token refresh check — every Sunday 08:00
  cron.schedule('0 8 * * 0', () => {
    meta.checkTokenExpiry().catch((e) =>
      console.error('[scheduler] checkTokenExpiry (Meta):', e.message)
    );
  });

  // CX: feedback_request — every hour (checks orders delivered N hours ago)
  cron.schedule('0 * * * *', () => {
    runFeedbackRequestCron().catch((e) =>
      console.error('[scheduler] CX feedback_request:', e.message)
    );
  });

  // CX: re_engagement — every day at 10:00 (morning send)
  cron.schedule('0 10 * * *', () => {
    runReEngagementCron().catch((e) =>
      console.error('[scheduler] CX re_engagement:', e.message)
    );
  });

  // DB hygiene — every Sunday 09:00 (1 hour after token check, low-traffic window)
  // Removes expired sessions and used/expired password reset tokens.
  cron.schedule('0 9 * * 0', () => {
    try {
      const sessions = deleteExpiredSessions();
      const tokens   = deleteExpiredResetTokens();
      console.log(`[scheduler] hygiene: removed ${sessions.changes} expired sessions, ${tokens.changes} reset tokens`);
    } catch (err) {
      console.error('[scheduler] hygiene error:', err.message);
    }
  });

  // TIER_SYSTEM — pause-log reset at UTC midnight.
  // _pauseLoggedToday tracks which brand:platform pairs have already had their
  // "skipping sync — sync_paused=1" line emitted today. Clearing at midnight
  // means each brand gets at most one log line per platform per calendar day,
  // regardless of how many 30-minute ticks fire while they remain downgraded.
  // node-cron v3: options go as 3rd arg — cron.schedule(expr, callback, options)
  cron.schedule('0 0 * * *', () => {
    const count = _pauseLoggedToday.size;
    _pauseLoggedToday.clear();
    if (count > 0) {
      console.log(`[scheduler] pause log reset — cleared ${count} suppressed-log entries (UTC midnight)`);
    }
  });

  console.log('[scheduler] started');
  console.log('  • Webhook queue    — every 1 minute (retry failed webhooks)');
  console.log('  • Shopify          — every 6 hours  (incremental)');
  console.log('  • Locally          — every 30 minutes (PAID — skipped if sync_paused=1)');
  console.log('  • ShipBlu poll     — every 30 minutes (PAID — skipped if sync_paused=1)');
  console.log('  • Meta Ads/IG      — every 2 hours    (PAID — skipped if sync_paused=1)');
  console.log('  • Meta token       — every Sunday 08:00');
  console.log('  • DB hygiene       — every Sunday 09:00 (expired sessions + tokens)');
  console.log('  • Pause log        — cleared daily at 00:00 UTC');
  console.log('  • CX feedback_req  — every hour (post-delivery 24h+ feedback)');
  console.log('  • CX re_engage     — daily 10:00 (30-day inactive customers)');
}

module.exports = { startScheduler, triggerSync, triggerGlobalSync };
