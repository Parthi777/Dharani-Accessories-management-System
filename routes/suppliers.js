// routes/suppliers.js — supplier master CRUD
const express = require('express');
const store = require('../lib/store');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/suppliers — active suppliers (admin can request all with ?all=1)
router.get('/', (req, res) => {
  const all = req.user.role === 'Admin' && req.query.all === '1';
  let rows = store.all('suppliers');
  if (!all) rows = rows.filter(s => s.status === 'Active');
  rows.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ ok: true, data: rows });
});

// POST /api/suppliers — Admin: create supplier
router.post('/', requireRole('Admin'), async (req, res) => {
  try {
    const { name, contact, address } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, msg: 'Supplier name required' });
    if (store.find('suppliers', s => s.name.toLowerCase() === String(name).trim().toLowerCase()))
      return res.status(409).json({ ok: false, msg: 'Supplier name already exists' });

    const id = store.nextSeqId('suppliers', 'id', 'SUP', 3);
    const row = await store.insert('suppliers', {
      id, name: String(name).trim(), contact: contact || '', address: address || '', status: 'Active',
    });
    await store.audit(req.user, 'CREATE', 'supplier', id, { name });
    res.json({ ok: true, data: row });
  } catch (e) {
    console.error(e); res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

// PUT /api/suppliers/:id — Admin: edit contact/address/status.
// Name is the cross-table key (stored on stock.source / inward.supplier), so it is not editable here.
router.put('/:id', requireRole('Admin'), async (req, res) => {
  try {
    const s = store.find('suppliers', x => x.id === req.params.id);
    if (!s) return res.status(404).json({ ok: false, msg: 'Supplier not found' });
    const { contact, address, status } = req.body || {};
    if (status && !['Active', 'Inactive'].includes(status))
      return res.status(400).json({ ok: false, msg: 'status must be Active or Inactive' });

    const patch = {};
    if (contact != null) patch.contact = contact;
    if (address != null) patch.address = address;
    if (status != null) patch.status = status;

    const row = await store.updateByKey('suppliers', 'id', req.params.id, patch);
    await store.audit(req.user, 'UPDATE', 'supplier', req.params.id, patch);
    res.json({ ok: true, data: row });
  } catch (e) {
    console.error(e); res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

// PATCH /api/suppliers/:id/status — Admin: toggle/set Active/Inactive
router.patch('/:id/status', requireRole('Admin'), async (req, res) => {
  try {
    const s = store.find('suppliers', x => x.id === req.params.id);
    if (!s) return res.status(404).json({ ok: false, msg: 'Supplier not found' });
    const next = (req.body && req.body.status) || (s.status === 'Active' ? 'Inactive' : 'Active');
    if (!['Active', 'Inactive'].includes(next))
      return res.status(400).json({ ok: false, msg: 'status must be Active or Inactive' });
    const row = await store.updateByKey('suppliers', 'id', req.params.id, { status: next });
    await store.audit(req.user, 'STATUS', 'supplier', req.params.id, { status: next });
    res.json({ ok: true, data: row });
  } catch (e) {
    console.error(e); res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

// DELETE /api/suppliers/:id — Admin only. Historical rows naming the supplier are left intact (reported).
router.delete('/:id', requireRole('Admin'), async (req, res) => {
  try {
    const s = store.find('suppliers', x => x.id === req.params.id);
    if (!s) return res.status(404).json({ ok: false, msg: 'Supplier not found' });
    const refs = {
      stock: store.all('stock').filter(x => x.source === s.name).length,
      inward: store.all('inward').filter(i => i.supplier === s.name).length,
    };
    await store.deleteByKey('suppliers', 'id', req.params.id);
    await store.audit(req.user, 'DELETE', 'supplier', req.params.id, { name: s.name, refs });
    res.json({ ok: true, data: { id: req.params.id, refs } });
  } catch (e) {
    console.error(e); res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

module.exports = router;
