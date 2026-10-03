/**
 * Building shell geometry: walls (per floor, with procedural facade
 * parameters for the shader), plinth, cornices, roofs and rooftop equipment.
 * This is the geometry used at all distances; close-range detail (window
 * reveals, frames, balconies, fire escapes…) is added by buildingDetail.ts.
 */
import earcut from 'earcut';
import { Rng } from '../core/rng';
import { type Poly, minAreaRect, polyArea, ensureCCW, polyCentroid, pointInPoly } from '../core/geom2';
import { offset, shapesToPolys, intersection } from '../core/clip';
import { gridPoint, type SlabGrid } from './buildingLayout';
import type { Terrain } from '../world/terrain';
import type { BuildingDesc } from '../plan/building';
import { MeshBuilder } from './meshBuilder';
import { buildingLayout, doorBayOf, type BuildingLayout, type FloorInfo } from './buildingLayout';

/** Facade flags (bit field stored in aFacade.w). */
export const enum FF {
  Windows = 1,
  Shop = 2,
  Curtain = 4,
  Arched = 8,
  Balcony = 16,
  Shutters = 32,
  Blind = 64,      // attached side wall, no openings
  Roof = 128,      // roof surface (no windows; roof material)
  Front = 256,     // main street facade (entrance door)
}

export function facadeSpecs() {
  return [
    { name: 'uv', size: 2 },
    { name: 'aLayer', size: 1 },
    { name: 'aTint', size: 3, type: 'u8n' as const },
    { name: 'aFacade', size: 4 },
    { name: 'aSeed', size: 1 },
    { name: 'aElem', size: 1 },
  ];
}

/** Palettes for tintable walls (plaster, stucco, siding) and general variation. */
const PASTELS: [number, number, number][] = [
  [0.93, 0.89, 0.80], [0.95, 0.86, 0.66], [0.90, 0.78, 0.62], [0.93, 0.80, 0.74], [0.82, 0.86, 0.80],
  [0.80, 0.85, 0.90], [0.96, 0.95, 0.92], [0.88, 0.70, 0.55], [0.97, 0.92, 0.82], [0.75, 0.80, 0.74],
  [0.92, 0.83, 0.85], [0.85, 0.75, 0.60],
];
const SIDING: [number, number, number][] = [
  [0.95, 0.95, 0.93], [0.78, 0.84, 0.88], [0.80, 0.82, 0.72], [0.62, 0.68, 0.72], [0.92, 0.88, 0.76], [0.72, 0.52, 0.45], [0.55, 0.62, 0.55],
];

export interface BuildingGeomInfo {
  base: number;
  low: number;
  height: number;
  /** Elements: floors + roof. */
  elemCount: number;
  /** Top of walls per tier for queries. */
  topY: number;
}

export { buildingBase, buildingHeight } from './buildingLayout';

/** Simplified geometry (LOD1): no rooftop equipment or chimneys. */
let SIMPLE = false;

const CLASSICAL = new Set(['rowhouse', 'tenement', 'haussmann', 'artdeco', 'oldstone', 'mediterranean', 'church']);

/**
 * Which part to build: the whole building, the visible shell without the storey slabs, or
 * only the slabs. Slabs are ~60% of a tower's triangles but are seen only through broken
 * walls, so cells stream the shell and a building's slabs are built when it is first damaged.
 */
export type ShellPart = 'all' | 'shell' | 'slabs';

