/**
 * Drone route planning round tall buildings: A* over a coarse grid (8-connected, octile)
 * spanning the leg plus a margin. Cells are blocked within a clearance of every footprint
 * that reaches into the cruise altitude; cells over buildings close below it cost extra, so
 * routes keep to the open air over street canyons. The cell path is string-pulled into a few
 * straight legs. Built per leg (a delivery spawn), not per frame: well under a millisecond.
 */
import { pointInPoly, distPointPolyEdge } from '../core/geom2';
import { MinHeap } from '../core/heap';
import type { WorldIndex } from '../world/WorldIndex';

const CELL = 10;
const MAX_CELLS = 9000;
/** Horizontal clearance from walls that reach into the lane (m). */
const CLEAR = 7;

const heap = new MinHeap();
let gScore = new Float32Array(0);
let from = new Int32Array(0);
let state = new Uint8Array(0);
let cost = new Float32Array(0);
/** Cell centre inside a footprint that reaches into the lane. */
let solid = new Uint8Array(0);

/**
 * Waypoints (x, z pairs, without the end points) from a to b at altitude y round every
 * building whose top is above y - 8; null when there is no way round within the search area.
 * The last `skipEnd` m round b are open (the destination's own walls on the final approach).
 */
export function planAround(world: WorldIndex, ax: number, az: number, bx: number, bz: number, y: number, skipEnd: number): number[] | null {
  const L = Math.hypot(bx - ax, bz - az);
  const m = Math.min(220, 60 + L * 0.3);
  let x0 = Math.min(ax, bx) - m, z0 = Math.min(az, bz) - m;
  const x1 = Math.max(ax, bx) + m, z1 = Math.max(az, bz) + m;
  let cs = CELL;
  while (((x1 - x0) / cs) * ((z1 - z0) / cs) > MAX_CELLS) cs *= 1.25;
  const nx = Math.ceil((x1 - x0) / cs), nz = Math.ceil((z1 - z0) / cs);
  x0 -= (nx * cs - (x1 - x0)) / 2; z0 -= (nz * cs - (z1 - z0)) / 2;
  const N = nx * nz;
  if (cost.length < N) { cost = new Float32Array(N * 2); solid = new Uint8Array(N * 2); gScore = new Float32Array(N * 2); from = new Int32Array(N * 2); state = new Uint8Array(N * 2); }
  cost.fill(1, 0, N);
  solid.fill(0, 0, N);
  // Rasterise the buildings that reach into the lane (blocked) or come close below it (costly).
  let blockers = 0;
  for (const r of world.buildingsIn(x0, z0, x1, z1)) {
    if (!r.alive || r.top < y - 22) continue;
    const hard = r.top > y - 8;
    const pad = hard ? CLEAR + cs * 0.5 : 0;
    const i0 = Math.max(0, Math.floor((r.bounds[0] - pad - x0) / cs)), i1 = Math.min(nx - 1, Math.floor((r.bounds[2] + pad - x0) / cs));
    const j0 = Math.max(0, Math.floor((r.bounds[1] - pad - z0) / cs)), j1 = Math.min(nz - 1, Math.floor((r.bounds[3] + pad - z0) / cs));
    if (hard) blockers++;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * nx + i;
      if (cost[k] === 0) continue;
      const cx = x0 + (i + 0.5) * cs, cz = z0 + (j + 0.5) * cs;
      const inside = pointInPoly(r.poly, cx, cz);
      if (hard && inside) solid[k] = 1;
      if (hard && (inside || distPointPolyEdge(r.poly, cx, cz) < pad)) cost[k] = 0;
      else if (!hard && inside) cost[k] = Math.max(cost[k], 1.6);
    }
  }
  if (!blockers) return [];
  const cell = (x: number, z: number) => Math.min(nz - 1, Math.max(0, Math.floor((z - z0) / cs))) * nx + Math.min(nx - 1, Math.max(0, Math.floor((x - x0) / cs)));
  const s = cell(ax, az), g = cell(bx, bz);
  // The start may sit in a clearance zone (taking off beside a tower: away from the wall is
  // fine); the goal's surroundings (its own building's door or roof) are open within skipEnd.
  const unblock = (px: number, pz: number, r: number, any: boolean) => {
    const o = Math.ceil(r / cs), ci = Math.floor((px - x0) / cs), cj = Math.floor((pz - z0) / cs);
    for (let j = Math.max(0, cj - o); j <= Math.min(nz - 1, cj + o); j++) for (let i = Math.max(0, ci - o); i <= Math.min(nx - 1, ci + o); i++) {
      const k = j * nx + i;
      if (cost[k] !== 0 || (!any && solid[k])) continue;
      if (Math.hypot(x0 + (i + 0.5) * cs - px, z0 + (j + 0.5) * cs - pz) <= r) cost[k] = 1;
    }
  };
  unblock(ax, az, CLEAR + cs * 1.5, false);
  cost[s] = Math.max(cost[s], 1);
  unblock(bx, bz, skipEnd + cs, true);
  unblock(bx, bz, CLEAR + cs * 1.5, false);
  cost[g] = Math.max(cost[g], 1);
  const gi = g % nx, gj = Math.floor(g / nx);
  // ---- A*
  gScore.fill(Infinity, 0, N);
  state.fill(0, 0, N);
  heap.clear();
  gScore[s] = 0; from[s] = -1;
  heap.push(octile(s % nx, Math.floor(s / nx), gi, gj), s);
  let found = false, iter = 0;
  while (heap.size && iter++ < N * 3) {
    const k = heap.pop();
    if (state[k] === 2) continue;
    state[k] = 2;
    if (k === g) { found = true; break; }
    const i = k % nx, j = (k - i) / nx;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
      const q = jj * nx + ii;
      if (state[q] === 2 || cost[q] === 0) continue;
      // No corner cutting past a blocked cell.
      if (di && dj && (cost[j * nx + ii] === 0 || cost[jj * nx + i] === 0)) continue;
      const ng = gScore[k] + (di && dj ? Math.SQRT2 : 1) * (cost[q] + cost[k]) * 0.5;
      if (ng >= gScore[q]) continue;
      gScore[q] = ng; from[q] = k;
      heap.push(ng + octile(ii, jj, gi, gj), q);
    }
  }
  if (!found) return null;
  // Cell path (centres) from a to b, then string pulling over the grid.
  const path: number[] = [];
  for (let k = g; k >= 0; k = from[k]) path.push(k);
  path.reverse();
  const pts: number[] = [ax, az];
  for (let p = 1; p < path.length - 1; p++) pts.push(x0 + ((path[p] % nx) + 0.5) * cs, z0 + (Math.floor(path[p] / nx) + 0.5) * cs);
  pts.push(bx, bz);
  const free = (px: number, pz: number, qx: number, qz: number) => {
    const n = Math.ceil(Math.hypot(qx - px, qz - pz) / (cs * 0.3));
    let prevCost = 1;
    for (let t = 1; t < n; t++) {
      const c = cost[cell(px + ((qx - px) * t) / n, pz + ((qz - pz) * t) / n)];
      if (c === 0 || c > prevCost + 0.01) return false;
      prevCost = Math.max(prevCost, c);
    }
    return true;
  };
  const via: number[] = [];
  let i = 0;
  const n = pts.length / 2;
  while (i < n - 1) {
    let j = n - 1;
    while (j > i + 1 && !free(pts[i * 2], pts[i * 2 + 1], pts[j * 2], pts[j * 2 + 1])) j--;
    if (j < n - 1) via.push(pts[j * 2], pts[j * 2 + 1]);
    i = j;
  }
  return via;
}

function octile(i: number, j: number, gi: number, gj: number): number {
  const dx = Math.abs(i - gi), dz = Math.abs(j - gj);
  return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
}

