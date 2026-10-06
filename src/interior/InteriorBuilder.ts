/**
 * Meshes for a generated storey: floor finishes, ceiling, interior walls (painted per room on
 * each side, plaster, baseboards, door frames, tiled wainscots in baths and kitchens), the stairs
 * (switchback flights, landings, handrails), furniture, rugs, glowing screens and lamp shades, and
 * the ceiling fixtures. Everything deterministic per plan (no Math.random: a storey rebuilt when
 * the player comes back looks the same).
 */
import * as THREE from 'three';
import earcut from 'earcut';
import type { FloorPlan, Furn, IWall, Room } from './InteriorGen';
import { difference } from '../core/clip';
import { pointInPoly } from '../core/geom2';

const WALL_T = 0.12;
const DOOR_H = 2.15;

type C3 = [number, number, number];

/** Procedural canvas textures for interior floors and walls (seeded: the same every session). */
function canvasTex(draw: (g: CanvasRenderingContext2D, s: number, rnd: (a: number, b: number) => number) => void, size = 256, seed = 1): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  let st = seed >>> 0;
  const rnd = (a: number, b: number) => { st = (Math.imul(st, 1664525) + 1013904223) >>> 0; return a + (st / 4294967296) * (b - a); };
  draw(g, size, rnd);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

let mats: Record<string, THREE.Material> | null = null;
export function interiorMaterials(): Record<string, THREE.Material> {
  if (mats) return mats;
  const wood = canvasTex((g, s, rnd) => {
    for (let y = 0; y < s; y += 16) {
      for (let x = (y / 16) % 2 ? -64 : 0; x < s; x += 128) {
        const v = rnd(0.85, 1.1);
        g.fillStyle = `rgb(${150 * v | 0},${105 * v | 0},${68 * v | 0})`;
        g.fillRect(x, y, 128, 16);
        g.strokeStyle = 'rgba(40,25,10,0.35)';
        g.strokeRect(x + 0.5, y + 0.5, 128, 16);
        for (let k = 0; k < 6; k++) { g.strokeStyle = `rgba(80,50,25,${rnd(0.05, 0.15)})`; g.beginPath(); g.moveTo(x, y + rnd(2, 14)); g.lineTo(x + 128, y + rnd(2, 14)); g.stroke(); }
      }
    }
  }, 256, 11);
  const tile = canvasTex((g, s, rnd) => {
    g.fillStyle = '#b8b8b2'; g.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 32) for (let x = 0; x < s; x += 32) { const v = rnd(0.92, 1.05); g.fillStyle = `rgb(${225 * v | 0},${224 * v | 0},${218 * v | 0})`; g.fillRect(x + 1, y + 1, 30, 30); }
  }, 256, 12);
  const carpet = canvasTex((g, s, rnd) => {
    g.fillStyle = '#5a5f68'; g.fillRect(0, 0, s, s);
    for (let k = 0; k < 6000; k++) { g.fillStyle = `rgba(${rnd(60, 110) | 0},${rnd(65, 110) | 0},${rnd(75, 120) | 0},0.5)`; g.fillRect(rnd(0, s), rnd(0, s), 1.5, 1.5); }
  }, 256, 13);
  const concrete = canvasTex((g, s, rnd) => {
    g.fillStyle = '#9c9a95'; g.fillRect(0, 0, s, s);
    for (let k = 0; k < 4000; k++) { g.fillStyle = `rgba(${rnd(120, 170) | 0},${rnd(120, 168) | 0},${rnd(115, 160) | 0},0.4)`; g.fillRect(rnd(0, s), rnd(0, s), 2, 2); }
  }, 256, 14);
  const marble = canvasTex((g, s, rnd) => {
    g.fillStyle = '#e8e4dc'; g.fillRect(0, 0, s, s);
    for (let k = 0; k < 40; k++) { g.strokeStyle = `rgba(120,115,110,${rnd(0.05, 0.25)})`; g.lineWidth = rnd(0.5, 2); g.beginPath(); g.moveTo(rnd(0, s), 0); g.bezierCurveTo(rnd(0, s), rnd(0, s), rnd(0, s), rnd(0, s), rnd(0, s), s); g.stroke(); }
    g.strokeStyle = 'rgba(90,85,80,0.4)'; g.strokeRect(0, 0, s, s);
  }, 256, 15);
  const stone = canvasTex((g, s, rnd) => {
    for (let y = 0; y < s; y += 64) for (let x = 0; x < s; x += 64) { const v = rnd(0.85, 1.05); g.fillStyle = `rgb(${190 * v | 0},${180 * v | 0},${165 * v | 0})`; g.fillRect(x + 1, y + 1, 62, 62); }
  }, 256, 16);
  // Plaster: a soft mottle (white, tinted per room by the vertex colour).
  const plaster = canvasTex((g, s, rnd) => {
    g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, s, s);
    for (let k = 0; k < 900; k++) { const r = rnd(4, 22); g.fillStyle = `rgba(${rnd(200, 255) | 0},${rnd(200, 255) | 0},${rnd(200, 255) | 0},0.05)`; g.beginPath(); g.arc(rnd(0, s), rnd(0, s), r, 0, 6.3); g.fill(); }
    for (let k = 0; k < 3000; k++) { g.fillStyle = `rgba(0,0,0,${rnd(0.01, 0.04)})`; g.fillRect(rnd(0, s), rnd(0, s), 1, 1); }
  }, 256, 17);
  // Small square wall tiles (white, tinted by the vertex colour).
  const wallTile = canvasTex((g, s, rnd) => {
    g.fillStyle = '#c9cbc9'; g.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 32) for (let x = 0; x < s; x += 32) { const v = rnd(0.95, 1.02); g.fillStyle = `rgb(${245 * v | 0},${246 * v | 0},${246 * v | 0})`; g.fillRect(x + 1.5, y + 1.5, 29, 29); }
  }, 256, 18);
  // Rugs: a border and a pattern (tinted by the vertex colour).
  const rug = canvasTex((g, s, rnd) => {
    g.fillStyle = '#d9d2c4'; g.fillRect(0, 0, s, s);
    g.fillStyle = '#7b2e2a'; g.fillRect(8, 8, s - 16, s - 16);
    g.fillStyle = '#e6dcc8'; g.fillRect(18, 18, s - 36, s - 36);
    g.fillStyle = '#9c3f37'; g.fillRect(26, 26, s - 52, s - 52);
    g.strokeStyle = '#e8d9b8'; g.lineWidth = 3;
    for (let k = 0; k < 6; k++) { const m = 40 + k * 14; g.strokeRect(m, m, s - 2 * m, s - 2 * m); }
    for (let k = 0; k < 300; k++) { g.fillStyle = `rgba(255,255,255,${rnd(0.02, 0.06)})`; g.fillRect(rnd(0, s), rnd(0, s), 2, 2); }
  }, 256, 19);
  const m = (map: THREE.Texture, rough: number) => new THREE.MeshStandardMaterial({ map, roughness: rough, metalness: 0 });
  mats = {
    wood: m(wood, 0.55), tile: m(tile, 0.35), carpet: m(carpet, 0.95), concrete: m(concrete, 0.9), marble: m(marble, 0.2), stone: m(stone, 0.7),
    wall: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }),
    plaster: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, map: plaster }),
    wallTile: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.25, map: wallTile }),
    rug: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, map: rug }),
    furn: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }),
    gloss: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.18, metalness: 0.1 }),
    screen: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.15, emissive: 0x2a4a6a, emissiveIntensity: 0.6 }),
    shade: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, emissive: 0xffd9a0, emissiveIntensity: 0.9, side: THREE.DoubleSide }),
    light: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2dd, emissiveIntensity: 1.3 }),
    rail: new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.6, roughness: 0.4 }),
  };
  return mats;
}

