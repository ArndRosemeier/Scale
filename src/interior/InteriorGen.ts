/**
 * Interior layout of one storey: rooms, interior walls with door openings,
 * a stair core, floor finishes and furniture placements. Pure data,
 * deterministic per (building seed, floor). Coordinates are world x/z.
 */
import { Rng } from '../core/rng';
import { minAreaRect, polyArea, pointInPoly, polyCentroid, type Poly, polyBounds } from '../core/geom2';
import { hash32 } from '../core/rng';
import { intersection } from '../core/clip';
import type { BuildingDesc } from '../plan/building';
import { WALLS, FABRIC, WOOD } from './fill/palette';
import { roomArea, type EdgeKind } from './fill/area';
import { Filler, type Item } from './fill/place';
import { homeItems, homeProgram, type HomeRoom } from './fill/home';
import { workItems, workProgram, type Work } from './fill/work';
import { splitStorey, type Program } from './fill/split';

export type RoomType =
  | 'living' | 'bedroom' | 'kitchen' | 'bath' | 'hall' | 'office' | 'meeting' | 'shop' | 'cafe' | 'storage'
  | 'warehouse' | 'nave' | 'lobby' | 'corridor' | 'stairs' | 'parking' | 'arcade'
  // A starship's (fill/starship): round its great hall.
  | 'quarters' | 'lab' | 'mess' | 'lounge' | 'control' | 'gallery'
  // A museum's (fill/museum): galleries round its great hall.
  | 'exhibit';

export type FurnKind =
  | 'bed' | 'bedDouble' | 'wardrobe' | 'nightstand' | 'sofa' | 'armchair' | 'coffeeTable' | 'tvStand' | 'tv' | 'rug'
  | 'diningTable' | 'chair' | 'kitchenRow' | 'fridge' | 'stove' | 'toilet' | 'bathtub' | 'sink' | 'shower'
  | 'desk' | 'officeChair' | 'monitor' | 'meetingTable' | 'shelf' | 'bookshelf' | 'plant' | 'floorLamp' | 'painting'
  | 'counter' | 'shopShelf' | 'rack' | 'cafeTable' | 'barCounter' | 'palletRack' | 'crate' | 'pew' | 'altar' | 'reception' | 'column' | 'clothesStack'
  | 'screen' | 'cooler' | 'mirror' | 'pendant' | 'coatRack' | 'mailboxes' | 'curtain' | 'tallMirror' | 'arcade'
  // A starship's props (built as landmark parts by interior/design/props).
  | 'pod' | 'locker' | 'console' | 'holo' | 'stool' | 'bench' | 'planter' | 'table'
  // A museum's.
  | 'case' | 'statue' | 'bigStatue' | 'seat';

export interface Room {
  type: RoomType;
  /** Polygon (world). */
  poly: Poly;
  floorMat: 'wood' | 'tile' | 'carpet' | 'concrete' | 'stone' | 'marble';
  wallColor: [number, number, number];
}

export interface IWall {
  ax: number; az: number; bx: number; bz: number;
  /** Door openings along the wall: [t0, t1] parameters 0..1. */
  doors: [number, number][];
  /** Lift shaft and stair core walls: never opened up for the way in from the street door. */
  solid?: boolean;
}

export interface Furn {
  kind: FurnKind;
  x: number; z: number; yaw: number;
  /** Size (w along local x, d along local z, h). */
  w: number; d: number; h: number;
  color: [number, number, number];
  /** People can use it: 'sit' | 'sleep' | 'work' | 'stand' */
  /** 'dress': the fitting mirror of a clothes shop (E there opens the character creator). */
  use?: 'sit' | 'sleep' | 'work' | 'stand' | 'dress';
  /** A video game cabinet's game (arcade/games GAMES index). */
  game?: number;
}

/** One flight of stairs: start (bottom) of its centre line, direction, width, run (m along), heights. */
export interface Flight {
  x: number; z: number; dx: number; dz: number; width: number; run: number;
  y0: number; y1: number;
}

/**
 * A building's stair core (planned once from the ground floor, like the lift): a switchback in a
 * band along one side wall at one end of the long axis. Local frame: origin at the near end on the
 * band's centre line, u along the first flight (towards the facade), v across. Lane A (v < 0)
 * climbs the first half storey to a landing at the far end, lane B (v > 0) climbs back to the next
 * floor's near landing; a wall stands between the lanes and along the side open to the stair hall.
 */
export interface StairCore {
  cx: number; cz: number; ux: number; uz: number;
  /** Length (near landing + run + far landing), lane width, gap between the lanes. */
  len: number; w: number; g: number;
  near: number; run: number;
  /** Which side (±1 in v) faces the stair hall (the other is the building's side wall). */
  open: number;
}

/** Core-local (u, v) → world (x, z). */
export function coreP(c: StairCore, u: number, v: number): [number, number] {
  return [c.cx + c.ux * u - c.uz * v, c.cz + c.uz * u + c.ux * v];
}

/** The core's footprint (world polygon), optionally from u0 on. */
export function coreRect(c: StairCore, u0 = 0, m = 0): number[] {
  const b = c.w + c.g / 2;
  return [...coreP(c, u0 - m, -b - m), ...coreP(c, c.len + m, -b - m), ...coreP(c, c.len + m, b + m), ...coreP(c, u0 - m, b + m)];
}

/** Elevator shaft (world coordinates): centre, u axis (doors face +u), half extents. */
export interface LiftShaft {
  cx: number; cz: number; ux: number; uz: number; hu: number; hv: number;
}

/** Corners of the shaft (CCW-agnostic quad), optionally grown by m. */
export function liftRect(l: LiftShaft, m = 0): number[] {
  const vx = -l.uz, vz = l.ux, out: number[] = [];
  for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    out.push(l.cx + l.ux * su * (l.hu + m) + vx * sv * (l.hv + m), l.cz + l.uz * su * (l.hu + m) + vz * sv * (l.hv + m));
  }
  return out;
}

