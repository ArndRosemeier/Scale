/**
 * The army in the game (THREATS_PLAN §2 levels 3–4, "Forces without the player", Phase B stage 2):
 * the response director's levels 3 (National Guard) and 4 (army & air) for a major threat.
 *
 *  3 National Guard   army trucks with infantry squads and APCs come along the boulevards from beyond
 *                     the monster; the squads get out on its flanks ahead of it, build sandbag walls,
 *                     take cover and fire bursts (tracers, muzzle flashes, gunfire); APCs fire their
 *                     autocannons; searchlights at night.
 *  4 Army & air       tanks hold the avenue ahead of it (the turret turns, the gun recoils, shells);
 *                     attack helicopters circle and make rocket runs (it swats them: they spin down and
 *                     crash, burning); jets bomb on runs over it; an artillery battery beyond the city
 *                     edge fires (flashes on the horizon, the boom later, shells whistling in).
 *
 * The battle model is `BattleModel` (shared with the headless "no player" battle): every unit is a
 * `ForceUnit` in a squad (the monster's aggro key); `stepForces` moves them between lines, falls back
 * when it comes too close or a squad breaks ("the line is breaking"), and fires volleys. Tiered
 * simulation: units within ARMY.matR of the player are materialised — vehicles in traffic (army
 * trucks, APCs, tanks: VehicleRenderer kinds), soldiers as crowd actors (role 'soldier': uniform,
 * helmet, rifle), their fire resolved with rays (2 Hz a squad at most) and drawn; units farther away
 * stay abstract (positions, chance-based volleys) and are only map pings and horizon effects.
 *
 * The monster answers through the Strider's hooks: `unitAt` (its breath goes for the squad that hurt
 * it most within reach), `onBlow` (breath ticks, tail sweeps, footfalls hurt the units there; a roar
 * shakes their morale), `airTargets` (it swats helicopters near its head). Soldiers never fire at
 * people; the player is only ever hurt by a stray splash (ArmyFx.explosion).
 *
 * Stage 3 / E hooks: `onOutcome` (the battle's end for the aftermath / triage and the nuke
 * countdown), `rally` and `airstrike` (the player's reputation unlocks).
 *
 * The army against the player: a rampaging giant player (threats/PlayerRampage, after its warnings)
 * is an `ArmyFoe` like the Strider — the same levels, squads and fire, its zones the player's body
 * (army damage becomes the player's health). Its route ends where the player stands, so the battle
 * model rings them; units come in from the city's side, and holding units the player has walked away
 * from go again (`regroup`). Its blows on the units are the player's own: crushed and wrecked
 * vehicles, knocked-down soldiers, helicopters swatted by a punch (`struck`).
 */
import * as THREE from 'three';
import type { Game } from '../../Game';
import { Rng, deriveSeed, hash32 } from '../../../core/rng';
import { PState, type PedAgent } from '../../../sim/Pedestrians';
import { Role } from '../../../sim/Population';
import { VState, type Vehicle, type VKind } from '../../../sim/Traffic';
import { attach, goTo, lookAt, makeActor, play, setState, stand } from '../../../sim/actors/Actor';
import { G } from '../../../render/materials/globals';
import type { MapMarker } from '../../../ui/map/GameMap';
import type { EquipmentVisuals } from '../../../items/types';
import { Strider, STRIDER, STRIDER_ZONES, type AirProvider, type StriderBlow } from '../../threats/Strider';
import { PlayerRampage } from '../../threats/PlayerRampage';
import { RAMPAGE } from '../../threats/rampageRules';
import type { DamageResult, DamageSource, ThreatEvent, ThreatOutcome, ThreatZone } from '../../threats/ThreatEvent';
import type { Incident } from '../ResponseDirector';
import {
  ARMY, FORCE, aimedVolley, hurtUnit, land, levelSquads, makeSquad, makeUnit, pathAt, pickZone, regroup, simulateBattle, stepForces, volley,
  type ForceKind, type ForceOps, type ForceUnit, type MonsterSpec, type MonsterView, type PathView, type Squad,
  type ZoneView,
} from './BattleModel';
import { ArmyFx } from './ArmyFx';
import { Aircraft } from './Aircraft';
import { TANK_GUN, TANK_TURRET } from '../../../props/military';
import { vehicleModel } from '../../../props/vehicles';

interface Body {
  car?: Vehicle;
  soldiers?: PedAgent[];
  /** Seconds before trying to materialise again (no room in traffic / on the street). */
  retryT: number;
  /** Seconds a vehicle stood still on its way. */
  stuckT: number;
}

/** What the army fights: the Strider, or a rampaging giant player (threats/PlayerRampage). */
export interface ArmyFoe {
  readonly x: number; readonly y: number; readonly z: number;
  /** Progress along its route (m) and what it is doing ('advance', 'rampage' at the route's end …). */
  readonly s: number; readonly mode: string;
  readonly zones: ThreatZone[];
  readonly route: PathView & { start: { x: number; z: number }; end: { x: number; z: number } };
  readonly targetable: boolean;
  readonly defeated: boolean;
  readonly outcome: ThreatOutcome | null;
  readonly aggro: ReadonlyMap<string, number>;
  readonly hp: number;
  readonly maxHp: number;
  readonly headPos: { x: number; y: number; z: number };
  damage(zone: ThreatZone | string | null, amount: number, src: DamageSource): DamageResult;
  /** Its hooks for the army: where a squad stands, its blows, helicopters in reach. */
  unitAt: ((key: string) => { x: number; y: number; z: number } | null) | null;
  onBlow: ((kind: StriderBlow, x: number, y: number, z: number, r: number) => void) | null;
  airTargets: AirProvider[];
  /** Where units come from (default: ahead of it along its route) and the artillery's spot (default: past the route's end). */
  spawnPoint?(k: number, level: number): { x: number; z: number };
  batteryAt?(): { x: number; z: number };
  /** It goes where it likes (the player): units holding out of reach go again. */
  readonly chased?: boolean;
}

/** The army's foe in an incident (a major threat with a body), or null. */
export function armyFoe(ev: ThreatEvent): ArmyFoe | null {
  return ev.tier === 'major' && (ev instanceof Strider || ev instanceof PlayerRampage) ? ev : null;
}

const VEHICLE_KIND: Partial<Record<ForceKind, VKind>> = { truck: 'army_truck', apc: 'apc', tank: 'tank' };
const ON_GROUND: ForceKind[] = ['truck', 'apc', 'tank', 'rifles'];
const _o = { x: 0, z: 0, dx: 0, dz: 0 };
const SPARK = new THREE.Color(4, 2.6, 1);

export class Forces {
  readonly squads: Squad[] = [];
  readonly fx: ArmyFx;
  readonly air: Aircraft;
  private inc: Incident | null = null;
  private mon: ArmyFoe | null = null;
  private view: MonsterView | null = null;
  private hooked = new WeakSet<ArmyFoe>();
  private bodies = new Map<number, Body>();
  private rng: Rng;
  /** Soldiers getting back into their truck, and the hurt walking out of it. */
  private boarding: { a: PedAgent; truck: ForceUnit | null; t: number }[] = [];
  private injured: { a: PedAgent; t: number }[] = [];
  private placed = new Set<string>();
  private blowT = new Map<string, number>();
  /** Volleys in a row with no line of sight, per unit. */
  private blockedN = new Map<number, number>();
  /** The zone each unit last had a line to (a target that goes where it likes). */
  private lastZone = new Map<number, string>();
  /** Units whose spot gave no line from where they actually stand: the next slot is somewhere else. */
  private reslot = new Set<number>();
  private battery: { x: number; z: number } | null = null;
  private time = 0;
  private markT = 0;
  private markKey = '';
  private devDone = false;
  private idle = true;
  readonly log: { t: number; what: string }[] = [];
  stats = { sent: 0, materialised: 0, soldiers: 0, vehicles: 0, lost: {} as Record<string, number>, broke: 0, routed: 0, volleys: 0, rays: 0, held: 0, heldBy: {} as Record<string, number>, reslots: 0, breaches: 0, suppress: 0, hits: 0, weak: 0, dealt: 0, msAvg: 0, peakSoldiers: 0, peakVehicles: 0 };
  /** Stage 3: the battle is over (the monster defeated or driven off by the army, or it got away). */
  onOutcome: ((o: { outcome: string; byArmy: boolean; lost: Record<string, number> }) => void) | null = null;
  /** The army's target is a rampaging giant player (threats/PlayerRampage: HostilePlayer sets it). */
  hostilePlayer = false;

  constructor(private g: Game) {
    this.rng = new Rng(deriveSeed(g.settings.seed, 'army'));
    // The military models (built once, now, not on the first spawn).
    for (const k of ['army_truck', 'apc', 'tank'] as const) vehicleModel(k);
    this.fx = new ArmyFx(g);
    this.air = new Aircraft(g);
    this.air.onCrash = (u) => this.lose(u, 'swatted out of the sky');
    this.air.onLanded = (x, y, z) => {
      this.fx.explosion(x, y + 1, z, 2.2);
      this.fx.burn(x, y, z, 60);
      this.fx.impact(x, y + 2, z, 5, 6e5, 0, -1, 0, 'stomp');
      this.g.stimuli.emit('collapse', x, y, z, 6, 80, { cause: 'military' });
    };
    const R = g.response;
    R.registerLevel(3, {
      when: (inc) => this.armyFor(inc) && ((inc.levelT >= ARMY.up3.after && inc.ev.strength() > ARMY.up3.strength) || inc.ev.hurt >= ARMY.up3.hurt),
      up: (inc) => this.engage(inc, 3),
      down: () => this.standDown(3),
    });
    R.registerLevel(4, {
      when: (inc) => this.armyFor(inc) && (inc.levelT >= ARMY.up4.after || (inc.ev.strength() > ARMY.up4.strength && this.squads.some((q) => q.broke > 0) && inc.levelT > 20)),
      up: (inc) => this.engage(inc, 4),
      down: () => this.standDown(4),
    });
  }

