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
 */
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { Rng, deriveSeed, hash32 } from '../core/rng';
import { CURB_H } from '../build/ground';
import { doorOf } from '../sim/Population';
import type { PedAgent } from '../sim/Pedestrians';
import type { BuildingRef } from '../world/WorldIndex';
import { VState } from '../sim/Traffic';
import { FurnBatch } from './batch';
import { robotGeometry, ROBOT } from './models';
import { FLEETS, type FutureCtx, type PlayerProbe } from './ctx';

export const enum RState { Drive = 0, Wait = 1, Deliver = 2, Down = 3, Broken = 4 }

export interface Robot {
  id: number;
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
}

const MAX_ROBOTS = 150;
const SCAN_R = 320;
const DESPAWN_R = 460;
const DRAW_R = 260;
const VMAX = 1.7;
const BODY_Y = 0.32;
/** Impulses (N·s): knocked over / broken. */
const J_TOPPLE = 60;
const J_BREAK = 900;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);
const _off = new THREE.Matrix4().makeTranslation(0, -BODY_Y, 0);

export class Robots {
  readonly group = new THREE.Group();
  readonly list: Robot[] = [];
  private batch: FurnBatch;
  private rng: Rng;
  private nextId = 1;
  private t = 0;
  private spawnT = 0;
  private target = 0;
  private hubs: BuildingRef[] = [];
  private homes: BuildingRef[] = [];
  private scanT = -10;
  private nb: PedAgent[] = [];
  stats = { robots: 0, target: 0, hubs: 0, drawn: 0, knocked: 0, broken: 0 };

