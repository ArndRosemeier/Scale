/**
 * Interior layout of one storey: rooms, interior walls with door openings,
 * a stair core, floor finishes and furniture placements. Pure data,
 * deterministic per (building seed, floor). Coordinates are world x/z.
 */
import { Rng } from '../core/rng';
import { minAreaRect, polyArea, pointInPoly, type Poly } from '../core/geom2';
import { intersection } from '../core/clip';
import type { BuildingDesc } from '../plan/building';

export type RoomType =
  | 'living' | 'bedroom' | 'kitchen' | 'bath' | 'hall' | 'office' | 'meeting' | 'shop' | 'cafe' | 'storage'
  | 'warehouse' | 'nave' | 'lobby' | 'corridor' | 'stairs' | 'parking';

export type FurnKind =
  | 'bed' | 'bedDouble' | 'wardrobe' | 'nightstand' | 'sofa' | 'armchair' | 'coffeeTable' | 'tvStand' | 'tv' | 'rug'
  | 'diningTable' | 'chair' | 'kitchenRow' | 'fridge' | 'stove' | 'toilet' | 'bathtub' | 'sink' | 'shower'
  | 'desk' | 'officeChair' | 'monitor' | 'meetingTable' | 'shelf' | 'bookshelf' | 'plant' | 'floorLamp' | 'painting'
  | 'counter' | 'shopShelf' | 'rack' | 'cafeTable' | 'barCounter' | 'palletRack' | 'crate' | 'pew' | 'altar' | 'reception' | 'column' | 'clothesStack';

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
}

export interface Furn {
  kind: FurnKind;
  x: number; z: number; yaw: number;
  /** Size (w along local x, d along local z, h). */
  w: number; d: number; h: number;
  color: [number, number, number];
  /** People can use it: 'sit' | 'sleep' | 'work' | 'stand' */
  use?: 'sit' | 'sleep' | 'work' | 'stand';
}

export interface Stair {
  /** Run start (bottom) and direction; width; rise per floor. */
  x: number; z: number; dx: number; dz: number; width: number; run: number;
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
export function planLift(b: BuildingDesc, poly: Poly): LiftShaft | null {
  if (b.floors < 2) return null;
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
    return true;
  };
  const vOff = Math.max(0, F.hv - LIFT_HV - 0.3);
  for (let inset = 0.15; inset < F.hu - 1; inset += 0.5) {
    for (const v of [vOff, -vOff, 0]) {
      if (fits(-F.hu + inset, v)) return candidate(-F.hu + inset, v);
    }
  }
  return null;
}

export interface FloorPlan {
  floor: number;
  y: number;
  height: number;
  rooms: Room[];
  walls: IWall[];
  furniture: Furn[];
  stair: Stair | null;
  /** Elevator shaft serving this floor (doors on its +u face), or null. */
  lift: LiftShaft | null;
  /** Ceiling light positions (x, z). */
  lights: number[];
}

const WALLS: [number, number, number][] = [[0.92, 0.9, 0.85], [0.88, 0.86, 0.8], [0.85, 0.88, 0.9], [0.9, 0.85, 0.8], [0.8, 0.86, 0.8], [0.95, 0.93, 0.9], [0.86, 0.8, 0.75]];
const FABRIC: [number, number, number][] = [[0.3, 0.32, 0.38], [0.55, 0.45, 0.35], [0.2, 0.3, 0.25], [0.6, 0.6, 0.58], [0.45, 0.2, 0.18], [0.25, 0.25, 0.28], [0.7, 0.65, 0.55]];
const WOOD: [number, number, number][] = [[0.45, 0.32, 0.2], [0.6, 0.45, 0.3], [0.3, 0.2, 0.13], [0.75, 0.65, 0.5]];

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

