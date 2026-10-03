/**
 * Macro plan: city centres, the urban density field, the arterial road
 * network (organic web from a variable-density Poisson set filtered to a
 * Gabriel graph, with river-bank roads, coastal promenade and bridges), the
 * cells (faces of that network) and their districts.
 */
import Delaunator from 'delaunator';
import { Rng, deriveSeed } from '../core/rng';
import { Noise } from '../core/noise';
import { clamp, lerp, smoothstep } from '../core/math';
import { polyArea, polyCentroid, polyBounds, ensureCCW, cleanPoly, type Poly } from '../core/geom2';
import { difference } from '../core/clip';
import { riverChunks, seaPolygon } from './water';
import type { Terrain } from '../world/terrain';
import type { WorldProfile } from '../world/settings';
import { RoadClass, type ArterialEdge, type ArterialNode, type Bridge, type CellInfo, type Centre, type District, type MacroPlan } from './types';
import { planUnderground } from './underground';
import { MinHeap } from '../core/heap';
import { makeBoundary, boundaryAt } from '../world/boundary';

export const ROAD_SPEC: Record<RoadClass, { width: number; sidewalk: number; lanes: number }> = {
  [RoadClass.Boulevard]: { width: 24, sidewalk: 5.5, lanes: 3 },
  [RoadClass.Avenue]: { width: 15, sidewalk: 4.5, lanes: 2 },
  [RoadClass.Street]: { width: 9.5, sidewalk: 3.2, lanes: 1 },
  [RoadClass.Lane]: { width: 6, sidewalk: 1.6, lanes: 1 },
  [RoadClass.Path]: { width: 3, sidewalk: 0, lanes: 0 },
};

export class CityField {
  readonly profile: WorldProfile;
  readonly terrain: Terrain;
  readonly centres: Centre[];
  readonly core: [number, number];
  readonly boundary: number[];
  private noise: Noise;

  constructor(terrain: Terrain, centres: Centre[], core: [number, number], boundary: number[]) {
    this.terrain = terrain;
    this.profile = terrain.profile;
    this.centres = centres;
    this.core = core;
    this.boundary = boundary;
    this.noise = new Noise(deriveSeed(this.profile.seed, 'field'));
  }

  boundaryAt(x: number, z: number): number {
    return boundaryAt(this.boundary, x, z);
  }

  inCity(x: number, z: number, margin = 0): boolean {
    return Math.hypot(x, z) < this.boundaryAt(x, z) - margin;
  }

  /** Urban density 0..1. */
  density(x: number, z: number): number {
    let d = 0;
    for (const c of this.centres) {
      const r = Math.hypot(x - c.x, z - c.z) / c.radius;
      d = Math.max(d, c.weight * Math.exp(-Math.pow(r, 1.15)));
    }
    d *= 1 + 0.18 * this.noise.fbm2(x / 1400, z / 1400, 3);
    // Fade at the city edge.
    const edge = this.boundaryAt(x, z);
    d *= smoothstep(edge * 1.02, edge * 0.82, Math.hypot(x, z));
    return clamp(d, 0, 1);
  }
}

function makeCentres(terrain: Terrain, rng: Rng): { centres: Centre[]; core: [number, number] } {
  const p = terrain.profile;
  // Cities grow at river crossings: the historic core sits on a bank near the origin.
  const r0 = terrain.rivers[0];
  let best = Infinity, bx = 0, bz = 0, bi = 0;
  for (let i = 0; i < r0.pts.length; i += 2) {
    const d = Math.hypot(r0.pts[i], r0.pts[i + 1]);
    if (d < best) { best = d; bx = r0.pts[i]; bz = r0.pts[i + 1]; bi = i; }
  }
  const tx = r0.pts[Math.min(bi + 2, r0.pts.length - 2)] - r0.pts[Math.max(0, bi - 2)];
  const tz = r0.pts[Math.min(bi + 3, r0.pts.length - 1)] - r0.pts[Math.max(1, bi - 1)];
  const tl = Math.hypot(tx, tz) || 1;
  const side = rng.sign();
  const hw = terrain.riverHalfWidthAt(0, r0.s[bi >> 1]);
  const off = hw + 120 + rng.range(0, 200);
  let core: [number, number] = [bx - (tz / tl) * off * side, bz + (tx / tl) * off * side];
  if (terrain.isWater(core[0], core[1], 40)) core = [bx - (tz / tl) * off * -side, bz + (tx / tl) * off * -side];

  const centres: Centre[] = [];
  const mainR = Math.max(500, p.radius * 0.42);
  // The CBD of a large city drifts away from the medieval core.
  let cbd: [number, number] = core;
  if (p.size > 0.35) {
    for (let k = 0; k < 20; k++) {
      const a = rng.range(0, Math.PI * 2), d = rng.range(400, 600 + p.radius * 0.1);
      const c: [number, number] = [core[0] + Math.cos(a) * d, core[1] + Math.sin(a) * d];
      if (!terrain.isWater(c[0], c[1], 150)) { cbd = c; break; }
    }
  }
  centres.push({ x: cbd[0], z: cbd[1], weight: 1, radius: mainR });
  if (cbd !== core) centres.push({ x: core[0], z: core[1], weight: 0.92, radius: mainR * 0.55 });
  const subs = Math.round(p.size * 9 + (p.size > 0.2 ? 1 : 0));
  for (let k = 0, tries = 0; k < subs && tries < 400; tries++) {
    const a = rng.range(0, Math.PI * 2), d = p.radius * rng.range(0.3, 0.85);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (terrain.isWater(x, z, 200)) continue;
    if (centres.some((c) => Math.hypot(c.x - x, c.z - z) < p.radius * 0.28)) continue;
    centres.push({ x, z, weight: rng.range(0.55, 0.85), radius: p.radius * rng.range(0.14, 0.24) });
    k++;
  }
  return { centres, core };
}

