/**
 * Application state: the design being configured, the cart, and past orders.
 * Pure data + persistence. Nothing here touches the DOM or the 3D engine.
 */
import { PRODUCTS, PRICING, SIZES, FINISH_LIST, isPurchasable } from '../data/products.js';
import { sideExtras, pairPrice as pricePair, orderTotals } from '../data/pricing.js';

const FINISH_KEYS = new Set(FINISH_LIST.map((f) => f.key).filter((k) => k !== 'original'));
const FINISH_LABEL = Object.fromEntries(FINISH_LIST.map((f) => [f.key, f.label]));

/** Drop per-part finish fields (pre-global designs); a part left with no colour is removed. */
function stripPartFinishes(sides) {
  for (const side of [sides.left, sides.right]) {
    for (const [key, cfg] of Object.entries(side.parts || {})) {
      if (!cfg) { delete side.parts[key]; continue; }
      delete cfg.finish;
      if (!cfg.color) delete side.parts[key];
    }
  }
}

const LS = {
  cart: 'kc_cart_v2',
  orders: 'kc_orders_v2',         // legacy (pre-server) local orders; no longer written
  mine: 'kc_my_orders',           // { id, token } for orders placed from this browser
  design: 'kc_design_v2',
  last: 'kc_last_order',
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }   // private mode / quota: the app still works for this session
}

export const money = (n) => '₹' + Math.round(n).toLocaleString('en-IN');

export function blankSide() { return { parts: {}, decals: [] }; }

export function blankState() {
  return {
    model: 'street-low',
    pairMode: 'same',         // 'same' | 'split'
    active: 'left',
    sides: { left: blankSide(), right: blankSide() },
    finish: 'original',       // ONE finish for the whole sneaker (both shoes); colour stays per part
    size: SIZES[3],
    qty: 1,
  };
}

/** Tiny observable store. */
class Emitter {
  constructor() { this._subs = new Set(); }
  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
  emit(payload) { this._subs.forEach((f) => { try { f(payload); } catch (e) { console.error(e); } }); }
}

export class Store extends Emitter {
  constructor() {
    super();
    this.state = this._restore();
    // a cart restored from an earlier session may hold products that are no longer for sale
    this.cart = read(LS.cart, []).filter((i) => i && i.id && isPurchasable(PRODUCTS[i.model]));
    this.myOrders = read(LS.mine, []);
    this.discount = { code: null, rate: 0 };
  }

  _restore() {
    const saved = read(LS.design, null);
    const base = blankState();
    if (!saved || !saved.sides || !PRODUCTS[saved.model]) return base;
    const state = {
      ...base, ...saved,
      sides: {
        left: { parts: saved.sides.left?.parts || {}, decals: saved.sides.left?.decals || [] },
        right: { parts: saved.sides.right?.parts || {}, decals: saved.sides.right?.decals || [] },
      },
    };
    state.finish = Store.migrateFinish(state);
    return state;
  }

  /**
   * Finish used to be stored on each part. Designs saved that way are converted once: the upper's
   * finish wins (it is the largest panel and what people pick first), otherwise the most-used one.
   * Per-part finish fields are then dropped so they can never disagree with the global setting.
   */
  static migrateFinish(state) {
    const valid = (f) => f && (f === 'original' || FINISH_KEYS.has(f));
    if (valid(state.finish) && state.finish !== 'original') { stripPartFinishes(state.sides); return state.finish; }
    const counts = {};
    let upper = null;
    for (const side of [state.sides.left, state.sides.right]) {
      for (const [key, cfg] of Object.entries(side.parts || {})) {
        if (!cfg || !valid(cfg.finish) || cfg.finish === 'original') continue;
        counts[cfg.finish] = (counts[cfg.finish] || 0) + 1;
        if (key === 'upper' && !upper) upper = cfg.finish;
      }
    }
    stripPartFinishes(state.sides);
    return upper || Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'original';
  }

  /* ------------------------------------------------------------- design */
  get product() { return PRODUCTS[this.state.model]; }
  get side() { return this.state.sides[this.state.active]; }
  get otherKey() { return this.state.active === 'left' ? 'right' : 'left'; }

  /** The design object handed to the viewer. */
  viewDesign() {
    const s = this.side;
    return { parts: s.parts, decals: s.decals, mirror: this.state.active === 'right', finish: this.state.finish || 'original' };
  }

  _mirrorIfNeeded() {
    if (this.state.pairMode === 'same') {
      this.state.sides[this.otherKey] = structuredClone(this.side);
    }
  }

  /** Mutate the active side, mirror to the other if the pair is linked, persist and notify. */
  update(mutator, meta = {}) {
    mutator(this.side, this.state);
    this._mirrorIfNeeded();
    this.persistDesign();
    this.emit({ type: 'design', ...meta });
  }

