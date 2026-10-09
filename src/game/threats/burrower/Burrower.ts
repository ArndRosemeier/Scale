/**
 * The Burrower (THREATS_PLAN §1 #3, Phase C): a 95 m worm that tunnels under the city towards
 * downtown and breaks out through the streets.
 *
 * Felt before it is seen: a rumble that follows the boulevards, cracks running along the asphalt,
 * people stopping to look down, the metro halted. Then the street ahead bulges, cracks and caves in
 * (Sinkholes) and a column of ringed, plated body rears out of the hole, three petals of the maw
 * opening on rows of teeth, an amber gullet, the pits along its flanks pulsing blue-white.
 *
 *   travel   under the streets along its route (burrowerRoute) at ~9 m/s, 18 m down: cracks and a
 *            rumble on the street above it, a tremor; it hunts whoever hurt it (a breach under them)
 *            and comes up where the hero is about.
 *   breach   the street bulges for a couple of seconds, then caves in: cars and people go down with
 *            it; the head bursts up and rears 26 m over the street, the body planted in its hole.
 *   up       14–22 s up there: it roars (the maw open: the weak spot exposed), slams its head down
 *            on whoever fights it (a landing at its size: cars flattened, people thrown, facades
 *            broken), snatches cars and flings them, bites into facades, snaps helicopters and drones
 *            out of the air near its head.
 *   dive     it arcs over and dives into the street 18–26 m on (a second hole) and the tail slides
 *            after it, then travels on to the next breach.
 *   seismic  a heavy landing (a super jump, a giant's stomp) over it while it is under the street
 *            drives it up: it breaks out stunned for 4 s with the maw hanging open.
 *
 * Downtown it breaks out beside the tall buildings for a few minutes, then leaves. Badly hurt (30 %)
 * it dives and tunnels away; brought down while it is up, the column topples onto the street and lies
 * there (the body stays a few game hours, then it is gone when nobody is looking).
 *
 * It is a ThreatActor (2600 points; zones maw, head, body, belly; the maw the weak spot while open),
 * only reachable while it is up (`actors` is empty under the street, `hidden` for the army: its units
 * hold their fire), and an ArmyFoe (the Guard and the army come along its route; no last resort).
 */
import * as THREE from 'three';
import type { Game } from '../../Game';
import { Rng } from '../../../core/rng';
import { PState, type PedAgent } from '../../../sim/Pedestrians';
import { VState, type Vehicle } from '../../../sim/Traffic';
import { DKind } from '../../../future/Drones';
import { dealtBy } from '../../../shared/status';
import { DecalKind } from '../../powers/ElementFx';
import { bodyMass, stepEnergy } from '../../GiantBody';
import { rayCapsule } from '../rig/CreatureRig';
import type { ThreatActor, ThreatEvent, ThreatOutcome, ThreatTarget, ThreatZone, DamageSource, DamageResult } from '../ThreatEvent';
import { DAMAGE_PER_IMPULSE } from '../ThreatEvent';
import type { Cause } from '../../Stimuli';
import type { BuildingRef } from '../../../world/WorldIndex';
import { angriestInReach } from '../../response/forces/BattleModel';
import type { AirProvider, AirTarget, StriderBlow } from '../Strider';
import { bookAggro, decayAggro, heroEarned, topAggro, zoneDealt } from '../aggro';
import { WormRig, WORM, wormRadius } from './wormRig';
import type { WormMesh } from './WormMesh';
import { planBurrowerRoute, type BurrowRoute } from './burrowerRoute';
import { routeAt, nearestS } from '../StriderRoute';
import { closestOnPoly } from '../../../core/geom2';
import { SINK, type Sinkholes } from './Sinkholes';

export const BURROWER = {
  hp: 2600,
  /** Its "height" for stomps and the con (m), and how high the head rears over the street. */
  height: 30, rear: 26,
  /** Under the street: depth (m), speed (m/s), turning (how fast its heading follows, 1/s). */
  depth: 18, speed: 9, steer: 1.6,
  /** A breach: the bulge (s), the hole's radius (m), rising (m/s), time up (s). */
  bulgeT: 2.4, holeR: [6.5, 8] as [number, number], rise: 16, upT: [14, 22] as [number, number],
  /** Where it dives back in (m from the hole) and the exit hole's radius. */
  diveAhead: [18, 26] as [number, number], diveR: [4.5, 5.5] as [number, number], diveT: 2.6,
  /** Its reach from the hole (m) and the gaps between blows (s). */
  reach: 34, strikeGap: [2.2, 4] as [number, number], roarGap: [9, 15] as [number, number],
  /** A breach near the hero: within this far of the head (m), at most this often (s). */
  nearHero: 45, nearGap: 25,
  /** Whoever hurt it most is hunted within this far (m). */
  huntR: 200,
  /** A heavy landing over it (stomp intensity ≥, within m of the head) breaks it out, stunned (s). */
  seismic: { intensity: 3.6, r: 30, stunT: 4 },
  weakMul: 4, staggerAt: 160,
  retreatAt: 0.3,
  /** Downtown: breaking out beside towers this long (s); a visit ends after visitMax (s). */
  rampageT: 240, visitMax: 780,
  /** Leaving: underground this long at most (s). */
  leaveT: 70,
  radius: 110,
  /** A body lying in the city stays at least this many game hours. */
  bodyHours: 6,
  karma: { weak: 2, retreat: 60, defeated: 120 },
};

/** Body zones (the army's battle model reads them too). */
export const BURROWER_ZONES: { id: string; name: string; armour: number; weak: boolean }[] = [
  { id: 'maw', name: 'Maw', armour: 0.55, weak: true },
  { id: 'head', name: 'Head', armour: 0.65, weak: false },
  { id: 'body', name: 'Armoured rings', armour: 0.88, weak: false },
  { id: 'belly', name: 'Underside', armour: 0.72, weak: false },
];

type Mode = 'advance' | 'rampage' | 'retreat' | 'dying' | 'dead' | 'gone';
type Phase = 'travel' | 'bulge' | 'breach' | 'up' | 'dive';
type Act = null | 'roar' | 'slam' | 'snatch' | 'bite' | 'swat' | 'stun' | 'flinch';

interface Site { x: number; z: number; r: number; depth: number; y: number }

let EVENT_ID = 4000;
const DUST = new THREE.Color(0.5, 0.46, 0.4);
const SOIL = new THREE.Color(0.28, 0.2, 0.13);
const _v = new THREE.Vector3();
const _rp = { x: 0, z: 0, dx: 0, dz: 1 };

export class Burrower implements ThreatEvent, ThreatActor {
  readonly id = EVENT_ID++;
  readonly archetype = 'burrower';
  readonly tier = 'major';
  readonly engageOnFoot = false;
  /** No last resort for it (it is under the street half the time). */
  readonly ceiling = 4;
  readonly name = 'Giant worm';
  readonly radius = BURROWER.radius;
  readonly size = WORM.joints * WORM.seg;
  readonly height = BURROWER.height;
  readonly maxHp = BURROWER.hp;
  hp = BURROWER.hp;
  x = 0; y = 0; z = 0;
  t = 0;
  active = true;
  outcome: ThreatOutcome | null = null;
  hurt = 0;
  readonly rig: WormRig;
  readonly route: BurrowRoute;
  readonly zones: ThreatZone[];
  readonly aggro = new Map<string, number>();
  mode: Mode = 'advance';
  phase: Phase = 'travel';
  act: Act = null;
  /** Progress along the route (m) of the point nearest the head. */
  s = 0;
  /** A body lying in the city: when it came down (absolute game hours). */
  downAt = -1;
  airTargets: AirProvider[] = [];
  unitAt: ((key: string) => { x: number; y: number; z: number } | null) | null = null;
  keyAt: ((key: string) => { x: number; y: number; z: number } | null) | null = null;
  onBlow: ((kind: StriderBlow, x: number, y: number, z: number, r: number) => void) | null = null;
  readonly stats = {
    breaches: 0, dives: 0, slams: 0, snatches: 0, bites: 0, roars: 0, swats: 0, seismic: 0, stuns: 0, flinches: 0,
    damage: 0, weakHits: 0, wrecked: 0, knocked: 0, broken: 0, playerHits: 0, travelled: 0, skipped: 0,
  };
  private rng: Rng;
  private actT = 0;
  private phaseT = 0;
  private upFor = 0;
  private nextBreach = 0;
  private site: Site | null = null;
  /** The hole it stands in (up) and the one it dives for. */
  private hole: Site | null = null;
  private exit: Site | null = null;
  private diveP0 = new THREE.Vector3();
  private diveP1 = new THREE.Vector3();
  private exitOpened = false;
  /** Underground: heading (unit), the goal it steers for. */
  private head = new THREE.Vector3();
  private heading = new THREE.Vector3(0, 0, -1);
  private goal = { x: 0, z: 0 };
  /** Up: what it looks at / strikes (world), the act's start position. */
  private focus = new THREE.Vector3();
  private target = new THREE.Vector3();
  private targetCar: Vehicle | null = null;
  private targetRef: BuildingRef | null = null;
  private swatT: AirTarget | null = null;
  private hit = false;
  private cool = { strike: 0, roar: 0, swat: 0 };
  private recentHit = 0;
  private lastBreachT = -99;
  private stunned = false;
  private rampT = 0;
  private rampDone = new Set<BuildingRef>();
  private leaveT = 0;
  private dieT = 0;
  private fallTo = new THREE.Vector3();
  private fallDir = new THREE.Vector3();
  private crackT = 0;
  private crackX = 0;
  private crackZ = 0;
  private stimT = 0;
  private newsT = 8;
  private seqSeen = 0;
  private upCheckT = 0;
  private anyUp = false;
  private rumble: { set(x: number, y: number, z: number, gain: number, rate?: number): void; stop(): void } | null = null;
  private exposedMaw = false;

