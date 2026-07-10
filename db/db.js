'use strict';

const Database = require('better-sqlite3');
const crypto   = require('crypto');
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

// LAST_SYNC_EXPLICIT — updateIntegrationStatus only touches status.
// last_sync must be advanced EXPLICITLY by each integration after a
// successful data fetch. The old signature silently set last_sync=NOW
// on EVERY call (including error calls), which advanced the incremental
// sync window even on failure — permanently skipping the failed period
// on the next Shopify incremental run.
const updateIntegrationStatus = (brandId, platform, status) =>
  db.prepare(`
    UPDATE integrations
    SET status = ?
    WHERE brand_id = ? AND platform = ?
  `).run(status, brandId, platform);

const deleteIntegration = (brandId, platform) =>
  db.prepare(
    'DELETE FROM integrations WHERE brand_id = ? AND platform = ?'
  ).run(brandId, platform);

// DISCONNECT_STANDARDIZATION — soft-disconnect: keep the row, null out credentials.
// Preferred over deleteIntegration so the UI can show "disconnected" state
// and the settings page knows to offer a reconnect flow (not a first-time setup flow).
// Clears: credentials, health, last_error, last_tested_at, last_sync, token_expires_at.
// Does NOT clear cached order/inventory data — that is managed per-platform.
const disconnectIntegration = (brandId, platform) =>
  db.prepare(`
    UPDATE integrations
    SET status           = 'disconnected',
        credentials      = NULL,
        health           = NULL,
        last_error       = NULL,
        last_tested_at   = NULL,
        last_sync        = NULL,
        token_expires_at = NULL
    WHERE brand_id = ? AND platform = ?
  `).run(brandId, platform);

// BRAND_WORKSPACE_CREATION — mark a brand's onboarding as complete.
// Called by POST /api/auth/complete-onboarding after the user finishes setup.
// Also sets onboarding_step='done' and records the ISO timestamp in onboarded_at.
const markBrandOnboarded = (brandId) =>
  db.prepare(`
    UPDATE brands
    SET onboarded       = 1,
        onboarding_step = 'done',
        onboarded_at    = datetime('now')
    WHERE id = ?
  `).run(brandId);

// ONBOARDING_FLOW — persist the user's current step so they can resume mid-flow.
// step values: 'welcome' | 'shopify' | 'locally' | 'shipping' | 'meta' | 'done'
const updateOnboardingStep = (brandId, step) =>
  db.prepare("UPDATE brands SET onboarding_step = ? WHERE id = ?").run(step, brandId);

// ONBOARDING_FLOW — called when user dismisses the setup checklist card.
// Once dismissed the card never re-renders, regardless of integration status.
const setChecklistDismissed = (brandId) =>
  db.prepare("UPDATE brands SET checklist_dismissed = 1 WHERE id = ?").run(brandId);

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

// ── Integration health helpers ────────────────────────────────────────────────
// INTEGRATION_HEALTH_RESPONSE

/** Staleness thresholds per platform (ms). */
const STALE_MS = {
  shopify: 8 * 3600000,
  locally: 2 * 3600000,
  shipblu: 2 * 3600000,
  meta:    3 * 3600000,
};

/**
 * Returns a standardised integration_health object for one platform.
 * Never throws — returns a 'never' stub if the integration doesn't exist.
 * @param {string} brandId
 * @param {string} platform  shopify | locally | shipblu | meta
 * @returns {{ connected, last_sync_attempt, last_successful_sync, sync_status, credential_valid, error_message }}
 */
function getIntegrationHealth(brandId, platform) {
  try {
    const integration = db.prepare(
      'SELECT * FROM integrations WHERE brand_id = ? AND platform = ?'
    ).get(brandId, platform);

    if (!integration) {
      return {
        connected:            false,
        last_sync_attempt:    null,
        last_successful_sync: null,
        sync_status:          'never',
        credential_valid:     false,
        error_message:        null,
      };
    }

    const lastLog = db.prepare(
      'SELECT * FROM sync_logs WHERE brand_id = ? AND platform = ? ORDER BY synced_at DESC LIMIT 1'
    ).get(brandId, platform);

    const lastSuccess = db.prepare(
      "SELECT * FROM sync_logs WHERE brand_id = ? AND platform = ? AND status = 'success' ORDER BY synced_at DESC LIMIT 1"
    ).get(brandId, platform);

    const staleMs = STALE_MS[platform] || 6 * 3600000;
    let sync_status = 'never';

    if (lastLog) {
      const s = lastLog.status;
      if (s === 'error' || s === 'failed') {
        sync_status = 'failed';
      } else if (lastSuccess) {
        const ageMs = Date.now() - new Date(lastSuccess.synced_at).getTime();
        sync_status = ageMs > staleMs ? 'stale' : 'ok';
      } else {
        sync_status = 'failed';
      }
    }

    return {
      connected:            integration.status === 'connected',
      last_sync_attempt:    lastLog?.synced_at || integration.last_sync || null,
      last_successful_sync: lastSuccess?.synced_at || null,
      sync_status,
      credential_valid:     integration.health !== 'error',
      error_message:        integration.last_error || lastLog?.error_message || null,
    };
  } catch (_) {
    return {
      connected: false, last_sync_attempt: null, last_successful_sync: null,
      sync_status: 'never', credential_valid: false, error_message: null,
    };
  }
}

/**
 * Write health + last_tested_at back to an integrations row.
 * @param {string} brandId
 * @param {string} platform
 * @param {'ok'|'error'|'warning'} health
 * @param {string|null} lastError
 */
function setIntegrationHealth(brandId, platform, health, lastError = null) {
  db.prepare(`
    UPDATE integrations
    SET health = ?, last_error = ?, last_tested_at = datetime('now')
    WHERE brand_id = ? AND platform = ?
  `).run(health, lastError, brandId, platform);
}

// ── Order cache helpers ───────────────────────────────────────────────────────

const upsertOrder = (order) => {
  // Ensure total_items has a default so callers that don't set it (Shopify,
  // ShipBlu) don't cause a "missing parameter" error in better-sqlite3.
  const row = { total_items: 0, ...order };
  return db.prepare(`
    INSERT INTO orders_cache (
      brand_id, source, source_order_id, customer_name, phone, city,
      items, total, total_items, currency, payment_method, financial_status,
      fulfillment_status, shipping, needs_action, action_reason,
      raw_data, created_at
    ) VALUES (
      @brand_id, @source, @source_order_id, @customer_name, @phone, @city,
      @items, @total, @total_items, @currency, @payment_method, @financial_status,
      @fulfillment_status, @shipping, @needs_action, @action_reason,
      @raw_data, @created_at
    )
    ON CONFLICT(brand_id, source, source_order_id) DO UPDATE SET
      customer_name      = excluded.customer_name,
      phone              = excluded.phone,
      city               = excluded.city,
      items              = excluded.items,
      total              = excluded.total,
      total_items        = excluded.total_items,
      payment_method     = excluded.payment_method,
      financial_status   = excluded.financial_status,
      fulfillment_status = excluded.fulfillment_status,
      shipping           = excluded.shipping,
      needs_action       = excluded.needs_action,
      action_reason      = excluded.action_reason,
      raw_data           = excluded.raw_data,
      created_at         = excluded.created_at,
      updated_at         = datetime('now')
  `).run(row);
};

/**
 * Write the normalised line items for one order to the order_items table.
 * Uses delete-then-insert so each sync run produces a clean, current snapshot.
 *
 * @param {string} brandId
 * @param {string} source      'locally' | 'shopify' | ...
 * @param {string} orderRef    source_order_id of the parent order
 * @param {Array}  items       [{ name, variant, qty, price, sku }, ...]
 */
