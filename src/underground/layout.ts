/**
 * Metro and sewer geometry as pure data (no rendering): track tubes, station halls,
 * sewer tubes and the analytic train timetable. Shared by the game (Underground) and
 * the headless audit (tools/metroaudit.ts).
 */
import type { MacroPlan, MetroLine } from '../plan/types';
import type { Terrain } from '../world/terrain';
import { makeTube, makeBox, tubeAt, boxAt, type Tube, type Box } from './Volumes';
import { STATION_HALF, ENTRANCE_L, ENTRANCE_W } from '../plan/metroDims';
import { sewerInvert } from '../plan/underground';

export const TUNNEL_HW = 4.3;
export const TUNNEL_H = 6.0;
export const STATION_HW = 11;
export const STATION_H = 7.5;
export const PLATFORM_H = 1.05;
export const SEWER_HW = 1.7;
export const SEWER_H = 2.8;
/** Tracks run at ±TRACK_OFF from the line's centreline. */
export const TRACK_OFF = 1.9;
export const CAR_L = 18.5;
export const CARS = 4;
export const CAR_W = 2.9;
export const CAR_H = 3.3;
/** Car floor over the track bed = platform height: one steps level from the platform into a car. */
export const CAR_FLOOR = PLATFORM_H;
/** Platform edge from the line's centreline: 5 cm from the side of a car on its track. */
export const PLATFORM_EDGE = TRACK_OFF + CAR_W / 2 + 0.05;
export const PLATFORM_W = STATION_HW - PLATFORM_EDGE;
/** Doors (car frame u of their centres, half width) and how long before departure they close (s). */
export const DOOR_U = [-5.5, 0, 5.5];
export const DOOR_HW = 0.65;
export const DOOR_CLOSE = 1.5;

/** Track tube of a metro line (floor = top of the track bed). */
export function metroTube(line: MetroLine): Tube {
  const pts: number[] = [];
  for (let i = 0, k = 0; i < line.pts.length; i += 2, k++) pts.push(line.pts[i], line.y[k], line.pts[i + 1]);
  return makeTube('metro', pts, TUNNEL_HW, TUNNEL_H);
}

/** Sewer trunk tube: invert ~4.6 m under the street, smoothed so it never climbs steeply. */
export function sewerTube(pts2: number[], terrain: Terrain): Tube {
  const inv = sewerInvert(pts2, terrain), pts: number[] = [];
  for (let i = 0; i < pts2.length; i += 2) pts.push(pts2[i], inv[i >> 1], pts2[i + 1]);
  return makeTube('sewer', pts, SEWER_HW, SEWER_H, 0.6, 0.45);
}

/** Station halls: one box per (station, line), floor = track level, side platforms. */
export function stationHalls(macro: MacroPlan): Box[] {
  const out: Box[] = [];
  for (const st of macro.metroStations) {
    st.halls.forEach((h, hi) => {
      const b = makeBox('station', h.x, h.z, h.y, h.y + STATION_H, h.angle, STATION_HALF, STATION_HW,
        [[-STATION_HW, -STATION_HW + PLATFORM_W, PLATFORM_H], [STATION_HW - PLATFORM_W, STATION_HW, PLATFORM_H]]);
      b.station = st.id;
      b.hall = hi;
      b.line = h.line;
      out.push(b);
    });
  }
  return out;
}

export interface TrainState { s: number; dir: number; dwell: boolean; /** seconds left in the dwell (0 if moving) */ left: number; /** station index (in line.stations) of the dwell or the next stop */ next: number }

export const TRAIN_V = 16;
export const DWELL = 22;

/**
 * Train state along a line (analytic: position = function of time). Trains shuttle between the
 * termini, dwelling DWELL s at every intermediate stop; at a terminus they dwell half on the
 * arrival track, then half on the departure track.
 */
