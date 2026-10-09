/**
 * The Roc (THREATS_PLAN §1 #5, Phase E): a giant bird of prey, 40 m from wingtip to wingtip.
 *
 * It comes in high from beyond the hero, circles over them and screeches, then takes its pick:
 *
 *   perch    it glides onto the roof edge of a tall building (its weight breaks the top floor), mantles
 *            its wings over the street, screeches, and beats its wings: the gusts throw people off
 *            their feet, street furniture and debris about; it pecks at whoever comes near.
 *   snatch   it stoops on a car (a bus by preference), carries it off up high and drops it.
 *   dive     it stoops on a helicopter or a drone and knocks it out of the sky.
 *   swoop    it rakes whoever hurt it most with its talons in a low pass.
 *
 * A whirlwind (the power) or enough damage to its wings brings it down: it tumbles out of the sky,
 * lands hard and stands on the street for a few seconds, head low and open to blows, then labours
 * back up. Its head is the weak spot (three times the damage) while it screeches or is grounded.
 * Hurt to 30 % it flies off; brought down it falls out of the sky and lies where it fell (the body
 * stays a few game hours).
 *
 * A ThreatActor (1800 points; zones head, body, wings, legs) always in reach of what can reach it,
 * and an ArmyFoe that goes where it likes (`chased`, like a rampaging giant: the army rings it).
 */
import * as THREE from 'three';
import type { Game } from '../../Game';
import { Rng } from '../../../core/rng';
import { clamp, angleDiff } from '../../../core/math';
import { pointInPoly } from '../../../core/geom2';
import { PState, type PedAgent } from '../../../sim/Pedestrians';
import { VState, type Vehicle } from '../../../sim/Traffic';
import { DKind } from '../../../future/Drones';
import { dealtBy } from '../../../shared/status';
import { rayCapsule } from '../rig/CreatureRig';
import type { ThreatActor, ThreatEvent, ThreatOutcome, ThreatTarget, ThreatZone, DamageSource, DamageResult } from '../ThreatEvent';
import { DAMAGE_PER_IMPULSE } from '../ThreatEvent';
import type { Cause } from '../../Stimuli';
import { angriestInReach } from '../../response/forces/BattleModel';
import type { AirProvider, AirTarget, StriderBlow } from '../Strider';
import { bookAggro, decayAggro, heroEarned, topAggro, zoneDealt } from '../aggro';
import { playerPath, playerSpawn } from '../rampageRules';
import { bodyMass, stepEnergy } from '../../GiantBody';
import { RocRig, PERCH_HEIGHT, ROC } from './rocRig';
import type { RocMesh } from './RocMesh';
import { pickPerch, entryPoint, pickPrey, type Perch } from './rocPlan';
import type { BuildingRef } from '../../../world/WorldIndex';

export const ROC_T = {
  hp: 1800,
  /** Its "height" for the con, stomps and the shake (m). */
  height: 12,
  /** Size (× the full-size bird), the incident radius (m). */
  scale: 1, radius: 160,
  /** Flying: cruise and stoop speeds (m/s), turn rate (rad/s), height over the roofs (m). */
  cruise: 24, stoop: 40, turn: 0.9, alt: [65, 95] as [number, number], clear: 22,
  /** Circling: radius (m) and how long before it picks something (s). */
  circleR: [60, 90] as [number, number], circleT: [7, 13] as [number, number],
  /** Perched (s), between screeches (s), between wing gusts (s), a gust's reach (m). */
  perchT: [18, 28] as [number, number], screechGap: [6, 11] as [number, number], gustGap: [5, 8] as [number, number], gustR: 30,
  /** Snatching: cars within (m), carried up this high over the ground (m), for (s). */
  preyR: 300, carryAlt: 55, carryT: [6, 9] as [number, number],
  /** Grounded: how long (s), wind it takes (summed power), recent wing damage that brings it down. */
  groundT: 9, windDown: 2.5, wingDown: 240,
  weakMul: 3, retreatAt: 0.3,
  /** The visit ends after (s); flying off takes at most (s). */
  visitMax: 600, leaveT: 50,
  /** The body lies this many game hours. */
  bodyHours: 6,
  karma: { weak: 2, retreat: 60, defeated: 120 },
};

export const ROC_ZONES: { id: string; name: string; armour: number; weak: boolean }[] = [
  { id: 'head', name: 'Head', armour: 0.45, weak: true },
  { id: 'body', name: 'Body', armour: 0.7, weak: false },
  { id: 'wing', name: 'Wings', armour: 0.5, weak: false },
  { id: 'leg', name: 'Talons', armour: 0.65, weak: false },
];

type Mode = 'rampage' | 'retreat' | 'dying' | 'dead' | 'gone';
export type RocAct = 'arrive' | 'circle' | 'perch' | 'snatch' | 'carry' | 'dive' | 'swoop' | 'grounded' | 'takeoff' | 'leave' | 'fall';

let EVENT_ID = 6000;
const DUST = new THREE.Color(0.6, 0.57, 0.52);
const FEATHER = new THREE.Color(0.22, 0.16, 0.1);
const _v = { x: 0, y: 0, z: 0 };
const _w = { x: 0, y: 0, z: 0 };

