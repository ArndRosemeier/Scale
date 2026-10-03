/**
 * Cell plan: everything inside one face of the arterial network.
 *
 *  1. Local streets by recursive splitting of the cell polygon (grammar per district).
 *  2. Surfaces by polygon booleans: carriageway, sidewalks, blocks, quay promenades.
 *  3. Lots: perimeter lots (urban), free lots (suburban/industrial), tower lots (downtown).
 *  4. Buildings, plazas, parks, courtyards and street furniture.
 */
import { Rng, deriveSeed } from '../core/rng';
import { clamp, lerp } from '../core/math';
import {
  type Poly, polyArea, polyCentroid, minAreaRect, splitPolyByLine, ensureCCW, cleanPoly, pointInPoly,
  distSqPointSeg, polyBounds, resample, polylineLength, simplifyClosed,
} from '../core/geom2';
import { difference, intersection, offset, strokePolylines, union, shapesToPolys, type Shape, shapeArea } from '../core/clip';
import type { Terrain } from '../world/terrain';
import { RoadClass, type CellInfo, type District, type MacroPlan } from './types';
import { ROAD_SPEC } from './macro';
import { STYLES, pickStyle, type BuildingDesc, type StyleId } from './building';

export interface StreetSeg {
  pts: number[];
  cls: RoadClass;
  width: number;
  sidewalk: number;
  lanes: number;
  /** -1 local street; otherwise the arterial edge id. */
  arterial: number;
}

export interface Lot {
  poly: Poly;
  /** Frontage edge [ax, az, bx, bz] on the street side. */
  front: number[];
  corner: boolean;
  kind: 'perimeter' | 'free' | 'tower';
}

export const enum PropType {
  Tree = 0,
  Lamp = 1,
  Bench = 2,
  Bin = 3,
  Hydrant = 4,
  TrafficLight = 5,
  ParkedCar = 6,
  BusStop = 7,
  Bollard = 8,
  Fountain = 9,
  Statue = 10,
  Bush = 11,
  Kiosk = 12,
  Planter = 13,
  StopSign = 14,
  Hedge = 15,
  PlayGround = 16,
  MetroEntrance = 17,
  Manhole = 18,
  Mailbox = 19,
}

export interface CellPlan {
  id: number;
  district: District;
  streets: StreetSeg[];
  carriageway: Shape[];
  sidewalks: Shape[];
  blocks: Shape[];
  promenade: Shape[];
  plazas: Shape[];
  parks: Shape[];
  /** Back yards / courtyards / gardens. */
  yards: Shape[];
  /** Parking lots / industrial yards (asphalt). */
  paved: Shape[];
  lots: Lot[];
  buildings: BuildingDesc[];
  /** Props: [type, x, z, yaw, scale, variant] * n */
  props: number[];
  /** Junction points of local streets [x, z, degree] * n. */
  junctions: number[];
  bounds: [number, number, number, number];
  /** Metro entrances: [cx, cz, ux, uz, station, end] * n (opening 2.2 × 5.5 m, long axis u). */
  entrances: number[];
}

export const ENTRANCE_W = 2.2;
export const ENTRANCE_L = 5.5;

interface Grammar {
  /** Target block dimensions (short, long) in m. */
  block: [number, number];
  street: RoadClass;
  /** Probability that a grid is used instead of organic splits. */
  grid: number;
  /** Lot frontage width range. */
  lotW: [number, number];
  /** Perimeter lot depth range. */
  lotD: [number, number];
  /** Lot layout. */
  layout: 'perimeter' | 'free' | 'tower' | 'none';
  /** Street tree probability. */
  trees: number;
}

const GRAMMAR: Record<District, Grammar> = {
  downtown: { block: [70, 140], street: RoadClass.Street, grid: 0.85, lotW: [18, 42], lotD: [22, 34], layout: 'perimeter', trees: 0.35 },
  commercial: { block: [65, 130], street: RoadClass.Street, grid: 0.7, lotW: [12, 26], lotD: [16, 24], layout: 'perimeter', trees: 0.5 },
  oldtown: { block: [38, 75], street: RoadClass.Lane, grid: 0.05, lotW: [7, 13], lotD: [11, 17], layout: 'perimeter', trees: 0.15 },
  apartments: { block: [70, 140], street: RoadClass.Street, grid: 0.65, lotW: [14, 28], lotD: [13, 19], layout: 'perimeter', trees: 0.75 },
  rowhouses: { block: [60, 180], street: RoadClass.Street, grid: 0.75, lotW: [5.5, 8], lotD: [12, 16], layout: 'perimeter', trees: 0.85 },
  suburban: { block: [70, 190], street: RoadClass.Street, grid: 0.35, lotW: [17, 28], lotD: [28, 40], layout: 'free', trees: 0.8 },
  industrial: { block: [120, 240], street: RoadClass.Street, grid: 0.6, lotW: [40, 90], lotD: [40, 80], layout: 'free', trees: 0.1 },
  port: { block: [120, 220], street: RoadClass.Street, grid: 0.7, lotW: [40, 90], lotD: [40, 70], layout: 'free', trees: 0.05 },
  park: { block: [1e9, 1e9], street: RoadClass.Path, grid: 0, lotW: [0, 0], lotD: [0, 0], layout: 'none', trees: 1 },
  water: { block: [1e9, 1e9], street: RoadClass.Path, grid: 0, lotW: [0, 0], lotD: [0, 0], layout: 'none', trees: 0 },
};

const CURB_R = 4.5;

