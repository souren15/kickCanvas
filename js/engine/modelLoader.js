/**
 * Loads a sneaker's GLB, its three part-mask textures and its parts.json.
 * Results are cached per (product, lod) and shared between viewers.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PART_SLOTS } from './partMaterial.js';

const gltfLoader = new GLTFLoader();
const cache = new Map();

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load ' + url));
    img.src = url;
  });
}

function makeMaskTexture(img) {
  const t = new THREE.Texture(img);
  t.flipY = false;                       // glTF UV convention (matches the baked colour texture)
  t.colorSpace = THREE.NoColorSpace;     // weights are data, not colours
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

/** CPU copy of the masks so a tap on the shoe can be mapped to a part without a GPU read-back. */
function readMaskPixels(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return { w: c.width, h: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data };
}

/**
 * @returns {Promise<{geometry, map, masks, maskPixels, partRef, product, lod}>}
 */
export function loadSneakerAssets(product, { lod = false, onProgress } = {}) {
  const key = product.id + (lod ? ':lod' : '');
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    const glbUrl = lod && product.glbLod ? product.glbLod : product.glb;
    const progress = { glb: 0, masks: 0 };
    const report = () => onProgress && onProgress((progress.glb * 0.8 + progress.masks * 0.2));

    const gltfP = new Promise((resolve, reject) => {
      gltfLoader.load(glbUrl, resolve, (e) => {
        if (e.lengthComputable) { progress.glb = e.loaded / e.total; report(); }
      }, reject);
    });
    const imgsP = Promise.all(product.masks.map(loadImage)).then((imgs) => { progress.masks = 1; report(); return imgs; });
    const infoP = fetch(product.partsJson).then((r) => { if (!r.ok) throw new Error('parts.json ' + r.status); return r.json(); });
    const [gltf, imgs, info] = await Promise.all([gltfP, imgsP, infoP]);

    let mesh = null;
    gltf.scene.traverse((o) => { if (!mesh && o.isMesh) mesh = o; });
    if (!mesh) throw new Error('No mesh found in ' + glbUrl);

    const src = mesh.material;
    const map = src.map;
    if (!map) throw new Error('Model has no baked texture');
    map.colorSpace = THREE.SRGBColorSpace;
    // glTF packs occlusion/roughness/metalness into one texture; GLTFLoader hands it to us
    // three times over, so one of them is enough to carry all three channels.
    const normalMap = src.normalMap || null;
    const ormMap = src.roughnessMap || src.metalnessMap || src.aoMap || null;

    const geometry = mesh.geometry;
    // models are authored toe-forward in different directions; normalise once, into the cached
    // geometry, so every camera preset and decal anchor downstream can assume one convention
    if (product.yaw) geometry.rotateY(product.yaw);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    if (!geometry.attributes.normal) geometry.computeVertexNormals();

    const partRef = {};
    for (const k of PART_SLOTS) partRef[k] = info.parts?.[k]?.meanLum || 0.2;

    return {
      geometry, map, normalMap, ormMap,
      masks: imgs.map(makeMaskTexture),
      maskPixels: imgs.map(readMaskPixels),
      partRef, partArea: Object.fromEntries(PART_SLOTS.map((k) => [k, info.parts?.[k]?.area || 0])),
      product, lod,
    };
  })();
  cache.set(key, p);
  p.catch(() => cache.delete(key)); // allow retry after a failure
  return p;
}

/** Which part is under this UV? Mirrors the shader's mask sharpening so picking == what you see. */
export function partAtUV(assets, uv, edge = [0.18, 0.82]) {
  const { maskPixels } = assets;
  const w = new Array(PART_SLOTS.length).fill(0);
  const m = maskPixels[0];
  const x = Math.min(m.w - 1, Math.max(0, Math.floor(uv.x * m.w)));
  const y = Math.min(m.h - 1, Math.max(0, Math.floor(uv.y * m.h)));
  const i = (y * m.w + x) * 4;
  const ss = (v) => { const t = Math.min(1, Math.max(0, (v - edge[0]) / (edge[1] - edge[0]))); return t * t * (3 - 2 * t); };
  const read = (mi, c) => ss(maskPixels[mi].data[i + c] / 255);
  w[0] = read(0, 0); w[1] = read(0, 1); w[2] = read(0, 2);
  w[3] = read(1, 0); w[4] = read(1, 1); w[5] = read(1, 2);
  w[6] = read(2, 0); w[7] = read(2, 1);
  let sum = 0; for (let k = 0; k < 8; k++) sum += w[k];
  if (sum > 1) { for (let k = 0; k < 8; k++) w[k] /= sum; sum = 1; }
  w[8] = 1 - sum;
  let best = 8;
  for (let k = 0; k < 9; k++) if (w[k] > w[best]) best = k;
  return PART_SLOTS[best];
}
