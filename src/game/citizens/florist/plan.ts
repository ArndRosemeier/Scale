/**
 * The shrunk florist, the pure part: where her shop is, which roofs carry her gardens and what she
 * does at what time of day. No three.js: runs in the self test.
 *
 * Shop: in one of the old-town / commercial / downtown cells nearest the city centre (a seeded
 * pick among the first few), a ground-floor shop that is not a café, a clothes shop or an arcade,
 * with room on the pavement beside its door (clear of the walking corridor) for her flower stand.
 * Gardens: up to GARDENS flat roofs of the same cell, 20 to 170 m from the shop, picked by seed.
 */
import { deriveSeed, hash32, hashToFloat } from '../../../core/rng';
import { pointInPoly, polyArea, polyCentroid } from '../../../core/geom2';
import { clearOfWalk, frontDoor, streetBoxes } from '../../../plan/terrace';
import { isArcade, isClothesShop } from '../../../interior/InteriorGen';
import type { CellPlan } from '../../../plan/cell';
import type { BuildingDesc } from '../../../plan/building';
import type { MacroPlan } from '../../../plan/types';

/** Her height (m), and her pigeon's body length (m: a big, well-fed one). */
export const FLORIST_H = 0.15;
export const PIGEON_LEN = 0.42;
/** Roof gardens at most. */
export const GARDENS = 3;

export interface FloristGarden {
  /** Building index in the cell plan. */
  b: number;
  x: number;
  z: number;
  /** Direction along which the planters stand (unit). */
  ux: number;
  uz: number;
}

export interface FloristHome {
  cell: number;
  /** Building index in the cell plan. */
  b: number;
  /** The shop door (on the pavement, 0.8 m out from the facade). */
  door: { x: number; z: number };
  /** Along the facade (unit, towards the stand) and out of it (unit). */
  tx: number; tz: number;
  nx: number; nz: number;
  /** Her flower stand on the pavement (against the facade) and her own little door in the wall. */
  stand: { x: number; z: number };
  little: { x: number; z: number };
  gardens: FloristGarden[];
  /** Her name and the shop's. */
  name: string;
  shop: string;
}

const DISTRICTS = new Set(['oldtown', 'commercial', 'downtown']);

/** Cells her shop may be in, in the order they are tried (seeded: one of the first four comes first). */
export function floristCells(macro: MacroPlan, seed: number): number[] {
  const c0 = macro.centres[0] ?? { x: 0, z: 0 };
  const cells = macro.cells.filter((c) => DISTRICTS.has(c.district))
    .sort((a, b) => Math.hypot(a.centroid[0] - c0.x, a.centroid[1] - c0.z) - Math.hypot(b.centroid[0] - c0.x, b.centroid[1] - c0.z))
    .slice(0, 12).map((c) => c.id);
  if (cells.length < 2) return cells;
  const k = hash32(deriveSeed(seed, 'florist-cell')) % Math.min(4, cells.length);
  return [cells[k], ...cells.filter((_, i) => i !== k)];
}

/** Her name (first names only: the city knows her by it). */
const NAMES = ['Posy', 'Tilly', 'Daisy', 'Clementine', 'Wren', 'Marigold', 'Hazel', 'Pip'];

export function floristName(seed: number): string {
  return NAMES[hash32(deriveSeed(seed, 'florist-name')) % NAMES.length];
}

function edge(b: BuildingDesc): { tx: number; tz: number; nx: number; nz: number } {
  const p = b.poly, n = p.length >> 1;
  const i = b.front % n, j = (i + 1) % n;
  const dx = p[j * 2] - p[i * 2], dz = p[j * 2 + 1] - p[i * 2 + 1];
  const L = Math.hypot(dx, dz) || 1;
  return { tx: dx / L, tz: dz / L, nx: dz / L, nz: -dx / L };
}

/** Her shop in this cell's plan (null: no shop here fits). Deterministic for (plan, seed). */
export function floristHome(plan: CellPlan, seed: number): FloristHome | null {
  const boxes = streetBoxes(plan.streets);
  const doors = plan.buildings.map((b) => frontDoor(b));
  const order = plan.buildings.map((b, i) => ({ b, i, h: hashToFloat(hash32(deriveSeed(seed, 'florist-shop', b.id))) }))
    .filter(({ b }) => b.shopfront && !b.eatery && !b.landmark && b.style !== 'church' && b.use !== 'industrial' && b.use !== 'parking' && !isClothesShop(b) && !isArcade(b))
    .sort((p, q) => p.h - q.h);
  for (const { b, i } of order) {
    const e = edge(b), d = doors[i];
    // Her stand: beside the door against the wall (0.35 m out), either side; clear of the walk and of other doors.
    for (const s of [1, -1]) {
      const tx = e.tx * s, tz = e.tz * s;
      const sx = d.x + tx * 1.9 - e.nx * 0.45, sz = d.z + tz * 1.9 - e.nz * 0.45;
      // The whole stand (buckets, pot, crate, sandwich board: −0.4 … +2.1 m along) fits.
      let fits = true;
      for (const u of [-0.4, 0.5, 1.3, 2.1]) {
        const px = sx + tx * u, pz = sz + tz * u;
        if (!clearOfWalk(plan.streets, px, pz, 0.35, false, boxes) || doors.some((o, k) => k !== i && Math.hypot(o.x - px, o.z - pz) < 2)
          || plan.buildings.some((o, k) => k !== i && pointInPoly(o.poly, px, pz))) { fits = false; break; }
      }
      if (!fits) continue;
      // Her own little door in the wall between the shop door and the stand.
      const lx = d.x + tx * 1.05 - e.nx * 0.8, lz = d.z + tz * 1.05 - e.nz * 0.8;
      const home: FloristHome = {
        cell: plan.id, b: i, door: { x: d.x, z: d.z }, tx, tz, nx: e.nx, nz: e.nz,
        stand: { x: sx, z: sz }, little: { x: lx, z: lz }, gardens: [], name: floristName(seed), shop: '',
      };
      home.shop = `${home.name}'s Petals`;
      home.gardens = gardensFor(plan, home, seed);
      return home;
    }
  }
  return null;
}

/** Her roof gardens: flat roofs of the cell, 20–170 m from the shop, not too tall (seeded pick). */
export function gardensFor(plan: CellPlan, home: Pick<FloristHome, 'stand' | 'b'>, seed: number): FloristGarden[] {
  const out: (FloristGarden & { h: number })[] = [];
  plan.buildings.forEach((b, i) => {
    if (i === home.b || b.roof !== 'flat' || b.landmark || b.floors < 2 || b.floors > 8 || b.setbacks.length) return;
    if (polyArea(b.poly) < 70) return;
    const [cx, cz] = polyCentroid(b.poly);
    if (!pointInPoly(b.poly, cx, cz)) return;
    const d = Math.hypot(cx - home.stand.x, cz - home.stand.z);
    if (d < 20 || d > 170) return;
    const e = edge(b);
    out.push({ b: i, x: cx, z: cz, ux: e.tx, uz: e.tz, h: hashToFloat(hash32(deriveSeed(seed, 'florist-garden', b.id))) });
  });
  return out.sort((p, q) => p.h - q.h).slice(0, GARDENS).map(({ h: _h, ...g }) => g);
}

/** What she does at an hour of the day (0..24): asleep inside, at her shop, or out on deliveries. */
export type FloristDay = 'asleep' | 'open' | 'evening';

export function floristDay(hour: number): FloristDay {
  const h = ((hour % 24) + 24) % 24;
  if (h < 6.5 || h >= 21.5) return 'asleep';
  if (h >= 19) return 'evening';
  return 'open';
}
