-- Optimize platform — base schema
-- All statements use CREATE TABLE IF NOT EXISTS so this file is safe to re-run.
-- Columns added by migrations.js via addColumn() are included here so the table
-- is fully formed on first boot; addColumn() catches "duplicate column" errors and
-- ignores them, so there is no conflict.

-- ── Brands ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brands (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  slug              TEXT,
  logo_url          TEXT DEFAULT NULL,
  theme_config      TEXT DEFAULT NULL,
  created_at        TEXT DEFAULT (datetime('now')),
  -- onboarding (added via migration addColumn — safe duplicates)
  onboarded         INTEGER DEFAULT 0,
  onboarding_step   TEXT    DEFAULT 'welcome',
  onboarded_at      TEXT    DEFAULT NULL,
  checklist_dismissed INTEGER DEFAULT 0,
  -- tier system
  tier              TEXT    NOT NULL DEFAULT 'free',
  last_seen_at      TEXT    DEFAULT NULL,
  -- signup profile
  ig_handle         TEXT    DEFAULT NULL,
  revenue_range     TEXT    DEFAULT NULL,
  has_showroom      INTEGER DEFAULT 0,
  showroom_platform TEXT    DEFAULT NULL,
  -- branding
  brand_color       TEXT    DEFAULT NULL,
  logo_uploaded_at  TEXT    DEFAULT NULL,
  -- workspace type
  business_type     TEXT    NOT NULL DEFAULT 'ecommerce'
);

-- ── Integrations ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS integrations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id        TEXT    NOT NULL,
  platform        TEXT    NOT NULL,
  credentials     TEXT    DEFAULT NULL,
  status          TEXT    NOT NULL DEFAULT 'disconnected',
  token_expires_at TEXT   DEFAULT NULL,
  last_sync       TEXT    DEFAULT NULL,
  -- health fields (migration addColumn)
  health              TEXT    DEFAULT 'unknown',
  last_error          TEXT    DEFAULT NULL,
  last_tested_at      TEXT    DEFAULT NULL,
  locally_imported_at TEXT    DEFAULT NULL,
  sync_paused         INTEGER DEFAULT 0,
  UNIQUE(brand_id, platform),
  FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_integrations_brand
  ON integrations(brand_id, platform);

-- ── Sync logs ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id       TEXT    NOT NULL,
  platform       TEXT    NOT NULL,
  status         TEXT    NOT NULL,
  error_message  TEXT    DEFAULT NULL,
  records_synced INTEGER DEFAULT 0,
  synced_at      TEXT    DEFAULT (datetime('now')),
  FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sync_logs_brand
  ON sync_logs(brand_id, platform, synced_at DESC);

-- ── Orders cache ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders_cache (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id           TEXT    NOT NULL,
  source             TEXT    NOT NULL,
  source_order_id    TEXT    NOT NULL,
  customer_name      TEXT    DEFAULT NULL,
  phone              TEXT    DEFAULT NULL,
  city               TEXT    DEFAULT NULL,
  items              TEXT    DEFAULT '[]',
  total              REAL    DEFAULT 0,
  total_items        INTEGER DEFAULT 0,
  currency           TEXT    DEFAULT 'EGP',
  payment_method     TEXT    DEFAULT NULL,
  financial_status   TEXT    DEFAULT NULL,
  fulfillment_status TEXT    DEFAULT NULL,
  shipping           TEXT    DEFAULT NULL,
  needs_action       INTEGER DEFAULT 0,
  action_reason      TEXT    DEFAULT NULL,
  raw_data           TEXT    DEFAULT NULL,
  created_at         TEXT    DEFAULT (datetime('now')),
  updated_at         TEXT    DEFAULT (datetime('now')),
  UNIQUE(brand_id, source, source_order_id),
  FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_orders_brand_status
  ON orders_cache(brand_id, source, financial_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_action
  ON orders_cache(brand_id, needs_action, created_at DESC);

-- ── Order items ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id     TEXT    NOT NULL,
  source       TEXT    NOT NULL,
  order_ref    TEXT    NOT NULL,
  product_name TEXT,
  variant      TEXT,
  qty          INTEGER DEFAULT 1,
  price        REAL    DEFAULT 0,
  sku          TEXT,
  created_at   TEXT    DEFAULT (datetime('now')),
  FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_order_items_ref
  ON order_items(brand_id, source, order_ref);

-- ── Inventory cache ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_cache (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id     TEXT    NOT NULL,
  source       TEXT    NOT NULL,
  product_name TEXT    DEFAULT NULL,
  variant_name TEXT    DEFAULT NULL,
  sku          TEXT    DEFAULT NULL,
  quantity     REAL    DEFAULT 0,
  price        REAL    DEFAULT 0,
  raw_data     TEXT    DEFAULT NULL,
  updated_at   TEXT    DEFAULT (datetime('now')),
  UNIQUE(brand_id, source, sku),
  FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_inventory_brand
  ON inventory_cache(brand_id, source);

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  name          TEXT    DEFAULT NULL,
  role          TEXT    NOT NULL DEFAULT 'member',
  is_active     INTEGER NOT NULL DEFAULT 1,
  phone         TEXT    DEFAULT NULL,
  last_login_at TEXT    DEFAULT NULL,
  created_at    TEXT    DEFAULT (datetime('now'))
);

-- ── User → Brand access ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_brands (
  user_id    INTEGER NOT NULL,
  brand_id   TEXT    NOT NULL,
  role       TEXT    NOT NULL DEFAULT 'member',
  created_at TEXT    DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, brand_id),
  UNIQUE(user_id, brand_id),
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
);

-- ── Sessions ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  brand_id    TEXT    DEFAULT NULL,
  ip_address  TEXT    DEFAULT NULL,
  user_agent  TEXT    DEFAULT NULL,
  expires_at  TEXT    NOT NULL,
  created_at  TEXT    DEFAULT (datetime('now')),
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user
  ON sessions(user_id, expires_at);
