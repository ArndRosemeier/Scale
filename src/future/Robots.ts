/**
 * Sidewalk delivery robots: six-wheeled cooler boxes that leave a shop, drive the pedestrian
 * sidewalk route (Pedestrians.buildRoute) to a customer's door, wait there for the hand-over
 * and drive back. They yield to people (slow, swerve, stop), wait at the kerb until the road is
 * clear, and are physical: a shove or a punch knocks them over (a Rapier box until they come to
 * rest), a hard hit or a giant's foot breaks them (shell chips, sparks, status light dead).
 *
 * Like pedestrians they exist only near the player: spawned at shops in loaded cells (so their
 * density follows the shop density - downtown and high streets, few in the suburbs) and dropped
 * when far away. All drawn as one instanced mesh in the furniture material.
 *
 * At night and in the early morning street-cleaning robots work the same sidewalks: slow
 * sweepers with spinning side brushes and an amber beacon, going from block to block.
 *
 * People step aside for them (the robot tells those in its way) and stop to look at one lying
 * on its back; cars brake for them on the carriageway (Traffic.obstacles). Knocked over they
 * collide with the exact street level and building walls (LocalGround), not the coarse
 * heightfield.
 */
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { Rng, deriveSeed, hash32 } from '../core/rng';
import { CURB_H } from '../build/ground';
import { doorOf } from '../sim/Population';
import type { PedAgent } from '../sim/Pedestrians';
import type { BuildingRef } from '../world/WorldIndex';
import { VState } from '../sim/Traffic';
import { GROUPS } from '../physics/Physics';
import { FurnBatch } from './batch';
import { robotGeometry, ROBOT, cleanerGeometry, brushGeometry, CLEANER, CLEANER_BRUSHES } from './models';
import { FLEETS, type FutureCtx, type PlayerProbe } from './ctx';
import { gawkAt } from './attention';
import { statusOf } from '../shared/status';
const _sm = new THREE.Matrix4();
import type { LocalGround } from './ground';

export const enum RState { Drive = 0, Wait = 1, Deliver = 2, Down = 3, Broken = 4 }
export const enum RKind { Delivery = 0, Cleaner = 1 }

/** Per kind: body box (m), body centre height, mass, top speed. */
const KINDS = [
  { w: ROBOT.width - 0.04, h: 0.6, l: ROBOT.length, bodyY: 0.32, mass: ROBOT.mass, vmax: 1.7 },
  { w: CLEANER.width, h: 0.5, l: CLEANER.length, bodyY: 0.27, mass: CLEANER.mass, vmax: 0.75 },
];
/** Municipal cleaning colour (sRGB). */
const MUNICIPAL: [number, number, number] = [0.95, 0.55, 0.08];

export interface Robot {
  id: number;
  kind: RKind;
  fleet: number;
  x: number; y: number; z: number;
  yaw: number;
  speed: number;
  route: Float32Array;
  wp: number;
  onRoad: boolean;
  state: RState;
  stateT: number;
  /** Seconds blocked by someone in front. */
  blocked: number;
  /** Lateral swerve offset (m, + = right). */
  swerve: number;
  /** Shop it belongs to (returns there) and whether it is on the way back. */
  home: { x: number; z: number };
  returning: boolean;
  phase: number;
  body: RAPIER.RigidBody | null;
  /** Pose when lying (knocked over / broken). */
  pose: THREE.Matrix4 | null;
  crushed: boolean;
  alive: boolean;
  /** Cleaners: blocks still to sweep before heading off. */
  legs: number;
  /** Lying on the carriageway (cars stop for it). */
  inLane: boolean;
  /** Seconds a car has been waiting in front of it while it lies in the lane. */
  carWait: number;
  /** Being dragged off the carriageway to this point. */
  drag?: { x: number; z: number };
}

const MAX_ROBOTS = 150;
const MAX_CLEANERS = 24;
const SCAN_R = 320;
const DESPAWN_R = 460;
const DRAW_R = 260;
/** Impulses (N·s): knocked over / broken. */
const J_TOPPLE = 60;
const J_BREAK = 900;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);
const _off = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();

