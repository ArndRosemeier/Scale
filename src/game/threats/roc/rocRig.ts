/**
 * The Roc's body (THREATS_PLAN §1 #5): a giant bird of prey, a little skeleton of 23 bones posed
 * forward from a handful of controls. Pure (three.js maths only), headless-testable.
 *
 * Bind pose (the skin is built in it, `rocSkin.ts`): the body's middle at the origin, the beak
 * along +Z, up +Y, the wings spread flat along ±X, the legs hanging straight down, the tail fanned
 * behind along −Z. Every bone is the bind pose turned about its joint: a bone's frame is its
 * parent's × (the joint's offset, a turn, a scale), so its skinning matrix is that × the bind
 * translation's inverse.
 *
 * Controls (set by the owner, then `place()`): where it is and how it lies (`x, y, z`, `yaw`,
 * `pitch`, `roll`), the wings (`flap` phase and `beat` strength, or `spread` / `mantle` / `fold`
 * mixes), the head's aim (`look`), the beak (`gape`), the legs (`legs`: tucked 0 … reaching 1,
 * `perch`: standing), the tail (`tailPitch`, `tailSpread`) and the glows (`eyes`).
 */
import * as THREE from 'three';
import { clamp, lerp } from '../../../core/math';
import type { Capsule } from '../rig/CreatureRig';

type V3 = [number, number, number];

/** Bones: 0 holds the glow levels, then the body, neck and head, the wings, the legs. */
export const ROC_BONES = {
  count: 24,
  chest: 1, pelvis: 2, tail: 3, fan: 4,
  neck0: 5, head: 8, jaw: 9,
  /** Humerus, forearm, hand (+0, +1, +2) of a side (+1: +X). */
  wing: (side: number) => (side > 0 ? 10 : 13),
  leg: (side: number) => (side > 0 ? 16 : 19),
  prim: (side: number) => (side > 0 ? 22 : 23),
};

/** Full-size measures (m). */
export const ROC = {
  /** Shoulder joint on the chest; humerus, forearm, hand, the primaries' root beyond the wrist. */
  shoulder: [1.6, 1.0, 1.7] as V3,
  humerus: 4.2, forearm: 5.0, hand: 2.4,
  /** Hip on the pelvis; thigh, shank. */
  hip: [1.25, -1.0, 1.4] as V3,
  thigh: 2.5, shank: 2.9,
  /** Beak tip (bind) and the jaw's hinge on the head. */
  beakTip: [0, 0.95, 10.0] as V3,
  /** Half span with the wings spread (m), body length beak to tail tip (m). */
  halfSpan: 0, length: 17.5,
};
ROC.halfSpan = ROC.shoulder[0] + ROC.humerus + ROC.forearm + ROC.hand + 6.6;

/** Parent and offset (bind, from the parent's joint) of each bone. */
const DEF: { parent: number; off: V3 }[] = [];
DEF[0] = { parent: -1, off: [0, 0, 0] };
DEF[1] = { parent: -1, off: [0, 0, 0] };
DEF[2] = { parent: 1, off: [0, 0, -3.5] };
DEF[3] = { parent: 2, off: [0, 0.3, -2.6] };
DEF[4] = { parent: 3, off: [0, 0, -1.6] };
DEF[5] = { parent: 1, off: [0, 0.9, 2.9] };
DEF[6] = { parent: 5, off: [0, 0.4, 1.25] };
DEF[7] = { parent: 6, off: [0, 0.4, 1.25] };
DEF[8] = { parent: 7, off: [0, 0.2, 1.1] };
DEF[9] = { parent: 8, off: [0, -0.45, 0.55] };
for (const s of [1, -1]) {
  const w = ROC_BONES.wing(s), l = ROC_BONES.leg(s), p = ROC_BONES.prim(s);
  DEF[w] = { parent: 1, off: [s * ROC.shoulder[0], ROC.shoulder[1], ROC.shoulder[2]] };
  DEF[w + 1] = { parent: w, off: [s * ROC.humerus, 0, 0] };
  DEF[w + 2] = { parent: w + 1, off: [s * ROC.forearm, 0, 0] };
  DEF[p] = { parent: w + 2, off: [s * ROC.hand, 0, 0] };
  DEF[l] = { parent: 2, off: [s * ROC.hip[0], ROC.hip[1], ROC.hip[2]] };
  DEF[l + 1] = { parent: l, off: [0, -ROC.thigh, 0] };
  DEF[l + 2] = { parent: l + 1, off: [0, -ROC.shank, 0] };
}

