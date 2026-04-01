'use strict';

/**
 * GET  /api/:brand_id/settings  — return brand config
 * POST /api/:brand_id/settings  — update brand config
 */

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../db/db');

// ── GET ───────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const brand = db.getBrand(req.params.brand_id);
    if (!brand) return res.status(404).json({ ok: false, error: 'Brand not found' });

    res.json({
      ok: true,
      settings: {
        id:           brand.id,
        name:         brand.name,
        slug:         brand.slug,
        logo_url:     brand.logo_url,
        theme_config: JSON.parse(brand.theme_config || '{}'),
        created_at:   brand.created_at,
      },
    });
  } catch (err) {
    console.error('[settings] GET error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to load settings' });
  }
});

// ── POST ──────────────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  try {
    const { brand_id }                     = req.params;
    const { name, logo_url, theme_config } = req.body;

    const brand = db.getBrand(brand_id);
    if (!brand) return res.status(404).json({ ok: false, error: 'Brand not found' });

    if (theme_config !== undefined && (typeof theme_config !== 'object' || Array.isArray(theme_config))) {
      return res.status(400).json({ ok: false, error: 'theme_config must be an object' });
    }

    db.upsertBrand({
      id:           brand_id,
      name:         name         ?? brand.name,
      slug:         brand.slug,
      logo_url:     logo_url     ?? brand.logo_url,
      theme_config: theme_config ? JSON.stringify(theme_config) : brand.theme_config,
    });

    res.json({ ok: true, message: 'Settings updated' });
  } catch (err) {
    console.error('[settings] POST error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
