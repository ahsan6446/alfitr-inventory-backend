const express = require('express');
const db = require('../lib/db');
const { requireAuth, requirePermission } = require('../lib/auth');
const { can } = require('../lib/permissions');
const { itemQty } = require('../lib/calc');

const router = express.Router();
router.use(requireAuth);

function nextMrNumber(state) {
  state.materialRequestCounter += 1;
  const yy = new Date().getFullYear();
  return `MR-${yy}-${String(state.materialRequestCounter).padStart(4, '0')}`;
}

// A request's overall status is derived from its lines, never stored redundantly —
// so it can never drift out of sync with what's actually been fulfilled.
function computeMrStatus(mr) {
  if (mr.status === 'Cancelled') return 'Cancelled';
  const lines = mr.lineItems || [];
  if (lines.length === 0) return 'Requested';
  const allFulfilled = lines.every(l => l.qtyFulfilled >= l.qtyRequested);
  const anyFulfilled = lines.some(l => l.qtyFulfilled > 0);
  if (allFulfilled) return 'Fulfilled';
  if (anyFulfilled) return 'PartiallyFulfilled';
  return 'Requested';
}

function withComputed(mr) {
  return { ...mr, status: computeMrStatus(mr) };
}

router.get('/', (req, res) => {
  const { materialRequests } = db.get();
  res.json({ materialRequests: [...materialRequests].sort((a, b) => b.createdAt - a.createdAt).map(withComputed) });
});

router.get('/:id', (req, res) => {
  const { materialRequests } = db.get();
  const mr = materialRequests.find(m => m.id === req.params.id);
  if (!mr) return res.status(404).json({ error: 'Material Request not found.' });
  res.json({ materialRequest: withComputed(mr) });
});

