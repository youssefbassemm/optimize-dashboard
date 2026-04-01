'use strict';

/**
 * /api/:brand_id/locally
 *
 * POST /upload   — import orders from a CSV file (multer upload, field name: "file")
 * POST /sync     — trigger an immediate Locally API sync
 * GET  /template — download a blank CSV template
 *
 * CSV format expected by importCSV():
 *   date, customer_name, phone, city, items, total, payment_method
 *
 * "items" column: semicolon-separated "Name x Qty @ Price"
 *   e.g.  "Blue Hoodie x 2 @ 750;Black Cap x 1 @ 350"
 */

const express  = require('express');
const multer   = require('multer');
const router   = express.Router({ mergeParams: true });
const locally  = require('../integrations/locally');
const { getIntegration } = require('../db/db');

// Store upload in memory (CSV files are small)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },   // 5 MB max
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.originalname.toLowerCase().endsWith('.csv')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are accepted'));
    }
  },
});

// ── POST /api/:brand_id/locally/upload ────────────────────────────────────────
router.post('/upload', upload.single('file'), (req, res) => {
  const { brand_id } = req.params;

  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'No file uploaded — send field name "file"' });
  }

  try {
    const result = locally.importCSV(brand_id, req.file.buffer);
    res.json({
      ok:     true,
      count:  result.count,
      errors: result.errors,
      message: result.errors.length
        ? `Imported ${result.count} orders with ${result.errors.length} row error(s)`
        : `Imported ${result.count} orders successfully`,
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ── POST /api/:brand_id/locally/sync ──────────────────────────────────────────
router.post('/sync', (req, res) => {
  try {
    const { brand_id } = req.params;

    const integration = getIntegration(brand_id, 'locally');
    if (!integration || integration.status === 'disconnected') {
      return res.status(400).json({ ok: false, error: 'Locally integration not connected' });
    }

    res.json({ ok: true, message: 'Locally sync started' });

    setImmediate(async () => {
      try {
        await locally.fullSync(brand_id);
      } catch (err) {
        console.error(`[locally/sync] error brand=${brand_id}:`, err.message);
      }
    });
  } catch (err) {
    console.error('[locally/sync] error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to start sync' });
  }
});

// ── GET /api/:brand_id/locally/template ───────────────────────────────────────
router.get('/template', (_req, res) => {
  const header  = 'date,customer_name,phone,city,items,total,payment_method';
  const example = '2025-01-15,Ahmed Mohamed,01012345678,Cairo,Blue Hoodie x 2 @ 750;Black Cap x 1 @ 350,1850,cash';

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="locally_orders_template.csv"');
  res.send(`${header}\n${example}\n`);
});

// ── Multer error handler ───────────────────────────────────────────────────────
router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError || err.message) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  res.status(500).json({ ok: false, error: 'Upload failed' });
});

module.exports = router;
