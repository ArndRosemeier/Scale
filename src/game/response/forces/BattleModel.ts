/**
 * The army's battle model (THREATS_PLAN §2 "Forces without the player", Phase B stage 2). Pure:
 * no three.js, no game — the game's force director (`Forces`) and the headless "no player"
 * simulation (`simulateBattle`, tools/selftest.ts) share it.
 *
 *  - Force kinds and their numbers (`FORCE`): infantry squads, army trucks, APCs, tanks, attack
 *    helicopters, jets and an artillery battery beyond the city edge; what arrives at levels 3 and 4
 *    (`ARMY.l3`, `ARMY.l4`).
 *  - `ForceUnit {kind, squad, pos, hp, morale, ammo, task}` and squads (the aggro key the monster
 *    books its anger to; shared morale).
 *  - Fire: hit chance (falling off with range, lower when shaken) × damage before armour, on a body
 *    zone picked by exposure; a weak spot only with line of sight and when it is exposed (the throat
 *    while charging, the belly while rearing). Army fire mostly chips armour and staggers.
 *  - Morale drops with losses and a roar close by; a squad below `ARMY.breakAt` falls back to the
 *    next line ("the line is breaking"), below `ARMY.routAt` it leaves.
 *  - Lines: slots ahead of the monster along its projected path (infantry on the flanks, tanks on
 *    the avenue itself), a ring round it once it is in downtown.
 *
 * The abstract simulation runs the monster as `SimMonster` — the Strider's rules in one dimension
 * along its route (emerge, walk at a 40 m body's pace, slower when hurt; roar, breath at whoever
 * hurt it most, tail swipe, footsteps, swatting helicopters near its head; stagger; back to the
 * river at 30 %, a rampage of 260 s in downtown) — against the ladder's arrivals. Deterministic per
 * seed; the army drives it off or brings it down in ARMY's tuned share of runs.
 */
import { Rng } from '../../../core/rng';

export type ForceKind = 'rifles' | 'truck' | 'apc' | 'tank' | 'heli' | 'jet' | 'artillery';
export type ForceTask = 'inbound' | 'move' | 'hold' | 'fallback' | 'mount' | 'orbit' | 'leave' | 'dead';

export interface Weapon {
  /** Reach (m), seconds between volleys, rounds per volley, damage per hit before armour. */
  range: number; reload: number; shots: number; dmg: number;
  /** Hit chance close in, and the distance (m) where it has halved. */
  acc: number; half: number;
  /** A volley is aimed at an exposed weak spot this often (when it can see it). */
  aimWeak: number;
  /** Chance an abstract (not materialised) volley has line of sight to the body (buildings in the way). */
  los: number;
}

export interface ForceSpec {
  name: string;
  /** Hit points (a squad: per soldier, × crew). */
  hp: number;
  /** Share of the monster's blows its armour stops. */
  armour: number;
  /** Speed (m/s) when abstract (straight line; detours are in ARMY.detour). */
  speed: number;
  crew: number;
  weapon: Weapon | null;
  /** Holding distance ahead of the monster along its path (m), off the route to the side (m). */
  ahead: number; side: number;
  /** Too close: fall back when the monster is nearer than this (m). */
  danger: number;
  /** Map / tooltip text. */
  title: string;
}

const W = (o: Partial<Weapon> & Pick<Weapon, 'range' | 'reload' | 'shots' | 'dmg' | 'acc' | 'half'>): Weapon => ({ aimWeak: 0.3, los: 0.6, ...o });

export const FORCE: Record<ForceKind, ForceSpec> = {
  rifles: {
    name: 'Infantry squad', hp: 100, armour: 0, speed: 3.4, crew: 6, ahead: 230, side: 26, danger: 75,
    weapon: W({ range: 270, reload: 2.5, shots: 6, dmg: 4.5, acc: 0.6, half: 220, aimWeak: 0.35, los: 0.55 }),
    title: 'National Guard squad — dug in behind sandbags',
  },
  truck: { name: 'Army truck', hp: 320, armour: 0.1, speed: 11, crew: 1, ahead: 330, side: 14, danger: 140, weapon: null, title: 'Army truck — troops and supplies' },
  apc: {
    name: 'APC', hp: 650, armour: 0.35, speed: 10, crew: 1, ahead: 280, side: 12, danger: 110,
    weapon: W({ range: 450, reload: 3, shots: 4, dmg: 13, acc: 0.6, half: 340, aimWeak: 0.3, los: 0.6 }),
    title: 'Armoured personnel carrier — autocannon',
  },
  tank: {
    name: 'Tank', hp: 1500, armour: 0.6, speed: 8, crew: 1, ahead: 360, side: 5, danger: 120,
    weapon: W({ range: 1000, reload: 7.5, shots: 1, dmg: 125, acc: 0.72, half: 750, aimWeak: 0.3, los: 0.65 }),
    title: 'Main battle tank — 120 mm gun',
  },
  heli: {
    name: 'Attack helicopter', hp: 420, armour: 0.1, speed: 45, crew: 1, ahead: 0, side: 0, danger: 0,
    weapon: W({ range: 320, reload: 16, shots: 8, dmg: 38, acc: 0.62, half: 380, aimWeak: 0.5, los: 0.95 }),
    title: 'Attack helicopter — rocket runs',
  },
  jet: {
    name: 'Strike jet', hp: 1e9, armour: 1, speed: 220, crew: 1, ahead: 0, side: 0, danger: 0,
    weapon: W({ range: 1e9, reload: 50, shots: 4, dmg: 210, acc: 0.5, half: 1e9, aimWeak: 0, los: 1 }),
    title: 'Strike jets — bombing runs',
  },
  artillery: {
    name: 'Artillery battery', hp: 1e9, armour: 1, speed: 0, crew: 1, ahead: 0, side: 0, danger: 0,
    weapon: W({ range: 1e9, reload: 30, shots: 3, dmg: 150, acc: 0.3, half: 1e9, aimWeak: 0, los: 1 }),
    title: 'Artillery beyond the city edge',
  },
};

