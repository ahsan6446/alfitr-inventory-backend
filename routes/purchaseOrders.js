const express = require('express');
const db = require('../lib/db');
const { requireAuth, requirePermission } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

function nextPoNumber(state) {
  state.purchaseOrderCounter += 1;
  const yy = new Date().getFullYear();
  return `PO-${yy}-${String(state.purchaseOrderCounter).padStart(4, '0')}`;
}

function computePoStatus(po) {
  if (po.status === 'Cancelled') return 'Cancelled';
  if (po.status === 'Draft') return 'Draft';
  const allReceived = po.lineItems.every(l => l.qtyReceived >= l.qtyOrdered);
  const anyReceived = po.lineItems.some(l => l.qtyReceived > 0);
  if (allReceived) return 'Received';
  if (anyReceived) return 'PartiallyReceived';
  return 'Sent';
}
function withComputed(po) { return { ...po, status: computePoStatus(po) }; }

router.get('/', (req, res) => {
  const { purchaseOrders } = db.get();
  res.json({ purchaseOrders: [...purchaseOrders].sort((a, b) => b.createdAt - a.createdAt).map(withComputed) });
});

router.get('/:id', (req, res) => {
  const { purchaseOrders } = db.get();
  const po = purchaseOrders.find(p => p.id === req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase Order not found.' });
  res.json({ purchaseOrder: withComputed(po) });
});

// Created only from an approved Purchase Request — the vendor, unit costs, and expected
// date get set here; the actual items/quantities always trace back to the PR (and, through
// it, back to the Material Request that first flagged the shortfall).
router.post('/', requirePermission('manageProcurement'), async (req, res) => {
  const state = db.get();
  const body = req.body || {};
  const pr = state.purchaseRequests.find(p => p.id === body.purchaseRequestId);
  if (!pr) return res.status(400).json({ error: 'Select a valid Purchase Request.' });
  if (pr.status !== 'Approved') return res.status(400).json({ error: 'Only an approved Purchase Request can be converted to a Purchase Order.' });
  if (pr.purchaseOrderId) return res.status(400).json({ error: 'This Purchase Request already has a linked Purchase Order.' });
  const vendor = state.vendors.find(v => v.id === body.vendorId);
  if (!vendor) return res.status(400).json({ error: 'Select a valid vendor.' });

  const lineItems = pr.lineItems.map(l => ({
    id: db.uuid(), prLineId: l.id, itemId: l.itemId, description: l.description, brand: l.brand, partNo: l.partNo,
    unit: l.unit, qtyOrdered: l.qty, qtyReceived: 0,
    unitCost: Number((body.unitCosts && body.unitCosts[l.id]) || 0),
  }));

  const po = {
    id: db.uuid(),
    poNumber: nextPoNumber(state),
    purchaseRequestId: pr.id, purchaseRequestNumber: pr.prNumber,
    materialRequestId: pr.materialRequestId, materialRequestNumber: pr.materialRequestNumber,
    jobOrderId: pr.jobOrderId, jobOrderNumber: pr.jobOrderNumber,
    vendorId: vendor.id, vendorName: vendor.companyName, vendorContact: vendor.contactPerson, vendorEmail: vendor.email,
    status: 'Draft',
    date: new Date().toISOString().slice(0, 10),
    expectedDate: body.expectedDate || '',
    lineItems,
    notes: body.notes || '',
    createdById: req.user.id, createdByName: req.user.name,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  state.purchaseOrders.push(po);
  pr.purchaseOrderId = po.id;
  pr.status = 'Converted';
  pr.updatedAt = Date.now();
  await db.persist();
  res.status(201).json({ purchaseOrder: withComputed(po) });
});

router.put('/:id', requirePermission('manageProcurement'), async (req, res) => {
  const state = db.get();
  const po = state.purchaseOrders.find(p => p.id === req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase Order not found.' });
  if (computePoStatus(po) !== 'Draft') return res.status(400).json({ error: 'Only a draft Purchase Order can be edited.' });
  const body = req.body || {};
  if ('expectedDate' in body) po.expectedDate = body.expectedDate;
  if ('notes' in body) po.notes = body.notes;
  if (body.unitCosts) {
    for (const l of po.lineItems) if (body.unitCosts[l.id] !== undefined) l.unitCost = Number(body.unitCosts[l.id]);
  }
  po.updatedAt = Date.now();
  await db.persist();
  res.json({ purchaseOrder: withComputed(po) });
});

router.post('/:id/send', requirePermission('manageProcurement'), async (req, res) => {
  const state = db.get();
  const po = state.purchaseOrders.find(p => p.id === req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase Order not found.' });
  if (computePoStatus(po) !== 'Draft') return res.status(400).json({ error: 'This Purchase Order has already been sent.' });
  po.status = 'Sent';
  po.updatedAt = Date.now();
  await db.persist();
  res.json({ purchaseOrder: withComputed(po) });
});

// Receiving a line creates a real IN stock movement, tagged back to this PO — the same
// mechanism used everywhere else stock enters or leaves (Delivery Notes, Material Requests).
router.post('/:id/receive-line', requirePermission('manageStock'), async (req, res) => {
  const state = db.get();
  const po = state.purchaseOrders.find(p => p.id === req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase Order not found.' });
  const status = computePoStatus(po);
  if (status === 'Draft') return res.status(400).json({ error: 'Send this Purchase Order to the vendor before receiving goods against it.' });
  if (status === 'Cancelled') return res.status(400).json({ error: 'This Purchase Order has been cancelled.' });

  const { lineId, qty } = req.body || {};
  const line = po.lineItems.find(l => l.id === lineId);
  if (!line) return res.status(400).json({ error: 'Line item not found on this order.' });
  const qn = Number(qty);
  if (!qn || qn <= 0) return res.status(400).json({ error: 'Enter a valid quantity received.' });
  const remaining = line.qtyOrdered - line.qtyReceived;
  if (qn > remaining) return res.status(400).json({ error: `Only ${remaining} ${line.unit} remain on order for this line.` });

  const item = state.items.find(i => i.id === line.itemId);
  if (!item) return res.status(400).json({ error: 'The item on this line no longer exists.' });

  state.movements.push({
    id: db.uuid(), itemId: item.id, action: 'IN', qty: qn, date: new Date().toISOString().slice(0, 10),
    reference: `Purchase Order ${po.poNumber} — ${po.vendorName}`,
    by: req.user.name, dnId: null, purchaseOrderId: po.id, createdAt: Date.now(),
  });
  line.qtyReceived += qn;
  po.updatedAt = Date.now();
  await db.persist();
  res.json({ purchaseOrder: withComputed(po) });
});

router.post('/:id/cancel', requirePermission('manageProcurement'), async (req, res) => {
  const state = db.get();
  const po = state.purchaseOrders.find(p => p.id === req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase Order not found.' });
  if (po.lineItems.some(l => l.qtyReceived > 0)) {
    return res.status(400).json({ error: 'Goods have already been received against this order — it cannot be cancelled.' });
  }
  po.status = 'Cancelled';
  po.updatedAt = Date.now();
  await db.persist();
  res.json({ purchaseOrder: withComputed(po) });
});

module.exports = router;
