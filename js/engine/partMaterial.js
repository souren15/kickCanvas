/**
 * Per-part PBR material for single-mesh sneaker GLBs.
 *
 * Both supplied GLBs are one mesh with one baked texture, so there are no sub-meshes to recolour.
 * Instead each model ships with three RGB "part masks" in the same UV space as the baked texture
 * (see tools/segment). This material is a real MeshPhysicalMaterial whose fragment shader reads
 * those masks and applies, per part:
 *   - a tint colour (recolouring while keeping the baked shading/detail of the original texture)
 *   - a finish (roughness, clear-coat, sheen, procedural leather grain / suede nap)
 *   - a selection highlight outline
 * and projects up to MAX_DECALS text/artwork decals onto the surface in object space.
 *
 * Nothing here is an overlay: every change alters the surface's albedo/roughness/clearcoat/normal
 * inside the physically based lighting model, so reflections and shadows respond correctly.
 */
import * as THREE from 'three';

export const MAX_DECALS = 4;
export const PART_SLOTS = ['panels', 'trim', 'detail', 'laces', 'tongue', 'heel', 'midsole', 'outsole', 'upper'];
export const PART_INDEX = Object.fromEntries(PART_SLOTS.map((k, i) => [k, i]));
const N = PART_SLOTS.length; // 9

/** Finish presets. rough = base roughness; clear = clear-coat amount; sheen = velvet sheen; grain = [type, amount] */
export const FINISHES = {
  matte:   { label: 'Matte',   rough: 0.82, clear: 0.0,  clearRough: 0.5,  sheen: 0.0, grain: [0, 0.0] },
  gloss:   { label: 'Gloss',   rough: 0.16, clear: 1.0,  clearRough: 0.05, sheen: 0.0, grain: [0, 0.0] },
  leather: { label: 'Leather', rough: 0.50, clear: 0.28, clearRough: 0.38, sheen: 0.0, grain: [1, 1.0] },
  suede:   { label: 'Suede',   rough: 0.96, clear: 0.0,  clearRough: 0.6,  sheen: 1.0, grain: [2, 1.0] },
  gum:     { label: 'Gum',     rough: 0.72, clear: 0.0,  clearRough: 0.6,  sheen: 0.0, grain: [1, 0.55] },
};

const VERT_PARS = /* glsl */`
varying vec3 vObjPos;
varying vec3 vObjNormal;
`;