export function buildBuildingShell(mb: MeshBuilder, b: BuildingDesc, elemBase: number, terrain: Terrain, lod = 0, part: ShellPart = 'all'): BuildingGeomInfo & { layout: BuildingLayout } {
  SIMPLE = lod > 0;
  const r = new Rng(b.seed);
  const L = buildingLayout(b, terrain, elemBase);
  const { base, low } = L;
  const H = L.height;
  const seedF = (b.seed % 10007) / 10007;

  // Tint.
  let tint: [number, number, number];
  if (b.wall === 6 || b.wall === 7) tint = PASTELS[b.seed % PASTELS.length];
  else if (b.wall === 14) tint = SIDING[b.seed % SIDING.length];
  else {
    const v = 0.88 + r.float() * 0.2;
    tint = [v * (0.97 + r.float() * 0.06), v, v * (0.97 + r.float() * 0.06)];
  }
  const trimTint: [number, number, number] = b.style === 'haussmann' || b.style === 'artdeco' ? [tint[0] * 1.02, tint[1] * 1.02, tint[2] * 1.02] : [0.92, 0.9, 0.86];

  // Facade flags by style.
  let flags = FF.Windows;
  if (b.style === 'glass') flags |= FF.Curtain;
  if (b.style === 'church') flags |= FF.Arched;
  if (b.style === 'haussmann') flags |= FF.Balcony;
  if ((b.style === 'oldstone' || b.style === 'mediterranean') && r.chance(0.6)) flags |= FF.Shutters;
  if (b.style === 'oldstone' && r.chance(0.25)) flags |= FF.Arched;
  if (b.style === 'modern' && r.chance(0.6)) flags |= FF.Balcony;
  if (b.style === 'garage') flags &= ~FF.Windows;

  const tiers = L.tiers;
  mb.set('aSeed', seedF);
  mb.set('aTint', ...tint);

  // ---- plinth (foundation on slopes)
  if (base - low > 0.25) {
    mb.set('aLayer', 13).set('aFacade', 2, 3, 3, 0).set('aElem', L.plinth);
    mb.set('aTint', tint[0] * 0.8, tint[1] * 0.8, tint[2] * 0.8);
    walls(mb, b.poly, low, base, 0, null, -1);
    mb.set('aTint', ...tint);
  }
  // ---- entrance steps up to a raised ground floor (same stone, breaks with the plinth)
  if (L.stoop) {
    const S = L.stoop;
    mb.set('aLayer', 13).set('aFacade', 2, 3, 3, 0).set('aElem', L.plinth);
    mb.set('aTint', tint[0] * 0.85, tint[1] * 0.85, tint[2] * 0.85);
    // Local x along the facade, local -z outwards; no bottom face, no back face (against the plinth).
    const yaw = Math.atan2(-S.uz, S.ux);
    for (let k = 0; k < S.boxes.length; k += 5) {
      const hy = (S.boxes[k + 4] - S.foot) / 2;
      mb.box(S.boxes[k], S.foot + hy, S.boxes[k + 1], S.boxes[k + 2], hy, S.boxes[k + 3], yaw, 1 | 2 | 4 | 32);
    }
    mb.set('aTint', ...tint);
  }

  // ---- wall panels (one element per bay group per floor) and floor slabs
  mb.set('aLayer', b.wall);
  // Slab tile pieces per tier (clipped once, reused for every storey of the tier).
  const tierPieces = new Map<number, { ip: number[]; tiles: Map<number, number[][]> }>();
  for (const fl of L.floors) {
    const poly = tiers[fl.tier].poly;
    if (part === 'slabs') {
      if (lod === 0) emitSlab(fl, poly);
      continue;
    }
    if (lod > 0) {
      // LOD1: one quad per edge and floor (element = the middle panel, so collapses still show).
      let k = fl.panelStart;
      const end = fl.panelStart + fl.panelCount;
      while (k < end) {
        const p0 = L.panels[k];
        let k1 = k;
        while (k1 + 1 < end && L.panels[k1 + 1].edge === p0.edge) k1++;
        const p1 = L.panels[k1];
        const pm = L.panels[(k + k1) >> 1];
        let ef = edgeFlags(flags, b, poly, p0.edge);
        if (ef & FF.Front) ef += doorBayOf(b.seed, Math.round(p0.edgeLen / p0.bayW)) * 512;
        mb.set('aElem', pm.e).set('aFacade', p0.bayW, b.floorH, b.groundH, ef);
        const v0 = p0.y0 - base, v1 = p0.y1 - base;
        const u1 = p0.u0 + p0.edgeLen;
        const i0 = mb.v(p0.ax, p0.y0, p0.az, p0.nx, 0, p0.nz, p0.u0, v0);
        mb.v(p1.bx, p0.y0, p1.bz, p0.nx, 0, p0.nz, u1, v0);
        mb.v(p1.bx, p0.y1, p1.bz, p0.nx, 0, p0.nz, u1, v1);
        mb.v(p0.ax, p0.y1, p0.az, p0.nx, 0, p0.nz, p0.u0, v1);
        mb.quad(i0, i0 + 3, i0 + 2, i0 + 1);
        k = k1 + 1;
      }
      continue;
    }
    for (let k = fl.panelStart; k < fl.panelStart + fl.panelCount; k++) {
      const p = L.panels[k];
      let ef = edgeFlags(flags, b, poly, p.edge);
      if (ef & FF.Front) ef += doorBayOf(b.seed, Math.round(p.edgeLen / p.bayW)) * 512;
      mb.set('aElem', p.e).set('aFacade', p.bayW, b.floorH, b.groundH, ef);
      const v0 = p.y0 - base, v1 = p.y1 - base;
      const u1 = p.u0 + Math.hypot(p.bx - p.ax, p.bz - p.az);
      const i0 = mb.v(p.ax, p.y0, p.az, p.nx, 0, p.nz, p.u0, v0);
      mb.v(p.bx, p.y0, p.bz, p.nx, 0, p.nz, u1, v0);
      mb.v(p.bx, p.y1, p.bz, p.nx, 0, p.nz, u1, v1);
      mb.v(p.ax, p.y1, p.az, p.nx, 0, p.nz, p.u0, v1);
      mb.quad(i0, i0 + 3, i0 + 2, i0 + 1);
    }
    if (part === 'all') emitSlab(fl, poly);
  }
  if (part === 'slabs') return { base, low, height: H, elemCount: L.elemCount, topY: base + H, layout: L };

  /** Slab: floor and ceiling of a storey, one piece per slab tile so floors break up piece by piece. */
  function emitSlab(fl: FloorInfo, poly: number[]): void {
    let tp = tierPieces.get(fl.tier);
    if (!tp) {
      const inner = offset([poly], -0.25, 'miter');
      tierPieces.set(fl.tier, (tp = { ip: inner.length ? ensureCCW(inner[0].outer) : poly, tiles: new Map() }));
    }
    const grid = L.tiers[fl.tier].grid;
    mb.set('aLayer', 8).set('aFacade', 1, 1, 1, FF.Roof).set('aTint', 0.82, 0.8, 0.77);
    for (let c = 0; c < fl.tiles.length; c++) {
      if (fl.tiles[c] < 0) continue;
      let polys = tp.tiles.get(c);
      if (!polys) {
        const i = Math.floor(c / grid.nv), j = c % grid.nv;
        const u0 = grid.u0 + i * grid.size, v0 = grid.v0 + j * grid.size, u1 = u0 + grid.size, v1 = v0 + grid.size;
        const rect = [...gridPoint(grid, u0, v0), ...gridPoint(grid, u1, v0), ...gridPoint(grid, u1, v1), ...gridPoint(grid, u0, v1)];
        tp.tiles.set(c, (polys = shapesToPolys(intersection([ensureCCW(rect)], [tp.ip])).map(ensureCCW)));
      }
      mb.set('aElem', fl.tiles[c]);
      for (const q of polys) {
        cap(mb, q, fl.y0 + 0.02);
        cap(mb, q, fl.y1 - 0.02, true);
      }
    }
    mb.set('aLayer', b.wall).set('aTint', ...tint);
  }
  // Terrace caps and parapets where a tier steps in.
  for (let t = 0; t + 1 < tiers.length; t++) {
    const f1 = tiers[t + 1].fromFloor;
    const y = base + L.floors.find((fl) => fl.f === f1)!.y0 - base;
    const slabElem = L.floors.find((fl) => fl.f === f1 - 1)!.slab;
    mb.set('aLayer', 16).set('aFacade', 1, 1, 1, FF.Roof).set('aElem', slabElem);
    capRing(mb, tiers[t].poly, tiers[t + 1].poly, y);
    mb.set('aLayer', b.wall);
    parapet(mb, tiers[t].poly, y, 1.1, b);
  }
  const top = tiers[tiers.length - 1].poly;
  const topY = base + H;

  // ---- cornices and string courses (classical styles)
  if (lod === 0 && CLASSICAL.has(b.style) && b.floors >= 2) {
    mb.set('aLayer', b.style === 'tenement' || b.style === 'rowhouse' ? 4 : b.wall).set('aTint', ...trimTint).set('aFacade', 1, 1, 1, 0);
    mb.set('aElem', L.roof);
    band(mb, top, topY - 0.05, 0.55, b.style === 'artdeco' ? 0.15 : 0.45);
    mb.set('aElem', L.floors[0].slab);
    if (b.floors > 2) band(mb, b.poly, base + b.groundH - 0.1, 0.3, 0.12);
    mb.set('aTint', ...tint);
  }

  // ---- roof
  mb.set('aElem', L.roof);
  // Flat roofs are tiled like the top storey's slab, so they break and fall with it.
  const topFl = L.floors[L.floors.length - 1];
  roof(mb, b, top, topY, r, tint, topFl ? { grid: L.tiers[topFl.tier].grid, tiles: topFl.tiles, roofElem: L.roof } : null);

  return { base, low, height: H, elemCount: L.elemCount, topY, layout: L };
}