const LIFT_HU = 1.0, LIFT_HV = 1.1, LANDING = 1.8;

/**
 * Where a building's elevator goes (once per building, from the ground-floor footprint):
 * at one end of the long axis, slid inwards until shaft and landing fit the footprint.
 */
export function planLift(b: BuildingDesc, poly: Poly, door: Door | null = null): LiftShaft | null {
  if (b.floors < 2) return null;
  // Never in the way in from the street door (no lift when only that spot fits: the stairs go up).
  return liftAt(b, poly, door && doorWay(poly, door, 2.2, 0.75));
}

function liftAt(b: BuildingDesc, poly: Poly, way: Poly | null): LiftShaft | null {
  const F = new Frame(poly);
  if (F.hu < 3 || F.hv < 1.6) return null;
  // The exact shaft (with margin, corners and edge midpoints) and its landing must be inside.
  const candidate = (u0: number, v: number): LiftShaft => {
    const c = F.P(u0 + LIFT_HU, v);
    return { cx: c[0], cz: c[1], ux: F.ux, uz: F.uz, hu: LIFT_HU, hv: LIFT_HV };
  };
  const fits = (u0: number, v: number) => {
    const r = liftRect(candidate(u0, v), 0.15);
    for (let k = 0; k < 8; k += 2) {
      const n = (k + 2) % 8;
      if (!pointInPoly(poly, r[k], r[k + 1]) || !pointInPoly(poly, (r[k] + r[n]) / 2, (r[k + 1] + r[n + 1]) / 2)) return false;
    }
    for (const dv of [-LIFT_HV, 0, LIFT_HV]) {
      const q = F.P(u0 + LIFT_HU * 2 + LANDING, v + dv);
      if (!pointInPoly(poly, q[0], q[1])) return false;
    }
    return !way || !overlaps(r, way);
  };
  const vOff = Math.max(0, F.hv - LIFT_HV - 0.3);
  for (let inset = 0.15; inset < F.hu - 1; inset += 0.5) {
    for (const v of [vOff, -vOff, 0]) {
      if (fits(-F.hu + inset, v)) return candidate(-F.hu + inset, v);
    }
  }
  return null;
}

/** A street door: its centre on the facade. */
export type Door = { x: number; z: number };

/**
 * The way in behind a street door: a quad `half` to either side of the door centre, from just
 * outside the facade to `depth` m into the storey (along the inward normal of the outline edge
 * nearest the door), or null when the door is not on the outline.
 */
export function doorWay(poly: Poly, door: Door, depth: number, half: number): Poly | null {
  const n = poly.length >> 1;
  let best = Infinity, ex = 0, ez = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[i * 2], az = poly[i * 2 + 1], dx = poly[j * 2] - ax, dz = poly[j * 2 + 1] - az;
    const L2 = dx * dx + dz * dz;
    if (L2 < 1e-6) continue;
    const t = Math.max(0, Math.min(1, ((door.x - ax) * dx + (door.z - az) * dz) / L2));
    const d = Math.hypot(ax + dx * t - door.x, az + dz * t - door.z);
    if (d < best) { best = d; const L = Math.sqrt(L2); ex = dx / L; ez = dz / L; }
  }
  if (best > 1) return null;
  // Inward: the side of the edge the storey lies on.
  let nx = -ez, nz = ex;
  if (!pointInPoly(poly, door.x + nx * (best + 0.3), door.z + nz * (best + 0.3))) { nx = -nx; nz = -nz; }
  const P = (s: number, d: number): [number, number] => [door.x + ex * s + nx * d, door.z + ez * s + nz * d];
  return [...P(-half, -0.3), ...P(half, -0.3), ...P(half, depth), ...P(-half, depth)];
}

/** Do two convex quads overlap? */
function overlaps(a: Poly, b: Poly): boolean {
  const s = intersection([a], [b]);
  return s.some((q) => Math.abs(polyArea(q.outer)) > 0.01);
}

/** Steps no higher than this (m), treads this deep. */
const RISE = 0.175, TREAD = 0.27;

/**
 * Where a building's stairs go (once per building, from the ground floor; null for single storeys
 * and churches): at the end of the long axis away from the lift, along a side wall, as far as
 * the footprint allows. `maxH`: the tallest storey (sizes the flights).
 */
export function planStair(b: BuildingDesc, poly: Poly, lift: LiftShaft | null, maxH: number, door: Door | null = null): StairCore | null {
  if (b.floors < 2 || b.style === 'church') return null;
  // Never in the way in from the street door; where no spot keeps it clear, the first that fits
  // (and planFloor opens up the hall wall in front of the door).
  const way = door && doorWay(poly, door, 2.2, 0.75);
  return (way && stairAt(b, poly, lift, maxH, way)) || stairAt(b, poly, lift, maxH, null);
}

/**
 * Lift and stairs of a building together, both clear of the way in from the street door: when the
 * stairs only keep it clear without the lift, the building goes without the lift.
 */
export function planCores(b: BuildingDesc, poly: Poly, maxH: number, door: Door | null): { lift: LiftShaft | null; stair: StairCore | null } {
  const stairs = b.floors >= 2 && b.style !== 'church';
  // A roomy way in first, then (small and oddly cut houses) narrower ones that still let one walk
  // in. Where even a step inside the door would run into the stairs, the house goes without them
  // (the lift alone takes people up when it fits).
  let liftOnly: LiftShaft | null = null;
  for (const [depth, half] of [[2.2, 0.75], [1.6, 0.5], [1.0, 0.4]]) {
    const way = door && doorWay(poly, door, depth, half);
    if (!way) break;
    const lift = liftAt(b, poly, way);
    if (!stairs) return { lift, stair: null };
    const st = stairAt(b, poly, lift, maxH, way);
    if (st) return { lift, stair: st };
    const alone = lift && stairAt(b, poly, null, maxH, way);
    if (alone) return { lift: null, stair: alone };
    liftOnly ??= lift;
    if (depth === 1) return { lift: liftOnly, stair: null };
  }
  const lift = planLift(b, poly);
  return { lift, stair: planStair(b, poly, lift, maxH) };
}

