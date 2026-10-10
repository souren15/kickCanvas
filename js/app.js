/**
 * KickCanvas front end.
 * Wires the DOM to the 3D engine (js/engine) and the state store (js/ui/store.js).
 */
import { PRODUCTS, PALETTE, FINISH_LIST, SIZES, PRICING, partLabel, isPurchasable, isPreLaunch, statusOf } from './data/products.js';
import { applyCatalogue, defaultSettings, ORDER_STATUSES } from './data/site-config.js';
import { store, money } from './ui/store.js';
import { SneakerViewer, detectQuality } from './engine/viewer.js';
import { FINISHES } from './engine/partMaterial.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const ga = (name, params = {}) => { try { window.gtag && window.gtag('event', name, params); } catch {} };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Site settings the administrator publishes. Starts as the built-in defaults until they load. */
const SETTINGS = defaultSettings();

/* =========================================================== toasts */
const toastWrap = $('#toasts');
function toast(message, { icon = true } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = (icon ? `<svg class="ic" width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>` : '') + `<span>${esc(message)}</span>`;
  toastWrap.appendChild(el);
  setTimeout(() => { el.dataset.out = 'true'; setTimeout(() => el.remove(), 320); }, 2600);
}

/* =========================================================== router */
const PAGES = ['home', 'design', 'styles', 'how', 'cart', 'checkout', 'confirmation', 'track', 'about'];
const SECTION_OF = { styles: 'styles', how: 'how' };   // anchors living inside the home page

let currentPage = null;

/** The origin the page is actually served from, so the canonical tag can never point at a
 *  domain that does not resolve. Falls back to the production host when opened from a file. */
const SITE = /^https?:$/.test(location.protocol) ? location.origin : 'https://kickcanvas.netlify.app';
/** Title + meta description per route. Search engines index the rendered page, so the
 *  description has to change with the view the way it would on a multi-page site. */
const META = {
  // One Moz-validated keyword owns one page; see the keyword map in the strategy doc.
  // home → "custom sneakers india" (KD 24) · design → "design your own shoes online" (KD 29)
  // + "3d sneaker customizer" (KD 36, the only commercial-intent term) · about → "custom
  // sneakers bangalore" (KD 26). No term is targeted by two pages.
  home: ['Custom Sneakers India — Design Your Own in 3D | KickCanvas',
    'Design custom sneakers in India — recolour every panel on a real 3D model, pick finishes, print your own artwork. Order with Cash on Delivery.'],
  design: ['3D Sneaker Customizer — Design Your Own Shoes | KickCanvas',
    'Free 3D sneaker customizer: design your own shoes online in your browser. Recolour nine parts, choose five finishes, add your own artwork. No signup needed.'],
  styles: ['Silhouettes — Three Customisable Sneakers | KickCanvas',
    'Three real 3D sneaker silhouettes to customise: KC—01 Vector, KC—02 Monolith and KC—03 Drift. Pick a shape and make it yours.'],
  how: ['How KickCanvas Works — Design, Review, Order',
    'How custom sneakers are made at KickCanvas: pick a silhouette, customise every panel in 3D, check it from every angle, order with Cash on Delivery, and we make it once your order is confirmed.'],
  cart: ['Your Designs — KickCanvas', 'The sneaker designs you have saved on this device.'],
  checkout: ['Checkout — KickCanvas', 'Complete your KickCanvas order.'],
  confirmation: ['Order received — KickCanvas', 'Your KickCanvas order has been received and is awaiting confirmation.'],
  track: ['Track Your Order — KickCanvas',
    'Track your KickCanvas custom sneaker order. Enter the order ID from your confirmation email to see production and delivery status.'],
  about: ['About KickCanvas — Custom Sneakers in Bangalore',
    'KickCanvas makes custom sneakers in Bangalore (Bengaluru), built around a real 3D configurator. Who it is for, how each pair is made, and where we ship.'],
};
/** Clean entry URLs (/design, /styles …). Netlify rewrites every path to index.html, so these
 *  are real crawlable URLs and usable as Google Ads landing pages; in-app navigation stays on
 *  the hash, and the canonical tag below points each view back at its clean URL. */
const pathRoute = () => {
  const seg = location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0].toLowerCase();
  return PAGES.includes(seg) ? seg : null;
};

function parseHash() {
  if (!location.hash) return pathRoute() || 'home';
  const raw = location.hash.replace(/^#\/?/, '');
  const [name] = raw.split('?');
  return PAGES.includes(name) ? name : 'home';
}

// False until the first showPage completes: gtag('config') owns the initial page_view.
let routeViewSent = false;

function showPage(name, { scroll = true } = {}) {
  const target = SECTION_OF[name] ? 'home' : name;
  $$('.page').forEach((p) => p.classList.toggle('is-active', p.dataset.page === target));

  // title, description and canonical move with the view, as they would on a multi-page site
  const [title, desc] = META[name] || META[target] || META.home;
  document.title = title;
  const meta = $('meta[name="description"]');
  if (meta) meta.setAttribute('content', desc);
  const canon = $('link[rel="canonical"]');
  if (canon) canon.setAttribute('href', name === 'home' ? SITE + '/' : `${SITE}/${name}`);
  const ogUrl = $('meta[property="og:url"]');
  if (ogUrl) ogUrl.setAttribute('content', name === 'home' ? SITE + '/' : `${SITE}/${name}`);
  const ogTitle = $('meta[property="og:title"]');
  if (ogTitle) ogTitle.setAttribute('content', title);
  const ogDesc = $('meta[property="og:description"]');
  if (ogDesc) ogDesc.setAttribute('content', desc);

  $$('[data-link]').forEach((a) => {
    const on = a.dataset.link === name || (a.dataset.link === 'home' && target === 'home' && !SECTION_OF[name]);
    if (a.closest('.nav')) a.setAttribute('aria-current', on ? 'page' : 'false');
  });

  currentPage = name;
  onPageChange(target, name);
  if (name === 'track') renderMyOrders();    // independent of the 3D viewer

  if (SECTION_OF[name]) {
    const sec = document.getElementById(SECTION_OF[name]);
    if (sec) requestAnimationFrame(() => sec.scrollIntoView({ behavior: prefersReduced ? 'auto' : 'smooth', block: 'start' }));
  } else if (scroll) {
    // the swap changes document height, so reset after the browser has laid the new page out
    window.scrollTo({ top: 0, behavior: 'auto' });
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'auto' }));
  }
  ga('page_view_app', { page: name });

  // GA4 builds its "Pages and screens" report from `page_view` ONLY. `page_view_app` above is a
  // custom event and does not feed that report, so without this a seven-route site collapses
  // into a single row for "/" and every route-level engagement metric is lost.
  // The guard matters: gtag('config') already sends the page_view for the first route, so firing
  // here on boot would double-count it. Only navigations after the first send one.
  if (routeViewSent) {
    ga('page_view', {
      page_title: document.title,              // showPage has already set the per-route title
      page_location: location.href,
      page_path: location.pathname + location.hash,
    });
  }
  routeViewSent = true;
}

window.addEventListener('hashchange', () => showPage(parseHash()));

/* =========================================================== header + nav */
const header = $('#siteHeader');
const onScroll = () => header.dataset.stuck = String(window.scrollY > 4);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

const menuBtn = $('#menuBtn'), mobileNav = $('#mobileNav');
const setMenu = (open) => {
  mobileNav.dataset.open = String(open);
  menuBtn.setAttribute('aria-expanded', String(open));
  document.body.style.overflow = open ? 'hidden' : '';
};
menuBtn.addEventListener('click', () => setMenu(mobileNav.dataset.open !== 'true'));
mobileNav.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mobileNav.dataset.open === 'true') setMenu(false); });

$('#year').textContent = new Date().getFullYear();

