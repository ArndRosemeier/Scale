/**
 * Quadcopter drones over the streets: parcel deliveries (fly in at a cruise altitude of
 * 25–60 m, descend in front of a door or onto a flat roof, winch the parcel down, climb and
 * leave), news drones that gather over collapses and police drones that circle crashes.
 *
 * Routes keep to lanes by heading and are planned round towers on a coarse grid (skyPath);
 * only when there is no way round within a wide search area do they climb over the top.
 * Flight is a simple kinematic model: arrival steering with acceleration limits (climb and
 * sink rates capped), boids-like separation, a climb when a low building is ahead; the attitude follows the horizontal
 * acceleration (a quadcopter tilts into the direction it accelerates), yaw turns smoothly
 * into the flight direction. Rotors spin (separate instanced mesh), nav lights and the
 * anti-collision strobe blink. A swat (any strike near it) or a giant's body knocks a drone
 * out of the sky: it becomes a Rapier body and breaks on impact.
 */
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { Rng, deriveSeed } from '../core/rng';
import { doorOf } from '../sim/Population';
import type { BuildingRef } from '../world/WorldIndex';
import { FurnBatch } from './batch';
import { droneGeometry, rotorGeometry, parcelGeometry, DRONE, DRONE_MOTORS } from './models';
import { FLEETS, type FutureCtx, type PlayerProbe } from './ctx';
import { NavGlows } from './NavGlows';
import { planAround } from './skyPath';
import { glanceAt, gawkAt } from './attention';
import type { LocalGround } from './ground';
import { GROUPS } from '../physics/Physics';
import { statusOf } from '../shared/status';
import { malLed, MAL_KEEP_R, ROGUE_RED, type Malfunction, type MalfunctionCtl } from './malfunction';

export const enum DKind { Delivery = 0, News = 1, Police = 2 }
export const enum DState { Fly = 0, Fall = 1, Down = 2 }

export interface Wp { x: number; y: number; z: number; r: number; hold: number; drop?: boolean }

export interface Drone {
  id: number;
  kind: DKind;
  fleet: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  yaw: number;
  up: THREE.Vector3;
  q: THREE.Quaternion;
  plan: Wp[];
  pi: number;
  /** Index of the drop waypoint (-9: none). */
  drop: number;
  holdT: number;
  /** Parcel aboard (0 none, 1 carried; winch length in m while lowering). */
  parcel: number;
  winch: number;
  orbit: { x: number; z: number; y: number; r: number; until: number; dir: number } | null;
  rotor: number;
  phase: number;
  state: DState;
  stateT: number;
  body: RAPIER.RigidBody | null;
  lastSpeed: number;
  broken: boolean;
  alive: boolean;
  /** Seconds to the next look round for people below (glances). */
  lookT: number;
  /** Glitching or gone rogue (a threat): its plan is set by the malfunction controller. */
  mal?: Malfunction;
}

const MAX_DRONES = 60;
const SPAWN_R = [260, 420];
const DESPAWN_R = 560;
const DRAW_R = 520;
const VMAX = 13;
const AMAX = 3.5;
/** Climb / sink rate limits (m/s). */
const VUP = 5;
const VDOWN = 4;
/** A hostile drone flies harder: speed, acceleration and sink rate × this. */
const RAGE = 1.6;

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _Y = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();


/** Seconds a delivered parcel stays where the winch set it down before it is taken in. */
const PARCEL_STAY = 3;
export class Drones {
  readonly group = new THREE.Group();
  readonly list: Drone[] = [];
  private bodyB: FurnBatch[];
  private rotorB: FurnBatch;
  private parcelB: FurnBatch;
  private tetherB: FurnBatch;
  private glows = new NavGlows(MAX_DRONES * 3 + 48);
  private rng: Rng;
  private nextId = 1;
  private t = 0;
  private spawnT = 0;
  private target = 0;
  private scanT = -10;
  private dests: BuildingRef[] = [];
  /** Parcels just set down at doors / on roofs (gone after PARCEL_STAY s): x, y, z, yaw, time. */
  private dropped: number[] = [];
  stats = { drones: 0, target: 0, drawn: 0, swatted: 0, news: 0, police: 0, legs: 0, raised: 0, overTop: 0 };
  /** Exact ground and walls for falling drones (set by NearFuture). */
  ground: LocalGround | null = null;
  /** Plans malfunctioning drones' flights (the threat layer; set by NearFuture). */
  mal: MalfunctionCtl | null = null;

