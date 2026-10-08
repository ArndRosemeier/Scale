/**
 * Police (PLAYGROUND_PLAN §2.4, decision 5). A call (a crime, or the player being wanted) sends the
 * nearest patrol car — one already in traffic, or one coming in from out of view — with siren and
 * flashers: it runs red lights and the cars ahead pull over. At the scene two officers get out and
 * go for the criminals: they cuff the knocked-out and the ones with their hands up, run after the
 * rest and tackle them, walk the arrested to the car and drive off. A wanted player is chased the
 * same way; an officer who gets them on the ground cuffs them (the justice layer settles it). At
 * wanted level POLICE.shootAt (3) they draw: from a distance, with a clear line (the shared line of
 * sight — buildings, terrain, cars) and nobody else in it, they shoot at the player (pistols; a
 * SWAT van with rifles joins the pursuit) — modest damage per round, every round fired hits;
 * close in they still go for the tackle. Below that they stay non-lethal.
 *
 * Officers carry pistols (crime/Firearms): against a criminal with a gun who has fired (or is
 * aiming) they stop at a distance, aim and shoot back — never through bystanders; the others they
 * run down as before. A target they cannot get to (no progress for a few seconds after a re-plan:
 * Actor `pursue`) they let go for a while instead of running in place.
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
import { setState, play, goTo, stand, lookAt, followRoute, pursue, endPursuit, hold, type Actor } from '../../sim/actors/Actor';
import { GUNS, type Firearms, type GunSpec } from './Firearms';
import type { EquipmentVisuals } from '../../items/types';
import { dealtBy } from '../../shared/status';

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
  hurtPlayer(dmg: number, kind: HurtKind, fromX: number, fromZ: number, fromY: number): void;
  /** The player is on the ground (knocked down / out). */
  playerDown(): boolean;
  /** An officer has the player cuffed. */
  arrestPlayer(): void;
  /** Wanted level (0 = not wanted). */
  wanted(): number;
  /** Small arms (effects, rules). */
  guns?: Firearms;
  /** An officer fires at a criminal ('held': no clear shot / someone in the line). */
  gunAt?(o: PedAgent, c: PedAgent, spec: GunSpec): 'hit' | 'miss' | 'held';
  /** An officer fires at the wanted player ('held': no clear shot / someone in the line); `car`: their own car (cover). */
  gunAtPlayer?(o: PedAgent, spec: GunSpec, car: object | null): 'hit' | 'held';
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

type Job = { kind: 'crime'; crime: Crime } | { kind: 'player'; swat?: boolean } | { kind: 'incident'; job: IncidentJob };

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

export const POLICE = { maxUnits: 4, maxIncident: 12, officerHp: 90, officerStrength: 1.45, run: 5.45, tackleR: 1.3, cuffTime: 1.8, respondR: 650, spawnMin: 300, spawnMax: 420,
  /** A criminal who could not be reached is let go this long (s); a chase gives up after this long without a tackle. */
  skipT: 6, chaseMax: 90,
  /** Shooting back at a gunman: from within this range (m); one hurt below this share may give up (chance per hit). */
  fireR: 30, yieldBelow: 0.55, yieldChance: 0.45,
  /** Closer than this to a gunman they go for the tackle instead (m). */
  closeR: 3.5,
  /** A gunman counts as shooting this long after a shot (s). */
  shotMemory: 12,
  /**
   * A wanted player: from this wanted level on officers shoot at them (and a SWAT van joins the
   * pursuit with `swatOfficers` rifles); between `closeR` and `playerFireR` m, the cadence their
   * gun's gap × `playerGapK` (a pistol ≈ 1.1 hp/s, a rifle ≈ 0.7 hp/s before size; a full
   * wanted-3 pursuit in the open ≈ 8 hp/s; regen 7 hp/s out of a fight).
   */
  shootAt: 3, playerFireR: 34, playerGapK: 2.5, swatOfficers: 3 };

