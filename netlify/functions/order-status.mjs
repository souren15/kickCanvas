/**
 * POST /.netlify/functions/order-status   { id, token }  or  { id, email }
 * A customer reads the latest saved status of THEIR order. Requires the private token their
 * browser received when ordering, or the email used on the order. There is no way to list orders.
 */
import { json, fail, readJson, handle, clientIp, sha256, rateLimit } from '../lib/http.mjs';
import { store, ORDERS, META } from '../lib/storage.mjs';
import { publicView, ORDER_ID } from '../lib/orders.mjs';
import { timingSafeEqual } from 'node:crypto';

const NOT_FOUND = 'We couldn’t find an order with those details. Check the order ID and the email you used.';
const eq = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export default handle(async (req, context) => {
  if (req.method !== 'POST') return fail(405, 'Method not allowed.');
  const body = await readJson(req, 4_000);
  const id = String(body.id || '').trim().toUpperCase();
  if (!ORDER_ID.test(id)) return fail(404, NOT_FOUND);
  const meta = await store(META);
  // email look-ups are rate limited so order IDs cannot be guessed against a known email
  if (!body.token) await rateLimit(meta, `rl/track/${sha256(clientIp(req, context)).slice(0, 40)}`, 20, 600, 'Too many attempts. Please wait a few minutes and try again.');
  const order = await (await store(ORDERS)).get(`o/${id}`, { type: 'json' });
  if (!order) return fail(404, NOT_FOUND);
  const ok = body.token
    ? eq(sha256(String(body.token)), order.tokenHash)
    : typeof body.email === 'string' && eq(body.email.trim().toLowerCase(), order.customer.email);
  if (!ok) return fail(404, NOT_FOUND);
  return json({ ok: true, order: publicView(order) });
});