export function planCell(macro: MacroPlan, cell: CellInfo, terrain: Terrain): CellPlan {
  const p = terrain.profile;
  const rng = new Rng(deriveSeed(p.seed, 'cell', cell.id, Math.round(cell.centroid[0]), Math.round(cell.centroid[1])));
  const g = GRAMMAR[cell.district];
  const plan: CellPlan = {
    id: cell.id, district: cell.district, streets: [], carriageway: [], sidewalks: [], blocks: [], promenade: [],
    plazas: [], parks: [], yards: [], paved: [], lots: [], buildings: [], props: [], junctions: [], bounds: polyBounds(cell.poly), entrances: [],
  };

  // ---------------------------------------------------------- 1. streets
  const chords: { pts: number[]; cls: RoadClass }[] = [];
  if (g.layout !== 'none') splitStreets(cell, g, rng.fork('streets'), chords);
  // Curvy suburbs: bend chords (keeping endpoints).
  for (const c of chords) {
    if (cell.district === 'suburban' && cell.gridness < 0.5) {
      const L = Math.hypot(c.pts[2] - c.pts[0], c.pts[3] - c.pts[1]);
      if (L > 60) {
        const n = Math.ceil(L / 12);
        const amp = rng.range(-0.12, 0.12) * L;
        const dx = (c.pts[2] - c.pts[0]) / L, dz = (c.pts[3] - c.pts[1]) / L;
        const pts: number[] = [];
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const o = Math.sin(Math.PI * t) * amp;
          pts.push(c.pts[0] + (c.pts[2] - c.pts[0]) * t - dz * o, c.pts[1] + (c.pts[3] - c.pts[1]) * t + dx * o);
        }
        c.pts = pts;
      }
    }
  }
  for (const c of chords) {
    const s = ROAD_SPEC[c.cls];
    plan.streets.push({ pts: c.pts, cls: c.cls, width: s.width, sidewalk: s.sidewalk, lanes: s.lanes, arterial: -1 });
  }
  // Arterials bounding the cell.
  for (const eid of cell.edges) {
    const e = macro.edges[eid];
    plan.streets.push({ pts: e.pts, cls: e.cls, width: e.width, sidewalk: e.sidewalk, lanes: e.lanes, arterial: eid });
  }

  // --------------------------------------------------------- 2. surfaces
  const cellPolys = [cell.poly];
  const carrStrokes: Poly[] = [];
  const roadStrokes: Poly[] = [];
  for (const s of plan.streets) {
    for (const sh of strokePolylines([s.pts], s.width / 2, 'round', 'round')) carrStrokes.push(sh.outer);
    for (const sh of strokePolylines([s.pts], s.width / 2 + s.sidewalk, 'round', 'round')) roadStrokes.push(sh.outer);
  }
  // Closing (dilate→erode) rounds the curb corners at junctions.
  const carr = closeShapes(union(carrStrokes), CURB_R);
  const road = closeShapes(union(roadStrokes), CURB_R * 0.6);
  plan.carriageway = intersection(shapesToPolys(carr), cellPolys);
  const roadInCell = intersection(shapesToPolys(road), cellPolys);
  plan.sidewalks = difference(shapesToPolys(roadInCell), shapesToPolys(plan.carriageway));

  // Quay promenade along water edges.
  const waterEdges: number[][] = [];
  {
    const P = cell.poly;
    const n = P.length >> 1;
    let run: number[] = [];
    for (let i = 0; i <= n; i++) {
      const j = i % n, k = (i + 1) % n;
      const mx = (P[j * 2] + P[k * 2]) / 2, mz = (P[j * 2 + 1] + P[k * 2 + 1]) / 2;
      const wet = i < n && terrain.isWater(mx, mz, 3);
      if (wet) {
        if (!run.length) run.push(P[j * 2], P[j * 2 + 1]);
        run.push(P[k * 2], P[k * 2 + 1]);
      } else if (run.length) { waterEdges.push(run); run = []; }
    }
  }
  let blocksBase = difference(cellPolys, shapesToPolys(road));
  if (waterEdges.length) {
    const prom = union(strokePolylines(waterEdges, cell.district === 'park' ? 4 : 9, 'round', 'round').map((s) => s.outer));
    plan.promenade = difference(intersection(shapesToPolys(prom), cellPolys).flatMap((s) => [s.outer, ...s.holes]), shapesToPolys(road));
    blocksBase = difference(shapesToPolys(blocksBase), shapesToPolys(prom));
  }
  // Soften block corners slightly (opening).
  blocksBase = offset(shapesToPolys(offset(shapesToPolys(blocksBase), -1.5, 'miter')), 1.5, 'round').filter((s) => shapeArea(s) > 60);
  plan.blocks = blocksBase;

  // ------------------------------------------------------ 3. lots & uses
  const br = rng.fork('blocks');
  let bid = 0;
  for (const blk of plan.blocks) {
    const area = shapeArea(blk);
    const b = br.fork(bid++);
    if (cell.district === 'park') { plan.parks.push(blk); continue; }
    // Occasional plaza / pocket park.
    const plazaP = cell.district === 'oldtown' ? 0.1 : cell.district === 'downtown' || cell.district === 'commercial' ? 0.07 : 0.05;
    if (area < 9000 && area > 600 && b.chance(plazaP)) {
      if (cell.district === 'suburban' || b.chance(0.4)) plan.parks.push(blk);
      else plan.plazas.push(blk);
      continue;
    }
    if (area < 120) { plan.plazas.push(blk); continue; }
    makeLots(blk, g, cell, b, plan, terrain);
  }

  // ------------------------------------------------------- 4. buildings
  const bR = rng.fork('buildings');
  plan.lots.forEach((lot, i) => {
    const bd = makeBuilding(lot, i, cell, bR.fork(i), terrain);
    if (bd) plan.buildings.push(bd);
  });

  // Junctions (for traffic lights/stop signs and crossings).
  plan.junctions = findJunctions(plan.streets);

  // ------------------------------------------------- 4b. metro entrances
  placeEntrances(plan, cell, macro);

  // --------------------------------------------------------- 5. props
  placeProps(plan, cell, macro, g, rng.fork('props'), terrain);
  return plan;
}

function closeShapes(shapes: Shape[], r: number): Shape[] {
  const grown = offset(shapesToPolys(shapes), r, 'round');
  return offset(shapesToPolys(grown), -r, 'round');
}

// ------------------------------------------------------------- streets

