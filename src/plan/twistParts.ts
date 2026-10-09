/**
 * The twisted tower's lowest storeys, walkable (plan/marvelParts builds the rest of it): each
 * storey a block turned a little further than the one under it, its glass walls round a floor plate
 * of its own outline. A lobby at the foot (the way in through the front), above it a sky lounge, a
 * café, a studio. Scissor stairs up the middle: each flight climbs one storey through a well in the
 * floor above, the next flight starts beside where it arrives and runs back the other way. As the
 * storeys turn, each well is cut wide enough in the turned plate (glass rails round it) and the
 * flights sit far enough apart for the turn. The rooms are furnished by the interior core.
 */
import { Rng, deriveSeed } from '../core/rng';
import type { Landmark } from './landmarks';
import { Kit, mat, wallAB, GLASS, CONC, type PartMat, type RGB, type Opt } from './landmarkParts';
import { ringWalls, wayIn } from './lookoutParts';
import { emptyDesign, type Design } from '../interior/design/types';
import { emitDesign } from '../interior/design/emit';
import { scifiTheme } from '../interior/design/theme';
import { fillStorey } from '../interior/design/storey';
import { lookoutItems } from '../interior/fill/lookout';
import { starshipItems } from '../interior/fill/starship';
import type { Program } from '../interior/fill/split';
import type { RoomType } from '../interior/InteriorGen';
import type { Area } from '../interior/fill/area';
import { setDesign } from './designs';
import { polyArea } from '../core/geom2';

type P2 = [number, number];

/** What the tower looks like and how its blocks turn (from plan/marvelParts). */
export interface TwistShell {
  /** Blocks in all, each dh high. */
  n: number;
  dh: number;
  /** A block's turn and its size (share of P.side). */
  tw: (i: number) => number;
  s: (i: number) => number;
  wall: PartMat;
  plain: PartMat;
  roof: PartMat;
  accent: RGB;
  glass: RGB;
}

/** Wall thickness, flight width, landing depth before and after a flight. */
const TH = 0.3, FW = 1.4, LAND = 1.8;
/** The aisle beside a flight (or the rail round its well) to the rooms round the stair hall. */
const AISLE = 1.7;
/** The ceiling slab under the next floor plate (deeper than a flight's first steps reach down). */
const CEIL = 0.34;

const turn = (a: number, [u, v]: P2): P2 => [u * Math.cos(a) - v * Math.sin(a), u * Math.sin(a) + v * Math.cos(a)];
const rect = (a: number, b: number, u0 = -a, v0 = -b, u1 = a, v1 = b): P2[] => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];

interface Stairs { m: number; n: number; tread: number; L: number; gap: number; core: number }

/**
 * How many storeys get an inside and the flights between them: the flights as steep as needed to
 * fit the narrowest storey with a landing at each end, apart by what the storeys turn over their
 * length; one storey only (no stairs) where they do not fit.
 */
function plan(S: TwistShell, side: number, aspect: number): Stairs | null {
  for (let m = Math.min(S.dh > 6 ? 2 : 4, S.n - 1); m >= 2; m--) {
    let a = Infinity, b = Infinity, turnMax = 0;
    for (let i = 0; i < m; i++) { a = Math.min(a, side * S.s(i) - TH); b = Math.min(b, side * S.s(i) * aspect - TH); }
    for (let i = 0; i + 1 < m; i++) turnMax = Math.max(turnMax, Math.abs(S.tw(i + 1) - S.tw(i)));
    const room = 2 * (a - LAND) - 0.2;
    let n = Math.ceil(S.dh / 0.2), tread = 0.28;
    if (n * tread > room) { n = Math.ceil(S.dh / 0.29); tread = Math.min(0.3, room / n); }
    if (tread < 0.25) continue;
    const L = n * tread;
    // (How far a flight's far corner swings across over one storey's turn.)
    const swing = (L / 2 + FW + 1) * Math.sin(turnMax) + 0.1;
    const gap = 0.3 + 2 * swing, core = gap / 2 + FW + swing + AISLE;
    if (b - core < 1.2) continue;
    return { m, n, tread, L, gap, core };
  }
  return null;
}

const ALL = (type: RoomType): Program => ({ reserve: [{ type, at: 'all' }], rooms: [], corridor: 0 });

/**
 * A storey above the lobby as rooms round the stair hall, each from the hall out to the glass:
 * the café storey (a café, a lounge, a store room), the capsule hotel (sleeping pods and
 * lounges), the studios (labs, a control room, a store room).
 */
