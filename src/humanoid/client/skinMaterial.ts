/**
 * Realistic procedural skin: MeshPhysicalMaterial patched via
 * onBeforeCompile.
 *
 *  - Albedo is computed in the shader from the appearance (tone, regional
 *    variation from per-vertex masks: lips, blush, eye sockets, nose, ears,
 *    nails), painted features in face coordinates (eyebrows, stubble, shaved
 *    scalp, scars, warpaint, tattoos), age blotches and the race pattern
 *    (freckles, scales, bark, spots, tattoos, veins, stripes, crystals)
 *    evaluated in 3D bind-pose space so patterns have no UV seams.
 *  - Micro detail: pores and micro wrinkles from a shared tiling texture,
 *    age wrinkles and pattern relief, all through derivative bump mapping.
 *  - Lighting: per-channel wrap diffuse (subsurface scattering look: red
 *    light bleeds past the terminator), back-light translucency on thin
 *    parts (ears, nostrils), sheen for peach fuzz, skin IOR specular.
 *  - Facial expressions: expression-unit deltas from a shared texture are
 *    added in the vertex shader (per-character weights as uniforms).
 *  - Sky occlusion via patchSkyOcclusion('uniform').
 *
 * All characters share one GPU program; per-character data lives in
 * uniforms, so 60 unique NPCs cost no extra textures.
 */
import * as THREE from 'three';
import { patchSkyOcclusion, type SkyVisPatch } from '../../render/skyOcclusion';
import type { HumanoidAppearance } from '../types';
import { GLSL_NOISE } from './glsl';
import { GLSL_FACE, GLSL_EYE_MASK, BEARD_IDS } from './faceRegions';
import { poreTexture } from './textures';
import { MARK_IDS } from '../appearance';

export const PATTERN_IDS: Record<HumanoidAppearance['skinPattern'], number> = {
  none: 0, freckles: 1, scales: 2, bark: 3, spots: 4, tattoos: 5, veins: 6, stripes: 7, crystals: 8,
};
const BROW_PARAMS: Record<string, [number, number, number, number]> = {
  none: [0, 0, 0, 0], thin: [0.6, 0.9, 0, 0.75], normal: [1, 0.7, 0, 0.9], thick: [1.35, 0.6, 0, 1], bushy: [1.75, 0.5, 0, 1.1],
  arched: [0.95, 1.6, 0, 0.9], unibrow: [1.35, 0.5, 0.9, 1], scaled: [0, 0, 0, 0],
};

export interface SkinUniforms {
  uTone: { value: THREE.Color };
  uAccent: { value: THREE.Color };
  uHair: { value: THREE.Color };
  uPattern: { value: THREE.Vector4 };
  uLook: { value: THREE.Vector4 };
  uBrow: { value: THREE.Vector4 };
  uBeard: { value: THREE.Vector4 };
  uMarks: { value: number };
  uExprW: { value: Float32Array };
  uExprTex: { value: THREE.Texture | null };
  uFaceScale: { value: number };
  uPores: { value: THREE.Texture };
  uHide: { value: number };
  /** A worn eye mask: x off (0) / domino (1) / round a cowl's eye holes (2), yzw its colour (linear). Set by the equipment. */
  uMask: { value: THREE.Vector4 };
  /** The material's sheenColor, tinted from the skin tone by applySkinLook. */
  sheenTarget?: THREE.Color;
}

export interface SkinMaterialHandle {
  material: THREE.MeshPhysicalMaterial;
  uniforms: SkinUniforms;
  sky: SkyVisPatch;
}

const SKIN_VERT_HEAD = /* glsl */ `
attribute vec4 aMaskA;
attribute vec4 aMaskB;
attribute vec3 aFace;
attribute float aExpr;
uniform sampler2D uExprTex;
uniform float uExprW[EXPR_UNITS];
uniform float uFaceScale;
varying vec4 vMaskA;
varying vec4 vMaskB;
varying vec3 vFace;
varying vec3 vBind;
varying vec2 vSkinUv;
`;

