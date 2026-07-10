'use strict';

/**
 * blockImpersonation — prevents state mutations during impersonation sessions.
 *
 * An impersonation JWT sets req.user.impersonated_by = 'admin'.
 * This middleware rejects any non-idempotent request (POST, PUT, PATCH, DELETE)
 * made with such a token, returning 403 impersonation_readonly.
 *
 * Safe methods (GET, HEAD, OPTIONS) are always allowed — impersonation is
 * intentionally read-only so admins can see exactly what a brand sees without
 * the risk of accidentally modifying data.
 *
 * Apply AFTER requireAuth / requireBrandOwnership so req.user is populated.
 */

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function blockImpersonation(req, res, next) {
  if (req.user && req.user.impersonated_by && !READ_METHODS.has(req.method)) {
    return res.status(403).json({
      ok:      false,
      error:   'impersonation_readonly',
      message: 'Mutations are not allowed during an impersonation session. This action is read-only.',
    });
  }
  next();
}

module.exports = { blockImpersonation };
