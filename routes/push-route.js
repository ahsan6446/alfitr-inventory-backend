const express = require('express');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { ensureVapidConfigured } = require('../lib/push');

const router = express.Router();
router.use(requireAuth);

router.get('/vapid-public-key', (req, res) => {
  const config = ensureVapidConfigured();
  res.json({ publicKey: config.publicKey });
});

router.get('/status', (req, res) => {
  const state = db.get();
  const subscribed = state.pushSubscriptions.some(s => s.userId === req.user.id);
  res.json({ subscribed });
});

router.post('/subscribe', async (req, res) => {
  const state = db.get();
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Invalid subscription.' });

  // Same device re-subscribing (e.g. after switching accounts) replaces the old entry
  // for that endpoint rather than creating a duplicate.
  const existing = state.pushSubscriptions.find(s => s.subscription.endpoint === subscription.endpoint);
  if (existing) {
    existing.userId = req.user.id;
    existing.subscription = subscription;
    existing.updatedAt = Date.now();
  } else {
    state.pushSubscriptions.push({ id: db.uuid(), userId: req.user.id, subscription, createdAt: Date.now() });
  }
  await db.persist();
  res.status(201).json({ ok: true });
});

router.post('/unsubscribe', async (req, res) => {
  const state = db.get();
  const { endpoint } = req.body || {};
  const before = state.pushSubscriptions.length;
  state.pushSubscriptions = state.pushSubscriptions.filter(s => s.subscription.endpoint !== endpoint);
  if (state.pushSubscriptions.length !== before) await db.persist();
  res.json({ ok: true });
});

module.exports = router;
