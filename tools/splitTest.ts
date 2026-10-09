/**
 * Self test of the splitter (fill/split) and the work themes (fill/work), run by tools/selftest.ts:
 * on odd outlines (an L, a T, a U, a triangle, a round end) and on real storeys of homes, offices,
 * shops and cafés, the rooms cover the storey without overlapping, every room is big enough to use
 * and can be reached through doors from the stairs or a hall, and the theme's big space was
 * reserved first. Offices get desks, meeting rooms their table, shops a checkout (clothes shops
 * their fitting mirror), cafés a counter and tables.
 */
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { planCell } from '../src/plan/cell';
import { buildingLayout } from '../src/build/buildingLayout';
import { planFloor, planCores, coreFits, shopKindOf, isArcade, type FloorPlan, type Room } from '../src/interior/InteriorGen';
import { splitStorey, type Space, type Program } from '../src/interior/fill/split';
import { homeProgram } from '../src/interior/fill/home';
import { workProgram } from '../src/interior/fill/work';
import { intersection } from '../src/core/clip';
import { polyArea, pointInPoly, minAreaRect, type Poly } from '../src/core/geom2';
import { Rng } from '../src/core/rng';

type Check = (ok: boolean, msg: string) => void;

const area = (p: Poly) => Math.abs(polyArea(p));

/** Overlap of two rooms (m²). */
function overlapArea(a: Poly, b: Poly): number {
  return intersection([a], [b]).reduce((s, q) => s + area(q.outer), 0);
}

/**
 * Rooms that cannot be reached through a door (or an open stretch) from a hub: doors join the
 * rooms on either side of them.
 */
function unreachable(rooms: { type: string; poly: Poly; hub: boolean }[], walls: FloorPlan['walls']): number[] {
  const n = rooms.length, par = rooms.map((_, i) => i);
  const find = (i: number): number => (par[i] === i ? i : (par[i] = find(par[i])));
  const at = (x: number, z: number) => rooms.findIndex((r) => pointInPoly(r.poly, x, z));
  for (const w of walls) {
    const L = Math.hypot(w.bx - w.ax, w.bz - w.az);
    if (L < 1e-6) continue;
    const nx = -(w.bz - w.az) / L, nz = (w.bx - w.ax) / L;
    for (const [t0, t1] of w.doors) {
      const t = (t0 + t1) / 2, x = w.ax + (w.bx - w.ax) * t, z = w.az + (w.bz - w.az) * t;
      const a = at(x + nx * 0.3, z + nz * 0.3), b = at(x - nx * 0.3, z - nz * 0.3);
      if (a >= 0 && b >= 0) par[find(a)] = find(b);
    }
  }
  // A house without halls is entered from the street into its biggest room.
  const big = rooms.reduce((m, r, i) => (area(r.poly) > area(rooms[m].poly) ? i : m), 0);
  const hubRoots = new Set(rooms.some((r) => r.hub) ? rooms.map((r, i) => (r.hub ? find(i) : -1)) : [find(big)]);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (!hubRoots.has(find(i))) out.push(i);
  return out;
}

const HUBS = new Set(['stairs', 'hall', 'corridor', 'lobby', 'office', 'shop', 'cafe']);

interface Stats { storeys: number; overlap: number; gap: number; small: number; lost: number; rooms: number; [k: string]: number }

/** The shared checks for one divided storey. */
function judge(S: Stats, outline: Poly, rooms: { type: string; poly: Poly; hub: boolean }[], walls: FloorPlan['walls']): void {
  S.storeys++;
  S.rooms += rooms.length;
  let sum = 0;
  for (let i = 0; i < rooms.length; i++) {
    sum += area(rooms[i].poly);
    for (let j = i + 1; j < rooms.length; j++) if (overlapArea(rooms[i].poly, rooms[j].poly) > 0.3) { S.overlap++; }
    const o = minAreaRect(rooms[i].poly);
    if (!rooms[i].hub && (area(rooms[i].poly) < 2.4 || 2 * Math.min(o.hu, o.hv) < 1.15) && rooms[i].type !== 'storage') S.small++;
  }
  // (Slivers under 15 cm between the stairs and the facade stay without a room.)
  if (Math.abs(sum - area(outline)) > area(outline) * 0.01 + 4) S.gap++;
  // Closets that could not join a neighbour may stay shut.
  S.lost += unreachable(rooms, walls).filter((i) => rooms[i].type !== 'storage').length;
}

