/**
 * One physical ragdoll: 14 Rapier rigid bodies (see skeleton.ts) joined by ball joints with
 * per-axis limits (spine, neck, shoulders, hips, ankles) and limited hinges (elbows, knees),
 * with a little joint friction (zero-velocity motors) and angular damping so it does not flail.
 *
 * Size: the body plan is in the rig's model units; `s` scales it to the world (a 0.1 m or a
 * 100 m person is the same plan). Masses follow the volume (∝ k³); damping rates follow the
 * body's own time scale (∝ 1/√k), like the player's gait.
 *
 * Collision: like the near-future robots, ragdolls ignore the coarse city heightfield and
 * collide with the exact local ground (street patches, building prisms: LocalGround), debris,
 * robots and each other. Arms do not collide with other ragdoll parts (they start out lying
 * against the torso); legs, torso and head do (joined parts never collide).
 *
 * `pos`/`rot` hold the parts' world transforms (body origin = the driver bone's head); they
 * survive `release()`, so a settled ragdoll keeps its final pose without any bodies.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import { GROUPS } from '../Physics';
import { PARTS, PART_COUNT, Part, type RagDims } from './skeleton';

export interface PhysicsLike { R: typeof RAPIER; world: RAPIER.World }

const MASS_SUM = PARTS.reduce((s, p) => s + p.mass, 0);
/** Body mass of a 1.76 m person (kg). */
const BASE_MASS = 72;

// Rapier (Raw)JointAxis values: angular X, Y, Z (the raw joint set takes them directly).
const ANG_X = 3;

const _q = { x: 0, y: 0, z: 0, w: 1 };
const _v = { x: 0, y: 0, z: 0 };
const _a = { x: 0, y: 0, z: 0 };
const _b = { x: 0, y: 0, z: 0 };

/** Rotate (x, y, z) by quaternion q (array at offset o) into out. */
export function qrot(q: ArrayLike<number>, o: number, x: number, y: number, z: number, out: { x: number; y: number; z: number }): void {
  const qx = q[o], qy = q[o + 1], qz = q[o + 2], qw = q[o + 3];
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
}

export class Ragdoll {
  readonly bodies: RAPIER.RigidBody[] = [];
  readonly pos = new Float32Array(PART_COUNT * 3);
  readonly rot = new Float32Array(PART_COUNT * 4);
  /** Total mass (kg). */
  readonly mass: number;
  /** Size factor: stature / 1.8 m. */
  readonly k: number;
  /** Largest part speed (m/s) and angular speed (rad/s) at the last read. */
  maxV = 0;
  maxW = 0;
  /** Mean velocity of the body (m/s) at the last read. */
  readonly vel = { x: 0, y: 0, z: 0 };

  constructor(private P: PhysicsLike, readonly dims: RagDims, readonly s: number) {
    this.k = (dims.height * s) / 1.8;
    this.mass = BASE_MASS * Math.pow((dims.height * s) / 1.76, 3);
  }

  get live(): boolean { return this.bodies.length > 0; }

  /**
   * Place the parts by forward kinematics from the pelvis (the joints start closed): the
   * caller fills `rot` with the parts' world rotations; the pelvis goes to (px, py, pz).
   */
  placeFromPelvis(px: number, py: number, pz: number): void {
    const o = this.dims.origin, s = this.s, P = this.pos;
    P[0] = px; P[1] = py; P[2] = pz;
    for (let i = 1; i < PART_COUNT; i++) {
      const p = PARTS[i].parent;
      qrot(this.rot, p * 4, (o[i][0] - o[p][0]) * s, (o[i][1] - o[p][1]) * s, (o[i][2] - o[p][2]) * s, _v);
      P[i * 3] = P[p * 3] + _v.x; P[i * 3 + 1] = P[p * 3 + 1] + _v.y; P[i * 3 + 2] = P[p * 3 + 2] + _v.z;
    }
  }

