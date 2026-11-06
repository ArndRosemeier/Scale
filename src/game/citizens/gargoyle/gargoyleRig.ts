/**
 * The retired cathedral gargoyle's body: a small skeleton of 24 bones posed forward from a handful
 * of controls (like the Roc's, `threats/roc/rocRig.ts`). Pure (three.js maths only), headless-testable.
 *
 * Bind pose (the skin is built in it, `gargoyleSkin.ts`): the pelvis at the origin, standing
 * upright, the face along +Z, up +Y, the arms hanging at the sides, the bat wings spread flat along
 * ±X (their chord along −Z), the legs straight down, the tail straight back along −Z.
 *
 * Controls (set by the owner, then `place()`): where it is (`x, y, z` of the pelvis, or `feet`: the
 * height its soles stand on, which wins), `yaw`, how it holds itself (`crouch` 0 standing … 1 the
 * squat it perches and sits in, `lean`), walking (`walk` amount, `phase`), the wings (`fold` 1
 * folded … 0 spread, `flap` phase, `beat`), the head's aim (`look`), the mouth (`gape`), the arms
 * (`wave`, `aim`, `stretch`), the tail (`curl`), the eyes' glow (`eyes`), and `still` (stone).
 */
import * as THREE from 'three';
import { clamp, lerp } from '../../../core/math';

type V3 = [number, number, number];

/** Bones: 0 holds the glow levels, then the body and head, the arms, the legs, the wings, the tail. */
export const GARGOYLE_BONES = {
  count: 24,
  pelvis: 1, chest: 2, neck: 3, head: 4, jaw: 5,
  /** Upper arm, forearm, hand (+0, +1, +2) of a side (+1: +X, its left). */
  arm: (side: number) => (side > 0 ? 6 : 9),
  /** Thigh, shin, foot (+0, +1, +2). */
  leg: (side: number) => (side > 0 ? 12 : 15),
  /** Inner and outer wing (+0, +1). */
  wing: (side: number) => (side > 0 ? 18 : 20),
  tail: 22, tail2: 23,
};

/** Measures (m). */
export const GARGOYLE = {
  /** Sole below the ankle joint. */
  sole: 0.06,
  /** Bind: wing joints (inner, outer, tip) out along X; the wingtip's span from the shoulder. */
  wingIn: 0.42, wingOut: 0.56,
  /** Standing height (top of the horns) and crouched (about). */
  height: 1.55,
};

const B = GARGOYLE_BONES;
/** Parent and offset (bind, from the parent's joint) of each bone. */
const DEF: { parent: number; off: V3 }[] = [];
DEF[0] = { parent: -1, off: [0, 0, 0] };
DEF[1] = { parent: -1, off: [0, 0, 0] };
DEF[2] = { parent: 1, off: [0, 0.4, 0.0] };
DEF[3] = { parent: 2, off: [0, 0.28, 0.0] };
DEF[4] = { parent: 3, off: [0, 0.12, 0.04] };
DEF[5] = { parent: 4, off: [0, -0.03, 0.03] };
for (const s of [1, -1]) {
  const a = B.arm(s), l = B.leg(s), w = B.wing(s);
  DEF[a] = { parent: 2, off: [s * 0.27, 0.19, 0] };
  DEF[a + 1] = { parent: a, off: [s * 0.04, -0.25, 0] };
  DEF[a + 2] = { parent: a + 1, off: [s * 0.02, -0.23, 0.01] };
  DEF[l] = { parent: 1, off: [s * 0.12, -0.04, 0] };
  DEF[l + 1] = { parent: l, off: [s * 0.02, -0.34, 0.01] };
  DEF[l + 2] = { parent: l + 1, off: [0, -0.32, -0.02] };
  DEF[w] = { parent: 2, off: [s * 0.1, 0.17, -0.16] };
  DEF[w + 1] = { parent: w, off: [s * GARGOYLE.wingIn, 0.03, 0] };
}
DEF[22] = { parent: 1, off: [0, -0.06, -0.15] };
DEF[23] = { parent: 22, off: [0, 0, -0.34] };

