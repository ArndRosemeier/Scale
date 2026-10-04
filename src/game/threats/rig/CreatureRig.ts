/**
 * A procedural segmented creature rig (THREATS_PLAN §4.3): a spine that follows its leader along
 * the path it walks, legs whose feet are planted on the ground and stepped by a gait phase (two-bone
 * IK, knees and elbows by a pole), a neck that aims the head at what it looks at (FABRIK), a tail
 * that trails, sags, sways and can sweep, dorsal plates on the chains. Everything is defined by a
 * `RigDef` in metres, so the same rig drives the Strider now and later creatures (a Burrower is a
 * spine and a head without legs, tentacles are tails, tripod legs are legs).
 *
 * Per frame: `update` moves the skeleton (the owner sets the root position, heading and the pose
 * controls first), `draw` pushes the parts into a CreatureMesh, `capsules` lists the body's
 * capsules for hits (ray, sphere) with the zone each belongs to. Footfalls come out through `onStep`.
 */
import * as THREE from 'three';
import { follow, reach, twoBone, swingOf, smooth01, type Vec3 } from './chain';
import { Shape, type CreatureMesh } from './CreatureMesh';

export interface LegDef {
  /** Fixed to the front (chest) or the back (pelvis) of the spine. */
  at: 'front' | 'back';
  side: 1 | -1;
  /** Hip offset from the spine joint: out to the side, down, forward (m). */
  out: number; down: number; fwd: number;
  /** Bone lengths (m) and radii [upper, lower, foot]. */
  upper: number; lower: number; foot: number;
  r: [number, number, number];
  /** Gait phase offset (0..1). */
  phase: number;
  /** +1: the knee points forward (hind legs); −1: the elbow points back (forelegs). */
  knee: 1 | -1;
  /** The foot stands this far further out than the hip (sprawl, m). */
  spread: number;
  /** Zone name for hits. */
  zone: string;
}

export interface PlateDef { chain: 'spine' | 'neck' | 'tail'; seg: number; t: number; h: number; len: number }

export interface RigDef {
  /** Spine from the front (neck base) back to the pelvis: segment lengths, radii, and the joints' heights above the ground. */
  spine: number[]; spineR: number[]; spineH: number[];
  neck: number[]; neckR: number[];
  head: { len: number; w: number; h: number };
  jaw: { len: number; w: number; h: number };
  tail: number[]; tailR: number[];
  legs: LegDef[];
  plates: PlateDef[];
  /** Stride (m per gait cycle), share of the cycle a foot is in the air, step height (m). */
  stride: number; swing: number; lift: number;
}

/** A body capsule for hits: segment a → b, radius, zone. */
export interface Capsule { ax: number; ay: number; az: number; bx: number; by: number; bz: number; r: number; zone: string }

interface LegState {
  def: LegDef;
  plant: Vec3; from: Vec3; to: Vec3;
  /** Swing progress 0..1, −1 planted. */
  sw: number;
  hip: Vec3; knee: Vec3; ankle: Vec3; foot: Vec3;
  /** Forced re-step (settling while standing). */
  lifted: boolean;
  /** Pinned somewhere else (a forefoot on a facade): world point, or null. */
  pin: Vec3 | null;
}

const _m = new THREE.Matrix4();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _v: Vec3 = { x: 0, y: 0, z: 0 }, _w: Vec3 = { x: 0, y: 0, z: 0 }, _p: Vec3 = { x: 0, y: 0, z: 0 };

const v3 = (): Vec3 => ({ x: 0, y: 0, z: 0 });

export class CreatureRig {
  // ---- pose controls (set by the owner before update)
  /** Root on the ground (x, z) and heading (yaw: forward = (−sin, −cos)). */
  x = 0; z = 0; yaw = 0;
  /** Extra height of the whole body (m; negative: sunk under water / into the ground). */
  lift = 0;
  /** Rearing up on the hind legs 0..1 (belly shown). */
  rear = 0;
  /** Dying / lying down 0..1 (legs fold, body to the ground), and to which side it rolls. */
  slump = 0;
  slumpSide = 1;
  /** Jaw open 0..1. */
  jaw = 0;
  /** Where the head looks (world), and how much it follows that (0: ahead). */
  readonly look: Vec3 = { x: 0, y: 0, z: 0 };
  lookW = 0;
  /** Tail sweep: −1..1 to a side (0: trailing). */
  sweep = 0;
  /** Glows (0..1): the ridge (with a wave from the tail to the head at `ridgeT`), the throat, the eyes. */
  ridge = 0;
  throat = 0;
  eyes = 0.6;
  /** Breathing / idle sway time. */
  t = 0;
  /** Ground height at a point (terrain / street, ignoring buildings). */
  ground: (x: number, z: number) => number = () => 0;
  /** A foot came down (leg index, where). */
  onStep: ((leg: number, x: number, y: number, z: number) => void) | null = null;

