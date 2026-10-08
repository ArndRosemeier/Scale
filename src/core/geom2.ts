/**
 * 2D geometry on the ground plane (x, z). Polygons are flat arrays
 * [x0, z0, x1, z1, ...] without a repeated closing vertex. Counter-clockwise
 * (positive signed area in an x-right / z-up frame) is the canonical winding.
 */

export type Poly = number[];
export type P2 = [number, number];

export function polyArea(p: Poly): number {
  let a = 0;
  const n = p.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) a += p[j * 2] * p[i * 2 + 1] - p[i * 2] * p[j * 2 + 1];
  return a * 0.5;
}

export function ensureCCW(p: Poly): Poly {
  return polyArea(p) < 0 ? reversePoly(p) : p;
}

export function reversePoly(p: Poly): Poly {
  const out: Poly = [];
  for (let i = (p.length >> 1) - 1; i >= 0; i--) out.push(p[i * 2], p[i * 2 + 1]);
  return out;
}

export function polyCentroid(p: Poly): P2 {
  let a = 0, cx = 0, cz = 0;
  const n = p.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const f = p[j * 2] * p[i * 2 + 1] - p[i * 2] * p[j * 2 + 1];
    a += f;
    cx += (p[j * 2] + p[i * 2]) * f;
    cz += (p[j * 2 + 1] + p[i * 2 + 1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sz = 0;
    for (let i = 0; i < n; i++) { sx += p[i * 2]; sz += p[i * 2 + 1]; }
    return [sx / n, sz / n];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function polyBounds(p: Poly): [number, number, number, number] {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] < x0) x0 = p[i];
    if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < z0) z0 = p[i + 1];
    if (p[i + 1] > z1) z1 = p[i + 1];
  }
  return [x0, z0, x1, z1];
}

export function pointInPoly(p: Poly, x: number, z: number): boolean {
  let inside = false;
  const n = p.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2], zi = p[i * 2 + 1], xj = p[j * 2], zj = p[j * 2 + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function polyPerimeter(p: Poly): number {
  let s = 0;
  const n = p.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) s += Math.hypot(p[i * 2] - p[j * 2], p[i * 2 + 1] - p[j * 2 + 1]);
  return s;
}

/** Distance from point to segment, squared. */
export function distSqPointSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px, qz = az + dz * t - pz;
  return qx * qx + qz * qz;
}

