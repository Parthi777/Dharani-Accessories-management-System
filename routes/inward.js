// routes/inward.js — stock inward (single + bulk)
const express = require('express');
const store = require('../lib/store');
const { ddMMyy, today } = require('../lib/util');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const pad = (n, w) => String(n).padStart(w, '0');

// Tolerant numeric parsing for uploaded data: strips currency symbols, thousands
// separators, spaces and stray text (e.g. "₹1,250", "10 pcs", "1,200" → 1250/10/1200).
const cleanNum = v => {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[₹$,\s]/g, '').replace(/[^0-9.\-]/g, '');
  return s === '' || s === '-' ? NaN : Number(s);
};
const qtyOf = v => { const n = cleanNum(v); return Number.isFinite(n) ? Math.trunc(n) : NaN; };
const priceOf = v => { if (v == null || v === '') return null; const n = cleanNum(v); return Number.isFinite(n) ? n : null; };

function effBranch(req, fallback) {
  if (req.user.role !== 'Admin' && req.user.branch && req.user.branch !== 'ALL') return req.user.branch;
  return fallback || req.user.branch || null;
}

// Highest numeric suffix currently used for an id prefix (e.g. STK, IN260624).
function maxSeq(table, prefix) {
  let m = 0;
  for (const r of store.all(table)) {
    const v = String(r.id || '');
    if (v.startsWith(prefix)) m = Math.max(m, parseInt(v.slice(prefix.length), 10) || 0);
  }
  return m;
}

