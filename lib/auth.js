const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  console.warn('\n⚠️  WARNING: JWT_SECRET is not set in the environment. Using an insecure default.');
  console.warn('   Set a real JWT_SECRET before deploying to production (see .env.example).\n');
  return 'INSECURE-DEV-SECRET-CHANGE-ME';
})();

const TOKEN_TTL = '12h';

function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// Middleware: requires a valid bearer token (or auth cookie), attaches req.user
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = bearer || req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    req.user = verifyToken(token);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }
}

// Middleware factory: requires a specific permission, evaluated against the CURRENT
// roles table in the DB (not a stale copy from the token), so admin changes to a role's
// permissions take effect immediately for everyone with that role.
function requirePermission(permKey) {
  const { can } = require('./permissions');
  const db = require('./db');
  return (req, res, next) => {
    const { roles } = db.get();
    if (!can(roles, req.user.role, permKey)) {
      return res.status(403).json({ error: `Your role (${req.user.role}) does not have the "${permKey}" permission.` });
    }
    next();
  };
}

module.exports = { signToken, verifyToken, requireAuth, requirePermission, JWT_SECRET };
