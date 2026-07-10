'use strict';

/**
 * /api/admin/system — system health + manual control endpoints.
 * All routes protected by requireAdminAuth (applied in server.js).
 *
 * GET  /api/admin/system/health
 *   Returns aggregated health data for 6 dashboard cards.
 *   Auto-polled every 30s by the admin System tab.
 *
 * POST /api/admin/system/pause-syncs
 *   Sets system_settings.syncs_paused_globally = '1'.
 *   Scheduler checks this flag on every tick and skips all syncAll* calls.
 *
 * POST /api/admin/system/resume-syncs
 *   Sets system_settings.syncs_paused_globally = '0'.
 *
 * POST /api/admin/system/sync-brand
 *   Body: { brand_id, platform }
 *   Triggers an immediate sync for one brand + platform.
 *
 * POST /api/admin/system/global-sync
 *   Body: { platform? }   (omit to sync all platforms)
 *   Triggers an immediate sync across all connected brands.
 *
 * GET  /api/admin/system/export
 *   Query: type = 'brands' | 'events' | 'tier_changes'
 *   Returns a CSV file (Content-Disposition: attachment).
 *
 * POST /api/admin/system/fire-event
 *   Body: { brand_id, event_name, payload? }
 *   Manually inserts an event row (for testing / backfilling).
 *
 * POST /api/admin/system/vacuum-db
 *   Runs VACUUM on the SQLite database to reclaim freed pages.
 *   Can take a few seconds on large databases — runs synchronously.
 */

const express   = require('express');
const router    = express.Router();
const db        = require('../db/db');
const scheduler = require('../jobs/scheduler');

// ── GET /api/admin/system/health ──────────────────────────────────────────────
router.get('/health', (req, res) => {
  try {
    const health = db.getSystemHealth();
    return res.json({ ok: true, health, fetched_at: new Date().toISOString() });
  } catch (err) {
    console.error('[admin-system] health error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to load health data' });
  }
});

