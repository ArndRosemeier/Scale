/**
 * Structural layout of a building: floors, perimeter wall panels (one per
 * window bay per floor) and slabs. Deterministic from the descriptor, so the
 * mesh worker (geometry) and the main thread (destruction, interiors) derive
 * exactly the same element ids without transferring anything.
 */
import { type Poly, polyArea, ensureCCW, polyCentroid, minAreaRect, pointInPoly } from '../core/geom2';
import { offset, shapesToPolys } from '../core/clip';
import type { Terrain } from '../world/terrain';
import type { BuildingDesc } from '../plan/building';
import { CURB_H } from './ground';

export interface Panel {
  /** Element id (cell-local). */
  e: number;
  floor: number;
  edge: number;
  bay: number;
  ax: number; az: number; bx: number; bz: number;
  y0: number; y1: number;
  /** Outward normal. */
  nx: number; nz: number;
  /** u offset of the panel start along its edge (for facade uv continuity). */
  u0: number;
  /** Exact bay width of this edge. */
  bayW: number;
  edgeLen: number;
}

export interface FloorInfo {
  f: number;
  y0: number;
  y1: number;
  tier: number;
  panelStart: number;
  panelCount: number;
  /** First slab tile element (a stand-in for "the slab" where one element is enough). */
  slab: number;
  /** Slab tiles: element id per grid cell (-1 = cell outside the floor). */
  tiles: Int32Array;
}

/**
 * Slab tile grid of a tier (in its oriented bounding box): a storey's floor is made of
 * these tiles so it can break piece by piece. Cell (i, j) covers u ∈ [u0 + i·size, …),
 * v ∈ [v0 + j·size, …) in the frame (cx, cz, ux, uz).
 */
export interface SlabGrid {
  cx: number; cz: number; ux: number; uz: number;
  u0: number; v0: number; size: number; nu: number; nv: number;
  /** 1 if the cell overlaps the tier's footprint. */
  inside: Uint8Array;
}

/** World position of grid coordinates (u, v). */
export function gridPoint(g: SlabGrid, u: number, v: number): [number, number] {
  return [g.cx + g.ux * u - g.uz * v, g.cz + g.uz * u + g.ux * v];
}

/** Grid cell index containing world (x, z), or -1. */
export function gridCell(g: SlabGrid, x: number, z: number): number {
  const dx = x - g.cx, dz = z - g.cz;
  const fu = (dx * g.ux + dz * g.uz - g.u0) / g.size, fv = (-dx * g.uz + dz * g.ux - g.v0) / g.size;
  // Points on the grid's border (footprint corners) round into the edge cells.
  const E = 1e-4;
  if (fu < -E || fv < -E || fu > g.nu + E || fv > g.nv + E) return -1;
  const i = Math.min(g.nu - 1, Math.max(0, Math.floor(fu))), j = Math.min(g.nv - 1, Math.max(0, Math.floor(fv)));
  return i * g.nv + j;
}

function slabGrid(poly: Poly): SlabGrid {
  const o = minAreaRect(poly);
  const area = Math.abs(polyArea(poly));
  // ~4 m tiles, at most ~48 per storey.
  const size = Math.max(4, Math.sqrt(area / 48));
  const nu = Math.max(1, Math.ceil((o.hu * 2) / size)), nv = Math.max(1, Math.ceil((o.hv * 2) / size));
  const g: SlabGrid = { cx: o.cx, cz: o.cz, ux: o.ux, uz: o.uz, u0: -o.hu, v0: -o.hv, size, nu, nv, inside: new Uint8Array(nu * nv) };
  // Deterministic overlap test (same on the worker and the main thread): any of 9 samples
  // inside, or the outline entering the cell (corner slivers of irregular footprints must get
  // a tile too, or the floor has a hole there).
  const n = poly.length >> 1;
  const pu = new Float64Array(n), pv = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const dx = poly[k * 2] - g.cx, dz = poly[k * 2 + 1] - g.cz;
    pu[k] = dx * g.ux + dz * g.uz; pv[k] = -dx * g.uz + dz * g.ux;
  }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    let hit = false;
    for (const a of [0.02, 0.5, 0.98]) for (const c of [0.02, 0.5, 0.98]) {
      const [x, z] = gridPoint(g, g.u0 + (i + a) * size, g.v0 + (j + c) * size);
      if (!hit && pointInPoly(poly, x, z)) hit = true;
    }
    const ua = g.u0 + i * size, va = g.v0 + j * size, ub = ua + size, vb = va + size;
    for (let k = 0; k < n && !hit; k++) {
      const k2 = (k + 1) % n;
      hit = segHitsRect(pu[k], pv[k], pu[k2], pv[k2], ua, va, ub, vb);
    }
    g.inside[i * nv + j] = hit ? 1 : 0;
  }
  return g;
}

