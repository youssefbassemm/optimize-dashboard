'use strict';

/**
 * GET /api/health
 *
 * Returns server status, database connectivity, and per-integration summary.
 * Safe to expose publicly — no credentials or sensitive data returned.
 */

const express = require('express');
const router  = express.Router();
const { db, getAllIntegrations } = require('../db/db');

const START_TIME = Date.now();

router.get('/', (req, res) => {
  try {
    // Quick DB connectivity check
    let dbStatus = 'ok';
    try {
      db.prepare('SELECT 1').get();
    } catch (err) {
      dbStatus = 'error: ' + err.message;
    }

    // Summarise integration statuses for all brands
    let integrations = {};
    try {
      const rows = db.prepare('SELECT brand_id, platform, status, last_sync FROM integrations').all();
      for (const r of rows) {
        if (!integrations[r.brand_id]) integrations[r.brand_id] = {};
        integrations[r.brand_id][r.platform] = {
          status:    r.status,
          last_sync: r.last_sync,
        };
      }
    } catch (_) {}

    res.json({
      ok:           dbStatus === 'ok',
      uptime_secs:  Math.floor((Date.now() - START_TIME) / 1000),
      database:     dbStatus,
      integrations,
      server_url:   process.env.SERVER_URL || 'not set',
    });
  } catch (err) {
    console.error('[health] GET error:', err.message);
    res.status(500).json({ ok: false, error: 'Health check failed' });
  }
});

module.exports = router;
