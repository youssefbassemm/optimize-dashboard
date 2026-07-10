'use strict';

/**
 * /api/:brand_id/food-brand/*
 *
 * All routes are brand-scoped (brand_id comes from requireBrandOwnership middleware).
 * Tables are fb_* equivalents of BUNZY's single-tenant tables.
 */

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../db/db');
const calc    = require('../lib/fb-calc');
const cfg     = require('../lib/fb-config');

// ── helpers ───────────────────────────────────────────────────────────────────

function getTalabatRate(brandId) {
  const row = db.getFbSetting(brandId, 'talabat_commission_rate');
  return row ? parseFloat(row.value) : cfg.DEFAULT_TALABAT_COMMISSION_RATE;
}

function getSeasonDates(brandId) {
  const startRow = db.getFbSetting(brandId, 'season_start');
  const endRow   = db.getFbSetting(brandId, 'season_end');
  return {
    start: startRow?.value || cfg.SEASON.START,
    end:   endRow?.value   || cfg.SEASON.END,
  };
}

function attachExpected(brandId, rows) {
  const rate = getTalabatRate(brandId);
  return rows.map(row => {
    const revenueRows = db.db.prepare('SELECT * FROM fb_daily_revenue WHERE brand_id = ? AND date >= ? AND date <= ?')
      .all(brandId, row.period_from, row.period_to);
    const expected = calc.expectedTransferAmount(row.source, revenueRows, rate);
    return { ...row, expected_amount: expected, difference: row.amount_received - expected };
  });
}

function computeCashDrawer(brandId, date) {
  const row = db.getFbCashDrawer(brandId, date);
  const { start: seasonStart } = getSeasonDates(brandId);
  const isSeasonStart = date === seasonStart;
  let openingCash = row?.opening_cash ?? null;
  let openingSource = 'manual';

  if (openingCash === null && !isSeasonStart) {
    const prevDate = calc.addDays(date, -1);
    const prevRow  = db.getFbCashDrawer(brandId, prevDate);
    if (prevRow && prevRow.actual_counted_cash !== null) {
      openingCash   = prevRow.actual_counted_cash;
      openingSource = 'previous_day';
    } else {
      openingSource = 'missing_previous';
    }
  }

  const revenueRow = db.getFbDailyRevenue(brandId, date);
  const cashRevenue = revenueRow?.revenue_cash ?? 0;

  const cashExpenses = db.db.prepare(
    "SELECT * FROM fb_daily_expenses WHERE brand_id = ? AND date = ? AND payment_method = 'Cash'"
  ).all(brandId, date);
  const cashExpensesPaidOut = cashExpenses.reduce((a, b) => a + b.amount, 0);

  const cashTransfers = db.db.prepare(
    "SELECT * FROM fb_bank_transfers WHERE brand_id = ? AND date_received = ? AND source = 'Cash Deposit'"
  ).all(brandId, date);
  const cashTransferredOut = cashTransfers.reduce((a, b) => a + b.amount_received, 0);

  const expectedClosing = openingCash !== null
    ? calc.expectedClosingCash(openingCash, cashRevenue, cashExpensesPaidOut, cashTransferredOut)
    : null;

  const actual   = row?.actual_counted_cash ?? null;
  const variance = actual !== null && expectedClosing !== null ? calc.cashVariance(actual, expectedClosing) : null;

  return {
    date,
    opening_cash: openingCash,
    opening_source: openingSource,
    is_season_start: isSeasonStart,
    cash_revenue: cashRevenue,
    cash_expenses_paid_out: cashExpensesPaidOut,
    cash_transferred_out: cashTransferredOut,
    expected_closing_cash: expectedClosing,
    actual_counted_cash: actual,
    variance,
  };
}

function toCSV(rows) {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  const lines = [keys.join(',')];
  for (const row of rows) {
    lines.push(keys.map(k => {
      const v = row[k];
      if (v === null || v === undefined) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','));
  }
  return lines.join('\n');
}

// ── settings ──────────────────────────────────────────────────────────────────

// GET  /api/:brand_id/food-brand/settings
router.get('/settings', (req, res) => {
  const { brand_id } = req.params;
  const rows = db.db.prepare('SELECT key, value FROM fb_settings WHERE brand_id = ?').all(brand_id);
  res.json(rows);
});

// PUT  /api/:brand_id/food-brand/settings
router.put('/settings', (req, res) => {
  const { brand_id } = req.params;
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ ok: false, error: 'key is required' });
  db.setFbSetting(brand_id, key, String(value));
  res.json({ ok: true });
});

