/**
 * The Strider (THREATS_PLAN §1 #1, Phase B): a 40 m reptilian walker that rises from the river and
 * walks the arterials into downtown. The city's first major threat.
 *
 * Seen first in fragments (show, don't tell): a tremor, a wake on the river, then a back with a
 * ridge of plates breaking the surface, water cascading off it, a two-tone roar. It wades up the
 * bank and walks its route (StriderRoute) — a low spine, a tall dorsal ridge, thick legs, a long
 * tail — drawn to tall buildings, to loud things and to whoever hurt it most (the aggro table).
 *
 *   walk      feet come down through GiantBody (GiantSteps.footstep at its size, booked to the
 *             threat): cars flattened, people knocked down, paving and ground floors broken; its
 *             body shoulders through facades in narrow streets; the camera shakes with distance.
 *   lean      it puts a forefoot on a tower and pushes: the facade gives; small buildings come down.
 *   swipe     the tail sweeps a side (a capsule sweep): facades, cars and people flung.
 *   roar      two-tone; people flee, drivers abandon their cars, birds lift off; half the time it
 *             rears up (the soft belly shown) and comes down on its forefeet.
 *   swat      drones near its head are snapped out of the air, and the army's helicopters (`airTargets`).
 *   breath    the ridge lights up plate by plate for 2 s, the throat glows (a weak spot, exposed),
 *             then a blue-white beam sweeps a facade: windows burst, panels break, it burns.
 *
 * It is a ThreatActor: 3000 points, armour per zone (head, throat, neck, back, belly, four legs,
 * tail), weak spots (the throat while charging and breathing, the belly while rearing). The player's
 * punches and powers reach it through `damage` / `strike` (Elements, Game.strike), the army will
 * too. Hard hits stagger it, a hit on the glowing throat chokes the breath off, a battered leg
 * buckles. Badly hurt (30 %) it turns back to the river and sinks away; brought down it collapses —
 * no gore — and its body stays where it fell (`onDefeated`; the aftermath removes it, stage 3).
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import { Rng } from '../../core/rng';
import { PState, type PedAgent } from '../../sim/Pedestrians';
import { VState, type Vehicle } from '../../sim/Traffic';
import { DKind } from '../../future/Drones';
import { statusFor, dealtBy } from '../../shared/status';
import { BeamStyle, DecalKind } from '../powers/ElementFx';
import { bodyMass, stepEnergy, walkSpeed } from '../GiantBody';
import { CreatureRig, capsuleDist, type RigDef, type Capsule } from './rig/CreatureRig';
import type { CreatureMesh } from './rig/CreatureMesh';
import { planStriderRoute, routeAt, type StriderRoute } from './StriderRoute';
import type { ThreatActor, ThreatEvent, ThreatOutcome, ThreatTarget, ThreatZone, DamageSource, DamageResult } from './ThreatEvent';
import { DAMAGE_PER_IMPULSE } from './ThreatEvent';
import type { Cause } from '../Stimuli';
import type { BuildingRef } from '../../world/WorldIndex';
import { angriestInReach } from '../response/forces/BattleModel';
import { boneLayout } from './rig/skin';

/** Its blows as the army's units feel them (response/forces): breath ticks, tail sweeps, footfalls, slams, roars, its fall. */
export type StriderBlow = 'breath' | 'swipe' | 'step' | 'slam' | 'roar' | 'fall';

export const STRIDER = {
  height: 40,
  /** Bulk relative to a scaled-up human (mass ∝ k³ × build). */
  build: 1.25,
  hp: 3000,
  /** Walking speed: a 1.8 m equivalent's pace (× √k), m/s. */
  pace: 1.1,
  turnRate: 0.42,
  emergeT: 10,
  /** Below the river bed before it rises (m). */
  sunk: 52,
  roarGap: [24, 40] as [number, number], roarT: 3.4, rearChance: 0.5,
  breathGap: [28, 44] as [number, number], chargeT: 2.0, breathT: 3.4, breathRange: 240, breathTick: 0.25,
  /** Heat impulse per breath tick (N·s) and its radius (m). */
  breathHeat: 1.8e5, breathR: 2.6,
  swipeGap: [14, 24] as [number, number], swipeT: 1.7,
  leanGap: 16, leanT: 4.5, leanReach: 26,
  /** Body contacts with facades: impulse (N·s), checks a second. */
  contactJ: 2.6e5, contactRate: 3,
  /**
   * Destruction budget (THREATS_PLAN §4 budgets): every panel a destruction impact breaks costs a few
   * ms (debris bodies, structure checks), so its impacts draw on tokens (this many a second, a burst
   * of `burst`); with many panels broken lately they soften to glass and cracks.
   */
  smashRate: 3, smashBurst: 6, panelsSoft: 10,
  /** Weak spot multiplier, staggers, the leg that buckles. */
  weakMul: 4, staggerAt: 150, buckleAt: 240, staggerT: 1.8,
  /** Badly hurt: back to the river at this share of hp. */
  retreatAt: 0.3,
  /** In downtown: attack towers this long (s), then go back. */
  rampageT: 260,
  /** In downtown with no tower in reach: it hunts whoever fights it, else roams (a new point this often, s). */
  roamT: 25,
  /** On one tower this long (s) without bringing it down: it gives up on it and picks the next. */
  towerMax: 75,
  /** A visit ends: after this long (s) it heads back to the river whatever it is doing. */
  visitMax: 720,
  /** The incident radius (m) and its far stimulus radius. */
  radius: 95,
  karma: { weak: 2, retreat: 60, defeated: 120 },
};

/** The 40 m body (metres; `CreatureRig` scales it for bigger variants). */
export const STRIDER_RIG: RigDef = {
  spine: [6.5, 10, 10], spineR: [6.4, 7.4, 6.6], spineH: [19, 17, 15.5, 15],
  neck: [5.5, 5, 4.5], neckR: [4.4, 3.6, 3.0],
  head: { len: 11.5, w: 7.6, h: 6.4 },
  jaw: { len: 10, w: 6, h: 3.6 },
  tail: [7, 7, 6.5, 6, 5.5, 5, 4.5, 4, 3.5], tailR: [5.6, 4.8, 4.1, 3.5, 2.9, 2.3, 1.8, 1.3, 0.9],
  legs: [
    { at: 'front', side: -1, out: 6.2, down: 3, fwd: -1, upper: 9, lower: 8.5, foot: 6, r: [3.4, 2.6, 2.4], phase: 0.25, knee: -1, spread: 2.5, zone: 'foreL' },
    { at: 'front', side: 1, out: 6.2, down: 3, fwd: -1, upper: 9, lower: 8.5, foot: 6, r: [3.4, 2.6, 2.4], phase: 0.75, knee: -1, spread: 2.5, zone: 'foreR' },
    { at: 'back', side: -1, out: 6.4, down: 2, fwd: 1, upper: 10.5, lower: 9.5, foot: 7, r: [4.0, 2.9, 2.6], phase: 0, knee: 1, spread: 2.5, zone: 'hindL' },
    { at: 'back', side: 1, out: 6.4, down: 2, fwd: 1, upper: 10.5, lower: 9.5, foot: 7, r: [4.0, 2.9, 2.6], phase: 0.5, knee: 1, spread: 2.5, zone: 'hindR' },
  ],
  plates: [
    { chain: 'neck', seg: 0, t: 0.4, h: 4, len: 4 }, { chain: 'neck', seg: 1, t: 0.5, h: 3.4, len: 3.5 }, { chain: 'neck', seg: 2, t: 0.5, h: 2.6, len: 3 },
    { chain: 'spine', seg: 0, t: 0.5, h: 7, len: 6 }, { chain: 'spine', seg: 1, t: 0.25, h: 9.5, len: 7 }, { chain: 'spine', seg: 1, t: 0.75, h: 10, len: 7.5 },
    { chain: 'spine', seg: 2, t: 0.25, h: 9, len: 7 }, { chain: 'spine', seg: 2, t: 0.75, h: 8, len: 6.5 },
    { chain: 'tail', seg: 0, t: 0.5, h: 6.5, len: 6 }, { chain: 'tail', seg: 1, t: 0.5, h: 5.5, len: 5.5 }, { chain: 'tail', seg: 2, t: 0.5, h: 4.5, len: 5 },
    { chain: 'tail', seg: 3, t: 0.5, h: 3.6, len: 4.5 }, { chain: 'tail', seg: 4, t: 0.5, h: 2.8, len: 4 }, { chain: 'tail', seg: 5, t: 0.5, h: 2, len: 3.2 },
  ],
  stride: 15, swing: 0.3, lift: 3.6,
};

/** The skin's bone layout of the Strider (the carcass cleanup cuts it up bone by bone). */
export const CUT_LAYOUT = boneLayout(STRIDER_RIG);

type Mode = 'emerge' | 'advance' | 'rampage' | 'retreat' | 'sink' | 'dying' | 'dead' | 'gone';
type Act = null | 'roar' | 'charge' | 'breath' | 'swipe' | 'lean' | 'stagger' | 'swat';

/** Something in the air the monster can swat (drones now; helicopters register in stage 2). */
export interface AirTarget { x: number; y: number; z: number; swat(jx: number, jy: number, jz: number): void }
export type AirProvider = (x: number, y: number, z: number, r: number) => AirTarget[];

export interface StriderOpts {
  /** 'river' (default): the seed's emergence point; or a fixed start in the water. */
  from?: 'river';
  at?: { x: number; z: number };
}

let EVENT_ID = 1000;

const WATER_A = new THREE.Color(0.75, 0.82, 0.86), WATER_B = new THREE.Color(0.5, 0.6, 0.66);
const FOAM = new THREE.Color(0.9, 0.93, 0.95);
const BEAM_HOT = new THREE.Color(1.6, 2.6, 4.5), BEAM_END = new THREE.Color(0.3, 0.6, 1.4);
const FIRE_HOT = new THREE.Color(2.2, 1.05, 0.25), FIRE_END = new THREE.Color(0.55, 0.08, 0.01);
const SMOKE = new THREE.Color(0.14, 0.13, 0.12), SMOKE_L = new THREE.Color(0.4, 0.39, 0.38);
const DUST = new THREE.Color(0.55, 0.52, 0.48);
const _v = new THREE.Vector3();
const _r = { x: 0, z: 0, dx: 0, dz: 0 };
const NO_KINDS = {};

/** Body zones: armour (share of the damage stopped) and weak spots (the army's battle model reads them too). */
export const STRIDER_ZONES: { id: string; name: string; armour: number; weak: boolean }[] = [
  { id: 'head', name: 'Head', armour: 0.6, weak: false },
  { id: 'throat', name: 'Throat', armour: 0.85, weak: true },
  { id: 'neck', name: 'Neck', armour: 0.75, weak: false },
  { id: 'back', name: 'Dorsal plates', armour: 0.92, weak: false },
  { id: 'belly', name: 'Belly', armour: 0.7, weak: true },
  { id: 'foreL', name: 'Left foreleg', armour: 0.8, weak: false },
  { id: 'foreR', name: 'Right foreleg', armour: 0.8, weak: false },
  { id: 'hindL', name: 'Left hind leg', armour: 0.82, weak: false },
  { id: 'hindR', name: 'Right hind leg', armour: 0.82, weak: false },
  { id: 'tail', name: 'Tail', armour: 0.85, weak: false },
];

