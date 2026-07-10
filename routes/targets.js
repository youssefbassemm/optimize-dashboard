'use strict';

/**
 * TARGETS_ROUTER
 *
 * GET  /api/:brand_id/targets           — current period targets with progress
 * POST /api/:brand_id/targets           — upsert targets array
 * GET  /api/:brand_id/targets/history   — past periods with final results
 * POST /api/:brand_id/targets/rollover  — copy previous period targets to current
 *
 * Protected by requireBrandOwnership (mounted in server.js).
 */

const express = require('express');
const router  = express.Router({ mergeParams: true });
const { db }  = require('../db/db');
const { getBrand, getBrandTier } = require('../db/db');

// ── Period helpers ─────────────────────────────────────────────────────────────

function currentPeriodBounds(periodType = 'monthly') {
  const now = new Date();
  if (periodType === 'monthly') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end   = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return {
      start: start.toISOString().slice(0, 10),
      end:   end.toISOString().slice(0, 10),
    };
  }
  // quarterly
  const q     = Math.floor(now.getMonth() / 3);
  const start = new Date(now.getFullYear(), q * 3, 1);
  const end   = new Date(now.getFullYear(), q * 3 + 3, 0);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function prevPeriodBounds(periodType = 'monthly') {
  const now = new Date();
  if (periodType === 'monthly') {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end   = new Date(now.getFullYear(), now.getMonth(), 0);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  const q  = Math.floor(now.getMonth() / 3) - 1;
  const yr = q < 0 ? now.getFullYear() - 1 : now.getFullYear();
  const qq = q < 0 ? 3 : q;
  const start = new Date(yr, qq * 3, 1);
  const end   = new Date(yr, qq * 3 + 3, 0);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

// ── Trajectory calculation ─────────────────────────────────────────────────────

function calcTrajectory(current, target, periodStart, periodEnd, metricName) {
  if (target === 0) return { pct: 0, status: 'on_pace', label: 'On pace' };

  const now       = Date.now();
  const start     = new Date(periodStart).getTime();
  const end       = new Date(periodEnd).getTime() + 86400000; // inclusive
  const totalMs   = end - start;
  const elapsedMs = Math.max(0, now - start);
  const daysPct   = totalMs > 0 ? (elapsedMs / totalMs) * 100 : 100;

  let actualPct = (current / target) * 100;
  let status, label;

  if (metricName === 'channel_split') {
    // current = online%, target = online%
    const deviation = Math.abs(current - target);
    if (deviation <= 3)      { status = 'on_track';     label = 'On track'; }
    else if (deviation <= 7) { status = 'slight_drift'; label = 'Slight drift'; }
    else                     { status = 'off_target';   label = 'Off target'; }
  } else {
    if (actualPct >= 100)              { status = 'ahead';           label = 'Ahead'; }
    else if (actualPct >= daysPct - 5) { status = 'on_pace';         label = 'On pace'; }
    else if (actualPct >= daysPct -15) { status = 'slightly_behind'; label = 'Slightly behind'; }
    else                               { status = 'behind';          label = 'Behind'; }
  }
  return { pct: Math.min(Math.round(actualPct), 100), raw_pct: actualPct, status, label };
}

// ── Progress calculation ───────────────────────────────────────────────────────

function computeCurrentValue(brand_id, metricName, periodStart, periodEnd) {
  try {
    switch (metricName) {
      case 'revenue': {
        const row = db.prepare(`
          SELECT COALESCE(SUM(total_price), 0) AS val
          FROM orders_cache
          WHERE brand_id = ? AND financial_status = 'paid'
            AND created_at >= ? AND created_at <= ?
        `).get(brand_id, periodStart, periodEnd + 'T23:59:59');
        return row ? row.val : 0;
      }

      case 'orders': {
        const row = db.prepare(`
          SELECT COUNT(*) AS val
          FROM orders_cache
          WHERE brand_id = ? AND financial_status = 'paid'
            AND created_at >= ? AND created_at <= ?
        `).get(brand_id, periodStart, periodEnd + 'T23:59:59');
        return row ? row.val : 0;
      }

      case 'aov': {
        const row = db.prepare(`
          SELECT
            COALESCE(SUM(total_price), 0) AS revenue,
            COUNT(*) AS orders
          FROM orders_cache
          WHERE brand_id = ? AND financial_status = 'paid'
            AND created_at >= ? AND created_at <= ?
        `).get(brand_id, periodStart, periodEnd + 'T23:59:59');
        if (!row || row.orders === 0) return 0;
        return row.revenue / row.orders;
      }

      case 'sell_through': {
        const soldRow = db.prepare(`
          SELECT COALESCE(SUM(total_items), 0) AS units_sold
          FROM orders_cache
          WHERE brand_id = ? AND financial_status = 'paid'
            AND created_at >= ? AND created_at <= ?
        `).get(brand_id, periodStart, periodEnd + 'T23:59:59');
        const invRow = db.prepare(`
          SELECT COALESCE(SUM(quantity), 0) AS total_qty
          FROM inventory_cache
          WHERE brand_id = ?
        `).get(brand_id);
        const unitsSold = soldRow ? soldRow.units_sold : 0;
        const totalInv  = invRow  ? invRow.total_qty   : 0;
        if (totalInv === 0) return 0;
        return (unitsSold / totalInv) * 100;
      }

      case 'roas': {
        // period is a YYYY-MM string used in campaign_cache
        const periodMonth = periodStart.slice(0, 7);
        const row = db.prepare(`
          SELECT
            COALESCE(SUM(spend), 0)          AS total_spend,
            COALESCE(SUM(purchase_value), 0) AS total_value
          FROM campaign_cache
          WHERE brand_id = ? AND period = ?
        `).get(brand_id, periodMonth);
        if (!row || row.total_spend === 0) return 0;
        return row.total_value / row.total_spend;
      }

      case 'channel_split': {
        const shopifyRow = db.prepare(`
          SELECT COALESCE(SUM(total_price), 0) AS rev
          FROM orders_cache
          WHERE brand_id = ? AND source = 'shopify' AND financial_status = 'paid'
            AND created_at >= ? AND created_at <= ?
        `).get(brand_id, periodStart, periodEnd + 'T23:59:59');
        const locallyRow = db.prepare(`
          SELECT COALESCE(SUM(total_price), 0) AS rev
          FROM orders_cache
          WHERE brand_id = ? AND source = 'locally' AND financial_status = 'paid'
            AND created_at >= ? AND created_at <= ?
        `).get(brand_id, periodStart, periodEnd + 'T23:59:59');
        const shopifyRev = shopifyRow ? shopifyRow.rev : 0;
        const locallyRev = locallyRow ? locallyRow.rev : 0;
        const total = shopifyRev + locallyRev;
        if (total === 0) return 0;
        return (shopifyRev / total) * 100;
      }

      default:
        return 0;
    }
  } catch (err) {
    console.error(`[targets] computeCurrentValue(${metricName}) error:`, err.message);
    return 0;
  }
}

// ── GET /api/:brand_id/targets ─────────────────────────────────────────────────

router.get('/', (req, res) => {
  try {
    const { brand_id } = req.params;
    const brand = getBrand(brand_id);
    if (!brand) return res.status(404).json({ ok: false, error: 'Brand not found' });

    const periodType = req.query.period_type || 'monthly';
    const { start, end } = currentPeriodBounds(periodType);

    const targets = db.prepare(`
      SELECT * FROM targets
      WHERE brand_id = ? AND period_start = ? AND enabled = 1
      ORDER BY id ASC
    `).all(brand_id, start);

    const result = targets.map(t => {
      const current    = computeCurrentValue(brand_id, t.metric_name, t.period_start, t.period_end);
      const trajectory = calcTrajectory(current, t.target_value, t.period_start, t.period_end, t.metric_name);
      return {
        id:               t.id,
        metric_name:      t.metric_name,
        target_value:     t.target_value,
        target_secondary: t.target_secondary,
        current_value:    current,
        period_start:     t.period_start,
        period_end:       t.period_end,
        period_type:      t.period_type,
        trajectory,
        enabled:          t.enabled === 1,
      };
    });

    // Check if there are previous-period targets available for rollover
    const prev = prevPeriodBounds(periodType);
    const prevCount = db.prepare(`
      SELECT COUNT(*) AS cnt FROM targets
      WHERE brand_id = ? AND period_start = ? AND enabled = 1
    `).get(brand_id, prev.start);

    res.json({
      ok:                  true,
      period_start:        start,
      period_end:          end,
      period_type:         periodType,
      targets:             result,
      has_targets:         result.length > 0,
      can_rollover:        (prevCount ? prevCount.cnt : 0) > 0 && result.length === 0,
    });
  } catch (err) {
    console.error('[targets] GET / error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to load targets' });
  }
});

// ── POST /api/:brand_id/targets ────────────────────────────────────────────────

router.post('/', (req, res) => {
  try {
    const { brand_id } = req.params;
    const brand = getBrand(brand_id);
    if (!brand) return res.status(404).json({ ok: false, error: 'Brand not found' });

    const { targets } = req.body;
    if (!Array.isArray(targets) || targets.length === 0) {
      return res.status(400).json({ ok: false, error: 'targets must be a non-empty array' });
    }

    const upsert = db.prepare(`
      INSERT INTO targets
        (brand_id, metric_name, target_value, target_secondary, period_type, period_start, period_end, enabled)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(brand_id, metric_name, period_start) DO UPDATE SET
        target_value     = excluded.target_value,
        target_secondary = excluded.target_secondary,
        period_type      = excluded.period_type,
        period_end       = excluded.period_end,
        enabled          = excluded.enabled
    `);

    const upsertMany = db.transaction((rows) => {
      for (const t of rows) {
        const periodType = t.period_type || 'monthly';
        const { start, end } = currentPeriodBounds(periodType);
        upsert.run(
          brand_id,
          t.metric_name,
          t.target_value,
          t.target_secondary ?? null,
          periodType,
          start,
          end,
          t.enabled !== undefined ? (t.enabled ? 1 : 0) : 1,
        );
      }
    });

    upsertMany(targets);
    console.log(`[targets] brand=${brand_id} upserted ${targets.length} targets`);
    res.json({ ok: true, upserted: targets.length });
  } catch (err) {
    console.error('[targets] POST / error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to save targets' });
  }
});

