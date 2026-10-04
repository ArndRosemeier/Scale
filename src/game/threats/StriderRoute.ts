/**
 * Where the Strider rises and the way it walks (THREATS_PLAN §1 #1). Pure (plan and terrain only),
 * deterministic per seed, headless-testable.
 *
 *  - Emergence: every seed has a river. The point is in the city's river about ROUTE.rise from the
 *    main centre (downtown), preferring a spot beside a bridge or a quay (a bank road): the monster
 *    rises where people are and walks through town into downtown. It stands off the bridge itself and
 *    towards the downtown bank.
 *  - Route: from the water up the bank to an arterial node (a straight landing that leaves the
 *    water once and never re-enters it), then the shortest way over the arterial graph (boulevards
 *    preferred, bridges never — it wades, it does not cross on decks) to the node nearest the main
 *    centre. Resampled every ~8 m with arc lengths.
 */
import type { MacroPlan } from '../../plan/types';
import type { Terrain } from '../../world/terrain';
import { boundaryAt } from '../../world/boundary';
import { MinHeap } from '../../core/heap';
import { resample } from '../../core/geom2';

export interface StriderRoute {
  /** Where it rises (in the river). */
  start: { x: number; z: number };
  /** Polyline (x, z, …) from the start to downtown, ~8 m apart, and the arc length at each point. */
  pts: number[];
  s: number[];
  length: number;
  /** Arc length where the route leaves the water. */
  landS: number;
  /** Arterial edges followed, in order. */
  edges: number[];
  /** Length walked on arterial edges (m). */
  onArterials: number;
  end: { x: number; z: number };
  /** River, arc length on it, and the bridge next to the start (−1: none). */
  river: number;
  riverS: number;
  bridge: number;
}

export const ROUTE = {
  /** River samples every this many m. */
  sample: 24,
  /** Bridges count from this far (m): close enough to see, far enough not to stand in the deck. */
  bridgeNear: 55, bridgeFar: 170, bridgeBonus: 160,
  /** A quay (bank road node) this close: bonus. */
  quayR: 90, quayBonus: 70,
  /** Rise about this far from the main centre (m, straight line): a walk through town into downtown. */
  rise: 750,
  /** Landing: candidate nodes within this distance (m), cost weight of the landing walk (short: up the bank to the road). */
  landR: 320, landW: 4,
  /** Edge cost by class (boulevard, avenue, street …). */
  clsCost: [1, 1.15, 1.6, 2, 3],
  spacing: 8,
};

