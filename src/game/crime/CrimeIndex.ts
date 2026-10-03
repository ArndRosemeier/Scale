/**
 * District crime index (PLAYGROUND_PLAN §0 decision 6): a deterministic 0..1 "how much street
 * crime happens here" per macro cell, from (seed, plan) only.
 *
 *   base by district   port .70 · industrial .64 · old dense residential (apartments) .58 ·
 *                      park .46 · old town .44 · row houses .40 · commercial .38 ·
 *                      downtown .30 · suburbs .14
 *   density            dense residential blocks are rougher (+.14 at full density); dense
 *                      business districts are not
 *   distance           the inner ring around the main centre (35–70 % of the city radius) is
 *                      poorer (+.1); the outskirts calmer (−.08)
 *   poverty noise      a seeded smooth field over ~1.1 km (±.16): some neighbourhoods are simply
 *                      worse than their type
 *
 * The hour shapes it (`hourFactor`): business districts empty at night (less snatching, more
 * mugging), nightlife (old town, commercial, downtown evenings) and the docks get worse after
 * dark, suburbs stay calm. `crimesPerMinute` turns index × hour × setting into the director's rate.
 */
import type { MacroPlan, District } from '../../plan/types';
import { hash2f } from '../../core/rng';

export const DISTRICT_CRIME: Record<District, number> = {
  port: 0.7, industrial: 0.64, apartments: 0.58, park: 0.46, oldtown: 0.44, rowhouses: 0.4, commercial: 0.38, downtown: 0.3, suburban: 0.14, water: 0,
};

/** Crime index per macro cell (0..1), deterministic for (seed, plan). */
export function crimeIndex(macro: MacroPlan, seed: number): Float32Array {
  const out = new Float32Array(macro.cells.length);
  const c0 = macro.centres[0];
  let R = 0;
  for (const c of macro.cells) R = Math.max(R, Math.hypot(c.centroid[0] - c0.x, c.centroid[1] - c0.z));
  R = Math.max(500, R);
  macro.cells.forEach((c, i) => {
    const d = c.district;
    if (d === 'water') { out[i] = 0; return; }
    let v = DISTRICT_CRIME[d];
    const dens = Math.max(0, Math.min(1, c.density));
    if (d === 'apartments' || d === 'rowhouses' || d === 'oldtown') v += 0.14 * (dens - 0.4);
    if (d === 'industrial' || d === 'port') v += 0.06 * (1 - dens);
    const r = Math.hypot(c.centroid[0] - c0.x, c.centroid[1] - c0.z) / R;
    if (r > 0.35 && r < 0.7 && d !== 'suburban' && d !== 'downtown') v += 0.1 * Math.sin(((r - 0.35) / 0.35) * Math.PI);
    if (r > 0.85) v -= 0.08 * Math.min(1, (r - 0.85) / 0.15);
    v += 0.32 * (valueNoise2(seed ^ 0x6c1e, c.centroid[0] / 1100, c.centroid[1] / 1100) - 0.5);
    out[i] = Math.max(0.02, Math.min(1, v));
  });
  return out;
}

/** Hour-of-day factor (0..24) for a district: how much of its index applies now. */
export function hourFactor(d: District, hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  // 0 at noon, 1 at 1 am.
  const night = h >= 21 || h < 5 ? 1 : h >= 18 ? (h - 18) / 3 : h < 7 ? (7 - h) / 2 : 0;
  const deadNight = h >= 2 && h < 5; // streets empty
  let f: number;
  switch (d) {
    case 'downtown': case 'commercial': f = 0.85 + 0.55 * night; break;          // day crowds, evening nightlife
    case 'oldtown': f = 0.75 + 0.85 * night; break;                               // bars
    case 'industrial': case 'port': f = 0.7 + 0.9 * night; break;                 // dark and empty
    case 'park': f = 0.6 + 1.1 * night; break;
    case 'suburban': f = 0.8 + 0.3 * night; break;
    default: f = 0.8 + 0.6 * night;
  }
  return deadNight ? f * 0.55 : f;
}

/**
 * Street crimes per minute near the player for an index and hour (the director's rate):
 * an average district (index 0.5) by day gives about one every two minutes, a bad one about one a
 * minute, a safe one one in ten.
 */
export function crimesPerMinute(index: number, district: District, hour: number, setting: CrimeSetting): number {
  const mul = SETTING_RATE[setting];
  if (mul <= 0) return 0;
  return 0.5 * Math.pow(Math.max(0, index) / 0.5, 1.35) * hourFactor(district, hour) * mul;
}

export type CrimeSetting = 'off' | 'calm' | 'normal' | 'chaos';
export const SETTING_RATE: Record<CrimeSetting, number> = { off: 0, calm: 0.4, normal: 1, chaos: 3.5 };
/** Concurrent crimes per setting (budget: never more than 3). */
export const SETTING_MAX: Record<CrimeSetting, number> = { off: 0, calm: 1, normal: 2, chaos: 3 };

/** Smooth value noise in [0, 1) (bilinear between hashed lattice values, smoothstep weights). */
export function valueNoise2(seed: number, x: number, z: number): number {
  const i = Math.floor(x), j = Math.floor(z);
  const fx = x - i, fz = z - j;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash2f(seed, i, j), b = hash2f(seed, i + 1, j), c = hash2f(seed, i, j + 1), d = hash2f(seed, i + 1, j + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
