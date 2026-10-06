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
/**
 * Manholes: a lid in the street every MANHOLE_EVERY m along a sewer trunk, over a square shaft on
 * one side of the trunk that opens into the vault above the walkway. Across the trunk the shaft
 * spans [SHAFT_IN, SEWER_HW] (SHAFT_IN is a vertex of the vault's profile, so the opening follows
 * its faces), along it ±SHAFT_HS. Its top is a round neck (HOLE_R, COLLAR deep) under the round lid.
 * A ladder runs up from the walkway to the street, off the outer wall so that it fits the neck.
 */
export const MANHOLE_EVERY = 45;
export const SHAFT_IN = Math.cos((3 / 8) * Math.PI) * SEWER_HW;
export const SHAFT_HS = 0.45;
/** Lid (and shaft) centre across the trunk. */
export const LID_LAT = (SHAFT_IN + SEWER_HW) / 2;
/** The round hole in the street (radius) and the depth of the round neck under it. */
export const HOLE_R = 0.36;
export const COLLAR = 0.4;
/** Rungs across the trunk (off the wall, inside the neck), the rails' half spacing, the rung spacing. */
export const LADDER_LAT = LID_LAT + 0.2;
export const LADDER_HW = 0.2;
export const RUNG = 0.3;

/** A manhole: lid centre on the street, the trunk's direction there, the shaft's side across it. */
export interface ManholeSpot {
  tube: Tube;
  /** Arc length along the trunk. */
  s: number;
  x: number; z: number;
  /** Unit direction of the trunk; side: +1 / −1, the shaft's side as a profile lateral (lateral vector (−dz, dx)). */
  dx: number; dz: number; side: number;
  /** Walkway floor under the shaft. */
  floor: number;
}

/** World point of a manhole's frame: `lat` across the trunk on the shaft's side, `ds` along it, `y` over the walkway. */
export function shaftPoint(m: ManholeSpot, lat: number, ds: number, y: number): [number, number, number] {
  const l = lat * m.side;
  return [m.x + m.dz * LID_LAT * m.side - m.dz * l + m.dx * ds, m.floor + y, m.z - m.dx * LID_LAT * m.side + m.dx * l + m.dz * ds];
}

