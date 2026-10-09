/**
 * Navigation graph of the loaded city: arterial edges (split where local
 * streets join) plus each loaded cell's local streets. Rebuilt (debounced)
 * when cells load or unload. Provides A* routing and lane / sidewalk offsets.
 */
import type { MacroPlan } from '../plan/types';
import type { CellState } from '../stream/CityStreamer';
import { MinHeap } from '../core/heap';
import { distSqPointSeg } from '../core/geom2';

export interface RNode {
  x: number;
  z: number;
  edges: number[];
  /** Arterial junction with signals. */
  signal: boolean;
  /** Macro node id or -1. */
  macro: number;
}

export interface REdge {
  a: number;
  b: number;
  /** Polyline a → b. */
  pts: number[];
  len: number;
  width: number;
  sidewalk: number;
  lanes: number;
  cls: number;
  /** Cumulative arc length per vertex. */
  cum: number[];
}

const SNAP = 1.5;

export class RoadNet {
  nodes: RNode[] = [];
  edges: REdge[] = [];
  private grid = new Map<number, number[]>(); // edge spatial hash
  version = 0;
  /** Where the way is cut (a fallen bridge span): edges passing within `r` of a point are closed. */
  private cuts: { x: number; z: number; r: number }[] = [];
  private closedSet: Set<number> | null = null;
  private closedVer = -1;
  private dirty = true;
  private lastBuild = -10;

  constructor(private macro: MacroPlan) {}

  markDirty(): void { this.dirty = true; }

  /** Rebuild if dirty (at most every `minInterval` seconds). */
  maybeRebuild(t: number, cells: Iterable<CellState>, minInterval = 2): boolean {
    if (!this.dirty || t - this.lastBuild < minInterval) return false;
    this.dirty = false;
    this.lastBuild = t;
    this.build(cells);
    return true;
  }