/**
 * One small mesh per interior material (with the same attributes as real floors) so the
 * game can compile their shaders during the loading warm-up instead of on first entry.
 */
export function interiorWarmup(): THREE.Group {
  const g = new THREE.Group();
  for (const mat of Object.values(interiorMaterials())) {
    const geo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    if ((mat as THREE.MeshStandardMaterial).vertexColors) geo.setAttribute('color', new THREE.Float32BufferAttribute(new Array(geo.getAttribute('position').count * 3).fill(1), 3));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    g.add(mesh);
  }
  return g;
}

const TILE_M: Record<string, number> = { wood: 2.4, tile: 2.4, carpet: 3, concrete: 4, marble: 1.2, stone: 2.4 };

class Geo {
  pos: number[] = []; nrm: number[] = []; uv: number[] = []; col: number[] = []; idx: number[] = [];
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, w: number, c: C3): number {
    this.pos.push(x, y, z); this.nrm.push(nx, ny, nz); this.uv.push(u, w); this.col.push(c[0], c[1], c[2]);
    return this.pos.length / 3 - 1;
  }
  quad(a: number, b: number, c: number, d: number): void { this.idx.push(a, b, c, a, c, d); }
  box(x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw: number, c: C3): void {
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const P = (lx: number, ly: number, lz: number): [number, number, number] => [x + lx * cs + lz * sn, y + ly, z - lx * sn + lz * cs];
    const faces: [[number, number, number], number[][]][] = [
      [[1, 0, 0], [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]]],
      [[-1, 0, 0], [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]]],
      [[0, 1, 0], [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]]],
      [[0, -1, 0], [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]]],
      [[0, 0, 1], [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]]],
      [[0, 0, -1], [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]]],
    ];
    for (const [n, corners] of faces) {
      const wn: [number, number, number] = [n[0] * cs + n[2] * sn, n[1], -n[0] * sn + n[2] * cs];
      const i0 = this.pos.length / 3;
      for (const cc of corners) { const p = P(cc[0], cc[1], cc[2]); this.v(p[0], p[1], p[2], wn[0], wn[1], wn[2], (cc[0] + cc[2]) * 0.5, cc[1] * 0.5, c); }
      this.quad(i0, i0 + 1, i0 + 2, i0 + 3);
    }
  }
  /** Vertical cylinder (or cone: r1 at the top) from y0 to y1, closed on top. */
  cyl(x: number, y0: number, z: number, y1: number, r0: number, r1: number, seg: number, c: C3, cap = true): void {
    const base = this.pos.length / 3;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const sl = (r0 - r1) / Math.max(0.01, y1 - y0);
      const nl = Math.hypot(1, sl);
      this.v(x + ca * r0, y0, z + sa * r0, ca / nl, sl / nl, sa / nl, i / seg, 0, c);
      this.v(x + ca * r1, y1, z + sa * r1, ca / nl, sl / nl, sa / nl, i / seg, 1, c);
    }
    for (let i = 0; i < seg; i++) { const a = base + i * 2; this.quad(a, a + 1, a + 3, a + 2); }
    if (cap && r1 > 0.001) {
      const ct = this.v(x, y1, z, 0, 1, 0, 0.5, 0.5, c);
      const r0i = this.pos.length / 3;
      for (let i = 0; i <= seg; i++) { const a = (i / seg) * Math.PI * 2; this.v(x + Math.cos(a) * r1, y1, z + Math.sin(a) * r1, 0, 1, 0, 0, 0, c); }
      for (let i = 0; i < seg; i++) this.idx.push(ct, r0i + i + 1, r0i + i);
    }
  }
  /** A flat quad with its own UV square (rugs, pictures). Corners counter-clockwise seen from the normal. */
  quadUV(a: number[], b: number[], c: number[], d: number[], n: number[], col: C3, uw = 1, vw = 1): void {
    const i = this.v(a[0], a[1], a[2], n[0], n[1], n[2], 0, 0, col);
    this.v(b[0], b[1], b[2], n[0], n[1], n[2], uw, 0, col);
    this.v(c[0], c[1], c[2], n[0], n[1], n[2], uw, vw, col);
    this.v(d[0], d[1], d[2], n[0], n[1], n[2], 0, vw, col);
    this.quad(i, i + 1, i + 2, i + 3);
  }
  build(): THREE.BufferGeometry | null {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** Flat polygon (with holes) facing up or down at height y. */
function flat(geo: Geo, poly: number[], holes: number[][], y: number, up: boolean, tile: number, c: C3): void {
  const flatArr = poly.slice();
  const hi: number[] = [];
  for (const h of holes) { hi.push(flatArr.length / 2); flatArr.push(...h); }
  const tris = earcut(flatArr, hi.length ? hi : undefined, 2);
  const base = geo.pos.length / 3;
  for (let i = 0; i < flatArr.length; i += 2) geo.v(flatArr[i], y, flatArr[i + 1], 0, up ? 1 : -1, 0, flatArr[i] / tile, flatArr[i + 1] / tile, c);
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i], b = tris[i + 1], d = tris[i + 2];
    const cr = (flatArr[b * 2] - flatArr[a * 2]) * (flatArr[d * 2 + 1] - flatArr[a * 2 + 1]) - (flatArr[b * 2 + 1] - flatArr[a * 2 + 1]) * (flatArr[d * 2] - flatArr[a * 2]);
    const isUp = cr < 0;
    if (isUp === up) geo.idx.push(base + a, base + b, base + d);
    else geo.idx.push(base + a, base + d, base + b);
  }
}

/** A polygon minus several openings. */
function minus(poly: number[], holes: number[][]): { outer: number[]; holes: number[][] }[] {
  return difference([poly], holes);
}

