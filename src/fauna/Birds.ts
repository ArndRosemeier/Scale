/**
 * Birds: a light, lively layer that exists only around the camera (like the pedestrians,
 * nothing is simulated city-wide and placement is not deterministic).
 *
 *  - Ground groups: pigeons and sparrows on sidewalks, plazas and parks, pigeons on flat
 *    roof edges. They peck, walk or hop; anything that comes too close - the player
 *    (by size and speed), a running person, a car, a drone, a loud event - flushes them:
 *    they burst up with a flutter, circle, and land again nearby once it is calm.
 *  - Flocks: a circling pigeon flock by day and starling murmurations at dusk (offsets in
 *    a slowly deforming, rippling ellipsoid that follows a wandering centre, steered with
 *    limited acceleration, so they bank smoothly); gulls soaring over the river or the sea;
 *    single crows crossing. They climb over buildings and scatter around a giant or a
 *    flying player.
 *  - Night: no flocks or crossings; birds on roofs roost (sit still); few on the street.
 *  - Strikes and blasts: a direct hit sends feathers flying and the bird tumbles, then
 *    flees; a giant's body or a flying player swats birds out of the air the same way.
 *
 * One instanced mesh (birdMesh.ts), one draw call; at most CAP birds; no per-frame
 * allocations.
 */
import * as THREE from 'three';
import type { Terrain } from '../world/terrain';
import type { WorldIndex, BuildingRef } from '../world/WorldIndex';
import type { Stimuli, Stimulus } from '../game/Stimuli';
import type { Dust } from '../destruction/Dust';
import type { Debris } from '../destruction/Debris';
import { G } from '../render/materials/globals';
import { clamp, smoothstep } from '../core/math';
import { createBirdGeometry, createBirdMaterial } from './birdMesh';

/** What the birds need from the game. */
export interface BirdCtx {
  terrain: Terrain;
  world: WorldIndex;
  peds: { neighbours(x: number, z: number, r: number, out: BirdPed[]): BirdPed[] };
  traffic: { vehicles: readonly { x: number; z: number; y: number; speed: number; length: number }[] };
  drones: { list: readonly { x: number; y: number; z: number }[] };
  dust: Dust;
  debris: Debris;
  /** Spatial one-shot (id from public/sounds/manifest.json). */
  sound: (id: string, x: number, y: number, z: number, gain: number, pitch: number, refDist: number) => void;
}

interface BirdPed { x: number; z: number; y: number; speed: number; state: number; inside?: boolean }

/** The player's body (null in the free camera). */
export interface BirdPlayer {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  height: number;
  radius: number;
  flying: boolean;
}

const enum Sp { Pigeon = 0, Sparrow = 1, Starling = 2, Gull = 3, Crow = 4 }
const enum Mode { Ground = 0, Air = 1, Land = 2, Flock = 3, Soar = 4, Cross = 5, Tumble = 6 }

interface Species {
  /** Body length (m) and wingspan factor. */
  len: number; span: number;
  body: THREE.Color; wing: THREE.Color; beak: number; tip: number;
  /** Wing beats per second, cruise speed (m/s). */
  hz: number; speed: number;
}

const col = (hex: number) => new THREE.Color(hex);
const SPECIES: Species[] = [
  { len: 0.32, span: 1.0, body: col(0x6c717c), wing: col(0x8c929e), beak: 0, tip: 0.75, hz: 7, speed: 9 },
  { len: 0.15, span: 0.8, body: col(0x86664a), wing: col(0x5f4630), beak: 0, tip: 0.35, hz: 14, speed: 7 },
  { len: 0.21, span: 0.9, body: col(0x26262c), wing: col(0x303036), beak: 0.6, tip: 0.2, hz: 10, speed: 12 },
  { len: 0.5, span: 1.35, body: col(0xe9e9e4), wing: col(0xa4abb4), beak: 1, tip: 0.95, hz: 3, speed: 8 },
  { len: 0.46, span: 1.05, body: col(0x141416), wing: col(0x1a1a1d), beak: 0, tip: 0, hz: 4.5, speed: 11 },
];

interface Bird {
  /** Index in the pool. */
  id: number;
  on: boolean;
  sp: Sp;
  mode: Mode;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  yaw: number; pitch: number; roll: number;
  /** Heading wanted on the ground. */
  tyaw: number;
  /** Wing: phase, amplitude, fold (0 open … 1 tucked), bias (dihedral), beat rate. */
  phase: number; amp: number; fold: number; bias: number; hz: number;
  /** Mode timer and action timer. */
  t: number; act: number;
  /** Peck time left; walk / hop progress (-1 = standing) and its duration. */
  peck: number; hop: number; hopT: number;
  x0: number; y0: number; z0: number; x1: number; y1: number; z1: number;
  /** Target (landing spot, circle centre, soaring anchor). */
  tx: number; ty: number; tz: number;
  /** Ground group or flock index (-1 none). */
  g: number;
  /** Flock offset in the unit ball; circle radius / direction for soaring. */
  ox: number; oy: number; oz: number;
  size: number;
}

interface Group {
  on: boolean;
  sp: Sp;
  x: number; y: number; z: number; r: number;
  /** Roof edge: along-edge direction and outward normal. */
  roof: boolean; ex: number; ez: number; nx: number; nz: number;
  members: number[];
  /** Flushed: circle centre; seconds without a threat. */
  flushed: boolean; cx: number; cy: number; cz: number; calm: number;
  checkT: number;
  cooT: number;
}

interface Flock {
  on: boolean;
  sp: Sp;
  x: number; y: number; z: number;
  hd: number; vh: number; speed: number; alt: number;
  /** Shape half-axes (m). */
  ax: number; ay: number; az: number;
  t: number;
  members: number[];
  /** Scatter: strength 0..1 and its source. */
  scat: number; sx: number; sy: number; sz: number;
  leave: boolean;
  checkT: number;
  /** Lowest centre height clearing the roofs below and ahead. */
  floor: number;
  /** Mean velocity of the members (for alignment). */
  mvx: number; mvy: number; mvz: number;
}

const CAP = 300;
const GROUP_CAP = 18;
const FLOCK_CAP = 4;
const DRAW_R = 900;
const GROUND_DRAW_R = 220;
const GRAV = 9.81;

/** Scare radii (m) of stimuli for birds on the ground (capped by the stimulus' own radius). */
const SCARE: Partial<Record<Stimulus['kind'], number>> = { impact: 35, glass: 25, collapse: 260, blast: 200, stomp: 140, giant: 150, crash: 60, scream: 18, horn: 16, sonic: 500, flyby: 40, threat: 25, roar: 420, tremor: 300, thunder: 120 };

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _col = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);

export class Birds {
  readonly mesh: THREE.InstancedMesh;
  private anim: THREE.InstancedBufferAttribute;
  private colA: THREE.InstancedBufferAttribute;
  private colB: THREE.InstancedBufferAttribute;
  private span: THREE.InstancedBufferAttribute;
  private readonly uniforms = { uBirdPx: { value: 0.003 } };
  private birds: Bird[] = [];
  private free: number[] = [];
  private groups: Group[] = [];
  private flocks: Flock[] = [];
  private pedsNear: BirdPed[] = [];
  private refs: BuildingRef[] = [];
  private t = 0;
  private spawnT = 0;
  private flockT = 0;
  private gullT = 0;
  private crowT = 8;
  private callT = 4;
  private featherSound = -1;
  private water = { x: 0, z: 0, ok: false, t: -1e9 };
  /** Threat found by the last scare check. */
  private thx = 0;
  private thz = 0;
  private fx = 0;
  private fz = 0;
  private night = 0;
  private hour = 12;
  /** Rain 0..1 (render/Weather): no flocks, gulls or crows aloft; fewer groups on the street. */
  rain = 0;
  stats = { birds: 0, ground: 0, groups: 0, flocks: 0, gulls: 0, crows: 0, drawn: 0, flushes: 0, hits: 0, ms: 0 };

