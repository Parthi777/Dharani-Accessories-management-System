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

// PUT /api/sales/:id — Admin only: edit a sale (part & branch are not editable).
// Recomputes value/profit and re-validates stock for the new quantity.
router.put('/:id', requireRole('Admin'), async (req, res) => {
  try {
    const b = req.body || {};
    const row = await store.runExclusive(async () => {
      const sale = store.find('sales', x => x.id === req.params.id);
      if (!sale) throw { code: 404, msg: 'Sale not found' };
      const branch = sale.branch;

      const qty = b.qty != null ? parseInt(b.qty) : Number(sale.qty);
      if (!qty || qty <= 0) throw { code: 400, msg: 'qty must be a positive number' };
      const unitPrice = b.unitPrice != null ? Number(b.unitPrice) : Number(sale.unit_price);
      const costPrice = Number(sale.cost_price);
      const invoiceNo = b.invoiceNo != null ? String(b.invoiceNo).trim() : String(sale.invoice_no || '');

      if (invoiceNo && store.all('sales').some(s => s.id !== sale.id && s.branch === branch && String(s.invoice_no) === invoiceNo))
        throw { code: 409, msg: `Invoice ${invoiceNo} already used for this branch` };

      // Available if THIS sale didn't exist (add its current qty back).
      const cur = store.currentQty(sale.part_name, sale.part_no, branch);
      const availWithoutThis = cur == null ? Infinity : cur + Number(sale.qty);
      if (qty > availWithoutThis) throw { code: 400, msg: `Insufficient stock. Available: ${availWithoutThis}` };

      const patch = {
        sale_date: b.saleDate != null ? b.saleDate : sale.sale_date,
        invoice_no: invoiceNo,
        customer_name: b.customerName != null ? b.customerName : sale.customer_name,
        vehicle_no: b.vehicleNo != null ? b.vehicleNo : sale.vehicle_no,
        qty, unit_price: unitPrice, sale_value: unitPrice * qty, gross_profit: (unitPrice - costPrice) * qty,
        stock_before: availWithoutThis === Infinity ? sale.stock_before : availWithoutThis,
        stock_after: availWithoutThis === Infinity ? sale.stock_after : availWithoutThis - qty,
        remarks: b.remarks != null ? b.remarks : sale.remarks,
      };
      return await store.updateNoLock('sales', 'id', sale.id, patch);
    });
    await store.audit(req.user, 'UPDATE', 'sales', req.params.id, { qty: row.qty, saleValue: row.sale_value });
    res.json({ ok: true, data: row });
  } catch (e) {
    if (e && e.code) return res.status(e.code).json({ ok: false, msg: e.msg });
    console.error('sale edit error', e);
    res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

// DELETE /api/sales/:id — Admin only. Stock auto-restores (qty is computed).
router.delete('/:id', requireRole('Admin'), async (req, res) => {
  try {
    const sale = store.find('sales', x => x.id === req.params.id);
    if (!sale) return res.status(404).json({ ok: false, msg: 'Sale not found' });
    await store.deleteByKey('sales', 'id', req.params.id);
    await store.audit(req.user, 'DELETE', 'sales', req.params.id, { partName: sale.part_name, qty: sale.qty, invoice: sale.invoice_no });
    res.json({ ok: true, data: { id: req.params.id } });
  } catch (e) {
    console.error('sale delete error', e);
    res.status(500).json({ ok: false, msg: 'Server error' });
  }
});

module.exports = router;