export function distPointPolyEdge(p: Poly, x: number, z: number): number {
  let best = Infinity;
  const n = p.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const d = distSqPointSeg(x, z, p[j * 2], p[j * 2 + 1], p[i * 2], p[i * 2 + 1]);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Segment intersection; returns t along AB and u along CD or null. */
export function segIntersect(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): [number, number] | null {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = cx - ax, qz = cz - az;
  const t = (qx * sz - qz * sx) / den;
  const u = (qx * rz - qz * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [t, u];
}

/**
 * Split a simple polygon by the infinite line through (ox,oz) with direction
 * (dx,dz). Returns the pieces (each CCW) and the chords (segments of the line
 * inside the polygon) as [x0,z0,x1,z1].
 */
export function splitPolyByLine(p: Poly, ox: number, oz: number, dx: number, dz: number): { pieces: Poly[]; chords: number[][] } {
  const n = p.length >> 1;
  const nx = -dz, nz = dx; // left normal
  const side = new Float64Array(n);
  for (let i = 0; i < n; i++) side[i] = (p[i * 2] - ox) * nx + (p[i * 2 + 1] - oz) * nz;
  // Nudge vertices lying exactly on the line.
  for (let i = 0; i < n; i++) if (Math.abs(side[i]) < 1e-7) side[i] = 1e-7;

  type V = { x: number; z: number; cross: boolean; t: number; idx: number; partner?: V; next?: V; visited?: boolean };
  const ring: V[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    ring.push({ x: p[i * 2], z: p[i * 2 + 1], cross: false, t: 0, idx: ring.length });
    if ((side[i] > 0) !== (side[j] > 0)) {
      const f = side[i] / (side[i] - side[j]);
      const x = p[i * 2] + (p[j * 2] - p[i * 2]) * f;
      const z = p[i * 2 + 1] + (p[j * 2 + 1] - p[i * 2 + 1]) * f;
      ring.push({ x, z, cross: true, t: (x - ox) * dx + (z - oz) * dz, idx: ring.length });
    }
  }
  const crosses = ring.filter((v) => v.cross);
  if (crosses.length < 2) return { pieces: [ensureCCW(p.slice())], chords: [] };
  crosses.sort((a, b) => a.t - b.t);
  const chords: number[][] = [];
  for (let k = 0; k + 1 < crosses.length; k += 2) {
    crosses[k].partner = crosses[k + 1];
    crosses[k + 1].partner = crosses[k];
    chords.push([crosses[k].x, crosses[k].z, crosses[k + 1].x, crosses[k + 1].z]);
  }
  for (let i = 0; i < ring.length; i++) ring[i].next = ring[(i + 1) % ring.length];
  const pieces: Poly[] = [];
  for (const start of ring) {
    if (start.visited || start.cross) continue;
    const out: Poly = [];
    let v: V = start;
    let guard = 0;
    do {
      if (!v.cross) v.visited = true;
      out.push(v.x, v.z);
      if (v.cross && v.partner) {
        const w: V = v.partner;
        out.push(w.x, w.z);
        v = w.next!;
      } else v = v.next!;
    } while (v !== start && guard++ < ring.length * 2);
    if (out.length >= 6 && Math.abs(polyArea(out)) > 1e-6) pieces.push(ensureCCW(cleanPoly(out)));
  }
  return { pieces, chords };
}

/** Remove duplicate and collinear vertices. */
export function cleanPoly(p: Poly, eps = 1e-4): Poly {
  let pts: number[] = [];
  const n = p.length >> 1;
  for (let i = 0; i < n; i++) {
    const x = p[i * 2], z = p[i * 2 + 1];
    const m = pts.length;
    if (m >= 2 && Math.abs(pts[m - 2] - x) < eps && Math.abs(pts[m - 1] - z) < eps) continue;
    pts.push(x, z);
  }
  if (pts.length >= 4 && Math.abs(pts[0] - pts[pts.length - 2]) < eps && Math.abs(pts[1] - pts[pts.length - 1]) < eps) pts.length -= 2;
  let changed = true;
  while (changed && pts.length >= 8) {
    changed = false;
    const m = pts.length >> 1;
    for (let i = 0; i < m; i++) {
      const a = (i + m - 1) % m, c = (i + 1) % m;
      const ax = pts[a * 2], az = pts[a * 2 + 1], bx = pts[i * 2], bz = pts[i * 2 + 1], cx = pts[c * 2], cz = pts[c * 2 + 1];
      const cr = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
      const len = Math.hypot(cx - ax, cz - az);
      if (Math.abs(cr) < eps * Math.max(1, len)) {
        pts = pts.slice(0, i * 2).concat(pts.slice(i * 2 + 2));
        changed = true;
        break;
      }
    }
  }
  return pts;
}

/** Minimum-area oriented bounding box (rotating edges). */
export interface OBB { cx: number; cz: number; ux: number; uz: number; hu: number; hv: number; angle: number }
export function minAreaRect(p: Poly): OBB {
  const n = p.length >> 1;
  let best: OBB = { cx: 0, cz: 0, ux: 1, uz: 0, hu: 0, hv: 0, angle: 0 };
  let bestArea = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    let ux = p[j * 2] - p[i * 2], uz = p[j * 2 + 1] - p[i * 2 + 1];
    const l = Math.hypot(ux, uz);
    if (l < 1e-6) continue;
    ux /= l; uz /= l;
    const vx = -uz, vz = ux;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const x = p[k * 2], z = p[k * 2 + 1];
      const u = x * ux + z * uz, v = x * vx + z * vz;
      if (u < u0) u0 = u; if (u > u1) u1 = u;
      if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < bestArea) {
      bestArea = area;
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
      best = { cx: cu * ux + cv * vx, cz: cu * uz + cv * vz, ux, uz, hu: (u1 - u0) / 2, hv: (v1 - v0) / 2, angle: Math.atan2(uz, ux) };
    }
  }
  return best;
}

/** Rectangularity = area / OBB area (1 for a rectangle). */
export function rectangularity(p: Poly): number {
  const o = minAreaRect(p);
  return Math.abs(polyArea(p)) / Math.max(1e-6, 4 * o.hu * o.hv);
}