  /** The army comes for a major threat with a body (the Strider, a rampaging giant player). */
  private armyFor(inc: Incident): boolean { return this.enabled && !!armyFoe(inc.ev); }

  /** Off: the ladder stops at 2 (dev.army.enabled(false): measurements without the army). */
  enabled = true;

  // ================================================================== levels

  private engage(inc: Incident, level: 3 | 4): void {
    const foe = armyFoe(inc.ev);
    if (!this.enabled || !foe) return;
    this.attach(inc, foe);
    const S = this.mon!, R = S.route;
    const spawn = (k: number) => {
      if (S.spawnPoint) { const p = S.spawnPoint(k, level); return this.street(p.x, p.z, 200); }
      // From beyond it, ahead towards downtown (past the end: further on in the same direction), on a street.
      const want = S.s + ARMY.spawnR;
      const p = pathAt(R, Math.min(R.length, want), _o);
      const over = Math.max(0, want - R.length);
      const a = (k * 2.399 + level) % (Math.PI * 2);
      return this.street(p.x + p.dx * over + Math.cos(a) * 120, p.z + p.dz * over + Math.sin(a) * 120, 200);
    };
    const add = levelSquads(level, spawn);
    for (const q of add) { this.squads.push(q); this.stats.sent += q.units.length; }
    this.note(`level ${level}: ${add.map((q) => `${q.key} (${q.units.map((u) => u.kind).join('+')})`).join(', ')}`);
  }

  private attach(inc: Incident, s: ArmyFoe): void {
    this.inc = inc;
    if (this.mon === s) return;
    this.mon = s;
    const self = this;
    this.view = {
      get x() { return s.x; }, get z() { return s.z; }, get s() { return s.s; }, get mode() { return s.mode; },
      zones: s.zones,
      get head() { const h = s.headPos; return { x: h.x, y: h.y, z: h.z }; },
      damage(z, amount, key) {
        const c = self.centroid(key);
        const r = s.damage(z as ThreatZone, amount, { cause: 'military', key, x: c?.x, y: c?.y, z: c?.z });
        self.stats.dealt += r.dealt; self.stats.hits++; if (r.weak) self.stats.weak++;
        return r.dealt;
      },
    };
    if (!this.hooked.has(s)) {
      this.hooked.add(s);
      s.unitAt = (key) => this.centroid(key, true);
      s.onBlow = (kind, x, y, z, r) => this.blow(kind, x, y, z, r);
      s.airTargets.push((x, y, z, r) => this.air.airTargets(x, y, z, r));
    }
    // The battery beyond the city edge, further on past downtown.
    if (s.batteryAt) { this.battery = s.batteryAt(); return; }
    const R = s.route, e = pathAt(R, R.length, _o);
    const dx = R.end.x - R.start.x, dz = R.end.z - R.start.z, l = Math.hypot(dx, dz) || 1;
    this.battery = { x: e.x + (dx / l) * 3200, z: e.z + (dz / l) * 3200 };
  }

  /** The last resort (level 5): everyone pulls out of the strike zone — convoys leaving; no more fire. */
  withdraw(): void {
    for (const q of this.squads) for (const u of q.units) if (u.task !== 'dead') { u.task = 'leave'; u.taskT = 0; u.mounted = false; }
    this.withdrawn = true;
    this.note('pulling out (the last resort)');
  }
  /** Pulled out for the last resort (until the battle is over). */
  private withdrawn = false;

  /** A level stands down: its squads leave. */
  private standDown(level: number): void {
    for (const q of this.squads) if (q.level >= level) for (const u of q.units) if (u.task !== 'dead') u.task = 'leave';
    this.note(`level ${level} stands down`);
  }

  // ================================================================== frame

  update(dt: number): void {
    if (!this.devDone) this.installDev();
    if (this.idle && !this.squads.length) return;
    const t0 = performance.now();
    this.time += dt;
    const S = this.mon, ev = this.inc?.ev;
    if (S) this.lastAt = { x: S.x, z: S.z };
    const fighting = !!(S && ev && ev.active && S.targetable && !S.defeated) && !this.withdrawn;
    this.materialise(dt);
    const ops = this.ops(fighting);
    if (S && this.view && (fighting || S.mode === 'retreat' || S.mode === 'sink')) {
      // (A target that goes where it likes: units it has left out of reach go again.)
      if (S.chased && fighting) regroup(this.squads, this.view, RAMPAGE.regroupT, RAMPAGE.reach);
      stepForces(this.squads, this.view, S.route, dt, this.rng, () => {}, ops);
    } else this.leaveStep(dt, ops);
    this.rearmStep(dt, fighting);
    this.soldierStep(dt);
    this.tankStep(dt);
    this.searchlights();
    this.fx.update(dt);
    const units = this.units();
    this.air.update(dt, units, S && fighting ? { x: S.x, y: S.y, z: S.z } : null);
    this.prune(dt);
    this.markers(dt);
    // Over: the incident closed and everyone gone → clear the field.
    if (!this.squads.length && (!this.inc || this.inc.closed)) this.finish();
    this.idle = !this.squads.length;
    if (this.idle) { this.leaveTo.clear(); this.lastAt = null; }
    this.stats.msAvg = this.stats.msAvg * 0.95 + (performance.now() - t0) * 0.05;
  }

  units(): ForceUnit[] { return this.squads.flatMap((q) => q.units); }

  /** The game's hooks for the battle model. */
  private ops(fighting: boolean): ForceOps {
    return {
      slot: (u, x, z) => (this.mon?.chased ? this.sightSlot(u, x, z) : u.kind === 'rifles' ? this.street(x, z, 90, 4) : this.street(x, z, 140)),
      move: (u, x, z, dt) => this.move(u, x, z, dt),
      fire: (u, q, d) => (fighting ? this.fire(u, q, d) : true),
      event: (q, what, u) => this.event(q, what, u),
    };
  }

  /** The battle over: units drive / walk / fly off and leave the map. */
  private leaveStep(dt: number, ops: ForceOps): void {
    for (const q of this.squads) for (const u of q.units) {
      if (u.task === 'dead') continue;
      // (No battle at all — units spawned by hand: they stay where they are.)
      if (u.task !== 'leave') { if (!this.inc) continue; u.task = 'leave'; u.taskT = 0; }
      u.taskT += dt;
      const S = FORCE[u.kind];
      if (u.kind === 'jet' || u.kind === 'artillery') continue;
      if (u.mounted) continue;
      // Away from where it all happened, to the edge of the scene.
      const t = this.leaveTarget(u);
      const ax = t.x - u.x, az = t.z - u.z, l = Math.hypot(ax, az) || 1;
      if (u.kind === 'heli') { u.x += (ax / l) * S.speed * dt; u.z += (az / l) * S.speed * dt; continue; }
      const r = ops.move?.(u, t.x, t.z, dt);
      if (r === undefined && l > 2) { const st = Math.min(l, (S.speed / ARMY.detour) * dt); u.x += (ax / l) * st; u.z += (az / l) * st; }
    }
  }

  /** Helicopters away rearming: their squad, seconds until they are back. */
  private rearm: { key: string; t: number }[] = [];

  /** Rearmed helicopters come back to their squad (level 4 still on, the fight still going). */
  private rearmStep(dt: number, fighting: boolean): void {
    for (let i = this.rearm.length - 1; i >= 0; i--) {
      const R = this.rearm[i];
      R.t -= dt;
      if (R.t > 0) continue;
      this.rearm.splice(i, 1);
      const q = this.squads.find((sq) => sq.key === R.key), S = this.mon;
      if (!q || !S || !fighting || q.routed || (this.inc?.level ?? 0) < q.level) continue;
      const a = this.rng.range(0, Math.PI * 2);
      const u = makeUnit('heli', q.key, S.x + Math.cos(a) * 900, S.z + Math.sin(a) * 900, 1, 0);
      u.y = ARMY.heliAlt; u.ang = a;
      q.units.push(u);
      this.stats.sent++;
      this.note(`${q.key}: back, rearmed`);
    }
  }

  /** Units that have left (far off, or long enough) go; empty squads go. */
  private prune(_dt: number): void {
    const p = this.g.player.pos;
    for (let i = this.squads.length - 1; i >= 0; i--) {
      const q = this.squads[i];
      for (let k = q.units.length - 1; k >= 0; k--) {
        const u = q.units[k];
        const gone = u.task === 'leave' && (u.taskT > ARMY.leaveT * 2 || ((u.taskT > ARMY.leaveT || Math.hypot(u.x - p.x, u.z - p.z) > ARMY.dematR + 300) && !this.visibleBody(u)));
        if (!gone) continue;
        // (A helicopter that flew off with its pods empty comes back rearmed while the fight goes on.)
        if (u.kind === 'heli' && u.ammo <= 0 && !q.routed && !this.withdrawn && this.inc && !this.inc.closed) this.rearm.push({ key: q.key, t: HELI_REARM });
        this.dematerialise(u, true);
        q.units.splice(k, 1);
      }
      // A squad with nothing left but wrecks: gone once the battle is over.
      if (!q.units.some((u) => u.task !== 'dead') && (!this.inc || !this.inc.ev.active || this.inc.level < q.level)) { for (const u of q.units) this.dematerialise(u, false); this.squads.splice(i, 1); }
    }
  }

  private visibleBody(u: ForceUnit): boolean {
    const b = this.bodies.get(u.id);
    if (!b) return false;
    const p = b.car ?? b.soldiers?.[0];
    return !!p && this.g.crime['visible'](p.x, 1.5, p.z) && Math.hypot(p.x - this.g.player.pos.x, p.z - this.g.player.pos.z) < 250;
  }

