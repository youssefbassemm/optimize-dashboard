'use strict';

/**
 * GET /api/:brand_id/dashboard?period=today|7d|30d|ytd|all
 *
 * Single-shot home page endpoint. Returns:
 *   - current period: revenue, orders, AOV, channel split, top product
 *   - previous period: same metrics for delta calculation
 *   - daily_revenue: array for chart
 *   - needs_action_count: unresolved orders
 *   - integrations: connected status per platform
 *
 * Accepts frontend period aliases: week→7d, month→30d, year→ytd
 */

const express = require('express');
const router  = express.Router({ mergeParams: true });
const { db, getAllIntegrations, getIntegrationHealth } = require('../db/db');
const meta    = require('../integrations/meta');

// Accept frontend period aliases
function normalisePeriod(p) {
  const map = { week: '7d', month: '30d', year: 'ytd' };
  return map[p] || p || '7d';
}

function periodStart(period) {
  const now = new Date();
  switch (period) {
    case 'today': return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    case '7d':    return new Date(Date.now() - 7  * 86400000).toISOString();
    case '30d':   return new Date(Date.now() - 30 * 86400000).toISOString();
    case 'ytd':   return new Date(now.getFullYear(), 0, 1).toISOString();
    default:      return null;   // 'all'
  }
}

function prevPeriodStart(period) {
  switch (period) {
    case 'today': return new Date(Date.now() - 86400000).toISOString();
    case '7d':    return new Date(Date.now() - 14 * 86400000).toISOString();
    case '30d':   return new Date(Date.now() - 60 * 86400000).toISOString();
    case 'ytd':   return new Date(new Date().getFullYear() - 1, 0, 1).toISOString();
    default:      return null;
  }
}

/**
 * DATE_FILTER_JS — filter in JS, not SQL.
 *
 * The Locally integration historically stored created_at in a non-ISO format
 * ("31 Dec 2025, 04:30 pm") which makes SQLite string comparison unreliable:
 *   "31 Dec..." >= "2026-04-..." → TRUE (because '3' > '2') even for old rows.
 *
 * Fetching all rows for the brand and filtering with new Date() in JS correctly
 * handles any parseable date string. Performance is acceptable at this scale —
 * if the orders_cache grows beyond ~100k rows, add a proper ISO migration first.
 */
function queryPeriod(brandId, since, until) {
  // PAID_ONLY_FILTER — only count paid orders in every revenue metric.
  // Pending, refunded, and voided orders must never appear in revenue totals.
  // financial_status is a clean enum field; SQL filtering is safe here.
  const rows = db.prepare(
    "SELECT source, financial_status, total, total_items, created_at, items FROM orders_cache WHERE brand_id = ? AND financial_status = 'paid'"
  ).all(brandId);

  // No date bounds → return everything
  if (!since && !until) return rows;

  const sinceMs = since ? new Date(since).getTime() : null;
  const untilMs = until ? new Date(until).getTime() : null;

  return rows.filter(row => {
    if (!row.created_at) return false; // exclude undated orders from bounded queries
    const ts = new Date(row.created_at).getTime();
    if (isNaN(ts)) return false;        // exclude unparseable dates
    if (sinceMs !== null && ts < sinceMs) return false;
    if (untilMs !== null && ts >= untilMs) return false;
    return true;
  });
}

