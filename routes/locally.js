'use strict';

/**
 * /api/:brand_id/locally
 *
 * POST /sync     — trigger an immediate Locally sync and wait for result
 * POST /upload   — import orders from a CSV file
 * GET  /template — download a blank CSV template
 * GET  /status   — current integration status + latest sync log
 */

const express  = require('express');
const multer   = require('multer');
const router   = express.Router({ mergeParams: true });
const locally  = require('../integrations/locally');
const { db, getIntegration, getIntegrationHealth, getLastSyncLog } = require('../db/db');

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },   // 10 MB — Locally exports can be large
  fileFilter: (_req, file, cb) => {
    const name  = file.originalname.toLowerCase();
    const mime  = file.mimetype;
    const isCSV = mime === 'text/csv' || mime === 'application/vnd.ms-excel'
               || mime === 'text/plain' || mime === 'application/octet-stream'
               || name.endsWith('.csv') || name.endsWith('.txt');
    if (isCSV) cb(null, true);
    else cb(new Error('Only CSV files are accepted (.csv or .txt)'));
  },
});

// ── POST /api/:brand_id/locally/sync ─────────────────────────────────────────
// Runs a full sync and waits for it to complete before responding.
// This allows the UI to know the actual outcome immediately.
router.post('/sync', async (req, res) => {
  const { brand_id } = req.params;

  const integration = getIntegration(brand_id, 'locally');
  if (!integration) {
    return res.status(400).json({ ok: false, error: 'Locally integration not found — connect it first in Settings' });
  }
  if (integration.status === 'disconnected') {
    return res.status(400).json({ ok: false, error: 'Locally integration is disconnected — reconnect it in Settings' });
  }

  try {
    // Run synchronously so the response carries the actual result
    await locally.fullSync(brand_id);

    // Read back the result from DB
    const log    = getLastSyncLog(brand_id, 'locally');
    const health = getIntegrationHealth(brand_id, 'locally');

    if (log?.status === 'success' || log?.status === 'partial') {
      return res.json({
        ok:            true,
        status:        log.status,
        records_synced: log.records_synced || 0,
        message:       log.status === 'partial'
          ? `Partial sync: ${log.records_synced} records — ${log.error_message || ''}`
          : `Sync complete — ${log.records_synced} records synced`,
        health,
      });
    }

    // Sync ran but failed
    const errMsg = log?.error_message || 'Sync failed — check credentials';
    return res.json({
      ok:      false,
      status:  'error',
      error:   errMsg,
      health,
    });

  } catch (err) {
    console.error(`[locally/sync] unhandled error brand=${brand_id}:`, err.message);
    return res.status(500).json({ ok: false, error: `Sync error: ${err.message}` });
  }
});

