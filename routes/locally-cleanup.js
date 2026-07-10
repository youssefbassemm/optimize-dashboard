'use strict';

// DEBUG_LOCALLY_CLEANUP — temporary cleanup endpoint
// POST /api/:brand_id/debug/locally-cleanup
// Removes imp-* and csv-* Locally rows for the authenticated brand only.
// NEVER touches loc-* rows, shopify rows, or any other brand's data.

const express = require('express');
const router  = express.Router({ mergeParams: true });
const { db }  = require('../db/db');

// Create cleanup_log table if it does not exist (idempotent at startup)
db.prepare(`
  CREATE TABLE IF NOT EXISTS cleanup_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id        TEXT    NOT NULL,
    timestamp       TEXT    NOT NULL DEFAULT (datetime('now')),
    rows_deleted    INTEGER NOT NULL DEFAULT 0,
    revenue_removed REAL    NOT NULL DEFAULT 0,
    executed_by     TEXT
  )
`).run();

router.post('/locally-cleanup', (req, res) => { // DEBUG_LOCALLY_CLEANUP
  const { brand_id } = req.params;

  // Default to dry_run=true — caller must explicitly pass dry_run:false to delete
  const dry_run = req.body?.dry_run !== false;

  try {
    // Count and sum the imp-*/csv-* rows for this brand (used for dry_run preview)
    const preview = db.prepare(`
      SELECT COUNT(*) AS cnt,
             ROUND(COALESCE(SUM(total), 0), 2) AS rev
      FROM   orders_cache
      WHERE  brand_id          = ?
        AND  source            = 'locally'
        AND  (source_order_id LIKE 'imp-%' OR source_order_id LIKE 'csv-%')
    `).get(brand_id);

    if (dry_run) {
      return res.json({
        ok:                true,
        dry_run:           true,
        rows_to_delete:    preview?.cnt  || 0,
        revenue_to_remove: parseFloat((preview?.rev || 0).toFixed(2)),
      });
    }

    // ── Live delete — fully transactional ────────────────────────────────────
    const executed_by = req.user?.email || req.user?.id || 'unknown';

    const doCleanup = db.transaction(() => {
      // Re-read counts inside the transaction for accuracy
      const snapshot = db.prepare(`
        SELECT COUNT(*) AS cnt,
               ROUND(COALESCE(SUM(total), 0), 2) AS rev
        FROM   orders_cache
        WHERE  brand_id          = ?
          AND  source            = 'locally'
          AND  (source_order_id LIKE 'imp-%' OR source_order_id LIKE 'csv-%')
      `).get(brand_id);

      const result = db.prepare(`
        DELETE FROM orders_cache
        WHERE  brand_id          = ?
          AND  source            = 'locally'
          AND  (source_order_id LIKE 'imp-%' OR source_order_id LIKE 'csv-%')
      `).run(brand_id);

      const rev = parseFloat((snapshot?.rev || 0).toFixed(2));

      db.prepare(`
        INSERT INTO cleanup_log (brand_id, rows_deleted, revenue_removed, executed_by)
        VALUES (?, ?, ?, ?)
      `).run(brand_id, result.changes, rev, executed_by);

      return { rows_deleted: result.changes, revenue_removed: rev };
    });

    const { rows_deleted, revenue_removed } = doCleanup();

    console.log(
      `[locally-cleanup] brand=${brand_id} deleted=${rows_deleted} revenue=${revenue_removed} by=${executed_by}`
    );

    return res.json({
      ok:              true,
      dry_run:         false,
      rows_deleted,
      revenue_removed,
    });

  } catch (err) {
    console.error('[locally-cleanup] error:', err.message);
    return res.status(500).json({ ok: false, error: 'Cleanup failed', detail: err.message });
  }
});

module.exports = router;
