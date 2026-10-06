// @ts-nocheck -- three's TSL typings infer swizzles and vector widths poorly; checked by rendering (docs/WEBGPU_PLAN.md).
/**
 * Helpers for the ported effect / creature / sign materials: the instance matrix of an
 * InstancedMesh as a node (GLSL `instanceMatrix`), a ShaderMaterial-like node material, and
 * a diffuse multiplier hook.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, mat4, vec4, buffer, instanceIndex, instancedBufferAttribute, instancedDynamicBufferAttribute, OnBeforeObjectUpdate, diffuseColor,
} from 'three/tsl';

const _mats = new WeakMap<object, unknown>();
const _inter = new WeakMap<object, THREE.InstancedInterleavedBuffer>();

/**
 * GLSL `instanceMatrix` of the InstancedMesh being drawn (vertex stage), read the way three's
 * InstanceNode reads it: a uniform buffer when it fits, else instanced vertex attributes. Identity
 * for anything else. Call once per material and reuse the node.
 */
export const instanceMatrixNode = Fn((builder) => {
  const im = builder.object?.instanceMatrix as THREE.InstancedBufferAttribute | undefined;
  if (!im || !builder.object.isInstancedMesh) return mat4(1.0);
  const count = Math.max(im.count, 1);
  if (count * 64 <= builder.getUniformBufferLimit()) {
    let n = _mats.get(im);
    if (!n) { n = buffer(im.array, 'mat4', count); _mats.set(im, n); }
    return n.element(instanceIndex);
  }
  let ib = _inter.get(im);
  if (!ib) { ib = new THREE.InstancedInterleavedBuffer(im.array, 16, 1); _inter.set(im, ib); }
  // (The interleaved copy shares the array: upload it whenever the matrices changed.)
  OnBeforeObjectUpdate(() => { if (ib.version !== im.version) { ib.clearUpdateRanges(); ib.version = im.version; } });
  const f = im.usage === THREE.DynamicDrawUsage ? instancedDynamicBufferAttribute : instancedBufferAttribute;
  return mat4(f(ib, 'vec4', 16, 0), f(ib, 'vec4', 16, 4), f(ib, 'vec4', 16, 8), f(ib, 'vec4', 16, 12));
});

/** Column i of a mat4 node (GLSL `m[i]`). */
export const col = (m, i: number) => m.mul(vec4(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0, i === 3 ? 1 : 0));

/** Multiplies the diffuse colour (GLSL `diffuseColor.rgb *= x` after the colour / map chunks). */
export function mulDiffuse(mat: THREE.NodeMaterial, node: () => unknown): void {
  const base = mat.setupDiffuseColor;
  mat.setupDiffuseColor = function (builder) {
    base.call(this, builder);
    diffuseColor.assign(vec4(diffuseColor.rgb.mul(node()), diffuseColor.a));
  };
}

/**
 * A plain node material standing in for a ShaderMaterial: clip position from `vertex` (vec4),
 * colour from `fragment` (vec4), no fog unless asked (ShaderMaterial's default).
 */
export function shaderLike(o: {
  vertex?: unknown; position?: unknown; fragment: unknown; transparent?: boolean; depthWrite?: boolean; blending?: THREE.Blending;
  side?: THREE.Side; fog?: boolean; line?: boolean;
}): THREE.NodeMaterial {
  const m = o.line ? new THREE.LineBasicNodeMaterial() : new THREE.NodeMaterial();
  m.lights = false;
  m.fog = o.fog ?? false;
  m.transparent = o.transparent ?? false;
  m.depthWrite = o.depthWrite ?? true;
  m.blending = o.blending ?? THREE.NormalBlending;
  m.side = o.side ?? THREE.FrontSide;
  if (o.vertex) m.vertexNode = o.vertex;
  if (o.position) m.positionNode = o.position;
  m.fragmentNode = o.fragment;
  return m;
}
