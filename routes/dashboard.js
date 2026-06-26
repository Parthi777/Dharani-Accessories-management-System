// routes/dashboard.js — KPIs, the 12 dashboard charts, live alerts, and
// drill-downs. All aggregation runs in JS over the in-memory store cache.
const express = require('express');
const store = require('../lib/store');
const { today, dateDaysAgo } = require('../lib/util');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const n = v => Number(v || 0);
const inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to);
const pk = (name, pno) => store.partKey(name, pno);

// ── Scope: branch lock + Sales_Staff personal-sales filter ──────────────────
function scope(req) {
  let branch = req.query.branch;
  if (req.user.role !== 'Admin' && req.user.branch && req.user.branch !== 'ALL') branch = req.user.branch;
  branch = (branch && branch !== 'ALL') ? branch : null;
  return { branch, mine: req.user.role === 'Sales_Staff', email: req.user.email };
}

// part key → { category, supplier, cost_price, vehicle }  (supplier is stored in stock.source)
function buildPartMeta() {
  const m = new Map();
  for (const s of store.all('stock')) {
    m.set(pk(s.part_name, s.part_no), {
      category: (s.category || '').trim() || 'Untagged',
      supplier: (s.source || '').trim() || 'Unassigned',
      cost_price: n(s.cost_price),
      vehicle: s.vehicle,
    });
  }
  return m;
}
const metaCat = (meta, s) => (meta.get(pk(s.part_name, s.part_no)) || {}).category || 'Untagged';

// Set of part keys belonging to `supplier` (the part's stock.source). null = no filter.
function partsForSupplier(supplier) {
  if (!supplier || supplier === 'ALL') return null;
  const set = new Set();
  for (const s of store.all('stock')) if ((s.source || '') === supplier) set.add(pk(s.part_name, s.part_no));
  return set;
}

// Apply branch + personal + category/supplier filters to sale rows.
function filterSales(rows, { branch, mine, email }, meta, f, supParts) {
  return rows.filter(s => {
    if (branch && s.branch !== branch) return false;
    if (mine && s.staff_email !== email) return false;
    if (f.category && f.category !== 'ALL' && metaCat(meta, s) !== f.category) return false;
    if (supParts && !supParts.has(pk(s.part_name, s.part_no))) return false;
    return true;
  });
}

// Apply branch + category/supplier to inward (purchase) rows. No personal filter.
function filterInward(rows, { branch }, meta, f, supParts) {
  return rows.filter(i => {
    if (branch && i.branch !== branch) return false;
    if (f.category && f.category !== 'ALL' && ((meta.get(pk(i.part_name, i.part_no)) || {}).category || 'Untagged') !== f.category) return false;
    if (supParts && !supParts.has(pk(i.part_name, i.part_no))) return false;
    return true;
  });
}

// Stock rows (with current qty) filtered by category/supplier.
function filterStock(branch, meta, f, supParts) {
  return store.stockWithQty(branch).filter(s => {
    if (f.category && f.category !== 'ALL' && ((s.category || '').trim() || 'Untagged') !== f.category) return false;
    if (supParts && !supParts.has(pk(s.part_name, s.part_no))) return false;
    return true;
  });
}

function groupSum(arr, keyFn, valFn) {
  const m = new Map();
  for (const x of arr) { const k = keyFn(x); m.set(k, n(m.get(k)) + n(valFn(x))); }
  return m;
}
const sum = (arr, f) => arr.reduce((a, x) => a + n(f(x)), 0);

// Bucket a YYYY-MM-DD date by granularity. Week label = that week's Monday.
function bucket(dateStr, gran) {
  const d = String(dateStr);
  if (gran === 'year') return d.slice(0, 4);
  if (gran === 'month') return d.slice(0, 7);
  if (gran === 'week') {
    const dt = new Date(d + 'T00:00:00');
    const off = (dt.getDay() + 6) % 7;          // Mon=0
    dt.setDate(dt.getDate() - off);
    return dt.toISOString().slice(0, 10);
  }
  return d; // day
}

function lastSaleByPartMap() {
  const m = new Map();
  for (const s of store.all('sales')) {
    const k = pk(s.part_name, s.part_no);
    const prev = m.get(k);
    if (!prev || s.sale_date > prev) m.set(k, s.sale_date);
  }
  return m;
}
function lastInwardByPartMap() {
  const m = new Map();
  for (const i of store.all('inward')) {
    const k = pk(i.part_name, i.part_no);
    const prev = m.get(k);
    if (!prev || i.inward_date > prev) m.set(k, i.inward_date);
  }
  return m;
}

