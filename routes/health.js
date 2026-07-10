'use strict';

/**
 * GET /api/health
 *
 * Public infrastructure health check.
 * Returns ONLY: ok, status, timestamp, version, uptime, database reachable (boolean).
 *
 * Deliberately excludes:
 *   - Integration statuses, last_sync, health, or last_error messages
 *   - Order counts, revenue totals, or inventory counts
 *   - Per-brand data of any kind
 *   - SERVER_URL, NODE_ENV, or any other environment/config values
 *   - Raw database error messages
 *
 * Operational stats (integration status, sync counts, errors) are available
 * to authenticated users via /api/:brand_id/integrations and
 * /api/:brand_id/dashboard. This endpoint exists only to confirm the process
 * and database are alive — suitable for Railway uptime monitors and load
 * balancer health checks.
 *
 * // RAILWAY_PRODUCTION
 */

const express = require('express');
const router  = express.Router();
const { db }  = require('../db/db');

const START_TIME = Date.now();
const VERSION    = process.env.npm_package_version || '1.0.0';

router.get('/', (req, res) => {
  try {
    // DB connectivity — boolean only; never expose the raw error message
    // or any schema/path details that would help an attacker.
    let dbReachable = true;
    try {
      db.prepare('SELECT 1').get();
    } catch (_) {
      dbReachable = false;
    }

    res.json({
      ok:          dbReachable,
      status:      dbReachable ? 'ok' : 'degraded',
      timestamp:   new Date().toISOString(),
      version:     VERSION,
      uptime_secs: Math.floor((Date.now() - START_TIME) / 1000),
      database:    dbReachable,
    });
  } catch (err) {
    console.error('[health] GET error:', err.message);
    res.status(500).json({ ok: false, error: 'Health check failed' });
  }
});

module.exports = router;
