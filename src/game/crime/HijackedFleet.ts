/**
 * The machines a techno-cult hack turned (crime/Hijack, VILLAINS_PLAN §3.2): the delivery robots,
 * service robots and drones round the hacked one go hostile under the rogue controller
 * (threats/RogueMachines) — the same machines and fights as a robot malfunction, smaller and
 * shorter — with this as their owner. They spare the cultists who hacked them. It ends when the
 * hack wears off (HIJACKED.duration), when the hackers are stopped (the link dies: they go dark),
 * or when every machine is disabled; the machines then reboot and carry on with their day.
 *
 * Each machine the player disables pays a little karma (the crime's own reward is for the hackers).
 */
import type { Game } from '../Game';
import type { PedAgent } from '../../sim/Pedestrians';
import { doorOf } from '../../sim/Population';
import { RState, RKind, type Robot } from '../../future/Robots';
import { BState, type ServiceBot } from '../../future/ServiceBots';
import { DKind, DState, type Drone } from '../../future/Drones';
import type { RogueMachines, Rogue, RogueOwner } from '../threats/RogueMachines';
import type { Crime } from './Crime';

export const HIJACKED = { duration: 75, recruitR: 70, droneR: 160, rebootAfter: 4, karma: 4, rep: 0.4 };

export type FleetEnd = 'expired' | 'cut' | 'stopped';

export class HijackedFleet implements RogueOwner {
  x: number;
  z: number;
  t = 0;
  active = true;
  end: FleetEnd | null = null;
  readonly units: Rogue[] = [];
  /** Disabled by the player. */
  byPlayer = 0;
  private offT = 0;
  private stimT = 0;
  private checkT = 0;

  constructor(private g: Game, private ctl: RogueMachines, readonly crime: Crime, x: number, z: number, n: number) {
    this.x = x; this.z = z;
    this.turn(n);
  }

  private turn(n: number): void {
    const F = this.g.future, R = HIJACKED, x = this.x, z = this.z;
    const d = (o: { x: number; z: number }) => Math.hypot(o.x - x, o.z - z);
    // A drone or two overhead, a service robot when one stands near, the rest delivery robots.
    const nD = Math.min(2, Math.floor(n / 3)), nB = 1, nR = n - nD - nB;
    const robots: Robot[] = F.robots.list.filter((r) => r.alive && !r.mal && r.state < RState.Down && d(r) < R.recruitR).sort((a, b) => d(a) - d(b)).slice(0, nR);
    const doors = this.doors();
    for (let k = 0; robots.length < nR && k < nR * 2 && doors.length; k++) {
      const p = doors[k % doors.length];
      const r = F.robots.spawnAt(p.x + (Math.random() - 0.5) * 2, p.z + (Math.random() - 0.5) * 2, p.yaw, RKind.Delivery, k % 4);
      if (r) robots.push(r);
    }
    robots.forEach((r, i) => this.units.push(this.ctl.turn('robot', r, this, i === 2 ? 'rammer' : 'hunter', 0.4 + Math.random() * 1.6)));
    const bots: ServiceBot[] = F.service.list.filter((b) => b.alive && !b.mal && b.state === BState.Stand && d(b) < R.recruitR).slice(0, nB);
    for (const b of bots) this.units.push(this.ctl.turn('bot', b, this, 'hunter', 0.8 + Math.random()));
    const drones: Drone[] = F.drones.list.filter((o) => o.alive && !o.mal && o.state === DState.Fly && o.kind === DKind.Delivery && d(o) < R.droneR).slice(0, nD);
    for (const o of drones) this.units.push(this.ctl.turn('drone', o, this, 'hunter', 0.3 + Math.random()));
  }

  /** Shop doors near the site (robots roll out of them). */
  private doors(): { x: number; z: number; yaw: number }[] {
    const W = this.g.world, R = 70, out: { x: number; z: number; yaw: number; d: number }[] = [];
    for (const r of W.buildingsIn(this.x - R, this.z - R, this.x + R, this.z + R)) {
      if (!r.alive || !(r.desc.shopfront || r.desc.use === 'retail')) continue;
      const dr = doorOf(r.desc);
      const x = dr.x + dr.nx * 0.9, z = dr.z + dr.nz * 0.9;
      if (!W.standable(x, z)) continue;
      out.push({ x, z, yaw: Math.atan2(-dr.nx, -dr.nz), d: Math.hypot(x - this.x, z - this.z) });
    }
    return out.sort((a, b) => a.d - b.d).slice(0, 6);
  }

  // ================================================================== RogueOwner

  blockSpot(): null { return null; }

  attacked(): void { /* the stimulus below keeps people away */ }

  /** The cultists of this crime are not their targets. */
  spares(a: PedAgent): boolean { return a.actor?.owner === this.crime.id; }

  // ================================================================== per frame

  update(dt: number): void {
    this.t += dt;
    const g = this.g;
    if (!this.active) {
      // Shut down: a few seconds dark, then they reboot and go back to their rounds.
      this.offT += dt;
      if (this.offT > HIJACKED.rebootAfter) { for (const m of this.units) if (m.obj.mal === m) this.ctl.drop(m); this.units.length = 0; }
      return;
    }
    this.checkT -= dt;
    if (this.checkT <= 0) { this.checkT = 0.25; this.check(); }
    if (!this.active) return;
    let cx = 0, cz = 0, n = 0;
    for (const m of this.units) if (!m.out && m.mode === 'hostile' && m.kind !== 'drone') { cx += m.obj.x; cz += m.obj.z; n++; }
    if (n) { const k = Math.min(1, dt * 0.4); this.x += (cx / n - this.x) * k; this.z += (cz / n - this.z) * k; }
    this.stimT -= dt;
    if (this.stimT <= 0) { this.stimT = 1.5; g.stimuli.emit('threat', this.x, g.terrain.height(this.x, this.z) + 1, this.z, 3, 36, { cause: 'threat' }); }
    const c = this.crime;
    if (c.wasSubdued || c.outcome === 'arrested' || c.outcome === 'stopped') this.finish('cut');
    else if (this.t > HIJACKED.duration) this.finish('expired');
  }

  private check(): void {
    let left = 0;
    for (const m of this.units) {
      if (m.out) continue;
      if (!this.ctl.disabled(m)) { if (m.mode !== 'off') left++; continue; }
      m.out = true;
      if (m.lastBy !== 'player' || this.ctl.time - m.lastT > 6) continue;
      this.byPlayer++;
      this.g.progress.addKarma(HIJACKED.karma, m.kind === 'drone' ? 'brought down a hijacked drone' : 'stopped a hijacked robot');
      this.g.crime.rep.add(HIJACKED.rep, 'hijacked robot');
    }
    if (left === 0 && this.t > 4) this.finish('stopped');
  }

  finish(end: FleetEnd): void {
    if (!this.active) return;
    this.active = false;
    this.end = end;
    for (const m of this.units) if (!m.out && !this.ctl.disabled(m)) this.ctl.shutdown(m);
  }

  /** Live hostile machines (map dots). */
  live(): Rogue[] { return this.units.filter((m) => !m.out && m.mode === 'hostile'); }

  get done(): boolean { return !this.active && this.units.length === 0; }

  dispose(): void {
    for (const m of this.units) if (m.obj.mal === m) this.ctl.drop(m);
    this.units.length = 0;
  }
}
