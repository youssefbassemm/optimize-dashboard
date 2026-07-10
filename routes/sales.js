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
const { db, getIntegrationHealth } = require('../db/db');

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

// Map frontend period names to backend keys
function normalisePeriod(p) {
  const map = { week: '7d', month: '30d', year: 'ytd' };
  return map[p] || p || '7d';
}

router.get('/', (req, res) => {
  const { brand_id }      = req.params;
  const period            = normalisePeriod(req.query.period || '7d');
  const since             = periodStart(period);

  // DATE_FILTER_JS — filter in JS, not SQL (mirrors dashboard.js).
  //
  // The Locally integration historically stored created_at in non-ISO formats
  // ("31 Dec 2025, 04:30 pm") that make SQLite string comparison unreliable.
  // Example: "31 Dec..." >= "2026-04-..." evaluates TRUE ('3' > '2') even for
  // a December order — so old Locally rows would pass a 7-day filter they
  // shouldn't. Fetching all paid rows and filtering with new Date() in JS
  // handles any parseable date string correctly.
  //
  // Performance note: acceptable at current scale. If orders_cache exceeds ~100k
  // rows, run migrate-created-at.js to normalise all dates, then revert to SQL.

  try {
    const sinceMs = since ? new Date(since).getTime() : null;

    // Pull all paid rows for this brand, then filter by date in JS
    const allPaidRows = db.prepare(`
      SELECT source, financial_status, total, total_items, created_at, source_order_id
      FROM orders_cache
      WHERE brand_id = ? AND financial_status = 'paid'
    `).all(brand_id);

    const rows = allPaidRows.filter(row => {
      if (!sinceMs) return true;                          // 'all' — no date bound
      if (!row.created_at) return false;                  // undated → exclude
      const ts = new Date(row.created_at).getTime();
      return !isNaN(ts) && ts >= sinceMs;
    });

    // ── Totals ─────────────────────────────────────────────────────────────
    let totalRevenue = 0, orderCount = 0;
    for (const r of rows) { totalRevenue += parseFloat(r.total) || 0; orderCount++; }
    const avgOrderValue = orderCount > 0 ? totalRevenue / orderCount : 0;

    // ── Channel split ──────────────────────────────────────────────────────
    const channelAgg = {};
    for (const r of rows) {
      const src = r.source || 'unknown';
      if (!channelAgg[src]) channelAgg[src] = { revenue: 0, count: 0, units_sold: 0 };
      channelAgg[src].revenue    += parseFloat(r.total) || 0;
      channelAgg[src].count      += 1;
      channelAgg[src].units_sold += (r.total_items > 0 ? r.total_items : 1);
    }

    // Shim: satisfy the rest of the route which expects channelRows format
    const channelRows = Object.entries(channelAgg).map(([source, v]) => ({
      source,
      revenue:    v.revenue,
      count:      v.count,
      units_sold: v.units_sold,
    }));

    // Legacy totals shim for downstream code
    const totals = { total_revenue: totalRevenue, order_count: orderCount, avg_order_value: avgOrderValue };

    const channelMap = {};
    for (const row of channelRows) {
      channelMap[row.source] = {
        revenue:    row.revenue,
        count:      row.count,
        units_sold: row.units_sold,
        pct:        totals.total_revenue > 0
          ? Math.round((row.revenue / totals.total_revenue) * 100)
          : 0,
      };
    }

    // ── Locally data-quality signal ────────────────────────────────────────
    // Row-ID taxonomy:
    //   loc-{hash}  — /orders line-item hash (current primary source)
    //   imp-{hash}  — import file without order-number column
    //   csv-{…}     — legacy manual CSV import
    //   other       — order_name from old fetchOrderHistory approach (cleaned up)
    let locallyDataQuality = 'none';
    let locallyImportedAt  = null;

    if ((channelMap['locally']?.count || 0) > 0) {
      // Use the already-filtered JS rows (same date window, no SQL string comparison)
      const locallyRows = rows.filter(r => r.source === 'locally');
      let stableCount = 0, importHashCount = 0, locCount = 0;
      for (const r of locallyRows) {
        const id = r.source_order_id || '';
        if (id.startsWith('loc-'))       locCount++;
        else if (id.startsWith('imp-') || id.startsWith('csv-')) importHashCount++;
        else                             stableCount++;
      }
      if      (stableCount      > 0) locallyDataQuality = 'stable';
      else if (importHashCount  > 0) locallyDataQuality = 'hash_import';
      else if (locCount         > 0) locallyDataQuality = 'api_hash';

      // Read locally_imported_at from the integrations table
      try {
        const intRow = db.prepare(
          "SELECT locally_imported_at FROM integrations WHERE brand_id = ? AND platform = 'locally'"
        ).get(brand_id);
        locallyImportedAt = intRow?.locally_imported_at || null;
      } catch (_) {}
    }

    const channel_split = {
      shopify: channelMap['shopify'] || { revenue: 0, count: 0, units_sold: 0, pct: 0 },
      locally: {
        ...(channelMap['locally'] || { revenue: 0, count: 0, units_sold: 0, pct: 0 }),
        data_quality: locallyDataQuality,
        imported_at:  locallyImportedAt,
      },
    };

    // ── Daily revenue (for chart) ─────────────────────────────────────────
    // Built from already-filtered JS rows — same date logic, no SQL date() issues.
    const dailyMap = {};
    for (const r of rows) {
      if (!r.created_at) continue;
      const parsed = new Date(r.created_at);
      if (isNaN(parsed.getTime())) continue;
      const dateKey = parsed.toISOString().slice(0, 10);
      if (!dailyMap[dateKey]) dailyMap[dateKey] = { date: dateKey, revenue: 0, orders: 0 };
      dailyMap[dateKey].revenue += parseFloat(r.total) || 0;
      dailyMap[dateKey].orders++;
    }
    const daily_revenue = Object.values(dailyMap)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map(d => ({ ...d, revenue: parseFloat(d.revenue.toFixed(2)) }));

    // INTEGRATION_HEALTH_RESPONSE
    const integration_health = {
      shopify: getIntegrationHealth(brand_id, 'shopify'),
      locally: getIntegrationHealth(brand_id, 'locally'),
    };

    res.json({
      ok: true,
      period,
      since,
      total_revenue:    parseFloat(totals.total_revenue.toFixed(2)),
      order_count:      totals.order_count,
      avg_order_value:  Math.round(totals.avg_order_value),
      channel_split,
      daily_revenue,
      integration_health,
    });

  } catch (err) {
    console.error('[sales] query error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to load sales data' });
  }
});

module.exports = router;