/** Bind position of each bone's joint. */
export const ROC_BIND: V3[] = DEF.map(() => [0, 0, 0] as V3);
for (let b = 1; b < ROC_BONES.count; b++) {
  const d = DEF[b], p = d.parent >= 0 ? ROC_BIND[d.parent] : [0, 0, 0];
  ROC_BIND[b] = [p[0] + d.off[0], p[1] + d.off[1], p[2] + d.off[2]];
}

/** How high the body's middle stands over its feet when perched (full size, m). */
export const PERCH_HEIGHT = 6.25;

const _m = new THREE.Matrix4(), _l = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _p = new THREE.Vector3(), _s = new THREE.Vector3();

/** A wing's joint turns: sweep (back), elevation (up), twist (leading edge up), elbow and wrist folds, the primaries' fan. */
interface WingPose { sweep: number; elev: number; twist: number; elbow: number; wrist: number; prim: number; chord: number }

const SPREAD: WingPose = { sweep: 0.05, elev: 0.04, twist: 0.06, elbow: 0.12, wrist: -0.1, prim: 0, chord: 1 };
const MANTLE: WingPose = { sweep: 0.35, elev: -0.25, twist: 0.2, elbow: 0.75, wrist: -0.9, prim: 0.25, chord: 0.9 };
const FOLD: WingPose = { sweep: 1.25, elev: 0.15, twist: 0.1, elbow: 2.35, wrist: -2.5, prim: 0.35, chord: 0.35 };

export class RocRig {
  // ---- controls
  x = 0; y = 0; z = 0;
  /** Heading (forward = (sin yaw, 0, cos yaw)), nose up, bank (right wing down for +). */
  yaw = 0; pitch = 0; roll = 0;
  scale = 1;
  /** Wingbeat phase (rad) and strength 0..1 (0: held), the poses' mixes (0..1; the rest is spread). */
  flap = 0; beat = 0;
  mantle = 0; fold = 0;
  /** Extra per-side lift of a wing (a lopsided flail when it tumbles), rad. */
  flail = 0;
  /** Where the head looks (world) or null (straight ahead), the beak open 0..1. */
  look: { x: number; y: number; z: number } | null = null;
  gape = 0;
  /** Legs: tucked back (0) … reaching forward with the talons open (1); standing on a perch (true wins). */
  legs = 0;
  perch = false;
  /** Talons closed round something (0 open … 1 shut). */
  grip = 0;
  tailPitch = 0; tailSpread = 0.5;
  /** Glows 0..1: the eyes. */
  eyes = 0.3;
  /** Breathing / idle clock; lying dead (no breath). */
  t = 0;
  still = false;

  /** Bone frames (world, 16 floats each, column-major) after `place`. */
  readonly world = new Float32Array(ROC_BONES.count * 16);
  /** Hit capsules: body, neck, head, each wing's three parts and its feathers, legs (zone in each). */
  readonly caps: Capsule[] = [];

  constructor(scale = 1) {
    this.scale = scale;
    const zone = ['body', 'body', 'neck', 'head', 'wing', 'wing', 'wing', 'wing', 'wing', 'wing', 'wing', 'wing', 'leg', 'leg', 'tail'];
    for (const z of zone) this.caps.push({ ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, r: 1, zone: z });
  }

  /** Forward and right (unit, world) of the heading. */
  get fwd(): { x: number; z: number } { return { x: Math.sin(this.yaw), z: Math.cos(this.yaw) }; }

  /** Pose every bone from the controls. */
  place(): void {
    const W = this.world, s = this.scale;
    // Root: position, heading, nose, bank (Y, then X, then Z), size.
    _e.set(-this.pitch, this.yaw, this.roll, 'YXZ');
    _q.setFromEuler(_e);
    const breathe = this.still ? 1 : 1 + 0.012 * Math.sin(this.t * 1.3);
    _m.compose(_p.set(this.x, this.y, this.z), _q, _s.set(s, s, s));
    // (Bone 0 is the glow slot, written by the mesh.)
    _l.identity().toArray(W, 0);
    this.bone(1, _m, 0, 0, 0, breathe, breathe, 1);
    this.bone(2, null, 0.04 * this.legs, 0, 0);
    this.bone(3, null, this.tailPitch * 0.5, 0, 0);
    const sp = lerp(0.45, 1.55, clamp(this.tailSpread, 0, 1));
    this.bone(4, null, this.tailPitch * 0.5, 0, 0, sp, 1, 1);
    this.neckAndHead();
    for (const side of [1, -1]) { this.wing(side); this.leg(side); }
    this.capsules();
  }

