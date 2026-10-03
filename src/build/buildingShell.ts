/**
 * Building shell geometry: walls (per floor, with procedural facade
 * parameters for the shader), plinth, cornices, roofs and rooftop equipment.
 * This is the geometry used at all distances; close-range detail (window
 * reveals, frames, balconies, fire escapes…) is added by buildingDetail.ts.
 */
import earcut from 'earcut';
import { Rng } from '../core/rng';
import { type Poly, minAreaRect, polyArea, ensureCCW, polyCentroid, pointInPoly, distPointPolyEdge, splitPolyByLine, segIntersect } from '../core/geom2';
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
function capRing(mb: MeshBuilder, outer: Poly, inner: Poly | Poly[], y: number, down = false): void {
  const flat = outer.slice();
  const holes: number[] = [];
  for (const h of (typeof inner[0] === 'number' ? [inner as Poly] : (inner as Poly[]))) {
    holes.push(flat.length / 2);
    for (const v of ensureCCW(h)) flat.push(v);
  }
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
  // A narrow neck can split the inset outline into several pieces.
  const inner = offset([poly], -0.3, 'miter').map((s) => ensureCCW(s.outer));
  if (!inner.length) return;
  mb.set('aFacade', 1, 1, 1, 0);
  walls(mb, poly, y, y + h, 0, null, -1);
  // inner faces (reverse rings so normals face inward)
  for (const ip of inner) {
    const rev: number[] = [];
    for (let i = (ip.length >> 1) - 1; i >= 0; i--) rev.push(ip[i * 2], ip[i * 2 + 1]);
    walls(mb, rev, y, y + h, 0, null, -1);
  }
  capRing(mb, poly, inner, y + h);
  void b;
}

