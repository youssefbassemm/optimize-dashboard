'use strict';

/**
 * /api/brands
 *
 * GET  /         — list brands the authenticated user has access to
 * POST /         — create a new brand (admin role only)
 * GET  /:brand_id — get a single brand (authenticated user must have access)
 *
 * All routes require authentication. GET / returns only the caller's brands.
 * POST / is restricted to admin users — brands are normally created via /api/auth/signup.
 */

const express        = require('express');
const router         = express.Router();
const db             = require('../db/db');
const { requireAuth } = require('../middleware/auth');

// All /api/brands routes require authentication
router.use(requireAuth);

// ── GET /api/brands ───────────────────────────────────────────────────────────
// Returns only brands the authenticated user has access to.
router.get('/', (req, res) => {
  try {
    // Stub user (AUTH_ENABLED=false dev mode) — fall back to all brands
    if (req.user?._stub) {
      const brands = db.db.prepare('SELECT id, name, slug, logo_url, created_at FROM brands ORDER BY created_at ASC').all();
      return res.json({ ok: true, brands });
    }
    const brands = db.getUserBrands(req.user.id);
    res.json({ ok: true, brands });
  } catch (err) {
    console.error('[brands] GET / error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to load brands' });
  }
});

// ── POST /api/brands ──────────────────────────────────────────────────────────
// Admin-only: brands are normally created via /api/auth/signup.
router.post('/', (req, res) => {
  if (!req.user?._stub && req.user?.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Admin access required to create brands directly' });
  }
  const { name, id, logo_url } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ ok: false, error: 'name is required' });
  }

  // Auto-generate slug/id from name if not provided
  const brandId = id
    ? id.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 40)
    : name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

  if (!brandId) {
    return res.status(400).json({ ok: false, error: 'Could not generate a valid brand ID from the provided name' });
  }

  try {
    const existing = db.getBrand(brandId);
    if (existing) {
      return res.status(409).json({ ok: false, error: `Brand "${brandId}" already exists` });
    }

    db.upsertBrand({
      id:           brandId,
      name:         name.trim(),
      slug:         brandId,
      logo_url:     logo_url || null,
      theme_config: '{}',
    });

    const brand = db.getBrand(brandId);
    res.status(201).json({ ok: true, brand });
  } catch (err) {
    console.error('[brands] POST / error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to create brand' });
  }
});

// ── GET /api/brands/:brand_id ─────────────────────────────────────────────────
// Returns brand metadata only if the authenticated user has access to it.
router.get('/:brand_id', (req, res) => {
  try {
    const { brand_id } = req.params;

    // Verify access: JWT brand claim or DB membership (stub bypasses in dev)
    if (!req.user?._stub) {
      const jwtBrandId = req.user?.brandId;
      if (jwtBrandId) {
        if (jwtBrandId !== brand_id) {
          return res.status(403).json({ ok: false, error: 'Access denied to this brand' });
        }
      } else {
        const hasAccess = db.userHasBrandAccess(req.user.id, brand_id);
        if (!hasAccess) {
          return res.status(403).json({ ok: false, error: 'Access denied to this brand' });
        }
      }
    }

    const brand = db.getBrand(brand_id);
    if (!brand) return res.status(404).json({ ok: false, error: 'Brand not found' });
    res.json({ ok: true, brand });
  } catch (err) {
    console.error('[brands] GET /:brand_id error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to load brand' });
  }
});

module.exports = router;
