/**
 * Every progression and power number in one place (ranks are 1-based; index 0 = locked).
 * Values for the player at 1.8 m; size scaling (k = height / 1.8) is applied by the code.
 */
export const MAX_RANK = 5;

/** Karma price of the next rank: COST[id][r] buys rank r + 1 (r = 0 is the unlock). */
export const KARMA_COST = {
  /** Everyone can punch: free and always unlocked (Progress.rank). */
  punch: [0],
  strength: [20, 30, 45, 70, 100],
  superJump: [40, 50, 75, 105, 150],
  speed: [20, 30, 45, 70, 100],
  shockwave: [50, 60, 85, 120, 160],
  flight: [80, 70, 100, 140, 190],
  size: [100, 80, 110, 150, 200],
  laser: [60, 60, 85, 120, 165],
  fireWave: [50, 55, 80, 110, 150],
  fireball: [60, 60, 85, 120, 165],
  frostNova: [50, 55, 80, 110, 150],
  icePath: [40, 45, 65, 90, 125],
  lightning: [60, 60, 85, 120, 165],
  stomp: [50, 55, 80, 110, 150],
  gust: [45, 50, 75, 105, 145],
  hydro: [40, 45, 65, 90, 125],
  shrink: [70, 60, 85, 120, 165],
  phase: [60, 60, 85, 120, 165],
  focus: [60, 60, 85, 120, 165],
  seeker: [55, 55, 80, 110, 150],
  /** Not bought: the Lumen's trust grants it (deep/Trust.callRank). */
  slimeCall: [],
} as const;

export const KARMA = {
  /** Balance of a new Normal game: enough for one cheap first purchase. */
  start: 25,
  /** Helping up someone who fell, was hit by a car, … */
  helpUp: 15,
  /** … someone a building collapse knocked down (collapses are usually the player's doing). */
  helpUpCollapse: 8,
  /** … someone the player knocked down personally. */
  helpUpOwn: 0,
  /** Reputation for helping someone up (not someone you knocked down yourself): a little. */
  helpUpRep: 1,
  /** Power core with the karma bonus. */
  coreKarma: 40,
};

/** Energy pool (Normal). Power cores raise max energy and regeneration. */
export const ENERGY = {
  max: 100,
  regen: 9,
  coreMax: 15,
  coreRegen: 1.5,
  /** Sandbox: effectively unlimited. */
  sandboxMax: 1000,
  sandboxRegen: 1000,
};

/** Upkeep of a giant body (energy / s by height). Below 1.8 m it is free; it climbs to the base
 *  regeneration at 10 m (a 10 m giant just holds even) and on to `top` at 100 m, where a full
 *  pool lasts about 20 s. Out of energy, the body shrinks back to `fallback`, pays only
 *  `exhaustedUpkeep` of its upkeep (so it refills at 10 m) and may grow again once the pool is
 *  back to `recover` of max. Flight costs nothing but stops regeneration. */
export const GIANT = { even: 10, top: 100, drainTop: 14, fallback: 10, recover: 0.25, exhaustedUpkeep: 0.5, shrinkRate: 1.2 };

/** Energy per second it takes to keep a body of height h (m). */
export function sizeUpkeep(h: number): number {
  if (h <= 1.8) return 0;
  if (h <= GIANT.even) return ENERGY.regen * (h - 1.8) / (GIANT.even - 1.8);
  return ENERGY.regen + (GIANT.drainTop - ENERGY.regen) * (h - GIANT.even) / (GIANT.top - GIANT.even);
}

/** Super strength (passive). Punch impulse in N·s at 1.8 m (× k²); index = rank. Rank 0 is an
 *  ordinary punch: shoves people, never breaks a wall or a window. */
export const PUNCH_IMPULSE = [200, 900, 25000, 60000, 200000, 400000];
/** Wall smashing by body momentum (running, dashing, flying into a wall): momentum multiplier. */
export const SMASH_MUL = [0.5, 1, 2, 5, 12, 30];

/** Super jump: highest climb in m at 1.8 m (× k) with Space held all the way. */
export const JUMP_HEIGHT = [0, 6, 10, 16, 25, 40];
/** Energy for the full height (paid as the height is gained); `debounce`: no new take-off for this
 *  long (s), so a bounce on landing cannot fire a second jump. */
export const JUMP = { cost: 22, debounce: 0.5 };
/** Super jump as travel: top forward speed in m/s at 1.8 m (× √k) of a full-height leap steered
 *  with W held; a lower leap carries its share (Player.leap), never less than 12 m/s. The speed
 *  builds up through the leap (LEAP_RAMP: seconds from standstill to the top speed), so a leap
 *  starts as a jump and turns into a bound. Leaping on from landing to landing covers ground a
 *  little slower than a boosted flight at the same rank (tools/travelsim.ts, checked in the selftest). */
