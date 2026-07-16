const express = require('express');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const { clients } = db.get();
  res.json({ clients: [...clients].sort((a, b) => a.companyName.localeCompare(b.companyName)) });
});

router.post('/', async (req, res) => {
  const { companyName, contactPerson, phone, email, address } = req.body || {};
  if (!companyName || !companyName.trim()) return res.status(400).json({ error: 'Company name is required.' });
  const state = db.get();
  const client = {
    id: db.uuid(), companyName: companyName.trim(), contactPerson: contactPerson || '',
    phone: phone || '', email: email || '', address: address || '', createdAt: Date.now(),
  };
  state.clients.push(client);
  await db.persist();
  res.status(201).json({ client });
});

router.put('/:id', async (req, res) => {
  const state = db.get();
  const client = state.clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found.' });
  const fields = ['companyName', 'contactPerson', 'phone', 'email', 'address'];
  for (const f of fields) if (req.body && f in req.body) client[f] = req.body[f];
  await db.persist();
  res.json({ client });
});

router.delete('/:id', async (req, res) => {
  const state = db.get();
  const before = state.clients.length;
  state.clients = state.clients.filter(c => c.id !== req.params.id);
  if (state.clients.length === before) return res.status(404).json({ error: 'Client not found.' });
  await db.persist();
  res.json({ ok: true });
});

module.exports = router;
