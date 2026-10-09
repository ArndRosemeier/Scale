/**
 * The Burrower's body (THREATS_PLAN §1 #3): a giant worm, a chain of joints along one path.
 *
 * The body always lies along a polyline from the head back:
 *
 *   trail mode     the path the head has travelled (`trail`, oldest first): under the streets, up out
 *                  of a sinkhole, over in an arc and down into the next one — every part of the body
 *                  passes exactly where the head went (the tail slides out of the first hole and into
 *                  the second).
 *   anchored mode  standing up out of a sinkhole: from the head a smooth curve (Hermite) down to the
 *                  hole's mouth (`anchor`), leaving it straight down, then the trail below — the head
 *                  sways, rears and strikes while the column stays planted in its hole. `release`
 *                  bakes the curve into the trail when it dives on.
 *
 * Joints sit at fixed arc lengths along that polyline (`place`); frames are parallel-transported down
 * the chain from the head (no twist flips when the body stands straight up); `frames` writes the skin's
 * bones (joint frames with a slow peristaltic swell, and the three petals of the maw swung open about
 * their hinges on the lip); `caps` are the body's capsules for hits. Pure (no game), tested.
 */
import * as THREE from 'three';
import { clamp, saturate, smoothstep, v3cross, v3norm, type Vec3 } from '../../../core/math';
import type { Capsule } from '../rig/CreatureRig';

export const WORM = {
  /** Joints (0 = the head's front, at the lip) and the distance between them (m): 95 m of worm. */
  joints: 26, seg: 3.8,
  /** Radius of the lip ring (m). */
  lip: 2.9,
  /** The maw: petals, their length and hinge radius (m), how far they swing open (rad). */
  petals: 3, petalLen: 4.7, petalR: 3.0, petalOpen: 2.0,
  /** Throat depth inside the head (m). */
  throat: 5.6,
};

export const WORM_LENGTH = (WORM.joints - 1) * WORM.seg;

/** Body radius at arc length s from the lip (m; full size). */
export function wormRadius(s: number): number {
  if (s < 0) return WORM.lip;
  const head = WORM.lip + (4.35 - WORM.lip) * smoothstep(0, 14, s);
  const tail = s < 52 ? 1 : 1 - 0.32 * smoothstep(52, 78, s) - 0.5 * smoothstep(78, WORM_LENGTH, s);
  return Math.max(0.35, head * tail);
}

/** The skin's bones: 0 = parameters (glows), 1 + i = joint i, then the petals. */
export const WORM_BONES = { count: WORM.joints + 1 + WORM.petals, joint0: 1, petal0: 1 + WORM.joints };

/** Petal k in the head frame (X right, Y up, Z forward): its hinge point on the lip and its hinge axis. */
export function petalHinge(k: number): { h: Vec3; axis: Vec3; d: Vec3 } {
  const a = (k / WORM.petals) * Math.PI * 2;
  // Radial direction (petal 0 on top), the hinge on the lip ring, the axis z × d (opening swings the tip out).
  const d: Vec3 = [Math.sin(a), Math.cos(a), 0];
  return { h: [d[0] * WORM.petalR, d[1] * WORM.petalR, 0.15], axis: [-d[1], d[0], 0], d };
}

const _m = new THREE.Matrix4(), _r = new THREE.Matrix4(), _t = new THREE.Matrix4(), _ax = new THREE.Vector3();

export class WormRig {
  readonly n = WORM.joints;
  /** Joint positions (0 = the head's front). */
  readonly j: Float64Array;
  /** Per joint: forward (towards the head), up (the back), right. */
  readonly fw: Float64Array;
  readonly up: Float64Array;
  readonly rt: Float64Array;
  /** Body size (× the full-size metres). */
  scale = 1;
  /** The head's front and the way it faces (unit). */
  readonly head = { x: 0, y: 0, z: 0 };
  readonly dir = { x: 0, y: 0, z: -1 };
  /** The maw open 0..1, the glows (side pits: a wave from tail to head; the gullet) 0..1. */
  petal = 0;
  pits = 0;
  maw = 0;
  /** Swell / pulse clock. */
  t = 0;
  /** Lying dead: no swell. */
  still = false;
  /** The way the head has come (x, y, z …, oldest first). */
  private trail: number[] = [];
  /** Standing in a sinkhole: the hole's mouth (the body leaves it straight down). */
  anchor: { x: number; y: number; z: number } | null = null;
  readonly caps: Capsule[] = [];
  /** Ground height (terrain / street) at a point: the body never lies through it outside its holes. */
  ground: ((x: number, z: number) => number) | null = null;
  /** Holes the body may pass the ground through (x, z, r). */
  holes: { x: number; z: number; r: number }[] = [];
  private prevUp: Vec3 = [0, 1, 0];
  private poly: number[] = [];
  private polyS: number[] = [];

