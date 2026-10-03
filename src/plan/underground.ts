/**
 * Metro lines and sewer trunks.
 *
 * Metro lines are routed on the arterial graph (cut-and-cover follows the
 * avenues) favouring dense areas, then smoothed into a track alignment.
 * Stations sit at arterial junctions; lines sharing a junction share the
 * station (transfers). Sewer trunks run under every arterial with junction
 * chambers at nodes and outfalls at the river banks.
 */
import { Rng, deriveSeed } from '../core/rng';
import { MinHeap } from '../core/heap';
import { chaikin, resample, closestOnPolyline } from '../core/geom2';
import { clamp } from '../core/math';
import type { Terrain } from '../world/terrain';
import type { MacroPlan, MetroLine, MetroStation } from './types';
import type { CityField } from './macro';
import { stationName } from './names';

const LINE_COLORS = [0xe23b2e, 0x1f6fd1, 0x1d9a4a, 0xf2b705, 0x8e44ad, 0xf07c1b, 0x00a6b4, 0x8b5a2b, 0xd6338a];

export function planUnderground(plan: MacroPlan, field: CityField, terrain: Terrain): void {
  planSewers(plan, terrain);
  if (field.profile.metro) planMetro(plan, field, terrain);
}

function planSewers(plan: MacroPlan, terrain: Terrain): void {
  for (const e of plan.edges) {
    if (e.bridge) continue;
    const pts = e.pts.slice();
    const depth: number[] = [];
    for (let i = 0; i < pts.length; i += 2) depth.push(4.5);
    plan.sewers.push({ pts, depth, width: e.cls === 0 ? 3.2 : 2.4 });
  }
  void terrain;
}