  private finish(): void {
    if (this.inc && this.mon) {
      const S = this.mon;
      const byArmy = (S.outcome === 'defeated' || S.outcome === 'retreated') && [...S.aggro.keys()].some((k) => k !== 'player') && (S.aggro.get('player') ?? 0) < S.maxHp * 0.25;
      this.onOutcome?.({ outcome: S.outcome ?? 'gone', byArmy, lost: { ...this.stats.lost } });
      this.note(`over: ${S.outcome}${byArmy ? ' (the army)' : ''}`);
    }
    this.inc = null; this.mon = null; this.view = null;
    this.withdrawn = false;
    this.fx.clearEmplacements();
    this.placed.clear();
    this.lastZone.clear(); this.reslot.clear();
    this.rearm.length = 0;
    this.air.clear();
    for (const b of this.boarding) b.a.alive = false;
    this.boarding.length = 0;
    this.g.map.setMarkers('army', []);
    this.markKey = '';
  }

  // ================================================================== bodies (materialised near the player)

  private materialise(dt: number): void {
    const p = this.g.player.pos;
    let vehicles = 0, soldiers = 0;
    for (const b of this.bodies.values()) { if (b.car) vehicles++; soldiers += b.soldiers?.length ?? 0; }
    for (const q of this.squads) for (const u of q.units) {
      if (!ON_GROUND.includes(u.kind)) continue;
      const b = this.bodies.get(u.id);
      const d = Math.hypot(u.x - p.x, u.z - p.z);
      if (b?.car) {
        const car = b.car;
        if (car.state >= VState.Wreck) { if (u.task !== 'dead') this.lose(u, car.state === VState.Crushed ? 'crushed' : 'wrecked'); b.car = undefined; continue; }
        if (!car.alive || !this.g.traffic.vehicles.includes(car)) { b.car = undefined; continue; }
        if (u.task === 'dead') { this.g.traffic.wreckIt(car); b.car = undefined; continue; }
        u.x = car.x; u.z = car.z;
        if (d > ARMY.dematR) { this.dematerialise(u, false); vehicles--; }
        continue;
      }
      if (b?.soldiers) {
        b.soldiers = b.soldiers.filter((o) => this.fit(o, u, q));
        const fit = b.soldiers;
        if (!fit.length) { if (u.crew <= 0) { u.task = 'dead'; } this.bodies.delete(u.id); continue; }
        u.x = fit.reduce((a, o) => a + o.x, 0) / fit.length; u.z = fit.reduce((a, o) => a + o.z, 0) / fit.length;
        if (d > ARMY.dematR || u.mounted || u.task === 'dead') { soldiers -= fit.length; this.dematerialise(u, false); }
        continue;
      }
      if (u.task === 'dead' || d > ARMY.matR) continue;
      const body = b ?? { retryT: 0, stuckT: 0 };
      if (!b) this.bodies.set(u.id, body);
      body.retryT -= dt;
      if (body.retryT > 0) continue;
      body.retryT = 2;
      if (u.kind === 'rifles') {
        if (u.mounted || soldiers + u.crew > ARMY.maxSoldiers) continue;
        // (An abstract squad goes in straight lines — across a river, in the end: out on the bank.)
        if (this.wet(u.x, u.z)) { const p = this.street(u.x, u.z, 120, 4); u.x = p.x; u.z = p.z; }
        body.soldiers = this.spawnSoldiers(u, u.x, u.z);
        soldiers += body.soldiers.length;
        if (body.soldiers.length) this.stats.materialised++;
      } else if (vehicles < ARMY.maxVehicles) {
        const car = this.g.traffic.spawnVehicle(VEHICLE_KIND[u.kind]!, u.x, u.z, 90, { x: u.tx, z: u.tz });
        if (!car) continue;
        car.vmax = u.kind === 'tank' ? 9 : 13;
        car.speed = 0;
        car.fear = 0;
        car.task = u.task === 'hold' ? { x: car.x, z: car.z, arrived: true, hold: true } : { x: u.tx, z: u.tz, arrived: false };
        if (!car.task.arrived) this.g.traffic.sendTo(car, u.tx, u.tz);
        if (u.kind === 'tank') car.gun = { yaw: 0, pitch: 0, recoil: 0 };
        body.car = car;
        vehicles++;
        this.stats.materialised++;
      }
    }
    this.stats.vehicles = vehicles; this.stats.soldiers = soldiers;
    this.stats.peakVehicles = Math.max(this.stats.peakVehicles, vehicles);
    this.stats.peakSoldiers = Math.max(this.stats.peakSoldiers, soldiers);
  }

  /** Back to abstract: the vehicle drives on out of the simulated area, the soldiers are no longer drawn. */
  private dematerialise(u: ForceUnit, leaving: boolean): void {
    const b = this.bodies.get(u.id);
    if (!b) return;
    if (b.car && b.car.state < VState.Wreck) b.car.alive = false;
    if (b.soldiers) for (const o of b.soldiers) o.alive = false;
    void leaving;
    this.bodies.delete(u.id);
  }

  /** A soldier still in the fight (else: hurt — out of it, walking off later — or gone). */
  private fit(o: PedAgent, u: ForceUnit, q: Squad): boolean {
    if (!o.alive) return false;
    if (o.state === PState.Down) {
      // Knocked down by the monster: hurt, out of the fight (no gore; stage 3: medics, triage).
      u.crew = Math.max(0, u.crew - 1);
      u.hp = u.crew * FORCE.rifles.hp;
      q.losses++; q.morale -= ARMY.loss; q.quietT = 0;
      this.stats.lost.rifles = (this.stats.lost.rifles ?? 0) + 1;
      this.injured.push({ a: o, t: 0 });
      return false;
    }
    return true;
  }

  private spawnSoldiers(u: ForceUnit, x: number, z: number): PedAgent[] {
    const out: PedAgent[] = [];
    const g = this.g, pop = g.population;
    for (let i = 0; i < u.crew; i++) {
      let c = null;
      for (let k = 0; k < 20 && !c; k++) { const cc = pop.synthetic(hash32(u.id * 977 + i * 131 + k * 7919) || 1); if (cc.role === Role.Adult && cc.age < 0.5) c = cc; }
      if (!c) c = pop.synthetic(hash32(u.id * 31 + i) || 1);
      const a = (i / Math.max(1, u.crew)) * Math.PI * 2;
      const o = g.peds.spawnAt(c, x + Math.cos(a) * 1.5, z + Math.sin(a) * 1.5, 0, true);
      if (!o) break;
      attach(o, makeActor('soldier', -1, { hp: 120, maxHp: 120, strength: 1.7, held: 'rifle', outfit: soldierOutfit(c.seed), mood: 'focused' }));
      out.push(o);
    }
    if (out.length) g.audio.play('door_open', x, 1, z, 0.6, 0.8, 6, g.renderer.camera.position);
    return out;
  }

  // ================================================================== moving

  private move(u: ForceUnit, x: number, z: number, dt: number): boolean | undefined {
    if (u.task === 'leave') { const t = this.leaveTarget(u); x = t.x; z = t.z; }
    const b = this.bodies.get(u.id);
    if (!b) return undefined;
    if (b.car) {
      const car = b.car;
      const d = Math.hypot(car.x - x, car.z - z);
      if (d < 14) { car.task = { x: car.x, z: car.z, arrived: true, hold: true }; car.speed = 0; b.stuckT = 0; return true; }
      if (!car.task || car.task.hold || Math.hypot(car.task.x - x, car.task.z - z) > 12) {
        car.task = { x, z, arrived: false };
        car.state = VState.Drive;
        if (!this.g.traffic.sendTo(car, x, z)) { car.task = { x: car.x, z: car.z, arrived: true, hold: true }; return true; }
      }
      // Stuck behind wrecks or a jam: hold where it is.
      b.stuckT = car.speed < 0.3 ? b.stuckT + dt : 0;
      // (Stuck with the monster close: keep trying — it may come through — else hold where it is.)
      const near = this.mon ? Math.hypot(car.x - this.mon.x, car.z - this.mon.z) < 150 : false;
      if (car.task.arrived || (b.stuckT > 25 && !near)) { car.task = { x: car.x, z: car.z, arrived: true, hold: true }; return true; }
      return false;
    }
    if (b.soldiers?.length) {
      const S = this.mon, fx = S ? S.x - x : 0, fz = S ? S.z - z : 1, l = Math.hypot(fx, fz) || 1;
      let away = 0;
      b.soldiers.forEach((o, i) => {
        const p = this.coverSpot(x, z, fx / l, fz / l, i, b.soldiers!.length);
        const d = Math.hypot(p.x - o.x, p.z - o.z);
        if (d > 1.5) { away++; this.g.crime.police.chase(o, p, 3.6); }
      });
      // (A target that goes where it likes turns the line about as it goes: most of them there will do;
      // and a squad that cannot get there in the end fights from where it got to.)
      if (S?.chased && u.task === 'move') return away <= b.soldiers.length / 2 || u.taskT > 45;
      return away === 0;
    }
    return undefined;
  }

  /** Behind the sandbag wall at a slot: a line across the direction it faces (bunched on the slot where the line would reach into water). */
  private coverSpot(x: number, z: number, fx: number, fz: number, i: number, n: number): { x: number; z: number } {
    const side = (i - (n - 1) / 2) * 0.75;
    const p = { x: x - fz * side - fx * 0.2, z: z + fx * side - fz * 0.2 };
    return this.wet(p.x, p.z) ? { x, z } : p;
  }

  /**
   * Where a unit that is leaving goes: away from where the battle was, a street point 400 m off —
   * picked once (a target that moved on with it every frame led them straight off the bank into
   * the river after the battle, and had vehicles re-planning their route all the time).
   */
  private leaveTarget(u: ForceUnit): { x: number; z: number } {
    let t = this.leaveTo.get(u.id);
    if (t) return t;
    const c = this.mon ?? this.lastAt ?? { x: u.x - 1, z: u.z };
    const ax = u.x - c.x, az = u.z - c.z, l = Math.hypot(ax, az) || 1;
    t = u.kind === 'rifles' ? this.street(u.x + (ax / l) * 400, u.z + (az / l) * 400, 120, 4) : this.street(u.x + (ax / l) * 400, u.z + (az / l) * 400, 160);
    this.leaveTo.set(u.id, t);
    return t;
  }
  private leaveTo = new Map<number, { x: number; z: number }>();
  /** Where the battle's foe was last (units leave away from it once it is gone). */
  private lastAt: { x: number; z: number } | null = null;

