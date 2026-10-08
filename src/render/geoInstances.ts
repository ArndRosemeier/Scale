/**
 * Instancing through geometry attributes instead of an InstancedMesh (WebGPU).
 *
 * three's WebGPU renderer builds the node shaders of every InstancedMesh separately (its cache key
 * contains the mesh's uuid, since the instance matrix buffer is baked into the build), so content
 * that comes and goes as many small instanced meshes (the countryside's canopy clumps, one or two
 * per terrain tile) builds shaders on the main thread whenever a new one first shows up: stutter.
 * A plain Mesh whose InstancedBufferGeometry carries the matrices (iM0..iM3, one interleaved
 * buffer) and colours (iColor) shares one build per material and attribute layout. The material
 * reads them (webgpu/fx.ts `geometryInstancing`). docs/WEBGPU_PORTING.md "Shared instancing".
 */
import * as THREE from 'three';

export class GeoInstances {
  readonly mesh: THREE.Mesh;
  private m: Float32Array;
  private c: Float32Array;
  private box = new THREE.Box3();
  private r0: number;

  constructor(base: THREE.BufferGeometry, material: THREE.Material, count: number) {
    const g = new THREE.InstancedBufferGeometry();
    // (Own copies of the small base mesh: disposing this geometry frees all its GPU buffers, and
    // shared ones would vanish from under every other mesh made from the same base.)
    g.index = base.index ? base.index.clone() : null;
    for (const n of Object.keys(base.attributes)) g.setAttribute(n, base.attributes[n].clone());
    this.m = new Float32Array(count * 16);
    this.c = new Float32Array(count * 3);
    const ib = new THREE.InstancedInterleavedBuffer(this.m, 16, 1);
    for (let k = 0; k < 4; k++) g.setAttribute(`iM${k}`, new THREE.InterleavedBufferAttribute(ib, 4, k * 4));
    g.setAttribute('iColor', new THREE.InstancedBufferAttribute(this.c, 3));
    g.instanceCount = count;
    if (!base.boundingSphere) base.computeBoundingSphere();
    this.r0 = base.boundingSphere!.center.length() + base.boundingSphere!.radius;
    this.mesh = new THREE.Mesh(g, material);
  }

  setMatrixAt(i: number, m: THREE.Matrix4): void {
    m.toArray(this.m, i * 16);
    // (Bounds: each instance's base sphere, scaled by its largest axis.)
    const e = m.elements;
    const s = Math.sqrt(Math.max(e[0] * e[0] + e[1] * e[1] + e[2] * e[2], e[4] * e[4] + e[5] * e[5] + e[6] * e[6], e[8] * e[8] + e[9] * e[9] + e[10] * e[10]));
    const r = this.r0 * s;
    this.box.expandByPoint(_p.set(e[12] - r, e[13] - r, e[14] - r)).expandByPoint(_p.set(e[12] + r, e[13] + r, e[14] + r));
  }

  setColorAt(i: number, c: THREE.Color): void { c.toArray(this.c, i * 3); }

  /** After the last setMatrixAt: the bounds for frustum culling. */
  finish(): void {
    const g = this.mesh.geometry;
    g.boundingSphere = this.box.getBoundingSphere(new THREE.Sphere());
    g.boundingBox = this.box.clone();
  }

  dispose(): void { this.mesh.geometry.dispose(); }
}

const _p = new THREE.Vector3();