/** Does segment a-b touch the open rectangle (u0, v0)-(u1, v1)? (Liang-Barsky clip.) */
function segHitsRect(au: number, av: number, bu: number, bv: number, u0: number, v0: number, u1: number, v1: number): boolean {
  let t0 = 0, t1 = 1;
  const du = bu - au, dv = bv - av;
  for (const [p, q] of [[-du, au - u0], [du, u1 - au], [-dv, av - v0], [dv, v1 - av]]) {
    if (Math.abs(p) < 1e-12) { if (q <= 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t0) t0 = t; } else if (t < t1) t1 = t;
    if (t0 >= t1) return false;
  }
  return t1 - t0 > 1e-6;
}

export interface BuildingLayout {
  base: number;
  low: number;
  height: number;
  tiers: { fromFloor: number; poly: Poly; grid: SlabGrid }[];
  floors: FloorInfo[];
  panels: Panel[];
  plinth: number;
  roof: number;
  elemBase: number;
  elemCount: number;
  centroid: [number, number];
  /** Entrance door on the front edge: arc-length span along that edge. */
  door: { edge: number; s0: number; s1: number; x: number; z: number };
  /** Entrance steps up to a ground floor raised above the street (slopes), or null. */
  stoop: Stoop | null;
}

/**
 * Entrance steps outside the door: a landing at ground-floor level and a flight down to
 * the street, as boxes in the front edge's frame (along the facade u, outwards n = (uz, -ux)).
 */
export interface Stoop {
  ux: number; uz: number;
  /** Bottom of every box (buried below the terrain). */
  foot: number;
  /** [cx, cz, hu, hn, top] per box: centre, half extents along the facade / outwards, top height. */
  boxes: number[];
  bounds: [number, number, number, number];
}

/** No stoop reaches farther than this from its building's footprint bounds. */
export const STOOP_REACH = 8;
/** Comfortable riser / tread of entrance steps. */
const RISER = 0.18, TREAD = 0.3;
/** Longest flight that runs straight out from the door (keeps the sidewalk passable). */
const STRAIGHT_RUN = 1.2;
/** Boxes reach this far into the wall: no seam between the steps and the floor inside. */
const IN = 0.1;

/** Highest stoop step top under (x, z) (-Infinity outside). */
export function stoopTop(s: Stoop, x: number, z: number): number {
  const bb = s.bounds;
  if (x < bb[0] || x > bb[2] || z < bb[1] || z > bb[3]) return -Infinity;
  let top = -Infinity;
  const B = s.boxes;
  for (let k = 0; k < B.length; k += 5) {
    const dx = x - B[k], dz = z - B[k + 1];
    // (1 mm tolerance: no seam between neighbouring steps)
    if (Math.abs(dx * s.ux + dz * s.uz) <= B[k + 2] + 1e-3 && Math.abs(dx * s.uz - dz * s.ux) <= B[k + 3] + 1e-3) top = Math.max(top, B[k + 4]);
  }
  return top;
}

/**
 * Steps from the street up to the entrance door when the ground floor stands above the
 * ground outside (the floor sits on the highest corner of the footprint, so on a slope
 * the downhill doors are up to several metres above the sidewalk). A short flight runs
 * straight out of the door; a long one turns along the facade, towards the uphill side
 * when it fits (shorter), so it never blocks the whole sidewalk.
 */
