'use strict';

/**
 * /api/:brand_id/shipping/shipblu
 *
 * TIER_SYSTEM — PAID TIER ONLY.
 * requirePaidTier is applied at mount level in server.js.
 * Free users receive 403 { ok:false, error:'upgrade_required' } on every
 * endpoint here — they never reach these handlers.
 *
 * Data query routes for ShipBlu shipping data.
 * Connect / disconnect is handled by /api/:brand_id/integrations/shipblu
 * (ungated — free users can connect in preparation for upgrade).
 *
 * GET /status     — integration health + last sync summary
 * GET /shipments  — recent orders that have ShipBlu shipping data
 *
 * FROZEN_INTEGRATION note:
 *   sync_paused=1 means the background scheduler skips this brand.
 *   These data-read endpoints still work while frozen — the freeze only
 *   stops NEW data from being written; existing cache rows remain readable.
 *   We surface sync_paused in /status so the frontend can show a banner.
 */

const express   = require('express');
const router    = express.Router({ mergeParams: true });
const { db, getIntegration, getIntegrationHealth, getLastSyncLog } = require('../../db/db');

// ── GET /api/:brand_id/shipping/shipblu/status ────────────────────────────────
router.get('/status', (req, res) => {
  const { brand_id } = req.params;
  try {
    const row    = getIntegration(brand_id, 'shipblu');
    const lastLog = getLastSyncLog(brand_id, 'shipblu');

    if (!row || row.status === 'disconnected') {
      return res.json({ ok: true, connected: false });
    }

    res.json({
      ok:          true,
      connected:   true,
      status:      row.status,
      health:      row.health      || 'unknown',
      sync_paused: !!row.sync_paused,
      last_sync:   row.last_sync   || null,
      last_log:    lastLog ? {
        status:         lastLog.status,
        records_synced: lastLog.records_synced,
        error_message:  lastLog.error_message || null,
        created_at:     lastLog.created_at,
      } : null,
    });
  } catch (err) {
    console.error('[shipping/shipblu] GET /status error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to load ShipBlu status' });
  }
});

// ── GET /api/:brand_id/shipping/shipblu/shipments ─────────────────────────────
// Returns orders that have ShipBlu tracking data in the shipping JSON column.
router.get('/shipments', (req, res) => {
  const { brand_id } = req.params;
  try {
    const row = getIntegration(brand_id, 'shipblu');
    if (!row || row.status === 'disconnected') {
      return res.status(400).json({ ok: false, error: 'ShipBlu not connected' });
    }

    // Shipping data is stored as JSON in orders_cache.shipping.
    // Each row represents an order; the shipping column carries tracking details.
    const rows = db.prepare(`
      SELECT source_order_id, customer_name, total, status, shipping, created_at
      FROM   orders_cache
      WHERE  brand_id = ?
        AND  shipping IS NOT NULL
      ORDER  BY created_at DESC
      LIMIT  100
    `).all(brand_id);

    const shipments = rows.map(r => {
      let s = {};
      try { s = JSON.parse(r.shipping || '{}'); } catch (_) {}
      return {
        order_id:      r.source_order_id,
        customer_name: r.customer_name,
        total:         r.total,
        order_status:  r.status,
        tracking_number: s.tracking_number || null,
        carrier_status:  s.status          || null,
        created_at:    r.created_at,
      };
    });

    res.json({ ok: true, count: shipments.length, shipments });
  } catch (err) {
    console.error('[shipping/shipblu] GET /shipments error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to load shipments' });
  }
});

module.exports = router;
