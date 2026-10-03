/**
 * Rapier physics, used only where things are breaking: debris fragments,
 * toppling props and vehicles. Static terrain colliders are heightfield
 * patches created around activity and dropped when idle. Fixed 60 Hz step.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type { Terrain } from '../world/terrain';

export type R = typeof RAPIER;

const PATCH = 96;   // m per heightfield patch
const RES = 48;     // cells per side

/**
 * Collision groups (Rapier: membership << 16 | filter). Everything defaults to all groups; only
 * the near-future layer narrows it: its small bodies (robots, drones) skip the coarse city
 * heightfield (it ramps up to the roofs over 2 m at building edges, which sent them through or
 * onto walls) and collide instead with exact local ground: street-level patches and building
 * prisms that debris (spawned inside breaking walls) must not touch.
 */
export const GROUPS = {
  /** The city heightfield patches (terrain, roofs, bridges). */
  cityGround: (0x0001 << 16) | 0xffff,
  /** Exact local ground near small bodies: street patches, building walls and roofs. */
  localGround: (0x0002 << 16) | 0xffff,
  /** Robots, drones: everything but the city heightfield. */
  smallBody: (0x0004 << 16) | 0xfffe,
  /** Debris fragments: everything but the local ground. */
  debris: (0xfffd << 16) | 0xfffd,
  /** Ragdoll torso, head and legs (physics/ragdoll): like small bodies, and against each other. */
  ragdoll: (0x0008 << 16) | 0xfffe,
  /** Ragdoll arms: like small bodies, but not against any ragdoll part (they lie against the torso). */
  ragdollArm: (0x0010 << 16) | (0xfffe & ~0x0018),
};

export class Physics {
  R!: R;
  world!: RAPIER.World;
  private acc = 0;
  private patches = new Map<string, { collider: RAPIER.Collider; used: number }>();
  private t = 0;
  private extraStatics: { collider: RAPIER.Collider; until: number }[] = [];

  constructor(private terrain: Terrain, private groundFn: (x: number, z: number) => number) {}

  async init(): Promise<void> {
    await RAPIER.init();
    this.R = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.integrationParameters.numSolverIterations = 4;
  }

  /** Make sure ground exists under (x,z) within radius r. */
  ensureGround(x: number, z: number, r = 30): void {
    const i0 = Math.floor((x - r) / PATCH), i1 = Math.floor((x + r) / PATCH);
    const j0 = Math.floor((z - r) / PATCH), j1 = Math.floor((z + r) / PATCH);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const key = `${i},${j}`;
      const p = this.patches.get(key);
      if (p) { p.used = this.t; continue; }
      const n = RES + 1;
      const heights = new Float32Array(n * n);
      const x0 = i * PATCH, z0 = j * PATCH;
      // Column-major: index = row(z) + col(x) * (nrows + 1)
      for (let cx = 0; cx < n; cx++) for (let rz = 0; rz < n; rz++) {
        heights[rz + cx * n] = this.groundFn(x0 + (cx / RES) * PATCH, z0 + (rz / RES) * PATCH);
      }
      const desc = this.R.ColliderDesc.heightfield(RES, RES, heights, { x: PATCH, y: 1, z: PATCH })
        .setTranslation(x0 + PATCH / 2, 0, z0 + PATCH / 2)
        .setFriction(0.9)
        .setCollisionGroups(GROUPS.cityGround);
      const collider = this.world.createCollider(desc);
      this.patches.set(key, { collider, used: this.t });
    }
  }

  /**
   * The ground changed in this box (a building collapsed or got shorter): drop the cached
   * heightfield patches there. They are rebuilt from the current world on next use, so
   * debris no longer lands on an invisible roof.
   */
  invalidateGround(x0: number, z0: number, x1: number, z1: number): void {
    const i0 = Math.floor(x0 / PATCH), i1 = Math.floor(x1 / PATCH), j0 = Math.floor(z0 / PATCH), j1 = Math.floor(z1 / PATCH);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const key = `${i},${j}`;
      const p = this.patches.get(key);
      if (!p) continue;
      this.world.removeCollider(p.collider, true);
      this.patches.delete(key);
    }
  }

  /** Temporary static box (e.g. remaining building stump) for debris to rest on. */
  addStaticBox(x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw: number, seconds: number): void {
    const q = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
    const c = this.world.createCollider(this.R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setRotation(q).setFriction(0.8));
    this.extraStatics.push({ collider: c, until: this.t + seconds });
  }

  step(dt: number): number {
    this.t += dt;
    this.acc += Math.min(dt, 0.1);
    const h = 1 / 60;
    let steps = 0;
    while (this.acc >= h && steps < 3) {
      this.world.timestep = h;
      this.world.step();
      this.acc -= h;
      steps++;
    }
    if (this.acc > h) this.acc = 0;
    // Drop idle ground patches and expired statics.
    if (Math.floor(this.t) !== Math.floor(this.t - dt)) {
      for (const [k, p] of this.patches) if (this.t - p.used > 60) { this.world.removeCollider(p.collider, false); this.patches.delete(k); }
      this.extraStatics = this.extraStatics.filter((s) => {
        if (s.until > this.t) return true;
        this.world.removeCollider(s.collider, false);
        return false;
      });
    }
    return steps;
  }

  get time(): number { return this.t; }
  void(): Terrain { return this.terrain; }
}