// ── setup expenses ────────────────────────────────────────────────────────────

// GET  /api/:brand_id/food-brand/setup-expenses
router.get('/setup-expenses', (req, res) => {
  res.json(db.getFbSetupExpenses(req.params.brand_id));
});

// POST /api/:brand_id/food-brand/setup-expenses
router.post('/setup-expenses', (req, res) => {
  const { brand_id } = req.params;
  const body = req.body;
  if (!body.item || !body.category) {
    return res.status(400).json({ ok: false, error: 'item and category are required' });
  }
  res.status(201).json(db.insertFbSetupExpense(brand_id, body));
});

// PUT  /api/:brand_id/food-brand/setup-expenses/:id
router.put('/setup-expenses/:id', (req, res) => {
  const { brand_id, id } = req.params;
  const existing = db.db.prepare('SELECT id FROM fb_setup_expenses WHERE id = ? AND brand_id = ?').get(id, brand_id);
  if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });
  db.updateFbSetupExpense(brand_id, id, req.body);
  res.json(db.db.prepare('SELECT * FROM fb_setup_expenses WHERE id = ?').get(id));
});

// DELETE /api/:brand_id/food-brand/setup-expenses/:id
router.delete('/setup-expenses/:id', (req, res) => {
  const { brand_id, id } = req.params;
  const existing = db.db.prepare('SELECT id FROM fb_setup_expenses WHERE id = ? AND brand_id = ?').get(id, brand_id);
  if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });
  db.deleteFbSetupExpense(brand_id, id);
  res.json({ ok: true });
});

// ── recurring expenses ────────────────────────────────────────────────────────

// GET  /api/:brand_id/food-brand/recurring-expenses
router.get('/recurring-expenses', (req, res) => {
  res.json(db.getFbRecurringExpenses(req.params.brand_id));
});

// POST /api/:brand_id/food-brand/recurring-expenses
router.post('/recurring-expenses', (req, res) => {
  const { brand_id } = req.params;
  const body = req.body;
  if (!body.item || !body.frequency) {
    return res.status(400).json({ ok: false, error: 'item and frequency are required' });
  }
  res.status(201).json(db.insertFbRecurringExpense(brand_id, {
    item:             body.item,
    frequency:        body.frequency,
    amount:           body.frequency === 'Percent of Sales' ? null : (body.amount ?? 0),
    percent_rate:     body.frequency === 'Percent of Sales' ? (body.percent_rate ?? 0) : null,
    weekly_due_day:   body.frequency === 'Weekly'  ? (body.weekly_due_day ?? 0) : null,
    monthly_due_date: body.frequency === 'Monthly' ? (body.monthly_due_date ?? 1) : null,
    payment_method:   body.payment_method ?? null,
    active:           body.active === false ? 0 : 1,
    notes:            body.notes ?? null,
  }));
});

// PUT  /api/:brand_id/food-brand/recurring-expenses/:id
router.put('/recurring-expenses/:id', (req, res) => {
  const { brand_id, id } = req.params;
  const existing = db.db.prepare('SELECT id FROM fb_recurring_expenses WHERE id = ? AND brand_id = ?').get(id, brand_id);
  if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });
  const body = req.body;
  db.updateFbRecurringExpense(brand_id, id, {
    item:             body.item,
    frequency:        body.frequency,
    amount:           body.frequency === 'Percent of Sales' ? null : (body.amount ?? 0),
    percent_rate:     body.frequency === 'Percent of Sales' ? (body.percent_rate ?? 0) : null,
    weekly_due_day:   body.frequency === 'Weekly'  ? (body.weekly_due_day ?? 0) : null,
    monthly_due_date: body.frequency === 'Monthly' ? (body.monthly_due_date ?? 1) : null,
    payment_method:   body.payment_method ?? null,
    active:           body.active === false ? 0 : 1,
    notes:            body.notes ?? null,
  });
  res.json(db.db.prepare('SELECT * FROM fb_recurring_expenses WHERE id = ?').get(id));
});