  // ---- skeleton
  readonly spine: Float64Array;
  readonly neck: Float64Array;
  readonly tail: Float64Array;
  readonly legs: LegState[];
  /** Head origin (back of the skull), its forward / up axes. */
  readonly headPos = new THREE.Vector3();
  readonly headFwd = new THREE.Vector3(0, 0, -1);
  readonly headUp = new THREE.Vector3(0, 1, 0);
  /** Mouth (breath origin) and the throat (weak spot). */
  readonly mouth = new THREE.Vector3();
  readonly throatPos = new THREE.Vector3();
  private phase = 0;
  private placed = false;
  readonly caps: Capsule[] = [];
  readonly scale: number;

  constructor(readonly def: RigDef, scale = 1) {
    this.scale = scale;
    this.spine = new Float64Array((def.spine.length + 1) * 3);
    this.neck = new Float64Array((def.neck.length + 1) * 3);
    this.tail = new Float64Array((def.tail.length + 1) * 3);
    this.legs = def.legs.map((d) => ({ def: d, plant: v3(), from: v3(), to: v3(), sw: -1, hip: v3(), knee: v3(), ankle: v3(), foot: v3(), lifted: false, pin: null }));
  }

  get fx(): number { return -Math.sin(this.yaw); }
  get fz(): number { return -Math.cos(this.yaw); }
  /** Right of the heading. */
  get rx(): number { return Math.cos(this.yaw); }
  get rz(): number { return -Math.sin(this.yaw); }

  /** Total body length (nose to tail tip, m). */
  get length(): number {
    const D = this.def, s = this.scale;
    return (D.spine.reduce((a, b) => a + b, 0) + D.neck.reduce((a, b) => a + b, 0) * 0.8 + D.head.len + D.tail.reduce((a, b) => a + b, 0)) * s;
  }

  /** Put the skeleton straight at the current root (spawn): feet planted under the hips. */
  place(): void {
    const D = this.def, s = this.scale, fx = this.fx, fz = this.fz;
    const g = this.ground(this.x, this.z);
    let o = 0;
    for (let i = 0; i <= D.spine.length; i++) {
      const y = g + D.spineH[i] * s + this.lift;
      this.spine[i * 3] = this.x - fx * o; this.spine[i * 3 + 1] = y; this.spine[i * 3 + 2] = this.z - fz * o;
      if (i < D.spine.length) o += D.spine[i] * s;
    }
    const px = this.spine[D.spine.length * 3], py = this.spine[D.spine.length * 3 + 1], pz = this.spine[D.spine.length * 3 + 2];
    o = 0;
    for (let i = 0; i <= D.tail.length; i++) {
      this.tail[i * 3] = px - fx * o; this.tail[i * 3 + 1] = Math.max(g + 1, py - o * 0.2); this.tail[i * 3 + 2] = pz - fz * o;
      if (i < D.tail.length) o += D.tail[i] * s;
    }
    o = 0;
    for (let i = 0; i <= D.neck.length; i++) {
      this.neck[i * 3] = this.spine[0] + fx * o * 0.8; this.neck[i * 3 + 1] = this.spine[1] + o * 0.6; this.neck[i * 3 + 2] = this.spine[2] + fz * o * 0.8;
      if (i < D.neck.length) o += D.neck[i] * s;
    }
    for (const L of this.legs) {
      this.home(L, _v);
      L.plant.x = _v.x; L.plant.z = _v.z; L.plant.y = this.ground(_v.x, _v.z);
      L.sw = -1; L.lifted = false;
    }
    this.placed = true;
  }

