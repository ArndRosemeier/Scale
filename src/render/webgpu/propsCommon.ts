// @ts-nocheck -- three's TSL typings infer swizzles and vector widths poorly; checked by rendering (docs/WEBGPU_PLAN.md).
/**
 * Helpers shared by the vehicle and street furniture node materials (webgpu/vehicles.ts,
 * webgpu/furniture.ts): the 3D value noise both GLSL materials carry (vhHash/vhNoise, fh/fn) and
 * the instance matrix of the InstancedMesh being drawn (GLSL `instanceMatrix`).
 */
import * as THREE from 'three/webgpu';
import {
  Fn, vec3, fract, floor, mix, sub, mul, buffer, storage, instanceIndex, mat4, instancedBufferAttribute,
  instancedDynamicBufferAttribute, OnBeforeFrameUpdate,
} from 'three/tsl';

/** vhHash / fh */
export const hash3 = Fn(([p0]) => {
  const p = fract(p0.mul(0.3183099).add(0.1)).mul(17.0).toVar();
  return fract(p.x.mul(p.y).mul(p.z).mul(p.x.add(p.y).add(p.z)));
}, { p: 'vec3', return: 'float' });

/** vhNoise / fn */
export const noise3 = Fn(([x]) => {
  const i = floor(x).toVar();
  const f0 = fract(x);
  const f = f0.mul(f0).mul(sub(3.0, mul(2.0, f0))).toVar();
  return mix(
    mix(mix(hash3(i), hash3(i.add(vec3(1, 0, 0))), f.x), mix(hash3(i.add(vec3(0, 1, 0))), hash3(i.add(vec3(1, 1, 0))), f.x), f.y),
    mix(mix(hash3(i.add(vec3(0, 0, 1))), hash3(i.add(vec3(1, 0, 1))), f.x), mix(hash3(i.add(vec3(0, 1, 1))), hash3(i.add(vec3(1, 1, 1))), f.x), f.y),
    f.z,
  );
}, { x: 'vec3', return: 'float' });

const interleaved = new WeakMap<THREE.BufferAttribute, THREE.InstancedInterleavedBuffer>();

/**
 * The current object's instance matrix (vertex stage), or null when it is not an InstancedMesh.
 * Call inside an `Fn((_, builder) => ...)`. Mirrors three's own instancing node (accessors/Instance.js):
 * a uniform buffer while it fits, else per-instance vertex attributes (our own interleaved copy of
 * the matrices, kept in step with their version).
 */
export function instanceMatrixOf(builder): unknown | null {
  const o = builder.object;
  if (!o || o.isInstancedMesh !== true || !o.instanceMatrix || o.instanceMatrix.isInstancedBufferAttribute !== true) return null;
  const m = o.instanceMatrix;
  const count = Math.max(m.count, 1);
  if (m.isStorageInstancedBufferAttribute === true) return storage(m, 'mat4', count).element(instanceIndex);
  if (count * 16 * 4 <= builder.getUniformBufferLimit()) return buffer(m.array, 'mat4', count).element(instanceIndex);
  let ib = interleaved.get(m);
  if (!ib) {
    ib = new THREE.InstancedInterleavedBuffer(m.array, 16, 1);
    interleaved.set(m, ib);
  }
  OnBeforeFrameUpdate(() => {
    if (ib.version !== m.version) ib.version = m.version;
  });
  const bufferFn = m.usage === THREE.DynamicDrawUsage ? instancedDynamicBufferAttribute : instancedBufferAttribute;
  return mat4(bufferFn(ib, 'vec4', 16, 0), bufferFn(ib, 'vec4', 16, 4), bufferFn(ib, 'vec4', 16, 8), bufferFn(ib, 'vec4', 16, 12));
}