// DELETE /api/:brand_id/food-brand/recurring-expenses/:id
router.delete('/recurring-expenses/:id', (req, res) => {
  const { brand_id, id } = req.params;
  const existing = db.db.prepare('SELECT id FROM fb_recurring_expenses WHERE id = ? AND brand_id = ?').get(id, brand_id);
  if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });
  db.deleteFbRecurringExpense(brand_id, id);
  res.json({ ok: true });
});

// ── revenue ───────────────────────────────────────────────────────────────────

// GET /api/:brand_id/food-brand/revenue  (all rows)
router.get('/revenue', (req, res) => {
  const rows = db.db.prepare('SELECT * FROM fb_daily_revenue WHERE brand_id = ? ORDER BY date').all(req.params.brand_id);
  res.json(rows);
});

// GET /api/:brand_id/food-brand/revenue/:date
router.get('/revenue/:date', (req, res) => {
  const { brand_id, date } = req.params;
  const rate = getTalabatRate(brand_id);
  const row  = db.getFbDailyRevenue(brand_id, date);
  const base = row ?? { date, revenue_cash: 0, revenue_visa: 0, revenue_talabat_gross: 0 };
  const { commission, net } = calc.talabatBreakdown(base.revenue_talabat_gross, rate);
  res.json({ ...base, talabat_commission: commission, talabat_net: net, total_revenue: calc.totalRevenueForDay(base, rate), exists: !!row });
});

// PUT /api/:brand_id/food-brand/revenue/:date
router.put('/revenue/:date', (req, res) => {
  const { brand_id, date } = req.params;
  const rate = getTalabatRate(brand_id);
  const row  = db.upsertFbDailyRevenue(brand_id, date, req.body);
  const { commission, net } = calc.talabatBreakdown(row.revenue_talabat_gross, rate);
  res.json({ ...row, talabat_commission: commission, talabat_net: net, total_revenue: calc.totalRevenueForDay(row, rate), exists: true });
});

// ── daily expenses ────────────────────────────────────────────────────────────

// GET  /api/:brand_id/food-brand/expenses[?date=YYYY-MM-DD]
router.get('/expenses', (req, res) => {
  const { brand_id } = req.params;
  const { date } = req.query;
  const rows = date
    ? db.db.prepare('SELECT * FROM fb_daily_expenses WHERE brand_id = ? AND date = ? ORDER BY id DESC').all(brand_id, date)
    : db.db.prepare('SELECT * FROM fb_daily_expenses WHERE brand_id = ? ORDER BY date DESC, id DESC').all(brand_id);
  res.json(rows);
});

// POST /api/:brand_id/food-brand/expenses
router.post('/expenses', (req, res) => {
  const { brand_id } = req.params;
  const body = req.body;
  if (!body.date || !body.category || !body.item) {
    return res.status(400).json({ ok: false, error: 'date, category and item are required' });
  }
  res.status(201).json(db.insertFbDailyExpense(brand_id, body));
});

// PUT  /api/:brand_id/food-brand/expenses/:id
router.put('/expenses/:id', (req, res) => {
  const { brand_id, id } = req.params;
  const existing = db.db.prepare('SELECT id FROM fb_daily_expenses WHERE id = ? AND brand_id = ?').get(id, brand_id);
  if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });
  const body = req.body;
  db.db.prepare(`UPDATE fb_daily_expenses SET date = ?, category = ?, item = ?, amount = ?,
    payment_method = ?, paid_by = ?, notes = ? WHERE id = ? AND brand_id = ?`)
    .run(body.date, body.category, body.item, body.amount ?? 0,
         body.payment_method ?? null, body.paid_by ?? null, body.notes ?? null, id, brand_id);
  res.json(db.db.prepare('SELECT * FROM fb_daily_expenses WHERE id = ?').get(id));
});

// DELETE /api/:brand_id/food-brand/expenses/:id
router.delete('/expenses/:id', (req, res) => {
  const { brand_id, id } = req.params;
  const existing = db.db.prepare('SELECT id FROM fb_daily_expenses WHERE id = ? AND brand_id = ?').get(id, brand_id);
  if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });
  db.deleteFbDailyExpense(brand_id, id);
  res.json({ ok: true });
});

// ── bank transfers ────────────────────────────────────────────────────────────