function buildingStoop(b: BuildingDesc, terrain: Terrain, y0: number, door: BuildingLayout['door']): Stoop | null {
  const P = b.poly, n = P.length >> 1, i = door.edge, j = (i + 1) % n;
  const ax = P[i * 2], az = P[i * 2 + 1];
  const len = Math.hypot(P[j * 2] - ax, P[j * 2 + 1] - az);
  if (len < 0.5) return null;
  const ux = (P[j * 2] - ax) / len, uz = (P[j * 2 + 1] - az) / len;
  const nx = uz, nz = -ux;
  /** Sidewalk level at facade coordinates (s along the edge, o outwards). */
  const ground = (s: number, o: number) => terrain.height(ax + ux * s + nx * o, az + uz * s + nz * o) + CURB_H;
  const sc = (door.s0 + door.s1) / 2;
  const rise0 = y0 - ground(sc, 0.5);
  if (rise0 < 0.1) return null;
  const W = door.s1 - door.s0 + 0.7;
  // Boxes in facade coordinates: [s0, s1, o0, o1, top].
  const rects: number[] = [];
  if (rise0 <= 0.3) {
    // A single doorstep.
    rects.push(sc - W / 2, sc + W / 2, -IN, 0.45, y0);
  } else {
    /** Risers of a flight whose foot is at (s, o) given its run: iterate as the ground there depends on the run. */
    const risers = (foot: (run: number) => [number, number], maxRun: number) => {
      let k = Math.max(2, Math.ceil(rise0 / RISER)), rise = rise0;
      for (let it = 0; it < 4; it++) {
        const [fs, fo] = foot(Math.min(maxRun, (k - 1) * TREAD));
        rise = Math.max(0.3, y0 - ground(fs, fo));
        k = Math.max(2, Math.ceil(rise / RISER));
      }
      // Too long for the room there: steeper steps (within a walker's step height up to
      // rises of ~7 m; the flight never leaves STOOP_REACH, which collision relies on).
      const fit = Math.max(2, Math.floor(maxRun / TREAD + 1e-6) + 1);
      if (k > fit) k = fit;
      return { k, r: rise / k };
    };
    const LAND = 1.0;
    const straight = risers((run) => [sc, LAND + run + 0.15], STRAIGHT_RUN + TREAD);
    if ((straight.k - 1) * TREAD <= STRAIGHT_RUN + 1e-6) {
      rects.push(sc - W / 2, sc + W / 2, -IN, LAND, y0);
      for (let k = 1; k < straight.k; k++) rects.push(sc - W / 2, sc + W / 2, LAND + (k - 1) * TREAD, LAND + k * TREAD, y0 - k * straight.r);
    } else {
      // Along the facade (against the plinth): landing at the door, flight to one side.
      const F = 1.2, maxRun = STOOP_REACH - W / 2 - 0.5;
      const side = (dir: number) => {
        const fl = risers((run) => [sc + dir * (W / 2 + run + 0.15), F / 2], maxRun);
        const room = dir > 0 ? len - (sc + W / 2) : sc - W / 2;
        return { dir, ...fl, run: (fl.k - 1) * TREAD, room };
      };
      const a = side(1), c = side(-1);
      const fits = [a, c].filter((q) => q.run <= q.room).sort((p, q) => p.run - q.run);
      const best = fits[0] ?? (a.room - a.run >= c.room - c.run ? a : c);
      rects.push(sc - W / 2, sc + W / 2, -IN, F, y0);
      for (let k = 1; k < best.k; k++) {
        const s0 = sc + best.dir * (W / 2 + (k - 1) * TREAD), s1 = sc + best.dir * (W / 2 + k * TREAD);
        rects.push(Math.min(s0, s1), Math.max(s0, s1), -IN, F, y0 - k * best.r);
      }
    }
  }
  const boxes: number[] = [];
  const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  let foot = Infinity;
  for (let k = 0; k < rects.length; k += 5) {
    const [s0, s1, o0, o1, top] = rects.slice(k, k + 5);
    const sm = (s0 + s1) / 2, om = (o0 + o1) / 2;
    boxes.push(ax + ux * sm + nx * om, az + uz * sm + nz * om, (s1 - s0) / 2, (o1 - o0) / 2, top);
    for (const [s, o] of [[s0, o0], [s1, o0], [s1, o1], [s0, o1]]) {
      const x = ax + ux * s + nx * o, z = az + uz * s + nz * o;
      bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], z); bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], z);
      foot = Math.min(foot, terrain.height(x, z));
    }
  }
  // Below the natural terrain mesh (which sits slightly under the urban ground).
  return { ux, uz, foot: foot - 0.6, boxes, bounds };
}