// ── GET /api/:brand_id/targets/history ────────────────────────────────────────

router.get('/history', (req, res) => {
  try {
    const { brand_id } = req.params;
    const brand = getBrand(brand_id);
    if (!brand) return res.status(404).json({ ok: false, error: 'Brand not found' });

    const periodType = req.query.period_type || 'monthly';
    const { start: currentStart } = currentPeriodBounds(periodType);

    // Fetch all past periods (not current) — up to 6 distinct periods
    const pastPeriods = db.prepare(`
      SELECT DISTINCT period_start, period_end, period_type
      FROM targets
      WHERE brand_id = ? AND period_start < ? AND period_type = ?
      ORDER BY period_start DESC
      LIMIT 6
    `).all(brand_id, currentStart, periodType);

    const history = pastPeriods.map(period => {
      const targets = db.prepare(`
        SELECT * FROM targets
        WHERE brand_id = ? AND period_start = ? AND period_type = ?
        ORDER BY id ASC
      `).all(brand_id, period.period_start, periodType);

      const items = targets.map(t => {
        const final_value = computeCurrentValue(brand_id, t.metric_name, t.period_start, t.period_end);
        const trajectory  = calcTrajectory(final_value, t.target_value, t.period_start, t.period_end, t.metric_name);
        return {
          id:               t.id,
          metric_name:      t.metric_name,
          target_value:     t.target_value,
          target_secondary: t.target_secondary,
          final_value,
          period_start:     t.period_start,
          period_end:       t.period_end,
          period_type:      t.period_type,
          trajectory,
          enabled:          t.enabled === 1,
        };
      });

      return {
        period_start: period.period_start,
        period_end:   period.period_end,
        period_type:  period.period_type,
        targets:      items,
      };
    });

    res.json({ ok: true, history });
  } catch (err) {
    console.error('[targets] GET /history error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to load targets history' });
  }
});