/** A small deterministic random stream from a position (furniture details). */
function seeded(x: number, z: number, k = 0): () => number {
  let s = (Math.floor(x * 97.13) * 73856093) ^ (Math.floor(z * 89.71) * 19349663) ^ (k * 83492791);
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

const BOOKS: C3[] = [[0.55, 0.12, 0.1], [0.12, 0.25, 0.45], [0.15, 0.38, 0.22], [0.75, 0.6, 0.25], [0.85, 0.82, 0.75], [0.25, 0.22, 0.2], [0.45, 0.2, 0.42], [0.8, 0.4, 0.15]];

interface Geos { walls: Geo; tiles: Geo; furn: Geo; gloss: Geo; rugs: Geo; screens: Geo; shades: Geo; lights: Geo; struct: Geo }

/**
 * `floorHoles`: openings in this storey's slab (the stairs and lift arriving from below);
 * `ceilHoles`: openings in its ceiling. `slabPoly`: the storey's full slab outline (to the facade),
 * so the floor reaches the door sill.
 */
export function buildFloorMeshes(plan: FloorPlan, floorPoly: number[], floorHoles: number[][], ceilHoles: number[][], slabPoly = floorPoly): THREE.Group {
  const M = interiorMaterials();
  const group = new THREE.Group();
  const y = plan.y;
  const G: Geos = { walls: new Geo(), tiles: new Geo(), furn: new Geo(), gloss: new Geo(), rugs: new Geo(), screens: new Geo(), shades: new Geo(), lights: new Geo(), struct: new Geo() };
  // Floor finishes per room material.
  const byMat = new Map<string, Geo>();
  for (const room of plan.rooms) {
    let g = byMat.get(room.floorMat);
    if (!g) byMat.set(room.floorMat, (g = new Geo()));
    const polys = floorHoles.length ? minus(room.poly, floorHoles) : [{ outer: room.poly, holes: [] }];
    for (const p of polys) flat(g, p.outer, p.holes, y + 0.035, true, TILE_M[room.floorMat] ?? 2, [1, 1, 1]);
  }
  for (const [m, g] of byMat) {
    const geo = g.build();
    if (geo) { const mesh = new THREE.Mesh(geo, M[m]); mesh.receiveShadow = true; group.add(mesh); }
  }
  // Structural floor under the finishes and the ceiling (with the openings).
  const sg = G.struct;
  for (const p of floorHoles.length ? minus(slabPoly, floorHoles) : [{ outer: slabPoly, holes: [] }]) flat(sg, p.outer, p.holes, y + 0.02, true, 4, [0.6, 0.6, 0.58]);
  for (const p of ceilHoles.length ? minus(floorPoly, ceilHoles) : [{ outer: floorPoly, holes: [] }]) flat(sg, p.outer, p.holes, y + plan.height - 0.03, false, 4, [0.95, 0.95, 0.93]);
  // Interior walls, painted per room, with baseboards, frames and wainscots.
  for (const w of plan.walls) wallSegments(G, plan, w, y, plan.height);
  // Baseboards along the outer walls (the storey's outline, inside).
  outlineTrim(G, plan, floorPoly, y);
  // Stairs.
  stairs(G, plan);
  // Furniture.
  for (const f of plan.furniture) buildFurniture(G, f, y + 0.035);
  // Ceiling fixtures.
  for (let i = 0, k = 0; i < plan.lights.length; i += 2, k++) fixture(G, plan.lights[i], plan.lights[i + 1], y + plan.height, plan.fixtures[k] ?? 0);
  const add = (g: Geo, mat: THREE.Material, cast = true) => {
    const geo = g.build();
    if (!geo) return;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = cast;
    group.add(mesh);
  };
  add(G.struct, M.wall);
  add(G.walls, M.plaster);
  add(G.tiles, M.wallTile, false);
  add(G.furn, M.furn);
  add(G.gloss, M.gloss);
  add(G.rugs, M.rug, false);
  add(G.screens, M.screen, false);
  add(G.shades, M.shade, false);
  add(G.lights, M.light, false);
  return group;
}

/** The room a point lies in (walls are coloured by the room on each side). */
function roomAt(plan: FloorPlan, x: number, z: number): Room | null {
  for (const r of plan.rooms) if (pointInPoly(r.poly, x, z)) return r;
  return null;
}

const BASE: C3 = [0.93, 0.92, 0.89];
const FRAME: C3 = [0.95, 0.94, 0.91];

/**
 * A wall with its doorways: per piece two painted faces (each the colour of the room it faces) and
 * plain edges; baseboards on both faces; frames round every doorway; tiles up to 1.3 m on the bath
 * side, a splashback on the kitchen side.
 */
function wallSegments(G: Geos, plan: FloorPlan, w: IWall, y: number, h: number): void {
  const L = Math.hypot(w.bx - w.ax, w.bz - w.az);
  if (L < 0.2) return;
  const dx = (w.bx - w.ax) / L, dz = (w.bz - w.az) / L;
  const nx = -dz, nz = dx, t = WALL_T / 2;
  const mx = (w.ax + w.bx) / 2, mz = (w.az + w.bz) / 2;
  const rA = roomAt(plan, mx + nx * 0.3, mz + nz * 0.3), rB = roomAt(plan, mx - nx * 0.3, mz - nz * 0.3);
  const cA: C3 = rA?.wallColor ?? [0.9, 0.89, 0.86], cB: C3 = rB?.wallColor ?? [0.9, 0.89, 0.86];
  const g = G.walls;
  const P = (s: number, side: number, yy: number) => [w.ax + dx * s + nx * side * t, yy, w.az + dz * s + nz * side * t];
  const face = (s0: number, s1: number, y0: number, y1: number, side: number, c: C3) => {
    const a = P(s0, side, y0), b = P(s1, side, y0), cc = P(s1, side, y1), d = P(s0, side, y1);
    const i = g.v(a[0], a[1], a[2], nx * side, 0, nz * side, s0 / 2, y0 / 2, c);
    g.v(b[0], b[1], b[2], nx * side, 0, nz * side, s1 / 2, y0 / 2, c);
    g.v(cc[0], cc[1], cc[2], nx * side, 0, nz * side, s1 / 2, y1 / 2, c);
    g.v(d[0], d[1], d[2], nx * side, 0, nz * side, s0 / 2, y1 / 2, c);
    if (side > 0) g.quad(i, i + 1, i + 2, i + 3); else g.quad(i, i + 3, i + 2, i + 1);
  };
  const edge = (s: number, y0: number, y1: number, dir: number) => {
    const a = P(s, -1, y0), b = P(s, 1, y0), c = P(s, 1, y1), d = P(s, -1, y1);
    const i = g.v(a[0], a[1], a[2], dx * dir, 0, dz * dir, 0, 0, BASE);
    g.v(b[0], b[1], b[2], dx * dir, 0, dz * dir, 0.06, 0, BASE);
    g.v(c[0], c[1], c[2], dx * dir, 0, dz * dir, 0.06, 1, BASE);
    g.v(d[0], d[1], d[2], dx * dir, 0, dz * dir, 0, 1, BASE);
    if (dir > 0) g.quad(i, i + 3, i + 2, i + 1); else g.quad(i, i + 1, i + 2, i + 3);
  };
  const piece = (s0: number, s1: number, y0: number, y1: number) => {
    if (s1 - s0 < 0.01) return;
    face(s0, s1, y0, y1, 1, cA);
    face(s0, s1, y0, y1, -1, cB);
    const top = [P(s0, -1, y1), P(s1, -1, y1), P(s1, 1, y1), P(s0, 1, y1)];
    const i = g.v(top[0][0], top[0][1], top[0][2], 0, 1, 0, 0, 0, BASE);
    for (let k = 1; k < 4; k++) g.v(top[k][0], top[k][1], top[k][2], 0, 1, 0, 0, 0, BASE);
    g.quad(i, i + 3, i + 2, i + 1);
    const bot = [P(s0, -1, y0), P(s1, -1, y0), P(s1, 1, y0), P(s0, 1, y0)];
    const j = g.v(bot[0][0], bot[0][1], bot[0][2], 0, -1, 0, 0, 0, BASE);
    for (let k = 1; k < 4; k++) g.v(bot[k][0], bot[k][1], bot[k][2], 0, -1, 0, 0, 0, BASE);
    g.quad(j, j + 1, j + 2, j + 3);
  };
  const doors = w.doors.slice().sort((a, b) => a[0] - b[0]).map(([a, b]) => [a * L, b * L] as [number, number]);
  let s = 0;
  const solid: [number, number][] = [];
  for (const [d0, d1] of doors) {
    piece(s, d0, y, y + h);
    if (d0 - s > 0.01) { solid.push([s, d0]); edge(d0, y, y + DOOR_H, 1); }
    piece(d0, d1, y + DOOR_H, y + h);
    if (s > 0 || d0 > 0.01) { /* jamb on the far side */ }
    edge(d1, y, y + DOOR_H, -1);
    s = d1;
  }
  piece(s, L, y, y + h);
  if (L - s > 0.01) solid.push([s, L]);
  if (!doors.length) { edge(0, y, y + h, -1); edge(L, y, y + h, 1); }
  // Trim: baseboards along the solid parts, frames round the doorways (both faces).
  const f = G.furn;
  const yaw = Math.atan2(dx, dz);
  for (const side of [1, -1]) {
    const off = t + 0.012;
    for (const [s0, s1] of solid) {
      const sm = (s0 + s1) / 2;
      f.box(w.ax + dx * sm + nx * side * off, y + 0.075, w.az + dz * sm + nz * side * off, 0.012, 0.045, (s1 - s0) / 2, yaw, BASE);
    }
    for (const [d0, d1] of doors) {
      for (const sd of [d0 - 0.04, d1 + 0.04]) f.box(w.ax + dx * sd + nx * side * off, y + 0.04 + DOOR_H / 2, w.az + dz * sd + nz * side * off, 0.012, DOOR_H / 2, 0.04, yaw, FRAME);
      const sm = (d0 + d1) / 2;
      f.box(w.ax + dx * sm + nx * side * off, y + DOOR_H + 0.04, w.az + dz * sm + nz * side * off, 0.012, 0.04, (d1 - d0) / 2 + 0.08, yaw, FRAME);
    }
    // Wall tiles on a bath's side (to 1.3 m), a splashback over the kitchen counter.
    const room = side > 0 ? rA : rB;
    const tileTo = room?.type === 'bath' ? 1.35 : 0;
    if (tileTo) for (const [s0, s1] of solid) {
      const a = P(s0, side, y + 0.12), b = P(s1, side, y + 0.12);
      const o = 0.006 * side;
      tilesQuad(G.tiles, [a[0] + nx * o, a[1], a[2] + nz * o], [b[0] + nx * o, b[1], b[2] + nz * o], tileTo, side > 0 ? [nx, 0, nz] : [-nx, 0, -nz], side < 0, [0.92, 0.95, 0.97]);
    }
  }
}

function tilesQuad(g: Geo, a: number[], b: number[], h: number, n: number[], flip: boolean, c: C3): void {
  const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const A = a, B = b, C = [b[0], b[1] + h, b[2]], D = [a[0], a[1] + h, a[2]];
  if (flip) g.quadUV(A, D, C, B, n, c, h / 1.2, L / 1.2);
  else g.quadUV(A, B, C, D, n, c, L / 1.2, h / 1.2);
}

/** Baseboards round the storey's outline (the inside of the outer walls). */
function outlineTrim(G: Geos, plan: FloorPlan, poly: number[], y: number): void {
  const n = poly.length / 2;
  // Orientation: inward normals.
  let area = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; area += poly[i * 2] * poly[j * 2 + 1] - poly[j * 2] * poly[i * 2 + 1]; }
  const sg = area > 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[i * 2], az = poly[i * 2 + 1], bx = poly[j * 2], bz = poly[j * 2 + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.4) continue;
    const dx = (bx - ax) / L, dz = (bz - az) / L;
    const nx = -dz * sg, nz = dx * sg;
    const mx = (ax + bx) / 2 + nx * 0.015, mz = (az + bz) / 2 + nz * 0.015;
    G.furn.box(mx, y + 0.075, mz, 0.012, 0.045, L / 2, Math.atan2(dx, dz), BASE);
  }
  void plan;
}