export const LEAP_RAMP = 3;
export const LEAP_SPEED = [0, 18, 40, 80, 120, 200];

/** Powers are balanced by their energy cost, not by cooldowns. The only wait left is this
 *  technical debounce (s) after a tap power goes off, so one press (or key and mouse together)
 *  cannot fire it twice. */
export const TAP_DEBOUNCE = 0.25;

/** Super speed pressed in flight = dash burst: distance in m (× k) covered in DASH.time seconds. */
export const DASH_DIST = [0, 7, 10, 13, 17, 22];
export const DASH = { time: 0.2, cost: 22 };

/** Shockwave (blast where you look): impulse N·s, range m, energy. */
export const SHOCK_IMPULSE = [0, 3e4, 6e4, 1.2e5, 2.5e5, 5e5];
export const SHOCK_RANGE = [0, 80, 150, 300, 500, 800];
export const SHOCK_COST = [0, 55, 55, 60, 65, 70];

/** Flight: speed multiplier on cruise (22 m/s at 1.8 m). */
export const FLIGHT_SPEED = [0, 0.35, 0.5, 0.65, 0.8, 1];
export const FLIGHT_CRUISE = 22;
/** Boost (Shift) multiplies the cruise speed, more with every rank: a first-rank boost is a brisk 14 m/s, the top rank ~160 m/s. */
export const FLIGHT_BOOST_MUL = [0, 1.8, 2.6, 3.8, 5.2, 7.3];
/** Flight boost speed (m/s at 1.8 m) at rank r. */
export const flightBoost = (r: number): number => FLIGHT_CRUISE * FLIGHT_SPEED[r] * FLIGHT_BOOST_MUL[r];

/**
 * Super speed (a toggle), top running speed in m/s at 1.8 m (× √k, like every gait and like flight).
 * Kept where the streaming city and the collision substeps keep up; the runner steers itself
 * around what is ahead and brakes when nothing ahead is clear (player/speedNav.ts).
 * (Running costs no energy, like flight; on water above SPEED_WATER in Player.ts.)
 */
export const SPEED_TOP = [0, 40, 50, 62, 78, 100];

/** Size shift: allowed body height range in m. */
export const SIZE_RANGE: [number, number][] = [[1.8, 1.8], [0.5, 4], [0.3, 10], [0.2, 25], [0.12, 50], [0.1, 100]];

// ---------------------------------------------------------------- elemental powers
// Ranges and radii are at 1.8 m and scale with √k (a giant's powers reach farther); impulses
// scale with k² like the punch. Durations do not scale.

/** Laser eyes (held beam): energy per second, reach (m), heat dose (N·s per second of beam on
 *  one spot — accumulates on a facade panel until it gives way), impacts at most 10 / s. */
export const LASER = { drain: 14, tick: 0.1 };
export const LASER_RANGE = [0, 45, 65, 90, 130, 180];
export const LASER_DOSE = [0, 5000, 14000, 35000, 70000, 140000];

/** Fire wave (cone of flame): reach (m), heat on facades (N·s, breaks light materials only),
 *  how long people and cars burn (s), energy. */
export const FIRE = { cost: 40, halfAngle: 0.42, sweep: 0.55 };
export const FIRE_RANGE = [0, 8, 11, 14, 18, 24];
export const FIRE_HEAT = [0, 4000, 10000, 20000, 38000, 60000];
export const FIRE_BURN = [0, 3, 4, 5, 6, 8];

/** Fireball (a ball of fire hurled from the hands that bursts where it lands): flight speed (m/s),
 *  reach (m), burst radius (m), blast on facades (N·s: the old test blast's impact), how long people
 *  and cars burn (s), energy. Rank 3 wrecks cars in the burst; rank 5 blows in brick. */
export const FIREBALL = { cost: 40, speed: 48 };
export const FIREBALL_RANGE = [0, 45, 60, 75, 95, 120];
export const FIREBALL_RADIUS = [0, 3, 3.8, 4.6, 5.6, 7];
export const FIREBALL_BLAST = [0, 6000, 16000, 40000, 90000, 180000];
export const FIREBALL_BURN = [0, 3, 4, 5, 6, 8];

/** Frost nova (around the player): radius (m), freeze time (s), icy ground lasts × iceLinger. */
export const NOVA = { cost: 55, iceLinger: 3, glass: 2400 };
export const NOVA_RADIUS = [0, 6, 8, 11, 14, 18];
export const NOVA_FREEZE = [0, 3, 4, 5, 6, 8];

/** Ice path (held): sheet width (m), how long it lasts before melting (s), energy / s. */
export const ICE = { drain: 7, tileLen: 1.6, thick: 0.22, maxTiles: 360 };
export const ICE_WIDTH = [0, 1.6, 2.0, 2.4, 2.8, 3.4];
export const ICE_LIFE = [0, 8, 12, 17, 23, 30];