function stairAt(b: BuildingDesc, poly: Poly, lift: LiftShaft | null, maxH: number, way: Poly | null): StairCore | null {
  const F = new Frame(poly);
  // The end away from the lift (the lift sits at the -u end when there is one).
  const liftEnd = lift ? Math.sign((lift.cx - F.cx) * F.ux + (lift.cz - F.cz) * F.uz) || -1 : 0;
  const lr = lift ? liftRect(lift, LANDING + 0.6) : null;
  // A comfortable core first, then a compact one for narrow houses (narrower, steeper, shorter landings).
  for (const [w, g, near, far, rise, tread, hall] of [[1.1, 0.12, 1.3, 1.25, RISE, TREAD, 1.2], [0.9, 0.08, 1.0, 1.0, 0.19, 0.25, 0.9]]) {
    const run = Math.max(2.2, Math.ceil(maxH / 2 / rise) * tread);
    const len = near + run + far, band = 2 * w + g;
    if (F.hu * 2 < len + hall + 1 || F.hv * 2 < band + 0.5) continue;
    for (const end of liftEnd ? [-liftEnd] : [1, -1]) {
      for (const side of [1, -1]) {
        for (let inset = 0.15; inset < F.hu * 2 - len - hall; inset += 0.5) {
          const uF = end * (F.hu - inset), uN = uF - end * len;
          const vc = side * (F.hv - 0.15 - band / 2);
          const [cx, cz] = F.P(uN, vc);
          const c: StairCore = { cx, cz, ux: end * F.ux, uz: end * F.uz, len, w, g, near, run, open: -side * end };
          const r = coreRect(c, 0, 0.1);
          let ok = true;
          for (let k = 0; k < 8 && ok; k += 2) {
            const n = (k + 2) % 8;
            if (!pointInPoly(poly, r[k], r[k + 1]) || !pointInPoly(poly, (r[k] + r[n]) / 2, (r[k + 1] + r[n + 1]) / 2)) ok = false;
          }
          // Room in front of it for the stair hall.
          const h = coreP(c, -hall, 0);
          if (!pointInPoly(poly, h[0], h[1])) ok = false;
          if (ok && lr) for (let k = 0; k < 8; k += 2) if (pointInPoly(lr, r[k], r[k + 1]) || pointInPoly(r, lr[k], lr[k + 1])) ok = false;
          if (ok && way && overlaps(r, way)) ok = false;
          if (ok) return c;
        }
      }
    }
  }
  return null;
}

/** Does the stair core lie inside a storey's outline? */
export function coreFits(c: StairCore, poly: Poly): boolean {
  const r = coreRect(c, 0, 0.02);
  for (let k = 0; k < r.length; k += 2) if (!pointInPoly(poly, r[k], r[k + 1])) return false;
  return true;
}

export interface FloorPlan {
  floor: number;
  y: number;
  height: number;
  rooms: Room[];
  walls: IWall[];
  furniture: Furn[];
  /** Flights of stairs from this floor up (two per storey), the landing between them. */
  flights: Flight[];
  landings: { poly: number[]; y: number }[];
  /** Opening these flights cut in the slab of the floor above (null: no stairs up). */
  stairHole: number[] | null;
  /** Elevator shaft serving this floor (doors on its +u face), or null. */
  lift: LiftShaft | null;
  /** Ceiling light positions (x, z), and the fixture at each: 0 a flat panel, 1 a pendant lamp, 2 a round ceiling lamp. */
  lights: number[];
  fixtures: number[];
}

/** Local frame (OBB) helper. */
class Frame {
  readonly cx: number; readonly cz: number; readonly ux: number; readonly uz: number; readonly hu: number; readonly hv: number;
  constructor(poly: Poly) {
    const o = minAreaRect(poly);
    let ux = o.ux, uz = o.uz, hu = o.hu, hv = o.hv;
    if (hv > hu) { ux = -o.uz; uz = o.ux; const t = hu; hu = hv; hv = t; }
    this.cx = o.cx; this.cz = o.cz; this.ux = ux; this.uz = uz; this.hu = hu; this.hv = hv;
  }
  P(u: number, v: number): [number, number] {
    return [this.cx + this.ux * u - this.uz * v, this.cz + this.uz * u + this.ux * v];
  }
  rect(u0: number, v0: number, u1: number, v1: number): Poly {
    return [...this.P(u0, v0), ...this.P(u1, v0), ...this.P(u1, v1), ...this.P(u0, v1)];
  }
  get yaw(): number { return Math.atan2(this.ux, this.uz); }
}

/**
 * `stair`: the building's stair core; `up`: stairs from this storey to the next (the core fits
 * both); `below`: stairs arrive from the storey below.
 */
/** Ground-floor shop layout of a building: 0 café (eateries), 1 clothes shop, 2 grocery (see planFloor). */
export function shopKindOf(b: BuildingDesc): number {
  const sk = (b.seed >>> 7) % 9;
  return b.eatery ? 0 : sk % 3 === 0 ? sk + 1 : sk;
}

/** Does the building have a clothes shop (with a fitting mirror) on its ground floor? */
export function isClothesShop(b: BuildingDesc): boolean {
  return (b.shopfront || b.use === 'retail') && b.style !== 'church' && b.use !== 'industrial' && b.use !== 'parking' && shopKindOf(b) % 3 === 1;
}