  constructor(private g: Game, private holes: Sinkholes, seed: number, opts: { at?: { x: number; z: number }; toward?: { x: number; z: number } } = {}) {
    this.rng = new Rng(seed);
    const route = planBurrowerRoute(g.macro, seed, opts.toward ?? { x: g.player.pos.x, z: g.player.pos.z });
    if (!route) throw new Error('burrower: no way under the city');
    this.route = route;
    this.zones = BURROWER_ZONES.map((z) => ({ ...z, exposed: false, x: 0, y: 0, z: 0, r: 4, recent: 0 }));
    const rig = new WormRig(1);
    rig.ground = (x, z) => this.ground(x, z);
    this.rig = rig;
    // It sets off deep under its entry, heading along the way.
    const x0 = route.pts[0], z0 = route.pts[1], x1 = route.pts[4] ?? route.pts[2], z1 = route.pts[5] ?? route.pts[3];
    const y0 = this.ground(x0, z0) - BURROWER.depth;
    this.head.set(x0, y0, z0);
    this.heading.set(x1 - x0, 0, z1 - z0).normalize();
    rig.reset(x0, y0, z0, this.heading.x, this.heading.y, this.heading.z);
    this.x = x0; this.y = y0; this.z = z0;
    this.cool.roar = 0;
    this.seqSeen = g.stimuli.seq;
    this.updateZones();
  }

  // ================================================================== ThreatActor / ArmyFoe

  get defeated(): boolean { return this.mode === 'dying' || this.mode === 'dead'; }
  /** Out of the street: something to hit (the head, the column). */
  get surfaced(): boolean { return this.phase === 'up' || (this.phase === 'breach' && !!this.rig.anchor) || (this.phase === 'dive' && this.phaseT < BURROWER.diveT * 0.7) || this.mode === 'dying'; }
  get targetable(): boolean { return this.mode !== 'gone' && this.mode !== 'dead' && this.mode !== 'dying'; }
  /** Under the street: the army holds its fire (Forces), nothing reaches it. */
  get hidden(): boolean { return !this.surfaced; }
  get actors(): ThreatActor[] { return this.surfaced && this.targetable ? [this] : []; }
  get headPos(): { x: number; y: number; z: number } { return this.rig.head; }
  get title(): string { return this.defeated ? 'Fallen worm' : this.surfaced ? 'Giant worm — stay clear or fight it' : 'Giant worm — tunnelling under the streets'; }

  zone(id: string): ThreatZone { return this.zones.find((z) => z.id === id) ?? this.zones[2]; }