const upsertOrderItems = (brandId, source, orderRef, items) => {
  if (!Array.isArray(items) || items.length === 0) return;
  db.prepare(
    'DELETE FROM order_items WHERE brand_id = ? AND source = ? AND order_ref = ?'
  ).run(brandId, source, orderRef);
  const stmt = db.prepare(`
    INSERT INTO order_items (brand_id, source, order_ref, product_name, variant, qty, price, sku)
    VALUES (@brand_id, @source, @order_ref, @product_name, @variant, @qty, @price, @sku)
  `);
  for (const item of items) {
    stmt.run({
      brand_id:     brandId,
      source,
      order_ref:    orderRef,
      product_name: item.name  || 'Unknown',
      variant:      item.variant || null,
      qty:          Number(item.qty  || item.quantity || 1),
      price:        parseFloat(item.price || 0),
      sku:          item.sku   || null,
    });
  }
};

function getOrders(brandId, { status, source, search, from, to, limit, offset } = {}) {
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

  if (from) {
    sql += ' AND created_at >= ?';
    args.push(from);
  }
  if (to) {
    sql += ' AND created_at <= ?';
    args.push(to);
  }

  if (search) {
    sql += ' AND (customer_name LIKE ? OR phone LIKE ? OR source_order_id LIKE ?)';
    const t = `%${search}%`;
    args.push(t, t, t);
  }

  sql += ' ORDER BY created_at DESC';

  const pageSize = (limit && Number.isInteger(limit) && limit > 0) ? Math.min(limit, 500) : 200;
  const pageOffset = (offset && Number.isInteger(offset) && offset >= 0) ? offset : 0;
  sql += ` LIMIT ${pageSize} OFFSET ${pageOffset}`;

  return db.prepare(sql).all(...args);
}

function countOrders(brandId, { status, source, search, from, to } = {}) {
  let sql    = 'SELECT COUNT(*) AS cnt FROM orders_cache WHERE brand_id = ?';
  const args = [brandId];

  if (source && source !== 'all') { sql += ' AND source = ?'; args.push(source); }
  if (status && status !== 'all') {
    if (status === 'action')    sql += ' AND needs_action = 1';
    else if (status === 'new')  sql += " AND (fulfillment_status IS NULL OR fulfillment_status = 'unfulfilled')";
    else if (status === 'transit') sql += " AND fulfillment_status IN ('partial', 'shipped')";
    else if (status === 'delivered') sql += " AND fulfillment_status = 'fulfilled'";
    else if (status === 'failed')    sql += " AND fulfillment_status = 'failed'";
  }
  if (from)   { sql += ' AND created_at >= ?'; args.push(from); }
  if (to)     { sql += ' AND created_at <= ?'; args.push(to); }
  if (search) {
    sql += ' AND (customer_name LIKE ? OR phone LIKE ? OR source_order_id LIKE ?)';
    const t = `%${search}%`;
    args.push(t, t, t);
  }
  return db.prepare(sql).get(...args)?.cnt || 0;
}

const getOrder = (brandId, orderId) =>
  db.prepare(
    'SELECT * FROM orders_cache WHERE brand_id = ? AND (source_order_id = ? OR CAST(id AS TEXT) = ?)'
  ).get(brandId, orderId, orderId);

// ── Inventory cache helpers ───────────────────────────────────────────────────

/**
 * Generate a stable, deterministic SKU for an inventory item with no real SKU.
 *
 * Hash inputs: source + normalised product_name + normalised variant_name.
 * Result format: "loc-<16 hex chars>" (Locally) or "shp-<16 hex chars>" (Shopify).
 *
 * This is the canonical fallback used by BOTH upsertInventory() and normalizeProduct()
 * in integrations/locally.js so the same product always produces the same key
 * regardless of which sync run or API call order it appears in.
 *
 * @param {string} source        'locally' | 'shopify'
 * @param {string} productName   Raw product name (will be normalised internally)
 * @param {string} [variantName] Raw variant name (will be normalised internally)
 * @returns {string}
 */
