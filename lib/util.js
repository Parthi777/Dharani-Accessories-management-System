// lib/util.js — pure helpers shared across the app (no I/O).
const crypto = require('crypto');

const SALT = 'TVS_SALT_2024';

// SHA-256(password + salt) — must match the original GAS implementation.
function hashPwd(password) {
  return crypto.createHash('sha256').update(String(password) + SALT).digest('hex');
}

// ddMMyy for transaction IDs (uses the supplied date or today).
function ddMMyy(d = new Date()) {
  const dt = (d instanceof Date) ? d : new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return p(dt.getDate()) + p(dt.getMonth() + 1) + p(dt.getFullYear() % 100);
}

const today = () => new Date().toISOString().slice(0, 10);

// 'YYYY-MM-DD' for `n` days before today (n may be 0 or negative).
function dateDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

module.exports = { SALT, hashPwd, ddMMyy, today, dateDaysAgo };
