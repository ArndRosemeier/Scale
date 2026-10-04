/**
 * Cafés, restaurants, bistros, bakeries, pizzerias, ice-cream parlours and wine bars: which
 * ground-floor shops are places to eat and drink, what they are called, when they are open and
 * how busy their tables are over the day. Pure functions of (seed, cell, building, hour).
 * The terraces in front of them are planned in plan/terrace.ts.
 */
import { Rng, deriveSeed, hashToFloat, hash32 } from '../core/rng';
import type { District } from './types';
import type { BuildingDesc } from './building';
import { ROOTS } from './names';

export const enum Eatery { None = 0, Cafe = 1, Restaurant = 2, Bistro = 3, Bakery = 4, Pizzeria = 5, IceCream = 6, Bar = 7 }
export const EATERY_KINDS = 8;

export interface EateryInfo {
  label: string;
  /** Chance of a terrace where there is room for one. */
  terraceP: number;
  /** Length of a visit in game hours [min, max]. */
  visit: [number, number];
  /** Opening hours (close may pass midnight: 25 = 1:00). */
  open: number;
  close: number;
  /** Closing hour in nightlife districts (downtown, commercial, old town). */
  closeLate: number;
  /** Busy hours: [centre, width, share of tables taken]. */
  peaks: [number, number, number][];
  /** Share of tables taken outside the peaks while open. */
  base: number;
  /** What guests hold (held-item id) or null. */
  held: string | null;
}

export const EATERY: Record<number, EateryInfo> = {
  [Eatery.Cafe]: { label: 'Café', terraceP: 0.82, visit: [0.35, 0.9], open: 7, close: 19.5, closeLate: 21, peaks: [[8.6, 1.2, 0.55], [13, 1.3, 0.62], [16, 1.6, 0.6]], base: 0.22, held: 'coffee' },
  [Eatery.Restaurant]: { label: 'Restaurant', terraceP: 0.55, visit: [0.9, 1.8], open: 11.5, close: 23, closeLate: 24.5, peaks: [[12.9, 1.1, 0.6], [20, 1.7, 0.85]], base: 0.12, held: null },
  [Eatery.Bistro]: { label: 'Bistro', terraceP: 0.75, visit: [0.6, 1.4], open: 9, close: 23, closeLate: 24.5, peaks: [[12.8, 1.2, 0.68], [19.6, 1.8, 0.75]], base: 0.2, held: 'coffee' },
  [Eatery.Bakery]: { label: 'Bakery', terraceP: 0.5, visit: [0.25, 0.6], open: 6.5, close: 18.5, closeLate: 18.5, peaks: [[8, 1.5, 0.6], [15.5, 1.3, 0.42]], base: 0.18, held: 'coffee' },
  [Eatery.Pizzeria]: { label: 'Pizzeria', terraceP: 0.6, visit: [0.7, 1.4], open: 11.5, close: 23, closeLate: 24.5, peaks: [[12.8, 1.1, 0.55], [19.8, 1.8, 0.8]], base: 0.12, held: null },
  [Eatery.IceCream]: { label: 'Gelato', terraceP: 0.75, visit: [0.15, 0.45], open: 11, close: 21.5, closeLate: 22.5, peaks: [[16.5, 2.6, 0.75]], base: 0.2, held: null },
  [Eatery.Bar]: { label: 'Bar', terraceP: 0.55, visit: [0.8, 2.2], open: 17, close: 24, closeLate: 26, peaks: [[21.5, 2.2, 0.85]], base: 0.15, held: null },
};

/** Kind weights per district (cafés everywhere, bars where the nightlife is). */
const KIND_W: Partial<Record<District, number[]>> = {
  //            -   cafe rest bistro bakery pizza ice  bar
  downtown: [0, 3.0, 2.0, 1.5, 0.6, 0.8, 0.5, 1.3],
  commercial: [0, 3.0, 2.0, 1.2, 1.0, 1.2, 0.8, 1.0],
  oldtown: [0, 3.0, 2.2, 1.6, 1.2, 1.0, 1.2, 1.3],
  apartments: [0, 2.6, 1.0, 0.7, 1.6, 1.4, 0.6, 0.5],
  rowhouses: [0, 2.6, 0.9, 0.6, 1.8, 1.2, 0.6, 0.4],
  suburban: [0, 1.6, 0.8, 0.3, 1.5, 1.5, 0.8, 0.2],
  industrial: [0, 1.6, 0.6, 0.2, 0.6, 0.6, 0.0, 0.6],
  port: [0, 1.4, 0.9, 0.3, 0.4, 0.5, 0.2, 0.9],
};
/** Share of shop fronts that are places to eat and drink, per district. */
const SHARE: Partial<Record<District, number>> = { downtown: 0.22, commercial: 0.3, oldtown: 0.36, apartments: 0.24, rowhouses: 0.24, suburban: 0.3, industrial: 0.1, port: 0.14 };
/** Nightlife districts keep bars and restaurants open later. */
export const NIGHTLIFE: Partial<Record<District, boolean>> = { downtown: true, commercial: true, oldtown: true };

/**
 * Is this building a place to eat or drink, and which kind? `open`: it faces a plaza or a park
 * (cafés like those spots). Deterministic per (seed, cell, building).
 */
