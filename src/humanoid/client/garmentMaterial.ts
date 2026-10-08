/**
 * Procedural garment shading for shell layers (ShellMaterial from the items
 * module): plain cloth weave, stripes, checks, quilting, chainmail rings,
 * scales, leather grain, fur, embroidery, patchwork, silk, plates and glowing
 * runes. Patterns are evaluated triplanar in bind-pose space, so they are
 * seamless and stay glued to the body while it animates; relief goes through
 * derivative bump mapping. Edge trims come from a per-vertex boundary
 * attribute. Wear adds dirt, fraying and scuffs.
 */
import * as THREE from 'three';
import { patchSkyOcclusion, type SkyVisPatch } from '../../render/skyOcclusion';
import type { ShellMaterial } from '../../items/wearable';
import { GLSL_NOISE } from './glsl';
import { WEBGPU, gpuKit } from '../../render/gpuMode';
import { GLSL_MASK_CUT } from './faceRegions';

const PATTERNS: Record<ShellMaterial['pattern'], number> = {
  plain: 0, stripes: 1, checks: 2, quilted: 3, chainmail: 4, scales: 5, leather: 6, fur: 7, embroidered: 8, patchwork: 9, silk: 10, plates: 11, runes: 12, bones: 13, hero: 14,
};

export interface GarmentHandle {
  material: THREE.MeshPhysicalMaterial;
  sky: SkyVisPatch;
}

