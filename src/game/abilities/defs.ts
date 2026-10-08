/**
 * Ability registry: what each power is, how it is triggered, and what its ranks do.
 * Mechanics live in AbilitySystem (wrapping Player / Interactions); numbers in tuning.ts.
 */
import {
  MAX_RANK, PUNCH_IMPULSE, JUMP_HEIGHT, DASH_DIST, SHOCK_IMPULSE, SHOCK_RANGE, SHOCK_COST,
  FLIGHT_SPEED, FLIGHT_CRUISE, flightBoost, SIZE_RANGE, JUMP, LEAP_SPEED, DASH, SPEED_TOP,
  LASER, LASER_RANGE, LASER_DOSE, FIRE, FIRE_RANGE, FIRE_HEAT, FIRE_BURN,
  FIREBALL, FIREBALL_RANGE, FIREBALL_RADIUS, FIREBALL_BLAST, FIREBALL_BURN, NOVA, NOVA_RADIUS, NOVA_FREEZE,
  ICE, ICE_WIDTH, ICE_LIFE, BOLT, BOLT_JUMPS, BOLT_JUMP_RANGE, BOLT_REACH, BOLT_STUN, QUAKE, QUAKE_LENGTH, QUAKE_IMPULSE,
  GUST, GUST_RADIUS, GUST_TIME, HYDRO, HYDRO_RANGE, HYDRO_FORCE, SHRINK, SHRINK_FACTOR, SHRINK_TIME, SHRINK_CAP, SHRINK_DEALT,
  SLIME_COST, SLIME_COUNT, SLIME_TIME, SLIME_REACH, SLIME_HOLD,
  PHASE, PHASE_DMG, PHASE_RANGE, FOCUS, FOCUS_DMG, FOCUS_RANGE, SEEKER, SEEKER_DMG, SEEKER_RANGE, SENSE_POWERS, KARMA_COST,
} from './tuning';
import { wallBreakShare, windowShatterShare, WALL_CLASSES, type WallClass } from '../../destruction/wallStrength';

export type AbilityId = 'punch' | 'strength' | 'superJump' | 'speed' | 'shockwave' | 'flight' | 'size'
  | 'laser' | 'fireWave' | 'fireball' | 'frostNova' | 'icePath' | 'lightning' | 'stomp' | 'gust' | 'hydro' | 'shrink' | 'slimeCall'
  | 'phase' | 'focus' | 'seeker';

/** Ids of earlier versions (saved progress, hotbars) -> their current power. */
export const LEGACY_IDS: Record<string, AbilityId> = { dash: 'speed' };

export type AbilityGroup = 'body' | 'movement' | 'elemental' | 'energy' | 'support';
/** Group headings, in the order the powers screen and the help list show them. */
export const GROUP_NAMES: Record<AbilityGroup, string> = { body: 'Body', movement: 'Movement', elemental: 'Elemental', energy: 'Energy (single target)', support: 'Support' };

export interface AbilityDef {
  id: AbilityId;
  name: string;
  /** One-line description. */
  desc: string;
  /** Not bought with karma: given by something in the world (how it is earned, for the powers screen). */
  granted?: string;
  /** Inline SVG (24×24, currentColor). */
  icon: string;
  /** passive: always on (no hotbar); active: hotbar-assignable. */
  kind: 'active' | 'passive';
  group: AbilityGroup;
  /** tap: fires on press; hold: works while held (super jump: climbs while held); toggle: on/off. */
  trigger: 'tap' | 'hold' | 'toggle' | 'none';
  maxRank: number;
  /** Native key besides the hotbar (shown in the UI). */
  key?: string;
  /** Effect summary of rank r (1..maxRank). */
  rankText(r: number): string;
  /** Energy cost summary (actives). */
  costText?(r: number): string;
}

const svg = (body: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const fmtJ = (j: number) => (j >= 1000 ? `${Math.round(j / 1000)}k` : `${j}`);
const fmtH = (h: number) => (h < 1 ? `${Math.round(h * 100)} cm` : `${h} m`);
const list = (a: string[]) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : a[0] ?? '');

/**
 * What a punch of rank r does to walls, from the real material strengths and street-level
 * panel sizes (wallStrength.ts): "breaks" ≥ 90 % of a class's panels, "most" ≥ 50 %, "some" ≥ 20 %.
 */
