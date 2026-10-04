/**
 * Meshes of the side rooms, the crawl passages and the hidden chambers (built lazily near the
 * player by Underground). Everything is lit by emissive fixtures only (the scene's light count
 * never changes) and drawn with a handful of shared materials: the facade atlas material
 * (aLayer / aTint, as the tunnels), the emissive fixture material, an unlit glow material and a
 * decal material on the room atlas, the sewer water, and an additive veil (falling water, light
 * shafts).
 */
import * as THREE from 'three';
import { MeshBuilder } from '../build/meshBuilder';
import { facadeSpecs } from '../build/buildingShell';
import { toGeometry } from '../stream/CityStreamer';
import { Rng } from '../core/rng';
import type { Obstacle } from '../world/Collision';
import { type Room, type Colony, GHOST_PLATFORM, CRAWL_HW, CRAWL_H } from './rooms';
import { CELL, fw, fbox, cyl, dome, wallDecal, floorDecal, cellQuad, wall, flat, type Frame } from './roomArt';
import { pointOnTube } from './layout';

export interface RoomMats {
  lit: THREE.Material;
  light: THREE.Material;
  glow: THREE.Material;
  decal: THREE.Material;
  water: THREE.Material;
  veil: THREE.Material;
}

export type EmitterId = 'under_drip' | 'under_falls' | 'under_hum' | 'under_fan';
export interface Emitter { id: EmitterId; x: number; y: number; z: number }

export interface BuiltRoom {
  obj: THREE.Group;
  obstacles: Obstacle[];
  emitters: Emitter[];
  /** Per-frame animation (fan blades, falling water, daylight in a shaft): time, daylight 0..1. */
  tick: ((t: number, day: number) => void) | null;
  /** Trace rooms: where a lone one may sit (x, y, z) and the crack it slips into. */
  scout: { x: number; y: number; z: number; hx: number; hz: number } | null;
}

const SEWER_WALL: [number, number, number] = [0.75, 0.68, 0.6];
const METRO_WALL: [number, number, number] = [0.74, 0.74, 0.71];

/** Accumulates one room's geometry per material, in its frame. */
class Kit {
  lit = new MeshBuilder(facadeSpecs());
  glow = new MeshBuilder([{ name: 'uv', size: 2 }, { name: 'color', size: 3, type: 'u8n' }]);
  dec = new MeshBuilder([{ name: 'uv', size: 2 }]);
  light = new MeshBuilder([]);
  water = new MeshBuilder([{ name: 'uv', size: 2 }]);
  obstacles: Obstacle[] = [];
  emitters: Emitter[] = [];
  constructor(public f: Frame, public rng: Rng) {
    this.lit.set('aFacade', 1, 1, 1, 0).set('aSeed', 0.4).set('aElem', 0);
  }
  m(layer: number, r: number, g: number, b: number): MeshBuilder {
    return this.lit.set('aLayer', layer).set('aTint', r, g, b);
  }
  P(u: number, v: number, y: number): [number, number, number] {
    const [x, z] = fw(this.f, u, v);
    return [x, y, z];
  }
  /** A solid box (obstacle) in the frame. */
  solid(u: number, v: number, y0: number, y1: number, hu: number, hv: number): void {
    const [x, z] = fw(this.f, u, v);
    this.obstacles.push({ cyl: false, x, z, r: 0, hx: hu, hz: hv, ux: this.f.nx, uz: this.f.nz, y0, y1 });
  }
  solidCyl(u: number, v: number, y0: number, y1: number, r: number): void {
    const [x, z] = fw(this.f, u, v);
    this.obstacles.push({ cyl: true, x, z, r, hx: 0, hz: 0, ux: 1, uz: 0, y0, y1 });
  }
  cylF(u0: number, v0: number, y0: number, u1: number, v1: number, y1: number, r: number, n = 8): void {
    const a = this.P(u0, v0, y0), b = this.P(u1, v1, y1);
    cyl(this.lit, a[0], a[1], a[2], b[0], b[1], b[2], r, n);
  }
  emit(id: EmitterId, u: number, v: number, y: number): void {
    const [x, z] = fw(this.f, u, v);
    this.emitters.push({ id, x, y, z });
  }
  build(mats: RoomMats): THREE.Group {
    const g = new THREE.Group();
    const add = (mb: MeshBuilder, mat: THREE.Material, shadow = false) => {
      if (mb.empty) return null;
      const m = new THREE.Mesh(toGeometry(mb.build()), mat);
      m.receiveShadow = shadow;
      g.add(m);
      return m;
    };
    add(this.lit, mats.lit, true);
    add(this.light, mats.light);
    add(this.glow, mats.glow);
    const d = add(this.dec, mats.decal);
    if (d) d.renderOrder = 1;
    add(this.water, mats.water);
    return g;
  }
}

/** Glow geometry uses the atlas' white cell: a box's uvs are pinned to it. */
function whiteBox(k: Kit, u: number, v: number, y: number, hu: number, hy: number, hv: number, c: [number, number, number]): void {
  k.glow.set('color', ...c);
  const n0 = k.glow.vcount;
  fbox(k.glow, k.f, u, v, y, hu, hy, hv);
  pinUV(k.glow, n0);
}

/** Pin the uvs of vertices from n0 on to the middle of the white cell. */
function pinUV(mb: MeshBuilder, n0: number): void {
  const uv = (mb as unknown as { data: Record<string, { arr: Float32Array }> }).data.uv.arr;
  for (let i = n0; i < mb.vcount; i++) { uv[i * 2] = 1 / 16; uv[i * 2 + 1] = 1 - 1 / 8; }
}

function lamp(k: Kit, u: number, v: number, y: number, ceiling: boolean, long = false): void {
  if (ceiling) fbox(k.light, k.f, u, v, y - 0.04, long ? 0.6 : 0.18, 0.035, 0.1);
  else fbox(k.light, k.f, u, v, y, 0.06, 0.05, 0.16);
}

/** Exit sign (green running figure) on a wall facing (fu, fv). */
function exitSign(k: Kit, u: number, v: number, fu: number, fv: number, y: number): void {
  k.glow.set('color', 0.85, 0.95, 0.85);
  const [x, z] = fw(k.f, u + fu * 0.03, v + fv * 0.03);
  const fx = k.f.nx * fu - k.f.nz * fv, fz = k.f.nz * fu + k.f.nx * fv;
  const rx = fz, rz = -fx, hw = 0.32, hh = 0.16;
  cellQuad(k.glow, [x - rx * hw, y - hh, z - rz * hw], [x + rx * hw, y - hh, z + rz * hw], [x + rx * hw, y + hh, z + rz * hw], [x - rx * hw, y + hh, z - rz * hw], CELL.exit);
}

function crate(k: Kit, u: number, v: number, y: number, s: number, yaw: number, solid = true): void {
  k.m(12, 0.62 + k.rng.range(-0.08, 0.08), 0.5, 0.36);
  fbox(k.lit, k.f, u, v, y + s, s * k.rng.range(0.9, 1.3), s, s, yaw);
  if (solid) k.solid(u, v, y, y + s * 2, s * 1.2, s * 1.2);
}

/** Cable drum lying on its rim (axis along v). */
function drum(k: Kit, u: number, v: number, y: number, r: number, w: number): void {
  k.m(12, 0.55, 0.42, 0.3);
  k.cylF(u, v - w, y + r, u, v - w + 0.05, y + r, r, 12);
  k.cylF(u, v + w - 0.05, y + r, u, v + w, y + r, r, 12);
  k.m(11, 0.15, 0.15, 0.16);
  k.cylF(u, v - w + 0.05, y + r, u, v + w - 0.05, y + r, r * 0.72, 12);
  k.solid(u, v, y, y + r * 2, r, w);
}

function rubble(k: Kit, u: number, v: number, y: number, rad: number, n: number, layer = 1, tint: [number, number, number] = SEWER_WALL): void {
  for (let i = 0; i < n; i++) {
    const a = k.rng.range(0, Math.PI * 2), d = Math.sqrt(k.rng.float()) * rad;
    const s = k.rng.range(0.06, 0.2);
    const t = k.rng.range(0.7, 1.05);
    k.m(layer, tint[0] * t, tint[1] * t, tint[2] * t);
    fbox(k.lit, k.f, u + Math.cos(a) * d, v + Math.sin(a) * d, y + s * 0.6 + (1 - d / rad) * rad * 0.35 * k.rng.float(), s * 1.6, s * 0.7, s, k.rng.range(0, 3));
  }
}