  constructor(private ctx: BirdCtx, stimuli: Stimuli) {
    const g = createBirdGeometry();
    this.anim = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.colA = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.colB = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iAnim', this.anim);
    g.setAttribute('iColA', this.colA);
    this.span = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 2), 2).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iColB', this.colB);
    g.setAttribute('iSpan', this.span);
    this.mesh = new THREE.InstancedMesh(g, createBirdMaterial(this.uniforms), CAP);
    this.mesh.name = 'birds';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    for (let i = 0; i < CAP; i++) {
      this.birds.push({
        id: i, on: false, sp: Sp.Pigeon, mode: Mode.Ground, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, roll: 0, tyaw: 0,
        phase: 0, amp: 0, fold: 1, bias: 0, hz: 1, t: 0, act: 0, peck: 0, hop: -1, hopT: 1,
        x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0, tx: 0, ty: 0, tz: 0, g: -1, ox: 0, oy: 0, oz: 0, size: 1,
      });
      this.free.push(CAP - 1 - i);
    }
    for (let i = 0; i < GROUP_CAP; i++) this.groups.push({ on: false, sp: Sp.Pigeon, x: 0, y: 0, z: 0, r: 1, roof: false, ex: 1, ez: 0, nx: 0, nz: 1, members: [], flushed: false, cx: 0, cy: 0, cz: 0, calm: 0, checkT: 0, cooT: 5 });
    for (let i = 0; i < FLOCK_CAP; i++) this.flocks.push({ on: false, sp: Sp.Starling, x: 0, y: 0, z: 0, hd: 0, vh: 0, speed: 10, alt: 60, ax: 20, ay: 6, az: 14, t: 0, members: [], scat: 0, sx: 0, sy: 0, sz: 0, leave: false, checkT: 0, floor: 0, mvx: 0, mvy: 0, mvz: 0 });
    stimuli.on((s) => this.onStimulus(s));
  }

  // ------------------------------------------------------------------ update

  update(dt: number, hour: number, focus: THREE.Vector3, player: BirdPlayer | null, cam: THREE.PerspectiveCamera): void {
    const t0 = performance.now();
    if (dt <= 0) return;
    this.t += dt;
    this.hour = hour;
    this.night = G.uNight.value;
    this.fx = focus.x; this.fz = focus.z;
    cam.getWorldDirection(_fwd);
    this.spawn(dt, focus, player, cam);
    for (let i = 0; i < GROUP_CAP; i++) if (this.groups[i].on) this.updateGroup(i, dt, player);
    for (let i = 0; i < FLOCK_CAP; i++) if (this.flocks[i].on) this.updateFlock(this.flocks[i], dt, player);
    let n = 0, ground = 0, gulls = 0, crows = 0;
    for (let i = 0; i < CAP; i++) {
      const b = this.birds[i];
      if (!b.on) continue;
      n++;
      switch (b.mode) {
        case Mode.Ground: ground++; this.stepGround(b, dt); break;
        case Mode.Air: this.stepAir(b, dt); break;
        case Mode.Land: this.stepLand(b, dt); break;
        case Mode.Flock: this.stepFlock(b, i, dt, player); break;
        case Mode.Soar: gulls++; this.stepSoar(b, i, dt, player); break;
        case Mode.Cross: crows++; this.stepCross(b, i, dt, player); break;
        case Mode.Tumble: this.stepTumble(b, dt); break;
      }
      if (b.mode !== Mode.Ground && b.mode !== Mode.Tumble && player) this.swat(b, player);
      b.phase += b.hz * dt * Math.PI * 2;
      if (b.phase > 1e4) b.phase -= Math.PI * 2 * 1000;
    }
    this.calls(dt, cam);
    this.draw(cam);
    const S = this.stats;
    S.birds = n; S.ground = ground; S.gulls = gulls; S.crows = crows;
    S.groups = 0; for (const g of this.groups) if (g.on) S.groups++;
    S.flocks = 0; for (const f of this.flocks) if (f.on) S.flocks++;
    S.ms = S.ms * 0.95 + (performance.now() - t0) * 0.05;
  }

  /** Short debug summary (window.game.birds.report()). */
  report(): string {
    const s = this.stats;
    return `birds ${s.birds}/${CAP} (ground ${s.ground} in ${s.groups} groups, ${s.flocks} flocks, gulls ${s.gulls}, crows ${s.crows}, drawn ${s.drawn}) · flushes ${s.flushes} · hits ${s.hits} · ${s.ms.toFixed(3)} ms`;
  }

  // ------------------------------------------------------------------ spawning

  private spawn(dt: number, focus: THREE.Vector3, player: BirdPlayer | null, cam: THREE.Camera): void {
    const night = this.night;
    const k = player ? clamp(Math.sqrt(player.height / 1.8), 1, 4) : clamp(Math.sqrt(Math.max(1, cam.position.y - this.ctx.terrain.height(cam.position.x, cam.position.z)) / 15), 1, 3);
    const far = 150 * k;
    // Ground groups out of range go; flocks leave on their own.
    for (let i = 0; i < GROUP_CAP; i++) {
      const g = this.groups[i];
      if (!g.on) continue;
      const d = Math.hypot(g.x - focus.x, g.z - focus.z);
      // At night street groups thin out (only where nobody sees it happen).
      const unseen = d > 45 || (g.x - cam.position.x) * _fwd.x + (g.z - cam.position.z) * _fwd.z < 0;
      if (d > far * 1.25 || (!g.roof && night > 0.6 && unseen && this.streetGroups() > 1 && !g.flushed)) this.removeGroup(i);
    }
    this.spawnT -= dt;
    if (this.spawnT <= 0) {
      this.spawnT = 0.35;
      const street = this.streetGroups(), roof = this.roofGroups();
      const wet = Math.min(1, this.rain * 1.6);
      const wantStreet = Math.round((9 * (1 - night) + 1 * night) * (1 - 0.6 * wet)), wantRoof = Math.round(3 + night * 2);
      if (street < wantStreet && this.free.length > 24) this.spawnStreetGroup(focus, cam, 14 * Math.min(k, 2), far);
      else if (roof < wantRoof && this.free.length > 16) this.spawnRoofGroup(focus, cam, far);
    }
    // Flocks: a pigeon flock by day, murmurations at dusk.
    this.flockT -= dt;
    if (this.flockT <= 0) {
      this.flockT = 3;
      const h = this.hour;
      // Sunset is at 18:00 (SkySystem): murmurations in the last hour or so of daylight.
      const dusk = smoothstep(16.2, 16.9, h) * (1 - smoothstep(18.1, 18.6, h));
      let pigeons = 0, starlings = 0;
      for (const f of this.flocks) if (f.on && !f.leave) { if (f.sp === Sp.Starling) starlings++; else pigeons++; }
      const dry = this.rain < 0.15;
      const wantStar = dusk > 0.3 && dry ? 2 : 0, wantPig = night < 0.3 && dusk < 0.5 && dry ? 1 : 0;
      for (const f of this.flocks) {
        if (!f.on || f.leave) continue;
        if ((f.sp === Sp.Starling && starlings > wantStar) || (f.sp === Sp.Pigeon && pigeons > wantPig)) {
          f.leave = true;
          if (f.sp === Sp.Starling) starlings--; else pigeons--;
        }
      }
      if (starlings < wantStar && this.free.length > 70) this.spawnFlock(Sp.Starling, focus);
      else if (pigeons < wantPig && this.free.length > 40) this.spawnFlock(Sp.Pigeon, focus);
    }
    // Gulls over water.
    this.gullT -= dt;
    if (this.gullT <= 0) {
      this.gullT = 2.5;
      if (this.t - this.water.t > 6 || Math.hypot(this.water.x - focus.x, this.water.z - focus.z) > 450) this.findWater(focus);
      let gulls = 0;
      for (const b of this.birds) if (b.on && b.mode === Mode.Soar) gulls++;
      const want = this.water.ok ? Math.round(7 * (1 - night) * (1 - Math.min(1, this.rain * 1.4))) : 0;
      if (gulls < want && this.free.length > 8) this.spawnGull(focus);
    }
    // A crow (or two) crossing now and then by day.
    this.crowT -= dt;
    if (this.crowT <= 0) {
      this.crowT = 15 + Math.random() * 35;
      if (night < 0.3 && this.rain < 0.3 && this.free.length > 10) this.spawnCrows(focus);
    }
  }

  private streetGroups(): number { let n = 0; for (const g of this.groups) if (g.on && !g.roof) n++; return n; }
  private roofGroups(): number { let n = 0; for (const g of this.groups) if (g.on && g.roof) n++; return n; }

  private alloc(sp: Sp, mode: Mode): Bird | null {
    const i = this.free.pop();
    if (i === undefined) return null;
    const b = this.birds[i];
    b.on = true; b.sp = sp; b.mode = mode;
    b.vx = b.vy = b.vz = 0; b.pitch = b.roll = 0;
    b.phase = Math.random() * 6.28; b.amp = 0; b.fold = 1; b.bias = 0; b.hz = SPECIES[sp].hz;
    b.t = 0; b.act = Math.random() * 2; b.peck = 0; b.hop = -1; b.hopT = 1; b.g = -1;
    b.size = 0.9 + Math.random() * 0.2;
    return b;
  }

  private release(i: number): void {
    const b = this.birds[i];
    if (!b.on) return;
    b.on = false;
    this.free.push(i);
  }

  private freeGroup(): number { for (let i = 0; i < GROUP_CAP; i++) if (!this.groups[i].on) return i; return -1; }

  private removeGroup(gi: number): void {
    const g = this.groups[gi];
    for (const i of g.members) this.release(i);
    g.members.length = 0;
    g.on = false;
  }

  /** A walkable open spot: not in a building, not on the carriageway, not in water. */
  private groundSpot(x: number, z: number): number {
    const W = this.ctx.world;
    if (W.buildingAt(x, z) || this.ctx.terrain.isWater(x, z, 2)) return NaN;
    if (W.surfaceOffset(x, z) <= 0) return NaN;
    return W.groundHeight(x, z, this.ctx.terrain.height(x, z) + 1.5);
  }

  private spawnStreetGroup(focus: THREE.Vector3, cam: THREE.Camera, rMin: number, rMax: number): void {
    const gi = this.freeGroup();
    if (gi < 0) return;
    const camYaw = Math.atan2(_fwd.x, _fwd.z);
    for (let k = 0; k < 6; k++) {
      // Mostly ahead of the camera, not right under the player's nose.
      const a = Math.random() < 0.7 ? camYaw + (Math.random() - 0.5) * 2.2 : Math.random() * Math.PI * 2;
      const d = rMin + Math.random() * (Math.min(rMax, 110) - rMin);
      const x = focus.x + Math.sin(a) * d, z = focus.z + Math.cos(a) * d;
      if (Math.hypot(x - cam.position.x, z - cam.position.z) < rMin * 0.8) continue;
      if (this.tooClose(x, z, 12)) continue;
      const y = this.groundSpot(x, z);
      if (!Number.isFinite(y)) continue;
      const sparrow = Math.random() < 0.35;
      const sp = sparrow ? Sp.Sparrow : Sp.Pigeon;
      const n = sparrow ? 3 + Math.floor(Math.random() * 6) : 4 + Math.floor(Math.random() * 10);
      const g = this.groups[gi];
      g.on = true; g.sp = sp; g.x = x; g.y = y; g.z = z; g.r = sparrow ? 1.6 + Math.random() : 2.2 + Math.random() * 2;
      g.roof = false; g.flushed = false; g.calm = 0; g.checkT = Math.random() * 0.2; g.cooT = 3 + Math.random() * 8;
      g.members.length = 0;
      for (let j = 0; j < n; j++) {
        const b = this.alloc(sp, Mode.Ground);
        if (!b) break;
        b.g = gi;
        this.groundPoint(g, b);
        b.x = b.tx; b.y = b.ty; b.z = b.tz;
        b.yaw = b.tyaw = Math.random() * 6.28;
        g.members.push(b.id);
      }
      return;
    }
  }

  private spawnRoofGroup(focus: THREE.Vector3, cam: THREE.Camera, rMax: number): void {
    const gi = this.freeGroup();
    if (gi < 0) return;
    const camYaw = Math.atan2(_fwd.x, _fwd.z);
    const a = camYaw + (Math.random() - 0.5) * 2, d = 30 + Math.random() * Math.min(110, rMax - 30);
    const cx = focus.x + Math.sin(a) * d, cz = focus.z + Math.cos(a) * d;
    const refs = this.ctx.world.buildingsIn(cx - 40, cz - 40, cx + 40, cz + 40, this.refs);
    if (!refs.length) return;
    for (let k = 0; k < 5; k++) {
      const r = refs[Math.floor(Math.random() * refs.length)];
      const h = r.top - r.base;
      if (!r.alive || r.desc.roof !== 'flat' || h < 4 || h > 80) continue;
      const P = r.poly, nv = P.length / 2, e = Math.floor(Math.random() * nv);
      const ax = P[e * 2], az = P[e * 2 + 1], bx = P[((e + 1) % nv) * 2], bz = P[((e + 1) % nv) * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 3) continue;
      const ex = (bx - ax) / L, ez = (bz - az) / L;
      // Outward normal: away from the footprint's centre.
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      const ccx = (r.bounds[0] + r.bounds[2]) / 2, ccz = (r.bounds[1] + r.bounds[3]) / 2;
      let nx = ez, nz = -ex;
      if (nx * (mx - ccx) + nz * (mz - ccz) < 0) { nx = -nx; nz = -nz; }
      const x = mx - nx * 0.3, z = mz - nz * 0.3;
      if (this.tooClose(x, z, 6) || Math.hypot(x - cam.position.x, z - cam.position.z) < 10) continue;
      const nearWater = this.water.ok && Math.hypot(this.water.x - x, this.water.z - z) < 250 && Math.random() < 0.5;
      const sp = nearWater && this.night < 0.5 ? Sp.Gull : Sp.Pigeon;
      const g = this.groups[gi];
      g.on = true; g.sp = sp; g.x = x; g.y = r.top; g.z = z; g.r = Math.min(L / 2 - 0.4, 3.5);
      g.roof = true; g.ex = ex; g.ez = ez; g.nx = nx; g.nz = nz;
      g.flushed = false; g.calm = 0; g.checkT = Math.random() * 0.2; g.cooT = 6 + Math.random() * 8;
      g.members.length = 0;
      const n = sp === Sp.Gull ? 2 + Math.floor(Math.random() * 3) : 3 + Math.floor(Math.random() * 6);
      for (let j = 0; j < n; j++) {
        const b = this.alloc(sp, Mode.Ground);
        if (!b) break;
        b.g = gi;
        this.groundPoint(g, b);
        b.x = b.tx; b.y = b.ty; b.z = b.tz;
        b.yaw = b.tyaw;
        g.members.push(b.id);
      }
      return;
    }
  }

  private tooClose(x: number, z: number, r: number): boolean {
    for (const g of this.groups) if (g.on && Math.hypot(g.x - x, g.z - z) < r + g.r) return true;
    return false;
  }

  /** A spot in the group's patch (tx, ty, tz) and a heading for sitting there (tyaw). */
  private groundPoint(g: Group, b: Bird): void {
    if (g.roof) {
      const s = (Math.random() * 2 - 1) * g.r;
      b.tx = g.x + g.ex * s; b.tz = g.z + g.ez * s; b.ty = g.y;
      // Mostly looking out over the edge.
      b.tyaw = Math.atan2(g.nx, g.nz) + (Math.random() - 0.5) * 1.6;
      return;
    }
    for (let k = 0; k < 4; k++) {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * g.r;
      const x = g.x + Math.cos(a) * d, z = g.z + Math.sin(a) * d;
      const y = this.groundSpot(x, z);
      if (Number.isFinite(y) && Math.abs(y - g.y) < 0.6) { b.tx = x; b.ty = y; b.tz = z; b.tyaw = Math.random() * 6.28; return; }
    }
    b.tx = g.x; b.ty = g.y; b.tz = g.z; b.tyaw = Math.random() * 6.28;
  }

  private spawnFlock(sp: Sp, focus: THREE.Vector3): void {
    const f = this.flocks.find((q) => !q.on);
    if (!f) return;
    const star = sp === Sp.Starling;
    const a = Math.random() * Math.PI * 2, d = star ? 180 + Math.random() * 220 : 70 + Math.random() * 90;
    f.on = true; f.sp = sp; f.leave = false; f.t = Math.random() * 100;
    f.x = focus.x + Math.sin(a) * d; f.z = focus.z + Math.cos(a) * d;
    f.alt = star ? 55 + Math.random() * 45 : 22 + Math.random() * 18;
    f.y = this.ctx.terrain.height(f.x, f.z) + f.alt;
    f.hd = Math.random() * Math.PI * 2; f.vh = 0; f.speed = star ? 11 : 9;
    f.ax = star ? 19 : 7; f.ay = star ? 6 : 2.5; f.az = star ? 12 : 6;
    f.scat = 0; f.checkT = 0; f.floor = 0; f.mvx = Math.sin(f.hd) * f.speed; f.mvy = 0; f.mvz = Math.cos(f.hd) * f.speed;
    f.members.length = 0;
    const fi = this.flocks.indexOf(f);
    const n = star ? 50 + Math.floor(Math.random() * 40) : 14 + Math.floor(Math.random() * 10);
    for (let j = 0; j < n; j++) {
      const b = this.alloc(sp, Mode.Flock);
      if (!b) break;
      b.g = fi;
      // Uniform in the unit ball.
      let ox = 0, oy = 0, oz = 0;
      do { ox = Math.random() * 2 - 1; oy = Math.random() * 2 - 1; oz = Math.random() * 2 - 1; } while (ox * ox + oy * oy + oz * oz > 1);
      b.ox = ox; b.oy = oy; b.oz = oz;
      b.x = f.x + ox * f.ax; b.y = f.y + oy * f.ay; b.z = f.z + oz * f.az;
      b.vx = f.mvx; b.vz = f.mvz; b.fold = 0; b.amp = 0.8;
      b.yaw = f.hd;
      f.members.push(b.id);
    }
  }

  private findWater(focus: THREE.Vector3): void {
    const T = this.ctx.terrain;
    this.water.t = this.t;
    this.water.ok = false;
    let best = Infinity;
    for (let ring = 0; ring < 4; ring++) {
      const r = 40 + ring * 110;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + ring * 0.4;
        const x = focus.x + Math.sin(a) * r, z = focus.z + Math.cos(a) * r;
        if (!T.isWater(x, z, -4)) continue;
        if (r < best) { best = r; this.water.x = x; this.water.z = z; this.water.ok = true; }
      }
      if (this.water.ok) return;
    }
  }

  private spawnGull(focus: THREE.Vector3): void {
    const b = this.alloc(Sp.Gull, Mode.Soar);
    if (!b) return;
    const W = this.water;
    // Anchor over the water near the found point; soar in wide circles.
    b.tx = W.x + (Math.random() - 0.5) * 80; b.tz = W.z + (Math.random() - 0.5) * 80;
    b.ty = Math.max(0, this.ctx.terrain.height(b.tx, b.tz)) + 6 + Math.random() * 22;
    b.ox = 18 + Math.random() * 30; b.oy = Math.random() < 0.5 ? 1 : -1;
    const a = Math.random() * Math.PI * 2;
    // Come in from out of view range if possible.
    const far = Math.hypot(b.tx - focus.x, b.tz - focus.z) > 60;
    b.x = b.tx + Math.cos(a) * b.ox * (far ? 1 : 4); b.z = b.tz + Math.sin(a) * b.ox * (far ? 1 : 4); b.y = b.ty;
    b.vx = -Math.sin(a) * 8 * b.oy; b.vz = Math.cos(a) * 8 * b.oy;
    b.fold = 0; b.act = Math.random() * 3;
  }

  private spawnCrows(focus: THREE.Vector3): void {
    const n = Math.random() < 0.6 ? 1 : 2;
    const a = Math.random() * Math.PI * 2, R = 320;
    const off = (Math.random() - 0.5) * 120;
    const x = focus.x + Math.sin(a) * R + Math.cos(a) * off, z = focus.z + Math.cos(a) * R - Math.sin(a) * off;
    const y = this.ctx.terrain.height(x, z) + 25 + Math.random() * 30;
    for (let j = 0; j < n; j++) {
      const b = this.alloc(Sp.Crow, Mode.Cross);
      if (!b) return;
      b.x = x + j * 3; b.y = y + j; b.z = z + j * 2;
      b.vx = -Math.sin(a) * 11; b.vz = -Math.cos(a) * 11;
      b.ty = y; b.fold = 0; b.amp = 0.7; b.act = 2 + Math.random() * 3;
    }
  }

  // ------------------------------------------------------------------ ground groups

  private updateGroup(gi: number, dt: number, player: BirdPlayer | null): void {
    const g = this.groups[gi];
    if (!g.members.length) { g.on = false; return; }
    g.checkT -= dt;
    if (g.checkT > 0) { if (g.flushed) g.calm += dt; return; }
    const step = 0.12;
    g.checkT = step;
    const threat = this.threat(g, player);
    if (threat) {
      g.calm = 0;
      if (!g.flushed) this.flush(gi, this.thx, this.thz, 1);
    } else if (g.flushed) g.calm += step;
    if (!threat && !g.flushed && !g.roof) this.nudge(g);
  }

  /** Is something scary near the group? (sets thx / thz) */
  private threat(g: Group, player: BirdPlayer | null): boolean {
    if (player) {
      const p = player.pos, H = player.height;
      // A tiny player is not worth flying off for; giants and fliers are.
      if (H > 0.35) {
        const sp = Math.hypot(player.vel.x, player.vel.z);
        const r = Math.min(160, 1.2 + H * 1.4 + sp * 0.45 + (player.flying ? 6 + H : 0));
        const dy = g.y - (p.y + H * 0.5);
        if (Math.hypot(p.x - g.x, p.z - g.z, Math.max(0, Math.abs(dy) - H)) < r + g.r) { this.thx = p.x; this.thz = p.z; return true; }
      }
    }
    if (!g.roof) {
      // Running people (or anyone fleeing) and cars.
      for (const a of this.ctx.peds.neighbours(g.x, g.z, g.r + 4, this.pedsNear)) {
        if (a.inside || a.state === 5) continue;
        if ((a.speed > 2.3 || a.state === 4) && Math.hypot(a.x - g.x, a.z - g.z) < g.r + 3.5) { this.thx = a.x; this.thz = a.z; return true; }
      }
      for (const v of this.ctx.traffic.vehicles) {
        const dx = v.x - g.x, dz = v.z - g.z, r = g.r + 3 + v.length * 0.5;
        if (dx * dx + dz * dz < r * r && v.speed > 1.5 && Math.abs(v.y - g.y) < 3) { this.thx = v.x; this.thz = v.z; return true; }
      }
    }
    for (const d of this.ctx.drones.list) {
      const dx = d.x - g.x, dy = d.y - g.y, dz = d.z - g.z, r = g.r + 9;
      if (dx * dx + dy * dy + dz * dz < r * r) { this.thx = d.x; this.thz = d.z; return true; }
    }
    return false;
  }

  /** Walkers passing right through a calm street group: the nearest birds hop-flutter aside. */
  private nudge(g: Group): void {
    const near = this.ctx.peds.neighbours(g.x, g.z, g.r + 1, this.pedsNear);
    if (!near.length) return;
    for (const a of near) {
      if (a.inside || a.speed < 0.3) continue;
      for (const i of g.members) {
        const b = this.birds[i];
        if (b.mode !== Mode.Ground) continue;
        const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
        if (d > 0.8) continue;
        // A short flutter 1.5-3 m away from the walker, back down in the patch.
        const ux = d > 1e-3 ? dx / d : 1, uz = d > 1e-3 ? dz / d : 0;
        const s = 1.5 + Math.random() * 1.5;
        const tx = b.x + ux * s, tz = b.z + uz * s;
        const ty = this.groundSpot(tx, tz);
        if (!Number.isFinite(ty)) continue;
        b.tx = tx; b.ty = ty; b.tz = tz; b.tyaw = Math.atan2(ux, uz);
        b.mode = Mode.Land; b.t = 0;
        b.vx = ux * 2.5; b.vz = uz * 2.5; b.vy = 2.6;
        b.hop = -1; b.peck = 0;
      }
    }
  }

  /** Everyone up: away from (fx, fz), circle, land again when it is calm (strength scales the time aloft). */
  private flush(gi: number, fx: number, fz: number, strength: number): void {
    const g = this.groups[gi];
    if (g.flushed) { g.calm = 0; return; }
    g.flushed = true; g.calm = 0;
    this.stats.flushes++;
    let ux = g.x - fx, uz = g.z - fz;
    const d = Math.hypot(ux, uz);
    if (d > 1e-3) { ux /= d; uz /= d; } else { const a = Math.random() * 6.28; ux = Math.cos(a); uz = Math.sin(a); }
    // Circle off to the side of the threat, above the rooftops if on a roof.
    g.cx = g.x + ux * 10; g.cz = g.z + uz * 10;
    g.cy = g.y + (g.roof ? 8 : 7) + Math.random() * 6;
    const b0 = this.ctx.world.buildingAt(g.cx, g.cz);
    if (b0) g.cy = Math.max(g.cy, b0.top + 6);
    // A new patch a little way off (street groups); roof birds come back to their ledge.
    if (!g.roof) {
      for (let k = 0; k < 5; k++) {
        const a = Math.atan2(ux, uz) + (Math.random() - 0.5) * 2, s = 8 + Math.random() * 20;
        const x = g.x + Math.sin(a) * s, z = g.z + Math.cos(a) * s;
        const y = this.groundSpot(x, z);
        if (Number.isFinite(y)) { g.x = x; g.y = y; g.z = z; break; }
      }
    }
    const S = SPECIES[g.sp];
    for (const i of g.members) {
      const b = this.birds[i];
      if (b.mode !== Mode.Ground && b.mode !== Mode.Land) continue;
      b.mode = Mode.Air;
      b.t = (3 + Math.random() * 6) * strength;
      const a = Math.atan2(ux, uz) + (Math.random() - 0.5) * 1.6;
      const sp = 2 + Math.random() * 2.5;
      b.vx = Math.sin(a) * sp; b.vz = Math.cos(a) * sp; b.vy = 3.5 + Math.random() * 2.5;
      b.fold = 0; b.hz = S.hz * 1.5; b.amp = 1.1;
      b.hop = -1; b.peck = 0;
    }
    const n = g.members.length;
    this.ctx.sound('bird_flutter', g.x, g.y + 0.5, g.z, Math.min(1, 0.35 + n * 0.06) * (g.sp === Sp.Sparrow ? 0.6 : 1), g.sp === Sp.Sparrow ? 1.35 : 0.9 + Math.random() * 0.2, 5);
  }

  // ------------------------------------------------------------------ birds

  private stepGround(b: Bird, dt: number): void {
    const g = b.g >= 0 ? this.groups[b.g] : null;
    const roost = this.night > 0.6;
    b.fold = Math.min(1, b.fold + dt * 4);
    b.amp = 0;
    b.roll *= 0.8;
    if (b.hop >= 0) {
      b.hop = Math.min(1, b.hop + dt / b.hopT);
      const u = b.hop;
      b.x = b.x0 + (b.x1 - b.x0) * u; b.z = b.z0 + (b.z1 - b.z0) * u;
      if (b.sp === Sp.Sparrow) {
        b.y = b.y0 + (b.y1 - b.y0) * u + Math.sin(u * Math.PI) * 0.07;
        b.pitch = -0.2 * Math.sin(u * Math.PI);
      } else {
        // Pigeon walk: a quick nod with every step (~4 steps a second).
        const steps = b.hopT * 4;
        b.y = b.y0 + (b.y1 - b.y0) * u + Math.abs(Math.sin(u * steps * Math.PI)) * 0.008;
        b.pitch = 0.22 * Math.max(0, Math.sin(u * steps * Math.PI * 2));
      }
      if (b.hop >= 1) { b.hop = -1; b.pitch = 0; }
    } else if (b.peck > 0) {
      b.peck -= dt;
      b.pitch = 0.75 * Math.max(0, Math.sin(b.peck * 16));
    } else b.pitch *= 0.85;
    b.yaw += angleDiff(b.tyaw, b.yaw) * Math.min(1, dt * 8);
    b.act -= dt;
    if (b.act > 0 || b.hop >= 0 || !g) return;
    const r = Math.random();
    if (roost || g.roof) {
      // Sitting: now and then a shuffle along the ledge or a look round.
      if (!roost && r < 0.15) this.startWalk(b, g);
      else b.tyaw += (Math.random() - 0.5) * (roost ? 0.3 : 1.2);
      b.act = (roost ? 4 : 1.5) + Math.random() * 4;
    } else if (r < 0.45) {
      b.peck = 0.35 + Math.random() * 0.9;
      b.act = b.peck + 0.2 + Math.random() * 0.6;
    } else if (r < 0.85) this.startWalk(b, g);
    else {
      b.tyaw += (Math.random() - 0.5) * 2;
      b.act = 0.4 + Math.random() * 1.5;
    }
  }

  private startWalk(b: Bird, g: Group): void {
    // Sparrows hop a little way; pigeons walk somewhere in the patch.
    if (b.sp === Sp.Sparrow) {
      const a = Math.random() < 0.5 ? b.yaw : Math.random() * 6.28, s = 0.12 + Math.random() * 0.25;
      let x = b.x + Math.sin(a) * s, z = b.z + Math.cos(a) * s;
      if (Math.hypot(x - g.x, z - g.z) > g.r) { x = b.x + (g.x - b.x) * 0.2; z = b.z + (g.z - b.z) * 0.2; }
      b.x1 = x; b.z1 = z; b.y1 = b.y; b.hopT = 0.18;
      b.act = 0.2 + (Math.random() < 0.6 ? 0.05 : 0.5 + Math.random());
    } else {
      this.groundPoint(g, b);
      const s = Math.hypot(b.tx - b.x, b.tz - b.z);
      if (s > 1.5) { const k = 1.5 / s; b.tx = b.x + (b.tx - b.x) * k; b.tz = b.z + (b.tz - b.z) * k; b.ty = g.roof ? g.y : this.groundSpot(b.tx, b.tz); }
      if (!Number.isFinite(b.ty)) return;
      b.x1 = b.tx; b.z1 = b.tz; b.y1 = b.ty;
      b.hopT = Math.max(0.3, Math.hypot(b.x1 - b.x, b.z1 - b.z) / 0.45);
      b.act = b.hopT + 0.2 + Math.random();
    }
    b.x0 = b.x; b.y0 = b.y; b.z0 = b.z;
    b.tyaw = Math.atan2(b.x1 - b.x, b.z1 - b.z);
    b.hop = 0;
  }

  /** Flushed: climb out, circle the group's centre, then come in to land once it is calm. */
  private stepAir(b: Bird, dt: number): void {
    const S = SPECIES[b.sp];
    const g = b.g >= 0 ? this.groups[b.g] : null;
    b.t -= dt;
    if (!g) { this.flee(b); return; }
    const dx = b.x - g.cx, dz = b.z - g.cz;
    const a = Math.atan2(dz, dx) + 0.6;
    const R = g.roof ? 9 : 7;
    let tx = g.cx + Math.cos(a) * R - b.x, ty = g.cy + Math.sin(this.t * 0.8 + b.ox * 6) * 1.5 - b.y, tz = g.cz + Math.sin(a) * R - b.z;
    const L = Math.hypot(tx, ty, tz) || 1;
    const sp = S.speed * 0.85;
    tx = (tx / L) * sp; ty = (ty / L) * sp * 0.6; tz = (tz / L) * sp;
    this.steer(b, tx, ty, tz, 2.2, dt);
    this.avoid(b, dt);
    // Climbing: fast beats; level circling: slower, with short glides.
    b.amp = b.vy > 0.5 ? 1.1 : (Math.sin(b.t * 1.7 + b.ox * 9) > 0.6 ? 0.08 : 0.85);
    b.hz = S.hz * (b.vy > 0.5 ? 1.4 : 1);
    b.bias = b.amp < 0.2 ? 0.15 : 0;
    this.move(b, dt);
    if (b.t <= 0) {
      if (g.calm > 2.5) {
        this.groundPoint(g, b);
        b.mode = Mode.Land; b.t = 0;
      } else b.t = 1 + Math.random();
    }
  }

  /** Coming in to land on (tx, ty, tz): descend on a glide slope, flare, settle. */
  private stepLand(b: Bird, dt: number): void {
    const S = SPECIES[b.sp];
    b.t += dt;
    const dx = b.tx - b.x, dz = b.tz - b.z, dh = Math.hypot(dx, dz);
    const dy = b.ty - b.y;
    const d = Math.hypot(dh, dy);
    if (d < 0.12 || b.t > 14) {
      b.x = b.tx; b.y = b.ty; b.z = b.tz;
      b.vx = b.vy = b.vz = 0;
      b.mode = Mode.Ground; b.hop = -1; b.pitch = 0; b.roll = 0;
      b.act = 0.3 + Math.random();
      b.hz = S.hz;
      return;
    }
    const sp = Math.min(S.speed * 0.8, 0.6 + d * 0.9);
    // Approach from a little above: aim for a point over the spot while far.
    const over = Math.min(4, dh * 0.35);
    const ty = dy + over;
    const L = Math.hypot(dx, ty, dz) || 1;
    this.steer(b, (dx / L) * sp, (ty / L) * sp, (dz / L) * sp, d < 3 ? 6 : 3, dt);
    if (dh > 6) this.avoid(b, dt);
    this.move(b, dt);
    const flare = d < 2.5;
    b.amp = flare ? 1.2 : 0.7;
    b.hz = S.hz * (flare ? 1.5 : 1);
    if (flare) b.pitch = Math.max(-0.7, b.pitch - dt * 3);
  }

  private stepFlock(b: Bird, _i: number, dt: number, player: BirdPlayer | null): void {
    const f = this.flocks[b.g];
    if (!f || !f.on) { this.flee(b); return; }
    const S = SPECIES[b.sp];
    const t = f.t;
    // Offset in the deforming, rippling shape (rotated with the flock's heading).
    const ox = b.ox + 0.22 * Math.sin(t * 1.3 + b.oz * 3.1);
    const oy = b.oy + 0.3 * Math.sin(t * 0.9 + b.ox * 4.2);
    const oz = b.oz + 0.22 * Math.sin(t * 1.1 + b.ox * 2.7);
    const lx = ox * f.ax * (1 + 0.35 * Math.sin(t * 0.31)), ly = oy * f.ay * (1 + 0.4 * Math.sin(t * 0.47 + 1)), lz = oz * f.az * (1 + 0.4 * Math.sin(t * 0.23 + 2));
    const rot = f.hd + 0.7 * Math.sin(t * 0.13);
    const c = Math.cos(rot), s = Math.sin(rot);
    const px = f.x + lx * c + lz * s, py = f.y + ly, pz = f.z - lx * s + lz * c;
    let vx = f.mvx + (px - b.x) * 0.7, vy = f.mvy + (py - b.y) * 0.7, vz = f.mvz + (pz - b.z) * 0.7;
    if (f.scat > 0.01) {
      const ux = b.x - f.sx, uy = b.y - f.sy, uz = b.z - f.sz, d = Math.hypot(ux, uy, uz) || 1;
      const k = (f.scat * 22) / (1 + d / 25);
      vx += (ux / d) * k; vy += (uy / d) * k * 0.6; vz += (uz / d) * k;
    }
    if (player) { const r = this.repel(b, player); vx += this.rvx * r; vy += this.rvy * r; vz += this.rvz * r; }
    const L = Math.hypot(vx, vy, vz);
    const vmax = S.speed * 1.6, vmin = S.speed * 0.6;
    const k = L > vmax ? vmax / L : L < vmin && L > 1e-3 ? vmin / L : 1;
    this.steer(b, vx * k, vy * k, vz * k, 2.8, dt);
    this.move(b, dt);
    b.fold = 0;
    // Starlings beat fast with glides in between; pigeons clap round in slow circles.
    const glide = Math.sin(t * 0.9 + b.ox * 5 + b.oz * 3) > 0.55;
    b.amp = glide ? 0.12 : 0.85;
    b.bias = glide ? 0.12 : 0;
  }

  private stepSoar(b: Bird, _i: number, dt: number, player: BirdPlayer | null): void {
    const S = SPECIES[b.sp];
    // Leave at night / when the water is far.
    const away = this.night > 0.7 || !this.water.ok || Math.hypot(b.tx - this.fx, b.tz - this.fz) > 600;
    if (away) { this.flee(b); return; }
    // Wide circles round the anchor that drifts slowly; height holds in the updraft.
    b.tx += Math.sin(this.t * 0.05 + b.ox) * dt * 1.5;
    const dx = b.x - b.tx, dz = b.z - b.tz;
    const a = Math.atan2(dz, dx) + 0.35 * b.oy;
    let vx = b.tx + Math.cos(a) * b.ox - b.x, vz = b.tz + Math.sin(a) * b.ox - b.z;
    const L = Math.hypot(vx, vz) || 1;
    vx = (vx / L) * S.speed; vz = (vz / L) * S.speed;
    let vy = clamp((b.ty - b.y) * 0.3, -1.5, 1.5);
    if (player) { const r = this.repel(b, player); vx += this.rvx * r; vy += this.rvy * r; vz += this.rvz * r; }
    this.steer(b, vx, vy, vz, 1.2, dt);
    this.avoid(b, dt);
    this.move(b, dt);
    // Mostly gliding (wings slightly up, tips down); a bout of slow flaps now and then.
    b.act -= dt;
    if (b.act < -2 - (b.ox % 3)) b.act = 1 + Math.random() * 1.5;
    const flap = b.act > 0;
    b.amp = flap ? 0.65 : 0.03;
    b.bias = flap ? 0 : 0.14;
    b.fold = 0;
  }

  private stepCross(b: Bird, _i: number, dt: number, player: BirdPlayer | null): void {
    const S = SPECIES[b.sp];
    if (Math.hypot(b.x - this.fx, b.z - this.fz) > 480) { this.release(b.id); return; }
    const L = Math.hypot(b.vx, b.vz) || 1;
    let vx = (b.vx / L) * S.speed, vz = (b.vz / L) * S.speed;
    let vy = clamp((b.ty - b.y) * 0.5, -2, 3);
    if (player) { const r = this.repel(b, player); vx += this.rvx * r; vy += this.rvy * r; vz += this.rvz * r; }
    this.steer(b, vx, vy, vz, 1.5, dt);
    // Look ahead for towers and climb over them.
    const B = this.ctx.world.buildingAt(b.x + b.vx * 2, b.z + b.vz * 2);
    if (B && b.ty < B.top + 6) b.ty = B.top + 8;
    this.avoid(b, dt);
    this.move(b, dt);
    b.act -= dt;
    if (b.act < -1.2) b.act = 2 + Math.random() * 3;
    b.amp = b.act > 0 ? 0.7 : 0.05;
    b.bias = b.act > 0 ? 0 : 0.08;
    b.fold = 0;
  }

  /** Knocked: fall and spin for a moment, then flap away. */
  private stepTumble(b: Bird, dt: number): void {
    b.t -= dt;
    b.vy -= GRAV * dt;
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
    b.roll += dt * 14; b.pitch += dt * 9;
    b.amp = 1.2; b.hz = 13; b.fold = 0;
    const gnd = this.ctx.terrain.height(b.x, b.z) + 0.15;
    if (b.y < gnd) { b.y = gnd; b.vy = Math.abs(b.vy) * 0.3; b.vx *= 0.5; b.vz *= 0.5; }
    if (b.t <= 0) {
      b.roll = 0; b.pitch = 0;
      this.flee(b);
    }
  }

  /** Leave: fly off and away from the focus; despawn when far. */
  private flee(b: Bird): void {
    if (b.g >= 0 && (b.mode === Mode.Ground || b.mode === Mode.Air || b.mode === Mode.Land || b.mode === Mode.Tumble)) this.leaveGroup(b);
    b.g = -1;
    b.mode = Mode.Cross;
    let ux = b.x - this.fx, uz = b.z - this.fz;
    const d = Math.hypot(ux, uz);
    if (d > 1e-3) { ux /= d; uz /= d; } else { ux = 1; uz = 0; }
    b.vx = ux * 6 + b.vx * 0.3; b.vz = uz * 6 + b.vz * 0.3; b.vy = Math.max(b.vy, 2);
    b.ty = Math.max(b.y + 15, this.ctx.terrain.height(b.x, b.z) + 30);
    b.act = 3;
    b.hz = SPECIES[b.sp].hz * 1.3;
  }

  private leaveGroup(b: Bird): void {
    const i = b.id;
    const g = this.groups[b.g];
    if (!g) return;
    const k = g.members.indexOf(i);
    if (k >= 0) { g.members[k] = g.members[g.members.length - 1]; g.members.pop(); }
  }

  // ------------------------------------------------------------------ flocks

  private updateFlock(f: Flock, dt: number, player: BirdPlayer | null): void {
    f.t += dt;
    if (!f.members.length) { f.on = false; return; }
    // A giant or a flier in the flock: it bursts apart around them and the flock turns away.
    if (player && (player.flying || player.height >= 4)) {
      const H = player.height, py = player.pos.y + H * 0.5;
      const ux = f.x - player.pos.x, uz = f.z - player.pos.z;
      const d = Math.hypot(ux, f.y - py, uz);
      if (d < f.ax * 1.5 + 6 + H) {
        f.scat = Math.max(f.scat, 0.8);
        f.sx = player.pos.x; f.sy = py; f.sz = player.pos.z;
        f.hd += angleDiff(Math.atan2(ux, uz), f.hd) * Math.min(1, dt * 1.5);
      }
    }
    const T = this.ctx.terrain;
    const dx = this.fx - f.x, dz = this.fz - f.z, d = Math.hypot(dx, dz);
    if (f.leave) {
      // Off and away (night falling, too many): straight out, then gone.
      const want = Math.atan2(-dx, -dz);
      f.hd += angleDiff(want, f.hd) * Math.min(1, dt * 0.5);
      f.alt += dt * 2;
      f.speed = Math.min(16, f.speed + dt);
      if (d > 650) { for (const i of f.members) this.release(i); f.members.length = 0; f.on = false; return; }
    } else {
      // Wander, but keep within view range of the focus.
      const star = f.sp === Sp.Starling;
      f.vh += (Math.sin(f.t * 0.21) * 0.25 + Math.sin(f.t * 0.067 + 1) * 0.2 - f.vh) * Math.min(1, dt);
      let turn = f.vh * (star ? 1 : 2.2);
      const R = star ? 330 : 140;
      if (d > R) turn += angleDiff(Math.atan2(dx, dz), f.hd) * 0.6;
      f.hd += turn * dt;
    }
    f.checkT -= dt;
    if (f.checkT <= 0) {
      f.checkT = 0.4;
      // Over the skyline: look ahead and below for the tallest roof.
      const lx = f.x + Math.sin(f.hd) * 50, lz = f.z + Math.cos(f.hd) * 50;
      let top = Math.max(T.height(lx, lz), T.height(f.x, f.z));
      const b1 = this.ctx.world.buildingAt(f.x, f.z), b2 = this.ctx.world.buildingAt(lx, lz);
      if (b1) top = Math.max(top, b1.top);
      if (b2) top = Math.max(top, b2.top);
      f.floor = top + f.ay + 15;
    }
    const ty = Math.max(f.floor, T.height(f.x, f.z) + f.alt);
    const vy = clamp((ty - f.y) * 0.5, -3, 6);
    f.y += vy * dt;
    const vx = Math.sin(f.hd) * f.speed, vz = Math.cos(f.hd) * f.speed;
    f.x += vx * dt; f.z += vz * dt;
    f.mvx = vx; f.mvy = vy; f.mvz = vz;
    f.scat = Math.max(0, f.scat - dt * 0.35);
  }

  // ------------------------------------------------------------------ motion helpers

  /** Accelerate towards a desired velocity (rate 1/s); bank and pitch from the motion. */
  private steer(b: Bird, vx: number, vy: number, vz: number, rate: number, dt: number): void {
    const k = Math.min(1, rate * dt);
    const ax = (vx - b.vx) * k, ay = (vy - b.vy) * k, az = (vz - b.vz) * k;
    b.vx += ax; b.vy += ay; b.vz += az;
    const h = Math.hypot(b.vx, b.vz);
    if (h > 0.2) b.yaw = Math.atan2(b.vx, b.vz);
    b.pitch += (-Math.atan2(b.vy, Math.max(0.5, h)) * 0.8 - b.pitch) * Math.min(1, dt * 5);
    // Bank into the turn: lateral acceleration over g.
    const lat = h > 0.5 ? (ax * b.vz - az * b.vx) / h / Math.max(dt, 1e-3) : 0;
    const roll = clamp(-lat / GRAV, -1.1, 1.1);
    b.roll += (roll - b.roll) * Math.min(1, dt * 4);
  }

  private move(b: Bird, dt: number): void {
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
  }

  /** Keep out of buildings and off the ground (cheap: one footprint lookup ahead). */
  private avoid(b: Bird, dt: number): void {
    const B = this.ctx.world.buildingAt(b.x + b.vx * 0.8, b.z + b.vz * 0.8);
    if (B && b.y < B.top + 2 && b.y > B.low - 1) {
      b.vy += 14 * dt;
      b.vx *= 1 - Math.min(1, dt * 3); b.vz *= 1 - Math.min(1, dt * 3);
      if (b.y < B.top - 1) {
        // Inside the prism already (spawned or pushed there): pop up to the roof.
        const here = this.ctx.world.buildingAt(b.x, b.z);
        if (here && b.y < here.top) b.y = Math.min(here.top + 0.5, b.y + dt * 8);
      }
    }
    const gnd = this.ctx.terrain.height(b.x, b.z) + 1.5;
    if (b.y < gnd && b.mode !== Mode.Land) b.vy += (gnd - b.y) * 6 * dt;
  }

  private rvx = 0;
  private rvy = 0;
  private rvz = 0;

  /** Push away from a giant or a flying player (direction in rv*, returns the strength). */
  private repel(b: Bird, p: BirdPlayer): number {
    const H = p.height;
    if (!p.flying && H < 4) return 0;
    const cy = p.pos.y + H * 0.5;
    const dx = b.x - p.pos.x, dy = b.y - cy, dz = b.z - p.pos.z;
    const R = 4 + H * 1.2 + Math.hypot(p.vel.x, p.vel.y, p.vel.z) * 0.4;
    const d = Math.hypot(dx, dy * 0.7, dz);
    if (d > R || d < 1e-3) return 0;
    this.rvx = dx / d; this.rvy = dy / d + 0.3; this.rvz = dz / d;
    return (1 - d / R) * 30;
  }

  /** A giant's body or a flying player hitting a bird in the air knocks it out of its flight. */
  private swat(b: Bird, p: BirdPlayer): void {
    const ox = b.x - p.pos.x, oz = b.z - p.pos.z;
    const rr = p.radius + 0.3 * Math.max(1, p.height * 0.1);
    if (ox * ox + oz * oz > rr * rr || b.y < p.pos.y - 0.2 || b.y > p.pos.y + p.height + 0.2) return;
    const sp = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
    if (sp < 1 && p.height < 3) return;
    this.knock(b, p.vel.x + ox * 3, p.vel.y + 2, p.vel.z + oz * 3);
  }

  /** A direct hit: feathers fly, the bird tumbles and then flees. */
  private knock(b: Bird, vx: number, vy: number, vz: number): void {
    if (b.mode === Mode.Tumble) return;
    if (b.g >= 0 && (b.mode === Mode.Ground || b.mode === Mode.Air || b.mode === Mode.Land)) {
      const g = this.groups[b.g];
      this.leaveGroup(b);
      if (g && g.on && !g.flushed) this.flush(b.g, b.x, b.z, 1.4);
    }
    b.g = -1;
    b.mode = Mode.Tumble;
    b.t = 0.5 + Math.random() * 0.4;
    const L = Math.hypot(vx, vy, vz), k = L > 12 ? 12 / L : 1;
    b.vx = vx * k; b.vy = Math.max(1, vy * k); b.vz = vz * k;
    this.stats.hits++;
    this.feathers(b);
  }

  private feathers(b: Bird): void {
    const S = SPECIES[b.sp];
    const big = b.sp === Sp.Gull || b.sp === Sp.Crow ? 1.4 : b.sp === Sp.Sparrow ? 0.6 : 1;
    _col.copy(S.wing).lerp(S.body, 0.5).lerp(_white, 0.4);
    this.ctx.dust.burst(b.x, b.y, b.z, Math.round(8 * big), 0.25 * big, 1.2, 0.06 * big, 1.8, _col, -0.05, 0.75);
    this.ctx.debris.chipBurst(b.x, b.y, b.z, Math.round(12 * big), 1.6, 0, 0.6, 0, _col, 0.045 * big, 2.5);
    if (this.t - this.featherSound > 0.25) { this.featherSound = this.t; this.ctx.sound('bird_flutter', b.x, b.y, b.z, 0.5, 1.3, 3); }
  }

  // ------------------------------------------------------------------ events

  private onStimulus(s: Stimulus): void {
    const cap = SCARE[s.kind];
    if (cap === undefined) return;
    const r = Math.min(s.radius, cap);
    for (let i = 0; i < GROUP_CAP; i++) {
      const g = this.groups[i];
      if (!g.on) continue;
      if (Math.hypot(g.x - s.x, g.z - s.z) < r) this.flush(i, s.x, s.z, s.kind === 'horn' || s.kind === 'scream' ? 0.7 : 1.3);
    }
    if (s.kind === 'blast' || s.kind === 'collapse' || s.kind === 'sonic' || s.kind === 'giant' || s.kind === 'stomp' || s.kind === 'impact' || s.kind === 'roar' || s.kind === 'tremor') {
      const fr = s.kind === 'impact' ? Math.min(r, 60) : r * 1.5;
      for (const f of this.flocks) {
        if (!f.on || Math.hypot(f.x - s.x, f.z - s.z) > fr + f.ax) continue;
        f.scat = Math.min(1, f.scat + (s.kind === 'impact' || s.kind === 'stomp' ? 0.4 : 1));
        f.sx = s.x; f.sy = s.y; f.sz = s.z;
      }
    }
    // A blast knocks birds near it out of the air.
    if (s.kind === 'blast') {
      for (const b of this.birds) {
        if (!b.on) continue;
        const dx = b.x - s.x, dy = b.y - s.y, dz = b.z - s.z, d = Math.hypot(dx, dy, dz);
        if (d < 8 && d > 1e-3) this.knock(b, (dx / d) * 10, (dy / d) * 10 + 3, (dz / d) * 10);
      }
    }
  }

  /** A physical strike (punch, swat, power, thrown thing): direct hits and frightened neighbours. */
  hit(x: number, y: number, z: number, r: number, jx: number, jy: number, jz: number): void {
    const J = Math.hypot(jx, jy, jz);
    const ux = J > 1e-6 ? jx / J : 0, uy = J > 1e-6 ? jy / J : 0, uz = J > 1e-6 ? jz / J : 0;
    for (let i = 0; i < CAP; i++) {
      const b = this.birds[i];
      if (!b.on) continue;
      const d = Math.hypot(b.x - x, b.y - y, b.z - z);
      if (d < r + 0.4) {
        const sp = Math.min(12, 3 + J / 300);
        this.knock(b, ux * sp + (b.x - x) * 2, uy * sp + 2, uz * sp + (b.z - z) * 2);
      }
    }
    const fr = r * 3 + 4;
    for (let i = 0; i < GROUP_CAP; i++) {
      const g = this.groups[i];
      if (g.on && Math.hypot(g.x - x, g.z - z) < fr + g.r) this.flush(i, x, z, 1.2);
    }
    for (const f of this.flocks) {
      if (!f.on || Math.hypot(f.x - x, f.y - y, f.z - z) > fr + f.ax) continue;
      f.scat = Math.min(1, f.scat + 0.6); f.sx = x; f.sy = y; f.sz = z;
    }
  }

  // ------------------------------------------------------------------ sound

  /** Now and then: a coo from a pigeon group nearby, a gull's call, a crow's caw. */
  private calls(dt: number, cam: THREE.Camera): void {
    this.callT -= dt;
    if (this.callT > 0) return;
    this.callT = 1.2 + Math.random() * 2;
    const c = cam.position;
    if (this.night > 0.6) return;
    const pick = Math.floor(Math.random() * CAP);
    for (let k = 0; k < CAP; k++) {
      const b = this.birds[(pick + k) % CAP];
      if (!b.on) continue;
      const d = Math.hypot(b.x - c.x, b.y - c.y, b.z - c.z);
      if (b.sp === Sp.Pigeon && b.mode === Mode.Ground && d < 22 && Math.random() < 0.35) {
        this.ctx.sound('pigeon_coo', b.x, b.y + 0.2, b.z, 0.55, 0.9 + Math.random() * 0.2, 2.5);
        return;
      }
      if (b.sp === Sp.Gull && d < 140 && Math.random() < 0.3) {
        this.ctx.sound('gull_call', b.x, b.y, b.z, 0.6, 0.9 + Math.random() * 0.25, 18);
        return;
      }
      if (b.sp === Sp.Crow && d < 160 && Math.random() < 0.25) {
        this.ctx.sound('crow_caw', b.x, b.y, b.z, 0.6, 0.92 + Math.random() * 0.15, 16);
        return;
      }
    }
  }

  // ------------------------------------------------------------------ render

  private draw(cam: THREE.PerspectiveCamera): void {
    const c = cam.position;
    // ~2 px of body length at least (vertical fov, CSS pixels).
    const h = typeof window !== 'undefined' ? window.innerHeight : 720;
    this.uniforms.uBirdPx.value = ((2 * Math.tan((cam.fov * Math.PI) / 360)) / Math.max(200, h)) * 2.2;
    const A = this.anim.array as Float32Array, CA = this.colA.array as Float32Array, CB = this.colB.array as Float32Array, SA = this.span.array as Float32Array;
    let n = 0;
    for (let i = 0; i < CAP; i++) {
      const b = this.birds[i];
      if (!b.on) continue;
      const dx = b.x - c.x, dy = b.y - c.y, dz = b.z - c.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const lim = b.mode === Mode.Ground ? GROUND_DRAW_R : DRAW_R;
      if (d2 > lim * lim) continue;
      // Behind the camera: skip (a little margin for the wings).
      if (dx * _fwd.x + dy * _fwd.y + dz * _fwd.z < -2) continue;
      const S = SPECIES[b.sp];
      const L = S.len * b.size;
      _e.set(b.pitch, b.yaw, b.roll);
      _q.setFromEuler(_e);
      _p.set(b.x, b.y + (b.mode === Mode.Ground ? L * 0.18 : 0), b.z);
      _s.set(L, L, L);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(n, _m);
      const o = n * 4;
      A[o] = b.phase; A[o + 1] = b.amp; A[o + 2] = b.fold; A[o + 3] = b.bias;
      CA[o] = S.body.r; CA[o + 1] = S.body.g; CA[o + 2] = S.body.b; CA[o + 3] = 1;
      SA[n * 2] = S.span; SA[n * 2 + 1] = S.beak;
      CB[o] = S.wing.r; CB[o + 1] = S.wing.g; CB[o + 2] = S.wing.b; CB[o + 3] = S.tip;
      n++;
    }
    this.mesh.count = n;
    this.stats.drawn = n;
    if (n) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.anim.needsUpdate = true;
      this.colA.needsUpdate = true;
      this.colB.needsUpdate = true;
      this.span.needsUpdate = true;
    }
  }
}

function angleDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