export class Robots {
  readonly group = new THREE.Group();
  readonly list: Robot[] = [];
  private batch: FurnBatch;
  private cleanB: FurnBatch;
  private brushB: FurnBatch;
  private rng: Rng;
  private crng: Rng;
  private cleanT = 0;
  private cleanTarget = 0;
  private nextId = 1;
  private t = 0;
  private spawnT = 0;
  private target = 0;
  private hubs: BuildingRef[] = [];
  private homes: BuildingRef[] = [];
  private scanT = -10;
  private nb: PedAgent[] = [];
  stats = { robots: 0, target: 0, hubs: 0, drawn: 0, knocked: 0, broken: 0, cleaners: 0, carHits: 0 };
  /** Exact ground and walls for knocked robots (set by NearFuture). */
  ground: LocalGround | null = null;

  constructor(private ctx: FutureCtx, mat: THREE.Material) {
    this.batch = new FurnBatch(robotGeometry(), mat, MAX_ROBOTS + 16);
    this.cleanB = new FurnBatch(cleanerGeometry(), mat, MAX_CLEANERS + 4);
    this.brushB = new FurnBatch(brushGeometry(), mat, (MAX_CLEANERS + 4) * 2, false);
    this.group.add(this.batch.mesh, this.cleanB.mesh, this.brushB.mesh);
    this.rng = new Rng(deriveSeed(ctx.seed, 'robots'));
    // Own sequence: the delivery robots' placement does not depend on the cleaners.
    this.crng = new Rng(deriveSeed(ctx.seed, 'cleaners'));
  }

