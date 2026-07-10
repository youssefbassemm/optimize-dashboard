'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// RAILWAY_PRODUCTION — Required environment variables
// ─────────────────────────────────────────────────────────────────────────────
//
// REQUIRED — server will not start without these:
//   ENCRYPTION_KEY   64 hex chars (32 bytes). Generate:
//                    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// RECOMMENDED — defaults work but should be set in production:
//   PORT             HTTP port (default: 3000). Railway sets this automatically.
//   NODE_ENV         'production' | 'development' (default: development)
//   DATABASE_PATH    Absolute path to SQLite file.
//                    On Railway, mount a Volume at /data and set DATABASE_PATH=/data/optimize.db
//                    so the DB survives redeploys.
//   SERVER_URL       Full public base URL, e.g. https://yourapp.up.railway.app
//                    Required for Shopify webhook registration and ShipBlu webhook URLs.
//   JWT_SECRET       Random string for signing JWTs. Generate:
//                    node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
//   SESSION_TTL_DAYS JWT/session lifetime in days (default: 7)
//   AUTH_ENABLED     'true' to enforce JWT authentication (default: disabled)
//
// SHOPIFY OAUTH — required for the one-click Shopify connection flow:         // ENV_NEEDED
//   SHOPIFY_CLIENT_ID      Shopify app Client ID (from Partners dashboard)    // ENV_NEEDED
//   SHOPIFY_CLIENT_SECRET  Shopify app Client Secret                          // ENV_NEEDED
//   SHOPIFY_SCOPES         Comma-separated scopes (defaults to read_orders,   // ENV_NEEDED
//                          read_products,read_inventory,read_customers,        // ENV_NEEDED
//                          read_fulfillments,read_shipping,read_returns,       // ENV_NEEDED
//                          read_analytics)                                     // ENV_NEEDED
//   SHOPIFY_REDIRECT_URI   Must be:                                           // ENV_NEEDED
//                          https://optimize-backend-production.up.railway.app/auth/shopify/callback
//
// SHOPIFY_REDIRECT_URL — must be set to:
//   https://optimize-backend-production.up.railway.app/auth/shopify/callback
// Update this in the Shopify app dashboard before testing OAuth flow.
//
// OPTIONAL — integration-specific:
//   SEED_BRAND_ID    Brand ID to auto-create on first boot (e.g. 'etrnll')
//   SEED_BRAND_NAME  Brand display name for the seeded brand
//   SHOPIFY_WEBHOOK_SECRET  HMAC secret for verifying Shopify webhook payloads
//   META_APP_ID      Meta app ID for token auto-refresh
//   META_APP_SECRET  Meta app secret for token auto-refresh
//
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const express      = require('express');
const path         = require('path');
const cookieParser = require('cookie-parser');
const jwt          = require('jsonwebtoken');
const rateLimit    = require('express-rate-limit');
const db           = require('./db/db');
const { runMigrations }         = require('./db/migrations');
const { startScheduler }        = require('./jobs/scheduler');
const { requireBrandOwnership } = require('./middleware/auth');  // BRAND_OWNERSHIP_CHECK
const { requirePaidTier }      = require('./middleware/requirePaidTier'); // TIER_SYSTEM
const { requireAdminAuth, requireAdminPage } = require('./middleware/requireAdminAuth'); // ADMIN_DASHBOARD
const { blockImpersonation }   = require('./middleware/blockImpersonation'); // ADMIN PHASE 3

// Application version — bump this on deploys for health check tracking
const APP_VERSION = process.env.npm_package_version || '1.0.0';

const app  = express();
const PORT = process.env.PORT || 3000;

// Trust reverse proxies (Railway, Render, Heroku, DigitalOcean, etc.)
app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────────────────────
// Applied to every response. Strict-Transport-Security only fires in production
// since Railway handles TLS termination and the header needs the real domain.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0'); // modern browsers use CSP; legacy header disabled
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  next();
});

