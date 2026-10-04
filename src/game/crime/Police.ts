/**
 * Police (PLAYGROUND_PLAN §2.4, decision 5). A call (a crime, or the player being wanted) sends the
 * nearest patrol car — one already in traffic, or one coming in from out of view — with siren and
 * flashers: it runs red lights and the cars ahead pull over. At the scene two officers get out and
 * go for the criminals: they cuff the knocked-out and the ones with their hands up, run after the
 * rest and tackle them, walk the arrested to the car and drive off. A wanted player is chased the
 * same way; an officer who gets them on the ground cuffs them (the justice layer settles it).
 *
 * Incidents (THREATS_PLAN §2, the city response): the response director sends units with an
 * `IncidentJob` — a patrol car to the scene, a car to a roadblock, a SWAT van; the job says how
 * many get out and what they do there (`work`), and when to go (`done`).
 */
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';
import type { Traffic, Vehicle, VKind } from '../../sim/Traffic';
import { VState } from '../../sim/Traffic';
import type { Combat } from '../Combat';
import type { HurtKind } from '../PlayerHealth';
import type { StimulusKind } from '../Stimuli';
import type { Crime, PlayerView } from './Crime';
import { setState, play, goTo, stand, lookAt, followRoute } from '../../sim/actors/Actor';
import type { EquipmentVisuals } from '../../items/types';

export interface PoliceHost {
  time: number;
  player: PlayerView;
  traffic: Traffic;
  combat: Combat;
  spawnOfficer(seed: number, x: number, z: number, heading: number): PedAgent | null;
  route(ax: number, az: number, bx: number, bz: number): Float32Array | null;
  visible(x: number, y: number, z: number): boolean;
  sound(id: string, x: number, y: number, z: number, gain: number, pitch?: number): void;
  sirenLoop(): { set(x: number, y: number, z: number, gain: number, rate?: number): void; stop(): void } | null;
  emit(kind: StimulusKind, x: number, y: number, z: number, intensity: number, radius: number): void;
  hurtPlayer(dmg: number, kind: HurtKind, fromX: number, fromZ: number): void;
  /** The player is on the ground (knocked down / out). */
  playerDown(): boolean;
  /** An officer has the player cuffed. */
  arrestPlayer(): void;
  /** Wanted level (0 = not wanted). */
  wanted(): number;
}

/** A unit's work at an incident (the response director's): where, how many, what to do there. */
export interface IncidentJob {
  /** Where to drive to (may move; the car is re-routed). */
  x: number; z: number;
  vehicle: VKind;
  officers: number;
  /** Set by the owner: the unit packs up and drives off. */
  done: boolean;
  /** The unit sent (unset: no car could be found / the budget is full). */
  unit?: Unit;
  /** The car has arrived and the officers are out. */
  arrived?(u: Unit): void;
  /** Every frame on the scene. */
  work(u: Unit, dt: number): void;
  /** Dress / equip an officer who got out. */
  equip?(o: PedAgent): void;
  /** Cars that come from out of view start this far out (m; default POLICE.spawnMin). */
  spawnR?: number;
}

type Job = { kind: 'crime'; crime: Crime } | { kind: 'player' } | { kind: 'incident'; job: IncidentJob };

export interface Unit {
  id: number;
  car: Vehicle;
  officers: PedAgent[];
  job: Job;
  state: 'driving' | 'scene' | 'leaving';
  t: number;
  retargetT: number;
  siren: ReturnType<PoliceHost['sirenLoop']>;
  sirenT: number;
  /** Seconds on scene with nothing to do. */
  idleT: number;
  /** Officers that got back in. */
  boarded: number;
}

export const POLICE = { maxUnits: 4, maxIncident: 12, officerHp: 90, officerStrength: 1.45, run: 5.45, tackleR: 1.3, cuffTime: 1.8, respondR: 650, spawnMin: 300, spawnMax: 420 };

