/**
 * Pricing rules, shared by the browser (cart display) and the server (the price that is actually
 * recorded on an order). The server never trusts a price sent by the browser: it re-runs these
 * same functions against its own copy of the catalogue.
 */
import { PRICING } from './products.js';

const HEX = /^#[0-9a-f]{6}$/i;

/** Extras on one shoe: recoloured parts plus prints. Finish is NOT here - it is per pair. */
export function sideExtras(product, side) {
  let total = 0;
  for (const [key, cfg] of Object.entries(side?.parts || {})) {
    if (!product.parts.includes(key)) continue;
    if (cfg && HEX.test(cfg.color || '')) total += PRICING.colorDelta;
  }
  for (const d of side?.decals || []) total += d?.type === 'text' ? PRICING.textDelta : PRICING.artworkDelta;
  return total;
}

/** One finish for the whole sneaker, charged once per pair. */
export function finishDelta(finish) {
  return PRICING.finishDelta[finish] || 0;
}

/** Price of one pair. In left/right mode each shoe's extras are charged. */
export function pairPrice(product, { pairMode = 'same', sides, finish = 'original' }) {
  const left = sideExtras(product, sides?.left);
  const right = pairMode === 'split' ? sideExtras(product, sides?.right) : 0;
  return product.price + left + right + finishDelta(finish);
}

/** Cart / order totals from a subtotal. Shipping rules come from the published settings. */
export function orderTotals(subtotal, {
  couponRate = 0, shipping = PRICING.shipping, freeShippingOver = PRICING.freeShippingOver,
} = {}) {
  const discount = Math.round(subtotal * couponRate);
  const after = subtotal - discount;
  const ship = subtotal === 0 || (freeShippingOver > 0 && after >= freeShippingOver) ? 0 : shipping;
  return { subtotal, discount, shipping: ship, total: Math.max(0, after + ship) };
}