/** Variable-radius Poisson disk sampling by dart throwing on a grid. */
function poisson(rng: Rng, field: CityField, spacing: (x: number, z: number) => number, rMin: number, rMax: number, accept: (x: number, z: number) => boolean, seedPts: number[]): number[] {
  const R = field.profile.radius * 1.25;
  const cell = rMin / Math.SQRT2;
  const N = Math.ceil((2 * R) / cell);
  const grid = new Int32Array(N * N).fill(-1);
  const pts: number[] = [];
  const add = (x: number, z: number) => {
    const i = Math.floor((x + R) / cell), j = Math.floor((z + R) / cell);
    if (i < 0 || j < 0 || i >= N || j >= N) return false;
    grid[j * N + i] = pts.length >> 1;
    pts.push(x, z);
    return true;
  };
  const free = (x: number, z: number, r: number) => {
    const i = Math.floor((x + R) / cell), j = Math.floor((z + R) / cell);
    const k = Math.ceil(rMax / cell);
    for (let jj = Math.max(0, j - k); jj <= Math.min(N - 1, j + k); jj++) {
      for (let ii = Math.max(0, i - k); ii <= Math.min(N - 1, i + k); ii++) {
        const q = grid[jj * N + ii];
        if (q < 0) continue;
        const qx = pts[q * 2], qz = pts[q * 2 + 1];
        const rq = Math.min(r, spacing(qx, qz));
        if ((qx - x) * (qx - x) + (qz - z) * (qz - z) < rq * rq) return false;
      }
    }
    return true;
  };
  for (let i = 0; i < seedPts.length; i += 2) add(seedPts[i], seedPts[i + 1]);
  // Active-list Bridson with variable radius.
  const active: number[] = [];
  for (let i = 0; i < pts.length >> 1; i++) active.push(i);
  if (!active.length) {
    const c = field.centres[0];
    add(c.x, c.z);
    active.push(0);
  }
  while (active.length) {
    const ai = Math.floor(rng.float() * active.length);
    const pi = active[ai];
    const px = pts[pi * 2], pz = pts[pi * 2 + 1];
    const r = spacing(px, pz);
    let placed = false;
    for (let t = 0; t < 24; t++) {
      const a = rng.range(0, Math.PI * 2), d = r * rng.range(1, 1.6);
      const x = px + Math.cos(a) * d, z = pz + Math.sin(a) * d;
      if (!accept(x, z)) continue;
      if (!free(x, z, spacing(x, z))) continue;
      if (add(x, z)) {
        active.push((pts.length >> 1) - 1);
        placed = true;
        break;
      }
    }
    if (!placed) active.splice(ai, 1);
  }
  return pts;
}

