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
import { chaikin, resample, closestOnPolyline, polylineLength } from '../core/geom2';
import { clamp } from '../core/math';
import type { Terrain } from '../world/terrain';
import type { MacroPlan, MetroLine, MetroStation } from './types';
import type { CityField } from './macro';
import { stationName } from './names';
import { STATION_HALF } from './metroDims';

const LINE_COLORS = [0xe23b2e, 0x1f6fd1, 0x1d9a4a, 0xf2b705, 0x8e44ad, 0xf07c1b, 0x00a6b4, 0x8b5a2b, 0xd6338a];

export function planUnderground(plan: MacroPlan, field: CityField, terrain: Terrain): void {
  planSewers(plan, terrain);
  if (field.profile.metro) planMetro(plan, field, terrain);
}

/**
 * One trunk under every arterial. Under a bridge the trunk becomes a culvert: it dips under the
 * river bed and comes up on the far bank, so the sewers of the whole city form one network.
 */
function planSewers(plan: MacroPlan, terrain: Terrain): void {
  for (const e of plan.edges) {
    const pts = e.pts.slice();
    const depth: number[] = [];
    for (let i = 0; i < pts.length; i += 2) depth.push(4.5);
    plan.sewers.push({ pts, depth, width: e.cls === 0 ? 3.2 : 2.4, a: e.a, b: e.b, culvert: e.bridge || undefined });
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
    const track = smoothTrack(resample(chaikin(raw, 3), 10));
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
        st = { id: stations.length, x: q.px, z: q.pz, angle, depth: 0, lines: [], name: stationName(p.seed, stations.length), halls: [] };
        stations.push(st);
      }
      if (!st.lines.includes(lines.length)) st.lines.push(lines.length);
      if (lineStations[lineStations.length - 1] !== st.id) lineStations.push(st.id);
      lastS = acc;
    }
    if (lineStations.length < 2) continue;
    const stationS = lineStations.map((sid) => closestOnPolyline(track, stations[sid].x, stations[sid].z).s);
    lines.push({ id: lines.length, color: LINE_COLORS[lines.length % LINE_COLORS.length], name: String(lines.length + 1), stations: lineStations, pts: track, stationS, depth: [], y: [] });
  }
  for (const L of lines) alignStations(L, stations);
  for (const L of lines) profileLine(L, lines, stations, plan, terrain);
  plan.metroLines = lines;
  plan.metroStations = stations;
}

// ------------------------------------------------------------ metro geometry

/** Track/hall sizes (m), as the volumes in src/underground/layout.ts. */
const TUNNEL_H = 6.0, TUNNEL_HW = 4.3, HALL_H = 7.5, HALL_HW = 11;
/** Soil cover over tunnel and hall roofs (also keeps them under the sewers). */
const COVER = 6;
/** Steepest track gradient. */
const MAX_GRADE = 0.035;
/** Half length of the straight, level stretch through a station (hall + run-in). */
export const HALL_SPAN = STATION_HALF + 6;

