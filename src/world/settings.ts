/**
 * User-facing generation settings and the seed-derived world profile.
 */
import { Rng, deriveSeed } from '../core/rng';

export interface CitySettings {
  /** 32-bit seed. */
  seed: number;
  /** 0 = small town … 1 = New-York-sized metropolis (log scale). */
  size: number;
}

export const DEFAULT_SETTINGS: CitySettings = { seed: 1, size: 0.35 };

/** City radius in meters for a size setting (≈0.9 km town … ≈14 km metropolis). */
export function cityRadius(size: number): number {
  return 900 * Math.pow(15.5, Math.min(1, Math.max(0, size)));
}

export type CityClass = 'town' | 'city' | 'metropolis' | 'megacity';
export function cityClass(size: number): CityClass {
  const r = cityRadius(size);
  return r < 1800 ? 'town' : r < 4500 ? 'city' : r < 9000 ? 'metropolis' : 'megacity';
}

/**
 * Seed-derived character of the place. Everything here is decided once and
 * read by every generator so the city feels consistent.
 */
export interface WorldProfile {
  seed: number;
  size: number;
  radius: number;
  cls: CityClass;
  /** 0 flat … 1 very hilly. */
  hilliness: number;
  /** Characteristic hill wavelength (m). */
  hillScale: number;
  coastal: boolean;
  /** Unit vector pointing from land towards the sea. */
  seaDir: [number, number];
  /** Distance of the coastline from the centre along seaDir (m). */
  coastOffset: number;
  /** River count (≥1). */
  rivers: number;
  /** Base river width at the city centre (m). */
  riverWidth: number;
  /** Ground height of the city centre above sea level. */
  baseElevation: number;
  /** Architectural flavour weights (0..1), normalised by consumers. */
  arch: {
    oldWorld: number;   // european stone / timber, mansards
    american: number;   // brick tenements, brownstones, fire escapes
    modern: number;     // glass, concrete
    warm: number;       // stucco, terracotta roofs (mediterranean)
  };
  /** Climate influences vegetation and roofs: 0 cold … 1 warm. */
  warmth: number;
  /** Fraction of streets laid out as grids (vs organic). */
  gridness: number;
  /** Has a metro (larger cities). */
  metro: boolean;
  /** Downtown skyscraper intensity 0..1. */
  skyline: number;
  /** Right-hand traffic. */
  rightHand: boolean;
}

export function makeProfile(s: CitySettings): WorldProfile {
  const rng = new Rng(deriveSeed(s.seed, 'profile'));
  const radius = cityRadius(s.size);
  const cls = cityClass(s.size);
  const coastal = rng.chance(0.45);
  const a = rng.range(0, Math.PI * 2);
  const hilliness = Math.pow(rng.float(), 1.6);
  const archBase = {
    oldWorld: rng.float(),
    american: rng.float(),
    modern: rng.range(0.2, 1) * (0.4 + s.size * 0.6),
    warm: rng.float() * rng.float(),
  };
  return {
    seed: s.seed,
    size: s.size,
    radius,
    cls,
    hilliness,
    hillScale: rng.range(900, 2200),
    coastal,
    seaDir: [Math.cos(a), Math.sin(a)],
    coastOffset: radius * rng.range(0.55, 0.85),
    rivers: cls === 'megacity' && rng.chance(0.5) ? 2 : 1,
    riverWidth: Math.min(380, rng.range(28, 55) * Math.pow(radius / 900, 0.45)),
    baseElevation: coastal ? rng.range(4, 14) : rng.range(25, 160),
    arch: archBase,
    warmth: rng.float(),
    gridness: rng.chance(0.35) ? rng.range(0.7, 1) : rng.range(0.15, 0.7),
    metro: cls === 'metropolis' || cls === 'megacity' || (cls === 'city' && rng.chance(0.5)),
    skyline: Math.min(1, s.size * 1.2 + rng.range(-0.15, 0.25)),
    rightHand: rng.chance(0.8),
  };
}
