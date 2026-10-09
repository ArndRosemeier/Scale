/**
 * Citizens and their days.
 *
 * Every citizen is a deterministic identity derived from a building slot:
 *  - non-workers (children, seniors, unemployed, home workers) are anchored at
 *    their home building;
 *  - workers are anchored at their workplace slot and get a deterministic home.
 * So each person exists exactly once, and their whole day (stays and trips) is
 * a pure function of (identity, day): nobody has to be simulated while unseen —
 * "where is X now" is computed when the player is near (Vuntra-style).
 */
import { Rng, hash32, hashCombine } from '../core/rng';
import type { MacroPlan } from '../plan/types';
import type { BuildingDesc } from '../plan/building';
import { polyCentroid, polyArea } from '../core/geom2';
import { doorBayOf } from '../build/buildingLayout';

export const enum Role { Child = 0, Adult = 1, Senior = 2, Worker = 3 }
export const enum Mode { Walk = 0, Car = 1, Metro = 2 }

/** A place a citizen can be: a building in a cell (resolved lazily), or outside the loaded region. */
export interface PlaceRef {
  cell: number;
  /** Building index, or -1 = "any suitable building" picked by hash at resolve time. */
  b: number;
  pick: number;
  kind: 'home' | 'work' | 'shop' | 'food' | 'park' | 'school' | 'leisure';
}

export interface Stay { place: PlaceRef; from: number; to: number }
export interface Trip { from: PlaceRef; to: PlaceRef; depart: number; mode: Mode }

export interface Citizen {
  id: number;
  seed: number;
  role: Role;
  gender: number;
  age: number;
  home: PlaceRef;
  work: PlaceRef | null;
  ownsCar: boolean;
  /** Personal rhythm. */
  wake: number;
  sleep: number;
  workStart: number;
  workLen: number;
  /** 0 calm … 1 nervous (reactions). */
  nerve: number;
  /** 0 reserved … 1 curious (gawking, filming). */
  curiosity: number;
}

export interface DayPlan { stays: Stay[]; trips: Trip[] }

/** Job density weights per district (jobs per m² of floor, roughly). */
const JOB_W: Record<string, number> = { downtown: 1, commercial: 0.6, industrial: 0.35, port: 0.3, oldtown: 0.4, apartments: 0.12, rowhouses: 0.05, suburban: 0.03, park: 0.02, water: 0 };
const HOME_W: Record<string, number> = { downtown: 0.25, commercial: 0.5, industrial: 0.05, port: 0.03, oldtown: 0.8, apartments: 1, rowhouses: 0.8, suburban: 0.5, park: 0, water: 0 };

export class Population {
  private jobCells: { cell: number; w: number }[] = [];
  private jobTotal = 0;
  private homeCells: { cell: number; w: number }[] = [];
  private homeTotal = 0;
  private planCache = new Map<string, DayPlan>();

  constructor(private macro: MacroPlan, readonly seed: number) {
    for (const c of macro.cells) {
      const jw = (JOB_W[c.district] ?? 0) * c.area;
      if (jw > 0) { this.jobTotal += jw; this.jobCells.push({ cell: c.id, w: this.jobTotal }); }
      const hw = (HOME_W[c.district] ?? 0) * c.area;
      if (hw > 0) { this.homeTotal += hw; this.homeCells.push({ cell: c.id, w: this.homeTotal }); }
    }
  }

  /** Residents (non-workers) of a building. */
  residentsOf(cell: number, b: number, desc: BuildingDesc): Citizen[] {
    const out: Citizen[] = [];
    if (desc.units <= 0) return out;
    const r = new Rng(hashCombine(hashCombine(this.seed, cell * 7919 + 13), b * 104729 + 7));
    const people = Math.round(desc.units * desc.floors * r.range(1.6, 2.6));
    // About half of the residents are workers counted at their workplaces.
    const n = Math.round(people * 0.45);
    for (let k = 0; k < n; k++) {
      const seed = hash32(hashCombine(hashCombine(this.seed ^ 0x5151, cell), b * 4096 + k));
      out.push(this.makeCitizen(seed, { cell, b, pick: 0, kind: 'home' }, null));
    }
    return out;
  }

