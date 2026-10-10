/**
 * KickCanvas admin panel. Every read and write goes through the server functions, which check the
 * signed admin session on each request; this file holds no secrets and grants no access itself.
 */
import { ORDER_STATUSES, STATUS_FLOW, LIMITS, FIELD_LABELS } from '/js/data/site-config.js';
import { PRODUCTS, PALETTE, partLabel } from '/js/data/products.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '₹' + Math.round(n || 0).toLocaleString('en-IN');
const when = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const whenLong = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const pill = (s) => `<span class="pill" data-s="${esc(s)}">${esc(ORDER_STATUSES[s]?.label || s)}</span>`;
const colourName = (hex) => PALETTE.find((c) => c.hex.toLowerCase() === String(hex).toLowerCase())?.name || String(hex).toUpperCase();

const state = { orders: [], stats: null, filter: 'all', query: '', settings: null, live: null, hasDraft: false, dirty: false, openId: null };

/* ------------------------------------------------------------------ api */
class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
async function api(fn, { method = 'GET', body } = {}) {
  const headers = {};
  if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['X-KC-Admin'] = '1'; }
  let res;
  try {
    res = await fetch(`/.netlify/functions/${fn}`, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError('Can’t reach the server. Check your connection and try again.', 0);
  }
  let data = null; try { data = await res.json(); } catch {}
  if (res.status === 404 && !data) throw new ApiError('The admin service isn’t running on this deploy. Deploy the site from GitHub so the server functions are included (see ADMIN-SETUP.md).', 404);
  if (res.status === 401 && fn !== 'admin-auth') { showLogin('Your session ended. Please sign in again.'); throw new ApiError('Signed out', 401); }
  if (!res.ok || data?.ok === false) throw new ApiError(data?.error || `Request failed (${res.status}).`, res.status);
  return data;
}

function toast(msg, tone = '') {
  const t = document.createElement('div');
  t.className = 'toast'; if (tone) t.dataset.tone = tone; t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), tone === 'error' ? 6000 : 3200);
}

/* ------------------------------------------------------------------ auth */
function showLogin(message = '', tone = '') {
  $('#viewApp').hidden = true;
  $('#viewLogin').hidden = false;
  const m = $('#loginMsg'); m.textContent = message; if (tone) m.dataset.tone = tone; else delete m.dataset.tone;
  $('#loginUser').focus();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#loginBtn');
  const username = $('#loginUser').value.trim(), password = $('#loginPass').value;
  if (!username || !password) { showLogin('Enter your username and password.'); return; }
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    await api('admin-auth', { method: 'POST', body: { action: 'login', username, password } });
    $('#loginPass').value = '';
    await startApp();
  } catch (err) {
    showLogin(err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Sign in';
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('admin-auth', { method: 'POST', body: { action: 'logout' } }); } catch {}
  state.orders = []; state.settings = null;
  showLogin('You’re signed out.', 'info');
});