/** The Strider's way from the river to downtown, or null (no river in the city). `from`: a fixed start. */
export function planStriderRoute(macro: MacroPlan, terrain: Terrain, from?: { x: number; z: number }): StriderRoute | null {
  const c0 = macro.centres[0];
  // ---- emergence point
  let best = { x: 0, z: 0, score: Infinity, river: -1, s: 0, bridge: -1 };
  const bridgeMid = macro.bridges.map((b) => { const p = b.pts, n = p.length >> 1, i = n >> 1; return { x: p[i * 2], z: p[i * 2 + 1] }; });
  const quays = macro.nodes.filter((n) => n.kind === 1);
  if (from) {
    const w = terrain.water(from.x, from.z);
    best = { x: from.x, z: from.z, score: 0, river: w.river, s: w.s, bridge: -1 };
  } else {
    for (let r = 0; r < terrain.baseRivers; r++) {
      const R = terrain.rivers[r], P = R.pts;
      const step = Math.max(1, Math.round(ROUTE.sample / 12));
      for (let i = 0; i < P.length / 2; i += step) {
        const x = P[i * 2], z = P[i * 2 + 1];
        if (Math.hypot(x, z) > boundaryAt(macro.boundary, x, z) * 0.92) continue;
        let score = Math.abs(Math.hypot(x - c0.x, z - c0.z) - ROUTE.rise), bridge = -1;
        for (let b = 0; b < bridgeMid.length; b++) {
          const d = Math.hypot(bridgeMid[b].x - x, bridgeMid[b].z - z);
          if (d < ROUTE.bridgeNear) { score += 400; bridge = -1; break; }
          if (d < ROUTE.bridgeFar && bridge < 0) { score -= ROUTE.bridgeBonus; bridge = b; }
        }
        if (quays.some((q) => Math.hypot(q.x - x, q.z - z) < ROUTE.quayR)) score -= ROUTE.quayBonus;
        if (score < best.score) best = { x, z, score, river: r, s: R.s[i], bridge };
      }
    }
    if (best.river < 0) return null;
    // Off the centreline towards downtown (the monster wades out on the near side).
    const hw = terrain.riverHalfWidthAt(best.river, best.s);
    const dx = c0.x - best.x, dz = c0.z - best.z, dl = Math.hypot(dx, dz) || 1;
    best.x += (dx / dl) * hw * 0.35; best.z += (dz / dl) * hw * 0.35;
  }
  const start = { x: best.x, z: best.z };
  // ---- arterial graph without bridges: cost to downtown from every node
  const N = macro.nodes.length;
  let dest = -1, dd = Infinity;
  for (let i = 0; i < N; i++) {
    const n = macro.nodes[i];
    if (n.edges.filter((e) => !macro.edges[e].bridge).length < 2) continue;
    const d = Math.hypot(n.x - c0.x, n.z - c0.z);
    if (d < dd) { dd = d; dest = i; }
  }
  if (dest < 0) return null;
  const elen = macro.edges.map((e) => { let L = 0; for (let k = 0; k + 3 < e.pts.length; k += 2) L += Math.hypot(e.pts[k + 2] - e.pts[k], e.pts[k + 3] - e.pts[k + 1]); return L; });
  const dist = new Float64Array(N).fill(Infinity), next = new Int32Array(N).fill(-1), via = new Int32Array(N).fill(-1);
  dist[dest] = 0;
  const heap = new MinHeap();
  heap.push(0, dest);
  while (heap.size) {
    const u = heap.pop();
    if (heap.lastPriority > dist[u]) continue;
    for (const ei of macro.nodes[u].edges) {
      const e = macro.edges[ei];
      if (e.bridge) continue;
      const v = e.a === u ? e.b : e.a;
      const nd = dist[u] + elen[ei] * (ROUTE.clsCost[e.cls] ?? 3);
      if (nd < dist[v]) { dist[v] = nd; next[v] = u; via[v] = ei; heap.push(nd, v); }
    }
  }
  // ---- landing: up the bank to the node that makes the cheapest whole way
  let land = -1, lc = Infinity;
  for (let i = 0; i < N; i++) {
    const n = macro.nodes[i];
    if (!isFinite(dist[i])) continue;
    const L = Math.hypot(n.x - start.x, n.z - start.z);
    if (L > ROUTE.landR || terrain.isWater(n.x, n.z, 4)) continue;
    // Leaves the water once: no wet sample after the first dry one.
    let dry = false, ok = true;
    for (let t = 0; t <= L; t += 6) {
      const x = start.x + (n.x - start.x) * (t / (L || 1)), z = start.z + (n.z - start.z) * (t / (L || 1));
      const wet = terrain.isWater(x, z, 1);
      if (!wet) dry = true; else if (dry) { ok = false; break; }
    }
    if (!ok) continue;
    const c = L * ROUTE.landW + dist[i];
    if (c < lc) { lc = c; land = i; }
  }
  if (land < 0) return null;
  // ---- the polyline
  const raw: number[] = [start.x, start.z];
  const edges: number[] = [];
  let onArt = 0;
  for (let u = land; u !== dest && u >= 0; u = next[u]) {
    const ei = via[u], e = macro.edges[ei];
    const p = e.pts;
    const fwd = e.a === u;
    const n = p.length >> 1;
    for (let k = 0; k < n; k++) { const j = fwd ? k : n - 1 - k; raw.push(p[j * 2], p[j * 2 + 1]); }
    edges.push(ei);
    onArt += elen[ei];
  }
  if (raw.length === 2) raw.push(macro.nodes[land].x, macro.nodes[land].z);
  const pts = resample(dedupe(raw), ROUTE.spacing);
  const s: number[] = [0];
  for (let i = 1; i < pts.length / 2; i++) s.push(s[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]));
  let landS = 0;
  for (let i = 0; i < s.length; i++) if (terrain.isWater(pts[i * 2], pts[i * 2 + 1], 1)) landS = s[i]; else if (s[i] > 0) break;
  const L = s[s.length - 1];
  return {
    start, pts, s, length: L, landS, edges, onArterials: onArt,
    end: { x: pts[pts.length - 2], z: pts[pts.length - 1] },
    river: best.river, riverS: best.s, bridge: best.bridge,
  };
}

/** Drop consecutive duplicate points (shared edge ends). */
function dedupe(p: number[]): number[] {
  const out: number[] = [p[0], p[1]];
  for (let i = 2; i < p.length; i += 2) if (Math.hypot(p[i] - out[out.length - 2], p[i + 1] - out[out.length - 1]) > 0.5) out.push(p[i], p[i + 1]);
  return out;
}

/** Point and unit direction at arc length `s` on a route (clamped). */
export function routeAt(r: { pts: number[]; s: number[] }, s: number, out: { x: number; z: number; dx: number; dz: number }): typeof out {
  const S = r.s, P = r.pts, n = S.length;
  if (s <= 0 || n < 2) { out.x = P[0]; out.z = P[1]; setDir(P, 0, out); return out; }
  if (s >= S[n - 1]) { out.x = P[(n - 1) * 2]; out.z = P[(n - 1) * 2 + 1]; setDir(P, n - 2, out); return out; }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
  const t = (s - S[lo]) / Math.max(1e-9, S[hi] - S[lo]);
  out.x = P[lo * 2] + (P[hi * 2] - P[lo * 2]) * t;
  out.z = P[lo * 2 + 1] + (P[hi * 2 + 1] - P[lo * 2 + 1]) * t;
  setDir(P, lo, out);
  return out;
}

function setDir(P: number[], i: number, out: { dx: number; dz: number }): void {
  const dx = P[i * 2 + 2] - P[i * 2], dz = P[i * 2 + 3] - P[i * 2 + 1], l = Math.hypot(dx, dz) || 1;
  out.dx = dx / l; out.dz = dz / l;
}