/** Sewer invert (floor of the walkways) along a trunk: ~4.6 m under the street, smoothed. */
export function sewerInvert(pts: number[], terrain: Terrain, culvert = false): number[] {
  const y: number[] = [];
  for (let i = 0; i < pts.length; i += 2) y.push(terrain.height(pts[i], pts[i + 1]) - 4.6);
  if (culvert) {
    // Under the river: 4.6 m under the bed at least, sloping no steeper than CULVERT_GRADE from the
    // banks (a lower envelope), so it can be walked down into and up out of.
    const cum = [0];
    for (let i = 2; i < pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
    // Densely sampled bed (the deck's polyline points can be far apart over the water).
    const bed = y.slice();
    for (let i = 0; i + 1 < y.length; i++) {
      const L = cum[i + 1] - cum[i];
      for (let s = 2; s < L; s += 2) {
        const f = s / L, x = pts[i * 2] + (pts[i * 2 + 2] - pts[i * 2]) * f, z = pts[i * 2 + 1] + (pts[i * 2 + 3] - pts[i * 2 + 1]) * f;
        const v = terrain.height(x, z) - 4.6;
        bed[i] = Math.min(bed[i], v + CULVERT_GRADE * s);
        bed[i + 1] = Math.min(bed[i + 1], v + CULVERT_GRADE * (L - s));
      }
    }
    const e = bed.slice();
    for (let i = 1; i < e.length; i++) e[i] = Math.min(e[i], e[i - 1] + CULVERT_GRADE * (cum[i] - cum[i - 1]));
    for (let i = e.length - 2; i >= 0; i--) e[i] = Math.min(e[i], e[i + 1] + CULVERT_GRADE * (cum[i + 1] - cum[i]));
    y.splice(0, y.length, ...e);
  } else {
    for (let it = 0; it < 4; it++) for (let i = 1; i + 1 < y.length; i++) y[i] = (y[i - 1] + y[i] * 2 + y[i + 1]) / 4;
  }
  // The smoothing lifts the invert where the street runs through a dip, and the street can dip
  // between the points: keep SEWER_COVER of soil over the vault everywhere along the trunk (and
  // across its width) by lowering the floor there, then ease the dents (downwards only).
  const n = y.length;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (let i = 0; i + 1 < n; i++) {
      const ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[i * 2 + 2], bz = pts[i * 2 + 3];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-6) continue;
      const nx = -(bz - az) / L, nz = (bx - ax) / L;
      for (let s = 0; s <= L; s += Math.min(2, L)) {
        const f = s / L, x = ax + (bx - ax) * f, z = az + (bz - az) * f;
        let g = Infinity;
        for (const o of [-SEWER_SPAN, 0, SEWER_SPAN]) g = Math.min(g, terrain.height(x + nx * o, z + nz * o));
        const e = y[i] + (y[i + 1] - y[i]) * f - (g - SEWER_DEPTH_MIN);
        if (e <= 1e-3) continue;
        // Interior points drop together; a trunk's ends stay where the crossing trunks meet them
        // (right at a node the street is level with the node, so the far point takes the drop).
        const a0 = i > 0, b0 = i + 1 < n - 1;
        if (a0 && b0) { y[i] -= e; y[i + 1] -= e; }
        else if (b0) y[i + 1] -= e / Math.max(f, 0.25);
        else if (a0) y[i] -= e / Math.max(1 - f, 0.25);
        else continue;
        moved = true;
      }
    }
    if (!moved) break;
    for (let it = 0; it < 2; it++) for (let i = 1; i + 1 < n; i++) y[i] = Math.min(y[i], (y[i - 1] + y[i] * 2 + y[i + 1]) / 4);
  }
  return y;
}

/** Deepest the street may come to a sewer's floor (vault 2.8 m + 1 m of soil), and the half width checked. */
const SEWER_DEPTH_MIN = 3.8, SEWER_SPAN = 1.7;

/** Steepest slope of a culvert's floor (walkable). */
export const CULVERT_GRADE = 0.3;

/** Laplacian smoothing (ends fixed) towards metro curve radii, then even 10 m spacing. */
function smoothTrack(pts: number[]): number[] {
  let p = pts;
  for (let it = 0; it < 500; it++) {
    const q = p.slice();
    for (let i = 2; i + 2 < p.length; i += 2) {
      q[i] = (p[i - 2] + p[i] * 2 + p[i + 2]) / 4;
      q[i + 1] = (p[i - 1] + p[i + 1] * 2 + p[i + 3]) / 4;
    }
    p = q;
  }
  return resample(p, 10);
}

/** Point at arc length s on a 2D polyline (clamped to its ends). */
function pointAt(pts: number[], s: number): [number, number] {
  let acc = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const L = Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
    if (acc + L >= s || i + 4 >= pts.length) {
      const f = L > 0 ? Math.max(0, Math.min(1, (s - acc) / L)) : 0;
      return [pts[i] + (pts[i + 2] - pts[i]) * f, pts[i + 1] + (pts[i + 3] - pts[i + 1]) * f];
    }
    acc += L;
  }
  return [pts[0], pts[1]];
}

/**
 * Straight track through every station: tail tracks beyond the termini, and the track replaced
 * by the chord over each stop's span, so the hall (a straight box) contains its track exactly.
 * Sets the line's stop positions and the stations' halls.
 */