const FRAG_PARS = /* glsl */`
varying vec3 vObjPos;
varying vec3 vObjNormal;
uniform sampler2D uMask0;
uniform sampler2D uMask1;
uniform sampler2D uMask2;
uniform vec3  uPartColor[${N}];
uniform float uPartTint[${N}];
uniform float uPartRef[${N}];
uniform vec4  uPartFinish[${N}];   // x rough, y clearcoat, z clearcoat roughness, w sheen
uniform vec2  uPartGrain[${N}];    // x type (0 none, 1 leather, 2 suede), y amount
uniform float uPartMapMix[${N}];   // 1 = take roughness from the model's ORM map
uniform float uRoughRef;           // that map's mean roughness, so a finish can add detail
uniform vec2  uDetail;             // x exponent, y unused
uniform vec2  uDetailClamp;        // min, max
uniform vec2  uEdge;               // mask sharpening thresholds
uniform int   uSel;                // selected part index, -1 = none
uniform float uSelAmt;
uniform vec3  uSelColor;
uniform vec2  uSelEdge;            // outline falloff in pixels (inner, outer)
uniform sampler2D uDecalTex0;
uniform sampler2D uDecalTex1;
uniform sampler2D uDecalTex2;
uniform sampler2D uDecalTex3;
uniform mat4  uDecalInv[${MAX_DECALS}];
uniform vec4  uDecalParams[${MAX_DECALS}]; // x enabled, y flipU, z opacity, w unused

float kcHash(vec3 p){
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float kcNoise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(kcHash(i + vec3(0,0,0)), kcHash(i + vec3(1,0,0)), f.x),
                 mix(kcHash(i + vec3(0,1,0)), kcHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(kcHash(i + vec3(0,0,1)), kcHash(i + vec3(1,0,1)), f.x),
                 mix(kcHash(i + vec3(0,1,1)), kcHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
// leather: pebbled cells; suede: fine fuzzy nap
float kcLeather(vec3 p){
  float a = kcNoise(p * 640.0);
  float b = kcNoise(p * 1450.0);
  return (1.0 - abs(a * 2.0 - 1.0)) * 0.7 + b * 0.3;
}
float kcSuede(vec3 p){
  return kcNoise(p * 2300.0) * 0.6 + kcNoise(p * 5200.0) * 0.4;
}
vec3 kcBump(vec3 surfPos, vec3 n, float h, float strength){
  vec3 dpdx = dFdx(surfPos); vec3 dpdy = dFdy(surfPos);
  float dhx = dFdx(h); float dhy = dFdy(h);
  vec3 r1 = cross(dpdy, n); vec3 r2 = cross(n, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * n - strength * grad);
}
vec4 kcDecal(sampler2D tex, mat4 inv, vec4 prm){
  vec4 q = inv * vec4(vObjPos, 1.0);
  vec2 uv = q.xy + 0.5;
  uv.x = mix(uv.x, 1.0 - uv.x, prm.y);
  float inBox = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0) * step(abs(q.z), 1.0);
  // facing: the decal's depth axis (row 2 of the inverse matrix) points out of the surface
  vec3 dir = normalize(vec3(inv[0][2], inv[1][2], inv[2][2]));
  float facing = smoothstep(0.12, 0.5, dot(normalize(vObjNormal), dir));
  vec4 t = texture2D(tex, clamp(uv, 0.001, 0.999)); // premultiplied alpha
  float k = inBox * facing * prm.x * prm.z;
  return t * k;
}
`;

// Replaces <map_fragment>: builds albedo + per-part material parameters.
const FRAG_MAP = /* glsl */`
float pRough = 0.6, pClear = 0.0, pClearR = 0.5, pSheen = 0.0, pGrainL = 0.0, pGrainS = 0.0, pMapMix = 0.0;
float pw[${N}];
for (int i = 0; i < ${N}; i++) pw[i] = 0.0;
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  vec3 pm0 = texture2D( uMask0, vMapUv ).rgb;
  vec3 pm1 = texture2D( uMask1, vMapUv ).rgb;
  vec3 pm2 = texture2D( uMask2, vMapUv ).rgb;
  pw[0]=pm0.r; pw[1]=pm0.g; pw[2]=pm0.b; pw[3]=pm1.r; pw[4]=pm1.g; pw[5]=pm1.b; pw[6]=pm2.r; pw[7]=pm2.g;
  float psum = 0.0;
  for (int i = 0; i < ${N - 1}; i++) { pw[i] = smoothstep(uEdge.x, uEdge.y, pw[i]); psum += pw[i]; }
  if (psum > 1.0) { for (int i = 0; i < ${N - 1}; i++) pw[i] /= psum; psum = 1.0; }
  pw[${N - 1}] = 1.0 - psum;

  pRough = 0.0; pClearR = 0.0; // part weights sum to exactly 1, so accumulate from zero
  vec3 baseCol = sampledDiffuseColor.rgb;
  float baseL = dot(baseCol, vec3(0.2126, 0.7152, 0.0722));
  vec3 albedo = vec3(0.0);
  for (int i = 0; i < ${N}; i++) {
    float wi = pw[i];
    float d = clamp(pow(max(baseL, 1e-4) / max(uPartRef[i], 1e-4), uDetail.x), uDetailClamp.x, uDetailClamp.y);
    albedo += wi * mix(baseCol, uPartColor[i] * d, uPartTint[i]);
    vec4 fin = uPartFinish[i];
    pRough  += wi * fin.x;
    pClear  += wi * fin.y;
    pClearR += wi * fin.z;
    pSheen  += wi * fin.w;
    pGrainL += wi * (uPartGrain[i].x > 0.5 && uPartGrain[i].x < 1.5 ? uPartGrain[i].y : 0.0);
    pGrainS += wi * (uPartGrain[i].x > 1.5 ? uPartGrain[i].y : 0.0);
    pMapMix += wi * uPartMapMix[i];
  }

  // projected decals (text / artwork), printed into the albedo like ink
  vec4 dc0 = kcDecal(uDecalTex0, uDecalInv[0], uDecalParams[0]);
  vec4 dc1 = kcDecal(uDecalTex1, uDecalInv[1], uDecalParams[1]);
  vec4 dc2 = kcDecal(uDecalTex2, uDecalInv[2], uDecalParams[2]);
  vec4 dc3 = kcDecal(uDecalTex3, uDecalInv[3], uDecalParams[3]);
  // the decal textures are sRGB; premultiplied rgb is already decoded to linear by the sampler
  albedo = albedo * (1.0 - dc0.a) + dc0.rgb;
  albedo = albedo * (1.0 - dc1.a) + dc1.rgb;
  albedo = albedo * (1.0 - dc2.a) + dc2.rgb;
  albedo = albedo * (1.0 - dc3.a) + dc3.rgb;
  float decalCover = max(max(dc0.a, dc1.a), max(dc2.a, dc3.a));

  // suede nap: subtle value variation
  if (pGrainS > 0.01) {
    float nap = kcSuede(vObjPos);
    albedo *= 1.0 + (nap - 0.5) * 0.22 * pGrainS;
  }
  diffuseColor.rgb = albedo;
  sampledDiffuseColor = vec4(albedo, 1.0);
#endif
`;

