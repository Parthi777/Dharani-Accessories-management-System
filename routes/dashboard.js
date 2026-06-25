// routes/dashboard.js — KPIs, charts, recent activity, and KPI drill-downs
const express = require('express');
const store = require('../lib/store');
const { today, dateDaysAgo } = require('../lib/util');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const n = v => Number(v || 0);

function effBranch(req) {
  let branch = req.query.branch;
  if (req.user.role !== 'Admin' && req.user.branch && req.user.branch !== 'ALL') branch = req.user.branch;
  return (branch && branch !== 'ALL') ? branch : null;
}
const inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to);

function sum(arr, f) { return arr.reduce((a, x) => a + n(f(x)), 0); }
function groupSum(arr, keyFn, valFn) {
  const m = new Map();
  for (const x of arr) { const k = keyFn(x); m.set(k, n(m.get(k)) + n(valFn(x))); }
  return m;
}

// GET /api/dashboard?branch=&from=&to= → KPIs + charts + recent
router.get('/', (req, res) => {
  try {
    const branch = effBranch(req);
    const { from, to } = req.query;
    const lowThr = parseInt(store.getSetting('LOW_STOCK_THRESHOLD', '5'));
    const deadDays = parseInt(store.getSetting('DEAD_STOCK_DAYS', '90'));
    const t = today();
    const month = t.slice(0, 7);

    const allSales = store.all('sales').filter(s => !branch || s.branch === branch);
    const rangeSales = allSales.filter(s => inRange(s.sale_date, from, to));

    const stockRows = store.stockWithQty(branch);
    const deadCutoff = dateDaysAgo(deadDays);
    const lastSaleByPart = new Map();
    for (const s of store.all('sales')) {
      const prev = lastSaleByPart.get(s.part_name);
      if (!prev || s.sale_date > prev) lastSaleByPart.set(s.part_name, s.sale_date);
    }

    const kpis = {
      today_sales: sum(allSales.filter(s => s.sale_date === t), s => s.sale_value),
      monthly_sales: sum(allSales.filter(s => String(s.sale_date).startsWith(month)), s => s.sale_value),
      total_sales: sum(rangeSales, s => s.sale_value),
      gross_profit: sum(rangeSales, s => s.gross_profit),
      qty_sold: sum(rangeSales, s => s.qty),
      transactions: rangeSales.length,
      stock_value: sum(stockRows, s => n(s.current_qty) * n(s.cost_price)),
      low_stock: stockRows.filter(s => n(s.current_qty) <= lowThr && n(s.current_qty) > 0).length,
      out_of_stock: stockRows.filter(s => n(s.current_qty) <= 0).length,
      dead_stock: stockRows.filter(s => {
        const last = lastSaleByPart.get(s.part_name);
        return !last || last < deadCutoff;
      }).length,
    };

    // Charts
    const since = dateDaysAgo(13);
    const trendMap = groupSum(allSales.filter(s => s.sale_date >= since), s => s.sale_date, s => s.sale_value);
    const trend = [...trendMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, value]) => ({ date, value }));

    const byBranch = [...groupSum(rangeSales, s => s.branch, s => s.sale_value).entries()]
      .map(([b, value]) => ({ branch: b, value })).sort((a, b) => b.value - a.value);

    const partAgg = new Map();
    for (const s of rangeSales) {
      const e = partAgg.get(s.part_name) || { qty: 0, value: 0 };
      e.qty += n(s.qty); e.value += n(s.sale_value); partAgg.set(s.part_name, e);
    }
    const topParts = [...partAgg.entries()].map(([part, e]) => ({ part, qty: e.qty, value: e.value }))
      .sort((a, b) => b.value - a.value).slice(0, 8);

    const recent = allSales
      .sort((a, b) => (b.sale_date + (b.created_at || '')).localeCompare(a.sale_date + (a.created_at || '')))
      .slice(0, 10)
      .map(s => ({ id: s.id, sale_date: s.sale_date, branch: s.branch, part_name: s.part_name, qty: s.qty, sale_value: s.sale_value, invoice_no: s.invoice_no }));

    res.json({ ok: true, data: { kpis, charts: { trend, byBranch, topParts }, recent } });
  } catch (e) {
    console.error('dashboard error', e); res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

// GET /api/dashboard/drill/:type?branch=&from=&to= → table data for a KPI
router.get('/drill/:type', (req, res) => {
  try {
    const { type } = req.params;
    const { from, to } = req.query;
    const branch = effBranch(req);
    const lowThr = parseInt(store.getSetting('LOW_STOCK_THRESHOLD', '5'));
    const deadDays = parseInt(store.getSetting('DEAD_STOCK_DAYS', '90'));
    const t = today();

    const branchSales = store.all('sales').filter(s => !branch || s.branch === branch);
    const sel = s => ({ id: s.id, sale_date: s.sale_date, branch: s.branch, part_name: s.part_name,
      qty: s.qty, unit_price: s.unit_price, sale_value: s.sale_value, gross_profit: s.gross_profit, invoice_no: s.invoice_no });
    const byDateDesc = (a, b) => (b.sale_date + (b.created_at || '')).localeCompare(a.sale_date + (a.created_at || ''));

    let rows = [];
    switch (type) {
      case 'today_sales':
        rows = branchSales.filter(s => s.sale_date === t).sort(byDateDesc).map(sel); break;
      case 'monthly_sales':
        rows = branchSales.filter(s => String(s.sale_date).startsWith(t.slice(0, 7))).sort(byDateDesc).map(sel); break;
      case 'total_sales':
      case 'gross_profit':
      case 'qty_sold':
      case 'transactions':
        rows = branchSales.filter(s => inRange(s.sale_date, from, to)).sort(byDateDesc).slice(0, 1000).map(sel); break;
      case 'branch_sales': {
        const m = new Map();
        for (const s of branchSales.filter(s => inRange(s.sale_date, from, to))) {
          const e = m.get(s.branch) || { branch: s.branch, transactions: 0, qty: 0, sale_value: 0, gross_profit: 0 };
          e.transactions++; e.qty += n(s.qty); e.sale_value += n(s.sale_value); e.gross_profit += n(s.gross_profit);
          m.set(s.branch, e);
        }
        rows = [...m.values()].sort((a, b) => b.sale_value - a.sale_value); break;
      }
      case 'stock_value':
      case 'low_stock':
      case 'dead_stock': {
        const stockRows = store.stockWithQty(branch).map(s => ({
          vehicle: s.vehicle, part_name: s.part_name, part_no: s.part_no,
          cost_price: s.cost_price, unit_price: s.unit_price,
          qty: s.current_qty, value: n(s.current_qty) * n(s.cost_price),
        }));
        if (type === 'stock_value') {
          rows = stockRows.sort((a, b) => b.value - a.value);
        } else if (type === 'low_stock') {
          rows = stockRows.filter(s => n(s.qty) <= lowThr).sort((a, b) => n(a.qty) - n(b.qty));
        } else {
          const lastByPart = new Map();
          for (const s of store.all('sales')) {
            const prev = lastByPart.get(s.part_name);
            if (!prev || s.sale_date > prev) lastByPart.set(s.part_name, s.sale_date);
          }
          const cutoff = dateDaysAgo(deadDays);
          rows = stockRows.map(s => ({ ...s, last_sale: lastByPart.get(s.part_name) || '' }))
            .filter(s => !s.last_sale || s.last_sale < cutoff)
            .sort((a, b) => (a.last_sale || '').localeCompare(b.last_sale || ''));
        }
        break;
      }
      default:
        return res.status(400).json({ ok: false, msg: 'Unknown drill type' });
    }
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('drill error', e); res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

module.exports = router;
