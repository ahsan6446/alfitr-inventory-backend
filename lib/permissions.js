const DEFAULT_PERMS = {
  'Super Admin':  { viewPricing:true,  editPricing:true,  exportPricing:true,  viewStockValue:true,  viewProfitMargin:true,  manageStock:true,  createDN:true,  manageInventory:true,  manageUsers:true,  allowNegativeStock:true,  manageQuotations:true,  manageMaterialRequests:true,  manageProcurement:true,  manageReports:true,  manageClients:true,  manageFM:true  },
  'Admin':        { viewPricing:true,  editPricing:true,  exportPricing:true,  viewStockValue:true,  viewProfitMargin:true,  manageStock:true,  createDN:true,  manageInventory:true,  manageUsers:false, allowNegativeStock:true,  manageQuotations:true,  manageMaterialRequests:true,  manageProcurement:true,  manageReports:true,  manageClients:true,  manageFM:true  },
  'Storekeeper':  { viewPricing:false, editPricing:false, exportPricing:false, viewStockValue:false, viewProfitMargin:false, manageStock:true,  createDN:true,  manageInventory:false, manageUsers:false, allowNegativeStock:false, manageQuotations:false, manageMaterialRequests:true,  manageProcurement:false, manageReports:false, manageClients:false, manageFM:false },
  'Engineer':     { viewPricing:false, editPricing:false, exportPricing:false, viewStockValue:false, viewProfitMargin:false, manageStock:false, createDN:false, manageInventory:false, manageUsers:false, allowNegativeStock:false, manageQuotations:false, manageMaterialRequests:true,  manageProcurement:false, manageReports:true,  manageClients:false, manageFM:true  },
  'Supervisor':   { viewPricing:false, editPricing:false, exportPricing:false, viewStockValue:false, viewProfitMargin:false, manageStock:false, createDN:false, manageInventory:false, manageUsers:false, allowNegativeStock:false, manageQuotations:false, manageMaterialRequests:true,  manageProcurement:false, manageReports:true,  manageClients:false, manageFM:true  },
  'Technician':   { viewPricing:false, editPricing:false, exportPricing:false, viewStockValue:false, viewProfitMargin:false, manageStock:false, createDN:false, manageInventory:false, manageUsers:false, allowNegativeStock:false, manageQuotations:false, manageMaterialRequests:false, manageProcurement:false, manageReports:false, manageClients:false, manageFM:true  },
  'Coordinator':  { viewPricing:false, editPricing:false, exportPricing:false, viewStockValue:false, viewProfitMargin:false, manageStock:false, createDN:true,  manageInventory:false, manageUsers:false, allowNegativeStock:false, manageQuotations:false, manageMaterialRequests:true,  manageProcurement:false, manageReports:true,  manageClients:true,  manageFM:true  },
  'Viewer':       { viewPricing:false, editPricing:false, exportPricing:false, viewStockValue:false, viewProfitMargin:false, manageStock:false, createDN:false, manageInventory:false, manageUsers:false, allowNegativeStock:false, manageQuotations:false, manageMaterialRequests:false, manageProcurement:false, manageReports:false, manageClients:false, manageFM:false },
};

const PERM_LABELS = [
  ['viewPricing',            'View Pricing'],
  ['editPricing',            'Edit Pricing'],
  ['exportPricing',          'Export Pricing'],
  ['viewStockValue',         'View Stock Value'],
  ['viewProfitMargin',       'View Profit & Margin'],
  ['manageStock',            'Log Stock Movements'],
  ['createDN',               'Create Delivery Notes'],
  ['manageInventory',        'Add/Edit/Delete Items'],
  ['manageUsers',            'Manage Users & Roles'],
  ['allowNegativeStock',     'Allow Stock to Go Negative'],
  ['manageQuotations',       'Create & Send Quotations'],
  ['manageMaterialRequests', 'Create Material Requests'],
  ['manageProcurement',      'Approve Purchase Requests & Send POs'],
  ['manageReports',          'Create & Edit Site Reports / Job Orders'],
  ['manageClients',          'Add/Edit Clients'],
  ['manageFM',               'FM Services — Checklists & Work Reports'],
];

const PRICING_FIELDS = ['cost', 'price', 'stockValue', 'margin'];

function can(rolesTable, role, permKey) {
  const perms = (rolesTable && rolesTable[role]) || DEFAULT_PERMS[role] || DEFAULT_PERMS['Viewer'];
  return !!perms[permKey];
}

function stripPricingFromItem(item) {
  const clone = { ...item };
  for (const f of PRICING_FIELDS) delete clone[f];
  return clone;
}

function stripPricingFromItems(items) {
  return items.map(stripPricingFromItem);
}

module.exports = { DEFAULT_PERMS, PERM_LABELS, PRICING_FIELDS, can, stripPricingFromItem, stripPricingFromItems };