  /** Bone b's frame: its parent's (or `root`) × offset × turn (Euler XYZ, rad) × scale. */
  private bone(b: number, root: THREE.Matrix4 | null, rx: number, ry: number, rz: number, sx = 1, sy = 1, sz = 1): void {
    const d = DEF[b];
    if (root) _m.copy(root);
    else _m.fromArray(this.world, d.parent * 16);
    _e.set(rx, ry, rz, 'YZX');
    _q.setFromEuler(_e);
    _l.compose(_p.set(d.off[0], d.off[1], d.off[2]), _q, _s.set(sx, sy, sz));
    _m.multiply(_l).toArray(this.world, b * 16);
  }

  /** The neck in an S (raptor's posture), the head turned to what it looks at, the beak. */
  private neckAndHead(): void {
    let yaw = 0, pitch = 0;
    if (this.look) {
      // The target in the chest's frame.
      _m.fromArray(this.world, 16).invert();
      const v = _p.set(this.look.x, this.look.y, this.look.z).applyMatrix4(_m);
      const dx = v.x, dy = v.y - 2, dz = v.z - 6;
      yaw = clamp(Math.atan2(dx, Math.max(0.5, dz)), -1.5, 1.5);
      pitch = clamp(Math.atan2(dy, Math.hypot(dx, Math.max(0.5, dz))), -1.1, 0.8);
      if (dz < 0) yaw = clamp(Math.sign(dx || 1) * 1.5, -1.5, 1.5);
    }
    const crouch = this.perch ? 0.25 : 0.08;
    this.bone(5, null, -0.35 - crouch - pitch * 0.2, yaw * 0.2, 0);
    this.bone(6, null, 0.05 - pitch * 0.25, yaw * 0.25, 0);
    this.bone(7, null, 0.2 + crouch - pitch * 0.25, yaw * 0.3, 0);
    this.bone(8, null, 0.1 + crouch * 0.5 - pitch * 0.3, yaw * 0.25, 0);
    this.bone(9, null, clamp(this.gape, 0, 1.2) * 0.55, 0, 0);
  }

  /** A wing's pose this frame: the mixes, the beat on top. */
  private wingPose(side: number): WingPose {
    const m = clamp(this.mantle, 0, 1), f = clamp(this.fold, 0, 1);
    const mix = (k: keyof WingPose) => lerp(lerp(SPREAD[k], MANTLE[k], m), FOLD[k], f);
    const P: WingPose = { sweep: mix('sweep'), elev: mix('elev'), twist: mix('twist'), elbow: mix('elbow'), wrist: mix('wrist'), prim: mix('prim'), chord: mix('chord') };
    const b = clamp(this.beat, 0, 1) * (1 - f);
    if (b > 0) {
      // Down stroke (sin > 0 falling): wings sweep down and forward, the hand flexes on the up stroke.
      const c = Math.cos(this.flap), sn = Math.sin(this.flap);
      P.elev += b * (0.15 + 0.62 * c);
      P.sweep += b * 0.12 * sn;
      P.twist += b * 0.18 * sn;
      const up = Math.max(0, -sn);
      P.elbow += b * 0.35 * up;
      P.wrist -= b * 0.55 * up;
      P.prim += b * 0.15 * up;
    }
    P.elev += this.flail * side;
    return P;
  }

  private wing(side: number): void {
    const P = this.wingPose(side), w = ROC_BONES.wing(side), s = side;
    // Humerus: sweep (back), elevation (up), twist (leading edge up), chord squeezed when folded.
    this.bone(w, null, P.twist, s * P.sweep, s * P.elev, 1, 1, P.chord);
    this.bone(w + 1, null, 0, -s * P.elbow, 0, 1, 1, lerp(1, P.chord, 0.6) / P.chord);
    this.bone(w + 2, null, 0, -s * P.wrist, 0);
    this.bone(ROC_BONES.prim(side), null, 0, -s * (P.prim + 0.05 * Math.sin(this.t * 2 + s)), 0);
  }

  private leg(side: number): void {
    const l = ROC_BONES.leg(side);
    let hip: number, knee: number, ankle: number;
    if (this.perch) { hip = -0.6; knee = 1.0; ankle = -0.4; }
    else {
      // Tucked back under the tail … swung forward, talons out.
      const k = clamp(this.legs, 0, 1);
      hip = lerp(1.35, -1.05, k); knee = lerp(-2.2, 0.45, k); ankle = lerp(1.4, -0.1, k);
    }
    this.bone(l, null, hip, 0, side * 0.06);
    this.bone(l + 1, null, knee, 0, 0);
    this.bone(l + 2, null, ankle + this.grip * 0.25, 0, 0);
  }

