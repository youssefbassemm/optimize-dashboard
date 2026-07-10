'use strict';

/**
 * /api/auth
 *
 * POST /signup              — create user + brand workspace, return JWT
 * POST /register            — legacy: user only (no brand)
 * POST /login               — authenticate, return JWT
 * POST /logout              — invalidate session
 * GET  /me                  — current user + brands (legacy, authGuard gated)
 * POST /complete-onboarding — mark brand as onboarded after setup flow
 *
 * All routes except /complete-onboarding are active only when AUTH_ENABLED=true.
 */

const express           = require('express');
const crypto            = require('crypto');
const bcrypt            = require('bcryptjs');
const jwt               = require('jsonwebtoken');
const router            = express.Router();
const db                = require('../db/db');
const { requireAuth }   = require('../middleware/auth');
const { sendMail }      = require('../lib/mailer');

// ── SIGNUP_PROFILE — validation constants ─────────────────────────────────────
//
// REVENUE_RANGE_KEYS — locked keys stored in DB + sent in API.
// The display labels live in the HTML signup form; the keys are stable forever.
const REVENUE_RANGE_KEYS = ['under_50k', '50k_200k', '200k_plus'];

// Egyptian mobile: 01[0,1,2,5] followed by 8 digits — 11 digits total.
// Examples: 01012345678  01112345678  01212345678  01512345678
const EGYPTIAN_PHONE_RE  = /^01[0125][0-9]{8}$/;

// Instagram handle after stripping leading @ and lowercasing.
// Must match: letters, digits, underscores, dots. 1–30 chars.
const IG_HANDLE_RE       = /^[a-z0-9._]{1,30}$/;

// AUTH_BACKEND — mirrors middleware/auth.js: always enforced in production.
// In development, set AUTH_ENABLED=true in .env to activate the auth routes.
// Without this, dev mode leaves auth routes dormant so the API stub pass-through
// (in middleware/auth.js) handles all access without requiring a real login.
const IS_PROD      = process.env.NODE_ENV === 'production';
const AUTH_ENABLED = IS_PROD || process.env.AUTH_ENABLED === 'true';
const JWT_SECRET   = process.env.JWT_SECRET   || 'replace-me-in-env';
const BCRYPT_ROUNDS = 12;

// Session TTL — 7 days by default, configurable via SESSION_TTL_DAYS
const SESSION_TTL_DAYS = parseInt(process.env.SESSION_TTL_DAYS || '7', 10);

// SESSION_COOKIE — HTTP-only cookie set alongside the JWT response body.
// The server-side page guard reads this cookie to protect HTML routes without
// exposing the token to JavaScript (XSS-safe). sameSite:Lax blocks CSRF.
const COOKIE_OPTS = {
  httpOnly: true,
  secure:   process.env.NODE_ENV === 'production',
  sameSite: 'Lax',
  maxAge:   SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  path:     '/',
};

// BRAND_WORKSPACE_CREATION — convert brand name to a safe URL slug
function slugify(str) {
  return str.toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40) || 'brand';
}

// BRAND_WORKSPACE_CREATION — generate a unique brand slug with collision retry.
// Appends a random 4-hex suffix if the base slug is taken, retries up to 10 times.
function uniqueBrandSlug(baseName) {
  const base = slugify(baseName);
  if (!db.getBrand(base)) return base;
  for (let i = 0; i < 10; i++) {
    const candidate = `${base}-${crypto.randomBytes(2).toString('hex')}`;
    if (!db.getBrand(candidate)) return candidate;
  }
  throw new Error('Could not generate a unique brand ID — please try a different brand name');
}

/**
 * Helper: create session + JWT. Returns { sessionId, token }.
 * tier is embedded in the JWT so requirePaidTier can gate routes without a
 * DB lookup on every request.  It is refreshed on every /api/me poll (60s)
 * so a tier upgrade propagates to the browser within one polling cycle.
 */
