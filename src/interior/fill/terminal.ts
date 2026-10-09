/**
 * Theme: an airport terminal's hall (plan/terminalParts lays out the bands). Landside along the
 * front the check-in hall, airside along the apron the gate lounges, between them a band of
 * shops, cafés and back rooms cut by the core, with the security lanes through it.
 *
 *  - check-in: a row of check-in desks with their bag belts facing the entrances, departures
 *    boards, a few seat rows and planters.
 *  - security: scanner arches with the bag belts beside them, lane by lane.
 *  - gates: a desk and its sign by each gate (at the glass), rows of seats facing the apron.
 *  - shops: a till, racks along the walls, display tables; cafés: a counter, tables with stools.
 *  - back rooms: racks and crates.
 *
 * The pieces are landmark parts (design/props); sizes here are their footprints.
 */
import type { Rng } from '../../core/rng';
import type { Item, Kid } from './place';
import type { Area } from './area';
import type { RoomType } from '../InteriorGen';
import { polyArea, polyBounds } from '../../core/geom2';
import type { C3 } from './palette';

export interface TerminalPlan {
  /** Check-in desks' row (v) and the gates' u along the glass. */
  deskV: number;
  gateU: number[];
  /** The gate lounge's glass (v) and how far back from it the seat rows reach. */
  glassV: number;
  /** Security lanes: their middle u and the band's middle v. */
  laneU: number[];
  laneV: number;
}

const C: C3 = [0.8, 0.8, 0.8];
const many = (n: number, f: () => Item): Item[] => Array.from({ length: Math.max(0, Math.floor(n)) }, f);
const stool = (dv: number, dyaw: number, need = false): Kid => ({ kind: 'stool', du: 0, dv, dyaw, w: 0.44, d: 0.44, h: 0.46, color: C, use: 'sit', need });

/** The items for a space of a terminal laid out as P. */
export function terminalItems(P: TerminalPlan) {
  return (type: RoomType, A: Area, r: Rng): Item[] => {
    const area = Math.abs(polyArea(A.poly)), [x0, , x1] = polyBounds(A.poly);
    const inU = (u: number) => u > x0 + 1 && u < x1 - 1;
    switch (type) {
      case 'checkin': {
        const desks: [number, number][] = [];
        for (let u = x0 + 6; u < x1 - 6; u += 3.2) desks.push([u, P.deskV]);
        const boards: [number, number][] = [], seats: [number, number][] = [];
        for (let u = x0 + 20; u < x1 - 10; u += 40) { boards.push([u, P.deskV - 8]); for (const du of [-6, 6]) seats.push([u + du, P.deskV - 9], [u + du, P.deskV - 10.5]); }
        return [
          ...many(Math.min(60, desks.length), () => ({ kind: 'checkDesk', at: 'free', w: 2.4, d: 0.8, h: 2.3, color: C, use: 'work', front: 2.0, spots: desks, score: (c) => -Math.cos(c.yaw) * 3 })),
          ...many(boards.length, () => ({ kind: 'board', at: 'free', sym: true, w: 1.8, d: 0.4, h: 2.9, color: C, front: 1.5, spots: boards })),
          ...many(seats.length, () => ({ kind: 'seatRow', at: 'free', w: 2.9, d: 0.6, h: 0.9, color: C, use: 'sit', front: 0.7, spots: seats, score: (c) => Math.cos(c.yaw) })),
          ...many(Math.min(12, area / 600), () => ({ kind: 'planter', at: 'wall', w: 0.9, d: 0.9, h: 1.4, color: C, score: () => r.range(0, 1) })),
        ];
      }
      case 'security': {
        const out: Item[] = [];
        for (const u of P.laneU) if (inU(u)) for (const du of [-3.5, 0, 3.5]) {
          out.push({ kind: 'scanner', at: 'free', w: 1.2, d: 0.6, h: 2.4, color: C, spots: [[u + du, P.laneV + 1.5]], score: (c) => Math.abs(Math.cos(c.yaw)) });
          out.push({ kind: 'belt', at: 'free', w: 2.8, d: 0.8, h: 1.5, color: C, spots: [[u + du + 1.6, P.laneV - 1.2]], score: (c) => Math.abs(Math.sin(c.yaw)) });
        }
        return out;
      }
      case 'gates': {
        const out: Item[] = [];
        for (const g of P.gateU) {
          if (!inU(g)) continue;
          out.push({ kind: 'gateDesk', at: 'free', w: 1.8, d: 0.7, h: 3.1, color: C, use: 'work', front: 1.5, spots: [[g + 4, P.glassV - 2.5]], score: (c) => -Math.cos(c.yaw) });
          const seats: [number, number][] = [];
          for (let k = 0; k < 4; k++) for (let du = -10; du <= 10; du += 3.1) if (Math.abs(du - 4) > 2.5 || k > 0) seats.push([g + du, P.glassV - 4.5 - k * 2.6]);
          out.push(...many(seats.length, () => ({ kind: 'seatRow', at: 'free', w: 2.9, d: 0.6, h: 0.9, color: C, use: 'sit', front: 0.7, spots: seats, score: (c) => Math.cos(c.yaw) * 2 })));
          out.push({ kind: 'board', at: 'free', sym: true, w: 1.8, d: 0.4, h: 2.9, color: C, front: 1.2, spots: [[g - 12, P.glassV - 6], [g + 12, P.glassV - 6]] });
        }
        out.push(...many(Math.min(16, area / 500), () => ({ kind: 'planter', at: 'free', sym: true, w: 0.9, d: 0.9, h: 1.4, color: C, score: () => r.range(0, 1) })));
        return out;
      }
      case 'shop': return [
        { kind: 'counter', at: 'wall', w: 2.0, d: 0.7, h: 1.0, color: C, use: 'stand', front: 1.0, score: (c, f) => -Math.abs(f.doorDist(c.x, c.z) - 2.5) },
        ...many(Math.min(10, area / 8), () => ({ kind: 'rack', at: 'wall', w: 1.2, d: 0.5, h: 1.9, color: C, front: 0.8, score: (c, f) => -f.cornerGap(c) * 0.3 })),
        ...many(Math.min(4, area / 30), () => ({ kind: 'table', at: 'free', sym: true, w: 1.5, d: 0.9, h: 0.77, color: C })),
      ];
      case 'cafe': return [
        { kind: 'counter', at: 'wall', w: 2.8, d: 0.7, h: 1.0, color: C, use: 'stand', front: 1.1, score: (c, f) => Math.min(f.doorDist(c.x, c.z), 6) * 0.4 },
        ...many(Math.min(12, area / 8), () => ({ kind: 'table', at: 'free', sym: true, w: 1.5, d: 0.9, h: 0.77, color: C, kids: [stool(0.75, Math.PI, true), stool(-0.75, 0)] })),
        { kind: 'planter', at: 'wall', w: 0.9, d: 0.9, h: 1.4, color: C },
      ];
      case 'storage': case 'office': return [
        ...many(4, () => ({ kind: 'rack', at: 'wall', w: 1.2, d: 0.5, h: 1.9, color: C, front: 0.8 })),
        ...many(r.int(2, 5), () => ({ kind: 'crate', at: 'free', sym: true, w: 1.0, d: 1.0, h: 1.0, color: C, score: (c, f) => Math.min(f.doorDist(c.x, c.z), 5) })),
      ];
      default: return [];
    }
  };
}