/** Switchback flights: steps (with a soffit under them), landings, handrails. */
function stairs(G: Geos, plan: FloorPlan): void {
  const stepC: C3 = [0.72, 0.7, 0.66], nose: C3 = [0.5, 0.48, 0.45];
  for (const fl of plan.flights) {
    const rise = fl.y1 - fl.y0, n = Math.max(4, Math.round(rise / 0.175)), r = rise / n, tread = fl.run / n;
    const yaw = Math.atan2(fl.dx, fl.dz);
    for (let k = 0; k < n; k++) {
      const s = tread * (k + 0.5), top = fl.y0 + r * (k + 1);
      const cx = fl.x + fl.dx * s, cz = fl.z + fl.dz * s;
      // Each step a block down to a sloped soffit 25 cm under the flight's line.
      const bottom = fl.y0 + r * k - 0.25;
      G.struct.box(cx, (top + bottom) / 2, cz, fl.width / 2, (top - bottom) / 2, tread / 2, yaw, stepC);
      G.furn.box(cx + fl.dx * (tread / 2 - 0.02), top - 0.012, cz + fl.dz * (tread / 2 - 0.02), fl.width / 2 - 0.02, 0.014, 0.025, yaw, nose);
    }
    // Handrail on the outer side.
    const px = -fl.dz, pz = fl.dx;
    for (const side of [1, -1]) {
      const ox = px * side * (fl.width / 2 - 0.05), oz = pz * side * (fl.width / 2 - 0.05);
      const len = Math.hypot(fl.run, rise), pitch = Math.atan2(rise, fl.run);
      const mx = fl.x + fl.dx * fl.run / 2 + ox, mz = fl.z + fl.dz * fl.run / 2 + oz;
      const g = new THREE.BoxGeometry(0.04, 0.04, len);
      g.rotateX(-pitch);
      g.rotateY(yaw);
      g.translate(mx, (fl.y0 + fl.y1) / 2 + 0.9, mz);
      const pos = g.getAttribute('position') as THREE.BufferAttribute, nrm = g.getAttribute('normal') as THREE.BufferAttribute, idx = g.getIndex()!;
      const base = G.gloss.pos.length / 3;
      for (let i = 0; i < pos.count; i++) G.gloss.v(pos.getX(i), pos.getY(i), pos.getZ(i), nrm.getX(i), nrm.getY(i), nrm.getZ(i), 0, 0, [0.18, 0.18, 0.19]);
      for (let i = 0; i < idx.count; i++) G.gloss.idx.push(base + idx.getX(i));
      g.dispose();
    }
  }
  for (const l of plan.landings) {
    // A slab under the landing's surface.
    const P = l.poly;
    let cx = 0, cz = 0;
    for (let i = 0; i < 8; i += 2) { cx += P[i] / 4; cz += P[i + 1] / 4; }
    const ex = P[2] - P[0], ez = P[3] - P[1], hl = Math.hypot(ex, ez) / 2;
    const hw = Math.hypot(P[6] - P[0], P[7] - P[1]) / 2;
    G.struct.box(cx, l.y - 0.11, cz, hw, 0.11, hl, Math.atan2(ex, ez) + Math.PI / 2, stepC);
  }
}