export const ARMY = {
  /** Level 3 (National Guard): this long at level 2 (s) while it is still above this strength; or this many hurt. */
  up3: { after: 30, strength: 0.5, hurt: 25 },
  /** Level 4 (army & air): this long at level 3 (s), or the monster above this strength with the guard's lines breaking. */
  up4: { after: 55, strength: 0.4 },
  /** What each level sends: squads of [kind, count] (a rifle squad rides in a truck). */
  l3: { rifles: 4, apc: 2 },
  l4: { tankPlatoons: 3, tanksPer: 2, helis: 3, jets: 2, artillery: 1 },
  /** Units come from this far beyond the monster (m), ahead of it towards downtown. */
  spawnR: 720,
  /** Roads are not straight lines: abstract travel takes this much longer. */
  detour: 1.3,
  /** Morale: loss per soldier / vehicle lost, per breath close by, per roar within 300 m; recovery per s (after 20 s quiet). */
  loss: 0.17, scorched: 0.3, roar: 0.07, recover: 0.006,
  /** Fall back below this morale ("the line is breaking"); rout (leave) below this. */
  breakAt: 0.38, routAt: 0.1,
  /** Helicopters: orbit radius and altitude (m); a rocket run closes to this far from the head; swatted within this reach. */
  heliOrbit: 230, heliAlt: 75, heliPass: [40, 115] as [number, number], swatR: 54,
  /** The monster's blows on units: breath (radius m, damage), tail swipe (reach from the tail m, damage), feet (m). */
  breathR: 13, breathDmg: 950, swipeR: 34, swipeDmg: 1100, stepR: 12,
  /** In-game (materialised) units within this range of the player; abstract beyond `dematR`. */
  matR: 600, dematR: 700,
  /** Budgets (THREATS_PLAN §4): materialised vehicles / soldiers, helicopters, jets, tracers, impacts a second from response fire. */
  maxVehicles: 24, maxSoldiers: 48, maxHelis: 4, maxJets: 2, maxTracers: 256, impactsPerS: 6,
  /** Seconds between rays per squad (≈ 2 Hz). */
  rayGap: 0.5,
  /** After the event: units pack up and leave within this long (s). */
  leaveT: 40,
  /** Balance knob: every weapon's damage × this (the headless battle tunes the army's win rate with it). */
  firepower: 0.16,
};

/**
 * Whom the monster turns on: the one that hurt it most among those within reach (aggro ≥ 25); the
 * angriest of all may be out of reach (tanks far down the avenue) — then the next one.
 */
export function angriestInReach<T extends { x: number; z: number }>(aggro: ReadonlyMap<string, number>, where: (key: string) => T | null, x: number, z: number, reach: number): (T & { key: string }) | null {
  let best: (T & { key: string }) | null = null, bv = 25;
  for (const [key, v] of aggro) {
    if (v < bv) continue;
    const p = where(key);
    if (!p || Math.hypot(p.x - x, p.z - z) > reach) continue;
    bv = v; best = { ...p, key };
  }
  return best;
}

/** A body zone as the model sees it (the Strider's ThreatZone fits). */
export interface ZoneView { readonly id: string; readonly armour: number; readonly weak: boolean; readonly exposed: boolean }

/** Where volleys land on the body when nothing is aimed for (exposed surface): weights by zone id. */
export const ZONE_WEIGHT: Record<string, number> = {
  head: 0.07, throat: 0.03, neck: 0.1, back: 0.3, belly: 0.04, foreL: 0.08, foreR: 0.08, hindL: 0.08, hindR: 0.08, tail: 0.13,
};

/** Hit chance of one round at a distance (m), with the squad's morale. */
export function hitChance(w: Weapon, dist: number, morale: number): number {
  const fall = w.half >= 1e8 ? 1 : 1 / (1 + (dist / w.half) ** 2);
  return w.acc * fall * (0.55 + 0.45 * Math.max(0, Math.min(1, morale)));
}

/**
 * The zone a hit lands on: an exposed weak spot when the volley is aimed at it and can see it,
 * else by exposed surface (a rearing belly shows more).
 */
export function pickZone(rng: Rng, zones: readonly ZoneView[], los: boolean, aimWeak: number): ZoneView | null {
  if (!zones.length) return null;
  if (los && aimWeak > 0) {
    const weak = zones.filter((z) => z.weak && z.exposed);
    if (weak.length && rng.chance(aimWeak)) return weak[rng.int(0, weak.length - 1)];
  }
  let tot = 0;
  for (const z of zones) tot += zoneW(z);
  let r = rng.float() * tot;
  for (const z of zones) { r -= zoneW(z); if (r <= 0) return z; }
  return zones[zones.length - 1];
}

function zoneW(z: ZoneView): number {
  const w = ZONE_WEIGHT[z.id] ?? 0.05;
  return z.weak && z.exposed ? w * 3 : w;
}

/**
 * A volley at the monster in sight (the targeted rule, combat/shot.ts — the in-game army's direct
 * fire): every round hits; each does what a round of the chance-based volley did on average (hit
 * chance × damage), so the battle's balance stays where `volley` tuned it.
 */
export function aimedVolley(rng: Rng, w: Weapon, dist: number, morale: number, zones: readonly ZoneView[]): { zone: ZoneView; dmg: number }[] {
  const out: { zone: ZoneView; dmg: number }[] = [];
  if (dist > w.range) return out;
  const p = hitChance(w, dist, morale);
  for (let i = 0; i < w.shots; i++) {
    const z = pickZone(rng, zones, true, w.aimWeak);
    if (z) out.push({ zone: z, dmg: w.dmg * ARMY.firepower * p * rng.range(0.8, 1.2) });
  }
  return out;
}

/** One volley: the hits (zone, damage before armour) it lands. */
export function volley(rng: Rng, w: Weapon, dist: number, morale: number, zones: readonly ZoneView[], los: boolean): { zone: ZoneView; dmg: number }[] {
  const out: { zone: ZoneView; dmg: number }[] = [];
  if (dist > w.range) return out;
  const p = hitChance(w, dist, morale);
  for (let i = 0; i < w.shots; i++) {
    if (!rng.chance(p)) continue;
    const z = pickZone(rng, zones, los, w.aimWeak);
    if (z) out.push({ zone: z, dmg: w.dmg * ARMY.firepower * rng.range(0.8, 1.2) });
  }
  return out;
}

// ================================================================== units and squads

export interface ForceUnit {
  id: number;
  kind: ForceKind;
  /** The squad's key (the monster's aggro table books to it). */
  squad: string;
  /** Abstract position (ground units: on the ground; aircraft: y is the altitude). */
  x: number; y: number; z: number;
  hp: number; maxHp: number;
  /** Soldiers left (rifle squads), 1 for a vehicle. */
  crew: number;
  ammo: number;
  task: ForceTask;
  /** Where it is going / holding. */
  tx: number; tz: number;
  /** Seconds to its next volley. */
  cool: number;
  /** Which side of the route it holds (±1) and its slot in the squad. */
  side: number; slot: number;
  /** Helicopters: orbit angle, rocket-run phase. */
  ang: number; run: number;
  /** Seconds in the current task. */
  taskT: number;
  /** A rifle squad riding in its truck. */
  mounted: boolean;
}