function roof(mb: MeshBuilder, b: BuildingDesc, top: Poly, y: number, r: Rng, tint: [number, number, number], tiling: { grid: SlabGrid; tiles: Int32Array; roofElem: number } | null = null): void {
  const roofLayer = 16 + b.roofMat;
  top = ensureCCW(top);
  const obb = minAreaRect(top);
  const rect = Math.abs(polyArea(top)) / Math.max(1e-6, 4 * obb.hu * obb.hv);
  let kind = b.roof;
  if ((kind === 'gable' || kind === 'hip' || kind === 'sawtooth' || kind === 'shed') && rect < 0.8) kind = 'flat';
  if (kind === 'flat') {
    mb.set('aLayer', roofLayer).set('aFacade', 1, 1, 1, FF.Roof);
    // Inset under the parapet; a narrow neck can split it into several pieces.
    const inner = offset([top], -0.3, 'miter').map((s) => ensureCCW(s.outer));
    const ip = inner.length ? inner : [top];
    if (tiling) {
      const g = tiling.grid;
      for (let c = 0; c < tiling.tiles.length; c++) {
        if (tiling.tiles[c] < 0) continue;
        const i = Math.floor(c / g.nv), j = c % g.nv;
        const u0 = g.u0 + i * g.size, v0 = g.v0 + j * g.size, u1 = u0 + g.size, v1 = v0 + g.size;
        const rect = [...gridPoint(g, u0, v0), ...gridPoint(g, u1, v0), ...gridPoint(g, u1, v1), ...gridPoint(g, u0, v1)];
        mb.set('aElem', tiling.tiles[c]);
        for (const piece of shapesToPolys(intersection([ensureCCW(rect)], ip))) cap(mb, ensureCCW(piece), y + 0.05);
      }
      mb.set('aElem', tiling.roofElem);
    } else for (const p of ip) cap(mb, p, y + 0.05);
    if (b.style !== 'house') {
      mb.set('aLayer', b.wall);
      parapet(mb, top, y, b.style === 'glass' ? 1.4 : 0.9, b);
    }
    rooftop(mb, b, top, y, r);
    return;
  }
  if (kind === 'mansard') {
    // Steep lower slope (with dormers drawn by the shader) then a flat top.
    // The inset ring keeps one vertex per outline vertex, so every wall edge gets its own
    // slope; outlines too tight for that inset try a smaller one, else stay flat.
    const mh = 3.4;
    let inset = Math.min(2.2, Math.min(obb.hu, obb.hv) * 0.4);
    let inner: Poly | null = null;
    for (let k = 0; k < 3 && !inner; k++, inset *= 0.55) {
      const q = offsetEdges(top, new Array(top.length >> 1).fill(-inset));
      if (offsetValid(top, q)) inner = q;
    }
    if (!inner) { mb.set('aLayer', roofLayer).set('aFacade', 1, 1, 1, FF.Roof); cap(mb, top, y + 0.05); rooftop(mb, b, top, y, r); return; }
    mb.set('aLayer', roofLayer).set('aFacade', b.bay, mh, mh, FF.Roof | FF.Windows);
    slopedRing(mb, top, inner, y, y + mh);
    mb.set('aFacade', 1, 1, 1, FF.Roof);
    cap(mb, inner, y + mh);
    rooftop(mb, b, inner, y + mh, r);
    return;
  }
  // Gable / hip / shed / sawtooth: a height field of planar facets laid out in the frame of the
  // footprint's OBB, but cut to the real outline (eaves follow its edges, and where the roof
  // stands above the wall top a gable wall closes it), so trapezoids, pentagons and notched
  // footprints are covered exactly instead of by their bounding rectangle.
  // Ridge direction: along the long axis, except attached houses: parallel to the street.
  let ux = obb.ux, uz = obb.uz, hu = obb.hu, hv = obb.hv;
  if (hv > hu) { ux = -obb.uz; uz = obb.ux; const t = hu; hu = hv; hv = t; }
  let fdx = 1, fdz = 0; // street direction (attached houses)
  if (b.attached) {
    const n = b.poly.length >> 1;
    const j = (b.front + 1) % n;
    const fx = b.poly[j * 2] - b.poly[b.front * 2], fz = b.poly[j * 2 + 1] - b.poly[b.front * 2 + 1];
    const fl = Math.hypot(fx, fz) || 1;
    fdx = fx / fl; fdz = fz / fl;
    if (Math.abs((fx / fl) * ux + (fz / fl) * uz) < 0.7) { const t = hu; hu = hv; hv = t; const ox = ux; ux = -uz; uz = ox; }
  }
  const vx = -uz, vz = ux;
  const ov = 0.35; // eave overhang
  const cx = obb.cx, cz = obb.cz;
  const P = (u: number, v: number): [number, number] => [cx + ux * u + vx * v, cz + uz * u + vz * v];
  // Facet plane h = y + a + bu·u + bv·v and cut "cu·u + cv·v <= q", both given in the (u, v) frame.
  const facet = (a: number, bu: number, bv: number, cuts: number[][] = []): Facet => {
    const gx = bu * ux + bv * vx, gz = bu * uz + bv * vz;
    return { gx, gz, h0: y + a - gx * cx - gz * cz, cuts: cuts.map(([cu, cv, q]) => halfPlane(cu * ux + cv * vx, cu * uz + cv * vz, q, cx, cz)) };
  };
  const rise = hv * b.pitch;
  // Eaves: every edge overhangs, except the party walls of attached houses (edges across the street front).
  const eave = (k: number): number => {
    if (!b.attached) return ov;
    const n = top.length >> 1, j = (k + 1) % n;
    const ex = top[j * 2] - top[k * 2], ez = top[j * 2 + 1] - top[k * 2 + 1], el = Math.hypot(ex, ez) || 1;
    return Math.abs((ex / el) * fdx + (ez / el) * fdz) < 0.5 ? 0 : ov;
  };
  const eaves = offsetEdges(top, Array.from({ length: top.length >> 1 }, (_, k) => (kind === 'sawtooth' ? 0 : eave(k))));
  const wallMat = () => mb.set('aLayer', b.wall).set('aTint', ...tint).set('aFacade', 1, 1, 1, 0);
  let facets: Facet[];
  if (kind === 'gable') facets = [facet(rise, 0, b.pitch, [[0, 1, 0]]), facet(rise, 0, -b.pitch, [[0, -1, 0]])];
  else if (kind === 'shed') facets = [facet(rise * 0.5, 0, b.pitch * 0.5)];
  else if (kind === 'hip') facets = hipFacets(top, y, b.pitch);
  else {
    // Sawtooth (industrial): teeth across the long axis with glazed north faces.
    const teeth = Math.max(2, Math.round((hu * 2) / 8));
    const tw = (hu * 2) / teeth;
    const th = Math.min(3.5, tw * 0.45);
    facets = [];
    for (let k = 0; k < teeth; k++) {
      const u0 = -hu + k * tw, cuts: number[][] = [];
      if (k > 0) cuts.push([-1, 0, -u0]);
      if (k < teeth - 1) cuts.push([1, 0, u0 + tw]);
      facets.push(facet(-th * u0 / tw, th / tw, 0, cuts));
    }
    mb.set('aLayer', roofLayer).set('aFacade', 1, 1, 1, FF.Roof);
    for (const f of facets) facetSurface(mb, eaves, f);
    // Glazing (vertical) where one tooth ends high and the next starts low, cut to the outline.
    mb.set('aLayer', 10).set('aFacade', 1.5, th, th, FF.Windows | FF.Curtain);
    for (let k = 1; k < teeth; k++) {
      const o = P(-hu + k * tw, 0);
      for (const ch of splitPolyByLine(top, o[0], o[1], vx, vz).chords) {
        // Outward (+u, the low side of the next tooth) normal: wind the quad accordingly.
        const sx = ch[2] - ch[0], sz = ch[3] - ch[1];
        const fw = sz * ux - sx * uz > 0;
        const [ax, az, bx, bz] = fw ? ch : [ch[2], ch[3], ch[0], ch[1]];
        const L = Math.hypot(bx - ax, bz - az);
        const i0 = mb.v(ax, y, az, ux, 0, uz, 0, 0);
        mb.v(bx, y, bz, ux, 0, uz, L, 0);
        mb.v(bx, y + th, bz, ux, 0, uz, L, th);
        mb.v(ax, y + th, az, ux, 0, uz, 0, th);
        mb.quad(i0, i0 + 3, i0 + 2, i0 + 1);
      }
    }
    // End walls under the teeth; outline edges facing +u close the last tooth with glazing.
    roofWalls(mb, top, y, facets, (nx, nz) => {
      if (nx * ux + nz * uz > 0.7) mb.set('aLayer', 10).set('aTint', ...tint).set('aFacade', 1.5, th, th, FF.Windows | FF.Curtain);
      else wallMat();
    });
    return;
  }
  mb.set('aLayer', roofLayer).set('aFacade', 1, 1, 1, FF.Roof);
  for (const f of facets) facetSurface(mb, eaves, f);
  // Gable walls wherever the roof stands above the wall top (gable ends, notches, slanted edges).
  roofWalls(mb, top, y, facets, wallMat);
  // Chimneys for houses / old town, on the roof (not over an empty corner of the bounding box).
  if (!SIMPLE && (b.style === 'house' || b.style === 'oldstone' || b.style === 'timber' || b.style === 'rowhouse') && kind !== 'hip') {
    mb.set('aLayer', 0).set('aFacade', 1, 1, 1, 0).set('aTint', 0.9, 0.85, 0.8);
    for (let t = 0; t < 6; t++) {
      const p = P(r.range(-hu * 0.6, hu * 0.6), r.range(-hv * 0.4, hv * 0.4));
      if (!pointInPoly(top, p[0], p[1]) || distPointPolyEdge(top, p[0], p[1]) < 0.8) continue;
      mb.box(p[0], y + rise * 0.6 + 0.8, p[1], 0.35, rise * 0.6 + 1.0, 0.45, Math.atan2(ux, uz));
      break;
    }
  }
  if (!SIMPLE && kind === 'hip' && b.style === 'house' && r.chance(0.6)) {
    mb.set('aLayer', 0).set('aFacade', 1, 1, 1, 0).set('aTint', 0.9, 0.85, 0.8);
    const ridge = Math.max(0, hu - hv);
    const p = P(r.range(-ridge, ridge), 0);
    if (pointInPoly(top, p[0], p[1]) && distPointPolyEdge(top, p[0], p[1]) > 0.8) mb.box(p[0], fieldHeight(facets, p[0], p[1]) + 0.4, p[1], 0.35, 1.0, 0.45, Math.atan2(ux, uz));
  }
}

