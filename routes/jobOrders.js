const express = require('express');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const { jobOrders } = db.get();
  res.json({ jobOrders: [...jobOrders].sort((a, b) => b.createdAt - a.createdAt) });
});

router.get('/:id', (req, res) => {
  const { jobOrders } = db.get();
  const jo = jobOrders.find(j => j.id === req.params.id);
  if (!jo) return res.status(404).json({ error: 'Job Order not found.' });
  res.json({ jobOrder: jo });
});

module.exports = router;
