/**
 * The giant mech (THREATS_PLAN §1 #12, Phase E): a rogue walking-weapons prototype, 30 m tall.
 *
 * It strides in along the arterials from the hero's side of town towards downtown (its feet crash
 * down in turn: cars under them crushed, people near them thrown down, the street shaking), and
 * fights on the way:
 *
 *   salvo    it stops, turns its hull on a target — whoever hurt it most within reach, else a
 *            building ahead — raises its shoulder pods and ripple-fires twelve missiles on smoke
 *            trails: blasts on facades, in the street, round the army's vehicles.
 *   cannon   bursts from the rotary cannon on its right arm at helicopters and drones, and at the
 *            hero when they fly.
 *   smash    whoever is close in front of it on the ground gets the hammer fist.
 *
 * Every salvo heats it up; hot, it stands and vents: two vents slide out of its back glowing white,
 * steam pouring off — its weak spot while open (×3.5). Frost on the open vents shuts it down for a
 * few seconds (it sags, the visor dark); frost on the closed ones only cools it. Enough damage to a
 * knee buckles it to its knees, the cockpit low. The cockpit is always a weak spot (×2), heavily
 * armoured. Downtown it patrols the last stretch of its way. Hurt to 25 % it turns and walks back
 * out of town; destroyed it sparks, staggers and topples forward, and the wreck lies there for hours.
 *
 * A ThreatActor (2600 points; zones cockpit, vents, knees, hull, arms, legs, pods) and an ArmyFoe
 * on a route (the army meets it ahead along its way).
 */
import * as THREE from 'three';
import type { Game } from '../../Game';
import { Rng } from '../../../core/rng';
import { clamp, angleDiff } from '../../../core/math';
import { closestOnPoly } from '../../../core/geom2';
import { PState, type PedAgent } from '../../../sim/Pedestrians';
import { VState } from '../../../sim/Traffic';
import { DKind } from '../../../future/Drones';
import { dealtBy } from '../../../shared/status';
import { BeamStyle, DecalKind } from '../../powers/ElementFx';
import { rayCapsule } from '../rig/CreatureRig';
import type { ThreatActor, ThreatEvent, ThreatOutcome, ThreatTarget, ThreatZone, DamageSource, DamageResult } from '../ThreatEvent';
import { DAMAGE_PER_IMPULSE } from '../ThreatEvent';
import type { Cause } from '../../Stimuli';
import { angriestInReach } from '../../response/forces/BattleModel';
import type { AirProvider, AirTarget, StriderBlow } from '../Strider';
import { routeAt, nearestS } from '../StriderRoute';
import { bookAggro, decayAggro, heroEarned, topAggro, zoneDealt } from '../aggro';
import { bodyMass, stepEnergy } from '../../GiantBody';
import { planBurrowerRoute, type BurrowRoute } from '../burrower/burrowerRoute';
import { MechRig, MECH, MECH_BONES } from './mechRig';
import type { MechMesh } from './MechMesh';

export const MECH_T = {
  hp: 2600,
  /** Height (m) for the con, stomps and the shake; size × the full-size frame; the incident radius (m). */
  height: 30, scale: 1.35, radius: 180,
  /** Walking speed (m/s), turn rate (rad/s), stride (m, full size), a step's swing (s). */
  speed: 3.6, turn: 0.45, stride: 8, swingT: 1.0,
  /** Missile salvos: reach (m), between salvos (s), missiles a salvo, their speed (m/s), a blast's reach (m). */
  salvoR: 280, salvoGap: [12, 18] as [number, number], missiles: 12, missileV: 85, blastR: 7,
  /** The cannon: reach (m), between bursts (s), a burst (s). */
  cannonR: 220, cannonGap: [5, 8] as [number, number], burstT: 1.4,
  /** The hammer: reach in front (m), between blows (s). */
  smashR: 15, smashGap: 4,
  /** Heat a salvo adds; at 1 it vents (s), frost on open vents shuts it down (s). */
  salvoHeat: 0.5, ventT: 7, shutT: 6,
  /** Recent damage on a knee that buckles it (points), kneeling (s). */
  kneeDown: 320, kneelT: 5,
  weakMul: 2, ventMul: 3.5, retreatAt: 0.25,
  /** Downtown it patrols the last this-many metres of its way. */
  patrol: 160,
  /** The visit ends after (s); walking off ends when out of sight or after (s). */
  visitMax: 720, leaveT: 120,
  /** The wreck lies this many game hours. */
  wreckHours: 8,
  karma: { weak: 2, retreat: 70, defeated: 140 },
};

export const MECH_ZONES: { id: string; name: string; armour: number; weak: boolean }[] = [
  { id: 'cockpit', name: 'Cockpit', armour: 0.55, weak: true },
  { id: 'vents', name: 'Heat vents', armour: 0.3, weak: true },
  { id: 'joint', name: 'Knees', armour: 0.5, weak: false },
  { id: 'body', name: 'Hull', armour: 0.85, weak: false },
  { id: 'arm', name: 'Arms', armour: 0.75, weak: false },
  { id: 'leg', name: 'Legs', armour: 0.8, weak: false },
  { id: 'pod', name: 'Missile pods', armour: 0.6, weak: false },
];

type Mode = 'advance' | 'rampage' | 'retreat' | 'dying' | 'dead' | 'gone';
export type MechAct = 'walk' | 'salvo' | 'cannon' | 'smash' | 'vent' | 'shutdown' | 'kneel' | 'topple';

interface Missile { ax: number; ay: number; az: number; bx: number; by: number; bz: number; t: number; T: number; arc: number; trail: number }
interface Foot { from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number }; u: number; swinging: boolean }

let EVENT_ID = 7000;
const FIRE_HOT = new THREE.Color(3.2, 1.6, 0.45), FIRE_END = new THREE.Color(0.6, 0.12, 0.02);
const SMOKE = new THREE.Color(0.16, 0.15, 0.14), SMOKE_L = new THREE.Color(0.42, 0.41, 0.4);
const FLASH = new THREE.Color(4, 2.6, 1.1), FLASH_END = new THREE.Color(1.2, 0.4, 0.05);
const STEAM = new THREE.Color(0.85, 0.88, 0.9), STEAM_END = new THREE.Color(0.6, 0.62, 0.65);
const SPARK = new THREE.Color(4, 2.6, 1), DUST = new THREE.Color(0.55, 0.52, 0.47);
const _v = { x: 0, y: 0, z: 0 };
const _w = { x: 0, y: 0, z: 0 };
const _r = { x: 0, z: 0, dx: 0, dz: 0 };