const FRAG = /* glsl */ `
uniform vec3 gColor;
uniform vec3 gColor2;
uniform vec3 gTrim;
uniform vec4 gParams; // pattern id, scale, wear, seed
uniform vec3 gGlow;
uniform float gMetal;
uniform vec4 gFig; // wearer's height (m), hero tights design, a mask's neck hem (bind y = z + w * bind z)
varying vec3 vGBind;
varying vec3 vGNrm;
varying float vGEdge;
#ifdef GARMENT_CUT
varying vec3 vGFace;
${GLSL_MASK_CUT}
#endif
${GLSL_NOISE}
float g_h; vec3 g_c; float g_r; float g_m; vec3 g_e;

// One 2D pattern sample: returns color mix (x), height (y), roughness delta (z), metal (w)
vec4 g_pat(vec2 q, float id) {
  if (id < 0.5) { // plain weave
    float w = sin(q.x * 160.0) * sin(q.y * 160.0);
    return vec4(0.0, w * 0.00008, 0.0, 0.0);
  } else if (id < 1.5) { // stripes
    float s = step(0.5, fract(q.y * 3.0));
    return vec4(s, sin(q.x * 140.0) * 0.00006, 0.0, 0.0);
  } else if (id < 2.5) { // checks / tartan
    vec2 f = step(0.5, fract(q * 3.0));
    float s = abs(f.x - f.y) * 0.7 + step(0.9, fract(q.x * 6.0)) * 0.3;
    return vec4(s, sin((q.x + q.y) * 200.0) * 0.00006, 0.0, 0.0);
  } else if (id < 3.5) { // quilted diamonds
    vec2 d = abs(fract(vec2(q.x + q.y, q.x - q.y) * 3.0) - 0.5);
    float seam = 1.0 - smoothstep(0.0, 0.06, min(d.x, d.y));
    float puff = (0.5 - max(d.x, d.y)) * 0.004;
    return vec4(seam * 0.6, puff - seam * 0.0015, 0.05, 0.0);
  } else if (id < 4.5) { // chainmail rings
    vec2 g = q * 55.0;
    g.x += step(1.0, mod(floor(g.y), 2.0)) * 0.5;
    vec2 f = fract(g) - 0.5;
    float r = length(f);
    float ring = 1.0 - smoothstep(0.05, 0.12, abs(r - 0.33));
    return vec4(0.0, ring * 0.0012 - 0.0006, -0.25 * ring, 1.0);
  } else if (id < 5.5) { // scales
    vec2 g = q * vec2(14.0, 20.0);
    g.x += step(1.0, mod(floor(g.y), 2.0)) * 0.5;
    vec2 f = fract(g) - vec2(0.5, 0.15);
    float d = length(f * vec2(1.0, 0.8));
    float sc = smoothstep(0.62, 0.45, d);
    return vec4(1.0 - sc, sc * 0.0016 * (1.0 - f.y), -0.2, 0.8);
  } else if (id < 6.5) { // leather grain
    float n = h_fbm2(q * 30.0);
    float cr = smoothstep(0.62, 0.7, h_noise2(q * 70.0));
    return vec4(n * 0.35, (n - 0.5) * 0.00045 - cr * 0.0002, -0.05 + cr * 0.1, 0.0);
  } else if (id < 7.5) { // fur
    float f = h_noise2(q * vec2(90.0, 25.0));
    return vec4(f * 0.6, f * 0.0025, 0.3, 0.0);
  } else if (id < 8.5) { // embroidery: vines along bands
    float band = smoothstep(0.08, 0.0, abs(fract(q.y * 1.5) - 0.5) - 0.12);
    float vine = smoothstep(0.03, 0.0, abs(sin(q.x * 12.0) * 0.08 - (fract(q.y * 1.5) - 0.5)));
    return vec4(max(band * 0.25, vine), vine * 0.0004 + sin(q.x * 160.0) * 0.00005, -0.1 * vine, 0.0);
  } else if (id < 9.5) { // patchwork
    vec3 v = h_voronoi2(q * 3.0);
    float seam = 1.0 - smoothstep(0.0, 0.05, v.y - v.x);
    return vec4(v.z, -seam * 0.0008 + sin(q.x * 150.0) * 0.00005, seam * 0.1, 0.0);
  } else if (id < 10.5) { // silk sheen
    return vec4(0.5 + 0.5 * sin(q.y * 6.0 + h_noise2(q * 2.0) * 3.0), 0.0, -0.3, 0.0);
  } else if (id < 11.5) { // plates
    float row = fract(q.y * 5.0);
    float edge = smoothstep(0.9, 1.0, row);
    float rivet = smoothstep(0.035, 0.0, length(vec2(fract(q.x * 6.0) - 0.5, row - 0.85) * vec2(1.0, 3.0)));
    return vec4(edge * 0.4, (1.0 - row) * 0.002 + rivet * 0.001, -0.3, 1.0);
  }
  // runes: dark cloth with glowing glyph rows
  vec2 cell = floor(q * vec2(9.0, 4.0));
  vec2 f = fract(q * vec2(9.0, 4.0));
  float h = h_hash12(cell);
  float glyph = step(0.5, h_hash12(floor(f * 3.0) + cell * 3.0)) * step(0.2, f.x) * step(f.x, 0.8) * step(0.2, f.y) * step(f.y, 0.8);
  float rowMask = step(0.6, fract(cell.y * 0.5 + 0.25));
  return vec4(glyph * rowMask, glyph * rowMask * 0.0002, 0.0, -1.0);
}

float h_seg2(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
// Five-pointed star, signed distance (negative inside); r outer radius, rf inner ratio.
float h_star5(vec2 p, float r, float rf) {
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}

void garmentEval() {
  float edge = vGEdge;
#ifdef GARMENT_CUT
  // A mask's openings, cut clean per pixel (the shell reaches a little past them), with a hem.
  float md = h_maskDepth(GARMENT_CUT, vGFace);
  float hem = (vGBind.y - gFig.z - gFig.w * vGBind.z) / 0.012;
  if (md < 0.0 || hem < 0.0) discard;
  edge = max(edge, 1.0 - smoothstep(0.05, 0.12, min(md, hem)));
#endif
  float id = gParams.x;
  float sc = gParams.y;
  vec3 n = normalize(vGNrm);
  vec3 w = pow(abs(n), vec3(4.0));
  w /= (w.x + w.y + w.z);
  vec3 p = vGBind * sc;
  vec4 a = g_pat(p.zy, id) * w.x + g_pat(p.xz, id) * w.y + g_pat(p.xy, id) * w.z;
  vec3 heroBelt = vec3(-1.0);
  if (id > 13.5) {
    // Hero tights: fine knit, and the design laid out on the body by the wearer's height (bind
    // pose, metres, feet at 0, facing -Z): 1 an emblem disc with a star on the chest, 2 a
    // lightning bolt, 3 a chevron across the chest and back, 4 stripes down the sides, 5 trunks
    // and a belt over the tights.
    vec3 b = vGBind;
    float H = gFig.x, d = gFig.y, ax = abs(b.x);
    float front = smoothstep(0.15, 0.45, -n.z);
    vec2 q = vec2(b.x, b.y - 0.725 * H);
    float m = 0.0;
    if (d < 0.5) {
      m = 0.0;
    } else if (d < 1.5) {
      float disc = 1.0 - smoothstep(0.072, 0.077, length(q));
      float star = h_star5(q * vec2(1.0, 1.0) - vec2(0.0, -0.004), 0.056, 0.42);
      m = disc * smoothstep(-0.002, 0.002, star) * front;
    } else if (d < 2.5) {
      // A zigzag: down-left, a sharp kink back right, down-left again to a point (wide at the top).
      float bolt = min(min(h_seg2(q, vec2(0.055, 0.12), vec2(-0.045, 0.012)), h_seg2(q, vec2(-0.045, 0.012), vec2(0.045, -0.012))), h_seg2(q, vec2(0.045, -0.012), vec2(-0.05, -0.125)));
      float w = mix(0.008, 0.018, smoothstep(-0.125, 0.12, q.y));
      m = (1.0 - smoothstep(w - 0.002, w + 0.002, bolt)) * front;
    } else if (d < 3.5) {
      float v = q.y + 0.07 - 0.75 * ax;
      m = smoothstep(-0.003, 0.003, v) * (1.0 - smoothstep(0.042, 0.048, v)) * (1.0 - smoothstep(0.19, 0.2, ax)) * step(0.45 * H, b.y);
    } else if (d < 4.5) {
      m = (1.0 - smoothstep(0.2, 0.28, abs(n.z))) * smoothstep(0.25, 0.45, n.x * sign(b.x));
    } else if (d < 5.5) {
      float waist = 0.575 * H, hem = 0.455 * H + 0.55 * max(ax - 0.04, 0.0);
      m = smoothstep(hem - 0.003, hem + 0.003, b.y) * (1.0 - smoothstep(waist - 0.003, waist + 0.003, b.y)) * (1.0 - smoothstep(0.3, 0.32, ax));
      float belt = smoothstep(waist - 0.003, waist + 0.003, b.y) * (1.0 - smoothstep(waist + 0.034, waist + 0.04, b.y)) * (1.0 - smoothstep(0.3, 0.32, ax));
      if (belt > 0.01) heroBelt = vec3(belt, 0.0, 0.0);
    }
    a = vec4(m, sin(p.x * 320.0) * sin(p.y * 320.0) * 0.00002 + (heroBelt.x > 0.0 ? heroBelt.x * 0.0008 : 0.0), 0.0, 0.0);
  } else if (id > 12.5) {
    // bones: a black suit with the skeleton on it, laid out in the body's own space (metres, feet
    // at 0): ribs and a breastbone, the spine, the pelvis, pale limbs with dark knees and ankles.
    vec3 b = vGBind;
    float ax = abs(b.x), bone = 0.0;
    if (b.y > 1.0 && b.y < 1.42) bone = max(step(0.45, fract((b.y - 1.0) * 12.0)) * step(ax, 0.17), step(ax, 0.022));
    else if (b.y > 0.9 && b.y <= 1.0) bone = step(ax, 0.03) * step(0.45, fract(b.y * 25.0));
    else if (b.y > 0.8 && b.y <= 0.9) bone = step(ax, 0.16) * (1.0 - step(abs(ax - 0.085), 0.03));
    else if (b.y <= 0.8) bone = step(0.025, abs(b.y - 0.5)) * step(0.018, abs(b.y - 0.09));
    if (ax > 0.21 && b.y > 0.9) bone = step(0.02, abs(fract(ax * 3.3) - 0.5));
    a = vec4(bone, bone * 0.0006, 0.1, 0.0);
  }
  vec3 c = mix(gColor, gColor2, clamp(a.x, 0.0, 1.0));
  // A golden belt buckled over the hero's trunks.
  if (heroBelt.x > 0.0) c = mix(c, vec3(0.78, 0.6, 0.16) * (abs(vGBind.x) < 0.035 ? 1.15 : 0.9), heroBelt.x);
  float big = h_fbm3(vGBind * 6.0 + gParams.w);
  c *= 0.9 + 0.2 * big;
  // Wear: dirt toward the hem, scuffs and fading.
  float wear = gParams.z;
  float dirt = smoothstep(0.9, 0.2, vGBind.y) * wear;
  c = mix(c, c * vec3(0.55, 0.5, 0.42), dirt * 0.6 * smoothstep(0.35, 0.7, h_fbm3(vGBind * 9.0)));
  c = mix(c, c * 1.15 + 0.03, wear * 0.3 * smoothstep(0.6, 0.8, h_noise3(vGBind * 25.0)));
  // Trim along the garment edges.
  float trim = smoothstep(0.35, 0.75, edge);
  c = mix(c, gTrim, trim);
#ifdef GARMENT_CUT
  // The inside of a mask, seen past its edge, is in shadow.
  if (!gl_FrontFacing) c *= 0.3;
#endif
  g_c = c;
  g_h = a.y * (1.0 - trim) + trim * (id > 13.5 ? 0.0 : 0.0006);
  g_r = a.z;
  g_m = a.w;
  g_e = a.w < -0.5 ? gGlow * a.x * 3.0 : vec3(0.0);
  // A glowing garment lights its trim most (a villain lieutenant's lit seams).
  g_e += gGlow * trim * 2.5;
}
`;

