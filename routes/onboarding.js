'use strict';

/**
 * ONBOARDING_FLOW
 *
 * GET  /api/:brand_id/onboarding        — return current onboarding state
 * POST /api/:brand_id/onboarding        — advance step, complete, or dismiss checklist
 *
 * Protected by requireBrandOwnership (mounted in server.js).
 * All mutations write to the brands table via db helpers.
 */

const express = require('express');
const router  = express.Router({ mergeParams: true });
const {
  getBrand,
  getBrandTier,
  updateOnboardingStep,
  markBrandOnboarded,
  setChecklistDismissed,
  getAllIntegrations,
} = require('../db/db');
const db = require('../db/db');

// ── TIER_SYSTEM — required integrations per tier ───────────────────────────────
//
// Free:  Shopify (sales data) + Instagram (basic display via Meta connect).
//        'instagram' maps to the meta platform integration — free users can
//        connect Meta to get basic Instagram display without the Ads suite.
//
// Paid:  Full suite.  'shipping' is the shared step name from the onboarding
//        wizard (STEPS includes 'shipping') and lets the user pick ShipBlu or
//        Bosta. Both are paid-only integrations; the step name is stable.
//        'locally' is only required when the brand has a showroom.
//
function getRequiredIntegrations(tier, hasShowroom) {
  if (tier === 'paid') {
    return hasShowroom
      ? ['shopify', 'instagram', 'locally', 'shipping', 'meta']
      : ['shopify', 'instagram', 'shipping', 'meta'];
  }
  return ['shopify', 'instagram'];
}

// Valid step names in order — used for validation only.
const STEPS = ['welcome', 'shopify', 'showroom', 'locally', 'shipping', 'meta', 'done'];

// ── GET /api/:brand_id/onboarding ────────────────────────────────────────────
// Returns current onboarding state and connected-integration summary.
// Used by both the onboarding page (to resume mid-flow) and the dashboard
// boot sequence (to decide whether to show the setup checklist card).
router.get('/', (req, res) => {
  const { brand_id } = req.params;

  try {
    const brand = getBrand(brand_id);
    if (!brand) {
      return res.status(404).json({ ok: false, error: 'Brand not found' });
    }

    // Build a compact map of which integrations are currently connected
    // so the frontend can render the checklist card without extra round trips.
    const integrations = getAllIntegrations(brand_id);
    const connected    = {};
    for (const row of (integrations || [])) {
      connected[row.platform] = row.status === 'connected';
    }

    // TIER_SYSTEM — surface which integrations the checklist should prompt for.
    // Free:  ['shopify', 'instagram']  — basics for dashboard to show real data
    // Paid (showroom):   ['shopify', 'instagram', 'locally', 'shipping', 'meta']
    // Paid (online-only): ['shopify', 'instagram', 'shipping', 'meta']
    // 'instagram' maps to the meta platform (same connect flow, sub-scope).
    // 'shipping' is the wizard step name; user picks ShipBlu or Bosta inside it.
    const tier                   = getBrandTier(brand_id);
    const hasShowroom            = brand.has_showroom === 1;
    const required_integrations  = getRequiredIntegrations(tier, hasShowroom);

    return res.json({
      ok:                  true,
      onboarding_step:     brand.onboarding_step     || 'welcome',
      onboarded_at:        brand.onboarded_at        || null,
      checklist_dismissed: brand.checklist_dismissed === 1,
      needs_onboarding:    !brand.onboarded_at,
      tier,
      required_integrations,
      has_showroom:        hasShowroom,
      showroom_platform:   brand.showroom_platform || null,
      connected,          // { shopify: bool, locally: bool, shipblu: bool, meta: bool, bosta: bool }
    });
  } catch (err) {
    console.error('[onboarding] GET error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to load onboarding state' });
  }
});

// ── POST /api/:brand_id/onboarding ───────────────────────────────────────────
// Body: { action, step? }
//
// action = 'advance'          — move to the given step (validate step name)
// action = 'complete'         — mark onboarding done (sets onboarded_at, step='done')
// action = 'dismiss_checklist'— set checklist_dismissed = 1 (permanent)
//
// All actions are idempotent — calling them multiple times is safe.
router.post('/', (req, res) => {
  const { brand_id }          = req.params;
  const { action, step }      = req.body || {};

  if (!action) {
    return res.status(400).json({ ok: false, error: 'action is required' });
  }

  try {
    const brand = getBrand(brand_id);
    if (!brand) {
      return res.status(404).json({ ok: false, error: 'Brand not found' });
    }

    if (action === 'advance') {
      if (!step || !STEPS.includes(step)) {
        return res.status(400).json({
          ok:    false,
          error: `step must be one of: ${STEPS.join(', ')}`,
        });
      }
      updateOnboardingStep(brand_id, step);
      console.log(`[onboarding] brand=${brand_id} advanced to step=${step}`);
      return res.json({ ok: true, onboarding_step: step });
    }

    if (action === 'complete') {
      markBrandOnboarded(brand_id);
      console.log(`[onboarding] brand=${brand_id} completed onboarding`);
      return res.json({
        ok:              true,
        onboarding_step: 'done',
        needs_onboarding: false,
      });
    }

    if (action === 'dismiss_checklist') {
      setChecklistDismissed(brand_id);
      console.log(`[onboarding] brand=${brand_id} dismissed setup checklist`);
      return res.json({ ok: true, checklist_dismissed: true });
    }

    if (action === 'save_showroom') {
      const { has_showroom, showroom_platform } = req.body;
      const val = has_showroom ? 1 : 0;
      const plat = val === 1 && showroom_platform ? showroom_platform : null;
      db.db.prepare('UPDATE brands SET has_showroom = ?, showroom_platform = ? WHERE id = ?')
        .run(val, plat, brand_id);
      console.log(`[onboarding] brand=${brand_id} showroom=${val} platform=${plat}`);
      return res.json({ ok: true, has_showroom: val, showroom_platform: plat });
    }

    return res.status(400).json({
      ok:    false,
      error: `Unknown action "${action}". Must be one of: advance, complete, dismiss_checklist, save_showroom`,
    });

  } catch (err) {
    console.error('[onboarding] POST error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to update onboarding state' });
  }
});

module.exports = router;