export class Strider implements ThreatEvent, ThreatActor {
  readonly id = EVENT_ID++;
  readonly archetype = 'strider';
  readonly tier = 'major';
  readonly engageOnFoot = false;
  readonly actors: ThreatActor[] = [this];
  readonly name = 'Giant creature';
  readonly radius = STRIDER.radius;
  /** Biggest dimension at full size (nose to tail; for the shrink ray). */
  readonly size: number;
  /** Shrink ray: body size factor (1 = full). */
  private sc = 1;
  get height(): number { return STRIDER.height * this.sc; }
  readonly maxHp = STRIDER.hp;
  hp = STRIDER.hp;
  x = 0; y = 0; z = 0;
  t = 0;
  active = true;
  outcome: ThreatOutcome | null = null;
  hurt = 0;
  readonly rig: CreatureRig;
  readonly route: StriderRoute;
  readonly zones: ThreatZone[];
  readonly aggro = new Map<string, number>();
  /** Stage 3: called once when it is brought down (the body stays). */
  onDefeated: ((s: Strider) => void) | null = null;
  /** The last resort's countdown is on (response level 5): it stays in downtown — no rampage or visit limit sends it home. */
  stay = false;
  /** A body lying in the city: when it came down (absolute game hours; −1 not yet) and the share carted away (the aftermath). */
  downAt = -1;
  cleared = 0;
  /** Things in the air it can swat besides drones (the army's helicopters). */
  airTargets: AirProvider[] = [];
  /** The army (response/forces): where a squad (an aggro key) stands now — its breath and roars go for them. */
  unitAt: ((key: string) => { x: number; y: number; z: number } | null) | null = null;
  /** Others it can turn on by aggro key (the police on foot: ResponseDirector GIANT). */
  keyAt: ((key: string) => { x: number; y: number; z: number } | null) | null = null;
  /** The army: its blows, for the units standing there. */
  onBlow: ((kind: StriderBlow, x: number, y: number, z: number, r: number) => void) | null = null;
  mode: Mode = 'emerge';
  act: Act = null;
  private actT = 0;
  /** Progress along the route (m). */
  s = 0;
  private yaw = 0;
  private v = 0;
  private rng: Rng;
  private cool = { roar: 0, breath: 0, swipe: 0, lean: 0, swat: 0 };
  private rearing = false;
  private rearT = 0;
  /** Breath: where it aims (world), its sweep axis, the last impact. */
  private aimP = new THREE.Vector3();
  private aimSide = new THREE.Vector3();
  private beamEnd = new THREE.Vector3();
  private beamTick = 0;
  private igniteT = 0;
  private breathTarget: 'player' | 'building' | 'point' = 'point';
  private swipeSide = 1;
  private swipeHit = new Map<object, number>();
  private leanRef: BuildingRef | null = null;
  private leanLeg = 0;
  private leanP = new THREE.Vector3();
  private leanTick = 0;
  private contactT = 0;
  private contactBudget = 0;
  private stimT = 0;
  private newsT = 5;
  private scanT = 0;
  private interest: { x: number; y: number; z: number } | null = null;
  private rampage: Rampage | null = null;
  private recentHit = 0;
  /** Destruction tokens and the panels broken lately (decaying). */
  private tokens = 4;
  private recentBroken = 0;
  private emergeK = 0;
  private waterT = 0;
  private dieT = 0;
  private stepN = 0;
  private lastSound = { charge: -9, breath: -9 };
  readonly stats = {
    steps: 0, broken: 0, crushedCars: 0, wrecked: 0, knocked: 0, impacts: 0, roars: 0, rears: 0, breaths: 0, fires: 0,
    swipes: 0, leans: 0, swats: 0, damage: 0, weakHits: 0, staggers: 0, walked: 0, chokes: 0, playerHits: 0,
  };

  constructor(private g: Game, seed: number, opts: StriderOpts = {}) {
    this.rng = new Rng(seed);
    const route = planStriderRoute(g.macro, g.terrain, opts.at);
    if (!route) throw new Error('strider: no route from the river');
    this.route = route;
    this.zones = STRIDER_ZONES.map((z) => ({ ...z, exposed: false, x: 0, y: 0, z: 0, r: 4, recent: 0 }));
    const rig = new CreatureRig(STRIDER_RIG, STRIDER.height / 40);
    rig.ground = (x, z) => g.terrain.height(x, z) + g.world.surfaceOffset(x, z);
    routeAt(route, 0, _r);
    rig.x = route.start.x; rig.z = route.start.z;
    this.yaw = rig.yaw = Math.atan2(-_r.dx, -_r.dz);
    rig.lift = -STRIDER.sunk;
    rig.place();
    this.size = Math.max(STRIDER.height, rig.length);
    rig.onStep = (leg, x, y, z) => this.footstep(leg, x, y, z);
    this.rig = rig;
    this.x = route.start.x; this.z = route.start.z;
    this.cool.breath = 26; this.cool.swipe = 12; this.cool.lean = 8; this.cool.roar = 0;
    rig.update(0.016, 0);
  }

  // ================================================================== ThreatActor

  get defeated(): boolean { return this.mode === 'dying' || this.mode === 'dead'; }
  /** Its head (the army's helicopters make their runs at it). */
  get headPos(): { x: number; y: number; z: number } { return this.rig.headPos; }
  get targetable(): boolean { return this.mode !== 'gone' && this.mode !== 'dead' && !(this.mode === 'emerge' && this.emergeK < 0.25) && !(this.mode === 'sink' && this.rig.lift < -25); }

  zone(id: string): ThreatZone { return this.zones.find((z) => z.id === id) ?? this.zones[3]; }