/**
 * Roughness. A part left on its original finish uses the model's own ORM map, so the knit, the
 * foam and the rubber keep the roughness the artist authored. A part given an explicit finish
 * takes that finish's value, plus the map's local deviation so the surface keeps its character
 * instead of going uniformly flat.
 */
const FRAG_ROUGH = /* glsl */`
float kcRough = pRough;
#ifdef USE_ROUGHNESSMAP
  float kcMapR = texture2D( roughnessMap, vRoughnessMapUv ).g;
  kcRough = mix( pRough + (kcMapR - uRoughRef) * 0.3, kcMapR, pMapMix );
#endif
float roughnessFactor = clamp(kcRough, 0.04, 1.0);
`;

const FRAG_NORMAL = /* glsl */`
#include <normal_fragment_maps>
{
  float px = length(fwidth(vObjPos));
  float lodL = 1.0 - smoothstep(0.35, 1.0, px * 640.0);
  float lodS = 1.0 - smoothstep(0.35, 1.0, px * 2300.0);
  vec3 sp = - vViewPosition;
  if (pGrainL > 0.01 && lodL > 0.01) {
    float hL = kcLeather(vObjPos);
    normal = kcBump(sp, normal, hL, 0.0016 * pGrainL * lodL);
  }
  if (pGrainS > 0.01 && lodS > 0.01) {
    float hS = kcSuede(vObjPos);
    normal = kcBump(sp, normal, hS, 0.0009 * pGrainS * lodS);
  }
}
`;

const FRAG_EMISSIVE = /* glsl */`
#include <emissivemap_fragment>
#ifdef USE_MAP
if (uSel >= 0 && uSelAmt > 0.001) {
  float selW = 0.0;
  for (int i = 0; i < ${N}; i++) { if (i == uSel) selW = pw[i]; }
  // screen-space constant outline: fwidth gives the per-pixel slope of the mask, so dividing by
  // it converts the weight into an approximate distance in pixels from the part's border.
  float fw = max(fwidth(selW), 1e-5);
  float distPx = abs(selW - 0.5) / fw;
  float edge = 1.0 - smoothstep(uSelEdge.x, uSelEdge.y, distPx);
  // a gentle lift across the whole part so the selection is obvious even where no border is in view
  float fill = smoothstep(0.35, 0.75, selW);
  totalEmissiveRadiance += uSelColor * (edge * 1.6 + fill * 0.045) * uSelAmt;
}
#endif
`;