function planMetro(plan: MacroPlan, field: CityField, terrain: Terrain): void {
  const p = field.profile;
  const rng = new Rng(deriveSeed(p.seed, 'metro'));
  const nodes = plan.nodes, edges = plan.edges;
  if (nodes.length < 6) return;
  const nLines = clamp(Math.round(Math.pow(p.size, 1.5) * 9), 1, 9);
  const dens = nodes.map((n) => field.density(n.x, n.z));
  const len = edges.map((e) => Math.hypot(nodes[e.a].x - nodes[e.b].x, nodes[e.a].z - nodes[e.b].z));
  const usedEdge = new Float64Array(edges.length);

  const route = (src: number, dst: number): number[] | null => {
    const dist = new Float64Array(nodes.length).fill(Infinity);
    const via = new Int32Array(nodes.length).fill(-1);
    const heap = new MinHeap();
    dist[src] = 0;
    heap.push(0, src);
    while (heap.size) {
      const u = heap.pop();
      const d = heap.lastPriority;
      if (d > dist[u]) continue;
      if (u === dst) break;
      for (const eid of nodes[u].edges) {
        const e = edges[eid];
        const v = e.a === u ? e.b : e.a;
        // Prefer dense corridors; avoid reusing other lines' corridors.
        const w = len[eid] * (1.6 - dens[v]) * (1 + usedEdge[eid] * 0.8);
        const nd = d + w;
        if (nd < dist[v]) { dist[v] = nd; via[v] = eid; heap.push(nd, v); }
      }
    }
    if (!isFinite(dist[dst])) return null;
    const out: number[] = [dst];
    let u = dst, guard = 0;
    while (u !== src && guard++ < 100000) {
      const e = edges[via[u]];
      usedEdge[e.id]++;
      u = e.a === u ? e.b : e.a;
      out.push(u);
    }
    return out.reverse();
  };

  // Line termini: pairs of far-apart nodes in opposite sectors, passing near centres.
  const R = p.radius;
  const stations: MetroStation[] = [];
  const lines: MetroLine[] = [];
  const stationAt = (x: number, z: number): MetroStation | undefined =>
    stations.find((s) => Math.hypot(s.x - x, s.z - z) < 160);
  for (let li = 0; li < nLines; li++) {
    const a0 = (li / nLines) * Math.PI + rng.range(-0.25, 0.25);
    const pickEnd = (ang: number) => {
      let bi = -1, bs = -Infinity;
      nodes.forEach((n, i) => {
        const d = Math.hypot(n.x, n.z);
        const da = Math.abs(((Math.atan2(n.z, n.x) - ang + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        const s = Math.min(d, R * 0.85) / R - da * 1.4 + dens[i] * 0.2;
        if (s > bs) { bs = s; bi = i; }
      });
      return bi;
    };
    const a = pickEnd(a0), b = pickEnd(a0 + Math.PI + rng.range(-0.3, 0.3));
    if (a < 0 || b < 0 || a === b) continue;
    // Pass via a centre for structure.
    const c = plan.centres[li % plan.centres.length];
    let ci = 0, cd = Infinity;
    nodes.forEach((n, i) => { const d = Math.hypot(n.x - c.x, n.z - c.z); if (d < cd) { cd = d; ci = i; } });
    const r1 = route(a, ci), r2 = route(ci, b);
    if (!r1 || !r2) continue;
    const path = r1.concat(r2.slice(1));
    // Remove loops (repeated nodes).
    const seen = new Map<number, number>();
    const clean: number[] = [];
    for (const n of path) {
      if (seen.has(n)) { const k = seen.get(n)!; for (const r of clean.splice(k + 1)) seen.delete(r); continue; }
      seen.set(n, clean.length);
      clean.push(n);
    }
    if (clean.length < 3) continue;
    // Station selection along the path by spacing.
    const raw: number[] = [];
    for (const n of clean) raw.push(nodes[n].x, nodes[n].z);
    const track = resample(chaikin(raw, 3), 10);
    const lineStations: number[] = [];
    let lastS = -1e9;
    let acc = 0;
    for (let k = 0; k < clean.length; k++) {
      const n = nodes[clean[k]];
      if (k > 0) acc += Math.hypot(n.x - nodes[clean[k - 1]].x, n.z - nodes[clean[k - 1]].z);
      const spacing = 650 + (1 - dens[clean[k]]) * 700;
      const isEnd = k === 0 || k === clean.length - 1;
      if (!isEnd && acc - lastS < spacing) continue;
      if (terrain.isWater(n.x, n.z, 40)) continue;
      // Snap to track.
      const q = closestOnPolyline(track, n.x, n.z);
      let st = stationAt(q.px, q.pz);
      if (!st) {
        const i2 = Math.min(track.length - 2, q.seg * 2 + 2);
        const angle = Math.atan2(track[i2 + 1] - track[q.seg * 2 + 1], track[i2] - track[q.seg * 2]);
        st = { id: stations.length, x: q.px, z: q.pz, angle, depth: 0, lines: [], name: stationName(p.seed, stations.length) };
        stations.push(st);
      }
      if (!st.lines.includes(lines.length)) st.lines.push(lines.length);
      if (lineStations[lineStations.length - 1] !== st.id) lineStations.push(st.id);
      lastS = acc;
    }
    if (lineStations.length < 2) continue;
    // Depth along the track: deeper under water and for later lines (avoid crossings at equal depth).
    const depth: number[] = [];
    const baseDepth = 12 + (li % 3) * 7;
    for (let i = 0; i < track.length; i += 2) {
      const w = terrain.water(track[i], track[i + 1]);
      let d = baseDepth;
      if (w.river >= 0 && w.d < w.halfWidth + 60) {
        const ground = terrain.height(track[i], track[i + 1]);
        const bed = w.level - (2.5 + w.halfWidth * 0.06) - 10;
        d = Math.max(d, ground - bed);
      }
      depth.push(d);
    }
    // Smooth depth (tunnels have limited gradient).
    for (let it = 0; it < 30; it++) for (let i = 1; i < depth.length - 1; i++) depth[i] = Math.max(depth[i], (depth[i - 1] + depth[i + 1]) / 2 - 0.4);
    const stationS = lineStations.map((sid) => closestOnPolyline(track, stations[sid].x, stations[sid].z).s);
    lines.push({ id: lines.length, color: LINE_COLORS[lines.length % LINE_COLORS.length], name: String(lines.length + 1), stations: lineStations, pts: track, stationS, depth });
  }
  // Station depth = max line depth at that station.
  for (const st of stations) {
    for (const li of st.lines) {
      const L = lines[li];
      const q = closestOnPolyline(L.pts, st.x, st.z);
      st.depth = Math.max(st.depth, L.depth[Math.min(L.depth.length - 1, q.seg)]);
    }
  }
  plan.metroLines = lines;
  plan.metroStations = stations;
}