export function trainsOn(line: MetroLine, t: number): TrainState[] {
  const v = TRAIN_V, dwell = DWELL;
  const S = line.stationS;
  if (S.length < 2) return [];
  const legs: { a: number; b: number; dur: number }[] = [];
  for (let i = 0; i + 1 < S.length; i++) legs.push({ a: S[i], b: S[i + 1], dur: Math.abs(S[i + 1] - S[i]) / v });
  const oneWay = legs.reduce((a, l) => a + l.dur, 0) + (S.length - 1) * dwell;
  const cycle = oneWay * 2;
  const n = Math.max(2, Math.round(Math.abs(S[S.length - 1] - S[0]) / 1400));
  const out: TrainState[] = [];
  for (let k = 0; k < n; k++) {
    let tt = ((t + (cycle * k) / n) % cycle + cycle) % cycle;
    let dir = 1;
    if (tt >= oneWay) { tt -= oneWay; dir = -1; }
    const L = dir > 0 ? legs : legs.slice().reverse().map((l) => ({ a: l.b, b: l.a, dur: l.dur }));
    const idxOf = (li: number) => (dir > 0 ? li : S.length - 1 - li);
    let st: TrainState | null = null;
    for (let li = 0; li < L.length; li++) {
      const leg = L[li], d0 = li === 0 ? dwell / 2 : dwell;
      if (tt < d0) { st = { s: leg.a, dir, dwell: true, left: d0 - tt, next: idxOf(li) }; break; }
      tt -= d0;
      if (tt < leg.dur) {
        const f = tt / leg.dur, e = f * f * (3 - 2 * f);
        st = { s: leg.a + (leg.b - leg.a) * e, dir, dwell: false, left: 0, next: idxOf(li + 1) };
        break;
      }
      tt -= leg.dur;
    }
    // Arrived at the far terminus: the first half of its dwell.
    if (!st) st = { s: L[L.length - 1].b, dir, dwell: true, left: Math.max(0, dwell / 2 - tt), next: idxOf(L.length) };
    out.push(st);
  }
  return out;
}

/** Arc-length position (s) of car c (0 = head) of a train at s, centred on s and kept on the track. */
export function carS(tube: Tube, s: number, dir: number, c: number): number {
  const total = tube.cum[tube.cum.length - 1], half = (CARS * CAR_L) / 2;
  const mid = Math.max(half, Math.min(total - half, s));
  return mid + dir * ((CARS - 1) / 2 - c) * CAR_L;
}

export function pointOnTube(t: Tube, s: number): { x: number; y: number; z: number; dx: number; dz: number } | null {
  const C = t.cum, P = t.pts;
  if (s < 0 || s > C[C.length - 1]) return null;
  let lo = 0, hi = C.length - 1;
  while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (C[m] <= s) lo = m; else hi = m; }
  const f = (s - C[lo]) / Math.max(1e-6, C[hi] - C[lo]);
  const ax = P[lo * 3], ay = P[lo * 3 + 1], az = P[lo * 3 + 2], bx = P[hi * 3], by = P[hi * 3 + 1], bz = P[hi * 3 + 2];
  const L = Math.hypot(bx - ax, bz - az) || 1;
  return { x: ax + (bx - ax) * f, y: ay + (by - ay) * f, z: az + (bz - az) * f, dx: (bx - ax) / L, dz: (bz - az) / L };
}

/**
 * World pose of car c of a train: centre (x, y = track-bed floor, z), heading (dx, dz),
 * on the track of its direction (right-hand side of the centreline).
 */
export function carPose(tube: Tube, tr: { s: number; dir: number }, c: number): { x: number; y: number; z: number; dx: number; dz: number } | null {
  const p = pointOnTube(tube, carS(tube, tr.s, tr.dir, c));
  if (!p) return null;
  const off = TRACK_OFF * tr.dir;
  return { x: p.x - p.dz * off, y: p.y, z: p.z + p.dx * off, dx: p.dx * tr.dir, dz: p.dz * tr.dir };
}

// ------------------------------------------------------------ entrances

/** Entrance passages: half width, clear height, stair gradient (rise/run), rise per flight, landing length. */
export const PASSAGE_HW = ENTRANCE_W / 2 + 0.2;
export const PASSAGE_H = 3.2;
/** Depth of a passage floor under the street surface (ceiling + slab). */
const COVER = PASSAGE_H + 0.2;
const STAIR_SLOPE = 0.55;
const FLIGHT_RISE = 3.6;
const LANDING = 1.6;

export interface EntranceRoute { pts: number[]; /** descent direction in the opening */ dx: number; dz: number; /** doorway in the hall's side wall (box frame u, side) */ door: { u: number; sv: number } }

/**
 * Walkable route from a street opening down to a side platform:
 *  1. a stair flight inside the opening (along its long axis) down to a corridor just under the street,
 *  2. the level corridor (above the station hall's roof) to a point beside the hall,
 *  3. stair flights with landings running alongside the hall, parallel to the tracks, towards its middle,
 *  4. a short level stub through a doorway in the hall's side wall onto the platform.
 * The legs never double back over one another, so the floor under any point is unambiguous.
 */
