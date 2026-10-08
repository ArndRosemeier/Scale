/**
 * Robot malfunction (THREATS_PLAN §1 #11, roadmap Phase A): the city's first minor threat. In a
 * district near the player the delivery robots, service robots and drones turn hostile at once —
 * a flicker, a burst of glitching, then red lights: robots roll out of the shop doors and run people
 * down, a few line up across the street and stop the traffic, some ram cars; service robots leave
 * their posts and stalk passers-by; drones dive at heads. The machines are the ordinary near-future
 * ones under the rogue controller (RogueMachines): destructible as always (punch, powers, police
 * batons), a hostile one rights itself after a knock until it has taken enough to break.
 *
 * It ends when every machine is disabled (stopped), or after a few minutes when the city shuts the
 * fleet down remotely (what is left powers off where it stands, drones fly home).
 *
 * Omens (`robotOmen`, before the event, show-don't-tell): a robot or two stopping dead and spinning
 * with flickering lights, a drone dropping out of its lane, billboards tearing and flickering.
 *
 * Rewards (Normal mode, karma / reputation; the player's credit is the last knock within 6 s):
 *   a rogue robot or drone disabled   5 karma (service robot 8), +0.5 rep
 *   … while it was going for someone  +3 karma ("saved someone")
 *   the malfunction stopped, the player having disabled at least two   20 karma, +4 rep, cheers
 */
import type { Game } from '../Game';
import { Rng } from '../../core/rng';
import { doorOf } from '../../sim/Population';
import { RState, RKind, type Robot } from '../../future/Robots';
import { BState, type ServiceBot } from '../../future/ServiceBots';
import { DKind, DState, type Drone } from '../../future/Drones';
import type { Cause } from '../Stimuli';
import type { RogueMachines, Rogue, RogueOwner, RogueRole } from './RogueMachines';
import type { ThreatEvent, ThreatOutcome, ThreatTarget } from './ThreatEvent';

export interface RobotEventOpts {
  robots?: number;
  bots?: number;
  drones?: number;
  /** Seconds until the fleet is shut down remotely. */
  duration?: number;
}

export const ROBOT_EVENT = {
  robots: [9, 12], bots: [2, 3], drones: [4, 6],
  /** Machines are recruited / spawned this far from the site (m). */
  recruitR: 110, droneR: 260,
  duration: 300,
  /** The player gone this far for this long: the event winds down unseen. */
  farR: 700, farT: 30,
  karma: { robot: 5, bot: 8, drone: 5, saved: 3, stopped: 20 },
  rep: { unit: 0.5, stopped: 4 },
};

let EVENT_ID = 1;

interface Spot { x: number; z: number; yaw: number; taken: Rogue | null }
type LiveTarget = ThreatTarget & { m: Rogue; x: number; y: number; z: number; grounded: boolean; on: boolean; speed: number };

export class RobotMalfunction implements ThreatEvent, RogueOwner {
  readonly id = EVENT_ID++;
  readonly archetype = 'robots';
  x: number;
  z: number;
  readonly radius = 60;
  t = 0;
  active = true;
  outcome: ThreatOutcome | null = null;
  hurt = 0;
  readonly units: Rogue[] = [];
  /** Disabled machines by whose doing. */
  readonly credit: Record<Cause | 'other', number> = { player: 0, police: 0, threat: 0, military: 0, world: 0, other: 0 };
  readonly stats = { robots: 0, bots: 0, drones: 0, recruited: 0, spawned: 0, playerHurt: 0, cars: 0 };
  private spots: Spot[] = [];
  /** The machines still in action as police targets (refreshed every frame, objects reused). */
  private live: LiveTarget[] = [];
  private liveOf = new Map<Rogue, LiveTarget>();
  private rng: Rng;
  private checkT = 0;
  private stimT = 0;
  private farT = 0;
  private maxT: number;

  constructor(private g: Game, private ctl: RogueMachines, site: { x: number; z: number }, seed: number, opts: RobotEventOpts = {}) {
    this.x = site.x; this.z = site.z;
    this.rng = new Rng(seed);
    this.maxT = opts.duration ?? ROBOT_EVENT.duration;
    this.start(opts);
  }

  get initial(): number { return this.units.length; }

  // ================================================================== the turn