/** Facade flags for one edge of a tier polygon. */
function edgeFlags(flags: number, b: BuildingDesc, poly: Poly, i: number): number {
  let f = flags;
  const front = b.front;
  if (poly === b.poly) {
    if (b.attached && i !== front && isSideEdge(poly, i, front)) f = (f & ~(FF.Windows | FF.Shop | FF.Balcony)) | FF.Blind;
    if (b.shopfront && i === front) f |= FF.Shop;
    if (i === front) f |= FF.Front;
  }
  return f;
}

/** Walls of a polygon between y0 and y1. u runs along each edge from its start. */
function walls(mb: MeshBuilder, poly: Poly, y0: number, y1: number, flags: number, b: BuildingDesc | null, front: number, base = y0): void {
  const n = poly.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[i * 2], az = poly[i * 2 + 1], bx = poly[j * 2], bz = poly[j * 2 + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.05) continue;
    // Outward normal of a CCW polygon (x right, z "up" in plan) is the right normal.
    const nx = (bz - az) / L, nz = -(bx - ax) / L;
    if (b) {
      const bayN = Math.max(1, Math.round(L / b.bay));
      let f = flags;
      // Attached side walls of perimeter buildings are blind (party walls).
      if (b.attached && i !== front && isSideEdge(poly, i, front)) f = (f & ~(FF.Windows | FF.Shop | FF.Balcony)) | FF.Blind;
      if (b.shopfront && i === front) f |= FF.Shop;
      if (i === front) f |= FF.Front;
      // Back facades: no shop, simpler.
      if (i !== front && !isSideEdge(poly, i, front)) f &= ~FF.Shop;
      mb.set('aFacade', L / bayN, b.floorH, b.groundH, f);
    }
    const v0 = y0 - base, v1 = y1 - base;
    const i0 = mb.v(ax, y0, az, nx, 0, nz, 0, v0);
    mb.v(bx, y0, bz, nx, 0, nz, L, v0);
    mb.v(bx, y1, bz, nx, 0, nz, L, v1);
    mb.v(ax, y1, az, nx, 0, nz, 0, v1);
    mb.quad(i0, i0 + 3, i0 + 2, i0 + 1);
  }
}

