'use strict';

/**
 * /api/:brand_id/campaigns
 *
 * GET /             — campaign list for a period (Meta Ads)
 * GET /summary      — aggregated totals (spend, impressions, purchases, ROAS, CPA)
 * GET /instagram    — latest Instagram snapshot
 * POST /sync        — trigger an immediate Meta sync
 */

const express = require('express');
const router  = express.Router({ mergeParams: true });
const meta    = require('../integrations/meta');
const { getIntegration } = require('../db/db');

// ── GET /api/:brand_id/campaigns ─────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const { brand_id } = req.params;
    const period = req.query.period || 'last_7d';

    const allowed = ['last_7d', 'last_30d', 'this_month', 'last_month'];
    if (!allowed.includes(period)) {
      return res.status(400).json({ ok: false, error: `period must be one of: ${allowed.join(', ')}` });
    }

    const campaigns = meta.getCampaigns(brand_id, period);
    res.json({ ok: true, period, campaigns });
  } catch (err) {
    console.error('[campaigns] GET / error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to load campaigns' });
  }
});

// ── GET /api/:brand_id/campaigns/summary ──────────────────────────────────────
router.get('/summary', (req, res) => {
  try {
    const { brand_id } = req.params;
    const period = req.query.period || 'last_7d';

    const campaigns = meta.getCampaigns(brand_id, period);

    if (!campaigns.length) {
      return res.json({
        ok: true,
        period,
        summary: { total_spend: 0, total_impressions: 0, total_purchases: 0, total_purchase_value: 0, roas: 0, cpa: 0 },
      });
    }

    const totSpend = campaigns.reduce((s, c) => s + (c.spend         || 0), 0);
    const totImpr  = campaigns.reduce((s, c) => s + (c.impressions    || 0), 0);
    const totPurch = campaigns.reduce((s, c) => s + (c.purchases      || 0), 0);
    const totValue = campaigns.reduce((s, c) => s + (c.purchase_value || 0), 0);

    res.json({
      ok: true,
      period,
      summary: {
        total_spend:          parseFloat(totSpend.toFixed(2)),
        total_impressions:    totImpr,
        total_purchases:      totPurch,
        total_purchase_value: parseFloat(totValue.toFixed(2)),
        roas: totSpend > 0 ? parseFloat((totValue / totSpend).toFixed(4)) : 0,
        cpa:  totPurch > 0 ? parseFloat((totSpend / totPurch).toFixed(4)) : 0,
      },
    });
  } catch (err) {
    console.error('[campaigns] GET /summary error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to load campaign summary' });
  }
});

// ── GET /api/:brand_id/campaigns/instagram ────────────────────────────────────
router.get('/instagram', (req, res) => {
  try {
    const { brand_id } = req.params;
    const ig = meta.getInstagram(brand_id);
    res.json({ ok: true, instagram: ig || null });
  } catch (err) {
    console.error('[campaigns] GET /instagram error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to load Instagram data' });
  }
});

// ── POST /api/:brand_id/campaigns/sync ────────────────────────────────────────
router.post('/sync', async (req, res) => {
  try {
    const { brand_id } = req.params;

    const integration = getIntegration(brand_id, 'meta');
    if (!integration || integration.status === 'disconnected') {
      return res.status(400).json({ ok: false, error: 'Meta integration not connected' });
    }

    res.json({ ok: true, message: 'Meta sync started' });

    setImmediate(async () => {
      try {
        await meta.fullSync(brand_id);
      } catch (err) {
        console.error(`[campaigns/sync] error brand=${brand_id}:`, err.message);
      }
    });
  } catch (err) {
    console.error('[campaigns] POST /sync error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to start sync' });
  }
});

module.exports = router;
