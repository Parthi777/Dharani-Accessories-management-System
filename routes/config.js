// routes/config.js — non-sensitive display config for any authenticated user
// (full settings remain Admin-only via /api/settings). Used by the invoice/PDF.
const express = require('express');
const store = require('../lib/store');
const requireAuth = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Distinct, sorted, non-empty values of a column across a table's rows.
const distinct = (table, col) =>
  [...new Set(store.all(table).map(r => (r[col] || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

router.get('/', (req, res) => {
  res.json({
    ok: true,
    data: {
      company: store.getSetting('COMPANY_NAME', 'Bhavani Dharani TVS'),
      currency: store.getSetting('CURRENCY', 'INR'),
      gstRate: Number(store.getSetting('GST_RATE', '0')) || 0,
      gstMode: store.getSetting('GST_MODE', 'exclusive'),
      gstEnabled: store.getSetting('GST_ENABLED', 'true') !== 'false',
      gstin: store.getSetting('GSTIN', ''),
      // Filter option lists for the dashboard global filters.
      categories: distinct('stock', 'category'),
      brands: distinct('stock', 'brand'),
      suppliers: distinct('inward', 'supplier'),
    },
  });
});

module.exports = router;
