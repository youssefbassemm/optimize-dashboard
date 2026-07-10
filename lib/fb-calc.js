'use strict';

const { PEAK_WEEKDAYS, SEASON } = require('./fb-config');

// All dates are plain YYYY-MM-DD strings, compared/parsed at UTC noon to dodge DST

function toDateUTC(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`);
}

function formatDateUTC(d) {
  return d.toISOString().slice(0, 10);
}

function todayStr() {
  return formatDateUTC(new Date());
}

function addDays(dateStr, n) {
  const d = toDateUTC(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return formatDateUTC(d);
}

function daysBetweenInclusive(startStr, endStr) {
  const start = toDateUTC(startStr).getTime();
  const end   = toDateUTC(endStr).getTime();
  return Math.round((end - start) / 86400000) + 1;
}

function weekdayOf(dateStr) {
  return toDateUTC(dateStr).getUTCDay(); // 0=Sun..6=Sat
}

function dayOfMonth(dateStr) {
  return toDateUTC(dateStr).getUTCDate();
}

function isPeakNight(dateStr) {
  return PEAK_WEEKDAYS.includes(weekdayOf(dateStr));
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}

// --- revenue ---

function talabatBreakdown(gross, rate) {
  const commission = gross * rate;
  const net = gross - commission;
  return { commission, net };
}

function totalRevenueForDay(rev, rate) {
  const { net } = talabatBreakdown(rev.revenue_talabat_gross, rate);
  return rev.revenue_cash + rev.revenue_visa + net;
}

// --- recurring expenses ---

function isRecurringDueToday(exp, dateStr) {
  if (!exp.active) return false;
  switch (exp.frequency) {
    case 'Daily':
    case 'Percent of Sales':
      return true;
    case 'Weekly':
      return weekdayOf(dateStr) === exp.weekly_due_day;
    case 'Monthly':
      return dayOfMonth(dateStr) === exp.monthly_due_date;
    default:
      return false;
  }
}

function recurringDueAmount(exp, todaysTotalRevenue) {
  if (exp.frequency === 'Percent of Sales') {
    return todaysTotalRevenue * (exp.percent_rate != null ? exp.percent_rate : 0);
  }
  return exp.amount != null ? exp.amount : 0;
}

// --- cash drawer ---

function expectedClosingCash(opening, cashRevenue, cashExpensesPaidOut, cashTransferredOut) {
  return opening + cashRevenue - cashExpensesPaidOut - cashTransferredOut;
}

function cashVariance(actual, expected) {
  return actual - expected;
}

// --- bank transfers ---

function expectedTransferAmount(source, revenueRows, talabatRate) {
  switch (source) {
    case 'Cash Deposit':
      return sum(revenueRows.map(r => r.revenue_cash));
    case 'Visa Settlement':
      return sum(revenueRows.map(r => r.revenue_visa));
    case 'Talabat Payout':
      return sum(revenueRows.map(r => talabatBreakdown(r.revenue_talabat_gross, talabatRate).net));
    default:
      return 0;
  }
}

// --- setup cost recovery ---

function setupCostRecoveredPercent(netCashGenerated, totalSetupCost) {
  if (totalSetupCost <= 0) return 0;
  const pct = Math.max(0, netCashGenerated) / totalSetupCost;
  return clamp(pct, 0, 1) * 100;
}

// --- inventory ---

function inventoryVariance(system, physical) {
  if (system === null || physical === null) return null;
  return physical - system;
}

function inventoryVariancePercent(system, physical) {
  if (system === null || physical === null || system === 0) return null;
  return (physical - system) / system;
}

// --- season ---

function seasonProgress(today) {
  const totalDays  = daysBetweenInclusive(SEASON.START, SEASON.END);
  const rawElapsed = daysBetweenInclusive(SEASON.START, today);
  const elapsed    = clamp(rawElapsed, 0, totalDays);
  const remaining  = totalDays - elapsed;
  const percent    = (elapsed / totalDays) * 100;
  return { totalDays, elapsed, remaining, percent };
}

function fmtEGP(n) {
  const rounded = Math.round(n * 100) / 100;
  return `EGP ${rounded.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function fmtPercent(n) {
  return `${(Math.round(n * 10) / 10).toLocaleString('en-US')}%`;
}

module.exports = {
  toDateUTC,
  formatDateUTC,
  todayStr,
  addDays,
  daysBetweenInclusive,
  weekdayOf,
  dayOfMonth,
  isPeakNight,
  clamp,
  sum,
  talabatBreakdown,
  totalRevenueForDay,
  isRecurringDueToday,
  recurringDueAmount,
  expectedClosingCash,
  cashVariance,
  expectedTransferAmount,
  setupCostRecoveredPercent,
  inventoryVariance,
  inventoryVariancePercent,
  seasonProgress,
  fmtEGP,
  fmtPercent,
};
