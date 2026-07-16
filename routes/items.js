const express = require('express');
const db = require('../lib/db');
const { requireAuth, requirePermission } = require('../lib/auth');
const { can, stripPricingFromItems, stripPricingFromItem } = require('../lib/permissions');
const { enrichItem } = require('../lib/calc');

const router = express.Router();
router.use(requireAuth);

function visiblePricing(req) {
  const { roles } = db.get();
  return can(roles, req.user.role, 'viewPricing');
}

router.get('/', (req, res) => {
  const { items, movements } = db.get();
  let enriched = items.map(it => enrichItem(it, movements));
  if (!visiblePricing(req)) enriched = stripPricingFromItems(enriched);
  res.json({ items: enriched });
});

router.post('/', requirePermission('manageInventory'), async (req, res) => {
  const { brand, partNo, description, location, unit, minLevel, cost, price, openingQty } = req.body || {};
  if (!description || !String(description).trim()) return res.status(400).json({ error: 'Item description is required.' });
  const state = db.get();
  const item = {
    id: db.uuid(), brand: brand || '', partNo: partNo || '', description: description.trim(),
    location: location || state.branches[0], unit: unit || state.units[0],
    minLevel: Number(minLevel || 0), cost: Number(cost || 0), price: Number(price || 0),
    openingQty: Number(openingQty || 0), createdAt: Date.now(),
  };
  state.items.push(item);
  await db.persist();
  const enriched = enrichItem(item, state.movements);
  res.status(201).json({ item: visiblePricing(req) ? enriched : stripPricingFromItem(enriched) });
});

router.put('/:id', requirePermission('manageInventory'), async (req, res) => {
  const state = db.get();
  const item = state.items.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  const editingPricing = ('cost' in (req.body||{})) || ('price' in (req.body||{}));
  if (editingPricing && !can(state.roles, req.user.role, 'editPricing')) {
    return res.status(403).json({ error: 'Your role cannot edit pricing.' });
  }
  const fields = ['brand','partNo','description','location','unit','minLevel','cost','price','openingQty'];
  for (const f of fields) {
    if (req.body && f in req.body) {
      item[f] = ['minLevel','cost','price','openingQty'].includes(f) ? Number(req.body[f]) : req.body[f];
    }
  }
  await db.persist();
  const enriched = enrichItem(item, state.movements);
  res.json({ item: visiblePricing(req) ? enriched : stripPricingFromItem(enriched) });
});

router.delete('/:id', requirePermission('manageInventory'), async (req, res) => {
  const state = db.get();
  const before = state.items.length;
  state.items = state.items.filter(i => i.id !== req.params.id);
  if (state.items.length === before) return res.status(404).json({ error: 'Item not found.' });
  await db.persist();
  res.json({ ok: true });
});

module.exports = router;
