/**
 * Eateries and their terraces (part of the cell plan, pure data).
 *
 * Shop fronts become cafés, restaurants, bistros, … (plan/eatery.ts); a good share get outside
 * seating where there is room for it, never in the walking corridor of the sidewalk (a clear
 * band of 2 × WALK_CLEAR m around the line people walk along), never in front of a door, near
 * a crossing or over a metro entrance:
 *  - sidewalk terrace: a row of small tables against the facade where the sidewalk is wide
 *    (avenues, boulevards, set-back fronts);
 *  - parklet: a timber deck in the parking strip of a local street (planters at the ends, a
 *    rail on the traffic side), where the sidewalk is too narrow;
 *  - square terrace: tables with parasols out on a plaza or a park the front faces (across the
 *    lane in the old town, or the plaza around a downtown tower).
 * Awnings over the shop windows and an A-board menu by the door. Everything is a street prop
 * (instanced, physical, destructible); the seats are listed for the people (sim/Terraces.ts).
 */
import { Rng, deriveSeed } from '../core/rng';
import { pointInPoly, distPointPolyEdge, closestOnPolyline, polylineLength, polyBounds, type Poly } from '../core/geom2';
import { doorBayOf } from '../build/buildingLayout';
import type { Terrain } from '../world/terrain';
import { RoadClass, type CellInfo, type MacroPlan } from './types';
import type { BuildingDesc } from './building';
import { Eatery, EATERY, eateryKind } from './eatery';
import type { CellPlan, StreetSeg } from './cell';
import { ENTRANCE_L } from './metroDims';

/**
 * PropType values (plan/cell.ts) as plain numbers for the hot loops here (an imported enum is a
 * module getter in dev builds); checked against PropType in the self test.
 */
export const PT = {
  Tree: 0, Lamp: 1, Bench: 2, Bin: 3, Hydrant: 4, TrafficLight: 5, ParkedCar: 6, BusStop: 7, Bollard: 8, Fountain: 9, Statue: 10, Bush: 11,
  Kiosk: 12, Planter: 13, StopSign: 14, Hedge: 15, PlayGround: 16, MetroEntrance: 17, Manhole: 18, Mailbox: 19,
  CafeTable: 20, CafeChair: 21, Parasol: 22, Awning: 23, MenuBoard: 24, TerraceRail: 25, Parklet: 26,
} as const;

/** Half width of the walking corridor kept clear around the sidewalk's walking line (m). */
export const WALK_CLEAR = 1.0;
/** Distance kept from junction centres (crossings, corner turns). */
export const CROSSING_CLEAR = 12;
/** Distance kept from every door (beyond the item's own radius). */
export const DOOR_CLEAR = 1.2;

export const enum TerraceKind { None = 0, Sidewalk = 1, Parklet = 2, Square = 3 }

export interface EateryPlan {
  /** Building index in plan.buildings. */
  b: number;
  kind: Eatery;
  terrace: TerraceKind;
  /** Front facade frame: corner a, unit u along the facade, unit n out of it, frontage length. */
  ax: number; az: number; ux: number; uz: number; nx: number; nz: number; len: number;
  /** Just outside the door. */
  door: [number, number];
  /** Tables: [x, z, seats] * n. */
  tables: number[];
  /** Seats: [x, z, heading (facing the table), table] * n. */
  seats: number[];
  /** Awnings over the windows: [u centre, width, top y above the sidewalk] * n. */
  awnings: number[];
  /** Colour scheme (parasols, awnings, chairs): index into TERRACE_PALETTE. */
  palette: number;
}

