/**
 * Main-thread spatial index of the loaded city for physics-ish queries:
 * building prisms (2D footprint + base/top), ground surfaces (road vs raised
 * sidewalk/lot), bridge decks, and ray casts against all of them.
 */
import type { Terrain } from './terrain';
import type { CellState } from '../stream/CityStreamer';
import type { BuildingDesc } from '../plan/building';
import type { Shape } from '../core/clip';
import { pointInPoly, polyBounds } from '../core/geom2';
import { CURB_H } from '../build/ground';
import type { BridgeProfile } from '../build/bridges';
import { BINFO_STRIDE } from '../stream/protocol';

/** A carriageway shape with its bounds and its holes' bounds (min x, min z, max x, max z). */
interface BoxedShape { outer: number[]; ob: [number, number, number, number]; holes: { poly: number[]; b: [number, number, number, number] }[] }

export interface BuildingRef {
  cell: CellState;
  index: number;
  desc: BuildingDesc;
  poly: number[];
  base: number;
  low: number;
  top: number;
  bounds: [number, number, number, number];
  elemBase: number;
  elemCount: number;
  /** Bumped when damaged so caches can refresh. */
  alive: boolean;
}

const B = 32;
const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);

export class WorldIndex {
  private grid = new Map<number, BuildingRef[]>();
  private cellRefs = new Map<number, BuildingRef[]>();
  private cellShapes = new Map<number, { cell: CellState; bounds: [number, number, number, number]; carr: BoxedShape[]; poly: number[] }>();
  bridges: BridgeProfile[] = [];

  constructor(readonly terrain: Terrain, private cellPolys: (id: number) => number[]) {}

  addCell(cs: CellState): void {
    if (!cs.plan || !cs.binfo) return;
    const refs: BuildingRef[] = [];
    cs.plan.buildings.forEach((b, i) => {
      const o = i * BINFO_STRIDE;
      const f = cs.binfo!;
      const bounds = polyBounds(b.poly);
      const ref: BuildingRef = {
        cell: cs, index: i, desc: b, poly: b.poly, base: f[o], low: f[o + 7], top: f[o] + f[o + 1], bounds,
        elemBase: f[o + 2], elemCount: f[o + 3], alive: true,
      };
      refs.push(ref);
      for (let x = Math.floor(bounds[0] / B); x <= Math.floor(bounds[2] / B); x++)
        for (let z = Math.floor(bounds[1] / B); z <= Math.floor(bounds[3] / B); z++) {
          const k = key(x, z);
          let l = this.grid.get(k);
          if (!l) this.grid.set(k, (l = []));
          l.push(ref);
        }
    });
    this.cellRefs.set(cs.id, refs);
    const poly = this.cellPolys(cs.id);
    // Carriageway shapes with their bounds (and their holes'): surfaceOffset is asked for every
    // sample of a physics ground patch, and point-in-polygon on every hole was most of it.
    const carr = cs.plan.carriageway.map((sh: Shape) => ({ outer: sh.outer, ob: polyBounds(sh.outer), holes: sh.holes.map((h) => ({ poly: h, b: polyBounds(h) })) }));
    this.cellShapes.set(cs.id, { cell: cs, bounds: polyBounds(poly), carr, poly });
  }

  removeCell(cs: CellState): void {
    const refs = this.cellRefs.get(cs.id);
    if (refs) {
      for (const ref of refs) {
        const b = ref.bounds;
        for (let x = Math.floor(b[0] / B); x <= Math.floor(b[2] / B); x++)
          for (let z = Math.floor(b[1] / B); z <= Math.floor(b[3] / B); z++) {
            const l = this.grid.get(key(x, z));
            if (!l) continue;
            const i = l.indexOf(ref);
            if (i >= 0) l.splice(i, 1);
            if (!l.length) this.grid.delete(key(x, z));
          }
      }
    }
    this.cellRefs.delete(cs.id);
    this.cellShapes.delete(cs.id);
  }

  /** The buildings of a loaded cell (saves: collapsed buildings). */
  cellBuildings(id: number): readonly BuildingRef[] {
    return this.cellRefs.get(id) ?? [];
  }

