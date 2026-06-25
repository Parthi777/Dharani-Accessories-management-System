// lib/db.js — PostgreSQL connection pool + query helper.
const { Pool } = require('pg');

const url = process.env.DATABASE_URL || '';
const isLocal = /localhost|127\.0\.0\.1/.test(url);
// Railway/managed Postgres needs SSL; local dev does not.
const ssl = (process.env.PGSSL === 'require' || (!isLocal && process.env.NODE_ENV === 'production'))
  ? { rejectUnauthorized: false } : false;

const pool = new Pool({ connectionString: url, ssl });
pool.on('error', (err) => console.error('Unexpected PG pool error', err.message));

module.exports = { pool, query: (text, params) => pool.query(text, params) };
