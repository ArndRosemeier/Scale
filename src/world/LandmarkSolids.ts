/**
 * The landmarks' solid parts (plan/landmarkParts) for the main thread: an obstacle provider for
 * the walker's collision (walls stop, tops can be stood on), the highest top under a point (the
 * physics ground, roofs, stands) and a point-inside test for ray casts (camera, aiming, sight).
 * All landmarks are known from the start (they are part of the macro plan), so the index is built
 * once: a 32 m grid of obstacle indices.
 */
import type { MacroPlan } from '../plan/types';
import type { Terrain } from './terrain';
import { landmarkParts, partObstacles, type PartObstacle } from '../plan/landmarkParts';
import type { ObstacleProvider } from './Collision';

const G = 32;
const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);

export class LandmarkSolids {
  readonly obs: PartObstacle[] = [];
  private grid = new Map<number, number[]>();
  /** Query stamp per obstacle (dedupe across grid cells). */
  private stamp: Uint32Array;
  private q = 0;

  constructor(macro: MacroPlan, terrain: Terrain) {
    for (const lm of macro.landmarks ?? []) for (const o of partObstacles(landmarkParts(lm, terrain))) this.obs.push(o);
    this.obs.forEach((o, n) => {
      const e = o.cyl ? o.r : Math.abs(o.hx * o.ux) + Math.abs(o.hz * o.uz);
      const f = o.cyl ? o.r : Math.abs(o.hx * o.uz) + Math.abs(o.hz * o.ux);
      for (let i = Math.floor((o.x - e) / G); i <= Math.floor((o.x + e) / G); i++)
        for (let j = Math.floor((o.z - f) / G); j <= Math.floor((o.z + f) / G); j++) {
          const k = key(i, j);
          let l = this.grid.get(k);
          if (!l) this.grid.set(k, (l = []));
          l.push(n);
        }
    });
    this.stamp = new Uint32Array(this.obs.length);
  }

  /** Obstacles overlapping the box (each once). */
  private each(x0: number, z0: number, x1: number, z1: number, fn: (o: PartObstacle) => void): void {
    if (!this.obs.length) return;
    const q = ++this.q;
    for (let i = Math.floor(x0 / G); i <= Math.floor(x1 / G); i++)
      for (let j = Math.floor(z0 / G); j <= Math.floor(z1 / G); j++) {
        const l = this.grid.get(key(i, j));
        if (!l) continue;
        for (const n of l) {
          if (this.stamp[n] === q) continue;
          this.stamp[n] = q;
          fn(this.obs[n]);
        }
      }
  }

  /** Obstacle provider for world/Collision. */
  provider: ObstacleProvider = (x0, z0, x1, z1, out) => this.each(x0, z0, x1, z1, out);

  /** Is (x, z) inside the obstacle's footprint (grown by m)? */
  private inside(o: PartObstacle, x: number, z: number, m = 0): boolean {
    const dx = x - o.x, dz = z - o.z;
    if (o.cyl) return dx * dx + dz * dz < (o.r + m) * (o.r + m);
    return Math.abs(dx * o.ux + dz * o.uz) < o.hx + m && Math.abs(-dx * o.uz + dz * o.ux) < o.hz + m;
  }

  /** Highest solid top under (x, z) not above yRef + step (-Infinity: none). */
  topAt(x: number, z: number, yRef = Infinity, step = 0.5): number {
    let g = -Infinity;
    this.each(x, z, x, z, (o) => { if (o.y1 > g && o.y1 <= yRef + step && this.inside(o, x, z)) g = o.y1; });
    return g;
  }

  /** Is the point inside a solid? */
  hit(x: number, y: number, z: number): boolean {
    let h = false;
    this.each(x, z, x, z, (o) => { if (!h && y > o.y0 && y < o.y1 && this.inside(o, x, z)) h = true; });
    return h;
  }

  /** Is (x, z) on a landmark's footprint at ground level (grown by m)? */
  onFootprint(x: number, z: number, m = 0): boolean {
    let h = false;
    this.each(x - m, z - m, x + m, z + m, (o) => { if (!h && this.inside(o, x, z, m)) h = true; });
    return h;
  }
}
