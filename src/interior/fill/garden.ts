/**
 * Theme: a glasshouse's halls (plan/glasshouseParts lays out the halls, each a storey of its own).
 * Each hall gets a planting of its own:
 *
 *  - palms: palms and tree ferns in the free floor, beds of ferns along the glass, a fountain in
 *    a big enough hall (the dome), benches to sit under them.
 *  - desert: cacti and rocks in gravel, a few low palms, benches.
 *  - flowers: flower beds along the walls and in the floor, small trees, benches, a fountain.
 *
 * Plants are only as tall as the hall lets them be (`maxH`, from the floor to where the roof
 * springs). The pieces are landmark parts (design/props); sizes here are their footprints.
 */
import type { Rng } from '../../core/rng';
import type { Item, Cand } from './place';
import type { Area } from './area';
import type { RoomType } from '../InteriorGen';
import { polyArea, polyBounds, distSqPointSeg, type Poly } from '../../core/geom2';
import type { C3 } from './palette';

export type Planting = 'palms' | 'desert' | 'flowers';

// (Colours come from the theme's materials when the parts are built.)
const C: C3 = [0.4, 0.6, 0.35];
const many = (n: number, f: () => Item): Item[] => Array.from({ length: Math.max(0, Math.floor(n)) }, f);
const fromMiddle = (A: Area) => {
  const [x0, z0, x1, z1] = polyBounds(A.poly), cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  return (c: Cand) => Math.hypot(c.x - cx, c.z - cz);
};

/** A path: its centre line (local u, v). */
export type PathSeg = [[number, number], [number, number]];
export const PATH_W = 2.4;

/** The floor of the paths (convex strips, a little longer than the centre lines). */
export function pathFloor(paths: PathSeg[]): Poly[] {
  return paths.map(([a, b]) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L, h = PATH_W / 2;
    const ax = a[0] - ux * h * 0.5, az = a[1] - uz * h * 0.5, bx = b[0] + ux * h * 0.5, bz = b[1] + uz * h * 0.5;
    return [ax - uz * h, az + ux * h, ax + uz * h, az - ux * h, bx + uz * h, bz - ux * h, bx - uz * h, bz + ux * h];
  });
}

/**
 * The items for a hall of a glasshouse planted as `planting`, plants up to maxH tall, lining the
 * paths (kept clear by the caller); a fountain where the hall has a ring path round its middle.
 */
export function gardenItems(planting: Planting, maxH: number, paths: PathSeg[], fountainAt: [number, number] | null) {
  const toPath = (x: number, z: number) => paths.reduce((d, [a, b]) => Math.min(d, Math.sqrt(distSqPointSeg(x, z, a[0], a[1], b[0], b[1]))), Infinity);
  /** Spots along both sides of the paths, d metres out from their edges, every `gap` metres. */
  const along = (d: number, gap: number): [number, number][] => {
    const out: [number, number][] = [];
    for (const [a, b] of paths) {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L, o = PATH_W / 2 + d;
      for (let t = gap / 2; t < L; t += gap) for (const s of [-1, 1]) out.push([a[0] + ux * t - uz * o * s, a[1] + uz * t + ux * o * s]);
    }
    return out;
  };
  const S = { tall: along(1.3, 2.2), mid: along(1.0, 1.6), low: along(0.7, 1.3), bench: along(0.4, 2.0) };
  /** Near the path's edge (d metres from its side), a little random. */
  const lining = (d: number, r: Rng) => (c: Cand) => -Math.abs(toPath(c.x, c.z) - PATH_W / 2 - d) * 0.4 + r.range(0, 0.6);
  return (type: RoomType, A: Area, r: Rng): Item[] => {
    if (type !== 'garden') return [];
    const area = Math.abs(polyArea(A.poly)), m = fromMiddle(A);
    const tall = (lo: number, hi: number) => Math.max(1.5, Math.min(hi, maxH - 0.4, r.range(lo, hi)));
    const fountain: Item[] = fountainAt ? [{ kind: 'fountain', at: 'free', sym: true, w: 3.6, d: 3.6, h: 1.4, color: C, front: 0.3, spots: [fountainAt] }] : [];
    const palm = (): Item => ({ kind: 'palm', at: 'free', sym: true, w: 1.6, d: 1.6, h: tall(4, 8), color: C, spots: S.tall, score: lining(1.3, r) });
    const tree = (): Item => ({ kind: 'tree', at: 'free', sym: true, w: 1.8, d: 1.8, h: tall(3, 5.5), color: C, spots: S.tall, score: lining(1.3, r) });
    const fern = (): Item => ({ kind: 'fern', at: 'free', sym: true, w: 1.2, d: 1.2, h: 1.0, color: C, score: lining(0.6, r) });
    const bedWall = (): Item => ({ kind: 'flowerBed', at: 'wall', widths: [3.0, 2.2, 1.4], w: 3.0, d: 1.2, h: 0.9, color: C, score: (c, f) => -f.cornerGap(c) * 0.1 + r.range(0, 0.5) });
    const bedFree = (): Item => ({ kind: 'flowerBed', at: 'free', w: 2.4, d: 1.2, h: 0.9, color: C, spots: S.mid, score: lining(0.7, r) });
    const cactus = (): Item => ({ kind: 'cactus', at: 'free', sym: true, w: 1.0, d: 1.0, h: tall(1.2, 3.2), color: C, spots: [...S.low, ...S.tall], score: lining(0.7, r) });
    const rock = (): Item => ({ kind: 'rock', at: 'free', sym: true, w: 1.4, d: 1.1, h: 0.8, color: C, spots: [...S.low, ...S.tall], score: lining(0.7, r) });
    const bench = (): Item => ({ kind: 'bench', at: 'free', w: 1.9, d: 0.56, h: 0.85, color: C, use: 'sit', front: 0.6, spots: S.bench, score: (c) => -Math.abs(toPath(c.x, c.z) - PATH_W / 2 - 0.35) * 2 - Math.abs(m(c) - 6) * 0.1 });
    switch (planting) {
      case 'palms': return [...fountain, ...many(Math.min(32, area / 22), palm), ...many(area > 600 ? 4 : 2, bench), ...many(Math.min(16, area / 50), tree), ...many(Math.min(28, area / 20), fern), ...many(Math.min(16, area / 18), bedWall)];
      case 'desert': return [...many(Math.min(10, area / 45), palm).map((p) => ({ ...p, h: Math.min(p.h, 4) })), ...many(2, bench), ...many(Math.min(36, area / 10), cactus), ...many(Math.min(18, area / 25), rock)];
      case 'flowers': return [...fountain, ...many(2, bench), ...many(Math.min(16, area / 14), bedFree), ...many(Math.min(10, area / 40), tree), ...many(Math.min(14, area / 18), bedWall)];
    }
  };
}