/** The uniform: navy shirt, trousers and cap, a dark jacket. */
export function policeOutfit(seed: number): EquipmentVisuals {
  const navy: [number, number, number] = [0.07, 0.1, 0.22], dark: [number, number, number] = [0.05, 0.06, 0.1];
  const v = (primary: [number, number, number], secondary: [number, number, number], k: number) => ({ shape: 'cloth', seed: seed + k, primary, secondary, accent: [0.85, 0.75, 0.2], material: 'plain', glow: 0 });
  return {
    chest: { defId: 'shirt', visual: v([0.55, 0.62, 0.75], navy, 1) },
    back: { defId: 'jacket', visual: v(navy, dark, 2) },
    legs: { defId: 'trousers', visual: v(dark, dark, 3) },
    feet: { defId: 'shoes', visual: v([0.04, 0.04, 0.04], [0, 0, 0], 4) },
    head: { defId: 'cap', visual: v(navy, navy, 5) },
  } as unknown as EquipmentVisuals;
}

let UNIT_ID = 1;

export class Police {
  readonly units: Unit[] = [];
  private calls: { crime: Crime | null; at: number }[] = [];
  private seed = 0x9e1;
  stats = { dispatched: 0, spawnedCars: 0, arrests: 0, tackles: 0 };

  constructor(private h: PoliceHost) {}

  /** A crime was reported: a unit goes after `delay` seconds (phone call, dispatch). */
  call(crime: Crime, delay: number): void {
    this.calls.push({ crime, at: this.h.time + delay });
  }

  /** The player is wanted: make sure `level` units (1–3) are on them. */
  pursuePlayer(level: number): void {
    const want = Math.max(1, Math.min(3, level));
    let have = this.units.filter((u) => u.job.kind === 'player' && u.state !== 'leaving').length + this.calls.filter((c) => c.crime === null).length;
    // Units at a crime scene nearby join in.
    for (const u of this.units) {
      if (have >= want) break;
      if (u.job.kind === 'crime' && u.state === 'scene' && !u.job.crime.active && Math.hypot(u.car.x - this.h.player.x, u.car.z - this.h.player.z) < 250) { u.job = { kind: 'player' }; have++; }
    }
    for (; have < want; have++) this.calls.push({ crime: null, at: this.h.time + 2 + have * 6 });
  }

