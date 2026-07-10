'use strict';

/**
 * /api/leads — Public qualification form submission endpoint.
 *
 * POST /api/leads
 *   Validates 10 form fields, saves to leads table, fires n8n webhook.
 *   Rate-limited to 5 submissions per IP per hour.
 *   Returns { ok, lead_id, calendly_url } on success.
 *
 * Route is PUBLIC (no auth required) — mounted before requirePageAuth in server.js.
 */

const express   = require('express');
const rateLimit = require('express-rate-limit');
const router    = express.Router();
const { insertFormLead } = require('../db/db');

// ── Rate limiting: 5 submissions per IP per hour ─────────────────────────────
const leadsLimiter = rateLimit({
  windowMs:        60 * 60 * 1000,   // 1-hour window
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => req.ip || req.socket?.remoteAddress || 'unknown',
  message: { ok: false, error: 'Too many submissions — please try again later.' },
  skip: () => process.env.NODE_ENV === 'development',
});

// ── Validation helpers ────────────────────────────────────────────────────────

const REVENUE_RANGES = [
  'Under 50k EGP',
  '50k - 200k EGP',
  '200k - 500k EGP',
  '500k - 1M EGP',
  '1M+ EGP',
];

const CS_OPTIONS = [
  'Myself',
  'One employee',
  'Multiple employees',
  'Not handling well / overwhelmed',
];

const SHOWROOM_PLATFORMS = ['Locally', 'Other'];

function validateEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
}

function validatePhone(v) {
  return /^01[0-2,5][0-9]{8}$/.test(String(v || '').trim());
}

function validateIgHandle(v) {
  return /^[a-z0-9._]{1,30}$/.test(String(v || '').trim());
}

function normalizeIgHandle(v) {
  return String(v || '').trim().toLowerCase().replace(/^@/, '');
}

function normalizeWebsite(v) {
  let s = String(v || '').trim();
  if (!s) return s;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s;
}

function validateWebsite(v) {
  const s = normalizeWebsite(v);
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

// ── n8n webhook fanout ────────────────────────────────────────────────────────
async function fireLeadWebhook(payload) {
  const url = process.env.N8N_LEAD_WEBHOOK_URL;
  if (!url) return;
  try {
    const resp = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      console.warn(`[leads] n8n webhook HTTP ${resp.status}`);
    } else {
      console.log(`[leads] n8n webhook delivered — lead_id=${payload.lead_id}`);
    }
  } catch (err) {
    console.warn('[leads] n8n webhook failed (non-fatal):', err.message);
  }
}

// ── POST /api/leads ───────────────────────────────────────────────────────────
router.post('/', leadsLimiter, async (req, res) => {
  const body = req.body || {};

  // ── Field extraction ───────────────────────────────────────────────────────
  const brand_name        = String(body.brand_name        || '').trim();
  const contact_name      = String(body.contact_name      || '').trim();
  const email             = String(body.email             || '').trim().toLowerCase();
  const phone             = String(body.phone             || '').trim();
  const ig_raw            = String(body.ig_handle         || '').trim();
  const ig_handle         = normalizeIgHandle(ig_raw);
  const website_raw       = String(body.website           || '').trim();
  const revenue_range     = String(body.revenue_range     || '').trim();
  const has_showroom      = body.has_showroom === true || body.has_showroom === 'yes' || body.has_showroom === '1';
  const showroom_platform = has_showroom ? (String(body.showroom_platform || '').trim() || null) : null;
  const cs_handled_by     = String(body.cs_handled_by     || '').trim();
  const source            = String(body.source            || 'direct').trim().slice(0, 100);

  // ── Validation ─────────────────────────────────────────────────────────────
  const errors = {};

  if (!brand_name)    errors.brand_name    = 'Brand name is required.';
  if (!contact_name)  errors.contact_name  = 'Your name is required.';
  if (!email || !validateEmail(email))  errors.email = 'Valid email address is required.';
  if (!phone || !validatePhone(phone))  errors.phone = 'Egyptian mobile required (e.g., 01XXXXXXXXX).';
  if (!ig_handle || !validateIgHandle(ig_handle)) errors.ig_handle = 'Valid Instagram handle required (letters, numbers, . _).';
  if (!website_raw || !validateWebsite(website_raw)) errors.website = 'Valid website or Shopify URL required.';
  if (!revenue_range || !REVENUE_RANGES.includes(revenue_range)) errors.revenue_range = 'Please select your monthly revenue range.';
  if (body.has_showroom === undefined || body.has_showroom === null || body.has_showroom === '')
    errors.has_showroom = 'Please indicate if you have a showroom.';
  if (has_showroom && !showroom_platform)
    errors.showroom_platform = 'Please select your showroom platform.';
  if (!cs_handled_by || !CS_OPTIONS.includes(cs_handled_by))
    errors.cs_handled_by = 'Please select how you currently handle customer service.';

  if (Object.keys(errors).length) {
    return res.status(422).json({ ok: false, errors });
  }

  const website = normalizeWebsite(website_raw);

  // ── Save to DB ─────────────────────────────────────────────────────────────
  let lead_id;
  try {
    lead_id = insertFormLead({
      brand_name,
      contact_name,
      email,
      phone,
      ig_handle,
      website,
      revenue_range,
      has_showroom,
      showroom_platform,
      cs_handled_by,
      ip_address: req.ip || null,
      user_agent: req.headers['user-agent'] || null,
      source,
    });
  } catch (err) {
    console.error('[leads] DB insert error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to save submission. Please try again.' });
  }

  // ── Build Calendly URL with pre-fill ──────────────────────────────────────
  const calendlyBase = 'https://calendly.com/youssefbassem-aucegypt/30min';
  const calendlyUrl  = `${calendlyBase}?name=${encodeURIComponent(contact_name)}&email=${encodeURIComponent(email)}&a1=${encodeURIComponent(brand_name)}&a2=${encodeURIComponent(revenue_range)}`;

  // ── Fire n8n webhook (async — never blocks response) ─────────────────────
  const serverUrl = process.env.SERVER_URL || 'https://optimize-backend-production.up.railway.app';
  fireLeadWebhook({
    event:            'new_lead_form_submission',
    lead_id,
    brand_name,
    contact_name,
    phone,
    ig_handle:        `@${ig_handle}`,
    revenue_range,
    has_showroom,
    showroom_platform: showroom_platform || null,
    cs_handled_by,
    source,
    submitted_at:     new Date().toISOString(),
    admin_url:        `${serverUrl}/admin#form-leads`,
  }).catch(() => {}); // already non-fatal inside, belt-and-suspenders

  console.log(`[leads] new submission — id=${lead_id} brand="${brand_name}" revenue="${revenue_range}"`);

  return res.json({ ok: true, lead_id, calendly_url: calendlyUrl });
});

module.exports = router;
