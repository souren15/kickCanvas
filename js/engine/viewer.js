/**
 * KickCanvas 3D engine.
 *
 * One SneakerViewer owns one WebGL context. Its canvas is re-parented between the homepage hero and the
 * customizer, so the sneaker you see on the homepage is the same one you start designing.
 *
 * Public API (methods): setupScene, setupLights, setupControls, loadModel, switchModel, rotateModel,
 * resetCamera, setView, selectMesh, pickPart, applyDesign, applyColor, applyMaterial,
 * addTextDecal, addImageDecal, removeDecal, capturePreview, setActive, dispose.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createPartMaterial, setPartFinish, PART_SLOTS, PART_INDEX, FINISHES } from './partMaterial.js';
import { loadSneakerAssets, partAtUV } from './modelLoader.js';
import { DecalManager, renderTextCanvas, renderImageCanvas } from './decals.js';

const DEG = Math.PI / 180;
const STUDIO_BG = ['#FBFBFA', '#F5F5F3', '#EBEAE6'];

export function detectQuality() {
  const ua = navigator.userAgent || '';
  const mobile = /iPhone|iPad|iPod|Android/i.test(ua) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));
  const lowMem = navigator.deviceMemory && navigator.deviceMemory <= 4;
  const lowCpu = navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4;
  const low = !!(lowMem || (lowCpu && mobile));
  return {
    mobile, low,
    dpr: low ? 1.5 : mobile ? 2 : 2,
    shadowMap: low ? 512 : mobile ? 1024 : 2048,
    aniso: low ? 2 : mobile ? 4 : 8,
  };
}

/** Camera presets in spherical terms. theta: azimuth from +Z toward +X. phi: polar angle from +Y. */
const VIEWS = {
  default: { theta: -34 * DEG, phi: 77 * DEG, zoom: 1.0 },
  side:    { theta: 0,         phi: 86 * DEG, zoom: 1.0 },
  front:   { theta: -90 * DEG, phi: 80 * DEG, zoom: 1.0 },
  back:    { theta: 90 * DEG,  phi: 80 * DEG, zoom: 1.0 },
  top:     { theta: 0,         phi: 14 * DEG, zoom: 1.0 },
  sole:    { theta: 0,         phi: 160 * DEG, zoom: 1.0 },
};

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

let uid = 0;
export const newId = (p = 'd') => `${p}${Date.now().toString(36)}${(uid++).toString(36)}`;

export class SneakerViewer {
  constructor(products) {
    this.products = products;               // { id: product }
    this.q = detectQuality();
    this.records = new Map();               // id -> model record
    this.current = null;
    this.design = null;
    this.mode = 'hero';
    this.container = null;
    this.selected = null;                   // part key or null
    this.highlight = true;
    this.listeners = {};
    this._raf = 0; this._last = 0; this._idle = 0; this._needs = true; this._active = true;
    this._onscreen = true;                  // false while the mounted container is scrolled out of view
    this._camTween = null; this._intro = null; this._fade = null;
    this._userMoved = false; this.baseDistance = 2.6; this.targetY = 0.25;
    this._switching = Promise.resolve();
    this._decalVersion = 0;
    this.imageCache = new Map();
    this._tg = null;                        // smoothing targets for the current material
    this.ready = false;
    this.failed = false;

    try {
      this.setupScene();
      this.setupLights();
      this.setupControls();
      this._bindPointer();
      this._bindContext();
    } catch (err) {
      console.error('WebGL setup failed', err);
      this.failed = true;
    }
  }

  /* ------------------------------------------------------------------ events */
  on(evt, fn) { (this.listeners[evt] ||= []).push(fn); return () => this.off(evt, fn); }
  off(evt, fn) { this.listeners[evt] = (this.listeners[evt] || []).filter((f) => f !== fn); }
  emit(evt, detail) { (this.listeners[evt] || []).forEach((f) => { try { f(detail); } catch (e) { console.error(e); } }); }