  setModel(id) {
    if (!PRODUCTS[id] || this.state.model === id) return;
    this.state.model = id;
    // customisation is kept across models: parts and decals are shared keys, and each decal
    // remembers a placement per model, so switching back restores exactly what you had.
    this.persistDesign();
    this.emit({ type: 'model' });
  }

  setPairMode(mode) {
    this.state.pairMode = mode;
    if (mode === 'same') this.state.sides.right = structuredClone(this.state.sides.left);
    this.persistDesign();
    this.emit({ type: 'pairmode' });
  }

  setActiveSide(which) {
    if (this.state.active === which) return;
    this.state.active = which;
    this.persistDesign();
    this.emit({ type: 'side' });
  }

  setPartColor(part, hex) {
    this.update((s) => {
      if (hex) s.parts[part] = { ...(s.parts[part] || {}), color: hex };
      else delete s.parts[part];
    }, { part });
  }

  /** Finish is a whole-sneaker setting: every part of both shoes, colours untouched. */
  setFinish(finish) {
    if (finish !== 'original' && !FINISH_KEYS.has(finish)) return;
    if (this.state.finish === finish) return;
    this.state.finish = finish;
    this.persistDesign();
    this.emit({ type: 'design', finish });
  }

  resetPart(part) {
    this.update((s) => { delete s.parts[part]; }, { part });
  }

  resetAll() {
    this.state.sides.left = blankSide();
    this.state.sides.right = blankSide();
    this.state.finish = 'original';
    this.persistDesign();
    this.emit({ type: 'design', reset: true });
  }

  persistDesign() {
    // decal image sources can be large; keep the design within a sane localStorage budget
    const ok = write(LS.design, this.state);
    if (!ok) this.emit({ type: 'storagefull' });
  }

  /* ------------------------------------------------------------- pricing */
  sidePrice(side) { return this.product.price + sideExtras(this.product, side); }

  get finishDelta() { return PRICING.finishDelta[this.state.finish] || 0; }

  pairPrice() {
    return pricePair(this.product, { pairMode: this.state.pairMode, sides: this.state.sides, finish: this.state.finish });
  }

  priceLines() {
    const p = this.product;
    const lines = [{ label: p.name, value: p.price }];
    if (this.finishDelta) lines.push({ label: `${FINISH_LABEL[this.state.finish]} finish`, value: this.finishDelta });
    const sides = this.state.pairMode === 'same' ? [['', this.state.sides.left]] : [['Left ', this.state.sides.left], ['Right ', this.state.sides.right]];
    for (const [prefix, side] of sides) {
      let colors = 0;
      for (const [key, cfg] of Object.entries(side.parts || {})) {
        if (!p.parts.includes(key)) continue;
        if (cfg.color) colors++;
      }
      if (colors) lines.push({ label: `${prefix}Custom colours × ${colors}`, value: colors * PRICING.colorDelta });
      const texts = (side.decals || []).filter((d) => d.type === 'text').length;
      const arts = (side.decals || []).filter((d) => d.type === 'image').length;
      if (texts) lines.push({ label: `${prefix}Custom text × ${texts}`, value: texts * PRICING.textDelta });
      if (arts) lines.push({ label: `${prefix}Artwork × ${arts}`, value: arts * PRICING.artworkDelta });
    }
    return lines;
  }

  /**
   * Published prices can change after something was added to the cart. Re-price every line from
   * the current catalogue so the cart always shows what the server will actually charge.
   */
  repriceCart() {
    let changed = false;
    for (const it of this.cart) {
      const p = PRODUCTS[it.model];
      if (!p) continue;
      const price = pricePair(p, { pairMode: it.pairMode, sides: it.design, finish: it.finish || 'original' });
      if (price !== it.unitPrice || it.name !== p.name) { it.unitPrice = price; it.name = p.name; changed = true; }
    }
    if (changed) { this.saveCart(); this.emit({ type: 'cart' }); }
  }

  /* ------------------------------------------------------------- cart */
  describe(side) {
    const p = this.product;
    const bits = [];
    const colored = Object.entries(side.parts || {}).filter(([k, c]) => c.color && p.parts.includes(k));
    if (colored.length) bits.push(`${colored.length} part${colored.length > 1 ? 's' : ''} recoloured`);
    if (this.state.finish && this.state.finish !== 'original') bits.push(`${FINISH_LABEL[this.state.finish]} finish`);
    const texts = (side.decals || []).filter((d) => d.type === 'text').map((d) => `“${d.text}”`);
    if (texts.length) bits.push(texts.join(', '));
    const arts = (side.decals || []).filter((d) => d.type === 'image').length;
    if (arts) bits.push(`${arts} artwork`);
    return bits.length ? bits.join(' · ') : 'Original colourway';
  }