export interface Squad {
  key: string;
  kind: ForceKind;
  level: 3 | 4;
  units: ForceUnit[];
  morale: number;
  losses: number;
  /** Seconds since the last loss. */
  quietT: number;
  /** Fell back ("the line is breaking") / routed. */
  broke: number;
  routed: boolean;
  /** Damage dealt (after armour) and volleys fired. */
  dealt: number; fired: number;
  /** Weak-spot hits. */
  weak: number;
}

let UNIT_ID = 1;

export function makeUnit(kind: ForceKind, squad: string, x: number, z: number, side: number, slot: number): ForceUnit {
  const S = FORCE[kind];
  return {
    id: UNIT_ID++, kind, squad, x, y: 0, z, hp: S.hp * S.crew, maxHp: S.hp * S.crew, crew: S.crew, ammo: kind === 'heli' ? 6 : kind === 'tank' ? 40 : 999,
    task: 'inbound', tx: x, tz: z, cool: 2 + slot * 0.7, side, slot, ang: 0, run: 0, taskT: 0, mounted: kind === 'rifles',
  };
}

export function makeSquad(key: string, kind: ForceKind, level: 3 | 4, units: ForceUnit[]): Squad {
  return { key, kind, level, units, morale: level === 3 ? 0.85 : 1, losses: 0, quietT: 99, broke: 0, routed: false, dealt: 0, fired: 0, weak: 0 };
}

/** A unit takes a blow from the monster (damage before its armour). True when it is lost (or a soldier is). */
export function hurtUnit(u: ForceUnit, sq: Squad, dmg: number, rng: Rng): { lost: number; dead: boolean } {
  if (u.task === 'dead') return { lost: 0, dead: true };
  const S = FORCE[u.kind];
  let lost = 0;
  if (u.kind === 'rifles') {
    // Each soldier in reach goes down with a chance (no gore: knocked down, hurt, out of the fight).
    const p = Math.min(0.9, dmg / 1200);
    for (let i = u.crew; i > 0; i--) if (rng.chance(p)) lost++;
    u.crew -= lost;
    u.hp = u.crew * S.hp;
  } else {
    u.hp -= dmg * (1 - S.armour);
    if (u.hp <= 0) lost = 1;
  }
  if (lost) { sq.losses += lost; sq.morale -= ARMY.loss * lost * (u.kind === 'rifles' ? 1 : 1.6); sq.quietT = 0; }
  const dead = u.kind === 'rifles' ? u.crew <= 0 : u.hp <= 0;
  if (dead) { u.task = 'dead'; u.hp = 0; }
  return { lost, dead };
}

/** Morale over time: recovers after a quiet spell; the squad breaks and routs at the thresholds. */
export function moraleStep(sq: Squad, dt: number): 'ok' | 'break' | 'rout' {
  sq.quietT += dt;
  if (sq.quietT > 20) sq.morale = Math.min(sq.level === 3 ? 0.85 : 1, sq.morale + ARMY.recover * dt);
  sq.morale = Math.max(0, sq.morale);
  if (!sq.units.some((u) => u.task !== 'dead' && u.task !== 'leave')) return 'ok';
  if (!sq.routed && sq.morale < ARMY.routAt) { sq.routed = true; return 'rout'; }
  if (sq.morale < ARMY.breakAt) return 'break';
  return 'ok';
}

// ================================================================== lines (where units hold)

export interface PathView {
  /** Route polyline (x, z, …) with arc lengths, as StriderRoute. */
  pts: number[]; s: number[]; length: number;
}

const _p = { x: 0, z: 0, dx: 0, dz: 0 };

/** Point and direction on the route at arc length s (clamped). */
export function pathAt(r: PathView, s: number, out = _p): typeof _p {
  const S = r.s, P = r.pts;
  s = Math.max(0, Math.min(r.length, s));
  let lo = 0, hi = S.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
  const t = S[hi] > S[lo] ? (s - S[lo]) / (S[hi] - S[lo]) : 0;
  const ax = P[lo * 2], az = P[lo * 2 + 1], bx = P[hi * 2], bz = P[hi * 2 + 1];
  out.x = ax + (bx - ax) * t; out.z = az + (bz - az) * t;
  const l = Math.hypot(bx - ax, bz - az) || 1;
  out.dx = (bx - ax) / l; out.dz = (bz - az) / l;
  return out;
}

/**
 * Where a unit of a kind holds: `ahead` m further along the monster's path than `s` (its projected
 * position when the unit gets there), off to its side; once the path runs out (downtown), on a
 * ring round the path's end, on the unit's side of it.
 */
export function slotFor(r: PathView, s: number, kind: ForceKind, side: number, slot: number, fromX: number, fromZ: number): { x: number; z: number } {
  const S = FORCE[kind];
  // Where the path ahead runs straight (a line of sight down the avenue), no farther than its holding distance.
  const want = straightTo(r, s, s + S.ahead + slot * 18, S.danger + 50);
  const lat = side * (S.side + (slot % 3) * 6);
  if (want <= r.length - 30) {
    const p = pathAt(r, want);
    return { x: p.x - p.dz * lat, z: p.z + p.dx * lat };
  }
  // Downtown: a ring round where it will stand, on the side the unit comes from.
  const e = pathAt(r, r.length);
  let ax = fromX - e.x, az = fromZ - e.z;
  const l = Math.hypot(ax, az) || 1; ax /= l; az /= l;
  const a = Math.atan2(az, ax) + side * (0.25 + slot * 0.18);
  const R = S.ahead * 0.75 + 60;
  return { x: e.x + Math.cos(a) * R, z: e.z + Math.sin(a) * R };
}

/**
 * The farthest point along the path from s0 up to `want` (not nearer than s0 + `min`) that the path
 * between them stays within a few metres of the straight line: a unit there sees down the avenue.
 */
export function straightTo(r: PathView, s0: number, want: number, min: number): number {
  const S = r.s, P = r.pts;
  const a = pathAt(r, s0, { x: 0, z: 0, dx: 0, dz: 0 });
  const ax = a.x, az = a.z;
  for (let s = want; s > s0 + min; s -= 20) {
    const b = pathAt(r, s, { x: 0, z: 0, dx: 0, dz: 0 });
    const dx = b.x - ax, dz = b.z - az, l = Math.hypot(dx, dz) || 1;
    let worst = 0;
    for (let i = 0; i < S.length; i++) {
      if (S[i] <= s0 || S[i] >= s) continue;
      worst = Math.max(worst, Math.abs((P[i * 2] - ax) * dz - (P[i * 2 + 1] - az) * dx) / l);
      if (worst > 12) break;
    }
    if (worst <= 12) return s;
  }
  return Math.max(s0 + min, Math.min(want, s0 + min));
}