function aggregate(rows) {
  let revenue = 0, orders = 0;
  const channelMap = {};
  const productUnits = {};

  for (const row of rows) {
    const total = parseFloat(row.total) || 0;
    revenue += total;
    orders++;

    const src = row.source || 'unknown';
    if (!channelMap[src]) channelMap[src] = { revenue: 0, count: 0, units_sold: 0 };
    channelMap[src].revenue += total;
    channelMap[src].count++;
    // units_sold: sum of line-item quantities; fall back to 1 per order when
    // total_items is 0 (pre-migration rows or sources that don't populate it).
    channelMap[src].units_sold += (row.total_items > 0 ? row.total_items : 1);

    // Top product from items JSON
    try {
      const items = typeof row.items === 'string' ? JSON.parse(row.items) : (row.items || []);
      for (const item of items) {
        const key = item.name || 'Unknown';
        productUnits[key] = (productUnits[key] || 0) + (item.qty || item.quantity || 1);
      }
    } catch (_) {}
  }

  const channel_split = {
    shopify: { revenue: channelMap.shopify?.revenue || 0, count: channelMap.shopify?.count || 0, units_sold: channelMap.shopify?.units_sold || 0, pct: 0 },
    locally: { revenue: channelMap.locally?.revenue || 0, count: channelMap.locally?.count || 0, units_sold: channelMap.locally?.units_sold || 0, pct: 0 },
  };
  if (revenue > 0) {
    channel_split.shopify.pct = Math.round(channel_split.shopify.revenue / revenue * 100);
    channel_split.locally.pct = Math.round(channel_split.locally.revenue / revenue * 100);
  }

  let top_product = null;
  for (const [name, units] of Object.entries(productUnits)) {
    if (!top_product || units > top_product.units) top_product = { name, units };
  }

  return {
    revenue:         parseFloat(revenue.toFixed(2)),
    order_count:     orders,
    avg_order_value: orders > 0 ? Math.round(revenue / orders) : 0,
    channel_split,
    top_product,
  };
}

