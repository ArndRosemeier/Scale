/**
 * Water polygons: river channels (as buffered chunks) and the sea. Used to
 * clip cells, build quays and water surfaces.
 */
import { strokePolylines, union, type Shape } from '../core/clip';
import type { Terrain } from '../world/terrain';
import type { Poly } from '../core/geom2';
import { polyBounds } from '../core/geom2';

export interface WaterChunk {
  /** River index, or -1 for the sea. */
  river: number;
  shapes: Shape[];
  bounds: [number, number, number, number];
}

const CHUNK = 240; // m of river per chunk

/**
 * River chunks: each chunk is the channel buffer (half width + margin) over a
 * stretch of the centerline. Chunks overlap slightly so their union is closed.
 */
export function riverChunks(terrain: Terrain, margin: number): WaterChunk[] {
  const out: WaterChunk[] = [];
  terrain.rivers.forEach((R, ri) => {
    const pts = R.pts;
    const n = pts.length >> 1;
    let i = 0;
    while (i < n - 1) {
      let j = i;
      while (j < n - 1 && R.s[j] - R.s[i] < CHUNK) j++;
      const line: number[] = [];
      for (let k = Math.max(0, i - 1); k <= Math.min(n - 1, j + 1); k++) line.push(pts[k * 2], pts[k * 2 + 1]);
      // Variable width: split into short sub-strokes with their own width.
      const subs: Poly[] = [];
      for (let k = 0; k + 3 < line.length; k += 6) {
        const seg = line.slice(k, Math.min(line.length, k + 10));
        const sMid = R.s[Math.min(n - 1, Math.max(0, i - 1) + (k >> 1) + 1)];
        const hw = terrain.riverHalfWidthAt(ri, sMid) + margin;
        for (const sh of strokePolylines([seg], hw, 'round', 'round')) subs.push(sh.outer);
      }
      const shapes = union(subs);
      const b = shapes.length ? polyBounds(shapes.flatMap((s) => s.outer)) : [0, 0, 0, 0] as [number, number, number, number];
      out.push({ river: ri, shapes, bounds: b });
      i = j;
    }
  });
  return out;
}

/**
 * Sea polygon by tracing the coastline (c = margin) along the coast tangent,
 * closed far out to sea. Islands/bays deeper than the trace are approximated.
 */
export function seaPolygon(terrain: Terrain, margin: number, step = 30): Poly | null {
  const p = terrain.profile;
  if (!p.coastal) return null;
  const perp: [number, number] = [-p.seaDir[1], p.seaDir[0]];
  const ext = terrain.extent * 1.2;
  const coast: number[] = [];
  for (let t = -ext; t <= ext; t += step) {
    const ox = perp[0] * t, oz = perp[1] * t;
    let lo = -ext * 2, hi = ext * 2;
    for (let k = 0; k < 44; k++) {
      const m = (lo + hi) / 2;
      const c = terrain.coastDistance(ox + p.seaDir[0] * m, oz + p.seaDir[1] * m);
      if (c > margin) lo = m; else hi = m;
    }
    coast.push(ox + p.seaDir[0] * lo, oz + p.seaDir[1] * lo);
  }
  // Close the polygon far out to sea.
  const far = ext * 3;
  const last = coast.length - 2;
  coast.push(coast[last] + p.seaDir[0] * far, coast[last + 1] + p.seaDir[1] * far);
  coast.push(coast[0] + p.seaDir[0] * far, coast[1] + p.seaDir[1] * far);
  return coast;
}
