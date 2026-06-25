// routes/auth.js — login, logout, change-password
const express = require('express');
const jwt = require('jsonwebtoken');
const store = require('../lib/store');
const { hashPwd } = require('../lib/util');
const requireAuth = require('../middleware/auth');

const router = express.Router();
const TOKEN_TTL = '8h';

// POST /api/auth/login  { email, password } → { ok, token, user }
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, msg: 'Email and password required' });

    const u = store.find('users', x => x.email.toLowerCase() === String(email).toLowerCase());
    if (!u || u.pwd_hash !== hashPwd(password)) {
      return res.status(401).json({ ok: false, msg: 'Invalid email or password' });
    }
    if (u.status !== 'Active') return res.status(403).json({ ok: false, msg: 'Account is inactive' });

    const payload = { userId: u.id, email: u.email, name: u.name, role: u.role, branch: u.branch };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: TOKEN_TTL });

    await store.updateByKey('users', 'id', u.id, { last_login: new Date().toISOString() });
    await store.audit(payload, 'LOGIN', 'user', u.id, 'Login successful', u.branch);

    res.json({ ok: true, token, user: payload });
  } catch (e) {
    console.error('login error', e);
    res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

// POST /api/auth/logout — token is cleared client-side; record the event.
router.post('/logout', requireAuth, async (req, res) => {
  await store.audit(req.user, 'LOGOUT', 'user', req.user.userId, 'Logout');
  res.json({ ok: true });
});

// POST /api/auth/change-password { oldPwd, newPwd }
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { oldPwd, newPwd } = req.body || {};
    if (!oldPwd || !newPwd) return res.status(400).json({ ok: false, msg: 'Old and new password required' });
    if (String(newPwd).length < 6) return res.status(400).json({ ok: false, msg: 'New password must be at least 6 characters' });

    const u = store.find('users', x => x.id === req.user.userId);
    if (!u || u.pwd_hash !== hashPwd(oldPwd)) {
      return res.status(400).json({ ok: false, msg: 'Current password is incorrect' });
    }
    await store.updateByKey('users', 'id', u.id, { pwd_hash: hashPwd(newPwd) });
    await store.audit(req.user, 'CHANGE_PASSWORD', 'user', u.id, 'Password changed');
    res.json({ ok: true });
  } catch (e) {
    console.error('change-password error', e);
    res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

module.exports = router;
