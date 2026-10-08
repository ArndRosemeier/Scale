/**
 * The filler: puts furniture into an Area (fill/area) by rules instead of fixed slots. The caller
 * (a theme, see fill/home) lists what it wants in order of importance, each piece saying where it
 * goes (against a wall or free-standing), how much clear floor it needs in front, whether it is
 * tall (no tall pieces in front of windows), hung on a wall, flat on the floor (a rug) or standing
 * on another piece, plus the pieces that come with it (a coffee table in front of the sofa,
 * nightstands beside the bed, chairs round the table) and a score that says where it would rather
 * be (the TV across from the sofa, the bed's head against a wall away from the door).
 *
 * The filler does the hard part for every caller the same way: it tries the candidate spots best
 * score first and keeps the first one where the piece and its companions fit the outline (any
 * shape), keep doors, stairs and each other's clear floor free, and leave every door and every
 * piece that needs to be reached connected by a walkway.
 *
 * Furniture faces local +z (the builder's convention: a sofa's back is at -z, its seat looks to +z).
 */
import type { Furn, FurnKind } from '../InteriorGen';
import type { Area, Edge } from './area';
import { Rng } from '../../core/rng';
import { pointInPoly, distSqPointSeg, minAreaRect, polyBounds, type Poly } from '../../core/geom2';

type C3 = [number, number, number];

export interface Piece {
  kind: FurnKind;
  w: number; d: number; h: number;
  color: C3;
  use?: Furn['use'];
  game?: number;
  /** Clear floor needed in front (m): to open a wardrobe, stand at a counter, get out of bed. */
  front?: number;
  /** Lies flat on the floor (a rug): others stand on it, it may run into a doorway. */
  flat?: boolean;
  /** Hangs on a wall (a picture, a mirror): needs a plain stretch of wall behind it, no windows or doors. */
  hung?: boolean;
  /** Stands on another piece (a TV on its stand, a monitor on a desk): no floor of its own. */
  onTop?: boolean;
  /** Tall: kept away from windows. Default: taller than a window sill (1 m). */
  tall?: boolean;
  /** For a companion: the group fails without it (default: optional). For an item: unused. */
  need?: boolean;
  /** Name other pieces' scores refer to (Filler.get). */
  tag?: string;
}

/** A companion piece, placed relative to its item: du to the item's right, dv to its front, turned by dyaw. */
export interface Kid extends Piece { du: number; dv: number; dyaw?: number }

export interface Item extends Piece {
  at: 'wall' | 'free';
  /** Looks the same turned half round (a table): free-standing, only two facings are tried. */
  sym?: boolean;
  /** Widths to try (a kitchen row as long as the wall allows); wider scores a little better. */
  widths?: number[];
  /** Where the item would rather be (higher is better). */
  score?: (c: Cand, f: Filler) => number;
  /** Lowest acceptable score: below it the item is left out. */
  min?: number;
  kids?: Kid[];
}

/** A candidate spot: centre, facing, width, and the wall it stands against (if any) with the position along it. */
export interface Cand { x: number; z: number; yaw: number; w: number; edge: Edge | null; s: number }

interface Placed { f: Furn; q: Poly; clear: Poly | null; solid: boolean; flat: boolean; hung: boolean; tag?: string; reach: [number, number] | null }

/** Gap between a piece's back and the wall line (walls are 12 cm thick, with a baseboard). */
const WALL_GAP = 0.09;
/** Hung pieces sit on the wall face. */
const HUNG_GAP = 0.065;
const WALKER = 0.22;
const CELL = 0.2;
const MAX_TESTS = 700;
/** Walkway checks per item: a piece that keeps cutting the room in two is left out. */
const MAX_WALKS = 12;

