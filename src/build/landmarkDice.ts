/**
 * Breakable landmarks (the marvels): their meshes are diced along a grid in the landmark's frame
 * (u, y, v) and every grid cell that holds geometry becomes one piece, one element of the mesh
 * (`aElem` = piece index + 1; element 0 stays whole). Destruction (destruction/LandmarkWreck)
 * breaks pieces, finds what lost its support and drops it.
 *
 * The grid is a pure function of the landmark and its parts, so the worker (meshes) and the main
 * thread (collision bands) agree. The near meshes (opaque and clear glass) define the pieces; the
 * far meshes are cut along the same grid and take the near pieces for their cell (0 where there
 * is none).
 */
import type { Landmark } from '../plan/landmarks';
import type { LmPart } from '../plan/landmarkParts';

/** Grid of a breakable landmark: frame (x, z, angle), cell size across (cs) and up (ch). */
export interface WreckGrid {
  x: number; z: number; c: number; s: number;
  cs: number; ch: number;
  u0: number; v0: number; y0: number;
  nu: number; nv: number; ny: number;
}

/** Floats per piece in a piece table: key, area, centroid (x, y, z), bounds (x0, y0, z0, x1, y1, z1), layer. */
export const PIECE_STRIDE = 12;

/** Which landmarks can be broken (the marvels and the cathedral; the other landmarks stay as they are). */
export function isWreckable(lm: Landmark): boolean {
  return lm.kind === 'marvel' || lm.kind === 'cathedral';
}

/** Grid cells in all: window glass (LmPart.pane) is a piece of its own, keyed one grid further on. */
export function gridCells(g: WreckGrid): number {
  return g.nu * g.nv * g.ny;
}

/** Is a piece key window glass? */
export function isPaneKey(g: WreckGrid, key: number): boolean {
  return key >= gridCells(g);
}

export function wreckGrid(lm: Landmark, parts: LmPart[]): WreckGrid {
  let top = lm.base;
  for (const p of parts) {
    top = Math.max(top, p.y0, p.y1, p.by ?? -Infinity);
    if (p.hh) top = Math.max(top, p.y1 + p.hh);
  }
  const cs = Math.min(8, Math.max(3.5, Math.sqrt(lm.hu * lm.hv) / 7));
  const ch = Math.min(9, Math.max(3.5, (top - lm.base) / 110));
  const y0 = Math.min(lm.low, lm.base) - 2;
  return {
    x: lm.x, z: lm.z, c: Math.cos(lm.angle), s: Math.sin(lm.angle), cs, ch,
    u0: -lm.hu - cs, v0: -lm.hv - cs, y0,
    nu: Math.ceil((2 * lm.hu + 2 * cs) / cs), nv: Math.ceil((2 * lm.hv + 2 * cs) / cs), ny: Math.ceil((top + 2 - y0) / ch) + 1,
  };
}

/** Grid cell indices (i along u, j along v, k up) of a world point, clamped to the grid. */
export function gridIJK(g: WreckGrid, x: number, y: number, z: number): [number, number, number] {
  const dx = x - g.x, dz = z - g.z;
  const u = dx * g.c + dz * g.s, v = -dx * g.s + dz * g.c;
  const cl = (t: number, n: number) => Math.max(0, Math.min(n - 1, Math.floor(t)));
  return [cl((u - g.u0) / g.cs, g.nu), cl((v - g.v0) / g.cs, g.nv), cl((y - g.y0) / g.ch, g.ny)];
}

export function gridKey(g: WreckGrid, i: number, j: number, k: number): number {
  return (k * g.nv + j) * g.nu + i;
}

export function keyAt(g: WreckGrid, x: number, y: number, z: number): number {
  const [i, j, k] = gridIJK(g, x, y, z);
  return gridKey(g, i, j, k);
}

type V3 = [number, number, number];
interface Vert { p: V3; n: V3; uv: [number, number] }

/**
 * Cuts convex polygons along the grid and names the piece of each bit. With `pieces` given (the
 * near mesh's table), unknown cells map to 0; without, it builds the table as it goes.
 */
export class Dicer {
  readonly ids = new Map<number, number>();
  /** Per piece: key, area, Σ area·centroid, bounds, best layer area, layer. */
  private acc: number[][] = [];
  private frozen: boolean;

  constructor(readonly g: WreckGrid, near?: Float32Array) {
    this.frozen = !!near;
    if (near) for (let i = 0; i < near.length / PIECE_STRIDE; i++) this.ids.set(near[i * PIECE_STRIDE], i + 1);
  }

  /** Local coordinate of a world point along an axis (0 u, 1 y, 2 v), in grid units from the origin. */
  private coord(p: V3, axis: number): number {
    const g = this.g;
    if (axis === 1) return (p[1] - g.y0) / g.ch;
    const dx = p[0] - g.x, dz = p[2] - g.z;
    return axis === 0 ? (dx * g.c + dz * g.s - g.u0) / g.cs : (-dx * g.s + dz * g.c - g.v0) / g.cs;
  }