  private start(o: RobotEventOpts): void {
    const g = this.g, F = g.future, rng = this.rng, R = ROBOT_EVENT;
    const nR = o.robots ?? rng.int(R.robots[0], R.robots[1]);
    const nB = o.bots ?? rng.int(R.bots[0], R.bots[1]);
    const nD = o.drones ?? rng.int(R.drones[0], R.drones[1]);
    this.planSpots();
    // Ground robots: the ones about turn (nearest first), the rest roll out of the shops.
    const near = F.robots.list.filter((r) => r.alive && !r.mal && r.state < RState.Down && Math.hypot(r.x - this.x, r.z - this.z) < R.recruitR)
      .sort((a, b) => Math.hypot(a.x - this.x, a.z - this.z) - Math.hypot(b.x - this.x, b.z - this.z));
    const robots: Robot[] = near.slice(0, nR);
    this.stats.recruited += robots.length;
    const doors = this.doors();
    for (let k = 0; robots.length < nR && k < nR * 3; k++) {
      const p = doors.length ? doors[k % doors.length] : this.sidewalkNear(rng.range(10, 50));
      if (!p) break;
      const jx = rng.range(-1.2, 1.2), jz = rng.range(-1.2, 1.2);
      const r = F.robots.spawnAt(p.x + jx, p.z + jz, p.yaw, k % 7 === 6 ? RKind.Cleaner : RKind.Delivery, rng.int(0, 3));
      if (r) { robots.push(r); this.stats.spawned++; }
    }
    // Roles: cleaners and a share of the rest block the street, some ram cars, the rest hunt.
    const nBlock = Math.min(this.spots.length, Math.round(robots.length * 0.3));
    const nRam = Math.round(robots.length * 0.2);
    let blockers = 0, rammers = 0;
    for (const r of robots) {
      let role: RogueRole = 'hunter';
      if ((r.kind === RKind.Cleaner || blockers < nBlock) && blockers < this.spots.length) { role = 'blocker'; blockers++; }
      else if (rammers < nRam) { role = 'rammer'; rammers++; }
      this.units.push(this.ctl.turn('robot', r, this, role, rng.range(0.6, 2.6)));
    }
    this.stats.robots = robots.length;
    // Service robots: those at their posts nearby, more stepping out of the big shops.
    const bots: ServiceBot[] = F.service.list.filter((b) => b.alive && !b.mal && b.state === BState.Stand && Math.hypot(b.x - this.x, b.z - this.z) < R.recruitR + 20).slice(0, nB);
    for (let k = 0; bots.length < nB && k < 6; k++) {
      const p = doors.length ? doors[(k * 3 + 1) % doors.length] : this.sidewalkNear(rng.range(10, 40));
      if (!p) break;
      const b = F.service.spawnAt(p.x, p.z, p.yaw);
      if (b) bots.push(b);
    }
    for (const b of bots) this.units.push(this.ctl.turn('bot', b, this, 'hunter', rng.range(1, 3)));
    this.stats.bots = bots.length;
    // Drones: the delivery drones overhead drop their parcels and come down; more fly in.
    const drones: Drone[] = F.drones.list.filter((d) => d.alive && !d.mal && d.state === DState.Fly && d.kind === DKind.Delivery && Math.hypot(d.x - this.x, d.z - this.z) < R.droneR).slice(0, nD);
    for (let k = 0; drones.length < nD && k < nD * 2; k++) {
      const a = rng.range(0, Math.PI * 2), rr = rng.range(140, 230);
      const x = this.x + Math.cos(a) * rr, z = this.z + Math.sin(a) * rr;
      const gy = g.terrain.height(x, z), b = g.world.buildingAt(x, z);
      if (b && b.top > gy + 30) continue;
      const d = F.drones.spawnAt(x, gy + 38, z, Math.atan2(-(this.x - x), -(this.z - z)));
      if (d) drones.push(d);
    }
    for (const d of drones) this.units.push(this.ctl.turn('drone', d, this, 'hunter', rng.range(0.3, 2)));
    this.stats.drones = drones.length;
  }

  /** Shop doors near the site (where robots roll out): positions just outside, facing the street. */
  private doors(): { x: number; z: number; yaw: number }[] {
    const W = this.g.world, R = 90, out: { x: number; z: number; yaw: number; d: number }[] = [];
    for (const r of W.buildingsIn(this.x - R, this.z - R, this.x + R, this.z + R)) {
      if (!r.alive || !(r.desc.shopfront || r.desc.use === 'retail' || r.desc.use === 'office')) continue;
      const d = doorOf(r.desc);
      const x = d.x + d.nx * 0.9, z = d.z + d.nz * 0.9;
      if (!W.standable(x, z)) continue;
      out.push({ x, z, yaw: Math.atan2(-d.nx, -d.nz), d: Math.hypot(x - this.x, z - this.z) });
    }
    out.sort((a, b) => a.d - b.d);
    return out.slice(0, 10);
  }

  /** A sidewalk point about `r` m from the site, or null. */
  private sidewalkNear(r: number): { x: number; z: number; yaw: number } | null {
    const net = this.g.net, a = this.rng.range(0, Math.PI * 2);
    const ne = net.nearestEdge(this.x + Math.cos(a) * r, this.z + Math.sin(a) * r, 80);
    if (!ne) return null;
    const e = net.edges[ne.e], o = { x: 0, z: 0, dx: 0, dz: 0 };
    net.pointAt(e, ne.s, ne.side * (e.width / 2 + e.sidewalk * 0.5), o);
    return !this.g.world.standable(o.x, o.z) ? null : { x: o.x, z: o.z, yaw: Math.atan2(-o.dx, -o.dz) };
  }

