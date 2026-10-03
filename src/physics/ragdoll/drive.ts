/**
 * Ragdoll ↔ rig: reads seed rotations from an animated Character and writes ragdoll world
 * transforms back onto its bones.
 *
 * Driving: a part's body rotation is its driver bone's world rotation (rest frames carry no
 * rotation), the bones inside a part are held at rest, so a driver bone's parent world
 * rotation is simply its parent part's body rotation: local = parentBody⁻¹ · body. The root
 * bone's position follows the pelvis body. Everything is blended with the bones' current
 * (animation) pose by a weight, so entering and leaving the ragdoll never pops.
 */
import * as THREE from 'three';
import type { Character } from '../../humanoid/client/Character';
import { PARTS, PART_COUNT, Part, type Vec3 } from './skeleton';

const _pm = new THREE.Vector3(), _sm = new THREE.Vector3(), _v = new THREE.Vector3();
const _qm = new THREE.Quaternion(), _qmi = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _q = new THREE.Quaternion();
const _id = new THREE.Quaternion();

export class RigDriver {
  /** Driver bone per part. */
  private drv: THREE.Bone[] = [];
  private seedB: THREE.Bone[] = [];
  /** All bones the ragdoll sets (drivers, then the held sub bones). */
  private all: THREE.Bone[] = [];
  private nDrv = PART_COUNT;
  /** The animation's pose of `all` (+ root position), kept for frames the animator skips. */
  private animQ: Float32Array;
  private animP = new THREE.Vector3();
  /** What this driver wrote last (root quaternion + position): tells a skipped animator frame. */
  private outQ = new THREE.Quaternion();
  private outP = new THREE.Vector3();
  private wrote = false;

  constructor(readonly ch: Character) {
    for (const p of PARTS) { this.drv.push(ch.bone(p.bone)); this.seedB.push(ch.bone(p.seed)); }
    this.all.push(...this.drv);
    for (const p of PARTS) for (const s of p.sub) { const b = ch.bones[ch.boneIndex.get(s) ?? -1]; if (b) this.all.push(b); }
    this.animQ = new Float32Array(this.all.length * 4);
  }

  /** Rest bone head by name (model units) for the body plan. */
  static restOf(ch: Character): (name: string) => Vec3 | null {
    return (n) => {
      const i = ch.boneIndex.get(n);
      if (i === undefined) return null;
      const r = ch.rest[i];
      return [r.x, r.y, r.z];
    };
  }

  /** The model frame's world transform (position, rotation, uniform scale). */
  private model(): number {
    const m = this.ch.model;
    m.updateWorldMatrix(true, false);
    m.matrixWorld.decompose(_pm, _qm, _sm);
    return _sm.x;
  }

  /** World scale of the model frame (model units → metres). */
  scale(): number { return this.model(); }

  /**
   * Seed a ragdoll from the current (animated) pose: each part's world rotation into `rot`,
   * the pelvis (root bone head) world position into `pelvis`. Returns the world scale.
   */
  sample(rot: Float32Array, pelvis: THREE.Vector3): number {
    const s = this.model();
    for (let i = 0; i < PART_COUNT; i++) {
      // World rotation = model · Π locals from the root down to the seed bone.
      _q.identity();
      for (let b: THREE.Object3D | null = this.seedB[i]; b && b !== this.ch.model; b = b.parent) _q.premultiply(b.quaternion);
      _q.premultiply(_qm).normalize();
      rot[i * 4] = _q.x; rot[i * 4 + 1] = _q.y; rot[i * 4 + 2] = _q.z; rot[i * 4 + 3] = _q.w;
    }
    pelvis.copy(this.drv[Part.Pelvis].position).multiplyScalar(s).applyQuaternion(_qm).add(_pm);
    return s;
  }

  /**
   * Pose the rig from part world transforms, blended over the animation by w (0..1).
   * Call after the animator (and the rig's own update) for this frame.
   */
  apply(pos: Float32Array, rot: Float32Array, w: number): void {
    const all = this.all, root = this.drv[Part.Pelvis];
    // Keep the animation pose: if the animator skipped this frame (distant LOD) the bones still
    // hold our last output, so blend from the stored animation pose instead.
    const skipped = this.wrote && root.quaternion.equals(this.outQ) && root.position.equals(this.outP);
    if (!skipped) {
      for (let k = 0; k < all.length; k++) all[k].quaternion.toArray(this.animQ, k * 4);
      this.animP.copy(root.position);
    }
    const s = this.model();
    _qmi.copy(_qm).invert();
    w = Math.min(1, Math.max(0, w));
    for (let i = 0; i < this.nDrv; i++) {
      const p = PARTS[i].parent;
      if (p < 0) _qp.copy(_qmi);
      else _qp.set(rot[p * 4], rot[p * 4 + 1], rot[p * 4 + 2], rot[p * 4 + 3]).invert();
      _qb.set(rot[i * 4], rot[i * 4 + 1], rot[i * 4 + 2], rot[i * 4 + 3]);
      _q.multiplyQuaternions(_qp, _qb);
      const b = this.drv[i];
      b.quaternion.fromArray(this.animQ, i * 4);
      if (w >= 1) b.quaternion.copy(_q); else b.quaternion.slerp(_q, w);
    }
    for (let k = this.nDrv; k < all.length; k++) {
      const b = all[k];
      b.quaternion.fromArray(this.animQ, k * 4);
      if (w >= 1) b.quaternion.identity(); else b.quaternion.slerp(_id, w);
    }
    // Root position: the pelvis body in the model frame.
    _v.set(pos[0], pos[1], pos[2]).sub(_pm).applyQuaternion(_qmi).divideScalar(s || 1);
    root.position.copy(this.animP).lerp(_v, w);
    this.outQ.copy(root.quaternion);
    this.outP.copy(root.position);
    this.wrote = true;
  }

  /** The animator owns the bones again (no stale "skipped frame" detection). */
  reset(): void { this.wrote = false; }
}
