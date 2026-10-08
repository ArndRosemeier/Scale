/**
 * The game's line of sight (`game.sight`): the shared LineOfSight (los.ts) over the real world —
 * the building grid (WorldIndex) refined by the standing facade panels (Targeting.facadeT: a hole
 * blasted in a wall lets a line through), the terrain, and every vehicle — moving traffic and
 * wrecks from a 16 m grid rebuilt at most ten times a second, parked cars (thousands, standing
 * still) from one rebuilt only when the parked list changes or every few seconds; both only when
 * someone asks.
 *
 * Everybody who shoots goes through `clear`: Firearms (police, SWAT, criminals, officers against
 * the Strider), the army's direct fire (Forces), the player's directed powers (Elements.aim).
 */
import type { Game } from '../Game';
import type { BuildingRef } from '../../world/WorldIndex';
import type { Vehicle } from '../../sim/Traffic';
import { LineOfSight, type LosCar } from './los';

const CELL = 16;

/** Vehicles on a coarse grid (lists kept and refilled; the map dropped now and then). */
class CarGrid {
  private grid = new Map<number, Vehicle[]>();
  private rebuilds = 0;

  rebuild(list: readonly Vehicle[]): void {
    if (++this.rebuilds % 200 === 0) this.grid.clear();
    else for (const l of this.grid.values()) l.length = 0;
    for (const v of list) {
      if (!v.alive) continue;
      const k = (Math.floor(v.x / CELL) + 32768) * 65536 + (Math.floor(v.z / CELL) + 32768);
      let l = this.grid.get(k);
      if (!l) this.grid.set(k, (l = []));
      l.push(v);
    }
  }

  query(x0: number, z0: number, x1: number, z1: number, out: LosCar[], n: number): number {
    const i0 = Math.floor((x0 - 8) / CELL), i1 = Math.floor((x1 + 8) / CELL), j0 = Math.floor((z0 - 8) / CELL), j1 = Math.floor((z1 + 8) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const l = this.grid.get((i + 32768) * 65536 + (j + 32768));
      if (!l) continue;
      for (const v of l) {
        const e = v.length * 0.5 + 0.5;
        if (v.x + e < x0 || v.x - e > x1 || v.z + e < z0 || v.z - e > z1) continue;
        out[n++] = v;
      }
    }
    return n;
  }
}

export class Sight {
  readonly los: LineOfSight;
  private moving = new CarGrid();
  private parked = new CarGrid();
  private movingAt = -1e9;
  private parkedAt = -1e9;
  private parkedList: readonly Vehicle[] | null = null;
  private parkedN = -1;

  constructor(private g: Game) {
    this.los = new LineOfSight({
      building: (x, z) => g.world.buildingAt(x, z),
      ground: (x, z) => g.terrain.height(x, z),
      solid: (x, y, z) => !!g.world.landmarks?.hit(x, y, z),
      panel: (b, ox, oy, oz, dx, dy, dz, tMin, maxT) => g.targeting.facadeT(b as BuildingRef, ox, oy, oz, dx, dy, dz, tMin, maxT),
      cars: (x0, z0, x1, z1, out) => this.cars(x0, z0, x1, z1, out),
    });
  }

  /** A clear line from a to b (pad m short of b); `skip` / `skip2`: vehicles that do not count. */
  clear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, pad?: number, skip: object | null = null, skip2: object | null = null): boolean {
    // In the deep realm's caves the rock is the only thing in the way (the ground is far above).
    const cave = this.g.underground?.caveLine(ax, ay, az, bx, by, bz, pad ?? 0);
    if (cave !== null && cave !== undefined) return cave;
    // In the sewers, the metro and the rooms: the tunnel walls (the street overhead is not in the way).
    const tunnel = this.g.underground?.tunnelLine(ax, ay, az, bx, by, bz, pad ?? 0);
    if (tunnel !== null && tunnel !== undefined) return tunnel;
    return this.los.clear(ax, ay, az, bx, by, bz, pad, skip, skip2);
  }

  get stats(): LineOfSight['stats'] { return this.los.stats; }

  private cars(x0: number, z0: number, x1: number, z1: number, out: LosCar[]): number {
    const now = performance.now();
    if (now - this.movingAt > 100) { this.movingAt = now; this.moving.rebuild(this.g.traffic.vehicles); }
    const P = this.g.parkedCars;
    if (P !== this.parkedList || P.length !== this.parkedN || now - this.parkedAt > 3000) {
      this.parkedAt = now; this.parkedList = P; this.parkedN = P.length;
      this.parked.rebuild(P);
    }
    return this.parked.query(x0, z0, x1, z1, out, this.moving.query(x0, z0, x1, z1, out, 0));
  }
}
