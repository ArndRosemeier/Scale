/**
 * The Leviathan's way up the river (THREATS_PLAN §1 #2). Pure (plan and terrain only),
 * deterministic per seed, headless-testable.
 *
 *  - The river: of the city's own rivers, the one with the most bridges.
 *  - Entry: downstream of the first bridge, LEVI_ROUTE.lead m before it (it comes up the river from
 *    the sea or the lower course), never outside the city.
 *  - Stops: the bridges along the way (up to LEVI_ROUTE.bridges, nearest the entry first), each
 *    with the spot it holds in the channel just off the deck's downstream side, and a quay between
 *    two bridges that lie far apart (a bank junction near the river), where it sweeps the promenade.
 *  - Way: the river's centreline from the entry to the last stop (it goes back the same way).
 */
import type { MacroPlan } from '../../../plan/types';
import type { Terrain } from '../../../world/terrain';
import { boundaryAt } from '../../../world/boundary';
import { bridgeProfiles } from '../../../build/bridges';
import { Rng } from '../../../core/rng';

export interface LeviStop {
  kind: 'bridge' | 'quay';
  /** Arc length along the way (m) where it holds. */
  s: number;
  /** Where it holds in the channel, and what it goes for (the deck's middle, the quay). */
  x: number; z: number;
  tx: number; tz: number;
  /** The bridge's macro edge (bridges). */
  edge: number;
}

export interface LeviRoute {
  river: number;
  /** Polyline (x, z, …) along the centreline from the entry, arc lengths, total. */
  pts: number[];
  s: number[];
  length: number;
  start: { x: number; z: number };
  end: { x: number; z: number };
  stops: LeviStop[];
  /** Arc length on the river at the entry and the way it heads along it (+1 upstream in s, −1 down). */
  riverS0: number;
  dir: 1 | -1;
}

export const LEVI_ROUTE = {
  /** Most bridges it visits; a quay stop between two bridges this far apart (m), found within m. */
  bridges: 3, quayGap: 260, quayR: 130,
  /** It comes up this far (m) before its first stop, and visits stops within this much of it. */
  lead: 280, span: 1500,
  /** Kept in from the city's edge (share of the boundary radius); held off the deck (m). */
  edgeShare: 0.93, offDeck: 13,
  /** Least way to bother (m). */
  minLength: 220,
};

/** The Leviathan's way, or null (no river with a bridge in the city). */
export function planLeviathanRoute(macro: MacroPlan, terrain: Terrain, seed: number): LeviRoute | null {
  const L = LEVI_ROUTE, rng = new Rng(seed ^ 0x1e71);
  const profiles = bridgeProfiles(macro, terrain);
  // ---- bridges by river: where each deck's middle crosses which river
  const onRiver = new Map<number, { edge: number; s: number; x: number; z: number; dx: number; dz: number }[]>();
  for (const p of profiles) {
    const sm = (p.s0 + p.s1) / 2, x = p.ax + p.dx * sm, z = p.az + p.dz * sm;
    const w = terrain.water(x, z);
    if (w.river < 0 || w.river >= terrain.baseRivers || w.d > w.halfWidth + 4) continue;
    const list = onRiver.get(w.river) ?? [];
    list.push({ edge: p.edge, s: w.s, x, z, dx: p.dx, dz: p.dz });
    onRiver.set(w.river, list);
  }
  let river = -1, most = 0;
  for (const [r, list] of onRiver) if (list.length > most || (list.length === most && r < river)) { most = list.length; river = r; }
  if (river < 0) return null;
  const R = terrain.rivers[river], P = R.pts, n = P.length >> 1;
  // ---- its stretch inside the city
  let i0 = -1, i1 = -1;
  for (let i = 0; i < n; i++) {
    const x = P[i * 2], z = P[i * 2 + 1];
    if (Math.hypot(x, z) > boundaryAt(macro.boundary, x, z) * L.edgeShare) continue;
    if (i0 < 0) i0 = i;
    i1 = i;
  }
  if (i0 < 0 || R.s[i1] - R.s[i0] < L.minLength) return null;
  // Downstream: the lower end (rivers run downhill along s when level1 < level0).
  const dir: 1 | -1 = R.level1 <= R.level0 ? -1 : 1;
  const iStart = dir === -1 ? i1 : i0, sStart = R.s[iStart];
  const bridges = onRiver.get(river)!
    .filter((b) => b.s >= R.s[i0] && b.s <= R.s[i1])
    .map((b) => ({ ...b, d: (b.s - sStart) * dir }))
    .filter((b) => b.d > 40)
    .sort((a, b) => a.d - b.d);
  if (!bridges.length) return null;
  // (Comes up a little before the first, visits those within its span.)
  const d0 = Math.max(0, bridges[0].d - L.lead);
  const near = bridges.filter((b) => b.d - bridges[0].d < L.span).slice(0, L.bridges).map((b) => ({ ...b, d: b.d - d0 }));
  bridges.length = 0; bridges.push(...near);
  // ---- the way: the centreline from the entry to just short of the last bridge
  const lastD = bridges[bridges.length - 1].d - L.offDeck;
  const pts: number[] = [], s: number[] = [];
  const at = (d: number): { x: number; z: number } => {
    const rs = sStart + (d + d0) * dir;
    let k = 0;
    while (k + 1 < n - 1 && R.s[k + 1] < rs) k++;
    const t = Math.max(0, Math.min(1, (rs - R.s[k]) / Math.max(1e-6, R.s[k + 1] - R.s[k])));
    return { x: P[k * 2] + (P[k * 2 + 2] - P[k * 2]) * t, z: P[k * 2 + 1] + (P[k * 2 + 3] - P[k * 2 + 1]) * t };
  };
  for (let d = 0; ; d = Math.min(lastD, d + 10)) {
    const p = at(d);
    pts.push(p.x, p.z); s.push(d);
    if (d >= lastD) break;
  }
  // ---- stops: each bridge, a quay between bridges far apart
  const quays = macro.nodes.filter((q) => q.kind === 1);
  const stops: LeviStop[] = [];
  let prevD = 0;
  for (const b of bridges) {
    if (b.d - prevD > L.quayGap && quays.length) {
      const mid = at((prevD + b.d) / 2 + rng.range(-40, 40));
      let best: { x: number; z: number } | null = null, bd = L.quayR;
      for (const q of quays) { const d = Math.hypot(q.x - mid.x, q.z - mid.z); if (d < bd) { bd = d; best = q; } }
      if (best) {
        const w = terrain.water(best.x, best.z);
        const qd = Math.max(prevD + 30, Math.min(b.d - 40, (w.s - sStart) * dir - d0));
        const p = at(qd);
        stops.push({ kind: 'quay', s: qd, x: p.x, z: p.z, tx: best.x, tz: best.z, edge: -1 });
      }
    }
    const hd = b.d - L.offDeck, p = at(hd);
    stops.push({ kind: 'bridge', s: hd, x: p.x, z: p.z, tx: b.x, tz: b.z, edge: b.edge });
    prevD = b.d;
  }
  const length = s[s.length - 1];
  return {
    river, pts, s, length, start: { x: pts[0], z: pts[1] }, end: { x: pts[pts.length - 2], z: pts[pts.length - 1] },
    stops, riverS0: sStart + d0 * dir, dir,
  };
}
