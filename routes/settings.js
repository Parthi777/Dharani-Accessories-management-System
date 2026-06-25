// routes/settings.js — app settings (Admin only)
const express = require('express');
const store = require('../lib/store');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('Admin'));

// GET /api/settings → all settings
router.get('/', (req, res) => {
  const rows = store.all('settings').sort((a, b) => a.key.localeCompare(b.key));
  res.json({ ok: true, data: rows });
});

// PUT /api/settings/:key { value } → upsert
router.put('/:key', async (req, res) => {
  try {
    const { value } = req.body || {};
    if (value == null) return res.status(400).json({ ok: false, msg: 'value required' });
    const row = await store.upsertSetting(req.params.key, value);
    await store.audit(req.user, 'UPDATE', 'settings', req.params.key, { value });
    res.json({ ok: true, data: row });
  } catch (e) {
    console.error(e); res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

module.exports = router;