  /** Where a leg's foot wants to stand: under its hip, sprawled out, a little ahead. */
  private home(L: LegState, out: Vec3): Vec3 {
    const d = L.def, s = this.scale;
    const j = d.at === 'front' ? 1 : this.def.spine.length;
    const bx = this.spine[j * 3], bz = this.spine[j * 3 + 2];
    // Local axes from the spine itself (the body bends along the path).
    const a = d.at === 'front' ? 0 : j - 1, b = d.at === 'front' ? 2 : j;
    let ax = this.spine[a * 3] - this.spine[b * 3], az = this.spine[a * 3 + 2] - this.spine[b * 3 + 2];
    const al = Math.hypot(ax, az) || 1; ax /= al; az /= al;
    const sx = -az * d.side, sz = ax * d.side; // right of the axis × side
    const outD = (d.out + d.spread) * s;
    out.x = bx + sx * outD + ax * d.fwd * s;
    out.z = bz + sz * outD + az * d.fwd * s;
    out.y = this.ground(out.x, out.z);
    return out;
  }

  /**
   * Move the skeleton. `moved`: distance the root travelled this frame (drives the gait).
   */
  update(dt: number, moved: number): void {
    if (!this.placed) this.place();
    const D = this.def, s = this.scale;
    this.t += dt;
    const fx = this.fx, fz = this.fz, rx = this.rx, rz = this.rz;
    const g0 = this.ground(this.x, this.z);
    const slump = smooth01(this.slump), rear = smooth01(this.rear);
    // ---- spine: the leader (neck base) on the path, the rest follow it.
    const nS = D.spine.length;
    const breath = Math.sin(this.t * 1.1) * 0.25 * s;
    const lead = 0.6 * s;
    const lx = this.x + fx * lead * (1 - rear) - fx * rear * 6 * s, lz = this.z + fz * lead * (1 - rear) - fz * rear * 6 * s;
    const groundLead = this.ground(lx, lz);
    const ly = Math.max(groundLead, g0 - 4 * s) + (D.spineH[0] * s + rear * 20 * s) * (1 - slump) + slump * D.spineR[0] * s * 0.7 + this.lift + breath;
    this.spine[0] = lx; this.spine[1] = ly; this.spine[2] = lz;
    for (let i = 1; i <= nS; i++) {
      // Followers at their own heights (rearing: a ramp up to the raised front).
      const jx = this.spine[i * 3], jz = this.spine[i * 3 + 2];
      const gi = this.ground(jx, jz);
      const tRear = 1 - i / nS;
      const hi = (D.spineH[i] * s + rear * 20 * s * tRear * tRear) * (1 - slump) + slump * D.spineR[Math.min(i, nS - 1)] * s * 0.75;
      this.spine[i * 3 + 1] += (Math.max(gi, g0 - 4 * s) + hi + this.lift - this.spine[i * 3 + 1]) * Math.min(1, dt * 6);
    }
    follow(this.spine, scaled(D.spine, s));
    // ---- legs
    const swing = D.swing;
    let settle = false;
    for (const L of this.legs) if (!L.pin) { this.home(L, _v); if (Math.hypot(_v.x - L.plant.x, _v.z - L.plant.z) > D.stride * s * 0.35) settle = true; }
    const dPhase = moved / (D.stride * s) + (settle && moved < 0.05 * dt ? dt * 0.45 : 0);
    const prev = this.phase;
    if (slump < 0.5) this.phase += dPhase;
    for (let li = 0; li < this.legs.length; li++) {
      const L = this.legs[li], d = L.def;
      const was = swingOf(prev, d.phase, swing), now = swingOf(this.phase, d.phase, swing);
      if (L.pin) { L.sw = -1; }
      else if (now >= 0 && (was < 0 || now < was)) {
        // Lift off: aim half a stride ahead of home (where home will be at touch-down).
        L.from.x = L.plant.x; L.from.y = L.plant.y; L.from.z = L.plant.z;
        this.home(L, L.to);
        const ahead = moved > 0.02 * dt ? D.stride * s * 0.42 : 0;
        L.to.x += fx * ahead; L.to.z += fz * ahead; L.to.y = this.ground(L.to.x, L.to.z);
        L.sw = now;
      } else if (now >= 0) {
        L.sw = now;
        // Keep the landing point up to date with the body (turns).
        this.home(L, _w);
        const ahead = moved > 0.02 * dt ? D.stride * s * 0.42 : 0;
        L.to.x += (_w.x + fx * ahead - L.to.x) * Math.min(1, dt * 3); L.to.z += (_w.z + fz * ahead - L.to.z) * Math.min(1, dt * 3);
        L.to.y = this.ground(L.to.x, L.to.z);
      } else if (L.sw >= 0) {
        // Touch down.
        L.sw = -1;
        L.plant.x = L.to.x; L.plant.y = L.to.y; L.plant.z = L.to.z;
        this.onStep?.(li, L.plant.x, L.plant.y, L.plant.z);
      }
      // Foot: planted, swinging (an arc), pinned, or folding while dying.
      const f = L.foot;
      if (L.pin) { f.x = L.pin.x; f.y = L.pin.y; f.z = L.pin.z; }
      else if (L.sw >= 0) {
        const k = smooth01(L.sw);
        f.x = L.from.x + (L.to.x - L.from.x) * k; f.z = L.from.z + (L.to.z - L.from.z) * k;
        f.y = L.from.y + (L.to.y - L.from.y) * k + Math.sin(Math.PI * L.sw) * D.lift * s;
      } else { f.x = L.plant.x; f.y = L.plant.y; f.z = L.plant.z; }
      if (slump > 0) {
        // Splay out sideways as the body comes down.
        const j = d.at === 'front' ? 1 : nS;
        const ox = f.x - this.spine[j * 3], oz = f.z - this.spine[j * 3 + 2], ol = Math.hypot(ox, oz) || 1;
        f.x += (ox / ol) * slump * d.upper * s * 0.6; f.z += (oz / ol) * slump * d.upper * s * 0.6;
        f.y = this.ground(f.x, f.z);
      }
      // Hip on the spine joint; ankle above the heel; IK for the knee.
      const j = d.at === 'front' ? 1 : nS;
      const a = d.at === 'front' ? 0 : nS - 1, b = d.at === 'front' ? 2 : nS;
      let ax = this.spine[a * 3] - this.spine[b * 3], az = this.spine[a * 3 + 2] - this.spine[b * 3 + 2];
      const al = Math.hypot(ax, az) || 1; ax /= al; az /= al;
      const sx = -az * d.side, sz = ax * d.side;
      L.hip.x = this.spine[j * 3] + sx * d.out * s + ax * d.fwd * s;
      L.hip.y = this.spine[j * 3 + 1] - d.down * s;
      L.hip.z = this.spine[j * 3 + 2] + sz * d.out * s + az * d.fwd * s;
      const heel = d.foot * s * 0.35;
      _p.x = f.x - ax * heel; _p.y = f.y + d.r[2] * s * 0.9; _p.z = f.z - az * heel;
      _w.x = ax * d.knee + sx * 0.55; _w.y = d.knee > 0 ? 0.1 : 0.25; _w.z = az * d.knee + sz * 0.55;
      twoBone(L.hip, _p, d.upper * s, d.lower * s, _w, L.knee, L.ankle);
    }
    void rx; void rz;
    // ---- neck and head: reach towards the look target (clamped to what a neck can do).
    const n0x = this.spine[0], n0y = this.spine[1], n0z = this.spine[2];
    this.neck[0] = n0x; this.neck[1] = n0y; this.neck[2] = n0z;
    const nL = D.neck.reduce((p, c) => p + c, 0) * s;
    let tx = fx * 0.75, ty = 0.55, tz = fz * 0.75;
    if (this.lookW > 0) {
      let dx = this.look.x - n0x, dy = this.look.y - n0y, dz = this.look.z - n0z;
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl; dy /= dl; dz /= dl;
      // Keep it in front: no more than ~100° off the heading.
      const fwdDot = dx * fx + dz * fz;
      if (fwdDot < -0.2) { const k = (-0.2 - fwdDot); dx += fx * k; dz += fz * k; }
      dy = Math.max(-0.45, Math.min(0.9, dy));
      const w = this.lookW;
      tx = tx * (1 - w) + dx * w; ty = ty * (1 - w) + dy * w; tz = tz * (1 - w) + dz * w;
      const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    }
    if (slump > 0) { ty = ty * (1 - slump) - 0.5 * slump; }
    // Idle sway of the head.
    tx += Math.sin(this.t * 0.37) * 0.05; ty += Math.sin(this.t * 0.53) * 0.04;
    const reachD = nL * 0.93;
    let hx = n0x + tx * reachD, hy = n0y + ty * reachD, hz = n0z + tz * reachD;
    if (slump > 0) hy = hy * (1 - slump) + (this.ground(hx, hz) + D.neckR[D.neckR.length - 1] * s * 0.8) * slump;
    hy = Math.max(hy, this.ground(hx, hz) + D.neckR[D.neckR.length - 1] * s * 0.8);
    reach(this.neck, scaled(D.neck, s), hx, hy, hz, 3);
    const nN = D.neck.length;
    this.headPos.set(this.neck[nN * 3], this.neck[nN * 3 + 1], this.neck[nN * 3 + 2]);
    // The head points along the look direction (pitched down a little; up when roaring).
    _x.set(tx, ty - 0.35 + this.jaw * 0.3, tz).normalize();
    this.headFwd.lerp(_x, Math.min(1, dt * 5)).normalize();
    _y.set(0, 1, 0);
    _z.crossVectors(this.headFwd, _y).normalize();
    this.headUp.crossVectors(_z, this.headFwd).normalize();
    this.mouth.copy(this.headPos).addScaledVector(this.headFwd, D.head.len * s * 0.92).addScaledVector(this.headUp, -D.head.h * s * 0.12);
    // Throat: under the jaw hinge, on the last neck segment.
    const tI = (nN - 1) * 3;
    this.throatPos.set((this.neck[tI] + this.headPos.x) / 2, (this.neck[tI + 1] + this.headPos.y) / 2, (this.neck[tI + 2] + this.headPos.z) / 2).addScaledVector(this.headUp, -D.neckR[nN - 1] * s * 0.7);
    // ---- tail: trails from the pelvis, sags, sways, sweeps.
    const pI = nS * 3;
    this.tail[0] = this.spine[pI]; this.tail[1] = this.spine[pI + 1] - D.spineR[nS - 1] * s * 0.15; this.tail[2] = this.spine[pI + 2];
    const nT = D.tail.length;
    let bx = this.spine[pI] - this.spine[pI - 3], bz = this.spine[pI + 2] - this.spine[pI - 1];
    const bl = Math.hypot(bx, bz) || 1; bx /= bl; bz /= bl;
    // Each joint is drawn towards where it would be on a tail bent by the sweep angle (stronger
    // towards the tip) plus a slow idle sway, drooping behind the pelvis; the chain constraint keeps
    // the lengths (and when walking, the drag along the path dominates).
    const ang0 = this.sweep * 1.9 + Math.sin(this.t * 0.9) * 0.12;
    const rate = Math.min(1, dt * (Math.abs(this.sweep) > 0.05 ? 7 : 2.5));
    let o = 0;
    for (let i = 1; i <= nT; i++) {
      o += D.tail[i - 1] * s;
      const k = i / nT, a = ang0 * Math.pow(k, 0.7) + Math.sin(this.t * 1.3 - k * 3) * 0.08 * k;
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = bx * ca - bz * sa, dz = bz * ca + bx * sa;
      const tx = this.tail[0] + dx * o, tz = this.tail[2] + dz * o, ty = this.tail[1] - o * 0.16;
      this.tail[i * 3] += (tx - this.tail[i * 3]) * rate;
      this.tail[i * 3 + 1] += (ty - this.tail[i * 3 + 1]) * rate;
      this.tail[i * 3 + 2] += (tz - this.tail[i * 3 + 2]) * rate;
    }
    const tR = D.tailR;
    follow(this.tail, scaled(D.tail, s), 0.35 * s * Math.min(1, dt * 30), (x, z) => this.ground(x, z) + tR[tR.length - 1] * s);
    // ---- capsules for hits
    this.buildCapsules();
  }

