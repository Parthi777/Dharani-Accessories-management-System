// routes/inward.js — stock inward (single + bulk)
const express = require('express');
const store = require('../lib/store');
const { ddMMyy, today } = require('../lib/util');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const pad = (n, w) => String(n).padStart(w, '0');

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
    const qty = parseInt(b.qty);
    if (!branch || !partName || !qty || qty <= 0)
      return res.status(400).json({ ok: false, msg: 'branch, partName and a positive qty are required' });

    const cost = (b.unitCost != null && b.unitCost !== '') ? Number(b.unitCost) : null;        // purchase price
    const selling = (b.sellingPrice != null && b.sellingPrice !== '') ? Number(b.sellingPrice) : null; // retail price

    const row = await store.runExclusive(async () => {
      let part = store.findStock(partName, b.partNo);
      if (!part) {
        const id = store.nextSeqId('stock', 'id', 'STK', 4);
        [part] = await store.appendNoLock('stock', {
          id, vehicle: b.vehicle || 'Unassigned', part_name: partName, part_no: b.partNo || '—',
          source: b.source || 'DMS', unit_price: selling != null ? selling : 0, cost_price: cost != null ? cost : 0,
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
  if (!Array.isArray(rowsIn) || rowsIn.length === 0)
    return res.status(400).json({ ok: false, msg: 'Expected a non-empty array of inward rows' });

  try {
    const result = await store.runExclusive(async () => {
      const errors = [];
      const newStock = [];
      const inwardObjs = [];
      let stockMax = maxSeq('stock', 'STK');
      const inwCounters = {};

      const ensure = (partName, vehicle, partNo, cost, selling) => {
        const k = store.partKey(partName, partNo);
        let p = store.findStock(partName, partNo) || newStock.find(s => store.partKey(s.part_name, s.part_no) === k);
        if (p) return p;
        p = { id: 'STK' + pad(++stockMax, 4), vehicle: vehicle || 'Unassigned', part_name: partName,
              part_no: partNo || '—', source: 'DMS',
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
        const qty = parseInt(b.qty);
        if (!branch || !partName || !qty || qty <= 0) {
          errors.push({ row: i + 1, msg: 'branch, partName and positive qty required' });
          return;
        }
        const inwardDate = b.inwardDate || today();
        const cost = (b.unitCost != null && b.unitCost !== '') ? Number(b.unitCost) : null;
        const selling = (b.sellingPrice != null && b.sellingPrice !== '') ? Number(b.sellingPrice) : null;
        const part = ensure(partName, b.vehicle, b.partNo, cost, selling);
        const unitCost = cost != null ? cost : Number(part.cost_price);
        inwardObjs.push({
          id: nextInwId(ddMMyy(inwardDate)), inward_date: inwardDate, branch,
          vehicle: part.vehicle, part_name: partName, part_no: part.part_no, qty,
          supplier: b.supplier || '', batch_no: b.batchNo || '', unit_cost: unitCost,
          total_cost: unitCost * qty, staff_email: req.user.email, remarks: b.remarks || '',
        });
      });

      if (errors.length && inwardObjs.length === 0) throw { code: 400, msg: 'No valid rows', errors };
      if (newStock.length) await store.appendNoLock('stock', newStock);
      const saved = inwardObjs.length ? await store.appendNoLock('inward', inwardObjs) : [];
      return { saved, errors };
    });

    await store.audit(req.user, 'INWARD_BULK', 'inward', null, { saved: result.saved.length, errors: result.errors.length });
    res.json({ ok: true, data: { saved: result.saved.length, errors: result.errors }, rows: result.saved, vpmap: store.buildVpmap() });
  } catch (e) {
    if (e && e.code) return res.status(e.code).json({ ok: false, msg: e.msg, errors: e.errors });
    console.error('bulk inward error', e);
    res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

module.exports = router;