/** Video game cabinet: width, depth, height; screen and marquee on the front (+z) face (game/Arcade). */
export const CABINET = { w: 1.7, d: 0.9, h: 3.0 };
/** Cabinet colours by game (matching arcade/games GAMES order). */
const CABINET_COLORS: [number, number, number][] = [[0.12, 0.2, 0.42], [0.55, 0.12, 0.1], [0.08, 0.3, 0.14], [0.1, 0.1, 0.12], [0.42, 0.1, 0.4], [0.75, 0.74, 0.7]];
const ARCADE_GAMES = CABINET_COLORS.length;

const arcadeCache = new WeakMap<BuildingDesc, boolean>();
/**
 * Does the building have an arcade (a hall of video game cabinets) on its ground floor? Some
 * general stores in big, plainly rectangular buildings (an irregular or small shop leaves no
 * proper hall: cabinets walled off behind the stairs, or just two of them).
 */
export function isArcade(b: BuildingDesc): boolean {
  let v = arcadeCache.get(b);
  if (v === undefined) {
    v = (b.shopfront || b.use === 'retail') && !b.eatery && b.style !== 'church' && b.use !== 'industrial' && b.use !== 'parking'
      && b.groundH >= 3.6 && shopKindOf(b) % 3 === 2 && hash32(b.seed ^ 0x3a7c11d) % ARCADE_ONE_IN === 0 && b.poly.length <= 12;
    if (v) {
      const r = minAreaRect(b.poly);
      v = Math.min(r.hu, r.hv) >= ARCADE_MIN.hv && Math.max(r.hu, r.hv) >= ARCADE_MIN.hu && Math.abs(polyArea(b.poly)) >= 4 * r.hu * r.hv * 0.93;
    }
    arcadeCache.set(b, v);
  }
  return v;
}
/** One general store in this many (of those big and rectangular enough) is an arcade. */
const ARCADE_ONE_IN = 25;
/** Smallest half sizes of an arcade building (m): long side, short side. */
const ARCADE_MIN = { hu: 9, hv: 5.5 };