/* ------------------------------------------------------------------ routing */
const TABS = ['dashboard', 'orders', 'products', 'content'];
function route() {
  const tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard';
  TABS.forEach((t) => { $(`#tab-${t}`).hidden = t !== tab; });
  $$('.bar__nav a').forEach((a) => a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false'));
  $('#publishBar').hidden = !(tab === 'products' || tab === 'content');
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

/* ------------------------------------------------------------------ orders data */
async function loadOrders({ quiet = false } = {}) {
  try {
    const data = await api('admin-orders');
    state.orders = data.orders; state.stats = data.stats;
    renderDashboard(); renderFilters(); renderOrders();
    if (!quiet) toast('Orders refreshed');
  } catch (err) { if (err.status !== 401) toast(err.message, 'error'); }
}
$$('[data-refresh]').forEach((b) => b.addEventListener('click', () => loadOrders()));

const custom = (o) => o.items.map((i) => `${i.name} · ${i.summary.left}`).join(' | ');

function renderDashboard() {
  const s = state.stats, c = s.count;
  const pending = state.orders.filter((o) => o.status === 'pending');
  $('#navPending').hidden = !pending.length;
  $('#navPending').textContent = pending.length;
  const q = $('#queue');
  q.classList.toggle('queue--empty', !pending.length);
  q.innerHTML = `
    <div class="queue__head"><span class="queue__n">${pending.length}</span><h2>${pending.length === 1 ? 'order needs' : 'orders need'} your confirmation</h2></div>
    <p class="queue__lead">${pending.length ? 'Customers see these as Pending Confirmation until you approve or reject them.' : 'Nothing is waiting. New orders appear here as soon as customers place them.'}</p>
    ${pending.slice(0, 8).map((o) => `
      <div class="queue__row">
        <div class="queue__who">
          <b>${esc(o.id)}</b> · ${esc(o.customer.name)} · <b>${money(o.totals.total)}</b>
          <p>${esc(when(o.createdAt))} · ${esc(o.customer.city)} · ${esc(custom(o))}</p>
        </div>
        <div class="queue__acts">
          <button class="btn btn--ghost btn--sm" type="button" data-open="${esc(o.id)}">Review</button>
          <button class="btn btn--danger btn--sm" type="button" data-act="rejected" data-id="${esc(o.id)}">Reject</button>
          <button class="btn btn--primary btn--sm" type="button" data-act="confirmed" data-id="${esc(o.id)}">Approve</button>
        </div>
      </div>`).join('')}
    ${pending.length > 8 ? `<p class="queue__lead" style="margin-top:12px"><a href="#orders" data-filter-link="pending">See all ${pending.length} pending orders</a></p>` : ''}`;
  const fig = (label, n, filter, extra = '') => `<div><a href="#orders" data-filter-link="${filter}"><dt>${label}</dt><dd>${n}${extra}</dd></a></div>`;
  $('#figures').innerHTML =
    fig('Total orders', s.total, 'all') + fig('Pending', c.pending, 'pending') + fig('Confirmed', c.confirmed, 'confirmed')
    + fig('Processing', c.processing, 'processing') + fig('Shipped', c.shipped, 'shipped') + fig('Delivered', c.delivered, 'delivered')
    + fig('Rejected or cancelled', c.rejected + c.cancelled, 'closed');
  $('#money').innerHTML = `
    <div><dt>Requested</dt><dd>${money(s.requested)}<small>Every order placed, whatever its status</small></dd></div>
    <div><dt>Awaiting confirmation</dt><dd>${money(s.pendingValue)}<small>Pending orders not yet approved</small></dd></div>
    <div><dt>Confirmed sales</dt><dd>${money(s.confirmedSales)}<small>Confirmed, processing, shipped and delivered</small></dd></div>`;
}

document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-filter-link]');
  if (link) { state.filter = link.dataset.filterLink; renderFilters(); renderOrders(); }
  const open = e.target.closest('[data-open]');
  if (open) openOrder(open.dataset.open);
  const act = e.target.closest('[data-act]');
  if (act) changeStatus(act.dataset.id, act.dataset.act);
});

const FILTERS = [['all', 'All'], ...Object.entries(ORDER_STATUSES).map(([k, v]) => [k, v.label])];
function renderFilters() {
  const n = (k) => (k === 'all' ? state.orders.length : k === 'closed' ? state.orders.filter((o) => ['rejected', 'cancelled'].includes(o.status)).length : state.orders.filter((o) => o.status === k).length);
  const list = state.filter === 'closed' ? [...FILTERS, ['closed', 'Rejected or cancelled']] : FILTERS;
  $('#filters').innerHTML = list.map(([k, label]) =>
    `<button type="button" data-filter="${k}" aria-pressed="${state.filter === k}">${esc(label)}<span>${n(k)}</span></button>`).join('');
}
$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]'); if (!b) return;
  state.filter = b.dataset.filter; renderFilters(); renderOrders();
});
$('#orderSearch').addEventListener('input', (e) => { state.query = e.target.value.trim().toLowerCase(); renderOrders(); });

function visibleOrders() {
  return state.orders.filter((o) => {
    if (state.filter === 'closed' ? !['rejected', 'cancelled'].includes(o.status) : state.filter !== 'all' && o.status !== state.filter) return false;
    if (!state.query) return true;
    const c = o.customer;
    return [o.id, c.name, c.email, c.phone, c.city, c.pincode].join(' ').toLowerCase().includes(state.query);
  });
}