const SKIN_VERT_BODY = /* glsl */ `
vBind = position;
vSkinUv = uv;
vMaskA = aMaskA;
vMaskB = aMaskB;
vFace = aFace;
#ifdef SKIN_EXPR
if (aExpr >= 0.0) {
  vec3 ed = vec3(0.0);
  int ei = int(aExpr + 0.5);
  for (int i = 0; i < EXPR_UNITS; i++) {
    float w = uExprW[i];
    if (w != 0.0) ed += texelFetch(uExprTex, ivec2(ei, i), 0).xyz * w;
  }
  transformed += ed * uFaceScale;
}
#endif
`;

const SKIN_FRAG_HEAD = /* glsl */ `
uniform vec3 uTone;
uniform vec3 uAccent;
uniform vec3 uHair;
uniform vec4 uPattern;   // x id, y strength, z seed, w glow
uniform vec4 uLook;      // x age, y male, z blush, w scalp shade
uniform vec4 uBrow;      // thickness, arch, unibrow, density
uniform vec4 uBeard;     // x style id, y density, z scalp recede, w lip tint
uniform float uMarks;
uniform vec4 uMask;
uniform sampler2D uPores;
varying vec4 vMaskA;
varying vec4 vMaskB;
varying vec3 vFace;
varying vec3 vBind;
varying vec2 vSkinUv;
float sk_thin = 0.0;
${GLSL_NOISE}
${GLSL_FACE}
${GLSL_EYE_MASK}
float h_bit(float bits, float i) { return mod(floor(bits / exp2(i)), 2.0); }
float h_seg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * t);
}
vec3 h_bumpNormal(vec3 surfPos, vec3 n, float h, float faceDir) {
  vec3 sx = dFdx(surfPos), sy = dFdy(surfPos);
  vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  return normalize(abs(det) * n - grad);
}

// Outputs of skinEval
vec3 sk_albedo;
float sk_rough;
float sk_height;
vec3 sk_emit;

void skinEval() {
  vec3 tone = uTone;
  float seed = uPattern.z;
  vec3 f = vFace;
  float age = uLook.x, male = uLook.y;
  float lips = vMaskA.x, cheeks = vMaskA.y, socket = vMaskA.z, nose = vMaskA.w;
  float ears = vMaskB.x, ageZ = vMaskB.y, laugh = vMaskB.z;
  // One channel holds the nails and the lid line (they never meet): face height tells them apart.
  float onFace = step(-3.0, vFace.y);
  float nails = vMaskB.w * (1.0 - onFace), lidLine = vMaskB.w * onFace;
  float lumT = dot(tone, vec3(0.2126, 0.7152, 0.0722));
  float fair = smoothstep(0.03, 0.4, lumT); // how visible redness is

  // ---- broad tone variation (blood, sun, melanin unevenness)
  float lowN = h_fbm3(vBind * 4.0 + seed * 31.0);
  float midN = h_noise3(vBind * 23.0 + seed * 7.0);
  vec3 c = tone * (0.9 + 0.2 * lowN) * (0.97 + 0.06 * midN);
  // Living skin is never one flat colour: blotchy red (capillaries) vs. yellow
  // (fat/melanin) hue shifts at a few centimetres, scaled down on dark skin.
  float hueN = h_fbm3(vBind * 9.0 + seed * 17.0);
  c *= mix(vec3(1.0), mix(vec3(1.05, 0.95, 0.93), vec3(1.0, 1.0, 0.92), smoothstep(0.35, 0.65, hueN)), 0.3 + 0.7 * fair);
  // Faint bluish veins where skin is thin (inner forearms, temples, chest).
  float veinN = abs(h_noise3(vBind * vec3(22.0, 9.0, 22.0) + 3.0) - 0.5);
  c = mix(c, c * vec3(0.9, 0.93, 1.06), (1.0 - smoothstep(0.0, 0.04, veinN)) * 0.35 * fair);
  // Warmer, redder extremities & face; slightly darker back of hands, lighter palms/soles via height.
  vec3 blood = vec3(1.08, 0.86, 0.84);
  c = mix(c, c * blood, 0.5 * fair * (cheeks * (0.55 + uLook.z) + nose * 0.6 + ears * 0.5));
  // Lips: darker, redder; tint toward hair/accent for fantasy tones.
  vec3 lipCol = c * mix(vec3(0.86, 0.5, 0.48), vec3(0.75, 0.62, 0.7), 1.0 - fair) * (0.9 + 0.1 * male);
  lipCol = mix(lipCol, uAccent * 0.8, uBeard.w);
  c = mix(c, lipCol, smoothstep(0.0, 0.6, lips) * 0.9);
  // Eye sockets: thinner, slightly violet skin.
  c = mix(c, c * vec3(0.84, 0.8, 0.86), socket * (0.45 + age * 0.4));
  // Nails: pinkish-white, glossy.
  c = mix(c, mix(c, vec3(0.86, 0.72, 0.68), 0.55), nails);
  // Age spots.
  float spots = smoothstep(0.62, 0.8, h_noise3(vBind * 38.0 + seed * 3.0)) * smoothstep(0.62, 0.9, age);
  c = mix(c, c * vec3(0.78, 0.68, 0.58), spots * 0.6);

  // Specular breakup: oily T-zone, drier cheeks/limbs, mid-frequency variation.
  float tzone = (1.0 - smoothstep(0.25, 0.6, abs(f.x))) * smoothstep(-1.0, -0.6, f.y) * (1.0 - smoothstep(1.4, 1.9, f.y)) * smoothstep(-0.4, 0.0, f.z);
  float rough = 0.56 - 0.12 * lips + 0.06 * age - 0.1 * tzone - 0.18 * nails + (h_noise3(vBind * 60.0 + 5.0) - 0.5) * 0.14;
  float height = 0.0;
  vec3 emit = vec3(0.0);

  // ---- micro detail: pores (stronger on nose & cheeks) and micro-wrinkles
  vec4 pt = texture2D(uPores, vSkinUv * 28.0);
  // Fade micro detail once a pixel covers more than ~0.4 mm (avoids sparkling aliasing).
  float px = length(fwidth(vBind));
  float micro = 1.0 - smoothstep(0.00025, 0.0009, px);
  float poreAmt = (0.3 + 0.7 * max(nose, cheeks)) * micro;
  height += (pt.r - 0.78) * 0.0002 * poreAmt * (1.0 - lips) * (1.0 - nails);
  height += (pt.g - 0.86) * 0.00022 * (0.3 + age) * (1.0 - lips) * micro;
  height += (h_noise3(vBind * 900.0) - 0.5) * 0.00012 * lips;

  // ---- age wrinkles: forehead lines, crow's feet, nasolabial folds, neck
  float wr = smoothstep(0.45, 0.95, age);
  if (wr > 0.0) {
    float fh = (1.0 - smoothstep(0.05, 0.18, abs(f.y - 0.95) - 0.25)) * (1.0 - smoothstep(0.55, 0.9, abs(f.x)));
    height -= wr * fh * 0.0005 * smoothstep(0.35, 1.0, 0.5 + 0.5 * sin(f.y * 36.0 + h_noise2(f.xy * 3.0) * 3.0));
    float crow = smoothstep(0.35, 0.0, length(vec2(abs(f.x) - 1.02, f.y + 0.02)) - 0.05);
    float rays = 0.5 + 0.5 * sin(atan(f.y + 0.02, abs(f.x) - 0.95) * 18.0 + h_noise2(f.xy * 9.0) * 2.0);
    height -= wr * crow * 0.0004 * smoothstep(0.5, 1.0, rays);
    height -= wr * laugh * 0.0012;
    height -= wr * ageZ * 0.0003 * h_noise3(vBind * 160.0);
    c = mix(c, c * 0.92, wr * laugh * 0.4);
  }

  // ---- painted hair: stubble, shaved scalp, eyebrows
  vec3 hairC = uHair;
  float hairDot = smoothstep(0.35, 0.75, h_noise2(vSkinUv * 2600.0 + seed));
  float stub = h_beardCoverage(uBeard.x, f) * uBeard.y;
  c = mix(c, mix(c, hairC * 0.85, 0.75), stub * (0.25 + 0.55 * hairDot));
  rough += stub * 0.15;
  float scalp = h_scalpCoverage(f, uBeard.z) * uLook.w;
  c = mix(c, mix(c, hairC * 0.8, 0.8), scalp * (0.35 + 0.5 * hairDot));
  // Lash line along the lids (darker, softer on men).
  c = mix(c, mix(hairC * 0.5, vec3(0.06, 0.04, 0.035), 0.6), lidLine * (0.9 - 0.25 * male));
  vec2 brow = h_brow(f, uBrow);
  if (brow.x > 0.001) {
    float strokes = h_noise2(vec2(brow.y * 140.0 + f.y * 60.0 * sign(f.x), (f.y - 0.2) * 420.0 + seed * 9.0));
    float bm = brow.x * (0.5 + 0.5 * smoothstep(0.3, 0.7, strokes + 0.2 * uBrow.w)) * uBrow.w * 0.92;
    c = mix(c, mix(hairC * 0.5, vec3(0.08, 0.055, 0.04), 0.4), clamp(bm, 0.0, 1.0));
    height += bm * 0.00012;
    rough += bm * 0.1;
  }

  // ---- race pattern (3D bind space, seamless)
  float pid = uPattern.x, ps = uPattern.y;
  vec3 acc = uAccent;
  float faceZone = smoothstep(-0.6, 0.0, f.z) * (1.0 - smoothstep(1.8, 2.2, f.y)) * step(-2.6, f.y);
  if (pid > 0.5 && ps > 0.0) {
    if (pid < 1.5) {
      // Freckles: dense on face & shoulders.
      vec3 v = h_voronoi3(vBind * 260.0 + seed * 13.0);
      float zone = max(faceZone * smoothstep(-0.6, 0.2, f.y) * (1.0 - smoothstep(0.8, 1.5, f.y)), smoothstep(1.1, 1.5, vBind.y / max(0.2, uLook.z + 1.0)) * 0.0);
      zone = max(zone, smoothstep(0.55, 0.8, h_noise3(vBind * 3.0)) * 0.6);
      float fr = (1.0 - smoothstep(0.12, 0.3, v.x)) * step(0.45, v.z) * zone;
      c = mix(c, c * vec3(0.78, 0.6, 0.48), fr * ps);
    } else if (pid < 2.5) {
      // Scales: Voronoi plates, finer on the face, absent on palms/lips.
      float sc = mix(48.0, 95.0, faceZone);
      vec3 v = h_voronoi3(vBind * sc + seed * 5.0);
      // Fade plate edges once a cell spans only a few pixels (no shimmering at distance).
      float aa = 1.0 - smoothstep(0.08, 0.35, length(fwidth(vBind * sc)));
      float edge = mix(0.75, smoothstep(0.0, 0.18, v.y - v.x), aa);
      float dome = (1.0 - v.x) * aa;
      float mask = ps * (1.0 - lips) * (1.0 - nails);
      vec3 plate = mix(acc, c, 0.45 + 0.45 * mix(0.5, v.z, aa));
      float belly = smoothstep(0.0, -0.06, vBind.z) * smoothstep(0.6, 1.2, vBind.y) * (1.0 - smoothstep(1.35, 1.5, vBind.y)) * (1.0 - faceZone);
      plate = mix(plate, mix(c, acc, 0.5) * 1.15, belly * 0.6);
      c = mix(c, mix(plate * 0.55, plate, edge), mask);
      height += mask * (dome * 0.0009 + edge * 0.0004);
      rough = mix(rough, 0.32 + 0.2 * v.z, mask);
    } else if (pid < 3.5) {
      // Bark: vertical ridged furrows warped by noise; moss in the grooves.
      vec3 q = vBind * vec3(28.0, 6.0, 28.0) + seed * 3.0;
      float warp = h_fbm3(q * 0.5) * 2.0;
      float ridge = abs(sin((vBind.x * 70.0 + vBind.z * 55.0) + warp * 3.0 + h_noise3(q) * 2.0));
      float groove = 1.0 - smoothstep(0.0, 0.35, ridge);
      float m = ps * (1.0 - faceZone * 0.55) * (1.0 - lips);
      float knots = smoothstep(0.75, 0.9, h_noise3(vBind * 12.0 + 4.0));
      c = mix(c, acc, m * max(groove * 0.85, knots * 0.5));
      float moss = smoothstep(0.55, 0.75, h_fbm3(vBind * 9.0 + 9.0)) * groove;
      c = mix(c, vec3(0.13, 0.2, 0.06), m * moss * 0.6);
      height += m * (ridge * 0.0016 - knots * 0.001);
      rough = mix(rough, 0.82, m);
    } else if (pid < 4.5) {
      // Spots: irregular blotches (orc/goblin/giantkin).
      float n = h_fbm3(vBind * 7.0 + seed * 11.0);
      float sp = smoothstep(0.55, 0.62, n);
      c = mix(c, mix(c, acc, 0.75), sp * ps * (1.0 - lips));
    } else if (pid < 5.5) {
      // Tattoos: crisp tribal bands on arms, shoulders, face sides.
      float bands = abs(sin(vBind.y * 34.0 + h_fbm3(vBind * 5.0 + seed) * 6.0));
      float zone = smoothstep(0.35, 0.6, h_noise3(vBind * 2.2 + seed * 2.0)) * (1.0 - lips);
      float ink = (1.0 - smoothstep(0.15, 0.22, bands)) * zone;
      c = mix(c, c * mix(vec3(0.18, 0.22, 0.32), acc * 0.6, 0.3), ink * ps);
    } else if (pid < 6.5) {
      // Veins: branching glowing lines.
      float v1 = abs(h_fbm3(vBind * 14.0 + seed) - 0.5);
      float v2 = abs(h_fbm3(vBind * 31.0 + seed * 2.0) - 0.5);
      float vein = (1.0 - smoothstep(0.0, 0.025, v1)) + 0.5 * (1.0 - smoothstep(0.0, 0.018, v2));
      vein *= ps * (1.0 - lips) * (0.6 + 0.4 * (1.0 - faceZone * 0.5));
      c = mix(c, acc * 0.7, clamp(vein, 0.0, 1.0) * 0.7);
      emit += acc * vein * uPattern.w * 0.8;
      height += vein * 0.0002;
    } else if (pid < 7.5) {
      // Stripes: warped bands around the body.
      float s = sin(vBind.y * 26.0 + h_fbm3(vBind * 4.0 + seed) * 7.0 + vBind.x * 4.0);
      float st = smoothstep(0.55, 0.75, s) * smoothstep(0.3, 0.6, h_noise3(vBind * 3.0 + 2.0));
      c = mix(c, acc, st * ps * (1.0 - lips) * (1.0 - faceZone * 0.4));
    } else {
      // Crystals: faceted mineral patches with glints.
      vec3 v = h_voronoi3(vBind * 60.0 + seed * 3.0);
      float patchM = smoothstep(0.58, 0.68, h_fbm3(vBind * 5.0 + seed * 8.0)) * ps * (1.0 - lips);
      float facet = 0.6 + 0.4 * v.z;
      c = mix(c, acc * facet, patchM);
      height += patchM * (0.0012 * (1.0 - v.x) + 0.0006 * v.z);
      rough = mix(rough, 0.18, patchM);
      emit += acc * patchM * uPattern.w * 0.3;
    }
  }

  // ---- marks: scars, warpaint, face tattoo, freckle patch (face coordinates)
  float side = (fract(seed * 7.13) < 0.5) ? -1.0 : 1.0;
  vec2 fp = vec2(f.x * side, f.y);
  if (uMarks > 0.5) {
    float scar = 0.0;
    if (h_bit(uMarks, 0.0) > 0.5) scar = max(scar, 1.0 - smoothstep(0.012, 0.035, h_seg(fp, vec2(0.55, -0.35), vec2(1.0, -1.15))));
    if (h_bit(uMarks, 1.0) > 0.5) scar = max(scar, 1.0 - smoothstep(0.012, 0.03, h_seg(fp, vec2(0.62, 0.75), vec2(0.5, 0.2))));
    if (h_bit(uMarks, 2.0) > 0.5) scar = max(scar, 1.0 - smoothstep(0.01, 0.025, h_seg(fp, vec2(0.12, -0.95), vec2(0.2, -1.35))));
    if (h_bit(uMarks, 3.0) > 0.5) scar = max(scar, (1.0 - smoothstep(0.012, 0.03, h_seg(fp, vec2(0.45, 0.75), vec2(0.58, -0.55)))) * smoothstep(0.08, 0.16, length(fp - vec2(0.5, 0.0))));
    if (h_bit(uMarks, 4.0) > 0.5) scar = max(scar, 1.0 - smoothstep(0.012, 0.03, h_seg(fp, vec2(-0.15, -1.75), vec2(0.25, -1.95))));
    scar *= smoothstep(-0.7, -0.3, f.z);
    c = mix(c, c * vec3(1.12, 0.92, 0.92) + 0.03, scar * 0.85);
    height += scar * 0.0006;
    rough -= scar * 0.12;
    if (h_bit(uMarks, 5.0) > 0.5) {
      // Face tattoo: curling lines on one side of the face.
      // Bold curved bands sweeping from the temple down over the cheekbone, plus chin lines.
      vec2 q = fp - vec2(1.25, 0.35);
      float r = length(q);
      float ang = atan(q.y, q.x);
      float arcs = abs(fract(r * 4.2 + 0.08 * sin(ang * 3.0)) - 0.5);
      float sweep = smoothstep(-2.9, -2.5, ang) * (1.0 - smoothstep(-1.75, -1.45, ang));
      float ink = (1.0 - smoothstep(0.12, 0.2, arcs)) * sweep * smoothstep(0.35, 0.45, r) * (1.0 - smoothstep(0.95, 1.05, r));
      float chinL = (1.0 - smoothstep(0.02, 0.035, abs(fract(f.x * 3.0 + 0.5) - 0.5) * 0.33)) * smoothstep(-1.55, -1.5, f.y) * (1.0 - smoothstep(-1.95, -1.9, f.y)) * (1.0 - smoothstep(0.35, 0.4, abs(f.x)));
      ink = max(ink, chinL);
      ink *= smoothstep(-0.5, -0.2, f.z) * (1.0 - lips);
      c = mix(c, c * vec3(0.15, 0.2, 0.32), ink * 0.85);
    }
    if (h_bit(uMarks, 6.0) > 0.5) {
      // Warpaint stripes: three diagonal bars across the cheeks.
      float bars = step(0.5, fract((f.y * 1.6 - abs(f.x) * 0.8) * 3.0)) * smoothstep(0.25, 0.4, abs(f.x)) * (1.0 - smoothstep(1.0, 1.15, abs(f.x)));
      bars *= smoothstep(-0.95, -0.85, f.y) * (1.0 - smoothstep(-0.15, -0.05, f.y)) * smoothstep(-0.6, -0.3, f.z);
      c = mix(c, uAccent * 0.35 + vec3(0.25, 0.02, 0.02), bars * 0.85);
    }
    if (h_bit(uMarks, 7.0) > 0.5) {
      // Warpaint mask band across the eyes.
      float band = (1.0 - smoothstep(0.18, 0.24, abs(f.y + 0.02))) * (1.0 - smoothstep(1.05, 1.2, abs(f.x))) * smoothstep(-0.7, -0.4, f.z);
      c = mix(c, vec3(0.02, 0.02, 0.025), band * 0.9);
    }
    if (h_bit(uMarks, 8.0) > 0.5) {
      vec3 v = h_voronoi3(vBind * 300.0 + seed * 13.0);
      float zone = (1.0 - smoothstep(0.6, 1.0, length(vec2(f.x, (f.y + 0.45) * 1.6)))) * smoothstep(-0.4, -0.1, f.z);
      c = mix(c, c * vec3(0.75, 0.58, 0.46), (1.0 - smoothstep(0.1, 0.28, v.x)) * step(0.35, v.z) * zone);
    }
  }

  // ---- a hero's eye mask (worn, not a mark: the equipment sets it): matte cloth over brows and
  // lids, a raised edge.
  if (uMask.x > 0.5) {
    float em = h_eyeMask(f);
    if (uMask.x > 1.5) em = max(em, (1.0 - smoothstep(1.25, 1.35, length(vec2((abs(f.x) - 0.5) / 0.33, (f.y + 0.01) / 0.22)))) * smoothstep(-0.75, -0.5, f.z));
    c = mix(c, uMask.yzw * (0.92 + 0.16 * midN), em);
    rough = mix(rough, 0.5, em);
    height += em * 0.0007;
  }

  sk_thin = ears * 0.9 + nose * 0.25 + lips * 0.2;
  sk_albedo = c;
  sk_rough = clamp(rough, 0.18, 0.9);
  sk_height = height;
  sk_emit = emit;
}
`;