function punchEffect(r: number): string {
  const j = PUNCH_IMPULSE[r];
  const by = (lo: number, hi: number) => WALL_CLASSES.filter((c: WallClass) => { const s = wallBreakShare(j, c); return s >= lo && s < hi; });
  const all = by(0.9, 2), most = by(0.5, 0.9), some = by(0.2, 0.5);
  const parts: string[] = [];
  const name = (c: WallClass) => (c === 'glass' ? 'glass facades' : c);
  if (all.length) parts.push(`breaks ${list(all.map(name))}${all.length === 1 && all[0] === 'glass' ? '' : ' walls'}`);
  else {
    const w = windowShatterShare(j);
    parts.push(w >= 0.75 ? 'shatters windows' : w > 0.2 ? 'cracks some windows' : 'no damage to walls');
  }
  if (most.length) parts.push(`most ${list(most.map(name))}`);
  if (some.length) parts.push(`some ${list(some.map(name))}`);
  return parts.join(' · ');
}

/** Wall classes an impulse breaks at least half of (street-level panels). */
function breaksClasses(j: number): WallClass[] {
  return WALL_CLASSES.filter((c) => wallBreakShare(j, c) >= 0.5);
}

/** Impulse at which half of a class's street-level panels break (bisection over the real table). */
const needCache = new Map<WallClass, number>();
export function panelNeed(c: WallClass): number {
  let v = needCache.get(c);
  if (v !== undefined) return v;
  let lo = 0, hi = 1e7;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (wallBreakShare(m, c) >= 0.5) hi = m; else lo = m; }
  needCache.set(c, (v = hi));
  return v;
}

/** How long the laser needs on one spot to cut through a typical panel of each class. */
function laserCuts(r: number): string {
  const dose = LASER_DOSE[r];
  const parts: string[] = [];
  for (const c of ['glass', 'wood', 'brick', 'concrete'] as WallClass[]) {
    const t = panelNeed(c) / dose;
    parts.push(`${c} ${t < 0.95 ? '<1' : t < 60 ? Math.round(t) : '60+'} s`);
  }
  return `cuts a wall panel: ${parts.join(' · ')}`;
}

function fireWalls(r: number): string {
  const b = breaksClasses(FIRE_HEAT[r]);
  if (b.length) return `burns through ${list(b)} walls`;
  return windowShatterShare(FIRE_HEAT[r]) >= 0.75 ? 'bursts windows, scorches walls' : 'scorches walls';
}

function fireballWalls(r: number): string {
  const b = breaksClasses(FIREBALL_BLAST[r]);
  if (b.length) return `blows in ${list(b)} walls`;
  return windowShatterShare(FIREBALL_BLAST[r]) >= 0.75 ? 'blows out windows' : 'cracks windows';
}

function quakeWalls(r: number): string {
  const b = breaksClasses(QUAKE_IMPULSE[r]);
  return b.length ? `breaks ${list(b)} walls along it` : 'shatters windows along it';
}

