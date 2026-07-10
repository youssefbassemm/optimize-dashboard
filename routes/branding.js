'use strict';

/**
 * Brand customisation routes.
 *
 * Mounted at /api/:brand_id/branding  (requires requireBrandOwnership + blockImpersonation)
 *
 * POST   /api/:brand_id/branding/logo    — upload logo (multipart, ≤500 KB)
 * DELETE /api/:brand_id/branding/logo    — remove logo
 * POST   /api/:brand_id/branding/color   — set accent color (whitelist of 16)
 * DELETE /api/:brand_id/branding/color   — clear accent color
 */

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const db      = require('../db/db');

const router  = express.Router({ mergeParams: true });

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 500 * 1024; // 500 KB

/** The 16 approved accent hex values — server-enforced whitelist. */
const ACCENT_COLORS = new Set([
  '#1B2B5A', // Navy
  '#1E3A8A', // Deep Blue
  '#2563EB', // Royal
  '#4338CA', // Indigo
  '#6B21A8', // Plum
  '#881337', // Burgundy
  '#7F1D1D', // Wine
  '#14532D', // Forest
  '#3D5C2B', // Olive
  '#78350F', // Bronze
  '#B45309', // Copper
  '#C2410C', // Terracotta
  '#374151', // Charcoal
  '#475569', // Slate
  '#A8A29E', // Stone
  '#F5F0E8', // Ivory
]);

// ── Logo upload directory ─────────────────────────────────────────────────────

const LOGOS_DIR = path.join(__dirname, '..', 'public', 'uploads', 'logos');
if (!fs.existsSync(LOGOS_DIR)) {
  fs.mkdirSync(LOGOS_DIR, { recursive: true });
}

// ── Multer storage ────────────────────────────────────────────────────────────
// Files are saved as `<brand_id>.<ext>` — one logo per brand, auto-replaces the old one.

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LOGOS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    cb(null, `${req.params.brand_id}${ext}`);
  },
});

/** Only PNG, JPG, SVG, WebP allowed. */
function fileFilter(req, file, cb) {
  const allowed = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(Object.assign(new Error('Only PNG, JPG, SVG, and WebP images are allowed.'), { status: 422 }));
  }
}

const upload = multer({
  storage,
  limits:     { fileSize: MAX_FILE_SIZE },
  fileFilter,
});

// ── POST /logo ────────────────────────────────────────────────────────────────
router.post('/logo', upload.single('logo'), async (req, res) => {
  try {
    const { brand_id } = req.params;

    // BRAND_WRITE_GUARD
    const jwtBrandId = req.user?.brandId;
    if (jwtBrandId && jwtBrandId !== brand_id) {
      return res.status(403).json({ ok: false, error: 'Cannot modify another brand\'s settings' });
    }

    if (!req.file) {
      return res.status(422).json({ ok: false, error: 'No file uploaded.' });
    }

    // Public URL served by express.static from public/
    const logoUrl = `/uploads/logos/${req.file.filename}`;
    db.setBrandLogo(brand_id, logoUrl);

    console.log(`[branding] logo set — brand=${brand_id} url=${logoUrl}`);
    return res.json({ ok: true, logo_url: logoUrl });
  } catch (err) {
    // Multer size-limit error
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(422).json({ ok: false, error: 'Logo must be 500 KB or smaller.' });
    }
    if (err.status === 422) {
      return res.status(422).json({ ok: false, error: err.message });
    }
    console.error('[branding] logo upload error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to upload logo.' });
  }
});

// ── DELETE /logo ──────────────────────────────────────────────────────────────
router.delete('/logo', (req, res) => {
  try {
    const { brand_id } = req.params;
    const jwtBrandId = req.user?.brandId;
    if (jwtBrandId && jwtBrandId !== brand_id) {
      return res.status(403).json({ ok: false, error: 'Cannot modify another brand\'s settings' });
    }

    // Remove the file from disk (any extension)
    const exts = ['.png', '.jpg', '.jpeg', '.svg', '.webp'];
    for (const ext of exts) {
      const fp = path.join(LOGOS_DIR, `${brand_id}${ext}`);
      if (fs.existsSync(fp)) {
        try { fs.unlinkSync(fp); } catch (_) {}
        break;
      }
    }

    db.clearBrandLogo(brand_id);
    console.log(`[branding] logo cleared — brand=${brand_id}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[branding] logo delete error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to remove logo.' });
  }
});

// ── POST /color ───────────────────────────────────────────────────────────────
router.post('/color', express.json(), (req, res) => {
  try {
    const { brand_id } = req.params;
    const jwtBrandId = req.user?.brandId;
    if (jwtBrandId && jwtBrandId !== brand_id) {
      return res.status(403).json({ ok: false, error: 'Cannot modify another brand\'s settings' });
    }

    const { color } = req.body || {};
    const hex = String(color || '').trim().toLowerCase();
    // Normalise to uppercase for lookup
    const hexUpper = hex.toUpperCase();

    // Whitelist check — try both cases
    if (!ACCENT_COLORS.has(hex) && !ACCENT_COLORS.has(hexUpper)) {
      return res.status(422).json({ ok: false, error: 'Color not in approved palette.' });
    }

    // Store the exact case from the whitelist
    const stored = ACCENT_COLORS.has(hex) ? hex : hexUpper;
    db.setBrandColor(brand_id, stored);

    console.log(`[branding] color set — brand=${brand_id} color=${stored}`);
    return res.json({ ok: true, brand_color: stored });
  } catch (err) {
    console.error('[branding] color set error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to set brand color.' });
  }
});

// ── DELETE /color ─────────────────────────────────────────────────────────────
router.delete('/color', (req, res) => {
  try {
    const { brand_id } = req.params;
    const jwtBrandId = req.user?.brandId;
    if (jwtBrandId && jwtBrandId !== brand_id) {
      return res.status(403).json({ ok: false, error: 'Cannot modify another brand\'s settings' });
    }

    db.clearBrandColor(brand_id);
    console.log(`[branding] color cleared — brand=${brand_id}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[branding] color delete error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to clear brand color.' });
  }
});

module.exports = router;
