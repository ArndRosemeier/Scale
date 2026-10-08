/**
 * Humanoid service robots (PLAYGROUND_PLAN decision 16): a few slim white humanoids at fixed
 * posts - directing traffic on the corner of busy signalled junctions (one arm points the
 * flow that has green, the other waves it on; both hands up while all is red) and greeting at
 * the entrances of big shops and office towers (hands folded, head following passers-by, a
 * wave for whoever comes close). Posts are a pure function of (seed, junction / building), so
 * the same robots stand in the same places every visit; they work by day.
 *
 * Articulated rather than skinned: body, head, upper arms and forearms are separate instanced
 * parts in the furniture material, posed per frame (cheap: at most MAX_BOTS of them). They
 * are physical like the delivery robots: a shove topples them (Rapier box, lying limp), a hard
 * hit breaks them (sparks, visor dark), a giant's foot flattens them. People make room for
 * them and stop to look at a fallen one; the player bumps into them.
 */
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { hash32 } from '../core/rng';
import { CURB_H } from '../build/ground';
import { doorOf } from '../sim/Population';
import { type PedAgent, isUp } from '../sim/Pedestrians';
import type { Obstacle, ObstacleProvider } from '../world/Collision';
import { GROUPS } from '../physics/Physics';
import { FurnBatch } from './batch';
import { HUMANOID, humanoidBodyGeometry, humanoidHeadGeometry, humanoidUpperArmGeometry, humanoidForearmGeometry } from './models';
import type { FutureCtx, PlayerProbe } from './ctx';
import { gawkAt } from './attention';
import type { LocalGround } from './ground';
import { statusOf } from '../shared/status';
import { malLed, MAL_KEEP_R, ROGUE_RED, type Malfunction, type MalfunctionCtl } from './malfunction';
const _sm = new THREE.Matrix4();

const enum Role { Director = 0, Greeter = 1 }
export const enum BState { Stand = 0, Down = 1, Broken = 2 }

interface Post {
  key: number;
  role: Role;
  x: number; z: number; yaw: number;
  /** Director: the junction (position; index refreshed when the road graph is rebuilt). */
  nx: number; nz: number;
}

export type ServiceBot = Bot;

interface Bot {
  post: Post;
  x: number; y: number; z: number; yaw: number;
  state: BState;
  stateT: number;
  head: number; headP: number;
  /** Who it looks at (greeter) and how long until it looks round again. */
  lookX: number; lookZ: number; lookT: number;
  waveT: number; waveCool: number;
  phase: number;
  body: RAPIER.RigidBody | null;
  pose: THREE.Matrix4 | null;
  crushed: boolean;
  inLane: boolean;
  alive: boolean;
  node: number; nodeVer: number;
  /** Glitching or gone rogue (a threat): driven by the malfunction controller. */
  mal?: Malfunction;
}

const MAX_BOTS = 16;
const RANGE = 170;
const DRAW_R = 150;
const ANIM_R = 90;
const HALF = HUMANOID.height / 2;
const J_TOPPLE = 50;
const J_BREAK = 1100;
/** Accent colours (sRGB): high-vis yellow for traffic, teal for greeters. */
const ACCENT: [number, number, number][] = [[0.98, 0.78, 0.05], [0.05, 0.62, 0.6]];

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _m3 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _v = new THREE.Vector3();
const _e = new THREE.Euler();
const _up = new THREE.Vector3(0, 1, 0);
const _down = new THREE.Vector3(0, -1, 0);
const _one = new THREE.Vector3(1, 1, 1);

export class ServiceBots {
  readonly group = new THREE.Group();
  readonly list: Bot[] = [];
  private bodyB: FurnBatch;
  private headB: FurnBatch;
  private upperB: FurnBatch;
  private foreB: FurnBatch;
  private posts: Post[] = [];
  /** Posts whose robot was knocked down: empty until then (game time). */
  private vacant = new Map<number, number>();
  private scanT = -10;
  private t = 0;
  private nb: PedAgent[] = [];
  ground: LocalGround | null = null;
  /** Steps malfunctioning robots (the threat layer; set by NearFuture). */
  mal: MalfunctionCtl | null = null;
  stats = { bots: 0, posts: 0, drawn: 0, knocked: 0 };

