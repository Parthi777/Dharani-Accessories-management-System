// lib/store.js — PostgreSQL-backed data store.
// Keeps an in-memory cache (loaded on boot, kept in sync on writes) so the
// dashboard/analytics compute helpers run in JS unchanged. Stock identity is
// the COMPOSITE (part_name + part_no): same-named parts with different part
// numbers are tracked separately. A part with no number normalises to '—'.
const db = require('./db');
const { hashPwd, today } = require('./util');

// ── Table definitions (cols order is informational; inserts name columns) ──
const SCHEMA = {
  branches: { key: 'id', cols: ['id', 'name', 'location', 'status', 'manager', 'email', 'contact', 'created_at'], num: [] },
  users:    { key: 'id', cols: ['id', 'email', 'name', 'role', 'branch', 'status', 'pwd_hash', 'last_login', 'created_at'], num: [] },
  stock:    { key: 'id', cols: ['id', 'vehicle', 'part_name', 'part_no', 'source', 'unit_price', 'cost_price', 'init_qty', 'notes'], num: ['unit_price', 'cost_price', 'init_qty'] },
  sales:    { key: 'id', cols: ['id', 'sale_date', 'branch', 'staff_email', 'invoice_no', 'vehicle', 'part_name', 'part_no', 'qty', 'unit_price', 'sale_value', 'cost_price', 'gross_profit', 'stock_before', 'stock_after', 'remarks', 'created_at', 'customer_name', 'vehicle_no'], num: ['qty', 'unit_price', 'sale_value', 'cost_price', 'gross_profit', 'stock_before', 'stock_after'] },
  inward:   { key: 'id', cols: ['id', 'inward_date', 'branch', 'vehicle', 'part_name', 'part_no', 'qty', 'supplier', 'batch_no', 'unit_cost', 'total_cost', 'staff_email', 'created_at', 'remarks'], num: ['qty', 'unit_cost', 'total_cost'] },
  transfers:{ key: 'id', cols: ['id', 'transfer_date', 'part_name', 'from_branch', 'to_branch', 'qty', 'vehicle', 'part_no', 'staff_email', 'created_at', 'remarks'], num: ['qty'] },
  settings: { key: 'key', cols: ['key', 'value', 'description'], num: [] },
  audit_log:{ key: 'id', cols: ['id', 'created_at', 'email', 'name', 'role', 'action', 'entity', 'entity_id', 'branch', 'details'], num: [] },
};
const TABLES = Object.keys(SCHEMA);

const DDL = `
CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, location TEXT, status TEXT DEFAULT 'Active',
  manager TEXT, email TEXT, contact TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL,
  branch TEXT, status TEXT DEFAULT 'Active', pwd_hash TEXT NOT NULL, last_login TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS stock (
  id TEXT PRIMARY KEY, vehicle TEXT NOT NULL, part_name TEXT NOT NULL, part_no TEXT DEFAULT '—',
  source TEXT DEFAULT 'DMS', unit_price NUMERIC DEFAULT 0, cost_price NUMERIC DEFAULT 0,
  init_qty INTEGER DEFAULT 0, notes TEXT,
  UNIQUE (part_name, part_no)
);
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY, sale_date TEXT NOT NULL, branch TEXT NOT NULL, staff_email TEXT, invoice_no TEXT,
  vehicle TEXT, part_name TEXT NOT NULL, part_no TEXT, qty INTEGER NOT NULL, unit_price NUMERIC,
  sale_value NUMERIC, cost_price NUMERIC, gross_profit NUMERIC, stock_before INTEGER, stock_after INTEGER,
  remarks TEXT, created_at TEXT, customer_name TEXT, vehicle_no TEXT
);
CREATE TABLE IF NOT EXISTS inward (
  id TEXT PRIMARY KEY, inward_date TEXT NOT NULL, branch TEXT NOT NULL, vehicle TEXT, part_name TEXT NOT NULL,
  part_no TEXT, qty INTEGER NOT NULL, supplier TEXT, batch_no TEXT, unit_cost NUMERIC, total_cost NUMERIC,
  staff_email TEXT, created_at TEXT, remarks TEXT
);
CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY, transfer_date TEXT NOT NULL, part_name TEXT NOT NULL, from_branch TEXT NOT NULL,
  to_branch TEXT NOT NULL, qty INTEGER NOT NULL, vehicle TEXT, part_no TEXT, staff_email TEXT,
  created_at TEXT, remarks TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, description TEXT);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, created_at TEXT, email TEXT, name TEXT, role TEXT, action TEXT, entity TEXT,
  entity_id TEXT, branch TEXT, details TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_invoice_branch ON sales(branch, invoice_no) WHERE invoice_no IS NOT NULL AND invoice_no <> '';
CREATE INDEX IF NOT EXISTS idx_sales_part ON sales(part_name, part_no);
CREATE INDEX IF NOT EXISTS idx_inward_part ON inward(part_name, part_no);
`;