// GET  /api/:brand_id/food-brand/transfers[?date=YYYY-MM-DD]
router.get('/transfers', (req, res) => {
  const { brand_id } = req.params;
  const { date } = req.query;
  const rows = date
    ? db.db.prepare('SELECT * FROM fb_bank_transfers WHERE brand_id = ? AND date_received = ? ORDER BY id DESC').all(brand_id, date)
    : db.db.prepare('SELECT * FROM fb_bank_transfers WHERE brand_id = ? ORDER BY date_received DESC, id DESC').all(brand_id);
  res.json(attachExpected(brand_id, rows));
});

// GET  /api/:brand_id/food-brand/transfers/expected?source=&from=&to=
router.get('/transfers/expected', (req, res) => {
  const { brand_id } = req.params;
  const { source, from, to } = req.query;
  if (!source || !from || !to) return res.status(400).json({ ok: false, error: 'source, from and to are required' });
  const revenueRows = db.db.prepare('SELECT * FROM fb_daily_revenue WHERE brand_id = ? AND date >= ? AND date <= ?').all(brand_id, from, to);
  res.json({ expected_amount: calc.expectedTransferAmount(source, revenueRows, getTalabatRate(brand_id)) });
});

// POST /api/:brand_id/food-brand/transfers
router.post('/transfers', (req, res) => {
  const { brand_id } = req.params;
  const body = req.body;
  if (!body.date_received || !body.source || !body.period_from || !body.period_to) {
    return res.status(400).json({ ok: false, error: 'date_received, source, period_from and period_to are required' });
  }
  const row = db.insertFbBankTransfer(brand_id, body);
  res.status(201).json(attachExpected(brand_id, [row])[0]);
});

// PUT  /api/:brand_id/food-brand/transfers/:id
router.put('/transfers/:id', (req, res) => {
  const { brand_id, id } = req.params;
  const existing = db.db.prepare('SELECT id FROM fb_bank_transfers WHERE id = ? AND brand_id = ?').get(id, brand_id);
  if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });
  db.updateFbBankTransfer(brand_id, id, req.body);
  res.json(db.db.prepare('SELECT * FROM fb_bank_transfers WHERE id = ?').get(id));
});

// DELETE /api/:brand_id/food-brand/transfers/:id
router.delete('/transfers/:id', (req, res) => {
  const { brand_id, id } = req.params;
  const existing = db.db.prepare('SELECT id FROM fb_bank_transfers WHERE id = ? AND brand_id = ?').get(id, brand_id);
  if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });
  db.deleteFbBankTransfer(brand_id, id);
  res.json({ ok: true });
});

// ── cash drawer ───────────────────────────────────────────────────────────────

// GET /api/:brand_id/food-brand/cash-drawer/:date
router.get('/cash-drawer/:date', (req, res) => {
  res.json(computeCashDrawer(req.params.brand_id, req.params.date));
});

// PUT /api/:brand_id/food-brand/cash-drawer/:date
router.put('/cash-drawer/:date', (req, res) => {
  const { brand_id, date } = req.params;
  const body     = req.body;
  const computed = computeCashDrawer(brand_id, date);
  const openingCash = body.opening_cash !== undefined ? body.opening_cash : computed.opening_cash;
  db.upsertFbCashDrawer(brand_id, date, {
    opening_cash:         openingCash,
    actual_counted_cash:  body.actual_counted_cash ?? null,
  });
  res.json(computeCashDrawer(brand_id, date));
});

// ── inventory ─────────────────────────────────────────────────────────────────

// GET  /api/:brand_id/food-brand/inventory[?date=&item=&days=]
router.get('/inventory', (req, res) => {
  const { brand_id } = req.params;
  const { date, item, days } = req.query;
  let rows;
  if (item && days) {
    rows = db.db.prepare(`SELECT * FROM fb_inventory_check WHERE brand_id = ? AND item = ? AND date >= date('now', ?) ORDER BY date`)
      .all(brand_id, item, `-${parseInt(days, 10)} days`);
  } else if (item) {
    rows = db.db.prepare('SELECT * FROM fb_inventory_check WHERE brand_id = ? AND item = ? ORDER BY date DESC').all(brand_id, item);
  } else if (date) {
    rows = db.db.prepare('SELECT * FROM fb_inventory_check WHERE brand_id = ? AND date = ? ORDER BY id DESC').all(brand_id, date);
  } else {
    rows = db.db.prepare('SELECT * FROM fb_inventory_check WHERE brand_id = ? ORDER BY date DESC, id DESC').all(brand_id);
  }
  res.json(rows);
});

