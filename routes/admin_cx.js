'use strict';

/**
 * /api/admin/cx — Admin CX monitoring + management endpoints.
 * All routes protected by requireAdminAuth (applied in server.js).
 *
 *  GET  /api/admin/cx/messages-firehose
 *    All cx_messages across all brands. Filters: brand_id, flow_type, status, limit.
 *
 *  GET  /api/admin/brands/:brand_id/cx/setup-status
 *    CX setup state for one brand (settings + flow summary).
 *
 *  POST /api/admin/brands/:brand_id/cx/initialize
 *    Admin marks WhatsApp setup complete after manual configuration.
 *
 *  POST /api/admin/brands/:brand_id/cx/force-test
 *    Force-fire a test flow for a brand (admin diagnostic).
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/db');

const VALID_FLOW_TYPES = [
  'order_confirmed', 'shipped', 'out_for_delivery', 'delivered',
  'failed_delivery', 'feedback_request', 're_engagement', 'test',
];
const VALID_STATUSES = ['queued', 'sent', 'delivered', 'failed'];

// ── GET /api/admin/cx/messages-firehose ──────────────────────────────────────
router.get('/cx/messages-firehose', (req, res) => {
  const { brand_id, flow_type, status } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

  if (flow_type && !VALID_FLOW_TYPES.includes(flow_type)) {
    return res.status(400).json({ ok: false, error: 'Invalid flow_type filter' });
  }
  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ ok: false, error: 'Invalid status filter' });
  }

  try {
    let sql  = `
      SELECT m.*, b.name AS brand_name
      FROM cx_messages m
      JOIN brands b ON b.id = m.brand_id
      WHERE 1=1
    `;
    const args = [];
    if (brand_id)  { sql += ' AND m.brand_id = ?';  args.push(brand_id); }
    if (flow_type) { sql += ' AND m.flow_type = ?'; args.push(flow_type); }
    if (status)    { sql += ' AND m.status = ?';    args.push(status); }
    sql += ' ORDER BY m.created_at DESC LIMIT ?';
    args.push(limit);

    const messages = db.db.prepare(sql).all(...args);

    // Summary stats
    const totals = db.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
      FROM cx_messages
      WHERE created_at >= datetime('now', '-30 days')
    `).get();

    return res.json({ ok: true, count: messages.length, totals, messages });
  } catch (err) {
    console.error('[admin-cx] firehose error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/admin/brands/:brand_id/cx/setup-status ──────────────────────────
router.get('/brands/:brand_id/cx/setup-status', (req, res) => {
  const { brand_id } = req.params;

  const brand = db.getBrand(brand_id);
  if (!brand) {
    return res.status(404).json({ ok: false, error: `Brand "${brand_id}" not found` });
  }

  try {
    const settings = db.getCxSettings(brand_id);
    const flows    = db.getCxFlows(brand_id);
    const stats    = db.getCxStats(brand_id);
    const recent   = db.listCxMessages(brand_id, { limit: 10 });

    return res.json({
      ok:       true,
      brand_id,
      settings,
      flows,
      stats,
      recent_messages: recent,
    });
  } catch (err) {
    console.error('[admin-cx] setup-status error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/admin/brands/:brand_id/cx/initialize ───────────────────────────
router.post('/brands/:brand_id/cx/initialize', (req, res) => {
  const { brand_id } = req.params;
  const { whatsapp_number, n8n_workflow_url } = req.body || {};

  const brand = db.getBrand(brand_id);
  if (!brand) {
    return res.status(404).json({ ok: false, error: `Brand "${brand_id}" not found` });
  }

  try {
    const fields = {
      setup_status:            'whatsapp_setup',
      whatsapp_number_verified: 1,
    };
    if (whatsapp_number)   fields.whatsapp_number   = whatsapp_number;
    if (n8n_workflow_url)  fields.n8n_workflow_url  = n8n_workflow_url;
    if (whatsapp_number && n8n_workflow_url) fields.setup_status = 'live';

    db.upsertCxSettings(brand_id, fields);

    // Ensure flows are seeded (idempotent)
    db.seedCxFlows(brand_id);

    console.log(`[admin-cx] initialized brand=${brand_id} status=${fields.setup_status}`);
    const settings = db.getCxSettings(brand_id);
    return res.json({ ok: true, brand_id, settings });
  } catch (err) {
    console.error('[admin-cx] initialize error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/admin/brands/:brand_id/cx/force-test ───────────────────────────
router.post('/brands/:brand_id/cx/force-test', async (req, res) => {
  const { brand_id } = req.params;
  const { flow_type = 'order_confirmed', recipient_phone } = req.body || {};

  const brand = db.getBrand(brand_id);
  if (!brand) {
    return res.status(404).json({ ok: false, error: `Brand "${brand_id}" not found` });
  }

  if (!recipient_phone) {
    return res.status(400).json({ ok: false, error: 'recipient_phone required' });
  }

  const flow = db.getCxFlow(brand_id, flow_type);
  if (!flow) {
    return res.status(404).json({ ok: false, error: `Flow "${flow_type}" not found for brand` });
  }

  const sample = {
    customer_name:   'Test Customer',
    brand_name:      brand.name || brand_id,
    order_total:     '500',
    order_id:        'TEST-001',
    tracking_number: 'TRACK123456',
    failure_reason:  'Customer not available',
  };

  let body = flow.template_text || '';
  for (const [k, v] of Object.entries(sample)) {
    body = body.replace(new RegExp(`{${k}}`, 'g'), v);
  }

  try {
    const messageId = db.insertCxMessage({
      brandId:        brand_id,
      flowType:       flow_type,
      channel:        'whatsapp',
      recipientPhone: recipient_phone,
      recipientName:  'Test Customer',
      orderId:        'TEST-001',
      messageBody:    body,
    });

    const settings = db.getCxSettings(brand_id);
    if (settings.n8n_workflow_url) {
      const { fireCxWebhook } = require('../lib/cx_trigger');
      await fireCxWebhook(settings.n8n_workflow_url, {
        brand_id,
        message_id:      messageId,
        flow_type,
        recipient_phone,
        recipient_name:  'Test Customer',
        order_id:        'TEST-001',
        template:        flow.template_text,
        variables:       sample,
      });
    }

    console.log(`[admin-cx] force-test brand=${brand_id} flow=${flow_type} msg=${messageId}`);
    return res.json({ ok: true, brand_id, message_id: messageId, flow_type, recipient_phone });
  } catch (err) {
    console.error('[admin-cx] force-test error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
