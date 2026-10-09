/**
 * Theme: a museum. The great hall runs through the middle from the entrance to the back (fill/split
 * reserves it first), the wings either side get a gallery corridor with exhibition rooms off it,
 * a museum shop and a café.
 *
 *  - great hall: the centrepiece statue in the middle, the reception desk facing the door,
 *    benches round the statue, display cases, plants and big paintings on the walls.
 *  - exhibition rooms: paintings round the walls, display cases and a statue or two in the floor,
 *    a bench in the middle to sit and look.
 *  - corridor: paintings and a bench.
 *  - shop: racks along the walls, the till by the door, display tables.
 *  - café: the counter against a wall, tables with stools.
 *  - store: racks and crates.
 *
 * The pieces are landmark parts (design/props builds each kind); sizes here are their footprints.
 */
import type { Rng } from '../../core/rng';
import type { Item, Kid, Cand, Filler } from './place';
import type { Area } from './area';
import type { RoomType } from '../InteriorGen';
import type { Program } from './split';
import { polyArea, polyBounds } from '../../core/geom2';
import type { C3 } from './palette';

/** The great hall through the middle (`share` of the width), galleries in the wings. */
export function museumProgram(share: number): Program {
  return {
    reserve: [{ type: 'lobby', at: 'centre', share }],
    rooms: [
      { type: 'exhibit', len: [8, 12] }, { type: 'exhibit', len: [8, 12] }, { type: 'shop', len: [7, 9], max: 1 },
      { type: 'exhibit', len: [9, 13] }, { type: 'cafe', len: [8, 11], max: 1 }, { type: 'exhibit', len: [8, 12] }, { type: 'storage', len: [5, 7], max: 1 },
    ],
    corridor: 3.2, corridorType: 'corridor',
    leaf: ['storage'], doorW: 2.2, doorsMid: true,
  };
}

// (Colours come from the theme's materials when the parts are built.)
const C: C3 = [0.8, 0.8, 0.8];
const many = (n: number, it: Item): Item[] => Array.from({ length: Math.max(0, Math.floor(n)) }, () => it);
/** Distance from the room's middle (bounding box centre). */
const fromMiddle = (A: Area) => {
  const [x0, z0, x1, z1] = polyBounds(A.poly), cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  return (c: Cand) => Math.hypot(c.x - cx, c.z - cz);
};
const painting = (big = false): Item => ({ kind: 'painting', at: 'wall', hung: true, widths: big ? [2.0, 1.6] : [1.6, 1.2, 0.9], w: big ? 2.0 : 1.6, d: 0.05, h: 1.4, color: C, score: (c, f) => f.cornerGap(c) * 0.2 + (c.edge ? -Math.abs(c.s - c.edge.len / 2) * 0.05 : 0) });
const vitrine = (A: Area): Item => { const m = fromMiddle(A); return { kind: 'case', at: 'free', sym: true, w: 1.2, d: 0.8, h: 1.5, color: C, front: 0.8, score: (c, f) => Math.min(f.doorDist(c.x, c.z), 4) * 0.3 - Math.abs(m(c) - 3.5) * 0.2 }; };
const statue = (A: Area): Item => { const m = fromMiddle(A); return { kind: 'statue', at: 'free', sym: true, w: 1.0, d: 1.0, h: 2.6, color: C, front: 1.0, score: (c, f) => Math.min(f.doorDist(c.x, c.z), 4) * 0.3 - Math.abs(m(c) - 2.5) * 0.3 }; };
const seat = (A: Area, at = 0): Item => { const m = fromMiddle(A); return { kind: 'seat', at: 'free', sym: true, w: 1.8, d: 0.5, h: 0.46, color: C, use: 'sit', front: 0.6, score: (c) => -Math.abs(m(c) - at) }; };
const planter: Item = { kind: 'planter', at: 'wall', w: 0.9, d: 0.9, h: 1.4, color: C, score: (c, f: Filler) => -f.cornerGap(c) * 1.5 };
const rack: Item = { kind: 'rack', at: 'wall', w: 1.2, d: 0.5, h: 1.9, color: C, front: 0.8, score: (c, f) => -f.cornerGap(c) * 0.3 };
const crate: Item = { kind: 'crate', at: 'free', sym: true, w: 1.0, d: 1.0, h: 1.0, color: C, score: (c, f) => Math.min(f.doorDist(c.x, c.z), 5) };
const stool = (dv: number, dyaw: number, need = false): Kid => ({ kind: 'stool', du: 0, dv, dyaw, w: 0.44, d: 0.44, h: 0.46, color: C, use: 'sit', need });
const table: Item = { kind: 'table', at: 'free', sym: true, w: 1.5, d: 0.9, h: 0.77, color: C, kids: [stool(0.75, Math.PI, true), stool(-0.75, 0)] };

/** The items for a room of a museum (empty for anything else). */
export function museumItems(type: RoomType, A: Area, r: Rng): Item[] {
  const area = Math.abs(polyArea(A.poly));
  switch (type) {
    case 'lobby': {
      const m = fromMiddle(A), [x0, z0, x1] = polyBounds(A.poly), cx = (x0 + x1) / 2;
      return [
        { kind: 'bigStatue', at: 'free', sym: true, w: 3.2, d: 3.2, h: 4.9, color: C, front: 1.5, score: (c) => -m(c) },
        // About 6 m in from the entrance (the front: the hall's low-v edge), facing it.
        { kind: 'reception', at: 'free', w: 3.0, d: 0.9, h: 1.15, color: C, use: 'stand', front: 1.0, kids: [], score: (c) => -Math.abs(c.z - z0 - 6) - Math.abs(c.x - cx) * 0.15 - Math.cos(c.yaw) },
        ...many(4, seat(A, 4.5)), ...many(Math.min(6, area / 80), vitrine(A)),
        planter, planter, planter, planter,
        ...many(Math.min(8, area / 60), painting(true)),
      ];
    }
    case 'exhibit': return [
      ...many(Math.min(10, area / 9), painting()),
      ...many(Math.min(5, area / 30), vitrine(A)),
      ...many(r.int(1, Math.min(3, Math.floor(area / 40) + 1)), statue(A)),
      seat(A),
    ];
    case 'corridor': return [...many(Math.min(8, area / 10), painting()), seat(A)];
    case 'shop': return [
      { kind: 'counter', at: 'wall', w: 2.0, d: 0.7, h: 1.0, color: C, use: 'stand', front: 1.0, score: (c, f) => -Math.abs(f.doorDist(c.x, c.z) - 2.5) },
      ...many(Math.min(8, area / 8), rack), table, table,
    ];
    case 'cafe': return [
      { kind: 'counter', at: 'wall', w: 2.8, d: 0.7, h: 1.0, color: C, use: 'stand', front: 1.1, score: (c, f) => Math.min(f.doorDist(c.x, c.z), 6) * 0.4 },
      ...many(Math.min(10, area / 8), table), planter, painting(),
    ];
    case 'storage': return [rack, rack, rack, rack, ...many(r.int(2, 5), crate)];
    default: return [];
  }
}