  /** Workers anchored at a workplace building (only those who work there). */
  workersOf(cell: number, b: number, desc: BuildingDesc): Citizen[] {
    const out: Citizen[] = [];
    const area = Math.abs(polyArea(desc.poly));
    let jobs = 0;
    if (desc.use === 'office') jobs = (area * desc.floors) / 22;
    else if (desc.use === 'retail') jobs = (area * desc.floors) / 45;
    else if (desc.use === 'industrial') jobs = (area * desc.floors) / 90;
    else if (desc.use === 'civic') jobs = area / 60;
    else if (desc.use === 'mixed' || desc.shopfront) jobs = area / 45;
    else if (desc.use === 'parking') jobs = 2;
    const n = Math.round(jobs);
    for (let k = 0; k < n; k++) {
      const seed = hash32(hashCombine(hashCombine(this.seed ^ 0x7a7a, cell), b * 65536 + k));
      const r = new Rng(seed);
      const homeCell = this.pickWeighted(this.homeCells, this.homeTotal, r.float());
      const home: PlaceRef = { cell: homeCell, b: -1, pick: r.nextU32(), kind: 'home' };
      out.push(this.makeCitizen(seed, home, { cell, b, pick: 0, kind: 'work' }));
    }
    return out;
  }

  private pickWeighted(list: { cell: number; w: number }[], total: number, u: number): number {
    const t = u * total;
    let lo = 0, hi = list.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].w < t) lo = m + 1; else hi = m; }
    return list[lo]?.cell ?? 0;
  }

  /** A citizen identity for someone from far away (through traffic drivers). */
  synthetic(seed: number): Citizen {
    const r = new Rng(seed);
    const cell = this.pickWeighted(this.homeCells, this.homeTotal, r.float());
    return this.makeCitizen(seed, { cell, b: -1, pick: r.nextU32(), kind: 'home' }, null);
  }

  private makeCitizen(seed: number, home: PlaceRef, work: PlaceRef | null): Citizen {
    const r = new Rng(seed);
    let role: Role;
    if (work) role = Role.Worker;
    else role = r.weighted([Role.Child, Role.Adult, Role.Senior], (x) => (x === Role.Child ? 0.32 : x === Role.Adult ? 0.25 : 0.43));
    const age = role === Role.Child ? r.range(0.05, 0.18) : role === Role.Senior ? r.range(0.65, 0.95) : r.range(0.22, 0.62);
    const homeDistrict = this.macro.cells[home.cell]?.district ?? 'apartments';
    const carP = homeDistrict === 'suburban' ? 0.85 : homeDistrict === 'downtown' ? 0.2 : homeDistrict === 'oldtown' ? 0.25 : 0.5;
    return {
      id: seed,
      seed,
      role,
      gender: r.float(),
      age,
      home,
      work,
      ownsCar: role !== Role.Child && r.chance(carP),
      wake: r.normalIn(5.5, 9.5),
      sleep: r.normalIn(21.5, 25.5),
      workStart: r.normalIn(7, 10),
      workLen: r.normalIn(7.5, 10),
      nerve: r.float(),
      curiosity: r.float(),
    };
  }

  /** Distance between two macro cells (m). */
  cellDist(a: number, b: number): number {
    const ca = this.macro.cells[a]?.centroid, cb = this.macro.cells[b]?.centroid;
    if (!ca || !cb) return 1000;
    return Math.hypot(ca[0] - cb[0], ca[1] - cb[1]);
  }

  /** A nearby cell for errands (shops, food, parks) chosen deterministically. */
  private nearbyCell(from: number, r: Rng, want: string[]): number {
    const c0 = this.macro.cells[from];
    if (!c0) return from;
    let best = from, bs = -Infinity;
    for (let k = 0; k < 24; k++) {
      const c = this.macro.cells[(r.nextU32() % this.macro.cells.length)];
      const d = Math.hypot(c.centroid[0] - c0.centroid[0], c.centroid[1] - c0.centroid[1]);
      const s = (want.includes(c.district) ? 1 : 0) - d / 900 + r.float() * 0.3;
      if (s > bs) { bs = s; best = c.id; }
    }
    return bs > -0.3 ? best : from;
  }

  /** The citizen's plan for a given day (cached). Hours are absolute from day 0 (hours). */
  dayPlan(c: Citizen, day: number): DayPlan {
    const key = `${c.id}:${day}`;
    const cached = this.planCache.get(key);
    if (cached) return cached;
    if (this.planCache.size > 20000) this.planCache.clear();
    const r = new Rng(hashCombine(c.seed, day * 977 + 1));
    const weekend = day % 7 >= 5;
    const T0 = day * 24;
    const stays: Stay[] = [];
    const trips: Trip[] = [];
    const wake = c.wake + r.range(-0.4, 0.4) + (weekend ? 1 : 0);
    const sleep = c.sleep + r.range(-0.5, 0.5);
    let at: PlaceRef = c.home;
    let t = T0 + wake;
    stays.push({ place: c.home, from: T0 - 6, to: t + r.range(0.3, 1.0) });
    t = stays[0].to;
    const go = (to: PlaceRef, stayH: number) => {
      const dist = this.cellDist(at.cell, to.cell) + 150;
      const mode = dist < 1100 ? Mode.Walk : c.ownsCar && r.chance(0.7) ? Mode.Car : this.macro.metroLines.length ? Mode.Metro : Mode.Walk;
      const speed = mode === Mode.Walk ? 1.35 : mode === Mode.Car ? 9 : 10;
      const dur = dist / speed / 3600 + (mode === Mode.Metro ? 0.15 : mode === Mode.Car ? 0.08 : 0);
      trips.push({ from: at, to, depart: t, mode });
      t += dur;
      stays.push({ place: to, from: t, to: t + stayH });
      t += stayH;
      at = to;
    };
    if (c.role === Role.Worker && !weekend) {
      const start = T0 + c.workStart + r.range(-0.3, 0.3);
      t = Math.max(t, start - 0.6);
      // Lunch break outside for some.
      if (r.chance(0.4)) {
        const half = c.workLen * r.range(0.4, 0.55);
        go(c.work!, half);
        go({ cell: this.nearbyCell(c.work!.cell, r, ['commercial', 'downtown', 'oldtown']), b: -1, pick: r.nextU32(), kind: 'food' }, r.range(0.4, 0.9));
        go(c.work!, c.workLen - half);
      } else go(c.work!, c.workLen);
      // After work: errand, then home; sometimes a night out.
      if (r.chance(0.35)) go({ cell: this.nearbyCell(at.cell, r, ['commercial', 'oldtown']), b: -1, pick: r.nextU32(), kind: 'shop' }, r.range(0.3, 1.0));
      go(c.home, 0);
      if (r.chance(0.2)) {
        go({ cell: this.nearbyCell(c.home.cell, r, ['oldtown', 'commercial', 'downtown']), b: -1, pick: r.nextU32(), kind: 'leisure' }, r.range(1.5, 3.5));
        go(c.home, 0);
      }
    } else if (c.role === Role.Child && !weekend) {
      go({ cell: this.nearbyCell(c.home.cell, r, ['apartments', 'rowhouses', 'suburban', 'commercial']), b: -1, pick: r.nextU32(), kind: 'school' }, r.range(5.5, 7));
      if (r.chance(0.5)) go({ cell: this.nearbyCell(at.cell, r, ['park']), b: -1, pick: r.nextU32(), kind: 'park' }, r.range(0.5, 2));
      go(c.home, 0);
    } else {
      // Seniors, unemployed, weekends: errands, parks, cafes.
      const outings = r.int(1, 3);
      for (let k = 0; k < outings; k++) {
        const kind = r.pick(['shop', 'park', 'food', 'leisure'] as const);
        const want = kind === 'park' ? ['park'] : ['commercial', 'oldtown', 'downtown'];
        go({ cell: this.nearbyCell(at.cell, r, want), b: -1, pick: r.nextU32(), kind }, r.range(0.4, 2.5));
        if (r.chance(0.5)) go(c.home, r.range(0.5, 3));
      }
      if (at !== c.home) go(c.home, 0);
    }
    // Stay home until sleep / next day.
    stays[stays.length - 1].to = Math.max(stays[stays.length - 1].to, T0 + Math.max(sleep, t - T0) + 8);
    const plan = { stays, trips };
    this.planCache.set(key, plan);
    return plan;
  }

  /**
   * What the citizen is doing at absolute time `h` (hours): staying somewhere,
   * or travelling (trip + progress 0..1 by time).
   */
  stateAt(c: Citizen, h: number): { stay: Stay | null; trip: Trip | null; tripEnd: number } {
    const day = Math.floor(h / 24);
    for (const d of [day, day - 1]) {
      const p = this.dayPlan(c, d);
      for (let i = 0; i < p.trips.length; i++) {
        const tr = p.trips[i];
        const end = p.stays[i + 1]?.from ?? tr.depart;
        if (h >= tr.depart && h < end) return { stay: null, trip: tr, tripEnd: end };
      }
      for (const s of p.stays) if (h >= s.from && h < s.to) return { stay: s, trip: null, tripEnd: 0 };
    }
    return { stay: { place: c.home, from: h - 1, to: h + 1 }, trip: null, tripEnd: 0 };
  }
}

/** Entrance point of a building (front facade, door bay) — slightly outside the wall. */
export function doorOf(desc: BuildingDesc): { x: number; z: number; nx: number; nz: number } {
  const p = desc.poly;
  const n = p.length >> 1;
  const i = desc.front % n, j = (i + 1) % n;
  const ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
  const L = Math.hypot(bx - ax, bz - az) || 1;
  const nx = (bz - az) / L, nz = -(bx - ax) / L;
  const bays = Math.max(1, Math.round(L / desc.bay));
  const bayW = L / bays;
  const doorBay = doorBayOf(desc.seed, bays);
  const t = ((doorBay + 0.5) * bayW) / L;
  void polyCentroid;
  return { x: ax + (bx - ax) * t + nx * 0.8, z: az + (bz - az) * t + nz * 0.8, nx, nz };
}