/**
 * Planar roof facet: height h0 + gx·x + gz·z over the part of the roof outline where every
 * cut [nx, nz, d] (unit normal) holds: nx·x + nz·z <= d. The facets of a roof tile the plane.
 */
interface Facet { gx: number; gz: number; h0: number; cuts: number[][] }

/** Half-plane "n·(p - c) <= q" in world coordinates, with a unit normal. */
function halfPlane(nx: number, nz: number, q: number, cx: number, cz: number): number[] {
  const l = Math.hypot(nx, nz) || 1;
  return [nx / l, nz / l, (q + nx * cx + nz * cz) / l];
}

/** Roof height at (x, z): the facet whose cuts hold (the least violated one on boundaries). */
function fieldHeight(facets: Facet[], x: number, z: number): number {
  let best = facets[0], bv = Infinity;
  for (const f of facets) {
    let v = 0;
    for (const c of f.cuts) v = Math.max(v, c[0] * x + c[1] * z - c[2]);
    if (v < bv) { bv = v; best = f; }
  }
  return best.h0 + best.gx * x + best.gz * z;
}

/**
 * Hip roof over any footprint: every edge of the convex hull carries a plane rising inwards at
 * the pitch, the roof is their minimum (for a convex footprint that is its straight skeleton:
 * ridge plus hips). Notches of a concave footprint get gable walls up to that surface.
 */