/** A ceiling fixture: 0 a flat panel, 1 a pendant lamp (cord and glowing shade), 2 a round lamp. */
function fixture(G: Geos, x: number, z: number, ceil: number, kind: number): void {
  if (kind === 1) {
    G.furn.cyl(x, ceil - 0.75, z, ceil, 0.006, 0.006, 4, [0.1, 0.1, 0.1], false);
    G.shades.cyl(x, ceil - 0.95, z, ceil - 0.72, 0.24, 0.07, 14, [1, 0.9, 0.75], false);
    G.lights.box(x, ceil - 0.9, z, 0.05, 0.04, 0.05, 0, [1, 1, 1]);
  } else if (kind === 2) {
    G.lights.cyl(x, ceil - 0.08, z, ceil - 0.02, 0.2, 0.2, 16, [1, 1, 1]);
  } else G.lights.box(x, ceil - 0.06, z, 0.3, 0.02, 0.3, 0, [1, 1, 1]);
}

function buildFurniture(G: Geos, f: Furn, y: number): void {
  const g = G.furn;
  const c = f.color;
  const yaw = f.yaw;
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const W = (lx: number, lz: number): [number, number] => [f.x + lx * cs + lz * sn, f.z - lx * sn + lz * cs];
  const B = (lx: number, ly: number, lz: number, hx: number, hy: number, hz: number, col: C3 = c, geo: Geo = g) => {
    const [x, z] = W(lx, lz);
    geo.box(x, y + ly, z, hx, hy, hz, yaw, col);
  };
  const Cy = (lx: number, ly0: number, lz: number, ly1: number, r0: number, r1: number, col: C3, seg = 10, geo: Geo = g) => {
    const [x, z] = W(lx, lz);
    geo.cyl(x, y + ly0, z, y + ly1, r0, r1, seg, col);
  };
  const rnd = seeded(f.x, f.z, f.kind.length);
  const w = f.w / 2, d = f.d / 2, h = f.h;
  const sc = (k: number): C3 => [c[0] * k, c[1] * k, c[2] * k];
  const dark = sc(0.6);
  switch (f.kind) {
    case 'bed': case 'bedDouble': {
      const frame: C3 = [0.35, 0.25, 0.18];
      B(0, 0.15, 0, w, 0.15, d, frame);
      for (const a of [-1, 1]) for (const b of [-1, 1]) B(a * (w - 0.04), 0.06, b * (d - 0.04), 0.035, 0.06, 0.035, sc(0.5));
      B(0, 0.36, 0.03, w - 0.03, 0.08, d - 0.06, [0.94, 0.94, 0.93]);
      // Duvet folded back a little, pillows at the head.
      B(0, 0.46, 0.18, w - 0.02, 0.04, d * 0.78, c);
      B(0, 0.5, -d * 0.33, w - 0.02, 0.025, 0.1, sc(1.12));
      const np = f.kind === 'bedDouble' ? 2 : 1;
      for (let i = 0; i < np; i++) B(np === 2 ? (i ? 1 : -1) * w * 0.48 : 0, 0.5, -d + 0.28, np === 2 ? w * 0.42 : w * 0.7, 0.07, 0.17, [0.97, 0.97, 0.96]);
      B(0, 0.62, -d + 0.03, w + 0.02, 0.62, 0.04, frame);
      break;
    }
    case 'sofa': case 'armchair': {
      const legs: C3 = [0.2, 0.15, 0.1];
      for (const a of [-1, 1]) for (const b of [-1, 1]) B(a * (w - 0.08), 0.04, b * (d - 0.08), 0.025, 0.04, 0.025, legs);
      B(0, 0.2, 0, w, 0.12, d, c);
      const arm = 0.12;
      const seats = f.kind === 'sofa' ? Math.max(2, Math.round((w * 2 - 2 * arm) / 0.65)) : 1;
      const sw = (w * 2 - 2 * arm) / seats;
      for (let i = 0; i < seats; i++) {
        const lx = -w + arm + sw * (i + 0.5);
        B(lx, 0.39, 0.06, sw / 2 - 0.015, 0.08, d - 0.18, sc(1.08));
        B(lx, 0.66, -d + 0.2, sw / 2 - 0.02, 0.2, 0.09, sc(1.05));
      }
      B(0, 0.55, -d + 0.08, w, 0.32, 0.08, c);
      B(-w + arm / 2, 0.42, 0, arm / 2, 0.18, d, c); B(w - arm / 2, 0.42, 0, arm / 2, 0.18, d, c);
      if (f.kind === 'sofa' && rnd() < 0.6) B(-w + arm + 0.22, 0.56, -d + 0.36, 0.17, 0.15, 0.05, sc(0.6));
      break;
    }
    case 'chair': {
      B(0, 0.45, 0, w, 0.025, d);
      for (let i = -1; i <= 1; i++) B(i * (w - 0.08) * 0.7, 0.72, -d + 0.03, 0.025, 0.24, 0.015);
      B(0, 0.95, -d + 0.03, w, 0.03, 0.02);
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) B(a * (w - 0.03), 0.22, b * (d - 0.03), 0.018, 0.22, 0.018, dark);
      break;
    }
    case 'officeChair':
      B(0, 0.48, 0, w * 0.8, 0.05, d * 0.8); B(0, 0.82, -d * 0.62, w * 0.75, 0.28, 0.05); B(0, 0.25, 0, 0.03, 0.22, 0.03, [0.3, 0.3, 0.3]);
      for (const a of [0, 1.256, 2.513, 3.77, 5.026]) { const lx = Math.cos(a) * w * 0.4, lz = Math.sin(a) * w * 0.4; B(lx / 2, 0.04, lz / 2, Math.abs(lx) / 2 + 0.02, 0.015, Math.abs(lz) / 2 + 0.02, [0.2, 0.2, 0.2]); }
      for (const a of [-1, 1]) B(a * w * 0.78, 0.62, 0, 0.025, 0.02, d * 0.45, [0.2, 0.2, 0.2]);
      break;
    case 'diningTable': case 'coffeeTable': case 'desk': case 'meetingTable': {
      B(0, h - 0.025, 0, w, 0.025, d);
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) B(a * (w - 0.05), (h - 0.05) / 2, b * (d - 0.05), 0.025, (h - 0.05) / 2, 0.025, dark);
      if (f.kind === 'desk') {
        B(0.3, h + 0.012, 0.12, 0.22, 0.01, 0.07, [0.12, 0.12, 0.13]);
        if (rnd() < 0.6) Cy(-w + 0.2, h, 0.15, h + 0.1, 0.04, 0.04, [0.9, 0.9, 0.88], 8);
        if (rnd() < 0.5) B(-w + 0.35, h + 0.02, -0.05, 0.12, 0.02, 0.15, [0.95, 0.95, 0.93]);
      } else if (f.kind === 'diningTable' || f.kind === 'coffeeTable') {
        const r = rnd();
        if (r < 0.4) { Cy(0, h, 0, h + 0.22, 0.05, 0.035, [0.75, 0.82, 0.86], 10, G.gloss); for (let k = 0; k < 3; k++) Cy((rnd() - 0.5) * 0.06, h + 0.22, (rnd() - 0.5) * 0.06, h + 0.3, 0.03, 0.03, [0.85, 0.3 + rnd() * 0.5, 0.35], 6); }
        else if (r < 0.75) Cy(0, h, 0, h + 0.07, 0.12, 0.16, [0.88, 0.86, 0.8], 14, G.gloss);
        else for (let k = 0; k < 3; k++) B((rnd() - 0.5) * w, h + 0.015, (rnd() - 0.5) * d, 0.12, 0.012, 0.16, BOOKS[Math.floor(rnd() * BOOKS.length)]);
      }
      break;
    }
    case 'cafeTable':
      Cy(0, h - 0.03, 0, h, w, w, c, 16);
      Cy(0, 0, 0, h - 0.03, 0.03, 0.03, [0.15, 0.15, 0.15], 8);
      Cy(0, 0, 0, 0.02, 0.22, 0.22, [0.15, 0.15, 0.15], 12);
      if (rnd() < 0.5) Cy(0.12, h, 0.05, h + 0.09, 0.04, 0.045, [0.95, 0.95, 0.93], 8, G.gloss);
      break;
    case 'wardrobe':
      B(0, h / 2, 0, w, h / 2, d, c);
      B(0, h / 2, d + 0.004, 0.006, h / 2 - 0.04, 0.004, dark);
      for (const a of [-1, 1]) B(a * 0.05, h * 0.52, d + 0.02, 0.01, 0.12, 0.015, [0.75, 0.72, 0.6]);
      B(0, h - 0.02, 0, w + 0.02, 0.02, d + 0.02, sc(0.85));
      break;
    case 'bookshelf': case 'shelf': case 'shopShelf': {
      // A frame and shelves; books (or goods) in deterministic colours and heights.
      B(-w + 0.02, h / 2, 0, 0.02, h / 2, d, c); B(w - 0.02, h / 2, 0, 0.02, h / 2, d, c);
      B(0, h - 0.02, 0, w, 0.02, d, c); B(0, 0.04, 0, w, 0.04, d, c);
      B(0, h / 2, -d + 0.01, w, h / 2, 0.01, sc(0.75));
      const levels = f.kind === 'shelf' ? 3 : 5;
      for (let k = 1; k < levels; k++) {
        const yy = (h * k) / levels;
        B(0, yy, 0, w - 0.03, 0.012, d - 0.01, sc(0.85));
      }
      if (f.kind === 'shelf') { for (let k = 0; k < levels; k++) B(0, (h * (k + 0.5)) / levels, d + 0.004, w - 0.04, h / levels / 2 - 0.02, 0.005, sc(0.92)); B(0, 0, 0, 0, 0, 0); break; }
      for (let k = 0; k < levels; k++) {
        const yy = (h * k) / levels + 0.02, room = h / levels - 0.06;
        let x = -w + 0.05;
        while (x < w - 0.08) {
          const bw = f.kind === 'shopShelf' ? 0.08 + rnd() * 0.12 : 0.025 + rnd() * 0.035;
          if (rnd() < (f.kind === 'shopShelf' ? 0.08 : 0.12)) { x += bw + 0.05; continue; }
          const bh = room * (f.kind === 'shopShelf' ? 0.45 + rnd() * 0.4 : 0.65 + rnd() * 0.3);
          const col = f.kind === 'shopShelf' ? ([0.3 + rnd() * 0.65, 0.25 + rnd() * 0.6, 0.2 + rnd() * 0.6] as C3) : BOOKS[Math.floor(rnd() * BOOKS.length)];
          B(Math.min(w - 0.05, x + bw / 2), yy + bh / 2, 0.02, bw / 2 - 0.003, bh / 2, d * (f.kind === 'shopShelf' ? 0.8 : 0.7), col);
          x += bw + 0.004;
        }
      }
      break;
    }
    case 'kitchenRow': {
      // Base cabinets with doors and handles, a worktop, the hob and the sink, wall cabinets and a hood.
      B(0, 0.05, 0.02, w, 0.05, d - 0.04, [0.2, 0.2, 0.2]);
      B(0, (h - 0.1) / 2 + 0.1, 0, w, (h - 0.1) / 2, d, c);
      const n = Math.max(1, Math.round(w * 2 / 0.6));
      for (let i = 0; i < n; i++) {
        const lx = -w + (i + 0.5) * (w * 2 / n);
        B(lx, h * 0.55, d + 0.005, w / n - 0.01, h * 0.4, 0.005, sc(0.96));
        B(lx, h * 0.82, d + 0.02, 0.07, 0.008, 0.012, [0.7, 0.7, 0.72]);
      }
      B(0, h + 0.02, 0, w + 0.01, 0.02, d + 0.02, [0.22, 0.2, 0.2], G.gloss);
      // Hob: a black glass square with four rings.
      const hx = -w * 0.35;
      B(hx, h + 0.042, 0, 0.3, 0.003, 0.26, [0.04, 0.04, 0.05], G.gloss);
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) Cy(hx + a * 0.14, h + 0.044, b * 0.12, h + 0.046, 0.08, 0.08, [0.25, 0.08, 0.06], 12);
      // Sink with a tap.
      const sx = w * 0.35;
      B(sx, h + 0.041, 0, 0.24, 0.004, 0.2, [0.72, 0.74, 0.76], G.gloss);
      B(sx, h + 0.035, 0, 0.2, 0.012, 0.16, [0.45, 0.47, 0.49], G.gloss);
      Cy(sx, h + 0.04, -d + 0.08, h + 0.3, 0.012, 0.012, [0.75, 0.76, 0.78], 6, G.gloss);
      B(sx, h + 0.3, -d + 0.15, 0.012, 0.012, 0.07, [0.75, 0.76, 0.78], G.gloss);
      // Splashback, wall cabinets, the hood over the hob.
      B(0, h + 0.33, -d + 0.008, w, 0.3, 0.008, [0.93, 0.93, 0.9], G.gloss);
      B(0, 1.95, -d + 0.18, w, 0.33, 0.17, c);
      for (let i = 0; i < n; i++) { const lx = -w + (i + 0.5) * (w * 2 / n); B(lx, 1.95, -d + 0.355, w / n - 0.01, 0.31, 0.005, sc(0.96)); }
      B(hx, h + 0.75, -d + 0.22, 0.32, 0.05, 0.22, [0.6, 0.62, 0.64], G.gloss);
      break;
    }
    case 'fridge':
      B(0, h / 2, 0, w, h / 2, d, c, G.gloss);
      B(0, h * 0.62, d + 0.004, w - 0.01, 0.004, 0.004, sc(0.7));
      for (const yy of [h * 0.8, h * 0.45]) B(w - 0.08, yy, d + 0.025, 0.012, 0.12, 0.012, [0.7, 0.7, 0.72]);
      break;
    case 'tvStand': case 'nightstand': case 'crate': case 'altar':
      B(0, h / 2, 0, w, h / 2, d, c);
      if (f.kind === 'nightstand') {
        B(0, h * 0.6, d + 0.004, w - 0.03, h * 0.18, 0.004, sc(0.9));
        B(0, h * 0.6, d + 0.015, 0.04, 0.01, 0.01, [0.7, 0.68, 0.6]);
        // A little lamp on it.
        Cy(0.08, h, -0.02, h + 0.22, 0.015, 0.015, [0.8, 0.75, 0.6], 6);
        Cy(0.08, h + 0.18, -0.02, h + 0.34, 0.11, 0.07, [1, 0.9, 0.75], 12, G.shades);
      }
      if (f.kind === 'tvStand') for (const a of [-1, 1]) B(a * w * 0.5, h / 2, d + 0.004, w * 0.48, h / 2 - 0.03, 0.004, sc(0.85));
      break;
    case 'counter': case 'reception': case 'barCounter': {
      B(0, h / 2, 0, w, h / 2, d, c);
      B(0, h / 2, d + 0.005, w - 0.03, h / 2 - 0.05, 0.005, sc(0.8));
      B(0, h + 0.02, 0, w + 0.03, 0.02, d + 0.05, [0.15, 0.15, 0.16], G.gloss);
      if (f.kind === 'barCounter') {
        for (let x = -w + 0.4; x < w - 0.2; x += 0.65) { Cy(x, 0, d + 0.45, 0.75, 0.025, 0.025, [0.2, 0.2, 0.2], 6); Cy(x, 0.72, d + 0.45, 0.78, 0.18, 0.18, c, 12); }
        for (let x = -w + 0.2; x < w - 0.1; x += 0.25) Cy(x, h + 0.04, -d + 0.15, h + 0.3, 0.035, 0.03, [0.2 + rnd() * 0.5, 0.3 + rnd() * 0.3, 0.2], 6, G.gloss);
      }
      if (f.kind === 'reception') B(0, h + 0.25, -0.1, 0.25, 0.17, 0.02, [0.06, 0.06, 0.07], G.screens);
      break;
    }
    case 'tv':
      B(0, 0.5 + h / 2, 0, w, h / 2, d, [0.04, 0.04, 0.05], G.gloss);
      B(0, 0.5 + h / 2, d + 0.002, w - 0.03, h / 2 - 0.03, 0.002, [0.1, 0.12, 0.16], G.screens);
      break;
    case 'monitor':
      B(0, 0.74 + 0.25, 0, 0.28, 0.17, 0.02, [0.06, 0.06, 0.07]);
      B(0, 0.74 + 0.25, 0.022, 0.26, 0.15, 0.002, [0.12, 0.16, 0.22], G.screens);
      B(0, 0.74 + 0.04, 0, 0.1, 0.04, 0.06, [0.2, 0.2, 0.2]);
      break;
    case 'screen':
      B(0, 1.5, 0, w, h / 2, d, [0.05, 0.05, 0.06], G.gloss);
      B(0, 1.5, d + 0.002, w - 0.04, h / 2 - 0.04, 0.002, [0.14, 0.2, 0.3], G.screens);
      break;
    case 'rug': {
      const [ax, az] = W(-w, -d), [bx, bz] = W(w, -d), [cx, cz] = W(w, d), [dx, dz] = W(-w, d);
      const yy = y + 0.008;
      G.rugs.quadUV([ax, yy, az], [dx, yy, dz], [cx, yy, cz], [bx, yy, bz], [0, 1, 0], [c[0] * 1.6 + 0.2, c[1] * 1.6 + 0.2, c[2] * 1.6 + 0.2]);
      break;
    }
    case 'plant': {
      Cy(0, 0, 0, 0.32, 0.15, 0.19, [0.62, 0.38, 0.26], 10);
      Cy(0, 0.3, 0, 0.31, 0.17, 0.17, [0.25, 0.18, 0.12], 10);
      // Leaves: thin slanted blades round a stem.
      const n = 9 + Math.floor(rnd() * 5);
      for (let k = 0; k < n; k++) {
        const a = rnd() * Math.PI * 2, r = 0.05 + rnd() * 0.18, hh = 0.45 + rnd() * (h - 0.5);
        const [x, z] = W(Math.cos(a) * r, Math.sin(a) * r);
        g.box(x, y + hh, z, 0.11 + rnd() * 0.08, 0.012, 0.045, a + rnd(), [0.12 + rnd() * 0.1, 0.36 + rnd() * 0.2, 0.12 + rnd() * 0.06]);
        g.box(x, y + hh * 0.6, z, 0.008, hh * 0.4, 0.008, 0, [0.2, 0.35, 0.15]);
      }
      break;
    }
    case 'floorLamp':
      Cy(0, 0, 0, 0.03, 0.15, 0.15, [0.15, 0.15, 0.15], 12);
      Cy(0, 0.03, 0, 1.45, 0.012, 0.012, [0.2, 0.2, 0.2], 6);
      Cy(0, 1.35, 0, 1.65, 0.22, 0.14, [1, 0.9, 0.75], 14, G.shades);
      break;
    case 'painting': {
      B(0, 1.5, 0, w, h / 2, d, [0.22, 0.16, 0.1]);
      // An abstract picture: a ground and a few blocks of colour (or a landscape band).
      const pal: C3[] = [[0.85, 0.75, 0.55], [0.2, 0.35, 0.55], [0.75, 0.3, 0.2], [0.3, 0.5, 0.35], [0.9, 0.88, 0.82], [0.15, 0.15, 0.2]];
      B(0, 1.5, d + 0.004, w - 0.05, h / 2 - 0.05, 0.003, c);
      if (rnd() < 0.5) { B(0, 1.5 - h * 0.15, d + 0.008, w - 0.05, h * 0.12, 0.003, pal[3]); B(w * 0.3, 1.5 + h * 0.15, d + 0.008, 0.06, 0.06, 0.003, pal[0]); }
      else for (let k = 0; k < 3; k++) B((rnd() - 0.5) * w, 1.5 + (rnd() - 0.5) * h * 0.5, d + 0.008, 0.05 + rnd() * w * 0.4, 0.04 + rnd() * h * 0.25, 0.003, pal[Math.floor(rnd() * pal.length)]);
      break;
    }
    case 'mirror':
      B(0, 1.45, 0, w + 0.02, h / 2 + 0.02, d, [0.85, 0.85, 0.82]);
      B(0, 1.45, d + 0.003, w, h / 2, 0.003, [0.78, 0.86, 0.9], G.gloss);
      break;
    case 'tallMirror':
      // Fitting mirror against a wall: wooden frame on two feet, the glass facing +z.
      B(0, h / 2 + 0.06, 0, w + 0.04, h / 2 + 0.04, d * 0.5, c);
      B(0, h / 2 + 0.06, d * 0.5 + 0.004, w, h / 2, 0.004, [0.8, 0.87, 0.92], G.gloss);
      for (const sx of [-1, 1]) B(sx * (w - 0.04), 0.03, 0.1, 0.035, 0.03, 0.12, dark);
      break;
    case 'toilet':
      Cy(0, 0, 0.08, 0.38, 0.16, 0.19, c, 14, G.gloss);
      Cy(0, 0.38, 0.08, 0.41, 0.2, 0.2, [0.97, 0.97, 0.97], 14, G.gloss);
      B(0, 0.6, -0.24, 0.19, 0.22, 0.08, c, G.gloss);
      break;
    case 'bathtub':
      B(0, h / 2, 0, w, h / 2, d, c, G.gloss);
      B(0, h - 0.015, 0, w - 0.07, 0.016, d - 0.07, [0.68, 0.8, 0.86], G.gloss);
      Cy(-w + 0.12, h, 0, h + 0.18, 0.012, 0.012, [0.75, 0.76, 0.78], 6, G.gloss);
      break;
    case 'sink':
      B(0, 0.38, 0, w, 0.38, d, [0.82, 0.8, 0.76]);
      B(0, 0.8, 0.02, w + 0.02, 0.05, d + 0.02, c, G.gloss);
      B(0, 0.84, 0.04, w - 0.08, 0.01, d - 0.12, [0.7, 0.78, 0.84], G.gloss);
      Cy(0, 0.85, -d + 0.08, 1.0, 0.012, 0.012, [0.75, 0.76, 0.78], 6, G.gloss);
      break;
    case 'pew':
      B(0, 0.45, 0, w, 0.03, d * 0.6); B(0, 0.7, -d * 0.5, w, 0.25, 0.03); B(-w, 0.45, 0, 0.03, 0.45, d * 0.6); B(w, 0.45, 0, 0.03, 0.45, d * 0.6);
      break;
    case 'palletRack':
      for (let k = 0; k < 3; k++) B(0, 0.1 + k * (h / 3), 0, w, 0.05, d, [0.8, 0.45, 0.1]);
      for (const a of [-1, 1]) for (const b of [-1, 1]) B(a * w, h / 2, b * d, 0.04, h / 2, 0.04, [0.2, 0.3, 0.6]);
      for (let k = 0; k < 3; k++) if (rnd() < 0.85) B((rnd() - 0.5) * 0.2, 0.4 + k * (h / 3), 0, w * (0.6 + rnd() * 0.3), 0.3, d * 0.85, [0.6 + rnd() * 0.1, 0.5 + rnd() * 0.08, 0.35 + rnd() * 0.08]);
      break;
    case 'clothesStack': {
      let k = 0;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j += 2) {
        const n = 2 + Math.floor(rnd() * 3);
        for (let q = 0; q < n; q++) {
          const t = 0.75 + 0.25 * rnd();
          B(i * w * 0.6, h + 0.025 + q * 0.05, j * d * 0.45, 0.16, 0.022, 0.12, [c[0] * t, c[1] * t, c[2] * t]);
        }
        k++;
      }
      break;
    }
    case 'cooler':
      B(0, 0.5, 0, w, 0.5, d, c, G.gloss);
      Cy(0, 1.0, 0, 1.38, 0.13, 0.13, [0.55, 0.75, 0.95], 12, G.gloss);
      break;
    case 'coatRack':
      Cy(0, 0, 0, 0.03, 0.18, 0.18, c, 10);
      Cy(0, 0.03, 0, h, 0.02, 0.02, c, 6);
      for (let k = 0; k < 4; k++) { const a = k * 1.57; B(Math.cos(a) * 0.08, h - 0.1, Math.sin(a) * 0.08, 0.06, 0.01, 0.01, c); }
      if (rnd() < 0.7) B(0.1, h - 0.5, 0, 0.12, 0.38, 0.1, [0.25 + rnd() * 0.4, 0.2 + rnd() * 0.3, 0.2 + rnd() * 0.3]);
      break;
    case 'mailboxes':
      B(0, h / 2 + 0.9, 0, w, h / 2, d, [0.62, 0.63, 0.6], G.gloss);
      for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) B(-w + (i + 0.5) * (w * 2 / 6), 0.9 + (j + 0.5) * (h / 3), d + 0.004, w / 6 - 0.015, h / 6 - 0.015, 0.004, [0.5, 0.5, 0.48]);
      break;
    case 'column':
      B(0, h / 2, 0, w / 2, h / 2, d / 2, c);
      break;
    default:
      B(0, h / 2, 0, w, h / 2, d, c);
  }
}

