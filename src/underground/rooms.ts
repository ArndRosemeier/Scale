/**
 * Side rooms off the sewers and the metro tunnels, and the hidden chambers a few of them lead
 * to (pure data, deterministic per seed; drawn by RoomMeshes, inhabited by Slimes).
 *
 *  - A room opens off its host tube through a doorway cut into the tube's wall: a short door
 *    box (overlapping the tube so the walker passes) and the main room behind it. Rooms keep
 *    clear of every other tube, station hall and room, stay under the ground (sewer rooms under
 *    their street: basements are not modelled) and away from the stations and their entrances.
 *  - Colonies: 2–5 per city, far down. A gap in the back wall of a side room leads into a rough
 *    crawl passage that sinks to a chamber at depth.
 *  - Traces: a few rooms near a colony (and the room with the gap) get a faint glowing trail.
 */
import { Rng, deriveSeed } from '../core/rng';
import type { MacroPlan } from '../plan/types';
import type { Terrain } from '../world/terrain';
import { makeBox, makeTube, tubeAt, type Box, type Tube, type Platform } from './Volumes';
import { pointOnTube, SEWER_H } from './layout';

export type SewerRoomKind = 'alcove' | 'overflow' | 'cistern' | 'pump' | 'collapsed' | 'bricked';
export type MetroRoomKind = 'niche' | 'cross' | 'staff' | 'ghost' | 'vent' | 'electrical' | 'storage';
export type RoomKind = SewerRoomKind | MetroRoomKind;

/** Main room depth (along u), half width (v), height; door half width, length, top; floor drop; weight. */
interface Spec { depth: number; hv: number; h: number; dhv: number; dl: number; top: number; drop?: number; w: number }

/** Top of a doorway in a sewer wall: the springing plus the first piece of the vault (cut out whole). */
export const SEWER_DOOR_TOP = 1.6 + Math.sin(Math.PI / 8) * (SEWER_H - 1.6) + 0.002;

const SPECS: Record<RoomKind, Spec> = {
  alcove: { depth: 1.8, hv: 1.3, h: 2.3, dhv: 1.3, dl: 0.25, top: SEWER_DOOR_TOP, w: 3 },
  overflow: { depth: 4.5, hv: 3.2, h: 3.2, dhv: 0.7, dl: 1.0, top: SEWER_DOOR_TOP, w: 2 },
  cistern: { depth: 6.5, hv: 5.5, h: 3.3, dhv: 0.7, dl: 1.0, top: SEWER_DOOR_TOP, drop: 1.0, w: 2 },
  pump: { depth: 4.5, hv: 3, h: 3.0, dhv: 0.7, dl: 1.0, top: SEWER_DOOR_TOP, w: 2 },
  collapsed: { depth: 7, hv: 0.9, h: 2.3, dhv: 0.9, dl: 0.3, top: SEWER_DOOR_TOP, w: 2 },
  bricked: { depth: 3.5, hv: 2, h: 2.4, dhv: 0.45, dl: 0.6, top: 1.75, w: 1.5 },
  niche: { depth: 1.6, hv: 1.6, h: 2.8, dhv: 1.6, dl: 0.25, top: 2.8, w: 3 },
  cross: { depth: 6, hv: 0.8, h: 2.5, dhv: 0.8, dl: 0.25, top: 2.5, w: 2 },
  staff: { depth: 4.5, hv: 2.5, h: 2.6, dhv: 0.6, dl: 1.5, top: 2.2, w: 2 },
  ghost: { depth: 4.5, hv: 12.5, h: 4.6, dhv: 0, dl: 0, top: 4.0, w: 1.2 },
  vent: { depth: 6, hv: 3, h: 6, dhv: 0.7, dl: 2.5, top: 2.4, w: 1.2 },
  electrical: { depth: 4, hv: 2.5, h: 2.8, dhv: 0.6, dl: 1.0, top: 2.2, w: 2 },
  storage: { depth: 5, hv: 3, h: 3.0, dhv: 0.7, dl: 1.0, top: 2.3, w: 2 },
};
const SEWER_KINDS: SewerRoomKind[] = ['alcove', 'overflow', 'cistern', 'pump', 'collapsed', 'bricked'];
const METRO_KINDS: MetroRoomKind[] = ['niche', 'cross', 'staff', 'ghost', 'vent', 'electrical', 'storage'];
/** Kinds whose back wall can hide the gap to a colony. */
const GAP_KINDS: RoomKind[] = ['collapsed', 'bricked', 'cistern', 'pump', 'storage', 'cross'];
/** Ghost platform: openings along the tunnel (room-local v ranges), pillars between. */
const GHOST_OPEN: [number, number][] = [[-12.5, -6.5], [-4, 2], [4.5, 10.5]];
/** Ghost platform height over the track bed (as the stations). */
export const GHOST_PLATFORM = 1.05;