export class Filler {
  readonly placed: Placed[] = [];
  private readonly doorZones: Poly[] = [];
  private readonly seeds: [number, number][] = [];
  private readonly frame: { cx: number; cz: number; ux: number; uz: number; hu: number; hv: number };
  /** The room's walk grid: the bare room's walkable cells, less the floor of the pieces placed so far. */
  private readonly convex: boolean;
  private readonly changed: number[] = [];
  private seen: Uint32Array | null = null;
  private stack: Int32Array | null = null;
  private stamp = 0;
  private grid: { x0: number; z0: number; nx: number; nz: number; walk: Uint8Array } | null = null;

  constructor(readonly A: Area, readonly r: Rng) {
    for (const e of A.edges) {
      const spans: [number, number, number][] = e.kind === 'open' ? [[0, e.len, 0.6]] : e.doors.map(([s0, s1]) => [s0, s1, 1.0]);
      for (const [s0, s1, depth] of spans) {
        const a0 = Math.max(0, s0 - 0.1), a1 = Math.min(e.len, s1 + 0.1);
        const p = (s: number, t: number): [number, number] => [e.ax + e.ux * s + e.nx * t, e.az + e.uz * s + e.nz * t];
        this.doorZones.push([...p(a0, -0.05), ...p(a1, -0.05), ...p(a1, depth), ...p(a0, depth)]);
        this.seeds.push(p((s0 + s1) / 2, 0.45));
      }
    }
    this.convex = isConvex(A.poly);
    const o = minAreaRect(A.poly);
    this.frame = { cx: o.cx, cz: o.cz, ux: o.ux, uz: o.uz, hu: o.hu, hv: o.hv };
  }

  /** The furniture placed so far. */
  get furniture(): Furn[] { return this.placed.map((p) => p.f); }

  /** Places the items in order (most important first); returns what fitted. */
  fill(items: Item[]): Furn[] {
    for (const it of items) this.put(it);
    return this.furniture;
  }

  /** The first placed piece with this tag. */
  get(tag: string): Furn | undefined { return this.placed.find((p) => p.tag === tag)?.f; }

  /** Distance from (x, z) to the nearest door (10 if the room has none). */
  doorDist(x: number, z: number): number {
    let d = 10;
    for (const [sx, sz] of this.seeds) d = Math.min(d, Math.hypot(sx - x, sz - z));
    return d;
  }

  /** Free floor in front of a candidate of depth d: from its front face to the room's outline. */
  ahead(c: Cand, d: number): number {
    const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
    return rayToOutline(this.A.poly, c.x + fx * d / 2, c.z + fz * d / 2, fx, fz);
  }