function hipFacets(poly: Poly, y: number, pitch: number): Facet[] {
  const H = convexHull(poly);
  const n = H.length >> 1;
  // Inward unit normal m and offset c per hull edge: distance inside = m·p - c.
  const m: number[][] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = H[j * 2] - H[i * 2], ez = H[j * 2 + 1] - H[i * 2 + 1], l = Math.hypot(ex, ez);
    if (l < 1e-3) continue;
    const mx = -ez / l, mz = ex / l;
    m.push([mx, mz, mx * H[i * 2] + mz * H[i * 2 + 1]]);
  }
  return m.map((a, i) => ({
    gx: a[0] * pitch, gz: a[1] * pitch, h0: y - a[2] * pitch,
    // This plane is the lowest where (m_i - m_j)·p <= c_i - c_j for every other edge j.
    cuts: m.filter((_, j) => j !== i && Math.hypot(a[0] - m[j][0], a[1] - m[j][1]) > 1e-4).map((o) => halfPlane(a[0] - o[0], a[1] - o[1], a[2] - o[2], 0, 0)),
  }));
}

/** Convex hull (CCW) of a polygon's vertices, monotone chain. */
function convexHull(p: Poly): Poly {
  const pts: [number, number][] = [];
  for (let i = 0; i < p.length; i += 2) pts.push([p[i], p[i + 1]]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [], hi: [number, number][] = [];
  for (const q of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 1e-9) lo.pop(); lo.push(q); }
  for (let i = pts.length - 1; i >= 0; i--) { const q = pts[i]; while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], q) <= 1e-9) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1)).flat();
}

/** The parts of a polygon where all of a facet's cuts hold. */
function facetPieces(poly: Poly, cuts: number[][]): Poly[] {
  let pieces = [poly];
  for (const [nx, nz, d] of cuts) {
    const next: Poly[] = [];
    for (const p of pieces) {
      for (const q of splitPolyByLine(p, nx * d, nz * d, -nz, nx).pieces) {
        // Pieces lie on one side of the line: judge by the vertex farthest from it.
        let s = 0;
        for (let k = 0; k < q.length; k += 2) { const e = nx * q[k] + nz * q[k + 1] - d; if (Math.abs(e) > Math.abs(s)) s = e; }
        if (s <= 0) next.push(q);
      }
    }
    pieces = next;
  }
  return pieces;
}