export interface Room {
  id: number;
  kind: RoomKind;
  net: 'sewer' | 'metro';
  /** Host tube (index in the tube list given to planRooms = Underground.tubes), arc position, side (±1 of its lateral). */
  tube: number; s: number; side: number;
  seed: number;
  /**
   * Room frame: origin on the host's wall line at the doorway, floor y there; u along the outward
   * normal (nx, nz), v along (-nz, nx). Host half width (centreline at u = -hw).
   */
  ox: number; oz: number; y: number; nx: number; nz: number; hw: number;
  /** Doorways in the host wall (room v ranges, height over y) and the door passage length (u). */
  doors: { v0: number; v1: number; top: number }[];
  dl: number;
  /** Main room: u0..u1, v0..v1, floor y0 (under y by the drop), height h. */
  main: { u0: number; u1: number; v0: number; v1: number; y0: number; h: number };
  /** Wall openings in the host tube: arc ranges, height over the floor. */
  cuts: { s0: number; s1: number; top: number }[];
  /** Collision volumes (door boxes, main box). */
  boxes: Box[];
  /** Gap in the back wall (u = main.u1) to a colony's crawl: centre v, half width, height. */
  gap: { v: number; hw: number; h: number } | null;
  colony: number;
  /** A faint glowing trail (something passed through here). */
  trace: boolean;
  /** Vent rooms: height of the street grate over the shaft (the shaft rises at main u middle + 1, v middle). */
  shaft?: number;
}

export interface Colony {
  id: number;
  /** Room with the gap. */
  room: number;
  seed: number;
  crawl: Tube;
  chamber: Box;
}

export interface RoomPlan { rooms: Room[]; colonies: Colony[] }

/** Room-local (u, v) → world (x, z). */
export function roomW(r: Room, u: number, v: number): [number, number] {
  return [r.ox + r.nx * u - r.nz * v, r.oz + r.nz * u + r.nx * v];
}

/** Spatial grid (cells of GRID m) of tube segments and boxes for the clearance tests. */
const GRID = 16;
type Item = { t: Tube; i: number } | { b: Box };
class Grid {
  private m = new Map<number, Item[]>();
  private add(x0: number, z0: number, x1: number, z1: number, it: Item): void {
    for (let i = Math.floor(x0 / GRID); i <= Math.floor(x1 / GRID); i++) for (let j = Math.floor(z0 / GRID); j <= Math.floor(z1 / GRID); j++) {
      const k = (i + 32768) * 65536 + (j + 32768);
      let l = this.m.get(k);
      if (!l) this.m.set(k, (l = []));
      l.push(it);
    }
  }
  tube(t: Tube): void {
    const P = t.pts, r = t.halfWidth + PAD + 0.5;
    for (let i = 0; i + 5 < P.length; i += 3) this.add(Math.min(P[i], P[i + 3]) - r, Math.min(P[i + 2], P[i + 5]) - r, Math.max(P[i], P[i + 3]) + r, Math.max(P[i + 2], P[i + 5]) + r, { t, i: i / 3 });
  }
  box(b: Box): void { this.add(b.bounds[0] - PAD, b.bounds[1] - PAD, b.bounds[2] + PAD, b.bounds[3] + PAD, { b }); }
  at(x: number, z: number): Item[] | undefined { return this.m.get((Math.floor(x / GRID) + 32768) * 65536 + (Math.floor(z / GRID) + 32768)); }
}

interface Env {
  terrain: Terrain;
  grid: Grid;
  halls: Box[];
}