  /** The element of a point (piece index + 1, or 0). */
  idAt(x: number, y: number, z: number): number {
    return this.ids.get(keyAt(this.g, x, y, z)) ?? 0;
  }

  /** Split a convex polygon into grid cells: each bit with its element (window glass: the cell's glass piece). */
  split(poly: Vert[], layer: number, pane: boolean, out: (bit: Vert[], elem: number) => void): void {
    let list: Vert[][] = [poly];
    for (const axis of [1, 0, 2]) {
      const next: Vert[][] = [];
      for (const q of list) {
        let lo = Infinity, hi = -Infinity;
        for (const v of q) { const t = this.coord(v.p, axis); lo = Math.min(lo, t); hi = Math.max(hi, t); }
        let rest = q;
        for (let m = Math.floor(lo) + 1; m < hi - 1e-6 && rest.length >= 3; m++) {
          const [a, b] = clip(rest, (v) => this.coord(v.p, axis) - m);
          if (a.length >= 3) next.push(a);
          rest = b;
        }
        if (rest.length >= 3) next.push(rest);
      }
      list = next;
    }
    for (const bit of list) {
      let cx = 0, cy = 0, cz = 0;
      for (const v of bit) { cx += v.p[0]; cy += v.p[1]; cz += v.p[2]; }
      cx /= bit.length; cy /= bit.length; cz /= bit.length;
      out(bit, this.elemOf(cx, cy, cz, area(bit), layer, pane));
    }
  }

  private elemOf(x: number, y: number, z: number, a: number, layer: number, pane: boolean): number {
    const key = keyAt(this.g, x, y, z) + (pane ? gridCells(this.g) : 0);
    let id = this.ids.get(key);
    if (id === undefined) {
      if (this.frozen) return 0;
      id = this.acc.length + 1;
      this.ids.set(key, id);
      this.acc.push([key, 0, 0, 0, 0, Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity, 0, layer]);
    }
    if (this.frozen || id === 0) return id;
    const A = this.acc[id - 1];
    A[1] += a; A[2] += a * x; A[3] += a * y; A[4] += a * z;
    A[5] = Math.min(A[5], x); A[6] = Math.min(A[6], y); A[7] = Math.min(A[7], z);
    A[8] = Math.max(A[8], x); A[9] = Math.max(A[9], y); A[10] = Math.max(A[10], z);
    if (a > A[11]) { A[11] = a; A[12] = layer; }
    return id;
  }

  /** The piece table (near mesh): PIECE_STRIDE floats per piece, element = index + 1. */
  table(): Float32Array {
    const g = this.g, out = new Float32Array(this.acc.length * PIECE_STRIDE);
    this.acc.forEach((A, i) => {
      const o = i * PIECE_STRIDE, a = Math.max(1e-6, A[1]);
      // Bounds: the bits' centres, grown a little toward their edges (not into the next cell).
      out[o] = A[0]; out[o + 1] = A[1];
      out[o + 2] = A[2] / a; out[o + 3] = A[3] / a; out[o + 4] = A[4] / a;
      const r = g.cs * 0.3, h = g.ch * 0.3;
      out[o + 5] = A[5] - r; out[o + 6] = A[6] - h; out[o + 7] = A[7] - r;
      out[o + 8] = A[8] + r; out[o + 9] = A[9] + h; out[o + 10] = A[10] + r;
      out[o + 11] = A[12];
    });
    return out;
  }
}

/** Sutherland–Hodgman both ways: the parts of a convex polygon with f < 0 and f ≥ 0. */
function clip(poly: Vert[], f: (v: Vert) => number): [Vert[], Vert[]] {
  const a: Vert[] = [], b: Vert[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const fp = f(p), fq = f(q);
    (fp < 0 ? a : b).push(p);
    if ((fp < 0) !== (fq < 0)) {
      const t = fp / (fp - fq);
      const m = lerp(p, q, t);
      a.push(m); b.push(m);
    }
  }
  return [a, b];
}

function lerp(p: Vert, q: Vert, t: number): Vert {
  const L = (x: number, y: number) => x + (y - x) * t;
  const n: V3 = [L(p.n[0], q.n[0]), L(p.n[1], q.n[1]), L(p.n[2], q.n[2])];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return { p: [L(p.p[0], q.p[0]), L(p.p[1], q.p[1]), L(p.p[2], q.p[2])], n: [n[0] / l, n[1] / l, n[2] / l], uv: [L(p.uv[0], q.uv[0]), L(p.uv[1], q.uv[1])] };
}

function area(P: Vert[]): number {
  let x = 0, y = 0, z = 0;
  for (let i = 1; i + 1 < P.length; i++) {
    const a = P[0].p, b = P[i].p, c = P[i + 1].p;
    const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2], fx = c[0] - a[0], fy = c[1] - a[1], fz = c[2] - a[2];
    x += ey * fz - ez * fy; y += ez * fx - ex * fz; z += ex * fy - ey * fx;
  }
  return Math.hypot(x, y, z) / 2;
}