export class Roc implements ThreatEvent, ThreatActor {
  readonly id = EVENT_ID++;
  readonly archetype = 'roc';
  readonly tier = 'major';
  readonly engageOnFoot = false;
  readonly ceiling = 4;
  readonly name = 'Roc';
  readonly radius = ROC_T.radius;
  readonly size = ROC.halfSpan * 2 * ROC_T.scale;
  readonly height = ROC_T.height;
  readonly maxHp = ROC_T.hp;
  hp = ROC_T.hp;
  t = 0;
  active = true;
  outcome: ThreatOutcome | null = null;
  hurt = 0;
  readonly rig: RocRig;
  readonly zones: ThreatZone[];
  readonly aggro = new Map<string, number>();
  mode: Mode = 'rampage';
  act: RocAct = 'arrive';
  /** What the army reads: it goes where it likes, its "route" ends where it is. */
  readonly route = { pts: [] as number[], s: [] as number[], length: 0, start: { x: 0, z: 0 }, end: { x: 0, z: 0 } };
  readonly chased = true;
  airTargets: AirProvider[] = [];
  unitAt: ((key: string) => { x: number; y: number; z: number } | null) | null = null;
  onBlow: ((kind: StriderBlow, x: number, y: number, z: number, r: number) => void) | null = null;
  /** Game hours when it came down (the body lies a while). */
  downAt = 0;
  readonly stats = {
    perches: 0, snatches: 0, drops: 0, dives: 0, swats: 0, swoops: 0, screeches: 0, gusts: 0, grounded: 0, crushed: 0,
    damage: 0, weakHits: 0, wrecked: 0, knocked: 0, playerHits: 0, pecks: 0,
  };
  private rng: Rng;
  private actT = 0;
  private sub = 0;
  private stayFor = 0;
  private speed = ROC_T.cruise;
  private vy = 0;
  private yawRate = 0;
  /** Circling round (centre, radius, angle, height). */
  private orbit = { x: 0, z: 0, r: 70, a: 0, alt: 80 };
  private perchAt: Perch | null = null;
  private perchRef: BuildingRef | null = null;
  private usedPerch = new Set<BuildingRef>();
  private prey: Vehicle | null = null;
  private air: AirTarget | null = null;
  private aim = new THREE.Vector3();
  private carryDir = 0;
  private cool = { screech: 3, gust: 4, peck: 2, swoop: 20 };
  private screechT = 0;
  private gustT = 0;
  private wind = 0;
  private recentHit = 0;
  private leaveAt = { x: 0, z: 0 };
  private newsT = 8;
  private stimT = 0;
  private pathT = 0;
  private last: RocAct = 'arrive';

  constructor(private g: Game, seed: number) {
    this.rng = new Rng(seed);
    this.zones = ROC_ZONES.map((z) => ({ ...z, exposed: true, x: 0, y: 0, z: 0, r: 3, recent: 0 }));
    const rig = new RocRig(ROC_T.scale);
    const c = g.macro.centres[0], p = g.player.pos;
    const e = entryPoint(c.x, c.z, p.x, p.z, this.rng);
    rig.x = e.x; rig.z = e.z; rig.y = this.floor(e.x, e.z) + e.y;
    rig.yaw = Math.atan2(p.x - e.x, p.z - e.z);
    this.rig = rig;
    this.orbit.x = p.x; this.orbit.z = p.z;
    rig.place();
    this.updateZones();
    this.path();
  }

  // ================================================================== ThreatActor / ArmyFoe

  get x(): number { return this.rig.x; }
  get y(): number { return this.rig.y; }
  get z(): number { return this.rig.z; }
  get s(): number { return this.route.length; }
  get defeated(): boolean { return this.mode === 'dying' || this.mode === 'dead'; }
  get targetable(): boolean { return this.mode === 'rampage' || this.mode === 'retreat'; }
  get actors(): ThreatActor[] { return this.targetable ? [this] : []; }
  get headPos(): { x: number; y: number; z: number } { return this.rig.joint(8, _v); }
  get title(): string {
    if (this.defeated) return 'Roc — brought down';
    return this.act === 'perch' && this.sub >= 2 ? 'Roc — perched on a rooftop' : this.act === 'grounded' ? 'Roc — grounded' : 'Roc — circling over the city';
  }
  /** On a roof or the street (people walk into it). */
  get standing(): boolean { return (this.act === 'perch' && this.sub === 2) || (this.act === 'grounded' && this.sub === 1) || this.mode === 'dead'; }
  get flying(): boolean { return !this.standing && this.mode !== 'gone'; }

  zone(id: string): ThreatZone { return this.zones.find((z) => z.id === id) ?? this.zones[1]; }

  private zoneOfCap(i: number): ThreatZone {
    const z = this.rig.caps[i].zone;
    return this.zone(z === 'neck' ? 'body' : z === 'tail' ? 'wing' : z);
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
    const weak = Z.weak && Z.exposed;
    const dealt = zoneDealt(amount, Z.armour, weak, ROC_T.weakMul);
    this.hp = Math.max(0, this.hp - dealt);
    Z.recent += dealt;
    this.recentHit += dealt;
    this.stats.damage += dealt;
    if (weak) this.stats.weakHits++;
    bookAggro(this.aggro, src.key ?? src.cause, dealt + amount * 0.02 + (src.aggro ?? 0));
    if (src.cause === 'player' && weak && dealt > 20) this.g.progress.addKarma(ROC_T.karma.weak, 'hit the roc where it hurts');
    // A hard blow while it carries something: it lets go.
    if (this.act === 'carry' && this.recentHit > 160) this.drop(false);
    // Wings shot through: it comes down.
    if (Z.id === 'wing' && Z.recent > ROC_T.wingDown && this.flying && this.act !== 'fall' && this.act !== 'grounded') this.startGrounded();
    return { dealt, zone: Z, weak };
  }

  blow(x: number, y: number, z: number, r: number, jx: number, jy: number, jz: number, src: DamageSource): DamageResult | null {
    if (!this.targetable) return null;
    const n = this.rig.nearest(x, y, z);
    if (!n || n.d > r + 0.5) return null;
    return this.damage(this.zoneOfCap(n.i), Math.hypot(jx, jy, jz) * DAMAGE_PER_IMPULSE, { ...src, x: src.x ?? x, y: src.y ?? y, z: src.z ?? z });
  }

  /** Elements: a whirlwind tumbles it out of the sky; fire and lightning hurt as usual. */
  onElement(el: 'fire' | 'frost' | 'shock' | 'wind', dur: number): number {
    if (el === 'wind') {
      this.wind += dur;
      if (this.wind > ROC_T.windDown && this.flying && this.targetable && this.act !== 'fall' && this.act !== 'grounded') this.startGrounded();
      return 1;
    }
    if (el === 'frost') return 0.8; // (feathers)
    return 1;
  }

  conStrength(): number { return 170 * Math.sqrt(Math.max(0.05, this.hp / this.maxHp)); }
  topAggro(): { key: string; v: number } | null { return topAggro(this.aggro); }

  // ================================================================== ThreatEvent

  strength(): number { return this.active ? this.hp / this.maxHp : 0; }
  targetsNear(_x: number, _z: number, _r: number): ThreatTarget[] { return []; }
  strike(_t: ThreatTarget, _jx: number, _jy: number, _jz: number, _cause: Cause): void { /* nothing on foot reaches it */ }
  shutdown(): void { if (this.mode === 'rampage') this.startLeaving(false); }
  dispose(): void { if (this.prey) this.drop(false); }
  obliterate(): void { this.finish('destroyed'); }

  /** Where the army comes from: around it, from the city's side. */
  spawnPoint(k: number): { x: number; z: number } {
    const c = this.g.macro.centres[0];
    return playerSpawn(c.x, c.z, this.x, this.z, k);
  }