export function buildMacroPlan(terrain: Terrain): MacroPlan {
  const p = terrain.profile;
  const rng = new Rng(deriveSeed(p.seed, 'macro'));
  const boundary = makeBoundary(p);
  const { centres, core } = makeCentres(terrain, rng.fork('centres'));
  const field = new CityField(terrain, centres, core, boundary);
  const bendNoise = new Noise(deriveSeed(p.seed, 'bend'));

  const sizeK = clamp(Math.pow(p.radius / 3000, 0.25), 0.75, 1.35);
  const rMin = 165 * sizeK, rMax = 540 * sizeK;
  const spacing = (x: number, z: number) => lerp(rMin, rMax, Math.pow(1 - field.density(x, z), 1.3));

  // --- Bank and coast nodes (forced chains).
  const seedPts: number[] = [];
  const kinds: number[] = [];
  const chains: number[][] = [];
  const BANK_OFF = 16;
  const hwAt = (r: number, s: number) => terrain.riverHalfWidthAt(r, s);
  for (let r = 0; r < terrain.rivers.length; r++) {
    const R = terrain.rivers[r];
    for (const side of [-1, 1]) {
      let chain: number[] = [];
      let lastS = -1e9;
      for (let i = 2; i < R.pts.length - 2; i += 2) {
        const s = R.s[i >> 1];
        const x = R.pts[i], z = R.pts[i + 1];
        const step = Math.min(spacing(x, z) * 0.7, 140 + hwAt(r, s) * 0.8);
        if (s - lastS < step) continue;
        const tx = R.pts[i + 2] - R.pts[i - 2], tz = R.pts[i + 3] - R.pts[i - 1];
        const tl = Math.hypot(tx, tz) || 1;
        const hw = terrain.riverHalfWidthAt(r, s);
        const off = hw + BANK_OFF + ROAD_SPEC[RoadClass.Avenue].width / 2;
        const bx = x - (tz / tl) * off * side, bz = z + (tx / tl) * off * side;
        const ok = field.inCity(bx, bz, 60) && !terrain.isWater(bx, bz, hw * 0.0 + 8) && (!p.coastal || terrain.coastDistance(bx, bz) > 60);
        if (!ok) {
          if (chain.length >= 2) chains.push(chain);
          chain = [];
          lastS = s;
          continue;
        }
        lastS = s;
        chain.push(seedPts.length >> 1);
        seedPts.push(bx, bz);
        kinds.push(1);
      }
      if (chain.length >= 2) chains.push(chain);
    }
  }
  if (p.coastal) {
    // Promenade nodes along the coast iso-line c = 70 m.
    const perp: [number, number] = [-p.seaDir[1], p.seaDir[0]];
    let chain: number[] = [];
    for (let t = -p.radius * 1.3; t <= p.radius * 1.3; t += 0) {
      const ox = perp[0] * t, oz = perp[1] * t;
      // Bisection along seaDir for coastDistance == 70.
      let lo = -p.radius * 2, hi = p.radius * 2;
      for (let k = 0; k < 40; k++) {
        const m = (lo + hi) / 2;
        const c = terrain.coastDistance(ox + p.seaDir[0] * m, oz + p.seaDir[1] * m);
        if (c > 70) lo = m; else hi = m;
      }
      const x = ox + p.seaDir[0] * lo, z = oz + p.seaDir[1] * lo;
      const step = spacing(x, z) * 0.8;
      t += step;
      if (!field.inCity(x, z, 60) || terrain.isWater(x, z, 30)) {
        if (chain.length >= 2) chains.push(chain);
        chain = [];
        continue;
      }
      // Skip nodes too close to existing bank nodes.
      let close = false;
      for (let i = 0; i < seedPts.length; i += 2) if (Math.hypot(seedPts[i] - x, seedPts[i + 1] - z) < step * 0.6) { close = true; break; }
      if (close) { if (chain.length >= 2) chains.push(chain); chain = []; continue; }
      chain.push(seedPts.length >> 1);
      seedPts.push(x, z);
      kinds.push(2);
    }
    if (chain.length >= 2) chains.push(chain);
  }

  // --- Poisson interior nodes.
  const accept = (x: number, z: number) =>
    field.inCity(x, z, 30) && !terrain.isWater(x, z, 30) && (!p.coastal || terrain.coastDistance(x, z) > 40);
  const pts = poisson(rng.fork('poisson'), field, spacing, rMin, rMax, accept, seedPts);
  const nNodes = pts.length >> 1;
  while (kinds.length < nNodes) kinds.push(0);

  // --- Delaunay → Gabriel graph.
  const del = new Delaunator(Float64Array.from(pts));
  const edgeSet = new Map<number, [number, number]>();
  const key = (a: number, b: number) => (a < b ? a * nNodes + b : b * nNodes + a);
  const tri = del.triangles, he = del.halfedges;
  const isGabriel = (e: number): boolean => {
    const a = tri[e], b = tri[e % 3 === 2 ? e - 2 : e + 1];
    const mx = (pts[a * 2] + pts[b * 2]) / 2, mz = (pts[a * 2 + 1] + pts[b * 2 + 1]) / 2;
    const r2 = ((pts[a * 2] - pts[b * 2]) ** 2 + (pts[a * 2 + 1] - pts[b * 2 + 1]) ** 2) / 4;
    const opp = (t: number) => tri[t % 3 === 0 ? t + 2 : t - 1];
    const c1 = opp(e);
    if ((pts[c1 * 2] - mx) ** 2 + (pts[c1 * 2 + 1] - mz) ** 2 < r2 * 0.98) return false;
    if (he[e] >= 0) {
      const c2 = opp(he[e]);
      if ((pts[c2 * 2] - mx) ** 2 + (pts[c2 * 2 + 1] - mz) ** 2 < r2 * 0.98) return false;
    }
    return true;
  };
  for (let e = 0; e < tri.length; e++) {
    if (he[e] > e) continue; // each undirected edge once (he=-1 hull edges too)
    const a = tri[e], b = tri[e % 3 === 2 ? e - 2 : e + 1];
    if (!isGabriel(e)) continue;
    edgeSet.set(key(a, b), [a, b]);
  }
  // Forced chain edges (bank / coast roads).
  const forced = new Set<number>();
  for (const ch of chains) {
    for (let i = 0; i + 1 < ch.length; i++) {
      const a = ch[i], b = ch[i + 1];
      if (Math.hypot(pts[a * 2] - pts[b * 2], pts[a * 2 + 1] - pts[b * 2 + 1]) > rMax * 2.2) continue;
      edgeSet.set(key(a, b), [a, b]);
      forced.add(key(a, b));
    }
  }

  // --- Water crossings → bridge candidates.
  const crossesWater = (a: number, b: number, margin = 2): number => {
    const ax = pts[a * 2], az = pts[a * 2 + 1], bx = pts[b * 2], bz = pts[b * 2 + 1];
    const L = Math.hypot(bx - ax, bz - az);
    const n = Math.max(4, Math.ceil(L / (margin > 0 ? 8 : 3)));
    let wet = 0;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (terrain.isWater(ax + (bx - ax) * t, az + (bz - az) * t, margin)) wet++;
    }
    return (wet / n) * L;
  };
  const bridgeCands: { k: number; a: number; b: number; wet: number; s: number; river: number; len: number }[] = [];
  /** Every river crossing (also oblique ones): fallback links when the network falls apart. */
  const crossings: typeof bridgeCands = [];
  for (const [k, [a, b]] of [...edgeSet]) {
    const wet = crossesWater(a, b);
    if (wet <= 0) continue;
    edgeSet.delete(k);
    forced.delete(k);
    const ax = pts[a * 2], az = pts[a * 2 + 1], bx = pts[b * 2], bz = pts[b * 2 + 1];
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    if (p.coastal && terrain.coastDistance(mx, mz) < 0) continue; // never bridge the sea
    const w = terrain.water(mx, mz);
    if (w.river < 0) continue;
    // Only real crossings: an edge that merely clips a bend has far less water than the river is wide.
    if (crossesWater(a, b, 0) < w.halfWidth * 2 * 0.6) continue;
    const len = Math.hypot(bx - ax, bz - az);
    // Angle to the river: |sin| of edge vs. river direction (1 = straight across).
    const R = terrain.rivers[w.river];
    let i = 0;
    while (i < R.s.length - 2 && R.s[i + 1] < w.s) i++;
    const tx = R.pts[i * 2 + 2] - R.pts[i * 2], tz = R.pts[i * 2 + 3] - R.pts[i * 2 + 1];
    const across = Math.abs((bx - ax) * tz - (bz - az) * tx) / (len * Math.hypot(tx, tz) || 1);
    if (across < 0.64) continue; // under ~40°: runs along the river
    crossings.push({ k, a, b, wet, s: w.s, river: w.river, len });
    if (across < 0.82) continue; // bridges proper cross at 55° or more
    bridgeCands.push({ k, a, b, wet, s: w.s, river: w.river, len });
  }
  // Pick bridges spaced along each river; denser downtown.
  bridgeCands.sort((x, y) => x.wet / x.len - y.wet / y.len || x.len - y.len);
  const chosen: typeof bridgeCands = [];
  for (const c of bridgeCands) {
    const mx = (pts[c.a * 2] + pts[c.b * 2]) / 2, mz = (pts[c.a * 2 + 1] + pts[c.b * 2 + 1]) / 2;
    const gap = lerp(260, 1100, Math.pow(1 - field.density(mx, mz), 1.5)) * (0.85 + 0.3 * (p.riverWidth / 200));
    if (chosen.some((o) => o.river === c.river && Math.abs(o.s - c.s) < gap)) continue;
    chosen.push(c);
  }
  for (const c of chosen) edgeSet.set(c.k, [c.a, c.b]);
  const bridgeKeys = new Set(chosen.map((c) => c.k));
  crossings.sort((x, y) => x.wet - y.wet || x.len - y.len);

  // --- Prune steep edges and thin out the sparse outskirts.
  const pr = rng.fork('prune');
  const deg = new Int32Array(nNodes);
  for (const [, [a, b]] of edgeSet) { deg[a]++; deg[b]++; }
  const edgeList = [...edgeSet.entries()].sort((x, y) => x[0] - y[0]);
  for (const [k, [a, b]] of edgeList) {
    if (forced.has(k) || bridgeKeys.has(k)) continue;
    const ax = pts[a * 2], az = pts[a * 2 + 1], bx = pts[b * 2], bz = pts[b * 2 + 1];
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const L = Math.hypot(bx - ax, bz - az);
    const grade = Math.abs(terrain.height(ax, az) - terrain.height(bx, bz)) / L;
    const dens = field.density(mx, mz);
    const removeP = (grade > 0.11 ? 0.8 : 0) + (1 - dens) * 0.16;
    if (deg[a] > 3 && deg[b] > 3 && pr.chance(removeP)) {
      edgeSet.delete(k);
      deg[a]--; deg[b]--;
    }
  }

  // --- Merge triangles into quads: drop the longest edge of triangular faces
  // (real arterial grids are dominated by 4-way junctions and quad blocks).
  {
    const mr = rng.fork('merge');
    const faces = straightFaces(pts, [...edgeSet.values()]);
    const faceOfEdge = new Map<number, number[]>();
    faces.forEach((f, fi) => {
      for (let i = 0; i < f.length; i++) {
        const k = key(f[i], f[(i + 1) % f.length]);
        (faceOfEdge.get(k) ?? faceOfEdge.set(k, []).get(k)!).push(fi);
      }
    });
    const merged = new Uint8Array(faces.length);
    const order = faces.map((_, i) => i);
    mr.shuffle(order);
    const degM = new Int32Array(nNodes);
    for (const [, [a, b]] of edgeSet) { degM[a]++; degM[b]++; }
    for (const fi of order) {
      const f = faces[fi];
      if (f.length !== 3 || merged[fi]) continue;
      let bk = -1, bl = -1, ba = -1, bb = -1;
      for (let i = 0; i < 3; i++) {
        const a = f[i], b = f[(i + 1) % 3];
        const L = Math.hypot(pts[a * 2] - pts[b * 2], pts[a * 2 + 1] - pts[b * 2 + 1]);
        if (L > bl) { bl = L; bk = key(a, b); ba = a; bb = b; }
      }
      if (forced.has(bk) || bridgeKeys.has(bk) || !edgeSet.has(bk)) continue;
      const adjF = (faceOfEdge.get(bk) ?? []).filter((o) => o !== fi);
      if (adjF.length !== 1 || merged[adjF[0]] || faces[adjF[0]].length > 4) continue;
      if (degM[ba] <= 3 || degM[bb] <= 3) continue;
      const mx = (pts[ba * 2] + pts[bb * 2]) / 2, mz = (pts[ba * 2 + 1] + pts[bb * 2 + 1]) / 2;
      if (!mr.chance(0.55 + 0.4 * p.gridness * field.density(mx, mz) + 0.2)) continue;
      edgeSet.delete(bk);
      degM[ba]--; degM[bb]--;
      merged[fi] = 1;
      merged[adjF[0]] = 1;
    }
  }

  // --- Remove dangling nodes iteratively; keep the largest component.
  const adj = (): Map<number, number[]> => {
    const m = new Map<number, number[]>();
    for (const [, [a, b]] of edgeSet) {
      (m.get(a) ?? m.set(a, []).get(a)!).push(b);
      (m.get(b) ?? m.set(b, []).get(b)!).push(a);
    }
    return m;
  };
  for (let changed = true; changed;) {
    changed = false;
    const m = adj();
    for (const [n, nb] of m) {
      if (nb.length < 2) {
        for (const o of nb) edgeSet.delete(key(n, o));
        changed = true;
      }
    }
  }
  const components = () => {
    const m = adj();
    const comp = new Map<number, number>();
    let bestC = -1, bestSize = 0, c = 0;
    for (const n of m.keys()) {
      if (comp.has(n)) continue;
      const stack = [n];
      comp.set(n, c);
      let size = 0;
      while (stack.length) {
        const u = stack.pop()!;
        size++;
        for (const v of m.get(u)!) if (!comp.has(v)) { comp.set(v, c); stack.push(v); }
      }
      if (size > bestSize) { bestSize = size; bestC = c; }
      c++;
    }
    return { comp, bestC, count: c };
  };
  // A river can cut the network in two when the chosen bridges all land on one side:
  // reconnect each detached part with its best crossing instead of dropping it.
  for (let guard = 0; guard < 16; guard++) {
    const { comp, bestC, count } = components();
    if (count <= 1) break;
    const link = crossings.find((c) => !edgeSet.has(c.k) && comp.has(c.a) && comp.has(c.b) && comp.get(c.a) !== comp.get(c.b) && (comp.get(c.a) === bestC || comp.get(c.b) === bestC));
    if (!link) break;
    edgeSet.set(link.k, [link.a, link.b]);
    bridgeKeys.add(link.k);
  }
  {
    const { comp, bestC } = components();
    for (const [k, [a]] of [...edgeSet]) if (comp.get(a) !== bestC) edgeSet.delete(k);
  }

  // --- Compact node / edge arrays.
  const used = new Map<number, number>();
  const nodes: ArterialNode[] = [];
  const nodeId = (i: number) => {
    let id = used.get(i);
    if (id === undefined) {
      id = nodes.length;
      used.set(i, id);
      nodes.push({ x: pts[i * 2], z: pts[i * 2 + 1], edges: [], kind: kinds[i] });
    }
    return id;
  };
  const edges: ArterialEdge[] = [];
  const sortedEdges = [...edgeSet.entries()].sort((x, y) => x[0] - y[0]);
  const isBridgeEdge: boolean[] = [];
  for (const [k, [a, b]] of sortedEdges) {
    const ia = nodeId(a), ib = nodeId(b);
    const e: ArterialEdge = { id: edges.length, a: ia, b: ib, cls: RoadClass.Avenue, width: 0, sidewalk: 0, pts: [], bridge: bridgeKeys.has(k), median: false, lanes: 2 };
    edges.push(e);
    nodes[ia].edges.push(e.id);
    nodes[ib].edges.push(e.id);
    isBridgeEdge.push(e.bridge);
  }

  // --- Road hierarchy: edges carrying many centre-to-centre / centre-to-gate trips become boulevards.
  const usage = new Float64Array(edges.length);
  const gates: number[] = [];
  {
    // Gates: boundary-most nodes in 8 sectors.
    const best = new Array(8).fill(-1), bestD = new Array(8).fill(0);
    nodes.forEach((n, i) => {
      const a = Math.floor((((Math.atan2(n.z, n.x) / (Math.PI * 2)) + 1) % 1) * 8);
      const d = Math.hypot(n.x, n.z);
      if (d > bestD[a]) { bestD[a] = d; best[a] = i; }
    });
    for (const g of best) if (g >= 0) gates.push(g);
  }
  const nearestNode = (x: number, z: number) => {
    let bi = 0, bd = Infinity;
    nodes.forEach((n, i) => { const d = (n.x - x) ** 2 + (n.z - z) ** 2; if (d < bd) { bd = d; bi = i; } });
    return bi;
  };
  const sources = [...centres.map((c) => nearestNode(c.x, c.z)), ...gates];
  const edgeLen = edges.map((e) => Math.hypot(nodes[e.a].x - nodes[e.b].x, nodes[e.a].z - nodes[e.b].z));
  for (const src of sources) {
    // Dijkstra (simple O(n^2) fallback is fine for a few thousand nodes with a binary heap).
    const dist = new Float64Array(nodes.length).fill(Infinity);
    const via = new Int32Array(nodes.length).fill(-1);
    dist[src] = 0;
    const heap = new MinHeap();
    heap.push(0, src);
    while (heap.size) {
      const u = heap.pop();
      const d = heap.lastPriority;
      if (d > dist[u]) continue;
      for (const eid of nodes[u].edges) {
        const e = edges[eid];
        const v = e.a === u ? e.b : e.a;
        const nd = d + edgeLen[eid];
        if (nd < dist[v]) { dist[v] = nd; via[v] = eid; heap.push(nd, v); }
      }
    }
    for (const dst of sources) {
      if (dst === src) continue;
      let u = dst, guard = 0;
      while (u !== src && via[u] >= 0 && guard++ < 10000) {
        const e = edges[via[u]];
        usage[e.id] += 1;
        u = e.a === u ? e.b : e.a;
      }
    }
  }
  const maxUse = Math.max(1, ...usage);
  const boulevardCut = Math.max(2, maxUse * 0.18);
  for (const e of edges) {
    const n0 = nodes[e.a], n1 = nodes[e.b];
    const dens = field.density((n0.x + n1.x) / 2, (n0.z + n1.z) / 2);
    let cls = usage[e.id] >= boulevardCut && p.radius > 1500 ? RoadClass.Boulevard : RoadClass.Avenue;
    if (p.radius < 1400 && usage[e.id] < 1 && dens < 0.35) cls = RoadClass.Street;
    const spec = ROAD_SPEC[cls];
    e.cls = cls;
    e.width = spec.width * (cls === RoadClass.Avenue ? lerp(0.85, 1.15, dens) : 1);
    e.sidewalk = spec.sidewalk;
    e.lanes = spec.lanes;
    e.median = cls === RoadClass.Boulevard;
  }

  // --- Edge geometry: gentle organic bends (not on bridges or bank chains).
  for (const e of edges) {
    const n0 = nodes[e.a], n1 = nodes[e.b];
    const L = Math.hypot(n1.x - n0.x, n1.z - n0.z);
    const segs = Math.max(1, Math.round(L / 40));
    const bend = e.bridge || (n0.kind > 0 && n1.kind > 0) ? 0 : L * 0.05 * (1 - p.gridness * 0.7);
    const dx = (n1.x - n0.x) / L, dz = (n1.z - n0.z) / L;
    const ph = bendNoise.n2(e.a * 0.37, e.b * 0.37) * 10;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const off = Math.sin(Math.PI * t) * bend * bendNoise.n2(ph + t * 1.3, ph);
      e.pts.push(n0.x + (n1.x - n0.x) * t - dz * off, n0.z + (n1.z - n0.z) * t + dx * off);
    }
  }

  // --- Faces → cells.
  const cells = extractCells(nodes, edges, field, terrain, rng.fork('cells'));

  // --- Bridges.
  const bridges: Bridge[] = [];
  for (const e of edges) {
    if (!e.bridge) continue;
    const mx = (e.pts[0] + e.pts[e.pts.length - 2]) / 2, mz = (e.pts[1] + e.pts[e.pts.length - 1]) / 2;
    const w = terrain.water(mx, mz);
    const span = Math.hypot(e.pts[e.pts.length - 2] - e.pts[0], e.pts[e.pts.length - 1] - e.pts[1]);
    const br = rng.fork('bridge', e.id);
    const dens = field.density(mx, mz);
    const style: Bridge['style'] =
      w.halfWidth * 2 > 260 && br.chance(0.6) ? 'suspension'
        : dens > 0.6 && p.arch.oldWorld > 0.4 && w.halfWidth < 90 && br.chance(0.7) ? 'stone'
          : br.pick(['arch', 'girder', 'truss', 'girder', 'arch'] as const);
    bridges.push({ edge: e.id, pts: e.pts.slice(), width: e.width + e.sidewalk * 2, clearance: Math.min(14, 5 + span * 0.02), style, waterLevel: w.river >= 0 ? w.level : 0 });
  }

  const plan: MacroPlan = {
    seed: p.seed, centres, core, nodes, edges, cells, bridges,
    metroLines: [], metroStations: [], sewers: [], boundary,
  };
  planUnderground(plan, field, terrain);
  return plan;
}

