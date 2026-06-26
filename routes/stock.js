// routes/stock.js — stock catalogue + computed quantities
const express = require('express');
const store = require('../lib/store');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Non-admins are locked to their JWT branch.
function effBranch(req) {
  if (req.user.role !== 'Admin' && req.user.branch && req.user.branch !== 'ALL') return req.user.branch;
  return req.query.branch || null;
}

// GET /api/stock?branch= → stock rows with current qty
router.get('/', (req, res) => {
  res.json({ ok: true, data: store.stockWithQty(effBranch(req)) });
});

// GET /api/stock/vpmap → { vehicle: [partName] }
router.get('/vpmap', (req, res) => {
  res.json({ ok: true, data: store.buildVpmap() });
});

// GET /api/stock/qty/:partName?branch=&partNo= → single current qty
router.get('/qty/:partName', (req, res) => {
  const qty = store.currentQty(req.params.partName, req.query.partNo, req.query.vehicle, effBranch(req));
  if (qty === null) return res.status(404).json({ ok: false, msg: 'Part not found' });
  res.json({ ok: true, data: { partName: req.params.partName, partNo: req.query.partNo || '', qty } });
});

// POST /api/stock — Admin only: add new part → returns updated VPMAP
router.post('/', requireRole('Admin'), async (req, res) => {
  try {
    const { vehicle, partName, partNo, source, category, unitPrice, costPrice, initQty, notes } = req.body || {};
    if (!vehicle || !partName) return res.status(400).json({ ok: false, msg: 'vehicle and partName are required' });
    // Identity = name + part number + vehicle; the same name on a different vehicle/part-no is a different item.
    if (store.findStock(partName, partNo, vehicle))
      return res.status(409).json({ ok: false, msg: 'A part with this name, part number and vehicle already exists' });

    const id = store.nextSeqId('stock', 'id', 'STK', 4);
    const row = await store.insert('stock', {
      id, vehicle, part_name: partName, part_no: partNo || '—', source: source || '',
      category: category || '',
      unit_price: Number(unitPrice) || 0, cost_price: Number(costPrice) || 0,
      init_qty: parseInt(initQty) || 0, notes: notes || '',
    });
    await store.audit(req.user, 'CREATE', 'stock', id, { partName });
    res.json({ ok: true, data: row, vpmap: store.buildVpmap() });
  } catch (e) {
    console.error(e); res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

// POST /api/stock/bulk-delete — Admin: delete several parts at once. Like the
// single delete, it removes each part's inward + transfer history; sales are kept
// unless purgeSales is set.
router.post('/bulk-delete', requireRole('Admin'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    const purgeSales = !!(req.body && (req.body.purgeSales === true || req.body.purgeSales === '1'));
    if (!ids.length) return res.status(400).json({ ok: false, msg: 'No parts selected' });

    let deleted = 0; const removed = { inward: 0, transfers: 0, sales: 0 };
    for (const id of ids) {
      const s = store.find('stock', x => x.id === id);
      if (!s) continue;
      const key = store.partKey(s.part_name, s.part_no, s.vehicle);
      const sameItem = r => store.partKey(r.part_name, r.part_no, r.vehicle) === key;
      await store.deleteByKey('stock', 'id', id);
      removed.inward += await store.deleteWhere('inward', sameItem);
      removed.transfers += await store.deleteWhere('transfers', sameItem);
      removed.sales += purgeSales ? await store.deleteWhere('sales', sameItem) : 0;
      deleted++;
    }
    await store.audit(req.user, 'DELETE', 'stock', ids.join(','), { bulk: true, deleted, removed, purgeSales });
    res.json({ ok: true, data: { deleted, removed }, vpmap: store.buildVpmap() });
  } catch (e) {
    console.error(e); res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

// PUT /api/stock/:id — Admin only: edit a catalogue entry.
// part_name is the cross-table join key, so it is NOT editable here.
router.put('/:id', requireRole('Admin'), async (req, res) => {
  try {
    const s = store.find('stock', x => x.id === req.params.id);
    if (!s) return res.status(404).json({ ok: false, msg: 'Part not found' });
    const { vehicle, partNo, source, category, unitPrice, costPrice, initQty, notes } = req.body || {};

    const patch = {};
    if (vehicle != null) patch.vehicle = vehicle;
    if (partNo != null) patch.part_no = partNo || '—';
    if (source != null) patch.source = source;
    if (category != null) patch.category = category;
    if (unitPrice != null) patch.unit_price = Number(unitPrice) || 0;
    if (costPrice != null) patch.cost_price = Number(costPrice) || 0;
    if (initQty != null) patch.init_qty = parseInt(initQty) || 0;
    if (notes != null) patch.notes = notes;

    const row = await store.updateByKey('stock', 'id', req.params.id, patch);
    await store.audit(req.user, 'UPDATE', 'stock', req.params.id, { partName: s.part_name });
    res.json({ ok: true, data: row, vpmap: store.buildVpmap() });
  } catch (e) {
    console.error(e); res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

// DELETE /api/stock/:id — Admin only: remove a catalogue entry AND its stock
// movement history (inward + transfers) so re-uploading the same part name
// starts clean. Sales are kept unless ?purgeSales=1 (financial records).
// Because everything joins on part_name, leaving inward behind would let an
// old quantity resurrect when the same name is added again.
router.delete('/:id', requireRole('Admin'), async (req, res) => {
  try {
    const s = store.find('stock', x => x.id === req.params.id);
    if (!s) return res.status(404).json({ ok: false, msg: 'Part not found' });
    const name = s.part_name;
    const key = store.partKey(s.part_name, s.part_no, s.vehicle);   // only THIS part (name + part no + vehicle)
    const sameItem = r => store.partKey(r.part_name, r.part_no, r.vehicle) === key;
    const purgeSales = req.query.purgeSales === '1' || req.query.purgeSales === 'true';

    const removed = {};
    await store.deleteByKey('stock', 'id', req.params.id);
    removed.inward = await store.deleteWhere('inward', sameItem);
    removed.transfers = await store.deleteWhere('transfers', sameItem);
    removed.sales = purgeSales ? await store.deleteWhere('sales', sameItem) : 0;
    const salesKept = purgeSales ? 0 : store.all('sales').filter(sameItem).length;

    await store.audit(req.user, 'DELETE', 'stock', req.params.id, { partName: name, removed, salesKept });
    res.json({ ok: true, data: { id: req.params.id, removed, salesKept }, vpmap: store.buildVpmap() });
  } catch (e) {
    console.error(e); res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

module.exports = router;