  batteryAt(): { x: number; z: number } {
    const R = this.route, dx = R.end.x - R.start.x, dz = R.end.z - R.start.z, l = Math.hypot(dx, dz) || 1;
    return { x: R.end.x + (dx / l) * 3200, z: R.end.z + (dz / l) * 3200 };
  }

  snapshot(): Record<string, unknown> {
    return {
      id: this.id, archetype: this.archetype, t: +this.t.toFixed(1), active: this.active, outcome: this.outcome, mode: this.mode, act: this.act, sub: this.sub,
      x: Math.round(this.x), y: Math.round(this.y), z: Math.round(this.z), speed: +this.speed.toFixed(1), hp: Math.round(this.hp),
      overGround: Math.round(this.y - this.g.world.groundHeight(this.x, this.z)), wind: +this.wind.toFixed(2),
      perch: this.perchAt ? { x: Math.round(this.perchAt.x), y: Math.round(this.perchAt.y), z: Math.round(this.perchAt.z) } : null,
      prey: this.prey ? this.prey.kind : null,
      aggro: Object.fromEntries([...this.aggro].map(([k, v]) => [k, Math.round(v)])), hurt: this.hurt, ...this.stats,
    };
  }

  // ================================================================== frame

  update(dt: number): void {
    this.t += dt;
    if (this.mode === 'gone') return;
    decayAggro(this.aggro, dt, 90);
    for (const Z of this.zones) Z.recent *= Math.exp(-dt / 5);
    this.recentHit *= Math.exp(-dt / 2);
    this.wind *= Math.exp(-dt / 3);
    this.cool.screech -= dt; this.cool.gust -= dt; this.cool.peck -= dt; this.cool.swoop -= dt;
    this.actT += dt;
    const R = this.rig;
    R.t += dt;
    if (this.mode === 'dead') { this.lie(dt); this.updateZones(); return; }
    if (this.mode !== 'dying') {
      if (this.hp <= 0) this.startDying();
      else this.watch();
    }
    // (Pose defaults each frame; the act sets what it needs.)
    R.perch = false; R.mantle = 0; R.fold = 0; R.legs = 0; R.grip = 0; R.flail = 0; R.look = null;
    R.tailSpread = 0.4; R.tailPitch = 0;
    switch (this.act) {
      case 'arrive': this.arrive(dt); break;
      case 'circle': this.circle(dt); break;
      case 'perch': this.perch(dt); break;
      case 'snatch': this.snatch(dt); break;
      case 'carry': this.carry(dt); break;
      case 'dive': this.dive(dt); break;
      case 'swoop': this.swoop(dt); break;
      case 'grounded': this.grounded(dt); break;
      case 'takeoff': this.takeoff(dt); break;
      case 'leave': this.leave(dt); break;
      case 'fall': this.falling(dt); break;
    }
    this.screech(dt);
    R.place();
    this.updateZones();
    this.surroundings(dt);
    this.pathT -= dt;
    if (this.pathT <= 0) { this.pathT = 2; this.path(); }
  }

  // ---------------------------------------------------------------- flying

  /** The highest roof (or the ground) at a point. */
  private floor(x: number, z: number): number {
    const g = this.g;
    let y = g.world.groundHeight(x, z);
    for (const r of g.world.buildingsIn(x - 1, z - 1, x + 1, z + 1)) if (r.alive && r.top > y && pointInPoly(r.poly, x, z)) y = r.top;
    return y;
  }

  /** Roofs under it and ahead along its heading (m): what it must clear. */
  private floorAhead(): number {
    const R = this.rig, f = R.fwd;
    let y = this.floor(R.x, R.z);
    for (const d of [25, 50, 80]) y = Math.max(y, this.floor(R.x + f.x * d, R.z + f.z * d));
    return y;
  }

  /** Fly towards a point: a banked turn at `turn` rad/s, easing to `speed`, climbing or sinking to its height. */
  private steer(dt: number, tx: number, ty: number, tz: number, speed: number, turn = ROC_T.turn, clearRoofs = true): void {
    const R = this.rig;
    const want = Math.atan2(tx - R.x, tz - R.z);
    const dyaw = clamp(angleDiff(R.yaw, want), -turn * dt, turn * dt);
    R.yaw += dyaw;
    this.yawRate += (dyaw / Math.max(dt, 1e-3) - this.yawRate) * Math.min(1, dt * 4);
    this.speed += (speed - this.speed) * Math.min(1, dt * 0.9);
    let goalY = ty;
    if (clearRoofs) goalY = Math.max(goalY, this.floorAhead() + ROC_T.clear);
    const vyWant = clamp((goalY - R.y) * 0.7, -16, 12);
    this.vy += (vyWant - this.vy) * Math.min(1, dt * 1.6);
    const f = R.fwd;
    R.x += f.x * this.speed * dt; R.z += f.z * this.speed * dt; R.y += this.vy * dt;
    this.attitude(dt);
  }

  /** Straight at a point in 3D (a stoop, the last metres onto a perch), the heading turning to face it. */
  private glideTo(dt: number, tx: number, ty: number, tz: number, speed: number, faceYaw?: number): number {
    const R = this.rig;
    const dx = tx - R.x, dy = ty - R.y, dz = tz - R.z, d = Math.hypot(dx, dy, dz);
    const v = Math.min(speed, d * 1.6 + 2);
    this.speed += (v - this.speed) * Math.min(1, dt * 2.5);
    const k = d > 1e-3 ? Math.min(d, this.speed * dt) / d : 0;
    R.x += dx * k; R.y += dy * k; R.z += dz * k;
    this.vy = d > 1e-3 ? (dy / d) * this.speed : 0;
    const want = faceYaw ?? (Math.hypot(dx, dz) > 2 ? Math.atan2(dx, dz) : R.yaw);
    const dyaw = clamp(angleDiff(R.yaw, want), -2 * dt, 2 * dt);
    R.yaw += dyaw;
    this.yawRate += (dyaw / Math.max(dt, 1e-3) - this.yawRate) * Math.min(1, dt * 4);
    this.attitude(dt);
    return d;
  }