/** Per-channel wrap lighting + back translucency replacing the diffuse term of RE_Direct_Physical. */
function sssChunk(): string {
  let chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
  const target = 'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );';
  if (!chunk.includes(target)) {
    console.warn('humanoid skin: SSS patch target not found; using plain lambert');
    return chunk;
  }
  chunk = chunk.replace(
    target,
    /* glsl */ `{
      float nlRaw = dot( geometryNormal, directLight.direction );
      vec3 wrapK = vec3( 0.55, 0.24, 0.15 );
      vec3 wrapped = clamp( ( vec3( nlRaw ) + wrapK ) / ( 1.0 + wrapK ), 0.0, 1.0 );
      wrapped *= wrapped;
      vec3 sssIrr = wrapped * directLight.color;
      float back = pow( saturate( dot( geometryViewDir, -directLight.direction ) ), 3.0 ) * sk_thin;
      sssIrr += directLight.color * vec3( 0.9, 0.25, 0.12 ) * back * 0.6;
      reflectedLight.directDiffuse += sssIrr * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
    }`,
  );
  return chunk;
}

let sssCache: string | null = null;

/** Create the skin material for one character. */
export function createSkinMaterial(opts: { expr: boolean; exprTex: THREE.Texture | null; exprUnits: number; lod: number }): SkinMaterialHandle {
  const material = new THREE.MeshPhysicalMaterial({
    roughness: 0.5,
    metalness: 0,
    ior: 1.4,
    specularIntensity: 0.45,
    sheen: 0.18,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color(0.32, 0.26, 0.24),
  });
  const uniforms: SkinUniforms = {
    uTone: { value: new THREE.Color(0.7, 0.5, 0.4) },
    uAccent: { value: new THREE.Color(0.3, 0.2, 0.15) },
    uHair: { value: new THREE.Color(0.1, 0.07, 0.05) },
    uPattern: { value: new THREE.Vector4() },
    uLook: { value: new THREE.Vector4() },
    uBrow: { value: new THREE.Vector4() },
    uBeard: { value: new THREE.Vector4(-1, 0, 0, 0) },
    uMarks: { value: 0 },
    uExprW: { value: new Float32Array(Math.max(1, opts.exprUnits)) },
    uExprTex: { value: opts.exprTex },
    uFaceScale: { value: 1 },
    uPores: { value: poreTexture() },
    uHide: { value: 0 },
    uMask: { value: new THREE.Vector4() },
  };
  uniforms.sheenTarget = material.sheenColor;
  material.defines = { EXPR_UNITS: Math.max(1, opts.exprUnits) };
  if (opts.expr) material.defines.SKIN_EXPR = '';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + SKIN_VERT_HEAD)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + SKIN_VERT_BODY);
    sssCache ??= sssChunk();
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + SKIN_FRAG_HEAD)
      .replace('#include <lights_physical_pars_fragment>', sssCache)
      .replace('#include <color_fragment>', '#include <color_fragment>\nskinEval();\ndiffuseColor.rgb = sk_albedo;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = sk_rough;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = h_bumpNormal( -vViewPosition, normal, sk_height * 1.0, faceDirection );')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += sk_emit;');
  };
  material.customProgramCacheKey = () => `norgo-skin-${opts.expr ? 1 : 0}-${opts.exprUnits}`;
  // Sky occlusion chains with the hook above.
  const sky = patchSkyOcclusion(material, 'uniform');
  return { material, uniforms, sky };
}