/** The vault's profile vertices over the shaft, outer wall top to SHAFT_IN: [lat, height over the walkway]. */
export const SHAFT_VAULT: [number, number][] = [0, 1, 2, 3].map((k) => [Math.cos((k / 8) * Math.PI) * SEWER_HW, 1.6 + Math.sin((k / 8) * Math.PI) * (SEWER_H - 1.6)]);

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
export function sewerTube(pts2: number[], terrain: Terrain, culvert = false): Tube {
  const inv = sewerInvert(pts2, terrain, culvert), pts: number[] = [];
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

/**
 * The next train at a stop for one direction (platform side), from the same timetable as
 * trainsOn: seconds until it pulls in (0 while one dwells there) and, while dwelling, the
 * seconds until it leaves. Used by the platform departure boards.
 */
export function nextTrainAt(line: MetroLine, stop: number, dir: number, t: number): { wait: number; dwelling: boolean; left: number } | null {
  const v = TRAIN_V, dwell = DWELL;
  const S = line.stationS;
  if (S.length < 2 || stop < 0 || stop >= S.length) return null;
  const legs: number[] = [];
  for (let i = 0; i + 1 < S.length; i++) legs.push(Math.abs(S[i + 1] - S[i]) / v);
  const oneWay = legs.reduce((a, l) => a + l, 0) + (S.length - 1) * dwell;
  const cycle = oneWay * 2;
  const n = Math.max(2, Math.round(Math.abs(S[S.length - 1] - S[0]) / 1400));
  // Position of the stop in this direction's run, and when (in the cycle) trains start dwelling there.
  const L = dir > 0 ? legs : legs.slice().reverse();
  const idx = dir > 0 ? stop : S.length - 1 - stop;
  let T = dir > 0 ? 0 : oneWay;
  for (let li = 0; li < idx; li++) T += (li === 0 ? dwell / 2 : dwell) + L[li];
  const here = idx === 0 || idx === S.length - 1 ? dwell / 2 : dwell;
  let best: { wait: number; dwelling: boolean; left: number } | null = null;
  for (let k = 0; k < n; k++) {
    const tt = ((t + (cycle * k) / n) % cycle + cycle) % cycle;
    const since = ((tt - T) % cycle + cycle) % cycle;
    if (since < here) return { wait: 0, dwelling: true, left: here - since };
    const wait = cycle - since;
    if (!best || wait < best.wait) best = { wait, dwelling: false, left: 0 };
  }
  return best;
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

/** Bench seats in a car (car-local u along, v across): the bench rows along both walls, between the doorways. */
export const TRAIN_SEATS: [number, number][] = (() => {
  const out: [number, number][] = [];
  let a = -8.1;
  for (const d of [...DOOR_U, Infinity]) {
    const b = Math.min(8.1, d - DOOR_HW);
    const n = Math.floor((b - a) / 0.6);
    for (let i = 0; i < n; i++) for (const v of [-1.12, 1.12]) out.push([a + (b - a) * (i + 0.5) / n, v]);
    a = Math.max(a, d + DOOR_HW);
  }
  return out;
})();

/** Heading of someone on a car seat at car-local v: facing across the aisle. */
export function seatYaw(c: { dx: number; dz: number }, v: number): number {
  // World direction of -v·sign(v) is (dz, -dx)·sign(v); headings face (-sin h, -cos h).
  const s = Math.sign(v) || 1;
  return Math.atan2(-c.dz * s, c.dx * s);
}

/** Seats on a hall's platform benches (box frame u, v): two per bench, facing the tracks (see buildStation). */
export function platformSeats(b: { hu: number; hv: number }): [number, number][] {
  const out: [number, number][] = [];
  for (let u = -b.hu + 8; u < b.hu - 6; u += 8) for (const sv of [-1, 1]) for (const du of [-0.5, 0.5]) out.push([u + 4 + du, sv * (b.hv - 0.6)]);
  return out;
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
/** Level landing where a passage turns (a slope running into a turn leaves a ledge across the corner). */
const CORNER = PASSAGE_HW + 0.3;

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
    const hits = (env.blocked ? routeHits(r.pts, env.blocked) : 0) + ownHallHits(b, r.pts) + selfHits(r.pts, PASSAGE_HW) + steep * 1000;
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

/**
 * Samples (one a metre) where an entrance passage runs through its own hall above the platform:
 * a corridor pushed down (under a sewer) while still over the hall would cut through its roof.
 * Only the stub through the doorway, at platform level, belongs inside.
 */
export function ownHallHits(b: Box, pts: number[]): number {
  const sy = b.y0 + PLATFORM_H;
  let hits = 0;
  for (let i = 0; i + 5 < pts.length; i += 3) {
    const L = Math.hypot(pts[i + 3] - pts[i], pts[i + 5] - pts[i + 2]), n = Math.max(1, Math.ceil(L));
    for (let k = 0; k < n; k++) {
      const f = k / n, x = pts[i] + (pts[i + 3] - pts[i]) * f, y = pts[i + 1] + (pts[i + 4] - pts[i + 1]) * f, z = pts[i + 2] + (pts[i + 5] - pts[i + 2]) * f;
      const dx = x - b.cx, dz = z - b.cz, u = dx * b.ux + dz * b.uz, v = -dx * b.uz + dz * b.ux;
      if (Math.abs(u) < b.hu + PASSAGE_HW && Math.abs(v) < b.hv + PASSAGE_HW - 0.1 && y > sy + 0.3 && y < b.y1 + 0.2) hits++;
    }
  }
  return hits;
}

/**
 * Samples (one a metre, along the middle and both sides) where a passage runs into itself: another
 * of its legs overlapping in plan at a different floor height, closer than a passage's clear height
 * (a corridor turned back under its own stair), or a step across a corner (a slope running into a turn).
 */
export function selfHits(pts: number[], hw: number): number {
  const n = pts.length / 3;
  let hits = 0;
  for (let i = 0; i + 1 < n; i++) {
    const ax = pts[i * 3], ay = pts[i * 3 + 1], az = pts[i * 3 + 2], bx = pts[i * 3 + 3], by = pts[i * 3 + 4], bz = pts[i * 3 + 5];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-3) continue;
    const nx = -(bz - az) / L, nz = (bx - ax) / L, m = Math.max(1, Math.ceil(L));
    for (let k = 0; k <= m; k++) for (const o of [-(hw - 0.3), 0, hw - 0.3]) {
      const f = k / m, x = ax + (bx - ax) * f + nx * o, z = az + (bz - az) * f + nz * o, y = ay + (by - ay) * f;
      for (let j = 0; j + 1 < n; j++) {
        if (j === i) continue;
        const cx = pts[j * 3], cz = pts[j * 3 + 2], dx = pts[j * 3 + 3] - cx, dz = pts[j * 3 + 5] - cz, l2 = dx * dx + dz * dz;
        if (l2 < 1e-6) continue;
        // (A straight run on into the next leg, a landing after a flight, is no overlap.)
        if (Math.abs(j - i) === 1 && (dx * (bx - ax) + dz * (bz - az)) / (Math.sqrt(l2) * L) > 0.95) continue;
        const t = Math.max(0, Math.min(1, ((x - cx) * dx + (z - cz) * dz) / l2));
        if (Math.hypot(x - cx - dx * t, z - cz - dz * t) > hw - 0.3) continue;
        const dy = Math.abs(pts[j * 3 + 1] + (pts[j * 3 + 4] - pts[j * 3 + 1]) * t - y);
        if (dy > 0.3 && dy < PASSAGE_H + 0.3) { hits++; break; }
      }
    }
  }
  return hits;
}

function routeHits(pts: number[], blocked: (x: number, y: number, z: number) => boolean): number {
  let hits = 0;
  for (let i = 0; i + 5 < pts.length; i += 3) {
    const L = Math.hypot(pts[i + 3] - pts[i], pts[i + 5] - pts[i + 2]), n = Math.max(1, Math.ceil(L * 4));
    for (let k = 0; k < n; k++) {
      const f = k / n;
      if (blocked(pts[i] + (pts[i + 3] - pts[i]) * f, pts[i + 1] + (pts[i + 4] - pts[i + 1]) * f, pts[i + 2] + (pts[i + 5] - pts[i + 2]) * f)) hits++;
    }
  }
  return hits;
}

function routeVariant(b: Box, gx: number, gz: number, ux: number, uz: number, ground: (x: number, z: number) => number, env: RouteEnv,
  lat: number, sgTop: number, shift: number, away: number, sinkMin = 0): EntranceRoute | null {
  const gy = ground(gx, gz), sy = b.y0 + PLATFORM_H;
  const toW = (u: number, v: number): [number, number] => [b.cx + b.ux * u - b.uz * v, b.cz + b.uz * u + b.ux * v];
  const uOf = (x: number, z: number) => (x - b.cx) * b.ux + (z - b.cz) * b.uz;
  // The flights run along the hall's side wall (outside it).
  const fv = lat * (b.hv + PASSAGE_HW + 0.2 + away);
  // Corridor level: the ceiling under the street from the end of the opening on, above the hall's roof if possible.
  const corridor = Math.max(gy - COVER, Math.min(gy - 2.4, b.y1 + 0.3));
  const flightLen = (drop: number) => drop / STAIR_SLOPE + (Math.max(1, Math.ceil(drop / FLIGHT_RISE)) - 1) * LANDING + 2 * CORNER;
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
  // (Where the street falls away beyond the opening, the run first goes on down by stairs, straight
  // on: a slope must not run into the turn.)
  const run0 = hl + CORNER + 0.4, cx0 = gx + dx * run0, cz0 = gz + dz * run0;
  const sink = Math.min(6, Math.max(sinkMin, Math.max(0, corridor - (ground(cx0, cz0) - COVER)) / STAIR_SLOPE));
  const ox = gx + dx * (run0 + sink), oz = gz + dz * (run0 + sink);
  const wu = bottom(uOf(ox, oz));
  let u = wu + sgTop * flightLen(corridor - sy);
  const [qx, qz] = toW(u, fv);
  // The corridor's way: straight to the top of the flights; but arriving from where the flights
  // go (it would run back alongside the first flight), it swings out beside the top and comes in square.
  const way: [number, number][] = [[ox, oz]];
  {
    // Out of the opening, heading back the way the stair came down: first a step aside (else the
    // corridor would run back under its own stair).
    if ((qx - ox) * dx + (qz - oz) * dz < 0) {
      const side = (qx - ox) * -dz + (qz - oz) * dx >= 0 ? 1 : -1, off = 2 * PASSAGE_HW + 0.8;
      way.push([ox - dz * side * off, oz + dx * side * off]);
    }
    const [fx, fz] = [-b.ux * sgTop, -b.uz * sgTop]; // the flights' way down
    const [lx, lz] = way[way.length - 1];
    if ((lx - qx) * fx + (lz - qz) * fz > 0.4 * Math.hypot(lx - qx, lz - qz)) {
      // (On the side it comes from, so it runs in clear of the flights' strip.)
      const side = Math.sign((lx - qx) * -b.uz + (lz - qz) * b.ux) || lat;
      way.push(toW(u, fv + side * (2 * PASSAGE_HW + 0.8)));
    }
  }
  way.push([qx, qz]);
  // Sample points along it: level for a landing's length at either side of every turn (a slope
  // running into a turn leaves a ledge across the corner), sinking by stairs between.
  const sx: number[] = [], sz: number[] = [], lvl: boolean[] = [];
  for (let w = 0; w + 1 < way.length; w++) {
    const [ax, az] = way[w], [bx, bz] = way[w + 1], L = Math.hypot(bx - ax, bz - az), ce = Math.min(CORNER, L / 3);
    const inner = Math.max(1, Math.ceil((L - 2 * ce) / 3));
    const fs = [0, ...Array.from({ length: inner + 1 }, (_, k) => ce + ((L - 2 * ce) * k) / inner)];
    if (w + 2 === way.length) fs.push(L);
    fs.forEach((f, k) => {
      const t = L > 1e-6 ? f / L : 0;
      sx.push(ax + (bx - ax) * t); sz.push(az + (bz - az) * t);
      // Level from here to the next sample: the first and last stretch of every leg.
      lvl.push(k === 0 || k === fs.length - (w + 2 === way.length ? 2 : 1));
    });
  }
  const ns = sx.length - 1;
  const at = (k: number): [number, number] => [sx[k], sz[k]];
  const ys: number[] = [];
  for (let k = 0; k <= ns; k++) {
    const [x, z] = at(k);
    ys.push(Math.min(corridor, ground(x, z) - COVER, env.cap ? env.cap(x, z) : Infinity));
  }
  // The flights must pass under sewers too: start them low enough (they descend at least ~0.45).
  if (env.cap) {
    const fl = flightLen(corridor - sy);
    for (let d = 0; d <= fl; d += 1) {
      const [x, z] = toW(u - sgTop * d, fv);
      ys[ns] = Math.min(ys[ns], env.cap(x, z) + 0.45 * Math.max(0, d - CORNER));
    }
  }
  // Never climbing again on the way down (a dip under a sewer or a hollow in the street would
  // otherwise make the corridor go down and back up before the flights); then no steeper than a
  // stair, and level over the end landings.
  for (let k = 1; k <= ns; k++) ys[k] = Math.min(ys[k], ys[k - 1]);
  for (let k = ns - 1; k >= 0; k--) ys[k] = Math.min(ys[k], ys[k + 1] + (lvl[k] ? 0 : STAIR_SLOPE * Math.hypot(sx[k + 1] - sx[k], sz[k + 1] - sz[k])));
  // (Lower than the street alone asked for: once more with the run long enough for that.)
  const need = (corridor - ys[0]) / STAIR_SLOPE;
  if (need > sink + 0.2 && need <= 6 && sinkMin === 0) return routeVariant(b, gx, gz, ux, uz, ground, env, lat, sgTop, shift, away, need);
  if (sink > 0.3) add(gx + dx * (hl + sink), ys[0], gz + dz * (hl + sink));
  for (let k = 0; k <= ns; k++) { const [x, z] = at(k); add(x, ys[k], z); }
  const yq = ys[ns];
  if (yq <= sy) return null;
  // A landing where it turns, flights with landings, then level to the doorway.
  const n = Math.max(1, Math.ceil((yq - sy) / FLIGHT_RISE)), rise = (yq - sy) / n;
  u -= sgTop * CORNER;
  { const [x, z] = toW(u, fv); pts.push(x, yq, z); }
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

/** Floor of a cross-platform underpass under its hall's track bed (ceiling and slab under the tracks). */
const UNDERPASS_DROP = PASSAGE_H + 0.4;

/**
 * Underpass between a hall's two platforms (so a platform with no street entrance of its own
 * can still be reached, and left, on foot): through a doorway in one side wall, flights down
 * alongside the hall towards its middle, across under the tracks, flights back up alongside the
 * other wall and through the doorway opposite the first. In plan a U: the legs never pass over
 * one another. Null when every place for it cuts through something else.
 */
export function underpassRoute(b: Box, env: RouteEnv = {}): { pts: number[]; u: number } | null {
  const sy = b.y0 + PLATFORM_H, yb = b.y0 - UNDERPASS_DROP, drop = sy - yb;
  const toW = (u: number, v: number): [number, number] => [b.cx + b.ux * u - b.uz * v, b.cz + b.uz * u + b.ux * v];
  const n = Math.max(1, Math.ceil(drop / FLIGHT_RISE)), rise = drop / n;
  const len = drop / STAIR_SLOPE + (n - 1) * LANDING + 2 * CORNER;
  let best: { pts: number[]; u: number } | null = null, bestHits = Infinity;
  for (const want of [-0.3, 0.3, -0.6, 0.6, 0]) {
    const ud = doorSlot(b.hu, want * b.hu, 0);
    const g = ud > 0 ? -1 : 1;
    if (Math.abs(ud + g * len) > b.hu - 2) continue;
    const pts: number[] = [];
    const push = (u: number, v: number, y: number) => { const [x, z] = toW(u, v); pts.push(x, y, z); };
    const fv = b.hv + PASSAGE_HW + 0.2;
    // Down on the + side (stub through the doorway, then the flights with landings) …
    push(ud, b.hv - 2.1, sy);
    push(ud, b.hv - 0.05, sy);
    push(ud, fv, sy);
    // (Level landings wherever it turns.)
    let u = ud + g * CORNER;
    push(u, fv, sy);
    for (let k = 0; k < n; k++) {
      u += g * rise / STAIR_SLOPE;
      push(u, fv, sy - rise * (k + 1));
      if (k + 1 < n) { u += g * LANDING; push(u, fv, sy - rise * (k + 1)); }
    }
    u += g * CORNER;
    push(u, fv, yb);
    // … across under the tracks …
    push(u, -fv, yb);
    // … and up on the - side, back to the doorway opposite.
    u -= g * CORNER;
    push(u, -fv, yb);
    for (let k = 0; k < n; k++) {
      if (k > 0) { u -= g * LANDING; push(u, -fv, yb + rise * k); }
      u -= g * rise / STAIR_SLOPE;
      push(u, -fv, yb + rise * (k + 1));
    }
    push(ud, -fv, sy);
    push(ud, -(b.hv - 0.05), sy);
    push(ud, -(b.hv - 2.1), sy);
    const hits = (env.blocked ? routeHits(pts, env.blocked) : 0) + selfHits(pts, PASSAGE_HW);
    if (hits < bestHits) { best = { pts, u: ud }; bestHits = hits; }
    if (hits === 0) break;
  }
  return bestHits === 0 ? best : null;
}

/** Route surroundings from the city's volumes: under the sewers, clear of other tunnels and halls. */
export function routeEnv(tubes: Tube[], halls: Box[], own: Box): RouteEnv {
  // Only the stretches of the volumes around the hall (its routes stay near it; a point beyond
  // is checked against everything): many samples are taken along every candidate route.
  const R = own.hu + 250, x0 = own.cx - R, x1 = own.cx + R, z0 = own.cz - R, z1 = own.cz + R;
  const crop = (list: Tube[]) => list.flatMap((t) => cropTube(t, x0, z0, x1, z1));
  const allSewers = tubes.filter((t) => t.kind === 'sewer'), allOthers = tubes.filter((t) => t.kind !== 'passage' || t.underpass);
  const sewersNear = crop(allSewers), othersNear = crop(allOthers);
  const inside = (x: number, z: number) => x > x0 + 10 && x < x1 - 10 && z > z0 + 10 && z < z1 - 10;
  let sewers = sewersNear, others = othersNear;
  const pick = (x: number, z: number) => { const i = inside(x, z); sewers = i ? sewersNear : allSewers; others = i ? othersNear : allOthers; };
  halls = halls.filter((h) => h.bounds[2] > x0 && h.bounds[0] < x1 && h.bounds[3] > z0 && h.bounds[1] < z1 || h === own);
  return {
    cap: (x, z) => {
      pick(x, z);
      let c = Infinity;
      for (const t of sewers) {
        if (x < t.bounds[0] - 2 || x > t.bounds[2] + 2 || z < t.bounds[1] - 2 || z > t.bounds[3] + 2) continue;
        const h = tubeAt(t, x, -1e9, z, PASSAGE_HW + 0.4, true);
        if (h) c = Math.min(c, h.floor - (t.channelDepth ?? 0) - 0.4 - PASSAGE_H);
      }
      return c;
    },
    blocked: (x, y, z) => {
      pick(x, z);
      for (const t of others) {
        // (Clear of the underpasses by a wall's thickness: not just inside them.)
        // (An underpass not even at the same level: the stairs ending where it starts down left its
        // side wall standing across their foot, a wall one walked through.)
        const h = tubeAt(t, x, y + 1.1, z, t.underpass ? 0.4 : -0.3);
        if (h && (t.underpass || Math.abs(h.floor - y) > 0.5)) return true;
      }
      for (const hb of halls) if (hb !== own && boxAt(hb, x, y + 1.1, z, 0) && y + 1.1 > hb.y0) return true;
      return false;
    },
  };
}

/** The runs of a tube's segments that come near a rectangle, as tubes of their own (same floors). */
function cropTube(t: Tube, x0: number, z0: number, x1: number, z1: number): Tube[] {
  if (t.bounds[2] < x0 || t.bounds[0] > x1 || t.bounds[3] < z0 || t.bounds[1] > z1) return [];
  const P = t.pts, n = P.length / 3, m = t.halfWidth + 2, out: Tube[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length >= 6) {
      const c = makeTube(t.kind, run, t.halfWidth, t.height, t.channel, t.channelDepth);
      c.underpass = t.underpass;
      out.push(c);
    }
    run = [];
  };
  for (let i = 0; i + 1 < n; i++) {
    const ax = P[i * 3], az = P[i * 3 + 2], bx = P[i * 3 + 3], bz = P[i * 3 + 5];
    const near = Math.max(ax, bx) + m > x0 && Math.min(ax, bx) - m < x1 && Math.max(az, bz) + m > z0 && Math.min(az, bz) - m < z1;
    if (!near) { flush(); continue; }
    if (!run.length) run.push(ax, P[i * 3 + 1], az);
    run.push(bx, P[i * 3 + 4], bz);
  }
  flush();
  return out;
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

