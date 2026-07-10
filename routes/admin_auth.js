'use strict';

/**
 * /api/admin/auth — Admin session management.
 * Mounted PUBLIC (before requireAdminAuth guard) in server.js.
 *
 * POST /api/admin/auth/login   — validate ADMIN_SECRET, set admin_session cookie.
 * POST /api/admin/auth/logout  — clear admin_session cookie.
 * GET  /api/admin/auth/check   — return 200 if authenticated, 401 otherwise.
 */

const express = require('express');
const router  = express.Router();

const {
  issueAdminCookie,
  clearAdminCookie,
  requireAdminAuth,
} = require('../middleware/requireAdminAuth');

const ADMIN_SECRET = process.env.ADMIN_SECRET;

// ── POST /api/admin/auth/login ────────────────────────────────────────────────
// Body: { secret: '<ADMIN_SECRET>' }
// On success: sets admin_session cookie + returns { ok: true }.
router.post('/login', (req, res) => {
  if (!ADMIN_SECRET) {
    return res.status(503).json({
      ok:    false,
      error: 'Admin access not configured — set ADMIN_SECRET in your environment',
    });
  }

  const { secret } = req.body || {};
  if (!secret || secret !== ADMIN_SECRET) {
    console.warn('[admin-auth] failed login attempt from IP:', req.ip);
    return res.status(401).json({ ok: false, error: 'Invalid admin secret' });
  }

  issueAdminCookie(res);
  console.log('[admin-auth] admin login from IP:', req.ip);

  return res.json({ ok: true, message: 'Logged in as admin' });
});

// ── POST /api/admin/auth/logout ───────────────────────────────────────────────
router.post('/logout', (req, res) => {
  clearAdminCookie(res);
  return res.json({ ok: true, message: 'Logged out' });
});

// ── GET /api/admin/auth/check ─────────────────────────────────────────────────
// Used by the SPA on initial load to verify session without full data fetch.
router.get('/check', requireAdminAuth, (req, res) => {
  return res.json({ ok: true, admin: true });
});

module.exports = router;