function issueToken(userId, brandId, role, ipAddress, userAgent, tier = 'free') {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.createSession({ id: sessionId, userId, brandId: brandId || null, ipAddress, userAgent, expiresAt });
  db.updateUserLastLogin(userId);
  const token = jwt.sign(
    { userId, brandId: brandId || null, sessionId, role, tier },
    JWT_SECRET,
    { expiresIn: `${SESSION_TTL_DAYS}d` }
  );
  return { sessionId, token, expiresAt };
}

// ── Guard helper ──────────────────────────────────────────────────────────────
function authGuard(req, res, next) {
  if (!AUTH_ENABLED) {
    return res.status(503).json({
      ok:    false,
      error: 'Auth is not enabled on this server',
      hint:  'Set AUTH_ENABLED=true and JWT_SECRET in your .env to activate authentication',
    });
  }
  next();
}

// ── POST /api/auth/signup ─────────────────────────────────────────────────────
// BRAND_WORKSPACE_CREATION + SIGNUP_PROFILE
//
// Creates a new user account AND a completely isolated brand workspace.
// Returns a JWT so the user is immediately logged in.
//
// Required: email, password, brand_name
// Optional: full_name, phone, ig_handle, revenue_range
//
// TIER_SYSTEM — free users are marked onboarded immediately (fast-track).
// needs_onboarding is always false for free tier; the dashboard shows a
// checklist card prompting Shopify + Instagram connect instead of the
// full /onboarding wizard redirect.
//
// Lead webhooks: new_signup fires on every signup; new_signup_high_revenue
// fires additionally when revenue_range === '200k_plus'.
const VALID_BUSINESS_TYPES = ['ecommerce', 'food_brand'];