function puddles(k: Kit, m: Room['main'], n: number): void {
  for (let i = 0; i < n; i++) {
    const u = k.rng.range(m.u0 + 0.6, m.u1 - 0.6), v = k.rng.range(m.v0 + 0.6, m.v1 - 0.6), s = k.rng.range(0.4, 1.1);
    floorDecal(k.dec, k.f, u, v, m.y0, s * 1.3, s, k.rng.range(0, 3), CELL.puddle);
  }
}

function streaks(k: Kit, m: Room['main'], n: number): void {
  for (let i = 0; i < n; i++) {
    const side = k.rng.int(0, 2);
    const h = m.h * k.rng.range(0.5, 0.85), y = m.y0 + m.h - h / 2 - 0.02;
    if (side === 0) wallDecal(k.dec, k.f, m.u1, k.rng.range(m.v0 + 0.8, m.v1 - 0.8), -1, 0, y, k.rng.range(0.5, 1.1), h / 2, CELL.streak);
    else { const sv = side === 1 ? 1 : -1; wallDecal(k.dec, k.f, k.rng.range(m.u0 + 0.6, m.u1 - 0.6), sv > 0 ? m.v1 : m.v0, 0, -sv, y, k.rng.range(0.5, 1.1), h / 2, CELL.streak); }
  }
}

function graffiti(k: Kit, m: Room['main'], n: number, y: number): void {
  for (let i = 0; i < n; i++) {
    const s = k.rng.range(0.6, 1.1), cell = CELL.graffiti + k.rng.int(0, 3);
    if (k.rng.chance(0.5) && m.v1 - m.v0 > 2.5) wallDecal(k.dec, k.f, m.u1, k.rng.range(m.v0 + s, m.v1 - s), -1, 0, y + k.rng.range(0.6, 1.4), s, s, cell);
    else { const sv = k.rng.sign(); if (m.u1 - m.u0 > 2.4) wallDecal(k.dec, k.f, k.rng.range(m.u0 + s, m.u1 - s), sv > 0 ? m.v1 : m.v0, 0, -sv, y + k.rng.range(0.6, 1.4), s, s, cell); }
  }
}

/** Shell of a side room: door passage(s) and the main room (walls with openings, floor, ceiling). */
function shell(k: Kit, r: Room, ceilHole: [number, number, number, number] | null): void {
  const m = r.main, sewer = r.net === 'sewer', ghost = r.kind === 'ghost';
  const wallT: [number, number, number] = ghost ? [0.86, 0.82, 0.68] : sewer ? SEWER_WALL : METRO_WALL;
  const wl = ghost ? 15 : sewer ? 1 : 8;
  const top = m.y0 + m.h;
  // Door passages: jambs, lintel and floor (they start a little inside the host's wall line).
  for (const d of r.doors) {
    k.m(wl, ...wallT);
    if (r.dl > 0) {
      wall(k.lit, k.f, -0.2, d.v0, r.dl, d.v0, r.y, r.y + d.top);
      wall(k.lit, k.f, -0.2, d.v1, r.dl, d.v1, r.y, r.y + d.top);
      flat(k.lit, k.f, -0.2, r.dl, d.v0, d.v1, r.y + d.top, false);
      k.m(8, 0.42, 0.4, 0.37);
      flat(k.lit, k.f, -0.05, r.dl, d.v0, d.v1, r.y + 0.004);
    }
  }
  k.m(wl, ...wallT);
  // Front wall with the doorways (the ghost platform's front is the tunnel wall itself).
  if (!ghost) {
    const holes = r.doors.map((d): [number, number, number, number] => [d.v0 - m.v0, d.v1 - m.v0, r.y - 0.01, r.y + d.top]);
    wall(k.lit, k.f, m.u0, m.v0, m.u0, m.v1, m.y0, top, holes);
  }
  const back: [number, number, number, number][] = r.gap ? [[r.gap.v - r.gap.hw - m.v0, r.gap.v + r.gap.hw - m.v0, m.y0 - 0.01, m.y0 + r.gap.h]] : [];
  wall(k.lit, k.f, m.u1, m.v0, m.u1, m.v1, m.y0, top, back);
  wall(k.lit, k.f, m.u0, m.v0, m.u1, m.v0, m.y0, top);
  wall(k.lit, k.f, m.u0, m.v1, m.u1, m.v1, m.y0, top);
  // Ceiling (around an opening: a shaft, a grate, a collapse).
  k.m(sewer ? 1 : 9, ...(sewer ? SEWER_WALL : [0.62, 0.62, 0.6] as [number, number, number]));
  if (ceilHole) {
    const [a0, a1, b0, b1] = ceilHole;
    flat(k.lit, k.f, m.u0, a0, m.v0, m.v1, top, false);
    flat(k.lit, k.f, a1, m.u1, m.v0, m.v1, top, false);
    flat(k.lit, k.f, a0, a1, m.v0, b0, top, false);
    flat(k.lit, k.f, a0, a1, b1, m.v1, top, false);
  } else flat(k.lit, k.f, m.u0, m.u1, m.v0, m.v1, top, false);
  k.m(ghost ? 13 : 8, ...(sewer ? [0.4, 0.38, 0.34] as [number, number, number] : [0.5, 0.5, 0.48] as [number, number, number]));
  flat(k.lit, k.f, ghost ? 0 : m.u0, m.u1, m.v0, m.v1, m.y0 + 0.002);
}