  /** Body capsules (spine, neck, head, tail, legs) with their zones. */
  private buildCapsules(): void {
    const D = this.def, s = this.scale, C = this.caps;
    C.length = 0;
    const seg = (c: Float64Array, i: number, r: number, zone: string) => C.push({ ax: c[i * 3], ay: c[i * 3 + 1], az: c[i * 3 + 2], bx: c[i * 3 + 3], by: c[i * 3 + 4], bz: c[i * 3 + 5], r, zone });
    for (let i = 0; i < D.spine.length; i++) seg(this.spine, i, D.spineR[i] * s, 'body');
    for (let i = 0; i < D.neck.length; i++) seg(this.neck, i, D.neckR[i] * s, i === D.neck.length - 1 ? 'throat' : 'neck');
    const hp = this.headPos, hf = this.headFwd, hl = D.head.len * s;
    C.push({ ax: hp.x, ay: hp.y, az: hp.z, bx: hp.x + hf.x * hl, by: hp.y + hf.y * hl, bz: hp.z + hf.z * hl, r: D.head.w * s * 0.42, zone: 'head' });
    for (let i = 0; i < D.tail.length; i++) seg(this.tail, i, D.tailR[i] * s, 'tail');
    for (const L of this.legs) {
      const r = L.def.r;
      C.push({ ax: L.hip.x, ay: L.hip.y, az: L.hip.z, bx: L.knee.x, by: L.knee.y, bz: L.knee.z, r: r[0] * s, zone: L.def.zone });
      C.push({ ax: L.knee.x, ay: L.knee.y, az: L.knee.z, bx: L.ankle.x, by: L.ankle.y, bz: L.ankle.z, r: r[1] * s, zone: L.def.zone });
    }
  }