  constructor(scale = 1) {
    this.scale = scale;
    this.j = new Float64Array(this.n * 3);
    this.fw = new Float64Array(this.n * 3);
    this.up = new Float64Array(this.n * 3);
    this.rt = new Float64Array(this.n * 3);
    for (let i = 0; i < this.n; i++) this.caps.push({ ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, r: 1, zone: i === 0 ? 'head' : 'body' });
  }

  get length(): number { return WORM_LENGTH * this.scale; }

  /** Lay the whole body straight behind a head at (x, y, z) facing (dx, dy, dz) (trail mode). */
  reset(x: number, y: number, z: number, dx: number, dy: number, dz: number): void {
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    this.trail.length = 0;
    const L = this.length + 12;
    for (let s = L; s >= 0; s -= 3) this.trail.push(x - dx * s, y - dy * s, z - dz * s);
    this.anchor = null;
    this.head.x = x; this.head.y = y; this.head.z = z;
    this.dir.x = dx; this.dir.y = dy; this.dir.z = dz;
    this.place();
  }

  /** Move the head (trail mode: the trail grows behind it; anchored: only the curve moves). */
  moveHead(x: number, y: number, z: number): void {
    this.head.x = x; this.head.y = y; this.head.z = z;
    if (this.anchor) return;
    const T = this.trail, k = T.length - 3;
    if (k < 0 || Math.hypot(x - T[k], y - T[k + 1], z - T[k + 2]) > 0.35 * this.scale) T.push(x, y, z);
    this.trim();
  }

