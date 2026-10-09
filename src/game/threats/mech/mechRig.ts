/**
 * The giant mech's frame (THREATS_PLAN §1 #12): a two-legged walking war machine, a little skeleton
 * of 18 rigid bones posed from a handful of controls. Pure (three.js maths only), headless-testable.
 *
 * Bind pose (the skin is built in it, `mechSkin.ts`): the pelvis at the origin, forward +Z, up +Y,
 * the legs hanging straight down, the arms straight down at the hull's sides. Every bone is the bind
 * pose turned about its joint (a bone's frame is its parent's × the joint's offset × a turn), so its
 * skinning matrix is that × the bind translation's inverse; every part of the skin rides one bone.
 *
 * Controls (set by the owner, then `place()`): where the pelvis is and how it lies (`x, y, z`,
 * `yaw`, `pitch`, `roll`), where each foot stands (`feet`, world, with the foot's heading and a lift
 * for the swing), the hull's twist and the arms' aim (`aim`: a world point or null), the missile pods
 * raised (`pods`), the right arm's hammer blow (`smash`), the heat vents open (`vent`), the glows
 * (`visor`, `heat`).
 *
 * The legs are reverse-jointed ("chicken walker"): each is solved by two-bone IK from the hip to its
 * foot, the knee behind; the foot stays flat on the ground.
 */
import * as THREE from 'three';
import { clamp } from '../../../core/math';
import type { Capsule } from '../rig/CreatureRig';

type V3 = [number, number, number];

/** Bones: 0 holds the glow levels, then the body, the pods, the arms, the legs, the vents. */
export const MECH_BONES = {
  count: 18,
  pelvis: 1, hull: 2, cockpit: 3,
  /** Missile pod on a side's shoulder (+1: +X). */
  pod: (side: number) => (side > 0 ? 4 : 5),
  /** Upper arm, forearm (+0, +1) of a side: +X the cannon arm, −X the hammer arm. */
  arm: (side: number) => (side > 0 ? 6 : 8),
  /** Thigh, shin, foot (+0, +1, +2) of a side. */
  leg: (side: number) => (side > 0 ? 10 : 13),
  vent: (side: number) => (side > 0 ? 16 : 17),
};

/** Full-size measures (m). */
export const MECH = {
  /** Hip on the pelvis (x, y, z); thigh, shin; ankle to sole. */
  hip: [2.9, -0.6, 0] as V3,
  thigh: 7.2, shin: 7.4, sole: 1.1,
  /** Hull joint on the pelvis; the hull box (half width, bottom, top, back, front). */
  hullAt: [0, 1.2, 0] as V3,
  hull: { w: 4.4, y0: -0.4, y1: 6.8, z0: -3.6, z1: 3.4 },
  /** Cockpit joint on the hull (front, high). */
  cockpitAt: [0, 5.2, 3.2] as V3,
  /** Pod joint on the hull (side, high), the pod's size (half width, half height, length). */
  podAt: [5.7, 6.9, -0.6] as V3, pod: [1.35, 1.25, 4.8] as V3,
  /** Shoulder on the hull; upper arm, forearm. */
  shoulder: [5.4, 4.6, 0.4] as V3, upper: 4.4, fore: 4.2, barrel: 3.6,
  /** Vent on the hull's back (side, high). */
  ventAt: [1.9, 4.4, -3.6] as V3,
  /** How high the pelvis stands over the ground at rest (legs bent), full size. */
  stand: 13.2,
};

/** Parent and offset (bind, from the parent's joint) of each bone. */
const DEF: { parent: number; off: V3 }[] = [];
DEF[0] = { parent: -1, off: [0, 0, 0] };
DEF[1] = { parent: -1, off: [0, 0, 0] };
DEF[2] = { parent: 1, off: MECH.hullAt };
DEF[3] = { parent: 2, off: MECH.cockpitAt };
for (const s of [1, -1]) {
  const a = MECH_BONES.arm(s), l = MECH_BONES.leg(s);
  DEF[MECH_BONES.pod(s)] = { parent: 2, off: [s * MECH.podAt[0], MECH.podAt[1], MECH.podAt[2]] };
  DEF[a] = { parent: 2, off: [s * MECH.shoulder[0], MECH.shoulder[1], MECH.shoulder[2]] };
  DEF[a + 1] = { parent: a, off: [0, -MECH.upper, 0] };
  DEF[l] = { parent: 1, off: [s * MECH.hip[0], MECH.hip[1], MECH.hip[2]] };
  DEF[l + 1] = { parent: l, off: [0, -MECH.thigh, 0] };
  DEF[l + 2] = { parent: l + 1, off: [0, -MECH.shin, 0] };
  DEF[MECH_BONES.vent(s)] = { parent: 2, off: [s * MECH.ventAt[0], MECH.ventAt[1], MECH.ventAt[2]] };
}

