/**
 * Themes: the lookouts (plan/towerParts, plan/lighthouseParts, plan/fortressParts lay out their
 * shells): an observation tower's lobby and its deck up top, a lighthouse's stair room and lantern
 * room, a fortress keep's great hall.
 *
 *  - foyer (a tower's foot): the ticket desk, the lift doors on the core, benches, a souvenir rack.
 *  - deck: coin telescopes at the glass, benches looking out, a snack counter with a few tables.
 *  - stair room: the spiral stair up the middle, a chest, a rack, a bench by the wall.
 *  - lantern room: the great lens in the middle.
 *  - great hall: the throne at the back facing the door, the long table with its benches, banners,
 *    a fireplace, suits of armour (a ruin's: the same, fallen stones about).
 *
 * The pieces are landmark parts (design/props); sizes here are their footprints.
 */
import type { Rng } from '../../core/rng';
import type { Item, Kid } from './place';
import type { Area } from './area';
import type { RoomType } from '../InteriorGen';
import { polyArea, polyBounds } from '../../core/geom2';
import type { C3 } from './palette';

export interface LookoutPlan {
  /** The middle of the core (a lift shaft or a spiral stair) and its half size; none: no core. */
  core?: { u: number; v: number; r: number };
  /** A ruined keep: fallen stones in the hall. */
  ruin?: boolean;
}

const C: C3 = [0.8, 0.8, 0.8];
const many = (n: number, f: () => Item): Item[] => Array.from({ length: Math.max(0, Math.floor(n)) }, f);
const sit = (dv: number, dyaw: number, du = 0): Kid => ({ kind: 'bench', du, dv, dyaw, w: 1.9, d: 0.5, h: 0.85, color: C, use: 'sit', need: true });

/** The items for a space of a lookout laid out as P. */
export function lookoutItems(P: LookoutPlan) {
  return (type: RoomType, A: Area, r: Rng): Item[] => {
    const area = Math.abs(polyArea(A.poly)), [x0, z0, x1, z1] = polyBounds(A.poly);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const core = P.core;
    // (Lift doors on the core's face towards the way in.)
    const lift = (): Item[] => core ? [{ kind: 'liftDoor', at: 'free', w: 1.6, d: 0.25, h: 2.6, color: C, front: 1.5, spots: [[core.u, core.v - core.r - 0.15]], score: (c) => -Math.cos(c.yaw) }] : [];
    const out = (x: number, z: number) => Math.hypot(x - cx, z - cz);
    switch (type) {
      case 'foyer': return [
        { kind: 'counter', at: 'wall', w: 2.4, d: 0.7, h: 1.0, color: C, use: 'stand', front: 1.1, score: (c, f) => -Math.abs(f.doorDist(c.x, c.z) - 4) },
        ...lift(),
        ...many(Math.min(4, area / 40), () => ({ kind: 'rack', at: 'wall', w: 1.2, d: 0.5, h: 1.9, color: C, front: 0.8, score: (c, f) => f.doorDist(c.x, c.z) * 0.2 })),
        ...many(Math.min(4, area / 50), () => ({ kind: 'bench', at: 'wall', w: 1.9, d: 0.56, h: 0.85, color: C, use: 'sit', front: 0.6 })),
        ...many(Math.min(4, area / 60), () => ({ kind: 'planter', at: 'wall', w: 0.9, d: 0.9, h: 1.4, color: C, score: () => r.range(0, 1) })),
      ];
      case 'deck': {
        const scopes = Math.max(2, Math.min(10, Math.floor(area / 25)));
        return [
          ...many(scopes, () => ({ kind: 'telescope', at: 'wall', w: 0.7, d: 0.7, h: 1.5, color: C, use: 'stand', front: 0.9, score: (c, f) => f.cornerGap(c) * 0.5 + r.range(0, 0.5) })),
          ...lift(),
          ...(area > 90 ? [{ kind: 'counter', at: 'wall', w: 2.4, d: 0.7, h: 1.0, color: C, use: 'stand', front: 1.1, score: (c: { x: number; z: number }) => -out(c.x, c.z) * 0.1 } as Item] : []),
          ...many(Math.min(6, area / 45), () => ({ kind: 'table', at: 'free', sym: true, w: 1.5, d: 0.9, h: 0.77, color: C, kids: [sit(0.8, Math.PI), sit(-0.8, 0)] })),
          // (Benches with their backs to the middle, looking out.)
          ...many(Math.min(8, area / 30), () => ({ kind: 'bench', at: 'free', w: 1.9, d: 0.56, h: 0.85, color: C, use: 'sit', front: 0.6, score: (c) => { const dx = c.x - cx, dz = c.z - cz, d = Math.hypot(dx, dz) || 1; return (Math.sin(c.yaw) * dx + Math.cos(c.yaw) * dz) / d; } })),
        ];
      }
      case 'stairhall': return [
        { kind: 'spiralStair', at: 'free', sym: true, w: 2.6, d: 2.6, h: 3.4, color: C, spots: [[cx, cz]] },
        { kind: 'crate', at: 'wall', w: 1.0, d: 0.6, h: 0.7, color: C },
        { kind: 'rack', at: 'wall', w: 1.2, d: 0.5, h: 1.9, color: C, front: 0.8 },
        { kind: 'bench', at: 'wall', w: 1.9, d: 0.56, h: 0.85, color: C, use: 'sit', front: 0.6 },
      ];
      case 'lantern': return [
        { kind: 'lens', at: 'free', sym: true, w: 1.6, d: 1.6, h: 2.4, color: C, spots: [[cx, cz]] },
      ];
      case 'greatHall': {
        const w = x1 - x0, d = z1 - z0;
        const tables: [number, number][] = [[cx, cz + d * 0.05], [cx, cz - d * 0.05]];
        // (Backless benches down both sides of the table.)
        const seats: Kid[] = [-1, 1].flatMap((s) => [-1.9, 0, 1.9].map((dv): Kid => ({ kind: 'seat', du: s * 1.15, dv, dyaw: s * Math.PI / 2, w: 1.8, d: 0.5, h: 0.46, color: C, use: 'sit' })));
        const items: Item[] = [
          // The throne on its dais at the back, facing the door.
          { kind: 'throne', at: 'wall', w: 2.4, d: 1.6, h: 3.2, color: C, front: 2.5, score: (c, f) => f.doorDist(c.x, c.z) - Math.abs(c.x - cx) * 0.3 },
          { kind: 'longTable', at: 'free', w: 1.4, d: 6, h: 0.8, color: C, spots: tables, score: (c) => Math.abs(Math.cos(c.yaw)) * 2, kids: seats },
          { kind: 'fireplace', at: 'wall', w: 2.6, d: 0.9, h: 3.0, color: C, front: 1.5, score: (c) => -Math.abs(c.z - cz) * 0.2 },
          ...many(Math.min(8, (w + d) / 4), () => ({ kind: 'banner', at: 'wall', hung: true, w: 1.2, d: 0.08, h: 3.2, color: C, score: (c, f) => f.cornerGap(c) * 0.2 })),
          ...many(Math.min(6, (w + d) / 6), () => ({ kind: 'armour', at: 'wall', w: 0.7, d: 0.6, h: 2.0, color: C, front: 0.6 })),
        ];
        if (P.ruin) items.push(...many(r.int(4, 8), () => ({ kind: 'rock', at: 'free', sym: true, w: 1.4, d: 1.1, h: 0.8, color: C, score: () => r.range(0, 1) })));
        return items;
      }
      default: return [];
    }
  };
}