const lin = (c: [number, number, number]) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);

/** Push an appearance into the skin uniforms. */
export function applySkinLook(u: SkinUniforms, a: HumanoidAppearance, opts: { shavedScalp: number; hairCovered: boolean }) {
  u.uTone.value.copy(lin(a.skinTone));
  // Peach-fuzz sheen tinted by the skin itself (a grey sheen reads as plastic).
  if (u.sheenTarget) u.sheenTarget.copy(lin(a.skinTone)).multiplyScalar(0.55);
  u.uAccent.value.copy(lin(a.skinAccent));
  u.uHair.value.copy(lin(a.hairColor));
  const seed = ((a.seed >>> 0) % 9973) / 9973;
  const glow = a.skinPattern === 'veins' ? 0.6 + a.eyeGlow * 0.6 : a.skinPattern === 'crystals' ? 0.4 : 0;
  u.uPattern.value.set(PATTERN_IDS[a.skinPattern] ?? 0, a.patternStrength, seed, glow);
  const blush = (1 - a.gender) * 0.35 + (a.age < 0.45 ? 0.2 : 0);
  u.uLook.value.set(a.age, a.gender, blush, opts.shavedScalp);
  const bp = BROW_PARAMS[a.browStyle] ?? BROW_PARAMS.normal;
  // Elders: thinner, sparser brows; males slightly thicker.
  const thick = bp[0] * (0.9 + a.gender * 0.2) * (a.age > 0.75 ? 0.85 : 1);
  u.uBrow.value.set(thick, bp[1], bp[2], bp[3]);
  const beardId = BEARD_IDS[a.beardStyle] ?? -1;
  // Stubble density: stubble style dense shadow, full beards get a dark base under the cards.
  const dens = a.beardStyle === 'none' ? 0 : a.beardStyle === 'stubble' ? 0.75 : 0.95;
  const recede = a.gender > 0.5 ? Math.max(0, a.age - 0.6) * 1.6 : 0;
  const lipTint = a.race === 'umbral' ? 0.35 : a.race === 'drakeborn' ? 0.3 : 0;
  u.uBeard.value.set(beardId, dens, recede, lipTint);
  let bits = 0;
  for (const m of a.marks) {
    const i = MARK_IDS.indexOf(m);
    if (i === 6 + 0 && m === 'warpaint_stripes') bits |= 1 << 6;
    else if (m === 'warpaint_mask') bits |= 1 << 7;
    else if (m === 'freckle_patch') bits |= 1 << 8;
    else if (m === 'tattoo_face') bits |= 1 << 5;
    else if (i >= 0 && i < 5) bits |= 1 << i;
  }
  u.uMarks.value = bits;
}
