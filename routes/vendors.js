const express = require('express');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const { vendors } = db.get();
  res.json({ vendors: [...vendors].sort((a, b) => a.companyName.localeCompare(b.companyName)) });
});

router.post('/', async (req, res) => {
  const { companyName, contactPerson, phone, email, address } = req.body || {};
  if (!companyName || !companyName.trim()) return res.status(400).json({ error: 'Company name is required.' });
  const state = db.get();
  const vendor = {
    id: db.uuid(), companyName: companyName.trim(), contactPerson: contactPerson || '',
    phone: phone || '', email: email || '', address: address || '', createdAt: Date.now(),
  };
  state.vendors.push(vendor);
  await db.persist();
  res.status(201).json({ vendor });
});

router.put('/:id', async (req, res) => {
  const state = db.get();
  const vendor = state.vendors.find(v => v.id === req.params.id);
  if (!vendor) return res.status(404).json({ error: 'Vendor not found.' });
  const fields = ['companyName', 'contactPerson', 'phone', 'email', 'address'];
  for (const f of fields) if (req.body && f in req.body) vendor[f] = req.body[f];
  await db.persist();
  res.json({ vendor });
});

router.delete('/:id', async (req, res) => {
  const state = db.get();
  const before = state.vendors.length;
  state.vendors = state.vendors.filter(v => v.id !== req.params.id);
  if (state.vendors.length === before) return res.status(404).json({ error: 'Vendor not found.' });
  await db.persist();
  res.json({ ok: true });
});

module.exports = router;