router.get('/', (req, res) => {
  const { brand_id } = req.params;
  const period       = normalisePeriod(req.query.period || '7d');

  try {
    const currSince = periodStart(period);
    const prevSince = prevPeriodStart(period);
    const prevUntil = currSince;  // previous period ends where current begins

    const currRows = queryPeriod(brand_id, currSince, null);
    const prevRows = prevSince ? queryPeriod(brand_id, prevSince, prevUntil) : [];

    const current  = aggregate(currRows);
    const previous = aggregate(prevRows);

    // ── Guardrails ──────────────────────────────────────────────────────────
    // Log anomalies that indicate data duplication, missing sync, or aggregation bugs.
    // These never block the response — they surface as server-side warnings only.
    const cs = current.channel_split;
    const shopifyRev = cs.shopify?.revenue || 0;
    const locallyRev = cs.locally?.revenue || 0;
    const channelSum = shopifyRev + locallyRev;
    if (current.revenue > 0.01 && Math.abs(current.revenue - channelSum) > 0.01) {
      console.warn(`[guardrail] channel_split_mismatch brand=${brand_id} period=${period} total=${current.revenue} shopify+locally=${channelSum.toFixed(2)}`);
    }
    if (shopifyRev > 0 && locallyRev > 0 && Math.abs(shopifyRev - locallyRev) < 0.01) {
      console.warn(`[guardrail] identical_channel_totals brand=${brand_id} period=${period} shopify=${shopifyRev} locally=${locallyRev} — possible data duplication`);
    }
    if (current.order_count === 0) {
      const shopifyRow = db.prepare(
        "SELECT status FROM integrations WHERE brand_id = ? AND platform = 'shopify'"
      ).get(brand_id);
      const locallyRow = db.prepare(
        "SELECT status FROM integrations WHERE brand_id = ? AND platform = 'locally'"
      ).get(brand_id);
      const anyConnected = shopifyRow?.status === 'connected' || locallyRow?.status === 'connected';
      if (anyConnected) {
        console.warn(`[guardrail] zero_orders_after_sync brand=${brand_id} period=${period} — integration connected but no orders returned`);
      }
    }

    // Daily revenue for chart — derived from already-filtered currRows in JS.
    // This avoids the SQLite date() function failing on non-ISO created_at values
    // (e.g. "31 Dec 2025, 04:30 pm") which would produce null-dated buckets.
    const dailyMap = {};
    for (const row of currRows) {
      if (!row.created_at) continue;
      const parsed = new Date(row.created_at);
      if (isNaN(parsed.getTime())) continue;
      const dateKey = parsed.toISOString().slice(0, 10); // YYYY-MM-DD
      if (!dailyMap[dateKey]) dailyMap[dateKey] = { date: dateKey, revenue: 0, orders: 0, shopify: 0, locally: 0 };
      const total = parseFloat(row.total) || 0;
      dailyMap[dateKey].revenue += total;
      dailyMap[dateKey].orders++;
      if (row.source === 'shopify') dailyMap[dateKey].shopify += total;
      if (row.source === 'locally') dailyMap[dateKey].locally += total;
    }
    const daily_revenue = Object.values(dailyMap)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map(d => ({
        ...d,
        revenue: parseFloat(d.revenue.toFixed(2)),
        shopify: parseFloat(d.shopify.toFixed(2)),
        locally: parseFloat(d.locally.toFixed(2)),
      }));

    // Needs-action count (open across all time)
    const needs_action_count = db.prepare(
      "SELECT COUNT(*) AS cnt FROM orders_cache WHERE brand_id = ? AND needs_action = 1"
    ).get(brand_id)?.cnt || 0;

    // Integration connection states
    const integRows = getAllIntegrations(brand_id);
    const integrations = {};
    for (const r of integRows) {
      integrations[r.platform] = {
        status:    r.status,
        last_sync: r.last_sync,
        health:    r.health || null,
      };
    }

    // INTEGRATION_HEALTH_RESPONSE — rich health object for each platform
    const integration_health = {
      shopify: getIntegrationHealth(brand_id, 'shopify'),
      locally: getIntegrationHealth(brand_id, 'locally'),
      shipblu: getIntegrationHealth(brand_id, 'shipblu'),
      meta:    getIntegrationHealth(brand_id, 'meta'),
    };

    // ── Meta: Instagram snapshot + ads summary ──────────────────────────
    // Included inline so the home tab doesn't need a second round-trip.
    //
    // META_ISOLATION: Only serve cached data when:
    //   1. Meta integration status is not 'error' or 'disconnected'
    //   2. The cached data is < 3 hours old (META_STALE_MS)
    //
    // An errored integration has stale data from the last successful sync.
    // Serving it without these checks makes the dashboard show outdated
    // Instagram stats and ad spend as if they were current — they are not.
    let instagram   = null;
    let ads_summary = null;

    const META_STALE_MS = 3 * 60 * 60 * 1000; // 3 hours — matches scheduler cadence
    const metaStatus  = integrations.meta?.status;
    const metaHealthy = metaStatus && metaStatus !== 'disconnected' && metaStatus !== 'error';

    if (metaHealthy) {
      try {
        const igRow = meta.getInstagram(brand_id);
        if (igRow) {
          const fetchedMs = new Date(igRow.fetched_at).getTime();
          if (!isNaN(fetchedMs) && (Date.now() - fetchedMs) < META_STALE_MS) {
            let posts = [];
            try { posts = JSON.parse(igRow.recent_posts); } catch (_) {}
            instagram = {
              followers_count: igRow.followers_count || 0,
              media_count:     igRow.media_count     || 0,
              recent_posts:    posts,
              fetched_at:      igRow.fetched_at,
            };
          }
        }
      } catch (err) {
        console.warn('[dashboard] instagram fetch error:', err.message);
      }

      try {
        const campaigns = meta.getCampaigns(brand_id, 'last_7d');
        if (campaigns.length) {
          const totSpend = campaigns.reduce((s, c) => s + (c.spend         || 0), 0);
          const totPurch = campaigns.reduce((s, c) => s + (c.purchases      || 0), 0);
          const totValue = campaigns.reduce((s, c) => s + (c.purchase_value || 0), 0);
          const totImpr  = campaigns.reduce((s, c) => s + (c.impressions    || 0), 0);
          ads_summary = {
            total_spend:          parseFloat(totSpend.toFixed(2)),
            total_impressions:    totImpr,
            total_purchases:      totPurch,
            total_purchase_value: parseFloat(totValue.toFixed(2)),
            roas: totSpend > 0 ? parseFloat((totValue / totSpend).toFixed(4)) : 0,
            cpa:  totPurch > 0 ? parseFloat((totSpend / totPurch).toFixed(4)) : 0,
          };
        }
      } catch (err) {
        console.warn('[dashboard] ads_summary fetch error:', err.message);
      }
    }

    res.json({
      ok:                 true,
      period,
      current,
      previous,
      daily_revenue,
      needs_action_count,
      integrations,
      integration_health,
      instagram,
      ads_summary,
    });
  } catch (err) {
    console.error('[dashboard] error:', err.message);
    res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

module.exports = router;