  /** The zone at a point on capsule i: the maw at the front of the head, the underside below the axis. */
  private zoneOfHit(i: number, x: number, y: number, z: number): ThreatZone {
    const rig = this.rig;
    if (i === 0) {
      const m = rig.mouth();
      if (Math.hypot(x - m.x, y - m.y, z - m.z) < WORM.lip * 1.4 * rig.scale && rig.petal > 0.4) return this.zone('maw');
      return this.zone('head');
    }
    const c = rig.caps[i];
    const U = rig.up;
    const mx = (c.ax + c.bx) / 2, my = (c.ay + c.by) / 2, mz = (c.az + c.bz) / 2;
    const below = -((x - mx) * U[i * 3] + (y - my) * U[i * 3 + 1] + (z - mz) * U[i * 3 + 2]);
    return below > c.r * 0.35 ? this.zone('belly') : this.zone('body');
  }

  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): { t: number; zone: ThreatZone } | null {
    if (!this.surfaced && this.mode !== 'dead') return null;
    let best = maxT, bi = -1;
    const caps = this.rig.caps;
    for (let i = 0; i < caps.length - 1; i++) {
      const t = rayCapsule(ox, oy, oz, dx, dy, dz, caps[i], best);
      if (t < best) { best = t; bi = i; }
    }
    if (bi < 0) return null;
    return { t: best, zone: this.zoneOfHit(bi, ox + dx * best, oy + dy * best, oz + dz * best) };
  }

  zoneAt(x: number, y: number, z: number): { zone: ThreatZone; d: number } | null {
    if (!this.surfaced && this.mode !== 'dead') return null;
    const n = this.rig.nearest(x, y, z);
    return n ? { zone: this.zoneOfHit(n.i, x, y, z), d: n.d } : null;
  }

  damage(zone: ThreatZone | string | null, amount: number, src: DamageSource): DamageResult {
    if (this.defeated || this.mode === 'gone' || amount <= 0 || !this.surfaced) return { dealt: 0, zone: null, weak: false };
    let Z: ThreatZone;
    if (typeof zone === 'string') Z = this.zone(zone);
    else if (zone) Z = zone;
    else Z = (src.x !== undefined ? this.zoneAt(src.x, src.y ?? this.y, src.z ?? this.z)?.zone : null) ?? this.zone('body');
    const weak = Z.weak && Z.exposed;
    const dealt = zoneDealt(amount, Z.armour, weak, BURROWER.weakMul);
    this.hp = Math.max(0, this.hp - dealt);
    Z.recent += dealt;
    this.recentHit += dealt;
    this.stats.damage += dealt;
    if (weak) this.stats.weakHits++;
    bookAggro(this.aggro, src.key ?? src.cause, dealt + amount * 0.02 + (src.aggro ?? 0));
    if (src.cause === 'player' && weak && dealt > 20) this.g.progress.addKarma(BURROWER.karma.weak, 'hit the worm where it hurts');
    this.react(dealt, weak, src);
    return { dealt, zone: Z, weak };
  }

  blow(x: number, y: number, z: number, r: number, jx: number, jy: number, jz: number, src: DamageSource): DamageResult | null {
    if (!this.surfaced || !this.targetable) return null;
    const n = this.rig.nearest(x, y, z);
    if (!n || n.d > r + 0.5) return null;
    return this.damage(this.zoneOfHit(n.i, x, y, z), Math.hypot(jx, jy, jz) * DAMAGE_PER_IMPULSE, { ...src, x: src.x ?? x, y: src.y ?? y, z: src.z ?? z });
  }

  conStrength(): number { return 240 * Math.sqrt(Math.max(0.05, this.hp / this.maxHp)); }
  topAggro(): { key: string; v: number } | null { return topAggro(this.aggro); }

  // ================================================================== ThreatEvent

  strength(): number { return this.active ? this.hp / this.maxHp : 0; }
  targetsNear(_x: number, _z: number, _r: number): ThreatTarget[] { return []; }
  strike(_t: ThreatTarget, _jx: number, _jy: number, _jz: number, _cause: Cause): void { /* nothing on foot reaches it */ }

  /** The response gives up: it tunnels away. */
  shutdown(): void { if (this.mode === 'advance' || this.mode === 'rampage') this.startLeaving(false); }

  dispose(): void { this.rumble?.stop(); this.rumble = null; }

  snapshot(): Record<string, unknown> {
    return {
      id: this.id, archetype: this.archetype, t: +this.t.toFixed(1), active: this.active, outcome: this.outcome, mode: this.mode, phase: this.phase, act: this.act,
      x: Math.round(this.x), y: Math.round(this.y), z: Math.round(this.z), head: { x: Math.round(this.rig.head.x), y: Math.round(this.rig.head.y), z: Math.round(this.rig.head.z) },
      hp: Math.round(this.hp), s: Math.round(this.s), route: Math.round(this.route.length), breachesPlanned: this.route.breaches.map(Math.round), next: this.nextBreach,
      hole: this.hole ? { x: Math.round(this.hole.x), z: Math.round(this.hole.z), r: +this.hole.r.toFixed(1) } : null, surfaced: this.surfaced,
      exposed: Math.round(this.rig.exposed()), aggro: Object.fromEntries([...this.aggro].map(([k, v]) => [k, Math.round(v)])), hurt: this.hurt, ...this.stats,
    };
  }

  // ================================================================== frame

  update(dt: number): void {
    this.t += dt;
    if (this.mode === 'gone') return;
    const rig = this.rig;
    decayAggro(this.aggro, dt, 90);
    for (const Z of this.zones) Z.recent *= Math.exp(-dt / 4);
    this.recentHit *= Math.exp(-dt / 2);
    for (const k of Object.keys(this.cool) as (keyof Burrower['cool'])[]) this.cool[k] -= dt;
    rig.t += dt;
    rig.holes = this.holes.list.filter((h) => Math.hypot(h.x - rig.head.x, h.z - rig.head.z) < 160);
    if (this.mode === 'dead') { this.lying(dt); return; }
    if (this.mode === 'dying') this.dying(dt);
    else {
      if (this.hp <= 0 && this.surfaced) { this.startDying(); return; }
      this.watch(dt);
      this.phaseT += dt;
      switch (this.phase) {
        case 'travel': this.travel(dt); break;
        case 'bulge': this.bulge(dt); break;
        case 'breach': this.breach(dt); break;
        case 'up': this.up(dt); break;
        case 'dive': this.dive(dt); break;
      }
    }
    rig.place();
    this.glows(dt);
    this.centre();
    this.updateZones();
    this.surroundings(dt);
  }

  /** Street (and sinkhole) height at a point. */
  private ground(x: number, z: number): number { return this.g.terrain.height(x, z) + this.g.world.surfaceOffset(x, z); }

  /** Its centre for the map, the army and the response: the column while up, the head under the street. */
  private centre(): void {
    const rig = this.rig;
    if (this.surfaced || this.defeated) {
      const J = rig.j, i = this.mode === 'dead' || this.mode === 'dying' ? 4 : 2;
      this.x = J[i * 3]; this.y = J[i * 3 + 1]; this.z = J[i * 3 + 2];
    } else { this.x = rig.head.x; this.y = rig.head.y; this.z = rig.head.z; }
  }

  // ---------------------------------------------------------------- under the street

  /** The goal under the street: whoever it hunts, a tower downtown, the route ahead, or the way out. */
  private pickGoal(): { hunt: boolean } {
    const g = this.g, h = this.rig.head;
    if (this.mode === 'retreat') { this.goal.x = this.route.start.x; this.goal.z = this.route.start.z; return { hunt: false }; }
    const hostile = this.hostileTarget(BURROWER.huntR);
    if (hostile && this.t - this.lastBreachT > 8) { this.goal.x = hostile.x; this.goal.z = hostile.z; return { hunt: true }; }
    if (this.mode === 'rampage') {
      if (!this.site || this.phaseT > 40) this.site = this.towerSite();
      if (this.site) { this.goal.x = this.site.x; this.goal.z = this.site.z; return { hunt: false }; }
      const E = this.route.end, a = this.t * 0.07;
      this.goal.x = E.x + Math.cos(a) * 90; this.goal.z = E.z + Math.sin(a) * 90;
      return { hunt: false };
    }
    this.s = nearestS(this.route, h.x, h.z, this.s, 80);
    let p = routeAt(this.route, Math.min(this.route.length, this.s + 24), _rp);
    // Far off its line (dragged up beside the hero, a long chase): pick it up wherever it is nearest.
    if (Math.hypot(p.x - h.x, p.z - h.z) > 120) {
      this.s = nearestS(this.route, h.x, h.z, this.s, 1e6);
      while (this.nextBreach < this.route.breaches.length && this.route.breaches[this.nextBreach] < this.s) this.nextBreach++;
      p = routeAt(this.route, Math.min(this.route.length, this.s + 24), _rp);
    }
    this.goal.x = p.x; this.goal.z = p.z;
    void g;
    return { hunt: false };
  }

  private travel(dt: number): void {
    const g = this.g, rig = this.rig, h = this.head;
    const { hunt } = this.pickGoal();
    // Steer: towards the goal at its depth (down a slope after a dive).
    const gy = this.ground(this.goal.x, this.goal.z) - BURROWER.depth;
    _v.set(this.goal.x - h.x, gy - h.y, this.goal.z - h.z);
    const dist = Math.hypot(_v.x, _v.z);
    _v.y = Math.max(-0.7 * dist - 2, Math.min(0.5 * dist, _v.y));
    _v.normalize();
    this.heading.lerp(_v, Math.min(1, dt * BURROWER.steer)).normalize();
    const pace = BURROWER.speed * (this.mode === 'retreat' ? 1.25 : 1) * (0.6 + 0.4 * Math.max(0.3, this.hp / this.maxHp));
    h.addScaledVector(this.heading, pace * dt);
    rig.setDir(this.heading.x, this.heading.y, this.heading.z);
    rig.moveHead(h.x, h.y, h.z);
    this.stats.travelled += pace * dt;
    if (this.mode === 'retreat') {
      this.leaveT += dt;
      if (dist < 40 || this.leaveT > BURROWER.leaveT) this.finish('retreated');
      return;
    }
    // Into downtown.
    if (this.mode === 'advance' && this.s >= this.route.length - 15) { this.mode = 'rampage'; this.rampT = 0; this.site = null; }
    // Up through the street: under whoever it hunts, beside the hero, at a planned spot, at a tower.
    if (this.phaseT < 3) return;
    const P = g.player.pos;
    let at: { x: number; z: number } | null = null;
    if (hunt && dist < 14) at = { x: this.goal.x, z: this.goal.z };
    else if (this.t - this.lastBreachT > BURROWER.nearGap && Math.hypot(P.x - h.x, P.z - h.z) < BURROWER.nearHero && !g.underground.feetUnder(P.x, P.y, P.z)) at = { x: P.x + (h.x - P.x) * 0.3, z: P.z + (h.z - P.z) * 0.3 };
    else if (this.mode === 'advance' && this.nextBreach < this.route.breaches.length && this.s >= this.route.breaches[this.nextBreach]) { this.nextBreach++; at = { x: h.x, z: h.z }; }
    else if (this.mode === 'rampage' && this.site && dist < 10) at = { x: this.site.x, z: this.site.z };
    if (at) {
      const site = this.findSite(at.x, at.z, this.rng.range(BURROWER.holeR[0], BURROWER.holeR[1]));
      if (site) this.startBulge(site);
      else { this.stats.skipped++; if (this.mode === 'rampage') this.site = null; }
    }
    // A heavy landing over it: up it comes, stunned.
    this.seismicCheck();
  }

  /** Heavy landings near its head since the last look (super-jump landings, a giant's stomps). */
  private seismicCheck(): void {
    const g = this.g, h = this.rig.head;
    for (const s of g.stimuli.recent) {
      if (s.seq <= this.seqSeen) continue;
      this.seqSeen = s.seq;
      if (s.kind !== 'stomp' && s.kind !== 'blast') continue;
      if (s.cause !== 'player' || s.intensity < BURROWER.seismic.intensity) continue;
      if (Math.hypot(s.x - h.x, s.z - h.z) > BURROWER.seismic.r) continue;
      if (this.phase !== 'travel') continue;
      const site = this.findSite(h.x * 0.5 + s.x * 0.5, h.z * 0.5 + s.z * 0.5, BURROWER.holeR[0]);
      if (!site) continue;
      this.stats.seismic++;
      this.stunned = true;
      bookAggro(this.aggro, 'player', 60);
      this.startBulge(site, 0.8);
      return;
    }
    this.seqSeen = g.stimuli.seq;
  }

  /** A spot near (x, z) where the street can cave in (searched outwards), or null. */
  private findSite(x: number, z: number, r: number): Site | null {
    // The first deep enough spot; failing that the deepest shallow one (a sewer under the street).
    const H = this.holes;
    let best: ReturnType<Sinkholes['site']> = null;
    for (const [dx, dz] of [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8], [14, 10], [-14, -10], [10, -14], [-10, 14], [22, 0], [-22, 0], [0, 22], [0, -22]]) {
      const s = H.site(x + dx, z + dz, r);
      if (s && (!best || s.depth > best.depth)) best = s;
      if (best && best.depth >= SINK.deep) break;
    }
    return best && { ...best, y: this.ground(best.x, best.z) };
  }

  private startBulge(site: Site, quick = 1): void {
    this.site = site;
    this.phase = 'bulge';
    this.phaseT = 0;
    this.bulgeFor = BURROWER.bulgeT * quick;
    this.lastBreachT = this.t;
    const g = this.g;
    g.elements.fx.decal(DecalKind.Crack, site.x, site.y + 0.05, site.z, 0, 1, 0, site.r * 2.2, site.r * 2.2, this.rng.range(0, 6), 120);
    g.audio.play('tremor_rumble', site.x, site.y, site.z, 1, 0.7, 60, g.renderer.camera.position);
    g.stimuli.emit('tremor', site.x, site.y, site.z, 6, 300, { cause: 'threat', size: this.height });
  }
  private bulgeFor = BURROWER.bulgeT;

  /** The street over it heaves: it comes up under the site, the ground shakes and cracks. */
  private bulge(dt: number): void {
    const g = this.g, S = this.site!, rig = this.rig, h = this.head;
    const tx = S.x, ty = S.y - 7, tz = S.z;
    _v.set(tx - h.x, ty - h.y, tz - h.z);
    const d = _v.length();
    if (d > 0.5) {
      _v.normalize();
      this.heading.lerp(_v, Math.min(1, dt * 3)).normalize();
      h.addScaledVector(this.heading, Math.min(d, BURROWER.speed * 1.4 * dt));
      rig.setDir(this.heading.x, this.heading.y, this.heading.z);
      rig.moveHead(h.x, h.y, h.z);
    }
    // Dust jets and grit from the cracks; the camera shakes near it.
    if (Math.random() < dt * 6) {
      const a = Math.random() * Math.PI * 2, r = S.r * (0.4 + Math.random() * 0.8);
      g.dust.burst(S.x + Math.cos(a) * r, S.y + 0.2, S.z + Math.sin(a) * r, 5, 1, 3, 1.5, 2.5, DUST, 0.2, 0.5);
    }
    const pd = Math.hypot(g.player.pos.x - S.x, g.player.pos.z - S.z);
    if (pd < 120) g.camRig.addShake(dt * 0.9 * (1 - pd / 120));
    if (this.phaseT >= this.bulgeFor && d < 6) this.startBreach();
    else if (this.phaseT > this.bulgeFor + 4) this.startBreach();
  }

  private startBreach(): void {
    const S = this.site!;
    this.holes.open(S, (this.rng.float() * 2 ** 32) >>> 0);
    this.hole = S;
    this.site = null;
    this.phase = 'breach';
    this.phaseT = 0;
    this.stats.breaches++;
    // Straight up through the hole's middle.
    const h = this.head;
    h.x = S.x; h.z = S.z;
    this.heading.set(0, 1, 0);
    this.rig.setDir(0, 1, 0);
    this.rig.moveHead(h.x, h.y, h.z);
    const g = this.g;
    this.onBlow?.('fall', S.x, S.y, S.z, S.r + 4);
    // People near the hole run.
    g.stimuli.emit('roar', S.x, S.y, S.z, 8, 400, { cause: 'threat', size: this.height });
  }

  /** Bursting up out of the hole, the head rising to where it rears. */
  private breach(dt: number): void {
    const g = this.g, S = this.hole!, rig = this.rig, h = this.head;
    h.y += BURROWER.rise * dt * (rig.anchor ? 0.8 : 1.2);
    if (!rig.anchor) {
      rig.setDir(0, 1, 0);
      rig.moveHead(S.x, h.y, S.z);
      if (h.y >= S.y - 1.5) {
        rig.anchorAt(S.x, S.y - 2.5, S.z);
        // Soil and asphalt thrown up round it.
        for (let i = 0; i < 14; i++) {
          const a = Math.random() * Math.PI * 2;
          g.elements.fx.soft(S.x + Math.cos(a) * 3, S.y + 1, S.z + Math.sin(a) * 3, Math.cos(a) * 9, 12 + Math.random() * 10, Math.sin(a) * 9, 1.4, 1.2, 2.5, SOIL, DUST, 0.7, 0.4, 9.8);
        }
        g.dust.burst(S.x, S.y + 2, S.z, 24, S.r, 8, 5, 4.5, DUST, 0.45, 0.45);
        const pd = Math.hypot(g.player.pos.x - S.x, g.player.pos.z - S.z);
        if (pd < 220) g.camRig.addShake(0.7 * (1 - pd / 220));
        this.hurtPlayerNear(S.x, S.z, S.r + 2, 30, 10);
      }
      return;
    }
    // Rearing up: the head arches over towards whatever it attends to.
    this.chooseFocus();
    const top = S.y + BURROWER.rear * rig.scale;
    const fx = this.focus.x - S.x, fz = this.focus.z - S.z, fl = Math.hypot(fx, fz) || 1;
    rig.head.y = Math.min(top, h.y);
    rig.head.x += (S.x + (fx / fl) * 4 - rig.head.x) * Math.min(1, dt * 2);
    rig.head.z += (S.z + (fz / fl) * 4 - rig.head.z) * Math.min(1, dt * 2);
    const up = Math.max(0, 1 - (h.y - S.y) / (BURROWER.rear * rig.scale));
    rig.setDir(fx / fl * (1 - up), Math.max(-0.2, up * 1.5 - 0.15), fz / fl * (1 - up));
    rig.moveHead(rig.head.x, rig.head.y, rig.head.z);
    if (h.y >= top) {
      h.set(rig.head.x, rig.head.y, rig.head.z);
      this.phase = 'up';
      this.phaseT = 0;
      this.upFor = this.rng.range(BURROWER.upT[0], BURROWER.upT[1]) * (this.mode === 'rampage' ? 1.25 : 1);
      if (this.stunned) { this.stunned = false; this.begin('stun', BURROWER.seismic.stunT); this.stats.stuns++; }
      else this.startRoar();
    }
  }

  // ---------------------------------------------------------------- up out of the hole

  private begin(a: Act, dur: number): void { this.act = a; this.actT = dur; this.hit = false; }

  /** What it attends to up there: whoever it hates most in reach, the hero near, a tower, else ahead. */
  private chooseFocus(): void {
    const S = this.hole!, P = this.g.player.pos;
    const hostile = this.hostileTarget(BURROWER.reach * 2.5);
    if (hostile) { this.focus.set(hostile.x, hostile.y, hostile.z); return; }
    if (Math.hypot(P.x - S.x, P.z - S.z) < 120) { this.focus.set(P.x, P.y + 1, P.z); return; }
    const p = routeAt(this.route, Math.min(this.route.length, this.s + 40), _rp);
    this.focus.set(p.x, S.y + 10, p.z);
  }

  private up(dt: number): void {
    const S = this.hole!, rig = this.rig, g = this.g;
    if (!this.act) {
      this.chooseFocus();
      if ((this.phaseT > this.upFor || this.mode === 'retreat') && this.startDive()) return;
      this.decide();
    }
    // The pose: idle sway over the hole, rearing for a roar, a strike down at its target.
    const sc = rig.scale, top = S.y + BURROWER.rear * sc;
    const fx = this.focus.x - S.x, fz = this.focus.z - S.z, fl = Math.hypot(fx, fz) || 1, ux = fx / fl, uz = fz / fl;
    let px = S.x + ux * 6 * sc + Math.sin(this.t * 0.7) * 3 * -uz, py = top + Math.sin(this.t * 1.1) * 1.5, pz = S.z + uz * 6 * sc + Math.sin(this.t * 0.7) * 3 * ux;
    let dx = this.focus.x - px, dy = this.focus.y - py, dz = this.focus.z - pz;
    let rate = 2.5;
    let petal = 0.15 + 0.1 * Math.sin(this.t * 2.3);
    if (this.act) this.actT -= dt;
    switch (this.act) {
      case 'roar': {
        px -= ux * 4; pz -= uz * 4; py += 4; dy = Math.abs(fl) * 0.9 + 10;
        petal = 1.1;
        rate = 3;
        if (this.actT <= 0) this.act = null;
        break;
      }
      case 'stun': {
        // Sagging, swaying, the maw hanging open.
        py = S.y + 11 * sc + Math.sin(this.t * 0.9) * 1.5; px = S.x + ux * 9 * sc; pz = S.z + uz * 9 * sc;
        dy = -fl * 0.6 - 10;
        petal = 0.85;
        rate = 1.5;
        if (this.actT <= 0) { this.act = null; this.startRoar(); }
        break;
      }
      case 'flinch': {
        px -= ux * 5; pz -= uz * 5; py += 2; petal = 0.7; rate = 6;
        if (this.actT <= 0) this.act = null;
        break;
      }
      case 'swat': {
        const a = this.swatT;
        if (a) { px = a.x - (a.x - S.x) * 0.15; py = a.y - 2; pz = a.z - (a.z - S.z) * 0.15; dx = a.x - px; dy = a.y - py; dz = a.z - pz; rate = 7; petal = 1; }
        if (a && this.actT < 0.4 && !this.hit) {
          this.hit = true;
          const h = rig.head, l = Math.hypot(a.x - h.x, a.y - h.y, a.z - h.z) || 1;
          a.swat(((a.x - h.x) / l) * 900, ((a.y - h.y) / l) * 400 - 300, ((a.z - h.z) / l) * 900);
          this.stats.swats++;
          g.audio.play('punch_impact', a.x, a.y, a.z, 1, 0.45, 30, g.renderer.camera.position);
          this.swatT = null;
        }
        if (this.actT <= 0) this.act = null;
        break;
      }
      case 'slam': case 'snatch': case 'bite': {
        // Wind up (rear back), strike (fast, down at the target), hold, back up.
        const T = this.act === 'bite' ? 2.2 : 2.6, k = 1 - this.actT / T;
        const tx = this.target.x, ty = this.target.y, tz = this.target.z;
        if (this.act === 'snatch' && this.targetCar) { this.target.set(this.targetCar.x, this.targetCar.y + 1, this.targetCar.z); }
        if (k < 0.35) { px -= ux * 7 * sc; pz -= uz * 7 * sc; py += 5 * sc; dx = tx - px; dy = ty - py; dz = tz - pz; rate = 3; petal = 0.5; }
        else if (k < 0.55) {
          // The strike: the head driven at the target (stopping short by its own radius).
          const hx = rig.head.x, hz = rig.head.z;
          const bx = tx - hx, bz = tz - hz, bl = Math.hypot(bx, bz) || 1;
          px = tx - (bx / bl) * 2.5; py = ty + (this.act === 'bite' ? 0 : 3.2 * sc); pz = tz - (bz / bl) * 2.5;
          dx = bx; dy = ty - rig.head.y; dz = bz;
          rate = 11; petal = this.act === 'slam' ? 0.2 : 1.1;
          if (!this.hit && Math.hypot(rig.head.x - px, rig.head.y - py, rig.head.z - pz) < 3.5 * sc) this.impact();
        } else if (k < 0.7) { px = rig.head.x; py = rig.head.y; pz = rig.head.z; rate = 0; petal = this.act === 'slam' ? 0.3 : 0.6; if (!this.hit) this.impact(); }
        else { rate = 2.2; petal = 0.3; }
        if (this.actT <= 0) { this.act = null; this.targetCar = null; this.targetRef = null; this.cool.strike = this.rng.range(BURROWER.strikeGap[0], BURROWER.strikeGap[1]); }
        break;
      }
      default: break;
    }
    // Keep the head within its reach of the hole.
    const ox = px - S.x, oz = pz - S.z, ol = Math.hypot(ox, oz), maxR = BURROWER.reach * sc;
    if (ol > maxR) { px = S.x + (ox / ol) * maxR; pz = S.z + (oz / ol) * maxR; }
    py = Math.max(py, S.y + 2.5 * sc);
    const k = Math.min(1, dt * rate);
    const H = rig.head;
    rig.moveHead(H.x + (px - H.x) * k, H.y + (py - H.y) * k, H.z + (pz - H.z) * k);
    const dl = Math.hypot(dx, dy, dz) || 1, D = rig.dir;
    const kd = Math.min(1, dt * Math.max(2, rate));
    rig.setDir(D.x + (dx / dl - D.x) * kd, D.y + (dy / dl - D.y) * kd, D.z + (dz / dl - D.z) * kd);
    rig.petal += (petal - rig.petal) * Math.min(1, dt * 5);
    this.head.set(H.x, H.y, H.z);
  }

  /** Its next move up there. */
  private decide(): void {
    const g = this.g, S = this.hole!, sc = this.rig.scale, R = BURROWER.reach * sc;
    if (this.cool.swat <= 0) {
      this.cool.swat = 0.6;
      const h = this.rig.head, air = this.airNear(h.x, h.y, h.z, 30);
      if (air) { this.swatT = air; this.begin('swat', 0.9); return; }
    }
    if (this.cool.roar <= 0) { this.startRoar(); return; }
    if (this.cool.strike > 0) return;
    // A slam on whoever fights it in reach (the hero, a squad), else a car to snatch, a facade to bite.
    const hostile = this.hostileTarget(R + 6);
    if (hostile && Math.hypot(hostile.x - S.x, hostile.z - S.z) < R + 4) {
      this.target.set(hostile.x, this.ground(hostile.x, hostile.z), hostile.z);
      this.begin('slam', 2.6); this.stats.slams++;
      g.audio.play('burrower_roar', this.rig.head.x, this.rig.head.y, this.rig.head.z, 0.6, 1.3, 90, g.renderer.camera.position);
      return;
    }
    const P = g.player.pos;
    if (!g.player.flying && Math.hypot(P.x - S.x, P.z - S.z) < R && P.y < S.y + 8 && this.rng.chance(0.5)) {
      this.target.set(P.x, this.ground(P.x, P.z), P.z);
      this.begin('slam', 2.6); this.stats.slams++;
      return;
    }
    const car = this.carNear(S.x, S.z, R);
    if (car && this.rng.chance(0.6)) {
      this.targetCar = car;
      this.target.set(car.x, car.y + 1, car.z);
      this.begin('snatch', 2.6); this.stats.snatches++;
      return;
    }
    const f = this.facadeNear(S.x, S.z, R);
    if (f) {
      this.targetRef = f.ref;
      this.target.set(f.x, f.y, f.z);
      this.begin('bite', 2.2); this.stats.bites++;
      return;
    }
    // Nothing worth it: a slam on the street ahead (it never just hangs there).
    const a = Math.atan2(this.focus.z - S.z, this.focus.x - S.x) + this.rng.range(-0.6, 0.6), d = this.rng.range(14, R * 0.8);
    const x = S.x + Math.cos(a) * d, z = S.z + Math.sin(a) * d;
    this.target.set(x, this.ground(x, z), z);
    this.begin('slam', 2.6); this.stats.slams++;
  }

  /** The strike lands. */
  private impact(): void {
    this.hit = true;
    const g = this.g, T = this.target, sc = this.rig.scale, cam = g.renderer.camera.position;
    const E = stepEnergy(bodyMass(BURROWER.height, 1.3), BURROWER.height) * 2.5 * dealtBy(this);
    switch (this.act) {
      case 'slam': {
        const y = this.ground(T.x, T.z);
        this.stats.broken += g.interactions.steps.land(T.x, y, T.z, E, BURROWER.height, { cause: 'threat', own: false, sound: 'burrower_slam', ref: 90, maxR: 500, foot: 6 * sc });
        for (const a of g.peds.neighbours(T.x, T.z, 9 * sc, [])) this.knock(a, T.x, T.z, 8);
        for (const v of [...g.traffic.vehicles, ...g.parkedCars]) if (v.state !== VState.Crushed && Math.hypot(v.x - T.x, v.z - T.z) < 5 * sc) { g.traffic.crush(v); this.stats.wrecked++; }
        g.props.hit(T.x, y + 1, T.z, 6 * sc, 0, -2e4, 0);
        this.hurtPlayerNear(T.x, T.z, 8, 40, 12);
        this.onBlow?.('slam', T.x, y, T.z, 9 * sc);
        g.elements.fx.decal(DecalKind.Crack, T.x, y + 0.05, T.z, 0, 1, 0, 10 * sc, 10 * sc, Math.random() * 6, 200);
        break;
      }
      case 'snatch': {
        const v = this.targetCar;
        const h = this.rig.head;
        if (v && v.state !== VState.Crushed && v.state !== VState.Wreck && Math.hypot(v.x - h.x, v.z - h.z) < 8 * sc) {
          // Caught up and flung away over the street.
          const a = Math.atan2(v.z - this.hole!.z, v.x - this.hole!.x) + this.rng.range(-1.2, 1.2);
          this.wreckCar(v, Math.cos(a) * 26000, 30000, Math.sin(a) * 26000);
          g.audio.play('car_crash', v.x, v.y, v.z, 1, 0.8, 16, cam);
        } else {
          const y = this.ground(T.x, T.z);
          g.interactions.steps.land(T.x, y, T.z, E * 0.5, BURROWER.height, { cause: 'threat', own: false, sound: 'burrower_slam', ref: 70, maxR: 400, foot: 4 * sc });
        }
        for (const a of g.peds.neighbours(T.x, T.z, 6 * sc, [])) this.knock(a, T.x, T.z, 6);
        this.hurtPlayerNear(T.x, T.z, 6, 30, 10);
        this.onBlow?.('swipe', T.x, T.y, T.z, 6 * sc);
        break;
      }
      case 'bite': {
        const ref = this.targetRef;
        const h = this.rig.head, dx = T.x - h.x, dz = T.z - h.z, l = Math.hypot(dx, dz) || 1;
        const n = g.destruction.as('threat', () => g.destruction.impact(T.x, T.y, T.z, 5 * sc, 9e5 * dealtBy(this), dx / l, -0.2, dz / l, 'wall'));
        this.stats.broken += n;
        if (n) g.consequences.record('burrower', 'building', 'facade', T.x, T.z, undefined, 'threat');
        if (ref && ref.alive && ref.top - ref.base < 14) g.destruction.as('threat', () => g.destruction.crushAt(ref, ref.top));
        if (ref && this.mode === 'rampage') this.rampDone.add(ref);
        g.dust.burst(T.x, T.y, T.z, 20, 5, 5, 4, 5, DUST, 0.3, 0.5);
        g.audio.play('collapse_big', T.x, T.y, T.z, 0.7, 1.2, 60, cam);
        g.camRig.addShake(Math.min(0.35, 50 / Math.max(50, Math.hypot(g.player.pos.x - T.x, g.player.pos.z - T.z))));
        this.hurtPlayerNear(T.x, T.z, 6, 25, 8);
        this.onBlow?.('swipe', T.x, T.y, T.z, 7 * sc);
        break;
      }
      default: break;
    }
  }

  private startRoar(): void {
    const g = this.g, h = this.rig.head;
    this.begin('roar', 3.0);
    this.stats.roars++;
    this.cool.roar = this.rng.range(BURROWER.roarGap[0], BURROWER.roarGap[1]);
    this.cool.strike = Math.max(this.cool.strike, 0.8);
    g.audio.play('burrower_roar', h.x, h.y, h.z, 1, 0.95 + this.rng.range(0, 0.1), 140, g.renderer.camera.position);
    g.stimuli.emit('roar', h.x, h.y, h.z, 9, 700, { cause: 'threat', size: this.height });
    this.onBlow?.('roar', h.x, h.y, h.z, 300);
    const d = Math.hypot(g.player.pos.x - h.x, g.player.pos.z - h.z);
    if (d < 350) g.camRig.addShake(0.3 * (1 - d / 350));
  }

  /** Over and down into the street further on (a second hole), or back down its own. False: not now. */
  private startDive(): boolean {
    const S = this.hole!, rig = this.rig;
    // Onwards along its way (back the way it came when it leaves; at the hunted when it hunts).
    let ax: number, az: number;
    if (this.mode === 'retreat') { ax = this.route.start.x - S.x; az = this.route.start.z - S.z; }
    else {
      this.pickGoal();
      ax = this.goal.x - S.x; az = this.goal.z - S.z;
      if (Math.hypot(ax, az) < 10) { ax = rig.dir.x; az = rig.dir.z; }
    }
    const al = Math.hypot(ax, az) || 1;
    ax /= al; az /= al;
    let exit: Site | null = null;
    const d = this.rng.range(BURROWER.diveAhead[0], BURROWER.diveAhead[1]) * rig.scale;
    for (const turn of [0, 0.35, -0.35, 0.7, -0.7]) {
      const c = Math.cos(turn), s = Math.sin(turn);
      const dx = ax * c - az * s, dz = ax * s + az * c;
      const r = this.rng.range(BURROWER.diveR[0], BURROWER.diveR[1]);
      const st = this.holes.site(S.x + dx * d, S.z + dz * d, r);
      if (st && Math.hypot(st.x - S.x, st.z - S.z) > S.r + st.r + 4) { exit = { ...st, y: this.ground(st.x, st.z) }; break; }
    }
    // (Nowhere to dive: back down its own hole.)
    this.exit = exit;
    this.exitOpened = !exit;
    const E = exit ?? S;
    rig.release();
    this.diveP0.set(rig.head.x, rig.head.y, rig.head.z);
    this.diveP1.set(E.x, E.y, E.z);
    this.phase = 'dive';
    this.phaseT = 0;
    this.act = null;
    this.stats.dives++;
    const g = this.g;
    g.audio.play('burrower_dive', rig.head.x, rig.head.y, rig.head.z, 1, 1, 100, g.renderer.camera.position);
    return true;
  }

  /** The arc over and down: the head goes in, the body follows it through the air into the hole. */
  private dive(dt: number): void {
    const g = this.g, rig = this.rig, T = BURROWER.diveT, k = Math.min(1, this.phaseT / T);
    const A = this.diveP0, B = this.diveP1, sc = rig.scale;
    if (k < 1) {
      // A quadratic arc over the street, ending headfirst into the hole.
      const mx = (A.x + B.x) / 2, mz = (A.z + B.z) / 2, my = Math.max(A.y, B.y) + 8 * sc;
      const u = k, a = (1 - u) * (1 - u), b = 2 * u * (1 - u), c = u * u;
      const x = a * A.x + b * mx + c * B.x, y = a * A.y + b * my + c * (B.y - 4 * sc), z = a * A.z + b * mz + c * B.z;
      const tx = 2 * (1 - u) * (mx - A.x) + 2 * u * (B.x - mx), ty = 2 * (1 - u) * (my - A.y) + 2 * u * (B.y - 4 * sc - my), tz = 2 * (1 - u) * (mz - A.z) + 2 * u * (B.z - mz);
      rig.setDir(tx, ty, tz);
      rig.moveHead(x, y, z);
      rig.petal += (0 - rig.petal) * Math.min(1, dt * 4);
      if (!this.exitOpened && k > 0.55) {
        this.exitOpened = true;
        this.holes.open(this.exit!, (this.rng.float() * 2 ** 32) >>> 0);
        this.onBlow?.('fall', B.x, B.y, B.z, this.exit!.r + 3);
      }
      this.head.set(x, y, z);
      if (k > 0.9 && !this.diveSplash) {
        this.diveSplash = true;
        g.dust.burst(B.x, B.y + 1, B.z, 16, 4, 7, 4, 4, DUST, 0.4, 0.45);
        const pd = Math.hypot(g.player.pos.x - B.x, g.player.pos.z - B.z);
        if (pd < 160) g.camRig.addShake(0.45 * (1 - pd / 160));
        this.hurtPlayerNear(B.x, B.z, (this.exit?.r ?? 5) + 2, 25, 8);
      }
      return;
    }
    // Under again: on downwards, then travelling.
    this.diveSplash = false;
    this.heading.set(rig.dir.x, Math.min(-0.5, rig.dir.y), rig.dir.z).normalize();
    this.hole = null;
    this.exit = null;
    this.phase = 'travel';
    this.phaseT = 0;
  }
  private diveSplash = false;

  // ---------------------------------------------------------------- choices

  private hostileTarget(reach: number): { x: number; y: number; z: number; key: string } | null {
    const g = this.g, p = g.player.pos;
    const at = (key: string) => (key === 'player' ? { x: p.x, y: p.y + g.player.height * 0.5, z: p.z } : this.unitAt?.(key) ?? this.keyAt?.(key) ?? null);
    return angriestInReach(this.aggro, at, this.rig.head.x, this.rig.head.z, reach);
  }

  private carNear(x: number, z: number, r: number): Vehicle | null {
    const g = this.g;
    let best: Vehicle | null = null, bd = r;
    for (const v of [...g.traffic.vehicles, ...g.parkedCars]) {
      if (v.state === VState.Crushed || v.state === VState.Wreck) continue;
      const d = Math.hypot(v.x - x, v.z - z);
      if (d < bd && d > 6) { bd = d; best = v; }
    }
    return best;
  }

  /** A facade in reach to bite into (downtown: the towers it has not done yet), two to four floors up. */
  private facadeNear(x: number, z: number, r: number): { ref: BuildingRef; x: number; y: number; z: number } | null {
    const g = this.g;
    let best: { ref: BuildingRef; x: number; y: number; z: number } | null = null, bs = -Infinity;
    for (const ref of g.world.buildingsIn(x - r, z - r, x + r, z + r)) {
      if (!ref.alive || this.rampDone.has(ref)) continue;
      const c = closestOnPoly(ref.poly, x, z), d = Math.hypot(c.x - x, c.z - z);
      if (d > r || d < 4) continue;
      const H = ref.top - ref.base, s = H - d * 0.4;
      if (s > bs) { bs = s; best = { ref, x: c.x, y: ref.base + Math.min(H - 1.5, 7 + this.rng.range(0, 10)), z: c.z }; }
    }
    return best;
  }

  /** Downtown: a spot beside a tall building it has not broken out at yet. */
  private towerSite(): Site | null {
    const g = this.g, E = this.route.end;
    const towers = g.world.buildingsIn(E.x - 240, E.z - 240, E.x + 240, E.z + 240).filter((r) => r.alive && r.top - r.base > 18 && !this.rampDone.has(r));
    towers.sort((a, b) => (b.top - b.base) - (a.top - a.base));
    for (const ref of towers.slice(0, 8)) {
      const h = this.rig.head;
      const c = closestOnPoly(ref.poly, h.x, h.z);
      const dx = h.x - c.x, dz = h.z - c.z, l = Math.hypot(dx, dz) || 1;
      const s = this.findSite(c.x + (dx / l) * 14, c.z + (dz / l) * 14, this.rng.range(BURROWER.holeR[0], BURROWER.holeR[1]));
      if (s) { this.rampDone.add(ref); return s; }
      this.rampDone.add(ref);
    }
    return null;
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

  /** Timers that run whatever it does: downtown's clock, the visit's end, badly hurt. */
  private watch(dt: number): void {
    if (this.mode === 'retreat') return;
    if (this.hp < this.maxHp * BURROWER.retreatAt) { this.startLeaving(true); return; }
    if (this.t > BURROWER.visitMax) { this.startLeaving(false); return; }
    if (this.mode === 'rampage') {
      this.rampT += dt;
      if (this.rampT > BURROWER.rampageT) this.startLeaving(false);
    }
  }

  /** Away under the city (hurt: the hero may be rewarded for driving it off). */
  private startLeaving(hurt: boolean): void {
    if (this.mode === 'retreat' || this.defeated) return;
    this.mode = 'retreat';
    this.leaveT = 0;
    this.site = null;
    if (hurt && this.topAggro()?.key === 'player') this.g.crime.reward({ karma: BURROWER.karma.retreat, why: 'drove the worm off', rep: 6, news: 'giant worm driven off' });
    // Up there: it dives at once (the bulge before a breach: it turns away).
    if (this.phase === 'up' && !this.act) this.startDive();
    else if (this.phase === 'bulge') { this.phase = 'travel'; this.phaseT = 0; this.site = null; }
  }

  // ---------------------------------------------------------------- hurt, beaten

  private react(dealt: number, weak: boolean, src: DamageSource): void {
    if (this.phase !== 'up') return;
    // A hard blow on the open maw: it recoils, the petals snap shut.
    if ((weak && dealt > 60) || this.recentHit > BURROWER.staggerAt) {
      if (this.act === 'flinch' || this.act === 'stun') return;
      this.recentHit *= 0.3;
      this.begin('flinch', 1.0);
      this.stats.flinches++;
      return;
    }
    if (src.cause === 'player' && dealt > 30) this.cool.strike = Math.min(this.cool.strike, 0.5);
  }

  private startDying(): void {
    if (this.defeated) return;
    const g = this.g, rig = this.rig, S = this.hole ?? { x: rig.head.x, z: rig.head.z, y: this.ground(rig.head.x, rig.head.z), r: 6, depth: 4 };
    this.mode = 'dying';
    this.act = null;
    this.dieT = 0;
    this.active = false;
    this.outcome = 'defeated';
    // It topples away from the hole the way it leans, the column coming down on the street.
    if (!rig.anchor) rig.anchorAt(S.x, S.y - 2.5, S.z);
    let dx = rig.head.x - S.x, dz = rig.head.z - S.z;
    if (Math.hypot(dx, dz) < 2) { dx = rig.dir.x; dz = rig.dir.z; }
    const l = Math.hypot(dx, dz) || 1;
    this.fallDir.set(dx / l, 0, dz / l);
    const reach = Math.min(rig.exposed() * 0.8, 40 * rig.scale);
    const fx = S.x + this.fallDir.x * reach, fz = S.z + this.fallDir.z * reach;
    this.fallTo.set(fx, this.ground(fx, fz) + wormRadius(0) * rig.scale * 0.85, fz);
    const h = rig.head;
    g.audio.play('burrower_roar', h.x, h.y, h.z, 1, 0.7, 140, g.renderer.camera.position);
    g.stimuli.emit('roar', h.x, h.y, h.z, 9, 700, { cause: 'threat', size: this.height });
    if (heroEarned(this.aggro)) g.crime.reward({ karma: BURROWER.karma.defeated, why: 'brought the giant worm down', rep: 12, news: 'giant worm defeated', stopped: true });
  }

  /** The column topples onto the street; the impact crushes what is under it. */
  private dying(dt: number): void {
    const g = this.g, rig = this.rig;
    this.dieT += dt;
    const k = Math.min(1, this.dieT / 3.2), e = k * k;
    const H = rig.head;
    const before = this.dieT - dt;
    // Down along an arc: out and over first, then down onto the street.
    const tx = H.x + (this.fallTo.x - H.x) * Math.min(1, dt * (1 + e * 6));
    const tz = H.z + (this.fallTo.z - H.z) * Math.min(1, dt * (1 + e * 6));
    const ty = H.y + (this.fallTo.y - H.y) * Math.min(1, dt * e * 6);
    rig.moveHead(tx, ty, tz);
    rig.setDir(this.fallDir.x, -0.1 * (1 - k), this.fallDir.z);
    rig.petal += (0.55 - rig.petal) * Math.min(1, dt * 2);
    for (const Z of this.zones) Z.exposed = false;
    if (before < 2.6 && this.dieT >= 2.6) {
      // The body hits the street.
      for (let i = 0; i < rig.caps.length - 1; i++) {
        const c = rig.caps[i];
        const mx = (c.ax + c.bx) / 2, my = (c.ay + c.by) / 2, mz = (c.az + c.bz) / 2;
        if (my < this.ground(mx, mz) - 2) continue;
        for (const v of [...g.traffic.vehicles, ...g.parkedCars]) if (v.state !== VState.Crushed && Math.hypot(v.x - mx, v.z - mz) < c.r + 1.5) { g.traffic.crush(v); this.stats.wrecked++; }
        for (const a of g.peds.neighbours(mx, mz, c.r + 2, [])) this.knock(a, mx, mz, 5);
        g.props.crush(mx, mz, c.r);
        if (i % 4 === 0) {
          this.stats.broken += g.interactions.steps.land(mx, this.ground(mx, mz), mz, stepEnergy(bodyMass(BURROWER.height, 1.3), BURROWER.height) * 3, BURROWER.height, { cause: 'threat', own: false, sound: 'burrower_slam', ref: 110, maxR: 600, foot: c.r });
          this.onBlow?.('fall', mx, my, mz, c.r + 4);
        }
      }
      g.stimuli.emit('collapse', this.x, this.y, this.z, 9, 900, { cause: 'threat', size: this.height });
      g.dust.burst(this.x, this.y, this.z, 60, 24, 12, 10, 9, DUST, 0.5, 0.6);
      g.camRig.addShake(Math.min(1, 300 / Math.max(60, Math.hypot(g.player.pos.x - this.x, g.player.pos.z - this.z))));
    }
    if (k >= 1 && this.dieT > 3.6) {
      this.mode = 'dead';
      rig.still = true;
      this.downAt = g.sky.hoursAbs;
      this.rumble?.stop(); this.rumble = null;
    }
  }

  /** Lying in the street: settles a little longer, then is left alone. */
  private lying(dt: number): void {
    if (this.dieT < 6) { this.dieT += dt; this.rig.place(); this.centre(); }
  }

  /** The last resort is not for it; dev and the console: gone at once. */
  obliterate(): void { this.finish('destroyed'); }

  private finish(o: ThreatOutcome): void {
    if (this.mode === 'gone') return;
    this.active = false;
    this.outcome = o;
    this.mode = 'gone';
    this.rumble?.stop(); this.rumble = null;
  }

  // ---------------------------------------------------------------- effects

  /** The glows: the pits pulse while it is up (bright while it roars), the gullet with the maw open. */
  private glows(dt: number): void {
    const rig = this.rig;
    const upK = this.surfaced ? 1 : 0;
    const pits = this.mode === 'dead' ? 0 : this.act === 'roar' ? 1 : upK * (0.45 + 0.25 * Math.sin(this.t * 2.6)) + (1 - upK) * 0.15;
    rig.pits += (pits - rig.pits) * Math.min(1, dt * 3);
    const maw = this.mode === 'dead' ? 0 : Math.min(1, rig.petal * 1.2);
    rig.maw += (maw - rig.maw) * Math.min(1, dt * 4);
    this.exposedMaw = rig.petal > 0.45 && this.surfaced;
    this.zone('maw').exposed = this.exposedMaw;
  }

  /** Under the street: cracks running along it, dust, a rumble, a tremor; drivers stop; news drones. */
  private surroundings(dt: number): void {
    const g = this.g, h = this.rig.head, cam = g.renderer.camera.position;
    const under = this.phase === 'travel' || this.phase === 'bulge';
    // Its body above the street (drawn), checked a few times a second.
    this.upCheckT -= dt;
    if (this.upCheckT <= 0) {
      this.upCheckT = 0.25;
      const J = this.rig.j;
      let up = false;
      for (let i = 0; i < this.rig.n && !up; i += 2) if (J[i * 3 + 1] > this.ground(J[i * 3], J[i * 3 + 2]) - wormRadius(i * WORM.seg) * 1.1) up = true;
      this.anyUp = up;
    }
    if (this.mode === 'dead') return;
    const sy = this.ground(h.x, h.z);
    const dc = Math.hypot(cam.x - h.x, cam.z - h.z);
    // The rumble follows it (loud over it, felt more than heard).
    if (!this.rumble && dc < 600) this.rumble = g.audio.loop('burrower_rumble', 40);
    if (this.rumble) {
      const gain = this.mode === 'dying' ? 0 : under ? 1 : 0.5;
      this.rumble.set(h.x, sy, h.z, gain * Math.max(0, 1 - dc / 600), 0.85 + Math.min(0.3, BURROWER.speed / 40));
      if (dc > 700) { this.rumble.stop(); this.rumble = null; }
    }
    if (under && dc < 400) {
      this.crackT -= dt;
      if (this.crackT <= 0 && Math.hypot(h.x - this.crackX, h.z - this.crackZ) > 7) {
        this.crackT = 0.15;
        this.crackX = h.x; this.crackZ = h.z;
        const yaw = Math.atan2(this.heading.x, this.heading.z);
        if (!g.world.buildingAt(h.x, h.z)) g.elements.fx.decal(DecalKind.Crack, h.x, sy + 0.05, h.z, 0, 1, 0, 9, 4, yaw + this.rng.range(-0.4, 0.4), 90);
        if (Math.random() < 0.5) g.dust.burst(h.x, sy + 0.2, h.z, 4, 2, 1.5, 1.5, 3, DUST, 0.15, 0.4);
      }
      if (dc < 90) g.camRig.addShake(dt * 0.25 * (1 - dc / 90));
    }
    this.stimT -= dt;
    if (this.stimT <= 0) {
      this.stimT = 1.3;
      if (under) g.stimuli.emit('tremor', h.x, sy, h.z, 5, 260, { cause: 'threat', size: this.height });
      else g.stimuli.emit('threat', this.x, sy + 10, this.z, 6, 160, { cause: 'threat' });
      g.physics.prefetchGround(h.x + this.heading.x * 40, h.z + this.heading.z * 40, 60);
      for (const v of g.traffic.vehicles) if (v.state === VState.Drive && !v.task && Math.hypot(v.x - h.x, v.z - h.z) < (under ? 50 : 140)) v.fear = Math.max(v.fear, 1);
    }
    this.newsT -= dt;
    if (this.newsT <= 0 && !under && !this.defeated) { this.newsT = 35; g.future.drones.incident(DKind.News, this.x, this.z, g.player.pos.x, g.player.pos.z); }
  }

  private knock(a: PedAgent, fx: number, fz: number, power: number): void {
    if (a.inside || a.state === PState.Down) return;
    this.g.reactions.knockDown(a, fx, fz, power * dealtBy(this), 'threat');
    this.g.consequences.record('burrower', 'person', 'knockdown', a.x, a.z, a, 'threat');
    this.hurt++;
    this.stats.knocked++;
  }

  private wreckCar(v: Vehicle, jx: number, jy: number, jz: number): void {
    const g = this.g;
    g.traffic.wreckIt(v);
    const k = dealtBy(this);
    g.vehicles.makeWreck(v, v.x, v.y + 1.5, v.z, jx * k, jy * k, jz * k);
    g.consequences.record('burrower', 'car', 'wreck', v.x, v.z, v, 'threat');
    this.stats.wrecked++;
  }

  private hurtPlayerNear(x: number, z: number, r: number, dmg: number, fling: number): void {
    const p = this.g.player;
    const d = Math.hypot(p.pos.x - x, p.pos.z - z);
    const gy = this.ground(x, z);
    if (d > r + p.radius || p.pos.y > gy + 6) return;
    this.hurtPlayer(dmg * (1 - (d / (r + p.radius + 1)) * 0.5), x, z, gy, fling);
  }

  private hurtPlayer(dmg: number, fromX: number, fromZ: number, fromY: number, fling: number): void {
    const g = this.g, p = g.player;
    const k3 = p.k ** 3, rel = Math.min(1, Math.pow(this.height / Math.max(1, p.height), 0.8));
    const d = g.crime.health.damage(dmg * k3 * Math.max(0.15, rel) * dealtBy(this), 'monster', fromX, fromZ, fromY);
    this.stats.playerHits++;
    if (d <= 0 && !g.crime.health.invulnerable) return;
    const dx = p.pos.x - fromX, dz = p.pos.z - fromZ, l = Math.hypot(dx, dz) || 1;
    const f = fling * rel;
    if (f > 2 && !p.flying) {
      p.vel.x += (dx / l) * f; p.vel.z += (dz / l) * f; p.vel.y = Math.max(p.vel.y, f * 0.45);
      p.grounded = false;
      if (rel > 0.5) p.downT = Math.max(p.downT, 1.4);
    }
    g.camRig.addShake(0.4);
  }

  private updateZones(): void {
    const rig = this.rig, J = rig.j, s = rig.scale;
    const set = (id: string, x: number, y: number, z: number, r: number) => { const Z = this.zone(id); Z.x = x; Z.y = y; Z.z = z; Z.r = r; };
    const m = rig.mouth();
    set('maw', m.x, m.y, m.z, WORM.lip * s);
    set('head', J[3], J[4], J[5], 4 * s);
    // The column's middle (up) or the body behind the head.
    const i = 4, U = rig.up;
    set('body', J[i * 3], J[i * 3 + 1], J[i * 3 + 2], 4.4 * s);
    set('belly', J[i * 3] - U[i * 3] * 3 * s, J[i * 3 + 1] - U[i * 3 + 1] * 3 * s, J[i * 3 + 2] - U[i * 3 + 2] * 3 * s, 3 * s);
  }

  // ================================================================== drawing, obstacles

  /** Something of it is above the street (drawn). */
  get visible(): boolean { return this.mode !== 'gone' && (this.surfaced || this.defeated || this.phase === 'dive' || this.anyUp); }

  draw(mesh: WormMesh): number {
    if (!this.visible) return 0;
    return mesh.draw(this.rig, 0.15);
  }

  /** The column and a body lying in the street stand in the player's way. */
  obstacles(x0: number, z0: number, x1: number, z1: number, out: (o: import('../../../world/Collision').Obstacle) => void): void {
    if (!this.visible) return;
    const caps = this.rig.caps;
    for (let i = 0; i < caps.length - 1; i++) {
      const c = caps[i];
      const mx = (c.ax + c.bx) / 2, mz = (c.az + c.bz) / 2, r = c.r * 0.9;
      if (mx + r < x0 || mx - r > x1 || mz + r < z0 || mz - r > z1) continue;
      const y0 = Math.min(c.ay, c.by) - c.r, y1 = Math.max(c.ay, c.by) + c.r;
      if (y1 < this.ground(mx, mz) - 0.5) continue;
      out({ cyl: true, x: mx, z: mz, r, hx: 0, hz: 0, ux: 1, uz: 0, y0, y1 });
    }
  }

  // ================================================================== dev

  /** Break out now (ahead of its head, or at the hero). */
  devBreach(atHero = false): string {
    if (this.defeated || this.phase !== 'travel') return this.phase;
    const P = this.g.player.pos, h = this.rig.head;
    const s = atHero ? this.findSite(P.x, P.z, BURROWER.holeR[0]) : this.findSite(h.x + this.heading.x * 20, h.z + this.heading.z * 20, BURROWER.holeR[0]);
    if (!s) return 'no site';
    this.startBulge(s, 0.5);
    return 'bulge';
  }

  devDive(): string { if (this.phase !== 'up') return this.phase; this.act = null; this.startDive(); return this.phase; }

  devSlam(): string {
    if (this.phase !== 'up') return this.phase;
    const P = this.g.player.pos;
    this.target.set(P.x, this.ground(P.x, P.z), P.z);
    this.begin('slam', 2.6); this.stats.slams++;
    return 'slam';
  }

  /** Dev: under the street at the point of its way nearest the hero. */
  devNear(): number {
    const P = this.g.player.pos;
    const s = nearestS(this.route, P.x, P.z, this.route.length / 2, 1e6);
    this.s = 0;
    return this.devSkip(Math.max(0, s - 30));
  }

  /** Jump `m` metres on along its way, under the street. */
  devSkip(m: number): number {
    if (this.phase !== 'travel') return Math.round(this.s);
    this.s = Math.min(this.route.length, this.s + m);
    const p = routeAt(this.route, this.s, _rp);
    const y = this.ground(p.x, p.z) - BURROWER.depth;
    this.head.set(p.x, y, p.z);
    this.heading.set(p.dx, 0, p.dz);
    this.rig.reset(p.x, y, p.z, p.dx, 0, p.dz);
    while (this.nextBreach < this.route.breaches.length && this.route.breaches[this.nextBreach] < this.s) this.nextBreach++;
    return Math.round(this.s);
  }
}
