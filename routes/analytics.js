// routes/analytics.js — full analytics breakdown
const express = require('express');
const store = require('../lib/store');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const n = v => Number(v || 0);
const inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to);

// Group sales rows and aggregate qty/sales/profit (+optional txns) by a key.
function groupBy(rows, keyFn, { txns = false } = {}) {
  const m = new Map();
  for (const s of rows) {
    const k = keyFn(s);
    const e = m.get(k) || { qty: 0, sales: 0, profit: 0, txns: 0 };
    e.qty += n(s.qty); e.sales += n(s.sale_value); e.profit += n(s.gross_profit); e.txns += 1;
    m.set(k, e);
  }
  return [...m.entries()].map(([k, e]) => {
    const o = { qty: e.qty, sales: e.sales, profit: e.profit };
    if (txns) o.txns = e.txns;
    return [k, o];
  });
}

// GET /api/analytics?branch=&from=&to= → breakdowns by part, vehicle, branch, source, month, staff
router.get('/', (req, res) => {
  try {
    let branch = req.query.branch;
    if (req.user.role !== 'Admin' && req.user.branch && req.user.branch !== 'ALL') branch = req.user.branch;
    const { from, to, vehicle } = req.query;

    const sourceByPart = new Map(store.all('stock').map(s => [s.part_name, s.source]));
    const rows = store.all('sales').filter(s =>
      (!branch || branch === 'ALL' || s.branch === branch) &&
      (!vehicle || vehicle === 'ALL' || s.vehicle === vehicle) &&
      inRange(s.sale_date, from, to));

    const byPart = groupBy(rows, s => s.part_name)
      .map(([part_name, e]) => ({ part_name, ...e })).sort((a, b) => b.sales - a.sales).slice(0, 50);
    const byVehicle = groupBy(rows, s => s.vehicle)
      .map(([vehicle, e]) => ({ vehicle, ...e })).sort((a, b) => b.sales - a.sales);
    const byBranch = groupBy(rows, s => s.branch, { txns: true })
      .map(([branch, e]) => ({ branch, ...e })).sort((a, b) => b.sales - a.sales);
    const bySource = groupBy(rows, s => sourceByPart.get(s.part_name) || 'Unknown')
      .map(([source, e]) => ({ source, qty: e.qty, sales: e.sales })).sort((a, b) => b.sales - a.sales);
    const byMonth = groupBy(rows, s => String(s.sale_date).slice(0, 7))
      .map(([month, e]) => ({ month, sales: e.sales, profit: e.profit, qty: e.qty })).sort((a, b) => a.month.localeCompare(b.month));
    const staff = groupBy(rows, s => s.staff_email || '—', { txns: true })
      .map(([staff_email, e]) => ({ staff_email, txns: e.txns, sales: e.sales })).sort((a, b) => b.sales - a.sales).slice(0, 20);

    const totals = {
      sales: rows.reduce((a, s) => a + n(s.sale_value), 0),
      profit: rows.reduce((a, s) => a + n(s.gross_profit), 0),
      qty: rows.reduce((a, s) => a + n(s.qty), 0),
      txns: rows.length,
    };

    res.json({ ok: true, data: { totals, byPart, byVehicle, byBranch, bySource, byMonth, staff } });
  } catch (e) {
    console.error('analytics error', e); res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

module.exports = router;
