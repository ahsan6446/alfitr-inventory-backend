const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const { requireAuth, requirePermission } = require('../lib/auth');
const { PERM_LABELS } = require('../lib/permissions');

const router = express.Router();
router.use(requireAuth);

function publicUser(u) {
  return { id: u.id, name: u.name, username: u.username, role: u.role, designation: u.designation || '', active: u.active !== false, createdAt: u.createdAt };
}

router.get('/', requirePermission('manageUsers'), (req, res) => {
  const { users } = db.get();
  res.json({ users: users.map(publicUser) });
});

router.post('/', requirePermission('manageUsers'), async (req, res) => {
  const state = db.get();
  const { name, username, password, role, active, designation } = req.body || {};
  if (!name || !username || !password) return res.status(400).json({ error: 'Name, username and password are required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (state.users.find(u => u.username.toLowerCase() === String(username).toLowerCase())) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }
  if (!state.roles[role]) return res.status(400).json({ error: 'Unknown role.' });
  const user = {
    id: db.uuid(), name, username, passwordHash: bcrypt.hashSync(password, 10),
    role, designation: (designation || '').trim(), active: active !== false, mustChangePassword: true, createdAt: Date.now(),
  };
  state.users.push(user);
  await db.persist();
  res.status(201).json({ user: publicUser(user) });
});

router.put('/:id', requirePermission('manageUsers'), async (req, res) => {
  const state = db.get();
  const user = state.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const { name, role, active, password, designation } = req.body || {};
  if (role && role !== user.role) {
    if (!state.roles[role]) return res.status(400).json({ error: 'Unknown role.' });
    if (user.role === 'Super Admin') {
      const activeSuperAdmins = state.users.filter(u => u.role === 'Super Admin' && u.active !== false);
      if (activeSuperAdmins.length <= 1) return res.status(400).json({ error: 'Cannot change the role of the only active Super Admin.' });
    }
    user.role = role;
  }
  if (typeof name === 'string' && name.trim()) user.name = name.trim();
  if (typeof designation === 'string') user.designation = designation.trim();
  if (typeof active === 'boolean') {
    if (user.role === 'Super Admin' && active === false) {
      const activeSuperAdmins = state.users.filter(u => u.role === 'Super Admin' && u.active !== false);
      if (activeSuperAdmins.length <= 1) return res.status(400).json({ error: 'Cannot deactivate the only active Super Admin.' });
    }
    user.active = active;
  }
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    user.passwordHash = bcrypt.hashSync(password, 10);
    user.mustChangePassword = true;
  }
  await db.persist();
  res.json({ user: publicUser(user) });
});

router.delete('/:id', requirePermission('manageUsers'), async (req, res) => {
  const state = db.get();
  const target = state.users.find(u => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.role === 'Super Admin') {
    const activeSuperAdmins = state.users.filter(u => u.role === 'Super Admin' && u.active !== false);
    if (activeSuperAdmins.length <= 1) return res.status(400).json({ error: 'Cannot delete the only active Super Admin.' });
  }
  state.users = state.users.filter(u => u.id !== req.params.id);
  await db.persist();
  res.json({ ok: true });
});

// ---- Roles / permission grid ----
router.get('/roles/all', requirePermission('manageUsers'), (req, res) => {
  const { roles } = db.get();
  res.json({ roles, labels: PERM_LABELS });
});

router.put('/roles/:role', requirePermission('manageUsers'), async (req, res) => {
  const state = db.get();
  const roleName = req.params.role;
  if (!state.roles[roleName]) return res.status(404).json({ error: 'Unknown role.' });
  if (roleName === 'Super Admin') return res.status(400).json({ error: 'Super Admin permissions cannot be restricted.' });
  const perms = req.body || {};
  for (const [key] of PERM_LABELS) {
    if (key in perms) state.roles[roleName][key] = !!perms[key];
  }
  await db.persist();
  res.json({ role: state.roles[roleName] });
});

module.exports = router;
