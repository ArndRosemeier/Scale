/**
 * Ragdolls for people and the player: knocked flying, tumbling, lying, getting up (or not).
 *
 *   ragdolls.knockout(target, { impulse, point, velocity, stayDown, source })
 *   ragdolls.isActive(target)
 *   ragdolls.onSettled = (target, info) => …     ragdolls.onGotUp = (target) => …
 *
 * Life of a ragdoll:
 *  1. knockout: the body is seeded from the rig's current animated pose and velocity (or a
 *     standing rest pose for someone without a full rig yet), the hit's velocity/impulse is
 *     applied (the upper body takes more of a push than the feet, so people topple; hard hits
 *     throw the whole body), and the rig blends into the ragdoll over 0.1 s.
 *  2. tumbling: physics (Ragdoll.ts) drives the rig's bones (drive.ts); the person / player
 *     position follows the pelvis; bodies pushed into a building are put back out.
 *  3. settled (slow for a moment): the bodies are released (no physics cost), the final pose
 *     is kept and applied to the rig every frame; onSettled fires.
 *  4. stay down (KO, injured, accident victims, crime actors: until helped or their owner
 *     stands them up) — or, after a while, get up: face-up or face-down get-up poses
 *     (getup.ts) through the animator's override layer, with the lying pose blended out over
 *     half a second; the person ends standing where the body lay, facing along it.
 *
 * Budget: at most MAX_LIVE simulated ragdolls (each 14 bodies); a new one beyond that drops
 * the oldest tumbling person back to the simple knock-down animation. Lying people cost
 * nothing but a pose copy when drawn.
 *
 * Pedestrians: any knock-down (Reactions.knockDown and everything built on it: powers,
 * strikes, cars, stomps, blasts) within RANGE of the camera becomes a ragdoll — detected from
 * the agent itself (Down with a fresh fling velocity), so no hook is needed. People drawn
 * as instanced crowd get promoted to a full rig (CrowdRenderer.forceRig); until the rig is
 * built the instanced "down" clip follows the ragdoll's pelvis.
 *
 * The player: when Player.downT is set (combat), after a hard fall, or through knockout().
 */
import * as THREE from 'three';
import type { Physics } from '../Physics';
import type { LocalGround } from '../../future/ground';
import type { Pedestrians, PedAgent, DownCause } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';
import type { CrowdRenderer } from '../../sim/CrowdRenderer';
import type { Player } from '../../player/Player';
import type { HumanoidRig } from '../../humanoid/client/HumanoidRig';
import type { Character } from '../../humanoid/client/Character';
import type { Animator } from '../../humanoid/client/anim/Animator';
import type { Pose } from '../../humanoid/client/anim/pose';
import { smooth } from '../../humanoid/client/anim/pose';
import { statusOf } from '../../shared/status';
import type RAPIER from '@dimforge/rapier3d-compat';
import { GROUPS } from '../Physics';
import { Ragdoll, qrot } from './Ragdoll';
import { RigDriver } from './drive';
import { GetUpPoser, getupEndZ } from './getup';
import { PART_COUNT, Part, makeDims, defaultBodyDims, REST_HEIGHT, type RagDims } from './skeleton';

export type RagTarget = PedAgent | Player;
type V3 = { x: number; y: number; z: number } | [number, number, number];

export interface KnockoutOpts {
  /** Impulse (N·s) on the body, applied at `point` (world) if given. */
  impulse?: V3;
  point?: V3;
  /** A velocity change (m/s) for the whole body instead of / besides an impulse. */
  velocity?: V3;
  /** Stays down after settling (KO, injured) until helped / getUp(). Default: by hit strength. */
  stayDown?: boolean;
  /** Seconds lying before getting up (default from the hit strength). */
  lie?: number;
  /** Who/what did it (passed back in onSettled); for people also sets downBy when one of DownCause. */
  source?: string;
}

export interface SettledInfo {
  x: number; y: number; z: number;
  faceUp: boolean;
  stayDown: boolean;
  source?: string;
}

const MAX_LIVE = 8;
/** People further than this from the camera keep the simple knock-down animation. */
const RANGE = 45;
/** Lying poses kept (people lying around, drawn when near). */
const MAX_KEPT = 40;
/** Seconds of blending into the ragdoll. */
const ENTER = 0.1;

const enum Phase { Tumble, Lying, GetUp }

interface Entry {
  target: RagTarget;
  ped: PedAgent | null;
  serial: number;
  rd: Ragdoll;
  phase: Phase;
  t: number;
  calm: number;
  stayDown: boolean;
  lie: number;
  slow: boolean;
  source?: string;
  helped: boolean;
  /** Rig driver of the character this ragdoll last drove (null: none yet). */
  drv: RigDriver | null;
  /** Ground ensured around here (LocalGround). */
  gx: number; gz: number; gt: number;
  up: GetUp | null;
}

