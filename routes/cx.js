'use strict';

/**
 * /api/:brand_id/cx — Customer Experience endpoints (PAID tier only).
 * All routes protected by requireBrandOwnership + requirePaidTier (applied in server.js).
 *
 *  GET  /api/:brand_id/cx/settings         — returns cx_settings row
 *  PUT  /api/:brand_id/cx/settings         — update whatsapp_number, enabled, n8n_workflow_url
 *  GET  /api/:brand_id/cx/flows            — returns all 7 flow rows
 *  PUT  /api/:brand_id/cx/flows/:flow_type — update flow (enabled, template_text, delay_minutes)
 *  GET  /api/:brand_id/cx/messages         — recent messages with filters + pagination
 *  GET  /api/:brand_id/cx/stats            — aggregate stats (30d)
 *  POST /api/:brand_id/cx/test-send        — fire test message to brand owner's phone
 *  POST /api/:brand_id/cx/notify-ig        — register for Instagram DM notification
 */

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../db/db');

const VALID_FLOW_TYPES = [
  'order_confirmed', 'shipped', 'out_for_delivery', 'delivered',
  'failed_delivery', 'feedback_request', 're_engagement',
];

// ── GET /api/:brand_id/cx/settings ───────────────────────────────────────────
router.get('/settings', (req, res) => {
  try {
    const settings = db.getCxSettings(req.params.brand_id);
    // Compute completion percentage from setup_status
    const STATUS_PROGRESS = { pending: 0, whatsapp_setup: 33, templates_setup: 66, live: 100, error: 20 };
    const progress = STATUS_PROGRESS[settings.setup_status] ?? 0;
    return res.json({ ok: true, settings: { ...settings, setup_progress: progress } });
  } catch (err) {
    console.error('[cx] settings error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── PUT /api/:brand_id/cx/settings ───────────────────────────────────────────
router.put('/settings', (req, res) => {
  const { brand_id } = req.params;
  const { whatsapp_number, enabled, n8n_workflow_url } = req.body || {};

  // Validate phone number format if provided
  if (whatsapp_number !== undefined && whatsapp_number !== null && whatsapp_number !== '') {
    const clean = String(whatsapp_number).replace(/\D/g, '');
    if (clean.length < 10 || clean.length > 15) {
      return res.status(400).json({ ok: false, error: 'Invalid phone number format' });
    }
  }

  try {
    const fields = {};
    if (whatsapp_number   !== undefined) fields.whatsapp_number   = whatsapp_number || null;
    if (enabled           !== undefined) fields.enabled           = enabled ? 1 : 0;
    if (n8n_workflow_url  !== undefined) fields.n8n_workflow_url  = n8n_workflow_url || null;

    db.upsertCxSettings(brand_id, fields);
    const settings = db.getCxSettings(brand_id);
    db.insertEvent(brand_id, req.user?.id || null, 'cx_settings_updated', { changed: Object.keys(fields) });
    return res.json({ ok: true, settings });
  } catch (err) {
    console.error('[cx] settings update error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/:brand_id/cx/flows ──────────────────────────────────────────────
router.get('/flows', (req, res) => {
  const { brand_id } = req.params;
  try {
    let flows = db.getCxFlows(brand_id);
    // If not seeded yet (brand was upgraded before this code landed), seed now
    if (!flows.length) {
      db.seedCxFlows(brand_id);
      flows = db.getCxFlows(brand_id);
    }
    return res.json({ ok: true, count: flows.length, flows });
  } catch (err) {
    console.error('[cx] flows error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── PUT /api/:brand_id/cx/flows/:flow_type ───────────────────────────────────
router.put('/flows/:flow_type', (req, res) => {
  const { brand_id, flow_type } = req.params;

  if (!VALID_FLOW_TYPES.includes(flow_type)) {
    return res.status(400).json({ ok: false, error: `Invalid flow_type. Must be one of: ${VALID_FLOW_TYPES.join(', ')}` });
  }

  const { enabled, template_text, delay_minutes } = req.body || {};

  // Validate template character limit
  if (template_text !== undefined && String(template_text).length > 1024) {
    return res.status(400).json({ ok: false, error: 'Template exceeds 1024 character WhatsApp limit' });
  }

  // Validate delay ranges
  if (delay_minutes !== undefined) {
    const dm = Number(delay_minutes);
    if (flow_type === 'feedback_request' && (dm < 60 || dm > 10080)) {
      return res.status(400).json({ ok: false, error: 'feedback_request delay must be 1–168 hours (60–10080 minutes)' });
    }
    if (flow_type === 're_engagement' && (dm < 10080 || dm > 129600)) {
      return res.status(400).json({ ok: false, error: 're_engagement delay must be 7–90 days (10080–129600 minutes)' });
    }
  }

  try {
    const fields = {};
    if (enabled        !== undefined) fields.enabled        = enabled ? 1 : 0;
    if (template_text  !== undefined) fields.template_text  = String(template_text).trim();
    if (delay_minutes  !== undefined) fields.delay_minutes  = Number(delay_minutes);

    const flow = db.updateCxFlow(brand_id, flow_type, fields);
    if (!flow) {
      return res.status(404).json({ ok: false, error: `Flow "${flow_type}" not found — ensure brand is on paid tier` });
    }

    db.insertEvent(brand_id, req.user?.id || null, 'cx_flow_updated', { flow_type, changed: Object.keys(fields) });
    return res.json({ ok: true, flow });
  } catch (err) {
    console.error('[cx] flow update error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/:brand_id/cx/messages ───────────────────────────────────────────
router.get('/messages', (req, res) => {
  const { brand_id } = req.params;
  const { flow_type, status } = req.query;
  const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  if (flow_type && !VALID_FLOW_TYPES.includes(flow_type) && flow_type !== 'test') {
    return res.status(400).json({ ok: false, error: 'Invalid flow_type filter' });
  }
  const VALID_STATUSES = ['queued', 'sent', 'delivered', 'failed'];
  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ ok: false, error: 'Invalid status filter' });
  }

  try {
    const messages = db.listCxMessages(brand_id, { flowType: flow_type, status, limit, offset });
    return res.json({ ok: true, count: messages.length, messages });
  } catch (err) {
    console.error('[cx] messages error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/:brand_id/cx/stats ──────────────────────────────────────────────
router.get('/stats', (req, res) => {
  const { brand_id } = req.params;
  try {
    const stats = db.getCxStats(brand_id);
    return res.json({ ok: true, stats });
  } catch (err) {
    console.error('[cx] stats error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/:brand_id/cx/test-send ─────────────────────────────────────────
router.post('/test-send', async (req, res) => {
  const { brand_id } = req.params;
  const { flow_type } = req.body || {};

  if (!flow_type || !VALID_FLOW_TYPES.includes(flow_type)) {
    return res.status(400).json({ ok: false, error: 'Valid flow_type required' });
  }

  // Get brand owner phone
  const owner = db.db.prepare(`
    SELECT u.phone, u.name FROM users u
    JOIN user_brands ub ON ub.user_id = u.id
    WHERE ub.brand_id = ? AND ub.role = 'owner'
    ORDER BY ub.created_at ASC LIMIT 1
  `).get(brand_id);

  if (!owner?.phone) {
    return res.status(400).json({ ok: false, error: 'No phone number on file for brand owner. Add your phone number in Settings.' });
  }

  const flow = db.getCxFlow(brand_id, flow_type);
  if (!flow) {
    return res.status(404).json({ ok: false, error: `Flow "${flow_type}" not found` });
  }

  const brand  = db.getBrand(brand_id);
  const sample = {
    customer_name:  owner.name || 'Test Customer',
    brand_name:     brand?.name || brand_id,
    order_total:    '500',
    order_id:       'TEST-001',
    tracking_number: 'TRACK123456',
    failure_reason: 'Customer not available',
  };

  // Resolve template variables
  let body = flow.template_text || '';
  for (const [k, v] of Object.entries(sample)) {
    body = body.replace(new RegExp(`{${k}}`, 'g'), v);
  }

  try {
    // Create a test message row
    const messageId = db.insertCxMessage({
      brandId:        brand_id,
      flowType:       'test',
      channel:        'whatsapp',
      recipientPhone: owner.phone,
      recipientName:  owner.name,
      orderId:        null,
      messageBody:    body,
    });

    // Fire to n8n if configured (non-fatal — test succeeds even if n8n is unreachable)
    let n8nWarning = null;
    const settings = db.getCxSettings(brand_id);
    if (settings.n8n_workflow_url) {
      try {
        const { fireCxWebhook } = require('../lib/cx_trigger');
        await fireCxWebhook(settings.n8n_workflow_url, {
          brand_id,
          message_id:      messageId,
          flow_type:       'test',
          recipient_phone: owner.phone,
          recipient_name:  owner.name,
          order_id:        null,
          template:        flow.template_text,
          variables:       sample,
        });
      } catch (n8nErr) {
        n8nWarning = `n8n unreachable: ${n8nErr.message}`;
        console.warn('[cx] test-send n8n call failed (non-fatal):', n8nErr.message);
        db.updateCxMessageStatus(messageId, 'failed', { failed_reason: n8nWarning });
      }
    }

    return res.json({ ok: true, message_id: messageId, recipient_phone: owner.phone, message_body: body, n8n_warning: n8nWarning || undefined });
  } catch (err) {
    console.error('[cx] test-send error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/:brand_id/cx/notify-ig ─────────────────────────────────────────
router.post('/notify-ig', (req, res) => {
  const { brand_id } = req.params;
  try {
    db.upsertCxSettings(brand_id, { notify_ig_ready: 1 });
    db.insertEvent(brand_id, req.user?.id || null, 'cx_ig_notify_registered', {});
    return res.json({ ok: true, message: "You'll be notified when Instagram DM automation is available." });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
