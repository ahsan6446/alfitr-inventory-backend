const express = require('express');
const db = require('../lib/db');
const { requireAuth, requirePermission } = require('../lib/auth');

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

// Sets the named site team once on the Job Order — every Delay Report raised against
// this job then pulls these names automatically instead of asking again each time.
router.put('/:id/site-team', requirePermission('manageReports'), async (req, res) => {
  const state = db.get();
  const jo = state.jobOrders.find(j => j.id === req.params.id);
  if (!jo) return res.status(404).json({ error: 'Job Order not found.' });
  const body = req.body || {};
  for (const f of ['siteEngineer', 'projectManager', 'siteSupervisor', 'projectsIncharge']) {
    if (f in body) jo[f] = String(body[f] || '').trim();
  }
  jo.updatedAt = Date.now();
  await db.persist();
  res.json({ jobOrder: jo });
});

module.exports = router;