  /** Posts across the nearest street: a line of robots from kerb to kerb, two when there are many. */
  private planSpots(): void {
    const net = this.g.net;
    const ne = net.nearestEdge(this.x, this.z, 70);
    if (!ne) return;
    const e = net.edges[ne.e], o = { x: 0, z: 0, dx: 0, dz: 0 };
    for (const ds of [0, 9]) {
      const s = Math.max(4, Math.min(e.len - 4, ne.s + ds));
      const half = e.width / 2 - 0.6;
      for (let off = -half; off <= half + 1e-3; off += 1.15) {
        net.pointAt(e, s, off, o);
        this.spots.push({ x: o.x, z: o.z, yaw: Math.atan2(-o.dx, -o.dz) + (ds ? Math.PI : 0), taken: null });
      }
    }
  }

  // ================================================================== RogueOwner

  blockSpot(m: Rogue): { x: number; z: number; yaw: number } | null {
    let mine = this.spots.find((s) => s.taken === m);
    if (!mine) {
      mine = this.spots.find((s) => !s.taken || this.ctl.disabled(s.taken) || s.taken.mode !== 'hostile');
      if (!mine) return null;
      mine.taken = m;
    }
    return mine;
  }

  attacked(_m: Rogue, what: 'person' | 'player' | 'car' | 'officer', _x: number, _z: number): void {
    if (what === 'person' || what === 'officer') this.hurt++;
    else if (what === 'player') this.stats.playerHurt++;
    else this.stats.cars++;
  }

  // ================================================================== per frame

  update(dt: number): void {
    this.t += dt;
    if (!this.active) return;
    const g = this.g;
    this.checkT -= dt;
    if (this.checkT <= 0) { this.checkT = 0.25; this.check(); }
    if (!this.active) return;
    // The incident's centre follows the swarm (the machines still in action on the ground).
    let cx = 0, cz = 0, n = 0;
    for (const t of this.live) t.on = false;
    this.live.length = 0;
    for (const m of this.units) {
      if (m.out || m.mode !== 'hostile') continue;
      let t = this.liveOf.get(m);
      if (!t) { t = { m, x: m.obj.x, y: 0, z: m.obj.z, grounded: m.kind !== 'drone', on: true, speed: 0 }; this.liveOf.set(m, t); }
      t.speed = dt > 0 ? Math.hypot(m.obj.x - t.x, m.obj.z - t.z) / dt : 0;
      t.x = m.obj.x; t.y = m.obj.y; t.z = m.obj.z; t.on = true;
      this.live.push(t);
      if (m.kind !== 'drone') { cx += m.obj.x; cz += m.obj.z; n++; }
    }
    if (n) { const k = Math.min(1, dt * 0.4); this.x += (cx / n - this.x) * k; this.z += (cz / n - this.z) * k; }
    // People round about hear it (crashes, whirring, screams): they keep away.
    this.stimT -= dt;
    if (this.stimT <= 0) { this.stimT = 1.5; g.stimuli.emit('threat', this.x, g.terrain.height(this.x, this.z) + 1, this.z, 3, 42, { cause: 'threat' }); }
    // Run its course: the fleet is shut down remotely after a while; or it fizzles out unseen.
    const p = g.player.pos;
    this.farT = Math.hypot(p.x - this.x, p.z - this.z) > ROBOT_EVENT.farR ? this.farT + dt : 0;
    if (this.farT > ROBOT_EVENT.farT) this.finish('abandoned');
    else if (this.t > this.maxT) this.finish('shutdown');
  }

  /** Newly disabled machines: credit, rewards; the end when none is left. */
  private check(): void {
    const g = this.g, K = ROBOT_EVENT.karma;
    let left = 0;
    for (const m of this.units) {
      if (m.out) continue;
      if (!this.ctl.disabled(m)) { if (m.mode !== 'off') left++; continue; }
      m.out = true;
      const by: Cause | 'other' = m.lastBy && this.ctl.time - m.lastT < 6 ? m.lastBy : 'other';
      this.credit[by]++;
      if (by !== 'player') continue;
      const k = m.kind === 'bot' ? K.bot : m.kind === 'drone' ? K.drone : K.robot;
      g.progress.addKarma(k, m.kind === 'drone' ? 'brought down a rogue drone' : 'stopped a rogue robot');
      g.crime.rep.add(ROBOT_EVENT.rep.unit, 'rogue robot');
      // It was going for someone: they owe the player.
      const t = m.tgt;
      if (t?.kind === 'ped' && t.a.alive && Math.hypot(t.a.x - m.obj.x, t.a.z - m.obj.z) < 5) g.progress.addKarma(K.saved, 'saved someone from a rogue robot');
    }
    if (left === 0 && this.t > 4) this.finish('stopped');
  }