  update(dt: number, hours: number, px: number, pz: number, player: PlayerProbe, cam: THREE.Camera): void {
    this.t += dt;
    // Shops (hubs) and customers around the player, refreshed every few seconds.
    if (this.t - this.scanT > 3) {
      this.scanT = this.t;
      const refs = this.ctx.world.buildingsIn(px - SCAN_R, pz - SCAN_R, px + SCAN_R, pz + SCAN_R);
      this.hubs = refs.filter((r) => r.alive && (r.desc.shopfront || r.desc.use === 'retail'));
      this.homes = refs.filter((r) => r.alive && (r.desc.units > 0 || r.desc.use === 'office'));
      const h = ((hours % 24) + 24) % 24;
      const hourF = h >= 7 && h < 22 ? 1 : h >= 22 || h < 1 ? 0.45 : h < 5 ? 0.12 : 0.4;
      this.target = Math.min(MAX_ROBOTS, Math.round(this.hubs.length * 0.3 * hourF));
      // Sweepers: the night shift and the early morning before the crowds.
      const cleanF = h >= 22 || h < 5 ? 1 : h < 8 ? 0.7 : h >= 20 ? 0.35 : 0.08;
      this.cleanTarget = Math.min(MAX_CLEANERS, Math.round((2 + this.homes.length * 0.025) * cleanF));
      this.stats.hubs = this.hubs.length;
      this.stats.target = this.target;
    }
    // One spawn (one route search) at a time.
    this.spawnT -= dt;
    let active = 0, cleaners = 0;
    for (const r of this.list) if (r.kind === RKind.Cleaner) cleaners++; else active++;
    if (this.spawnT <= 0 && active < this.target && this.hubs.length && this.homes.length && this.ctx.peds) {
      this.spawnT = active < this.target * 0.5 ? 0.05 : 0.6;
      this.spawn(px, pz, active < this.target * 0.5);
    }
    this.cleanT -= dt;
    if (this.cleanT <= 0 && cleaners < this.cleanTarget && this.homes.length > 1 && this.ctx.peds) {
      this.cleanT = cleaners < this.cleanTarget * 0.5 ? 0.3 : 2;
      this.spawnCleaner(px, pz);
    }
    this.stats.cleaners = cleaners;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const r = this.list[i];
      const d = Math.hypot(r.x - px, r.z - pz);
      // Distant robots step at a quarter of the rate.
      if (d > 120 && r.state < RState.Down && !r.onRoad) { if ((i + Math.floor(this.t * 60)) % 4 === 0) this.step(r, dt * 4, player); }
      else this.step(r, dt, player);
      const stale = (r.state >= RState.Down && r.stateT > 150 && d > 40) || (r.kind === RKind.Cleaner && r.legs <= 0 && d > 60);
      if (!r.alive || d > DESPAWN_R || stale) this.remove(i);
    }
    this.draw(cam);
    this.stats.robots = this.list.length;
  }

  private pickNear(list: BuildingRef[], x: number, z: number, rMin: number, rMax: number, rng = this.rng): BuildingRef | null {
    if (!list.length) return null;
    for (let k = 0; k < 8; k++) {
      const b = list[rng.int(0, list.length - 1)];
      const d = Math.hypot(b.bounds[0] - x, b.bounds[1] - z);
      if (d >= rMin && d <= rMax) return b;
    }
    return null;
  }

  private spawn(px: number, pz: number, midway: boolean): void {
    const hub = this.hubs[this.rng.int(0, this.hubs.length - 1)];
    const a = doorOf(hub.desc);
    const dest = this.pickNear(this.homes, a.x, a.z, 60, 300);
    if (!dest) return;
    const b = doorOf(dest.desc);
    const route = this.ctx.peds.buildRoute(a.x, a.z, b.x, b.z);
    if (!route || route.length < 9) return;
    const fleet = hash32(hub.desc.seed) % FLEETS.length;
    const r: Robot = {
      id: this.nextId++, fleet, x: route[0], z: route[1], y: 0, yaw: 0, speed: 0, route, wp: 1, onRoad: false,
      state: RState.Drive, stateT: 0, blocked: 0, swerve: 0, home: { x: a.x, z: a.z }, returning: false,
      phase: this.rng.float(), body: null, pose: null, crushed: false, alive: true, kind: RKind.Delivery, legs: 0, inLane: false, carWait: 0,
    };
    if (midway) {
      // Fill an empty neighbourhood: robots already on their way (not popping up next to the player).
      advance(r, routeLength(route) * this.rng.range(0.1, 0.9));
      if (Math.hypot(r.x - px, r.z - pz) < 35) return;
    }
    const nx = r.route[r.wp * 3] ?? r.x, nz = r.route[r.wp * 3 + 1] ?? r.z;
    r.yaw = Math.atan2(-(nx - r.x), -(nz - r.z));
    r.y = this.groundY(r.x, r.z, r.onRoad);
    this.list.push(r);
  }

  /** A sweeper starts on the sidewalk in front of a building out of the player's sight. */
  private spawnCleaner(px: number, pz: number): void {
    const a = this.homes[this.crng.int(0, this.homes.length - 1)];
    const da = doorOf(a.desc);
    if (Math.hypot(da.x - px, da.z - pz) < 40) return;
    const route = this.cleanRoute(da.x, da.z);
    if (!route) return;
    const r: Robot = {
      id: this.nextId++, kind: RKind.Cleaner, fleet: 0, x: route[0], z: route[1], y: 0, yaw: 0, speed: 0, route, wp: 1, onRoad: false,
      state: RState.Drive, stateT: 0, blocked: 0, swerve: 0, home: { x: da.x, z: da.z }, returning: false,
      phase: this.crng.float(), body: null, pose: null, crushed: false, alive: true, legs: this.crng.int(2, 5), inLane: false, carWait: 0,
    };
    advance(r, Math.min(3, routeLength(route) * 0.2));
    const nx = r.route[r.wp * 3] ?? r.x, nz = r.route[r.wp * 3 + 1] ?? r.z;
    r.yaw = Math.atan2(-(nx - r.x), -(nz - r.z));
    r.y = this.groundY(r.x, r.z, r.onRoad);
    this.list.push(r);
  }

  /** The next stretch to sweep: to a building 40-160 m away along the sidewalks. */
  private cleanRoute(x: number, z: number): Float32Array | null {
    const dest = this.pickNear(this.homes, x, z, 40, 160, this.crng) ?? this.pickNear(this.hubs, x, z, 40, 160, this.crng);
    if (!dest) return null;
    const b = doorOf(dest.desc);
    const route = this.ctx.peds.buildRoute(x, z, b.x, b.z);
    if (!route || route.length < 9) return null;
    // Sweep the sidewalk, not the doorstep: drop the last door connector.
    return route.slice(0, route.length - 3);
  }

  private groundY(x: number, z: number, onRoad: boolean): number {
    return this.ctx.terrain.height(x, z) + (onRoad ? 0 : CURB_H);
  }

  private step(r: Robot, dt: number, player: PlayerProbe): void {
    r.stateT += dt;
    if (r.state >= RState.Down) { this.stepDown(r, dt); return; }
    if (r.state === RState.Deliver) {
      // Customer collects the parcel; then back to the shop (or gone when that is far).
      if (r.stateT > 14 + r.phase * 10) {
        if (r.returning) { r.alive = false; return; }
        const route = this.ctx.peds.buildRoute(r.x, r.z, r.home.x, r.home.z);
        if (!route) { r.alive = false; return; }
        r.route = route; r.wp = 1; r.returning = true; r.state = RState.Drive; r.stateT = 0;
      }
      return;
    }
    if (r.state === RState.Wait) {
      // At the kerb: at least a moment, then only when no car is coming.
      if (r.stateT > 1.2 && this.ctx.traffic.safeToCross({ x: r.x, z: r.z } as PedAgent)) { r.state = RState.Drive; r.stateT = 0; r.onRoad = true; }
      r.speed = 0;
      return;
    }
    const K = KINDS[r.kind];
    const R = r.route;
    if (r.wp >= R.length / 3) {
      if (r.kind === RKind.Cleaner) {
        // Block done: the next one, or park and be dropped once out of sight.
        r.legs--;
        const next = r.legs > 0 ? this.cleanRoute(r.x, r.z) : null;
        if (next) { r.route = next; r.wp = 1; r.onRoad = false; } else { r.legs = 0; r.speed = 0; }
        return;
      }
      r.state = RState.Deliver; r.stateT = 0; r.speed = 0; return;
    }
    let tx = R[r.wp * 3], tz = R[r.wp * 3 + 1];
    const dx0 = tx - r.x, dz0 = tz - r.z;
    const dl = Math.hypot(dx0, dz0);
    if (dl < 0.45) {
      // A flagged waypoint is reached across the carriageway: wait at the kerb first.
      r.wp++;
      const nextRoad = r.wp < R.length / 3 && R[r.wp * 3 + 2] > 0.5;
      if (nextRoad && !r.onRoad) { r.state = RState.Wait; r.stateT = 0; return; }
      r.onRoad = nextRoad;
      return;
    }
    const fx = dx0 / dl, fz = dz0 / dl;
    // People (and the player) ahead: slow down and swerve right, stop when close.
    let want = K.vmax, near = 9;
    const box = K.w / 2 + 0.34;
    const lookX = r.x + fx * 1.8, lookZ = r.z + fz * 1.8;
    for (const a of this.ctx.peds.neighbours(lookX, lookZ, 2.6, this.nb)) {
      if (a.state === 5 || a.inside) continue;
      const ox = a.x - r.x, oz = a.z - r.z;
      const along = ox * fx + oz * fz, lat = -ox * fz + oz * fx;
      const d = Math.hypot(ox, oz);
      // Nudge people out of the robot's box (a last resort; they make room themselves).
      if (d < box && d > 1e-3) { a.x += (ox / d) * (box - d) * 0.6; a.z += (oz / d) * (box - d) * 0.6; }
      const off = lat - r.swerve;
      if (along > 0 && along < 2.6 && Math.abs(off) < 0.75) near = Math.min(near, along);
      // Walking in its path: step aside, away from the robot's line, before it gets there.
      if (a.state === 0 && along > -0.2 && along < 3.8 && Math.abs(off) < 0.95) {
        const side = off >= 0 ? 1 : -1, k = 0.3 + 0.8 * (1 - Math.abs(off) / 0.95);
        a.sideX = -fz * side * k; a.sideZ = fx * side * k; a.sideT = 0.3;
      }
    }
    // The player, whatever the size (a tiny player is a small obstacle, not nothing).
    if (player.active && player.height > 0.02) {
      const pr = Math.max(0.1, player.radius);
      const ox = player.x - r.x, oz = player.z - r.z;
      const along = ox * fx + oz * fz, lat = -ox * fz + oz * fx;
      if (along > 0 && along < 2.6 + pr && Math.abs(lat - r.swerve) < K.w / 2 + 0.32 + pr && Math.abs(player.y - r.y) < 1.2) near = Math.min(near, along - pr);
    }
    // Crossing: a moving car about to pass in front - stop short of its path (it brakes for
    // robots already in its lane, so they never wait for each other).
    let carAhead = false;
    if (r.onRoad) {
      const probe = K.l / 2 + 0.9, qx = r.x + fx * probe, qz = r.z + fz * probe;
      for (const v of this.ctx.traffic.vehicles) {
        if (v.speed < 0.8 || Math.abs(v.x - qx) > 12 || Math.abs(v.z - qz) > 12) continue;
        const cfx = -Math.sin(v.yaw), cfz = -Math.cos(v.yaw), ox = qx - v.x, oz = qz - v.z;
        const along = ox * cfx + oz * cfz, lat = Math.abs(-ox * cfz + oz * cfx);
        // (A car turning through the junction sweeps a curve: keep clear all round.)
        const inPath = v.turn ? Math.hypot(ox, oz) < v.length / 2 + 1.5 + v.speed
          : along > -v.length / 2 - 0.5 && along < v.length / 2 + 0.8 + v.speed * 1.2 && lat < v.width / 2 + 0.5;
        if (inPath) { near = 0; carAhead = true; break; }
      }
    }
    if (near < 0.9) { want = 0; r.blocked += dt; }
    else if (near < 2.6) { want = K.vmax * 0.45; r.blocked = Math.max(0, r.blocked - dt); }
    else r.blocked = Math.max(0, r.blocked - dt * 2);
    // Swerve towards the right edge of the sidewalk while something is ahead (never on the road).
    const swTarget = near < 2.6 && !r.onRoad ? 0.55 : 0;
    r.swerve += (swTarget - r.swerve) * Math.min(1, dt * 1.5);
    // Stuck for a long time (a crowd): creep on.
    if (r.blocked > 8 && !carAhead) want = 0.3;
    r.speed += clampAbs(want - r.speed, (want < r.speed ? 3 : 1.2) * dt);
    tx += -fz * r.swerve; tz += fx * r.swerve;
    const hx = tx - r.x, hz = tz - r.z, hl = Math.hypot(hx, hz) || 1;
    r.x += (hx / hl) * r.speed * dt;
    r.z += (hz / hl) * r.speed * dt;
    const h = Math.atan2(-hx, -hz);
    let dy = h - r.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    r.yaw += dy * Math.min(1, dt * 5);
    r.y += (this.groundY(r.x, r.z, r.onRoad) - r.y) * Math.min(1, dt * 12);
    // Crossing: a car that does not stop (cars brake for robots in their lane) runs it over.
    if (r.onRoad) {
      for (const v of this.ctx.traffic.vehicles) {
        if (v.speed < 2.5 || (v.state !== VState.Drive && v.state !== VState.Fleeing)) continue;
        const vx = r.x - v.x, vz = r.z - v.z;
        if (vx * vx + vz * vz > (v.length / 2 + 0.6) ** 2) continue;
        const cfx = -Math.sin(v.yaw), cfz = -Math.cos(v.yaw);
        if (Math.abs(vx * -cfz + vz * cfx) > v.width / 2 + 0.3) continue;
        this.stats.carHits++;
        this.knock(r, cfx * v.speed * 40, v.speed * 12, cfz * v.speed * 40);
        this.ctx.sound('car_crash', r.x, r.y, r.z, 0.35, 1.5, 4);
        break;
      }
    }
    // The player's body: walking into a robot pushes it; running into it or a big body knocks it
    // over. A tiny player is simply not driven over (the robot stops beside them).
    if (player.active && player.height > 0.02) {
      const ox = r.x - player.x, oz = r.z - player.z, d = Math.hypot(ox, oz);
      const rr = Math.max(0.1, player.radius) + K.w / 2 + 0.1;
      if (d < rr && d > 1e-3 && Math.abs(player.y - r.y) < Math.max(player.height, 0.55)) {
        const sp = Math.hypot(player.vx, player.vz);
        if (player.height > 0.5 && (sp > 3.2 || player.mass > 400)) this.knock(r, (ox / d) * player.mass * Math.max(1, sp) * 0.25, 20, (oz / d) * player.mass * Math.max(1, sp) * 0.25);
        else { r.x = player.x + (ox / d) * rr; r.z = player.z + (oz / d) * rr; if (player.height < 0.5) r.speed = 0; }
      }
    }
  }

  /** Lying / tumbling robots follow their rigid body until it rests. */
  private stepDown(r: Robot, dt: number): void {
    const b = r.body;
    if (!b) { this.clearLane(r, dt); return; }
    const K = KINDS[r.kind], G = this.ground;
    const t = b.translation(), q = b.rotation();
    const g = G ? G.streetY(t.x, t.z, r.y + 1) : this.ctx.terrain.height(t.x, t.z);
    if (t.y < g - 0.4) {
      // Below the street (should not happen with the exact ground): back up.
      b.setTranslation({ x: r.x, y: Math.max(r.y + K.bodyY, g + 0.6), z: r.z }, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      return;
    }
    // Inside a building after all (a huge impulse): out through the nearest wall.
    const out = G?.resolve(t.x, t.y, t.z, Math.max(K.w, K.l) / 2 + 0.05);
    if (out) {
      b.setTranslation({ x: out.x, y: Math.max(t.y, g + K.h / 2), z: out.z }, true);
      const lv = b.linvel(), vn = lv.x * out.nx + lv.z * out.nz;
      if (vn < 0) b.setLinvel({ x: lv.x - out.nx * vn * 1.3, y: lv.y, z: lv.z - out.nz * vn * 1.3 }, true);
      return;
    }
    G?.ensure(t.x, t.z, 4, t.y);
    r.x = t.x; r.y = t.y - K.bodyY; r.z = t.z;
    _m.compose(_p.set(t.x, t.y, t.z), _q.set(q.x, q.y, q.z, q.w), _s.set(1, 1, 1)).multiply(_off.makeTranslation(0, -K.bodyY, 0));
    r.pose!.copy(_m);
    if ((b.isSleeping() && r.stateT > 1.5) || r.stateT > 25 || t.y < -100) {
      this.ctx.physics.world.removeRigidBody(b);
      r.body = null;
      r.inLane = this.ctx.world.surfaceOffset(r.x, r.z) < 0.01;
    }
  }

  /**
   * A robot lying in a traffic lane: cars stop for it. When one has waited a while its driver
   * drags it to the kerb (the robot slides off the carriageway to the nearest sidewalk).
   */
  private clearLane(r: Robot, dt: number): void {
    if (!r.inLane || !r.pose) return;
    if (r.carWait < 10) {
      let waiting = false;
      for (const v of this.ctx.traffic.vehicles) {
        if (v.speed > 0.5 || Math.abs(v.x - r.x) > 10 || Math.abs(v.z - r.z) > 10) continue;
        if ((r.x - v.x) * -Math.sin(v.yaw) + (r.z - v.z) * -Math.cos(v.yaw) > 0) { waiting = true; break; }
      }
      r.carWait = waiting ? r.carWait + dt : Math.max(0, r.carWait - dt);
      return;
    }
    // Towards the nearest sidewalk point (searched once, 8 directions).
    if (!r.drag) {
      const W = this.ctx.world;
      let best: { x: number; z: number } | null = null, bd = Infinity;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2, ux = Math.cos(a), uz = Math.sin(a);
        for (let d = 1; d <= 8; d += 0.5) {
          const x = r.x + ux * d, z = r.z + uz * d;
          if (W.buildingAt(x, z)) break;
          if (W.surfaceOffset(x, z) > 0.01) { if (d < bd) { bd = d; best = { x: x + ux * 0.6, z: z + uz * 0.6 }; } break; }
        }
      }
      if (!best) { r.inLane = false; return; }
      r.drag = best;
    }
    const dx = r.drag.x - r.x, dz = r.drag.z - r.z, d = Math.hypot(dx, dz);
    if (d < 0.05) { r.inLane = false; r.drag = undefined; r.onRoad = false; return; }
    const st = Math.min(d, dt * 1.1), mx = (dx / d) * st, mz = (dz / d) * st;
    r.x += mx; r.z += mz;
    const gy = this.ctx.terrain.height(r.x, r.z) + this.ctx.world.surfaceOffset(r.x, r.z);
    const my = (gy - r.y) * Math.min(1, dt * 8);
    r.y += my;
    const e = r.pose.elements;
    e[12] += mx; e[13] += my; e[14] += mz;
  }

  /** Robots on the carriageway (crossing, or lying there) for the cars to stop for. */
  obstacles(out: { x: number; z: number; r: number }[]): void {
    for (const r of this.list) {
      const lying = r.state >= RState.Down;
      if (lying ? !r.inLane : !(r.onRoad && r.state === RState.Drive)) continue;
      const K = KINDS[r.kind];
      out.push({ x: r.x, z: r.z, r: lying ? Math.max(K.w, K.l) / 2 + 0.1 : Math.max(K.w, K.l) / 2 });
    }
  }

  /** Knock a robot over (or push a lying one); a big impulse breaks it. */
  knock(r: Robot, jx: number, jy: number, jz: number): void {
    const J = Math.hypot(jx, jy, jz);
    if (r.crushed) return;
    const K = KINDS[r.kind];
    if (J > J_BREAK && r.state !== RState.Broken) this.breakIt(r, jx / J, jz / J);
    if (r.state < RState.Down) {
      r.state = RState.Down; r.stateT = 0; this.stats.knocked++; r.speed = 0;
      r.inLane = r.onRoad; r.carWait = 0;
      // A robot on its back: the curious stop and look.
      gawkAt(this.ctx.peds, r.x, r.y + 0.3, r.z, 14, 0.75);
    }
    const P = this.ctx.physics, R = P.R;
    if (!r.body) {
      // Body centre and orientation: upright on its wheels, or as it lies.
      if (r.pose) { r.pose.decompose(_p, _q, _s); _p.set(0, K.bodyY, 0).applyMatrix4(r.pose); }
      else { _q.setFromAxisAngle(_up, r.yaw); _p.set(r.x, r.y + K.bodyY, r.z); }
      r.body = P.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(_p.x, _p.y, _p.z).setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }).setAngularDamping(0.6).setLinearDamping(0.1).setCcdEnabled(true));
      P.world.createCollider(R.ColliderDesc.cuboid(K.w / 2, K.h / 2, K.l / 2).setDensity(K.mass / (K.w * K.h * K.l)).setFriction(0.7).setRestitution(0.15)
        .setCollisionGroups(this.ground ? GROUPS.smallBody : 0xffffffff), r.body);
      if (this.ground) this.ground.ensure(r.x, r.z, 12, r.y + 1); else P.ensureGround(r.x, r.z, 12);
      r.pose = new THREE.Matrix4();
      r.stateT = 0;
      r.drag = undefined;
    }
    // Velocity change capped (a punch sends it flying, not to orbit); hit above the centre so it tips.
    const k = Math.min(1, (K.mass * 6) / Math.max(1, J));
    const t = r.body.translation();
    r.body.applyImpulseAtPoint({ x: jx * k, y: Math.max(jy * k, J * k * 0.15), z: jz * k }, { x: t.x, y: t.y + K.h * 0.37, z: t.z }, true);
  }

  breakIt(r: Robot, dirX: number, dirZ: number): void {
    if (r.state === RState.Broken) return;
    r.state = RState.Broken;
    this.stats.broken++;
    const D = this.ctx.debris, y = r.y + 0.35;
    const shell = r.kind === RKind.Cleaner ? new THREE.Color(...MUNICIPAL) : new THREE.Color(0.9, 0.9, 0.88);
    D.chipBurst(r.x, y, r.z, 12, 3.5, dirX, 0.6, dirZ, shell, 0.07, 4);
    D.chipBurst(r.x, y, r.z, 4, 3, dirX, 0.4, dirZ, new THREE.Color(0.08, 0.08, 0.09), 0.09, 4);
    D.chipBurst(r.x, y + 0.1, r.z, 10, 5, 0, 1, 0, new THREE.Color(4, 2.2, 0.6), 0.025, 0.7);
    this.ctx.sound('metal_bend', r.x, y, r.z, 0.45, 1.6, 4);
    this.ctx.sound('glass_shatter', r.x, y, r.z, 0.25, 1.4, 3);
    gawkAt(this.ctx.peds, r.x, r.y + 0.3, r.z, 18, 1);
  }

  /** A giant's foot / falling rubble: flattened in place. */
  crush(x: number, z: number, rad: number): number {
    let n = 0;
    for (const r of this.list) {
      if (r.crushed || Math.hypot(r.x - x, r.z - z) > rad + 0.4) continue;
      this.breakIt(r, 0, 0);
      if (r.body) { this.ctx.physics.world.removeRigidBody(r.body); r.body = null; }
      r.state = RState.Broken; r.stateT = 0; r.crushed = true; r.inLane = r.onRoad;
      const g = this.ctx.terrain.height(r.x, r.z) + (r.onRoad ? 0 : CURB_H);
      r.pose = new THREE.Matrix4().compose(_p.set(r.x, g, r.z), _q.setFromAxisAngle(_up, r.yaw), _s.set(1.12, 0.32, 1.08));
      n++;
    }
    return n;
  }

  /** A strike at a point (punch, thrown object). Returns the number hit. */
  hit(x: number, y: number, z: number, rad: number, jx: number, jy: number, jz: number): number {
    const J = Math.hypot(jx, jy, jz);
    if (J < J_TOPPLE) return 0;
    let n = 0;
    for (const r of this.list) {
      if (r.crushed) continue;
      const d = Math.hypot(r.x - x, r.z - z);
      if (d > rad + 0.45 || y > r.y + 1.0 + rad || y < r.y - rad - 0.5) continue;
      this.knock(r, jx, jy, jz);
      n++;
    }
    return n;
  }

  private draw(cam: THREE.Camera): void {
    const b = this.batch, cb = this.cleanB, bb = this.brushB, cp = cam.position;
    b.begin(); cb.begin(); bb.begin();
    for (const r of this.list) {
      if (Math.abs(r.x - cp.x) > DRAW_R || Math.abs(r.z - cp.z) > DRAW_R) continue;
      if (r.pose) _m.copy(r.pose);
      else {
        // A little pitch when climbing the kerb is not worth it; a slight bob over the paving is.
        const bob = r.speed > 0.2 ? Math.sin(this.t * 22 + r.phase * 40) * 0.004 : 0;
        _m.compose(_p.set(r.x, r.y + bob, r.z), _q.setFromAxisAngle(_up, r.yaw), _s.set(1, 1, 1));
      }
      // Shrink ray.
      const sc = statusOf(r)?.scale ?? 1;
      if (sc !== 1) _m.multiply(_sm.makeScale(sc, sc, sc));
      if (r.kind === RKind.Cleaner) {
        // Beacon blinks amber while working; brushes spin while it drives.
        const mode = r.state === RState.Broken ? 2 : r.state === RState.Down || r.legs > 0 ? 1 : 0;
        cb.push(_m, MUNICIPAL[0], MUNICIPAL[1], MUNICIPAL[2], 1, 0, r.phase, mode);
        if (Math.abs(r.x - cp.x) > 70 || Math.abs(r.z - cp.z) > 70) continue;
        const spin = r.state < RState.Down && r.legs > 0 ? this.t * 11 + r.phase * 9 : r.phase * 9;
        for (let k = 0; k < 2; k++) {
          const p = CLEANER_BRUSHES[k];
          _m2.makeRotationY(k ? -spin : spin).setPosition(p[0], p[1], p[2]).premultiply(_m);
          bb.push(_m2, 0, 0, 0, 1, 0, 0, 0);
        }
        continue;
      }
      const c = FLEETS[r.fleet];
      const mode = r.state === RState.Broken ? 2 : r.state === RState.Wait || r.state === RState.Down || r.blocked > 1.5 ? 1 : 0;
      b.push(_m, c[0], c[1], c[2], 1, 0, r.phase, mode);
    }
    b.end(); cb.end(); bb.end();
    this.stats.drawn = b.n + cb.n;
  }

  private remove(i: number): void {
    const r = this.list[i];
    if (r.body) this.ctx.physics.world.removeRigidBody(r.body);
    this.list[i] = this.list[this.list.length - 1];
    this.list.pop();
  }

  dispose(): void {
    for (let i = this.list.length - 1; i >= 0; i--) this.remove(i);
  }
}

function clampAbs(v: number, m: number): number { return v > m ? m : v < -m ? -m : v; }

function routeLength(r: Float32Array): number {
  let s = 0;
  for (let i = 3; i < r.length; i += 3) s += Math.hypot(r[i] - r[i - 3], r[i + 1] - r[i - 2]);
  return s;
}

function advance(r: Robot, dist: number): void {
  const R = r.route;
  while (dist > 0 && r.wp < R.length / 3) {
    const tx = R[r.wp * 3], tz = R[r.wp * 3 + 1];
    const d = Math.hypot(tx - r.x, tz - r.z);
    if (d <= dist) { r.x = tx; r.z = tz; dist -= d; r.wp++; }
    else { r.x += ((tx - r.x) / d) * dist; r.z += ((tz - r.z) / d) * dist; dist = 0; }
  }
  r.onRoad = r.wp < R.length / 3 && R[r.wp * 3 + 2] > 0.5;
}