/** Build one side room. */
export function buildRoom(r: Room, mats: RoomMats, veilOut: (o: THREE.Object3D) => void = () => {}): BuiltRoom {
  const f: Frame = { ox: r.ox, oz: r.oz, nx: r.nx, nz: r.nz };
  const k = new Kit(f, new Rng(r.seed));
  const m = r.main, y = r.y, top = m.y0 + m.h, mu = (m.u0 + m.u1) / 2, mv = (m.v0 + m.v1) / 2;
  const sewer = r.net === 'sewer';
  let ceilHole: [number, number, number, number] | null = null;
  let tick: BuiltRoom['tick'] = null;
  const extra: THREE.Object3D[] = [];
  const wallT = sewer ? SEWER_WALL : METRO_WALL;
  // Metro rooms behind a door get the green running figure over it (on the tunnel side).
  if (!sewer && r.kind !== 'ghost' && r.kind !== 'niche') exitSign(k, -0.21, 0, -1, 0, y + r.doors[0].top + 0.3);
  switch (r.kind) {
    case 'alcove': {
      lamp(k, m.u1 - 0.07, mv, y + 1.9, false);
      crate(k, m.u1 - 0.5, m.v0 + 0.5, y, 0.3, k.rng.range(-0.3, 0.3));
      k.m(11, 0.4, 0.42, 0.45); k.cylF(m.u1 - 0.35, m.v1 - 0.4, y, m.u1 - 0.35, m.v1 - 0.4, y + 0.4, 0.17, 10);
      k.m(11, 0.3, 0.3, 0.32); k.cylF(m.u1 - 0.12, m.v0, y + 2.0, m.u1 - 0.12, m.v1, y + 2.0, 0.07);
      // A shovel leaning in the corner.
      k.m(12, 0.5, 0.4, 0.3); k.cylF(m.u1 - 0.15, m.v1 - 0.15, y + 0.3, m.u1 - 0.5, m.v1 - 0.25, y + 1.4, 0.02, 5);
      k.m(11, 0.3, 0.3, 0.3); fbox(k.lit, f, m.u1 - 0.12, m.v1 - 0.13, y + 0.16, 0.03, 0.16, 0.11, 0.3);
      puddles(k, m, 1);
      k.emit('under_drip', mu, mv, y + 2);
      break;
    }
    case 'overflow': {
      // A basin under a street grate: water falls through it, over a weir into the sewer.
      const gu = mu + 0.6, gv = mv + k.rng.range(-1, 1);
      ceilHole = [gu - 0.55, gu + 0.55, gv - 0.4, gv + 0.4];
      k.m(8, 0.5, 0.5, 0.48);
      // Basin rim (low walls) around the fall.
      const bu0 = gu - 1.3, bu1 = gu + 1.3, bv0 = gv - 1.2, bv1 = gv + 1.2;
      fbox(k.lit, f, bu0, gv, y + 0.3, 0.12, 0.3, 1.32);
      fbox(k.lit, f, bu1, gv, y + 0.3, 0.12, 0.3, 1.32);
      fbox(k.lit, f, gu, bv0, y + 0.3, 1.18, 0.3, 0.12);
      fbox(k.lit, f, gu, bv1, y + 0.3, 1.18, 0.3, 0.12);
      k.solid(gu, gv, y, y + 0.6, 1.42, 1.32);
      floorDecal(k.water, f, gu, gv, y + 0.45, 1.2, 1.1, 0, CELL.white);
      // The grate and the shaft above it (a glimmer of street light).
      k.m(11, 0.2, 0.2, 0.2);
      for (let i = -3; i <= 3; i++) fbox(k.lit, f, gu + i * 0.15, gv, top - 0.03, 0.02, 0.03, 0.4);
      k.m(8, 0.45, 0.45, 0.43);
      wall(k.lit, f, gu - 0.55, gv - 0.4, gu + 0.55, gv - 0.4, top, top + 0.7);
      wall(k.lit, f, gu - 0.55, gv + 0.4, gu + 0.55, gv + 0.4, top, top + 0.7);
      wall(k.lit, f, gu - 0.55, gv - 0.4, gu - 0.55, gv + 0.4, top, top + 0.7);
      wall(k.lit, f, gu + 0.55, gv - 0.4, gu + 0.55, gv + 0.4, top, top + 0.7);
      k.glow.set('color', 0.35, 0.38, 0.42);
      const n0 = k.glow.vcount;
      flat(k.glow, f, gu - 0.55, gu + 0.55, gv - 0.4, gv + 0.4, top + 0.65, false);
      pinUV(k.glow, n0);
      // Falling water: a few thin sheets (animated), a splash ring.
      const veil = new MeshBuilder([{ name: 'color', size: 3, type: 'u8n' }]);
      for (let i = 0; i < 16; i++) {
        // Thin streams of different brightness (streaky, not a sheet).
        const du = k.rng.range(-0.3, 0.3), dv = k.rng.range(-0.3, 0.3), w = k.rng.range(0.015, 0.045), c = k.rng.range(0.03, 0.09);
        veil.set('color', c, c * 1.05, c * 1.1);
        const A = k.P(gu + du, gv + dv - w, top), B = k.P(gu + du, gv + dv + w, top);
        const i0 = veil.v(A[0], y + 0.45, A[2], 1, 0, 0), i1 = veil.v(B[0], y + 0.45, B[2], 1, 0, 0);
        veil.v(B[0], top, B[2], 1, 0, 0); veil.v(A[0], top, A[2], 1, 0, 0);
        veil.quad(i0, i1, i1 + 1, i0 + 3);
      }
      const vm = new THREE.Mesh(toGeometry(veil.build()), mats.veil);
      vm.renderOrder = 3;
      extra.push(vm);
      tick = (t) => { vm.position.set(Math.sin(t * 31) * 0.01, Math.sin(t * 23) * 0.012, Math.cos(t * 27) * 0.01); };
      // The weir into the sewer: a lip at the door.
      k.m(8, 0.48, 0.46, 0.42); fbox(k.lit, f, r.dl - 0.1, 0, y + 0.05, 0.08, 0.05, 0.7);
      lamp(k, m.u0 + 0.07, m.v0 + 0.8, y + 2.2, false);
      puddles(k, m, 3);
      streaks(k, m, 3);
      k.emit('under_falls', gu, gv, y + 1);
      break;
    }
    case 'cistern': {
      // Landing and steps down to the old cistern floor; brick piers with arches; standing water.
      const drop = y - m.y0;
      k.m(8, 0.45, 0.43, 0.4);
      fbox(k.lit, f, m.u0 + 0.7, mv, (y + m.y0) / 2, 0.7, drop / 2, m.v1 - mv);
      for (let s = 1; s < 4; s++) fbox(k.lit, f, m.u0 + 1.4 + (s - 0.5) * 0.32, mv, m.y0 + (drop - drop * s / 4) / 2, 0.16, (drop - drop * s / 4) / 2, m.v1 - mv);
      const cols: [number, number][] = [];
      for (const fu of [0.45, 0.78]) for (const fv of [-0.5, 0, 0.5]) cols.push([m.u0 + (m.u1 - m.u0) * fu, mv + (m.v1 - m.v0) * fv * 0.8]);
      for (const [cu, cv] of cols) {
        k.m(1, 0.7, 0.6, 0.52); fbox(k.lit, f, cu, cv, m.y0 + m.h / 2, 0.32, m.h / 2, 0.32);
        k.solid(cu, cv, m.y0, top, 0.36, 0.36);
      }
      // Arches between the piers (along v), as thick ribs under the ceiling.
      k.m(1, 0.66, 0.57, 0.5);
      for (const fu of [0.45, 0.78]) {
        const cu = m.u0 + (m.u1 - m.u0) * fu;
        for (let s = -6; s <= 6; s++) {
          const vv = mv + (s / 6) * (m.v1 - m.v0) / 2, a = Math.abs(Math.sin((s / 6) * Math.PI * 1.25));
          fbox(k.lit, f, cu, vv, top - 0.18 - (1 - a) * 0.0 - a * 0.25, 0.3, 0.2 + a * 0.2, (m.v1 - m.v0) / 24 + 0.02);
        }
      }
      floorDecal(k.water, f, (m.u0 + 1.4 + 1.0 + m.u1) / 2, mv, m.y0 + 0.1, (m.u1 - m.u0 - 2.4) / 2, (m.v1 - m.v0) / 2 - 0.05, 0, CELL.white);
      lamp(k, m.u0 + 0.07, mv + 1.2, y + 1.9, false);
      streaks(k, m, 5);
      for (let i = 0; i < 3; i++) k.emit('under_drip', k.rng.range(m.u0 + 2, m.u1 - 1), k.rng.range(m.v0 + 1, m.v1 - 1), top - 0.2);
      break;
    }
    case 'pump': {
      // Pump set on a plinth, big pipes into the floor and across, a valve wheel, gauges.
      const pu = mu + 0.3, pv = mv - 0.6;
      k.m(8, 0.5, 0.5, 0.48); fbox(k.lit, f, pu, pv, y + 0.1, 0.9, 0.1, 1.3);
      k.m(11, 0.3, 0.42, 0.55); fbox(k.lit, f, pu, pv - 0.4, y + 0.6, 0.45, 0.4, 0.45);
      k.m(11, 0.32, 0.45, 0.6); k.cylF(pu, pv + 0.05, y + 0.65, pu, pv + 1.1, y + 0.65, 0.33, 12);
      k.solid(pu, pv, y, y + 1.1, 0.95, 1.35);
      k.m(11, 0.36, 0.33, 0.3);
      k.cylF(pu, pv - 0.85, y + 0.6, pu, m.v0, y + 0.6, 0.18, 10);
      k.cylF(m.u1 - 0.35, m.v0, y + 2.4, m.u1 - 0.35, m.v1, y + 2.4, 0.22, 10);
      k.cylF(m.u1 - 0.35, m.v1 - 0.5, y, m.u1 - 0.35, m.v1 - 0.5, y + 2.4, 0.2, 10);
      k.solid(m.u1 - 0.35, m.v1 - 0.5, y, y + 2.4, 0.24, 0.24);
      // Valve wheel on the riser: rim of short beams, spokes.
      const wu = m.u1 - 0.65, wv = m.v1 - 0.5, wy = y + 1.25, R = 0.32;
      k.m(11, 0.6, 0.12, 0.1);
      for (let i = 0; i < 14; i++) {
        const a0 = (i / 14) * Math.PI * 2, a1 = ((i + 1) / 14) * Math.PI * 2;
        k.cylF(wu, wv + Math.cos(a0) * R, wy + Math.sin(a0) * R, wu, wv + Math.cos(a1) * R, wy + Math.sin(a1) * R, 0.025, 5);
      }
      for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + 0.4; k.cylF(wu, wv, wy, wu, wv + Math.cos(a) * R, wy + Math.sin(a) * R, 0.015, 4); }
      k.m(11, 0.3, 0.3, 0.3); k.cylF(wu, wv, wy, wu + 0.35, wv, wy, 0.04, 6);
      // Control box with a gauge and a green lamp.
      k.m(11, 0.45, 0.47, 0.45); fbox(k.lit, f, m.u1 - 0.15, m.v0 + 0.8, y + 1.4, 0.12, 0.35, 0.3);
      whiteBox(k, m.u1 - 0.27, m.v0 + 0.7, y + 1.55, 0.01, 0.025, 0.025, [0.2, 0.95, 0.35]);
      whiteBox(k, m.u1 - 0.27, m.v0 + 0.9, y + 1.55, 0.01, 0.025, 0.025, [0.95, 0.6, 0.15]);
      lamp(k, mu, mv, top, true, true);
      puddles(k, m, 2);
      k.emit('under_hum', pu, pv, y + 0.8);
      break;
    }
    case 'collapsed': {
      // A side passage ending in a fall of bricks and earth; a broken ceiling, fallen timbers.
      const end = m.u1 - 0.2;
      if (r.gap) {
        // The fall opened a way: the heap lies against one side, the gap behind it on the other.
        const sv = k.rng.sign(), hv2 = 0.42, cu = end - 2.6, cv = mv + sv * (m.v1 - mv - hv2);
        rubble(k, cu, cv, y, 0.8, 40);
        k.m(13, 0.35, 0.29, 0.22); fbox(k.lit, f, cu, cv, y + 0.45, 0.7, 0.45, hv2);
        k.solid(cu, cv, y, y + 0.9, 0.8, hv2);
        rubble(k, end - 0.6, mv, y, 0.5, 10);
      } else {
        rubble(k, end - 1.0, mv, y, 1.6, 70);
        k.m(13, 0.35, 0.29, 0.22); fbox(k.lit, f, end - 0.5, mv, y + 0.5, 0.6, 0.55, m.v1 - mv);
        fbox(k.lit, f, end - 1.4, mv, y + 0.2, 0.6, 0.25, m.v1 - mv - 0.1, 0.1);
        k.solid(end - 0.9, mv, y, y + 1.0, 1.1, m.v1 - mv);
      }
      k.m(12, 0.32, 0.25, 0.18);
      k.cylF(end - 2.6, m.v0 + 0.1, y + 0.1, end - 0.6, m.v1 - 0.2, y + 1.6, 0.08, 6);
      k.cylF(end - 3.2, m.v1 - 0.1, top - 0.05, end - 1.5, m.v0 + 0.3, y + 0.9, 0.07, 6);
      ceilHole = [end - 2.2, end, m.v0, m.v1];
      k.m(3, 0.32, 0.25, 0.19);
      flat(k.lit, f, end - 2.2, end, m.v0, m.v1, top + 0.6, false);
      wall(k.lit, f, end - 2.2, m.v0, end - 2.2, m.v1, top, top + 0.6);
      wall(k.lit, f, end - 2.2, m.v0, end, m.v0, top, top + 0.6);
      wall(k.lit, f, end - 2.2, m.v1, end, m.v1, top, top + 0.6);
      wall(k.lit, f, end, m.v0, end, m.v1, top, top + 0.6);
      rubble(k, m.u0 + 2.5, mv, y, 0.7, 8);
      puddles(k, m, 1);
      k.emit('under_drip', end - 1.5, mv, top);
      break;
    }
    case 'bricked': {
      // The old arch filled with newer bricks, except for a gap; inside, forgotten things.
      const d = r.doors[0];
      k.m(0, 0.62, 0.42, 0.34);
      const fu = -0.05;
      wall(k.lit, f, fu, -1.3, fu, 1.3, y, y + 2.05, [[1.3 + d.v0, 1.3 + d.v1, y - 0.01, y + d.top]]);
      rubble(k, -0.5, 0.2, y, 0.5, 14, 0, [0.62, 0.42, 0.34]);
      for (let i = 0; i < 4; i++) { k.m(11, 0.15, 0.3, 0.18); k.cylF(m.u1 - 0.3 - i * 0.12, m.v0 + 0.4 + i * 0.1, y, m.u1 - 0.3 - i * 0.12, m.v0 + 0.4 + i * 0.1, y + 0.28, 0.035, 6); }
      crate(k, m.u1 - 0.5, m.v1 - 0.6, y, 0.32, 0.2);
      crate(k, m.u1 - 0.55, m.v1 - 0.65, y + 0.64, 0.25, -0.3, false);
      k.m(12, 0.42, 0.33, 0.24); fbox(k.lit, f, mu, m.v0 + 0.35, y + 0.45, 0.5, 0.03, 0.3);
      k.m(11, 0.2, 0.2, 0.2); for (const s of [-1, 1]) for (const t of [-1, 1]) fbox(k.lit, f, mu + s * 0.45, m.v0 + 0.35 + t * 0.25, y + 0.22, 0.02, 0.22, 0.02);
      puddles(k, m, 1);
      streaks(k, m, 3);
      k.emit('under_drip', mu, mv, top);
      break;
    }
    case 'niche': {
      lamp(k, m.u1 - 0.07, mv, y + 2.3, false);
      drum(k, mu + 0.1, m.v0 + 0.7, y, k.rng.range(0.45, 0.6), 0.35);
      // Tool rack on the back wall.
      k.m(11, 0.35, 0.36, 0.38); fbox(k.lit, f, m.u1 - 0.04, m.v1 - 0.8, y + 1.3, 0.03, 0.5, 0.6);
      k.m(12, 0.5, 0.38, 0.25);
      for (let i = 0; i < 5; i++) k.cylF(m.u1 - 0.1, m.v1 - 1.3 + i * 0.25, y + 0.5, m.u1 - 0.1, m.v1 - 1.3 + i * 0.25, y + 1.6, 0.02, 5);
      wallDecal(k.dec, f, m.u1, m.v1 - 0.8, -1, 0, y + 2.0, 0.6, 0.08, CELL.hazard);
      break;
    }
    case 'cross': {
      // A cross-passage ending in a shut steel door (another tunnel's?), with its sign.
      lamp(k, mu, mv, top, true);
      if (r.gap) {
        // The door was forced long ago: it leans in the passage, the hole behind it is dark.
        k.m(11, 0.45, 0.47, 0.45); fbox(k.lit, f, m.u1 - 1.0, m.v1 - 0.12, y + 1.0, 0.55, 1.0, 0.04, 0.25);
      } else {
        k.m(11, 0.5, 0.52, 0.5); fbox(k.lit, f, m.u1 - 0.06, mv, y + 1.05, 0.05, 1.05, 0.55);
        k.m(11, 0.7, 0.7, 0.68); fbox(k.lit, f, m.u1 - 0.14, mv, y + 1.0, 0.02, 0.03, 0.4);
      }
      exitSign(k, m.u1, mv, -1, 0, y + 2.3);
      k.m(11, 0.32, 0.32, 0.34); k.cylF(mu - 2, m.v0 + 0.1, top - 0.25, mu + 2.5, m.v0 + 0.1, top - 0.25, 0.05);
      break;
    }
    case 'staff': {
      // Door leaf standing open, table and chairs, lockers, a kettle, a calendar.
      k.m(11, 0.55, 0.58, 0.6);
      fbox(k.lit, f, r.dl * 0.5 + 0.1, r.doors[0].v1 - 0.05 + 0.45, y + 1.05, 0.02, 1.05, 0.48, 1.2);
      k.m(12, 0.6, 0.48, 0.32); fbox(k.lit, f, mu + 0.3, mv, y + 0.74, 0.5, 0.03, 0.8);
      k.m(11, 0.3, 0.3, 0.3); for (const s of [-1, 1]) for (const t of [-1, 1]) fbox(k.lit, f, mu + 0.3 + s * 0.42, mv + t * 0.7, y + 0.36, 0.02, 0.36, 0.02);
      k.solid(mu + 0.3, mv, y, y + 0.76, 0.55, 0.85);
      for (const [cu, cv, yaw] of [[mu - 0.5, mv - 0.3, 0.2], [mu + 1.1, mv + 0.4, 2.9]] as const) {
        k.m(11, 0.25, 0.35, 0.5); fbox(k.lit, f, cu, cv, y + 0.45, 0.22, 0.03, 0.22, yaw);
        fbox(k.lit, f, cu - Math.cos(yaw) * 0.2, cv - Math.sin(yaw) * 0.2, y + 0.75, 0.03, 0.3, 0.22, yaw);
      }
      k.m(11, 0.32, 0.45, 0.6);
      for (let i = 0; i < 3; i++) fbox(k.lit, f, m.u1 - 0.25, m.v0 + 0.35 + i * 0.52, y + 0.95, 0.24, 0.95, 0.25);
      k.solid(m.u1 - 0.25, m.v0 + 0.87, y, y + 1.9, 0.26, 0.8);
      k.m(11, 0.85, 0.85, 0.82); k.cylF(mu + 0.4, mv + 0.3, y + 0.77, mu + 0.4, mv + 0.3, y + 0.95, 0.07, 10);
      k.m(11, 0.9, 0.3, 0.2); k.cylF(mu + 0.1, mv - 0.4, y + 0.77, mu + 0.1, mv - 0.4, y + 0.86, 0.04, 8);
      wallDecal(k.dec, f, k.rng.range(m.u0 + 0.8, m.u1 - 0.8), m.v1, 0, -1, y + 1.5, 0.3, 0.38, CELL.poster);
      lamp(k, mu, mv, top, true, true);
      break;
    }
    case 'ghost': {
      // A closed-off platform: the old platform edge with its faded line, benches, old signs, litter.
      k.m(13, 0.62, 0.6, 0.55);
      const steps = r.doors[0].v0;
      fbox(k.lit, f, m.u1 / 2, (steps + 2.2 + m.v1) / 2, y + GHOST_PLATFORM / 2, m.u1 / 2, GHOST_PLATFORM / 2, (m.v1 - steps - 2.2) / 2);
      fbox(k.lit, f, (1.5 + m.u1) / 2, steps + 1.1, y + GHOST_PLATFORM / 2, (m.u1 - 1.5) / 2, GHOST_PLATFORM / 2, 1.1);
      for (let s = 0; s < 5; s++) fbox(k.lit, f, s * 0.3 + 0.15, steps + 1.1, y + GHOST_PLATFORM * (s + 1) / 12, 0.15, GHOST_PLATFORM * (s + 1) / 12, 1.1);
      k.glow.set('color', 0.28, 0.24, 0.08);
      const n0 = k.glow.vcount;
      flat(k.glow, f, 0.25, 0.37, steps + 2.2, m.v1, y + GHOST_PLATFORM + 0.006);
      pinUV(k.glow, n0);
      // Pillars between the openings stand in the tunnel wall: solid.
      for (let i = 0; i + 1 < r.doors.length; i++) {
        const a = r.doors[i].v1, b = r.doors[i + 1].v0;
        k.solid(-0.2, (a + b) / 2, y, y + 4, 0.25, (b - a) / 2);
      }
      k.solid(-0.2, m.v1 + 0.1, y, y + 4, 0.25, 0.1);
      for (const u0 of [-6, 2, 9]) {
        k.m(12, 0.4, 0.3, 0.22); fbox(k.lit, f, m.u1 - 0.5, u0, y + GHOST_PLATFORM + 0.45, 0.2, 0.04, 1.0);
        k.m(11, 0.25, 0.25, 0.25); fbox(k.lit, f, m.u1 - 0.5, u0, y + GHOST_PLATFORM + 0.22, 0.15, 0.22, 0.9);
        k.solid(m.u1 - 0.5, u0, y + GHOST_PLATFORM, y + GHOST_PLATFORM + 0.5, 0.25, 1.05);
      }
      const sy = y + GHOST_PLATFORM + 2.3;
      wallDecal(k.dec, f, m.u1, -9, -1, 0, sy, 1.0, 1.0, CELL.roundel);
      wallDecal(k.dec, f, m.u1, 5.5, -1, 0, sy, 1.0, 1.0, CELL.roundel);
      wallDecal(k.dec, f, m.u1, -2, -1, 0, sy - 0.2, 0.9, 0.45, CELL.arrow);
      wallDecal(k.dec, f, m.u1, 0, -1, 0, y + GHOST_PLATFORM + 3.2, 12.4, 0.25, CELL.frieze);
      wallDecal(k.dec, f, m.u1, 9.5, -1, 0, sy - 0.3, 0.8, 0.4, CELL.chips);
      graffiti(k, { ...m, u0: 0.6, y0: y + GHOST_PLATFORM }, 4, y + GHOST_PLATFORM);
      for (let i = 0; i < 18; i++) {
        k.m(12, k.rng.range(0.4, 0.8), k.rng.range(0.4, 0.7), k.rng.range(0.3, 0.6));
        fbox(k.lit, f, k.rng.range(0.6, m.u1 - 0.3), k.rng.range(m.v0 + 0.5, m.v1 - 0.5), y + GHOST_PLATFORM + 0.02, k.rng.range(0.05, 0.15), 0.02, k.rng.range(0.05, 0.12), k.rng.range(0, 3));
      }
      lamp(k, m.u1 / 2, -3, top, true, true);
      lamp(k, m.u1 / 2, 7, top, true, true);
      puddles(k, { ...m, u0: 0.6, y0: y + GHOST_PLATFORM }, 2);
      break;
    }
    case 'vent': {
      // Ventilation: a big fan in the side wall; a shaft up to a street grate letting daylight in.
      const su = mu + 1, sv = mv; // (as rooms.ts checked the shaft)
      ceilHole = [su - 1.0, su + 1.0, sv - 1.0, sv + 1.0];
      const g = r.shaft ?? top + 2;
      k.m(8, ...wallT);
      wall(k.lit, f, su - 1, sv - 1, su + 1, sv - 1, top, g);
      wall(k.lit, f, su - 1, sv + 1, su + 1, sv + 1, top, g);
      wall(k.lit, f, su - 1, sv - 1, su - 1, sv + 1, top, g);
      wall(k.lit, f, su + 1, sv - 1, su + 1, sv + 1, top, g);
      k.m(11, 0.2, 0.2, 0.2);
      for (let i = -5; i <= 5; i++) fbox(k.lit, f, su + i * 0.18, sv, g - 0.05, 0.025, 0.04, 1.0);
      // Sky over the grate and a dusty shaft of light (brightness follows the day).
      const skyMat = (mats.veil as THREE.MeshBasicMaterial).clone();
      skyMat.userData.own = true;
      const veil = new MeshBuilder([{ name: 'color', size: 3, type: 'u8n' }]);
      veil.set('color', 0.22, 0.24, 0.26);
      const C = [k.P(su - 1, sv - 1, g), k.P(su + 1, sv - 1, g), k.P(su + 1, sv + 1, g), k.P(su - 1, sv + 1, g)];
      const i0 = veil.v(C[0][0], g + 0.05, C[0][2], 0, -1, 0);
      for (let i = 1; i < 4; i++) veil.v(C[i][0], g + 0.05, C[i][2], 0, -1, 0);
      veil.quad(i0, i0 + 1, i0 + 2, i0 + 3);
      // Light shaft: a soft prism from the grate to the floor, fading downwards.
      const B = [k.P(su - 0.7, sv - 0.8, m.y0), k.P(su + 1.3, sv - 0.6, m.y0), k.P(su + 1.2, sv + 0.9, m.y0), k.P(su - 0.8, sv + 0.7, m.y0)];
      for (let i = 0; i < 4; i++) {
        const a = C[i], b = C[(i + 1) % 4], c = B[(i + 1) % 4], d = B[i];
        veil.set('color', 0.05, 0.05, 0.045);
        const j = veil.v(a[0], g, a[2], 0, 1, 0); veil.v(b[0], g, b[2], 0, 1, 0);
        veil.set('color', 0, 0, 0);
        veil.v(c[0], c[1], c[2], 0, 1, 0); veil.v(d[0], d[1], d[2], 0, 1, 0);
        veil.quad(j, j + 1, j + 2, j + 3);
      }
      const sky = new THREE.Mesh(toGeometry(veil.build()), skyMat);
      sky.renderOrder = 3;
      extra.push(sky);
      // The fan in the far side wall: a ring, a hub and blades (turning slowly).
      const fv = m.v1 - 0.15, fy = m.y0 + 2.6;
      k.m(11, 0.32, 0.33, 0.35);
      for (let i = 0; i < 20; i++) {
        const a0 = (i / 20) * Math.PI * 2, a1 = ((i + 1) / 20) * Math.PI * 2;
        k.cylF(mu - 0.6 + Math.cos(a0) * 1.3, fv, fy + Math.sin(a0) * 1.3, mu - 0.6 + Math.cos(a1) * 1.3, fv, fy + Math.sin(a1) * 1.3, 0.08, 5);
      }
      const fan = new MeshBuilder(facadeSpecs());
      fan.set('aFacade', 1, 1, 1, 0).set('aSeed', 0.4).set('aElem', 0).set('aLayer', 11).set('aTint', 0.4, 0.42, 0.44);
      cyl(fan, 0, 0, -0.1, 0, 0, 0.15, 0.22, 10);
      // Blades: radial, slightly pitched, in the fan's own plane (the mesh turns about its local z).
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a), px = -sn, py = c;
        const q = [[0.2, -0.12, -0.04], [1.15, -0.2, -0.07], [1.15, 0.2, 0.07], [0.2, 0.12, 0.04]].map(([r, w, zz]) => [c * r + px * w, sn * r + py * w, zz]);
        const j = fan.v(q[0][0], q[0][1], q[0][2], 0, 0, 1);
        for (let e = 1; e < 4; e++) fan.v(q[e][0], q[e][1], q[e][2], 0, 0, 1);
        fan.quad(j, j + 1, j + 2, j + 3); fan.quad(j, j + 3, j + 2, j + 1);
      }
      const fanMesh = new THREE.Mesh(toGeometry(fan.build()), mats.lit);
      const fp = k.P(mu - 0.6, fv - 0.1, fy);
      fanMesh.position.set(fp[0], fp[1], fp[2]);
      fanMesh.lookAt(fp[0] - (-f.nz), fp[1], fp[2] - f.nx);
      const pivot = fanMesh.quaternion.clone();
      extra.push(fanMesh);
      // Blade angle per frame; the shaft's light follows daylight.
      const qz = new THREE.Quaternion(), ax = new THREE.Vector3(0, 0, 1);
      tick = (t, day) => {
        fanMesh.quaternion.copy(pivot).multiply(qz.setFromAxisAngle(ax, t * 1.4));
        skyMat.color.setScalar(0.08 + 0.92 * day);
      };
      k.m(11, 0.3, 0.3, 0.32); k.cylF(m.u0 + 0.2, m.v0 + 0.1, top - 0.3, m.u1 - 0.2, m.v0 + 0.1, top - 0.3, 0.12);
      lamp(k, m.u0 + 0.07, mv - 1.5, m.y0 + 2.4, false);
      wallDecal(k.dec, f, mu - 0.6, m.v1, 0, -1, fy - 1.7, 0.6, 0.08, CELL.hazard);
      k.emit('under_fan', mu - 0.6, fv, fy);
      break;
    }
    case 'electrical': {
      // Rows of cabinets with small lamps; cable trays; warning signs. It hums.
      k.m(11, 0.55, 0.57, 0.56);
      const n = Math.max(2, Math.floor((m.v1 - m.v0 - 0.6) / 0.85));
      for (let i = 0; i < n; i++) {
        const cv = m.v0 + 0.5 + i * 0.85;
        fbox(k.lit, f, m.u1 - 0.35, cv, y + 1.0, 0.3, 1.0, 0.4);
        for (let j = 0; j < 3; j++) whiteBox(k, m.u1 - 0.66, cv - 0.2 + j * 0.1, y + 1.7, 0.01, 0.015, 0.015, k.rng.chance(0.75) ? [0.2, 0.95, 0.3] : [0.95, 0.25, 0.15]);
      }
      k.solid(m.u1 - 0.35, (m.v0 + m.v1) / 2, y, y + 2, 0.32, (m.v1 - m.v0) / 2);
      for (let i = 0; i < 2; i++) fbox(k.lit, f, m.u0 + 0.35, m.v0 + 0.6 + i * 0.85, y + 0.8, 0.3, 0.8, 0.4);
      k.solid(m.u0 + 0.35, m.v0 + 1.0, y, y + 1.6, 0.32, 0.85);
      k.m(11, 0.3, 0.3, 0.3); fbox(k.lit, f, mu, mv, top - 0.25, 0.15, 0.03, (m.v1 - m.v0) / 2);
      wallDecal(k.dec, f, mu, m.v1, 0, -1, y + 1.6, 0.25, 0.25, CELL.volt);
      wallDecal(k.dec, f, mu - 0.6, m.v1, 0, -1, y + 0.2, 0.7, 0.08, CELL.hazard);
      lamp(k, mu, mv, top, true, true);
      k.emit('under_hum', m.u1 - 0.5, mv, y + 1.2);
      break;
    }
    case 'storage': {
      // Shelves of crates, old signs leaning on the wall, a dead departure board.
      k.m(11, 0.4, 0.42, 0.44);
      for (const sv of [m.v0 + 0.35, m.v1 - 0.35]) {
        for (const h of [0.05, 0.75, 1.45]) fbox(k.lit, f, mu, sv, y + h, (m.u1 - m.u0) / 2 - 0.5, 0.025, 0.3);
        for (const su of [m.u0 + 0.6, mu, m.u1 - 0.6]) fbox(k.lit, f, su, sv, y + 0.9, 0.025, 0.9, 0.3);
        k.solid(mu, sv, y, y + 1.8, (m.u1 - m.u0) / 2 - 0.45, 0.32);
        for (const h of [0.1, 0.8, 1.5]) for (let i = 0; i < 3; i++) if (k.rng.chance(0.75)) crate(k, m.u0 + 1 + i * 1.1 + k.rng.range(-0.2, 0.2), sv, y + h - 0.02, k.rng.range(0.15, 0.24), k.rng.range(-0.2, 0.2), false);
      }
      // Old signs on boards leaning against the back wall.
      for (const [sv, cell, w] of [[mv - 1.2, CELL.roundel, 0.55], [mv + 0.1, CELL.arrow, 0.7], [mv + 1.3, CELL.chips, 0.5]] as const) {
        const lean = 0.18;
        k.m(12, 0.3, 0.3, 0.3); fbox(k.lit, f, m.u1 - 0.2, sv, y + w, 0.02, w, w, 0);
        wallDecal(k.dec, f, m.u1 - 0.23, sv, -1, 0, y + w, w * 0.95, w * 0.95, cell);
        void lean;
      }
      k.m(11, 0.15, 0.15, 0.16); fbox(k.lit, f, mu, mv, y + 0.2, 0.8, 0.16, 0.12, 0.3);
      lamp(k, mu, mv, top, true);
      streaks(k, m, 2);
      break;
    }
  }
  // Graffiti here and there (metro rooms more often), stains, a drip in most.
  if (r.kind !== 'ghost' && r.main.u1 - r.main.u0 > 2 && k.rng.chance(sewer ? 0.25 : 0.4)) graffiti(k, m, 1 + k.rng.int(0, 1), m.y0);
  if (sewer && r.kind !== 'cistern' && r.kind !== 'alcove') k.emit('under_drip', mu, mv, top - 0.2);
  shell(k, r, ceilHole);
  // A faint trail: something small and glowing passed through, towards a crack (or the gap).
  let scout: BuiltRoom['scout'] = null;
  if (r.trace) scout = trail(k, r);
  const obj = k.build(mats);
  for (const e of extra) obj.add(e);
  return { obj, obstacles: k.obstacles, emitters: k.emitters, tick, scout };
}