/* strip */
$('#stripRow').innerHTML = (() => {
  const items = ['Real 3D models', 'Nine recolourable parts', 'Matte · Gloss · Leather · Suede', 'Your artwork on the shoe', 'Designed by you', 'Cash on Delivery'];
  const row = items.map((t) => `<span>${esc(t)}</span>`).join('');
  return row + row;   // duplicated for a seamless loop
})();

/* =========================================================== reveal on scroll */
const revealObs = new IntersectionObserver((entries) => {
  entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('is-in'); revealObs.unobserve(e.target); } });
}, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
$$('.reveal').forEach((el) => revealObs.observe(el));

/* =========================================================== 3D viewer */
const quality = detectQuality();
const viewer = new SneakerViewer(PRODUCTS);
let viewerReady = false;
let heroMounted = false;

const designStage = $('#designStage');
const heroStage = $('#heroStage');
const heroPoster = $('#heroPoster');
/** The hero poster shows until the live canvas is actually inside the hero stage. */
function syncHeroPoster() {
  heroPoster.style.opacity = !viewer.failed && viewerReady && viewer.container === heroStage ? '0' : '1';
}
const loadingEl = $('#designLoading');
const errorEl = $('#designError');
const loaderBar = $('#loaderBar');

if (viewer.failed) showViewerError('Your browser couldn’t start WebGL.');

function showViewerError(message) {
  loadingEl.hidden = true;
  errorEl.hidden = false;
  $('#designErrorText').textContent = message + ' You can still browse styles and place an order.';
  heroPoster.style.opacity = '1';
}

viewer.on('error', (e) => showViewerError(e?.message || 'The 3D viewer hit an error.'));

viewer.on('ready', () => {
  viewerReady = true;
  loadingEl.hidden = true;
  errorEl.hidden = true;
  syncHeroPoster();
});

/** Mount the (single) WebGL canvas wherever it is needed right now. */
function onPageChange(target, name) {
  if (viewer.failed) return;
  if (target === 'design') {
    viewer.mount(designStage, 'customizer');
    viewer.setActive(true);
    ensureModel(store.state.model);
    syncHeroPoster();
  } else if (target === 'home') {
    viewer.mount(heroStage, 'hero');
    viewer.setActive(true);
    heroMounted = true;
    ensureModel(store.state.model);
    syncHeroPoster();
  } else {
    viewer.setActive(false);
  }
  if (target !== 'design') cardPreview.release();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) viewer.setActive(false);
  else if (currentPage === 'design' || currentPage === 'home' || SECTION_OF[currentPage]) viewer.setActive(true);
});

let modelLoading = null;
/** Spinner on the configurator's model button while that model loads. */
function setModelLoading(id) {
  $$('#modelOpts .model-opt').forEach((b) => b.dataset.loading = String(b.dataset.model === id));
}

function ensureModel(id) {
  if (viewer.failed) return Promise.resolve();
  if (viewer.current?.id === id && !modelLoading) { viewer.applyDesign(store.viewDesign()); return Promise.resolve(); }
  if (!viewer.current) { loadingEl.hidden = false; errorEl.hidden = true; }
  setModelLoading(id);
  loaderBar.style.width = '8%';
  const job = viewer.switchModel(id, store.viewDesign(), {
    onProgress: (p) => { loaderBar.style.width = Math.round(8 + p * 88) + '%'; },
  }).then(() => {
    if (modelLoading !== job) return;          // superseded by a newer choice: leave its spinner alone
    loaderBar.style.width = '100%';
    setModelLoading(null);
    modelLoading = null;
  }).catch((e) => {
    console.error(e);
    if (modelLoading !== job) return;
    modelLoading = null;
    setModelLoading(null);
    showViewerError('The sneaker model failed to load.');
  });
  modelLoading = job;
  return modelLoading;
}

/* hero hint fades after the first interaction */
const heroHint = $('#heroHint');
['pointerdown', 'wheel', 'touchstart'].forEach((ev) =>
  heroStage.addEventListener(ev, () => { heroHint.dataset.hide = 'true'; }, { passive: true, once: true }));

/* =========================================================== card previews */
/**
 * Style cards show a pre-rendered poster of the real GLB; hovering (or focusing) a card hands it
 * the live viewer canvas so the sneaker can be spun, without paying for extra WebGL contexts.
 */
const cardPreview = {
  host: null,
  take(stageEl, modelId) {
    if (viewer.failed || window.matchMedia('(hover: none)').matches) return;
    if (currentPage !== 'home' && !SECTION_OF[currentPage]) return;
    if (this.host === stageEl) return;
    this.release();
    this.host = stageEl;
    stageEl.dataset.live = 'true';
    viewer.mount(stageEl, 'hero');
    viewer.setAutoRotate(true);
    ensureModel(modelId);
    syncHeroPoster();
  },
  release() {
    if (!this.host) return;
    this.host.dataset.live = 'false';
    this.host = null;
    if (!viewer.failed && (currentPage === 'home' || SECTION_OF[currentPage])) {
      viewer.mount(heroStage, 'hero');
      viewer.setAutoRotate(true);
      ensureModel(store.state.model);
    }
    syncHeroPoster();
  },
};

function buildStyleCards() {
  const host = $('#styleCards');
  const shown = Object.values(PRODUCTS).filter((p) => p.visible !== false);
  host.classList.toggle('cards--3', shown.length === 3);
  host.innerHTML = shown.map((p) => `
    <article class="card" data-model="${p.id}">
      <div class="card__stage" data-live="false">
        <img class="card__poster" src="assets/posters/${p.id}-card.jpg" alt="${esc(p.name)} sneaker" width="900" height="675" loading="lazy" decoding="async">
        <span class="card__live-tag"><span class="dot"></span> Live 3D</span>
        ${statusOf(p).badge ? `<span class="card__status">${esc(statusOf(p).badge)}</span>` : ''}
      </div>
      <div class="card__body">
        <div class="card__row"><h3>${esc(p.name)}</h3><span class="card__price num">${money(p.price)}</span></div>
        <p class="card__desc">${esc(p.blurb)}</p>
        <div class="card__chips" aria-hidden="true">${PALETTE.slice(0, 6).map((c) => `<i style="background:${c.hex}"></i>`).join('')}</div>
        <div class="card__actions">
          <a class="btn btn--ghost card__cta" href="#/design" data-link="design" data-customize="${p.id}">Customise this</a>
          ${isPurchasable(p)
            ? ''
            : `<button class="btn btn--muted card__cta" type="button" disabled aria-disabled="true">${esc(statusOf(p).label)}</button>`}
        </div>
      </div>
    </article>`).join('');

  $$('.card', host).forEach((card) => {
    const stage = $('.card__stage', card);
    const id = card.dataset.model;
    card.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') cardPreview.take(stage, id); });
    card.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && cardPreview.host === stage) cardPreview.release(); });
    card.addEventListener('focusin', () => cardPreview.take(stage, id));
  });
}

/** CC BY models must be credited wherever they are shown. */
function buildCredits() {
  const credited = Object.values(PRODUCTS).filter((p) => p.credit);
  const host = $('#modelCredits');
  if (!host) return;
  if (!credited.length) { host.closest('[data-credits]')?.remove(); return; }
  host.innerHTML = credited.map((p) => {
    const c = p.credit;
    return `<li><a href="${c.url}" target="_blank" rel="noopener noreferrer">“${esc(c.title)}”</a> by ${esc(c.author)}, licensed under <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">${esc(c.licence)}</a> — used for ${esc(p.name)}.</li>`;
  }).join('');
}