export class Mech implements ThreatEvent, ThreatActor {
  readonly id = EVENT_ID++;
  readonly archetype = 'mech';
  readonly tier = 'major';
  readonly engageOnFoot = false;
  readonly name = 'Giant mech';
  readonly radius = MECH_T.radius;
  readonly height = MECH_T.height;
  readonly maxHp = MECH_T.hp;
  hp = MECH_T.hp;
  t = 0;
  active = true;
  outcome: ThreatOutcome | null = null;
  hurt = 0;
  readonly rig: MechRig;
  readonly zones: ThreatZone[];
  readonly aggro = new Map<string, number>();
  mode: Mode = 'advance';
  act: MechAct = 'walk';
  readonly route: BurrowRoute;
  /** Progress along the route (m). */
  s = 0;
  airTargets: AirProvider[] = [];
  unitAt: ((key: string) => { x: number; y: number; z: number } | null) | null = null;
  onBlow: ((kind: StriderBlow, x: number, y: number, z: number, r: number) => void) | null = null;
  /** Game hours when it came down (the wreck lies a while). */
  downAt = 0;
  readonly stats = {
    steps: 0, salvos: 0, missiles: 0, blasts: 0, bursts: 0, smashes: 0, vents: 0, shutdowns: 0, kneels: 0,
    crushed: 0, broken: 0, damage: 0, weakHits: 0, wrecked: 0, knocked: 0, playerHits: 0, airHits: 0,
  };
  private rng: Rng;
  private actT = 0;
  private sub = 0;
  private speed = 0;
  /** Which way along the route it walks (1 in, −1 back out), and the patrol's turning points. */
  private dir = 1;
  private feet: Foot[];
  private heat = 0;
  private vent = 0;
  private crouch = 0;
  private sag = 0;
  private cool = { salvo: 6, cannon: 3, smash: 2 };
  private shots: Missile[] = [];
  private fired = 0;
  private target: { x: number; y: number; z: number } | null = null;
  private air: AirTarget | null = null;
  private tokens = 4;
  private newsT = 10;
  private stimT = 0;
  private sparkT = 0;
  private alarmT = 0;