interface GetUp {
  faceUp: boolean;
  t: number;
  /** Seconds to hold the lying pose, duration of the get-up proper, blend-out of the lying pose. */
  hold: number; dur: number; blend: number;
  /** Size of the pose offsets (hip height / 0.94 m), forward end offset (model units). */
  q: number; endZ: number;
  /** Moved over the feet already (the pose's forward offset handed to the position). */
  handed: boolean;
  /** Override weight (ramps out at the end). */
  w: number;
  anim: Animator;
  poser: GetUpPoser;
  scale: number;
}

const _v = new THREE.Vector3(), _w = { x: 0, y: 0, z: 0 }, _c = { x: 0, y: 0, z: 0 };
const _pel = new THREE.Vector3();
const _q = new THREE.Quaternion(), _e = new THREE.Euler();
// Share of a knock-down's fling velocity per part: the upper body takes the push, the feet
// stay planted a moment longer (they topple); hard hits throw the whole body.
const SOFT_W = new Float32Array([0.8, 0.9, 1, 1, 0.95, 0.95, 0.95, 0.95, 0.7, 0.55, 0.45, 0.7, 0.55, 0.45]);
const _wts = new Float32Array(PART_COUNT);

const vx3 = (v: V3) => Array.isArray(v) ? v[0] : (v as { x: number }).x;
const vy3 = (v: V3) => Array.isArray(v) ? v[1] : (v as { y: number }).y;
const vz3 = (v: V3) => Array.isArray(v) ? v[2] : (v as { z: number }).z;

export interface RagdollDeps {
  physics: Physics;
  /** Exact street ground and building prisms (the near-future layer's), null: city heightfield. */
  ground: LocalGround | null;
  peds: Pedestrians;
  crowd: CrowdRenderer;
  player: Player;
  /** Walkable ground height below (x, y, z): street, floor, roof. */
  groundAt: (x: number, y: number, z: number) => number;
  /** Cars on the road and parked (physical wrecks excluded): tumbling bodies hit them. */
  cars?: () => Iterable<CarBox>;
}

/** A car as a box: the car itself (identity), base centre on the road, yaw (forward = −sin, −cos), size. */
export interface CarBox { ref: object; x: number; y: number; z: number; yaw: number; length: number; width: number; height: number }

/** Cars near tumbling bodies get a moving (kinematic) box collider from this pool. */
const CAR_POOL = 10, CAR_NEAR = 14;

export class RagdollSystem {
  private entries: Entry[] = [];
  private byTarget = new Map<RagTarget, Entry>();
  private serial = 0;
  private drivers = new WeakMap<Character, RigDriver>();
  private dims = new WeakMap<Character, RagDims>();
  private posers = new WeakMap<Animator, GetUpPoser>();
  private camX = 0; private camY = 0; private camZ = 0;
  private playerDownT = 0;
  private frame = 0;
  private carBodies: { body: RAPIER.RigidBody; col: RAPIER.Collider; key: object | null }[] = [];
  /** Called once a ragdoll comes to rest (lying). */
  onSettled: ((target: RagTarget, info: SettledInfo) => void) | null = null;
  /** Called when someone has got back up. */
  onGotUp: ((target: RagTarget) => void) | null = null;
  /** Hard landings of the player above this speed (m/s at 1.8 m, × √k) knock them down. */
  fallSpeed = 17;
  stats = { live: 0, lying: 0, gettingUp: 0, bodies: 0, ms: 0, knockouts: 0, fallbacks: 0, pushedOut: 0 };

  constructor(private d: RagdollDeps) {
    d.crowd.forceRig = (a) => !!a.ragdoll || this.byTarget.has(a);
  }

  // ------------------------------------------------------------------ API

  /** Is the target a ragdoll right now (tumbling, lying or getting up)? */
  isActive(target: RagTarget): boolean { return this.byTarget.has(target); }

  /** Is the target's body physically simulated right now? */
  isTumbling(target: RagTarget): boolean { return this.byTarget.get(target)?.phase === Phase.Tumble; }

