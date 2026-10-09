/**
 * The space a filler works in: one room's floor outline (any polygon, world x/z) with what each
 * stretch of its boundary is (a facade with windows, a blind party wall, an inner wall, or open
 * to the next space), where the doors are, and the floor that must stay free (stairs, a lift
 * landing, the way in from the street). Callers describe their space with this; the filler
 * (fill/place) knows nothing else about the building.
 */
import { pointInPoly, distSqPointSeg, polyArea, type Poly } from '../../core/geom2';

/** What stands along an edge of the room. */
export type EdgeKind = 'window' | 'blind' | 'inner' | 'open';

export interface Edge {
  ax: number; az: number; bx: number; bz: number;
  /** Length, unit direction a → b, inward normal (into the room). */
  len: number; ux: number; uz: number; nx: number; nz: number;
  kind: EdgeKind;
  /** Door openings along the edge: [s0, s1] in metres from a. */
  doors: [number, number][];
}

export interface Area {
  poly: Poly;
  edges: Edge[];
  /** Floor nothing may stand on (convex polygons). */
  keepOut: Poly[];
}

/** A wall segment with door openings as parameters 0..1 along it (InteriorGen IWall shape). */
export interface WallSeg { ax: number; az: number; bx: number; bz: number; doors: [number, number][] }

/**
 * An Area from a room outline. `walls`: the storey's interior walls (an edge lying on one is an
 * inner wall, with that wall's doors); `outline`: the storey's outer outline (an edge on it is the
 * facade: `facade(ax, az, bx, bz)` says whether that stretch has windows); anything else is open.
 */
export function roomArea(poly: Poly, walls: WallSeg[], outline: Poly, facade: (ax: number, az: number, bx: number, bz: number) => EdgeKind, keepOut: Poly[] = []): Area {
  const ccw = polyArea(poly) > 0;
  const n = poly.length >> 1, edges: Edge[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[i * 2], az = poly[i * 2 + 1], bx = poly[j * 2], bz = poly[j * 2 + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.05) continue;
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    // Inward normal: left of a → b for a counter-clockwise outline (x right, z down in plan).
    let nx = -uz, nz = ux;
    if (!ccw) { nx = -nx; nz = -nz; }
    const mx = (ax + bx) / 2 + nx * 0.05, mz = (az + bz) / 2 + nz * 0.05;
    if (!pointInPoly(poly, mx, mz)) { nx = -nx; nz = -nz; }
    const e: Edge = { ax, az, bx, bz, len, ux, uz, nx, nz, kind: 'open', doors: [] };
    // The walls lying along this edge (within 12 cm of its line, overlapping it).
    let covered = 0;
    for (const w of walls) {
      const wl = Math.hypot(w.bx - w.ax, w.bz - w.az);
      if (wl < 0.05) continue;
      const da = Math.abs((w.ax - ax) * nx + (w.az - az) * nz), db = Math.abs((w.bx - ax) * nx + (w.bz - az) * nz);
      if (da > 0.12 || db > 0.12) continue;
      const sa = (w.ax - ax) * ux + (w.az - az) * uz, sb = (w.bx - ax) * ux + (w.bz - az) * uz;
      const lo = Math.max(0, Math.min(sa, sb)), hi = Math.min(len, Math.max(sa, sb));
      if (hi - lo < 0.1) continue;
      covered += hi - lo;
      for (const [t0, t1] of w.doors) {
        const s0 = sa + (sb - sa) * t0, s1 = sa + (sb - sa) * t1;
        const d0 = Math.max(0, Math.min(s0, s1)), d1 = Math.min(len, Math.max(s0, s1));
        if (d1 - d0 > 0.05) e.doors.push([d0, d1]);
      }
    }
    if (covered > len * 0.5) e.kind = 'inner';
    else if (onOutline(outline, ax, az, bx, bz)) e.kind = facade(ax, az, bx, bz);
    // Too short to walk through: a corner of wall, not an opening.
    else if (len < 0.7) e.kind = 'inner';
    // A wall that covers only part of the edge leaves the rest open: treat the gap as a doorway.
    if (e.kind === 'inner' && covered < len - 0.3) e.doors.push(...gaps(e, walls));
    e.doors.sort((p, q) => p[0] - q[0]);
    edges.push(e);
  }
  return { poly, edges, keepOut };
}

/** Is the segment on the outline (both ends and the middle within 15 cm of its edges)? */
function onOutline(outline: Poly, ax: number, az: number, bx: number, bz: number): boolean {
  const near = (x: number, z: number) => {
    const n = outline.length >> 1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (distSqPointSeg(x, z, outline[i * 2], outline[i * 2 + 1], outline[j * 2], outline[j * 2 + 1]) < 0.0225) return true;
    }
    return false;
  };
  return near(ax, az) && near(bx, bz) && near((ax + bx) / 2, (az + bz) / 2);
}

/** Stretches of an edge no wall covers (as door spans). */
function gaps(e: Edge, walls: WallSeg[]): [number, number][] {
  const cov: [number, number][] = [];
  for (const w of walls) {
    const da = Math.abs((w.ax - e.ax) * e.nx + (w.az - e.az) * e.nz), db = Math.abs((w.bx - e.ax) * e.nx + (w.bz - e.az) * e.nz);
    if (da > 0.12 || db > 0.12) continue;
    const sa = (w.ax - e.ax) * e.ux + (w.az - e.az) * e.uz, sb = (w.bx - e.ax) * e.ux + (w.bz - e.az) * e.uz;
    cov.push([Math.min(sa, sb), Math.max(sa, sb)]);
  }
  cov.sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  let s = 0;
  for (const [a, b] of cov) {
    if (a - s > 0.5) out.push([s, Math.min(a, e.len)]);
    s = Math.max(s, b);
  }
  if (e.len - s > 0.5) out.push([s, e.len]);
  return out;
}