  buildingsIn(x0: number, z0: number, x1: number, z1: number, out: BuildingRef[] = []): BuildingRef[] {
    out.length = 0;
    const seen = new Set<BuildingRef>();
    for (let x = Math.floor(x0 / B); x <= Math.floor(x1 / B); x++)
      for (let z = Math.floor(z0 / B); z <= Math.floor(z1 / B); z++) {
        const l = this.grid.get(key(x, z));
        if (!l) continue;
        for (const r of l) {
          if (seen.has(r)) continue;
          seen.add(r);
          if (r.bounds[0] > x1 || r.bounds[2] < x0 || r.bounds[1] > z1 || r.bounds[3] < z0) continue;
          out.push(r);
        }
      }
    return out;
  }

  buildingAt(x: number, z: number): BuildingRef | null {
    const l = this.grid.get(key(Math.floor(x / B), Math.floor(z / B)));
    if (!l) return null;
    for (const r of l) {
      if (x < r.bounds[0] || x > r.bounds[2] || z < r.bounds[1] || z > r.bounds[3]) continue;
      if (r.alive && pointInPoly(r.poly, x, z)) return r;
    }
    return null;
  }

  /** Urban surface offset above natural terrain: 0 on roads, curb height elsewhere in the city. */
  surfaceOffset(x: number, z: number): number {
    for (const s of this.cellShapes.values()) {
      const b = s.bounds;
      if (x < b[0] || x > b[2] || z < b[1] || z > b[3]) continue;
      if (!pointInPoly(s.poly, x, z)) continue;
      for (const sh of s.carr) {
        const ob = sh.ob;
        if (x < ob[0] || x > ob[2] || z < ob[1] || z > ob[3]) continue;
        if (pointInPoly(sh.outer, x, z)) {
          let inHole = false;
          for (const h of sh.holes) {
            const hb = h.b;
            if (x < hb[0] || x > hb[2] || z < hb[1] || z > hb[3]) continue;
            if (pointInPoly(h.poly, x, z)) { inHole = true; break; }
          }
          if (!inHole) return 0;
        }
      }
      return CURB_H;
    }
    return 0;
  }

  /**
   * Bridge deck height at (x,z) or -Infinity. With a heading (hx, hz) only decks running
   * that way count (a car on the bank road under a bridge stays on the bank road).
   */
  bridgeDeck(x: number, z: number, hx = 0, hz = 0): number {
    for (const b of this.bridges) {
      const dx = x - b.ax, dz = z - b.az;
      const s = dx * b.dx + dz * b.dz;
      if (s < b.s0 || s > b.s1) continue;
      if ((hx || hz) && Math.abs(hx * b.dx + hz * b.dz) < 0.5) continue;
      const o = -dx * b.dz + dz * b.dx;
      if (Math.abs(o) > b.width / 2) continue;
      return b.y(s) + (Math.abs(o) > b.width / 2 - 2.5 ? CURB_H : 0);
    }
    return -Infinity;
  }

  /**
   * Walkable ground height below `yRef` (+ step tolerance): terrain/streets, bridge decks
   * and flat building roofs.
   */
  groundHeight(x: number, z: number, yRef = Infinity, step = 0.5): number {
    let g = this.terrain.height(x, z) + this.surfaceOffset(x, z);
    const deck = this.bridgeDeck(x, z);
    if (deck > -Infinity && deck <= yRef + step) g = Math.max(g, deck);
    const b = this.buildingAt(x, z);
    if (b && b.top <= yRef + step) g = Math.max(g, b.top);
    return g;
  }

  /** Ray cast against terrain and building prisms. Returns hit distance or Infinity. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, stepLen = 1): { t: number; building: BuildingRef | null } {
    const n = Math.ceil(maxDist / stepLen);
    let prevAbove = true;
    for (let i = 1; i <= n; i++) {
      const t = (i / n) * maxDist;
      const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
      const g = this.terrain.height(x, z);
      if (y < g) return { t: refine(this, ox, oy, oz, dx, dy, dz, ((i - 1) / n) * maxDist, t), building: null };
      const b = this.buildingAt(x, z);
      if (b && y < b.top && y > b.low) return { t, building: b };
      prevAbove = true;
    }
    void prevAbove;
    return { t: Infinity, building: null };
  }
}

function refine(w: WorldIndex, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, a: number, b: number): number {
  for (let k = 0; k < 8; k++) {
    const m = (a + b) / 2;
    const y = oy + dy * m;
    if (y < w.terrain.height(ox + dx * m, oz + dz * m)) b = m; else a = m;
  }
  return (a + b) / 2;
}
