/**
 * Meshes for a generated storey: floor finishes, ceiling, interior walls
 * with door openings, stairs, furniture and ceiling light panels.
 */
import * as THREE from 'three';
import earcut from 'earcut';
import type { FloorPlan, Furn, IWall, Room } from './InteriorGen';
import { difference } from '../core/clip';

const WALL_T = 0.12;
const DOOR_H = 2.15;

/** Procedural canvas textures for interior floors. */
function canvasTex(draw: (g: CanvasRenderingContext2D, s: number) => void, size = 256): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

let mats: Record<string, THREE.Material> | null = null;
export function interiorMaterials(): Record<string, THREE.Material> {
  if (mats) return mats;
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);
  const wood = canvasTex((g, s) => {
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
  });
  const tile = canvasTex((g, s) => {
    g.fillStyle = '#b8b8b2'; g.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 32) for (let x = 0; x < s; x += 32) { const v = rnd(0.92, 1.05); g.fillStyle = `rgb(${225 * v | 0},${224 * v | 0},${218 * v | 0})`; g.fillRect(x + 1, y + 1, 30, 30); }
  });
  const carpet = canvasTex((g, s) => {
    g.fillStyle = '#5a5f68'; g.fillRect(0, 0, s, s);
    for (let k = 0; k < 6000; k++) { g.fillStyle = `rgba(${rnd(60, 110) | 0},${rnd(65, 110) | 0},${rnd(75, 120) | 0},0.5)`; g.fillRect(rnd(0, s), rnd(0, s), 1.5, 1.5); }
  });
  const concrete = canvasTex((g, s) => {
    g.fillStyle = '#9c9a95'; g.fillRect(0, 0, s, s);
    for (let k = 0; k < 4000; k++) { g.fillStyle = `rgba(${rnd(120, 170) | 0},${rnd(120, 168) | 0},${rnd(115, 160) | 0},0.4)`; g.fillRect(rnd(0, s), rnd(0, s), 2, 2); }
  });
  const marble = canvasTex((g, s) => {
    g.fillStyle = '#e8e4dc'; g.fillRect(0, 0, s, s);
    for (let k = 0; k < 40; k++) { g.strokeStyle = `rgba(120,115,110,${rnd(0.05, 0.25)})`; g.lineWidth = rnd(0.5, 2); g.beginPath(); g.moveTo(rnd(0, s), 0); g.bezierCurveTo(rnd(0, s), rnd(0, s), rnd(0, s), rnd(0, s), rnd(0, s), s); g.stroke(); }
    g.strokeStyle = 'rgba(90,85,80,0.4)'; g.strokeRect(0, 0, s, s);
  });
  const stone = canvasTex((g, s) => {
    for (let y = 0; y < s; y += 64) for (let x = 0; x < s; x += 64) { const v = rnd(0.85, 1.05); g.fillStyle = `rgb(${190 * v | 0},${180 * v | 0},${165 * v | 0})`; g.fillRect(x + 1, y + 1, 62, 62); }
  });
  const m = (map: THREE.Texture, rough: number) => new THREE.MeshStandardMaterial({ map, roughness: rough, metalness: 0 });
  mats = {
    wood: m(wood, 0.55), tile: m(tile, 0.35), carpet: m(carpet, 0.95), concrete: m(concrete, 0.9), marble: m(marble, 0.2), stone: m(stone, 0.7),
    wall: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }),
    furn: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }),
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
  for (const [k, mat] of Object.entries(interiorMaterials())) {
    const geo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    if (k === 'wall' || k === 'furn') geo.setAttribute('color', new THREE.Float32BufferAttribute(new Array(geo.getAttribute('position').count * 3).fill(1), 3));
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

const TILE_M: Record<string, number> = { wood: 2.4, tile: 2.4, carpet: 3, concrete: 4, marble: 1.2, stone: 2.4 };

class Geo {
  pos: number[] = []; nrm: number[] = []; uv: number[] = []; col: number[] = []; idx: number[] = [];
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, w: number, c: [number, number, number]): number {
    this.pos.push(x, y, z); this.nrm.push(nx, ny, nz); this.uv.push(u, w); this.col.push(c[0], c[1], c[2]);
    return this.pos.length / 3 - 1;
  }
  quad(a: number, b: number, c: number, d: number): void { this.idx.push(a, b, c, a, c, d); }
  box(x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw: number, c: [number, number, number]): void {
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
      for (const cc of corners) { const p = P(cc[0], cc[1], cc[2]); this.v(p[0], p[1], p[2], wn[0], wn[1], wn[2], 0, 0, c); }
      this.quad(i0, i0 + 1, i0 + 2, i0 + 3);
    }
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
function flat(geo: Geo, poly: number[], holes: number[][], y: number, up: boolean, tile: number, c: [number, number, number]): void {
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

export function buildFloorMeshes(plan: FloorPlan, floorPoly: number[], stairHole: number[] | null, ceilingHole: number[] | null): THREE.Group {
  const M = interiorMaterials();
  const group = new THREE.Group();
  const y = plan.y;
  // Floor finishes per room material.
  const byMat = new Map<string, Geo>();
  for (const room of plan.rooms) {
    let g = byMat.get(room.floorMat);
    if (!g) byMat.set(room.floorMat, (g = new Geo()));
    let polys: { outer: number[]; holes: number[][] }[] = [{ outer: room.poly, holes: [] }];
    if (stairHole) polys = difference([room.poly], [stairHole]);
    for (const p of polys) flat(g, p.outer, p.holes, y + 0.035, true, TILE_M[room.floorMat] ?? 2, [1, 1, 1]);
  }
  for (const [m, g] of byMat) {
    const geo = g.build();
    if (geo) { const mesh = new THREE.Mesh(geo, M[m]); mesh.receiveShadow = true; group.add(mesh); }
  }
  // Structural floor under the finishes and the ceiling (with stair openings).
  const sg = new Geo();
  const fp = stairHole ? difference([floorPoly], [stairHole]) : [{ outer: floorPoly, holes: [] }];
  for (const p of fp) flat(sg, p.outer, p.holes, y + 0.02, true, 4, [0.6, 0.6, 0.58]);
  const cp = ceilingHole ? difference([floorPoly], [ceilingHole]) : [{ outer: floorPoly, holes: [] }];
  for (const p of cp) flat(sg, p.outer, p.holes, y + plan.height - 0.03, false, 4, [0.93, 0.93, 0.91]);
  // Interior walls (with door gaps) — split into segments and a header over each door.
  for (const w of plan.walls) wallSegments(sg, w, y, plan.height, wallColor(plan.rooms));
  // Stairs.
  if (plan.stair) {
    const s = plan.stair;
    const steps = Math.max(8, Math.round(plan.height / 0.18));
    const rise = plan.height / steps, tread = s.run / steps;
    const nx = -s.dz, nz = s.dx;
    for (let k = 0; k < steps; k++) {
      const cx = s.x + s.dx * (tread * (k + 0.5)) + nx * 0, cz = s.z + s.dz * (tread * (k + 0.5));
      const yaw = Math.atan2(s.dx, s.dz);
      sg.box(cx, y + rise * (k + 0.5), cz, s.width / 2, rise * (k + 1) / 2, tread / 2, yaw, [0.7, 0.68, 0.64]);
      // (box spans from floor up to the step top)
      void nx; void nz;
    }
    // Handrail
    const yaw = Math.atan2(s.dx, s.dz);
    const ex = s.x + s.dx * s.run, ez = s.z + s.dz * s.run;
    const hx = -s.dz * (s.width / 2), hz = s.dx * (s.width / 2);
    const mx = (s.x + ex) / 2 + hx, mz = (s.z + ez) / 2 + hz;
    const len = Math.hypot(s.run, plan.height);
    const pitch = Math.atan2(plan.height, s.run);
    const g = new THREE.BoxGeometry(0.05, 0.05, len);
    const rail = new THREE.Mesh(g, interiorMaterials().rail);
    rail.position.set(mx, y + plan.height / 2 + 0.9, mz);
    rail.rotation.set(-pitch, yaw, 0, 'YXZ');
    group.add(rail);
  }
  const sgeo = sg.build();
  if (sgeo) { const mesh = new THREE.Mesh(sgeo, M.wall); mesh.receiveShadow = true; mesh.castShadow = true; group.add(mesh); }
  // Furniture.
  const fg = new Geo();
  for (const f of plan.furniture) buildFurniture(fg, f, y + 0.035);
  const fgeo = fg.build();
  if (fgeo) { const mesh = new THREE.Mesh(fgeo, M.furn); mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); }
  // Ceiling light panels.
  const lg = new Geo();
  for (let i = 0; i < plan.lights.length; i += 2) lg.box(plan.lights[i], y + plan.height - 0.06, plan.lights[i + 1], 0.3, 0.02, 0.3, 0, [1, 1, 1]);
  const lgeo = lg.build();
  if (lgeo) group.add(new THREE.Mesh(lgeo, M.light));
  return group;
}

function wallColor(rooms: Room[]): [number, number, number] {
  return rooms.find((r) => r.type !== 'stairs' && r.type !== 'corridor')?.wallColor ?? [0.9, 0.89, 0.86];
}

function wallSegments(g: Geo, w: IWall, y: number, h: number, c: [number, number, number]): void {
  const L = Math.hypot(w.bx - w.ax, w.bz - w.az);
  if (L < 0.2) return;
  const dx = (w.bx - w.ax) / L, dz = (w.bz - w.az) / L;
  const yaw = Math.atan2(dx, dz);
  const doors = w.doors.slice().sort((a, b) => a[0] - b[0]);
  let t = 0;
  const seg = (t0: number, t1: number, y0: number, y1: number) => {
    if (t1 - t0 < 1e-3) return;
    const s0 = t0 * L, s1 = t1 * L;
    const mx = w.ax + dx * (s0 + s1) / 2, mz = w.az + dz * (s0 + s1) / 2;
    g.box(mx, (y0 + y1) / 2, mz, WALL_T / 2, (y1 - y0) / 2, (s1 - s0) / 2, yaw, c);
  };
  for (const [d0, d1] of doors) {
    seg(t, d0, y, y + h);
    seg(d0, d1, y + DOOR_H, y + h);
    t = d1;
  }
  seg(t, 1, y, y + h);
}

function buildFurniture(g: Geo, f: Furn, y: number): void {
  const c = f.color;
  const yaw = f.yaw;
  const B = (lx: number, ly: number, lz: number, hx: number, hy: number, hz: number, col: [number, number, number] = c) => {
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    g.box(f.x + lx * cs + lz * sn, y + ly, f.z - lx * sn + lz * cs, hx, hy, hz, yaw, col);
  };
  const w = f.w / 2, d = f.d / 2, h = f.h;
  const dark: [number, number, number] = [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6];
  switch (f.kind) {
    case 'bed': case 'bedDouble':
      B(0, 0.15, 0, w, 0.15, d, [0.35, 0.25, 0.18]);
      B(0, 0.38, 0.05, w - 0.03, 0.1, d - 0.08, [0.93, 0.93, 0.92]);
      B(0, 0.45, 0.25, w - 0.05, 0.05, d * 0.7, c);
      B(0, 0.55, -d + 0.2, w * 0.7, 0.07, 0.15, [0.95, 0.95, 0.95]);
      B(0, 0.6, -d + 0.03, w, 0.6, 0.04, [0.35, 0.25, 0.18]);
      break;
    case 'sofa':
      B(0, 0.22, 0, w, 0.22, d, c);
      B(0, 0.45, 0.05, w - 0.15, 0.08, d - 0.1, [c[0] * 1.1, c[1] * 1.1, c[2] * 1.1]);
      B(0, 0.6, -d + 0.12, w, 0.3, 0.12, c);
      B(-w + 0.1, 0.42, 0, 0.1, 0.2, d, c); B(w - 0.1, 0.42, 0, 0.1, 0.2, d, c);
      break;
    case 'armchair':
      B(0, 0.22, 0, w, 0.22, d, c); B(0, 0.6, -d + 0.1, w, 0.3, 0.1, c);
      B(-w + 0.08, 0.4, 0, 0.08, 0.18, d, c); B(w - 0.08, 0.4, 0, 0.08, 0.18, d, c);
      break;
    case 'chair':
      B(0, 0.45, 0, w, 0.03, d); B(0, 0.7, -d + 0.03, w, 0.22, 0.03);
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) B(a * (w - 0.03), 0.22, b * (d - 0.03), 0.02, 0.22, 0.02, dark);
      break;
    case 'officeChair':
      B(0, 0.48, 0, w * 0.8, 0.05, d * 0.8); B(0, 0.8, -d * 0.6, w * 0.75, 0.28, 0.05); B(0, 0.25, 0, 0.04, 0.22, 0.04, [0.3, 0.3, 0.3]);
      B(0, 0.04, 0, w * 0.8, 0.02, 0.05, [0.2, 0.2, 0.2]); B(0, 0.04, 0, 0.05, 0.02, d * 0.8, [0.2, 0.2, 0.2]);
      break;
    case 'diningTable': case 'coffeeTable': case 'desk': case 'meetingTable': case 'cafeTable':
      B(0, h - 0.025, 0, w, 0.025, d);
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) B(a * (w - 0.05), (h - 0.05) / 2, b * (d - 0.05), 0.025, (h - 0.05) / 2, 0.025, dark);
      break;
    case 'wardrobe': case 'bookshelf': case 'shelf': case 'shopShelf':
      B(0, h / 2, 0, w, h / 2, d, c);
      if (f.kind === 'bookshelf' || f.kind === 'shopShelf') {
        for (let k = 1; k < 5; k++) {
          const yy = (h * k) / 5;
          B(0, yy, 0.02, w - 0.03, 0.012, d - 0.02, [c[0] * 0.8, c[1] * 0.8, c[2] * 0.8]);
          for (let i = 0; i < 6; i++) B(-w + 0.15 + i * (w * 2 - 0.3) / 6, yy + 0.1, d * 0.3, 0.05, 0.09, d * 0.5, [0.3 + Math.random() * 0.6, 0.2 + Math.random() * 0.5, 0.2 + Math.random() * 0.5]);
        }
      } else B(0, h / 2, d + 0.005, 0.01, h / 2 - 0.05, 0.005, dark);
      break;
    case 'kitchenRow':
      B(0, h / 2, 0, w, h / 2, d, c);
      B(0, h + 0.02, 0, w, 0.02, d + 0.02, [0.2, 0.2, 0.22]);
      B(0, 1.9, -d + 0.18, w, 0.35, 0.18, c);
      break;
    case 'fridge': case 'tvStand': case 'nightstand': case 'counter': case 'reception': case 'barCounter': case 'altar': case 'crate':
      B(0, h / 2, 0, w, h / 2, d, c);
      if (f.kind === 'counter' || f.kind === 'barCounter' || f.kind === 'reception') B(0, h + 0.02, 0, w + 0.03, 0.02, d + 0.05, [0.15, 0.15, 0.16]);
      break;
    case 'tv':
      B(0, 0.5 + h / 2, 0, w, h / 2, d, [0.04, 0.04, 0.05]);
      break;
    case 'monitor':
      B(0, 0.74 + 0.25, 0, w / 2 * 0 + 0.28, 0.17, 0.02, [0.06, 0.06, 0.07]);
      B(0, 0.74 + 0.04, 0, 0.1, 0.04, 0.06, [0.2, 0.2, 0.2]);
      break;
    case 'rug':
      B(0, 0.005, 0, w, 0.005, d, c);
      break;
    case 'plant':
      B(0, 0.2, 0, 0.18, 0.2, 0.18, [0.55, 0.35, 0.25]);
      for (let k = 0; k < 5; k++) B((Math.random() - 0.5) * 0.3, 0.5 + k * 0.18, (Math.random() - 0.5) * 0.3, 0.2, 0.12, 0.2, [0.15 + Math.random() * 0.1, 0.4 + Math.random() * 0.15, 0.15]);
      break;
    case 'floorLamp':
      B(0, 0.02, 0, 0.15, 0.02, 0.15, [0.2, 0.2, 0.2]); B(0, 0.8, 0, 0.015, 0.78, 0.015, [0.2, 0.2, 0.2]); B(0, 1.55, 0, 0.18, 0.12, 0.18, [1, 0.95, 0.8]);
      break;
    case 'painting':
      B(0, 1.5, 0, w, h / 2, d, [0.25, 0.18, 0.1]); B(0, 1.5, 0.02, w - 0.05, h / 2 - 0.05, 0.005, c);
      break;
    case 'toilet':
      B(0, 0.2, 0.05, 0.18, 0.2, 0.25, c); B(0, 0.45, -0.25, 0.2, 0.25, 0.08, c);
      break;
    case 'bathtub':
      B(0, h / 2, 0, w, h / 2, d, c); B(0, h - 0.02, 0, w - 0.08, 0.02, d - 0.08, [0.75, 0.82, 0.86]);
      break;
    case 'sink':
      B(0, 0.42, 0, w, 0.42, d, [0.85, 0.85, 0.85]); B(0, 1.4, -d + 0.02, w * 0.8, 0.3, 0.01, [0.75, 0.8, 0.85]);
      break;
    case 'pew':
      B(0, 0.45, 0, w, 0.03, d * 0.6); B(0, 0.7, -d * 0.5, w, 0.25, 0.03); B(-w, 0.45, 0, 0.03, 0.45, d * 0.6); B(w, 0.45, 0, 0.03, 0.45, d * 0.6);
      break;
    case 'palletRack':
      for (let k = 0; k < 3; k++) B(0, 0.1 + k * (h / 3), 0, w, 0.05, d, [0.8, 0.45, 0.1]);
      for (const a of [-1, 1]) for (const b of [-1, 1]) B(a * w, h / 2, b * d, 0.04, h / 2, 0.04, [0.2, 0.3, 0.6]);
      for (let k = 0; k < 3; k++) B(0, 0.4 + k * (h / 3), 0, w * 0.9, 0.3, d * 0.85, [0.65, 0.55, 0.4]);
      break;
    case 'clothesStack': {
      // Folded garments in short stacks on a table top (h = table height).
      let k = 0;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j += 2) {
        const n = 2 + ((k * 7 + Math.floor(f.x * 3)) % 3);
        for (let q = 0; q < n; q++) {
          const t = 0.75 + 0.25 * (((k + q) * 37) % 10) / 10;
          B(i * w * 0.6, h + 0.025 + q * 0.05, j * d * 0.45, 0.16, 0.022, 0.12, [c[0] * t, c[1] * t, c[2] * t]);
        }
        k++;
      }
      break;
    }
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