// POST /api/inward — single inward entry
router.post('/', requireRole('Admin', 'Branch_Manager', 'Store_Staff'), async (req, res) => {
  try {
    const b = req.body || {};
    const branch = effBranch(req, b.branch);
    const inwardDate = b.inwardDate || today();
    const partName = b.partName;
    const qty = qtyOf(b.qty);
    if (!branch || !partName || !Number.isFinite(qty) || qty <= 0)
      return res.status(400).json({ ok: false, msg: 'branch, partName and a positive qty are required' });

    const cost = priceOf(b.unitCost);        // purchase price
    const selling = priceOf(b.sellingPrice); // retail price

    const row = await store.runExclusive(async () => {
      let part = store.findStock(partName, b.partNo, b.vehicle);
      if (!part) {
        const id = store.nextSeqId('stock', 'id', 'STK', 4);
        [part] = await store.appendNoLock('stock', {
          id, vehicle: b.vehicle || 'Unassigned', part_name: partName, part_no: b.partNo || '—',
          source: b.supplier || '', unit_price: selling != null ? selling : 0, cost_price: cost != null ? cost : 0,
          init_qty: 0, notes: '',
        });
      }
      const unitCost = cost != null ? cost : Number(part.cost_price);
      const id = store.nextTxnId('inward', 'IN', ddMMyy(inwardDate));
      const [saved] = await store.appendNoLock('inward', {
        id, inward_date: inwardDate, branch, vehicle: part.vehicle, part_name: partName, part_no: part.part_no,
        qty, supplier: b.supplier || '', batch_no: b.batchNo || '', unit_cost: unitCost,
        total_cost: unitCost * qty, staff_email: req.user.email, remarks: b.remarks || '',
      });
      return saved;
    });

    await store.audit(req.user, 'INWARD', 'inward', row.id, { partName, qty }, branch);
    res.json({ ok: true, data: row, vpmap: store.buildVpmap() });
  } catch (e) {
    console.error('inward error', e);
    res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

// POST /api/inward/bulk — array of rows; auto-creates missing stock entries
router.post('/bulk', requireRole('Admin', 'Branch_Manager', 'Store_Staff'), async (req, res) => {
  const rowsIn = Array.isArray(req.body) ? req.body : (req.body && req.body.rows);
  const force = !Array.isArray(req.body) && !!(req.body && req.body.force); // upload duplicates anyway
  if (!Array.isArray(rowsIn) || rowsIn.length === 0)
    return res.status(400).json({ ok: false, msg: 'Expected a non-empty array of inward rows' });

  try {
    const result = await store.runExclusive(async () => {
      const errors = [];
      const newStock = [];
      const inwardObjs = [];
      let stockMax = maxSeq('stock', 'STK');
      const inwCounters = {};

      // Duplicate detection: an inward row is a duplicate when the same date, branch,
      // part, qty, supplier and batch already exist (re-uploaded file) or repeat in
      // this same upload. Duplicates are skipped unless `force` is set.
      const duplicates = [];
      const sigOf = (date, branch, partName, partNo, vehicle, qty, supplier, batchNo) =>
        [date, branch, String(partName).trim().toLowerCase(), (partNo || '—'), String(vehicle || '').trim().toLowerCase(), qty, String(supplier || '').trim().toLowerCase(), String(batchNo || '').trim().toLowerCase()].join('¦');
      const existingSigs = new Set(store.all('inward').map(r => sigOf(r.inward_date, r.branch, r.part_name, r.part_no, r.vehicle, r.qty, r.supplier, r.batch_no)));
      const seenSigs = new Set();

      const ensure = (partName, vehicle, partNo, cost, selling) => {
        const k = store.partKey(partName, partNo, vehicle);
        let p = store.findStock(partName, partNo, vehicle) || newStock.find(s => store.partKey(s.part_name, s.part_no, s.vehicle) === k);
        if (p) return p;
        p = { id: 'STK' + pad(++stockMax, 4), vehicle: vehicle || 'Unassigned', part_name: partName,
              part_no: partNo || '—', source: '',
              unit_price: selling != null ? selling : 0, cost_price: cost != null ? cost : 0,
              init_qty: 0, notes: '' };
        newStock.push(p);
        return p;
      };
      const nextInwId = (stamp) => {
        if (inwCounters[stamp] == null) inwCounters[stamp] = maxSeq('inward', 'IN' + stamp);
        return 'IN' + stamp + pad(++inwCounters[stamp], 4);
      };

      rowsIn.forEach((b, i) => {
        const branch = effBranch(req, b.branch);
        const partName = b.partName;
        const qty = qtyOf(b.qty);
        if (!branch || !partName || !Number.isFinite(qty) || qty <= 0) {
          errors.push({ row: i + 1, msg: 'branch, partName and positive qty required' });
          return;
        }
        const inwardDate = b.inwardDate || today();
        const cost = priceOf(b.unitCost);
        const selling = priceOf(b.sellingPrice);
        if (!force) {
          const sig = sigOf(inwardDate, branch, partName, b.partNo, b.vehicle, qty, b.supplier, b.batchNo);
          if (existingSigs.has(sig) || seenSigs.has(sig)) {
            duplicates.push({ row: i + 1, partName, partNo: b.partNo || '—', qty, branch, date: inwardDate });
            return;
          }
          seenSigs.add(sig);
        }
        const part = ensure(partName, b.vehicle, b.partNo, cost, selling);
        const unitCost = cost != null ? cost : Number(part.cost_price);
        inwardObjs.push({
          id: nextInwId(ddMMyy(inwardDate)), inward_date: inwardDate, branch,
          vehicle: part.vehicle, part_name: partName, part_no: part.part_no, qty,
          supplier: b.supplier || '', batch_no: b.batchNo || '', unit_cost: unitCost,
          total_cost: unitCost * qty, staff_email: req.user.email, remarks: b.remarks || '',
        });
      });

      if (errors.length && inwardObjs.length === 0 && duplicates.length === 0) throw { code: 400, msg: 'No valid rows', errors };
      if (newStock.length) await store.appendNoLock('stock', newStock);
      const saved = inwardObjs.length ? await store.appendNoLock('inward', inwardObjs) : [];
      return { saved, errors, duplicates };
    });

    await store.audit(req.user, 'INWARD_BULK', 'inward', null, { saved: result.saved.length, errors: result.errors.length, duplicates: result.duplicates.length });
    res.json({ ok: true, data: { saved: result.saved.length, errors: result.errors, duplicates: result.duplicates }, rows: result.saved, vpmap: store.buildVpmap() });
  } catch (e) {
    if (e && e.code) return res.status(e.code).json({ ok: false, msg: e.msg, errors: e.errors });
    console.error('bulk inward error', e);
    res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

module.exports = router;