export const ABILITIES: AbilityDef[] = [
  {
    // Everyone can punch: always rank 1 and free (Progress.rank); Super strength makes it hit harder.
    id: 'punch', name: 'Punch', kind: 'active', group: 'body', trigger: 'tap', maxRank: 1,
    desc: 'Throw a punch at your target in reach, or where you look. Super strength makes it hit harder.',
    icon: svg('<path d="M6 10.5V8a2 2 0 0 1 2-2h7.5a2.5 2.5 0 0 1 2.5 2.5V14a6 6 0 0 1-6 6h-1.5A4.5 4.5 0 0 1 6 15.5z"/><path d="M10 6v4M14 6v4M6 13h5.5a1.5 1.5 0 0 0 0-3H6"/>'),
    rankText: () => 'A plain punch — Super strength raises its force',
  },
  {
    id: 'strength', name: 'Super strength', kind: 'passive', group: 'body', trigger: 'none', maxRank: MAX_RANK,
    desc: 'Punches hit harder and running into walls smashes through them.',
    icon: svg('<path d="M7 11V7.5a1.5 1.5 0 0 1 3 0V10"/><path d="M10 9.5V6.5a1.5 1.5 0 0 1 3 0V10"/><path d="M13 9.5V7a1.5 1.5 0 0 1 3 0v3.5"/><path d="M16 10a1.5 1.5 0 0 1 3 0v3a7 7 0 0 1-7 7h-1a6 6 0 0 1-5-2.7L4.2 14.6a1.6 1.6 0 0 1 2.6-1.8L8 14V11"/><path d="M3 5l1.5 1.5M6.5 2.5L7 4.5M2 9h2"/>'),
    rankText: (r) => `Punch ${fmtJ(PUNCH_IMPULSE[r])} N·s · ${punchEffect(r)}`,
  },
  {
    id: 'superJump', name: 'Super jump', kind: 'active', group: 'movement', trigger: 'hold', maxRank: MAX_RANK, key: 'Hold Space',
    desc: 'Press Space to leap and keep holding it to climb higher; steer all the way. Hold W to bound forward: the leap picks up speed as it flies, and the higher it goes, the faster and farther it carries. Heavy landings shake the ground.',
    icon: svg('<path d="M6 11l6-6 6 6"/><path d="M6 17l6-6 6 6"/><path d="M4 21h16"/>'),
    rankText: (r) => `Climb up to ${JUMP_HEIGHT[r]} m high · leap forward at up to ${LEAP_SPEED[r]} m/s`,
    costText: () => `${JUMP.cost} energy for the full height`,
  },
  {
    id: 'speed', name: 'Super speed', kind: 'active', group: 'movement', trigger: 'toggle', maxRank: MAX_RANK,
    desc: 'Switch it on to run at super speed: you steer around cars, poles and walls by yourself and brake when the way ahead is blocked. Runs across water; people you pass are spun aside. In flight: a dash burst.',
    icon: svg('<path d="M11 6l6 6-6 6"/><path d="M17 6l6 6-6 6" opacity="0.55"/><path d="M2 9h6M1 12h7M2 15h6"/>'),
    rankText: (r) => `Run ${SPEED_TOP[r]} m/s · in flight: ${DASH_DIST[r]} m dash`,
    costText: () => `Running is free · dash ${DASH.cost} energy`,
  },
  {
    id: 'shockwave', name: 'Shockwave', kind: 'active', group: 'elemental', trigger: 'tap', maxRank: MAX_RANK,
    desc: 'Detonate a concussive blast where you look.',
    icon: svg('<circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4"/><path d="M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2"/>'),
    rankText: (r) => `Blast ${fmtJ(SHOCK_IMPULSE[r])} N·s · reach ${SHOCK_RANGE[r]} m`,
    costText: (r) => `${SHOCK_COST[Math.max(1, r)]} energy`,
  },
  {
    id: 'flight', name: 'Flight', kind: 'active', group: 'movement', trigger: 'toggle', maxRank: MAX_RANK, key: 'F',
    desc: 'Take to the sky. Shift to boost, Space / Ctrl to climb and sink. Flying costs no energy, but energy does not recover in the air: land to catch your breath.',
    icon: svg('<path d="M3 13c3-1 5-4 6-8 1 3 1 6-1 9"/><path d="M21 13c-3-1-5-4-6-8-1 3-1 6 1 9"/><path d="M12 8v9"/><path d="M9 19l3-2 3 2"/>'),
    rankText: (r) => `Cruise ${Math.round(FLIGHT_CRUISE * FLIGHT_SPEED[r])} m/s · boost ${Math.round(flightBoost(r))} m/s`,
  },
  {
    id: 'size', name: 'Size shift', kind: 'passive', group: 'body', trigger: 'none', maxRank: MAX_RANK, key: 'Numpad + / −',
    desc: 'Grow into a giant or shrink to the size of a mouse. A giant body costs energy, more the bigger it is: at 10 m it eats all your regeneration, at 100 m a full pool lasts about 20 seconds. Run dry and you shrink back to 10 m.',
    icon: svg('<path d="M14 4h6v6"/><path d="M20 4l-6.5 6.5"/><path d="M10 20H4v-6"/><path d="M4 20l6.5-6.5"/><rect x="9.5" y="9.5" width="5" height="5" rx="1" opacity="0.55"/>'),
    rankText: (r) => `Size ${fmtH(SIZE_RANGE[r][0])} … ${fmtH(SIZE_RANGE[r][1])}`,
  },
  // ---------------------------------------------------------------- elemental
  {
    id: 'laser', name: 'Laser eyes', kind: 'active', group: 'elemental', trigger: 'hold', maxRank: MAX_RANK,
    desc: 'Hold for a searing beam from your eyes: it cuts through walls, sets things smoking, wrecks cars and fries robots and drones.',
    icon: svg('<path d="M2 8.5c2.4-2.8 5.2-4.2 7.7-4.2s5.3 1.4 7.7 4.2c-2.4 2.8-5.2 4.2-7.7 4.2S4.4 11.3 2 8.5z"/><circle cx="9.7" cy="8.5" r="1.7" fill="currentColor"/><path d="M11.5 14.5l9.5 6.5M7.5 15l5 7" stroke-width="2.2"/>'),
    rankText: (r) => `Reach ${LASER_RANGE[r]} m · ${laserCuts(r)}`,
    costText: () => `${LASER.drain} energy / s`,
  },
  {
    id: 'fireWave', name: 'Fire wave', kind: 'active', group: 'elemental', trigger: 'tap', maxRank: MAX_RANK,
    desc: 'Breathe a cone of flame: people catch fire and run, cars smoke and burn out, light walls and windows give way.',
    icon: svg('<path d="M12 21c-3.9 0-6.4-2.6-6.4-6 0-3.4 2.9-5.4 3.4-9 2 1.5 3 3.2 3 5 1-1 1.5-2.2 1.5-3.5 2.4 2 3.9 4.5 3.9 7.5 0 3.4-2.4 6-5.4 6z"/><path d="M12 21c-1.5 0-2.6-1.1-2.6-2.6 0-1.5 1.3-2.3 1.6-3.9 1.6 1 3.6 2.4 3.6 3.9 0 1.5-1.1 2.6-2.6 2.6z"/>'),
    rankText: (r) => `Cone ${FIRE_RANGE[r]} m · burns ${FIRE_BURN[r]} s · ${fireWalls(r)}`,
    costText: () => `${FIRE.cost} energy`,
  },
  {
    id: 'fireball', name: 'Fireball', kind: 'active', group: 'elemental', trigger: 'tap', maxRank: MAX_RANK,
    desc: 'Hurl a ball of fire that bursts where it lands: people are thrown and set alight, cars burn and blow up, windows and walls are blown in.',
    icon: svg('<circle cx="15" cy="9" r="4.2"/><path d="M15 6.6c1 .9 1.6 1.7 1.6 2.6a1.6 1.6 0 0 1-3.2 0c0-.6.3-1 .7-1.5"/><path d="M11.4 12.6L4 20M9.6 10.4L3.5 14.5M13.6 14.4L9.5 20.5" opacity="0.7"/>'),
    rankText: (r) => `Bursts ${FIREBALL_RADIUS[r]} m wide · reach ${FIREBALL_RANGE[r]} m · burns ${FIREBALL_BURN[r]} s · ${r >= 3 ? 'wrecks cars · ' : ''}${fireballWalls(r)}`,
    costText: () => `${FIREBALL.cost} energy`,
  },
  {
    id: 'frostNova', name: 'Frost nova', kind: 'active', group: 'elemental', trigger: 'tap', maxRank: MAX_RANK,
    desc: 'Everything around you freezes solid: people, cars, robots; drones drop, windows shatter, the ground ices over.',
    icon: svg('<path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7"/><path d="M9.6 3.6L12 5.6l2.4-2M9.6 20.4L12 18.4l2.4 2M3.5 10.4l3.1-.7-.9-3M20.5 13.6l-3.1.7.9 3M3.5 13.6l3.1.7-.9 3M20.5 10.4l-3.1-.7.9-3"/>'),
    rankText: (r) => `Radius ${NOVA_RADIUS[r]} m · frozen ${NOVA_FREEZE[r]} s · icy ground ${NOVA_FREEZE[r] * NOVA.iceLinger} s`,
    costText: () => `${NOVA.cost} energy`,
  },
  {
    id: 'icePath', name: 'Ice path', kind: 'active', group: 'elemental', trigger: 'hold', maxRank: MAX_RANK,
    desc: 'Hold to freeze a sheet of ice ahead of you as you go: across rivers, the sea and gaps; look up to build a ramp. Slippery for everyone else.',
    icon: svg('<path d="M2 18.5L21 11"/><path d="M2 18.5h19" opacity="0.5"/><path d="M6 17l.8 1.5M11 15l1 3.5M16 13l1.2 5.5"/><path d="M2 22c2-1 3.5 1 5.5 0s3.5 1 5.5 0 3.5 1 5.5 0" opacity="0.6"/><path d="M17 3l1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/>'),
    rankText: (r) => `Sheet ${ICE_WIDTH[r]} m wide · melts after ${ICE_LIFE[r]} s`,
    costText: () => `${ICE.drain} energy / s`,
  },
  {
    id: 'lightning', name: 'Chain lightning', kind: 'active', group: 'elemental', trigger: 'tap', maxRank: MAX_RANK,
    desc: 'A bolt that leaps from what it strikes to whatever is near: people, cars, robots, drones, lamps and signs alike.',
    icon: svg('<path d="M13 2L6 13h5l-2 9 8-12h-5l3-8z"/><path d="M19 15l2 1.5M19.5 19l1.5.5M3 5l1.8 1M2.5 9h2" opacity="0.7"/>'),
    rankText: (r) => `Strikes up to ${1 + BOLT_JUMPS[r]} targets · jumps ${BOLT_JUMP_RANGE[r]} m · reach ${BOLT_REACH[r]} m · stuns ${BOLT_STUN[r]} s`,
    costText: () => `${BOLT.cost} energy`,
  },
  {
    id: 'stomp', name: 'Seismic stomp', kind: 'active', group: 'elemental', trigger: 'tap', maxRank: MAX_RANK,
    desc: 'Stamp a fissure into the ground along your aim: props topple, cars and people are thrown, walls near the crack break.',
    icon: svg('<path d="M2 20h20"/><path d="M12 20l-2-4 3-3-2-4 1.5-3"/><path d="M6 20l1.6-2.6M18 20l-1.3-2.9"/><path d="M7.5 5.5L5.5 3.5M16.5 5.5l2-2"/>'),
    rankText: (r) => `Fissure ${QUAKE_LENGTH[r]} m · ${fmtJ(QUAKE_IMPULSE[r])} N·s · ${quakeWalls(r)}`,
    costText: () => `${QUAKE.cost} energy`,
  },
  {
    id: 'gust', name: 'Whirlwind', kind: 'active', group: 'elemental', trigger: 'tap', maxRank: MAX_RANK,
    desc: 'Spin up a vortex where you aim: it lifts people, debris, props, robots and drones, scatters dust and smoke, and at high rank, cars.',
    icon: svg('<path d="M3 5c4 1.6 14 1.6 18 0M5 9c3 1.3 10 1.3 13 0M7.5 13c2.5 1 6.5 1 8.5-.2M9.5 17c1.5.8 3.5.8 4.5 0M11 21h1.5"/>'),
    rankText: (r) => `Vortex ${GUST_RADIUS[r]} m wide for ${GUST_TIME[r]} s · lifts people${r >= 5 ? ', cars (not buses or trucks)' : r >= 3 ? ', small cars' : ''}`,
    costText: () => `${GUST.cost} energy`,
  },
  {
    id: 'hydro', name: 'Hydrokinesis', kind: 'active', group: 'elemental', trigger: 'hold', maxRank: MAX_RANK,
    desc: 'Hold to conjure a pressure jet of water from your hands, anywhere. It knocks people over, shoves cars, puts out fires and leaves puddles.',
    icon: svg('<path d="M10 2.5c2.6 3.4 4.6 5.8 4.6 8.2a4.6 4.6 0 0 1-9.2 0c0-2.4 2-4.8 4.6-8.2z"/><path d="M2 20c2-1.4 4-1.4 6 0s4 1.4 6 0 4-1.4 6 0"/><path d="M16 7.5h5M17 11h4" opacity="0.6"/>'),
    rankText: (r) => `Jet ${HYDRO_RANGE[r]} m · ${fmtJ(HYDRO_FORCE[r])} N·s/s · ${r >= 3 ? 'shoves cars' : 'stops cars'}`,
    costText: () => `${HYDRO.drain} energy / s`,
  },
  // ---------------------------------------------------------------- energy (single target)
  {
    id: 'phase', name: 'Phase pulse', kind: 'active', group: 'energy', trigger: 'tap', maxRank: MAX_RANK,
    desc: 'A pulse of energy that passes through walls, cars and people and lands only on your target, even one that ducked out of sight a moment ago. Weaker than the laser and short-ranged; it breaks nothing on the way.',
    icon: svg('<path d="M10 3v18" stroke-dasharray="2 2.2" opacity="0.6"/><path d="M2.5 12h17"/><path d="M16.5 8.5L20 12l-3.5 3.5"/><path d="M6 8.5a5 5 0 0 0 0 7M13.5 8a5.5 5.5 0 0 1 0 8" opacity="0.55"/>'),
    rankText: (r) => `${PHASE_DMG[r]} damage · reach ${PHASE_RANGE[r]} m · through walls`,
    costText: () => `${PHASE.cost} energy`,
  },
  {
    id: 'focus', name: 'Focus beam', kind: 'active', group: 'energy', trigger: 'hold', maxRank: MAX_RANK,
    desc: 'Hold to gather a beam of energy behind your eyes, let go to fire one heavy shot at your target. The longer you gather, the harder it hits. Best against monsters: aim at a weak spot.',
    icon: svg('<path d="M3 4l4.5 4.5M3 12h5M3 20l4.5-4.5" opacity="0.6"/><circle cx="10" cy="12" r="2.6" fill="currentColor"/><path d="M12.6 12H22" stroke-width="3.2"/>'),
    rankText: (r) => `Full charge ${FOCUS_DMG[r]} damage · reach ${FOCUS_RANGE[r]} m · gathers in ${FOCUS.charge} s`,
    costText: () => `${FOCUS.base} energy + up to ${FOCUS.cost - FOCUS.base} while gathering`,
  },
  {
    id: 'seeker', name: 'Seeker orb', kind: 'active', group: 'energy', trigger: 'tap', maxRank: MAX_RANK,
    desc: 'Throw a ball of energy that hunts your target: it curves round corners and over buildings and only bursts on the one it was sent after. Needs a target.',
    icon: svg('<path d="M3 21h18"/><rect x="9" y="12" width="6" height="9" opacity="0.6"/><path d="M4 18C5 6 17 4 18.5 15" stroke-dasharray="1.6 1.8"/><circle cx="19" cy="17.5" r="2.2" fill="currentColor"/><circle cx="5" cy="15" r="1.6"/>'),
    rankText: (r) => `${SEEKER_DMG[r]} damage · target within ${SEEKER_RANGE[r]} m · flies ${SEEKER.life} s`,
    costText: () => `${SEEKER.cost} energy`,
  },
  // ---------------------------------------------------------------- support
  {
    id: 'shrink', name: 'Shrink ray', kind: 'active', group: 'support', trigger: 'tap', maxRank: MAX_RANK,
    desc: 'Zap anything — a person, a car, a robot, a monster — down in size for a while. Small things shrink to a fraction, big ones lose a few metres. Whatever is shrunk hits softer.',
    icon: svg('<path d="M3.5 3.5l5 5M20.5 3.5l-5 5M3.5 20.5l5-5M20.5 20.5l-5-5"/><path d="M8.5 5v3.5H5M15.5 5v3.5H19M8.5 19v-3.5H5M15.5 19v-3.5H19"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/>'),
    rankText: (r) => `Shrinks to ${Math.round(SHRINK_FACTOR[r] * 100)} %, at most ${SHRINK_CAP[r]} m off, for ${SHRINK_TIME[r]} s · deals ${Math.round(SHRINK_DEALT[r] * 100)} % damage · reach ${SHRINK.reach} m`,
    costText: () => `${SHRINK.cost} energy`,
  },
  {
    id: 'slimeCall', name: 'Slime call', kind: 'active', group: 'support', trigger: 'tap', maxRank: 3,
    desc: 'Call the Lumen up out of the sewers: they pour from the nearest manhole to your target — holding a criminal down, smothering a fire, tangling a machine, fighting the Murk.',
    granted: 'Earned through the trust of the Lumen, the glowing slimes deep under the city',
    icon: svg('<path d="M4 17c0-4.5 3.6-8 8-8s8 3.5 8 8c0 1.7-1.3 3-3 3H7c-1.7 0-3-1.3-3-3z"/><circle cx="9.5" cy="14.5" r="1" fill="currentColor"/><circle cx="14.5" cy="14.5" r="1" fill="currentColor"/><path d="M12 9V4M9 5.5L12 3l3 2.5" opacity="0.7"/>'),
    rankText: (r) => `${SLIME_COUNT[r]} Lumen for ${SLIME_TIME[r]} s · hold someone ${SLIME_HOLD[r]} s · a manhole within ${SLIME_REACH[r]} m`,
    costText: (r) => `${SLIME_COST[Math.max(1, r)]} energy`,
  },
];

/** Powers that can hit more than what they are aimed at: they offer the friend/foe sense. */
export const SENSE_IDS: readonly AbilityId[] = SENSE_POWERS;
export const hasSenseOption = (id: AbilityId): boolean => SENSE_IDS.includes(id);
/** Karma price of a power's friend/foe sense: the price of its first rank. */
export const senseCost = (id: AbilityId): number => (KARMA_COST as Record<string, readonly number[]>)[id]?.[0] ?? 0;

export const ABILITY: Record<AbilityId, AbilityDef> = Object.fromEntries(ABILITIES.map((a) => [a.id, a])) as Record<AbilityId, AbilityDef>;

export const HOTBAR_SLOTS = 10;