/** Bind position of each bone's joint. */
export const GARGOYLE_BIND: V3[] = DEF.map(() => [0, 0, 0] as V3);
for (let b = 1; b < B.count; b++) {
  const d = DEF[b], p = d.parent >= 0 ? GARGOYLE_BIND[d.parent] : [0, 0, 0];
  GARGOYLE_BIND[b] = [p[0] + d.off[0], p[1] + d.off[1], p[2] + d.off[2]];
}

const _m = new THREE.Matrix4(), _l = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _p = new THREE.Vector3(), _s = new THREE.Vector3();

export class GargoyleRig {
  // ---- controls
  x = 0; y = 0; z = 0;
  /** Height the soles stand on (null: `y` is the pelvis, as in flight). */
  feet: number | null = null;
  /** Heading: forward = (sin yaw, 0, cos yaw). Body pitch forward (rad, gliding) and bank. */
  yaw = 0; pitch = 0; roll = 0;
  /** 0 standing … 1 the squat; extra forward lean of the chest (rad). */
  crouch = 1; lean = 0;
  /** Walking: 0 … 1, gait phase (rad). */
  walk = 0; phase = 0;
  /** Wings: 1 folded … 0 spread; wingbeat phase (rad) and strength 0..1. */
  fold = 1; flap = 0; beat = 0;
  /** Where the head looks (world) or null, the mouth open 0..1 (talking). */
  look: { x: number; y: number; z: number } | null = null;
  gape = 0;
  /** Arms: the right one waving 0..1, the right one pointing ahead 0..1, both stretched up 0..1. */
  wave = 0; aim = 0; stretch = 0;
  /** Arms resting on the knees (crouched) 0..1. */
  rest = 1;
  /** Tail curled round the feet 0..1. */
  curl = 1;
  /** Glows 0..1: the eyes. */
  eyes = 0;
  /** Idle clock; stone (no breath, no sway). */
  t = 0;
  still = false;

  /** Bone frames (world, 16 floats each, column-major) after `place`. */
  readonly world = new Float32Array(B.count * 16);

  get fwd(): { x: number; z: number } { return { x: Math.sin(this.yaw), z: Math.cos(this.yaw) }; }

  /** Pose every bone from the controls. */
  place(): void {
    const W = this.world, c = clamp(this.crouch, 0, 1), sway = this.still ? 0 : 1;
    const breathe = this.still ? 1 : 1 + 0.015 * Math.sin(this.t * 1.6);
    // Root: the pelvis tips forward as it squats (and flat out in a glide).
    _e.set(this.pitch + c * 0.55, this.yaw, this.roll, 'YXZ');
    _q.setFromEuler(_e);
    _m.compose(_p.set(this.x, this.feet === null ? this.y : 0, this.z), _q, _s.set(1, 1, 1));
    _l.identity().toArray(W, 0);
    this.bone(1, _m, 0, 0, 0);
    const wk = clamp(this.walk, 0, 1), ph = this.phase;
    // The chest hunched over, rolling a little with the waddle; the neck back up so it looks ahead.
    this.bone(2, null, c * 0.35 + this.lean + wk * 0.12, wk * 0.12 * Math.sin(ph), wk * 0.06 * Math.sin(ph), breathe, 1, breathe);
    this.head();
    this.arms(c, wk);
    this.legs(c, wk);
    this.wings();
    // Tail: down and curled round the feet when it squats, swaying as it walks.
    const cu = clamp(this.curl, 0, 1);
    const sw = sway * (0.08 * Math.sin(this.t * 0.7) + wk * 0.25 * Math.sin(ph));
    this.bone(22, null, -0.5 * cu - 0.15 - c * 0.35, sw + cu * 0.5, 0);
    this.bone(23, null, 0.45 * cu, sw * 0.8 + cu * 1.1, 0);
    if (this.feet !== null) this.stand(this.feet);
  }