/** Fabric / paint colours (sRGB) of the colour schemes: [parasol & awning, chair paint]. */
export const TERRACE_PALETTE: [number, number, number][][] = [
  [[0.93, 0.9, 0.82], [0.12, 0.13, 0.13]], // cream / black
  [[0.13, 0.33, 0.24], [0.13, 0.33, 0.24]], // bottle green
  [[0.5, 0.1, 0.12], [0.16, 0.12, 0.1]],    // burgundy
  [[0.12, 0.2, 0.36], [0.85, 0.85, 0.82]],  // navy / white
  [[0.72, 0.36, 0.2], [0.35, 0.24, 0.16]],  // terracotta
  [[0.85, 0.66, 0.2], [0.2, 0.2, 0.2]],     // mustard
  [[0.24, 0.25, 0.27], [0.55, 0.42, 0.3]],  // charcoal / teak
  [[0.92, 0.92, 0.9], [0.6, 0.15, 0.12]],   // white / red
];

/** Prop radii used for clearance (chairs, tables, …) and of the furniture already there. */
const R_CHAIR = 0.24, R_TABLE = 0.38, R_PLANTER = 0.45;
export const propR = (t: number): number =>
  t === PT.Tree ? 1.1 : t === PT.Fountain ? 4 : t === PT.Statue ? 2.2 : t === PT.Kiosk ? 2 : t === PT.PlayGround ? 5
    : t === PT.Bench ? 1.1 : t === PT.Lamp || t === PT.TrafficLight || t === PT.StopSign ? 0.4 : t === PT.Bush || t === PT.Hedge ? 0.9 : 0.6;

interface Item { t: number; x: number; z: number; yaw: number; s: number; v: number; r: number }

/** Point at arc length s along a polyline, with its unit direction. */
function pointAt(pts: number[], s: number): { x: number; z: number; dx: number; dz: number } {
  let acc = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const dx = pts[i + 2] - pts[i], dz = pts[i + 3] - pts[i + 1];
    const L = Math.hypot(dx, dz);
    if (acc + L >= s || i + 4 >= pts.length) {
      const t = L > 0 ? Math.max(0, Math.min(1, (s - acc) / L)) : 0;
      return { x: pts[i] + dx * t, z: pts[i + 1] + dz * t, dx: dx / (L || 1), dz: dz / (L || 1) };
    }
    acc += L;
  }
  return { x: pts[0], z: pts[1], dx: 1, dz: 0 };
}

/** Door point (0.8 m out of the front facade, at the door bay) — as the people use it. */
export function frontDoor(b: BuildingDesc): { x: number; z: number } {
  const p = b.poly, n = p.length >> 1;
  const i = b.front % n, j = (i + 1) % n;
  const ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
  const L = Math.hypot(bx - ax, bz - az) || 1;
  const bays = Math.max(1, Math.round(L / b.bay));
  const t = ((doorBayOf(b.seed, bays) + 0.5) * (L / bays)) / L;
  return { x: ax + (bx - ax) * t + ((bz - az) / L) * 0.8, z: az + (bz - az) * t - ((bx - ax) / L) * 0.8 };
}

/**
 * Clearance rules shared by the planner and the self test: is a round item of radius r at
 * (x, z) clear of the walking corridors, the carriageways (unless `onRoad`) and paths?
 */
export function clearOfWalk(streets: StreetSeg[], x: number, z: number, r: number, onRoad = false, boxes?: number[][]): boolean {
  for (let i = 0; i < streets.length; i++) {
    const s = streets[i];
    // Bounds of what the street's rules reach (see streetBoxes): skip it when far.
    const q = boxes?.[i];
    if (q && (x < q[0] - r || x > q[2] + r || z < q[1] - r || z > q[3] + r)) continue;
    const d = closestOnPolyline(s.pts, x, z).d;
    if (s.cls === RoadClass.Path) { if (d < s.width / 2 + 0.4 + r) return false; continue; }
    if (!onRoad && d < s.width / 2 + r) return false;
    const walk = s.width / 2 + s.sidewalk / 2;
    if (d < s.width / 2 + s.sidewalk + 1.5 && Math.abs(d - walk) < WALK_CLEAR + r) return false;
  }
  return true;
}