function buildFinishCards() {
  const host = $('#finishCards');
  if (!host) return;
  const rows = [
    { k: 'leather', t: 'Leather', d: 'A pebbled grain breaks up reflections, so highlights sit in the surface instead of sliding across it.' },
    { k: 'suede', t: 'Suede', d: 'High roughness plus a velvet sheen: light catches the nap at glancing angles the way real suede does.' },
    { k: 'gloss', t: 'Gloss', d: 'A clear coat over the base colour adds a second, sharper specular layer — patent-leather bright.' },
    { k: 'matte', t: 'Matte', d: 'Light scatters evenly and the colour reads flat and true from every direction.' },
  ];
  host.classList.add('cards--4');
  host.innerHTML = rows.map((r) => `
    <div class="panel">
      <span class="eyebrow">${esc(r.t)}</span>
      <p class="small muted" style="margin-top:10px">${esc(r.d)}</p>
    </div>`).join('');
}

/* =========================================================== configurator UI */
const rail = $('#rail');
const partChips = $('#partChips');
const swatchHost = $('#swatches');
const finishHost = $('#finishes');
const decalList = $('#decalList');
const selReadout = $('#selReadout');
const designHint = $('#designHint');
const designHintText = $('#designHintText');

let activePart = 'upper';
let activeDecal = null;

function availableParts() { return store.product.parts; }

function buildModelOptions() {
  $('#modelOpts').innerHTML = Object.values(PRODUCTS).filter((p) => p.visible !== false).map((p, i) => `
    <button class="model-opt" type="button" data-model="${p.id}" data-loading="false" aria-pressed="${p.id === store.state.model}">
      <span class="spin"></span>
      <span class="k">MODEL 0${i + 1}</span>
      <span class="n">${esc(p.name)}</span>
      <span class="p num">${money(p.price)}</span>
    </button>`).join('');
}

function buildSizes() {
  $('#sizeSel').innerHTML = SIZES.map((s) => `<option${s === store.state.size ? ' selected' : ''}>${s}</option>`).join('');
}

function buildPartChips() {
  const parts = availableParts();
  if (!parts.includes(activePart)) activePart = parts[0];
  partChips.innerHTML = parts.map((key) => {
    const cfg = store.side.parts[key] || {};
    const sw = cfg.color ? `<span class="sw" style="background:${cfg.color}"></span>` : '';
    return `<button class="chip" type="button" data-part="${key}" aria-pressed="${key === activePart}">${sw}${esc(partLabel(store.state.model, key))}</button>`;
  }).join('');
}

function buildSwatches() {
  swatchHost.innerHTML = PALETTE.map((c) => `
    <button class="swatch" type="button" data-color="${c.hex}" style="background:${c.hex}" aria-label="${esc(c.name)}" title="${esc(c.name)}" aria-pressed="false"></button>`).join('')
    + `<label class="swatch swatch--custom" title="Custom colour">
         <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.2 2.6 13.4 4.8 5.6 12.6l-3 .8.8-3z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
         <input type="color" id="customColor" value="#C2452D" aria-label="Custom colour">
       </label>`;
}

function buildFinishes() {
  finishHost.innerHTML = FINISH_LIST.map((f) => {
    const d = PRICING.finishDelta[f.key];
    return `<button class="finish" type="button" data-finish="${f.key}" aria-pressed="false">
      <b>${esc(f.label)}</b><span>${esc(f.note)}</span>${d ? `<span class="delta">+${money(d)}</span>` : ''}</button>`;
  }).join('');
}

/** The Finish panel reflects the one whole-sneaker finish, whichever part is being edited. */
function syncFinishUI() {
  const cur = store.state.finish || 'original';
  $$('.finish', finishHost).forEach((b) => b.setAttribute('aria-pressed', String(cur === b.dataset.finish)));
}

function syncPartUI() {
  const cfg = store.side.parts[activePart] || {};
  $$('.chip', partChips).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.part === activePart)));
  $$('.swatch[data-color]', swatchHost).forEach((b) => {
    const on = (cfg.color || '').toLowerCase() === b.dataset.color.toLowerCase();
    b.setAttribute('aria-pressed', String(on));
  });
  syncFinishUI();
  const named = PALETTE.find((c) => c.hex.toLowerCase() === (cfg.color || '').toLowerCase());
  $('#colorName').textContent = cfg.color ? (named ? named.name : cfg.color.toUpperCase()) : 'Original';
  const label = partLabel(store.state.model, activePart);
  selReadout.innerHTML = `Editing <b style="color:var(--ink)">${esc(label)}</b>`;
}

function syncHeader() {
  const p = store.product;
  $('#stageName').textContent = p.name;
  $('#stageSub').textContent = p.tagline;
  syncAvailability();
  $$('#modelOpts .model-opt').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.model === store.state.model)));
}

/** Mirror the product's real availability onto the purchase controls. */
function syncAvailability() {
  const p = store.product;
  const ok = isPurchasable(p);
  const btn = $('#btnAddCart');
  if (btn) {
    btn.disabled = !ok;
    btn.setAttribute('aria-disabled', String(!ok));
    btn.textContent = ok ? 'Add to cart' : statusOf(p).label;
    btn.classList.toggle('btn--accent', ok);
    btn.classList.toggle('btn--muted', !ok);
  }
  const note = $('#availabilityNote');
  if (note) {
    note.hidden = ok;
    note.textContent = ok ? '' : 'This sneaker isn’t available to order right now.';
  }
}

function syncPair() {
  $$('[data-pair]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pair === store.state.pairMode)));
  $$('[data-side]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.side === store.state.active)));
  $('#sideField').hidden = store.state.pairMode !== 'split';
}

function renderDecals() {
  const decals = store.side.decals;
  $('#decalHint').textContent = `${decals.length} of 4`;
  if (!decals.length) { decalList.innerHTML = ''; return; }
  decalList.innerHTML = decals.map((d) => {
    const name = d.type === 'text' ? `“${d.text}”` : 'Artwork';
    const thumb = d.type === 'image'
      ? `<span class="decal__thumb" style="background-image:url('${d.src}')"></span>`
      : `<span class="decal__thumb" style="color:${d.color}">${esc((d.text || '').slice(0, 3))}</span>`;
    return `<div class="decal" data-id="${d.id}" data-sel="${d.id === activeDecal}">
      <div class="decal__top">
        ${thumb}
        <span class="decal__name">${esc(name)}</span>
        ${d.type === 'text' ? `<input type="color" class="mini" value="${d.color}" data-act="color" aria-label="Text colour" style="width:34px;padding:2px">` : ''}
        <button class="decal__del" type="button" data-act="del" aria-label="Remove">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="decal__ctl">
        <div class="ctl-row"><span class="label">Size</span>
          <input type="range" min="0.05" max="0.45" step="0.005" value="${d.size}" data-act="size" aria-label="Decal size"></div>
        <div class="ctl-row"><span class="label">Rotate</span>
          <input type="range" min="-180" max="180" step="1" value="${Math.round((d.rot || 0) * 180 / Math.PI)}" data-act="rot" aria-label="Decal rotation"></div>
        <div class="ctl-row"><span class="label">Place</span>
          <div class="ctl-btns">
            ${['side', 'medial', 'heel', 'toe'].map((a) => `<button class="mini" type="button" data-act="anchor" data-anchor="${a}">${a === 'medial' ? 'Inner' : a[0].toUpperCase() + a.slice(1)}</button>`).join('')}
          </div></div>
      </div>
    </div>`;
  }).join('');
}

function renderPrice() {
  const lines = store.priceLines();
  const pair = store.pairPrice();
  const qty = Math.max(1, store.state.qty | 0);
  $('#priceLines').innerHTML =
    lines.map((l) => `<div class="summary__line"><span>${esc(l.label)}</span><span class="num">${money(l.value)}</span></div>`).join('')
    + (qty > 1 ? `<div class="summary__line"><span>Pairs</span><span class="num">× ${qty}</span></div>` : '')
    + `<div class="summary__line is-total"><span>Total</span><span class="num">${money(pair * qty)}</span></div>`;
}

function syncAll() {
  buildPartChips();
  syncPartUI();
  syncHeader();
  syncAvailability();
  syncPair();
  renderDecals();
  renderPrice();
  updateCartCount();
}

/* ------------------------------------------------- configurator events */
$('#modelOpts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-model]'); if (!b) return;
  store.setModel(b.dataset.model);
  ga('select_model', { model: b.dataset.model });
});

