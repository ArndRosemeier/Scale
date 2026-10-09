/**
 * The Leviathan (THREATS_PLAN §1 #2, Phase E): an amphibious river creature that comes up the river
 * and goes for its bridges and quays.
 *
 * A long, ringed sea-green body that never leaves the water: what shows is a head rearing a dozen
 * metres out of the river (the maw opening on teeth, an amber gullet: its weak spot) and six thick
 * tentacles that rise round it, reach over the parapets and pull cars off the decks.
 *
 *   travel   under the surface along its way (leviRoute) at ~7 m/s: a long V of foam on the water,
 *            boils, a low surge heard on the banks; drivers on the bridges ahead stop.
 *   rise     at a stop the water heaves, the head bursts up and the tentacles come out round it.
 *   attack   at a bridge (45–70 s): tentacles grab cars on the deck and fling them into the river,
 *            hammer the deck (five blows on a span and it gives way, two spans per visit at most: BridgeBreaks), sweep people off
 *            their feet, swat helicopters and drones; the head roars and snaps at whoever fights it.
 *            At a quay (25–35 s): the tentacles sweep the promenade and drag parked cars in.
 *   sink     it goes under again and travels on to the next stop.
 *
 * After its last stop, or hurt to 30 %, it turns back down the river and is gone. Frozen (frost on
 * it while it is up: the water round it ices over) it is held fast, the head raised and the maw open,
 * for a few seconds. Brought down, it slumps into the river, the tentacles drifting, and sinks.
 *
 * It is a ThreatActor (2200 points; zones maw, head, tentacles, neck; the maw the weak spot while
 * open), reachable only while it is up (`actors` empty under the surface, `hidden` for the army), and
 * an ArmyFoe (the army comes along its way and fires from the banks; no last resort).
 */
import * as THREE from 'three';
import type { Game } from '../../Game';
import { Rng } from '../../../core/rng';
import { PState, type PedAgent } from '../../../sim/Pedestrians';
import { VState, type Vehicle } from '../../../sim/Traffic';
import { DKind } from '../../../future/Drones';
import { dealtBy } from '../../../shared/status';
import { DecalKind } from '../../powers/ElementFx';
import { rayCapsule } from '../rig/CreatureRig';
import type { ThreatActor, ThreatEvent, ThreatOutcome, ThreatTarget, ThreatZone, DamageSource, DamageResult } from '../ThreatEvent';
import { DAMAGE_PER_IMPULSE } from '../ThreatEvent';
import type { Cause } from '../../Stimuli';
import { angriestInReach } from '../../response/forces/BattleModel';
import type { AirProvider, AirTarget, StriderBlow } from '../Strider';
import { bookAggro, decayAggro, heroEarned, topAggro, zoneDealt } from '../aggro';
import { WormRig, WORM } from '../burrower/wormRig';
import type { WormMesh } from '../burrower/WormMesh';
import { routeAt, nearestS } from '../StriderRoute';
import { planLeviathanRoute, type LeviRoute, type LeviStop } from './leviRoute';
import type { BridgeBreaks } from './BridgeBreaks';

export const LEVIATHAN = {
  hp: 2200,
  /** Its "height" for the con and stomps (m). */
  height: 24,
  /** Under the surface: how deep the head runs (m) and how fast (m/s). */
  depth: 5, speed: 7,
  /** Body and tentacle sizes (× the worm's full size), how many tentacles, their roots' ring (m). */
  bodyScale: 0.55, tentScale: 0.27, tentacles: 6, ring: 5.5,
  /** The head over the water (m) and its reach from the body (m); a tentacle's reach (m). */
  rear: 12, headReach: 14, reach: 24,
  /** Time at a stop (s): bridges, quays; rising and sinking (s). */
  bridgeT: [45, 70] as [number, number], quayT: [25, 35] as [number, number], riseT: 3, sinkT: 3,
  /** Gaps between a tentacle's blows (s) and roars (s); blows on a span before it gives way, spans it brings down per bridge visit. */
  strikeGap: [1.4, 2.8] as [number, number], roarGap: [10, 16] as [number, number], spanBlows: 5, spansPerVisit: 2,
  /** Frozen fast (s per second of frost, at most). */
  frostK: 1.2, frostMax: 8,
  weakMul: 4, retreatAt: 0.3,
  /** The visit ends after this long (s) whatever is left; going away takes at most (s). */
  visitMax: 720, leaveT: 90,
  radius: 120,
  karma: { weak: 2, retreat: 60, defeated: 120 },
  /** The hide's tint (sea-green, darker). */
  tint: [0.55, 0.95, 0.85] as [number, number, number],
};

export const LEVIATHAN_ZONES: { id: string; name: string; armour: number; weak: boolean }[] = [
  { id: 'maw', name: 'Maw', armour: 0.5, weak: true },
  { id: 'head', name: 'Head', armour: 0.7, weak: false },
  { id: 'tentacle', name: 'Tentacles', armour: 0.6, weak: false },
  { id: 'neck', name: 'Neck', armour: 0.85, weak: false },
];

type Mode = 'advance' | 'retreat' | 'dying' | 'dead' | 'gone';
type Phase = 'travel' | 'rise' | 'attack' | 'sink';
type TAct = 'idle' | 'reach' | 'grab' | 'smash' | 'sweep' | 'swat' | 'limp';

interface Tentacle {
  rig: WormRig;
  /** Root angle round the body (rad) and its sway phase. */
  a: number; ph: number;
  act: TAct; t: number; T: number;
  /** The act's target (world), the tip's start, a car it grabs, an air target. */
  target: THREE.Vector3; from: THREE.Vector3;
  car: Vehicle | null; air: AirTarget | null;
  /** The bridge and spot it hammers. */
  edge: number; s: number;
  hit: boolean; cool: number;
  /** Out of the water (drawn). */
  up: number;
}

let EVENT_ID = 5000;
const FOAM = new THREE.Color(0.86, 0.9, 0.92);
const ICE_MIST = new THREE.Color(0.82, 0.92, 1.0);
const WATER_A = new THREE.Color(0.55, 0.66, 0.7);
const WATER_B = new THREE.Color(0.8, 0.86, 0.88);
const _rp = { x: 0, z: 0, dx: 0, dz: 1 };

export class Leviathan implements ThreatEvent, ThreatActor {
  readonly id = EVENT_ID++;
  readonly archetype = 'leviathan';
  readonly tier = 'major';
  readonly engageOnFoot = false;
  readonly ceiling = 4;
  readonly name = 'Leviathan';
  readonly radius = LEVIATHAN.radius;
  readonly size = WORM.joints * WORM.seg * LEVIATHAN.bodyScale;
  readonly height = LEVIATHAN.height;
  readonly maxHp = LEVIATHAN.hp;
  hp = LEVIATHAN.hp;
  x = 0; y = 0; z = 0;
  t = 0;
  active = true;
  outcome: ThreatOutcome | null = null;
  hurt = 0;
  readonly body: WormRig;
  readonly tents: Tentacle[] = [];
  readonly route: LeviRoute;
  readonly zones: ThreatZone[];
  readonly aggro = new Map<string, number>();
  mode: Mode = 'advance';
  phase: Phase = 'travel';
  /** Progress along the way (m), the stop it heads for. */
  s = 0;
  stop = 0;
  airTargets: AirProvider[] = [];
  unitAt: ((key: string) => { x: number; y: number; z: number } | null) | null = null;
  onBlow: ((kind: StriderBlow, x: number, y: number, z: number, r: number) => void) | null = null;
  readonly stats = {
    stops: 0, grabs: 0, smashes: 0, sweeps: 0, swats: 0, roars: 0, collapses: 0, frozen: 0,
    damage: 0, weakHits: 0, wrecked: 0, knocked: 0, playerHits: 0, travelled: 0,
  };
  private rng: Rng;
  private phaseT = 0;
  private stayFor = 0;
  private headAct: null | 'roar' | 'snap' | 'flinch' = null;
  private headT = 0;
  private headTarget = new THREE.Vector3();
  private heading = new THREE.Vector3(0, 0, 1);
  /** The body's root in the water (it holds here at a stop). */
  private cx = 0; private cz = 0;
  private wl = 0;
  private cool = { roar: 4, snap: 2 };
  private recentHit = 0;
  private frozenT = 0;
  private dieT = 0;
  private leaveT = 0;
  /** Blows landed per span: `${edge}:${round(s)}` → count. */
  private spanHits = new Map<string, number>();
  /** Spans brought down at this stop. */
  private stopFalls = 0;
  private wakeT = 0;
  private stimT = 0;
  private newsT = 6;
  private surgeT = 0;

