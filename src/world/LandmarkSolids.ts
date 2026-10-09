/**
 * The landmarks' solid parts (plan/landmarkParts) for the main thread: an obstacle provider for
 * the walker's collision (walls stop, tops can be stood on), the highest top under a point (the
 * physics ground, roofs, stands) and a point-inside test for ray casts (camera, aiming, sight).
 * All landmarks are known from the start (they are part of the macro plan), so the index is built
 * once: a 32 m grid of obstacle indices. Also the walkable insides (the town hall): where one is
 * indoors, and the room lights near a point. Helix walkways (the marvels' glazed spirals) are
 * solved analytically: their floors and outer walls become obstacles only around the query, a
 * short piece of each turn passing there.
 *
 * Breakable landmarks (destruction/LandmarkWreck) are cut along their piece grid where they get
 * damaged: an obstacle there becomes one per grid level, and a level stops blocking when most of
 * its pieces are broken. Helix walkways check the piece at the point.
 */
import type { MacroPlan } from '../plan/types';
import type { Terrain } from './terrain';
import { landmarkParts, landmarkInterior, partObstacles, helixFloorAt, helixFloorsAt, HELIX_SLAB, PK, type PartObstacle, type LmInterior, type LmPart } from '../plan/landmarkParts';
import { pointInPoly } from '../core/geom2';
import type { ObstacleProvider } from './Collision';
import { PIECE_STRIDE, gridKey, gridCells, keyAt, type WreckGrid } from '../build/landmarkDice';

const G = 32;
/** Helix walkway solids: slab depth under the floor, outer wall thickness, rise per collision piece. */
const SLAB = 0.8, WALL = 0.15, RISE = 0.3;
const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);

/** A grid level of a damaged landmark's obstacle: blocks while at least half its pieces stand. */
interface Band { o: PartObstacle; n: number; live: number }
interface WreckLink {
  g: WreckGrid; T: Float32Array; alive: Uint8Array; ids: Map<number, number>;
  /** The landmark's obstacles not cut into levels yet. */
  whole: number[];
  /** Bands holding each piece. */
  bands: Map<number, Band[]>;
}

export class LandmarkSolids {
  readonly obs: PartObstacle[] = [];
  private grid = new Map<number, number[]>();
  /** Query stamp per obstacle (dedupe across grid cells). */
  private stamp: Uint32Array;
  private q = 0;

  /** Walkable insides of the landmarks that have one. */
  readonly insides: LmInterior[] = [];
  /** Helix walkways (their opaque parts). */
  readonly helices: LmPart[] = [];
  /** Landmark (index) of each helix. */
  private helixLm: number[] = [];
  private pool: PartObstacle[] = [];
  private floors: number[] = [];
  /** Obstacles of each landmark: [first, end). */
  private lmObs: [number, number][] = [];
  private wrecks = new Map<number, WreckLink>();

  constructor(macro: MacroPlan, terrain: Terrain) {
    (macro.landmarks ?? []).forEach((lm, li) => {
      const parts = landmarkParts(lm, terrain);
      const first = this.obs.length;
      for (const o of partObstacles(parts)) this.obs.push(o);
      this.lmObs.push([first, this.obs.length]);
      for (const p of parts) if (p.k === PK.Helix && !p.clear) { this.helices.push(p); this.helixLm.push(li); }
      const ins = landmarkInterior(lm, terrain);
      if (ins) this.insides.push(ins);
    });
    this.obs.forEach((o, n) => this.index(o, n));
    this.stamp = new Uint32Array(this.obs.length);
  }

  private index(o: PartObstacle, n: number): void {
    const [e, f] = reach(o);
    for (let i = Math.floor((o.x - e) / G); i <= Math.floor((o.x + e) / G); i++)
      for (let j = Math.floor((o.z - f) / G); j <= Math.floor((o.z + f) / G); j++) {
        const k = key(i, j);
        let l = this.grid.get(k);
        if (!l) this.grid.set(k, (l = []));
        l.push(n);
      }
  }