export function entranceRoute(b: Box, gx: number, gz: number, ux: number, uz: number, ground: (x: number, z: number) => number,
  env: RouteEnv = {}): EntranceRoute {
  // Candidates: flights on the entrance's side of the hall or the other, descending towards the
  // hall's middle or away from it, doorways in the nearest gaps; the first that cuts through
  // nothing else (sewers, other lines) wins; failing that, the flights move a little farther out.
  const lat0 = -(gx - b.cx) * b.uz + (gz - b.cz) * b.ux >= 0 ? 1 : -1;
  const u0 = (gx - b.cx) * b.ux + (gz - b.cz) * b.uz, sg0 = Math.sign(u0) || 1;
  let best: EntranceRoute | null = null, bestHits = Infinity;
  for (const away of [0, 4]) for (const lat of [lat0, -lat0]) for (const sg of [sg0, -sg0]) for (const shift of [0, -8, 8, -16, 16, -24, 24]) {
    const r = routeVariant(b, gx, gz, ux, uz, ground, env, lat, sg, shift, away);
    if (!r) continue;
    // Too steep a stair (the corridor had to dive right behind the opening) counts as blocked.
    let steep = 0;
    for (let i = 0; i + 5 < r.pts.length; i += 3) if (Math.abs(r.pts[i + 4] - r.pts[i + 1]) > 0.65 * Math.hypot(r.pts[i + 3] - r.pts[i], r.pts[i + 5] - r.pts[i + 2]) + 1e-6) steep++;
    const hits = (env.blocked ? routeHits(r.pts, env.blocked) : 0) + steep * 1000;
    if (hits < bestHits) { best = r; bestHits = hits; }
    if (hits === 0) return r;
  }
  return best!;
}

/** Surroundings an entrance route must respect. */
export interface RouteEnv {
  /** Highest corridor floor allowed at (x, z) (under sewers). */
  cap?: (x: number, z: number) => number;
  /** Does the walking space at (x, feet y, z) cut through another volume? */
  blocked?: (x: number, y: number, z: number) => boolean;
}

function routeHits(pts: number[], blocked: (x: number, y: number, z: number) => boolean): number {
  let hits = 0;
  for (let i = 0; i + 5 < pts.length; i += 3) {
    const L = Math.hypot(pts[i + 3] - pts[i], pts[i + 5] - pts[i + 2]), n = Math.max(1, Math.ceil(L));
    for (let k = 0; k < n; k++) {
      const f = k / n;
      if (blocked(pts[i] + (pts[i + 3] - pts[i]) * f, pts[i + 1] + (pts[i + 4] - pts[i + 1]) * f, pts[i + 2] + (pts[i + 5] - pts[i + 2]) * f)) hits++;
    }
  }
  return hits;
}

