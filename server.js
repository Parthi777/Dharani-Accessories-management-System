// server.js — DAMS Express entry point (PostgreSQL backend)
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const store = require('./lib/store');

// Fail-loud reminders for the two required env vars (the app still boots so the
// health check and SPA work, but these must be set for login/data to work).
if (!process.env.JWT_SECRET) console.warn('⚠️  JWT_SECRET is not set — set it in your environment / Railway Variables (login will fail without it).');
if (!process.env.DATABASE_URL) console.warn('⚠️  DATABASE_URL is not set — add the Railway PostgreSQL plugin or set it locally.');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' })); // bulk inward can be large
app.use(express.static(path.join(__dirname, 'public')));

// Health check (Railway requires it) — also reports backend readiness.
app.get('/health', (req, res) => res.json({ status: 'ok', store: store.ready ? 'ready' : 'not-configured' }));

// If the Google Sheets backend isn't configured, every /api call returns a
// clear 503 (instead of crashing) so the SPA still loads and shows the reason.
app.use('/api', (req, res, next) => {
  if (store.ready) return next();
  res.status(503).json({
    ok: false,
    msg: 'Database not ready. ' + (store.error || 'Set DATABASE_URL and restart.'),
  });
});

// API routes
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/branches',  require('./routes/branches'));
app.use('/api/users',     require('./routes/users'));
app.use('/api/stock',     require('./routes/stock'));
app.use('/api/sales',     require('./routes/sales'));
app.use('/api/inward',    require('./routes/inward'));
app.use('/api/transfers', require('./routes/transfers'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/settings',  require('./routes/settings'));
app.use('/api/config',    require('./routes/config'));
app.use('/api/report',    require('./routes/report'));

// Unknown API path → JSON 404 (don't fall through to the SPA)
app.use('/api', (req, res) => res.status(404).json({ ok: false, msg: 'Not found' }));

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Central error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ ok: false, msg: 'Server error' });
});

const PORT = process.env.PORT || 3000;

// Start the HTTP server FIRST so the health check passes and the SPA loads even
// while (or if) the database is still connecting. /api routes return 503 until
// store.ready flips true. This avoids a hung DB connection blocking startup and
// causing Railway's "Application failed to respond".
app.listen(PORT, () => console.log('DAMS running on port', PORT));

// Connect to the database in the background.
store.init()
  .then(() => console.log('PostgreSQL backend ready'))
  .catch((e) => {
    store.ready = false;
    store.error = e.message;
    console.error('\n⚠️  Database NOT ready:', e.message);
    console.error('    The app is running; fix DATABASE_URL and redeploy.\n');
  });

module.exports = app;
