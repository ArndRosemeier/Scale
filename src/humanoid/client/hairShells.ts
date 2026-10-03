/**
 * Fur-shell hair: several skinned copies of the scalp / beard region of the
 * body, pushed out along the normal in the vertex shader, each alpha-tested
 * against a strand pattern that thins out with height. Gives dense, soft
 * coverage for short hair, buzz cuts, short beards and the base layer under
 * hair cards (no scalp shining through partings), at a cost of a few
 * hundred triangles per layer. Shares the body's vertex buffers; only the
 * index subset is per character.
 */
import * as THREE from 'three';
import { patchSkyOcclusion, type SkyVisPatch } from '../../render/skyOcclusion';
import { GLSL_NOISE } from './glsl';
import { GLSL_FACE, beardCoverage, scalpCoverage, BEARD_IDS } from './faceRegions';
import type { HumanStatic } from './staticData';

export interface ShellSpec {
  kind: 'scalp' | 'beard';
  /** Total thickness (m). */
  length: number;
  layers: number;
  /** Strand density 0..1. */
  density: number;
  /** Comb direction strength (strands lean with the surface "down/back"). */
  recede: number;
  beardStyle: number;
  /** Restrict scalp coverage to a band (mohawk/topknot/undercut) via face x/y limits. */
  maxAbsX?: number;
  minY?: number;
}

const FRAG = /* glsl */ `
uniform vec3 hsColor;
uniform vec4 hsParams; // layer 0..1, density, kind (0 scalp / 1 beard), beard style
uniform vec4 hsLimits; // recede, maxAbsX, minY, unused
varying vec3 vHsFace;
varying vec2 vHsUv;
${GLSL_NOISE}
${GLSL_FACE}
`;

/** Triangle subset of the body covered by the region (at least one vertex with coverage). */
export function shellIndex(st: HumanStatic, spec: ShellSpec): Uint16Array {
  const face = st.face.array as Float32Array;
  const body = st.index.body;
  const cov = (v: number) => {
    const x = face[v * 3], y = face[v * 3 + 1], z = face[v * 3 + 2];
    if (spec.kind === 'beard') return beardCoverage(spec.beardStyle, x, y, z);
    let c = scalpCoverage(x, y, z, spec.recede);
    if (spec.maxAbsX !== undefined && Math.abs(x) > spec.maxAbsX) c = 0;
    if (spec.minY !== undefined && y < spec.minY) c = 0;
    return c;
  };
  const keep: number[] = [];
  for (let i = 0; i < body.length; i += 3) {
    if (cov(body[i]) > 0.05 || cov(body[i + 1]) > 0.05 || cov(body[i + 2]) > 0.05) keep.push(body[i], body[i + 1], body[i + 2]);
  }
  return Uint16Array.from(keep);
}

export interface ShellLayerHandle {
  material: THREE.MeshPhysicalMaterial;
  sky: SkyVisPatch;
}

/**
 * One shell layer. Layers are alpha-blended (soft, no alpha-test sparkle) and
 * use a low-frequency, anti-aliased streak pattern running with the hair flow
 * (face-coordinate space), fading to its mean once streaks get sub-pixel, so
 * the coat reads as coherent hair at any distance. Roots are darker (self
 * shadowing); a sheen lobe gives the soft anisotropic-looking rim highlight.
 */
export function createShellMaterial(spec: ShellSpec, layer: number, color: THREE.Color): ShellLayerHandle {
  const t = (layer + 1) / spec.layers;
  const material = new THREE.MeshPhysicalMaterial({
    roughness: 0.62, metalness: 0, specularIntensity: 0.25, envMapIntensity: 0.15,
    sheen: 0.35, sheenRoughness: 0.4, sheenColor: color.clone().multiplyScalar(0.8),
    transparent: true, depthWrite: false,
  });
  const uniforms = {
    hsColor: { value: color.clone() },
    hsParams: { value: new THREE.Vector4(t, spec.density, spec.kind === 'beard' ? 1 : 0, spec.beardStyle) },
    hsLimits: { value: new THREE.Vector4(spec.recede, spec.maxAbsX ?? 99, spec.minY ?? -99, 0) },
    hsOffset: { value: spec.length * t },
  };
  material.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aFace;\nuniform float hsOffset;\nvarying vec3 vHsFace;\nvarying vec2 vHsUv;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        // Strands lean downward/backward with height (combed), lifting off the surface.
        transformed += normal * hsOffset + vec3(0.0, -1.0, 0.6) * hsOffset * 0.35;
        vHsFace = aFace;
        vHsUv = uv;`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float cov = hsParams.z > 0.5 ? h_beardCoverage(hsParams.w, vHsFace) : h_scalpCoverage(vHsFace, hsLimits.x);
        if (abs(vHsFace.x) > hsLimits.y || vHsFace.y < hsLimits.z) cov = 0.0;
        // Streaks along the flow (narrow across, long along), anti-aliased toward their mean.
        vec2 q = vec2(vHsFace.x * 46.0 + vHsFace.z * 26.0, vHsFace.y * 7.0 - vHsFace.z * 4.0);
        float n = h_noise2(q) * 0.65 + h_noise2(q * vec2(2.1, 1.6) + 7.3) * 0.35;
        float aa = 1.0 - smoothstep(0.3, 1.2, length(fwidth(q)));
        n = mix(0.5, n, aa);
        float lay = hsParams.x;
        float alpha = cov * clamp((n + 0.62 - lay * 0.9) * 2.4, 0.0, 1.0) * mix(1.0, 0.75, lay) * (0.55 + 0.45 * hsParams.y);
        if (alpha < 0.01) discard;
        diffuseColor.a *= alpha;
        // Darker roots (self-shadowing inside the coat), lighter, varied tips.
        diffuseColor.rgb = hsColor * mix(0.45, 1.05, lay) * (0.82 + 0.36 * n);`);
  };
  material.customProgramCacheKey = () => 'norgo-hairshell-2';
  const sky = patchSkyOcclusion(material, 'uniform');
  return { material, sky };
}

/** Shell settings for a hair style / beard style (null = none). */
export function scalpShellFor(style: string, recede: number): ShellSpec | null {
  const base = { kind: 'scalp' as const, layers: 6, density: 0.95, recede, beardStyle: 0 };
  switch (style) {
    case 'bald': case 'crest': case 'leaves': return null;
    case 'shaved': return { ...base, length: 0.0015, layers: 3, density: 0.8 };
    case 'buzz': return { ...base, length: 0.004, layers: 4 };
    case 'crop': return { ...base, length: 0.007 };
    case 'mohawk': return { ...base, length: 0.004, layers: 4, maxAbsX: 0.3 };
    case 'topknot': return { ...base, length: 0.005, minY: 1.2 };
    case 'tonsure': return { ...base, length: 0.006 };
    case 'undercut': return { ...base, length: 0.003, layers: 3 };
    default: return { ...base, length: 0.006 };
  }
}

export function beardShellFor(style: string): ShellSpec | null {
  if (style === 'none' || style === 'stubble') return null;
  const id = BEARD_IDS[style] ?? 0;
  const len = style === 'short' || style === 'chinstrap' || style === 'goatee' || style === 'mustache' || style === 'mutton' ? 0.008 : 0.006;
  return { kind: 'beard', length: len, layers: 6, density: 0.92, recede: 0, beardStyle: id };
}
