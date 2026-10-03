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
  superJump: [20, 30, 45, 70, 100],
  speed: [40, 50, 75, 105, 150],
  shockwave: [50, 60, 85, 120, 160],
  flight: [80, 70, 100, 140, 190],
  size: [100, 80, 110, 150, 200],
  laser: [60, 60, 85, 120, 165],
  fireWave: [50, 55, 80, 110, 150],
  frostNova: [50, 55, 80, 110, 150],
  icePath: [40, 45, 65, 90, 125],
  lightning: [60, 60, 85, 120, 165],
  stomp: [50, 55, 80, 110, 150],
  gust: [45, 50, 75, 105, 145],
  hydro: [40, 45, 65, 90, 125],
  shrink: [70, 60, 85, 120, 165],
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

/** Super strength (passive). Punch impulse in N·s at 1.8 m (× k²); index = rank. Rank 0 is an
 *  ordinary punch: shoves people, never breaks a wall or a window. */
export const PUNCH_IMPULSE = [200, 900, 25000, 60000, 200000, 400000];
/** Wall smashing by body momentum (running, dashing, flying into a wall): momentum multiplier. */
export const SMASH_MUL = [0.5, 1, 2, 5, 12, 30];

/** Super jump: apex height in m at 1.8 m (× k) at full charge. */
export const JUMP_HEIGHT = [0, 6, 10, 16, 25, 40];
export const JUMP = { chargeTime: 0.9, tapTime: 0.18, cost: 22, cooldown: 0.5 };

/** Super speed, tap = dash burst: distance in m (× k) covered in DASH.time seconds. */
export const DASH_DIST = [0, 7, 10, 13, 17, 22];
export const DASH_COOLDOWN = [0, 3, 2.5, 2, 1.5, 1];
export const DASH = { time: 0.2, cost: 18 };

/** Shockwave (blast where you look): impulse N·s, range m, energy, cooldown s. */
export const SHOCK_IMPULSE = [0, 3e4, 6e4, 1.2e5, 2.5e5, 5e5];
export const SHOCK_RANGE = [0, 80, 150, 300, 500, 800];
export const SHOCK_COST = [0, 40, 40, 45, 50, 55];
export const SHOCK_COOLDOWN = [0, 10, 9, 8, 7, 6];

/** Flight: speed multiplier on cruise (22 m/s at 1.8 m). */
export const FLIGHT_SPEED = [0, 0.35, 0.5, 0.65, 0.8, 1];
export const FLIGHT_CRUISE = 22;
/** Boost (Shift) multiplies the cruise speed, more with every rank: a first-rank boost is a brisk 14 m/s, the top rank ~160 m/s. */
export const FLIGHT_BOOST_MUL = [0, 1.8, 2.6, 3.8, 5.2, 7.3];
/** Flight boost speed (m/s at 1.8 m) at rank r. */
export const flightBoost = (r: number): number => FLIGHT_CRUISE * FLIGHT_SPEED[r] * FLIGHT_BOOST_MUL[r];

/**
 * Super speed, hold = run: top speed in m/s at 1.8 m (× √k, like every gait and like flight).
 * Always clearly above flight's boost at the same rank (flightBoost(r)).
 */
export const SPEED_TOP = [0, 75, 110, 145, 185, 240];
/** Super speed: hold longer than this (s) and it runs; a shorter tap dashes. */
/** (Running costs no energy, like flight; on water above SPEED_WATER in Player.ts.) */
export const SPEED = { tapTime: 0.22, cost: 0 };

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
 *  how long people and cars burn (s), energy, cooldown (s). */
export const FIRE = { cost: 30, halfAngle: 0.42, sweep: 0.55 };
export const FIRE_RANGE = [0, 8, 11, 14, 18, 24];
export const FIRE_HEAT = [0, 4000, 10000, 20000, 38000, 60000];
export const FIRE_BURN = [0, 3, 4, 5, 6, 8];
export const FIRE_COOLDOWN = [0, 8, 7, 6, 5, 4];

/** Frost nova (around the player): radius (m), freeze time (s), icy ground lasts × iceLinger. */
export const NOVA = { cost: 35, iceLinger: 3, glass: 2400 };
export const NOVA_RADIUS = [0, 6, 8, 11, 14, 18];
export const NOVA_FREEZE = [0, 3, 4, 5, 6, 8];
export const NOVA_COOLDOWN = [0, 14, 12, 10, 9, 8];

/** Ice path (held): sheet width (m), how long it lasts before melting (s), energy / s. */
export const ICE = { drain: 7, tileLen: 1.6, thick: 0.22, maxTiles: 360 };
export const ICE_WIDTH = [0, 1.6, 2.0, 2.4, 2.8, 3.4];
export const ICE_LIFE = [0, 8, 12, 17, 23, 30];

/** Chain lightning: jumps after the first strike, jump range (m), reach of the first strike (m),
 *  stall / stun time (s). */
export const BOLT = { cost: 30, flash: 0.25 };
export const BOLT_JUMPS = [0, 2, 3, 4, 6, 8];
export const BOLT_JUMP_RANGE = [0, 6, 8, 10, 13, 16];
export const BOLT_REACH = [0, 50, 65, 80, 100, 120];
export const BOLT_STUN = [0, 2, 3, 4, 5, 6];
export const BOLT_COOLDOWN = [0, 6, 5, 4.5, 4, 3];

/** Seismic stomp: fissure length (m), impulse along it (N·s; walls near the line break when it
 *  beats their strength), energy, cooldown. */
export const QUAKE = { cost: 40, speed: 45, width: 2.2 };
export const QUAKE_LENGTH = [0, 12, 18, 25, 35, 50];
export const QUAKE_IMPULSE = [0, 15000, 40000, 90000, 180000, 320000];
export const QUAKE_COOLDOWN = [0, 12, 10, 9, 8, 7];

/** Whirlwind: vortex radius (m), lifetime (s), lift (m/s given to people and debris); cars
 *  from rank 3 (small ones) and 5 (all but buses and trucks) get lifted. */
export const GUST = { cost: 35, drift: 2.5, reach: 35 };
export const GUST_RADIUS = [0, 4, 5, 6, 8, 10];
export const GUST_TIME = [0, 4, 5, 6, 7, 8];
export const GUST_LIFT = [0, 4, 5.5, 7, 9, 12];
export const GUST_COOLDOWN = [0, 12, 11, 10, 9, 8];

/** Hydrokinesis (held jet of conjured water): reach (m), force (N·s per second on what it
 *  hits), energy / s. Cars are shoved from rank 3. */
export const HYDRO = { drain: 11 };
export const HYDRO_RANGE = [0, 12, 16, 20, 26, 32];
export const HYDRO_FORCE = [0, 900, 1500, 2600, 4200, 6500];

/** Shrink ray: size factor and how long it lasts (s); reach (m). */
export const SHRINK = { cost: 25, reach: 60 };
export const SHRINK_FACTOR = [0, 0.5, 0.4, 0.3, 0.2, 0.12];
export const SHRINK_TIME = [0, 10, 15, 22, 32, 45];
export const SHRINK_COOLDOWN = [0, 6, 5, 4, 3, 2];

/** Tab targeting: how far targets are picked (m at 1.8 m, × √k). */
export const TARGET = { range: 160, propRange: 45, lostAfter: 5 };

/** Power cores in a city: count from the number of cells. */
export const CORES = { perCells: 5, min: 6, max: 24, discoverRadius: 150 };

/** Small accidents (someone trips and falls) near the player, as interim good deeds. */
export const ACCIDENTS = { minGap: 50, maxGap: 110, near: 15, far: 60, lieFor: 120 };
