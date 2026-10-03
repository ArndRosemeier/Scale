/**
 * Tileable block layouts (brick bonds, ashlar courses, slabs, shingles): horizontal courses of
 * blocks inside a W x W tile, wrapping in both directions.
 */
import { Rng } from '../../core/rng';
import { wrap } from './core';

export interface Hit {
  course: number;
  block: number;
  /** stable id (course * 4096 + block) */
  id: number;
  /** block kind (pattern specific, e.g. header/stretcher) */
  kind: number;
  /** block rectangle in the same (unwrapped) frame as x, y */
  x0: number; x1: number; y0: number; y1: number;
  /** wrapped query point */
  x: number; y: number;
}
export const newHit = (): Hit => ({ course: 0, block: 0, id: 0, kind: 0, x0: 0, x1: 0, y0: 0, y1: 0, x: 0, y: 0 });

export class Layout {
  /** course start y (ys[n] = W) */
  private ys: number[];
  private xs: number[][] = [];
  private kinds: number[][] = [];
  constructor(readonly W: number, heights: number[], xs: number[][], kinds: number[][] = []) {
    this.ys = [0];
    let acc = 0;
    for (const h of heights) { acc += h; this.ys.push(acc); }
    const k = W / acc;
    this.ys = this.ys.map((y) => y * k);
    xs.forEach((row, c) => {
      const kr = kinds[c] ?? [];
      const order = row.map((_, k) => k).sort((a, b) => wrap(row[a], W) - wrap(row[b], W));
      this.xs.push(order.map((k) => wrap(row[k], W)));
      this.kinds.push(order.map((k) => kr[k] ?? 0));
    });
  }
  get courses(): number { return this.ys.length - 1; }

  at(xq: number, yq: number, o: Hit): Hit {
    const W = this.W, ys = this.ys;
    const x = wrap(xq, W), y = wrap(yq, W);
    let c = 0;
    const nc = ys.length - 1;
    while (c < nc - 1 && y >= ys[c + 1]) c++;
    const row = this.xs[c];
    const m = row.length;
    // last block start <= x
    let lo = 0, hi = m - 1, b = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (row[mid] <= x) { b = mid; lo = mid + 1; } else hi = mid - 1; }
    let x0: number, x1: number;
    if (b === -1) { b = m - 1; x0 = row[m - 1] - W; x1 = row[0]; } else { x0 = row[b]; x1 = b + 1 < m ? row[b + 1] : row[0] + W; }
    o.course = c; o.block = b; o.id = c * 4096 + b; o.kind = this.kinds[c]?.[b] ?? 0;
    o.x0 = x0; o.x1 = x1; o.y0 = ys[c]; o.y1 = ys[c + 1]; o.x = x; o.y = y;
    return o;
  }
}

/** Running (stretcher) bond with optional head-joint jitter (meters). */
export function runningBond(W: number, courses: number, perCourse: number, seed: number, jitter = 0, offset = 0.5): Layout {
  const rng = new Rng(seed);
  const L = W / perCourse;
  const xs: number[][] = [];
  for (let c = 0; c < courses; c++) {
    const row: number[] = [];
    const off = (c % 2) * offset * L + (c % 4 >= 2 ? 0.03 * L : 0);
    for (let k = 0; k < perCourse; k++) row.push(off + k * L + (rng.float() - 0.5) * 2 * jitter);
    xs.push(row);
  }
  return new Layout(W, new Array(courses).fill(1), xs);
}

/**
 * Flemish bond: alternating stretchers (kind 0, length S) and headers (kind 1, length S/2 +
 * joint/2) with headers centered on the stretchers of adjacent courses.
 */
export function flemishBond(W: number, courses: number, units: number, seed: number, jitter = 0): Layout {
  const rng = new Rng(seed);
  const U = W / units; // stretcher + header
  const S = U * (2 / 3), H = U / 3;
  const xs: number[][] = [], kinds: number[][] = [];
  for (let c = 0; c < courses; c++) {
    const row: number[] = [], kr: number[] = [];
    if (c % 2 === 0) {
      for (let k = 0; k < units; k++) {
        row.push(k * U + (rng.float() - 0.5) * 2 * jitter); kr.push(0);
        row.push(k * U + S + (rng.float() - 0.5) * 2 * jitter); kr.push(1);
      }
    } else {
      const off = S / 2 - H / 2;
      for (let k = 0; k < units; k++) {
        row.push(off + k * U + (rng.float() - 0.5) * 2 * jitter); kr.push(1);
        row.push(off + k * U + H + (rng.float() - 0.5) * 2 * jitter); kr.push(0);
      }
    }
    xs.push(row); kinds.push(kr);
  }
  return new Layout(W, new Array(courses).fill(1), xs, kinds);
}

/**
 * Random ashlar courses: given course heights, each course is filled with blocks of random
 * length in [minL, maxL] that sum exactly to W; joints of adjacent courses avoid alignment.
 */
export function randomCourses(W: number, heights: number[], minL: number, maxL: number, seed: number): Layout {
  const rng = new Rng(seed);
  const xs: number[][] = [];
  let prev: number[] = [];
  for (let c = 0; c < heights.length; c++) {
    let best: number[] = [];
    let bestScore = -1;
    for (let attempt = 0; attempt < 12; attempt++) {
      const lens: number[] = [];
      let sum = 0;
      while (sum < W - minL * 0.5) { const l = rng.range(minL, maxL); lens.push(l); sum += l; }
      const k = W / sum;
      const off = rng.float() * W;
      const row: number[] = [];
      let x = off;
      for (const l of lens) { row.push(wrap(x, W)); x += l * k; }
      // score = min distance of a joint to a joint in the previous course
      let score = 1e9;
      for (const a of row) for (const b of prev) { const d = Math.abs(((a - b + W * 1.5) % W) - W / 2); score = Math.min(score, W / 2 - d); }
      if (prev.length === 0) score = 1;
      if (score > bestScore) { bestScore = score; best = row; }
      if (score > minL * 0.3) break;
    }
    xs.push(best);
    prev = best;
  }
  return new Layout(W, heights, xs);
}

/**
 * Signed inside distance (meters) of point (hit.x, hit.y) to the block rectangle shrunk by the
 * half joint on each side, with rounded corners of radius cr.
 */
export function blockDist(o: Hit, halfJoint: number, cr: number): number {
  const dx = Math.min(o.x - o.x0, o.x1 - o.x) - halfJoint;
  const dy = Math.min(o.y - o.y0, o.y1 - o.y) - halfJoint;
  if (dx < cr && dy < cr) {
    const ax = cr - dx, ay = cr - dy;
    if (ax > 0 && ay > 0) return cr - Math.sqrt(ax * ax + ay * ay);
  }
  return Math.min(dx, dy);
}