  /** Push the parts into the batch. */
  draw(mesh: CreatureMesh): number {
    const D = this.def, s = this.scale;
    let n = 0;
    const fx = this.fx, fz = this.fz;
    // Up hint per chain: the body's up (rolling over while dying).
    const roll = smooth01(this.slump) * 0.9 * this.slumpSide;
    const upx = this.rx * Math.sin(roll), upy = Math.cos(roll), upz = this.rz * Math.sin(roll);
    // Spine (with the belly glow off), neck (the throat segment glows when charging), tail.
    for (let i = 0; i < D.spine.length; i++) n += this.seg(mesh, this.spine, i, D.spineR[i] * s * 1.0, D.spineR[i] * s * 0.92, upx, upy, upz, 0, 0, 0) ? 1 : 0;
    const th = this.throat;
    for (let i = 0; i < D.neck.length; i++) {
      const g = i === D.neck.length - 1 ? th : i === D.neck.length - 2 ? th * 0.5 : 0;
      n += this.seg(mesh, this.neck, i, D.neckR[i] * s, D.neckR[i] * s * 0.95, upx, upy, upz, 2.6 * g, 1.1 * g, 0.25 * g) ? 1 : 0;
    }
    for (let i = 0; i < D.tail.length; i++) n += this.seg(mesh, this.tail, i, D.tailR[i] * s, D.tailR[i] * s * 0.85, upx, upy, upz, 0, 0, 0) ? 1 : 0;
    // Legs: upper and lower bones, the foot flat on the ground pointing ahead.
    for (const L of this.legs) {
      const r = L.def.r;
      n += this.bone(mesh, L.hip, L.knee, r[0] * s, upx, upy, upz) ? 1 : 0;
      n += this.bone(mesh, L.knee, L.ankle, r[1] * s, upx, upy, upz) ? 1 : 0;
      const j = L.def.at === 'front' ? 1 : D.spine.length;
      const a = L.def.at === 'front' ? 0 : j - 1;
      let ax = this.spine[a * 3] - this.spine[j * 3], az = this.spine[a * 3 + 2] - this.spine[j * 3 + 2];
      const al = Math.hypot(ax, az) || 1; ax /= al; az /= al;
      // Toes splay out a little to their side.
      const sx = -az * L.def.side, sz = ax * L.def.side;
      _z.set(ax + sx * 0.25, 0, az + sz * 0.25).normalize();
      _y.set(0, 1, 0);
      _x.crossVectors(_y, _z).normalize();
      const fl = L.def.foot * s, fw = r[2] * s * 2.2;
      _m.makeBasis(_x.multiplyScalar(fw), _y.multiplyScalar(r[2] * s * 1.6), _z.multiplyScalar(fl));
      _m.setPosition(L.ankle.x - ax * fl * 0.25, L.foot.y, L.ankle.z - az * fl * 0.25);
      n += mesh.push(Shape.Foot, _m) ? 1 : 0;
    }
    // Head and jaw.
    const hp = this.headPos, hf = this.headFwd, hu = this.headUp;
    _z.copy(hf); _y.copy(hu); _x.crossVectors(_y, _z).normalize();
    const H = D.head;
    _m.makeBasis(_x.clone().multiplyScalar(H.w * s), _y.clone().multiplyScalar(H.h * s), _z.clone().multiplyScalar(H.len * s));
    _m.setPosition(hp.x, hp.y, hp.z);
    const eg = this.eyes;
    n += mesh.push(Shape.Head, _m, 3.2 * eg, 1.6 * eg, 0.3 * eg) ? 1 : 0;
    // Jaw hinged below the skull, opened by `jaw`.
    _q.setFromAxisAngle(_x, this.jaw * 0.55);
    const jz = _z.clone().applyQuaternion(_q), jy = _y.clone().applyQuaternion(_q);
    const J = D.jaw;
    _m.makeBasis(_x.clone().multiplyScalar(J.w * s), jy.multiplyScalar(J.h * s), jz.multiplyScalar(J.len * s));
    _m.setPosition(hp.x - hu.x * H.h * s * 0.1 + hf.x * H.len * s * 0.06, hp.y - hu.y * H.h * s * 0.1 + hf.y * H.len * s * 0.06, hp.z - hu.z * H.h * s * 0.1 + hf.z * H.len * s * 0.06);
    n += mesh.push(Shape.Jaw, _m, 2.6 * th, 1.1 * th, 0.25 * th) ? 1 : 0;
    // Dorsal plates: on top of their segment, edge along the spine; the ridge glow runs from the tail to the head.
    const P = D.plates;
    for (let k = 0; k < P.length; k++) {
      const p = P[k];
      const c = p.chain === 'spine' ? this.spine : p.chain === 'neck' ? this.neck : this.tail;
      const R = p.chain === 'spine' ? D.spineR : p.chain === 'neck' ? D.neckR : D.tailR;
      const i = p.seg;
      const ax = c[i * 3], ay = c[i * 3 + 1], az = c[i * 3 + 2], bx = c[i * 3 + 3], by = c[i * 3 + 4], bz = c[i * 3 + 5];
      const px = ax + (bx - ax) * p.t, py = ay + (by - ay) * p.t, pz = az + (bz - az) * p.t;
      _z.set(bx - ax, by - ay, bz - az).normalize();
      if (p.chain !== 'neck') _z.negate();
      _y.set(upx, upy, upz);
      _y.addScaledVector(_z, -_y.dot(_z)).normalize();
      _x.crossVectors(_y, _z).normalize();
      const rr = R[Math.min(i, R.length - 1)] * s * 0.85;
      _m.makeBasis(_x.multiplyScalar(s * 1.1), _y.clone().multiplyScalar(p.h * s), _z.multiplyScalar(p.len * s));
      _m.setPosition(px + _y.x * rr, py + _y.y * rr, pz + _y.z * rr);
      // The wave: plates nearest the tail light first.
      const order = 1 - k / Math.max(1, P.length - 1);
      const gl = Math.max(0, Math.min(1, this.ridge * 1.6 - order * 0.6));
      n += mesh.push(Shape.Plate, _m, 0.6 * gl * gl * 4, 1.4 * gl * gl * 4, 3.2 * gl * gl * 4) ? 1 : 0;
    }
    void fx; void fz;
    return n;
  }