// ================================================================== the monster, abstract (headless)

/** The monster's numbers the simulation needs (the Strider's: STRIDER and its zones). */
export interface MonsterSpec {
  hp: number; height: number; pace: number;
  retreatAt: number; rampageT: number; emergeT: number;
  roarGap: [number, number]; roarT: number; rearChance: number;
  breathGap: [number, number]; chargeT: number; breathT: number; breathRange: number;
  swipeGap: [number, number]; swipeT: number;
  weakMul: number; staggerAt: number; staggerT: number;
  zones: { id: string; armour: number; weak: boolean }[];
}

type SimAct = null | 'roar' | 'charge' | 'breath' | 'swipe' | 'stagger' | 'swat';

/** The Strider's rules along its route (the headless "no player" battle). */
export class SimMonster {
  hp: number;
  s = 0;
  t = 0;
  mode: 'emerge' | 'advance' | 'rampage' | 'retreat' | 'dead' = 'emerge';
  act: SimAct = null;
  actT = 0;
  readonly zones: { id: string; armour: number; weak: boolean; exposed: boolean; recent: number }[];
  readonly aggro = new Map<string, number>();
  x = 0; z = 0; fx = 0; fz = 1;
  private cool = { roar: 0, breath: 26, swipe: 12, swat: 0 };
  private recentHit = 0;
  private rampT = 0;
  private breathAt: { x: number; z: number } | null = null;
  rearing = false;
  stats = { breaths: 0, swipes: 0, swats: 0, staggers: 0, chokes: 0, weakHits: 0, dealt: 0, roars: 0 };

  constructor(readonly spec: MonsterSpec, readonly path: PathView, private rng: Rng) {
    this.hp = spec.hp;
    this.zones = spec.zones.map((z) => ({ ...z, exposed: false, recent: 0 }));
    this.place();
  }

  get active(): boolean { return this.mode === 'emerge' || this.mode === 'advance' || this.mode === 'rampage'; }
  /** Head (swats) and tail (swipes) in the plane. */
  get head(): { x: number; z: number; y: number } { return { x: this.x + this.fx * 24, z: this.z + this.fz * 24, y: this.spec.height * (this.rearing ? 1.4 : 0.8) }; }
  get tail(): { x: number; z: number } { return { x: this.x - this.fx * 32, z: this.z - this.fz * 32 }; }

  private place(): void {
    const p = pathAt(this.path, this.s);
    this.x = p.x; this.z = p.z; this.fx = p.dx; this.fz = p.dz;
  }

  zone(id: string) { return this.zones.find((z) => z.id === id) ?? this.zones[0]; }

  damage(zone: { id: string }, amount: number, key: string): number {
    if (this.mode === 'dead' || amount <= 0) return 0;
    const Z = this.zone(zone.id);
    const weak = Z.weak && Z.exposed;
    const dealt = amount * (1 - (weak ? 0.05 : Z.armour)) * (weak ? this.spec.weakMul : 1);
    this.hp = Math.max(0, this.hp - dealt);
    Z.recent += dealt;
    this.recentHit += dealt;
    this.stats.dealt += dealt;
    if (weak) this.stats.weakHits++;
    this.aggro.set(key, (this.aggro.get(key) ?? 0) + dealt + amount * 0.02);
    // The glowing throat hit hard: the breath is choked off; hard hits stagger it.
    if (weak && Z.id === 'throat' && (this.act === 'charge' || this.act === 'breath') && dealt > 60) { this.stats.chokes++; this.cool.breath = 12; this.stagger(); }
    else if ((Z.id.startsWith('fore') || Z.id.startsWith('hind')) && Z.recent > 240 && this.act !== 'stagger') { Z.recent *= 0.4; this.stagger(); }
    else if (this.recentHit > this.spec.staggerAt && this.act !== 'stagger' && this.act !== 'breath') { this.recentHit *= 0.3; this.stagger(); }
    return dealt;
  }

  private stagger(): void { this.act = 'stagger'; this.actT = this.spec.staggerT; this.stats.staggers++; this.breathAt = null; }

  topAggro(): { key: string; v: number } | null {
    let best: { key: string; v: number } | null = null;
    for (const [key, v] of this.aggro) if (!best || v > best.v) best = { key, v };
    return best;
  }

