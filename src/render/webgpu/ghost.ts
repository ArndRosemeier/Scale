// @ts-nocheck -- three's TSL typings infer swizzles and vector widths poorly; checked by rendering (docs/WEBGPU_PLAN.md).
/**
 * The ghost look (game/ghost/look.ts `ghostify`) for node materials: TSL twin of its GLSL patch.
 * Every material keeps its own shader (folds, normal maps, hair strands); its lit colour is turned
 * into a pale blue-green glow that is brightest at the silhouette (a rim), and it becomes
 * see-through: alpha = rim-weighted × the shared fade (0 gone … 1 fully there). Cut-outs (hair
 * cards, garment edges) keep their own alpha test, which runs before this.
 */
import * as THREE from 'three/webgpu';
import { abs, clamp, dot, float, mix, normalize, normalView, positionViewDirection, pow, uniform, vec3, vec4 } from 'three/tsl';

/** One fade for all ghost materials (there is one ghost at a time). */
const fade = uniform(1);

export function setGhostFadeNode(v: number): void {
  fade.value = v;
}

export function ghostNodeMaterial(m: THREE.Material, tint: THREE.Color, glow: THREE.Color, base: number, rimA: number): void {
  const n = m as THREE.NodeMaterial;
  if (!n.isNodeMaterial) {
    m.transparent = true;
    m.opacity = base;
    m.needsUpdate = true;
    return;
  }
  const T = vec3(tint.r, tint.g, tint.b), G = vec3(glow.r, glow.g, glow.b);
  const out = n.setupOutput;
  n.setupOutput = function (builder, outputNode) {
    const rim = pow(float(1).sub(clamp(abs(dot(normalize(normalView), positionViewDirection)), 0, 1)), 2.2);
    const lum = dot(outputNode.rgb, vec3(0.3, 0.55, 0.15));
    const col = mix(T.mul(lum.mul(1.4).add(0.12)), outputNode.rgb, 0.18).add(G.mul(rim.mul(0.9)));
    const a = outputNode.a.mul(clamp(float(base).add(rim.mul(rimA)), 0, 1)).mul(fade);
    return out.call(this, builder, vec4(col, a));
  };
  const key = n.customProgramCacheKey.bind(n);
  n.customProgramCacheKey = () => `${key()}|ghost`;
  n.transparent = true;
  n.depthWrite = true;
  n.needsUpdate = true;
}
