// middleware/auth.js — JWT validation + role guard
const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ ok: false, msg: 'Session expired' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ ok: false, msg: 'Session expired' });
  }
}

// requireRole('Admin', 'Branch_Manager') — use after requireAuth
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ ok: false, msg: 'Forbidden' });
    }
    next();
  };
}

module.exports = requireAuth;
module.exports.requireAuth = requireAuth;
module.exports.requireRole = requireRole;
