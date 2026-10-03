/**
 * Every progression and power number in one place (ranks are 1-based; index 0 = locked).
 * Values for the player at 1.8 m; size scaling (k = height / 1.8) is applied by the code.
 */
export const MAX_RANK = 5;

/** Karma price of the next rank: COST[id][r] buys rank r + 1 (r = 0 is the unlock). */
export const KARMA_COST = {
  strength: [20, 30, 45, 70, 100],
  superJump: [20, 30, 45, 70, 100],
  dash: [30, 40, 60, 85, 120],
  shockwave: [50, 60, 85, 120, 160],
  flight: [80, 70, 100, 140, 190],
  size: [100, 80, 110, 150, 200],
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
export const PUNCH_IMPULSE = [200, 900, 12000, 60000, 200000, 400000];
/** Wall smashing by body momentum (running, dashing, flying into a wall): momentum multiplier. */
export const SMASH_MUL = [0.5, 1, 2, 5, 12, 30];

/** Super jump: apex height in m at 1.8 m (× k) at full charge. */
export const JUMP_HEIGHT = [0, 6, 10, 16, 25, 40];
export const JUMP = { chargeTime: 0.9, tapTime: 0.18, cost: 22, cooldown: 0.5 };

/** Dash: distance in m (× k) covered in DASH.time seconds. */
export const DASH_DIST = [0, 7, 10, 13, 17, 22];
export const DASH_COOLDOWN = [0, 3, 2.5, 2, 1.5, 1];
export const DASH = { time: 0.2, cost: 18 };

/** Shockwave (blast where you look): impulse N·s, range m, energy, cooldown s. */
export const SHOCK_IMPULSE = [0, 3e4, 6e4, 1.2e5, 2.5e5, 5e5];
export const SHOCK_RANGE = [0, 80, 150, 300, 500, 800];
export const SHOCK_COST = [0, 40, 40, 45, 50, 55];
export const SHOCK_COOLDOWN = [0, 10, 9, 8, 7, 6];

/** Flight: speed multiplier on cruise (22 m/s) and boost (160 m/s) at 1.8 m. */
export const FLIGHT_SPEED = [0, 0.35, 0.5, 0.65, 0.8, 1];

/** Size shift: allowed body height range in m. */
export const SIZE_RANGE: [number, number][] = [[1.8, 1.8], [0.5, 4], [0.3, 10], [0.2, 25], [0.12, 50], [0.1, 100]];

/** Power cores in a city: count from the number of cells. */
export const CORES = { perCells: 5, min: 6, max: 24, discoverRadius: 150 };

/** Small accidents (someone trips and falls) near the player, as interim good deeds. */
export const ACCIDENTS = { minGap: 50, maxGap: 110, near: 15, far: 60, lieFor: 120 };
