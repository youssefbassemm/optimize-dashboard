'use strict';

/**
 * Database migrations — Part B additions.
 *
 * Run once on server startup (after initSchema).
 * All statements use IF NOT EXISTS guards so they are safe to run repeatedly.
 */

const { db } = require('./db');

function runMigrations() {

  // ── webhook_queue — retry table for failed webhook handlers ──────────────────
  //
  // When a Shopify (or other) webhook handler throws, the payload is stored here
  // instead of being dropped. The scheduler processes pending rows every minute
  // with exponential back-off (1→2→4→8→16 min). After max_attempts the row
  // moves to 'dead' status and is preserved for manual inspection.
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_queue (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id      TEXT    NOT NULL,
      topic         TEXT    NOT NULL,
      payload       TEXT    NOT NULL,          -- original JSON body
      attempts      INTEGER NOT NULL DEFAULT 0,
      max_attempts  INTEGER NOT NULL DEFAULT 5,
      status        TEXT    NOT NULL DEFAULT 'pending',  -- pending | done | dead
      error         TEXT    DEFAULT NULL,                -- last error message
      created_at    TEXT    DEFAULT (datetime('now')),
      next_retry_at TEXT    DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_wq_status_retry
      ON webhook_queue(status, next_retry_at);
  `);

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

  // ── auth tables (Part C — users / user_brands / sessions) ─────────────────
  // Defined in schema.sql with IF NOT EXISTS guards, so initSchema() creates
  // them on first run.  This migration only adds any future ALTER TABLE changes.
  addColumn('users', 'last_login_at', 'TEXT DEFAULT NULL');

  // BRAND_WORKSPACE_CREATION — onboarded flag on brands table.
  // 0 = brand is new, redirect to /onboarding on first login.
  // 1 = onboarding complete, load dashboard normally.
  // Set via POST /api/auth/complete-onboarding at the end of the onboarding flow.
  addColumn('brands', 'onboarded', 'INTEGER DEFAULT 0');

  // ── Onboarding flow state ─────────────────────────────────────────────────
  //
  // onboarding_step: tracks which step the user last reached in the 6-step flow.
  //   Values: 'welcome' | 'shopify' | 'locally' | 'shipping' | 'meta' | 'done'
  //   Defaults to 'welcome' so a brand with no explicit step starts at the beginning.
  //
  // onboarded_at: ISO timestamp set when the user completes or skips the flow
  //   (reaches the 'done' step). NULL = onboarding not yet completed.
  //   The auth route checks this: if NULL → return needs_onboarding: true in response.
  //
  // checklist_dismissed: set to 1 when the user clicks "Dismiss" on the
  //   persistent setup checklist card on the home tab. Once dismissed it never
  //   reappears, even if not all integrations are connected.
  addColumn('brands', 'onboarding_step',      "TEXT    DEFAULT 'welcome'");
  addColumn('brands', 'onboarded_at',         'TEXT    DEFAULT NULL');
  addColumn('brands', 'checklist_dismissed',  'INTEGER DEFAULT 0');

  // ── password_reset_tokens ─────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      token_hash TEXT    NOT NULL UNIQUE,
      expires_at TEXT    NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_prt_hash ON password_reset_tokens(token_hash);
  `);

  // ── team_invites ──────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_invites (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id   TEXT    NOT NULL,
      email      TEXT    NOT NULL,
      role       TEXT    NOT NULL DEFAULT 'member',
      token_hash TEXT    NOT NULL UNIQUE,
      expires_at TEXT    NOT NULL,
      accepted   INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER,
      created_at TEXT    DEFAULT (datetime('now')),
      FOREIGN KEY (brand_id)   REFERENCES brands(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );
  `);

  // ── orders_cache — total_items column ────────────────────────────────────────
  // Stores the sum of all line-item quantities for an order so the dashboard
  // can compute "units sold" = SUM(total_items) without parsing JSON.
  addColumn('orders_cache', 'total_items', 'INTEGER DEFAULT 0');

  // ── order_items table ─────────────────────────────────────────────────────────
  // One row per line item per order. Populated by upsertOrderItems().
  // Enables per-product analytics and correct units-sold aggregation.
  db.exec(`
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
      created_at   TEXT    DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_order_items_ref
      ON order_items(brand_id, source, order_ref);
  `);

  // ── Clean up ALL Locally timestamp-based source_order_id rows ────────────────
  //
  // ROOT CAUSE (now fixed): normalizeOrder() used `locally-${Date.now()}-${index}`
  // as the fallback source_order_id when the Locally API returned no stable ID.
  // Date.now() returns a different value on EVERY sync run, so every sync
  // INSERTed fresh rows instead of hitting the ON CONFLICT UPDATE clause.
  // After N syncs: N × real_order_count rows → inflated units and revenue.
  //
  // The previous cleanup only removed rows with index >= 9000 (overview path).
  // This cleanup removes ALL rows matching the "locally-{timestamp}-{N}" pattern
  // regardless of index — covering both the main fetchOrders path (0..N)
  // and the old overview path (9000..N).
  //
  // Rows with real API IDs (numeric strings like "12345") are NOT affected
  // because they don't start with "locally-".
  // CSV-imported rows ("csv-...") are also not affected.
  // The new content-hash IDs ("loc-{hex}") are also not affected.
  //
  // The next sync will repopulate using stable content-hash IDs.
  try {
    const r1 = db.prepare(
      "DELETE FROM orders_cache WHERE source = 'locally' AND source_order_id LIKE 'locally-%'"
    ).run();
    if (r1.changes > 0) {
      console.log(`[migrations] purged ${r1.changes} Locally rows with unstable timestamp-based IDs (will repopulate on next sync)`);
    }
  } catch (err) {
    console.warn('[migrations] Locally timestamp-ID cleanup failed (non-fatal):', err.message);
  }

  // Also clean up any orphaned order_items rows whose parent order was just deleted.
  try {
    db.prepare(`
      DELETE FROM order_items
      WHERE source = 'locally'
        AND order_ref LIKE 'locally-%'
    `).run();
  } catch (_) {}

  // ── Clean up Locally duplicate orders (overview-path insertion bug) ──────────
  //
  // A prior version of integrations/locally.js unconditionally wrote
  // overview.latest_orders[] to orders_cache alongside the normal fetchOrders()
  // results. The overview objects lacked the ID fields present in the main
  // orders response, so normalizeOrder() fell back to generating
  // "locally-{Date.now()}-{9000+i}" as source_order_id — always a fresh INSERT,
  // never hitting the ON CONFLICT clause, creating duplicate rows for every
  // real order on every sync run.
  //
  // These rows are identifiable by their source_order_id matching the pattern
  // "locally-{13-digit-ms-timestamp}-{4-or-5-digit-index-starting-with-9}".
  // The 9000+ offset was hard-coded in the old code; real fetchOrders() rows
  // use 0-based sequential indices so they will never reach 9000 for any
  // reasonably sized brand.
  //
  // This migration runs once (changes = 0 on subsequent startups since the
  // matching rows will already be gone).
  try {
    const result = db.prepare(`
      DELETE FROM orders_cache
      WHERE source = 'locally'
        AND (
          source_order_id GLOB 'locally-*-9???'
          OR source_order_id GLOB 'locally-*-9????'
        )
    `).run();
    if (result.changes > 0) {
      console.log(`[migrations] removed ${result.changes} duplicate Locally orders (overview-path insertion bug)`);
    }
  } catch (err) {
    console.warn('[migrations] Locally dedup cleanup failed (non-fatal):', err.message);
  }

  // ── Normalise Locally created_at dates to ISO 8601 ───────────────────────────
  //
  // ROOT CAUSE: Some Locally API responses use "YYYY-MM-DD HH:MM:SS" (space
  // separator). SQLite stores created_at as TEXT and compares lexicographically.
  //
  // When the period filter is  `created_at >= "2026-04-04T00:00:00.000Z"`,
  // an order with created_at = "2026-04-04 09:00:00" evaluates to FALSE because
  // ' ' (0x20) < 'T' (0x54) — the order appears before the period start and is
  // silently excluded, even though it belongs to the correct calendar day.
  //
  // Fix: replace the first space with 'T' in all affected rows so comparisons
  // work correctly. Safe to run repeatedly (LIKE guard makes it a no-op once done).
  // The upsertOrder ON CONFLICT clause also now updates created_at, so every
  // re-sync going forward will correct any remaining mismatches automatically.
  try {
    const r = db.prepare(`
      UPDATE orders_cache
      SET    created_at = REPLACE(created_at, ' ', 'T')
      WHERE  source = 'locally'
        AND  created_at LIKE '____-__-__ %'
    `).run();
    if (r.changes > 0) {
      console.log(`[migrations] normalised ${r.changes} Locally created_at dates to ISO 8601 (space → T)`);
    }
  } catch (err) {
    console.warn('[migrations] created_at normalisation failed (non-fatal):', err.message);
  }

  // ── Fix Locally orders with financial_status='pending' that should be 'paid' ──
  //
  // ROOT CAUSE: normalizeOrder() and importLocallyExport() both mapped the Odoo
  // 'sale' state (confirmed active order) to financial_status='pending'.
  // In Odoo/Locally: 'sale' = confirmed sale order = should count as revenue.
  // The dashboard queries use `WHERE financial_status='paid'`, so any row with
  // 'pending' was silently excluded → dashboard showed zeros after import or sync.
  //
  // This migration corrects all existing affected rows in one pass.
  // Rows with 'cancelled' or explicitly 'pending' (draft quotations) are NOT touched.
  // Safe to re-run (WHERE clause makes it a no-op once all rows are corrected).
  try {
    const r = db.prepare(`
      UPDATE orders_cache
      SET    financial_status = 'paid'
      WHERE  source = 'locally'
        AND  financial_status = 'pending'
    `).run();
    if (r.changes > 0) {
      console.log(`[migrations] corrected financial_status for ${r.changes} Locally orders ('pending' → 'paid')`);
    }
  } catch (err) {
    console.warn('[migrations] Locally financial_status fix failed (non-fatal):', err.message);
  }

  // ── locally_imported_at on integrations ──────────────────────────────────
  // Tracks when the brand last performed a successful manual CSV import.
  // Read by the sales route to populate channel_split.locally.imported_at
  // so the dashboard can surface data-provenance ("last verified import: X").
  addColumn('integrations', 'locally_imported_at', 'TEXT DEFAULT NULL');

  // ── One-time purge of legacy loc-* hash rows ──────────────────────────────
  //
  // ROOT CAUSE: Before fetchOrderHistory() was introduced, fullSync() called
  // fetchOrders() (/partner/orders line-item endpoint). That endpoint returns
  // NO stable order identifier, so stableLocallyId() fell back to a SHA-256
  // content hash → "loc-{hex}" source_order_id.
  //
  // fetchOrderHistory() now uses /partner/overview latest_orders[], which
  // provides order_name ("S00042") as a stable server-assigned key. This
  // means new API syncs produce stable rows, but old loc-* hash rows remain
  // alongside them as stale shadows of the same real orders → double-count.
  //
  // This migration deletes ALL loc-* rows once (safe to re-run — they'll
  // already be gone). The next fetchOrderHistory() / import will repopulate
  // with stable IDs. csv-* and imp-* rows are NOT affected.
  try {
    const locPurge = db.prepare(
      "DELETE FROM orders_cache WHERE source = 'locally' AND source_order_id LIKE 'loc-%'"
    ).run();
    if (locPurge.changes > 0) {
      console.log(`[migrations] purged ${locPurge.changes} obsolete loc-* hash rows (will repopulate with stable IDs on next sync)`);
    }
  } catch (err) {
    console.warn('[migrations] loc-* purge failed (non-fatal):', err.message);
  }

  // ── Fix Locally date-only created_at values (missing time component) ─────────
  //
  // ROOT CAUSE: importLocallyExport() stored dates as "YYYY-MM-DD" (no time) when
  // the CSV contained date-only values. SQLite string comparison then caused a
  // subtle edge case: "2026-04-12" < "2026-04-12T00:00:00.000Z" is TRUE, so
  // orders from the current day were excluded by the period filter boundary.
  //
  // More critically, "2025-10-15" (no 'T') correctly precedes timestamps like
  // "2025-10-15T09:00:00" — but the period start is always an ISO timestamp, so
  // orders from within the period could be correctly included OR excluded depending
  // on whether their day-string precedes or follows the period-start timestamp.
  //
  // Fix: append T00:00:00 to all date-only Locally rows.
  // Safe to re-run: the WHERE LIKE guard only touches "YYYY-MM-DD" strings.
  try {
    const r = db.prepare(`
      UPDATE orders_cache
      SET    created_at = created_at || 'T00:00:00'
      WHERE  source = 'locally'
        AND  created_at LIKE '____-__-__'
        AND  length(created_at) = 10
    `).run();
    if (r.changes > 0) {
      console.log(`[migrations] appended T00:00:00 to ${r.changes} Locally orders with date-only created_at`);
    }
  } catch (err) {
    console.warn('[migrations] date-only created_at fix failed (non-fatal):', err.message);
  }

  // ── Inventory: fix unstable index-based SKUs + deduplicate rows ──────────────
  //
  // ROOT CAUSE (fixed in normalizeProduct):
  //   normalizeProduct() used `locally-${p.id || index}-${v.id || vi}` as the
  //   fallback SKU when a Locally product had no real SKU.  `index` is the array
  //   position in the API response, which changes between syncs (different order
  //   → different SKU → new row instead of update → accumulating duplicates).
  //
  // ADDITIONAL CAUSE:
  //   SQLite UNIQUE(brand_id, source, sku) treats NULL as distinct, so rows with
  //   sku=NULL are never merged by the conflict clause.
  //
  // FIX:
  //   1. Compute the canonical stable hash SKU for every Locally row using the
  //      same algorithm as the updated normalizeProduct() / canonicalSku():
  //        "loc-" + sha256("locally|norm(product_name)|norm(variant_name)").slice(0,16)
  //   2. Group rows by (brand_id, stable_sku): pick the survivor with the best
  //      data (prefer real SKU, then highest quantity, then latest id).
  //   3. Update the survivor's sku to the stable hash.
  //   4. Delete all other rows in the group.
  //
  // IDEMPOTENT: rows already carrying a stable "loc-" hash are treated as "real"
  // SKUs and won't be re-hashed.  Subsequent runs are no-ops.
  try {
    const crypto = require('crypto');

    function normStr(s) {
      return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
    }

    function stableLocallySku(productName, variantName) {
      const key = `locally|${normStr(productName)}|${normStr(variantName)}`;
      return `loc-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
    }

    // Fetch all Locally inventory rows
    const locallyRows = db.prepare(
      "SELECT id, brand_id, sku, product_name, variant_name, quantity FROM inventory_cache WHERE source = 'locally'"
    ).all();

    if (locallyRows.length > 0) {
      // Group by (brand_id, canonical_sku)
      const groups = new Map(); // `${brand_id}|${canonicalSku}` → { canonicalSku, rows[] }
      for (const row of locallyRows) {
        // If the row already has a real (non-index-based) SKU, use it as-is.
        // Index-based SKUs match the pattern "locally-<digits>-<digits>".
        const hasIndexSku = !row.sku || /^locally-\d/.test(row.sku);
        const canonical   = hasIndexSku
          ? stableLocallySku(row.product_name, row.variant_name)
          : row.sku.trim();
        const gKey = `${row.brand_id}|${canonical}`;
        if (!groups.has(gKey)) groups.set(gKey, { canonical, rows: [] });
        groups.get(gKey).rows.push(row);
      }

      const updateSku = db.prepare('UPDATE inventory_cache SET sku = ? WHERE id = ?');
      const deleteRow = db.prepare('DELETE FROM inventory_cache WHERE id = ?');

      const dedupTx = db.transaction(() => {
        let updatedSku = 0, deletedDup = 0;
        for (const { canonical, rows } of groups.values()) {
          // Sort: prefer rows with real non-index SKUs, then highest qty, then latest id
          rows.sort((a, b) => {
            const aIndex = /^locally-\d/.test(a.sku || '') || !a.sku ? 0 : 1;
            const bIndex = /^locally-\d/.test(b.sku || '') || !b.sku ? 0 : 1;
            if (aIndex !== bIndex) return bIndex - aIndex; // higher = real SKU = preferred
            if ((b.quantity || 0) !== (a.quantity || 0)) return (b.quantity || 0) - (a.quantity || 0);
            return b.id - a.id;
          });

          const winner = rows[0];

          // Update winner's SKU to the stable canonical value (no-op if already correct)
          if (winner.sku !== canonical) {
            updateSku.run(canonical, winner.id);
            updatedSku++;
          }

          // Delete all duplicates
          for (const loser of rows.slice(1)) {
            deleteRow.run(loser.id);
            deletedDup++;
          }
        }
        return { updatedSku, deletedDup };
      });

      const { updatedSku, deletedDup } = dedupTx();
      if (updatedSku > 0 || deletedDup > 0) {
        console.log(`[migrations] inventory: ${updatedSku} SKUs stabilised, ${deletedDup} duplicate rows removed`);
      }
    }

    // Also clean up NULL-sku rows from any source (they bypass the unique constraint)
    const nullFixed = db.prepare(`
      UPDATE inventory_cache
      SET sku = source || '-null-' || CAST(id AS TEXT)
      WHERE sku IS NULL OR sku = ''
    `).run();
    if (nullFixed.changes > 0) {
      console.log(`[migrations] inventory: fixed ${nullFixed.changes} rows with NULL/empty sku`);
    }

  } catch (err) {
    console.warn('[migrations] inventory dedup failed (non-fatal):', err.message);
  }

  // ── Purge imp-*/csv-* rows superseded by API sync (revenue dedup fix) ────────
  //
  // ROOT CAUSE: fetchOrders() (API sync) clears and re-inserts loc-* rows but
  // never removed imp-*/csv-* rows from prior manual CSV imports. Both sets
  // represent the same real Locally orders under different IDs, so both were
  // counted by `WHERE financial_status='paid'` → revenue was inflated by the
  // full CSV import amount (≈ +101k EGP).
  //
  // PREVIOUS ATTEMPT relied on loc-* rows existing — broken because an earlier
  // migration (lines ~308-317) purges all loc-* rows on startup before this
  // block runs, so the subquery returned no brands and nothing was deleted.
  //
  // CORRECT CONDITION: use the integrations table. If the Locally integration
  // is 'connected' or 'warning', the API sync has successfully run (or is
  // running) and is the authoritative source. imp-*/csv-* rows for those brands
  // are superseded and must be deleted.
  //
  // Brands where Locally is 'disconnected' or absent keep their import rows —
  // they have no API data, so the CSV is their only source.
  //
  // This is a one-time cleanup; fetchOrders() now performs the same cleanup on
  // every successful sync, so the situation cannot recur after the first sync.
  try {
    const impPurge = db.prepare(`
      DELETE FROM orders_cache
      WHERE  source = 'locally'
        AND  (source_order_id LIKE 'imp-%' OR source_order_id LIKE 'csv-%')
        AND  brand_id IN (
          SELECT brand_id FROM integrations
          WHERE  platform = 'locally'
            AND  status IN ('connected', 'warning')
        )
    `).run();
    if (impPurge.changes > 0) {
      console.log(`[migrations] purged ${impPurge.changes} imp-*/csv-* rows superseded by connected API sync (revenue dedup fix)`);
    }
  } catch (err) {
    console.warn('[migrations] imp-*/csv-* dedup purge failed (non-fatal):', err.message);
  }

  // ── Tier system ───────────────────────────────────────────────────────────────
  //
  // TIER_SYSTEM — free / paid two-tier access model.
  //
  // brands.tier          : 'free' | 'paid'. Defaults to 'free' for all brands.
  // brands.last_seen_at  : Updated on every /api/me call. Used for re-engagement.
  // brands.ig_handle     : Instagram handle collected at signup (Step 3 of tier system).
  // brands.revenue_range : Self-reported revenue range from signup form.
  // users.phone          : Phone number collected at signup (for WhatsApp CTA lead capture).
  // integrations.sync_paused : 1 = background scheduler skips this integration.
  //   Set to 1 on paid integrations when a brand is downgraded to free.
  //   Credentials are NOT cleared — set to 0 on re-upgrade to resume automatically.

  addColumn('brands',       'tier',           "TEXT NOT NULL DEFAULT 'free'");
  addColumn('brands',       'last_seen_at',   'TIMESTAMP DEFAULT NULL');
  addColumn('brands',       'ig_handle',      'TEXT DEFAULT NULL');
  addColumn('brands',       'revenue_range',  'TEXT DEFAULT NULL');
  addColumn('users',        'phone',          'TEXT DEFAULT NULL');
  addColumn('integrations', 'sync_paused',    'INTEGER DEFAULT 0');

  // ── tier_changes — immutable audit log for every tier transition ─────────────
  //
  // Every call to setBrandTier() atomically inserts a row here alongside the
  // UPDATE on brands.tier.  Never deleted — used for billing audit and support.
  // changed_by: 'admin' (via /api/admin) | 'system' | user email
  db.exec(`
    CREATE TABLE IF NOT EXISTS tier_changes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id    TEXT    NOT NULL,
      old_tier    TEXT    NOT NULL,
      new_tier    TEXT    NOT NULL,
      changed_by  TEXT    NOT NULL DEFAULT 'system',
      note        TEXT    DEFAULT NULL,
      changed_at  TEXT    DEFAULT (datetime('now')),
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_tc_brand
      ON tier_changes(brand_id, changed_at DESC);
  `);

  // ── events — internal analytics decoupled from n8n ───────────────────────────
  //
  // Every significant action (signup, tier change, integration connect, etc.)
  // is written here BEFORE the optional n8n/webhook fanout.
  // Rate-limited read endpoint: GET /api/events (30 req/min per user — Step 9).
  // Admin read endpoint: GET /api/admin/events (no rate limit — Step 1 admin routes).
  //
  // event_name examples: 'signup', 'tier_upgrade', 'tier_downgrade',
  //   'integration_connected', 'integration_disconnected', 'onboarding_complete',
  //   'lead_captured'
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id    TEXT    NOT NULL,
      user_id     INTEGER DEFAULT NULL,
      event_name  TEXT    NOT NULL,
      payload     TEXT    DEFAULT NULL,   -- JSON blob
      created_at  TEXT    DEFAULT (datetime('now')),
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_events_brand
      ON events(brand_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_name
      ON events(event_name, created_at DESC);
  `);

  // ── lead_contacts — ADMIN PHASE 2 ────────────────────────────────────────────
  //
  // Tracks which high-priority events the founder has already followed up on.
  // One row per event_id (event_id is PK so there is at most one contacted row).
  // Rows are deleted by DELETE /api/admin/leads/:event_id/contacted (mistake recovery).
  //
  // High-priority event_names queried here:
  //   new_signup_high_revenue | simulator_3x_with_shopify | talk_to_us | simulator_3x
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_contacts (
      event_id      INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
      contacted_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      contacted_by  TEXT DEFAULT 'admin',
      notes         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_lead_contacts_event
      ON lead_contacts(event_id);
  `);

  // ── ADMIN PHASE 3 — impersonation_sessions ────────────────────────────────────
  //
  // Tracks every admin impersonation session (login-as-brand). Rows are never
  // deleted — they form an immutable audit trail. revoked=1 means the session
  // was forcibly ended by the admin before the 30-minute JWT expired.
  //
  // session_id: UUID generated server-side, embedded in the impersonation JWT.
  // The JWT is verified by requireAuth using the same JWT_SECRET; the
  // impersonation_session_id claim is cross-checked here for revocation.
  db.exec(`
    CREATE TABLE IF NOT EXISTS impersonation_sessions (
      session_id  TEXT    PRIMARY KEY,
      brand_id    TEXT    NOT NULL,
      user_id     INTEGER NOT NULL DEFAULT 0,
      reason      TEXT    NOT NULL,
      started_at  TEXT    DEFAULT (datetime('now')),
      ended_at    TEXT    DEFAULT NULL,
      revoked     INTEGER DEFAULT 0,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_imp_brand
      ON impersonation_sessions(brand_id, started_at DESC);
  `);

  // ── ADMIN PHASE 3 — system_settings ──────────────────────────────────────────
  //
  // Key/value store for admin-controlled system flags.
  // Keys used so far:
  //   syncs_paused_globally : '1' = all scheduled syncs are skipped until '0'
  //
  // The scheduler reads this on every tick so pausing takes effect within the
  // next scheduled interval (≤30 minutes) without a server restart.
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO system_settings (key, value) VALUES ('syncs_paused_globally', '0');
  `);

  // ── CX: Customer Experience tables (Phase 4) ──────────────────────────────────
  //
  // cx_settings : one row per brand — WhatsApp number, enabled flag, n8n URL.
  //   setup_status: 'pending' → 'whatsapp_setup' → 'templates_setup' → 'live' | 'error'
  //
  // cx_flows : 7 automation rows per brand (one per flow_type).
  //   Seeded automatically when a brand upgrades to paid.
  //   All disabled by default — brand enables individually after reviewing templates.
  //
  // cx_messages : every outbound CX message (queued → sent → delivered | failed).
  //   n8n_execution_id : set when n8n calls back /api/cx/webhook/sent.
  //   Used for the activity feed + stats cards on the CS tab.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cx_settings (
      brand_id                 TEXT    PRIMARY KEY REFERENCES brands(id) ON DELETE CASCADE,
      whatsapp_number          TEXT    DEFAULT NULL,
      whatsapp_number_verified INTEGER DEFAULT 0,
      enabled                  INTEGER DEFAULT 0,
      setup_status             TEXT    NOT NULL DEFAULT 'pending',
      n8n_workflow_url         TEXT    DEFAULT NULL,
      notify_ig_ready          INTEGER DEFAULT 0,
      created_at               TEXT    DEFAULT (datetime('now')),
      updated_at               TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cx_flows (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id          TEXT    NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      flow_type         TEXT    NOT NULL,
      enabled           INTEGER NOT NULL DEFAULT 0,
      template_text     TEXT    NOT NULL DEFAULT '',
      delay_minutes     INTEGER NOT NULL DEFAULT 0,
      triggered_count   INTEGER NOT NULL DEFAULT 0,
      last_triggered_at TEXT    DEFAULT NULL,
      created_at        TEXT    DEFAULT (datetime('now')),
      updated_at        TEXT    DEFAULT (datetime('now')),
      UNIQUE(brand_id, flow_type)
    );
    CREATE INDEX IF NOT EXISTS idx_cx_flows_brand
      ON cx_flows(brand_id, flow_type);

    CREATE TABLE IF NOT EXISTS cx_messages (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id         TEXT    NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      flow_type        TEXT    NOT NULL,
      channel          TEXT    NOT NULL DEFAULT 'whatsapp',
      recipient_phone  TEXT    NOT NULL,
      recipient_name   TEXT    DEFAULT NULL,
      order_id         TEXT    DEFAULT NULL,
      message_body     TEXT    DEFAULT NULL,
      status           TEXT    NOT NULL DEFAULT 'queued',
      sent_at          TEXT    DEFAULT NULL,
      delivered_at     TEXT    DEFAULT NULL,
      failed_reason    TEXT    DEFAULT NULL,
      n8n_execution_id TEXT    DEFAULT NULL,
      created_at       TEXT    DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cx_msgs_brand
      ON cx_messages(brand_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cx_msgs_status
      ON cx_messages(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cx_msgs_order
      ON cx_messages(brand_id, order_id, flow_type);
  `);

  // ── has_showroom / showroom_platform on brands ─────────────────────────────
  // has_showroom: 0 = online only, 1 = has showroom. Default 0.
  // showroom_platform: 'locally' | null. Only option for now.
  addColumn('brands', 'has_showroom',       'INTEGER DEFAULT 0');
  addColumn('brands', 'showroom_platform',  'TEXT DEFAULT NULL');

  // ── targets table ─────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS targets (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id         TEXT    NOT NULL,
      metric_name      TEXT    NOT NULL,
      target_value     REAL    NOT NULL,
      target_secondary REAL    DEFAULT NULL,
      period_type      TEXT    NOT NULL DEFAULT 'monthly',
      period_start     DATE    NOT NULL,
      period_end       DATE    NOT NULL,
      enabled          INTEGER DEFAULT 1,
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(brand_id, metric_name, period_start),
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_targets_brand_period
      ON targets(brand_id, period_start, period_end);
  `);

  // ── leads — qualification form submissions (funnel) ───────────────────────────
  //
  // Prospect fills /book qualification form before seeing Calendly.
  // booked_calendly is set to 1 when Calendly webhook fires.
  // contacted / contacted_at are admin-controlled from the Form Leads view.
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_name        TEXT NOT NULL,
      contact_name      TEXT NOT NULL,
      email             TEXT NOT NULL,
      phone             TEXT NOT NULL,
      ig_handle         TEXT NOT NULL,
      website           TEXT NOT NULL,
      revenue_range     TEXT NOT NULL,
      has_showroom      INTEGER DEFAULT 0,
      showroom_platform TEXT,
      cs_handled_by     TEXT NOT NULL,
      booked_calendly   INTEGER DEFAULT 0,
      calendly_event_url TEXT,
      contacted         INTEGER DEFAULT 0,
      contacted_at      TIMESTAMP,
      notes             TEXT,
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ip_address        TEXT,
      user_agent        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_leads_created  ON leads(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_leads_revenue  ON leads(revenue_range);
    CREATE INDEX IF NOT EXISTS idx_leads_contacted ON leads(contacted, created_at DESC);
  `);

  // ── leads.source — tracks where the booking request originated ───────────────
  // Values: 'direct' (typed /book URL), 'customer_service', 'marketing_meta_ads',
  //   'dashboard', or any other source identifier passed via ?source= on /book.
  addColumn('leads', 'source', "TEXT DEFAULT 'direct'");

  // ── Brand customization (branding system) ─────────────────────────────────────
  //
  // brand_color      : one of 16 whitelisted accent hex values (e.g. '#1B2B5A').
  //   NULL = no accent chosen — UI defaults to #ffffff.
  //   Set via POST /api/:brand_id/branding/color.
  //   Cleared via DELETE /api/:brand_id/branding/color.
  //
  // logo_uploaded_at : ISO timestamp of the last successful logo upload.
  //   NULL = no logo uploaded via the branding endpoint.
  //   (brands.logo_url already exists from initial schema — used here as the storage field)
  //
  // Note: brands.logo_url already exists in the base schema (created in schema.sql).
  // We only add the two new columns that don't exist yet.
  addColumn('brands', 'brand_color',      'TEXT DEFAULT NULL');
  addColumn('brands', 'logo_uploaded_at', 'TIMESTAMP DEFAULT NULL');

  // ── Food Brand (restaurant ops) workspace type ─────────────────────────────
  //
  // business_type: 'ecommerce' (default) | 'food_brand'
  //   Determines which dashboard experience a workspace gets.
  //   Set at signup via POST /api/auth/signup { business_type }.
  //   Read by GET /api/me and used by the frontend to route to the correct HTML.
  addColumn('brands', 'business_type', "TEXT NOT NULL DEFAULT 'ecommerce'");

  // ── fb_* tables — Food Brand operational data ──────────────────────────────
  //
  // All tables are prefixed fb_ to avoid collision with existing tables.
  // Every row is scoped to a brand_id (FK → brands.id ON DELETE CASCADE).
  // Composite primary keys / unique constraints replace BUNZY's single-tenant
  // date PKs so multiple food brand workspaces can coexist in the same DB.

  db.exec(`
    CREATE TABLE IF NOT EXISTS fb_settings (
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      key      TEXT NOT NULL,
      value    TEXT NOT NULL,
      PRIMARY KEY (brand_id, key)
    );

    CREATE TABLE IF NOT EXISTS fb_setup_expenses (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id       TEXT    NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      item           TEXT    NOT NULL,
      category       TEXT    NOT NULL,
      amount         REAL    NOT NULL DEFAULT 0,
      date_paid      TEXT,
      payment_method TEXT,
      paid_by        TEXT,
      notes          TEXT,
      created_at     TEXT    DEFAULT (datetime('now')),
      updated_at     TEXT    DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fb_setup_brand ON fb_setup_expenses(brand_id);

    CREATE TABLE IF NOT EXISTS fb_recurring_expenses (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id         TEXT    NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      item             TEXT    NOT NULL,
      frequency        TEXT    NOT NULL,
      amount           REAL,
      percent_rate     REAL,
      weekly_due_day   INTEGER,
      monthly_due_date INTEGER,
      payment_method   TEXT,
      active           INTEGER NOT NULL DEFAULT 1,
      notes            TEXT,
      created_at       TEXT    DEFAULT (datetime('now')),
      updated_at       TEXT    DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fb_recurring_brand ON fb_recurring_expenses(brand_id);

    CREATE TABLE IF NOT EXISTS fb_daily_revenue (
      brand_id              TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      date                  TEXT NOT NULL,
      revenue_cash          REAL NOT NULL DEFAULT 0,
      revenue_visa          REAL NOT NULL DEFAULT 0,
      revenue_talabat_gross REAL NOT NULL DEFAULT 0,
      updated_at            TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (brand_id, date)
    );

    CREATE TABLE IF NOT EXISTS fb_daily_expenses (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id             TEXT    NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      date                 TEXT    NOT NULL,
      category             TEXT    NOT NULL,
      item                 TEXT    NOT NULL,
      amount               REAL    NOT NULL DEFAULT 0,
      payment_method       TEXT,
      paid_by              TEXT,
      notes                TEXT,
      recurring_expense_id INTEGER,
      created_at           TEXT    DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fb_daily_exp_brand_date ON fb_daily_expenses(brand_id, date);

    CREATE TABLE IF NOT EXISTS fb_bank_transfers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id        TEXT    NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      date_received   TEXT    NOT NULL,
      source          TEXT    NOT NULL,
      period_from     TEXT    NOT NULL,
      period_to       TEXT    NOT NULL,
      amount_received REAL    NOT NULL DEFAULT 0,
      confirmed       TEXT    NOT NULL DEFAULT 'Pending',
      notes           TEXT,
      created_at      TEXT    DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fb_transfers_brand_date ON fb_bank_transfers(brand_id, date_received);

    CREATE TABLE IF NOT EXISTS fb_cash_drawer_check (
      brand_id            TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      date                TEXT NOT NULL,
      opening_cash        REAL,
      actual_counted_cash REAL,
      updated_at          TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (brand_id, date)
    );

    CREATE TABLE IF NOT EXISTS fb_inventory_check (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id       TEXT    NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      date           TEXT    NOT NULL,
      item           TEXT    NOT NULL,
      unit           TEXT,
      system_count   REAL,
      physical_count REAL,
      notes          TEXT,
      created_at     TEXT    DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fb_inventory_brand_date ON fb_inventory_check(brand_id, date);
    CREATE INDEX IF NOT EXISTS idx_fb_inventory_brand_item ON fb_inventory_check(brand_id, item);

    CREATE TABLE IF NOT EXISTS fb_calendar_notes (
      brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      date     TEXT NOT NULL,
      note     TEXT NOT NULL,
      PRIMARY KEY (brand_id, date)
    );
  `);

  // ── Remove bunzyeg@gmail.com so they can re-register as food_brand ─────────
  // Uses CASCADE deletes: brands → all brand tables; users → sessions + tokens.
  try {
    const bunzyUser = db.prepare("SELECT id FROM users WHERE email = 'bunzyeg@gmail.com'").get();
    if (bunzyUser) {
      const bunzyBrands = db.prepare('SELECT brand_id FROM user_brands WHERE user_id = ?')
        .all(bunzyUser.id);
      for (const row of bunzyBrands) {
        db.prepare('DELETE FROM brands WHERE id = ?').run(row.brand_id);
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(bunzyUser.id);
      console.log('[migrations] purged bunzyeg@gmail.com — free to re-register');
    }
  } catch (err) {
    console.warn('[migrations] bunzy purge failed:', err.message);
  }

  console.log('[migrations] ready');
}

module.exports = { runMigrations };