/** Glow dots along the floor from the door to the gap (or a crack in a back corner). */
function trail(k: Kit, r: Room): BuiltRoom['scout'] {
  const m = r.main, f = k.f;
  const fy = m.y0 + (r.kind === 'ghost' ? GHOST_PLATFORM : 0);
  const tv = r.gap ? r.gap.v : k.rng.chance(0.5) ? m.v0 + 0.25 : m.v1 - 0.25;
  const tu = r.gap ? m.u1 - 0.2 : r.kind === 'collapsed' ? m.u1 - 3.4 : m.u1 - 0.25;
  const su = r.kind === 'ghost' ? 1.8 : r.dl + 0.2, sv = r.kind === 'ghost' ? -8 : 0;
  // Only the lowered part of a cistern (a trail does not climb the steps in the dark).
  const u0 = r.kind === 'cistern' ? m.u0 + 2.6 : su;
  const L = Math.hypot(tu - u0, tv - sv), n = Math.max(4, Math.floor(L / 0.32));
  const ph = k.rng.range(0, 6);
  k.glow.set('color', 0.12, 0.34, 0.3);
  for (let i = 0; i <= n; i++) {
    const t = i / n, wob = Math.sin(t * 7 + ph) * 0.25 * Math.sin(t * Math.PI);
    const u = u0 + (tu - u0) * t - (tv - sv) / (L || 1) * wob, v = sv + (tv - sv) * t + (tu - u0) / (L || 1) * wob;
    if (i % 3 === 2) continue;
    floorDecal(k.glow, f, u, v, (r.kind === 'cistern' ? m.y0 : fy) + 0.004, 0.05, 0.04, k.rng.range(0, 3), CELL.dot);
  }
  // A crack at the bottom of the wall where it ends (unless it ends at the gap).
  const yb = r.kind === 'cistern' ? m.y0 : fy;
  if (!r.gap) {
    if (Math.abs(tv - m.v0) < 0.3 || Math.abs(tv - m.v1) < 0.3) {
      const sv2 = tv > (m.v0 + m.v1) / 2 ? 1 : -1;
      wallDecal(k.dec, f, tu, sv2 > 0 ? m.v1 : m.v0, 0, -sv2, yb + 0.35, 0.12, 0.35, CELL.crack);
    }
  }
  const [x, z] = fw(f, tu - 0.35, tv);
  const [hx, hz] = fw(f, tu + 0.1, tv);
  return { x, y: yb, z, hx, hz };
}

