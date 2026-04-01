'use strict';

const Database = require('better-sqlite3');
const fs       = require('fs');
const path     = require('path');

require('dotenv').config();

// Resolve DB path to an absolute path so it works regardless of CWD.
// If DATABASE_PATH is set and relative, resolve it from the project root
// (one level above this db/ directory).
const rawDbPath = process.env.DATABASE_PATH || path.join(__dirname, 'optimize.db');
const DB_PATH   = path.isAbsolute(rawDbPath)
  ? rawDbPath
  : path.resolve(__dirname, '..', rawDbPath);

// Ensure the directory exists
const dbDir = path.dirname(path.resolve(DB_PATH));
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

// Verify the directory is writable before attempting to open the database
try {
  fs.accessSync(dbDir, fs.constants.W_OK);
} catch (err) {
  console.error(`[db] Directory "${dbDir}" is not writable:`, err.message);
  console.error('[db] Set DATABASE_PATH in .env to a writable path (e.g. /tmp/optimize.db)');
  process.exit(1);
}

const db = new Database(DB_PATH);

// WAL mode: allows concurrent reads while a write is in progress
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema init ───────────────────────────────────────────────────────────────

function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
  console.log('[db] Schema initialised — path:', DB_PATH);
}

// ── Brand helpers ─────────────────────────────────────────────────────────────

const getBrand = (id) =>
  db.prepare('SELECT * FROM brands WHERE id = ?').get(id);

const upsertBrand = (brand) =>
  db.prepare(`
    INSERT INTO brands (id, name, slug, logo_url, theme_config)
    VALUES (@id, @name, @slug, @logo_url, @theme_config)
    ON CONFLICT(id) DO UPDATE SET
      name         = excluded.name,
      logo_url     = excluded.logo_url,
      theme_config = excluded.theme_config
  `).run(brand);

// ── Integration helpers ───────────────────────────────────────────────────────

const getIntegration = (brandId, platform) =>
  db.prepare(
    'SELECT * FROM integrations WHERE brand_id = ? AND platform = ?'
  ).get(brandId, platform);

const getAllIntegrations = (brandId) =>
  db.prepare('SELECT * FROM integrations WHERE brand_id = ?').all(brandId);

const saveIntegration = (brandId, platform, credentials, status = 'connected', tokenExpiresAt = null) =>
  db.prepare(`
    INSERT INTO integrations (brand_id, platform, credentials, status, token_expires_at)
    VALUES (@brand_id, @platform, @credentials, @status, @token_expires_at)
    ON CONFLICT(brand_id, platform) DO UPDATE SET
      credentials      = excluded.credentials,
      status           = excluded.status,
      token_expires_at = excluded.token_expires_at
  `).run({ brand_id: brandId, platform, credentials, status, token_expires_at: tokenExpiresAt });

const updateIntegrationStatus = (brandId, platform, status, lastSync = null) =>
  db.prepare(`
    UPDATE integrations
    SET status = ?, last_sync = ?
    WHERE brand_id = ? AND platform = ?
  `).run(status, lastSync || new Date().toISOString(), brandId, platform);

const deleteIntegration = (brandId, platform) =>
  db.prepare(
    'DELETE FROM integrations WHERE brand_id = ? AND platform = ?'
  ).run(brandId, platform);

// ── Sync log helpers ──────────────────────────────────────────────────────────

const logSync = (brandId, platform, status, errorMessage = null, recordsSynced = 0) =>
  db.prepare(`
    INSERT INTO sync_logs (brand_id, platform, status, error_message, records_synced)
    VALUES (@brand_id, @platform, @status, @error_message, @records_synced)
  `).run({ brand_id: brandId, platform, status, error_message: errorMessage, records_synced: recordsSynced });

const getLastSyncLog = (brandId, platform) =>
  db.prepare(
    'SELECT * FROM sync_logs WHERE brand_id = ? AND platform = ? ORDER BY synced_at DESC LIMIT 1'
  ).get(brandId, platform);

// ── Order cache helpers ───────────────────────────────────────────────────────

