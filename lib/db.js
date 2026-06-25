// lib/db.js — PostgreSQL connection pool + query helper.
const { Pool } = require('pg');

const url = process.env.DATABASE_URL || '';

// SSL resolution (works for local, Railway private network, and remote/managed):
//   PGSSL=require|disable overrides everything.
//   sslmode=require in the URL → SSL on.
//   localhost / *.railway.internal (private network) → SSL off.
//   any other remote host (Railway public proxy, Neon, etc.) → SSL on.
function resolveSsl() {
  if (process.env.PGSSL === 'disable') return false;
  if (process.env.PGSSL === 'require') return { rejectUnauthorized: false };
  if (/sslmode=require/.test(url)) return { rejectUnauthorized: false };
  if (/localhost|127\.0\.0\.1|\.railway\.internal/.test(url) || !url) return false;
  return { rejectUnauthorized: false };
}

const pool = new Pool({ connectionString: url, ssl: resolveSsl() });
pool.on('error', (err) => console.error('Unexpected PG pool error', err.message));

module.exports = { pool, query: (text, params) => pool.query(text, params) };