/** Faces of the planar arterial graph → cells with districts. */
function extractCells(nodes: ArterialNode[], edges: ArterialEdge[], field: CityField, terrain: Terrain, rng: Rng): CellInfo[] {
  const p = field.profile;
  // Sort incident edges by angle around each node.
  const sorted: number[][] = nodes.map((n, ni) => {
    return n.edges.slice().sort((ea, eb) => {
      const other = (eid: number) => {
        const e = edges[eid];
        // direction of the first segment leaving the node
        if (e.a === ni) return Math.atan2(e.pts[3] - e.pts[1], e.pts[2] - e.pts[0]);
        const L = e.pts.length;
        return Math.atan2(e.pts[L - 3] - e.pts[L - 1], e.pts[L - 4] - e.pts[L - 2]);
      };
      return other(ea) - other(eb);
    });
  });
  const visited = new Set<string>();
  const cells: CellInfo[] = [];
  const noise = new Noise(deriveSeed(p.seed, 'district'));
  for (const e0 of edges) {
    for (const dir of [true, false]) {
      const k0 = `${e0.id}:${dir ? 1 : 0}`;
      if (visited.has(k0)) continue;
      const poly: number[] = [];
      const eids: number[] = [];
      let eid = e0.id, fwd = dir, guard = 0, ok = true;
      while (guard++ < 400) {
        const k = `${eid}:${fwd ? 1 : 0}`;
        if (visited.has(k)) { ok = k === k0 && eids.length > 0; break; }
        visited.add(k);
        const e = edges[eid];
        eids.push(eid);
        const P = e.pts;
        const n = P.length >> 1;
        // Append polyline excluding the final vertex.
        if (fwd) for (let i = 0; i < n - 1; i++) poly.push(P[i * 2], P[i * 2 + 1]);
        else for (let i = n - 1; i > 0; i--) poly.push(P[i * 2], P[i * 2 + 1]);
        const v = fwd ? e.b : e.a;
        // Next edge: the one immediately clockwise from the reverse of the edge we arrived on.
        const list = sorted[v];
        const idx = list.indexOf(eid);
        const nextE = list[(idx - 1 + list.length) % list.length];
        const ne = edges[nextE];
        fwd = ne.a === v;
        eid = nextE;
      }
      if (!ok || poly.length < 6) continue;
      const area = polyArea(poly);
      if (area <= 0) continue; // outer face (clockwise)
      if (area > p.radius * p.radius * 2) continue;
      const c = polyCentroid(poly);
      let rad = 0;
      for (let i = 0; i < poly.length; i += 2) rad = Math.max(rad, Math.hypot(poly[i] - c[0], poly[i + 1] - c[1]));
      cells.push({ id: cells.length, poly, edges: eids, centroid: c, area, district: 'apartments', density: 0, gridAngle: 0, gridness: 0, era: 0, radius: rad });
    }
  }
  const clipped = clipCellsByWater(cells, terrain);
  assignDistricts(clipped, field, terrain, noise, rng);
  return clipped;
}