/** Volumes to test: a box or a crawl tube (from/to arc); things it may touch; only one tube to test against. */
interface Vol { box?: Box; tube?: Tube; s0?: number; s1?: number; skipTubes?: Tube[]; skipBoxes?: Box[]; only?: Tube }

const PAD = 0.3;

function boxSamples(b: Box, fn: (x: number, y: number, z: number) => boolean): boolean {
  const nu = Math.max(1, Math.ceil((2 * (b.hu + PAD)) / 1.2)), nv = Math.max(1, Math.ceil((2 * (b.hv + PAD)) / 1.2));
  const ys = [b.y0 - 0.35, (b.y0 + b.y1) / 2, b.y1 + 0.35];
  for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
    const u = -b.hu - PAD + (2 * (b.hu + PAD) * i) / nu, v = -b.hv - PAD + (2 * (b.hv + PAD) * j) / nv;
    const x = b.cx + b.ux * u - b.uz * v, z = b.cz + b.uz * u + b.ux * v;
    for (const y of ys) if (fn(x, y, z)) return true;
  }
  return false;
}

function tubeSamples(t: Tube, s0: number, s1: number, fn: (x: number, y: number, z: number) => boolean): boolean {
  for (let s = s0; s <= s1; s += 0.8) {
    const p = pointOnTube(t, s);
    if (!p) continue;
    for (const l of [-t.halfWidth - PAD, 0, t.halfWidth + PAD]) {
      const x = p.x - p.dz * l, z = p.z + p.dx * l;
      for (const y of [p.y - 0.35, p.y + t.height / 2, p.y + t.height + 0.35]) if (fn(x, y, z)) return true;
    }
  }
  return false;
}

/** Inside segment i of a tube (with its walls: PAD around, its channel under the floor)? */
function inSeg(t: Tube, i: number, x: number, y: number, z: number): boolean {
  const P = t.pts, k = i * 3;
  const ax = P[k], ay = P[k + 1], az = P[k + 2], dx = P[k + 3] - ax, dz = P[k + 5] - az, l2 = dx * dx + dz * dz;
  const f = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
  if (Math.hypot(x - ax - dx * f, z - az - dz * f) > t.halfWidth + PAD) return false;
  const floor = ay + (P[k + 4] - ay) * f;
  return y > floor - 0.5 - PAD && y < floor + t.height + PAD;
}

function inBox(b: Box, x: number, y: number, z: number): boolean {
  if (y < b.y0 - 0.5 - PAD || y > b.y1 + PAD) return false;
  const dx = x - b.cx, dz = z - b.cz;
  return Math.abs(dx * b.ux + dz * b.uz) < b.hu + PAD && Math.abs(-dx * b.uz + dz * b.ux) < b.hv + PAD;
}

/** Does a volume cut through anything in the environment (tubes, halls, rooms, crawls, chambers)? */
function blocked(env: Env, v: Vol): boolean {
  const hit = (x: number, y: number, z: number) => {
    const L = env.grid.at(x, z);
    if (!L) return false;
    for (const it of L) {
      if ('t' in it) {
        if (v.only ? it.t !== v.only : v.skipTubes?.includes(it.t)) continue;
        if (inSeg(it.t, it.i, x, y, z)) return true;
      } else if (!v.only && !v.skipBoxes?.includes(it.b) && inBox(it.b, x, y, z)) return true;
    }
    return false;
  };
  return v.box ? boxSamples(v.box, hit) : tubeSamples(v.tube!, v.s0 ?? 0, v.s1 ?? v.tube!.cum[v.tube!.cum.length - 1], hit);
}