  /** One chain segment as a spindle (radii across: rx sideways, rz up/down). */
  private seg(mesh: CreatureMesh, c: Float64Array, i: number, rx: number, rz: number, upx: number, upy: number, upz: number, gr: number, gg: number, gb: number): boolean {
    _v.x = c[i * 3]; _v.y = c[i * 3 + 1]; _v.z = c[i * 3 + 2];
    _w.x = c[i * 3 + 3]; _w.y = c[i * 3 + 4]; _w.z = c[i * 3 + 5];
    return this.spindle(mesh, _v, _w, rx, rz, upx, upy, upz, gr, gg, gb);
  }

  private bone(mesh: CreatureMesh, a: Vec3, b: Vec3, r: number, upx: number, upy: number, upz: number): boolean {
    return this.spindle(mesh, a, b, r, r, upx, upy, upz, 0, 0, 0);
  }

  private spindle(mesh: CreatureMesh, a: Vec3, b: Vec3, rx: number, rz: number, upx: number, upy: number, upz: number, gr: number, gg: number, gb: number): boolean {
    _y.set(b.x - a.x, b.y - a.y, b.z - a.z);
    const len = _y.length();
    if (len < 1e-4) return false;
    _y.divideScalar(len);
    // Z: the body's up, made perpendicular to the segment (back up, belly down).
    _z.set(upx, upy, upz).addScaledVector(_y, -(upx * _y.x + upy * _y.y + upz * _y.z));
    if (_z.lengthSq() < 1e-6) _z.set(1, 0, 0).addScaledVector(_y, -_y.x);
    _z.normalize();
    _x.crossVectors(_y, _z).normalize();
    _m.makeBasis(_x.multiplyScalar(rx), _y.multiplyScalar(len), _z.multiplyScalar(rz));
    _m.setPosition(a.x, a.y, a.z);
    return mesh.push(Shape.Spindle, _m, gr, gg, gb);
  }

