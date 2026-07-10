'use strict';

/**
 * GET /api/debug/reconcile?brand_id=X&period=all
 *
 * Revenue reconciliation endpoint — RECON_ROUTE
 *
 * Returns raw DB ground truth identical to scripts/reconcile.js, but
 * accessible over HTTP so it can be called against the Railway production DB
 * without needing shell access.
 *
 * SECURITY: Protected by DEBUG_TOKEN env var.
 * Pass the token as: Authorization: Bearer <DEBUG_TOKEN>
 * or as query param: ?token=<DEBUG_TOKEN>
 *
 * This route is automatically disabled (404) when DEBUG_TOKEN is not set,
 * so it cannot accidentally be active in a misconfigured deployment.
 *
 * REMOVE OR GATE BEHIND ADMIN AUTH before scaling to multiple users.
 */

const express = require('express');
const router  = express.Router();
const { db }  = require('../db/db');

// ── Auth guard ────────────────────────────────────────────────────────────────
router.use((req, res, next) => {
  const token = process.env.DEBUG_TOKEN;
  // No token set → route doesn't exist (don't reveal it's here)
  if (!token) return res.status(404).json({ ok: false, error: 'Not found' });

  const provided = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.query.token;
  if (!provided || provided !== token) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
});

// ── Period helpers (mirror dashboard.js exactly) ──────────────────────────────
function periodStart(p) {
  const now = new Date();
  switch (p) {
    case 'today': return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    case '7d':    return new Date(Date.now() - 7  * 86400000).toISOString();
    case '30d':   return new Date(Date.now() - 30 * 86400000).toISOString();
    case 'ytd':   return new Date(now.getFullYear(), 0, 1).toISOString();
    default:      return null; // 'all'
  }
}

