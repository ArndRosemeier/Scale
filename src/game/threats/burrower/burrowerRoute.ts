/**
 * The Burrower's way under the city (THREATS_PLAN §1 #3). Pure (plan only), deterministic per seed,
 * headless-testable.
 *
 *  - Entry: an arterial junction ROUTE.entry m out from the main centre, on the side the hero is on
 *    (± a seeded angle), well inside the city's edge: it comes up through the districts towards
 *    downtown and passes near whoever is about.
 *  - Way: the cheapest path over the arterial graph to the junction nearest the main centre — under
 *    the boulevards along the sewer trunks, bridges included (it passes under the river).
 *  - Breaches: where along the way it means to come up (arc lengths, the first soon after it sets
 *    off, then every 130–210 m); the game snaps each to a spot where the street can cave in.
 */
import type { MacroPlan } from '../../../plan/types';
import { boundaryAt } from '../../../world/boundary';
import { MinHeap } from '../../../core/heap';
import { resample, polylineLength } from '../../../core/geom2';
import { Rng } from '../../../core/rng';

export interface BurrowRoute {
  /** Polyline (x, z, …) ~8 m apart from the entry to downtown, and the arc length at each point. */
  pts: number[];
  s: number[];
  length: number;
  start: { x: number; z: number };
  end: { x: number; z: number };
  /** Arc lengths where it plans to break through the street. */
  breaches: number[];
  /** Arterial edges followed. */
  edges: number[];
}

export const BURROW_ROUTE = {
  /** Entry distance from the main centre (m, straight line), at most this share of the city's radius there. */
  entry: [650, 1050] as [number, number], edgeShare: 0.82,
  /** How far off the hero's bearing the entry may be (rad). */
  spread: 0.55,
  /** First breach after this much (m), then gaps (m), none closer than this to the end. */
  first: [90, 150] as [number, number], gap: [130, 210] as [number, number], endKeep: 30,
  /** Edge cost by class (it keeps to the big trunks). */
  clsCost: [1, 1.1, 1.5, 2, 3],
  spacing: 8,
};

/** The Burrower's way to downtown, or null (no arterial graph). `toward`: where the hero is. */
export function planBurrowerRoute(macro: MacroPlan, seed: number, toward?: { x: number; z: number }): BurrowRoute | null {
  const R = BURROW_ROUTE, rng = new Rng(seed);
  const c0 = macro.centres[0];
  const N = macro.nodes.length;
  if (!N) return null;
  // ---- downtown: the junction nearest the main centre
  let dest = -1, dd = Infinity;
  for (let i = 0; i < N; i++) {
    const n = macro.nodes[i];
    if (n.edges.length < 2) continue;
    const d = Math.hypot(n.x - c0.x, n.z - c0.z);
    if (d < dd) { dd = d; dest = i; }
  }
  if (dest < 0) return null;
  // ---- entry: on the hero's side (or a seeded one when they are downtown)
  const far = toward && Math.hypot(toward.x - c0.x, toward.z - c0.z) > 200;
  const bearing = (far ? Math.atan2(toward!.z - c0.z, toward!.x - c0.x) : rng.range(-Math.PI, Math.PI)) + rng.range(-R.spread, R.spread);
  const want = rng.range(R.entry[0], R.entry[1]);
  const elen = macro.edges.map((e) => polylineLength(e.pts));
  // Cost to downtown from every junction.
  const dist = new Float64Array(N).fill(Infinity), next = new Int32Array(N).fill(-1), via = new Int32Array(N).fill(-1);
  dist[dest] = 0;
  const heap = new MinHeap();
  heap.push(0, dest);
  while (heap.size) {
    const u = heap.pop();
    if (heap.lastPriority > dist[u]) continue;
    for (const ei of macro.nodes[u].edges) {
      const e = macro.edges[ei];
      const v = e.a === u ? e.b : e.a;
      const nd = dist[u] + elen[ei] * (R.clsCost[e.cls] ?? 3);
      if (nd < dist[v]) { dist[v] = nd; next[v] = u; via[v] = ei; heap.push(nd, v); }
    }
  }
  let entry = -1, es = Infinity;
  for (let i = 0; i < N; i++) {
    const n = macro.nodes[i];
    if (!isFinite(dist[i]) || i === dest || n.edges.length < 2) continue;
    const r = Math.hypot(n.x - c0.x, n.z - c0.z);
    const edge = boundaryAt(macro.boundary, n.x, n.z) * R.edgeShare;
    if (r > edge) continue;
    let da = Math.atan2(n.z - c0.z, n.x - c0.x) - bearing;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    const score = Math.abs(r - Math.min(want, edge)) + Math.abs(da) * 420;
    if (score < es) { es = score; entry = i; }
  }
  if (entry < 0) return null;
  // ---- the polyline
  const raw: number[] = [];
  const edges: number[] = [];
  for (let u = entry; u !== dest && u >= 0; u = next[u]) {
    const ei = via[u], e = macro.edges[ei], p = e.pts, n = p.length >> 1, fwd = e.a === u;
    for (let k = 0; k < n; k++) {
      const j = fwd ? k : n - 1 - k;
      const x = p[j * 2], z = p[j * 2 + 1];
      if (raw.length && Math.hypot(x - raw[raw.length - 2], z - raw[raw.length - 1]) < 0.5) continue;
      raw.push(x, z);
    }
    edges.push(ei);
  }
  if (raw.length < 4) return null;
  const pts = resample(raw, R.spacing);
  const s: number[] = [0];
  for (let i = 1; i < pts.length / 2; i++) s.push(s[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]));
  const L = s[s.length - 1];
  const breaches: number[] = [];
  for (let b = rng.range(R.first[0], R.first[1]); b < L - R.endKeep; b += rng.range(R.gap[0], R.gap[1])) breaches.push(b);
  return { pts, s, length: L, start: { x: pts[0], z: pts[1] }, end: { x: pts[pts.length - 2], z: pts[pts.length - 1] }, breaches, edges };
}