  /**
   * Knock a person or the player over: the body goes limp from its current pose and motion
   * and takes the hit. Returns false when no ragdoll could be made (out of range, indoors):
   * people then get the simple knock-down (state Down with a fling velocity).
   */
  knockout(target: RagTarget, o: KnockoutOpts = {}): boolean {
    const ped = this.isPed(target) ? target : null;
    if (ped) {
      if (!ped.alive) return false;
      if (ped.state !== PState.Down) {
        ped.state = PState.Down; ped.stateT = 0; ped.fear = 2; ped.helped = false;
        ped.downBy = (['player', 'collapse', 'accident', 'other'] as string[]).includes(o.source ?? '') ? o.source as DownCause : 'other';
      }
    }
    let e = this.byTarget.get(target) ?? null;
    if (e && e.phase !== Phase.Tumble) e = this.wake(e);
    if (!e) e = this.create(target, 0, 0, 0);
    if (!e) {
      // Fallback: the old ballistic knock-down.
      if (ped && (o.velocity || o.impulse)) {
        const m = 72;
        ped.vx = (o.velocity ? vx3(o.velocity) : 0) + (o.impulse ? vx3(o.impulse) / m : 0);
        ped.vy = (o.velocity ? vy3(o.velocity) : 0) + (o.impulse ? vy3(o.impulse) / m : 0);
        ped.vz = (o.velocity ? vz3(o.velocity) : 0) + (o.impulse ? vz3(o.impulse) / m : 0);
      }
      return false;
    }
    if (o.velocity) e.rd.addVelocity(vx3(o.velocity), vy3(o.velocity), vz3(o.velocity));
    let hit = o.velocity ? Math.hypot(vx3(o.velocity), vz3(o.velocity)) : 0;
    if (o.impulse) {
      const jx = vx3(o.impulse), jy = vy3(o.impulse), jz = vz3(o.impulse), M = e.rd.mass;
      hit += Math.hypot(jx, jz) / M;
      // Most of it moves the body; a share at the hit point spins it.
      e.rd.addVelocity((jx * 0.6) / M, (jy * 0.6) / M, (jz * 0.6) / M);
      const p = o.point;
      if (p) e.rd.impulseAt(jx * 0.4, jy * 0.4, jz * 0.4, vx3(p), vy3(p), vz3(p));
      else e.rd.addVelocity((jx * 0.4) / M, (jy * 0.4) / M, (jz * 0.4) / M, SOFT_W);
    }
    // The player gets up by default (a caller's KO keeps them down until getUp()).
    this.configure(e, hit / Math.sqrt(e.rd.k), ped ? o.stayDown : o.stayDown ?? false, o.lie, o.source);
    return true;
  }

  /** Stand a lying target up now (a stayDown KO that recovers, or someone helped). */
  getUp(target: RagTarget): void {
    const e = this.byTarget.get(target);
    if (!e) return;
    e.stayDown = false;
    e.lie = 0;
    if (e.phase === Phase.Lying) this.startGetUp(e);
  }

  /** Keep a lying target down for good (someone injured, waiting for care): no getting up after the lie. */
  keepDown(target: RagTarget): void {
    const e = this.byTarget.get(target);
    if (!e) return;
    e.stayDown = true;
    if (e.phase === Phase.Lying && e.ped) e.ped.ragdoll = false;
  }

  /** Drop the ragdoll at once (the target is removed or teleported). */
  release(target: RagTarget): void {
    const e = this.byTarget.get(target);
    if (e) this.finish(e, false);
  }

  // ------------------------------------------------------------------ per frame