  setDir(dx: number, dy: number, dz: number): void {
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-6) return;
    this.dir.x = dx / l; this.dir.y = dy / l; this.dir.z = dz / l;
  }

  /** Stand in a hole: the head has come up through (x, y, z); the trail is cut back to it. */
  anchorAt(x: number, y: number, z: number): void {
    const T = this.trail;
    while (T.length > 6 && T[T.length - 2] > y + 0.05) T.length -= 3;
    T.push(x, y, z);
    this.anchor = { x, y, z };
  }

  /** Leave the anchored stance (it dives on): the curve from the hole up to the head becomes trail. */
  release(): void {
    const A = this.anchor;
    if (!A) return;
    const pts = this.curve(24);
    // (curve runs head → hole; the trail takes it hole → head, the hole itself is already in it.)
    for (let i = pts.length - 6; i >= 0; i -= 3) this.trail.push(pts[i], pts[i + 1], pts[i + 2]);
    this.anchor = null;
    this.trim();
  }

  /** How much of the body stands out of its hole (m along the curve; 0 in trail mode). */
  exposed(): number {
    if (!this.anchor) return 0;
    const c = this.curve(16);
    let L = 0;
    for (let i = 3; i < c.length; i += 3) L += Math.hypot(c[i] - c[i - 3], c[i + 1] - c[i - 2], c[i + 2] - c[i - 1]);
    return L;
  }

  /** The Hermite curve from the head (leaving backwards) down into the anchor (arriving straight down): x, y, z … */
  private curve(k: number): number[] {
    const A = this.anchor!, H = this.head, D = this.dir;
    const span = Math.hypot(H.x - A.x, H.y - A.y, H.z - A.z);
    const m = Math.max(4, span * 1.15);
    const out: number[] = [];
    for (let i = 0; i <= k; i++) {
      const t = i / k, t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      // Tangent at the head: backwards (−dir); at the hole: down.
      out.push(
        h00 * H.x + h10 * -D.x * m + h01 * A.x,
        h00 * H.y + h10 * -D.y * m + h01 * A.y + h11 * -m,
        h00 * H.z + h10 * -D.z * m + h01 * A.z,
      );
    }
    return out;
  }

  /** Drop trail older than the body needs. */
  private trim(): void {
    const T = this.trail, need = this.length + 20;
    let L = 0, i = T.length - 3;
    for (; i >= 3; i -= 3) {
      L += Math.hypot(T[i] - T[i - 3], T[i + 1] - T[i - 2], T[i + 2] - T[i - 1]);
      if (L > need) break;
    }
    if (i > 3) T.splice(0, i - 3);
  }

  /** Put the joints along the body's polyline and work out their frames. */
  place(): void {
    const P = this.poly;
    P.length = 0;
    const H = this.head;
    if (this.anchor) {
      const c = this.curve(20);
      for (let i = 0; i < c.length; i += 3) P.push(c[i], c[i + 1], c[i + 2]);
      const T = this.trail;
      for (let i = T.length - 6; i >= 0; i -= 3) P.push(T[i], T[i + 1], T[i + 2]);
    } else {
      P.push(H.x, H.y, H.z);
      const T = this.trail;
      for (let i = T.length - 3; i >= 0; i -= 3) if (i < T.length - 3 || Math.hypot(T[i] - H.x, T[i + 1] - H.y, T[i + 2] - H.z) > 1e-3) P.push(T[i], T[i + 1], T[i + 2]);
    }
    this.keepAboveGround(P);
    // Arc lengths, then the joints at fixed spacing (extended straight past the end).
    const S = this.polyS;
    S.length = 0;
    S.push(0);
    for (let i = 3; i < P.length; i += 3) S.push(S[S.length - 1] + Math.hypot(P[i] - P[i - 3], P[i + 1] - P[i - 2], P[i + 2] - P[i - 1]));
    const seg = WORM.seg * this.scale, J = this.j;
    let k = 0;
    for (let i = 0; i < this.n; i++) {
      const s = i * seg;
      while (k + 1 < S.length - 1 && S[k + 1] < s) k++;
      if (S.length < 2) { J[i * 3] = H.x - this.dir.x * s; J[i * 3 + 1] = H.y - this.dir.y * s; J[i * 3 + 2] = H.z - this.dir.z * s; continue; }
      const a = k * 3, b = (k + 1) * 3, ds = S[k + 1] - S[k];
      const t = ds > 1e-6 ? (s - S[k]) / ds : 0;
      // (Past the end: on along the last piece.)
      J[i * 3] = P[a] + (P[b] - P[a]) * t;
      J[i * 3 + 1] = P[a + 1] + (P[b + 1] - P[a + 1]) * t;
      J[i * 3 + 2] = P[a + 2] + (P[b + 2] - P[a + 2]) * t;
    }
    this.framesOfChain();
    this.updateCaps();
  }

  /**
   * The body lies on the street, never through it, except where it goes down a hole: points above
   * ground stay, points below it outside every hole are lifted to rest on it (a body draped over the
   * street when it falls; a dive arc that dips beside the hole).
   */
  private keepAboveGround(P: number[]): void {
    const G = this.ground;
    if (!G) return;
    // Underground stretches (the trail under the streets) stay where they are: only points the body
    // reaches from the surface side are lifted — a run of points from the head while it is up.
    if (this.head.y < G(this.head.x, this.head.z) - 1) return;
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], z = P[i + 2];
      if (this.holes.some((h) => Math.hypot(x - h.x, z - h.z) < h.r * 0.95)) break;
      const r = wormRadius((i / 3) * 2) * this.scale * 0.85;
      const g = G(x, z) + r;
      if (P[i + 1] < g) P[i + 1] = g;
    }
  }

  private framesOfChain(): void {
    const J = this.j, F = this.fw, U = this.up, R = this.rt, n = this.n;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let fx = J[a * 3] - J[b * 3], fy = J[a * 3 + 1] - J[b * 3 + 1], fz = J[a * 3 + 2] - J[b * 3 + 2];
      let l = Math.hypot(fx, fy, fz);
      if (l < 1e-6) { fx = this.dir.x; fy = this.dir.y; fz = this.dir.z; l = 1; }
      F[i * 3] = fx / l; F[i * 3 + 1] = fy / l; F[i * 3 + 2] = fz / l;
    }
    // The head's up: the world's up where it faces sideways, the last one where it points up or down.
    const f0: Vec3 = [F[0], F[1], F[2]];
    const proj = (u: Vec3, f: Vec3): Vec3 => { const d = u[0] * f[0] + u[1] * f[1] + u[2] * f[2]; return [u[0] - f[0] * d, u[1] - f[1] * d, u[2] - f[2] * d]; };
    const w = saturate((1 - Math.abs(f0[1])) * 3);
    const pw = proj([0, 1, 0], f0), pp = proj(this.prevUp, f0);
    let u: Vec3 = [pw[0] * w + pp[0] * (1 - w), pw[1] * w + pp[1] * (1 - w), pw[2] * w + pp[2] * (1 - w)];
    if (Math.hypot(u[0], u[1], u[2]) < 1e-4) u = Math.abs(f0[0]) < 0.9 ? proj([1, 0, 0], f0) : proj([0, 0, 1], f0);
    u = v3norm(u);
    this.prevUp = u;
    for (let i = 0; i < n; i++) {
      const f: Vec3 = [F[i * 3], F[i * 3 + 1], F[i * 3 + 2]];
      let q = proj(u, f);
      if (Math.hypot(q[0], q[1], q[2]) < 1e-5) q = Math.abs(f[0]) < 0.9 ? proj([1, 0, 0], f) : proj([0, 0, 1], f);
      u = v3norm(q);
      const r = v3cross(u, f);
      U[i * 3] = u[0]; U[i * 3 + 1] = u[1]; U[i * 3 + 2] = u[2];
      R[i * 3] = r[0]; R[i * 3 + 1] = r[1]; R[i * 3 + 2] = r[2];
    }
  }

  private updateCaps(): void {
    const J = this.j, s = this.scale, seg = WORM.seg;
    for (let i = 0; i < this.n; i++) {
      const c = this.caps[i];
      const a = i * 3, b = Math.min(this.n - 1, i + 1) * 3;
      c.ax = J[a]; c.ay = J[a + 1]; c.az = J[a + 2];
      c.bx = J[b]; c.by = J[b + 1]; c.bz = J[b + 2];
      c.r = wormRadius((i + 0.5) * seg) * s * 0.92;
    }
  }

  /** Swell of joint i now (a slow peristaltic wave, ±3 %). */
  private swell(i: number): number { return this.still ? 1 : 1 + 0.03 * Math.sin(this.t * 1.7 - i * 0.55); }

  /** The bones (16 floats each, column-major, X right / Y up / Z forward): joints, then the petals. */
  frames(out: Float32Array): void {
    const J = this.j, F = this.fw, U = this.up, R = this.rt, s = this.scale;
    for (let i = 0; i < this.n; i++) {
      const k = (WORM_BONES.joint0 + i) * 16, w = this.swell(i) * s;
      out[k] = R[i * 3] * w; out[k + 1] = R[i * 3 + 1] * w; out[k + 2] = R[i * 3 + 2] * w; out[k + 3] = 0;
      out[k + 4] = U[i * 3] * w; out[k + 5] = U[i * 3 + 1] * w; out[k + 6] = U[i * 3 + 2] * w; out[k + 7] = 0;
      out[k + 8] = F[i * 3] * s; out[k + 9] = F[i * 3 + 1] * s; out[k + 10] = F[i * 3 + 2] * s; out[k + 11] = 0;
      out[k + 12] = J[i * 3]; out[k + 13] = J[i * 3 + 1]; out[k + 14] = J[i * 3 + 2]; out[k + 15] = 1;
    }
    // Petals: the head frame × (about the hinge) a turn by the opening.
    const head = _m.fromArray(out, WORM_BONES.joint0 * 16);
    const open = clamp(this.petal, 0, 1.15) * WORM.petalOpen;
    for (let p = 0; p < WORM.petals; p++) {
      const h = petalHinge(p);
      _ax.set(h.axis[0], h.axis[1], h.axis[2]);
      _r.makeTranslation(h.h[0], h.h[1], h.h[2]).multiply(_t.makeRotationAxis(_ax, open)).multiply(_t.makeTranslation(-h.h[0], -h.h[1], -h.h[2]));
      _t.copy(head).multiply(_r).toArray(out, (WORM_BONES.petal0 + p) * 16);
    }
  }

  /** Bind frames (the worm straight along −Z from the lip at the origin, petals shut). */
  static bindFrames(): Float32Array {
    const out = new Float32Array(WORM_BONES.count * 16);
    for (let b = 1; b < WORM_BONES.count; b++) {
      const i = b - WORM_BONES.joint0;
      const z = i < WORM.joints ? -i * WORM.seg : 0;
      new THREE.Matrix4().makeTranslation(0, 0, z).toArray(out, b * 16);
    }
    return out;
  }

  /** The point of the head (between the petals) and the gullet's mouth, for effects. */
  mouth(): { x: number; y: number; z: number } {
    const k = 0, f = this.fw;
    const L = 1.2 * this.scale;
    return { x: this.j[k] + f[0] * L, y: this.j[k + 1] + f[1] * L, z: this.j[k + 2] + f[2] * L };
  }

  /** Nearest capsule to a point (distance to its surface, negative inside) among those `ok` accepts. */
  nearest(x: number, y: number, z: number, ok?: (i: number) => boolean): { d: number; i: number } | null {
    let bd = Infinity, bi = -1;
    for (let i = 0; i < this.n - 1; i++) {
      if (ok && !ok(i)) continue;
      const c = this.caps[i];
      const ux = c.bx - c.ax, uy = c.by - c.ay, uz = c.bz - c.az, L2 = ux * ux + uy * uy + uz * uz || 1;
      const t = clamp(((x - c.ax) * ux + (y - c.ay) * uy + (z - c.az) * uz) / L2, 0, 1);
      const d = Math.hypot(x - c.ax - ux * t, y - c.ay - uy * t, z - c.az - uz * t) - c.r;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi >= 0 ? { d: bd, i: bi } : null;
  }
}
