// routes/users.js — user CRUD (Admin only)
const express = require('express');
const store = require('../lib/store');
const { hashPwd } = require('../lib/util');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('Admin'));

const ROLES = ['Admin', 'Branch_Manager', 'Sales_Staff', 'Store_Staff', 'Accountant'];

// GET /api/users — all users (no password hash)
router.get('/', (req, res) => {
  const rows = store.all('users').map(({ pwd_hash, ...u }) => u);
  res.json({ ok: true, data: rows });
});

// POST /api/users — create user
router.post('/', async (req, res) => {
  try {
    const { email, name, role, branch, password } = req.body || {};
    if (!email || !name || !role || !password)
      return res.status(400).json({ ok: false, msg: 'email, name, role and password are required' });
    if (!ROLES.includes(role)) return res.status(400).json({ ok: false, msg: 'Invalid role' });
    if (store.find('users', u => u.email.toLowerCase() === String(email).toLowerCase()))
      return res.status(409).json({ ok: false, msg: 'Email already in use' });

    const id = store.nextSeqId('users', 'id', 'USR', 4);
    const row = await store.insert('users', {
      id, email, name, role, branch: branch || 'ALL', status: 'Active',
      pwd_hash: hashPwd(password), last_login: '',
    });
    await store.audit(req.user, 'CREATE', 'user', id, { email, role });
    const { pwd_hash, ...safe } = row;
    res.json({ ok: true, data: safe });
  } catch (e) {
    console.error(e); res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

// PUT /api/users/:id — edit name, role, branch, status, and optionally password.
// Email/id are the login key, so they're not editable here.
router.put('/:id', async (req, res) => {
  try {
    const u = store.find('users', x => x.id === req.params.id);
    if (!u) return res.status(404).json({ ok: false, msg: 'User not found' });
    const { name, role, branch, status, password } = req.body || {};
    if (role && !ROLES.includes(role)) return res.status(400).json({ ok: false, msg: 'Invalid role' });
    if (status && !['Active', 'Inactive'].includes(status))
      return res.status(400).json({ ok: false, msg: 'status must be Active or Inactive' });
    if (req.params.id === req.user.userId && status === 'Inactive')
      return res.status(400).json({ ok: false, msg: 'You cannot deactivate your own account' });

    const patch = {};
    if (name != null) patch.name = name;
    if (role != null) patch.role = role;
    if (branch != null) patch.branch = branch;
    if (status != null) patch.status = status;
    if (password) {
      if (String(password).length < 6) return res.status(400).json({ ok: false, msg: 'Password must be at least 6 characters' });
      patch.pwd_hash = hashPwd(password);
    }

    const row = await store.updateByKey('users', 'id', req.params.id, patch);
    await store.audit(req.user, 'UPDATE', 'user', req.params.id, { ...patch, pwd_hash: password ? '***' : undefined });
    const { pwd_hash, ...safe } = row;
    res.json({ ok: true, data: safe });
  } catch (e) {
    console.error(e); res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

// PATCH /api/users/:id/status — set status explicitly (Active/Inactive)
router.patch('/:id/status', async (req, res) => {
  try {
    const u = store.find('users', x => x.id === req.params.id);
    if (!u) return res.status(404).json({ ok: false, msg: 'User not found' });
    const next = (req.body && req.body.status) || (u.status === 'Active' ? 'Inactive' : 'Active');
    if (!['Active', 'Inactive'].includes(next))
      return res.status(400).json({ ok: false, msg: 'status must be Active or Inactive' });
    if (req.params.id === req.user.userId && next === 'Inactive')
      return res.status(400).json({ ok: false, msg: 'You cannot deactivate your own account' });
    const row = await store.updateByKey('users', 'id', req.params.id, { status: next });
    await store.audit(req.user, 'STATUS', 'user', req.params.id, { status: next });
    const { pwd_hash, ...safe } = row;
    res.json({ ok: true, data: safe });
  } catch (e) {
    console.error(e); res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

module.exports = router;
