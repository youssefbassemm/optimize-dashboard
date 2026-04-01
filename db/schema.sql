-- Optimize Backend — SQLite schema
-- Safe to run multiple times (IF NOT EXISTS everywhere)

-- ── Brands ────────────────────────────────────────────────────────────────────
-- One row per client brand. v1 ships with a single seed row ("etrnll").
CREATE TABLE IF NOT EXISTS brands (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  slug         TEXT UNIQUE NOT NULL,
  logo_url     TEXT DEFAULT NULL,
  theme_config TEXT DEFAULT '{}',    -- JSON: accent colour, font overrides, etc.
  created_at   TEXT DEFAULT (datetime('now'))
);

-- ── Integrations ──────────────────────────────────────────────────────────────
-- One row per (brand × platform). Credentials are AES-256-CBC encrypted JSON.
CREATE TABLE IF NOT EXISTS integrations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id         TEXT    NOT NULL,
  platform         TEXT    NOT NULL,   -- 'shopify' | 'locally' | 'shipblu' | 'meta'
  credentials      TEXT    NOT NULL,   -- encrypted JSON
  status           TEXT    DEFAULT 'disconnected',  -- 'connected' | 'error' | 'disconnected'
  last_sync        TEXT    DEFAULT NULL,
  token_expires_at TEXT    DEFAULT NULL,
  created_at       TEXT    DEFAULT (datetime('now')),
  UNIQUE(brand_id, platform),
  FOREIGN KEY (brand_id) REFERENCES brands(id)
);

-- ── Sync logs ─────────────────────────────────────────────────────────────────
-- Every sync attempt is recorded here so the Settings tab can show history.
CREATE TABLE IF NOT EXISTS sync_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id       TEXT    NOT NULL,
  platform       TEXT    NOT NULL,
  status         TEXT    NOT NULL,   -- 'success' | 'error' | 'partial'
  error_message  TEXT    DEFAULT NULL,
  records_synced INTEGER DEFAULT 0,
  synced_at      TEXT    DEFAULT (datetime('now'))
);

-- ── Orders cache ──────────────────────────────────────────────────────────────
-- Normalized orders from all sources (Shopify, Locally).
-- The frontend reads from this table — never directly from third-party APIs.
CREATE TABLE IF NOT EXISTS orders_cache (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id           TEXT    NOT NULL,
  source             TEXT    NOT NULL,   -- 'shopify' | 'locally'
  source_order_id    TEXT    NOT NULL,
  customer_name      TEXT,
  phone              TEXT,
  city               TEXT,
  items              TEXT    DEFAULT '[]',   -- JSON array
  total              REAL    DEFAULT 0,
  currency           TEXT    DEFAULT 'EGP',
  payment_method     TEXT,
  financial_status   TEXT,
  fulfillment_status TEXT,
  shipping           TEXT    DEFAULT '{}',   -- JSON: carrier, tracking, timeline
  needs_action       INTEGER DEFAULT 0,      -- SQLite boolean (0/1)
  action_reason      TEXT,
  raw_data           TEXT    DEFAULT '{}',   -- full source payload for debugging
  created_at         TEXT,
  updated_at         TEXT    DEFAULT (datetime('now')),
  UNIQUE(brand_id, source, source_order_id)
);

-- Index to speed up the most common query (brand + date sort)
CREATE INDEX IF NOT EXISTS idx_orders_brand_created
  ON orders_cache(brand_id, created_at DESC);

-- ── Inventory cache ───────────────────────────────────────────────────────────
-- Normalized inventory from Shopify (and eventually Locally).
CREATE TABLE IF NOT EXISTS inventory_cache (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id     TEXT    NOT NULL,
  source       TEXT    NOT NULL,   -- 'shopify' | 'locally'
  product_name TEXT,
  variant_name TEXT,
  sku          TEXT,
  quantity     INTEGER DEFAULT 0,
  price        REAL    DEFAULT 0,
  raw_data     TEXT    DEFAULT '{}',
  updated_at   TEXT    DEFAULT (datetime('now')),
  UNIQUE(brand_id, source, sku)
);
