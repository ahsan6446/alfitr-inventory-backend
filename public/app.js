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

  const [company, branchesR, brandsR, unitsR, itemsR, movementsR, clientsR, dnsR] = await Promise.all([
    api('GET', '/api/company'),
    api('GET', '/api/meta/branches'),
    api('GET', '/api/meta/brands'),
    api('GET', '/api/meta/units'),
    api('GET', '/api/items'),
    api('GET', '/api/movements'),
    api('GET', '/api/clients'),
    api('GET', '/api/dns'),
  ]);
  state.company = company.company; state.nextDnPreview = company.nextDnPreview;
  state.branches = branchesR.branches; state.brands = brandsR.brands; state.units = unitsR.units;
  state.items = itemsR.items; state.movements = movementsR.movements; state.clients = clientsR.clients; state.dns = dnsR.dns;

  if (can('manageUsers')) {
    const [usersR, rolesR] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/users/roles/all')]);
    state.users = usersR.users; state.roles = rolesR.roles; state.permLabels = rolesR.labels;
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
  return `
  <div class="toolbar">
    <div style="flex:1"></div>
    ${can('manageStock') ? `<button class="btn btn-primary" id="addMvBtn">+ Log Movement</button>` : ''}
  </div>
  <div class="card">
    <div class="tbl-wrap"><table>
      <thead><tr><th>Date</th><th>Item</th><th>Branch</th><th>Action</th><th>Qty</th><th>Reference</th><th>By</th><th>Linked DN</th></tr></thead>
      <tbody>
      ${list.length === 0 ? `<tr><td colspan="8"><div class="empty"><div class="big">🧾</div>No stock movements logged yet.</div></td></tr>` :
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
            <td>${m.by || '—'}</td>
            <td>${dn ? `<span class="tag">${dn.dnNumber}</span>` : '—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>
  </div>`;
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
      <div class="field"><label>Report Footer Text</label><textarea id="setReportFooter" rows="2" ${can('manageInventory') ? '' : 'disabled'}>${co.reportFooter || ''}</textarea></div>
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

  ${can('manageUsers') ? renderUsersRolesSettings() : `<div class="card"><div class="card-title" style="margin-bottom:6px;">Users &amp; Roles</div><p class="muted" style="margin:0;">Only Super Admin can manage users, roles and permissions.</p></div>`}

  <div class="shared-note">Pricing visibility, negative-stock rules and user permissions here are enforced by the server on every request — not just hidden in this screen.</div>
  `;
}

function renderUsersRolesSettings() {
  return `
  <div class="card">
    <div class="card-head"><div class="card-title">Users <span>${state.users.length} user(s)</span></div>
      <button class="btn btn-primary btn-sm" id="addUserBtn">+ Add User</button></div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Active</th><th></th></tr></thead>
      <tbody>
      ${state.users.map(u => `
        <tr>
          <td><strong>${u.name}</strong></td>
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
  if (type === 'movement') return modalWrap(renderMovementForm(payload), 'Log Stock Movement');
  if (type === 'client') return modalWrap(renderClientForm(payload), 'Client Details');
  if (type === 'userEdit') return modalWrap(renderUserForm(payload), 'User Details');
  if (type === 'forcePwd') return modalWrap(renderForcePwdForm(payload), 'Change Your Password');
  if (type === 'changePwd') return modalWrap(renderChangePwdForm(payload), 'Change Password');
  if (type === 'newDn') return modalWrap(renderDnForm(payload), 'New Delivery Note', true);
  if (type === 'viewDn') return modalWrap(renderDnView(payload), '', true);
  if (type === 'invReport') return modalWrap(renderInventoryReportView(), '', true);
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
        <option value="IN">IN (Received)</option>
        <option value="OUT">OUT (Issued)</option>
        <option value="ADJUSTMENT">ADJUSTMENT (Correction)</option>
      </select>
    </div>
    <div class="field"><label>Quantity</label><input type="number" id="mv_qty" placeholder="e.g. 10"></div>
    <div class="field"><label>Date</label><input type="date" id="mv_date" value="${new Date().toISOString().slice(0, 10)}"></div>
  </div>
  <div class="grid2">
    <div class="field"><label>Reference / Project</label><input id="mv_ref" placeholder="PO number, project name…"></div>
    <div class="field"><label>Issued / Received By</label><input id="mv_by" value="${state.user.name}"></div>
  </div>
  <div class="muted" style="margin-bottom:10px;">IN/OUT must be a positive quantity. ADJUSTMENT can be negative (e.g. -3) to reduce stock.</div>
  <div style="display:flex;justify-content:flex-end;gap:8px;">
    <button class="btn btn-ghost" id="modalCancel">Cancel</button>
    <button class="btn btn-primary" id="saveMvBtn">Log Movement</button>
  </div>
  `;
}

/* ---------------- Delivery note form / view ---------------- */
function renderDnForm(payload) {
  const lines = payload.lines || [{ itemId: '', qty: 1 }];
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
      <div style="display:flex;gap:14px;align-items:flex-start;">
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
      <div style="display:flex;gap:14px;align-items:flex-start;">
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
    ${co.reportFooter ? `<div class="dn-footer-note">${co.reportFooter}</div>` : ''}
  </div>
  <div class="no-print" style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px;">
    <button class="btn btn-ghost" id="modalCancel">Close</button>
    <button class="btn btn-teal" id="printReportBtn">Print</button>
  </div>
  `;
}

/* ================= EVENT HANDLING ================= */
function val(id) { const el = document.getElementById(id); return el ? el.value : ''; }

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
  if (printReportBtn) printReportBtn.addEventListener('click', () => window.print());

  const addMvBtn = document.getElementById('addMvBtn');
  if (addMvBtn) addMvBtn.addEventListener('click', () => openModal('movement', {}));

  document.querySelectorAll('[data-view-dn]').forEach(b => b.addEventListener('click', e => {
    openModal('viewDn', state.dns.find(d => d.id === e.currentTarget.getAttribute('data-view-dn')));
  }));

  const addClientBtn = document.getElementById('addClientBtn');
  if (addClientBtn) addClientBtn.addEventListener('click', () => openModal('client', {}));
  document.querySelectorAll('[data-edit-client]').forEach(b => b.addEventListener('click', e => {
    openModal('client', { ...state.clients.find(c => c.id === e.currentTarget.getAttribute('data-edit-client')) });
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
    try {
      await api('POST', '/api/movements', { itemId, action, qty, date: val('mv_date'), reference: val('mv_ref').trim(), by: val('mv_by').trim() });
      await loadAll();
      showToast('Movement logged — Qty On Hand updated.', 'ok');
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
    const p = state.modal.payload; p.lines = collectDnLines(); p.lines.push({ itemId: '', qty: 1 }); syncDnPayload(p); render();
  });
  document.querySelectorAll('.removeDnLine').forEach(b => b.addEventListener('click', e => {
    const idx = Number(e.currentTarget.getAttribute('data-idx'));
    const p = state.modal.payload; p.lines = collectDnLines(); p.lines.splice(idx, 1);
    if (p.lines.length === 0) p.lines.push({ itemId: '', qty: 1 });
    syncDnPayload(p); render();
  }));
  document.querySelectorAll('.dnLineItem').forEach(s => s.addEventListener('change', () => {
    const p = state.modal.payload; p.lines = collectDnLines(); syncDnPayload(p); render();
  }));
  const locSel = document.getElementById('dn_location');
  if (locSel) locSel.addEventListener('change', () => {
    const p = state.modal.payload; p.lines = [{ itemId: '', qty: 1 }]; syncDnPayload(p); render();
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
    lines.push({ itemId: sel.value, qty: Number(qtyEl ? qtyEl.value : 1) || 0 });
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
  if (printBtn) printBtn.addEventListener('click', () => window.print());
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
    try {
      if (existing) {
        const body = { name, role: val('u_role'), active: val('u_active') === 'true' };
        const newPwd = val('u_newPassword');
        if (newPwd) body.password = newPwd;
        await api('PUT', '/api/users/' + existing, body);
      } else {
        const username = val('u_username').trim();
        const password = val('u_password');
        if (!username || !password) { showToast('Username and temporary password are required.', 'err'); return; }
        await api('POST', '/api/users', { name, username, password, role: val('u_role'), active: val('u_active') === 'true' });
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