  build(cells: Iterable<CellState>): void {
    const nodes: RNode[] = [];
    const edges: REdge[] = [];
    const nodeKey = new Map<string, number>();
    const node = (x: number, z: number, macro = -1, signal = false): number => {
      const k = `${Math.round(x / SNAP)},${Math.round(z / SNAP)}`;
      let id = nodeKey.get(k);
      if (id === undefined) {
        id = nodes.length;
        nodes.push({ x, z, edges: [], signal, macro });
        nodeKey.set(k, id);
      } else if (signal) nodes[id].signal = true;
      return id;
    };
    const addEdge = (a: number, b: number, pts: number[], width: number, sidewalk: number, lanes: number, cls: number) => {
      if (a === b || pts.length < 4) return;
      const cum = [0];
      for (let i = 2; i < pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
      const len = cum[cum.length - 1];
      if (len < 0.5) return;
      const id = edges.length;
      edges.push({ a, b, pts, len, width, sidewalk, lanes, cls, cum });
      nodes[a].edges.push(id);
      nodes[b].edges.push(id);
    };
    // Split points on arterial edges contributed by loaded cells (param along polyline).
    const arterialSplits = new Map<number, { s: number; x: number; z: number }[]>();
    const usedArterials = new Set<number>();
    const local: { pts: number[]; width: number; sidewalk: number; lanes: number; cls: number }[] = [];
    for (const cs of cells) {
      if (!cs.plan) continue;
      const cell = this.macro.cells[cs.id];
      for (const eid of cell.edges) usedArterials.add(eid);
      const streets = cs.plan.streets.filter((s) => s.arterial < 0);
      // Split local streets at T-junctions with other local streets.
      const pieces: number[][] = streets.map((s) => s.pts.slice());
      const splits: { i: number; x: number; z: number }[] = [];
      for (const s of streets) {
        for (const end of [0, s.pts.length - 2]) {
          const x = s.pts[end], z = s.pts[end + 1];
          streets.forEach((o, oi) => {
            if (o === s) return;
            for (let k = 0; k + 3 < o.pts.length; k += 2) {
              if (distSqPointSeg(x, z, o.pts[k], o.pts[k + 1], o.pts[k + 2], o.pts[k + 3]) < 1.0) {
                const nearEnd = Math.hypot(x - o.pts[0], z - o.pts[1]) < SNAP * 1.5 || Math.hypot(x - o.pts[o.pts.length - 2], z - o.pts[o.pts.length - 1]) < SNAP * 1.5;
                if (!nearEnd) splits.push({ i: oi, x, z });
              }
            }
          });
          // Attachment to an arterial bounding the cell.
          for (const eid of cell.edges) {
            const e = this.macro.edges[eid];
            let acc = 0;
            for (let k = 0; k + 3 < e.pts.length; k += 2) {
              const segL = Math.hypot(e.pts[k + 2] - e.pts[k], e.pts[k + 3] - e.pts[k + 1]);
              if (distSqPointSeg(x, z, e.pts[k], e.pts[k + 1], e.pts[k + 2], e.pts[k + 3]) < 2.5) {
                const t = ((x - e.pts[k]) * (e.pts[k + 2] - e.pts[k]) + (z - e.pts[k + 1]) * (e.pts[k + 3] - e.pts[k + 1])) / (segL * segL);
                let l = arterialSplits.get(eid);
                if (!l) arterialSplits.set(eid, (l = []));
                l.push({ s: acc + Math.max(0, Math.min(1, t)) * segL, x, z });
              }
              acc += segL;
            }
          }
        }
      }
      // Apply local splits.
      const byIdx = new Map<number, { x: number; z: number }[]>();
      for (const sp of splits) (byIdx.get(sp.i) ?? byIdx.set(sp.i, []).get(sp.i)!).push(sp);
      streets.forEach((s, i) => {
        const sp = byIdx.get(i);
        if (!sp) { local.push({ pts: pieces[i], width: s.width, sidewalk: s.sidewalk, lanes: s.lanes, cls: s.cls }); return; }
        for (const part of splitPolyline(pieces[i], sp)) local.push({ pts: part, width: s.width, sidewalk: s.sidewalk, lanes: s.lanes, cls: s.cls });
      });
    }
    // Arterials (only those bordering loaded cells), split at attachments.
    for (const eid of usedArterials) {
      const e = this.macro.edges[eid];
      const na = this.macro.nodes[e.a], nb = this.macro.nodes[e.b];
      const a = node(na.x, na.z, e.a, na.edges.length >= 3);
      const b = node(nb.x, nb.z, e.b, nb.edges.length >= 3);
      const sp = (arterialSplits.get(eid) ?? []).sort((p, q) => p.s - q.s);
      if (!sp.length) { addEdge(a, b, e.pts.slice(), e.width, e.sidewalk, e.lanes, e.cls); continue; }
      const parts = splitPolyline(e.pts.slice(), sp);
      for (const part of parts) {
        const n0 = node(part[0], part[1]);
        const n1 = node(part[part.length - 2], part[part.length - 1]);
        addEdge(n0, n1, part, e.width, e.sidewalk, e.lanes, e.cls);
      }
      void a; void b;
    }
    for (const l of local) {
      const n0 = node(l.pts[0], l.pts[1]);
      const n1 = node(l.pts[l.pts.length - 2], l.pts[l.pts.length - 1]);
      addEdge(n0, n1, l.pts, l.width, l.sidewalk, l.lanes, l.cls);
    }
    this.nodes = nodes;
    this.edges = edges;
    // Spatial hash of edges (32 m).
    this.grid.clear();
    edges.forEach((e, id) => {
      for (let k = 0; k + 3 < e.pts.length; k += 2) {
        const x0 = Math.min(e.pts[k], e.pts[k + 2]), x1 = Math.max(e.pts[k], e.pts[k + 2]);
        const z0 = Math.min(e.pts[k + 1], e.pts[k + 3]), z1 = Math.max(e.pts[k + 1], e.pts[k + 3]);
        for (let i = Math.floor(x0 / 32); i <= Math.floor(x1 / 32); i++) for (let j = Math.floor(z0 / 32); j <= Math.floor(z1 / 32); j++) {
          const key = (i + 32768) * 65536 + (j + 32768);
          let l = this.grid.get(key);
          if (!l) this.grid.set(key, (l = []));
          if (l[l.length - 1] !== id) l.push(id);
        }
      }
    });
    this.version++;
  }

  /** Set the cuts (a fallen bridge span's middle, half its length): routes go round them. */
  setCuts(cuts: { x: number; z: number; r: number }[]): void {
    this.cuts = cuts;
    this.closedSet = null;
  }

  /** Is an edge cut (nobody gets along it: a span of its bridge is down)? */
  closed(eid: number): boolean {
    if (!this.cuts.length) return false;
    if (!this.closedSet || this.closedVer !== this.version) {
      this.closedVer = this.version;
      this.closedSet = new Set();
      this.edges.forEach((e, id) => {
        for (let k = 0; k + 3 < e.pts.length; k += 2) {
          const ax = e.pts[k], az = e.pts[k + 1], dx = e.pts[k + 2] - ax, dz = e.pts[k + 3] - az, L2 = dx * dx + dz * dz || 1;
          if (this.cuts.some((c) => { const t = Math.max(0, Math.min(1, ((c.x - ax) * dx + (c.z - az) * dz) / L2)); return Math.hypot(ax + dx * t - c.x, az + dz * t - c.z) < c.r; })) { this.closedSet!.add(id); break; }
        }
      });
    }
    return this.closedSet.has(eid);
  }

  /** Nearest edge to a point: edge id, arc param s, distance, side (+1 right of a→b). */
  nearestEdge(x: number, z: number, maxR = 120): { e: number; s: number; d: number; side: number } | null {
    let best: { e: number; s: number; d: number; side: number } | null = null;
    for (let r = 32; r <= maxR; r *= 2) {
      const i0 = Math.floor((x - r) / 32), i1 = Math.floor((x + r) / 32), j0 = Math.floor((z - r) / 32), j1 = Math.floor((z + r) / 32);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const l = this.grid.get((i + 32768) * 65536 + (j + 32768));
        if (!l) continue;
        for (const id of l) {
          const e = this.edges[id];
          for (let k = 0; k + 3 < e.pts.length; k += 2) {
            const ax = e.pts[k], az = e.pts[k + 1], bx = e.pts[k + 2], bz = e.pts[k + 3];
            const dx = bx - ax, dz = bz - az;
            const l2 = dx * dx + dz * dz;
            let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
            t = Math.max(0, Math.min(1, t));
            const qx = ax + dx * t, qz = az + dz * t;
            const d = Math.hypot(x - qx, z - qz);
            if (!best || d < best.d) {
              const side = dx * (z - az) - dz * (x - ax) > 0 ? 1 : -1;
              best = { e: id, s: e.cum[k >> 1] + Math.sqrt(l2) * t, d, side };
            }
          }
        }
      }
      const b2 = best as { d: number } | null;
      if (b2 && b2.d < r) break;
    }
    return best;
  }