  constructor(private g: Game, seed: number, route?: BurrowRoute | null) {
    this.rng = new Rng(seed);
    this.zones = MECH_ZONES.map((z) => ({ ...z, exposed: z.id !== 'vents', x: 0, y: 0, z: 0, r: 3, recent: 0 }));
    const p = g.player.pos;
    const R = route ?? planBurrowerRoute(g.macro, seed, { x: p.x, z: p.z });
    if (!R) throw new Error('mech: no way into town');
    this.route = R;
    const rig = new MechRig(MECH_T.scale);
    this.rig = rig;
    this.feet = [0, 1].map(() => ({ from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 0 }, u: 0, swinging: false }));
    this.placeAt(0);
    this.updateZones();
  }

  /** Stand at arc length s on the route, facing along it, the feet planted under the hips. */
  private placeAt(s: number): void {
    const R = this.rig, sc = MECH_T.scale;
    this.s = s;
    routeAt(this.route, s, _r);
    R.x = _r.x; R.z = _r.z; R.yaw = Math.atan2(_r.dx * this.dir, _r.dz * this.dir);
    const rx = Math.cos(R.yaw), rz = -Math.sin(R.yaw);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1, x = R.x + rx * side * MECH.hip[0] * sc, z = R.z + rz * side * MECH.hip[0] * sc;
      const F = R.feet[i], y = this.g.world.groundHeight(x, z);
      F.x = x; F.y = y; F.z = z; F.yaw = R.yaw; F.lift = 0;
      this.feet[i].swinging = false;
    }
    R.y = this.groundUnder() + MECH.stand * sc;
    R.place();
  }

  // ================================================================== ThreatActor / ArmyFoe

  get x(): number { return this.rig.x; }
  get y(): number { return this.rig.y; }
  get z(): number { return this.rig.z; }
  get defeated(): boolean { return this.mode === 'dying' || this.mode === 'dead'; }
  get targetable(): boolean { return this.mode === 'advance' || this.mode === 'rampage' || this.mode === 'retreat'; }
  get actors(): ThreatActor[] { return this.targetable ? [this] : []; }
  get headPos(): { x: number; y: number; z: number } { return this.rig.point(MECH_BONES.cockpit, 0, MECH.hullAt[1] + MECH.cockpitAt[1] + 1, MECH.cockpitAt[2] + 1.5, _v); }
  get title(): string {
    if (this.defeated) return 'Giant mech — destroyed';
    if (this.act === 'shutdown') return 'Giant mech — shut down (frozen vents)';
    if (this.act === 'vent') return 'Giant mech — venting heat (weak spot open)';
    return this.mode === 'retreat' ? 'Giant mech — walking out of town' : 'Giant mech — a rogue war machine on the march';
  }

  zone(id: string): ThreatZone { return this.zones.find((z) => z.id === id) ?? this.zones[3]; }

  private zoneOfCap(i: number): ThreatZone {
    const z = this.rig.caps[i].zone;
    // (Closed vents are armour like the rest of the back.)
    if (z === 'vents' && !this.zone('vents').exposed) return this.zone('body');
    return this.zone(z);
  }

  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): { t: number; zone: ThreatZone } | null {
    if (this.mode === 'gone') return null;
    let best = maxT, bi = -1;
    this.rig.caps.forEach((c, i) => { const t = rayCapsule(ox, oy, oz, dx, dy, dz, c, best); if (t < best) { best = t; bi = i; } });
    return bi < 0 ? null : { t: best, zone: this.zoneOfCap(bi) };
  }

  zoneAt(x: number, y: number, z: number): { zone: ThreatZone; d: number } | null {
    if (this.mode === 'gone') return null;
    const n = this.rig.nearest(x, y, z);
    return n ? { zone: this.zoneOfCap(n.i), d: n.d } : null;
  }

  damage(zone: ThreatZone | string | null, amount: number, src: DamageSource): DamageResult {
    if (!this.targetable || amount <= 0) return { dealt: 0, zone: null, weak: false };
    let Z: ThreatZone;
    if (typeof zone === 'string') Z = this.zone(zone);
    else if (zone) Z = zone;
    else Z = (src.x !== undefined ? this.zoneAt(src.x, src.y ?? this.y, src.z ?? this.z)?.zone : null) ?? this.zone('body');
    if (Z.id === 'vents' && !Z.exposed) Z = this.zone('body');
    const weak = Z.weak && Z.exposed;
    const dealt = zoneDealt(amount, Z.armour, weak, Z.id === 'vents' ? MECH_T.ventMul : MECH_T.weakMul);
    this.hp = Math.max(0, this.hp - dealt);
    Z.recent += dealt;
    this.stats.damage += dealt;
    if (weak) this.stats.weakHits++;
    bookAggro(this.aggro, src.key ?? src.cause, dealt + amount * 0.02 + (src.aggro ?? 0));
    if (src.cause === 'player' && weak && dealt > 20) this.g.progress.addKarma(MECH_T.karma.weak, 'hit the mech where it hurts');
    if (dealt > 30) this.sparks(Z.x, Z.y, Z.z, Math.min(12, 3 + dealt / 40));
    // A knee shot through: it buckles.
    if (Z.id === 'joint' && Z.recent > MECH_T.kneeDown && this.act !== 'kneel' && this.act !== 'shutdown' && this.act !== 'topple' && this.hp > 0) this.startKneel();
    return { dealt, zone: Z, weak };
  }

  blow(x: number, y: number, z: number, r: number, jx: number, jy: number, jz: number, src: DamageSource): DamageResult | null {
    if (!this.targetable) return null;
    const n = this.rig.nearest(x, y, z);
    if (!n || n.d > r + 0.5) return null;
    return this.damage(this.zoneOfCap(n.i), Math.hypot(jx, jy, jz) * DAMAGE_PER_IMPULSE, { ...src, x: src.x ?? x, y: src.y ?? y, z: src.z ?? z });
  }

  /** Elements: frost on the open vents shuts it down (on closed ones it only cools it); fire hardly bites, lightning does. */
  onElement(el: 'fire' | 'frost' | 'shock' | 'wind', dur: number): number {
    if (el === 'frost') {
      if (this.act === 'vent' && this.vent > 0.4 && this.targetable) this.startShutdown();
      else this.heat = Math.max(0, this.heat - dur * 0.15);
      return 0.8;
    }
    if (el === 'fire') return 0.6;
    if (el === 'shock') return 1.6;
    return 0.3;
  }

  conStrength(): number { return 190 * Math.sqrt(Math.max(0.05, this.hp / this.maxHp)); }
  topAggro(): { key: string; v: number } | null { return topAggro(this.aggro); }

  // ================================================================== ThreatEvent

  strength(): number { return this.active ? this.hp / this.maxHp : 0; }
  targetsNear(_x: number, _z: number, _r: number): ThreatTarget[] { return []; }
  strike(_t: ThreatTarget, _jx: number, _jy: number, _jz: number, _cause: Cause): void { /* nothing on foot dents it */ }
  shutdown(): void { if (this.mode === 'advance' || this.mode === 'rampage') this.startLeaving(false); }
  dispose(): void { this.shots.length = 0; }
  obliterate(): void { this.finish('destroyed'); }

  snapshot(): Record<string, unknown> {
    return {
      id: this.id, archetype: this.archetype, t: +this.t.toFixed(1), active: this.active, outcome: this.outcome, mode: this.mode, act: this.act, sub: this.sub,
      x: Math.round(this.x), y: Math.round(this.y), z: Math.round(this.z), s: Math.round(this.s), length: Math.round(this.route.length),
      speed: +this.speed.toFixed(1), hp: Math.round(this.hp), heat: +this.heat.toFixed(2), vent: +this.vent.toFixed(2),
      overGround: +(this.y - this.groundUnder()).toFixed(1), inFlight: this.shots.length,
      aggro: Object.fromEntries([...this.aggro].map(([k, v]) => [k, Math.round(v)])), hurt: this.hurt, ...this.stats,
    };
  }

  // ================================================================== frame

  update(dt: number): void {
    this.t += dt;
    this.missiles(dt);
    if (this.mode === 'gone') return;
    decayAggro(this.aggro, dt, 90);
    for (const Z of this.zones) Z.recent *= Math.exp(-dt / 5);
    this.cool.salvo -= dt; this.cool.cannon -= dt; this.cool.smash -= dt;
    this.tokens = Math.min(4, this.tokens + dt * 1.5);
    this.actT += dt;
    const R = this.rig;
    R.t += dt;
    if (this.mode === 'dead') { this.lie(dt); this.updateZones(); this.smoulder(dt); return; }
    if (this.mode !== 'dying') {
      if (this.hp <= 0) this.startDying();
      else this.watch();
    }
    // (Pose defaults each frame; the act sets what it needs.)
    R.aim = null; R.smash = 0;
    let move = 0;
    switch (this.act) {
      case 'walk': move = this.walk(dt); break;
      case 'salvo': this.salvo(dt); break;
      case 'cannon': move = this.cannon(dt); break;
      case 'smash': this.smash(dt); break;
      case 'vent': this.venting(dt); break;
      case 'shutdown': this.shut(dt); break;
      case 'kneel': this.kneel(dt); break;
      case 'topple': this.topple(dt); break;
    }
    if (this.act !== 'topple') this.gait(dt, move);
    // Heat, the vents, the visor.
    const ventWant = this.act === 'vent' || this.act === 'shutdown' ? 1 : 0;
    this.vent += (ventWant - this.vent) * Math.min(1, dt * 2.5);
    R.vent = this.vent;
    R.heat = Math.max(this.vent * (this.act === 'shutdown' ? 0.35 : 1), this.heat * 0.25);
    const visor = this.act === 'shutdown' || this.defeated ? 0 : this.act === 'salvo' || this.act === 'cannon' ? 1 : 0.7;
    R.visor += (visor - R.visor) * Math.min(1, dt * 3);
    R.place();
    this.updateZones();
    this.surroundings(dt);
  }

  // ---------------------------------------------------------------- walking

  /** Ground height under the body (the feet's average while planted). */
  private groundUnder(): number {
    const F = this.rig.feet;
    return (F[0].y + F[1].y) / 2;
  }

  /** Along the route (or back out, or to and fro downtown): returns the speed it moves at. */
  private walk(dt: number): number {
    const L = this.route.length;
    this.speed += (MECH_T.speed * dealtBy(this) - this.speed) * Math.min(1, dt * 0.8);
    this.s = clamp(this.s + this.speed * dt * this.dir, 0, L);
    if (this.mode === 'advance' && this.s >= L - 1) { this.mode = 'rampage'; this.dir = -1; this.note('downtown'); }
    if (this.mode === 'rampage') {
      if (this.dir < 0 && this.s <= Math.max(0, L - MECH_T.patrol)) this.dir = 1;
      else if (this.dir > 0 && this.s >= L - 1) this.dir = -1;
    }
    if (this.mode === 'retreat' && this.s <= 1) { this.finish('retreated'); return 0; }
    this.follow(dt);
    this.choose();
    return this.speed;
  }

  /** The body to its place on the route, turning towards the way ahead. */
  private follow(dt: number): void {
    const R = this.rig;
    routeAt(this.route, this.s, _r);
    R.x += (_r.x - R.x) * Math.min(1, dt * 2);
    R.z += (_r.z - R.z) * Math.min(1, dt * 2);
    const want = Math.atan2(_r.dx * this.dir, _r.dz * this.dir);
    R.yaw += clamp(angleDiff(R.yaw, want), -MECH_T.turn * dt, MECH_T.turn * dt);
  }

  /** Feet: a foot steps when it lags behind its spot under the hip; one at a time. Body height and sway follow. */
  private gait(dt: number, move: number): void {
    const R = this.rig, sc = MECH_T.scale, g = this.g;
    const f = R.fwd, rx = Math.cos(R.yaw), rz = -Math.sin(R.yaw);
    const stride = MECH_T.stride * sc, T = MECH_T.swingT * Math.sqrt(sc);
    const lead = move > 0.3 ? stride * 0.45 : 0;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1, S = this.feet[i], F = R.feet[i];
      const hx = R.x + rx * side * MECH.hip[0] * sc, hz = R.z + rz * side * MECH.hip[0] * sc;
      if (S.swinging) {
        S.u += dt / T;
        const u = Math.min(1, S.u), e = u * u * (3 - 2 * u);
        F.x = S.from.x + (S.to.x - S.from.x) * e; F.z = S.from.z + (S.to.z - S.from.z) * e;
        F.y = S.from.y + (S.to.y - S.from.y) * e;
        F.lift = Math.sin(Math.PI * u) * 2.6 * sc;
        F.yaw += angleDiff(F.yaw, R.yaw) * Math.min(1, dt * 4);
        if (u >= 1) { S.swinging = false; F.lift = 0; this.footfall(i, F.x, F.y, F.z); }
        continue;
      }
      const other = this.feet[1 - i];
      if (other.swinging || this.act === 'shutdown' || this.act === 'kneel') continue;
      const tx = hx + f.x * lead, tz = hz + f.z * lead;
      const off = Math.hypot(F.x - tx, F.z - tz);
      // (Moving: a stride's worth behind; standing: settle any foot that is out of place.)
      if (off > (move > 0.3 ? stride * 0.55 : 1.5 * sc) || Math.abs(angleDiff(F.yaw, R.yaw)) > 0.6) {
        // The foot that lags most goes first.
        const o = R.feet[1 - i], oOff = Math.hypot(o.x - (R.x - rx * side * MECH.hip[0] * sc + f.x * lead), o.z - (R.z - rz * side * MECH.hip[0] * sc + f.z * lead));
        if (oOff > off + 2 && !other.swinging) continue;
        S.swinging = true; S.u = 0;
        S.from.x = F.x; S.from.y = F.y; S.from.z = F.z;
        const ax = tx + f.x * move * T * 0.5, az = tz + f.z * move * T * 0.5;
        S.to.x = ax; S.to.z = az; S.to.y = g.world.groundHeight(ax, az);
      }
    }
    // Body: over the feet, dipping as weight lands, lowered when kneeling or shut down.
    const swing = Math.max(this.feet[0].swinging ? Math.sin(Math.PI * Math.min(1, this.feet[0].u)) : 0, this.feet[1].swinging ? Math.sin(Math.PI * Math.min(1, this.feet[1].u)) : 0);
    const kneel = this.act === 'kneel' ? 1 : 0, sag = this.act === 'shutdown' ? 1 : 0;
    this.crouch += (kneel - this.crouch) * Math.min(1, dt * (kneel ? 3 : 1.2));
    this.sag += (sag - this.sag) * Math.min(1, dt * (sag ? 2 : 1));
    const want = this.groundUnder() + (MECH.stand - 0.5 * swing - 4.2 * this.crouch - 2.2 * this.sag) * sc;
    R.y += (want - R.y) * Math.min(1, dt * 6);
    R.pitch = 0.18 * this.crouch + 0.12 * this.sag + (this.act === 'smash' ? 0.06 : 0);
    // Side sway towards the planted foot.
    const lean = this.feet[0].swinging ? -1 : this.feet[1].swinging ? 1 : 0;
    R.roll += (lean * 0.035 - R.roll) * Math.min(1, dt * 3);
  }

  /** A foot comes down: the street shakes, cars under it are crushed, people near it thrown down. */
  private footfall(i: number, x: number, y: number, z: number): void {
    const g = this.g, sc = MECH_T.scale;
    this.stats.steps++;
    const E = stepEnergy(bodyMass(MECH_T.height, 1.4), MECH_T.height) * dealtBy(this);
    this.stats.broken += g.interactions.steps.land(x, y, z, E, MECH_T.height, { cause: 'threat', own: false, sound: 'mech_step', ref: 100, maxR: 450, foot: 2.4 * sc, impact: false });
    for (const v of g.traffic.vehicles) {
      if (v.state === VState.Wreck || Math.abs(v.x - x) > 4.5 * sc || Math.abs(v.z - z) > 4.5 * sc) continue;
      if (Math.hypot(v.x - x, v.z - z) > 3.6 * sc) continue;
      g.traffic.wreckIt(v);
      g.vehicles.makeWreck(v, v.x, v.y + 0.3, v.z, 0, -6000 * dealtBy(this), 0);
      g.consequences.record('mech', 'car', 'wreck', v.x, v.z, v, 'threat');
      this.stats.wrecked++; this.stats.crushed++;
    }
    this.knockAround(x, y, z, 5 * sc, 5);
    this.hurtPlayerNear(x, y + 1, z, 3 * sc, 30, 10);
    this.onBlow?.('step', x, y, z, 4 * sc);
    void i;
  }

  // ---------------------------------------------------------------- choosing what to do

  /** While walking: a salvo, the cannon, the hammer, or vent when hot. */
  private choose(): void {
    if (this.mode === 'retreat' && this.heat < 1) return;
    if (this.heat >= 1) { this.setAct('vent'); return; }
    const foe = this.hostileTarget(MECH_T.salvoR);
    // The hammer: someone right in front of it on the ground.
    if (foe && this.cool.smash <= 0 && this.inFront(foe, MECH_T.smashR * MECH_T.scale / 1.35) && foe.y - this.groundUnder() < 8) { this.target = foe; this.setAct('smash'); return; }
    // The cannon: fliers within reach (a helicopter, a drone, the hero in the air).
    if (this.cool.cannon <= 0) {
      const a = this.airNear(this.x, this.y, this.z, MECH_T.cannonR);
      if (a) { this.air = a; this.target = { x: a.x, y: a.y, z: a.z }; this.setAct('cannon'); return; }
      const p = this.g.player;
      if (foe && this.topAggro()?.key === 'player' && (p.flying || p.pos.y - this.g.world.groundHeight(p.pos.x, p.pos.z) > 8) && Math.hypot(p.pos.x - this.x, p.pos.z - this.z) < MECH_T.cannonR) {
        this.air = null; this.target = foe; this.setAct('cannon'); return;
      }
    }
    if (this.cool.salvo <= 0) {
      const t = foe ?? this.buildingTarget();
      if (t) { this.target = t; this.setAct('salvo'); }
      else this.cool.salvo = 3;
    }
  }

  private inFront(p: { x: number; z: number }, r: number): boolean {
    const dx = p.x - this.x, dz = p.z - this.z, f = this.rig.fwd;
    const d = Math.hypot(dx, dz);
    return d < r && (dx * f.x + dz * f.z) / (d || 1) > 0.3;
  }

  /** A facade ahead to blast when nobody fights it: a tall building within reach, a point up its face. */
  private buildingTarget(): { x: number; y: number; z: number } | null {
    const g = this.g, f = this.rig.fwd;
    const cx = this.x + f.x * 110, cz = this.z + f.z * 110;
    const list = g.world.buildingsIn(cx - 120, cz - 120, cx + 120, cz + 120).filter((b) => b.alive && b.top - b.base > 14);
    if (!list.length) return null;
    const b = list[this.rng.int(0, list.length - 1)];
    const e = closestOnPoly(b.poly, this.x, this.z);
    const d = Math.hypot(e.x - this.x, e.z - this.z);
    if (d < 40 || d > MECH_T.salvoR) return null;
    return { x: e.x, y: b.base + (b.top - b.base) * this.rng.range(0.35, 0.8), z: e.z };
  }

  private setAct(a: MechAct): void {
    this.act = a;
    this.actT = 0;
    this.sub = 0;
  }

  // ---------------------------------------------------------------- weapons

  /** Stops, turns the hull on its target, raises the pods, ripple-fires; then walks on. */
  private salvo(dt: number): void {
    const R = this.rig, T = this.target;
    this.speed *= Math.exp(-dt * 3);
    if (!T || !this.targetable) { this.endAttack(); return; }
    R.aim = T;
    R.pods += (1 - R.pods) * Math.min(1, dt * 2);
    // Turn the whole body when the hull cannot twist far enough.
    if (Math.abs(R.twist) > 1.2) R.yaw += clamp(R.twist, -1, 1) * MECH_T.turn * dt;
    if (this.sub === 0 && this.actT > 1.3) {
      this.sub = 1; this.fired = 0; this.actT = 0;
      this.stats.salvos++;
      this.alarm();
    }
    if (this.sub === 1) {
      const n = MECH_T.missiles;
      while (this.fired < n && this.actT > this.fired * 0.14) this.launch(this.fired++ % 2 === 0 ? 1 : -1, T);
      if (this.fired >= n && this.actT > n * 0.14 + 0.8) {
        this.heat += MECH_T.salvoHeat;
        this.cool.salvo = this.rng.range(MECH_T.salvoGap[0], MECH_T.salvoGap[1]);
        this.endAttack();
      }
    }
  }

  private endAttack(): void {
    this.target = null; this.air = null;
    this.setAct('walk');
  }

  /** One missile out of a pod at (near) the target, on an arc. */
  private launch(side: number, T: { x: number; y: number; z: number }): void {
    const g = this.g, R = this.rig, a = R.tubes(side, _w);
    const spread = 4 + Math.hypot(T.x - a.x, T.z - a.z) * 0.035;
    const bx = T.x + this.rng.range(-spread, spread), bz = T.z + this.rng.range(-spread, spread);
    const by = Math.max(g.world.groundHeight(bx, bz) + 0.5, T.y + this.rng.range(-3, 3));
    const d = Math.hypot(bx - a.x, by - a.y, bz - a.z);
    this.shots.push({ ax: a.x, ay: a.y, az: a.z, bx, by, bz, t: 0, T: d / MECH_T.missileV, arc: Math.min(40, d * 0.18), trail: 0 });
    this.stats.missiles++;
    const fx = g.elements.fx;
    fx.glow(a.x, a.y, a.z, 0, 0, 0, 0.12, 1.2, 2.4, FLASH, FLASH_END, 1, 1, 0);
    fx.soft(a.x, a.y, a.z, this.rng.range(-1, 1), 1, this.rng.range(-1, 1), 1.5, 1.2, 3.5, SMOKE_L, SMOKE, 0.5, 1, -0.2);
    g.audio.play('mech_launch', a.x, a.y, a.z, 0.8, 0.9 + this.rng.range(0, 0.2), 120, g.renderer.camera.position);
  }

  /** Missiles in flight: a bright motor, a smoke trail; a blast where they come down. */
  private missiles(dt: number): void {
    const fx = this.g.elements.fx;
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const p = this.shots[i];
      p.t += dt;
      const k = Math.min(1, p.t / p.T);
      const x = p.ax + (p.bx - p.ax) * k, z = p.az + (p.bz - p.az) * k, y = p.ay + (p.by - p.ay) * k + p.arc * 4 * k * (1 - k);
      fx.glow(x, y, z, 0, 0, 0, 0.05, 0.7, 1, FLASH, FLASH_END, 1, 1, 0);
      p.trail -= dt;
      if (p.trail <= 0) { p.trail = 0.035; fx.soft(x, y, z, Math.random() - 0.5, 0.4, Math.random() - 0.5, 1.8, 0.6, 2.6, SMOKE_L, SMOKE, 0.5, 1.2, -0.2); }
      if (k >= 1) { this.shots[i] = this.shots[this.shots.length - 1]; this.shots.pop(); this.blast(p.bx, p.by, p.bz); }
    }
  }

  /** A missile's blast: fire, smoke, chips; the facade or street there breaks; people thrown down; the army's units hit. */
  private blast(x: number, y: number, z: number): void {
    const g = this.g, fx = g.elements.fx, cam = g.renderer.camera.position, r = MECH_T.blastR;
    this.stats.blasts++;
    if (Math.hypot(cam.x - x, cam.z - z) < 900) {
      for (let i = 0; i < 9; i++) fx.glow(x, y, z, (Math.random() - 0.5) * 16, Math.random() * 11, (Math.random() - 0.5) * 16, 0.35 + Math.random() * 0.3, 1.4, 3.8, FIRE_HOT, FIRE_END, 0.9, 2.4, -3);
      for (let i = 0; i < 5; i++) fx.soft(x + (Math.random() - 0.5) * 2.4, y + Math.random() * 1.2, z + (Math.random() - 0.5) * 2.4, (Math.random() - 0.5) * 4, 2 + Math.random() * 3.6, (Math.random() - 0.5) * 4, 4.6, 1.8, 6, SMOKE, SMOKE_L, 0.55, 0.6, -0.6);
      g.debris.chipBurst(x, y, z, 12, 9, 0, 1, 0, DUST, 0.05, 1.6);
      g.dust.burst(x, y, z, 8, 3, 3.6, 2.6, 4, DUST, 0.4, 0.5);
    }
    g.audio.play('army_explosion', x, y, z, 0.9, 1.0 + Math.random() * 0.1, 40, cam);
    g.stimuli.emit('gunfire', x, y, z, 6, 220, { cause: 'threat' });
    const ground = g.world.groundHeight(x, z);
    // A facade (above the street) or the street itself.
    if (this.tokens >= 1) {
      this.tokens -= 1;
      // (Outwards from the mech: a unit direction, the destruction scales debris speed by it.)
      const dl = Math.hypot(x - this.x, z - this.z) || 1, ux = (x - this.x) / dl, uz = (z - this.z) / dl;
      const n = g.destruction.as('threat', () => g.destruction.impact(x, y, z, 3.2, 5e5 * dealtBy(this), ux, 0, uz, y - ground > 2 ? 'wall' : 'stomp'));
      this.stats.broken += n;
      if (n) g.consequences.record('mech', 'building', 'facade', x, z, undefined, 'threat');
    }
    if (y - ground < 3) fx.decal(DecalKind.Scorch, x, ground + 0.05, z, 0, 1, 0, 6, 6, Math.random() * 6, 120);
    g.props.hit(x, y, z, r, 0, 1.5e4, 0);
    for (const v of g.traffic.vehicles) {
      if (v.state === VState.Wreck || Math.hypot(v.x - x, v.z - z) > 4.5 || Math.abs(v.y - y) > 4) continue;
      g.traffic.wreckIt(v);
      const dx = v.x - x, dz = v.z - z, l = Math.hypot(dx, dz) || 1;
      g.vehicles.makeWreck(v, v.x, v.y + 0.5, v.z, (dx / l) * 5000, 9000, (dz / l) * 5000);
      g.consequences.record('mech', 'car', 'wreck', v.x, v.z, v, 'threat');
      this.stats.wrecked++;
    }
    this.knockAround(x, y, z, r, 7);
    this.hurtPlayerNear(x, y, z, r, 35, 12);
    this.onBlow?.('slam', x, y, z, r);
    const d = Math.hypot(g.player.pos.x - x, g.player.pos.z - z);
    if (d < 200) g.camRig.addShake(Math.min(0.3, 10 / Math.max(25, d)));
  }

  /** Bursts from the rotary cannon at a flier (or the hero in the air), walking on slowly. */
  private cannon(dt: number): number {
    const R = this.rig, g = this.g;
    const a = this.air;
    if (a) { this.target = { x: a.x, y: a.y, z: a.z }; }
    else if (this.target && this.topAggro()?.key === 'player') { const p = g.player.pos; this.target = { x: p.x, y: p.y + g.player.height * 0.5, z: p.z }; }
    const T = this.target;
    if (!T || !this.targetable) { this.endAttack(); return 0; }
    R.aim = T;
    this.speed *= Math.exp(-dt * 1.5);
    this.s = clamp(this.s + this.speed * dt * this.dir, 0, this.route.length);
    this.follow(dt);
    if (this.actT < 0.6) return this.speed;
    // Firing: tracers every few frames, a hit now and then.
    this.sub += dt;
    if (this.sub > 0.07) {
      this.sub = 0;
      const m = R.muzzle(_w);
      const sx = (Math.random() - 0.5) * 3, sy = (Math.random() - 0.5) * 3, sz = (Math.random() - 0.5) * 3;
      g.elements.fx.seg(m.x, m.y, m.z, T.x + sx, T.y + sy, T.z + sz, 0.14, 3.6, 2.2, 0.9, 1.6, BeamStyle.Laser);
      g.elements.fx.glow(m.x, m.y, m.z, 0, 0, 0, 0.06, 0.8, 1.4, FLASH, FLASH_END, 1, 1, 0);
    }
    if (this.actT > 0.6 && Math.floor((this.actT - dt) / 0.35) !== Math.floor(this.actT / 0.35)) {
      g.audio.play('mech_cannon', this.x, this.y + 10, this.z, 0.9, 1, 140, g.renderer.camera.position);
      if (a) {
        this.stats.airHits++;
        if (this.actT > MECH_T.burstT * 0.8) { const l = Math.hypot(a.x - this.x, a.z - this.z) || 1; a.swat(((a.x - this.x) / l) * 600, -200, ((a.z - this.z) / l) * 600); }
      } else this.hurtPlayerNear(T.x, T.y, T.z, 3, 9, 3);
    }
    if (this.actT > 0.6 + MECH_T.burstT) {
      this.stats.bursts++;
      this.cool.cannon = this.rng.range(MECH_T.cannonGap[0], MECH_T.cannonGap[1]);
      this.endAttack();
    }
    return this.speed;
  }

  /** The hammer: raised, brought down in front of it. */
  private smash(dt: number): void {
    const R = this.rig, g = this.g;
    this.speed *= Math.exp(-dt * 4);
    const T = this.target;
    if (T) R.aim = { x: T.x, y: this.y, z: T.z };
    if (T && Math.abs(R.twist) > 0.4) R.yaw += clamp(R.twist, -1, 1) * MECH_T.turn * 1.5 * dt;
    const up = 0.8, down = 0.25;
    R.smash = this.actT < up ? 0.5 * (this.actT / up) : 0.5 + 0.5 * Math.min(1, (this.actT - up) / down);
    if (this.sub === 0 && this.actT >= up + down) {
      this.sub = 1;
      this.stats.smashes++;
      const h = R.hammer(_w), y = g.world.groundHeight(h.x, h.z);
      this.stats.broken += g.interactions.steps.land(h.x, y, h.z, stepEnergy(bodyMass(MECH_T.height, 1.4), MECH_T.height) * 1.5 * dealtBy(this), MECH_T.height, { cause: 'threat', own: false, sound: 'mech_step', ref: 110, maxR: 400, foot: 4 });
      this.knockAround(h.x, y, h.z, 9, 8);
      this.hurtPlayerNear(h.x, y + 1, h.z, 6, 70, 22);
      this.onBlow?.('slam', h.x, y, h.z, 7);
      for (let i = 0; i < 8; i++) g.dust.burst(h.x + this.rng.range(-3, 3), y + 0.5, h.z + this.rng.range(-3, 3), 5, 2, 5, 1.6, 3, DUST, 0.2, 0.5);
    }
    if (this.actT > up + down + 0.9) { this.cool.smash = MECH_T.smashGap; this.endAttack(); }
  }

  /** Hot: stands, the vents open glowing, steam pouring off; then walks on cooled. */
  private venting(dt: number): void {
    const R = this.rig, g = this.g;
    this.speed *= Math.exp(-dt * 3);
    if (this.actT < dt * 1.5) { this.stats.vents++; g.audio.play('mech_vent', this.x, this.y + 10, this.z, 1, 1, 120, g.renderer.camera.position); }
    this.heat = Math.max(0, this.heat - dt / MECH_T.ventT * 1.2);
    // Steam off the open vents.
    this.sparkT -= dt;
    if (this.sparkT <= 0 && this.vent > 0.3) {
      this.sparkT = 0.06;
      for (const side of [1, -1]) {
        const v = MECH_BONES.vent(side), B = MECH.ventAt, p = R.point(v, side * B[0], MECH.hullAt[1] + B[1] + 0.5, B[2] - 1.4, _w);
        const f = R.fwd;
        g.elements.fx.soft(p.x, p.y, p.z, -f.x * 3 + this.rng.range(-1, 1), 4 + this.rng.range(0, 3), -f.z * 3 + this.rng.range(-1, 1), 2.4, 1.2, 5, STEAM, STEAM_END, 0.45, 0.8, -0.8);
      }
    }
    if (this.actT > MECH_T.ventT) { this.heat = 0; this.endAttack(); }
  }

  /** Frost on the open vents: it locks up, sags, the visor dark; then reboots. */
  private startShutdown(): void {
    if (this.act === 'shutdown') { this.actT = Math.min(this.actT, 1); return; }
    this.setAct('shutdown');
    this.stats.shutdowns++;
    this.heat = 0;
    this.g.audio.play('mech_alarm', this.x, this.y + 10, this.z, 0.8, 0.7, 160, this.g.renderer.camera.position);
  }

  private shut(dt: number): void {
    this.speed = 0;
    // (Frost hangs on it: a little ice mist.)
    if (Math.random() < dt * 12) {
      const p = this.rig.joint(MECH_BONES.hull, _w);
      this.g.elements.fx.soft(p.x + this.rng.range(-5, 5), p.y + this.rng.range(-2, 6), p.z + this.rng.range(-5, 5), 0, -0.5, 0, 2, 1.5, 4, STEAM, STEAM_END, 0.3, 0.8, 0.2);
    }
    if (this.actT > MECH_T.shutT) { this.alarm(); this.endAttack(); }
  }

  private startKneel(): void {
    this.setAct('kneel');
    this.stats.kneels++;
    this.zone('joint').recent = 0;
    this.sparks(this.zone('joint').x, this.zone('joint').y, this.zone('joint').z, 14);
    this.g.audio.play('mech_alarm', this.x, this.y + 10, this.z, 0.7, 0.85, 160, this.g.renderer.camera.position);
  }

  private kneel(dt: number): void {
    this.speed *= Math.exp(-dt * 5);
    if (this.actT > MECH_T.kneelT) this.endAttack();
  }

  // ---------------------------------------------------------------- leaving, dying

  private watch(): void {
    if (this.mode === 'retreat') return;
    if (this.hp < this.maxHp * MECH_T.retreatAt) { this.startLeaving(true); return; }
    if (this.t > MECH_T.visitMax) this.startLeaving(false);
  }

  private startLeaving(hurt: boolean): void {
    if (this.mode === 'retreat' || this.defeated) return;
    this.mode = 'retreat';
    this.dir = -1;
    if (hurt && this.topAggro()?.key === 'player') this.g.crime.reward({ karma: MECH_T.karma.retreat, why: 'drove the mech off', rep: 6, news: 'rogue war machine driven off' });
    if (this.act === 'salvo' || this.act === 'cannon' || this.act === 'smash') this.endAttack();
  }

  private finish(o: ThreatOutcome): void {
    if (this.mode === 'gone') return;
    this.active = false;
    this.outcome = o;
    this.mode = 'gone';
  }

  private startDying(): void {
    if (this.defeated) return;
    const g = this.g;
    this.mode = 'dying';
    this.active = false;
    this.outcome = 'defeated';
    this.setAct('topple');
    this.speed = 0;
    g.audio.play('mech_alarm', this.x, this.y + 10, this.z, 1, 0.6, 220, g.renderer.camera.position);
    g.stimuli.emit('collapse', this.x, this.y, this.z, 8, 500, { cause: 'threat', size: this.height });
    if (heroEarned(this.aggro)) g.crime.reward({ karma: MECH_T.karma.defeated, why: 'destroyed the mech', rep: 12, news: 'rogue war machine destroyed', stopped: true });
  }

  /** Sparks and small blasts for a few seconds, then it pitches forward and crashes down. */
  private topple(dt: number): void {
    const R = this.rig, g = this.g;
    this.sparkT -= dt;
    if (this.sparkT <= 0) {
      this.sparkT = 0.25;
      const c = R.caps[this.rng.int(0, R.caps.length - 1)];
      this.sparks(c.ax, c.ay, c.az, 10);
      if (this.rng.chance(0.3)) { g.elements.fx.glow(c.ax, c.ay, c.az, 0, 3, 0, 0.4, 1.5, 4, FIRE_HOT, FIRE_END, 0.9, 2, -2); g.audio.play('army_explosion', c.ax, c.ay, c.az, 0.6, 1.3, 30, g.renderer.camera.position); }
    }
    if (this.actT < 2.5) { R.roll = 0.04 * Math.sin(this.actT * 7); return; }
    // Falling forward: about the feet, the body dropping.
    const u = clamp((this.actT - 2.5) / 1.8, 0, 1), e = u * u;
    R.pitch = e * 1.45;
    const ground = this.groundUnder(), sc = MECH_T.scale;
    R.y = ground + (MECH.stand * sc) * (1 - e) + 3.2 * sc * e;
    const f = R.fwd;
    R.x += f.x * dt * 7 * e; R.z += f.z * dt * 7 * e;
    if (u >= 1 && this.mode === 'dying') {
      const y = g.world.groundHeight(R.x + f.x * 8, R.z + f.z * 8), hx = R.x + f.x * 10, hz = R.z + f.z * 10;
      this.stats.broken += g.interactions.steps.land(hx, y, hz, stepEnergy(bodyMass(MECH_T.height, 1.4), MECH_T.height) * 5, MECH_T.height, { cause: 'threat', own: false, sound: 'mech_step', ref: 140, maxR: 650, foot: 9 });
      this.knockAround(hx, y, hz, 16, 8);
      this.hurtPlayerNear(hx, y + 1, hz, 9, 60, 20);
      for (let i = 0; i < 14; i++) g.dust.burst(hx + this.rng.range(-12, 12), y + 1, hz + this.rng.range(-12, 12), 6, 2.5, 4, 2, 5, DUST, 0.1, 0.6);
      g.audio.play('army_bomb', hx, y, hz, 1, 0.9, 80, g.renderer.camera.position);
      this.onBlow?.('fall', hx, y, hz, 14);
      this.mode = 'dead';
      this.downAt = g.sky.hoursAbs;
      this.deadT = this.t;
    }
  }

  /** The wreck: face down, still. */
  private lie(_dt: number): void {
    this.rig.still = true;
    this.rig.visor = 0; this.rig.heat = 0; this.rig.vent = 0.3;
    this.rig.place();
  }

  /** Smoke off the wreck for a while. */
  private smoulder(dt: number): void {
    if (this.t - this.deadT > 240 || Math.random() > dt * 6) return;
    const c = this.rig.caps[0];
    this.g.elements.fx.soft(c.ax + this.rng.range(-4, 4), c.ay + 2, c.az + this.rng.range(-4, 4), this.rng.range(-0.5, 0.5), 3, this.rng.range(-0.5, 0.5), 7, 2.5, 8, SMOKE, SMOKE_L, 0.5, 0.4, -0.7);
  }
  private deadT = 0;

  // ---------------------------------------------------------------- what it does to things

  private alarm(): void {
    if (this.t - this.alarmT < 10) return;
    this.alarmT = this.t;
    const h = this.headPos;
    this.g.audio.play('mech_alarm', h.x, h.y, h.z, 0.9, 1, 220, this.g.renderer.camera.position);
    this.g.stimuli.emit('roar', h.x, h.y, h.z, 7, 500, { cause: 'threat', size: this.height });
    this.onBlow?.('roar', h.x, h.y, h.z, 220);
  }

  private sparks(x: number, y: number, z: number, n: number): void {
    const fx = this.g.elements.fx;
    for (let i = 0; i < n; i++) fx.glow(x, y, z, this.rng.range(-8, 8), this.rng.range(0, 9), this.rng.range(-8, 8), 0.4 + this.rng.range(0, 0.4), 0.15, 0.05, SPARK, FLASH_END, 1, 0.6, -9);
  }

  private knockAround(x: number, y: number, z: number, r: number, power: number): void {
    for (const a of this.g.peds.neighbours(x, z, r, [])) if (Math.abs(a.y - y) < 4) this.knock(a, x, z, power);
  }

  private knock(a: PedAgent, fx: number, fz: number, power: number): void {
    if (a.inside || a.state === PState.Down) return;
    this.g.reactions.knockDown(a, fx, fz, power * dealtBy(this), 'threat');
    this.g.consequences.record('mech', 'person', 'knockdown', a.x, a.z, a, 'threat');
    this.hurt++;
    this.stats.knocked++;
  }

  private hurtPlayerNear(x: number, y: number, z: number, r: number, dmg: number, fling: number): void {
    const g = this.g, p = g.player;
    const d = Math.hypot(p.pos.x - x, p.pos.z - z);
    if (d > r + p.radius || Math.abs(p.pos.y + p.height * 0.4 - y) > r + p.height) return;
    const k3 = p.k ** 3, rel = Math.min(1, Math.pow(this.height / Math.max(1, p.height), 0.8));
    const dealt = g.crime.health.damage(dmg * (1 - (d / (r + p.radius + 1)) * 0.5) * k3 * Math.max(0.15, rel) * dealtBy(this), 'monster', x, z, y);
    this.stats.playerHits++;
    if (dealt <= 0 && !g.crime.health.invulnerable) return;
    const dx = p.pos.x - x, dz = p.pos.z - z, l = Math.hypot(dx, dz) || 1, f = fling * rel;
    if (f > 2 && !p.flying) {
      p.vel.x += (dx / l) * f; p.vel.z += (dz / l) * f; p.vel.y = Math.max(p.vel.y, f * 0.45);
      p.grounded = false;
      if (rel > 0.5) p.downT = Math.max(p.downT, 1.2);
    }
    g.camRig.addShake(0.3);
  }

  // ---------------------------------------------------------------- finding things

  private hostileTarget(reach: number): { x: number; y: number; z: number } | null {
    const g = this.g, p = g.player.pos;
    const at = (key: string) => (key === 'player' ? { x: p.x, y: p.y + g.player.height * 0.5, z: p.z } : this.unitAt?.(key) ?? null);
    return angriestInReach(this.aggro, at, this.x, this.z, reach);
  }

  private airNear(x: number, y: number, z: number, r: number): AirTarget | null {
    const g = this.g;
    for (const prov of this.airTargets) { const a = prov(x, y, z, r); if (a.length) return a[0]; }
    for (const d of g.future.drones.list) {
      if (!d.alive || d.state !== 0) continue;
      if (Math.hypot(d.x - x, d.z - z) < r && d.y - g.world.groundHeight(d.x, d.z) > 12) return { x: d.x, y: d.y, z: d.z, swat: (jx, jy, jz) => g.future.drones.knock(d, jx, jy, jz) };
    }
    return null;
  }

  // ---------------------------------------------------------------- around it

  private surroundings(dt: number): void {
    const g = this.g;
    if (this.mode === 'gone' || this.defeated) return;
    this.stimT -= dt;
    if (this.stimT <= 0) {
      this.stimT = 1.4;
      g.physics.prefetchGround(this.x + this.rig.fwd.x * 40, this.z + this.rig.fwd.z * 40, 90);
      g.stimuli.emit('threat', this.x, this.groundUnder() + 10, this.z, 6, 170, { cause: 'threat' });
      for (const v of g.traffic.vehicles) if (v.state === VState.Drive && !v.task && Math.hypot(v.x - this.x, v.z - this.z) < 150) v.fear = Math.max(v.fear, 1);
    }
    this.newsT -= dt;
    if (this.newsT <= 0) { this.newsT = 35; g.future.drones.incident(DKind.News, this.x, this.z, g.player.pos.x, g.player.pos.z); }
  }

  private updateZones(): void {
    const R = this.rig, C = R.caps;
    const set = (id: string, i: number) => { const Z = this.zone(id), c = C[i]; Z.x = (c.ax + c.bx) / 2; Z.y = (c.ay + c.by) / 2; Z.z = (c.az + c.bz) / 2; Z.r = c.r; };
    set('body', 0); set('cockpit', 2); set('pod', 3); set('arm', 5); set('leg', 9); set('joint', 10); set('vents', 17);
    for (const Z of this.zones) Z.exposed = this.targetable && (Z.id !== 'vents' || this.vent > 0.3);
  }

  private note(_s: string): void { /* (a hook for the director's log) */ }

  // ================================================================== drawing, obstacles

  get visible(): boolean { return this.mode !== 'gone'; }

  draw(mesh: MechMesh): number { return this.visible ? mesh.draw(this.rig) : 0; }

  /** Its legs and hull (or the wreck) are in the player's way. */
  obstacles(x0: number, z0: number, x1: number, z1: number, out: (o: import('../../../world/Collision').Obstacle) => void): void {
    if (this.mode === 'gone') return;
    for (const c of this.rig.caps) {
      if (c.zone === 'arm' || c.zone === 'pod') continue;
      const mx = (c.ax + c.bx) / 2, mz = (c.az + c.bz) / 2, r = c.r * 0.9;
      if (mx + r < x0 || mx - r > x1 || mz + r < z0 || mz - r > z1) continue;
      out({ cyl: true, x: mx, z: mz, r, hx: 0, hz: 0, ux: 1, uz: 0, y0: Math.min(c.ay, c.by) - c.r, y1: Math.max(c.ay, c.by) + c.r });
    }
  }

  // ================================================================== dev

  /** Dev: it is already in town, a little up the way from the hero, walking towards them. */
  devNear(): string {
    const p = this.g.player.pos;
    const s = nearestS(this.route, p.x, p.z, this.route.length / 2, 1e6);
    this.placeAt(Math.max(0, s - 90));
    return `walking in ${Math.round(Math.hypot(this.x - p.x, this.z - p.z))} m from you`;
  }

  devSalvo(): string { if (!this.targetable) return this.mode; const t = this.hostileTarget(MECH_T.salvoR) ?? this.buildingTarget(); if (!t) return 'nothing to fire at'; this.target = t; this.setAct('salvo'); return 'salvo'; }
  devCannon(): string { const a = this.airNear(this.x, this.y, this.z, 2000); if (!a) return 'nothing flying'; this.air = a; this.target = { x: a.x, y: a.y, z: a.z }; this.setAct('cannon'); return 'cannon'; }
  devSmash(): string { if (!this.targetable) return this.mode; const f = this.rig.fwd; this.target = { x: this.x + f.x * 10, y: this.y, z: this.z + f.z * 10 }; this.setAct('smash'); return 'smash'; }
  devVent(): string { if (!this.targetable) return this.mode; this.heat = 1; this.setAct('vent'); return 'venting'; }
  devFreeze(): string { if (this.act !== 'vent') { this.heat = 1; this.setAct('vent'); this.vent = 1; } this.startShutdown(); return this.act; }
  devKneel(): string { if (!this.targetable) return this.mode; this.startKneel(); return 'kneeling'; }
  devLeave(): string { this.startLeaving(false); return this.mode; }
  devDowntown(): string { this.placeAt(Math.max(0, this.route.length - 30)); return 'downtown'; }
}