export function planFloor(b: BuildingDesc, poly: Poly, floor: number, y: number, height: number, shopKind: number, lift: LiftShaft | null = null, stair: StairCore | null = null, up = false, below = false, door: { x: number; z: number } | null = null): FloorPlan {
  const r = new Rng((b.seed ^ (floor * 0x9e3779b1)) >>> 0);
  const F = new Frame(poly);
  const plan: FloorPlan = { floor, y, height, rooms: [], walls: [], furniture: [], flights: [], landings: [], stairHole: null, lift: null, lights: [], fixtures: [] };
  const area = Math.abs(polyArea(poly));
  const clipRoom = (rect: Poly): Poly | null => {
    const s = intersection([rect], [poly]);
    if (!s.length) return null;
    const q = s.sort((a, b2) => Math.abs(polyArea(b2.outer)) - Math.abs(polyArea(a.outer)))[0].outer;
    return Math.abs(polyArea(q)) > 2 ? q : null;
  };
  const multi = b.floors > 1;
  const { hu, hv } = F;
  // Walls between the stair hall / lift lobby and the rest: a theme that splits the floor itself
  // (fill/split) makes its own; the older layouts below use these.
  const coreWalls: IWall[] = [];
  const ground = floor === 0;
  const use = b.use;
  const style = b.style;
  // Floors divided by the splitter with a theme (fill/split, fill/home, fill/work).
  const work: Work | null = ground && (b.shopfront || use === 'retail') ? (shopKind % 3 === 0 ? 'cafe' : shopKind % 3 === 1 ? 'clothes' : 'grocery') : use === 'office' ? 'office' : null;
  const split: Program | null = style === 'church' || use === 'industrial' || use === 'parking' || (ground && isArcade(b)) ? null
    : work ? workProgram(work, ground) : homeProgram(ground);
  // --- elevator core (multi-storey): shaft + landing at one end of the long axis
  let coreU0 = hu, coreU1 = hu;
  const serves = !!lift && liftRect(lift, 0.05).every((_, k, a) => k % 2 === 1 || pointInPoly(poly, a[k], a[k + 1]));
  if (multi && lift && serves) {
    plan.lift = lift;
    // Shaft walls in the lift's own frame (doors on the +u face).
    const vx = -lift.uz, vz = lift.ux;
    const L = (u: number, v: number): [number, number] => [lift.cx + lift.ux * u + vx * v, lift.cz + lift.uz * u + vz * v];
    const wall = (a: [number, number], b: [number, number], doors: [number, number][]) => plan.walls.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], doors, solid: true });
    const { hu: lu, hv: lv } = lift;
    wall(L(-lu, -lv), L(lu, -lv), []);
    wall(L(-lu, lv), L(lu, lv), []);
    wall(L(-lu, -lv), L(-lu, lv), []);
    const dw = 0.5 / (2 * lv);
    wall(L(lu, -lv), L(lu, lv), [[0.5 - dw, 0.5 + dw]]);
    // Lift lobby in front of the doors, separated from the floor by a wall with a doorway.
    const lob = Math.min(hv, 2.8);
    const front = lu + LANDING;
    const lobby = clipRoom([...L(-lu - 0.6, -lob), ...L(front, -lob), ...L(front, lob), ...L(-lu - 0.6, lob)]);
    if (lobby) plan.rooms.push({ type: 'hall', poly: lobby, floorMat: floor === 0 ? 'marble' : 'tile', wallColor: [0.86, 0.85, 0.82] });
    const [la, lb] = [L(front, -lob), L(front, lob)];
    coreWalls.push({ ax: la[0], az: la[1], bx: lb[0], bz: lb[1], doors: [[0.55, 0.85]] });
    // Rooms start beyond the lobby (in this floor's frame).
    const e = L(front, 0);
    coreU1 = (e[0] - F.cx) * F.ux + (e[1] - F.cz) * F.uz;
    coreU0 = -hu;
    if (Math.abs(lift.ux * F.ux + lift.uz * F.uz) < 0.95) coreU1 = -hu; // rotated frame (setback tier)
  }
  let u0 = plan.lift ? coreU1 : -hu;
  // --- stair core: a stair hall across the end of the floor that holds it
  let uE = hu;
  const st = stair && coreFits(stair, poly) && style !== 'church' ? stair : null;
  // A piece fits when it lies fully inside the storey (with a margin from the walls; edge
  // midpoints too, so nothing reaches across an inner corner of an L-shaped storey) and clear
  // of the stair core and the lift with its landing.
  const fitsStorey = (f: Furn): boolean => {
    const c = Math.cos(f.yaw), sn = Math.sin(f.yaw);
    const w = f.w / 2 + 0.05, d = f.d / 2 + 0.05;
    for (const [lx, lz] of [[-w, -d], [w, -d], [w, d], [-w, d], [0, 0], [0, -d], [w, 0], [0, d], [-w, 0]]) {
      const x = f.x + lx * c + lz * sn, z = f.z - lx * sn + lz * c;
      if (!pointInPoly(poly, x, z)) return false;
    }
    if (st && pointInPoly(coreRect(st, 0, 0.4), f.x, f.z)) return false;
    if (plan.lift) {
      const l = plan.lift;
      const dx = f.x - l.cx, dz = f.z - l.cz;
      const u = dx * l.ux + dz * l.uz, v = -dx * l.uz + dz * l.ux;
      if (u > -l.hu - 0.7 && u < l.hu + LANDING + 0.4 && Math.abs(v) < l.hv + 0.7) return false;
    }
    return true;
  };
  if (st) {
    const r = coreRect(st, -1.4);
    const proj: number[] = [];
    for (let k = 0; k < r.length; k += 2) proj.push((r[k] - F.cx) * F.ux + (r[k + 1] - F.cz) * F.uz);
    const hallFloor: Room['floorMat'] = ground ? 'stone' : 'tile';
    if (split) {
      // Only the core and a landing strip along its open side: the theme gets the rest of the floor.
      const bw = st.w + st.g / 2, v0 = st.open > 0 ? -bw : -bw - 1.2, v1 = st.open > 0 ? bw + 1.2 : bw;
      const hq = clipRoom([...coreP(st, -1.4, v0), ...coreP(st, st.len, v0), ...coreP(st, st.len, v1), ...coreP(st, -1.4, v1)]);
      if (hq) plan.rooms.push({ type: 'stairs', poly: hq, floorMat: hallFloor, wallColor: [0.88, 0.87, 0.83] });
    } else if (proj.reduce((a, q) => a + q, 0) > 0) {
      uE = Math.max(u0 + 3, Math.min(...proj));
      const hq = clipRoom(F.rect(uE, -hv, hu, hv));
      if (hq) plan.rooms.push({ type: 'stairs', poly: hq, floorMat: hallFloor, wallColor: [0.88, 0.87, 0.83] });
      coreWalls.push(lineWall(F, uE, -hv, uE, hv, [[0.42, 0.58]]));
    } else {
      const uS = Math.min(uE - 3, Math.max(...proj));
      const hq = clipRoom(F.rect(-hu, -hv, uS, hv));
      if (hq) plan.rooms.push({ type: 'stairs', poly: hq, floorMat: hallFloor, wallColor: [0.88, 0.87, 0.83] });
      coreWalls.push(lineWall(F, uS, -hv, uS, hv, [[0.42, 0.58]]));
      u0 = Math.max(u0, uS);
    }
    stairsOf(plan, st, y, height, up, below);
  }
  // Rooms furnished by a theme once the walls and doors are final (fill/place).
  const furnish: Room[] = [];
  // (The older layouts below place things against the walls already standing.)
  if (!split) plan.walls.push(...coreWalls);
  // --- choose layout
  if (split) {
    // The theme reserves its big spaces, the rest is cut into rooms (fill/split); stair hall and
    // lift lobby stay as they are.
    const front = frontNormal(b);
    const fixed = plan.rooms.map((q) => ({ type: q.type, poly: q.poly, hub: true }));
    const kept = plan.rooms;
    const S = splitStorey({ poly, fixed, front, solid: plan.walls.filter((w) => w.solid) }, split, r);
    plan.rooms = [];
    for (const [k, sp] of S.spaces.entries()) {
      // The fixed spaces come first, in order (the stair hall may have taken in a scrap of floor).
      if (k < kept.length) { plan.rooms.push({ ...kept[k], poly: sp.poly }); continue; }
      const room: Room = { type: sp.type, poly: sp.poly, ...lookOf(sp.type, ground, r) };
      plan.rooms.push(room);
      furnish.push(room);
    }
    plan.walls.push(...S.walls);
  } else if (style === 'church') {
    plan.rooms.push({ type: 'nave', poly, floorMat: 'stone', wallColor: [0.9, 0.87, 0.8] });
    for (let u = -hu + 3; u < hu - 4; u += 1.1) {
      for (const side of [-1, 1]) {
        const p = F.P(u, side * Math.min(hv * 0.45, 3));
        plan.furniture.push({ kind: 'pew', x: p[0], z: p[1], yaw: F.yaw + Math.PI / 2, w: Math.min(hv * 0.7, 4.5), d: 0.5, h: 0.9, color: WOOD[2], use: 'sit' });
      }
    }
    const al = F.P(uE - 2, 0);
    plan.furniture.push({ kind: 'altar', x: al[0], z: al[1], yaw: F.yaw, w: 2.4, d: 1, h: 1.05, color: [0.85, 0.82, 0.75] });
  } else if (use === 'industrial' || use === 'parking') {
    plan.rooms.push({ type: use === 'parking' ? 'parking' : 'warehouse', poly: clipRoom(F.rect(u0, -hv, uE, hv)) ?? poly, floorMat: 'concrete', wallColor: [0.75, 0.75, 0.74] });
    for (let u = u0 + 3; u < uE - 2; u += use === 'parking' ? 8 : 4.2) {
      for (let v = -hv + 2; v < hv - 1; v += use === 'parking' ? 8 : 3.5) {
        const p = F.P(u, v);
        if (use === 'parking') plan.furniture.push({ kind: 'column', x: p[0], z: p[1], yaw: 0, w: 0.5, d: 0.5, h: height, color: [0.7, 0.7, 0.7] });
        else if (r.chance(0.7)) plan.furniture.push({ kind: r.chance(0.6) ? 'palletRack' : 'crate', x: p[0], z: p[1], yaw: F.yaw, w: 2.6, d: 1.1, h: r.range(1.2, 3.5), color: [0.35, 0.4, 0.5] });
      }
    }
  } else if (ground && isArcade(b)) {
    // Arcade: one dim hall, video game cabinets along the walls facing in, and back-to-back
    // islands down the middle where the hall is deep enough. The games go round in turn.
    const hall = clipRoom(F.rect(u0, -hv, uE, hv));
    plan.rooms.push({ type: 'arcade', poly: hall ?? poly, floorMat: 'carpet', wallColor: [0.17, 0.14, 0.26] });
    const { w: CW, d: CD, h: CH } = CABINET;
    const stairPoly = st ? coreRect(st, 0, 0.4) : null;
    const gaps: [number, number][] = [];
    for (const w of plan.walls) for (const [t0, t1] of w.doors) for (const t of [t0, (t0 + t1) / 2, t1]) gaps.push([w.ax + (w.bx - w.ax) * t, w.az + (w.bz - w.az) * t]);
    const standSpot = (f: Furn): [number, number] => [f.x + Math.sin(f.yaw) * (CD / 2 + 0.8), f.z + Math.cos(f.yaw) * (CD / 2 + 0.8)];
    const inFootprint = (f: Furn, x: number, z: number, m: number): boolean => {
      const c = Math.cos(f.yaw), sn = Math.sin(f.yaw), dx = x - f.x, dz = z - f.z;
      return Math.abs(dx * c - dz * sn) <= f.w / 2 + m && Math.abs(dx * sn + dz * c) <= f.d / 2 + m;
    };
    let game = (b.seed >>> 5) % ARCADE_GAMES;
    const cab = (u: number, v: number, du: number, dv: number) => {
      if (plan.furniture.length >= 18) return;
      const a = F.P(u, v), b2 = F.P(u + du, v + dv);
      const f: Furn = { kind: 'arcade', x: a[0], z: a[1], yaw: Math.atan2(b2[0] - a[0], b2[1] - a[1]), w: CW, d: CD, h: CH, color: CABINET_COLORS[game], game };
      if (!fitsStorey(f) || (door && Math.hypot(f.x - door.x, f.z - door.z) < 3.4)) return;
      // Room to stand and play in front of it, and in front of the ones already placed.
      const st = standSpot(f);
      if (!pointInPoly(poly, st[0], st[1]) || (stairPoly && pointInPoly(stairPoly, st[0], st[1]))) return;
      for (const o of plan.furniture) if (inFootprint(o, st[0], st[1], 0.35) || inFootprint(f, ...standSpot(o), 0.35)) return;
      // Never in front of a doorway (the stair hall's, the lift lobby's): the street door may lead in through them.
      for (const [gx, gz] of gaps) if (inFootprint(f, gx, gz, 0.9)) return;
      plan.furniture.push(f);
      game = (game + 1) % ARCADE_GAMES;
    };
    const step = CW + 0.25;
    const vWall = hv - CD / 2 - 0.08;
    for (let u = u0 + CW / 2 + 0.3; u < uE - CW / 2 - 0.3; u += step) cab(u, vWall, 0, -1);
    for (let v = hv - CD - 0.08 - CW / 2 - 0.2; v > -hv + 3; v -= step) {
      cab(u0 + CD / 2 + 0.08, v, 1, 0);
      cab(uE - CD / 2 - 0.08, v, -1, 0);
    }
    // Islands: room to stand in front of the back wall's row and of the window side.
    const vc = -0.4;
    if (vc + 2 * CD + 2.8 <= vWall - CD / 2 && vc - 2 * CD - 2.8 >= -hv) {
      for (let u = u0 + CD + 3.4 + CW / 2; u < uE - CD - 3.4 - CW / 2; u += step) {
        cab(u, vc - CD / 2 - 0.02, 0, -1);
        cab(u, vc + CD / 2 + 0.02, 0, 1);
      }
    }
  }
  // Interior walls are laid out on the storey's rectangle: keep only their parts inside the
  // real outline (cut or irregular footprints had walls standing out in the street).
  plan.walls = plan.walls.flatMap((w) => clipWall(w, poly));
  // Keep only furniture that fits the storey (see fitsStorey).
  plan.furniture = plan.furniture.filter(fitsStorey);
  // A clear way in behind the street door: room walls across it get an opening, solid pieces go.
  const way = door && doorWay(poly, door, 2.2, 0.75);
  if (way) {
    for (const w of plan.walls) if (!w.solid) openWall(w, way);
    plan.walls = plan.walls.filter((w) => !(w.doors.length === 1 && w.doors[0][0] <= 0 && w.doors[0][1] >= 1));
    plan.furniture = plan.furniture.filter((f) => f.kind === 'rug' || f.kind === 'painting' || f.use === 'dress' || f.h < 0.3 || !overlaps(furnRect(f), way));
  }
  if (furnish.length) {
    const keepOut = [...(way ? [way] : []), ...(st ? [coreRect(st, 0, 0.1)] : []), ...(plan.lift ? [liftRect(plan.lift, 0.1), landingOf(plan.lift)] : [])];
    furnishRooms(plan, furnish, poly, b, r, keepOut, (type, A) => (work ? workItems(work, type, A, r) : homeItems(type as HomeRoom, A, r) ?? []));
  }
  // Ceiling lights per room: one in the middle of a small room, a grid in big ones; homes and
  // cafés get pendant lamps (over the table where there is one), offices and shops panels.
  for (const room of plan.rooms) {
    const fx = room.type === 'living' || room.type === 'bedroom' || room.type === 'kitchen' || room.type === 'cafe' ? 1
      : room.type === 'bath' || room.type === 'corridor' || room.type === 'hall' || room.type === 'stairs' || room.type === 'storage' || room.type === 'arcade' ? 2 : 0;
    const bb = polyBounds(room.poly);
    const cu = (bb[0] + bb[2]) / 2, cz = (bb[1] + bb[3]) / 2;
    const big = Math.max(bb[2] - bb[0], bb[3] - bb[1]) > 7;
    const pts: [number, number][] = [];
    if (!big) {
      const table = plan.furniture.find((f) => (f.kind === 'diningTable' || f.kind === 'coffeeTable') && pointInPoly(room.poly, f.x, f.z));
      pts.push(table ? [table.x, table.z] : [cu, cz]);
    } else for (let x = bb[0] + 2; x < bb[2] - 1; x += 4) for (let z = bb[1] + 2; z < bb[3] - 1; z += 4) pts.push([x, z]);
    for (const [x, z] of pts) {
      if (!pointInPoly(room.poly, x, z)) continue;
      if (plan.lights.some((_, i) => i % 2 === 0 && Math.hypot(plan.lights[i] - x, plan.lights[i + 1] - z) < 1.5)) continue;
      plan.lights.push(x, z);
      plan.fixtures.push(fx);
    }
  }

  void area;
  return plan;
}

