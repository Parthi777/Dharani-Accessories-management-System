// routes/config.js — non-sensitive display config for any authenticated user
// (full settings remain Admin-only via /api/settings). Used by the invoice/PDF.
const express = require('express');
const store = require('../lib/store');
const requireAuth = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

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
    },
  });
});

module.exports = router;
