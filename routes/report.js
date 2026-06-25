// routes/report.js — monthly report generation
const express = require('express');
const store = require('../lib/store');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const n = v => Number(v || 0);

// POST /api/report/generate { month: 'YYYY-MM', branch? } → JSON summary
router.post('/generate', requireRole('Admin', 'Branch_Manager', 'Accountant'), async (req, res) => {
  try {
    const month = (req.body && req.body.month) || new Date().toISOString().slice(0, 7);
    let branch = req.body && req.body.branch;
    if (req.user.role !== 'Admin' && req.user.branch && req.user.branch !== 'ALL') branch = req.user.branch;
    const scoped = branch && branch !== 'ALL';

    const sales = store.all('sales').filter(s =>
      String(s.sale_date).startsWith(month) && (!scoped || s.branch === branch));
    const inward = store.all('inward').filter(i =>
      String(i.inward_date).startsWith(month) && (!scoped || i.branch === branch));

    const byBranchMap = new Map();
    for (const s of sales) {
      const e = byBranchMap.get(s.branch) || { branch: s.branch, sales: 0, profit: 0, qty: 0, txns: 0 };
      e.sales += n(s.sale_value); e.profit += n(s.gross_profit); e.qty += n(s.qty); e.txns += 1;
      byBranchMap.set(s.branch, e);
    }
    const partMap = new Map();
    for (const s of sales) {
      const e = partMap.get(s.part_name) || { part: s.part_name, qty: 0, sales: 0 };
      e.qty += n(s.qty); e.sales += n(s.sale_value); partMap.set(s.part_name, e);
    }

    const report = {
      month, branch: branch || 'ALL', generated_at: new Date().toISOString(),
      sales: {
        value: sales.reduce((a, s) => a + n(s.sale_value), 0),
        profit: sales.reduce((a, s) => a + n(s.gross_profit), 0),
        qty: sales.reduce((a, s) => a + n(s.qty), 0),
        transactions: sales.length,
      },
      inward: {
        cost: inward.reduce((a, i) => a + n(i.total_cost), 0),
        qty: inward.reduce((a, i) => a + n(i.qty), 0),
        entries: inward.length,
      },
      byBranch: [...byBranchMap.values()].sort((a, b) => b.sales - a.sales),
      topParts: [...partMap.values()].sort((a, b) => b.sales - a.sales).slice(0, 20),
    };

    await store.audit(req.user, 'REPORT', 'report', month, { branch: report.branch });
    res.json({ ok: true, data: report });
  } catch (e) {
    console.error('report error', e); res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

module.exports = router;