// POST /api/:brand_id/food-brand/inventory
router.post('/inventory', (req, res) => {
  const { brand_id } = req.params;
  const body = req.body;
  if (!body.date || !body.item) return res.status(400).json({ ok: false, error: 'date and item are required' });
  res.status(201).json(db.insertFbInventoryCheck(brand_id, body));
});

// PUT  /api/:brand_id/food-brand/inventory/:id
router.put('/inventory/:id', (req, res) => {
  const { brand_id, id } = req.params;
  const existing = db.db.prepare('SELECT id FROM fb_inventory_check WHERE id = ? AND brand_id = ?').get(id, brand_id);
  if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });
  const body = req.body;
  db.db.prepare(`UPDATE fb_inventory_check SET date = ?, item = ?, unit = ?, system_count = ?, physical_count = ?, notes = ? WHERE id = ? AND brand_id = ?`)
    .run(body.date, body.item, body.unit ?? null, body.system_count ?? null, body.physical_count ?? null, body.notes ?? null, id, brand_id);
  res.json(db.db.prepare('SELECT * FROM fb_inventory_check WHERE id = ?').get(id));
});

// DELETE /api/:brand_id/food-brand/inventory/:id
router.delete('/inventory/:id', (req, res) => {
  const { brand_id, id } = req.params;
  const existing = db.db.prepare('SELECT id FROM fb_inventory_check WHERE id = ? AND brand_id = ?').get(id, brand_id);
  if (!existing) return res.status(404).json({ ok: false, error: 'Not found' });
  db.deleteFbInventoryCheck(brand_id, id);
  res.json({ ok: true });
});

// ── calendar notes ────────────────────────────────────────────────────────────

// GET  /api/:brand_id/food-brand/calendar-notes
router.get('/calendar-notes', (req, res) => {
  res.json(db.db.prepare('SELECT * FROM fb_calendar_notes WHERE brand_id = ? ORDER BY date').all(req.params.brand_id));
});

// POST /api/:brand_id/food-brand/calendar-notes
router.post('/calendar-notes', (req, res) => {
  const { brand_id } = req.params;
  const { date, note } = req.body;
  if (!date || !note) return res.status(400).json({ ok: false, error: 'date and note are required' });
  const row = db.upsertFbCalendarNote(brand_id, date, note);
  res.status(201).json(row);
});

// DELETE /api/:brand_id/food-brand/calendar-notes/:date
router.delete('/calendar-notes/:date', (req, res) => {
  const { brand_id, date } = req.params;
  db.upsertFbCalendarNote(brand_id, date, null);
  res.json({ ok: true });
});

// ── status for a given date ───────────────────────────────────────────────────

// GET /api/:brand_id/food-brand/status/:date
router.get('/status/:date', (req, res) => {
  const { brand_id, date } = req.params;
  const revenue      = db.getFbDailyRevenue(brand_id, date);
  const expenseCount = db.db.prepare('SELECT COUNT(*) as c FROM fb_daily_expenses WHERE brand_id = ? AND date = ?').get(brand_id, date);
  const cash         = db.getFbCashDrawer(brand_id, date);
  const invCount     = db.db.prepare('SELECT COUNT(*) as c FROM fb_inventory_check WHERE brand_id = ? AND date = ?').get(brand_id, date);
  res.json({
    date,
    revenue_entered:    !!revenue,
    expenses_entered:   expenseCount.c > 0,
    cash_counted:       !!cash && cash.actual_counted_cash !== null,
    inventory_checked:  invCount.c > 0,
  });
});

// ── recurring due on a date ───────────────────────────────────────────────────

// GET /api/:brand_id/food-brand/recurring-due/:date
router.get('/recurring-due/:date', (req, res) => {
  const { brand_id, date } = req.params;
  const all        = db.db.prepare('SELECT * FROM fb_recurring_expenses WHERE brand_id = ? AND active = 1').all(brand_id);
  const revenueRow = db.getFbDailyRevenue(brand_id, date);
  const totalRev   = revenueRow ? calc.totalRevenueForDay(revenueRow, getTalabatRate(brand_id)) : 0;

  const due = all
    .filter(exp => calc.isRecurringDueToday(exp, date))
    .map(exp => {
      const dueAmount = calc.recurringDueAmount(exp, totalRev);
      const logged    = db.db.prepare('SELECT * FROM fb_daily_expenses WHERE brand_id = ? AND date = ? AND recurring_expense_id = ?').get(brand_id, date, exp.id);
      return { ...exp, due_amount: dueAmount, logged: !!logged, logged_entry_id: logged ? logged.id : null };
    });
  res.json(due);
});