  /** Officers and cars near a point (turning yourself in). */
  nearestOfficer(x: number, z: number, r: number): PedAgent | null {
    let best: PedAgent | null = null, bd = r;
    for (const u of this.units) for (const o of u.officers) {
      if (!o.alive || o.state === PState.Down) continue;
      const d = Math.hypot(o.x - x, o.z - z);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  nearestCar(x: number, z: number, r: number): Vehicle | null {
    let best: Vehicle | null = null, bd = r;
    for (const v of this.h.traffic.vehicles) {
      if (v.kind !== 'police' || v.state >= VState.Wreck) continue;
      const d = Math.hypot(v.x - x, v.z - z);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  isOfficer(a: PedAgent): boolean { return a.actor?.role === 'police'; }

  get officerCount(): number { return this.units.reduce((n, u) => n + u.officers.filter((o) => o.alive).length, 0); }

  update(dt: number): void {
    const H = this.h;
    // Calls that are due.
    for (let i = this.calls.length - 1; i >= 0; i--) {
      const c = this.calls[i];
      if (c.at > H.time) continue;
      this.calls.splice(i, 1);
      if (c.crime && !c.crime.active) continue;
      if (!c.crime && H.wanted() <= 0) continue;
      this.dispatch(c.crime ? { kind: 'crime', crime: c.crime } : { kind: 'player' });
    }
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      u.t += dt;
      if (!this.stepUnit(u, dt)) { u.siren?.stop(); this.units.splice(i, 1); }
    }
  }

  private target(u: Unit): { x: number; z: number } {
    return u.job.kind === 'crime' ? u.job.crime.hot : u.job.kind === 'incident' ? u.job.job : { x: this.h.player.x, z: this.h.player.z };
  }

  /** Send a unit to an incident now (false: no car to be had, or the incident budget is full). */
  respond(job: IncidentJob): boolean {
    if (this.units.filter((u) => u.job.kind === 'incident').length >= POLICE.maxIncident) return false;
    return this.dispatch({ kind: 'incident', job });
  }

  private dispatch(job: Job): boolean {
    const H = this.h;
    const incident = job.kind === 'incident';
    if (!incident && this.units.filter((u) => u.job.kind !== 'incident').length >= POLICE.maxUnits) return false;
    const t = job.kind === 'crime' ? job.crime.hot : job.kind === 'incident' ? { x: job.job.x, z: job.job.z } : { x: H.player.x, z: H.player.z };
    const kind: VKind = job.kind === 'incident' ? job.job.vehicle : 'police';
    // The nearest free patrol car in traffic, else one coming in from out of view.
    let car: Vehicle | null = null, bd = POLICE.respondR;
    if (kind === 'police') for (const v of H.traffic.vehicles) {
      if (v.kind !== 'police' || v.state !== VState.Drive || v.task || this.units.some((u) => u.car === v)) continue;
      const d = Math.hypot(v.x - t.x, v.z - t.z);
      if (d < bd) { bd = d; car = v; }
    }
    if (!car) {
      for (let k = 0; k < 10 && !car; k++) {
        const a = (this.seed = (this.seed * 1103515245 + 12345) >>> 0) / 4294967296 * Math.PI * 2;
        const r = (job.kind === 'incident' ? job.job.spawnR ?? POLICE.spawnMin : POLICE.spawnMin) + k * 15;
        const x = t.x + Math.cos(a) * r, z = t.z + Math.sin(a) * r;
        if (H.visible(x, 1, z) && Math.hypot(x - H.player.x, z - H.player.z) < 200) continue;
        car = H.traffic.spawnVehicle(kind, x, z, 80, t);
      }
      if (car) this.stats.spawnedCars++;
    }
    if (!car) return false;
    car.task = { x: t.x, z: t.z, arrived: false };
    car.siren = true;
    car.fear = 0;
    car.state = VState.Drive;
    car.vmax = 20;
    H.traffic.sendTo(car, t.x, t.z);
    const unit: Unit = { id: UNIT_ID++, car, officers: [], job, state: 'driving', t: 0, retargetT: 4, siren: H.sirenLoop(), sirenT: 0, idleT: 0, boarded: 0 };
    this.units.push(unit);
    if (job.kind === 'incident') job.job.unit = unit;
    this.stats.dispatched++;
    return true;
  }

  /** One unit: drive, deploy, work the scene, leave. False when it is done. */
  private stepUnit(u: Unit, dt: number): boolean {
    const H = this.h, car = u.car;
    const carOk = car.alive && H.traffic.vehicles.includes(car) && car.state < VState.Abandoned;
    // Siren sound and stimulus while driving to the call.
    if (u.siren) {
      if (car.siren && carOk) { u.siren.set(car.x, car.y + 1.6, car.z, 0.9, 1); }
      else { u.siren.set(car.x, car.y + 1.6, car.z, 0, 1); }
    } else if (car.siren) u.siren = H.sirenLoop();
    u.sirenT -= dt;
    if (car.siren && u.sirenT <= 0) { u.sirenT = 1; H.emit('siren', car.x, car.y + 1.5, car.z, 2, 130); }
    if (u.state === 'driving') {
      if (!carOk) { this.deploy(u); return true; }
      // The job may have ended on the way.
      if (u.job.kind === 'crime' && !u.job.crime.active && u.job.crime.outcome !== 'escaped') { this.leave(u); return true; }
      if (u.job.kind === 'player' && H.wanted() <= 0) { this.leave(u); return true; }
      if (u.job.kind === 'incident' && u.job.job.done) { this.leave(u); return true; }
      u.retargetT -= dt;
      const t = this.target(u);
      if (u.retargetT <= 0) {
        u.retargetT = 4;
        if (car.task && Math.hypot(car.task.x - t.x, car.task.z - t.z) > 35 && !car.task.arrived) { car.task.x = t.x; car.task.z = t.z; H.traffic.sendTo(car, t.x, t.z); }
      }
      const close = Math.hypot(car.x - t.x, car.z - t.z);
      // (Stuck in a jam near an incident: they get out and go the rest of the way on foot.)
      u.idleT = car.speed < 0.5 ? u.idleT + dt : 0;
      const stuck = u.job.kind === 'incident' && close < 90 && u.idleT > 8;
      if (car.task?.arrived || close < 22 || (close < 45 && car.speed < 0.5 && u.t > 6) || stuck || u.t > 120) this.deploy(u);
      return true;
    }
    if (u.state === 'scene') {
      // Nobody got out (the street was full): try again for a while.
      if (!u.officers.length) { if (u.t < 20 && (u.idleT += dt) > 1) { u.idleT = 0; this.spawnOfficers(u); } if (u.t >= 20) { this.leave(u); } return true; }
      if (u.job.kind === 'incident') {
        if (u.job.job.done) this.leave(u); else u.job.job.work(u, dt);
        return true;
      }
      const busy = u.job.kind === 'crime' ? this.workCrime(u, u.job.crime, dt) : this.workPlayer(u, dt);
      if (!busy) { u.idleT += dt; if (u.idleT > 6) this.leave(u); }
      else u.idleT = 0;
      return true;
    }
    // Leaving: officers walk back and get in, then the car drives off.
    let inside = 0;
    for (const o of u.officers) {
      if (!o.alive) { inside++; continue; }
      const act = o.actor;
      if (!act || o.state === PState.Down) continue;
      act.face = null;
      if (!carOk || Math.hypot(o.x - car.x, o.z - car.z) < 2.2) { o.alive = false; inside++; H.sound('door_close', o.x, 1, o.z, 0.6); continue; }
      goTo(act, car.x, car.z, 1.6);
      setState(act, 'walk');
    }
    if (inside >= u.officers.length || u.t > 400) {
      // Everyone in: back on patrol (hand the car back to traffic).
      if (carOk) { car.task = undefined; car.siren = false; car.fear = 0; car.vmax = 13; car.route = { edges: [car.edge], fwd: [car.fwd] }; car.ri = 0; }
      for (const o of u.officers) o.alive = false;
      return false;
    }
    return true;
  }

  private deploy(u: Unit): void {
    const H = this.h, car = u.car;
    if (car.task) car.task.arrived = true;
    car.speed = 0;
    // Flashers stay on at the scene; the siren goes quiet.
    car.siren = false;
    car.fear = 0;
    this.spawnOfficers(u);
    u.state = 'scene';
    u.t = 0;
    u.idleT = 0;
    // Keep the flashers going while parked.
    car.fear = 0.35;
    if (u.job.kind === 'incident') u.job.job.arrived?.(u);
  }

  private spawnOfficers(u: Unit): void {
    const H = this.h, car = u.car;
    const n = u.job.kind === 'incident' ? u.job.job.officers : 2;
    const fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw);
    for (let i = 0; i < n; i++) {
      const side = i & 1 ? 1 : -1;
      const back = (i >> 1) * 1.4;
      const x = car.x + fz * side * 1.6 + fx * (0.3 - back), z = car.z - fx * side * 1.6 + fz * (0.3 - back);
      const o = H.spawnOfficer((this.seed = (this.seed * 1103515245 + 12345) >>> 0), x, z, car.yaw);
      if (!o) continue;
      if (u.job.kind === 'incident') u.job.job.equip?.(o);
      u.officers.push(o);
      H.sound('door_open', x, 1, z, 0.6);
    }
  }

  private leave(u: Unit): void {
    u.state = 'leaving';
    u.car.siren = false;
    u.idleT = 0;
    for (const o of u.officers) if (o.actor) { o.actor.hostile = false; o.actor.action = null; }
  }

  /**
   * A crime scene: cuff the subdued, chase the rest, escort the arrested to the car.
   * Returns false when there is nothing (left) to do.
   */
  private workCrime(u: Unit, crime: Crime, dt: number): boolean {
    const H = this.h, car = u.car;
    let busy = false;
    const free = u.officers.filter((o) => o.alive && o.actor && o.state !== PState.Down);
    const claimed = new Set<PedAgent>();
    for (const o of free) {
      const act = o.actor!;
      // Escort first: an arrested criminal this officer cuffed walks to the car with them.
      const escort = crime.criminals.find((c) => c.alive && c.actor?.state === 'arrested' && c.actor.memo.cuffedBy === o.id);
      if (escort) {
        busy = true;
        const ea = escort.actor!;
        if (ea.stateT < 2.6) { stand(act); lookAt(act, escort.x, escort.y + 1, escort.z); continue; }
        ea.action = null;
        ea.mood = 'sad';
        const dc = Math.hypot(escort.x - car.x, escort.z - car.z);
        if (dc < 2.4) { escort.alive = false; ea.memo.inCar = 1; H.sound('door_close', car.x, 1, car.z, 0.7); continue; }
        goTo(ea, car.x, car.z, 1.35);
        goTo(act, escort.x + (o.x - escort.x) * 0.3, escort.z + (o.z - escort.z) * 0.3, 1.5);
        if (Math.hypot(o.x - escort.x, o.z - escort.z) < 1.2) stand(act);
        setState(act, 'walk');
        continue;
      }
      // The nearest criminal still on the loose or waiting to be cuffed.
      let tgt: PedAgent | null = null, bd = 160;
      for (const c of crime.criminals) {
        const ca = c.actor;
        if (!c.alive || !ca || ca.state === 'arrested' || ca.state === 'gone' || claimed.has(c)) continue;
        const d = Math.hypot(c.x - o.x, c.z - o.z);
        if (d < bd) { bd = d; tgt = c; }
      }
      if (!tgt) {
        // Nothing of their own: back up the partner.
        const mate = free.find((m) => m !== o && m.actor?.goal);
        if (mate && Math.hypot(mate.x - o.x, mate.z - o.z) > 3) { this.chase(o, mate, mate.actor!.speed > 3 ? POLICE.run : 2); busy = true; } else stand(act);
        continue;
      }
      busy = true;
      claimed.add(tgt);
      const ta = tgt.actor!;
      const down = tgt.state === PState.Down || ta.state === 'ko' || ta.state === 'surrender' || ta.state === 'down';
      lookAt(act, tgt.x, tgt.y + 1, tgt.z);
      act.hostile = false;
      if (down) {
        // (Hysteresis: once kneeling to cuff, a little drift does not interrupt it.)
        if (bd > ((act.memo.cuff ?? 0) > 0 ? 1.9 : 1.2)) { this.chase(o, tgt, bd > 8 ? POLICE.run : 2.2); act.memo.cuff = 0; continue; }
        stand(act);
        setState(act, 'idle');
        act.memo.cuff = (act.memo.cuff ?? 0) + dt;
        if (!act.action) play(act, 'pickup', 2);
        if (act.memo.cuff > POLICE.cuffTime) {
          act.memo.cuff = 0;
          crime.arrest(tgt);
          ta.memo.cuffedBy = o.id;
          this.stats.arrests++;
          H.sound('cuffs', tgt.x, tgt.y + 0.9, tgt.z, 0.9);
        }
      } else {
        // Running away or fighting: run them down and tackle.
        this.chase(o, tgt, POLICE.run);
        if (bd < POLICE.tackleR && act.attackT <= 0) {
          act.attackT = 1.2;
          const dx = tgt.x - o.x, dz = tgt.z - o.z, l = Math.hypot(dx, dz) || 1;
          H.combat.hitActor(tgt, (dx / l) * 700, 120, (dz / l) * 700, 'tackle', 'police', o.x, o.z);
          play(act, 'kick', 0.6);
          this.stats.tackles++;
          H.sound('punch_impact', tgt.x, tgt.y + 1, tgt.z, 0.8, 0.85);
        }
      }
    }
    // A crime that ended with nobody to take: done once the arrested are in the car.
    if (!crime.active && !crime.criminals.some((c) => c.alive && c.actor?.state === 'arrested')) return busy && crime.outcome !== 'escaped' ? busy : false;
    return busy || crime.active;
  }

  /** Run after a point along the sidewalks (straight in the last 28 m). */
  chase(o: PedAgent, tgt: { x: number; z: number }, speed: number): void {
    const act = o.actor!;
    const d = Math.hypot(tgt.x - o.x, tgt.z - o.z);
    setState(act, 'run');
    if (d < 28) { goTo(act, tgt.x, tgt.z, speed); return; }
    const R0 = act.route;
    const endMoved = R0 ? Math.hypot(R0[R0.length - 3] - tgt.x, R0[R0.length - 2] - tgt.z) > 15 : true;
    if (!R0 || act.wp >= R0.length / 3 || (act.replanT <= 0 && endMoved)) {
      act.replanT = 4;
      const R = this.h.route(o.x, o.z, tgt.x, tgt.z);
      act.route = R;
      // Start at the waypoint ahead (not back at the route's first point).
      act.wp = 1;
      if (R) for (let k = 2; k < Math.min(6, R.length / 3); k++) if (Math.hypot(R[k * 3] - o.x, R[k * 3 + 1] - o.z) < Math.hypot(R[act.wp * 3] - o.x, R[act.wp * 3 + 1] - o.z)) act.wp = k;
    }
    if (!act.route || !followRoute(o, act, speed)) goTo(act, tgt.x, tgt.z, speed);
  }

  /** A wanted player: chase, take down, cuff. */
  private workPlayer(u: Unit, dt: number): boolean {
    const H = this.h, p = H.player;
    if (H.wanted() <= 0) return false;
    let any = false;
    for (const o of u.officers) {
      const act = o.actor;
      if (!o.alive || !act || o.state === PState.Down) continue;
      any = true;
      act.hostile = true;
      act.mood = 'angry';
      const d = Math.hypot(p.x - o.x, p.z - o.z);
      lookAt(act, p.x, p.y + p.height * 0.8, p.z);
      if (p.flying && p.y - o.y > 4) { stand(act); continue; }
      if (H.playerDown() && d < 2.3) {
        if (d > 1.0) goTo(act, p.x, p.z, 1.4); else stand(act);
        act.memo.cuff = (act.memo.cuff ?? 0) + dt;
        if (!act.action) play(act, 'pickup', 1.5);
        if (act.memo.cuff > 1.3) { act.memo.cuff = 0; H.sound('cuffs', p.x, p.y + 0.5, p.z, 1); H.arrestPlayer(); }
        continue;
      }
      act.memo.cuff = 0;
      if (d > 1.2) this.chase(o, p, POLICE.run);
      else stand(act);
      // Take-down: a wind-up, then a hard shove / baton if still in reach.
      if ((act.memo.windup ?? 0) > 0) {
        act.memo.windup -= dt;
        if (act.memo.windup <= 0 && Math.hypot(p.x - o.x, p.z - o.z) < 1.8 && !H.playerDown()) { H.hurtPlayer(24, 'police', o.x, o.z); H.sound('punch_impact', p.x, p.y + 1, p.z, 0.9, 0.8); }
      } else if (d < 1.6 && act.attackT <= 0 && !H.playerDown()) {
        act.attackT = 1.6;
        act.memo.windup = 0.35;
        play(act, 'kick', 0.7);
      }
    }
    return any;
  }

  /** Units for the dev console. */
  summary(): string {
    return this.units.map((u) => `#${u.id} ${u.job.kind}${u.job.kind === 'crime' ? ':' + u.job.crime.kind : u.job.kind === 'incident' ? ':' + u.car.kind : ''} ${u.state} car ${Math.round(Math.hypot(u.car.x - this.h.player.x, u.car.z - this.h.player.z))} m, ${u.officers.filter((o) => o.alive).length} officers`).join(' · ') || 'none';
  }
}
