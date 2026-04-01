'use strict';

require('dotenv').config();

const express = require('express');
const path    = require('path');
const db      = require('./db/db');
const { runMigrations } = require('./db/migrations');
const { startScheduler } = require('./jobs/scheduler');

const app  = express();
const PORT = process.env.PORT || 3000;

// Trust reverse proxies (Railway, Render, Heroku, DigitalOcean, etc.)
app.set('trust proxy', 1);

// ── Dev CORS ──────────────────────────────────────────────────────────────────
// Only active when NODE_ENV=development. In production the dashboard is served
// from the same origin so no CORS headers are needed.
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });
}

// ── Webhook routes (raw body — must come before json() middleware) ─────────────
app.use('/api/webhooks', require('./routes/webhooks'));

// ── Body parsers ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Static frontend ───────────────────────────────────────────────────────────
const fs         = require('fs');
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(express.static(PUBLIC_DIR));

// Root → dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/health', require('./routes/health'));

app.use('/api/:brand_id/integrations', require('./routes/integrations'));
app.use('/api/:brand_id/settings',     require('./routes/settings'));
app.use('/api/:brand_id/orders',       require('./routes/orders'));
app.use('/api/:brand_id/inventory',    require('./routes/inventory'));
app.use('/api/:brand_id/sales',        require('./routes/sales'));
app.use('/api/:brand_id/campaigns',    require('./routes/campaigns'));
app.use('/api/:brand_id/locally',      require('./routes/locally'));

// ── API 404 — only for /api/* paths that matched nothing above ────────────────
app.all('/api/*', (req, res) => {
  res.status(404).json({ ok: false, error: `No route: ${req.method} ${req.originalUrl}` });
});

// ── Frontend catch-all — serve dashboard for every non-API path ───────────────
app.get('*', (req, res) => {
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

  // 3. Seed default brand
  const existing = db.getBrand('etrnll');
  if (!existing) {
    db.upsertBrand({ id: 'etrnll', name: 'etrnll', slug: 'etrnll', logo_url: null, theme_config: '{}' });
  }

  // 4. Verify brand exists after seeding
  const brand = db.getBrand('etrnll');
  if (!brand) {
    console.error('[server] FATAL: brand "etrnll" does not exist after seeding — check database path and permissions');
    process.exit(1);
  }

  // 5. Warn if SERVER_URL not set (webhooks will show placeholder URLs)
  if (!process.env.SERVER_URL) {
    console.warn('[server] WARNING: SERVER_URL not set — webhook URLs will be placeholders');
    console.warn('[server]          Set SERVER_URL=https://yourdomain.com in .env');
  }

  // 6. Start background jobs
  startScheduler();

  // 7. Verify dashboard exists
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) {
    console.warn('[server] WARNING: public/index.html not found');
    console.warn('[server]          Run "npm run setup" or copy your dashboard HTML to public/index.html');
  }

  // 8. Listen on all interfaces
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