/** The parts of a wall inside a polygon (shortened 5 cm at the outline), doors carried over. */
function clipWall(w: IWall, poly: Poly): IWall[] {
  const dx = w.bx - w.ax, dz = w.bz - w.az;
  const L = Math.hypot(dx, dz);
  if (L < 1e-3) return [];
  // Crossings of the wall line with the outline, as parameters along the wall.
  const ts = [0, 1];
  const n = poly.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const px = poly[i * 2], pz = poly[i * 2 + 1], ex = poly[j * 2] - px, ez = poly[j * 2 + 1] - pz;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((px - w.ax) * ez - (pz - w.az) * ex) / den;
    const u = ((px - w.ax) * dz - (pz - w.az) * dx) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
  }
  ts.sort((a, b) => a - b);
  const out: IWall[] = [];
  const m = 0.05 / L;
  for (let k = 0; k + 1 < ts.length; k++) {
    let t0 = ts[k], t1 = ts[k + 1];
    if (t1 - t0 < 1e-4) continue;
    const tm = (t0 + t1) / 2;
    if (!pointInPoly(poly, w.ax + dx * tm, w.az + dz * tm)) continue;
    if (t0 > 0) t0 += m;
    if (t1 < 1) t1 -= m;
    if ((t1 - t0) * L < 0.3) continue;
    const span = t1 - t0;
    const doors: [number, number][] = [];
    for (const [d0, d1] of w.doors) {
      const a = Math.max(d0, t0), b = Math.min(d1, t1);
      if (b - a > 0.6 / L) doors.push([(a - t0) / span, (b - t0) / span]);
    }
    out.push({ ax: w.ax + dx * t0, az: w.az + dz * t0, bx: w.ax + dx * t1, bz: w.az + dz * t1, doors, solid: w.solid });
  }
  return out;
}