  /** Bone b's frame: its parent's (or `root`) × offset × turn (Euler YZX, rad) × scale. */
  private bone(b: number, root: THREE.Matrix4 | null, rx: number, ry: number, rz: number, sx = 1, sy = 1, sz = 1): void {
    const d = DEF[b];
    if (root) _m.copy(root);
    else _m.fromArray(this.world, d.parent * 16);
    _e.set(rx, ry, rz, 'YZX');
    _q.setFromEuler(_e);
    _l.compose(_p.set(d.off[0], d.off[1], d.off[2]), _q, _s.set(sx, sy, sz));
    _m.multiply(_l).toArray(this.world, b * 16);
  }

  private head(): void {
    let yaw = 0, pitch = 0;
    if (this.look) {
      // The target in the chest's frame (the head sits ~0.4 m above the chest joint).
      _m.fromArray(this.world, B.chest * 16).invert();
      const v = _p.set(this.look.x, this.look.y, this.look.z).applyMatrix4(_m);
      const dx = v.x, dy = v.y - 0.4, dz = v.z;
      yaw = clamp(Math.atan2(dx, Math.max(0.2, dz)), -1.4, 1.4);
      pitch = clamp(Math.atan2(dy, Math.hypot(dx, Math.max(0.2, dz))), -0.9, 0.9);
      if (dz < 0) yaw = Math.sign(dx || 1) * 1.4;
    }
    // Undo the squat's lean at the neck so the face stays level, then the aim.
    const c = clamp(this.crouch, 0, 1), sway = this.still ? 0 : 0.04 * Math.sin(this.t * 0.45);
    const level = -(c * 0.9 + this.lean + this.pitch * 0.85);
    this.bone(3, null, level * 0.6 - pitch * 0.4, yaw * 0.45 + sway, 0);
    this.bone(4, null, level * 0.4 - pitch * 0.6, yaw * 0.55, sway * 0.5);
    this.bone(5, null, clamp(this.gape, 0, 1) * 0.42, 0, 0);
  }

  private arms(c: number, wk: number): void {
    const wave = clamp(this.wave, 0, 1), point = clamp(this.aim, 0, 1), st = clamp(this.stretch, 0, 1), rest = clamp(this.rest, 0, 1) * c;
    for (const s of [1, -1]) {
      const a = B.arm(s);
      // Hanging, swinging as it walks (against the leg), forward onto the knees in the squat.
      const swing = wk * 0.35 * Math.sin(this.phase + (s > 0 ? Math.PI : 0));
      let ux = -swing - rest * 1.15 - (this.feet === null ? 0.4 : 0), uz = s * (0.12 + rest * 0.1), fx = -rest * 0.5 - 0.12, hx = -0.2 + rest * 0.1;
      // Both arms up (a stretch on waking, flapping arms when it lands).
      ux = lerp(ux, -0.25, st); uz = lerp(uz, s * 2.7, st); fx = lerp(fx, 0, st);
      if (s < 0) {
        // Right: a wave (upper arm out and up, the forearm wagging) or a point (straight ahead).
        ux = lerp(ux, -0.35, wave); uz = lerp(uz, -2.25, wave);
        const wag = Math.sin(this.t * 9) * 0.45;
        fx = lerp(fx, 0, wave);
        this.bone(a, null, lerp(ux, -1.45, point), 0, lerp(uz, -0.15, point));
        this.bone(a + 1, null, lerp(fx, -0.05, point), 0, wave * (-0.6 + wag));
        this.bone(a + 2, null, lerp(hx, 0, point), 0, 0);
        continue;
      }
      this.bone(a, null, ux, 0, uz);
      this.bone(a + 1, null, fx, 0, 0);
      this.bone(a + 2, null, hx, 0, 0);
    }
  }

