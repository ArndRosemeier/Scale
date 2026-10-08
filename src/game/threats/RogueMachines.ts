/**
 * Rogue machines (THREATS_PLAN §1 #11): the malfunction controller layered on the near-future
 * robots and drones (src/future/malfunction.ts). It drives every machine that glitches (an omen:
 * a delivery robot stops dead and spins, a drone drops out of its lane and lurches, a service
 * robot twitches — then they carry on) or has turned hostile in a robot malfunction:
 *
 *  - delivery and cleaning robots: hunters run people (and the player) down and knock them over,
 *    rammers drive into cars (dents, a stalled car, a frightened driver), blockers line up across
 *    the carriageway (the cars stop for them: Traffic.obstacles); knocked over they right
 *    themselves after a few seconds until they have taken enough (impulse hit points) to break;
 *  - humanoid service robots leave their posts and stalk people, swinging at them;
 *  - drones hover over a target, dive at head height, hit, climb and go again.
 *
 * Who did what is kept per machine (the last knock's cause: the player, the police, the threat
 * itself), so a robot the player broke is the player's credit, and every harm the machines do
 * goes on the ledger with cause 'threat' (Consequences), never the player's.
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';
import { VState, dentCar, type Vehicle } from '../../sim/Traffic';
import { RState, RKind, type Robot } from '../../future/Robots';
import { BState, type ServiceBot } from '../../future/ServiceBots';
import { DState, type Drone } from '../../future/Drones';
import type { Malfunction, MalfunctionCtl, MalKind } from '../../future/malfunction';
import type { PlayerProbe } from '../../future/ctx';
import type { Cause } from '../Stimuli';
import { CURB_H } from '../../build/ground';
import { statusOf } from '../../shared/status';
import { DRONE_PLATING } from '../crime/Firearms';

export type RogueRole = 'hunter' | 'blocker' | 'rammer';
type Tgt = { kind: 'ped'; a: PedAgent } | { kind: 'player' } | { kind: 'car'; v: Vehicle } | null;

/** What a hostile machine belongs to (the event): its centre and the posts it hands out. */
export interface RogueOwner {
  readonly x: number;
  readonly z: number;
  /** A place on the carriageway to block (blockers), or null. */
  blockSpot(m: Rogue): { x: number; z: number; yaw: number } | null;
  /** Something was attacked (people near it take fright; the response hears of it). */
  attacked(m: Rogue, what: 'person' | 'player' | 'car' | 'officer', x: number, z: number): void;
  /** People the machines leave alone (the cultists who hacked them). */
  spares?(a: PedAgent): boolean;
}

/** A malfunctioning machine (the state the future classes see is its Malfunction part). */
export interface Rogue extends Malfunction {
  kind: MalKind;
  obj: Robot | ServiceBot | Drone;
  owner: RogueOwner | null;
  role: RogueRole;
  /** Glitch: seconds it lasts, spin rate (rad/s). */
  until: number;
  spin: number;
  tgt: Tgt;
  scanT: number;
  attackT: number;
  /** Ground units: on the carriageway (refreshed now and then), steering heading. */
  onRoad: boolean;
  roadT: number;
  heading: number;
  /** Drones: 0 hover over the target, 1 dive, 2 climb away; seconds in it. */
  dive: number;
  diveT: number;
  /** The last knock: by whom, when (game time). */
  lastBy: Cause | null;
  lastT: number;
  /** Disabled (broken / down for good / shot down) and reported to the owner. */
  out: boolean;
  /** Seconds to the next growl / glitch chirp. */
  voiceT: number;
  /** Drones: the altitude it glitched at. */
  baseY: number;
  /** Drones: plating left against small-arms fire (crime/Firearms DRONE_PLATING). */
  plating: number;
}