// ── Main reconciliation handler ────────────────────────────────────────────────
router.get('/reconcile', (req, res) => {
  const period   = req.query.period || 'all';
  let   brand_id = req.query.brand_id;

  // Default to first brand if not specified
  if (!brand_id) {
    const first = db.prepare('SELECT id FROM brands ORDER BY created_at ASC LIMIT 1').get();
    brand_id = first?.id;
  }
  if (!brand_id) {
    return res.status(404).json({ ok: false, error: 'No brands found' });
  }

  try {
    const since   = periodStart(period);
    const sinceMs = since ? new Date(since).getTime() : null;

    // ── LAYER 1: Raw SQL counts by source + status ──────────────────────────
    const bySourceStatus = db.prepare(`
      SELECT source, financial_status,
             COUNT(*) AS cnt,
             ROUND(SUM(total), 2) AS rev
      FROM orders_cache
      WHERE brand_id = ?
      GROUP BY source, financial_status
      ORDER BY source, financial_status
    `).all(brand_id);

    const sqlShopifyPaid = db.prepare(`
      SELECT COUNT(*) AS cnt, ROUND(SUM(total),2) AS rev
      FROM orders_cache WHERE brand_id=? AND source='shopify' AND financial_status='paid'
    `).get(brand_id);

    const sqlLocallyPaid = db.prepare(`
      SELECT COUNT(*) AS cnt, ROUND(SUM(total),2) AS rev
      FROM orders_cache WHERE brand_id=? AND source='locally' AND financial_status='paid'
    `).get(brand_id);

    const sqlCombinedPaid = db.prepare(`
      SELECT COUNT(*) AS cnt, ROUND(SUM(total),2) AS rev
      FROM orders_cache WHERE brand_id=? AND financial_status='paid'
    `).get(brand_id);

    // ── LAYER 2: Duplicate detection ────────────────────────────────────────
    const exactDups = db.prepare(`
      SELECT source, source_order_id, COUNT(*) AS cnt
      FROM orders_cache WHERE brand_id=?
      GROUP BY source, source_order_id
      HAVING cnt > 1
    `).all(brand_id);

    const nearDups = db.prepare(`
      SELECT source,
             SUBSTR(created_at,1,10) AS day,
             ROUND(total,0)          AS total_rounded,
             COUNT(*)                AS cnt,
             GROUP_CONCAT(SUBSTR(source_order_id,1,30),' | ') AS sample_ids
      FROM orders_cache
      WHERE brand_id=? AND financial_status='paid'
      GROUP BY source, day, total_rounded
      HAVING cnt > 1
      ORDER BY cnt DESC
      LIMIT 30
    `).all(brand_id);

    const nearDupRevLoss = nearDups.reduce((s, r) => s + (r.total_rounded * (r.cnt - 1)), 0);

    // Locally ID taxonomy
    const locallyIdTypes = db.prepare(`
      SELECT
        SUM(CASE WHEN source_order_id LIKE 'loc-%' THEN 1 ELSE 0 END) AS loc_count,
        SUM(CASE WHEN source_order_id LIKE 'imp-%' THEN 1 ELSE 0 END) AS imp_count,
        SUM(CASE WHEN source_order_id LIKE 'csv-%' THEN 1 ELSE 0 END) AS csv_count,
        SUM(CASE WHEN source_order_id NOT LIKE 'loc-%'
                  AND source_order_id NOT LIKE 'imp-%'
                  AND source_order_id NOT LIKE 'csv-%' THEN 1 ELSE 0 END) AS stable_count,
        ROUND(SUM(CASE WHEN source_order_id LIKE 'loc-%' THEN total ELSE 0 END),2) AS loc_rev,
        ROUND(SUM(CASE WHEN source_order_id LIKE 'imp-%' THEN total ELSE 0 END),2) AS imp_rev,
        ROUND(SUM(CASE WHEN source_order_id LIKE 'csv-%' THEN total ELSE 0 END),2) AS csv_rev,
        ROUND(SUM(CASE WHEN source_order_id NOT LIKE 'loc-%'
                        AND source_order_id NOT LIKE 'imp-%'
                        AND source_order_id NOT LIKE 'csv-%' THEN total ELSE 0 END),2) AS stable_rev
      FROM orders_cache WHERE brand_id=? AND source='locally'
    `).get(brand_id);

    // ── LAYER 3: JS-filtered totals (exact dashboard logic) ─────────────────
    const allPaid = db.prepare(
      "SELECT source, total, created_at FROM orders_cache WHERE brand_id=? AND financial_status='paid'"
    ).all(brand_id);

    const filtered = allPaid.filter(row => {
      if (!sinceMs) return true;
      if (!row.created_at) return false;
      const ts = new Date(row.created_at).getTime();
      return !isNaN(ts) && ts >= sinceMs;
    });

    const nullDatePaid    = allPaid.filter(r => !r.created_at).length;
    const invalidDatePaid = allPaid.filter(r => r.created_at && isNaN(new Date(r.created_at).getTime())).length;
    const excludedByDate  = allPaid.length - filtered.length;

    let shopifyRev = 0, shopifyCnt = 0;
    let locallyRev = 0, locallyCnt = 0;
    for (const r of filtered) {
      const t = parseFloat(r.total) || 0;
      if (r.source === 'shopify') { shopifyRev += t; shopifyCnt++; }
      if (r.source === 'locally') { locallyRev += t; locallyCnt++; }
    }

    // ── LAYER 4: Date distribution ───────────────────────────────────────────
    const yearlyRev = db.prepare(`
      SELECT SUBSTR(created_at,1,4) AS yr, source,
             COUNT(*) AS cnt, ROUND(SUM(total),2) AS rev
      FROM orders_cache
      WHERE brand_id=? AND financial_status='paid'
      GROUP BY yr, source ORDER BY yr DESC, source
    `).all(brand_id);

    const locallySample = db.prepare(`
      SELECT created_at FROM orders_cache
      WHERE brand_id=? AND source='locally'
      ORDER BY rowid DESC LIMIT 5
    `).all(brand_id).map(r => r.created_at);

    // ── Build response ───────────────────────────────────────────────────────
    res.json({
      ok: true,
      meta: { brand_id, period, since: since || 'all-time', generated_at: new Date().toISOString() },

      // Ground truth — what the API must match
      ground_truth: {
        shopify_revenue:  parseFloat(shopifyRev.toFixed(2)),
        shopify_orders:   shopifyCnt,
        locally_revenue:  parseFloat(locallyRev.toFixed(2)),
        locally_orders:   locallyCnt,
        combined_revenue: parseFloat((shopifyRev + locallyRev).toFixed(2)),
        combined_orders:  shopifyCnt + locallyCnt,
      },

      // Raw SQL (before JS date filter) — all-time paid
      sql_raw_paid: {
        shopify:  { orders: sqlShopifyPaid.cnt,  revenue: sqlShopifyPaid.rev  },
        locally:  { orders: sqlLocallyPaid.cnt,  revenue: sqlLocallyPaid.rev  },
        combined: { orders: sqlCombinedPaid.cnt, revenue: sqlCombinedPaid.rev },
      },

      // Row counts by source + financial_status
      by_source_status: bySourceStatus,

      // JS-filter diagnostics
      filter_diagnostics: {
        total_paid_rows_in_db: allPaid.length,
        rows_passing_js_filter: filtered.length,
        excluded_by_date_filter: excludedByDate,
        null_created_at: nullDatePaid,
        unparseable_created_at: invalidDatePaid,
      },

      // Duplicate analysis
      duplicates: {
        exact_id_duplicates: exactDups.length,
        exact_id_details: exactDups.slice(0, 20),
        same_day_same_total_groups: nearDups.length,
        estimated_double_counted_revenue: parseFloat(nearDupRevLoss.toFixed(2)),
        same_day_same_total_details: nearDups.slice(0, 20),
      },

      // Locally-specific ID taxonomy
      locally_id_taxonomy: locallyIdTypes,

      // Revenue by year
      revenue_by_year: yearlyRev,

      // Sample Locally date strings
      locally_created_at_sample: locallySample,
    });

  } catch (err) {
    console.error('[debug/reconcile] error:', err.message);
    res.status(500).json({ ok: false, error: 'Reconciliation failed', detail: err.message });
  }
});

module.exports = router;
