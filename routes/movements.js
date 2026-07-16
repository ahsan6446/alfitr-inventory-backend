const express = require('express');
const db = require('../lib/db');
const { requireAuth, requirePermission } = require('../lib/auth');
const { can } = require('../lib/permissions');
const { itemQty } = require('../lib/calc');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const { movements } = db.get();
  res.json({ movements: [...movements].sort((a, b) => b.createdAt - a.createdAt) });
});

router.post('/', requirePermission('manageStock'), async (req, res) => {
  const state = db.get();
  const { itemId, action, qty, date, reference, by } = req.body || {};
  const item = state.items.find(i => i.id === itemId);
  if (!item) return res.status(400).json({ error: 'Please select a valid item.' });
  if (!['IN', 'OUT', 'ADJUSTMENT'].includes(action)) return res.status(400).json({ error: 'Invalid action.' });
  const qn = Number(qty);
  if (!qn || (action !== 'ADJUSTMENT' && qn <= 0)) return res.status(400).json({ error: 'Enter a valid quantity.' });
  if (action === 'ADJUSTMENT' && qn === 0) return res.status(400).json({ error: 'Adjustment quantity cannot be zero.' });

  if (!can(state.roles, req.user.role, 'allowNegativeStock')) {
    const current = itemQty(item, state.movements);
    const resulting = action === 'OUT' ? current - qn : (action === 'ADJUSTMENT' ? current + qn : current);
    if (resulting < 0) {
      return res.status(403).json({ error: `This would take ${item.description} to ${resulting} — negative stock needs Admin approval.` });
    }
  }

  const mv = {
    id: db.uuid(), itemId, action, qty: qn, date: date || new Date().toISOString().slice(0, 10),
    reference: reference || '', by: by || req.user.name, dnId: null, createdAt: Date.now(),
  };
  state.movements.push(mv);
  await db.persist();
  res.status(201).json({ movement: mv });
});

module.exports = router;
