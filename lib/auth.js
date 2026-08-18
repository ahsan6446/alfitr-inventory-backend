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

// Resolves who a record should be credited to. Only Super Admin can attribute a record
// to someone other than whoever is actually logged in — e.g. when they're operating the
// software on behalf of the person who really did the work, or backfilling historical
// data. Everyone else is always attributed to themselves, with no way to override this
// even by calling the API directly (this check happens server-side, not just hidden in
// the UI). `fieldName` is the attribution's prefix, e.g. 'preparedBy' expects
// body.preparedByName / body.preparedByDesignation.
function resolveAttribution(req, state, body, fieldName) {
  const actualUser = (state.users || []).find(u => u.id === req.user.id);
  const overrideName = body && body[fieldName + 'Name'];
  if (req.user.role === 'Super Admin' && overrideName && String(overrideName).trim()) {
    return {
      id: null, // an overridden name may not correspond to any real account
      name: String(overrideName).trim(),
      designation: ((body[fieldName + 'Designation'] || '')).trim(),
    };
  }
  return {
    id: req.user.id,
    name: req.user.name,
    designation: (actualUser && actualUser.designation) || '',
  };
}

module.exports = { signToken, verifyToken, requireAuth, requirePermission, resolveAttribution, JWT_SECRET };
