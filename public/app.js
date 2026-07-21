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
  tab: 'dashboard', branch: 'All', search: '', invFilter: 'All', exportIncludePricing: true,
  user: null, permissions: {}, company: {}, branches: [], brands: [], units: [],
  items: [], movements: [], clients: [], dns: [], users: [], roles: {}, permLabels: [],
  loaded: false, modal: null, toast: null,
  publicBranding: null,
  quotations: [], jobOrders: [], exclusionsLibrary: [], quotationCategories: [], quotationApprovers: [],
  nextQuotationCounter: null, quoteFilter: 'All',
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

  const [company, branchesR, brandsR, unitsR, itemsR, movementsR, clientsR, dnsR, quotCatR, exclR, quotesR, joR] = await Promise.all([
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
  ]);
  state.company = company.company; state.nextDnPreview = company.nextDnPreview; state.nextQuotationCounter = company.nextQuotationCounter;
  state.branches = branchesR.branches; state.brands = brandsR.brands; state.units = unitsR.units;
  state.items = itemsR.items; state.movements = movementsR.movements; state.clients = clientsR.clients; state.dns = dnsR.dns;
  state.quotationCategories = quotCatR.quotationCategories; state.exclusionsLibrary = exclR.exclusions;
  state.quotations = quotesR.quotations; state.jobOrders = joR.jobOrders;

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
function setTab(t) { state.tab = t; state.modal = null; render(); }

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
      <div class="login-title">${(b && b.name) || 'Al Fitr Inventory & Delivery'}</div>
      <div class="login-sub">Sign in to continue</div>
      <div id="loginErr"></div>
      <div class="field"><label>Username</label><input id="loginUsername" autocomplete="username" placeholder="e.g. admin"></div>
      <div class="field"><label>Password</label><input id="loginPassword" type="password" autocomplete="current-password" placeholder="Enter your password"></div>
      <button class="btn btn-primary" id="loginBtn" style="width:100%;justify-content:center;margin-top:6px;">Sign In</button>
      <p class="muted" style="text-align:center;margin-top:16px;font-size:11.5px;">First time? Default is <strong>admin</strong> / <strong>admin123</strong> — you'll be asked to change it.</p>
    </div>
  </div>`;
}
async function loadPublicBranding() {
  try {
    const res = await fetch('/api/company/public');
    if (res.ok) { state.publicBranding = await res.json(); render(); }
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
      ${co.logoPath ? `<img src="${co.logoPath}" class="app-header-logo" style="height:${headerLogoSizePx(co.logoSize)}px;max-width:160px;object-fit:contain;" alt="logo">` : `<div class="brand-mark" style="width:30px;height:30px;font-size:12px;">${userInitials(co.name)}</div>`}
      <div class="app-header-name">${co.name || ''} <span class="muted" style="font-weight:500;">— Inventory &amp; Delivery</span></div>
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
  const navItem = (id, label) => `<button data-tab="${id}" class="${state.tab === id ? 'active' : ''}"><span class="dot"></span>${label}</button>`;
  return `
  <div class="sidebar">
    <div class="brand">
      <div class="brand-mark">AF</div>
      <div class="brand-name">Al Fitr Electromechanical</div>
      <div class="brand-sub">Inventory &amp; Delivery</div>
    </div>
    <div class="nav">
      ${navItem('dashboard', 'Dashboard')}
      ${navItem('inventory', 'Inventory')}
      ${navItem('movements', 'Stock Movements')}
      ${navItem('dns', 'Delivery Notes')}
      ${navItem('quotations', 'Quotations')}
      ${navItem('jobOrders', 'Job Orders')}
      ${navItem('clients', 'Clients')}
      ${navItem('settings', 'Settings')}
    </div>
    <div class="sidebar-foot">
      Server-backed: pricing and permissions are enforced by the server, not just hidden in this screen.
      <div class="sync-badge"><span class="sync-dot"></span> Connected</div>
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
    clients: ['Clients', 'Company directory used on delivery notes'],
    settings: ['Settings', 'Branches, brands, units, security and company details'],
  };
  const [title, sub] = titles[state.tab];
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
  if (state.tab === 'clients') return renderClients();
  if (state.tab === 'settings') return renderSettings();
  return '';
}

