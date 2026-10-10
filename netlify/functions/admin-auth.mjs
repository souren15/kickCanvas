/**
 * GET  /.netlify/functions/admin-auth                       { signedIn, username, configured }
 * POST /.netlify/functions/admin-auth  { action: 'login', username, password }
 * POST /.netlify/functions/admin-auth  { action: 'logout' }
 */
import { timingSafeEqual } from 'node:crypto';
import { json, fail, readJson, handle, sameOrigin, clientIp, sha256, rateLimit } from '../lib/http.mjs';
import { store, META } from '../lib/storage.mjs';
import { adminConfig, verifyPassword, sessionCookie, clearedCookie, readSession } from '../lib/auth.mjs';

const same = (a, b) => { const x = Buffer.from(sha256(a)), y = Buffer.from(sha256(b)); return timingSafeEqual(x, y); };

export default handle(async (req, context) => {
  if (req.method === 'GET') {
    const s = readSession(req);
    return json({ ok: true, configured: !!adminConfig(), signedIn: !!s, username: s?.username || null });
  }
  if (req.method !== 'POST') return fail(405, 'Method not allowed.');
  if (!sameOrigin(req)) return fail(403, 'That request was blocked.');
  const body = await readJson(req, 4_000);

  if (body.action === 'logout') return json({ ok: true }, 200, { 'set-cookie': clearedCookie() });
  if (body.action !== 'login') return fail(400, 'Unknown action.');

  const cfg = adminConfig();
  if (!cfg) return fail(503, 'The admin account hasn’t been set up on the server yet. Follow ADMIN-SETUP.md to add ADMIN_USERNAME, ADMIN_PASSWORD_HASH and SESSION_SECRET in Netlify.');

  // 5 wrong attempts per 15 minutes per connection, then locked out until the window resets
  const meta = await store(META);
  const key = `rl/login/${sha256(clientIp(req, context)).slice(0, 40)}`;
  await rateLimit(meta, key, 5, 900, 'Too many sign-in attempts. Please wait 15 minutes and try again.', { count: false });

  const okUser = same(String(body.username || '').trim(), cfg.username);
  const okPass = verifyPassword(String(body.password || ''), cfg.hash);   // always run: no timing hint
  if (!okUser || !okPass) {
    await rateLimit(meta, key, 5, 900, 'Too many sign-in attempts. Please wait 15 minutes and try again.');
    return fail(401, 'That username and password don’t match.');
  }
  await meta.delete(key);
  return json({ ok: true, username: cfg.username }, 200, { 'set-cookie': sessionCookie(cfg.username, cfg.secret) });
});