  /** Bank into turns, nose with the climb, the wings beating when it climbs or flies slowly. */
  private attitude(dt: number): void {
    const R = this.rig;
    const roll = clamp(this.yawRate * this.speed * 0.045, -0.85, 0.85);
    R.roll += (roll - R.roll) * Math.min(1, dt * 2.5);
    const pitch = clamp(Math.atan2(this.vy, Math.max(4, this.speed)) * 0.8, -0.7, 0.45);
    R.pitch += (pitch - R.pitch) * Math.min(1, dt * 2);
    const work = this.vy > 2 || this.speed < 14 ? 1 : this.vy < -6 ? 0.05 : 0.3;
    R.beat += (work - R.beat) * Math.min(1, dt * 2);
    R.flap += dt * Math.PI * 2 * (0.55 + 0.35 * R.beat);
    R.tailSpread = 0.3 + 0.5 * clamp(1 - this.speed / ROC_T.cruise, 0, 1);
  }

  private arrive(dt: number): void {
    const p = this.g.player.pos;
    this.steer(dt, p.x, this.floor(p.x, p.z) + ROC_T.alt[1], p.z, ROC_T.cruise);
    if (Math.hypot(p.x - this.x, p.z - this.z) < 160) this.startCircle(p.x, p.z);
    if (this.actT > 60) this.startCircle(this.x, this.z);
  }

  private startCircle(cx: number, cz: number): void {
    this.setAct('circle');
    const o = this.orbit;
    o.x = cx; o.z = cz;
    o.r = this.rng.range(ROC_T.circleR[0], ROC_T.circleR[1]);
    o.a = Math.atan2(this.z - cz, this.x - cx);
    o.alt = this.rng.range(ROC_T.alt[0], ROC_T.alt[1]);
    this.stayFor = this.rng.range(ROC_T.circleT[0], ROC_T.circleT[1]);
  }

  private circle(dt: number): void {
    const o = this.orbit;
    o.a += (this.speed / o.r) * dt;
    const ax = o.x + Math.cos(o.a + 0.35) * o.r, az = o.z + Math.sin(o.a + 0.35) * o.r;
    this.steer(dt, ax, this.floor(o.x, o.z) + o.alt, az, ROC_T.cruise * 0.85, ROC_T.turn * 1.3);
    this.rig.look = this.g.player.pos;
    if (this.actT > this.stayFor) this.decide();
  }

  /** What next, from circling: a flier near, whoever hurt it, a perch, a car, round again. */
  private decide(): void {
    if (this.mode === 'retreat') { this.startLeave(); return; }
    const g = this.g, p = g.player.pos;
    const air = this.airNear(this.x, this.y, this.z, 320);
    if (air) { this.air = air; this.setAct('dive'); return; }
    const foe = this.hostileTarget(380);
    if (foe && this.cool.swoop <= 0 && this.rng.chance(0.6)) { this.cool.swoop = 25; this.setAct('swoop'); return; }
    const r = this.rng.float();
    if (r < 0.5 && this.last !== 'perch' && this.findPerch()) { this.setAct('perch'); return; }
    if (r < 0.85 && this.last !== 'snatch' && this.findPrey()) { this.setAct('snatch'); return; }
    if (this.findPerch()) { this.setAct('perch'); return; }
    this.startCircle(p.x + this.rng.range(-60, 60), p.z + this.rng.range(-60, 60));
  }

  private setAct(a: RocAct): void {
    if (a !== 'circle' && a !== 'takeoff') this.last = a;
    this.act = a; this.actT = 0; this.sub = 0;
  }

  // ---------------------------------------------------------------- perching

  private findPerch(): boolean {
    const g = this.g, p = g.player.pos, R = 360;
    const refs = g.world.buildingsIn(p.x - R, p.z - R, p.x + R, p.z + R).slice();
    const used = new Set<number>();
    refs.forEach((r, i) => { if (this.usedPerch.has(r)) used.add(i); });
    const P = pickPerch(refs, p.x, p.z, p.x, p.z, this.rng, used);
    if (!P) return false;
    this.perchAt = P;
    this.perchRef = refs[P.i];
    return true;
  }

  /** 0 approach (behind and above), 1 the last glide in (wings back, talons out), 2 standing, 3 off again. */
  private perch(dt: number): void {
    const P = this.perchAt!, R = this.rig, s = ROC_T.scale;
    if (!P || !this.perchRef) { this.startCircle(this.x, this.z); return; }
    const fx = Math.sin(P.yaw), fz = Math.cos(P.yaw);
    const standY = P.y + PERCH_HEIGHT * s;
    if (this.sub === 0) {
      // Round to a point behind the edge and above it, then in.
      const ax = P.x - fx * 70, az = P.z - fz * 70, ay = standY + 26;
      this.steer(dt, ax, ay, az, ROC_T.cruise * 0.8, ROC_T.turn * 1.5, false);
      const d = Math.hypot(ax - this.x, az - this.z);
      const facing = Math.abs(angleDiff(R.yaw, P.yaw));
      if ((d < 30 && facing < 1.2) || (d < 50 && this.actT > 18) || this.actT > 30) { this.sub = 1; this.actT = 0; }
    } else if (this.sub === 1) {
      const d = this.glideTo(dt, P.x, standY, P.z, 16, P.yaw);
      R.legs = clamp(1 - d / 40, 0, 1);
      R.beat = Math.max(R.beat, clamp(1 - d / 30, 0, 1));
      R.pitch += (0.35 * clamp(1 - d / 30, 0, 1) - R.pitch) * Math.min(1, dt * 3);
      R.tailSpread = 1;
      R.look = { x: P.x + fx * 30, y: P.y, z: P.z + fz * 30 };
      if (d < 1.2 || this.actT > 14) this.land();
    } else if (this.sub === 2) {
      // Standing on the edge, wings mantled over the street.
      R.x = P.x; R.z = P.z; R.y = standY;
      R.yaw += angleDiff(R.yaw, P.yaw) * Math.min(1, dt * 3);
      R.pitch += (0.1 - R.pitch) * Math.min(1, dt * 3); R.roll *= 1 - Math.min(1, dt * 3);
      R.perch = true;
      R.mantle = 1;
      R.tailPitch = -0.2;
      const foe = this.hostileTarget(60);
      R.look = foe ?? this.g.player.pos;
      this.gustT -= dt;
      if (this.gustT > 0) { R.mantle = 0.2; R.beat = 1; R.flap += dt * Math.PI * 2 * 1.1; }
      else { R.beat = 0; R.flap = 0; }
      if (this.cool.gust <= 0) this.gust(P.x, P.y, P.z);
      if (foe && this.cool.peck <= 0 && Math.hypot(foe.x - P.x, foe.z - P.z) < 14) this.peck(foe);
      if (!this.perchRef.alive || this.actT > this.stayFor || this.mode === 'retreat') this.startTakeoff();
    }
  }