/* ---------------- Dashboard ---------------- */
function renderDashboard() {
  const items = state.branch === 'All' ? state.items : state.items.filter(i => i.location === state.branch);
  const statuses = items.map(i => i.status);
  const total = items.length;
  const inStock = statuses.filter(s => s === 'IN STOCK').length;
  const lowCrit = statuses.filter(s => s === 'LOW STOCK' || s === 'CRITICAL').length;
  const outStock = statuses.filter(s => s === 'OUT OF STOCK').length;
  const showValue = can('viewStockValue');
  const stockValue = items.reduce((s, i) => s + (Number(i.stockValue) || 0), 0);

  const dns = state.branch === 'All' ? state.dns : state.dns.filter(d => d.location === state.branch);
  const issuedThisMonth = dns.filter(d => {
    if (d.status !== 'Issued') return false;
    const dt = new Date(d.date); const now = new Date();
    return dt.getMonth() === now.getMonth() && dt.getFullYear() === now.getFullYear();
  }).length;

  const recentMv = [...state.movements].filter(m => {
    if (state.branch === 'All') return true;
    const it = findItem(m.itemId); return it && it.location === state.branch;
  }).sort((a, b) => b.createdAt - a.createdAt).slice(0, 8);
  const recentDns = [...dns].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);
  const alerts = items.filter(i => i.status !== 'IN STOCK').sort((a, b) => a.qty - b.qty).slice(0, 8);

  return `
  <div class="kpi-row">
    <div class="kpi"><div class="num">${total}</div><div class="lbl">Total Items</div></div>
    <div class="kpi good"><div class="num">${inStock}</div><div class="lbl">In Stock</div></div>
    <div class="kpi warn"><div class="num">${lowCrit}</div><div class="lbl">Low / Critical</div></div>
    <div class="kpi bad"><div class="num">${outStock}</div><div class="lbl">Out of Stock</div></div>
    <div class="kpi brand"><div class="num">${issuedThisMonth}</div><div class="lbl">DNs This Month</div></div>
  </div>
  <div class="grid2" style="align-items:start;">
    <div class="card">
      <div class="card-head"><div class="card-title">Reorder Alerts <span>${alerts.length} item(s) need attention</span></div>
        <button class="btn btn-ghost btn-sm" data-tab="inventory">View Inventory</button></div>
      ${alerts.length === 0 ? `<div class="empty">All items are healthy right now.</div>` : `
      <div class="tbl-wrap"><table><thead><tr><th>Item</th><th>Brand</th><th>Qty</th><th>Min</th><th>Status</th></tr></thead>
      <tbody>${alerts.map(i => `<tr><td>${i.description}</td><td>${i.brand}</td><td>${i.qty}</td><td>${i.minLevel}</td><td>${statusBadge(i.status)}</td></tr>`).join('')}</tbody></table></div>`}
    </div>
    <div class="card">
      <div class="card-head"><div class="card-title">Recent Delivery Notes</div>
        ${can('createDN') ? `<button class="btn btn-primary btn-sm" id="newDnBtn">+ New Delivery Note</button>` : ''}</div>
      ${recentDns.length === 0 ? `<div class="empty">No delivery notes yet.</div>` : `
      <div class="tbl-wrap"><table><thead><tr><th>DN No.</th><th>Client</th><th>Branch</th><th>Status</th></tr></thead>
      <tbody>${recentDns.map(d => `<tr><td style="font-family:var(--mono)">${d.dnNumber}</td><td>${d.clientCompany || '—'}</td><td>${d.location}</td><td><span class="badge ${d.status === 'Issued' ? 'badge-issued' : 'badge-draft'}">${d.status}</span></td></tr>`).join('')}</tbody></table></div>`}
    </div>
  </div>
  <div class="card">
    <div class="card-head"><div class="card-title">Recent Stock Movements</div>
      <button class="btn btn-ghost btn-sm" data-tab="movements">View All</button></div>
    ${recentMv.length === 0 ? `<div class="empty">No movements logged yet.</div>` : `
    <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Item</th><th>Action</th><th>Qty</th><th>Reference</th><th>By</th></tr></thead>
    <tbody>${recentMv.map(m => {
      const it = findItem(m.itemId);
      const cls = m.action === 'IN' ? 'pill-in' : m.action === 'OUT' ? 'pill-out' : 'pill-adj';
      return `<tr><td>${fmtDate(m.date)}</td><td>${it ? it.description : '(deleted item)'}</td><td class="${cls}">${m.action}</td><td>${m.qty}</td><td>${m.reference || '—'}</td><td>${m.by || '—'}</td></tr>`;
    }).join('')}</tbody></table></div>`}
  </div>
  ${showValue ? `<div class="shared-note">Stock Value (at cost) ${state.branch === 'All' ? 'across all branches' : 'for ' + state.branch}: ${state.company.currency} ${fmtMoney(stockValue)}</div>` : ''}
  `;
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
  list.sort((a, b) => b.createdAt - a.createdAt);
  return `
  <div class="toolbar">
    <div style="flex:1"></div>
    ${can('createDN') ? `<button class="btn btn-primary" id="newDnBtn2">+ New Delivery Note</button>` : ''}
  </div>
  <div class="card">
    <div class="tbl-wrap"><table>
      <thead><tr><th>DN No.</th><th>Date</th><th>Client / Project</th><th>LPO #</th><th>Invoice #</th><th>Branch</th><th>Items</th><th>Status</th><th></th></tr></thead>
      <tbody>
      ${list.length === 0 ? `<tr><td colspan="9"><div class="empty"><div class="big">📄</div>No delivery notes yet.</div></td></tr>` :
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
function renderClients() {
  const list = [...state.clients].sort((a, b) => a.companyName.localeCompare(b.companyName));
  return `
  <div class="toolbar">
    <div style="flex:1"></div>
    <button class="btn btn-primary" id="addClientBtn">+ Add Client</button>
  </div>
  <div class="card">
    <div class="tbl-wrap"><table>
      <thead><tr><th>Company Name</th><th>Contact Person</th><th>Phone</th><th>Email</th><th>Address</th><th></th></tr></thead>
      <tbody>
      ${list.length === 0 ? `<tr><td colspan="6"><div class="empty"><div class="big">🏢</div>No clients yet.</div></td></tr>` :
        list.map(c => `
        <tr>
          <td><strong>${c.companyName}</strong></td>
          <td>${c.contactPerson || '—'}</td>
          <td>${c.phone || '—'}</td>
          <td>${c.email || '—'}</td>
          <td>${c.address || '—'}</td>
          <td><button class="btn btn-outline btn-sm" data-edit-client="${c.id}">Edit</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </div>`;
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
          <td style="font-family:var(--mono);font-weight:700;font-size:12px;">${q.quotationNumber || '<span class="muted">(draft)</span>'}</td>
          <td><span class="tag">${QUOTE_TYPE_LABEL[q.type]}</span></td>
          <td>${q.clientCompany}</td>
          <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${q.subject || q.siteDetail || '—'}</td>
          <td>${fmtDate(q.date)}</td>
          <td style="font-family:var(--mono);">${state.company.currency} ${fmtMoney(q.totals.total)}</td>
          <td>${quoteStatusBadge(q.status)}</td>
          <td><button class="btn btn-outline btn-sm" data-view-quote="${q.id}">Open</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </div>`;
}

/* ---------------- Job Orders ---------------- */
function renderJobOrders() {
  const list = [...state.jobOrders].sort((a, b) => b.createdAt - a.createdAt);
  return `
  <div class="card">
    <div class="tbl-wrap"><table>
      <thead><tr><th>Job Order #</th><th>From Quote</th><th>Type</th><th>Client</th><th>Subject / Site</th><th>Value</th><th>Status</th></tr></thead>
      <tbody>
      ${list.length === 0 ? `<tr><td colspan="7"><div class="empty"><div class="big">🛠️</div>No job orders yet. These are created from accepted quotations.</div></td></tr>` :
        list.map(jo => `
        <tr>
          <td style="font-family:var(--mono);font-weight:700;">${jo.jobOrderNumber}</td>
          <td style="font-family:var(--mono);font-size:12px;">${jo.quotationNumber || '—'}</td>
          <td><span class="tag">${QUOTE_TYPE_LABEL[jo.type]}</span></td>
          <td>${jo.clientCompany}</td>
          <td>${jo.subject || jo.siteDetail || '—'}</td>
          <td style="font-family:var(--mono);">${state.company.currency} ${fmtMoney(jo.value)}</td>
          <td><span class="badge badge-in">${jo.status}</span></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </div>
  <div class="shared-note">Job Orders are created automatically when you convert an accepted quotation. Material requests, procurement, and completion reports build on top of this in the next phase.</div>
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
      <div class="muted">${q.status === 'PendingApproval' ? 'PENDING APPROVAL' : q.status.toUpperCase()}</div>
    </div>
  </div>
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
    <div class="card-head"><div class="card-title">Users <span>${state.users.length} user(s)</span></div>
      <button class="btn btn-primary btn-sm" id="addUserBtn">+ Add User</button></div>
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
  if (type === 'client') return modalWrap(renderClientForm(payload), 'Client Details');
  if (type === 'userEdit') return modalWrap(renderUserForm(payload), 'User Details');
  if (type === 'forcePwd') return modalWrap(renderForcePwdForm(payload), 'Change Your Password');
  if (type === 'changePwd') return modalWrap(renderChangePwdForm(payload), 'Change Password');
  if (type === 'newDn') return modalWrap(renderDnForm(payload), 'New Delivery Note', true);
  if (type === 'viewDn') return modalWrap(renderDnView(payload), '', true);
  if (type === 'invReport') return modalWrap(renderInventoryReportView(), '', true);
  if (type === 'newQuote') return modalWrap(renderQuoteForm(payload), payload.id ? 'Edit Quotation' : 'New Quotation', true);
  if (type === 'viewQuote') return modalWrap(renderQuoteView(payload), '', true);
  if (type === 'exclusionsLib') return modalWrap(renderExclusionsLibrary(payload), 'Exclusions & Terms Library');
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
  <div class="field"><label>Company Name</label><input id="c_companyName" value="${client.companyName || ''}" placeholder="e.g. Edge Technical Solutions LLC"></div>
  <div class="grid2">
    <div class="field"><label>Contact Person</label><input id="c_contactPerson" value="${client.contactPerson || ''}"></div>
    <div class="field"><label>Phone</label><input id="c_phone" value="${client.phone || ''}" placeholder="+971 5xx xxx xxx"></div>
  </div>
  <div class="grid2">
    <div class="field"><label>Email</label><input id="c_email" type="email" value="${client.email || ''}"></div>
    <div class="field"><label>Address</label><input id="c_address" value="${client.address || ''}"></div>
  </div>
  <div style="display:flex;justify-content:space-between;margin-top:8px;">
    <div>${isEdit ? `<button class="btn btn-danger" id="deleteClientBtn">Delete Client</button>` : ''}</div>
    <div style="display:flex;gap:8px;"><button class="btn btn-ghost" id="modalCancel">Cancel</button><button class="btn btn-primary" id="saveClientBtn">${isEdit ? 'Save Changes' : 'Add Client'}</button></div>
  </div>
  `;
}

function renderUserForm(user) {
  const isEdit = !!user.id;
  return `
  <div class="field"><label>Name</label><input id="u_name" value="${user.name || ''}" placeholder="Full name"></div>
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
    <div class="field"><label>Issued By</label><input id="dn_issuedBy" value="${payload.issuedBy || state.user.name}"></div>
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
  const contactLine = [co.address, co.phone, co.email, co.website].filter(Boolean).join(' · ');
  return `
  <div id="printArea" class="dn-doc">
    <div class="dn-head">
      <div style="display:flex;gap:14px;align-items:center;">
        ${co.logoPath ? `<img src="${co.logoPath}" class="dn-logo" style="height:${logoSizePx(co.logoSize)}px;max-width:220px;object-fit:contain;" alt="${co.name} logo">` : ''}
        <div>
          <div class="dn-company">${co.name}</div>
          <div class="dn-company-sub">${contactLine}</div>
          ${co.vatNumber ? `<div class="dn-company-sub">TRN/VAT: ${co.vatNumber}</div>` : ''}
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
    ${co.reportFooter ? `<div class="dn-footer-note">${co.reportFooter}</div>` : ''}
    <div class="dn-footer-note">This delivery note was generated by the ${co.name} Inventory &amp; Delivery system. ${dn.status === 'Issued' ? 'Issuing this note automatically deducted the listed quantities from stock.' : 'This is a draft — stock has not been deducted yet.'}</div>
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
  document.body.appendChild(mount);
  window.print();
  const cleanup = () => { document.getElementById('printMount')?.remove(); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  setTimeout(cleanup, 8000); // fallback in case afterprint doesn't fire (varies by browser/print-to-PDF flow)
}

function attachHandlers() {
  document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', e => {
    setTab(e.currentTarget.getAttribute('data-tab'));
  }));
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

  const addClientBtn = document.getElementById('addClientBtn');
  if (addClientBtn) addClientBtn.addEventListener('click', () => openModal('client', {}));
  document.querySelectorAll('[data-edit-client]').forEach(b => b.addEventListener('click', e => {
    openModal('client', { ...state.clients.find(c => c.id === e.currentTarget.getAttribute('data-edit-client')) });
  }));

  const newQuoteBtn = document.getElementById('newQuoteBtn');
  if (newQuoteBtn) newQuoteBtn.addEventListener('click', () => openModal('newQuote', {}));
  const quoteStatusFilter = document.getElementById('quoteStatusFilter');
  if (quoteStatusFilter) quoteStatusFilter.addEventListener('change', e => { state.quoteFilter = e.target.value; render(); });
  document.querySelectorAll('[data-view-quote]').forEach(b => b.addEventListener('click', e => {
    openModal('viewQuote', findQuote(e.currentTarget.getAttribute('data-view-quote')));
  }));
  document.querySelectorAll('[data-choose-quote-type]').forEach(b => b.addEventListener('click', e => {
    openModal('newQuote', { type: e.currentTarget.getAttribute('data-choose-quote-type'), lineItems: [], sitesCovered: [], exclusions: [] });
  }));

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
  attachUserFormHandlers();
  attachPwdFormHandlers();
  attachQuoteFormHandlers();
  attachQuoteViewHandlers();
  attachExclusionsLibraryHandlers();
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
  p.issuedBy = val('dn_issuedBy'); p.receivedBy = val('dn_receivedBy'); p.remarks = val('dn_remarks');
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
    location: val('dn_location'), issuedBy: val('dn_issuedBy').trim(), receivedBy: val('dn_receivedBy').trim(),
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
    const body = { companyName, contactPerson: val('c_contactPerson').trim(), phone: val('c_phone').trim(), email: val('c_email').trim(), address: val('c_address').trim() };
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
