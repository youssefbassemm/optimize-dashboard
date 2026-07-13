'use strict';

const db  = require('../db/db');
const cfg = require('./fb-config');

// ── Helpers ───────────────────────────────────────────────────────────────────

function getTalabatRate(brandId) {
  const row = db.getFbSetting(brandId, 'talabat_commission_rate');
  return row ? parseFloat(row.value) : cfg.DEFAULT_TALABAT_COMMISSION_RATE;
}

function prevPeriod(startDate, endDate) {
  const s = new Date(startDate + 'T12:00:00Z');
  const e = new Date(endDate   + 'T12:00:00Z');
  const days = Math.round((e - s) / 86400000) + 1;
  const pe = new Date(s); pe.setUTCDate(pe.getUTCDate() - 1);
  const ps = new Date(pe); ps.setUTCDate(ps.getUTCDate() - days + 1);
  return { start: ps.toISOString().slice(0, 10), end: pe.toISOString().slice(0, 10) };
}

function pctChange(current, previous) {
  if (previous == null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function fmtEGP(n) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(Math.round(n));
  return (n < 0 ? '-' : '') + 'EGP ' + abs.toLocaleString('en-US');
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d + 'T12:00:00Z');
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function fmtPeriod(start, end) {
  return fmtDate(start) + ' – ' + fmtDate(end);
}

// ── Revenue ───────────────────────────────────────────────────────────────────

function getRevenueData(brandId, startDate, endDate) {
  const rate = getTalabatRate(brandId);
  const rows = db.db.prepare(
    'SELECT * FROM fb_daily_revenue WHERE brand_id=? AND date>=? AND date<=? ORDER BY date'
  ).all(brandId, startDate, endDate);

  const { start: ps, end: pe } = prevPeriod(startDate, endDate);
  const prevRows = db.db.prepare(
    'SELECT * FROM fb_daily_revenue WHERE brand_id=? AND date>=? AND date<=?'
  ).all(brandId, ps, pe);

  const enrich = r => {
    const talNet = Math.round((r.revenue_talabat_gross || 0) * (1 - rate));
    const total  = (r.revenue_cash || 0) + (r.revenue_visa || 0) + talNet;
    return { ...r, talabat_net: talNet, total };
  };

  const enriched = rows.map(enrich);
  const sumRows  = arr => ({
    cash:     arr.reduce((a, r) => a + (r.revenue_cash || 0), 0),
    visa:     arr.reduce((a, r) => a + (r.revenue_visa || 0), 0),
    talGross: arr.reduce((a, r) => a + (r.revenue_talabat_gross || 0), 0),
    talNet:   arr.reduce((a, r) => a + Math.round((r.revenue_talabat_gross || 0) * (1 - rate)), 0),
    get total() { return this.cash + this.visa + this.talNet; },
  });

  const cur  = sumRows(rows);
  const prev = sumRows(prevRows);
  const chg  = pctChange(cur.total, prev.total);

  const sorted  = [...enriched].sort((a, b) => b.total - a.total);
  const highest = sorted[0] || null;
  const lowest  = sorted[sorted.length - 1] || null;
  const avgDaily = enriched.length ? Math.round(cur.total / enriched.length) : 0;

  // Executive summary
  let summary;
  if (!enriched.length) {
    summary = `No revenue data was recorded between ${fmtDate(startDate)} and ${fmtDate(endDate)}.`;
  } else {
    const t = cur.total;
    const cashPct = t ? Math.round(cur.cash / t * 100) : 0;
    const visaPct = t ? Math.round(cur.visa / t * 100) : 0;
    const talPct  = 100 - cashPct - visaPct;
    const topCh   = cashPct >= visaPct && cashPct >= talPct ? `Cash (${cashPct}%)`
                  : visaPct >= talPct ? `Visa (${visaPct}%)` : `Talabat (${talPct}%)`;
    summary = `Total recorded revenue for ${fmtPeriod(startDate, endDate)} was ${fmtEGP(t)} across ${enriched.length} operating day${enriched.length !== 1 ? 's' : ''}, averaging ${fmtEGP(avgDaily)} per day. `;
    summary += `${topCh} was the leading payment channel. `;
    if (highest) summary += `The strongest day was ${fmtDate(highest.date)} with ${fmtEGP(highest.total)}. `;
    summary += chg != null
      ? (chg >= 0 ? `Revenue grew by ${chg.toFixed(1)}%` : `Revenue declined by ${Math.abs(chg).toFixed(1)}%`) + ` vs the previous equivalent period (${fmtPeriod(ps, pe)}).`
      : 'No equivalent previous-period data is available for comparison.';
  }

  return {
    type: 'revenue', title: 'Daily Revenue Report',
    startDate, endDate,
    rows: enriched, totals: cur,
    prevTotals: prev, prevPeriod: { start: ps, end: pe },
    pctChange: chg,
    kpis: [
      { label: 'Total Revenue',       value: fmtEGP(cur.total),   sub: chg != null ? (chg >= 0 ? '▲ ' : '▼ ') + Math.abs(chg).toFixed(1) + '% vs prev period' : 'No prev-period data', subOk: chg == null ? null : chg >= 0 },
      { label: 'Cash Revenue',         value: fmtEGP(cur.cash),    sub: cur.total ? Math.round(cur.cash / cur.total * 100) + '% of total' : '—' },
      { label: 'Visa Revenue',         value: fmtEGP(cur.visa),    sub: cur.total ? Math.round(cur.visa / cur.total * 100) + '% of total' : '—' },
      { label: 'Talabat Net Revenue',  value: fmtEGP(cur.talNet),  sub: 'Gross: ' + fmtEGP(cur.talGross) },
      { label: 'Avg Daily Revenue',    value: fmtEGP(avgDaily),    sub: enriched.length + ' operating days' },
      { label: 'Best Day Revenue',     value: highest ? fmtEGP(highest.total) : '—', sub: highest ? fmtDate(highest.date) : '' },
    ],
    chartData: enriched.slice(-20).map(r => ({ label: r.date.slice(5), value: r.total })),
    summary,
    tableHeaders: ['Date', 'Cash', 'Visa', 'Talabat Gross', 'Talabat Net', 'Total'],
    tableColWidths: [68, 72, 72, 80, 78, 80],
    tableAlign:   ['left', 'right', 'right', 'right', 'right', 'right'],
    tableRows: enriched.map(r => [
      fmtDate(r.date),
      fmtEGP(r.revenue_cash),
      fmtEGP(r.revenue_visa),
      fmtEGP(r.revenue_talabat_gross),
      fmtEGP(r.talabat_net),
      fmtEGP(r.total),
    ]),
    tableTotals: ['TOTALS', fmtEGP(cur.cash), fmtEGP(cur.visa), fmtEGP(cur.talGross), fmtEGP(cur.talNet), fmtEGP(cur.total)],
    tableNote: 'Total = Cash + Visa + Talabat Net (after ' + Math.round(rate * 100) + '% platform commission). Gross shown for reference.',
    rate,
  };
}

// ── Expenses ──────────────────────────────────────────────────────────────────

function getExpensesData(brandId, startDate, endDate) {
  const rows = db.db.prepare(
    'SELECT * FROM fb_daily_expenses WHERE brand_id=? AND date>=? AND date<=? ORDER BY date, id'
  ).all(brandId, startDate, endDate);

  const { start: ps, end: pe } = prevPeriod(startDate, endDate);
  const prevRows = db.db.prepare(
    'SELECT * FROM fb_daily_expenses WHERE brand_id=? AND date>=? AND date<=?'
  ).all(brandId, ps, pe);

  const total     = rows.reduce((a, r) => a + (r.amount || 0), 0);
  const prevTotal = prevRows.reduce((a, r) => a + (r.amount || 0), 0);
  const chg       = pctChange(total, prevTotal);

  const byCategory = {};
  rows.forEach(r => { byCategory[r.category] = (byCategory[r.category] || 0) + (r.amount || 0); });
  const sortedCats = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  const topCat = sortedCats[0];

  const byDate = {};
  rows.forEach(r => { byDate[r.date] = (byDate[r.date] || 0) + (r.amount || 0); });
  const activeDays = Object.keys(byDate).length;
  const avgDaily   = activeDays ? Math.round(total / activeDays) : 0;

  const cashTotal  = rows.filter(r => r.payment_method === 'Cash').reduce((a, r) => a + (r.amount || 0), 0);
  const largest    = [...rows].sort((a, b) => (b.amount || 0) - (a.amount || 0))[0];
  const highestDay = Object.entries(byDate).sort((a, b) => b[1] - a[1])[0];

  let summary;
  if (!rows.length) {
    summary = `No expense records were found between ${fmtDate(startDate)} and ${fmtDate(endDate)}.`;
  } else {
    summary = `Total expenses for ${fmtPeriod(startDate, endDate)} were ${fmtEGP(total)} across ${rows.length} entr${rows.length !== 1 ? 'ies' : 'y'} and ${activeDays} active day${activeDays !== 1 ? 's' : ''}, averaging ${fmtEGP(avgDaily)} per day. `;
    if (topCat) summary += `${topCat[0]} was the largest spending category at ${fmtEGP(topCat[1])} (${total ? Math.round(topCat[1] / total * 100) : 0}% of total). `;
    if (highestDay) summary += `The most expensive day was ${fmtDate(highestDay[0])} with ${fmtEGP(highestDay[1])}. `;
    summary += chg != null
      ? (chg >= 0 ? `Expenses increased by ${chg.toFixed(1)}%` : `Expenses decreased by ${Math.abs(chg).toFixed(1)}%`) + ` vs the previous equivalent period.`
      : 'No previous-period comparison is available.';
  }

  return {
    type: 'expenses', title: 'Daily Expenses Report',
    startDate, endDate,
    rows, total, prevTotal, prevPeriod: { start: ps, end: pe }, pctChange: chg,
    kpis: [
      { label: 'Total Expenses',     value: fmtEGP(total),                          sub: chg != null ? (chg >= 0 ? '▲ ' : '▼ ') + Math.abs(chg).toFixed(1) + '% vs prev period' : 'No prev-period data', subOk: chg == null ? null : chg <= 0 },
      { label: 'Avg Daily Expense',  value: fmtEGP(avgDaily),                       sub: activeDays + ' days with expenses' },
      { label: 'No. of Entries',     value: String(rows.length),                    sub: activeDays + ' active days' },
      { label: 'Top Category',       value: topCat ? topCat[0] : '—',              sub: topCat ? fmtEGP(topCat[1]) : '' },
      { label: 'Cash Expenses',      value: fmtEGP(cashTotal),                      sub: total ? Math.round(cashTotal / total * 100) + '% of total' : '—' },
      { label: 'Largest Entry',      value: largest ? fmtEGP(largest.amount) : '—', sub: largest ? (largest.item || largest.category) : '' },
    ],
    chartData: sortedCats.slice(0, 8).map(([label, value]) => ({ label, value })),
    chartTitle: 'Expense Breakdown by Category',
    summary,
    tableHeaders: ['Date', 'Category', 'Item / Description', 'Method', 'Amount'],
    tableColWidths: [68, 90, 160, 70, 80],
    tableAlign:   ['left', 'left', 'left', 'left', 'right'],
    tableRows: rows.map(r => [
      fmtDate(r.date),
      r.category || '—',
      r.item || r.notes || '—',
      r.payment_method || '—',
      fmtEGP(r.amount),
    ]),
    tableTotals: ['TOTALS', '', '', '', fmtEGP(total)],
    tableNote: null,
  };
}

// ── Transfers ─────────────────────────────────────────────────────────────────

function getTransfersData(brandId, startDate, endDate) {
  const rows = db.db.prepare(
    'SELECT * FROM fb_bank_transfers WHERE brand_id=? AND date_received>=? AND date_received<=? ORDER BY date_received, id'
  ).all(brandId, startDate, endDate);

  const total = rows.reduce((a, r) => a + (r.amount_received || 0), 0);
  const bySource = {};
  rows.forEach(r => { const s = r.source || 'Other'; bySource[s] = (bySource[s] || 0) + (r.amount_received || 0); });

  const cashDep  = bySource['Cash Deposit']   || 0;
  const visaSett = bySource['Visa Settlement'] || 0;
  const talPay   = bySource['Talabat Payout'] || 0;
  const sortedSrc = Object.entries(bySource).sort((a, b) => b[1] - a[1]);
  const topSource = sortedSrc[0];

  let summary;
  if (!rows.length) {
    summary = `No bank transfer records were found between ${fmtDate(startDate)} and ${fmtDate(endDate)}.`;
  } else {
    summary = `A total of ${fmtEGP(total)} was transferred to bank accounts across ${rows.length} record${rows.length !== 1 ? 's' : ''} during ${fmtPeriod(startDate, endDate)}. `;
    if (topSource) summary += `${topSource[0]} was the largest transfer category at ${fmtEGP(topSource[1])} (${total ? Math.round(topSource[1] / total * 100) : 0}% of total). `;
    if (cashDep === 0 && visaSett === 0 && talPay === 0) {
      summary += 'No standard channel transfers (Cash Deposit, Visa Settlement, Talabat Payout) were recorded in this period.';
    }
  }

  return {
    type: 'transfers', title: 'Bank Transfers Report',
    startDate, endDate, rows, total,
    kpis: [
      { label: 'Total Transferred',   value: fmtEGP(total),      sub: rows.length + ' records' },
      { label: 'Cash Deposits',        value: fmtEGP(cashDep),   sub: total ? Math.round(cashDep / total * 100) + '% of total' : '—' },
      { label: 'Visa Settlements',     value: fmtEGP(visaSett),  sub: total ? Math.round(visaSett / total * 100) + '% of total' : '—' },
      { label: 'Talabat Payouts',      value: fmtEGP(talPay),    sub: total ? Math.round(talPay / total * 100) + '% of total' : '—' },
    ],
    chartData: sortedSrc.slice(0, 6).map(([label, value]) => ({ label, value })),
    chartTitle: 'Transfers by Source',
    summary,
    tableHeaders: ['Transfer Date', 'Type / Source', 'Coverage Period', 'Amount', 'Reference'],
    tableColWidths: [72, 100, 140, 82, 121],
    tableAlign:    ['left', 'left', 'left', 'right', 'left'],
    tableRows: rows.map(r => [
      fmtDate(r.date_received),
      r.source || '—',
      r.period_from && r.period_to ? fmtDate(r.period_from) + ' – ' + fmtDate(r.period_to) : '—',
      fmtEGP(r.amount_received),
      r.reference || r.notes || '—',
    ]),
    tableTotals: ['TOTALS', '', '', fmtEGP(total), ''],
    tableNote: null,
  };
}

// ── Cash Drawer ───────────────────────────────────────────────────────────────

function getCashDrawerData(brandId, startDate, endDate) {
  const rate = getTalabatRate(brandId);
  const rows = db.db.prepare(
    'SELECT * FROM fb_cash_drawer_check WHERE brand_id=? AND date>=? AND date<=? ORDER BY date'
  ).all(brandId, startDate, endDate);

  const revRows  = db.db.prepare('SELECT * FROM fb_daily_revenue WHERE brand_id=? AND date>=? AND date<=?').all(brandId, startDate, endDate);
  const expRows  = db.db.prepare("SELECT * FROM fb_daily_expenses WHERE brand_id=? AND date>=? AND date<=? AND payment_method='Cash'").all(brandId, startDate, endDate);
  const xfers    = db.db.prepare("SELECT * FROM fb_bank_transfers WHERE brand_id=? AND date_received>=? AND date_received<=? AND source='Cash Deposit'").all(brandId, startDate, endDate);

  const enriched = rows.map(row => {
    const rev     = revRows.find(r => r.date === row.date);
    const cashRev = rev ? (rev.revenue_cash || 0) : 0;
    const cashExp = expRows.filter(e => e.date === row.date).reduce((a, e) => a + (e.amount || 0), 0);
    const cashOut = xfers.filter(t => t.date_received === row.date).reduce((a, t) => a + (t.amount_received || 0), 0);
    const expected = (row.opening_cash || 0) + cashRev - cashExp - cashOut;
    const variance = row.actual_counted_cash !== null ? row.actual_counted_cash - expected : null;
    const status   = variance === null ? 'Not Counted' : Math.abs(variance) < 1 ? 'Balanced' : variance > 0 ? 'Overage' : 'Shortage';
    return { date: row.date, opening: row.opening_cash, cashSales: cashRev, cashExp, cashOut, expected, actual: row.actual_counted_cash, variance, status };
  });

  const counted      = enriched.filter(r => r.variance !== null);
  const totalVar     = counted.reduce((a, r) => a + r.variance, 0);
  const discrepDays  = counted.filter(r => Math.abs(r.variance) >= 1);
  const largestDisc  = [...discrepDays].sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))[0];
  const overageDays  = counted.filter(r => r.variance > 1).length;
  const shortageDays = counted.filter(r => r.variance < -1).length;
  const balancedDays = counted.filter(r => Math.abs(r.variance) < 1).length;

  let summary;
  if (!rows.length) {
    summary = `No cash drawer records were found between ${fmtDate(startDate)} and ${fmtDate(endDate)}.`;
  } else if (!counted.length) {
    summary = `${rows.length} cash drawer record${rows.length !== 1 ? 's' : ''} were found but none had a physical count completed. Please complete daily cash counts to enable reconciliation.`;
  } else {
    const overallStatus = Math.abs(totalVar) < 1 ? 'balanced' : totalVar > 0 ? 'net overage' : 'net shortage';
    summary = `Cash drawer reconciliation for ${fmtPeriod(startDate, endDate)}: ${counted.length} day${counted.length !== 1 ? 's' : ''} counted. `;
    summary += `Overall status is ${overallStatus} (${totalVar >= 0 ? '+' : ''}${fmtEGP(totalVar)}). `;
    summary += `${balancedDays} day${balancedDays !== 1 ? 's' : ''} balanced, ${shortageDays} shortage${shortageDays !== 1 ? 's' : ''}, ${overageDays} overage${overageDays !== 1 ? 's' : ''}. `;
    if (largestDisc) summary += `Largest discrepancy was ${fmtDate(largestDisc.date)} (${largestDisc.variance > 0 ? '+' : ''}${fmtEGP(largestDisc.variance)} ${largestDisc.status.toLowerCase()}).`;
  }

  return {
    type: 'cash-drawer', title: 'Cash Drawer Reconciliation Report',
    startDate, endDate, rows: enriched,
    kpis: [
      { label: 'Days Checked',        value: String(enriched.length),      sub: counted.length + ' with physical count' },
      { label: 'Days with Variance',  value: String(discrepDays.length),   sub: discrepDays.length ? 'Requires attention' : 'All clear', subOk: discrepDays.length === 0 ? true : false },
      { label: 'Total Variance',      value: fmtEGP(totalVar),             sub: totalVar > 0 ? 'Net overage' : totalVar < 0 ? 'Net shortage' : 'Balanced', subOk: totalVar === 0 ? true : totalVar > 0 ? null : false },
      { label: 'Balanced Days',       value: String(balancedDays),         sub: 'of ' + counted.length + ' counted' },
      { label: 'Shortage Days',       value: String(shortageDays),         sub: shortageDays ? 'Cash missing' : 'None', subOk: shortageDays === 0 ? true : false },
      { label: 'Largest Discrepancy', value: largestDisc ? fmtEGP(largestDisc.variance) : 'None', sub: largestDisc ? fmtDate(largestDisc.date) : '' },
    ],
    chartData: null,
    summary,
    tableHeaders: ['Date', 'Opening', 'Cash Sales', 'Cash Exp.', 'Expected', 'Actual', 'Variance', 'Status'],
    tableColWidths: [58, 58, 58, 58, 62, 62, 62, 62],
    tableAlign:    ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'center'],
    tableRows: enriched.map(r => [
      fmtDate(r.date),
      r.opening != null ? fmtEGP(r.opening) : '—',
      fmtEGP(r.cashSales),
      r.cashExp ? fmtEGP(r.cashExp) : '—',
      fmtEGP(r.expected),
      r.actual != null ? fmtEGP(r.actual) : 'Not counted',
      r.variance != null ? (r.variance >= 0 ? '+' : '') + fmtEGP(r.variance) : '—',
      r.status,
    ]),
    tableTotals: ['TOTALS', '', '', '', '', '', (totalVar >= 0 ? '+' : '') + fmtEGP(totalVar), counted.length + ' counted'],
    tableNote: 'Formula: Expected = Opening + Cash Sales − Cash Expenses − Cash Deposits. Variance = Actual − Expected.',
    _stats: { totalVar, overageDays, shortageDays, balancedDays, discrepDays: discrepDays.length },
  };
}