/** The tactical team: dark overalls, helmet-like cap, tougher and stronger (SWAT rifles). */
export function equipSwat(o: PedAgent): void {
  const act = o.actor;
  if (!act) return;
  const seed = o.cit.seed;
  const dark: [number, number, number] = [0.03, 0.035, 0.045], grey: [number, number, number] = [0.12, 0.13, 0.15];
  const v = (primary: [number, number, number], secondary: [number, number, number], k: number) => ({ shape: 'cloth', seed: seed + k, primary, secondary, accent: [0.2, 0.22, 0.25], material: 'plain', glow: 0 });
  act.outfit = {
    ...policeOutfit(seed),
    chest: { defId: 'shirt', visual: v(grey, dark, 1) },
    back: { defId: 'jacket', visual: v(dark, grey, 2) },
    legs: { defId: 'trousers', visual: v(dark, dark, 3) },
    head: { defId: 'cap', visual: v(dark, dark, 5) },
  } as unknown as EquipmentVisuals;
  act.hp = act.maxHp = 160;
  act.strength = 2.2;
}

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
  private calls: { crime: Crime | null; at: number; swat?: boolean }[] = [];
  private seed = 0x9e1;
  stats = { dispatched: 0, spawnedCars: 0, arrests: 0, tackles: 0, gaveUp: 0, shots: 0, hits: 0, yielded: 0, atPlayer: 0, heldAtPlayer: 0, rejoined: 0 };

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
    // So do units on their way back to the car (an arrest just made, a crime cleared): attacked, or
    // the player wanted again, they turn round instead of walking off.
    for (const u of this.units) {
      if (have >= want) break;
      if (u.state !== 'leaving' || u.job.kind === 'incident' || !u.car.alive || u.car.state >= VState.Abandoned) continue;
      if (Math.hypot(u.car.x - this.h.player.x, u.car.z - this.h.player.z) > 250) continue;
      this.rejoin(u);
      have++;
    }
    for (; have < want; have++) this.calls.push({ crime: null, at: this.h.time + 2 + have * 6 });
    // Wanted enough to be shot at: a SWAT van joins (once).
    if (level >= POLICE.shootAt && !this.units.some((u) => u.job.kind === 'player' && u.job.swat && u.state !== 'leaving') && !this.calls.some((c) => c.swat)) this.calls.push({ crime: null, at: this.h.time + 8, swat: true });
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
      this.dispatch(c.crime ? { kind: 'crime', crime: c.crime } : { kind: 'player', swat: c.swat });
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
    if (!incident && this.units.filter((u) => u.job.kind !== 'incident').length >= POLICE.maxUnits + (job.kind === 'player' && job.swat ? 1 : 0)) return false;
    const t = job.kind === 'crime' ? job.crime.hot : job.kind === 'incident' ? { x: job.job.x, z: job.job.z } : { x: H.player.x, z: H.player.z };
    const kind: VKind = job.kind === 'incident' ? job.job.vehicle : job.kind === 'player' && job.swat ? 'swat' : 'police';
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
      const busy = u.job.kind === 'crime' ? this.workCrime(u.officers, u.car, u.job.crime, dt) : this.workPlayer(u.officers, u.car, u.job.swat === true, dt);
      if (!busy) { u.idleT += dt; if (u.idleT > 6) this.leave(u); }
      else u.idleT = 0;
      return true;
    }
    // Leaving: officers walk back and get in, then the car drives off.
    let inside = 0;
    for (const o of u.officers) {
      if (!o.alive) { inside++; continue; }
      const act = o.actor;
      // Out cold: left lying there (the city clears them away once out of sight), not waited for.
      if (act?.state === 'ko') { act.pinned = false; inside++; continue; }
      if (!act || o.state === PState.Down) continue;
      act.face = null;
      if (!carOk || Math.hypot(o.x - car.x, o.z - car.z) < 2.2) { o.alive = false; inside++; H.sound('door_close', o.x, 1, o.z, 0.6); continue; }
      goTo(act, car.x, car.z, 1.6);
      setState(act, 'walk');
    }
    if (inside >= u.officers.length || u.t > 400) {
      // Everyone in: back on patrol (hand the car back to traffic).
      if (carOk) { car.task = undefined; car.siren = false; car.fear = 0; car.vmax = 13; car.route = { edges: [car.edge], fwd: [car.fwd] }; car.ri = 0; }
      for (const o of u.officers) if (o.actor?.state !== 'ko') o.alive = false;
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
    const swat = u.job.kind === 'player' && u.job.swat;
    const n = u.job.kind === 'incident' ? u.job.job.officers : swat ? POLICE.swatOfficers : 2;
    const fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw);
    for (let i = 0; i < n; i++) {
      const side = i & 1 ? 1 : -1;
      const back = (i >> 1) * 1.4;
      const x = car.x + fz * side * 1.6 + fx * (0.3 - back), z = car.z - fx * side * 1.6 + fz * (0.3 - back);
      const o = H.spawnOfficer((this.seed = (this.seed * 1103515245 + 12345) >>> 0), x, z, car.yaw);
      if (!o) continue;
      if (u.job.kind === 'incident') u.job.job.equip?.(o);
      else if (swat) equipSwat(o);
      u.officers.push(o);
      H.sound('door_open', x, 1, z, 0.6);
    }
  }

  /** A leaving unit back on the wanted player: the officers still out turn round, the ones in the car get out again. */
  private rejoin(u: Unit): void {
    u.job = { kind: 'player', swat: u.job.kind === 'player' ? u.job.swat : undefined };
    u.officers = u.officers.filter((o) => o.alive);
    u.state = 'scene';
    u.t = 0;
    u.idleT = 0;
    u.car.fear = 0.35;
    this.stats.rejoined++;
  }

  private leave(u: Unit): void {
    u.state = 'leaving';
    u.car.siren = false;
    u.idleT = 0;
    for (const o of u.officers) if (o.actor) { o.actor.hostile = false; o.actor.action = null; o.actor.move = null; o.actor.held = null; }
  }

  /** A crime has a unit on it or a call out for it (officers on the beat call one car, not two). */
  covered(crime: Crime): boolean {
    return this.calls.some((c) => c.crime === crime) || this.units.some((u) => u.job.kind === 'crime' && u.job.crime === crime && u.state !== 'leaving');
  }

  /**
   * Officers on the beat (crime/Beat) stepping in at a crime: like a unit's officers, without a car —
   * the ones they cuff wait with them for the patrol car (or are walked off out of sight). False
   * when there is nothing (left) for them to do.
   */
  footCrime(officers: PedAgent[], crime: Crime, dt: number): boolean {
    return this.workCrime(officers, null, crime, dt);
  }

  /** Officers on the beat going after the wanted player (non-lethal on foot below shootAt, like a unit). */
  footPlayer(officers: PedAgent[], dt: number): boolean {
    return this.workPlayer(officers, null, false, dt);
  }

  /**
   * A crime scene: cuff the subdued, chase the rest, escort the arrested to the car (officers on
   * foot, `car` null: guard them until a car's officers take them over).
   * Returns false when there is nothing (left) to do.
   */
  private workCrime(officers: PedAgent[], car: Vehicle | null, crime: Crime, dt: number): boolean {
    const H = this.h;
    let busy = false;
    const free = officers.filter((o) => o.alive && o.actor && o.state !== PState.Down);
    const claimed = new Set<PedAgent>();
    for (const o of free) {
      const act = o.actor!;
      // Escort first: an arrested criminal this officer cuffed walks to the car with them.
      const escort = crime.criminals.find((c) => c.alive && c.actor?.state === 'arrested' && (c.actor.memo.cuffedBy === o.id || (!!car && c.actor.memo.foot === 1)));
      if (escort && car && escort.actor!.memo.foot === 1) { escort.actor!.memo.foot = 0; escort.actor!.memo.cuffedBy = o.id; }
      if (escort && !car) {
        // On foot: stand by them until a car's officers take over (a long wait out of sight: walked off).
        busy = true;
        const ea = escort.actor!;
        ea.memo.guardT = (ea.memo.guardT ?? 0) + dt;
        if (ea.memo.guardT > 75 && !H.visible(escort.x, escort.y + 1, escort.z) && !H.visible(o.x, o.y + 1, o.z)) { escort.alive = false; ea.memo.inCar = 1; continue; }
        lower(act);
        if (Math.hypot(o.x - escort.x, o.z - escort.z) > 1.6) { goTo(act, escort.x + 0.9, escort.z, 1.6); setState(act, 'walk'); } else { stand(act); setState(act, 'idle'); }
        lookAt(act, escort.x, escort.y + 1, escort.z);
        continue;
      }
      if (escort && car) {
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
      if (act.memo.skipT > 0) act.memo.skipT -= dt;
      for (const c of crime.criminals) {
        const ca = c.actor;
        if (!c.alive || !ca || ca.state === 'arrested' || ca.state === 'gone' || claimed.has(c)) continue;
        if (act.memo.skipT > 0 && act.memo.skipId === c.id) continue;
        // (A skeleton in pieces is not cuffed: it pulls itself together, or crumbles with its master.)
        if (ca.memo.skel && (ca.state === 'ko' || c.state === PState.Down)) continue;
        const d = Math.hypot(c.x - o.x, c.z - o.z);
        if (d < bd) { bd = d; tgt = c; }
      }
      if (!tgt) {
        // Nothing of their own: back up the partner.
        lower(act);
        const mate = free.find((m) => m !== o && m.actor?.goal);
        if (mate && Math.hypot(mate.x - o.x, mate.z - o.z) > 3 && act.stuckT <= 0) { this.chase(o, mate, mate.actor!.speed > 3 ? POLICE.run : 2); busy = true; } else stand(act);
        continue;
      }
      busy = true;
      claimed.add(tgt);
      const ta = tgt.actor!;
      const down = tgt.state === PState.Down || ta.state === 'ko' || ta.state === 'surrender' || ta.state === 'down';
      lookAt(act, tgt.x, tgt.y + 1, tgt.z);
      act.hostile = false;
      // A gunman (shooting, or aiming at someone): stop at a distance and shoot back.
      if (!down && this.gunfight(o, tgt, crime, bd, dt)) continue;
      if (down) {
        lower(act);
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
          if (!car) ta.memo.foot = 1;
          this.stats.arrests++;
          H.sound('cuffs', tgt.x, tgt.y + 0.9, tgt.z, 0.9);
        }
      } else {
        // Running away or fighting: run them down and tackle (let go of one that cannot be reached).
        lower(act);
        this.chase(o, tgt, POLICE.run);
        if (pursue(act, dt, POLICE.chaseMax) === 'give_up') { act.memo.skipId = tgt.id; act.memo.skipT = POLICE.skipT; stand(act); this.stats.gaveUp++; continue; }
        if (bd < POLICE.tackleR && act.attackT <= 0) {
          endPursuit(act);
          act.attackT = 1.2;
          const dx = tgt.x - o.x, dz = tgt.z - o.z, l = Math.hypot(dx, dz) || 1;
          const k = dealtBy(o);
          H.combat.hitActor(tgt, (dx / l) * 700 * k, 120 * k, (dz / l) * 700 * k, 'tackle', 'police', o.x, o.z);
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

  /**
   * Run after a point along the sidewalks (straight in the last 28 m — getting nowhere on the
   * straight bit: by the sidewalks after all for a few seconds). Callers watch `act.stuckT` /
   * `pursue` to give up.
   */
  chase(o: PedAgent, tgt: { x: number; z: number }, speed: number): void {
    const act = o.actor!;
    const d = Math.hypot(tgt.x - o.x, tgt.z - o.z);
    setState(act, 'run');
    if (act.stuckT > 0 && !(act.memo.viaT > this.h.time)) { act.route = null; act.memo.viaT = this.h.time + 4; act.replanT = 0; }
    if (d < 28 && !(act.memo.viaT > this.h.time)) { goTo(act, tgt.x, tgt.z, speed); return; }
    const R0 = act.route;
    const endMoved = R0 ? Math.hypot(R0[R0.length - 3] - tgt.x, R0[R0.length - 2] - tgt.z) > (d < 28 ? 4 : 15) : true;
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

  /**
   * Against a criminal with a gun who has fired lately or is aiming: draw, stop within range, aim
   * and shoot back (cadence; no shot through people); one badly hurt may give up. Without a clear
   * shot they close in. False when this is no gunfight (the caller runs them down as usual).
   */
  private gunfight(o: PedAgent, tgt: PedAgent, crime: Crime, bd: number, dt: number): boolean {
    const H = this.h, act = o.actor!, ta = tgt.actor!;
    if (ta.armed !== 'gun' || !H.gunAt) return false;
    const shooting = crime.t - (ta.memo.shotAt ?? -99) < POLICE.shotMemory || ta.action?.id === 'aim_pistol';
    // (Right there: tackle them instead.)
    if (!shooting || bd > POLICE.fireR + 15 || bd < POLICE.closeR) return false;
    act.held = 'pistol';
    lookAt(act, tgt.x, tgt.y + 1.2, tgt.z);
    if (!act.memo.warned) { act.memo.warned = 1; H.sound('shout_hey', o.x, o.y + 1.6, o.z, 0.9, 0.8); }
    act.memo.gunT = (act.memo.gunT ?? 0.6 + Math.random() * 0.6) - dt;
    // No clear shot lately (a corner, people in the way) or too far: close in for a bit (to
    // fireR / 3 — not into the muzzle: from there a step to the side).
    if (act.memo.closeT > 0 || bd > POLICE.fireR) {
      act.memo.closeT = (act.memo.closeT ?? 0) - dt;
      lower(act);
      if (bd < POLICE.fireR / 3) {
        const sx = -(tgt.z - o.z) / (bd || 1), sz = (tgt.x - o.x) / (bd || 1), k = o.id & 1 ? 1 : -1;
        goTo(act, o.x + sx * 3 * k, o.z + sz * 3 * k, 3);
        setState(act, 'run');
        return true;
      }
      this.chase(o, tgt, POLICE.run);
      if (pursue(act, dt, POLICE.chaseMax) === 'give_up') { act.memo.skipId = tgt.id; act.memo.skipT = POLICE.skipT; act.memo.closeT = 0; this.stats.gaveUp++; }
      return true;
    }
    stand(act);
    endPursuit(act);
    setState(act, 'fight');
    hold(act, 'aim_pistol');
    if (act.memo.gunT > 0) return true;
    act.memo.gunT = GUNS.pistol.gap * (1.1 + Math.random() * 0.5);
    const r = H.gunAt(o, tgt, GUNS.pistol);
    if (r === 'held') { act.memo.heldN = (act.memo.heldN ?? 0) + 1; if (act.memo.heldN >= 2) { act.memo.heldN = 0; act.memo.closeT = 2.5; } return true; }
    act.memo.heldN = 0;
    this.stats.shots++;
    if (r === 'hit') {
      this.stats.hits++;
      if (ta.hp < ta.maxHp * POLICE.yieldBelow && Math.random() < POLICE.yieldChance) { crime.yieldTo(tgt); this.stats.yielded++; }
    }
    return true;
  }

  /** A wanted player: chase, take down, cuff. */
  private workPlayer(officers: PedAgent[], car: Vehicle | null, swat: boolean, dt: number): boolean {
    const H = this.h, p = H.player;
    if (H.wanted() <= 0) return false;
    let any = false;
    for (const o of officers) {
      const act = o.actor;
      if (!o.alive || !act || o.state === PState.Down) continue;
      any = true;
      act.hostile = true;
      act.mood = 'angry';
      const d = Math.hypot(p.x - o.x, p.z - o.z);
      // Hands and cuffs: not far above or below (a sewer under the pavement), however close on the map.
      const reach = Math.abs(p.y - o.y) < 2.5;
      lookAt(act, p.x, p.y + p.height * 0.8, p.z);
      // Wanted enough: shoot from where they are (a clear line, out of tackling reach).
      if (this.shootPlayer(o, d, dt, swat, car)) continue;
      if (p.flying && p.y - o.y > 4) { stand(act); continue; }
      // Could not get to them (no progress): wait and watch a moment.
      if (act.memo.waitT > 0) { act.memo.waitT -= dt; stand(act); if (d < 3) act.memo.waitT = 0; continue; }
      if (H.playerDown() && d < 2.3 && reach) {
        if (d > 1.0) goTo(act, p.x, p.z, 1.4); else stand(act);
        act.memo.cuff = (act.memo.cuff ?? 0) + dt;
        if (!act.action) play(act, 'pickup', 1.5);
        if (act.memo.cuff > 1.3) { act.memo.cuff = 0; H.sound('cuffs', p.x, p.y + 0.5, p.z, 1); H.arrestPlayer(); }
        continue;
      }
      act.memo.cuff = 0;
      if (d > 1.2) {
        this.chase(o, p, POLICE.run);
        if (pursue(act, dt) === 'give_up') { act.memo.waitT = 5; stand(act); this.stats.gaveUp++; continue; }
      } else { stand(act); endPursuit(act); }
      // Take-down: a wind-up, then a hard shove / baton if still in reach.
      if ((act.memo.windup ?? 0) > 0) {
        act.memo.windup -= dt;
        if (act.memo.windup <= 0 && Math.hypot(p.x - o.x, p.z - o.z) < 1.8 && reach && !H.playerDown()) { H.hurtPlayer(24 * dealtBy(o), 'police', o.x, o.z, o.y); H.sound('punch_impact', p.x, p.y + 1, p.z, 0.9, 0.8); }
      } else if (d < 1.6 && reach && act.attackT <= 0 && !H.playerDown()) {
        act.attackT = 1.6;
        act.memo.windup = 0.35;
        play(act, 'kick', 0.7);
      }
    }
    return any;
  }

  /**
   * At wanted level POLICE.shootAt: an officer with a shot at the player (out of tackling reach,
   * within POLICE.playerFireR) stops, aims and fires — their pistol (SWAT: rifle). No clear line
   * twice running: they close in for a while (the chase). True while handling it.
   */
  private shootPlayer(o: PedAgent, d: number, dt: number, swat: boolean, car: Vehicle | null): boolean {
    const H = this.h, act = o.actor!, p = H.player;
    if (H.wanted() < POLICE.shootAt || !H.gunAtPlayer || H.playerDown()) return lowerAny(act);
    const spec = swat ? GUNS.rifle : GUNS.pistol;
    act.held = spec.item;
    if (act.memo.closeT > 0) { act.memo.closeT -= dt; return lowerAny(act); }
    const dy = Math.max(0, p.y - o.y);
    if ((d < POLICE.closeR && dy < 3) || d > POLICE.playerFireR) return lowerAny(act);
    stand(act);
    endPursuit(act);
    setState(act, 'fight');
    hold(act, spec.aim);
    act.memo.pgunT = (act.memo.pgunT ?? 0.5 + Math.random() * 0.8) - dt;
    if (act.memo.pgunT > 0) return true;
    act.memo.pgunT = spec.gap * POLICE.playerGapK * (0.85 + Math.random() * 0.3);
    const r = H.gunAtPlayer(o, spec, car);
    if (r === 'held') {
      this.stats.heldAtPlayer++;
      act.memo.pheld = (act.memo.pheld ?? 0) + 1;
      if (act.memo.pheld >= 2) { act.memo.pheld = 0; act.memo.closeT = 3; act.action = null; }
      return true;
    }
    act.memo.pheld = 0;
    this.stats.atPlayer += spec.burst;
    if (!act.memo.warnedP) { act.memo.warnedP = 1; H.sound('shout_hey', o.x, o.y + 1.6, o.z, 0.9, 0.8); }
    return true;
  }

  /** Units for the dev console. */
  summary(): string {
    return this.units.map((u) => `#${u.id} ${u.job.kind}${u.job.kind === 'crime' ? ':' + u.job.crime.kind : u.job.kind === 'incident' ? ':' + u.car.kind : ''} ${u.state} car ${Math.round(Math.hypot(u.car.x - this.h.player.x, u.car.z - this.h.player.z))} m, ${u.officers.filter((o) => o.alive).length} officers`).join(' · ') || 'none';
  }
}

/** Pistol or rifle down (not shooting now). */
function lowerAny(act: Actor): false {
  if (act.action?.id === 'aim_pistol' || act.action?.id === 'aim_rifle') act.action = null;
  return false;
}

/** Weapon down (no gunfight). */
function lower(act: Actor): void {
  if (act.action?.id === 'aim_pistol') act.action = null;
}
