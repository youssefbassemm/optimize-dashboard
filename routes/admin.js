'use strict';

/**
 * /api/admin — internal admin endpoints.
 * Protected by requireAdminAuth (cookie OR X-Admin-Secret header) applied in server.js.
 *
 * Endpoints:
 *   POST /api/admin/brands/:brand_id/set-tier
 *     Body: { tier: 'free'|'paid', note?: string }
 *     Sets the brand tier atomically with an audit log row.
 *     Also freezes/unfreezes paid integrations on tier change.
 *
 *   GET  /api/admin/brands/:brand_id/tier-history
 *     Returns the full immutable audit trail of tier changes.
 *
 *   GET  /api/admin/events
 *     Query params: brand_id, event_name, since (ISO date), limit (max 1000)
 *     Returns internal analytics events from the events table.
 *
 *   GET  /api/admin/brands
 *     Returns all brands with tier + last_seen_at + owner contact + integration count.
 *
 *   GET  /api/admin/brands/:brand_id/detail
 *     Returns full brand detail: brand row, owner user, all integrations, tier history.
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/db');

// ── POST /api/admin/brands/:brand_id/set-tier ─────────────────────────────────
router.post('/brands/:brand_id/set-tier', (req, res) => {
  const { brand_id } = req.params;
  const { tier, note } = req.body || {};

  if (!tier || !['free', 'paid'].includes(tier)) {
    return res.status(400).json({ ok: false, error: 'tier must be "free" or "paid"' });
  }

  const brand = db.getBrand(brand_id);
  if (!brand) {
    return res.status(404).json({ ok: false, error: `Brand "${brand_id}" not found` });
  }

  const oldTier = brand.tier || 'free';

  // setBrandTier is a no-op if tier is unchanged; still safe to call
  db.setBrandTier(brand_id, tier, 'admin', note || null);

  // Freeze paid integrations on downgrade; unfreeze on upgrade
  if (oldTier === 'paid' && tier === 'free') {
    db.freezePaidIntegrations(brand_id);
    console.log(`[admin] frozen paid integrations for brand=${brand_id} (downgrade)`);
    db.insertEvent(brand_id, null, 'tier_downgrade', { old_tier: oldTier, new_tier: tier, changed_by: 'admin', note: note || null });
  } else if (oldTier === 'free' && tier === 'paid') {
    db.unfreezePaidIntegrations(brand_id);
    console.log(`[admin] unfrozen integrations for brand=${brand_id} (upgrade)`);
    // CX Phase 4 — auto-seed 7 default cx_flows on first upgrade (idempotent)
    try { db.seedCxFlows(brand_id); } catch (e) { console.warn('[admin] seedCxFlows:', e.message); }
    db.insertEvent(brand_id, null, 'tier_upgrade', { old_tier: oldTier, new_tier: tier, changed_by: 'admin', note: note || null });
  }

  return res.json({
    ok:       true,
    brand_id,
    old_tier: oldTier,
    new_tier: tier,
    note:     note || null,
    changed:  oldTier !== tier,
  });
});

// ── GET /api/admin/brands/:brand_id/tier-history ──────────────────────────────
router.get('/brands/:brand_id/tier-history', (req, res) => {
  const { brand_id } = req.params;

  const brand = db.getBrand(brand_id);
  if (!brand) {
    return res.status(404).json({ ok: false, error: `Brand "${brand_id}" not found` });
  }

  const history = db.getTierHistory(brand_id);

  return res.json({
    ok:       true,
    brand_id,
    tier:     brand.tier || 'free',
    history,
  });
});

// ── GET /api/admin/events ─────────────────────────────────────────────────────
router.get('/events', (req, res) => {
  const { brand_id, event_name, since } = req.query;
  // STEP9 — default limit raised to 500 (max 1000 enforced in queryEvents)
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : 500;

  try {
    const events = db.queryEvents({ brand_id, event_name, since, limit });
    return res.json({ ok: true, count: events.length, events });
  } catch (err) {
    console.error('[admin] events query error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to query events' });
  }
});

// ── GET /api/admin/events/firehose ────────────────────────────────────────────
// Auto-refresh-friendly endpoint for the events firehose tab.
// Supports ETag to avoid full payload on unchanged data, since= for incremental.
// Query params: brand_id, event_name, since (ISO), high_priority (1/0), limit (max 200)
const HIGH_PRIORITY = new Set([
  'new_signup_high_revenue', 'simulator_3x_with_shopify', 'talk_to_us',
  'shopify_connected', 'instagram_connected', 'simulator_3x',
]);

router.get('/events/firehose', (req, res) => {
  const { brand_id, event_name, since } = req.query;
  const highOnly = req.query.high_priority === '1';
  const limit    = Math.min(parseInt(req.query.limit, 10) || 100, 200);

  try {
    let events = db.queryEvents({ brand_id, event_name, since, limit });

    if (highOnly) {
      events = events.filter(e => HIGH_PRIORITY.has(e.event_name));
    }

    // Join brand name for display
    const brandNames = {};
    const rows = db.db.prepare('SELECT id, name FROM brands').all();
    rows.forEach(r => { brandNames[r.id] = r.name; });
    events = events.map(e => ({ ...e, brand_name: brandNames[e.brand_id] || e.brand_id }));

    // ETag based on newest event id
    const etag = events.length ? `"${events[0].id}"` : '"empty"';
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, count: events.length, etag, events });
  } catch (err) {
    console.error('[admin] firehose query error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to query events firehose' });
  }
});

// ── POST /api/admin/whatsapp-log ──────────────────────────────────────────────
// Logs a WhatsApp message sent to a brand. Body: { brand_id, template_type, custom_message? }
router.post('/whatsapp-log', (req, res) => {
  const { brand_id, template_type, custom_message } = req.body || {};

  if (!brand_id || !template_type) {
    return res.status(400).json({ ok: false, error: 'brand_id and template_type are required' });
  }

  const brand = db.getBrand(brand_id);
  if (!brand) {
    return res.status(404).json({ ok: false, error: `Brand "${brand_id}" not found` });
  }

  try {
    db.insertEvent(brand_id, null, 'admin_whatsapp_sent', {
      template_type,
      custom_message: custom_message || null,
      sent_by: 'admin',
    });
    console.log(`[admin] whatsapp-log brand=${brand_id} template=${template_type}`);
    return res.json({ ok: true, brand_id, template_type });
  } catch (err) {
    console.error('[admin] whatsapp-log error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to log WhatsApp message' });
  }
});

// ── GET /api/admin/brands ─────────────────────────────────────────────────────
// Returns all brands with tier, last_seen_at, owner contact info, integrations count.
// Owner = the user_brands row with role='owner' (first owner if multiple).
router.get('/brands', (req, res) => {
  try {
    const brands = db.db.prepare(`
      SELECT
        b.id,
        b.name,
        b.slug,
        b.tier,
        b.last_seen_at,
        b.onboarded_at,
        b.created_at,
        b.ig_handle,
        b.revenue_range,
        b.onboarded,
        -- Owner contact (first owner by user_brands.created_at)
        u.id         AS owner_user_id,
        u.name       AS contact_name,
        u.email      AS contact_email,
        u.phone      AS contact_phone,
        -- Connected integration count (status IN connected/warning)
        (SELECT COUNT(*)
         FROM integrations i
         WHERE i.brand_id = b.id
           AND i.status IN ('connected','warning')
        ) AS integrations_count
      FROM brands b
      LEFT JOIN user_brands ub ON ub.brand_id = b.id AND ub.role = 'owner'
      LEFT JOIN users u        ON u.id = ub.user_id
      GROUP BY b.id
      ORDER BY b.last_seen_at DESC
    `).all();

    return res.json({ ok: true, count: brands.length, brands });
  } catch (err) {
    console.error('[admin] brands list error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to list brands' });
  }
});

// ── GET /api/admin/brands/:brand_id/detail ────────────────────────────────────
// Full detail for one brand: brand row + owner user + all integrations + tier history.
router.get('/brands/:brand_id/detail', (req, res) => {
  const { brand_id } = req.params;

  try {
    const brand = db.getBrand(brand_id);
    if (!brand) {
      return res.status(404).json({ ok: false, error: `Brand "${brand_id}" not found` });
    }

    // Owner user
    const owner = db.db.prepare(`
      SELECT u.id, u.name, u.email, u.phone, u.role, u.created_at, u.last_login_at
      FROM users u
      JOIN user_brands ub ON ub.user_id = u.id
      WHERE ub.brand_id = ? AND ub.role = 'owner'
      ORDER BY ub.created_at ASC
      LIMIT 1
    `).get(brand_id);

    // All integrations (strip encrypted credentials)
    const integrations = db.db.prepare(`
      SELECT id, brand_id, platform, status, last_sync, token_expires_at,
             created_at, health, last_error, last_tested_at, sync_paused
      FROM integrations
      WHERE brand_id = ?
      ORDER BY platform
    `).all(brand_id);

    // Tier history
    const tierHistory = db.getTierHistory(brand_id);

    return res.json({
      ok:            true,
      brand:         { ...brand },
      owner:         owner || null,
      integrations,
      tier_history:  tierHistory,
    });
  } catch (err) {
    console.error('[admin] brand detail error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to load brand detail' });
  }
});

// ── DELETE /api/admin/brands/:brand_id ───────────────────────────────────────
router.delete('/brands/:brand_id', (req, res) => {
  const { brand_id } = req.params;
  if (!brand_id) return res.status(400).json({ ok: false, error: 'brand_id required' });

  try {
    const brand = db.getBrand(brand_id);
    if (!brand) return res.status(404).json({ ok: false, error: 'Brand not found' });

    db.db.transaction(() => {
      db.db.prepare('DELETE FROM cx_messages           WHERE brand_id = ?').run(brand_id);
      db.db.prepare('DELETE FROM cx_flows              WHERE brand_id = ?').run(brand_id);
      db.db.prepare('DELETE FROM cx_settings           WHERE brand_id = ?').run(brand_id);
      db.db.prepare('DELETE FROM impersonation_sessions WHERE brand_id = ?').run(brand_id);
      db.db.prepare('DELETE FROM integrations          WHERE brand_id = ?').run(brand_id);
      db.db.prepare('DELETE FROM tier_changes          WHERE brand_id = ?').run(brand_id);
      db.db.prepare('DELETE FROM events                WHERE brand_id = ?').run(brand_id);
      db.db.prepare('DELETE FROM orders_cache          WHERE brand_id = ?').run(brand_id);
      db.db.prepare('DELETE FROM inventory_cache       WHERE brand_id = ?').run(brand_id);
      db.db.prepare('DELETE FROM campaign_cache        WHERE brand_id = ?').run(brand_id);
      db.db.prepare('DELETE FROM ig_cache              WHERE brand_id = ?').run(brand_id);
      db.db.prepare('DELETE FROM sync_logs             WHERE brand_id = ?').run(brand_id);
      db.db.prepare('DELETE FROM webhook_queue         WHERE brand_id = ?').run(brand_id);
      // Remove user-brand links; delete orphaned users
      const userIds = db.db.prepare('SELECT user_id FROM user_brands WHERE brand_id = ?')
        .all(brand_id).map(r => r.user_id);
      db.db.prepare('DELETE FROM user_brands WHERE brand_id = ?').run(brand_id);
      for (const uid of userIds) {
        const remaining = db.db.prepare('SELECT 1 FROM user_brands WHERE user_id = ?').get(uid);
        if (!remaining) {
          db.db.prepare('DELETE FROM sessions               WHERE user_id = ?').run(uid);
          db.db.prepare('DELETE FROM password_reset_tokens  WHERE user_id = ?').run(uid);
          db.db.prepare('DELETE FROM users                  WHERE id = ?').run(uid);
        }
      }
      db.db.prepare('DELETE FROM brands WHERE id = ?').run(brand_id);
    })();

    console.log(`[admin] deleted brand=${brand_id}`);
    return res.json({ ok: true, deleted: brand_id });
  } catch (err) {
    console.error('[admin] brand delete error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