// ── Rate limiting — auth routes only ─────────────────────────────────────────
// Limits sign-in / sign-up / forgot-password to 10 attempts per 15 min per IP.
// Uses a memory store — single-instance safe on Railway (one dyno/container).
const authLimiter = rateLimit({
  windowMs:         15 * 60 * 1000,  // 15-minute sliding window
  max:              10,               // max requests per window per IP
  standardHeaders:  true,            // Return RateLimit-* headers
  legacyHeaders:    false,
  message: { ok: false, error: 'Too many attempts — please try again in 15 minutes.' },
  skip: () => process.env.NODE_ENV === 'development', // only off when explicitly in dev
});

// ── Dev CORS ──────────────────────────────────────────────────────────────────
// Only active when NODE_ENV=development. In production the dashboard is served
// from the same origin so no CORS headers are needed.
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });
}

// ── Webhook routes (raw body — must come before json() middleware) ─────────────
// Note: routes/webhooks.js is a helper lib (fireLeadWebhook), not an HTTP router.
// CX n8n callbacks (no auth — HMAC-secured; must be before json() so raw body available)
app.use('/api/cx/webhook', require('./routes/cx_webhook'));
// Calendly booking webhook (no auth — optional HMAC-secured; raw body for sig verification)
app.use('/api/calendly/webhook', require('./routes/calendly_webhook'));

// ── Body parsers ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// ── Page auth guard ───────────────────────────────────────────────────────────
// SERVER_PAGE_GUARD — blocks unauthenticated access to every app HTML page.
// Reads the HTTP-only __session cookie set by /api/auth/login and /api/auth/signup.
// If no valid cookie → redirect to /signin immediately (no HTML served, no flash).
//
// AUTH_ENABLED_PAGE mirrors the same logic as middleware/auth.js AUTH_ENABLED:
//   production → always enforced, regardless of env var.
//   development → only enforced when AUTH_ENABLED=true is explicitly set.
// This ensures dev mode (where auth routes return 503 and no cookie can be issued)
// doesn't break page navigation — both the page guard and the API guard must agree.
const JWT_SECRET_PAGE     = process.env.JWT_SECRET || 'replace-me-in-env';
const AUTH_ENABLED_PAGE   = process.env.NODE_ENV === 'production' || process.env.AUTH_ENABLED === 'true';

function requirePageAuth(req, res, next) {
  // Dev bypass: if AUTH_ENABLED is off, both page guard and API guard are pass-through
  if (!AUTH_ENABLED_PAGE) return next();

  const cookie = req.cookies && req.cookies.__session;
  if (!cookie) return res.redirect('/signin');
  try {
    const decoded = jwt.verify(cookie, JWT_SECRET_PAGE);
    // SESSION_REVOCATION — JWT signature alone is not sufficient.
    // A logged-out or force-expired session must be rejected even if the JWT
    // is cryptographically valid, so we confirm the session still exists in DB.
    if (decoded.sessionId) {
      const session = db.getSessionById(decoded.sessionId);
      if (!session) {
        res.clearCookie('__session', { path: '/' });
        return res.redirect('/signin');
      }
    }
    next();
  } catch (_) {
    res.clearCookie('__session', { path: '/' });
    res.redirect('/signin');
  }
}

// ── Static frontend ───────────────────────────────────────────────────────────
const fs         = require('fs');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Intercept direct .html requests — non-public files require auth.
// Without this, a user could bypass requirePageAuth by requesting /index.html directly.
// setup.html and onboarding.html are intentionally absent — both are auth-guarded.
// Admin HTML files are guarded by requireAdminPage (redirects to /admin/login).
const PUBLIC_HTML = new Set([
  '/signin.html', '/signup.html', '/forgot-password.html',
  '/reset-password.html', '/landing.html', '/book.html',
]);
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    // Admin files → requireAdminPage (redirect to /admin/login)
    if (req.path.startsWith('/admin/')) {
      return req.path === '/admin/login.html'
        ? next()
        : requireAdminPage(req, res, next);
    }
    // All other non-public HTML → requirePageAuth
    if (!PUBLIC_HTML.has(req.path)) {
      return requirePageAuth(req, res, next);
    }
  }
  next();
});

