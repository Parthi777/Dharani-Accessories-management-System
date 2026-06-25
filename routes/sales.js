// routes/sales.js — sales entry + listing
const express = require('express');
const store = require('../lib/store');
const { ddMMyy, today } = require('../lib/util');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Non-admins are server-side locked to their JWT branch.
function effBranch(req, fallback) {
  if (req.user.role !== 'Admin' && req.user.branch && req.user.branch !== 'ALL') return req.user.branch;
  return fallback || req.user.branch || null;
}

// GET /api/sales?branch=&limit=500 → recent sales
router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
  const branch = effBranch(req, req.query.branch);
  let rows = store.all('sales');
  if (branch && branch !== 'ALL') rows = rows.filter(s => s.branch === branch);
  rows.sort((a, b) => (b.sale_date + (b.created_at || '')).localeCompare(a.sale_date + (a.created_at || '')));
  res.json({ ok: true, data: rows.slice(0, limit) });
});

// Next sequential invoice number for a branch (4-digit, e.g. '0043').
function nextInvoiceFor(branch) {
  let max = 0;
  for (const s of store.all('sales')) {
    if (s.branch === branch && /^\d+$/.test(String(s.invoice_no))) max = Math.max(max, parseInt(s.invoice_no, 10));
  }
  return String(max + 1).padStart(4, '0');
}

// GET /api/sales/next-invoice?branch= → { invoiceNo: '0043' } (preview only)
router.get('/next-invoice', (req, res) => {
  res.json({ ok: true, data: { invoiceNo: nextInvoiceFor(effBranch(req, req.query.branch)) } });
});

// POST /api/sales — save a sale (validates stock, dedupes invoice)
router.post('/', requireRole('Admin', 'Branch_Manager', 'Sales_Staff'), async (req, res) => {
  try {
    const b = req.body || {};
    const branch = effBranch(req, b.branch);
    const saleDate = b.saleDate || today();
    const partName = b.partName;
    const qty = parseInt(b.qty);
    if (!branch || !partName || !qty || qty <= 0)
      return res.status(400).json({ ok: false, msg: 'branch, partName and a positive qty are required' });

    const row = await store.runExclusive(async () => {
      const part = store.findStock(partName, b.partNo);
      if (!part) throw { code: 404, msg: 'Part not found in catalogue' };

      // Invoice number: auto-generate per branch when not supplied; dedupe if one is.
      let invoiceNo = (b.invoiceNo != null && String(b.invoiceNo).trim()) ? String(b.invoiceNo).trim() : '';
      if (invoiceNo) {
        if (store.find('sales', s => s.branch === branch && String(s.invoice_no) === invoiceNo))
          throw { code: 409, msg: `Invoice ${invoiceNo} already used for this branch` };
      } else {
        invoiceNo = nextInvoiceFor(branch);
      }

      const before = store.currentQty(partName, part.part_no, branch);
      if (before < qty) throw { code: 400, msg: `Insufficient stock. Available: ${before}` };

      const unitPrice = b.unitPrice != null ? Number(b.unitPrice) : Number(part.unit_price);
      const costPrice = b.costPrice != null ? Number(b.costPrice) : Number(part.cost_price);
      const id = store.nextTxnId('sales', 'SL', ddMMyy(saleDate));
      const [saved] = await store.appendNoLock('sales', {
        id, sale_date: saleDate, branch, staff_email: req.user.email, invoice_no: invoiceNo,
        vehicle: part.vehicle, part_name: partName, part_no: part.part_no,
        qty, unit_price: unitPrice, sale_value: unitPrice * qty,
        cost_price: costPrice, gross_profit: (unitPrice - costPrice) * qty,
        stock_before: before, stock_after: before - qty, remarks: b.remarks || '',
        customer_name: b.customerName || '', vehicle_no: b.vehicleNo || '',
      });
      return saved;
    });

    await store.audit(req.user, 'SALE', 'sales', row.id, { partName, qty, saleValue: row.sale_value }, branch);
    res.json({ ok: true, data: row });
  } catch (e) {
    if (e && e.code) return res.status(e.code).json({ ok: false, msg: e.msg });
    console.error('sale error', e);
    res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

module.exports = router;
