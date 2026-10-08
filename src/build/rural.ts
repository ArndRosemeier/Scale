/**
 * Geometry of the countryside's settlements and roads for one square tile (worker side):
 * road ribbons draped on the terrain (asphalt country roads with a dashed centre line, lighter
 * village lanes, dirt farm tracks), village squares and farmyards, and the buildings of every
 * settlement whose centre lies in the tile, drawn by the city's building shells (near and far
 * LOD), plus their boxes for player collision.
 */
import type { Terrain } from '../world/terrain';
import { RoadKind, SettleKind, type RuralPlan } from '../world/rural';
import { MeshBuilder } from './meshBuilder';
import { drapeShape, groundSpecs, GroundLayer } from './ground';
import { buildBuildingShell, facadeSpecs } from './buildingShell';
import { minAreaRect } from '../core/geom2';
import { TERRAIN_DROP } from './terrainMesh';

/** Per building box for collision: cx, cz, hu, hv, ux, uz, y0, y1. */
export const RURAL_OBST_STRIDE = 8;

/**
 * Outlines of the draped road and paved surfaces of a tile, for the ground height (the natural
 * ground around them is drawn TERRAIN_DROP lower): per outline n, min x, min z, max x, max z,
 * then n x/z pairs.
 */
export function ruralSurfaceAt(S: Float32Array, x: number, z: number): boolean {
  for (let o = 0; o < S.length; o += 5 + S[o] * 2) {
    if (x < S[o + 1] || z < S[o + 2] || x > S[o + 3] || z > S[o + 4]) continue;
    const n = S[o], b = o + 5;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = S[b + i * 2], zi = S[b + i * 2 + 1], xj = S[b + j * 2], zj = S[b + j * 2 + 1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

function pushOutline(out: number[], poly: ArrayLike<number>): void {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    x0 = Math.min(x0, poly[i]); x1 = Math.max(x1, poly[i]);
    z0 = Math.min(z0, poly[i + 1]); z1 = Math.max(z1, poly[i + 1]);
  }
  out.push(poly.length >> 1, x0, z0, x1, z1);
  for (let i = 0; i < poly.length; i++) out.push(poly[i]);
}

/** Height of the road surfaces above the natural ground (the terrain mesh sits TERRAIN_DROP lower). */
const DY = [0.06, 0.05, 0.04];
const DASH_ON = 3, DASH_OFF = 6;

export interface RuralTile {
  ground: MeshBuilder | null;
  facade: MeshBuilder | null;
  facadeLod: MeshBuilder | null;
  obstacles: Float32Array;
  /** Road and paved outlines (see ruralSurfaceAt). */
  surfaces: Float32Array;
}

export function buildRuralTile(plan: RuralPlan, terrain: Terrain, x0: number, z0: number, size: number): RuralTile {
  const cx = x0 + size / 2, cz = z0 + size / 2;
  const in_ = (x: number, z: number) => x >= x0 && x < x0 + size && z >= z0 && z < z0 + size;
  const gb = new MeshBuilder(groundSpecs());
  gb.setOrigin(cx, 0, cz);
  const surf: number[] = [];
  const villages = plan.settlements.filter((s) => s.kind !== SettleKind.Farm && Math.abs(s.x - cx) < size / 2 + s.r + 400 && Math.abs(s.z - cz) < size / 2 + s.r + 400);
  const inVillage = (x: number, z: number) => villages.some((v) => Math.hypot(x - v.x, z - v.z) < v.r + 25);
  for (const R of plan.roads) {
    const P = R.pts, n = P.length >> 1;
    // Quick reject: no point of the road near the tile.
    let near = false;
    for (let i = 0; i < n; i += 8) if (Math.abs(P[i * 2] - cx) < size / 2 + 80 && Math.abs(P[i * 2 + 1] - cz) < size / 2 + 80) { near = true; break; }
    if (!near && !(Math.abs(P[P.length - 2] - cx) < size / 2 + 80 && Math.abs(P[P.length - 1] - cz) < size / 2 + 80)) continue;
    // Branch lanes (not from the square) sit a hair lower than the street they leave.
    const s0 = R.a >= 0 ? plan.settlements[R.a] : null;
    const branch = R.kind === RoadKind.Lane && !!s0 && Math.hypot(P[0] - s0.x, P[1] - s0.z) > s0.square + 2;
    const dy = DY[R.kind] - (branch ? 0.006 : 0);
    const layer = R.kind === RoadKind.Main ? GroundLayer.Asphalt : R.kind === RoadKind.Lane ? GroundLayer.AsphaltLight : GroundLayer.Dirt;
    // Mitred normals at every point.
    const nx = new Float64Array(n), nz = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      const dx = P[b * 2] - P[a * 2], dz = P[b * 2 + 1] - P[a * 2 + 1], l = Math.hypot(dx, dz) || 1;
      nx[i] = -dz / l; nz[i] = dx / l;
    }
    let s = 0;
    for (let i = 0; i + 1 < n; i++) {
      const ax = P[i * 2], az = P[i * 2 + 1], bx = P[i * 2 + 2], bz = P[i * 2 + 3];
      const L = Math.hypot(bx - ax, bz - az);
      const s1 = s + L;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      if (s1 > R.trim && in_(mx, mz)) {
        // Start exactly at the trim (the city's ground covers the rest).
        const t0 = s < R.trim ? (R.trim - s) / L : 0;
        const px = ax + (bx - ax) * t0, pz = az + (bz - az) * t0;
        ribbon(gb, terrain, px, pz, bx, bz, nx[i], nz[i], nx[i + 1], nz[i + 1], R.hw, dy, layer);
        const h = R.hw;
        pushOutline(surf, [px - nx[i] * h, pz - nz[i] * h, bx - nx[i + 1] * h, bz - nz[i + 1] * h, bx + nx[i + 1] * h, bz + nz[i + 1] * h, px + nx[i] * h, pz + nz[i] * h]);
        if (R.kind === RoadKind.Main && !inVillage(mx, mz)) {
          // Dashed centre line.
          for (let d = Math.ceil(Math.max(s, R.trim + 20) / (DASH_ON + DASH_OFF)) * (DASH_ON + DASH_OFF); d < s1; d += DASH_ON + DASH_OFF) {
            const e = Math.min(s1, d + DASH_ON);
            const ta = (d - s) / L, tb = (e - s) / L;
            ribbon(gb, terrain, ax + (bx - ax) * ta, az + (bz - az) * ta, ax + (bx - ax) * tb, az + (bz - az) * tb, nx[i], nz[i], nx[i + 1], nz[i + 1], 0.08, dy + 0.012, GroundLayer.PaintWhite);
          }
        }
      }
      s = s1;
    }
  }
  // Squares, junctions and yards, buildings, collision boxes of the settlements centred here.
  const fb = new MeshBuilder(facadeSpecs()), fl = new MeshBuilder(facadeSpecs());
  fb.setOrigin(cx, 0, cz);
  fl.setOrigin(cx, 0, cz);
  const obst: number[] = [];
  let e0 = 0, e1 = 0;
  for (const st of plan.settlements) {
    if (!in_(st.x, st.z)) continue;
    const L = plan.layout(st.id);
    for (const p of L.paved) {
      const dy = st.kind === SettleKind.Farm ? 0.045 : 0.075;
      drapeShape(gb, { outer: p.poly, holes: [] }, terrain, dy, p.layer, undefined, 6);
      skirt(gb, terrain, p.poly, dy, p.layer);
      pushOutline(surf, p.poly);
    }
    for (const b of L.buildings) {
      const info = buildBuildingShell(fb, b, e0, terrain, 0, 'shell');
      e0 += info.elemCount;
      e1 += buildBuildingShell(fl, b, e1, terrain, 1).elemCount;
      const o = minAreaRect(b.poly);
      obst.push(o.cx, o.cz, o.hu, o.hv, o.ux, o.uz, info.low, info.base + info.height);
    }
  }
  return {
    ground: gb.empty ? null : gb,
    facade: fb.empty ? null : fb,
    facadeLod: fl.empty ? null : fl,
    obstacles: Float32Array.from(obst),
    surfaces: Float32Array.from(surf),
  };
}

/**
 * A lip round a draped area (counter-clockwise outline): slopes from its surface down under the
 * terrain mesh a little way out, so the edge does not show as a raised slab from the side.
 */
function skirt(mb: MeshBuilder, T: Terrain, poly: number[], dy: number, layer: number): void {
  const W = 1.6, DOWN = TERRAIN_DROP + 0.12;
  const n = poly.length >> 1;
  mb.set('aLayer', layer);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[i * 2], az = poly[i * 2 + 1], bx = poly[j * 2], bz = poly[j * 2 + 1];
    // Outward normals at both ends (averaged with the neighbouring edges: no gaps at the corners).
    const nrm = (k: number): [number, number] => {
      const p = (k + n - 1) % n, q = (k + 1) % n;
      let ux = poly[k * 2] - poly[p * 2], uz = poly[k * 2 + 1] - poly[p * 2 + 1], vx = poly[q * 2] - poly[k * 2], vz = poly[q * 2 + 1] - poly[k * 2 + 1];
      const lu = Math.hypot(ux, uz) || 1, lv = Math.hypot(vx, vz) || 1;
      ux /= lu; uz /= lu; vx /= lv; vz /= lv;
      const ox = uz + vz, oz = -ux - vx, l = Math.hypot(ox, oz) || 1;
      return [ox / l, oz / l];
    };
    const [anx, anz] = nrm(i), [bnx, bnz] = nrm(j);
    const base = mb.vcount;
    const pts = [[ax, az, dy], [bx, bz, dy], [bx + bnx * W, bz + bnz * W, -DOWN], [ax + anx * W, az + anz * W, -DOWN]];
    for (const [x, z, d] of pts) mb.v(x, T.height(x, z) + d, z, 0, 1, 0, x, z);
    // Faces up: clockwise in x/z as in drapeShape (the outline runs counter-clockwise, the lip outside it).
    mb.tri(base, base + 1, base + 2);
    mb.tri(base, base + 2, base + 3);
  }
}