// ------------------------------------------------------------ crawl passages and chambers

/** The rough crawl passage from a room's back wall down to its chamber. */
export function buildCrawl(c: Colony, mats: RoomMats): THREE.Object3D {
  const mb = new MeshBuilder(facadeSpecs());
  mb.set('aFacade', 1, 1, 1, 0).set('aSeed', 0.5).set('aElem', 0).set('aLayer', 3).set('aTint', 0.5, 0.4, 0.32);
  const t = c.crawl, total = t.cum[t.cum.length - 1];
  const rng = new Rng(c.seed ^ 0x77);
  const hw = CRAWL_HW, h = CRAWL_H;
  // Profile (lat, height): flat floor, bulging rough walls, a low irregular vault.
  const prof: [number, number][] = [[-hw, 0], [hw, 0], [hw * 1.08, 0.7], [hw * 0.95, 1.5], [hw * 0.55, h * 0.97], [0, h], [-hw * 0.55, h * 0.97], [-hw * 0.95, 1.5], [-hw * 1.08, 0.7]];
  const rings: number[][] = [];
  const s0 = 1.0, s1 = total - 2.8;
  for (let s = s0; s <= s1 + 1e-6; s += Math.min(0.8, s1 - s + 1e-3 > 0.8 ? 0.8 : s1 - s + 1e-3)) {
    const p = pointOnTube(t, Math.min(s, s1))!;
    const ring: number[] = [];
    for (let k = 0; k < prof.length; k++) {
      const [l, y] = prof[k];
      const j = k < 2 || s < s0 + 0.5 || s > s1 - 0.5 ? 0 : rng.range(-0.08, 0.1);
      const L = l * (1 + j), Y = y + (y > 0.1 ? rng.range(-0.06, 0.06) : 0);
      ring.push(p.x - p.dz * L, p.y + Y, p.z + p.dx * L);
    }
    rings.push(ring);
    if (s >= s1) break;
  }
  for (let i = 0; i + 1 < rings.length; i++) {
    const A = rings[i], B = rings[i + 1];
    for (let k = 0; k < prof.length; k++) {
      const k2 = (k + 1) % prof.length;
      const a = [A[k * 3], A[k * 3 + 1], A[k * 3 + 2]], b = [A[k2 * 3], A[k2 * 3 + 1], A[k2 * 3 + 2]];
      const cc = [B[k2 * 3], B[k2 * 3 + 1], B[k2 * 3 + 2]], d = [B[k * 3], B[k * 3 + 1], B[k * 3 + 2]];
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      const i0 = mb.v(a[0], a[1], a[2], nx, ny, nz, k * 0.5, i * 0.8);
      mb.v(b[0], b[1], b[2], nx, ny, nz, k * 0.5 + 0.5, i * 0.8);
      mb.v(cc[0], cc[1], cc[2], nx, ny, nz, k * 0.5 + 0.5, i * 0.8 + 0.8);
      mb.v(d[0], d[1], d[2], nx, ny, nz, k * 0.5, i * 0.8 + 0.8);
      mb.quad(i0, i0 + 1, i0 + 2, i0 + 3);
      mb.quad(i0, i0 + 3, i0 + 2, i0 + 1);
    }
  }
  // Loose stones along the sides.
  for (let s = s0 + 0.5; s < s1; s += rng.range(0.6, 1.4)) {
    const p = pointOnTube(t, s)!, side = rng.sign(), l = side * (hw - 0.12), sz = rng.range(0.05, 0.12);
    mb.set('aTint', 0.45, 0.37, 0.3);
    mb.box(p.x - p.dz * l, p.y + sz * 0.6, p.z + p.dx * l, sz * 1.4, sz * 0.6, sz, rng.range(0, 3));
  }
  const m = new THREE.Mesh(toGeometry(mb.build()), mats.lit);
  m.receiveShadow = true;
  return m;
}

