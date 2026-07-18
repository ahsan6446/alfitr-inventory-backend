function itemQty(item, movements) {
  let inQ = 0, outQ = 0, adj = 0;
  for (const m of movements) {
    if (m.itemId !== item.id) continue;
    if (m.action === 'IN') inQ += Number(m.qty);
    else if (m.action === 'OUT') outQ += Number(m.qty);
    else if (m.action === 'ADJUSTMENT') adj += Number(m.qty);
  }
  return Number(item.openingQty || 0) + inQ - outQ + adj;
}

function itemStatus(item, movements) {
  const q = itemQty(item, movements);
  const min = Number(item.minLevel || 0);
  if (q <= 0) return 'OUT OF STOCK';
  if (q < min * 0.5) return 'CRITICAL';
  if (q < min) return 'LOW STOCK';
  return 'IN STOCK';
}

// Attaches computed qty/status/stockValue/margin to a plain item record.
function enrichItem(item, movements) {
  const qty = itemQty(item, movements);
  const status = itemStatus(item, movements);
  const cost = Number(item.cost || 0);
  const price = Number(item.price || 0);
  return {
    ...item,
    qty,
    status,
    stockValue: qty * cost,
    margin: price > 0 ? (price - cost) / price : null,
  };
}

module.exports = { itemQty, itemStatus, enrichItem };

// ---------------- Quotation helpers ----------------

function lineTotal(line) {
  return Number(line.qty || 0) * Number(line.unitPrice || 0);
}

// Groups line items by category (Fire Alarm System, PAVA, etc.) with subtotals —
// mirrors the real "Article 1 summary / Article 2 itemized BOQ" structure Al Fitr uses.
function groupLinesByCategory(lineItems) {
  const groups = [];
  const byCategory = new Map();
  for (const line of lineItems || []) {
    const cat = line.category || 'General';
    if (!byCategory.has(cat)) {
      const g = { category: cat, lines: [], subtotal: 0 };
      byCategory.set(cat, g);
      groups.push(g);
    }
    const g = byCategory.get(cat);
    g.lines.push(line);
    g.subtotal += lineTotal(line);
  }
  return groups;
}

// Groups line items by site/building (only meaningful when sitesCovered is used).
function groupLinesBySite(lineItems, sitesCovered) {
  const groups = [];
  const bySite = new Map();
  const siteName = (id) => (sitesCovered || []).find(s => s.id === id)?.name || 'Unassigned';
  for (const line of lineItems || []) {
    const key = line.siteId || '__none__';
    if (!bySite.has(key)) {
      const g = { siteId: line.siteId || null, siteName: line.siteId ? siteName(line.siteId) : null, lines: [], subtotal: 0 };
      bySite.set(key, g);
      groups.push(g);
    }
    const g = bySite.get(key);
    g.lines.push(line);
    g.subtotal += lineTotal(line);
  }
  return groups;
}

const VAT_RATE = 0.05;

function quotationTotals(quotation) {
  const source = (quotation.type === 'AMC') ? (quotation.amc && quotation.amc.services || []) : (quotation.lineItems || []);
  const subtotal = source.reduce((s, l) => s + lineTotal(l), 0);
  const discount = Number(quotation.discount || 0);
  const taxable = Math.max(0, subtotal - discount);
  const vat = quotation.showVat === false ? 0 : taxable * VAT_RATE;
  const total = taxable + vat;
  return { subtotal, discount, taxable, vat, total };
}

module.exports.lineTotal = lineTotal;
module.exports.groupLinesByCategory = groupLinesByCategory;
module.exports.groupLinesBySite = groupLinesBySite;
module.exports.quotationTotals = quotationTotals;
module.exports.VAT_RATE = VAT_RATE;
