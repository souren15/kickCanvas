/**
 * Order statuses and the settings an administrator can edit, shared by the site, the admin panel
 * and the server functions. The server validates every settings change against these defaults.
 */
import { PRODUCTS, PRICING } from './products.js';

export const ORDER_STATUSES = {
  pending:    { label: 'Pending Confirmation', note: 'Order received. Our team will review it and confirm it.' },
  confirmed:  { label: 'Confirmed',  note: 'Approved by KickCanvas. Your pair is going into production.' },
  rejected:   { label: 'Rejected',   note: 'This order could not be accepted.' },
  processing: { label: 'Processing', note: 'Your pair is being made.' },
  shipped:    { label: 'Shipped',    note: 'Your pair is on its way.' },
  delivered:  { label: 'Delivered',  note: 'Delivered. Enjoy your sneakers.' },
  cancelled:  { label: 'Cancelled',  note: 'This order was cancelled.' },
};

/** Allowed admin moves. Customers can never change a status; new orders always start "pending". */
export const STATUS_FLOW = {
  pending: ['confirmed', 'rejected', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  rejected: [],
  cancelled: [],
};

export const PAYMENT_METHOD = 'Cash on Delivery';

export const DEFAULT_PENDING_TITLE = 'Your order has been placed successfully and is awaiting confirmation from KickCanvas.';
export const DEFAULT_PENDING_MESSAGE = 'We have received your order request. Our team will review your order and confirm it after approval. Your order is not confirmed yet. Please wait for confirmation from our team.';

/** Everything editable from the admin panel, with today's live site text as the default. */
export function defaultSettings() {
  return {
    products: Object.fromEntries(Object.values(PRODUCTS).map((p) => [p.id, {
      name: p.name, price: p.price, blurb: p.blurb, enabled: true, visible: true,
    }])),
    content: {
      announcement: 'Orders open · Pay with Cash on Delivery',
      heroBadge: 'Orders open',
      heroLine1: 'Custom sneakers.',
      heroLine2: 'Designed by you.',
      heroText: 'Your sneakers, your creativity, your canvas. Make every detail your own — colour, finish and artwork, on a real 3D shoe.',
      bandHeading: 'Every sneaker starts with a canvas.',
      bandText: 'Yours is blank right now. Design it, place your order, and pay in cash when it arrives — our team confirms every order before your pair is made.',
    },
    orders: {
      acceptingOrders: true,
      closedMessage: 'We are not taking new orders right now. Your design is saved — please check back soon.',
      pendingTitle: DEFAULT_PENDING_TITLE,
      pendingMessage: DEFAULT_PENDING_MESSAGE,
      shipping: PRICING.shipping,
      freeShippingOver: PRICING.freeShippingOver,
    },
  };
}

/** Field limits used by the server to validate an admin's settings and by the admin form. */
export const LIMITS = {
  name: 40, blurb: 260, price: [0, 100000],
  announcement: 140, heroBadge: 40, heroLine1: 40, heroLine2: 40, heroText: 260,
  bandHeading: 80, bandText: 260, closedMessage: 260, pendingTitle: 200, pendingMessage: 400,
  shipping: [0, 2000], freeShippingOver: [0, 100000],
};

/** Human names for settings, used in validation messages. */
export const FIELD_LABELS = {
  announcement: 'Announcement bar', heroBadge: 'Hero badge', heroLine1: 'Hero heading, first line',
  heroLine2: 'Hero heading, second line', heroText: 'Hero supporting text',
  bandHeading: 'Promotional banner heading', bandText: 'Promotional banner text',
  closedMessage: 'Message shown when orders are closed', pendingTitle: 'Order received heading',
  pendingMessage: 'Order received message', shipping: 'Shipping charge', freeShippingOver: 'Free shipping on orders over',
};

/**
 * Validate settings coming from the admin panel. Unknown keys are dropped, every string is
 * trimmed and length-limited, numbers are clamped integers. Returns { ok, settings, errors }.
 */
export function cleanSettings(input) {
  const base = defaultSettings();
  const errors = [];
  const str = (v, max, field, fallback) => {
    const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
    if (!s) { errors.push(`${field} cannot be empty`); return fallback; }
    if (s.length > max) { errors.push(`${field} must be ${max} characters or fewer`); return s.slice(0, max); }
    return s;
  };
  const int = (v, [lo, hi], field, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi || Math.round(n) !== n) { errors.push(`${field} must be a whole number from ${lo} to ${hi}`); return fallback; }
    return n;
  };
  const out = { products: {}, content: {}, orders: {} };
  for (const [id, def] of Object.entries(base.products)) {
    const p = input?.products?.[id] || {};
    const label = PRODUCTS[id].name;
    out.products[id] = {
      name: str(p.name ?? def.name, LIMITS.name, `${label} name`, def.name),
      price: int(p.price ?? def.price, LIMITS.price, `${label} price`, def.price),
      blurb: str(p.blurb ?? def.blurb, LIMITS.blurb, `${label} description`, def.blurb),
      enabled: p.enabled === undefined ? def.enabled : p.enabled === true,
      visible: p.visible === undefined ? def.visible : p.visible === true,
    };
  }
  if (!Object.values(out.products).some((p) => p.visible)) errors.push('At least one product must stay visible');
  for (const [k, def] of Object.entries(base.content)) {
    out.content[k] = str(input?.content?.[k] ?? def, LIMITS[k], FIELD_LABELS[k], def);
  }
  const o = input?.orders || {};
  out.orders = {
    acceptingOrders: o.acceptingOrders === undefined ? true : o.acceptingOrders === true,
    closedMessage: str(o.closedMessage ?? base.orders.closedMessage, LIMITS.closedMessage, FIELD_LABELS.closedMessage, base.orders.closedMessage),
    pendingTitle: str(o.pendingTitle ?? base.orders.pendingTitle, LIMITS.pendingTitle, FIELD_LABELS.pendingTitle, base.orders.pendingTitle),
    pendingMessage: str(o.pendingMessage ?? base.orders.pendingMessage, LIMITS.pendingMessage, FIELD_LABELS.pendingMessage, base.orders.pendingMessage),
    shipping: int(o.shipping ?? base.orders.shipping, LIMITS.shipping, FIELD_LABELS.shipping, base.orders.shipping),
    freeShippingOver: int(o.freeShippingOver ?? base.orders.freeShippingOver, LIMITS.freeShippingOver, FIELD_LABELS.freeShippingOver, base.orders.freeShippingOver),
  };
  return { ok: errors.length === 0, settings: out, errors };
}

/**
 * Apply published settings to a product catalogue in place (the browser does this to PRODUCTS;
 * the server does it to its own copy). Hidden products disappear from the site; disabled ones
 * stay visible but cannot be ordered.
 */
export function applyCatalogue(products, settings) {
  for (const [id, p] of Object.entries(products)) {
    const s = settings?.products?.[id];
    if (!s) continue;
    p.name = s.name; p.price = s.price; p.blurb = s.blurb;
    p.visible = s.visible !== false;
    p.available = s.enabled !== false && p.visible;
    p.status = p.available ? 'AVAILABLE' : 'UNAVAILABLE';
  }
  return products;
}
