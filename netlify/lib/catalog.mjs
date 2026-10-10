/** The server's trusted view of products and site settings. Never taken from the browser. */
import { PRODUCTS } from '../../js/data/products.js';
import { defaultSettings, cleanSettings, applyCatalogue } from '../../js/data/site-config.js';
import { store, META } from './storage.mjs';

/** Stored settings are re-validated on read, so fields added later fall back to defaults. */
export async function readSettings(kind = 'live') {
  const meta = await store(META);
  const saved = await meta.get(`settings/${kind}`, { type: 'json' });
  return saved ? cleanSettings(saved).settings : null;
}

export async function liveSettings() {
  return (await readSettings('live')) || defaultSettings();
}

export function catalogueFrom(settings) {
  return applyCatalogue(structuredClone(PRODUCTS), settings);
}