  /**
   * One step. `target(key)`: where a squad stands (for the breath); `air`: a helicopter near the
   * head; `blow(kind, x, z, r)`: the monster's blows on whatever stands there.
   */
  step(dt: number, target: (key: string) => { x: number; z: number } | null, air: () => boolean, blow: (kind: 'breath' | 'swipe' | 'step' | 'roar' | 'swat', x: number, z: number, r: number) => void): void {
    const S = this.spec, rng = this.rng;
    this.t += dt;
    for (const [k, v] of this.aggro) { const nv = v * Math.exp(-dt / 90); if (nv < 1) this.aggro.delete(k); else this.aggro.set(k, nv); }
    for (const Z of this.zones) Z.recent *= Math.exp(-dt / 4);
    this.recentHit *= Math.exp(-dt / 2);
    this.cool.roar -= dt; this.cool.breath -= dt; this.cool.swipe -= dt; this.cool.swat -= dt;
    if (this.mode === 'dead' || this.mode === 'retreat') return;
    if (this.mode === 'emerge') { if (this.t >= S.emergeT) { this.mode = 'advance'; this.startRoar(blow); } return; }
    if (this.hp <= 0) { this.mode = 'dead'; return; }
    if (this.hp < S.hp * S.retreatAt) { this.mode = 'retreat'; return; }
    // Acting.
    if (this.act) {
      this.actT -= dt;
      if (this.act === 'charge') { this.zone('throat').exposed = true; if (this.actT <= 0) { this.act = 'breath'; this.actT = S.breathT; this.stats.breaths++; } }
      else if (this.act === 'breath') {
        this.zone('throat').exposed = true;
        if (this.breathAt) blow('breath', this.breathAt.x, this.breathAt.z, ARMY.breathR);
        if (this.actT <= 0) { this.act = null; this.breathAt = null; this.cool.breath = rng.range(S.breathGap[0], S.breathGap[1]); }
      } else if (this.act === 'swipe') {
        if (this.actT < S.swipeT * 0.6 && this.actT + dt >= S.swipeT * 0.6) { const T = this.tail; blow('swipe', T.x, T.z, ARMY.swipeR); }
        if (this.actT <= 0) { this.act = null; this.cool.swipe = rng.range(S.swipeGap[0], S.swipeGap[1]); }
      } else if (this.actT <= 0) {
        if (this.act === 'roar' && this.rearing) this.rearing = false;
        this.act = null;
      }
    }
    if (this.act !== 'charge' && this.act !== 'breath') this.zone('throat').exposed = false;
    this.zone('belly').exposed = this.rearing && this.act === 'roar';
    if (!this.act) this.decide(target, air, blow);
    // Moving (stands while breathing, roaring, staggering; slower when hurt).
    const factor = this.act === null ? 1 : this.act === 'swipe' ? 0.35 : this.act === 'swat' ? 0.5 : 0;
    const v = S.pace * Math.sqrt(S.height / 1.8) * factor * (0.55 + 0.45 * Math.max(0.3, this.hp / S.hp));
    if (this.mode === 'advance') {
      const was = Math.floor(this.s / 7.5);
      this.s = Math.min(this.path.length, this.s + v * dt * 0.92);
      this.place();
      if (Math.floor(this.s / 7.5) !== was) blow('step', this.x, this.z, ARMY.stepR);
      if (this.s >= this.path.length - 12) { this.mode = 'rampage'; this.rampT = 0; }
    } else if (this.mode === 'rampage') {
      this.rampT += dt;
      // Goes from tower to tower round the end of its path.
      const a = this.rampT * 0.03;
      const e = pathAt(this.path, this.path.length);
      const nx = e.x + Math.cos(a) * 60, nz = e.z + Math.sin(a) * 60;
      const d = Math.hypot(nx - this.x, nz - this.z);
      if (d > 1 && factor > 0) { this.fx = (nx - this.x) / d; this.fz = (nz - this.z) / d; const st = Math.min(d, v * dt * 0.5); this.x += this.fx * st; this.z += this.fz * st; }
      if (this.rampT > S.rampageT) this.mode = 'retreat';
    }
  }

  private decide(target: (key: string) => { x: number; z: number } | null, air: () => boolean, blow: (kind: 'breath' | 'swipe' | 'step' | 'roar' | 'swat', x: number, z: number, r: number) => void): void {
    const S = this.spec, rng = this.rng;
    if (this.cool.swat <= 0) {
      this.cool.swat = 0.6;
      if (air()) { this.act = 'swat'; this.actT = 0.9; this.stats.swats++; const h = this.head; blow('swat', h.x, h.z, ARMY.swatR); return; }
    }
    if (this.cool.breath <= 0) {
      // At whoever hurt it most (in reach), else at a building (nothing of the army there).
      const p = angriestInReach(this.aggro, target, this.x, this.z, S.breathRange * 0.95);
      this.breathAt = p ? { x: p.x, z: p.z } : null;
      this.act = 'charge'; this.actT = S.chargeT;
      return;
    }
    if (this.cool.roar <= 0) { this.startRoar(blow); return; }
    if (this.cool.swipe <= 0) { this.act = 'swipe'; this.actT = S.swipeT; this.stats.swipes++; return; }
  }

  private startRoar(blow: (kind: 'roar', x: number, z: number, r: number) => void): void {
    const S = this.spec;
    this.act = 'roar'; this.actT = S.roarT; this.stats.roars++;
    this.rearing = this.rng.chance(S.rearChance);
    this.cool.roar = this.rng.range(S.roarGap[0], S.roarGap[1]);
    blow('roar', this.x, this.z, 300);
  }
}


// ================================================================== forces, step by step

/** The monster as the force model sees it (SimMonster, or the game's Strider through an adapter). */
export interface MonsterView {
  readonly x: number; readonly z: number;
  /** Progress along its path (m) and what it is doing ('advance', 'rampage' in downtown …). */
  readonly s: number; readonly mode: string;
  readonly zones: readonly ZoneView[];
  readonly head: { x: number; z: number; y: number };
  damage(zone: ZoneView, amount: number, key: string): number;
}

/** The game's hooks: how materialised units move and fire (absent: the abstract rules). */
export interface ForceOps {
  /** Snap a slot to where the unit can stand (a street point for a vehicle). */
  slot?(u: ForceUnit, x: number, z: number): { x: number; z: number };
  /** Move a materialised unit towards (x, z) (its position comes from its body); true when there. Undefined: not materialised. */
  move?(u: ForceUnit, x: number, z: number, dt: number): boolean | undefined;
  /** Fire a volley the game's way (rays, tracers, shells, a jet run): true when it did; false: resolved abstractly. */
  fire?(u: ForceUnit, q: Squad, dist: number): boolean;
  /** Squad events: 'break' (the line is breaking), 'rout', 'dismount', 'mount', 'hold'. */
  event?(q: Squad, what: string, u?: ForceUnit): void;
}

/**
 * Forces for one step: move (straight lines at their speed, or the game's bodies), hold their slots,
 * fall back when it comes too close or the squad breaks, fire volleys. A rifle squad rides in its
 * truck to a slot on the monster's flank, gets out and digs in; it falls back on foot, away from it,
 * and once the monster has passed by it mounts again and the truck takes it to the next line.
 * Helicopters circle and make rocket runs; jets and the artillery strike on their timers.
 */
export function stepForces(squads: Squad[], mon: MonsterView, path: PathView, dt: number, rng: Rng, dealt: (u: ForceUnit, d: number) => void, ops: ForceOps = {}): void {
  for (const q of squads) {
    const m = moraleStep(q, dt);
    if (m === 'break' && !q.units.some((u) => u.task === 'fallback')) {
      q.broke++;
      for (const u of q.units) if (u.task === 'hold') u.task = 'fallback';
      q.morale = Math.max(q.morale, ARMY.breakAt + 0.12);
      ops.event?.(q, 'break');
    }
    if (m === 'rout') { for (const u of q.units) if (u.task !== 'dead') u.task = 'leave'; ops.event?.(q, 'rout'); }
    for (const u of q.units) if (u.task !== 'dead') stepUnit(u, q, mon, path, dt, rng, dealt, ops);
  }
}

/**
 * A target that moves where it likes (a rampaging giant player, not a monster on its route): units
 * holding out of reach of it for `minT` s go again — to a new slot round it; and units still on their
 * way to a slot it has long since left behind are sent to a new one. Out of reach: past the weapon's
 * range, or past `reach` (m, by kind) when given — in a city a gun outranges its line of sight.
 */