function splitStreets(cell: CellInfo, g: Grammar, rng: Rng, out: { pts: number[]; cls: RoadClass }[]): void {
  const useGrid = rng.chance(g.grid * (0.4 + cell.gridness * 0.8));
  const ang = cell.gridAngle;
  const ux = Math.cos(ang), uz = Math.sin(ang);
  const [shortT, longT] = g.block;
  // Per-cell spacing jitter for the global grid (aligned across arterials).
  const spU = longT * rng.range(0.9, 1.1), spV = shortT * rng.range(0.9, 1.1);
  const queue: { poly: Poly; depth: number }[] = [{ poly: cell.poly, depth: 0 }];
  let guard = 0;
  while (queue.length && guard++ < 600) {
    const { poly, depth } = queue.shift()!;
    const area = Math.abs(polyArea(poly));
    const obb = minAreaRect(poly);
    const longLen = Math.max(obb.hu, obb.hv) * 2;
    const shortLen = Math.min(obb.hu, obb.hv) * 2;
    if (area < shortT * longT * 1.35 && longLen < longT * 1.4) continue;
    if (shortLen < shortT * 0.9 && longLen < longT * 1.6) continue;
    // Cut across the long axis.
    let dx: number, dz: number, ox: number, oz: number;
    const longAxisU = obb.hu >= obb.hv;
    const lx = longAxisU ? obb.ux : -obb.uz, lz = longAxisU ? obb.uz : obb.ux; // long axis dir
    if (useGrid) {
      // Choose the grid direction closest to the long axis as the cut normal.
      const dotU = Math.abs(lx * ux + lz * uz);
      const nx = dotU > 0.7071 ? ux : -uz, nz = dotU > 0.7071 ? uz : ux; // cut normal
      dx = -nz; dz = nx; // cut line direction
      const sp = dotU > 0.7071 ? spU : spV;
      // Nearest grid line to the centroid along the normal.
      const c = polyCentroid(poly);
      const proj = c[0] * nx + c[1] * nz;
      let k = Math.round(proj / sp);
      // Keep the cut within the polygon's middle 70%.
      const half = (dotU > 0.7071 ? (longAxisU ? obb.hu : obb.hv) : (longAxisU ? obb.hu : obb.hv));
      if (Math.abs(k * sp - proj) > half * 0.7) k = Math.round(proj / sp - 0.5) + 0.5;
      const t = k * sp;
      ox = nx * t; oz = nz * t;
      // Offset origin onto the line through projection.
      ox = c[0] + nx * (t - proj);
      oz = c[1] + nz * (t - proj);
    } else {
      const c = polyCentroid(poly);
      const jitterA = rng.range(-0.3, 0.3);
      const ca = Math.cos(jitterA), sa = Math.sin(jitterA);
      const nx = lx * ca - lz * sa, nz = lx * sa + lz * ca;
      dx = -nz; dz = nx;
      const shift = rng.range(-0.18, 0.18) * longLen;
      ox = c[0] + nx * shift;
      oz = c[1] + nz * shift;
    }
    const { pieces, chords } = splitPolyByLine(poly, ox, oz, dx, dz);
    if (pieces.length < 2) continue;
    // Reject slivers.
    if (pieces.some((q) => Math.abs(polyArea(q)) < shortT * shortT * 0.35)) {
      if (depth < 3) {
        // Retry once with a centred cut.
        const c = polyCentroid(poly);
        const r2 = splitPolyByLine(poly, c[0], c[1], -lz, lx);
        if (r2.pieces.length >= 2 && !r2.pieces.some((q) => Math.abs(polyArea(q)) < shortT * shortT * 0.35)) {
          for (const ch of r2.chords) if (Math.hypot(ch[2] - ch[0], ch[3] - ch[1]) > 20) out.push({ pts: ch, cls: chordClass(g, ch, depth) });
          for (const q of r2.pieces) queue.push({ poly: q, depth: depth + 1 });
        }
      }
      continue;
    }
    for (const ch of chords) if (Math.hypot(ch[2] - ch[0], ch[3] - ch[1]) > 20) out.push({ pts: ch, cls: chordClass(g, ch, depth) });
    for (const q of pieces) queue.push({ poly: q, depth: depth + 1 });
  }
}

function chordClass(g: Grammar, ch: number[], depth: number): RoadClass {
  const L = Math.hypot(ch[2] - ch[0], ch[3] - ch[1]);
  if (g.street === RoadClass.Lane) return L > 160 && depth === 0 ? RoadClass.Street : RoadClass.Lane;
  return g.street;
}

function findJunctions(streets: StreetSeg[]): number[] {
  // Endpoints that coincide (or lie on another street) are junctions.
  const pts: number[] = [];
  const add = (x: number, z: number) => {
    for (let i = 0; i < pts.length; i += 3) {
      if (Math.abs(pts[i] - x) < 3 && Math.abs(pts[i + 1] - z) < 3) { pts[i + 2]++; return; }
    }
    pts.push(x, z, 1);
  };
  for (const s of streets) {
    add(s.pts[0], s.pts[1]);
    add(s.pts[s.pts.length - 2], s.pts[s.pts.length - 1]);
  }
  // Endpoints touching the middle of another street count as T-junctions.
  for (let i = 0; i < pts.length; i += 3) {
    for (const s of streets) {
      for (let k = 0; k + 3 < s.pts.length; k += 2) {
        const d = distSqPointSeg(pts[i], pts[i + 1], s.pts[k], s.pts[k + 1], s.pts[k + 2], s.pts[k + 3]);
        const atEnd = (Math.hypot(pts[i] - s.pts[0], pts[i + 1] - s.pts[1]) < 3) || (Math.hypot(pts[i] - s.pts[s.pts.length - 2], pts[i + 1] - s.pts[s.pts.length - 1]) < 3);
        if (d < 4 && !atEnd) { pts[i + 2] += 2; break; }
      }
    }
  }
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 3) if (pts[i + 2] >= 3) out.push(pts[i], pts[i + 1], pts[i + 2]);
  return out;
}

// ------------------------------------------------------------------ lots