/** Roof surface of one facet over the roof outline: triangulated, uv in metres (v up the slope). */
function facetSurface(mb: MeshBuilder, outline: Poly, f: Facet): void {
  const g = Math.hypot(f.gx, f.gz);
  const l = Math.hypot(f.gx, f.gz, 1);
  const nx = -f.gx / l, ny = 1 / l, nz = -f.gz / l;
  const sx = g > 1e-6 ? f.gx / g : 1, sz = g > 1e-6 ? f.gz / g : 0, sl = Math.sqrt(1 + g * g);
  for (const piece of facetPieces(outline, f.cuts)) {
    const tris = earcut(piece, undefined, 2);
    const base = mb.vcount;
    for (let i = 0; i < piece.length; i += 2) {
      const x = piece[i], z = piece[i + 1];
      mb.v(x, f.h0 + f.gx * x + f.gz * z, z, nx, ny, nz, -x * sz + z * sx, (x * sx + z * sz) * sl);
    }
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i], b = tris[i + 1], c = tris[i + 2];
      const cr = (piece[b * 2] - piece[a * 2]) * (piece[c * 2 + 1] - piece[a * 2 + 1]) - (piece[b * 2 + 1] - piece[a * 2 + 1]) * (piece[c * 2] - piece[a * 2]);
      if (cr < 0) mb.tri(base + a, base + b, base + c);
      else mb.tri(base + a, base + c, base + b);
    }
  }
}

/**
 * Vertical walls on the edges of the wall-top polygon (at y) up to the roof surface where it
 * stands above them: gable ends, sawtooth ends, notches and slanted edges under a pitched roof.
 * `mat` sets the material per edge from its outward normal.
 */
function roofWalls(mb: MeshBuilder, poly: Poly, y: number, facets: Facet[], mat: (nx: number, nz: number) => void): void {
  const n = poly.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[i * 2], az = poly[i * 2 + 1], dx = poly[j * 2] - ax, dz = poly[j * 2 + 1] - az;
    const L = Math.hypot(dx, dz);
    if (L < 0.05) continue;
    const nx = dz / L, nz = -dx / L;
    // Breakpoints: where the edge crosses a facet boundary.
    const ts = [0, 1];
    for (const f of facets) for (const c of f.cuts) {
      const den = c[0] * dx + c[1] * dz;
      if (Math.abs(den) < 1e-9) continue;
      const t = (c[2] - c[0] * ax - c[1] * az) / den;
      if (t > 1e-6 && t < 1 - 1e-6) ts.push(t);
    }
    ts.sort((p, q) => p - q);
    let matSet = false;
    for (let k = 0; k + 1 < ts.length; k++) {
      const t0 = ts[k], t1 = ts[k + 1];
      if (t1 - t0 < 1e-6) continue;
      const tm = (t0 + t1) / 2;
      // Facet under this stretch (by its midpoint), evaluated at both ends (sawtooth steps are discontinuous).
      let f = facets[0], bv = Infinity;
      for (const g of facets) {
        let v = 0;
        for (const c of g.cuts) v = Math.max(v, c[0] * (ax + dx * tm) + c[1] * (az + dz * tm) - c[2]);
        if (v < bv) { bv = v; f = g; }
      }
      const x0 = ax + dx * t0, z0 = az + dz * t0, x1 = ax + dx * t1, z1 = az + dz * t1;
      const h0 = Math.max(0, f.h0 + f.gx * x0 + f.gz * z0 - y), h1 = Math.max(0, f.h0 + f.gx * x1 + f.gz * z1 - y);
      if (h0 < 0.01 && h1 < 0.01) continue;
      if (!matSet) { mat(nx, nz); matSet = true; }
      const i0 = mb.v(x0, y, z0, nx, 0, nz, t0 * L, 0);
      mb.v(x1, y, z1, nx, 0, nz, t1 * L, 0);
      mb.v(x1, y + h1, z1, nx, 0, nz, t1 * L, h1);
      mb.v(x0, y + h0, z0, nx, 0, nz, t0 * L, h0);
      mb.quad(i0, i0 + 3, i0 + 2, i0 + 1);
    }
  }
}

/**
 * Offset each edge of a CCW polygon outwards by its own distance (mitred; negative = inwards).
 * Vertex k of the result belongs to vertex k of the input. Outward mitres are capped.
 */