/** Remove water from cells; cells split by water become several cells. */
function clipCellsByWater(cells: CellInfo[], terrain: Terrain): CellInfo[] {
  // The city's own rivers (countryside rivers never reach a cell).
  const chunks = riverChunks(terrain, 0.5, terrain.baseRivers);
  const sea = seaPolygon(terrain, 0.5);
  const out: CellInfo[] = [];
  for (const c of cells) {
    const b = polyBounds(c.poly);
    const clipPolys: Poly[] = [];
    for (const ch of chunks) {
      if (ch.bounds[0] > b[2] || ch.bounds[2] < b[0] || ch.bounds[1] > b[3] || ch.bounds[3] < b[1]) continue;
      for (const s of ch.shapes) clipPolys.push(s.outer);
    }
    if (sea) clipPolys.push(sea);
    let pieces: Poly[] = [c.poly];
    if (clipPolys.length) {
      const res = difference([c.poly], clipPolys);
      pieces = res.map((r) => r.outer);
    }
    const total = pieces.reduce((a, q) => a + Math.abs(polyArea(q)), 0);
    if (total < c.area * 0.25) continue; // essentially water
    for (const q of pieces) {
      const area = Math.abs(polyArea(q));
      if (area < 4000) continue;
      const poly = ensureCCW(cleanPoly(q, 0.05));
      const cen = polyCentroid(poly);
      let rad = 0;
      for (let i = 0; i < poly.length; i += 2) rad = Math.max(rad, Math.hypot(poly[i] - cen[0], poly[i + 1] - cen[1]));
      out.push({ ...c, id: out.length, poly, centroid: cen, area, radius: rad });
    }
  }
  return out;
}