function makeLots(blk: Shape, g: Grammar, cell: CellInfo, r: Rng, plan: CellPlan, terrain: Terrain): void {
  const outer = blk.outer;
  const area = shapeArea(blk);
  // Downtown: some blocks are a single tower on a plaza.
  if (cell.district === 'downtown' && area < 14000 && area > 1200 && r.chance(0.22)) {
    plan.lots.push({ poly: outer, front: longestEdge(outer), corner: true, kind: 'tower' });
    plan.plazas.push(blk);
    return;
  }
  if (g.layout === 'perimeter' && area < g.lotW[1] * g.lotD[1] * 1.3) {
    // Small block: one or two buildings.
    const parts = splitFree(outer, area / (area > g.lotW[1] * g.lotD[0] ? 2 : 1), r, 1);
    for (const q of parts) plan.lots.push({ poly: q, front: longestEdge(q), corner: true, kind: 'perimeter' });
    return;
  }
  if (g.layout === 'free') {
    const lotArea = (g.lotW[0] + g.lotW[1]) / 2 * ((g.lotD[0] + g.lotD[1]) / 2);
    const parts = splitFree(outer, lotArea, r, 12);
    for (const q of parts) {
      const fr = frontEdge(q, outer);
      if (!fr) { plan.yards.push({ outer: q, holes: [] }); continue; }
      plan.lots.push({ poly: q, front: fr, corner: false, kind: 'free' });
    }
    for (const h of blk.holes) plan.yards.push({ outer: h, holes: [] });
    return;
  }
  // Perimeter block: a ring of lots along the street edges around a courtyard.
  // Built constructively: one depth strip per (simplified) edge, mitred at the
  // corners, split into frontage lots; long edges first, later strips only take
  // what is left (handles reflex corners and short edges).
  const depth = r.range(g.lotD[0], g.lotD[1]);
  const simp = ensureCCW(simplifyClosed(outer, 0.9));
  const n = simp.length >> 1;
  if (n < 3) return;
  const nrm: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = simp[j * 2] - simp[i * 2], dz = simp[j * 2 + 1] - simp[i * 2 + 1];
    const L = Math.hypot(dx, dz) || 1;
    nrm.push(-dz / L, dx / L);
  }
  const inner: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n;
    let bx = nrm[a * 2] + nrm[i * 2], bz = nrm[a * 2 + 1] + nrm[i * 2 + 1];
    const bl = Math.hypot(bx, bz);
    if (bl < 1e-3) { bx = nrm[i * 2]; bz = nrm[i * 2 + 1]; } else { bx /= bl; bz /= bl; }
    const sc = Math.min(depth * 2.2, depth / Math.max(0.35, bx * nrm[i * 2] + bz * nrm[i * 2 + 1]));
    inner.push(simp[i * 2] + bx * sc, simp[i * 2 + 1] + bz * sc);
  }
  const order = [...Array(n).keys()].sort((x, y) => edgeLen(simp, y) - edgeLen(simp, x));
  const taken: Poly[] = [];
  const minLot = g.lotW[0] * depth * 0.45;
  for (const i of order) {
    const j = (i + 1) % n;
    const L = edgeLen(simp, i);
    if (L < 2) continue;
    const strip = [simp[i * 2], simp[i * 2 + 1], simp[j * 2], simp[j * 2 + 1], inner[j * 2], inner[j * 2 + 1], inner[i * 2], inner[i * 2 + 1]];
    const stripClean = union([strip, ]).filter((sh) => shapeArea(sh) > 1);
    if (!stripClean.length) continue;
    let pieces = intersection(shapesToPolys(stripClean), [outer]);
    if (taken.length) pieces = difference(shapesToPolys(pieces), taken);
    taken.push(...shapesToPolys(stripClean));
    const ax = simp[i * 2], az = simp[i * 2 + 1];
    const dx = (simp[j * 2] - ax) / L, dz = (simp[j * 2 + 1] - az) / L;
    for (const pc of pieces) {
      let rest = ensureCCW(cleanPoly(pc.outer, 0.05));
      if (Math.abs(polyArea(rest)) < minLot) { if (Math.abs(polyArea(rest)) > 20) plan.yards.push({ outer: rest, holes: [] }); continue; }
      // Extent of this piece along the edge.
      let t0 = Infinity, t1 = -Infinity;
      for (let k = 0; k < rest.length; k += 2) {
        const t = (rest[k] - ax) * dx + (rest[k + 1] - az) * dz;
        t0 = Math.min(t0, t); t1 = Math.max(t1, t);
      }
      const cutsT: number[] = [];
      let t = t0;
      while (true) {
        const w = r.range(g.lotW[0], g.lotW[1]);
        if (t + w > t1 - g.lotW[0] * 0.7) break;
        t += w;
        cutsT.push(t);
      }
      const lotsHere: Poly[] = [];
      for (const ct of cutsT) {
        const res = splitPolyByLine(rest, ax + dx * ct, az + dz * ct, -dz, dx);
        if (res.pieces.length < 2) continue;
        // The piece on the low-t side is a finished lot.
        res.pieces.sort((p1, p2) => polyCentroid(p1)[0] * dx + polyCentroid(p1)[1] * dz - (polyCentroid(p2)[0] * dx + polyCentroid(p2)[1] * dz));
        lotsHere.push(res.pieces[0]);
        rest = res.pieces[res.pieces.length - 1];
        for (let k = 1; k < res.pieces.length - 1; k++) lotsHere.push(res.pieces[k]);
      }
      lotsHere.push(rest);
      for (const q0 of lotsHere) {
        const q = ensureCCW(cleanPoly(q0, 0.05));
        if (q.length < 6 || Math.abs(polyArea(q)) < 20) continue;
        const fr = frontEdge(q, outer) ?? frontEdge(q, simp);
        if (!fr) { plan.yards.push({ outer: q, holes: [] }); continue; }
        plan.lots.push({ poly: q, front: fr, corner: countFrontEdges(q, simp) > 1, kind: 'perimeter' });
      }
    }
  }
  // Courtyard: whatever the strips did not take.
  const yard = taken.length ? difference([outer], taken) : [];
  for (const s of yard) {
    const a = shapeArea(s);
    if (a < 30) continue;
    if ((cell.district === 'downtown' || cell.district === 'commercial') && a > 200 && r.chance(0.55)) {
      const sh = offset([s.outer], -1.0, 'miter');
      for (const q of sh) if (shapeArea(q) > 150) plan.lots.push({ poly: q.outer, front: longestEdge(q.outer), corner: false, kind: 'free' });
      continue;
    }
    plan.yards.push(s);
  }
}

function edgeLen(p: Poly, i: number): number {
  const n = p.length >> 1, j = (i + 1) % n;
  return Math.hypot(p[j * 2] - p[i * 2], p[j * 2 + 1] - p[i * 2 + 1]);
}

/** Recursive OBB splitting until pieces are near the target area. */
function splitFree(poly: Poly, target: number, r: Rng, maxDepth: number): Poly[] {
  const out: Poly[] = [];
  const stack: [Poly, number][] = [[poly, 0]];
  while (stack.length) {
    const [q, d] = stack.pop()!;
    const a = Math.abs(polyArea(q));
    if (a < target * 1.6 || d >= maxDepth) { out.push(q); continue; }
    const o = minAreaRect(q);
    const longU = o.hu >= o.hv;
    const lx = longU ? o.ux : -o.uz, lz = longU ? o.uz : o.ux;
    const c = polyCentroid(q);
    const shift = r.range(-0.12, 0.12) * Math.max(o.hu, o.hv);
    const res = splitPolyByLine(q, c[0] + lx * shift, c[1] + lz * shift, -lz, lx);
    if (res.pieces.length < 2) { out.push(q); continue; }
    if (res.pieces.some((pc) => rectangularityOf(pc) < 0.45 && Math.abs(polyArea(pc)) > 80)) { out.push(q); continue; }
    for (const pc of res.pieces) stack.push([pc, d + 1]);
  }
  return out;
}