// ── summary (full season aggregate) ──────────────────────────────────────────

// GET /api/:brand_id/food-brand/summary
router.get('/summary', (req, res) => {
  const { brand_id } = req.params;
  const rate  = getTalabatRate(brand_id);
  const today = calc.todayStr();
  const { start: seasonStart, end: seasonEnd } = getSeasonDates(brand_id);
  const progress = calc.seasonProgress(today, seasonStart, seasonEnd);

  const revenueRows   = db.db.prepare('SELECT * FROM fb_daily_revenue WHERE brand_id = ?').all(brand_id);
  const cashRevenue   = revenueRows.reduce((a, r) => a + r.revenue_cash, 0);
  const visaRevenue   = revenueRows.reduce((a, r) => a + r.revenue_visa, 0);
  const talabatGross  = revenueRows.reduce((a, r) => a + r.revenue_talabat_gross, 0);
  const { commission: talabatCommission, net: talabatNet } = calc.talabatBreakdown(talabatGross, rate);
  const totalRevenue  = revenueRows.reduce((a, r) => a + calc.totalRevenueForDay(r, rate), 0);
  const daysWithRevenue  = revenueRows.length;
  const avgDailyRevenue  = daysWithRevenue > 0 ? totalRevenue / daysWithRevenue : 0;
  const cashPercent      = totalRevenue > 0 ? (cashRevenue / totalRevenue) * 100 : 0;
  const talabatPercent   = totalRevenue > 0 ? (talabatNet  / totalRevenue) * 100 : 0;

  const setupExpenses      = db.getFbSetupExpenses(brand_id);
  const totalSetupCost     = setupExpenses.reduce((a, e) => a + e.amount, 0);
  const dailyExpenses      = db.db.prepare('SELECT * FROM fb_daily_expenses WHERE brand_id = ?').all(brand_id);
  const totalDailyExpenses = dailyExpenses.reduce((a, e) => a + e.amount, 0);
  const recurringPaid      = dailyExpenses.filter(e => e.category === 'Recurring').reduce((a, e) => a + e.amount, 0);
  const totalAllExpenses   = totalSetupCost + totalDailyExpenses;

  const netCashGenerated      = totalRevenue - totalAllExpenses;
  const setupRecoveredPercent = calc.setupCostRecoveredPercent(netCashGenerated, totalSetupCost);

  const transfers = db.db.prepare('SELECT * FROM fb_bank_transfers WHERE brand_id = ?').all(brand_id);
  const transferredBySource = src => transfers.filter(t => t.source === src).reduce((a, t) => a + t.amount_received, 0);

  const channels = [
    { channel: 'Cash',    earned: cashRevenue, transferred: transferredBySource('Cash Deposit') },
    { channel: 'Visa',    earned: visaRevenue, transferred: transferredBySource('Visa Settlement') },
    { channel: 'Talabat', earned: talabatNet,  transferred: transferredBySource('Talabat Payout') },
  ].map(c => ({ ...c, gap: c.earned - c.transferred, flagged: c.earned - c.transferred > 0 }));

  const cashRows = db.db.prepare('SELECT * FROM fb_cash_drawer_check WHERE brand_id = ? ORDER BY date').all(brand_id);
  const cashRowsWithVariance = cashRows.map(row => {
    if (row.opening_cash === null || row.actual_counted_cash === null) return null;
    const revenueRow = revenueRows.find(r => r.date === row.date);
    const cashRev    = revenueRow?.revenue_cash ?? 0;
    const cashExp    = dailyExpenses.filter(e => e.date === row.date && e.payment_method === 'Cash').reduce((a, e) => a + e.amount, 0);
    const cashOut    = transfers.filter(t => t.date_received === row.date && t.source === 'Cash Deposit').reduce((a, t) => a + t.amount_received, 0);
    const expected   = calc.expectedClosingCash(row.opening_cash, cashRev, cashExp, cashOut);
    const variance   = calc.cashVariance(row.actual_counted_cash, expected);
    return { date: row.date, expected_closing_cash: expected, actual_counted_cash: row.actual_counted_cash, variance };
  }).filter(Boolean);

  const cumulativeCashVariance = cashRowsWithVariance.reduce((a, r) => a + r.variance, 0);
  const nonzeroVarianceDays    = cashRowsWithVariance.filter(r => Math.round(r.variance * 100) !== 0).length;
  const recentVariances        = [...cashRowsWithVariance].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 5);

  const inventoryRows   = db.db.prepare('SELECT * FROM fb_inventory_check WHERE brand_id = ?').all(brand_id);
  const linesChecked    = inventoryRows.length;
  const linesWithVariance = inventoryRows.filter(r => {
    const v = calc.inventoryVariance(r.system_count, r.physical_count);
    return v !== null && Math.round(v * 100) !== 0;
  }).length;
  const weekAgo = calc.addDays(today, -7);
  const topVariancesThisWeek = inventoryRows
    .filter(r => r.date >= weekAgo)
    .map(r => ({ ...r, variance: calc.inventoryVariance(r.system_count, r.physical_count), variance_percent: calc.inventoryVariancePercent(r.system_count, r.physical_count) }))
    .filter(r => r.variance !== null)
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))
    .slice(0, 5);

  const todayRevenue    = db.getFbDailyRevenue(brand_id, today);
  const todayExpCount   = db.db.prepare('SELECT COUNT(*) as c FROM fb_daily_expenses WHERE brand_id = ? AND date = ?').get(brand_id, today);
  const todayCash       = db.getFbCashDrawer(brand_id, today);
  const todayInvCount   = db.db.prepare('SELECT COUNT(*) as c FROM fb_inventory_check WHERE brand_id = ? AND date = ?').get(brand_id, today);

  res.json({
    today,
    season: progress,
    revenue: { totalRevenue, cashRevenue, visaRevenue, talabatGrossRevenue: talabatGross, talabatCommissionPaid: talabatCommission, talabatNetRevenue: talabatNet, cashPercent, talabatPercent, avgDailyRevenue, daysWithRevenue },
    expenses: { totalSetupCost, totalDailyExpenses, recurringPaid, totalAllExpenses },
    netPosition: { netCashGenerated, setupRecoveredPercent },
    bankTransferHealth: channels,
    cashDrawerHealth: { cumulativeVariance: cumulativeCashVariance, nonzeroVarianceDays, recentVariances },
    inventoryHealth: { linesChecked, linesWithVariance, topVariancesThisWeek },
    todayStatus: { date: today, revenue_entered: !!todayRevenue, expenses_entered: todayExpCount.c > 0, cash_counted: !!todayCash && todayCash.actual_counted_cash !== null, inventory_checked: todayInvCount.c > 0 },
  });
});

