const express = require('express');
const db = require('../lib/db');
const { requireAuth, requirePermission } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

function listRoutes(key) {
  router.get(`/${key}`, (req, res) => {
    res.json({ [key]: db.get()[key] });
  });
  router.post(`/${key}`, requirePermission('manageInventory'), async (req, res) => {
    const state = db.get();
    const value = (req.body && req.body.value || '').trim();
    if (!value) return res.status(400).json({ error: 'Value is required.' });
    if (!state[key].includes(value)) state[key].push(value);
    await db.persist();
    res.json({ [key]: state[key] });
  });
  router.delete(`/${key}/:value`, requirePermission('manageInventory'), async (req, res) => {
    const state = db.get();
    state[key] = state[key].filter(v => v !== req.params.value);
    await db.persist();
    res.json({ [key]: state[key] });
  });
}

listRoutes('branches');
listRoutes('brands');
listRoutes('units');

module.exports = router;