function renderOrders() {
  const list = visibleOrders();
  $('#ordersBody').innerHTML = list.map((o) => {
    const c = o.customer, qty = o.items.reduce((n, i) => n + i.qty, 0);
    return `<tr>
      <td data-k="order"><span class="id">${esc(o.id)}</span><span class="sm">${esc(when(o.createdAt))}</span></td>
      <td data-k="customer" class="wrap">${esc(c.name)}<span class="sm">${esc(c.phone)} · ${esc(c.email)}</span></td>
      <td data-k="delivery" class="wrap">${esc(c.address)}${c.apt ? `, ${esc(c.apt)}` : ''}<span class="sm">${esc(c.city)}, ${esc(c.state)} ${esc(c.pincode)}</span></td>
      <td data-k="items" class="wrap">${o.items.map((i) => `${esc(i.name)} <span class="sm">${esc(i.size)} · ${esc(i.summary.left)}</span>`).join('')}</td>
      <td data-k="qty" class="r">${qty}</td>
      <td data-k="total" class="r">${money(o.totals.total)}</td>
      <td data-k="payment">${esc(o.paymentMethod)}</td>
      <td data-k="status">${pill(o.status)}</td>
      <td data-k="act"><button class="btn btn--ghost btn--sm" type="button" data-open="${esc(o.id)}">View</button></td>
    </tr>`;
  }).join('');
  const empty = $('#ordersEmpty');
  empty.hidden = list.length > 0;
  $('#ordersTable').hidden = list.length === 0;
  empty.textContent = !state.orders.length ? 'No orders yet. When a customer places an order it appears here with status Pending Confirmation.'
    : state.query ? `No orders match “${state.query}”.` : 'No orders with this status.';
}

/* ------------------------------------------------------------------ order detail + status */
const ACTION = {
  confirmed: ['Approve order', 'btn--primary'], rejected: ['Reject order', 'btn--danger'],
  processing: ['Mark as processing', 'btn--primary'], shipped: ['Mark as shipped', 'btn--primary'],
  delivered: ['Mark as delivered', 'btn--primary'], cancelled: ['Cancel order', 'btn--danger'],
};

function designLines(item, side) {
  const d = item.design?.[side] || { parts: {}, decals: [] };
  const parts = Object.entries(d.parts || {});
  const swatches = parts.length
    ? `<div class="swatchrow">${parts.map(([k, v]) => `<span><i style="background:${esc(v.color)}"></i>${esc(partLabel(item.model, k))}: ${esc(colourName(v.color))}</span>`).join('')}</div>`
    : '<p class="muted">Original colours</p>';
  const prints = (d.decals || []).map((x) => (x.type === 'text' ? `Text “${esc(x.text)}”` : 'Uploaded artwork')).join(', ');
  return swatches + (prints ? `<p>Prints: ${prints}</p>` : '');
}

function openOrder(id) {
  const o = state.orders.find((x) => x.id === id); if (!o) return;
  state.openId = id;
  const c = o.customer, t = o.totals;
  $('#drawerTitle').innerHTML = `${esc(o.id)} ${pill(o.status)}`;
  $('#drawerBody').innerHTML = `
    <dl class="kv">
      <dt>Placed</dt><dd>${esc(whenLong(o.createdAt))}</dd>
      <dt>Customer</dt><dd>${esc(c.name)}</dd>
      <dt>Phone</dt><dd><a href="tel:+91${esc(c.phone)}">${esc(c.phone)}</a></dd>
      <dt>Email</dt><dd><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></dd>
      <dt>Deliver to</dt><dd>${esc(c.address)}${c.apt ? `, ${esc(c.apt)}` : ''}<br>${esc(c.city)}, ${esc(c.state)} ${esc(c.pincode)}</dd>
      <dt>Payment</dt><dd>${esc(o.paymentMethod)} · collect ${money(t.total)}</dd>
    </dl>
    <div class="d-sec"><h3>Sneakers</h3>
      ${o.items.map((i) => `
        <div class="d-item">
          ${i.preview ? `<img src="${i.preview}" alt="Customer’s ${esc(i.name)} design">` : '<div class="noimg">No preview</div>'}
          <div>
            <b>${esc(i.name)}</b>
            <p>${esc(i.size)} · ${i.qty} pair${i.qty > 1 ? 's' : ''} · ${money(i.unitPrice)} each · ${money(i.lineTotal)}</p>
            <p>Finish: <b>${esc(i.finishLabel)}</b> (whole sneaker) · ${i.pairMode === 'split' ? 'left and right differ' : 'matched pair'}</p>
            ${i.pairMode === 'split' ? `<p><b>Left</b></p>${designLines(i, 'left')}<p><b>Right</b></p>${designLines(i, 'right')}` : designLines(i, 'left')}
          </div>
        </div>`).join('')}
    </div>
    <div class="d-sec"><h3>Total</h3>
      <dl class="kv">
        <dt>Subtotal</dt><dd>${money(t.subtotal)}</dd>
        ${t.discount ? `<dt>Discount</dt><dd>−${money(t.discount)} (${esc(o.coupon)})</dd>` : ''}
        <dt>Shipping</dt><dd>${t.shipping ? money(t.shipping) : 'Free'}</dd>
        <dt>Total</dt><dd><b>${money(t.total)}</b></dd>
      </dl>
    </div>
    <div class="d-sec"><h3>History</h3>
      <ol class="timeline">${o.history.map((h) => `<li><b>${esc(ORDER_STATUSES[h.status]?.label)}</b><span class="muted">${esc(whenLong(h.at))} · ${h.by === 'customer' ? 'placed by the customer' : `by ${esc(h.by)}`}${h.note ? ` · “${esc(h.note)}”` : ''}</span></li>`).join('')}</ol>
    </div>`;
  const next = STATUS_FLOW[o.status] || [];
  $('#drawerActions').innerHTML = next.map((s) => `<button class="btn ${ACTION[s][1]}" type="button" data-act="${s}" data-id="${esc(o.id)}">${ACTION[s][0]}</button>`).join('');
  const dlg = $('#orderDrawer');
  if (!dlg.open) dlg.showModal();
}
$('#orderDrawer').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]') || e.target === e.currentTarget) { e.currentTarget.close(); state.openId = null; }
});