// ── CSV export ────────────────────────────────────────────────────────────────

const EXPORT_QUERIES = {
  revenue:              'SELECT * FROM fb_daily_revenue WHERE brand_id = ? ORDER BY date',
  expenses:             'SELECT * FROM fb_daily_expenses WHERE brand_id = ? ORDER BY date, id',
  transfers:            'SELECT * FROM fb_bank_transfers WHERE brand_id = ? ORDER BY date_received, id',
  'cash-drawer':        'SELECT * FROM fb_cash_drawer_check WHERE brand_id = ? ORDER BY date',
  inventory:            'SELECT * FROM fb_inventory_check WHERE brand_id = ? ORDER BY date, id',
  'setup-expenses':     'SELECT * FROM fb_setup_expenses WHERE brand_id = ? ORDER BY id',
  'recurring-expenses': 'SELECT * FROM fb_recurring_expenses WHERE brand_id = ? ORDER BY id',
};

// GET /api/:brand_id/food-brand/export/:table
router.get('/export/:table', (req, res) => {
  const { brand_id, table } = req.params;
  const query = EXPORT_QUERIES[table];
  if (!query) return res.status(404).json({ ok: false, error: 'Unknown table' });
  const rows = db.db.prepare(query).all(brand_id);
  const csv  = toCSV(rows);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="optimize-${table}.csv"`);
  res.send(csv);
});

module.exports = router;