/** Edges adjacent (by index) to the front edge whose direction is roughly perpendicular count as side walls. */
function isSideEdge(poly: Poly, i: number, front: number): boolean {
  const n = poly.length >> 1;
  const dir = (k: number) => {
    const j = (k + 1) % n;
    const dx = poly[j * 2] - poly[k * 2], dz = poly[j * 2 + 1] - poly[k * 2 + 1];
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  };
  const f = dir(front), e = dir(i);
  return Math.abs(f[0] * e[0] + f[1] * e[1]) < 0.5;
}

/** Horizontal protruding band around a polygon (cornice / string course). */
function band(mb: MeshBuilder, poly: Poly, y: number, h: number, out: number): void {
  const sh = offset([poly], out, 'miter', 3);
  if (!sh.length) return;
  const outer = ensureCCW(sh[0].outer);
  walls(mb, outer, y, y + h, 0, null, -1);
  // top and bottom ring caps
  capRing(mb, outer, poly, y + h);
  capRing(mb, outer, poly, y, true);
}

/** Flat cap of (outer minus inner) at height y. */
function capRing(mb: MeshBuilder, outer: Poly, inner: Poly, y: number, down = false): void {
  const flat = outer.slice();
  const holes = [flat.length / 2];
  for (const v of ensureCCW(inner)) flat.push(v);
  const tris = earcut(flat, holes, 2);
  emitFlat(mb, flat, tris, y, down);
}

function cap(mb: MeshBuilder, poly: Poly, y: number, down = false): void {
  const tris = earcut(poly, undefined, 2);
  emitFlat(mb, poly, tris, y, down);
}

function emitFlat(mb: MeshBuilder, flat: number[], tris: number[], y: number, down: boolean): void {
  const base = mb.vcount;
  const ny = down ? -1 : 1;
  for (let i = 0; i < flat.length; i += 2) mb.v(flat[i], y, flat[i + 1], 0, ny, 0, flat[i], flat[i + 1]);
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i], b = tris[i + 1], c = tris[i + 2];
    const cr = (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) - (flat[b * 2 + 1] - flat[a * 2 + 1]) * (flat[c * 2] - flat[a * 2]);
    const up = cr < 0;
    if (up !== down) mb.tri(base + a, base + b, base + c);
    else mb.tri(base + a, base + c, base + b);
  }
}