  /** The zone of a capsule hit at a point (torso: back or belly by height; last neck segment: throat underneath). */
  private zoneOfHit(c: Capsule, x: number, y: number, z: number): ThreatZone {
    if (c.zone === 'body' || c.zone === 'throat') {
      const ux = c.bx - c.ax, uy = c.by - c.ay, uz = c.bz - c.az, L2 = ux * ux + uy * uy + uz * uz || 1;
      const t = Math.max(0, Math.min(1, ((x - c.ax) * ux + (y - c.ay) * uy + (z - c.az) * uz) / L2));
      const below = (c.ay + uy * t) - y;
      if (c.zone === 'throat') return below > c.r * 0.2 ? this.zone('throat') : this.zone('neck');
      return below > c.r * 0.35 ? this.zone('belly') : this.zone('back');
    }
    return this.zone(c.zone);
  }

  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): { t: number; zone: ThreatZone } | null {
    if (!this.targetable && this.mode !== 'dead') return null;
    const h = this.rig.ray(ox, oy, oz, dx, dy, dz, maxT);
    if (!h) return null;
    return { t: h.t, zone: this.zoneOfHit(h.cap, ox + dx * h.t, oy + dy * h.t, oz + dz * h.t) };
  }

  zoneAt(x: number, y: number, z: number): { zone: ThreatZone; d: number } | null {
    const n = this.rig.nearest(x, y, z);
    return n ? { zone: this.zoneOfHit(n.cap, x, y, z), d: n.d } : null;
  }

  damage(zone: ThreatZone | string | null, amount: number, src: DamageSource): DamageResult {
    if (this.defeated || this.mode === 'gone' || amount <= 0) return { dealt: 0, zone: null, weak: false };
    let Z: ThreatZone;
    if (typeof zone === 'string') Z = this.zone(zone);
    else if (zone) Z = zone;
    else Z = (src.x !== undefined ? this.zoneAt(src.x, src.y ?? this.y, src.z ?? this.z)?.zone : null) ?? this.zone('back');
    const weak = Z.weak && Z.exposed;
    const dealt = amount * (1 - (weak ? 0.05 : Z.armour)) * (weak ? STRIDER.weakMul : 1);
    this.hp = Math.max(0, this.hp - dealt);
    Z.recent += dealt;
    this.recentHit += dealt;
    this.stats.damage += dealt;
    if (weak) this.stats.weakHits++;
    const key = src.key ?? src.cause;
    this.aggro.set(key, (this.aggro.get(key) ?? 0) + dealt + amount * 0.02 + (src.aggro ?? 0));
    if (src.cause === 'player' && weak && dealt > 20) this.g.progress.addKarma(STRIDER.karma.weak, 'hit the monster where it hurts');
    this.react(Z, dealt, weak, src);
    return { dealt, zone: Z, weak };
  }

  blow(x: number, y: number, z: number, r: number, jx: number, jy: number, jz: number, src: DamageSource): DamageResult | null {
    if (!this.targetable) return null;
    const n = this.rig.nearest(x, y, z);
    if (!n || n.d > r + 0.5) return null;
    const J = Math.hypot(jx, jy, jz);
    const Z = this.zoneOfHit(n.cap, x, y, z);
    return this.damage(Z, J * DAMAGE_PER_IMPULSE, { ...src, x: src.x ?? x, y: src.y ?? y, z: src.z ?? z });
  }

  /** Shrink ray: the rig (skeleton, skin, hit capsules, reach) follows the size; blows soften via `dealtBy`. */
  setScale(s: number): void {
    this.sc = s;
    this.rig.scale = (STRIDER.height / 40) * s;
  }

  /** Fighting strength for the con: far beyond any person; a giant hero comes closer. */
  conStrength(): number {
    return 260 * Math.sqrt(Math.max(0.05, this.hp / this.maxHp));
  }

  /** Who it is angriest with (aggro key) and how much. */
  topAggro(): { key: string; v: number } | null {
    let best: { key: string; v: number } | null = null;
    for (const [key, v] of this.aggro) if (!best || v > best.v) best = { key, v };
    return best;
  }

  // ================================================================== ThreatEvent

  /** The share still in action: for one monster, its health (0 once beaten or gone). */
  strength(): number { return this.active ? this.hp / this.maxHp : 0; }

  /** Nothing of it is for officers on foot. */
  targetsNear(_x: number, _z: number, _r: number): ThreatTarget[] { return []; }
  strike(_t: ThreatTarget, _jx: number, _jy: number, _jz: number, _cause: Cause): void { /* nothing on foot reaches it */ }

  shutdown(): void {
    // The response cannot stop it by force: it goes back to the river when it is ready (driven off).
    if (this.mode === 'advance' || this.mode === 'rampage') this.startRetreat();
  }

  dispose(): void {
    // The body of a defeated monster stays (the director keeps it as remains); otherwise nothing is left.
  }

  snapshot(): Record<string, unknown> {
    return {
      id: this.id, archetype: this.archetype, t: +this.t.toFixed(1), active: this.active, outcome: this.outcome, mode: this.mode, act: this.act,
      x: Math.round(this.x), z: Math.round(this.z), hp: Math.round(this.hp), s: Math.round(this.s), route: Math.round(this.route.length),
      start: { x: Math.round(this.route.start.x), z: Math.round(this.route.start.z) }, end: { x: Math.round(this.route.end.x), z: Math.round(this.route.end.z) },
      rampage: this.rampage ? { t: Math.round(this.rampage.t), tower: this.rampage.ref ? Math.round(this.rampage.ref.top - this.rampage.ref.base) : null, onT: Math.round(this.rampage.onT), goal: [Math.round(this.rampage.x), Math.round(this.rampage.z)], done: this.rampage.done.size } : null,
      v: +this.v.toFixed(2), stuck: this.stuckN, direct: this.direct,
      hurt: this.hurt, aggro: Object.fromEntries([...this.aggro].map(([k, v]) => [k, Math.round(v)])), burning: this.g.threats.fires.list.length, ...this.stats,
    };
  }

  // ================================================================== frame

  update(dt: number): void {
    this.t += dt;
    if (this.mode === 'gone') return;
    const g = this.g, rig = this.rig;
    // Decay: the aggro table, recent hits per zone.
    for (const [k, v] of this.aggro) { const nv = v * Math.exp(-dt / 90); if (nv < 1) this.aggro.delete(k); else this.aggro.set(k, nv); }
    for (const Z of this.zones) Z.recent *= Math.exp(-dt / 4);
    this.recentHit *= Math.exp(-dt / 2);
    this.tokens = Math.min(STRIDER.smashBurst, this.tokens + dt * STRIDER.smashRate);
    this.recentBroken *= Math.exp(-dt / 3);
    for (const k of Object.keys(this.cool) as (keyof Strider['cool'])[]) this.cool[k] -= dt;
    let moved = 0;
    if (this.mode === 'dead') { this.finishDeath(dt); return; }
    if (this.mode === 'dying') this.dying(dt);
    else {
      this.decide(dt);
      this.doAct(dt);
      moved = this.locomote(dt);
    }
    rig.update(dt, moved);
    this.stats.walked += moved;
    // Event centre: the body's middle.
    const sp = rig.spine;
    this.x = sp[3]; this.y = sp[4]; this.z = sp[5];
    this.updateZones();
    this.water(dt);
    if (this.mode !== 'dying') this.contacts(dt);
    this.surroundings(dt);
  }

  /** What to do next (when not busy). */
  private decide(dt: number): void {
    const g = this.g, P = g.player.pos;
    if (this.mode === 'emerge') {
      this.emergeK = Math.min(1, this.emergeK + dt / STRIDER.emergeT);
      const k = this.emergeK;
      this.rig.lift = -STRIDER.sunk * (1 - k * k * (3 - 2 * k));
      if (k >= 1) { this.mode = 'advance'; this.startRoar(true); }
      return;
    }
    if (this.mode === 'sink') {
      this.rig.lift -= dt * 5.5;
      if (this.rig.lift < -STRIDER.sunk) this.finish('retreated');
      return;
    }
    if (this.hp <= 0) { this.startDying(); return; }
    // (Timers and the stuck check run while it is busy too: swatting the drones round its head
    // back to back used to freeze the rampage clock, and it stayed in town for good.)
    this.watch(dt);
    if (this.act) return;
    if ((this.mode === 'advance' || this.mode === 'rampage') && this.hp < this.maxHp * STRIDER.retreatAt) { this.startRetreat(); this.startRoar(false); return; }
    // Interest: the tallest building ahead (it is drawn to them).
    this.scanT -= dt;
    if (this.scanT <= 0) { this.scanT = 2.5; this.interest = this.tallAhead(140); }
    if (this.mode === 'advance' && this.s >= this.route.length - 12) { this.mode = 'rampage'; this.rampage = newRampage(this.x, this.z); }
    if (this.mode === 'rampage' && this.rampage) {
      const R = this.rampage;
      if (R.t > STRIDER.rampageT || R.done.size >= 5) {
        if (!this.stay) { this.startRetreat(); return; }
        R.t = 0; R.done.clear();
      }
      // (A tower it leaned on is done even while it still stands: the next one.)
      if (!R.ref || !R.ref.alive || R.done.has(R.ref)) {
        R.ref = null; R.onT = 0;
        R.seekT -= dt;
        if (R.seekT <= 0) {
          R.seekT = 2.5;
          R.ref = this.pickTower(R.done);
          if (R.ref) { const c = nearestOnPoly(R.ref.poly, this.x, this.z); R.x = c.x; R.z = c.z; }
        }
        if (!R.ref) this.roam(R, dt);
      }
    }
    // Swat what flies near its head.
    if (this.cool.swat <= 0 && this.mode !== 'retreat') {
      this.cool.swat = 0.6;
      const air = this.airNear(this.rig.headPos.x, this.rig.headPos.y, this.rig.headPos.z, 32);
      if (air) { this.swatT = air; this.begin('swat', 0.9); return; }
    }
    const hostile = this.hostileTarget();
    // Breath: at whoever hurt it, else at a tall building in front.
    if (this.cool.breath <= 0 && this.mode !== 'retreat') {
      const tgt = hostile ?? this.breathBuilding();
      if (tgt) { this.startCharge(tgt); return; }
      this.cool.breath = 4;
    }
    if (this.cool.roar <= 0) { this.startRoar(this.rng.chance(STRIDER.rearChance) && this.mode !== 'retreat'); return; }
    if (this.cool.swipe <= 0) {
      const side = this.swipeWorth();
      if (side) { this.swipeSide = side; this.begin('swipe', STRIDER.swipeT); this.swipeHit.clear(); this.stats.swipes++; this.g.audio.play('tree_crack_fall', this.x, this.y, this.z, 0.8, 0.5, 40, this.g.renderer.camera.position); return; }
      this.cool.swipe = 3;
    }
    if (this.cool.lean <= 0 && this.mode !== 'retreat') {
      const L = this.leanTarget();
      if (L) { this.startLean(L.ref, L.x, L.y, L.z); return; }
      this.cool.lean = 3;
    }
    void P;
  }

  private swatT: AirTarget | null = null;

  private begin(a: Act, dur: number): void { this.act = a; this.actT = dur; }

  // ---------------------------------------------------------------- actions

  private doAct(dt: number): void {
    const rig = this.rig, g = this.g;
    // Look: what it attends to.
    this.look(dt);
    // Glows die down unless it is charging or breathing.
    if (this.act !== 'charge' && this.act !== 'breath') { rig.throat += (0 - rig.throat) * Math.min(1, dt * 2); rig.ridge += (0 - rig.ridge) * Math.min(1, dt * 1.2); }
    if (!this.act) { rig.jaw += (0 - rig.jaw) * Math.min(1, dt * 3); rig.sweep *= Math.exp(-dt * 3); this.rearStep(dt); return; }
    this.actT -= dt;
    switch (this.act) {
      case 'roar': {
        const T = STRIDER.roarT, k = 1 - this.actT / T;
        rig.jaw += ((k > 0.1 && k < 0.85 ? 1 : 0) - rig.jaw) * Math.min(1, dt * 6);
        if (this.rearing) rig.rear = Math.min(1, rig.rear + dt * 0.9);
        if (this.actT <= 0) { this.act = null; if (this.rearing) this.rearT = 1.6; }
        break;
      }
      case 'charge': {
        const k = 1 - this.actT / STRIDER.chargeT;
        rig.ridge = Math.min(1, k * 1.05);
        rig.throat = Math.min(1, k * k * 1.2);
        rig.jaw += (0.25 - rig.jaw) * Math.min(1, dt * 2);
        this.zone('throat').exposed = true;
        // Motes gathering at the mouth.
        const m = rig.mouth;
        for (let i = 0; i < 3; i++) {
          const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 6;
          const px = m.x + Math.cos(a) * r, py = m.y + (Math.random() - 0.5) * 6, pz = m.z + Math.sin(a) * r;
          g.elements.fx.glow(px, py, pz, (m.x - px) * 1.6, (m.y - py) * 1.6, (m.z - pz) * 1.6, 0.6, 0.6, 0.2, BEAM_HOT, BEAM_END, 0.8, 0.5, 0);
        }
        if (this.actT <= 0) this.startBreath();
        break;
      }
      case 'breath': this.breathe(dt); break;
      case 'swipe': {
        const T = STRIDER.swipeT, k = 1 - this.actT / T;
        // Wind up a little to the other side, sweep through, settle back.
        const sweep = k < 0.18 ? -0.35 * (k / 0.18) : k < 0.55 ? -0.35 + 1.35 * ((k - 0.18) / 0.37) : 1 - (k - 0.55) / 0.45;
        rig.sweep = sweep * this.swipeSide;
        if (k > 0.18 && k < 0.75) this.swipeHits();
        if (this.actT <= 0) { this.act = null; this.cool.swipe = this.rng.range(STRIDER.swipeGap[0], STRIDER.swipeGap[1]); }
        break;
      }
      case 'lean': this.leaning(dt); break;
      case 'stagger': {
        // Sways and sags, the hurt side lower.
        rig.lift = -2.2 * Math.sin(Math.min(1, (STRIDER.staggerT - this.actT) / STRIDER.staggerT) * Math.PI);
        rig.jaw += (0.6 - rig.jaw) * Math.min(1, dt * 4);
        if (this.actT <= 0) { this.act = null; rig.lift = 0; }
        break;
      }
      case 'swat': {
        const a = this.swatT;
        rig.jaw += (1 - rig.jaw) * Math.min(1, dt * 8);
        if (a) { rig.look.x = a.x; rig.look.y = a.y; rig.look.z = a.z; rig.lookW = 1; }
        if (this.actT < 0.45 && a) {
          const h = rig.headPos;
          const dx = a.x - h.x, dy = a.y - h.y, dz = a.z - h.z, l = Math.hypot(dx, dy, dz) || 1;
          a.swat((dx / l) * 900, (dy / l) * 400 - 300, (dz / l) * 900);
          this.stats.swats++;
          g.audio.play('punch_impact', a.x, a.y, a.z, 1, 0.45, 30, g.renderer.camera.position);
          this.swatT = null;
        }
        if (this.actT <= 0) this.act = null;
        break;
      }
    }
    if (this.act !== 'roar') this.rearStep(dt);
    if (this.act !== 'charge' && this.act !== 'breath') this.zone('throat').exposed = false;
  }

  /** Rearing: up during a rearing roar, then down — the forefeet slam (a landing at its size). */
  private rearStep(dt: number): void {
    const rig = this.rig;
    this.zone('belly').exposed = rig.rear > 0.45;
    if (this.act === 'roar' && this.rearing) return;
    if (this.rearT > 0) { this.rearT -= dt; return; }
    if (rig.rear > 0) {
      const before = rig.rear;
      rig.rear = Math.max(0, rig.rear - dt * 1.6);
      if (before > 0.15 && rig.rear <= 0.15 && this.rearing) {
        this.rearing = false;
        // Forefeet come down.
        for (const L of rig.legs) if (L.def.at === 'front') {
          const E = this.stepE * 3;
          this.stats.broken += this.g.interactions.steps.land(L.foot.x, L.foot.y, L.foot.z, E, this.height, { cause: 'threat', own: false, sound: 'strider_step', ref: 90, maxR: 500, foot: 5 });
          this.hurtPlayerNear(L.foot.x, L.foot.z, 9, 40, 9);
          this.onBlow?.('slam', L.foot.x, L.foot.y, L.foot.z, 9);
        }
      }
    }
    // Forelegs off the ground while reared.
    for (const L of rig.legs) if (L.def.at === 'front') {
      if (rig.rear > 0.2) {
        const j = 1, sp = rig.spine;
        L.pin = L.pin ?? { x: 0, y: 0, z: 0 };
        L.pin.x = sp[j * 3] + rig.fx * 6 + rig.rx * L.def.side * 7; L.pin.y = sp[j * 3 + 1] - 12; L.pin.z = sp[j * 3 + 2] + rig.fz * 6 + rig.rz * L.def.side * 7;
      } else if (this.act !== 'lean' && L.pin) { L.pin = null; L.plant.x = L.foot.x; L.plant.z = L.foot.z; L.plant.y = rig.ground(L.foot.x, L.foot.z); }
    }
  }

  private get mass(): number { return bodyMass(STRIDER.height, STRIDER.build); }
  /** What a footfall carries: the full-size body's, softened while shrunk (`dealtBy`). */
  private get stepE(): number { return stepEnergy(this.mass, STRIDER.height) * dealtBy(this); }

  private startRoar(rear: boolean): void {
    const g = this.g;
    this.begin('roar', STRIDER.roarT);
    this.rearing = rear;
    this.stats.roars++;
    if (rear) this.stats.rears++;
    this.cool.roar = this.rng.range(STRIDER.roarGap[0], STRIDER.roarGap[1]);
    const h = this.rig.headPos;
    g.audio.play('strider_roar', h.x, h.y, h.z, 1, 0.95 + this.rng.range(0, 0.1), 140, g.renderer.camera.position);
    g.stimuli.emit('roar', h.x, h.y, h.z, 9, 700, { cause: 'threat', size: this.height });
    this.onBlow?.('roar', h.x, h.y, h.z, 300);
    const d = Math.hypot(g.player.pos.x - h.x, g.player.pos.z - h.z);
    if (d < 350) g.camRig.addShake(0.35 * (1 - d / 350));
  }

  private startCharge(tgt: { kind: 'player' | 'building' | 'point'; x: number; y: number; z: number }): void {
    const g = this.g;
    this.begin('charge', STRIDER.chargeT);
    this.breathTarget = tgt.kind;
    this.aimP.set(tgt.x, tgt.y, tgt.z);
    const m = this.rig.mouth;
    g.audio.play('strider_charge', m.x, m.y, m.z, 1, 1, 70, g.renderer.camera.position);
    this.lastSound.charge = this.t;
  }

  private startBreath(): void {
    const g = this.g, m = this.rig.mouth;
    this.begin('breath', STRIDER.breathT);
    this.stats.breaths++;
    this.beamTick = 0;
    // Sweep across the target, sideways to the line of fire.
    const dx = this.aimP.x - m.x, dz = this.aimP.z - m.z, l = Math.hypot(dx, dz) || 1;
    this.aimSide.set(-dz / l, 0, dx / l);
    g.audio.play('strider_breath', m.x, m.y, m.z, 1, 1, 80, g.renderer.camera.position);
    g.stimuli.emit('power', this.aimP.x, this.aimP.y, this.aimP.z, 8, 220, { cause: 'threat' });
  }

  private breathe(dt: number): void {
    const g = this.g, rig = this.rig, m = rig.mouth;
    if (this.actT <= 0) { this.act = null; this.cool.breath = this.rng.range(STRIDER.breathGap[0], STRIDER.breathGap[1]); return; }
    const T = STRIDER.breathT, k = 1 - this.actT / T;
    rig.ridge = 1; rig.throat = 1; rig.jaw += (0.85 - rig.jaw) * Math.min(1, dt * 6);
    this.zone('throat').exposed = true;
    // Track the player when that is the target.
    if (this.breathTarget === 'player') { const p = g.player.pos; this.aimP.lerp(_v.set(p.x, p.y + g.player.height * 0.5, p.z), Math.min(1, dt * 1.5)); }
    const sweep = Math.sin((k - 0.5) * Math.PI) * 14;
    const ax = this.aimP.x + this.aimSide.x * sweep, ay = this.aimP.y + Math.sin(k * 9) * 2, az = this.aimP.z + this.aimSide.z * sweep;
    let dx = ax - m.x, dy = ay - m.y, dz = az - m.z;
    const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
    const range = STRIDER.breathRange;
    const h = g.targeting.probe(m.x, m.y, m.z, dx, dy, dz, range, null, NO_KINDS);
    const t = h.what === 'none' ? range : h.t;
    const ex = m.x + dx * t, ey = m.y + dy * t, ez = m.z + dz * t;
    this.beamEnd.set(ex, ey, ez);
    // The beam: a hot core and a wide glow; motes along it; fire and smoke where it lands.
    const fx = g.elements.fx;
    const on = Math.min(1, k * 8) * Math.min(1, this.actT * 4);
    fx.seg(m.x, m.y, m.z, ex, ey, ez, 2.4 * on + 0.3, BEAM_HOT.r, BEAM_HOT.g, BEAM_HOT.b, 2.4, BeamStyle.Laser);
    fx.seg(m.x, m.y, m.z, ex, ey, ez, 6.5 * on + 0.5, 0.25, 0.5, 1.2, 1.1, BeamStyle.Fire);
    for (let i = 0; i < 4; i++) {
      const u = Math.random();
      fx.glow(m.x + dx * t * u, m.y + dy * t * u, m.z + dz * t * u, (Math.random() - 0.5) * 4, Math.random() * 3, (Math.random() - 0.5) * 4, 0.4, 1.2, 0.3, BEAM_HOT, BEAM_END, 0.7, 1, 0);
    }
    if (h.what !== 'none') {
      for (let i = 0; i < 4; i++) fx.glow(ex, ey, ez, (h.nx + (Math.random() - 0.5) * 1.4) * 9, (h.ny + Math.random()) * 9, (h.nz + (Math.random() - 0.5) * 1.4) * 9, 0.7, 1.5, 3.5, FIRE_HOT, FIRE_END, 0.8, 1.6, -2);
      if (Math.random() < 0.5) fx.soft(ex + h.nx, ey + h.ny, ez + h.nz, h.nx * 2, 3, h.nz * 2, 3.5, 2, 9, SMOKE, SMOKE_L, 0.5, 0.5, -0.8);
    }
    // Damage ticks: heat on the facade (windows burst, panels break), fires, what stands there burns.
    this.beamTick -= dt;
    if (this.beamTick > 0 || on < 0.5) return;
    this.beamTick = STRIDER.breathTick;
    this.onBlow?.('breath', ex, ey, ez, 9);
    if (h.what === 'building' || h.what === 'roof' || h.what === 'ground') {
      if (h.what !== 'ground') this.smash(ex - h.nx * 0.2, ey, ez - h.nz * 0.2, STRIDER.breathR, STRIDER.breathHeat, dx, dy, dz);
      this.igniteT -= STRIDER.breathTick;
      if (this.igniteT <= 0) {
        this.igniteT = 0.35;
        if (h.what === 'building') { g.threats.fires.ignite(ex + h.nx * 0.3, ey, ez + h.nz * 0.3, h.nx, h.nz, 3.5, this.rng.range(90, 150)); this.stats.fires++; }
        g.elements.fx.decal(DecalKind.Scorch, ex, ey, ez, h.nx, h.ny, h.nz, 7, 7, Math.random() * 6, 60);
      }
    }
    // People, cars and things where it lands burn and are thrown; the player takes it hard.
    g.targeting.inSphere(ex, ey, ez, 7, (tg) => {
      switch (tg.kind) {
        case 'person': {
          const a = tg.obj;
          statusFor(a).burning = Math.max(statusFor(a).burning, 6);
          if (a.state !== PState.Down) { this.knock(a, ex, ez, 6); g.consequences.record('strider', 'person', 'burn', a.x, a.z, a, 'threat'); }
          break;
        }
        case 'car': {
          const v = tg.obj;
          statusFor(v).burning = Math.max(statusFor(v).burning, 12);
          if (v.state !== VState.Wreck && v.state !== VState.Crushed) { this.wreckCar(v, dx * 6000, 9000, dz * 6000); }
          break;
        }
        case 'prop': if (tg.obj.tree) statusFor(tg.obj).burning = 8; break;
        default: break;
      }
    });
    const pd = segDist(g.player.pos.x, g.player.pos.y + g.player.height * 0.5, g.player.pos.z, m.x, m.y, m.z, ex, ey, ez);
    if (pd < 4 + g.player.radius) this.hurtPlayer(18, m.x, m.z, ey, 4);
  }

  private startLean(ref: BuildingRef, x: number, y: number, z: number): void {
    this.begin('lean', STRIDER.leanT);
    this.leanRef = ref;
    this.leanP.set(x, y, z);
    this.stats.leans++;
    // The forefoot on the side of the building.
    const rig = this.rig;
    const side = (x - this.x) * rig.rx + (z - this.z) * rig.rz > 0 ? 1 : -1;
    this.leanLeg = rig.legs.findIndex((L) => L.def.at === 'front' && L.def.side === side);
    this.leanTick = 0.8;
  }

  private leaning(dt: number): void {
    const g = this.g, rig = this.rig, ref = this.leanRef;
    const L = rig.legs[this.leanLeg];
    const k = 1 - this.actT / STRIDER.leanT;
    if (L) {
      L.pin = L.pin ?? { x: L.foot.x, y: L.foot.y, z: L.foot.z };
      const up = Math.min(1, k * 3);
      L.pin.x += (this.leanP.x - L.pin.x) * Math.min(1, dt * 3); L.pin.z += (this.leanP.z - L.pin.z) * Math.min(1, dt * 3);
      L.pin.y += (L.plant.y + (this.leanP.y - L.plant.y) * up - L.pin.y) * Math.min(1, dt * 3);
    }
    rig.look.x = this.leanP.x; rig.look.y = this.leanP.y + 8; rig.look.z = this.leanP.z; rig.lookW = 0.7;
    this.leanTick -= dt;
    if (this.leanTick <= 0 && ref && k > 0.25) {
      this.leanTick = 0.45;
      const dx = this.leanP.x - this.x, dz = this.leanP.z - this.z, l = Math.hypot(dx, dz) || 1;
      // Push: the foot on the facade, then (a small building) low down, so it comes down.
      const n1 = this.smash(this.leanP.x, this.leanP.y, this.leanP.z, 4, 6e5, dx / l, -0.3, dz / l);
      let n2 = 0;
      if (ref.top - ref.base < 26) n2 = this.smash(this.leanP.x, ref.base + 3, this.leanP.z, 4.5, 8e5, dx / l, 0, dz / l);
      if (n1 + n2 > 0) g.camRig.addShake(Math.min(0.3, 40 / Math.max(40, Math.hypot(g.player.pos.x - this.leanP.x, g.player.pos.z - this.leanP.z))));
      g.dust.burst(this.leanP.x, this.leanP.y, this.leanP.z, 10, 4, 4, 4, 5, DUST, 0.3, 0.5);
    }
    if (this.actT <= 0) {
      this.act = null;
      if (L && L.pin) { L.pin = null; L.plant.x = L.foot.x; L.plant.z = L.foot.z; L.plant.y = rig.ground(L.foot.x, L.foot.z); }
      this.cool.lean = STRIDER.leanGap + this.rng.range(0, 8);
      if (this.rampage && ref) this.rampage.done.add(ref);
      this.leanRef = null;
    }
  }

  /** The tail sweep: capsules of the outer tail against everything there. */
  private swipeHits(): void {
    const g = this.g, rig = this.rig, T = rig.tail, nT = STRIDER_RIG.tail.length;
    const sx = rig.rx * this.swipeSide, sz = rig.rz * this.swipeSide;
    for (let i = 2; i < nT; i++) {
      const ax = T[i * 3], ay = T[i * 3 + 1], az = T[i * 3 + 2], bx = T[i * 3 + 3], by = T[i * 3 + 4], bz = T[i * 3 + 5];
      const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2;
      const r = STRIDER_RIG.tailR[i] * rig.scale + 1.5;
      const J = 2.2e4 * (0.5 + i / nT);
      // Facades.
      const ref = g.world.buildingAt(mx, mz);
      const key = ref ? ref : null;
      if (ref && my < ref.top && (this.swipeHit.get(key!) ?? -9) < this.t - 0.25) {
        this.swipeHit.set(key!, this.t);
        this.smash(mx, my, mz, r + 1, 4e5, sx, 0, sz);
      }
      // Cars: flung.
      for (const v of [...g.traffic.vehicles, ...g.parkedCars]) {
        if (this.swipeHit.has(v) || Math.hypot(v.x - mx, v.z - mz) > r + v.length * 0.5 || v.y > my + r) continue;
        this.swipeHit.set(v, this.t);
        this.wreckCar(v, sx * J * 1.4, J * 0.9, sz * J * 1.4);
        g.audio.play('car_crash', v.x, v.y, v.z, 0.9, 0.9, 12, g.renderer.camera.position);
      }
      // People: thrown.
      for (const a of g.peds.neighbours(mx, mz, r + 1, [])) {
        if (this.swipeHit.has(a) || a.inside || a.state === PState.Down || Math.abs(a.y - my) > r + 2) continue;
        this.swipeHit.set(a, this.t);
        this.knock(a, a.x - sx * 2, a.z - sz * 2, 10);
      }
      g.props.hit(mx, my, mz, r, sx * J, J * 0.3, sz * J);
      g.future.hit(mx, my, mz, r, sx * J * 0.2, J * 0.1, sz * J * 0.2);
      this.onBlow?.('swipe', mx, my, mz, r + 2);
      // The player.
      const p = g.player.pos;
      if (!this.swipeHit.has(g.player) && Math.hypot(p.x - mx, p.z - mz) < r + g.player.radius && p.y < my + r && p.y > my - r) {
        this.swipeHit.set(g.player, this.t);
        this.hurtPlayer(45, mx - sx * 3, mz - sz * 3, my, 16);
      }
    }
  }

  // ---------------------------------------------------------------- moving

  private locomote(dt: number): number {
    const rig = this.rig;
    if (this.mode === 'emerge' || this.mode === 'sink') { if (!this.sinkHere) { rig.x = this.route.start.x; rig.z = this.route.start.z; } return 0; }
    const factor = this.act === null ? 1 : this.act === 'swipe' ? 0.35 : this.act === 'swat' ? 0.5 : 0;
    const pace = walkSpeed(this.height, STRIDER.pace) * factor * (this.mode === 'retreat' ? 1.1 : 1) * (0.55 + 0.45 * Math.max(0.3, this.hp / this.maxHp));
    // Goal: along the route ahead (back on retreat), or the tower it is after.
    let gx: number, gz: number;
    let stop = false;
    if (this.mode === 'rampage' && this.rampage) {
      const R = this.rampage;
      gx = R.x; gz = R.z;
      if (Math.hypot(gx - this.x, gz - this.z) < (R.ref ? 28 : 20)) stop = true;
    } else if (this.mode === 'retreat' && this.direct) {
      gx = this.route.start.x; gz = this.route.start.z;
      if (Math.hypot(gx - this.x, gz - this.z) < 25) { this.mode = 'sink'; this.g.audio.play('splash_big', rig.x, 2, rig.z, 1, 0.5, 80, this.g.renderer.camera.position); return 0; }
    } else if (this.mode === 'retreat') {
      routeAt(this.route, Math.max(0, this.s - 24), _r); gx = _r.x; gz = _r.z;
      if (this.s <= Math.max(this.route.landS, 6) + 4) { this.mode = 'sink'; this.g.audio.play('splash_big', rig.x, 2, rig.z, 1, 0.5, 80, this.g.renderer.camera.position); return 0; }
    } else {
      routeAt(this.route, Math.min(this.route.length, this.s + 24), _r); gx = _r.x; gz = _r.z;
      if (this.s >= this.route.length - 2) stop = true;
    }
    const want = Math.atan2(-(gx - rig.x), -(gz - rig.z));
    let d = want - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    // Look at a breath target / swat: turn the body towards it too.
    if ((this.act === 'charge' || this.act === 'breath') && this.breathTarget !== 'point') {
      const m = this.aimP;
      d = Math.atan2(-(m.x - rig.x), -(m.z - rig.z)) - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
    }
    const turn = Math.max(-STRIDER.turnRate * dt, Math.min(STRIDER.turnRate * dt, d));
    this.yaw += turn;
    rig.yaw = this.yaw;
    const target = stop ? 0 : pace * Math.max(0.2, Math.cos(Math.min(Math.PI / 2, Math.abs(d))));
    this.v += (target - this.v) * Math.min(1, dt * 0.7);
    const step = this.v * dt;
    rig.x += rig.fx * step; rig.z += rig.fz * step;
    // Progress: the nearest route point around where it was.
    if (this.mode !== 'rampage') this.s = nearestS(this.route, rig.x, rig.z, this.s);
    return step;
  }

  /**
   * Never stuck in one place: walking (in or back) but hardly getting anywhere for a while — busy
   * swatting the drones round its head, a route doubling back on itself — it moves on: into town,
   * or straight for the river; still stuck, it sinks where it stands. Every visit also ends after
   * STRIDER.visitMax.
   */
  private watch(dt: number): void {
    if ((this.mode === 'advance' || this.mode === 'rampage') && this.t > STRIDER.visitMax && !this.stay) { this.startRetreat(); return; }
    if (this.mode === 'rampage' && this.rampage) {
      const R = this.rampage;
      R.t += dt;
      if (R.t > STRIDER.rampageT + 30 && !this.stay) { this.startRetreat(); return; }
      // A tower it cannot bring down (or never gets to lean on): the next one.
      R.onT = R.ref ? R.onT + dt : 0;
      if (R.ref && R.onT > STRIDER.towerMax) { R.done.add(R.ref); R.ref = null; R.onT = 0; }
    }
    if (this.mode !== 'advance' && this.mode !== 'retreat') { this.watchT = 0; this.watchX = this.x; this.watchZ = this.z; return; }
    this.watchT += dt;
    if (this.watchT < 40) return;
    const moved = Math.hypot(this.x - this.watchX, this.z - this.watchZ);
    this.watchT = 0; this.watchX = this.x; this.watchZ = this.z;
    if (moved > 20) { this.stuckN = 0; return; }
    this.stuckN++;
    if (this.mode === 'advance') { this.mode = 'rampage'; this.rampage = newRampage(this.x, this.z); }
    else if (!this.direct) this.direct = true;
    else { this.mode = 'sink'; this.sinkHere = true; this.g.audio.play('tremor_rumble', this.x, 2, this.z, 1, 0.6, 80, this.g.renderer.camera.position); }
  }
  private watchT = 0;
  private watchX = 0;
  private watchZ = 0;
  private stuckN = 0;
  /** Retreat straight for the river (the route back got it nowhere). */
  private direct = false;
  /** Sinking where it stands (stuck on the way back), not at the river spot it rose from. */
  private sinkHere = false;

  private startRetreat(): void {
    if (this.mode === 'retreat' || this.mode === 'sink' || this.defeated) return;
    this.mode = 'retreat';
    this.rampage = null;
    // Back along the way it came (from wherever it is: the nearest route point).
    this.s = nearestS(this.route, this.rig.x, this.rig.z, this.s, 400);
    if (this.hp < this.maxHp * STRIDER.retreatAt) {
      const top = this.topAggro();
      if (top?.key === 'player') { this.g.progress.addKarma(STRIDER.karma.retreat, 'drove the monster back'); this.g.crime.rep.add(6, 'monster driven off'); }
    }
  }

  private look(dt: number): void {
    const rig = this.rig, g = this.g;
    let w = 0;
    if (this.act === 'charge' || this.act === 'breath') { rig.look.x = this.aimP.x; rig.look.y = this.aimP.y; rig.look.z = this.aimP.z; w = 1; }
    else if (this.act === 'roar') {
      const tgt = this.hostileTarget();
      const h = rig.headPos;
      rig.look.x = tgt ? tgt.x : h.x + rig.fx * 40; rig.look.y = h.y + (this.rearing ? 60 : 30); rig.look.z = tgt ? tgt.z : h.z + rig.fz * 40; w = 0.9;
    } else if (this.act === 'swat' || this.act === 'lean') return;
    else {
      const tgt = this.hostileTarget();
      const p = g.player.pos;
      if (tgt) { rig.look.x = tgt.x; rig.look.y = tgt.y; rig.look.z = tgt.z; w = 0.8; }
      else if (this.interest) { rig.look.x = this.interest.x; rig.look.y = this.interest.y; rig.look.z = this.interest.z; w = 0.55; }
      else if (Math.hypot(p.x - this.x, p.z - this.z) < 160 && Math.sin(this.t * 0.21) > 0.2) { rig.look.x = p.x; rig.look.y = p.y + 2; rig.look.z = p.z; w = 0.6; }
    }
    rig.lookW += (w - rig.lookW) * Math.min(1, dt * 2);
  }

  // ---------------------------------------------------------------- targets and choices

  /**
   * Whoever hurt it most among those near enough to go for: the player, or one of the army's squads
   * (`unitAt`; tanks far down the avenue are out of reach — then the next one).
   */
  private hostileTarget(): { kind: 'player' | 'point'; x: number; y: number; z: number } | null {
    const g = this.g, p = g.player.pos;
    const at = (key: string) => (key === 'player' ? { x: p.x, y: p.y + g.player.height * 0.5, z: p.z } : this.unitAt?.(key) ?? this.keyAt?.(key) ?? null);
    const t = angriestInReach(this.aggro, at, this.x, this.z, STRIDER.breathRange * 0.95);
    return t ? { kind: t.key === 'player' ? 'player' : 'point', x: t.x, y: t.y, z: t.z } : null;
  }

  /** A tall building ahead to breathe fire at: a point on its facade, two thirds up. */
  private breathBuilding(): { kind: 'building'; x: number; y: number; z: number } | null {
    const best = this.tallAhead(160, 22);
    if (!best) return null;
    return { kind: 'building', x: best.x, y: best.y, z: best.z };
  }

  /** The tallest building within r ahead (±70°): a facade point facing the monster, two thirds up. */
  private tallAhead(r: number, minH = 30): { x: number; y: number; z: number; ref: BuildingRef } | null {
    const g = this.g, rig = this.rig, hx = rig.headPos.x, hz = rig.headPos.z;
    let best: { x: number; y: number; z: number; ref: BuildingRef } | null = null, bh = minH;
    for (const ref of g.world.buildingsIn(hx - r, hz - r, hx + r, hz + r)) {
      if (!ref.alive) continue;
      const H = ref.top - ref.base;
      if (H < bh) continue;
      const c = nearestOnPoly(ref.poly, hx, hz);
      const dx = c.x - hx, dz = c.z - hz, d = Math.hypot(dx, dz);
      if (d > r || d < 12) continue;
      if ((dx * rig.fx + dz * rig.fz) / d < 0.34) continue;
      bh = H;
      best = { x: c.x, y: ref.base + H * 0.66, z: c.z, ref };
    }
    return best;
  }

  /** Downtown: the next tower to go for (tall, near, not done yet). */
  private pickTower(done: Set<BuildingRef>): BuildingRef | null {
    // A tower near, else one further off; away from the high-rises (held up on the way in), lower blocks do.
    return this.pickTowerOf(done, 220, 20) ?? this.pickTowerOf(done, 420, 20) ?? this.pickTowerOf(done, 200, 9);
  }

  /**
   * No building to go for (none left near, or the city there not streamed in): it never stands
   * about — it goes for whoever fights it (the army, the player), else into downtown (the end of
   * its route), else roams to a new spot now and then.
   */
  private roam(R: Rampage, dt: number): void {
    const hostile = this.hostileTarget();
    if (hostile) { R.x = hostile.x; R.z = hostile.z; R.roamT = 0; return; }
    R.roamT -= dt;
    const there = Math.hypot(R.x - this.x, R.z - this.z) < 20;
    if (R.roamT > 0 && !there) return;
    R.roamT = STRIDER.roamT;
    const E = this.route.end;
    if (Math.hypot(E.x - this.x, E.z - this.z) > 90) { R.x = E.x; R.z = E.z; return; }
    const a = this.rng.range(0, Math.PI * 2), d = this.rng.range(80, 160);
    R.x = E.x + Math.cos(a) * d; R.z = E.z + Math.sin(a) * d;
  }
  private pickTowerOf(done: Set<BuildingRef>, r: number, minH: number): BuildingRef | null {
    const g = this.g;
    let best: BuildingRef | null = null, bs = -Infinity;
    for (const ref of g.world.buildingsIn(this.x - r, this.z - r, this.x + r, this.z + r)) {
      if (!ref.alive || done.has(ref)) continue;
      const H = ref.top - ref.base;
      if (H < minH) continue;
      const c = nearestOnPoly(ref.poly, this.x, this.z);
      const s = H - Math.hypot(c.x - this.x, c.z - this.z) * 0.25;
      if (s > bs) { bs = s; best = ref; }
    }
    return best;
  }

  /** A building beside the chest to lean on: the point on its facade at shoulder height. */
  private leanTarget(): { ref: BuildingRef; x: number; y: number; z: number } | null {
    const g = this.g, rig = this.rig, sp = rig.spine;
    const cx = sp[3] + rig.fx * 8, cz = sp[5] + rig.fz * 8, R = STRIDER.leanReach;
    let best: { ref: BuildingRef; x: number; y: number; z: number } | null = null, bd = R;
    for (const ref of g.world.buildingsIn(cx - R, cz - R, cx + R, cz + R)) {
      if (!ref.alive || ref.top - ref.base < 12) continue;
      const c = nearestOnPoly(ref.poly, cx, cz);
      const d = Math.hypot(c.x - cx, c.z - cz);
      if (d < bd) { bd = d; best = { ref, x: c.x, y: Math.min(ref.top - 2, ref.base + 14), z: c.z }; }
    }
    if (!best) return null;
    // In downtown it goes for the tower it is after; on the way it leans on what it passes, now and then.
    if (this.rampage?.ref && best.ref !== this.rampage.ref) return null;
    return best;
  }

  /** Is a tail swipe worth it (and to which side)? The player near the tail, or cars / buildings beside it. */
  private swipeWorth(): number {
    const g = this.g, rig = this.rig, T = rig.tail, i = 5;
    const tx = T[i * 3], tz = T[i * 3 + 2];
    const p = g.player.pos;
    const side = (x: number, z: number) => ((x - tx) * rig.rx + (z - tz) * rig.rz > 0 ? 1 : -1);
    if (Math.hypot(p.x - tx, p.z - tz) < 30) return side(p.x, p.z);
    let l = 0, r = 0;
    for (const v of g.traffic.vehicles) if (Math.hypot(v.x - tx, v.z - tz) < 26) { if (side(v.x, v.z) > 0) r++; else l++; }
    for (const ref of g.world.buildingsIn(tx - 22, tz - 22, tx + 22, tz + 22)) { const c = nearestOnPoly(ref.poly, tx, tz); if (Math.hypot(c.x - tx, c.z - tz) < 18) { if (side(c.x, c.z) > 0) r += 2; else l += 2; } }
    if (l + r < 2 && this.rng.float() < 0.6) return 0;
    return r >= l ? 1 : -1;
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

  // ---------------------------------------------------------------- effects on the world

  /**
   * A destruction impact of the monster's, within its budget (−1: skipped, out of tokens). With many
   * panels broken lately the blow is softened (windows burst, walls crack, fewer come down).
   */
  private smash(x: number, y: number, z: number, r: number, J: number, dx: number, dy: number, dz: number, kind: 'wall' | 'stomp' = 'wall', cost = 1): number {
    if (this.tokens < cost) return -1;
    this.tokens -= cost;
    const soft = this.recentBroken > STRIDER.panelsSoft ? 0.35 : 1;
    const k = this.sc, J2 = J * soft * dealtBy(this);
    const n = this.g.destruction.as('threat', () => this.g.destruction.impact(x, y, z, r * k * (soft < 1 ? 0.7 : 1), J2, dx, dy, dz, kind));
    this.stats.impacts++;
    this.stats.broken += n;
    this.recentBroken += n;
    if (n) this.g.consequences.record('strider', 'building', 'facade', x, z, undefined, 'threat');
    return n;
  }

  private footstep(leg: number, x: number, y: number, z: number): void {
    const g = this.g;
    if (this.mode === 'emerge' && this.rig.lift < -20) return;
    this.stats.steps++;
    this.stepN++;
    const E = this.stepE;
    // Who is under the foot (the stomp handlers knock them down; count them as hurt).
    const r = this.height * 0.09;
    for (const a of g.peds.neighbours(x, z, r + 1, [])) if (a.state !== PState.Down && !a.inside && Math.hypot(a.x - x, a.z - z) < r) this.hurt++;
    let cars = 0;
    for (const v of [...g.traffic.vehicles, ...g.parkedCars]) if (v.state !== VState.Crushed && Math.hypot(v.x - x, v.z - z) < r + v.length * 0.3) cars++;
    this.stats.crushedCars += cars;
    const wet = g.terrain.waterLevel(x, z);
    g.interactions.steps.footstep(x, y, z, E, this.height, { cause: 'threat', own: false, sound: 'strider_step', ref: 60, maxR: 420, impact: false });
    // What is under the foot breaks (kerbs, paving, a ground floor it comes down beside), within the budget.
    if (g.world.buildingsIn(x - 6, z - 6, x + 6, z + 6).length) this.smash(x, y + 2, z, 3.6, Math.sqrt(E) * 80, 0, -1, 0, 'stomp', 0.5);
    // A foot coming down on a low building: through the roof.
    const ref = g.world.buildingAt(x, z);
    if (ref && ref.alive && this.smash(x, ref.base + 3, z, 4.5, 7e5, 0, -1, 0, 'stomp', 1.5) >= 0 && ref.top - ref.base < 14) g.destruction.as('threat', () => g.destruction.crushAt(ref, ref.top));
    if (wet > y) {
      // In the water: a splash and foam.
      g.dust.burst(x, wet + 0.5, z, 18, 4, 6, 3, 2.5, FOAM, -0.2, 0.7);
      for (let i = 0; i < 10; i++) g.elements.fx.soft(x + (Math.random() - 0.5) * 6, wet + 0.5, z + (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 8, 6 + Math.random() * 8, (Math.random() - 0.5) * 8, 1.6, 1.2, 3, WATER_A, WATER_B, 0.6, 0.3, 9.8);
      if (this.stepN % 2 === 0) g.audio.play('splash_big', x, wet, z, 0.8, 0.6, 30, g.renderer.camera.position);
    }
    // Far away it is a tremor (birds lift, people look round).
    if (this.stepN % 2 === 0) g.stimuli.emit('tremor', x, y, z, 5, 1100, { cause: 'threat', size: this.height });
    this.hurtPlayerNear(x, z, 7, 30, 6);
    this.onBlow?.('step', x, y, z, this.height * 0.12);
    void leg;
  }

  /** Facades the body shoulders into, cars and people its legs and belly run over. */
  private contacts(dt: number): void {
    const g = this.g, rig = this.rig;
    if (this.mode === 'emerge' && this.emergeK < 0.6) return;
    this.contactBudget = Math.min(STRIDER.contactRate, this.contactBudget + dt * STRIDER.contactRate);
    this.contactT -= dt;
    if (this.contactT > 0) return;
    this.contactT = 0.2;
    const sp = rig.spine, nS = STRIDER_RIG.spine.length;
    // Torso sides and shoulders, and the knees.
    const pts: [number, number, number, number, number][] = [];
    for (let i = 0; i < nS; i++) {
      const mx = (sp[i * 3] + sp[i * 3 + 3]) / 2, my = (sp[i * 3 + 1] + sp[i * 3 + 4]) / 2, mz = (sp[i * 3 + 2] + sp[i * 3 + 5]) / 2;
      const r = STRIDER_RIG.spineR[i] * rig.scale;
      for (const s of [-1, 1]) pts.push([mx + rig.rx * r * s, my - r * 0.2, mz + rig.rz * r * s, rig.rx * s, rig.rz * s]);
    }
    for (const L of rig.legs) pts.push([L.knee.x, L.knee.y, L.knee.z, L.knee.x - L.hip.x, L.knee.z - L.hip.z]);
    for (const [x, y, z, nx, nz] of pts) {
      if (this.contactBudget < 1) break;
      const ref = g.world.buildingAt(x, z);
      if (!ref || !ref.alive || y > ref.top || y < ref.low) continue;
      this.contactBudget -= 1;
      const l = Math.hypot(nx, nz) || 1;
      if (this.smash(x, y, z, 3.5, STRIDER.contactJ, nx / l, 0, nz / l) < 0) break;
    }
  }

  /** The water it rises from and wades in: cascades off its back, foam round its legs. */
  private water(dt: number): void {
    const g = this.g, rig = this.rig, fx = g.elements.fx;
    const wl = g.terrain.waterLevel(this.x, this.z);
    // Wet skin dries off over a minute once out of the river.
    rig.wet = Math.max(0, rig.wet - dt / 60);
    if (!isFinite(wl)) return;
    rig.wet = 1;
    this.waterT -= dt;
    const rising = this.mode === 'emerge' || this.mode === 'sink';
    if (this.waterT > 0) return;
    this.waterT = rising ? 0.03 : 0.12;
    // Cascades: off the back, the plates and the head while it comes up (and a while after).
    const sp = rig.spine, n = rising ? 6 : 2;
    for (let k = 0; k < n; k++) {
      const i = Math.floor(Math.random() * 4);
      const x = sp[i * 3] + (Math.random() - 0.5) * 10, y = sp[i * 3 + 1] + 4 + Math.random() * 8, z = sp[i * 3 + 2] + (Math.random() - 0.5) * 10;
      if (y < wl + 0.5) continue;
      const ox = x - sp[i * 3], oz = z - sp[i * 3 + 2];
      fx.soft(x, y, z, ox * 0.4, Math.random() * 1.5, oz * 0.4, 1.6 + Math.random(), 1.5, 3.5, WATER_A, WATER_B, 0.55, 0.2, 9.8);
    }
    if (rising && this.emergeK > 0.05) {
      // Foam boiling round it at the waterline.
      const a = Math.random() * Math.PI * 2, r = 8 + Math.random() * 18;
      g.dust.burst(this.x + Math.cos(a) * r, wl + 0.4, this.z + Math.sin(a) * r, 6, 4, 3, 3, 3, FOAM, -0.3, 0.6);
      if (Math.random() < 0.05) g.audio.play('splash_big', this.x, wl, this.z, 0.9, 0.5 + Math.random() * 0.2, 60, g.renderer.camera.position);
    }
  }

  /** People keep away, drivers leave, news drones come, a far stimulus. */
  private surroundings(dt: number): void {
    const g = this.g;
    this.stimT -= dt;
    if (this.stimT <= 0 && this.mode !== 'dead') {
      this.stimT = 1.5;
      // The ground its debris and wrecks will need, sampled ahead in the background.
      g.physics.prefetchGround(this.x + this.rig.fx * 40, this.z + this.rig.fz * 40, 90);
      g.stimuli.emit('threat', this.x, g.terrain.height(this.x, this.z) + 10, this.z, 6, 160, { cause: 'threat' });
      // Drivers near it turn round or leave their cars.
      for (const v of g.traffic.vehicles) if (v.state === VState.Drive && !v.task && Math.hypot(v.x - this.x, v.z - this.z) < 150) v.fear = Math.max(v.fear, 1);
    }
    this.newsT -= dt;
    if (this.newsT <= 0 && this.mode !== 'dead' && this.mode !== 'emerge') { this.newsT = 35; g.future.drones.incident(DKind.News, this.x, this.z, g.player.pos.x, g.player.pos.z); }
  }

  private knock(a: PedAgent, fx: number, fz: number, power: number): void {
    if (a.inside || a.state === PState.Down) return;
    this.g.reactions.knockDown(a, fx, fz, power * dealtBy(this), 'threat');
    this.g.consequences.record('strider', 'person', 'knockdown', a.x, a.z, a, 'threat');
    this.hurt++;
    this.stats.knocked++;
  }

  private wreckCar(v: Vehicle, jx: number, jy: number, jz: number): void {
    const g = this.g;
    g.traffic.wreckIt(v);
    const k = dealtBy(this);
    g.vehicles.makeWreck(v, v.x, v.y + 0.8, v.z, jx * k, jy * k, jz * k);
    g.consequences.record('strider', 'car', 'wreck', v.x, v.z, v, 'threat');
    this.stats.wrecked++;
  }

  /** The player close to a footfall / slam: knocked off their feet (sized by how big they are). */
  private hurtPlayerNear(x: number, z: number, r: number, dmg: number, fling: number): void {
    const p = this.g.player;
    const d = Math.hypot(p.pos.x - x, p.pos.z - z);
    const gy = this.g.terrain.height(x, z);
    r *= this.sc;
    if (d > r + p.radius || p.pos.y > gy + 6) return;
    this.hurtPlayer(dmg * (1 - d / (r + p.radius + 1) * 0.5), x, z, gy, fling);
  }

  /** Hurt and fling the player (damage as for a 1.8 m body; a giant hero shrugs off more). */
  private hurtPlayer(dmg: number, fromX: number, fromZ: number, fromY: number, fling: number): void {
    const g = this.g, p = g.player;
    const k3 = p.k ** 3, rel = Math.min(1, Math.pow(this.height / Math.max(1, p.height), 0.8));
    const d = g.crime.health.damage(dmg * k3 * Math.max(0.15, rel) * dealtBy(this), 'monster', fromX, fromZ, fromY);
    this.stats.playerHits++;
    if (d <= 0 && !g.crime.health.invulnerable) return;
    // Thrown (small bodies fly; a giant only staggers).
    const dx = p.pos.x - fromX, dz = p.pos.z - fromZ, l = Math.hypot(dx, dz) || 1;
    const f = fling * rel;
    if (f > 2 && !p.flying) {
      p.vel.x += (dx / l) * f; p.vel.z += (dz / l) * f; p.vel.y = Math.max(p.vel.y, f * 0.45);
      p.grounded = false;
      if (rel > 0.5) p.downT = Math.max(p.downT, 1.4);
    }
    g.camRig.addShake(0.4);
  }

  // ---------------------------------------------------------------- hurt, beaten

  private react(Z: ThreatZone, dealt: number, weak: boolean, src: DamageSource): void {
    if (this.mode === 'emerge' || this.mode === 'sink') return;
    // The glowing throat hit hard: the breath is choked off.
    if (weak && Z.id === 'throat' && (this.act === 'charge' || this.act === 'breath') && dealt > 60) {
      this.act = null;
      this.stats.chokes++;
      this.cool.breath = 12;
      this.rig.ridge = 0.2;
      this.startStagger();
      this.g.audio.play('strider_roar', this.rig.headPos.x, this.rig.headPos.y, this.rig.headPos.z, 0.8, 1.35, 100, this.g.renderer.camera.position);
      return;
    }
    // A battered leg buckles; heavy hits stagger it.
    if ((Z.id.startsWith('fore') || Z.id.startsWith('hind')) && Z.recent > STRIDER.buckleAt && this.act !== 'stagger') { Z.recent *= 0.4; this.startStagger(); return; }
    if (this.recentHit > STRIDER.staggerAt && this.act !== 'stagger' && this.act !== 'breath') { this.recentHit *= 0.3; this.startStagger(); return; }
    // It turns on whoever hurts it: roar at them soon.
    if (src.cause === 'player' && this.cool.roar > 6 && dealt > 30) this.cool.roar = Math.min(this.cool.roar, 2);
  }

  private startStagger(): void {
    if (this.act === 'charge' || this.act === 'breath') { this.stats.chokes++; this.cool.breath = Math.max(this.cool.breath, 10); }
    if (this.act === 'lean') { const L = this.rig.legs[this.leanLeg]; if (L?.pin) { L.pin = null; L.plant.x = L.foot.x; L.plant.z = L.foot.z; L.plant.y = this.rig.ground(L.foot.x, L.foot.z); } }
    this.begin('stagger', STRIDER.staggerT);
    this.stats.staggers++;
    this.rig.ridge = Math.min(this.rig.ridge, 0.2);
    this.rig.throat = 0;
  }

  private startDying(): void {
    if (this.defeated) return;
    this.mode = 'dying';
    this.act = null;
    this.dieT = 0;
    this.rig.slumpSide = this.rng.chance(0.5) ? 1 : -1;
    for (const L of this.rig.legs) L.pin = null;
    const h = this.rig.headPos;
    this.g.audio.play('strider_roar', h.x, h.y, h.z, 1, 0.7, 140, this.g.renderer.camera.position);
    this.g.stimuli.emit('roar', h.x, h.y, h.z, 9, 700, { cause: 'threat', size: this.height });
    this.active = false;
    this.outcome = 'defeated';
    const top = this.topAggro();
    if (top?.key === 'player' || (this.aggro.get('player') ?? 0) > this.maxHp * 0.25) {
      this.g.progress.addKarma(STRIDER.karma.defeated, 'brought the monster down');
      this.g.crime.rep.add(12, 'monster defeated');
      this.g.crime.cheer();
    }
  }

  /** Legs buckle, the body comes down and rolls a little; the impact crushes what is under it. */
  private dying(dt: number): void {
    const rig = this.rig, g = this.g;
    this.dieT += dt;
    const k = Math.min(1, this.dieT / 4.5);
    const before = rig.slump;
    rig.slump = k;
    rig.rear = Math.max(0, rig.rear - dt);
    rig.jaw += ((k < 0.5 ? 0.8 : 0.3) - rig.jaw) * Math.min(1, dt * 2);
    rig.ridge = Math.max(0, rig.ridge - dt); rig.throat = Math.max(0, rig.throat - dt);
    rig.eyes = Math.max(0, 0.6 * (1 - k * 1.2));
    rig.lookW = 0;
    for (const Z of this.zones) Z.exposed = false;
    if (before < 0.8 && rig.slump >= 0.8) {
      // The body hits the ground.
      const sp = rig.spine;
      for (let i = 0; i < 4; i++) {
        const x = sp[i * 3], z = sp[i * 3 + 2], y = rig.ground(x, z);
        this.stats.broken += g.interactions.steps.land(x, y, z, this.stepE * 4, this.height, { cause: 'threat', own: false, sound: 'strider_step', ref: 120, maxR: 600, foot: 8 });
        this.onBlow?.('fall', x, y, z, 14);
      }
      g.stimuli.emit('collapse', this.x, this.y, this.z, 9, 900, { cause: 'threat', size: this.height });
      for (const c of rig.caps) {
        if (c.zone !== 'body' && c.zone !== 'tail' && c.zone !== 'neck' && c.zone !== 'throat') continue;
        const mx = (c.ax + c.bx) / 2, mz = (c.az + c.bz) / 2;
        for (const v of [...g.traffic.vehicles, ...g.parkedCars]) if (v.state !== VState.Crushed && Math.hypot(v.x - mx, v.z - mz) < c.r + 2) { g.traffic.crush(v); this.stats.crushedCars++; }
        for (const a of g.peds.neighbours(mx, mz, c.r + 2, [])) this.knock(a, mx, mz, 5);
        g.props.crush(mx, mz, c.r);
      }
      g.dust.burst(this.x, this.y, this.z, 60, 30, 14, 12, 10, DUST, 0.5, 0.6);
      g.camRig.addShake(Math.min(1, 300 / Math.max(60, Math.hypot(g.player.pos.x - this.x, g.player.pos.z - this.z))));
    }
    if (k >= 1) {
      this.mode = 'dead';
      this.onDefeated?.(this);
    }
  }

  /** Lying there: the rig is settled once more and then left alone (the director draws it each frame). */
  private finishDeath(dt: number): void {
    if (this.dieT < 6) { this.dieT += dt; this.rig.update(dt, 0); }
  }

  /** The last resort's strike: nothing is left of it (no body, no rewards). */
  obliterate(): void {
    if (this.mode === 'gone') return;
    this.act = null;
    this.stay = false;
    this.finish('destroyed');
  }

  private finish(o: ThreatOutcome): void {
    if (this.mode === 'gone') return;
    this.active = false;
    this.outcome = o;
    this.mode = 'gone';
  }

  // ================================================================== dev helpers

  devRoar(rear: boolean): void { if (!this.defeated && this.mode !== 'emerge') { this.act = null; this.startRoar(rear); } }

  /** Breathe now: at the tallest building ahead, else at a point in front. */
  devBreathe(): void {
    if (this.defeated || this.mode === 'emerge') return;
    this.act = null;
    const b = this.breathBuilding() ?? { kind: 'point' as const, x: this.rig.headPos.x + this.rig.fx * 70, y: this.rig.ground(this.rig.headPos.x + this.rig.fx * 70, this.rig.headPos.z + this.rig.fz * 70) + 6, z: this.rig.headPos.z + this.rig.fz * 70 };
    this.startCharge(b);
  }

  devSwipe(side: number): void { if (this.defeated || this.mode === 'emerge') return; this.act = null; this.swipeSide = side >= 0 ? 1 : -1; this.begin('swipe', STRIDER.swipeT); this.swipeHit.clear(); this.stats.swipes++; }

  /** Jump `m` metres along the route (the emergence done). */
  devSkip(m: number): void {
    if (this.mode === 'emerge') { this.emergeK = 1; this.rig.lift = 0; this.mode = 'advance'; }
    this.s = Math.min(this.route.length, this.s + m);
    routeAt(this.route, this.s, _r);
    this.rig.x = _r.x; this.rig.z = _r.z;
    this.yaw = this.rig.yaw = Math.atan2(-_r.dx, -_r.dz);
    this.rig.place();
  }

  /** Put the player on the street `dist` m in front of it, a little to the side, facing it. */
  devPlayerNear(dist: number): { x: number; z: number } {
    const g = this.g, rig = this.rig;
    let x = rig.x + rig.fx * dist + rig.rx * dist * 0.35, z = rig.z + rig.fz * dist + rig.rz * dist * 0.35;
    const ne = g.net.nearestEdge(x, z, 80);
    if (ne) { const o = { x: 0, z: 0, dx: 0, dz: 0 }; g.net.pointAt(g.net.edges[ne.e], ne.s, 0, o); x = o.x; z = o.z; }
    const p = g.player;
    p.pos.set(x, g.world.groundHeight(x, z) + 0.1, z);
    p.vel.set(0, 0, 0);
    p.yaw = Math.atan2(-(this.x - x), -(this.z - z));
    g.camRig.yaw = p.yaw;
    return { x: Math.round(x), z: Math.round(z) };
  }

  // ================================================================== saves

  /** Saves: where it is (a body lying in the city, or how far along its route a live one walked). */
  saveState(): { x: number; z: number; yaw: number; side: number; s: number; hp: number; mode: string } {
    return { x: this.rig.x, z: this.rig.z, yaw: this.yaw, side: this.rig.slumpSide, s: this.s, hp: this.hp, mode: this.mode };
  }

  /** Saves: lie as a body already brought down (no impact, no rewards), settled on the ground. */
  restoreDead(st: { x: number; z: number; yaw: number; side: number; s: number }): void {
    const rig = this.rig;
    this.s = Math.min(this.route.length, st.s);
    this.emergeK = 1;
    rig.lift = 0;
    rig.x = st.x; rig.z = st.z;
    this.yaw = rig.yaw = st.yaw;
    rig.slumpSide = st.side < 0 ? -1 : 1;
    rig.slump = 1;
    rig.place();
    for (const L of rig.legs) L.pin = null;
    this.hp = 0;
    this.mode = 'dead';
    this.active = false;
    this.outcome = 'defeated';
    this.dieT = 6;
    for (let i = 0; i < 40; i++) rig.update(0.15, 0);
    const sp = rig.spine;
    this.x = sp[3]; this.y = sp[4]; this.z = sp[5];
    this.updateZones();
  }

  /** Saves: a live one resumes at its route position with its hit points (the emergence skipped). */
  restoreWalking(st: { s: number; hp: number }): void {
    if (st.s > 0) this.devSkip(st.s);
    this.hp = Math.max(1, Math.min(this.maxHp, st.hp));
  }

  /** Push the body's parts (the director's batch). */
  draw(mesh: CreatureMesh): number {
    if (this.mode === 'gone' || (this.mode === 'emerge' && this.rig.lift < -STRIDER.sunk + 2)) return 0;
    return this.rig.draw(mesh);
  }

  /** The body as obstacles for the player (legs, torso), when the box overlaps. */
  obstacles(x0: number, z0: number, x1: number, z1: number, out: (o: import('../../world/Collision').Obstacle) => void): void {
    if (this.mode === 'gone') return;
    for (const c of this.rig.caps) {
      if (c.zone === 'tail' || c.zone === 'head') continue;
      // A carcass being taken away: what has been cut off and carted away is no longer in the way.
      const k = this.rig.cut ? this.cutOf(c.zone) : 1;
      if (k < 0.3) continue;
      const mx = (c.ax + c.bx) / 2, mz = (c.az + c.bz) / 2, r = c.r * 0.9 * k;
      if (mx + r < x0 || mx - r > x1 || mz + r < z0 || mz - r > z1) continue;
      out({ cyl: true, x: mx, z: mz, r, hx: 0, hz: 0, ux: 1, uz: 0, y0: Math.min(c.ay, c.by) - c.r, y1: Math.max(c.ay, c.by) + c.r });
    }
  }

  /** How much of a body zone is left while the carcass is cut up (1 whole; the smallest of its bones). */
  private cutOf(zone: string): number {
    const C = this.rig.cut!, L = CUT_LAYOUT;
    if (zone === 'body') return Math.min(C[L.spine], C[L.spine + 1], C[L.spine + 2]);
    if (zone === 'neck' || zone === 'throat') return Math.min(C[L.neck], C[L.neck + 1], C[L.neck + 2]);
    const leg = STRIDER_RIG.legs.findIndex((d) => d.zone === zone);
    if (leg >= 0) return Math.min(C[L.legs + leg * 3], C[L.legs + leg * 3 + 1]);
    return 1;
  }

  private updateZones(): void {
    const rig = this.rig, sp = rig.spine, s = rig.scale;
    const set = (id: string, x: number, y: number, z: number, r: number) => { const Z = this.zone(id); Z.x = x; Z.y = y; Z.z = z; Z.r = r; };
    const hp = rig.headPos, hf = rig.headFwd;
    set('head', hp.x + hf.x * 4 * s, hp.y + hf.y * 4 * s, hp.z + hf.z * 4 * s, 4 * s);
    set('throat', rig.throatPos.x, rig.throatPos.y, rig.throatPos.z, 3 * s);
    const n = rig.neck;
    set('neck', n[3], n[4], n[5], 4 * s);
    set('back', sp[3], sp[4] + 7 * s, sp[5], 8 * s);
    set('belly', (sp[3] + sp[6]) / 2, (sp[4] + sp[7]) / 2 - 6.5 * s, (sp[5] + sp[8]) / 2, 6 * s);
    for (const L of rig.legs) set(L.def.zone, L.knee.x, L.knee.y, L.knee.z, L.def.r[0] * s);
    const T = rig.tail;
    set('tail', T[9], T[10], T[11], 4 * s);
  }
}

/** Downtown: the tower it is after (`ref`, approached at x, z), the ones done, and its clocks. */
interface Rampage { ref: BuildingRef | null; t: number; done: Set<BuildingRef>; x: number; z: number; onT: number; seekT: number; roamT: number }
function newRampage(x: number, z: number): Rampage { return { ref: null, t: 0, done: new Set(), x, z, onT: 0, seekT: 0, roamT: 0 }; }

/** Distance from a point to segment a–b. */
function segDist(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return capsuleDist(px, py, pz, { ax, ay, az, bx, by, bz, r: 0, zone: '' });
}

/** Closest point on a polygon's outline. */
function nearestOnPoly(poly: number[], x: number, z: number): { x: number; z: number } {
  let best = Infinity, bx = x, bz = z;
  const n = poly.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = poly[j * 2], az = poly[j * 2 + 1], cx = poly[i * 2], cz = poly[i * 2 + 1];
    const dx = cx - ax, dz = cz - az, l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + dx * t, qz = az + dz * t, d = (qx - x) ** 2 + (qz - z) ** 2;
    if (d < best) { best = d; bx = qx; bz = qz; }
  }
  return { x: bx, z: bz };
}

/** Arc length of the route point nearest (x, z), searched around s0 (± window m). */
function nearestS(r: StriderRoute, x: number, z: number, s0: number, win = 60): number {
  const S = r.s, P = r.pts;
  let best = Infinity, bs = s0;
  for (let i = 0; i < S.length; i++) {
    if (S[i] < s0 - win || S[i] > s0 + win) continue;
    const d = (P[i * 2] - x) ** 2 + (P[i * 2 + 1] - z) ** 2;
    if (d < best) { best = d; bs = S[i]; }
  }
  return bs;
}
