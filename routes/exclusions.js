const express = require('express');
const db = require('../lib/db');
const { requireAuth, requirePermission } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const { exclusions } = db.get();
  res.json({ exclusions: [...exclusions].sort((a, b) => a.text.localeCompare(b.text)) });
});

router.post('/', requirePermission('manageQuotations'), async (req, res) => {
  const state = db.get();
  const text = (req.body && req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Text is required.' });
  const category = (req.body && req.body.category) || 'General';
  const item = { id: db.uuid(), text, category, createdAt: Date.now() };
  state.exclusions.push(item);
  await db.persist();
  res.status(201).json({ exclusion: item });
});

router.delete('/:id', requirePermission('manageQuotations'), async (req, res) => {
  const state = db.get();
  const before = state.exclusions.length;
  state.exclusions = state.exclusions.filter(e => e.id !== req.params.id);
  if (state.exclusions.length === before) return res.status(404).json({ error: 'Not found.' });
  await db.persist();
  res.json({ ok: true });
});

module.exports = router;
