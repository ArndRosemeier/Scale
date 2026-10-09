/**
 * Theme: the starship's rooms round its great hall (interior/design/hall). The hall reserves the
 * void, the gallery ring and the stair wells; the ring behind the gallery is cut into wedge rooms
 * along rays from the hull's axis (fill/split sectors), wider ones for the mess and the lounge.
 *
 *  - quarters: sleep pods head to a plain wall, a locker, a wall screen, a table with a stool.
 *  - lab: consoles along the walls, a holo table in the free floor, racks and crates.
 *  - mess: the galley counter along a wall, tables with stools in the free floor.
 *  - lounge: benches along the walls, a holo table, planters.
 *  - control: a row of consoles with their stools, the holo table in the middle, screens.
 *  - storage: racks and lockers along the walls, crates stacked in the floor.
 *
 * The pieces are landmark parts (design/props builds each kind); sizes here are their footprints.
 */
import type { Rng } from '../../core/rng';
import type { Item, Kid, Cand } from './place';
import type { Area } from './area';
import type { RoomType } from '../InteriorGen';
import type { Program } from './split';
import { polyArea } from '../../core/geom2';
import type { C3 } from './palette';

/** The room mix round a starship's hall: room types with their width at the far wall (m). */
export function starshipProgram(cx: number, cz: number, angles: number[]): Program {
  return {
    reserve: [],
    rooms: [
      { type: 'quarters', len: [8, 12] }, { type: 'lab', len: [9, 13] }, { type: 'quarters', len: [8, 12] },
      { type: 'mess', len: [16, 22], max: 2 }, { type: 'quarters', len: [8, 12] }, { type: 'storage', len: [7, 11] },
      { type: 'lounge', len: [15, 22], max: 2 }, { type: 'lab', len: [9, 13] }, { type: 'control', len: [10, 14], max: 1 },
    ],
    corridor: 0, leaf: ['quarters', 'storage'],
    sectors: { cx, cz, angles }, doorsMid: true,
  };
}

// (Colours come from the theme's materials when the parts are built.)
const C: C3 = [0.9, 0.92, 0.94];
const plainWall = (c: Cand) => (c.edge && c.edge.kind !== 'window' ? 1 : 0);
const many = (n: number, it: Item): Item[] => Array.from({ length: Math.max(0, Math.floor(n)) }, () => it);
const stool = (dv: number, dyaw: number, need = false): Kid => ({ kind: 'stool', du: 0, dv, dyaw, w: 0.44, d: 0.44, h: 0.46, color: C, use: 'sit', need });

const pod: Item = { kind: 'pod', at: 'wall', w: 1.1, d: 2.2, h: 1.15, color: C, use: 'sleep', front: 0.7, score: (c, f) => plainWall(c) + Math.min(f.doorDist(c.x, c.z), 4) * 0.3 };
const locker: Item = { kind: 'locker', at: 'wall', w: 1.8, d: 0.6, h: 2.1, color: C, front: 0.8, score: (c, f) => -f.cornerGap(c) * 0.5 };
const screen: Item = { kind: 'screen', at: 'wall', hung: true, w: 1.8, d: 0.04, h: 0.8, color: C, score: (c) => (c.edge ? -Math.abs(c.s - c.edge.len / 2) : 0) };
const planter: Item = { kind: 'planter', at: 'wall', w: 0.9, d: 0.9, h: 1.2, color: C, score: (c, f) => -f.cornerGap(c) * 1.5 };
const rack: Item = { kind: 'rack', at: 'wall', w: 1.2, d: 0.5, h: 1.9, color: C, front: 0.7, score: (c, f) => -f.cornerGap(c) * 0.3 };
const crate: Item = { kind: 'crate', at: 'free', sym: true, w: 1.0, d: 1.0, h: 1.0, color: C, score: (c, f) => Math.min(f.doorDist(c.x, c.z), 5) - f.cornerGap(c) * 0.2 };
const holo: Item = { kind: 'holo', at: 'free', sym: true, w: 1.5, d: 1.5, h: 1.9, color: C, front: 0.8, score: (c, f) => Math.min(f.doorDist(c.x, c.z), 4) * 0.3 };
const table = (stools: number): Item => ({
  kind: 'table', at: 'free', sym: true, w: 1.5, d: 0.9, h: 0.77, color: C,
  kids: [stool(0.75, Math.PI, stools > 0), ...(stools > 1 ? [stool(-0.75, 0)] : [])],
});
const console_ = (seat: boolean): Item => ({
  kind: 'console', at: 'wall', w: 1.6, d: 0.7, h: 0.85, color: C, use: 'work', front: 1.0,
  kids: seat ? [stool(0.7, Math.PI)] : [],
  score: (c, f) => plainWall(c) + Math.min(f.doorDist(c.x, c.z), 4) * 0.2,
});

/** The items for a room of a starship (empty for anything else). */
export function starshipItems(type: RoomType, A: Area, r: Rng): Item[] {
  const area = Math.abs(polyArea(A.poly));
  switch (type) {
    case 'quarters': return [pod, pod, ...(area > 70 ? [pod] : []), locker, screen, table(1), planter];
    case 'lab': return [console_(true), console_(false), holo, rack, rack, ...many(r.int(1, 3), crate), screen];
    case 'mess': return [
      { kind: 'counter', at: 'wall', w: 2.8, d: 0.7, h: 1.0, color: C, use: 'stand', front: 1.1, score: (c, f) => plainWall(c) + Math.min(f.doorDist(c.x, c.z), 6) * 0.4 },
      ...many(Math.min(8, area / 14), table(2)), planter, planter, screen,
    ];
    case 'lounge': return [{ kind: 'bench', at: 'wall', w: 1.9, d: 0.56, h: 0.85, color: C, use: 'sit', front: 0.8, score: plainWall }, holo, ...many(Math.min(4, area / 30), { kind: 'bench', at: 'wall', w: 1.9, d: 0.56, h: 0.85, color: C, use: 'sit', front: 0.8, score: plainWall }), planter, planter, screen];
    case 'control': return [console_(true), console_(true), console_(true), holo, screen, screen, planter];
    case 'storage': return [rack, rack, rack, rack, locker, ...many(r.int(3, 6), crate)];
    default: return [];
  }
}