export function regroup(squads: Squad[], mon: MonsterView, minT: number, reach: Partial<Record<ForceKind, number>> = {}): void {
  for (const q of squads) for (const u of q.units) {
    if (u.taskT < minT || u.kind === 'heli' || u.kind === 'jet' || u.kind === 'artillery' || u.kind === 'truck') continue;
    const W = FORCE[u.kind].weapon;
    if (!W) continue;
    const R = Math.min(W.range, reach[u.kind] ?? W.range);
    // (On the way to a slot that is now well out of reach of it: a new slot, from where it is.)
    // (A rifle squad on foot waits for its truck to fetch it, when it has one.)
    const fetch = () => (u.kind === 'rifles' && !u.mounted && q.units.some((t) => t.kind === 'truck' && t.task !== 'dead' && t.task !== 'leave') ? 'mount' : 'inbound');
    if (u.task === 'move') {
      if (Math.hypot(u.tx - mon.x, u.tz - mon.z) > R + 200) { u.task = fetch(); u.taskT = 0; }
      continue;
    }
    if (u.task !== 'hold' || u.mounted) continue;
    // (Out of reach: the ring round the target lies inside it.)
    if (Math.hypot(u.x - mon.x, u.z - mon.z) <= R) continue;
    u.task = fetch();
    u.taskT = 0;
  }
}

function stepUnit(u: ForceUnit, q: Squad, mon: MonsterView, path: PathView, dt: number, rng: Rng, dealt: (u: ForceUnit, d: number) => void, ops: ForceOps): void {
  u.taskT += dt;
  const S = FORCE[u.kind];
  const d = Math.hypot(u.x - mon.x, u.z - mon.z);
  const go = (x: number, z: number, v: number) => { const r = ops.move?.(u, x, z, dt); return r !== undefined ? r : moveTo(u, x, z, v, dt); };
  const slot = (p: { x: number; z: number }) => (ops.slot ? ops.slot(u, p.x, p.z) : p);
  const ahead = () => {
    // The slot ahead of where it will be by the time the unit gets there.
    const v = u.kind === 'rifles' && !u.mounted ? S.speed : u.kind === 'rifles' ? FORCE.truck.speed : S.speed;
    const travel = d / (v / ARMY.detour);
    const proj = mon.mode === 'rampage' ? path.length : mon.s + Math.min(travel, 60) * 4.5;
    return slot(slotFor(path, proj, u.kind, u.side, u.slot, u.x, u.z));
  };
  const away = (r: number) => {
    const ax = u.x - mon.x, az = u.z - mon.z, l = Math.hypot(ax, az) || 1;
    return slot({ x: mon.x + (ax / l) * r, z: mon.z + (az / l) * r });
  };
  if (u.kind === 'heli') { heliStep(u, q, mon, dt, rng, dealt, ops); return; }
  if (u.kind === 'jet' || u.kind === 'artillery') {
    if (u.task === 'leave') return;
    u.task = 'hold';
    u.cool -= dt;
    if (u.cool <= 0) { u.cool = S.weapon!.reload * rng.range(0.85, 1.15); if (!ops.fire?.(u, q, 0)) fireAt(u, q, mon, 0, rng, true, dealt); }
    return;
  }
  if (u.task === 'leave') { go(u.x + (u.x - mon.x), u.z + (u.z - mon.z), S.speed / ARMY.detour); return; }
  const truck = q.units.find((t) => t.kind === 'truck' && t.task !== 'dead' && t.task !== 'leave');
  const rifles = q.units.find((t) => t.kind === 'rifles' && t.task !== 'dead');
  if (u.kind === 'truck') {
    // The squad's truck: takes them to their slot, waits nearby, fetches them for the next line.
    if (rifles?.mounted) { if (go(rifles.tx, rifles.tz, S.speed / ARMY.detour)) u.task = 'hold'; else u.task = 'move'; return; }
    if (rifles?.task === 'mount') { go(rifles.x, rifles.z, S.speed / ARMY.detour); u.task = 'move'; return; }
    if (d < S.danger) { const p = away(S.danger * 2); u.tx = p.x; u.tz = p.z; }
    else if (u.task !== 'hold' && Math.hypot(u.tx - u.x, u.tz - u.z) < 3) u.task = 'hold';
    if (Math.hypot(u.tx - u.x, u.tz - u.z) > 3) go(u.tx, u.tz, S.speed / ARMY.detour);
    return;
  }
  if (u.kind === 'rifles' && u.mounted) {
    if (!truck) { u.mounted = false; u.task = 'inbound'; }
    else {
      u.x = truck.x; u.z = truck.z;
      if (u.task === 'inbound' || u.task === 'mount' || u.task === 'fallback') { const p = ahead(); u.tx = p.x; u.tz = p.z; u.task = 'move'; }
      // At the slot: out of the truck (which parks a little way back).
      if (Math.hypot(truck.x - u.tx, truck.z - u.tz) < 25 || (truck.task === 'hold' && truck.taskT > 2)) {
        u.mounted = false; u.task = 'move';
        truck.tx = truck.x; truck.tz = truck.z; truck.task = 'hold';
        ops.event?.(q, 'dismount', u);
      }
      return;
    }
  }
  // Too close (or the squad broke): back away from it (rifles on foot, out of its path; vehicles to the next line).
  if (u.task === 'fallback' || (u.task === 'hold' && d < S.danger)) {
    const p = u.kind === 'rifles' || mon.mode === 'rampage' ? away(S.danger * 2.3) : ahead();
    u.tx = p.x; u.tz = p.z; u.task = 'move'; u.taskT = 0;
  }
  if (u.task === 'inbound') { const p = ahead(); u.tx = p.x; u.tz = p.z; u.task = 'move'; u.taskT = 0; }
  if (u.task === 'move') {
    if (go(u.tx, u.tz, S.speed / ARMY.detour)) { u.task = 'hold'; u.taskT = 0; ops.event?.(q, 'hold', u); }
    return;
  }
  if (u.task === 'mount') {
    // Waiting for the truck to fetch them.
    if (!truck) { u.task = 'hold'; return; }
    if (Math.hypot(truck.x - u.x, truck.z - u.z) < 30) { u.mounted = true; u.task = 'inbound'; ops.event?.(q, 'mount', u); return; }
  }
  // Holding (or waiting): fire when it is in reach.
  u.cool -= dt;
  const W = S.weapon;
  if (u.cool <= 0 && W && d < W.range) {
    u.cool = W.reload * rng.range(0.85, 1.2);
    if (!ops.fire?.(u, q, d)) fireAt(u, q, mon, d, rng, rng.chance(W.los), dealt);
  }
  // The monster has gone by (out of reach, past them): the truck takes them to the next line.
  // (Not while it is still coming towards them: only when the next line is somewhere else.)
  if (u.kind === 'rifles' && u.task === 'hold' && truck && d > (W?.range ?? 200) + 60 && u.taskT > 8) {
    const p = ahead();
    if (Math.hypot(p.x - u.x, p.z - u.z) > 150) { u.task = 'mount'; u.taskT = 0; }
  }
}