  // ------------------------------------------------------------ breakable landmarks

  /** A breakable landmark's pieces (its grid, piece table and live alive flags). */
  attachWreck(index: number, g: WreckGrid, T: Float32Array, alive: Uint8Array): void {
    const ids = new Map<number, number>();
    for (let p = 0; p < T.length / PIECE_STRIDE; p++) ids.set(T[p * PIECE_STRIDE], p);
    const [a, b] = this.lmObs[index] ?? [0, 0];
    const whole: number[] = [];
    for (let n = a; n < b; n++) whole.push(n);
    this.wrecks.set(index, { g, T, alive, ids, whole, bands: new Map() });
  }

  /** Is the piece at the point of a breakable landmark standing (no piece there: yes)? */
  private standing(lm: number, x: number, y: number, z: number): boolean {
    const w = this.wrecks.get(lm);
    if (!w) return true;
    const p = w.ids.get(keyAt(w.g, x, y, z));
    return p === undefined || !!w.alive[p];
  }

  /** Pieces of a breakable landmark broke (already marked in its alive flags). */
  piecesBroken(index: number, pieces: number[]): void {
    const w = this.wrecks.get(index);
    if (!w) return;
    const T = w.T;
    for (const p of pieces) {
      for (const b of w.bands.get(p) ?? []) {
        b.live--;
        if (b.live < b.n * 0.5) b.o.dead = true;
      }
      // Obstacles around the piece not cut yet: cut them into levels now.
      const o5 = p * PIECE_STRIDE;
      for (let m = w.whole.length - 1; m >= 0; m--) {
        const o = this.obs[w.whole[m]];
        const [e, f] = reach(o);
        if (o.x + e < T[o5 + 5] || o.x - e > T[o5 + 8] || o.z + f < T[o5 + 7] || o.z - f > T[o5 + 10] || o.y1 < T[o5 + 6] || o.y0 > T[o5 + 9]) continue;
        w.whole.splice(m, 1);
        this.cut(w, o);
      }
    }
  }