/** Collision segments of interior walls (door gaps excluded): [ax, az, bx, bz] per segment. */
export function wallCollisionSegments(plan: FloorPlan): number[] {
  const out: number[] = [];
  for (const w of plan.walls) {
    const doors = w.doors.slice().sort((a, b) => a[0] - b[0]);
    let t = 0;
    const push = (t0: number, t1: number) => {
      if (t1 - t0 < 1e-3) return;
      out.push(w.ax + (w.bx - w.ax) * t0, w.az + (w.bz - w.az) * t0, w.ax + (w.bx - w.ax) * t1, w.az + (w.bz - w.az) * t1);
    };
    for (const [d0, d1] of doors) { push(t, d0); t = d1; }
    push(t, 1);
  }
  return out;
}

/** Things one cannot walk through (rugs, pictures, chairs, lamps and small things excepted). */
const PASS = new Set(['rug', 'painting', 'mirror', 'chair', 'officeChair', 'monitor', 'tv', 'screen', 'clothesStack', 'floorLamp', 'coatRack', 'pendant', 'curtain']);

/**
 * Collision outlines of the solid furniture: per piece its footprint's four edges and its height
 * ([ax, az, bx, bz, top] per edge, top above the floor). Low things (under a step) are left out.
 */
export function furnitureCollision(plan: FloorPlan): number[] {
  const out: number[] = [];
  for (const f of plan.furniture) {
    if (PASS.has(f.kind) || f.h < 0.3) continue;
    const c = Math.cos(f.yaw), s = Math.sin(f.yaw), w = f.w / 2, d = f.d / 2;
    const P = (lx: number, lz: number) => [f.x + lx * c + lz * s, f.z - lx * s + lz * c];
    const q = [P(-w, -d), P(w, -d), P(w, d), P(-w, d)];
    const top = f.kind === 'kitchenRow' ? 0.95 : f.kind === 'tv' ? 0.5 : f.h;
    for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; out.push(a[0], a[1], b[0], b[1], top); }
  }
  return out;
}
