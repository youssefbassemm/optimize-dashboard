'use strict';

/**
 * GET /api/me
 *
 * API_ME_ENDPOINT
 *
 * Top-level identity endpoint — returns everything the frontend needs on
 * page load to configure the dashboard: brand_id, brand_name, onboarded
 * status, and which integrations are connected.
 *
 * Does NOT use authGuard — works in both AUTH_ENABLED=true and false modes.
 * When AUTH_ENABLED=false, returns { dev_mode: true } so the frontend can
 * fall back to localStorage values without redirecting to /signin.
 *
 * Response shape:
 *   { ok: true, dev_mode: true }                      ← auth disabled
 *   { ok: true, user_id, email, brand_id, brand_name, onboarded, integrations_connected }
 */

const express       = require('express');
const router        = express.Router();
const db            = require('../db/db');
const { requireAuth } = require('../middleware/auth');

// GET /api/me
// API_ME_ENDPOINT
router.get('/', requireAuth, (req, res) => {
  try {
    // Auth disabled — pass-through stub user
    // REMOVE_SEED_HARDCODING — never return a hardcoded brand_id
    if (req.user._stub) {
      return res.json({ ok: true, dev_mode: true });
    }

    // Resolve brand_id from JWT claim first, then from user_brands
    const jwtBrandId = req.user.brandId || null;
    const brands     = db.getUserBrands(req.user.id);
    const brandId    = jwtBrandId || (brands.length > 0 ? brands[0].id : null);

    if (!brandId) {
      // User exists but has no brand — should not happen after signup
      // Return 404 so the frontend can redirect to signup/onboarding
      return res.status(404).json({
        ok:    false,
        error: 'No brand found for this account. Please complete signup.',
      });
    }

    const brandRow = db.getBrand(brandId);

    // TIER_SYSTEM — update last_seen_at on every /api/me call.
    // Non-blocking: we don't await this. The dashboard polls every 60s.
    try { db.updateBrandLastSeen(brandId); } catch (_) {}

    // INTEGRATION_BRAND_SCOPE — integrations are always scoped to brand_id
    const integrationRows    = db.getAllIntegrations(brandId);
    const integrations_connected = integrationRows
      .filter(i => i.status === 'connected')
      .map(i => i.platform);

    // BRAND_WORKSPACE_CREATION — surface onboarded flag
    const onboarded = !!(brandRow?.onboarded);

    // TIER_SYSTEM — tier is read directly from DB here so the polling response
    // always reflects the current tier, even if the JWT is stale from before the
    // last admin tier change.  The frontend detects a change and calls onTierChange().
    const tier = brandRow?.tier || 'free';

    return res.json({
      ok:                    true,
      user_id:               req.user.id,
      email:                 req.user.email,
      brand_id:              brandId,
      brand_name:            brandRow?.name || brandId,
      onboarded,
      tier,
      integrations_connected,
      // BRANDING — expose accent color and logo so the frontend can apply them on load
      brand_color:           brandRow?.brand_color  || null,
      logo_url:              brandRow?.logo_url     || null,
      business_type:         brandRow?.business_type || 'ecommerce',
    });
  } catch (err) {
    console.error('[me] GET /api/me error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to load identity' });
  }
});

module.exports = router;