  constructor(private ctx: FutureCtx, mat: THREE.Material) {
    this.batch = new FurnBatch(robotGeometry(), mat, MAX_ROBOTS + 16);
    this.group.add(this.batch.mesh);
    this.rng = new Rng(deriveSeed(ctx.seed, 'robots'));
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
      this.stats.hubs = this.hubs.length;
      this.stats.target = this.target;
    }
    // One spawn (one route search) at a time.
    this.spawnT -= dt;
    const active = this.list.length;
    if (this.spawnT <= 0 && active < this.target && this.hubs.length && this.homes.length && this.ctx.peds) {
      this.spawnT = active < this.target * 0.5 ? 0.05 : 0.6;
      this.spawn(px, pz, active < this.target * 0.5);
    }
    for (let i = this.list.length - 1; i >= 0; i--) {
      const r = this.list[i];
      const d = Math.hypot(r.x - px, r.z - pz);
      // Distant robots step at a quarter of the rate.
      if (d > 120 && r.state < RState.Down) { if ((i + Math.floor(this.t * 60)) % 4 === 0) this.step(r, dt * 4, player); }
      else this.step(r, dt, player);
      const stale = r.state >= RState.Down && r.stateT > 150 && d > 40;
      if (!r.alive || d > DESPAWN_R || stale) this.remove(i);
    }
    this.draw(cam);
    this.stats.robots = this.list.length;
  }

  private pickNear(list: BuildingRef[], x: number, z: number, rMin: number, rMax: number): BuildingRef | null {
    for (let k = 0; k < 8; k++) {
      const b = list[this.rng.int(0, list.length - 1)];
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
      phase: this.rng.float(), body: null, pose: null, crushed: false, alive: true,
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

  private groundY(x: number, z: number, onRoad: boolean): number {
    return this.ctx.terrain.height(x, z) + (onRoad ? 0 : CURB_H);
  }

  private step(r: Robot, dt: number, player: PlayerProbe): void {
    r.stateT += dt;
    if (r.state >= RState.Down) { this.stepDown(r); return; }
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
    const R = r.route;
    if (r.wp >= R.length / 3) { r.state = RState.Deliver; r.stateT = 0; r.speed = 0; return; }
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
    let want = VMAX, near = 9;
    const lookX = r.x + fx * 1.2, lookZ = r.z + fz * 1.2;
    for (const a of this.ctx.peds.neighbours(lookX, lookZ, 1.8, this.nb)) {
      if (a.state === 5 || a.inside) continue;
      const ox = a.x - r.x, oz = a.z - r.z;
      const along = ox * fx + oz * fz, lat = -ox * fz + oz * fx;
      const d = Math.hypot(ox, oz);
      // Nudge people out of the robot's box (they do not see it).
      if (d < 0.62 && d > 1e-3) { a.x += (ox / d) * (0.62 - d) * 0.6; a.z += (oz / d) * (0.62 - d) * 0.6; }
      if (along > 0 && along < 2.6 && Math.abs(lat - r.swerve) < 0.75) near = Math.min(near, along);
    }
    if (player.active && player.height > 0.4) {
      const ox = player.x - r.x, oz = player.z - r.z;
      const along = ox * fx + oz * fz, lat = -ox * fz + oz * fx;
      if (along > 0 && along < 2.6 + player.radius && Math.abs(lat - r.swerve) < 0.6 + player.radius) near = Math.min(near, along - player.radius);
    }
    if (near < 0.9) { want = 0; r.blocked += dt; }
    else if (near < 2.6) { want = VMAX * 0.45; r.blocked = Math.max(0, r.blocked - dt); }
    else r.blocked = Math.max(0, r.blocked - dt * 2);
    // Swerve towards the right edge of the sidewalk while something is ahead (never on the road).
    const swTarget = near < 2.6 && !r.onRoad ? 0.55 : 0;
    r.swerve += (swTarget - r.swerve) * Math.min(1, dt * 1.5);
    // Stuck for a long time (a crowd): creep on.
    if (r.blocked > 8) want = 0.3;
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
    // Crossing: a car that does not stop runs it over.
    if (r.onRoad) {
      for (const v of this.ctx.traffic.vehicles) {
        if (v.speed < 2.5 || (v.state !== VState.Drive && v.state !== VState.Fleeing)) continue;
        const vx = r.x - v.x, vz = r.z - v.z;
        if (vx * vx + vz * vz > (v.length / 2 + 0.6) ** 2) continue;
        const cfx = -Math.sin(v.yaw), cfz = -Math.cos(v.yaw);
        if (Math.abs(vx * -cfz + vz * cfx) > v.width / 2 + 0.3) continue;
        this.knock(r, cfx * v.speed * 40, v.speed * 12, cfz * v.speed * 40);
        this.ctx.sound('car_crash', r.x, r.y, r.z, 0.35, 1.5, 4);
        break;
      }
    }
    // The player's body: walking into a robot pushes it; running into it or a big body knocks it over.
    if (player.active && player.height > 0.5) {
      const ox = r.x - player.x, oz = r.z - player.z, d = Math.hypot(ox, oz);
      const rr = player.radius + 0.36;
      if (d < rr && d > 1e-3 && Math.abs(player.y - r.y) < player.height) {
        const sp = Math.hypot(player.vx, player.vz);
        if (sp > 3.2 || player.mass > 400) this.knock(r, (ox / d) * player.mass * Math.max(1, sp) * 0.25, 20, (oz / d) * player.mass * Math.max(1, sp) * 0.25);
        else { r.x = player.x + (ox / d) * rr; r.z = player.z + (oz / d) * rr; }
      }
    }
  }

  /** Lying / tumbling robots follow their rigid body until it rests. */
  private stepDown(r: Robot): void {
    const b = r.body;
    if (!b) return;
    const t = b.translation(), q = b.rotation();
    // Pushed into a building edge the box can tunnel under the ground heightfield: back up.
    const g = this.ctx.terrain.height(t.x, t.z);
    if (t.y < g - 0.4) {
      b.setTranslation({ x: r.x, y: Math.max(r.y + BODY_Y, g + 0.6), z: r.z }, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      return;
    }
    r.x = t.x; r.y = t.y - BODY_Y; r.z = t.z;
    _m.compose(_p.set(t.x, t.y, t.z), _q.set(q.x, q.y, q.z, q.w), _s.set(1, 1, 1)).multiply(_off);
    r.pose!.copy(_m);
    if ((b.isSleeping() && r.stateT > 1.5) || r.stateT > 25 || t.y < -100) {
      this.ctx.physics.world.removeRigidBody(b);
      r.body = null;
    }
  }

  /** Knock a robot over (or push a lying one); a big impulse breaks it. */
  knock(r: Robot, jx: number, jy: number, jz: number): void {
    const J = Math.hypot(jx, jy, jz);
    if (r.crushed) return;
    if (J > J_BREAK && r.state !== RState.Broken) this.breakIt(r, jx / J, jz / J);
    if (r.state < RState.Down) { r.state = RState.Down; r.stateT = 0; this.stats.knocked++; r.speed = 0; }
    const P = this.ctx.physics, R = P.R;
    if (!r.body) {
      // Body centre and orientation: upright on its wheels, or as it lies.
      if (r.pose) { r.pose.decompose(_p, _q, _s); _p.set(0, BODY_Y, 0).applyMatrix4(r.pose); }
      else { _q.setFromAxisAngle(_up, r.yaw); _p.set(r.x, r.y + BODY_Y, r.z); }
      r.body = P.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(_p.x, _p.y, _p.z).setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }).setAngularDamping(0.6).setLinearDamping(0.1).setCcdEnabled(true));
      P.world.createCollider(R.ColliderDesc.cuboid(ROBOT.width / 2 - 0.02, 0.3, ROBOT.length / 2).setDensity(ROBOT.mass / (ROBOT.width * 0.6 * ROBOT.length)).setFriction(0.7).setRestitution(0.15), r.body);
      P.ensureGround(r.x, r.z, 12);
      r.pose = new THREE.Matrix4();
      r.stateT = 0;
    }
    // Velocity change capped (a punch sends it flying, not to orbit); hit above the centre so it tips.
    const k = Math.min(1, (ROBOT.mass * 6) / Math.max(1, J));
    const t = r.body.translation();
    r.body.applyImpulseAtPoint({ x: jx * k, y: Math.max(jy * k, J * k * 0.15), z: jz * k }, { x: t.x, y: t.y + 0.22, z: t.z }, true);
  }

  breakIt(r: Robot, dirX: number, dirZ: number): void {
    if (r.state === RState.Broken) return;
    r.state = RState.Broken;
    this.stats.broken++;
    const D = this.ctx.debris, y = r.y + 0.35;
    D.chipBurst(r.x, y, r.z, 12, 3.5, dirX, 0.6, dirZ, new THREE.Color(0.9, 0.9, 0.88), 0.07, 4);
    D.chipBurst(r.x, y, r.z, 4, 3, dirX, 0.4, dirZ, new THREE.Color(0.08, 0.08, 0.09), 0.09, 4);
    D.chipBurst(r.x, y + 0.1, r.z, 10, 5, 0, 1, 0, new THREE.Color(4, 2.2, 0.6), 0.025, 0.7);
    this.ctx.sound('metal_bend', r.x, y, r.z, 0.45, 1.6, 4);
    this.ctx.sound('glass_shatter', r.x, y, r.z, 0.25, 1.4, 3);
  }

  /** A giant's foot / falling rubble: flattened in place. */
  crush(x: number, z: number, rad: number): number {
    let n = 0;
    for (const r of this.list) {
      if (r.crushed || Math.hypot(r.x - x, r.z - z) > rad + 0.4) continue;
      this.breakIt(r, 0, 0);
      if (r.body) { this.ctx.physics.world.removeRigidBody(r.body); r.body = null; }
      r.state = RState.Broken; r.stateT = 0; r.crushed = true;
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
    const b = this.batch, cp = cam.position;
    b.begin();
    for (const r of this.list) {
      if (Math.abs(r.x - cp.x) > DRAW_R || Math.abs(r.z - cp.z) > DRAW_R) continue;
      if (r.pose) _m.copy(r.pose);
      else {
        // A little pitch when climbing the kerb is not worth it; a slight bob over the paving is.
        const bob = r.speed > 0.2 ? Math.sin(this.t * 22 + r.phase * 40) * 0.004 : 0;
        _m.compose(_p.set(r.x, r.y + bob, r.z), _q.setFromAxisAngle(_up, r.yaw), _s.set(1, 1, 1));
      }
      const c = FLEETS[r.fleet];
      const mode = r.state === RState.Broken ? 2 : r.state === RState.Wait || r.state === RState.Down || r.blocked > 1.5 ? 1 : 0;
      b.push(_m, c[0], c[1], c[2], 1, 0, r.phase, mode);
    }
    b.end();
    this.stats.drawn = b.n;
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

