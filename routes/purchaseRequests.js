const express = require('express');
const db = require('../lib/db');
const { requireAuth, requirePermission } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

function nextPrNumber(state) {
  state.purchaseRequestCounter += 1;
  const yy = new Date().getFullYear();
  return `PR-${yy}-${String(state.purchaseRequestCounter).padStart(4, '0')}`;
}

router.get('/', (req, res) => {
  const { purchaseRequests } = db.get();
  res.json({ purchaseRequests: [...purchaseRequests].sort((a, b) => b.createdAt - a.createdAt) });
});

router.get('/:id', (req, res) => {
  const { purchaseRequests } = db.get();
  const pr = purchaseRequests.find(p => p.id === req.params.id);
  if (!pr) return res.status(404).json({ error: 'Purchase Request not found.' });
  res.json({ purchaseRequest: pr });
});

// Raised directly from a Material Request's shortfall — every line here traces back
// to a specific MR line, so there's always a clear reason a purchase was needed.
router.post('/', requirePermission('manageMaterialRequests'), async (req, res) => {
  const state = db.get();
  const body = req.body || {};
  const mr = state.materialRequests.find(m => m.id === body.materialRequestId);
  if (!mr) return res.status(400).json({ error: 'Select a valid Material Request.' });
  if (!Array.isArray(body.lineItems) || body.lineItems.length === 0) return res.status(400).json({ error: 'Select at least one shortfall line.' });

  const lineItems = [];
  for (const l of body.lineItems) {
    const mrLine = mr.lineItems.find(x => x.id === l.mrLineId);
    if (!mrLine) return res.status(400).json({ error: 'One of the selected Material Request lines is invalid.' });
    const item = state.items.find(i => i.id === mrLine.itemId);
    if (!item) return res.status(400).json({ error: 'One of the items no longer exists.' });
    const qty = Number(l.qty);
    if (!qty || qty <= 0) return res.status(400).json({ error: `Enter a valid quantity for ${item.description}.` });
    lineItems.push({
      id: db.uuid(), mrLineId: mrLine.id, itemId: item.id, description: item.description,
      brand: item.brand, partNo: item.partNo || '', unit: item.unit, qty,
    });
  }

  const pr = {
    id: db.uuid(),
    prNumber: nextPrNumber(state),
    materialRequestId: mr.id, materialRequestNumber: mr.mrNumber,
    jobOrderId: mr.jobOrderId, jobOrderNumber: mr.jobOrderNumber,
    status: 'Requested',
    requestedById: req.user.id, requestedByName: req.user.name,
    date: new Date().toISOString().slice(0, 10),
    lineItems,
    notes: body.notes || '',
    approvedById: null, approvedByName: null, approvedAt: null,
    rejectionReason: null,
    purchaseOrderId: null,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  state.purchaseRequests.push(pr);
  await db.persist();
  res.status(201).json({ purchaseRequest: pr });
});

router.post('/:id/approve', requirePermission('manageProcurement'), async (req, res) => {
  const state = db.get();
  const pr = state.purchaseRequests.find(p => p.id === req.params.id);
  if (!pr) return res.status(404).json({ error: 'Purchase Request not found.' });
  if (pr.status !== 'Requested') return res.status(400).json({ error: 'This request is not awaiting approval.' });
  pr.status = 'Approved';
  pr.approvedById = req.user.id; pr.approvedByName = req.user.name; pr.approvedAt = Date.now();
  pr.updatedAt = Date.now();
  await db.persist();
  res.json({ purchaseRequest: pr });
});

router.post('/:id/reject', requirePermission('manageProcurement'), async (req, res) => {
  const state = db.get();
  const pr = state.purchaseRequests.find(p => p.id === req.params.id);
  if (!pr) return res.status(404).json({ error: 'Purchase Request not found.' });
  if (pr.status !== 'Requested') return res.status(400).json({ error: 'This request is not awaiting approval.' });
  pr.status = 'Rejected';
  pr.rejectionReason = (req.body && req.body.reason) || '';
  pr.updatedAt = Date.now();
  await db.persist();
  res.json({ purchaseRequest: pr });
});

module.exports = router;