/** A wall's opening where it crosses a convex quad (grown by a walker's width), merged with its doors. */
function openWall(w: IWall, quad: Poly): void {
  const dx = w.bx - w.ax, dz = w.bz - w.az, L = Math.hypot(dx, dz);
  if (L < 1e-3) return;
  // Cyrus–Beck: clip the wall line to the quad.
  let cx = 0, cz = 0;
  for (let i = 0; i < 8; i += 2) { cx += quad[i] / 4; cz += quad[i + 1] / 4; }
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 8 && t0 <= t1; i += 2) {
    const j = (i + 2) % 8;
    let nx = quad[j + 1] - quad[i + 1], nz = quad[i] - quad[j];
    // Outward normal of this edge.
    if ((cx - quad[i]) * nx + (cz - quad[i + 1]) * nz > 0) { nx = -nx; nz = -nz; }
    const num = (w.ax - quad[i]) * nx + (w.az - quad[i + 1]) * nz, den = dx * nx + dz * nz;
    if (Math.abs(den) < 1e-12) { if (num > 0) return; continue; }
    const t = -num / den;
    if (den < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
  }
  if (t1 - t0 < 0.05 / L) return;
  // At least a doorway's width (0.9 m), and no sliver of wall left at either end.
  const need = 0.9 / L;
  if (t1 - t0 < need) { const m = (t0 + t1) / 2; t0 = Math.max(0, m - need / 2); t1 = Math.min(1, t0 + need); t0 = Math.max(0, t1 - need); }
  if (t0 < 0.3 / L) t0 = 0;
  if (t1 > 1 - 0.3 / L) t1 = 1;
  const all = [...w.doors, [t0, t1] as [number, number]].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const d of all) {
    const last = merged[merged.length - 1];
    if (last && d[0] <= last[1] + 0.3 / L) last[1] = Math.max(last[1], d[1]);
    else merged.push([d[0], d[1]]);
  }
  w.doors = merged;
}

/** A piece's footprint (world quad). */
function furnRect(f: Furn): Poly {
  const c = Math.cos(f.yaw), s = Math.sin(f.yaw), w = f.w / 2, d = f.d / 2;
  const out: number[] = [];
  for (const [lx, lz] of [[-w, -d], [w, -d], [w, d], [-w, d]]) out.push(f.x + lx * c + lz * s, f.z - lx * s + lz * c);
  return out;
}

function lineWall(F: Frame, u0: number, v0: number, u1: number, v1: number, doors: [number, number][]): IWall {
  const a = F.P(u0, v0), b = F.P(u1, v1);
  return { ax: a[0], az: a[1], bx: b[0], bz: b[1], doors };
}

