/**
 * Projected decals (text + artwork) for the sneaker surface.
 *
 * Each decal is a texture projected along the surface normal at a placement point, evaluated per
 * fragment in object space inside the sneaker's material (see partMaterial.js). That means the
 * print follows the real 3D surface, is lit like the rest of the shoe, never z-fights, and can be
 * moved / scaled / rotated by changing a matrix - no geometry is rebuilt.
 */
import * as THREE from 'three';
import { MAX_DECALS } from './partMaterial.js';

const TEX_SIZE = 1024;

/** Draw text into a transparent canvas (premultiplied-alpha texture). */
export function renderTextCanvas({ text, font = 'Manrope KC', color = '#111111', weight = 800 }) {
  const canvas = document.createElement('canvas');
  const pad = 56;
  const ctx = canvas.getContext('2d');
  let size = 220;
  const fontStr = (s) => `${weight} ${s}px "${font}", "Helvetica Neue", Arial, sans-serif`;
  ctx.font = fontStr(size);
  let w = ctx.measureText(text).width;
  // fit within the texture width, keep it a wide strip
  if (w > TEX_SIZE - pad * 2) { size = Math.floor(size * (TEX_SIZE - pad * 2) / w); ctx.font = fontStr(size); w = ctx.measureText(text).width; }
  canvas.width = TEX_SIZE;
  canvas.height = Math.round(size * 1.5) + pad;
  const c2 = canvas.getContext('2d');
  c2.font = fontStr(size);
  c2.textAlign = 'center';
  c2.textBaseline = 'middle';
  c2.fillStyle = color;
  c2.fillText(text, canvas.width / 2, canvas.height / 2 + size * 0.04);
  return { canvas, aspect: canvas.width / canvas.height };
}

/** Fit an uploaded image into a padded transparent canvas (downscaled for memory + storage). */
export function renderImageCanvas(img, maxSide = 1024) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const s = Math.min(1, maxSide / Math.max(iw, ih));
  const w = Math.max(2, Math.round(iw * s)), h = Math.max(2, Math.round(ih * s));
  const pad = 12;
  const canvas = document.createElement('canvas');
  canvas.width = w + pad * 2; canvas.height = h + pad * 2;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, pad, pad, w, h);
  return { canvas, aspect: canvas.width / canvas.height };
}

export class DecalManager {
  /**
   * @param {object} opts { getMaxAnisotropy:()=>number, onChange:()=>void }
   */
  constructor({ maxAnisotropy = 4, onChange = () => {} } = {}) {
    this.maxAnisotropy = maxAnisotropy;
    this.onChange = onChange;
    this.items = [];           // {id, texture, aspect, pos:Vector3, normal:Vector3, size, rot, opacity, flipU?}
    this.blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    this.blank.needsUpdate = true;
    this.mirror = false;
    this._inv = Array.from({ length: MAX_DECALS }, () => new THREE.Matrix4());
  }

  get full() { return this.items.length >= MAX_DECALS; }
  get(id) { return this.items.find((d) => d.id === id) || null; }

  /** Create/replace the texture for a decal from a canvas. */
  _makeTexture(canvas, old) {
    if (old) old.dispose();
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.premultiplyAlpha = true;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.anisotropy = this.maxAnisotropy;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  }

  add({ id, canvas, aspect, pos, normal, size = 0.16, rot = 0, opacity = 1 }) {
    if (this.full) return null;
    const rec = {
      id, aspect, size, rot, opacity,
      pos: new THREE.Vector3().fromArray(pos),
      normal: new THREE.Vector3().fromArray(normal).normalize(),
      texture: this._makeTexture(canvas, null),
    };
    this.items.push(rec);
    this.onChange();
    return rec;
  }

  updateTexture(id, canvas, aspect) {
    const d = this.get(id); if (!d) return;
    d.texture = this._makeTexture(canvas, d.texture);
    d.aspect = aspect;
    this.onChange();
  }

  update(id, patch) {
    const d = this.get(id); if (!d) return;
    if (patch.pos) d.pos.fromArray(patch.pos);
    if (patch.normal) d.normal.fromArray(patch.normal).normalize();
    if (patch.size != null) d.size = patch.size;
    if (patch.rot != null) d.rot = patch.rot;
    if (patch.opacity != null) d.opacity = patch.opacity;
    this.onChange();
  }

  remove(id) {
    const i = this.items.findIndex((d) => d.id === id);
    if (i < 0) return;
    this.items[i].texture.dispose();
    this.items.splice(i, 1);
    this.onChange();
  }

  clear() {
    this.items.forEach((d) => d.texture.dispose());
    this.items.length = 0;
    this.onChange();
  }

  /**
   * Basis of a decal in object space.
   * Text stays upright on the shoe: "up" follows world +Y projected onto the tangent plane.
   */
  basis(d) {
    const n = d.normal;
    let up = new THREE.Vector3(0, 1, 0);
    if (Math.abs(n.dot(up)) > 0.92) up = new THREE.Vector3(-1, 0, 0); // top/bottom: toe points "up"
    const R = new THREE.Vector3().crossVectors(up, n).normalize();
    const U = new THREE.Vector3().crossVectors(n, R).normalize();
    const c = Math.cos(d.rot), s = Math.sin(d.rot);
    const R2 = R.clone().multiplyScalar(c).addScaledVector(U, s);
    const U2 = U.clone().multiplyScalar(c).addScaledVector(R, -s);
    return { R: R2, U: U2, N: n };
  }

  /** objectScale = object-space units per "shoe length" (size is stored as a fraction of length) */
  matrixFor(d, objectScale, out = new THREE.Matrix4()) {
    const { R, U, N } = this.basis(d);
    const w = d.size * objectScale;             // decal width in object units
    const h = w / d.aspect;
    const depth = Math.max(w, h) * 0.55;        // projection reaches this far either side of the tangent plane
    const p = d.pos;
    out.set(
      R.x / w, R.y / w, R.z / w, -R.dot(p) / w,
      U.x / h, U.y / h, U.z / h, -U.dot(p) / h,
      N.x / depth, N.y / depth, N.z / depth, -N.dot(p) / depth,
      0, 0, 0, 1
    );
    return out;
  }

  /** Is object-space point `p` inside decal `d`'s footprint? (used for drag-to-move picking) */
  contains(d, p, objectScale) {
    const m = this.matrixFor(d, objectScale, new THREE.Matrix4());
    const q = p.clone().applyMatrix4(m);
    return Math.abs(q.x) <= 0.5 && Math.abs(q.y) <= 0.5 && Math.abs(q.z) <= 1;
  }

  /** Write all decal uniforms into the part material. */
  syncUniforms(material, objectScale) {
    const u = material.userData.kc;
    for (let i = 0; i < MAX_DECALS; i++) {
      const d = this.items[i];
      const key = 'uDecalTex' + i;
      if (d) {
        this.matrixFor(d, objectScale, u.uDecalInv.value[i]);
        u[key].value = d.texture;
        u.uDecalParams.value[i].set(1, this.mirror ? 1 : 0, d.opacity, 0);
      } else {
        u[key].value = this.blank;
        u.uDecalParams.value[i].set(0, 0, 1, 0);
      }
    }
  }

  dispose() { this.clear(); this.blank.dispose(); }
}