  constructor(private ctx: FutureCtx, mat: THREE.Material) {
    this.bodyB = new FurnBatch(humanoidBodyGeometry(), mat, MAX_BOTS);
    this.headB = new FurnBatch(humanoidHeadGeometry(), mat, MAX_BOTS);
    this.upperB = new FurnBatch(humanoidUpperArmGeometry(), mat, MAX_BOTS * 2);
    this.foreB = new FurnBatch(humanoidForearmGeometry(), mat, MAX_BOTS * 2);
    this.group.add(this.bodyB.mesh, this.headB.mesh, this.upperB.mesh, this.foreB.mesh);
  }

  update(dt: number, hours: number, px: number, pz: number, player: PlayerProbe, cam: THREE.Camera): void {
    this.t += dt;
    if (this.t - this.scanT > 4) { this.scanT = this.t; this.scan(px, pz); }
    const h = ((hours % 24) + 24) % 24;
    // Posts: staffed by day (traffic duty 7-21, greeters 8-21); spawn / leave out of sight.
    for (const p of this.posts) {
      const on = p.role === Role.Director ? h >= 7 && h < 21 : h >= 8 && h < 21;
      const d = Math.hypot(p.x - px, p.z - pz);
      const bot = this.list.find((b) => b.post === p);
      if (!bot && on && d < RANGE && (d > 45 || this.t < 6) && this.list.length < MAX_BOTS && !((this.vacant.get(p.key) ?? -1e9) > this.t)) this.spawn(p);
      else if (bot && !on && d > 45 && bot.state === BState.Stand && !bot.mal) bot.alive = false;
    }
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i];
      const d = Math.hypot(b.x - px, b.z - pz);
      this.step(b, dt, d, player);
      if (b.state !== BState.Stand && b.stateT > 90 && d > 40) { this.vacant.set(b.post.key, this.t + 240); b.alive = false; }
      if (!b.alive || d > (b.mal ? MAL_KEEP_R : RANGE + 40)) this.remove(i);
    }
    this.draw(cam);
    this.stats.bots = this.list.length;
  }

  /** Posts near the player: busy signalled junction corners, big shop / office entrances. */
  private scan(px: number, pz: number): void {
    const seed = this.ctx.seed, posts: Post[] = [];
    const W = this.ctx.world, net = this.ctx.net;
    for (let ni = 0; ni < net.nodes.length; ni++) {
      const n = net.nodes[ni];
      if (!n.signal || n.edges.length < 4 || Math.abs(n.x - px) > RANGE || Math.abs(n.z - pz) > RANGE) continue;
      const key = hash32(Math.round(n.x * 2) * 73856093 ^ Math.round(n.z * 2) * 19349663 ^ seed);
      if (key % 100 >= 22) continue;
      if (!n.edges.some((e) => net.edges[e].cls <= 1)) continue;
      // A corner between two neighbouring streets.
      const dirs = n.edges.map((ei) => {
        const e = net.edges[ei], p = e.pts, m = p.length;
        const out = e.a === ni ? [p[2] - p[0], p[3] - p[1]] : [p[m - 4] - p[m - 2], p[m - 3] - p[m - 1]];
        const l = Math.hypot(out[0], out[1]) || 1;
        return { x: out[0] / l, z: out[1] / l, a: Math.atan2(out[1], out[0]), e };
      }).sort((a, b) => a.a - b.a);
      const k = (key >>> 8) % dirs.length, d1 = dirs[k], d2 = dirs[(k + 1) % dirs.length];
      const o1 = d2.e.width / 2 + d2.e.sidewalk * 0.6, o2 = d1.e.width / 2 + d1.e.sidewalk * 0.6;
      const x = n.x + d1.x * o1 + d2.x * o2, z = n.z + d1.z * o1 + d2.z * o2;
      if (W.buildingAt(x, z) || W.surfaceOffset(x, z) < 0.01) continue;
      posts.push({ key, role: Role.Director, x, z, yaw: Math.atan2(-(n.x - x), -(n.z - z)), nx: n.x, nz: n.z });
    }
    for (const r of W.buildingsIn(px - RANGE, pz - RANGE, px + RANGE, pz + RANGE)) {
      const D = r.desc;
      if (!r.alive || r.top - r.base < 14 || !(D.shopfront || D.use === 'retail' || D.use === 'office')) continue;
      const key = hash32(D.seed * 2654435761 ^ seed);
      if (key % 100 >= 7) continue;
      const door = doorOf(D), side = key & 256 ? 1 : -1;
      const x = door.x + door.nx * 0.5 - door.nz * 1.1 * side, z = door.z + door.nz * 0.5 + door.nx * 1.1 * side;
      if (W.buildingAt(x, z)) continue;
      posts.push({ key, role: Role.Greeter, x, z, yaw: Math.atan2(-door.nx, -door.nz), nx: 0, nz: 0 });
    }
    // Keep the posts robots stand at (their keys are stable).
    for (const b of this.list) if (!posts.some((p) => p.key === b.post.key)) posts.push(b.post);
    else b.post = posts.find((p) => p.key === b.post.key)!;
    this.posts = posts;
    this.stats.posts = posts.length;
  }

  /** A service robot standing at (x, z) facing yaw, off any post (a malfunction drives it). */
  spawnAt(x: number, z: number, yaw: number): ServiceBot | null {
    if (this.list.length >= MAX_BOTS) return null;
    const key = (hash32(Math.round(x * 7) ^ Math.round(z * 13) * 7919 ^ this.ctx.seed) | 1) >>> 0;
    this.spawn({ key, role: Role.Greeter, x, z, yaw, nx: 0, nz: 0 });
    return this.list[this.list.length - 1];
  }

  private spawn(p: Post): void {
    this.list.push({
      post: p, x: p.x, y: this.ctx.terrain.height(p.x, p.z) + CURB_H, z: p.z, yaw: p.yaw, state: BState.Stand, stateT: 0,
      head: 0, headP: 0, lookX: 0, lookZ: 0, lookT: 0, waveT: 0, waveCool: 0, phase: (p.key % 1000) / 1000,
      body: null, pose: null, crushed: false, inLane: false, alive: true, node: -1, nodeVer: -1,
    });
  }

  private step(b: Bot, dt: number, dist: number, player: PlayerProbe): void {
    b.stateT += dt;
    if (b.mal && this.mal?.bot(b, dt, player)) return;
    if (b.state !== BState.Stand) { this.stepDown(b); return; }
    // People make room (it stands in the sidewalk flow); the player bumps into it.
    if (dist < 110) {
      for (const a of this.ctx.peds.neighbours(b.x, b.z, 1.6, this.nb)) {
        if (!isUp(a)) continue;
        const ox = a.x - b.x, oz = a.z - b.z, d = Math.hypot(ox, oz);
        if (d < 1e-3 || d > 1.6) continue;
        if (d < 0.5) { a.x = b.x + (ox / d) * 0.5; a.z = b.z + (oz / d) * 0.5; }
        if (a.state === 0) { a.sideX = (ox / d) * 0.7; a.sideZ = (oz / d) * 0.7; a.sideT = 0.25; }
      }
    }
    if (player.active && player.height > 0.5) {
      const ox = b.x - player.x, oz = b.z - player.z, d = Math.hypot(ox, oz);
      if (d < player.radius + 0.45 && d > 1e-3 && Math.abs(player.y - b.y) < player.height) {
        const sp = Math.hypot(player.vx, player.vz);
        if (sp > 3 || player.mass > 300) this.knock(b, (ox / d) * player.mass * Math.max(1, sp) * 0.25, 10, (oz / d) * player.mass * Math.max(1, sp) * 0.25);
      }
    }
    if (dist > ANIM_R) return;
    // Who to look at: the nearest passer-by (greeters wave at those who come close).
    b.lookT -= dt;
    b.waveT = Math.max(0, b.waveT - dt);
    b.waveCool -= dt;
    if (b.lookT <= 0) {
      b.lookT = 0.6;
      let best: PedAgent | null = null, bd = b.post.role === Role.Greeter ? 7 : 5;
      for (const a of this.ctx.peds.neighbours(b.x, b.z, bd, this.nb)) {
        if (!isUp(a)) continue;
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        // Only in front (a head turns ±70°).
        if (d < bd && (a.x - b.x) * -Math.sin(b.yaw) + (a.z - b.z) * -Math.cos(b.yaw) > -d * 0.3) { bd = d; best = a; }
      }
      if (player.active && player.height > 0.3 && player.height < 3) {
        const d = Math.hypot(player.x - b.x, player.z - b.z);
        if (d < bd) { bd = d; best = null; b.lookX = player.x; b.lookZ = player.z; }
      }
      if (best) { b.lookX = best.x; b.lookZ = best.z; }
      else if (bd >= (b.post.role === Role.Greeter ? 7 : 5)) { b.lookX = NaN; }
      if (b.post.role === Role.Greeter && bd < 3.2 && b.waveCool <= 0) {
        b.waveT = 2.2; b.waveCool = 7 + b.phase * 4;
        // Greeted: they look back.
        if (best) { best.glance = 1.8; best.lookX = b.x; best.lookY = b.y + 1.55; best.lookZ = b.z; }
      }
    }
    let ty = 0, tp = 0;
    if (!Number.isNaN(b.lookX)) {
      const dx = b.lookX - b.x, dz = b.lookZ - b.z;
      ty = Math.atan2(-dx, -dz) - b.yaw;
      while (ty > Math.PI) ty -= Math.PI * 2;
      while (ty < -Math.PI) ty += Math.PI * 2;
      ty = Math.max(-1.2, Math.min(1.2, ty));
      tp = -0.12;
    } else if (b.post.role === Role.Director) {
      // Watching the traffic: slow sweeps across the junction.
      ty = Math.sin(this.t * 0.4 + b.phase * 6) * 0.9;
    } else ty = Math.sin(this.t * 0.25 + b.phase * 6) * 0.35;
    b.head += (ty - b.head) * Math.min(1, dt * 3);
    b.headP += (tp - b.headP) * Math.min(1, dt * 3);
  }

  private stepDown(b: Bot): void {
    const body = b.body;
    if (!body) return;
    const t = body.translation(), q = body.rotation();
    const G = this.ground;
    const g = G ? G.streetY(t.x, t.z, b.y + 1) : this.ctx.terrain.height(t.x, t.z);
    if (t.y < g - 0.4) { body.setTranslation({ x: b.x, y: g + HALF + 0.1, z: b.z }, true); body.setLinvel({ x: 0, y: 0, z: 0 }, true); return; }
    const out = G?.resolve(t.x, t.y, t.z, 0.5);
    if (out) {
      body.setTranslation({ x: out.x, y: Math.max(t.y, g + 0.3), z: out.z }, true);
      const lv = body.linvel(), vn = lv.x * out.nx + lv.z * out.nz;
      if (vn < 0) body.setLinvel({ x: lv.x - out.nx * vn * 1.3, y: lv.y, z: lv.z - out.nz * vn * 1.3 }, true);
      return;
    }
    G?.ensure(t.x, t.z, 4, t.y);
    b.x = t.x; b.y = t.y - HALF; b.z = t.z;
    b.pose!.compose(_p.set(t.x, t.y, t.z), _q.set(q.x, q.y, q.z, q.w), _one).multiply(_m3.makeTranslation(0, -HALF, 0));
    if ((body.isSleeping() && b.stateT > 1.5) || b.stateT > 25 || t.y < -100) {
      this.ctx.physics.world.removeRigidBody(body);
      b.body = null;
      b.inLane = this.ctx.world.surfaceOffset(b.x, b.z) < 0.01;
    }
  }

  /** Topple (or push a lying one); a big impulse breaks it. */
  knock(b: Bot, jx: number, jy: number, jz: number): void {
    if (b.crushed) return;
    const J = Math.hypot(jx, jy, jz);
    if (b.mal) this.mal?.hit('bot', b, J);
    if (J > J_BREAK) this.breakIt(b);
    if (b.state === BState.Stand) {
      b.state = BState.Down; b.stateT = 0; this.stats.knocked++;
      gawkAt(this.ctx.peds, b.x, b.y + 0.4, b.z, 16, 0.85);
    }
    const P = this.ctx.physics, R = P.R;
    if (!b.body) {
      if (b.pose) { b.pose.decompose(_p, _q, _s); _p.set(0, HALF, 0).applyMatrix4(b.pose); }
      else { _q.setFromAxisAngle(_up, b.yaw); _p.set(b.x, b.y + HALF, b.z); }
      b.body = P.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(_p.x, _p.y, _p.z).setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }).setAngularDamping(0.5).setLinearDamping(0.1).setCcdEnabled(true));
      P.world.createCollider(R.ColliderDesc.cuboid(0.21, HALF, 0.13).setDensity(HUMANOID.mass / (0.42 * HUMANOID.height * 0.26)).setFriction(0.7).setRestitution(0.1)
        .setCollisionGroups(this.ground ? GROUPS.smallBody : 0xffffffff), b.body);
      if (this.ground) this.ground.ensure(b.x, b.z, 12, b.y + 1); else P.ensureGround(b.x, b.z, 12);
      b.pose = new THREE.Matrix4();
      b.stateT = 0;
    }
    const k = Math.min(1, (HUMANOID.mass * 5) / Math.max(1, J));
    const t = b.body.translation();
    // High on the body: it tips over rather than sliding.
    b.body.applyImpulseAtPoint({ x: jx * k, y: Math.max(jy * k, 0), z: jz * k }, { x: t.x, y: t.y + HALF * 0.6, z: t.z }, true);
  }

  breakIt(b: Bot): void {
    if (b.state === BState.Broken) return;
    b.state = BState.Broken; b.stateT = 0;
    const D = this.ctx.debris, y = b.y + 1.2;
    D.chipBurst(b.x, y, b.z, 12, 3.5, 0, 0.6, 0, new THREE.Color(0.92, 0.92, 0.9), 0.06, 4);
    D.chipBurst(b.x, y, b.z, 5, 3, 0, 0.4, 0, new THREE.Color(0.1, 0.1, 0.11), 0.07, 4);
    D.chipBurst(b.x, y + 0.2, b.z, 12, 5, 0, 1, 0, new THREE.Color(4, 2.2, 0.6), 0.025, 0.7);
    this.ctx.sound('metal_bend', b.x, y, b.z, 0.5, 1.3, 5);
    gawkAt(this.ctx.peds, b.x, b.y + 0.4, b.z, 18, 1);
  }

  crush(x: number, z: number, rad: number): void {
    for (const b of this.list) {
      if (b.crushed || Math.hypot(b.x - x, b.z - z) > rad + 0.3) continue;
      this.breakIt(b);
      if (b.body) { this.ctx.physics.world.removeRigidBody(b.body); b.body = null; }
      b.crushed = true; b.state = BState.Broken; b.stateT = 0;
      const g = this.ctx.terrain.height(b.x, b.z) + CURB_H;
      // Flat on its back, squashed.
      _q.setFromAxisAngle(_up, b.yaw).multiply(_q2.setFromAxisAngle(_v.set(1, 0, 0), Math.PI / 2));
      b.pose = new THREE.Matrix4().compose(_p.set(b.x, g + 0.05, b.z), _q, _s.set(1.1, 1, 0.35));
    }
  }

  hit(x: number, y: number, z: number, rad: number, jx: number, jy: number, jz: number, skip?: (b: ServiceBots['list'][number]) => boolean): void {
    if (Math.hypot(jx, jy, jz) < J_TOPPLE) return;
    for (const b of this.list) {
      if (b.crushed || skip?.(b) || Math.hypot(b.x - x, b.z - z) > rad + 0.35 || y > b.y + HUMANOID.height + rad || y < b.y - rad) continue;
      this.knock(b, jx, jy, jz);
    }
  }

  /** Blast / collapse push. */
  push(x: number, z: number, r: number, J: number): void {
    for (const b of this.list) {
      const dx = b.x - x, dz = b.z - z, d = Math.hypot(dx, dz);
      if (d < r && d > 1e-3) this.knock(b, (dx / d) * J / Math.max(1, d), J * 0.2, (dz / d) * J / Math.max(1, d));
    }
  }

  /** Fallen robots lying in a traffic lane (for a while; then the cars go round them). */
  obstacles(out: { x: number; z: number; r: number }[]): void {
    for (const b of this.list) if (b.inLane && b.stateT < 40) out.push({ x: b.x, z: b.z, r: 1 });
  }

  /** Standing robots as player obstacles (thin cylinders). */
  readonly provider: ObstacleProvider = (x0, z0, x1, z1, out) => {
    for (const b of this.list) {
      if (b.state !== BState.Stand || b.x < x0 - 1 || b.x > x1 + 1 || b.z < z0 - 1 || b.z > z1 + 1) continue;
      const o = this.obst;
      o.x = b.x; o.z = b.z; o.y0 = b.y; o.y1 = b.y + HUMANOID.height;
      out(o);
    }
  };
  private obst: Obstacle = { cyl: true, x: 0, z: 0, r: 0.26, hx: 0, hz: 0, ux: 1, uz: 0, y0: 0, y1: 0 };

  private draw(cam: THREE.Camera): void {
    const cp = cam.position;
    this.bodyB.begin(); this.headB.begin(); this.upperB.begin(); this.foreB.begin();
    let n = 0;
    for (const b of this.list) {
      if (Math.abs(b.x - cp.x) > DRAW_R || Math.abs(b.z - cp.z) > DRAW_R) continue;
      const c = b.mal?.mode === 'hostile' && b.state !== BState.Broken ? ROGUE_RED : ACCENT[b.post.role];
      const mode = b.state === BState.Broken ? 2 : b.mal ? malLed(b.mal) : b.state === BState.Down ? 1 : 0;
      if (b.pose) _m.copy(b.pose);
      else if (b.mal?.mode === 'hostile') {
        // Stalking: a stiff side-to-side rock with every step, leaning into the walk.
        const st = Math.sin(this.t * 7 + b.phase * 9);
        _q.setFromEuler(_e.set(-0.08, b.yaw + st * 0.06, st * 0.05, 'YXZ'));
        _m.compose(_p.set(b.x, b.y + Math.abs(st) * 0.03, b.z), _q, _one);
      } else {
        // Idle: a slow weight shift.
        const sway = Math.sin(this.t * 0.9 + b.phase * 7) * 0.012;
        _m.compose(_p.set(b.x, b.y, b.z), _q.setFromAxisAngle(_up, b.yaw + sway), _one);
      }
      // Shrink ray.
      const sc = statusOf(b)?.scale ?? 1;
      if (sc !== 1) _m.multiply(_sm.makeScale(sc, sc, sc));
      this.bodyB.push(_m, c[0], c[1], c[2], 1, 0, b.phase, mode);
      // Head.
      const hy = b.state === BState.Broken ? 0.5 : b.state === BState.Down ? 0 : b.head;
      const hp = b.state === BState.Broken ? 0.45 : b.headP;
      _q.setFromEuler(_e.set(hp, hy, 0, 'YXZ'));
      _m2.compose(_p.set(HUMANOID.neck[0], HUMANOID.neck[1], HUMANOID.neck[2]), _q, _one).premultiply(_m);
      this.headB.push(_m2, c[0], c[1], c[2], 1, 0, b.phase, mode);
      // Arms.
      for (const side of [-1, 1]) {
        const elbow = this.armPose(b, side, _q);
        _m2.compose(_p.set(HUMANOID.shoulder[0] * side, HUMANOID.shoulder[1], HUMANOID.shoulder[2]), _q, _one).premultiply(_m);
        this.upperB.push(_m2, c[0], c[1], c[2], 1, 0, 0, 0);
        _m3.compose(_p.set(HUMANOID.elbow[0], HUMANOID.elbow[1], HUMANOID.elbow[2]), elbow, _one).premultiply(_m2);
        this.foreB.push(_m3, c[0], c[1], c[2], 1, 0, 0, 0);
      }
      n++;
    }
    this.bodyB.end(); this.headB.end(); this.upperB.end(); this.foreB.end();
    this.stats.drawn = n;
  }

  private elbowQ = new THREE.Quaternion();
  private _u = new THREE.Vector3();
  private _f = new THREE.Vector3();

  /**
   * Arm pose from two directions in the body frame (front -Z, right +X): the upper arm's and
   * the forearm's. Sets the upper arm rotation into q and returns the forearm rotation in the
   * upper arm's frame.
   */
  private armPose(b: Bot, side: number, q: THREE.Quaternion): THREE.Quaternion {
    const u = this._u, f = this._f;
    const t = this.t + b.phase * 10;
    if (b.state !== BState.Stand) {
      // Limp.
      u.set(side * 0.25, -1, 0.1); f.set(side * 0.2, -1, -0.15);
    } else if (b.mal?.mode === 'hostile') {
      // Arms raised forward, the right one swinging down in a blow while it attacks.
      const sw = side === 1 ? b.mal.swing : 0;
      u.set(side * 0.3, -0.25 + 0.9 * sw, -1); f.set(side * 0.1, 0.2 - 1.2 * sw, -1);
    } else if (b.mal?.mode === 'glitch') {
      // Twitching.
      const j = Math.sin(t * 23 + side) > 0.6 ? 0.6 : 0;
      u.set(side * (0.12 + j), -1, -0.1 - j * 0.5); f.set(side * 0.2, -1 + j * 1.4, -0.3);
    } else if (b.post.role === Role.Greeter) {
      if (b.waveT > 0 && side === 1) {
        // Right hand up, waving side to side.
        const k = Math.min(1, b.waveT * 2, (2.2 - b.waveT) * 4);
        u.set(0.12 + 0.75 * k, -1 + 1.45 * k, -0.15);
        f.set(0.1 + (0.15 + Math.sin(t * 9) * 0.45) * k, -1 + 2 * k, -0.2 - 0.3 * (1 - k));
      } else {
        // Hands folded in front.
        u.set(side * 0.12, -1, -0.28); f.set(-side * 0.6, -0.12, -0.8);
      }
    } else {
      // Traffic: which way has green?
      const A = this.axes(b);
      if (!A) { u.set(side * 0.1, -1, 0); f.set(side * 0.1, -1, -0.1); }
      else if (A.green < 0) {
        // All red: both hands up, palms to the traffic.
        u.set(side * 0.25, 0, -1); f.set(side * 0.08, 1, -0.2);
      } else {
        // The green axis in the body frame: the arm on its side points along it, the other
        // waves the flow on.
        const ax = A.green ? A.bx : A.ax, az = A.green ? A.bz : A.az;
        const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
        let lx = c * ax - s * az, lz = s * ax + c * az;
        if (lz > 0.3) { lx = -lx; lz = -lz; }
        const pointSide = lx >= 0 ? 1 : -1;
        if (side === pointSide) { u.set(lx, 0.1, lz); f.set(lx, 0.14, lz); }
        else {
          const w = 0.5 + 0.5 * Math.sin(t * 5.5);
          u.set(side * 0.35, -0.15, -1);
          f.set(side * (0.1 + 0.9 * w) - pointSide * 0.3 * (1 - w), 0.45, -0.75);
        }
      }
    }
    q.setFromUnitVectors(_down, u.normalize());
    // Forearm in the upper arm's frame.
    return this.elbowQ.setFromUnitVectors(_down, f.normalize().applyQuaternion(_q2.copy(q).invert()));
  }

  /** The junction's two signal axes (world directions) and which one is green (-1: none). */
  private axes(b: Bot): { ax: number; az: number; bx: number; bz: number; green: number } | null {
    const net = this.ctx.net, T = this.ctx.traffic;
    if (b.nodeVer !== net.version || b.node < 0 || b.node >= net.nodes.length) {
      b.nodeVer = net.version; b.node = -1;
      let bd = 12;
      net.nodes.forEach((n, i) => { const d = Math.hypot(n.x - b.post.nx, n.z - b.post.nz); if (n.signal && d < bd) { bd = d; b.node = i; } });
    }
    if (b.node < 0) return null;
    const n = net.nodes[b.node];
    const e0 = net.edges[n.edges[0]];
    if (!e0) return null;
    const dir = (e: typeof e0) => { const p = e.pts, m = p.length; const dx = p[m - 2] - p[0], dz = p[m - 1] - p[1], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
    const [ax, az] = dir(e0);
    let eB = e0;
    for (const ei of n.edges) { const [x, z] = dir(net.edges[ei]); if (Math.abs(x * ax + z * az) < 0.7) { eB = net.edges[ei]; break; } }
    const gA = T.signalGreen(b.node, e0, T.time), gB = eB !== e0 && T.signalGreen(b.node, eB, T.time);
    return { ax, az, bx: -az, bz: ax, green: gA ? 0 : gB ? 1 : -1 };
  }

  private remove(i: number): void {
    const b = this.list[i];
    if (b.body) this.ctx.physics.world.removeRigidBody(b.body);
    this.list[i] = this.list[this.list.length - 1];
    this.list.pop();
  }
}
