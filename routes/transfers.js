// routes/transfers.js — inter-branch stock transfers
const express = require('express');
const store = require('../lib/store');
const { ddMMyy, today } = require('../lib/util');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Non-admins can only transfer OUT of their own branch.
function lockedBranch(req) {
  if (req.user.role !== 'Admin' && req.user.branch && req.user.branch !== 'ALL') return req.user.branch;
  return null;
}

// GET /api/transfers?branch=&limit=500 → transfers touching the branch
router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
  let rows = store.all('transfers');
  const branch = lockedBranch(req) || req.query.branch;
  if (branch && branch !== 'ALL') rows = rows.filter(t => t.from_branch === branch || t.to_branch === branch);
  rows.sort((a, b) => (b.transfer_date + (b.created_at || '')).localeCompare(a.transfer_date + (a.created_at || '')));
  res.json({ ok: true, data: rows.slice(0, limit) });
});

// POST /api/transfers — move stock from one branch to another
router.post('/', requireRole('Admin', 'Branch_Manager', 'Store_Staff'), async (req, res) => {
  try {
    const b = req.body || {};
    const fromBranch = lockedBranch(req) || b.fromBranch;
    const toBranch = b.toBranch;
    const partName = b.partName;
    const qty = parseInt(b.qty);
    const date = b.transferDate || today();

    if (!fromBranch || !toBranch || !partName || !qty || qty <= 0)
      return res.status(400).json({ ok: false, msg: 'fromBranch, toBranch, partName and a positive qty are required' });
    if (fromBranch === toBranch)
      return res.status(400).json({ ok: false, msg: 'Source and destination branches must be different' });

    const names = new Set(store.all('branches').map(x => x.name));
    if (!names.has(fromBranch)) return res.status(400).json({ ok: false, msg: 'Unknown source branch' });
    if (!names.has(toBranch)) return res.status(400).json({ ok: false, msg: 'Unknown destination branch' });

    const row = await store.runExclusive(async () => {
      const part = store.findStock(partName, b.partNo);
      if (!part) throw { code: 404, msg: 'Part not found in catalogue' };
      const avail = store.currentQty(partName, part.part_no, fromBranch);
      if (avail < qty) throw { code: 400, msg: `Insufficient stock in ${fromBranch}. Available: ${avail}` };
      const id = store.nextTxnId('transfers', 'TR', ddMMyy(date));
      const [saved] = await store.appendNoLock('transfers', {
        id, transfer_date: date, part_name: partName, from_branch: fromBranch, to_branch: toBranch,
        qty, vehicle: part.vehicle, part_no: part.part_no, staff_email: req.user.email, remarks: b.remarks || '',
      });
      return saved;
    });

    await store.audit(req.user, 'TRANSFER', 'transfers', row.id, { partName, qty, from: fromBranch, to: toBranch });
    res.json({ ok: true, data: row });
  } catch (e) {
    if (e && e.code) return res.status(e.code).json({ ok: false, msg: e.msg });
    console.error('transfer error', e);
    res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

module.exports = router;