  constructor(private g: Game, private breaks: BridgeBreaks, seed: number) {
    this.rng = new Rng(seed);
    const route = planLeviathanRoute(g.macro, g.terrain, seed);
    if (!route) throw new Error('leviathan: no river with a bridge');
    this.route = route;
    this.zones = LEVIATHAN_ZONES.map((z) => ({ ...z, exposed: false, x: 0, y: 0, z: 0, r: 3, recent: 0 }));
    const p0 = routeAt(route, 0, _rp);
    this.cx = p0.x; this.cz = p0.z;
    this.heading.set(_rp.dx, 0, _rp.dz);
    this.wl = this.waterAt(this.cx, this.cz);
    const body = new WormRig(LEVIATHAN.bodyScale);
    body.reset(this.cx, this.wl - LEVIATHAN.depth, this.cz, this.heading.x, -0.05, this.heading.z);
    this.body = body;
    for (let i = 0; i < LEVIATHAN.tentacles; i++) {
      const rig = new WormRig(LEVIATHAN.tentScale);
      const a = (i / LEVIATHAN.tentacles) * Math.PI * 2 + 0.3;
      const t: Tentacle = { rig, a, ph: this.rng.range(0, 6), act: 'idle', t: 0, T: 0, target: new THREE.Vector3(), from: new THREE.Vector3(), car: null, air: null, edge: -1, s: 0, hit: false, cool: this.rng.range(0.5, 3), up: 0 };
      this.layTentacle(t);
      this.tents.push(t);
    }
    this.x = this.cx; this.y = this.wl; this.z = this.cz;
    this.updateZones();
  }

  // ================================================================== ThreatActor / ArmyFoe

  get defeated(): boolean { return this.mode === 'dying' || this.mode === 'dead'; }
  /** Out of the water: something to hit. */
  get surfaced(): boolean { return (this.phase === 'attack' || (this.phase === 'rise' && this.phaseT > 0.8) || (this.phase === 'sink' && this.phaseT < 1.5)) && this.mode !== 'gone' && this.mode !== 'dead'; }
  get targetable(): boolean { return this.mode === 'advance' || this.mode === 'retreat'; }
  get hidden(): boolean { return !this.surfaced; }
  get actors(): ThreatActor[] { return this.surfaced && this.targetable ? [this] : []; }
  get headPos(): { x: number; y: number; z: number } { return this.body.head; }
  get title(): string { return this.defeated ? 'Leviathan — sinking' : this.surfaced ? 'Leviathan — attacking the river crossings' : 'Leviathan — something big in the river'; }
  get frozen(): boolean { return this.frozenT > 0; }

  zone(id: string): ThreatZone { return this.zones.find((z) => z.id === id) ?? this.zones[3]; }

  /** Every capsule above the water: the head rig's (index < n) and the tentacles' (rig k: k·n + i). */
  private hitCaps(f: (c: { ax: number; ay: number; az: number; bx: number; by: number; bz: number; r: number }, rig: number, i: number) => void): void {
    const below = this.wl - 0.6;
    const each = (rig: WormRig, k: number) => {
      for (let i = 0; i < rig.caps.length - 1; i++) {
        const c = rig.caps[i];
        if (c.ay < below && c.by < below) continue;
        f(c, k, i);
      }
    };
    each(this.body, -1);
    this.tents.forEach((t, k) => { if (t.up > 0.2) each(t.rig, k); });
  }

