const express = require('express');
const db = require('../lib/db');
const { requireAuth, requirePermission } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

// ── Auto customer number ──────────────────────────────────────────
function nextClientNumber(state) {
  if (!state.clientCounter) state.clientCounter = 0;
  state.clientCounter += 1;
  return `AF-CLT-${String(state.clientCounter).padStart(4, '0')}`;
}

// ── Retroactively assign numbers to existing clients ──────────────
function ensureClientNumbers(state) {
  let changed = false;
  if (!state.clientCounter) state.clientCounter = 0;
  for (const c of state.clients) {
    if (!c.customerNumber) {
      state.clientCounter += 1;
      c.customerNumber = `AF-CLT-${String(state.clientCounter).padStart(4, '0')}`;
      changed = true;
    }
  }
  return changed;
}

// ── GET all clients ───────────────────────────────────────────────
router.get('/', async (req, res) => {
  const state = db.get();
  const changed = ensureClientNumbers(state);
  if (changed) await db.persist();
  res.json({ clients: [...state.clients].sort((a, b) => a.companyName.localeCompare(b.companyName)) });
});

// ── GET single client with full 360 data ─────────────────────────
router.get('/:id', async (req, res) => {
  const state   = db.get();
  const client  = state.clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found.' });

  // Aggregate all linked data
  const quotations     = (state.quotations     || []).filter(q => q.clientId === client.id || q.clientCompany === client.companyName);
  const jobOrders      = (state.jobOrders      || []).filter(j => j.clientId === client.id || j.clientCompany === client.companyName);
  const dns            = (state.dns            || []).filter(d => d.clientId === client.id || d.clientCompany === client.companyName);
  const delayReports   = (state.delayReports   || []).filter(r => jobOrders.some(j => j.id === r.jobOrderId));
  const materialReqs   = (state.materialRequests|| []).filter(m => jobOrders.some(j => j.id === m.jobOrderId));
  const purchaseReqs   = (state.purchaseRequests|| []).filter(p => jobOrders.some(j => j.jobOrderNumber === p.jobOrderNumber));

  // Business value
  const totalQuoteValue    = quotations.reduce((s, q) => s + (q.totals?.total || 0), 0);
  const acceptedQuoteValue = quotations.filter(q => q.status === 'Accepted').reduce((s, q) => s + (q.totals?.total || 0), 0);
  const issuedDns          = dns.filter(d => d.status === 'Issued').length;
  const openDelays         = delayReports.reduce((acc, r) => acc + (r.delayItems||[]).filter(i => i.status === 'Open').length, 0);

  res.json({
    client,
    summary: {
      totalQuoteValue,
      acceptedQuoteValue,
      totalQuotations:   quotations.length,
      acceptedQuotations: quotations.filter(q => q.status === 'Accepted').length,
      totalJobOrders:    jobOrders.length,
      activeJobOrders:   jobOrders.filter(j => j.status === 'Open' || j.status === 'In Process').length,
      totalDns:          dns.length,
      issuedDns,
      openDelays,
      totalDelayReports: delayReports.length,
      totalMRs:          materialReqs.length,
    },
    quotations:     quotations.sort((a,b) => b.createdAt - a.createdAt),
    jobOrders:      jobOrders.sort((a,b) => b.createdAt - a.createdAt),
    dns:            dns.sort((a,b) => b.createdAt - a.createdAt),
    delayReports:   delayReports.sort((a,b) => b.createdAt - a.createdAt),
    materialReqs:   materialReqs.sort((a,b) => b.createdAt - a.createdAt),
  });
});

// ── POST create ───────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const state = db.get();
  const body  = req.body || {};
  if (!body.companyName || !body.companyName.trim()) {
    return res.status(400).json({ error: 'Company name is required.' });
  }
  const client = {
    id:             db.uuid(),
    customerNumber: nextClientNumber(state),
    companyName:    body.companyName.trim(),
    contactPerson:  body.contactPerson  || '',
    phone:          body.phone          || '',
    email:          body.email          || '',
    address:        body.address        || '',
    trn:            body.trn            || '',
    notes:          body.notes          || '',
    createdAt:      Date.now(),
  };
  state.clients.push(client);
  await db.persist();
  res.status(201).json({ client });
});

// ── PUT update ────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const state  = db.get();
  const client = state.clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found.' });
  for (const f of ['companyName','contactPerson','phone','email','address','trn','notes']) {
    if (req.body && f in req.body) client[f] = req.body[f];
  }
  client.updatedAt = Date.now();
  await db.persist();
  res.json({ client });
});

// ── DELETE ────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const state  = db.get();
  const before = state.clients.length;
  state.clients = state.clients.filter(c => c.id !== req.params.id);
  if (state.clients.length === before) return res.status(404).json({ error: 'Client not found.' });
  await db.persist();
  res.json({ ok: true });
});

module.exports = router;
