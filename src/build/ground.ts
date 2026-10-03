/**
 * Urban ground surfaces of a cell: carriageway, sidewalks with curbs, plazas,
 * yards and parks, quay promenades, road markings. Surfaces are triangulated
 * (earcut), tessellated so they follow the terrain, and draped on it.
 */
import earcut from 'earcut';
import type { Shape } from '../core/clip';
import type { Terrain } from '../world/terrain';
import type { CellPlan } from '../plan/cell';
import { RoadClass } from '../plan/types';
import { MeshBuilder } from './meshBuilder';
import { resample, polylineLength } from '../core/geom2';

export const enum GroundLayer {
  Asphalt = 0,
  Paving = 1,
  Curb = 2,
  Grass = 3,
  PlazaStone = 4,
  Cobble = 5,
  Gravel = 6,
  Promenade = 7,
  AsphaltLight = 8,
  PaintWhite = 9,
  PaintYellow = 10,
  Dirt = 11,
  QuayWall = 12,
}
export const GROUND_LAYER_COUNT = 13;

export const CURB_H = 0.15;
const MAX_EDGE = 5;

export function groundSpecs() {
  return [
    { name: 'uv', size: 2 },
    { name: 'aLayer', size: 1 },
  ];
}

/** Triangulate a shape with holes, tessellate, drape at terrain height + dy. */
export function drapeShape(mb: MeshBuilder, sh: Shape, terrain: Terrain, dy: number, layer: number, heightFn?: (x: number, z: number) => number, maxEdge = MAX_EDGE): void {
  const flat: number[] = [];
  const holes: number[] = [];
  for (let i = 0; i < sh.outer.length; i++) flat.push(sh.outer[i]);
  for (const h of sh.holes) {
    holes.push(flat.length / 2);
    for (let i = 0; i < h.length; i++) flat.push(h[i]);
  }
  const tris = earcut(flat, holes.length ? holes : undefined, 2);
  if (!tris.length) return;
  // Tessellate: split edges longer than MAX_EDGE with a shared midpoint cache.
  const pts: number[] = flat.slice();
  const cache = new Map<string, number>();
  const mid = (a: number, b: number): number => {
    const k = a < b ? a + ',' + b : b + ',' + a;
    let m = cache.get(k);
    if (m === undefined) {
      m = pts.length / 2;
      pts.push((pts[a * 2] + pts[b * 2]) / 2, (pts[a * 2 + 1] + pts[b * 2 + 1]) / 2);
      cache.set(k, m);
    }
    return m;
  };
  // Adaptive: an edge is split only where the terrain bends under it (or when very long),
  // decided per edge so neighbouring triangles agree (no cracks).
  const hFn = heightFn ?? ((x: number, z: number) => terrain.height(x, z));
  const hs: number[] = [];
  const hAt = (i: number) => {
    let h = hs[i];
    if (h === undefined) { h = hFn(pts[i * 2], pts[i * 2 + 1]); hs[i] = h; }
    return h;
  };
  const hardMax = maxEdge * 5;
  const needs = (a: number, b: number, L: number): boolean => {
    if (L <= 1.2) return false;
    if (L > hardMax) return true;
    const mx = (pts[a * 2] + pts[b * 2]) / 2, mz = (pts[a * 2 + 1] + pts[b * 2 + 1]) / 2;
    return Math.abs(hFn(mx, mz) - (hAt(a) + hAt(b)) / 2) > 0.02;
  };
  const out: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < tris.length; i += 3) stack.push(tris[i], tris[i + 1], tris[i + 2]);
  let guard = 0;
  while (stack.length && guard++ < 400000) {
    const c = stack.pop()!, b = stack.pop()!, a = stack.pop()!;
    const lab = Math.hypot(pts[a * 2] - pts[b * 2], pts[a * 2 + 1] - pts[b * 2 + 1]);
    const lbc = Math.hypot(pts[b * 2] - pts[c * 2], pts[b * 2 + 1] - pts[c * 2 + 1]);
    const lca = Math.hypot(pts[c * 2] - pts[a * 2], pts[c * 2 + 1] - pts[a * 2 + 1]);
    const nab = needs(a, b, lab) ? lab : -1, nbc = needs(b, c, lbc) ? lbc : -1, nca = needs(c, a, lca) ? lca : -1;
    const m = Math.max(nab, nbc, nca);
    if (m < 0) { out.push(a, b, c); continue; }
    if (m === nab) { const d = mid(a, b); stack.push(a, d, c, d, b, c); }
    else if (m === nbc) { const d = mid(b, c); stack.push(a, b, d, a, d, c); }
    else { const d = mid(c, a); stack.push(a, b, d, d, b, c); }
  }
  mb.set('aLayer', layer);
  const base = mb.vcount;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], z = pts[i * 2 + 1];
    const y = (heightFn ? heightFn(x, z) : terrain.height(x, z)) + dy;
    mb.v(x, y, z, 0, 1, 0, x, z);
  }
  // Orient every triangle to face +y (clockwise in the x/z plane).
  for (let i = 0; i < out.length; i += 3) {
    const a = out[i], b = out[i + 1], c = out[i + 2];
    const cr = (pts[b * 2] - pts[a * 2]) * (pts[c * 2 + 1] - pts[a * 2 + 1]) - (pts[b * 2 + 1] - pts[a * 2 + 1]) * (pts[c * 2] - pts[a * 2]);
    if (cr > 0) mb.tri(base + a, base + c, base + b);
    else mb.tri(base + a, base + b, base + c);
  }
}

