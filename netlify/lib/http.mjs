import { createHash } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex',
};

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...BASE_HEADERS, ...headers } });

export const fail = (status, error, extra = {}) => json({ ok: false, error, ...extra }, status);

export async function readJson(req, maxBytes = 200_000) {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > maxBytes) throw new HttpError(413, 'That request is too large.');
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, 'That request is too large.');
  try { return JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'The request could not be read.'); }
}

export function clientIp(req, context) {
  return context?.ip || req.headers.get('x-nf-client-connection-ip')
    || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
}

/** Browsers send Origin on POST/PUT. Reject cross-site requests outright. */
export function sameOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try { return new URL(origin).host === new URL(req.url).host; } catch { return false; }
}

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

/**
 * Fixed-window counter in the meta store. Throws 429 once `limit` hits occur within `windowSec`.
 * `count: false` only checks without adding a hit (used to block before verifying a password).
 */
export async function rateLimit(meta, key, limit, windowSec, message, { count = true } = {}) {
  const now = Math.floor(Date.now() / 1000);
  let rec = await meta.get(key, { type: 'json' });
  if (!rec || rec.reset <= now) rec = { n: 0, reset: now + windowSec };
  if (rec.n >= limit) throw new HttpError(429, message, { retryAfter: rec.reset - now });
  if (count) { rec.n += 1; await meta.setJSON(key, rec); }
  return rec;
}

/** Wrap a handler: known errors become clean JSON, anything else a generic 500 (details logged). */
export function handle(fn) {
  return async (req, context) => {
    try {
      return await fn(req, context);
    } catch (e) {
      if (e instanceof HttpError) return fail(e.status, e.message, e.extra);
      console.error('[kickcanvas]', e);
      return fail(500, 'Something went wrong on our side. Please try again in a moment.');
    }
  };
}