router.post('/', requirePermission('manageMaterialRequests'), async (req, res) => {
  const state = db.get();
  const body = req.body || {};
  const jo = state.jobOrders.find(j => j.id === body.jobOrderId);
  if (!jo) return res.status(400).json({ error: 'Select a valid Job Order.' });
  if (!Array.isArray(body.lineItems) || body.lineItems.length === 0) return res.status(400).json({ error: 'Add at least one line item.' });

  // Optional quotation link
  let linkedQuotation = null;
  if (body.quotationId) {
    linkedQuotation = (state.quotations || []).find(q => q.id === body.quotationId);
  }

  const lineItems = [];
  for (const l of body.lineItems) {
    // Support both inventory items and custom text items (from quotation or manual)
    if (l.isCustom || !l.itemId) {
      // Custom line — description required
      if (!l.description || !String(l.description).trim()) continue;
      const qty = Number(l.qty);
      if (!qty || qty <= 0) return res.status(400).json({ error: `Enter a valid quantity for ${l.description}.` });
      lineItems.push({
        id: db.uuid(), itemId: null, description: l.description,
        brand: l.brand || '', partNo: l.partNo || '', unit: l.unit || 'Pcs',
        qtyRequested: qty, qtyFulfilled: 0, isCustom: true,
      });
    } else {
      const item = state.items.find(i => i.id === l.itemId);
      if (!item) return res.status(400).json({ error: 'One of the selected items is invalid.' });
      const qty = Number(l.qty);
      if (!qty || qty <= 0) return res.status(400).json({ error: `Enter a valid quantity for ${item.description}.` });
      lineItems.push({
        id: db.uuid(), itemId: item.id, description: item.description, brand: item.brand,
        partNo: item.partNo || '', unit: item.unit, qtyRequested: qty, qtyFulfilled: 0, isCustom: false,
      });
    }
  }

  if (lineItems.length === 0) return res.status(400).json({ error: 'Add at least one valid line item.' });

  const mr = {
    id: db.uuid(),
    mrNumber: nextMrNumber(state),
    jobOrderId: jo.id, jobOrderNumber: jo.jobOrderNumber,
    clientCompany: jo.clientCompany,
    quotationId:     linkedQuotation ? linkedQuotation.id : null,
    quotationNumber: linkedQuotation ? linkedQuotation.quotationNumber : null,
    requestedById: req.user.id, requestedByName: req.user.name,
    status: 'Requested',
    date: body.date || new Date().toISOString().slice(0, 10),
    neededBy: body.neededBy || '',
    notes: body.notes || '',
    lineItems,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  state.materialRequests.push(mr);
  await db.persist();
  res.status(201).json({ materialRequest: withComputed(mr) });
});

router.put('/:id', requirePermission('manageMaterialRequests'), async (req, res) => {
  const state = db.get();
  const mr = state.materialRequests.find(m => m.id === req.params.id);
  if (!mr) return res.status(404).json({ error: 'Material Request not found.' });
  if (computeMrStatus(mr) !== 'Requested') {
    return res.status(400).json({ error: 'Only a request with nothing fulfilled yet can be edited.' });
  }
  const body = req.body || {};
  if (Array.isArray(body.lineItems)) {
    const lineItems = [];
    for (const l of body.lineItems) {
      if (l.isCustom || !l.itemId) {
        if (!l.description || !String(l.description).trim()) continue;
        const qty = Number(l.qty);
        if (!qty || qty <= 0) return res.status(400).json({ error: `Enter a valid quantity for ${l.description}.` });
        lineItems.push({
          id: l.id || db.uuid(), itemId: null, description: l.description,
          brand: l.brand || '', partNo: l.partNo || '', unit: l.unit || 'Pcs',
          qtyRequested: qty, qtyFulfilled: 0, isCustom: true,
        });
      } else {
        const item = state.items.find(i => i.id === l.itemId);
        if (!item) return res.status(400).json({ error: 'One of the selected items is invalid.' });
        const qty = Number(l.qty);
        if (!qty || qty <= 0) return res.status(400).json({ error: `Enter a valid quantity for ${item.description}.` });
        lineItems.push({
          id: l.id || db.uuid(), itemId: item.id, description: item.description, brand: item.brand,
          partNo: item.partNo || '', unit: item.unit, qtyRequested: qty, qtyFulfilled: 0, isCustom: false,
        });
      }
    }
    mr.lineItems = lineItems;
  }
  if ('neededBy' in body) mr.neededBy = body.neededBy;
  if ('notes' in body) mr.notes = body.notes;
  mr.updatedAt = Date.now();
  await db.persist();
  res.json({ materialRequest: withComputed(mr) });
});

router.post('/:id/cancel', requirePermission('manageMaterialRequests'), async (req, res) => {
  const state = db.get();
  const mr = state.materialRequests.find(m => m.id === req.params.id);
  if (!mr) return res.status(404).json({ error: 'Material Request not found.' });
  if (mr.lineItems.some(l => l.qtyFulfilled > 0)) {
    return res.status(400).json({ error: 'This request already has material issued against it and cannot be cancelled — the stock movements would no longer match what the request says.' });
  }
  mr.status = 'Cancelled';
  mr.updatedAt = Date.now();
  await db.persist();
  res.json({ materialRequest: withComputed(mr) });
});

// Fulfilling a line releases stock exactly like issuing a Delivery Note does — same
// negative-stock guard, same movement record shape, just tagged back to this request
// instead of a DN so the trail is traceable either way.
router.post('/:id/fulfill-line', requirePermission('manageStock'), async (req, res) => {
  const state = db.get();
  const mr = state.materialRequests.find(m => m.id === req.params.id);
  if (!mr) return res.status(404).json({ error: 'Material Request not found.' });
  if (mr.status === 'Cancelled') return res.status(400).json({ error: 'This request has been cancelled.' });

  const { lineId, qty } = req.body || {};
  const line = mr.lineItems.find(l => l.id === lineId);
  if (!line) return res.status(400).json({ error: 'Line item not found on this request.' });
  const qn = Number(qty);
  if (!qn || qn <= 0) return res.status(400).json({ error: 'Enter a valid quantity to fulfill.' });
  const remaining = line.qtyRequested - line.qtyFulfilled;
  if (qn > remaining) return res.status(400).json({ error: `Only ${remaining} ${line.unit} remain requested on this line.` });

  const item = state.items.find(i => i.id === line.itemId);
  if (!item) return res.status(400).json({ error: 'The item on this line no longer exists.' });

  if (!can(state.roles, req.user.role, 'allowNegativeStock')) {
    const current = itemQty(item, state.movements);
    if (current - qn < 0) {
      return res.status(403).json({ error: `This would take ${item.description} to ${current - qn} — negative stock needs Admin approval.` });
    }
  }

  state.movements.push({
    id: db.uuid(), itemId: item.id, action: 'OUT', qty: qn, date: new Date().toISOString().slice(0, 10),
    reference: `Material Request ${mr.mrNumber} — Job Order ${mr.jobOrderNumber}`,
    by: req.user.name, dnId: null, materialRequestId: mr.id, createdAt: Date.now(),
  });
  line.qtyFulfilled += qn;
  mr.updatedAt = Date.now();
  await db.persist();
  res.json({ materialRequest: withComputed(mr) });
});

module.exports = router;
