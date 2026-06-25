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

1. **New Project → Deploy from GitHub repo** → pick this repo.
2. In the project, **+ New → Database → Add PostgreSQL**.
3. Open the **app service → Variables** and add:
   - `JWT_SECRET` — any long random string
     (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`)
   - `NODE_ENV` = `production`
   - **`DATABASE_URL`** — add a *reference variable* pointing to the Postgres
     service: set it to `${{Postgres.DATABASE_URL}}` (so the app and DB are linked).
4. Deploy. On first boot the app **creates the schema and seeds** your branches
   + admin user (`store.init()` runs `CREATE TABLE IF NOT EXISTS` — no migration step).
5. Railway re-deploys automatically on every push to `main`.

Config that ships in the repo ([railway.json](railway.json)):
`npm start`, health check `GET /health`, restart-on-failure.

- **SSL** is handled automatically ([lib/db.js](lib/db.js)): off for the Railway
  private network (`*.railway.internal`) and localhost, on for public/managed
  hosts. Override with `PGSSL=require` or `PGSSL=disable` if needed.
- **Login** after deploy: `admin@tvs.local` / `Admin@123`.
- Health: `GET /health` → `{ status, store: "ready" | "not-configured" }`.

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