/** Tuning (m, m/s, s, N·s, damage points). */
export const ROGUE = {
  hp: { robot: 600, cleaner: 750, bot: 950 },
  speed: { robot: 3.1, cleaner: 1.9, bot: 1.5 },
  /** Robots right themselves this long after coming to rest. */
  getUp: 2.6,
  seePlayer: 26, seePeople: 22, seeCars: 30,
  /** They keep to their district: nothing farther than this from the event's centre is a target (m). */
  leash: 85,
  /** Damage to the player per blow, and the cooldowns (s) after a blow at the player / a person. */
  hurt: { robot: 4, bot: 7, drone: 4 },
  cooldown: { robot: 3, bot: 3, drone: 0.5 },
  /** However many are at it, the player takes at most one blow per this many seconds. */
  playerGap: 1.2,
  personGap: { robot: 5, bot: 4, drone: 3 },
  /** At most this many ground machines (and drones) go for the player at once. */
  onPlayer: 3, dronesOnPlayer: 2,
  /** Fling speed of the people they knock over. */
  knock: { robot: 3.4, bot: 4.6, drone: 2.6 },
  drone: { hover: 7, hoverT: 1.4, climb: 11, climbT: 1.6, diveMax: 3.5, see: 45 },
};

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class RogueMachines implements MalfunctionCtl {
  /** Every machine with a malfunction (glitching or hostile). */
  readonly list: Rogue[] = [];
  /** Cause of the knocks that happen now (police strikes and car recoils set it around their call). */
  private cause: Cause = 'player';
  private nb: PedAgent[] = [];
  /** Game time of the last blow the player took. */
  private playerHitT = -99;
  time = 0;
  stats = { glitched: 0, turned: 0, knockdowns: 0, playerHits: 0, rammed: 0, broken: 0 };

  constructor(private g: Game) {}

  // ================================================================== making machines malfunction

  private make(kind: MalKind, obj: Robot | ServiceBot | Drone, mode: 'glitch' | 'hostile', owner: RogueOwner | null): Rogue {
    const hp = kind === 'bot' ? ROGUE.hp.bot : kind === 'robot' && (obj as Robot).kind === RKind.Cleaner ? ROGUE.hp.cleaner : ROGUE.hp.robot;
    const yaw = 'yaw' in obj ? obj.yaw : 0;
    const m: Rogue = {
      mode, t: 0, hp, maxHp: hp, swing: 0, kind, obj, owner, role: 'hunter', until: 0, spin: 0, tgt: null,
      scanT: Math.random() * 0.5, attackT: 0.5, onRoad: false, roadT: 0, heading: yaw, dive: 0, diveT: 0,
      lastBy: null, lastT: -99, out: false, voiceT: 1 + Math.random() * 3, baseY: obj.y, plating: DRONE_PLATING,
    };
    obj.mal = m;
    if (!this.list.includes(m)) this.list.push(m);
    return m;
  }

  /** An omen: the machine glitches for `dur` seconds (stops, spins / lurches, flickers), then carries on. */
  glitch(kind: MalKind, obj: Robot | ServiceBot | Drone, dur: number): Rogue | null {
    if (obj.mal) return null;
    const m = this.make(kind, obj, 'glitch', null);
    m.until = dur;
    m.spin = (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 3);
    this.stats.glitched++;
    this.voice(m, 'robot_glitch', 0.55);
    return m;
  }

  /** The machine turns hostile for `owner` (a short glitch first when `delay` > 0). */
  turn(kind: MalKind, obj: Robot | ServiceBot | Drone, owner: RogueOwner, role: RogueRole, delay = 0): Rogue {
    const prev = obj.mal as Rogue | undefined;
    if (prev) this.drop(prev);
    const m = this.make(kind, obj, delay > 0 ? 'glitch' : 'hostile', owner);
    m.role = role;
    m.until = delay;
    m.spin = (Math.random() < 0.5 ? -1 : 1) * 3;
    if (delay <= 0) this.goHostile(m);
    return m;
  }

  private goHostile(m: Rogue): void {
    m.mode = 'hostile'; m.t = 0;
    this.stats.turned++;
    this.voice(m, 'robot_hostile', 0.85);
    if (m.kind === 'drone') { const d = m.obj as Drone; d.orbit = null; d.plan = [{ x: d.x, y: d.y, z: d.z, r: 1.2, hold: 1e9 }]; d.pi = 0; d.parcel = 0; d.winch = 0; }
  }

  /** No longer malfunctioning (back to ordinary life, or as it is now). */
  drop(m: Rogue): void {
    if (m.obj.mal === m) m.obj.mal = undefined;
    const i = this.list.indexOf(m);
    if (i >= 0) this.list.splice(i, 1);
  }

  /** Shut a hostile machine down where it is (powered off; drones fly home). */
  shutdown(m: Rogue): void {
    m.mode = 'off'; m.t = 0; m.tgt = null; m.swing = 0;
    if (m.kind === 'drone') { this.drop(m); this.g.future.drones.leave(m.obj as Drone); return; }
    if (m.kind === 'robot') (m.obj as Robot).speed = 0;
    this.voice(m, 'robot_glitch', 0.4, 0.7);
  }

  /** Powered down for good: lies dark where it stands (ground machines), dropped from the list. */
  powerOff(m: Rogue): void {
    if (m.kind === 'robot') {
      const r = m.obj as Robot;
      if (r.state < RState.Down) { r.state = RState.Broken; r.stateT = 0; r.speed = 0; r.pose = new THREE.Matrix4().compose(_v.set(r.x, r.y, r.z), _q.setFromAxisAngle(_up, r.yaw), _s.set(1, 1, 1)); r.inLane = r.onRoad; }
    } else if (m.kind === 'bot') {
      const b = m.obj as ServiceBot;
      if (b.state === BState.Stand) { b.state = BState.Broken; b.stateT = 0; b.pose = new THREE.Matrix4().compose(_v.set(b.x, b.y, b.z), _q.setFromAxisAngle(_up, b.yaw), _s.set(1, 1, 1)); }
    }
    this.drop(m);
  }

  /** Is this machine out of the fight (broken, shot down, gone)? */
  disabled(m: Rogue): boolean {
    if (m.kind === 'robot') { const r = m.obj as Robot; return !r.alive || r.crushed || r.state === RState.Broken; }
    if (m.kind === 'bot') { const b = m.obj as ServiceBot; return !b.alive || b.crushed || b.state === BState.Broken; }
    const d = m.obj as Drone;
    return !d.alive || d.broken || d.state !== DState.Fly;
  }

  /** Knocks made inside `fn` count as `cause`'s (police strikes, a robot's own recoil). */
  as(cause: Cause, fn: () => void): void {
    const prev = this.cause;
    this.cause = cause;
    try { fn(); } finally { this.cause = prev; }
  }

  /** Strike a hostile machine (police batons, the event's own recoils): knock with the cause. */
  strike(m: Rogue, jx: number, jy: number, jz: number, cause: Cause): void {
    this.as(cause, () => {
      const F = this.g.future;
      if (m.kind === 'robot') F.robots.knock(m.obj as Robot, jx, jy, jz);
      else if (m.kind === 'bot') F.service.knock(m.obj as ServiceBot, jx, jy, jz);
      else F.drones.knock(m.obj as Drone, jx, jy, jz);
    });
  }

  /**
   * Small-arms hits (police pistols and rifles, a robber's gun): wear the machine down without
   * knocking it about — a drone's plating gives after a few rounds and it drops out of the sky, a
   * ground machine breaks once its hit points are gone (one last knock, with the cause). True when
   * this brought it down.
   */
  shoot(m: Rogue, dmg: number, cause: Cause, fromX: number, fromZ: number): boolean {
    if (m.mode !== 'hostile' || this.disabled(m)) return false;
    m.lastBy = cause;
    m.lastT = this.time;
    const o = m.obj, dx = o.x - fromX, dz = o.z - fromZ, l = Math.hypot(dx, dz) || 1;
    if (m.kind === 'drone') {
      m.plating -= dmg;
      if (m.plating > 0) return false;
      this.strike(m, (dx / l) * 25, -15, (dz / l) * 25, cause);
      return true;
    }
    m.hp -= dmg;
    if (m.hp > 0) return false;
    // Taken enough: the last round knocks it over and it breaks (hit() sees no hit points left).
    this.strike(m, (dx / l) * 260, 60, (dz / l) * 260, cause);
    return true;
  }

  update(dt: number): void {
    this.time += dt;
    // Machines that are gone (despawned far away) or that finished glitching.
    for (let i = this.list.length - 1; i >= 0; i--) {
      const m = this.list[i];
      if (!m.obj.alive || m.obj.mal !== m) this.list.splice(i, 1);
    }
  }

  // ================================================================== MalfunctionCtl

  hit(_kind: MalKind, unit: Robot | ServiceBot | Drone, J: number): void {
    const m = unit.mal as Rogue | undefined;
    if (!m) return;
    m.lastBy = this.cause;
    m.lastT = this.time;
    if (m.mode !== 'hostile' || m.kind === 'drone') return;
    m.hp -= J;
    if (m.hp > 0) return;
    // Taken enough: it breaks (sparks, light dead) as it goes over.
    if (m.kind === 'robot') { const r = unit as Robot; if (r.state !== RState.Broken) this.g.future.robots.breakIt(r, 0, 0); }
    else { const b = unit as ServiceBot; if (b.state !== BState.Broken) this.g.future.service.breakIt(b); }
  }

  robot(r: Robot, dt: number, player: PlayerProbe): boolean {
    const m = r.mal as Rogue;
    m.t += dt;
    if (r.state === RState.Broken) return false;
    if (m.mode === 'off') { r.speed = 0; return r.state < RState.Down; }
    if (r.state >= RState.Down) {
      // Knocked over: lies until its body rests; a hostile one then rights itself.
      if (m.mode === 'hostile' && !r.body && r.stateT > ROGUE.getUp) this.rightRobot(r, m);
      else return false;
      return true;
    }
    if (this.held(r)) { r.speed = 0; return true; }
    if (m.mode === 'glitch') { this.glitchRobot(r, m, dt); return true; }
    this.hostileRobot(r, m, dt, player);
    return true;
  }

  bot(b: ServiceBot, dt: number, player: PlayerProbe): boolean {
    const m = b.mal as Rogue;
    m.t += dt;
    if (b.state === BState.Broken) return false;
    if (b.state === BState.Down) {
      if (m.mode === 'hostile' && !b.body && b.stateT > ROGUE.getUp + 1) {
        // Gets back up, stiffly.
        b.state = BState.Stand; b.stateT = 0; b.pose = null; b.inLane = false;
        b.y = this.groundY(b.x, b.z, this.road(m, b.x, b.z, true));
        this.voice(m, 'robot_hostile', 0.5, 1.1);
        return true;
      }
      return false;
    }
    if (m.mode === 'off' || this.held(b)) { m.swing = Math.max(0, m.swing - dt * 3); return true; }
    if (m.mode === 'glitch') {
      b.head = Math.sin(m.t * 17) * 0.7 * (Math.sin(m.t * 3.1) > 0 ? 1 : 0.2);
      if (m.until > 0 && m.t > m.until) { if (m.owner) this.goHostile(m); else this.drop(m); }
      return true;
    }
    this.hostileBot(b, m, dt, player);
    return true;
  }

  drone(d: Drone, dt: number, player: PlayerProbe): boolean {
    const m = d.mal as Rogue;
    m.t += dt;
    if (m.mode === 'glitch') { this.glitchDrone(d, m, dt); return false; }
    if (m.mode === 'off' || this.held(d)) return false;
    this.hostileDrone(d, m, dt, player);
    return false;
  }

  // ================================================================== glitching (omens)

  private glitchRobot(r: Robot, m: Rogue, dt: number): void {
    // Stops dead, spins in bursts, a few jerks back and forth; then carries on as if nothing happened.
    r.speed = Math.max(0, r.speed - dt * 6);
    const burst = Math.sin(m.t * 2.3 + r.phase * 7) > -0.2 ? 1 : 0;
    r.yaw += m.spin * dt * burst;
    const jerk = Math.sin(m.t * 13) > 0.85 ? 0.35 : 0;
    r.x += -Math.sin(r.yaw) * jerk * dt; r.z += -Math.cos(r.yaw) * jerk * dt;
    m.voiceT -= dt;
    if (m.voiceT <= 0) { m.voiceT = 1.6 + Math.random() * 2; this.voice(m, 'robot_glitch', 0.35); }
    if (m.until > 0 && m.t > m.until) {
      if (m.owner) this.goHostile(m);
      else this.drop(m);
    }
  }

  private glitchDrone(d: Drone, m: Rogue, dt: number): void {
    // Drops out of its lane: a sudden sag, lurches and a wobble, lights flickering; then it climbs
    // back and flies on (its plan is untouched).
    const w = d.plan[d.pi];
    if (w && m.t < m.until) {
      const sag = Math.min(1, m.t / 0.6) * 9;
      if (d.y > m.baseY - sag) d.vy -= 9 * dt;
      d.vx += Math.sin(m.t * 7.3) * 6 * dt; d.vz += Math.cos(m.t * 5.1) * 6 * dt;
      d.yaw += m.spin * dt * 0.6;
    }
    if (m.until > 0 && m.t > m.until) {
      if (m.owner) this.goHostile(m);
      else this.drop(m);
    }
  }

  // ================================================================== hostile: ground robots

  private rightRobot(r: Robot, m: Rogue): void {
    // Back on its wheels, facing the way it lay.
    if (r.pose) { _v.set(0, 0, -1).transformDirection(r.pose); r.yaw = Math.atan2(-_v.x, -_v.z); }
    r.state = RState.Drive; r.stateT = 0; r.pose = null; r.inLane = false; r.drag = undefined; r.speed = 0;
    m.onRoad = this.road(m, r.x, r.z, true);
    r.onRoad = m.onRoad;
    r.y = this.groundY(r.x, r.z, m.onRoad);
    m.heading = r.yaw;
    this.voice(m, 'robot_hostile', 0.45, 1.2);
  }

  private hostileRobot(r: Robot, m: Rogue, dt: number, player: PlayerProbe): void {
    const cleaner = r.kind === RKind.Cleaner;
    const vmax = cleaner ? ROGUE.speed.cleaner : ROGUE.speed.robot;
    m.attackT -= dt;
    m.scanT -= dt;
    if (m.scanT <= 0) { m.scanT = 0.5; this.pickTarget(m, r.x, r.y, r.z, player, m.role === 'rammer'); }
    // Where to: the target, the block post, or round the event's centre.
    let gx = NaN, gz = NaN, want = vmax, post: { x: number; z: number; yaw: number } | null = null;
    const t = this.tgtPos(m.tgt, player);
    if (t && (m.role !== 'blocker' || Math.hypot(t.x - r.x, t.z - r.z) < 5)) { gx = t.x; gz = t.z; }
    else if (m.role === 'blocker' && m.owner) {
      post = m.owner.blockSpot(m);
      if (post) { gx = post.x; gz = post.z; }
    }
    if (Number.isNaN(gx) && m.owner) {
      // Prowl round the centre.
      const a = this.time * 0.25 + (r.id % 17);
      gx = m.owner.x + Math.cos(a) * 12; gz = m.owner.z + Math.sin(a) * 12;
      want = vmax * 0.55;
    }
    const dx = gx - r.x, dz = gz - r.z, dist = Math.hypot(dx, dz);
    if (post && dist < 0.5) {
      // At its post across the road: hold, nose to the traffic.
      r.speed = 0;
      r.yaw += angle(post.yaw - r.yaw) * Math.min(1, dt * 4);
    } else if (dist > 0.2) {
      this.move(r, m, dx / dist, dz / dist, Math.min(want, dist * 2.5), dt);
    } else r.speed = 0;
    r.onRoad = m.onRoad;
    r.y += (this.groundY(r.x, r.z, m.onRoad) - r.y) * Math.min(1, dt * 12);
    this.keepOffPlayer(r, player, 0.45);
    // Contacts: people knocked over, the player hit, cars rammed.
    if (r.speed > 1.2 || m.tgt) this.contactPeople(m, r.x, r.z, r.yaw, 0.55, ROGUE.knock.robot);
    if (m.tgt?.kind === 'player' && m.attackT <= 0 && this.reaches(player, r.x, r.y, r.z, 0.95, 1.2)) this.hitPlayer(m, r.x, r.z, r.y, ROGUE.hurt.robot, ROGUE.cooldown.robot);
    if (r.speed > 1 || m.role === 'rammer') this.ram(m, r);
    this.growl(m, dt, r.x, r.y, r.z);
  }

  private hostileBot(b: ServiceBot, m: Rogue, dt: number, player: PlayerProbe): void {
    m.attackT -= dt;
    m.scanT -= dt;
    if (m.scanT <= 0) { m.scanT = 0.6; this.pickTarget(m, b.x, b.y, b.z, player, false); }
    const t = this.tgtPos(m.tgt, player);
    let gx: number, gz: number, want = ROGUE.speed.bot;
    if (t) { gx = t.x; gz = t.z; }
    else if (m.owner) { const a = this.time * 0.2 + (b.post.key % 13); gx = m.owner.x + Math.cos(a) * 9; gz = m.owner.z + Math.sin(a) * 9; want *= 0.6; }
    else { gx = b.x; gz = b.z; }
    const dx = gx - b.x, dz = gz - b.z, dist = Math.hypot(dx, dz);
    // Swing: wind up within reach, the blow lands at the top of the swing.
    if (m.swing > 0 || (t && dist < 1.25 && m.attackT <= 0)) {
      const before = m.swing;
      m.swing = Math.min(1, m.swing + dt * 3.2);
      if (before < 1 && m.swing >= 1) {
        m.attackT = ROGUE.cooldown.bot;
        if (m.tgt?.kind === 'player') { if (this.reaches(player, b.x, b.y, b.z, 1.4, 2)) this.hitPlayer(m, b.x, b.z, b.y, ROGUE.hurt.bot, ROGUE.cooldown.bot); }
        else if (m.tgt?.kind === 'ped' && Math.hypot(m.tgt.a.x - b.x, m.tgt.a.z - b.z) < 1.5) { this.knockPerson(m, m.tgt.a, b.x, b.z, ROGUE.knock.bot); m.attackT = ROGUE.personGap.bot; }
      }
      if (m.swing >= 1 && m.attackT < ROGUE.cooldown.bot - 0.35) m.swing = 0;
    }
    if (dist > 0.9 && m.swing === 0) {
      const sx = dx / dist, sz = dz / dist;
      const nx = b.x + sx * want * dt, nz = b.z + sz * want * dt;
      if (!this.g.world.buildingAt(nx + sx * 0.4, nz + sz * 0.4)) { b.x = nx; b.z = nz; }
      b.yaw += angle(Math.atan2(-sx, -sz) - b.yaw) * Math.min(1, dt * 3);
    } else if (t) b.yaw += angle(Math.atan2(-dx, -dz) - b.yaw) * Math.min(1, dt * 4);
    b.head = t ? Math.max(-0.8, Math.min(0.8, angle(Math.atan2(-dx, -dz) - b.yaw))) : Math.sin(this.time * 1.7 + b.phase * 5) * 0.6;
    b.headP = -0.1;
    b.y += (this.groundY(b.x, b.z, this.road(m, b.x, b.z)) - b.y) * Math.min(1, dt * 10);
    this.keepOffPlayer(b, player, 0.35);
    this.contactPeople(m, b.x, b.z, b.yaw, 0.45, 0);
    this.growl(m, dt, b.x, b.y + 1.5, b.z);
  }

  /** Drive a ground robot along a heading, round buildings and apart from the other rogues. */
  private move(r: Robot, m: Rogue, fx: number, fz: number, want: number, dt: number): void {
    // Separation from the other machines of the swarm.
    let sx = 0, sz = 0;
    for (const o of this.list) {
      if (o === m || o.kind === 'drone' || o.mode !== 'hostile') continue;
      const ox = r.x - o.obj.x, oz = r.z - o.obj.z, d2 = ox * ox + oz * oz;
      if (d2 > 1.2 || d2 < 1e-4) continue;
      const d = Math.sqrt(d2);
      sx += (ox / d) * (1.1 - d); sz += (oz / d) * (1.1 - d);
    }
    let hx = fx + sx * 1.5, hz = fz + sz * 1.5;
    const hl = Math.hypot(hx, hz) || 1;
    hx /= hl; hz /= hl;
    // A wall ahead: try turning off either way.
    const W = this.g.world;
    let h = Math.atan2(-hx, -hz);
    if (W.buildingAt(r.x + hx * 0.9, r.z + hz * 0.9)) {
      let found = false;
      for (const k of [0.6, -0.6, 1.2, -1.2, 1.9, -1.9]) {
        const a = h + k * (m.spin >= 0 ? 1 : -1);
        if (!W.buildingAt(r.x - Math.sin(a) * 0.9, r.z - Math.cos(a) * 0.9)) { h = a; found = true; break; }
      }
      if (!found) { want = 0; m.spin = -m.spin; }
    }
    m.heading += angle(h - m.heading) * Math.min(1, dt * 5);
    r.speed += Math.max(-dt * 6, Math.min(dt * 4, want - r.speed));
    r.x += -Math.sin(m.heading) * r.speed * dt;
    r.z += -Math.cos(m.heading) * r.speed * dt;
    r.yaw = m.heading;
    this.road(m, r.x, r.z);
  }

  // ================================================================== hostile: drones

  private hostileDrone(d: Drone, m: Rogue, dt: number, player: PlayerProbe): void {
    m.attackT -= dt;
    m.scanT -= dt;
    if (m.scanT <= 0) { m.scanT = 0.7; this.pickTarget(m, d.x, d.y, d.z, player, false, ROGUE.drone.see); }
    const D = ROGUE.drone;
    const t = this.tgtPos(m.tgt, player);
    const w = d.plan[0] ?? (d.plan[0] = { x: d.x, y: d.y, z: d.z, r: 1.2, hold: 1e9 });
    d.pi = 0; d.orbit = null; w.hold = 1e9;
    const ground = this.g.terrain.height(d.x, d.z);
    m.diveT += dt;
    if (!t) {
      // Circle the centre, low and menacing.
      const o = m.owner;
      const a = this.time * 0.5 + (d.id % 11);
      const cx = o ? o.x : d.x, cz = o ? o.z : d.z;
      w.x = cx + Math.cos(a) * 14; w.z = cz + Math.sin(a) * 14; w.y = this.g.terrain.height(w.x, w.z) + 12; w.r = 3;
      m.dive = 0;
      this.growl(m, dt, d.x, d.y, d.z);
      return;
    }
    const head = t.y + (m.tgt?.kind === 'player' ? player.height * 0.75 : 1.5);
    if (m.dive === 0) {
      w.x = t.x; w.z = t.z; w.y = Math.max(head + D.hover, ground + 5); w.r = 1.5;
      if (m.diveT > D.hoverT && Math.hypot(d.x - t.x, d.z - t.z) < 4 && m.attackT <= 0) { m.dive = 1; m.diveT = 0; this.voice(m, 'robot_hostile', 0.5, 1.4); }
    } else if (m.dive === 1) {
      // Dive at the head; a hit, or overshooting, ends it.
      w.x = t.x; w.z = t.z; w.y = head; w.r = 0.6;
      const reach = Math.hypot(d.x - t.x, d.y - head, d.z - t.z);
      if (reach < 1.25) {
        if (m.tgt?.kind === 'player') this.hitPlayer(m, d.x, d.z, d.y, ROGUE.hurt.drone, ROGUE.cooldown.drone);
        else if (m.tgt?.kind === 'ped') this.knockPerson(m, m.tgt.a, d.x, d.z, ROGUE.knock.drone);
        m.attackT = ROGUE.personGap.drone; m.dive = 2; m.diveT = 0;
      } else if (m.diveT > D.diveMax) { m.dive = 2; m.diveT = 0; }
    } else {
      // Pull up and away.
      w.x = d.x + d.vx * 0.8; w.z = d.z + d.vz * 0.8; w.y = head + D.climb; w.r = 2;
      if (m.diveT > D.climbT) { m.dive = 0; m.diveT = 0; }
    }
    this.growl(m, dt, d.x, d.y, d.z);
  }

  // ================================================================== targets and blows

  /**
   * The nearest thing to go for: the player within sight, else a person, else (rammers) a car.
   * Keeps a current target while it is still about.
   */
  private pickTarget(m: Rogue, x: number, y: number, z: number, player: PlayerProbe, cars: boolean, see = ROGUE.seePeople): void {
    const g = this.g;
    const pd = player.active && player.height > 0.3 ? Math.hypot(player.x - x, player.z - z) : Infinity;
    let playerOk = pd < (m.kind === 'drone' ? ROGUE.drone.see : ROGUE.seePlayer) && (m.kind === 'drone' || Math.abs(player.y - y) < 2.5) && !g.player.flying;
    // Not all of them at once: a few go for the player, the rest for whoever is about.
    if (playerOk && m.tgt?.kind !== 'player') {
      let n = 0;
      for (const o of this.list) if (o.tgt?.kind === 'player' && (o.kind === 'drone') === (m.kind === 'drone')) n++;
      if (n >= (m.kind === 'drone' ? ROGUE.dronesOnPlayer : ROGUE.onPlayer) && pd > 3) playerOk = false;
    }
    // Within the district only (they do not follow someone across the city).
    const o = m.owner, inLeash = (px: number, pz: number) => !o || Math.hypot(px - o.x, pz - o.z) < ROGUE.leash * (m.kind === 'drone' ? 1.2 : 1);
    if (playerOk && !inLeash(player.x, player.z)) playerOk = false;
    // Keep the current one while valid (hysteresis).
    const cur = m.tgt;
    if (cur?.kind === 'player' && playerOk) return;
    if (cur?.kind === 'ped' && this.validPed(cur.a, y, m.kind === 'drone') && !o?.spares?.(cur.a) && Math.hypot(cur.a.x - x, cur.a.z - z) < see * 1.3 && inLeash(cur.a.x, cur.a.z) && !(playerOk && pd < 8)) return;
    if (cur?.kind === 'car' && cur.v.alive && cur.v.state < VState.Wreck && Math.hypot(cur.v.x - x, cur.v.z - z) < ROGUE.seeCars && inLeash(cur.v.x, cur.v.z)) return;
    m.tgt = null;
    if (playerOk && (m.role !== 'rammer' || pd < 6)) { m.tgt = { kind: 'player' }; return; }
    if (cars) {
      let best: Vehicle | null = null, bd = ROGUE.seeCars;
      for (const v of g.traffic.vehicles) {
        if (v.state >= VState.Wreck || v.kind === 'police' || v.kind === 'swat' || !inLeash(v.x, v.z)) continue;
        const d = Math.hypot(v.x - x, v.z - z);
        if (d < bd) { bd = d; best = v; }
      }
      if (best) { m.tgt = { kind: 'car', v: best }; return; }
    }
    let best: PedAgent | null = null, bd = see;
    for (const a of g.peds.neighbours(x, z, see, this.nb)) {
      if (!this.validPed(a, y, m.kind === 'drone') || !inLeash(a.x, a.z) || o?.spares?.(a)) continue;
      const d = Math.hypot(a.x - x, a.z - z);
      if (d < bd) { bd = d; best = a; }
    }
    if (best) m.tgt = { kind: 'ped', a: best };
    else if (playerOk) m.tgt = { kind: 'player' };
  }

  private validPed(a: PedAgent, y: number, flying: boolean): boolean {
    return a.alive && !a.inside && !a.ragdoll && a.state !== PState.Down && (flying || Math.abs(a.y - y) < 2);
  }

  private tgtPos(t: Tgt, player: PlayerProbe): { x: number; y: number; z: number } | null {
    if (!t) return null;
    if (t.kind === 'player') return { x: player.x, y: player.y, z: player.z };
    if (t.kind === 'ped') return { x: t.a.x, y: t.a.y, z: t.a.z };
    return { x: t.v.x, y: t.v.y, z: t.v.z };
  }

  /** People in the machine's way: knocked over (its target, and anyone it runs into at speed). */
  private contactPeople(m: Rogue, x: number, z: number, yaw: number, r: number, power: number): void {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    for (const a of this.g.peds.neighbours(x, z, r + 0.6, this.nb)) {
      if (a.state === PState.Down || a.inside || a.ragdoll || !a.alive) continue;
      const ox = a.x - x, oz = a.z - z, d = Math.hypot(ox, oz);
      if (d > r + 0.3 || d < 1e-3) continue;
      const ahead = (ox * fx + oz * fz) / d > 0.2;
      const isTgt = m.tgt?.kind === 'ped' && m.tgt.a === a;
      // Its quarry, or (now and then) whoever it runs into head on.
      if (power > 0 && m.attackT <= 0 && (isTgt || (ahead && Math.random() < 0.3))) { this.knockPerson(m, a, x, z, power); m.attackT = ROGUE.personGap.robot; return; }
      // Shoved aside.
      a.x += (ox / d) * (r + 0.3 - d) * 0.7; a.z += (oz / d) * (r + 0.3 - d) * 0.7;
    }
  }

  private knockPerson(m: Rogue, a: PedAgent, fx: number, fz: number, power: number): void {
    const g = this.g;
    g.reactions.knockDown(a, fx, fz, power, 'threat');
    g.consequences.record(m.kind, 'person', 'knockdown', a.x, a.z, a, 'threat');
    g.audio.play('punch_impact', a.x, a.y + 1, a.z, 0.7, 0.85, 5, g.renderer.camera.position);
    g.stimuli.emit('threat', a.x, a.y + 1, a.z, 3, 30, { cause: 'threat' });
    this.stats.knockdowns++;
    m.owner?.attacked(m, a.actor?.role === 'police' ? 'officer' : 'person', a.x, a.z);
    if (m.tgt?.kind === 'ped' && m.tgt.a === a) m.tgt = null;
  }

  private reaches(p: PlayerProbe, x: number, y: number, z: number, r: number, dy: number): boolean {
    return p.active && Math.hypot(p.x - x, p.z - z) < p.radius + r && p.y < y + dy && p.y + p.height > y - 0.3;
  }

  private hitPlayer(m: Rogue, x: number, z: number, y: number, dmg: number, cd: number): void {
    const g = this.g;
    m.attackT = cd;
    if (this.time - this.playerHitT < ROGUE.playerGap) return;
    this.playerHitT = this.time;
    const dealt = g.crime.health.damage(dmg, 'robot', x, z, y);
    g.audio.play('punch_impact', g.player.pos.x, g.player.pos.y + 1, g.player.pos.z, 0.75, 0.8, 4, g.renderer.camera.position);
    if (dealt <= 0) g.camRig.addShake(0.12);
    g.stimuli.emit('threat', x, g.player.pos.y + 1, z, 3, 25, { cause: 'threat' });
    this.stats.playerHits++;
    m.owner?.attacked(m, 'player', x, z);
  }

  /** A robot driving into a car: a dent, the car stopped, the driver frightened; the robot bounces off. */
  private ram(m: Rogue, r: Robot): void {
    if (m.attackT > 0) return;
    const g = this.g;
    for (const v of g.traffic.vehicles) {
      if (v.state >= VState.Wreck || Math.abs(v.x - r.x) > 5 || Math.abs(v.z - r.z) > 5) continue;
      const cfx = -Math.sin(v.yaw), cfz = -Math.cos(v.yaw), ox = r.x - v.x, oz = r.z - v.z;
      const along = ox * cfx + oz * cfz, lat = ox * -cfz + oz * cfx;
      if (Math.abs(along) > v.length / 2 + 0.45 || Math.abs(lat) > v.width / 2 + 0.45) continue;
      m.attackT = 1.4;
      dentCar(v, 0.12, 0.9);
      v.speed *= 0.2;
      v.fear = Math.min(2, v.fear + 0.45);
      g.consequences.record('robot', 'car', 'damage', v.x, v.z, v, 'threat');
      g.audio.play('car_crash', r.x, r.y + 0.4, r.z, 0.45, 1.35, 6, g.renderer.camera.position);
      if (Math.random() < 0.4) g.traffic.onHorn?.(v);
      this.stats.rammed++;
      m.owner?.attacked(m, 'car', v.x, v.z);
      // Bounces off (it rights itself again).
      const l = Math.hypot(ox, oz) || 1;
      this.strike(m, (ox / l) * 120, 40, (oz / l) * 120, 'threat');
      if (m.tgt?.kind === 'car' && m.tgt.v === v && v.damage > 0.6) m.tgt = null;
      return;
    }
  }

  // ================================================================== small helpers

  /** Frozen or stunned by a power: held where it is. */
  private held(o: object): boolean {
    const st = statusOf(o);
    return !!st && (st.frozen > 0 || st.stunned > 0);
  }

  /** Is (x, z) on the carriageway (cached per machine, refreshed a few times a second)? */
  private road(m: Rogue, x: number, z: number, now = false): boolean {
    m.roadT -= 1 / 60;
    if (now || m.roadT <= 0) { m.roadT = 0.25; m.onRoad = this.g.world.surfaceOffset(x, z) < 0.01; }
    return m.onRoad;
  }

  private groundY(x: number, z: number, onRoad: boolean): number {
    return this.g.terrain.height(x, z) + (onRoad ? 0 : CURB_H);
  }

  /** The player is solid: a machine never ends up inside them. */
  private keepOffPlayer(o: { x: number; z: number }, p: PlayerProbe, r: number): void {
    if (!p.active || p.height < 0.3) return;
    const ox = o.x - p.x, oz = o.z - p.z, d = Math.hypot(ox, oz), rr = p.radius + r;
    if (d < rr && d > 1e-3) { o.x = p.x + (ox / d) * rr; o.z = p.z + (oz / d) * rr; }
  }

  /** Now and then a hostile one chirps or whirs (only near the listener). */
  private growl(m: Rogue, dt: number, x: number, y: number, z: number): void {
    m.voiceT -= dt;
    if (m.voiceT > 0) return;
    m.voiceT = 4 + Math.random() * 5;
    const c = this.g.renderer.camera.position;
    if (Math.hypot(x - c.x, z - c.z) < 60) this.g.audio.play(Math.random() < 0.6 ? 'robot_glitch' : 'robot_hostile', x, y + 0.5, z, 0.35, 0.9 + Math.random() * 0.25, 4, c);
  }

  private voice(m: Rogue, id: string, gain: number, pitch = 1): void {
    const o = m.obj, c = this.g.renderer.camera.position;
    if (Math.hypot(o.x - c.x, o.z - c.z) < 90) this.g.audio.play(id, o.x, o.y + 0.6, o.z, gain, pitch * (0.95 + Math.random() * 0.1), 5, c);
  }
}

function angle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