/** Vertical skirt along a ring (curbs, quay walls). Faces outward of a CCW ring when outward=true. */
export function ringWall(mb: MeshBuilder, ring: number[], terrain: Terrain, yTop: number, yBottom: number, layer: number, outward: boolean, step = MAX_EDGE): void {
  mb.set('aLayer', layer);
  const n = ring.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-3) continue;
    const segs = Math.max(1, Math.ceil(L / step));
    let nx = (bz - az) / L, nz = -(bx - ax) / L; // right normal (outward for CCW)
    if (!outward) { nx = -nx; nz = -nz; }
    for (let s = 0; s < segs; s++) {
      const t0 = s / segs, t1 = (s + 1) / segs;
      const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0, x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
      const h0 = terrain.height(x0, z0), h1 = terrain.height(x1, z1);
      const u0 = (L * t0), u1 = (L * t1);
      const i0 = mb.v(x0, h0 + yBottom, z0, nx, 0, nz, u0, h0 + yBottom);
      mb.v(x1, h1 + yBottom, z1, nx, 0, nz, u1, h1 + yBottom);
      mb.v(x1, h1 + yTop, z1, nx, 0, nz, u1, h1 + yTop);
      mb.v(x0, h0 + yTop, z0, nx, 0, nz, u0, h0 + yTop);
      if (outward) mb.quad(i0, i0 + 3, i0 + 2, i0 + 1);
      else mb.quad(i0, i0 + 1, i0 + 2, i0 + 3);
    }
  }
}

export function buildGround(plan: CellPlan, terrain: Terrain, origin: [number, number, number]): MeshBuilder {
  const mb = new MeshBuilder(groundSpecs());
  mb.setOrigin(...origin);
  const oldTown = plan.district === 'oldtown';
  for (const s of plan.carriageway) drapeShape(mb, s, terrain, 0, oldTown ? GroundLayer.Cobble : GroundLayer.Asphalt);
  // Curbs: carriageway outline walls facing the road.
  for (const s of plan.carriageway) {
    ringWall(mb, s.outer, terrain, CURB_H, -0.05, GroundLayer.Curb, false);
    for (const h of s.holes) ringWall(mb, h, terrain, CURB_H, -0.05, GroundLayer.Curb, false);
  }
  for (const s of plan.sidewalks) drapeShape(mb, s, terrain, CURB_H, oldTown ? GroundLayer.PlazaStone : GroundLayer.Paving);
  for (const s of plan.promenade) drapeShape(mb, s, terrain, CURB_H, GroundLayer.Promenade);
  for (const s of plan.plazas) drapeShape(mb, s, terrain, CURB_H, GroundLayer.PlazaStone);
  for (const s of plan.paved) drapeShape(mb, s, terrain, CURB_H, GroundLayer.AsphaltLight);
  for (const s of plan.parks) drapeShape(mb, s, terrain, CURB_H, GroundLayer.Grass);
  // Blocks: lots and yards. Lot surfaces of dense districts are paved, gardens are grass.
  const dense = plan.district === 'downtown' || plan.district === 'commercial' || plan.district === 'oldtown';
  const industrial = plan.district === 'industrial' || plan.district === 'port';
  for (const s of plan.blocks) drapeShape(mb, s, terrain, CURB_H - 0.01, industrial ? GroundLayer.AsphaltLight : dense ? GroundLayer.Paving : GroundLayer.Grass);
  for (const s of plan.yards) drapeShape(mb, s, terrain, CURB_H + 0.01, industrial ? GroundLayer.Gravel : GroundLayer.Grass);
  // Quay walls along the water side of promenades.
  for (const s of plan.promenade) {
    const n = s.outer.length >> 1;
    // Only edges actually at the water get a deep wall.
    const ring = s.outer;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const mx = (ring[i * 2] + ring[j * 2]) / 2, mz = (ring[i * 2 + 1] + ring[j * 2 + 1]) / 2;
      const wl = terrain.waterLevel(mx + (ring[j * 2 + 1] - ring[i * 2 + 1]) * 0.2, mz - (ring[j * 2] - ring[i * 2]) * 0.2);
      if (wl === -Infinity) continue;
      ringWall(mb, [ring[i * 2], ring[i * 2 + 1], ring[j * 2], ring[j * 2 + 1]], terrain, CURB_H, -6, GroundLayer.QuayWall, true);
    }
  }
  buildMarkings(mb, plan, terrain);
  return mb;
}