function storeyProgram(type: RoomType, cx: number, cz: number, angles: number[]): Program {
  const rooms: Program['rooms'] = type === 'mess'
    ? [{ type: 'mess', len: [14, 20], max: 2 }, { type: 'lounge', len: [12, 18], max: 1 }, { type: 'storage', len: [6, 9], max: 1 }]
    : type === 'lounge'
      ? [{ type: 'lounge', len: [12, 18] }, { type: 'quarters', len: [7, 10] }, { type: 'quarters', len: [7, 10] }]
      : [{ type: 'lab', len: [8, 12] }, { type: 'control', len: [9, 13], max: 1 }, { type: 'lab', len: [8, 12] }, { type: 'storage', len: [6, 9], max: 1 }];
  return { reserve: [], rooms, corridor: 0, leaf: ['quarters', 'storage'], sectors: { cx, cz, angles }, doorsMid: true };
}

/** A plate (half size a × b) with a rectangular well [u0, u1] × [v0, v1] through it (current frame). */
function plate(k: Kit, a: number, b: number, y0: number, y1: number, well: [number, number, number, number] | null, m: PartMat, o: Opt): void {
  if (!well) { k.box(0, 0, a, b, y0, y1, m, o); return; }
  const [u0, u1, v0, v1] = [Math.max(-a, well[0]), Math.min(a, well[1]), Math.max(-b, well[2]), Math.min(b, well[3])];
  const put = (p0: number, p1: number, q0: number, q1: number) => { if (p1 - p0 > 0.02 && q1 - q0 > 0.02) k.box((p0 + p1) / 2, (q0 + q1) / 2, (p1 - p0) / 2, (q1 - q0) / 2, y0, y1, m, o); };
  put(-a, u0, -b, b);
  put(u1, a, -b, b);
  put(u0, u1, -b, v0);
  put(u0, u1, v1, b);
}

/**
 * Builds the walkable storeys at the tower's foot (storey 0 the lobby with the way in) and keeps
 * the design; returns how many blocks they took (the caller builds the solid ones above).
 */