  /** World position of a point given in bone b's bind space (bind coordinates). */
  point(b: number, bx: number, by: number, bz: number, out = { x: 0, y: 0, z: 0 }): { x: number; y: number; z: number } {
    const B = ROC_BIND[b];
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

  /** The beak's tip (world). */
  beak(out = { x: 0, y: 0, z: 0 }): { x: number; y: number; z: number } { return this.point(ROC_BONES.head, ROC.beakTip[0], ROC.beakTip[1], ROC.beakTip[2], out); }

  /** Between the talons (world): where a grabbed car hangs. */
  talons(out = { x: 0, y: 0, z: 0 }): { x: number; y: number; z: number } {
    const a = this.point(ROC_BONES.leg(1) + 2, ROC_BIND[ROC_BONES.leg(1) + 2][0], ROC_BIND[ROC_BONES.leg(1) + 2][1] - 0.4, ROC_BIND[ROC_BONES.leg(1) + 2][2] + 0.6);
    const b = this.point(ROC_BONES.leg(-1) + 2, ROC_BIND[ROC_BONES.leg(-1) + 2][0], ROC_BIND[ROC_BONES.leg(-1) + 2][1] - 0.4, ROC_BIND[ROC_BONES.leg(-1) + 2][2] + 0.6);
    out.x = (a.x + b.x) / 2; out.y = (a.y + b.y) / 2; out.z = (a.z + b.z) / 2;
    return out;
  }

  /** The wingtip of a side (world). */
  tip(side: number, out = { x: 0, y: 0, z: 0 }): { x: number; y: number; z: number } {
    const p = ROC_BONES.prim(side), B = ROC_BIND[p];
    return this.point(p, B[0] + side * 6.2, B[1], B[2] - 1.5, out);
  }

  private capsules(): void {
    const C = this.caps, s = this.scale;
    let i = 0;
    const set = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, r: number) => {
      const c = C[i++];
      c.ax = a.x; c.ay = a.y; c.az = a.z; c.bx = b.x; c.by = b.y; c.bz = b.z; c.r = r * s;
    };
    const P = (b: number, x: number, y: number, z: number) => this.point(b, x, y, z, { x: 0, y: 0, z: 0 });
    set(P(1, 0, 0, 1.5), P(1, 0, 0, -1.5), 2.4);
    set(P(2, 0, 0, -2.5), P(2, 0, 0.2, -5.5), 1.8);
    set(this.joint(5, { x: 0, y: 0, z: 0 }), this.joint(8, { x: 0, y: 0, z: 0 }), 1.1);
    set(this.joint(8, { x: 0, y: 0, z: 0 }), this.beak(), 1.05);
    for (const side of [1, -1]) {
      const w = ROC_BONES.wing(side), p = ROC_BONES.prim(side);
      // Each part along its leading edge, pushed half a chord back (radius ≈ half the chord).
      const seg = (b: number, x0: number, x1: number, back: number, r: number) => { const B = ROC_BIND[b]; set(P(b, x0, B[1], B[2] - back), P(b, x1, B[1], B[2] - back), r); };
      const sx = ROC_BIND[w][0], ex = ROC_BIND[w + 1][0], wx = ROC_BIND[w + 2][0], px = ROC_BIND[p][0];
      seg(w, sx, ex, 2.4, 2.4);
      seg(w + 1, ex, wx, 2.1, 2.2);
      seg(w + 2, wx, px, 1.4, 1.6);
      seg(p, px, px + side * 5.6, 1.6, 1.4);
    }
    for (const side of [1, -1]) {
      const l = ROC_BONES.leg(side);
      set(this.joint(l, { x: 0, y: 0, z: 0 }), this.joint(l + 2, { x: 0, y: 0, z: 0 }), 0.7);
    }
    set(P(4, 0, 0.3, -7.8), P(4, 0, 0.3, -12.2), 1.6);
  }

  /** Bind frames (translations only). */
  static bindFrames(): Float32Array {
    const out = new Float32Array(ROC_BONES.count * 16);
    for (let b = 0; b < ROC_BONES.count; b++) new THREE.Matrix4().makeTranslation(ROC_BIND[b][0], ROC_BIND[b][1], ROC_BIND[b][2]).toArray(out, b * 16);
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