// ── Seed (fresh DB only): the real branches + admin login ──────────────────
const SEED = {
  branches: [
    { id: 'BRN001', name: 'Bhavani',      location: 'Bhavani',      status: 'Active', manager: 'Admin', email: '', contact: '' },
    { id: 'BRN002', name: 'Anthiyur',     location: 'Anthiyur',     status: 'Active', manager: 'Admin', email: '', contact: '' },
    { id: 'BRN003', name: 'Ammapettai',   location: 'Ammapettai',   status: 'Active', manager: 'Admin', email: '', contact: '' },
    { id: 'BRN004', name: 'Kavindapadi',  location: 'Kavindapadi',  status: 'Active', manager: 'Admin', email: '', contact: '' },
    { id: 'BRN005', name: 'Kumarapalayam',location: 'Kumarapalayam',status: 'Active', manager: 'Admin', email: '', contact: '' },
  ],
  users: [
    // Login: admin@tvs.local / Admin@123  (same hashing as the original app)
    { id: 'USR0001', email: 'admin@tvs.local', name: 'System Admin', role: 'Admin', branch: 'ALL', status: 'Active', pwd_hash: hashPwd('Admin@123'), last_login: '' },
  ],
};
const DEFAULT_SETTINGS = [
  ['LOW_STOCK_THRESHOLD', '5',  'Parts with qty at or below this are low stock'],
  ['DEAD_STOCK_DAYS',     '90', 'Parts with no sale in this many days are dead stock'],
  ['COMPANY_NAME',        'Bhavani Dharani TVS', 'Name shown on invoices/reports'],
  ['CURRENCY',            'INR', 'Currency code'],
  ['GST_RATE',            '18', 'GST % on invoices (set 0 to disable GST)'],
  ['GST_MODE',            'exclusive', 'exclusive = GST added on top of price; inclusive = price already includes GST'],
  ['GSTIN',               '', 'Shop GSTIN printed on invoices'],
];

// ── State + helpers ─────────────────────────────────────────────────────────
const data = {};
const store = { ready: false, error: null };
const n = v => Number(v || 0);

// Coerce a DB/raw row into the cache shape (numbers parsed, nulls → '').
function shape(table, o) {
  const r = {};
  for (const c of SCHEMA[table].cols) {
    const v = o[c];
    r[c] = SCHEMA[table].num.includes(c) ? Number(v || 0) : (v == null ? '' : String(v));
  }
  return r;
}

// Composite part identity. '—'/'-'/'' all mean "no part number".
const normPno = p => { p = (p == null ? '' : String(p)).trim(); return (p === '' || p === '—' || p === '-') ? '' : p; };
const partKey = (name, pno) => String(name == null ? '' : name).trim() + '' + normPno(pno);

// ── Write serialization ─────────────────────────────────────────────────────
let _chain = Promise.resolve();
function withLock(fn) { const run = _chain.then(fn); _chain = run.then(() => {}, () => {}); return run; }

