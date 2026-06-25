# CLAUDE.md — Dharani Accessories Management System (DAMS)
# Stack: Node.js + Express + PostgreSQL → deployed on Railway

## Overview
TVS accessories inventory system for 5 branches of Bhavani Dharani TVS.
Features: sales entry, stock inward, analytics, branch/user admin, bulk CSV upload.
Originally built on Google Apps Script; this version runs on Railway.app.

---

## Project Structure
```
dams/
├── server.js          # Express app entry point
├── db.js              # pg Pool + query helper
├── routes/
│   ├── auth.js        # POST /login, POST /logout, POST /change-password
│   ├── sales.js       # GET/POST /sales, GET /sales/next-invoice
│   ├── stock.js       # GET/POST /stock, GET /stock/qty
│   ├── inward.js      # POST /inward, POST /inward/bulk
│   ├── dashboard.js   # GET /dashboard, GET /dashboard/drill
│   ├── analytics.js   # GET /analytics
│   ├── branches.js    # CRUD /branches
│   ├── users.js       # CRUD /users
│   └── settings.js    # GET/PUT /settings
├── middleware/
│   └── auth.js        # requireAuth(req,res,next) — JWT validation
├── public/
│   └── index.html     # Frontend SPA (adapted from original)
├── seed.sql           # Initial data: branches, admin, stock catalogue
├── schema.sql         # CREATE TABLE statements
├── package.json
└── .env               # DATABASE_URL, JWT_SECRET, PORT
```

---

## Environment Variables (.env / Railway dashboard)
```
DATABASE_URL=postgresql://...   # Auto-set by Railway Postgres plugin
JWT_SECRET=<random-64-char>     # Set manually in Railway Variables
PORT=3000                        # Railway sets this automatically
NODE_ENV=production
```

---

## Database Schema (schema.sql)

```sql
-- Run once on Railway: railway run psql < schema.sql

CREATE TABLE branches (
  id TEXT PRIMARY KEY,           -- BRN001..BRN005
  name TEXT NOT NULL UNIQUE,
  location TEXT,
  status TEXT DEFAULT 'Active',  -- Active | Inactive
  manager TEXT, email TEXT, contact TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,            -- Admin | Branch_Manager | Sales_Staff | Store_Staff | Accountant
  branch TEXT,                   -- branch name or 'ALL'
  status TEXT DEFAULT 'Active',  -- Active | Inactive
  pwd_hash TEXT NOT NULL,
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE stock (
  id TEXT PRIMARY KEY,           -- STK0001..
  vehicle TEXT NOT NULL,
  part_name TEXT NOT NULL UNIQUE,
  part_no TEXT DEFAULT '—',
  source TEXT DEFAULT 'DMS',     -- DMS | Local | Import
  unit_price NUMERIC DEFAULT 0,
  cost_price NUMERIC DEFAULT 0,
  init_qty INTEGER DEFAULT 0,
  notes TEXT
);

CREATE TABLE sales (
  id TEXT PRIMARY KEY,           -- SL260624NNNN
  sale_date DATE NOT NULL,
  branch TEXT NOT NULL,
  staff_email TEXT,
  invoice_no TEXT,
  vehicle TEXT,
  part_name TEXT NOT NULL,
  part_no TEXT,
  qty INTEGER NOT NULL,
  unit_price NUMERIC,
  sale_value NUMERIC,
  cost_price NUMERIC,
  gross_profit NUMERIC,
  stock_before INTEGER,
  stock_after INTEGER,
  remarks TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE inward (
  id TEXT PRIMARY KEY,           -- IN260624NNNN
  inward_date DATE NOT NULL,
  branch TEXT NOT NULL,
  vehicle TEXT,
  part_name TEXT NOT NULL,
  part_no TEXT,
  qty INTEGER NOT NULL,
  supplier TEXT,
  batch_no TEXT,
  unit_cost NUMERIC,
  total_cost NUMERIC,
  staff_email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  remarks TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  description TEXT
);

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  email TEXT, name TEXT, role TEXT,
  action TEXT, entity TEXT, entity_id TEXT,
  branch TEXT, details TEXT
);

-- Indexes for performance
CREATE INDEX idx_sales_part   ON sales(part_name);
CREATE INDEX idx_sales_date   ON sales(sale_date);
CREATE INDEX idx_sales_branch ON sales(branch);
CREATE INDEX idx_inward_part  ON inward(part_name);
CREATE INDEX idx_inward_branch ON inward(branch);
```