/** A colony's chamber layout (chamber frame: centre, u along its axis, v across), deterministic. */
export interface ColonyLayout {
  frame: Frame; y: number; hu: number; hv: number;
  palette: [number, number, number][];
  gardens: { u: number; v: number; r: number }[];
  structures: { u: number; v: number; r: number; h: number; stack: boolean }[];
  lamps: { u: number; v: number; h: number; c: number }[];
  /** Hiding places: cracks at the foot of the walls (u, v on the wall, inward facing fu, fv). */
  crevices: { u: number; v: number; fu: number; fv: number }[];
  /** Where they sit together, where they gather things, the spiral of collected things. */
  circle: { u: number; v: number };
  pile: { u: number; v: number };
  spiral: { u: number; v: number };
  row: { u: number; v0: number; v1: number };
}

const PALETTES: [number, number, number][][] = [
  [[0.1, 1.0, 0.7], [0.35, 1.0, 0.2], [0.1, 0.6, 1.0]],
  [[1.0, 0.6, 0.1], [1.0, 0.35, 0.15], [1.0, 0.85, 0.2]],
  [[0.7, 0.25, 1.0], [0.25, 0.45, 1.0], [1.0, 0.3, 0.75]],
  [[0.5, 1.0, 0.15], [0.1, 0.95, 0.6], [0.95, 0.95, 0.2]],
  [[1.0, 0.3, 0.6], [0.3, 0.75, 1.0], [0.75, 0.4, 1.0]],
];

