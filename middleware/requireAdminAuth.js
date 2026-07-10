'use strict';

/**
 * requireAdminAuth — cookie + header hybrid authentication for the admin dashboard.
 *
 * Two authentication paths (checked in order):
 *   1. X-Admin-Secret header — backward-compat for curl / scripts. Validates
 *      directly against ADMIN_SECRET. No cookie issued.
 *   2. admin_session cookie — browser SPA path. Cookie contains a JWT signed
 *      with ADMIN_SESSION_SECRET. Issued by POST /api/admin/auth/login.
 *
 * Exports:
 *   issueAdminCookie(res)  — signs a JWT and sets the admin_session cookie.
 *   clearAdminCookie(res)  — clears the admin_session cookie.
 *   requireAdminAuth       — API middleware; returns 401 JSON on failure.
 *   requireAdminPage       — page middleware; redirects to /admin/login on failure.
 *
 * Environment vars:
 *   ADMIN_SECRET          — the admin passphrase (shared with the old header auth).
 *   ADMIN_SESSION_SECRET  — JWT signing secret for admin cookies. If unset, an
 *                           ephemeral secret is generated at startup (sessions won't
 *                           survive restarts). Generate with:
 *                           node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
 */

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');

const ADMIN_SECRET = process.env.ADMIN_SECRET;

// ADMIN_SESSION_SECRET — separate from JWT_SECRET used for brand sessions.
// Ephemeral fallback: sessions work until next restart; fine for dev.
let ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET;
if (!ADMIN_SESSION_SECRET) {
  ADMIN_SESSION_SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('[admin-auth] WARNING: ADMIN_SESSION_SECRET not set — generating ephemeral secret.');
  console.warn('[admin-auth]          Admin sessions will NOT survive server restarts.');
  console.warn('[admin-auth]          Set ADMIN_SESSION_SECRET in .env for persistent sessions.');
}

const COOKIE_NAME = 'admin_session';
const TOKEN_TTL   = '24h';
const COOKIE_TTL  = 24 * 60 * 60 * 1000; // 24 h in ms

// ── Token helpers ─────────────────────────────────────────────────────────────

function signToken(payload) {
  return jwt.sign(payload, ADMIN_SESSION_SECRET, { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, ADMIN_SESSION_SECRET);
  } catch (_) {
    return null;
  }
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

function issueAdminCookie(res) {
  const token = signToken({ admin: true });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   COOKIE_TTL,
    path:     '/',
  });
  return token;
}

function clearAdminCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// ── API middleware (returns JSON 401) ─────────────────────────────────────────

function requireAdminAuth(req, res, next) {
  // Path 1 — X-Admin-Secret header (curl / backward compat)
  const headerSecret = req.headers['x-admin-secret'];
  if (headerSecret) {
    if (!ADMIN_SECRET) {
      return res.status(503).json({
        ok:    false,
        error: 'Admin access not configured — set ADMIN_SECRET in your environment',
      });
    }
    if (headerSecret === ADMIN_SECRET) return next();
    return res.status(401).json({ ok: false, error: 'Invalid X-Admin-Secret header' });
  }

  // Path 2 — admin_session cookie (browser SPA)
  const cookie = req.cookies && req.cookies[COOKIE_NAME];
  if (!cookie) {
    return res.status(401).json({ ok: false, error: 'Admin authentication required' });
  }
  const decoded = verifyToken(cookie);
  if (!decoded || !decoded.admin) {
    clearAdminCookie(res);
    return res.status(401).json({ ok: false, error: 'Invalid or expired admin session' });
  }
  next();
}

// ── Page middleware (redirects to /admin/login) ───────────────────────────────

function requireAdminPage(req, res, next) {
  const cookie = req.cookies && req.cookies[COOKIE_NAME];
  if (!cookie) return res.redirect('/admin/login');
  const decoded = verifyToken(cookie);
  if (!decoded || !decoded.admin) {
    clearAdminCookie(res);
    return res.redirect('/admin/login');
  }
  next();
}

module.exports = {
  signToken,
  verifyToken,
  issueAdminCookie,
  clearAdminCookie,
  requireAdminAuth,
  requireAdminPage,
};
