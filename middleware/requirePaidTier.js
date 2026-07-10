'use strict';

/**
 * requirePaidTier — gate any route to paid-tier brands only.
 *
 * Must run AFTER requireAuth (req.user must already be set).
 * Reads req.user.tier, which is embedded in the JWT at login and attached by
 * requireAuth. Returns HTTP 403 with a machine-readable error code so the
 * frontend can show the upgrade prompt without hitting a confusing error page.
 *
 * Response on failure:
 *   HTTP 403  { ok: false, error: 'upgrade_required', tier: 'free' }
 *
 * Usage:
 *   const { requirePaidTier } = require('../middleware/requirePaidTier');
 *   router.get('/some-paid-route', requireAuth, requirePaidTier, handler);
 *
 *   Or as a router-level guard:
 *   app.use('/api/:brand_id/locally', requireBrandOwnership, requirePaidTier, locallyRouter);
 */

const IS_PROD     = process.env.NODE_ENV === 'production';
const AUTH_ENABLED = IS_PROD || process.env.AUTH_ENABLED === 'true';

function requirePaidTier(req, res, next) {
  // Pass-through when auth is disabled (dev mode) or stub user
  if (!AUTH_ENABLED || (req.user && req.user._stub)) return next();

  const tier = req.user?.tier || 'free';

  if (tier === 'paid') return next();

  return res.status(403).json({
    ok:    false,
    error: 'upgrade_required',
    tier,
  });
}

module.exports = { requirePaidTier };