  private land(): void {
    const g = this.g, P = this.perchAt!, R = this.rig;
    this.sub = 2; this.actT = 0;
    this.stats.perches++;
    this.usedPerch.add(this.perchRef!);
    this.stayFor = this.rng.range(ROC_T.perchT[0], ROC_T.perchT[1]);
    R.x = P.x; R.z = P.z; R.y = P.y + PERCH_HEIGHT * ROC_T.scale;
    this.speed = 0; this.vy = 0;
    // Its weight on the edge: the roof and the floor under it give.
    const E = stepEnergy(bodyMass(ROC_T.height, 0.6), ROC_T.height) * 2 * dealtBy(this);
    this.stats.crushed += g.interactions.steps.land(P.x, P.y, P.z, E, ROC_T.height, { cause: 'threat', own: false, sound: 'roc_flap', ref: 80, maxR: 400, foot: 5 });
    const ref = this.perchRef!;
    if (ref.top - ref.base < 40) g.destruction.as('threat', () => g.destruction.impact(P.x, P.y - 2, P.z, 6, 7e5 * dealtBy(this), 0, -1, 0, 'stomp'));
    this.cool.gust = 2; this.cool.screech = 0.8;
  }

  private startTakeoff(): void {
    const g = this.g, R = this.rig;
    this.setAct('takeoff');
    this.speed = 9; this.vy = 9;
    R.beat = 1;
    if (this.perchAt) {
      // (The push off the edge.)
      const P = this.perchAt;
      g.dust.burst(P.x, P.y + 0.5, P.z, 20, 8, 7, 3, 3, DUST, 0.2, 0.5);
      g.audio.play('roc_flap', P.x, P.y, P.z, 1, 0.8, 90, g.renderer.camera.position);
      this.knockAround(P.x, P.y, P.z, 18, 5);
    }
    this.perchAt = null;
  }

  private takeoff(dt: number): void {
    const R = this.rig, f = R.fwd;
    this.steer(dt, R.x + f.x * 100, R.y + 40, R.z + f.z * 100, ROC_T.cruise * 0.8, ROC_T.turn, false);
    R.beat = 1;
    if (this.actT > 3.5) { const p = this.g.player.pos; this.startCircle(p.x, p.z); }
  }

  // ---------------------------------------------------------------- snatching

  private findPrey(): boolean {
    const g = this.g, p = g.player.pos;
    const cars = g.traffic.vehicles;
    const view = cars.map((v) => ({ x: v.x, z: v.z, bus: v.kind === 'bus', ok: v.state === VState.Drive || v.state === VState.Stopped ? !this.covered(v.x, v.z) : false }));
    const i = pickPrey(view, p.x, p.z, ROC_T.preyR);
    if (i < 0) return false;
    this.prey = cars[i];
    return true;
  }

  /** Under a bridge or in a tunnel: nothing to stoop on. */
  private covered(x: number, z: number): boolean {
    const g = this.g, gy = g.world.groundHeight(x, z), deck = g.world.bridgeDeck(x, z);
    return isFinite(deck) && deck > gy + 3;
  }

  /** 0 over it, 1 the stoop (talons out). */
  private snatch(dt: number): void {
    const v = this.prey, R = this.rig;
    if (!v || v.state === VState.Crushed || v.state === VState.Wreck || this.actT > 30) { this.prey = null; this.startCircle(this.x, this.z); return; }
    const top = v.y + 3;
    if (this.sub === 0) {
      this.steer(dt, v.x, top + 35, v.z, ROC_T.cruise, ROC_T.turn * 1.4);
      if (Math.hypot(v.x - this.x, v.z - this.z) < 70) { this.sub = 1; this.actT = 0; }
    } else {
      // (The talons hang a body's height under its middle.)
      const hang = PERCH_HEIGHT * ROC_T.scale * 0.85;
      const d = this.glideTo(dt, v.x, top + hang, v.z, ROC_T.stoop);
      R.legs = clamp(1.4 - d / 30, 0, 1);
      R.mantle = 0.3; R.fold = clamp(d / 60 - 0.3, 0, 0.6);
      R.look = { x: v.x, y: v.y, z: v.z };
      if (d < 3) this.grab(v);
      else if (this.actT > 12) { this.prey = null; this.startTakeoff(); }
    }
  }

  private grab(v: Vehicle): void {
    const g = this.g;
    g.traffic.wreckIt(v);
    this.stats.snatches++;
    this.setAct('carry');
    this.stayFor = this.rng.range(ROC_T.carryT[0], ROC_T.carryT[1]);
    this.carryDir = this.rig.yaw + this.rng.range(-1, 1);
    g.audio.play('car_crash', v.x, v.y, v.z, 0.8, 1.1, 30, g.renderer.camera.position);
    g.stimuli.emit('roar', v.x, v.y, v.z, 7, 260, { cause: 'threat', size: this.height });
    for (const a of g.peds.neighbours(v.x, v.z, 8, [])) this.knock(a, v.x, v.z, 4);
    g.consequences.record('roc', 'car', 'wreck', v.x, v.z, v, 'threat');
    this.stats.wrecked++;
    g.future.drones.incident(DKind.News, v.x, v.z, g.player.pos.x, g.player.pos.z);
  }

  /** Up and away with it, then let go from high up. */
  private carry(dt: number): void {
    const v = this.prey, R = this.rig;
    if (!v) { this.startCircle(this.x, this.z); return; }
    const heavy = v.kind === 'bus' || v.kind === 'truck' ? 0.65 : 1;
    const tx = R.x + Math.sin(this.carryDir) * 100, tz = R.z + Math.cos(this.carryDir) * 100;
    this.steer(dt, tx, this.g.world.groundHeight(R.x, R.z) + ROC_T.carryAlt, tz, ROC_T.cruise * 0.7 * heavy, ROC_T.turn * 0.6);
    R.beat = 1; R.legs = 0.75; R.grip = 1;
    const T = R.talons(_w);
    v.x = T.x; v.z = T.z; v.y = T.y - 2.6; v.yaw = R.yaw;
    if (this.actT > this.stayFor) this.drop(true);
  }