/** A draped ribbon from a to b: three vertices across (follows the cross slope), uv = world x/z. */
function ribbon(mb: MeshBuilder, T: Terrain, ax: number, az: number, bx: number, bz: number, anx: number, anz: number, bnx: number, bnz: number, hw: number, dy: number, layer: number): void {
  mb.set('aLayer', layer);
  const base = mb.vcount;
  const xz: number[] = [];
  for (const [x, z, nx, nz] of [[ax, az, anx, anz], [bx, bz, bnx, bnz]]) {
    for (const k of [-1, 0, 1]) {
      const px = x + nx * hw * k, pz = z + nz * hw * k;
      xz.push(px, pz);
      mb.v(px, T.height(px, pz) + dy, pz, 0, 1, 0, px, pz);
    }
  }
  // Rows a (0..2) and b (3..5); every triangle faces +y (clockwise in x/z, as in drapeShape).
  const up = (a: number, b: number, c: number) => {
    const cr = (xz[b * 2] - xz[a * 2]) * (xz[c * 2 + 1] - xz[a * 2 + 1]) - (xz[b * 2 + 1] - xz[a * 2 + 1]) * (xz[c * 2] - xz[a * 2]);
    if (cr > 0) mb.tri(base + a, base + c, base + b); else mb.tri(base + a, base + b, base + c);
  };
  for (let k = 0; k < 2; k++) { up(k, k + 1, 4 + k); up(k, 4 + k, 3 + k); }
}