  private finish(outcome: ThreatOutcome): void {
    if (!this.active) return;
    this.active = false;
    this.outcome = outcome;
    for (const m of this.units) if (!m.out && !this.ctl.disabled(m)) this.ctl.shutdown(m);
    const g = this.g;
    if (outcome === 'stopped' && this.credit.player >= 2) {
      g.progress.addKarma(ROBOT_EVENT.karma.stopped, 'the rogue robots are stopped');
      g.crime.rep.add(ROBOT_EVENT.rep.stopped, 'rogue robots stopped');
      g.crime.rep.count('stopped');
      g.crime.cheer();
    }
  }

  strength(): number {
    if (!this.active) return 0;
    let n = 0;
    for (const m of this.units) if (!m.out && m.mode !== 'off') n++;
    return this.units.length ? n / this.units.length : 0;
  }

  targetsNear(x: number, z: number, r: number): ThreatTarget[] {
    const out: ThreatTarget[] = [];
    for (const t of this.live) if (!t.m.out && Math.hypot(t.x - x, t.z - z) <= r) out.push(t);
    return out;
  }

  strike(t: ThreatTarget, jx: number, jy: number, jz: number, cause: Cause): void {
    const m = (t as ThreatTarget & { m?: Rogue }).m;
    if (m && !m.out) this.ctl.strike(m, jx, jy, jz, cause);
  }

  shoot(t: ThreatTarget, dmg: number, cause: Cause, fromX: number, fromZ: number): boolean {
    const m = (t as ThreatTarget & { m?: Rogue }).m;
    if (!m || m.out) return false;
    return this.ctl.shoot(m, dmg, cause, fromX, fromZ);
  }

  shutdown(): void { this.finish('shutdown'); }

  dispose(): void {
    for (const m of this.units) if (m.obj.mal === m) this.ctl.powerOff(m);
  }

  snapshot(): Record<string, unknown> {
    const live = this.units.filter((m) => !m.out && m.mode === 'hostile');
    return {
      id: this.id, archetype: this.archetype, t: +this.t.toFixed(1), active: this.active, outcome: this.outcome,
      x: Math.round(this.x), z: Math.round(this.z), strength: +this.strength().toFixed(2), hurt: this.hurt,
      units: this.units.length, live: live.length, liveByKind: { robot: live.filter((m) => m.kind === 'robot').length, bot: live.filter((m) => m.kind === 'bot').length, drone: live.filter((m) => m.kind === 'drone').length },
      credit: { ...this.credit }, ...this.stats,
    };
  }
}

/**
 * An omen of a coming robot malfunction near `site` (seen from where the player is): returns
 * false when nothing suitable was about (the director tries another kind).
 */
export function robotOmen(g: Game, ctl: RogueMachines, site: { x: number; z: number }, kind: string, rng: Rng): boolean {
  const F = g.future, p = g.player.pos;
  const near = (o: { x: number; z: number }, r: number) => Math.hypot(o.x - p.x, o.z - p.z) < r && Math.hypot(o.x - site.x, o.z - site.z) < 260;
  if (kind === 'glitch') {
    const rs = F.robots.list.filter((r) => r.alive && !r.mal && r.state < RState.Down && r.kind === RKind.Delivery && near(r, 110));
    const bs = F.service.list.filter((b) => b.alive && !b.mal && b.state === BState.Stand && near(b, 80));
    if (!rs.length && !bs.length) return false;
    rs.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    for (const r of rs.slice(0, rng.int(1, 2))) ctl.glitch('robot', r, rng.range(5, 9));
    if (bs.length && (rng.chance(0.5) || !rs.length)) ctl.glitch('bot', bs[0], rng.range(4, 7));
    return true;
  }
  if (kind === 'drone') {
    const ds = F.drones.list.filter((d) => d.alive && !d.mal && d.state === DState.Fly && d.kind === DKind.Delivery && near(d, 160));
    if (!ds.length) return false;
    ds.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    ctl.glitch('drone', ds[0], rng.range(2.5, 4));
    return true;
  }
  // Billboards and shop screens tearing and flickering (the robots' network is going down).
  const n = F.signs.glitch(p.x + (site.x - p.x) * 0.3, p.z + (site.z - p.z) * 0.3, 140, rng.range(6, 12), 6);
  const rs = F.robots.list.filter((r) => r.alive && !r.mal && r.state < RState.Down && near(r, 90));
  if (rs.length && rng.chance(0.6)) ctl.glitch('robot', rs[0], rng.range(3, 6));
  return n > 0 || rs.length > 0;
}
