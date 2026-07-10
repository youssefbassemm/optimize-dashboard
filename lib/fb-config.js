'use strict';

const SEASON = {
  START: '2026-06-01',
  END:   '2026-09-30',
};

const PEAK_WEEKDAYS = [4, 5, 6]; // Thu, Fri, Sat (0=Sun..6=Sat)

const DEFAULT_TALABAT_COMMISSION_RATE = 0.13;

const EXPENSE_CATEGORIES_DAILY = [
  'Food Cost/Supplies',
  'Packaging',
  'Recurring',
  'Staff Wages',
  'Staff Meals',
  'Maintenance',
  'Marketing',
  'Transport/Delivery',
  'Ice/Beverages Restock',
  'Other',
];

const SETUP_EXPENSE_CATEGORIES = [
  'Equipment',
  'Fit-out & Signage',
  'Initial Inventory',
  'Licensing & Permits',
  'Packaging Stock',
  'Staff Uniforms',
  'POS & Software',
  'Deposit',
  'Other',
];

const PAYMENT_METHODS = ['Cash', 'Visa', 'Transfer'];

const TRANSFER_SOURCES = [
  'Cash Deposit',
  'Visa Settlement',
  'Talabat Payout',
  'Instapay',
  'Other',
];

const RECURRING_FREQUENCIES = ['Daily', 'Weekly', 'Monthly', 'Percent of Sales'];

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

module.exports = {
  SEASON,
  PEAK_WEEKDAYS,
  DEFAULT_TALABAT_COMMISSION_RATE,
  EXPENSE_CATEGORIES_DAILY,
  SETUP_EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  TRANSFER_SOURCES,
  RECURRING_FREQUENCIES,
  WEEKDAY_LABELS,
};
