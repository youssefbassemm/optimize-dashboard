'use strict';

/**
 * /api/admin/leads — Lead queue management for admin Phase 2.
 * All routes protected by requireAdminAuth (applied at server.js mount level).
 *
 *  GET  /api/admin/leads                      — unhandled + handled from last 14 days
 *  POST /api/admin/leads/:event_id/contacted  — mark contacted { notes? }
 *  DELETE /api/admin/leads/:event_id/contacted — unmark (mistake recovery)
 *  GET  /api/admin/leads/count                — unhandled count for badge
 */

const express = require('express');
const router  = express.Router();
const { getLeads, getUnhandledLeadCount, markLeadContacted, unmarkLeadContacted, db: rawDb } = require('../db/db');

// ── GET /api/admin/leads ──────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const leads = getLeads();
    const count = getUnhandledLeadCount();
    return res.json({ ok: true, count: leads.length, unhandled: count, leads });
  } catch (err) {
    console.error('[admin-leads] get leads error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to load leads' });
  }
});

// ── GET /api/admin/leads/count ────────────────────────────────────────────────
// Lightweight poll endpoint for the badge counter.
router.get('/count', (req, res) => {
  try {
    const count = getUnhandledLeadCount();
    return res.json({ ok: true, unhandled: count });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Failed to count leads' });
  }
});

// ── POST /api/admin/leads/:event_id/contacted ─────────────────────────────────
router.post('/:event_id/contacted', (req, res) => {
  const eventId = parseInt(req.params.event_id, 10);
  if (!Number.isFinite(eventId)) {
    return res.status(400).json({ ok: false, error: 'Invalid event_id' });
  }

  // Verify event exists
  const ev = rawDb.prepare('SELECT id FROM events WHERE id = ?').get(eventId);
  if (!ev) {
    return res.status(404).json({ ok: false, error: `Event ${eventId} not found` });
  }

  const { notes } = req.body || {};

  try {
    markLeadContacted(eventId, notes || null);
    console.log(`[admin-leads] marked event=${eventId} as contacted`);
    return res.json({ ok: true, event_id: eventId, action: 'contacted' });
  } catch (err) {
    console.error('[admin-leads] mark contacted error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to mark as contacted' });
  }
});

// ── DELETE /api/admin/leads/:event_id/contacted ───────────────────────────────
router.delete('/:event_id/contacted', (req, res) => {
  const eventId = parseInt(req.params.event_id, 10);
  if (!Number.isFinite(eventId)) {
    return res.status(400).json({ ok: false, error: 'Invalid event_id' });
  }

  try {
    const result = unmarkLeadContacted(eventId);
    console.log(`[admin-leads] unmarked event=${eventId} as contacted`);
    return res.json({ ok: true, event_id: eventId, action: 'uncontacted', removed: result.changes });
  } catch (err) {
    console.error('[admin-leads] unmark contacted error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to unmark contacted' });
  }
});

module.exports = router;