/** Build the material. maps = { map, masks:[t0,t1,t2] } */
export function createPartMaterial({ map, masks, partRef, defaultRough = 0.6, normalMap = null, ormMap = null, roughRef = 0.7 }) {
  const mat = new THREE.MeshPhysicalMaterial({
    map,
    normalMap,
    roughnessMap: ormMap,
    metalnessMap: ormMap,
    aoMap: ormMap,
    aoMapIntensity: ormMap ? 1.0 : 0.0,
    color: 0xffffff,
    roughness: 0.6,
    metalness: 0.0,
    clearcoat: 1.0,       // enables USE_CLEARCOAT (value is overridden per fragment)
    sheen: 1.0,           // enables USE_SHEEN (value is overridden per fragment)
    sheenColor: new THREE.Color(0xffffff),
    envMapIntensity: 1.0,
  });

  const u = {
    uMask0: { value: masks[0] }, uMask1: { value: masks[1] }, uMask2: { value: masks[2] },
    uPartColor: { value: Array.from({ length: N }, () => new THREE.Color(1, 1, 1)) },
    uPartTint: { value: new Array(N).fill(0) },
    uPartRef: { value: PART_SLOTS.map((k) => Math.max(partRef?.[k] ?? 0.2, 0.005)) },
    uPartFinish: { value: Array.from({ length: N }, () => new THREE.Vector4(defaultRough, 0, 0.5, 0)) },
    uPartGrain: { value: Array.from({ length: N }, () => new THREE.Vector2(0, 0)) },
    uPartMapMix: { value: new Array(N).fill(ormMap ? 1 : 0) },
    uRoughRef: { value: roughRef },
    uDetail: { value: new THREE.Vector2(0.55, 0) },
    uDetailClamp: { value: new THREE.Vector2(0.28, 1.9) },
    uEdge: { value: new THREE.Vector2(0.18, 0.82) },
    uSel: { value: -1 },
    uSelAmt: { value: 0 },
    uSelColor: { value: new THREE.Color('#ff4d1f') },
    uSelEdge: { value: new THREE.Vector2(1.1, 2.4) },
    uDecalTex0: { value: null }, uDecalTex1: { value: null }, uDecalTex2: { value: null }, uDecalTex3: { value: null },
    uDecalInv: { value: Array.from({ length: MAX_DECALS }, () => new THREE.Matrix4()) },
    uDecalParams: { value: Array.from({ length: MAX_DECALS }, () => new THREE.Vector4(0, 0, 1, 0)) },
  };
  mat.userData.kc = u;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = VERT_PARS + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n vObjPos = position; vObjNormal = normal;'
    );
    const lp = THREE.ShaderChunk.lights_physical_fragment
      .replace('material.clearcoat = clearcoat;', 'material.clearcoat = pClear;')
      .replace('material.clearcoatRoughness = clearcoatRoughness;', 'material.clearcoatRoughness = pClearR;')
      .replace('material.sheenColor = sheenColor;', 'material.sheenColor = pSheen * mix(vec3(1.0), diffuseColor.rgb, 0.6);')
      .replace('material.sheenRoughness = clamp( sheenRoughness, 0.0001, 1.0 );', 'material.sheenRoughness = 0.45;');
    shader.fragmentShader = FRAG_PARS + shader.fragmentShader
      .replace('#include <map_fragment>', FRAG_MAP)
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
      .replace('#include <emissivemap_fragment>', FRAG_EMISSIVE)
      .replace('#include <lights_physical_fragment>', lp);
  };
  mat.customProgramCacheKey = () => 'kc-part-material-v1';
  return mat;
}

/** Convenience writer used by the viewer. */
export function setPartFinish(mat, slotIndex, finishKey, originalRough) {
  const u = mat.userData.kc;
  const f = finishKey === 'original' || !FINISHES[finishKey]
    ? { rough: originalRough, clear: 0.0, clearRough: 0.5, sheen: 0.0, grain: [0, 0] }
    : FINISHES[finishKey];
  u.uPartFinish.value[slotIndex].set(f.rough, f.clear, f.clearRough, f.sheen);
  u.uPartGrain.value[slotIndex].set(f.grain[0], f.grain[1]);
}
