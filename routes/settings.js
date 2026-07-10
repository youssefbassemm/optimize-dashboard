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

    // BRAND_WRITE_GUARD — defense-in-depth: assert the authenticated user's brand
    // matches the target brand_id before writing. The middleware already checks this,
    // but this makes the write path explicitly safe even if middleware is misconfigured.
    const jwtBrandId = req.user?.brandId;
    if (jwtBrandId && jwtBrandId !== brand_id) {
      return res.status(403).json({ ok: false, error: 'Cannot modify another brand\'s settings' });
    }

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
    res.status(500).json({ ok: false, error: 'Failed to update settings' });
  }
});

// ── GET /api/:brand_id/settings/sales-channel ─────────────────────────────
router.get('/sales-channel', (req, res) => {
  try {
    const brand = db.getBrand(req.params.brand_id);
    if (!brand) return res.status(404).json({ ok: false, error: 'Brand not found' });
    res.json({
      ok: true,
      has_showroom: brand.has_showroom === 1,
      showroom_platform: brand.showroom_platform || null,
    });
  } catch (err) {
    console.error('[settings] sales-channel GET error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to load sales channel settings' });
  }
});

// ── POST /api/:brand_id/settings/sales-channel ────────────────────────────
router.post('/sales-channel', (req, res) => {
  try {
    const { brand_id } = req.params;
    const jwtBrandId = req.user?.brandId;
    if (jwtBrandId && jwtBrandId !== brand_id) {
      return res.status(403).json({ ok: false, error: 'Cannot modify another brand\'s settings' });
    }

    const brand = db.getBrand(brand_id);
    if (!brand) return res.status(404).json({ ok: false, error: 'Brand not found' });

    const { has_showroom, showroom_platform } = req.body;
    const val  = has_showroom ? 1 : 0;
    const plat = val === 1 && showroom_platform ? showroom_platform : null;

    // If switching from showroom → online-only, freeze Locally integration
    const wasShowroom = brand.has_showroom === 1;
    if (wasShowroom && val === 0) {
      db.db.prepare(`UPDATE integrations SET sync_paused = 1 WHERE brand_id = ? AND platform = 'locally'`).run(brand_id);
      console.log(`[settings] brand=${brand_id} downgraded to online-only — Locally paused`);
    }

    db.db.prepare('UPDATE brands SET has_showroom = ?, showroom_platform = ? WHERE id = ?')
      .run(val, plat, brand_id);

    console.log(`[settings] brand=${brand_id} sales-channel updated: has_showroom=${val} platform=${plat}`);
    res.json({ ok: true, has_showroom: val === 1, showroom_platform: plat, was_showroom: wasShowroom });
  } catch (err) {
    console.error('[settings] sales-channel POST error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to update sales channel settings' });
  }
});

module.exports = router;