  /**
   * A slot round a target that goes where it likes (a giant player): the street point nearest the
   * ring slot (x, z) from which a unit sees the target — tried round its side of the ring and nearer
   * in (streets running towards the target give a line down them), else the ring slot itself. Without
   * this, units on the ring stood behind buildings, never got a shot and moved on for ever.
   */
  private sightSlot(u: ForceUnit, x: number, z: number): { x: number; z: number } {
    const S = this.mon!, g = this.g;
    const snap = (px: number, pz: number) => (u.kind === 'rifles' ? this.street(px, pz, 60, 4) : this.street(px, pz, 80));
    const ax = x - S.x, az = z - S.z, R = Math.hypot(ax, az) || 1, a0 = Math.atan2(az, ax);
    const W = FORCE[u.kind].weapon, danger = FORCE[u.kind].danger;
    const reach = Math.min(W?.range ?? 1e9, RAMPAGE.reach[u.kind] ?? 1e9) * 0.95;
    const head = S.zones.find((zz) => zz.id === 'head') ?? S.zones[0], torso = S.zones.find((zz) => zz.id === 'torso') ?? head;
    const eye = u.kind === 'tank' ? 2.4 : u.kind === 'rifles' ? 1.5 : 2.6;
    // Not where it stood without a line, and not on top of another unit (a convoy parked nose to tail
    // down one street: the one in front blocks the line of the ones behind).
    const moved = this.reslot.delete(u.id), ux = u.x, uz = u.z;
    const taken: { x: number; z: number }[] = [];
    for (const q of this.squads) for (const o of q.units) {
      if (o === u || o.task === 'dead' || o.task === 'leave' || o.mounted || !ON_GROUND.includes(o.kind) || o.kind === 'truck') continue;
      taken.push({ x: o.x, z: o.z });
      if (o.task === 'move' || o.task === 'hold') taken.push({ x: o.tx, z: o.tz });
    }
    const free = (p: { x: number; z: number }) => (!moved || Math.hypot(p.x - ux, p.z - uz) > 20) && !taken.some((t) => Math.hypot(t.x - p.x, t.z - p.z) < 16);
    for (const k of SLOT_R) {
      const r = Math.max(danger + 25, Math.min(R, reach) * k);
      if (r > reach) continue;
      for (const da of SLOT_A) {
        const p = snap(S.x + Math.cos(a0 + da) * r, S.z + Math.sin(a0 + da) * r);
        const d = Math.hypot(p.x - S.x, p.z - S.z);
        if (d < danger + 10 || d > reach || !free(p)) continue;
        const y = g.world.groundHeight(p.x, p.z) + eye;
        this.stats.rays++;
        if (g.sight.clear(p.x, y, p.z, torso.x, torso.y, torso.z, torso.r) || g.sight.clear(p.x, y, p.z, head.x, head.y, head.z, head.r)) return p;
      }
    }
    return snap(x, z);
  }