function routeVariant(b: Box, gx: number, gz: number, ux: number, uz: number, ground: (x: number, z: number) => number, env: RouteEnv,
  lat: number, sgTop: number, shift: number, away: number): EntranceRoute | null {
  const gy = ground(gx, gz), sy = b.y0 + PLATFORM_H;
  const toW = (u: number, v: number): [number, number] => [b.cx + b.ux * u - b.uz * v, b.cz + b.uz * u + b.ux * v];
  const uOf = (x: number, z: number) => (x - b.cx) * b.ux + (z - b.cz) * b.uz;
  // The flights run along the hall's side wall (outside it).
  const fv = lat * (b.hv + PASSAGE_HW + 0.2 + away);
  // Corridor level: the ceiling under the street from the end of the opening on, above the hall's roof if possible.
  const corridor = Math.max(gy - COVER, Math.min(gy - 2.4, b.y1 + 0.3));
  const flightLen = (drop: number) => drop / STAIR_SLOPE + (Math.max(1, Math.ceil(drop / FLIGHT_RISE)) - 1) * LANDING;
  // Bottom of the flights (the doorway): the top lies sgTop of it, level with u0 where possible.
  const bottom = (u0: number) => doorSlot(b.hu, u0 - sgTop * flightLen(corridor - sy) + shift, -sgTop);
  // Descend through the opening towards the doorway (an opening along the tracks then leads
  // straight on into the flights instead of the flights doubling back under it).
  const [wx0, wz0] = toW(bottom(uOf(gx, gz)), fv);
  const sgnU = (wx0 - gx) * ux + (wz0 - gz) * uz >= 0 ? 1 : -1;
  const dx = ux * sgnU, dz = uz * sgnU;
  const hl = ENTRANCE_L / 2;
  const pts: number[] = [gx - dx * hl, gy, gz - dz * hl, gx + dx * hl, corridor, gz + dz * hl];
  const add = (x: number, y: number, z: number) => {
    const n = pts.length;
    if (Math.hypot(x - pts[n - 3], z - pts[n - 1]) > 0.3) pts.push(x, y, z);
  };
  // A short level run out of the opening, so the corridor never turns under the stair; then the
  // corridor to the top of the flights, sinking (by stairs) wherever the street above is lower or
  // a sewer is in the way.
  const ox = gx + dx * (hl + 1.5), oz = gz + dz * (hl + 1.5);
  const wu = bottom(uOf(ox, oz));
  let u = wu + sgTop * flightLen(corridor - sy);
  const [qx, qz] = toW(u, fv);
  const cl = Math.hypot(qx - ox, qz - oz), ns = Math.max(1, Math.ceil(cl / 3)), step = cl / ns;
  const ys: number[] = [];
  for (let k = 0; k <= ns; k++) {
    const x = ox + ((qx - ox) * k) / ns, z = oz + ((qz - oz) * k) / ns;
    ys.push(Math.min(corridor, ground(x, z) - COVER, env.cap ? env.cap(x, z) : Infinity));
  }
  // The flights must pass under sewers too: start them low enough (they descend at least ~0.45).
  if (env.cap) {
    const fl = flightLen(corridor - sy);
    for (let d = 0; d <= fl; d += 1) {
      const [x, z] = toW(u - sgTop * d, fv);
      ys[ns] = Math.min(ys[ns], env.cap(x, z) + 0.45 * d);
    }
  }
  for (let k = 1; k <= ns; k++) ys[k] = Math.min(ys[k], ys[k - 1] + STAIR_SLOPE * step);
  for (let k = ns - 1; k >= 0; k--) ys[k] = Math.min(ys[k], ys[k + 1] + STAIR_SLOPE * step);
  for (let k = 0; k <= ns; k++) add(ox + ((qx - ox) * k) / ns, ys[k], oz + ((qz - oz) * k) / ns);
  const yq = ys[ns];
  if (yq <= sy) return null;
  // Flights with landings, then level to the doorway.
  const n = Math.max(1, Math.ceil((yq - sy) / FLIGHT_RISE)), rise = (yq - sy) / n;
  for (let k = 0; k < n; k++) {
    u -= sgTop * rise / STAIR_SLOPE;
    const [x, z] = toW(u, fv);
    pts.push(x, yq - rise * (k + 1), z);
    if (k + 1 < n) {
      u -= sgTop * LANDING;
      const [x2, z2] = toW(u, fv);
      pts.push(x2, yq - rise * (k + 1), z2);
    }
  }
  const [wx, wz] = toW(wu, fv);
  add(wx, sy, wz);
  // Through the doorway onto the middle of the platform.
  const [ex, ez] = toW(wu, lat * (b.hv - 0.05));
  pts.push(ex, sy, ez);
  const [tx, tz] = toW(wu, lat * (b.hv - 2.1));
  pts.push(tx, sy, tz);
  return { pts, dx, dz, door: { u: wu, sv: lat } };
}

/** Route surroundings from the city's volumes: under the sewers, clear of other tunnels and halls. */
export function routeEnv(tubes: Tube[], halls: Box[], own: Box): RouteEnv {
  const sewers = tubes.filter((t) => t.kind === 'sewer'), others = tubes.filter((t) => t.kind !== 'passage');
  return {
    cap: (x, z) => {
      let c = Infinity;
      for (const t of sewers) {
        if (x < t.bounds[0] - 2 || x > t.bounds[2] + 2 || z < t.bounds[1] - 2 || z > t.bounds[3] + 2) continue;
        const h = tubeAt(t, x, -1e9, z, PASSAGE_HW + 0.4, true);
        if (h) c = Math.min(c, h.floor - (t.channelDepth ?? 0) - 0.4 - PASSAGE_H);
      }
      return c;
    },
    blocked: (x, y, z) => {
      for (const t of others) {
        const h = tubeAt(t, x, y + 1.1, z, -0.3);
        if (h && Math.abs(h.floor - y) > 0.5) return true;
      }
      for (const hb of halls) if (hb !== own && boxAt(hb, x, y + 1.1, z, 0) && y + 1.1 > hb.y0) return true;
      return false;
    },
  };
}

/**
 * Doorway position (box frame u) on a station side wall nearest to u, preferably on the
 * `toward` side of it: in a gap between the columns and benches of buildStation, clear of the name signs.
 */
function doorSlot(hu: number, u: number, toward: number): number {
  let best = 0, bd = Infinity;
  for (let c = -hu + 9.65; c <= hu - 4; c += 8) {
    if ([-hu * 0.5, 0, hu * 0.5].some((s) => Math.abs(c - s) < 3.45)) continue;
    const d = Math.abs(c - u) + ((c - u) * toward < 0 ? 100 : 0);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