partChips.addEventListener('click', (e) => {
  const b = e.target.closest('[data-part]'); if (!b) return;
  activePart = b.dataset.part;
  viewer.selectMesh(activePart, { silent: true });
  syncPartUI();
});

swatchHost.addEventListener('click', (e) => {
  const b = e.target.closest('.swatch[data-color]'); if (!b) return;
  store.setPartColor(activePart, b.dataset.color);
  ga('customize_color', { part: activePart, color: b.getAttribute('aria-label') });
});
swatchHost.addEventListener('input', (e) => {
  if (e.target.id === 'customColor') store.setPartColor(activePart, e.target.value);
});

finishHost.addEventListener('click', (e) => {
  const b = e.target.closest('[data-finish]'); if (!b) return;
  store.setFinish(b.dataset.finish);
  ga('customize_finish', { part: 'all', finish: b.dataset.finish });
});

$('#btnResetPart').addEventListener('click', () => { store.resetPart(activePart); toast(`${partLabel(store.state.model, activePart)} reset`); });

$('#btnResetAll').addEventListener('click', () => {
  store.resetAll();
  activeDecal = null;
  toast('Design reset to original');
});

/* pair + size + qty */
rail.addEventListener('click', (e) => {
  const pair = e.target.closest('[data-pair]');
  if (pair) { store.setPairMode(pair.dataset.pair); ga('pair_mode', { mode: pair.dataset.pair }); return; }
  const side = e.target.closest('[data-side]');
  if (side) { store.setActiveSide(side.dataset.side); return; }
});
$('#sizeSel').addEventListener('change', (e) => { store.state.size = e.target.value; store.persistDesign(); });
$('#qtyInput').addEventListener('input', (e) => {
  const v = Math.min(20, Math.max(1, parseInt(e.target.value || '1', 10) || 1));
  store.state.qty = v; store.persistDesign(); renderPrice();
});
$('#qtyInput').addEventListener('blur', (e) => { e.target.value = store.state.qty; });

/* ------------------------------------------------- decals */
const MAX_UPLOAD = 6 * 1024 * 1024;

function addTextDecal() {
  const input = $('#textInput');
  const text = input.value.trim();
  if (!text) { input.focus(); toast('Type some text first'); return; }
  if (store.side.decals.length >= 4) { toast('You can add up to 4 items'); return; }
  const d = { id: 'd' + Date.now().toString(36), type: 'text', text, font: 'Manrope KC', color: '#15161A', size: 0.15, rot: 0, place: {} };
  store.update((s) => { s.decals = [...s.decals, d]; });
  activeDecal = d.id;
  input.value = '';
  toast('Text added — drag it on the shoe to move it');
  flashHint('Drag the print to move it around the shoe');
  ga('customize_text', {});
}
$('#btnAddText').addEventListener('click', addTextDecal);
$('#textInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTextDecal(); } });

async function handleFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) { toast('That file isn’t an image'); return; }
  if (file.size > MAX_UPLOAD) { toast('Image is larger than 6 MB'); return; }
  if (store.side.decals.length >= 4) { toast('You can add up to 4 items'); return; }
  try {
    const src = await downscale(file);
    const d = { id: 'd' + Date.now().toString(36), type: 'image', src, size: 0.17, rot: 0, place: {} };
    store.update((s) => { s.decals = [...s.decals, d]; });
    activeDecal = d.id;
    toast('Artwork applied — drag it to position it');
    flashHint('Drag the artwork to move it around the shoe');
    ga('customize_artwork', {});
  } catch (e) {
    console.error(e);
    toast('Couldn’t read that image');
  }
}

/** Keep uploads small enough to live in localStorage alongside the rest of the design. */
function downscale(file, max = 768) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * s)), h = Math.max(1, Math.round(img.naturalHeight * s));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      // keep PNG transparency; otherwise JPEG is far smaller
      const hasAlpha = /png|webp|svg/.test(file.type);
      resolve(c.toDataURL(hasAlpha ? 'image/png' : 'image/jpeg', 0.9));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

$('#artFile').addEventListener('change', (e) => { handleFile(e.target.files[0]); e.target.value = ''; });
const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.dataset.over = 'true'; }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.dataset.over = 'false'; }));
drop.addEventListener('drop', (e) => handleFile(e.dataTransfer?.files?.[0]));

decalList.addEventListener('click', (e) => {
  const row = e.target.closest('.decal'); if (!row) return;
  const id = row.dataset.id;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'del') {
    store.update((s) => { s.decals = s.decals.filter((d) => d.id !== id); });
    if (activeDecal === id) activeDecal = null;
    viewer.decals.remove(id);
    toast('Removed');
    return;
  }
  if (act === 'anchor') {
    const anchor = e.target.closest('[data-anchor]').dataset.anchor;
    const rec = viewer.current;
    const pl = rec?.anchors?.[anchor];
    if (!pl) { toast('That spot isn’t available on this model'); return; }
    store.update((s) => {
      const d = s.decals.find((x) => x.id === id); if (!d) return;
      (d.place ||= {})[store.state.model] = { pos: pl.pos, normal: pl.normal };
    });
    return;
  }
  activeDecal = id;
  $$('.decal', decalList).forEach((r) => r.dataset.sel = String(r.dataset.id === id));
});

decalList.addEventListener('input', (e) => {
  const row = e.target.closest('.decal'); if (!row) return;
  const id = row.dataset.id;
  const act = e.target.dataset.act;
  const value = e.target.value;
  store.update((s) => {
    const d = s.decals.find((x) => x.id === id); if (!d) return;
    if (act === 'size') d.size = parseFloat(value);
    else if (act === 'rot') d.rot = parseFloat(value) * Math.PI / 180;
    else if (act === 'color') d.color = value;
  }, { quiet: true });
});

let hintTimer = null;
let hintRetired = false;
function retireHint() {
  if (hintRetired) return;
  hintRetired = true;
  clearTimeout(hintTimer);
  designHint.dataset.hide = 'true';
}
['pointerdown', 'wheel'].forEach((ev) => designStage.addEventListener(ev, retireHint, { passive: true }));
setTimeout(retireHint, 7000);

function flashHint(text) {
  hintRetired = true;
  designHintText.textContent = text;
  designHint.dataset.hide = 'false';
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { designHint.dataset.hide = 'true'; }, 3200);
}

/* The order bar is sticky over the bottom of the rail; publish its height so the rail can
   reserve room and nothing ends up permanently underneath it. */
(() => {
  const bar = $('.summary');
  if (!bar || !('ResizeObserver' in window)) return;
  const sync = () => rail.style.setProperty('--order-bar-h', Math.round(bar.offsetHeight) + 'px');
  new ResizeObserver(sync).observe(bar);
  sync();
})();

/* ------------------------------------------------- viewer <-> store */
viewer.on('tap', ({ part }) => {
  if (!part) return;
  if (!availableParts().includes(part)) { toast('That part isn’t customisable on this model'); return; }
  activePart = part;
  syncPartUI();
  flashHint(`${partLabel(store.state.model, part)} selected`);
  $('.chip[aria-pressed="true"]', partChips)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
});

viewer.on('decalselect', ({ id }) => {
  activeDecal = id;
  $$('.decal', decalList).forEach((r) => r.dataset.sel = String(r.dataset.id === id));
});