/** Bind position of each bone's joint. */
export const MECH_BIND: V3[] = DEF.map(() => [0, 0, 0] as V3);
for (let b = 0; b < DEF.length; b++) {
  const d = DEF[b], p = d.parent >= 0 ? MECH_BIND[d.parent] : [0, 0, 0];
  MECH_BIND[b] = [p[0] + d.off[0], p[1] + d.off[1], p[2] + d.off[2]];
}

export interface MechFoot { x: number; y: number; z: number; yaw: number; lift: number }

const _m = new THREE.Matrix4(), _l = new THREE.Matrix4(), _inv = new THREE.Matrix4();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
const _q = new THREE.Quaternion(), _e = new THREE.Euler();

export class MechRig {
  // ---- controls
  x = 0; y = MECH.stand; z = 0;
  yaw = 0; pitch = 0; roll = 0;
  scale = 1;
  /** Where each foot's sole stands (world); index 0 the +X (left-hand) foot. */
  readonly feet: MechFoot[] = [{ x: MECH.hip[0], y: 0, z: 0, yaw: 0, lift: 0 }, { x: -MECH.hip[0], y: 0, z: 0, yaw: 0, lift: 0 }];
  /** What the hull and the arms turn to (world), or null (straight ahead). */
  aim: { x: number; y: number; z: number } | null = null;
  /** Pods raised 0..1, the hammer arm's blow 0 (resting) … 0.5 (raised) … 1 (down), vents open 0..1. */
  pods = 0; smash = 0; vent = 0;
  /** Glows: the visor, the vents' heat. */
  visor = 0.7; heat = 0;
  /** Seconds (small idle motions), no idle motion when set (tests). */
  t = 0;
  still = false;

  /** Bone frames (world, 16 floats each, column-major) after `place`. */
  readonly world = new Float32Array(MECH_BONES.count * 16);
  /** Hit capsules (zone in each): hull ×2, cockpit, pods, arms, thighs, knees, shins, feet, vents. */
  readonly caps: Capsule[] = [];
  /** Hull twist this frame (rad, from the aim). */
  twist = 0;

  constructor(scale = 1) {
    this.scale = scale;
    const zone = ['body', 'body', 'cockpit', 'pod', 'pod', 'arm', 'arm', 'arm', 'arm', 'leg', 'joint', 'leg', 'leg', 'leg', 'joint', 'leg', 'leg', 'vents'];
    for (const z of zone) this.caps.push({ ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, r: 1, zone: z });
  }

  /** Forward (unit, world) of the heading. */
  get fwd(): { x: number; z: number } { return { x: Math.sin(this.yaw), z: Math.cos(this.yaw) }; }

  /** Pose every bone from the controls. */
  place(): void {
    const W = this.world, s = this.scale;
    _e.set(-this.pitch, this.yaw, this.roll, 'YXZ');
    _q.setFromEuler(_e);
    _m.compose(_p.set(this.x, this.y, this.z), _q, _s.set(s, s, s));
    _l.identity().toArray(W, 0);
    _m.toArray(W, 16);
    // Hull: twisted to the aim (in the pelvis frame), a slow idle sway.
    let tw = 0, el = 0;
    if (this.aim) {
      _inv.copy(_m).invert();
      const v = _p.set(this.aim.x, this.aim.y, this.aim.z).applyMatrix4(_inv);
      tw = clamp(Math.atan2(v.x, Math.max(0.5, v.z)), -1.4, 1.4);
      if (v.z < 0) tw = Math.sign(v.x || 1) * 1.4;
      el = clamp(Math.atan2(v.y - MECH.shoulder[1] - MECH.hullAt[1], Math.hypot(v.x, v.z)), -0.9, 0.7);
    }
    this.twist = tw;
    const sway = this.still ? 0 : 0.02 * Math.sin(this.t * 0.7);
    this.bone(2, null, 0, tw + sway, 0);
    this.bone(3, null, -el * 0.4, 0, 0);
    for (const side of [1, -1]) {
      // Pods: tilted up to fire.
      this.bone(MECH_BONES.pod(side), null, -0.55 * clamp(this.pods, 0, 1), 0, 0);
      const a = MECH_BONES.arm(side);
      if (side > 0) {
        // The cannon arm: raised to aim (forearm level to the target).
        const up = this.aim ? 1 : 0.15;
        this.bone(a, null, -(1.2 + el) * up, 0, side * 0.08);
        this.bone(a + 1, null, -0.35 * up - 0.2, 0, 0);
      } else {
        // The hammer arm: resting forward a little, raised high, brought down in front.
        const k = clamp(this.smash, 0, 1);
        const sh = k < 0.5 ? -0.3 - (k / 0.5) * 2.4 : -2.7 + ((k - 0.5) / 0.5) * 2.0;
        const el2 = k < 0.5 ? -0.4 - (k / 0.5) * 0.8 : -1.2 + ((k - 0.5) / 0.5) * 1.0;
        this.bone(a, null, sh, 0, side * 0.08);
        this.bone(a + 1, null, el2, 0, 0);
      }
      // Vents slide back out of the hull.
      this.bone(MECH_BONES.vent(side), null, 0, 0, 0, 1, 1, 1, [0, 0.25 * this.vent, -1.1 * this.vent]);
      this.leg(side);
    }
    this.capsules();
  }

