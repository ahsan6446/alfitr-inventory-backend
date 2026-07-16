const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const { signToken, requireAuth } = require('../lib/auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

  const { users } = db.get();
  const user = users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
  if (!user || user.active === false) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  if (!bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const token = signToken(user);
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 });
  res.json({
    token,
    user: { id: user.id, name: user.name, username: user.username, role: user.role, mustChangePassword: !!user.mustChangePassword },
  });
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const { users, roles } = db.get();
  const user = users.find(u => u.id === req.user.id);
  if (!user || user.active === false) return res.status(401).json({ error: 'Account no longer active.' });
  res.json({
    user: { id: user.id, name: user.name, username: user.username, role: user.role, mustChangePassword: !!user.mustChangePassword },
    permissions: roles[user.role] || roles['Viewer'],
  });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }
  const state = db.get();
  const user = state.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (!bcrypt.compareSync(currentPassword || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  user.mustChangePassword = false;
  await db.persist();
  res.json({ ok: true });
});

module.exports = router;