// ── Core CRUD ────────────────────────────────────────────────────────────────
async function bulkInsert(table, objs) {
  objs = Array.isArray(objs) ? objs : [objs];
  if (!objs.length) return [];
  const cols = SCHEMA[table].cols;
  const prepared = objs.map(o => {
    const x = { ...o };
    if (cols.includes('created_at') && !x.created_at) x.created_at = new Date().toISOString();
    return x;
  });
  const params = [];
  const tuples = prepared.map(o => '(' + cols.map(c => { params.push(o[c] === undefined ? null : o[c]); return '$' + params.length; }).join(',') + ')');
  await db.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')}`, params);
  const shaped = prepared.map(o => shape(table, o));
  data[table].push(...shaped);
  return shaped.map(r => ({ ...r }));
}

function insert(table, obj) { return withLock(async () => (await bulkInsert(table, [obj]))[0]); }
function insertMany(table, objs) { return withLock(() => bulkInsert(table, objs)); }

async function _update(table, keyField, keyValue, patch) {
  const idx = data[table].findIndex(r => String(r[keyField]) === String(keyValue));
  if (idx < 0) return null;
  const cols = Object.keys(patch).filter(c => SCHEMA[table].cols.includes(c));
  if (cols.length) {
    const vals = cols.map(c => patch[c]);
    const set = cols.map((c, i) => `${c}=$${i + 1}`).join(',');
    vals.push(keyValue);
    await db.query(`UPDATE ${table} SET ${set} WHERE ${keyField}=$${vals.length}`, vals);
  }
  data[table][idx] = shape(table, { ...data[table][idx], ...patch });
  return { ...data[table][idx] };
}
function updateByKey(table, keyField, keyValue, patch) { return withLock(() => _update(table, keyField, keyValue, patch)); }

function deleteByKey(table, keyField, keyValue) {
  return withLock(async () => {
    const idx = data[table].findIndex(r => String(r[keyField]) === String(keyValue));
    if (idx < 0) return false;
    await db.query(`DELETE FROM ${table} WHERE ${keyField}=$1`, [keyValue]);
    data[table].splice(idx, 1);
    return true;
  });
}

function deleteWhere(table, predicate) {
  return withLock(async () => {
    const matched = data[table].filter(predicate);
    if (!matched.length) return 0;
    const key = SCHEMA[table].key;
    await db.query(`DELETE FROM ${table} WHERE ${key} = ANY($1)`, [matched.map(r => r[key])]);
    data[table] = data[table].filter(r => !predicate(r));
    return matched.length;
  });
}