function parapet(mb: MeshBuilder, poly: Poly, y: number, h: number, b: BuildingDesc): void {
  const sh = offset([poly], -0.3, 'miter');
  if (!sh.length) return;
  const inner = ensureCCW(sh[0].outer);
  mb.set('aFacade', 1, 1, 1, 0);
  walls(mb, poly, y, y + h, 0, null, -1);
  // inner face (reverse ring so normals face inward)
  const rev: number[] = [];
  for (let i = (inner.length >> 1) - 1; i >= 0; i--) rev.push(inner[i * 2], inner[i * 2 + 1]);
  walls(mb, rev, y, y + h, 0, null, -1);
  capRing(mb, poly, inner, y + h);
  void b;
}

function roof(mb: MeshBuilder, b: BuildingDesc, top: Poly, y: number, r: Rng, tint: [number, number, number], tiling: { grid: SlabGrid; tiles: Int32Array; roofElem: number } | null = null): void {
  const roofLayer = 16 + b.roofMat;
  const obb = minAreaRect(top);
  const rect = Math.abs(polyArea(top)) / Math.max(1e-6, 4 * obb.hu * obb.hv);
  let kind = b.roof;
  if ((kind === 'gable' || kind === 'hip' || kind === 'sawtooth' || kind === 'shed') && rect < 0.8) kind = 'flat';
  if (kind === 'flat') {
    mb.set('aLayer', roofLayer).set('aFacade', 1, 1, 1, FF.Roof);
    const inner = offset([top], -0.3, 'miter');
    const ip = inner.length ? ensureCCW(inner[0].outer) : top;
    if (tiling) {
      const g = tiling.grid;
      for (let c = 0; c < tiling.tiles.length; c++) {
        if (tiling.tiles[c] < 0) continue;
        const i = Math.floor(c / g.nv), j = c % g.nv;
        const u0 = g.u0 + i * g.size, v0 = g.v0 + j * g.size, u1 = u0 + g.size, v1 = v0 + g.size;
        const rect = [...gridPoint(g, u0, v0), ...gridPoint(g, u1, v0), ...gridPoint(g, u1, v1), ...gridPoint(g, u0, v1)];
        mb.set('aElem', tiling.tiles[c]);
        for (const piece of shapesToPolys(intersection([ensureCCW(rect)], [ip]))) cap(mb, ensureCCW(piece), y + 0.05);
      }
      mb.set('aElem', tiling.roofElem);
    } else cap(mb, ip, y + 0.05);
    if (b.style !== 'house') {
      mb.set('aLayer', b.wall);
      parapet(mb, top, y, b.style === 'glass' ? 1.4 : 0.9, b);
    }
    rooftop(mb, b, top, y, r);
    return;
  }
  if (kind === 'mansard') {
    // Steep lower slope (with dormers drawn by the shader) then a flat top.
    const inset = Math.min(2.2, Math.min(obb.hu, obb.hv) * 0.4);
    const sh = offset([top], -inset, 'miter');
    if (!sh.length) { mb.set('aLayer', roofLayer).set('aFacade', 1, 1, 1, FF.Roof); cap(mb, top, y); return; }
    const inner = ensureCCW(sh[0].outer);
    const mh = 3.4;
    mb.set('aLayer', roofLayer).set('aFacade', b.bay, mh, mh, FF.Roof | FF.Windows);
    slopedRing(mb, top, inner, y, y + mh);
    mb.set('aFacade', 1, 1, 1, FF.Roof);
    cap(mb, inner, y + mh);
    rooftop(mb, b, inner, y + mh, r);
    return;
  }
  // Gable / hip / shed / sawtooth on the OBB of the footprint.
  // Ridge direction: along the long axis, except attached houses: parallel to the street.
  let ux = obb.ux, uz = obb.uz, hu = obb.hu, hv = obb.hv;
  if (hv > hu) { ux = -obb.uz; uz = obb.ux; const t = hu; hu = hv; hv = t; }
  if (b.attached) {
    const n = b.poly.length >> 1;
    const j = (b.front + 1) % n;
    const fx = b.poly[j * 2] - b.poly[b.front * 2], fz = b.poly[j * 2 + 1] - b.poly[b.front * 2 + 1];
    const fl = Math.hypot(fx, fz) || 1;
    if (Math.abs((fx / fl) * ux + (fz / fl) * uz) < 0.7) { const t = hu; hu = hv; hv = t; const ox = ux; ux = -uz; uz = ox; }
  }
  const vx = -uz, vz = ux;
  const ov = 0.35; // eave overhang
  const cx = obb.cx, cz = obb.cz;
  const P = (u: number, v: number, yy: number): [number, number, number] => [cx + ux * u + vx * v, yy, cz + uz * u + vz * v];
  const rise = hv * b.pitch;
  mb.set('aLayer', roofLayer).set('aFacade', 1, 1, 1, FF.Roof);
  if (kind === 'gable' || kind === 'shed') {
    const A = hu + (b.attached ? 0 : ov), V = hv + ov, yE = y - ov * b.pitch;
    if (kind === 'gable') {
      plane(mb, P(-A, -V, yE), P(A, -V, yE), P(A, 0, y + rise), P(-A, 0, y + rise));
      plane(mb, P(A, V, yE), P(-A, V, yE), P(-A, 0, y + rise), P(A, 0, y + rise));
      // Gable end walls (triangles) in wall material.
      mb.set('aLayer', b.wall).set('aTint', ...tint).set('aFacade', 1, 1, 1, 0);
      tri(mb, P(-hu, -hv, y), P(-hu, hv, y), P(-hu, 0, y + rise));
      tri(mb, P(hu, hv, y), P(hu, -hv, y), P(hu, 0, y + rise));
    } else {
      const rise2 = hv * 2 * b.pitch * 0.5;
      plane(mb, P(-A, -V, yE), P(A, -V, yE), P(A, V, y + rise2), P(-A, V, y + rise2));
      mb.set('aLayer', b.wall).set('aFacade', 1, 1, 1, 0);
      tri(mb, P(-hu, -hv, y), P(-hu, hv, y), P(-hu, hv, y + rise2));
      tri(mb, P(hu, hv, y), P(hu, -hv, y), P(hu, hv, y + rise2));
      plane(mb, P(hu, hv, y), P(-hu, hv, y), P(-hu, hv, y + rise2), P(hu, hv, y + rise2));
    }
    // Chimneys for houses / old town.
    if (!SIMPLE && (b.style === 'house' || b.style === 'oldstone' || b.style === 'timber' || b.style === 'rowhouse')) {
      mb.set('aLayer', 0).set('aFacade', 1, 1, 1, 0).set('aTint', 0.9, 0.85, 0.8);
      const cu = r.range(-hu * 0.6, hu * 0.6), cv = r.range(-hv * 0.4, hv * 0.4);
      const p = P(cu, cv, 0);
      mb.box(p[0], y + rise * 0.6 + 0.8, p[2], 0.35, rise * 0.6 + 1.0, 0.45, Math.atan2(ux, uz));
    }
    return;
  }
  if (kind === 'hip') {
    const A = hu + ov, V = hv + ov, yE = y - ov * b.pitch;
    const ridge = Math.max(0, hu - hv);
    plane(mb, P(-A, -V, yE), P(A, -V, yE), P(ridge, 0, y + rise), P(-ridge, 0, y + rise));
    plane(mb, P(A, V, yE), P(-A, V, yE), P(-ridge, 0, y + rise), P(ridge, 0, y + rise));
    tri(mb, P(A, -V, yE), P(A, V, yE), P(ridge, 0, y + rise));
    tri(mb, P(-A, V, yE), P(-A, -V, yE), P(-ridge, 0, y + rise));
    if (!SIMPLE && b.style === 'house' && r.chance(0.6)) {
      mb.set('aLayer', 0).set('aFacade', 1, 1, 1, 0).set('aTint', 0.9, 0.85, 0.8);
      const p = P(r.range(-ridge, ridge), 0, 0);
      mb.box(p[0], y + rise + 0.4, p[2], 0.35, 1.0, 0.45, Math.atan2(ux, uz));
    }
    return;
  }
  // Sawtooth (industrial): teeth across the long axis with glazed north faces.
  const teeth = Math.max(2, Math.round((hu * 2) / 8));
  const tw = (hu * 2) / teeth;
  const th = Math.min(3.5, tw * 0.45);
  for (let k = 0; k < teeth; k++) {
    const u0 = -hu + k * tw, u1 = u0 + tw;
    mb.set('aLayer', roofLayer).set('aFacade', 1, 1, 1, FF.Roof);
    plane(mb, P(u0, hv, y), P(u0, -hv, y), P(u1, -hv, y + th), P(u1, hv, y + th));
    // glazing (vertical)
    mb.set('aLayer', 10).set('aFacade', 1.5, th, th, FF.Windows | FF.Curtain);
    plane(mb, P(u1, -hv, y), P(u1, hv, y), P(u1, hv, y + th), P(u1, -hv, y + th));
    // end triangles
    mb.set('aLayer', b.wall).set('aFacade', 1, 1, 1, 0);
    tri(mb, P(u0, -hv, y), P(u1, -hv, y), P(u1, -hv, y + th));
    tri(mb, P(u1, hv, y), P(u0, hv, y), P(u1, hv, y + th));
  }
}