/** The engine found a default spot (or the user dragged the print): remember it per model. */
const persistPlace = ({ id, modelId, place }) => {
  store.update((s) => {
    const d = s.decals.find((x) => x.id === id); if (!d) return;
    (d.place ||= {})[modelId] = place;
  }, { quiet: true, noRefresh: true });
};
viewer.on('decalplace', persistPlace);
viewer.on('decalmove', persistPlace);

viewer.on('modelchange', () => { syncAll(); });

/* view + rotate controls */
$$('[data-view]').forEach((b) => b.addEventListener('click', () => {
  $$('[data-view]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  viewer.setView(b.dataset.view);
  ga('camera_view', { view: b.dataset.view });
}));
$('#btnRotL').addEventListener('click', () => { viewer.rotateModel(45); clearViewPressed(); });
$('#btnRotR').addEventListener('click', () => { viewer.rotateModel(-45); clearViewPressed(); });
$('#btnReset').addEventListener('click', () => {
  viewer.resetCamera();
  $$('[data-view]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.view === 'default')));
});
$('#btnAuto').addEventListener('click', (e) => {
  const on = !viewer.autoRotate;
  viewer.setAutoRotate(on);
  e.currentTarget.setAttribute('aria-pressed', String(on));
});
$('#btnRetry3D').addEventListener('click', () => {
  errorEl.hidden = true; loadingEl.hidden = false;
  ensureModel(store.state.model);
});
function clearViewPressed() { $$('[data-view]').forEach((x) => x.setAttribute('aria-pressed', 'false')); }

/* keyboard: arrows rotate the shoe when the stage has focus */
designStage.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') { viewer.rotateModel(25); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { viewer.rotateModel(-25); e.preventDefault(); }
});
designStage.tabIndex = 0;
designStage.setAttribute('role', 'application');
designStage.setAttribute('aria-label', 'Sneaker viewer. Use left and right arrow keys to rotate.');

/* ------------------------------------------------- store subscription */
store.subscribe((evt) => {
  if (evt.type === 'storagefull') { toast('This device is low on storage — your design may not be saved'); return; }
  if (evt.type === 'unavailable') { toast('This sneaker isn’t available to order right now'); return; }
  if (evt.type === 'cart') { updateCartCount(); renderCart(); return; }
  if (evt.type === 'model') { ensureModel(store.state.model); syncHeader(); return; }
  if (evt.type === 'order') return;

  if (!viewer.failed && viewer.current) viewer.applyDesign(store.viewDesign());
  if (evt.noRefresh) return;
  if (evt.quiet) { renderPrice(); return; }
  buildPartChips(); syncPartUI(); syncPair(); renderDecals(); renderPrice();
});

/* =========================================================== cart */
function updateCartCount() {
  const n = store.cartCount;
  const el = $('#cartCount');
  el.textContent = n;
  el.dataset.has = String(n > 0);
  // the badge is visible text inside the link, so the accessible name has to contain it —
  // otherwise voice control cannot address the control by what is written on it
  const link = el.closest('a');
  // WCAG 2.5.3: the accessible name must CONTAIN the visible text, which is the count digit
  if (link) link.setAttribute('aria-label', `Cart, ${n} item${n === 1 ? '' : 's'}`);
}

function shippingNote() {
  if (!PRICING.shipping) return 'Shipping is free.';
  return PRICING.freeShippingOver > 0
    ? `Shipping is ${money(PRICING.shipping)}, free over ${money(PRICING.freeShippingOver)}.`
    : `Shipping is ${money(PRICING.shipping)}.`;
}

function renderCart() {
  const host = $('#cartBody');
  if (!store.cart.length) {
    const pre = isPreLaunch();
    host.innerHTML = `<div class="empty">
      <svg class="empty__mark" aria-hidden="true" focusable="false"><use href="#kc-mark"/></svg>
      <p class="display-m">${pre ? 'Your cart is waiting for the first drop' : 'Your cart is empty'}</p>
      <p class="muted small" style="max-width:44ch">${pre
        ? 'KickCanvas is launching soon. Design your pair now and it’ll be saved to this device, ready for when the collection drops.'
        : 'Build a pair and it’ll show up here.'}</p>
      <a class="btn btn--accent" href="#/design" data-link="design">${pre ? 'Design your pair' : 'Start designing'}</a>
    </div>`;
    return;
  }
  const t = store.totals();
  host.innerHTML = `
    <div class="cart-list">
      ${store.cart.map((i) => `
        <div class="cart-item" data-id="${i.id}">
          <div class="cart-item__img">${i.previews?.left
            ? `<img src="${i.previews.left}" alt="${esc(i.name)} preview">`
            : `<div style="display:grid;place-items:center;height:100%;color:var(--faint);font-size:.7rem">No preview</div>`}</div>
          <div>
            <div class="cart-item__name">${esc(i.name)}</div>
            <div class="cart-item__spec">${esc(i.size)} · ${esc(i.pairMode === 'split' ? 'Left/right differ' : 'Matched pair')}</div>
            <div class="cart-item__spec"><b>${esc(i.summary.left)}</b></div>
            ${i.pairMode === 'split' ? `<div class="cart-item__spec">Right: <b>${esc(i.summary.right)}</b></div>` : ''}
          </div>
          <div class="cart-item__end">
            <span class="num" style="font-weight:600">${money(i.unitPrice * i.qty)}</span>
            <div class="qty">
              <button type="button" data-act="dec" aria-label="Decrease quantity">−</button>
              <span class="num">${i.qty}</span>
              <button type="button" data-act="inc" aria-label="Increase quantity">+</button>
            </div>
            <button class="cart-remove" type="button" data-act="rm">Remove</button>
          </div>
        </div>`).join('')}
    </div>
    <div class="cart-foot">
      <p class="small muted" style="max-width:40ch">${shippingNote()} Pay with Cash on Delivery. Each pair is made to order after our team confirms your order.</p>
      <div style="min-width:260px">
        <div class="co-line"><span>Subtotal</span><span class="num">${money(t.subtotal)}</span></div>
        <div class="co-line"><span>Shipping</span><span class="num">${t.shipping ? money(t.shipping) : 'Free'}</span></div>
        <div class="co-line is-total"><span>Total</span><span class="num">${money(t.total)}</span></div>
        <a class="btn btn--accent btn--lg btn--block" href="#/checkout" data-link="checkout" style="margin-top:16px">Checkout</a>
      </div>
    </div>`;
}

$('#cartBody').addEventListener('click', (e) => {
  const row = e.target.closest('.cart-item'); if (!row) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'inc') store.changeQty(row.dataset.id, 1);
  else if (act === 'dec') store.changeQty(row.dataset.id, -1);
  else if (act === 'rm') { store.removeFromCart(row.dataset.id); toast('Removed from cart'); }
});

/**
 * Rendering the cart thumbnail is a synchronous GPU read-back, which is slow on weak hardware.
 * The button's pressed state is painted first, the capture is kept small on low-end devices, and
 * a failed or slow capture never blocks the item from reaching the cart.
 */
const PREVIEW_SIZE = quality.low ? { width: 384, height: 288 } : quality.mobile ? { width: 512, height: 384 } : { width: 640, height: 480 };
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