  /** Lets the car go (thrown on with its speed when it means to). */
  private drop(meant: boolean): void {
    const v = this.prey, g = this.g, R = this.rig;
    this.prey = null;
    if (!v) return;
    const f = R.fwd, k = (meant ? 1 : 0.5) * dealtBy(this);
    const m = v.kind === 'bus' ? 4 : 1;
    g.vehicles.makeWreck(v, v.x, v.y + 1, v.z, f.x * 9000 * m * k, -2000 * m, f.z * 9000 * m * k);
    this.stats.drops++;
    g.audio.play('roc_screech', R.x, R.y, R.z, 0.7, 1.15, 160, g.renderer.camera.position);
    if (this.act === 'carry') this.startCircle(g.player.pos.x, g.player.pos.z);
  }

  // ---------------------------------------------------------------- stoops

  private dive(dt: number): void {
    const a = this.air, R = this.rig;
    if (!a || this.actT > 12) { this.air = null; this.startCircle(this.x, this.z); return; }
    const d = this.glideTo(dt, a.x, a.y, a.z, ROC_T.stoop + 4);
    R.legs = clamp(1.2 - d / 40, 0, 1); R.fold = clamp(d / 80, 0, 0.7);
    R.look = a;
    if (d < 9) {
      const l = Math.hypot(a.x - R.x, a.z - R.z) || 1;
      a.swat(((a.x - R.x) / l) * 1300, -500, ((a.z - R.z) / l) * 1300);
      this.stats.swats++; this.stats.dives++;
      this.g.audio.play('punch_impact', a.x, a.y, a.z, 1, 0.45, 40, this.g.renderer.camera.position);
      this.air = null;
      this.startTakeoff();
    }
  }

  /** A low pass at whoever hurt it most: in from above and behind, talons first, and away. */
  private swoop(dt: number): void {
    const R = this.rig;
    const foe = this.hostileTarget(500);
    if (!foe || this.actT > 16) { this.startCircle(this.x, this.z); return; }
    if (this.sub === 0) {
      const away = Math.atan2(R.x - foe.x, R.z - foe.z);
      const ax = foe.x + Math.sin(away) * 90, az = foe.z + Math.cos(away) * 90;
      this.steer(dt, ax, foe.y + 45, az, ROC_T.cruise, ROC_T.turn * 1.4);
      if (Math.hypot(ax - R.x, az - R.z) < 40 || this.actT > 7) { this.sub = 1; this.actT = 0; }
    } else {
      const hang = PERCH_HEIGHT * ROC_T.scale * 0.8;
      const d = this.glideTo(dt, foe.x, foe.y + hang, foe.z, ROC_T.stoop);
      R.legs = clamp(1.3 - d / 30, 0, 1);
      R.look = foe;
      if (d < 4) {
        this.stats.swoops++;
        this.hurtPlayerNear(foe.x, foe.y, foe.z, 6, 40, 16);
        for (const a of this.g.peds.neighbours(foe.x, foe.z, 7, [])) this.knock(a, R.x, R.z, 6);
        this.onBlow?.('swipe', foe.x, foe.y, foe.z, 7);
        this.g.audio.play('roc_screech', R.x, R.y, R.z, 0.9, 1.05, 160, this.g.renderer.camera.position);
        this.startTakeoff();
      }
    }
  }

  // ---------------------------------------------------------------- brought down

  private startGrounded(): void {
    const g = this.g;
    if (this.prey) this.drop(false);
    this.setAct('grounded');
    this.stats.grounded++;
    this.wind = 0;
    g.audio.play('roc_screech', this.x, this.y, this.z, 1, 0.85, 200, g.renderer.camera.position);
  }

  /** 0 tumbling down, 1 standing on the street (head low, open), then it labours back up. */
  private grounded(dt: number): void {
    const R = this.rig, g = this.g;
    if (this.sub === 0) {
      if (this.tumble(dt)) {
        this.sub = 1; this.actT = 0;
        const y = this.floor(R.x, R.z);
        g.interactions.steps.land(R.x, y, R.z, stepEnergy(bodyMass(ROC_T.height, 0.6), ROC_T.height) * 3 * dealtBy(this), ROC_T.height, { cause: 'threat', own: false, sound: 'step_giant', ref: 90, maxR: 400, foot: 7 });
        this.knockAround(R.x, y, R.z, 14, 6);
      }
      return;
    }
    const y = this.floor(R.x, R.z);
    R.y = y + PERCH_HEIGHT * ROC_T.scale;
    R.perch = true; R.mantle = 0.8; R.pitch += (0.05 - R.pitch) * Math.min(1, dt * 3); R.roll *= 1 - Math.min(1, dt * 4);
    R.gape = 0.5;
    const foe = this.hostileTarget(40);
    R.look = foe ?? g.player.pos;
    if (foe && this.cool.peck <= 0 && Math.hypot(foe.x - R.x, foe.z - R.z) < 14) this.peck(foe);
    // Tries the wings now and then.
    this.gustT -= dt;
    if (this.gustT > 0) { R.mantle = 0.1; R.beat = 1; R.flap += dt * Math.PI * 2; }
    else { R.beat = 0; R.flap = 0; R.fold = 0.3; } // (half folded, drooping; not the wings left mid-beat from the fall)
    if (this.cool.gust <= 0) this.gust(R.x, y, R.z);
    if (this.actT > ROC_T.groundT) { this.perchAt = null; this.startTakeoff(); }
  }

  /** Falling out of the sky (wings flailing, rolling over): true once it is down. */
  private tumble(dt: number): boolean {
    const R = this.rig;
    this.vy = Math.max(-28, this.vy - 12 * dt);
    this.speed *= Math.exp(-dt * 0.7);
    const f = R.fwd;
    R.x += f.x * this.speed * dt; R.z += f.z * this.speed * dt; R.y += this.vy * dt;
    R.roll += dt * 1.6 * Math.sin(this.t * 1.7); R.pitch += (-0.3 - R.pitch) * Math.min(1, dt);
    R.flail = 0.5 * Math.sin(this.t * 9); R.beat = 1; R.flap += dt * Math.PI * 2 * 1.6;
    const ground = this.floor(R.x, R.z) + PERCH_HEIGHT * ROC_T.scale * 0.9;
    if (R.y <= ground) { R.y = ground; this.vy = 0; this.speed = 0; R.roll = 0; return true; }
    return false;
  }

  // ---------------------------------------------------------------- leaving, dying

  private watch(): void {
    if (this.mode === 'retreat') return;
    if (this.hp < this.maxHp * ROC_T.retreatAt) { this.startLeaving(true); return; }
    if (this.t > ROC_T.visitMax) this.startLeaving(false);
  }