  private zoneOfHit(rig: number, i: number, x: number, y: number, z: number): ThreatZone {
    if (rig >= 0) return this.zone('tentacle');
    if (i === 0) {
      const m = this.body.mouth();
      if (Math.hypot(x - m.x, y - m.y, z - m.z) < WORM.lip * 1.5 * this.body.scale && this.body.petal > 0.4) return this.zone('maw');
      return this.zone('head');
    }
    return i < 3 ? this.zone('head') : this.zone('neck');
  }

  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): { t: number; zone: ThreatZone } | null {
    if (!this.surfaced) return null;
    let best = maxT, br = -2, bi = -1;
    this.hitCaps((c, rig, i) => { const t = rayCapsule(ox, oy, oz, dx, dy, dz, c as never, best); if (t < best) { best = t; br = rig; bi = i; } });
    if (bi < 0) return null;
    return { t: best, zone: this.zoneOfHit(br, bi, ox + dx * best, oy + dy * best, oz + dz * best) };
  }

  /** Nearest capsule above the water to a point: its rig (−1 the head), index and distance to its surface. */
  private nearestCap(x: number, y: number, z: number): { rig: number; i: number; d: number } | null {
    let best: { rig: number; i: number; d: number } | null = null;
    this.hitCaps((c, rig, i) => {
      const ux = c.bx - c.ax, uy = c.by - c.ay, uz = c.bz - c.az, L2 = ux * ux + uy * uy + uz * uz || 1;
      const t = Math.max(0, Math.min(1, ((x - c.ax) * ux + (y - c.ay) * uy + (z - c.az) * uz) / L2));
      const d = Math.hypot(x - c.ax - ux * t, y - c.ay - uy * t, z - c.az - uz * t) - c.r;
      if (!best || d < best.d) best = { rig, i, d };
    });
    return best;
  }

  zoneAt(x: number, y: number, z: number): { zone: ThreatZone; d: number } | null {
    if (!this.surfaced) return null;
    const n = this.nearestCap(x, y, z);
    return n ? { zone: this.zoneOfHit(n.rig, n.i, x, y, z), d: n.d } : null;
  }

  damage(zone: ThreatZone | string | null, amount: number, src: DamageSource): DamageResult {
    if (!this.targetable || amount <= 0 || !this.surfaced) return { dealt: 0, zone: null, weak: false };
    let Z: ThreatZone;
    if (typeof zone === 'string') Z = this.zone(zone);
    else if (zone) Z = zone;
    else Z = (src.x !== undefined ? this.zoneAt(src.x, src.y ?? this.y, src.z ?? this.z)?.zone : null) ?? this.zone('neck');
    const weak = Z.weak && Z.exposed;
    const dealt = zoneDealt(amount, Z.armour, weak, LEVIATHAN.weakMul);
    this.hp = Math.max(0, this.hp - dealt);
    Z.recent += dealt;
    this.recentHit += dealt;
    this.stats.damage += dealt;
    if (weak) this.stats.weakHits++;
    bookAggro(this.aggro, src.key ?? src.cause, dealt + amount * 0.02 + (src.aggro ?? 0));
    if (src.cause === 'player' && weak && dealt > 20) this.g.progress.addKarma(LEVIATHAN.karma.weak, 'hit the leviathan where it hurts');
    // A hard blow: the head recoils; a tentacle hit near its tip lets go.
    if (this.recentHit > 150 && this.headAct !== 'flinch') { this.recentHit *= 0.3; this.headAct = 'flinch'; this.headT = 1; }
    if (Z.id === 'tentacle' && src.x !== undefined && dealt > 25) {
      const n = this.nearestCap(src.x, src.y ?? this.y, src.z ?? this.z);
      const t = n && n.rig >= 0 ? this.tents[n.rig] : null;
      if (t && (t.act === 'grab' || t.act === 'reach')) this.tentAct(t, 'idle', 0.6);
    }
    return { dealt, zone: Z, weak };
  }

  blow(x: number, y: number, z: number, r: number, jx: number, jy: number, jz: number, src: DamageSource): DamageResult | null {
    if (!this.surfaced || !this.targetable) return null;
    const n = this.nearestCap(x, y, z);
    if (!n || n.d > r + 0.5) return null;
    return this.damage(this.zoneOfHit(n.rig, n.i, x, y, z), Math.hypot(jx, jy, jz) * DAMAGE_PER_IMPULSE, { ...src, x: src.x ?? x, y: src.y ?? y, z: src.z ?? z });
  }

  private mistT = 0;
  /** Frozen: icy mist smoking off the head and the raised tentacles (the hide itself keeps its colour). */
  private frostMist(dt: number): void {
    this.mistT -= dt;
    if (this.mistT > 0) return;
    this.mistT = 0.3;
    const g = this.g, rigs = [this.body, ...this.tents.filter((t) => t.up > 0.5).map((t) => t.rig)];
    for (const r of rigs) {
      const i = this.rng.int(0, Math.min(r.n - 1, 8)) * 3;
      if (r.j[i + 1] < this.wl) continue;
      g.dust.burst(r.j[i], r.j[i + 1], r.j[i + 2], 6, 1.5, 1.2, 1.5, 2.2, ICE_MIST, 0.15, 0.5);
    }
  }

  /** Frost on it while it is up: the water round it ices over and holds it fast. */
  onElement(el: 'fire' | 'frost' | 'shock', dur: number): number {
    if (el === 'fire') return 0.5; // (wet through)
    if (el === 'shock') return 1.4; // (in the water)
    if (!this.surfaced || !this.targetable) return 1;
    const before = this.frozenT;
    this.frozenT = Math.min(LEVIATHAN.frostMax, Math.max(this.frozenT, dur * LEVIATHAN.frostK));
    if (before <= 0 && this.frozenT > 0) {
      this.stats.frozen++;
      const g = this.g;
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + this.rng.range(0, 1), d = i === 0 ? 0 : this.rng.range(5, 11);
        g.elements.fx.decal(DecalKind.Ice, this.cx + Math.cos(a) * d, this.wl + 0.12, this.cz + Math.sin(a) * d, 0, 1, 0, 16, 16, this.rng.range(0, 6), this.frozenT + 4);
      }
      for (const t of this.tents) if (t.act !== 'limp') this.tentAct(t, 'idle', 0);
    }
    return 1;
  }

  conStrength(): number { return 230 * Math.sqrt(Math.max(0.05, this.hp / this.maxHp)); }
  topAggro(): { key: string; v: number } | null { return topAggro(this.aggro); }

  // ================================================================== ThreatEvent

  strength(): number { return this.active ? this.hp / this.maxHp : 0; }
  targetsNear(_x: number, _z: number, _r: number): ThreatTarget[] { return []; }
  strike(_t: ThreatTarget, _jx: number, _jy: number, _jz: number, _cause: Cause): void { /* nothing on foot reaches it */ }
  shutdown(): void { if (this.mode === 'advance') this.startLeaving(false); }
  dispose(): void { /* no loops of its own */ }
  obliterate(): void { this.finish('destroyed'); }

  snapshot(): Record<string, unknown> {
    return {
      id: this.id, archetype: this.archetype, t: +this.t.toFixed(1), active: this.active, outcome: this.outcome, mode: this.mode, phase: this.phase,
      x: Math.round(this.x), z: Math.round(this.z), head: { x: Math.round(this.body.head.x), y: Math.round(this.body.head.y), z: Math.round(this.body.head.z) },
      hp: Math.round(this.hp), s: Math.round(this.s), route: Math.round(this.route.length), stop: this.stop, plan: this.route.stops.map((p) => `${p.kind}@${Math.round(p.s)}`),
      surfaced: this.surfaced, frozenFor: +this.frozenT.toFixed(1), tentacles: this.tents.map((t) => t.act), head_act: this.headAct,
      aggro: Object.fromEntries([...this.aggro].map(([k, v]) => [k, Math.round(v)])), hurt: this.hurt, ...this.stats,
    };
  }

  // ================================================================== frame

  update(dt: number): void {
    this.t += dt;
    if (this.mode === 'gone') return;
    decayAggro(this.aggro, dt, 90);
    for (const Z of this.zones) Z.recent *= Math.exp(-dt / 4);
    this.recentHit *= Math.exp(-dt / 2);
    this.cool.roar -= dt; this.cool.snap -= dt;
    this.body.t += dt;
    if (this.mode === 'dying' || this.mode === 'dead') this.dying(dt);
    else {
      if (this.hp <= 0) { this.startDying(); return; }
      this.watch();
      if (this.frozenT > 0) { this.frozenT -= dt; this.frostMist(dt); }
      else this.phaseT += dt;
      switch (this.phase) {
        case 'travel': this.travel(dt); break;
        case 'rise': this.rise(dt); break;
        case 'attack': this.attack(dt); break;
        case 'sink': this.sink(dt); break;
      }
    }
    this.body.place();
    for (const t of this.tents) this.poseTentacle(t, dt);
    this.glows(dt);
    this.x = this.cx; this.z = this.cz; this.y = this.wl;
    this.updateZones();
    this.surroundings(dt);
  }

  private waterAt(x: number, z: number): number {
    const t = this.g.terrain, wl = t.waterLevel(x, z);
    return isFinite(wl) ? wl : t.water(x, z).level;
  }

  // ---------------------------------------------------------------- travel, stops

  private travel(dt: number): void {
    const R = this.route, back = this.mode === 'retreat';
    const goalS = back ? 0 : (R.stops[this.stop]?.s ?? R.length);
    const dir = Math.sign(goalS - this.s) || (back ? -1 : 1);
    const step = LEVIATHAN.speed * (back ? 1.3 : 1) * (0.6 + 0.4 * Math.max(0.3, this.hp / this.maxHp)) * dt;
    this.s = Math.max(0, Math.min(R.length, this.s + dir * step));
    this.stats.travelled += step;
    const p = routeAt(R, this.s, _rp);
    // (The root eases along the centreline; the head runs ahead of it under the surface.)
    this.cx += (p.x - this.cx) * Math.min(1, dt * 2); this.cz += (p.z - this.cz) * Math.min(1, dt * 2);
    this.wl = this.waterAt(this.cx, this.cz);
    this.heading.lerp(new THREE.Vector3(_rp.dx * dir, 0, _rp.dz * dir), Math.min(1, dt * 1.5)).normalize();
    const B = this.body, H = B.head;
    const hx = this.cx + this.heading.x * 6, hz = this.cz + this.heading.z * 6, hy = this.wl - LEVIATHAN.depth + Math.sin(this.t * 0.6) * 0.6;
    if (B.anchor) B.release();
    B.moveHead(H.x + (hx - H.x) * Math.min(1, dt * 3), H.y + (hy - H.y) * Math.min(1, dt * 2), H.z + (hz - H.z) * Math.min(1, dt * 3));
    B.setDir(this.heading.x, -0.04, this.heading.z);
    B.petal += (0 - B.petal) * Math.min(1, dt * 3);
    for (const t of this.tents) if (t.act !== 'limp') { t.act = 'idle'; t.up = Math.max(0, t.up - dt); }
    if (back) {
      this.leaveT += dt;
      if (this.s <= 0.5 || this.leaveT > LEVIATHAN.leaveT) this.finish('retreated');
      return;
    }
    if (Math.abs(goalS - this.s) < 1) {
      if (this.stop >= R.stops.length) { this.startLeaving(false); return; }
      this.startRise();
    }
  }

  private get here(): LeviStop | null { return this.route.stops[this.stop] ?? null; }

  private startRise(): void {
    const g = this.g, S = this.here!;
    this.phase = 'rise';
    this.phaseT = 0;
    this.cx = S.x; this.cz = S.z;
    this.wl = this.waterAt(S.x, S.z);
    this.stats.stops++;
    this.stopFalls = 0;
    this.stayFor = S.kind === 'bridge' ? this.rng.range(LEVIATHAN.bridgeT[0], LEVIATHAN.bridgeT[1]) : this.rng.range(LEVIATHAN.quayT[0], LEVIATHAN.quayT[1]);
    // Planted in the channel: the neck rises straight out of the water.
    this.body.anchorAt(this.cx, this.wl - 4, this.cz);
    const cam = g.renderer.camera.position;
    g.audio.play('leviathan_surface', this.cx, this.wl, this.cz, 1, 0.95 + this.rng.range(0, 0.1), 140, cam);
    g.stimuli.emit('roar', this.cx, this.wl, this.cz, 8, 500, { cause: 'threat', size: this.height });
    this.onBlow?.('fall', this.cx, this.wl, this.cz, 14);
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2, r = this.rng.range(3, 9);
      g.dust.burst(this.cx + Math.cos(a) * r, this.wl + 0.4, this.cz + Math.sin(a) * r, 8, 3, 7, 3, 2.5, FOAM, -0.2, 0.7);
    }
    this.cool.roar = 1.5;
  }

  private rise(dt: number): void {
    const k = Math.min(1, this.phaseT / LEVIATHAN.riseT);
    this.poseHead(dt, k);
    for (const t of this.tents) t.up = Math.min(1, t.up + dt / (LEVIATHAN.riseT * 0.8));
    if (k >= 1) { this.phase = 'attack'; this.phaseT = 0; this.startRoar(); }
  }

  private attack(dt: number): void {
    if (this.frozenT > 0) { this.poseHead(dt, 1); return; }
    const S = this.here!;
    if (this.phaseT > this.stayFor || this.mode === 'retreat') { this.startSink(); return; }
    this.headDecide();
    this.poseHead(dt, 1);
    for (const t of this.tents) {
      t.up = Math.min(1, t.up + dt);
      if (t.act === 'idle') { t.cool -= dt; if (t.cool <= 0) this.tentDecide(t, S); }
    }
  }

  private startSink(): void {
    this.phase = 'sink';
    this.phaseT = 0;
    this.headAct = null;
    for (const t of this.tents) if (t.act !== 'limp') { if (t.car) t.car = null; this.tentAct(t, 'idle', 0); }
    this.g.audio.play('leviathan_surface', this.cx, this.wl, this.cz, 0.7, 0.8, 100, this.g.renderer.camera.position);
  }

  private sink(dt: number): void {
    const k = Math.min(1, this.phaseT / LEVIATHAN.sinkT);
    this.poseHead(dt, 1 - k);
    for (const t of this.tents) t.up = Math.max(0, t.up - dt / LEVIATHAN.sinkT);
    if (k >= 1) {
      this.phase = 'travel';
      this.phaseT = 0;
      if (this.mode === 'advance') this.stop++;
      this.body.release();
    }
  }

  /** Timers that run whatever it does: badly hurt, the visit's end. */
  private watch(): void {
    if (this.mode === 'retreat') return;
    if (this.hp < this.maxHp * LEVIATHAN.retreatAt) { this.startLeaving(true); return; }
    if (this.t > LEVIATHAN.visitMax) this.startLeaving(false);
  }

  private startLeaving(hurt: boolean): void {
    if (this.mode === 'retreat' || this.defeated) return;
    this.mode = 'retreat';
    this.leaveT = 0;
    if (hurt && this.topAggro()?.key === 'player') this.g.crime.reward({ karma: LEVIATHAN.karma.retreat, why: 'drove the leviathan off', rep: 6, news: 'river monster driven off' });
    if (this.phase === 'attack' || this.phase === 'rise') this.startSink();
  }

  private finish(o: ThreatOutcome): void {
    if (this.mode === 'gone') return;
    this.active = false;
    this.outcome = o;
    this.mode = 'gone';
  }

  // ---------------------------------------------------------------- the head

  /** The head over the water (k: 0 under … 1 reared), its act. */
  private poseHead(dt: number, k: number): void {
    const B = this.body, H = B.head, g = this.g;
    const S = this.here;
    const fx0 = S ? S.tx : this.cx + this.heading.x * 30, fz0 = S ? S.tz : this.cz + this.heading.z * 30;
    let fx = fx0 - this.cx, fz = fz0 - this.cz;
    const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
    const rear = LEVIATHAN.rear * k;
    let px = this.cx + fx * 3, py = this.wl - 3 + rear + 3 * k + Math.sin(this.t * 1.1) * 0.8 * k, pz = this.cz + fz * 3;
    let dx = fx, dy = -0.15, dz = fz;
    let rate = 2.5, petal = 0.2 + 0.1 * Math.sin(this.t * 2);
    if (this.frozenT > 0) { petal = 0.9; rate = 0.5; dy = 0.3; }
    else if (this.headAct) {
      this.headT -= dt;
      const T = this.headTarget;
      if (this.headAct === 'roar') { py += 3; dy = 0.9; petal = 1.15; rate = 3; }
      else if (this.headAct === 'flinch') { px -= fx * 4; pz -= fz * 4; py += 1; petal = 0.6; rate = 6; }
      else if (this.headAct === 'snap') {
        const q = 1 - this.headT / 1.4;
        if (q > 0.3 && q < 0.6) {
          let ox = T.x - this.cx, oz = T.z - this.cz;
          const ol = Math.hypot(ox, oz), mr = LEVIATHAN.headReach * B.scale / 0.55;
          if (ol > mr) { ox *= mr / ol; oz *= mr / ol; }
          px = this.cx + ox; pz = this.cz + oz; py = Math.max(this.wl + 3, T.y);
          dx = T.x - H.x; dy = T.y - H.y; dz = T.z - H.z;
          rate = 9; petal = 1.1;
          if (q > 0.45 && !this.snapped) { this.snapped = true; this.snapLands(); }
        } else { py += 2; petal = 0.7; rate = 3; }
      }
      if (this.headT <= 0) this.headAct = null;
    }
    const kk = Math.min(1, dt * rate);
    B.moveHead(H.x + (px - H.x) * kk, H.y + (py - H.y) * kk, H.z + (pz - H.z) * kk);
    const D = B.dir, dl = Math.hypot(dx, dy, dz) || 1, kd = Math.min(1, dt * Math.max(2, rate));
    B.setDir(D.x + (dx / dl - D.x) * kd, D.y + (dy / dl - D.y) * kd, D.z + (dz / dl - D.z) * kd);
    B.petal += (petal * k - B.petal) * Math.min(1, dt * 5);
    // Water streams off it as it rises.
    if (k > 0.05 && k < 0.98 && Math.random() < dt * 20) g.elements.fx.soft(H.x + this.rng.range(-2, 2), H.y - 1, H.z + this.rng.range(-2, 2), 0, -3, 0, 1.4, 1.2, 3, WATER_A, WATER_B, 0.6, 0.5, 9);
  }

  private snapped = false;

  private headDecide(): void {
    if (this.headAct) return;
    if (this.cool.roar <= 0) { this.startRoar(); return; }
    if (this.cool.snap > 0) return;
    this.cool.snap = this.rng.range(3, 6);
    const B = this.body, R = LEVIATHAN.headReach + 6;
    const air = this.airNear(B.head.x, B.head.y, B.head.z, 30);
    if (air) { this.headTarget.set(air.x, air.y, air.z); this.headAct = 'snap'; this.headT = 1.4; this.snapped = false; this.snapAir = air; return; }
    const hostile = this.hostileTarget(R);
    if (hostile) { this.headTarget.set(hostile.x, hostile.y, hostile.z); this.headAct = 'snap'; this.headT = 1.4; this.snapped = false; this.snapAir = null; }
  }

  private snapAir: AirTarget | null = null;

  private snapLands(): void {
    const g = this.g, T = this.headTarget, cam = g.renderer.camera.position;
    if (this.snapAir) {
      const a = this.snapAir, h = this.body.head, l = Math.hypot(a.x - h.x, a.y - h.y, a.z - h.z) || 1;
      a.swat(((a.x - h.x) / l) * 900, -300, ((a.z - h.z) / l) * 900);
      this.stats.swats++;
      g.audio.play('punch_impact', a.x, a.y, a.z, 1, 0.45, 30, cam);
      return;
    }
    this.hurtPlayerNear(T.x, T.y, T.z, 6, 35, 14);
    this.onBlow?.('swipe', T.x, T.y, T.z, 6);
    g.audio.play('leviathan_roar', T.x, T.y, T.z, 0.5, 1.4, 60, cam);
  }

  private startRoar(): void {
    const g = this.g, h = this.body.head;
    this.headAct = 'roar'; this.headT = 2.6;
    this.stats.roars++;
    this.cool.roar = this.rng.range(LEVIATHAN.roarGap[0], LEVIATHAN.roarGap[1]);
    g.audio.play('leviathan_roar', h.x, h.y, h.z, 1, 0.95 + this.rng.range(0, 0.1), 140, g.renderer.camera.position);
    g.stimuli.emit('roar', h.x, h.y, h.z, 9, 650, { cause: 'threat', size: this.height });
    this.onBlow?.('roar', h.x, h.y, h.z, 280);
    const d = Math.hypot(g.player.pos.x - h.x, g.player.pos.z - h.z);
    if (d < 300) g.camRig.addShake(0.25 * (1 - d / 300));
  }

  // ---------------------------------------------------------------- tentacles

  /** A tentacle's root: on a ring round the body, a few metres under the water. */
  private root(t: Tentacle): { x: number; y: number; z: number } {
    return { x: this.cx + Math.cos(t.a) * LEVIATHAN.ring, y: this.wl - 2.5, z: this.cz + Math.sin(t.a) * LEVIATHAN.ring };
  }

  /** Lay a tentacle hanging straight down from its root (its trail below the anchor). */
  private layTentacle(t: Tentacle): void {
    const r = this.root(t);
    t.rig.reset(r.x, r.y - 0.5, r.z, 0, 1, 0);
    t.rig.anchorAt(r.x, r.y, r.z);
  }

  private tentAct(t: Tentacle, act: TAct, T: number): void {
    t.act = act; t.t = 0; t.T = T; t.hit = false;
    t.from.set(t.rig.head.x, t.rig.head.y, t.rig.head.z);
    if (act === 'idle') { t.cool = T || this.rng.range(LEVIATHAN.strikeGap[0], LEVIATHAN.strikeGap[1]); t.car = null; t.air = null; }
  }

  /** A tentacle's next move at a stop: swat what flies, fend off whoever fights it, cars, the deck, the quay. */
  private tentDecide(t: Tentacle, S: LeviStop): void {
    const g = this.g, r = this.root(t), R = LEVIATHAN.reach * (LEVIATHAN.tentScale / 0.27);
    // (Each tentacle works its own side: targets nearer its root than the others'.)
    const mine = (x: number, z: number) => { const a = Math.atan2(z - this.cz, x - this.cx); const d = Math.abs(((a - t.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI); return d < Math.PI / 2.2; };
    const air = this.airNear(r.x, r.y + 12, r.z, R + 4);
    if (air && mine(air.x, air.z)) { t.air = air; t.target.set(air.x, air.y, air.z); this.tentAct(t, 'swat', 1.1); t.air = air; return; }
    const hostile = this.hostileTarget(R, r.x, r.z);
    if (hostile && this.rng.chance(0.6)) { t.target.set(hostile.x, hostile.y, hostile.z); this.tentAct(t, 'smash', 1.5); t.edge = -1; return; }
    if (S.kind === 'bridge') {
      const car = this.carOnDeck(r.x, r.z, R, S.edge);
      if (car && this.rng.chance(0.55)) { t.car = car; t.target.set(car.x, car.y + 1, car.z); this.tentAct(t, 'reach', 1.4); t.car = car; return; }
      const spot = this.deckSpot(r.x, r.z, R, S.edge);
      if (spot) { t.target.set(spot.x, spot.y, spot.z); t.edge = S.edge; t.s = spot.s; this.tentAct(t, 'smash', 1.6); t.edge = S.edge; t.s = spot.s; return; }
    } else {
      const car = this.carNear(r.x, r.z, R);
      if (car && this.rng.chance(0.45)) { t.car = car; t.target.set(car.x, car.y + 1, car.z); this.tentAct(t, 'reach', 1.4); t.car = car; return; }
    }
    // The bank: a sweep along the quay towards the stop's target.
    const a = Math.atan2(S.tz - r.z, S.tx - r.x) + this.rng.range(-0.5, 0.5), d = Math.min(R * 0.9, Math.hypot(S.tx - r.x, S.tz - r.z) + this.rng.range(-4, 6));
    const x = r.x + Math.cos(a) * d, z = r.z + Math.sin(a) * d;
    t.target.set(x, this.groundAt(x, z), z);
    this.tentAct(t, 'sweep', 1.8);
  }

  /** The tip's pose for its act; blows land along the way. */
  private poseTentacle(t: Tentacle, dt: number): void {
    const rig = t.rig, r = this.root(t), A = rig.anchor;
    if (A) { A.x = r.x; A.y = r.y; A.z = r.z; }
    t.t += dt;
    const out = (Math.cos(t.a) * 1), outZ = Math.sin(t.a);
    const sway = Math.sin(this.t * 1.3 + t.ph), sway2 = Math.cos(this.t * 0.9 + t.ph * 1.7);
    // Idle: up out of the water, curling and waving; under it while it travels.
    const up = t.up;
    let px = r.x + out * (5 + 3 * sway2) - outZ * 3 * sway, py = r.y + (2.5 + (6 + 3 * sway) * up) * up + (up < 0.05 ? -2 : 0), pz = r.z + outZ * (5 + 3 * sway2) + out * 3 * sway;
    let dx = out * 0.3, dy = 1, dz = outZ * 0.3;
    let rate = 2.5;
    const frozen = this.frozenT > 0;
    if (!frozen) switch (t.act) {
      case 'reach': {
        const car = t.car;
        if (!car || car.state === VState.Crushed || car.state === VState.Wreck) { this.tentAct(t, 'idle', 0.4); break; }
        t.target.set(car.x, car.y + 1, car.z);
        const k = Math.min(1, t.t / t.T);
        px = t.target.x; py = t.target.y + 6 * (1 - k) + 0.5; pz = t.target.z;
        dx = t.target.x - r.x; dy = -1.2; dz = t.target.z - r.z; rate = 2 + 6 * k;
        if (k >= 1 && Math.hypot(rig.head.x - car.x, rig.head.z - car.z) < 3.5) { this.tentAct(t, 'grab', 1.6); t.car = car; this.g.traffic.wreckIt(car); this.stats.grabs++; }
        else if (t.t > t.T + 1.5) this.tentAct(t, 'idle', 0.5);
        break;
      }
      case 'grab': {
        // Up and over, then flung out into the river.
        const k = Math.min(1, t.t / t.T), car = t.car;
        px = r.x + (t.from.x - r.x) * (1 - k) * 0.6; py = r.y + 12 + 4 * Math.sin(k * Math.PI); pz = r.z + (t.from.z - r.z) * (1 - k) * 0.6;
        dx = out; dy = 0.6; dz = outZ; rate = 3;
        if (car && !t.hit) {
          // (Held at the tip until it lets go.)
          const H = rig.head;
          car.x = H.x; car.z = H.z; car.y = H.y - 1;
          if (k > 0.7) {
            t.hit = true;
            const away = Math.atan2(this.cz - r.z, this.cx - r.x) + Math.PI + this.rng.range(-0.8, 0.8);
            this.flingCar(car, Math.cos(away) * 14000, 9000, Math.sin(away) * 14000);
            t.car = null;
          }
        }
        if (k >= 1) this.tentAct(t, 'idle', 0);
        break;
      }
      case 'smash': case 'sweep': {
        // Raised high, then down on the target (a sweep slides on along the bank).
        const k = Math.min(1, t.t / t.T), T = t.target;
        if (k < 0.45) { px = r.x + (T.x - r.x) * 0.4; py = Math.max(r.y + 14, T.y + 10); pz = r.z + (T.z - r.z) * 0.4; dx = T.x - r.x; dy = 0.8; dz = T.z - r.z; rate = 3; }
        else if (k < 0.65) {
          px = T.x; py = T.y + 0.8; pz = T.z; dx = T.x - r.x; dy = -1.5; dz = T.z - r.z; rate = 12;
          if (!t.hit && Math.hypot(rig.head.x - T.x, rig.head.y - T.y, rig.head.z - T.z) < 3) this.tentImpact(t);
        } else if (t.act === 'sweep') {
          const q = (k - 0.65) / 0.35, side = -Math.sin(t.a) * 9 * q, sideZ = Math.cos(t.a) * 9 * q;
          px = T.x + side; py = T.y + 0.6; pz = T.z + sideZ; rate = 5;
          if (!t.hit) this.tentImpact(t);
          this.sweepAlong(rig.head.x, rig.head.z, T.y);
        } else { px = rig.head.x; py = rig.head.y + 0.5; pz = rig.head.z; rate = 1; if (!t.hit) this.tentImpact(t); }
        if (k >= 1) this.tentAct(t, 'idle', 0);
        break;
      }
      case 'swat': {
        const a = t.air, k = Math.min(1, t.t / t.T);
        if (a) { px = a.x; py = a.y; pz = a.z; dx = a.x - r.x; dy = 0.5; dz = a.z - r.z; rate = 7; }
        if (a && k > 0.6 && !t.hit) {
          t.hit = true;
          const l = Math.hypot(a.x - r.x, a.z - r.z) || 1;
          a.swat(((a.x - r.x) / l) * 800, 200, ((a.z - r.z) / l) * 800);
          this.stats.swats++;
          this.g.audio.play('punch_impact', a.x, a.y, a.z, 1, 0.5, 30, this.g.renderer.camera.position);
        }
        if (k >= 1) this.tentAct(t, 'idle', 0);
        break;
      }
      case 'limp': {
        // Drifting on the water, sinking with the body.
        px = r.x + out * 14 + Math.sin(this.t * 0.3 + t.ph) * 2; py = this.wl - 0.6 - this.dieT * 0.25; pz = r.z + outZ * 14 + Math.cos(this.t * 0.3 + t.ph) * 2;
        dx = out; dy = -0.05; dz = outZ; rate = 0.8;
        break;
      }
      default: break;
    }
    // Within its length of the root.
    const L = rig.length * 0.86, ox = px - r.x, oy = py - r.y, oz = pz - r.z, ol = Math.hypot(ox, oy, oz);
    if (ol > L) { px = r.x + (ox / ol) * L; py = r.y + (oy / ol) * L; pz = r.z + (oz / ol) * L; }
    const H = rig.head, k = Math.min(1, dt * rate);
    if (!frozen) rig.moveHead(H.x + (px - H.x) * k, H.y + (py - H.y) * k, H.z + (pz - H.z) * k);
    else rig.moveHead(H.x, H.y, H.z);
    const D = rig.dir, dl = Math.hypot(dx, dy, dz) || 1, kd = Math.min(1, dt * Math.max(2, rate));
    if (!frozen) rig.setDir(D.x + (dx / dl - D.x) * kd, D.y + (dy / dl - D.y) * kd, D.z + (dz / dl - D.z) * kd);
    rig.petal = 0; rig.maw = 0; rig.pits = this.body.pits * 0.6;
    rig.place();
  }

  /** A tentacle's blow lands at its target. */
  private tentImpact(t: Tentacle): void {
    t.hit = true;
    const g = this.g, T = t.target, cam = g.renderer.camera.position;
    const wet = T.y < this.wl + 1.5 && g.world.wet(T.x, T.z);
    g.audio.play(wet ? 'splash_big' : 'leviathan_slap', T.x, T.y, T.z, 1, 0.9 + this.rng.range(0, 0.2), 70, cam);
    if (wet) g.dust.burst(T.x, this.wl + 0.4, T.z, 12, 3, 7, 3, 2.5, FOAM, -0.2, 0.7);
    else g.dust.burst(T.x, T.y + 0.5, T.z, 8, 2, 3, 2, 2.5, new THREE.Color(0.5, 0.48, 0.45), 0.2, 0.4);
    for (const a of g.peds.neighbours(T.x, T.z, 5, [])) if (Math.abs(a.y - T.y) < 3) this.knock(a, T.x, T.z, 6);
    for (const v of [...g.traffic.vehicles, ...g.parkedCars]) if (v.state !== VState.Crushed && v.state !== VState.Wreck && Math.hypot(v.x - T.x, v.z - T.z) < 2.8 && Math.abs(v.y - T.y) < 3) { g.traffic.crush(v); this.stats.wrecked++; g.consequences.record('leviathan', 'car', 'wreck', v.x, v.z, v, 'threat'); }
    g.props.hit(T.x, T.y + 1, T.z, 3, 0, -1.5e4, 0);
    this.hurtPlayerNear(T.x, T.y, T.z, 4.5, 30, 12);
    this.onBlow?.('slam', T.x, T.y, T.z, 5);
    if (t.act === 'smash') this.stats.smashes++; else this.stats.sweeps++;
    const d = Math.hypot(g.player.pos.x - T.x, g.player.pos.z - T.z);
    if (d < 80) g.camRig.addShake(0.15 * (1 - d / 80));
    // The deck: enough blows on a span and it gives way.
    if (t.edge >= 0) {
      const span = this.breaks.spanAt(t.edge, t.s);
      if (span) {
        const key = `${t.edge}:${Math.round(span[0])}`;
        const n = (this.spanHits.get(key) ?? 0) + 1;
        this.spanHits.set(key, n);
        g.elements.fx.decal(DecalKind.Crack, T.x, T.y + 0.05, T.z, 0, 1, 0, 5, 1.4, this.rng.range(0, 6), 120);
        const gap = n >= LEVIATHAN.spanBlows && this.stopFalls < LEVIATHAN.spansPerVisit ? this.breaks.collapse(t.edge, t.s, 'threat') : null;
        if (gap) {
          this.stats.collapses++;
          this.stopFalls++;
          this.spanHits.delete(key);
          // (The cracks laid on the fallen piece would hang over the gap.)
          const prof = g.world.bridges.find((b) => b.edge === t.edge);
          if (prof) for (let s = gap.s0; s <= gap.s1; s += prof.width / 2) g.elements.fx.clearDecals(prof.ax + prof.dx * s, prof.az + prof.dz * s, prof.width * 0.75);
          g.future.drones.incident(DKind.News, T.x, T.z, g.player.pos.x, g.player.pos.z);
        }
      }
    }
  }

  /** A sweep sliding along the bank: people in its way are thrown down. */
  private sweepAlong(x: number, z: number, y: number): void {
    for (const a of this.g.peds.neighbours(x, z, 3, [])) if (Math.abs(a.y - y) < 2.5) this.knock(a, x, z, 5);
  }

  // ---------------------------------------------------------------- finding things

  private hostileTarget(reach: number, x = this.cx, z = this.cz): { x: number; y: number; z: number } | null {
    const g = this.g, p = g.player.pos;
    const at = (key: string) => (key === 'player' ? { x: p.x, y: p.y + g.player.height * 0.5, z: p.z } : this.unitAt?.(key) ?? null);
    return angriestInReach(this.aggro, at, x, z, reach);
  }

  /** A car on this bridge's deck (intact) within reach. */
  private carOnDeck(x: number, z: number, r: number, edge: number): Vehicle | null {
    const g = this.g;
    let best: Vehicle | null = null, bd = r;
    for (const v of g.traffic.vehicles) {
      if (v.state === VState.Crushed || v.state === VState.Wreck) continue;
      const d = Math.hypot(v.x - x, v.z - z);
      if (d > bd) continue;
      const on = this.breaks.deckAt(v.x, v.z);
      if (!on || on.edge !== edge) continue;
      bd = d; best = v;
    }
    return best;
  }

  private carNear(x: number, z: number, r: number): Vehicle | null {
    const g = this.g;
    let best: Vehicle | null = null, bd = r;
    for (const v of [...g.traffic.vehicles, ...g.parkedCars]) {
      if (v.state === VState.Crushed || v.state === VState.Wreck) continue;
      const d = Math.hypot(v.x - x, v.z - z);
      if (d < bd && d > 4) { bd = d; best = v; }
    }
    return best;
  }

  /** A spot on the deck in reach to hammer (the span already hit most first). */
  private deckSpot(x: number, z: number, r: number, edge: number): { x: number; y: number; z: number; s: number } | null {
    const prof = this.g.world.bridges.find((b) => b.edge === edge);
    if (!prof) return null;
    let best: { x: number; y: number; z: number; s: number } | null = null, bs = -Infinity;
    for (let s = prof.s0 + 5; s < prof.s1 - 5; s += 3) {
      const px = prof.ax + prof.dx * s, pz = prof.az + prof.dz * s;
      const d = Math.hypot(px - x, pz - z);
      if (d > r * 0.9) continue;
      const span = this.breaks.spanAt(edge, s);
      if (!span) continue;
      const hits = this.spanHits.get(`${edge}:${Math.round(span[0])}`) ?? 0;
      const score = hits * 10 - d * 0.2 + this.rng.range(0, 2);
      if (score > bs) { bs = score; best = { x: px, y: prof.y(s) + 0.2, z: pz, s }; }
    }
    return best;
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

  private groundAt(x: number, z: number): number {
    const g = this.g, deck = g.world.bridgeDeck(x, z);
    return isFinite(deck) ? deck : g.terrain.height(x, z) + g.world.surfaceOffset(x, z);
  }

  // ---------------------------------------------------------------- beaten

  private startDying(): void {
    if (this.defeated) return;
    const g = this.g, h = this.body.head;
    this.mode = 'dying';
    this.active = false;
    this.outcome = 'defeated';
    this.dieT = 0;
    this.headAct = null;
    for (const t of this.tents) { if (t.car) t.car = null; this.tentAct(t, 'limp', 0); t.act = 'limp'; }
    if (!this.body.anchor) this.body.anchorAt(this.cx, this.wl - 4, this.cz);
    g.audio.play('leviathan_roar', h.x, h.y, h.z, 1, 0.7, 140, g.renderer.camera.position);
    g.stimuli.emit('roar', h.x, h.y, h.z, 9, 650, { cause: 'threat', size: this.height });
    if (heroEarned(this.aggro)) g.crime.reward({ karma: LEVIATHAN.karma.defeated, why: 'brought the leviathan down', rep: 12, news: 'river monster defeated', stopped: true });
  }

  /** It slumps onto the water with a great splash, drifts a little and sinks. */
  private dying(dt: number): void {
    const g = this.g, B = this.body, H = B.head;
    const before = this.dieT;
    this.dieT += dt;
    const fx = this.cx + this.heading.x * 16, fz = this.cz + this.heading.z * 16;
    const ty = this.dieT < 2.5 ? this.wl + 1 : this.wl - 1 - (this.dieT - 2.5) * 0.3;
    B.moveHead(H.x + (fx - H.x) * Math.min(1, dt * 1.2), H.y + (ty - H.y) * Math.min(1, dt * (this.dieT < 2.5 ? 1.5 : 0.6)), H.z + (fz - H.z) * Math.min(1, dt * 1.2));
    B.setDir(this.heading.x, -0.1, this.heading.z);
    B.petal += (0.5 - B.petal) * Math.min(1, dt * 2);
    for (const Z of this.zones) Z.exposed = false;
    for (const t of this.tents) t.up = Math.max(0.3, t.up);
    if (before < 2.2 && this.dieT >= 2.2) {
      g.audio.play('splash_big', H.x, this.wl, H.z, 1, 0.6, 140, g.renderer.camera.position);
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2, r = this.rng.range(2, 14);
        g.dust.burst(H.x + Math.cos(a) * r, this.wl + 0.4, H.z + Math.sin(a) * r, 10, 4, 9, 4, 3, FOAM, -0.2, 0.7);
      }
      g.stimuli.emit('collapse', H.x, this.wl, H.z, 8, 700, { cause: 'threat', size: this.height });
      this.onBlow?.('fall', H.x, this.wl, H.z, 16);
    }
    if (this.mode === 'dying' && this.dieT > 6) this.mode = 'dead';
    // Gone under: the event ends.
    if (this.dieT > 26) { this.mode = 'gone'; this.active = false; }
  }

  // ---------------------------------------------------------------- effects

  private glows(dt: number): void {
    const B = this.body;
    const pits = this.defeated ? 0 : this.headAct === 'roar' ? 1 : this.surfaced ? 0.4 + 0.2 * Math.sin(this.t * 2.2) : 0.1;
    B.pits += (pits - B.pits) * Math.min(1, dt * 3);
    B.maw += ((this.defeated ? 0 : Math.min(1, B.petal * 1.2)) - B.maw) * Math.min(1, dt * 4);
    this.zone('maw').exposed = (B.petal > 0.45 || this.frozenT > 0) && this.surfaced;
  }

  /** Under the water: a V of foam, boils, the surge; drivers on the bridges ahead stop; news drones. */
  private surroundings(dt: number): void {
    const g = this.g, cam = g.renderer.camera.position;
    if (this.mode === 'gone') return;
    const under = this.phase === 'travel';
    const dc = Math.hypot(cam.x - this.cx, cam.z - this.cz);
    if (under && dc < 900) {
      this.wakeT -= dt;
      if (this.wakeT <= 0) {
        this.wakeT = 0.08;
        const hx = this.heading.x, hz = this.heading.z;
        const back = Math.random() * 40, side = (Math.random() < 0.5 ? -1 : 1) * back * 0.4;
        const x = this.cx + hx * 8 - hx * back - hz * side, z = this.cz + hz * 8 - hz * back + hx * side;
        g.elements.fx.soft(x, this.wl + 0.15, z, hx * 0.4, 0.05, hz * 0.4, 4.5, 1.6, 4, WATER_A, FOAM, 0.55, 0.3, 0);
        if (Math.random() < 0.08) g.dust.burst(this.cx + hx * 6, this.wl + 0.3, this.cz + hz * 6, 5, 2.5, 2.5, 2.5, 2, FOAM, -0.1, 0.5);
      }
      this.surgeT -= dt;
      if (this.surgeT <= 0 && dc < 500) { this.surgeT = this.rng.range(6, 11); g.audio.play('leviathan_surface', this.cx, this.wl, this.cz, 0.35, 0.6, 60, cam); }
    }
    this.stimT -= dt;
    if (this.stimT <= 0) {
      this.stimT = 1.3;
      g.stimuli.emit('threat', this.cx, this.wl + 4, this.cz, 6, under ? 90 : 180, { cause: 'threat' });
      // Drivers on the bridge ahead (or the one it is at) stop and back off.
      const S = this.here;
      for (const v of g.traffic.vehicles) if (v.state === VState.Drive && !v.task && Math.hypot(v.x - (S?.tx ?? this.cx), v.z - (S?.tz ?? this.cz)) < (under ? 60 : 120) && Math.hypot(v.x - this.cx, v.z - this.cz) < 260) v.fear = Math.max(v.fear, 1);
    }
    this.newsT -= dt;
    if (this.newsT <= 0 && !under && !this.defeated) { this.newsT = 35; g.future.drones.incident(DKind.News, this.cx, this.cz, g.player.pos.x, g.player.pos.z); }
  }

  private knock(a: PedAgent, fx: number, fz: number, power: number): void {
    if (a.inside || a.state === PState.Down) return;
    this.g.reactions.knockDown(a, fx, fz, power * dealtBy(this), 'threat');
    this.g.consequences.record('leviathan', 'person', 'knockdown', a.x, a.z, a, 'threat');
    this.hurt++;
    this.stats.knocked++;
  }

  private flingCar(v: Vehicle, jx: number, jy: number, jz: number): void {
    const g = this.g, k = dealtBy(this);
    g.vehicles.makeWreck(v, v.x, v.y, v.z, jx * k, jy * k, jz * k);
    g.consequences.record('leviathan', 'car', 'wreck', v.x, v.z, v, 'threat');
    g.audio.play('car_crash', v.x, v.y, v.z, 1, 0.8, 18, g.renderer.camera.position);
    this.stats.wrecked++;
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
    g.camRig.addShake(0.35);
  }

  private updateZones(): void {
    const B = this.body, J = B.j, s = B.scale;
    const set = (id: string, x: number, y: number, z: number, r: number) => { const Z = this.zone(id); Z.x = x; Z.y = y; Z.z = z; Z.r = r; };
    const m = B.mouth();
    set('maw', m.x, m.y, m.z, WORM.lip * s);
    set('head', J[3], J[4], J[5], 4 * s);
    set('neck', J[12], J[13], J[14], 4.4 * s);
    // The tentacle most out of the water.
    let best = this.tents[0];
    for (const t of this.tents) if (t.rig.head.y > best.rig.head.y) best = t;
    const T = best.rig.j;
    set('tentacle', T[9], T[10], T[11], 2);
    for (const Z of this.zones) if (Z.id !== 'maw') Z.exposed = this.surfaced;
  }

  // ================================================================== drawing, obstacles

  get visible(): boolean { return this.mode !== 'gone'; }

  /** The head (its neck going down into the water) and the tentacles that are out. */
  draw(mesh: WormMesh): number {
    if (!this.visible) return 0;
    let n = mesh.draw(this.body, 1);
    for (const t of this.tents) if (t.up > 0.02 || t.act === 'limp') n += mesh.draw(t.rig, 1);
    return n;
  }

  /** What stands out of the water is in the player's way. */
  obstacles(x0: number, z0: number, x1: number, z1: number, out: (o: import('../../../world/Collision').Obstacle) => void): void {
    if (!this.surfaced) return;
    this.hitCaps((c) => {
      const mx = (c.ax + c.bx) / 2, mz = (c.az + c.bz) / 2, r = c.r * 0.9;
      if (mx + r < x0 || mx - r > x1 || mz + r < z0 || mz - r > z1) return;
      out({ cyl: true, x: mx, z: mz, r, hx: 0, hz: 0, ux: 1, uz: 0, y0: Math.min(c.ay, c.by) - c.r, y1: Math.max(c.ay, c.by) + c.r });
    });
  }

  // ================================================================== dev

  devSurface(): string {
    if (this.phase !== 'travel' || this.mode !== 'advance') return this.phase;
    const S = this.here;
    if (!S) return 'no stop';
    this.s = S.s;
    const p = routeAt(this.route, this.s, _rp);
    this.cx = p.x; this.cz = p.z;
    this.body.reset(p.x, this.waterAt(p.x, p.z) - LEVIATHAN.depth, p.z, _rp.dx, -0.05, _rp.dz);
    this.startRise();
    return 'rise';
  }

  /** Dev: on to the stop nearest a point (the hero), at once. */
  devNear(x: number, z: number): string {
    let bi = -1, bd = Infinity;
    this.route.stops.forEach((p, i) => { const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; bi = i; } });
    if (bi < 0) return 'no stops';
    this.stop = bi;
    this.s = Math.max(0, this.route.stops[bi].s - 60);
    const p = routeAt(this.route, this.s, _rp);
    this.cx = p.x; this.cz = p.z;
    this.body.reset(p.x, this.waterAt(p.x, p.z) - LEVIATHAN.depth, p.z, _rp.dx, -0.05, _rp.dz);
    this.s = nearestS(this.route, p.x, p.z, this.s);
    return `stop ${bi} (${this.route.stops[bi].kind}) ${Math.round(bd)} m from you`;
  }

  devSink(): string { if (this.phase !== 'attack') return this.phase; this.startSink(); return 'sink'; }

  /** Dev: the next deck blow brings a span down. */
  devBreak(): string {
    const S = this.here;
    if (!S || S.kind !== 'bridge') return 'not at a bridge';
    const prof = this.g.world.bridges.find((b) => b.edge === S.edge);
    if (!prof) return 'no deck';
    const sm = (prof.s0 + prof.s1) / 2;
    return this.breaks.collapse(S.edge, sm, 'threat') ? 'collapsed' : 'no span left';
  }
}