$('#btnAddCart').addEventListener('click', async () => {
  const btn = $('#btnAddCart');
  if (!isPurchasable(store.product)) { toast('This sneaker isn’t available to order right now'); return; }
  btn.disabled = true;
  try {
    await nextFrame();                       // let the disabled state paint before we block
    const previews = { left: null, right: null };
    if (!viewer.failed && viewer.current) {
      try {
        const was = store.state.active;
        if (store.state.pairMode === 'split') {
          store.setActiveSide('left'); viewer.applyDesign(store.viewDesign(), { instant: true });
          previews.left = viewer.capturePreview(PREVIEW_SIZE);
          store.setActiveSide('right'); viewer.applyDesign(store.viewDesign(), { instant: true });
          previews.right = viewer.capturePreview(PREVIEW_SIZE);
          store.setActiveSide(was); viewer.applyDesign(store.viewDesign(), { instant: true });
        } else {
          previews.left = viewer.capturePreview(PREVIEW_SIZE);
        }
      } catch (e) {
        console.warn('Cart preview could not be captured', e);
      }
    }
    const item = store.addToCart({ previews });
    if (!item) { toast('This sneaker isn’t available to order right now'); return; }
    ga('add_to_cart', {
      currency: 'INR', value: item.unitPrice * item.qty,
      items: [{ item_id: item.model, item_name: item.name, price: item.unitPrice, quantity: item.qty }],
    });
    toast('Added to cart');
    location.hash = '#/cart';
  } finally {
    btn.disabled = false;
  }
});

/* =========================================================== checkout */
const FIELDS = [
  { id: 'coName', label: 'name', test: (v) => v.trim().length >= 2, msg: 'Please enter your name.' },
  { id: 'coEmail', label: 'email', test: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()), msg: 'Enter a valid email address.' },
  { id: 'coPhone', label: 'phone', test: (v) => /^[6-9]\d{9}$/.test(v.replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '')), msg: 'Enter a valid 10-digit mobile number.' },
  { id: 'coAddr', label: 'address', test: (v) => v.trim().length >= 6, msg: 'Enter your street address.' },
  { id: 'coCity', label: 'city', test: (v) => v.trim().length >= 2, msg: 'Enter your city.' },
  { id: 'coState', label: 'state', test: (v) => v.trim().length >= 2, msg: 'Enter your state.' },
  { id: 'coPin', label: 'pincode', test: (v) => /^\d{6}$/.test(v.trim()), msg: 'Indian pincodes are 6 digits.' },
];

function validateCheckout({ focus = true } = {}) {
  let ok = true, first = null;
  for (const f of FIELDS) {
    const el = $('#' + f.id);
    const good = f.test(el.value || '');
    el.setAttribute('aria-invalid', String(!good));
    const err = $(`[data-err="${f.id}"]`);
    if (err) err.textContent = good ? '' : f.msg;
    if (!good && !first) first = el;
    ok = ok && good;
  }
  if (!ok && focus && first) { first.focus(); first.scrollIntoView({ block: 'center', behavior: prefersReduced ? 'auto' : 'smooth' }); }
  return ok;
}
FIELDS.forEach((f) => $('#' + f.id).addEventListener('blur', () => {
  const el = $('#' + f.id);
  if (!el.value) return;
  const good = f.test(el.value);
  el.setAttribute('aria-invalid', String(!good));
  const err = $(`[data-err="${f.id}"]`);
  if (err) err.textContent = good ? '' : f.msg;
}));

function renderCheckout() {
  const host = $('#coSummary');
  const btn = $('#btnPlaceOrder');
  const gate = store.canCheckout();
  if (!gate.ok) {
    host.innerHTML = `<p class="small muted">${esc(gate.message)} <a class="link-underline" href="#/design" data-link="design">Design a pair</a></p>`;
    btn.disabled = true;
    return;
  }
  const closed = SETTINGS.orders.acceptingOrders === false;
  btn.disabled = closed || placing;
  if (closed) setPayMsg(SETTINGS.orders.closedMessage, 'error');
  const t = store.totals();
  host.innerHTML =
    store.cart.map((i) => `<div class="co-line"><span>${esc(i.name)} <span class="muted">× ${i.qty}</span></span><span class="num">${money(i.unitPrice * i.qty)}</span></div>`).join('')
    + `<div class="co-line" style="border-top:1px solid var(--line);margin-top:8px;padding-top:12px"><span>Subtotal</span><span class="num">${money(t.subtotal)}</span></div>`
    + (t.discount ? `<div class="co-line"><span class="ok">Discount (${esc(store.discount.code)})</span><span class="num ok">−${money(t.discount)}</span></div>` : '')
    + `<div class="co-line"><span>Shipping</span><span class="num">${t.shipping ? money(t.shipping) : 'Free'}</span></div>`
    + `<div class="co-line is-total"><span>Total</span><span class="num">${money(t.total)}</span></div>`
    + `<div class="co-line"><span>Payment</span><span>Cash on Delivery</span></div>`;
}

function setPayMsg(text, state = '') {
  const m = $('#payMsg');
  m.textContent = text || '';
  if (state) m.dataset.state = state; else delete m.dataset.state;
}

$('#btnCoupon').addEventListener('click', () => {
  const res = store.applyCoupon($('#coCoupon').value);
  const msg = $('#couponMsg');
  msg.textContent = res.message;
  msg.style.color = res.ok ? 'var(--ok)' : 'var(--warn)';
  renderCheckout();
  if (res.ok) ga('apply_coupon', { code: store.discount.code });
});

function collectCustomer() {
  return {
    name: $('#coName').value.trim(),
    email: $('#coEmail').value.trim(),
    phone: $('#coPhone').value.trim(),
    address: $('#coAddr').value.trim(),
    apt: $('#coApt').value.trim(),
    city: $('#coCity').value.trim(),
    state: $('#coState').value.trim(),
    pincode: $('#coPin').value.trim(),
  };
}

/**
 * Cash on Delivery order. The cart is cleared ONLY after the server confirms the order was saved;
 * any failure leaves the cart exactly as it was. One request key per attempt means a double tap
 * or a retry after a dropped connection returns the same order instead of creating a second one.
 */
let placing = false;
const SERVER_FIELD = { name: 'coName', email: 'coEmail', phone: 'coPhone', address: 'coAddr', city: 'coCity', state: 'coState', pincode: 'coPin' };
const newRequestKey = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : String(Date.now()) + Math.random().toString(36).slice(2, 12));
let requestKey = newRequestKey();

$('#btnPlaceOrder').addEventListener('click', async () => {
  if (placing) return;
  const gate = store.canCheckout();
  if (!gate.ok) { toast(gate.message); return; }
  if (SETTINGS.orders.acceptingOrders === false) { setPayMsg(SETTINGS.orders.closedMessage, 'error'); return; }
  if (!validateCheckout()) return;
  placing = true;
  const btn = $('#btnPlaceOrder');
  btn.disabled = true;
  btn.textContent = 'Placing your order…';
  setPayMsg('');
  try {
    const res = await fetch('/.netlify/functions/orders-create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestKey, paymentMethod: 'cod', customer: collectCustomer(),
        items: store.orderPayload(), coupon: store.discount.code,
      }),
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok || !data?.ok) {
      if (data?.fields) {
        for (const [k, msg] of Object.entries(data.fields)) {
          const id = SERVER_FIELD[k]; if (!id) continue;
          $('#' + id).setAttribute('aria-invalid', 'true');
          const err = $(`[data-err="${id}"]`); if (err) err.textContent = msg;
        }
      }
      const fallback = res.status === 404
        ? 'Orders can’t be placed from this copy of the site because the order service isn’t running here. Your cart is safe.'
        : 'We couldn’t place your order. Your cart is safe — please try again.';
      setPayMsg((data?.error || fallback) + (data?.fields ? '' : ''), 'error');
      return;
    }
    const order = data.order;
    store.recordOrder(order, data.token);          // cart is cleared only now, after the save
    requestKey = newRequestKey();
    ga('purchase', {
      transaction_id: order.id, currency: 'INR', value: order.totals.total, payment_type: 'cash_on_delivery',
      items: order.items.map((i) => ({ item_name: i.name, price: i.unitPrice, quantity: i.qty })),
    });
    renderConfirmation(order);
    location.hash = '#/confirmation';
  } catch (err) {
    console.error('[KickCanvas] placing the order failed:', err);
    // fetch() only throws TypeError for network failures; anything else is a problem on this page
    const network = err instanceof TypeError && /fetch|network|load failed/i.test(err.message || '');
    setPayMsg(network
      ? 'We couldn’t reach KickCanvas. Check your connection and try again — your cart is safe.'
      : 'Something went wrong on this page. Refresh the page and try again — your cart is safe.', 'error');
  } finally {
    placing = false;
    btn.textContent = 'Place order';
    renderCheckout();
  }
});