  /** Create the bodies at `pos`/`rot`, all moving at (vx, vy, vz). */
  spawn(vx: number, vy: number, vz: number): void {
    if (this.live) return;
    const R = this.P.R, W = this.P.world, d = this.dims, s = this.s;
    const sk = Math.sqrt(this.k);
    for (let i = 0; i < PART_COUNT; i++) {
      const def = PARTS[i];
      _q.x = this.rot[i * 4]; _q.y = this.rot[i * 4 + 1]; _q.z = this.rot[i * 4 + 2]; _q.w = this.rot[i * 4 + 3];
      const desc = R.RigidBodyDesc.dynamic()
        .setTranslation(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2])
        .setRotation(_q)
        .setLinvel(vx, vy, vz)
        .setLinearDamping(0.05 / sk)
        .setAngularDamping(1.1 / sk)
        .setCcdEnabled(true)
        .setAdditionalSolverIterations(2)
        .setCanSleep(true);
      const b = W.createRigidBody(desc);
      const sh = d.shape[i];
      let cd: RAPIER.ColliderDesc;
      if (sh.kind === 'capsule') {
        const ax = (sh.b[0] - sh.a[0]) * s, ay = (sh.b[1] - sh.a[1]) * s, az = (sh.b[2] - sh.a[2]) * s;
        const l = Math.hypot(ax, ay, az) || 1e-4;
        cd = R.ColliderDesc.capsule(Math.max(1e-4, l / 2), sh.r * s)
          .setTranslation((sh.a[0] + sh.b[0]) * 0.5 * s, (sh.a[1] + sh.b[1]) * 0.5 * s, (sh.a[2] + sh.b[2]) * 0.5 * s);
        // Rotate the capsule's local Y onto the segment.
        const ux = ax / l, uy = ay / l, uz = az / l;
        if (uy < -0.9999) { _q.x = 1; _q.y = 0; _q.z = 0; _q.w = 0; } else {
          // q = (Y × u, 1 + Y·u), normalised.
          const qx = uz, qy = 0, qz = -ux, qw = 1 + uy, n = Math.hypot(qx, qy, qz, qw);
          _q.x = qx / n; _q.y = qy / n; _q.z = qz / n; _q.w = qw / n;
        }
        cd.setRotation(_q);
      } else if (sh.kind === 'box') {
        const r = Math.min(sh.r, sh.half[0] * 0.9, sh.half[1] * 0.9, sh.half[2] * 0.9);
        cd = R.ColliderDesc.roundCuboid((sh.half[0] - r) * s, (sh.half[1] - r) * s, (sh.half[2] - r) * s, r * s)
          .setTranslation(sh.a[0] * s, sh.a[1] * s, sh.a[2] * s);
      } else {
        cd = R.ColliderDesc.ball(sh.r * s).setTranslation(sh.a[0] * s, sh.a[1] * s, sh.a[2] * s);
      }
      cd.setMass(this.mass * def.mass / MASS_SUM).setFriction(0.8).setRestitution(0.05)
        .setCollisionGroups(def.arm ? GROUPS.ragdollArm : GROUPS.ragdoll);
      W.createCollider(cd, b);
      this.bodies.push(b);
    }
    // Joints: anchors at the child's origin (its driver bone head) in both bodies. Motors give
    // joint friction (damping) and a faint muscle tone toward a relaxed pose (stiffness), both
    // in the body's own time scale.
    const damp = 1.4 / sk, tone = 3 / this.k;
    for (let i = 1; i < PART_COUNT; i++) {
      const def = PARTS[i], p = def.parent;
      _a.x = (d.origin[i][0] - d.origin[p][0]) * s; _a.y = (d.origin[i][1] - d.origin[p][1]) * s; _a.z = (d.origin[i][2] - d.origin[p][2]) * s;
      _b.x = _b.y = _b.z = 0;
      const L = def.limits;
      if (def.joint === 'hinge') {
        const h = d.hinge[i];
        const j = W.createImpulseJoint(R.JointData.revolute(_a, _b, { x: h[0], y: h[1], z: h[2] }), this.bodies[p], this.bodies[i], true) as RAPIER.RevoluteImpulseJoint;
        j.setLimits(L[0], L[1]);
        j.configureMotor(def.relax[0] ?? 0, 0, tone * 4, damp);
        j.setContactsEnabled(false);
      } else {
        const j = W.createImpulseJoint(R.JointData.spherical(_a, _b), this.bodies[p], this.bodies[i], true) ;
        const raw = W.impulseJoints.raw;
        raw.jointSetLimits(j.handle, ANG_X as never, L[0], L[1]);
        raw.jointSetLimits(j.handle, (ANG_X + 1) as never, L[2], L[3]);
        raw.jointSetLimits(j.handle, (ANG_X + 2) as never, L[4], L[5]);
        for (let k = 0; k < 3; k++) raw.jointConfigureMotor(j.handle, (ANG_X + k) as never, def.relax[k] ?? 0, 0, tone, damp);
        j.setContactsEnabled(false);
      }
    }
    this.read();
  }

  /** Copy the bodies' world transforms into pos/rot; update the speed measures. */
  read(): void {
    const B = this.bodies;
    if (!B.length) return;
    let mv = 0, mw = 0, sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      const t = b.translation(), q = b.rotation(), v = b.linvel(), w = b.angvel();
      this.pos[i * 3] = t.x; this.pos[i * 3 + 1] = t.y; this.pos[i * 3 + 2] = t.z;
      this.rot[i * 4] = q.x; this.rot[i * 4 + 1] = q.y; this.rot[i * 4 + 2] = q.z; this.rot[i * 4 + 3] = q.w;
      const sv = v.x * v.x + v.y * v.y + v.z * v.z, sw = w.x * w.x + w.y * w.y + w.z * w.z;
      if (sv > mv) mv = sv;
      if (sw > mw) mw = sw;
      sx += v.x; sy += v.y; sz += v.z;
    }
    this.maxV = Math.sqrt(mv);
    this.maxW = Math.sqrt(mw);
    this.vel.x = sx / B.length; this.vel.y = sy / B.length; this.vel.z = sz / B.length;
  }

  /** World centre of a part's collider. */
  partCentre(i: number, out: { x: number; y: number; z: number }): void {
    const sh = this.dims.shape[i], s = this.s;
    const cx = sh.kind === 'capsule' ? (sh.a[0] + sh.b[0]) * 0.5 : sh.a[0];
    const cy = sh.kind === 'capsule' ? (sh.a[1] + sh.b[1]) * 0.5 : sh.a[1];
    const cz = sh.kind === 'capsule' ? (sh.a[2] + sh.b[2]) * 0.5 : sh.a[2];
    qrot(this.rot, i * 4, cx * s, cy * s, cz * s, out);
    out.x += this.pos[i * 3]; out.y += this.pos[i * 3 + 1]; out.z += this.pos[i * 3 + 2];
  }

  /** Change the velocity of every part by (vx, vy, vz) × its weight (default 1). */
  addVelocity(vx: number, vy: number, vz: number, weights?: ArrayLike<number>): void {
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i], w = weights ? weights[i] : 1;
      const v = b.linvel();
      _v.x = v.x + vx * w; _v.y = v.y + vy * w; _v.z = v.z + vz * w;
      b.setLinvel(_v, true);
    }
  }

  /** An impulse (N·s) at a world point: on the part nearest to it (spins the body). */
  impulseAt(jx: number, jy: number, jz: number, px: number, py: number, pz: number): void {
    if (!this.live) return;
    let best = 0, bd = Infinity;
    for (let i = 0; i < PART_COUNT; i++) {
      this.partCentre(i, _v);
      const d = (_v.x - px) ** 2 + (_v.y - py) ** 2 + (_v.z - pz) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    // A point far outside the body (an area effect) acts at the nearest part's centre.
    this.partCentre(best, _v);
    const reach = this.dims.height * this.s * 0.25;
    if (bd > reach * reach) { px = _v.x; py = _v.y; pz = _v.z; }
    _a.x = jx; _a.y = jy; _a.z = jz; _b.x = px; _b.y = py; _b.z = pz;
    this.bodies[best].applyImpulseAtPoint(_a, _b, true);
  }

  /** Move the whole body (pushed out of a wall); `kill` removes the velocity along (nx, nz). */
  translate(dx: number, dy: number, dz: number, nx = 0, nz = 0): void {
    for (const b of this.bodies) {
      const t = b.translation();
      _v.x = t.x + dx; _v.y = t.y + dy; _v.z = t.z + dz;
      b.setTranslation(_v, true);
      if (nx || nz) {
        const v = b.linvel(), into = v.x * nx + v.z * nz;
        if (into < 0) { _v.x = v.x - into * nx; _v.y = v.y; _v.z = v.z - into * nz; b.setLinvel(_v, true); }
      }
    }
    this.read();
  }

  /** Remove the bodies (pos/rot keep the last pose). */
  release(): void {
    const W = this.P.world;
    for (const b of this.bodies) W.removeRigidBody(b);
    this.bodies.length = 0;
  }

  /** Pelvis world position. */
  get px(): number { return this.pos[Part.Pelvis * 3]; }
  get py(): number { return this.pos[Part.Pelvis * 3 + 1]; }
  get pz(): number { return this.pos[Part.Pelvis * 3 + 2]; }
}