function moveTo(u: ForceUnit, x: number, z: number, v: number, dt: number): boolean {
  const dx = x - u.x, dz = z - u.z, d = Math.hypot(dx, dz);
  if (d < 2) return true;
  const s = Math.min(d, v * dt);
  u.x += (dx / d) * s; u.z += (dz / d) * s;
  return d - s < 2;
}

/** A volley resolved abstractly (no rays): hits by chance, a weak spot only with line of sight. */
export function fireAt(u: ForceUnit, q: Squad, mon: MonsterView, dist: number, rng: Rng, los: boolean, dealt: (u: ForceUnit, d: number) => void): void {
  const w = FORCE[u.kind].weapon!;
  q.fired++;
  const crewK = u.kind === 'rifles' ? u.crew / FORCE.rifles.crew : 1;
  for (const h of volley(rng, w, dist, q.morale, mon.zones, los)) {
    if (crewK < 1 && !rng.chance(crewK)) continue;
    land(u, q, mon, h.zone, h.dmg, dealt);
  }
}

/** One hit lands (booked to the squad). */
export function land(u: ForceUnit, q: Squad, mon: MonsterView, zone: ZoneView, dmg: number, dealt: (u: ForceUnit, d: number) => void): number {
  const before = zone.weak && zone.exposed;
  const dd = mon.damage(zone, dmg, q.key);
  q.dealt += dd;
  if (before) q.weak++;
  dealt(u, dd);
  return dd;
}

/** A helicopter: circles at ARMY.heliOrbit; every reload a rocket run in, firing, and a break past it. */
function heliStep(u: ForceUnit, q: Squad, mon: MonsterView, dt: number, rng: Rng, dealt: (u: ForceUnit, d: number) => void, ops: ForceOps): void {
  const S = FORCE.heli;
  if (u.task === 'leave') { moveTo(u, u.x + (u.x - mon.x) * 2, u.z + (u.z - mon.z) * 2, S.speed, dt); return; }
  if (u.task === 'inbound') {
    const tx = mon.x + Math.cos(u.ang) * ARMY.heliOrbit, tz = mon.z + Math.sin(u.ang) * ARMY.heliOrbit;
    if (moveTo(u, tx, tz, S.speed, dt)) { u.task = 'orbit'; u.cool = 4 + u.slot * 3; }
    return;
  }
  u.cool -= dt;
  if (u.run <= 0) {
    // Circling.
    u.ang += dt * 0.12;
    moveTo(u, mon.x + Math.cos(u.ang) * ARMY.heliOrbit, mon.z + Math.sin(u.ang) * ARMY.heliOrbit, S.speed * 0.6, dt);
    if (u.cool <= 0 && u.ammo > 0) { u.run = 1; u.taskT = 0; u.tx = rng.range(ARMY.heliPass[0], ARMY.heliPass[1]); }
    return;
  }
  // Rocket run: close in to the pass distance, fire on the way, break off.
  const h = mon.head;
  const d = Math.hypot(u.x - h.x, u.z - h.z);
  if (u.run === 1) {
    moveTo(u, h.x + (u.x - h.x) / (d || 1) * u.tx, h.z + (u.z - h.z) / (d || 1) * u.tx, S.speed * 0.8, dt);
    if (d < 300) { u.run = 2; u.ammo--; if (!ops.fire?.(u, q, d)) fireAt(u, q, mon, d, rng, true, dealt); }
  } else if (u.run === 2) {
    moveTo(u, h.x + (u.x - h.x) / (d || 1) * u.tx, h.z + (u.z - h.z) / (d || 1) * u.tx, S.speed * 0.6, dt);
    if (d <= u.tx + 4) { u.run = 3; u.taskT = 0; }
  } else {
    u.ang += dt * 0.6;
    moveTo(u, mon.x + Math.cos(u.ang) * ARMY.heliOrbit, mon.z + Math.sin(u.ang) * ARMY.heliOrbit, S.speed, dt);
    if (u.taskT > 6) { u.run = 0; u.cool = S.weapon!.reload * rng.range(0.85, 1.2); if (u.ammo <= 0) u.task = 'leave'; }
  }
}

/** The squads a level sends (keys, kinds, units at their spawn points). */
export function levelSquads(level: 3 | 4, spawn: (k: number) => { x: number; z: number }): Squad[] {
  const out: Squad[] = [];
  let n = 0;
  const add = (kinds: ForceKind[], key: string, count = 1) => {
    const units: ForceUnit[] = [];
    for (let i = 0; i < count; i++) for (const kind of kinds) {
      const p = spawn(n);
      const u = makeUnit(kind, key, p.x, p.z, (n & 1) ? 1 : -1, i);
      if (kind === 'heli') { u.y = ARMY.heliAlt; u.ang = n * 1.7; }
      units.push(u);
    }
    n++;
    out.push(makeSquad(key, kinds[kinds.length - 1], level, units));
  };
  if (level === 3) {
    for (let i = 0; i < ARMY.l3.rifles; i++) add(['truck', 'rifles'], `guard-squad-${i + 1}`);
    for (let i = 0; i < ARMY.l3.apc; i++) add(['apc'], `guard-apc-${i + 1}`);
  } else {
    for (let i = 0; i < ARMY.l4.tankPlatoons; i++) add(['tank'], `army-tanks-${i + 1}`, ARMY.l4.tanksPer);
    for (let i = 0; i < ARMY.l4.helis; i++) add(['heli'], `army-heli-${i + 1}`);
    add(['jet'], 'air-jets', ARMY.l4.jets);
    add(['artillery'], 'army-artillery', ARMY.l4.artillery);
  }
  return out;
}

// ================================================================== the headless battle