  /** Replace an obstacle by one per grid level, each knowing its pieces. */
  private cut(w: WreckLink, o: PartObstacle): void {
    const g = w.g;
    o.dead = true;
    const k0 = Math.max(0, Math.floor((o.y0 - g.y0) / g.ch)), k1 = Math.min(g.ny - 1, Math.floor((o.y1 - 1e-3 - g.y0) / g.ch));
    // Grid cells the footprint covers (cell centres inside it, grown by half a cell's diagonal).
    const [e, f] = reach(o);
    const cells: [number, number][] = [];
    const ui = (x: number, z: number) => { const dx = x - g.x, dz = z - g.z; return [dx * g.c + dz * g.s, -dx * g.s + dz * g.c]; };
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const [u, v] = ui(o.x + sx * e, o.z + sz * f);
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const grow = g.cs * 0.71;
    for (let i = Math.max(0, Math.floor((u0 - g.u0) / g.cs)); i <= Math.min(g.nu - 1, Math.floor((u1 - g.u0) / g.cs)); i++)
      for (let j = Math.max(0, Math.floor((v0 - g.v0) / g.cs)); j <= Math.min(g.nv - 1, Math.floor((v1 - g.v0) / g.cs)); j++) {
        const u = g.u0 + (i + 0.5) * g.cs, v = g.v0 + (j + 0.5) * g.cs;
        const x = g.x + u * g.c - v * g.s, z = g.z + u * g.s + v * g.c;
        if (this.inside(o, x, z, grow)) cells.push([i, j]);
      }
    // (Window glass follows the glass pieces of its cells.)
    const off = o.pane ? gridCells(g) : 0;
    for (let k = k0; k <= k1; k++) {
      const b: Band = { o: { ...o, dead: false, y0: Math.max(o.y0, g.y0 + k * g.ch), y1: Math.min(o.y1, g.y0 + (k + 1) * g.ch) }, n: 0, live: 0 };
      for (const [i, j] of cells) {
        const p = w.ids.get(gridKey(g, i, j, k) + off);
        if (p === undefined) continue;
        b.n++;
        b.live += w.alive[p];
        let l = w.bands.get(p);
        if (!l) w.bands.set(p, (l = []));
        l.push(b);
      }
      if (b.n && b.live < b.n * 0.5) b.o.dead = true;
      const n = this.obs.length;
      this.obs.push(b.o);
      this.index(b.o, n);
    }
    if (this.stamp.length < this.obs.length) {
      const s = new Uint32Array(this.obs.length * 2);
      s.set(this.stamp);
      this.stamp = s;
    }
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
          const o = this.obs[n];
          if (!o.dead) fn(o);
        }
      }
  }

  /** Obstacle provider for world/Collision. */
  provider: ObstacleProvider = (x0, z0, x1, z1, out) => {
    this.each(x0, z0, x1, z1, out);
    this.helices.forEach((p, i) => this.helixPieces(p, this.helixLm[i], x0, z0, x1, z1, out));
  };

  /**
   * The pieces of a helix walkway over the box: per turn passing there, a slab under each short
   * stretch of floor (its top the floor at the stretch's upper end, so one walks up without
   * sinking) and the outer wall beside it.
   */
  private helixPieces(p: LmPart, lm: number, x0: number, z0: number, x1: number, z1: number, out: (o: PartObstacle) => void): void {
    const R2 = p.r2!, R1 = p.r!, cx = p.x, cz = p.z, T = Math.PI * 2;
    if (x1 < cx - R2 - 1 || x0 > cx + R2 + 1 || z1 < cz - R2 - 1 || z0 > cz + R2 + 1) return;
    const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, ext = Math.hypot(x1 - x0, z1 - z0) / 2 + 1, d = Math.hypot(mx - cx, mz - cz);
    if (d - ext > R2) return;
    const turns = Math.abs(p.turns!), sg = p.turns! < 0 ? -1 : 1, full = turns * T;
    const rise = Math.abs(p.y1 - p.y0);
    const n = Math.max(8, Math.ceil(Math.max(full / 0.1, rise / RISE))), dphi = full / n;
    let pa: number, pb: number;
    if (d - ext < R1 * 0.5 || ext >= d) { pa = 0; pb = T; }
    else {
      const c = Math.atan2(mz - cz, mx - cx), half = Math.asin(Math.min(1, ext / d));
      pa = sg * (c - half - p.a); pb = sg * (c + half - p.a);
      if (pa > pb) [pa, pb] = [pb, pa];
      const sh = Math.floor(pa / T) * T;
      pa -= sh; pb -= sh;
    }
    const rm = (R1 + R2) / 2, chord = dphi * R2 / 2 + 0.05;
    let used = 0;
    for (let k = -1; pa + k * T <= full; k++) {
      const lo = pa + k * T, hi = pb + k * T;
      if (hi <= 0) continue;
      const i0 = Math.max(0, Math.floor(lo / dphi)), i1 = Math.min(n - 1, Math.floor(hi / dphi));
      for (let i = i0; i <= i1; i++) {
        const th = p.a + sg * (i + 0.5) * dphi, c = Math.cos(th), s = Math.sin(th);
        const top = helixFloorAt(p, (i + 1) * dphi);
        for (const wall of [false, true]) {
          let o = this.pool[used];
          if (!o) this.pool.push((o = { cyl: false, x: 0, z: 0, r: 0, hx: 0, hz: 0, ux: 1, uz: 0, y0: 0, y1: 0 }));
          used++;
          const rr = wall ? R2 - WALL : rm;
          o.x = cx + c * rr; o.z = cz + s * rr; o.ux = -s; o.uz = c; o.hx = chord;
          o.hz = wall ? WALL : (R2 - R1) / 2;
          o.y0 = top - SLAB; o.y1 = wall ? top + p.hh! : top;
          if (this.wrecks.has(lm) && !this.standing(lm, o.x, top - 0.2, o.z)) continue;
          out(o);
        }
      }
    }
  }

  /** Is (x, z) inside the obstacle's footprint (grown by m)? */
  private inside(o: PartObstacle, x: number, z: number, m = 0): boolean {
    const dx = x - o.x, dz = z - o.z;
    if (o.cyl) return dx * dx + dz * dz < (o.r + m) * (o.r + m);
    return Math.abs(dx * o.ux + dz * o.uz) < o.hx + m && Math.abs(-dx * o.uz + dz * o.ux) < o.hz + m;
  }

  /** Highest solid top under (x, z) not above yRef + step (-Infinity: none). */
  topAt(x: number, z: number, yRef = Infinity, step = 0.5, minH = 0): number {
    let g = -Infinity;
    // (minH: as world/Collision for a walker, slabs thinner than that only count as decks.)
    this.each(x, z, x, z, (o) => { if (o.y1 > g && o.y1 <= yRef + step && (o.y1 - o.y0 >= minH || o.deck) && this.inside(o, x, z)) g = o.y1; });
    this.helices.forEach((p, i) => {
      for (const f of helixFloorsAt(p, x, z, 0, this.floors)) if (f > g && f <= yRef + step && this.standing(this.helixLm[i], x, f - 0.2, z)) g = f;
    });
    return g;
  }

  /** Is the point inside a solid? */
  hit(x: number, y: number, z: number): boolean {
    let h = false;
    this.each(x, z, x, z, (o) => { if (!h && y > o.y0 && y < o.y1 && this.inside(o, x, z)) h = true; });
    if (h) return true;
    for (let i = 0; i < this.helices.length; i++) {
      const p = this.helices[i];
      const fl = helixFloorsAt(p, x, z, 0, this.floors);
      if (!fl.length) continue;
      const wall = Math.hypot(x - p.x, z - p.z) > p.r2! - WALL;
      for (const f of fl) if (((y > f - HELIX_SLAB && y < f) || (wall && y >= f && y < f + p.hh!)) && this.standing(this.helixLm[i], x, f - 0.2, z)) return true;
    }
    return false;
  }

  /** The inside (x, y, z) is in, or null. */
  insideAt(x: number, y: number, z: number): LmInterior | null {
    for (const ins of this.insides) for (const rm of ins.rooms) if (y > rm.y0 && y < rm.y1 && pointInPoly(rm.poly, x, z)) return ins;
    return null;
  }

  /** Room lights of the inside the point is in, nearest first (x, y, z, distance). */
  lightsNear(x: number, y: number, z: number): { x: number; y: number; z: number; d: number }[] {
    const ins = this.insideAt(x, y, z);
    if (!ins) return [];
    const out: { x: number; y: number; z: number; d: number }[] = [];
    const L = ins.lights;
    for (let i = 0; i < L.length; i += 3) out.push({ x: L[i], y: L[i + 1], z: L[i + 2], d: Math.hypot(L[i] - x, L[i + 1] - y, L[i + 2] - z) });
    return out.sort((a, b) => a.d - b.d);
  }

  /** Is (x, z) on a landmark's footprint at ground level (grown by m)? */
  onFootprint(x: number, z: number, m = 0): boolean {
    let h = false;
    this.each(x - m, z - m, x + m, z + m, (o) => { if (!h && this.inside(o, x, z, m)) h = true; });
    return h;
  }
}

/** Half extents of an obstacle's footprint along x and z. */
function reach(o: PartObstacle): [number, number] {
  return o.cyl ? [o.r, o.r] : [Math.abs(o.hx * o.ux) + Math.abs(o.hz * o.uz), Math.abs(o.hx * o.uz) + Math.abs(o.hz * o.ux)];
}
