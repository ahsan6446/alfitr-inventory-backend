const express = require('express');
const db = require('../lib/db');
const { requireAuth, requirePermission } = require('../lib/auth');
const { can } = require('../lib/permissions');
const { quotationTotals } = require('../lib/calc');
const { generateQuotationPdf } = require('../lib/quotePdf');

const router = express.Router();
router.use(requireAuth);

const TYPE_PREFIX = { PR: 'PR', SUP: 'SUP', AMC: 'AMC', FO: 'FO' };

function nextQuotationNumber(state, type) {
  state.quotationCounter += 1;
  const prefix = TYPE_PREFIX[type] || 'PR';
  const yy = String(new Date().getFullYear()).slice(-2);
  return `AF/${prefix}/${state.quotationCounter}/${yy}`;
}

function nextJobOrderNumber(state) {
  state.jobOrderCounter += 1;
  const yy = new Date().getFullYear();
  return `JO-${yy}-${String(state.jobOrderCounter).padStart(4, '0')}`;
}

function isApprover(state, user) {
  if (user.role === 'Super Admin') return true;
  return (state.company.quotationApprovers || []).includes(user.id);
}

function withTotals(q) {
  return { ...q, totals: quotationTotals(q) };
}

router.get('/', (req, res) => {
  const { quotations } = db.get();
  res.json({ quotations: [...quotations].sort((a, b) => b.createdAt - a.createdAt).map(withTotals) });
});

router.get('/approvers-list', requirePermission('manageQuotations'), (req, res) => {
  // Convenience endpoint so the frontend can show approver names without a users fetch permission mismatch
  const { users, company } = db.get();
  const approverIds = new Set(company.quotationApprovers || []);
  res.json({ approvers: users.filter(u => approverIds.has(u.id)).map(u => ({ id: u.id, name: u.name })) });
});

router.get('/:id', (req, res) => {
  const { quotations } = db.get();
  const q = quotations.find(x => x.id === req.params.id);
  if (!q) return res.status(404).json({ error: 'Quotation not found.' });
  res.json({ quotation: withTotals(q) });
});

router.get('/:id/pdf', async (req, res) => {
  const { quotations } = db.get();
  const q = quotations.find(x => x.id === req.params.id);
  if (!q) return res.status(404).json({ error: 'Quotation not found.' });
  try {
    await generateQuotationPdf(q, res);
  } catch (e) {
    console.error('Quotation PDF generation failed', e);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate PDF.' });
  }
});

function validatePayload(body, state) {
  if (!body.type || !TYPE_PREFIX[body.type]) return 'Invalid quotation type.';
  if (!body.clientCompany || !body.clientCompany.trim()) return 'Client company name is required.';
  if (body.type !== 'AMC') {
    if (!Array.isArray(body.lineItems) || body.lineItems.length === 0) return 'Add at least one line item.';
    for (const l of body.lineItems) {
      if (!l.description || !String(l.description).trim()) return 'Every line item needs a description.';
      if (!l.qty || Number(l.qty) <= 0) return 'Every line item needs a quantity greater than zero.';
    }
  } else {
    if (!body.amc || !body.amc.services || body.amc.services.length === 0) return 'Add at least one AMC service line.';
  }
  return null;
}

