'use strict';

/**
 * GET /api/:brand_id/inventory
 *
 * Reads from inventory_cache.
 * filter=low_stock returns items with quantity < 5.
 */

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../db/db');

router.get('/', (req, res) => {
  const { brand_id }              = req.params;
  const { source, search, filter } = req.query;

  try {
    const rows = db.getInventory(brand_id, { source, search, filter });

    const items = rows.map((r) => ({
      sku:          r.sku,
      product_name: r.product_name,
      variant_name: r.variant_name,
      source:       r.source,
      quantity:     r.quantity,
      price:        r.price,
      low_stock:    r.quantity < 5,
      updated_at:   r.updated_at,
    }));

    res.json({ ok: true, count: items.length, inventory: items });
  } catch (err) {
    console.error('[inventory] query error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