// ── Admin page routes (must precede express.static to prevent dir-redirect 301) ──
// /admin/login — public login page (no auth required)
app.get('/admin/login', (req, res) => {
  const p = path.join(PUBLIC_DIR, 'admin', 'login.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  res.status(404).send('Admin login page not found');
});
// /admin and /admin/* — protected SPA (requireAdminPage redirects to /admin/login)
app.get('/admin', requireAdminPage, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin', 'index.html'));
});
app.get('/admin/', requireAdminPage, (req, res) => {
  res.redirect('/admin');
});
app.get('/admin/*', requireAdminPage, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin', 'index.html'));
});

app.use(express.static(PUBLIC_DIR, { index: false }));

// Root → landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'landing.html'));
});

// Dashboard — protected route (requirePageAuth blocks unauthenticated access)
app.get('/dashboard', requirePageAuth, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Food Brand dashboard — protected (requirePageAuth); only food_brand workspaces land here
app.get('/food-brand', requirePageAuth, (req, res) => {
  const p = path.join(PUBLIC_DIR, 'food-brand.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  res.redirect('/dashboard');
});

// Setup — private workspace setup screen (post-signup, auth required)
app.get('/setup', requirePageAuth, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'setup.html'));
});

// Onboarding — private (auth required); kept for backward compatibility
app.get('/onboarding', requirePageAuth, (req, res) => {
  const p = path.join(PUBLIC_DIR, 'onboarding.html');
  // If onboarding.html exists serve it; otherwise fall through to the dashboard
  if (fs.existsSync(p)) return res.sendFile(p);
  res.redirect('/dashboard');
});

// AUTH_FRONTEND — explicit routes for public auth/landing pages only
// setup and onboarding are private and registered explicitly above
['signin', 'signup', 'forgot-password', 'reset-password', 'landing'].forEach((page) => {
  app.get(`/${page}`, (req, res) => {
    const p = path.join(PUBLIC_DIR, `${page}.html`);
    if (fs.existsSync(p)) return res.sendFile(p);
    res.redirect('/signin');
  });
});