  /** The k nearest edges (one entry per edge, nearest first) within maxR. */
  nearestEdges(x: number, z: number, maxR: number, k: number): { e: number; s: number; d: number; side: number }[] {
    const best = new Map<number, { e: number; s: number; d: number; side: number }>();
    const i0 = Math.floor((x - maxR) / 32), i1 = Math.floor((x + maxR) / 32), j0 = Math.floor((z - maxR) / 32), j1 = Math.floor((z + maxR) / 32);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const l = this.grid.get((i + 32768) * 65536 + (j + 32768));
      if (!l) continue;
      for (const id of l) {
        const e = this.edges[id];
        for (let q = 0; q + 3 < e.pts.length; q += 2) {
          const ax = e.pts[q], az = e.pts[q + 1], bx = e.pts[q + 2], bz = e.pts[q + 3];
          const dx = bx - ax, dz = bz - az;
          const l2 = dx * dx + dz * dz;
          let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
          t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
          if (d > maxR) continue;
          const cur = best.get(id);
          if (!cur || d < cur.d) best.set(id, { e: id, s: e.cum[q >> 1] + Math.sqrt(l2) * t, d, side: dx * (z - az) - dz * (x - ax) > 0 ? 1 : -1 });
        }
      }
    }
    return [...best.values()].sort((a, b) => a.d - b.d).slice(0, k);
  }

  /** Point on an edge at arc length s, with lateral offset (positive = right of a→b). Writes into out. */
  pointAt(e: REdge, s: number, offset: number, out: { x: number; z: number; dx: number; dz: number }): void {
    s = Math.max(0, Math.min(e.len, s));
    let k = 0;
    while (k < e.cum.length - 2 && e.cum[k + 1] < s) k++;
    const seg = e.cum[k + 1] - e.cum[k] || 1;
    const t = (s - e.cum[k]) / seg;
    const ax = e.pts[k * 2], az = e.pts[k * 2 + 1], bx = e.pts[k * 2 + 2], bz = e.pts[k * 2 + 3];
    const dx = (bx - ax) / seg, dz = (bz - az) / seg;
    // Right normal of (dx, dz) in the x/z plane is (-dz, dx) when z points "down" on screen;
    // we define right as (−dz, dx) consistently for traffic sides.
    out.x = ax + (bx - ax) * t - dz * offset;
    out.z = az + (bz - az) * t + dx * offset;
    out.dx = dx;
    out.dz = dz;
  }

  /** A* between two nodes. Returns edge ids in travel order with direction flags, or null. */
  route(from: number, to: number, carMode = false, maxNodes = 20000): { edges: number[]; fwd: boolean[] } | null {
    if (from === to) return { edges: [], fwd: [] };
    const N = this.nodes.length;
    const g = new Float64Array(N).fill(Infinity);
    const via = new Int32Array(N).fill(-1);
    const heap = new MinHeap();
    const tx = this.nodes[to].x, tz = this.nodes[to].z;
    g[from] = 0;
    heap.push(0, from);
    let expanded = 0;
    while (heap.size && expanded++ < maxNodes) {
      const u = heap.pop();
      if (u === to) break;
      const gu = g[u];
      for (const eid of this.nodes[u].edges) {
        if (this.closed(eid)) continue;
        const e = this.edges[eid];
        const v = e.a === u ? e.b : e.a;
        // Cars prefer arterials; pedestrians prefer short local streets.
        const w = e.len * (carMode ? (e.cls <= 1 ? 0.7 : e.cls === 2 ? 1 : 1.6) : 1);
        const ng = gu + w;
        if (ng < g[v]) {
          g[v] = ng;
          via[v] = eid;
          heap.push(ng + Math.hypot(this.nodes[v].x - tx, this.nodes[v].z - tz) * (carMode ? 0.7 : 1), v);
        }
      }
    }
    if (!isFinite(g[to])) return null;
    const edges: number[] = [], fwd: boolean[] = [];
    let u = to;
    while (u !== from) {
      const eid = via[u];
      const e = this.edges[eid];
      const prev = e.a === u ? e.b : e.a;
      edges.push(eid);
      fwd.push(e.b === u);
      u = prev;
    }
    edges.reverse();
    fwd.reverse();
    return { edges, fwd };
  }

  /** Node nearest to an edge param (the end you would reach first). */
  edgeEndNear(eid: number, s: number): number {
    const e = this.edges[eid];
    return s < e.len / 2 ? e.a : e.b;
  }
}