export function eateryKind(seed: number, cell: number, index: number, district: District, b: BuildingDesc, open: boolean): Eatery {
  if (!b.shopfront || b.use === 'industrial' || b.use === 'parking' || b.style === 'church') return Eatery.None;
  const r = new Rng(deriveSeed(seed, 'eatery', cell, index));
  const share = Math.min(0.85, (SHARE[district] ?? 0) + (open ? 0.32 : 0));
  if (!r.chance(share)) return Eatery.None;
  const w = KIND_W[district] ?? KIND_W.apartments!;
  return r.weighted([1, 2, 3, 4, 5, 6, 7], (k) => w[k] + (open && (k === Eatery.Cafe || k === Eatery.IceCream) ? 1 : 0)) as Eatery;
}

const NAME_FMT: Record<number, ((root: string) => string)[]> = {
  [Eatery.Cafe]: [(o) => `Café ${o}`, (o) => `${o} Coffee`, (o) => `The ${o} Café`, (o) => `${o} Roasters`, (o) => `Café ${o}`],
  [Eatery.Restaurant]: [(o) => `Trattoria ${o}`, (o) => `${o} Kitchen`, (o) => `Brasserie ${o}`, (o) => `Osteria ${o}`, (o) => `The ${o} House`],
  [Eatery.Bistro]: [(o) => `Bistro ${o}`, (o) => `${o} Bistro`, (o) => `Le Petit ${o}`, (o) => `${o} & Co`],
  [Eatery.Bakery]: [(o) => `${o} Bakery`, (o) => `${o}'s Bakehouse`, (o) => `${o} Bread & Coffee`, (o) => `Boulangerie ${o}`],
  [Eatery.Pizzeria]: [(o) => `Pizzeria ${o}`, (o) => `${o} Pizza`, (o) => `Da ${o}`],
  [Eatery.IceCream]: [(o) => `Gelato ${o}`, (o) => `${o} Gelateria`, (o) => `${o} Ice Cream`],
  [Eatery.Bar]: [(o) => `${o} Wine Bar`, (o) => `Bar ${o}`, (o) => `The ${o} Tap`],
};

/** The name over the door, in the city's naming style (see plan/names). */
export function eateryName(seed: number, cell: number, index: number, kind: Eatery): string {
  const r = new Rng(deriveSeed(seed, 'eatery-name', cell, index));
  const root = r.pick(ROOTS);
  return r.pick(NAME_FMT[kind] ?? NAME_FMT[Eatery.Cafe])(root);
}

/** Open at this hour (0..24)? */
export function eateryOpen(kind: Eatery, hour: number, district: District): boolean {
  const k = EATERY[kind];
  if (!k) return false;
  const close = NIGHTLIFE[district] ? k.closeLate : k.close;
  const h = hour < k.open && hour + 24 < close ? hour + 24 : hour;
  return h >= k.open && h < close;
}

/**
 * Share of the tables taken at this hour (0 when closed): the base plus the busy hours, fewer
 * in the suburbs, a little more in the old town; the last half hour before closing empties.
 */
export function eateryDemand(kind: Eatery, hour: number, district: District): number {
  const k = EATERY[kind];
  if (!k || !eateryOpen(kind, hour, district)) return 0;
  let f = k.base;
  for (const [c, w, s] of k.peaks) {
    // Peaks wrap around midnight for bars.
    const d = Math.min(Math.abs(hour - c), Math.abs(hour + 24 - c), Math.abs(hour - 24 - c));
    f = Math.max(f, k.base + (s - k.base) * Math.exp(-((d / w) ** 2)));
  }
  const close = NIGHTLIFE[district] ? k.closeLate : k.close;
  const h = hour < k.open && hour + 24 < close ? hour + 24 : hour;
  f *= Math.min(1, (close - h) / 0.5, (h - k.open) / 0.4 + 0.3);
  const m = district === 'suburban' ? 0.7 : district === 'oldtown' ? 1.12 : district === 'industrial' || district === 'port' ? 0.6 : 1;
  return Math.max(0, Math.min(0.95, f * m));
}

/**
 * Who sits at a table when: visits are laid out on a deterministic timeline per table. Window
 * n of a table starts at a seeded offset, lasts `visit × 1.3`, and holds a visit of the kind's
 * length (starting a little into the window) when its roll is below the demand at its start.
 * Returns the visit covering `hoursAbs` (absolute game hours) or null.
 */
export function tableVisit(seed: number, key: number, kind: Eatery, district: District, hoursAbs: number): { n: number; from: number; to: number; guests: number } | null {
  const k = EATERY[kind];
  if (!k) return null;
  const h0 = hashToFloat(hash32(key ^ 0x51ed));
  const len = k.visit[0] + (k.visit[1] - k.visit[0]) * h0;
  const win = len * 1.3;
  const off = hashToFloat(hash32(key + 77)) * win;
  const n = Math.floor((hoursAbs - off) / win);
  // The visit of window n (and one that started in window n − 1 and is still running).
  for (const m of [n, n - 1]) {
    const ws = off + m * win;
    const hk = hash32(deriveSeed(seed, 'visit', key, m));
    const from = ws + hashToFloat(hk) * (win - len) * 0.9;
    const to = from + len * (0.75 + 0.5 * hashToFloat(hash32(hk + 1)));
    if (hoursAbs < from || hoursAbs >= to) continue;
    const dem = eateryDemand(kind, ((from % 24) + 24) % 24, district);
    if (hashToFloat(hash32(hk + 2)) >= dem) continue;
    const g = hashToFloat(hash32(hk + 3));
    return { n: m, from, to, guests: g < 0.25 ? 1 : g < 0.7 ? 2 : g < 0.85 ? 3 : 4 };
  }
  return null;
}
