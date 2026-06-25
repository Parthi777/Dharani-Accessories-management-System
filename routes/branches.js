// routes/branches.js — branch CRUD
const express = require('express');
const store = require('../lib/store');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/branches — active branches (admin can request all with ?all=1)
router.get('/', (req, res) => {
  const all = req.user.role === 'Admin' && req.query.all === '1';
  let rows = store.all('branches');
  if (!all) rows = rows.filter(b => b.status === 'Active');
  rows.sort((a, b) => a.id.localeCompare(b.id));
  res.json({ ok: true, data: rows });
});

// POST /api/branches — Admin: create branch
router.post('/', requireRole('Admin'), async (req, res) => {
  try {
    const { name, location, manager, email, contact } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, msg: 'Branch name required' });
    if (store.find('branches', b => b.name.toLowerCase() === String(name).toLowerCase()))
      return res.status(409).json({ ok: false, msg: 'Branch name already exists' });

    const id = store.nextSeqId('branches', 'id', 'BRN', 3);
    const row = await store.insert('branches', {
      id, name, location: location || '', status: 'Active',
      manager: manager || '', email: email || '', contact: contact || '',
    });
    await store.audit(req.user, 'CREATE', 'branch', id, { name });
    res.json({ ok: true, data: row });
  } catch (e) {
    console.error(e); res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

// PUT /api/branches/:id — Admin: edit branch fields + status.
// Name/id are the cross-table key, so they're not editable here.
router.put('/:id', requireRole('Admin'), async (req, res) => {
  try {
    const b = store.find('branches', x => x.id === req.params.id);
    if (!b) return res.status(404).json({ ok: false, msg: 'Branch not found' });
    const { location, manager, email, contact, status } = req.body || {};
    if (status && !['Active', 'Inactive'].includes(status))
      return res.status(400).json({ ok: false, msg: 'status must be Active or Inactive' });

    const patch = {};
    if (location != null) patch.location = location;
    if (manager != null) patch.manager = manager;
    if (email != null) patch.email = email;
    if (contact != null) patch.contact = contact;
    if (status != null) patch.status = status;

    const row = await store.updateByKey('branches', 'id', req.params.id, patch);
    await store.audit(req.user, 'UPDATE', 'branch', req.params.id, patch);
    res.json({ ok: true, data: row });
  } catch (e) {
    console.error(e); res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

// PATCH /api/branches/:id/status — Admin: set status explicitly (Active/Inactive)
router.patch('/:id/status', requireRole('Admin'), async (req, res) => {
  try {
    const b = store.find('branches', x => x.id === req.params.id);
    if (!b) return res.status(404).json({ ok: false, msg: 'Branch not found' });
    const next = (req.body && req.body.status) || (b.status === 'Active' ? 'Inactive' : 'Active');
    if (!['Active', 'Inactive'].includes(next))
      return res.status(400).json({ ok: false, msg: 'status must be Active or Inactive' });
    const row = await store.updateByKey('branches', 'id', req.params.id, { status: next });
    await store.audit(req.user, 'STATUS', 'branch', req.params.id, { status: next });
    res.json({ ok: true, data: row });
  } catch (e) {
    console.error(e); res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

// DELETE /api/branches/:id — Admin only. Historical rows referencing the
// branch name are left intact (just reported).
router.delete('/:id', requireRole('Admin'), async (req, res) => {
  try {
    const b = store.find('branches', x => x.id === req.params.id);
    if (!b) return res.status(404).json({ ok: false, msg: 'Branch not found' });
    const refs = {
      users: store.all('users').filter(u => u.branch === b.name).length,
      sales: store.all('sales').filter(s => s.branch === b.name).length,
      inward: store.all('inward').filter(i => i.branch === b.name).length,
      transfers: store.all('transfers').filter(t => t.from_branch === b.name || t.to_branch === b.name).length,
    };
    await store.deleteByKey('branches', 'id', req.params.id);
    await store.audit(req.user, 'DELETE', 'branch', req.params.id, { name: b.name, refs });
    res.json({ ok: true, data: { id: req.params.id, refs } });
  } catch (e) {
    console.error(e); res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

module.exports = router;