function waterFraction(poly: number[], terrain: Terrain): number {
  let wet = 0, tot = 0;
  const c = polyCentroid(poly);
  const n = poly.length >> 1;
  for (let i = 0; i < n; i++) {
    for (const t of [0.25, 0.6, 0.9]) {
      const x = c[0] + (poly[i * 2] - c[0]) * t, z = c[1] + (poly[i * 2 + 1] - c[1]) * t;
      tot++;
      if (terrain.isWater(x, z)) wet++;
    }
  }
  tot++;
  if (terrain.isWater(c[0], c[1])) wet++;
  return wet / tot;
}

function assignDistricts(cells: CellInfo[], field: CityField, terrain: Terrain, noise: Noise, rng: Rng): void {
  const p = field.profile;
  const arch = p.arch;
  const oldWorld = arch.oldWorld / (arch.oldWorld + arch.american + 0.3);
  const oldR = lerp(250, 1100, Math.min(1, p.radius / 8000)) * (0.45 + oldWorld * 0.8);
  // City-wide grid orientations per centre (boroughs have their own grid).
  const gridAngles = field.centres.map((_, i) => rng.fork('grid', i).range(0, Math.PI));
  // Main-river mouth for a port.
  for (const c of cells) {
    const [x, z] = c.centroid;
    c.density = field.density(x, z);
    const wf = waterFraction(c.poly, terrain);
    const d = c.density;
    const n = noise.fbm2(x / 900, z / 900, 3);
    const cr = rng.fork('cell', c.id);
    let dist: District;
    const dCore = Math.hypot(x - field.core[0], z - field.core[1]);
    const coast = terrain.coastDistance(x, z);
    const slope = terrain.slope(x, z, 40);
    if (wf > 0.45) dist = 'water';
    else if (dCore < oldR && (oldWorld > 0.25 || p.cls === 'town')) dist = 'oldtown';
    else if (d > 0.74) dist = 'downtown';
    else if (d > 0.6) dist = n > 0.25 ? 'downtown' : 'commercial';
    else if (slope > 0.2 && cr.chance(0.5)) dist = 'park';
    else if (p.coastal && coast < 500 && coast > 0 && cr.chance(0.45) && d < 0.65) dist = 'port';
    else if (n < -0.38 && d < 0.6 && d > 0.12) dist = 'industrial';
    else if (cr.chance(0.05 + (slope > 0.14 ? 0.1 : 0))) dist = 'park';
    else if (d > 0.42) dist = arch.american > arch.oldWorld && cr.chance(0.35) ? 'rowhouses' : 'apartments';
    else if (d > 0.24) dist = cr.chance(0.55) ? 'rowhouses' : 'apartments';
    else dist = 'suburban';
    c.district = dist;
    // Nearest centre decides grid orientation; grids are stronger in planned (non-old) areas.
    let bi = 0, bd = Infinity;
    field.centres.forEach((ce, i) => { const dd = Math.hypot(ce.x - x, ce.z - z) / ce.radius; if (dd < bd) { bd = dd; bi = i; } });
    c.gridAngle = gridAngles[bi] + noise.n2(x / 3000, z / 3000) * 0.35 * (1 - p.gridness);
    c.gridness = dist === 'oldtown' ? 0.05 : dist === 'suburban' ? p.gridness * 0.4 : clamp(p.gridness + n * 0.25, 0, 1);
    c.era = dist === 'oldtown' ? 0.05 : dist === 'downtown' ? 0.85 : clamp(0.35 + (1 - d) * 0.4 + n * 0.3, 0, 1);
  }
  // A grand central park in large cities.
  if (p.radius > 3500) {
    let best: CellInfo | null = null, bs = -Infinity;
    for (const c of cells) {
      if (c.district === 'water' || c.district === 'oldtown') continue;
      const s = c.area / 1e5 - Math.abs(c.density - 0.62) * 8;
      if (s > bs) { bs = s; best = c; }
    }
    if (best) best.district = 'park';
  }
}