export function colonyLayout(c: Colony): ColonyLayout {
  const b = c.chamber, rng = new Rng(c.seed);
  const frame: Frame = { ox: b.cx, oz: b.cz, nx: b.ux, nz: b.uz };
  const hu = b.hu, hv = b.hv;
  const used: { u: number; v: number; r: number }[] = [{ u: -hu + 1.5, v: 0, r: 1.6 }];
  const place = (r: number, margin = 0.6): { u: number; v: number } => {
    for (let i = 0; i < 40; i++) {
      const u = rng.range(-hu + r + margin, hu - r - margin), v = rng.range(-hv + r + margin, hv - r - margin);
      if (used.every((o) => Math.hypot(o.u - u, o.v - v) > o.r + r + 0.4)) { used.push({ u, v, r }); return { u, v }; }
    }
    const u = rng.range(-hu + 1, hu - 1), v = rng.range(-hv + 1, hv - 1);
    used.push({ u, v, r });
    return { u, v };
  };
  const circle = place(1.3);
  const spiral = place(1.0);
  const pile = place(0.6);
  const gardens = Array.from({ length: 3 + rng.int(0, 1) }, () => { const r = rng.range(0.9, 1.5); return { ...place(r), r }; });
  const structures = Array.from({ length: 3 + rng.int(0, 2) }, () => { const r = rng.range(0.35, 0.7); return { ...place(r), r, h: r * rng.range(0.9, 1.6), stack: rng.chance(0.45) }; });
  const lamps = Array.from({ length: 9 + rng.int(0, 4) }, () => ({ ...place(0.15, 0.3), h: rng.range(0.15, 0.45), c: rng.int(0, 2) }));
  const crevices: ColonyLayout['crevices'] = [];
  for (let i = 0; i < 7; i++) {
    const side = i % 3;
    if (side === 0) crevices.push({ u: hu, v: rng.range(-hv + 0.8, hv - 0.8), fu: -1, fv: 0 });
    else { const sv = side === 1 ? 1 : -1; crevices.push({ u: rng.range(-hu + 2.5, hu - 0.8), v: sv * hv, fu: 0, fv: -sv }); }
  }
  const row = { u: hu - 0.45, v0: -hv + 1.2, v1: rng.range(-1, 1.5) };
  return { frame, y: b.y0, hu, hv, palette: PALETTES[c.seed % PALETTES.length], gardens, structures, lamps, crevices, circle, pile, spiral, row };
}