export function twistInside(k: Kit, lm: Landmark, S: TwistShell): number {
  const P = lm.p, B = k.B, dh = S.dh;
  const half = (i: number): P2 => [P.side * S.s(i), P.side * S.s(i) * P.aspect];
  const st = plan(S, P.side, P.aspect);
  const m = st ? st.m : 1;
  const r = new Rng(deriveSeed(lm.seed, 'twist-rooms'));
  const T = scifiTheme(S.accent);
  const floorM = T.floor, clear = mat(GLASS, S.glass);
  const D: Design = emptyDesign();
  // Flight i: on storey i, side σ (+v or -v of the middle), climbing along +u (even) or -u (odd).
  const sgn = (i: number) => (i % 2 === 0 ? 1 : -1);
  const flight = (i: number): P2[] => {
    const c = sgn(i) * (st!.gap / 2 + FW / 2);
    return rect(st!.L / 2, FW / 2, -st!.L / 2, c - FW / 2, st!.L / 2, c + FW / 2);
  };
  // The well a flight from below climbs through, in the turned frame of the storey it arrives on.
  const wellOf = (i: number): [number, number, number, number] => {
    const pts = flight(i - 1).map((p) => turn(S.tw(i - 1) - S.tw(i), p));
    const us = pts.map((p) => p[0]), vs = pts.map((p) => p[1]);
    return [Math.min(...us) - 0.05, Math.max(...us) + 0.05, Math.min(...vs) - 0.05, Math.max(...vs) + 0.05];
  };
  const up: RoomType[] = ['lounge', 'mess', 'lab'];
  for (let i = up.length - 1; i > 0; i--) { const j = r.int(0, i); [up[i], up[j]] = [up[j], up[i]]; }
  const types: RoomType[] = ['foyer', ...up];
  const rails: [P2, P2, number][] = [];
  const halls: [P2[], number, number][] = [];
  let seed = deriveSeed(lm.seed, 'twist-storeys');
  for (let i = 0; i < m; i++) {
    const [a, b] = half(i), tw = S.tw(i), y = B + i * dh, y1 = y + dh, top = i === m - 1;
    const well = i > 0 ? wellOf(i) : null;
    k.sub(0, 0, tw, () => {
      // The floor plate (the lobby's on a foundation), the glass walls, the ceiling under the
      // next plate (its corners out of the next block are the ledges one sees from outside).
      plate(k, a, b, i === 0 ? y - 0.3 : y - 0.25, y, well, S.plain, { top: floorM, map: 0, deck: true, foot: i === 0 ? true : undefined });
      ringWalls(k, rect(a - TH / 2, b - TH / 2), y, y1 - CEIL, TH, S.wall, i === 0 ? 3.0 : 0, 3.0, { map: 0, foot: i === 0 ? true : undefined });
      const f = st && !top ? flight(i) : null;
      plate(k, a, b, y1 - CEIL, top ? y1 : y1 - 0.05, f ? [f[0][0] - 0.05, f[1][0] + 0.05, f[0][1] - 0.05, f[2][1] + 0.05] : null, S.plain, { top: S.roof, map: 0, deck: true });
      if (i % 2 === 1) ringWalls(k, rect(a + 0.3, b + 0.3), y1 - 0.4, y1, 0.6, S.plain, 0, 0, { detail: true, solid: false });
    });
    if (i === 0) {
      const fp = k.box(0, 0, a, b, B, B + dh, mat(CONC), { solid: false, map: 1 });
      fp.hidden = true; fp.footprint = true;
      wayIn(k, rect(a - TH / 2, b - TH / 2), 3.0);
    }
    // Glass rails round the well, open at the end the flight arrives at.
    if (well) {
      const [u0, u1, v0, v1] = well, arrive = sgn(i - 1);
      const low = arrive > 0 ? u0 : u1;
      for (const [p, q] of [[[u0, v0], [u1, v0]], [[u0, v1], [u1, v1]], [[low, v0], [low, v1]]] as [P2, P2][]) rails.push([turn(tw, p), turn(tw, q), y]);
    }
    // The flight up to the next storey.
    if (st && !top) {
      const dir = turn(tw, [sgn(i), 0]), from = turn(tw, [-sgn(i) * st.L / 2, sgn(i) * (st.gap / 2 + FW / 2)]);
      D.stairs.push({ from, dir, width: FW, tread: st.tread, y0: y, y1, n: st.n });
    }
    // The rooms: inside the walls' inner faces. The stair core (the flights, the wells, the
    // landings and an aisle beside them) is kept clear: the lobby round it, open; above, a hall
    // with the rooms round it where they are deep enough, else one open floor.
    const outline = rect(a - TH, b - TH).map((p) => turn(tw, p));
    const used = [...(st && !top ? [sgn(i)] : []), ...(well ? [sgn(i - 1)] : [])];
    const hub = st && used.length ? rect(0, 0, -st.L / 2 - LAND, used.includes(-1) ? -st.core : 0.15 - AISLE, st.L / 2 + LAND, used.includes(1) ? st.core : AISLE - 0.15).map((p) => turn(tw, p)) : null;
    // (The lobby: the desk and seats of a tower's foot, a lounge corner, in a big one a café.)
    const items = (type: RoomType, A: Area, rr: Rng) => type !== 'foyer' ? starshipItems(type, A, rr)
      : [...lookoutItems({})(type, A, rr), ...starshipItems('lounge', A, rr), ...(Math.abs(polyArea(A.poly)) > 300 ? starshipItems('mess', A, rr) : [])];
    const brief = { outline: outline.flat(), front: null, y, top: y1 - CEIL, seed, items };
    if (i > 0 && hub && st && b - TH - st.core >= 3.5) {
      const angles = Array.from({ length: 16 }, (_, j) => tw + (j * Math.PI) / 8);
      // (The hall runs out to the glass at the back: a landing with a view, and no room has to
      // wrap round it.)
      const [h0, h1, h2, h3] = hub.map((p) => turn(-tw, p));
      const hall0 = [h0, h1, [h2[0], b - TH + 1], [h3[0], b - TH + 1]].map((p) => turn(tw, p as P2));
      const split = fillStorey(D, { ...brief, fixed: [{ type: 'stairs', poly: hall0.flat(), hub: true, fixed: true }], program: storeyProgram(types[i], 0, 0, angles), cell: 0.3 });
      const hall = split.spaces[0].poly;
      halls.push([Array.from({ length: hall.length / 2 }, (_, j): P2 => [hall[2 * j], hall[2 * j + 1]]), y, y1 - CEIL]);
      D.lights.push([0, 0, y1 - 0.55]);
    } else {
      const h = 1.5 / (2 * (a - TH));
      fillStorey(D, {
        ...brief, fixed: [], program: ALL(types[i]), cell: 0.25, keepOut: hub ? [hub.flat()] : [],
        entrances: i === 0 ? [{ ax: outline[0][0], az: outline[0][1], bx: outline[1][0], bz: outline[1][1], doors: [[0.5 - h, 0.5 + h]] }] : [],
      });
    }
    seed += 1000;
  }
  k.inner(() => {
    emitDesign(k, D, T);
    for (const [p, y0, y1] of halls) k.roomPoly(p, y0, y1);
    for (const [p, q, y] of rails) wallAB(k, p, q, y, y + 1.05, 0.06, clear, [], { detail: true, solid: true, clear: true, map: 0 });
  });
  setDesign(lm, D);
  return m;
}