function askReason(status) {
  const dlg = $('#reasonDlg');
  const reject = status === 'rejected';
  $('#reasonTitle').textContent = reject ? 'Reject this order?' : 'Cancel this order?';
  $('#reasonText').textContent = `The customer will see the order as ${reject ? 'Rejected' : 'Cancelled'}. This can’t be undone.`;
  $('#reasonOk').textContent = reject ? 'Reject order' : 'Cancel order';
  $('#reasonInput').value = '';
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? $('#reasonInput').value.trim() : null), { once: true });
    dlg.showModal();
    $('#reasonInput').focus();
  });
}

const DONE = { confirmed: 'Order approved', rejected: 'Order rejected', processing: 'Marked as processing', shipped: 'Marked as shipped', delivered: 'Marked as delivered', cancelled: 'Order cancelled' };

async function changeStatus(id, status) {
  let note = '';
  if (status === 'rejected' || status === 'cancelled') {
    note = await askReason(status);
    if (note === null) return;
  }
  $$(`[data-act][data-id="${id}"]`).forEach((b) => { b.disabled = true; });
  try {
    const data = await api('admin-orders', { method: 'POST', body: { id, status, note } });
    const i = state.orders.findIndex((o) => o.id === id);
    if (i >= 0) state.orders[i] = data.order;
    toast(`${DONE[status]} · ${id}`);
    await loadOrders({ quiet: true });
    if (state.openId === id) openOrder(id);
  } catch (err) {
    if (err.status !== 401) toast(err.message, 'error');
    $$(`[data-act][data-id="${id}"]`).forEach((b) => { b.disabled = false; });
    if (err.status === 409) await loadOrders({ quiet: true });
  }
}

/* ------------------------------------------------------------------ settings: products + website */
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
const setPath = (obj, path, v) => { const ks = path.split('.'); const last = ks.pop(); ks.reduce((o, k) => o[k], obj)[last] = v; };

async function loadSettings() {
  try {
    const data = await api('admin-settings');
    state.live = data.live; state.settings = structuredClone(data.draft); state.hasDraft = data.hasDraft; state.dirty = false;
    renderProducts(); fillContent(); renderPublishState();
  } catch (err) { if (err.status !== 401) toast(err.message, 'error'); }
}

function renderProducts() {
  $('#productsHost').innerHTML = Object.entries(state.settings.products).map(([id, p]) => `
    <article class="product" data-off="${!p.enabled || !p.visible}">
      <img class="product__img" src="/assets/posters/${esc(id)}-card.jpg" alt="" loading="lazy">
      <div class="product__body">
        <span class="product__id">${esc(PRODUCTS[id]?.tagline || '')} · model ${esc(id)}</span>
        <div class="field"><label for="p-${id}-name">Name</label><input id="p-${id}-name" maxlength="${LIMITS.name}" data-path="products.${id}.name"></div>
        <div class="field"><label for="p-${id}-price">Base price per pair (₹)</label><input id="p-${id}-price" type="number" min="0" max="100000" step="1" inputmode="numeric" data-path="products.${id}.price"></div>
        <div class="field"><label for="p-${id}-blurb">Description</label><textarea id="p-${id}-blurb" rows="3" maxlength="${LIMITS.blurb}" data-path="products.${id}.blurb"></textarea></div>
        <div class="switches">
          <label class="switch"><input type="checkbox" data-path="products.${id}.visible"><span>Show on website</span></label>
          <label class="switch"><input type="checkbox" data-path="products.${id}.enabled"><span>Can be ordered</span></label>
        </div>
      </div>
    </article>`).join('');
  bindFields($('#productsHost'));
}

function fillContent() { bindFields($('#contentForm')); }

