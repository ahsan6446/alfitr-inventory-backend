/* ============================================================
   AL FITR — INVENTORY & DELIVERY (API-backed client)
   All data lives on the server. This file only renders what the
   server sends back — pricing fields are simply absent from the
   JSON for roles that shouldn't see them, not hidden client-side.
============================================================ */

const root = document.getElementById('root');
let authToken = localStorage.getItem('af_token') || null;

/* ---------------- API client ---------------- */
async function api(method, path, body, isForm) {
  const headers = {};
  if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
  let payload = body;
  if (body && !isForm) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 401) {
    authToken = null; localStorage.removeItem('af_token');
    state.user = null; state.loaded = false;
    render();
    throw new Error('Session expired. Please log in again.');
  }
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

async function apiDownload(path) {
  const headers = {};
  if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
  const res = await fetch(path, { headers });
  if (!res.ok) {
    let msg = 'Export failed.';
    try { msg = (await res.json()).error || msg; } catch (e) {}
    throw new Error(msg);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="(.+)"/);
  const filename = match ? match[1] : 'download';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
}

/* ---------------- state ---------------- */
const state = {
  tab: 'dashboard', branch: 'All', search: '', invFilter: 'All', exportIncludePricing: true, drFilter: 'All',
  fmChecklists: [], fmTemplates: [], fmChecklistView: null,
  fmFilterClient: 'All', fmFilterJO: 'All', fmFilterTemplate: 'All', fmFilterStatus: 'All', fmFilterMonth: '',
  workReports: [], workReportView: null,
  fmIncidents: [], incidentView: null,
  user: null, permissions: {}, company: {}, branches: [], brands: [], units: [],
  items: [], movements: [], clients: [], dns: [], users: [], roles: {}, permLabels: [],
  loaded: false, modal: null, toast: null,
  publicBranding: null,
  quotations: [], jobOrders: [], materialRequests: [], vendors: [], purchaseRequests: [], purchaseOrders: [], delayReports: [],
  exclusionsLibrary: [], quotationCategories: [], quotationApprovers: [], procView: 'requests',
  nextQuotationCounter: null, quoteFilter: 'All', mobileNavOpen: false, joFilter: 'All', dnFilter: 'All',
};

function can(permKey) { return !!state.permissions[permKey]; }
function uid(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function userInitials(name) {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}
function fmtMoney(n) { return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function statusBadge(status) {
  const map = { 'IN STOCK': 'badge-in', 'LOW STOCK': 'badge-low', 'CRITICAL': 'badge-crit', 'OUT OF STOCK': 'badge-out' };
  return `<span class="badge ${map[status]}">${status}</span>`;
}
// Standard company contact line for the bottom of every printed/downloaded document —
// Delivery Notes, Quotations, Inventory Reports, and any future module should call this
// rather than re-typing the pattern, so the footer stays consistent everywhere.
function companyFooterNote() {
  const co = state.company;
  const line = [co.name, co.address, co.phone, co.email].filter(Boolean).join('  ·  ');
  return line ? `<div class="dn-footer-note">${line}</div>` : '';
}
function itemLabel(item) { return item ? `${item.brand} | ${item.partNo || '—'} | ${item.description}` : ''; }
function findItem(id) { return state.items.find(i => i.id === id); }

/* ---------------- Quotation helpers ---------------- */
const QUOTE_TYPE_LABEL = { PR: 'Project', SUP: 'Supply Only', AMC: 'AMC Contract', FO: 'Fit-Out' };
const QUOTE_TYPE_PREFIX = { PR: 'PR', SUP: 'SUP', AMC: 'AMC', FO: 'FO' };
function quoteStatusBadge(status) {
  const map = {
    Draft: 'badge-draft', PendingApproval: 'badge-low', Approved: 'badge-in', Rejected: 'badge-out',
    Sent: 'badge-issued', Accepted: 'badge-in', Declined: 'badge-out', Expired: 'badge-out',
  };
  return `<span class="badge ${map[status] || 'badge-draft'}">${status === 'PendingApproval' ? 'Pending Approval' : status}</span>`;
}
function isQuotationApprover() {
  if (!state.user) return false;
  if (state.user.role === 'Super Admin') return true;
  return state.quotationApprovers.some(a => a.id === state.user.id);
}
function lineTotal(l) { return Number(l.qty || 0) * Number(l.unitPrice || 0); }
function calcQuoteTotals(q) {
  const source = (q.type === 'AMC') ? ((q.amc && q.amc.services) || []) : (q.lineItems || []);
  const subtotal = source.reduce((s, l) => s + lineTotal(l), 0);
  const discount = Number(q.discount || 0);
  const taxable = Math.max(0, subtotal - discount);
  const vat = q.showVat === false ? 0 : taxable * 0.05;
  const total = taxable + vat;
  return { subtotal, discount, taxable, vat, total };
}
function groupLinesByCategory(lineItems) {
  const groups = []; const byCat = new Map();
  for (const l of lineItems || []) {
    const cat = l.category || 'General';
    if (!byCat.has(cat)) { const g = { category: cat, lines: [], subtotal: 0 }; byCat.set(cat, g); groups.push(g); }
    const g = byCat.get(cat); g.lines.push(l); g.subtotal += lineTotal(l);
  }
  return groups;
}
function findQuote(id) { return state.quotations.find(q => q.id === id); }
function findJobOrder(id) { return state.jobOrders.find(j => j.id === id); }
function findMaterialRequest(id) { return state.materialRequests.find(m => m.id === id); }
function findVendor(id) { return state.vendors.find(v => v.id === id); }
function findPurchaseRequest(id) { return state.purchaseRequests.find(p => p.id === id); }
function findPurchaseOrder(id) { return state.purchaseOrders.find(p => p.id === id); }
function findDelayReport(id) { return state.delayReports.find(d => d.id === id); }
function prStatusBadge(status) {
  const map = { Requested: 'badge-low', Approved: 'badge-in', Rejected: 'badge-out', Converted: 'badge-draft' };
  return `<span class="badge ${map[status] || 'badge-draft'}">${status}</span>`;
}
function poStatusBadge(status) {
  const map = { Draft: 'badge-draft', Sent: 'badge-low', PartiallyReceived: 'badge-low', Received: 'badge-in', Cancelled: 'badge-out' };
  const label = status === 'PartiallyReceived' ? 'Partially Received' : status;
  return `<span class="badge ${map[status] || 'badge-draft'}">${label}</span>`;
}
function mrStatusBadge(status) {
  const map = { Requested: 'badge-low', PartiallyFulfilled: 'badge-low', Fulfilled: 'badge-in', Cancelled: 'badge-out' };
  const label = status === 'PartiallyFulfilled' ? 'Partially Fulfilled' : status;
  return `<span class="badge ${map[status] || 'badge-draft'}">${label}</span>`;
}

// Maps the Settings > "Logo Display Size" choice to an actual pixel height, used everywhere
// the logo appears (header, login screen, Delivery Notes, printed reports).
function logoSizePx(size) {
  return { small: 40, medium: 64, large: 96 }[size] || 64;
}
// The top navbar is a thin fixed-height bar, so it uses a smaller scale than print documents
// even when "Large" is selected — otherwise a big logo would break the header's layout.
function headerLogoSizePx(size) {
  return { small: 22, medium: 30, large: 38 }[size] || 30;
}

function showToast(msg, type) {
  state.toast = { msg, type };
  render();
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => { state.toast = null; render(); }, 3000);
}

/* ---------------- data loading ---------------- */
async function loadAll() {
  const me = await api('GET', '/api/auth/me');
  state.user = me.user; state.permissions = me.permissions;

  const [company, branchesR, brandsR, unitsR, itemsR, movementsR, clientsR, dnsR, quotCatR, exclR, quotesR, joR, mrR, vendR, prR, poR, drR, fmClR, fmTplR, wrR, irR] = await Promise.all([
    api('GET', '/api/company'),
    api('GET', '/api/meta/branches'),
    api('GET', '/api/meta/brands'),
    api('GET', '/api/meta/units'),
    api('GET', '/api/items'),
    api('GET', '/api/movements'),
    api('GET', '/api/clients'),
    api('GET', '/api/dns'),
    api('GET', '/api/meta/quotationCategories'),
    api('GET', '/api/exclusions'),
    api('GET', '/api/quotations'),
    api('GET', '/api/job-orders'),
    api('GET', '/api/material-requests'),
    api('GET', '/api/vendors'),
    api('GET', '/api/purchase-requests'),
    api('GET', '/api/purchase-orders'),
    api('GET', '/api/delay-reports'),
    api('GET', '/api/fm-checklists'),
    api('GET', '/api/fm-checklists/templates'),
    api('GET', '/api/work-reports'),
    api('GET', '/api/incidents'),
  ]);
  state.company = company.company; state.nextDnPreview = company.nextDnPreview; state.nextQuotationCounter = company.nextQuotationCounter;
  if (state.company.name) document.title = state.company.name;
  state.branches = branchesR.branches; state.brands = brandsR.brands; state.units = unitsR.units;
  state.items = itemsR.items; state.movements = movementsR.movements; state.clients = clientsR.clients; state.dns = dnsR.dns;
  state.quotationCategories = quotCatR.quotationCategories; state.exclusionsLibrary = exclR.exclusions;
  state.quotations = quotesR.quotations; state.jobOrders = joR.jobOrders; state.materialRequests = mrR.materialRequests;
  state.vendors = vendR.vendors; state.purchaseRequests = prR.purchaseRequests; state.purchaseOrders = poR.purchaseOrders;
  state.delayReports = drR.delayReports;
  state.fmChecklists = fmClR.checklists || [];
  state.fmTemplates  = fmTplR.templates  || [];
  state.workReports  = wrR.workReports   || [];
  state.fmIncidents  = irR.incidents     || [];

  if (can('manageUsers')) {
    const [usersR, rolesR] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/users/roles/all')]);
    state.users = usersR.users; state.roles = rolesR.roles; state.permLabels = rolesR.labels;
  }
  if (can('manageQuotations')) {
    const approversR = await api('GET', '/api/quotations/approvers-list');
    state.quotationApprovers = approversR.approvers;
  }
  state.loaded = true;
  updateFavicon();
}

// Swaps the browser tab icon to the uploaded company logo, once available.
// Falls back to the default "AF" mark (set in index.html) if no logo has been uploaded.
const DEFAULT_FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23F9893D'/%3E%3Ctext x='32' y='43' font-family='Arial, sans-serif' font-size='28' font-weight='800' fill='white' text-anchor='middle'%3EAF%3C/text%3E%3C/svg%3E";
function updateFavicon() {
  const favicon = document.getElementById('favicon');
  if (!favicon) return;
  favicon.href = (state.company && state.company.logoPath) ? state.company.logoPath : DEFAULT_FAVICON;
}

function visibleItems() {
  let list = state.items;
  if (state.branch !== 'All') list = list.filter(i => i.location === state.branch);
  if (state.invFilter !== 'All') list = list.filter(i => i.status === state.invFilter);
  if (state.search.trim()) {
    const q = state.search.toLowerCase();
    list = list.filter(i => (i.brand + ' ' + i.partNo + ' ' + i.description).toLowerCase().includes(q));
  }
  return list;
}
function currentFilterSummary() {
  const parts = [];
  parts.push('Branch: ' + (state.branch === 'All' ? 'All Branches' : state.branch));
  parts.push('Status: ' + (state.invFilter === 'All' ? 'All' : state.invFilter));
  if (state.search.trim()) parts.push(`Search: "${state.search.trim()}"`);
  return parts.join('  ·  ');
}
function shouldExportPricing() { return can('viewPricing') && can('exportPricing') && !!state.exportIncludePricing; }

/* ---------------- render shell ---------------- */
function setTab(t) { state.tab=t; state.modal=null; state.clientView=null; state.fmChecklistView=null; state.workReportView=null; state.incidentView=null; state.mobileNavOpen=false; render(); }

// Navigate to a tab with a pre-applied filter
function goFiltered(tab, filterKey, filterVal) {
  state.tab  = tab;
  state.modal = null;
  if (filterKey && filterVal !== undefined) state[filterKey] = filterVal;
  render();
}

function render() {
  if (!authToken) { root.innerHTML = renderLoginScreen(); attachLoginHandlers(); return; }
  if (!state.loaded) {
    root.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:var(--sans);color:var(--ink-soft);">Loading Al Fitr Inventory System…</div>`;
    return;
  }
  if (state.user && state.user.mustChangePassword && state.modal?.type !== 'forcePwd') {
    state.modal = { type: 'forcePwd', payload: {} };
  }
  root.innerHTML = `
    ${renderAppHeader()}
    <div class="app">
      ${renderSidebar()}
      <div class="main">
        ${renderTopbar()}
        ${renderPage()}
      </div>
    </div>
    ${state.modal ? renderModal() : ''}
    ${state.toast ? `<div class="toast ${state.toast.type || ''}">${state.toast.msg}</div>` : ''}
  `;
  attachHandlers();
}

function renderLoginScreen() {
  const b = state.publicBranding;
  const logoHtml = (b && b.logoPath)
    ? `<img src="${b.logoPath}" class="login-logo" style="height:${logoSizePx(b.logoSize)}px;max-width:220px;object-fit:contain;margin-bottom:14px;" alt="${b.name || ''} logo">`
    : '';
  return `
  <div class="login-wrap">
    <div class="login-card">
      ${logoHtml}
      <div class="login-title">${(b && b.name) || 'Sign In'}</div>
      <div class="login-sub">Sign in to continue</div>
      <div id="loginErr"></div>
      <div class="field"><label>Username</label><input id="loginUsername" autocomplete="username" placeholder="e.g. admin"></div>
      <div class="field"><label>Password</label><input id="loginPassword" type="password" autocomplete="current-password" placeholder="Enter your password"></div>
      <button class="btn btn-primary" id="loginBtn" style="width:100%;justify-content:center;margin-top:6px;">Sign In</button>
      <p class="muted" style="text-align:center;margin-top:16px;font-size:11.5px;">First time? Default is <strong>admin</strong> / <strong>admin123</strong> — you'll be asked to change it.</p>
      <div class="muted" style="text-align:center;margin-top:14px;font-size:10.5px;">Powered by Nexora Technologies</div>
    </div>
  </div>`;
}
async function loadPublicBranding() {
  try {
    const res = await fetch('/api/company/public');
    if (res.ok) {
      state.publicBranding = await res.json();
      if (state.publicBranding.name) document.title = state.publicBranding.name;
      render();
    }
  } catch (e) { /* non-fatal — login screen just shows the text fallback */ }
}
function attachLoginHandlers() {
  const btn = document.getElementById('loginBtn');
  const doLogin = async () => {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errBox = document.getElementById('loginErr');
    errBox.innerHTML = '';
    if (!username || !password) { errBox.innerHTML = `<div class="login-err">Enter both username and password.</div>`; return; }
    try {
      const data = await api('POST', '/api/auth/login', { username, password });
      authToken = data.token;
      localStorage.setItem('af_token', authToken);
      state.user = data.user;
      await loadAll();
      render();
    } catch (e) {
      errBox.innerHTML = `<div class="login-err">${e.message}</div>`;
    }
  };
  if (btn) btn.addEventListener('click', doLogin);
  ['loginUsername', 'loginPassword'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  });
}

function renderAppHeader() {
  const co = state.company;
  const user = state.user;
  return `
  <div class="app-header no-print">
    <div class="app-header-left">
      <button class="icon-btn mobile-nav-toggle" id="mobileNavToggle" title="Menu" aria-label="Open menu">☰</button>
      ${co.logoPath ? `<img src="${co.logoPath}" class="app-header-logo" style="height:${headerLogoSizePx(co.logoSize)}px;max-width:160px;object-fit:contain;" alt="logo">` : `<div class="brand-mark" style="width:30px;height:30px;font-size:12px;">${userInitials(co.name)}</div>`}
      <div class="app-header-name">${co.name || ''}</div>
    </div>
    <div class="app-header-right">
      <button class="icon-btn" title="No new notifications">🔔</button>
      <button class="icon-btn" id="headerSettingsBtn" title="Settings">⚙️</button>
      <div class="user-badge">
        <div class="user-avatar">${userInitials(user?.name)}</div>
        <div class="user-meta"><div class="n">${user?.name || ''}</div><div class="r">${user?.role || ''}</div></div>
      </div>
      <button class="btn btn-ghost btn-sm" id="logoutBtn">Logout</button>
    </div>
  </div>`;
}

function renderSidebar() {
  const co = state.company || {};

  // Which group is active based on current tab
  const groupOf = {
    dashboard:        'dashboard',
    inventory:        'inventory',
    movements:        'inventory',
    dns:              'inventory',
    quotations:       'sales',
    jobOrders:        'sales',
    clients:          'sales',
    materialRequests: 'projects',
    delayReports:     'projects',
    fmChecklists:     'fm',
    fmWorkReports:    'fm',
    fmIncidents:      'fm',
    procurement:      'procurement',
    vendors:          'procurement',
    settings:         'settings',
  };
  const activeGroup = groupOf[state.tab] || state.tab;

  // If no group is open in state, open the active one
  if (!state.sidebarOpen) state.sidebarOpen = activeGroup;

  const isOpen = (g) => state.sidebarOpen === g;
  const isActiveTab = (id) => state.tab === id;

  const navItem = (id, label) => `
    <button data-tab="${id}" class="nav-sub-item ${isActiveTab(id) ? 'active' : ''}">
      ${label}
    </button>`;

  const navGroup = (id, icon, label, items) => {
    const open     = isOpen(id);
    const hasActive = items.some(([tabId]) => isActiveTab(tabId));
    return `
    <div class="nav-group">
      <button class="nav-group-header ${hasActive ? 'has-active' : ''}" data-group="${id}">
        <span class="nav-group-icon">${icon}</span>
        <span class="nav-group-label">${label}</span>
        <span class="nav-group-arrow ${open ? 'open' : ''}">›</span>
      </button>
      <div class="nav-group-items ${open ? 'open' : ''}">
        ${items.map(([tabId, lbl]) => navItem(tabId, lbl)).join('')}
      </div>
    </div>`;
  };

  return `
  ${state.mobileNavOpen ? `<div class="mobile-nav-backdrop" id="mobileNavBackdrop"></div>` : ''}
  <div class="sidebar ${state.mobileNavOpen ? 'mobile-open' : ''}">
    <div class="brand">
      <div class="brand-mark">${userInitials(co.name)}</div>
      <div class="brand-name">${co.name || ''}</div>
      <button class="icon-btn mobile-nav-close" id="mobileNavClose" aria-label="Close menu">✕</button>
    </div>
    <div class="nav">

      <button data-tab="dashboard" class="nav-solo ${isActiveTab('dashboard') ? 'active' : ''}">
        <span class="nav-group-icon">🏠</span> Dashboard
      </button>

      ${navGroup('inventory', '📦', 'Inventory', [
        ['inventory',  'Items'],
        ['movements',  'Stock Movements'],
        ['dns',        'Delivery Notes'],
      ])}

      ${navGroup('sales', '💼', 'Sales', [
        ['quotations', 'Quotations'],
        ['jobOrders',  'Job Orders'],
        ['clients',    'Clients'],
      ])}

      ${navGroup('projects', '🔧', 'Projects', [
        ['materialRequests', 'Material Requests'],
        ['delayReports',     'Delay Reports'],
      ])}

      ${navGroup('fm', '🏢', 'FM Services', [
        ['fmChecklists',  'Daily Checklists'],
        ['fmWorkReports', 'Work Completion'],
        ['fmIncidents',   'Incident Reports'],
      ])}

      ${navGroup('procurement', '🛒', 'Procurement', [
        ['procurement', 'Purchase Requests & POs'],
        ['vendors',     'Vendors'],
      ])}

      <button data-tab="settings" class="nav-solo ${isActiveTab('settings') ? 'active' : ''}">
        <span class="nav-group-icon">⚙️</span> Settings
      </button>

    </div>
    <div class="sidebar-foot">
      <div class="sync-badge"><span class="sync-dot"></span> Connected</div>
      <div class="owner-credit">Powered by Nexora Technologies</div>
    </div>
  </div>`;
}

function renderTopbar() {
  const titles = {
    dashboard: ['Dashboard', 'Live overview across all branches'],
    inventory: ['Inventory', 'Stock levels, items and reorder status'],
    movements: ['Stock Movements', 'IN / OUT / ADJUSTMENT log'],
    dns: ['Delivery Notes', 'Create, issue and print delivery notes'],
    quotations: ['Quotations', 'Create, approve, send and track quotations'],
    jobOrders: ['Job Orders', 'Jobs created from accepted quotations'],
    materialRequests: ['Material Requests', 'Request materials against a job, checked and fulfilled from stock'],
    procurement: ['Procurement', 'Purchase Requests and Purchase Orders for whatever stock can\'t cover'],
    vendors: ['Vendors', 'Companies you buy materials from'],
    delayReports:     ['Delay Reports',    'Site delay reports raised against a Job Order'],
    clients:          ['Clients',          'Client directory with 360 project history'],
    fmChecklists:     ['FM Daily Checklists', 'Routine maintenance checklists for FM sites'],
    fmWorkReports:    ['Work Completion Reports', 'WCR and Service Notification Reports'],
    fmIncidents:      ['Incident Reports', 'Site incident and investigation reports'],
    settings:         ['Settings',         'Branches, brands, units, security and company details'],
  };
  const [title, sub] = titles[state.tab] || [state.tab, ''];
  return `
  <div class="topbar">
    <div><div class="page-title">${title}</div><div class="page-sub">${sub}</div></div>
    <div class="branch-select">
      Branch:
      <select id="branchPicker">
        <option ${state.branch === 'All' ? 'selected' : ''} value="All">All Branches</option>
        ${state.branches.map(b => `<option ${state.branch === b ? 'selected' : ''} value="${b}">${b}</option>`).join('')}
      </select>
    </div>
  </div>`;
}

function renderPage() {
  if (state.tab === 'dashboard') return renderDashboard();
  if (state.tab === 'inventory') return renderInventory();
  if (state.tab === 'movements') return renderMovements();
  if (state.tab === 'dns') return renderDns();
  if (state.tab === 'quotations') return renderQuotations();
  if (state.tab === 'jobOrders') return renderJobOrders();
  if (state.tab === 'materialRequests') return renderMaterialRequests();
  if (state.tab === 'procurement') return renderProcurement();
  if (state.tab === 'vendors') return renderVendors();
  if (state.tab === 'delayReports') return renderDelayReports();
  if (state.tab === 'clients')      return state.clientView ? renderClient360(state.clientView) : renderClients();
  if (state.tab === 'fmChecklists')  return state.fmChecklistView  ? renderFmChecklistDetail(state.fmChecklistView)   : renderFmChecklists();
  if (state.tab === 'fmWorkReports') return state.workReportView   ? renderWorkReportDetail(state.workReportView)      : renderWorkReports();
  if (state.tab === 'fmIncidents')   return state.incidentView     ? renderIncidentDetail(state.incidentView)           : renderIncidents();
  if (state.tab === 'settings') return renderSettings();
  return '';
}

/* ---------------- Dashboard ---------------- */
function renderDashboard() {
  const items    = state.branch === 'All' ? state.items : state.items.filter(i => i.location === state.branch);
  const dns      = state.branch === 'All' ? state.dns   : state.dns.filter(d => d.location === state.branch);
  const now      = new Date();
  const thisMonth = (d) => { const dt = new Date(d); return dt.getMonth()===now.getMonth() && dt.getFullYear()===now.getFullYear(); };
  const lastMonth = (d) => { const dt = new Date(d); const lm = new Date(now.getFullYear(), now.getMonth()-1,1); return dt.getMonth()===lm.getMonth() && dt.getFullYear()===lm.getFullYear(); };

  const total    = items.length;
  const inStock  = items.filter(i => i.status === 'IN STOCK').length;
  const lowCrit  = items.filter(i => i.status === 'LOW STOCK' || i.status === 'CRITICAL').length;
  const outStock = items.filter(i => i.status === 'OUT OF STOCK').length;
  const alerts   = items.filter(i => i.status !== 'IN STOCK').sort((a,b) => a.qty - b.qty).slice(0, 6);

  const quotes    = state.quotations || [];
  const qDraft    = quotes.filter(q => q.status === 'Draft').length;
  const qPending  = quotes.filter(q => q.status === 'PendingApproval').length;
  const qSent     = quotes.filter(q => q.status === 'Sent').length;
  const qAccepted = quotes.filter(q => q.status === 'Accepted').length;
  const qDeclined = quotes.filter(q => q.status === 'Declined').length;
  const qApproved = quotes.filter(q => q.status === 'Approved').length;
  const activeQ   = qDraft + qPending + qSent + qApproved;
  const jobOrders = state.jobOrders || [];
  const activeJOs = jobOrders.filter(j => j.status === 'Open' || j.status === 'In Process').length;
  const recentJOs = [...jobOrders].sort((a,b) => b.createdAt - a.createdAt).slice(0, 5);

  const mrs       = state.materialRequests || [];
  const openMRs   = mrs.filter(m => { const s = computeMrStatus(m); return s !== 'Fulfilled' && s !== 'Cancelled'; }).length;
  const drs       = state.delayReports || [];
  const allDI     = drs.reduce((acc,r) => { (r.delayItems||[]).forEach(i => acc.push(i.status)); return acc; }, []);
  const dOpen     = allDI.filter(s => s === 'Open').length;
  const dProg     = allDI.filter(s => s === 'In Progress').length;
  const dDone     = allDI.filter(s => s === 'Resolved').length;

  const prs       = state.purchaseRequests || [];
  const pos       = state.purchaseOrders   || [];
  const pendingPR = prs.filter(p => p.status === 'Requested' || p.status === 'Approved').length;
  const openPOs   = pos.filter(p => p.status !== 'Received' && p.status !== 'Cancelled').length;

  const dnThisM   = dns.filter(d => d.status === 'Issued' && thisMonth(d.date)).length;
  const dnLastM   = dns.filter(d => d.status === 'Issued' && lastMonth(d.date)).length;
  const recentDns = [...dns].sort((a,b) => b.createdAt - a.createdAt).slice(0, 5);

  const showValue  = can('viewStockValue');
  const stockValue = items.reduce((s, i) => s + (Number(i.stockValue) || 0), 0);

  // ── SVG bar chart helper (pure CSS, no library)
  function svgBar(data, colors, labels, maxH, onclicks) {
    const max  = Math.max(...data, 1);
    const barW = 36, gap = 12, padX = 10, padTop = 28, padBot = 24;
    const totalW = data.length * (barW + gap) + padX * 2;
    const h      = (maxH || 120) + padTop + padBot;
    const chartH = h - padTop - padBot;
    const bars   = data.map((v, i) => {
      const bh  = Math.max(3, Math.round((v / max) * chartH));
      const x   = padX + i * (barW + gap);
      const y   = padTop + (chartH - bh);
      const oc  = onclicks && onclicks[i] ? `onclick="${onclicks[i]}" style="cursor:pointer;"` : 'style="cursor:default;"';
      return `
        <g ${oc} onmouseover="this.querySelector('rect').style.opacity='0.75'" onmouseout="this.querySelector('rect').style.opacity='1'">
          <rect x="${x}" y="${y}" width="${barW}" height="${bh}" fill="${colors[i % colors.length]}" rx="4"><title>${labels[i]||''}: ${v}</title></rect>
          <text x="${x + barW/2}" y="${y - 6}" text-anchor="middle" font-size="12" font-weight="600" fill="#444">${v}</text>
          <text x="${x + barW/2}" y="${h - 6}" text-anchor="middle" font-size="11" fill="#888">${labels[i]||''}</text>
        </g>`;
    }).join('');
    return `<svg width="100%" viewBox="0 0 ${totalW} ${h}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;">${bars}</svg>`;
  }

  // ── SVG donut helper
  function svgDonut(data, colors, onclicks, labels) {
    const total = data.reduce((a,b) => a+b, 0);
    if (total === 0) return `<svg width="110" height="110" viewBox="0 0 110 110"><circle cx="55" cy="55" r="42" fill="none" stroke="#e5e7eb" stroke-width="18"/><text x="55" y="60" text-anchor="middle" font-size="14" fill="#ccc">0</text></svg>`;
    let angle = -90;
    const r = 42, cx = 55, cy = 55;
    const paths = data.map((v, i) => {
      if (v === 0) return '';
      const pct   = (v / total) * 360;
      const start = angle;
      angle += pct;
      const s    = polarToXY(cx, cy, r, start);
      const e    = polarToXY(cx, cy, r, angle);
      const large = pct > 180 ? 1 : 0;
      const oc   = onclicks && onclicks[i] ? `onclick="${onclicks[i]}" style="cursor:pointer;"` : 'style="cursor:default;"';
      const titleText = labels && labels[i] ? `${labels[i]}: ${v} (${Math.round(v/total*100)}%)` : `${v}`;
      return `<path d="M${cx},${cy} L${s.x},${s.y} A${r},${r},0,${large},1,${e.x},${e.y} Z" fill="${colors[i]}" ${oc} onmouseover="this.style.opacity='0.78'" onmouseout="this.style.opacity='1'"><title>${titleText}</title></path>`;
    }).join('');
    return `<svg width="110" height="110" viewBox="0 0 110 110" xmlns="http://www.w3.org/2000/svg">
      ${paths}
      <circle cx="${cx}" cy="${cy}" r="26" fill="#fff" style="pointer-events:none;"/>
      <text x="${cx}" y="${cy+5}" text-anchor="middle" font-size="16" font-weight="700" fill="#0B2B36" style="pointer-events:none;">${total}</text>
    </svg>`;
  }
  function polarToXY(cx, cy, r, deg) {
    const rad = (deg * Math.PI) / 180;
    return { x: +(cx + r * Math.cos(rad)).toFixed(2), y: +(cy + r * Math.sin(rad)).toFixed(2) };
  }

  // ── SVG line chart helper (6-month DN trend)
  function svgLine(data, labels) {
    const max  = Math.max(...data, 1);
    const w    = 300, padX = 20, padTop = 28, padBot = 28;
    const h    = 120 + padTop + padBot;
    const chartH = h - padTop - padBot;
    const pts  = data.map((v, i) => {
      const x = padX + (i / (data.length - 1)) * (w - padX * 2);
      const y = padTop + chartH - Math.round((v / max) * chartH);
      return { x: +x.toFixed(1), y: +y.toFixed(1), v, l: labels[i] };
    });
    const polyline = pts.map(p => `${p.x},${p.y}`).join(' ');
    const area     = `M${pts[0].x},${padTop + chartH} ` + pts.map(p => `L${p.x},${p.y}`).join(' ') + ` L${pts[pts.length-1].x},${padTop + chartH} Z`;
    return `<svg width="100%" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible;">
      <path d="${area}" fill="rgba(232,82,10,0.08)"/>
      <polyline points="${polyline}" fill="none" stroke="#E8520A" stroke-width="2.5"/>
      ${pts.map(p => `
        <g onclick="setTab('dns')" style="cursor:pointer;">
          <circle cx="${p.x}" cy="${p.y}" r="10" fill="transparent"><title>${p.l}: ${p.v} delivery note${p.v===1?'':'s'}</title></circle>
          <circle cx="${p.x}" cy="${p.y}" r="4" fill="#E8520A"
            onmouseover="this.setAttribute('r','7');this.style.opacity='0.8'"
            onmouseout="this.setAttribute('r','4');this.style.opacity='1'"/>
          <text x="${p.x}" y="${p.y - 10}" text-anchor="middle" font-size="12" font-weight="600" fill="#E8520A">${p.v}</text>
          <text x="${p.x}" y="${h - 6}" text-anchor="middle" font-size="11" fill="#999">${p.l}</text>
        </g>
      `).join('')}
    </svg>`;
  }

  // ── 6-month data
  const monthLabels = [], monthDnData = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthLabels.push(d.toLocaleDateString('en-GB', { month: 'short' }));
    monthDnData.push(dns.filter(dn => {
      const dt = new Date(dn.date);
      return dn.status === 'Issued' && dt.getMonth() === d.getMonth() && dt.getFullYear() === d.getFullYear();
    }).length);
  }

  const TEAL = '#1D9E75', ORANGE = '#E8520A', RED = '#dc2626', NAVY = '#00627B', PURPLE = '#7F77DD', GRAY = '#aaa';

  return `
  ${alerts.length > 0 ? `
  <div class="dash-alert">
    <span>⚠️</span>
    <span><strong>${outStock} items out of stock</strong> · ${lowCrit} items low/critical</span>
    <button class="btn btn-ghost btn-sm" data-tab="inventory" style="margin-left:auto;">View Inventory →</button>
  </div>` : ''}

  <div class="dash-kpi-strip">
    <div class="dash-kpi-card" style="border-top:3px solid ${TEAL};cursor:pointer;" onclick="goFiltered('inventory','invFilter','All')">
      <div class="dash-kpi-label">Total Inventory</div>
      <div class="dash-kpi-value" style="color:${TEAL};">${total}</div>
      <div class="dash-kpi-sub">${inStock} in stock · ${outStock} out</div>
    </div>
    <div class="dash-kpi-card" style="border-top:3px solid ${ORANGE};cursor:pointer;" onclick="goFiltered('quotations','quoteFilter','All')">
      <div class="dash-kpi-label">Quotations</div>
      <div class="dash-kpi-value" style="color:${ORANGE};">${quotes.length}</div>
      <div class="dash-kpi-sub">${activeQ} active · ${qAccepted} accepted</div>
    </div>
    <div class="dash-kpi-card" style="border-top:3px solid ${NAVY};cursor:pointer;" onclick="setTab('jobOrders')">
      <div class="dash-kpi-label">Job Orders</div>
      <div class="dash-kpi-value" style="color:${NAVY};">${jobOrders.length}</div>
      <div class="dash-kpi-sub">${activeJOs} open / in-process</div>
    </div>
    <div class="dash-kpi-card" style="border-top:3px solid ${ORANGE};cursor:pointer;" onclick="setTab('dns')">
      <div class="dash-kpi-label">DNs This Month</div>
      <div class="dash-kpi-value" style="color:${ORANGE};">${dnThisM} <span style="font-size:16px;color:${dnThisM>=dnLastM?TEAL:RED}">${dnThisM>=dnLastM?'↑':'↓'}</span></div>
      <div class="dash-kpi-sub">vs ${dnLastM} last month</div>
    </div>
    <div class="dash-kpi-card" style="border-top:3px solid ${RED};cursor:pointer;" onclick="setTab('delayReports')">
      <div class="dash-kpi-label">Open Delays</div>
      <div class="dash-kpi-value" style="color:${RED};">${dOpen}</div>
      <div class="dash-kpi-sub">${dProg} in progress · ${dDone} resolved</div>
    </div>
    <div class="dash-kpi-card" style="border-top:3px solid ${PURPLE};cursor:pointer;" onclick="setTab('procurement')">
      <div class="dash-kpi-label">Pending PRs</div>
      <div class="dash-kpi-value" style="color:${PURPLE};">${pendingPR}</div>
      <div class="dash-kpi-sub">${openPOs} open POs</div>
    </div>
  </div>

  <div class="dash-charts-row">
    <div class="dash-chart-card">
      <div class="dash-chart-title">Inventory Status</div>
      <div style="display:flex;align-items:center;gap:16px;margin-top:8px;">
        ${svgDonut([inStock, lowCrit, outStock], [TEAL, ORANGE, RED], [
          "goFiltered('inventory','invFilter','IN STOCK')",
          "goFiltered('inventory','invFilter','LOW STOCK')",
          "goFiltered('inventory','invFilter','OUT OF STOCK')"
        ], ['In Stock', 'Low/Critical', 'Out of Stock'])}
        <div style="font-size:12px;line-height:2;">
          <div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${TEAL};margin-right:6px;"></span>In Stock (${inStock})</div>
          <div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${ORANGE};margin-right:6px;"></span>Low/Critical (${lowCrit})</div>
          <div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${RED};margin-right:6px;"></span>Out of Stock (${outStock})</div>
        </div>
      </div>
    </div>

    <div class="dash-chart-card">
      <div class="dash-chart-title">Quotation Pipeline</div>
      <div style="margin-top:8px;">
        ${svgBar([qDraft,qPending,qApproved,qSent,qAccepted,qDeclined], [GRAY,ORANGE,NAVY,NAVY,TEAL,RED], ['Draft','Pend','Appr','Sent','Accpt','Decl'], 120, [
          "goFiltered('quotations','quoteFilter','Draft')",
          "goFiltered('quotations','quoteFilter','PendingApproval')",
          "goFiltered('quotations','quoteFilter','Approved')",
          "goFiltered('quotations','quoteFilter','Sent')",
          "goFiltered('quotations','quoteFilter','Accepted')",
          "goFiltered('quotations','quoteFilter','Declined')"
        ])}
      </div>
    </div>

    <div class="dash-chart-card">
      <div class="dash-chart-title">Delivery Notes — 6 Month Trend</div>
      <div style="margin-top:8px;">
        ${svgLine(monthDnData, monthLabels)}
      </div>
    </div>

    <div class="dash-chart-card">
      <div class="dash-chart-title">Delay Items Status</div>
      <div style="display:flex;align-items:center;gap:16px;margin-top:8px;">
        ${(dOpen+dProg+dDone) === 0
          ? `<div style="width:110px;height:110px;display:flex;align-items:center;justify-content:center;background:#f5f5f5;border-radius:50%;font-size:12px;color:#aaa;flex-shrink:0;">No data</div>`
          : svgDonut([dOpen,dProg,dDone],[RED,ORANGE,TEAL],["goFiltered('delayReports','drFilter','Open')","goFiltered('delayReports','drFilter','In Progress')","goFiltered('delayReports','drFilter','Resolved')"], ['Open','In Progress','Resolved'])}
        <div style="font-size:12px;line-height:2.2;">
          <div style="cursor:pointer;" onclick="goFiltered('delayReports','drFilter','Open')"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${RED};margin-right:6px;"></span>Open (${dOpen})</div>
          <div style="cursor:pointer;" onclick="goFiltered('delayReports','drFilter','In Progress')"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${ORANGE};margin-right:6px;"></span>In Progress (${dProg})</div>
          <div style="cursor:pointer;" onclick="goFiltered('delayReports','drFilter','Resolved')"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${TEAL};margin-right:6px;"></span>Resolved (${dDone})</div>
        </div>
      </div>
    </div>
  </div>

  <div class="dash-tables-row">
    <div class="card" style="min-width:0;">
      <div class="card-head">
        <div class="card-title">Recent Job Orders</div>
        <button class="btn btn-ghost btn-sm" data-tab="jobOrders">View All</button>
      </div>
      ${recentJOs.length === 0 ? `<div class="empty">No job orders yet.</div>` : `
      <div class="tbl-wrap"><table>
        <thead><tr><th>JO No.</th><th>Client</th><th>Status</th></tr></thead>
        <tbody>${recentJOs.map(j => `<tr>
          <td style="font-family:var(--mono);color:#E8520A;font-weight:700;">${j.jobOrderNumber}</td>
          <td>${j.clientCompany||'—'}</td>
          <td><span class="badge ${j.status==='Open'?'badge-in':j.status==='Resolved'?'badge-out':'badge-low'}">${j.status}</span></td>
        </tr>`).join('')}</tbody>
      </table></div>`}
    </div>

    <div class="card" style="min-width:0;">
      <div class="card-head">
        <div class="card-title">Recent Delivery Notes</div>
        ${can('createDN') ? `<button class="btn btn-primary btn-sm" id="newDnBtn2">+ New DN</button>` : ''}
      </div>
      ${recentDns.length === 0 ? `<div class="empty">No delivery notes yet.</div>` : `
      <div class="tbl-wrap"><table>
        <thead><tr><th>DN No.</th><th>Client</th><th>Status</th></tr></thead>
        <tbody>${recentDns.map(d => `<tr>
          <td style="font-family:var(--mono);font-weight:700;">${d.dnNumber}</td>
          <td>${d.clientCompany||'—'}</td>
          <td><span class="badge ${d.status==='Issued'?'badge-issued':'badge-draft'}">${d.status}</span></td>
        </tr>`).join('')}</tbody>
      </table></div>`}
    </div>

    <div class="card" style="min-width:0;">
      <div class="card-head">
        <div class="card-title">Reorder Alerts <span style="color:#E8520A;font-size:12px;font-weight:600;">${alerts.length} items</span></div>
        <button class="btn btn-ghost btn-sm" data-tab="inventory">View All</button>
      </div>
      ${alerts.length === 0 ? `<div class="empty">All items healthy.</div>` : `
      <div class="tbl-wrap"><table>
        <thead><tr><th>Item</th><th>Qty</th><th>Status</th></tr></thead>
        <tbody>${alerts.map(i => `<tr>
          <td style="font-size:12px;">${i.description}</td>
          <td style="font-weight:700;color:#dc2626;">${i.qty}</td>
          <td>${statusBadge(i.status)}</td>
        </tr>`).join('')}</tbody>
      </table></div>`}
    </div>
  </div>

  ${showValue ? `<div class="shared-note">Stock value (at cost) ${state.branch==='All'?'all branches':'for '+state.branch}: ${state.company.currency} ${fmtMoney(stockValue)}</div>` : ''}
  `;
}


function computeMrStatus(mr) {
  if (mr.status === 'Cancelled') return 'Cancelled';
  const lines = mr.lineItems || [];
  if (lines.length === 0) return 'Requested';
  const allFulfilled = lines.every(l => l.qtyFulfilled >= l.qtyRequested);
  const anyFulfilled = lines.some(l => l.qtyFulfilled > 0);
  if (allFulfilled) return 'Fulfilled';
  if (anyFulfilled) return 'PartiallyFulfilled';
  return 'Requested';
}

/* ---------------- Inventory ---------------- */
function renderInventory() {
  const items = visibleItems();
  const showPricing = can('viewPricing');
  return `
  <div class="toolbar">
    <input class="search" id="invSearch" placeholder="Search brand, part no, description…" value="${state.search}">
    <select id="invStatusFilter" style="max-width:170px;">
      <option ${state.invFilter === 'All' ? 'selected' : ''} value="All">All Statuses</option>
      <option ${state.invFilter === 'IN STOCK' ? 'selected' : ''} value="IN STOCK">In Stock</option>
      <option ${state.invFilter === 'LOW STOCK' ? 'selected' : ''} value="LOW STOCK">Low Stock</option>
      <option ${state.invFilter === 'CRITICAL' ? 'selected' : ''} value="CRITICAL">Critical</option>
      <option ${state.invFilter === 'OUT OF STOCK' ? 'selected' : ''} value="OUT OF STOCK">Out of Stock</option>
    </select>
    <div style="flex:1"></div>
    ${showPricing && can('exportPricing') ? `
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--ink-soft);text-transform:none;letter-spacing:0;margin:0;">
        <input type="checkbox" id="exportPricingToggle" ${state.exportIncludePricing ? 'checked' : ''} style="width:auto;"> Include pricing in exports
      </label>` : ''}
    <button class="btn btn-outline btn-sm" id="printInvBtn">🖨️ Print</button>
    <button class="btn btn-outline btn-sm" id="exportPdfBtn">📄 Download PDF</button>
    <button class="btn btn-outline btn-sm" id="exportExcelBtn">📊 Download Excel</button>
    ${can('manageInventory') ? `<button class="btn btn-primary" id="addItemBtn">+ Add Item</button>` : ''}
  </div>
  <div class="card">
    <div class="tbl-wrap"><table>
      <thead><tr><th>Description</th><th>Brand</th><th>Part No.</th><th>Branch</th><th>Unit</th><th>Qty</th><th>Min</th>${showPricing ? '<th>Cost</th><th>Price</th>' : ''}<th>Status</th><th></th></tr></thead>
      <tbody>
      ${items.length === 0 ? `<tr><td colspan="${showPricing ? 11 : 9}"><div class="empty"><div class="big">📦</div>No items match.</div></td></tr>` :
        items.map(i => `
        <tr>
          <td><strong>${i.description}</strong></td>
          <td>${i.brand}</td>
          <td style="font-family:var(--mono);font-size:12px;">${i.partNo || '—'}</td>
          <td>${i.location}</td>
          <td>${i.unit}</td>
          <td style="font-family:var(--mono);font-weight:700;">${i.qty}</td>
          <td>${i.minLevel}</td>
          ${showPricing ? `<td>${fmtMoney(i.cost)}</td><td>${fmtMoney(i.price)}</td>` : ''}
          <td>${statusBadge(i.status)}</td>
          <td><button class="btn btn-outline btn-sm" data-edit-item="${i.id}">${can('manageInventory') ? 'Edit' : 'View'}</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </div>`;
}

/* ---------------- Movements ---------------- */
function renderMovements() {
  let list = [...state.movements];
  if (state.branch !== 'All') list = list.filter(m => { const it = findItem(m.itemId); return it && it.location === state.branch; });
  list.sort((a, b) => b.createdAt - a.createdAt);
  const canManage = can('manageMovements');
  return `
  <div class="toolbar">
    <div style="flex:1"></div>
    ${can('manageStock') ? `<button class="btn btn-primary" id="addMvBtn">+ Log Movement</button>` : ''}
  </div>
  <div class="card">
    <div class="tbl-wrap"><table>
      <thead><tr><th>Date</th><th>Item</th><th>Branch</th><th>Action</th><th>Qty</th><th>Reference</th><th>By</th><th>Linked DN</th>${canManage ? '<th></th>' : ''}</tr></thead>
      <tbody>
      ${list.length === 0 ? `<tr><td colspan="${canManage ? 9 : 8}"><div class="empty"><div class="big">🧾</div>No stock movements logged yet.</div></td></tr>` :
        list.map(m => {
          const it = findItem(m.itemId);
          const cls = m.action === 'IN' ? 'pill-in' : m.action === 'OUT' ? 'pill-out' : 'pill-adj';
          const dn = m.dnId ? state.dns.find(d => d.id === m.dnId) : null;
          return `<tr>
            <td>${fmtDate(m.date)}</td>
            <td>${it ? it.description + ' <span class="muted">(' + it.brand + ' · ' + (it.partNo || '—') + ')</span>' : '<span class="muted">(deleted item)</span>'}</td>
            <td>${it ? it.location : '—'}</td>
            <td class="${cls}">${m.action}</td>
            <td style="font-family:var(--mono);font-weight:700;">${m.qty}</td>
            <td>${m.reference || '—'}</td>
            <td>${m.by || '—'}${m.editedByName ? ` <span class="muted" style="font-size:10.5px;">(edited by ${m.editedByName})</span>` : ''}</td>
            <td>${dn ? `<span class="tag">${dn.dnNumber}</span>` : '—'}</td>
            ${canManage ? `<td><button class="btn btn-outline btn-sm" data-edit-mv="${m.id}">Edit</button></td>` : ''}
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>
  </div>
  ${canManage ? `<div class="shared-note">As Super Admin, you can edit or delete any entry here — this bypasses the normal audit-trail protection, so use it for genuine mistakes (like a typo), not routine corrections. Routine corrections should still go through an ADJUSTMENT entry so the history stays meaningful.</div>` : ''}
  `;
}

/* ---------------- Delivery Notes ---------------- */
function renderDns() {
  let list = [...state.dns];
  if (state.branch !== 'All') list = list.filter(d => d.location === state.branch);
  if (state.dnFilter && state.dnFilter !== 'All') list = list.filter(d => d.status === state.dnFilter);
  list.sort((a, b) => b.createdAt - a.createdAt);
  return `
  <div class="toolbar">
    <select id="dnStatusFilter" style="max-width:190px;">
      <option ${(!state.dnFilter || state.dnFilter === 'All') ? 'selected' : ''} value="All">All Statuses</option>
      <option ${state.dnFilter === 'Issued' ? 'selected' : ''} value="Issued">Issued</option>
      <option ${state.dnFilter === 'Draft' ? 'selected' : ''} value="Draft">Draft</option>
    </select>
    <div style="flex:1"></div>
    ${can('createDN') ? `<button class="btn btn-primary" id="newDnBtn2">+ New Delivery Note</button>` : ''}
  </div>
  <div class="card">
    <div class="tbl-wrap"><table>
      <thead><tr><th>DN No.</th><th>Date</th><th>Client / Project</th><th>LPO #</th><th>Invoice #</th><th>Branch</th><th>Items</th><th>Status</th><th></th></tr></thead>
      <tbody>
      ${list.length === 0 ? `<tr><td colspan="9"><div class="empty"><div class="big">📄</div>No delivery notes match.</div></td></tr>` :
        list.map(d => `
        <tr>
          <td style="font-family:var(--mono);font-weight:700;">${d.dnNumber}</td>
          <td>${fmtDate(d.date)}</td>
          <td>${d.clientCompany || '—'}${d.project ? ` <span class="muted">/ ${d.project}</span>` : ''}</td>
          <td style="font-family:var(--mono);font-size:12px;">${d.lpoNumber || '—'}</td>
          <td style="font-family:var(--mono);font-size:12px;">${d.invoiceNumber || '—'}</td>
          <td>${d.location}</td>
          <td>${d.items.length}</td>
          <td><span class="badge ${d.status === 'Issued' ? 'badge-issued' : 'badge-draft'}">${d.status}</span></td>
          <td><button class="btn btn-outline btn-sm" data-view-dn="${d.id}">Open</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </div>`;
}

/* ---------------- Clients ---------------- */
/* ════════════════════════════════════════════════════════════════
   FM MODULE — Daily Checklists
════════════════════════════════════════════════════════════════ */
function renderFmChecklists() {
  // ── Filters ──────────────────────────────────────────────────
  const fClient   = state.fmFilterClient   || 'All';
  const fJO       = state.fmFilterJO       || 'All';
  const fTemplate = state.fmFilterTemplate || 'All';
  const fStatus   = state.fmFilterStatus   || 'All';
  const fMonth    = state.fmFilterMonth    || '';

  let list = [...state.fmChecklists].sort((a,b) => b.createdAt - a.createdAt);
  if (fClient   !== 'All') list = list.filter(cl => cl.clientCompany === fClient);
  if (fJO       !== 'All') list = list.filter(cl => cl.jobOrderNumber === fJO);
  if (fTemplate !== 'All') list = list.filter(cl => cl.templateId === fTemplate);
  if (fStatus   !== 'All') list = list.filter(cl => cl.status === fStatus);
  if (fMonth)              list = list.filter(cl => cl.month === fMonth);

  // Unique values for filter dropdowns
  const allClients   = [...new Set(state.fmChecklists.map(cl=>cl.clientCompany).filter(Boolean))].sort();
  const allJOs       = [...new Set(state.fmChecklists.filter(cl=>fClient==='All'||cl.clientCompany===fClient).map(cl=>cl.jobOrderNumber).filter(Boolean))].sort();
  const allTemplates = state.fmTemplates;

  const activeFilters = [fClient,fJO,fTemplate,fStatus,fMonth].filter(f=>f&&f!=='All'&&f!=='').length;

  return `
  <div class="toolbar">
    <div style="font-size:13px;color:var(--ink-soft);">${list.length} checklist${list.length!==1?'s':''} ${activeFilters>0?`<span style="color:#E8520A;font-weight:600;">(${activeFilters} filter${activeFilters>1?'s':''} active)</span>`:''}
    </div>
    ${can('manageReports') ? `<button class="btn btn-primary" id="newFmChecklistBtn">+ New Checklist</button>` : ''}
  </div>

  <!-- Filter Bar -->
  <div class="fm-filter-bar">
    <div class="fm-filter-item">
      <label>Client</label>
      <select id="fm_fClient" onchange="state.fmFilterClient=this.value;state.fmFilterJO='All';render()">
        <option value="All">All Clients</option>
        ${allClients.map(c=>`<option value="${c}" ${fClient===c?'selected':''}>${c}</option>`).join('')}
      </select>
    </div>
    <div class="fm-filter-item">
      <label>Job Order</label>
      <select id="fm_fJO" onchange="state.fmFilterJO=this.value;render()">
        <option value="All">All JOs</option>
        ${allJOs.map(j=>`<option value="${j}" ${fJO===j?'selected':''}>${j}</option>`).join('')}
      </select>
    </div>
    <div class="fm-filter-item">
      <label>System / Template</label>
      <select id="fm_fTpl" onchange="state.fmFilterTemplate=this.value;render()">
        <option value="All">All Templates</option>
        ${allTemplates.map(t=>`<option value="${t.id}" ${fTemplate===t.id?'selected':''}>${t.name}</option>`).join('')}
      </select>
    </div>
    <div class="fm-filter-item">
      <label>Month</label>
      <input type="month" id="fm_fMonth" value="${fMonth}" onchange="state.fmFilterMonth=this.value;render()" style="padding:7px 10px;border:1px solid var(--rule);border-radius:7px;font-size:12px;">
    </div>
    <div class="fm-filter-item">
      <label>Status</label>
      <select id="fm_fStatus" onchange="state.fmFilterStatus=this.value;render()">
        <option value="All">All Statuses</option>
        <option value="Draft" ${fStatus==='Draft'?'selected':''}>Draft</option>
        <option value="Submitted" ${fStatus==='Submitted'?'selected':''}>Submitted</option>
      </select>
    </div>
    ${activeFilters>0?`<button class="btn btn-ghost btn-sm" onclick="state.fmFilterClient='All';state.fmFilterJO='All';state.fmFilterTemplate='All';state.fmFilterStatus='All';state.fmFilterMonth='';render()" style="align-self:flex-end;">✕ Clear</button>`:''}
  </div>
  ${list.length === 0 ? `<div class="card"><div class="empty"><div class="big">✅</div>No checklists yet.</div></div>` : `
  <div class="card">
    <div class="tbl-wrap"><table>
      <thead><tr><th>Ref No.</th><th>Template</th><th>Category</th><th>Client</th><th>Project</th><th>Month</th><th>Technician</th><th>Status</th><th>Progress</th><th></th></tr></thead>
      <tbody>${list.map(cl => {
        const total = cl.items.length;
        const done  = cl.items.filter(i => i.status !== null).length;
        const fails = cl.items.filter(i => i.status === 'fail').length;
        const pct   = total ? Math.round((done/total)*100) : 0;
        return `<tr>
          <td style="font-family:var(--mono);color:#E8520A;font-weight:700;font-size:12px;">${cl.refNumber}</td>
          <td style="font-size:12px;">${cl.templateName}</td>
          <td><span class="badge badge-draft" style="font-size:10px;">${cl.category}</span></td>
          <td style="font-size:12px;">${cl.clientCompany||'—'}</td>
          <td style="font-size:12px;">${cl.projectName||'—'}</td>
          <td style="font-size:12px;">${cl.month||'—'}</td>
          <td style="font-size:12px;">${cl.technicianName||'—'}</td>
          <td><span class="badge ${cl.status==='Submitted'?'badge-issued':'badge-draft'}">${cl.status}</span></td>
          <td>
            <div style="display:flex;align-items:center;gap:6px;">
              <div style="flex:1;background:#e5e7eb;border-radius:4px;height:6px;min-width:60px;">
                <div style="background:${fails>0?'#dc2626':'#1D9E75'};width:${pct}%;height:6px;border-radius:4px;"></div>
              </div>
              <span style="font-size:11px;color:var(--ink-soft);">${done}/${total}</span>
              ${fails>0?`<span style="font-size:11px;color:#dc2626;font-weight:600;">${fails} FAIL</span>`:''}
            </div>
          </td>
          <td><button class="btn btn-outline btn-sm" data-view-fm-cl="${cl.id}">Open</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
  </div>`}
  `;
}

function renderFmChecklistDetail(id) {
  const cl = state.fmChecklists.find(c => c.id === id);
  if (!cl) return '<div class="empty">Checklist not found.</div>';
  const total  = cl.items.length;
  const okCnt  = cl.items.filter(i => i.status === 'ok').length;
  const failCnt= cl.items.filter(i => i.status === 'fail').length;
  const naCnt  = cl.items.filter(i => i.status === 'na').length;
  const pct    = total ? Math.round(((okCnt+naCnt)/total)*100) : 0;

  // Category color
  const catColors = {
    'Fire & Safety': '#dc2626', 'Electrical': '#E8520A', 'HVAC': '#00627B',
    'Mechanical': '#7F77DD', 'IT/ELV': '#1D9E75', 'Civil/Other': '#888',
  };
  const catColor = catColors[cl.category] || '#E8520A';

  return `
  <!-- Checklist Title Header -->
  <div class="fm-cl-title-bar" style="border-left:5px solid ${catColor};">
    <div style="flex:1;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:${catColor};margin-bottom:4px;">${cl.category}</div>
      <div style="font-size:20px;font-weight:700;color:var(--ink);">${cl.templateName}</div>
      <div style="font-size:12px;color:var(--ink-soft);margin-top:3px;">
        ${cl.clientCompany} · ${cl.projectName||cl.jobOrderNumber} · ${cl.month}
      </div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <span class="badge ${cl.status==='Submitted'?'badge-issued':'badge-draft'}">${cl.status}</span>
      <button class="btn btn-ghost btn-sm" onclick="state.fmChecklistView=null;render()">← Back</button>
      ${cl.status==='Draft'&&can('manageReports') ? `<button class="btn btn-primary btn-sm" id="submitFmClBtn" data-id="${cl.id}">✓ Submit</button>` : ''}
      <button class="btn btn-teal btn-sm" id="printFmClBtn" data-id="${cl.id}">🖨 Print PDF</button>
    </div>
  </div>
  <div class="card" style="margin-bottom:14px;">
    <div class="card-head"><div class="card-title">Checklist Details</div></div>
    <div class="card-body">
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">
        <div><div class="k muted">Ref No.</div><div style="font-family:var(--mono);color:#E8520A;font-weight:700;">${cl.refNumber}</div></div>
        <div><div class="k muted">Client</div><div>${cl.clientCompany||'—'}</div></div>
        <div><div class="k muted">Project</div><div>${cl.projectName||'—'}</div></div>
        <div><div class="k muted">Job Order</div><div style="font-family:var(--mono);">${cl.jobOrderNumber||'—'}</div></div>
        <div><div class="k muted">Location</div><div>${cl.location||'—'} ${cl.building?'· '+cl.building:''}</div></div>
        <div><div class="k muted">Month</div><div>${cl.month||'—'}</div></div>
        <div><div class="k muted">Technician</div><div>${cl.technicianName||'—'}</div></div>
        <div><div class="k muted">Supervisor</div><div>${cl.supervisorName||'—'}</div></div>
        <div><div class="k muted">Category</div><div>${cl.category||'—'}</div></div>
      </div>
    </div>
  </div>
  <div class="card" style="margin-bottom:14px;">
    <div class="card-body" style="padding:14px 16px;">
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
        <div style="flex:1;background:#e5e7eb;border-radius:6px;height:10px;min-width:100px;">
          <div style="background:${failCnt>0?'#dc2626':'#1D9E75'};width:${pct}%;height:10px;border-radius:6px;"></div>
        </div>
        <span style="font-size:13px;font-weight:600;">${pct}% complete</span>
        <span style="font-size:12px;color:#1D9E75;font-weight:600;">✓ ${okCnt} OK</span>
        <span style="font-size:12px;color:#dc2626;font-weight:600;">✗ ${failCnt} FAIL</span>
        <span style="font-size:12px;color:#888;font-weight:600;">— ${naCnt} N/A</span>
        <span style="font-size:12px;color:#aaa;">${total-(okCnt+failCnt+naCnt)} pending</span>
      </div>
    </div>
  </div>
  <div class="card" style="margin-bottom:14px;">
    <div class="card-head"><div class="card-title">Checklist Items</div></div>
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="background:#f5f5f5;">
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#555;font-weight:700;border-bottom:2px solid #e5e7eb;width:36px;">#</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#555;font-weight:700;border-bottom:2px solid #e5e7eb;">Description</th>
          <th style="padding:10px 12px;text-align:center;font-size:11px;color:#555;font-weight:700;border-bottom:2px solid #e5e7eb;width:80px;">Freq.</th>
          <th style="padding:10px 8px;text-align:center;font-size:11px;color:#1D9E75;font-weight:700;border-bottom:2px solid #e5e7eb;width:70px;">✓ OK</th>
          <th style="padding:10px 8px;text-align:center;font-size:11px;color:#dc2626;font-weight:700;border-bottom:2px solid #e5e7eb;width:70px;">✗ FAIL</th>
          <th style="padding:10px 8px;text-align:center;font-size:11px;color:#888;font-weight:700;border-bottom:2px solid #e5e7eb;width:70px;">— N/A</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#555;font-weight:700;border-bottom:2px solid #e5e7eb;">Remarks</th>
        </tr></thead>
        <tbody>${cl.items.map((item) => `
          <tr style="border-bottom:1px solid #f0f0f0;${item.status==='fail'?'background:#fff5f5;':item.status==='ok'?'background:#f0faf5;':''}">
            <td style="padding:10px 12px;font-size:12px;color:#888;font-weight:600;">${item.id}</td>
            <td style="padding:10px 12px;font-size:13px;color:#0B2B36;">${item.description}</td>
            <td style="padding:10px 12px;text-align:center;font-size:11px;color:#888;">${item.frequency||'Daily'}</td>
            <td style="padding:8px;text-align:center;">
              <button onclick="fmSetItemStatus('${cl.id}','${item.id}','ok')" style="width:36px;height:36px;border-radius:8px;border:2px solid ${item.status==='ok'?'#1D9E75':'#e5e7eb'};background:${item.status==='ok'?'#1D9E75':'#fff'};color:${item.status==='ok'?'#fff':'#aaa'};font-size:16px;cursor:pointer;transition:all .15s;">✓</button>
            </td>
            <td style="padding:8px;text-align:center;">
              <button onclick="fmSetItemStatus('${cl.id}','${item.id}','fail')" style="width:36px;height:36px;border-radius:8px;border:2px solid ${item.status==='fail'?'#dc2626':'#e5e7eb'};background:${item.status==='fail'?'#dc2626':'#fff'};color:${item.status==='fail'?'#fff':'#aaa'};font-size:16px;cursor:pointer;transition:all .15s;">✗</button>
            </td>
            <td style="padding:8px;text-align:center;">
              <button onclick="fmSetItemStatus('${cl.id}','${item.id}','na')" style="width:36px;height:36px;border-radius:8px;border:2px solid ${item.status==='na'?'#888':'#e5e7eb'};background:${item.status==='na'?'#888':'#fff'};color:${item.status==='na'?'#fff':'#aaa'};font-size:14px;cursor:pointer;font-weight:600;transition:all .15s;">N/A</button>
            </td>
            <td style="padding:8px 12px;">
              <input type="text" placeholder="Remarks..." value="${item.remarks||''}"
                onchange="fmSetItemRemarks('${cl.id}','${item.id}',this.value)"
                style="width:100%;padding:6px 8px;border:1px solid #e5e7eb;border-radius:6px;font-size:12px;color:#0B2B36;">
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>
  <div class="card">
    <div class="card-head">
      <div class="card-title">Abnormality Log</div>
      ${cl.status==='Draft'?`<button class="btn btn-ghost btn-sm" id="addAbnBtn" data-id="${cl.id}">+ Add Entry</button>`:''}
    </div>
    ${cl.abnormalities.length===0?`<div class="empty" style="padding:20px;">No abnormalities recorded.</div>`:`
    <div class="tbl-wrap"><table>
      <thead><tr><th>Date</th><th>Abnormality</th><th>Action Taken</th><th>Status</th><th>Done By</th></tr></thead>
      <tbody>${cl.abnormalities.map(a=>`<tr>
        <td style="font-size:12px;">${a.date||'—'}</td>
        <td style="font-size:12px;">${a.abnormality||'—'}</td>
        <td style="font-size:12px;">${a.actionTaken||'—'}</td>
        <td><span class="badge ${a.status==='Resolved'?'badge-issued':'badge-low'}">${a.status||'Open'}</span></td>
        <td style="font-size:12px;">${a.doneBy||'—'}</td>
      </tr>`).join('')}
      </tbody>
    </table></div>`}
  </div>`;
}

/* ════════════════════════════════════════════════════════════════
   WORK COMPLETION REPORTS (WCR + SNR)
════════════════════════════════════════════════════════════════ */
const WR_WORK_TYPES = ['Painting / Touch Up','Plumbing','Electrical','HVAC / AC','Civil / Carpentry','Fire Alarm / FF','ELV / IT','Cleaning','General Maintenance','Other'];

function renderWorkReports() {
  const wcrs = [...state.workReports].sort((a,b) => b.createdAt - a.createdAt);
  return `
  <div class="toolbar">
    <div style="font-size:13px;color:var(--ink-soft);">${wcrs.length} report${wcrs.length!==1?'s':''}</div>
    <div style="display:flex;gap:8px;">
      ${can('manageReports')?`<button class="btn btn-outline" id="newSnrBtn">+ Service Notification</button>`:''}
      ${can('manageReports')?`<button class="btn btn-primary" id="newWcrBtn">+ Work Completion Report</button>`:''}
    </div>
  </div>
  ${wcrs.length===0?`<div class="card"><div class="empty"><div class="big">📋</div>No work reports yet.</div></div>`:`
  <div class="card">
    <div class="tbl-wrap"><table>
      <thead><tr><th>Ref No.</th><th>Type</th><th>Client</th><th>Project</th><th>Date</th><th>Tasks</th><th>Status</th><th>For Client</th><th></th></tr></thead>
      <tbody>${wcrs.map(wr=>`<tr>
        <td style="font-family:var(--mono);color:#E8520A;font-weight:700;font-size:12px;">${wr.refNumber}</td>
        <td><span class="badge ${wr.type==='WCR'?'badge-in':'badge-low'}" style="font-size:10px;">${wr.type}</span></td>
        <td style="font-size:12px;">${wr.clientCompany||'—'}</td>
        <td style="font-size:12px;">${wr.projectName||wr.jobOrderNumber||'—'}</td>
        <td style="font-size:12px;">${fmtDate(wr.date)}</td>
        <td style="font-size:12px;">${wr.type==='WCR'?(wr.tasks||[]).length+' task(s)':wr.subject||'—'}</td>
        <td><span class="badge ${wr.status==='Completed'?'badge-issued':'badge-low'}">${wr.status}</span></td>
        <td style="text-align:center;">${wr.forClient?'<span style="color:#1D9E75;font-weight:700;">✓</span>':'—'}</td>
        <td><button class="btn btn-outline btn-sm" data-view-wr="${wr.id}">Open</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
  </div>`}`;
}

function renderWorkReportDetail(id) {
  const wr = state.workReports.find(r => r.id === id);
  if (!wr) return '<div class="empty">Report not found.</div>';
  const isWCR = wr.type === 'WCR';
  return `
  <div class="fm-cl-title-bar" style="border-left:5px solid #E8520A;">
    <div style="flex:1;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#E8520A;margin-bottom:4px;">${isWCR?'Work Completion Report':'Service Notification Report'}</div>
      <div style="font-size:20px;font-weight:700;color:var(--ink);">${wr.refNumber}</div>
      <div style="font-size:12px;color:var(--ink-soft);margin-top:3px;">${wr.clientCompany} · ${wr.projectName||wr.jobOrderNumber} · ${fmtDate(wr.date)}</div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <span class="badge ${wr.status==='Completed'?'badge-issued':'badge-low'}">${wr.status}</span>
      ${wr.forClient?'<span class="badge badge-in">For Client</span>':''}
      <button class="btn btn-ghost btn-sm" onclick="state.workReportView=null;render()">← Back</button>
      <button class="btn btn-teal btn-sm" id="printWrBtn" data-id="${wr.id}">🖨 Print PDF</button>
      ${state.user?.role==='Super Admin'?`<button class="btn btn-outline btn-sm" data-delete-wr="${wr.id}" style="color:#dc2626;border-color:#fca5a5;">🗑 Delete</button>`:''}
    </div>
  </div>

  <!-- Info -->
  <div class="card" style="margin-bottom:14px;">
    <div class="card-body">
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">
        <div><div class="k muted">Client</div><div>${wr.clientCompany||'—'}</div></div>
        <div><div class="k muted">Project</div><div>${wr.projectName||'—'}</div></div>
        <div><div class="k muted">Job Order</div><div style="font-family:var(--mono);">${wr.jobOrderNumber||'—'}</div></div>
        <div><div class="k muted">Location</div><div>${wr.location||'—'}</div></div>
        <div><div class="k muted">Date</div><div>${fmtDate(wr.date)}</div></div>
        <div><div class="k muted">Technician</div><div>${wr.technicianName||'—'}</div></div>
        <div><div class="k muted">Supervisor</div><div>${wr.supervisorName||'—'}</div></div>
        <div><div class="k muted">Received By</div><div>${wr.receivedBy||'—'}</div></div>
        <div><div class="k muted">Status</div><div>${wr.status||'—'}</div></div>
      </div>
      ${wr.notes?`<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--rule);font-size:13px;"><strong>Notes:</strong> ${wr.notes}</div>`:''}
    </div>
  </div>

  ${isWCR ? `
  <!-- Tasks -->
  ${(wr.tasks||[]).map((task,i)=>`
  <div class="card" style="margin-bottom:12px;">
    <div class="card-head">
      <div class="card-title">Task ${i+1} — ${task.workType||'General Work'}</div>
      <span class="badge ${task.status==='Completed'?'badge-issued':'badge-low'}">${task.status||'Completed'}</span>
    </div>
    <div class="card-body">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
        <div><div class="k muted">Work Type</div><div>${task.workType||'—'}</div></div>
        <div><div class="k muted">Area / Location</div><div>${task.area||'—'}</div></div>
        ${task.materials?`<div style="grid-column:span 2;"><div class="k muted">Materials Used</div><div>${task.materials}</div></div>`:''}
      </div>
      ${task.description?`<div style="margin-bottom:12px;"><div class="k muted">Work Description</div><div style="font-size:13px;line-height:1.6;">${task.description}</div></div>`:''}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <div style="font-size:11px;font-weight:700;color:#dc2626;text-transform:uppercase;margin-bottom:6px;">📷 Before</div>
          ${task.beforePhotoUrl
            ?`<img src="${task.beforePhotoUrl}" style="width:100%;max-height:200px;object-fit:cover;border-radius:8px;border:2px solid #fecaca;" alt="Before">`
            :`<div style="width:100%;height:140px;background:#f5f5f5;border:2px dashed #e5e7eb;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:12px;color:#aaa;">No photo</div>`}
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;color:#1D9E75;text-transform:uppercase;margin-bottom:6px;">📷 After</div>
          ${task.afterPhotoUrl
            ?`<img src="${task.afterPhotoUrl}" style="width:100%;max-height:200px;object-fit:cover;border-radius:8px;border:2px solid #d1fae5;" alt="After">`
            :`<div style="width:100%;height:140px;background:#f5f5f5;border:2px dashed #e5e7eb;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:12px;color:#aaa;">No photo</div>`}
        </div>
      </div>
    </div>
  </div>`).join('')}` : `
  <!-- SNR Full Detail -->
  <div class="card" style="margin-bottom:12px;">
    <div class="card-head"><div class="card-title">${wr.subject||'Service Notification'}</div>
      <span class="badge ${wr.status==='Completed'?'badge-issued':'badge-low'}">${wr.status}</span>
    </div>
    <div class="card-body">
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:12px;">
        <div><div class="k muted">Work Type</div><div>${wr.workType||'—'}</div></div>
        <div><div class="k muted">Location</div><div>${wr.location||'—'}</div></div>
        <div><div class="k muted">Time</div><div>${wr.time||'—'}</div></div>
      </div>
      ${wr.description?`<div style="margin-bottom:14px;"><div class="k muted">Description</div>
        <div style="font-size:13px;line-height:1.6;background:#f8f9fa;border-radius:6px;padding:10px;border-left:3px solid #E8520A;">${wr.description}</div>
      </div>`:''}
      ${wr.photoUrl?`<div>
        <div style="font-size:11px;font-weight:700;color:#E8520A;text-transform:uppercase;margin-bottom:8px;">📷 Photo</div>
        <img src="${wr.photoUrl}" style="max-width:100%;max-height:400px;object-fit:contain;border-radius:10px;border:2px solid #e5e7eb;" alt="Photo">
      </div>`:`<div style="height:140px;background:#f5f5f5;border:2px dashed #e5e7eb;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:12px;color:#aaa;">No photo attached</div>`}
    </div>
  </div>
  <!-- SNR Signatures -->
  <div class="card" style="margin-bottom:12px;">
    <div class="card-head"><div class="card-title">Sign-Off</div></div>
    <div class="card-body">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
        <div>
          <div style="border-bottom:1px solid #555;height:30px;margin-bottom:6px;"></div>
          <div style="font-size:13px;font-weight:700;">${wr.technicianName||'—'}</div>
          <div style="font-size:11px;color:#1D9E75;">Prepared By — Al Fitr</div>
        </div>
        <div>
          <div style="border-bottom:1px solid #555;height:30px;margin-bottom:6px;"></div>
          <div style="font-size:13px;font-weight:700;">${wr.receivedBy||'Client Representative'}</div>
          <div style="font-size:11px;color:#1D9E75;">Received By — Signature & Date</div>
        </div>
      </div>
    </div>
  </div>`}
  `;
}

function renderWcrForm() {
  const WORK_TYPES = ['Painting / Touch Up','Plumbing','Electrical','HVAC / AC','Civil / Carpentry','Fire Alarm / FF','ELV / IT','Cleaning','General Maintenance','Other'];
  const p = state.modal?.payload || {};
  const tasks = p.tasks || [{ workType:'', area:'', description:'', materials:'', status:'Completed' }];
  return `
  <div class="grid2">
    <div class="field"><label>Client *</label>
      <select id="wcr_clientId" onchange="onWcrClientSelect()">
        <option value="">— Select Client —</option>
        ${[...state.clients].sort((a,b)=>a.companyName.localeCompare(b.companyName)).map(c=>`<option value="${c.id}" ${p.clientId===c.id?'selected':''}>${c.companyName}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>Job Order / Project *</label>
      <select id="wcr_joId" disabled>
        <option value="">— Select client first —</option>
      </select>
    </div>
  </div>
  <div class="grid2">
    <div class="field"><label>Date</label><input type="date" id="wcr_date" value="${p.date||new Date().toISOString().slice(0,10)}"></div>
    <div class="field"><label>Location / Area</label><input id="wcr_location" value="${p.location||''}" placeholder="e.g. Common Area, Building A"></div>
  </div>
  <div class="grid2">
    <div class="field"><label>Technician Name</label><input id="wcr_tech" value="${p.technicianName||state.user?.name||''}"></div>
    <div class="field"><label>Supervisor</label><input id="wcr_supervisor" value="${p.supervisorName||''}"></div>
  </div>

  <div style="border-top:1px solid var(--rule);margin:14px 0 10px;"></div>
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
    <div style="font-size:13px;font-weight:700;">Tasks</div>
    <button class="btn btn-ghost btn-sm" type="button" id="addWcrTaskBtn">+ Add Task</button>
  </div>
  <div id="wcrTasksList">
    ${tasks.map((t,i) => renderWcrTaskRow(t, i, WORK_TYPES)).join('')}
  </div>

  <div class="field" style="margin-top:10px;"><label>Notes</label><textarea id="wcr_notes" rows="2" placeholder="Any additional notes...">${p.notes||''}</textarea></div>
  <div class="grid2">
    <div class="field"><label>Status</label>
      <select id="wcr_status">
        <option value="Completed">Completed</option>
        <option value="Partially Completed">Partially Completed</option>
        <option value="Pending">Pending</option>
      </select>
    </div>
    <div class="field"><label>Report Type</label>
      <select id="wcr_forClient">
        <option value="false">Internal Only</option>
        <option value="true">For Client (include in PDF)</option>
      </select>
    </div>
  </div>
  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
    <button class="btn btn-ghost" id="modalCancel">Cancel</button>
    <button class="btn btn-primary" id="saveWcrBtn">Submit Report</button>
  </div>`;
}

function renderWcrTaskRow(t, i, WORK_TYPES) {
  return `
  <div class="card" style="margin-bottom:10px;background:#fafafa;" data-wcr-task="${i}">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <div style="font-size:12px;font-weight:700;color:#E8520A;">Task ${i+1}</div>
      ${i>0?`<button class="btn btn-ghost btn-sm removeWcrTaskBtn" data-idx="${i}" style="color:#dc2626;">✕ Remove</button>`:''}
    </div>
    <div class="grid2">
      <div class="field"><label>Work Type</label>
        <select class="wcr_task_type" data-idx="${i}">
          ${WORK_TYPES.map(wt=>`<option ${t.workType===wt?'selected':''}>${wt}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Area / Location</label>
        <input class="wcr_task_area" data-idx="${i}" value="${t.area||''}" placeholder="e.g. Room 201, Lobby">
      </div>
    </div>
    <div class="field"><label>Work Description</label>
      <textarea class="wcr_task_desc" data-idx="${i}" rows="2" placeholder="Describe the work done...">${t.description||''}</textarea>
    </div>
    <div class="field"><label>Materials Used (optional)</label>
      <input class="wcr_task_materials" data-idx="${i}" value="${t.materials||''}" placeholder="e.g. 1L paint, 2 PVC fittings">
    </div>
    <div class="grid2">
      <div class="field"><label>📷 Before Photo</label>
        <input type="file" class="wcr_task_before" data-idx="${i}" accept="image/*" style="font-size:12px;padding:6px;">
        ${t.beforePhotoUrl?`<div style="font-size:11px;color:#1D9E75;margin-top:3px;">✓ Photo uploaded</div>`:''}
      </div>
      <div class="field"><label>📷 After Photo</label>
        <input type="file" class="wcr_task_after" data-idx="${i}" accept="image/*" style="font-size:12px;padding:6px;">
        ${t.afterPhotoUrl?`<div style="font-size:11px;color:#1D9E75;margin-top:3px;">✓ Photo uploaded</div>`:''}
      </div>
    </div>
  </div>`;
}

function renderSnrForm() {
  const WORK_TYPES = ['Painting / Touch Up','Plumbing','Electrical','HVAC / AC','Civil / Carpentry','Fire Alarm / FF','ELV / IT','Cleaning','General Maintenance','Other'];
  const p = state.modal?.payload || {};
  return `
  <div class="grid2">
    <div class="field"><label>Client *</label>
      <select id="snr_clientId" onchange="onSnrClientSelect()">
        <option value="">— Select Client —</option>
        ${[...state.clients].sort((a,b)=>a.companyName.localeCompare(b.companyName)).map(c=>`<option value="${c.id}">${c.companyName}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>Job Order / Project *</label>
      <select id="snr_joId" disabled>
        <option value="">— Select client first —</option>
      </select>
    </div>
  </div>
  <div class="field"><label>Subject / Title *</label>
    <input id="snr_subject" value="${p.subject||''}" placeholder="e.g. AC not cooling in Room 201">
  </div>
  <div class="grid2">
    <div class="field"><label>Work Type</label>
      <select id="snr_workType">
        ${WORK_TYPES.map(wt=>`<option>${wt}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>Location / Area</label>
      <input id="snr_location" value="${p.location||''}" placeholder="e.g. Common Area, Block B">
    </div>
  </div>
  <div class="grid2">
    <div class="field"><label>Date</label><input type="date" id="snr_date" value="${new Date().toISOString().slice(0,10)}"></div>
    <div class="field"><label>Time</label><input type="time" id="snr_time" value="${new Date().toTimeString().slice(0,5)}"></div>
  </div>
  <div class="field"><label>Description *</label>
    <textarea id="snr_desc" rows="3" placeholder="Describe the issue or work done...">${p.description||''}</textarea>
  </div>
  <div class="field"><label>📷 Photo *</label>
    <input type="file" id="snr_photo" accept="image/*" style="font-size:12px;padding:6px;">
    <div style="font-size:11px;color:var(--muted);margin-top:3px;">Attach one clear photo of the work/issue</div>
  </div>
  <div class="grid2">
    <div class="field"><label>Technician</label><input id="snr_tech" value="${state.user?.name||''}"></div>
    <div class="field"><label>Status</label>
      <select id="snr_status">
        <option value="Completed">Completed</option>
        <option value="In Progress">In Progress</option>
        <option value="Pending">Pending</option>
      </select>
    </div>
  </div>
  <div class="field"><label>For Client</label>
    <select id="snr_forClient">
      <option value="false">Internal Only</option>
      <option value="true">For Client</option>
    </select>
  </div>
  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
    <button class="btn btn-ghost" id="modalCancel">Cancel</button>
    <button class="btn btn-primary" id="saveSnrBtn">Submit</button>
  </div>`;
}

function onWcrClientSelect() {
  const clientId = document.getElementById('wcr_clientId')?.value;
  const joSel    = document.getElementById('wcr_joId');
  if (!clientId||!joSel) return;
  const client = state.clients.find(c=>c.id===clientId);
  const jos    = state.jobOrders.filter(j=>j.clientId===clientId||j.clientCompany===client?.companyName);
  joSel.innerHTML = `<option value="">— Select Job Order —</option>` +
    jos.map(j=>`<option value="${j.id}">${j.jobOrderNumber} — ${j.subject||j.siteDetail||''}</option>`).join('');
  joSel.disabled = false;
}

function onSnrClientSelect() {
  const clientId = document.getElementById('snr_clientId')?.value;
  const joSel    = document.getElementById('snr_joId');
  if (!clientId||!joSel) return;
  const client = state.clients.find(c=>c.id===clientId);
  const jos    = state.jobOrders.filter(j=>j.clientId===clientId||j.clientCompany===client?.companyName);
  joSel.innerHTML = `<option value="">— Select Job Order —</option>` +
    jos.map(j=>`<option value="${j.id}">${j.jobOrderNumber} — ${j.subject||j.siteDetail||''}</option>`).join('');
  joSel.disabled = false;
}

function buildWcrPdf(wr) {
  const co = state.company||{};
  const isWCR = wr.type==='WCR';
  const logoHtml = co.logoPath?`<img src="${co.logoPath}" style="height:48px;object-fit:contain;" alt="logo">`:`<div style="font-size:14px;font-weight:700;color:#1D9E75;">AL FITR</div>`;
  const tasksHtml = isWCR ? (wr.tasks||[]).map((t,i)=>`
  <div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin-bottom:12px;page-break-inside:avoid;">
    <div style="font-size:12px;font-weight:700;color:#E8520A;margin-bottom:8px;border-bottom:1px solid #e5e7eb;padding-bottom:6px;">Task ${i+1} — ${t.workType||'General Work'}</div>
    <table style="width:100%;font-size:11px;margin-bottom:8px;"><tr>
      <td style="width:50%;padding:4px 0;"><strong>Area:</strong> ${t.area||'—'}</td>
      <td style="padding:4px 0;"><strong>Status:</strong> ${t.status||'Completed'}</td>
    </tr></table>
    ${t.description?`<div style="font-size:11px;margin-bottom:8px;"><strong>Work Done:</strong> ${t.description}</div>`:''}
    ${t.materials?`<div style="font-size:11px;margin-bottom:8px;"><strong>Materials:</strong> ${t.materials}</div>`:''}
    <table style="width:100%;border-collapse:collapse;">
      <tr>
        <td style="width:50%;padding-right:6px;vertical-align:top;">
          <div style="font-size:10px;font-weight:700;color:#dc2626;text-transform:uppercase;margin-bottom:4px;">Before</div>
          ${t.beforePhotoUrl?`<img src="${t.beforePhotoUrl}" style="width:100%;max-height:180px;object-fit:cover;border-radius:6px;border:2px solid #fecaca;">`:`<div style="height:120px;background:#f5f5f5;border:2px dashed #e5e7eb;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#aaa;">No photo</div>`}
        </td>
        <td style="width:50%;padding-left:6px;vertical-align:top;">
          <div style="font-size:10px;font-weight:700;color:#1D9E75;text-transform:uppercase;margin-bottom:4px;">After</div>
          ${t.afterPhotoUrl?`<img src="${t.afterPhotoUrl}" style="width:100%;max-height:180px;object-fit:cover;border-radius:6px;border:2px solid #d1fae5;">`:`<div style="height:120px;background:#f5f5f5;border:2px dashed #e5e7eb;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#aaa;">No photo</div>`}
        </td>
      </tr>
    </table>
  </div>`).join('') : `
  <div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin-bottom:12px;">
    <div style="font-size:12px;font-weight:700;color:#E8520A;margin-bottom:8px;">${wr.subject||'Service Notification'}</div>
    ${wr.description?`<div style="font-size:11px;margin-bottom:12px;line-height:1.6;">${wr.description}</div>`:''}
    ${wr.photoUrl?`<img src="${wr.photoUrl}" style="max-width:100%;max-height:300px;object-fit:contain;border-radius:8px;border:1px solid #e5e7eb;">`:''}
  </div>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${wr.refNumber}</title>
  <style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;font-size:11px;color:#1a1a1a;}@page{size:A4 portrait;margin:12mm;}img{max-width:100%;}</style>
  </head><body>
  <div style="border-bottom:3px solid #E8520A;display:flex;align-items:center;justify-content:space-between;padding-bottom:10px;margin-bottom:14px;">
    <div style="display:flex;align-items:center;gap:12px;">${logoHtml}
      <div><div style="font-size:14px;font-weight:700;color:#E8520A;">${co.name||'Al Fitr Electromechanical Works LLC'}</div></div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:13px;font-weight:700;color:#00627B;">${isWCR?'WORK COMPLETION REPORT':'SERVICE NOTIFICATION REPORT'}</div>
      <div style="font-size:12px;color:#E8520A;font-weight:700;">${wr.refNumber}</div>
      <div style="font-size:10px;color:#555;">Date: ${fmtDate(wr.date)}</div>
    </div>
  </div>
  <table style="width:100%;border-collapse:collapse;margin-bottom:14px;font-size:11px;">
    <tr>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;width:18%;">Client</td>
      <td style="padding:5px 8px;border:1px solid #ddd;width:32%;">${wr.clientCompany||'—'}</td>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;width:18%;">Project</td>
      <td style="padding:5px 8px;border:1px solid #ddd;">${wr.projectName||'—'}</td>
    </tr>
    <tr>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;">Job Order</td>
      <td style="padding:5px 8px;border:1px solid #ddd;font-family:monospace;">${wr.jobOrderNumber||'—'}</td>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;">Location</td>
      <td style="padding:5px 8px;border:1px solid #ddd;">${wr.location||'—'}</td>
    </tr>
    <tr>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;">Technician</td>
      <td style="padding:5px 8px;border:1px solid #ddd;">${wr.technicianName||'—'}</td>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;">Supervisor</td>
      <td style="padding:5px 8px;border:1px solid #ddd;">${wr.supervisorName||'—'}</td>
    </tr>
  </table>
  ${tasksHtml}
  ${wr.notes?`<div style="border:1px solid #e5e7eb;border-radius:6px;padding:10px;margin-bottom:14px;font-size:11px;"><strong>Notes:</strong> ${wr.notes}</div>`:''}
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:16px;">
    <div><div style="border-bottom:1px solid #555;height:30px;margin-bottom:5px;"></div>
      <div style="font-size:11px;font-weight:700;">${wr.technicianName||'Technician'}</div>
      <div style="font-size:10px;color:#1D9E75;">Prepared By — Al Fitr</div></div>
    <div><div style="border-bottom:1px solid #555;height:30px;margin-bottom:5px;"></div>
      <div style="font-size:11px;font-weight:700;">${wr.receivedBy||'Client Representative'}</div>
      <div style="font-size:10px;color:#1D9E75;">Received By — Signature & Date</div></div>
  </div>
  </body></html>`;
}

/* ════════════════════════════════════════════════════════════════
   FM INCIDENT REPORTS
════════════════════════════════════════════════════════════════ */
const IR_TYPES     = ['Health & Safety','Fire','Electrical','Plumbing','HVAC / AC','Fire Alarm','Fire Fighting','Civil / Structural','Environmental','Other'];
const IR_SEVERITIES= ['Near Miss','Minor','Major','Critical','Fatal'];
const IR_SEV_COLOR = { 'Near Miss':'#888','Minor':'#1D9E75','Major':'#E8520A','Critical':'#dc2626','Fatal':'#7F1D1D' };

function renderIncidents() {
  const list = [...state.fmIncidents].sort((a,b) => b.createdAt - a.createdAt);
  return `
  <div class="toolbar">
    <div style="font-size:13px;color:var(--ink-soft);">${list.length} incident report${list.length!==1?'s':''}</div>
    ${can('manageReports')?`<button class="btn btn-primary" id="newIncidentBtn">+ New Incident Report</button>`:''}
  </div>
  ${list.length===0?`<div class="card"><div class="empty"><div class="big">🚨</div>No incident reports yet.</div></div>`:`
  <div class="card">
    <div class="tbl-wrap"><table>
      <thead><tr><th>Ref No.</th><th>Type</th><th>Severity</th><th>Client</th><th>Project</th><th>Date</th><th>Status</th><th></th></tr></thead>
      <tbody>${list.map(ir=>`<tr>
        <td style="font-family:var(--mono);color:#E8520A;font-weight:700;font-size:12px;">${ir.refNumber}</td>
        <td style="font-size:12px;">${ir.incidentType}</td>
        <td><span style="background:${IR_SEV_COLOR[ir.severity]||'#888'}20;color:${IR_SEV_COLOR[ir.severity]||'#888'};padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;">${ir.severity}</span></td>
        <td style="font-size:12px;">${ir.clientCompany||'—'}</td>
        <td style="font-size:12px;">${ir.projectName||'—'}</td>
        <td style="font-size:12px;">${fmtDate(ir.date)}</td>
        <td><span class="badge ${ir.status==='Closed'?'badge-issued':'badge-low'}">${ir.status||'Open'}</span></td>
        <td><button class="btn btn-outline btn-sm" data-view-ir="${ir.id}">Open</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
  </div>`}`;
}

function renderIncidentDetail(id) {
  const ir = state.fmIncidents.find(r => r.id === id);
  if (!ir) return '<div class="empty">Report not found.</div>';
  const sevColor = IR_SEV_COLOR[ir.severity] || '#888';
  return `
  <div class="fm-cl-title-bar" style="border-left:5px solid ${sevColor};">
    <div style="flex:1;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:${sevColor};margin-bottom:4px;">${ir.incidentType} Incident</div>
      <div style="font-size:20px;font-weight:700;color:var(--ink);">${ir.refNumber}</div>
      <div style="font-size:12px;color:var(--ink-soft);margin-top:3px;">${ir.clientCompany} · ${ir.projectName||ir.jobOrderNumber} · ${fmtDate(ir.date)}</div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <span style="background:${sevColor}20;color:${sevColor};padding:3px 10px;border-radius:4px;font-size:12px;font-weight:700;">${ir.severity}</span>
      <button class="btn btn-ghost btn-sm" onclick="state.incidentView=null;render()">← Back</button>
      <button class="btn btn-teal btn-sm" id="printIrBtn" data-id="${ir.id}">🖨 Print PDF</button>
      ${can('manageReports')?`<button class="btn btn-outline btn-sm" style="color:#dc2626;border-color:#fca5a5;" data-delete-ir="${ir.id}">🗑 Delete</button>`:''}
    </div>
  </div>

  <!-- Info Grid -->
  <div class="card" style="margin-bottom:14px;">
    <div class="card-body">
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">
        <div><div class="k muted">Incident Type</div><div>${ir.incidentType}</div></div>
        <div><div class="k muted">Severity</div><div style="color:${sevColor};font-weight:700;">${ir.severity}</div></div>
        <div><div class="k muted">Classification</div><div>${ir.classification||'—'}</div></div>
        <div><div class="k muted">Client</div><div>${ir.clientCompany||'—'}</div></div>
        <div><div class="k muted">Project</div><div>${ir.projectName||'—'}</div></div>
        <div><div class="k muted">Job Order</div><div style="font-family:var(--mono);">${ir.jobOrderNumber||'—'}</div></div>
        <div><div class="k muted">Location</div><div>${ir.location||'—'}</div></div>
        <div><div class="k muted">Date</div><div>${fmtDate(ir.date)}</div></div>
        <div><div class="k muted">Time</div><div>${ir.time||'—'}</div></div>
        ${ir.supervisorName?`<div><div class="k muted">Supervisor</div><div>${ir.supervisorName}</div></div>`:''}
        ${ir.affectedPerson?`<div><div class="k muted">Affected Person</div><div>${ir.affectedPerson}${ir.affectedDesignation?' ('+ir.affectedDesignation+')':''}</div></div>`:''}
        ${ir.injuryType?`<div><div class="k muted">Injury Type</div><div>${ir.injuryType}</div></div>`:''}
      </div>
      ${ir.typeDetails?`<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--rule);">
        <div class="k muted">Type-Specific Details</div>
        <div style="font-size:13px;line-height:1.6;margin-top:4px;">${ir.typeDetails}</div>
      </div>`:''}
      ${(ir.material||ir.extinguishingMedia||ir.estimatedCost)?`
      <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--rule);display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">
        ${ir.material?`<div><div class="k muted">Material Involved</div><div>${ir.material}</div></div>`:''}
        ${ir.extinguishingMedia?`<div><div class="k muted">Extinguishing Media</div><div>${ir.extinguishingMedia}</div></div>`:''}
        ${ir.estimatedCost?`<div><div class="k muted">Estimated Cost</div><div>AED ${ir.estimatedCost}</div></div>`:''}
        ${ir.civilDefenseInformed!==undefined?`<div><div class="k muted">Civil Defense Informed</div><div>${ir.civilDefenseInformed?'Yes':'No'}</div></div>`:''}
      </div>`:''}
    </div>
  </div>

  <!-- Photos -->
  ${ir.photos&&ir.photos.length>0?`
  <div class="card" style="margin-bottom:14px;">
    <div class="card-head"><div class="card-title">Incident Photos</div></div>
    <div class="card-body">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        ${ir.photos.map((url,i)=>`
        <div>
          <div style="font-size:10px;font-weight:700;color:#E8520A;text-transform:uppercase;margin-bottom:4px;">Photo ${i+1}</div>
          <img src="${url}" style="width:100%;height:200px;object-fit:cover;border-radius:8px;border:1px solid var(--rule);" alt="Photo ${i+1}">
        </div>`).join('')}
      </div>
    </div>
  </div>`:''}

  <!-- Description & Actions -->
  <div class="card" style="margin-bottom:14px;">
    <div class="card-head"><div class="card-title">Description & Actions</div></div>
    <div class="card-body">
      ${ir.description?`<div style="margin-bottom:12px;"><div class="k muted">Description of Incident</div><div style="font-size:13px;line-height:1.6;background:#f8f9fa;border-radius:6px;padding:10px;border-left:3px solid #E8520A;margin-top:4px;">${ir.description}</div></div>`:''}
      ${ir.immediateAction?`<div style="margin-bottom:12px;"><div class="k muted">Immediate Action Taken</div><div style="font-size:13px;line-height:1.6;background:#f8f9fa;border-radius:6px;padding:10px;border-left:3px solid #1D9E75;margin-top:4px;">${ir.immediateAction}</div></div>`:''}
      ${ir.correctiveAction?`<div><div class="k muted">Corrective Action</div><div style="font-size:13px;line-height:1.6;background:#f8f9fa;border-radius:6px;padding:10px;border-left:3px solid #00627B;margin-top:4px;">${ir.correctiveAction}</div></div>`:''}
    </div>
  </div>

  <!-- Cause Analysis -->
  <div class="card" style="margin-bottom:14px;">
    <div class="card-head"><div class="card-title">Cause Analysis</div></div>
    <div class="card-body">
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">
        <div style="background:#fff5f5;border-radius:8px;padding:12px;border-top:3px solid #dc2626;">
          <div style="font-size:10px;font-weight:700;color:#dc2626;text-transform:uppercase;margin-bottom:6px;">Immediate Cause</div>
          <div style="font-size:12px;">${ir.immediateCause||'—'}</div>
        </div>
        <div style="background:#fff8f0;border-radius:8px;padding:12px;border-top:3px solid #E8520A;">
          <div style="font-size:10px;font-weight:700;color:#E8520A;text-transform:uppercase;margin-bottom:6px;">Underlying Cause</div>
          <div style="font-size:12px;">${ir.underlyingCause||'—'}</div>
        </div>
        <div style="background:#f0faf5;border-radius:8px;padding:12px;border-top:3px solid #1D9E75;">
          <div style="font-size:10px;font-weight:700;color:#1D9E75;text-transform:uppercase;margin-bottom:6px;">Root Cause</div>
          <div style="font-size:12px;">${ir.rootCause||'—'}</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Risk Controls -->
  ${ir.riskControls&&ir.riskControls.length>0?`
  <div class="card" style="margin-bottom:14px;">
    <div class="card-head"><div class="card-title">Risk Control Measures</div></div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Risk Control</th><th>Planned Date</th><th>Actual Date</th><th>Responsibility</th></tr></thead>
      <tbody>${ir.riskControls.map(rc=>`<tr>
        <td style="font-size:12px;">${rc.control||'—'}</td>
        <td style="font-size:12px;">${rc.plannedDate||'—'}</td>
        <td style="font-size:12px;">${rc.actualDate||'—'}</td>
        <td style="font-size:12px;">${rc.responsibility||'—'}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </div>`:''}

  <!-- Signatures -->
  <div class="card">
    <div class="card-head"><div class="card-title">Sign-Off</div></div>
    <div class="card-body">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
        <div>
          <div style="border-bottom:1px solid #555;height:30px;margin-bottom:6px;"></div>
          <div style="font-size:13px;font-weight:700;">${ir.preparedByName||'—'}</div>
          <div style="font-size:11px;color:#1D9E75;">${ir.preparedByDesig||'Prepared By'}</div>
        </div>
        <div>
          <div style="border-bottom:1px solid #555;height:30px;margin-bottom:6px;"></div>
          <div style="font-size:13px;font-weight:700;">${ir.approvedByName||'—'}</div>
          <div style="font-size:11px;color:#1D9E75;">${ir.approvedByDesig||'Approved By'}</div>
        </div>
      </div>
    </div>
  </div>`;
}

function renderIncidentForm() {
  return `
  <div class="grid2">
    <div class="field"><label>Client *</label>
      <select id="ir_clientId" onchange="onIrClientSelect()">
        <option value="">— Select Client —</option>
        ${[...state.clients].sort((a,b)=>a.companyName.localeCompare(b.companyName)).map(c=>`<option value="${c.id}">${c.companyName}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>Job Order / Project *</label>
      <select id="ir_joId" disabled>
        <option value="">— Select client first —</option>
      </select>
    </div>
  </div>
  <div class="grid2">
    <div class="field"><label>Incident Type *</label>
      <select id="ir_type">
        ${IR_TYPES.map(t=>`<option>${t}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>Severity *</label>
      <select id="ir_severity">
        ${IR_SEVERITIES.map(s=>`<option>${s}</option>`).join('')}
      </select>
    </div>
  </div>
  <div class="grid2">
    <div class="field"><label>Date *</label><input type="date" id="ir_date" value="${new Date().toISOString().slice(0,10)}"></div>
    <div class="field"><label>Time</label><input type="time" id="ir_time" value="${new Date().toTimeString().slice(0,5)}"></div>
  </div>
  <div class="grid2">
    <div class="field"><label>Location / Area *</label><input id="ir_location" placeholder="e.g. Ground Floor, Pump Room"></div>
    <div class="field"><label>Classification</label><input id="ir_class" placeholder="e.g. Property Damage, Near Miss"></div>
  </div>

  <!-- Type specific -->
  <div class="field"><label>Type-Specific Details</label>
    <textarea id="ir_typeDetails" rows="2" placeholder="e.g. Material involved, equipment affected, chemical substance..."></textarea>
  </div>
  <div class="grid2">
    <div class="field"><label>Material / Substance Involved</label><input id="ir_material" placeholder="e.g. Electrical wiring, refrigerant"></div>
    <div class="field"><label>Extinguishing / Containment Media</label><input id="ir_extMedia" placeholder="e.g. CO2 extinguisher, absorbent material"></div>
  </div>
  <div class="grid2">
    <div class="field"><label>Estimated Cost (AED)</label><input type="number" id="ir_cost" placeholder="0"></div>
    <div class="field"><label>Civil Defense / Authority Informed</label>
      <select id="ir_cdInformed">
        <option value="false">No</option>
        <option value="true">Yes</option>
      </select>
    </div>
  </div>

  <!-- H&S Section -->
  <div class="grid2">
    <div class="field"><label>Affected Person (if any)</label><input id="ir_affectedPerson" placeholder="Name of affected person"></div>
    <div class="field"><label>Designation / Role</label><input id="ir_affectedDesig" placeholder="e.g. Technician, Foreman"></div>
  </div>
  <div class="field"><label>Injury / Damage Type</label><input id="ir_injuryType" placeholder="e.g. Electrical burn, Sprain, Property damage"></div>

  <div style="border-top:1px solid var(--rule);margin:12px 0;"></div>

  <!-- Core fields -->
  <div class="field"><label>Description of Incident *</label>
    <textarea id="ir_desc" rows="3" placeholder="Describe what happened, when, where and how..."></textarea>
  </div>
  <div class="field"><label>Immediate Action Taken</label>
    <textarea id="ir_immediate" rows="2" placeholder="What was done immediately after the incident..."></textarea>
  </div>
  <div class="field"><label>Corrective Action</label>
    <textarea id="ir_corrective" rows="2" placeholder="Long-term corrective measures planned or taken..."></textarea>
  </div>

  <!-- Cause Analysis -->
  <div style="border-top:1px solid var(--rule);margin:12px 0;padding-top:12px;">
    <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:10px;">Cause Analysis</div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
      <div class="field"><label style="color:#dc2626;">Immediate Cause</label><textarea id="ir_immCause" rows="2" placeholder="Direct cause of incident..."></textarea></div>
      <div class="field"><label style="color:#E8520A;">Underlying Cause</label><textarea id="ir_undCause" rows="2" placeholder="Contributing factors..."></textarea></div>
      <div class="field"><label style="color:#1D9E75;">Root Cause</label><textarea id="ir_rootCause" rows="2" placeholder="Fundamental reason..."></textarea></div>
    </div>
  </div>

  <!-- Risk Controls -->
  <div style="border-top:1px solid var(--rule);margin:12px 0;padding-top:12px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;">Risk Control Measures</div>
      <button class="btn btn-ghost btn-sm" type="button" id="addRcBtn">+ Add Row</button>
    </div>
    <div id="rcRows">
      <div class="rc-row" style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr auto;gap:6px;margin-bottom:6px;">
        <input placeholder="Risk control measure..." style="font-size:12px;">
        <input type="date" style="font-size:12px;">
        <input type="date" style="font-size:12px;">
        <input placeholder="Responsible person..." style="font-size:12px;">
        <button type="button" onclick="this.closest('.rc-row').remove()" style="background:none;border:none;color:#dc2626;cursor:pointer;font-size:16px;">✕</button>
      </div>
    </div>
  </div>

  <!-- Photos -->
  <div style="border-top:1px solid var(--rule);margin:12px 0;padding-top:12px;">
    <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:8px;">Photos (up to 5)</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
      ${[0,1,2,3,4].map(i=>`
      <div class="field">
        <label>Photo ${i+1}</label>
        <input type="file" id="ir_photo_${i}" accept="image/*" style="font-size:12px;padding:6px;">
      </div>`).join('')}
    </div>
  </div>

  <!-- People -->
  <div style="border-top:1px solid var(--rule);margin:12px 0;padding-top:12px;">
    <div class="grid2">
      ${userPickerHtml('irPreparedBy', state.user?.name, state.user?.designation, 'Prepared By')}
      ${userPickerHtml('irApprovedBy', '', '', 'Approved By')}
    </div>
    <div class="field"><label>Supervisor on Site</label><input id="ir_supervisor" placeholder="Name of site supervisor"></div>
  </div>

  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
    <button class="btn btn-ghost" id="modalCancel">Cancel</button>
    <button class="btn btn-primary" id="saveIrBtn">Submit Incident Report</button>
  </div>`;
}

function onIrClientSelect() {
  const cId = document.getElementById('ir_clientId')?.value;
  const joSel = document.getElementById('ir_joId');
  if (!cId||!joSel) return;
  const client = state.clients.find(c=>c.id===cId);
  const jos    = state.jobOrders.filter(j=>j.clientId===cId||j.clientCompany===client?.companyName);
  joSel.innerHTML = `<option value="">— Select Job Order —</option>` +
    jos.map(j=>`<option value="${j.id}">${j.jobOrderNumber} — ${j.subject||''}</option>`).join('');
  joSel.disabled = false;
}

function buildIrPdf(ir) {
  const co   = state.company || {};
  const sev  = IR_SEV_COLOR[ir.severity] || '#888';
  const logo = co.logoPath ? `<img src="${co.logoPath}" style="height:48px;object-fit:contain;" alt="logo">` : `<div style="font-size:14px;font-weight:700;color:#1D9E75;">AL FITR</div>`;

  const photosHtml = ir.photos&&ir.photos.length>0 ? `
  <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#555;margin:12px 0 8px;letter-spacing:.5px;">Incident Photos</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
    ${ir.photos.map((url,i)=>`
    <div>
      <div style="font-size:10px;font-weight:700;color:#E8520A;margin-bottom:4px;">Photo ${i+1}</div>
      <img src="${url}" style="width:100%;height:180px;object-fit:cover;border-radius:6px;border:1px solid #e5e7eb;">
    </div>`).join('')}
  </div>` : '';

  const rcRows = ir.riskControls&&ir.riskControls.length>0 ? ir.riskControls.map(rc=>`
  <tr>
    <td style="padding:5px 8px;border:1px solid #ddd;font-size:11px;">${rc.control||''}</td>
    <td style="padding:5px 8px;border:1px solid #ddd;font-size:11px;">${rc.plannedDate||''}</td>
    <td style="padding:5px 8px;border:1px solid #ddd;font-size:11px;">${rc.actualDate||''}</td>
    <td style="padding:5px 8px;border:1px solid #ddd;font-size:11px;">${rc.responsibility||''}</td>
  </tr>`).join('') : '<tr><td colspan="4" style="padding:8px;text-align:center;color:#aaa;font-size:11px;">No risk control measures recorded</td></tr>';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${ir.refNumber}</title>
  <style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;font-size:11px;color:#1a1a1a;}@page{size:A4 portrait;margin:12mm;}img{max-width:100%;}</style>
  </head><body>

  <!-- Header -->
  <div style="border-bottom:3px solid #E8520A;display:flex;align-items:center;justify-content:space-between;padding-bottom:10px;margin-bottom:14px;">
    <div style="display:flex;align-items:center;gap:12px;">${logo}
      <div style="font-size:14px;font-weight:700;color:#E8520A;">${co.name||'Al Fitr Electromechanical Works LLC'}</div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:13px;font-weight:700;color:#00627B;">INCIDENT / INVESTIGATION REPORT</div>
      <div style="font-size:12px;color:#E8520A;font-weight:700;">${ir.refNumber}</div>
      <div style="font-size:10px;color:#555;">Date: ${fmtDate(ir.date)}</div>
    </div>
  </div>

  <!-- Info Table -->
  <table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
    <tr>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;width:20%;">Client</td>
      <td style="padding:5px 8px;border:1px solid #ddd;width:30%;">${ir.clientCompany||'—'}</td>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;width:20%;">Project</td>
      <td style="padding:5px 8px;border:1px solid #ddd;">${ir.projectName||'—'}</td>
    </tr>
    <tr>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;">Job Order</td>
      <td style="padding:5px 8px;border:1px solid #ddd;font-family:monospace;">${ir.jobOrderNumber||'—'}</td>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;">Location</td>
      <td style="padding:5px 8px;border:1px solid #ddd;">${ir.location||'—'}</td>
    </tr>
    <tr>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;">Incident Type</td>
      <td style="padding:5px 8px;border:1px solid #ddd;">${ir.incidentType}</td>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;">Severity</td>
      <td style="padding:5px 8px;border:1px solid #ddd;"><span style="color:${sev};font-weight:700;">${ir.severity}</span></td>
    </tr>
    <tr>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;">Date & Time</td>
      <td style="padding:5px 8px;border:1px solid #ddd;">${fmtDate(ir.date)} ${ir.time||''}</td>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;">Classification</td>
      <td style="padding:5px 8px;border:1px solid #ddd;">${ir.classification||'—'}</td>
    </tr>
    ${ir.affectedPerson?`<tr>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;">Affected Person</td>
      <td style="padding:5px 8px;border:1px solid #ddd;">${ir.affectedPerson} ${ir.affectedDesignation?'('+ir.affectedDesignation+')':''}</td>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;">Injury / Damage</td>
      <td style="padding:5px 8px;border:1px solid #ddd;">${ir.injuryType||'—'}</td>
    </tr>`:''}
    ${ir.material?`<tr>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;">Material Involved</td>
      <td style="padding:5px 8px;border:1px solid #ddd;">${ir.material}</td>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;">Est. Cost (AED)</td>
      <td style="padding:5px 8px;border:1px solid #ddd;">${ir.estimatedCost||'—'}</td>
    </tr>`:''}
  </table>

  ${photosHtml}

  <!-- Description -->
  ${ir.description?`<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#555;margin:10px 0 4px;letter-spacing:.5px;">Description of Incident</div>
  <div style="border:1px solid #e5e7eb;border-left:3px solid #E8520A;border-radius:4px;padding:8px;font-size:11px;line-height:1.6;margin-bottom:10px;">${ir.description}</div>`:''}

  ${ir.immediateAction?`<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#555;margin:10px 0 4px;letter-spacing:.5px;">Immediate Action Taken</div>
  <div style="border:1px solid #e5e7eb;border-left:3px solid #1D9E75;border-radius:4px;padding:8px;font-size:11px;line-height:1.6;margin-bottom:10px;">${ir.immediateAction}</div>`:''}

  ${ir.correctiveAction?`<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#555;margin:10px 0 4px;letter-spacing:.5px;">Corrective Action</div>
  <div style="border:1px solid #e5e7eb;border-left:3px solid #00627B;border-radius:4px;padding:8px;font-size:11px;line-height:1.6;margin-bottom:10px;">${ir.correctiveAction}</div>`:''}

  <!-- Cause Analysis -->
  <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#555;margin:10px 0 6px;letter-spacing:.5px;">Cause Analysis</div>
  <table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
    <tr>
      <th style="padding:6px 8px;background:#dc2626;color:#fff;border:1px solid #dc2626;font-size:10px;width:33%;">Immediate Cause</th>
      <th style="padding:6px 8px;background:#E8520A;color:#fff;border:1px solid #E8520A;font-size:10px;width:33%;">Underlying Cause</th>
      <th style="padding:6px 8px;background:#1D9E75;color:#fff;border:1px solid #1D9E75;font-size:10px;width:33%;">Root Cause</th>
    </tr>
    <tr>
      <td style="padding:8px;border:1px solid #ddd;font-size:11px;vertical-align:top;">${ir.immediateCause||'—'}</td>
      <td style="padding:8px;border:1px solid #ddd;font-size:11px;vertical-align:top;">${ir.underlyingCause||'—'}</td>
      <td style="padding:8px;border:1px solid #ddd;font-size:11px;vertical-align:top;">${ir.rootCause||'—'}</td>
    </tr>
  </table>

  <!-- Risk Controls -->
  <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#555;margin:10px 0 6px;letter-spacing:.5px;">Risk Control Measures</div>
  <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
    <tr style="background:#2c2c2c;">
      <th style="padding:6px 8px;color:#fff;font-size:10px;text-align:left;border:1px solid #444;">Risk Control</th>
      <th style="padding:6px 8px;color:#fff;font-size:10px;text-align:left;border:1px solid #444;width:15%;">Planned Date</th>
      <th style="padding:6px 8px;color:#fff;font-size:10px;text-align:left;border:1px solid #444;width:15%;">Actual Date</th>
      <th style="padding:6px 8px;color:#fff;font-size:10px;text-align:left;border:1px solid #444;width:20%;">Responsibility</th>
    </tr>
    ${rcRows}
  </table>

  <!-- Signatures -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:10px;">
    <div style="text-align:center;">
      <div style="border-bottom:1px solid #555;height:30px;margin-bottom:5px;"></div>
      <div style="font-size:11px;font-weight:700;">${ir.preparedByName||'Prepared By'}</div>
      <div style="font-size:10px;color:#1D9E75;">${ir.preparedByDesig||'Signature & Date'}</div>
    </div>
    <div style="text-align:center;">
      <div style="border-bottom:1px solid #555;height:30px;margin-bottom:5px;"></div>
      <div style="font-size:11px;font-weight:700;">${ir.approvedByName||'Approved By'}</div>
      <div style="font-size:10px;color:#1D9E75;">${ir.approvedByDesig||'Signature & Date'}</div>
    </div>
  </div>

  </body></html>`;
}

function renderFmIncidents() {
  return renderIncidents();
}

async function fmSetItemStatus(clId, itemId, status) {
  const cl = state.fmChecklists.find(c => c.id === clId);
  if (!cl) return;
  const item = cl.items.find(i => String(i.id) === String(itemId));
  if (!item) return;
  item.status = item.status === status ? null : status;
  render();
  try { await api('PUT', '/api/fm-checklists/' + clId, { items: cl.items }); }
  catch(e) { showToast('Save failed: ' + e.message, 'err'); }
}

async function fmSetItemRemarks(clId, itemId, remarks) {
  const cl = state.fmChecklists.find(c => c.id === clId);
  if (!cl) return;
  const item = cl.items.find(i => String(i.id) === String(itemId));
  if (item) item.remarks = remarks;
  try { await api('PUT', '/api/fm-checklists/' + clId, { items: cl.items }); }
  catch(e) { console.error(e); }
}

function renderFmChecklistForm() {
  const jos = state.jobOrders;
  const cats = {};
  state.fmTemplates.forEach(t => {
    if (!cats[t.category]) cats[t.category] = [];
    cats[t.category].push(t);
  });
  return `
  <div class="field"><label>Client *</label>
    <select id="fm_clientId" onchange="onFmClientSelect()">
      <option value="">— Select Client —</option>
      ${[...state.clients].sort((a,b)=>a.companyName.localeCompare(b.companyName)).map(c=>`<option value="${c.id}">${c.companyName}</option>`).join('')}
    </select>
  </div>
  <div class="field"><label>Job Order / Project *</label>
    <select id="fm_joId" onchange="onFmJoSelect()" disabled>
      <option value="">— Select client first —</option>
    </select>
  </div>
  <div id="fm_jo_info" style="display:none;background:#f0faf5;border:1px solid #d1fae5;border-radius:6px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#085041;"></div>
  <div class="field"><label>Checklist Template *</label>
    <select id="fm_tplId" onchange="onFmTplSelect()">
      <option value="">— Select Template —</option>
      ${Object.entries(cats).map(([cat, tpls]) => `
        <optgroup label="${cat}">${tpls.map(t=>`<option value="${t.id}">${t.name}</option>`).join('')}</optgroup>`).join('')}
    </select>
  </div>
  <div id="fm_tpl_preview" style="display:none;background:#f8f9fa;border:1px solid #e5e7eb;border-radius:6px;padding:10px 12px;margin-bottom:12px;max-height:150px;overflow-y:auto;">
    <div style="font-size:11px;font-weight:700;color:#555;text-transform:uppercase;margin-bottom:6px;">Items in this template</div>
    <div id="fm_tpl_items" style="font-size:12px;color:#555;"></div>
  </div>
  <div class="grid2">
    <div class="field"><label>Month *</label><input type="month" id="fm_month" value="${new Date().toISOString().slice(0,7)}"></div>
    <div class="field"><label>Location / Building</label><input id="fm_location" placeholder="e.g. Abu Dhabi, Block A"></div>
  </div>
  <div class="grid2">
    <div class="field"><label>Floor</label><input id="fm_floor" placeholder="e.g. Ground Floor, 1F"></div>
    <div class="field"><label>Technician Name</label><input id="fm_tech" value="${state.user?.name||''}"></div>
  </div>
  <div class="field"><label>Supervisor / Engineer</label><input id="fm_supervisor" placeholder="e.g. Engr. Nazir Hussain"></div>
  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
    <button class="btn btn-ghost" id="modalCancel">Cancel</button>
    <button class="btn btn-primary" id="saveFmClBtn">Create Checklist</button>
  </div>`;
}

function onFmClientSelect() {
  const clientId = document.getElementById('fm_clientId')?.value;
  const joSel    = document.getElementById('fm_joId');
  if (!joSel) return;
  if (!clientId) {
    joSel.innerHTML = '<option value="">— Select client first —</option>';
    joSel.disabled = true;
    return;
  }
  const client = state.clients.find(c => c.id === clientId);
  const jos    = state.jobOrders.filter(j => j.clientId === clientId || j.clientCompany === client?.companyName);
  joSel.innerHTML = `<option value="">— Select Job Order —</option>` +
    jos.map(j=>`<option value="${j.id}">${j.jobOrderNumber} — ${j.subject||j.siteDetail||'No subject'}</option>`).join('');
  joSel.disabled = jos.length === 0;
  if (jos.length === 0) joSel.innerHTML = '<option value="">No job orders for this client</option>';
}

function onFmJoSelect() {
  const id   = document.getElementById('fm_joId')?.value;
  const info = document.getElementById('fm_jo_info');
  const jo   = state.jobOrders.find(j => j.id === id);
  if (jo && info) {
    info.style.display = '';
    info.innerHTML = `🔒 <strong>${jo.clientCompany}</strong> · ${jo.subject||jo.jobOrderNumber} · ${jo.location||''}`;
  } else if (info) info.style.display = 'none';
}

function buildFmChecklistPdf(cl) {
  const co      = state.company || {};
  const okCnt   = cl.items.filter(i=>i.status==='ok').length;
  const failCnt = cl.items.filter(i=>i.status==='fail').length;
  const naCnt   = cl.items.filter(i=>i.status==='na').length;
  const logoHtml = co.logoPath
    ? `<img src="${co.logoPath}" style="height:48px;object-fit:contain;" alt="logo">`
    : `<div style="font-size:14px;font-weight:700;color:#1D9E75;">AL FITR</div>`;
  const rows = cl.items.map(item => {
    const bg = item.status==='fail'?'#fff5f5':item.status==='ok'?'#f0faf5':'#fff';
    const st = item.status==='ok'?'<span style="color:#1D9E75;font-weight:700;">✓ OK</span>':
               item.status==='fail'?'<span style="color:#dc2626;font-weight:700;">✗ FAIL</span>':
               item.status==='na'?'<span style="color:#888;">N/A</span>':'<span style="color:#ccc;">—</span>';
    return `<tr style="background:${bg};border-bottom:1px solid #e5e7eb;">
      <td style="padding:6px 8px;font-size:11px;color:#888;text-align:center;border:1px solid #e5e7eb;">${item.id}</td>
      <td style="padding:6px 8px;font-size:11px;border:1px solid #e5e7eb;">${item.description}</td>
      <td style="padding:6px 8px;font-size:10px;color:#888;text-align:center;border:1px solid #e5e7eb;">${item.frequency||'Daily'}</td>
      <td style="padding:6px 8px;text-align:center;border:1px solid #e5e7eb;">${st}</td>
      <td style="padding:6px 8px;font-size:11px;color:#555;border:1px solid #e5e7eb;">${item.remarks||''}</td>
    </tr>`;
  }).join('');
  const abnRows = cl.abnormalities.length===0
    ? '<tr><td colspan="5" style="padding:10px;text-align:center;color:#aaa;font-size:11px;">No abnormalities recorded</td></tr>'
    : cl.abnormalities.map(a=>`<tr>
        <td style="padding:6px 8px;font-size:11px;border:1px solid #e5e7eb;">${a.date||''}</td>
        <td style="padding:6px 8px;font-size:11px;border:1px solid #e5e7eb;">${a.abnormality||''}</td>
        <td style="padding:6px 8px;font-size:11px;border:1px solid #e5e7eb;">${a.actionTaken||''}</td>
        <td style="padding:6px 8px;font-size:11px;border:1px solid #e5e7eb;">${a.status||''}</td>
        <td style="padding:6px 8px;font-size:11px;border:1px solid #e5e7eb;">${a.doneBy||''}</td>
      </tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${cl.refNumber}</title>
  <style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;font-size:11px;color:#1a1a1a;}@page{size:A4 portrait;margin:12mm;}</style>
  </head><body>
  <div style="border-bottom:3px solid #E8520A;display:flex;align-items:center;justify-content:space-between;padding-bottom:10px;margin-bottom:12px;">
    <div style="display:flex;align-items:center;gap:12px;">${logoHtml}
      <div style="font-size:14px;font-weight:700;color:#E8520A;">${co.name||'Al Fitr Electromechanical Works LLC'}</div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:13px;font-weight:700;color:#00627B;">${cl.templateName}</div>
      <div style="font-size:11px;color:#E8520A;font-weight:700;">${cl.refNumber}</div>
      <div style="font-size:10px;color:#555;">Month: ${cl.month||'—'}</div>
    </div>
  </div>
  <table style="width:100%;border-collapse:collapse;margin-bottom:12px;font-size:11px;">
    <tr>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;width:18%;">Client</td>
      <td style="padding:5px 8px;border:1px solid #ddd;width:32%;">${cl.clientCompany||'—'}</td>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;width:18%;">Project</td>
      <td style="padding:5px 8px;border:1px solid #ddd;">${cl.projectName||'—'}</td>
    </tr>
    <tr>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;">Job Order</td>
      <td style="padding:5px 8px;border:1px solid #ddd;font-family:monospace;">${cl.jobOrderNumber||'—'}</td>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;">Location</td>
      <td style="padding:5px 8px;border:1px solid #ddd;">${cl.location||'—'} ${cl.building?'· '+cl.building:''}</td>
    </tr>
    <tr>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;">Technician</td>
      <td style="padding:5px 8px;border:1px solid #ddd;">${cl.technicianName||'—'}</td>
      <td style="padding:5px 8px;border:1px solid #ddd;font-weight:700;background:#f5f5f5;">Supervisor</td>
      <td style="padding:5px 8px;border:1px solid #ddd;">${cl.supervisorName||'—'}</td>
    </tr>
  </table>
  <div style="display:flex;gap:10px;margin-bottom:12px;">
    <div style="background:#f0faf5;border:1px solid #d1fae5;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:700;color:#1D9E75;">✓ ${okCnt} OK</div>
    <div style="background:#fff5f5;border:1px solid #fecaca;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:700;color:#dc2626;">✗ ${failCnt} FAIL</div>
    <div style="background:#f5f5f5;border:1px solid #e5e7eb;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:700;color:#888;">— ${naCnt} N/A</div>
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:6px 14px;font-size:12px;color:#555;">${cl.items.length} Total Items</div>
  </div>
  <table style="width:100%;border-collapse:collapse;margin-bottom:14px;">
    <thead><tr style="background:#2c2c2c;">
      <th style="padding:7px 8px;color:#fff;font-size:10px;text-align:center;border:1px solid #444;width:5%;">S.No</th>
      <th style="padding:7px 8px;color:#fff;font-size:10px;text-align:left;border:1px solid #444;">Description</th>
      <th style="padding:7px 8px;color:#fff;font-size:10px;text-align:center;border:1px solid #444;width:10%;">Freq.</th>
      <th style="padding:7px 8px;color:#fff;font-size:10px;text-align:center;border:1px solid #444;width:10%;">Status</th>
      <th style="padding:7px 8px;color:#fff;font-size:10px;text-align:left;border:1px solid #444;width:25%;">Remarks</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div style="font-size:11px;font-weight:700;color:#0B2B36;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Abnormality Log</div>
  <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
    <thead><tr style="background:#f5f5f5;">
      <th style="padding:6px 8px;font-size:10px;border:1px solid #ddd;width:12%;">Date</th>
      <th style="padding:6px 8px;font-size:10px;border:1px solid #ddd;">Abnormality</th>
      <th style="padding:6px 8px;font-size:10px;border:1px solid #ddd;">Action Taken</th>
      <th style="padding:6px 8px;font-size:10px;border:1px solid #ddd;width:12%;">Status</th>
      <th style="padding:6px 8px;font-size:10px;border:1px solid #ddd;width:14%;">Done By</th>
    </tr></thead>
    <tbody>${abnRows}</tbody>
  </table>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:10px;">
    <div><div style="border-bottom:1px solid #555;height:30px;margin-bottom:5px;"></div>
      <div style="font-size:11px;font-weight:700;">${cl.technicianName||'Technician'}</div>
      <div style="font-size:10px;color:#1D9E75;">Signature of the Technician</div></div>
    <div><div style="border-bottom:1px solid #555;height:30px;margin-bottom:5px;"></div>
      <div style="font-size:11px;font-weight:700;">${cl.supervisorName||'Supervisor/Engineer'}</div>
      <div style="font-size:10px;color:#1D9E75;">Signature of Supervisor/Engineer with date</div></div>
  </div>
  </body></html>`;
}

function renderAddAbnormalityForm(clId) {
  return `
  <div class="grid2">
    <div class="field"><label>Date *</label><input type="date" id="abn_date" value="${new Date().toISOString().slice(0,10)}"></div>
    <div class="field"><label>Done By</label><input id="abn_doneBy" value="${state.user?.name||''}" placeholder="Technician name"></div>
  </div>
  <div class="field"><label>Abnormality Observed *</label>
    <textarea id="abn_desc" rows="3" placeholder="Describe the abnormality observed..."></textarea>
  </div>
  <div class="field"><label>Action Taken</label>
    <textarea id="abn_action" rows="2" placeholder="What action was taken?"></textarea>
  </div>
  <div class="field"><label>Status</label>
    <select id="abn_status">
      <option value="Open">Open</option>
      <option value="In Progress">In Progress</option>
      <option value="Resolved">Resolved</option>
    </select>
  </div>
  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
    <button class="btn btn-ghost" id="modalCancel">Cancel</button>
    <button class="btn btn-primary" id="saveAbnBtn" data-cl-id="${clId}">Add Entry</button>
  </div>`;
}

function onFmTplSelect() {
  const id  = document.getElementById('fm_tplId')?.value;
  const box = document.getElementById('fm_tpl_preview');
  const tpl = state.fmTemplates.find(t => t.id === id);
  if (tpl && box) {
    box.style.display = '';
    document.getElementById('fm_tpl_items').innerHTML =
      tpl.items.map((it,i) => `<div style="padding:3px 0;border-bottom:1px solid #f0f0f0;">${i+1}. ${it.description}</div>`).join('');
  } else if (box) box.style.display = 'none';
}

function renderClients() {
  const list = [...state.clients].sort((a, b) => a.companyName.localeCompare(b.companyName));

  // Pre-compute client stats from local state
  function clientStats(c) {
    const quotes  = (state.quotations    ||[]).filter(q => q.clientId === c.id || q.clientCompany === c.companyName);
    const jos     = (state.jobOrders     ||[]).filter(j => j.clientId === c.id || j.clientCompany === c.companyName);
    const dns     = (state.dns           ||[]).filter(d => d.clientId === c.id || d.clientCompany === c.companyName);
    const drs     = (state.delayReports  ||[]).filter(r => jos.some(j => j.id === r.jobOrderId));
    const openDel = drs.reduce((acc,r) => acc + (r.delayItems||[]).filter(i=>i.status==='Open').length, 0);
    const totalVal= quotes.reduce((s,q) => s+(q.totals?.total||0), 0);
    return { quotes: quotes.length, jos: jos.length, dns: dns.length, openDel, totalVal,
             accepted: quotes.filter(q=>q.status==='Accepted').length };
  }

  return `
  <div class="toolbar">
    <div style="font-size:13px;color:var(--ink-soft);">${list.length} client${list.length!==1?'s':''} registered</div>
    <button class="btn btn-primary" id="addClientBtn">+ Add Client</button>
  </div>

  <div class="client-grid">
    ${list.length === 0 ? `<div class="empty" style="grid-column:1/-1;"><div class="big">🏢</div>No clients yet.</div>` :
      list.map(c => {
        const s = clientStats(c);
        return `
        <div class="client-card" data-view-client="${c.id}">
          <div class="client-card-header">
            <div class="client-avatar">${c.companyName.charAt(0).toUpperCase()}</div>
            <div style="flex:1;min-width:0;">
              <div class="client-name">${c.companyName}</div>
              <div class="client-num">${c.customerNumber || '—'}</div>
            </div>
            <button class="btn btn-ghost btn-sm" data-edit-client="${c.id}" onclick="event.stopPropagation()">Edit</button>
          </div>
          ${c.contactPerson || c.phone ? `
          <div class="client-contact">
            ${c.contactPerson ? `<span>👤 ${c.contactPerson}</span>` : ''}
            ${c.phone ? `<span>📞 ${c.phone}</span>` : ''}
            ${c.email ? `<span>✉️ ${c.email}</span>` : ''}
          </div>` : ''}
          <div class="client-stats">
            <div class="client-stat"><div class="cs-num">${s.quotes}</div><div class="cs-lbl">Quotes</div></div>
            <div class="client-stat"><div class="cs-num" style="color:#1D9E75">${s.accepted}</div><div class="cs-lbl">Accepted</div></div>
            <div class="client-stat"><div class="cs-num" style="color:#00627B">${s.jos}</div><div class="cs-lbl">Job Orders</div></div>
            <div class="client-stat"><div class="cs-num">${s.dns}</div><div class="cs-lbl">DNs</div></div>
            ${s.openDel > 0 ? `<div class="client-stat"><div class="cs-num" style="color:#dc2626">${s.openDel}</div><div class="cs-lbl">Open Delays</div></div>` : ''}
          </div>
          ${s.totalVal > 0 ? `<div class="client-value">Total Business: <strong>AED ${fmtMoney(s.totalVal)}</strong></div>` : ''}
        </div>`;
      }).join('')}
  </div>`;
}

function renderClient360(clientId) {
  const c = state.clients.find(x => x.id === clientId);
  if (!c) return '<div class="empty">Client not found.</div>';

  const quotes  = (state.quotations    ||[]).filter(q => q.clientId===c.id||q.clientCompany===c.companyName).sort((a,b)=>b.createdAt-a.createdAt);
  const jos     = (state.jobOrders     ||[]).filter(j => j.clientId===c.id||j.clientCompany===c.companyName).sort((a,b)=>b.createdAt-a.createdAt);
  const dns     = (state.dns           ||[]).filter(d => d.clientId===c.id||d.clientCompany===c.companyName).sort((a,b)=>b.createdAt-a.createdAt);
  const drs     = (state.delayReports  ||[]).filter(r => jos.some(j=>j.id===r.jobOrderId)).sort((a,b)=>b.createdAt-a.createdAt);
  const mrs     = (state.materialRequests||[]).filter(m => jos.some(j=>j.id===m.jobOrderId)).sort((a,b)=>b.createdAt-a.createdAt);

  const totalVal    = quotes.reduce((s,q)=>s+(q.totals?.total||0),0);
  const acceptedVal = quotes.filter(q=>q.status==='Accepted').reduce((s,q)=>s+(q.totals?.total||0),0);
  const openDel     = drs.reduce((acc,r)=>acc+(r.delayItems||[]).filter(i=>i.status==='Open').length,0);
  const issuedDns   = dns.filter(d=>d.status==='Issued').length;

  const TEAL='#1D9E75',ORANGE='#E8520A',RED='#dc2626',NAVY='#00627B';

  // Mini donut for quotes — now with real hover tooltips (native SVG <title>) and
  // click-to-filter, matching the pattern already working on the main Dashboard.
  function miniDonut(data,colors,size,labels,onclicks) {
    const total=data.reduce((a,b)=>a+b,0);
    if(!total) return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size/2}" cy="${size/2}" r="${size/2-4}" fill="none" stroke="#e5e7eb" stroke-width="8"/></svg>`;
    const r=size/2-6,cx=size/2,cy=size/2;
    let angle=-90;
    const paths=data.map((v,i)=>{
      if(!v) return '';
      const pct=(v/total)*360,start=angle;
      angle+=pct;
      const s={x:+(cx+r*Math.cos(start*Math.PI/180)).toFixed(1),y:+(cy+r*Math.sin(start*Math.PI/180)).toFixed(1)};
      const e={x:+(cx+r*Math.cos(angle*Math.PI/180)).toFixed(1),y:+(cy+r*Math.sin(angle*Math.PI/180)).toFixed(1)};
      const oc = onclicks && onclicks[i] ? ` onclick="${onclicks[i]}" style="cursor:pointer;"` : '';
      const titleText = labels && labels[i] ? `${labels[i]}: ${v} (${Math.round(v/total*100)}%)` : `${v}`;
      return `<path d="M${cx},${cy} L${s.x},${s.y} A${r},${r},0,${pct>180?1:0},1,${e.x},${e.y} Z" fill="${colors[i]}"${oc}><title>${titleText}</title></path>`;
    }).join('');
    const ir=r-8;
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><style>path:hover{opacity:.75;cursor:pointer}</style>${paths}<circle cx="${cx}" cy="${cy}" r="${ir}" fill="#fff" style="pointer-events:none;"/><text x="${cx}" y="${cy+4}" text-anchor="middle" font-size="11" font-weight="700" fill="#0B2B36" style="pointer-events:none;">${total}</text></svg>`;
  }

  return `
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
    <button class="btn btn-ghost btn-sm" onclick="state.clientView=null;render()">← Back to Clients</button>
    <button class="btn btn-outline btn-sm" data-edit-client="${c.id}">Edit Client</button>
  </div>

  <!-- Client Header -->
  <div class="client-360-header">
    <div class="client-360-avatar">${c.companyName.charAt(0)}</div>
    <div style="flex:1">
      <div class="client-360-name">${c.companyName}</div>
      <div class="client-360-num">${c.customerNumber||'—'}</div>
      <div style="font-size:13px;color:var(--ink-soft);margin-top:4px;display:flex;gap:16px;flex-wrap:wrap;">
        ${c.contactPerson?`<span>👤 ${c.contactPerson}</span>`:''}
        ${c.phone?`<span>📞 ${c.phone}</span>`:''}
        ${c.email?`<span>✉️ ${c.email}</span>`:''}
        ${c.address?`<span>📍 ${c.address}</span>`:''}
        ${c.trn?`<span>TRN: ${c.trn}</span>`:''}
      </div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:11px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.5px;">Total Business</div>
      <div style="font-size:24px;font-weight:700;color:#E8520A;">AED ${fmtMoney(totalVal)}</div>
      <div style="font-size:12px;color:#1D9E75;">AED ${fmtMoney(acceptedVal)} accepted</div>
    </div>
  </div>

  <!-- KPI strip — each card jumps to its client-scoped section below, not a global list -->
  <div class="client-360-kpis">
    <div class="c360-kpi" style="border-top:3px solid ${ORANGE};cursor:pointer;" onclick="document.getElementById('c360-sec-quotations').scrollIntoView({behavior:'smooth',block:'start'})">
      <div class="c360-kpi-num" style="color:${ORANGE}">${quotes.length}</div>
      <div class="c360-kpi-lbl">Quotations</div>
      <div class="c360-kpi-sub">${quotes.filter(q=>q.status==='Accepted').length} accepted · ${quotes.filter(q=>q.status==='Declined').length} declined</div>
    </div>
    <div class="c360-kpi" style="border-top:3px solid ${NAVY};cursor:pointer;" onclick="document.getElementById('c360-sec-joborders').scrollIntoView({behavior:'smooth',block:'start'})">
      <div class="c360-kpi-num" style="color:${NAVY}">${jos.length}</div>
      <div class="c360-kpi-lbl">Job Orders</div>
      <div class="c360-kpi-sub">${jos.filter(j=>j.status==='Open'||j.status==='In Process').length} active</div>
    </div>
    <div class="c360-kpi" style="border-top:3px solid ${TEAL};cursor:pointer;" onclick="document.getElementById('c360-sec-dns').scrollIntoView({behavior:'smooth',block:'start'})">
      <div class="c360-kpi-num" style="color:${TEAL}">${dns.length}</div>
      <div class="c360-kpi-lbl">Delivery Notes</div>
      <div class="c360-kpi-sub">${issuedDns} issued · ${dns.length-issuedDns} draft</div>
    </div>
    <div class="c360-kpi" style="border-top:3px solid #7F77DD;cursor:pointer;" onclick="document.getElementById('c360-sec-materialrequests').scrollIntoView({behavior:'smooth',block:'start'})">
      <div class="c360-kpi-num" style="color:#7F77DD">${mrs.length}</div>
      <div class="c360-kpi-lbl">Material Requests</div>
      <div class="c360-kpi-sub">${mrs.filter(m=>computeMrStatus(m)==='Fulfilled').length} fulfilled</div>
    </div>
    <div class="c360-kpi" style="border-top:3px solid ${openDel>0?RED:'#e5e7eb'};cursor:pointer;" onclick="document.getElementById('c360-sec-delayreports').scrollIntoView({behavior:'smooth',block:'start'})">
      <div class="c360-kpi-num" style="color:${openDel>0?RED:'#aaa'}">${openDel}</div>
      <div class="c360-kpi-lbl">Open Delays</div>
      <div class="c360-kpi-sub">${drs.length} reports total</div>
    </div>
  </div>

  <!-- Charts row — clicking a segment jumps to the matching client-scoped section below,
       instead of navigating to the global list (which would mix in every other client's data) -->
  <div class="client-360-charts">
    <div class="dash-chart-card">
      <div class="dash-chart-title">Quotation Status</div>
      <div style="display:flex;align-items:center;gap:14px;margin-top:10px;">
        ${miniDonut(
          [quotes.filter(q=>q.status==='Draft').length, quotes.filter(q=>q.status==='Sent'||q.status==='PendingApproval').length, quotes.filter(q=>q.status==='Accepted').length, quotes.filter(q=>q.status==='Declined').length],
          ['#aaa', ORANGE, TEAL, RED], 90,
          ['Draft', 'Pending/Sent', 'Accepted', 'Declined'],
          Array(4).fill("document.getElementById('c360-sec-quotations').scrollIntoView({behavior:'smooth',block:'start'})")
        )}
        <div style="font-size:11px;line-height:2;">
          <div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#aaa;margin-right:5px;"></span>Draft (${quotes.filter(q=>q.status==='Draft').length})</div>
          <div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${ORANGE};margin-right:5px;"></span>Pending/Sent (${quotes.filter(q=>q.status==='Sent'||q.status==='PendingApproval').length})</div>
          <div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${TEAL};margin-right:5px;"></span>Accepted (${quotes.filter(q=>q.status==='Accepted').length})</div>
          <div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${RED};margin-right:5px;"></span>Declined (${quotes.filter(q=>q.status==='Declined').length})</div>
        </div>
      </div>
    </div>
    <div class="dash-chart-card">
      <div class="dash-chart-title">Job Order Status</div>
      <div style="display:flex;align-items:center;gap:14px;margin-top:10px;">
        ${miniDonut(
          [jos.filter(j=>j.status==='Open').length, jos.filter(j=>j.status==='In Process').length, jos.filter(j=>j.status==='Resolved').length],
          [ORANGE, NAVY, TEAL], 90,
          ['Open', 'In Process', 'Resolved'],
          Array(3).fill("document.getElementById('c360-sec-joborders').scrollIntoView({behavior:'smooth',block:'start'})")
        )}
        <div style="font-size:11px;line-height:2;">
          <div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${ORANGE};margin-right:5px;"></span>Open (${jos.filter(j=>j.status==='Open').length})</div>
          <div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${NAVY};margin-right:5px;"></span>In Process (${jos.filter(j=>j.status==='In Process').length})</div>
          <div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${TEAL};margin-right:5px;"></span>Resolved (${jos.filter(j=>j.status==='Resolved').length})</div>
        </div>
      </div>
    </div>
    <div class="dash-chart-card">
      <div class="dash-chart-title">Delivery Notes</div>
      <div style="display:flex;align-items:center;gap:14px;margin-top:10px;">
        ${miniDonut([issuedDns, dns.length-issuedDns], [TEAL, '#e5e7eb'], 90, ['Issued', 'Draft'], Array(2).fill("document.getElementById('c360-sec-dns').scrollIntoView({behavior:'smooth',block:'start'})"))}
        <div style="font-size:11px;line-height:2;">
          <div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${TEAL};margin-right:5px;"></span>Issued (${issuedDns})</div>
          <div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#e5e7eb;margin-right:5px;"></span>Draft (${dns.length-issuedDns})</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Data Tables -->
  <div class="grid2" style="margin-bottom:14px;">
    <!-- Job Orders -->
    <div class="card" id="c360-sec-joborders">
      <div class="card-head"><div class="card-title">Job Orders</div></div>
      ${jos.length===0?`<div class="empty">No job orders yet.</div>`:`
      <div class="tbl-wrap"><table>
        <thead><tr><th>JO No.</th><th>Project</th><th>Status</th></tr></thead>
        <tbody>${jos.map(j=>`<tr>
          <td style="font-family:var(--mono);color:#E8520A;font-weight:700;">${j.jobOrderNumber}</td>
          <td style="font-size:12px;">${j.subject||j.siteDetail||'—'}</td>
          <td><span class="badge ${j.status==='Open'?'badge-in':j.status==='Resolved'?'badge-out':'badge-low'}">${j.status}</span></td>
        </tr>`).join('')}</tbody>
      </table></div>`}
    </div>
    <!-- Quotations -->
    <div class="card" id="c360-sec-quotations">
      <div class="card-head"><div class="card-title">Quotations</div></div>
      ${quotes.length===0?`<div class="empty">No quotations yet.</div>`:`
      <div class="tbl-wrap"><table>
        <thead><tr><th>Ref No.</th><th>Amount</th><th>Status</th></tr></thead>
        <tbody>${quotes.map(q=>`<tr>
          <td style="font-family:var(--mono);font-weight:700;">${q.quotationNumber||'—'}</td>
          <td style="font-size:12px;">AED ${fmtMoney(q.totals?.total||0)}</td>
          <td>${quoteStatusBadge(q.status)}</td>
        </tr>`).join('')}</tbody>
      </table></div>`}
    </div>
  </div>

  <div class="grid2" style="margin-bottom:14px;">
    <!-- Delivery Notes -->
    <div class="card" id="c360-sec-dns">
      <div class="card-head"><div class="card-title">Delivery Notes</div></div>
      ${dns.length===0?`<div class="empty">No delivery notes yet.</div>`:`
      <div class="tbl-wrap"><table>
        <thead><tr><th>DN No.</th><th>Date</th><th>Status</th></tr></thead>
        <tbody>${dns.map(d=>`<tr>
          <td style="font-family:var(--mono);font-weight:700;">${d.dnNumber}</td>
          <td style="font-size:12px;">${fmtDate(d.date)}</td>
          <td><span class="badge ${d.status==='Issued'?'badge-issued':'badge-draft'}">${d.status}</span></td>
        </tr>`).join('')}</tbody>
      </table></div>`}
    </div>
    <!-- Delay Reports -->
    <div class="card" id="c360-sec-delayreports">
      <div class="card-head"><div class="card-title">Delay Reports</div></div>
      ${drs.length===0?`<div class="empty">No delay reports yet.</div>`:`
      <div class="tbl-wrap"><table>
        <thead><tr><th>Ref No.</th><th>Project</th><th>Open</th></tr></thead>
        <tbody>${drs.map(r=>`<tr>
          <td style="font-family:var(--mono);color:#E8520A;font-weight:700;">${r.refNumber}</td>
          <td style="font-size:12px;">${r.projectName||'—'}</td>
          <td><span class="badge ${(r.delayItems||[]).filter(i=>i.status==='Open').length>0?'badge-low':'badge-issued'}">${(r.delayItems||[]).filter(i=>i.status==='Open').length} open</span></td>
        </tr>`).join('')}</tbody>
      </table></div>`}
    </div>
  </div>

  <!-- Material Requests — new section, previously had a KPI card but nowhere to click through to -->
  <div class="card" id="c360-sec-materialrequests">
    <div class="card-head"><div class="card-title">Material Requests</div></div>
    ${mrs.length===0?`<div class="empty">No material requests yet.</div>`:`
    <div class="tbl-wrap"><table>
      <thead><tr><th>MR No.</th><th>Job Order</th><th>Lines</th><th>Status</th></tr></thead>
      <tbody>${mrs.map(m=>`<tr>
        <td style="font-family:var(--mono);color:#E8520A;font-weight:700;">${m.mrNumber}</td>
        <td style="font-size:12px;font-family:var(--mono);">${m.jobOrderNumber||'—'}</td>
        <td style="font-size:12px;">${(m.lineItems||[]).length}</td>
        <td>${mrStatusBadge(computeMrStatus(m))}</td>
      </tr>`).join('')}</tbody>
    </table></div>`}
  </div>`;
}

function renderVendors() {
  const list = [...state.vendors].sort((a, b) => a.companyName.localeCompare(b.companyName));
  return `
  <div class="toolbar">
    <div style="flex:1"></div>
    <button class="btn btn-primary" id="addVendorBtn">+ Add Vendor</button>
  </div>
  <div class="card">
    <div class="tbl-wrap"><table>
      <thead><tr><th>Company Name</th><th>Contact Person</th><th>Phone</th><th>Email</th><th>Address</th><th></th></tr></thead>
      <tbody>
      ${list.length === 0 ? `<tr><td colspan="6"><div class="empty"><div class="big">🚚</div>No vendors yet — add the companies you buy materials from.</div></td></tr>` :
        list.map(v => `
        <tr>
          <td><strong>${v.companyName}</strong></td>
          <td>${v.contactPerson || '—'}</td>
          <td>${v.phone || '—'}</td>
          <td>${v.email || '—'}</td>
          <td>${v.address || '—'}</td>
          <td><button class="btn btn-outline btn-sm" data-edit-vendor="${v.id}">Edit</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </div>`;
}

function renderVendorForm(vendor) {
  const isEdit = !!vendor.id;
  return `
  <div class="field"><label>Company Name</label><input id="v_companyName" value="${vendor.companyName || ''}" placeholder="e.g. Gulf Fire Supplies LLC"></div>
  <div class="grid2">
    <div class="field"><label>Contact Person</label><input id="v_contactPerson" value="${vendor.contactPerson || ''}"></div>
    <div class="field"><label>Phone</label><input id="v_phone" value="${vendor.phone || ''}" placeholder="+971 5xx xxx xxx"></div>
  </div>
  <div class="grid2">
    <div class="field"><label>Email</label><input id="v_email" type="email" value="${vendor.email || ''}"></div>
    <div class="field"><label>Address</label><input id="v_address" value="${vendor.address || ''}"></div>
  </div>
  <div style="display:flex;justify-content:space-between;margin-top:8px;">
    <div>${isEdit ? `<button class="btn btn-danger" id="deleteVendorBtn">Delete Vendor</button>` : ''}</div>
    <div style="display:flex;gap:8px;"><button class="btn btn-ghost" id="modalCancel">Cancel</button><button class="btn btn-primary" id="saveVendorBtn">${isEdit ? 'Save Changes' : 'Add Vendor'}</button></div>
  </div>
  `;
}

/* ---------------- Quotations ---------------- */
function renderQuotations() {
  let list = [...state.quotations];
  if (state.quoteFilter !== 'All') list = list.filter(q => q.status === state.quoteFilter);
  list.sort((a, b) => b.createdAt - a.createdAt);
  const pendingForMe = isQuotationApprover() ? state.quotations.filter(q => q.status === 'PendingApproval').length : 0;
  return `
  <div class="toolbar">
    <select id="quoteStatusFilter" style="max-width:190px;">
      <option ${state.quoteFilter === 'All' ? 'selected' : ''} value="All">All Statuses</option>
      <option ${state.quoteFilter === 'Draft' ? 'selected' : ''} value="Draft">Draft</option>
      <option ${state.quoteFilter === 'PendingApproval' ? 'selected' : ''} value="PendingApproval">Pending Approval</option>
      <option ${state.quoteFilter === 'Approved' ? 'selected' : ''} value="Approved">Approved</option>
      <option ${state.quoteFilter === 'Sent' ? 'selected' : ''} value="Sent">Sent</option>
      <option ${state.quoteFilter === 'Accepted' ? 'selected' : ''} value="Accepted">Accepted</option>
      <option ${state.quoteFilter === 'Declined' ? 'selected' : ''} value="Declined">Declined</option>
      <option ${state.quoteFilter === 'Rejected' ? 'selected' : ''} value="Rejected">Rejected (internal)</option>
    </select>
    <div style="flex:1"></div>
    ${pendingForMe > 0 ? `<span class="tag" style="background:var(--amber-bg);color:var(--amber);">${pendingForMe} awaiting your approval</span>` : ''}
    ${can('manageQuotations') ? `<button class="btn btn-primary" id="newQuoteBtn">+ New Quotation</button>` : ''}
  </div>
  <div class="card">
    <div class="tbl-wrap"><table>
      <thead><tr><th>Quote #</th><th>Type</th><th>Client</th><th>Subject</th><th>Date</th><th>Total</th><th>Status</th><th></th></tr></thead>
      <tbody>
      ${list.length === 0 ? `<tr><td colspan="8"><div class="empty"><div class="big">📋</div>No quotations match.</div></td></tr>` :
        list.map(q => `
        <tr>
          <td style="font-family:var(--mono);font-weight:700;font-size:12px;">${q.quotationNumber || '<span class="muted">(draft)</span>'}${q.revisionOf ? ` <span class="muted" style="font-weight:400;">(Rev ${q.revisionNumber})</span>` : ''}</td>
          <td><span class="tag">${QUOTE_TYPE_LABEL[q.type]}</span></td>
          <td>${q.clientCompany}</td>
          <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${q.subject || q.siteDetail || '—'}</td>
          <td>${fmtDate(q.date)}</td>
          <td style="font-family:var(--mono);">${state.company.currency} ${fmtMoney(q.totals.total)}</td>
          <td>${quoteStatusBadge(q.status)}${q.supersededByQuotationId ? ` <span class="badge badge-low">Superseded</span>` : ''}</td>
          <td><button class="btn btn-outline btn-sm" data-view-quote="${q.id}">Open</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </div>`;
}

/* ---------------- Job Orders ---------------- */
const JO_STATUS_BADGE = { Open: 'badge-in', Pending: 'badge-low', 'In Process': 'badge-low', Resolved: 'badge-out', 'In Progress': 'badge-low', Completed: 'badge-in', 'On Hold': 'badge-low', Cancelled: 'badge-out' };

const UAE_EMIRATES = ['Abu Dhabi','Dubai','Sharjah','Ajman','Fujairah','Ras Al Khaimah','Umm Al Quwain','Other'];

const DELAY_REASONS = [
  'Site Clearance Pending','Material Pending','Change in Route','Conduit Blockage',
  'Change in Drawing','Client Approval Pending','Consultant Approval Pending',
  'Access Not Available','Work Permit Pending','Coordination Issue','Other'
];

function renderJobOrders() {
  let list = [...state.jobOrders].sort((a, b) => b.createdAt - a.createdAt);
  if (state.joFilter && state.joFilter !== 'All') list = list.filter(j => j.status === state.joFilter);
  const statusOptions = ['All', ...Object.keys(JO_STATUS_BADGE)];
  return `
  <div class="toolbar">
    <select id="joStatusFilter" style="max-width:190px;">
      ${statusOptions.map(s => `<option value="${s}" ${((state.joFilter||'All')===s) ? 'selected' : ''}>${s === 'All' ? 'All Statuses' : s}</option>`).join('')}
    </select>
    <div style="flex:1"></div>
    ${can('manageReports') ? `<button class="btn btn-primary" id="newJoBtn">+ New Job Order</button>` : ''}
  </div>
  <div class="card">
    <div class="tbl-wrap"><table>
      <thead><tr><th>Job Order #</th><th>From Quote</th><th>Type</th><th>Client</th><th>Subject / Site</th><th>Value</th><th>Status</th><th></th></tr></thead>
      <tbody>
      ${list.length === 0 ? `<tr><td colspan="8"><div class="empty"><div class="big">🛠️</div>No job orders match.</div></td></tr>` :
        list.map(jo => `
        <tr>
          <td style="font-family:var(--mono);font-weight:700;">${jo.jobOrderNumber}</td>
          <td style="font-family:var(--mono);font-size:12px;">${jo.quotationNumber || '<span class="muted" style="font-family:var(--sans);font-style:italic;">Manual</span>'}</td>
          <td><span class="tag">${QUOTE_TYPE_LABEL[jo.type] || jo.type}</span></td>
          <td>${jo.clientCompany}</td>
          <td>${jo.subject || jo.siteDetail || '—'}</td>
          <td style="font-family:var(--mono);">${state.company.currency} ${fmtMoney(jo.value)}</td>
          <td><span class="badge ${JO_STATUS_BADGE[jo.status] || 'badge-draft'}">${jo.status}</span></td>
          <td><button class="btn btn-outline btn-sm" data-view-jo="${jo.id}">Open</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </div>
  <div class="shared-note">Job Orders are usually created automatically when you convert an accepted quotation — but you can also create one manually, e.g. for past jobs you're adding into the system. Open one to raise Material Requests or Delay Reports against it.</div>
  `;
}

function renderJoForm(payload) {
  const isEdit = !!payload.id;
  const clientOptions = [...state.clients].sort((a, b) => a.companyName.localeCompare(b.companyName))
    .map(c => `<option value="${c.id}" ${payload.clientId === c.id ? 'selected' : ''}>${c.companyName}</option>`).join('');
  return `
  <div class="grid2">
    <div class="field"><label>Client (optional — pick saved client)</label>
      <select id="jo_clientPick">
        <option value="">— None / type company name below —</option>
        ${clientOptions}
      </select>
    </div>
    <div class="field"><label>Client Company Name</label><input id="jo_clientCompany" value="${payload.clientCompany || ''}" placeholder="M/S. Client Name"></div>
  </div>
  <div class="grid2">
    <div class="field"><label>Job Order Number <span class="muted" style="font-weight:500;text-transform:none;">(leave blank to auto-generate, or enter a real historical number)</span></label><input id="jo_number" value="${payload.jobOrderNumber || ''}" placeholder="e.g. JO-2024-0087" ${isEdit ? '' : ''}></div>
    <div class="field"><label>Type</label>
      <select id="jo_type">${Object.entries(QUOTE_TYPE_LABEL).map(([k, v]) => `<option value="${k}" ${payload.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    </div>
  </div>
  <div class="field"><label>Subject / Project Name</label><input id="jo_subject" value="${payload.subject || ''}" placeholder="e.g. Fire Alarm Installation — Tower B"></div>
  <div class="field"><label>Scope of Work</label><input id="jo_siteDetail" value="${payload.siteDetail || ''}" placeholder="Brief description of work scope"></div>
  <div class="grid2">
    <div class="field"><label>Location (Emirate)</label>
      <select id="jo_location">
        <option value="">— Select Emirate —</option>
        ${UAE_EMIRATES.map(e => `<option value="${e}" ${(payload.location||'')===e?'selected':''}>${e}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>Status</label>
      <select id="jo_status">
        ${['Open','Pending','In Process','Resolved'].map(s => `<option ${payload.status === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </div>
  </div>
  <div class="field"><label>Value (AED)</label><input id="jo_value" type="number" value="${payload.value ?? ''}" placeholder="0"></div>
  ${userPickerHtml('jo_createdBy', payload.createdByName || state.user?.name, payload.createdByDesignation || state.user?.designation, 'Created By', 'createdBy')}

  <div style="border-top:1px solid var(--rule);margin:14px 0 12px;padding-top:14px;">
    <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;">Linked Quotation Reference</div>
    <div class="field">
      <label>Link to Approved / Accepted Quotation (optional)</label>
      <select id="jo_quotationId" onchange="onJoQuotationSelect()">
        <option value="">— None / Manual Entry —</option>
        ${(state.quotations||[])
          .filter(q => ['Accepted','Sent','Approved'].includes(q.status))
          .sort((a,b) => b.createdAt - a.createdAt)
          .map(q => `<option value="${q.id}" data-number="${q.quotationNumber||''}" data-client="${q.clientCompany||''}" data-subject="${q.subject||''}" data-site="${q.siteDetail||''}" ${payload.quotationId===q.id?'selected':''}>${q.quotationNumber||'(no number)'} — ${q.clientCompany} — ${q.status}</option>`).join('')}
      </select>
    </div>
    <div id="jo_qtn_ref_display" style="font-size:12px;color:var(--teal);font-weight:500;margin-top:4px;${payload.quotationNumber?'':'display:none'}">
      ✓ Linked: ${payload.quotationNumber || ''}
    </div>
  </div>

  <div style="border-top:1px solid var(--rule);margin:14px 0 12px;padding-top:14px;">
    <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;">Documents</div>
    <div class="grid2">
      <div class="field">
        <label>Customer LPO</label>
        ${payload.lpoFileUrl ? `<div style="font-size:12px;color:var(--teal);margin-bottom:6px;">✓ <a href="${payload.lpoFileUrl}" target="_blank" style="color:var(--teal);">${payload.lpoFileName||'View LPO'}</a></div>` : ''}
        <input type="file" id="jo_lpoFile" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" style="font-size:12px;padding:6px;">
        <div style="font-size:10px;color:var(--muted);margin-top:3px;">PDF, JPG, PNG, Word — max 20MB</div>
      </div>
      <div class="field">
        <label>Approved Quotation Document</label>
        ${payload.quoteFileUrl ? `<div style="font-size:12px;color:var(--teal);margin-bottom:6px;">✓ <a href="${payload.quoteFileUrl}" target="_blank" style="color:var(--teal);">${payload.quoteFileName||'View Quote'}</a></div>` : ''}
        <input type="file" id="jo_quoteFile" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" style="font-size:12px;padding:6px;">
        <div style="font-size:10px;color:var(--muted);margin-top:3px;">PDF, JPG, PNG, Word — max 20MB</div>
      </div>
    </div>
  </div>
  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
    <button class="btn btn-ghost" id="modalCancel">Cancel</button>
    <button class="btn btn-primary" id="saveJoBtn">${isEdit ? 'Save Changes' : 'Create Job Order'}</button>
  </div>
  `;
}

function renderJobOrderView(jo) {
  const mrs = state.materialRequests.filter(m => m.jobOrderId === jo.id).sort((a, b) => b.createdAt - a.createdAt);
  const drs = state.delayReports.filter(d => d.jobOrderId === jo.id).sort((a, b) => b.createdAt - a.createdAt);
  const hasSiteTeam = jo.siteEngineer || jo.projectManager || jo.siteSupervisor || jo.projectsIncharge;
  return `
  <div style="display:flex;justify-content:flex-end;margin-bottom:6px;">
    ${can('manageReports') ? `<button class="btn btn-outline btn-sm" id="editJoBtn">Edit Details</button>` : ''}
  </div>
  <div class="grid3">
    <div><div class="k muted">Client</div><div style="font-weight:600;">${jo.clientCompany}</div></div>
    <div><div class="k muted">From Quote</div><div style="font-weight:600;font-family:var(--mono);font-size:12px;">${jo.quotationNumber || 'Manual entry'}</div></div>
    <div><div class="k muted">Value</div><div style="font-weight:600;">${state.company.currency} ${fmtMoney(jo.value)}</div></div>
  </div>
  <div class="grid3" style="margin-top:10px;">
    <div><div class="k muted">Created By</div><div>${jo.createdByName || '—'}${jo.createdByDesignation ? ' <span class="muted">— ' + jo.createdByDesignation + '</span>' : ''}</div></div>
  </div>
  <div style="margin:10px 0 16px;">${jo.subject || jo.siteDetail || ''}</div>

  ${jo.quotationNumber ? `
  <div style="background:#f0faf5;border:1px solid #d1fae5;border-radius:6px;padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;gap:10px;">
    <span style="font-size:18px;">📋</span>
    <div>
      <div style="font-size:10px;font-weight:700;color:#085041;text-transform:uppercase;letter-spacing:0.05em;">Linked Quotation</div>
      <div style="font-size:13px;font-weight:700;color:#1D9E75;">${jo.quotationNumber}</div>
    </div>
  </div>` : ''}

  ${(jo.lpoFileUrl || jo.quoteFileUrl) ? `
  <div style="margin-bottom:14px;">
    <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">Documents</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      ${jo.lpoFileUrl   ? `<a href="${jo.lpoFileUrl}"   target="_blank" class="btn btn-outline btn-sm">📄 Customer LPO — ${jo.lpoFileName||'View'}</a>`         : ''}
      ${jo.quoteFileUrl ? `<a href="${jo.quoteFileUrl}" target="_blank" class="btn btn-outline btn-sm">📄 Approved Quote — ${jo.quoteFileName||'View'}</a>` : ''}
    </div>
  </div>` : ''}

  <div class="card-head" style="margin-top:6px;">
    <div class="card-title">Site Team</div>
    ${can('manageReports') ? `<button class="btn btn-outline btn-sm" id="editSiteTeamBtn">${hasSiteTeam ? 'Edit' : '+ Set Site Team'}</button>` : ''}
  </div>
  ${hasSiteTeam ? `
    <div style="background:#e1f5ee;border-radius:5px;padding:6px 10px;font-size:10px;font-weight:700;color:#085041;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Al Fitr Team</div>
    <div class="grid2" style="margin-bottom:10px;">
      <div><div class="k muted">Projects Incharge</div><div>${jo.projectsIncharge || '—'}</div></div>
      <div><div class="k muted">Prepared By</div><div>${jo.preparedBy || '—'}</div></div>
    </div>
    <div style="background:#e6f1fb;border-radius:5px;padding:6px 10px;font-size:10px;font-weight:700;color:#185FA5;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Client Team</div>
    <div class="grid2" style="margin-bottom:18px;">
      <div><div class="k muted">Client Engineer</div><div>${jo.siteEngineer || '—'}</div></div>
      <div><div class="k muted">Project Manager</div><div>${jo.projectManager || '—'}</div></div>
      <div><div class="k muted">Site Supervisor</div><div>${jo.siteSupervisor || '—'}</div></div>
    </div>
  ` : `<p class="muted" style="font-size:12px;margin-bottom:18px;">No site team set yet — set it once here, and every Delay Report for this job will use it automatically.</p>`}

  <div class="card-head" style="margin-top:6px;">
    <div class="card-title">Material Requests <span>${mrs.length}</span></div>
    ${can('manageMaterialRequests') ? `<button class="btn btn-primary btn-sm" id="newMrFromJoBtn">+ New Material Request</button>` : ''}
  </div>
  <div class="tbl-wrap" style="margin-bottom:20px;"><table>
    <thead><tr><th>MR #</th><th>Date</th><th>Requested By</th><th>Lines</th><th>Status</th><th></th></tr></thead>
    <tbody>
    ${mrs.length === 0 ? `<tr><td colspan="6"><div class="empty">No material requests raised against this job yet.</div></td></tr>` :
      mrs.map(m => `
      <tr>
        <td style="font-family:var(--mono);font-weight:700;">${m.mrNumber}</td>
        <td>${fmtDate(m.date)}</td>
        <td>${m.requestedByName}</td>
        <td>${m.lineItems.length}</td>
        <td>${mrStatusBadge(m.status)}</td>
        <td><button class="btn btn-outline btn-sm" data-view-mr="${m.id}">Open</button></td>
      </tr>`).join('')}
    </tbody>
  </table></div>

  <div class="card-head" style="margin-top:6px;">
    <div class="card-title">Delay Reports <span>${drs.length}</span></div>
    ${can('manageReports') ? `<button class="btn btn-primary btn-sm" id="newDrFromJoBtn">+ New Delay Report</button>` : ''}
  </div>
  <div class="tbl-wrap"><table>
    <thead><tr><th>Ref #</th><th>Date</th><th>Reported By</th><th>Items</th><th></th></tr></thead>
    <tbody>
    ${drs.length === 0 ? `<tr><td colspan="5"><div class="empty">No delay reports raised against this job yet.</div></td></tr>` :
      drs.map(d => `
      <tr>
        <td style="font-family:var(--mono);font-weight:700;">${d.refNumber}</td>
        <td>${fmtDate(d.date)}</td>
        <td>${d.reportedBy}</td>
        <td>${d.delayItems.length}</td>
        <td><button class="btn btn-outline btn-sm" data-view-dr="${d.id}">Open</button></td>
      </tr>`).join('')}
    </tbody>
  </table></div>
  <div style="display:flex;justify-content:flex-end;margin-top:16px;"><button class="btn btn-ghost" id="modalCancel">Close</button></div>
  `;
}

function renderSiteTeamForm(jo) {
  return `
  <div class="muted" style="margin-bottom:12px;font-size:12px;">For ${jo.jobOrderNumber} — ${jo.clientCompany}</div>
  <div style="background:#e1f5ee;border-radius:6px;padding:10px 12px;margin-bottom:12px;font-size:11px;font-weight:700;color:#085041;text-transform:uppercase;letter-spacing:0.05em;">Al Fitr Team</div>
  <div class="grid2">
    <div class="field"><label>Projects Incharge (Al Fitr)</label><input id="st_projectsIncharge" value="${jo.projectsIncharge || ''}" placeholder="e.g. Engr. Nazir Hussain"></div>
    <div class="field"><label>Prepared By / Reported By</label><input id="st_preparedBy" value="${jo.preparedBy || ''}" placeholder="e.g. Ramadasu"></div>
  </div>
  <div style="background:#e6f1fb;border-radius:6px;padding:10px 12px;margin:12px 0;font-size:11px;font-weight:700;color:#185FA5;text-transform:uppercase;letter-spacing:0.05em;">Client Team</div>
  <div class="grid2">
    <div class="field"><label>Client Engineer Name</label><input id="st_siteEngineer" value="${jo.siteEngineer || ''}" placeholder="e.g. Engr. Ibrahim"></div>
    <div class="field"><label>Project Manager (Client)</label><input id="st_projectManager" value="${jo.projectManager || ''}" placeholder="e.g. Engr. Hussein"></div>
  </div>
  <div class="field"><label>Site Supervisor</label><input id="st_siteSupervisor" value="${jo.siteSupervisor || ''}" placeholder="e.g. Engr. Ahmed"></div>
  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
    <button class="btn btn-ghost" id="modalCancel">Cancel</button>
    <button class="btn btn-primary" id="saveSiteTeamBtn">Save Site Team</button>
  </div>
  `;
}

/* ---------------- Delay Reports ---------------- */
function renderDelayReports() {
  let list = [...state.delayReports].sort((a, b) => b.createdAt - a.createdAt);

  // Apply filter from dashboard click or dropdown
  const activeFilter = state.drFilter || 'All';
  if (activeFilter !== 'All') {
    list = list.filter(r => (r.delayItems||[]).some(i => i.status === activeFilter));
  }

  return `
  <div class="card">
    <div class="card-head">
      <div class="card-title">Delay Reports</div>
      <div style="display:flex;gap:8px;align-items:center;">
        <select id="drStatusFilter" style="font-size:12px;padding:5px 8px;border:1px solid var(--rule);border-radius:6px;">
          <option ${activeFilter==='All'?'selected':''} value="All">All Reports</option>
          <option ${activeFilter==='Open'?'selected':''} value="Open">Has Open Items</option>
          <option ${activeFilter==='In Progress'?'selected':''} value="In Progress">Has In Progress</option>
          <option ${activeFilter==='Resolved'?'selected':''} value="Resolved">All Resolved</option>
        </select>
        ${can('manageReports') ? `<button class="btn btn-primary btn-sm" id="newDrBtn">+ New Report</button>` : ''}
      </div>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Ref #</th><th>Job Order</th><th>Project</th><th>Date</th><th>Reported By</th><th>Items</th><th>Status</th><th style="text-align:right;">Actions</th></tr></thead>
      <tbody>
      ${list.length === 0 ? `<tr><td colspan="8"><div class="empty"><div class="big">⏱️</div>No delay reports yet — raise one from a Job Order.</div></td></tr>` :
        list.map(d => {
          const openCount = (d.delayItems||[]).filter(i=>i.status==='Open').length;
          const progCount = (d.delayItems||[]).filter(i=>i.status==='In Progress').length;
          const doneCount = (d.delayItems||[]).filter(i=>i.status==='Resolved').length;
          return `
          <tr>
            <td style="font-family:var(--mono);font-weight:700;color:var(--orange);">${d.refNumber}</td>
            <td style="font-family:var(--mono);font-size:12px;">${d.jobOrderNumber}</td>
            <td>${d.projectName || '—'}</td>
            <td>${fmtDate(d.date)}</td>
            <td>${d.reportedBy}</td>
            <td>${d.delayItems.length}</td>
            <td>
              ${openCount  ? `<span class="tag" style="background:#FEE2E2;color:#991B1B;margin-right:3px;">${openCount} Open</span>` : ''}
              ${progCount  ? `<span class="tag" style="background:#FEF3C7;color:#92400E;margin-right:3px;">${progCount} In Progress</span>` : ''}
              ${doneCount  ? `<span class="tag" style="background:#D1FAE5;color:#065F46;">${doneCount} Resolved</span>` : ''}
            </td>
            <td style="text-align:right;white-space:nowrap;">
              <button class="btn btn-outline btn-sm" data-view-dr="${d.id}" style="margin-right:3px;">👁 View</button>
              <button class="btn btn-outline btn-sm" data-pdf-dr="${d.id}" style="margin-right:3px;">📄 PDF</button>
              ${can('manageReports') ? `<button class="btn btn-outline btn-sm" data-edit-dr="${d.id}" style="margin-right:3px;">✏️ Edit</button>` : ''}
              ${state.user.role === 'Super Admin' ? `<button class="btn btn-outline btn-sm" data-delete-dr="${d.id}" style="color:#dc2626;border-color:#fca5a5;">🗑 Delete</button>` : ''}
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>
  </div>
  `;
}

const DELAY_STATUS_OPTIONS = ['Open', 'In Progress', 'Resolved', 'Client Action Required'];

function renderDelayReportForm(payload) {
  const jo = findJobOrder(payload.jobOrderId);
  const items = payload.delayItems || [];
  return `
  <div class="field"><label>Job Order</label>
    <select id="drJobOrderPick" ${payload.jobOrderId ? 'disabled' : ''}>
      <option value="">— Select Job Order —</option>
      ${state.jobOrders.map(j => `<option value="${j.id}" ${payload.jobOrderId === j.id ? 'selected' : ''}>${j.jobOrderNumber} — ${j.clientCompany}</option>`).join('')}
    </select>
  </div>
  ${jo ? `
  <div class="grid2" style="margin-bottom:14px;">
    <div><div class="k muted">Project</div><div>${jo.subject || jo.name || '—'}</div></div>
      <div><div class="k muted">Scope of Work</div><div>${jo.siteDetail || '—'}</div></div>
  </div>
  ${!(jo.siteEngineer || jo.projectManager || jo.siteSupervisor || jo.projectsIncharge) ? `<div class="banner-warn">⚠ This Job Order has no site team set yet — signatures below will be blank until you set it (open the Job Order and click "Set Site Team").</div>` : ''}
  ` : ''}
  <div class="grid2">
    <div class="field"><label>Date</label><input type="date" id="drDate" value="${payload.date || new Date().toISOString().slice(0, 10)}"></div>
    <div class="field"><label>Reported By</label><input id="drReportedBy" value="${payload.reportedBy || state.user.name}"></div>
  </div>

  <label>Delay Items</label>
  <div id="drItemsList">
    ${items.length === 0 ? `<p class="muted" style="font-size:12px;">No items yet — add one below.</p>` : ''}
    ${items.map((it, idx) => renderDrItemRow(it, idx)).join('')}
  </div>
  <button class="btn btn-ghost btn-sm" id="addDrItemBtn" type="button" style="margin-bottom:16px;">+ Add Delay Item</button>

  <label>Signatures to Include</label>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
    <div>
      <div style="background:#e1f5ee;border-radius:5px;padding:5px 10px;font-size:10px;font-weight:700;color:#085041;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Al Fitr (always shown)</div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;color:var(--ink);text-transform:none;letter-spacing:0;margin-bottom:6px;">
        <input type="checkbox" id="sig_reportedBy" checked style="width:auto;"> Prepared By — ${payload.reportedBy || state.user.name}
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;color:var(--ink);text-transform:none;letter-spacing:0;">
        <input type="checkbox" id="sig_projectsIncharge" checked style="width:auto;"> Project In-Charge — ${jo?.projectsIncharge || '—'}
      </label>
    </div>
    <div>
      <div style="background:#e6f1fb;border-radius:5px;padding:5px 10px;font-size:10px;font-weight:700;color:#185FA5;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Client (optional)</div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;color:var(--ink);text-transform:none;letter-spacing:0;margin-bottom:6px;">
        <input type="checkbox" id="sig_projectManager" ${jo && jo.projectManager ? 'checked' : ''} style="width:auto;"> Project Manager — ${jo?.projectManager || '—'}
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;color:var(--ink);text-transform:none;letter-spacing:0;">
        <input type="checkbox" id="sig_siteEngineer" ${jo && jo.siteEngineer ? 'checked' : ''} style="width:auto;"> Client Engineer — ${jo?.siteEngineer || '—'}
      </label>
    </div>
  </div>

  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
    <button class="btn btn-ghost" id="modalCancel">Cancel</button>
    <button class="btn btn-primary" id="saveDrBtn">Submit Delay Report</button>
  </div>
  `;
}

function renderDrItemRow(it, idx) {
  return `
  <div class="card" style="background:#FAFCFC;margin-bottom:10px;" data-dr-item="${idx}">
    <div class="grid3">
      <div class="field"><label>Floor</label><input class="drFloor" data-idx="${idx}" value="${it.floor || ''}"></div>
      <div class="field"><label>Area / Zone</label><input class="drAreaZone" data-idx="${idx}" value="${it.areaZone || ''}"></div>
      <div class="field"><label>Target Date</label><input type="date" class="drTargetDate" data-idx="${idx}" value="${it.targetDate || ''}"></div>
    </div>
    <div class="field"><label>Description</label><input class="drDescription" data-idx="${idx}" value="${it.description || ''}"></div>
    <div class="grid2">
      <div class="field"><label>Reason of Delay</label>
        <select class="drReason" data-idx="${idx}">
          <option value="">— Select reason —</option>
          ${DELAY_REASONS.map(r => `<option value="${r}" ${it.reasonOfDelay===r?'selected':''}>${r}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Action By</label><input class="drActionBy" data-idx="${idx}" value="${it.actionBy || ''}" placeholder="e.g. Engr. Ibrahim"></div>
    </div>
    <div class="grid3">
      <div class="field"><label>Status</label>
        <select class="drStatus" data-idx="${idx}">${DELAY_STATUS_OPTIONS.map(s => `<option ${it.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Site Photo</label><input type="file" class="drSitePhoto" data-idx="${idx}" accept="image/*"></div>
      <div class="field"><label>Drawing Photo</label><input type="file" class="drDrawingPhoto" data-idx="${idx}" accept="image/*"></div>
    </div>
    <div class="field" style="margin-bottom:0;"><label>Remarks</label><input class="drRemarks" data-idx="${idx}" value="${it.remarks || ''}"></div>
    <div style="text-align:right;margin-top:8px;"><button class="btn btn-ghost btn-sm removeDrItemBtn" data-idx="${idx}" type="button">Remove Item</button></div>
  </div>`;
}

function renderDelayReportView(d) {
  return `
  <div class="grid3">
    <div><div class="k muted">Job Order</div><div style="font-weight:600;font-family:var(--mono);font-size:12px;">${d.jobOrderNumber}</div></div>
    <div><div class="k muted">Client</div><div style="font-weight:600;">${d.clientCompany}</div></div>
    <div><div class="k muted">Date</div><div>${fmtDate(d.date)}</div></div>
  </div>
  <div class="grid2" style="margin-top:10px;margin-bottom:16px;">
    <div><div class="k muted">Project</div><div>${d.projectName || '—'}</div></div>
    <div><div class="k muted">Location</div><div>${d.location || '—'}</div></div>
  </div>
  ${d.delayItems.map(it => `
    <div class="card" style="margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
        <strong>Item ${it.srNo} — ${it.floor || ''} ${it.areaZone ? '· ' + it.areaZone : ''}</strong>
        <span class="tag">${it.status}</span>
      </div>
      <div>${it.description || ''}</div>
      <div class="grid2" style="margin-top:8px;font-size:12.5px;">
        <div><span class="muted">Reason:</span> ${it.reasonOfDelay || '—'}</div>
        <div><span class="muted">Action By:</span> ${it.actionBy || '—'}</div>
      </div>
      ${it.targetDate ? `<div style="font-size:12.5px;margin-top:4px;"><span class="muted">Target Date:</span> ${fmtDate(it.targetDate)}</div>` : ''}
      ${it.remarks ? `<div style="font-size:12.5px;margin-top:4px;"><span class="muted">Remarks:</span> ${it.remarks}</div>` : ''}
      ${it.sitePhotoUrl || it.drawingPhotoUrl ? `
      <div style="display:flex;gap:10px;margin-top:10px;">
        ${it.sitePhotoUrl ? `<a href="${it.sitePhotoUrl}" target="_blank"><img src="${it.sitePhotoUrl}" style="width:110px;height:80px;object-fit:cover;border-radius:6px;border:1px solid var(--border);"></a>` : ''}
        ${it.drawingPhotoUrl ? `<a href="${it.drawingPhotoUrl}" target="_blank"><img src="${it.drawingPhotoUrl}" style="width:110px;height:80px;object-fit:cover;border-radius:6px;border:1px solid var(--border);"></a>` : ''}
      </div>` : ''}
    </div>`).join('')}
  <div class="dn-sign" style="margin-top:30px;">
    ${d.signatures.afSide.map(s => `<div class="sign-line">${s.name || '—'}<br><span style="font-size:11px;">${s.role}</span></div>`).join('')}
    ${d.signatures.clientSide.map(s => `<div class="sign-line">${s.name || '—'}<br><span style="font-size:11px;">${s.role}</span></div>`).join('')}
  </div>
  <div style="display:flex;justify-content:space-between;align-items:center;margin-top:18px;">
    <div style="display:flex;gap:8px;">
      ${can('manageReports') ? `<button class="btn btn-outline btn-sm" id="editDrBtn" data-edit-dr="${d.id}">✏️ Edit Report</button>` : ''}
      <button class="btn btn-outline btn-sm" id="pdfDrBtn" data-pdf-dr="${d.id}">📄 Export PDF</button>
      ${state.user.role === 'Super Admin' ? `<button class="btn btn-outline btn-sm" id="deleteDrBtn" data-delete-dr="${d.id}" style="color:#dc2626;border-color:#fca5a5;">🗑 Delete</button>` : ''}
    </div>
    <button class="btn btn-ghost" id="modalCancel">Close</button>
  </div>
  `;
}

/* ---------------- Material Requests ---------------- */
function renderMaterialRequests() {
  const list = [...state.materialRequests].sort((a, b) => b.createdAt - a.createdAt);
  return `
  <div class="toolbar">
    <div style="flex:1"></div>
    ${can('manageMaterialRequests') ? `<button class="btn btn-primary" id="newMrBtn">+ New Material Request</button>` : ''}
  </div>
  <div class="card">
    <div class="tbl-wrap"><table>
      <thead><tr><th>MR #</th><th>Job Order</th><th>Client</th><th>Date</th><th>Requested By</th><th>Lines</th><th>Status</th><th></th></tr></thead>
      <tbody>
      ${list.length === 0 ? `<tr><td colspan="8"><div class="empty"><div class="big">📦</div>No material requests yet.</div></td></tr>` :
        list.map(m => `
        <tr>
          <td style="font-family:var(--mono);font-weight:700;">${m.mrNumber}</td>
          <td style="font-family:var(--mono);font-size:12px;">${m.jobOrderNumber}</td>
          <td>${m.clientCompany}</td>
          <td>${fmtDate(m.date)}</td>
          <td>${m.requestedByName}</td>
          <td>${m.lineItems.length}</td>
          <td>${mrStatusBadge(m.status)}</td>
          <td><button class="btn btn-outline btn-sm" data-view-mr="${m.id}">Open</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </div>
  `;
}

function renderMaterialRequestForm(payload) {
  const isEdit = !!payload.id;
  const jobOrderOptions = state.jobOrders.map(jo => `<option value="${jo.id}" ${payload.jobOrderId === jo.id ? 'selected' : ''}>${jo.jobOrderNumber} — ${jo.clientCompany}</option>`).join('');
  const acceptedQuotations = (state.quotations || []).filter(q => ['Accepted','Approved','Sent'].includes(q.status));
  const lines = payload.lineItems || [];
  return `
  ${!isEdit ? `
  <div class="field"><label>Client *</label>
    <select id="mr_clientPick" onchange="onMrClientSelect()">
      <option value="">— Select Client —</option>
      ${[...state.clients].sort((a,b)=>a.companyName.localeCompare(b.companyName)).map(c=>`<option value="${c.id}" ${payload.clientId===c.id?'selected':''}>${c.companyName}</option>`).join('')}
    </select>
  </div>` : ''}
  <div class="field"><label>Job Order / Project *</label>
    <select id="mrJobOrderPick" ${isEdit ? 'disabled' : ''} ${!isEdit?'disabled':''}>
      <option value="">— ${isEdit?'':'Select client first —'}</option>
      ${isEdit ? state.jobOrders.filter(j=>j.id===payload.jobOrderId).map(j=>`<option value="${j.id}" selected>${j.jobOrderNumber} — ${j.clientCompany}</option>`).join('') : ''}
    </select>
  </div>
  <div class="grid2">
    <div class="field"><label>Date</label><input type="date" id="mrDate" value="${payload.date || new Date().toISOString().slice(0, 10)}"></div>
    <div class="field"><label>Needed By <span class="muted" style="font-weight:500;text-transform:none;">(optional)</span></label><input type="date" id="mrNeededBy" value="${payload.neededBy || ''}"></div>
  </div>
  ${userPickerHtml('mr_requestedBy', payload.requestedByName || state.user?.name, payload.requestedByDesignation || state.user?.designation, 'Requested By', 'requestedBy')}

  ${!isEdit ? `
  <div style="background:var(--surface-2,#f8f9fa);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:14px;">
    <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">📋 Import from Quotation (optional)</div>
    <div class="field" style="margin-bottom:0;">
      <select id="mrQuotationPick" onchange="onMrQuotationSelect()">
        <option value="">— None / Add items manually —</option>
        ${acceptedQuotations.map(q => `<option value="${q.id}">${q.quotationNumber||'(no number)'} — ${q.clientCompany} — ${q.type}</option>`).join('')}
      </select>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-top:5px;">Select a quotation to auto-fill line items below. You can edit, delete or add more items after.</div>
  </div>` : ''}

  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
    <label style="margin-bottom:0;">Line Items</label>
    <div style="display:flex;gap:6px;">
      <button class="btn btn-ghost btn-sm" id="addMrLineBtn" type="button">+ From Stock</button>
      <button class="btn btn-ghost btn-sm" id="addMrCustomLineBtn" type="button">+ Custom Item</button>
    </div>
  </div>
  <div id="mrLinesList">
    ${lines.length === 0 ? `<p class="muted" style="font-size:12px;">No items yet — add from stock or custom item above.</p>` : ''}
    ${lines.map((l, idx) => renderMrLineRow(l, idx)).join('')}
  </div>
  <div class="field" style="margin-top:10px;"><label>Notes</label><textarea id="mrNotes" rows="2">${payload.notes || ''}</textarea></div>
  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
    <button class="btn btn-ghost" id="modalCancel">Cancel</button>
    <button class="btn btn-primary" id="saveMrBtn">${isEdit ? 'Save Changes' : 'Submit Request'}</button>
  </div>
  `;
}

function renderMrLineRow(l, idx) {
  const it = l.itemId ? findItem(l.itemId) : null;
  const avail = it ? it.qty : null;
  const isCustom = l.isCustom || !l.itemId;
  return `
  <div style="background:var(--surface-1,#fafafa);border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:8px;" data-mr-line="${idx}">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
      <span style="font-size:11px;font-weight:600;color:var(--muted);">${isCustom ? '✏️ Custom Item' : '📦 Stock Item'} #${idx+1}</span>
      <button class="btn btn-ghost btn-sm removeMrLineBtn" data-idx="${idx}" style="padding:4px 8px;color:var(--red);">✕ Remove</button>
    </div>
    ${isCustom ? `
    <div class="grid3" style="align-items:end;gap:8px;">
      <div class="field" style="margin-bottom:0;grid-column:span 2;">
        <label>Description *</label>
        <input class="mrLineDesc" data-idx="${idx}" value="${l.description||''}" placeholder="e.g. Fire Alarm Cable 2x1.5mm">
      </div>
      <div class="field" style="margin-bottom:0;">
        <label>Qty *</label>
        <input class="mrLineQty" data-idx="${idx}" type="number" value="${l.qtyRequested??l.qty??''}">
      </div>
      <div class="field" style="margin-bottom:0;">
        <label>Brand</label>
        <input class="mrLineBrand" data-idx="${idx}" value="${l.brand||''}" placeholder="e.g. Honeywell">
      </div>
      <div class="field" style="margin-bottom:0;">
        <label>Part No.</label>
        <input class="mrLinePartNo" data-idx="${idx}" value="${l.partNo||''}" placeholder="Optional">
      </div>
      <div class="field" style="margin-bottom:0;">
        <label>Unit</label>
        <input class="mrLineUnit" data-idx="${idx}" value="${l.unit||'Pcs'}" placeholder="Pcs">
      </div>
    </div>
    <input type="hidden" class="mrLineIsCustom" data-idx="${idx}" value="true">
    ` : `
    <div class="grid3" style="align-items:end;gap:8px;">
      <div class="field" style="margin-bottom:0;grid-column:span 2;">
        <label>Item</label>
        <select class="mrLineItemPick" data-idx="${idx}">
          <option value="">— Select item —</option>
          ${state.items.map(i => `<option value="${i.id}" ${l.itemId === i.id ? 'selected' : ''}>${itemLabel(i)} (Avail: ${i.qty})</option>`).join('')}
        </select>
        ${it ? `<div class="muted" style="font-size:11px;margin-top:3px;">Currently in stock: <strong style="color:${avail>0?'var(--green)':'var(--red)'}">${avail} ${it.unit}</strong></div>` : ''}
      </div>
      <div class="field" style="margin-bottom:0;">
        <label>Qty *</label>
        <input class="mrLineQty" data-idx="${idx}" type="number" value="${l.qtyRequested??l.qty??''}">
      </div>
    </div>
    <input type="hidden" class="mrLineIsCustom" data-idx="${idx}" value="false">
    `}
  </div>`;
}

function renderMaterialRequestView(mr) {
  const canFulfill = can('manageStock');
  const canProcure = can('manageMaterialRequests');
  const jo = findJobOrder(mr.jobOrderId);
  const shortfallLines = mr.lineItems.filter(l => {
    const it = findItem(l.itemId);
    const remaining = l.qtyRequested - l.qtyFulfilled;
    const avail = it ? it.qty : 0;
    return remaining > 0 && avail < remaining;
  });
  const existingPr = state.purchaseRequests.find(p => p.materialRequestId === mr.id);
  return `
  <div class="grid3">
    <div><div class="k muted">Job Order</div><div style="font-weight:600;font-family:var(--mono);font-size:12px;">${mr.jobOrderNumber}</div></div>
    <div><div class="k muted">Client</div><div style="font-weight:600;">${mr.clientCompany}</div></div>
    <div><div class="k muted">Requested By</div><div style="font-weight:600;">${mr.requestedByName}${mr.requestedByDesignation ? ' <span class="muted" style="font-weight:400;">— ' + mr.requestedByDesignation + '</span>' : ''}</div></div>
  </div>
  <div class="grid3" style="margin-top:10px;">
    <div><div class="k muted">Date</div><div>${fmtDate(mr.date)}</div></div>
    <div><div class="k muted">Needed By</div><div>${mr.neededBy ? fmtDate(mr.neededBy) : '—'}</div></div>
    <div><div class="k muted">Status</div><div>${mrStatusBadge(mr.status)}</div></div>
  </div>
  ${mr.notes ? `<div style="margin-top:12px;"><strong>Notes:</strong> ${mr.notes}</div>` : ''}
  <div class="tbl-wrap" style="margin-top:16px;"><table>
    <thead><tr><th>Description</th><th>Brand</th><th>Unit</th><th style="text-align:right;">Requested</th><th style="text-align:right;">Fulfilled</th><th style="text-align:right;">In Stock</th>${canFulfill ? '<th></th>' : ''}</tr></thead>
    <tbody>
    ${mr.lineItems.map(l => {
      const it = findItem(l.itemId);
      const remaining = l.qtyRequested - l.qtyFulfilled;
      const avail = it ? it.qty : 0;
      const lineDone = remaining <= 0;
      return `<tr>
        <td>${l.description}</td><td>${l.brand || '—'}</td><td>${l.unit}</td>
        <td style="text-align:right;font-family:var(--mono);">${l.qtyRequested}</td>
        <td style="text-align:right;font-family:var(--mono);">${l.qtyFulfilled}</td>
        <td style="text-align:right;font-family:var(--mono);" class="${avail < remaining ? 'pill-out' : ''}">${avail}</td>
        ${canFulfill ? `<td>${lineDone && mr.status !== 'Cancelled' ? '<span class="muted" style="font-size:11px;">Done</span>' : (mr.status === 'Cancelled' ? '' : `<button class="btn btn-outline btn-sm" data-fulfill-line="${mr.id}|${l.id}|${remaining}">Fulfill</button>`)}</td>` : ''}
      </tr>`;
    }).join('')}
    </tbody>
  </table></div>
  ${shortfallLines.length > 0 && mr.status !== 'Cancelled' ? `
    <div class="banner-warn" style="margin-top:14px;">
      ⚠ ${shortfallLines.length} line(s) don't have enough in stock.
      ${existingPr ? `A Purchase Request has already been raised for this (${existingPr.prNumber}).` : `Raise a Purchase Request to buy the shortfall.`}
    </div>
    ${!existingPr && canProcure ? `<button class="btn btn-primary btn-sm" id="raisePrBtn" style="margin-bottom:14px;">Raise Purchase Request</button>` : ''}
    ${existingPr ? `<button class="btn btn-outline btn-sm" data-view-pr="${existingPr.id}" style="margin-bottom:14px;">View ${existingPr.prNumber}</button>` : ''}
  ` : ''}
  <div style="display:flex;justify-content:space-between;margin-top:18px;">
    <div>${mr.status === 'Requested' && can('manageMaterialRequests') ? `<button class="btn btn-danger" id="cancelMrBtn">Cancel Request</button>` : ''}</div>
    <button class="btn btn-ghost" id="modalCancel">Close</button>
  </div>
  `;
}

/* ---------------- Procurement (Purchase Requests + Purchase Orders) ---------------- */
function renderProcurement() {
  const view = state.procView || 'requests';
  return `
  <div class="toolbar">
    <div style="display:flex;gap:8px;">
      <button class="btn ${view === 'requests' ? 'btn-primary' : 'btn-outline'} btn-sm" data-proc-view="requests">Purchase Requests</button>
      <button class="btn ${view === 'orders' ? 'btn-primary' : 'btn-outline'} btn-sm" data-proc-view="orders">Purchase Orders</button>
    </div>
    <div style="flex:1"></div>
  </div>
  ${view === 'requests' ? renderPrList() : renderPoList()}
  `;
}

function renderPrList() {
  const list = [...state.purchaseRequests].sort((a, b) => b.createdAt - a.createdAt);
  return `
  <div class="card">
    <div class="tbl-wrap"><table>
      <thead><tr><th>PR #</th><th>Material Request</th><th>Job Order</th><th>Date</th><th>Requested By</th><th>Lines</th><th>Status</th><th></th></tr></thead>
      <tbody>
      ${list.length === 0 ? `<tr><td colspan="8"><div class="empty"><div class="big">🧾</div>No purchase requests yet — these get raised from a Material Request's shortfall.</div></td></tr>` :
        list.map(pr => `
        <tr>
          <td style="font-family:var(--mono);font-weight:700;">${pr.prNumber}</td>
          <td style="font-family:var(--mono);font-size:12px;">${pr.materialRequestNumber}</td>
          <td style="font-family:var(--mono);font-size:12px;">${pr.jobOrderNumber}</td>
          <td>${fmtDate(pr.date)}</td>
          <td>${pr.requestedByName}</td>
          <td>${pr.lineItems.length}</td>
          <td>${prStatusBadge(pr.status)}</td>
          <td><button class="btn btn-outline btn-sm" data-view-pr="${pr.id}">Open</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </div>`;
}

function renderPoList() {
  const list = [...state.purchaseOrders].sort((a, b) => b.createdAt - a.createdAt);
  return `
  <div class="card">
    <div class="tbl-wrap"><table>
      <thead><tr><th>PO #</th><th>Vendor</th><th>From PR</th><th>Date</th><th>Lines</th><th>Status</th><th></th></tr></thead>
      <tbody>
      ${list.length === 0 ? `<tr><td colspan="7"><div class="empty"><div class="big">📦</div>No purchase orders yet — these get created from an approved Purchase Request.</div></td></tr>` :
        list.map(po => `
        <tr>
          <td style="font-family:var(--mono);font-weight:700;">${po.poNumber}</td>
          <td>${po.vendorName}</td>
          <td style="font-family:var(--mono);font-size:12px;">${po.purchaseRequestNumber}</td>
          <td>${fmtDate(po.date)}</td>
          <td>${po.lineItems.length}</td>
          <td>${poStatusBadge(po.status)}</td>
          <td><button class="btn btn-outline btn-sm" data-view-po="${po.id}">Open</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </div>`;
}

function renderPrView(pr) {
  const canProcure = can('manageProcurement');
  return `
  <div class="grid3">
    <div><div class="k muted">Material Request</div><div style="font-weight:600;font-family:var(--mono);font-size:12px;">${pr.materialRequestNumber}</div></div>
    <div><div class="k muted">Job Order</div><div style="font-weight:600;font-family:var(--mono);font-size:12px;">${pr.jobOrderNumber}</div></div>
    <div><div class="k muted">Requested By</div><div style="font-weight:600;">${pr.requestedByName}${pr.requestedByDesignation ? ' <span class="muted" style="font-weight:400;">— ' + pr.requestedByDesignation + '</span>' : ''}</div></div>
  </div>
  <div class="grid2" style="margin-top:10px;">
    <div><div class="k muted">Date</div><div>${fmtDate(pr.date)}</div></div>
    <div><div class="k muted">Status</div><div>${prStatusBadge(pr.status)}</div></div>
  </div>
  ${pr.status === 'Rejected' ? `<div class="banner-warn" style="margin-top:10px;">Rejected: ${pr.rejectionReason || 'No reason given'}</div>` : ''}
  ${pr.notes ? `<div style="margin-top:12px;"><strong>Notes:</strong> ${pr.notes}</div>` : ''}
  <div class="tbl-wrap" style="margin-top:16px;"><table>
    <thead><tr><th>Description</th><th>Brand</th><th>Unit</th><th style="text-align:right;">Qty</th></tr></thead>
    <tbody>
    ${pr.lineItems.map(l => `<tr><td>${l.description}</td><td>${l.brand || '—'}</td><td>${l.unit}</td><td style="text-align:right;font-family:var(--mono);">${l.qty}</td></tr>`).join('')}
    </tbody>
  </table></div>
  <div style="display:flex;justify-content:space-between;margin-top:18px;">
    <div style="display:flex;gap:8px;">
      ${pr.status === 'Requested' && canProcure ? `<button class="btn btn-primary btn-sm" id="approvePrBtn">Approve</button><button class="btn btn-danger btn-sm" id="rejectPrBtn">Reject</button>` : ''}
      ${pr.status === 'Approved' && canProcure ? `<button class="btn btn-primary btn-sm" id="convertPrToPoBtn">Create Purchase Order</button>` : ''}
      ${pr.status === 'Converted' && pr.purchaseOrderId ? `<button class="btn btn-outline btn-sm" data-view-po="${pr.purchaseOrderId}">View Purchase Order</button>` : ''}
    </div>
    <button class="btn btn-ghost" id="modalCancel">Close</button>
  </div>
  `;
}

function renderPrForm(payload) {
  const mr = findMaterialRequest(payload.materialRequestId);
  const lines = payload.lineItems || [];
  return `
  <div class="muted" style="margin-bottom:10px;font-size:12px;">Raising against <strong>${mr.mrNumber}</strong> (${mr.jobOrderNumber})</div>
  <label>Shortfall Line Items <span class="muted" style="font-weight:500;text-transform:none;">(pre-filled with what's short — adjust if you want to order more)</span></label>
  <div class="tbl-wrap" style="margin-bottom:14px;"><table>
    <thead><tr><th>Description</th><th>Unit</th><th style="text-align:right;">Qty to Order</th></tr></thead>
    <tbody>
    ${lines.map((l, idx) => `
      <tr>
        <td>${l.description}</td><td>${l.unit}</td>
        <td style="text-align:right;"><input class="prLineQty" data-idx="${idx}" type="number" style="width:100px;text-align:right;" value="${l.qty}"></td>
      </tr>`).join('')}
    </tbody>
  </table></div>
  ${userPickerHtml('pr_requestedBy', payload.requestedByName || state.user?.name, payload.requestedByDesignation || state.user?.designation, 'Requested By', 'requestedBy')}
  <div class="field"><label>Notes</label><textarea id="prNotes" rows="2">${payload.notes || ''}</textarea></div>
  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
    <button class="btn btn-ghost" id="modalCancel">Cancel</button>
    <button class="btn btn-primary" id="savePrBtn">Raise Purchase Request</button>
  </div>
  `;
}

function renderPoForm(payload) {
  // payload.purchaseRequestId is the approved PR being converted
  const pr = findPurchaseRequest(payload.purchaseRequestId);
  const vendorOptions = state.vendors.map(v => `<option value="${v.id}" ${payload.vendorId === v.id ? 'selected' : ''}>${v.companyName}</option>`).join('');
  return `
  <div class="muted" style="margin-bottom:10px;font-size:12px;">Converting <strong>${pr.prNumber}</strong> (from ${pr.materialRequestNumber}, ${pr.jobOrderNumber})</div>
  <div class="field"><label>Vendor</label>
    <select id="poVendorPick">
      <option value="">— Select vendor —</option>
      ${vendorOptions}
    </select>
  </div>
  <div class="field"><label>Expected Delivery Date <span class="muted" style="font-weight:500;text-transform:none;">(optional)</span></label><input type="date" id="poExpectedDate" value="${payload.expectedDate || ''}"></div>
  <label>Line Items &amp; Unit Cost</label>
  <div class="tbl-wrap" style="margin-bottom:14px;"><table>
    <thead><tr><th>Description</th><th>Unit</th><th style="text-align:right;">Qty</th><th style="text-align:right;">Unit Cost</th></tr></thead>
    <tbody>
    ${pr.lineItems.map(l => `
      <tr>
        <td>${l.description}</td><td>${l.unit}</td><td style="text-align:right;font-family:var(--mono);">${l.qty}</td>
        <td style="text-align:right;"><input class="poUnitCost" data-prlineid="${l.id}" type="number" style="width:100px;text-align:right;" value="${(payload.unitCosts && payload.unitCosts[l.id]) || ''}"></td>
      </tr>`).join('')}
    </tbody>
  </table></div>
  ${userPickerHtml('po_createdBy', payload.createdByName || state.user?.name, payload.createdByDesignation || state.user?.designation, 'Created By', 'createdBy')}
  <div class="field"><label>Notes</label><textarea id="poNotes" rows="2">${payload.notes || ''}</textarea></div>
  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
    <button class="btn btn-ghost" id="modalCancel">Cancel</button>
    <button class="btn btn-primary" id="createPoBtn">Create Purchase Order</button>
  </div>
  `;
}

function renderPoView(po) {
  const canProcure = can('manageProcurement');
  const canReceive = can('manageStock');
  return `
  <div class="grid3">
    <div><div class="k muted">Vendor</div><div style="font-weight:600;">${po.vendorName}</div></div>
    <div><div class="k muted">From Purchase Request</div><div style="font-weight:600;font-family:var(--mono);font-size:12px;">${po.purchaseRequestNumber}</div></div>
    <div><div class="k muted">Job Order</div><div style="font-weight:600;font-family:var(--mono);font-size:12px;">${po.jobOrderNumber}</div></div>
  </div>
  <div class="grid3" style="margin-top:10px;">
    <div><div class="k muted">Date</div><div>${fmtDate(po.date)}</div></div>
    <div><div class="k muted">Expected</div><div>${po.expectedDate ? fmtDate(po.expectedDate) : '—'}</div></div>
    <div><div class="k muted">Status</div><div>${poStatusBadge(po.status)}</div></div>
  </div>
  <div class="grid3" style="margin-top:10px;">
    <div><div class="k muted">Created By</div><div>${po.createdByName || '—'}${po.createdByDesignation ? ' <span class="muted">— ' + po.createdByDesignation + '</span>' : ''}</div></div>
  </div>
  ${po.notes ? `<div style="margin-top:12px;"><strong>Notes:</strong> ${po.notes}</div>` : ''}
  <div class="tbl-wrap" style="margin-top:16px;"><table>
    <thead><tr><th>Description</th><th>Unit</th><th style="text-align:right;">Ordered</th><th style="text-align:right;">Received</th><th style="text-align:right;">Unit Cost</th>${canReceive ? '<th></th>' : ''}</tr></thead>
    <tbody>
    ${po.lineItems.map(l => {
      const remaining = l.qtyOrdered - l.qtyReceived;
      const lineDone = remaining <= 0;
      return `<tr>
        <td>${l.description}</td><td>${l.unit}</td>
        <td style="text-align:right;font-family:var(--mono);">${l.qtyOrdered}</td>
        <td style="text-align:right;font-family:var(--mono);">${l.qtyReceived}</td>
        <td style="text-align:right;font-family:var(--mono);">${state.company.currency} ${fmtMoney(l.unitCost)}</td>
        ${canReceive ? `<td>${po.status === 'Draft' ? '' : lineDone ? '<span class="muted" style="font-size:11px;">Done</span>' : (po.status === 'Cancelled' ? '' : `<button class="btn btn-outline btn-sm" data-receive-line="${po.id}|${l.id}|${remaining}">Receive</button>`)}</td>` : ''}
      </tr>`;
    }).join('')}
    </tbody>
  </table></div>
  <div style="display:flex;justify-content:space-between;margin-top:18px;">
    <div style="display:flex;gap:8px;">
      ${po.status === 'Draft' && canProcure ? `<button class="btn btn-primary btn-sm" id="sendPoBtn">Send to Vendor</button><button class="btn btn-danger btn-sm" id="cancelPoBtn">Cancel</button>` : ''}
    </div>
    <button class="btn btn-ghost" id="modalCancel">Close</button>
  </div>
  `;
}

/* ---------------- Quotation view / print ---------------- */
function renderQuoteView(q) {
  const doc = q.type === 'AMC' ? renderAmcQuoteDoc(q) : renderStandardQuoteDoc(q);
  return `
  <div id="printArea" class="dn-doc">${doc}</div>
  ${renderQuoteActionBar(q)}
  `;
}

function quoteDocHeader(q) {
  const co = state.company;
  return `
  <div class="dn-head">
    <div style="display:flex;gap:14px;align-items:center;">
      ${co.logoPath ? `<img src="${co.logoPath}" class="dn-logo" style="height:${logoSizePx(co.logoSize)}px;max-width:220px;object-fit:contain;" alt="${co.name} logo">` : ''}
      <div>
        <div class="dn-company">${co.name}</div>
        <div class="dn-company-sub">${[co.address, co.phone, co.email].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
    <div class="dn-title-block">
      <div class="dn-title">QUOTATION</div>
      <div class="dn-num">${q.quotationNumber || '(not yet sent)'}</div>
      <div class="muted">${q.status === 'PendingApproval' ? 'PENDING APPROVAL' : q.status.toUpperCase()}${q.revisionOf ? ` · REV ${q.revisionNumber}` : ''}</div>
    </div>
  </div>
  ${q.supersededByQuotationId ? `<div class="banner-warn">⚠ This quotation has been superseded by a later revision. It's kept here for reference only.</div>` : ''}
  <div class="dn-meta">
    <div><div class="k">Ref No</div><div class="v">${q.quotationNumber || '—'}</div></div>
    <div><div class="k">Date</div><div class="v">${fmtDate(q.date)}</div></div>
    <div><div class="k">Client</div><div class="v">${q.clientCompany}</div></div>
    <div><div class="k">Attn</div><div class="v">${q.clientAttn || '—'}</div></div>
    <div><div class="k">Contact</div><div class="v">${q.clientContact || '—'}</div></div>
    <div><div class="k">Email</div><div class="v">${q.clientEmail || '—'}</div></div>
  </div>
  ${q.subject ? `<div style="margin:10px 0;"><strong>Subject:</strong> ${q.subject}</div>` : ''}
  ${q.siteDetail ? `<div style="margin-bottom:14px;"><strong>Site Detail:</strong> ${q.siteDetail}</div>` : ''}
  ${q.sitesCovered && q.sitesCovered.length ? `
  <div style="margin-bottom:14px;">
    <strong>Sites Covered:</strong>
    <table class="dn-table" style="margin-top:6px;"><thead><tr><th>#</th><th>Site</th><th>Reference</th><th>Notes</th></tr></thead>
    <tbody>${q.sitesCovered.map((s,i)=>`<tr><td>${i+1}</td><td>${s.name}</td><td>${s.reference||'—'}</td><td>${s.notes||'—'}</td></tr>`).join('')}</tbody></table>
  </div>` : ''}
  <p>Dear Sir,</p>
  <p>We thank you for your enquiry. We have pleasure to submit our quotation as follows.</p>
  `;
}

function quoteDocFooter(q) {
  const t = calcQuoteTotals(q.type === 'AMC' ? { ...q, lineItems: q.amc.services } : q);
  const cur = state.company.currency;
  return `
  <table class="dn-table" style="margin-top:10px;">
    <tr><td style="text-align:right;width:80%;">Subtotal</td><td style="text-align:right;">${cur} ${fmtMoney(t.subtotal)}</td></tr>
    ${t.discount > 0 ? `<tr><td style="text-align:right;">Discount</td><td style="text-align:right;">- ${cur} ${fmtMoney(t.discount)}</td></tr>` : ''}
    <tr><td style="text-align:right;">VAT (5%)</td><td style="text-align:right;">${cur} ${fmtMoney(t.vat)}</td></tr>
    <tr style="font-weight:700;"><td style="text-align:right;">Total</td><td style="text-align:right;">${cur} ${fmtMoney(t.total)}</td></tr>
  </table>
  <div class="grid2" style="margin-top:16px;">
    <div><strong>Payment Terms:</strong> ${q.paymentTerms || 'TBD'}</div>
    <div><strong>Validity:</strong> ${q.validityDays || 15} Days</div>
  </div>
  ${q.exclusions && q.exclusions.length ? `
  <div style="margin-top:14px;">
    <strong>Exclusions:</strong>
    <ul style="margin:6px 0 0;padding-left:20px;font-size:13px;">${q.exclusions.map(e => `<li style="margin-bottom:4px;">${e}</li>`).join('')}</ul>
  </div>` : ''}
  ${q.notes ? `<div style="margin-top:14px;"><strong>Notes:</strong> ${q.notes}</div>` : ''}
  <p style="margin-top:20px;">Regards,</p>
  <div class="dn-sign" style="margin-top:36px;">
    <div class="sign-line"><strong>${q.preparedByName || '—'}</strong><br><span style="font-size:11px;">${q.preparedByDesignation || 'Prepared By'}</span></div>
    <div class="sign-line"><strong>${q.approvedByName || 'Pending'}</strong><br><span style="font-size:11px;">${q.approvedByDesignation || (q.approvedByName ? 'Approved By' : 'Approval Pending')}</span></div>
  </div>
  <div class="dn-footer-note">This is a system-generated quotation. Signature is not required unless specifically requested by the client.</div>
  ${companyFooterNote()}
  `;
}

function renderStandardQuoteDoc(q) {
  const showGrouped = q.type === 'PR' || q.type === 'FO';
  const groups = groupLinesByCategory(q.lineItems);
  const cur = state.company.currency;
  return `
  ${quoteDocHeader(q)}
  ${showGrouped && groups.length > 1 ? `
    <div style="text-align:center;font-weight:700;margin:14px 0 6px;">ARTICLE 1: SUMMARY</div>
    <table class="dn-table">
      <thead><tr><th>Description</th><th style="text-align:right;">Total (${cur})</th></tr></thead>
      <tbody>${groups.map(g => `<tr><td>${g.category}</td><td style="text-align:right;">${fmtMoney(g.subtotal)}</td></tr>`).join('')}</tbody>
    </table>
    <div style="text-align:center;font-weight:700;margin:18px 0 6px;">ARTICLE 2: BILL OF QUANTITY</div>
  ` : ''}
  ${groups.map(g => `
    ${showGrouped && groups.length > 1 ? `<div style="background:#F3F5F6;font-weight:700;padding:6px 10px;margin-top:10px;">${g.category}</div>` : ''}
    <table class="dn-table">
      <thead><tr><th>Description</th><th>Brand</th><th>Unit</th><th style="text-align:right;">Qty</th><th style="text-align:right;">Unit Price</th><th style="text-align:right;">Total</th></tr></thead>
      <tbody>${g.lines.map(l => `<tr><td>${l.description}</td><td>${l.brand||'—'}</td><td>${l.unit}</td><td style="text-align:right;">${l.qty}</td><td style="text-align:right;">${fmtMoney(l.unitPrice)}</td><td style="text-align:right;">${fmtMoney(lineTotal(l))}</td></tr>`).join('')}</tbody>
    </table>
  `).join('')}
  ${quoteDocFooter(q)}
  `;
}

function renderAmcQuoteDoc(q) {
  const amc = q.amc || {};
  const cur = state.company.currency;
  return `
  ${quoteDocHeader(q)}
  ${amc.scopeOfAgreement ? `<div style="margin-bottom:14px;"><strong>Scope of Agreement:</strong> ${amc.scopeOfAgreement}</div>` : ''}
  <div class="grid3" style="margin-bottom:14px;">
    <div><strong>Contract Period:</strong> ${fmtDate(amc.contractStart)} to ${fmtDate(amc.contractEnd)}</div>
    <div><strong>Maintenance Visits:</strong> ${amc.maintenanceSchedule || 'Quarterly'}</div>
  </div>
  <table class="dn-table">
    <thead><tr><th>Description</th><th style="text-align:right;">Qty</th><th style="text-align:right;">Unit Price</th><th style="text-align:right;">Total</th></tr></thead>
    <tbody>${(amc.services || []).map(s => `<tr><td>${s.description}</td><td style="text-align:right;">${s.qty}</td><td style="text-align:right;">${fmtMoney(s.unitPrice)}</td><td style="text-align:right;">${fmtMoney(lineTotal(s))}</td></tr>`).join('')}</tbody>
  </table>
  ${amc.manpower && amc.manpower.length ? `
  <div style="margin-top:14px;"><strong>Manpower Details:</strong>
  <table class="dn-table"><thead><tr><th>Role</th><th style="text-align:right;">Qty</th></tr></thead>
  <tbody>${amc.manpower.map(m => `<tr><td>${m.role}</td><td style="text-align:right;">${m.qty}</td></tr>`).join('')}</tbody></table>
  </div>` : ''}
  ${quoteDocFooter(q)}
  `;
}

function renderQuoteActionBar(q) {
  const buttons = [];
  const canManage = can('manageQuotations');
  buttons.push(`<button class="btn btn-teal" id="downloadQuotePdfBtn">Download PDF</button>`);

  if (q.status === 'Draft' && canManage) {
    buttons.unshift(`<button class="btn btn-outline" id="editQuoteBtn">Edit</button>`);
    buttons.unshift(`<button class="btn btn-primary" id="submitQuoteBtn">Submit for Approval</button>`);
  }
  if (q.status === 'Rejected') {
    buttons.unshift(`<span class="muted" style="align-self:center;font-size:12px;">Rejected: ${q.rejectionReason || 'No reason given'}</span>`);
    if (canManage) buttons.unshift(`<button class="btn btn-outline" id="editQuoteBtn">Edit & Resubmit</button>`);
  }
  if (q.status === 'PendingApproval' && isQuotationApprover()) {
    buttons.unshift(`<button class="btn btn-danger" id="rejectQuoteBtn">Reject</button>`);
    buttons.unshift(`<button class="btn btn-primary" id="approveQuoteBtn">Approve</button>`);
  }
  if (q.status === 'Approved' && canManage) {
    buttons.unshift(`<button class="btn btn-primary" id="sendQuoteBtn">Send to Client</button>`);
  }
  if (q.status === 'Sent' && canManage) {
    buttons.unshift(`<button class="btn btn-danger" id="declineQuoteBtn">Client Declined</button>`);
    buttons.unshift(`<button class="btn btn-primary" id="acceptQuoteBtn">Client Accepted</button>`);
  }
  if (q.status === 'Accepted' && canManage) {
    if (q.jobOrderId) {
      const jo = state.jobOrders.find(j => j.id === q.jobOrderId);
      buttons.unshift(`<span class="badge badge-in" style="align-self:center;">Job Order ${jo ? jo.jobOrderNumber : ''} created</span>`);
    } else {
      buttons.unshift(`<button class="btn btn-primary" id="convertQuoteBtn">Convert to Job Order</button>`);
    }
  }
  if (q.status === 'Declined') {
    buttons.unshift(`<span class="muted" style="align-self:center;font-size:12px;">${q.clientDecisionNote || 'Client declined this quotation.'}</span>`);
  }
  if (['Sent', 'Accepted', 'Declined'].includes(q.status) && canManage) {
    if (q.supersededByQuotationId) {
      const rev = findQuote(q.supersededByQuotationId);
      buttons.unshift(`<button class="btn btn-outline btn-sm" data-view-quote="${q.supersededByQuotationId}">View ${rev ? (rev.quotationNumber || 'Revision') : 'Revision'}</button>`);
      buttons.unshift(`<span class="badge badge-low" style="align-self:center;">Superseded${rev && rev.quotationNumber ? ' by ' + rev.quotationNumber : ''}</span>`);
    } else {
      buttons.unshift(`<button class="btn btn-outline" id="reviseQuoteBtn">Revise (Discount / BOQ Change)</button>`);
    }
  }

  return `<div class="no-print" style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px;flex-wrap:wrap;">
    <button class="btn btn-ghost" id="modalCancel">Close</button>
    ${buttons.join('')}
  </div>`;
}

function renderExclusionsLibrary() {
  return `
  <div class="tbl-wrap"><table>
    <thead><tr><th>Text</th><th>Category</th><th></th></tr></thead>
    <tbody>
    ${state.exclusionsLibrary.length === 0 ? `<tr><td colspan="3"><div class="empty">No saved exclusions yet.</div></td></tr>` :
      state.exclusionsLibrary.map(e => `<tr><td style="font-size:13px;">${e.text}</td><td>${e.category}</td><td><button class="btn btn-ghost btn-sm removeLibExclBtn" data-id="${e.id}">Remove</button></td></tr>`).join('')}
    </tbody>
  </table></div>
  <div class="field" style="margin-top:14px;"><label>Add New Exclusion / Term</label>
    <div style="display:flex;gap:8px;"><input id="newLibExclText" style="flex:1;" placeholder="Type a reusable exclusion or term..."><button class="btn btn-primary btn-sm" id="addLibExclBtn">Add</button></div>
  </div>
  <div style="display:flex;justify-content:flex-end;margin-top:14px;"><button class="btn btn-ghost" id="modalCancel">Close</button></div>
  `;
}

/* ---------------- Quotation form ---------------- */
// Helper — dropdown of all active users (for Super Admin name override)
function applyUserPick(fieldId, val, payloadPrefix) {
  var parts = (val||'').split('|');
  var n = document.getElementById(fieldId+'_name');
  var d = document.getElementById(fieldId+'_desig');
  if (n) n.value = parts[0]||'';
  if (d) d.value = parts[1]||'';
  // Also store in payload so re-renders don't lose it
  if (state.modal && state.modal.payload) {
    if (fieldId === 'quotePreparedBy') {
      state.modal.payload.preparedByName        = parts[0]||'';
      state.modal.payload.preparedByDesignation = parts[1]||'';
    }
    if (fieldId === 'quoteApprovedBy') {
      state.modal.payload.approvedByName        = parts[0]||'';
      state.modal.payload.approvedByDesignation = parts[1]||'';
    }
    if (fieldId === 'dnIssuedBy') {
      state.modal.payload.issuedBy = parts[0]||'';
    }
    // Generic path for any newer field — pass payloadPrefix and it just works,
    // no need to hardcode a new branch here every time.
    if (payloadPrefix) {
      state.modal.payload[payloadPrefix + 'Name']        = parts[0]||'';
      state.modal.payload[payloadPrefix + 'Designation'] = parts[1]||'';
    }
  }
}

function userPickerHtml(fieldId, currentName, currentDesig, label, payloadPrefix) {
  const isSA  = state.user?.role === 'Super Admin';
  const name  = currentName  || state.user?.name        || '';
  const desig = currentDesig || state.user?.designation  || '';
  if (!isSA) {
    return `<div class="field"><label>${label}</label>
      <input value="${name}" disabled style="background:#f5f5f5;margin-bottom:4px;">
      <input value="${desig}" disabled style="background:#f5f5f5;font-size:12px;">
    </div>`;
  }
  const opts = (state.users||[]).filter(u=>u.active!==false)
    .map(u=>`<option value="${u.name}|${u.designation||''}" ${name===u.name?'selected':''}>${u.name}${u.designation?' — '+u.designation:''}</option>`).join('');
  return `<div class="field"><label>${label}</label>
    <select onchange="applyUserPick('${fieldId}',this.value,'${payloadPrefix||''}')" style="margin-bottom:6px;">
      <option value="|">— Select from team —</option>
      ${opts}
    </select>
    <input id="${fieldId}_name" value="${name}" placeholder="Name" style="margin-bottom:4px;">
    <input id="${fieldId}_desig" value="${desig}" placeholder="Designation" style="font-size:12px;">
  </div>`;
}

function getUserPickerValue(fieldId) {
  return {
    name:        (document.getElementById(fieldId+'_name')?.value||'').trim(),
    designation: (document.getElementById(fieldId+'_desig')?.value||'').trim(),
  };
}

function renderQuoteForm(payload) {
  if (!payload.type) return renderQuoteTypeChooser();
  if (payload.type === 'AMC') return renderAmcQuoteForm(payload);
  return renderStandardQuoteForm(payload);
}

function renderQuoteTypeChooser() {
  const opts = [
    ['PR', 'Project', 'Multi-system installs — grouped BOQ by category (Fire Alarm, PAVA, EML...)'],
    ['SUP', 'Supply Only', 'Simple flat quote for material supply'],
    ['FO', 'Fit-Out', 'Fit-out jobs — same grouped BOQ structure as Project'],
    ['AMC', 'AMC Contract', 'Annual maintenance contract with clauses, manpower & maintenance schedule'],
  ];
  return `
  <div class="grid2">
    ${opts.map(([type, label, desc]) => `
      <div class="type-choice-card" data-choose-quote-type="${type}">
        <div style="font-weight:700;font-size:15px;margin-bottom:6px;">${label}</div>
        <div class="muted" style="font-size:12px;">${desc}</div>
        <div class="muted" style="font-size:11px;font-family:var(--mono);margin-top:8px;">AF/${type}/xxxxx/yy</div>
      </div>`).join('')}
  </div>
  <div style="display:flex;justify-content:flex-end;margin-top:16px;">
    <button class="btn btn-ghost" id="modalCancel">Cancel</button>
  </div>
  `;
}

function renderSitesCoveredEditor(payload) {
  const sites = payload.sitesCovered || [];
  return `
  <label>Sites Covered <span class="muted" style="font-weight:500;text-transform:none;">(optional — add every building/site this quote covers)</span></label>
  <div id="sitesCoveredList">
    ${sites.map((s, idx) => `
      <div class="grid3" style="margin-bottom:6px;align-items:end;" data-site-row="${idx}">
        <div class="field" style="margin-bottom:0;"><input class="siteNameInput" data-idx="${idx}" placeholder="Site / building name" value="${s.name || ''}"></div>
        <div class="field" style="margin-bottom:0;"><input class="siteRefInput" data-idx="${idx}" placeholder="Reference / ID (optional)" value="${s.reference || ''}"></div>
        <div style="display:flex;gap:6px;"><input class="siteNotesInput" data-idx="${idx}" placeholder="Notes (optional)" value="${s.notes || ''}" style="flex:1;"><button class="btn btn-ghost btn-sm removeSiteBtn" data-idx="${idx}" style="padding:6px 9px;">✕</button></div>
      </div>`).join('')}
  </div>
  <button class="btn btn-ghost btn-sm" id="addSiteBtn" type="button" style="margin-bottom:14px;">+ Add Site</button>
  `;
}

function renderExclusionsPicker(payload) {
  const selected = payload.exclusions || [];
  return `
  <label>Exclusions & Terms</label>
  <div id="exclusionsSelected" style="margin-bottom:8px;">
    ${selected.length === 0 ? `<span class="muted" style="font-size:12px;">None added yet.</span>` :
      selected.map((text, idx) => `<span class="excl-pill">${text}<button type="button" class="removeExclBtn" data-idx="${idx}">✕</button></span>`).join('')}
  </div>
  <div style="display:flex;gap:8px;margin-bottom:14px;">
    <select id="exclusionLibraryPick" style="flex:1;">
      <option value="">— Add from saved library —</option>
      ${state.exclusionsLibrary.filter(e => !selected.includes(e.text)).map(e => `<option value="${e.id}">${e.text.slice(0, 80)}${e.text.length > 80 ? '…' : ''}</option>`).join('')}
    </select>
    <button class="btn btn-ghost btn-sm" id="addExclFromLibBtn" type="button">Add</button>
  </div>
  <div style="display:flex;gap:8px;margin-bottom:14px;">
    <input id="customExclusionInput" placeholder="Or type a one-off exclusion / term and press Add" style="flex:1;">
    <button class="btn btn-ghost btn-sm" id="addCustomExclBtn" type="button">Add</button>
  </div>
  `;
}

function renderQuoteTotalsBox(payload) {
  const t = calcQuoteTotals(payload);
  const cur = state.company.currency;
  return `
  <div class="card" id="quoteTotalsBox" style="background:#FAFCFC;">
    <div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0;"><span class="muted">Subtotal</span><span id="totSubtotal">${cur} ${fmtMoney(t.subtotal)}</span></div>
    <div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0;align-items:center;">
      <span class="muted">Discount</span>
      <input type="number" id="quoteDiscount" value="${payload.discount || 0}" style="width:120px;text-align:right;">
    </div>
    <div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0;"><span class="muted">Taxable</span><span id="totTaxable">${cur} ${fmtMoney(t.taxable)}</span></div>
    <div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0;"><span class="muted">VAT (5%)</span><span id="totVat">${cur} ${fmtMoney(t.vat)}</span></div>
    <div style="display:flex;justify-content:space-between;font-size:15px;font-weight:700;padding:6px 0 0;border-top:1px solid var(--border);margin-top:4px;"><span>Total</span><span id="totTotal">${cur} ${fmtMoney(t.total)}</span></div>
  </div>`;
}

function renderStandardQuoteForm(payload) {
  const isEdit = !!payload.id;
  const lines = payload.lineItems || [];
  return `
  <div class="muted" style="margin-bottom:10px;font-size:12px;">Type: <strong>${QUOTE_TYPE_LABEL[payload.type]}</strong> &nbsp;·&nbsp; Number assigned when sent: <span style="font-family:var(--mono)">AF/${QUOTE_TYPE_PREFIX[payload.type]}/${state.nextQuotationCounter || '…'}/${String(new Date().getFullYear()).slice(-2)}</span></div>
  <div class="grid2">
    <div class="field">
      <label>Client</label>
      <select id="quoteClientPick">
        <option value="">— Select saved client (optional) —</option>
        ${[...state.clients].sort((a,b)=>a.companyName.localeCompare(b.companyName)).map(c => `<option value="${c.id}" ${payload.clientId === c.id ? 'selected' : ''}>${c.companyName}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>Client Company Name</label><input id="quoteClientCompany" value="${payload.clientCompany || ''}" placeholder="M/S. Client Name"></div>
  </div>
  <div class="grid3">
    <div class="field"><label>Attn</label><input id="quoteClientAttn" value="${payload.clientAttn || ''}"></div>
    <div class="field"><label>Contact</label><input id="quoteClientContact" value="${payload.clientContact || ''}"></div>
    <div class="field"><label>Email</label><input id="quoteClientEmail" type="email" value="${payload.clientEmail || ''}"></div>
  </div>
  <div class="grid3">
    <div class="field"><label>PO Box</label><input id="quoteClientPoBox" value="${payload.clientPoBox || ''}"></div>
    <div class="field"><label>Date</label><input id="quoteDate" type="date" value="${payload.date || new Date().toISOString().slice(0,10)}"></div>
    <div class="field"><label>Validity (days)</label><input id="quoteValidityDays" type="number" value="${payload.validityDays ?? 15}"></div>
  </div>
  <div class="field"><label>Subject</label><input id="quoteSubject" value="${payload.subject || ''}" placeholder="QUOTATION FOR ..."></div>
  <div class="field"><label>Site Detail</label><input id="quoteSiteDetail" value="${payload.siteDetail || ''}"></div>

  ${renderSitesCoveredEditor(payload)}

  <label>Line Items</label>
  <div id="quoteLinesList">
    ${lines.length === 0 ? `<p class="muted" style="font-size:12px;">No items yet — add one below.</p>` : ''}
    ${lines.map((l, idx) => renderQuoteLineCard(l, idx)).join('')}
  </div>
  <button class="btn btn-ghost btn-sm" id="addQuoteLineBtn" type="button" style="margin-bottom:16px;">+ Add Line Item</button>

  <div class="field"><label>Payment Terms</label><input id="quotePaymentTerms" value="${payload.paymentTerms || ''}" placeholder="e.g. 50% Advance, 50% Before Delivery"></div>
  ${renderExclusionsPicker(payload)}
  <div class="field"><label>Notes</label><textarea id="quoteNotes" rows="2">${payload.notes || ''}</textarea></div>

  ${renderQuoteTotalsBox(payload)}

  <div style="border-top:1px solid var(--rule);margin:14px 0 12px;padding-top:14px;">
    <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">Signatures</div>
    <div class="grid2">
      ${userPickerHtml('quotePreparedBy', payload.preparedByName || state.user?.name, payload.preparedByDesignation || state.user?.designation, 'Prepared By')}
      ${userPickerHtml('quoteApprovedBy', payload.approvedByName, payload.approvedByDesignation, 'Approved By')}
    </div>
  </div>

  <div style="display:flex;justify-content:space-between;margin-top:14px;">
    <div>${isEdit ? `<button class="btn btn-danger" id="deleteQuoteBtn" type="button">Delete Draft</button>` : ''}</div>
    <div style="display:flex;gap:8px;"><button class="btn btn-ghost" id="modalCancel">Cancel</button><button class="btn btn-primary" id="saveQuoteDraftBtn">Save Draft</button></div>
  </div>
  `;
}

function renderQuoteLineCard(l, idx) {
  return `
  <div class="quote-line-card" data-quote-line="${idx}">
    <div class="quote-line-top">
      <div><label>Description</label><input class="qlDescription" data-idx="${idx}" value="${l.description || ''}" placeholder="Item description"></div>
      <div><label>Category</label>
        <select class="qlCategory" data-idx="${idx}">
          ${state.quotationCategories.map(c => `<option ${l.category === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
      </div>
      <div style="display:flex;align-items:flex-end;"><button class="btn btn-ghost btn-sm removeQuoteLineBtn" data-idx="${idx}" style="padding:6px 9px;">✕</button></div>
    </div>
    <div class="quote-line-bottom">
      <div><label>From Inventory</label>
        <select class="qlInventoryPick" data-idx="${idx}">
          <option value="">— custom line —</option>
          ${state.items.map(it => `<option value="${it.id}" ${l.itemId === it.id ? 'selected' : ''}>${itemLabel(it)}</option>`).join('')}
        </select>
      </div>
      <div><label>Brand</label><input class="qlBrand" data-idx="${idx}" value="${l.brand || ''}"></div>
      <div><label>Unit</label>
        <select class="qlUnit" data-idx="${idx}">${state.units.map(u => `<option ${l.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select>
      </div>
      <div><label>Qty</label><input class="qlQty" data-idx="${idx}" type="number" value="${l.qty ?? ''}"></div>
      <div><label>Unit Price</label><input class="qlPrice" data-idx="${idx}" type="number" value="${l.unitPrice ?? ''}"></div>
      <div><label>Line Total</label><input class="qlLineTotal" value="${state.company.currency} ${fmtMoney(lineTotal(l))}" disabled></div>
    </div>
  </div>`;
}

function renderAmcQuoteForm(payload) {
  const isEdit = !!payload.id;
  const amc = payload.amc || { services: [], manpower: [], scopeOfAgreement: '', contractStart: '', contractEnd: '', maintenanceSchedule: 'Quarterly' };
  return `
  <div class="muted" style="margin-bottom:10px;font-size:12px;">Type: <strong>AMC Contract</strong> &nbsp;·&nbsp; Number assigned when sent: <span style="font-family:var(--mono)">AF/AMC/${state.nextQuotationCounter || '…'}/${String(new Date().getFullYear()).slice(-2)}</span></div>
  <div class="grid2">
    <div class="field">
      <label>Client</label>
      <select id="quoteClientPick">
        <option value="">— Select saved client (optional) —</option>
        ${[...state.clients].sort((a,b)=>a.companyName.localeCompare(b.companyName)).map(c => `<option value="${c.id}" ${payload.clientId === c.id ? 'selected' : ''}>${c.companyName}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>Client Company Name</label><input id="quoteClientCompany" value="${payload.clientCompany || ''}"></div>
  </div>
  <div class="grid3">
    <div class="field"><label>Attn</label><input id="quoteClientAttn" value="${payload.clientAttn || ''}"></div>
    <div class="field"><label>Contact</label><input id="quoteClientContact" value="${payload.clientContact || ''}"></div>
    <div class="field"><label>Email</label><input id="quoteClientEmail" type="email" value="${payload.clientEmail || ''}"></div>
  </div>
  <div class="field"><label>Subject</label><input id="quoteSubject" value="${payload.subject || ''}" placeholder="QUOTATION FOR ANNUAL MAINTENANCE CONTRACT..."></div>
  <div class="field"><label>Site Detail</label><input id="quoteSiteDetail" value="${payload.siteDetail || ''}"></div>

  ${renderSitesCoveredEditor(payload)}

  <div class="field"><label>Scope of Agreement</label><textarea id="amcScope" rows="3">${amc.scopeOfAgreement}</textarea></div>
  <div class="grid3">
    <div class="field"><label>Contract Start</label><input id="amcStart" type="date" value="${amc.contractStart}"></div>
    <div class="field"><label>Contract End</label><input id="amcEnd" type="date" value="${amc.contractEnd}"></div>
    <div class="field"><label>Maintenance Visits</label>
      <select id="amcSchedule">
        ${['Quarterly','Semi-Annual','Annual','Monthly'].map(o => `<option ${amc.maintenanceSchedule === o ? 'selected' : ''}>${o}</option>`).join('')}
      </select>
    </div>
  </div>

  <label>Services / Pricing</label>
  <div id="amcServicesList">
    ${(amc.services || []).map((s, idx) => `
      <div class="grid4" style="margin-bottom:6px;align-items:end;">
        <div class="field" style="margin-bottom:0;grid-column:span 2;"><input class="amcSvcDesc" data-idx="${idx}" value="${s.description || ''}" placeholder="Service description"></div>
        <div class="field" style="margin-bottom:0;"><input class="amcSvcQty" data-idx="${idx}" type="number" value="${s.qty ?? ''}" placeholder="Qty"></div>
        <div style="display:flex;gap:6px;"><input class="amcSvcPrice" data-idx="${idx}" type="number" value="${s.unitPrice ?? ''}" placeholder="Unit Price" style="flex:1;"><button class="btn btn-ghost btn-sm removeAmcSvcBtn" data-idx="${idx}" style="padding:6px 9px;">✕</button></div>
      </div>`).join('')}
  </div>
  <button class="btn btn-ghost btn-sm" id="addAmcSvcBtn" type="button" style="margin-bottom:14px;">+ Add Service Line</button>

  <label>Manpower</label>
  <div id="amcManpowerList">
    ${(amc.manpower || []).map((m, idx) => `
      <div class="grid3" style="margin-bottom:6px;align-items:end;">
        <div class="field" style="margin-bottom:0;grid-column:span 2;"><input class="amcMpRole" data-idx="${idx}" value="${m.role || ''}" placeholder="e.g. Supervisor, Technician"></div>
        <div style="display:flex;gap:6px;"><input class="amcMpQty" data-idx="${idx}" type="number" value="${m.qty ?? ''}" placeholder="Qty" style="flex:1;"><button class="btn btn-ghost btn-sm removeAmcMpBtn" data-idx="${idx}" style="padding:6px 9px;">✕</button></div>
      </div>`).join('')}
  </div>
  <button class="btn btn-ghost btn-sm" id="addAmcMpBtn" type="button" style="margin-bottom:16px;">+ Add Manpower Line</button>

  <div class="field"><label>Payment Terms</label><input id="quotePaymentTerms" value="${payload.paymentTerms || ''}" placeholder="e.g. Client will pay advance on quarterly basis"></div>
  ${renderExclusionsPicker(payload)}
  <div class="field"><label>Notes</label><textarea id="quoteNotes" rows="2">${payload.notes || ''}</textarea></div>

  ${renderQuoteTotalsBox({ ...payload, lineItems: amc.services })}

  <div style="display:flex;justify-content:space-between;margin-top:14px;">
    <div>${isEdit ? `<button class="btn btn-danger" id="deleteQuoteBtn" type="button">Delete Draft</button>` : ''}</div>
    <div style="display:flex;gap:8px;"><button class="btn btn-ghost" id="modalCancel">Cancel</button><button class="btn btn-primary" id="saveQuoteDraftBtn">Save Draft</button></div>
  </div>
  `;
}

/* ---------------- Settings ---------------- */
function renderSettings() {
  const co = state.company;
  return `
  <div class="grid2" style="align-items:start;">
    <div class="card">
      <div class="card-title" style="margin-bottom:12px;">Company Branding</div>
      <div class="field">
        <label>Company Logo</label>
        <div style="display:flex;align-items:center;gap:12px;">
          <div style="width:70px;height:70px;border:1px dashed var(--border);border-radius:8px;display:flex;align-items:center;justify-content:center;background:#FAFCFC;overflow:hidden;">
            ${co.logoPath ? `<img src="${co.logoPath}" style="max-width:100%;max-height:100%;object-fit:contain;">` : `<span class="muted" style="font-size:11px;text-align:center;">No logo</span>`}
          </div>
          <div>
            <input type="file" id="logoUpload" accept="image/png,image/jpeg,image/svg+xml,image/webp" style="max-width:220px;" ${can('manageInventory') ? '' : 'disabled'}>
            ${co.logoPath && can('manageInventory') ? `<button class="btn btn-ghost btn-sm" id="removeLogoBtn" style="margin-top:6px;">Remove Logo</button>` : ''}
          </div>
        </div>
        <p class="muted" style="margin-top:6px;">PNG, JPG, SVG or WEBP. Resized automatically wherever it appears.</p>
      </div>
      <div class="field"><label>Logo Display Size</label>
        <select id="setLogoSize" ${can('manageInventory') ? '' : 'disabled'}>
          <option value="small" ${co.logoSize === 'small' ? 'selected' : ''}>Small</option>
          <option value="medium" ${co.logoSize === 'medium' ? 'selected' : ''}>Medium</option>
          <option value="large" ${co.logoSize === 'large' ? 'selected' : ''}>Large</option>
        </select>
      </div>
      <div class="field"><label>Company Name</label><input id="setCompanyName" value="${co.name || ''}" ${can('manageInventory') ? '' : 'disabled'}></div>
      <div class="field"><label>Address</label><input id="setCompanyAddress" value="${co.address || ''}" ${can('manageInventory') ? '' : 'disabled'}></div>
      <div class="grid2">
        <div class="field"><label>Phone</label><input id="setCompanyPhone" value="${co.phone || ''}" ${can('manageInventory') ? '' : 'disabled'}></div>
        <div class="field"><label>Email</label><input id="setCompanyEmail" value="${co.email || ''}" ${can('manageInventory') ? '' : 'disabled'}></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Website</label><input id="setCompanyWebsite" value="${co.website || ''}" placeholder="www.example.com" ${can('manageInventory') ? '' : 'disabled'}></div>
        <div class="field"><label>VAT / TRN Number</label><input id="setCompanyVat" value="${co.vatNumber || ''}" ${can('manageInventory') ? '' : 'disabled'}></div>
      </div>
      ${can('manageInventory') ? `<button class="btn btn-teal" id="saveCompanyBtn">Save Company Details</button>` : `<p class="muted">Only Admins can edit company details.</p>`}
    </div>

    <div class="card">
      <div class="card-title" style="margin-bottom:12px;">Delivery Note &amp; Reports</div>
      <div class="grid2">
        <div class="field"><label>Delivery Note Prefix</label><input id="setDnPrefix" value="${co.dnPrefix || 'DN-'}" ${can('manageInventory') ? '' : 'disabled'}></div>
        <div class="field"><label>Default Currency</label>
          <select id="setCurrency" ${can('manageInventory') ? '' : 'disabled'}>
            ${['AED', 'USD', 'SAR', 'QAR', 'EUR', 'GBP'].map(c => `<option ${co.currency === c ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
      </div>
      <p class="muted" style="margin-top:-6px;">Next delivery note will be numbered <strong>${state.nextDnPreview || ''}</strong>.</p>
      <div class="field"><label>Paper Size (PDF / Print)</label>
        <select id="setPaperSize" ${can('manageInventory') ? '' : 'disabled'}>
          <option value="A4" ${co.paperSize === 'A4' ? 'selected' : ''}>A4</option>
          <option value="Letter" ${co.paperSize === 'Letter' ? 'selected' : ''}>Letter</option>
        </select>
      </div>
      <div class="field"><label>Delivery Note Footer Text</label><textarea id="setReportFooter" rows="2" placeholder="e.g. The undersigned hereby acknowledges receipt of the materials in good condition..." ${can('manageInventory') ? '' : 'disabled'}>${co.reportFooter || ''}</textarea>
      <p class="muted" style="margin-top:4px;">Only appears on Delivery Notes — not on Inventory Reports or Quotations, which have their own appropriate wording.</p></div>
      ${can('manageInventory') ? `<button class="btn btn-teal" id="saveDnSettingsBtn">Save Delivery Note &amp; Report Settings</button>` : ''}
    </div>
  </div>

  <div class="grid2" style="align-items:start;">
    <div class="card">
      <div class="card-title" style="margin-bottom:12px;">Branches</div>
      <div id="branchList">${state.branches.map(b => `<span class="tag">${b} ${can('manageInventory') ? `<span data-del-branch="${b}" style="cursor:pointer;color:var(--red);">✕</span>` : ''}</span>`).join(' ')}</div>
      ${can('manageInventory') ? `<div class="field" style="margin-top:12px;"><label>Add Branch</label>
        <div style="display:flex;gap:8px;"><input id="newBranchInput" placeholder="e.g. Store D"><button class="btn btn-ghost btn-sm" id="addBranchBtn">Add</button></div>
      </div>` : ''}
    </div>
    <div class="card">
      <div class="card-title" style="margin-bottom:12px;">Brands</div>
      <div id="brandList">${state.brands.map(b => `<span class="tag">${b} ${can('manageInventory') ? `<span data-del-brand="${b}" style="cursor:pointer;color:var(--red);">✕</span>` : ''}</span>`).join(' ')}</div>
      ${can('manageInventory') ? `<div class="field" style="margin-top:12px;"><label>Add Brand</label>
        <div style="display:flex;gap:8px;"><input id="newBrandInput" placeholder="e.g. Notifier"><button class="btn btn-ghost btn-sm" id="addBrandBtn">Add</button></div>
      </div>` : ''}
    </div>
  </div>
  <div class="grid2" style="align-items:start;">
    <div class="card">
      <div class="card-title" style="margin-bottom:12px;">Units</div>
      <div id="unitList">${state.units.map(u => `<span class="tag">${u} ${can('manageInventory') ? `<span data-del-unit="${u}" style="cursor:pointer;color:var(--red);">✕</span>` : ''}</span>`).join(' ')}</div>
      ${can('manageInventory') ? `<div class="field" style="margin-top:12px;"><label>Add Unit</label>
        <div style="display:flex;gap:8px;"><input id="newUnitInput" placeholder="e.g. Drum"><button class="btn btn-ghost btn-sm" id="addUnitBtn">Add</button></div>
      </div>` : ''}
    </div>
    <div class="card">
      <div class="card-title" style="margin-bottom:12px;">Your Account</div>
      <p class="muted" style="margin-top:0;">Signed in as <strong>${state.user.name}</strong> (${state.user.role}).</p>
      <button class="btn btn-outline btn-sm" id="openChangePwdBtn">Change Password</button>
    </div>
  </div>

  ${can('manageQuotations') ? renderQuotationSettings() : ''}

  ${can('manageUsers') ? renderUsersRolesSettings() : `<div class="card"><div class="card-title" style="margin-bottom:6px;">Users &amp; Roles</div><p class="muted" style="margin:0;">Only Super Admin can manage users, roles and permissions.</p></div>`}

  <div class="shared-note">Pricing visibility, negative-stock rules and user permissions here are enforced by the server on every request — not just hidden in this screen.</div>
  `;
}

function renderQuotationSettings() {
  const approverIds = new Set((state.company.quotationApprovers || []));
  return `
  <div class="grid2" style="align-items:start;">
    <div class="card">
      <div class="card-title" style="margin-bottom:12px;">Quotation Numbering</div>
      <div class="field"><label>Continue From Number</label><input id="setQuoteCounter" type="number" value="${state.nextQuotationCounter ? state.nextQuotationCounter - 1 : 20409}"></div>
      <p class="muted" style="margin-top:-6px;">Next quotation will be numbered like <strong>AF/PR/${state.nextQuotationCounter || ''}/${String(new Date().getFullYear()).slice(-2)}</strong> (prefix depends on type: PR / SUP / AMC / FO).</p>
      <button class="btn btn-teal btn-sm" id="saveQuoteCounterBtn">Save</button>
    </div>
    <div class="card">
      <div class="card-title" style="margin-bottom:12px;">Quotation Categories</div>
      <div id="quoteCategoryList">${state.quotationCategories.map(c => `<span class="tag">${c} <span data-del-quotecat="${c}" style="cursor:pointer;color:var(--red);">✕</span></span>`).join(' ')}</div>
      <div class="field" style="margin-top:12px;"><label>Add Category</label>
        <div style="display:flex;gap:8px;"><input id="newQuoteCatInput" placeholder="e.g. CCTV System"><button class="btn btn-ghost btn-sm" id="addQuoteCatBtn">Add</button></div>
      </div>
    </div>
  </div>
  <div class="grid2" style="align-items:start;">
    <div class="card">
      <div class="card-title" style="margin-bottom:12px;">Quotation Approvers</div>
      <p class="muted" style="margin-top:0;">Only these people (and Super Admin, always) can approve a quotation before it's sent.</p>
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${state.users.filter(u => u.active !== false).map(u => `
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;color:var(--ink);text-transform:none;letter-spacing:0;">
            <input type="checkbox" class="approverCheck" data-uid="${u.id}" ${approverIds.has(u.id) ? 'checked' : ''} style="width:auto;"> ${u.name} <span class="muted">(${u.role})</span>
          </label>`).join('')}
      </div>
      <button class="btn btn-teal btn-sm" id="saveApproversBtn" style="margin-top:12px;">Save Approvers</button>
    </div>
    <div class="card">
      <div class="card-title" style="margin-bottom:12px;">Exclusions &amp; Terms Library</div>
      <p class="muted" style="margin-top:0;">${state.exclusionsLibrary.length} saved exclusion/term snippets, reusable across every quotation instead of retyping.</p>
      <button class="btn btn-outline btn-sm" id="openExclusionsLibBtn">Manage Library</button>
    </div>
  </div>
  `;
}


function renderUsersRolesSettings() {
  return `
  <div class="card">
    <div class="card-head">
      <div class="card-title">Users <span>${state.users.length} user(s)</span></div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-ghost btn-sm" id="seedRolesBtn">+ Add Default Roles</button>
        <button class="btn btn-primary btn-sm" id="addUserBtn">+ Add User</button>
      </div>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Name</th><th>Designation</th><th>Username</th><th>Role</th><th>Active</th><th></th></tr></thead>
      <tbody>
      ${state.users.map(u => `
        <tr>
          <td><strong>${u.name}</strong></td>
          <td class="muted">${u.designation || '—'}</td>
          <td style="font-family:var(--mono);font-size:12px;">${u.username}</td>
          <td>${u.role}</td>
          <td>${u.active !== false ? '✅' : '—'}</td>
          <td><button class="btn btn-outline btn-sm" data-edit-user="${u.id}">Edit</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </div>
  <div class="card">
    <div class="card-title" style="margin-bottom:10px;">Role Permissions</div>
    <p class="muted" style="margin-top:0;">Enforced by the server on every request — not just this screen.</p>
    <div class="tbl-wrap"><table class="perm-grid">
      <thead><tr><th>Permission</th>${Object.keys(state.roles).map(r => `<th>${r}</th>`).join('')}</tr></thead>
      <tbody>
      ${state.permLabels.map(([key, label]) => `
        <tr><td>${label}</td>${Object.keys(state.roles).map(r => `
          <td><input type="checkbox" class="permCheck" data-role="${r}" data-perm="${key}" ${state.roles[r][key] ? 'checked' : ''} ${r === 'Super Admin' ? 'disabled' : ''}></td>
        `).join('')}</tr>`).join('')}
      </tbody>
    </table></div>
    <p class="muted" style="margin-top:8px;">Super Admin always has full access and can't be restricted.</p>
  </div>
  `;
}

/* ================= MODALS ================= */
function openModal(type, payload) { state.modal = { type, payload: payload || {} }; render(); }
function closeModal() { state.modal = null; render(); }

function renderModal() {
  const { type, payload } = state.modal;
  if (type === 'item') return modalWrap(renderItemForm(payload), 'Item Details');
  if (type === 'movement') return modalWrap(renderMovementForm(payload), payload.id ? 'Edit Stock Movement' : 'Log Stock Movement');
  if (type === 'fmChecklist')      return modalWrap(renderFmChecklistForm(), 'New Daily Checklist', false);
  if (type === 'addAbnormality')   return modalWrap(renderAddAbnormalityForm(payload.clId), 'Add Abnormality Entry', false);
  if (type === 'newWcr')           return modalWrap(renderWcrForm(), 'New Work Completion Report', true);
  if (type === 'newSnr')           return modalWrap(renderSnrForm(), 'New Service Notification Report', false);
  if (type === 'newIncident')      return modalWrap(renderIncidentForm(), 'New Incident Report', true);
  if (type === 'vendor') return modalWrap(renderVendorForm(payload), 'Vendor Details');
  if (type === 'client') return modalWrap(renderClientForm(payload), payload.id ? 'Edit Client' : 'New Client');
  if (type === 'userEdit') return modalWrap(renderUserForm(payload), 'User Details');
  if (type === 'forcePwd') return modalWrap(renderForcePwdForm(payload), 'Change Your Password');
  if (type === 'changePwd') return modalWrap(renderChangePwdForm(payload), 'Change Password');
  if (type === 'newDn') return modalWrap(renderDnForm(payload), 'New Delivery Note', true);
  if (type === 'viewDn') return modalWrap(renderDnView(payload), '', true);
  if (type === 'invReport') return modalWrap(renderInventoryReportView(), '', true);
  if (type === 'newQuote') return modalWrap(renderQuoteForm(payload), payload.id ? 'Edit Quotation' : 'New Quotation', true);
  if (type === 'viewQuote') return modalWrap(renderQuoteView(payload), '', true);
  if (type === 'exclusionsLib') return modalWrap(renderExclusionsLibrary(payload), 'Exclusions & Terms Library');
  if (type === 'viewJobOrder') return modalWrap(renderJobOrderView(payload), `Job Order ${payload.jobOrderNumber}`, true);
  if (type === 'newMr') return modalWrap(renderMaterialRequestForm(payload), payload.id ? 'Edit Material Request' : 'New Material Request');
  if (type === 'viewMr') return modalWrap(renderMaterialRequestView(payload), `Material Request ${payload.mrNumber}`, true);
  if (type === 'newPr') return modalWrap(renderPrForm(payload), 'Raise Purchase Request');
  if (type === 'viewPr') return modalWrap(renderPrView(payload), `Purchase Request ${payload.prNumber}`, true);
  if (type === 'newPo') return modalWrap(renderPoForm(payload), 'Create Purchase Order');
  if (type === 'viewPo') return modalWrap(renderPoView(payload), `Purchase Order ${payload.poNumber}`, true);
  if (type === 'siteTeam') return modalWrap(renderSiteTeamForm(payload), 'Set Site Team');
  if (type === 'newJo') return modalWrap(renderJoForm(payload), payload.id ? 'Edit Job Order' : 'New Job Order');
  if (type === 'newDr')  return modalWrap(renderDelayReportForm(payload), 'New Delay Report', true);
  if (type === 'editDr') return modalWrap(renderDelayReportForm(payload), `Edit Report — ${payload.refNumber || ''}`, true);
  if (type === 'viewDr') return modalWrap(renderDelayReportView(payload), `Delay Report ${payload.refNumber}`, true);
  return '';
}
function modalWrap(inner, title, wide) {
  return `<div class="overlay" id="modalOverlay">
    <div class="modal ${wide ? 'wide' : ''}">
      ${title ? `<div class="modal-head"><div class="modal-title">${title}</div><button class="close-x" id="modalClose">✕</button></div>` : `<div style="text-align:right;"><button class="close-x no-print" id="modalClose">✕</button></div>`}
      ${inner}
    </div>
  </div>`;
}

function renderItemForm(item) {
  const isEdit = !!item.id;
  const showPricing = can('viewPricing');
  const canEditPricing = can('editPricing');
  return `
  <div class="grid2">
    <div class="field"><label>Brand</label>
      <select id="f_brand">${state.brands.map(b => `<option ${item.brand === b ? 'selected' : ''}>${b}</option>`).join('')}</select>
    </div>
    <div class="field"><label>Part No. / Model No.</label><input id="f_partNo" value="${item.partNo || ''}"></div>
  </div>
  <div class="field"><label>Item Description</label><input id="f_description" value="${item.description || ''}"></div>
  <div class="grid3">
    <div class="field"><label>Branch / Location</label>
      <select id="f_location">${state.branches.map(b => `<option ${item.location === b ? 'selected' : ''}>${b}</option>`).join('')}</select>
    </div>
    <div class="field"><label>Unit</label>
      <select id="f_unit">${state.units.map(u => `<option ${item.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select>
    </div>
    <div class="field"><label>Min Level</label><input type="number" id="f_minLevel" value="${item.minLevel ?? 0}"></div>
  </div>
  ${showPricing ? `
  <div class="grid3">
    <div class="field"><label>Material Cost (${state.company.currency})</label><input type="number" id="f_cost" value="${item.cost ?? 0}" ${canEditPricing ? '' : 'disabled'}></div>
    <div class="field"><label>Selling Price (${state.company.currency})</label><input type="number" id="f_price" value="${item.price ?? 0}" ${canEditPricing ? '' : 'disabled'}></div>
    <div class="field"><label>Opening Qty</label><input type="number" id="f_openingQty" value="${item.openingQty ?? 0}"></div>
  </div>` : `
  <div class="grid3"><div class="field"><label>Opening Qty</label><input type="number" id="f_openingQty" value="${item.openingQty ?? 0}"></div></div>
  <p class="muted">Pricing fields are hidden for your role.</p>`}
  ${isEdit ? `<div class="muted" style="margin-bottom:10px;">Current Qty On Hand: <strong>${item.qty}</strong> (${statusBadge(item.status)})</div>` : ''}
  <div style="display:flex;justify-content:space-between;margin-top:8px;">
    <div>${isEdit && can('manageInventory') ? `<button class="btn btn-danger" id="deleteItemBtn">Delete Item</button>` : ''}</div>
    <div style="display:flex;gap:8px;"><button class="btn btn-ghost" id="modalCancel">Cancel</button>${can('manageInventory') ? `<button class="btn btn-primary" id="saveItemBtn">${isEdit ? 'Save Changes' : 'Add Item'}</button>` : ''}</div>
  </div>
  `;
}

function renderClientForm(client) {
  const isEdit = !!client.id;
  return `
  ${isEdit && client.customerNumber ? `<div style="background:#f0faf5;border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:12px;color:#085041;font-weight:600;">Customer No: ${client.customerNumber}</div>` : ''}
  <div class="field"><label>Company Name *</label><input id="c_companyName" value="${client.companyName || ''}" placeholder="e.g. Edge Technical Solutions LLC"></div>
  <div class="grid2">
    <div class="field"><label>Contact Person</label><input id="c_contactPerson" value="${client.contactPerson || ''}"></div>
    <div class="field"><label>Phone</label><input id="c_phone" value="${client.phone || ''}" placeholder="+971 5xx xxx xxx"></div>
  </div>
  <div class="grid2">
    <div class="field"><label>Email</label><input id="c_email" type="email" value="${client.email || ''}"></div>
    <div class="field"><label>TRN / VAT Number</label><input id="c_trn" value="${client.trn || ''}" placeholder="Optional"></div>
  </div>
  <div class="field"><label>Address</label><input id="c_address" value="${client.address || ''}"></div>
  <div class="field"><label>Notes</label><textarea id="c_notes" rows="2" placeholder="Internal notes about this client...">${client.notes || ''}</textarea></div>
  <div style="display:flex;justify-content:space-between;margin-top:8px;">
    <div>${isEdit ? `<button class="btn btn-danger" id="deleteClientBtn">Delete Client</button>` : ''}</div>
    <div style="display:flex;gap:8px;"><button class="btn btn-ghost" id="modalCancel">Cancel</button><button class="btn btn-primary" id="saveClientBtn">${isEdit ? 'Save Changes' : 'Add Client'}</button></div>
  </div>
  `;
}

function renderUserForm(user) {
  const isEdit = !!user.id;
  return `
  <div class="field"><label>Name <span class="muted" style="font-weight:500;text-transform:none;">(the person's real name — this appears on quotations, not their role)</span></label><input id="u_name" value="${user.name || ''}" placeholder="e.g. Ahsan Aslam"></div>
  <div class="field"><label>Designation <span class="muted" style="font-weight:500;text-transform:none;">(job title — appears on quotations they prepare or approve)</span></label><input id="u_designation" value="${user.designation || ''}" placeholder="e.g. Sales Engineer, General Manager"></div>
  ${isEdit ? '' : `
  <div class="grid2">
    <div class="field"><label>Username</label><input id="u_username" placeholder="e.g. faisal"></div>
    <div class="field"><label>Temporary Password</label><input id="u_password" type="text" placeholder="min. 6 characters"></div>
  </div>`}
  <div class="grid2">
    <div class="field"><label>Role</label>
      <select id="u_role">${Object.keys(state.roles).map(r => `<option ${user.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
    </div>
    <div class="field"><label>Active</label>
      <select id="u_active"><option value="true" ${user.active !== false ? 'selected' : ''}>Active</option><option value="false" ${user.active === false ? 'selected' : ''}>Inactive</option></select>
    </div>
  </div>
  ${isEdit ? `<div class="field"><label>Reset Password (optional)</label><input id="u_newPassword" type="text" placeholder="Leave blank to keep current password"></div>` : ''}
  <div style="display:flex;justify-content:space-between;margin-top:8px;">
    <div>${isEdit ? `<button class="btn btn-danger" id="deleteUserBtn">Delete User</button>` : ''}</div>
    <div style="display:flex;gap:8px;"><button class="btn btn-ghost" id="modalCancel">Cancel</button><button class="btn btn-primary" id="saveUserBtn">${isEdit ? 'Save Changes' : 'Add User'}</button></div>
  </div>
  `;
}

function renderForcePwdForm() {
  return `
  <p class="muted" style="margin-top:0;">You're using a temporary password. Please set a new one to continue.</p>
  <div class="field"><label>Current Password</label><input id="pwd_current" type="password"></div>
  <div class="field"><label>New Password</label><input id="pwd_new" type="password" placeholder="min. 6 characters"></div>
  <div class="field"><label>Confirm New Password</label><input id="pwd_confirm" type="password"></div>
  <div id="pwdErr"></div>
  <div style="display:flex;justify-content:flex-end;margin-top:8px;">
    <button class="btn btn-primary" id="savePwdBtn">Set New Password</button>
  </div>
  <div class="muted" style="text-align:center;margin-top:18px;font-size:10.5px;">Powered by Nexora Technologies</div>
  `;
}
function renderChangePwdForm() { return renderForcePwdForm(); }

function renderMovementForm(payload) {
  const isEdit = !!payload.id;
  const items = [...state.items].sort((a, b) => a.description.localeCompare(b.description));
  return `
  <div class="field"><label>Item</label>
    <select id="mv_item">
      <option value="">— Select item —</option>
      ${items.map(i => `<option value="${i.id}" ${payload.itemId === i.id ? 'selected' : ''}>${itemLabel(i)} (Qty: ${i.qty})</option>`).join('')}
    </select>
  </div>
  <div class="grid3">
    <div class="field"><label>Action</label>
      <select id="mv_action">
        <option value="IN" ${payload.action === 'IN' ? 'selected' : ''}>IN (Received)</option>
        <option value="OUT" ${payload.action === 'OUT' ? 'selected' : ''}>OUT (Issued)</option>
        <option value="ADJUSTMENT" ${payload.action === 'ADJUSTMENT' ? 'selected' : ''}>ADJUSTMENT (Correction)</option>
      </select>
    </div>
    <div class="field"><label>Quantity</label><input type="number" id="mv_qty" placeholder="e.g. 10" value="${payload.qty ?? ''}"></div>
    <div class="field"><label>Date</label><input type="date" id="mv_date" value="${payload.date || new Date().toISOString().slice(0, 10)}"></div>
  </div>
  <div class="grid2">
    <div class="field"><label>Reference / Project</label><input id="mv_ref" placeholder="PO number, project name…" value="${payload.reference || ''}"></div>
    <div class="field"><label>Issued / Received By</label><input id="mv_by" value="${payload.by || state.user.name}"></div>
  </div>
  <div class="muted" style="margin-bottom:10px;">IN/OUT must be a positive quantity. ADJUSTMENT can be negative (e.g. -3) to reduce stock.</div>
  ${isEdit && payload.dnId ? `<div class="banner-warn">⚠ This entry was created automatically by issuing Delivery Note ${state.dns.find(d => d.id === payload.dnId)?.dnNumber || ''}. Editing it here only changes the stock ledger — it will not update the Delivery Note document itself.</div>` : ''}
  <div style="display:flex;justify-content:${isEdit ? 'space-between' : 'flex-end'};gap:8px;">
    ${isEdit ? `<button class="btn btn-danger" id="deleteMvBtn" type="button">Delete Entry</button>` : ''}
    <div style="display:flex;gap:8px;">
      <button class="btn btn-ghost" id="modalCancel">Cancel</button>
      <button class="btn btn-primary" id="saveMvBtn">${isEdit ? 'Save Changes' : 'Log Movement'}</button>
    </div>
  </div>
  `;
}

/* ---------------- Delivery note form / view ---------------- */
function renderDnForm(payload) {
  const lines = payload.lines || [{ itemId: '', qty: '' }];
  const location = payload.location || (state.branch !== 'All' ? state.branch : state.branches[0]);
  const sortedClients = [...state.clients].sort((a, b) => a.companyName.localeCompare(b.companyName));
  return `
  <div class="grid3">
    <div class="field"><label>Branch (issuing from)</label>
      <select id="dn_location">${state.branches.map(b => `<option ${location === b ? 'selected' : ''}>${b}</option>`).join('')}</select>
    </div>
    <div class="field"><label>Date</label><input type="date" id="dn_date" value="${payload.date || new Date().toISOString().slice(0, 10)}"></div>
    ${userPickerHtml('dnIssuedBy', payload.issuedBy||state.user?.name, '', 'Issued By')}
  </div>
  <div class="field"><label>Received By (optional, printed name)</label><input id="dn_receivedBy" value="${payload.receivedBy || ''}" placeholder="Name of person receiving goods"></div>

  <div class="field">
    <label>Quick-fill from Saved Client</label>
    <div style="display:flex;gap:8px;">
      <select id="dn_clientPick" style="flex:1;">
        <option value="">— Select a saved client (optional) —</option>
        ${sortedClients.map(c => `<option value="${c.id}" ${payload.clientId === c.id ? 'selected' : ''}>${c.companyName}</option>`).join('')}
      </select>
      <button class="btn btn-ghost btn-sm" id="quickAddClientBtn" type="button">+ New Client</button>
    </div>
  </div>
  <div class="grid2">
    <div class="field"><label>Client Company Name</label><input id="dn_clientCompany" value="${payload.clientCompany || ''}" placeholder="Client / company name"></div>
    <div class="field"><label>Contact Person</label><input id="dn_clientContact" value="${payload.clientContact || ''}"></div>
  </div>
  <div class="grid2">
    <div class="field"><label>Client Phone</label><input id="dn_clientPhone" value="${payload.clientPhone || ''}"></div>
    <div class="field"><label>Client Email</label><input id="dn_clientEmail" type="email" value="${payload.clientEmail || ''}"></div>
  </div>
  <div class="field"><label>Client Address</label><input id="dn_clientAddress" value="${payload.clientAddress || ''}"></div>

  <div class="grid3">
    <div class="field"><label>Project / Site</label><input id="dn_project" value="${payload.project || ''}" placeholder="Project reference"></div>
    <div class="field"><label>LPO #</label><input id="dn_lpoNumber" value="${payload.lpoNumber || ''}" placeholder="Client's LPO number"></div>
    <div class="field"><label>Invoice #</label><input id="dn_invoiceNumber" value="${payload.invoiceNumber || ''}" placeholder="Invoice number"></div>
  </div>

  <label>Items</label>
  <div id="dnLines">
    ${lines.map((ln, idx) => renderDnLine(ln, idx, location)).join('')}
  </div>
  <button class="btn btn-ghost btn-sm" id="addDnLineBtn" style="margin-bottom:14px;">+ Add Line</button>

  <div class="field"><label>Remarks</label><textarea id="dn_remarks" rows="2">${payload.remarks || ''}</textarea></div>

  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px;">
    <button class="btn btn-ghost" id="modalCancel">Cancel</button>
    <button class="btn btn-outline" id="saveDraftBtn">Save as Draft</button>
    <button class="btn btn-primary" id="issueDnBtn">Issue Delivery Note</button>
  </div>
  `;
}
function renderDnLine(ln, idx, location) {
  const items = state.items.filter(i => i.location === location);
  const it = findItem(ln.itemId);
  const avail = it ? it.qty : null;
  const warn = it && Number(ln.qty) > avail;
  return `
  <div class="line-item-row" data-line="${idx}">
    <div><select class="dnLineItem" data-idx="${idx}">
      <option value="">— Select item —</option>
      ${items.map(i => `<option value="${i.id}" ${ln.itemId === i.id ? 'selected' : ''}>${itemLabel(i)} (Avail: ${i.qty})</option>`).join('')}
    </select></div>
    <div><input class="dnLineUnit" value="${it ? it.unit : ''}" disabled placeholder="Unit"></div>
    <div><input type="number" class="dnLineQty" data-idx="${idx}" value="${ln.qty}" min="0.01" step="0.01"></div>
    <div class="muted" style="font-size:11px;">${it ? `Avail:<br><strong style="color:${warn ? 'var(--red)' : 'var(--green)'}">${avail}</strong>` : ''}</div>
    <div><button class="btn btn-ghost btn-sm removeDnLine" data-idx="${idx}" style="padding:6px 9px;">✕</button></div>
  </div>
  ${warn ? `<div class="stock-hint" style="color:var(--red);margin-top:-4px;">⚠ Only ${avail} in stock at ${location} — issuing will take this item negative.</div>` : ''}
  `;
}

function renderDnView(dn) {
  const rows = dn.items.map((ln, idx) => {
    const it = findItem(ln.itemId);
    return `<tr><td>${idx + 1}</td><td>${it ? it.description : '(item removed)'}</td><td>${it ? it.brand : ''}</td><td style="font-family:var(--mono)">${it ? it.partNo || '—' : ''}</td><td style="text-align:right;">${ln.qty}</td><td>${it ? it.unit : ''}</td></tr>`;
  }).join('');
  const co = state.company;
  return `
  <div id="printArea" class="dn-doc">
    <div class="dn-head">
      <div style="display:flex;gap:14px;align-items:center;justify-content:flex-start;">
        ${co.logoPath ? `<img src="${co.logoPath}" class="dn-logo" style="height:${logoSizePx(co.logoSize)}px;max-width:220px;object-fit:contain;" alt="${co.name} logo">` : ''}
        <div style="text-align:center;">
          <div class="dn-company">${co.name}</div>
        </div>
      </div>
      <div class="dn-title-block">
        <div class="dn-title">DELIVERY NOTE</div>
        <div class="dn-num">${dn.dnNumber}</div>
        <div class="muted">${dn.status === 'Issued' ? 'ISSUED' : 'DRAFT — NOT YET ISSUED'}</div>
      </div>
    </div>
    <div class="dn-meta">
      <div><div class="k">Date</div><div class="v">${fmtDate(dn.date)}</div></div>
      <div><div class="k">Issuing Branch</div><div class="v">${dn.location}</div></div>
      <div><div class="k">LPO #</div><div class="v">${dn.lpoNumber || '—'}</div></div>
      <div><div class="k">Invoice #</div><div class="v">${dn.invoiceNumber || '—'}</div></div>
      <div><div class="k">Project / Site</div><div class="v">${dn.project || '—'}</div></div>
      <div><div class="k">Issued By</div><div class="v">${dn.issuedBy || '—'}</div></div>
    </div>
    <div class="dn-meta" style="border-top:1px dashed var(--border);padding-top:14px;">
      <div>
        <div class="k">Deliver To</div>
        <div class="v">${dn.clientCompany || '—'}</div>
        ${dn.clientContact ? `<div class="muted" style="margin-top:2px;">Attn: ${dn.clientContact}</div>` : ''}
      </div>
      <div>
        <div class="k">Client Contact</div>
        <div class="v" style="font-weight:500;">${dn.clientPhone || ''}${dn.clientPhone && dn.clientEmail ? ' · ' : ''}${dn.clientEmail || ''}</div>
        ${dn.clientAddress ? `<div class="muted" style="margin-top:2px;">${dn.clientAddress}</div>` : ''}
      </div>
    </div>
    <table class="dn-table">
      <thead><tr><th>#</th><th>Description</th><th>Brand</th><th>Part No.</th><th style="text-align:right;">Qty</th><th>Unit</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${dn.remarks ? `<div style="margin-top:14px;font-size:13px;"><strong>Remarks:</strong> ${dn.remarks}</div>` : ''}
    <div class="dn-sign">
      <div class="sign-line">Issued By — ${dn.issuedBy || ''}</div>
      <div class="sign-line">Received By${dn.receivedBy ? ' — ' + dn.receivedBy : ''} (Signature &amp; Stamp)</div>
    </div>
    <div class="dn-terms">The undersigned hereby acknowledges receipt of the materials described herein in good condition, free from any apparent defects or damages. This confirmation serves as conclusive evidence that the materials have been delivered and accepted in satisfactory condition.</div>
    <div class="dn-footer-bar">
      <span>${co.address || ''}</span>
      <span>${co.phone || ''}</span>
      <span>${co.email || ''}</span>
    </div>
  </div>
  <div class="no-print" style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px;">
    <button class="btn btn-ghost" id="modalCancel">Close</button>
    ${dn.status !== 'Issued' && can('createDN') ? `<button class="btn btn-outline" id="editDraftBtn">Edit Draft</button><button class="btn btn-primary" id="issueFromViewBtn">Issue Now</button>` : ''}
    <button class="btn btn-teal" id="printDnBtn">Print / Save PDF</button>
  </div>
  `;
}

/* ---------------- Inventory print report ---------------- */
function printInventory() { openModal('invReport', {}); }
function renderInventoryReportView() {
  const items = visibleItems();
  const showPricing = shouldExportPricing();
  const co = state.company;
  const colspan = showPricing ? 11 : 8;
  const rows = items.map(it => `<tr>
    <td>${it.description}</td><td>${it.brand}</td><td style="font-family:var(--mono);font-size:11px;">${it.partNo || '—'}</td>
    <td>${it.location}</td><td>${it.unit}</td><td style="text-align:right;">${it.qty}</td><td style="text-align:right;">${it.minLevel}</td>
    ${showPricing ? `<td style="text-align:right;">${fmtMoney(it.cost)}</td><td style="text-align:right;">${fmtMoney(it.price)}</td><td style="text-align:right;">${fmtMoney(it.stockValue)}</td>` : ''}
    <td>${statusBadge(it.status)}</td>
  </tr>`).join('');
  return `
  <div id="printArea" class="dn-doc">
    <div class="dn-head">
      <div style="display:flex;gap:14px;align-items:center;">
        ${co.logoPath ? `<img src="${co.logoPath}" class="dn-logo" style="height:${logoSizePx(co.logoSize)}px;max-width:220px;object-fit:contain;" alt="logo">` : ''}
        <div>
          <div class="dn-company">${co.name}</div>
          <div class="dn-company-sub">${[co.address, co.phone, co.email].filter(Boolean).join(' · ')}</div>
        </div>
      </div>
      <div class="dn-title-block">
        <div class="dn-title">INVENTORY REPORT</div>
        <div class="muted">Exported ${new Date().toLocaleString('en-GB')}</div>
      </div>
    </div>
    <div class="muted" style="margin-bottom:12px;font-size:12px;">Filters applied: ${currentFilterSummary()} &nbsp;·&nbsp; ${items.length} item(s)</div>
    <table class="dn-table">
      <thead><tr><th>Description</th><th>Brand</th><th>Part No.</th><th>Branch</th><th>Unit</th><th style="text-align:right;">Qty</th><th style="text-align:right;">Min</th>
      ${showPricing ? `<th style="text-align:right;">Cost</th><th style="text-align:right;">Price</th><th style="text-align:right;">Stock Value</th>` : ''}
      <th>Status</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="${colspan}">No items match the current filters.</td></tr>`}</tbody>
    </table>
    ${companyFooterNote()}
  </div>
  <div class="no-print" style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px;">
    <button class="btn btn-ghost" id="modalCancel">Close</button>
    <button class="btn btn-teal" id="printReportBtn">Print</button>
  </div>
  `;
}

/* ================= EVENT HANDLING ================= */
function val(id) { const el = document.getElementById(id); return el ? el.value : ''; }

// Printing content that lives inside a deeply-nested modal (overlay > modal > printArea) is
// fragile with CSS visibility/position tricks alone — the overlay's own scroll/positioning
// can clip or truncate content, especially on documents long enough to span multiple pages.
// Instead, we clone the current #printArea into a fresh, top-level element with zero
// inherited styling, print that in isolation, then remove it.
function printDocument() {
  const source = document.getElementById('printArea');
  if (!source) { window.print(); return; }
  document.getElementById('printMount')?.remove();
  const mount = document.createElement('div');
  mount.id = 'printMount';
  mount.innerHTML = source.outerHTML;

  // Inject print-specific styles for delivery note fixes
  const style = document.createElement('style');
  style.textContent = `
    @media print {
      body > *:not(#printMount) { display: none !important; }
      #printMount { display: block !important; }
      @page { margin: 14mm 12mm; size: A4 portrait; }
    }
    #printMount .dn-doc {
      font-family: Arial, sans-serif;
      font-size: 13px;
      color: #0B2B36;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      position: relative;
    }
    #printMount .dn-footer-bar {
      margin-top: auto;
      padding-top: 10px;
      border-top: 1px solid #E1E6E8;
      display: flex;
      justify-content: space-between;
      font-size: 8px;
      color: #5B6B70;
    }
    #printMount .dn-footer-bar span { flex: 1; }
    #printMount .dn-footer-bar span:nth-child(2) { text-align: center; }
    #printMount .dn-footer-bar span:nth-child(3) { text-align: right; }
    #printMount .dn-footer-note { display: none !important; }
    #printMount .dn-terms {
      font-size: 11px;
      color: #5B6B70;
      margin-top: 14px;
      line-height: 1.5;
    }
    #printMount .dn-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid #00627B;
      padding-bottom: 12px;
      margin-bottom: 16px;
    }
    #printMount .dn-company {
      font-size: 15px;
      font-weight: 700;
      color: #00627B;
    }
    #printMount .dn-title-block { text-align: right; }
    #printMount .dn-title { font-size: 20px; font-weight: 700; color: #0B2B36; }
    #printMount .dn-num { font-size: 12px; font-weight: 700; color: #D96F24; }
  `;
  document.head.appendChild(style);
  document.body.appendChild(mount);
  window.print();
  const cleanup = () => {
    document.getElementById('printMount')?.remove();
    style.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  setTimeout(cleanup, 8000);
}

function attachHandlers() {
  document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', e => {
    setTab(e.currentTarget.getAttribute('data-tab'));
  }));

  // Sidebar group toggle
  document.querySelectorAll('[data-group]').forEach(b => b.addEventListener('click', e => {
    const g = e.currentTarget.getAttribute('data-group');
    state.sidebarOpen = state.sidebarOpen === g ? null : g;
    render();
  }));

  const mobileNavToggle = document.getElementById('mobileNavToggle');
  if (mobileNavToggle) mobileNavToggle.addEventListener('click', () => { state.mobileNavOpen = true; render(); });
  const mobileNavClose = document.getElementById('mobileNavClose');
  if (mobileNavClose) mobileNavClose.addEventListener('click', () => { state.mobileNavOpen = false; render(); });
  const mobileNavBackdrop = document.getElementById('mobileNavBackdrop');
  if (mobileNavBackdrop) mobileNavBackdrop.addEventListener('click', () => { state.mobileNavOpen = false; render(); });

  const bp = document.getElementById('branchPicker');
  if (bp) bp.addEventListener('change', e => { state.branch = e.target.value; render(); });

  const headerSettingsBtn = document.getElementById('headerSettingsBtn');
  if (headerSettingsBtn) headerSettingsBtn.addEventListener('click', () => setTab('settings'));
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', async () => {
    try { await api('POST', '/api/auth/logout'); } catch (e) {}
    authToken = null; localStorage.removeItem('af_token');
    state.user = null; state.loaded = false; state.tab = 'dashboard';
    render();
  });

  const newDnBtn = document.getElementById('newDnBtn');
  if (newDnBtn) newDnBtn.addEventListener('click', () => openModal('newDn', {}));
  const newDnBtn2 = document.getElementById('newDnBtn2');
  if (newDnBtn2) newDnBtn2.addEventListener('click', () => openModal('newDn', {}));

  const invSearch = document.getElementById('invSearch');
  if (invSearch) {
    invSearch.addEventListener('input', e => { state.search = e.target.value; renderInventoryOnly(); });
    invSearch.focus(); invSearch.setSelectionRange(invSearch.value.length, invSearch.value.length);
  }
  const invStatusFilter = document.getElementById('invStatusFilter');
  if (invStatusFilter) invStatusFilter.addEventListener('change', e => { state.invFilter = e.target.value; render(); });
  const addItemBtn = document.getElementById('addItemBtn');
  if (addItemBtn) addItemBtn.addEventListener('click', () => openModal('item', { location: state.branch !== 'All' ? state.branch : state.branches[0], unit: state.units[0], brand: state.brands[0] }));
  document.querySelectorAll('[data-edit-item]').forEach(b => b.addEventListener('click', e => {
    openModal('item', { ...findItem(e.currentTarget.getAttribute('data-edit-item')) });
  }));

  const exportPricingToggle = document.getElementById('exportPricingToggle');
  if (exportPricingToggle) exportPricingToggle.addEventListener('change', e => { state.exportIncludePricing = e.target.checked; render(); });
  const printInvBtn = document.getElementById('printInvBtn');
  if (printInvBtn) printInvBtn.addEventListener('click', printInventory);
  const exportExcelBtn = document.getElementById('exportExcelBtn');
  if (exportExcelBtn) exportExcelBtn.addEventListener('click', () => {
    const qs = new URLSearchParams({ branch: state.branch, status: state.invFilter, search: state.search, pricing: shouldExportPricing() ? '1' : '0' });
    apiDownload('/api/export/excel?' + qs.toString()).then(() => showToast('Excel file downloaded.', 'ok')).catch(err => showToast(err.message, 'err'));
  });
  const exportPdfBtn = document.getElementById('exportPdfBtn');
  if (exportPdfBtn) exportPdfBtn.addEventListener('click', () => {
    const qs = new URLSearchParams({ branch: state.branch, status: state.invFilter, search: state.search, pricing: shouldExportPricing() ? '1' : '0' });
    apiDownload('/api/export/pdf?' + qs.toString()).then(() => showToast('PDF downloaded.', 'ok')).catch(err => showToast(err.message, 'err'));
  });
  const printReportBtn = document.getElementById('printReportBtn');
  if (printReportBtn) printReportBtn.addEventListener('click', printDocument);

  const addMvBtn = document.getElementById('addMvBtn');
  if (addMvBtn) addMvBtn.addEventListener('click', () => openModal('movement', {}));
  document.querySelectorAll('[data-edit-mv]').forEach(b => b.addEventListener('click', e => {
    const mv = state.movements.find(m => m.id === e.currentTarget.getAttribute('data-edit-mv'));
    openModal('movement', { ...mv });
  }));

  document.querySelectorAll('[data-view-dn]').forEach(b => b.addEventListener('click', e => {
    openModal('viewDn', state.dns.find(d => d.id === e.currentTarget.getAttribute('data-view-dn')));
  }));

  // Work Reports
  const newWcrBtn = document.getElementById('newWcrBtn');
  if (newWcrBtn) newWcrBtn.addEventListener('click', () => openModal('newWcr', { tasks:[{workType:'',area:'',description:'',materials:'',status:'Completed'}] }));

  const newSnrBtn = document.getElementById('newSnrBtn');
  if (newSnrBtn) newSnrBtn.addEventListener('click', () => openModal('newSnr', {}));

  document.querySelectorAll('[data-view-wr]').forEach(b => b.addEventListener('click', e => {
    state.workReportView = e.currentTarget.getAttribute('data-view-wr');
    render();
  }));

  const printWrBtn = document.getElementById('printWrBtn');
  if (printWrBtn) printWrBtn.addEventListener('click', () => {
    const id = printWrBtn.getAttribute('data-id');
    const wr = state.workReports.find(r => r.id === id);
    if (!wr) return;
    const win = window.open('', '_blank');
    win.document.write(buildWcrPdf(wr));
    win.document.close();
    setTimeout(() => win.print(), 800);
  });

  document.querySelectorAll('[data-delete-wr]').forEach(b => b.addEventListener('click', async e => {
    const id = e.currentTarget.getAttribute('data-delete-wr');
    const wr = state.workReports.find(r => r.id === id);
    if (!wr || !confirm(`Delete ${wr.refNumber}? This cannot be undone.`)) return;
    try {
      await api('DELETE', '/api/work-reports/' + id);
      await loadAll();
      showToast('Report deleted.', 'ok');
      state.workReportView = null;
      render();
    } catch(e) { showToast(e.message, 'err'); }
  }));

  // WCR form handlers
  const addWcrTaskBtn = document.getElementById('addWcrTaskBtn');
  if (addWcrTaskBtn) addWcrTaskBtn.addEventListener('click', () => {
    const p = state.modal.payload;
    if (!p.tasks) p.tasks = [];
    p.tasks.push({workType:'',area:'',description:'',materials:'',status:'Completed'});
    render();
  });
  document.querySelectorAll('.removeWcrTaskBtn').forEach(b => b.addEventListener('click', e => {
    const idx = Number(e.currentTarget.getAttribute('data-idx'));
    const p = state.modal.payload;
    p.tasks.splice(idx, 1);
    render();
  }));

  const saveWcrBtn = document.getElementById('saveWcrBtn');
  if (saveWcrBtn) saveWcrBtn.addEventListener('click', async () => {
    const joId = document.getElementById('wcr_joId')?.value;
    if (!joId) { showToast('Please select a Job Order.', 'err'); return; }
    const tasks = [];
    document.querySelectorAll('[data-wcr-task]').forEach((row, i) => {
      tasks.push({
        workType:    row.querySelector('.wcr_task_type')?.value   || '',
        area:        row.querySelector('.wcr_task_area')?.value   || '',
        description: row.querySelector('.wcr_task_desc')?.value   || '',
        materials:   row.querySelector('.wcr_task_materials')?.value || '',
        status:      'Completed',
      });
    });
    const fd = new FormData();
    fd.append('jobOrderId',     joId);
    fd.append('date',           document.getElementById('wcr_date')?.value || '');
    fd.append('location',       document.getElementById('wcr_location')?.value || '');
    fd.append('technicianName', document.getElementById('wcr_tech')?.value || '');
    fd.append('supervisorName', document.getElementById('wcr_supervisor')?.value || '');
    fd.append('notes',          document.getElementById('wcr_notes')?.value || '');
    fd.append('status',         document.getElementById('wcr_status')?.value || 'Completed');
    fd.append('forClient',      document.getElementById('wcr_forClient')?.value || 'false');
    fd.append('tasks',          JSON.stringify(tasks));
    document.querySelectorAll('[data-wcr-task]').forEach((row, i) => {
      const bf = row.querySelector('.wcr_task_before')?.files[0];
      const af = row.querySelector('.wcr_task_after')?.files[0];
      if (bf) fd.append(`beforePhoto_${i}`, bf);
      if (af) fd.append(`afterPhoto_${i}`,  af);
    });
    try {
      const r   = await fetch('/api/work-reports/wcr', { method:'POST', headers:{'Authorization':`Bearer ${authToken}`}, body:fd });
      const d   = await r.json();
      if (!r.ok) throw new Error(d.error);
      await loadAll();
      showToast('Work Completion Report submitted.', 'ok');
      closeModal();
      state.workReportView = d.workReport.id;
      render();
    } catch(e) { showToast(e.message, 'err'); }
  });

  const saveSnrBtn = document.getElementById('saveSnrBtn');
  if (saveSnrBtn) saveSnrBtn.addEventListener('click', async () => {
    const joId = document.getElementById('snr_joId')?.value;
    if (!joId) { showToast('Please select a Job Order.', 'err'); return; }
    if (!document.getElementById('snr_subject')?.value?.trim()) { showToast('Subject is required.', 'err'); return; }
    const fd = new FormData();
    fd.append('jobOrderId',  joId);
    fd.append('subject',     document.getElementById('snr_subject')?.value || '');
    fd.append('workType',    document.getElementById('snr_workType')?.value || '');
    fd.append('location',    document.getElementById('snr_location')?.value || '');
    fd.append('date',        document.getElementById('snr_date')?.value || '');
    fd.append('time',        document.getElementById('snr_time')?.value || '');
    fd.append('description', document.getElementById('snr_desc')?.value || '');
    fd.append('technicianName', document.getElementById('snr_tech')?.value || '');
    fd.append('status',      document.getElementById('snr_status')?.value || 'Completed');
    fd.append('forClient',   document.getElementById('snr_forClient')?.value || 'false');
    const photo = document.getElementById('snr_photo')?.files[0];
    if (photo) fd.append('servicePhoto', photo);
    try {
      const r = await fetch('/api/work-reports/snr', { method:'POST', headers:{'Authorization':`Bearer ${authToken}`}, body:fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      await loadAll();
      showToast('Service Notification submitted.', 'ok');
      closeModal();
      state.workReportView = d.workReport.id;
      render();
    } catch(e) { showToast(e.message, 'err'); }
  });

  // Incident Reports
  const newIncidentBtn = document.getElementById('newIncidentBtn');
  if (newIncidentBtn) newIncidentBtn.addEventListener('click', () => openModal('newIncident', {}));

  document.querySelectorAll('[data-view-ir]').forEach(b => b.addEventListener('click', e => {
    state.incidentView = e.currentTarget.getAttribute('data-view-ir');
    render();
  }));

  const printIrBtn = document.getElementById('printIrBtn');
  if (printIrBtn) printIrBtn.addEventListener('click', () => {
    const id = printIrBtn.getAttribute('data-id');
    const ir = state.fmIncidents.find(r => r.id === id);
    if (!ir) return;
    const win = window.open('', '_blank');
    win.document.write(buildIrPdf(ir));
    win.document.close();
    setTimeout(() => win.print(), 800);
  });

  document.querySelectorAll('[data-delete-ir]').forEach(b => b.addEventListener('click', async e => {
    const id = e.currentTarget.getAttribute('data-delete-ir');
    const ir = state.fmIncidents.find(r => r.id === id);
    if (!ir || !confirm(`Delete ${ir.refNumber}? This cannot be undone.`)) return;
    try {
      await api('DELETE', '/api/incidents/' + id);
      await loadAll();
      showToast('Incident report deleted.', 'ok');
      state.incidentView = null;
      render();
    } catch(e) { showToast(e.message, 'err'); }
  }));

  const addRcBtn = document.getElementById('addRcBtn');
  if (addRcBtn) addRcBtn.addEventListener('click', () => {
    const div = document.createElement('div');
    div.className = 'rc-row';
    div.style.cssText = 'display:grid;grid-template-columns:2fr 1fr 1fr 1fr auto;gap:6px;margin-bottom:6px;';
    div.innerHTML = `
      <input placeholder="Risk control measure..." style="font-size:12px;">
      <input type="date" style="font-size:12px;">
      <input type="date" style="font-size:12px;">
      <input placeholder="Responsible person..." style="font-size:12px;">
      <button type="button" onclick="this.closest('.rc-row').remove()" style="background:none;border:none;color:#dc2626;cursor:pointer;font-size:16px;">✕</button>`;
    document.getElementById('rcRows')?.appendChild(div);
  });

  const saveIrBtn = document.getElementById('saveIrBtn');
  if (saveIrBtn) saveIrBtn.addEventListener('click', async () => {
    const joId = document.getElementById('ir_joId')?.value;
    if (!joId) { showToast('Please select a Job Order.', 'err'); return; }
    const desc = document.getElementById('ir_desc')?.value?.trim();
    if (!desc) { showToast('Description is required.', 'err'); return; }

    // Collect risk controls
    const riskControls = [];
    document.querySelectorAll('.rc-row').forEach(row => {
      const inputs = row.querySelectorAll('input');
      if (inputs[0]?.value?.trim()) {
        riskControls.push({ control: inputs[0].value.trim(), plannedDate: inputs[1]?.value||'', actualDate: inputs[2]?.value||'', responsibility: inputs[3]?.value?.trim()||'' });
      }
    });

    const prepVal = getUserPickerValue('irPreparedBy');
    const apprVal = getUserPickerValue('irApprovedBy');

    const fd = new FormData();
    fd.append('jobOrderId',         joId);
    fd.append('incidentType',       document.getElementById('ir_type')?.value||'Other');
    fd.append('severity',           document.getElementById('ir_severity')?.value||'Minor');
    fd.append('date',               document.getElementById('ir_date')?.value||'');
    fd.append('time',               document.getElementById('ir_time')?.value||'');
    fd.append('location',           document.getElementById('ir_location')?.value||'');
    fd.append('classification',     document.getElementById('ir_class')?.value||'');
    fd.append('typeDetails',        document.getElementById('ir_typeDetails')?.value||'');
    fd.append('material',           document.getElementById('ir_material')?.value||'');
    fd.append('extinguishingMedia', document.getElementById('ir_extMedia')?.value||'');
    fd.append('estimatedCost',      document.getElementById('ir_cost')?.value||'');
    fd.append('civilDefenseInformed', document.getElementById('ir_cdInformed')?.value||'false');
    fd.append('affectedPerson',     document.getElementById('ir_affectedPerson')?.value||'');
    fd.append('affectedDesignation',document.getElementById('ir_affectedDesig')?.value||'');
    fd.append('injuryType',         document.getElementById('ir_injuryType')?.value||'');
    fd.append('description',        desc);
    fd.append('immediateAction',    document.getElementById('ir_immediate')?.value||'');
    fd.append('correctiveAction',   document.getElementById('ir_corrective')?.value||'');
    fd.append('immediateCause',     document.getElementById('ir_immCause')?.value||'');
    fd.append('underlyingCause',    document.getElementById('ir_undCause')?.value||'');
    fd.append('rootCause',          document.getElementById('ir_rootCause')?.value||'');
    fd.append('supervisorName',     document.getElementById('ir_supervisor')?.value||'');
    fd.append('preparedByName',     prepVal.name||state.user?.name||'');
    fd.append('preparedByDesig',    prepVal.designation||'');
    fd.append('approvedByName',     apprVal.name||'');
    fd.append('approvedByDesig',    apprVal.designation||'');
    fd.append('riskControls',       JSON.stringify(riskControls));

    for (let i=0; i<5; i++) {
      const f = document.getElementById(`ir_photo_${i}`)?.files[0];
      if (f) fd.append(`photo_${i}`, f);
    }

    try {
      const r = await fetch('/api/incidents', { method:'POST', headers:{'Authorization':`Bearer ${authToken}`}, body:fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      await loadAll();
      showToast('Incident report submitted.', 'ok');
      closeModal();
      state.incidentView = d.incident.id;
      render();
    } catch(e) { showToast(e.message, 'err'); }
  });
  if (newFmClBtn) newFmClBtn.addEventListener('click', () => openModal('fmChecklist', {}));

  document.querySelectorAll('[data-view-fm-cl]').forEach(b => b.addEventListener('click', e => {
    state.fmChecklistView = e.currentTarget.getAttribute('data-view-fm-cl');
    render();
  }));

  const submitFmClBtn = document.getElementById('submitFmClBtn');
  if (submitFmClBtn) submitFmClBtn.addEventListener('click', async () => {
    const id = submitFmClBtn.getAttribute('data-id');
    if (!confirm('Submit this checklist? It will be marked as Submitted and locked.')) return;
    try {
      await api('PUT', '/api/fm-checklists/' + id, { submit: true });
      await loadAll();
      showToast('Checklist submitted.', 'ok');
      render();
    } catch(e) { showToast(e.message, 'err'); }
  });

  const printFmClBtn = document.getElementById('printFmClBtn');
  if (printFmClBtn) printFmClBtn.addEventListener('click', () => {
    const id = printFmClBtn.getAttribute('data-id');
    const cl = state.fmChecklists.find(c => c.id === id);
    if (!cl) return;
    const win = window.open('', '_blank');
    win.document.write(buildFmChecklistPdf(cl));
    win.document.close();
    setTimeout(() => win.print(), 600);
  });

  const addAbnBtn = document.getElementById('addAbnBtn');
  if (addAbnBtn) addAbnBtn.addEventListener('click', () => {
    const clId = addAbnBtn.getAttribute('data-id');
    openModal('addAbnormality', { clId });
  });

  const saveAbnBtn = document.getElementById('saveAbnBtn');
  if (saveAbnBtn) saveAbnBtn.addEventListener('click', async () => {
    const clId = saveAbnBtn.getAttribute('data-cl-id');
    const desc = document.getElementById('abn_desc')?.value?.trim();
    if (!desc) { showToast('Please describe the abnormality.', 'err'); return; }
    const cl = state.fmChecklists.find(c => c.id === clId);
    if (!cl) return;
    const entry = {
      date:         document.getElementById('abn_date')?.value || new Date().toISOString().slice(0,10),
      abnormality:  desc,
      actionTaken:  document.getElementById('abn_action')?.value?.trim() || '',
      status:       document.getElementById('abn_status')?.value || 'Open',
      doneBy:       document.getElementById('abn_doneBy')?.value?.trim() || state.user?.name || '',
    };
    cl.abnormalities = [...(cl.abnormalities||[]), entry];
    try {
      await api('PUT', '/api/fm-checklists/' + clId, { abnormalities: cl.abnormalities });
      await loadAll();
      showToast('Abnormality entry added.', 'ok');
      closeModal();
      state.fmChecklistView = clId;
      render();
    } catch(e) { showToast(e.message, 'err'); }
  });

  const saveFmClBtn = document.getElementById('saveFmClBtn');
  if (saveFmClBtn) saveFmClBtn.addEventListener('click', async () => {
    const joId  = document.getElementById('fm_joId')?.value;
    const tplId = document.getElementById('fm_tplId')?.value;
    if (!joId)  { showToast('Please select a Job Order.', 'err'); return; }
    if (!tplId) { showToast('Please select a checklist template.', 'err'); return; }
    try {
      const res = await api('POST', '/api/fm-checklists', {
        jobOrderId:     joId,
        templateId:     tplId,
        month:          document.getElementById('fm_month')?.value,
        location:       document.getElementById('fm_location')?.value,
        floor:          document.getElementById('fm_floor')?.value,
        technicianName: document.getElementById('fm_tech')?.value,
        supervisorName: document.getElementById('fm_supervisor')?.value,
      });
      await loadAll();
      showToast('Checklist created.', 'ok');
      closeModal();
      state.fmChecklistView = res.checklist.id;
      render();
    } catch(e) { showToast(e.message, 'err'); }
  });

  const addClientBtn = document.getElementById('addClientBtn');
  if (addClientBtn) addClientBtn.addEventListener('click', () => openModal('client', {}));
  document.querySelectorAll('[data-view-client]').forEach(b => b.addEventListener('click', e => {
    state.clientView = e.currentTarget.getAttribute('data-view-client');
    render();
  }));
  document.querySelectorAll('[data-edit-client]').forEach(b => b.addEventListener('click', e => {
    openModal('client', { ...state.clients.find(c => c.id === e.currentTarget.getAttribute('data-edit-client')) });
  }));

  const addVendorBtn = document.getElementById('addVendorBtn');
  if (addVendorBtn) addVendorBtn.addEventListener('click', () => openModal('vendor', {}));
  document.querySelectorAll('[data-edit-vendor]').forEach(b => b.addEventListener('click', e => {
    openModal('vendor', { ...findVendor(e.currentTarget.getAttribute('data-edit-vendor')) });
  }));

  const newQuoteBtn = document.getElementById('newQuoteBtn');
  if (newQuoteBtn) newQuoteBtn.addEventListener('click', () => openModal('newQuote', {}));
  const quoteStatusFilter = document.getElementById('quoteStatusFilter');
  if (quoteStatusFilter) quoteStatusFilter.addEventListener('change', e => { state.quoteFilter = e.target.value; render(); });
  const joStatusFilter = document.getElementById('joStatusFilter');
  if (joStatusFilter) joStatusFilter.addEventListener('change', e => { state.joFilter = e.target.value; render(); });
  const dnStatusFilter = document.getElementById('dnStatusFilter');
  if (dnStatusFilter) dnStatusFilter.addEventListener('change', e => { state.dnFilter = e.target.value; render(); });
  document.querySelectorAll('[data-view-quote]').forEach(b => b.addEventListener('click', e => {
    openModal('viewQuote', findQuote(e.currentTarget.getAttribute('data-view-quote')));
  }));
  document.querySelectorAll('[data-choose-quote-type]').forEach(b => b.addEventListener('click', e => {
    openModal('newQuote', { type: e.currentTarget.getAttribute('data-choose-quote-type'), lineItems: [], sitesCovered: [], exclusions: [] });
  }));

  document.querySelectorAll('[data-view-jo]').forEach(b => b.addEventListener('click', e => {
    openModal('viewJobOrder', findJobOrder(e.currentTarget.getAttribute('data-view-jo')));
  }));
  document.querySelectorAll('[data-view-mr]').forEach(b => b.addEventListener('click', e => {
    openModal('viewMr', findMaterialRequest(e.currentTarget.getAttribute('data-view-mr')));
  }));
  const newMrBtn = document.getElementById('newMrBtn');
  if (newMrBtn) newMrBtn.addEventListener('click', () => openModal('newMr', { lineItems: [] }));
  const newMrFromJoBtn = document.getElementById('newMrFromJoBtn');
  if (newMrFromJoBtn) newMrFromJoBtn.addEventListener('click', () => {
    const jo = state.modal.payload; // currently-open Job Order
    openModal('newMr', { jobOrderId: jo.id, lineItems: [] });
  });

  const procViewBtns = document.querySelectorAll('[data-proc-view]');
  procViewBtns.forEach(b => b.addEventListener('click', e => { state.procView = e.currentTarget.getAttribute('data-proc-view'); render(); }));

  document.querySelectorAll('[data-view-pr]').forEach(b => b.addEventListener('click', e => {
    openModal('viewPr', findPurchaseRequest(e.currentTarget.getAttribute('data-view-pr')));
  }));
  document.querySelectorAll('[data-view-po]').forEach(b => b.addEventListener('click', e => {
    openModal('viewPo', findPurchaseOrder(e.currentTarget.getAttribute('data-view-po')));
  }));
  const raisePrBtn = document.getElementById('raisePrBtn');
  if (raisePrBtn) raisePrBtn.addEventListener('click', () => {
    const mr = state.modal.payload; // currently-open Material Request
    const shortfallLines = mr.lineItems.map(l => {
      const it = findItem(l.itemId);
      const remaining = l.qtyRequested - l.qtyFulfilled;
      const avail = it ? it.qty : 0;
      const shortfall = remaining - avail;
      return shortfall > 0 ? { mrLineId: l.id, itemId: l.itemId, description: l.description, unit: l.unit, qty: shortfall } : null;
    }).filter(Boolean);
    openModal('newPr', { materialRequestId: mr.id, lineItems: shortfallLines });
  });

  const editSiteTeamBtn = document.getElementById('editSiteTeamBtn');
  if (editSiteTeamBtn) editSiteTeamBtn.addEventListener('click', () => {
    openModal('siteTeam', state.modal.payload); // currently-open Job Order
  });
  const newDrFromJoBtn = document.getElementById('newDrFromJoBtn');
  if (newDrFromJoBtn) newDrFromJoBtn.addEventListener('click', () => {
    const jo = state.modal.payload; // currently-open Job Order
    openModal('newDr', { jobOrderId: jo.id, delayItems: [] });
  });
  const drStatusFilter = document.getElementById('drStatusFilter');
  if (drStatusFilter) drStatusFilter.addEventListener('change', e => { state.drFilter = e.target.value; render(); });

  document.querySelectorAll('[data-view-dr]').forEach(b => b.addEventListener('click', e => {
    openModal('viewDr', findDelayReport(e.currentTarget.getAttribute('data-view-dr')));
  }));

  // PDF export — open print-ready view
  document.querySelectorAll('[data-pdf-dr]').forEach(b => b.addEventListener('click', e => {
    const dr = findDelayReport(e.currentTarget.getAttribute('data-pdf-dr'));
    if (!dr) return;
    const win = window.open('', '_blank');
    win.document.write(buildDrPdfHtml(dr));
    win.document.close();
    setTimeout(() => win.print(), 600);
  }));

  // Edit — open the new-report form pre-filled
  document.querySelectorAll('[data-edit-dr]').forEach(b => b.addEventListener('click', e => {
    const dr = findDelayReport(e.currentTarget.getAttribute('data-edit-dr'));
    if (!dr) return;
    closeModal();
    openModal('editDr', dr);
  }));

  // Delete — Super Admin only, confirm before deleting
  document.querySelectorAll('[data-delete-dr]').forEach(b => b.addEventListener('click', async e => {
    const id  = e.currentTarget.getAttribute('data-delete-dr');
    const dr  = findDelayReport(id);
    if (!dr) return;
    if (!confirm(`Delete delay report ${dr.refNumber}?\n\nThis cannot be undone.`)) return;
    try {
      await api('DELETE', '/api/delay-reports/' + id);
      await loadAll();
      showToast('Delay report deleted.', 'ok');
      closeModal();
    } catch(err) { showToast(err.message || 'Delete failed.', 'err'); }
  }));

  const newJoBtn = document.getElementById('newJoBtn');
  if (newJoBtn) newJoBtn.addEventListener('click', () => openModal('newJo', { type: 'SUP', status: 'Open' }));
  const editJoBtn = document.getElementById('editJoBtn');
  if (editJoBtn) editJoBtn.addEventListener('click', () => openModal('newJo', { ...state.modal.payload }));

  const openChangePwdBtn = document.getElementById('openChangePwdBtn');
  if (openChangePwdBtn) openChangePwdBtn.addEventListener('click', () => openModal('changePwd', {}));

  attachSettingsHandlers();

  const overlay = document.getElementById('modalOverlay');
  if (overlay) overlay.addEventListener('mousedown', e => { if (e.target.id === 'modalOverlay' && state.modal?.type !== 'forcePwd') closeModal(); });
  const modalClose = document.getElementById('modalClose');
  if (modalClose && state.modal?.type !== 'forcePwd') modalClose.addEventListener('click', closeModal);
  const modalCancel = document.getElementById('modalCancel');
  if (modalCancel) modalCancel.addEventListener('click', closeModal);

  attachItemFormHandlers();
  attachMovementFormHandlers();
  attachDnFormHandlers();
  attachDnViewHandlers();
  attachClientFormHandlers();
  attachVendorFormHandlers();
  attachUserFormHandlers();
  attachPwdFormHandlers();
  attachQuoteFormHandlers();
  attachQuoteViewHandlers();
  attachExclusionsLibraryHandlers();
  attachMrFormHandlers();
  attachMrViewHandlers();
  attachPrFormHandlers();
  attachPrViewHandlers();
  attachPoFormHandlers();
  attachPoViewHandlers();
  attachSiteTeamFormHandlers();
  attachJoFormHandlers();
  attachDrFormHandlers();
}

function renderInventoryOnly() {
  const mainInner = document.querySelector('.main');
  mainInner.querySelector('.topbar').outerHTML = renderTopbar();
  mainInner.querySelectorAll('.toolbar, .card').forEach(el => el.remove());
  mainInner.insertAdjacentHTML('beforeend', renderInventory());
  attachHandlers();
  const invSearch = document.getElementById('invSearch');
  if (invSearch) { invSearch.focus(); invSearch.setSelectionRange(invSearch.value.length, invSearch.value.length); }
}

/* ---- Item form ---- */
function attachItemFormHandlers() {
  const saveBtn = document.getElementById('saveItemBtn');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const desc = val('f_description').trim();
    if (!desc) { showToast('Item description is required.', 'err'); return; }
    const existing = state.modal.payload.id;
    const body = {
      brand: val('f_brand'), partNo: val('f_partNo').trim(), description: desc,
      location: val('f_location'), unit: val('f_unit'), minLevel: Number(val('f_minLevel') || 0),
      openingQty: Number(val('f_openingQty') || 0),
    };
    if (can('editPricing')) { body.cost = Number(val('f_cost') || 0); body.price = Number(val('f_price') || 0); }
    try {
      if (existing) await api('PUT', '/api/items/' + existing, body);
      else await api('POST', '/api/items', body);
      await loadAll();
      showToast(existing ? 'Item updated.' : 'Item added.', 'ok');
      closeModal(); setTab('inventory');
    } catch (e) { showToast(e.message, 'err'); }
  });
  const delBtn = document.getElementById('deleteItemBtn');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm('Delete this item? Its movement history will remain but will no longer link to an item.')) return;
    try {
      await api('DELETE', '/api/items/' + state.modal.payload.id);
      await loadAll();
      showToast('Item deleted.', 'ok');
      closeModal(); setTab('inventory');
    } catch (e) { showToast(e.message, 'err'); }
  });
}

/* ---- Movement form ---- */
function attachMovementFormHandlers() {
  const saveMvBtn = document.getElementById('saveMvBtn');
  if (saveMvBtn) saveMvBtn.addEventListener('click', async () => {
    const itemId = val('mv_item'), action = val('mv_action'), qty = Number(val('mv_qty'));
    if (!itemId) { showToast('Please select an item.', 'err'); return; }
    if (!qty || (action !== 'ADJUSTMENT' && qty <= 0)) { showToast('Enter a valid quantity.', 'err'); return; }
    const isEdit = !!state.modal.payload.id;
    try {
      const body = { itemId, action, qty, date: val('mv_date'), reference: val('mv_ref').trim(), by: val('mv_by').trim() };
      if (isEdit) await api('PUT', '/api/movements/' + state.modal.payload.id, body);
      else await api('POST', '/api/movements', body);
      await loadAll();
      showToast(isEdit ? 'Movement updated — Qty On Hand recalculated.' : 'Movement logged — Qty On Hand updated.', 'ok');
      closeModal(); setTab('movements');
    } catch (e) { showToast(e.message, 'err'); }
  });
  const deleteMvBtn = document.getElementById('deleteMvBtn');
  if (deleteMvBtn) deleteMvBtn.addEventListener('click', async () => {
    if (!confirm('Permanently delete this stock movement entry? This directly rewrites stock history and cannot be undone.')) return;
    try {
      await api('DELETE', '/api/movements/' + state.modal.payload.id);
      await loadAll();
      showToast('Movement deleted — Qty On Hand recalculated.', 'ok');
      closeModal(); setTab('movements');
    } catch (e) { showToast(e.message, 'err'); }
  });
}

/* ---- DN form ---- */
function syncDnPayload(p) {
  p.location = val('dn_location'); p.date = val('dn_date');
  p.clientId = val('dn_clientPick') || p.clientId || null;
  p.clientCompany = val('dn_clientCompany'); p.clientContact = val('dn_clientContact');
  p.clientPhone = val('dn_clientPhone'); p.clientEmail = val('dn_clientEmail'); p.clientAddress = val('dn_clientAddress');
  p.project = val('dn_project'); p.lpoNumber = val('dn_lpoNumber'); p.invoiceNumber = val('dn_invoiceNumber');
  p.issuedBy = getUserPickerValue('dnIssuedBy').name || val('dnIssuedBy_name') || state.user?.name; p.receivedBy = val('dn_receivedBy'); p.remarks = val('dn_remarks');
}
function attachDnFormHandlers() {
  const addLineBtn = document.getElementById('addDnLineBtn');
  if (addLineBtn) addLineBtn.addEventListener('click', () => {
    const p = state.modal.payload; p.lines = collectDnLines(); p.lines.push({ itemId: '', qty: '' }); syncDnPayload(p); render();
  });
  document.querySelectorAll('.removeDnLine').forEach(b => b.addEventListener('click', e => {
    const idx = Number(e.currentTarget.getAttribute('data-idx'));
    const p = state.modal.payload; p.lines = collectDnLines(); p.lines.splice(idx, 1);
    if (p.lines.length === 0) p.lines.push({ itemId: '', qty: '' });
    syncDnPayload(p); render();
  }));
  document.querySelectorAll('.dnLineItem').forEach(s => s.addEventListener('change', () => {
    const p = state.modal.payload; p.lines = collectDnLines(); syncDnPayload(p); render();
  }));
  const locSel = document.getElementById('dn_location');
  if (locSel) locSel.addEventListener('change', () => {
    const p = state.modal.payload; p.lines = [{ itemId: '', qty: '' }]; syncDnPayload(p); render();
  });
  const clientPick = document.getElementById('dn_clientPick');
  if (clientPick) clientPick.addEventListener('change', e => {
    const p = state.modal.payload; p.lines = collectDnLines(); syncDnPayload(p);
    const c = state.clients.find(cl => cl.id === e.target.value);
    if (c) { p.clientId = c.id; p.clientCompany = c.companyName; p.clientContact = c.contactPerson; p.clientPhone = c.phone; p.clientEmail = c.email; p.clientAddress = c.address; }
    render();
  });
  const quickAddClientBtn = document.getElementById('quickAddClientBtn');
  if (quickAddClientBtn) quickAddClientBtn.addEventListener('click', () => {
    const p = state.modal.payload; p.lines = collectDnLines(); syncDnPayload(p);
    openModal('client', { fromDn: p });
  });
  const saveDraftBtn = document.getElementById('saveDraftBtn');
  if (saveDraftBtn) saveDraftBtn.addEventListener('click', () => submitDn(false));
  const issueBtn = document.getElementById('issueDnBtn');
  if (issueBtn) issueBtn.addEventListener('click', () => submitDn(true));
}
function collectDnLines() {
  const lines = [];
  document.querySelectorAll('.dnLineItem').forEach(sel => {
    const idx = Number(sel.getAttribute('data-idx'));
    const qtyEl = document.querySelector(`.dnLineQty[data-idx="${idx}"]`);
    const raw = qtyEl ? qtyEl.value : '';
    lines.push({ itemId: sel.value, qty: raw === '' ? '' : Number(raw) });
  });
  return lines;
}
async function submitDn(issue) {
  const lines = collectDnLines().filter(l => l.itemId && l.qty > 0);
  if (lines.length === 0) { showToast('Add at least one item line.', 'err'); return; }
  const body = {
    date: val('dn_date'), clientId: val('dn_clientPick') || state.modal.payload.clientId || null,
    clientCompany: val('dn_clientCompany').trim(), clientContact: val('dn_clientContact').trim(),
    clientPhone: val('dn_clientPhone').trim(), clientEmail: val('dn_clientEmail').trim(), clientAddress: val('dn_clientAddress').trim(),
    project: val('dn_project').trim(), lpoNumber: val('dn_lpoNumber').trim(), invoiceNumber: val('dn_invoiceNumber').trim(),
    location: val('dn_location'), issuedBy: (getUserPickerValue('dnIssuedBy').name || state.user?.name || '').trim(), receivedBy: val('dn_receivedBy').trim(),
    remarks: val('dn_remarks').trim(), items: lines, issue,
  };
  try {
    const existingId = state.modal.payload.id;
    let dn;
    if (existingId) {
      await api('PUT', '/api/dns/' + existingId, body);
      dn = (await api('GET', '/api/dns/' + existingId)).dn;
      if (issue) dn = (await api('POST', `/api/dns/${existingId}/issue`)).dn;
    } else {
      dn = (await api('POST', '/api/dns', body)).dn;
    }
    await loadAll();
    showToast(issue ? 'Delivery note issued — stock updated.' : 'Draft saved.', 'ok');
    closeModal();
    openModal('viewDn', state.dns.find(d => d.id === dn.id) || dn);
  } catch (e) { showToast(e.message, 'err'); }
}

function attachDnViewHandlers() {
  const printBtn = document.getElementById('printDnBtn');
  if (printBtn) printBtn.addEventListener('click', printDocument);
  const editBtn = document.getElementById('editDraftBtn');
  if (editBtn) editBtn.addEventListener('click', () => {
    const dn = state.modal.payload; openModal('newDn', { ...dn, lines: dn.items });
  });
  const issueFromViewBtn = document.getElementById('issueFromViewBtn');
  if (issueFromViewBtn) issueFromViewBtn.addEventListener('click', async () => {
    const dn = state.modal.payload;
    try {
      const res = await api('POST', `/api/dns/${dn.id}/issue`);
      await loadAll();
      showToast('Delivery note issued — stock updated.', 'ok');
      openModal('viewDn', res.dn);
    } catch (e) { showToast(e.message, 'err'); }
  });
}

/* ---- Client form ---- */
function attachClientFormHandlers() {
  const saveBtn = document.getElementById('saveClientBtn');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const companyName = val('c_companyName').trim();
    if (!companyName) { showToast('Company name is required.', 'err'); return; }
    const existing = state.modal.payload.id;
    const body = { companyName, contactPerson: val('c_contactPerson').trim(), phone: val('c_phone').trim(), email: val('c_email').trim(), address: val('c_address').trim(), trn: val('c_trn').trim(), notes: val('c_notes').trim() };
    try {
      let client;
      if (existing) client = (await api('PUT', '/api/clients/' + existing, body)).client;
      else client = (await api('POST', '/api/clients', body)).client;
      await loadAll();
      const fromDn = state.modal.payload.fromDn;
      showToast(existing ? 'Client updated.' : 'Client added.', 'ok');
      if (fromDn) {
        fromDn.clientId = client.id; fromDn.clientCompany = client.companyName; fromDn.clientContact = client.contactPerson;
        fromDn.clientPhone = client.phone; fromDn.clientEmail = client.email; fromDn.clientAddress = client.address;
        openModal('newDn', fromDn);
      } else { closeModal(); setTab('clients'); }
    } catch (e) { showToast(e.message, 'err'); }
  });
  const delBtn = document.getElementById('deleteClientBtn');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm('Delete this client? Past delivery notes keep their own copy of the client details.')) return;
    try {
      await api('DELETE', '/api/clients/' + state.modal.payload.id);
      await loadAll();
      showToast('Client deleted.', 'ok');
      closeModal(); setTab('clients');
    } catch (e) { showToast(e.message, 'err'); }
  });
}

function attachVendorFormHandlers() {
  const saveBtn = document.getElementById('saveVendorBtn');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const companyName = val('v_companyName').trim();
    if (!companyName) { showToast('Company name is required.', 'err'); return; }
    const existing = state.modal.payload.id;
    const body = { companyName, contactPerson: val('v_contactPerson').trim(), phone: val('v_phone').trim(), email: val('v_email').trim(), address: val('v_address').trim() };
    try {
      if (existing) await api('PUT', '/api/vendors/' + existing, body);
      else await api('POST', '/api/vendors', body);
      await loadAll();
      showToast(existing ? 'Vendor updated.' : 'Vendor added.', 'ok');
      closeModal(); setTab('vendors');
    } catch (e) { showToast(e.message, 'err'); }
  });
  const delBtn = document.getElementById('deleteVendorBtn');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm('Delete this vendor?')) return;
    try {
      await api('DELETE', '/api/vendors/' + state.modal.payload.id);
      await loadAll();
      showToast('Vendor deleted.', 'ok');
      closeModal(); setTab('vendors');
    } catch (e) { showToast(e.message, 'err'); }
  });
}

/* ---- User form ---- */
function attachUserFormHandlers() {
  const saveBtn = document.getElementById('saveUserBtn');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const name = val('u_name').trim();
    if (!name) { showToast('Name is required.', 'err'); return; }
    const existing = state.modal.payload.id;
    const designation = val('u_designation').trim();
    try {
      if (existing) {
        const body = { name, designation, role: val('u_role'), active: val('u_active') === 'true' };
        const newPwd = val('u_newPassword');
        if (newPwd) body.password = newPwd;
        await api('PUT', '/api/users/' + existing, body);
      } else {
        const username = val('u_username').trim();
        const password = val('u_password');
        if (!username || !password) { showToast('Username and temporary password are required.', 'err'); return; }
        await api('POST', '/api/users', { name, username, password, designation, role: val('u_role'), active: val('u_active') === 'true' });
      }
      await loadAll();
      showToast(existing ? 'User updated.' : 'User added.', 'ok');
      closeModal(); setTab('settings');
    } catch (e) { showToast(e.message, 'err'); }
  });
  const delBtn = document.getElementById('deleteUserBtn');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm('Delete this user? They will no longer be able to sign in.')) return;
    try {
      await api('DELETE', '/api/users/' + state.modal.payload.id);
      await loadAll();
      showToast('User deleted.', 'ok');
      closeModal(); setTab('settings');
    } catch (e) { showToast(e.message, 'err'); }
  });
}

/* ---- Password forms ---- */
function attachPwdFormHandlers() {
  const btn = document.getElementById('savePwdBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const current = val('pwd_current'), next = val('pwd_new'), confirmPwd = val('pwd_confirm');
    const errBox = document.getElementById('pwdErr');
    errBox.innerHTML = '';
    if (next.length < 6) { errBox.innerHTML = `<div class="login-err">New password must be at least 6 characters.</div>`; return; }
    if (next !== confirmPwd) { errBox.innerHTML = `<div class="login-err">Passwords do not match.</div>`; return; }
    try {
      await api('POST', '/api/auth/change-password', { currentPassword: current, newPassword: next });
      state.user.mustChangePassword = false;
      showToast('Password updated.', 'ok');
      closeModal();
    } catch (e) { errBox.innerHTML = `<div class="login-err">${e.message}</div>`; }
  });
}

/* ---- Quotation form handlers ---- */
function currentQuotePayload() {
  return state.modal.payload;
}

function readStandardLinesFromDom() {
  const cards = document.querySelectorAll('[data-quote-line]');
  const lines = [];
  cards.forEach(card => {
    const idx = card.getAttribute('data-quote-line');
    const desc = card.querySelector('.qlDescription').value;
    const category = card.querySelector('.qlCategory').value;
    const itemId = card.querySelector('.qlInventoryPick').value || null;
    const brand = card.querySelector('.qlBrand').value;
    const unit = card.querySelector('.qlUnit').value;
    const qty = Number(card.querySelector('.qlQty').value || 0);
    const unitPrice = Number(card.querySelector('.qlPrice').value || 0);
    lines.push({ description: desc, category, itemId, brand, unit, qty, unitPrice });
  });
  return lines;
}
function readSitesFromDom() {
  const rows = document.querySelectorAll('[data-site-row]');
  const sites = [];
  rows.forEach(row => {
    const idx = row.getAttribute('data-site-row');
    const name = row.querySelector('.siteNameInput').value;
    const reference = row.querySelector('.siteRefInput').value;
    const notes = row.querySelector('.siteNotesInput').value;
    if (name.trim()) sites.push({ id: uid('site'), name, reference, notes });
  });
  return sites;
}
function readAmcServicesFromDom() {
  const rows = document.querySelectorAll('#amcServicesList > div');
  const services = [];
  rows.forEach(row => {
    const description = row.querySelector('.amcSvcDesc')?.value;
    const qty = Number(row.querySelector('.amcSvcQty')?.value || 0);
    const unitPrice = Number(row.querySelector('.amcSvcPrice')?.value || 0);
    if (description !== undefined) services.push({ description, qty, unitPrice });
  });
  return services;
}
function readAmcManpowerFromDom() {
  const rows = document.querySelectorAll('#amcManpowerList > div');
  const manpower = [];
  rows.forEach(row => {
    const role = row.querySelector('.amcMpRole')?.value;
    const qty = Number(row.querySelector('.amcMpQty')?.value || 0);
    if (role !== undefined) manpower.push({ role, qty });
  });
  return manpower;
}

// Pulls every editable field out of the current DOM into the modal payload — called before
// any add/remove-row action or save, so in-progress edits are never lost on re-render.
function syncQuoteFormIntoPayload() {
  const p = state.modal.payload;
  if (!p.type) return;
  p.clientId = val('quoteClientPick') || p.clientId || null;
  p.clientCompany = val('quoteClientCompany');
  p.clientAttn = val('quoteClientAttn');
  p.clientContact = val('quoteClientContact');
  p.clientEmail = val('quoteClientEmail');
  p.clientPoBox = val('quoteClientPoBox');
  p.subject = val('quoteSubject');
  p.siteDetail = val('quoteSiteDetail');
  p.date = val('quoteDate') || p.date;
  p.validityDays = Number(val('quoteValidityDays') || 15);
  p.sitesCovered = readSitesFromDom();
  p.paymentTerms = val('quotePaymentTerms');
  p.notes = val('quoteNotes');
  p.discount = Number(val('quoteDiscount') || 0);
  // Prepared By / Approved By — Super Admin can override, others default to their own name
  const prepVal = getUserPickerValue('quotePreparedBy');
  const apprVal = getUserPickerValue('quoteApprovedBy');
  // Only update if picker has a value — don't fall back to state.user which would override selection
  if (prepVal.name) {
    p.preparedByName        = prepVal.name;
    p.preparedByDesignation = prepVal.designation;
  } else if (!p.preparedByName) {
    p.preparedByName        = state.user?.name        || '';
    p.preparedByDesignation = state.user?.designation || '';
  }
  if (apprVal.name) {
    p.approvedByName        = apprVal.name;
    p.approvedByDesignation = apprVal.designation;
  }
  // exclusions are managed directly on p.exclusions via add/remove buttons — preserve them
  if (!Array.isArray(p.exclusions)) p.exclusions = [];
  if (p.type === 'AMC') {
    p.amc = p.amc || {};
    p.amc.scopeOfAgreement = val('amcScope');
    p.amc.contractStart = val('amcStart');
    p.amc.contractEnd = val('amcEnd');
    p.amc.maintenanceSchedule = val('amcSchedule') || 'Quarterly';
    p.amc.services = readAmcServicesFromDom();
    p.amc.manpower = readAmcManpowerFromDom();
  } else {
    p.lineItems = readStandardLinesFromDom();
  }
}

// Recomputes and patches ONLY the line-total and totals-box numbers directly in the DOM,
// reading current input values live. Deliberately does not call render() or touch payload —
// this runs on every keystroke, so it must never replace any DOM node the user might be
// focused in or tabbing through.
function updateQuoteLiveTotals() {
  const cur = state.company.currency;
  let subtotal = 0;
  document.querySelectorAll('.quote-line-card').forEach(card => {
    const qty = Number(card.querySelector('.qlQty')?.value || 0);
    const price = Number(card.querySelector('.qlPrice')?.value || 0);
    const t = qty * price;
    subtotal += t;
    const totalField = card.querySelector('.qlLineTotal');
    if (totalField) totalField.value = `${cur} ${fmtMoney(t)}`;
  });
  document.querySelectorAll('#amcServicesList > div').forEach(row => {
    const qty = Number(row.querySelector('.amcSvcQty')?.value || 0);
    const price = Number(row.querySelector('.amcSvcPrice')?.value || 0);
    subtotal += qty * price;
  });
  const discount = Number(document.getElementById('quoteDiscount')?.value || 0);
  const taxable = Math.max(0, subtotal - discount);
  const showVat = state.modal.payload.showVat !== false;
  const vat = showVat ? taxable * 0.05 : 0;
  const total = taxable + vat;
  const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  setText('totSubtotal', `${cur} ${fmtMoney(subtotal)}`);
  setText('totTaxable', `${cur} ${fmtMoney(taxable)}`);
  setText('totVat', `${cur} ${fmtMoney(vat)}`);
  setText('totTotal', `${cur} ${fmtMoney(total)}`);
}

function attachQuoteFormHandlers() {
  if (!state.modal || (state.modal.type !== 'newQuote')) return;
  const p = state.modal.payload;
  if (!p.type) return; // type-chooser screen, nothing to wire yet

  // Client quick-fill
  const clientPick = document.getElementById('quoteClientPick');
  if (clientPick) clientPick.addEventListener('change', e => {
    syncQuoteFormIntoPayload();
    const c = state.clients.find(cl => cl.id === e.target.value);
    if (c) { p.clientId = c.id; p.clientCompany = c.companyName; p.clientAttn = c.contactPerson; p.clientContact = c.phone; p.clientEmail = c.email; }
    render();
  });

  // Sites Covered
  const addSiteBtn = document.getElementById('addSiteBtn');
  if (addSiteBtn) addSiteBtn.addEventListener('click', () => {
    syncQuoteFormIntoPayload();
    p.sitesCovered = [...(p.sitesCovered || []), { id: uid('site'), name: '', reference: '', notes: '' }];
    render();
  });
  document.querySelectorAll('.removeSiteBtn').forEach(b => b.addEventListener('click', e => {
    syncQuoteFormIntoPayload();
    const idx = Number(e.currentTarget.getAttribute('data-idx'));
    p.sitesCovered.splice(idx, 1);
    render();
  }));

  // Standard line items (SUP / PR / FO)
  const addLineBtn = document.getElementById('addQuoteLineBtn');
  if (addLineBtn) addLineBtn.addEventListener('click', () => {
    syncQuoteFormIntoPayload();
    p.lineItems = [...(p.lineItems || []), { description: '', category: state.quotationCategories[0], unit: state.units[0], qty: '', unitPrice: '' }];
    render();
  });
  document.querySelectorAll('.removeQuoteLineBtn').forEach(b => b.addEventListener('click', e => {
    syncQuoteFormIntoPayload();
    const idx = Number(e.currentTarget.getAttribute('data-idx'));
    p.lineItems.splice(idx, 1);
    render();
  }));
  document.querySelectorAll('.qlInventoryPick').forEach(sel => sel.addEventListener('change', e => {
    syncQuoteFormIntoPayload();
    const idx = Number(e.currentTarget.getAttribute('data-idx'));
    const it = findItem(e.target.value);
    if (it) {
      p.lineItems[idx].itemId = it.id; p.lineItems[idx].description = it.description;
      p.lineItems[idx].brand = it.brand; p.lineItems[idx].unit = it.unit;
      if (can('viewPricing') && it.price) p.lineItems[idx].unitPrice = it.price;
    } else { p.lineItems[idx].itemId = null; }
    render();
  }));
  // Qty/price/discount are live-typed fields — updating totals here must NEVER trigger a full
  // render(), or a mid-render DOM swap can steal focus and drop keystrokes (verified bug: Tab
  // navigation between fields lost input when this used to sync+render on every change).
  // Instead we recompute and patch just the numbers that need to move, in place.
  document.querySelectorAll('.qlQty, .qlPrice').forEach(el => {
    el.addEventListener('input', updateQuoteLiveTotals);
  });
  document.querySelectorAll('.qlDescription, .qlBrand, .qlCategory, .qlUnit').forEach(el => {
    el.addEventListener('change', () => { syncQuoteFormIntoPayload(); }); // sync only, no re-render needed — nothing else depends on these
  });

  // AMC services
  const addAmcSvcBtn = document.getElementById('addAmcSvcBtn');
  if (addAmcSvcBtn) addAmcSvcBtn.addEventListener('click', () => {
    syncQuoteFormIntoPayload();
    p.amc.services = [...(p.amc.services || []), { description: '', qty: '', unitPrice: '' }];
    render();
  });
  document.querySelectorAll('.removeAmcSvcBtn').forEach(b => b.addEventListener('click', e => {
    syncQuoteFormIntoPayload();
    const idx = Number(e.currentTarget.getAttribute('data-idx'));
    p.amc.services.splice(idx, 1);
    render();
  }));
  document.querySelectorAll('.amcSvcQty, .amcSvcPrice').forEach(el => {
    el.addEventListener('input', updateQuoteLiveTotals);
  });
  document.querySelectorAll('.amcSvcDesc').forEach(el => {
    el.addEventListener('change', () => { syncQuoteFormIntoPayload(); });
  });

  // AMC manpower
  const addAmcMpBtn = document.getElementById('addAmcMpBtn');
  if (addAmcMpBtn) addAmcMpBtn.addEventListener('click', () => {
    syncQuoteFormIntoPayload();
    p.amc.manpower = [...(p.amc.manpower || []), { role: '', qty: '' }];
    render();
  });
  document.querySelectorAll('.removeAmcMpBtn').forEach(b => b.addEventListener('click', e => {
    syncQuoteFormIntoPayload();
    const idx = Number(e.currentTarget.getAttribute('data-idx'));
    p.amc.manpower.splice(idx, 1);
    render();
  }));

  // Exclusions
  const addExclFromLibBtn = document.getElementById('addExclFromLibBtn');
  if (addExclFromLibBtn) addExclFromLibBtn.addEventListener('click', () => {
    syncQuoteFormIntoPayload();
    const id = val('exclusionLibraryPick');
    const item = state.exclusionsLibrary.find(e => e.id === id);
    if (item && !p.exclusions.includes(item.text)) p.exclusions = [...p.exclusions, item.text];
    render();
  });
  const addCustomExclBtn = document.getElementById('addCustomExclBtn');
  if (addCustomExclBtn) addCustomExclBtn.addEventListener('click', () => {
    syncQuoteFormIntoPayload();
    const text = val('customExclusionInput').trim();
    if (text) p.exclusions = [...p.exclusions, text];
    render();
  });
  document.querySelectorAll('.removeExclBtn').forEach(b => b.addEventListener('click', e => {
    syncQuoteFormIntoPayload();
    const idx = Number(e.currentTarget.getAttribute('data-idx'));
    p.exclusions.splice(idx, 1);
    render();
  }));

  // Discount live update (recalculate totals box on change)
  const discountInput = document.getElementById('quoteDiscount');
  if (discountInput) discountInput.addEventListener('input', updateQuoteLiveTotals);

  // Save / Delete
  const saveDraftBtn = document.getElementById('saveQuoteDraftBtn');
  if (saveDraftBtn) saveDraftBtn.addEventListener('click', async () => {
    syncQuoteFormIntoPayload();
    // Read picker values directly at save time
    const prepVal = getUserPickerValue('quotePreparedBy');
    const apprVal = getUserPickerValue('quoteApprovedBy');
    if (prepVal.name) { p.preparedByName = prepVal.name; p.preparedByDesignation = prepVal.designation; }
    else if (!p.preparedByName) { p.preparedByName = state.user?.name || ''; p.preparedByDesignation = state.user?.designation || ''; }
    if (apprVal.name) { p.approvedByName = apprVal.name; p.approvedByDesignation = apprVal.designation; }
    if (!p.clientCompany || !p.clientCompany.trim()) { showToast('Client company name is required.', 'err'); return; }
    const body = { ...p };
    try {
      let saved;
      if (p.id) saved = (await api('PUT', '/api/quotations/' + p.id, body)).quotation;
      else saved = (await api('POST', '/api/quotations', body)).quotation;
      await loadAll();
      showToast('Draft saved.', 'ok');
      closeModal();
      openModal('viewQuote', findQuote(saved.id));
    } catch (e) { showToast(e.message, 'err'); }
  });
  const deleteQuoteBtn = document.getElementById('deleteQuoteBtn');
  if (deleteQuoteBtn) deleteQuoteBtn.addEventListener('click', async () => {
    if (!confirm('Delete this draft quotation? This cannot be undone.')) return;
    try {
      await api('DELETE', '/api/quotations/' + p.id);
      await loadAll();
      showToast('Draft deleted.', 'ok');
      closeModal(); setTab('quotations');
    } catch (e) { showToast(e.message, 'err'); }
  });
}

/* ---- Quotation view / workflow action handlers ---- */
function attachQuoteViewHandlers() {
  if (!state.modal || state.modal.type !== 'viewQuote') return;
  const q = state.modal.payload;

  const printBtn = document.getElementById('downloadQuotePdfBtn');
  if (printBtn) printBtn.addEventListener('click', () => {
    apiDownload(`/api/quotations/${q.id}/pdf`)
      .then(() => showToast('PDF downloaded.', 'ok'))
      .catch(err => showToast(err.message, 'err'));
  });

  const editBtn = document.getElementById('editQuoteBtn');
  if (editBtn) editBtn.addEventListener('click', () => openModal('newQuote', { ...q }));

  const submitBtn = document.getElementById('submitQuoteBtn');
  if (submitBtn) submitBtn.addEventListener('click', async () => {
    try {
      const res = await api('POST', `/api/quotations/${q.id}/submit`);
      await loadAll();
      showToast('Submitted for approval.', 'ok');
      openModal('viewQuote', res.quotation);
    } catch (e) { showToast(e.message, 'err'); }
  });

  const approveBtn = document.getElementById('approveQuoteBtn');
  if (approveBtn) approveBtn.addEventListener('click', async () => {
    try {
      const res = await api('POST', `/api/quotations/${q.id}/approve`);
      await loadAll();
      showToast('Quotation approved.', 'ok');
      openModal('viewQuote', res.quotation);
    } catch (e) { showToast(e.message, 'err'); }
  });
  const rejectBtn = document.getElementById('rejectQuoteBtn');
  if (rejectBtn) rejectBtn.addEventListener('click', async () => {
    const reason = prompt('Reason for rejecting this quotation (visible to the person who created it):');
    if (reason === null) return;
    try {
      const res = await api('POST', `/api/quotations/${q.id}/reject`, { reason });
      await loadAll();
      showToast('Quotation rejected.', 'ok');
      openModal('viewQuote', res.quotation);
    } catch (e) { showToast(e.message, 'err'); }
  });

  const sendBtn = document.getElementById('sendQuoteBtn');
  if (sendBtn) sendBtn.addEventListener('click', async () => {
    if (!confirm('Send this quotation? A permanent reference number will be assigned.')) return;
    try {
      const res = await api('POST', `/api/quotations/${q.id}/send`);
      await loadAll();
      showToast('Quotation sent — number ' + res.quotation.quotationNumber, 'ok');
      openModal('viewQuote', res.quotation);
    } catch (e) { showToast(e.message, 'err'); }
  });

  const acceptBtn = document.getElementById('acceptQuoteBtn');
  if (acceptBtn) acceptBtn.addEventListener('click', async () => {
    try {
      const res = await api('POST', `/api/quotations/${q.id}/client-decision`, { decision: 'Accepted' });
      await loadAll();
      showToast('Marked as accepted by client.', 'ok');
      openModal('viewQuote', res.quotation);
    } catch (e) { showToast(e.message, 'err'); }
  });
  const declineBtn = document.getElementById('declineQuoteBtn');
  if (declineBtn) declineBtn.addEventListener('click', async () => {
    const note = prompt('Any note about why the client declined? (optional)') || '';
    try {
      const res = await api('POST', `/api/quotations/${q.id}/client-decision`, { decision: 'Declined', note });
      await loadAll();
      showToast('Marked as declined by client.', 'ok');
      openModal('viewQuote', res.quotation);
    } catch (e) { showToast(e.message, 'err'); }
  });

  const convertBtn = document.getElementById('convertQuoteBtn');
  if (convertBtn) convertBtn.addEventListener('click', async () => {
    if (!confirm('Create a Job Order from this accepted quotation?')) return;
    try {
      const res = await api('POST', `/api/quotations/${q.id}/convert-to-job-order`);
      await loadAll();
      showToast('Job Order ' + res.jobOrder.jobOrderNumber + ' created.', 'ok');
      openModal('viewQuote', res.quotation);
    } catch (e) { showToast(e.message, 'err'); }
  });

  const reviseBtn = document.getElementById('reviseQuoteBtn');
  if (reviseBtn) reviseBtn.addEventListener('click', async () => {
    if (!confirm('Create a new revision of this quotation? You\'ll be able to edit the discount, items, or terms, and it will go through approval again before sending.')) return;
    try {
      const res = await api('POST', `/api/quotations/${q.id}/revise`);
      await loadAll();
      showToast('Revision created — edit it and resubmit for approval when ready.', 'ok');
      openModal('newQuote', { ...res.quotation });
    } catch (e) { showToast(e.message, 'err'); }
  });
}

/* ---- Exclusions library (Settings) ---- */
function attachExclusionsLibraryHandlers() {
  if (!state.modal || state.modal.type !== 'exclusionsLib') return;
  const addBtn = document.getElementById('addLibExclBtn');
  if (addBtn) addBtn.addEventListener('click', async () => {
    const text = val('newLibExclText').trim();
    if (!text) return;
    try {
      await api('POST', '/api/exclusions', { text });
      await loadAll();
      showToast('Added to library.', 'ok');
      openModal('exclusionsLib', {});
    } catch (e) { showToast(e.message, 'err'); }
  });
  document.querySelectorAll('.removeLibExclBtn').forEach(b => b.addEventListener('click', async e => {
    const id = e.currentTarget.getAttribute('data-id');
    try {
      await api('DELETE', '/api/exclusions/' + id);
      await loadAll();
      showToast('Removed.', 'ok');
      openModal('exclusionsLib', {});
    } catch (err) { showToast(err.message, 'err'); }
  }));
}

/* ---- Material Request form handlers ---- */
function readMrLinesFromDom() {
  const lines = [];
  document.querySelectorAll('[data-mr-line]').forEach(row => {
    const idx = row.getAttribute('data-mr-line');
    const isCustomEl = row.querySelector('.mrLineIsCustom');
    const isCustom = isCustomEl ? isCustomEl.value === 'true' : false;
    const qty = Number(row.querySelector('.mrLineQty')?.value || 0);
    if (isCustom) {
      lines.push({
        itemId:      null,
        isCustom:    true,
        description: row.querySelector('.mrLineDesc')?.value    || '',
        brand:       row.querySelector('.mrLineBrand')?.value   || '',
        partNo:      row.querySelector('.mrLinePartNo')?.value  || '',
        unit:        row.querySelector('.mrLineUnit')?.value    || 'Pcs',
        qty,
        qtyRequested: qty,
      });
    } else {
      const itemId = row.querySelector('.mrLineItemPick')?.value || '';
      lines.push({ itemId, qty, qtyRequested: qty, isCustom: false });
    }
  });
  return lines;
}
function syncMrFormIntoPayload() {
  const p = state.modal.payload;
  p.jobOrderId = val('mrJobOrderPick') || p.jobOrderId;
  p.date = val('mrDate') || p.date;
  p.neededBy = val('mrNeededBy');
  p.notes = val('mrNotes');
  p.lineItems = readMrLinesFromDom();
}

function onMrClientSelect() {
  const clientId = document.getElementById('mr_clientPick')?.value;
  const joSel    = document.getElementById('mrJobOrderPick');
  if (!joSel) return;
  if (!clientId) { joSel.innerHTML = '<option value="">— Select client first —</option>'; joSel.disabled = true; return; }
  const client = state.clients.find(c => c.id === clientId);
  const jos    = state.jobOrders.filter(j => j.clientId === clientId || j.clientCompany === client?.companyName);
  joSel.innerHTML = `<option value="">— Select Job Order —</option>` +
    jos.map(j=>`<option value="${j.id}">${j.jobOrderNumber} — ${j.subject||j.siteDetail||'No subject'}</option>`).join('');
  joSel.disabled = false;
}

function onMrQuotationSelect() {
  const sel = document.getElementById('mrQuotationPick');
  if (!sel || !sel.value) return;
  const q = (state.quotations || []).find(x => x.id === sel.value);
  if (!q) return;
  const lines = (q.lineItems || []).map(l => ({
    itemId: l.itemId || null, description: l.description || '',
    brand: l.brand || '', partNo: l.partNo || '', unit: l.unit || 'Pcs',
    qty: l.qty || 1, qtyRequested: l.qty || 1, isCustom: !l.itemId,
  }));
  if (q.type === 'AMC' && q.amc && q.amc.services) {
    q.amc.services.forEach(s => lines.push({
      itemId: null, description: s.description || '', brand: '', partNo: '',
      unit: 'Pcs', qty: s.qty || 1, qtyRequested: s.qty || 1, isCustom: true,
    }));
  }
  if (state.modal && state.modal.payload) {
    state.modal.payload.lineItems   = lines;
    state.modal.payload.quotationId = q.id;
  }
  const listEl = document.getElementById('mrLinesList');
  if (listEl) listEl.innerHTML = lines.map((l, idx) => renderMrLineRow(l, idx)).join('');
  showToast(`${lines.length} line(s) imported from ${q.quotationNumber||'quotation'}.`, 'ok');
}

function attachMrFormHandlers() {
  if (!state.modal || state.modal.type !== 'newMr') return;
  const p = state.modal.payload;

  const addLineBtn = document.getElementById('addMrLineBtn');
  if (addLineBtn) addLineBtn.addEventListener('click', () => {
    syncMrFormIntoPayload();
    p.lineItems = [...(p.lineItems || []), { itemId: '', qty: '', isCustom: false }];
    render();
  });

  const addCustomBtn = document.getElementById('addMrCustomLineBtn');
  if (addCustomBtn) addCustomBtn.addEventListener('click', () => {
    syncMrFormIntoPayload();
    p.lineItems = [...(p.lineItems || []), { itemId: null, description: '', brand: '', partNo: '', unit: 'Pcs', qty: '', isCustom: true }];
    render();
  });

  document.querySelectorAll('.removeMrLineBtn').forEach(b => b.addEventListener('click', e => {
    syncMrFormIntoPayload();
    const idx = Number(e.currentTarget.getAttribute('data-idx'));
    p.lineItems.splice(idx, 1);
    render();
  }));

  document.querySelectorAll('.mrLineItemPick').forEach(sel => sel.addEventListener('change', () => {
    syncMrFormIntoPayload();
    render();
  }));

  const saveBtn = document.getElementById('saveMrBtn');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    syncMrFormIntoPayload();
    const p2 = state.modal.payload;
    const requestedByVal = getUserPickerValue('mr_requestedBy');
    if (requestedByVal.name) { p2.requestedByName = requestedByVal.name; p2.requestedByDesignation = requestedByVal.designation; }
    if (!p2.jobOrderId) { showToast('Please select a Job Order.', 'err'); return; }
    if (!p2.lineItems || p2.lineItems.length === 0) { showToast('Add at least one line item.', 'err'); return; }
    for (const l of p2.lineItems) {
      if (l.isCustom) {
        if (!l.description || !String(l.description).trim()) { showToast('Custom items need a description.', 'err'); return; }
      } else {
        if (!l.itemId) { showToast('Every stock line needs an item selected.', 'err'); return; }
      }
    }
    try {
      const payload = {
        ...p2,
        lineItems: p2.lineItems.map(l => ({
          ...l,
          qty: Number(l.qty || l.qtyRequested || 0),
          qtyRequested: Number(l.qty || l.qtyRequested || 0),
        })),
      };
      let saved;
      if (p2.id) saved = (await api('PUT', '/api/material-requests/' + p2.id, payload)).materialRequest;
      else saved = (await api('POST', '/api/material-requests', payload)).materialRequest;
      await loadAll();
      showToast('Material Request saved.', 'ok');
      closeModal();
      openModal('viewMr', findMaterialRequest(saved.id));
    } catch (e) { showToast(e.message, 'err'); }
  });
}
function attachMrViewHandlers() {
  if (!state.modal || state.modal.type !== 'viewMr') return;
  const mr = state.modal.payload;

  document.querySelectorAll('[data-fulfill-line]').forEach(b => b.addEventListener('click', async e => {
    const [mrId, lineId, remaining] = e.currentTarget.getAttribute('data-fulfill-line').split('|');
    const input = prompt(`Fulfill how many? (up to ${remaining} remaining)`, remaining);
    if (input === null) return;
    const qty = Number(input);
    if (!qty || qty <= 0) { showToast('Enter a valid quantity.', 'err'); return; }
    try {
      const res = await api('POST', `/api/material-requests/${mrId}/fulfill-line`, { lineId, qty });
      await loadAll();
      showToast('Stock released.', 'ok');
      openModal('viewMr', res.materialRequest);
    } catch (err) { showToast(err.message, 'err'); }
  }));

  const cancelBtn = document.getElementById('cancelMrBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', async () => {
    if (!confirm('Cancel this Material Request?')) return;
    try {
      await api('POST', `/api/material-requests/${mr.id}/cancel`);
      await loadAll();
      showToast('Request cancelled.', 'ok');
      closeModal(); setTab('materialRequests');
    } catch (e) { showToast(e.message, 'err'); }
  });
}

/* ---- Purchase Request form + view handlers ---- */
function attachPrFormHandlers() {
  if (!state.modal || state.modal.type !== 'newPr') return;
  const saveBtn = document.getElementById('savePrBtn');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const p = state.modal.payload;
    const qtyInputs = document.querySelectorAll('.prLineQty');
    const lineItems = p.lineItems.map((l, idx) => ({ mrLineId: l.mrLineId, qty: Number(qtyInputs[idx].value) }));
    if (lineItems.some(l => !l.qty || l.qty <= 0)) { showToast('Every line needs a quantity greater than zero.', 'err'); return; }
    const requestedByVal = getUserPickerValue('pr_requestedBy');
    try {
      const res = await api('POST', '/api/purchase-requests', {
        materialRequestId: p.materialRequestId, lineItems, notes: val('prNotes'),
        requestedByName: requestedByVal.name, requestedByDesignation: requestedByVal.designation,
      });
      await loadAll();
      showToast('Purchase Request raised.', 'ok');
      closeModal();
      openModal('viewPr', res.purchaseRequest);
    } catch (e) { showToast(e.message, 'err'); }
  });
}

function attachPrViewHandlers() {
  if (!state.modal || state.modal.type !== 'viewPr') return;
  const pr = state.modal.payload;

  const approveBtn = document.getElementById('approvePrBtn');
  if (approveBtn) approveBtn.addEventListener('click', async () => {
    try {
      const res = await api('POST', `/api/purchase-requests/${pr.id}/approve`);
      await loadAll();
      showToast('Purchase Request approved.', 'ok');
      openModal('viewPr', res.purchaseRequest);
    } catch (e) { showToast(e.message, 'err'); }
  });
  const rejectBtn = document.getElementById('rejectPrBtn');
  if (rejectBtn) rejectBtn.addEventListener('click', async () => {
    const reason = prompt('Reason for rejecting this purchase request:');
    if (reason === null) return;
    try {
      const res = await api('POST', `/api/purchase-requests/${pr.id}/reject`, { reason });
      await loadAll();
      showToast('Purchase Request rejected.', 'ok');
      openModal('viewPr', res.purchaseRequest);
    } catch (e) { showToast(e.message, 'err'); }
  });
  const convertBtn = document.getElementById('convertPrToPoBtn');
  if (convertBtn) convertBtn.addEventListener('click', () => {
    closeModal();
    openModal('newPo', { purchaseRequestId: pr.id, unitCosts: {} });
  });
}

/* ---- Purchase Order form + view handlers ---- */
function attachPoFormHandlers() {
  if (!state.modal || state.modal.type !== 'newPo') return;
  const createBtn = document.getElementById('createPoBtn');
  if (createBtn) createBtn.addEventListener('click', async () => {
    const p = state.modal.payload;
    const vendorId = val('poVendorPick');
    if (!vendorId) { showToast('Please select a vendor.', 'err'); return; }
    const unitCosts = {};
    document.querySelectorAll('.poUnitCost').forEach(el => { unitCosts[el.getAttribute('data-prlineid')] = Number(el.value || 0); });
    const createdByVal = getUserPickerValue('po_createdBy');
    try {
      const res = await api('POST', '/api/purchase-orders', {
        purchaseRequestId: p.purchaseRequestId, vendorId, unitCosts,
        expectedDate: val('poExpectedDate'), notes: val('poNotes'),
        createdByName: createdByVal.name, createdByDesignation: createdByVal.designation,
      });
      await loadAll();
      showToast('Purchase Order created.', 'ok');
      closeModal();
      openModal('viewPo', res.purchaseOrder);
    } catch (e) { showToast(e.message, 'err'); }
  });
}

function attachPoViewHandlers() {
  if (!state.modal || state.modal.type !== 'viewPo') return;
  const po = state.modal.payload;

  const sendBtn = document.getElementById('sendPoBtn');
  if (sendBtn) sendBtn.addEventListener('click', async () => {
    if (!confirm('Send this Purchase Order to the vendor?')) return;
    try {
      const res = await api('POST', `/api/purchase-orders/${po.id}/send`);
      await loadAll();
      showToast('Purchase Order marked as sent.', 'ok');
      openModal('viewPo', res.purchaseOrder);
    } catch (e) { showToast(e.message, 'err'); }
  });
  const cancelBtn = document.getElementById('cancelPoBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', async () => {
    if (!confirm('Cancel this Purchase Order?')) return;
    try {
      await api('POST', `/api/purchase-orders/${po.id}/cancel`);
      await loadAll();
      showToast('Purchase Order cancelled.', 'ok');
      closeModal(); setTab('procurement');
    } catch (e) { showToast(e.message, 'err'); }
  });
  document.querySelectorAll('[data-receive-line]').forEach(b => b.addEventListener('click', async e => {
    const [poId, lineId, remaining] = e.currentTarget.getAttribute('data-receive-line').split('|');
    const input = prompt(`Receive how many? (up to ${remaining} remaining)`, remaining);
    if (input === null) return;
    const qty = Number(input);
    if (!qty || qty <= 0) { showToast('Enter a valid quantity.', 'err'); return; }
    try {
      const res = await api('POST', `/api/purchase-orders/${poId}/receive-line`, { lineId, qty });
      await loadAll();
      showToast('Stock received.', 'ok');
      openModal('viewPo', res.purchaseOrder);
    } catch (err) { showToast(err.message, 'err'); }
  }));
}

/* ---- Site Team form handler ---- */
function attachSiteTeamFormHandlers() {
  if (!state.modal || state.modal.type !== 'siteTeam') return;
  const jo = state.modal.payload;
  const saveBtn = document.getElementById('saveSiteTeamBtn');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    try {
      const res = await api('PUT', `/api/job-orders/${jo.id}/site-team`, {
        siteEngineer:     val('st_siteEngineer').trim(),
        projectManager:   val('st_projectManager').trim(),
        siteSupervisor:   val('st_siteSupervisor').trim(),
        projectsIncharge: val('st_projectsIncharge').trim(),
        preparedBy:       val('st_preparedBy').trim(),
      });
      await loadAll();
      showToast('Site team saved.', 'ok');
      closeModal();
      openModal('viewJobOrder', findJobOrder(res.jobOrder.id));
    } catch (e) { showToast(e.message, 'err'); }
  });
}

/* ---- Job Order quotation auto-fill ---- */
function onJoQuotationSelect() {
  const sel = document.getElementById('jo_quotationId');
  const opt = sel.options[sel.selectedIndex];
  const ref = document.getElementById('jo_qtn_ref_display');
  if (!sel.value) { if (ref) ref.style.display = 'none'; return; }
  // Auto-fill client, subject, siteDetail from selected quotation
  const client  = opt.dataset.client  || '';
  const subject = opt.dataset.subject || '';
  const site    = opt.dataset.site    || '';
  const number  = opt.dataset.number  || '';
  if (client  && document.getElementById('jo_clientCompany')) document.getElementById('jo_clientCompany').value = client;
  if (subject && document.getElementById('jo_subject'))        document.getElementById('jo_subject').value       = subject;
  if (site    && document.getElementById('jo_siteDetail'))     document.getElementById('jo_siteDetail').value    = site;
  if (ref) { ref.textContent = `✓ Linked: ${number}`; ref.style.display = ''; }
}

/* ---- Job Order create/edit form handler ---- */
function attachJoFormHandlers() {
  if (!state.modal || state.modal.type !== 'newJo') return;
  const p = state.modal.payload;
  const clientPick = document.getElementById('jo_clientPick');
  if (clientPick) clientPick.addEventListener('change', e => {
    const c = state.clients.find(cl => cl.id === e.target.value);
    if (c) document.getElementById('jo_clientCompany').value = c.companyName;
  });
  const saveBtn = document.getElementById('saveJoBtn');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const clientCompany = val('jo_clientCompany').trim();
    if (!clientCompany) { showToast('Client company name is required.', 'err'); return; }

    const fd = new FormData();
    fd.append('clientId',       val('jo_clientPick') || '');
    fd.append('clientCompany',  clientCompany);
    fd.append('jobOrderNumber', val('jo_number').trim());
    fd.append('type',           val('jo_type'));
    fd.append('subject',        val('jo_subject'));
    fd.append('siteDetail',     val('jo_siteDetail'));
    fd.append('location',       val('jo_location'));
    fd.append('value',          val('jo_value') || 0);
    fd.append('status',         val('jo_status'));
    fd.append('quotationId',    val('jo_quotationId') || '');
    const createdByVal = getUserPickerValue('jo_createdBy');
    if (createdByVal.name)        fd.append('createdByName', createdByVal.name);
    if (createdByVal.designation) fd.append('createdByDesignation', createdByVal.designation);

    const lpoInput   = document.getElementById('jo_lpoFile');
    const quoteInput = document.getElementById('jo_quoteFile');
    if (lpoInput?.files[0])   fd.append('lpoFile',   lpoInput.files[0]);
    if (quoteInput?.files[0]) fd.append('quoteFile', quoteInput.files[0]);

    try {
      let saved;
      const headers = { 'Authorization': `Bearer ${authToken}` };
      if (p.id) {
        const r = await fetch('/api/job-orders/' + p.id, { method: 'PUT', headers, body: fd });
        const d = await r.json(); if (!r.ok) throw new Error(d.error); saved = d.jobOrder;
      } else {
        const r = await fetch('/api/job-orders', { method: 'POST', headers, body: fd });
        const d = await r.json(); if (!r.ok) throw new Error(d.error); saved = d.jobOrder;
      }
      await loadAll();
      showToast(p.id ? 'Job Order updated.' : 'Job Order created.', 'ok');
      closeModal();
      openModal('viewJobOrder', findJobOrder(saved.id));
    } catch (e) { showToast(e.message, 'err'); }
  });
}

/* ---- Delay Report form handler ---- */
function syncDrFormIntoPayload() {
  const p = state.modal.payload;
  p.jobOrderId = val('drJobOrderPick') || p.jobOrderId;
  p.date = val('drDate') || p.date;
  p.reportedBy = val('drReportedBy');
  p.delayItems = [];
  document.querySelectorAll('[data-dr-item]').forEach(row => {
    const idx = row.getAttribute('data-dr-item');
    p.delayItems.push({
      floor: row.querySelector('.drFloor').value,
      areaZone: row.querySelector('.drAreaZone').value,
      targetDate: row.querySelector('.drTargetDate').value,
      description: row.querySelector('.drDescription').value,
      reasonOfDelay: row.querySelector('.drReason').value,
      actionBy: row.querySelector('.drActionBy').value,
      status: row.querySelector('.drStatus').value,
      remarks: row.querySelector('.drRemarks').value,
      // File inputs can't be serialized into plain payload state — read directly at submit time instead.
    });
  });
}

function attachDrFormHandlers() {
  if (!state.modal || (state.modal.type !== 'newDr' && state.modal.type !== 'editDr')) return;
  const p = state.modal.payload;

  const jobOrderPick = document.getElementById('drJobOrderPick');
  if (jobOrderPick) jobOrderPick.addEventListener('change', () => {
    syncDrFormIntoPayload();
    render(); // discrete select action — safe to re-render, refreshes the auto-filled project/site-team preview
  });

  const addItemBtn = document.getElementById('addDrItemBtn');
  if (addItemBtn) addItemBtn.addEventListener('click', () => {
    syncDrFormIntoPayload();
    p.delayItems = [...p.delayItems, { status: 'Open' }];
    render();
  });
  document.querySelectorAll('.removeDrItemBtn').forEach(b => b.addEventListener('click', e => {
    syncDrFormIntoPayload();
    const idx = Number(e.currentTarget.getAttribute('data-idx'));
    p.delayItems.splice(idx, 1);
    render();
  }));
  // Text/select fields inside each row are read live via syncDrFormIntoPayload() at
  // add/remove/submit time — no per-keystroke render(), matching the lesson learned
  // from every other form in this app (mid-type re-renders drop focus and keystrokes).

  const saveBtn = document.getElementById('saveDrBtn');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const jobOrderId = val('drJobOrderPick') || p.jobOrderId;
    if (!jobOrderId) { showToast('Please select a Job Order.', 'err'); return; }
    const rows = document.querySelectorAll('[data-dr-item]');
    if (rows.length === 0) { showToast('Add at least one delay item.', 'err'); return; }

    const delayItems = [];
    const fd = new FormData();
    rows.forEach((row, idx) => {
      delayItems.push({
        floor: row.querySelector('.drFloor').value,
        areaZone: row.querySelector('.drAreaZone').value,
        targetDate: row.querySelector('.drTargetDate').value,
        description: row.querySelector('.drDescription').value,
        reasonOfDelay: row.querySelector('.drReason').value,
        actionBy: row.querySelector('.drActionBy').value,
        status: row.querySelector('.drStatus').value,
        remarks: row.querySelector('.drRemarks').value,
      });
      const siteFile = row.querySelector('.drSitePhoto').files[0];
      const drawingFile = row.querySelector('.drDrawingPhoto').files[0];
      if (siteFile) fd.append('sitePhotos', siteFile);
      if (drawingFile) fd.append('drawingPhotos', drawingFile);
    });

    fd.append('jobOrderId', jobOrderId);
    fd.append('date', val('drDate'));
    fd.append('reportedBy', val('drReportedBy'));
    fd.append('delayItems', JSON.stringify(delayItems));
    fd.append('sigRamadasu',  document.getElementById('sig_reportedBy').checked);
    fd.append('sigNazir',     document.getElementById('sig_projectsIncharge').checked);
    fd.append('sigIbrahim',   document.getElementById('sig_siteEngineer').checked);
    fd.append('sigHussein',   document.getElementById('sig_projectManager').checked);

    try {
      const isEdit = state.modal.type === 'editDr' && !!p.id;
      const res = isEdit
        ? await api('PUT', '/api/delay-reports/' + p.id, fd, true)
        : await api('POST', '/api/delay-reports', fd, true);
      await loadAll();
      showToast(isEdit ? 'Delay report updated.' : 'Delay report submitted.', 'ok');
      closeModal();
      openModal('viewDr', res.delayReport);
    } catch (e) { showToast(e.message, 'err'); }
  });
}

/* ---- Delay Report PDF builder ---- */
function buildDrPdfHtml(d) {
  const dateFmt = (d.date||'').split('-').reverse().join('-') || '—';
  const afSigs  = d.signatures?.afSide    || [];
  const clSigs  = d.signatures?.clientSide || [];
  // Always show Al Fitr side with real names — fallback to stored report fields
  const afSignatories = afSigs.length ? afSigs : [
    { name: d.reportedBy    || d.preparedBy || '—',          role: 'Prepared By'      },
    { name: d.projectsIncharge || 'Engr. Nazir Hussain',     role: 'Project In-Charge' },
  ];
  const rowsHtml = (d.delayItems||[]).map((item,i) => {
    const sc = item.status==='Open' ? 'background:#FEE2E2;color:#991B1B' : item.status==='In Progress' ? 'background:#FEF3C7;color:#92400E' : 'background:#D1FAE5;color:#065F46';
    const si = item.sitePhotoUrl    ? `<img src="${item.sitePhotoUrl}"    style="width:100%;height:50px;object-fit:cover;border-radius:2px;border:1px solid #ddd;display:block;">` : `<div style="width:100%;height:50px;background:#f5f5f5;border:1px dashed #ddd;border-radius:2px;display:flex;align-items:center;justify-content:center;font-size:7px;color:#ccc;">No photo</div>`;
    const di = item.drawingPhotoUrl ? `<img src="${item.drawingPhotoUrl}" style="width:100%;height:50px;object-fit:cover;border-radius:2px;border:1px solid #ddd;display:block;">` : `<div style="width:100%;height:50px;background:#f5f5f5;border:1px dashed #ddd;border-radius:2px;display:flex;align-items:center;justify-content:center;font-size:7px;color:#ccc;">Not uploaded</div>`;
    return `<tr>
      <td class="tc" style="font-weight:700;color:#555;font-size:8px;border:1px solid #ddd;padding:4px 3px;">${String(i+1).padStart(2,'0')}</td>
      <td class="tc" style="font-size:8px;border:1px solid #ddd;padding:4px 3px;">${item.floor||'—'}</td>
      <td class="tc" style="font-size:7.5px;border:1px solid #ddd;padding:4px 3px;">${item.areaZone||'—'}</td>
      <td class="tl" style="font-size:7.5px;border:1px solid #ddd;padding:4px 3px;">${item.description||'—'}</td>
      <td class="tc" style="border:1px solid #ddd;padding:4px 3px;">${si}</td>
      <td class="tc" style="border:1px solid #ddd;padding:4px 3px;">${di}</td>
      <td class="tc" style="font-size:7.5px;border:1px solid #ddd;padding:4px 3px;">${item.reasonOfDelay||'—'}</td>
      <td class="tc" style="font-size:7.5px;border:1px solid #ddd;padding:4px 3px;"><strong>${item.actionBy||'—'}</strong></td>
      <td class="tc" style="border:1px solid #ddd;padding:4px 3px;"><span style="border-radius:2px;padding:2px 4px;font-size:6.5px;font-weight:700;${sc};">${item.status||'Open'}</span></td>
      <td class="tl" style="font-size:7px;color:#555;border:1px solid #ddd;padding:4px 3px;">${item.remarks||'—'}</td>
      <td class="tc" style="font-size:8px;color:#E8520A;font-weight:700;border:1px solid #ddd;padding:4px 3px;">${item.targetDate||'—'}</td>
    </tr>`;
  }).join('');

  const afBlocks = afSignatories.map(s=>`<div style="flex:1;text-align:center;padding:0 8px;"><div style="border-bottom:1px solid #555;height:20px;margin-bottom:3px;"></div><div style="font-size:7.5px;font-weight:700;">${s.name||'—'}</div><div style="font-size:7px;color:#1D9E75;">${s.role}</div></div>`).join('');
  const clBlocks = clSigs.map(s=>`<div style="flex:1;text-align:center;padding:0 8px;"><div style="border-bottom:1px solid #555;height:20px;margin-bottom:3px;"></div><div style="font-size:7.5px;font-weight:700;">${s.name||'—'}</div><div style="font-size:7px;color:#185FA5;">${s.role}</div></div>`).join('');
  const sigHtml = `<div style="border-top:2px solid #E8520A;display:flex;">
    <div style="background:#f0faf5;flex:1;padding:8px 14px;${clSigs.length?'border-right:1px solid #ddd;':''}">
      <span style="font-size:7px;font-weight:700;text-transform:uppercase;background:#e1f5ee;color:#085041;padding:2px 7px;border-radius:3px;display:inline-block;margin-bottom:6px;">Al Fitr Electromechanical Works LLC</span>
      <div style="display:flex;">${afBlocks}</div>
    </div>
    ${clSigs.length ? `<div style="background:#f0f5fb;flex:1;padding:8px 14px;">
      <span style="font-size:7px;font-weight:700;text-transform:uppercase;background:#e6f1fb;color:#185FA5;padding:2px 7px;border-radius:3px;display:inline-block;margin-bottom:6px;">Client — ${d.clientCompany||''}</span>
      <div style="display:flex;">${clBlocks}</div>
    </div>` : ''}
  </div>`;
  const co = state.company || {};
  const logoHeight = co.logoSize === 'large' ? 64 : co.logoSize === 'small' ? 36 : 52;
  const logoHtml = co.logoPath
    ? `<img src="${co.logoPath}" style="height:${logoHeight}px;max-width:120px;object-fit:contain;display:block;" alt="logo">`
    : `<div style="display:flex;flex-direction:column;align-items:center;"><div style="width:42px;height:42px;border-radius:50%;border:2px solid #1D9E75;display:flex;align-items:center;justify-content:center;"><div style="width:26px;height:26px;border-radius:50%;background:#1D9E75;color:#fff;font-weight:700;font-size:8px;display:flex;align-items:center;justify-content:center;">AF</div></div><div style="font-size:7px;font-weight:700;color:#1D9E75;text-align:center;margin-top:2px;">AL FITR</div></div>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${d.refNumber}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:Arial,sans-serif;font-size:9px;color:#1a1a1a;}
    @page{size:A4 landscape;margin:8mm;}
    table{border-collapse:collapse;width:100%;}
    td,th{vertical-align:middle;word-wrap:break-word;overflow-wrap:break-word;}
    .tc{text-align:center !important;vertical-align:middle !important;}
    .tl{text-align:left !important;vertical-align:middle !important;}
  </style>
  </head><body>
  <div style="border-bottom:3px solid #E8520A;display:grid;grid-template-columns:90px 1fr auto;align-items:center;padding:8px 14px;gap:10px;">
    <div style="display:flex;align-items:center;justify-content:center;">${logoHtml}</div>
    <div style="text-align:center;font-size:13px;font-weight:700;color:#E8520A;letter-spacing:0.4px;">AL FITR ELECTROMECHANICAL WORKS LLC</div>
    <div style="text-align:right;font-size:7.5px;color:#555;line-height:1.7;">
      <div><strong>Ref No:</strong> ${d.refNumber||'—'}</div>
      <div><strong>Date:</strong> ${dateFmt}</div>
      <div><strong>Job Order:</strong> ${d.jobOrderNumber||'—'}</div>
      ${d.quotationNumber ? `<div><strong>Quote Ref:</strong> ${d.quotationNumber}</div>` : ''}
      <div><strong>Page:</strong> 1 of 1</div>
    </div>
  </div>
  <div style="background:#f5f5f5;border-bottom:1px solid #ddd;text-align:center;padding:5px;font-size:10px;font-weight:700;letter-spacing:0.5px;">SITE DELAY ANALYSIS REPORT</div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;border-bottom:1px solid #ddd;">
    <div style="padding:5px 10px;border-right:1px solid #ddd;">
      <div style="display:flex;gap:4px;margin-bottom:2px;"><span style="font-weight:700;color:#333;min-width:88px;font-size:7.5px;">Project Name:</span><span style="font-size:8px;">${d.projectName||'—'}</span></div>
      <div style="display:flex;gap:4px;margin-bottom:2px;"><span style="font-weight:700;color:#333;min-width:88px;font-size:7.5px;">Fire Contractor:</span><span style="font-size:8px;">${d.clientCompany||'—'}</span></div>
      <div style="display:flex;gap:4px;"><span style="font-weight:700;color:#333;min-width:88px;font-size:7.5px;">Scope of Work:</span><span style="font-size:8px;">${d.scopeOfWork||d.siteDetail||'—'}</span></div>
    </div>
    <div style="padding:5px 10px;border-right:1px solid #ddd;">
      <div style="display:flex;gap:4px;margin-bottom:2px;"><span style="font-weight:700;color:#333;min-width:88px;font-size:7.5px;">Location:</span><span style="font-size:8px;">${d.location||'—'}</span></div>
      <div style="display:flex;gap:4px;margin-bottom:2px;"><span style="font-weight:700;color:#333;min-width:88px;font-size:7.5px;">Project Manager:</span><span style="font-size:8px;">${d.projectManager||'—'} <span style="font-size:7px;color:#aaa;">(Client)</span></span></div>
      <div style="display:flex;gap:4px;"><span style="font-weight:700;color:#333;min-width:88px;font-size:7.5px;">Client Engineer:</span><span style="font-size:8px;">${d.siteEngineer||'—'} <span style="font-size:7px;color:#aaa;">(Client)</span></span></div>
    </div>
    <div style="padding:5px 10px;">
      <div style="display:flex;gap:4px;margin-bottom:2px;"><span style="font-weight:700;color:#333;min-width:88px;font-size:7.5px;">Date:</span><span style="font-size:8px;color:#E8520A;font-weight:700;">${dateFmt}</span></div>
      <div style="display:flex;gap:4px;margin-bottom:2px;"><span style="font-weight:700;color:#333;min-width:88px;font-size:7.5px;">Reported By:</span><span style="font-size:8px;">${d.reportedBy||'—'} <span style="font-size:7px;color:#aaa;">(Al Fitr)</span></span></div>
      <div style="display:flex;gap:4px;"><span style="font-weight:700;color:#333;min-width:88px;font-size:7.5px;">Projects Incharge:</span><span style="font-size:8px;">${d.projectsIncharge||'—'} <span style="font-size:7px;color:#aaa;">(Al Fitr)</span></span></div>
    </div>
  </div>
  <table style="width:100%;border-collapse:collapse;table-layout:fixed;">
    <colgroup><col style="width:3%"><col style="width:5%"><col style="width:8%"><col style="width:14%"><col style="width:9%"><col style="width:9%"><col style="width:10%"><col style="width:10%"><col style="width:6%"><col style="width:13%"><col style="width:13%"></colgroup>
    <thead><tr style="background:#2c2c2c;">
      ${[
        {h:'SR.<br>No',c:true},{h:'Floor',c:false},{h:'Area /<br>Zone',c:true},
        {h:'Description',c:false},{h:'Site Actual<br>Picture',c:true},{h:'Drawing Ref.<br>Picture',c:true},
        {h:'Reason of<br>Delay',c:true},{h:'Action By',c:true},{h:'Status',c:true},
        {h:'Remarks',c:false},{h:'Target<br>Resolution',c:true}
      ].map(({h,c})=>`<th style="color:#fff;font-size:7px;font-weight:700;padding:5px 3px;text-align:${c?'center':'left'};border:1px solid #444;line-height:1.3;">${h}</th>`).join('')}
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  ${sigHtml}
  <div style="background:#2c2c2c;color:#aaa;display:flex;justify-content:space-between;padding:4px 14px;font-size:6.5px;">
    <span>Al Fitr Electromechanical Works LLC — Sharjah, UAE</span>
    <span><strong style="color:#E8520A;">${d.refNumber||'—'}</strong> — Site Delay Analysis Report — ${d.projectName||''}</span>
    <span>Generated: ${dateFmt} — Confidential</span>
  </div>
  </body></html>`;
}

/* ---- Settings ---- */
function attachSettingsHandlers() {
  const saveCompanyBtn = document.getElementById('saveCompanyBtn');
  if (saveCompanyBtn) saveCompanyBtn.addEventListener('click', async () => {
    try {
      await api('PUT', '/api/company', {
        name: val('setCompanyName'), address: val('setCompanyAddress'), phone: val('setCompanyPhone'),
        email: val('setCompanyEmail'), website: val('setCompanyWebsite'), vatNumber: val('setCompanyVat'), logoSize: val('setLogoSize'),
      });
      await loadAll();
      showToast('Company details saved.', 'ok'); render();
    } catch (e) { showToast(e.message, 'err'); }
  });

  const logoUpload = document.getElementById('logoUpload');
  if (logoUpload) logoUpload.addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    const form = new FormData(); form.append('logo', file);
    try {
      await api('POST', '/api/company/logo', form, true);
      await loadAll();
      showToast('Logo updated.', 'ok'); render();
    } catch (err) { showToast(err.message, 'err'); }
  });
  const removeLogoBtn = document.getElementById('removeLogoBtn');
  if (removeLogoBtn) removeLogoBtn.addEventListener('click', async () => {
    try { await api('DELETE', '/api/company/logo'); await loadAll(); showToast('Logo removed.', 'ok'); render(); }
    catch (e) { showToast(e.message, 'err'); }
  });

  const saveDnSettingsBtn = document.getElementById('saveDnSettingsBtn');
  if (saveDnSettingsBtn) saveDnSettingsBtn.addEventListener('click', async () => {
    try {
      await api('PUT', '/api/company', {
        dnPrefix: val('setDnPrefix').trim() || 'DN-', currency: val('setCurrency'), paperSize: val('setPaperSize'), reportFooter: val('setReportFooter'),
      });
      await loadAll();
      showToast('Delivery note & report settings saved.', 'ok'); render();
    } catch (e) { showToast(e.message, 'err'); }
  });

  const addBranchBtn = document.getElementById('addBranchBtn');
  if (addBranchBtn) addBranchBtn.addEventListener('click', async () => {
    const v = val('newBranchInput').trim(); if (!v) return;
    try { await api('POST', '/api/meta/branches', { value: v }); await loadAll(); render(); } catch (e) { showToast(e.message, 'err'); }
  });
  document.querySelectorAll('[data-del-branch]').forEach(b => b.addEventListener('click', async e => {
    try { await api('DELETE', '/api/meta/branches/' + encodeURIComponent(e.currentTarget.getAttribute('data-del-branch'))); await loadAll(); render(); } catch (err) { showToast(err.message, 'err'); }
  }));
  const addBrandBtn = document.getElementById('addBrandBtn');
  if (addBrandBtn) addBrandBtn.addEventListener('click', async () => {
    const v = val('newBrandInput').trim(); if (!v) return;
    try { await api('POST', '/api/meta/brands', { value: v }); await loadAll(); render(); } catch (e) { showToast(e.message, 'err'); }
  });
  document.querySelectorAll('[data-del-brand]').forEach(b => b.addEventListener('click', async e => {
    try { await api('DELETE', '/api/meta/brands/' + encodeURIComponent(e.currentTarget.getAttribute('data-del-brand'))); await loadAll(); render(); } catch (err) { showToast(err.message, 'err'); }
  }));
  const addUnitBtn = document.getElementById('addUnitBtn');
  if (addUnitBtn) addUnitBtn.addEventListener('click', async () => {
    const v = val('newUnitInput').trim(); if (!v) return;
    try { await api('POST', '/api/meta/units', { value: v }); await loadAll(); render(); } catch (e) { showToast(e.message, 'err'); }
  });
  document.querySelectorAll('[data-del-unit]').forEach(b => b.addEventListener('click', async e => {
    try { await api('DELETE', '/api/meta/units/' + encodeURIComponent(e.currentTarget.getAttribute('data-del-unit'))); await loadAll(); render(); } catch (err) { showToast(err.message, 'err'); }
  }));

  const seedRolesBtn = document.getElementById('seedRolesBtn');
  if (seedRolesBtn) seedRolesBtn.addEventListener('click', async () => {
    try {
      const res = await api('POST', '/api/users/roles/seed', {});
      await loadAll();
      showToast(`Added roles: ${res.added.length > 0 ? res.added.join(', ') : 'None new (all already exist)'}`, 'ok');
      render();
    } catch(e) { showToast(e.message, 'err'); }
  });

  const addUserBtn = document.getElementById('addUserBtn');
  if (addUserBtn) addUserBtn.addEventListener('click', () => {
    const firstNonSuper = Object.keys(state.roles).find(r => r !== 'Super Admin') || 'Viewer';
    openModal('userEdit', { role: firstNonSuper, active: true });
  });
  document.querySelectorAll('[data-edit-user]').forEach(b => b.addEventListener('click', e => {
    openModal('userEdit', { ...state.users.find(u => u.id === e.currentTarget.getAttribute('data-edit-user')) });
  }));

  document.querySelectorAll('.permCheck').forEach(cb => cb.addEventListener('change', async e => {
    const role = e.target.getAttribute('data-role'), perm = e.target.getAttribute('data-perm');
    try {
      await api('PUT', '/api/users/roles/' + encodeURIComponent(role), { [perm]: e.target.checked });
      await loadAll();
      showToast(`Updated ${role} permissions.`, 'ok');
    } catch (err) { showToast(err.message, 'err'); render(); }
  }));

  const saveQuoteCounterBtn = document.getElementById('saveQuoteCounterBtn');
  if (saveQuoteCounterBtn) saveQuoteCounterBtn.addEventListener('click', async () => {
    const value = Number(val('setQuoteCounter'));
    try {
      await api('PUT', '/api/company/quotation-counter', { value });
      await loadAll();
      showToast('Quotation numbering updated.', 'ok'); render();
    } catch (e) { showToast(e.message, 'err'); }
  });
  const addQuoteCatBtn = document.getElementById('addQuoteCatBtn');
  if (addQuoteCatBtn) addQuoteCatBtn.addEventListener('click', async () => {
    const v = val('newQuoteCatInput').trim(); if (!v) return;
    try { await api('POST', '/api/meta/quotationCategories', { value: v }); await loadAll(); render(); } catch (e) { showToast(e.message, 'err'); }
  });
  document.querySelectorAll('[data-del-quotecat]').forEach(b => b.addEventListener('click', async e => {
    try { await api('DELETE', '/api/meta/quotationCategories/' + encodeURIComponent(e.currentTarget.getAttribute('data-del-quotecat'))); await loadAll(); render(); } catch (err) { showToast(err.message, 'err'); }
  }));
  const saveApproversBtn = document.getElementById('saveApproversBtn');
  if (saveApproversBtn) saveApproversBtn.addEventListener('click', async () => {
    const userIds = [...document.querySelectorAll('.approverCheck:checked')].map(cb => cb.getAttribute('data-uid'));
    try {
      await api('PUT', '/api/company/quotation-approvers', { userIds });
      await loadAll();
      showToast('Approvers updated.', 'ok'); render();
    } catch (e) { showToast(e.message, 'err'); }
  });
  const openExclusionsLibBtn = document.getElementById('openExclusionsLibBtn');
  if (openExclusionsLibBtn) openExclusionsLibBtn.addEventListener('click', () => openModal('exclusionsLib', {}));
}

/* ================= INIT ================= */
(async function init() {
  render();
  if (authToken) {
    try { await loadAll(); } catch (e) { console.error(e); }
  } else {
    loadPublicBranding();
  }
  render();
})();