router.post('/signup', authGuard, async (req, res) => {
  const { email, password, brand_name, full_name, phone, ig_handle, revenue_range, business_type } = req.body;

  // ── Required field check ────────────────────────────────────────────────────
  if (!email || !password || !brand_name) {
    return res.status(400).json({ ok: false, error: 'email, password, and brand_name are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
  }

  // ── Email format ────────────────────────────────────────────────────────────
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) {
    return res.status(400).json({ ok: false, error: 'Please enter a valid email address' });
  }

  const emailNorm = email.toLowerCase().trim();
  const brandName = brand_name.trim();
  // full_name is optional — fall back to the local-part of the email
  const userName  = (full_name || '').trim() || emailNorm.split('@')[0];

  // ── Phone validation (optional but validated if provided) ───────────────────
  // SIGNUP_PROFILE — Egyptian mobile only: 01[0,1,2,5] + 8 digits = 11 chars.
  let cleanPhone = null;
  if (phone !== undefined && phone !== null && phone !== '') {
    const stripped = String(phone).replace(/\s+/g, '');
    if (!EGYPTIAN_PHONE_RE.test(stripped)) {
      return res.status(400).json({
        ok:      false,
        error:   'invalid_phone',
        message: 'Egyptian mobile required (01[0/1/2/5] followed by 8 digits)',
      });
    }
    cleanPhone = stripped;
  }

  // ── Instagram handle validation (optional but validated if provided) ────────
  // SIGNUP_PROFILE — strip leading @, lowercase, validate character set.
  let cleanHandle = null;
  if (ig_handle !== undefined && ig_handle !== null && ig_handle !== '') {
    cleanHandle = String(ig_handle).trim().replace(/^@+/, '').toLowerCase();
    if (!IG_HANDLE_RE.test(cleanHandle)) {
      return res.status(400).json({
        ok:      false,
        error:   'invalid_ig_handle',
        message: 'Instagram handle must be 1–30 characters: letters, digits, underscores, and dots only',
      });
    }
  }

  // ── Revenue range validation (optional but key-locked if provided) ──────────
  // SIGNUP_PROFILE — stable keys only; reject anything else.
  let cleanRevenue = null;
  if (revenue_range !== undefined && revenue_range !== null && revenue_range !== '') {
    if (!REVENUE_RANGE_KEYS.includes(revenue_range)) {
      return res.status(400).json({
        ok:      false,
        error:   'invalid_revenue_range',
        message: `revenue_range must be one of: ${REVENUE_RANGE_KEYS.join(', ')}`,
      });
    }
    cleanRevenue = revenue_range;
  }

  // ── Business type validation ────────────────────────────────────────────────
  let cleanBusinessType = 'ecommerce';
  if (business_type && VALID_BUSINESS_TYPES.includes(business_type)) {
    cleanBusinessType = business_type;
  }

  try {
    // ── Duplicate email check ───────────────────────────────────────────────────
    // Return a generic error code with no information about whether the collision
    // is at user level or brand level — prevents account enumeration.
    if (db.findUserByEmail(emailNorm)) {
      return res.status(409).json({ ok: false, error: 'email_exists' });
    }

    // 1. Create user record (password is bcrypt-hashed, never stored plaintext)
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const userResult   = db.createUser({ email: emailNorm, passwordHash, name: userName, role: 'owner' });
    const userId       = userResult.lastInsertRowid;

    // 2. Persist phone on user record if provided
    if (cleanPhone) {
      try { db.updateUserPhone(userId, cleanPhone); } catch (_) {}
    }

    // 3. Generate unique brand_id — collision-safe with random suffix
    const brandId = uniqueBrandSlug(brandName);

    db.upsertBrand({
      id:           brandId,
      name:         brandName,
      slug:         brandId,
      logo_url:     null,
      theme_config: '{}',
    });

    // 4. Persist ig_handle + revenue_range on the brand record
    if (cleanHandle || cleanRevenue) {
      try { db.updateBrandProfile(brandId, { ig_handle: cleanHandle, revenue_range: cleanRevenue }); } catch (_) {}
    }

    // 5. Grant user full ownership of the new brand
    db.grantUserBrand(userId, brandId, 'owner');

    // 6. Free-tier fast-track — mark onboarded immediately.
    // TIER_SYSTEM: free users land on /dashboard with a checklist card,
    // NOT the /onboarding wizard. The checklist prompts Shopify + Instagram.
    // Paid users (upgraded later) retain normal flow; onboarded stays true.
    db.markBrandOnboarded(brandId);

    // 6b. Food brand setup — persist business_type and seed preset recurring expenses.
    if (cleanBusinessType === 'food_brand') {
      db.setBrandBusinessType(brandId, 'food_brand');
      try { db.seedFbRecurringExpenses(brandId); } catch (_) {}
    }

    // 7. Issue JWT with brand_id + tier embedded for brand-scoped API access
    const { token } = issueToken(
      userId,
      brandId,
      'owner',
      req.ip || null,
      req.headers['user-agent'] || null,
      'free'
    );

    console.log(
      `[auth] signup: brand_id=${brandId} user=${emailNorm}` +
      `${cleanPhone    ? ` phone=${cleanPhone}`   : ''}` +
      `${cleanHandle   ? ` ig=@${cleanHandle}`   : ''}` +
      `${cleanRevenue  ? ` revenue=${cleanRevenue}` : ''}`
    );

    // 8. Lead webhook — fire events (Step 9 spec activated early)
    // Both events write to the internal events table; n8n fanout is optional.
    const eventPayload = {
      email:         emailNorm,
      brand_name:    brandName,
      phone:         cleanPhone    || null,
      ig_handle:     cleanHandle   || null,
      revenue_range: cleanRevenue  || null,
    };

    try { db.insertEvent(brandId, userId, 'new_signup', eventPayload); } catch (_) {}

    if (cleanRevenue === '200k_plus') {
      try { db.insertEvent(brandId, userId, 'new_signup_high_revenue', eventPayload); } catch (_) {}
    }

    // Optional n8n fanout — fires asynchronously, never blocks the response.
    // Set N8N_LEAD_WEBHOOK_URL in Railway env to activate external delivery.
    fireLeadWebhook('new_signup', eventPayload).catch(() => {});
    if (cleanRevenue === '200k_plus') {
      fireLeadWebhook('new_signup_high_revenue', eventPayload).catch(() => {});
    }

    // SESSION_COOKIE — set alongside the JSON token for server-side page guard
    res.cookie('__session', token, COOKIE_OPTS);

    res.status(201).json({
      ok:               true,
      token,
      tier:             'free',
      user:             { id: userId, email: emailNorm, name: userName, role: 'owner' },
      brand_id:         brandId,
      brand_name:       brandName,
      onboarded:        true,    // TIER_SYSTEM: free users are fast-tracked
      needs_onboarding: false,   // → no /onboarding redirect; dashboard loads directly
    });
  } catch (err) {
    console.error('[auth] signup error:', err.message);
    res.status(500).json({ ok: false, error: 'Sign up failed' });
  }
});

// ── fireLeadWebhook ───────────────────────────────────────────────────────────
// Optional async fanout to n8n when N8N_LEAD_WEBHOOK_URL is set.
// Events are always written to the events table first (above); this function
// handles the secondary HTTP delivery only. Never throws — errors are logged.
//
// env: N8N_LEAD_WEBHOOK_URL — full n8n webhook URL, e.g.
//   https://n8n.yourserver.com/webhook/optimize-lead
async function fireLeadWebhook(eventName, payload) {
  const url = process.env.N8N_LEAD_WEBHOOK_URL;
  if (!url) return; // not configured — skip silently

  try {
    const body = JSON.stringify({ event: eventName, ...payload, fired_at: new Date().toISOString() });
    const resp = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal:  AbortSignal.timeout(8000), // 8s timeout — don't hang signup
    });
    if (!resp.ok) {
      console.warn(`[auth] fireLeadWebhook ${eventName} → HTTP ${resp.status} from n8n`);
    } else {
      console.log(`[auth] fireLeadWebhook ${eventName} → delivered to n8n`);
    }
  } catch (err) {
    console.warn(`[auth] fireLeadWebhook ${eventName} failed (non-fatal):`, err.message);
  }
}