/** Edge of q that lies on the block outline (street side); longest one wins. */
function frontEdge(q: Poly, outer: Poly): number[] | null {
  let best: number[] | null = null, bl = 0;
  const n = q.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = q[i * 2], az = q[i * 2 + 1], bx = q[j * 2], bz = q[j * 2 + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 2.5) continue;
    if (!onOutline((ax + bx) / 2, (az + bz) / 2, outer)) continue;
    if (L > bl) { bl = L; best = [ax, az, bx, bz]; }
  }
  return best;
}

function countFrontEdges(q: Poly, outer: Poly): number {
  let c = 0;
  const n = q.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const L = Math.hypot(q[j * 2] - q[i * 2], q[j * 2 + 1] - q[i * 2 + 1]);
    if (L > 4 && onOutline((q[i * 2] + q[j * 2]) / 2, (q[i * 2 + 1] + q[j * 2 + 1]) / 2, outer)) c++;
  }
  return c;
}

function onOutline(x: number, z: number, outer: Poly): boolean {
  const n = outer.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (distSqPointSeg(x, z, outer[i * 2], outer[i * 2 + 1], outer[j * 2], outer[j * 2 + 1]) < 0.3) return true;
  }
  return false;
}

function longestEdge(q: Poly): number[] {
  let best = [0, 0, 1, 0], bl = -1;
  const n = q.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const L = Math.hypot(q[j * 2] - q[i * 2], q[j * 2 + 1] - q[i * 2 + 1]);
    if (L > bl) { bl = L; best = [q[i * 2], q[i * 2 + 1], q[j * 2], q[j * 2 + 1]]; }
  }
  return best;
}

// ------------------------------------------------------------- buildings

