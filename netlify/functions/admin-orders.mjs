/**
 * GET  /.netlify/functions/admin-orders                     all orders + dashboard figures (admin)
 * POST /.netlify/functions/admin-orders  { id, status, note }  move an order along STATUS_FLOW (admin)
 */
import { json, fail, readJson, handle } from '../lib/http.mjs';
import { store, ORDERS } from '../lib/storage.mjs';
import { requireAdmin } from '../lib/auth.mjs';
import { adminView, ORDER_ID } from '../lib/orders.mjs';
import { ORDER_STATUSES, STATUS_FLOW } from '../../js/data/site-config.js';

async function allOrders(orders) {
  const { blobs } = await orders.list({ prefix: 'o/' });
  const out = [];
  for (let i = 0; i < blobs.length; i += 25) {
    const batch = await Promise.all(blobs.slice(i, i + 25).map((b) => orders.get(b.key, { type: 'json' })));
    out.push(...batch.filter(Boolean));
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function stats(list) {
  const count = Object.fromEntries(Object.keys(ORDER_STATUSES).map((k) => [k, 0]));
  let requested = 0, pendingValue = 0, confirmedSales = 0;
  for (const o of list) {
    count[o.status] = (count[o.status] || 0) + 1;
    requested += o.totals.total;
    if (o.status === 'pending') pendingValue += o.totals.total;
    if (['confirmed', 'processing', 'shipped', 'delivered'].includes(o.status)) confirmedSales += o.totals.total;
  }
  return { total: list.length, count, requested, pendingValue, confirmedSales };
}

export default handle(async (req) => {
  if (req.method === 'GET') {
    requireAdmin(req);
    const list = await allOrders(await store(ORDERS));
    return json({ ok: true, orders: list.map(adminView), stats: stats(list) });
  }
  if (req.method !== 'POST') return fail(405, 'Method not allowed.');
  const session = requireAdmin(req, { mutating: true });
  const body = await readJson(req, 4_000);
  const id = String(body.id || '').toUpperCase();
  if (!ORDER_ID.test(id)) return fail(400, 'Unknown order.');
  const next = String(body.status || '');
  if (!ORDER_STATUSES[next]) return fail(400, 'Unknown status.');

  const orders = await store(ORDERS);
  const order = await orders.get(`o/${id}`, { type: 'json' });
  if (!order) return fail(404, 'That order no longer exists.');
  if (!STATUS_FLOW[order.status].includes(next)) {
    return fail(409, `An order that is ${ORDER_STATUSES[order.status].label} can’t be moved to ${ORDER_STATUSES[next].label}.`, { order: adminView(order) });
  }
  const note = typeof body.note === 'string' ? body.note.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  const at = new Date().toISOString();
  order.status = next;
  order.updatedAt = at;
  order.history.push({ status: next, at, by: session.username, note: note || null });
  await orders.setJSON(`o/${id}`, order);
  return json({ ok: true, order: adminView(order) });
});
