'use strict';

/**
 * GET /api/:brand_id/inventory
 *
 * Reads from inventory_cache.
 * filter=low_stock returns items with quantity < 5.
 */

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db                         = require('../db/db');
const { getIntegrationHealth }   = require('../db/db');

router.get('/', (req, res) => {
  const { brand_id }              = req.params;
  const { source, search, filter } = req.query;

  try {
    const rows = db.getInventory(brand_id, { source, search, filter });

    // getInventory() now returns 1 row per canonical SKU (aggregated across
    // sources).  qty_shopify / qty_locally break out per-source quantities so
    // the frontend can still distinguish "online" vs "showroom" stock.
    const items = rows.map((r) => ({
      sku:          r.sku,
      product_name: r.product_name,
      variant_name: r.variant_name,
      quantity:     r.quantity,
      qty_shopify:  r.qty_shopify || 0,
      qty_locally:  r.qty_locally || 0,
      price:        r.price,
      low_stock:    (r.quantity || 0) < 5,
      updated_at:   r.updated_at,
    }));

    // INTEGRATION_HEALTH_RESPONSE
    const integration_health = {
      shopify: getIntegrationHealth(brand_id, 'shopify'),
      locally: getIntegrationHealth(brand_id, 'locally'),
    };
    res.json({ ok: true, count: items.length, inventory: items, integration_health });
  } catch (err) {
    console.error('[inventory] query error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to load inventory' });
  }
});

module.exports = router;
