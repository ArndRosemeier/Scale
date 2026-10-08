// @ts-nocheck -- three's TSL typings infer swizzles and vector widths poorly; checked by rendering (docs/WEBGPU_PLAN.md).
/**
 * The underground's own materials as node materials: the metro carriages (underground/Underground.ts)
 * and the deep realm's cave rock, falls, spores / lift motes and the Heart's crystal
 * (underground/deep/DeepMeshes.ts).
 *
 * Kept line by line close to the GLSL so the two can be compared.
 */
import * as THREE from 'three/webgpu';
import {
  float, vec3, vec4, mix, abs, fract, floor, sin, cos, mod, pow, dot, length, normalize, smoothstep, sub, add, mul,
  attribute, varying, uv, diffuseColor, positionGeometry, positionView, normalViewGeometry, modelViewMatrix, instancedBufferAttribute, screenDPR,
} from 'three/tsl';
import { shared } from './common';
import { setDiffuse } from './ground';

/**
 * Metro carriages: vertex colours, the line's colour (per instance `iLine`) on the stripe pieces
 * (`aStripe`). Was `vColor.rgb = mix(vColor.rgb, iLine, aStripe)` in color_vertex.
 */
export function undergroundTrainNodeMaterial(): THREE.MeshStandardNodeMaterial {
  // (vertex colours applied here, not through vertexColors)
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.35, metalness: 0.5, side: THREE.DoubleSide });
  const vColor = mix(attribute('color', 'vec3'), attribute('iLine', 'vec3'), attribute('aStripe', 'float'));
  setDiffuse(mat, () => diffuseColor.rgb.mul(vColor));
  return mat;
}

/** Deep cave rock: vertex colours, plus the light baked into every vertex (`aGlow`) as emission. */
export function deepCaveNodeMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 });
  const vGlow = attribute('aGlow', 'vec3');
  // totalEmissiveRadiance += vGlow * (diffuseColor.rgb * 0.9 + 0.04);
  mat.emissiveNode = vGlow.mul(diffuseColor.rgb.mul(0.9).add(0.04));
  return mat;
}

/** The falls: additive streaks running down a plane. `u.uT` is the game's `{ value }` object. */
export function deepFallsNodeMaterial(u: { uT: { value: number } }): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false,
  });
  mat.uniforms = u;
  const uT = shared(u.uT);
  const vUv = uv();
  const h = (n) => fract(sin(n).mul(43758.5453));
  const col = floor(vUv.x.mul(40.0));
  const s = fract(vUv.y.mul(3.0).add(uT.mul(add(1.2, h(col).mul(0.8)))).add(h(col.mul(7.0))));
  const streak = smoothstep(0.0, 0.3, s).mul(sub(1.0, smoothstep(0.5, 1.0, s))).toVar();
  const edge = smoothstep(0.0, 0.15, vUv.x).mul(sub(1.0, smoothstep(0.85, 1.0, vUv.x)));
  const a = add(0.12, mul(0.35, streak)).mul(edge).mul(add(0.6, mul(0.4, vUv.y)));
  mat.colorNode = vec4(vec3(0.55, 0.8, 0.95).mul(add(0.8, streak)), a);
  return mat;
}

/**
 * Spores (and, with `liftHeight`, the Lumen lift's rising motes): WebGPU draws points one pixel
 * wide, so the motes are an instanced Sprite (one quad per mote) with a PointsNodeMaterial.
 * `u` holds the `{ value }` objects the game updates (`uT`, `uColor`, `uScale`); the material
 * exposes them as `.uniforms` like the ShaderMaterial did.
 */
export function deepMotesNode(
  P: Float32Array, S: Float32Array,
  u: { uT: { value: number }; uColor: { value: THREE.Color }; uScale: { value: number } },
  liftHeight: number | null,
): THREE.Sprite {
  const mat = new THREE.PointsNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, sizeAttenuation: false,
  });
  mat.alphaToCoverage = false;
  mat.uniforms = u;
  const uT = shared(u.uT), uColor = shared(u.uColor), uScale = shared(u.uScale);
  const n = S.length;
  const position = instancedBufferAttribute(new THREE.InstancedBufferAttribute(P, 3), 'vec3');
  const aSeed = instancedBufferAttribute(new THREE.InstancedBufferAttribute(S, 1), 'float');

  // (plain expressions: assignments outside an Fn have no stack to land on)
  const p0 = vec3(position);
  const py = liftHeight === null
    ? p0.y.add(mod(uT.mul(add(0.15, aSeed.mul(0.25))).add(aSeed.mul(40.0)), 40.0).sub(20.0))
    : mod(p0.y.add(uT.mul(add(3.0, aSeed.mul(3.0)))), liftHeight);
  const p = vec3(p0.x.add(sin(uT.mul(0.3).add(aSeed.mul(30.0))).mul(0.8)), py, p0.z.add(cos(uT.mul(0.27).add(aSeed.mul(17.0))).mul(0.8)));
  mat.positionNode = p;
  const mvz = modelViewMatrix.mul(vec4(p, 1.0)).z.negate();
  const far = liftHeight === null ? 60.0 : 90.0;
  // (smoothstep(far, 10.0, -mv.z) written with its edges in order)
  const vA = varying(add(0.4, mul(0.6, abs(sin(uT.mul(add(0.5, aSeed)).add(aSeed.mul(9.0)))))).mul(sub(1.0, smoothstep(10.0, far, mvz))), 'vA');
  // gl_PointSize is in device pixels; the node material multiplies its size by the pixel ratio.
  mat.sizeNode = uScale.mul(add(0.035, aSeed.mul(0.04))).div(mvz).div(screenDPR);

  const d = length(uv().sub(0.5)).mul(2.0);
  mat.colorNode = uColor;
  mat.opacityNode = sub(1.0, smoothstep(0.2, 1.0, d)).mul(vA);

  const sprite = new THREE.Sprite(mat);
  sprite.count = n;
  return sprite;
}

/** The Heart's crystal (StarFx SHARD_VS / SHARD_FS): `u` holds the game's `uI` and `uT` objects. */
export function deepShardNodeMaterial(u: { uI: { value: number }; uT: { value: number } }): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({ toneMapped: false, fog: false });
  mat.uniforms = u;
  const uI = shared(u.uI), uT = shared(u.uT);
  const N = normalize(normalViewGeometry), V = normalize(positionView.negate());
  const vH = varying(positionGeometry.y, 'vH');
  const fres = pow(sub(1.0, abs(dot(N, V))), 2.0);
  const facet = add(0.5, mul(0.5, dot(N, normalize(vec3(0.4, 0.8, 0.3)))));
  const vein = add(0.5, mul(0.5, sin(vH.mul(14.0).sub(uT.mul(4.0)))));
  const deep = vec3(0.18, 0.08, 0.55), mid = vec3(0.25, 0.75, 1.2), hot = vec3(1.6, 1.5, 1.9);
  const c = mix(deep, mid, facet.mul(0.8).add(vein.mul(0.2))).add(hot.mul(fres));
  mat.colorNode = vec4(c.mul(uI), 1.0);
  return mat;
}