  /**
   * The wall straight across from a candidate's front (depth d): how far away it is and whether a
   * piece of width w could stand against it there (a wall, not open, no door at that spot). For
   * the sofa: is there somewhere across from it for the TV?
   */
  across(c: Cand, d: number, w: number): { dist: number; free: boolean } {
    const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw), x = c.x + fx * d / 2, z = c.z + fz * d / 2;
    let best = 20, hit: Edge | null = null, hs = 0;
    for (const e of this.A.edges) {
      const den = fx * e.uz - fz * e.ux;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((e.ax - x) * e.uz - (e.az - z) * e.ux) / den;
      const s = ((e.ax - x) * fz - (e.az - z) * fx) / den;
      if (t > 1e-3 && t < best && s >= 0 && s <= e.len) { best = t; hit = e; hs = s; }
    }
    if (!hit) return { dist: best, free: false };
    const free = hit.kind !== 'open' && hs > w / 2 && hs < hit.len - w / 2 && !hit.doors.some(([a, b]) => hs + w / 2 > a - 0.2 && hs - w / 2 < b + 0.2);
    return { dist: best, free };
  }

  /** How far the candidate stands from the nearest end of its wall (corners score high with a minus). */
  cornerGap(c: Cand): number {
    return c.edge ? Math.min(c.s - c.w / 2, c.edge.len - c.s - c.w / 2) : 10;
  }

  /**
   * How well a candidate faces a placed piece and stands in front of it: 1 when it is straight
   * ahead of the piece, facing it, at `want` metres; falls off with sideways offset, distance error
   * and angle. 0 when it is behind or turned away.
   */
  faces(c: Cand, tag: string, want: number): number {
    const t = this.get(tag);
    if (!t) return 0;
    const tfx = Math.sin(t.yaw), tfz = Math.cos(t.yaw), cfx = Math.sin(c.yaw), cfz = Math.cos(c.yaw);
    const dx = c.x - t.x, dz = c.z - t.z;
    const along = dx * tfx + dz * tfz, side = Math.abs(dx * tfz - dz * tfx);
    const opp = -(tfx * cfx + tfz * cfz);
    if (along < 1 || opp < 0.7) return 0;
    return Math.max(0, 1 - side * 0.5 - Math.abs(along - want) * 0.15) * opp;
  }

  /** Places one item with its companions, or nothing. */
  put(it: Item): Furn | null {
    const cands = this.candidates(it);
    const score = new Float64Array(cands.length);
    for (let i = 0; i < cands.length; i++) score[i] = (it.score ? it.score(cands[i], this) : 0) + (it.widths ? cands[i].w * 0.4 : 0) + this.r.float() * 0.25;
    // Best first: a max-heap of candidate indices (usually only the first few are tried).
    const heap = new MaxHeap(score);
    let tests = 0, walks = 0;
    const kids = it.kids ?? [];
    for (let i = heap.pop(); i >= 0; i = heap.pop()) {
      const c = cands[i];
      if (it.min !== undefined && score[i] < it.min) break;
      if (++tests > MAX_TESTS) break;
      const main = this.fits(c.w === it.w ? it : { ...it, w: c.w }, c.x, c.z, c.yaw);
      if (!main) continue;
      const mark = this.placed.length;
      this.placed.push(main);
      let ok = true;
      const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
      for (const k of kids) {
        const p = this.fits(k, c.x + k.du * cs + k.dv * sn, c.z - k.du * sn + k.dv * cs, c.yaw + (k.dyaw ?? 0));
        if (p) this.placed.push(p);
        else if (k.need) { ok = false; break; }
      }
      if (ok && ++walks > MAX_WALKS) { this.placed.length = mark; break; }
      if (ok && this.walkable(mark)) return main.f;
      this.placed.length = mark;
    }
    return null;
  }

  private candidates(it: Item): Cand[] {
    const out: Cand[] = [];
    const widths = it.widths ?? [it.w];
    if (it.at === 'wall') {
      const off = it.d / 2 + (it.hung ? HUNG_GAP : WALL_GAP);
      for (const e of this.A.edges) {
        if (e.kind === 'open') continue;
        if ((it.hung || isTall(it)) && e.kind === 'window') continue;
        const yaw = Math.atan2(e.nx, e.nz);
        for (const w of widths) {
          if (w + 0.1 > e.len) continue;
          const s0 = w / 2 + 0.05, s1 = e.len - w / 2 - 0.05, n = Math.max(1, Math.round((s1 - s0) / 0.25));
          for (let k = 0; k <= n; k++) {
            const s = s0 + ((s1 - s0) * k) / n;
            out.push({ x: e.ax + e.ux * s + e.nx * off, z: e.az + e.uz * s + e.nz * off, yaw, w, edge: e, s });
          }
        }
      }
    } else {
      const F = this.frame;
      // A grid of about 180 spots over the room, four facings (two for pieces that look the same turned round).
      const step = Math.max(0.25, Math.sqrt((4 * F.hu * F.hv) / 180));
      const yaws = (it.sym ? [0, 1] : [0, 1, 2, 3]).map((k) => Math.atan2(F.ux, F.uz) + (k * Math.PI) / 2);
      for (const w of widths) {
        for (let u = -F.hu + step / 2; u < F.hu; u += step) for (let v = -F.hv + step / 2; v < F.hv; v += step) {
          const x = F.cx + F.ux * u - F.uz * v, z = F.cz + F.uz * u + F.ux * v;
          if (!pointInPoly(this.A.poly, x, z)) continue;
          for (const yaw of yaws) out.push({ x, z, yaw, w, edge: null, s: 0 });
        }
      }
    }
    return out;
  }

  /** The placed record of a piece at a pose if it fits there, else null. */
  private fits(p: Piece, x: number, z: number, yaw: number): Placed | null {
    if (p.hung) {
      // Onto the wall face behind it (a companion's offset is only roughly there).
      const e = this.wallBehind(x, z, yaw, p.d);
      if (!e) return null;
      const t = HUNG_GAP + p.d / 2 - ((x - e.ax) * e.nx + (z - e.az) * e.nz);
      x += e.nx * t; z += e.nz * t;
    }
    const f: Furn = { kind: p.kind, x, z, yaw, w: p.w, d: p.d, h: p.h, color: p.color, use: p.use, game: p.game };
    const q = quad(x, z, yaw, p.w, -p.d / 2, p.d / 2);
    const rec: Placed = { f, q, clear: null, solid: false, flat: !!p.flat, hung: !!p.hung, tag: p.tag, reach: null };
    if (p.onTop) return rec;
    if (!this.inside(q, 0.02)) return null;
    if (p.hung) {
      // A plain stretch of inner or blind wall right behind it, clear of doors and of tall pieces.
      const e = this.wallBehind(x, z, yaw, p.d);
      if (!e || e.kind === 'window' || e.kind === 'open') return null;
      const s = (x - e.ax) * e.ux + (z - e.az) * e.uz;
      if (s - p.w / 2 < 0.1 || s + p.w / 2 > e.len - 0.1) return null;
      for (const [d0, d1] of e.doors) if (s + p.w / 2 > d0 - 0.15 && s - p.w / 2 < d1 + 0.15) return null;
      const g = quad(x, z, yaw, p.w + 0.3, -p.d / 2, p.d / 2 + 0.2);
      for (const o of this.placed) {
        if (o.hung && overlap(g, o.q)) return null;
        if (o.solid && o.f.h > 1.2 && overlap(q, o.q)) return null;
      }
      return rec;
    }
    for (const k of this.A.keepOut) if (overlap(q, k)) return null;
    if (p.flat) {
      for (const o of this.placed) if (o.flat && overlap(q, o.q)) return null;
      return rec;
    }
    rec.solid = true;
    if (isTall(p)) {
      const e = this.wallBehind(x, z, yaw, p.d);
      if (e?.kind === 'window') return null;
      // Nor standing with its side to a window wall.
      for (const e2 of this.A.edges) if (e2.kind === 'window' && quadNearEdge(q, e2, WALL_GAP + 0.05)) return null;
    }
    for (const dz of this.doorZones) if (overlap(q, dz)) return null;
    for (const o of this.placed) {
      if (o.solid && overlap(q, o.q)) return null;
      if (o.clear && overlap(q, o.clear)) return null;
      if (o.hung && p.h > 1.2 && overlap(q, o.q)) return null;
    }
    if (p.front) {
      const c = quad(x, z, yaw, p.w, p.d / 2, p.d / 2 + p.front);
      if (!this.inside(c, 0)) return null;
      for (const k of this.A.keepOut) if (overlap(c, k)) return null;
      for (const o of this.placed) if (o.solid && overlap(c, o.q)) return null;
      rec.clear = c;
      const fx = Math.sin(yaw), fz = Math.cos(yaw), t = p.d / 2 + Math.min(p.front, 0.6) * 0.7;
      rec.reach = [x + fx * t, z + fz * t];
    }
    return rec;
  }

  /** Is the quad inside the outline (its outline sampled every 30 cm, `m` metres from the edges)? */
  private inside(q: Poly, m: number): boolean {
    // A convex room holds the quad when it holds its corners; other shapes are sampled every 30 cm.
    const step = this.convex ? Infinity : 0.3;
    for (let i = 0; i < 4; i++) {
      const ax = q[i * 2], az = q[i * 2 + 1], bx = q[((i + 1) % 4) * 2], bz = q[((i + 1) % 4) * 2 + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
      for (let k = 0; k < n; k++) {
        const x = ax + ((bx - ax) * k) / n, z = az + ((bz - az) * k) / n;
        if (!pointInPoly(this.A.poly, x, z)) return false;
        if (m > 0 && edgeDistSq(this.A.poly, x, z) < m * m) return false;
      }
    }
    return true;
  }

  /** The room edge right behind a piece's back (within 20 cm, facing the same way), or null. */
  private wallBehind(x: number, z: number, yaw: number, d: number): Edge | null {
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const bx = x - fx * d / 2, bz = z - fz * d / 2;
    for (const e of this.A.edges) {
      if (e.nx * fx + e.nz * fz < 0.95) continue;
      const dist = (bx - e.ax) * e.nx + (bz - e.az) * e.nz;
      const s = (bx - e.ax) * e.ux + (bz - e.az) * e.uz;
      if (dist > -0.02 && dist < 0.2 && s > -0.05 && s < e.len + 0.05) return e;
    }
    return null;
  }

  /**
   * Can a person still walk from the first door to every other door and to the front of every
   * piece that needs to be reached? Flood fill over a 20 cm grid of the room, solid pieces grown by
   * a walker's half width.
   */
  private walkable(from: number): boolean {
    if (!this.seeds.length) return true;
    const G = this.baseGrid();
    const cells = G.walk, changed = this.changed;
    changed.length = 0;
    for (let k = from; k < this.placed.length; k++) this.block(this.placed[k], changed);
    const ok = this.flood(G);
    // A failed try gives its floor back; a good one keeps it blocked for the next pieces.
    if (!ok) for (const k of changed) cells[k] = 1;
    return ok;
  }

  private flood(G: NonNullable<Filler['grid']>): boolean {
    const cells = G.walk;
    const cellOf = (x: number, z: number): number => {
      const i = Math.floor((x - G.x0) / CELL), j = Math.floor((z - G.z0) / CELL);
      let best = -1, bd = Infinity;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= G.nx || jj >= G.nz || !cells[jj * G.nx + ii]) continue;
        const d = di * di + dj * dj;
        if (d < bd) { bd = d; best = jj * G.nx + ii; }
      }
      return best;
    };
    const start = cellOf(this.seeds[0][0], this.seeds[0][1]);
    if (start < 0) return false;
    if (!this.seen || this.seen.length !== cells.length) { this.seen = new Uint32Array(cells.length); this.stack = new Int32Array(cells.length); }
    const seen = this.seen, stack = this.stack!, mark = ++this.stamp;
    let top = 0;
    seen[start] = mark;
    stack[top++] = start;
    const W = G.nx;
    while (top) {
      const c = stack[--top], i = c % W;
      if (i > 0 && cells[c - 1] && seen[c - 1] !== mark) { seen[c - 1] = mark; stack[top++] = c - 1; }
      if (i < W - 1 && cells[c + 1] && seen[c + 1] !== mark) { seen[c + 1] = mark; stack[top++] = c + 1; }
      if (c >= W && cells[c - W] && seen[c - W] !== mark) { seen[c - W] = mark; stack[top++] = c - W; }
      if (c + W < cells.length && cells[c + W] && seen[c + W] !== mark) { seen[c + W] = mark; stack[top++] = c + W; }
    }
    const reached = (x: number, z: number) => { const c = cellOf(x, z); return c >= 0 && seen[c] === mark; };
    for (let k = 1; k < this.seeds.length; k++) if (!reached(this.seeds[k][0], this.seeds[k][1])) return false;
    for (const o of this.placed) if (o.reach && !reached(o.reach[0], o.reach[1])) return false;
    return true;
  }

  /** Marks the floor a solid piece takes (grown by a walker's half width) as not walkable. */
  private block(o: Placed, changed: number[]): void {
    if (!o.solid) return;
    const G = this.baseGrid(), cells = G.walk;
    const g = quad(o.f.x, o.f.z, o.f.yaw, o.f.w + WALKER * 2, -o.f.d / 2 - WALKER, o.f.d / 2 + WALKER);
    const [x0, z0, x1, z1] = polyBounds(g);
    const i0 = Math.max(0, Math.floor((x0 - G.x0) / CELL)), i1 = Math.min(G.nx - 1, Math.ceil((x1 - G.x0) / CELL));
    const j0 = Math.max(0, Math.floor((z0 - G.z0) / CELL)), j1 = Math.min(G.nz - 1, Math.ceil((z1 - G.z0) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (cells[j * G.nx + i] && pointInPoly(g, G.x0 + (i + 0.5) * CELL, G.z0 + (j + 0.5) * CELL)) { cells[j * G.nx + i] = 0; changed.push(j * G.nx + i); }
    }
  }

  /** Walkable cells of the bare room: inside the outline, a walker's width off the walls (doorways and open edges excepted). */
  private baseGrid() {
    if (this.grid) return this.grid;
    const P = this.A.poly;
    const [x0, z0, x1, z1] = polyBounds(P);
    const nx = Math.max(1, Math.ceil((x1 - x0) / CELL)), nz = Math.max(1, Math.ceil((z1 - z0) / CELL));
    const walk = new Uint8Array(nx * nz);
    // Inside the outline: row by row between the outline's crossings.
    const n = P.length >> 1, xs: number[] = [];
    for (let j = 0; j < nz; j++) {
      const z = z0 + (j + 0.5) * CELL;
      xs.length = 0;
      for (let i = 0; i < n; i++) {
        const k = (i + 1) % n, az = P[i * 2 + 1], bz = P[k * 2 + 1];
        if ((az > z) !== (bz > z)) xs.push(P[i * 2] + ((z - az) / (bz - az)) * (P[k * 2] - P[i * 2]));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - x0) / CELL - 0.5)), i1 = Math.min(nx - 1, Math.floor((xs[k + 1] - x0) / CELL - 0.5));
        for (let i = i0; i <= i1; i++) walk[j * nx + i] = 1;
      }
    }
    const cells = (q: Poly, fn: (k: number, x: number, z: number) => void) => {
      const [qx0, qz0, qx1, qz1] = polyBounds(q);
      const i0 = Math.max(0, Math.floor((qx0 - x0) / CELL)), i1 = Math.min(nx - 1, Math.floor((qx1 - x0) / CELL));
      const j0 = Math.max(0, Math.floor((qz0 - z0) / CELL)), j1 = Math.min(nz - 1, Math.floor((qz1 - z0) / CELL));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * nx + i, x0 + (i + 0.5) * CELL, z0 + (j + 0.5) * CELL);
    };
    // A walker's width off the walls (open edges excepted), but free again in the doorways.
    const off = new Uint8Array(nx * nz);
    for (const e of this.A.edges) {
      if (e.kind === 'open') continue;
      const lx = Math.min(e.ax, e.bx) - WALKER, hx = Math.max(e.ax, e.bx) + WALKER, lz = Math.min(e.az, e.bz) - WALKER, hz = Math.max(e.az, e.bz) + WALKER;
      const box = [lx, lz, hx, lz, hx, hz, lx, hz];
      cells(box, (k, x, z) => { if (distSqPointSeg(x, z, e.ax, e.az, e.bx, e.bz) < WALKER * WALKER) off[k] = 1; });
    }
    for (const dz of this.doorZones) cells(dz, (k, x, z) => { if (pointInPoly(dz, x, z)) off[k] = 0; });
    for (const ko of this.A.keepOut) cells(ko, (k, x, z) => { if (pointInPoly(ko, x, z)) off[k] = 1; });
    for (let k = 0; k < walk.length; k++) if (off[k]) walk[k] = 0;
    this.grid = { x0, z0, nx, nz, walk };
    return this.grid;
  }
}