// ── POST /api/:brand_id/targets/rollover ──────────────────────────────────────

router.post('/rollover', (req, res) => {
  try {
    const { brand_id } = req.params;
    const brand = getBrand(brand_id);
    if (!brand) return res.status(404).json({ ok: false, error: 'Brand not found' });

    const periodType = req.query.period_type || req.body?.period_type || 'monthly';
    const { start: currentStart, end: currentEnd } = currentPeriodBounds(periodType);
    const { start: prevStart } = prevPeriodBounds(periodType);

    // Fetch previous period enabled targets
    const prevTargets = db.prepare(`
      SELECT * FROM targets
      WHERE brand_id = ? AND period_start = ? AND enabled = 1
      ORDER BY id ASC
    `).all(brand_id, prevStart);

    if (prevTargets.length === 0) {
      return res.status(404).json({ ok: false, error: 'No previous period targets found to roll over' });
    }

    const upsert = db.prepare(`
      INSERT INTO targets
        (brand_id, metric_name, target_value, target_secondary, period_type, period_start, period_end, enabled)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(brand_id, metric_name, period_start) DO UPDATE SET
        target_value     = excluded.target_value,
        target_secondary = excluded.target_secondary,
        period_type      = excluded.period_type,
        period_end       = excluded.period_end,
        enabled          = 1
    `);

    const rolloverTx = db.transaction((rows) => {
      for (const t of rows) {
        upsert.run(
          brand_id,
          t.metric_name,
          t.target_value,
          t.target_secondary,
          periodType,
          currentStart,
          currentEnd,
        );
      }
    });

    rolloverTx(prevTargets);
    console.log(`[targets] brand=${brand_id} rolled over ${prevTargets.length} targets from ${prevStart} to ${currentStart}`);

    res.json({
      ok:         true,
      rolled_over: prevTargets.length,
      period_start: currentStart,
      period_end:   currentEnd,
    });
  } catch (err) {
    console.error('[targets] POST /rollover error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to roll over targets' });
  }
});

module.exports = router;