router.post('/', requirePermission('manageQuotations'), async (req, res) => {
  const state = db.get();
  const body = req.body || {};
  const err = validatePayload(body, state);
  if (err) return res.status(400).json({ error: err });

  const preparer = state.users.find(u => u.id === req.user.id);
  const q = {
    id: db.uuid(),
    quotationNumber: null, // assigned only when first sent, so drafts don't burn real sequence numbers
    type: body.type,
    status: 'Draft',
    date: body.date || new Date().toISOString().slice(0, 10),
    validityDays: Number(body.validityDays || 15),
    clientId: body.clientId || null,
    clientCompany: body.clientCompany.trim(),
    clientAttn: body.clientAttn || '',
    clientContact: body.clientContact || '',
    clientEmail: body.clientEmail || '',
    clientPoBox: body.clientPoBox || '',
    subject: body.subject || '',
    siteDetail: body.siteDetail || '',
    sitesCovered: Array.isArray(body.sitesCovered) ? body.sitesCovered : [],
    lineItems: Array.isArray(body.lineItems) ? body.lineItems.map(l => ({
      id: db.uuid(), category: l.category || 'General', siteId: l.siteId || null,
      itemId: l.itemId || null, description: l.description, brand: l.brand || '', partNo: l.partNo || '',
      unit: l.unit || 'Pcs', qty: Number(l.qty), unitPrice: Number(l.unitPrice || 0), isCustom: !l.itemId,
    })) : [],
    amc: body.type === 'AMC' ? {
      scopeOfAgreement: body.amc?.scopeOfAgreement || '',
      contractStart: body.amc?.contractStart || '',
      contractEnd: body.amc?.contractEnd || '',
      services: Array.isArray(body.amc?.services) ? body.amc.services : [],
      manpower: Array.isArray(body.amc?.manpower) ? body.amc.manpower : [],
      maintenanceSchedule: body.amc?.maintenanceSchedule || 'Quarterly',
    } : null,
    discount: Number(body.discount || 0),
    showVat: body.showVat !== false,
    paymentTerms: body.paymentTerms || '',
    exclusions: Array.isArray(body.exclusions) ? body.exclusions : [],
    notes: body.notes || '',
    preparedById: req.user.id,
    preparedByName: req.user.name,
    preparedByDesignation: (preparer && preparer.designation) || '',
    approverIds: [],
    approvedById: null, approvedByName: null, approvedByDesignation: null, approvedAt: null,
    rejectionReason: null,
    sentAt: null,
    clientDecision: null, clientDecisionAt: null, clientDecisionNote: null,
    jobOrderId: null,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  if (body.type === 'AMC') q.lineItems = []; // AMC quotes use q.amc.services instead of flat line items

  state.quotations.push(q);
  await db.persist();
  res.status(201).json({ quotation: withTotals(q) });
});

router.put('/:id', requirePermission('manageQuotations'), async (req, res) => {
  const state = db.get();
  const q = state.quotations.find(x => x.id === req.params.id);
  if (!q) return res.status(404).json({ error: 'Quotation not found.' });
  if (!['Draft', 'Rejected'].includes(q.status)) {
    return res.status(400).json({ error: 'Only draft or internally-rejected quotations can be edited. Sent quotations are locked for the audit trail.' });
  }
  const body = req.body || {};
  const err = validatePayload({ ...q, ...body }, state);
  if (err) return res.status(400).json({ error: err });

  const editable = ['date', 'validityDays', 'clientId', 'clientCompany', 'clientAttn', 'clientContact', 'clientEmail',
    'clientPoBox', 'subject', 'siteDetail', 'sitesCovered', 'discount', 'showVat', 'paymentTerms', 'exclusions', 'notes'];
  for (const f of editable) if (f in body) q[f] = body[f];
  if (Array.isArray(body.lineItems)) {
    q.lineItems = body.lineItems.map(l => ({
      id: l.id || db.uuid(), category: l.category || 'General', siteId: l.siteId || null,
      itemId: l.itemId || null, description: l.description, brand: l.brand || '', partNo: l.partNo || '',
      unit: l.unit || 'Pcs', qty: Number(l.qty), unitPrice: Number(l.unitPrice || 0), isCustom: !l.itemId,
    }));
  }
  if (body.amc && q.type === 'AMC') q.amc = { ...q.amc, ...body.amc };
  if (q.status === 'Rejected') q.status = 'Draft'; // editing a rejected quote sends it back to draft for resubmission
  q.updatedAt = Date.now();
  await db.persist();
  res.json({ quotation: withTotals(q) });
});

router.delete('/:id', requirePermission('manageQuotations'), async (req, res) => {
  const state = db.get();
  const q = state.quotations.find(x => x.id === req.params.id);
  if (!q) return res.status(404).json({ error: 'Quotation not found.' });
  if (q.status !== 'Draft') return res.status(400).json({ error: 'Only draft quotations can be deleted.' });
  state.quotations = state.quotations.filter(x => x.id !== req.params.id);
  await db.persist();
  res.json({ ok: true });
});

// ---- Approval workflow ----
router.post('/:id/submit', requirePermission('manageQuotations'), async (req, res) => {
  const state = db.get();
  const q = state.quotations.find(x => x.id === req.params.id);
  if (!q) return res.status(404).json({ error: 'Quotation not found.' });
  if (q.status !== 'Draft') return res.status(400).json({ error: 'Only draft quotations can be submitted for approval.' });
  if ((state.company.quotationApprovers || []).length === 0) {
    return res.status(400).json({ error: 'No approvers are configured yet. Ask a Super Admin to set them in Settings.' });
  }
  q.status = 'PendingApproval';
  q.updatedAt = Date.now();
  await db.persist();
  res.json({ quotation: withTotals(q) });
});

router.post('/:id/approve', async (req, res) => {
  const state = db.get();
  const q = state.quotations.find(x => x.id === req.params.id);
  if (!q) return res.status(404).json({ error: 'Quotation not found.' });
  if (!isApprover(state, req.user)) return res.status(403).json({ error: 'You are not an authorized approver for quotations.' });
  if (q.status !== 'PendingApproval') return res.status(400).json({ error: 'This quotation is not awaiting approval.' });
  q.status = 'Approved';
  const approver = state.users.find(u => u.id === req.user.id);
  q.approvedById = req.user.id; q.approvedByName = req.user.name; q.approvedByDesignation = (approver && approver.designation) || ''; q.approvedAt = Date.now();
  q.updatedAt = Date.now();
  await db.persist();
  res.json({ quotation: withTotals(q) });
});

router.post('/:id/reject', async (req, res) => {
  const state = db.get();
  const q = state.quotations.find(x => x.id === req.params.id);
  if (!q) return res.status(404).json({ error: 'Quotation not found.' });
  if (!isApprover(state, req.user)) return res.status(403).json({ error: 'You are not an authorized approver for quotations.' });
  if (q.status !== 'PendingApproval') return res.status(400).json({ error: 'This quotation is not awaiting approval.' });
  q.status = 'Rejected';
  q.rejectionReason = (req.body && req.body.reason) || '';
  q.updatedAt = Date.now();
  await db.persist();
  res.json({ quotation: withTotals(q) });
});

// ---- Send to client ----
router.post('/:id/send', requirePermission('manageQuotations'), async (req, res) => {
  const state = db.get();
  const q = state.quotations.find(x => x.id === req.params.id);
  if (!q) return res.status(404).json({ error: 'Quotation not found.' });
  if (q.status !== 'Approved') return res.status(400).json({ error: 'Only an approved quotation can be sent.' });
  if (!q.quotationNumber) {
    if (q.revisionOf && q.baseQuotationNumber) {
      // Revisions keep the original's number with an -R suffix, rather than burning a new sequential number
      q.quotationNumber = `${q.baseQuotationNumber}-R${q.revisionNumber}`;
    } else {
      q.quotationNumber = nextQuotationNumber(state, q.type);
      q.baseQuotationNumber = q.quotationNumber;
    }
  }
  q.status = 'Sent';
  q.sentAt = Date.now();
  q.updatedAt = Date.now();
  await db.persist();
  res.json({ quotation: withTotals(q) });
});

// ---- Client decision ----
router.post('/:id/client-decision', requirePermission('manageQuotations'), async (req, res) => {
  const state = db.get();
  const q = state.quotations.find(x => x.id === req.params.id);
  if (!q) return res.status(404).json({ error: 'Quotation not found.' });
  if (q.status !== 'Sent') return res.status(400).json({ error: 'Only a sent quotation can record a client decision.' });
  const decision = (req.body && req.body.decision) || '';
  if (!['Accepted', 'Declined'].includes(decision)) return res.status(400).json({ error: 'Decision must be Accepted or Declined.' });
  q.status = decision;
  q.clientDecision = decision;
  q.clientDecisionAt = Date.now();
  q.clientDecisionNote = (req.body && req.body.note) || '';
  q.updatedAt = Date.now();
  await db.persist();
  res.json({ quotation: withTotals(q) });
});

// ---- Convert accepted quote to Job Order (manual trigger, per Ahsan's spec) ----
router.post('/:id/convert-to-job-order', requirePermission('manageQuotations'), async (req, res) => {
  const state = db.get();
  const q = state.quotations.find(x => x.id === req.params.id);
  if (!q) return res.status(404).json({ error: 'Quotation not found.' });
  if (q.status !== 'Accepted') return res.status(400).json({ error: 'Only an accepted quotation can be converted to a Job Order.' });
  if (q.jobOrderId) return res.status(400).json({ error: 'This quotation already has a linked Job Order.' });

  const jo = {
    id: db.uuid(),
    jobOrderNumber: nextJobOrderNumber(state),
    quotationId: q.id,
    quotationNumber: q.quotationNumber,
    type: q.type,
    clientId: q.clientId, clientCompany: q.clientCompany,
    subject: q.subject, siteDetail: q.siteDetail,
    sitesCovered: q.sitesCovered,
    value: quotationTotals(q).total,
    status: 'Open',
    createdById: req.user.id, createdByName: req.user.name,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  state.jobOrders.push(jo);
  q.jobOrderId = jo.id;
  q.updatedAt = Date.now();
  await db.persist();
  res.status(201).json({ jobOrder: jo, quotation: withTotals(q) });
});

// ---- Revise a sent quote (client asked for a discount, BOQ change, etc.) ----
router.post('/:id/revise', requirePermission('manageQuotations'), async (req, res) => {
  const state = db.get();
  const orig = state.quotations.find(x => x.id === req.params.id);
  if (!orig) return res.status(404).json({ error: 'Quotation not found.' });
  if (!['Sent', 'Accepted', 'Declined'].includes(orig.status)) {
    return res.status(400).json({ error: 'Only a sent, accepted, or declined quotation can be revised.' });
  }
  if (orig.supersededByQuotationId) {
    return res.status(400).json({ error: 'This quotation has already been revised. Revise the latest revision instead.' });
  }

  const preparer = state.users.find(u => u.id === req.user.id);
  const revision = {
    ...JSON.parse(JSON.stringify(orig)), // deep-copy every editable field (client, items, terms, exclusions, etc.)
    id: db.uuid(),
    quotationNumber: null, // assigned again on send, using the base number below + new revision suffix
    baseQuotationNumber: orig.baseQuotationNumber || orig.quotationNumber,
    revisionOf: orig.id,
    revisionNumber: (orig.revisionNumber || 0) + 1,
    status: 'Draft',
    preparedById: req.user.id,
    preparedByName: req.user.name,
    preparedByDesignation: (preparer && preparer.designation) || '',
    approverIds: [],
    approvedById: null, approvedByName: null, approvedByDesignation: null, approvedAt: null,
    rejectionReason: null,
    sentAt: null,
    clientDecision: null, clientDecisionAt: null, clientDecisionNote: null,
    jobOrderId: null,
    supersededByQuotationId: null,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  state.quotations.push(revision);
  orig.supersededByQuotationId = revision.id;
  orig.updatedAt = Date.now();
  await db.persist();
  res.status(201).json({ quotation: withTotals(revision) });
});

module.exports = router;