  private legs(c: number, wk: number): void {
    for (const s of [1, -1]) {
      const l = B.leg(s);
      const p = this.phase + (s > 0 ? 0 : Math.PI);
      const swing = wk * Math.sin(p) * 0.45, lift = wk * Math.max(0, Math.cos(p)) * 0.55;
      // The squat: thigh forward and up, shin folded back under, the foot flat (the pelvis tips 0.55 forward).
      const tx = lerp(-0.08, -2.2, c) - swing - lift * 0.5, kx = lerp(0.12, 2.05, c) + lift, ax = lerp(-0.04, -0.4, c) - lift * 0.4;
      // Flying: legs trailing back.
      const fl = this.feet === null ? 1 : 0;
      this.bone(l, null, lerp(tx, 0.25, fl), 0, s * lerp(0.03 + c * 0.12, 0.05, fl));
      this.bone(l + 1, null, lerp(kx, 0.35, fl), 0, 0);
      this.bone(l + 2, null, lerp(ax, 0.6, fl), 0, 0);
    }
  }

  private wings(): void {
    const f = clamp(this.fold, 0, 1), b = clamp(this.beat, 0, 1) * (1 - f);
    const breathe = this.still ? 0 : 0.03 * Math.sin(this.t * 1.6);
    for (const s of [1, -1]) {
      const w = B.wing(s);
      // Folded: swept back and up behind the shoulders, the outer half folded down along it (and narrowed).
      let sweep = lerp(0.1, 1.15, f), elev = lerp(0.05, 0.85, f) + breathe, elbow = lerp(0.1, 2.5, f);
      if (b > 0) {
        const cf = Math.cos(this.flap);
        elev += b * (0.1 + 0.65 * cf);
        elbow += b * 0.35 * Math.max(0, -Math.sin(this.flap));
      }
      this.bone(w, null, 0, s * sweep, s * elev, 1, 1, lerp(1, 0.75, f));
      // (Folded, the outer half is drawn in, its tips tucked behind the arm instead of poking out.)
      this.bone(w + 1, null, 0, s * elbow * 0.25, -s * elbow, lerp(1, 0.45, f), 1, lerp(1, 0.6, f));
    }
  }

  /** Shift the whole body so its lowest sole stands at height `y`. */
  private stand(y: number): void {
    let low = Infinity;
    for (const s of [1, -1]) {
      const f = B.leg(s) + 2;
      // The sole: under the ankle, its heel and its toes.
      for (const dz of [-0.05, 0.18]) low = Math.min(low, this.point(f, GARGOYLE_BIND[f][0], GARGOYLE_BIND[f][1] - GARGOYLE.sole, GARGOYLE_BIND[f][2] + dz).y);
    }
    const dy = y - low, W = this.world;
    for (let b = 1; b < B.count; b++) W[b * 16 + 13] += dy;
    this.y = W[16 + 13];
  }

  /** World position of a point given in bone b's bind space (bind coordinates). */
  point(b: number, bx: number, by: number, bz: number, out = { x: 0, y: 0, z: 0 }): { x: number; y: number; z: number } {
    const P = GARGOYLE_BIND[b];
    _m.fromArray(this.world, b * 16);
    const v = _p.set(bx - P[0], by - P[1], bz - P[2]).applyMatrix4(_m);
    out.x = v.x; out.y = v.y; out.z = v.z;
    return out;
  }

  /** Joint position of bone b (world). */
  joint(b: number, out = { x: 0, y: 0, z: 0 }): { x: number; y: number; z: number } {
    const W = this.world, k = b * 16;
    out.x = W[k + 12]; out.y = W[k + 13]; out.z = W[k + 14];
    return out;
  }

  /** Top of the head (world): where its speech bubble hangs. */
  crown(out = { x: 0, y: 0, z: 0 }): { x: number; y: number; z: number } {
    const H = GARGOYLE_BIND[B.head];
    return this.point(B.head, H[0], H[1] + 0.3, H[2], out);
  }

  /** A box round the posed body (centre, radius) for culling. */
  bounds(): { x: number; y: number; z: number; r: number } {
    const c = this.joint(B.chest);
    return { x: c.x, y: c.y, z: c.z, r: this.fold > 0.6 ? 1.3 : 1.9 };
  }
}