function makeBuilding(lot: Lot, index: number, cell: CellInfo, r: Rng, terrain: Terrain): BuildingDesc | null {
  const p = terrain.profile;
  const frontLen = Math.hypot(lot.front[2] - lot.front[0], lot.front[3] - lot.front[1]);
  const area = Math.abs(polyArea(lot.poly));
  const c = polyCentroid(lot.poly);
  let style: StyleId = pickStyle(r, cell.district, p, cell.density, cell.era, area, frontLen);
  if (lot.kind === 'tower') style = r.chance(0.3 + 0.5 * p.arch.american / (p.arch.american + p.arch.modern + 0.1)) ? 'artdeco' : 'glass';
  // Churches: a few per city on corner lots in old/central areas.
  if ((cell.district === 'oldtown' || cell.district === 'apartments' || cell.district === 'commercial') && area > 500 && area < 3500 && r.chance(0.012)) style = 'church';
  let poly = lot.poly;
  // Setbacks for detached styles.
  if (lot.kind === 'free') {
    const fx = lot.front[2] - lot.front[0], fz = lot.front[3] - lot.front[1];
    const fl = Math.hypot(fx, fz) || 1;
    const nx = -fz / fl, nz = fx / fl;
    if (style === 'house') {
      // Detached house: a rectangle set back from the front edge; shrink until it fits.
      const ux = fx / fl, uz = fz / fl;
      const depth0 = r.range(9, 14), width0 = Math.min(frontLen - r.range(4, 7), r.range(9, 15));
      const setback = r.range(4, 8);
      const along = r.range(-1.5, 1.5);
      const wingP = r.chance(0.35), ww0 = r.range(0.35, 0.5), wd0 = r.range(4, 7), side = r.sign();
      let ok = false;
      for (let k = 0; k < 5 && !ok; k++) {
        const f = 1 - k * 0.12;
        const depth = depth0 * f, width = width0 * f;
        if (width < 5.5) break;
        const mx = (lot.front[0] + lot.front[2]) / 2 + ux * along, mz = (lot.front[1] + lot.front[3]) / 2 + uz * along;
        const x0 = mx + nx * setback * f, z0 = mz + nz * setback * f;
        let cand = [
          x0 - ux * width / 2, z0 - uz * width / 2,
          x0 + ux * width / 2, z0 + uz * width / 2,
          x0 + ux * width / 2 + nx * depth, z0 + uz * width / 2 + nz * depth,
          x0 - ux * width / 2 + nx * depth, z0 - uz * width / 2 + nz * depth,
        ];
        if (wingP && k < 2) {
          const ww = width * ww0, wd = wd0 * f;
          const sx = x0 + ux * side * (width / 2 - ww / 2) + nx * depth, sz = z0 + uz * side * (width / 2 - ww / 2) + nz * depth;
          const wing = [
            sx - ux * ww / 2 - nx * 0.5, sz - uz * ww / 2 - nz * 0.5,
            sx + ux * ww / 2 - nx * 0.5, sz + uz * ww / 2 - nz * 0.5,
            sx + ux * ww / 2 + nx * wd, sz + uz * ww / 2 + nz * wd,
            sx - ux * ww / 2 + nx * wd, sz - uz * ww / 2 + nz * wd,
          ];
          const u = union([ensureCCW(cand), ensureCCW(wing)]);
          if (u.length === 1) cand = u[0].outer;
        }
        if (polyInside(cand, lot.poly, 0.5)) { poly = cand; ok = true; }
      }
      if (!ok) return null;
    } else {
      const inset = style === 'warehouse' ? r.range(3, 8) : r.range(2, 5);
      const sh = offset([lot.poly], -inset, 'miter');
      if (!sh.length) return null;
      poly = sh.sort((a, b) => shapeArea(b) - shapeArea(a))[0].outer;
    }
  } else if (lot.kind === 'tower') {
    // Whole-block tower: a rectangle aligned to the block's frontage, standing on a plaza.
    const fx = lot.front[2] - lot.front[0], fz = lot.front[3] - lot.front[1];
    const fl = Math.hypot(fx, fz) || 1;
    const ux = fx / fl, uz = fz / fl, vx = -uz, vz = ux;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < lot.poly.length; i += 2) {
      const u = lot.poly[i] * ux + lot.poly[i + 1] * uz, v = lot.poly[i] * vx + lot.poly[i + 1] * vz;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
    const hu = (u1 - u0) / 2 * r.range(0.45, 0.75), hv = (v1 - v0) / 2 * r.range(0.45, 0.75);
    const rect = [
      ux * (cu - hu) + vx * (cv - hv), uz * (cu - hu) + vz * (cv - hv),
      ux * (cu + hu) + vx * (cv - hv), uz * (cu + hu) + vz * (cv - hv),
      ux * (cu + hu) + vx * (cv + hv), uz * (cu + hu) + vz * (cv + hv),
      ux * (cu - hu) + vx * (cv + hv), uz * (cu - hu) + vz * (cv + hv),
    ];
    const sh = intersection([ensureCCW(rect)], [lot.poly]);
    if (!sh.length) return null;
    poly = sh.sort((a, b) => shapeArea(b) - shapeArea(a))[0].outer;
  }
  poly = ensureCCW(cleanPoly(poly, 0.05));
  if (Math.abs(polyArea(poly)) < 30 || poly.length < 6) return null;

  // Front edge index of the footprint: the edge closest to/most parallel with the lot frontage.
  const fmx = (lot.front[0] + lot.front[2]) / 2, fmz = (lot.front[1] + lot.front[3]) / 2;
  let front = 0, bd = Infinity;
  const n = poly.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const d = distSqPointSeg(fmx, fmz, poly[i * 2], poly[i * 2 + 1], poly[j * 2], poly[j * 2 + 1]);
    const L = Math.hypot(poly[j * 2] - poly[i * 2], poly[j * 2 + 1] - poly[i * 2 + 1]);
    const score = d - L * 0.2;
    if (score < bd) { bd = score; front = i; }
  }

  const rule = STYLES[style];
  let floors = rule.floors(r, cell.density, p);
  // Height gradient towards the centre for towers, plus a few landmarks.
  if (style === 'glass' || style === 'artdeco') {
    const boost = 0.6 + cell.density * 0.8;
    floors = Math.round(floors * boost);
    if (r.chance(0.04 * p.skyline)) floors = Math.round(floors * r.range(1.4, 2.0));
    // Small lots cannot carry tall towers.
    const maxF = Math.max(8, Math.round(Math.sqrt(area) * 1.6));
    floors = Math.min(floors, maxF);
  }
  if (lot.kind === 'perimeter' && style !== 'church') {
    // Neighbouring buildings vary a little; corner buildings are often taller.
    floors = Math.max(1, floors + (lot.corner && r.chance(0.4) ? 1 : 0));
  }
  const floorH = r.range(rule.floorH[0], rule.floorH[1]);
  const groundH = r.range(rule.groundH[0], rule.groundH[1]);
  const roofs = rule.roofs;
  let roof = r.pick(roofs);
  const rect = rectangularityOf(poly);
  if ((roof === 'gable' || roof === 'hip') && rect < 0.85) roof = lot.kind === 'perimeter' ? 'gable' : 'flat';
  const setbacks: [number, number][] = [];
  if (style === 'artdeco' && floors > 14) {
    const steps = r.int(1, 3);
    for (let k = 1; k <= steps; k++) setbacks.push([Math.round(floors * (0.45 + 0.17 * k)), r.range(2, 4) * k]);
  } else if (style === 'glass' && floors > 25 && r.chance(0.4)) {
    setbacks.push([Math.round(floors * r.range(0.55, 0.8)), r.range(2, 5)]);
  }
  const shopfront = r.chance(rule.shopP * (cell.district === 'commercial' || cell.district === 'downtown' || cell.district === 'oldtown' ? 1.3 : 0.8));
  const bayW = r.range(rule.bay[0], rule.bay[1]);
  const walls = rule.walls;
  const fpArea = Math.abs(polyArea(poly));
  const units = rule.use === 'residential' || rule.use === 'mixed' ? Math.max(1, Math.round(fpArea / r.range(70, 110))) : 0;
  void c;
  return {
    id: index,
    poly,
    front,
    style,
    use: style === 'house' ? 'residential' : rule.use === 'mixed' && !shopfront ? 'residential' : rule.use,
    floors,
    floorH,
    groundH,
    roof,
    pitch: roof === 'gable' || roof === 'hip' ? r.range(0.45, 0.95) : roof === 'mansard' ? 1.6 : 0.2,
    setbacks,
    wall: r.pick(walls),
    trim: r.int(0, 7),
    roofMat: r.pick(rule.roofMats),
    accent: r.int(0, 7),
    bay: bayW,
    shopfront,
    seed: r.nextU32(),
    attached: lot.kind === 'perimeter',
    units,
    landmark: style === 'church' || floors > 45,
  };
}

function rectangularityOf(p: Poly): number {
  const o = minAreaRect(p);
  return Math.abs(polyArea(p)) / Math.max(1e-6, 4 * o.hu * o.hv);
}

function polyInside(inner: Poly, outer: Poly, margin: number): boolean {
  for (let i = 0; i < inner.length; i += 2) {
    if (!pointInPoly(outer, inner[i], inner[i + 1])) return false;
  }
  void margin;
  return true;
}

// ----------------------------------------------------------------- props