/** Chain lightning: jumps after the first strike, jump range (m), reach of the first strike (m),
 *  stall / stun time (s). */
export const BOLT = { cost: 38, flash: 0.25 };
export const BOLT_JUMPS = [0, 2, 3, 4, 6, 8];
export const BOLT_JUMP_RANGE = [0, 6, 8, 10, 13, 16];
export const BOLT_REACH = [0, 50, 65, 80, 100, 120];
export const BOLT_STUN = [0, 2, 3, 4, 5, 6];

/** Seismic stomp: fissure length (m), impulse along it (N·s; walls near the line break when it
 *  beats their strength), energy. */
export const QUAKE = { cost: 55, speed: 45, width: 2.2 };
export const QUAKE_LENGTH = [0, 12, 18, 25, 35, 50];
export const QUAKE_IMPULSE = [0, 15000, 40000, 90000, 180000, 320000];

/** Whirlwind: vortex radius (m), lifetime (s), lift (m/s given to people and debris); cars
 *  from rank 3 (small ones) and 5 (all but buses and trucks) get lifted. */
export const GUST = { cost: 50, drift: 2.5, reach: 35 };
export const GUST_RADIUS = [0, 4, 5, 6, 8, 10];
export const GUST_TIME = [0, 4, 5, 6, 7, 8];
export const GUST_LIFT = [0, 4, 5.5, 7, 9, 12];

/** Hydrokinesis (held jet of conjured water): reach (m), force (N·s per second on what it
 *  hits), energy / s. Cars are shoved from rank 3. */
export const HYDRO = { drain: 11 };
export const HYDRO_RANGE = [0, 12, 16, 20, 26, 32];
export const HYDRO_FORCE = [0, 900, 1500, 2600, 4200, 6500];

/** Shrink ray: size factor and how long it lasts (s); reach (m). */
export const SHRINK = { cost: 30, reach: 60 };
export const SHRINK_FACTOR = [0, 0.5, 0.4, 0.3, 0.2, 0.12];
export const SHRINK_TIME = [0, 10, 15, 22, 32, 45];
/** The most the ray takes off a target's biggest dimension (m): a person shrinks by the factor, a car
 *  or a monster only this much (big things stay big, but visibly smaller). */
export const SHRINK_CAP = [0, 1, 2, 3, 4, 5];
/** What a shrunk target still deals out (any damage, any blow): 10 % less per rank. */
export const SHRINK_DEALT = [1, 0.9, 0.8, 0.7, 0.6, 0.5];

/** Size factor the ray shrinks a target of `size` m (its biggest dimension) to at rank `r`. */
export function shrinkFactor(size: number, r: number): number {
  return Math.min(1, Math.max(SHRINK_FACTOR[r], (size - SHRINK_CAP[r]) / Math.max(1e-3, size)));
}

// ---------------------------------------------------------------- single-target powers
// They hit only what they are aimed at: no fire, no wall breaking beyond one panel (the focus
// beam), never a bystander next to the target. People take damage in hit points (Combat), a
// monster in "laser seconds": what the laser of the same rank does to it in one second.

/** Phase pulse: passes through walls, cars and people and lands only on the target (Tab, or what
 *  the crosshair is on), even one that ducked out of sight a few seconds ago (TARGET.lostAfter).
 *  Energy, damage to a person (hit points), to a monster (laser seconds), reach (m). Never across
 *  the street / sewer boundary. */
export const PHASE = { cost: 20, laserS: 0.5 };
export const PHASE_DMG = [0, 10, 14, 19, 25, 32];
export const PHASE_RANGE = [0, 25, 32, 40, 50, 60];

/** Focus beam: hold to gather the beam (up to `charge` s), let go to fire one heavy hit. `base`
 *  energy is paid on the press, the rest while it gathers (all of `cost` at a full charge); a
 *  shot that cannot go off gives the energy back. Damage scales from `min` (a quick tap) to the
 *  full charge: a person in hit points, a monster in laser seconds (exposed weak spots multiply it
 *  as for every power), a wall panel or a car takes the impulse. Reach (m). */
export const FOCUS = { base: 15, cost: 45, charge: 1.5, min: 0.25, laserS: 3, wallS: 1.5, flash: 0.28 };
export const FOCUS_DMG = [0, 45, 60, 80, 105, 140];
export const FOCUS_RANGE = [0, 60, 90, 130, 170, 220];

/** Seeker orb: a slow ball of energy that flies round corners and over buildings to its target
 *  (it needs one). Energy, damage to a person (hit points), to a monster (laser seconds), speed
 *  (m/s), life (s), how far off the target may be when it is thrown (m). */
export const SEEKER = { cost: 30, laserS: 0.6, speed: 25, life: 6, turn: 5, over: 10 };
export const SEEKER_DMG = [0, 12, 17, 23, 30, 40];
export const SEEKER_RANGE = [0, 50, 65, 80, 100, 120];