/** Inward normal of the building's street front (its front edge), or null. */
function frontNormal(b: BuildingDesc): [number, number] | null {
  const n = b.poly.length >> 1;
  if (n < 3) return null;
  const i = b.front % n, j = (i + 1) % n;
  const ax = b.poly[i * 2], az = b.poly[i * 2 + 1], dx = b.poly[j * 2] - ax, dz = b.poly[j * 2 + 1] - az, l = Math.hypot(dx, dz);
  if (l < 1e-6) return null;
  let nx = -dz / l, nz = dx / l;
  const [cx, cz] = polyCentroid(b.poly);
  if ((cx - ax) * nx + (cz - az) * nz < 0) { nx = -nx; nz = -nz; }
  return [nx, nz];
}

/** The floor in front of the lift doors that must stay free. */
function landingOf(l: LiftShaft): Poly {
  const vx = -l.uz, vz = l.ux;
  const P = (u: number, v: number) => [l.cx + l.ux * u + vx * v, l.cz + l.uz * u + vz * v];
  return [...P(l.hu, -l.hv), ...P(l.hu + LANDING, -l.hv), ...P(l.hu + LANDING, l.hv), ...P(l.hu, l.hv)];
}

/** Floor and wall finish of a room the splitter made. */
function lookOf(type: RoomType, ground: boolean, r: Rng): Pick<Room, 'floorMat' | 'wallColor'> {
  switch (type) {
    case 'bath': return { floorMat: 'tile', wallColor: [0.9, 0.92, 0.93] };
    case 'kitchen': return { floorMat: 'tile', wallColor: r.pick(WALLS) };
    case 'hall': case 'corridor': return { floorMat: 'tile', wallColor: [0.9, 0.89, 0.85] };
    case 'lobby': return { floorMat: 'marble', wallColor: [0.92, 0.9, 0.86] };
    case 'office': return { floorMat: 'carpet', wallColor: [0.9, 0.9, 0.88] };
    case 'meeting': return { floorMat: 'carpet', wallColor: [0.85, 0.88, 0.9] };
    case 'storage': return { floorMat: 'concrete', wallColor: [0.8, 0.8, 0.78] };
    case 'shop': return { floorMat: 'tile', wallColor: r.pick(WALLS) };
    case 'cafe': return { floorMat: 'wood', wallColor: r.pick(WALLS) };
    default: return { floorMat: ground && r.chance(0.3) ? 'tile' : r.chance(0.7) ? 'wood' : 'carpet', wallColor: r.pick(WALLS) };
  }
}

/**
 * Furnishes rooms with a theme's items (placed by fill/place), once the storey's walls and doors
 * are final. Side walls of attached houses are blind party walls, every other stretch of the
 * outline has windows.
 */
function furnishRooms(plan: FloorPlan, rooms: Room[], poly: Poly, b: BuildingDesc, r: Rng, keepOut: Poly[], items: (type: RoomType, A: ReturnType<typeof roomArea>) => Item[]): void {
  const n = b.poly.length >> 1, fi = b.front % n, fj = (fi + 1) % n;
  const fdx = b.poly[fj * 2] - b.poly[fi * 2], fdz = b.poly[fj * 2 + 1] - b.poly[fi * 2 + 1], fl = Math.hypot(fdx, fdz) || 1;
  const facade = (ax: number, az: number, bx: number, bz: number): EdgeKind => {
    if (!b.attached) return 'window';
    const l = Math.hypot(bx - ax, bz - az) || 1;
    return Math.abs(((bx - ax) * fdx + (bz - az) * fdz) / (l * fl)) < 0.5 ? 'blind' : 'window';
  };
  for (const room of rooms) {
    const A = roomArea(room.poly, plan.walls, poly, facade, keepOut);
    plan.furniture.push(...new Filler(A, r).fill(items(room.type, A)));
  }
}

/**
 * The stairs of one storey in its core: the enclosure wall on the hall side, the wall between
 * the lanes, and (going up) the two half flights with the landing between them; at the bottom of
 * the core the space under lane B is closed, at the top the opening over lane A is railed off.
 */
function stairsOf(plan: FloorPlan, c: StairCore, y: number, h: number, up: boolean, below: boolean): void {
  const band = 2 * c.w + c.g, vb = band / 2, mid = -vb + c.w + c.g / 2;
  const wall = (u0: number, v0: number, u1: number, v1: number) => {
    const a = coreP(c, u0, v0), b = coreP(c, u1, v1);
    plan.walls.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], doors: [], solid: true });
  };
  // Enclosure along the hall side past the near landing, along the outer side and across the far end
  // (the facade may stand a little further off: nobody walks off the landing).
  wall(c.near, c.open * vb, c.len, c.open * vb);
  wall(0, -c.open * vb, c.len, -c.open * vb);
  wall(c.len, -vb, c.len, vb);
  if (!up && !below) return;
  // Between the lanes.
  wall(c.near, mid, c.near + c.run, mid);
  if (!below) wall(c.near, mid, c.near, vb); // nothing under lane B at the bottom
  if (!up) { wall(c.near, -vb, c.near, mid); return; } // the opening over lane A at the top
  const half = h / 2;
  const la = coreP(c, c.near, -vb + c.w / 2), lb = coreP(c, c.near + c.run, vb - c.w / 2);
  plan.flights.push({ x: la[0], z: la[1], dx: c.ux, dz: c.uz, width: c.w, run: c.run, y0: y, y1: y + half });
  plan.flights.push({ x: lb[0], z: lb[1], dx: -c.ux, dz: -c.uz, width: c.w, run: c.run, y0: y + half, y1: y + h });
  const L = [...coreP(c, c.near + c.run, -vb), ...coreP(c, c.len, -vb), ...coreP(c, c.len, vb), ...coreP(c, c.near + c.run, vb)];
  plan.landings.push({ poly: L, y: y + half });
  plan.stairHole = coreRect(c, c.near - 0.02);
}
