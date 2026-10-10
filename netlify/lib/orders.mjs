/** Order validation, trusted pricing, IDs and the customer-safe view of an order. */
import { randomBytes } from 'node:crypto';
import { PRICING, SIZES, FINISH_LIST } from '../../js/data/products.js';
import { pairPrice } from '../../js/data/pricing.js';
import { ORDER_STATUSES } from '../../js/data/site-config.js';

const PART_KEYS = new Set(['upper', 'panels', 'trim', 'detail', 'laces', 'tongue', 'heel', 'midsole', 'outsole']);
const FINISHES = new Map(FINISH_LIST.map((f) => [f.key, f.label]));
const HEX = /^#[0-9a-fA-F]{6}$/;
const PREVIEW = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_LINES = 10, MAX_QTY = 20, MAX_PAIRS = 20, MAX_DECALS = 4, MAX_PREVIEW = 400_000;

const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

export function cleanCustomer(c = {}) {
  const v = {
    name: clean(c.name, 80), email: clean(c.email, 120).toLowerCase(), phone: clean(c.phone, 20),
    address: clean(c.address, 200), apt: clean(c.apt, 120), city: clean(c.city, 60),
    state: clean(c.state, 60), pincode: clean(c.pincode, 6),
  };
  const digits = v.phone.replace(/\D/g, '');
  const phone = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  const errors = {};
  if (v.name.length < 2) errors.name = 'Please enter your name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) errors.email = 'Enter a valid email address.';
  if (!/^[6-9]\d{9}$/.test(phone)) errors.phone = 'Enter a valid 10-digit Indian mobile number.';
  if (v.address.length < 6) errors.address = 'Enter your street address.';
  if (v.city.length < 2) errors.city = 'Enter your city.';
  if (v.state.length < 2) errors.state = 'Enter your state.';
  if (!/^[1-9]\d{5}$/.test(v.pincode)) errors.pincode = 'Indian pincodes are 6 digits.';
  v.phone = phone;
  return { ok: Object.keys(errors).length === 0, value: v, errors };
}

function cleanSide(side, product) {
  const parts = {};
  for (const [key, cfg] of Object.entries(side?.parts || {})) {
    if (PART_KEYS.has(key) && product.parts.includes(key) && HEX.test(cfg?.color || '')) parts[key] = { color: cfg.color.toUpperCase() };
  }
  const decals = (Array.isArray(side?.decals) ? side.decals : []).slice(0, MAX_DECALS).map((d) =>
    d?.type === 'text' ? { type: 'text', text: clean(d.text, 14) || 'TEXT' } : { type: 'image' });
  return { parts, decals };
}

function describeSide(product, side, finish) {
  const bits = [];
  const n = Object.keys(side.parts).length;
  if (n) bits.push(`${n} part${n > 1 ? 's' : ''} recoloured`);
  if (finish !== 'original') bits.push(`${FINISHES.get(finish)} finish`);
  const texts = side.decals.filter((d) => d.type === 'text').map((d) => `“${d.text}”`);
  if (texts.length) bits.push(texts.join(', '));
  const arts = side.decals.filter((d) => d.type === 'image').length;
  if (arts) bits.push(`${arts} artwork`);
  return bits.length ? bits.join(' · ') : 'Original colourway';
}

/** Re-price every line from the trusted catalogue. Browser-sent prices are ignored entirely. */
export function cleanItems(items, catalogue) {
  if (!Array.isArray(items) || !items.length) return { ok: false, error: 'Your cart is empty.' };
  if (items.length > MAX_LINES) return { ok: false, error: `Please order at most ${MAX_LINES} designs at a time.` };
  const out = [];
  let pairs = 0;
  for (const raw of items) {
    const product = catalogue[raw?.model];
    if (!product) return { ok: false, error: 'One of the sneakers in your cart no longer exists. Please remove it and try again.' };
    if (!product.available) return { ok: false, error: `${product.name} isn’t available to order right now. Please remove it from your cart.` };
    const qty = Number(raw.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return { ok: false, error: 'Please choose a quantity between 1 and 20.' };
    if (!SIZES.includes(raw.size)) return { ok: false, error: 'Please choose a valid size.' };
    const pairMode = raw.pairMode === 'split' ? 'split' : 'same';
    const finish = FINISHES.has(raw.finish) ? raw.finish : 'original';
    const left = cleanSide(raw.design?.left, product);
    const right = pairMode === 'split' ? cleanSide(raw.design?.right, product) : structuredClone(left);
    const unitPrice = pairPrice(product, { pairMode, sides: { left, right }, finish });
    pairs += qty;
    out.push({
      model: product.id, name: product.name, size: raw.size, qty, pairMode, finish,
      finishLabel: FINISHES.get(finish), unitPrice, lineTotal: unitPrice * qty,
      design: { left, right },
      summary: { left: describeSide(product, left, finish), right: pairMode === 'split' ? describeSide(product, right, finish) : null },
      preview: typeof raw.preview === 'string' && raw.preview.length <= MAX_PREVIEW && PREVIEW.test(raw.preview) ? raw.preview : null,
    });
  }
  if (pairs > MAX_PAIRS) return { ok: false, error: `Please order at most ${MAX_PAIRS} pairs at a time.` };
  return { ok: true, items: out };
}

export function couponRate(code) {
  const key = clean(code, 20).toUpperCase();
  if (!key) return { ok: true, code: null, rate: 0 };
  const rate = PRICING.coupons[key];
  return rate ? { ok: true, code: key, rate } : { ok: false };
}

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   // no 0/O/1/I: easy to read out on a phone call
export function newOrderId() {
  const bytes = randomBytes(8);
  return 'KC-' + [...bytes].map((b) => ALPHABET[b % 32]).join('');
}

export const ORDER_ID = /^KC-[2-9A-HJ-NP-Z]{8}$/;

/** What a customer may see about their own order: no contact details, no admin-only notes. */
export function publicView(o) {
  const show = (h) => h.status === 'rejected' || h.status === 'cancelled';
  return {
    id: o.id, createdAt: o.createdAt, updatedAt: o.updatedAt,
    status: o.status, statusLabel: ORDER_STATUSES[o.status]?.label, statusNote: ORDER_STATUSES[o.status]?.note,
    history: o.history.map((h) => ({ status: h.status, label: ORDER_STATUSES[h.status]?.label, at: h.at, note: show(h) ? h.note || null : null })),
    items: o.items.map((i) => ({
      name: i.name, size: i.size, qty: i.qty, unitPrice: i.unitPrice, lineTotal: i.lineTotal,
      pairMode: i.pairMode, finishLabel: i.finishLabel, summary: i.summary,
    })),
    totals: o.totals, coupon: o.coupon, paymentMethod: o.paymentMethod,
    deliverTo: `${o.customer.name.split(' ')[0]}, ${o.customer.city}`,
  };
}

/** The full record for the admin panel (secrets stripped). */
export function adminView(o) {
  const { tokenHash, ...rest } = o;
  return { ...rest, statusLabel: ORDER_STATUSES[o.status]?.label };
}