// GET /api/dashboard?branch=&from=&to=&category=&supplier=&gran=
router.get('/', (req, res) => {
  try {
    const sc = scope(req);
    const { from, to, gran = 'day' } = req.query;
    const f = { category: req.query.category, supplier: req.query.supplier };
    const supParts = partsForSupplier(req.query.supplier);
    const meta = buildPartMeta();
    const lowThr = parseInt(store.getSetting('LOW_STOCK_THRESHOLD', '5'));
    const deadDays = parseInt(store.getSetting('DEAD_STOCK_DAYS', '90'));
    const t = today();
    const month = t.slice(0, 7);

    const allSales = filterSales(store.all('sales'), sc, meta, f, supParts);
    const rangeSales = allSales.filter(s => inRange(s.sale_date, from, to));
    const stockRows = filterStock(sc.branch, meta, f, supParts);
    const rangeInward = filterInward(store.all('inward'), sc, meta, f, supParts)
      .filter(i => inRange(i.inward_date, from, to));

    const lastSale = lastSaleByPartMap();
    const lastInward = lastInwardByPartMap();
    const deadCutoff = dateDaysAgo(deadDays);

    const distinctInvoices = rows => new Set(rows.filter(s => s.invoice_no).map(s => s.branch + '|' + s.invoice_no)).size;

    // ── 8 headline KPIs (+ extras kept for the secondary strip / alerts) ──────
    const kpis = {
      total_stock_items: sum(stockRows, s => s.current_qty),
      inventory_value: sum(stockRows, s => n(s.current_qty) * n(s.cost_price)),
      today_sales: sum(allSales.filter(s => s.sale_date === t), s => s.sale_value),
      monthly_sales: sum(allSales.filter(s => String(s.sale_date).startsWith(month)), s => s.sale_value),
      total_invoices: distinctInvoices(rangeSales),
      low_stock: stockRows.filter(s => n(s.current_qty) <= lowThr && n(s.current_qty) > 0).length,
      out_of_stock: stockRows.filter(s => n(s.current_qty) <= 0).length,
      active_branches: store.all('branches').filter(b => b.status === 'Active').length,
      // extras
      stock_value: sum(stockRows, s => n(s.current_qty) * n(s.cost_price)),
      total_sales: sum(rangeSales, s => s.sale_value),
      gross_profit: sum(rangeSales, s => s.gross_profit),
      qty_sold: sum(rangeSales, s => s.qty),
      transactions: rangeSales.length,
      dead_stock: stockRows.filter(s => { const l = lastSale.get(pk(s.part_name, s.part_no)); return !l || l < deadCutoff; }).length,
    };

    // ── Charts ────────────────────────────────────────────────────────────────
    // 1. Sales trend (bucketed by gran)
    const trend = [...groupSum(rangeSales, s => bucket(s.sale_date, gran), s => s.sale_value).entries()]
      .map(([label, value]) => ({ label, value })).sort((a, b) => a.label.localeCompare(b.label));

    // 2. Branch-wise sales
    const byBranch = [...groupSum(rangeSales, s => s.branch, s => s.sale_value).entries()]
      .map(([branch, value]) => ({ branch, value })).sort((a, b) => b.value - a.value);

    // 3. Monthly sales vs purchase (+ profit)
    const svp = new Map();
    const svpRow = m => svp.get(m) || svp.set(m, { month: m, sales: 0, purchase: 0, profit: 0 }).get(m);
    for (const s of rangeSales) { const e = svpRow(s.sale_date.slice(0, 7)); e.sales += n(s.sale_value); e.profit += n(s.gross_profit); }
    for (const i of rangeInward) { svpRow(i.inward_date.slice(0, 7)).purchase += n(i.total_cost); }
    const salesVsPurchase = [...svp.values()].sort((a, b) => a.month.localeCompare(b.month));

    // 4. Sales by category
    const aggKey = (keyFn) => [...((arr) => { const m = new Map();
      for (const s of arr) { const k = keyFn(s); const e = m.get(k) || { value: 0, qty: 0 }; e.value += n(s.sale_value); e.qty += n(s.qty); m.set(k, e); } return m; })(rangeSales).entries()];
    const byCategory = aggKey(s => metaCat(meta, s)).map(([category, e]) => ({ category, ...e })).sort((a, b) => b.value - a.value);
    // 6. Sales by supplier (the part's stock.source)
    const bySupplier = aggKey(s => (meta.get(pk(s.part_name, s.part_no)) || {}).supplier || 'Unassigned')
      .map(([supplier, e]) => ({ supplier, ...e })).sort((a, b) => b.value - a.value);

    // 5. Top 10 selling parts (qty + value)
    const partAgg = new Map();
    for (const s of rangeSales) {
      const k = pk(s.part_name, s.part_no);
      const e = partAgg.get(k) || { part: s.part_name, pno: s.part_no, qty: 0, value: 0 };
      e.qty += n(s.qty); e.value += n(s.sale_value); partAgg.set(k, e);
    }
    const topParts = [...partAgg.values()].sort((a, b) => b.value - a.value).slice(0, 10);

    // 7. Stock by branch — qty stacked by top categories (+ Other)
    const activeBranches = store.all('branches').filter(b => b.status === 'Active').map(b => b.name);
    const branchList = sc.branch ? [sc.branch] : activeBranches;
    const catTotals = groupSum(stockRows, s => (s.category || '').trim() || 'Untagged', s => s.current_qty);
    const topCats = [...catTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c]) => c);
    const stockByBranch = { labels: branchList, series: topCats.concat('Other').map(c => ({ name: c, data: branchList.map(() => 0) })) };
    branchList.forEach((b, bi) => {
      for (const s of filterStock(b, meta, f, supParts)) {
        const c = (s.category || '').trim() || 'Untagged';
        const idx = topCats.includes(c) ? topCats.indexOf(c) : topCats.length; // Other = last
        stockByBranch.series[idx].data[bi] += n(s.current_qty);
      }
    });

    // 8. Inventory value by branch (treemap)
    const inventoryValueByBranch = branchList
      .map(b => ({ branch: b, value: sum(filterStock(b, meta, f, supParts), s => n(s.current_qty) * n(s.cost_price)) }))
      .filter(x => x.value > 0).sort((a, b) => b.value - a.value);

    // 9. Stock aging — value bucketed by days since last inward
    const ageBuckets = [['0-30 Days', 0, 30], ['31-60 Days', 31, 60], ['61-90 Days', 61, 90], ['90+ Days', 91, Infinity]];
    const stockAging = ageBuckets.map(([label]) => ({ bucket: label, value: 0 }));
    for (const s of stockRows) {
      if (n(s.current_qty) <= 0) continue;
      const li = lastInward.get(pk(s.part_name, s.part_no));
      const age = li ? Math.floor((Date.now() - new Date(li + 'T00:00:00')) / 86400000) : 999;
      const bi = ageBuckets.findIndex(([, lo, hi]) => age >= lo && age <= hi);
      stockAging[bi < 0 ? 3 : bi].value += n(s.current_qty) * n(s.cost_price);
    }

    // 10. Monthly profit trend
    const profitTrend = [...groupSum(rangeSales, s => s.sale_date.slice(0, 7), s => s.gross_profit).entries()]
      .map(([month, profit]) => ({ month, profit })).sort((a, b) => a.month.localeCompare(b.month));

    // 11. Branch performance (radar) — normalized 0-100 per axis
    const perfMap = new Map();
    for (const s of rangeSales) {
      const e = perfMap.get(s.branch) || { branch: s.branch, sales: 0, profit: 0, qty: 0, invoices: new Set() };
      e.sales += n(s.sale_value); e.profit += n(s.gross_profit); e.qty += n(s.qty);
      if (s.invoice_no) e.invoices.add(s.invoice_no); perfMap.set(s.branch, e);
    }
    const perfRaw = [...perfMap.values()].map(e => ({ branch: e.branch, sales: e.sales, profit: e.profit, qty: e.qty, invoices: e.invoices.size }));
    const axes = ['sales', 'profit', 'qty', 'invoices'];
    const maxBy = Object.fromEntries(axes.map(a => [a, Math.max(1, ...perfRaw.map(r => r[a]))]));
    const branchPerformance = {
      axes: ['Sales', 'Profit', 'Qty', 'Invoices'],
      series: perfRaw.map(r => ({ branch: r.branch, values: axes.map(a => Math.round((r[a] / maxBy[a]) * 100)), raw: r })),
    };

    // 12. Sales executive performance
    const staffMap = new Map();
    for (const s of rangeSales) {
      const e = staffMap.get(s.staff_email || '—') || { staff: s.staff_email || '—', sales: 0, qty: 0, bills: new Set() };
      e.sales += n(s.sale_value); e.qty += n(s.qty); if (s.invoice_no) e.bills.add(s.branch + '|' + s.invoice_no); staffMap.set(s.staff_email || '—', e);
    }
    const staffPerformance = [...staffMap.values()].map(e => ({ staff: e.staff, sales: e.sales, qty: e.qty, bills: e.bills.size }))
      .sort((a, b) => b.sales - a.sales).slice(0, 15);

    // ── Live alerts ─────────────────────────────────────────────────────────
    const lowList = stockRows.filter(s => n(s.current_qty) <= lowThr && n(s.current_qty) > 0)
      .sort((a, b) => n(a.current_qty) - n(b.current_qty)).map(s => ({ part_name: s.part_name, qty: s.current_qty }));
    const outList = stockRows.filter(s => n(s.current_qty) <= 0).map(s => ({ part_name: s.part_name, qty: s.current_qty }));
    const deadList = stockRows.filter(s => { const l = lastSale.get(pk(s.part_name, s.part_no)); return !l || l < deadCutoff; })
      .map(s => ({ part_name: s.part_name, last_sale: lastSale.get(pk(s.part_name, s.part_no)) || '' }));
    const dayTotals = [...groupSum(rangeSales, s => s.sale_date, s => s.sale_value).entries()];
    const avgDay = dayTotals.length ? sum(dayTotals, d => d[1]) / dayTotals.length : 0;
    const spikes = dayTotals.filter(([, v]) => avgDay > 0 && v > 2 * avgDay)
      .map(([date, value]) => ({ date, value })).sort((a, b) => b.value - a.value);
    const alerts = {
      lowStock: { count: lowList.length, sample: lowList.slice(0, 5) },
      outOfStock: { count: outList.length, sample: outList.slice(0, 5) },
      deadStock: { count: deadList.length, sample: deadList.slice(0, 5) },
      spikes: { count: spikes.length, sample: spikes.slice(0, 5) },
    };

    // ── Recent ────────────────────────────────────────────────────────────────
    const recent = allSales
      .sort((a, b) => (b.sale_date + (b.created_at || '')).localeCompare(a.sale_date + (a.created_at || '')))
      .slice(0, 10)
      .map(s => ({ id: s.id, sale_date: s.sale_date, branch: s.branch, part_name: s.part_name, qty: s.qty, sale_value: s.sale_value, invoice_no: s.invoice_no }));

    res.json({ ok: true, data: {
      kpis,
      charts: { trend, byBranch, salesVsPurchase, byCategory, topParts, bySupplier, stockByBranch, inventoryValueByBranch, stockAging, profitTrend, branchPerformance, staffPerformance },
      alerts, recent,
    } });
  } catch (e) {
    console.error('dashboard error', e); res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

// GET /api/dashboard/drill/:type?branch=&from=&to=&category=&supplier=&key=
router.get('/drill/:type', (req, res) => {
  try {
    const { type } = req.params;
    const { from, to, key, pno } = req.query;
    const sc = scope(req);
    const f = { category: req.query.category, supplier: req.query.supplier };
    const supParts = partsForSupplier(req.query.supplier);
    const meta = buildPartMeta();
    const lowThr = parseInt(store.getSetting('LOW_STOCK_THRESHOLD', '5'));
    const deadDays = parseInt(store.getSetting('DEAD_STOCK_DAYS', '90'));
    const t = today();

    const sales = filterSales(store.all('sales'), sc, meta, f, supParts);
    const sel = s => ({ id: s.id, sale_date: s.sale_date, branch: s.branch, part_name: s.part_name, qty: s.qty,
      unit_price: s.unit_price, sale_value: s.sale_value, gross_profit: s.gross_profit, invoice_no: s.invoice_no, staff_email: s.staff_email });
    const byDateDesc = (a, b) => (b.sale_date + (b.created_at || '')).localeCompare(a.sale_date + (a.created_at || ''));
    const ranged = () => sales.filter(s => inRange(s.sale_date, from, to));

    const stockSel = s => ({ vehicle: s.vehicle, part_name: s.part_name, part_no: s.part_no, category: s.category, supplier: s.source,
      cost_price: s.cost_price, unit_price: s.unit_price, qty: s.current_qty, value: n(s.current_qty) * n(s.cost_price) });
    const stockRows = () => filterStock(sc.branch, meta, f, supParts).map(stockSel);

    let rows = [];
    switch (type) {
      case 'today_sales': rows = sales.filter(s => s.sale_date === t).sort(byDateDesc).map(sel); break;
      case 'monthly_sales': rows = sales.filter(s => String(s.sale_date).startsWith(t.slice(0, 7))).sort(byDateDesc).map(sel); break;
      case 'total_sales': case 'gross_profit': case 'qty_sold': case 'transactions':
        rows = ranged().sort(byDateDesc).slice(0, 2000).map(sel); break;
      case 'total_invoices': {
        const m = new Map();
        for (const s of ranged()) {
          const k = s.branch + '|' + (s.invoice_no || '—');
          const e = m.get(k) || { invoice_no: s.invoice_no || '—', branch: s.branch, sale_date: s.sale_date, items: 0, qty: 0, value: 0 };
          e.items++; e.qty += n(s.qty); e.value += n(s.sale_value); m.set(k, e);
        }
        rows = [...m.values()].sort((a, b) => (b.sale_date || '').localeCompare(a.sale_date || '')); break;
      }
      case 'branch_sales': {
        const r = key ? sales.filter(s => s.branch === key) : sales;
        if (key) { rows = r.filter(s => inRange(s.sale_date, from, to)).sort(byDateDesc).map(sel); break; }
        const m = new Map();
        for (const s of ranged()) { const e = m.get(s.branch) || { branch: s.branch, transactions: 0, qty: 0, sale_value: 0, gross_profit: 0 };
          e.transactions++; e.qty += n(s.qty); e.sale_value += n(s.sale_value); e.gross_profit += n(s.gross_profit); m.set(s.branch, e); }
        rows = [...m.values()].sort((a, b) => b.sale_value - a.sale_value); break;
      }
      case 'category': rows = ranged().filter(s => metaCat(meta, s) === key).sort(byDateDesc).map(sel); break;
      case 'supplier_sales': rows = ranged().filter(s => ((meta.get(pk(s.part_name, s.part_no)) || {}).supplier || 'Unassigned') === key).sort(byDateDesc).map(sel); break;
      case 'staff': rows = ranged().filter(s => (s.staff_email || '—') === key).sort(byDateDesc).map(sel); break;
      case 'month': rows = ranged().filter(s => s.sale_date.slice(0, 7) === key).sort(byDateDesc).map(sel); break;
      case 'top_part': rows = ranged().filter(s => s.part_name === key && (!pno || s.part_no === pno)).sort(byDateDesc).map(sel); break;
      case 'supplier': {
        const ff = key ? { ...f, supplier: key } : f;
        rows = filterInward(store.all('inward'), sc, meta, ff, supParts)
          .filter(i => inRange(i.inward_date, from, to))
          .map(i => ({ inward_date: i.inward_date, branch: i.branch, part_name: i.part_name, qty: i.qty, supplier: i.supplier, unit_cost: i.unit_cost, total_cost: i.total_cost }))
          .sort((a, b) => (b.inward_date || '').localeCompare(a.inward_date || '')); break;
      }
      case 'aging': {
        const lastInward = lastInwardByPartMap();
        const rangeMap = { '0-30 Days': [0, 30], '31-60 Days': [31, 60], '61-90 Days': [61, 90], '90+ Days': [91, Infinity] };
        const [lo, hi] = rangeMap[key] || [0, Infinity];
        rows = stockRows().filter(s => {
          if (n(s.qty) <= 0) return false;
          const li = lastInward.get(pk(s.part_name, s.part_no));
          const age = li ? Math.floor((Date.now() - new Date(li + 'T00:00:00')) / 86400000) : 999;
          return age >= lo && age <= hi;
        }).sort((a, b) => b.value - a.value); break;
      }
      case 'stock_branch': {
        const b = key || sc.branch;
        rows = filterStock(b, meta, f, supParts).map(stockSel).filter(s => n(s.qty) > 0).sort((a, b2) => b2.value - a.value); break;
      }
      case 'total_stock_items': case 'stock_value': case 'inventory_value':
        rows = stockRows().sort((a, b) => b.value - a.value); break;
      case 'low_stock': rows = stockRows().filter(s => n(s.qty) <= lowThr && n(s.qty) > 0).sort((a, b) => n(a.qty) - n(b.qty)); break;
      case 'out_of_stock': rows = stockRows().filter(s => n(s.qty) <= 0).sort((a, b) => a.part_name.localeCompare(b.part_name)); break;
      case 'dead_stock': {
        const lastSale = lastSaleByPartMap();
        const cutoff = dateDaysAgo(deadDays);
        rows = stockRows().map(s => ({ ...s, last_sale: lastSale.get(pk(s.part_name, s.part_no)) || '' }))
          .filter(s => !s.last_sale || s.last_sale < cutoff).sort((a, b) => (a.last_sale || '').localeCompare(b.last_sale || '')); break;
      }
      case 'active_branches':
        rows = store.all('branches').filter(b => b.status === 'Active')
          .map(b => ({ id: b.id, name: b.name, location: b.location, manager: b.manager, contact: b.contact })); break;
      default: return res.status(400).json({ ok: false, msg: 'Unknown drill type' });
    }
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('drill error', e); res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

module.exports = router;