/** Odd outlines (world metres, centred near the origin). */
function shapes(): [string, Poly][] {
  const round: Poly = [];
  for (let k = 0; k <= 8; k++) { const a = -Math.PI / 2 + (k / 8) * Math.PI; round.push(14 + Math.cos(a) * 8, Math.sin(a) * 8); }
  round.push(-14, 8, -14, -8);
  return [
    ['L', [0, 0, 24, 0, 24, 10, 10, 10, 10, 26, 0, 26]],
    ['T', [0, 0, 30, 0, 30, 10, 19, 10, 19, 24, 11, 24, 11, 10, 0, 10]],
    ['U', [0, 0, 28, 0, 28, 22, 19, 22, 19, 9, 9, 9, 9, 22, 0, 22]],
    ['triangle', [0, 0, 30, 0, 6, 22]],
    ['round end', round],
    ['skewed', [0, 0, 20, 3, 24, 17, -3, 14]],
  ];
}

export function splitChecks(check: Check): void {
  // --- 1. Odd outlines, every program, a stair hall in one corner.
  const S: Stats = { storeys: 0, overlap: 0, gap: 0, small: 0, lost: 0, rooms: 0, reserved: 0, reserveWanted: 0 };
  const programs: [string, Program][] = [['home', homeProgram(false)], ['office', workProgram('office', false)], ['office ground', workProgram('office', true)], ['grocery', workProgram('grocery', true)], ['cafe', workProgram('cafe', true)]];
  for (const [name, poly] of shapes()) {
    for (const [pn, P] of programs) {
      for (const seed of [1, 2, 3]) {
        const x0 = poly[0], z0 = poly[1];
        const hall: Poly = intersection([poly], [[x0 - 1, z0 - 1, x0 + 4, z0 - 1, x0 + 4, z0 + 5, x0 - 1, z0 + 5]])[0].outer;
        const sp = splitStorey({ poly, fixed: [{ type: 'stairs', poly: hall, hub: true }], front: [0, 1] }, P, new Rng(seed));
        const rooms = sp.spaces.map((s: Space) => ({ type: s.type, poly: s.poly, hub: !!s.hub }));
        judge(S, poly, rooms, sp.walls);
        const want = P.reserve[P.reserve.length - 1];
        if (want) { S.reserveWanted++; if (sp.spaces.some((s) => s.type === want.type && s.hub && area(s.poly) > area(poly) * 0.25)) S.reserved++; }
        void name; void pn;
      }
    }
  }
  check(S.overlap === 0, `odd outlines: rooms do not overlap (${S.overlap} overlapping pairs in ${S.storeys} storeys)`);
  check(S.gap === 0, `odd outlines: rooms cover the whole storey (${S.gap} storeys with gaps)`);
  check(S.small === 0, `odd outlines: every room is big enough to use (${S.small} too small or too narrow of ${S.rooms})`);
  check(S.lost === 0, `odd outlines: every room has a way in (${S.lost} shut off)`);
  check(S.reserved === S.reserveWanted, `odd outlines: the theme's big space is reserved first (${S.reserved} of ${S.reserveWanted})`);

  // --- 2. Real storeys of every kind.
  const R: Stats = { storeys: 0, overlap: 0, gap: 0, small: 0, lost: 0, rooms: 0, ms: 0, open: 0, desks: 0, meetings: 0, tables: 0, shops: 0, checkouts: 0, clothes: 0, mirrors: 0, cafes: 0, bars: 0, cafeTables: 0, lobbies: 0, receptions: 0, workStoreys: 0, workMs: 0 };
  for (const [seed, size] of [[42, 0.4], [7, 0.7], [3, 0.5]] as const) {
    const terrain = new Terrain(makeProfile({ seed, size }));
    const macro = buildMacroPlan(terrain);
    const c0 = macro.centres[0];
    const cells = macro.cells.slice().sort((a, b) => Math.hypot(a.centroid[0] - c0.x, a.centroid[1] - c0.z) - Math.hypot(b.centroid[0] - c0.x, b.centroid[1] - c0.z));
    let done = 0;
    for (const c of cells.slice(0, 14)) for (const b of planCell(macro, c, terrain).buildings) {
      if (done >= 40 || b.use === 'industrial' || b.use === 'parking' || b.style === 'church') continue;
      done++;
      const L = buildingLayout(b, terrain, 0);
      const { lift, stair } = planCores(b, L.tiers[0].poly, Math.max(...L.floors.map((q) => q.y1 - q.y0)), L.door);
      for (const fl of L.floors.slice(0, 2)) {
        if (fl.f === 0 && isArcade(b)) continue;
        const poly = L.tiers[fl.tier].poly;
        const next = L.floors.find((q) => q.f === fl.f + 1);
        const up = !!stair && !!next && coreFits(stair, poly) && coreFits(stair, L.tiers[next.tier].poly);
        const run = () => planFloor(b, poly, fl.f, fl.y0, fl.y1 - fl.y0, shopKindOf(b), lift, stair, up, fl.f > 0 && !!stair && coreFits(stair, poly), fl.f === 0 ? L.door : null);
        const t0 = performance.now();
        const plan = run();
        let ms = performance.now() - t0;
        const work = b.use === 'office' || (fl.f === 0 && (b.shopfront || b.use === 'retail'));
        // (The same storey twice more, the fastest counts: other test workers share the CPU.)
        if (work) for (let k = 0; k < 2; k++) { const t1 = performance.now(); run(); ms = Math.min(ms, performance.now() - t1); }
        R.ms += ms;
        const ov0 = R.overlap, lost0 = R.lost;
        judge(R, poly, plan.rooms.map((r: Room) => ({ type: r.type, poly: r.poly, hub: HUBS.has(r.type) })), plan.walls);
        if (work) { R.workStoreys++; R.workMs += ms; }
        const inRoom = (r: Room) => plan.furniture.filter((f) => pointInPoly(r.poly, f.x, f.z));
        for (const r of plan.rooms) {
          const A = area(r.poly), f = inRoom(r);
          if (r.type === 'office' && A >= 40) { R.open++; if (f.filter((q) => q.kind === 'desk').length >= 2) R.desks++; }
          if (r.type === 'meeting' && A >= 9) { R.meetings++; if (f.some((q) => q.kind === 'meetingTable')) R.tables++; }
          if (r.type === 'lobby' && A >= 15) { R.lobbies++; if (f.some((q) => q.kind === 'reception')) R.receptions++; }
          if (r.type === 'shop' && A >= 15) {
            R.shops++;
            if (f.some((q) => q.kind === 'counter')) R.checkouts++;
            if (shopKindOf(b) % 3 === 1) { R.clothes++; if (f.some((q) => q.use === 'dress')) R.mirrors++; }
          }
          if (r.type === 'cafe' && A >= 15) { R.cafes++; if (f.some((q) => q.kind === 'barCounter')) R.bars++; if (f.filter((q) => q.kind === 'cafeTable').length >= 2) R.cafeTables++; }
        }
      }
    }
  }
  check(R.storeys > 100, `real storeys checked (${R.storeys}, ${R.workStoreys} offices, shops and cafés)`);
  check(R.overlap === 0, `real storeys: rooms do not overlap (${R.overlap} overlapping pairs)`);
  check(R.gap === 0, `real storeys: rooms cover the whole storey (${R.gap} storeys with gaps)`);
  check(R.small === 0, `real storeys: every room is big enough to use (${R.small} too small or too narrow of ${R.rooms})`);
  check(R.lost === 0, `real storeys: every room has a way in (${R.lost} shut off)`);
  check(R.desks >= R.open * 0.95, `open-plan offices have desks (${R.desks} of ${R.open})`);
  check(R.tables >= R.meetings * 0.9, `meeting rooms have their table (${R.tables} of ${R.meetings})`);
  check(R.receptions >= R.lobbies * 0.9, `office lobbies have a reception desk (${R.receptions} of ${R.lobbies})`);
  check(R.checkouts >= R.shops * 0.9, `shops have a checkout (${R.checkouts} of ${R.shops})`);
  check(R.mirrors === R.clothes, `every clothes shop has its fitting mirror (${R.mirrors} of ${R.clothes})`);
  check(R.bars >= R.cafes * 0.9 && R.cafeTables >= R.cafes * 0.9, `cafés have a counter and tables (${R.bars} counters, ${R.cafeTables} with tables, of ${R.cafes})`);
  // (About 21 ms alone; the bound leaves room for test workers sharing the CPU and still catches a slowdown of 3×.)
  check(R.workMs / Math.max(1, R.workStoreys) < 60, `an office, shop or café storey is planned and furnished in ${(R.workMs / Math.max(1, R.workStoreys)).toFixed(1)} ms (< 60; built one storey per frame as you walk in)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let fails = 0;
  splitChecks((ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; });
  process.exit(fails ? 1 : 0);
}