/* =========================================================== confirmation + tracking */
const fmtDate = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const pill = (status, label) => `<span class="status-pill" data-s="${esc(status)}">${esc(label || ORDER_STATUSES[status]?.label || status)}</span>`;

function itemLines(order) {
  return order.items.map((i) => `
    <div class="cf-item">
      <span><b>${esc(i.name)}</b> · ${esc(i.size)} · × ${i.qty}</span><span class="num">${money(i.lineTotal)}</span>
      <span class="muted">${esc(i.pairMode === 'split' ? `Left: ${i.summary.left} · Right: ${i.summary.right}` : i.summary.left)} · ${money(i.unitPrice)} per pair</span>
    </div>`).join('');
}

function renderConfirmation(order) {
  $('#cfTitle').textContent = SETTINGS.orders.pendingTitle;
  $('#cfLede').textContent = SETTINGS.orders.pendingMessage;
  const t = order.totals;
  $('#cfDetail').innerHTML = `
    <dt>Order ID</dt><dd class="num">${esc(order.id)}</dd>
    <dt>Placed</dt><dd>${esc(fmtDate(order.createdAt))}</dd>
    <dt>Status</dt><dd>${pill(order.status, order.statusLabel)}</dd>
    <dt>Payment</dt><dd>${esc(order.paymentMethod)}</dd>
    <dt>Subtotal</dt><dd class="num">${money(t.subtotal)}</dd>
    ${t.discount ? `<dt>Discount</dt><dd class="num">−${money(t.discount)}${order.coupon ? ` (${esc(order.coupon)})` : ''}</dd>` : ''}
    <dt>Shipping</dt><dd class="num">${t.shipping ? money(t.shipping) : 'Free'}</dd>
    <dt>Total</dt><dd class="num"><b>${money(t.total)}</b> · pay on delivery</dd>`;
  $('#cfItems').innerHTML = itemLines(order);
}

function renderTrackCard(order) {
  const steps = order.history.map((h) => `
    <li class="track-step" data-done="true" data-current="${h === order.history[order.history.length - 1]}">
      <span class="track-dot"><svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <div><b>${esc(h.label)}</b><span>${esc(fmtDate(h.at))}${h.note ? ` · ${esc(h.note)}` : ''}</span></div>
    </li>`).join('');
  return `
    <div class="panel track-card">
      <div class="track-card__head">
        <div><span class="eyebrow">Order</span><div class="display-m num">${esc(order.id)}</div></div>
        ${pill(order.status, order.statusLabel)}
      </div>
      <p class="small muted" style="margin-top:8px">${esc(order.statusNote || '')}</p>
      <div class="cf-items" style="margin-inline:0;max-width:none">${itemLines(order)}</div>
      <div class="co-line is-total" style="margin-top:12px"><span>Total · ${esc(order.paymentMethod)}</span><span class="num">${money(order.totals.total)}</span></div>
      <ol class="track-list">${steps}</ol>
    </div>`;
}

async function fetchOrderStatus(body) {
  const res = await fetch('/.netlify/functions/order-status', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok || !data?.ok) throw new Error(data?.error || 'We couldn’t load that order right now. Please try again.');
  return data.order;
}

/** Orders placed from this browser load automatically with their private token. */
async function renderMyOrders() {
  const host = $('#myOrders');
  if (!store.myOrders.length) { host.innerHTML = ''; return; }
  host.innerHTML = `<p class="eyebrow" style="margin-top:30px">Orders from this device</p><div id="myOrderCards"><p class="small muted" style="margin-top:12px">Loading the latest status…</p></div>`;
  const cards = await Promise.all(store.myOrders.slice(0, 10).map((o) =>
    fetchOrderStatus({ id: o.id, token: o.token }).then(renderTrackCard).catch((e) =>
      `<div class="panel track-card"><b class="num">${esc(o.id)}</b><p class="track-msg" data-state="error">${esc(e.message)}</p></div>`)));
  $('#myOrderCards').innerHTML = cards.join('');
}

$('#trackForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#trackId').value.trim().toUpperCase();
  const email = $('#trackEmail').value.trim();
  const box = $('#trackResult');
  if (!id) { toast('Enter your order ID'); return; }
  const mine = store.myOrder(id);
  if (!mine && !email) { box.innerHTML = `<p class="track-msg" data-state="error">Enter the email you used for this order.</p>`; return; }
  box.innerHTML = `<p class="track-msg">Checking…</p>`;
  try {
    const order = await fetchOrderStatus(mine ? { id, token: mine.token } : { id, email });
    box.innerHTML = renderTrackCard(order);
    ga('track_order', { order_id: id });
  } catch (err) {
    box.innerHTML = `<p class="track-msg" data-state="error">${esc(err.message)}</p>`;
  }
});
$('#btnTrackLast').addEventListener('click', () => { location.hash = '#/track'; });

/* =========================================================== deep links */
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-customize]');
  if (a) store.setModel(a.dataset.customize);
});

/* =========================================================== boot */
buildModelOptions();
buildSizes();
buildSwatches();
buildFinishes();
buildStyleCards();
buildFinishCards();
buildCredits();
$('#qtyInput').value = store.state.qty;
syncAll();
renderCart();
renderCheckout();

store.subscribe((evt) => { if (evt.type === 'cart' || evt.type === 'order') renderCheckout(); });


/* =========================================================== drop list (lead capture)
 * The only conversion the site can complete while it is pre-launch. Posts to the Netlify
 * form declared in index.html; GA4's `generate_lead` fires only on a confirmed 2xx, so the
 * conversion count in the report is of real submissions, never of optimistic UI. */
const LS_LEADS = 'kc.leads.v1';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

function describeDesign() {
  try {
    const p = PRODUCTS[store.state.model];
    const parts = store.side.parts || {};
    const painted = Object.keys(parts).filter((k) => parts[k] && parts[k].color).length;
    const prints = (store.side.decals || []).length;
    const fin = store.state.finish && store.state.finish !== 'original' ? ` · ${store.state.finish} finish` : '';
    return `${p ? p.name : store.state.model} · ${painted} parts recoloured${fin} · ${prints} print${prints === 1 ? '' : 's'}`;
  } catch { return store.state.model || ''; }
}

