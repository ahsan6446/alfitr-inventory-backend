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