export function planFloor(b: BuildingDesc, poly: Poly, floor: number, y: number, height: number, shopKind: number, lift: LiftShaft | null = null): FloorPlan {
  const r = new Rng((b.seed ^ (floor * 0x9e3779b1)) >>> 0);
  const F = new Frame(poly);
  const plan: FloorPlan = { floor, y, height, rooms: [], walls: [], furniture: [], stair: null, lift: null, lights: [] };
  const area = Math.abs(polyArea(poly));
  const clipRoom = (rect: Poly): Poly | null => {
    const s = intersection([rect], [poly]);
    if (!s.length) return null;
    const q = s.sort((a, b2) => Math.abs(polyArea(b2.outer)) - Math.abs(polyArea(a.outer)))[0].outer;
    return Math.abs(polyArea(q)) > 2 ? q : null;
  };
  const multi = b.floors > 1;
  const { hu, hv } = F;
  // --- elevator core (multi-storey): shaft + landing at one end of the long axis
  let coreU0 = hu, coreU1 = hu;
  const serves = !!lift && liftRect(lift, 0.05).every((_, k, a) => k % 2 === 1 || pointInPoly(poly, a[k], a[k + 1]));
  if (multi && lift && serves) {
    plan.lift = lift;
    // Shaft walls in the lift's own frame (doors on the +u face).
    const vx = -lift.uz, vz = lift.ux;
    const L = (u: number, v: number): [number, number] => [lift.cx + lift.ux * u + vx * v, lift.cz + lift.uz * u + vz * v];
    const wall = (a: [number, number], b: [number, number], doors: [number, number][]) => plan.walls.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], doors });
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
    wall(L(front, -lob), L(front, lob), [[0.55, 0.85]]);
    // Rooms start beyond the lobby (in this floor's frame).
    const e = L(front, 0);
    coreU1 = (e[0] - F.cx) * F.ux + (e[1] - F.cz) * F.uz;
    coreU0 = -hu;
    if (Math.abs(lift.ux * F.ux + lift.uz * F.uz) < 0.95) coreU1 = -hu; // rotated frame (setback tier)
  }
  const ground = floor === 0;
  const use = b.use;
  const style = b.style;
  const u0 = plan.lift ? coreU1 : -hu;
  // --- choose layout
  if (style === 'church') {
    plan.rooms.push({ type: 'nave', poly, floorMat: 'stone', wallColor: [0.9, 0.87, 0.8] });
    for (let u = -hu + 3; u < hu - 4; u += 1.1) {
      for (const side of [-1, 1]) {
        const p = F.P(u, side * Math.min(hv * 0.45, 3));
        plan.furniture.push({ kind: 'pew', x: p[0], z: p[1], yaw: F.yaw + Math.PI / 2, w: Math.min(hv * 0.7, 4.5), d: 0.5, h: 0.9, color: WOOD[2], use: 'sit' });
      }
    }
    const al = F.P(hu - 2, 0);
    plan.furniture.push({ kind: 'altar', x: al[0], z: al[1], yaw: F.yaw, w: 2.4, d: 1, h: 1.05, color: [0.85, 0.82, 0.75] });
  } else if (use === 'industrial' || use === 'parking') {
    plan.rooms.push({ type: use === 'parking' ? 'parking' : 'warehouse', poly, floorMat: 'concrete', wallColor: [0.75, 0.75, 0.74] });
    for (let u = u0 + 3; u < hu - 2; u += use === 'parking' ? 8 : 4.2) {
      for (let v = -hv + 2; v < hv - 1; v += use === 'parking' ? 8 : 3.5) {
        const p = F.P(u, v);
        if (use === 'parking') plan.furniture.push({ kind: 'column', x: p[0], z: p[1], yaw: 0, w: 0.5, d: 0.5, h: height, color: [0.7, 0.7, 0.7] });
        else if (r.chance(0.7)) plan.furniture.push({ kind: r.chance(0.6) ? 'palletRack' : 'crate', x: p[0], z: p[1], yaw: F.yaw, w: 2.6, d: 1.1, h: r.range(1.2, 3.5), color: [0.35, 0.4, 0.5] });
      }
    }
  } else if (ground && (b.shopfront || use === 'retail')) {
    // Shop or cafe on the ground floor: front part public, back storage.
    const cafe = shopKind % 3 === 0;
    const split = hv * 0.25;
    const front = clipRoom(F.rect(u0, -hv, hu, hv - split * 1.0));
    const back = clipRoom(F.rect(u0, hv - split, hu, hv));
    if (front) plan.rooms.push({ type: cafe ? 'cafe' : 'shop', poly: front, floorMat: cafe ? 'wood' : 'tile', wallColor: r.pick(WALLS) });
    if (back) plan.rooms.push({ type: 'storage', poly: back, floorMat: 'concrete', wallColor: [0.8, 0.8, 0.78] });
    wallLine(plan, F, u0, hv - split, hu, hv - split, [[0.8, 0.9]]);
    if (cafe) {
      for (let u = u0 + 1.5; u < hu - 1.2; u += 2.2) for (let v = -hv + 1.4; v < hv - split - 1.2; v += 2.2) {
        const p = F.P(u, v);
        plan.furniture.push({ kind: 'cafeTable', x: p[0], z: p[1], yaw: 0, w: 0.75, d: 0.75, h: 0.75, color: WOOD[1] });
        for (const [cu, cv] of [[0.65, 0], [-0.65, 0]]) {
          const c = F.P(u + cu, v + cv);
          plan.furniture.push({ kind: 'chair', x: c[0], z: c[1], yaw: F.yaw + (cu > 0 ? -Math.PI / 2 : Math.PI / 2), w: 0.45, d: 0.45, h: 0.9, color: WOOD[2], use: 'sit' });
        }
      }
      const bc = F.P((u0 + hu) / 2, hv - split - 0.8);
      plan.furniture.push({ kind: 'barCounter', x: bc[0], z: bc[1], yaw: F.yaw, w: Math.min(5, hu), d: 0.7, h: 1.1, color: WOOD[0], use: 'stand' });
    } else {
      // Along the long axis: yaw + π/2 puts a piece's width along u.
      const along = F.yaw + Math.PI / 2;
      const put = (kind: FurnKind, u: number, v: number, yaw: number, w: number, d: number, h: number, color: [number, number, number], use?: Furn['use']) => {
        const p = F.P(u, v);
        plan.furniture.push({ kind, x: p[0], z: p[1], yaw, w, d, h, color, use });
      };
      const vBack = hv - split, vFront = -hv;
      const fixture: [number, number, number] = r.pick([[0.86, 0.86, 0.84], [0.32, 0.33, 0.35], [0.62, 0.5, 0.36]]);
      const clothing = shopKind % 3 === 1;
      if (!clothing) {
        // Grocery / general store: back-to-back shelving aisles across the room.
        for (let v = vFront + 2.6; v < vBack - 1.9; v += 2.5) {
          for (let u = u0 + 1.4; u + 1.9 < hu - 2.6; u += 2.0) {
            put('shopShelf', u + 0.9, v - 0.31, along, 1.8, 0.55, 1.7, fixture);
            put('shopShelf', u + 0.9, v + 0.31, along + Math.PI, 1.8, 0.55, 1.7, fixture);
          }
        }
      } else {
        // Clothing / boutique: display tables, a rug and mirrors (paintings) on the walls.
        for (let v = vFront + 2.4; v < vBack - 1.6; v += 2.6) for (let u = u0 + 1.8; u < hu - 2.8; u += 2.8) {
          put('coffeeTable', u, v, along, 1.4, 0.8, 0.8, r.pick(WOOD));
          put('clothesStack', u, v, along, 1.2, 0.6, 0.8, r.pick(FABRIC));
        }
        put('rug', (u0 + hu) / 2, (vFront + vBack) / 2, along, Math.min(4, hu - u0 - 2), Math.min(3, vBack - vFront - 2), 0.01, r.pick(FABRIC));
        for (let u = u0 + 2; u < hu - 2; u += 3) put('painting', u, vBack - 0.06, along, 0.7, 0.04, 1.6, [0.75, 0.8, 0.85]);
      }
      // Wall shelving along the back wall, facing the shop.
      for (let u = u0 + 1.1; u + 1.9 < hu - 0.4; u += 2.0) put('shopShelf', u + 0.9, vBack - 0.32, along, 1.8, 0.5, 2.1, fixture);
      // Checkout by the entrance with a register, a display table and plants in the window.
      put('counter', hu - 1.6, vFront + 1.5, F.yaw, 1.8, 0.7, 1.0, WOOD[1], 'stand');
      put('monitor', hu - 1.6, vFront + 1.5, F.yaw + Math.PI, 0.5, 0.3, 0.3, [0.1, 0.1, 0.1]);
      put('coffeeTable', (u0 + hu) / 2, vFront + 1.1, along, 1.6, 0.7, 0.8, r.pick(WOOD));
      put('plant', u0 + 0.6, vFront + 0.6, 0, 0.5, 0.5, 1.3, [0.2, 0.45, 0.2]);
      put('plant', hu - 0.6, vFront + 0.6, 0, 0.5, 0.5, 1.1, [0.2, 0.45, 0.2]);
    }
    // Storage behind: pallet racks along the walls, crates in between.
    if (back) {
      const along = F.yaw + Math.PI / 2;
      for (let u = u0 + 1.6; u < hu - 1.4; u += 2.9) {
        const p = F.P(u, hv - 0.6);
        plan.furniture.push({ kind: 'palletRack', x: p[0], z: p[1], yaw: along, w: 1.3, d: 0.5, h: Math.min(2.6, height - 0.5), color: [0.35, 0.4, 0.5] });
        if (r.chance(0.6)) { const q = F.P(u + 1.4, hv - split + 0.7); plan.furniture.push({ kind: 'crate', x: q[0], z: q[1], yaw: along + r.range(-0.3, 0.3), w: 0.8, d: 0.6, h: 0.55, color: [0.6, 0.48, 0.3] }); }
      }
    }
    if (cafe) {
      // Cafe dressing: plants by the window, art on the walls.
      for (const u of [u0 + 0.7, hu - 0.7]) { const p = F.P(u, -hv + 0.7); plan.furniture.push({ kind: 'plant', x: p[0], z: p[1], yaw: 0, w: 0.5, d: 0.5, h: 1.4, color: [0.2, 0.45, 0.2] }); }
      for (let u = u0 + 2; u < hu - 1.5; u += 3.2) { const p = F.P(u, hv - split - 0.06); plan.furniture.push({ kind: 'painting', x: p[0], z: p[1], yaw: F.yaw + Math.PI / 2, w: 0.8, d: 0.04, h: 0.6, color: r.pick(FABRIC) }); }
    }
  } else if (use === 'office' || (ground && b.floors > 6)) {
    // Open plan office (or lobby on the ground floor of towers).
    if (ground) {
      plan.rooms.push({ type: 'lobby', poly, floorMat: 'marble', wallColor: [0.92, 0.9, 0.86] });
      const c = F.P(0, -hv * 0.4);
      plan.furniture.push({ kind: 'reception', x: c[0], z: c[1], yaw: F.yaw, w: 3, d: 0.9, h: 1.1, color: [0.25, 0.25, 0.27], use: 'stand' });
      for (const k of [-1, 1]) { const p = F.P(k * hu * 0.6, hv * 0.5); plan.furniture.push({ kind: 'plant', x: p[0], z: p[1], yaw: 0, w: 0.6, d: 0.6, h: 1.6, color: [0.2, 0.45, 0.2] }); }
      // Waiting area: two sofas facing over a low table on a rug, art on the walls.
      const wu = hu * 0.45, fab = r.pick(FABRIC);
      const at = (u: number, v: number) => F.P(u, v);
      let q = at(wu, hv * 0.15); plan.furniture.push({ kind: 'rug', x: q[0], z: q[1], yaw: F.yaw, w: 2.6, d: 3.2, h: 0.01, color: r.pick(FABRIC) });
      q = at(wu, hv * 0.15); plan.furniture.push({ kind: 'coffeeTable', x: q[0], z: q[1], yaw: F.yaw, w: 1.1, d: 0.6, h: 0.42, color: WOOD[2] });
      for (const sd of [-1, 1]) { q = at(wu + sd * 1.2, hv * 0.15); plan.furniture.push({ kind: 'sofa', x: q[0], z: q[1], yaw: F.yaw + (sd > 0 ? Math.PI : 0), w: 2.0, d: 0.9, h: 0.85, color: fab, use: 'sit' }); }
      for (let u = -hu + 2; u < hu - 2; u += 4) { q = at(u, hv - 0.06); plan.furniture.push({ kind: 'painting', x: q[0], z: q[1], yaw: F.yaw + Math.PI / 2, w: 1.2, d: 0.04, h: 0.8, color: r.pick(FABRIC) }); }
    } else {
      plan.rooms.push({ type: 'office', poly, floorMat: 'carpet', wallColor: [0.9, 0.9, 0.88] });
      // Meeting room at the far end.
      if (hu > 8) {
        const mr = clipRoom(F.rect(hu - 4.5, -hv, hu, hv * 0.2));
        if (mr) plan.rooms.push({ type: 'meeting', poly: mr, floorMat: 'carpet', wallColor: [0.85, 0.88, 0.9] });
        wallLine(plan, F, hu - 4.5, -hv, hu - 4.5, hv * 0.2, [[0.7, 0.85]]);
        wallLine(plan, F, hu - 4.5, hv * 0.2, hu, hv * 0.2, []);
        const t = F.P(hu - 2.25, (-hv + hv * 0.2) / 2);
        plan.furniture.push({ kind: 'meetingTable', x: t[0], z: t[1], yaw: F.yaw, w: 2.8, d: 1.2, h: 0.75, color: WOOD[3] });
      }
      for (let u = u0 + 2; u < (hu > 8 ? hu - 5.5 : hu - 1.5); u += 2.6) {
        for (let v = -hv + 1.8; v < hv - 1.4; v += 3.2) {
          const p = F.P(u, v);
          if (!pointInPoly(poly, p[0], p[1])) continue;
          plan.furniture.push({ kind: 'desk', x: p[0], z: p[1], yaw: F.yaw, w: 1.6, d: 0.8, h: 0.74, color: [0.85, 0.84, 0.8] });
          const m = F.P(u, v - 0.2);
          plan.furniture.push({ kind: 'monitor', x: m[0], z: m[1], yaw: F.yaw + Math.PI, w: 0.6, d: 0.05, h: 0.4, color: [0.08, 0.08, 0.09] });
          const c = F.P(u, v + 0.7);
          plan.furniture.push({ kind: 'officeChair', x: c[0], z: c[1], yaw: F.yaw + Math.PI, w: 0.6, d: 0.6, h: 1.1, color: [0.15, 0.15, 0.17], use: 'work' });
        }
      }
    }
  } else {
    // Residential: corridor along the spine, apartments either side, rooms in sequence.
    const corridor = hv > 5;
    const cw = 0.8;
    if (corridor) {
      const cq = clipRoom(F.rect(u0, -cw, hu, cw));
      if (cq) plan.rooms.push({ type: ground ? 'hall' : 'corridor', poly: cq, floorMat: 'tile', wallColor: [0.9, 0.89, 0.85] });
    }
    const sides: [number, number][] = corridor ? [[-hv, -cw], [cw, hv]] : [[-hv, hv]];
    const cycle: RoomType[] = ['living', 'bedroom', 'kitchen', 'bath', 'bedroom'];
    for (const [v0, v1] of sides) {
      let u = u0;
      let k = r.int(0, 3);
      while (u < hu - 1.5) {
        const type = cycle[k % cycle.length];
        const len = type === 'bath' ? r.range(2.2, 3) : type === 'kitchen' ? r.range(3, 4) : type === 'living' ? r.range(4.5, 6.5) : r.range(3.4, 4.5);
        const u1 = Math.min(hu, u + len);
        const q = clipRoom(F.rect(u, v0, u1, v1));
        if (q) {
          const room: Room = { type, poly: q, floorMat: type === 'bath' || type === 'kitchen' ? 'tile' : r.chance(0.7) ? 'wood' : 'carpet', wallColor: type === 'bath' ? [0.9, 0.92, 0.93] : r.pick(WALLS) };
          plan.rooms.push(room);
          furnishRoom(plan, F, r, type, u, v0, u1, v1, corridor ? (v0 < 0 ? 1 : -1) : 0);
        }
        // Wall between rooms with a door near the corridor side.
        if (u1 < hu - 0.5) wallLine(plan, F, u1, v0, u1, v1, corridor ? [[v0 < 0 ? 0.62 : 0.08, v0 < 0 ? 0.9 : 0.36]] : [[0.4, 0.62]]);
        u = u1;
        k++;
      }
      // Wall between rooms and corridor with doors per room.
      if (corridor) {
        const vv = v0 < 0 ? -cw : cw;
        const doors: [number, number][] = [];
        const span = hu - u0;
        for (let uu = u0 + 1; uu < hu - 1; uu += 4.2) doors.push([(uu - u0) / span, (uu + 0.9 - u0) / span]);
        wallLine(plan, F, u0, vv, hu, vv, doors);
      }
    }
  }
  // Keep only furniture fully inside the storey (with a margin from the walls).
  plan.furniture = plan.furniture.filter((f) => {
    const c = Math.cos(f.yaw), sn = Math.sin(f.yaw);
    const w = f.w / 2 + 0.05, d = f.d / 2 + 0.05;
    for (const [lx, lz] of [[-w, -d], [w, -d], [w, d], [-w, d], [0, 0]]) {
      const x = f.x + lx * c + lz * sn, z = f.z - lx * sn + lz * c;
      if (!pointInPoly(poly, x, z)) return false;
    }
    if (plan.lift) {
      const l = plan.lift;
      const dx = f.x - l.cx, dz = f.z - l.cz;
      const u = dx * l.ux + dz * l.uz, v = -dx * l.uz + dz * l.ux;
      if (u > -l.hu - 0.7 && u < l.hu + LANDING + 0.4 && Math.abs(v) < l.hv + 0.7) return false;
    }
    return true;
  });
  // Ceiling lights on a grid.
  for (let u = -hu + 2; u < hu - 1; u += 4) for (let v = -hv + 2; v < hv - 1; v += 4) {
    const p = F.P(u, v);
    if (pointInPoly(poly, p[0], p[1])) plan.lights.push(p[0], p[1]);
  }
  void area;
  return plan;
}