// ── GET /api/:brand_id/locally/status ────────────────────────────────────────
// Returns current integration status, latest sync log, and order counts.
// Used by the UI to poll after a sync.
router.get('/status', (req, res) => {
  const { brand_id } = req.params;
  try {
    const integration = getIntegration(brand_id, 'locally');
    const log         = getLastSyncLog(brand_id, 'locally');
    const health      = getIntegrationHealth(brand_id, 'locally');

    const counts = db.prepare(`
      SELECT
        COUNT(*) AS order_count,
        COALESCE(SUM(total), 0) AS total_revenue
      FROM orders_cache
      WHERE brand_id = ? AND source = 'locally'
    `).get(brand_id);

    const invCount = db.prepare(
      "SELECT COUNT(*) AS cnt FROM inventory_cache WHERE brand_id = ? AND source = 'locally'"
    ).get(brand_id);

    res.json({
      ok: true,
      connected:      integration?.status === 'connected',
      status:         integration?.status || 'disconnected',
      last_sync:      integration?.last_sync || null,
      health,
      last_log:       log ? { status: log.status, records: log.records_synced, error: log.error_message, at: log.synced_at } : null,
      db_counts: {
        orders:    counts?.order_count   || 0,
        revenue:   counts?.total_revenue || 0,
        inventory: invCount?.cnt         || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/:brand_id/locally/upload ───────────────────────────────────────
router.post('/upload', upload.single('file'), (req, res) => {
  const { brand_id } = req.params;

  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'No file uploaded — send field name "file"' });
  }

  try {
    const result = locally.importCSV(brand_id, req.file.buffer);
    res.json({
      ok:     true,
      count:  result.count,
      errors: result.errors,
      message: result.errors.length
        ? `Imported ${result.count} orders with ${result.errors.length} row error(s)`
        : `Imported ${result.count} orders successfully`,
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ── POST /api/:brand_id/locally/import ───────────────────────────────────────
// Accepts a CSV exported directly from the Locally EG portal.
// Auto-detects column headers — no specific format required beyond a date
// column and a total/amount column.
// Security: protected by requireBrandOwnership at server.js mount point.
//           brand_id is always from req.params, never from file content.
//           File is held entirely in memory via multer.memoryStorage().
router.post('/import', upload.single('file'), async (req, res) => {
  const { brand_id } = req.params;

  if (!req.file) {
    return res.status(400).json({
      ok:    false,
      error: 'No file uploaded — send field name "file" as multipart/form-data',
    });
  }

  try {
    const result = locally.importLocallyExport(brand_id, req.file.buffer);

    // Human-readable summary
    let message;
    if (result.imported === 0 && result.errors.length > 0) {
      message = `Import failed — 0 of ${result.found} rows could be imported (${result.errors.length} error(s))`;
    } else if (result.errors.length > 0) {
      message = `Partial import — ${result.imported} of ${result.found} rows ` +
                `(${result.new_rows} new, ${result.updated_rows} updated, ${result.errors.length} error(s))`;
    } else {
      message = `Import complete — ${result.imported} of ${result.found} rows ` +
                `(${result.new_rows} new, ${result.updated_rows} updated)`;
    }

    return res.json({
      ok:               true,
      message,
      found:            result.found,
      imported:         result.imported,
      new_rows:         result.new_rows,
      updated_rows:     result.updated_rows,
      errors:           result.errors,
      has_stable_id:    result.has_stable_id,
      id_column:        result.id_column,
      detected_columns: result.detected_columns,
      warnings:         result.warnings,
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

// ── GET /api/:brand_id/locally/debug ─────────────────────────────────────────
// Diagnostic endpoint: inspect the exact DB state for Locally orders on Railway
// without needing a Bash session. Never returns PII — only aggregated counts.
router.get('/debug', (req, res) => {
  const { brand_id } = req.params;
  try {
    // Total row count + financial_status breakdown
    const statusBreakdown = db.prepare(`
      SELECT financial_status, COUNT(*) AS cnt, COALESCE(SUM(total),0) AS revenue
      FROM orders_cache
      WHERE brand_id = ? AND source = 'locally'
      GROUP BY financial_status
    `).all(brand_id);

    // Date range of stored rows
    const dateRange = db.prepare(`
      SELECT
        MIN(created_at) AS oldest,
        MAX(created_at) AS newest,
        COUNT(*)         AS total
      FROM orders_cache
      WHERE brand_id = ? AND source = 'locally'
    `).get(brand_id);

    // ID-type distribution
    const idTypes = db.prepare(`
      SELECT
        COUNT(CASE WHEN source_order_id LIKE 'loc-%' THEN 1 END) AS loc_hash,
        COUNT(CASE WHEN source_order_id LIKE 'imp-%' THEN 1 END) AS imp_hash,
        COUNT(CASE WHEN source_order_id LIKE 'csv-%' THEN 1 END) AS csv_hash,
        COUNT(CASE WHEN source_order_id NOT LIKE 'loc-%'
                        AND source_order_id NOT LIKE 'imp-%'
                        AND source_order_id NOT LIKE 'csv-%' THEN 1 END) AS stable
      FROM orders_cache
      WHERE brand_id = ? AND source = 'locally'
    `).get(brand_id);

    // Sample of 5 most-recent rows (no PII — just IDs, dates, totals, status)
    const sample = db.prepare(`
      SELECT source_order_id, created_at, total, financial_status
      FROM orders_cache
      WHERE brand_id = ? AND source = 'locally'
      ORDER BY created_at DESC
      LIMIT 5
    `).all(brand_id);

    // Paid orders per period (to show what each period filter would return)
    const paidByPeriod = {};
    const now = new Date();
    const periods = {
      today: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
      '7d':  new Date(Date.now() - 7  * 86400000).toISOString(),
      '30d': new Date(Date.now() - 30 * 86400000).toISOString(),
      ytd:   new Date(now.getFullYear(), 0, 1).toISOString(),
      all:   null,
    };
    for (const [label, since] of Object.entries(periods)) {
      const q = since
        ? db.prepare(`SELECT COUNT(*) AS cnt, COALESCE(SUM(total),0) AS rev FROM orders_cache WHERE brand_id=? AND source='locally' AND financial_status='paid' AND created_at >= ?`).get(brand_id, since)
        : db.prepare(`SELECT COUNT(*) AS cnt, COALESCE(SUM(total),0) AS rev FROM orders_cache WHERE brand_id=? AND source='locally' AND financial_status='paid'`).get(brand_id);
      paidByPeriod[label] = { count: q.cnt, revenue: q.rev };
    }

    // Integration row
    const integration = db.prepare(
      "SELECT status, last_sync, health, locally_imported_at FROM integrations WHERE brand_id=? AND platform='locally'"
    ).get(brand_id);

    res.json({
      ok: true,
      brand_id,
      status_breakdown:    statusBreakdown,
      date_range:          dateRange,
      id_type_breakdown:   idTypes,
      paid_by_period:      paidByPeriod,
      recent_sample:       sample,
      integration:         integration || null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/:brand_id/locally/template ──────────────────────────────────────
router.get('/template', (_req, res) => {
  const header  = 'date,customer_name,phone,city,items,total,payment_method';
  const example = '2025-01-15,Ahmed Mohamed,01012345678,Cairo,Blue Hoodie x 2 @ 750;Black Cap x 1 @ 350,1850,cash';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="locally_orders_template.csv"');
  res.send(`${header}\n${example}\n`);
});

// ── Multer error handler ──────────────────────────────────────────────────────
router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError || err.message) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  res.status(500).json({ ok: false, error: 'Upload failed' });
});

module.exports = router;