// ── POST /api/admin/system/pause-syncs ────────────────────────────────────────
router.post('/pause-syncs', (req, res) => {
  try {
    db.setSystemSetting('syncs_paused_globally', '1');
    console.log('[admin-system] global sync paused by admin');
    return res.json({ ok: true, syncs_paused_globally: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/admin/system/resume-syncs ───────────────────────────────────────
router.post('/resume-syncs', (req, res) => {
  try {
    db.setSystemSetting('syncs_paused_globally', '0');
    console.log('[admin-system] global sync resumed by admin');
    return res.json({ ok: true, syncs_paused_globally: false });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/admin/system/sync-brand ─────────────────────────────────────────
router.post('/sync-brand', async (req, res) => {
  const { brand_id, platform } = req.body || {};
  if (!brand_id || !platform) {
    return res.status(400).json({ ok: false, error: 'brand_id and platform are required' });
  }
  const validPlatforms = ['shopify', 'locally', 'shipblu', 'meta'];
  if (!validPlatforms.includes(platform)) {
    return res.status(400).json({ ok: false, error: `platform must be one of: ${validPlatforms.join(', ')}` });
  }
  const brand = db.getBrand(brand_id);
  if (!brand) {
    return res.status(404).json({ ok: false, error: `Brand "${brand_id}" not found` });
  }

  try {
    db.insertEvent(brand_id, null, 'admin_tool_action', { action: 'sync_brand', platform, by: 'admin' });
    // Fire-and-forget — triggerSync never throws
    scheduler.triggerSync(brand_id, platform);
    console.log(`[admin-system] sync triggered brand=${brand_id} platform=${platform}`);
    return res.json({ ok: true, brand_id, platform, message: 'Sync triggered — check logs for progress' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/admin/system/global-sync ────────────────────────────────────────
router.post('/global-sync', async (req, res) => {
  const { platform } = req.body || {};
  const validPlatforms = ['shopify', 'locally', 'shipblu', 'meta'];

  if (platform && !validPlatforms.includes(platform)) {
    return res.status(400).json({ ok: false, error: `platform must be one of: ${validPlatforms.join(', ')}` });
  }

  const platforms = platform ? [platform] : validPlatforms;

  try {
    // Fire-and-forget for each platform
    platforms.forEach(p => scheduler.triggerGlobalSync(p));

    console.log(`[admin-system] global sync triggered platforms=${platforms.join(',')}`);
    return res.json({ ok: true, platforms, message: 'Global sync triggered — check logs for progress' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/admin/system/export ──────────────────────────────────────────────
router.get('/export', (req, res) => {
  const { type } = req.query;

  function csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function toCSV(headers, rows) {
    const headerLine = headers.map(csvEscape).join(',');
    const dataLines  = rows.map(r => headers.map(h => csvEscape(r[h])).join(','));
    return [headerLine, ...dataLines].join('\r\n');
  }

  try {
    let filename, csv;

    if (type === 'brands') {
      const rows = db.db.prepare(`
        SELECT
          b.id, b.name, b.slug, b.tier, b.onboarded, b.revenue_range, b.ig_handle,
          b.created_at, b.last_seen_at, b.onboarded_at,
          u.name  AS owner_name,
          u.email AS owner_email,
          u.phone AS owner_phone,
          (SELECT COUNT(*) FROM integrations i WHERE i.brand_id=b.id AND i.status IN ('connected','warning')) AS integrations_count
        FROM brands b
        LEFT JOIN user_brands ub ON ub.brand_id=b.id AND ub.role='owner'
        LEFT JOIN users u ON u.id=ub.user_id
        GROUP BY b.id
        ORDER BY b.created_at DESC
      `).all();
      filename = 'brands-export.csv';
      csv = toCSV([
        'id','name','slug','tier','onboarded','revenue_range','ig_handle',
        'created_at','last_seen_at','onboarded_at',
        'owner_name','owner_email','owner_phone','integrations_count',
      ], rows);

    } else if (type === 'events') {
      const rows = db.db.prepare(`
        SELECT e.id, e.brand_id, b.name AS brand_name, e.event_name, e.payload, e.created_at
        FROM events e
        JOIN brands b ON b.id = e.brand_id
        ORDER BY e.created_at DESC
        LIMIT 10000
      `).all();
      filename = 'events-export.csv';
      csv = toCSV(['id','brand_id','brand_name','event_name','payload','created_at'], rows);

    } else if (type === 'tier_changes') {
      const rows = db.db.prepare(`
        SELECT tc.id, tc.brand_id, b.name AS brand_name,
               tc.old_tier, tc.new_tier, tc.changed_by, tc.note, tc.changed_at
        FROM tier_changes tc
        JOIN brands b ON b.id = tc.brand_id
        ORDER BY tc.changed_at DESC
      `).all();
      filename = 'tier-changes-export.csv';
      csv = toCSV(['id','brand_id','brand_name','old_tier','new_tier','changed_by','note','changed_at'], rows);

    } else {
      return res.status(400).json({ ok: false, error: 'type must be brands, events, or tier_changes' });
    }

    console.log(`[admin-system] CSV export type=${type}`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(csv);

  } catch (err) {
    console.error('[admin-system] export error:', err.message);
    return res.status(500).json({ ok: false, error: 'Export failed: ' + err.message });
  }
});

// ── POST /api/admin/system/fire-event ─────────────────────────────────────────
router.post('/fire-event', (req, res) => {
  const { brand_id, event_name, payload } = req.body || {};
  if (!brand_id || !event_name) {
    return res.status(400).json({ ok: false, error: 'brand_id and event_name are required' });
  }
  const brand = db.getBrand(brand_id);
  if (!brand) {
    return res.status(404).json({ ok: false, error: `Brand "${brand_id}" not found` });
  }

  try {
    const merged = Object.assign({}, payload || {}, { fired_by: 'admin' });
    db.insertEvent(brand_id, null, event_name, merged);
    console.log(`[admin-system] event fired brand=${brand_id} event=${event_name}`);
    return res.json({ ok: true, brand_id, event_name });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/admin/system/vacuum-db ─────────────────────────────────────────
router.post('/vacuum-db', (req, res) => {
  try {
    const start = Date.now();
    db.db.exec('VACUUM');
    const ms = Date.now() - start;
    console.log(`[admin-system] VACUUM completed in ${ms}ms`);
    return res.json({ ok: true, duration_ms: ms, message: `Database vacuumed in ${ms}ms` });
  } catch (err) {
    console.error('[admin-system] vacuum error:', err.message);
    return res.status(500).json({ ok: false, error: 'VACUUM failed: ' + err.message });
  }
});

module.exports = router;