  /**
   * A street point near (x, z) (lane offset `off` m), or the point itself — on dry ground: a spot
   * in a river, a lake or the sea (a ring slot over the water, the far side of a line across a
   * bank, a rally point on the shore) moves to the nearest dry street point round it.
   */
  private street(x: number, z: number, r: number, off = 0): { x: number; z: number } {
    const p = this.streetPt(x, z, r, off);
    if (!this.wet(p.x, p.z)) return p;
    for (const d of DRY_R) for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + d * 0.01;
      const q = this.streetPt(x + Math.cos(a) * d, z + Math.sin(a) * d, Math.min(r, 60), off);
      if (!this.wet(q.x, q.z)) return q;
    }
    return p;
  }

  private streetPt(x: number, z: number, r: number, off: number): { x: number; z: number } {
    const net = this.g.net;
    const ne = net.nearestEdge(x, z, r);
    if (!ne) return { x, z };
    const e = net.edges[ne.e];
    if (e.cls > 3) return { x, z };
    net.pointAt(e, ne.s, off * (ne.side >= 0 ? 1 : -1) * Math.max(1, e.width / 2 - 1.5) / Math.max(1, off || 1), _o);
    return { x: _o.x, z: _o.z };
  }

  /** Open water at (x, z) (with a metre or two of bank), not under a bridge deck. */
  private wet(x: number, z: number): boolean {
    return this.g.terrain.isWater(x, z, 2) && this.g.world.bridgeDeck(x, z) === -Infinity;
  }

  // ================================================================== soldiers and tanks, every frame

  private soldierStep(dt: number): void {
    const S = this.mon;
    for (const q of this.squads) for (const u of q.units) {
      const b = this.bodies.get(u.id);
      if (!b?.soldiers?.length) continue;
      const truck = q.units.find((t) => t.kind === 'truck' && t.task !== 'dead');
      const n = b.soldiers.length;
      const fx = S ? S.x - u.tx : 0, fz = S ? S.z - u.tz : 1, l = Math.hypot(fx, fz) || 1;
      // Dug in at the slot: sandbags (once a slot).
      if (u.task === 'hold' && S) {
        const key = `${u.id}:${Math.round(u.tx / 8)}:${Math.round(u.tz / 8)}`;
        if (!this.placed.has(key) && Math.hypot(u.x - u.tx, u.z - u.tz) < 6) { this.placed.add(key); this.fx.emplacement(u.tx + (fx / l) * 1.1, u.tz + (fz / l) * 1.1, fx / l, fz / l); }
      }
      b.soldiers.forEach((o, i) => {
        const act = o.actor!;
        act.hostile = false;
        if (u.task === 'mount' && truck) {
          // To the truck (they get in when it is there).
          if (Math.hypot(truck.x - o.x, truck.z - o.z) > 3) this.g.crime.police.chase(o, truck, 3.6);
          return;
        }
        if (u.task === 'move' || u.task === 'leave') { setState(act, 'run'); act.move = null; return; }
        const p = this.coverSpot(u.tx, u.tz, fx / l, fz / l, i, n);
        if (Math.hypot(p.x - o.x, p.z - o.z) > 0.8) { goTo(act, p.x, p.z, 2.4); setState(act, 'walk'); act.move = null; return; }
        stand(act);
        if (S) lookAt(act, S.x, S.y, S.z);
        // Firing: up and aiming; between bursts: down behind the bags.
        const firing = (act.memo.fireT ?? 0) > 0;
        act.memo.fireT = (act.memo.fireT ?? 0) - dt;
        if (firing) { act.move = null; setState(act, 'fight'); if (act.action?.id !== 'aim_rifle') play(act, 'aim_rifle', 1.4); }
        else { act.move = 'crouch'; setState(act, 'idle'); }
      });
    }
    // Boarding the truck, and the hurt walking out of it once they are up again.
    for (let i = this.boarding.length - 1; i >= 0; i--) {
      const B = this.boarding[i];
      B.t += dt;
      const t = B.truck;
      if (!B.a.alive || !t || t.task === 'dead' || B.t > 20 || Math.hypot(t.x - B.a.x, t.z - B.a.z) < 3) { B.a.alive = false; this.boarding.splice(i, 1); continue; }
      if (B.a.actor) this.g.crime.police.chase(B.a, t, 3.6);
    }
    for (let i = this.injured.length - 1; i >= 0; i--) {
      const I = this.injured[i];
      I.t += dt;
      const a = I.a, act = a.actor;
      if (!a.alive || I.t > 90) { a.alive = false; this.injured.splice(i, 1); continue; }
      if (a.state === PState.Down || !act) continue;
      act.mood = 'pain';
      const cx = S?.x ?? a.x - 1, cz = S?.z ?? a.z, ax = a.x - cx, az = a.z - cz, l = Math.hypot(ax, az) || 1;
      goTo(act, a.x + (ax / l) * 10, a.z + (az / l) * 10, 1.1);
      setState(act, 'walk');
      if (Math.hypot(ax, az) > 300 && !this.g.crime['visible'](a.x, 1.5, a.z)) { a.alive = false; this.injured.splice(i, 1); }
    }
  }

  /** Turrets follow the monster; the gun recoils after a shot. */
  private tankStep(dt: number): void {
    const S = this.mon;
    for (const q of this.squads) for (const u of q.units) {
      const car = this.bodies.get(u.id)?.car;
      if (!car?.gun) continue;
      const G2 = car.gun;
      G2.recoil = Math.max(0, G2.recoil - dt * 1.4);
      if (!S || !S.targetable) { G2.yaw *= Math.exp(-dt); G2.pitch *= Math.exp(-dt); continue; }
      const aim = this.aimOf(u) ?? { x: S.x, y: S.y, z: S.z };
      const a = this.tankAim(car, aim);
      G2.yaw += clampA(a.yaw - G2.yaw, 0.45 * dt);
      G2.pitch += Math.max(-0.2 * dt, Math.min(0.2 * dt, a.pitch - G2.pitch));
    }
  }

  private aimAt = new Map<number, { x: number; y: number; z: number }>();
  private aimOf(u: ForceUnit): { x: number; y: number; z: number } | null { return this.aimAt.get(u.id) ?? null; }

  /** Turret yaw (relative to the hull) and gun pitch to point at a world point. */
  private tankAim(car: Vehicle, p: { x: number; y: number; z: number }): { yaw: number; pitch: number } {
    const dx = p.x - car.x, dz = p.z - car.z, h = Math.hypot(dx, dz) || 1;
    const yaw = angle(Math.atan2(-dx, -dz) - car.yaw);
    const pitch = Math.max(-0.1, Math.min(0.35, Math.atan2(p.y - (car.y + TANK_TURRET[1] + TANK_GUN[1]), h)));
    return { yaw, pitch };
  }

  /** Searchlights at night: from the vehicles holding near the monster, sweeping over it (≤ 4). */
  private searchlights(): void {
    const S = this.mon;
    if (!S || !S.targetable || G.uNight.value < 0.3) return;
    const cam = this.g.renderer.camera.position;
    let n = 0;
    for (const q of this.squads) for (const u of q.units) {
      if (n >= 4 || (u.kind !== 'truck' && u.kind !== 'apc') || u.task !== 'hold') continue;
      const car = this.bodies.get(u.id)?.car;
      if (!car || Math.hypot(car.x - cam.x, car.z - cam.z) > 700 || Math.hypot(car.x - S.x, car.z - S.z) > 450) continue;
      const k = (G.uNight.value - 0.3) / 0.7;
      const sw = Math.sin(this.time * 0.35 + u.id) * 9, up = Math.sin(this.time * 0.23 + u.id * 2) * 6;
      this.fx.searchlight(car.x, car.y + (u.kind === 'apc' ? 2.9 : 3.3), car.z, S.x + Math.cos(u.id) * sw, S.y + 8 + up, S.z + Math.sin(u.id) * sw, k);
      n++;
    }
  }

  // ================================================================== fire

  /** The game's way of firing a volley (true: done here). Far ground units: false (the model resolves it by chance). */
  private fire(u: ForceUnit, q: Squad, dist: number): boolean {
    const S = this.mon;
    if (!S) return true;
    switch (u.kind) {
      case 'heli': return this.rockets(u, q, dist);
      case 'jet': return this.jetRun(u, q);
      case 'artillery': return this.artillery(u, q);
      default: break;
    }
    const b = this.bodies.get(u.id);
    if (!b?.car && !b?.soldiers?.length) return false;
    const W = FORCE[u.kind].weapon!;
    const mz = this.muzzle(u, b);
    // (A tank sights from its turret: its long gun may poke past a corner.)
    const o = u.kind === 'tank' && b.car ? { x: b.car.x, y: b.car.y + 2.4, z: b.car.z } : mz;
    // Line of sight (the shared rule, combat/sight: buildings, terrain, cars — their own vehicle
    // aside): the zone it aims at, else the high back over the roofs in front. Targeted fire
    // (combat/shot.ts): no clear line, no volley; a clear one, every round hits.
    const sight = this.g.sight, own = b.car ?? null;
    // (A target that goes where it likes: the zone it hit last first — a tank's gun stays laid.)
    const last = S.chased ? S.zones.find((z) => z.id === this.lastZone.get(u.id)) : undefined;
    let aimZ = last ?? (pickZone(this.rng, S.zones, true, W.aimWeak) as ThreatZone);
    let ax = aimZ.x, ay = aimZ.y, az = aimZ.z;
    let blocked = !sight.clear(o.x, o.y, o.z, ax, ay, az, aimZ.r, own);
    this.stats.rays++;
    // (A giant player: whatever part of it shows over the cars and round the corner — a shoulder past
    // a corner, the top of the head over the roofs; not only the middle of each part.)
    if (blocked && S.chased) {
      const fx = aimZ.x - o.x, fz = aimZ.z - o.z, fl = Math.hypot(fx, fz) || 1, px = -fz / fl, pz = fx / fl;
      search: for (const z of [aimZ, ...S.zones.filter((zz) => zz !== aimZ)]) {
        for (let k = z === aimZ ? 1 : 0; k < SEE.length; k++) {
          const [side, up] = SEE[k], tx = z.x + px * side * z.r, ty = z.y + up * z.r, tz = z.z + pz * side * z.r;
          this.stats.rays++;
          if (sight.clear(o.x, o.y, o.z, tx, ty, tz, k ? 0.5 : z.r, own)) { aimZ = z; ax = tx; ay = ty; az = tz; blocked = false; break search; }
        }
      }
    }
    if (S.chased) { if (blocked) this.lastZone.delete(u.id); else this.lastZone.set(u.id, aimZ.id); }
    // (The high back over the roofs in front; a giant player's head.)
    const high = S.zones.find((z) => z.id === 'back') ?? S.zones.find((z) => z.id === 'head');
    if (blocked && high && aimZ !== high) {
      aimZ = high;
      ax = aimZ.x; ay = aimZ.y + aimZ.r * 0.5; az = aimZ.z;
      blocked = !sight.clear(o.x, o.y, o.z, ax, ay, az, aimZ.r, own);
      this.stats.rays++;
    }
    // No line of sight from here, volley after volley: shift along the line to another spot.
    const nb = blocked ? (this.blockedN.get(u.id) ?? 0) + 1 : 0;
    this.blockedN.set(u.id, nb);
    if (nb >= 3) { this.blockedN.set(u.id, 0); u.slot = (u.slot + 1) % 6; if (S.chased) { this.reslot.add(u.id); this.stats.reslots++; } if (u.task === 'hold') u.task = 'inbound'; return true; }
    // (A tank with a building between it and a giant player: it shoots its way through — the shell
    // blasts the facade in front, and the hole it leaves may give it its line next time.)
    if (blocked && S.chased && u.kind === 'tank' && b.car) return this.breachShot(u, b.car, mz, ax, ay, az);
    // (Rifles and APCs against a giant player with no clear line: fire over the roofs at the head
    // anyway — the battle model's rule for units out of sight, a hit by chance, never a weak spot.)
    if (blocked && S.chased && (u.kind === 'rifles' || u.kind === 'apc') && high) {
      this.stats.suppress++;
      aimZ = high; ax = high.x; ay = high.y + high.r * 0.5; az = high.z;
      return this.volleyFx(u, q, b, o, ax, ay, az, volley(this.rng, W, dist, q.morale, [high], false).map((h) => ({ zone: h.zone, dmg: h.dmg * 0.6 })));
    }
    if (blocked) { this.stats.held++; this.stats.heldBy[u.kind] = (this.stats.heldBy[u.kind] ?? 0) + 1; u.cool = Math.min(u.cool, 1.5); return true; }
    if (u.kind === 'tank') return this.tankShot(u, q, b.car!, mz, aimZ, dist, { x: ax, y: ay, z: az });
    return this.volleyFx(u, q, b, o, ax, ay, az, aimedVolley(this.rng, W, dist, q.morale, S.zones));
  }

  /** A rifle / APC volley: the hits land; bursts with tracers, flashes, sparks on the hide. */
  private volleyFx(u: ForceUnit, q: Squad, b: Body, o: { x: number; y: number; z: number }, ax: number, ay: number, az: number, hits: { zone: ZoneView; dmg: number }[]): boolean {
    const dx = ax - o.x, dy = ay - o.y, dz = az - o.z, L = Math.hypot(dx, dy, dz) || 1;
    q.fired++;
    this.stats.volleys++;
    const crewK = u.kind === 'rifles' ? u.crew / FORCE.rifles.crew : 1;
    for (const h of hits) if (crewK >= 1 || this.rng.chance(crewK)) land(u, q, this.view!, h.zone, h.dmg, () => {});
    // What it looks like: bursts with tracers (every third round lights up), flashes, sparks on the hide.
    const cam = this.g.renderer.camera.position;
    const endFor = (k: number) => {
      const h = hits[k % Math.max(1, hits.length)];
      if (h && k < hits.length) { const z = h.zone as ThreatZone; return { x: z.x + (this.rng.float() - 0.5) * z.r, y: z.y + (this.rng.float() - 0.5) * z.r, z: z.z + (this.rng.float() - 0.5) * z.r }; }
      // A miss: past it, on into the sky or the street beyond.
      return { x: ax + dx / L * 60 + (this.rng.float() - 0.5) * 30, y: ay + dy / L * 60 + (this.rng.float() - 0.3) * 20, z: az + dz / L * 60 + (this.rng.float() - 0.5) * 30 };
    };
    if (u.kind === 'rifles') {
      b.soldiers!.forEach((s, i) => {
        if (s.actor) s.actor.memo.fireT = 1.6;
        const m = { x: s.x + dx / L * 0.7, y: s.y + 1.45, z: s.z + dz / L * 0.7 };
        for (let k = 0; k < 2; k++) {
          const e = endFor(i * 2 + k);
          this.fx.tracer(m.x, m.y, m.z, e.x, e.y, e.z, 700, 6, 0.09, 3.2, 1.3, 0.35, 0.25 + k * 0.35 + i * 0.05);
        }
        this.fx.flash(m.x, m.y, m.z, dx / L, dy / L, dz / L, 0.35);
      });
      this.g.audio.play('army_rifle', o.x, o.y, o.z, 0.85, 0.95 + this.rng.float() * 0.1, 14, cam);
    } else {
      // APC autocannon: heavy tracers in a quick string.
      for (let k = 0; k < FORCE[u.kind].weapon!.shots; k++) {
        const e = endFor(k);
        this.fx.tracer(o.x, o.y, o.z, e.x, e.y, e.z, 900, 10, 0.2, 3.5, 1.6, 0.4, k * 0.15);
      }
      this.fx.flash(o.x, o.y, o.z, dx / L, dy / L, dz / L, 0.8);
      this.g.audio.play('army_autocannon', o.x, o.y, o.z, 0.9, 1, 22, cam);
    }
    for (const h of hits) { const z = h.zone as ThreatZone; this.g.debris.chipBurst(z.x, z.y, z.z, 3, 4, -dx / L, -dy / L, -dz / L, SPARK, 0.04, 0.4); }
    this.g.stimuli.emit('gunfire', o.x, o.y, o.z, 4, 140, { cause: 'military' });
    return true;
  }

  /** Where its rounds leave from (a soldier's rifle, the APC's cannon, the tank's muzzle). */
  private muzzle(u: ForceUnit, b: Body): { x: number; y: number; z: number } {
    if (b.soldiers?.length) { const s = b.soldiers[0]; return { x: u.x, y: s.y + 1.5, z: u.z }; }
    const car = b.car!;
    if (u.kind === 'tank' && car.gun) {
      const yaw = car.yaw + car.gun.yaw, c = Math.cos(car.gun.pitch);
      return { x: car.x - Math.sin(yaw) * (5.6 * c + 2.2), y: car.y + TANK_TURRET[1] + TANK_GUN[1] + Math.sin(car.gun.pitch) * 5.6, z: car.z - Math.cos(yaw) * (5.6 * c + 2.2) };
    }
    return { x: car.x, y: car.y + 2.6, z: car.z };
  }

  /** A tank: turn the turret first; then the shot (recoil, flash, the shell flies; it lands on the body, a facade or the street). */
  private tankShot(u: ForceUnit, q: Squad, car: Vehicle, o: { x: number; y: number; z: number }, zone: ThreatZone, dist: number, at: { x: number; y: number; z: number } = zone): boolean {
    this.aimAt.set(u.id, { x: at.x, y: at.y, z: at.z });
    const a = this.tankAim(car, at), G2 = car.gun!;
    if (Math.abs(angle(a.yaw - G2.yaw)) > 0.06 || Math.abs(a.pitch - G2.pitch) > 0.05) { u.cool = 0.4; return true; }
    q.fired++;
    this.stats.volleys++;
    G2.recoil = 0.55;
    const S = this.mon!, W = FORCE.tank.weapon!;
    const hits = aimedVolley(this.rng, W, dist, q.morale, S.zones);
    const dx = zone.x - o.x, dy = zone.y - o.y, dz = zone.z - o.z, L = Math.hypot(dx, dy, dz) || 1;
    const cam = this.g.renderer.camera.position;
    this.fx.flash(o.x, o.y, o.z, dx / L, dy / L, dz / L, 2.6);
    this.g.dust.burst(car.x, car.y + 0.3, car.z, 14, 4, 3, 2.5, 2.5, DUST, 0.2, 0.45);
    this.g.audio.play('army_tank', o.x, o.y, o.z, 1, 0.95 + this.rng.float() * 0.1, 45, cam);
    this.g.stimuli.emit('gunfire', o.x, o.y, o.z, 6, 220, { cause: 'military' });
    const d = Math.hypot(this.g.player.pos.x - o.x, this.g.player.pos.z - o.z);
    if (d < 120) this.g.camRig.addShake(Math.min(0.25, 6 / Math.max(15, d)));
    let end: { x: number; y: number; z: number };
    const h = hits[0];
    if (h) { const z = h.zone as ThreatZone; end = { x: z.x, y: z.y, z: z.z }; }
    else end = this.missPoint(o, zone, 20);
    this.fx.projectile('shell', o.x, o.y, o.z, end.x, end.y, end.z, Math.hypot(end.x - o.x, end.y - o.y, end.z - o.z) / 900, () => {
      if (h && this.view) { land(u, q, this.view, h.zone, h.dmg, () => {}); this.fx.explosion(end.x, end.y, end.z, 1.4, true); this.g.audio.play('army_hit', end.x, end.y, end.z, 1, 1, 40, cam); }
      else this.groundHit(end.x, end.y, end.z, 1.5, dx / L, dy / L, dz / L);
    });
    return true;
  }

  /** A tank shooting into the building between it and the target (turret first; the shell bursts on the facade). */
  private breachShot(u: ForceUnit, car: Vehicle, o: { x: number; y: number; z: number }, tx: number, ty: number, tz: number): boolean {
    const dx = tx - o.x, dy = ty - o.y, dz = tz - o.z, L = Math.hypot(dx, dy, dz) || 1;
    const h = this.g.targeting.probe(o.x, o.y, o.z, dx / L, dy / L, dz / L, L, null, NO_KINDS);
    this.stats.rays++;
    // (Nothing to blast — terrain, a car: it holds its fire.)
    if ((h.what !== 'building' && h.what !== 'roof') || h.t < 8) { this.stats.held++; this.stats.heldBy[u.kind] = (this.stats.heldBy[u.kind] ?? 0) + 1; u.cool = Math.min(u.cool, 1.5); return true; }
    this.aimAt.set(u.id, { x: h.x, y: h.y, z: h.z });
    const a = this.tankAim(car, h), G2 = car.gun!;
    if (Math.abs(angle(a.yaw - G2.yaw)) > 0.06 || Math.abs(a.pitch - G2.pitch) > 0.05) { u.cool = 0.4; return true; }
    this.stats.breaches++;
    G2.recoil = 0.55;
    const cam = this.g.renderer.camera.position;
    this.fx.flash(o.x, o.y, o.z, dx / L, dy / L, dz / L, 2.6);
    this.g.dust.burst(car.x, car.y + 0.3, car.z, 14, 4, 3, 2.5, 2.5, DUST, 0.2, 0.45);
    this.g.audio.play('army_tank', o.x, o.y, o.z, 1, 0.95 + this.rng.float() * 0.1, 45, cam);
    this.g.stimuli.emit('gunfire', o.x, o.y, o.z, 6, 220, { cause: 'military' });
    const ex = h.x, ey = h.y, ez = h.z;
    this.fx.projectile('shell', o.x, o.y, o.z, ex, ey, ez, h.t / 900, () => this.groundHit(ex, ey, ez, 1.5, dx / L, dy / L, dz / L));
    return true;
  }

  /** A shell / rocket / bomb that missed the body: on along its line to a facade or the street. */
  private missPoint(o: { x: number; y: number; z: number }, zone: ThreatZone, spread: number): { x: number; y: number; z: number } {
    const S = this.mon!;
    const tx = zone.x + (this.rng.float() - 0.5) * spread * 2, tz = zone.z + (this.rng.float() - 0.5) * spread * 2;
    const dx = tx - o.x, dz = tz - o.z, L = Math.hypot(dx, dz) || 1;
    // Past the body, down to the ground behind it.
    const ty = this.g.world.groundHeight(tx + (dx / L) * 25, tz + (dz / L) * 25);
    const end = { x: tx + (dx / L) * 25, y: ty + 0.5, z: tz + (dz / L) * 25 };
    const ddx = end.x - o.x, ddy = end.y - o.y, ddz = end.z - o.z, l3 = Math.hypot(ddx, ddy, ddz) || 1;
    const h = this.g.targeting.probe(o.x, o.y, o.z, ddx / l3, ddy / l3, ddz / l3, l3, null, NO_KINDS);
    this.stats.rays++;
    void S;
    return h.what !== 'none' ? { x: h.x, y: h.y, z: h.z } : end;
  }

  /** A miss lands: an explosion, a destruction impact (budgeted), a scorch mark on the street. */
  private groundHit(x: number, y: number, z: number, size: number, dx: number, dy: number, dz: number): void {
    this.fx.explosion(x, y, z, size);
    this.fx.impact(x - dx * 0.5, y, z - dz * 0.5, 2 + size * 1.5, 1.6e5 * size, dx, dy, dz);
    if (y - this.g.terrain.height(x, z) < 2) this.fx.scorch(x, y, z, size);
    // Cars right there are thrown about.
    for (const v of this.g.traffic.near(x, z, 3 + size * 2)) if (v.state < VState.Wreck && !VEHICLE_KIND_SET.has(v.kind)) { this.g.traffic.wreckIt(v); this.g.vehicles.makeWreck(v, v.x, v.y + 0.5, v.z, 0, 4000 * size, 0); this.g.consequences.record('army', 'car', 'wreck', v.x, v.z, v, 'military'); }
  }

  /** When each helicopter last looked for a line to fire along (s). */
  private heliLook = new Map<number, number>();

  /** A helicopter's rocket run: a salvo of eight from the pods. */
  private rockets(u: ForceUnit, q: Squad, dist: number): boolean {
    const S = this.mon!, from = this.air.heliPos(u);
    if (!from) return false;
    const W = FORCE.heli.weapon!;
    const hits = aimedVolley(this.rng, W, dist, q.morale, S.zones);
    // Targeted: a clear line from the helicopter to the part it goes for, or the run is held (the rockets kept).
    const z0 = (hits[0]?.zone ?? S.zones[0]) as ThreatZone;
    // (No line yet — towers in between: it keeps closing in and looks again, a few times a second,
    // until it is at its pass distance; only then is the run given up. It used to fire at 300 m or
    // not at all, and most runs over downtown ended without a rocket.)
    const again = () => { if (dist > u.tx + 10) u.run = 1; u.ammo++; return true; };
    if (this.time - (this.heliLook.get(u.id) ?? -9) < 0.3) return again();
    this.heliLook.set(u.id, this.time);
    this.stats.rays++;
    if (!this.g.sight.clear(from.x, from.y - 0.4, from.z, z0.x, z0.y, z0.z, z0.r)) {
      if (dist > u.tx + 10) return again();
      this.stats.held++; this.stats.heldBy[u.kind] = (this.stats.heldBy[u.kind] ?? 0) + 1; u.ammo++; return true;
    }
    q.fired++;
    this.stats.volleys++;
    const cam = this.g.renderer.camera.position;
    this.g.audio.play('army_rocket', from.x, from.y, from.z, 1, 1, 40, cam);
    for (let k = 0; k < W.shots; k++) {
      const side = k & 1 ? 1 : -1, c = Math.cos(from.yaw), s = Math.sin(from.yaw);
      const ox = from.x + c * side * 1.85, oz = from.z - s * side * 1.85, oy = from.y - 0.2;
      const h = hits[k];
      const zone = (h?.zone ?? S.zones[this.rng.int(0, S.zones.length - 1)]) as ThreatZone;
      const end = h ? { x: zone.x + (this.rng.float() - 0.5) * zone.r, y: zone.y + (this.rng.float() - 0.5) * zone.r, z: zone.z + (this.rng.float() - 0.5) * zone.r } : this.missPoint({ x: ox, y: oy, z: oz }, zone, 14);
      const T = Math.hypot(end.x - ox, end.y - oy, end.z - oz) / 260;
      this.fx.projectile('rocket', ox, oy, oz, end.x, end.y, end.z, T, () => {
        if (h && this.view) { land(u, q, this.view, h.zone, h.dmg, () => {}); this.fx.explosion(end.x, end.y, end.z, 1.1, true); }
        else this.groundHit(end.x, end.y, end.z, 1, 0, -1, 0);
      }, 0, k * 0.18);
    }
    this.g.stimuli.emit('gunfire', from.x, from.y, from.z, 5, 200, { cause: 'military' });
    return true;
  }

  /** A jet run: two jets over it, four bombs along their line (hits on the body, the rest in the street). */
  private jetRun(u: ForceUnit, q: Squad): boolean {
    const S = this.mon!;
    if (this.air.jetsActive) { u.cool = 5; return true; }
    q.fired++;
    this.stats.volleys++;
    const ang = this.rng.range(0, Math.PI * 2), W = FORCE.jet.weapon!;
    this.air.jetRun(S.x, S.z, ang, (x, y, z, vx, _vy, vz) => {
      if (!this.view || !S.targetable) return;
      const hits = volley(this.rng, W, 0, q.morale, S.zones, true);
      const l = Math.hypot(vx, vz) || 1;
      for (let k = 0; k < W.shots; k++) {
        const h = hits[k];
        const along = (k - (W.shots - 1) / 2) * 16;
        const zone = h?.zone as ThreatZone | undefined;
        const px = S.x + (vx / l) * along, pz = S.z + (vz / l) * along;
        const end = zone ? { x: zone.x, y: zone.y + zone.r * 0.6, z: zone.z } : { x: px + (this.rng.float() - 0.5) * 16, y: this.g.world.groundHeight(px, pz) + 0.3, z: pz + (this.rng.float() - 0.5) * 16 };
        this.fx.projectile('bomb', x + (vx / l) * k * 8, y, z + (vz / l) * k * 8, end.x, end.y, end.z, 1.9 + k * 0.12, () => {
          if (h && this.view) { land(u, q, this.view, h.zone, h.dmg, () => {}); this.fx.explosion(end.x, end.y, end.z, 2.6, true); }
          else this.groundHit(end.x, end.y, end.z, 2.8, 0, -1, 0);
        }, 12);
      }
    });
    this.note('jets: bombing run');
    return true;
  }

  /** The battery beyond the city edge: flashes on the horizon, the shells arrive ~9 s later. */
  private artillery(u: ForceUnit, q: Squad): boolean {
    const S = this.mon!, B = this.battery;
    if (!B) return false;
    q.fired++;
    this.stats.volleys++;
    this.fx.horizonFlash(B.x, B.z);
    const W = FORCE.artillery.weapon!;
    const hits = volley(this.rng, W, 0, q.morale, S.zones, false);
    const cam = this.g.renderer.camera.position;
    for (let k = 0; k < W.shots; k++) {
      const h = hits[k];
      const delay = 8 + k * 0.7;
      setTimeout(() => { if (S.targetable) this.g.audio.play('army_whistle', S.x, S.y + 30, S.z, 0.8, 0.95 + k * 0.05, 120, cam); }, (delay - 0.6) * 1000);
      // Coming in steeply from above, its target where the monster will be.
      const tx = S.x + this.rng.range(-35, 35), tz = S.z + this.rng.range(-35, 35);
      this.fx.projectile('arty', tx - 60, S.y + 500, tz - 60, tx, this.g.world.groundHeight(tx, tz) + 0.4, tz, 1.4, () => {
        const M = this.mon;
        if (h && M && M.targetable && this.view) {
          const z = M.zones.find((zz) => zz.id === h.zone.id) ?? M.zones[Math.min(3, M.zones.length - 1)];
          land(u, q, this.view, z, h.dmg, () => {});
          this.fx.explosion(z.x, z.y + z.r * 0.5, z.z, 1.8, true);
        } else this.groundHit(tx, this.g.world.groundHeight(tx, tz) + 0.4, tz, 1.8, 0, -1, 0);
      }, 0, delay);
    }
    return true;
  }

  // ================================================================== the monster's blows

  private blow(kind: StriderBlow, x: number, y: number, z: number, r: number): void {
    if (!this.squads.length) return;
    const now = this.time;
    for (const q of this.squads) {
      if (kind === 'roar') {
        for (const u of q.units) { if (u.task === 'dead') continue; const d = Math.hypot(u.x - x, u.z - z); if (d < r) { q.morale -= ARMY.roar * (d < 120 ? 2 : 1); break; } }
        continue;
      }
      for (const u of q.units) {
        if (u.task === 'dead' || u.mounted || u.kind === 'heli' || u.kind === 'jet' || u.kind === 'artillery') continue;
        const b = this.bodies.get(u.id);
        if (b?.soldiers?.length) {
          // Soldiers there are knocked flat (hurt, out of the fight: `fit` counts them).
          for (const o of b.soldiers) if (o.state !== PState.Down && Math.hypot(o.x - x, o.z - z) < r + 1.5 && Math.abs(o.y - y) < r + 4) this.g.reactions.knockDown(o, x, z, kind === 'breath' ? 6 : 9, 'threat');
          if (kind === 'breath' && Math.hypot(u.x - x, u.z - z) < r + 6) q.morale -= ARMY.scorched * 0.25;
          continue;
        }
        const d = Math.hypot(u.x - x, u.z - z) - (b?.car ? b.car.length * 0.4 : 3);
        if (d > r) continue;
        // (A tail sweep or a slam hits a unit once, not on every frame it lasts.)
        const key = `${u.id}:${kind}`, last = this.blowT.get(key) ?? -9;
        if (kind !== 'breath' && now - last < 1.5) continue;
        this.blowT.set(key, now);
        const dmg = kind === 'breath' ? ARMY.breathDmg * 0.25 : kind === 'swipe' ? ARMY.swipeDmg : kind === 'fall' ? 4000 : 2500;
        const crew = u.crew;
        const res = hurtUnit(u, q, dmg * Math.max(0.4, 1 - Math.max(0, d) / (r * 1.6)), this.rng);
        if (kind === 'breath') q.morale -= ARMY.scorched * 0.25;
        if (res.lost) this.stats.lost[u.kind] = (this.stats.lost[u.kind] ?? 0) + (u.kind === 'rifles' ? crew - u.crew : 1);
        if (res.dead) {
          this.note(`${q.key}: ${FORCE[u.kind].name} lost (${kind})`);
          const car = b?.car;
          if (car && car.state < VState.Wreck) {
            if (kind === 'step' || kind === 'fall' || kind === 'slam') this.g.traffic.crush(car);
            else { this.g.traffic.wreckIt(car); this.g.vehicles.makeWreck(car, car.x, car.y + 1, car.z, (car.x - x) * 2000, 30000, (car.z - z) * 2000); }
            this.fx.explosion(car.x, car.y + 1.5, car.z, 1.6);
          }
          if (u.kind === 'truck') { const rf = q.units.find((t) => t.kind === 'rifles' && t.mounted); if (rf) { rf.mounted = false; rf.task = 'inbound'; } }
        }
      }
    }
  }

  /** A unit lost (wrecked, crushed, swatted): the squad's morale takes it. */
  private lose(u: ForceUnit, how: string): void {
    const q = this.squads.find((s) => s.key === u.squad);
    if (u.task !== 'dead' || u.hp > 0 || u.kind === 'heli') {
      u.task = 'dead'; u.hp = 0;
      if (q) { q.losses++; q.morale -= ARMY.loss * 1.6; q.quietT = 0; }
      this.stats.lost[u.kind] = (this.stats.lost[u.kind] ?? 0) + 1;
    }
    this.note(`${u.squad}: ${FORCE[u.kind].name} ${how}`);
  }

  private event(q: Squad, what: string, u?: ForceUnit): void {
    if (what === 'break') { this.stats.broke++; this.note(`${q.key}: the line is breaking`); }
    else if (what === 'rout') { this.stats.routed++; this.note(`${q.key}: routed`); }
    else if (what === 'dismount' && u) {
      // Out of the truck (when it is here to be seen).
      const truck = q.units.find((t) => t.kind === 'truck');
      const b = this.bodies.get(u.id);
      if (truck && this.bodies.get(truck.id)?.car && !b?.soldiers) {
        const car = this.bodies.get(truck.id)!.car!;
        const rx = car.x + Math.sin(car.yaw) * 5, rz = car.z + Math.cos(car.yaw) * 5;
        const sol = this.spawnSoldiers(u, rx, rz);
        this.bodies.set(u.id, { soldiers: sol, retryT: 0, stuckT: 0 });
      }
    } else if (what === 'mount' && u) {
      const b = this.bodies.get(u.id);
      const truck = q.units.find((t) => t.kind === 'truck' && t.task !== 'dead') ?? null;
      if (b?.soldiers) { for (const o of b.soldiers) this.boarding.push({ a: o, truck, t: 0 }); b.soldiers = undefined; this.bodies.delete(u.id); }
    }
  }

  /** Where a squad is (its units on the ground, not riding; helicopters only with `air`). */
  centroid(key: string, ground = false): { x: number; y: number; z: number } | null {
    const q = this.squads.find((s) => s.key === key);
    if (!q) return null;
    let x = 0, z = 0, n = 0;
    for (const u of q.units) {
      if (u.task === 'dead' || u.task === 'leave' || u.mounted || u.kind === 'jet' || u.kind === 'artillery' || (ground && u.kind === 'heli')) continue;
      x += u.x; z += u.z; n++;
    }
    if (!n) return null;
    x /= n; z /= n;
    return { x, y: this.g.world.groundHeight(x, z) + 1.5, z };
  }

  // ================================================================== map, dev

  private markers(dt: number): void {
    this.markT -= dt;
    if (this.markT > 0) return;
    this.markT = 0.5;
    const list: MapMarker[] = [];
    for (const q of this.squads) {
      const c = this.centroid(q.key);
      const heli = q.units.find((u) => u.kind === 'heli' && u.task !== 'dead');
      const at = c ?? (heli ? { x: heli.x, z: heli.z } : null);
      if (!at || q.kind === 'jet' || q.kind === 'artillery') continue;
      const state = q.routed ? 'pulling out' : q.units.some((u) => u.task === 'leave') ? 'leaving' : q.units.some((u) => u.task === 'fallback' || (u.task === 'move' && q.broke)) ? 'the line is breaking' : q.units.some((u) => u.task === 'hold') ? 'holding the line' : 'moving up';
      list.push({ x: at.x, z: at.z, color: '#8a9a72', kind: 'dot', title: `${FORCE[q.kind].title} — ${state}` });
    }
    const key = list.map((m) => `${Math.round(m.x / 4)},${Math.round(m.z / 4)},${m.title?.length}`).join(';');
    if (key !== this.markKey) { this.markKey = key; this.g.map.setMarkers('army', list); }
  }

  private note(what: string): void {
    this.log.push({ t: +this.time.toFixed(1), what });
    if (this.log.length > 60) this.log.shift();
  }

  /** The battle at a glance (admin console, dev.army.status). */
  status(): Record<string, unknown> {
    const S = this.mon;
    return {
      level: this.inc?.level ?? 0,
      monster: S ? { mode: S.mode, hp: Math.round(S.hp), aggro: Object.fromEntries([...S.aggro].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => [k, Math.round(v)])) } : null,
      squads: this.squads.map((q) => ({
        key: q.key, kind: q.kind, morale: +q.morale.toFixed(2), broke: q.broke, dealt: Math.round(q.dealt), weak: q.weak, fired: q.fired,
        units: q.units.map((u) => `${u.kind}${u.kind === 'rifles' ? '×' + u.crew : ''}:${u.task}${u.mounted ? '(riding)' : ''}${this.bodies.get(u.id)?.car || this.bodies.get(u.id)?.soldiers ? '*' : ''} ${Math.round(Math.hypot(u.x - (S?.x ?? u.x), u.z - (S?.z ?? u.z)))}m`).join(', '),
      })),
      stats: { ...this.stats, lost: { ...this.stats.lost }, fx: this.fx.stats, air: this.air.stats },
      log: this.log.slice(-8).map((l) => `${l.t}: ${l.what}`),
    };
  }

  /** The player's rally (src/game/aftermath/Command, reputation unlock): squads within r of (x, z) gather on them. */
  rally(x: number, z: number, r = 350): number {
    if (this.withdrawn) return 0;
    let n = 0;
    for (const q of this.squads) for (const u of q.units) if (u.task !== 'dead' && u.task !== 'leave' && u.kind !== 'heli' && u.kind !== 'jet' && u.kind !== 'artillery' && Math.hypot(u.x - x, u.z - z) < r) {
      // (Round the player, on the street: never the river bank they stand on, or the water they hover over.)
      // (Each unit its own spot round them, the same every call: re-gathered every few seconds, they
      // only move when the player has, instead of milling about and re-planning their way each time.)
      const a = (hash32(u.id * 7919 + 17) / 2 ** 32) * Math.PI * 2, rr = u.kind === 'rifles' ? 12 + (u.id % 3) * 5 : 24 + (u.id % 3) * 8;
      const p = u.kind === 'rifles' ? this.street(x + Math.cos(a) * rr, z + Math.sin(a) * rr, 60, 4) : this.street(x + Math.cos(a) * rr, z + Math.sin(a) * rr, 120);
      if (u.task === 'move' || u.task === 'hold') if (Math.hypot(p.x - u.tx, p.z - u.tz) < 10) { n++; continue; }
      u.tx = p.x; u.tz = p.z; u.task = 'move'; u.taskT = 0; n++;
    }
    return n;
  }

  /** An airstrike on a point now (the player's call on a Tab target, src/game/aftermath/Command; dev): a jet run. */
  airstrike(x: number, z: number): boolean {
    // A monster about that the army has not engaged yet: the bombs are aimed at it all the same.
    if (!this.mon) { const sx = this.g.threats.strider(); const inc = sx?.active ? this.g.response.incidents.find((i) => i.ev === sx) : undefined; if (sx && inc) this.attach(inc, sx); }
    // Its own squad (not the army's jets): one run per call, never on the battle's timer.
    let q = this.squads.find((s) => s.key === 'air-strike');
    if (!q) { q = makeSquad('air-strike', 'jet', 4, [makeUnit('jet', 'air-strike', x, z, 1, 0)]); this.squads.push(q); }
    const u = q.units[0];
    u.cool = 1e9;
    this.idle = false;
    if (!this.mon) {
      this.air.jetRun(x, z, this.rng.range(0, Math.PI * 2), (bx, by, bz) => {
        for (let k = 0; k < 4; k++) this.fx.projectile('bomb', bx, by, bz, x + (k - 1.5) * 14, this.g.world.groundHeight(x, z) + 0.3, z, 1.9 + k * 0.12, () => this.groundHit(x + (k - 1.5) * 14, this.g.world.groundHeight(x, z) + 0.3, z, 2.8, 0, -1, 0), 12);
      });
      return true;
    }
    return this.jetRun(u, q);
  }

  /**
   * A blow of the player's at a point (Game.strike: a punch, a thrown car): an army helicopter in
   * reach is knocked out of the sky — only while the army is after the player.
   */
  struck(x: number, y: number, z: number, r: number, jx: number, jy: number, jz: number): number {
    if (!this.hostilePlayer || !(this.mon instanceof PlayerRampage)) return 0;
    const hit = this.air.airTargets(x, y, z, Math.max(r, this.g.player.height * 0.15));
    for (const h of hit) h.swat(jx, jy, jz);
    return hit.length;
  }

  /** Dev / admin: a unit of a kind `dist` m ahead of the player (it joins the fight when there is one). */
  spawn(kind: 'tank' | 'heli' | 'rifles' | 'apc' | 'truck', dist = 40): string {
    const g = this.g, fy = g.camRig.forwardYaw;
    const p = this.street(g.player.pos.x - Math.sin(fy) * dist, g.player.pos.z - Math.cos(fy) * dist, 80);
    const key = `dev-${kind}-${this.squads.length + 1}`;
    const u = makeUnit(kind, key, p.x, p.z, 1, 0);
    u.mounted = false;
    u.task = this.mon ? 'inbound' : 'hold';
    u.tx = p.x; u.tz = p.z;
    if (kind === 'heli') { u.y = ARMY.heliAlt; u.task = this.mon ? 'inbound' : 'orbit'; u.cool = 1e9; }
    const q = makeSquad(key, kind, 4, [u]);
    this.squads.push(q);
    this.idle = false;
    this.stats.sent++;
    if (!this.mon) {
      // No battle: let it stand there (bodies only).
      const sx = this.g.threats.strider();
      if (sx && sx.active) { const inc = g.response.incidents.find((i) => i.ev === sx); if (inc) this.attach(inc, sx); }
    }
    return `${key} at ${Math.round(p.x)},${Math.round(p.z)}`;
  }

  private installDev(): void {
    const dev = (window as unknown as { dev?: Record<string, unknown> }).dev;
    if (!dev) return;
    this.devDone = true;
    const g = this.g;
    dev.army = {
      forces: this,
      /** The battle at a glance: level, monster, squads (units: kind:task, * = materialised), losses, log. */
      status: () => this.status(),
      /** Spawn a unit near the player: 'tank' | 'heli' | 'rifles' | 'apc' | 'truck'. */
      spawn: (kind: 'tank' | 'heli' | 'rifles' | 'apc' | 'truck' = 'tank', dist = 40) => this.spawn(kind, dist),
      /** A jet run over a point (default: the monster, else the map marker, else ahead of the player). */
      airstrike: (x?: number, z?: number) => {
        const S = this.mon, w = g.map.waypoint, fy = g.camRig.forwardYaw;
        const px = x ?? S?.x ?? w?.x ?? g.player.pos.x - Math.sin(fy) * 120, pz = z ?? S?.z ?? w?.z ?? g.player.pos.z - Math.cos(fy) * 120;
        return this.airstrike(px, pz);
      },
      /** The headless "no player" battle on this city's Strider route: dev.army.sim(seed). */
      sim: (seed = 1) => {
        const R = this.mon?.route ?? g.threats.striderStart();
        if (!R) return 'no route';
        const spec = { ...STRIDER, zones: STRIDER_ZONES } as unknown as MonsterSpec;
        return simulateBattle(spec, R, seed);
      },
      level: (n = 3) => g.response.setLevel(n),
      /** Switch the army off / on (the ladder then stops at level 2). */
      enabled: (on?: boolean) => { if (on !== undefined) this.enabled = on; return this.enabled; },
      tuning: { ARMY, FORCE },
      log: () => this.log,
    };
  }
}