  constructor(private ctx: FutureCtx, mat: THREE.Material) {
    this.bodyB = [new FurnBatch(droneGeometry(0), mat, MAX_DRONES + 8), new FurnBatch(droneGeometry(1), mat, 16)];
    this.rotorB = new FurnBatch(rotorGeometry(), mat, (MAX_DRONES + 24) * 4, false);
    this.parcelB = new FurnBatch(parcelGeometry(), mat, MAX_DRONES + 48);
    const tg = new THREE.CylinderGeometry(0.004, 0.004, 1, 4, 1, true);
    tg.translate(0, -0.5, 0);
    const tb = tetherGeometry(tg);
    this.tetherB = new FurnBatch(tb, mat, MAX_DRONES, false);
    for (const b of [...this.bodyB, this.rotorB, this.parcelB, this.tetherB]) this.group.add(b.mesh);
    this.group.add(this.glows.mesh);
    this.rng = new Rng(deriveSeed(ctx.seed, 'drones'));
  }

  update(dt: number, hours: number, px: number, pz: number, player: PlayerProbe, cam: THREE.Camera): void {
    this.t += dt;
    if (this.t - this.scanT > 4) {
      this.scanT = this.t;
      const R = 240;
      const refs = this.ctx.world.buildingsIn(px - R, pz - R, px + R, pz + R).filter((r) => r.alive);
      this.dests = refs.filter((r) => r.desc.units > 0 || r.desc.shopfront || r.desc.use === 'office');
      const shops = refs.reduce((n, r) => n + (r.desc.shopfront ? 1 : 0), 0);
      const h = ((hours % 24) + 24) % 24;
      const hourF = h >= 7 && h < 21 ? 1 : h >= 21 || h < 1 ? 0.6 : 0.3;
      // Busy downtown skies, a few over the suburbs.
      this.target = Math.min(MAX_DRONES, Math.round((3 + shops * 0.22 + this.dests.length * 0.02) * hourF));
      this.stats.target = this.target;
    }
    this.spawnT -= dt;
    const flying = this.list.reduce((n, d) => n + (d.kind === DKind.Delivery && d.state === DState.Fly ? 1 : 0), 0);
    if (this.spawnT <= 0 && flying < this.target && this.dests.length) {
      this.spawnT = flying < this.target * 0.5 ? 0.1 : 1.2;
      this.spawnDelivery(px, pz, flying < this.target * 0.5);
    }
    for (let i = this.list.length - 1; i >= 0; i--) {
      const d = this.list[i];
      this.step(d, dt, player);
      const far = Math.hypot(d.x - px, d.z - pz);
      if (!d.alive || far > (d.mal ? MAL_KEEP_R : DESPAWN_R) || (d.state === DState.Down && d.stateT > 120 && far > 60)) this.remove(i);
    }
    // Parcels are taken in right after they land (left lying about they read as loot for the player).
    for (let k = this.dropped.length - 5; k >= 0; k -= 5) if (this.t - this.dropped[k + 4] > PARCEL_STAY) this.dropped.splice(k, 5);
    this.draw(dt, cam);
    this.stats.drones = this.list.length;
  }

  /**
   * A cruise leg a→b: altitude from a lane by heading (25–55 m over the highest ground on
   * the way) and waypoints round the towers that reach into it, planned on a coarse grid
   * (preferring the open air over streets). No way round: the next lane up (+12, +24 m);
   * over the top only when even that fails.
   */
  private leg(ax: number, az: number, bx: number, bz: number, skipEnd: number): { y: number; via: number[] } {
    const lane = 25 + 10 * (Math.floor(((Math.atan2(bz - az, bx - ax) + Math.PI) / (Math.PI * 2)) * 4) % 4);
    const L = Math.hypot(bx - ax, bz - az);
    const n = Math.max(2, Math.ceil(L / 20));
    let ground = -Infinity;
    for (let k = 0; k <= n; k++) ground = Math.max(ground, this.ctx.terrain.height(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n));
    this.stats.legs++;
    for (const up of [0, 12, 24]) {
      const y = ground + lane + up;
      const via = planAround(this.ctx.world, ax, az, bx, bz, y, skipEnd);
      if (!via) continue;
      // A huge detour is worse than the next lane up.
      let len = 0, px = ax, pz = az;
      for (let k = 0; k <= via.length; k += 2) {
        const qx = k < via.length ? via[k] : bx, qz = k < via.length ? via[k + 1] : bz;
        len += Math.hypot(qx - px, qz - pz); px = qx; pz = qz;
      }
      if (up < 24 && len > L * 1.8 + 120) continue;
      if (up) this.stats.raised++;
      return { y: this.overTop({ y, via }, ax, az, bx, bz, skipEnd), via };
    }
    this.stats.overTop++;
    return { y: this.overTop({ y: ground + lane, via: [] }, ax, az, bx, bz, skipEnd), via: [] };
  }

