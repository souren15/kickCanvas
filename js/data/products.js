/**
 * Product catalogue. Prices in INR.
 *
 * Orders are open (Cash on Delivery, each one confirmed by an administrator). `available` is the
 * real data state every purchase path checks - the admin panel can switch a product off, and the
 * published site settings override name, price, description, availability and visibility.
 * `originalRough` matches the roughness baked into each GLB's own material so the "Original"
 * finish looks exactly like the supplied model.
 */
export const PRODUCTS = {
  'street-low': {
    id: 'street-low',
    name: 'KC—01 Vector',
    available: true,
    status: 'AVAILABLE',
    tagline: 'Sculpted runner',
    blurb: 'A chunky, layered runner with a sculpted air midsole and three neon speed lines you can recolour independently.',
    price: 4499,
    glb: 'assets/models/street-low.glb',
    glbLod: 'assets/models/street-low-lod.glb',
    masks: ['assets/models/street-low.mask0.webp', 'assets/models/street-low.mask1.webp', 'assets/models/street-low.mask2.webp'],
    partsJson: 'assets/models/street-low.parts.json',
    originalRough: 0.42,
    // the parts worth exposing for this silhouette, in panel order
    parts: ['upper', 'panels', 'trim', 'detail', 'laces', 'tongue', 'heel', 'midsole', 'outsole'],
    partLabels: { panels: 'Speed line 1', trim: 'Speed line 2', detail: 'Speed line 3' },
    credit: {
      title: 'A sleek, edgy sneaker with angular shapes, neon colors',
      author: 'PurpleShade3D, generated with Sloyd',
      licence: 'CC BY 4.0',
      url: 'https://www.sloyd.ai/free-3d-models/model/a-sleek-edgy-sneaker-with-angular-shapes-neon-colors-oyqsgfgl',
    },
  },
  'court-high': {
    id: 'court-high',
    name: 'KC—02 Monolith',
    available: true,
    status: 'AVAILABLE',
    tagline: 'High-top',
    blurb: 'A moulded high-top with a wrapped shell, a glossy shroud and a full-length cushioned sole unit.',
    price: 5299,
    glb: 'assets/models/court-high.glb',
    glbLod: 'assets/models/court-high-lod.glb',
    masks: ['assets/models/court-high.mask0.webp', 'assets/models/court-high.mask1.webp', 'assets/models/court-high.mask2.webp'],
    partsJson: 'assets/models/court-high.parts.json',
    originalRough: 0.3,
    parts: ['upper', 'panels', 'trim', 'laces', 'tongue', 'heel', 'midsole', 'outsole'],
    partLabels: { panels: 'Shell', trim: 'Shroud' },
    credit: {
      title: 'Sneaker',
      author: 'ShaderSculptor, generated with Sloyd',
      licence: 'CC BY 4.0',
      url: 'https://www.sloyd.ai/free-3d-models/model/sneaker-bsvvqs9l',
    },
  },
  'knit-runner': {
    id: 'knit-runner',
    name: 'KC—03 Drift',
    available: true,
    status: 'AVAILABLE',
    tagline: 'Knit runner',
    blurb: 'An everyday knit runner on a soft foam midsole, with real laces, a woven upper and a lining you can colour too.',
    price: 4899,
    glb: 'assets/models/knit-runner.glb',
    glbLod: 'assets/models/knit-runner-lod.glb',
    masks: ['assets/models/knit-runner.mask0.webp', 'assets/models/knit-runner.mask1.webp', 'assets/models/knit-runner.mask2.webp'],
    partsJson: 'assets/models/knit-runner.parts.json',
    originalRough: 0.6,
    // this one ships a normal map and a packed occlusion/roughness/metalness map
    roughRef: 0.7,
    normalScale: 1.0,
    yaw: Math.PI,            // authored toe-forward the other way round
    parts: ['upper', 'panels', 'laces', 'tongue', 'detail', 'trim', 'heel', 'midsole', 'outsole'],
    partLabels: { panels: 'Side stripes', detail: 'Lining', trim: 'Pull loops', heel: 'Heel patch' },
    credit: {
      title: 'Materials Variants Shoe',
      author: 'Shopify',
      licence: 'CC BY 4.0',
      url: 'https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/MaterialsVariantsShoe',
    },
  },
};

export const PART_LABELS = {
  upper: 'Upper',
  panels: 'Side panel',
  trim: 'Trim',
  detail: 'Accent',
  laces: 'Laces',
  tongue: 'Tongue',
  heel: 'Heel',
  midsole: 'Midsole',
  outsole: 'Outsole',
};

export function partLabel(productId, key) {
  return PRODUCTS[productId]?.partLabels?.[key] || PART_LABELS[key] || key;
}

/** Curated palette: premium, mostly desaturated, with a few saturated statement colours. */
export const PALETTE = [
  { hex: '#F4F2ED', name: 'Bone' },
  { hex: '#D9D4CA', name: 'Sandstone' },
  { hex: '#A8A29A', name: 'Concrete' },
  { hex: '#55585C', name: 'Graphite' },
  { hex: '#15161A', name: 'Carbon' },
  { hex: '#2E4C3E', name: 'Pine' },
  { hex: '#1F3C6E', name: 'Ink blue' },
  { hex: '#6D2230', name: 'Oxblood' },
  { hex: '#C2452D', name: 'Clay' },
  { hex: '#D8C27A', name: 'Brass' },
  { hex: '#8E7BC4', name: 'Iris' },
];

export const FINISH_LIST = [
  { key: 'original', label: 'Original', note: 'As designed' },
  { key: 'matte', label: 'Matte', note: 'Flat, soft' },
  { key: 'gloss', label: 'Gloss', note: 'Clear-coated' },
  { key: 'leather', label: 'Leather', note: 'Pebbled grain' },
  { key: 'suede', label: 'Suede', note: 'Brushed nap' },
  { key: 'gum', label: 'Gum', note: 'Rubber' },
];

export const SIZES = ['UK 5', 'UK 6', 'UK 7', 'UK 8', 'UK 9', 'UK 10', 'UK 11', 'UK 12'];

export const PRICING = {
  finishDelta: { original: 0, matte: 0, gloss: 150, leather: 350, suede: 300, gum: 150 },
  colorDelta: 60,          // per recoloured part
  textDelta: 199,
  artworkDelta: 299,
  shipping: 99,
  freeShippingOver: 6000,
  coupons: { KICK10: 0.1, CANVAS15: 0.15 },
};


/** Availability. Everything that could take money checks this, not a label. */
export const AVAILABILITY = {
  // set only when an administrator switches a product off in the admin panel
  UNAVAILABLE: { label: 'Not available right now', badge: null },
  AVAILABLE: { label: null, badge: null },
};

export function isPurchasable(product) {
  return !!product && product.available === true;
}

/** True when nothing in the catalogue can be bought — the pre-launch state. */
export function isPreLaunch() {
  return !Object.values(PRODUCTS).some(isPurchasable);
}

export function statusOf(product) {
  return AVAILABILITY[product?.status] || AVAILABILITY.AVAILABLE;
}
