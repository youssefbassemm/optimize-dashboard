'use strict';

/**
 * /api/admin/form-leads — Admin endpoints for form submission leads.
 * All routes protected by requireAdminAuth (applied at server.js mount level).
 *
 *  GET   /api/admin/form-leads          — paginated list with filters/search
 *  GET   /api/admin/form-leads/:id      — single lead detail
 *  PATCH /api/admin/form-leads/:id      — update contacted status, notes
 */

const express = require('express');
const router  = express.Router();
const { getFormLeads, getFormLead, updateFormLead } = require('../db/db');

// ── GET /api/admin/form-leads ─────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { page = '1', limit = '50', search = '', revenue = '', booked = '', contacted = '' } = req.query;
  try {
    const result = getFormLeads({
      page:      Math.max(1, parseInt(page, 10) || 1),
      limit:     Math.min(100, Math.max(1, parseInt(limit, 10) || 50)),
      search:    search.trim(),
      revenue:   revenue.trim(),
      booked:    booked.trim(),
      contacted: contacted.trim(),
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[admin-form-leads] list error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to load form leads' });
  }
});

// ── GET /api/admin/form-leads/:id ─────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Invalid id' });
  const lead = getFormLead(id);
  if (!lead) return res.status(404).json({ ok: false, error: 'Lead not found' });
  return res.json({ ok: true, lead });
});

// ── PATCH /api/admin/form-leads/:id ──────────────────────────────────────────
router.patch('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Invalid id' });

  const lead = getFormLead(id);
  if (!lead) return res.status(404).json({ ok: false, error: 'Lead not found' });

  const { contacted, notes } = req.body || {};
  try {
    updateFormLead(id, { contacted, notes });
    const updated = getFormLead(id);
    console.log(`[admin-form-leads] updated id=${id} contacted=${contacted}`);
    return res.json({ ok: true, lead: updated });
  } catch (err) {
    console.error('[admin-form-leads] update error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to update lead' });
  }
});

module.exports = router;
