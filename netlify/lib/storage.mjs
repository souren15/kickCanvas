/**
 * Persistent storage: Netlify Blobs (built into every Netlify site, no extra account).
 * Two stores:
 *   kc-orders  one JSON record per order, key "o/<ORDER-ID>"
 *   kc-meta    published + draft site settings, duplicate-submission keys, rate-limit counters
 * Strong consistency, so an order written by a customer is immediately visible to the admin.
 *
 * globalThis.__KC_STORE__ lets the identical function code be exercised by a local test harness
 * against files on disk. Nothing in production can set it.
 */
let factory = null;

export const ORDERS = 'kc-orders';
export const META = 'kc-meta';

export async function store(name) {
  if (globalThis.__KC_STORE__) return globalThis.__KC_STORE__(name);
  if (!factory) {
    const { getStore } = await import('@netlify/blobs');
    factory = (n) => getStore({ name: n, consistency: 'strong' });
  }
  return factory(name);
}