function canonicalSku(source, productName, variantName) {
  const src = String(source || 'unknown').slice(0, 3);
  const key = [
    source || '',
    String(productName || '').toLowerCase().trim().replace(/\s+/g, ' '),
    String(variantName  || '').toLowerCase().trim().replace(/\s+/g, ' '),
  ].join('|');
  return `${src}-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

/**
 * Upsert one inventory row.
 *
 * NORMALISATION (applied before every write):
 *   • product_name / variant_name: trimmed, collapsed whitespace
 *   • sku: never stored as NULL or '' — a stable hash is generated if missing
 *
 * DEDUPLICATION KEY: (brand_id, source, sku)
 *   The schema UNIQUE constraint prevents same-source duplicates.
 *   getInventory() further merges same-SKU rows from different sources
 *   so the API returns exactly 1 row per SKU.
 */
const upsertInventory = (item) => {
  const productName = String(item.product_name || '').trim().replace(/\s+/g, ' ') || null;
  const variantName = item.variant_name
    ? String(item.variant_name).trim().replace(/\s+/g, ' ') || null
    : null;
  const sku = (item.sku && String(item.sku).trim())
    || canonicalSku(item.source || 'unknown', productName || '', variantName || '');

  return db.prepare(`
    INSERT INTO inventory_cache (brand_id, source, product_name, variant_name, sku, quantity, price, raw_data)
    VALUES (@brand_id, @source, @product_name, @variant_name, @sku, @quantity, @price, @raw_data)
    ON CONFLICT(brand_id, source, sku) DO UPDATE SET
      product_name = excluded.product_name,
      variant_name = excluded.variant_name,
      quantity     = excluded.quantity,
      price        = excluded.price,
      raw_data     = excluded.raw_data,
      updated_at   = datetime('now')
  `).run({ ...item, product_name: productName, variant_name: variantName, sku });
};

/**
 * Query inventory.
 *
 * Returns ONE row per canonical SKU (aggregated across sources) so the
 * frontend never shows the same product twice.  Per-source quantities are
 * exposed as qty_shopify / qty_locally so the UI can still show
 * "online" vs "showroom" stock levels.
 *
 * Filters are applied BEFORE aggregation (on individual source rows);
 * the low_stock filter is applied AFTER aggregation on the SUM.
 */
function getInventory(brandId, { source, search, filter } = {}) {
  const where = ['brand_id = ?'];
  const args  = [brandId];

  if (source && source !== 'all') {
    where.push('source = ?');
    args.push(source);
  }

  if (search) {
    where.push('(product_name LIKE ? OR variant_name LIKE ? OR sku LIKE ?)');
    const t = `%${search}%`;
    args.push(t, t, t);
  }

  // low_stock is applied AFTER GROUP BY (HAVING clause) so it tests the total
  // quantity across all sources, not individual source rows.
  const having = filter === 'low_stock' ? 'HAVING SUM(quantity) < 5' : '';

  const sql = `
    SELECT
      sku,
      MAX(product_name)  AS product_name,
      MAX(variant_name)  AS variant_name,
      SUM(quantity)      AS quantity,
      SUM(CASE WHEN source = 'shopify' THEN quantity ELSE 0 END) AS qty_shopify,
      SUM(CASE WHEN source = 'locally' THEN quantity ELSE 0 END) AS qty_locally,
      MAX(price)         AS price,
      MAX(updated_at)    AS updated_at
    FROM inventory_cache
    WHERE ${where.join(' AND ')}
    GROUP BY LOWER(TRIM(sku))
    ${having}
    ORDER BY MAX(product_name), MAX(variant_name)
  `;
  return db.prepare(sql).all(...args);
}

// ── User helpers ──────────────────────────────────────────────────────────────

const findUserByEmail = (email) =>
  db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email);

const getUserById = (id) =>
  db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(id);

const createUser = ({ email, passwordHash, name, role = 'member' }) =>
  db.prepare(`
    INSERT INTO users (email, password_hash, name, role)
    VALUES (@email, @password_hash, @name, @role)
  `).run({ email, password_hash: passwordHash, name, role });

const updateUserLastLogin = (id) =>
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(id);

// ── User → Brand access helpers ───────────────────────────────────────────────

const grantUserBrand = (userId, brandId, role = 'member') =>
  db.prepare(`
    INSERT OR IGNORE INTO user_brands (user_id, brand_id, role)
    VALUES (?, ?, ?)
  `).run(userId, brandId, role);

const getUserBrands = (userId) =>
  db.prepare(`
    SELECT b.*, ub.role AS user_role
    FROM brands b
    JOIN user_brands ub ON ub.brand_id = b.id
    WHERE ub.user_id = ?
    ORDER BY b.name
  `).all(userId);

const userHasBrandAccess = (userId, brandId) =>
  !!db.prepare('SELECT 1 FROM user_brands WHERE user_id = ? AND brand_id = ?').get(userId, brandId);

// ── Session helpers ───────────────────────────────────────────────────────────

const createSession = ({ id, userId, brandId = null, ipAddress = null, userAgent = null, expiresAt }) =>
  db.prepare(`
    INSERT INTO sessions (id, user_id, brand_id, ip_address, user_agent, expires_at)
    VALUES (@id, @user_id, @brand_id, @ip_address, @user_agent, @expires_at)
  `).run({ id, user_id: userId, brand_id: brandId, ip_address: ipAddress, user_agent: userAgent, expires_at: expiresAt });

const getSessionById = (id) =>
  db.prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')").get(id);

const deleteSession = (id) =>
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);

const deleteExpiredSessions = () =>
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();

// ── Password reset token helpers ──────────────────────────────────────────────

const createPasswordResetToken = (userId, tokenHash, expiresAt) =>
  db.prepare(`
    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
    VALUES (?, ?, ?)
  `).run(userId, tokenHash, expiresAt);

const getPasswordResetToken = (tokenHash) =>
  db.prepare(`
    SELECT * FROM password_reset_tokens
    WHERE token_hash = ? AND used = 0 AND expires_at > datetime('now')
  `).get(tokenHash);

const markResetTokenUsed = (tokenHash) =>
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE token_hash = ?').run(tokenHash);

const deleteExpiredResetTokens = () =>
  db.prepare("DELETE FROM password_reset_tokens WHERE expires_at <= datetime('now') OR used = 1").run();

// ── Team invite helpers ───────────────────────────────────────────────────────

const createTeamInvite = (brandId, email, role, tokenHash, expiresAt, createdBy) =>
  db.prepare(`
    INSERT INTO team_invites (brand_id, email, role, token_hash, expires_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(brandId, email, role, tokenHash, expiresAt, createdBy || null);

const getTeamInvite = (tokenHash) =>
  db.prepare(`
    SELECT * FROM team_invites
    WHERE token_hash = ? AND accepted = 0 AND expires_at > datetime('now')
  `).get(tokenHash);

const markInviteAccepted = (tokenHash) =>
  db.prepare('UPDATE team_invites SET accepted = 1 WHERE token_hash = ?').run(tokenHash);

const getTeamMembers = (brandId) =>
  db.prepare(`
    SELECT u.id, u.email, u.name, ub.role, ub.created_at AS joined_at
    FROM users u
    JOIN user_brands ub ON ub.user_id = u.id
    WHERE ub.brand_id = ?
    ORDER BY ub.created_at
  `).all(brandId);

const getPendingInvites = (brandId) =>
  db.prepare(`
    SELECT id, email, role, expires_at, created_at
    FROM team_invites
    WHERE brand_id = ? AND accepted = 0 AND expires_at > datetime('now')
    ORDER BY created_at DESC
  `).all(brandId);

// ── Tier helpers ──────────────────────────────────────────────────────────────

/**
 * Return the current tier for a brand. Defaults to 'free' if the column is
 * absent (before migration) or the brand doesn't exist.
 */
const getBrandTier = (brandId) => {
  const row = db.prepare('SELECT tier FROM brands WHERE id = ?').get(brandId);
  return row?.tier || 'free';
};

/**
 * Atomically update brands.tier AND insert an audit row into tier_changes.
 * Always call this instead of a bare UPDATE — the audit trail is non-negotiable.
 *
 * @param {string} brandId
 * @param {'free'|'paid'} newTier
 * @param {string} changedBy  'admin' | 'system' | user email
 * @param {string|null} note  Optional reason / context
 */
function setBrandTier(brandId, newTier, changedBy = 'system', note = null) {
  const current = getBrandTier(brandId);
  if (current === newTier) return; // no-op — tier unchanged

  const tierTx = db.transaction(() => {
    db.prepare("UPDATE brands SET tier = ? WHERE id = ?").run(newTier, brandId);
    db.prepare(`
      INSERT INTO tier_changes (brand_id, old_tier, new_tier, changed_by, note)
      VALUES (?, ?, ?, ?, ?)
    `).run(brandId, current, newTier, changedBy || 'system', note || null);
  });
  tierTx();

  console.log(`[db] tier change: brand=${brandId} ${current} → ${newTier} by=${changedBy}`);
}

/**
 * Return the full tier change history for a brand, newest first.
 */
const getTierHistory = (brandId) =>
  db.prepare(`
    SELECT * FROM tier_changes
    WHERE brand_id = ?
    ORDER BY changed_at DESC
  `).all(brandId);

/**
 * Write one internal analytics event.
 * payload can be any JSON-serialisable object — it is stored as a string.
 */
const insertEvent = (brandId, userId, eventName, payload = null) =>
  db.prepare(`
    INSERT INTO events (brand_id, user_id, event_name, payload)
    VALUES (?, ?, ?, ?)
  `).run(brandId, userId || null, eventName, payload ? JSON.stringify(payload) : null);

/**
 * Query events for the admin endpoint.
 * All params are optional; limit defaults to 100, max 1000.
 */
function queryEvents({ brand_id, event_name, since, limit = 100 } = {}) {
  let sql    = 'SELECT * FROM events WHERE 1=1';
  const args = [];
  if (brand_id)   { sql += ' AND brand_id = ?';   args.push(brand_id); }
  if (event_name) { sql += ' AND event_name = ?';  args.push(event_name); }
  if (since)      { sql += ' AND created_at >= ?'; args.push(since); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  args.push(Math.min(Math.max(1, limit), 1000));
  return db.prepare(sql).all(...args);
}

/**
 * Pause all paid-tier integrations for a brand (downgrade path).
 * Credentials are preserved — sync_paused=1 only stops the scheduler.
 * Platforms paused on downgrade: locally, shipblu, bosta, meta.
 * Shopify is NOT paused — it remains available on the free tier.
 */
const freezePaidIntegrations = (brandId) =>
  db.prepare(`
    UPDATE integrations
    SET sync_paused = 1
    WHERE brand_id = ?
      AND platform IN ('locally', 'shipblu', 'bosta', 'meta')
  `).run(brandId);

/**
 * Resume all previously-paused integrations for a brand (upgrade path).
 * Setting sync_paused=0 is sufficient — the scheduler picks them up on the next tick.
 */
const unfreezePaidIntegrations = (brandId) =>
  db.prepare(`
    UPDATE integrations
    SET sync_paused = 0
    WHERE brand_id = ?
  `).run(brandId);

/**
 * Update brands.last_seen_at to now. Called on every GET /api/me.
 * Used for re-engagement analytics (identify inactive free brands).
 */
const updateBrandLastSeen = (brandId) =>
  db.prepare("UPDATE brands SET last_seen_at = datetime('now') WHERE id = ?").run(brandId);

/**
 * SIGNUP_PROFILE — persist brand-level profile fields collected at signup.
 * Only updates columns that are provided (non-null).
 * Called immediately after brand creation in /api/auth/signup.
 *
 * @param {string} brandId
 * @param {{ ig_handle?: string, revenue_range?: string }} fields
 */
function updateBrandProfile(brandId, { ig_handle, revenue_range } = {}) {
  const sets  = [];
  const vals  = [];
  if (ig_handle     !== undefined && ig_handle     !== null) { sets.push('ig_handle = ?');     vals.push(ig_handle); }
  if (revenue_range !== undefined && revenue_range !== null) { sets.push('revenue_range = ?'); vals.push(revenue_range); }
  if (!sets.length) return;
  vals.push(brandId);
  db.prepare(`UPDATE brands SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

/**
 * SIGNUP_PROFILE — persist phone number on the user record.
 * Called immediately after user creation in /api/auth/signup.
 *
 * @param {number} userId
 * @param {string} phone  Already validated (Egyptian mobile format)
 */
const updateUserPhone = (userId, phone) =>
  db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, userId);

// ── Lead contact helpers (Admin Phase 2) ──────────────────────────────────────
//
// lead_contacts has event_id as PK so there is at most one contacted row per event.
// Helpers are used exclusively by /api/admin/leads/* routes.

const HIGH_PRIORITY_EVENTS = [
  'new_signup_high_revenue',
  'simulator_3x_with_shopify',
  'talk_to_us',
  'simulator_3x',
];

/**
 * Return all high-priority events from the last 14 days,
 * joined with brands/users (owner contact info) and lead_contacts status.
 * Unhandled (not contacted) rows sort first, then by recency desc.
 */
const getLeads = () =>
  db.prepare(`
    SELECT
      e.id,
      e.brand_id,
      e.event_name,
      e.payload,
      e.created_at,
      b.name         AS brand_name,
      b.revenue_range,
      b.ig_handle,
      u.phone        AS contact_phone,
      u.email        AS contact_email,
      u.name         AS contact_name,
      lc.event_id    AS contacted_event_id,
      lc.contacted_at,
      lc.contacted_by,
      lc.notes
    FROM events e
    JOIN    brands      b  ON b.id        = e.brand_id
    LEFT JOIN user_brands ub ON ub.brand_id = e.brand_id AND ub.role = 'owner'
    LEFT JOIN users     u  ON u.id        = ub.user_id
    LEFT JOIN lead_contacts lc ON lc.event_id = e.id
    WHERE e.event_name IN (${HIGH_PRIORITY_EVENTS.map(() => '?').join(',')})
      AND e.created_at >= datetime('now', '-14 days')
    GROUP BY e.id
    ORDER BY (lc.event_id IS NULL) DESC, e.created_at DESC
  `).all(...HIGH_PRIORITY_EVENTS);

/**
 * Count unhandled (not yet contacted) high-priority events in the last 14 days.
 * Used for the Leads badge in the top bar.
 */
const getUnhandledLeadCount = () =>
  (db.prepare(`
    SELECT COUNT(DISTINCT e.id) AS c
    FROM events e
    LEFT JOIN lead_contacts lc ON lc.event_id = e.id
    WHERE e.event_name IN (${HIGH_PRIORITY_EVENTS.map(() => '?').join(',')})
      AND e.created_at >= datetime('now', '-14 days')
      AND lc.event_id IS NULL
  `).get(...HIGH_PRIORITY_EVENTS) || { c: 0 }).c;

/**
 * Mark an event as contacted. Upserts so re-marking is safe.
 */
const markLeadContacted = (eventId, notes, contactedBy = 'admin') =>
  db.prepare(`
    INSERT INTO lead_contacts (event_id, contacted_by, notes)
    VALUES (?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      contacted_at = CURRENT_TIMESTAMP,
      contacted_by = excluded.contacted_by,
      notes        = COALESCE(excluded.notes, lead_contacts.notes)
  `).run(eventId, contactedBy || 'admin', notes || null);

/**
 * Unmark an event as contacted (mistake recovery).
 */
const unmarkLeadContacted = (eventId) =>
  db.prepare('DELETE FROM lead_contacts WHERE event_id = ?').run(eventId);

// ── Impersonation session helpers (Admin Phase 3) ─────────────────────────────

/**
 * Record a new impersonation session. Called when admin hits
 * POST /api/admin/brands/:id/impersonate.
 */
const createImpersonationSession = (sessionId, brandId, userId, reason) =>
  db.prepare(`
    INSERT INTO impersonation_sessions (session_id, brand_id, user_id, reason)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, brandId, userId || 0, reason);

/**
 * Fetch a session row (for revocation check in requireAuth).
 */
const getImpersonationSession = (sessionId) =>
  db.prepare('SELECT * FROM impersonation_sessions WHERE session_id = ?').get(sessionId);

/**
 * Revoke a session before its JWT expires (admin action).
 * JWT is still cryptographically valid but requireAuth will reject it.
 */
const revokeImpersonationSession = (sessionId) =>
  db.prepare(`
    UPDATE impersonation_sessions
    SET revoked = 1, ended_at = datetime('now')
    WHERE session_id = ?
  `).run(sessionId);

/**
 * Mark a session as ended (natural expiry / user-initiated exit).
 */
const endImpersonationSession = (sessionId) =>
  db.prepare(`
    UPDATE impersonation_sessions
    SET ended_at = datetime('now')
    WHERE session_id = ? AND ended_at IS NULL
  `).run(sessionId);

// ── System settings helpers (Admin Phase 3) ───────────────────────────────────

/**
 * Read one system setting by key. Returns value string or null.
 */
const getSystemSetting = (key) => {
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
  return row ? row.value : null;
};

/**
 * Write / upsert a system setting.
 */
const setSystemSetting = (key, value) =>
  db.prepare(`
    INSERT INTO system_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, String(value));

/**
 * Aggregate system health data for the admin System tab.
 * Returns a single object with 6 sections; never throws — each section
 * falls back to an error indicator on failure.
 */
function getSystemHealth() {
  const safe = (fn, fallback) => {
    try { return fn(); } catch (_) { return fallback; }
  };

  // 1. Brands overview
  const brands = safe(() => {
    const total     = db.prepare('SELECT COUNT(*) AS c FROM brands').get().c;
    const paid      = db.prepare("SELECT COUNT(*) AS c FROM brands WHERE tier='paid'").get().c;
    const onboarded = db.prepare('SELECT COUNT(*) AS c FROM brands WHERE onboarded=1').get().c;
    const last24h   = db.prepare("SELECT COUNT(*) AS c FROM brands WHERE created_at >= datetime('now','-1 day')").get().c;
    const last7d    = db.prepare("SELECT COUNT(*) AS c FROM brands WHERE created_at >= datetime('now','-7 days')").get().c;
    return { total, paid, free: total - paid, onboarded, last_24h: last24h, last_7d: last7d };
  }, { error: 'unavailable' });

  // 2. Integrations health
  const integrations = safe(() => {
    const rows = db.prepare(`
      SELECT platform,
        SUM(status='connected')    AS connected,
        SUM(status='warning')      AS warning,
        SUM(status='disconnected') AS disconnected,
        SUM(sync_paused=1)         AS paused
      FROM integrations
      GROUP BY platform
    `).all();
    const byPlatform = {};
    let totConn = 0, totWarn = 0, totDisc = 0;
    rows.forEach(r => {
      byPlatform[r.platform] = { connected: r.connected, warning: r.warning, disconnected: r.disconnected, paused: r.paused };
      totConn += r.connected; totWarn += r.warning; totDisc += r.disconnected;
    });
    return { total: totConn + totWarn + totDisc, connected: totConn, warning: totWarn, disconnected: totDisc, by_platform: byPlatform };
  }, { error: 'unavailable' });

  // 3. Sync queue (webhook retry queue)
  const syncQueue = safe(() => {
    const pending = db.prepare("SELECT COUNT(*) AS c FROM webhook_queue WHERE status='pending'").get().c;
    const dead    = db.prepare("SELECT COUNT(*) AS c FROM webhook_queue WHERE status='dead'").get().c;
    const done24h = db.prepare("SELECT COUNT(*) AS c FROM webhook_queue WHERE status='done' AND created_at >= datetime('now','-1 day')").get().c;
    return { pending, dead, processed_24h: done24h };
  }, { error: 'unavailable' });

  // 4. Events stream
  const events = safe(() => {
    const total24h = db.prepare("SELECT COUNT(*) AS c FROM events WHERE created_at >= datetime('now','-1 day')").get().c;
    const total7d  = db.prepare("SELECT COUNT(*) AS c FROM events WHERE created_at >= datetime('now','-7 days')").get().c;
    const topEvents = db.prepare(`
      SELECT event_name, COUNT(*) AS cnt
      FROM events
      WHERE created_at >= datetime('now','-7 days')
      GROUP BY event_name ORDER BY cnt DESC LIMIT 6
    `).all();
    return { total_24h: total24h, total_7d: total7d, top_events: topEvents };
  }, { error: 'unavailable' });

  // 5. Database stats
  const database = safe(() => {
    const orders = db.prepare('SELECT COUNT(*) AS c FROM orders_cache').get().c;
    const evts   = db.prepare('SELECT COUNT(*) AS c FROM events').get().c;
    const sessions= db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE expires_at > datetime(\'now\')').get().c;
    const dbPath = process.env.DATABASE_PATH || require('path').join(__dirname, 'optimize.db');
    let sizeBytes = 0;
    try { sizeBytes = require('fs').statSync(dbPath).size; } catch (_) {}
    return { size_bytes: sizeBytes, orders_count: orders, events_count: evts, active_sessions: sessions };
  }, { error: 'unavailable' });

  // 6. Webhook health + global settings
  const webhooks = safe(() => {
    const pending = db.prepare("SELECT COUNT(*) AS c FROM webhook_queue WHERE status='pending'").get().c;
    const dead    = db.prepare("SELECT COUNT(*) AS c FROM webhook_queue WHERE status='dead'").get().c;
    const syncsGlobalPaused = getSystemSetting('syncs_paused_globally') === '1';
    const impersonationsActive = db.prepare("SELECT COUNT(*) AS c FROM impersonation_sessions WHERE revoked=0 AND ended_at IS NULL AND started_at >= datetime('now','-30 minutes')").get().c;
    return { pending, dead, syncs_paused_globally: syncsGlobalPaused, active_impersonations: impersonationsActive };
  }, { error: 'unavailable' });

  return { brands, integrations, sync_queue: syncQueue, events, database, webhooks };
}

// ── CX: Customer Experience helpers (Phase 4) ─────────────────────────────────

/** Default templates seeded when a brand first upgrades to paid. */
const CX_FLOW_DEFAULTS = [
  {
    flow_type:     'order_confirmed',
    delay_minutes: 0,
    template_text: "Hi {customer_name}, your order from {brand_name} is confirmed! Total: {order_total} EGP. We'll keep you updated.",
  },
  {
    flow_type:     'shipped',
    delay_minutes: 0,
    template_text: "{customer_name}, your order from {brand_name} is on its way. Tracking: {tracking_number}",
  },
  {
    flow_type:     'out_for_delivery',
    delay_minutes: 0,
    template_text: "{customer_name}, your {brand_name} order is out for delivery today. Please be available.",
  },
  {
    flow_type:     'delivered',
    delay_minutes: 0,
    template_text: "Delivered! Your {brand_name} order arrived. We hope you love it!",
  },
  {
    flow_type:     'failed_delivery',
    delay_minutes: 0,
    template_text: "{customer_name}, we couldn't deliver your {brand_name} order. Reason: {failure_reason}. Please contact us to reschedule.",
  },
  {
    flow_type:     'feedback_request',
    delay_minutes: 1440,   // 24 hours
    template_text: "Hi {customer_name}, how was your {brand_name} order? We'd love your feedback. Reply here or rate us.",
  },
  {
    flow_type:     're_engagement',
    delay_minutes: 43200,  // 30 days
    template_text: "Hi {customer_name}, it's been a while. Check out what's new at {brand_name}.",
  },
];

/**
 * Return the cx_settings row for a brand, or a default object if none exists.
 */
function getCxSettings(brandId) {
  return db.prepare('SELECT * FROM cx_settings WHERE brand_id = ?').get(brandId) || {
    brand_id:                brandId,
    whatsapp_number:         null,
    whatsapp_number_verified: 0,
    enabled:                 0,
    setup_status:            'pending',
    n8n_workflow_url:        null,
    notify_ig_ready:         0,
    created_at:              null,
    updated_at:              null,
  };
}

/**
 * Upsert cx_settings fields for a brand.
 * Only updates columns explicitly passed in `fields`.
 */
function upsertCxSettings(brandId, fields = {}) {
  const allowed = [
    'whatsapp_number', 'whatsapp_number_verified', 'enabled',
    'setup_status', 'n8n_workflow_url', 'notify_ig_ready',
  ];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in fields) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  vals.push(brandId);
  // Upsert: insert first, then update if conflict
  db.prepare(`
    INSERT INTO cx_settings (brand_id) VALUES (?)
    ON CONFLICT(brand_id) DO NOTHING
  `).run(brandId);
  db.prepare(`UPDATE cx_settings SET ${sets.join(', ')} WHERE brand_id = ?`).run(...vals);
}

/**
 * Return all 7 cx_flows rows for a brand (or empty array if none seeded yet).
 */
const getCxFlows = (brandId) =>
  db.prepare('SELECT * FROM cx_flows WHERE brand_id = ? ORDER BY id').all(brandId);

/**
 * Return one cx_flows row for a brand + flow_type.
 */
const getCxFlow = (brandId, flowType) =>
  db.prepare('SELECT * FROM cx_flows WHERE brand_id = ? AND flow_type = ?').get(brandId, flowType);

/**
 * Update fields on a cx_flows row. Only the fields passed are changed.
 * Returns the updated row.
 */
function updateCxFlow(brandId, flowType, fields = {}) {
  const allowed = ['enabled', 'template_text', 'delay_minutes'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in fields) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  }
  if (!sets.length) return getCxFlow(brandId, flowType);
  sets.push("updated_at = datetime('now')");
  vals.push(brandId, flowType);
  db.prepare(`UPDATE cx_flows SET ${sets.join(', ')} WHERE brand_id = ? AND flow_type = ?`).run(...vals);
  return getCxFlow(brandId, flowType);
}

/**
 * Seed the 7 default cx_flows rows for a brand.
 * INSERT OR IGNORE — safe to call repeatedly (idempotent).
 * Called automatically when a brand upgrades to paid.
 */
function seedCxFlows(brandId) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO cx_flows (brand_id, flow_type, enabled, template_text, delay_minutes)
    VALUES (?, ?, 0, ?, ?)
  `);
  const seedTx = db.transaction(() => {
    for (const { flow_type, template_text, delay_minutes } of CX_FLOW_DEFAULTS) {
      stmt.run(brandId, flow_type, template_text, delay_minutes);
    }
  });
  seedTx();
  // Also ensure cx_settings row exists
  db.prepare(`
    INSERT OR IGNORE INTO cx_settings (brand_id) VALUES (?)
  `).run(brandId);
  console.log(`[db] cx flows seeded for brand=${brandId}`);
}

/**
 * Insert a new cx_messages row with status='queued'.
 * Returns the newly created row id.
 */
function insertCxMessage({ brandId, flowType, channel = 'whatsapp', recipientPhone, recipientName, orderId, messageBody }) {
  const result = db.prepare(`
    INSERT INTO cx_messages
      (brand_id, flow_type, channel, recipient_phone, recipient_name, order_id, message_body, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')
  `).run(brandId, flowType, channel, recipientPhone, recipientName || null, orderId || null, messageBody || null);
  return result.lastInsertRowid;
}

/**
 * Update the status of a cx_messages row (called by n8n webhook callbacks).
 * extra: { n8n_execution_id?, failed_reason? }
 */
function updateCxMessageStatus(messageId, status, extra = {}) {
  const sets = ['status = ?'];
  const vals = [status];
  if (status === 'sent') {
    sets.push("sent_at = datetime('now')");
    if (extra.n8n_execution_id) { sets.push('n8n_execution_id = ?'); vals.push(extra.n8n_execution_id); }
  }
  if (status === 'delivered') {
    sets.push("delivered_at = datetime('now')");
  }
  if (status === 'failed') {
    if (extra.failed_reason) { sets.push('failed_reason = ?'); vals.push(extra.failed_reason); }
  }
  vals.push(messageId);
  db.prepare(`UPDATE cx_messages SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

/**
 * Bump the triggered_count and last_triggered_at on a cx_flows row.
 * Called after successfully firing a trigger.
 */
const incrementCxFlowCount = (brandId, flowType) =>
  db.prepare(`
    UPDATE cx_flows
    SET triggered_count   = triggered_count + 1,
        last_triggered_at = datetime('now'),
        updated_at        = datetime('now')
    WHERE brand_id = ? AND flow_type = ?
  `).run(brandId, flowType);

/**
 * Query cx_messages for the activity feed.
 * Supports filtering by flow_type, status, and pagination.
 */
function listCxMessages(brandId, { flowType, status, limit = 50, offset = 0 } = {}) {
  let sql  = 'SELECT * FROM cx_messages WHERE brand_id = ?';
  const args = [brandId];
  if (flowType) { sql += ' AND flow_type = ?'; args.push(flowType); }
  if (status)   { sql += ' AND status = ?';    args.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  args.push(Math.min(limit, 200), Math.max(offset, 0));
  return db.prepare(sql).all(...args);
}

/**
 * Aggregate CX stats for the stats cards on the CS tab.
 * Returns sent count (30d), delivery rate, active flows count, failed count.
 */
function getCxStats(brandId) {
  const safe = (fn, fb) => { try { return fn(); } catch (_) { return fb; } };
  const sent30d      = safe(() => db.prepare("SELECT COUNT(*) AS c FROM cx_messages WHERE brand_id=? AND status IN ('sent','delivered') AND created_at>=datetime('now','-30 days')").get(brandId).c, 0);
  const delivered30d = safe(() => db.prepare("SELECT COUNT(*) AS c FROM cx_messages WHERE brand_id=? AND status='delivered' AND created_at>=datetime('now','-30 days')").get(brandId).c, 0);
  const failed30d    = safe(() => db.prepare("SELECT COUNT(*) AS c FROM cx_messages WHERE brand_id=? AND status='failed' AND created_at>=datetime('now','-30 days')").get(brandId).c, 0);
  const activeFlows  = safe(() => db.prepare("SELECT COUNT(*) AS c FROM cx_flows WHERE brand_id=? AND enabled=1").get(brandId).c, 0);
  const deliveryRate = (sent30d + delivered30d) > 0 ? Math.round((delivered30d / (sent30d + delivered30d)) * 100) : 0;
  const byFlow       = safe(() => db.prepare(`
    SELECT flow_type,
      SUM(CASE WHEN status IN ('sent','delivered') THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      MAX(created_at) AS last_at
    FROM cx_messages WHERE brand_id=? AND created_at>=datetime('now','-30 days')
    GROUP BY flow_type
  `).all(brandId), []);
  return { sent_30d: sent30d, delivered_30d: delivered30d, failed_30d: failed30d, active_flows: activeFlows, delivery_rate: deliveryRate, by_flow: byFlow };
}

// ── Webhook queue helpers ──────────────────────────────────────────────────────
//
// Failed webhook payloads are stored here so the scheduler can retry them
// with exponential back-off rather than silently losing real-time events.
//
// Status lifecycle:  pending → (processing attempt) → done | pending (retry) | dead

/**
 * Add a failed webhook to the retry queue.
 * Called by routes/webhooks.js when handleWebhook() throws.
 */
const enqueueWebhook = (brandId, topic, payload) =>
  db.prepare(`
    INSERT INTO webhook_queue (brand_id, topic, payload, status, next_retry_at)
    VALUES (?, ?, ?, 'pending', datetime('now'))
  `).run(brandId, topic, JSON.stringify(payload));

/**
 * Fetch up to `limit` pending webhooks that are ready to be retried.
 */
const getPendingWebhooks = (limit = 20) =>
  db.prepare(`
    SELECT *
    FROM   webhook_queue
    WHERE  status = 'pending'
      AND  next_retry_at <= datetime('now')
    ORDER  BY created_at ASC
    LIMIT  ?
  `).all(limit);

/**
 * Mark a webhook as successfully processed.
 */
const ackWebhook = (id) =>
  db.prepare("UPDATE webhook_queue SET status = 'done' WHERE id = ?").run(id);

/**
 * Record a failed attempt and schedule retry with exponential back-off.
 * Delays: 1 min → 2 min → 4 min → 8 min → 16 min → dead letter.
 */
function failWebhook(id, errorMsg) {
  const row = db.prepare('SELECT attempts, max_attempts FROM webhook_queue WHERE id = ?').get(id);
  if (!row) return;

  const attempts = (row.attempts || 0) + 1;
  const errStr   = String(errorMsg || '').slice(0, 500);

  if (attempts >= (row.max_attempts || 5)) {
    db.prepare(`
      UPDATE webhook_queue
      SET    status = 'dead', attempts = ?, error = ?, next_retry_at = NULL
      WHERE  id = ?
    `).run(attempts, errStr, id);
  } else {
    // Exponential back-off in minutes: 2^(attempt-1) → 1, 2, 4, 8, 16
    const delayMs      = Math.pow(2, attempts - 1) * 60 * 1000;
    const nextRetryIso = new Date(Date.now() + delayMs).toISOString();
    db.prepare(`
      UPDATE webhook_queue
      SET    attempts = ?, error = ?, next_retry_at = ?
      WHERE  id = ?
    `).run(attempts, errStr, nextRetryIso, id);
  }
}

// ── Brand branding helpers ────────────────────────────────────────────────────

/**
 * Return the branding fields (logo_url, brand_color, logo_uploaded_at) for a brand.
 * Returns null if the brand doesn't exist.
 */
const getBrandBranding = (brandId) => {
  const row = db.prepare(
    'SELECT logo_url, brand_color, logo_uploaded_at FROM brands WHERE id = ?'
  ).get(brandId);
  return row || null;
};

/**
 * Set a brand's accent color.
 * color must be one of the 16 whitelisted hex values — call-site enforces this.
 */
const setBrandColor = (brandId, color) =>
  db.prepare('UPDATE brands SET brand_color = ? WHERE id = ?').run(color, brandId);

/**
 * Clear a brand's accent color (revert to default).
 */
const clearBrandColor = (brandId) =>
  db.prepare('UPDATE brands SET brand_color = NULL WHERE id = ?').run(brandId);

/**
 * Set a brand's logo URL and update the logo_uploaded_at timestamp.
 * url is the public path served by express.static, e.g. '/uploads/logos/brand-id.png'.
 */
const setBrandLogo = (brandId, url) =>
  db.prepare(`
    UPDATE brands
    SET logo_url = ?, logo_uploaded_at = datetime('now')
    WHERE id = ?
  `).run(url, brandId);

/**
 * Clear a brand's logo (URL and timestamp).
 */
const clearBrandLogo = (brandId) =>
  db.prepare(
    "UPDATE brands SET logo_url = NULL, logo_uploaded_at = NULL WHERE id = ?"
  ).run(brandId);

// ── Form Leads (qualification funnel) ────────────────────────────────────────

/**
 * Insert a new form lead from /book page submission.
 * Returns the row id of the inserted lead.
 */
function insertFormLead({ brand_name, contact_name, email, phone, ig_handle,
  website, revenue_range, has_showroom, showroom_platform, cs_handled_by,
  ip_address, user_agent, source }) {
  const result = db.prepare(`
    INSERT INTO leads
      (brand_name, contact_name, email, phone, ig_handle, website,
       revenue_range, has_showroom, showroom_platform, cs_handled_by,
       ip_address, user_agent, source)
    VALUES
      (@brand_name, @contact_name, @email, @phone, @ig_handle, @website,
       @revenue_range, @has_showroom, @showroom_platform, @cs_handled_by,
       @ip_address, @user_agent, @source)
  `).run({ brand_name, contact_name, email, phone, ig_handle, website,
    revenue_range, has_showroom: has_showroom ? 1 : 0,
    showroom_platform: showroom_platform || null,
    cs_handled_by, ip_address: ip_address || null, user_agent: user_agent || null,
    source: source || 'direct' });
  return result.lastInsertRowid;
}

/**
 * Mark a lead as having booked a Calendly slot.
 */
const markLeadCalendlyBooked = (leadId, eventUrl = null) =>
  db.prepare(`
    UPDATE leads SET booked_calendly = 1, calendly_event_url = ?
    WHERE id = ?
  `).run(eventUrl, leadId);

/**
 * List form leads with optional filters. Returns paginated results.
 */
function getFormLeads({ page = 1, limit = 50, search = '', revenue = '', booked = '', contacted = '' } = {}) {
  const offset = (page - 1) * limit;
  const where = [];
  const args  = [];

  if (search) {
    where.push(`(brand_name LIKE ? OR ig_handle LIKE ? OR phone LIKE ? OR email LIKE ? OR contact_name LIKE ?)`);
    const t = `%${search}%`;
    args.push(t, t, t, t, t);
  }
  if (revenue) { where.push('revenue_range = ?'); args.push(revenue); }
  if (booked  === '1') { where.push('booked_calendly = 1'); }
  if (booked  === '0') { where.push('booked_calendly = 0'); }
  if (contacted === '1') { where.push('contacted = 1'); }
  if (contacted === '0') { where.push('contacted = 0'); }

  const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`SELECT * FROM leads ${wc} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset);
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM leads ${wc}`).get(...args) || { c: 0 }).c;
  return { rows, total, page, limit };
}

/** Get a single form lead by id. */
const getFormLead = (id) =>
  db.prepare('SELECT * FROM leads WHERE id = ?').get(id);

/** Update contacted status and/or notes on a form lead. */
function updateFormLead(id, { contacted, notes }) {
  const sets = [];
  const vals = [];
  if (contacted !== undefined) {
    sets.push('contacted = ?');
    vals.push(contacted ? 1 : 0);
    sets.push('contacted_at = ?');
    vals.push(contacted ? new Date().toISOString() : null);
  }
  if (notes !== undefined) { sets.push('notes = ?'); vals.push(notes || null); }
  if (!sets.length) return;
  vals.push(id);
  db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

// ─── Food-Brand helpers (fb_* tables) ────────────────────────────────────────

function getFbSetting(brandId, key) {
  return db.prepare('SELECT value FROM fb_settings WHERE brand_id = ? AND key = ?').get(brandId, key);
}

function setFbSetting(brandId, key, value) {
  db.prepare(`INSERT INTO fb_settings (brand_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(brand_id, key) DO UPDATE SET value = excluded.value`).run(brandId, key, String(value));
}

function getFbSetupExpenses(brandId) {
  return db.prepare('SELECT * FROM fb_setup_expenses WHERE brand_id = ? ORDER BY created_at DESC').all(brandId);
}

function insertFbSetupExpense(brandId, { item, category, amount, date_paid, payment_method, paid_by, notes }) {
  const r = db.prepare(`INSERT INTO fb_setup_expenses (brand_id, item, category, amount, date_paid, payment_method, paid_by, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(brandId, item, category, amount ?? 0, date_paid || null, payment_method || null, paid_by || null, notes || null);
  return db.prepare('SELECT * FROM fb_setup_expenses WHERE id = ?').get(r.lastInsertRowid);
}

function updateFbSetupExpense(brandId, id, fields) {
  const allowed = ['item', 'category', 'amount', 'date_paid', 'payment_method', 'paid_by', 'notes'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in fields) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  vals.push(id, brandId);
  db.prepare(`UPDATE fb_setup_expenses SET ${sets.join(', ')} WHERE id = ? AND brand_id = ?`).run(...vals);
}

function deleteFbSetupExpense(brandId, id) {
  db.prepare('DELETE FROM fb_setup_expenses WHERE id = ? AND brand_id = ?').run(id, brandId);
}

function getFbRecurringExpenses(brandId) {
  return db.prepare('SELECT * FROM fb_recurring_expenses WHERE brand_id = ? ORDER BY id ASC').all(brandId);
}

function insertFbRecurringExpense(brandId, { item, frequency, amount, percent_rate, weekly_due_day, monthly_due_date, payment_method, active, notes }) {
  const r = db.prepare(`INSERT INTO fb_recurring_expenses (brand_id, item, frequency, amount, percent_rate, weekly_due_day, monthly_due_date, payment_method, active, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    brandId, item, frequency,
    amount ?? null, percent_rate ?? null,
    weekly_due_day ?? null, monthly_due_date ?? null,
    payment_method || null,
    active === undefined ? 1 : (active ? 1 : 0),
    notes || null
  );
  return db.prepare('SELECT * FROM fb_recurring_expenses WHERE id = ?').get(r.lastInsertRowid);
}

function updateFbRecurringExpense(brandId, id, fields) {
  const allowed = ['item', 'frequency', 'amount', 'percent_rate', 'weekly_due_day', 'monthly_due_date', 'payment_method', 'active', 'notes'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in fields) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  vals.push(id, brandId);
  db.prepare(`UPDATE fb_recurring_expenses SET ${sets.join(', ')} WHERE id = ? AND brand_id = ?`).run(...vals);
}

function deleteFbRecurringExpense(brandId, id) {
  db.prepare('DELETE FROM fb_recurring_expenses WHERE id = ? AND brand_id = ?').run(id, brandId);
}

function getFbDailyRevenue(brandId, date) {
  return db.prepare('SELECT * FROM fb_daily_revenue WHERE brand_id = ? AND date = ?').get(brandId, date);
}

function upsertFbDailyRevenue(brandId, date, { revenue_cash, revenue_visa, revenue_talabat_gross }) {
  db.prepare(`INSERT INTO fb_daily_revenue (brand_id, date, revenue_cash, revenue_visa, revenue_talabat_gross)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(brand_id, date) DO UPDATE SET
      revenue_cash = excluded.revenue_cash,
      revenue_visa = excluded.revenue_visa,
      revenue_talabat_gross = excluded.revenue_talabat_gross,
      updated_at = datetime('now')`).run(brandId, date, revenue_cash ?? 0, revenue_visa ?? 0, revenue_talabat_gross ?? 0);
  return getFbDailyRevenue(brandId, date);
}

function getFbDailyExpenses(brandId, date) {
  return db.prepare('SELECT * FROM fb_daily_expenses WHERE brand_id = ? AND date = ? ORDER BY id ASC').all(brandId, date);
}

function insertFbDailyExpense(brandId, { date, category, item, amount, payment_method, paid_by, notes, recurring_expense_id }) {
  const r = db.prepare(`INSERT INTO fb_daily_expenses (brand_id, date, category, item, amount, payment_method, paid_by, notes, recurring_expense_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    brandId, date, category, item, amount ?? 0,
    payment_method || null, paid_by || null, notes || null,
    recurring_expense_id || null
  );
  return db.prepare('SELECT * FROM fb_daily_expenses WHERE id = ?').get(r.lastInsertRowid);
}

function deleteFbDailyExpense(brandId, id) {
  db.prepare('DELETE FROM fb_daily_expenses WHERE id = ? AND brand_id = ?').run(id, brandId);
}

function getFbBankTransfers(brandId, { limit = 100 } = {}) {
  return db.prepare('SELECT * FROM fb_bank_transfers WHERE brand_id = ? ORDER BY date_received DESC LIMIT ?').all(brandId, limit);
}

function insertFbBankTransfer(brandId, { date_received, source, period_from, period_to, amount_received, confirmed, notes }) {
  const r = db.prepare(`INSERT INTO fb_bank_transfers (brand_id, date_received, source, period_from, period_to, amount_received, confirmed, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    brandId, date_received, source, period_from, period_to,
    amount_received ?? 0, confirmed || 'Pending', notes || null
  );
  return db.prepare('SELECT * FROM fb_bank_transfers WHERE id = ?').get(r.lastInsertRowid);
}

function updateFbBankTransfer(brandId, id, fields) {
  const allowed = ['date_received', 'source', 'period_from', 'period_to', 'amount_received', 'confirmed', 'notes'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in fields) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  }
  if (!sets.length) return;
  vals.push(id, brandId);
  db.prepare(`UPDATE fb_bank_transfers SET ${sets.join(', ')} WHERE id = ? AND brand_id = ?`).run(...vals);
}

function deleteFbBankTransfer(brandId, id) {
  db.prepare('DELETE FROM fb_bank_transfers WHERE id = ? AND brand_id = ?').run(id, brandId);
}

function getFbCashDrawer(brandId, date) {
  return db.prepare('SELECT * FROM fb_cash_drawer_check WHERE brand_id = ? AND date = ?').get(brandId, date);
}

function upsertFbCashDrawer(brandId, date, { opening_cash, actual_counted_cash }) {
  db.prepare(`INSERT INTO fb_cash_drawer_check (brand_id, date, opening_cash, actual_counted_cash)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(brand_id, date) DO UPDATE SET
      opening_cash = COALESCE(excluded.opening_cash, fb_cash_drawer_check.opening_cash),
      actual_counted_cash = COALESCE(excluded.actual_counted_cash, fb_cash_drawer_check.actual_counted_cash),
      updated_at = datetime('now')`).run(brandId, date, opening_cash ?? null, actual_counted_cash ?? null);
  return getFbCashDrawer(brandId, date);
}

function getFbInventoryChecks(brandId, date) {
  return db.prepare('SELECT * FROM fb_inventory_check WHERE brand_id = ? AND date = ? ORDER BY id ASC').all(brandId, date);
}

function insertFbInventoryCheck(brandId, { date, item, unit, system_count, physical_count, notes }) {
  const r = db.prepare(`INSERT INTO fb_inventory_check (brand_id, date, item, unit, system_count, physical_count, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    brandId, date, item, unit || null,
    system_count ?? null, physical_count ?? null, notes || null
  );
  return db.prepare('SELECT * FROM fb_inventory_check WHERE id = ?').get(r.lastInsertRowid);
}

function deleteFbInventoryCheck(brandId, id) {
  db.prepare('DELETE FROM fb_inventory_check WHERE id = ? AND brand_id = ?').run(id, brandId);
}

function getFbCalendarNote(brandId, date) {
  return db.prepare('SELECT * FROM fb_calendar_notes WHERE brand_id = ? AND date = ?').get(brandId, date);
}

function upsertFbCalendarNote(brandId, date, note) {
  if (!note) {
    db.prepare('DELETE FROM fb_calendar_notes WHERE brand_id = ? AND date = ?').run(brandId, date);
    return null;
  }
  db.prepare(`INSERT INTO fb_calendar_notes (brand_id, date, note)
    VALUES (?, ?, ?)
    ON CONFLICT(brand_id, date) DO UPDATE SET note = excluded.note`).run(brandId, date, note);
  return getFbCalendarNote(brandId, date);
}

function setBrandBusinessType(brandId, businessType) {
  db.prepare("UPDATE brands SET business_type = ? WHERE id = ?").run(businessType, brandId);
}

function seedFbRecurringExpenses(brandId) {
  const presets = [
    { item: 'Landlord Revenue Share', frequency: 'Percent of Sales', percent_rate: 0.15, active: 1 },
    { item: 'Staff Wages',             frequency: 'Monthly', amount: 0, monthly_due_date: 1, active: 1 },
    { item: 'Staff Meals',             frequency: 'Daily',   amount: 0,                      active: 1 },
    { item: 'Electricity',             frequency: 'Monthly', amount: 0, monthly_due_date: 1, active: 1 },
    { item: 'Water',                   frequency: 'Monthly', amount: 0, monthly_due_date: 1, active: 1 },
    { item: 'Gas',                     frequency: 'Monthly', amount: 0, monthly_due_date: 1, active: 1 },
    { item: 'Waste / Cleaning',        frequency: 'Monthly', amount: 0, monthly_due_date: 1, active: 1 },
    { item: 'Internet',                frequency: 'Monthly', amount: 0, monthly_due_date: 1, active: 1 },
    { item: 'POS / Software',          frequency: 'Monthly', amount: 0, monthly_due_date: 1, active: 1 },
    { item: 'Delivery App Commission', frequency: 'Daily',   amount: 0,                      active: 0 },
    { item: 'Music / DJ Fee',          frequency: 'Weekly',  amount: 0, weekly_due_day: 4,   active: 1 },
    { item: 'Insurance',               frequency: 'Monthly', amount: 0, monthly_due_date: 1, active: 1 },
  ];
  const stmt = db.prepare(`INSERT INTO fb_recurring_expenses
    (brand_id, item, frequency, amount, percent_rate, weekly_due_day, monthly_due_date, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const p of presets) {
    stmt.run(
      brandId, p.item, p.frequency,
      p.amount ?? null, p.percent_rate ?? null,
      p.weekly_due_day ?? null, p.monthly_due_date ?? null,
      p.active
    );
  }
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
  disconnectIntegration,
  logSync,
  getLastSyncLog,
  getIntegrationHealth,
  setIntegrationHealth,
  markBrandOnboarded,
  updateOnboardingStep,
  setChecklistDismissed,
  upsertOrder,
  upsertOrderItems,
  getOrders,
  countOrders,
  getOrder,
  canonicalSku,
  upsertInventory,
  getInventory,
  // tier
  getBrandTier,
  setBrandTier,
  getTierHistory,
  insertEvent,
  queryEvents,
  freezePaidIntegrations,
  unfreezePaidIntegrations,
  updateBrandLastSeen,
  updateBrandProfile,
  updateUserPhone,
  // webhook queue
  enqueueWebhook,
  getPendingWebhooks,
  ackWebhook,
  failWebhook,
  // auth
  findUserByEmail,
  getUserById,
  createUser,
  updateUserLastLogin,
  grantUserBrand,
  getUserBrands,
  userHasBrandAccess,
  createSession,
  getSessionById,
  deleteSession,
  deleteExpiredSessions,
  // password reset
  createPasswordResetToken,
  getPasswordResetToken,
  markResetTokenUsed,
  deleteExpiredResetTokens,
  // team
  createTeamInvite,
  getTeamInvite,
  markInviteAccepted,
  getTeamMembers,
  getPendingInvites,
  // leads (admin phase 2)
  HIGH_PRIORITY_EVENTS,
  getLeads,
  getUnhandledLeadCount,
  markLeadContacted,
  unmarkLeadContacted,
  // impersonation (admin phase 3)
  createImpersonationSession,
  getImpersonationSession,
  revokeImpersonationSession,
  endImpersonationSession,
  // system settings (admin phase 3)
  getSystemSetting,
  setSystemSetting,
  getSystemHealth,
  // CX: Customer Experience (phase 4)
  CX_FLOW_DEFAULTS,
  getCxSettings,
  upsertCxSettings,
  getCxFlows,
  getCxFlow,
  updateCxFlow,
  seedCxFlows,
  insertCxMessage,
  updateCxMessageStatus,
  incrementCxFlowCount,
  listCxMessages,
  getCxStats,
  // form leads (qualification funnel)
  insertFormLead,
  markLeadCalendlyBooked,
  getFormLeads,
  getFormLead,
  updateFormLead,
  // branding
  getBrandBranding,
  setBrandColor,
  clearBrandColor,
  setBrandLogo,
  clearBrandLogo,
  // food brand
  getFbSetting,
  setFbSetting,
  getFbSetupExpenses,
  insertFbSetupExpense,
  updateFbSetupExpense,
  deleteFbSetupExpense,
  getFbRecurringExpenses,
  insertFbRecurringExpense,
  updateFbRecurringExpense,
  deleteFbRecurringExpense,
  getFbDailyRevenue,
  upsertFbDailyRevenue,
  getFbDailyExpenses,
  insertFbDailyExpense,
  deleteFbDailyExpense,
  getFbBankTransfers,
  insertFbBankTransfer,
  updateFbBankTransfer,
  deleteFbBankTransfer,
  getFbCashDrawer,
  upsertFbCashDrawer,
  getFbInventoryChecks,
  insertFbInventoryCheck,
  deleteFbInventoryCheck,
  getFbCalendarNote,
  upsertFbCalendarNote,
  seedFbRecurringExpenses,
  setBrandBusinessType,
};
