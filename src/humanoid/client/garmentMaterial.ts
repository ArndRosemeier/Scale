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

const PATTERNS: Record<ShellMaterial['pattern'], number> = {
  plain: 0, stripes: 1, checks: 2, quilted: 3, chainmail: 4, scales: 5, leather: 6, fur: 7, embroidered: 8, patchwork: 9, silk: 10, plates: 11, runes: 12,
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
varying vec3 vGBind;
varying vec3 vGNrm;
varying float vGEdge;
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

void garmentEval() {
  float id = gParams.x;
  float sc = gParams.y;
  vec3 n = normalize(vGNrm);
  vec3 w = pow(abs(n), vec3(4.0));
  w /= (w.x + w.y + w.z);
  vec3 p = vGBind * sc;
  vec4 a = g_pat(p.zy, id) * w.x + g_pat(p.xz, id) * w.y + g_pat(p.xy, id) * w.z;
  vec3 c = mix(gColor, gColor2, clamp(a.x, 0.0, 1.0));
  float big = h_fbm3(vGBind * 6.0 + gParams.w);
  c *= 0.9 + 0.2 * big;
  // Wear: dirt toward the hem, scuffs and fading.
  float wear = gParams.z;
  float dirt = smoothstep(0.9, 0.2, vGBind.y) * wear;
  c = mix(c, c * vec3(0.55, 0.5, 0.42), dirt * 0.6 * smoothstep(0.35, 0.7, h_fbm3(vGBind * 9.0)));
  c = mix(c, c * 1.15 + 0.03, wear * 0.3 * smoothstep(0.6, 0.8, h_noise3(vGBind * 25.0)));
  // Trim along the garment edges.
  float trim = smoothstep(0.35, 0.75, vGEdge);
  c = mix(c, gTrim, trim);
  g_c = c;
  g_h = a.y * (1.0 - trim) + trim * 0.0006;
  g_r = a.z;
  g_m = a.w;
  g_e = a.w < -0.5 ? gGlow * a.x * 3.0 : vec3(0.0);
}
`;

/** Create a garment material for a shell. */
export function createGarmentMaterial(m: ShellMaterial, seed: number, trim?: [number, number, number]): GarmentHandle {
  const lin = (c: [number, number, number]) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
  const metal = m.metalness;
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
  const uniforms = {
    gColor: { value: lin(m.color) },
    gColor2: { value: lin(m.color2) },
    gTrim: { value: lin(trim ?? m.color2) },
    gParams: { value: new THREE.Vector4(PATTERNS[m.pattern] ?? 0, Math.max(0.5, m.patternScale), m.wear, (seed % 997) * 0.37) },
    gGlow: { value: lin(m.glowColor).multiplyScalar(m.glow) },
    gMetal: { value: metal },
  };
  material.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aEdge;\nvarying vec3 vGBind;\nvarying vec3 vGNrm;\nvarying float vGEdge;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGBind = position;\nvGNrm = normal;\nvGEdge = aEdge;');
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
  material.customProgramCacheKey = () => 'norgo-garment';
  const sky = patchSkyOcclusion(material, 'uniform');
  return { material, sky };
}