/** Terrain sample spacing under footprints (m). */
const BASE_SAMPLE = 2.5;

/**
 * Ground floor level (above the highest ground anywhere under the footprint, so the terrain
 * never pokes through the floor) and plinth bottom (below the lowest). Samples the corners,
 * the edges and a grid over the inside: a hump or valley between the corners counts too.
 */
export function buildingBase(b: BuildingDesc, terrain: Terrain): { base: number; low: number } {
  let hi = -Infinity, lo = Infinity;
  const p = b.poly, n = p.length >> 1;
  const sample = (x: number, z: number) => {
    const h = terrain.height(x, z);
    if (h > hi) hi = h;
    if (h < lo) lo = h;
  };
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const ax = p[i * 2], az = p[i * 2 + 1], bx = p[((i + 1) % n) * 2], bz = p[((i + 1) % n) * 2 + 1];
    const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / BASE_SAMPLE));
    for (let t = 0; t < k; t++) sample(ax + ((bx - ax) * t) / k, az + ((bz - az) * t) / k);
    x0 = Math.min(x0, ax); x1 = Math.max(x1, ax); z0 = Math.min(z0, az); z1 = Math.max(z1, az);
  }
  const nu = Math.min(24, Math.ceil((x1 - x0) / BASE_SAMPLE)), nv = Math.min(24, Math.ceil((z1 - z0) / BASE_SAMPLE));
  for (let i = 1; i < nu; i++) for (let j = 1; j < nv; j++) {
    const x = x0 + ((x1 - x0) * i) / nu, z = z0 + ((z1 - z0) * j) / nv;
    if (pointInPoly(p, x, z)) sample(x, z);
  }
  const c = polyCentroid(p);
  if (pointInPoly(p, c[0], c[1])) sample(c[0], c[1]);
  return { base: hi + CURB_H, low: lo - 0.4 };
}

export function buildingHeight(b: BuildingDesc): number {
  return b.groundH + (b.floors - 1) * b.floorH;
}

export function floorBottom(b: BuildingDesc, f: number): number {
  return f <= 0 ? 0 : b.groundH + (f - 1) * b.floorH;
}

export function buildingTiers(b: BuildingDesc): { fromFloor: number; poly: Poly; grid: SlabGrid }[] {
  const tiers: { fromFloor: number; poly: Poly; grid: SlabGrid }[] = [{ fromFloor: 0, poly: b.poly, grid: slabGrid(b.poly) }];
  for (const [f, inset] of b.setbacks) {
    if (f <= 0 || f >= b.floors) continue;
    const sh = offset([b.poly], -inset, 'miter');
    if (!sh.length) break;
    const q = shapesToPolys(sh).sort((x, y) => Math.abs(polyArea(y)) - Math.abs(polyArea(x)))[0];
    if (Math.abs(polyArea(q)) < 60) break;
    const tp = ensureCCW(q);
    tiers.push({ fromFloor: f, poly: tp, grid: slabGrid(tp) });
  }
  return tiers;
}

/** Max panel width for blind / plain walls (no bay rhythm). */
const PLAIN_PANEL = 4;

/** Entrance door on the front edge: same bay as the facade flags. */
function doorOf(b: BuildingDesc): BuildingLayout['door'] {
  const P0 = b.poly, n0 = P0.length >> 1, fi = b.front % n0, fj = (fi + 1) % n0;
  const fL = Math.hypot(P0[fj * 2] - P0[fi * 2], P0[fj * 2 + 1] - P0[fi * 2 + 1]);
  const fBays = Math.max(1, Math.round(fL / b.bay));
  const fBayW = fL / fBays;
  const db = doorBayOf(b.seed, fBays);
  const dw = Math.min(1.3, fBayW * 0.62);
  const dc = (db + 0.5) * fBayW;
  const tt = dc / Math.max(1e-6, fL);
  return { edge: fi, s0: dc - dw / 2, s1: dc + dw / 2, x: P0[fi * 2] + (P0[fj * 2] - P0[fi * 2]) * tt, z: P0[fi * 2 + 1] + (P0[fj * 2 + 1] - P0[fi * 2 + 1]) * tt };
}