/** Smooth a polyline with Chaikin corner cutting (open ends preserved). */
export function chaikin(pts: number[], iterations: number): number[] {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    const out: number[] = [cur[0], cur[1]];
    const n = cur.length >> 1;
    for (let i = 0; i < n - 1; i++) {
      const ax = cur[i * 2], az = cur[i * 2 + 1], bx = cur[i * 2 + 2], bz = cur[i * 2 + 3];
      out.push(0.75 * ax + 0.25 * bx, 0.75 * az + 0.25 * bz, 0.25 * ax + 0.75 * bx, 0.25 * az + 0.75 * bz);
    }
    out.push(cur[cur.length - 2], cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}

/** Length of an open polyline. `stride` 3 reads (x, z, extra) triples, like the agents' routes. */
export function polylineLength(pts: ArrayLike<number>, stride = 2): number {
  let s = 0;
  for (let i = stride; i < pts.length; i += stride) s += Math.hypot(pts[i] - pts[i - stride], pts[i + 1] - pts[i - stride + 1]);
  return s;
}

/** Resample polyline to roughly uniform spacing. */
export function resample(pts: number[], spacing: number): number[] {
  const L = polylineLength(pts);
  const count = Math.max(1, Math.round(L / spacing));
  const out: number[] = [];
  let seg = 0, segStart = 0;
  let segLen = Math.hypot(pts[2] - pts[0], pts[3] - pts[1]);
  for (let k = 0; k <= count; k++) {
    const d = (k / count) * L;
    while (seg < (pts.length >> 1) - 2 && segStart + segLen < d) {
      segStart += segLen;
      seg++;
      segLen = Math.hypot(pts[seg * 2 + 2] - pts[seg * 2], pts[seg * 2 + 3] - pts[seg * 2 + 1]);
    }
    const t = segLen > 0 ? Math.min(1, (d - segStart) / segLen) : 0;
    out.push(pts[seg * 2] + (pts[seg * 2 + 2] - pts[seg * 2]) * t, pts[seg * 2 + 1] + (pts[seg * 2 + 3] - pts[seg * 2 + 1]) * t);
  }
  return out;
}

/** Closest point on polyline: returns distance, arc-length param, segment index. */
export function closestOnPolyline(pts: number[], x: number, z: number): { d: number; s: number; seg: number; px: number; pz: number } {
  let best = Infinity, bs = 0, bseg = 0, bpx = 0, bpz = 0;
  let acc = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const L = Math.sqrt(l2);
    let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + dx * t, pz = az + dz * t;
    const d = (px - x) * (px - x) + (pz - z) * (pz - z);
    if (d < best) { best = d; bs = acc + L * t; bseg = i >> 1; bpx = px; bpz = pz; }
    acc += L;
  }
  return { d: Math.sqrt(best), s: bs, seg: bseg, px: bpx, pz: bpz };
}

/** Douglas-Peucker simplification of a closed polygon. */
export function simplifyClosed(p: Poly, tol: number): Poly {
  const n = p.length >> 1;
  if (n <= 4) return p.slice();
  // Split at the two most distant vertices.
  let a = 0, b = 0, best = -1;
  for (let i = 0; i < n; i++) {
    const d = (p[i * 2] - p[0]) ** 2 + (p[i * 2 + 1] - p[1]) ** 2;
    if (d > best) { best = d; b = i; }
  }
  best = -1;
  for (let i = 0; i < n; i++) {
    const d = (p[i * 2] - p[b * 2]) ** 2 + (p[i * 2 + 1] - p[b * 2 + 1]) ** 2;
    if (d > best) { best = d; a = i; }
  }
  const keep = new Uint8Array(n);
  keep[a] = keep[b] = 1;
  const tol2 = tol * tol;
  const rec = (i: number, j: number) => {
    // vertices strictly between i and j going forward (mod n)
    let maxD = -1, idx = -1;
    for (let k = (i + 1) % n; k !== j; k = (k + 1) % n) {
      const d = distSqPointSeg(p[k * 2], p[k * 2 + 1], p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1]);
      if (d > maxD) { maxD = d; idx = k; }
    }
    if (idx >= 0 && maxD > tol2) {
      keep[idx] = 1;
      rec(i, idx);
      rec(idx, j);
    }
  };
  rec(a, b);
  rec(b, a);
  const out: Poly = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
  return out;
}
