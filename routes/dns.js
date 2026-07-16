const express = require('express');
const db = require('../lib/db');
const { requireAuth, requirePermission } = require('../lib/auth');
const { can } = require('../lib/permissions');
const { itemQty } = require('../lib/calc');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const { dns } = db.get();
  res.json({ dns: [...dns].sort((a, b) => b.createdAt - a.createdAt) });
});

router.get('/:id', (req, res) => {
  const { dns } = db.get();
  const dn = dns.find(d => d.id === req.params.id);
  if (!dn) return res.status(404).json({ error: 'Delivery note not found.' });
  res.json({ dn });
});

function nextDnNumber(state) {
  state.dnCounter += 1;
  const prefix = state.company.dnPrefix || 'DN-';
  const padding = state.company.dnPadding || 6;
  return prefix + String(state.dnCounter).padStart(padding, '0');
}

function validateLines(lines, state) {
  if (!Array.isArray(lines) || lines.length === 0) return 'Add at least one item line.';
  for (const ln of lines) {
    if (!ln.itemId || !state.items.find(i => i.id === ln.itemId)) return 'One of the item lines is invalid.';
    if (!ln.qty || Number(ln.qty) <= 0) return 'Every line needs a quantity greater than zero.';
  }
  return null;
}

router.post('/', requirePermission('createDN'), async (req, res) => {
  const state = db.get();
  const body = req.body || {};
  const lines = (body.items || []).map(l => ({ itemId: l.itemId, qty: Number(l.qty) }));
  const err = validateLines(lines, state);
  if (err) return res.status(400).json({ error: err });

  const issue = !!body.issue;
  if (issue && !can(state.roles, req.user.role, 'allowNegativeStock')) {
    for (const ln of lines) {
      const it = state.items.find(i => i.id === ln.itemId);
      const resulting = itemQty(it, state.movements) - ln.qty;
      if (resulting < 0) {
        return res.status(403).json({ error: `Issuing would take ${it.description} to ${resulting} — negative stock needs Admin approval.` });
      }
    }
  }

  const dn = {
    id: db.uuid(), dnNumber: nextDnNumber(state), date: body.date || new Date().toISOString().slice(0, 10),
    clientId: body.clientId || null, clientCompany: body.clientCompany || '', clientContact: body.clientContact || '',
    clientPhone: body.clientPhone || '', clientEmail: body.clientEmail || '', clientAddress: body.clientAddress || '',
    project: body.project || '', lpoNumber: body.lpoNumber || '', invoiceNumber: body.invoiceNumber || '',
    location: body.location || state.branches[0], issuedBy: body.issuedBy || req.user.name, receivedBy: body.receivedBy || '',
    items: lines, remarks: body.remarks || '', status: issue ? 'Issued' : 'Draft', createdAt: Date.now(),
  };
  state.dns.push(dn);

  if (issue) {
    for (const ln of lines) {
      state.movements.push({
        id: db.uuid(), itemId: ln.itemId, action: 'OUT', qty: ln.qty, date: dn.date,
        reference: 'DN ' + dn.dnNumber + (dn.clientCompany ? ' — ' + dn.clientCompany : ''),
        by: dn.issuedBy, dnId: dn.id, createdAt: Date.now(),
      });
    }
  }
  await db.persist();
  res.status(201).json({ dn });
});

// Issue an existing draft
router.post('/:id/issue', requirePermission('createDN'), async (req, res) => {
  const state = db.get();
  const dn = state.dns.find(d => d.id === req.params.id);
  if (!dn) return res.status(404).json({ error: 'Delivery note not found.' });
  if (dn.status === 'Issued') return res.status(400).json({ error: 'This delivery note is already issued.' });

  if (!can(state.roles, req.user.role, 'allowNegativeStock')) {
    for (const ln of dn.items) {
      const it = state.items.find(i => i.id === ln.itemId);
      if (!it) continue;
      const resulting = itemQty(it, state.movements) - ln.qty;
      if (resulting < 0) {
        return res.status(403).json({ error: `Issuing would take ${it.description} to ${resulting} — negative stock needs Admin approval.` });
      }
    }
  }

  for (const ln of dn.items) {
    state.movements.push({
      id: db.uuid(), itemId: ln.itemId, action: 'OUT', qty: ln.qty, date: dn.date,
      reference: 'DN ' + dn.dnNumber + (dn.clientCompany ? ' — ' + dn.clientCompany : ''),
      by: dn.issuedBy, dnId: dn.id, createdAt: Date.now(),
    });
  }
  dn.status = 'Issued';
  await db.persist();
  res.json({ dn });
});

// Update a draft (drafts only — issued DNs are immutable to keep the audit trail honest)
router.put('/:id', requirePermission('createDN'), async (req, res) => {
  const state = db.get();
  const dn = state.dns.find(d => d.id === req.params.id);
  if (!dn) return res.status(404).json({ error: 'Delivery note not found.' });
  if (dn.status === 'Issued') return res.status(400).json({ error: 'Issued delivery notes cannot be edited.' });

  const body = req.body || {};
  if (body.items) {
    const lines = body.items.map(l => ({ itemId: l.itemId, qty: Number(l.qty) }));
    const err = validateLines(lines, state);
    if (err) return res.status(400).json({ error: err });
    dn.items = lines;
  }
  const fields = ['date','clientId','clientCompany','clientContact','clientPhone','clientEmail','clientAddress',
    'project','lpoNumber','invoiceNumber','location','issuedBy','receivedBy','remarks'];
  for (const f of fields) if (f in body) dn[f] = body[f];
  await db.persist();
  res.json({ dn });
});

module.exports = router;