function alignStations(L: MetroLine, stations: MetroStation[]): void {
  let pts = L.pts;
  // Tail tracks so the termini's halls (and the trains standing in them) lie on the track.
  const ext = HALL_SPAN + 20;
  const n = pts.length >> 1;
  const sx = pts[0] - pts[2], sz = pts[1] - pts[3], sl = Math.hypot(sx, sz) || 1;
  const ex = pts[n * 2 - 2] - pts[n * 2 - 4], ez = pts[n * 2 - 1] - pts[n * 2 - 3], el = Math.hypot(ex, ez) || 1;
  pts = resample([pts[0] + (sx / sl) * ext, pts[1] + (sz / sl) * ext, ...pts, pts[n * 2 - 2] + (ex / el) * ext, pts[n * 2 - 1] + (ez / el) * ext], 10);
  // Stop targets: the first line's hall is at the station; other lines stop where they pass it.
  const targets = L.stations.map((sid) => [stations[sid].x, stations[sid].z]);
  let prevEnd: [number, number] | null = null;
  L.stations.forEach((sid, k) => {
    const st = stations[sid];
    if (st.halls.some((h) => h.line === L.id)) return;
    // Slide the stop (up to 150 m) to where the track is straightest, so the curves at the
    // ends of the straight stretch stay gentle.
    const s0 = closestOnPolyline(pts, targets[k][0], targets[k][1]).s, total = polylineLength(pts);
    let s = s0, bestDev = Infinity;
    for (let d = -150; d <= 150; d += 10) {
      const sc = s0 + d;
      if (sc - HALL_SPAN < 0 || sc + HALL_SPAN > total) continue;
      const [ax, az] = pointAt(pts, sc - HALL_SPAN), [bx, bz] = pointAt(pts, sc + HALL_SPAN), cl = Math.hypot(bx - ax, bz - az) || 1;
      let dev = 0;
      for (let q = -HALL_SPAN; q <= HALL_SPAN; q += 10) {
        const [x, z] = pointAt(pts, sc + q);
        dev = Math.max(dev, Math.abs(((x - ax) * (bz - az) - (z - az) * (bx - ax)) / cl));
      }
      dev += Math.abs(d) * 0.01;
      if (dev < bestDev) { bestDev = dev; s = sc; }
    }
    const [ax, az] = pointAt(pts, s - HALL_SPAN), [bx, bz] = pointAt(pts, s + HALL_SPAN);
    // Chord vertices: its ends, the hall's end walls and ~10 m steps between (so no track segment
    // straddles a hall wall).
    const m = Math.round((2 * STATION_HALF) / 10), fr = [0];
    for (let j = 0; j <= m; j++) fr.push((HALL_SPAN - STATION_HALF + (2 * STATION_HALF * j) / m) / (2 * HALL_SPAN));
    fr.push(1);
    const out: number[] = [];
    let acc = 0, chord = false;
    const pushChord = () => { for (const f of fr) out.push(ax + (bx - ax) * f, az + (bz - az) * f); chord = true; };
    for (let i = 0; i < pts.length; i += 2) {
      if (i > 0) acc += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
      if (acc < s - HALL_SPAN - 0.5) out.push(pts[i], pts[i + 1]);
      else if (acc <= s + HALL_SPAN + 0.5) { if (!chord) pushChord(); }
      else { if (!chord) pushChord(); out.push(pts[i], pts[i + 1]); }
    }
    if (!chord) pushChord();
    // Ease the track into and out of the straight (tangent-continuous transition curves).
    const ux = (bx - ax) / (2 * HALL_SPAN), uz = (bz - az) / (2 * HALL_SPAN);
    pts = easeFrom(out, bx, bz, ux, uz);
    // (Backwards only as far as the previous station's straight.)
    const back = prevEnd ? closestOnPolyline(pts, ax, az).s - closestOnPolyline(pts, prevEnd[0], prevEnd[1]).s - 5 : Infinity;
    pts = reversePolyline(easeFrom(reversePolyline(pts), ax, az, -ux, -uz, back));
    prevEnd = [bx, bz];
    const angle = Math.atan2(bz - az, bx - ax);
    const hall = { line: L.id, x: (ax + bx) / 2, z: (az + bz) / 2, angle, y: 0 };
    if (!st.halls.length) { st.x = hall.x; st.z = hall.z; st.angle = angle; }
    st.halls.push(hall);
  });
  L.pts = pts;
  L.stationS = L.stations.map((sid) => {
    const h = stations[sid].halls.find((q) => q.line === L.id)!;
    return closestOnPolyline(pts, h.x, h.z).s;
  });
}