function offsetEdges(p: Poly, d: number[]): Poly {
  const n = p.length >> 1;
  const out: Poly = [];
  let dmax = 0;
  for (const v of d) dmax = Math.max(dmax, Math.abs(v));
  for (let k = 0; k < n; k++) {
    const i = (k + n - 1) % n, j = (k + 1) % n;
    const px = p[k * 2], pz = p[k * 2 + 1];
    const ax = px - p[i * 2], az = pz - p[i * 2 + 1], la = Math.hypot(ax, az) || 1;
    const bx = p[j * 2] - px, bz = p[j * 2 + 1] - pz, lb = Math.hypot(bx, bz) || 1;
    const n1x = az / la, n1z = -ax / la, n2x = bz / lb, n2z = -bx / lb;
    const det = n1x * n2z - n1z * n2x;
    let wx: number, wz: number;
    if (Math.abs(det) < 1e-3) { const m = (d[i] + d[k]) / 2; wx = n2x * m; wz = n2z * m; }
    else {
      wx = (d[i] * n2z - n1z * d[k]) / det;
      wz = (n1x * d[k] - d[i] * n2x) / det;
      const wl = Math.hypot(wx, wz), cap = 3 * dmax;
      if (d[i] >= 0 && d[k] >= 0 && wl > cap) { wx *= cap / wl; wz *= cap / wl; }
    }
    out.push(px + wx, pz + wz);
  }
  return out;
}

/** Is a ring simple (no two non-adjacent edges intersect), CCW, and has every edge kept its direction? */
function offsetValid(src: Poly, p: Poly): boolean {
  const n = p.length >> 1;
  if (polyArea(p) <= 0) return false;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = p[j * 2] - p[i * 2], dz = p[j * 2 + 1] - p[i * 2 + 1];
    if (dx * (src[j * 2] - src[i * 2]) + dz * (src[j * 2 + 1] - src[i * 2 + 1]) <= 0.01) return false;
    for (let k = i + 2; k < n; k++) {
      if ((k + 1) % n === i) continue;
      const l = (k + 1) % n;
      if (segIntersect(p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1], p[k * 2], p[k * 2 + 1], p[l * 2], p[l * 2 + 1])) return false;
    }
  }
  return true;
}

/** Sloped ring from an outer polygon at y0 to an inset polygon at y1 (mansard). Vertex k of inner belongs to vertex k of outer. */
function slopedRing(mb: MeshBuilder, outer: Poly, inner: Poly, y0: number, y1: number): void {
  const n = outer.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = [outer[i * 2], y0, outer[i * 2 + 1]], b = [outer[j * 2], y0, outer[j * 2 + 1]];
    const c = [inner[j * 2], y1, inner[j * 2 + 1]], d = [inner[i * 2], y1, inner[i * 2 + 1]];
    // uv: u along edge, v up the slope; facade params let the shader draw dormers.
    const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (L < 0.01) continue;
    const ex = b[0] - a[0], ez = b[2] - a[2];
    // Normal: outward edge normal tilted up by the slope.
    const ox = ez / L, oz = -ex / L;
    const run = Math.max(1e-3, ((a[0] + b[0] - c[0] - d[0]) * ox + (a[2] + b[2] - c[2] - d[2]) * oz) / 2);
    const nl = Math.hypot(y1 - y0, run);
    const nx = (ox * (y1 - y0)) / nl, ny = run / nl, nz = (oz * (y1 - y0)) / nl;
    // u of the inner corners: their position along the edge, so the shader's bays stay vertical.
    const uc = ((c[0] - a[0]) * ex + (c[2] - a[2]) * ez) / L, ud = ((d[0] - a[0]) * ex + (d[2] - a[2]) * ez) / L;
    const i0 = mb.v(a[0], a[1], a[2], nx, ny, nz, 0, 0);
    mb.v(b[0], b[1], b[2], nx, ny, nz, L, 0);
    mb.v(c[0], c[1], c[2], nx, ny, nz, uc, y1 - y0);
    mb.v(d[0], d[1], d[2], nx, ny, nz, ud, y1 - y0);
    // Outward/up-facing winding (same as the walls: a, d, c, b).
    mb.quad(i0, i0 + 3, i0 + 2, i0 + 1);
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