  /** Two-bone IK from the hip to its foot (knee behind), the foot flat and turned to its heading. */
  private leg(side: number): void {
    const l = MECH_BONES.leg(side), F = this.feet[side > 0 ? 0 : 1], s = this.scale;
    // The ankle's target in the pelvis frame (the sole is MECH.sole under it, a lift for the swing).
    _inv.fromArray(this.world, 16).invert();
    const t = _p.set(F.x, F.y + (MECH.sole + F.lift) * s, F.z).applyMatrix4(_inv);
    const hx = side * MECH.hip[0], hy = MECH.hip[1], hz = MECH.hip[2];
    const dx = t.x - hx, dy = t.y - hy, dz = t.z - hz;
    const L1 = MECH.thigh, L2 = MECH.shin;
    // Roll the leg's plane out to the foot, then solve in it.
    const roll = clamp(Math.atan2(dx, -dy), -0.5, 0.5);
    const dv = Math.hypot(dx, dy) * Math.sign(-dy || 1);
    const d = clamp(Math.hypot(dv, dz), 0.6, L1 + L2 - 1e-3);
    const phi = Math.atan2(-dz, dv);
    const alpha = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
    const beta = Math.acos(clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
    const a1 = phi + alpha, a2 = a1 - (Math.PI - beta);
    this.bone(l, null, a1, 0, roll, 1, 1, 1, undefined, 'ZYX');
    this.bone(l + 1, null, a2 - a1, 0, 0);
    // The foot: flat (undo the leg's pitch, the pelvis's tilt) and turned to its heading.
    this.bone(l + 2, null, -a2 + this.pitch, F.yaw - this.yaw, -roll - this.roll * 0.5, 1, 1, 1, undefined, 'XZY');
  }

  /** Bone b's frame: its parent's (or `root`) × offset (+ `shift`) × turn × scale. */
  private bone(b: number, root: THREE.Matrix4 | null, rx: number, ry: number, rz: number, sx = 1, sy = 1, sz = 1, shift?: V3, order: THREE.EulerOrder = 'YXZ'): void {
    const d = DEF[b];
    if (root) _m.copy(root);
    else _m.fromArray(this.world, d.parent * 16);
    _e.set(rx, ry, rz, order);
    _q.setFromEuler(_e);
    _l.compose(_p.set(d.off[0] + (shift?.[0] ?? 0), d.off[1] + (shift?.[1] ?? 0), d.off[2] + (shift?.[2] ?? 0)), _q, _s.set(sx, sy, sz));
    _m.multiply(_l).toArray(this.world, b * 16);
  }

  /** World position of a point given in bone b's bind space (bind coordinates). */
  point(b: number, bx: number, by: number, bz: number, out = { x: 0, y: 0, z: 0 }): { x: number; y: number; z: number } {
    const B = MECH_BIND[b];
    _m.fromArray(this.world, b * 16);
    const v = _p.set(bx - B[0], by - B[1], bz - B[2]).applyMatrix4(_m);
    out.x = v.x; out.y = v.y; out.z = v.z;
    return out;
  }

  /** Joint position of bone b (world). */
  joint(b: number, out = { x: 0, y: 0, z: 0 }): { x: number; y: number; z: number } {
    const W = this.world, k = b * 16;
    out.x = W[k + 12]; out.y = W[k + 13]; out.z = W[k + 14];
    return out;
  }

  /** The cannon's muzzle (world: the barrel carries on along the forearm) and a pod's launch tubes (world, the front face's middle). */
  muzzle(out = { x: 0, y: 0, z: 0 }): { x: number; y: number; z: number } {
    const a = MECH_BONES.arm(1) + 1, B = MECH_BIND[a];
    return this.point(a, B[0], B[1] - MECH.fore - MECH.barrel, B[2], out);
  }
  tubes(side: number, out = { x: 0, y: 0, z: 0 }): { x: number; y: number; z: number } {
    const p = MECH_BONES.pod(side), B = MECH_BIND[p];
    return this.point(p, B[0], B[1], B[2] + MECH.pod[2] / 2 + 0.3, out);
  }
  /** The hammer's head (world). */
  hammer(out = { x: 0, y: 0, z: 0 }): { x: number; y: number; z: number } {
    const a = MECH_BONES.arm(-1) + 1, B = MECH_BIND[a];
    return this.point(a, B[0], B[1] - MECH.fore - 1.2, B[2], out);
  }
  /** Where a sole stands (world, under the foot bone). */
  sole(side: number, out = { x: 0, y: 0, z: 0 }): { x: number; y: number; z: number } {
    const f = MECH_BONES.leg(side) + 2, B = MECH_BIND[f];
    return this.point(f, B[0], B[1] - MECH.sole, B[2] + 0.6, out);
  }

  private capsules(): void {
    const C = this.caps, s = this.scale;
    let i = 0;
    const set = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, r: number) => {
      const c = C[i++];
      c.ax = a.x; c.ay = a.y; c.az = a.z; c.bx = b.x; c.by = b.y; c.bz = b.z; c.r = r * s;
    };
    const P = (b: number, x: number, y: number, z: number) => this.point(b, x, y, z, { x: 0, y: 0, z: 0 });
    const J = (b: number) => this.joint(b, { x: 0, y: 0, z: 0 });
    const H = MECH.hull, hb = MECH_BIND[2];
    // Hull: two side-by-side capsules front to back, the lower and the upper half.
    set(P(2, 0, hb[1] + 1.6, hb[2] + H.z0 + 1.6), P(2, 0, hb[1] + 1.6, hb[2] + H.z1 - 1.6), 3.4);
    set(P(2, 0, hb[1] + 4.6, hb[2] + H.z0 + 1.6), P(2, 0, hb[1] + 4.6, hb[2] + H.z1 - 1.6), 3.2);
    const cb = MECH_BIND[3];
    set(P(3, -1.2, cb[1] + 0.3, cb[2] + 0.9), P(3, 1.2, cb[1] + 0.3, cb[2] + 0.9), 1.5);
    for (const side of [1, -1]) {
      const p = MECH_BONES.pod(side), pb = MECH_BIND[p];
      set(P(p, pb[0], pb[1], pb[2] - MECH.pod[2] / 2 + 1), P(p, pb[0], pb[1], pb[2] + MECH.pod[2] / 2 - 1), 1.45);
    }
    for (const side of [1, -1]) {
      const a = MECH_BONES.arm(side);
      set(J(a), J(a + 1), 1.3);
      set(J(a + 1), side > 0 ? this.muzzle({ x: 0, y: 0, z: 0 }) : this.hammer({ x: 0, y: 0, z: 0 }), side > 0 ? 1.2 : 1.6);
    }
    for (const side of [1, -1]) {
      const l = MECH_BONES.leg(side);
      const hip = J(l), knee = J(l + 1), ankle = J(l + 2);
      // Thigh (short of the knee), the knee joint, the shin, the foot.
      const k = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
      set(hip, k(hip, knee, 0.78), 1.35);
      set(k(knee, hip, 0.08), k(knee, ankle, 0.08), 1.25);
      set(k(knee, ankle, 0.2), ankle, 1.1);
      const fb = MECH_BIND[l + 2];
      set(P(l + 2, fb[0], fb[1] - 0.6, fb[2] - 1.4), P(l + 2, fb[0], fb[1] - 0.6, fb[2] + 2.6), 0.75);
    }
    const v1 = MECH_BONES.vent(1), v2 = MECH_BONES.vent(-1);
    const a = MECH_BIND[v1], b = MECH_BIND[v2];
    set(P(v1, a[0], a[1], a[2] - 0.3), P(v2, b[0], b[1], b[2] - 0.3), 1.3);
  }

  /** Bind frames (translations only). */
  static bindFrames(): Float32Array {
    const out = new Float32Array(MECH_BONES.count * 16);
    for (let b = 0; b < MECH_BONES.count; b++) new THREE.Matrix4().makeTranslation(MECH_BIND[b][0], MECH_BIND[b][1], MECH_BIND[b][2]).toArray(out, b * 16);
    return out;
  }

  /** Nearest capsule to a point (distance to its surface) and its index. */
  nearest(x: number, y: number, z: number): { d: number; i: number } | null {
    let bd = Infinity, bi = -1;
    for (let i = 0; i < this.caps.length; i++) {
      const c = this.caps[i];
      const ux = c.bx - c.ax, uy = c.by - c.ay, uz = c.bz - c.az, L2 = ux * ux + uy * uy + uz * uz || 1;
      const t = clamp(((x - c.ax) * ux + (y - c.ay) * uy + (z - c.az) * uz) / L2, 0, 1);
      const d = Math.hypot(x - c.ax - ux * t, y - c.ay - uy * t, z - c.az - uz * t) - c.r;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi >= 0 ? { d: bd, i: bi } : null;
  }
}