---

## Stock Quantity Formula (CRITICAL — same logic as original)

Current qty is NEVER stored. Always computed:

```sql
-- currentQty for a single part, all branches:
SELECT
  s.init_qty
  + COALESCE(i.total_in, 0)
  - COALESCE(sa.total_out, 0) AS current_qty
FROM stock s
LEFT JOIN (SELECT part_name, SUM(qty) total_in  FROM inward GROUP BY part_name) i  USING(part_name)
LEFT JOIN (SELECT part_name, SUM(qty) total_out FROM sales  GROUP BY part_name) sa USING(part_name)
WHERE s.part_name = $1;

-- For branch-filtered qty:
-- Add WHERE branch = $2 to the inward/sales subqueries
```

Use this as a CTE or view for bulk stock loading. Never add a `current_qty` column to the `stock` table.

---

## Auth — JWT (replaces GAS ScriptProperties sessions)

- Passwords: SHA-256 of `password + 'TVS_SALT_2024'` (same salt as original for migration)
- Use `jsonwebtoken`. Sign on login, verify in middleware.
- Token payload: `{ userId, email, name, role, branch }`
- Token expiry: `8h`
- Frontend stores token in `localStorage` as `dams_token` (unchanged from original)

```js
// middleware/auth.js
const jwt = require('jsonwebtoken');
module.exports = function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ ok: false, msg: 'Session expired' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch { res.status(401).json({ ok: false, msg: 'Session expired' }); }
};
```

---

## API Routes Reference

All routes return `{ ok: true, data: ... }` or `{ ok: false, msg: '...' }`.
Auth routes are public. All others require `Authorization: Bearer <token>` header.

```
POST   /api/auth/login              { email, password } → { ok, token, user }
POST   /api/auth/logout             (clears client token)
POST   /api/auth/change-password    { oldPwd, newPwd }

GET    /api/branches                → active branches list
POST   /api/branches                Admin: create branch
PATCH  /api/branches/:id/status     Admin: toggle Active/Inactive

GET    /api/users                   Admin: all users
POST   /api/users                   Admin: create user
PATCH  /api/users/:id/status        Admin: toggle Active/Inactive

GET    /api/stock                   ?branch= → stock with current qtys
POST   /api/stock                   Admin/Manager: add new part → returns updated VPMAP
GET    /api/stock/vpmap             { vehicle: [partName] } map
GET    /api/stock/qty/:partName     ?branch= → single current qty

GET    /api/sales                   ?branch=&limit=500 → recent sales
POST   /api/sales                   Save sale (validates stock, dedupes invoice)
GET    /api/sales/next-invoice      → { invoiceNo: '0043' }

POST   /api/inward                  Save single inward entry
POST   /api/inward/bulk             Array of rows; auto-creates missing stock entries

GET    /api/dashboard               ?branch=&from=&to= → KPIs + charts + recent
GET    /api/dashboard/drill/:type   ?branch=&from=&to= → table data for KPI drill-down
       types: today_sales, monthly_sales, total_sales, gross_profit,
              stock_value, qty_sold, low_stock, dead_stock, transactions, branch_sales

GET    /api/analytics               ?branch=&from=&to= → full analytics breakdown

GET    /api/settings                Admin only
PUT    /api/settings/:key           Admin only: { value }

POST   /api/report/generate         Writes monthly report to DB / returns JSON
```

---

## Frontend Adapter (index.html changes from original)

The original frontend used `google.script.run`. Replace with a thin wrapper:

