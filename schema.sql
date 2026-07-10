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
  total_items        INTEGER DEFAULT 0,      -- sum of line-item quantities for units-sold aggregation
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

-- ── Users ─────────────────────────────────────────────────────────────────────
-- One row per human operator / team member.
-- Passwords are stored as bcrypt hashes — never plaintext.
-- `name` stores the user's full name (mapped from full_name in the signup form).
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    UNIQUE NOT NULL,
  password_hash TEXT    NOT NULL,
  name          TEXT    NOT NULL,             -- full name, e.g. "Jane Doe"
  role          TEXT    NOT NULL DEFAULT 'member',  -- 'owner' | 'admin' | 'member'
  is_active     INTEGER NOT NULL DEFAULT 1,   -- 0 = suspended
  last_login_at TEXT    DEFAULT NULL,
  created_at    TEXT    DEFAULT (datetime('now')),
  updated_at    TEXT    DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ── User → Brand access ───────────────────────────────────────────────────────
-- Many-to-many: a user can access multiple brands; a brand can have multiple users.
CREATE TABLE IF NOT EXISTS user_brands (
  user_id    INTEGER NOT NULL,
  brand_id   TEXT    NOT NULL,
  role       TEXT    NOT NULL DEFAULT 'member',  -- 'owner' | 'admin' | 'member'
  created_at TEXT    DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, brand_id),
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
);

-- ── Sessions ──────────────────────────────────────────────────────────────────
-- Server-side sessions. Each login creates a row; logout deletes it.
-- JWT or cookie-based — both point back to this table.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT    PRIMARY KEY,          -- random UUID / secure token
  user_id    INTEGER NOT NULL,
  brand_id   TEXT    DEFAULT NULL,         -- currently selected brand (nullable)
  ip_address TEXT    DEFAULT NULL,
  user_agent TEXT    DEFAULT NULL,
  expires_at TEXT    NOT NULL,
  created_at TEXT    DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ── Password reset tokens ────────────────────────────────────────────────────
-- One-time tokens for password reset. Raw token is in the email link;
-- only the SHA-256 hash is stored so a DB breach can't be replayed.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  token_hash TEXT    NOT NULL UNIQUE,   -- SHA-256(raw_token)
  expires_at TEXT    NOT NULL,          -- 1-hour TTL
  used       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_prt_hash ON password_reset_tokens(token_hash);

-- ── Team invites ──────────────────────────────────────────────────────────────
-- Invite tokens sent to new team members. Accepting creates a user + user_brands row.
CREATE TABLE IF NOT EXISTS team_invites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id   TEXT    NOT NULL,
  email      TEXT    NOT NULL,
  role       TEXT    NOT NULL DEFAULT 'member',
  token_hash TEXT    NOT NULL UNIQUE,   -- SHA-256(raw_token)
  expires_at TEXT    NOT NULL,          -- 48-hour TTL
  accepted   INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT    DEFAULT (datetime('now')),
  FOREIGN KEY (brand_id)   REFERENCES brands(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

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

-- Supports brand-scoped inventory queries (getInventory() always filters by brand_id)
CREATE INDEX IF NOT EXISTS idx_inventory_brand
  ON inventory_cache(brand_id);

-- Supports sync history queries in the Settings tab (brand + recency filter)
CREATE INDEX IF NOT EXISTS idx_sync_logs_brand_time
  ON sync_logs(brand_id, synced_at DESC);
