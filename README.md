# DAMS — Dharani Accessories Management System

TVS accessories inventory for the branches of Bhavani Dharani TVS.
Node.js + Express, **PostgreSQL** backend, single-page frontend, deploys to Railway.

The app keeps an in-memory cache over Postgres (loaded on boot, synced on every
write) so dashboard/analytics aggregation runs in JS. The schema is created
automatically on first boot and seeded with the branches + admin user.

## Stock identity (important)

A stock item is identified by **part name + part number** (a DB unique key).
Two parts can share a name as long as their part numbers differ — they stay
separate everywhere (stock, inward, sales, transfers, quantity math). A part
with no number normalises to `—`.

## Run locally

You need PostgreSQL running and a `DATABASE_URL` in `.env`
(default points at a local `dams` database).

```bash
# one-time: create the database (Homebrew Postgres example)
createdb dams        # or: psql -c "CREATE DATABASE dams;"

npm install
npm run dev          # http://localhost:3000  (schema auto-creates + seeds)
```

To wipe and start fresh, drop the tables — they're recreated on next boot:

```bash
psql -d dams -c "DROP TABLE IF EXISTS branches, users, stock, sales, inward, transfers, settings, audit_log CASCADE;"
```

### Default login

`admin@tvs.local` / `Admin@123` (Admin, all branches). Change it via
**Users → Edit** after first login.

## Deploy to Railway

1. Push this repo to GitHub.
2. Railway → New Project → Deploy from GitHub repo.
3. Add the **PostgreSQL** plugin — it sets `DATABASE_URL` automatically.
4. **Variables** → add `JWT_SECRET` (any long random string) and `NODE_ENV=production`.
5. Railway auto-deploys on push to `main`. The schema is created + seeded on
   first boot. Health check: `GET /health` → `{ status, store: "ready" | "not-configured" }`.

No migration step is needed — `store.init()` runs the DDL (`CREATE TABLE IF NOT EXISTS`).

## Layout

```
server.js            Express entry (store.init, /health, /api guard, SPA)
lib/db.js            pg Pool + query helper
lib/store.js         Postgres-backed store: cache, CRUD, ids, seed, write lock,
                     composite (name+part_no) stock identity, dashboard/qty compute
lib/util.js          pure helpers (password hash, date helpers)
middleware/auth.js   requireAuth (JWT) + requireRole guards
routes/              auth, branches, users, stock, sales, inward, transfers,
                     dashboard, analytics, settings, config, report
public/index.html    role-aware SPA (light theme, PDF invoices)
```

## Notes

- **Stock qty is never stored** — computed as `init_qty + inward + transfers-in − sales − transfers-out`,
  keyed on (part name + part no), branch-scoped when a branch is selected.
- **Branch lock**: non-admin users' branch comes from the JWT server-side.
- **Passwords**: `SHA-256(password + 'TVS_SALT_2024')`, matching the original app.
- **Invoices** auto-number per branch (unique index `uq_sales_invoice_branch`), and
  a PDF invoice (with GST/CGST/SGST from Settings) is generated per sale.
- **Admin-only**: settings, users, branches, and stock add/edit/delete.
  Deleting a stock item also removes that exact part's inward/transfer history.