function upsertSetting(key, value) {
  return withLock(async () => {
    await db.query(`INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, String(value)]);
    const idx = data.settings.findIndex(s => s.key === key);
    if (idx >= 0) { data.settings[idx].value = String(value); return { ...data.settings[idx] }; }
    const row = shape('settings', { key, value: String(value), description: '' });
    data.settings.push(row);
    return { ...row };
  });
}

// ── Reads (cache) ────────────────────────────────────────────────────────────
function all(table) { return data[table].map(r => ({ ...r })); }
function find(table, fn) { const r = data[table].find(fn); return r ? { ...r } : null; }
function filter(table, fn) { return data[table].filter(fn).map(r => ({ ...r })); }
function findStock(name, partNo) { const k = partKey(name, partNo); const r = data.stock.find(s => partKey(s.part_name, s.part_no) === k); return r ? { ...r } : null; }

// ── ID generation ───────────────────────────────────────────────────────────
function nextSeqId(table, field, prefix, width) {
  let max = 0;
  for (const r of data[table]) {
    const v = String(r[field] || '');
    if (prefix && !v.startsWith(prefix)) continue;
    const m = v.match(/(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return prefix + String(max + 1).padStart(width, '0');
}
function nextTxnId(table, prefix, stamp) {
  const pre = prefix + stamp;
  let max = 0;
  for (const r of data[table]) {
    const id = String(r.id || '');
    if (id.startsWith(pre)) max = Math.max(max, parseInt(id.slice(pre.length), 10) || 0);
  }
  return pre + String(max + 1).padStart(4, '0');
}

// ── Domain compute (composite part key) ─────────────────────────────────────
function qtyMaps(branch) {
  const inMap = new Map(), outMap = new Map();
  for (const i of data.inward) {
    if (branch && branch !== 'ALL' && i.branch !== branch) continue;
    const k = partKey(i.part_name, i.part_no);
    inMap.set(k, n(inMap.get(k)) + n(i.qty));
  }
  for (const s of data.sales) {
    if (branch && branch !== 'ALL' && s.branch !== branch) continue;
    const k = partKey(s.part_name, s.part_no);
    outMap.set(k, n(outMap.get(k)) + n(s.qty));
  }
  if (branch && branch !== 'ALL') {
    for (const t of data.transfers) {
      const k = partKey(t.part_name, t.part_no);
      if (t.to_branch === branch)   inMap.set(k, n(inMap.get(k)) + n(t.qty));
      if (t.from_branch === branch) outMap.set(k, n(outMap.get(k)) + n(t.qty));
    }
  }
  return { inMap, outMap };
}

function currentQty(partName, partNo, branch) {
  const k = partKey(partName, partNo);
  const s = data.stock.find(x => partKey(x.part_name, x.part_no) === k);
  if (!s) return null;
  const { inMap, outMap } = qtyMaps(branch);
  return n(s.init_qty) + n(inMap.get(k)) - n(outMap.get(k));
}

function stockWithQty(branch) {
  const { inMap, outMap } = qtyMaps(branch);
  return data.stock
    .map(s => { const k = partKey(s.part_name, s.part_no); return { ...s, current_qty: n(s.init_qty) + n(inMap.get(k)) - n(outMap.get(k)) }; })
    .sort((a, b) => (a.vehicle + a.part_name + a.part_no).localeCompare(b.vehicle + b.part_name + b.part_no));
}

function buildVpmap() {
  const map = {};
  for (const s of [...data.stock].sort((a, b) => (a.vehicle + a.part_name).localeCompare(b.vehicle + b.part_name))) {
    const list = (map[s.vehicle] = map[s.vehicle] || []);
    if (!list.includes(s.part_name)) list.push(s.part_name);
  }
  return map;
}

function getSetting(key, fallback) { const r = data.settings.find(x => x.key === key); return r ? r.value : fallback; }

async function audit(user, action, entity, entityId, details, branch) {
  try {
    await insert('audit_log', {
      id: nextSeqId('audit_log', 'id', '', 0) || '1', created_at: new Date().toISOString(),
      email: user?.email || '', name: user?.name || '', role: user?.role || '',
      action, entity, entity_id: entityId || '', branch: branch || user?.branch || '',
      details: typeof details === 'string' ? details : JSON.stringify(details || {}),
    });
  } catch (e) { console.error('audit_log write failed:', e.message); }
}

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  await db.query('SELECT 1');             // fail fast with a clear error
  await db.query(DDL);
  for (const t of TABLES) {
    const { rows } = await db.query(`SELECT * FROM ${t}`);
    data[t] = rows.map(r => shape(t, r));
  }
  if (data.branches.length === 0 && data.users.length === 0) {
    await bulkInsert('branches', SEED.branches);
    await bulkInsert('users', SEED.users);
  }
  const have = new Set(data.settings.map(s => s.key));
  const add = DEFAULT_SETTINGS.filter(([k]) => !have.has(k)).map(([key, value, description]) => ({ key, value, description }));
  if (add.length) await bulkInsert('settings', add);
  store.ready = true; store.error = null;
  return true;
}

async function refresh() {
  for (const t of TABLES) { const { rows } = await db.query(`SELECT * FROM ${t}`); data[t] = rows.map(r => shape(t, r)); }
  return true;
}

module.exports = Object.assign(store, {
  init, refresh, SCHEMA, TABLES, partKey,
  all, find, filter, findStock,
  insert, insertMany, updateByKey, deleteByKey, deleteWhere, upsertSetting,
  runExclusive: withLock, appendNoLock: bulkInsert, updateNoLock: _update,
  nextSeqId, nextTxnId, audit,
  currentQty, stockWithQty, buildVpmap, getSetting,
  hashPwd, today,
});
