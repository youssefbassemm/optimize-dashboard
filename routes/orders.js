'use strict';

/**
 * GET /api/:brand_id/orders
 * GET /api/:brand_id/orders/:order_id
 *
 * Reads from orders_cache — never from Shopify directly.
 * Parses JSON fields (items, shipping) before returning.
 */

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../db/db');

// Safe JSON.parse — returns fallback if the stored string is malformed
function safeJson(str, fallback) {
  try { return JSON.parse(str || JSON.stringify(fallback)); } catch (_) { return fallback; }
}

// Deserialise JSON columns and return a clean order object
function parseOrder(row) {
  if (!row) return null;
  return {
    order_id:          row.source_order_id,
    internal_id:       row.id,
    source:            row.source,
    customer_name:     row.customer_name,
    phone:             row.phone,
    city:              row.city,
    items:             safeJson(row.items,    []),
    total:             row.total,
    currency:          row.currency,
    payment_method:    row.payment_method,
    financial_status:  row.financial_status,
    fulfillment_status: row.fulfillment_status,
    shipping:          safeJson(row.shipping, {}),
    needs_action:      row.needs_action === 1,
    action_reason:     row.action_reason,
    created_at:        row.created_at,
    updated_at:        row.updated_at,
  };
}

// ── GET /api/:brand_id/orders ─────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { brand_id }              = req.params;
  const { status, source, search } = req.query;

  try {
    const rows   = db.getOrders(brand_id, { status, source, search });
    const orders = rows.map(parseOrder);
    res.json({ ok: true, count: orders.length, orders });
  } catch (err) {
    console.error('[orders] query error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/:brand_id/orders/:order_id ───────────────────────────────────────
router.get('/:order_id', (req, res) => {
  const { brand_id, order_id } = req.params;

  try {
    const row = db.getOrder(brand_id, order_id);
    if (!row) return res.status(404).json({ ok: false, error: 'Order not found' });
    res.json({ ok: true, order: parseOrder(row) });
  } catch (err) {
    console.error('[orders] detail error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