/** Lane markings, crosswalks and stop lines as thin draped quads. */
function buildMarkings(mb: MeshBuilder, plan: CellPlan, terrain: Terrain): void {
  const lift = 0.025;
  const strip = (pts: number[], off: number, halfW: number, dash: number, gap: number, layer: number, trim0: number, trim1: number) => {
    const L = polylineLength(pts);
    if (L < trim0 + trim1 + 1) return;
    const rs = resample(pts, 1);
    const n = rs.length >> 1;
    const step = L / (n - 1);
    mb.set('aLayer', layer);
    let s = 0;
    for (let i = 0; i < n - 1; i++, s += step) {
      if (s < trim0 || s > L - trim1) continue;
      if (dash > 0 && (s % (dash + gap)) > dash) continue;
      const x0 = rs[i * 2], z0 = rs[i * 2 + 1], x1 = rs[i * 2 + 2], z1 = rs[i * 2 + 3];
      const dx = x1 - x0, dz = z1 - z0;
      const l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l, nz = dx / l;
      const ax = x0 + nx * off, az = z0 + nz * off, bx = x1 + nx * off, bz = z1 + nz * off;
      const p = [
        ax - nx * halfW, az - nz * halfW, ax + nx * halfW, az + nz * halfW,
        bx + nx * halfW, bz + nz * halfW, bx - nx * halfW, bz - nz * halfW,
      ];
      const base = mb.vcount;
      for (let k = 0; k < 4; k++) mb.v(p[k * 2], terrain.height(p[k * 2], p[k * 2 + 1]) + lift, p[k * 2 + 1], 0, 1, 0, p[k * 2], p[k * 2 + 1]);
      upQuad(mb, base, p);
    }
  };
  const junctionNear = (x: number, z: number) => {
    for (let i = 0; i < plan.junctions.length; i += 3) if (Math.hypot(plan.junctions[i] - x, plan.junctions[i + 1] - z) < 4) return true;
    return false;
  };
  for (const st of plan.streets) {
    if (st.cls === RoadClass.Path) continue;
    // Arterials are marked by one cell only: the one whose id is lower among its two sides
    // is unknown here, so mark arterials from the side where the polyline runs CCW (left side owns).
    if (st.arterial >= 0 && !ownsArterial(plan, st.pts)) continue;
    const n = st.pts.length;
    const j0 = junctionNear(st.pts[0], st.pts[1]) || st.arterial >= 0;
    const j1 = junctionNear(st.pts[n - 2], st.pts[n - 1]) || st.arterial >= 0;
    const trim0 = j0 ? st.width * 0.75 + 2.5 : 1, trim1 = j1 ? st.width * 0.75 + 2.5 : 1;
    if (plan.district === 'oldtown' && st.cls >= RoadClass.Street) continue;
    if (st.cls <= RoadClass.Avenue) {
      // Double yellow centre (or median edge), dashed lane dividers, edge lines.
      if (st.cls === RoadClass.Boulevard) {
        strip(st.pts, 1.0, 0.08, 0, 0, GroundLayer.PaintYellow, trim0, trim1);
        strip(st.pts, -1.0, 0.08, 0, 0, GroundLayer.PaintYellow, trim0, trim1);
      } else {
        strip(st.pts, 0.12, 0.06, 0, 0, GroundLayer.PaintYellow, trim0, trim1);
        strip(st.pts, -0.12, 0.06, 0, 0, GroundLayer.PaintYellow, trim0, trim1);
      }
      const laneW = (st.width / 2 - (st.cls === RoadClass.Boulevard ? 1 : 0)) / st.lanes;
      for (let k = 1; k < st.lanes; k++) {
        const off = (st.cls === RoadClass.Boulevard ? 1 : 0) + laneW * k;
        strip(st.pts, off, 0.07, 3, 6, GroundLayer.PaintWhite, trim0, trim1);
        strip(st.pts, -off, 0.07, 3, 6, GroundLayer.PaintWhite, trim0, trim1);
      }
    } else if (st.cls === RoadClass.Street) {
      strip(st.pts, 0, 0.07, 3, 5, GroundLayer.PaintWhite, trim0, trim1);
    }
    // Crosswalks (zebra) near junction ends.
    for (const end of [0, 1]) {
      if (!(end === 0 ? j0 : j1)) continue;
      const pts = end === 0 ? st.pts : reverse(st.pts);
      const L = polylineLength(pts);
      const d = st.width * 0.75 + 1.2;
      if (L < d + 3) continue;
      const rs = resample(pts.slice(0, Math.min(pts.length, 8)), 0.5);
      // Point at distance d along the start.
      let acc = 0, px = pts[0], pz = pts[1], dxv = 1, dzv = 0;
      for (let i = 2; i < rs.length; i += 2) {
        const seg = Math.hypot(rs[i] - rs[i - 2], rs[i + 1] - rs[i - 1]);
        if (acc + seg >= d) {
          const t = (d - acc) / seg;
          px = rs[i - 2] + (rs[i] - rs[i - 2]) * t; pz = rs[i - 1] + (rs[i + 1] - rs[i - 1]) * t;
          dxv = (rs[i] - rs[i - 2]) / seg; dzv = (rs[i + 1] - rs[i - 1]) / seg;
          break;
        }
        acc += seg;
      }
      const nx = -dzv, nz = dxv;
      const half = st.width / 2 - 0.3;
      mb.set('aLayer', GroundLayer.PaintWhite);
      for (let o = -half + 0.25; o < half - 0.2; o += 1.0) {
        const cx = px + nx * o, cz = pz + nz * o;
        const p = [
          cx - nx * 0.25 - dxv * 1.5, cz - nz * 0.25 - dzv * 1.5,
          cx + nx * 0.25 - dxv * 1.5, cz + nz * 0.25 - dzv * 1.5,
          cx + nx * 0.25 + dxv * 1.5, cz + nz * 0.25 + dzv * 1.5,
          cx - nx * 0.25 + dxv * 1.5, cz - nz * 0.25 + dzv * 1.5,
        ];
        const base = mb.vcount;
        for (let k = 0; k < 4; k++) mb.v(p[k * 2], terrain.height(p[k * 2], p[k * 2 + 1]) + lift, p[k * 2 + 1], 0, 1, 0, p[k * 2], p[k * 2 + 1]);
        upQuad(mb, base, p);
      }
      // Stop line on the approach side (right-hand traffic: the lane arriving at the junction).
      const sx = px + dxv * 2.2, sz = pz + dzv * 2.2;
      strip([sx - nx * 0.05, sz - nz * 0.05, sx + nx * half, sz + nz * half], 0, 0.2, 0, 0, GroundLayer.PaintWhite, 0, 0);
    }
  }
}

function reverse(p: number[]): number[] {
  const o: number[] = [];
  for (let i = p.length - 2; i >= 0; i -= 2) o.push(p[i], p[i + 1]);
  return o;
}

/** A cell owns an arterial's markings when the cell lies to the left of the polyline direction. */
function ownsArterial(plan: CellPlan, pts: number[]): boolean {
  const n = pts.length >> 1;
  const i = Math.max(0, (n >> 1) - 1);
  const ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[i * 2 + 2], bz = pts[i * 2 + 3];
  const mx = (ax + bx) / 2, mz = (az + bz) / 2;
  const [x0, z0, x1, z1] = plan.bounds;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  return (bx - ax) * (cz - mz) - (bz - az) * (cx - mx) > 0;
}

/** Emit a quad (4 verts already added at `base`, xz corners in p) facing +y. */
function upQuad(mb: MeshBuilder, base: number, p: number[]): void {
  const cr = (p[2] - p[0]) * (p[5] - p[1]) - (p[3] - p[1]) * (p[4] - p[0]);
  if (cr > 0) { mb.tri(base, base + 2, base + 1); mb.tri(base, base + 3, base + 2); }
  else { mb.tri(base, base + 1, base + 2); mb.tri(base, base + 2, base + 3); }
}