// ── POST /api/auth/register ───────────────────────────────────────────────────
// Legacy: creates user only. Kept for backward compatibility.
router.post('/register', authGuard, async (req, res) => {
  const { email, password, name } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ ok: false, error: 'email, password, and name are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
  }

  const emailNorm = email.toLowerCase().trim();

  try {
    if (db.findUserByEmail(emailNorm)) {
      return res.status(409).json({ ok: false, error: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result       = db.createUser({ email: emailNorm, passwordHash, name, role: 'member' });

    res.status(201).json({
      ok:   true,
      user: { id: result.lastInsertRowid, email: emailNorm, name, role: 'member' },
    });
  } catch (err) {
    console.error('[auth] register error:', err.message);
    res.status(500).json({ ok: false, error: 'Registration failed' });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', authGuard, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'email and password are required' });
  }

  try {
    const user = db.findUserByEmail(email.toLowerCase().trim());

    // Constant-time comparison — prevents timing attacks on account enumeration
    const valid = user
      ? await bcrypt.compare(password, user.password_hash)
      : await bcrypt.compare(password, '$2a$12$invalidsaltXXXXXXXXXXXXXXhashXXXXXXXXXXXXXXXXXXXXXXX.');

    if (!user || !valid) {
      return res.status(401).json({ ok: false, error: 'Invalid email or password' });
    }

    // Load brands to embed first brand_id in JWT
    const brands  = db.getUserBrands(user.id);
    const brandId = brands.length > 0 ? brands[0].id : null;

    // Surface brand_name so the frontend can skip a separate /api/me call
    const brandRow = brandId ? db.getBrand(brandId) : null;
    const brandTier = brandRow?.tier || 'free';

    // AUTH_BACKEND — issue token with brandId + tier for brand-scoped API validation
    // TIER_SYSTEM — tier embedded in JWT so requirePaidTier gate works without DB call
    const { token } = issueToken(
      user.id,
      brandId,
      user.role,
      req.ip  || null,
      req.headers['user-agent'] || null,
      brandTier
    );

    // SESSION_COOKIE — set alongside the JSON token so the server-side page guard works
    res.cookie('__session', token, COOKIE_OPTS);
    // ONBOARDING_FLOW: if onboarded_at is null the brand never completed setup.
    // Return needs_onboarding: true so the frontend can redirect to /onboarding.
    const needsOnboarding = brandRow ? !brandRow.onboarded_at : false;

    res.json({
      ok:               true,
      token,
      tier:             brandTier,
      user:             { id: user.id, email: user.email, name: user.name, role: user.role },
      brand_id:         brandId,
      brand_name:       brandRow?.name || null,
      brands,
      needs_onboarding: needsOnboarding,
    });
  } catch (err) {
    console.error('[auth] login error:', err.message);
    res.status(500).json({ ok: false, error: 'Login failed' });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post('/logout', authGuard, requireAuth, (req, res) => {
  try {
    if (req.sessionId) {
      db.deleteSession(req.sessionId);
    }
    res.clearCookie('__session', { path: '/' });
    res.json({ ok: true, message: 'Logged out' });
  } catch (err) {
    console.error('[auth] logout error:', err.message);
    res.status(500).json({ ok: false, error: 'Logout failed' });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
// Legacy endpoint — kept for backward compatibility.
// Prefer GET /api/me (top-level, no authGuard) for new code.
router.get('/me', authGuard, requireAuth, (req, res) => {
  try {
    const brands = db.getUserBrands(req.user.id);
    res.json({
      ok:   true,
      user: {
        id:    req.user.id,
        email: req.user.email,
        name:  req.user.name,
        role:  req.user.role,
      },
      brands,
    });
  } catch (err) {
    console.error('[auth] /me error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to load user' });
  }
});

// ── POST /api/auth/complete-onboarding ───────────────────────────────────────
// ONBOARDING_FLOW / BRAND_WORKSPACE_CREATION
// Called by the onboarding page after the user finishes setup.
// Marks the brand as onboarded so /api/me returns onboarded: true and the
// dashboard boot sequence stops redirecting to /onboarding.
router.post('/complete-onboarding', authGuard, requireAuth, (req, res) => {
  try {
    const brandId = req.user.brandId;
    if (!brandId) {
      return res.status(400).json({ ok: false, error: 'No brand associated with this session' });
    }

    db.markBrandOnboarded(brandId);
    console.log(`[auth] onboarding complete for brand=${brandId}`);
    res.json({ ok: true, message: 'Onboarding complete — welcome to Optimize' });
  } catch (err) {
    console.error('[auth] complete-onboarding error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to mark onboarding complete' });
  }
});

// ── POST /api/auth/accept-invite ─────────────────────────────────────────────
// Public endpoint — accepts a team invite token.
// If the invitee already has an account: links them to the brand.
// If new: creates their account (password required) and links them.
router.post('/accept-invite', authGuard, async (req, res) => {
  const { token, password, full_name } = req.body;

  if (!token) {
    return res.status(400).json({ ok: false, error: 'token is required' });
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const invite    = db.getTeamInvite(tokenHash);

    if (!invite) {
      return res.status(400).json({ ok: false, error: 'Invite link is invalid or has expired' });
    }

    let user = db.findUserByEmail(invite.email);
    let isNew = false;

    if (!user) {
      // New user — password required
      if (!password || password.length < 8) {
        return res.status(400).json({ ok: false, error: 'Please set a password (min 8 characters) to create your account' });
      }
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const result = db.createUser({
        email:        invite.email,
        passwordHash,
        name:         (full_name || '').trim() || invite.email.split('@')[0],
        role:         invite.role,
      });
      user  = db.getUserById(result.lastInsertRowid);
      isNew = true;
    }

    // Grant brand access at the invited role
    db.grantUserBrand(user.id, invite.brand_id, invite.role);
    db.markInviteAccepted(tokenHash);

    // Issue a session so they land directly in the dashboard
    const inviteBrand = db.getBrand(invite.brand_id);
    const inviteTier  = inviteBrand?.tier || 'free';
    const { token: jwt } = issueToken(
      user.id, invite.brand_id, invite.role,
      req.ip || null, req.headers['user-agent'] || null, inviteTier
    );

    // SESSION_COOKIE — set so the server-side page guard lets them through
    res.cookie('__session', jwt, COOKIE_OPTS);
    res.json({
      ok:        true,
      token:     jwt,
      brand_id:  invite.brand_id,
      is_new:    isNew,
      message:   'Invite accepted',
    });
  } catch (err) {
    console.error('[auth] accept-invite error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to accept invite' });
  }
});

// ── POST /api/auth/forgot-password ───────────────────────────────────────────
// Generates a one-time reset token (SHA-256 hashed before storage).
// In production, the raw token is emailed via SMTP (configure SMTP_* env vars).
// In development (NODE_ENV !== 'production'), the token is returned in the
// response body so you can test without an email server.
router.post('/forgot-password', authGuard, async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ ok: false, error: 'email is required' });
  }

  // Always return 200 even when email not found — prevents account enumeration
  const emailNorm = email.toLowerCase().trim();
  const user = db.findUserByEmail(emailNorm);

  if (!user) {
    return res.json({ ok: true, message: 'If that email exists you will receive a reset link.' });
  }

  try {
    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    db.createPasswordResetToken(user.id, tokenHash, expiresAt);

    const resetUrl = `${process.env.SERVER_URL || ''}/reset-password?token=${rawToken}`;

    const mailResult = await sendMail({
      to:      emailNorm,
      subject: 'Reset your Optimize password',
      html: `
        <p>Hi,</p>
        <p>We received a request to reset your Optimize password.</p>
        <p><a href="${resetUrl}" style="color:#C49A55;font-weight:bold">Reset your password</a></p>
        <p>This link expires in <strong>1 hour</strong>. If you did not request this, you can safely ignore this email.</p>
        <p style="color:#888;font-size:12px">If the button above doesn't work, paste this URL into your browser:<br>${resetUrl}</p>
      `,
      text: `Reset your Optimize password: ${resetUrl}\n\nThis link expires in 1 hour. If you did not request a reset, ignore this email.`,
    });

    // Always log server-side — useful if SMTP fails silently in production
    console.log(`[auth] password reset for ${emailNorm} — email ${mailResult.sent ? 'sent' : 'NOT sent: ' + mailResult.reason}`);

    // In production, surface a clear error if email delivery failed
    if (!mailResult.sent && process.env.NODE_ENV === 'production') {
      return res.status(500).json({
        ok:    false,
        error: 'Could not send reset email. Please try again or contact support.',
      });
    }

    const responsePayload = { ok: true, message: 'If that email exists you will receive a reset link.' };

    // Expose URL in non-production when SMTP is not wired (dev convenience)
    if (process.env.NODE_ENV !== 'production') {
      responsePayload._dev_reset_url = resetUrl;
    }

    res.json(responsePayload);
  } catch (err) {
    console.error('[auth] forgot-password error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to process request' });
  }
});

// ── POST /api/auth/reset-password ────────────────────────────────────────────
// Validates the raw token from the reset link, hashes it, looks it up in DB,
// updates the password, invalidates the token, and clears all active sessions.
router.post('/reset-password', authGuard, async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ ok: false, error: 'token and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const record    = db.getPasswordResetToken(tokenHash);

    if (!record) {
      return res.status(400).json({ ok: false, error: 'Reset link is invalid or has expired' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Update password
    db.db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(passwordHash, record.user_id);

    // Invalidate the token
    db.markResetTokenUsed(tokenHash);

    // Revoke all existing sessions for this user (force re-login everywhere)
    db.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(record.user_id);
    res.clearCookie('__session', { path: '/' });

    console.log(`[auth] password reset successful for user_id=${record.user_id}`);
    res.json({ ok: true, message: 'Password updated — please sign in with your new password.' });
  } catch (err) {
    console.error('[auth] reset-password error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to reset password' });
  }
});

module.exports = router;