/** Where a slot round a giant player is looked for: shares of the ring's radius, angles off the unit's side (rad). */
const SLOT_R = [1, 0.8, 0.62, 0.48, 0.36];
/** Points tried on a zone of a giant player (side, up — in zone radii): the middle, its edges, its top. */
const SEE: [number, number][] = [[0, 0], [0, 0.8], [-0.8, 0], [0.8, 0], [0, -0.6]];
const SLOT_A = [0, 0.18, -0.18, 0.4, -0.4];
/** Rings (m) searched round a spot in the water for a dry street point. */
const DRY_R = [15, 30, 50, 80, 120, 170];
/** Seconds a helicopter is away rearming. */
const HELI_REARM = 90;
const VEHICLE_KIND_SET = new Set<string>(['army_truck', 'apc', 'tank']);
const NO_KINDS = {};
const DUST = new THREE.Color(0.55, 0.52, 0.47);

function angle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function clampA(d: number, max: number): number {
  d = angle(d);
  return Math.max(-max, Math.min(max, d));
}

/** The National Guard / army uniform: olive combat shirt and trousers, a darker jacket, boots, a helmet. */
export function soldierOutfit(seed: number): EquipmentVisuals {
  const olive: [number, number, number] = [0.26, 0.29, 0.19], dark: [number, number, number] = [0.17, 0.19, 0.13], tan: [number, number, number] = [0.36, 0.33, 0.24];
  const v = (primary: [number, number, number], secondary: [number, number, number], k: number, material = 'plain') => ({ shape: 'cloth', seed: seed + k, primary, secondary, accent: tan, material, glow: 0 });
  return {
    chest: { defId: 'shirt', visual: v(olive, dark, 1) },
    back: { defId: 'jacket', visual: v(dark, olive, 2, 'checks') },
    legs: { defId: 'trousers', visual: v(olive, dark, 3) },
    feet: { defId: 'boots', visual: v([0.08, 0.07, 0.06], [0, 0, 0], 4) },
    head: { defId: 'helmet', visual: v(dark, dark, 5) },
  } as unknown as EquipmentVisuals;
}