function plane(mb: MeshBuilder, a: number[], b: number[], c: number[], d: number[]): void {
  // Two triangles a-b-c, a-c-d; normal from (b-a)x(d-a); UVs in meters along edges.
  const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
  const fx = d[0] - a[0], fy = d[1] - a[1], fz = d[2] - a[2];
  let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  // make normal face up/outward: if ny < 0 for roof planes flip winding
  const flip = ny < -0.01;
  if (flip) { nx = -nx; ny = -ny; nz = -nz; }
  const le = Math.hypot(ex, ey, ez), lf = Math.hypot(fx, fy, fz);
  const i0 = mb.v(a[0], a[1], a[2], nx, ny, nz, 0, 0);
  mb.v(b[0], b[1], b[2], nx, ny, nz, le, 0);
  mb.v(c[0], c[1], c[2], nx, ny, nz, le, lf);
  mb.v(d[0], d[1], d[2], nx, ny, nz, 0, lf);
  if (!flip) mb.quad(i0, i0 + 1, i0 + 2, i0 + 3);
  else mb.quad(i0, i0 + 3, i0 + 2, i0 + 1);
}

function tri(mb: MeshBuilder, a: number[], b: number[], c: number[]): void {
  const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
  const fx = c[0] - a[0], fy = c[1] - a[1], fz = c[2] - a[2];
  let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  const L = Math.hypot(ex, ez);
  const i0 = mb.v(a[0], a[1], a[2], nx, ny, nz, 0, a[1] - a[1]);
  mb.v(b[0], b[1], b[2], nx, ny, nz, L, b[1] - a[1]);
  mb.v(c[0], c[1], c[2], nx, ny, nz, L / 2, c[1] - a[1]);
  mb.tri(i0, i0 + 1, i0 + 2);
}