// /book — public qualification form (no auth required)
app.get('/book', (req, res) => {
  const p = path.join(PUBLIC_DIR, 'book.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  res.redirect('/');
});

// ── Public qualification form endpoint (no auth required) ────────────────────
// MUST be before the catch-all requirePageAuth guard.
app.use('/api/leads', require('./routes/leads'));

// ── /api/me — top-level identity endpoint (no authGuard — works in both modes) ─
// API_ME_ENDPOINT — returns brand_id, brand_name, onboarded, integrations_connected
// Called by the dashboard on every page load to populate BRAND_ID and BRAND_NAME.
app.use('/api/me', require('./routes/me'));

// ── Shopify OAuth routes (public — no brand ownership check) ──────────────────
// SHOPIFY_OAUTH_START / SHOPIFY_OAUTH_CALLBACK
// /start requires auth + brand ownership (handled inside the router).
// /callback must be public — Shopify redirects the browser here directly,
// not via the authenticated frontend. Brand is recovered from the signed nonce.
app.use('/auth/shopify', require('./routes/shopify_oauth'));

// META_OAUTH_START / META_OAUTH_CALLBACK
// /start requires auth + brand ownership (handled inside the router).
// /callback must be public — Meta redirects the browser here directly.
app.use('/auth/meta', require('./routes/meta_oauth'));

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/health',  require('./routes/health'));
app.use('/api/auth',    authLimiter, require('./routes/auth'));  // rate-limited

// STEP9 — client-side event sink. requireAuth enforced inside the router.
// Rate-limited to 30 req/min per user in-memory (routes/events.js).
app.use('/api/events',  require('./routes/events'));
// /api/brands routes require authentication (enforced inside the router).
// GET / returns only the caller's brands; POST / is admin-only.
app.use('/api/brands',  require('./routes/brands'));

// All /api/:brand_id/* routes are protected by requireBrandOwnership.
// When AUTH_ENABLED=true this enforces JWT auth + per-brand access control.
// When AUTH_ENABLED is unset (dev default) the middleware is a pass-through.
app.use('/api/:brand_id/food-brand',   requireBrandOwnership, require('./routes/food-brand'));
app.use('/api/:brand_id/dashboard',    requireBrandOwnership, require('./routes/dashboard'));
app.use('/api/:brand_id/integrations', requireBrandOwnership, blockImpersonation, require('./routes/integrations'));
app.use('/api/:brand_id/settings',     requireBrandOwnership, blockImpersonation, require('./routes/settings'));
app.use('/api/:brand_id/branding',     requireBrandOwnership, blockImpersonation, require('./routes/branding'));
app.use('/api/:brand_id/orders',       requireBrandOwnership, require('./routes/orders'));
app.use('/api/:brand_id/inventory',    requireBrandOwnership, require('./routes/inventory'));
app.use('/api/:brand_id/sales',        requireBrandOwnership, require('./routes/sales'));
app.use('/api/:brand_id/campaigns',    requireBrandOwnership, require('./routes/campaigns'));
app.use('/api/:brand_id/targets',      requireBrandOwnership, require('./routes/targets'));
// ── Admin auth routes (public — login/logout/check) ───────────────────────────
// MUST be mounted BEFORE any protected /api/admin block so login is reachable
// without a session cookie.
app.use('/api/admin/auth', require('./routes/admin_auth'));

// Admin CX — mounted BEFORE /api/:brand_id/cx to avoid route conflict
// (/api/admin/cx/... would otherwise match brand_id='admin' below)
// admin_cx routes are prefixed with /cx/ so mount at /api/admin
app.use('/api/admin', requireAdminAuth, require('./routes/admin_cx'));

// CX — Customer Experience (paid only)
app.use('/api/:brand_id/cx',               requireBrandOwnership, requirePaidTier, require('./routes/cx'));

// TIER_SYSTEM — requirePaidTier applied at mount level.
// Free users receive 403 { ok:false, error:'upgrade_required' } on every endpoint
// under these route groups. Connect / disconnect stays ungated in /integrations.
app.use('/api/:brand_id/locally',           requireBrandOwnership, requirePaidTier, require('./routes/locally'));
app.use('/api/:brand_id/shipping/shipblu',  requireBrandOwnership, requirePaidTier, require('./routes/shipping/shipblu'));
app.use('/api/:brand_id/shipping/bosta',    requireBrandOwnership, requirePaidTier, require('./routes/shipping/bosta'));
app.use('/api/:brand_id/team',              requireBrandOwnership, require('./routes/team'));
app.use('/api/:brand_id/onboarding',   requireBrandOwnership, require('./routes/onboarding'));
app.use('/api/:brand_id/debug',        requireBrandOwnership, require('./routes/locally-audit'));
app.use('/api/:brand_id/debug',        requireBrandOwnership, require('./routes/locally-cleanup'));
app.use('/api/debug',                  require('./routes/debug'));

// ── Admin routes — protected by requireAdminAuth (cookie OR X-Admin-Secret) ──
// TIER_SYSTEM — set-tier, tier-history, events query, brand list, brand detail
// Never expose ADMIN_SECRET to the frontend.
app.use('/api/admin', requireAdminAuth, require('./routes/admin'));
// Admin leads — high-priority event queue + contacted tracking (Phase 2)
app.use('/api/admin/leads', requireAdminAuth, require('./routes/admin_leads'));
// Admin impersonation — login-as-brand (Phase 3)
// Mounted at /api/admin so /brands/:id/impersonate resolves to
// /api/admin/brands/:id/impersonate, and /impersonation/end + /impersonation/sessions
// resolve to /api/admin/impersonation/end + /api/admin/impersonation/sessions.
app.use('/api/admin', requireAdminAuth, require('./routes/admin_impersonation'));
// Admin system — health + manual controls (Phase 3)
app.use('/api/admin/system', requireAdminAuth, require('./routes/admin_system'));
// Admin form leads — qualification funnel submissions
app.use('/api/admin/form-leads', requireAdminAuth, require('./routes/admin_form_leads'));
// Admin CX — already mounted at /api/admin/cx above (before brand routes to prevent conflict)

// ── API 404 — only for /api/* paths that matched nothing above ────────────────
app.all('/api/*', (req, res) => {
  res.status(404).json({ ok: false, error: `No route: ${req.method} ${req.originalUrl}` });
});

// ── Frontend catch-all — protected, serves dashboard for every non-API path ──
// SERVER_PAGE_GUARD — requirePageAuth runs first; unauthenticated users are
// redirected to /signin before any HTML is sent.
app.get('*', requirePageAuth, (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(503).send('Dashboard not found — run "npm run setup" or copy index.html into the public/ folder.');
  }
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {        // eslint-disable-line no-unused-vars
  console.error('[server] unhandled error:', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

// ── Startup ───────────────────────────────────────────────────────────────────

function start() {
  // 0. Validate required environment variables before touching anything else
  const encKey = process.env.ENCRYPTION_KEY;
  if (!encKey || encKey.length !== 64) {
    console.error('[server] FATAL: ENCRYPTION_KEY is missing or not 64 hex characters.');
    console.error('[server]        Generate one with:');
    console.error('[server]        node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    console.error('[server]        Then add ENCRYPTION_KEY=<value> to your .env file.');
    process.exit(1);
  }

  // 1. Initialise base schema (idempotent)
  db.initSchema();

  // 2. Run migrations (idempotent)
  runMigrations();

  // 3. Seed default brand from environment (development only).
  // REMOVE_SEED_HARDCODING — never auto-seed in production. Brands are created
  // via POST /api/auth/signup in the normal user flow.
  const seedBrandId   = process.env.SEED_BRAND_ID;
  const seedBrandName = process.env.SEED_BRAND_NAME;
  const isProd        = process.env.NODE_ENV === 'production';
  if (!isProd && seedBrandId && seedBrandName) {
    const existing = db.getBrand(seedBrandId);
    if (!existing) {
      db.upsertBrand({
        id:           seedBrandId,
        name:         seedBrandName,
        slug:         seedBrandId,
        logo_url:     null,
        theme_config: '{}',
      });
      console.log(`[server] Seeded brand (dev only): ${seedBrandId}`);
    }
  } else if (isProd && seedBrandId) {
    console.log('[server] SEED_BRAND_ID ignored in production — use signup flow to create brands');
  }

  // 3b. Hard-gate: refuse to start in production without a persistent volume path.
  // A warning is not enough — data silently wiped on every redeploy is catastrophic.
  if (isProd) {
    const dbPath = process.env.DATABASE_PATH || '';
    if (!dbPath.startsWith('/data')) {
      console.error('[server] FATAL: DATABASE_PATH must point to a Railway persistent volume.');
      console.error('[server]        Current value:', dbPath || '(not set)');
      console.error('[server]        Fix:');
      console.error('[server]          1. Railway dashboard → your service → Volumes → Add Volume');
      console.error('[server]          2. Mount path: /data');
      console.error('[server]          3. Set env var: DATABASE_PATH=/data/optimize.db');
      console.error('[server]        Without this, ALL user data is wiped on every redeploy.');
      process.exit(1);
    }
  }

  // 4. Warn if SERVER_URL not set (webhooks will show placeholder URLs)
  if (!process.env.SERVER_URL) {
    console.warn('[server] WARNING: SERVER_URL not set — webhook URLs will be placeholders');
    console.warn('[server]          Set SERVER_URL=https://your-railway-domain.up.railway.app in .env');
  }

  // 4b. Warn if ADMIN_SECRET not set — admin routes will return 503
  if (!process.env.ADMIN_SECRET) {
    console.warn('[server] WARNING: ADMIN_SECRET not set — /api/admin/* routes are disabled');
    console.warn('[server]          Generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  } else {
    console.log('[server] Admin API: configured — ADMIN_SECRET present ✓');
  }
  // 4b2. Warn if ADMIN_SESSION_SECRET not set — admin cookie sessions won't survive restarts
  if (!process.env.ADMIN_SESSION_SECRET) {
    console.warn('[server] WARNING: ADMIN_SESSION_SECRET not set — admin sessions use ephemeral secret');
    console.warn('[server]          Set ADMIN_SESSION_SECRET for persistent admin login sessions');
  }

  // 4c. Warn if Shopify OAuth env vars are missing — connect button will be disabled on frontend
  // ENV_NEEDED — SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_REDIRECT_URI
  const missingShopifyVars = ['SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'].filter(k => !process.env[k]); // ENV_NEEDED
  if (missingShopifyVars.length) {
    console.warn('[server] WARNING: Shopify OAuth not configured — missing env vars:', missingShopifyVars.join(', '));
    console.warn('[server]          Set these in Railway dashboard → Variables to enable one-click Shopify connect');
  } else {
    console.log('[server] Shopify OAuth: configured — client_id present ✓');
  }

  // 5. Start background jobs
  startScheduler();

  // 5b. Immediate Locally sync on startup — runs in the background without blocking boot.
  //
  // WHY THIS EXISTS:
  //   The cron scheduler fires on clock ticks (e.g. */30 * * * *), not immediately
  //   on startup.  After a Railway redeploy the server can be up to 30 minutes before
  //   the first scheduled sync runs.  This ensures Locally data is always populated
  //   within seconds of any restart rather than waiting up to half an hour.
  {
    const locally = require('./integrations/locally');
    const { db: _db } = require('./db/db');
    setImmediate(async () => {
      try {
        const rows = _db.prepare(
          "SELECT brand_id FROM integrations WHERE platform = 'locally' AND status IN ('connected', 'warning')"
        ).all();
        for (const { brand_id } of rows) {
          console.log(`[server] startup Locally sync for brand=${brand_id}`);
          await locally.fullSync(brand_id);
        }
      } catch (err) {
        // Never crash startup — the scheduler will retry within 30 minutes
        console.warn('[server] startup Locally sync failed (non-fatal):', err.message);
      }
    });
  }

  // 6. Verify dashboard exists
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) {
    console.warn('[server] WARNING: public/index.html not found');
    console.warn('[server]          Run "npm run setup" or copy your dashboard HTML to public/index.html');
  }

  // 7. Listen on all interfaces
  app.listen(PORT, '0.0.0.0', () => {
    const base = process.env.SERVER_URL || `http://localhost:${PORT}`;
    console.log(`
  Optimize — port ${PORT}
  ─────────────────────────────────────────────────────
  Dashboard  →  ${base}/
  Health     →  ${base}/api/health
  Static dir →  ${PUBLIC_DIR}
  Frontend   →  ${fs.existsSync(indexPath) ? 'public/index.html (ready)' : 'public/index.html (MISSING — run npm run setup)'}
  DB         →  ${process.env.DATABASE_PATH || '(default: db/optimize.db)'}
  SERVER_URL →  ${process.env.SERVER_URL || '(not set — set in .env for webhooks)'}
  ─────────────────────────────────────────────────────
    `);
  });
}

start();