/** Length of the transition curve from a station's straight back into the route. */
const EASE = 160;

function reversePolyline(p: number[]): number[] {
  const out: number[] = [];
  for (let i = p.length - 2; i >= 0; i -= 2) out.push(p[i], p[i + 1]);
  return out;
}

/**
 * Replace the EASE metres of track after (x0, z0) (where the track leaves a straight in
 * direction (dx, dz)) by a cubic Hermite curve that starts along the straight and ends along
 * the track: no kink where the straight ends.
 */
function easeFrom(pts: number[], x0: number, z0: number, dx: number, dz: number, maxD = Infinity): number[] {
  const s0 = closestOnPolyline(pts, x0, z0).s, total = polylineLength(pts);
  const D = Math.min(EASE, maxD, total - s0 - 1);
  if (D < 10) return pts;
  const [x1, z1] = pointAt(pts, s0 + D), [xa, za] = pointAt(pts, s0 + D - 2), [xb, zb] = pointAt(pts, Math.min(total, s0 + D + 2));
  const tl = Math.hypot(xb - xa, zb - za) || 1, tx = (xb - xa) / tl, tz = (zb - za) / tl;
  const out: number[] = [];
  let acc = 0, done = false;
  for (let i = 0; i < pts.length; i += 2) {
    if (i > 0) acc += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    if (acc <= s0 + 0.01) { out.push(pts[i], pts[i + 1]); continue; }
    if (!done) {
      const n = Math.max(2, Math.round(D / 10));
      for (let k = 1; k <= n; k++) {
        const t = k / n, t2 = t * t, t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
        out.push(h00 * x0 + h10 * D * dx + h01 * x1 + h11 * D * tx, h00 * z0 + h10 * D * dz + h01 * z1 + h11 * D * tz);
      }
      done = true;
    }
    if (acc > s0 + D + 0.01) out.push(pts[i], pts[i + 1]);
  }
  return out;
}

/**
 * Vertical alignment: the highest track (least digging) that keeps COVER of soil over the
 * tunnel/hall roofs, passes under the sewers and under every earlier line with a slab between,
 * stays level through the halls and never exceeds MAX_GRADE (upper gradient envelope).
 */