/** Faces (node loops, CCW) of a straight-line planar graph. */
function straightFaces(pts: number[], edgeList: [number, number][]): number[][] {
  const nb = new Map<number, number[]>();
  for (const [a, b] of edgeList) {
    (nb.get(a) ?? nb.set(a, []).get(a)!).push(b);
    (nb.get(b) ?? nb.set(b, []).get(b)!).push(a);
  }
  for (const [n, list] of nb) list.sort((u, v) => Math.atan2(pts[u * 2 + 1] - pts[n * 2 + 1], pts[u * 2] - pts[n * 2]) - Math.atan2(pts[v * 2 + 1] - pts[n * 2 + 1], pts[v * 2] - pts[n * 2]));
  const seen = new Set<string>();
  const faces: number[][] = [];
  for (const [a, b] of edgeList) {
    for (const [u0, v0] of [[a, b], [b, a]]) {
      if (seen.has(u0 + ',' + v0)) continue;
      const loop: number[] = [];
      let u = u0, v = v0, guard = 0;
      while (guard++ < 64) {
        const k = u + ',' + v;
        if (seen.has(k)) break;
        seen.add(k);
        loop.push(u);
        const list = nb.get(v)!;
        const i = list.indexOf(u);
        const w = list[(i - 1 + list.length) % list.length];
        u = v; v = w;
      }
      const poly: number[] = [];
      for (const n of loop) poly.push(pts[n * 2], pts[n * 2 + 1]);
      if (loop.length >= 3 && polyArea(poly) > 0) faces.push(loop);
    }
  }
  return faces;
}