  // ------------------------------------------------------------------ hit queries

  /** Ray against the body: nearest capsule hit (t, zone) or null. */
  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): { t: number; cap: Capsule } | null {
    let best = maxT, bc: Capsule | null = null;
    for (const c of this.caps) {
      const t = rayCapsule(ox, oy, oz, dx, dy, dz, c, best);
      if (t < best) { best = t; bc = c; }
    }
    return bc ? { t: best, cap: bc } : null;
  }

  /** Nearest capsule to a point and the distance to its surface (negative inside). */
  nearest(x: number, y: number, z: number): { d: number; cap: Capsule } | null {
    let best = Infinity, bc: Capsule | null = null;
    for (const c of this.caps) {
      const d = capsuleDist(x, y, z, c);
      if (d < best) { best = d; bc = c; }
    }
    return bc ? { d: best, cap: bc } : null;
  }
}

function scaled(a: number[], s: number): number[] {
  if (s === 1) return a;
  return a.map((v) => v * s);
}

/** Distance from a point to a capsule's surface (negative inside). */
export function capsuleDist(x: number, y: number, z: number, c: Capsule): number {
  const ux = c.bx - c.ax, uy = c.by - c.ay, uz = c.bz - c.az;
  const L2 = ux * ux + uy * uy + uz * uz;
  let t = L2 > 0 ? ((x - c.ax) * ux + (y - c.ay) * uy + (z - c.az) * uz) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - c.ax - ux * t, y - c.ay - uy * t, z - c.az - uz * t) - c.r;
}

