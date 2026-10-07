/**
 * Section plan and ring layout for a great hall: a void rising through the middle of a volume,
 * ringed on every level by a gallery walkway (glass rail on the void side) and, behind it, wedge
 * rooms out to the outer wall. Two stair columns climb level by level in neighbouring wedges,
 * alternating, so each flight arrives beside the hole of the one above. Works for any star-shaped
 * section (round, oval, polygonal) and follows the outline as it tapers: the hall ends where the
 * rooms would get too shallow for a flight of stairs.
 */
import { Rng } from '../../core/rng';
import { emptyDesign, type Design, type DFloor, type P2, type RoomFn, type Volume } from './types';

export interface HallProgram {
  /** Ground floor level (the hall's floor; the host builds that plate). */
  y0: number;
  /** Highest the hall may reach (its ceiling plate lies at the last level's top). */
  yMax: number;
  /** Storey height (floor top to floor top) and floor plate thickness. */
  levelH: number;
  slab: number;
  /** Gallery walkway width, wanted room depth (outer wall in to the walkway), smallest depth. */
  walk: number;
  depth: number;
  minDepth: number;
  /** Target room width at the outer wall. */
  roomW: number;
  /** Room functions to deal out (a seeded shuffle of this mix). */
  mix: RoomFn[];
  seed: number;
  /** Bridges across the void: on every this many levels (0: none), from two wedges between the stairs. */
  bridgeEvery?: number;
}

/** Stair geometry: riser target and tread range. */
const RISE = 0.19, TREAD_MAX = 0.3, TREAD_MIN = 0.23, STAIR_W = 1.6, STAIR_IN = 0.7;

export interface HallPlan {
  design: Design;
  /** The void's radius (in section units, from the bottom section) and the hall's top. */
  voidR: number;
  top: number;
  /** Heights of the gallery levels (floor tops). */
  levels: number[];
  /** Number of wedges round. */
  n: number;
  /** Per level index: the wedges where a bridge leaves the gallery (their rail left open). */
  bridges: Record<number, number[]>;
}