/**
 * Just the entrance steps of a building (the plinth element is always elemBase): what
 * ground and collision queries need for every building around a walker. The full layout
 * (every panel and slab tile of every storey) is far too heavy to build for all of them.
 */
export function buildingEntrance(b: BuildingDesc, terrain: Terrain): Stoop | null {
  if (b.floors <= 0) return null;
  const { base } = buildingBase(b, terrain);
  return buildingStoop(b, terrain, base + floorBottom(b, 0), doorOf(b));
}

export function buildingLayout(b: BuildingDesc, terrain: Terrain, elemBase: number): BuildingLayout {
  const { base, low } = buildingBase(b, terrain);
  const tiers = buildingTiers(b);
  const floors: FloorInfo[] = [];
  const panels: Panel[] = [];
  let e = elemBase;
  const plinth = e++;
  for (let t = 0; t < tiers.length; t++) {
    const poly = tiers[t].poly;
    const f0 = tiers[t].fromFloor, f1 = t + 1 < tiers.length ? tiers[t + 1].fromFloor : b.floors;
    const n = poly.length >> 1;
    for (let f = f0; f < f1; f++) {
      const y0 = base + floorBottom(b, f), y1 = base + floorBottom(b, f + 1);
      const start = panels.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = poly[i * 2], az = poly[i * 2 + 1], bx = poly[j * 2], bz = poly[j * 2 + 1];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 0.05) continue;
        const nx = (bz - az) / L, nz = -(bx - ax) / L;
        // Party walls of attached buildings sit slightly inside the lot line so neighbours never share a plane.
        let pax = ax, paz = az, pbx = bx, pbz = bz;
        if (t === 0 && b.attached && i !== b.front) {
          const fi = b.front % n, fj = (fi + 1) % n;
          const fx = poly[fj * 2] - poly[fi * 2], fz = poly[fj * 2 + 1] - poly[fi * 2 + 1];
          const fl = Math.hypot(fx, fz) || 1;
          if (Math.abs((fx / fl) * ((bx - ax) / L) + (fz / fl) * ((bz - az) / L)) < 0.5) {
            pax -= nx * 0.12; paz -= nz * 0.12; pbx -= nx * 0.12; pbz -= nz * 0.12;
          }
        }
        const bays = Math.max(1, Math.round(L / b.bay));
        const bayW = L / bays;
        // Group bays into panels no wider than ~4 m (keeps element counts sane on long blind walls).
        const per = Math.max(1, Math.floor(PLAIN_PANEL / bayW));
        for (let k = 0; k < bays; k += per) {
          const k1 = Math.min(bays, k + per);
          const t0 = (k * bayW) / L, t1 = (k1 * bayW) / L;
          panels.push({
            e: e++, floor: f, edge: i, bay: k,
            ax: pax + (pbx - pax) * t0, az: paz + (pbz - paz) * t0, bx: pax + (pbx - pax) * t1, bz: paz + (pbz - paz) * t1,
            y0, y1, nx, nz, u0: k * bayW, bayW, edgeLen: L,
          });
        }
      }
      const grid = tiers[t].grid;
      const tiles = new Int32Array(grid.nu * grid.nv).fill(-1);
      for (let c = 0; c < tiles.length; c++) if (grid.inside[c]) tiles[c] = e++;
      let slab = -1;
      for (let c = 0; c < tiles.length && slab < 0; c++) slab = tiles[c];
      if (slab < 0) slab = e++;
      floors.push({ f, y0, y1, tier: t, panelStart: start, panelCount: panels.length - start, slab, tiles });
    }
  }
  const roof = e++;
  const door = doorOf(b);
  const stoop = floors.length ? buildingStoop(b, terrain, floors[0].y0, door) : null;
  return { base, low, height: buildingHeight(b), tiers, floors, panels, plinth, roof, elemBase, elemCount: e - elemBase, centroid: polyCentroid(b.poly), door, stoop };
}

/** Which bay of the front facade holds the entrance door (shared by the shader flags and the simulation). */
export function doorBayOf(seed: number, bays: number): number {
  if (bays <= 2) return 0;
  return 1 + ((seed >>> 5) % Math.min(bays - 2, 3));
}