  private startLeaving(hurt: boolean): void {
    if (this.mode === 'retreat' || this.defeated) return;
    this.mode = 'retreat';
    if (hurt && this.topAggro()?.key === 'player') this.g.crime.reward({ karma: ROC_T.karma.retreat, why: 'drove the roc off', rep: 6, news: 'giant bird driven off' });
    if (this.act === 'circle' || this.act === 'arrive') this.startLeave();
  }

  private startLeave(): void {
    if (this.prey) this.drop(false);
    this.setAct('leave');
    const c = this.g.macro.centres[0];
    let dx = this.x - c.x, dz = this.z - c.z;
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    this.leaveAt = { x: this.x + dx * 2000, z: this.z + dz * 2000 };
  }

  private leave(dt: number): void {
    this.steer(dt, this.leaveAt.x, this.floor(this.x, this.z) + 160, this.leaveAt.z, ROC_T.cruise * 1.2);
    const cam = this.g.renderer.camera.position;
    if (this.actT > ROC_T.leaveT || Math.hypot(cam.x - this.x, cam.z - this.z) > 1300) this.finish('retreated');
  }

  private finish(o: ThreatOutcome): void {
    if (this.mode === 'gone') return;
    if (this.prey) this.drop(false);
    this.active = false;
    this.outcome = o;
    this.mode = 'gone';
  }

  private startDying(): void {
    if (this.defeated) return;
    const g = this.g;
    if (this.prey) this.drop(false);
    this.mode = 'dying';
    this.active = false;
    this.outcome = 'defeated';
    this.setAct('fall');
    g.audio.play('roc_screech', this.x, this.y, this.z, 1, 0.7, 220, g.renderer.camera.position);
    g.stimuli.emit('roar', this.x, this.y, this.z, 9, 650, { cause: 'threat', size: this.height });
    if (heroEarned(this.aggro)) g.crime.reward({ karma: ROC_T.karma.defeated, why: 'brought the roc down', rep: 12, news: 'giant bird brought down', stopped: true });
  }

  /** It falls out of the sky and crashes down; then it lies there. */
  private falling(dt: number): void {
    const R = this.rig, g = this.g;
    if (this.tumble(dt)) {
      const y = this.floor(R.x, R.z);
      g.interactions.steps.land(R.x, y, R.z, stepEnergy(bodyMass(ROC_T.height, 0.6), ROC_T.height) * 4, ROC_T.height, { cause: 'threat', own: false, sound: 'step_giant', ref: 110, maxR: 600, foot: 8 });
      this.knockAround(R.x, y, R.z, 16, 7);
      for (let i = 0; i < 12; i++) g.dust.burst(R.x + this.rng.range(-12, 12), y + 1, R.z + this.rng.range(-8, 8), 6, 2, 2, 1.2, 4, FEATHER, 0.05, 0.6);
      g.stimuli.emit('collapse', R.x, y, R.z, 8, 600, { cause: 'threat', size: this.height });
      this.onBlow?.('fall', R.x, y, R.z, 14);
      this.mode = 'dead';
      this.downAt = g.sky.hoursAbs;
    }
  }

  /** Lying on its side, wings spread on the ground. */
  private lie(dt: number): void {
    const R = this.rig;
    const y = this.floor(R.x, R.z);
    R.perch = false; R.mantle = 0; R.fold = 0; R.beat = 0; R.flail = 0; R.legs = 0.5; R.grip = 0.6; R.gape = 0.4; R.eyes = 0;
    R.look = null; R.tailSpread = 0.9;
    R.roll += (1.25 - R.roll) * Math.min(1, dt * 2);
    R.pitch += (-0.05 - R.pitch) * Math.min(1, dt * 2);
    R.y += (y + 2.6 * ROC_T.scale - R.y) * Math.min(1, dt * 3);
    R.still = true;
    R.place();
  }

  // ---------------------------------------------------------------- what it does to things

  private screech(dt: number): void {
    const R = this.rig, g = this.g;
    if (this.defeated) { R.eyes += (0 - R.eyes) * Math.min(1, dt * 2); return; }
    if (this.screechT > 0) {
      this.screechT -= dt;
      R.gape += (1 - R.gape) * Math.min(1, dt * 8);
      R.eyes += (1 - R.eyes) * Math.min(1, dt * 6);
    } else {
      R.gape += (0.05 - R.gape) * Math.min(1, dt * 4);
      R.eyes += (0.3 - R.eyes) * Math.min(1, dt * 2);
      if (this.cool.screech <= 0 && this.act !== 'fall' && this.act !== 'leave') this.startScreech();
    }
    this.zone('head').exposed = this.screechT > 0 || (this.act === 'grounded' && this.sub === 1);
  }

  private startScreech(): void {
    const g = this.g, h = this.headPos;
    this.screechT = 1.6;
    this.stats.screeches++;
    this.cool.screech = this.rng.range(ROC_T.screechGap[0], ROC_T.screechGap[1]);
    g.audio.play('roc_screech', h.x, h.y, h.z, 1, 0.95 + this.rng.range(0, 0.1), 260, g.renderer.camera.position);
    g.stimuli.emit('roar', h.x, h.y, h.z, 8, 600, { cause: 'threat', size: this.height });
    this.onBlow?.('roar', h.x, h.y, h.z, 240);
  }