  /** Before the physics step: new knock-downs, ground around bodies, phase changes. */
  update(dt: number, cam: THREE.Vector3): void {
    const t0 = performance.now();
    this.camX = cam.x; this.camY = cam.y; this.camZ = cam.z;
    this.frame++;
    this.scanPeople();
    this.watchPlayer();
    this.updateCars();
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      e.t += dt;
      const ped = e.ped;
      // Gone (despawned): checked against the agent list now and then (it is long).
      if (ped && (!ped.alive || ((e.serial + this.frame) % 30 === 0 && !this.d.peds.agents.includes(ped)))) { this.finish(e, false); continue; }
      if (e.phase === Phase.Tumble) this.ensureGround(e, dt);
      else if (e.phase === Phase.Lying) {
        // Helped up / stood up by an owner (crime actors), or the KO wore off.
        const stoodUp = ped ? ped.state !== PState.Down : false;
        if (stoodUp) { e.helped = !!ped?.helped; this.startGetUp(e); }
        else if (!e.stayDown && e.t > e.lie && (!ped ? this.d.player.downT <= 0 : true)) this.startGetUp(e);
      } else if (e.phase === Phase.GetUp) this.stepGetUp(e, dt);
    }
    this.stats.ms = performance.now() - t0;
  }

  /** After the physics step: read the bodies, follow them with the targets, settle. */
  post(dt: number): void {
    const t0 = performance.now();
    let live = 0, lying = 0, up = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.phase === Phase.Tumble) {
        const rd = e.rd;
        rd.read();
        this.keepOutOfBuildings(e);
        this.follow(e);
        const sk = Math.sqrt(rd.k);
        const calm = rd.maxV < 0.3 * sk && rd.maxW < 1.6 / sk;
        e.calm = calm ? e.calm + dt : 0;
        if (e.calm > 0.45 * sk || e.t > 9 * sk) this.settle(e);
        else live++;
      } else if (e.phase === Phase.Lying) lying++;
      else up++;
    }
    this.stats.live = live;
    this.stats.lying = lying;
    this.stats.gettingUp = up;
    this.stats.bodies = live * PART_COUNT;
    this.stats.ms += performance.now() - t0;
  }

  /** After the rigs were animated this frame: pose them from the ragdolls. */
  pose(): void {
    const t0 = performance.now();
    for (const e of this.entries) {
      const rig = this.rigOf(e);
      if (!rig || !rig.char) continue;
      const drv = this.driverOf(rig.char);
      if (e.drv !== drv) { e.drv = drv; drv.reset(); }
      let w = 1;
      if (e.phase === Phase.Tumble) w = Math.min(1, e.t / ENTER);
      else if (e.phase === Phase.GetUp && e.up) w = 1 - smooth(0, e.up.blend, e.up.t);
      if (w <= 0.001) continue;
      drv.apply(e.rd.pos, e.rd.rot, w);
      if (!e.ped) this.syncAvatar();
    }
    this.stats.ms += performance.now() - t0;
  }

  // ------------------------------------------------------------------ detection

  /** Fresh knock-downs: Down with an unconsumed fling velocity (Reactions.knockDown sets it). */
  private scanPeople(): void {
    const R2 = RANGE * RANGE;
    for (const a of this.d.peds.agents) {
      if (a.state !== PState.Down || (a.vx === 0 && a.vy === 0 && a.vz === 0) || a.inside || !a.alive) continue;
      const e = this.byTarget.get(a);
      // Fresh knock-downs only (Reactions.knockDown resets stateT); a tumbling body takes any push.
      if (!e || e.phase !== Phase.Tumble) {
        if (a.stateT > 0.3) continue;
      }
      if (!e) {
        const dx = a.x - this.camX, dy = a.y - this.camY, dz = a.z - this.camZ;
        if (dx * dx + dy * dy + dz * dz > R2) continue;
      }
      const vx = a.vx, vy = a.vy, vz = a.vz;
      const power = Math.hypot(vx, vz);
      const cause = a.downBy ?? 'other';
      const ok = this.knockFromState(a, e, vx, vy, vz);
      if (!ok) continue;
      a.vx = a.vy = a.vz = 0;
      const ent = this.byTarget.get(a)!;
      // Accident and collapse victims and crime actors stay down (to be helped / handled);
      // a hard enough hit knocks out cold.
      const stay = !!a.actor || cause === 'accident' || cause === 'collapse' || power >= 7.5;
      this.configure(ent, power, stay, undefined, cause);
    }
  }

  private knockFromState(a: PedAgent, e: Entry | undefined, vx: number, vy: number, vz: number): boolean {
    let ent: Entry | null = e ?? null;
    if (ent && ent.phase !== Phase.Tumble) ent = this.wake(ent);
    // Walking momentum carries into the fall.
    const ws = ent ? 0 : a.speed;
    const hx = -Math.sin(a.heading) * ws, hz = -Math.cos(a.heading) * ws;
    if (!ent) ent = this.create(a, hx, 0, hz);
    if (!ent) return false;
    const power = Math.hypot(vx, vz);
    const hard = smooth(4, 10, power);
    for (let i = 0; i < PART_COUNT; i++) _wts[i] = SOFT_W[i] + (1 - SOFT_W[i]) * hard;
    ent.rd.addVelocity(vx, vy, vz, _wts);
    return true;
  }

  /** The player: knocked down by combat (downT), a hard landing. */
  private watchPlayer(): void {
    const P = this.d.player;
    if (P.downT > 0 && this.playerDownT <= 0 && !this.byTarget.has(P)) {
      const sk = Math.sqrt(P.k);
      this.knockout(P, { velocity: [P.vel.x, Math.max(P.vel.y, 0), P.vel.z], lie: Math.min(P.downT, 4 * sk), source: 'combat' });
    }
    this.playerDownT = P.downT;
  }

  /** A hard landing (Player events.onLand): falling too fast knocks the player flat. */
  landed(impactSpeed: number): void {
    const P = this.d.player;
    const sk = Math.sqrt(P.k);
    if (P.flying || P.landedLeap > 0 || impactSpeed < this.fallSpeed * sk || this.byTarget.has(P)) return;
    const f = Math.min(1, (impactSpeed / sk - this.fallSpeed) / 15);
    this.knockout(P, { velocity: [P.vel.x * 0.6, 1.2 * sk, P.vel.z * 0.6], lie: 1.5 + 2.5 * f, source: 'fall' });
  }

  // ------------------------------------------------------------------ lifecycle

  private isPed(t: RagTarget): t is PedAgent {
    return (t as PedAgent).cit !== undefined;
  }

  private rigOf(e: Entry): HumanoidRig | null {
    if (e.ped) return this.d.crowd.rigFor(e.ped.id);
    const r = this.d.player.rig;
    return r.char && r.animator ? r : null;
  }

  private driverOf(ch: Character): RigDriver {
    let d = this.drivers.get(ch);
    if (!d) { d = new RigDriver(ch); this.drivers.set(ch, d); }
    return d;
  }

  private dimsOf(ch: Character): RagDims {
    let d = this.dims.get(ch);
    if (!d) { d = makeDims(RigDriver.restOf(ch)); this.dims.set(ch, d); }
    return d;
  }

  /** Room for one more simulated ragdoll: the oldest tumbling person falls back to the old animation. */
  private makeRoom(forPlayer: boolean): boolean {
    let live = 0, oldest: Entry | null = null;
    for (const e of this.entries) {
      if (e.phase !== Phase.Tumble) continue;
      live++;
      if (e.ped && (!oldest || e.serial < oldest.serial)) oldest = e;
    }
    if (live < MAX_LIVE) return true;
    if (!oldest) return false;
    // Nearly settled: keep its pose lying; still flying: hand back to the simple knock-down.
    if (oldest.calm > 0) this.settle(oldest);
    else { this.finish(oldest, false); this.stats.fallbacks++; }
    void forPlayer;
    return true;
  }

  /** New ragdoll from the target's current pose (or a standing rest pose without a rig). */
  private create(target: RagTarget, vx: number, vy: number, vz: number): Entry | null {
    const ped = this.isPed(target) ? target : null;
    if (ped?.inside) return null;
    if (!this.makeRoom(!ped)) return null;
    const P = this.d.physics;
    if (!P.world) return null;
    const rig = ped ? this.d.crowd.rigFor(ped.id) : (this.d.player.rig.char ? this.d.player.rig : null);
    let rd: Ragdoll;
    if (rig?.char) {
      const drv = this.driverOf(rig.char);
      const dims = this.dimsOf(rig.char);
      const s = drv.scale();
      rd = new Ragdoll(P, dims, s);
      drv.sample(rd.rot, _pel);
      rd.placeFromPelvis(_pel.x, _pel.y, _pel.z);
    } else {
      // No rig (instanced crowd person / player still loading): the default body, standing.
      const dims = defaultBodyDims();
      let s: number, x: number, y: number, z: number, yaw: number;
      if (ped) {
        s = this.d.crowd.lookOf(ped).scale * (statusOf(ped)?.scale ?? 1);
        x = ped.x; y = ped.y; z = ped.z; yaw = ped.heading;
      } else {
        const pl = this.d.player;
        s = pl.height / REST_HEIGHT;
        x = pl.pos.x; y = pl.pos.y; z = pl.pos.z; yaw = pl.yaw;
      }
      rd = new Ragdoll(P, dims, s);
      _q.setFromEuler(_e.set(0, yaw, 0));
      for (let i = 0; i < PART_COUNT; i++) _q.toArray(rd.rot, i * 4);
      qrot(rd.rot, 0, dims.origin[0][0] * s, dims.origin[0][1] * s, dims.origin[0][2] * s, _w);
      rd.placeFromPelvis(x + _w.x, y + _w.y, z + _w.z);
    }
    // Nothing may start below the street (an animated pose with the feet in the ground, a
    // crouch): a body seeded into the ground is braked to a stop by the penetration.
    let lift = 0;
    for (let i = 0; i < PART_COUNT; i++) {
      const sh = rd.dims.shape[i];
      let low: number;
      if (sh.kind === 'capsule') {
        qrot(rd.rot, i * 4, sh.a[0] * rd.s, sh.a[1] * rd.s, sh.a[2] * rd.s, _w);
        qrot(rd.rot, i * 4, sh.b[0] * rd.s, sh.b[1] * rd.s, sh.b[2] * rd.s, _c);
        low = rd.pos[i * 3 + 1] + Math.min(_w.y, _c.y) - sh.r * rd.s;
      } else {
        rd.partCentre(i, _c);
        low = _c.y - (sh.kind === 'box' ? Math.max(sh.half[0], sh.half[1], sh.half[2]) : sh.r) * rd.s;
      }
      const g = this.streetY(rd.pos[i * 3], rd.pos[i * 3 + 1] + 0.5 * rd.s, rd.pos[i * 3 + 2]);
      lift = Math.max(lift, g + 0.005 * rd.s - low);
    }
    if (lift > 0) for (let i = 0; i < PART_COUNT; i++) rd.pos[i * 3 + 1] += lift;
    // Make sure the ground is there before the first step.
    this.d.ground?.ensure(rd.px, rd.pz, 4 + rd.dims.height * rd.s, rd.py);
    rd.spawn(vx, vy, vz);
    const e: Entry = {
      target, ped, serial: this.serial++, rd, phase: Phase.Tumble, t: 0, calm: 0, stayDown: false, lie: 2, slow: false,
      helped: false, drv: null, gx: rd.px, gz: rd.pz, gt: 0, up: null,
    };
    this.entries.push(e);
    this.byTarget.set(target, e);
    if (ped) { ped.ragdoll = true; ped.speed = 0; }
    else { const pl = this.d.player; pl.ragdoll = 'limp'; pl.vel.set(0, 0, 0); }
    this.stats.knockouts++;
    return e;
  }

  /** A lying / getting-up body hit again: back to physics from its current pose. */
  private wake(e: Entry): Entry | null {
    if (e.phase === Phase.GetUp) {
      // Seed from the rig as it is now (half up).
      this.endOverride(e);
      this.finish(e, false, true);
      return this.create(e.target, 0, 0, 0);
    }
    if (!this.makeRoom(!e.ped)) return null;
    this.d.ground?.ensure(e.rd.px, e.rd.pz, 4 + e.rd.dims.height * e.rd.s, e.rd.py);
    e.rd.spawn(0, 0, 0);
    e.phase = Phase.Tumble;
    e.t = ENTER;
    e.calm = 0;
    if (e.ped) e.ped.ragdoll = true;
    else this.d.player.ragdoll = 'limp';
    return e;
  }

  /** Lying time, stay-down and slowness from the hit's strength (m/s at 1.8 m). */
  private configure(e: Entry, power: number, stayDown: boolean | undefined, lie: number | undefined, source: string | undefined): void {
    e.stayDown = stayDown ?? power >= 7.5;
    e.slow = power >= 4;
    e.lie = lie ?? 0.8 + Math.min(4, power * 0.3) + Math.random() * 0.8;
    if (source) e.source = source;
  }

  /** Keep street patches and building prisms around a tumbling body. */
  private ensureGround(e: Entry, dt: number): void {
    const G = this.d.ground, rd = e.rd;
    e.gt -= dt;
    const moved = Math.hypot(rd.px - e.gx, rd.pz - e.gz);
    const size = rd.dims.height * rd.s;
    if (e.gt > 0 && moved < size) return;
    e.gt = 0.25;
    e.gx = rd.px; e.gz = rd.pz;
    const speed = Math.hypot(rd.vel.x, rd.vel.z);
    if (G) G.ensure(rd.px, rd.pz, 3 + size * 1.5 + speed * 0.5, rd.py);
    else this.d.physics.ensureGround(rd.px, rd.pz, 30);
  }

  /** A body that got into a building anyway (huge impulses): push it back out through the nearest wall. */
  private keepOutOfBuildings(e: Entry): void {
    const G = this.d.ground;
    if (!G) return;
    const rd = e.rd;
    for (const i of [Part.Pelvis, Part.Chest]) {
      rd.partCentre(i, _c);
      const out = G.resolve(_c.x, _c.y, _c.z, 0.25 * rd.s + 0.05);
      if (!out) continue;
      rd.translate(out.x - _c.x, 0, out.z - _c.z, out.nx, out.nz);
      this.stats.pushedOut++;
      break;
    }
    // Fell through the ground somewhere: put it back on top.
    const g = this.streetY(rd.px, rd.py + 2 * rd.s, rd.pz);
    if (rd.py < g - 0.6 * rd.s) rd.translate(0, g + 0.3 * rd.s - rd.py, 0);
  }

  /**
   * Boxes for the cars near tumbling bodies (kinematic: they move with the car and push, a body
   * flung against a car hits it and slides down its side instead of passing through).
   */
  private updateCars(): void {
    if (!this.d.cars) return;
    const live = this.entries.filter((e) => e.phase === Phase.Tumble);
    const near: { c: CarBox; d: number }[] = [];
    if (live.length) {
      for (const c of this.d.cars()) {
        let d = Infinity;
        for (const e of live) d = Math.min(d, Math.hypot(c.x - e.rd.px, c.z - e.rd.pz) - c.length / 2);
        if (d < CAR_NEAR) near.push({ c, d });
      }
      near.sort((a, b) => a.d - b.d);
    }
    const P = this.d.physics, R = P.R;
    for (let i = 0; i < Math.min(near.length, CAR_POOL); i++) {
      const c = near[i].c;
      let slot = this.carBodies[i];
      if (!slot) {
        const body = P.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -1000, 0));
        const col = P.world.createCollider(R.ColliderDesc.cuboid(1, 1, 1).setFriction(0.6).setCollisionGroups(GROUPS.localGround), body);
        slot = this.carBodies[i] = { body, col, key: null };
      }
      if (slot.key !== c.ref) {
        // A different car: resize and place it directly (no sweep from the old pose).
        slot.key = c.ref;
        slot.col.setHalfExtents({ x: c.width / 2, y: c.height / 2, z: c.length / 2 });
        slot.body.setTranslation({ x: c.x, y: c.y + c.height / 2, z: c.z }, false);
        slot.body.setRotation({ x: 0, y: Math.sin(c.yaw / 2), z: 0, w: Math.cos(c.yaw / 2) }, false);
      }
      slot.body.setNextKinematicTranslation({ x: c.x, y: c.y + c.height / 2, z: c.z });
      slot.body.setNextKinematicRotation({ x: 0, y: Math.sin(c.yaw / 2), z: 0, w: Math.cos(c.yaw / 2) });
    }
    // Unused boxes wait far below the city.
    for (let i = near.length; i < this.carBodies.length; i++) {
      const s = this.carBodies[i];
      if (!s.key) continue;
      s.key = null;
      s.body.setTranslation({ x: 0, y: -1000 - i * 10, z: 0 }, false);
    }
  }

  /** Street-level ground (cheap; roofs and floors are not in it): LocalGround, else the exact query. */
  private streetY(x: number, y: number, z: number): number {
    return this.d.ground ? this.d.ground.streetY(x, z, y) : this.d.groundAt(x, y, z);
  }

  /** Person / player position follows the pelvis (on the ground below it; exact: walkable surfaces). */
  private follow(e: Entry, exact = false): void {
    const rd = e.rd;
    const g = exact ? this.d.groundAt(rd.px, rd.py + 0.3 * rd.s, rd.pz) : this.streetY(rd.px, rd.py + 0.3 * rd.s, rd.pz);
    // Below the pelvis (in the air the rig's origin goes along, for culling and the camera).
    const y = Math.max(Math.min(rd.py, g), rd.py - 0.9 * rd.dims.hipH * rd.s);
    if (e.ped) {
      const a = e.ped;
      a.x = rd.px; a.z = rd.pz; a.y = y;
      a.speed = 0;
    } else {
      const P = this.d.player;
      P.pos.set(rd.px, y, rd.pz);
      P.vel.set(0, 0, 0);
      P.grounded = true;
    }
  }

  /** Came to rest: drop the bodies, keep the pose. */
  private settle(e: Entry): void {
    if (e.phase !== Phase.Tumble) return;
    e.rd.read();
    this.follow(e, true);
    e.rd.release();
    e.phase = Phase.Lying;
    e.t = 0;
    // Lying for good: the old rules apply again (helped up, owners, despawn after a while).
    if (e.ped && e.stayDown) e.ped.ragdoll = false;
    const fu = this.faceUp(e.rd);
    this.onSettled?.(e.target, { x: e.rd.px, y: e.rd.py, z: e.rd.pz, faceUp: fu, stayDown: e.stayDown, source: e.source });
    this.trimKept();
  }

  private trimKept(): void {
    let n = 0;
    for (const e of this.entries) if (e.phase === Phase.Lying) n++;
    while (n > MAX_KEPT) {
      let oldest: Entry | null = null;
      for (const e of this.entries) if (e.phase === Phase.Lying && e.ped && (!oldest || e.serial < oldest.serial)) oldest = e;
      if (!oldest) break;
      this.finish(oldest, false);
      n--;
    }
  }

  /** Lying face up? (the chest's forward axis points up). */
  private faceUp(rd: Ragdoll): boolean {
    qrot(rd.rot, Part.Chest * 4, 0, 0, -1, _w);
    return _w.y > 0;
  }

  // ------------------------------------------------------------------ getting up

  private startGetUp(e: Entry): void {
    const rig = this.rigOf(e);
    const rd = e.rd;
    const anim = rig?.animator;
    // Where and which way: along the body, from the pelvis.
    const faceUp = this.faceUp(rd);
    let dx = rd.pos[Part.Chest * 3] - rd.px, dz = rd.pos[Part.Chest * 3 + 2] - rd.pz;
    const l = Math.hypot(dx, dz);
    if (l < 1e-3) { qrot(rd.rot, Part.Pelvis * 4, 0, 1, 0, _w); dx = _w.x; dz = _w.z; } else { dx /= l; dz /= l; }
    // Face up: the feet point forward; face down: the head does.
    const fx = faceUp ? -dx : dx, fz = faceUp ? -dz : dz;
    const yaw = Math.atan2(-fx, -fz);
    if (!rig || !anim || !rig.char) {
      // Nobody sees the details (instanced crowd): just stand up.
      this.place(e, rd.px, rd.pz, yaw);
      this.finish(e, true);
      return;
    }
    const s = this.driverOf(rig.char).scale();
    const dims = this.dimsOf(rig.char);
    const q = dims.hipH / 0.94;
    // The lying key pose has the pelvis at the model origin's (x, z) plus the rest root offset.
    const ox = dims.origin[Part.Pelvis][0] * s, oz = dims.origin[Part.Pelvis][2] * s;
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    this.place(e, rd.px - (c * ox + sn * oz), rd.pz - (-sn * ox + c * oz), yaw);
    let poser = this.posers.get(anim);
    if (!poser) { poser = new GetUpPoser(anim.map); this.posers.set(anim, poser); }
    const slow = e.slow && !e.helped;
    e.up = {
      faceUp, t: 0, hold: slow ? 0.6 : 0.25, dur: (faceUp ? 2.3 : 2.5) * (slow ? 1.5 : 1) * Math.sqrt(e.rd.k),
      blend: slow ? 0.7 : 0.5, q, endZ: getupEndZ(faceUp) * q, handed: false, w: 1, anim, poser, scale: s,
    };
    const up = e.up;
    anim.override = (p: Pose) => {
      const u = Math.min(1, Math.max(0, (up.t - up.hold) / up.dur));
      up.poser.pose(p, up.faceUp, u, up.q);
      if (up.handed) p.root.z -= up.endZ;
      return up.w;
    };
    e.phase = Phase.GetUp;
    e.t = 0;
    if (e.ped) {
      const a = e.ped;
      a.ragdoll = true;
      a.state = PState.Idle;
      a.speed = 0;
    } else this.d.player.ragdoll = 'getup';
  }

  private stepGetUp(e: Entry, dt: number): void {
    const up = e.up;
    if (!up || !this.rigOf(e)) { this.endOverride(e); this.finish(e, true); return; }
    // Someone knocked down again mid-way is handled by scanPeople → wake.
    up.t += dt;
    const end = up.hold + up.dur;
    if (!up.handed && up.t >= end) {
      // Standing: move the position over the feet, drop the pose's forward offset.
      up.handed = true;
      const yaw = this.yawOf(e);
      const d = up.endZ * up.scale;
      this.place(e, this.xOf(e) - Math.sin(yaw) * d, this.zOf(e) - Math.cos(yaw) * d, yaw);
    }
    if (up.handed) {
      up.w = 1 - smooth(end, end + 0.35, up.t);
      if (up.w <= 0) { this.endOverride(e); this.finish(e, true); }
    }
  }

  private endOverride(e: Entry): void {
    if (e.up) { e.up.anim.override = null; e.up = null; }
  }

  private xOf(e: Entry): number { return e.ped ? e.ped.x : this.d.player.pos.x; }
  private zOf(e: Entry): number { return e.ped ? e.ped.z : this.d.player.pos.z; }
  private yawOf(e: Entry): number { return e.ped ? e.ped.heading : this.d.player.yaw; }

  /** Put the target at (x, z) on the ground, facing yaw. */
  private place(e: Entry, x: number, z: number, yaw: number): void {
    const y = this.d.groundAt(x, (e.ped ? e.ped.y : this.d.player.pos.y) + 0.5 * e.rd.s, z);
    if (e.ped) { e.ped.x = x; e.ped.z = z; e.ped.y = y; e.ped.heading = yaw; }
    else { const P = this.d.player; P.pos.set(x, y, z); P.yaw = yaw; P.vel.set(0, 0, 0); }
  }

  /**
   * Done: the target goes back to its own behaviour. `up`: it stood up (people walk on or
   * flee); otherwise it is simply released (lying people keep the old Down handling).
   */
  private finish(e: Entry, up: boolean, keepTarget = false): void {
    this.endOverride(e);
    e.rd.release();
    e.drv?.reset();
    const i = this.entries.indexOf(e);
    if (i >= 0) this.entries.splice(i, 1);
    this.byTarget.delete(e.target);
    if (keepTarget) return;
    if (e.ped) {
      const a = e.ped;
      a.ragdoll = false;
      a.vx = a.vy = a.vz = 0;
      if (up) {
        a.downBy = undefined;
        if (a.state === PState.Down || a.state === PState.Idle) {
          a.state = a.helped || a.actor || a.fear < 0.6 ? PState.Idle : PState.Flee;
          if (a.state === PState.Flee) { a.fearX = a.x + Math.sin(a.heading) * 3; a.fearZ = a.z + Math.cos(a.heading) * 3; }
        }
        a.stateT = 0;
        this.onGotUp?.(a);
      }
    } else {
      const P = this.d.player;
      P.ragdoll = '';
      if (up) this.onGotUp?.(P);
    }
  }

  /** The player's imported avatar copies the (ragdolled) puppet again. */
  private syncAvatar(): void {
    const av = this.d.player.avatar;
    if (av && av.mode === 'retarget') av.update(0, 'idle', 0, false);
  }
}