  /* ------------------------------------------------------------------ scene */
  setupScene() {
    const q = this.q;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.dpr));
    renderer.toneMapping = THREE.NeutralToneMapping;   // Khronos PBR Neutral: faithful product colours
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;   // PCFSoft was removed in r186
    this.renderer = renderer;
    this.canvas = renderer.domElement;
    this.canvas.classList.add('kc-canvas');
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Interactive 3D sneaker. Drag to rotate, scroll or pinch to zoom, tap a part to select it.');

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(27, 1.4, 0.05, 40);
    this.camera.position.set(0, 0.5, 2.6);

    // image-based lighting from a procedural studio (no external HDR download)
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
    this.scene.environment = this.envTex;
    this.scene.environmentIntensity = 0.9;
    pmrem.dispose();

    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);

    // floor: real shadow catcher + soft contact blob
    this.floor = new THREE.Group();
    const shadowMat = new THREE.ShadowMaterial({ opacity: 0.2 });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), shadowMat);
    plane.rotation.x = -Math.PI / 2;
    plane.receiveShadow = true;
    this.floor.add(plane);
    this.shadowMat = shadowMat;

    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grd.addColorStop(0, 'rgba(0,0,0,0.85)');
    grd.addColorStop(0.35, 'rgba(0,0,0,0.5)');
    grd.addColorStop(0.7, 'rgba(0,0,0,0.12)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
    const blobTex = new THREE.CanvasTexture(c);
    blobTex.colorSpace = THREE.SRGBColorSpace;
    this.blobMat = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: 0.5, toneMapped: false });
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.blobMat);
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.position.y = 0.0006;
    this.blob.renderOrder = -1;
    this.floor.add(this.blob);
    this.scene.add(this.floor);

    this.raycaster = new THREE.Raycaster();
    this.decals = new DecalManager({
      maxAnisotropy: q.aniso,
      onChange: () => { this._decalDirty = true; this.invalidate(); },
    });
  }

  setupLights() {
    const q = this.q;
    // key light: fixed in the world, the only shadow caster (soft contact shadow under the shoe)
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(1.3, 2.8, 1.6);
    key.castShadow = true;
    key.shadow.mapSize.set(q.shadowMap, q.shadowMap);
    const sc = key.shadow.camera;
    sc.left = -1.1; sc.right = 1.1; sc.top = 1.1; sc.bottom = -1.1; sc.near = 0.5; sc.far = 7;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.012;
    key.shadow.radius = 6;
    this.scene.add(key);
    this.keyLight = key;

    // fill + rim follow the camera's azimuth so every angle is lit like a studio shot
    this.rig = new THREE.Group();
    const fill = new THREE.DirectionalLight(0xe6edff, 0.75);
    fill.position.set(-2.2, 1.2, 1.8);
    const rim = new THREE.DirectionalLight(0xffffff, 1.0);
    rim.position.set(-1.6, 1.8, -2.4);
    const front = new THREE.DirectionalLight(0xffffff, 0.55);
    front.position.set(0.4, 0.8, 3.0);
    this.rig.add(fill, rim, front);
    this.scene.add(this.rig);
  }

  setupControls() {
    const c = new OrbitControls(this.camera, this.canvas);
    c.enableDamping = true;
    c.dampingFactor = 0.075;
    c.enablePan = false;
    c.rotateSpeed = this.q.mobile ? 0.9 : 0.8;
    c.zoomSpeed = 0.85;
    c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };
    c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: null };
    c.target.set(0, this.targetY, 0);
    c.autoRotateSpeed = 1.1;
    c.addEventListener('change', () => this.invalidate());
    c.addEventListener('start', () => { this._camTween = null; this._userMoved = true; this._idle = 0; });
    c.addEventListener('end', () => this.invalidate());
    this.controls = c;
  }

  _bindContext() {
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this._lost = true; });
    this.canvas.addEventListener('webglcontextrestored', () => { this._lost = false; this._needs = true; this.invalidate(); });
  }

  /* ------------------------------------------------------------------ mounting / sizing */
  mount(container, mode = 'hero') {
    if (this.failed) return;
    const changed = this.container !== container || this.mode !== mode;
    this.container = container;
    this.mode = mode;
    if (this.canvas.parentElement !== container) container.prepend(this.canvas);
    if (this._ro) this._ro.disconnect();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(container);
    // An auto-rotating viewer re-renders every frame (shadow pass included). Stop entirely while its
    // container is off-screen so scrolling the rest of the page doesn't compete with the GPU.
    if (this._io) this._io.disconnect();
    if ('IntersectionObserver' in window) {
      this._io = new IntersectionObserver((en) => {
        const vis = en[en.length - 1].isIntersecting;
        if (vis === this._onscreen) return;
        this._onscreen = vis;
        if (vis) this.invalidate();
        else if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
      }, { rootMargin: '80px 0px' });
      this._onscreen = true;
      this._io.observe(container);
    }
    // phones: the auto-rotating hero/section views render at 1.5x; the configurator keeps full density
    const pr = Math.min(window.devicePixelRatio || 1, mode === 'hero' && this.q.mobile ? Math.min(1.5, this.q.dpr) : this.q.dpr);
    if (this.renderer.getPixelRatio() !== pr) this.renderer.setPixelRatio(pr);

    const c = this.controls;
    if (mode === 'hero') {
      c.enableZoom = false;
      c.minPolarAngle = 62 * DEG; c.maxPolarAngle = 98 * DEG;
      this.canvas.style.touchAction = 'pan-y';           // vertical swipes still scroll the page
      c.autoRotate = true; c.autoRotateSpeed = 1.0;
    } else {
      c.enableZoom = true;
      c.minPolarAngle = 0.04; c.maxPolarAngle = 172 * DEG;
      this.canvas.style.touchAction = 'none';            // the viewer owns touch gestures
      c.autoRotate = false;
    }
    this.resize();
    if (changed) this.resetCamera(false);
    this.invalidate();
  }

  resize() {
    if (!this.container) return;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._computeBaseDistance();
    if (!this._userMoved && !this._camTween) this.setView('default', false);
    this.invalidate();
  }

  _computeBaseDistance() {
    const cam = this.camera;
    const r = (this.current?.radius ?? 0.62) * 0.94;
    const vf = cam.fov * DEG;
    const hf = 2 * Math.atan(Math.tan(vf / 2) * cam.aspect);
    const f = Math.min(vf, hf);
    this.baseDistance = r / Math.sin(f / 2);
    this.controls.minDistance = this.baseDistance * 0.32;
    this.controls.maxDistance = this.baseDistance * 1.7;
  }

  /* ------------------------------------------------------------------ loading */
  /** Load (or fetch from cache) a model record. Does not display it. */
  async loadModel(id, { onProgress } = {}) {
    if (this.records.has(id)) return this.records.get(id);
    const product = this.products[id];
    if (!product) throw new Error('Unknown model ' + id);
    // low-end and small-memory devices get the 1024px-texture build (roughly 40% of the bytes)
    const assets = await loadSneakerAssets(product, { onProgress, lod: this.q.low });
    if (this.records.has(id)) return this.records.get(id);
    const rec = this._buildRecord(id, product, assets);
    this.records.set(id, rec);
    return rec;
  }

  _buildRecord(id, product, assets) {
    assets.map.anisotropy = this.q.aniso;
    const material = createPartMaterial({
      map: assets.map, masks: assets.masks, partRef: assets.partRef,
      defaultRough: product.originalRough ?? 0.55,
      normalMap: assets.normalMap, ormMap: assets.ormMap, roughRef: product.roughRef ?? 0.7,
    });
    if (assets.normalMap && product.normalScale) material.normalScale.setScalar(product.normalScale);
    const mesh = new THREE.Mesh(assets.geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.name = product.name;
    const bb = assets.geometry.boundingBox;
    const size = bb.getSize(new THREE.Vector3());
    const scale = 1 / size.x;                           // normalise: shoe length = 1 unit
    mesh.position.set(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
    const root = new THREE.Group();
    root.add(mesh);
    root.scale.setScalar(scale);
    root.updateMatrixWorld(true);
    const rec = {
      id, product, assets, material, mesh, root,
      hasOrm: !!assets.ormMap,
      scale, objLength: size.x,
      height: size.y * scale, width: size.z * scale,
      radius: Math.hypot(0.5, size.y * scale / 2, size.z * scale / 2) * 1.02,
    };
    // Default decal placements cost ~300 brute-force raycasts against the full mesh, which blocked
    // the main thread for 0.3-1.4 s per model on a desktop CPU (several seconds on a phone) every
    // time a silhouette was first shown. Only decals need them, so compute on first use.
    let anchors = null;
    Object.defineProperty(rec, 'anchors', { get: () => (anchors ||= this._computeAnchors(rec)), enumerable: true });
    this._initTargets(rec);
    return rec;
  }

  /**
   * Default decal placements, found by actually shooting rays at the mesh.
   * For each anchor a small grid of rays is cast and the hit is scored on how flat and how
   * well-aligned to the intended facing it is, so a print never lands on a crease or an
   * inward-curling lip (which would skew the text).
   */
  _computeAnchors(rec) {
    const ray = new THREE.Raycaster();
    const h = rec.height, w = rec.width, s = rec.scale;
    const zones = {
      // dir = outward facing we want; u/v sweep across the search window (object-normalised units)
      side:   { dir: [0, 0, 1],  from: [0.06, h * 0.46, 2],  u: [1, 0, 0], v: [0, 1, 0], span: [0.30, h * 0.26] },
      medial: { dir: [0, 0, -1], from: [0.06, h * 0.46, -2], u: [1, 0, 0], v: [0, 1, 0], span: [0.30, h * 0.26] },
      heel:   { dir: [1, 0, 0],  from: [2, h * 0.52, 0],     u: [0, 0, 1], v: [0, 1, 0], span: [w * 0.5, h * 0.2] },
      toe:    { dir: [-1, 0, 0], from: [-2, h * 0.34, 0],    u: [0, 0, 1], v: [0, 1, 0], span: [w * 0.5, h * 0.16] },
    };
    const out = {};
    const invS = 1 / s;
    for (const [key, z] of Object.entries(zones)) {
      const dir = new THREE.Vector3(...z.dir);
      const from = new THREE.Vector3(...z.from);
      const uAx = new THREE.Vector3(...z.u), vAx = new THREE.Vector3(...z.v);
      let best = null;
      for (let iu = -2; iu <= 2; iu++) {
        for (let iv = -1; iv <= 1; iv++) {
          const o = from.clone()
            .addScaledVector(uAx, (iu / 2) * z.span[0] * 0.5)
            .addScaledVector(vAx, (iv / 2) * z.span[1] * 0.5);
          ray.set(o, dir.clone().negate());
          const hit = ray.intersectObject(rec.mesh, false)[0];
          if (!hit) continue;
          const pl = this._hitToObject(rec, hit);
          const n = new THREE.Vector3(...pl.normal);
          const align = n.dot(dir);                       // 1 = facing us straight on
          if (align < 0.55) continue;
          // flatness: compare the face normal with neighbours a few mm away
          let flat = 1;
          for (const off of [[0.012, 0], [-0.012, 0], [0, 0.012], [0, -0.012]]) {
            const o2 = o.clone().addScaledVector(uAx, off[0]).addScaledVector(vAx, off[1]);
            ray.set(o2, dir.clone().negate());
            const h2 = ray.intersectObject(rec.mesh, false)[0];
            if (!h2) { flat -= 0.25; continue; }
            const n2 = new THREE.Vector3(...this._hitToObject(rec, h2).normal);
            flat -= Math.max(0, 1 - n2.dot(n)) * 0.6;
          }
          const centred = 1 - Math.abs(iu) * 0.07 - Math.abs(iv) * 0.12;
          const score = align * 1.4 + flat * 1.0 + centred;
          if (!best || score > best.score) best = { score, pl };
        }
      }
      if (best) out[key] = best.pl;
    }
    if (!out.side) out.side = { pos: [0, (h * 0.45) * invS, (w * 0.5) * invS], normal: [0, 0, 1] };
    return out;
  }

  /** Convert a raycast hit to object-space placement {pos, normal, uv}. */
  _hitToObject(rec, hit) {
    const mesh = rec.mesh;
    const pos = mesh.worldToLocal(hit.point.clone());
    const g = mesh.geometry, n = g.attributes.normal;
    const f = hit.face;
    const a = new THREE.Vector3().fromBufferAttribute(g.attributes.position, f.a);
    const b = new THREE.Vector3().fromBufferAttribute(g.attributes.position, f.b);
    const c = new THREE.Vector3().fromBufferAttribute(g.attributes.position, f.c);
    const bc = new THREE.Vector3();
    THREE.Triangle.getBarycoord(pos, a, b, c, bc);
    const na = new THREE.Vector3().fromBufferAttribute(n, f.a), nb = new THREE.Vector3().fromBufferAttribute(n, f.b), nc = new THREE.Vector3().fromBufferAttribute(n, f.c);
    const normal = na.multiplyScalar(bc.x).addScaledVector(nb, bc.y).addScaledVector(nc, bc.z).normalize();
    return { pos: pos.toArray(), normal: normal.toArray(), uv: hit.uv ? { x: hit.uv.x, y: hit.uv.y } : null };
  }

  /* ------------------------------------------------------------------ smoothing targets */
  _initTargets(rec) {
    const n = PART_SLOTS.length;
    rec.tg = {
      color: Array.from({ length: n }, () => new THREE.Color(1, 1, 1)),
      tint: new Array(n).fill(0),
      finish: Array.from({ length: n }, () => new THREE.Vector4(rec.product.originalRough ?? 0.55, 0, 0.5, 0)),
      grainAmt: new Array(n).fill(0),
    };
    for (let i = 0; i < n; i++) setPartFinish(rec.material, i, 'original', rec.product.originalRough ?? 0.55);
  }

  /* ------------------------------------------------------------------ display / switching */
  /** Show a model. First call shows it with the intro animation; later calls cross-fade. */
  switchModel(id, design = this.design, { onProgress } = {}) {
    this._wantId = id;
    this._switching = this._switching.then(() => (this._wantId === id ? this._switchModel(id, design, onProgress) : null)).catch((e) => { console.error(e); this.emit('error', e); });
    return this._switching;
  }

  async _switchModel(id, design, onProgress) {
    if (this.failed) return;
    const rec = await this.loadModel(id, { onProgress });
    if (this._wantId !== id) return;          // a newer choice arrived while this one downloaded
    if (this.current === rec) { if (design) this.applyDesign(design, { instant: true }); return; }
    const prev = this.current;
    if (prev) await this._fadeOut(prev);
    // swap
    this.modelGroup.clear();
    this.current = rec;
    this.modelGroup.add(rec.root);
    this.blob.scale.set(rec.objLength * rec.scale * 1.18, rec.width * 1.3, 1);
    this._computeBaseDistance();
    this.targetY = rec.height * 0.46;
    if (!this._userMoved) { this.controls.target.set(0, this.targetY, 0); }
    if (design) this.applyDesign(design, { instant: true });
    this._warm(rec);
    this._fadeIn(rec, !prev);
    this.ready = true;
    this.emit('modelchange', { id, record: rec });
    this.emit('ready', { id });
    this.invalidate();
  }

  /** Pre-compile the transparent shader variant so the first cross-fade doesn't hitch. */
  _warm(rec) {
    if (rec._warmed) return;
    rec._warmed = true;
    const m = rec.material;
    try {
      m.transparent = true; m.opacity = 0.99;
      (this.renderer.compileAsync ? this.renderer.compileAsync(this.scene, this.camera) : Promise.resolve(this.renderer.compile(this.scene, this.camera)))
        .catch(() => {}).finally(() => { m.transparent = false; m.opacity = 1; });
    } catch (e) { m.transparent = false; m.opacity = 1; }
  }

  _fadeOut(rec) {
    return new Promise((resolve) => {
      rec.material.transparent = true;
      this._fade = { rec, t0: performance.now(), dur: 200, dir: -1, done: resolve };
      this.invalidate();
    });
  }
  _fadeIn(rec, intro) {
    rec.material.transparent = true;
    this._fade = { rec, t0: performance.now(), dur: intro ? 900 : 380, dir: 1, intro, done: () => { rec.material.transparent = false; rec.material.opacity = 1; } };
    this.invalidate();
  }

  /* ------------------------------------------------------------------ appearance */
  /**
   * Apply a whole design { parts:{key:{color}}, finish, decals:[...], mirror }.
   * `finish` is a single whole-sneaker setting: it drives the roughness / clear-coat / sheen /
   * grain uniforms of EVERY part slot, while each slot keeps its own colour and the model's own
   * texture, normal map and baked detail. Only uniforms change - no model reload, no new material.
   */
  applyDesign(design, { instant = false } = {}) {
    this.design = design;
    const rec = this.current;
    if (!rec || !design) return;
    const finish = design.finish || 'original';
    for (const key of PART_SLOTS) {
      const p = design.parts?.[key] || {};
      this._setPart(rec, key, p.color || null, finish, instant);
    }
    this.modelGroup.scale.z = design.mirror ? -1 : 1;
    this.decals.mirror = !!design.mirror;
    this._syncDecals(design.decals || []);
    this.invalidate();
  }

  applyColor(part, hex, { instant = false } = {}) {
    const rec = this.current; if (!rec) return;
    this._setPart(rec, part, hex || null, this.design?.finish || 'original', instant);
    this.invalidate();
  }

  /** Set the whole-sneaker finish. (`part` is accepted for older callers and ignored.) */
  applyMaterial(part, finish, { instant = false } = {}) {
    const rec = this.current; if (!rec) return;
    if (this.design) this.design = { ...this.design, finish };
    for (const key of PART_SLOTS) this._setPart(rec, key, this.design?.parts?.[key]?.color || null, finish, instant);
    this.invalidate();
  }

  _setPart(rec, key, hex, finish, instant) {
    const i = PART_INDEX[key]; if (i == null) return;
    const u = rec.material.userData.kc, tg = rec.tg;
    const wasTinted = u.uPartTint.value[i] > 0.01 || tg.tint[i] > 0.5;
    if (hex) {
      tg.color[i].set(hex);
      if (!wasTinted) u.uPartColor.value[i].copy(tg.color[i]);   // no hue sweep out of "original"
      tg.tint[i] = 1;
    } else tg.tint[i] = 0;
    const f = finish === 'original' || !FINISHES[finish]
      ? { rough: rec.product.originalRough ?? 0.55, clear: 0, clearRough: 0.5, sheen: 0, grain: [0, 0] }
      : FINISHES[finish];
    tg.finish[i].set(f.rough, f.clear, f.clearRough, f.sheen);
    tg.grainAmt[i] = f.grain[1];
    // on a model that ships an ORM map, "original" means "use the map's own roughness"
    u.uPartMapMix.value[i] = rec.hasOrm && (finish === 'original' || !FINISHES[finish]) ? 1 : 0;
    u.uPartGrain.value[i].x = f.grain[0];            // type switches immediately, amount eases
    if (f.grain[0] === 0 && u.uPartGrain.value[i].y < 0.01) u.uPartGrain.value[i].x = 0;
    if (instant) {
      u.uPartColor.value[i].copy(tg.color[i]);
      u.uPartTint.value[i] = tg.tint[i];
      u.uPartFinish.value[i].copy(tg.finish[i]);
      u.uPartGrain.value[i].set(f.grain[0], f.grain[1]);
    }
  }

  /** Ease current uniforms toward their targets. Returns true while anything is still moving. */
  _smooth(dt) {
    const rec = this.current; if (!rec) return false;
    const u = rec.material.userData.kc, tg = rec.tg;
    const k = 1 - Math.exp(-dt * 13);
    let moving = false;
    for (let i = 0; i < PART_SLOTS.length; i++) {
      const c = u.uPartColor.value[i], t = tg.color[i];
      const dc = Math.abs(c.r - t.r) + Math.abs(c.g - t.g) + Math.abs(c.b - t.b);
      if (dc > 0.002) { c.lerp(t, k); moving = true; } else if (dc > 0) c.copy(t);
      const dT = tg.tint[i] - u.uPartTint.value[i];
      if (Math.abs(dT) > 0.003) { u.uPartTint.value[i] += dT * k; moving = true; } else u.uPartTint.value[i] = tg.tint[i];
      const f = u.uPartFinish.value[i], ft = tg.finish[i];
      const df = Math.abs(f.x - ft.x) + Math.abs(f.y - ft.y) + Math.abs(f.z - ft.z) + Math.abs(f.w - ft.w);
      if (df > 0.003) { f.lerp(ft, k); moving = true; } else f.copy(ft);
      const g = u.uPartGrain.value[i], dg = tg.grainAmt[i] - g.y;
      if (Math.abs(dg) > 0.003) { g.y += dg * k; moving = true; } else { g.y = tg.grainAmt[i]; if (g.y === 0) g.x = 0; }
    }
    const selTarget = this.selected && this.highlight ? 1 : 0;
    const ds = selTarget - u.uSelAmt.value;
    if (Math.abs(ds) > 0.01) { u.uSelAmt.value += ds * (1 - Math.exp(-dt * 10)); moving = true; } else u.uSelAmt.value = selTarget;
    return moving;
  }

  /* ------------------------------------------------------------------ selection / picking */
  _ndc(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }
  _raycast(clientX, clientY) {
    if (!this.current) return null;
    this.raycaster.setFromCamera(this._ndc(clientX, clientY), this.camera);
    this.current.root.updateMatrixWorld(true);
    return this.raycaster.intersectObject(this.current.mesh, false)[0] || null;
  }

  /** Raycast to the shoe and identify the part under the pointer. */
  pickPart(clientX, clientY) {
    const hit = this._raycast(clientX, clientY);
    if (!hit || !hit.uv) return null;
    const part = partAtUV(this.current.assets, hit.uv);
    return { part, hit, placement: this._hitToObject(this.current, hit) };
  }

  /** Select (highlight) a part by key, or null to clear. */
  selectMesh(part, { silent = false } = {}) {
    this.selected = part || null;
    const rec = this.current;
    if (rec) {
      const u = rec.material.userData.kc;
      u.uSel.value = part ? PART_INDEX[part] : -1;
      if (part) u.uSelColor.value.set(this._outlineColorFor(rec, part));
    }
    if (!silent) this.emit('partselect', { part: this.selected });
    this.invalidate();
  }
  setHighlight(on) { this.highlight = !!on; this.invalidate(); }

  /**
   * The outline must stay legible on the part it surrounds, and the brand accent is orange - so on
   * a part that is itself warm (or very light), switch to a cool outline instead.
   */
  _outlineColorFor(rec, part) {
    const i = PART_INDEX[part];
    const u = rec.material.userData.kc;
    const tinted = u.uPartTint.value[i] > 0.5;
    const c = tinted ? u.uPartColor.value[i].clone() : new THREE.Color().setScalar(rec.assets.partRef[part] ?? 0.2);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    const warm = hsl.s > 0.22 && (hsl.h < 0.11 || hsl.h > 0.93);
    return warm ? '#0A84FF' : '#FF4D1F';
  }

  /* ------------------------------------------------------------------ camera */
  _viewTarget(name) {
    const v = VIEWS[name] || VIEWS.default;
    const dist = this.baseDistance * (v.zoom || 1) * (name === 'top' ? 0.98 : name === 'default' ? 1.0 : 0.96);
    return { theta: v.theta, phi: v.phi, r: dist };
  }

  setView(name = 'default', animate = true, duration = 850) {
    const to = this._viewTarget(name);
    const tY = this.targetY;
    this._moveCamera(to, tY, animate, duration);
  }
  resetCamera(animate = true) { this._userMoved = false; this.setView('default', animate, 900); }

  /** Orbit by degrees. Positive = the shoe turns left (same as dragging left). */
  rotateModel(deg, duration = 520) {
    const s = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    this._userMoved = true;
    this._moveCamera({ theta: s.theta + deg * DEG, phi: s.phi, r: s.radius }, this.controls.target.y, true, duration, true);
  }

  _moveCamera(to, targetY, animate, duration, relative = false) {
    const cam = this.camera, ctl = this.controls;
    const s = new THREE.Spherical().setFromVector3(cam.position.clone().sub(ctl.target));
    let t1 = to.theta;
    if (!relative) {            // shortest angular path to the preset
      let d = ((t1 - s.theta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      t1 = s.theta + d;
    }
    const tween = { t0: performance.now(), dur: animate ? duration : 0, from: { theta: s.theta, phi: s.phi, r: s.radius, ty: ctl.target.y }, to: { theta: t1, phi: to.phi, r: to.r, ty: targetY } };
    this._camTween = tween;
    if (!animate) this._stepCamTween(performance.now());
    this.invalidate();
  }

  _stepCamTween(now) {
    const tw = this._camTween; if (!tw) return false;
    const p = tw.dur <= 0 ? 1 : Math.min(1, (now - tw.t0) / tw.dur);
    const e = ease(p);
    const th = tw.from.theta + (tw.to.theta - tw.from.theta) * e;
    const ph = tw.from.phi + (tw.to.phi - tw.from.phi) * e;
    const r = tw.from.r + (tw.to.r - tw.from.r) * e;
    const ty = tw.from.ty + (tw.to.ty - tw.from.ty) * e;
    this.controls.target.set(0, ty, 0);
    const sp = new THREE.Spherical(r, THREE.MathUtils.clamp(ph, 0.04, Math.PI - 0.04), th);
    this.camera.position.setFromSpherical(sp).add(this.controls.target);
    this.camera.lookAt(this.controls.target);
    if (p >= 1) this._camTween = null;
    return true;
  }

  setAutoRotate(on) {
    this.controls.autoRotate = !!on;
    this._idle = 0;
    this.invalidate();
  }
  get autoRotate() { return this.controls.autoRotate; }

  /* ------------------------------------------------------------------ decals */
  /**
   * Reconcile the decal manager with design.decals for the current model.
   * Design decal: { id, type:'text'|'image', text, font, color, src, size, rot, place:{[modelId]:{pos,normal}} }
   */
  async _syncDecals(list) {
    const rec = this.current; if (!rec) return;
    const ver = ++this._decalVersion;
    const want = list.slice(0, 4);
    // remove stale
    for (const d of [...this.decals.items]) if (!want.find((w) => w.id === d.id)) this.decals.remove(d.id);
    for (let idx = 0; idx < want.length; idx++) {
      const w = want[idx];
      let place = w.place?.[rec.id];
      if (!place) {
        const order = ['side', 'medial', 'heel', 'toe'];
        const a = rec.anchors[order[idx % 4]] || rec.anchors.side;
        place = a ? { pos: a.pos, normal: a.normal } : { pos: [0, rec.height / rec.scale * 0.4, 0.05], normal: [0, 0, 1] };
        (w.place ||= {})[rec.id] = place;
        this.emit('decalplace', { id: w.id, modelId: rec.id, place });
      }
      const sig = w.type === 'text' ? `t|${w.text}|${w.font}|${w.color}` : `i|${w.src?.length}|${w.src?.slice(-48)}`;
      let item = this.decals.get(w.id);
      let tex = null;
      if (!item || item.sig !== sig) {
        tex = w.type === 'text'
          ? (w.text ? renderTextCanvas({ text: w.text, font: w.font || 'Manrope KC', color: w.color || '#111' }) : null)
          : await this._imageCanvas(w.src);
        if (ver !== this._decalVersion) return;   // a newer sync superseded this one
        if (!tex) { if (item) this.decals.remove(w.id); continue; }
      }
      if (!item) {
        item = this.decals.add({ id: w.id, canvas: tex.canvas, aspect: tex.aspect, pos: place.pos, normal: place.normal, size: w.size, rot: w.rot || 0 });
        if (item) item.sig = sig;
      } else {
        if (tex) { this.decals.updateTexture(w.id, tex.canvas, tex.aspect); item.sig = sig; }
        this.decals.update(w.id, { pos: place.pos, normal: place.normal, size: w.size, rot: w.rot || 0 });
      }
    }
    this._decalDirty = true;
    this.invalidate();
  }

  async _imageCanvas(src) {
    if (!src) return null;
    if (this.imageCache.has(src)) return this.imageCache.get(src);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const out = renderImageCanvas(img);
    this.imageCache.set(src, out);
    return out;
  }

  /** Convenience wrappers matching the product API; the store owns the data, the viewer renders it. */
  addTextDecal(design, { text, font = 'Inter Tight', color = '#111111', size = 0.14 }) {
    const d = { id: newId(), type: 'text', text, font, color, size, rot: 0, place: {} };
    design.decals.push(d);
    this._syncDecals(design.decals);
    return d;
  }
  addImageDecal(design, { src, size = 0.16 }) {
    const d = { id: newId(), type: 'image', src, size, rot: 0, place: {} };
    design.decals.push(d);
    this._syncDecals(design.decals);
    return d;
  }
  removeDecal(design, id) {
    design.decals = design.decals.filter((d) => d.id !== id);
    this.decals.remove(id);
    this._syncDecals(design.decals);
  }

  /* ------------------------------------------------------------------ pointer: tap-to-select + drag decals */
  _bindPointer() {
    const el = this.canvas;
    let down = null, drag = null;

    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, moved: false };
      // pressing on a decal footprint grabs it (instead of orbiting the camera)
      if (this.mode === 'customizer' && this.decals.items.length) {
        const hit = this._raycast(e.clientX, e.clientY);
        if (hit) {
          const rec = this.current;
          const p = rec.mesh.worldToLocal(hit.point.clone());
          for (let i = this.decals.items.length - 1; i >= 0; i--) {
            const d = this.decals.items[i];
            if (this.decals.contains(d, p, rec.objLength)) {
              drag = { id: d.id, pointer: e.pointerId, started: false };
              e.stopImmediatePropagation();
              this.emit('decalselect', { id: d.id });
              try { el.setPointerCapture(e.pointerId); } catch (_) {}
              break;
            }
          }
        }
      }
    }, { capture: true });

    el.addEventListener('pointermove', (e) => {
      if (!down || e.pointerId !== down.id) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) down.moved = true;
      if (drag && drag.pointer === e.pointerId && down.moved) {
        drag.started = true;
        const hit = this._raycast(e.clientX, e.clientY);
        if (hit) {
          const pl = this._hitToObject(this.current, hit);
          this.decals.update(drag.id, { pos: pl.pos, normal: pl.normal });
          this.emit('decalmove', { id: drag.id, modelId: this.current.id, place: { pos: pl.pos, normal: pl.normal } });
        }
      }
    });

    const finish = (e) => {
      if (!down || e.pointerId !== down.id) return;
      // A tap is defined by movement, not by duration: a time limit misfires on slow devices
      // (and on a deliberate, slightly long press) where the pointerup handler runs late.
      const wasTap = !down.moved;
      const d = drag; down = null; drag = null;
      if (d) {
        try { el.releasePointerCapture(e.pointerId); } catch (_) {}
        if (d.started) this.emit('decalmoveend', { id: d.id, modelId: this.current.id });
        return;
      }
      if (wasTap && this.mode === 'customizer' && e.type === 'pointerup') {
        const r = this.pickPart(e.clientX, e.clientY);
        this.emit('tap', { part: r?.part || null, placement: r?.placement || null, x: e.clientX, y: e.clientY });
        if (r) this.selectMesh(r.part);
      }
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', (e) => { if (down && e.pointerId === down.id) { down = null; drag = null; } });
  }

  /* ------------------------------------------------------------------ preview capture */
  /** Render a clean (no highlight) product shot and return a JPEG data URL. */
  capturePreview({ width = 720, height = 540, view = 'default', quality = 0.86 } = {}) {
    if (this.failed || !this.current || this._lost) return null;
    const { renderer, camera, controls } = this;
    const saved = {
      pos: camera.position.clone(), target: controls.target.clone(), aspect: camera.aspect,
      pr: renderer.getPixelRatio(), size: renderer.getSize(new THREE.Vector2()),
      auto: controls.autoRotate,
    };
    const u = this.current.material.userData.kc;
    const selAmt = u.uSelAmt.value;
    try {
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      const prevBase = this.baseDistance;
      this._computeBaseDistance();
      const to = this._viewTarget(view);
      controls.target.set(0, this.targetY, 0);
      camera.position.setFromSpherical(new THREE.Spherical(to.r * 0.98, to.phi, to.theta)).add(controls.target);
      camera.lookAt(controls.target);
      this._updateRig();
      u.uSelAmt.value = 0;
      renderer.render(this.scene, camera);

      const out = document.createElement('canvas');
      out.width = width; out.height = height;
      const ctx = out.getContext('2d');
      const g = ctx.createRadialGradient(width / 2, height * 0.62, 0, width / 2, height * 0.62, Math.max(width, height) * 0.75);
      g.addColorStop(0, STUDIO_BG[0]); g.addColorStop(0.5, STUDIO_BG[1]); g.addColorStop(1, STUDIO_BG[2]);
      ctx.fillStyle = g; ctx.fillRect(0, 0, width, height);
      ctx.drawImage(renderer.domElement, 0, 0, width, height);
      this.baseDistance = prevBase;
      return out.toDataURL('image/jpeg', quality);
    } catch (e) {
      console.error('capturePreview failed', e);
      return null;
    } finally {
      u.uSelAmt.value = selAmt;
      renderer.setPixelRatio(saved.pr);
      renderer.setSize(saved.size.x, saved.size.y, false);
      camera.aspect = saved.aspect; camera.updateProjectionMatrix();
      camera.position.copy(saved.pos); controls.target.copy(saved.target); camera.lookAt(saved.target);
      this._computeBaseDistance();
      this._updateRig();
      this.invalidate();
    }
  }

  /* ------------------------------------------------------------------ render loop */
  setActive(on) {
    this._active = !!on;
    if (on) this.invalidate();
    else if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
  }

  invalidate() {
    this._needs = true; this._idle = 0;
    if (!this._raf && this._active && this._onscreen && !this.failed) this._raf = requestAnimationFrame((t) => this._frame(t));
  }

  _updateRig() {
    const s = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    this.rig.rotation.y = s.theta;
    const below = this.camera.position.y < 0.002;
    this.floor.visible = !below;
  }

  _frame(now) {
    this._raf = 0;
    if (!this._active || !this._onscreen || this._lost) return;
    const dt = Math.min(0.05, this._last ? (now - this._last) / 1000 : 0.016);
    this._last = now;
    let animating = false;

    if (this._camTween) { this._stepCamTween(performance.now()); animating = !!this._camTween || animating; this._needs = true; }
    const changed = this.controls.update(dt);
    if (changed) this._needs = true;
    if (this.controls.autoRotate) animating = true;

    // cross-fade / intro
    const f = this._fade;
    if (f) {
      const p = Math.min(1, (performance.now() - f.t0) / f.dur);
      const e = f.dir > 0 ? easeOut(p) : p * p;
      const m = f.rec.material;
      m.opacity = f.dir > 0 ? e : 1 - e;
      this.blobMat.opacity = 0.5 * (f.dir > 0 ? e : 1 - e);
      this.shadowMat.opacity = 0.2 * (f.dir > 0 ? e : 1 - e);
      if (f.intro) {
        const s = 0.9 + 0.1 * e;
        this.modelGroup.scale.set(s, s, s * (this.design?.mirror ? -1 : 1));
        this.modelGroup.rotation.y = (1 - e) * -0.9;
      } else if (f.dir > 0) {
        const s = 0.96 + 0.04 * e;
        this.modelGroup.scale.set(s, s, s * (this.design?.mirror ? -1 : 1));
        this.modelGroup.rotation.y = (1 - e) * 0.22;
      } else {
        const s = 1 - 0.04 * p;
        this.modelGroup.scale.set(s, s, s * (this.design?.mirror ? -1 : 1));
        this.modelGroup.rotation.y = -0.22 * p;
      }
      if (p >= 1) {
        this._fade = null;
        if (f.dir > 0) {
          this.modelGroup.scale.set(1, 1, this.design?.mirror ? -1 : 1);
          this.modelGroup.rotation.y = 0;
          this.blobMat.opacity = 0.5; this.shadowMat.opacity = 0.2;
        }
        f.done && f.done();
      } else animating = true;
      this._needs = true;
    }

    if (this._smooth(dt)) { animating = true; this._needs = true; }
    if (this._decalDirty && this.current) {
      this.decals.syncUniforms(this.current.material, this.current.objLength);
      this._decalDirty = false; this._needs = true;
    }

    if (this._needs) {
      this._updateRig();
      this.renderer.render(this.scene, this.camera);
      this._needs = false;
      this._idle = 0;
    } else this._idle++;

    if (animating || this._idle < 4) this._raf = requestAnimationFrame((t) => this._frame(t));
  }

  /* ------------------------------------------------------------------ cleanup */
  dispose() {
    this.setActive(false);
    this._ro?.disconnect();
    this._io?.disconnect();
    this.controls.dispose();
    this.decals.dispose();
    this.records.forEach((r) => { r.material.dispose(); });
    this.envTex.dispose();
    this.renderer.dispose();
  }
}