export interface BattleResult {
  /** 'army': driven off or brought down by the army; 'monster': it finished its rampage (levelled blocks, left on its own). */
  winner: 'army' | 'monster';
  outcome: 'defeated' | 'retreated' | 'rampaged';
  t: number;
  hp: number;
  levelAt: number[];
  /** Units lost by kind (soldiers for rifle squads), squads that broke / routed, damage dealt by kind. */
  lost: Record<string, number>;
  broke: number; routed: number;
  dealtBy: Record<string, number>;
  monster: SimMonster['stats'];
  /** The most units on the field at once, by kind (budgets). */
  peak: Record<string, number>;
  /** Fingerprint of the run (determinism). */
  hash: number;
}

/**
 * The "no player" battle: the monster walks its path; the city's response climbs the ladder like
 * the game's (levels 1 and 2 by the major-threat timings, then 3 and 4 by ARMY.up3 / up4); units
 * come from beyond it, take positions ahead, fire, fall back, break and leave; the monster answers
 * by aggro. Deterministic per seed.
 */
export function simulateBattle(spec: MonsterSpec, path: PathView, seed: number, opts: { dt?: number; maxT?: number; level?: { up1: number; up2: number } } = {}): BattleResult {
  const rng = new Rng(seed);
  const mon = new SimMonster(spec, path, rng.fork('monster'));
  const dt = opts.dt ?? 0.5, maxT = opts.maxT ?? 900;
  const L = opts.level ?? { up1: 10, up2: 25 };
  const squads: Squad[] = [];
  const lost: Record<string, number> = {};
  const dealtBy: Record<string, number> = {};
  const peak: Record<string, number> = {};
  const levelAt = [0];
  let level = 0, levelT = 0, hurtGuess = 0;
  let t = 0, hash = 2166136261;
  const fire = rng.fork('fire');
  const blowRng = rng.fork('blows');
  const centroid = (key: string) => {
    const q = squads.find((s) => s.key === key);
    const us = q?.units.filter((u) => u.task !== 'dead' && u.task !== 'leave' && !u.mounted && u.kind !== 'jet' && u.kind !== 'artillery') ?? [];
    if (!us.length) return null;
    return { x: us.reduce((a, u) => a + u.x, 0) / us.length, z: us.reduce((a, u) => a + u.z, 0) / us.length };
  };
  const blow = (kind: 'breath' | 'swipe' | 'step' | 'roar' | 'swat', x: number, z: number, r: number) => {
    for (const q of squads) for (const u of q.units) {
      if (u.task === 'dead' || u.task === 'leave' || u.kind === 'jet' || u.kind === 'artillery' || u.mounted) continue;
      const d = Math.hypot(u.x - x, u.z - z);
      if (kind === 'roar') { if (d < r) q.morale -= ARMY.roar * (d < 120 ? 2 : 1); continue; }
      if (kind === 'swat') { if (u.kind === 'heli' && d < r && u.run > 0) { u.hp = 0; u.task = 'dead'; q.losses++; q.morale -= ARMY.loss * 1.6; q.quietT = 0; lost.heli = (lost.heli ?? 0) + 1; } continue; }
      if (u.kind === 'heli' || d > r) continue;
      const dmg = kind === 'breath' ? ARMY.breathDmg * dt : kind === 'swipe' ? ARMY.swipeDmg : 2500;
      const crew = u.crew;
      const res = hurtUnit(u, q, dmg * (1 - d / (r * 1.6)), blowRng);
      if (res.lost) lost[u.kind] = (lost[u.kind] ?? 0) + (u.kind === 'rifles' ? crew - u.crew : 1);
      if (res.dead && u.kind === 'truck') { const rf = q.units.find((x) => x.kind === 'rifles' && x.mounted); if (rf) { rf.mounted = false; rf.task = 'inbound'; } }
      if (kind === 'breath') q.morale -= ARMY.scorched * dt;
    }
  };
  const heliNear = () => {
    const h = mon.head;
    return squads.some((q) => q.units.some((u) => u.kind === 'heli' && u.task !== 'dead' && u.run > 0 && Math.hypot(u.x - h.x, u.z - h.z) < ARMY.swatR));
  };
  // Arrivals: from beyond it towards downtown, spread to the sides.
  const spawn = (k: number): { x: number; z: number } => {
    const e = pathAt(path, Math.min(path.length, mon.s + ARMY.spawnR));
    const a = (k * 2.399) % (Math.PI * 2);
    return { x: e.x + Math.cos(a) * 120, z: e.z + Math.sin(a) * 120 };
  };
  for (t = 0; t < maxT; t += dt) {
    // The ladder (as the game: majors go up fast; 3 and 4 by ARMY).
    levelT += dt;
    hurtGuess += dt * 0.12;
    const strength = mon.hp / spec.hp;
    if (mon.active) {
      if (level === 0 && t >= L.up1) { level = 1; levelT = 0; levelAt[1] = t; }
      else if (level === 1 && levelT >= L.up2) { level = 2; levelT = 0; levelAt[2] = t; }
      else if (level === 2 && ((levelT >= ARMY.up3.after && strength > ARMY.up3.strength) || hurtGuess >= ARMY.up3.hurt)) { level = 3; levelT = 0; levelAt[3] = t; squads.push(...levelSquads(3, spawn)); }
      else if (level === 3 && (levelT >= ARMY.up4.after || (strength > ARMY.up4.strength && squads.some((q) => q.broke > 0) && levelT > 20))) { level = 4; levelT = 0; levelAt[4] = t; squads.push(...levelSquads(4, spawn)); }
    }
    mon.step(dt, centroid, heliNear, blow);
    if (!mon.active) break;
    stepForces(squads, mon, path, dt, fire, (u, dealt) => { dealtBy[u.kind] = (dealtBy[u.kind] ?? 0) + dealt; });
    const now: Record<string, number> = {};
    for (const q of squads) for (const u of q.units) if (u.task !== 'dead' && u.task !== 'leave') now[u.kind] = (now[u.kind] ?? 0) + (u.kind === 'rifles' ? u.crew : 1);
    for (const k in now) peak[k] = Math.max(peak[k] ?? 0, now[k]);
    hash = Math.imul(hash ^ Math.round(mon.hp * 10), 16777619) >>> 0;
  }
  const outcome = mon.mode === 'dead' ? 'defeated' : mon.hp < spec.hp * spec.retreatAt ? 'retreated' : 'rampaged';
  return {
    winner: outcome === 'rampaged' ? 'monster' : 'army', outcome, t, hp: Math.round(mon.hp), levelAt,
    lost, broke: squads.reduce((a, q) => a + q.broke, 0), routed: squads.filter((q) => q.routed).length,
    dealtBy: Object.fromEntries(Object.entries(dealtBy).map(([k, v]) => [k, Math.round(v)])), monster: mon.stats, peak, hash,
  };
}