/** Sloped ring from an outer polygon at y0 to an inset polygon at y1 (mansard). Vertices must correspond. */
function slopedRing(mb: MeshBuilder, outer: Poly, inner: Poly, y0: number, y1: number): void {
  // Correspond vertices by nearest inner vertex to each outer vertex (miter offset preserves count usually).
  const n = outer.length >> 1;
  const m = inner.length >> 1;
  const near = (x: number, z: number) => {
    let bi = 0, bd = Infinity;
    for (let k = 0; k < m; k++) { const d = (inner[k * 2] - x) ** 2 + (inner[k * 2 + 1] - z) ** 2; if (d < bd) { bd = d; bi = k; } }
    return bi;
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ia = near(outer[i * 2], outer[i * 2 + 1]), ib = near(outer[j * 2], outer[j * 2 + 1]);
    const a = [outer[i * 2], y0, outer[i * 2 + 1]], b = [outer[j * 2], y0, outer[j * 2 + 1]];
    const c = [inner[ib * 2], y1, inner[ib * 2 + 1]], d = [inner[ia * 2], y1, inner[ia * 2 + 1]];
    // uv: u along edge, v up the slope; facade params let the shader draw dormers.
    const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const ex = b[0] - a[0], ez = b[2] - a[2];
    const fx = d[0] - a[0], fy = d[1] - a[1], fz = d[2] - a[2];
    let nx = 0 * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - 0 * fx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const i0 = mb.v(a[0], a[1], a[2], nx, ny, nz, 0, 0);
    mb.v(b[0], b[1], b[2], nx, ny, nz, L, 0);
    mb.v(c[0], c[1], c[2], nx, ny, nz, L, y1 - y0);
    mb.v(d[0], d[1], d[2], nx, ny, nz, 0, y1 - y0);
    // winding so that the normal (outward/up) is front-facing
    const crossY = ex * fz - ez * fx; // (b-a) x (d-a) y-component sign
    if (crossY < 0) mb.quad(i0, i0 + 3, i0 + 2, i0 + 1);
    else mb.quad(i0, i0 + 1, i0 + 2, i0 + 3);
  }
}

