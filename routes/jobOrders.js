const express = require('express');
const db = require('../lib/db');
const { requireAuth, requirePermission } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

function nextJobOrderNumber(state) {
  state.jobOrderCounter += 1;
  const yy = new Date().getFullYear();
  return `JO-${yy}-${String(state.jobOrderCounter).padStart(4, '0')}`;
}

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

router.post('/', requirePermission('manageReports'), async (req, res) => {
  const state = db.get();
  const body = req.body || {};
  if (!body.clientCompany || !body.clientCompany.trim()) {
    return res.status(400).json({ error: 'Client company name is required.' });
  }
  const customNumber = (body.jobOrderNumber || '').trim();
  if (customNumber && state.jobOrders.some(j => j.jobOrderNumber === customNumber)) {
    return res.status(400).json({ error: `Job Order number "${customNumber}" is already in use.` });
  }

  const jo = {
    id: db.uuid(),
    jobOrderNumber: customNumber || nextJobOrderNumber(state),
    quotationId: null, quotationNumber: null,
    type: body.type || 'SUP',
    clientId: body.clientId || null, clientCompany: body.clientCompany.trim(),
    subject: body.subject || '', siteDetail: body.siteDetail || '',
    location: body.location || '',
    sitesCovered: [],
    siteEngineer:     body.siteEngineer     || '',
    projectManager:   body.projectManager   || '',
    siteSupervisor:   body.siteSupervisor   || '',
    projectsIncharge: body.projectsIncharge || '',
    preparedBy:       body.preparedBy       || '',
    value: Number(body.value || 0),
    status: body.status || 'Open',
    createdById: req.user.id, createdByName: req.user.name,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  state.jobOrders.push(jo);
  await db.persist();
  res.status(201).json({ jobOrder: jo });
});

router.put('/:id', requirePermission('manageReports'), async (req, res) => {
  const state = db.get();
  const jo = state.jobOrders.find(j => j.id === req.params.id);
  if (!jo) return res.status(404).json({ error: 'Job Order not found.' });
  const body = req.body || {};
  if ('clientCompany' in body && !body.clientCompany.trim()) {
    return res.status(400).json({ error: 'Client company name is required.' });
  }
  if ('jobOrderNumber' in body) {
    const newNumber = body.jobOrderNumber.trim();
    if (newNumber && newNumber !== jo.jobOrderNumber && state.jobOrders.some(j => j.jobOrderNumber === newNumber)) {
      return res.status(400).json({ error: `Job Order number "${newNumber}" is already in use.` });
    }
    if (newNumber) jo.jobOrderNumber = newNumber;
  }
  for (const f of ['clientId', 'clientCompany', 'subject', 'siteDetail', 'location', 'type', 'status']) {
    if (f in body) jo[f] = body[f];
  }
  if ('value' in body) jo.value = Number(body.value || 0);
  jo.updatedAt = Date.now();
  await db.persist();
  res.json({ jobOrder: jo });
});

// Sets the named site team — Al Fitr side + Client side
router.put('/:id/site-team', requirePermission('manageReports'), async (req, res) => {
  const state = db.get();
  const jo = state.jobOrders.find(j => j.id === req.params.id);
  if (!jo) return res.status(404).json({ error: 'Job Order not found.' });
  const body = req.body || {};
  for (const f of ['siteEngineer', 'projectManager', 'siteSupervisor', 'projectsIncharge', 'preparedBy']) {
    if (f in body) jo[f] = String(body[f] || '').trim();
  }
  jo.updatedAt = Date.now();
  await db.persist();
  res.json({ jobOrder: jo });
});

module.exports = router;