  /** A wingbeat on a roof or the street: a gust that throws people down and things about. */
  private gust(x: number, y: number, z: number): void {
    const g = this.g, cam = g.renderer.camera.position;
    this.cool.gust = this.rng.range(ROC_T.gustGap[0], ROC_T.gustGap[1]);
    this.gustT = 1.6;
    this.stats.gusts++;
    g.audio.play('roc_flap', x, y, z, 1, 0.9 + this.rng.range(0, 0.15), 120, cam);
    const f = this.rig.fwd, R = ROC_T.gustR;
    // Down off the roof and out over the street in front of it.
    const gx = x + f.x * 14, gz = z + f.z * 14, gy = g.world.groundHeight(gx, gz);
    for (const [px, py, pz] of [[x, y, z], [gx, gy, gz]] as [number, number, number][]) {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        g.dust.burst(px + Math.cos(a) * 6, py + 0.5, pz + Math.sin(a) * 6, 4, 3, 9, 2.5, 2, DUST, 0.15, 0.3);
      }
      g.debris.vortex(px, py, pz, R * 0.6, 2, 6);
      g.props.hit(px, py + 1, pz, R * 0.5, f.x * 2.5e4, 1e4, f.z * 2.5e4);
    }
    this.knockAround(x, y, z, R * 0.6, 5);
    this.knockAround(gx, gy, gz, R, 4);
    this.hurtPlayerNear(gx, gy, gz, R, 8, 14);
    this.hurtPlayerNear(x, y, z, R * 0.6, 8, 14);
    const d = Math.hypot(g.player.pos.x - x, g.player.pos.z - z);
    if (d < 90) g.camRig.addShake(0.15 * (1 - d / 90));
  }

  /** A stab with the beak at someone close. */
  private peck(foe: { x: number; y: number; z: number }): void {
    this.cool.peck = this.rng.range(2.5, 4);
    this.stats.pecks++;
    this.hurtPlayerNear(foe.x, foe.y, foe.z, 4, 35, 10);
    for (const a of this.g.peds.neighbours(foe.x, foe.z, 4, [])) this.knock(a, this.x, this.z, 5);
    this.onBlow?.('swipe', foe.x, foe.y, foe.z, 5);
    this.g.audio.play('punch_impact', foe.x, foe.y, foe.z, 0.9, 0.6, 30, this.g.renderer.camera.position);
  }

  private knockAround(x: number, y: number, z: number, r: number, power: number): void {
    for (const a of this.g.peds.neighbours(x, z, r, [])) if (Math.abs(a.y - y) < 4) this.knock(a, x, z, power);
  }

  private knock(a: PedAgent, fx: number, fz: number, power: number): void {
    if (a.inside || a.state === PState.Down) return;
    this.g.reactions.knockDown(a, fx, fz, power * dealtBy(this), 'threat');
    this.g.consequences.record('roc', 'person', 'knockdown', a.x, a.z, a, 'threat');
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
    for (const d of g.future.drones.list) {
      if (!d.alive || d.state !== 0) continue;
      if (Math.hypot(d.x - x, d.y - y, d.z - z) < r) return { x: d.x, y: d.y, z: d.z, swat: (jx, jy, jz) => g.future.drones.knock(d, jx, jy, jz) };
    }
    for (const prov of this.airTargets) { const a = prov(x, y, z, r); if (a.length) return a[0]; }
    return null;
  }

  // ---------------------------------------------------------------- around it

  private surroundings(dt: number): void {
    const g = this.g;
    if (this.mode === 'gone' || this.defeated) return;
    this.stimT -= dt;
    if (this.stimT <= 0) {
      this.stimT = 1.2;
      const gy = g.world.groundHeight(this.x, this.z), low = this.y - gy < 45;
      g.stimuli.emit('threat', this.x, this.y, this.z, 6, low ? 160 : 90, { cause: 'threat' });
      // Drivers under a low pass or by its perch stop.
      if (low) for (const v of g.traffic.vehicles) if (v.state === VState.Drive && !v.task && Math.hypot(v.x - this.x, v.z - this.z) < 70) v.fear = Math.max(v.fear, 1);
    }
    this.newsT -= dt;
    if (this.newsT <= 0) { this.newsT = 40; g.future.drones.incident(DKind.News, this.x, this.z, g.player.pos.x, g.player.pos.z); }
  }

  /** The army's "route": from the centre's side to where it is. */
  private path(): void {
    const c = this.g.macro.centres[0];
    playerPath(this.route, c.x, c.z, this.x, this.z);
  }

  private updateZones(): void {
    const R = this.rig, C = R.caps;
    const set = (id: string, i: number) => { const Z = this.zone(id), c = C[i]; Z.x = (c.ax + c.bx) / 2; Z.y = (c.ay + c.by) / 2; Z.z = (c.az + c.bz) / 2; Z.r = c.r; };
    set('head', 3); set('body', 0); set('wing', 5); set('leg', 12);
    for (const Z of this.zones) if (Z.id !== 'head') Z.exposed = this.targetable;
  }

  // ================================================================== drawing, obstacles

  get visible(): boolean { return this.mode !== 'gone'; }

  draw(mesh: RocMesh): number { return this.visible ? mesh.draw(this.rig) : 0; }

  /** Standing on a roof or the street (or lying dead): in the player's way. */
  obstacles(x0: number, z0: number, x1: number, z1: number, out: (o: import('../../../world/Collision').Obstacle) => void): void {
    if (!this.standing) return;
    for (const c of this.rig.caps) {
      if (c.zone === 'wing' || c.zone === 'tail') continue;
      const mx = (c.ax + c.bx) / 2, mz = (c.az + c.bz) / 2, r = c.r * 0.9;
      if (mx + r < x0 || mx - r > x1 || mz + r < z0 || mz - r > z1) continue;
      out({ cyl: true, x: mx, z: mz, r, hx: 0, hz: 0, ux: 1, uz: 0, y0: Math.min(c.ay, c.by) - c.r, y1: Math.max(c.ay, c.by) + c.r });
    }
  }

  // ================================================================== dev

  /** Dev: it is already here, circling over the hero. */
  devNear(): string {
    const p = this.g.player.pos, R = this.rig;
    const a = this.rng.range(0, Math.PI * 2);
    R.x = p.x + Math.cos(a) * 110; R.z = p.z + Math.sin(a) * 110; R.y = this.floor(R.x, R.z) + 70;
    R.yaw = a + Math.PI / 2;
    this.speed = ROC_T.cruise;
    this.startCircle(p.x, p.z);
    return `circling ${Math.round(Math.hypot(R.x - p.x, R.z - p.z))} m from you`;
  }

  devPerch(): string { if (!this.targetable) return this.mode; if (!this.findPerch()) return 'no roof to perch on'; this.setAct('perch'); return `perching at ${Math.round(this.perchAt!.x)}, ${Math.round(this.perchAt!.z)} (${Math.round(this.perchAt!.y)} m up)`; }
  devSnatch(): string { if (!this.targetable) return this.mode; if (!this.findPrey()) return 'no car near'; this.setAct('snatch'); return `going for a ${this.prey!.kind}`; }
  devSwoop(): string { if (!this.targetable) return this.mode; bookAggro(this.aggro, 'player', Math.max(0, 500 - (this.aggro.get('player') ?? 0))); this.setAct('swoop'); return 'swooping at you'; }
  devDive(): string { const a = this.airNear(this.x, this.y, this.z, 2000); if (!a) return 'nothing flying'; this.air = a; this.setAct('dive'); return 'diving'; }
  devGround(): string { if (!this.flying) return 'not flying'; this.startGrounded(); return 'grounded'; }
  devLeave(): string { this.startLeaving(false); this.startLeave(); return this.mode; }
}