const upsertOrder = (order) =>
  db.prepare(`
    INSERT INTO orders_cache (
      brand_id, source, source_order_id, customer_name, phone, city,
      items, total, currency, payment_method, financial_status,
      fulfillment_status, shipping, needs_action, action_reason,
      raw_data, created_at
    ) VALUES (
      @brand_id, @source, @source_order_id, @customer_name, @phone, @city,
      @items, @total, @currency, @payment_method, @financial_status,
      @fulfillment_status, @shipping, @needs_action, @action_reason,
      @raw_data, @created_at
    )
    ON CONFLICT(brand_id, source, source_order_id) DO UPDATE SET
      customer_name      = excluded.customer_name,
      phone              = excluded.phone,
      city               = excluded.city,
      items              = excluded.items,
      total              = excluded.total,
      payment_method     = excluded.payment_method,
      financial_status   = excluded.financial_status,
      fulfillment_status = excluded.fulfillment_status,
      shipping           = excluded.shipping,
      needs_action       = excluded.needs_action,
      action_reason      = excluded.action_reason,
      raw_data           = excluded.raw_data,
      updated_at         = datetime('now')
  `).run(order);

function getOrders(brandId, { status, source, search } = {}) {
  let sql    = 'SELECT * FROM orders_cache WHERE brand_id = ?';
  const args = [brandId];

  if (source && source !== 'all') {
    sql += ' AND source = ?';
    args.push(source);
  }

  if (status && status !== 'all') {
    if (status === 'action') {
      sql += ' AND needs_action = 1';
    } else if (status === 'new') {
      sql += " AND (fulfillment_status IS NULL OR fulfillment_status = 'unfulfilled')";
    } else if (status === 'transit') {
      sql += " AND fulfillment_status IN ('partial', 'shipped')";
    } else if (status === 'delivered') {
      sql += " AND fulfillment_status = 'fulfilled'";
    } else if (status === 'failed') {
      sql += " AND fulfillment_status = 'failed'";
    }
  }

  if (search) {
    sql += ' AND (customer_name LIKE ? OR phone LIKE ? OR source_order_id LIKE ?)';
    const t = `%${search}%`;
    args.push(t, t, t);
  }

  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...args);
}

const getOrder = (brandId, orderId) =>
  db.prepare(
    'SELECT * FROM orders_cache WHERE brand_id = ? AND (source_order_id = ? OR CAST(id AS TEXT) = ?)'
  ).get(brandId, orderId, orderId);

// ── Inventory cache helpers ───────────────────────────────────────────────────

const upsertInventory = (item) =>
  db.prepare(`
    INSERT INTO inventory_cache (brand_id, source, product_name, variant_name, sku, quantity, price, raw_data)
    VALUES (@brand_id, @source, @product_name, @variant_name, @sku, @quantity, @price, @raw_data)
    ON CONFLICT(brand_id, source, sku) DO UPDATE SET
      product_name = excluded.product_name,
      variant_name = excluded.variant_name,
      quantity     = excluded.quantity,
      price        = excluded.price,
      raw_data     = excluded.raw_data,
      updated_at   = datetime('now')
  `).run(item);

function getInventory(brandId, { source, search, filter } = {}) {
  let sql    = 'SELECT * FROM inventory_cache WHERE brand_id = ?';
  const args = [brandId];

  if (source && source !== 'all') {
    sql += ' AND source = ?';
    args.push(source);
  }

  if (filter === 'low_stock') {
    sql += ' AND quantity < 5';
  }

  if (search) {
    sql += ' AND (product_name LIKE ? OR variant_name LIKE ? OR sku LIKE ?)';
    const t = `%${search}%`;
    args.push(t, t, t);
  }

  sql += ' ORDER BY product_name, variant_name';
  return db.prepare(sql).all(...args);
}

module.exports = {
  db,
  initSchema,
  getBrand,
  upsertBrand,
  getIntegration,
  getAllIntegrations,
  saveIntegration,
  updateIntegrationStatus,
  deleteIntegration,
  logSync,
  getLastSyncLog,
  upsertOrder,
  getOrders,
  getOrder,
  upsertInventory,
  getInventory,
};
