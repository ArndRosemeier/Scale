/**
 * Exact local ground for the near-future layer's small rigid bodies (knocked robots, falling
 * drones). The city heightfield (Physics.ensureGround) samples roofs every 2 m, so at a
 * building edge it ramps from the street to the roof: a robot shoved against a wall slid up
 * that ramp, tunnelled under it or came to rest half inside the building. Instead these bodies
 * (GROUPS.smallBody) ignore the heightfield and collide with
 *   - street-level heightfield patches (terrain + kerb, low bridge decks; 1 m resolution), and
 *   - building prisms: each footprint as a closed trimesh from below the ground to its roof
 *     (walls stop them, flat roofs catch falling drones).
 * Both are created on demand around a body and dropped when unused; prisms follow damage
 * (a building that collapsed or got shorter is rebuilt / removed). Last resort for anything
 * that still ends up in a footprint: `resolve` pushes a point out through the nearest wall.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import earcut from 'earcut';
import { GROUPS } from '../physics/Physics';
import { pointInPoly } from '../core/geom2';
import type { BuildingRef } from '../world/WorldIndex';
import type { FutureCtx } from './ctx';

const PATCH = 32;
const RES = 32;

export class LocalGround {
  private patches = new Map<number, { c: RAPIER.Collider; used: number }>();
  private prisms = new Map<BuildingRef, { c: RAPIER.Collider; used: number; top: number }>();
  private t = 0;
  stats = { patches: 0, prisms: 0 };

  constructor(private ctx: FutureCtx) {}

  /** Street ground (no roofs) at a point: terrain, kerb, low bridge decks below yRef. */
  streetY(x: number, z: number, yRef = Infinity): number {
    const W = this.ctx.world;
    const g = this.ctx.terrain.height(x, z) + W.surfaceOffset(x, z);
    const deck = W.bridgeDeck(x, z);
    return deck > g && deck <= yRef + 1 ? deck : g;
  }

  /** Make sure street patches and building prisms exist within r of (x, z). */
  ensure(x: number, z: number, r: number, yRef = Infinity): void {
    const P = this.ctx.physics, R = P.R;
    const i0 = Math.floor((x - r) / PATCH), i1 = Math.floor((x + r) / PATCH);
    const j0 = Math.floor((z - r) / PATCH), j1 = Math.floor((z + r) / PATCH);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const key = (i + 32768) * 65536 + (j + 32768);
      const p = this.patches.get(key);
      if (p) { p.used = this.t; continue; }
      const n = RES + 1, h = new Float32Array(n * n);
      const x0 = i * PATCH, z0 = j * PATCH;
      // Column-major like Physics.ensureGround: index = row(z) + col(x) * (nrows + 1).
      for (let cx = 0; cx < n; cx++) for (let rz = 0; rz < n; rz++) h[rz + cx * n] = this.streetY(x0 + (cx / RES) * PATCH, z0 + (rz / RES) * PATCH, yRef);
      const desc = R.ColliderDesc.heightfield(RES, RES, h, { x: PATCH, y: 1, z: PATCH })
        .setTranslation(x0 + PATCH / 2, 0, z0 + PATCH / 2).setFriction(0.9).setCollisionGroups(GROUPS.localGround);
      this.patches.set(key, { c: P.world.createCollider(desc), used: this.t });
    }
    for (const b of this.ctx.world.buildingsIn(x - r, z - r, x + r, z + r)) {
      if (!b.alive) continue;
      const p = this.prisms.get(b);
      if (p && Math.abs(p.top - b.top) < 0.05) { p.used = this.t; continue; }
      if (p) { P.world.removeCollider(p.c, false); this.prisms.delete(b); }
      const c = this.prism(b);
      if (c) this.prisms.set(b, { c, used: this.t, top: b.top });
    }
    this.stats.patches = this.patches.size;
    this.stats.prisms = this.prisms.size;
  }

  /** A footprint extruded from below the street to the roof as a closed trimesh. */
  private prism(b: BuildingRef): RAPIER.Collider | null {
    const P = b.poly, n = P.length / 2;
    if (n < 3 || b.top - b.base < 0.5) return null;
    const y0 = Math.min(b.low, b.base) - 2, y1 = b.top;
    const v = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      v.set([P[i * 2], y0, P[i * 2 + 1]], i * 3);
      v.set([P[i * 2], y1, P[i * 2 + 1]], (n + i) * 3);
    }
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      idx.push(i, j, n + j, i, n + j, n + i);
    }
    const cap = earcut(P);
    for (let k = 0; k < cap.length; k += 3) {
      idx.push(n + cap[k], n + cap[k + 1], n + cap[k + 2]);
      idx.push(cap[k], cap[k + 2], cap[k + 1]);
    }
    const R = this.ctx.physics.R;
    const desc = R.ColliderDesc.trimesh(v, new Uint32Array(idx));
    if (!desc) return null;
    desc.setFriction(0.7).setCollisionGroups(GROUPS.localGround);
    return this.ctx.physics.world.createCollider(desc);
  }

  /**
   * A point inside a footprint below its roof: the nearest point just outside its walls
   * (margin m), else null. For bodies that got in anyway (spawned overlapping, huge impulses).
   */
  resolve(x: number, y: number, z: number, margin: number): { x: number; z: number; nx: number; nz: number } | null {
    const b = this.ctx.world.buildingAt(x, z);
    if (!b || y > b.top - 0.05) return null;
    const P = b.poly, n = P.length / 2;
    let best = Infinity, qx = x, qz = z;
    for (let i = 0; i < n; i++) {
      const ax = P[i * 2], az = P[i * 2 + 1], bx = P[((i + 1) % n) * 2], bz = P[((i + 1) % n) * 2 + 1];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(px - x, pz - z);
      if (d < best) { best = d; qx = px; qz = pz; }
    }
    let nx = qx - x, nz = qz - z;
    const l = Math.hypot(nx, nz) || 1;
    nx /= l; nz /= l;
    let ox = qx + nx * margin, oz = qz + nz * margin;
    // A concave corner or a neighbouring building: try a little further out.
    for (let k = 0; k < 4 && this.ctx.world.buildingAt(ox, oz); k++) { ox += nx * margin; oz += nz * margin; }
    if (pointInPoly(P, ox, oz)) return null;
    return { x: ox, z: oz, nx, nz };
  }

  /** Drop what has not been used for a while, and prisms of buildings that are gone. */
  update(dt: number): void {
    this.t += dt;
    if (Math.floor(this.t) === Math.floor(this.t - dt)) return;
    const W = this.ctx.physics.world;
    for (const [k, p] of this.patches) if (this.t - p.used > 30) { W.removeCollider(p.c, false); this.patches.delete(k); }
    for (const [b, p] of this.prisms) if (this.t - p.used > 30 || !b.alive) { W.removeCollider(p.c, false); this.prisms.delete(b); }
    this.stats.patches = this.patches.size;
    this.stats.prisms = this.prisms.size;
  }

  /** Something big changed the city here: rebuild the patches on next use. */
  invalidate(x0: number, z0: number, x1: number, z1: number): void {
    const W = this.ctx.physics.world;
    for (const [k, p] of this.patches) {
      const i = Math.floor(k / 65536) - 32768, j = (k % 65536) - 32768;
      if ((i + 1) * PATCH < x0 || i * PATCH > x1 || (j + 1) * PATCH < z0 || j * PATCH > z1) continue;
      W.removeCollider(p.c, false);
      this.patches.delete(k);
    }
  }
}