/** Rooftop equipment: HVAC units, water tanks, elevator housings, skylights. */
function rooftop(mb: MeshBuilder, b: BuildingDesc, top: Poly, y: number, r: Rng): void {
  if (SIMPLE) return;
  const area = Math.abs(polyArea(top));
  if (area < 40) return;
  const obb = minAreaRect(top);
  const yaw = Math.atan2(obb.ux, obb.uz);
  const at = (fu: number, fv: number): [number, number] => {
    const u = fu * obb.hu * 0.7, v = fv * obb.hv * 0.7;
    return [obb.cx + obb.ux * u - obb.uz * v, obb.cz + obb.uz * u + obb.ux * v];
  };
  // Equipment must stand on the roof: L/U-shaped and courtyard roofs leave much of the
  // bounding box empty (a water tank there would float in the air).
  const fits = (x: number, z: number, rad: number) => {
    if (!pointInPoly(top, x, z)) return false;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      if (!pointInPoly(top, x + Math.cos(a) * (rad + 0.4), z + Math.sin(a) * (rad + 0.4))) return false;
    }
    return true;
  };
  const place = (fu: number, fv: number, rad = 1.5): [number, number] | null => {
    for (let t = 0; t < 10; t++) {
      const s = 1 - t * 0.09; // shrink towards the centre on retries
      const p = at(fu * s + (t ? r.range(-0.2, 0.2) : 0), fv * s + (t ? r.range(-0.2, 0.2) : 0));
      if (fits(p[0], p[1], rad)) return p;
    }
    return null;
  };
  mb.set('aFacade', 1, 1, 1, 0).set('aTint', 0.85, 0.85, 0.85);
  const units = Math.min(8, Math.floor(area / 120));
  for (let k = 0; k < units; k++) {
    const w = r.range(0.8, 2.2), d = r.range(0.8, 1.8), h = r.range(0.6, 1.4);
    const pu = place(r.range(-1, 1), r.range(-1, 1), Math.hypot(w, d) / 2);
    if (!pu) continue;
    const [x, z] = pu;
    mb.set('aLayer', 11);
    mb.box(x, y + h / 2, z, w / 2, h / 2, d / 2, yaw);
  }
  if (b.floors >= 8 && area > 300) {
    // Elevator / stair housing.
    const hw = r.range(2.5, 4), hd = r.range(2.5, 4);
    const ph = place(r.range(-0.3, 0.3), r.range(-0.3, 0.3), Math.hypot(hw, hd));
    if (ph) {
      mb.set('aLayer', b.wall === 10 ? 9 : b.wall).set('aTint', 0.9, 0.9, 0.9);
      mb.box(ph[0], y + 1.8, ph[1], hw, 1.8, hd, yaw);
    }
  }
  if (b.style === 'tenement' || (b.style === 'artdeco' && r.chance(0.3)) || (b.style === 'rowhouse' && r.chance(0.05))) {
    // Wooden water tank on steel legs (New York style).
    const tr = r.range(1.4, 2.0), th = r.range(2.8, 3.6), legs = 2.6;
    const pt = place(r.range(-0.6, 0.6), r.range(-0.6, 0.6), tr * 1.05);
    if (!pt) return;
    const [x, z] = pt;
    mb.set('aLayer', 21).set('aTint', 0.5, 0.5, 0.5);
    for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) mb.box(x + dx * tr * 0.6, y + legs / 2, z + dz * tr * 0.6, 0.08, legs / 2, 0.08);
    mb.set('aLayer', 12).set('aTint', 0.55, 0.42, 0.32);
    cylinder(mb, x, y + legs, z, tr, th, 12);
    mb.set('aLayer', 18).set('aTint', 0.6, 0.6, 0.6);
    cone(mb, x, y + legs + th, z, tr * 1.05, 1.1, 12);
  }
}

function cylinder(mb: MeshBuilder, x: number, y: number, z: number, rad: number, h: number, seg: number): void {
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    const u0 = (i / seg) * rad * Math.PI * 2, u1 = ((i + 1) / seg) * rad * Math.PI * 2;
    const i0 = mb.v(x + c0 * rad, y, z + s0 * rad, c0, 0, s0, u0, 0);
    mb.v(x + c1 * rad, y, z + s1 * rad, c1, 0, s1, u1, 0);
    mb.v(x + c1 * rad, y + h, z + s1 * rad, c1, 0, s1, u1, h);
    mb.v(x + c0 * rad, y + h, z + s0 * rad, c0, 0, s0, u0, h);
    mb.quad(i0, i0 + 3, i0 + 2, i0 + 1);
  }
}

function cone(mb: MeshBuilder, x: number, y: number, z: number, rad: number, h: number, seg: number): void {
  const top = [x, y + h, z];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    const ny = rad / Math.hypot(rad, h), nr = h / Math.hypot(rad, h);
    const i0 = mb.v(x + c0 * rad, y, z + s0 * rad, c0 * nr, ny, s0 * nr, 0, 0);
    mb.v(x + c1 * rad, y, z + s1 * rad, c1 * nr, ny, s1 * nr, 1, 0);
    mb.v(top[0], top[1], top[2], (c0 + c1) * 0.5 * nr, ny, (s0 + s1) * 0.5 * nr, 0.5, 1);
    mb.tri(i0, i0 + 2, i0 + 1);
  }
}