function bindFields(root) {
  $$('[data-path]', root).forEach((el) => {
    const v = getPath(state.settings, el.dataset.path);
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? '';
    const key = el.dataset.path.split('.').pop();
    if (el.type !== 'checkbox' && el.type !== 'number' && LIMITS[key] && typeof LIMITS[key] === 'number') el.maxLength = LIMITS[key];
    el.oninput = el.onchange = () => {
      const val = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value;
      setPath(state.settings, el.dataset.path, val);
      el.removeAttribute('aria-invalid');
      if (el.dataset.path.startsWith('products.')) el.closest('.product').dataset.off = String(!getPath(state.settings, el.dataset.path.replace(/\.\w+$/, '.enabled')) || !getPath(state.settings, el.dataset.path.replace(/\.\w+$/, '.visible')));
      state.dirty = true; renderPublishState();
    };
  });
}

function renderPublishState() {
  const el = $('#publishState');
  if (state.dirty) { el.textContent = 'You have unsaved changes.'; el.dataset.dirty = 'true'; }
  else if (state.hasDraft) { el.textContent = 'Draft saved. Preview it, then publish to update the live site.'; el.dataset.dirty = 'true'; }
  else { el.textContent = 'All changes are published.'; delete el.dataset.dirty; }
  $('#publishBtn').disabled = !state.dirty && !state.hasDraft;
  $('#discardBtn').disabled = !state.dirty && !state.hasDraft;
}

async function saveDraft({ silent = false } = {}) {
  try {
    const data = await api('admin-settings', { method: 'PUT', body: { settings: state.settings } });
    state.settings = structuredClone(data.draft); state.hasDraft = data.hasDraft; state.dirty = false;
    renderPublishState();
    if (!silent) toast('Draft saved');
    return true;
  } catch (err) {
    if (err.status !== 401) toast(err.message, 'error');
    flagInvalid(err.message);
    return false;
  }
}

/** Point at the field the server rejected: its error starts with that field's label. */
function flagInvalid(message) {
  const m = String(message || '');
  const el = $$('[data-path]').find((f) => {
    const [group, id, key] = f.dataset.path.split('.');
    if (group === 'products') {
      const word = { name: 'name', price: 'price', blurb: 'description' }[key];
      return word && m.startsWith(`${PRODUCTS[id]?.name} ${word}`);
    }
    const label = (FIELD_LABELS[id] || $(`label[for="${f.id}"]`)?.firstChild?.textContent || '').trim();
    return label && m.toLowerCase().startsWith(label.toLowerCase());
  });
  if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); }
}

$('#saveBtn').addEventListener('click', () => saveDraft());
$('#previewBtn').addEventListener('click', async () => {
  const win = window.open('about:blank', '_blank');
  if (state.dirty && !(await saveDraft({ silent: true }))) { win?.close(); return; }
  if (win) win.location = '/?kcpreview=1#/';
  else location.href = '/?kcpreview=1#/';
});
$('#publishBtn').addEventListener('click', async () => {
  if (state.dirty && !(await saveDraft({ silent: true }))) return;
  try {
    const data = await api('admin-settings', { method: 'POST', body: { action: 'publish' } });
    state.live = data.live; state.hasDraft = false; state.dirty = false;
    renderPublishState(); toast('Published. The live site now shows these changes.');
  } catch (err) { if (err.status !== 401) toast(err.message, 'error'); }
});
$('#discardBtn').addEventListener('click', async () => {
  if (!confirm('Discard all unpublished changes and go back to what is live?')) return;
  try {
    const data = await api('admin-settings', { method: 'POST', body: { action: 'discard' } });
    state.settings = structuredClone(data.draft); state.hasDraft = false; state.dirty = false;
    renderProducts(); fillContent(); renderPublishState(); toast('Draft discarded');
  } catch (err) { if (err.status !== 401) toast(err.message, 'error'); }
});
window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

/* ------------------------------------------------------------------ boot */
async function startApp() {
  $('#viewLogin').hidden = true;
  $('#viewApp').hidden = false;
  route();
  await Promise.all([loadOrders({ quiet: true }), loadSettings()]);
}

(async function boot() {
  try {
    const s = await api('admin-auth');
    if (!s.configured) { showLogin('The admin account isn’t set up on the server yet. Follow ADMIN-SETUP.md: add ADMIN_USERNAME, ADMIN_PASSWORD_HASH and SESSION_SECRET in Netlify, then redeploy.', 'info'); return; }
    if (s.signedIn) await startApp(); else showLogin();
  } catch (err) {
    showLogin(err.message);
  }
})();
// keep the dashboard current while it is open
setInterval(() => { if (!$('#viewApp').hidden && !document.hidden) loadOrders({ quiet: true }); }, 60_000);
