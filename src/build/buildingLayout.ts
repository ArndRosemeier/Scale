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
  const i = Math.floor((dx * g.ux + dz * g.uz - g.u0) / g.size), j = Math.floor((-dx * g.uz + dz * g.ux - g.v0) / g.size);
  return i < 0 || j < 0 || i >= g.nu || j >= g.nv ? -1 : i * g.nv + j;
}

function slabGrid(poly: Poly): SlabGrid {
  const o = minAreaRect(poly);
  const area = Math.abs(polyArea(poly));
  // ~4 m tiles, at most ~48 per storey.
  const size = Math.max(4, Math.sqrt(area / 48));
  const nu = Math.max(1, Math.ceil((o.hu * 2) / size)), nv = Math.max(1, Math.ceil((o.hv * 2) / size));
  const g: SlabGrid = { cx: o.cx, cz: o.cz, ux: o.ux, uz: o.uz, u0: -o.hu, v0: -o.hv, size, nu, nv, inside: new Uint8Array(nu * nv) };
  // Deterministic overlap test (same on the worker and the main thread): any of 9 samples inside.
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    let hit = false;
    for (const a of [0.02, 0.5, 0.98]) for (const c of [0.02, 0.5, 0.98]) {
      const [x, z] = gridPoint(g, g.u0 + (i + a) * size, g.v0 + (j + c) * size);
      if (!hit && pointInPoly(poly, x, z)) hit = true;
    }
    g.inside[i * nv + j] = hit ? 1 : 0;
  }
  return g;
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
}

export function buildingBase(b: BuildingDesc, terrain: Terrain): { base: number; low: number } {
  let hi = -Infinity, lo = Infinity;
  const p = b.poly;
  for (let i = 0; i < p.length; i += 2) {
    const h = terrain.height(p[i], p[i + 1]);
    if (h > hi) hi = h;
    if (h < lo) lo = h;
  }
  const c = polyCentroid(p);
  const hc = terrain.height(c[0], c[1]);
  hi = Math.max(hi, hc); lo = Math.min(lo, hc);
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
  // Door: same bay as the facade flags.
  const P0 = b.poly, n0 = P0.length >> 1, fi = b.front % n0, fj = (fi + 1) % n0;
  const fL = Math.hypot(P0[fj * 2] - P0[fi * 2], P0[fj * 2 + 1] - P0[fi * 2 + 1]);
  const fBays = Math.max(1, Math.round(fL / b.bay));
  const fBayW = fL / fBays;
  const db = doorBayOf(b.seed, fBays);
  const dw = Math.min(1.3, fBayW * 0.62);
  const dc = (db + 0.5) * fBayW;
  const tt = dc / Math.max(1e-6, fL);
  const door = { edge: fi, s0: dc - dw / 2, s1: dc + dw / 2, x: P0[fi * 2] + (P0[fj * 2] - P0[fi * 2]) * tt, z: P0[fi * 2 + 1] + (P0[fj * 2 + 1] - P0[fi * 2 + 1]) * tt };
  return { base, low, height: buildingHeight(b), tiers, floors, panels, plinth, roof, elemBase, elemCount: e - elemBase, centroid: polyCentroid(b.poly), door };
}

/** Which bay of the front facade holds the entrance door (shared by the shader flags and the simulation). */
export function doorBayOf(seed: number, bays: number): number {
  if (bays <= 2) return 0;
  return 1 + ((seed >>> 5) % Math.min(bays - 2, 3));
}
