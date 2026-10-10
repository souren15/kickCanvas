/**
 * POST /.netlify/functions/orders-create
 * Customer places a Cash on Delivery order. The order is validated and priced on the server from
 * the trusted catalogue, saved with status "pending", and needs an administrator to confirm it.
 */
import { randomBytes } from 'node:crypto';
import { json, fail, readJson, handle, sameOrigin, clientIp, sha256, rateLimit } from '../lib/http.mjs';
import { store, ORDERS, META } from '../lib/storage.mjs';
import { liveSettings, catalogueFrom } from '../lib/catalog.mjs';
import { cleanCustomer, cleanItems, couponRate, newOrderId, publicView } from '../lib/orders.mjs';
import { orderTotals } from '../../js/data/pricing.js';
import { PAYMENT_METHOD } from '../../js/data/site-config.js';

export default handle(async (req, context) => {
  if (req.method !== 'POST') return fail(405, 'Method not allowed.');
  if (!sameOrigin(req)) return fail(403, 'That request was blocked.');
  const body = await readJson(req, 4_500_000);   // up to ten small preview images

  const settings = await liveSettings();
  if (!settings.orders.acceptingOrders) return fail(503, settings.orders.closedMessage, { code: 'closed' });

  // Duplicate protection: the checkout sends one random key per order attempt. A double-click,
  // a retry after a timeout or a resubmitted form returns the order that was already saved.
  const key = typeof body.requestKey === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(body.requestKey) ? body.requestKey : null;
  if (!key) return fail(400, 'Please refresh the page and try again.');
  const meta = await store(META);
  const orders = await store(ORDERS);
  const seen = await meta.get(`idem/${key}`, { type: 'json' });
  if (seen?.id) {
    const existing = await orders.get(`o/${seen.id}`, { type: 'json' });
    if (existing) return json({ ok: true, duplicate: true, order: publicView(existing), token: seen.token });
  }

  if (body.paymentMethod !== 'cod') return fail(422, 'Cash on Delivery is the only payment method.');
  const customer = cleanCustomer(body.customer);
  if (!customer.ok) return fail(422, 'Please check the highlighted details.', { fields: customer.errors });
  const items = cleanItems(body.items, catalogueFrom(settings));
  if (!items.ok) return fail(422, items.error);
  const coupon = couponRate(body.coupon);
  if (!coupon.ok) return fail(422, 'That coupon code isn’t valid. Remove it and try again.');

  // at most 30 orders per hour from one network address: stops scripted floods of fake orders
  // while leaving room for a class demo where everyone shares the college Wi-Fi's address
  await rateLimit(meta, `rl/order/${sha256(clientIp(req, context)).slice(0, 40)}`, 30, 3600,
    'Too many orders from this connection. Please try again later or email hello@kickcanvas.in.');

  const subtotal = items.items.reduce((n, i) => n + i.lineTotal, 0);
  const totals = orderTotals(subtotal, {
    couponRate: coupon.rate, shipping: settings.orders.shipping, freeShippingOver: settings.orders.freeShippingOver,
  });

  let id = newOrderId();
  for (let i = 0; i < 5 && (await orders.get(`o/${id}`)); i++) id = newOrderId();

  const token = randomBytes(24).toString('base64url');   // lets this customer's browser read its own order
  const now = new Date().toISOString();
  const order = {
    id, createdAt: now, updatedAt: now,
    status: 'pending',
    history: [{ status: 'pending', at: now, by: 'customer', note: null }],
    customer: customer.value,
    items: items.items,
    totals, coupon: coupon.code,
    paymentMethod: PAYMENT_METHOD,
    tokenHash: sha256(token),
  };
  await orders.setJSON(`o/${id}`, order);
  await meta.setJSON(`idem/${key}`, { id, token, at: now });
  return json({ ok: true, order: publicView(order), token }, 201);
});