/** A max-heap of indices into a score array; pop() gives the best remaining index, -1 when empty. */
class MaxHeap {
  private readonly h: Int32Array;
  private n: number;
  constructor(private readonly s: Float64Array) {
    this.n = s.length;
    this.h = new Int32Array(this.n);
    for (let i = 0; i < this.n; i++) this.h[i] = i;
    for (let i = (this.n >> 1) - 1; i >= 0; i--) this.down(i);
  }
  pop(): number {
    if (!this.n) return -1;
    const top = this.h[0];
    this.h[0] = this.h[--this.n];
    this.down(0);
    return top;
  }
  private down(i: number): void {
    const { h, s } = this;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < this.n && s[h[l]] > s[h[m]]) m = l;
      if (r < this.n && s[h[r]] > s[h[m]]) m = r;
      if (m === i) return;
      const t = h[i]; h[i] = h[m]; h[m] = t;
      i = m;
    }
  }
}

function isConvex(p: Poly): boolean {
  const n = p.length >> 1;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = i * 2, b = ((i + 1) % n) * 2, c = ((i + 2) % n) * 2;
    const cr = (p[b] - p[a]) * (p[c + 1] - p[b + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[b]);
    if (Math.abs(cr) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(cr); else if (Math.sign(cr) !== sign) return false;
  }
  return true;
}

function isTall(p: Piece): boolean {
  return p.tall ?? (p.h > 1.0 && !p.flat && !p.hung && !p.onTop);
}

/** World quad of a piece: local x in [-w/2, w/2], local z in [z0, z1] (front is +z). */
export function quad(x: number, z: number, yaw: number, w: number, z0: number, z1: number): Poly {
  const c = Math.cos(yaw), s = Math.sin(yaw), h = w / 2, out: number[] = [];
  for (const [lx, lz] of [[-h, z0], [h, z0], [h, z1], [-h, z1]]) out.push(x + lx * c + lz * s, z - lx * s + lz * c);
  return out;
}

/** Do two convex polygons overlap by more than a centimetre (separating axis test)? */
export function overlap(a: Poly, b: Poly): boolean {
  for (const P of [a, b]) {
    const n = P.length >> 1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = -(P[j * 2 + 1] - P[i * 2 + 1]), az = P[j * 2] - P[i * 2];
      const l = Math.hypot(ax, az);
      if (l < 1e-9) continue;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (let k = 0; k < a.length; k += 2) { const t = (a[k] * ax + a[k + 1] * az) / l; a0 = Math.min(a0, t); a1 = Math.max(a1, t); }
      for (let k = 0; k < b.length; k += 2) { const t = (b[k] * ax + b[k + 1] * az) / l; b0 = Math.min(b0, t); b1 = Math.max(b1, t); }
      if (a1 <= b0 + 0.01 || b1 <= a0 + 0.01) return false;
    }
  }
  return true;
}

function quadNearEdge(q: Poly, e: Edge, m: number): boolean {
  for (let k = 0; k < 8; k += 2) {
    if (distSqPointSeg(q[k], q[k + 1], e.ax, e.az, e.bx, e.bz) < m * m) return true;
  }
  return false;
}

function edgeDistSq(p: Poly, x: number, z: number): number {
  const n = p.length >> 1;
  let d = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    d = Math.min(d, distSqPointSeg(x, z, p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1]));
  }
  return d;
}

/** Distance along a ray from (x, z) to the first crossing of the outline (20 if none). */
function rayToOutline(p: Poly, x: number, z: number, dx: number, dz: number): number {
  const n = p.length >> 1;
  let best = 20;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p[i * 2], az = p[i * 2 + 1], ex = p[j * 2] - ax, ez = p[j * 2 + 1] - az;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((ax - x) * ez - (az - z) * ex) / den;
    const u = ((ax - x) * dz - (az - z) * dx) / den;
    if (t > 1e-4 && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return best;
}