/** Per street the bounds within which clearOfWalk's rules can apply (for a radius r added on top). */
export function streetBoxes(streets: StreetSeg[]): number[][] {
  return streets.map((s) => {
    const [x0, z0, x1, z1] = polyBounds(s.pts);
    const m = s.width / 2 + s.sidewalk + 1.6;
    return [x0 - m, z0 - m, x1 + m, z1 + m];
  });
}

/** Junction centres of the cell (local junctions and arterial nodes). */
export function junctionPoints(plan: CellPlan, cell: CellInfo, macro: MacroPlan): number[] {
  const out: number[] = [];
  for (let i = 0; i < plan.junctions.length; i += 3) out.push(plan.junctions[i], plan.junctions[i + 1]);
  for (const eid of cell.edges) {
    const e = macro.edges[eid];
    for (const nid of [e.a, e.b]) out.push(macro.nodes[nid].x, macro.nodes[nid].z);
  }
  return out;
}

/**
 * Decide the eateries of a cell (BuildingDesc.eatery) and plan their terraces, awnings and menu
 * boards into plan.props / plan.eateries. Parked cars where a parklet goes are removed.
 */
export function placeEateries(plan: CellPlan, cell: CellInfo, macro: MacroPlan, terrain: Terrain): void {
  const seed = terrain.profile.seed;
  const district = cell.district;
  if (district === 'park' || district === 'water') return;
  const B = plan.buildings;
  const doors = B.map((b) => frontDoor(b));
  const junctions = junctionPoints(plan, cell, macro);
  const P = plan.props;
  const E = plan.entrances;
  const open = [...plan.plazas, ...plan.parks];
  const openBox = open.map((s) => polyBounds(s.outer));
  const placed: Item[] = [];
  // Spatial prefilters: building bounds, street reach, a grid of the furniture already there.
  const bb = B.map((b) => polyBounds(b.poly));
  const sbox = streetBoxes(plan.streets);
  const G = 6, grid = new Map<number, number[]>();
  const gk = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
  for (let k = 0; k < P.length; k += 6) {
    const t = P[k];
    if (t === PT.ParkedCar || t === PT.Manhole) continue;
    const key = gk(Math.floor(P[k + 1] / G), Math.floor(P[k + 2] / G));
    let l = grid.get(key);
    if (!l) grid.set(key, (l = []));
    l.push(t, P[k + 1], P[k + 2]);
  }
  const inBuilding = (x: number, z: number, m = 0): boolean => {
    for (let i = 0; i < B.length; i++) {
      const q = bb[i];
      if (x < q[0] - m || x > q[2] + m || z < q[1] - m || z > q[3] + m) continue;
      if (pointInPoly(B[i].poly, x, z) || (m > 0 && distPointPolyEdge(B[i].poly, x, z) < m)) return true;
    }
    return false;
  };

  /** Every rule for a terrace item (see the file comment). */
  const ok = (x: number, z: number, r: number, opt: { onRoad?: boolean; ownDoor?: number; noJunction?: boolean } = {}): boolean => {
    if (!pointInPoly(cell.poly, x, z) || terrain.isWater(x, z, 1)) return false;
    if (inBuilding(x, z, r + 0.05)) return false;
    // (The ways onto a landmark's square stay clear.)
    if (plan.approaches.some((w) => pointInPoly(w, x, z) || distPointPolyEdge(w, x, z) < r)) return false;
    if (!clearOfWalk(plan.streets, x, z, r, opt.onRoad, sbox)) return false;
    for (let k = 0; k < doors.length; k++) {
      const need = k === opt.ownDoor ? 0.75 + r : DOOR_CLEAR + r;
      const dx = doors[k].x - x, dz = doors[k].z - z;
      if (dx * dx + dz * dz < need * need) return false;
    }
    if (!opt.noJunction) for (let k = 0; k < junctions.length; k += 2) if (Math.hypot(junctions[k] - x, junctions[k + 1] - z) < CROSSING_CLEAR) return false;
    for (let k = 0; k < E.length; k += 6) if (Math.hypot(E[k] - x, E[k + 1] - z) < ENTRANCE_L * 0.7 + r + 0.5) return false;
    const i0 = Math.floor((x - r - 5) / G), i1 = Math.floor((x + r + 5) / G), j0 = Math.floor((z - r - 5) / G), j1 = Math.floor((z + r + 5) / G);
    for (let gi = i0; gi <= i1; gi++) for (let gj = j0; gj <= j1; gj++) {
      const l = grid.get(gk(gi, gj));
      if (l) for (let k = 0; k < l.length; k += 3) if (Math.hypot(l[k + 1] - x, l[k + 2] - z) < propR(l[k]) + r) return false;
    }
    for (const it of placed) if (Math.hypot(it.x - x, it.z - z) < it.r + r + 0.05) return false;
    return true;
  };

  B.forEach((b, bi) => {
    if (!b.shopfront) return;
    const poly = b.poly, n = poly.length >> 1;
    const i = b.front % n, j = (i + 1) % n;
    const ax = poly[i * 2], az = poly[i * 2 + 1], bx = poly[j * 2], bz = poly[j * 2 + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 3) return;
    const ux = (bx - ax) / len, uz = (bz - az) / len, nx = uz, nz = -ux;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    // A plaza or park in front of a facade (the front first, then the sides of corner
    // buildings; within 24 m, not behind another building)?
    let openShape: Poly | null = null, openAt = 0;
    const sq = { ax, az, ux, uz, nx, nz, len };
    for (let e = 0; e < n && !openShape && open.length; e++) {
      const i0 = (i + e) % n, j0 = (i0 + 1) % n;
      const ex = poly[j0 * 2] - poly[i0 * 2], ez = poly[j0 * 2 + 1] - poly[i0 * 2 + 1], el = Math.hypot(ex, ez);
      if (el < (e ? 5 : 3)) continue;
      const fx = ez / el, fz = -ex / el, cx = poly[i0 * 2] + ex / 2, cz = poly[i0 * 2 + 1] + ez / 2;
      // Only what the 24 m ray can meet.
      const rx0 = Math.min(cx, cx + fx * 24), rx1 = Math.max(cx, cx + fx * 24), rz0 = Math.min(cz, cz + fz * 24), rz1 = Math.max(cz, cz + fz * 24);
      const meets = (q: number[]) => q[0] <= rx1 && q[2] >= rx0 && q[1] <= rz1 && q[3] >= rz0;
      const os = open.map((_, k) => k).filter((k) => meets(openBox[k]));
      if (!os.length) continue;
      const bs = B.map((_, k) => k).filter((k) => meets(bb[k]));
      for (let k = 0.5; k <= 24 && !openShape; k += 0.5) {
        const x = cx + fx * k, z = cz + fz * k;
        if (k > 1 && bs.some((q) => pointInPoly(B[q].poly, x, z))) break;
        const oi = os.find((q) => pointInPoly(open[q].outer, x, z) && !open[q].holes.some((h) => pointInPoly(h, x, z))) ?? -1;
        if (oi >= 0) {
          openShape = open[oi].outer; openAt = k;
          Object.assign(sq, { ax: poly[i0 * 2], az: poly[i0 * 2 + 1], ux: ex / el, uz: ez / el, nx: fx, nz: fz, len: el });
          break;
        }
      }
    }
    const kind = eateryKind(seed, cell.id, bi, district, b, !!openShape);
    if (kind === Eatery.None) return;
    b.eatery = kind;
    const info = EATERY[kind];
    const r = new Rng(deriveSeed(seed, 'terrace', cell.id, bi));
    const palette = r.int(0, TERRACE_PALETTE.length - 1);
    const at = (u: number, v: number): [number, number] => [ax + ux * u + nx * v, az + uz * u + nz * v];
    const bays = Math.max(1, Math.round(len / b.bay));
    const uDoor = (doorBayOf(b.seed, bays) + 0.5) * (len / bays);
    const ep: EateryPlan = { b: bi, kind, terrace: TerraceKind.None, ax, az, ux, uz, nx, nz, len, door: [doors[bi].x, doors[bi].z], tables: [], seats: [], awnings: [], palette };
    // The street the front faces: nearest centreline straight out of the facade.
    let st: StreetSeg | null = null, sd = Infinity, sc: ReturnType<typeof closestOnPolyline> | null = null;
    for (const s of plan.streets) {
      if (s.cls === RoadClass.Path) continue;
      const c = closestOnPolyline(s.pts, mx, mz);
      if (c.d < 1e-3 || ((c.px - mx) * nx + (c.pz - mz) * nz) / c.d < 0.6) continue;
      if (c.d < sd) { sd = c.d; st = s; sc = c; }
    }
    const gap = st ? sd - st.width / 2 : Infinity; // facade → kerb
    const walkGap = st ? sd - st.width / 2 - st.sidewalk / 2 : Infinity; // facade → walking line
    const vMax = Math.min(3.4, walkGap - WALK_CLEAR - 0.05); // terrace depth on the sidewalk
    const distMul = district === 'oldtown' ? 1.15 : district === 'suburban' ? 0.85 : district === 'industrial' || district === 'port' ? 0.6 : 1;
    const items: Item[] = [];
    const seats: number[] = [], tables: number[] = [];
    /** A table with chairs at the given offsets (facing it); all or nothing. */
    const table = (x: number, z: number, chairs: [number, number][], tableV: number, chairV: number, opt: Parameters<typeof ok>[3] = {}): boolean => {
      const list: Item[] = [{ t: PT.CafeTable, x, z, yaw: r.range(0, 0.2), s: 1, v: palette * 2 + tableV, r: R_TABLE }];
      for (const [cx, cz] of chairs) list.push({ t: PT.CafeChair, x: cx, z: cz, yaw: Math.atan2(-(x - cx), -(z - cz)) + r.range(-0.15, 0.15), s: 1, v: palette * 2 + chairV, r: R_CHAIR });
      for (const it of list) if (!ok(it.x, it.z, it.r, opt)) return false;
      const ti = tables.length / 3;
      tables.push(x, z, chairs.length);
      for (const it of list) {
        placed.push(it); items.push(it);
        if (it.t === PT.CafeChair) seats.push(it.x, it.z, Math.atan2(-(x - it.x), -(z - it.z)), ti);
      }
      return true;
    };
    const tableV = kind === Eatery.Cafe || kind === Eatery.IceCream || kind === Eatery.Bakery ? 0 : 1; // round bistro / square timber
    const chairV = kind === Eatery.Restaurant || kind === Eatery.Pizzeria || kind === Eatery.Bar ? 1 : 0;
    const want = r.float() < info.terraceP * distMul;
    // ---------------------------------------------------------------- square terrace
    if (want && openShape && openAt < 24 && r.chance(0.9)) {
      const sat = (u: number, v: number): [number, number] => [sq.ax + sq.ux * u + sq.nx * v, sq.az + sq.uz * u + sq.nz * v];
      let v0 = -1;
      for (let k = Math.max(0.5, openAt); k <= openAt + 6; k += 0.25) {
        const [x, z] = sat(sq.len / 2, k);
        if (pointInPoly(openShape, x, z) && distPointPolyEdge(openShape, x, z) > 1.3) { v0 = k; break; }
      }
      if (v0 > 0) {
        const W = Math.min(sq.len + 4, 16), depth = r.range(4.5, 9);
        const pu = 2.5, pv = 2.5;
        const nu = Math.max(1, Math.min(5, Math.floor(W / pu))), nv = Math.max(1, Math.min(3, Math.floor(depth / pv)));
        for (let iv = 0; iv < nv; iv++) for (let iu = 0; iu < nu; iu++) {
          const u = sq.len / 2 + (iu - (nu - 1) / 2) * pu + r.range(-0.15, 0.15), v = v0 + 0.95 + iv * pv + r.range(-0.1, 0.1);
          const [x, z] = sat(u, v);
          if (!pointInPoly(openShape, x, z) || distPointPolyEdge(openShape, x, z) < 1.1) continue;
          const four = r.chance(0.6);
          const off = 0.62;
          const ch: [number, number][] = four
            ? [sat(u - off, v), sat(u + off, v), sat(u, v - off), sat(u, v + off)]
            : r.chance(0.5) ? [sat(u - off, v), sat(u + off, v)] : [sat(u, v - off), sat(u, v + off)];
          if (!ch.every(([cx, cz]) => pointInPoly(openShape!, cx, cz))) continue;
          if (table(x, z, ch, tableV, chairV, { noJunction: true })) {
            const pv0 = { t: PT.Parasol, x, z, yaw: Math.atan2(-sq.nx, -sq.nz), s: 1, v: palette * 2 + (four ? 0 : 1), r: 0.05 };
            items.push(pv0);
          }
        }
        if (tables.length < 6) undo(0);
        else {
          ep.terrace = TerraceKind.Square;
          // Planters at the front corners of the terrace.
          for (const su of [-1, 1]) {
            const u = sq.len / 2 + su * (nu * pu / 2 + 0.3), v = v0 + 0.6;
            const [x, z] = sat(u, v);
            if (pointInPoly(openShape, x, z) && ok(x, z, R_PLANTER, { noJunction: true })) { const it = { t: PT.Planter, x, z, yaw: 0, s: 1, v: 1, r: R_PLANTER }; items.push(it); placed.push(it); }
          }
        }
      }
    }
    // --------------------------------------------------------------- sidewalk terrace
    if (want && ep.terrace === TerraceKind.None && tables.length === 0 && vMax >= 0.85) {
      const deep = vMax >= 1.75;
      const pitch = deep ? 2.3 : 2.15;
      const n0 = tables.length;
      // At most ~10 tables, around the door (a long tower front is not one café).
      const uLo = Math.max(1.0 + (deep ? 0.35 : 0.85), uDoor - pitch * 5.2), uHi = Math.min(len - (deep ? 1.35 : 0.85), uDoor + pitch * 5.2);
      for (let u = uLo; u < uHi; u += pitch) {
        if (Math.abs(u - uDoor) < 1.45) { u += 0.4 - pitch; continue; }
        if (deep) {
          const v = Math.min(vMax / 2, 1.05);
          const four = vMax >= 1.8 && r.chance(0.45);
          const ch: [number, number][] = four ? [at(u - 0.62, v), at(u + 0.62, v), at(u, v - 0.62), at(u, v + 0.62)] : [at(u, v - 0.6), at(u, v + 0.6)];
          const [x, z] = at(u, v);
          if (table(x, z, ch, tableV, chairV) && r.chance(0.6)) items.push({ t: PT.Parasol, x, z, yaw: Math.atan2(-nx, -nz), s: 1, v: palette * 2 + 1, r: 0.05 });
        } else {
          const v = 0.48;
          const [x, z] = at(u, v);
          table(x, z, [at(u - 0.58, v), at(u + 0.58, v)], 0, chairV);
        }
      }
      if (tables.length - n0 >= 3 * 2) {
        ep.terrace = TerraceKind.Sidewalk;
        if (vMax >= 1.0) {
          // Planters close the terrace off at both ends.
          let u0 = Infinity, u1 = -Infinity;
          for (let k = 0; k < tables.length; k += 3) {
            const u = (tables[k] - ax) * ux + (tables[k + 1] - az) * uz;
            u0 = Math.min(u0, u); u1 = Math.max(u1, u);
          }
          for (const u of [u0 - (deep ? 1.25 : 1.15), u1 + (deep ? 1.25 : 1.15)]) {
            const [x, z] = at(u, Math.min(0.5, vMax - R_PLANTER));
            if (u > 0.4 && u < len - 0.4 && ok(x, z, R_PLANTER)) { const it = { t: PT.Planter, x, z, yaw: 0, s: 1, v: 1, r: R_PLANTER }; items.push(it); placed.push(it); }
          }
        }
      } else {
        // Too few tables to make a terrace: take them back.
        undo(n0);
      }
    }
    // ------------------------------------------------------------------- parklet
    if (want && ep.terrace === TerraceKind.None && tables.length === 0 && st && sc && st.cls === RoadClass.Street && st.arterial < 0 && gap < 5) {
      const Ls = polylineLength(st.pts);
      const nMod = Math.min(4, Math.floor((Math.min(len, 11) - 2) / 2));
      const half = nMod + 1; // deck half length (2 m modules + 1 m planter ends)
      if (nMod >= 2 && sc.s - half > 14 && sc.s + half < Ls - 14) {
        const c = pointAt(st.pts, sc.s);
        const qx = (mx - c.x) / sd, qz = (mz - c.z) / sd; // towards the facade
        const lat = st.width / 2 - 0.95;
        const yaw = Math.atan2(-qx, -qz);
        const deck: Item[] = [], rest: Item[] = [];
        let straight = true;
        const mod = (sAlong: number) => {
          const p = pointAt(st!.pts, sc!.s + sAlong);
          if (Math.abs(p.dx * c.dx + p.dz * c.dz) < 0.993) straight = false;
          return { x: p.x + qx * lat, z: p.z + qz * lat };
        };
        for (let k = 0; k < nMod; k++) { const p = mod((k - (nMod - 1) / 2) * 2); deck.push({ t: PT.Parklet, ...p, yaw, s: 1, v: palette * 2, r: 1.0 }); }
        for (const sg of [-1, 1]) { const p = mod(sg * (nMod + 0.5)); deck.push({ t: PT.Parklet, ...p, yaw: sg > 0 ? yaw : yaw + Math.PI, s: 1, v: palette * 2 + 1, r: 0.5 }); }
        // The deck sits on the road: clear of junctions, entrances and other furniture on it.
        const deckOk = straight && deck.every((d) => clearOfWalk(plan.streets, d.x, d.z, d.r + 0.2, true) && junctions.every((_, k) => k % 2 || Math.hypot(junctions[k] - d.x, junctions[k + 1] - d.z) >= CROSSING_CLEAR + 2)
          && P.every((_, k) => k % 6 || P[k] === PT.ParkedCar || P[k] === PT.Manhole || Math.hypot(P[k + 1] - d.x, P[k + 2] - d.z) > propR(P[k]) + 0.9)
          && placed.every((it) => Math.hypot(it.x - d.x, it.z - d.z) > it.r + 0.9));
        if (deckOk) {
          const n0 = tables.length;
          for (let k = 0; k < nMod; k++) {
            const p = mod((k - (nMod - 1) / 2) * 2);
            const ch: [number, number][] = [[p.x + qx * 0.6, p.z + qz * 0.6], [p.x - qx * 0.6, p.z - qz * 0.6]];
            if (table(p.x, p.z, ch, tableV, chairV, { onRoad: true, noJunction: true }) && k % 2 === 0) rest.push({ t: PT.Parasol, x: p.x, z: p.z, yaw, s: 1, v: palette * 2 + 1, r: 0.05 });
            // The rail on the traffic side.
            rest.push({ t: PT.TerraceRail, x: p.x - qx * 0.82, z: p.z - qz * 0.82, yaw, s: 1, v: palette * 2, r: 0.1 });
          }
          if (tables.length - n0 >= 3 * 2) {
            ep.terrace = TerraceKind.Parklet;
            for (const d of deck) { items.push(d); placed.push(d); }
            items.push(...rest);
            // No parking where the deck is.
            const span = half + 3;
            for (let k = P.length - 6; k >= 0; k -= 6) {
              if (P[k] !== PT.ParkedCar) continue;
              const cp = closestOnPolyline(st.pts, P[k + 1], P[k + 2]);
              const sideOk = ((P[k + 1] - cp.px) * qx + (P[k + 2] - cp.pz) * qz) > 0;
              if (sideOk && Math.abs(cp.s - sc.s) < span && cp.d < st.width / 2) P.splice(k, 6);
            }
          } else undo(n0);
        }
      }
    }
    // ------------------------------------------------------------- awnings and menu board
    if (gap > 1.45 && b.groundH >= 3.2 && r.chance(kind === Eatery.Bar ? 0.45 : kind === Eatery.Restaurant ? 0.6 : 0.8)) {
      const top = Math.min(3.05, b.groundH - 0.6); // the name board fits above it
      const proj = 1.3 * top / 3;
      const w = len >= 7 ? 3.2 : 2.4;
      const cnt = Math.min(5, Math.max(1, Math.floor((len - 0.4) / (w + 0.15))));
      if (len >= w + 0.4) {
        const centre = cnt >= 5 ? Math.max((w + 0.15) * 2.5 + 0.2, Math.min(len - (w + 0.15) * 2.5 - 0.2, uDoor)) : len / 2;
        const sw = top / 3;
        const list: Item[] = [];
        for (let k = 0; k < cnt; k++) {
          const u = centre + (k - (cnt - 1) / 2) * (w * sw + 0.15);
          const [x, z] = at(u, 0.02);
          list.push({ t: PT.Awning, x, z, yaw: Math.atan2(-nx, -nz), s: sw, v: palette * 2 + (w > 3 ? 1 : 0), r: 0 });
        }
        // Clear of lamps, trees and signals under it.
        // Each one clear of the lamp posts, tree trunks and signals under it.
        const clear = list.filter((a) => {
          for (let k = 0; k < P.length; k += 6) {
            const t = P[k];
            if (t !== PT.Tree && t !== PT.Lamp && t !== PT.TrafficLight && t !== PT.StopSign && t !== PT.BusStop) continue;
            const du = (P[k + 1] - a.x) * ux + (P[k + 2] - a.z) * uz, dv = (P[k + 1] - a.x) * nx + (P[k + 2] - a.z) * nz;
            if (dv > -0.3 && Math.abs(du) < w * sw / 2 + 0.5 && dv < proj + 0.35) return false;
          }
          return true;
        });
        for (const a of clear) {
          items.push(a);
          ep.awnings.push((a.x - ax) * ux + (a.z - az) * uz, w * sw, top);
        }
      }
    }
    if (walkGap - WALK_CLEAR >= 0.55) {
      // A-board menu beside the door, its faces turned to the passers-by.
      for (const su of [1, -1]) {
        const [x, z] = at(uDoor + su * 1.25, 0.3);
        if (uDoor + su * 1.25 < 0.4 || uDoor + su * 1.25 > len - 0.4 || !ok(x, z, 0.25, { ownDoor: bi })) continue;
        const it = { t: PT.MenuBoard, x, z, yaw: Math.atan2(-ux, -uz), s: 1, v: kind === Eatery.Bar || kind === Eatery.Restaurant ? 1 : 0, r: 0.25 };
        items.push(it); placed.push(it);
        break;
      }
    }
    for (const it of items) P.push(it.t, it.x, it.z, it.yaw, it.s, it.v);
    ep.tables = tables;
    ep.seats = seats;
    plan.eateries.push(ep);

    function undo(n0: number): void {
      const drop = new Set<Item>();
      const keepT = n0 / 3;
      for (let k = n0; k < tables.length; k += 3) {
        for (const it of items) if (Math.hypot(it.x - tables[k], it.z - tables[k + 1]) < 1.0 && (it.t === PT.CafeTable || it.t === PT.CafeChair || it.t === PT.Parasol)) drop.add(it);
      }
      tables.length = n0;
      for (let k = seats.length - 4; k >= 0; k -= 4) if (seats[k + 3] >= keepT) seats.splice(k, 4);
      for (let k = items.length - 1; k >= 0; k--) if (drop.has(items[k])) items.splice(k, 1);
      for (let k = placed.length - 1; k >= 0; k--) if (drop.has(placed[k])) placed.splice(k, 1);
    }
  });
}