type GarmentFig = { height: number; design: number; cut?: 'cowl' | 'full'; neckY?: number; neckSlope?: number };

/** The garment's uniforms (shared by the GLSL and the node material). */
function garmentUniforms(m: ShellMaterial, seed: number, trim?: [number, number, number], fig?: GarmentFig) {
  const lin = (c: [number, number, number]) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
  const metal = m.metalness;
  return {
    gColor: { value: lin(m.color) },
    gColor2: { value: lin(m.color2) },
    gTrim: { value: lin(trim ?? m.color2) },
    gParams: { value: new THREE.Vector4(PATTERNS[m.pattern] ?? 0, Math.max(0.5, m.patternScale), m.wear, (seed % 997) * 0.37) },
    gGlow: { value: lin(m.glowColor).multiplyScalar(m.glow) },
    gMetal: { value: metal },
    gFig: { value: new THREE.Vector4(fig?.height ?? 1.75, fig?.design ?? 0, fig?.neckY ?? 0, fig?.neckSlope ?? 0) },
  };
}

/** Create a garment material for a shell. */
export function createGarmentMaterial(m: ShellMaterial, seed: number, trim?: [number, number, number], fig?: GarmentFig): GarmentHandle {
  if (WEBGPU) return gpuKit().createGarmentNodeMaterial(m, garmentUniforms(m, seed, trim, fig)) as unknown as GarmentHandle;
  const lin = (c: [number, number, number]) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
  const material = new THREE.MeshPhysicalMaterial({
    roughness: m.roughness,
    metalness: 0,
    sheen: m.sheen,
    sheenRoughness: 0.6,
    sheenColor: lin(m.color).multiplyScalar(0.6),
    emissive: lin(m.glowColor),
    emissiveIntensity: m.glow * 0.6,
    side: THREE.FrontSide,
  });
  const uniforms = garmentUniforms(m, seed, trim, fig);
  const cut = fig?.cut ? (fig.cut === 'cowl' ? 1 : 2) : 0;
  if (cut) material.defines = { GARMENT_CUT: `${cut}.0` };
  material.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aEdge;\nvarying vec3 vGBind;\nvarying vec3 vGNrm;\nvarying float vGEdge;\n#ifdef GARMENT_CUT\nattribute vec3 aFace;\nvarying vec3 vGFace;\n#endif')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGBind = position;\nvGNrm = normal;\nvGEdge = aEdge;\n#ifdef GARMENT_CUT\nvGFace = aFace;\n#endif');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG)
      .replace('#include <color_fragment>', '#include <color_fragment>\ngarmentEval();\ndiffuseColor.rgb = g_c;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor + g_r, 0.08, 1.0);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = g_m > 0.5 ? gMetal : gMetal * 0.25;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 sx = dFdx( -vViewPosition ), sy = dFdy( -vViewPosition );
          vec3 r1 = cross( sy, normal ), r2 = cross( normal, sx );
          float det = dot( sx, r1 ) * faceDirection;
          normal = normalize( abs( det ) * normal - sign( det ) * ( dFdx( g_h ) * r1 + dFdy( g_h ) * r2 ) );
        }`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += g_e;');
  };
  material.customProgramCacheKey = () => `norgo-garment-${cut}`;
  const sky = patchSkyOcclusion(material, 'uniform');
  return { material, sky };
}