```js
// Add this to index.html <script> — replaces google.script.run calls
const API = '/api';

function apiCall(method, path, body) {
  return fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (TOKEN || '')
    },
    body: body ? JSON.stringify(body) : undefined
  }).then(r => r.json());
}

// Map original GAS calls → REST:
// loginUser(email, pwd)           → apiCall('POST', '/auth/login', {email, password: pwd})
// getAppInitData(token)           → apiCall('GET', '/stock/vpmap') + apiCall('GET', '/branches')
// saveSale(token, data)           → apiCall('POST', '/sales', data)
// saveInward(token, data)         → apiCall('POST', '/inward', data)
// bulkSaveInward(token, rows)     → apiCall('POST', '/inward/bulk', rows)
// getAllStock(token, branch)      → apiCall('GET', '/stock?branch=' + branch)
// getDashboardData(token,...)     → apiCall('GET', '/dashboard?branch=&from=&to=')
// getDrillData(token, type, ...) → apiCall('GET', '/dashboard/drill/' + type + '?...')
// getAnalytics(token, ...)       → apiCall('GET', '/analytics?...')
// getRecentSales(token, br, lim) → apiCall('GET', '/sales?branch=&limit=')
// getNextInvoiceNo(token)        → apiCall('GET', '/sales/next-invoice')
// addStockItem(token, ...)       → apiCall('POST', '/stock', {...})
// getAllBranches(token)           → apiCall('GET', '/branches')
// getAllUsers(token)              → apiCall('GET', '/users')
// getSettingsForAdmin(token)     → apiCall('GET', '/settings')
// updateSetting(token, key, val) → apiCall('PUT', '/settings/' + key, {value: val})
```

Remove `TOKEN` from all API calls (it's now in the Authorization header automatically).
The rest of the frontend JS (charts, tables, exports, UI) works unchanged.

---

## server.js Skeleton

```js
require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());
app.use(express.static('public'));

app.use('/api/auth',      require('./routes/auth'));
app.use('/api/branches',  require('./routes/branches'));
app.use('/api/users',     require('./routes/users'));
app.use('/api/stock',     require('./routes/stock'));
app.use('/api/sales',     require('./routes/sales'));
app.use('/api/inward',    require('./routes/inward'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/settings',  require('./routes/settings'));

// SPA fallback
app.get('*', (req, res) => res.sendFile(__dirname + '/public/index.html'));

app.listen(process.env.PORT || 3000, () => console.log('DAMS running on port', process.env.PORT || 3000));
```

## package.json (key deps)
```json
{
  "scripts": { "start": "node server.js", "dev": "nodemon server.js" },
  "dependencies": {
    "express": "^4.19",
    "pg": "^8.11",
    "jsonwebtoken": "^9.0",
    "dotenv": "^16.0",
    "cors": "^2.8"
  },
  "devDependencies": { "nodemon": "^3.0" }
}
```

---

## Railway Deployment Steps

```bash
# 1. Init project
npm init -y && npm install express pg jsonwebtoken dotenv cors

# 2. Push to GitHub

# 3. Railway dashboard → New Project → Deploy from GitHub repo
# 4. Railway dashboard → Add Plugin → PostgreSQL (sets DATABASE_URL automatically)
# 5. Railway dashboard → Variables → add JWT_SECRET

# 6. Run migrations
railway run psql $DATABASE_URL < schema.sql
railway run psql $DATABASE_URL < seed.sql

# 7. Railway auto-deploys on every git push to main
```

**Health check route** (Railway requires it):
```js
app.get('/health', (req, res) => res.json({ status: 'ok' }));
```

---

## Key Business Rules (unchanged from original)

| Rule | Detail |
|------|--------|
| Stock qty | Always computed from init_qty + inward - sales. Never stored. |
| Part name | Primary join key across stock/sales/inward tables. Must be unique. |
| Password hash | SHA-256(password + 'TVS_SALT_2024') — same as original |
| Low stock | Qty ≤ `LOW_STOCK_THRESHOLD` setting (default 5) |
| Dead stock | No sale in last `DEAD_STOCK_DAYS` days (default 90) |
| Invoice dedup | Unique per branch. Check before insert. |
| Branch lock | Non-admin users' branch is enforced server-side from JWT, ignore frontend value |
| Bulk inward | Auto-create missing stock rows with unit_price = cost_price = 0 |
| VPMAP sync | After addStock or bulkInward, return updated VPMAP in response body |

---

## Roles & Permissions

```
Admin          → all routes
Branch_Manager → own branch: read/write stock, sales, inward
Sales_Staff    → POST /sales only (branch locked from JWT)
Store_Staff    → POST /inward, POST /inward/bulk (branch locked)
Accountant     → GET routes only (dashboard, analytics, ledger)
```

---

## Date Format
- DB stores dates as `DATE` (native PostgreSQL) — no format issues
- API sends/receives `yyyy-MM-dd` (ISO) — HTML date inputs work natively
- Frontend: remove `isoBack()` calls — no longer needed with REST API
- Display: format in frontend with `new Date(d).toLocaleDateString('en-IN')`
