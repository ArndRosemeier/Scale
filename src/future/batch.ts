/**
 * A growable instanced batch in the shared furniture material, with the per-instance
 * fleet colour (iColor) and LED state (iState) attributes that material understands.
 */
import * as THREE from 'three';

export class FurnBatch {
  readonly mesh: THREE.InstancedMesh;
  private color: THREE.InstancedBufferAttribute;
  private state: THREE.InstancedBufferAttribute;
  n = 0;

  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, readonly cap: number, shadow = true) {
    const g = new THREE.BufferGeometry();
    for (const k of Object.keys(geo.attributes)) g.setAttribute(k, geo.attributes[k]);
    g.setIndex(geo.index);
    g.boundingSphere = geo.boundingSphere;
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.state = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iColor', this.color);
    g.setAttribute('iState', this.state);
    this.mesh = new THREE.InstancedMesh(g, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadow;
    this.mesh.receiveShadow = true;
  }

  /** Start filling a frame. */
  begin(): void { this.n = 0; }

  /** Append one instance; returns false when full. */
  push(m: THREE.Matrix4, r: number, g: number, b: number, sx: number, sy: number, sz: number, sw: number): boolean {
    if (this.n >= this.cap) return false;
    const i = this.n++;
    this.mesh.setMatrixAt(i, m);
    this.color.setXYZ(i, r, g, b);
    this.state.setXYZW(i, sx, sy, sz, sw);
    return true;
  }

  end(): void {
    this.mesh.count = this.n;
    if (this.n) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.color.needsUpdate = true;
      this.state.needsUpdate = true;
    }
  }
}
