// Central permission model. This is the SAME shape as the client-side prototype,
// but here it is the source of truth enforced on the server — clients cannot bypass it.

const DEFAULT_PERMS = {
  'Super Admin': { viewPricing:true,  editPricing:true,  exportPricing:true, viewStockValue:true,  viewProfitMargin:true,  manageStock:true, createDN:true, manageInventory:true, manageUsers:true,  allowNegativeStock:true, manageQuotations:true },
  'Admin':       { viewPricing:true,  editPricing:true,  exportPricing:true, viewStockValue:true,  viewProfitMargin:true,  manageStock:true, createDN:true, manageInventory:true, manageUsers:false, allowNegativeStock:true, manageQuotations:true },
  'Storekeeper': { viewPricing:false, editPricing:false, exportPricing:false, viewStockValue:false, viewProfitMargin:false, manageStock:true, createDN:true, manageInventory:false, manageUsers:false, allowNegativeStock:false, manageQuotations:false },
  'Engineer':    { viewPricing:false, editPricing:false, exportPricing:false, viewStockValue:false, viewProfitMargin:false, manageStock:false, createDN:false, manageInventory:false, manageUsers:false, allowNegativeStock:false, manageQuotations:false },
  'Viewer':      { viewPricing:false, editPricing:false, exportPricing:false, viewStockValue:false, viewProfitMargin:false, manageStock:false, createDN:false, manageInventory:false, manageUsers:false, allowNegativeStock:false, manageQuotations:false },
};

const PERM_LABELS = [
  ['viewPricing','View Pricing'], ['editPricing','Edit Pricing'], ['exportPricing','Export Pricing'],
  ['viewStockValue','View Stock Value'], ['viewProfitMargin','View Profit & Margin'],
  ['manageStock','Log Stock Movements'], ['createDN','Create Delivery Notes'],
  ['manageInventory','Add/Edit/Delete Items'], ['manageUsers','Manage Users & Roles'],
  ['allowNegativeStock','Allow Stock to Go Negative'], ['manageQuotations','Create & Send Quotations'],
];

const PRICING_FIELDS = ['cost', 'price', 'stockValue', 'margin'];

/**
 * can(rolesTable, role, permKey) -> boolean
 * Always resolves against the CURRENT roles table stored in the DB (admin-editable),
 * falling back to DEFAULT_PERMS for an unknown role.
 */
function can(rolesTable, role, permKey) {
  const perms = (rolesTable && rolesTable[role]) || DEFAULT_PERMS[role] || DEFAULT_PERMS['Viewer'];
  return !!perms[permKey];
}

/**
 * Strips pricing-related fields from a single item (or any object) in place-safe way.
 * This is the server-side enforcement point: called right before any JSON, Excel, or
 * PDF response is produced, so unauthorized roles never receive the bytes at all —
 * not hidden client-side, genuinely absent from the payload.
 */
function stripPricingFromItem(item) {
  const clone = { ...item };
  for (const f of PRICING_FIELDS) delete clone[f];
  return clone;
}

function stripPricingFromItems(items) {
  return items.map(stripPricingFromItem);
}

module.exports = { DEFAULT_PERMS, PERM_LABELS, PRICING_FIELDS, can, stripPricingFromItem, stripPricingFromItems };