/** The hidden chamber: rough walls, moss gardens, little domes and stacks of salvaged things, fungus lamps. */
export function buildChamber(c: Colony, L: ColonyLayout, mats: RoomMats): BuiltRoom {
  const f = L.frame, y = L.y, hu = L.hu, hv = L.hv, top = y + c.chamber.y1 - c.chamber.y0;
  const k = new Kit(f, new Rng(c.seed ^ 0x5151));
  const pal = L.palette;
  const dim = (col: [number, number, number], s: number): [number, number, number] => [col[0] * s, col[1] * s, col[2] * s];
  // Shell: rough stone; the crawl comes in at the near end.
  k.m(8, 0.34, 0.27, 0.21);
  wall(k.lit, f, -hu, -hv, -hu, hv, y, top, [[hv - CRAWL_HW, hv + CRAWL_HW, y - 0.01, y + CRAWL_H]]);
  wall(k.lit, f, hu, -hv, hu, hv, y, top);
  wall(k.lit, f, -hu, -hv, hu, -hv, y, top);
  wall(k.lit, f, -hu, hv, hu, hv, y, top);
  k.m(8, 0.3, 0.24, 0.19); flat(k.lit, f, -hu, hu, -hv, hv, top, false);
  k.m(22, 0.4, 0.33, 0.26); flat(k.lit, f, -hu, hu, -hv, hv, y + 0.002);
  // Boulders along the foot of the walls, roots hanging from the ceiling.
  for (let i = 0; i < 26; i++) {
    const side = i % 4, s = k.rng.range(0.25, 0.6);
    const u = side < 2 ? k.rng.range(-hu + 1.5, hu - 0.5) : (side === 2 ? hu - s * 0.6 : -hu + s * 0.6);
    const v = side < 2 ? (side === 0 ? hv - s * 0.6 : -hv + s * 0.6) : k.rng.range(-hv + 0.5, hv - 0.5);
    if (side === 3 && Math.abs(v) < 1.4) continue;
    if (L.crevices.some((q) => Math.hypot(q.u - u, q.v - v) < 0.8)) continue;
    k.m(3, 0.42 + k.rng.range(-0.06, 0.06), 0.34, 0.27);
    fbox(k.lit, f, u, v, y + s * 0.5, s, s * 0.7, s * 0.9, k.rng.range(0, 3));
  }
  k.m(12, 0.42, 0.34, 0.26);
  for (let i = 0; i < 9; i++) {
    const u = k.rng.range(-hu + 1, hu - 1), v = k.rng.range(-hv + 1, hv - 1), l = k.rng.range(0.3, 1.0);
    const a = k.P(u, v, top), b = k.P(u + k.rng.range(-0.2, 0.2), v + k.rng.range(-0.2, 0.2), top - l);
    cyl(k.lit, a[0], a[1], a[2], b[0], b[1], b[2], 0.015, 4, false);
  }
  // Moss gardens: soft glowing patches with tiny sprouts in neat rows.
  for (const g of L.gardens) {
    for (let i = 0; i < 5; i++) {
      const col = dim(pal[(i + 1) % pal.length], 0.3 + k.rng.range(0, 0.12));
      k.glow.set('color', ...col);
      floorDecal(k.glow, f, g.u + k.rng.range(-0.4, 0.4) * g.r, g.v + k.rng.range(-0.4, 0.4) * g.r, y + 0.003 + i * 0.001, g.r * k.rng.range(0.45, 0.7), g.r * k.rng.range(0.4, 0.6), k.rng.range(0, 3), CELL.blob);
    }
    for (let ru = -g.r * 0.6; ru <= g.r * 0.6; ru += 0.22) for (let rv = -g.r * 0.6; rv <= g.r * 0.6; rv += 0.3) {
      if (Math.hypot(ru, rv) > g.r * 0.6) continue;
      whiteBox(k, g.u + ru, g.v + rv, y + 0.05, 0.012, 0.05, 0.012, dim(pal[0], 0.8));
    }
  }
  // Little domes of bottle caps and tiles, stacks of cans.
  const capCols: [number, number, number][] = [[0.8, 0.2, 0.15], [0.9, 0.75, 0.2], [0.2, 0.45, 0.8], [0.85, 0.85, 0.85], [0.2, 0.6, 0.3]];
  for (const s of L.structures) {
    if (s.stack) {
      // Cans stacked in a shrinking cylinder (a little tower).
      let ry = y, rr = s.r;
      for (let lvl = 0; lvl < 4 && rr > 0.1; lvl++) {
        const n = Math.max(3, Math.round((rr * Math.PI * 2) / 0.14));
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + lvl * 0.3;
          const P = k.P(s.u + Math.cos(a) * rr, s.v + Math.sin(a) * rr, ry);
          const t = k.rng.range(0.5, 0.95);
          k.m(11, t, t * k.rng.range(0.7, 1), t * k.rng.range(0.6, 1));
          cyl(k.lit, P[0], P[1], P[2], P[0], P[1] + 0.12, P[2], 0.033, 6);
        }
        ry += 0.12; rr *= 0.72;
      }
      k.glow.set('color', ...dim(pal[1], 0.7));
      whiteBox(k, s.u, s.v, ry + 0.04, 0.035, 0.035, 0.035, dim(pal[1], 0.75));
    } else {
      // A dome shell of tiles with a low doorway, capped with bottle caps.
      k.m(15, 0.75, 0.72, 0.66);
      const P = k.P(s.u, s.v, y);
      dome(k.lit, P[0], P[1], P[2], s.r, s.h, 12, 4);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2, t = 0.35;
        const Q = k.P(s.u + Math.cos(a) * s.r * Math.cos(t), s.v + Math.sin(a) * s.r * Math.cos(t), y + Math.sin(t) * s.h);
        const col = capCols[(i + Math.floor(s.r * 10)) % capCols.length];
        k.m(11, ...col);
        cyl(k.lit, Q[0], Q[1], Q[2], Q[0], Q[1] + 0.02, Q[2], 0.03, 6);
      }
      // The doorway: a dark arch facing the middle.
      const a = Math.atan2(-s.v, -s.u);
      k.glow.set('color', 0.02, 0.02, 0.02);
      const n0 = k.glow.vcount;
      fbox(k.glow, f, s.u + Math.cos(a) * s.r * 0.98, s.v + Math.sin(a) * s.r * 0.98, y + s.h * 0.25, 0.02, s.h * 0.25, s.r * 0.25, a);
      pinUV(k.glow, n0);
      // Warm light inside, seen through the doorway.
      whiteBox(k, s.u, s.v, y + 0.05, s.r * 0.4, 0.04, s.r * 0.4, dim(pal[2], 0.5));
      k.solidCyl(s.u, s.v, y, y + s.h, s.r);
    }
  }
  // Fungus lamps: pale stalks with glowing caps, in little clusters.
  for (const l of L.lamps) {
    for (let i = 0; i < 3; i++) {
      const du = k.rng.range(-0.12, 0.12), dv = k.rng.range(-0.12, 0.12), h = l.h * k.rng.range(0.6, 1.1);
      const P = k.P(l.u + du, l.v + dv, y);
      k.m(13, 0.75, 0.72, 0.62);
      cyl(k.lit, P[0], P[1], P[2], P[0], P[1] + h, P[2], 0.012, 5, false);
      k.glow.set('color', ...dim(pal[l.c], 0.95));
      const n0 = k.glow.vcount;
      dome(k.glow, P[0], P[1] + h - 0.01, P[2], 0.05 + h * 0.12, 0.04 + h * 0.05, 8, 2);
      pinUV(k.glow, n0);
    }
  }
  // A neat spiral of collected glowing beads, a row of cans sorted by size along the far wall.
  for (let a = 0.6; a < Math.PI * 6; a += 0.42) {
    const rr = 0.07 * a;
    const col = dim(pal[Math.floor(a) % pal.length], 0.8);
    whiteBox(k, L.spiral.u + Math.cos(a) * rr, L.spiral.v + Math.sin(a) * rr, y + 0.025, 0.025, 0.025, 0.025, col);
  }
  const nRow = Math.floor((L.row.v1 - L.row.v0) / 0.2);
  for (let i = 0; i < nRow; i++) {
    const h = 0.08 + (i / nRow) * 0.14, P = k.P(L.row.u, L.row.v0 + i * 0.2, y);
    k.m(11, 0.7, 0.68 - i * 0.02, 0.6);
    cyl(k.lit, P[0], P[1], P[2], P[0], P[1] + h, P[2], 0.04, 7);
  }
  // A pile of things gathered (caps, tiles), where carriers fetch from.
  for (let i = 0; i < 14; i++) {
    k.m(11, ...capCols[i % capCols.length]);
    const a = k.rng.range(0, Math.PI * 2), d = Math.sqrt(k.rng.float()) * 0.4;
    fbox(k.lit, f, L.pile.u + Math.cos(a) * d, L.pile.v + Math.sin(a) * d, y + 0.02 + k.rng.range(0, 0.06), 0.04, 0.012, 0.04, k.rng.range(0, 3));
  }
  // Markings on the walls (patterns, faintly glowing), cracks where they hide.
  for (let i = 0; i < 6; i++) {
    const cell = CELL.mark + (i % 4), s = k.rng.range(0.35, 0.7), col = dim(pal[i % pal.length], 0.45);
    k.glow.set('color', ...col);
    if (i % 2 === 0) wallDecal(k.glow, f, hu, k.rng.range(-hv + 1, hv - 1), -1, 0, y + k.rng.range(1.1, 2.4), s, s, cell);
    else { const sv = i % 4 === 1 ? 1 : -1; wallDecal(k.glow, f, k.rng.range(-hu + 2, hu - 1), sv * hv, 0, -sv, y + k.rng.range(1.1, 2.4), s, s, cell); }
  }
  for (const q of L.crevices) wallDecal(k.dec, f, q.u, q.v, q.fu, q.fv, y + 0.38, 0.16, 0.4, CELL.crack);
  // Their circle: a ring of small flat stones.
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    k.m(13, 0.55, 0.52, 0.48);
    fbox(k.lit, f, L.circle.u + Math.cos(a) * 1.05, L.circle.v + Math.sin(a) * 1.05, y + 0.02, 0.09, 0.02, 0.07, a);
  }
  k.emit('under_drip', hu - 2, 0, top - 0.2);
  return { obj: k.build(mats), obstacles: k.obstacles, emitters: k.emitters, tick: null, scout: null };
}
