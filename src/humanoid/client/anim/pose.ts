/**
 * Pose representation for the procedural animator.
 *
 * A pose stores Euler angles per bone (radians) relative to the rest pose,
 * whose bone frames are translation-only (axes = model axes: +Y up, character
 * faces −Z, character's left is −X). Conventions (left-side canonical; right
 * side mirrors as (x, −y, −z)):
 *   limbs  (order XZY, body X outermost): +x swings a hanging limb forward,
 *          +z lowers/adducts the left arm (−z raises it sideways),
 *          +y twists; knees flex with −x, elbows with +x.
 *   spine/neck/head (order YXZ, yaw outermost): −x bends forward / chin down,
 *          +y turns left, +z leans left.
 * Poses blend linearly (angles stay moderate, so Euler blending is smooth).
 */
import * as THREE from 'three';

export type Side = 'L' | 'R';

/** Bone name → index map shared by all characters (manifest order) + tail bones. */
export interface BoneMap {
  idx: (name: string) => number;
  count: number;
  /** Rotation order per bone. */
  order: THREE.EulerOrder[];
}

export function makeBoneMap(names: string[]): BoneMap {
  const m = new Map<string, number>();
  names.forEach((n, i) => m.set(n, i));
  const order = names.map((n) => (/^(spine|neck|head|jaw|root|tail)/.test(n) ? 'YXZ' : 'XZY') as THREE.EulerOrder);
  return { idx: (n) => m.get(n) ?? -1, count: names.length, order };
}

export class Pose {
  readonly rot: Float32Array;
  /** Root translation offset (model space, m). */
  readonly root = new THREE.Vector3();
  constructor(readonly map: BoneMap) {
    this.rot = new Float32Array(map.count * 3);
  }
  clear() {
    this.rot.fill(0);
    this.root.set(0, 0, 0);
    return this;
  }
  copy(o: Pose) {
    this.rot.set(o.rot);
    this.root.copy(o.root);
    return this;
  }
  /** this = lerp(this, o, w) (masked), each angle the short way round (clips may turn fully over). */
  blend(o: Pose, w: number, mask?: Float32Array) {
    if (w <= 0) return this;
    const r = this.rot, s = o.rot;
    if (!mask) for (let i = 0; i < r.length; i++) r[i] += wrapPi(s[i] - r[i]) * w;
    else for (let b = 0; b < this.map.count; b++) {
      const k = w * mask[b];
      if (k <= 0) continue;
      const i = b * 3;
      r[i] += wrapPi(s[i] - r[i]) * k; r[i + 1] += wrapPi(s[i + 1] - r[i + 1]) * k; r[i + 2] += wrapPi(s[i + 2] - r[i + 2]) * k;
    }
    this.root.lerp(o.root, mask ? w * mask[0] : w);
    return this;
  }
  /** this += o * w. */
  addScaled(o: Pose, w: number) {
    const r = this.rot, s = o.rot;
    for (let i = 0; i < r.length; i++) r[i] += s[i] * w;
    this.root.addScaledVector(o.root, w);
    return this;
  }

  // ---- authoring helpers
  add(name: string, x: number, y = 0, z = 0) {
    const i = this.map.idx(name);
    if (i < 0) return this;
    this.rot[i * 3] += x; this.rot[i * 3 + 1] += y; this.rot[i * 3 + 2] += z;
    return this;
  }
  /** Side-aware add: angles given for the left side, mirrored for the right. */
  addS(base: string, side: Side, x: number, y = 0, z = 0) {
    const m = side === 'L' ? 1 : -1;
    return this.add(`${base}.${side}`, x, y * m, z * m);
  }
  /** Spread a bend over the spine (lower → upper weights). */
  spine(x: number, y = 0, z = 0) {
    const w = [0.12, 0.18, 0.22, 0.24, 0.24];
    ['spine05', 'spine04', 'spine03', 'spine02', 'spine01'].forEach((n, k) => this.add(n, x * w[k], y * w[k], z * w[k]));
    return this;
  }
  neck(x: number, y = 0, z = 0) {
    this.add('neck01', x * 0.3, y * 0.3, z * 0.3);
    this.add('neck02', x * 0.25, y * 0.25, z * 0.25);
    this.add('neck03', x * 0.15, y * 0.15, z * 0.15);
    return this.add('head', x * 0.3, y * 0.3, z * 0.3);
  }
  /**
   * Arm relative to the "arms down" neutral: fwd (shoulder flexion), out (abduction),
   * twist, elbow flexion, forearm pronation, wrist flex/deviation, shoulder shrug.
   */
  arm(side: Side, fwd: number, out: number, twist = 0, elbow = 0, pron = 0, wristX = 0, wristZ = 0, shrug = 0) {
    this.addS('clavicle', side, fwd * 0.12, 0, -out * 0.18 - shrug);
    this.addS('shoulder01', side, fwd * 0.1, 0, -out * 0.12);
    this.addS('upperarm01', side, fwd * 0.78, twist * 0.6, -out * 0.7);
    this.addS('upperarm02', side, 0, twist * 0.4, 0);
    this.addS('lowerarm01', side, elbow, pron * 0.3, 0);
    this.addS('lowerarm02', side, 0, pron * 0.7, 0);
    return this.addS('wrist', side, wristX, 0, wristZ);
  }
  leg(side: Side, flex: number, abd = 0, twist = 0, knee = 0, ankle = 0, toe = 0) {
    // The whole bend at the real hip and knee: upperleg02 / lowerleg02 start mid-thigh /
    // mid-shin, and a share of the bend there kinked the thigh and shin.
    this.addS('upperleg01', side, flex, twist, -abd);
    this.addS('lowerleg01', side, -knee, 0, 0);
    this.addS('foot', side, -ankle, 0, 0);
    return this.addS('toes', side, toe, 0, 0);
  }
}

/** Piecewise curve through [t, value] keys with smoothstep easing between keys. */
export function kf(t: number, keys: [number, number][]): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1], [t1, v1] = keys[i];
      const u = (t - t0) / Math.max(1e-6, t1 - t0);
      const s = u * u * (3 - 2 * u);
      return v0 + (v1 - v0) * s;
    }
  }
  return keys[keys.length - 1][1];
}

/** Angle difference folded into [−π, π]. */
export const wrapPi = (d: number) => d - Math.round(d / (Math.PI * 2)) * Math.PI * 2;
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Exponential approach (frame-rate independent). */
export const approach = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