async function submitLead(email, source) {
  const body = new URLSearchParams({
    'form-name': 'waitlist',
    email,
    source,
    design: source === 'configurator' ? describeDesign() : '',
    company: '',                                   // honeypot: must stay empty
  });
  const res = await fetch('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
}

/** Wires one capture widget. The host is a <form> on the home page and a <div> inside the
 *  configurator rail (a nested form would be discarded by the parser), so the trigger is the
 *  form's submit where there is one and the button and Enter key where there is not. */
function wireWaitlist(formSel, inputSel, btnSel, msgSel) {
  const form = $(formSel), input = $(inputSel), btn = $(btnSel), msg = $(msgSel);
  if (!form || !input || !btn || !msg) return;
  const source = form.dataset.source || 'home';
  const say = (text, state) => { msg.textContent = text; msg.dataset.state = state || ''; };

  const send = async (e) => {
    e.preventDefault();
    const email = input.value.trim();
    if (!EMAIL_RE.test(email)) {
      say('That email address does not look right — check it and try again.', 'error');
      input.focus();
      return;
    }
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Joining…';
    ga('lead_attempt', { lead_source: source });
    try {
      await submitLead(email, source);
      const seen = JSON.parse(localStorage.getItem(LS_LEADS) || '[]');
      if (!seen.includes(email)) { seen.push(email); localStorage.setItem(LS_LEADS, JSON.stringify(seen)); }
      form.hidden = true;
      input.value = '';
      say('You are on the list. We will email you the day the first drop opens.', 'ok');
      // GA4's recommended lead event — marked as a key event in the interface
      // `lead_source`, not `source`: GA4 uses `source` for traffic attribution, and a custom
      // event parameter of that name can collide with it and never populate its dimension
      ga('generate_lead', { lead_source: source, currency: 'INR', value: 0 });
      toast('You are on the drop list');
    } catch {
      btn.disabled = false;
      btn.textContent = label;
      say('We could not reach the server. Email hello@kickcanvas.in and we will add you by hand.', 'error');
      ga('lead_failed', { lead_source: source });
    }
  };

  if (form.tagName === 'FORM') form.addEventListener('submit', send);
  else {
    btn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(e); });
  }
}
wireWaitlist('#waitlistForm', '#waitlistEmail', '#waitlistBtn', '#waitlistMsg');
wireWaitlist('#railWaitlistForm', '#railWaitlistEmail', '#railWaitlistBtn', '#railWaitlistMsg');

/* =========================================================== share a design (UGC) */
const SHARE_TEXT = `I designed this on KickCanvas. Build yours at ${SITE.replace(/^https?:\/\//, '')} #KickCanvas`;

$('#btnShareDesign')?.addEventListener('click', async function () {
  const btn = this;
  btn.disabled = true;
  try {
    await nextFrame();
    // a share image is looked at full size, so capture larger than a cart thumbnail
    const dataUrl = viewer.capturePreview({ width: PREVIEW_SIZE.width * 2, height: PREVIEW_SIZE.height * 2 });
    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], 'kickcanvas-design.png', { type: 'image/png' });
    const payload = { title: 'My KickCanvas design', text: SHARE_TEXT, files: [file] };

    if (navigator.canShare?.(payload)) {
      await navigator.share(payload);                       // phones: the real share sheet
      ga('share', { method: 'web_share', content_type: 'design', item_id: store.state.model });
      toast('Thanks for sharing — tag #KickCanvas');
    } else {
      const a = document.createElement('a');                 // desktop: download + copy caption
      a.href = dataUrl;
      a.download = 'kickcanvas-design.png';
      a.click();
      try { await navigator.clipboard.writeText(SHARE_TEXT); } catch {}
      ga('share', { method: 'download', content_type: 'design', item_id: store.state.model });
      toast('Image saved and caption copied — post it with #KickCanvas');
    }
  } catch {
    toast('Could not create the image. Try again once the shoe has finished loading.');
  } finally {
    btn.disabled = false;
  }
});

/* =========================================================== Product structured data
 * Emitted from the catalogue so the markup can never drift from the prices and
 * availability the site actually serves. */
function renderProductSchema() {
  const node = $('#productSchema');
  if (!node) return;
  node.textContent = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': Object.values(PRODUCTS).filter((p) => p.visible !== false).map((p) => ({
      '@type': 'Product',
      name: p.name,
      description: p.blurb || p.sub || `${p.name} — a customisable KickCanvas sneaker.`,
      image: `https://kickcanvas.netlify.app/assets/posters/${p.id}-card.jpg`,
      brand: { '@id': 'https://kickcanvas.netlify.app/#org' },
      category: 'Custom sneakers',
      offers: {
        '@type': 'Offer',
        url: 'https://kickcanvas.netlify.app/design',
        priceCurrency: 'INR',
        price: String(p.price),
        availability: isPurchasable(p) ? 'https://schema.org/InStock' : 'https://schema.org/PreOrder',
        areaServed: { '@type': 'Country', name: 'India' },
      },
    })),
  });
}
renderProductSchema();

showPage(parseHash(), { scroll: false });

/* =========================================================== published site settings
 * Prices, product names/descriptions/availability, the hero and announcement text, shipping and
 * whether orders are open all come from the admin panel. The defaults above render first; the
 * published settings replace them as soon as they arrive. ?kcpreview=1 shows an administrator
 * their unpublished draft (the server only returns a draft to a signed-in admin). */
function applySiteSettings(settings, { preview = false } = {}) {
  SETTINGS.products = settings.products; SETTINGS.content = settings.content; SETTINGS.orders = settings.orders;
  applyCatalogue(PRODUCTS, settings);
  PRICING.shipping = settings.orders.shipping;
  PRICING.freeShippingOver = settings.orders.freeShippingOver;

  const set = (id, v) => { const el = document.getElementById(id); if (el && typeof v === 'string' && v) el.textContent = v; };
  const c = settings.content;
  set('announceText', c.announcement); set('heroBadge', c.heroBadge);
  set('heroLine1', c.heroLine1); set('heroLine2', c.heroLine2); set('heroText', c.heroText);
  set('bandHeading', c.bandHeading); set('bandText', c.bandText);

  const shown = Object.values(PRODUCTS).filter((p) => p.visible !== false);
  if (shown.length) {
    const prices = shown.map((p) => p.price);
    const lo = Math.min(...prices), hi = Math.max(...prices);
    set('heroFrom', `From ${money(lo)}`);
    $$('[data-price-range]').forEach((el) => { el.textContent = lo === hi ? money(lo) : `${money(lo)} to ${money(hi)}`; });
    if (PRODUCTS[store.state.model]?.visible === false) store.setModel(shown[0].id);
  }
  buildModelOptions();
  buildStyleCards();
  syncAll();
  store.repriceCart();
  renderCart();
  renderCheckout();
  renderProductSchema();
  if (currentPage === 'confirmation' && store.lastOrderId) { $('#cfTitle').textContent = SETTINGS.orders.pendingTitle; $('#cfLede').textContent = SETTINGS.orders.pendingMessage; }

  if (preview && !$('#previewBar')) {
    const bar = document.createElement('div');
    bar.id = 'previewBar'; bar.className = 'preview-bar'; bar.setAttribute('role', 'status');
    bar.innerHTML = 'Preview of unpublished changes — customers don’t see this yet. <a href="/admin#content">Back to admin</a>';
    document.body.prepend(bar);
  }
}

(async function loadSiteSettings() {
  const preview = new URLSearchParams(location.search).get('kcpreview') === '1';
  try {
    const res = await fetch('/.netlify/functions/site-settings' + (preview ? '?preview=1' : ''), { cache: 'no-store' });
    if (!res.ok) return;                       // no backend (e.g. a static preview): keep defaults
    const data = await res.json();
    if (data?.ok && data.settings) applySiteSettings(data.settings, { preview: data.preview });
  } catch { /* offline or no backend: the built-in defaults stay in place */ }
})();

// Prefetch a silhouette only when someone shows intent (hover, touch or focus on its button).
// The old blind preload pulled a second ~2 MB model 2.5 s after load and processed it on the main
// thread just as people started interacting; now nothing loads that wasn't asked for.
const prefetched = new Set();
const prefetch = (e) => {
  const b = e.target.closest?.('#modelOpts [data-model]');
  const id = b && b.dataset.model;
  if (!id || prefetched.has(id) || viewer.failed || viewer.records.has(id)) return;
  prefetched.add(id);
  viewer.loadModel(id).catch(() => prefetched.delete(id));
};
['pointerover', 'touchstart', 'focusin'].forEach((t) => document.addEventListener(t, prefetch, { passive: true }));

window.__kc = { store, viewer };   // handy for debugging from the console