function profileLine(L: MetroLine, lines: MetroLine[], stations: MetroStation[], plan: MacroPlan, terrain: Terrain): void {
  const P = L.pts, n = P.length >> 1;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(P[i * 2] - P[i * 2 - 2], P[i * 2 + 1] - P[i * 2 - 1]));
  const hallOf = new Int32Array(n).fill(-1);
  L.stationS.forEach((s, k) => { for (let i = 0; i < n; i++) if (Math.abs(cum[i] - s) <= HALL_SPAN + 0.5) hallOf[i] = k; });
  const inv = plan.sewers.map((sw) => sewerInvert(sw.pts, terrain, sw.culvert));
  const ymax = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = P[i * 2], z = P[i * 2 + 1];
    const inHall = hallOf[i] >= 0, hw = inHall ? HALL_HW : TUNNEL_HW, h = inHall ? HALL_H : TUNNEL_H;
    // Cover over the roof across its whole width.
    const j = Math.min(n - 1, i + 1), k0 = Math.max(0, i - 1);
    const tx = P[j * 2] - P[k0 * 2], tz = P[j * 2 + 1] - P[k0 * 2 + 1], tl = Math.hypot(tx, tz) || 1;
    let ground = Infinity;
    for (const o of [-hw, 0, hw]) ground = Math.min(ground, terrain.height(x - (tz / tl) * o, z + (tx / tl) * o));
    let y = ground - COVER - h;
    // Under the sewers (their channel is 0.45 below the invert).
    plan.sewers.forEach((sw, si) => {
      const q = nearestOn(sw.pts, x, z, hw + 3);
      if (q.d > hw + 1.7 + 1) return;
      const I = inv[si], iv = I[q.seg] + (I[Math.min(I.length - 1, q.seg + 1)] - I[q.seg]) * q.f;
      y = Math.min(y, iv - 0.45 - 1.0 - h);
    });
    // Under every earlier line (tunnel or hall), with a 1.5 m slab between.
    for (const M of lines) {
      if (M.id >= L.id) break;
      const q = nearestOn(M.pts, x, z, hw + HALL_HW + 2);
      if (q.d > hw + HALL_HW + 2) continue;
      const mhw = hallNear(M, stations, q.px, q.pz) ? HALL_HW : TUNNEL_HW;
      if (q.d > hw + mhw + 2) continue;
      const my = M.y[q.seg] + (M.y[Math.min(M.y.length - 1, q.seg + 1)] - M.y[q.seg]) * q.f;
      y = Math.min(y, my - 1.5 - h);
    }
    ymax[i] = y;
  }
  const envelope = (cap: Float64Array) => {
    const e = Float64Array.from(cap);
    for (let i = 1; i < n; i++) e[i] = Math.min(e[i], e[i - 1] + MAX_GRADE * (cum[i] - cum[i - 1]));
    for (let i = n - 2; i >= 0; i--) e[i] = Math.min(e[i], e[i + 1] + MAX_GRADE * (cum[i + 1] - cum[i]));
    return e;
  };
  // Level halls at the lowest envelope point of their span, then the final envelope.
  // (A neighbouring hall pinned lower can pull a level down again: repeat until all are level.)
  let e = envelope(ymax);
  const hallY = L.stationS.map(() => Infinity);
  for (let it = 0; it < 20; it++) {
    for (let i = 0; i < n; i++) if (hallOf[i] >= 0) hallY[hallOf[i]] = Math.min(hallY[hallOf[i]], e[i]);
    let level = true;
    for (let i = 0; i < n; i++) if (hallOf[i] >= 0) { if (e[i] > hallY[hallOf[i]] + 1e-6) level = false; ymax[i] = hallY[hallOf[i]]; }
    if (level && it > 0) break;
    e = envelope(ymax);
  }
  L.y = Array.from(e);
  L.depth = L.y.map((v, i) => terrain.height(P[i * 2], P[i * 2 + 1]) - v);
  L.stations.forEach((sid, k) => {
    const st = stations[sid], h = st.halls.find((q) => q.line === L.id)!;
    h.y = hallY[k];
    if (st.halls[0] === h) st.depth = terrain.height(st.x, st.z) - h.y;
  });
}

/** Is (x, z) on line M's centreline inside one of its halls? */
function hallNear(M: MetroLine, stations: MetroStation[], x: number, z: number): boolean {
  for (const sid of M.stations) for (const h of stations[sid].halls) {
    if (h.line !== M.id) continue;
    const dx = x - h.x, dz = z - h.z, ux = Math.cos(h.angle), uz = Math.sin(h.angle);
    if (Math.abs(dx * ux + dz * uz) <= HALL_SPAN && Math.abs(-dx * uz + dz * ux) < 1) return true;
  }
  return false;
}

/** Nearest point on a 2D polyline (segments farther than `reach` are skipped by bounding box). */
function nearestOn(pts: number[], x: number, z: number, reach: number): { d: number; seg: number; f: number; px: number; pz: number } {
  let bd = Infinity, bs = 0, bf = 0, bx = 0, bz = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i], az = pts[i + 1], cx = pts[i + 2], cz = pts[i + 3];
    if (x < Math.min(ax, cx) - reach || x > Math.max(ax, cx) + reach || z < Math.min(az, cz) - reach || z > Math.max(az, cz) + reach) continue;
    const dx = cx - ax, dz = cz - az, l2 = dx * dx + dz * dz;
    let f = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    f = Math.max(0, Math.min(1, f));
    const px = ax + dx * f, pz = az + dz * f, d = Math.hypot(x - px, z - pz);
    if (d < bd) { bd = d; bs = i >> 1; bf = f; bx = px; bz = pz; }
  }
  return { d: bd, seg: bs, f: bf, px: bx, pz: bz };
}