/** Covered by `cover` m of ground everywhere over the box, and not under water. */
function covered(terrain: Terrain, b: Box, cover: number, radius = 0): boolean {
  for (const [su, sv] of [[0, 0], [-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const u = su * (b.hu + PAD), v = sv * (b.hv + PAD);
    const x = b.cx + b.ux * u - b.uz * v, z = b.cz + b.uz * u + b.ux * v;
    if (b.y1 + cover > lowGround(terrain, x, z, radius) || terrain.isWater(x, z, 6)) return false;
  }
  return true;
}

/**
 * Lowest ground at (x, z) and on a ring of the radius around it: a building's base sits at the
 * lowest ground of its footprint, so on a slope its foundations reach below the ground beside it.
 */
function lowGround(terrain: Terrain, x: number, z: number, radius: number): number {
  let g = terrain.height(x, z);
  if (radius > 0) for (let k = 0; k < 8; k++) g = Math.min(g, terrain.height(x + Math.cos((k * Math.PI) / 4) * radius, z + Math.sin((k * Math.PI) / 4) * radius));
  return g;
}

/** Chambers: soil over them (m), below the lowest ground within the radius (m). */
const CHAMBER_COVER = 2.5, CHAMBER_R = 32;

/**
 * Side rooms and colonies of a city. `tubes` are the metro tubes (one per line, in line order)
 * followed by the sewer tubes (one per macro.sewers entry), as Underground builds them; `halls`
 * the station halls.
 */
export function planRooms(macro: MacroPlan, terrain: Terrain, tubes: Tube[], halls: Box[]): RoomPlan {
  const seed = macro.seed;
  const rooms: Room[] = [], colonies: Colony[] = [];
  const env: Env = { terrain, grid: new Grid(), halls };
  for (const t of tubes) env.grid.tube(t);
  for (const h of halls) env.grid.box(h);
  // Street half widths over the sewers (sewers run under every arterial that is not a bridge).
  const streets = macro.edges.filter((e) => !e.bridge).map((e) => e.width / 2 + e.sidewalk);
  const nMetro = macro.metroLines.length;
  tubes.forEach((t, ti) => {
    if (t.kind !== 'metro' && t.kind !== 'sewer') return;
    const sewer = t.kind === 'sewer';
    const total = t.cum[t.cum.length - 1];
    const rng = new Rng(deriveSeed(seed, 'rooms', ti));
    const kinds: RoomKind[] = sewer ? SEWER_KINDS : METRO_KINDS;
    const street = sewer ? streets[ti - nMetro] ?? 8 : Infinity;
    for (let s = rng.range(25, 140); s < total - (sewer ? 14 : 45); s += sewer ? rng.range(240, 520) : rng.range(160, 320)) {
      if (!sewer && s < 45) continue;
      // Clear of the manhole ladders (every 45 m from 22.5 m on).
      let sc = s;
      if (sewer) { const m = (((sc - 22.5) % 45) + 45) % 45; if (m < 4 || m > 41) sc += m < 4 ? 4 - m : 49 - m; }
      const first = rng.weighted(kinds, (k) => SPECS[k].w);
      const order = [first, ...kinds.filter((k) => k !== first && SPECS[k].depth < 2.5)];
      const side0 = rng.sign();
      const rs = rng.nextU32();
      let done = false;
      for (const kind of order) {
        for (const side of [side0, -side0]) {
          const r = tryRoom(env, t, ti, sc, side, kind, street, rooms.length, rs);
          if (!r) continue;
          rooms.push(r);
          for (const b of r.boxes) env.grid.box(b);
          done = true;
          break;
        }
        if (done) break;
      }
    }
  });
  placeColonies(env, macro, rooms, colonies);
  return { rooms, colonies };
}

function tryRoom(env: Env, t: Tube, ti: number, s: number, side: number, kind: RoomKind, street: number, id: number, rs: number): Room | null {
  const sp = SPECS[kind], sewer = t.kind === 'sewer';
  const p = pointOnTube(t, s);
  if (!p) return null;
  // Away from the stations (their halls and entrance passages).
  for (const h of env.halls) if (Math.hypot(h.cx - p.x, h.cz - p.z) < h.hu + 70) return null;
  const hw = t.halfWidth;
  const nx = -p.dz * side, nz = p.dx * side;
  const ox = p.x + nx * hw, oz = p.z + nz * hw, y = p.y;
  const rng = new Rng(rs ^ deriveSeed(id, kind));
  const doors = kind === 'ghost' ? GHOST_OPEN.map(([v0, v1]) => ({ v0, v1, top: sp.top })) : [{ v0: -sp.dhv, v1: sp.dhv, top: sp.top }];
  // Main room, shifted sideways a little (the doorway off its middle).
  const slack = Math.max(0, sp.hv - sp.dhv - 0.4);
  const voff = kind === 'ghost' ? 0 : rng.range(-slack, slack);
  const main = { u0: sp.dl, u1: sp.dl + sp.depth, v0: voff - sp.hv, v1: voff + sp.hv, y0: y - (sp.drop ?? 0), h: sp.h + (sp.drop ?? 0) };
  const r: Room = { id, kind, net: sewer ? 'sewer' : 'metro', tube: ti, s, side, seed: rng.nextU32(), ox, oz, y, nx, nz, hw, doors, dl: sp.dl, main, cuts: [], boxes: [], gap: null, colony: -1, trace: false };
  // The host runs straight and level along the doorways (the wall line is a plane there).
  const vs = doors.flatMap((d) => [d.v0, d.v1]), va = Math.min(...vs), vb = Math.max(...vs);
  for (let v = va; v <= vb + 1e-6; v += Math.max(0.5, (vb - va) / 8)) {
    const q = pointOnTube(t, s - side * v);
    if (!q) return null;
    const u = (q.x - ox) * nx + (q.z - oz) * nz;
    if (Math.abs(u + hw) > 0.15 || Math.abs(q.y - y) > 0.12) return null;
  }
  for (const d of doors) {
    const a = s - side * d.v0, b = s - side * d.v1;
    r.cuts.push({ s0: Math.min(a, b), s1: Math.max(a, b), top: d.top });
  }
  // Collision volumes: the door boxes reach 0.75 into the host (the walker crosses over), the main box behind.
  const angle = Math.atan2(nz, nx);
  const mk = (u0: number, u1: number, v0: number, v1: number, y0: number, y1: number, plats: Platform[] = []) => {
    const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
    const [cx, cz] = roomW(r, uc, vc);
    // Platforms come in room-local coordinates; boxes use their own centre.
    const pl = plats.map((q): Platform => (q.length === 3 ? [q[0] - vc, q[1] - vc, q[2]] : [q[0] - vc, q[1] - vc, q[2], q[3] - uc, q[4] - uc]));
    const bx = makeBox('room', cx, cz, y0, y1, angle, (u1 - u0) / 2, (v1 - v0) / 2, pl);
    bx.room = id;
    return bx;
  };
  for (const d of doors) r.boxes.push(mk(-0.75, sp.dl + 0.3, d.v0, d.v1, y, y + d.top));
  const plats: Platform[] = [];
  if (sp.drop) {
    // A landing inside the door, then steps down to the lowered floor.
    const n = 4, rise = sp.drop / n;
    plats.push([main.v0, main.v1, sp.drop, main.u0 - 0.1, main.u0 + 1.4]);
    for (let k = 1; k < n; k++) plats.push([main.v0, main.v1, sp.drop - rise * k, main.u0 + 1.4 + (k - 1) * 0.32, main.u0 + 1.4 + k * 0.32]);
  }
  if (kind === 'ghost') {
    // The old platform along the whole room, steps up from the track bed in the first opening.
    plats.push([main.v0, main.v1, GHOST_PLATFORM, -0.01, main.u1]);
    const [s0] = GHOST_OPEN[0];
    for (let k = 0; k < 5; k++) plats.push([s0, s0 + 2.2, (GHOST_PLATFORM * (k + 1)) / 6, k * 0.3 - 0.01, (k + 1) * 0.3]);
  }
  const mainBox = mk(kind === 'ghost' ? -0.75 : main.u0, main.u1, main.v0, main.v1, main.y0, main.y0 + main.h, plats);
  r.boxes.push(mainBox);
  // Clear of everything: the door boxes may overlap their host, the main box may not.
  // (The main box only off its front strip: it starts at or near the wall line.)
  for (const b of r.boxes) {
    if (blocked(env, { box: b, skipTubes: [t], skipBoxes: r.boxes })) return null;
    if (!covered(env.terrain, b, sewer ? 0.9 : 2)) return null;
  }
  if (blocked(env, { box: shrunk(mainBox, 0.7 - (kind === 'ghost' ? -0.75 : main.u0)), only: t })) return null;
  // The vent's shaft up to the street must be clear too.
  if (kind === 'vent') {
    const [cx, cz] = roomW(r, (main.u0 + main.u1) / 2 + 1, voff);
    const g = env.terrain.height(cx, cz);
    const shaft = makeBox('room', cx, cz, main.y0 + main.h, g - 0.6, angle, 1.2, 1.2);
    if (blocked(env, { box: shaft, skipBoxes: r.boxes })) return null;
    r.shaft = g - 0.6;
  }
  // Sewer rooms stay under their street.
  if (sewer && Number.isFinite(street)) {
    for (const [u, v] of [[main.u1, main.v0], [main.u1, main.v1]]) {
      const [x, z] = roomW(r, u, v);
      if (!tubeAt(t, x, 0, z, street - hw, true)) return null;
    }
  }
  return r;
}

/** The part of a box beyond u0 + cut (its front strip, inside the host, left out). */
function shrunk(b: Box, cut: number): Box {
  const out = makeBox('room', b.cx + b.ux * cut / 2, b.cz + b.uz * cut / 2, b.y0, b.y1, Math.atan2(b.uz, b.ux), b.hu - cut / 2, b.hv, b.platforms);
  return out;
}

const COLONY_HU = 7, COLONY_HV = 5.5, COLONY_H = 3.4;
export const CRAWL_HW = 0.6, CRAWL_H = 2.1;

/** Hidden chambers: through a gap in the back wall of a quiet side room, down a crawl passage. */
function placeColonies(env: Env, macro: MacroPlan, rooms: Room[], colonies: Colony[]): void {
  const rng = new Rng(deriveSeed(macro.seed, 'colonies'));
  const want = Math.min(5, 2 + rng.int(0, 2) + (rooms.length > 260 ? 1 : 0));
  // Farther out first (with a random spread), never two colonies close together.
  const cand = rooms.filter((r) => GAP_KINDS.includes(r.kind)).map((r) => ({ r, k: rng.range(0.4, 1) * (200 + Math.hypot(r.ox, r.oz)) }));
  cand.sort((a, b) => b.k - a.k);
  for (const { r } of cand) {
    if (colonies.length >= want) break;
    if (colonies.some((c) => Math.hypot(c.chamber.cx - r.ox, c.chamber.cz - r.oz) < 500)) continue;
    const c = tryColony(env, r, colonies.length, rng.nextU32());
    if (!c) continue;
    colonies.push(c);
    env.grid.tube(c.crawl);
    env.grid.box(c.chamber);
  }
  // Traces: the nearest few rooms around each colony, and now and then one anywhere.
  for (const c of colonies) {
    rooms.filter((r) => r.colony < 0).map((r) => ({ r, d: Math.hypot(r.ox - c.chamber.cx, r.oz - c.chamber.cz) }))
      .filter((o) => o.d < 350).sort((a, b) => a.d - b.d).slice(0, 4).forEach((o) => { o.r.trace = true; });
  }
  for (const r of rooms) if (r.colony < 0 && rng.chance(0.03)) r.trace = true;
}

function tryColony(env: Env, r: Room, id: number, seed: number): Colony | null {
  const rng = new Rng(seed);
  const m = r.main, sewer = r.net === 'sewer';
  // The room's lowest floor reaches its back wall.
  const fy = m.y0;
  for (let attempt = 0; attempt < 10; attempt++) {
    // (Clear of the props along the side walls: shelves, crates, risers.)
    const gm = Math.min(1.4, (m.v1 - m.v0) / 2), gv = rng.range(m.v0 + gm, m.v1 - gm);
    const a1 = rng.range(-0.9, 0.9), a2 = a1 + rng.range(-0.5, 0.5);
    const drop = sewer ? rng.range(3.5, 6.5) : rng.range(-0.5, 1.5);
    const L1 = rng.range(8, 12), L2 = rng.range(6, 9);
    const [x0, z0] = roomW(r, m.u1 - 1.0, gv), [x1, z1] = roomW(r, m.u1 + 1.6, gv);
    // Turn away from the room's normal by a1, then a2.
    const ang0 = Math.atan2(r.nz, r.nx);
    const d1x = Math.cos(ang0 + a1), d1z = Math.sin(ang0 + a1), d2x = Math.cos(ang0 + a2), d2z = Math.sin(ang0 + a2);
    const x2 = x1 + d1x * L1, z2 = z1 + d1z * L1, x3 = x2 + d2x * L2, z3 = z2 + d2z * L2;
    const y3 = fy - drop;
    const pts = [x0, fy, z0, x1, fy, z1, x2, fy - drop * 0.55, z2, x3, y3, z3, x3 + d2x * 1.6, y3, z3 + d2z * 1.6];
    // Gentle enough to walk (≤ 0.45 rise per metre).
    if (Math.abs(drop * 0.55) / L1 > 0.45 || Math.abs(drop * 0.45) / L2 > 0.45) continue;
    const crawl = makeTube('crawl', pts, CRAWL_HW, CRAWL_H);
    const cx = x3 + d2x * (COLONY_HU - 1.2), cz = z3 + d2z * (COLONY_HU - 1.2);
    const chamber = makeBox('room', cx, cz, y3, y3 + COLONY_H, Math.atan2(d2z, d2x), COLONY_HU, COLONY_HV);
    chamber.colony = id;
    if (!covered(env.terrain, chamber, CHAMBER_COVER, CHAMBER_R)) continue;
    const total = crawl.cum[crawl.cum.length - 1];
    if (blocked(env, { tube: crawl, s0: 2.0, s1: total - 2.6, skipBoxes: r.boxes })) continue;
    // The crawl stays under the ground too (past the room: under the lowest ground around).
    let shallow = false;
    for (let s = 0; s <= total; s += 1) { const p = pointOnTube(crawl, s); if (p && p.y + CRAWL_H + 1.2 > lowGround(env.terrain, p.x, p.z, s < 3 ? 0 : 20)) shallow = true; }
    if (shallow) continue;
    if (blocked(env, { box: chamber, skipTubes: [crawl] })) continue;
    r.gap = { v: gv, hw: CRAWL_HW - 0.05, h: CRAWL_H - 0.15 };
    r.colony = id;
    r.trace = true;
    return { id, room: r.id, seed: rng.nextU32(), crawl, chamber };
  }
  return null;
}

/**
 * Conflicts of a plan (for the self test): volumes of rooms and chambers cutting into each
 * other, the tubes (other than a door's host) or the station halls, or not under the ground.
 */
export function roomConflicts(plan: RoomPlan, terrain: Terrain, tubes: Tube[], halls: Box[], extra: Tube[] = []): { cuts: number; uncovered: number } {
  let cuts = 0, uncovered = 0;
  const env: Env = { terrain, grid: new Grid(), halls };
  for (const t of [...tubes, ...extra]) env.grid.tube(t);
  for (const h of halls) env.grid.box(h);
  for (const r of plan.rooms) for (const b of r.boxes) env.grid.box(b);
  for (const c of plan.colonies) { env.grid.tube(c.crawl); env.grid.box(c.chamber); }
  for (const r of plan.rooms) {
    const host = tubes[r.tube], own = plan.colonies.find((c) => c.room === r.id);
    const mainBox = r.boxes[r.boxes.length - 1];
    for (const b of r.boxes) {
      if (blocked(env, { box: b, skipTubes: own ? [host, own.crawl] : [host], skipBoxes: r.boxes })) cuts++;
      if (!covered(terrain, b, r.net === 'sewer' ? 0.9 : 2)) uncovered++;
    }
    if (blocked(env, { box: shrunk(mainBox, 0.7 - (r.kind === 'ghost' ? -0.75 : r.main.u0)), only: host })) cuts++;
  }
  for (const c of plan.colonies) {
    const room = plan.rooms[c.room];
    if (blocked(env, { box: c.chamber, skipTubes: [c.crawl], skipBoxes: [c.chamber] })) cuts++;
    const total = c.crawl.cum[c.crawl.cum.length - 1];
    if (blocked(env, { tube: c.crawl, s0: 2.0, s1: total - 2.6, skipTubes: [c.crawl], skipBoxes: [c.chamber, ...room.boxes] })) cuts++;
    if (!covered(terrain, c.chamber, CHAMBER_COVER, CHAMBER_R)) uncovered++;
  }
  return { cuts, uncovered };
}