/** Split a polyline at given points lying on it (sorted along the line). */
function splitPolyline(pts: number[], at: { x: number; z: number }[]): number[][] {
  // Param of each split point.
  const cum = [0];
  for (let i = 2; i < pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
  const params: number[] = [];
  for (const p of at) {
    let best = Infinity, bs = 0;
    for (let k = 0; k + 3 < pts.length; k += 2) {
      const ax = pts[k], az = pts[k + 1], bx = pts[k + 2], bz = pts[k + 3];
      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 0 ? ((p.x - ax) * dx + (p.z - az) * dz) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(ax + dx * t - p.x, az + dz * t - p.z);
      if (d < best) { best = d; bs = cum[k >> 1] + Math.sqrt(l2) * t; }
    }
    params.push(bs);
  }
  params.sort((a, b) => a - b);
  const L = cum[cum.length - 1];
  const cuts = params.filter((s, i) => s > 1 && s < L - 1 && (i === 0 || s - params[i - 1] > 1));
  const out: number[][] = [];
  let cur: number[] = [pts[0], pts[1]];
  let ci = 0;
  for (let k = 1; k < cum.length; k++) {
    while (ci < cuts.length && cuts[ci] <= cum[k]) {
      const s = cuts[ci];
      const t = (s - cum[k - 1]) / (cum[k] - cum[k - 1] || 1);
      const x = pts[k * 2 - 2] + (pts[k * 2] - pts[k * 2 - 2]) * t, z = pts[k * 2 - 1] + (pts[k * 2 + 1] - pts[k * 2 - 1]) * t;
      cur.push(x, z);
      out.push(cur);
      cur = [x, z];
      ci++;
    }
    cur.push(pts[k * 2], pts[k * 2 + 1]);
  }
  out.push(cur);
  return out.filter((p) => p.length >= 4);
}
