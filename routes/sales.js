'use strict';

/**
 * GET /api/:brand_id/sales?period=today|7d|30d|ytd|all
 *
 * Aggregates from orders_cache. Only counts paid orders.
 * Returns:
 *   total_revenue, order_count, avg_order_value,
 *   channel_split  { shopify: { revenue, count, pct }, locally: { ... } },
 *   daily_revenue  [ { date, revenue, orders } ]   — for the chart
 */

const express = require('express');
const router  = express.Router({ mergeParams: true });
const { db }  = require('../db/db');

/** Calculate the ISO8601 start date for a given period key. */
function periodStart(period) {
  const now = new Date();
  switch (period) {
    case 'today':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    case '7d':
      return new Date(Date.now() - 7  * 24 * 60 * 60 * 1000).toISOString();
    case '30d':
      return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    case 'ytd':
      return new Date(now.getFullYear(), 0, 1).toISOString();
    case 'all':
    default:
      return null;   // no date filter
  }
}

router.get('/', (req, res) => {
  const { brand_id }      = req.params;
  const period            = req.query.period || '7d';
  const since             = periodStart(period);

  // Base WHERE clause — only paid orders count as revenue
  const whereParts  = ["brand_id = ?", "financial_status = 'paid'"];
  const args        = [brand_id];
  if (since) { whereParts.push('created_at >= ?'); args.push(since); }
  const where = whereParts.join(' AND ');

  try {
    // ── Totals ─────────────────────────────────────────────────────────────
    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(total), 0)  AS total_revenue,
        COUNT(*)                 AS order_count,
        COALESCE(AVG(total), 0)  AS avg_order_value
      FROM orders_cache
      WHERE ${where}
    `).get(...args);

    // ── Channel split ──────────────────────────────────────────────────────
    const channelRows = db.prepare(`
      SELECT
        source,
        COALESCE(SUM(total), 0) AS revenue,
        COUNT(*)                AS count
      FROM orders_cache
      WHERE ${where}
      GROUP BY source
    `).all(...args);

    const channelMap = {};
    for (const row of channelRows) {
      channelMap[row.source] = {
        revenue: row.revenue,
        count:   row.count,
        pct:     totals.total_revenue > 0
          ? Math.round((row.revenue / totals.total_revenue) * 100)
          : 0,
      };
    }

    const channel_split = {
      shopify:  channelMap['shopify']  || { revenue: 0, count: 0, pct: 0 },
      locally:  channelMap['locally']  || { revenue: 0, count: 0, pct: 0 },
    };

    // ── Daily revenue (for chart) ──────────────────────────────────────────
    const daily_revenue = db.prepare(`
      SELECT
        date(created_at)        AS date,
        COALESCE(SUM(total), 0) AS revenue,
        COUNT(*)                AS orders
      FROM orders_cache
      WHERE ${where}
      GROUP BY date(created_at)
      ORDER BY date ASC
    `).all(...args);

    res.json({
      ok: true,
      period,
      since,
      total_revenue:    totals.total_revenue,
      order_count:      totals.order_count,
      avg_order_value:  Math.round(totals.avg_order_value),
      channel_split,
      daily_revenue,
    });

  } catch (err) {
    console.error('[sales] query error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