// ── Inventory ─────────────────────────────────────────────────────────────────

function getInventoryData(brandId, startDate, endDate) {
  const rows = db.db.prepare(
    'SELECT * FROM fb_inventory_check WHERE brand_id=? AND date>=? AND date<=? ORDER BY date, id'
  ).all(brandId, startDate, endDate);

  const enriched = rows.map(r => {
    const variance = (r.physical_count != null && r.system_count != null) ? r.physical_count - r.system_count : null;
    const status   = variance === null ? 'Not Counted' : variance === 0 ? 'Matched' : variance > 0 ? 'Overage' : 'Shortage';
    return { ...r, variance, status };
  });

  const withVar    = enriched.filter(r => r.variance !== null);
  const shortages  = withVar.filter(r => r.variance < 0);
  const overages   = withVar.filter(r => r.variance > 0);
  const matched    = withVar.filter(r => r.variance === 0);
  const largestSh  = [...shortages].sort((a, b) => a.variance - b.variance)[0];
  const largestOv  = [...overages].sort((a, b) => b.variance - a.variance)[0];

  // Unique items
  const byItem = {};
  enriched.forEach(r => {
    const k = (r.item || '').trim().toLowerCase();
    if (!k) return;
    if (!byItem[k]) byItem[k] = { name: r.item, unit: r.unit, variances: [] };
    if (r.variance !== null) byItem[k].variances.push(r.variance);
  });

  let summary;
  if (!enriched.length) {
    summary = `No inventory checks were recorded between ${fmtDate(startDate)} and ${fmtDate(endDate)}.`;
  } else {
    const uniqueItems = Object.keys(byItem).length;
    summary = `${enriched.length} inventory check${enriched.length !== 1 ? 's' : ''} were recorded for ${uniqueItems} unique item${uniqueItems !== 1 ? 's' : ''} during ${fmtPeriod(startDate, endDate)}. `;
    summary += `Of ${withVar.length} counted entries: ${matched.length} matched, ${shortages.length} short${shortages.length !== 1 ? 'ages' : 'age'}, ${overages.length} overage${overages.length !== 1 ? 's' : ''}. `;
    if (largestSh) summary += `Largest shortage: ${largestSh.item} (${largestSh.variance} ${largestSh.unit || 'units'} on ${fmtDate(largestSh.date)}). `;
    if (largestOv) summary += `Largest overage: ${largestOv.item} (+${largestOv.variance} ${largestOv.unit || 'units'} on ${fmtDate(largestOv.date)}).`;
  }

  // Sort display: largest discrepancies first
  const displayRows = [...enriched].sort((a, b) => {
    if (a.variance === null && b.variance === null) return 0;
    if (a.variance === null) return 1;
    if (b.variance === null) return -1;
    return Math.abs(b.variance) - Math.abs(a.variance);
  });

  return {
    type: 'inventory', title: 'Inventory Variance Report',
    startDate, endDate, rows: enriched,
    kpis: [
      { label: 'Checks Recorded',  value: String(enriched.length),   sub: Object.keys(byItem).length + ' unique items' },
      { label: 'Matched',          value: String(matched.length),     sub: 'No variance', subOk: true },
      { label: 'Shortages',        value: String(shortages.length),   sub: shortages.length ? 'Stock missing' : 'None', subOk: shortages.length === 0 ? true : false },
      { label: 'Overages',         value: String(overages.length),    sub: overages.length ? 'More than expected' : 'None', subOk: null },
      { label: 'Largest Shortage', value: largestSh ? String(largestSh.variance) + ' ' + (largestSh.unit || 'units') : '—', sub: largestSh ? largestSh.item : '' },
      { label: 'Largest Overage',  value: largestOv ? '+' + largestOv.variance + ' ' + (largestOv.unit || 'units') : '—', sub: largestOv ? largestOv.item : '' },
    ],
    chartData: null,
    summary,
    tableHeaders: ['Date', 'Item', 'Unit', 'System Qty', 'Physical Qty', 'Variance', 'Status'],
    tableColWidths: [68, 130, 50, 68, 74, 65, 65],
    tableAlign:    ['left', 'left', 'left', 'right', 'right', 'right', 'center'],
    tableRows: displayRows.map(r => [
      fmtDate(r.date),
      r.item || '—',
      r.unit || '—',
      r.system_count != null ? String(r.system_count) : '—',
      r.physical_count != null ? String(r.physical_count) : 'Not counted',
      r.variance != null ? (r.variance > 0 ? '+' : '') + r.variance : '—',
      r.status,
    ]),
    tableTotals: null,
    tableNote: 'Variance = Physical Qty − System Qty. Rows sorted by largest discrepancy first.',
    _stats: { shortages: shortages.length, overages: overages.length, matched: matched.length },
  };
}

// ── Improved CSV ──────────────────────────────────────────────────────────────

function buildCSV(data) {
  const escape = v => {
    if (v == null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [];
  lines.push(data.tableHeaders.map(escape).join(','));
  data.tableRows.forEach(row => lines.push(row.map(escape).join(',')));
  if (data.tableTotals) lines.push(data.tableTotals.map(escape).join(','));
  return '﻿' + lines.join('\r\n'); // BOM for Excel UTF-8
}

function safeFilename(brandName, reportType, startDate, endDate) {
  const slug = (brandName || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const type = reportType.replace(/_/g, '-');
  return `${slug}-${type}-${startDate}-to-${endDate}.pdf`;
}

function safeCSVFilename(brandName, reportType, startDate, endDate) {
  const slug = (brandName || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const type = reportType.replace(/_/g, '-');
  return `${slug}-${type}-${startDate}-to-${endDate}.csv`;
}

module.exports = {
  getRevenueData,
  getExpensesData,
  getTransfersData,
  getCashDrawerData,
  getInventoryData,
  buildCSV,
  safeFilename,
  safeCSVFilename,
  fmtDate,
  fmtPeriod,
  fmtEGP,
};