function wallLine(plan: FloorPlan, F: Frame, u0: number, v0: number, u1: number, v1: number, doors: [number, number][]): void {
  const a = F.P(u0, v0), b = F.P(u1, v1);
  plan.walls.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], doors });
}

/** Furniture along the walls of a rectangular room (OBB frame coordinates). `doorSide`: +1 door at v1? */
function furnishRoom(plan: FloorPlan, F: Frame, r: Rng, type: RoomType, u0: number, v0: number, u1: number, v1: number, corridorSide: number): void {
  const add = (kind: FurnKind, u: number, v: number, yawOff: number, w: number, d: number, h: number, color: [number, number, number], use?: Furn['use']) => {
    const p = F.P(u, v);
    plan.furniture.push({ kind, x: p[0], z: p[1], yaw: F.yaw + yawOff, w, d, h, color, use });
  };
  const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
  const W = u1 - u0, D = v1 - v0;
  // The exterior wall is opposite the corridor side.
  const ext = corridorSide > 0 ? v0 : corridorSide < 0 ? v1 : v0;
  const inner = corridorSide > 0 ? v1 : corridorSide < 0 ? v0 : v1;
  const towardInner = Math.sign(inner - ext) || 1;
  const fabric = r.pick(FABRIC), wood = r.pick(WOOD);
  switch (type) {
    case 'living':
      add('sofa', um, ext + towardInner * 0.55, towardInner > 0 ? 0 : Math.PI, Math.min(2.2, W * 0.5), 0.9, 0.85, fabric, 'sit');
      add('coffeeTable', um, ext + towardInner * 1.6, 0, 1.1, 0.6, 0.42, wood);
      add('rug', um, ext + towardInner * 1.5, 0, Math.min(2.6, W * 0.6), 1.8, 0.01, r.pick(FABRIC));
      add('tvStand', um, inner - towardInner * 0.35, towardInner > 0 ? Math.PI : 0, 1.6, 0.45, 0.5, wood);
      add('tv', um, inner - towardInner * 0.35, towardInner > 0 ? Math.PI : 0, 1.2, 0.08, 0.7, [0.05, 0.05, 0.06]);
      if (W > 4.5) add('armchair', u0 + 0.7, vm, Math.PI / 2, 0.85, 0.85, 0.9, r.pick(FABRIC), 'sit');
      add('plant', u1 - 0.5, ext + towardInner * 0.45, 0, 0.5, 0.5, 1.3, [0.2, 0.45, 0.2]);
      add('bookshelf', u1 - 0.2, vm, -Math.PI / 2, Math.min(1.8, D * 0.5), 0.35, 2.0, wood);
      add('floorLamp', u0 + 0.4, ext + towardInner * 0.4, 0, 0.35, 0.35, 1.6, [0.9, 0.85, 0.7]);
      if (r.chance(0.7)) add('painting', um, inner - towardInner * 0.06, towardInner > 0 ? Math.PI : 0, 0.9, 0.04, 0.6, r.pick(FABRIC));
      break;
    case 'bedroom': {
      const dbl = W > 3.4 && r.chance(0.7);
      add(dbl ? 'bedDouble' : 'bed', um, inner - towardInner * 1.1, towardInner > 0 ? Math.PI : 0, dbl ? 1.6 : 0.95, 2.05, 0.55, r.pick(FABRIC), 'sleep');
      add('nightstand', um + (dbl ? 1.1 : 0.75), inner - towardInner * 0.3, towardInner > 0 ? Math.PI : 0, 0.45, 0.4, 0.55, wood);
      add('wardrobe', u0 + 0.35, vm, Math.PI / 2, Math.min(2, D * 0.5), 0.6, 2.1, wood);
      add('rug', um, vm, 0, 1.6, 1.2, 0.01, r.pick(FABRIC));
      if (r.chance(0.5)) add('desk', u1 - 0.45, ext + towardInner * 0.8, -Math.PI / 2, 1.1, 0.6, 0.74, wood);
      break;
    }
    case 'kitchen':
      add('kitchenRow', um, inner - towardInner * 0.32, towardInner > 0 ? Math.PI : 0, W - 0.4, 0.62, 0.92, [0.92, 0.92, 0.9]);
      add('fridge', u1 - 0.45, inner - towardInner * 0.35, towardInner > 0 ? Math.PI : 0, 0.7, 0.68, 1.85, [0.9, 0.9, 0.9]);
      add('diningTable', um, vm, 0, 1.4, 0.85, 0.75, wood);
      for (const s of [-1, 1]) add('chair', um + s * 0.45, vm + 0.6, Math.PI, 0.45, 0.45, 0.9, wood, 'sit');
      for (const s of [-1, 1]) add('chair', um + s * 0.45, vm - 0.6, 0, 0.45, 0.45, 0.9, wood, 'sit');
      break;
    case 'bath':
      add('bathtub', um, inner - towardInner * 0.4, 0, Math.min(1.7, W - 0.3), 0.75, 0.55, [0.95, 0.95, 0.95]);
      add('toilet', u0 + 0.4, ext + towardInner * 0.4, Math.PI / 2, 0.4, 0.65, 0.75, [0.95, 0.95, 0.95]);
      add('sink', u1 - 0.35, ext + towardInner * 0.45, -Math.PI / 2, 0.55, 0.45, 0.85, [0.95, 0.95, 0.95]);
      break;
    default:
      break;
  }
}
