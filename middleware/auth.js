'use strict';

/**
 * Auth middleware — enforces JWT authentication and per-brand access control.
 *
 * AUTH_ENABLED:
 *   In production (NODE_ENV=production): always enforced, regardless of env var.
 *   In development: set AUTH_ENABLED=true to enforce, omit/false to disable.
 *   This ensures production deployments are always protected.
 *
 * requireAuth   — verifies JWT, loads user, attaches req.user
 * requireBrand  — verifies the JWT's brandId claim matches the URL :brand_id param
 * requireBrandOwnership — convenience: requireAuth + requireBrand in one call
 *
 * Brand scoping model:
 *   The JWT carries a brandId claim embedded at login/signup.
 *   requireBrand checks: JWT brandId === URL :brand_id param.
 *   If they don't match → 403. No owner-role bypass.
 *   If JWT has no brandId claim → falls back to DB access table check.
 *
 * Token location: Bearer token in Authorization header  OR  __session cookie.
 */

const jwt = require('jsonwebtoken');
const db  = require('../db/db');

// In production, auth is always enforced regardless of the AUTH_ENABLED env var.
// In development, disable with AUTH_ENABLED=false (or by not setting it).
const IS_PROD     = process.env.NODE_ENV === 'production';
const AUTH_ENABLED = IS_PROD || process.env.AUTH_ENABLED === 'true';
const JWT_SECRET   = process.env.JWT_SECRET || 'replace-me-in-env';

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  if (req.cookies && req.cookies.__session) {
    return req.cookies.__session;
  }
  return null;
}

// ── requireAuth ───────────────────────────────────────────────────────────────
// Verifies the JWT, loads the user from DB, attaches req.user.
// When auth is disabled, attaches a stub user so downstream code always has
// req.user available.

function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) {
    req.user = { id: null, email: null, role: 'owner', _stub: true };
    return next();
  }

  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Authentication required' });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    const reason = err.name === 'TokenExpiredError' ? 'Session expired' : 'Invalid token';
    return res.status(401).json({ ok: false, error: reason });
  }

  // ── Impersonation token path (ADMIN PHASE 3) ──────────────────────────────
  // Impersonation JWTs carry impersonated_by='admin' and an
  // impersonation_session_id instead of a regular sessionId.
  // Cross-check the session row to detect admin revocation.
  if (payload.impersonation_session_id) {
    const impSession = db.getImpersonationSession(payload.impersonation_session_id);
    if (!impSession || impSession.revoked) {
      return res.status(401).json({ ok: false, error: 'Impersonation session revoked or not found' });
    }
    // Impersonation JWTs may have userId=0 when the brand has no owner yet.
    // In that case, attach a minimal stub so downstream code doesn't crash.
    const user = payload.userId ? db.getUserById(payload.userId) : null;
    req.user                          = user || { id: 0, email: null, role: 'member', name: null, _stub: true };
    req.user.brandId                  = payload.brandId || null;
    req.user.tier                     = payload.tier    || 'free';
    req.user.impersonated_by          = payload.impersonated_by;       // 'admin'
    req.user.impersonation_session_id = payload.impersonation_session_id;
    req.isImpersonation               = true;
    req.sessionId                     = null;
    return next();
  }

  // ── Regular session path ────────────────────────────────────────────────────
  // Validate against DB session (stateful check — detects logout/revocation)
  if (payload.sessionId) {
    const session = db.getSessionById(payload.sessionId);
    if (!session) {
      return res.status(401).json({ ok: false, error: 'Session not found or expired' });
    }
  }

  const user = db.getUserById(payload.userId);
  if (!user) {
    return res.status(401).json({ ok: false, error: 'User not found' });
  }

  req.user          = user;
  req.user.brandId  = payload.brandId || null;   // BRAND_SCOPE — from JWT claim
  req.user.tier     = payload.tier    || 'free'; // TIER_SYSTEM — embedded at login, refreshed via /api/me polling
  req.isImpersonation = false;
  req.sessionId     = payload.sessionId || null;
  next();
}

// ── requireBrand ──────────────────────────────────────────────────────────────
// Must run after requireAuth. Enforces that the authenticated user owns the
// :brand_id in the URL. No role-based bypasses — every user, including owners,
// must pass this check.
//
// Scoping logic:
//   1. JWT carries brandId claim (set at login) → must match URL :brand_id exactly.
//   2. JWT has no brandId claim (edge case) → fall back to DB user_brands check.
//   Either way, if the check fails → 403. An owner cannot access another brand's
//   data by changing the URL, even with a valid token.

function requireBrand(req, res, next) {
  if (!AUTH_ENABLED) return next();
  if (!req.user)      return res.status(401).json({ ok: false, error: 'Not authenticated' });
  if (req.user._stub) return next();

  const { brand_id } = req.params;
  if (!brand_id) return next(); // route has no :brand_id param — no check needed

  const jwtBrandId = req.user.brandId; // BRAND_SCOPE — embedded by requireAuth from JWT

  if (jwtBrandId) {
    // Primary gate: JWT brand must match the URL brand. Period.
    if (jwtBrandId !== brand_id) {
      return res.status(403).json({ ok: false, error: 'Access denied — token not valid for this brand' });
    }
    return next(); // match confirmed
  }

  // Fallback: JWT has no brandId claim — verify via DB access table.
  // This handles edge cases (e.g. tokens issued before brand was assigned).
  const hasAccess = db.userHasBrandAccess(req.user.id, brand_id);
  if (!hasAccess) {
    return res.status(403).json({ ok: false, error: 'Access denied to this brand' });
  }

  next();
}

// ── requireBrandOwnership ─────────────────────────────────────────────────────
// BRAND_OWNERSHIP_CHECK
// Convenience middleware that combines requireAuth + requireBrand in one call.
// Attach to any /api/:brand_id/* route to enforce both authentication and
// per-brand access in a single line.
//
// Usage:
//   const { requireBrandOwnership } = require('../middleware/auth');
//   app.use('/api/:brand_id/orders', requireBrandOwnership, ordersRouter);

function requireBrandOwnership(req, res, next) {
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    requireBrand(req, res, next);
  });
}

module.exports = { requireAuth, requireBrand, requireBrandOwnership };