  /** The cruise altitude that clears every building along the route (y when nothing is in the way). */
  private overTop(l: { y: number; via: number[] }, ax: number, az: number, bx: number, bz: number, skipEnd: number): number {
    let y = l.y;
    const pts = [ax, az, ...l.via, bx, bz];
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const m = Math.max(2, Math.ceil(Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]) / 9));
      const last = i + 4 === pts.length;
      for (let k = 0; k <= m; k++) {
        // (The destination's own walls on the final approach do not count.)
        if (last && Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]) * (1 - k / m) < skipEnd) break;
        const b = this.ctx.world.buildingAt(pts[i] + ((pts[i + 2] - pts[i]) * k) / m, pts[i + 1] + ((pts[i + 3] - pts[i + 1]) * k) / m);
        if (b && b.top > y - 8) y = b.top + 12;
      }
    }
    return y;
  }

  private spawnDelivery(px: number, pz: number, midway: boolean): void {
    const dest = this.dests[this.rng.int(0, this.dests.length - 1)];
    const a = this.rng.range(0, Math.PI * 2);
    const R = this.rng.range(SPAWN_R[0], SPAWN_R[1]);
    let sx = px + Math.cos(a) * R, sz = pz + Math.sin(a) * R;
    // Drop point: in front of the door at head height, or onto a low flat roof.
    let dx: number, dy: number, dz: number;
    const roof = dest.desc.roof === 'flat' && dest.top - dest.base < 45 && this.rng.chance(0.35);
    if (roof) {
      dx = (dest.bounds[0] + dest.bounds[2]) / 2; dz = (dest.bounds[1] + dest.bounds[3]) / 2;
      if (this.ctx.world.buildingAt(dx, dz) !== dest) { const door = doorOf(dest.desc); dx = door.x - door.nx * 4; dz = door.z - door.nz * 4; }
      dy = dest.top + 2.2;
    } else {
      const door = doorOf(dest.desc);
      dx = door.x + door.nx * 0.4; dz = door.z + door.nz * 0.4;
      dy = this.ctx.world.groundHeight(dx, dz) + 4.5;
    }
    // One drone per drop point at a time (two at the same door would push each other off it).
    for (const o of this.list) {
      const w = o.kind === DKind.Delivery && o.drop >= 0 ? o.plan[o.drop] : null;
      if (w && o.pi <= o.drop + 1 && Math.hypot(w.x - dx, w.z - dz) < 6) return;
    }
    const out = this.rng.range(0, Math.PI * 2);
    const ex = dx + Math.cos(out) * 700, ez = dz + Math.sin(out) * 700;
    const legIn = this.leg(sx, sz, dx, dz, 16), legOut = this.leg(dx, dz, ex, ez, 0);
    const cIn = legIn.y, cOut = legOut.y;
    // Not out of a tower wall.
    const sb = this.ctx.world.buildingAt(sx, sz);
    if (sb && sb.top > cIn - 3) return;
    const plan: Wp[] = [];
    for (let k = 0; k < legIn.via.length; k += 2) plan.push({ x: legIn.via[k], y: cIn, z: legIn.via[k + 1], r: 8, hold: 0 });
    const inN = plan.length;
    plan.push(
      { x: dx, y: Math.max(cIn, dy + 6), z: dz, r: 6, hold: 0 },
      { x: dx, y: dy + 5, z: dz, r: 1.2, hold: 0.5 },
      { x: dx, y: dy, z: dz, r: 0.4, hold: 5, drop: true },
      { x: dx, y: Math.max(cOut, dy + 6), z: dz, r: 4, hold: 0 },
    );
    for (let k = 0; k < legOut.via.length; k += 2) plan.push({ x: legOut.via[k], y: cOut, z: legOut.via[k + 1], r: 8, hold: 0 });
    plan.push({ x: ex, y: cOut, z: ez, r: 10, hold: 0 });
    const dropAt = inN + 2;
    let pi = 0, y = cIn;
    if (midway) {
      // Already in the air somewhere along the approach or the way out.
      const f = this.rng.range(0.15, 0.95);
      if (this.rng.chance(0.65)) { sx += (plan[0].x - sx) * f; sz += (plan[0].z - sz) * f; }
      else {
        const a = plan[plan.length - 2], b = plan[plan.length - 1];
        sx = a.x + (b.x - a.x) * f * 0.6; sz = a.z + (b.z - a.z) * f * 0.6; pi = plan.length - 1; y = cOut;
      }
      const mb = this.ctx.world.buildingAt(sx, sz);
      if (Math.hypot(sx - px, sz - pz) < 60 || (mb && mb.top > y - 3)) return;
    }
    const kind = DKind.Delivery;
    const hd = Math.atan2(-(plan[pi].x - sx), -(plan[pi].z - sz));
    const sp = 8;
    this.list.push({
      id: this.nextId++, kind, fleet: this.rng.int(0, FLEETS.length - 1), x: sx, y, z: sz,
      vx: -Math.sin(hd) * sp, vy: 0, vz: -Math.cos(hd) * sp, yaw: hd, up: new THREE.Vector3(0, 1, 0), q: new THREE.Quaternion(),
      plan, pi, drop: dropAt, holdT: 0, parcel: pi <= dropAt ? 1 : 0, winch: 0, orbit: null, rotor: this.rng.range(0, 6), phase: this.rng.float(),
      state: DState.Fly, stateT: 0, body: null, lastSpeed: 0, broken: false, alive: true, lookT: this.rng.float(),
    });
  }

  /** A delivery drone hovering at (x, y, z) with nowhere to go (a malfunction plans its flight). */
  spawnAt(x: number, y: number, z: number, yaw: number): Drone | null {
    if (this.list.length >= MAX_DRONES + 8) return null;
    const d: Drone = {
      id: this.nextId++, kind: DKind.Delivery, fleet: this.rng.int(0, FLEETS.length - 1), x, y, z,
      vx: 0, vy: 0, vz: 0, yaw, up: new THREE.Vector3(0, 1, 0), q: new THREE.Quaternion(),
      plan: [{ x, y, z, r: 2, hold: 1e9 }], pi: 0, drop: -9, holdT: 0, parcel: 0, winch: 0, orbit: null, rotor: this.rng.range(0, 6), phase: this.rng.float(),
      state: DState.Fly, stateT: 0, body: null, lastSpeed: 0, broken: false, alive: true, lookT: this.rng.float(),
    };
    this.list.push(d);
    return d;
  }

  /** Send a drone away (out of the area, then it is dropped): a shut-down rogue going home. */
  leave(d: Drone): void {
    const a = Math.atan2(d.z, d.x) + this.rng.range(-1, 1);
    d.orbit = null;
    d.plan = [{ x: d.x + Math.cos(a) * 800, y: d.y + 15, z: d.z + Math.sin(a) * 800, r: 10, hold: 0 }];
    d.pi = 0;
  }

  /** News drones gather over a collapse, police drones circle a crash. */
  incident(kind: DKind.News | DKind.Police, x: number, z: number, px: number, pz: number): void {
    if (Math.hypot(x - px, z - pz) > 650) return;
    const max = kind === DKind.News ? 3 : 2;
    const have = this.list.filter((d) => d.kind === kind && d.state === DState.Fly);
    const g = this.ctx.terrain.height(x, z);
    const orbit = kind === DKind.News ? { x, z, y: g + 48, r: 42, until: this.t + 100, dir: 1 } : { x, z, y: g + 24, r: 16, until: this.t + 50, dir: -1 };
    for (const d of have) if (d.orbit && Math.hypot(d.orbit.x - x, d.orbit.z - z) < 150) { d.orbit.until = orbit.until; return; }
    if (have.length >= max) { const d = have[0]; d.orbit = { ...orbit, y: orbit.y + 6 * this.rng.float() }; return; }
    for (let k = have.length; k < (kind === DKind.News ? 2 : 1); k++) {
      const a = this.rng.range(0, Math.PI * 2);
      const sx = x + Math.cos(a) * 380, sz = z + Math.sin(a) * 380;
      const hd = Math.atan2(-(x - sx), -(z - sz));
      this.list.push({
        id: this.nextId++, kind, fleet: kind === DKind.News ? 0 : 2, x: sx, y: orbit.y + 10, z: sz,
        vx: -Math.sin(hd) * 10, vy: 0, vz: -Math.cos(hd) * 10, yaw: hd, up: new THREE.Vector3(0, 1, 0), q: new THREE.Quaternion(),
        plan: [], pi: 0, drop: -9, holdT: 0, parcel: 0, winch: 0, orbit: { ...orbit, y: orbit.y + k * 7, dir: k ? -orbit.dir : orbit.dir }, rotor: 0, phase: this.rng.float(),
        state: DState.Fly, stateT: 0, body: null, lastSpeed: 0, broken: false, alive: true, lookT: this.rng.float(),
      });
      if (kind === DKind.News) this.stats.news++; else this.stats.police++;
    }
  }

  private step(d: Drone, dt: number, player: PlayerProbe): void {
    d.stateT += dt;
    if (d.state !== DState.Fly) { this.stepFall(d); return; }
    if (d.mal && this.mal?.drone(d, dt, player)) return;
    const rage = d.mal?.mode === 'hostile' ? RAGE : 1;
    // ---- target: orbit, or the plan's current waypoint
    let tx: number, ty: number, tz: number, arriveR: number, hold = 0;
    let faceX = NaN, faceZ = NaN;
    if (d.orbit) {
      const o = d.orbit;
      if (this.t > o.until) {
        // Done filming: leave the area.
        const a = Math.atan2(d.z - o.z, d.x - o.x);
        d.plan = [{ x: o.x + Math.cos(a) * 800, y: o.y + 10, z: o.z + Math.sin(a) * 800, r: 10, hold: 0 }];
        d.pi = 0; d.orbit = null;
        return;
      }
      const a = Math.atan2(d.z - o.z, d.x - o.x) + o.dir * 0.35;
      tx = o.x + Math.cos(a) * o.r; tz = o.z + Math.sin(a) * o.r; ty = o.y;
      arriveR = 3; faceX = o.x; faceZ = o.z;
    } else {
      const w = d.plan[d.pi];
      if (!w) { d.alive = false; return; }
      tx = w.x; ty = w.y; tz = w.z; arriveR = w.r; hold = w.hold;
    }
    const ex = tx - d.x, ey = ty - d.y, ez = tz - d.z;
    const dist = Math.hypot(ex, ey, ez);
    // ---- waypoint progress (hover holds, parcel winch)
    // (Once there, a hover nudged off the spot (another drone, a gust of the player) still counts.)
    if (!d.orbit && (dist < arriveR || (d.holdT > 0 && dist < arriveR * 4 + 1.5))) {
      const w = d.plan[d.pi];
      d.holdT += dt;
      if (w.drop && d.parcel) {
        const ground = this.ctx.world.groundHeight(d.x, d.z, d.y);
        const L = Math.max(0.3, d.y - ground - 0.55);
        d.winch = Math.min(L, d.winch + dt * 1.1);
        if (d.winch >= L - 0.01) {
          // Set down on the spot the winch aimed for (the hovering drone sways a little).
          this.dropped.push(w.x, this.ctx.world.groundHeight(w.x, w.z, d.y), w.z, d.yaw, this.t);
          if (this.dropped.length > 40 * 5) this.dropped.splice(0, 5);
          d.parcel = 0;
        }
      } else if (w.drop) d.winch = Math.max(0, d.winch - dt * 2);
      if (d.holdT >= hold && (!w.drop || (!d.parcel && d.winch <= 0))) { d.pi++; d.holdT = 0; }
    }
    // ---- steering
    const want = Math.min(d.orbit ? 7 : VMAX * rage, Math.sqrt(2 * AMAX * rage * 0.6 * Math.max(0, dist - (d.orbit ? 0 : arriveR * 0.3))));
    const k = dist > 1e-3 ? want / dist : 0;
    // Climbs and descents at a limited rate: the horizontal speed waits for them (no lunges).
    const climbT = Math.max(0, Math.abs(ey) - arriveR * 0.5) / (ey > 0 ? VUP : VDOWN * rage);
    const kh = climbT > 0.1 ? Math.min(k, 1 / climbT) : k;
    const wantY = Math.max(-VDOWN * rage, Math.min(VUP, ey * k));
    let ax = (ex * kh - d.vx) * 1.6, ay = (wantY - d.vy) * 1.6, az = (ez * kh - d.vz) * 1.6;
    // Separation from other drones.
    for (const o of this.list) {
      if (o === d || o.state !== DState.Fly) continue;
      const ox = d.x - o.x, oy = d.y - o.y, oz = d.z - o.z;
      const d2 = ox * ox + oy * oy + oz * oz;
      if (d2 > 64 || d2 < 1e-4) continue;
      const f = 10 / d2;
      ax += ox * f; ay += oy * f * 0.5; az += oz * f;
    }
    // Buildings ahead: climb over them (not on the final approach to a door or a roof).
    const approach = !d.orbit && d.pi >= d.drop - 1 && d.pi <= d.drop && Math.hypot(ex, ez) < 10;
    const lx = d.x + d.vx * 1.6, lz = d.z + d.vz * 1.6;
    const b = approach ? null : this.ctx.world.buildingAt(lx, lz);
    if (b && b.top > d.y - 5) {
      if (b.top - d.y < 18) { ay += 6; ax -= d.vx * 0.8; az -= d.vz * 0.8; }
      else {
        // A tower: veer round it (away from its middle, across the flight direction).
        const mx = (b.bounds[0] + b.bounds[2]) / 2, mz = (b.bounds[1] + b.bounds[3]) / 2;
        const hs = Math.hypot(d.vx, d.vz) || 1, qx = -d.vz / hs, qz = d.vx / hs;
        const side = (d.x - mx) * qx + (d.z - mz) * qz >= 0 ? 1 : -1;
        ax += qx * side * 7 - d.vx * 0.5; az += qz * side * 7 - d.vz * 0.5;
      }
    }
    const ah = Math.hypot(ax, az);
    if (ah > AMAX * rage) { ax *= AMAX * rage / ah; az *= AMAX * rage / ah; }
    ay = Math.max(-2.5 * rage, Math.min(4, ay));
    d.vx += ax * dt; d.vy += ay * dt; d.vz += az * dt;
    d.vy = Math.max(-VDOWN * rage - 1, Math.min(VUP + 1, d.vy));
    d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
    // ---- attitude: tilt into the horizontal acceleration (plus drag), yaw into the flight direction
    const tX = (ax + d.vx * 0.12) / 9.81, tZ = (az + d.vz * 0.12) / 9.81;
    const tl = Math.hypot(tX, tZ), cap = 0.45;
    const sc = tl > cap ? cap / tl : 1;
    _v.set(tX * sc, 1, tZ * sc).normalize();
    d.up.lerp(_v, Math.min(1, dt * 4)).normalize();
    const hs = Math.hypot(d.vx, d.vz);
    let hd = d.yaw;
    if (!Number.isNaN(faceX)) hd = Math.atan2(-(faceX - d.x), -(faceZ - d.z));
    else if (hs > 1.5) hd = Math.atan2(-d.vx, -d.vz);
    let dy = hd - d.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    d.yaw += dy * Math.min(1, dt * 1.6);
    _q.setFromAxisAngle(_Y, d.yaw);
    _q2.setFromUnitVectors(_Y, d.up);
    d.q.copy(_q2).multiply(_q);
    d.rotor += dt * (95 + Math.hypot(ax, ay + 9.81, az) * 2);
    // Low over the street (arriving, winching a parcel down): passers-by glance up at it.
    d.lookT -= dt;
    if (d.lookT <= 0) {
      d.lookT = 0.7;
      const agl = d.y - this.ctx.terrain.height(d.x, d.z);
      if (agl < 16) glanceAt(this.ctx.peds, d.x, d.y, d.z, d.winch > 0 ? 9 : 12, d.winch > 0 ? 0.55 : 0.3, d.id * 31 + Math.floor(this.t));
    }
    // ---- the player's body (giants, flying heroes) swats drones it touches
    if (player.active) {
      const ox = d.x - player.x, oz = d.z - player.z;
      const rr = player.radius + 0.6;
      if (ox * ox + oz * oz < rr * rr && d.y > player.y - 0.3 && d.y < player.y + player.height + 0.3) {
        const sp = Math.hypot(player.vx, player.vy, player.vz);
        if (sp > 1 || player.height > 3) this.knock(d, player.vx * DRONE.mass + ox * 20, player.vy * DRONE.mass, player.vz * DRONE.mass + oz * 20);
      }
    }
  }


  /** Falling: follow the body; a hard landing breaks it. */
  private stepFall(d: Drone): void {
    const b = d.body;
    if (!b) return;
    const t = b.translation(), r = b.rotation(), v = b.linvel();
    const G = this.ground;
    const g = G ? G.streetY(t.x, t.z, d.y) : this.ctx.terrain.height(t.x, t.z);
    if (t.y < g - 0.4) {
      // Below the street (should not happen with the exact ground): put it back where it was.
      b.setTranslation({ x: d.x, y: Math.max(d.y, g + 0.5), z: d.z }, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      return;
    }
    // Inside a building (squeezed through a wall): out through the nearest wall.
    const out = G?.resolve(t.x, t.y, t.z, 0.6);
    if (out) {
      b.setTranslation({ x: out.x, y: t.y, z: out.z }, true);
      const lv = b.linvel(), vn = lv.x * out.nx + lv.z * out.nz;
      if (vn < 0) b.setLinvel({ x: lv.x - out.nx * vn * 1.3, y: lv.y, z: lv.z - out.nz * vn * 1.3 }, true);
      return;
    }
    G?.ensure(t.x, t.z, 6, t.y);
    d.x = t.x; d.y = t.y; d.z = t.z;
    d.q.set(r.x, r.y, r.z, r.w);
    const sp = Math.hypot(v.x, v.y, v.z);
    if (!d.broken && d.lastSpeed > 4 && sp < d.lastSpeed * 0.45) this.breakIt(d);
    d.lastSpeed = sp;
    d.rotor += (d.broken ? 0 : 30) * 0.016;
    if ((b.isSleeping() && d.stateT > 1) || d.stateT > 25 || t.y < -100) {
      this.ctx.physics.world.removeRigidBody(b);
      d.body = null;
      d.state = DState.Down;
      if (!d.broken) this.breakIt(d);
    }
  }

  private breakIt(d: Drone): void {
    d.broken = true;
    const D = this.ctx.debris;
    D.chipBurst(d.x, d.y + 0.1, d.z, 10, 3, 0, 0.8, 0, new THREE.Color(0.9, 0.9, 0.88), 0.05, 3);
    D.chipBurst(d.x, d.y + 0.1, d.z, 6, 3, 0, 0.8, 0, new THREE.Color(0.1, 0.1, 0.1), 0.06, 3);
    D.chipBurst(d.x, d.y + 0.15, d.z, 8, 4.5, 0, 1, 0, new THREE.Color(4, 2.2, 0.6), 0.02, 0.6);
    this.ctx.sound('metal_bend', d.x, d.y, d.z, 0.35, 1.9, 4);
    this.ctx.sound('glass_shatter', d.x, d.y, d.z, 0.2, 1.6, 3);
  }

  /** Knock a flying drone out of the sky (or push a falling one). */
  knock(d: Drone, jx: number, jy: number, jz: number): void {
    if (d.state === DState.Down) return;
    if (d.mal) this.mal?.hit('drone', d, Math.hypot(jx, jy, jz));
    const P = this.ctx.physics, R = P.R;
    if (!d.body) {
      d.state = DState.Fall; d.stateT = 0;
      this.stats.swatted++;
      if (d.parcel) d.parcel = 0;
      d.winch = 0;
      d.body = P.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(d.x, d.y, d.z).setRotation({ x: d.q.x, y: d.q.y, z: d.q.z, w: d.q.w })
        .setLinvel(d.vx, d.vy, d.vz).setAngvel({ x: (this.rng.float() - 0.5) * 8, y: (this.rng.float() - 0.5) * 12, z: (this.rng.float() - 0.5) * 8 })
        .setLinearDamping(0.15).setAngularDamping(0.3).setCcdEnabled(true));
      P.world.createCollider(R.ColliderDesc.cuboid(DRONE.arm * 0.7, 0.1, DRONE.arm * 0.7).setDensity(DRONE.mass / (DRONE.arm * DRONE.arm * 1.96 * 0.2)).setFriction(0.6).setRestitution(0.25)
        .setCollisionGroups(this.ground ? GROUPS.smallBody : 0xffffffff), d.body);
      // Ground and walls under the whole fall (it drifts while falling).
      const gr = 20 + Math.hypot(d.vx, d.vz) * 2;
      if (this.ground) this.ground.ensure(d.x, d.z, gr, d.y); else P.ensureGround(d.x, d.z, gr);
      this.ctx.sound('punch_impact', d.x, d.y, d.z, 0.5, 1.5, 6);
      // People look up; some stop to watch (or film) where it comes down.
      gawkAt(this.ctx.peds, d.x, Math.max(this.ctx.terrain.height(d.x, d.z) + 1, d.y * 0.5), d.z, 28, 0.9);
    }
    const J = Math.hypot(jx, jy, jz);
    const k = Math.min(1, (DRONE.mass * 9) / Math.max(1, J));
    d.body.applyImpulse({ x: jx * k, y: jy * k, z: jz * k }, true);
  }

  /** A strike near a point (punch, swat, thrown object). */
  hit(x: number, y: number, z: number, rad: number, jx: number, jy: number, jz: number): number {
    let n = 0;
    for (const d of this.list) {
      if (d.state === DState.Down) continue;
      const dd = Math.hypot(d.x - x, d.y - y, d.z - z);
      if (dd > rad + DRONE.arm + 0.3) continue;
      this.knock(d, jx, jy, jz);
      n++;
    }
    return n;
  }

  /** Nearest flying drone (for the rotor buzz). */
  nearest(x: number, y: number, z: number): { d: number; drone: Drone | null } {
    let best = Infinity, bd: Drone | null = null;
    for (const d of this.list) {
      if (d.state !== DState.Fly) continue;
      const dd = Math.hypot(d.x - x, d.y - y, d.z - z);
      if (dd < best) { best = dd; bd = d; }
    }
    return { d: best, drone: bd };
  }

  private draw(_dt: number, cam: THREE.Camera): void {
    const cp = cam.position;
    for (const b of this.bodyB) b.begin();
    this.rotorB.begin(); this.parcelB.begin(); this.tetherB.begin(); this.glows.begin(cam);
    let drawn = 0;
    for (const d of this.list) {
      if (Math.abs(d.x - cp.x) > DRAW_R || Math.abs(d.z - cp.z) > DRAW_R) continue;
      const sc = statusOf(d)?.scale ?? 1; // shrink ray
      _m.compose(_p.set(d.x, d.y, d.z), d.q, _s.set(sc, sc, sc));
      const c = d.mal?.mode === 'hostile' && !d.broken ? ROGUE_RED : d.kind === DKind.Police ? [0.08, 0.1, 0.16] : d.kind === DKind.News ? [0.85, 0.12, 0.1] : FLEETS[d.fleet];
      const mode = d.broken ? 2 : d.mal && d.state === DState.Fly ? malLed(d.mal) : d.state !== DState.Fly ? 1 : 0;
      const police = d.kind === DKind.Police ? 3 : 0;
      this.bodyB[d.kind === DKind.Delivery ? 0 : 1].push(_m, c[0], c[1], c[2], 1, police, d.phase, mode);
      drawn++;
      // Light glows (visible as dots far beyond the model): port red, starboard green, strobe
      // (all red when it has gone rogue; dark when shut down).
      if (!d.broken && mode < 2) {
        const m0 = DRONE_MOTORS[0], m1 = DRONE_MOTORS[1];
        this.glows.push(_p.set(m0[0], m0[1] - 0.04, m0[2] - 0.05).applyMatrix4(_m), 1, 0.06, 0.03, 0, d.phase);
        this.glows.push(_p.set(m1[0], m1[1] - 0.04, m1[2] - 0.05).applyMatrix4(_m), 0.1, 1, 0.25, 0, d.phase);
        this.glows.push(_p.set(0, 0.09, 0.05).applyMatrix4(_m), 1, 1, 1, d.kind === DKind.Police ? 2 : 1, d.phase);
      } else if (!d.broken && mode === 3) {
        for (const m of DRONE_MOTORS) this.glows.push(_p.set(m[0], m[1] - 0.04, m[2]).applyMatrix4(_m), 1, 0.04, 0.02, 0, d.phase);
        this.glows.push(_p.set(0, 0.09, 0.05).applyMatrix4(_m), 1, 0.05, 0.03, 1, d.phase * 0.3);
      }
      // Rotors: alternate spin directions; a broken drone's rotors stand still.
      const spin = d.broken ? 0.3 : d.rotor;
      for (let k = 0; k < 4; k++) {
        const mp = DRONE_MOTORS[k];
        _m2.makeRotationY((k & 1 ? -spin : spin) + k);
        _m2.setPosition(mp[0], mp[1], mp[2]).premultiply(_m);
        this.rotorB.push(_m2, 0, 0, 0, 1, 0, 0, 0);
      }
      if (d.parcel) {
        // The parcel hangs level under the body (on the winch while it is lowered).
        _q.setFromAxisAngle(_Y, d.yaw);
        _m2.compose(_p.set(d.x, d.y - d.winch, d.z), _q, _s.set(1, 1, 1));
        this.parcelB.push(_m2, 0, 0, 0, 1, 0, 0, 0);
        if (d.winch > 0.02) {
          _m2.compose(_p.set(d.x, d.y - 0.14, d.z), _q, _s.set(1, d.winch, 1));
          this.tetherB.push(_m2, 0, 0, 0, 1, 0, 0, 0);
        }
      }
    }
    // Parcels waiting at doors.
    const D = this.dropped;
    for (let k = 0; k < D.length; k += 5) {
      if (Math.abs(D[k] - cp.x) > 200 || Math.abs(D[k + 2] - cp.z) > 200) continue;
      _q.setFromAxisAngle(_Y, D[k + 3]);
      _m2.compose(_p.set(D[k], D[k + 1] + 0.43, D[k + 2]), _q, _s.set(1, 1, 1));
      this.parcelB.push(_m2, 0, 0, 0, 1, 0, 0, 0);
    }
    for (const b of this.bodyB) b.end();
    this.rotorB.end(); this.parcelB.end(); this.tetherB.end(); this.glows.end();
    this.stats.drawn = drawn;
  }

  private remove(i: number): void {
    const d = this.list[i];
    if (d.body) this.ctx.physics.world.removeRigidBody(d.body);
    this.list[i] = this.list[this.list.length - 1];
    this.list.pop();
  }
}

/** The tether as a furniture-material geometry (metal cable, top at y = 0, unit length). */
function tetherGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  g.setAttribute('aMat', new THREE.Float32BufferAttribute(new Float32Array(n).fill(0), 1));
  g.setAttribute('aEmit', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
  g.setAttribute('aSub', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(0.2), 3));
  return g;
}