function placeProps(plan: CellPlan, cell: CellInfo, macro: MacroPlan, g: Grammar, r: Rng, terrain: Terrain): void {
  const P = plan.props;
  const push = (t: PropType, x: number, z: number, yaw: number, scale = 1, variant = 0) => P.push(t, x, z, yaw, scale, variant);
  const inCell = (x: number, z: number) => pointInPoly(cell.poly, x, z);
  const E = plan.entrances;
  const inEntrance = (x: number, z: number) => {
    for (let i = 0; i < E.length; i += 6) if (Math.hypot(E[i] - x, E[i + 1] - z) < ENTRANCE_L * 0.7) return true;
    return false;
  };
  const free = (x: number, z: number, rad: number) => {
    if (inEntrance(x, z)) return false;
    for (let i = 0; i < P.length; i += 6) if (Math.abs(P[i + 1] - x) < rad && Math.abs(P[i + 2] - z) < rad) return false;
    return true;
  };
  // Along streets: trees, lamps, hydrants, bins, benches, parked cars — on both sides.
  plan.streets.forEach((s, si) => {
    if (s.cls === RoadClass.Path) return;
    const L = polylineLength(s.pts);
    if (L < 10) return;
    const pts = resample(s.pts, 2);
    const nPts = pts.length >> 1;
    const lampStep = s.cls <= RoadClass.Avenue ? 28 : 32;
    const treeStep = r.range(8, 11);
    const sr = r.fork('st', si);
    const treesHere = sr.chance(g.trees) && s.sidewalk >= 2.8;
    const parking = s.cls === RoadClass.Street && plan.district !== 'downtown' ? 0.55 : s.cls === RoadClass.Avenue ? 0.3 : 0;
    for (const side of [-1, 1]) {
      let nextLamp = sr.range(4, lampStep), nextTree = sr.range(2, treeStep), nextCar = sr.range(3, 8), nextMisc = sr.range(15, 40);
      let acc = 0;
      for (let i = 1; i < nPts - 1; i++) {
        const x0 = pts[i * 2 - 2], z0 = pts[i * 2 - 1], x1 = pts[i * 2], z1 = pts[i * 2 + 1];
        const segL = Math.hypot(x1 - x0, z1 - z0);
        acc += segL;
        // Keep clear of the ends (junctions).
        if (acc < 14 || acc > L - 14) continue;
        const dx = (x1 - x0) / segL, dz = (z1 - z0) / segL;
        const nx = -dz * side, nz = dx * side;
        const yaw = Math.atan2(dx, dz);
        const curb = s.width / 2;
        if (acc >= nextLamp) {
          nextLamp += lampStep;
          const x = x1 + nx * (curb + 0.6), z = z1 + nz * (curb + 0.6);
          if (inCell(x, z) && !terrain.isWater(x, z) && free(x, z, 1.2)) push(PropType.Lamp, x, z, Math.atan2(-nx, -nz), 1, s.cls <= RoadClass.Avenue ? 1 : 0);
        }
        if (treesHere && acc >= nextTree) {
          nextTree += treeStep * sr.range(0.85, 1.2);
          const x = x1 + nx * (curb + 1.4), z = z1 + nz * (curb + 1.4);
          if (inCell(x, z) && !terrain.isWater(x, z) && free(x, z, 2.5)) push(PropType.Tree, x, z, sr.range(0, 6.28), sr.range(0.75, 1.15), sr.int(0, 5));
        }
        if (parking && acc >= nextCar) {
          nextCar += sr.range(5.6, 7.5);
          if (sr.chance(parking)) {
            const lane = s.cls === RoadClass.Avenue ? curb - 1.3 : curb - 1.2;
            const x = x1 + nx * lane, z = z1 + nz * lane;
            if (inCell(x, z) && free(x, z, 2.2)) push(PropType.ParkedCar, x, z, side > 0 ? yaw : yaw + Math.PI, 1, sr.int(0, 1 << 20));
          }
        }
        if (acc >= nextMisc) {
          nextMisc += sr.range(25, 70);
          const kind = sr.weighted([PropType.Hydrant, PropType.Bin, PropType.Bench, PropType.Mailbox, PropType.Planter], (k) => k === PropType.Bench ? (plan.district === 'suburban' ? 0.1 : 1) : k === PropType.Planter ? 0.3 : 1);
          const off = kind === PropType.Bench ? s.sidewalk * 0.7 : 0.5;
          const x = x1 + nx * (curb + off), z = z1 + nz * (curb + off);
          if (inCell(x, z) && !terrain.isWater(x, z) && free(x, z, 1.5)) push(kind, x, z, kind === PropType.Bench ? Math.atan2(-nx, -nz) : yaw, 1, sr.int(0, 3));
        }
      }
    }
    // Manholes along the centreline.
    for (let d = r.range(10, 30); d < L - 10; d += r.range(40, 70)) {
      const k = Math.min(nPts - 1, Math.round(d / 2));
      push(PropType.Manhole, pts[k * 2], pts[k * 2 + 1], 0, 1, 0);
    }
  });
  // Junction furniture: traffic lights at busy junctions, stop signs at small ones.
  for (let i = 0; i < plan.junctions.length; i += 3) {
    const x = plan.junctions[i], z = plan.junctions[i + 1];
    if (!inCell(x, z)) continue;
    push(plan.district === 'suburban' ? PropType.StopSign : PropType.TrafficLight, x, z, 0, 1, plan.junctions[i + 2]);
  }
  // Arterial nodes inside/at the cell get traffic lights (owned by the lowest cell id touching them).
  for (const eid of cell.edges) {
    const e = macro.edges[eid];
    for (const nid of [e.a, e.b]) {
      const n = macro.nodes[nid];
      if (n.edges.length < 3) continue;
      if (P.some((_, k) => k % 6 === 0 && P[k] === PropType.TrafficLight && Math.abs(P[k + 1] - n.x) < 1 && Math.abs(P[k + 2] - n.z) < 1)) continue;
      // Ownership: only if the node lies within this cell's bounds-ish and this is the first cell in edge order.
      if (macro.cells.find((c) => c.edges.includes(eid))?.id !== cell.id && !(cell.edges[0] === eid)) continue;
      push(PropType.TrafficLight, n.x, n.z, 0, 1, n.edges.length);
    }
  }
  // Parks: trees, bushes, benches, paths, fountain, playground.
  for (const pk of plan.parks) {
    const area = shapeArea(pk);
    const [x0, z0, x1, z1] = polyBounds(pk.outer);
    const nTrees = Math.round(area / r.range(90, 180));
    for (let k = 0; k < nTrees; k++) {
      const x = r.range(x0, x1), z = r.range(z0, z1);
      if (!pointInPoly(pk.outer, x, z) || terrain.isWater(x, z)) continue;
      if (!free(x, z, 3)) continue;
      push(r.chance(0.8) ? PropType.Tree : PropType.Bush, x, z, r.range(0, 6.28), r.range(0.8, 1.5), r.int(0, 5));
    }
    if (area > 2500) {
      const c = polyCentroid(pk.outer);
      if (pointInPoly(pk.outer, c[0], c[1])) push(r.chance(0.6) ? PropType.Fountain : PropType.Statue, c[0], c[1], r.range(0, 6.28), 1, r.int(0, 3));
      for (let k = 0; k < Math.min(12, area / 600); k++) {
        const x = r.range(x0, x1), z = r.range(z0, z1);
        if (pointInPoly(pk.outer, x, z) && free(x, z, 2)) push(PropType.Bench, x, z, r.range(0, 6.28), 1, 0);
      }
      if (area > 8000 && r.chance(0.6)) {
        const x = r.range(x0, x1), z = r.range(z0, z1);
        if (pointInPoly(pk.outer, x, z) && free(x, z, 8)) push(PropType.PlayGround, x, z, r.range(0, 6.28), 1, 0);
      }
    }
  }
  // Plazas: fountain/statue, benches, planters, a kiosk.
  for (const pz of plan.plazas) {
    const area = shapeArea(pz);
    const c = polyCentroid(pz.outer);
    if (area > 300 && pointInPoly(pz.outer, c[0], c[1]) && !plan.buildings.some((b) => pointInPoly(b.poly, c[0], c[1]))) push(r.chance(0.5) ? PropType.Fountain : PropType.Statue, c[0], c[1], r.range(0, 6.28), 1, r.int(0, 3));
    const [x0, z0, x1, z1] = polyBounds(pz.outer);
    for (let k = 0; k < Math.min(10, area / 150); k++) {
      const x = r.range(x0, x1), z = r.range(z0, z1);
      if (!pointInPoly(pz.outer, x, z) || !free(x, z, 3)) continue;
      if (plan.buildings.some((b) => pointInPoly(b.poly, x, z))) continue;
      push(r.pick([PropType.Bench, PropType.Planter, PropType.Tree, PropType.Tree, PropType.Bin]), x, z, r.range(0, 6.28), 1, r.int(0, 3));
    }
  }
  // Yards: gardens get trees and hedges.
  for (const y of plan.yards) {
    const area = shapeArea(y);
    const [x0, z0, x1, z1] = polyBounds(y.outer);
    const n = Math.round(area / r.range(140, 320));
    for (let k = 0; k < n; k++) {
      const x = r.range(x0, x1), z = r.range(z0, z1);
      if (!pointInPoly(y.outer, x, z) || !free(x, z, 3)) continue;
      if (plan.buildings.some((b) => pointInPoly(b.poly, x, z))) continue;
      push(r.chance(0.6) ? PropType.Tree : PropType.Bush, x, z, r.range(0, 6.28), r.range(0.6, 1.1), r.int(0, 5));
    }
  }
  // Suburban front gardens: a tree or bush in front of houses.
  if (plan.district === 'suburban') {
    for (const lot of plan.lots) {
      if (!r.chance(0.6)) continue;
      const fx = (lot.front[0] + lot.front[2]) / 2, fz = (lot.front[1] + lot.front[3]) / 2;
      const c = polyCentroid(lot.poly);
      const t = r.range(0.15, 0.3);
      const x = fx + (c[0] - fx) * t + r.range(-3, 3), z = fz + (c[1] - fz) * t + r.range(-3, 3);
      if (pointInPoly(lot.poly, x, z) && free(x, z, 3) && !plan.buildings.some((b) => pointInPoly(b.poly, x, z))) push(r.chance(0.6) ? PropType.Tree : PropType.Bush, x, z, r.range(0, 6.28), r.range(0.7, 1.1), r.int(0, 5));
    }
  }
  void clamp; void lerp;
}

