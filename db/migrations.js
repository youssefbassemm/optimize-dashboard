'use strict';

/**
 * Database migrations — Part B additions.
 *
 * Run once on server startup (after initSchema).
 * All statements use IF NOT EXISTS guards so they are safe to run repeatedly.
 */

const { db } = require('./db');

function runMigrations() {

  // ── integrations — Shopify client-credentials additions ───────────────────
  // ALTER TABLE ADD COLUMN fails with "duplicate column" if run twice, so we
  // catch that error and ignore it (SQLite has no IF NOT EXISTS for columns).
  const addColumn = (table, column, definition) => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (_) {
      // Column already exists — safe to ignore
    }
  };

  // health   : quick-glance token health ('ok' | 'expired' | 'error' | 'unknown')
  // last_error    : most recent human-readable error string (null when healthy)
  // last_tested_at: ISO timestamp of the last explicit /test call
  addColumn('integrations', 'health',         "TEXT DEFAULT 'unknown'");
  addColumn('integrations', 'last_error',     'TEXT DEFAULT NULL');
  addColumn('integrations', 'last_tested_at', 'TEXT DEFAULT NULL');

  // ── campaign_cache (Meta Ads) ──────────────────────────────────────────────
  // UNIQUE on (brand_id, campaign_id, period) enables ON CONFLICT upserts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaign_cache (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id       TEXT    NOT NULL,
      campaign_id    TEXT,
      campaign_name  TEXT,
      spend          REAL    DEFAULT 0,
      impressions    INTEGER DEFAULT 0,
      purchases      INTEGER DEFAULT 0,
      purchase_value REAL    DEFAULT 0,
      roas           REAL    DEFAULT 0,
      cpa            REAL    DEFAULT 0,
      period         TEXT,
      fetched_at     TEXT    DEFAULT (datetime('now')),
      UNIQUE(brand_id, campaign_id, period)
    );

    CREATE INDEX IF NOT EXISTS idx_campaign_brand_period
      ON campaign_cache(brand_id, period, fetched_at DESC);
  `);

  // ── ig_cache (Instagram metrics) ──────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS ig_cache (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id        TEXT    NOT NULL,
      followers_count INTEGER DEFAULT 0,
      media_count     INTEGER DEFAULT 0,
      recent_posts    TEXT    DEFAULT '[]',
      fetched_at      TEXT    DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ig_brand
      ON ig_cache(brand_id, fetched_at DESC);
  `);

  console.log('[migrations] Part B tables ready');
}

module.exports = { runMigrations };