  /**
   * Add the current design to the cart.
   * Refuses anything that is not purchasable: this is the single gate the UI, the checkout and
   * the payment handlers all rely on, so an unavailable product cannot reach a basket even if a
   * disabled button is bypassed from the console.
   */
  addToCart({ previews }) {
    if (!isPurchasable(this.product)) {
      this.emit({ type: 'unavailable', model: this.state.model });
      return null;
    }
    const item = {
      id: 'it' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      model: this.state.model,
      name: this.product.name,
      pairMode: this.state.pairMode,
      size: this.state.size,
      qty: Math.max(1, this.state.qty | 0),
      unitPrice: this.pairPrice(),
      design: structuredClone(this.state.sides),
      finish: this.state.finish || 'original',
      summary: {
        left: this.describe(this.state.sides.left),
        right: this.describe(this.state.sides.right),
      },
      previews,                       // { left:dataURL, right:dataURL|null }
      addedAt: Date.now(),
    };
    this.cart.push(item);
    this.saveCart();
    this.emit({ type: 'cart', added: item.id });
    return item;
  }

  changeQty(id, delta) {
    const it = this.cart.find((i) => i.id === id);
    if (!it) return;
    it.qty = Math.min(20, Math.max(1, it.qty + delta));
    this.saveCart();
    this.emit({ type: 'cart' });
  }

  removeFromCart(id) {
    this.cart = this.cart.filter((i) => i.id !== id);
    this.saveCart();
    this.emit({ type: 'cart' });
  }

  clearCart() { this.cart = []; this.saveCart(); this.emit({ type: 'cart' }); }

  saveCart() {
    if (!write(LS.cart, this.cart)) {
      // previews are by far the biggest field: drop them rather than lose the cart
      const slim = this.cart.map((i) => ({ ...i, previews: { left: null, right: null } }));
      if (write(LS.cart, slim)) this.cart = slim;
    }
  }

  get cartCount() { return this.cart.reduce((n, i) => n + i.qty, 0); }
  get subtotal() { return this.cart.reduce((n, i) => n + i.unitPrice * i.qty, 0); }

  applyCoupon(code) {
    const key = String(code || '').trim().toUpperCase();
    const rate = PRICING.coupons[key];
    if (!rate) { this.discount = { code: null, rate: 0 }; return { ok: false, message: 'That code isn’t valid.' }; }
    this.discount = { code: key, rate };
    return { ok: true, message: `${key} applied — ${Math.round(rate * 100)}% off.` };
  }

  totals() {
    return orderTotals(this.subtotal, { couponRate: this.discount.rate, shipping: PRICING.shipping, freeShippingOver: PRICING.freeShippingOver });
  }

  /* ------------------------------------------------------------- orders */
  /**
   * The order payload for the server. Prices are deliberately NOT sent: the server re-prices every
   * line from its own catalogue. Artwork images stay on this device; only the print count is sent.
   */
  orderPayload() {
    return this.cart.map((i) => ({
      model: i.model, size: i.size, qty: i.qty, pairMode: i.pairMode, finish: i.finish || 'original',
      design: Object.fromEntries(['left', 'right'].map((k) => [k, {
        parts: i.design?.[k]?.parts || {},
        decals: (i.design?.[k]?.decals || []).map((d) => (d.type === 'text' ? { type: 'text', text: d.text } : { type: 'image' })),
      }])),
      preview: i.previews?.left || null,
    }));
  }

  /** Called only AFTER the server has saved the order: then, and only then, the cart is cleared. */
  recordOrder(order, token) {
    this.myOrders = [{ id: order.id, token, at: order.createdAt }, ...this.myOrders.filter((o) => o.id !== order.id)].slice(0, 25);
    write(LS.mine, this.myOrders);
    write(LS.last, order.id);
    this.clearCart();
    this.discount = { code: null, rate: 0 };
    this.emit({ type: 'order', id: order.id });
  }

  myOrder(id) {
    const key = String(id || '').trim().toUpperCase();
    return this.myOrders.find((o) => o.id === key) || null;
  }

  /** Whether checkout may proceed at all, and why not if it may not. */
  canCheckout() {
    if (!this.cart.length) return { ok: false, reason: 'empty', message: 'Your cart is empty.' };
    const blocked = this.cart.filter((i) => !isPurchasable(PRODUCTS[i.model]));
    if (blocked.length) {
      return { ok: false, reason: 'unavailable',
        message: `${blocked.map((i) => i.name).join(', ')} isn’t available to order right now. Remove it from your cart to continue.` };
    }
    return { ok: true };
  }

  get lastOrderId() { return read(LS.last, null); }
}

export const store = new Store();