/** Station half-length (m) shared with the underground builder. */
export const STATION_HALF = 62;

/** Entrance rectangles on this cell's sidewalks near the ends of nearby metro stations. */
function placeEntrances(plan: CellPlan, cell: CellInfo, macro: MacroPlan): void {
  const [bx0, bz0, bx1, bz1] = plan.bounds;
  const cuts: Poly[] = [];
  for (const st of macro.metroStations) {
    if (st.x < bx0 - 120 || st.x > bx1 + 120 || st.z < bz0 - 120 || st.z > bz1 + 120) continue;
    const ax = Math.cos(st.angle), az = Math.sin(st.angle);
    for (const end of [0, 1]) {
      const sgn = end ? 1 : -1;
      const ex = st.x + ax * sgn * (STATION_HALF - 12), ez = st.z + az * sgn * (STATION_HALF - 12);
      if (!pointInPoly(cell.poly, ex, ez)) continue;
      // Nearest sidewalk edge point to the station end.
      let best: { px: number; pz: number; dx: number; dz: number; d: number; sh: Shape } | null = null;
      for (const sh of plan.sidewalks) {
        const ring = sh.outer;
        const n = ring.length >> 1;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const x0 = ring[i * 2], z0 = ring[i * 2 + 1], x1 = ring[j * 2], z1 = ring[j * 2 + 1];
          const L = Math.hypot(x1 - x0, z1 - z0);
          if (L < ENTRANCE_L + 1) continue;
          const tt = Math.max(0.15, Math.min(0.85, ((ex - x0) * (x1 - x0) + (ez - z0) * (z1 - z0)) / (L * L)));
          const px = x0 + (x1 - x0) * tt, pz = z0 + (z1 - z0) * tt;
          const d = Math.hypot(px - ex, pz - ez);
          if (d < 70 && (!best || d < best.d)) best = { px, pz, dx: (x1 - x0) / L, dz: (z1 - z0) / L, d, sh };
        }
      }
      if (!best) continue;
      // Try both sides of the edge; keep a rectangle fully inside the sidewalk.
      for (const side of [1, -1]) {
        const nx = -best.dz * side, nz = best.dx * side;
        const off = ENTRANCE_W / 2 + 0.35;
        const cx = best.px + nx * off, cz = best.pz + nz * off;
        const hw = ENTRANCE_W / 2, hl = ENTRANCE_L / 2;
        const rect = [
          cx - best.dx * hl - nx * hw, cz - best.dz * hl - nz * hw, cx + best.dx * hl - nx * hw, cz + best.dz * hl - nz * hw,
          cx + best.dx * hl + nx * hw, cz + best.dz * hl + nz * hw, cx - best.dx * hl + nx * hw, cz - best.dz * hl + nz * hw,
        ];
        let ok = true;
        for (let k = 0; k < 8; k += 2) {
          if (!pointInPoly(best.sh.outer, rect[k], rect[k + 1]) || best.sh.holes.some((h) => pointInPoly(h, rect[k], rect[k + 1]))) { ok = false; break; }
        }
        if (!ok) continue;
        plan.entrances.push(cx, cz, best.dx, best.dz, st.id, end);
        cuts.push(ensureCCW(rect));
        break;
      }
    }
  }
  if (cuts.length) plan.sidewalks = difference(shapesToPolys(plan.sidewalks), cuts);
}
