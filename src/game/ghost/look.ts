/**
 * How the ghost looks: an Actors character (bones and clips untouched) in an old-fashioned long
 * coat with mutton chops, a lantern with a cold green flame, and every material of the rig turned
 * see-through and glowing at the edges (`ghostify`; TSL twin: render/webgpu/ghost.ts).
 *
 * The rig's materials are its own (as with the hero statue's bronze), so they are changed in place.
 * The ghost variants are new shaders: the caller compiles them in the background (shaderCap.slot +
 * compileAsync) before the ghost is shown.
 */
import * as THREE from 'three';
import { randomAppearance } from '../../humanoid/appearance';
import type { HumanoidAppearance } from '../../humanoid/types';
import type { EquipmentVisuals, ItemVisual } from '../../items/types';
import { WEBGPU, gpuKit } from '../../render/gpuMode';

type C3 = [number, number, number];

/** The ghost's colour (linear): what the lit colour turns into, and the rim glow. */
export const GHOST_TINT = new THREE.Color(0.62, 0.8, 0.86);
export const GHOST_GLOW = new THREE.Color(0.35, 0.75, 0.7);
/** Alpha in the middle of a surface and the extra at the silhouette. */
const BASE_A = 0.34, RIM_A = 0.5;
/** The lantern's flame (sRGB). */
export const LANTERN_GLOW: C3 = [0.45, 1.0, 0.8];

const v = (seed: number, primary: C3, secondary: C3 = primary, material = 'plain'): ItemVisual =>
  ({ shape: 'cloth', seed, primary, secondary, accent: secondary, material, glow: 0, glowColor: [0, 0, 0], wear: 0.3, style: '' });

/** A gentleman of the 1880s: tall, lean, mutton chops, pale as a sheet. */
export function ghostAppearance(seed: number): HumanoidAppearance {
  const app = randomAppearance('human', seed, { gender: 1, age: 0.6 });
  app.height = 0.78;
  app.weight = 0.3;
  app.beardStyle = 'mutton';
  app.skinTone = [0.84, 0.88, 0.9];
  app.skinAccent = [0.8, 0.84, 0.88];
  app.skinPattern = 'none';
  app.hairColor = [0.88, 0.9, 0.92];
  app.eyeColor = [0.55, 0.8, 0.78];
  return app;
}

/** Long coat, waistcoat-coloured shirt, narrow trousers, boots; the lantern in hand. */
export function ghostOutfit(seed: number): EquipmentVisuals {
  return {
    chest: { defId: 'shirt', visual: v(seed + 1, [0.86, 0.86, 0.82]) },
    back: { defId: 'coat', visual: v(seed + 2, [0.28, 0.3, 0.34], [0.2, 0.22, 0.25]) },
    legs: { defId: 'trousers', visual: v(seed + 3, [0.34, 0.33, 0.36], [0.3, 0.3, 0.32], 'stripes') },
    feet: { defId: 'boots', visual: v(seed + 4, [0.16, 0.15, 0.15]) },
    mainhand: { defId: 'lantern', visual: { shape: 'lantern', seed: seed + 5, primary: LANTERN_GLOW, secondary: LANTERN_GLOW, accent: LANTERN_GLOW, material: 'plain', glow: 1, glowColor: LANTERN_GLOW, wear: 0, style: '' } },
  };
}

/** The ghost's fade, 0 (gone) … 1, shared by all its materials (GLSL and TSL). */
const FADE = { value: 1 };
/** Glowing parts that only go see-through (no shader patch): faded by their opacity. */
const plain = new Set<THREE.Material>();
const PLAIN_A = Math.min(1, BASE_A + RIM_A * 0.6);
export function setGhostFade(f: number): void {
  FADE.value = f;
  for (const m of plain) m.opacity = PLAIN_A * f;
  if (WEBGPU) gpuKit().setGhostFadeNode(f);
}

const ghosted = new WeakSet<THREE.Material>();

/**
 * Every material under `root` becomes ghostly (once each); meshes stop casting shadows. Returns how
 * many materials were changed (0: nothing new).
 */
export function ghostify(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = false;
    // (The crowd renderer's shadow switch would put a rig's shadow back; this rig is not the crowd's.)
    mesh.userData.castShadow = false;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (ghosted.has(m)) continue;
      ghosted.add(m);
      n++;
      // (A glowing part, the lantern's glass: keeps its own colour, only goes see-through, so
      // its flame stays green on both renderers.)
      const e = m as THREE.MeshStandardMaterial;
      if (e.emissive && e.emissiveIntensity >= 1 && e.emissive.getHex() !== 0) {
        m.transparent = true;
        m.opacity = PLAIN_A * FADE.value;
        m.needsUpdate = true;
        plain.add(m);
        continue;
      }
      if (WEBGPU) { gpuKit().ghostNodeMaterial(m, GHOST_TINT, GHOST_GLOW, BASE_A, RIM_A); continue; }
      patchGlsl(m);
    }
  });
  return n;
}

function patchGlsl(m: THREE.Material): void {
  m.transparent = true;
  m.depthWrite = true;
  const std = m as THREE.MeshStandardMaterial;
  if (!std.isMeshStandardMaterial) {
    m.opacity = BASE_A;
    m.needsUpdate = true;
    return;
  }
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey.bind(m);
  const T = GHOST_TINT, G = GHOST_GLOW, f = (x: number) => x.toFixed(3);
  m.onBeforeCompile = (s, r) => {
    prev.call(m, s, r);
    s.uniforms.uGhostFade = FADE;
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGhostFade;')
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
      {
        // (Ghost: the lit colour as a pale glow, brightest and most solid at the silhouette.)
        float gRim = pow(1.0 - clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0), 2.2);
        float gLum = dot(gl_FragColor.rgb, vec3(0.3, 0.55, 0.15));
        gl_FragColor.rgb = mix(vec3(${f(T.r)}, ${f(T.g)}, ${f(T.b)}) * (gLum * 1.4 + 0.12), gl_FragColor.rgb, 0.18) + vec3(${f(G.r)}, ${f(G.g)}, ${f(G.b)}) * gRim * 0.9;
        gl_FragColor.a *= clamp(${f(BASE_A)} + gRim * ${f(RIM_A)}, 0.0, 1.0) * uGhostFade;
      }`);
  };
  m.customProgramCacheKey = () => `${prevKey()}|ghost`;
  m.needsUpdate = true;
}