/** Friend/foe sense: bought per power, at that power's first-rank price. With it, the power
 *  spares everyone who is not fighting you (bystanders, your sidekick, police not after you) and
 *  their cars and machines; walls, props and the ground still take it. */
/** A giant body never has the sense (Arnd, 2026-10-08: being a giant keeps its downside): above
 *  this height (m) every power hits everything again. */
export const SENSE = { maxHeight: 2.5 };
export const SENSE_POWERS = ['laser', 'shockwave', 'fireWave', 'fireball', 'frostNova', 'lightning', 'stomp', 'gust', 'hydro'] as const;

/** Tab targeting: how far targets are picked (m at 1.8 m, × √k). */
export const TARGET = { range: 160, propRange: 45, lostAfter: 5 };

/** Power cores in a city: count from the number of cells. */
export const CORES = { perCells: 5, min: 6, max: 24, discoverRadius: 150 };

/** Small accidents (someone trips and falls) near the player, as interim good deeds. */
export const ACCIDENTS = { minGap: 180, maxGap: 360, near: 12, far: 35, lieFor: 120 };

// ---------------------------------------------------------------- slime call (granted by the Lumen's trust)
/** Energy by rank (a bigger call is cheaper to make: the Lumen trust you more). */
export const SLIME_COST = [0, 70, 60, 50];
/** How many Lumen come, how long they stay (s), how far the nearest manhole may be (m), how long they hold someone (s). */
export const SLIME_COUNT = [0, 6, 10, 16];
export const SLIME_TIME = [0, 20, 28, 40];
export const SLIME_REACH = [0, 25, 35, 45];
export const SLIME_HOLD = [0, 8, 12, 18];

/**
 * How hard the powers hit people and giant creatures (Interactions, Game.dashSweep, Elements,
 * SlimeRealm); the help's power table computes its damage column from these too.
 *  - People: a power knocks a person down at a fling speed (m/s, the `…Knock` values), which
 *    costs COMBAT.knockBase + knockPerSpeed × speed health (Combat.knocked). Punches and the
 *    shockwave land as impulses instead (Combat.hitActor: COMBAT.dmgPerNs per N·s).
 *  - Creatures: points before armour (ThreatActor.damage); impulses count DAMAGE_PER_IMPULSE per N·s.
 */
export const POWER_HIT = {
  /** Punch: upward share of the impulse; shockwave: share of SHOCK_IMPULSE each body takes. */
  punchLift: 0.25, blastShare: 0.5,
  /** Super speed / dash: fling speed (1.5 + 0.6 × rank) × √size, at most 12 m/s. */
  dashKnock: 1.5, dashKnockPerRank: 0.6, dashKnockMax: 12,
  laserKnock: 2.5,
  /** Fire wave: knocks down people within this share of its range; creatures: × heat impulse. */
  fireKnock: 3, fireKnockReach: 0.45, fireCreatureMul: 1.5,
  /** Fireball: fling 3 m/s at the rim up to 3 + 6 at the centre. */
  fireballKnock: 3, fireballKnockCentre: 6, fireballCreatureMul: 1.5,
  /** Ice path: someone who slips falls at 1.2 + 0.4 × their speed. */
  iceSlipKnock: 1.2, iceSlipPerSpeed: 0.4,
  /** Chain lightning: fling per person; creatures: points per second of stun (× reach scale). */
  boltKnock: 1.4, boltCreature: 40,
  /** Frost nova on a creature: points per second of freeze, at a leg. */
  frostCreature: 18,
  /** Seismic stomp: fling 3 + impulse / 30 000 (at most 9); machines and props are shoved with at
   *  most `quakeShoveMax` per axis; giant creatures take this share of the full impulse at the legs. */
  quakeKnock: 3, quakeKnockPerNs: 1 / 30000, quakeKnockMax: 9, quakeShoveMax: 3000, quakeCreatureMul: 1,
  /** Whirlwind: fling = 0.7 × lift; creatures: 6 × lift per hit; the same person is caught again
   *  after `gustEveryPerson` s, anything else (but cars) after `gustEvery` s. */
  gustKnock: 0.7, gustCreature: 6, gustEveryPerson: 2.2, gustEvery: 1.2,
  /** Hydrokinesis: a person falls once the jet has built up this impulse (N·s), at 2 + impulse / 250
   *  (at most 9), pushing every `hydroTick` s; creatures take this share of the jet's impulse. */
  hydroKnockAt: 260, hydroTick: 0.1, hydroKnock: 2, hydroKnockPerNs: 1 / 250, hydroKnockMax: 9, hydroCreatureMul: 0.3,
  /** Slime call: points per second for every Lumen on a creature. */
  lumenCreature: 6,
};
