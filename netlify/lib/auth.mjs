/**
 * Admin authentication, entirely server-side.
 *  - The password is never stored anywhere in plain text: Netlify holds a PBKDF2-SHA256 hash in the
 *    ADMIN_PASSWORD_HASH environment variable (generate it with /admin/setup.html or
 *    scripts/hash-password.mjs). No credential appears in any file the browser can download.
 *  - A successful sign-in sets an HMAC-signed, HttpOnly, Secure, SameSite=Strict cookie that
 *    expires after 8 hours. Its signature uses SESSION_SECRET, also only in the environment.
 *  - Every admin action re-verifies that cookie; state-changing actions additionally require a
 *    same-origin request carrying the X-KC-Admin header (CSRF defence in depth).
 */
import { pbkdf2Sync, createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { HttpError, sameOrigin } from './http.mjs';

const COOKIE = 'kc_admin';
const TTL_SECONDS = 8 * 60 * 60;

export function adminConfig() {
  const username = process.env.ADMIN_USERNAME;
  const hash = process.env.ADMIN_PASSWORD_HASH;
  const secret = process.env.SESSION_SECRET;
  if (!username || !hash || !secret || secret.length < 32) return null;
  return { username, hash, secret };
}

/** stored format: pbkdf2-sha256$<iterations>$<salt base64>$<hash base64> */
export function verifyPassword(password, stored) {
  const parts = String(stored || '').trim().split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 5_000_000) return false;
  const salt = Buffer.from(parts[2], 'base64');
  const expected = Buffer.from(parts[3], 'base64');
  if (salt.length < 16 || expected.length < 32) return false;
  const got = pbkdf2Sync(String(password), salt, iterations, expected.length, 'sha256');
  return timingSafeEqual(got, expected);
}

const sign = (data, secret) => createHmac('sha256', secret).update(data).digest('base64url');

const cookie = (value, maxAge) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

export function sessionCookie(username, secret) {
  const payload = Buffer.from(JSON.stringify({
    u: username, exp: Math.floor(Date.now() / 1000) + TTL_SECONDS, n: randomBytes(8).toString('hex'),
  })).toString('base64url');
  return cookie(`${payload}.${sign(payload, secret)}`, TTL_SECONDS);
}

export const clearedCookie = () => cookie('', 0);

export function readSession(req) {
  const cfg = adminConfig();
  if (!cfg) return null;
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)kc_admin=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/);
  if (!m) return null;
  const [, payload, sig] = m;
  const want = Buffer.from(sign(payload, cfg.secret));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!data || data.u !== cfg.username || !(data.exp > Date.now() / 1000)) return null;
  return { username: data.u, expiresAt: data.exp };
}

export function requireAdmin(req, { mutating = false } = {}) {
  const session = readSession(req);
  if (!session) throw new HttpError(401, 'Your admin session has ended. Please sign in again.');
  if (mutating && (req.headers.get('x-kc-admin') !== '1' || !sameOrigin(req))) {
    throw new HttpError(403, 'That request was blocked.');
  }
  return session;
}