/** Ray (unit d) vs capsule: entry distance or Infinity. */
export function rayCapsule(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, c: Capsule, maxT: number): number {
  // Sphere-march would be simpler; solve against the infinite cylinder and the two end spheres.
  let best = Infinity;
  const ux = c.bx - c.ax, uy = c.by - c.ay, uz = c.bz - c.az;
  const L = Math.hypot(ux, uy, uz);
  const r = c.r;
  if (L > 1e-6) {
    const ax = ux / L, ay = uy / L, az = uz / L;
    const px = ox - c.ax, py = oy - c.ay, pz = oz - c.az;
    const dd = dx * ax + dy * ay + dz * az, pd = px * ax + py * ay + pz * az;
    const qx = dx - ax * dd, qy = dy - ay * dd, qz = dz - az * dd;
    const wx = px - ax * pd, wy = py - ay * pd, wz = pz - az * pd;
    const A = qx * qx + qy * qy + qz * qz, B = 2 * (qx * wx + qy * wy + qz * wz), Cc = wx * wx + wy * wy + wz * wz - r * r;
    if (A > 1e-9) {
      const disc = B * B - 4 * A * Cc;
      if (disc >= 0) {
        const t = (-B - Math.sqrt(disc)) / (2 * A);
        const along = pd + dd * t;
        if (t >= 0 && along >= 0 && along <= L) best = t;
      }
    }
  }
  for (const [sx, sy, sz] of [[c.ax, c.ay, c.az], [c.bx, c.by, c.bz]]) {
    const px = ox - sx, py = oy - sy, pz = oz - sz;
    const b = px * dx + py * dy + pz * dz, cc = px * px + py * py + pz * pz - r * r;
    const disc = b * b - cc;
    if (disc < 0) continue;
    const t = -b - Math.sqrt(disc);
    if (t >= 0 && t < best) best = t;
    else if (cc < 0) best = Math.min(best, 0);
  }
  return best <= maxT ? best : Infinity;
}