export function designHall(vol: Volume, P: HallProgram): HallPlan | null {
  const s0 = vol.section(P.y0);
  const R0 = minEdge(s0.edge.bind(s0));
  const voidR = Math.max(3, Math.min(R0 * 0.55, R0 - P.walk - P.depth));
  const rooms = (y: number) => minEdge((t) => vol.section(y).edge(t)) - voidR - P.walk;
  const steps = Math.ceil(P.levelH / RISE);
  if (rooms(P.y0) < Math.max(P.minDepth, STAIR_IN + steps * TREAD_MIN + 0.8)) return null;

  // Levels: one storey apart while the rooms stay deep enough and the ceiling fits.
  const levels: number[] = [];
  for (let y = P.y0 + P.levelH; y + P.levelH <= P.yMax && rooms(y + P.levelH) >= P.minDepth; y += P.levelH) levels.push(y);
  if (!levels.length) return null;
  const top = levels[levels.length - 1] + P.levelH;

  const D = emptyDesign();
  const n = Math.max(8, 2 * Math.round((Math.PI * R0) / P.roomW));
  const th = (i: number) => (i / n) * Math.PI * 2;
  const r = new Rng(P.seed);
  // Stair wedges: two columns opposite each other, each two wedges wide (flight and hole alternate).
  const sA = [0, n >> 1];
  const isStair = (i: number) => sA.some((s) => i === s || i === s + 1);
  const flightWedge = (j: number, s: number) => s + (j % 2);

  // Ground floor flights (j = 0) up to the first level, then one per level.
  const flight = (j: number, s: number, yA: number) => {
    const w = flightWedge(j, s), sec = vol.section(yA);
    const tm = (th(w) + th(w + 1)) / 2, rw = voidR + P.walk;
    // (Metres per radius unit along this wedge's middle: ellipses stretch them.)
    const k = chord(sec.at(tm, rw), sec.at(tm, rw + 1));
    const a = sec.at(tm, rw + STAIR_IN / k), b = sec.at(tm, sec.edge(tm) - 0.4);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const tread = Math.min(TREAD_MAX, Math.max(TREAD_MIN, (L - 0.4) / steps));
    D.stairs.push({ from: a, dir: [(b[0] - a[0]) / L, (b[1] - a[1]) / L], width: STAIR_W, tread, y0: yA, y1: yA + P.levelH, n: steps });
    return { w, run: (STAIR_IN + steps * tread + 0.3) / k };
  };
  // Holes: in the level each flight comes up to (levels[j] for flight j), above the flight.
  const holes = new Map<number, { w: number; run: number }[]>();
  const allY = [P.y0, ...levels];
  for (let j = 0; j < levels.length; j++) holes.set(j, sA.map((s) => flight(j, s, allY[j])));

  const bridges: Record<number, number[]> = {};
  if (P.bridgeEvery) levels.forEach((_, li) => { if (li % P.bridgeEvery! === 1 % P.bridgeEvery!) bridges[li] = [n >> 2, (3 * n) >> 2]; });
  const fns = shuffle(P.mix, r);
  let fi = 0, seed = P.seed;
  levels.forEach((y, li) => {
    const sec = vol.section(y), lvHoles = holes.get(li) ?? [];
    const yTop = y + P.levelH - P.slab;
    for (let i = 0; i < n; i++) {
      const t0 = th(i), t1 = th(i + 1);
      const e0 = sec.edge(t0) - 0.25, e1 = sec.edge(t1) - 0.25, rw = voidR + P.walk;
      const P0 = (rr: number) => sec.at(t0, rr), P1 = (rr: number) => sec.at(t1, rr);
      // Gallery walkway and its glass rail at the void.
      D.floors.push(plate(P0(voidR), P1(voidR), P1(rw), P0(rw), y, P.slab, 'gallery'));
      const isHole = lvHoles.find((h) => h.w === i);
      if (!bridges[li]?.includes(i)) D.walls.push({ a: P0(voidR + 0.06), b: P1(voidR + 0.06), y0: y, y1: y + 1.1, th: 0.08, kind: 'rail', doors: [] });
      // The room behind: its floor (with the stair hole where a flight comes up).
      if (isHole) {
        const f = 0.5 - (STAIR_W / 2 + 0.15) / chord(P0(rw), P1(rw)), g = 1 - f;
        const L = (q: P2, p: P2, s: number): P2 => [q[0] + (p[0] - q[0]) * s, q[1] + (p[1] - q[1]) * s];
        const at = (s: number, rr: number) => L(P0(rr), P1(rr), s);
        const rh = rw + isHole.run;
        D.floors.push(plate(P0(rw), at(f, rw), at(f, e0 + (e1 - e0) * f), P0(e0), y, P.slab, 'stairs'));
        D.floors.push(plate(at(g, rw), P1(rw), P1(e1), at(g, e0 + (e1 - e0) * g), y, P.slab, 'stairs'));
        D.floors.push(plate(at(f, rh), at(g, rh), at(g, e0 + (e1 - e0) * g), at(f, e0 + (e1 - e0) * f), y, P.slab, 'stairs'));
      } else {
        D.floors.push(plate(P0(rw), P1(rw), P1(e1), P0(e0), y, P.slab, isStair(i) ? 'stairs' : 'quarters'));
      }
      // Wall between this wedge and the next (none inside a stair pair).
      if (!(isStair(i) && isStair(i + 1) && sA.includes(i))) D.walls.push({ a: P1(rw), b: P1(e1), y0: y, y1: yTop, th: 0.2, kind: 'wall', doors: [] });
      // Front wall onto the gallery, a door in the middle (stair wedges stand open).
      const wF = chord(P0(rw), P1(rw)), dw = Math.min(0.45, 0.75 / wF);
      if (isStair(i)) continue;
      D.walls.push({ a: P0(rw), b: P1(rw), y0: y, y1: yTop, th: 0.15, kind: 'wall', doors: [[0.5 - dw, 0.5 + dw]] });
      const fn = fns[fi++ % fns.length];
      const poly: P2[] = [P0(rw), P1(rw), P1(e1), P0(e0)];
      const mid = mean(poly), door = sec.at((t0 + t1) / 2, rw);
      D.rooms.push({ fn, poly, y, h: yTop - y, door, facing: norm([door[0] - mid[0], door[1] - mid[1]]), seed: seed++ });
      D.lights.push([mid[0], mid[1], yTop - 0.25]);
      if (i % 2 === 0) { const g = sec.at((t0 + t1) / 2, voidR + P.walk / 2); D.lights.push([g[0], g[1], yTop - 0.25]); }
    }
  });
  // The hall's ceiling: a plate over the whole section at the top.
  const sT = vol.section(top);
  for (let i = 0; i < n; i++) {
    const t0 = th(i), t1 = th(i + 1);
    D.floors.push(plate(sT.at(t0, 0.01), sT.at(t1, 0.01), sT.at(t1, sT.edge(t1) - 0.1), sT.at(t0, sT.edge(t0) - 0.1), top, P.slab, 'hall'));
  }
  return { design: D, voidR, top, levels, n, bridges };
}

function plate(a: P2, b: P2, c: P2, d: P2, y: number, th: number, fn: RoomFn): DFloor { return { q: [a, b, c, d], y, th, fn }; }
const chord = (a: P2, b: P2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const mean = (p: P2[]): P2 => [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
const norm = (v: P2): P2 => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };

/** Smallest outline radius round the section (sampled). */
function minEdge(edge: (t: number) => number): number {
  let m = Infinity;
  for (let i = 0; i < 24; i++) m = Math.min(m, edge((i / 24) * Math.PI * 2));
  return m;
}

function shuffle<T>(a: T[], r: Rng): T[] {
  const o = a.slice();
  for (let i = o.length - 1; i > 0; i--) { const j = r.int(0, i); [o[i], o[j]] = [o[j], o[i]]; }
  return o;
}
