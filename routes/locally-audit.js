'use strict';

// DEBUG_LOCALLY_AUDIT — temporary diagnostic endpoint
// GET /api/:brand_id/debug/locally-audit
// READ-ONLY: does not modify any data.

const express = require('express');
const router  = express.Router({ mergeParams: true });
const { db }  = require('../db/db');

router.get('/locally-audit', (req, res) => { // DEBUG_LOCALLY_AUDIT
  const { brand_id } = req.params;
  try {
    const rows = db.prepare(
      "SELECT source_order_id, total, financial_status FROM orders_cache WHERE brand_id = ? AND source = 'locally'"
    ).all(brand_id);

    let loc_rows = 0, imp_rows = 0, csv_rows = 0, other_rows = 0;
    let loc_revenue = 0, imp_revenue = 0, csv_revenue = 0;
    const loc_ids = [], imp_ids = [], csv_ids = [];

    for (const r of rows) {
      const id   = r.source_order_id || '';
      const paid = r.financial_status === 'paid';
      const amt  = parseFloat(r.total) || 0;
      if (id.startsWith('loc-')) {
        loc_rows++;
        if (paid) loc_revenue += amt;
        if (loc_ids.length < 5) loc_ids.push(id);
      } else if (id.startsWith('imp-')) {
        imp_rows++;
        if (paid) imp_revenue += amt;
        if (imp_ids.length < 5) imp_ids.push(id);
      } else if (id.startsWith('csv-')) {
        csv_rows++;
        if (paid) csv_revenue += amt;
        if (csv_ids.length < 5) csv_ids.push(id);
      } else {
        other_rows++;
      }
    }

    res.json({
      ok: true,
      brand_id,
      total_locally_rows:  rows.length,
      loc_prefixed_rows:   loc_rows,
      imp_prefixed_rows:   imp_rows,
      csv_prefixed_rows:   csv_rows,
      other_prefixed_rows: other_rows,
      loc_total_revenue:   parseFloat(loc_revenue.toFixed(2)),
      imp_total_revenue:   parseFloat(imp_revenue.toFixed(2)),
      csv_total_revenue:   parseFloat(csv_revenue.toFixed(2)),
      sample_loc_ids:      loc_ids,
      sample_imp_ids:      imp_ids,
      sample_csv_ids:      csv_ids,
    });
  } catch (err) {
    console.error('[locally-audit] error:', err.message);
    res.status(500).json({ ok: false, error: 'Audit failed' });
  }
});

module.exports = router;
