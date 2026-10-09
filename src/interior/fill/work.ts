/**
 * Themes: offices, shops and cafés. Each theme has a program (what it reserves first and what the
 * rest of the floor is cut into, for fill/split) and the items each of its rooms holds (for
 * fill/place), in order of importance:
 *
 *  - offices: the ground floor reserves a lobby along the street front, every floor an open-plan
 *    office (the big space) before the rest becomes meeting rooms, single offices, a tea kitchen,
 *    toilets and a store room. Open plan: pairs of desks facing each other, near the windows,
 *    filing cabinets along the plain walls, a water cooler by the door. Meeting room: the table
 *    with chairs round it and the screen at its end. Lobby: the reception desk facing the way in,
 *    a waiting corner.
 *  - shops: the sales floor along the street front first, a store room and a toilet behind it.
 *    Grocery: aisles of back-to-back shelving, shelves along the walls, the checkout near the
 *    door. Clothes shop: the fitting mirror (always), display tables, shelving, the checkout.
 *  - cafés: the guest room along the street front, the counter against its back wall, tables
 *    with chairs by the windows; a kitchen, a toilet and a store room behind.
 */
import type { Rng } from '../../core/rng';
import type { Item, Cand, Filler, Kid } from './place';
import type { Area } from './area';
import type { Program } from './split';
import type { RoomType } from '../InteriorGen';
import { minAreaRect, polyArea } from '../../core/geom2';
import { FABRIC, WOOD, LEAF, WHITE_WARE, type C3 } from './palette';

export type Work = 'office' | 'grocery' | 'clothes' | 'cafe';

export function workProgram(w: Work, ground: boolean): Program {
  const wc = { type: 'bath' as RoomType, len: [1.7, 2.3] as [number, number], max: 1 };
  if (w === 'office') {
    return {
      reserve: [
        ...(ground ? [{ type: 'lobby' as RoomType, at: 'front' as const, depth: 5, minLeft: 3 }] : []),
        { type: 'office', at: 'front', share: 0.62, minLeft: 2.8, leave: 5.5 },
      ],
      rooms: [{ type: 'meeting', len: [3.6, 5], max: 2 }, { type: 'office', len: [2.8, 3.6] }, { type: 'kitchen', len: [2.4, 3], max: 1 }, wc, { type: 'office', len: [2.8, 3.6] }, { type: 'storage', len: [2, 2.8] }],
      corridor: 0, leaf: ['bath', 'storage', 'meeting'],
    };
  }
  if (w === 'cafe') {
    return {
      reserve: [{ type: 'cafe', at: 'front', share: 0.68, minLeft: 2.6, leave: 4.5 }],
      rooms: [{ type: 'kitchen', len: [3, 4.5], max: 1 }, wc, { type: 'storage', len: [2.2, 3.2] }],
      corridor: 0, leaf: ['bath', 'storage'],
    };
  }
  return {
    reserve: [{ type: 'shop', at: 'front', share: 0.74, minLeft: 2.6, leave: 4.5 }],
    rooms: [{ type: 'storage', len: [3, 5] }, wc],
    corridor: 0, leaf: ['bath'],
  };
}

/** The items for a room of a work theme. */
export function workItems(w: Work, type: RoomType, A: Area, r: Rng): Item[] {
  switch (type) {
    case 'lobby': return lobby(r);
    case 'office': return roomArea(A) >= 28 ? openPlan(A, r) : singleOffice(r);
    case 'meeting': return meeting(A, r);
    case 'kitchen': return w === 'cafe' ? cafeKitchen() : teaKitchen(r);
    case 'bath': return toilet();
    case 'storage': return w === 'office' ? officeStore() : stockRoom(r);
    case 'shop': return w === 'clothes' ? clothes(A, r) : grocery(A, r);
    case 'cafe': return cafe(A, r);
    default: return [];
  }
}

const roomArea = (A: Area) => Math.abs(polyArea(A.poly));
const plainWall = (c: Cand) => (c.edge && c.edge.kind !== 'window' ? 1 : 0);
const centred = (c: Cand) => (c.edge ? -Math.abs(c.s - c.edge.len / 2) : 0);
const plant = (h: number): Item => ({ kind: 'plant', at: 'wall', w: 0.55, d: 0.55, h, color: LEAF, score: (c, f) => -f.cornerGap(c) * 1.5 });
const picture = (col: C3, w = 1.0): Item => ({ kind: 'painting', at: 'wall', hung: true, w, d: 0.04, h: 0.7, color: col, score: centred });
const many = (n: number, it: Item): Item[] => Array.from({ length: Math.max(0, Math.floor(n)) }, () => it);
/** Is a free candidate turned so that its width runs along the room's long axis? */
const alongRoom = (A: Area) => {
  const o = minAreaRect(A.poly), long = o.hu >= o.hv, ux = long ? o.ux : -o.uz, uz = long ? o.uz : o.ux;
  return (c: Cand) => Math.abs(Math.cos(c.yaw) * ux - Math.sin(c.yaw) * uz) > 0.7;
};
const DARK: C3 = [0.15, 0.15, 0.17], SCREEN: C3 = [0.08, 0.08, 0.09], DESK: C3 = [0.85, 0.84, 0.8], METAL: C3 = [0.55, 0.57, 0.6];

/** An office chair at a desk's front, turned to it. */
const seat = (dv: number, dyaw: number, need = true): Kid => ({ kind: 'officeChair', du: 0, dv, dyaw, w: 0.6, d: 0.6, h: 1.1, color: DARK, use: 'work', need });

function openPlan(A: Area, r: Rng): Item[] {
  const along = alongRoom(A), area = roomArea(A);
  // Two desks facing each other: the first looks to +z, its partner sits behind it turned round.
  const pair: Item = {
    kind: 'desk', at: 'free', w: 1.6, d: 0.8, h: 0.74, color: DESK,
    kids: [
      { kind: 'monitor', du: 0, dv: -0.15, w: 0.6, d: 0.05, h: 0.4, color: SCREEN, onTop: true },
      seat(0.8, Math.PI),
      { kind: 'desk', du: 0, dv: -0.8, dyaw: Math.PI, w: 1.6, d: 0.8, h: 0.74, color: DESK },
      { kind: 'monitor', du: 0, dv: -0.65, dyaw: Math.PI, w: 0.6, d: 0.05, h: 0.4, color: SCREEN, onTop: true },
      seat(-1.6, 0, false),
    ],
    // Near the windows, in tidy rows along the room.
    score: (c, f) => -Math.min(f.windowDist(c.x, c.z), 8) * 0.5 + (along(c) ? 1.5 : 0) + Math.min(f.doorDist(c.x, c.z), 3) * 0.2,
  };
  const items: Item[] = [
    { kind: 'cooler', at: 'wall', w: 0.4, d: 0.4, h: 1.2, color: [0.9, 0.9, 0.92], tall: false, front: 0.6, score: (c, f) => -Math.abs(f.doorDist(c.x, c.z) - 1.2) },
    ...many(Math.min(24, area / 12), pair),
    ...many(Math.min(4, area / 25), { kind: 'shelf', at: 'wall', w: 0.9, d: 0.45, h: 1.3, color: METAL, front: 0.7, score: plainWall }),
    plant(1.5), plant(1.4),
  ];
  if (area > 70) items.push({ kind: 'sofa', at: 'wall', w: 1.8, d: 0.85, h: 0.85, color: r.pick(FABRIC), use: 'sit', front: 0.8, kids: [{ kind: 'coffeeTable', du: 0, dv: 0.85, w: 1.0, d: 0.55, h: 0.42, color: WOOD[2], need: true }], score: plainWall });
  if (r.chance(0.7)) items.push(picture(r.pick(FABRIC), 1.2));
  return items;
}

function singleOffice(r: Rng): Item[] {
  const wood = r.pick(WOOD);
  return [
    {
      kind: 'desk', at: 'wall', w: 1.4, d: 0.7, h: 0.74, color: wood,
      kids: [{ kind: 'monitor', du: 0, dv: -0.1, w: 0.6, d: 0.05, h: 0.4, color: SCREEN, onTop: true }, seat(0.75, Math.PI)],
      // At the window.
      score: (c) => (c.edge?.kind === 'window' ? 2 : 0) + centred(c) * 0.2,
    },
    { kind: 'bookshelf', at: 'wall', widths: [1.6, 1.2, 0.9], w: 1.6, d: 0.35, h: 2.0, color: wood, front: 0.6, score: plainWall },
    { kind: 'chair', at: 'wall', w: 0.5, d: 0.5, h: 0.9, color: r.pick(FABRIC), use: 'sit', score: (c, f) => -f.cornerGap(c) },
    plant(1.2),
    picture(r.pick(FABRIC), 0.8),
  ];
}

function meeting(A: Area, r: Rng): Item[] {
  const o = minAreaRect(A.poly), long = 2 * Math.max(o.hu, o.hv), short = 2 * Math.min(o.hu, o.hv);
  const tw = Math.max(1.6, Math.min(3.2, long - 2.2)), td = short > 3.4 ? 1.2 : 0.9;
  const kids: Kid[] = [];
  const n = Math.max(1, Math.floor(tw / 0.8));
  for (let k = 0; k < n; k++) {
    const du = (k - (n - 1) / 2) * 0.8;
    for (const side of [1, -1]) kids.push({ kind: 'officeChair', du, dv: side * (td / 2 + 0.3), dyaw: side > 0 ? Math.PI : 0, w: 0.6, d: 0.6, h: 1.1, color: DARK, use: 'sit', need: k === 0 });
  }
  return [
    { kind: 'meetingTable', at: 'free', sym: true, w: tw, d: td, h: 0.75, color: WOOD[3], tag: 'table', kids, score: (c) => -Math.hypot(c.x - o.cx, c.z - o.cz) },
    // A narrow room: a small table with a chair at either end instead.
    {
      kind: 'meetingTable', at: 'free', sym: true, w: 1.4, d: 0.8, h: 0.75, color: WOOD[3], tag: 'table',
      kids: [1, -1].map((s2, i): Kid => ({ kind: 'officeChair', du: s2 * 1.05, dv: 0, dyaw: s2 * Math.PI / 2 * -1, w: 0.6, d: 0.6, h: 1.1, color: DARK, use: 'sit', need: i === 0 })),
      score: (c, f) => (f.get('table') ? -100 : 0) - Math.hypot(c.x - o.cx, c.z - o.cz) * 0.1, min: -50,
    },
    {
      // The screen on the wall at the table's end.
      kind: 'screen', at: 'wall', hung: true, w: 1.6, d: 0.06, h: 0.95, color: SCREEN,
      score: (c, f) => {
        const t = f.get('table');
        if (!t) return 0;
        const ax = Math.cos(t.yaw), az = -Math.sin(t.yaw), dx = c.x - t.x, dz = c.z - t.z;
        return Math.abs(dx * ax + dz * az) - Math.abs(dz * ax - dx * az) * 3;
      },
    },
    plant(1.3),
    ...(r.chance(0.6) ? [picture(r.pick(FABRIC))] : []),
  ];
}

function lobby(r: Rng): Item[] {
  const fab = r.pick(FABRIC);
  return [
    {
      // Facing the way in, a few steps from it, with a chair behind.
      kind: 'reception', at: 'free', w: 2.4, d: 0.8, h: 1.1, color: [0.25, 0.25, 0.27], use: 'stand', front: 1.0,
      kids: [seat(-0.85, 0)],
      score: (c, f) => f.facesDoor(c) * 3 - Math.abs(f.doorDist(c.x, c.z) - 3.5) * 0.6,
    },
    {
      kind: 'sofa', at: 'wall', w: 2.0, d: 0.9, h: 0.85, color: fab, use: 'sit',
      kids: [
        { kind: 'coffeeTable', du: 0, dv: 0.9, w: 1.1, d: 0.6, h: 0.42, color: WOOD[2], need: true },
        { kind: 'rug', du: 0, dv: 0.85, w: 2.6, d: 1.9, h: 0.01, color: r.pick(FABRIC), flat: true },
        { kind: 'armchair', du: 1.4, dv: 0.9, dyaw: -Math.PI / 2, w: 0.85, d: 0.85, h: 0.9, color: fab, use: 'sit' },
        { kind: 'armchair', du: -1.4, dv: 0.9, dyaw: Math.PI / 2, w: 0.85, d: 0.85, h: 0.9, color: fab, use: 'sit' },
      ],
      score: (c, f) => plainWall(c) + Math.min(f.doorDist(c.x, c.z), 5) * 0.3,
    },
    plant(1.6), plant(1.6), plant(1.4),
    picture(r.pick(FABRIC), 1.2), picture(r.pick(FABRIC), 1.2),
  ];
}

function teaKitchen(r: Rng): Item[] {
  return [
    { kind: 'kitchenRow', at: 'wall', widths: [3.0, 2.4, 1.8], w: 3.0, d: 0.62, h: 0.92, color: [0.92, 0.92, 0.9], tall: true, front: 0.9, score: plainWall },
    { kind: 'fridge', at: 'wall', w: 0.7, d: 0.68, h: 1.85, color: [0.9, 0.9, 0.9], front: 0.8, score: (c, f) => -f.cornerGap(c) },
    {
      kind: 'cafeTable', at: 'free', sym: true, w: 0.75, d: 0.75, h: 0.75, color: r.pick(WOOD),
      kids: [0, Math.PI].map((a, i): Kid => ({ kind: 'chair', du: 0, dv: (i ? -1 : 1) * 0.65, dyaw: a + Math.PI, w: 0.45, d: 0.45, h: 0.9, color: r.pick(WOOD), use: 'sit', need: i === 0 })),
    },
  ];
}

function toilet(): Item[] {
  return [
    { kind: 'toilet', at: 'wall', w: 0.4, d: 0.65, h: 0.75, color: WHITE_WARE, front: 0.55, score: (c, f) => -f.cornerGap(c) * 0.3 + Math.min(f.doorDist(c.x, c.z), 3) },
    { kind: 'sink', at: 'wall', w: 0.55, d: 0.45, h: 0.85, color: WHITE_WARE, front: 0.6, kids: [{ kind: 'mirror', du: 0, dv: -0.45 / 2 + 0.01, w: 0.6, d: 0.03, h: 0.8, color: [0.7, 0.78, 0.82], hung: true }], score: plainWall },
  ];
}

function officeStore(): Item[] {
  return many(4, { kind: 'shelf', at: 'wall', widths: [1.8, 0.9], w: 1.8, d: 0.45, h: 1.9, color: METAL, front: 0.6, score: (c, f) => -f.cornerGap(c) * 0.2 });
}

function stockRoom(r: Rng): Item[] {
  return [
    ...many(6, { kind: 'palletRack', at: 'wall', w: 1.3, d: 0.5, h: 2.4, color: [0.35, 0.4, 0.5], front: 0.8, score: (c, f) => -f.cornerGap(c) * 0.2 }),
    ...many(3, { kind: 'crate', at: 'free', w: 0.8, d: 0.6, h: 0.55, color: [0.6, 0.48, 0.3], score: () => r.float() }),
  ];
}

/** The checkout by the entrance: facing into the shop, near the door, the till on it. */
const checkout = (): Item => ({
  kind: 'counter', at: 'free', w: 1.8, d: 0.7, h: 1.0, color: WOOD[1], use: 'stand', front: 0.9,
  kids: [{ kind: 'monitor', du: 0.4, dv: -0.1, dyaw: Math.PI, w: 0.5, d: 0.3, h: 0.3, color: SCREEN, onTop: true }],
  score: (c, f) => -Math.abs(f.doorDist(c.x, c.z) - 2.4) - f.facesDoor(c) * 0.5,
});

function grocery(A: Area, r: Rng): Item[] {
  const along = alongRoom(A), area = roomArea(A);
  const fixture: C3 = r.pick([[0.86, 0.86, 0.84], [0.32, 0.33, 0.35], [0.62, 0.5, 0.36]]);
  const aisle: Item = {
    kind: 'shopShelf', at: 'free', w: 1.8, d: 0.55, h: 1.7, color: fixture, front: 0.9,
    kids: [{ kind: 'shopShelf', du: 0, dv: -0.56, dyaw: Math.PI, w: 1.8, d: 0.55, h: 1.7, color: fixture, front: 0.9, need: true }],
    score: (c, f) => (along(c) ? 2 : 0) + Math.min(f.doorDist(c.x, c.z), 4) * 0.3,
  };
  return [
    checkout(),
    ...many(Math.min(16, area / 9), aisle),
    ...many(Math.min(12, area / 12), { kind: 'shopShelf', at: 'wall', w: 1.8, d: 0.5, h: 2.1, color: fixture, front: 0.9, score: plainWall }),
    { kind: 'fridge', at: 'wall', w: 0.9, d: 0.7, h: 1.9, color: [0.85, 0.88, 0.9], front: 0.9, score: plainWall },
    plant(1.2),
  ];
}

function clothes(A: Area, r: Rng): Item[] {
  const area = roomArea(A);
  const fixture: C3 = r.pick([[0.86, 0.86, 0.84], [0.32, 0.33, 0.35], [0.62, 0.5, 0.36]]);
  return [
    // The full-length fitting mirror (E there changes your look): flat on a plain wall, room in front.
    // (Against a shop window too where there is no plain wall; else standing free.)
    { kind: 'tallMirror', at: 'wall', w: 0.7, d: 0.08, h: 1.85, color: [0.3, 0.21, 0.14], use: 'dress', front: 1.2, tall: false, tag: 'mirror', score: (c, f) => plainWall(c) * 3 + Math.min(f.doorDist(c.x, c.z), 4) * 0.4 },
    { kind: 'tallMirror', at: 'free', w: 0.7, d: 0.3, h: 1.85, color: [0.3, 0.21, 0.14], use: 'dress', front: 1.2, tag: 'mirror', score: (c, f) => (f.get('mirror') ? -100 : 0), min: -50 },
    checkout(),
    // Rails of clothes down the floor and along the walls, dummies in the window.
    ...many(Math.min(14, area / 6), { kind: 'clothesRail', at: 'free', sym: true, w: 1.6, d: 0.6, h: 1.5, color: r.pick(FABRIC), front: 0.7, score: (c, f) => Math.min(f.doorDist(c.x, c.z), 4) * 0.3 }),
    ...many(Math.min(8, area / 10), { kind: 'clothesRail', at: 'wall', w: 1.8, d: 0.55, h: 1.6, color: r.pick(FABRIC), front: 0.8, score: plainWall }),
    ...many(Math.min(2, area / 25), { kind: 'mannequin', at: 'free', sym: true, w: 0.55, d: 0.45, h: 1.85, color: r.pick(FABRIC), score: (c, f) => -Math.min(f.windowDist(c.x, c.z), 6) }),
    ...many(Math.min(3, area / 25), {
      kind: 'coffeeTable', at: 'free', sym: true, w: 1.4, d: 0.8, h: 0.8, color: r.pick(WOOD), front: 0.6,
      kids: [{ kind: 'clothesStack', du: 0, dv: 0, w: 1.2, d: 0.6, h: 0.8, color: r.pick(FABRIC), onTop: true }],
      score: (c, f) => Math.min(f.doorDist(c.x, c.z), 4) * 0.3,
    }),
    ...many(Math.min(6, area / 16), { kind: 'shopShelf', at: 'wall', w: 1.8, d: 0.5, h: 2.1, color: fixture, front: 0.9, score: plainWall }),
    plant(1.3), plant(1.1),
    picture([0.75, 0.8, 0.85], 0.7), picture(r.pick(FABRIC), 0.7),
  ];
}

function cafe(A: Area, r: Rng): Item[] {
  const area = roomArea(A), wood = r.pick(WOOD);
  const set: Item = {
    kind: 'cafeTable', at: 'free', sym: true, w: 0.75, d: 0.75, h: 0.75, color: WOOD[1],
    kids: [1, -1].map((s, i): Kid => ({ kind: 'chair', du: 0, dv: s * 0.65, dyaw: s > 0 ? Math.PI : 0, w: 0.45, d: 0.45, h: 0.9, color: WOOD[2], use: 'sit', need: i === 0 })),
    // By the windows, away from the counter.
    score: (c, f) => -Math.min(f.windowDist(c.x, c.z), 6) * 0.6 + (f.get('bar') ? Math.min(Math.hypot(c.x - f.get('bar')!.x, c.z - f.get('bar')!.z), 4) * 0.3 : 0),
  };
  return [
    // The counter against a plain wall at the back, away from the door.
    { kind: 'barCounter', at: 'wall', widths: [4.2, 3.4, 2.6], w: 4.2, d: 0.7, h: 1.1, color: wood, use: 'stand', front: 1.1, tag: 'bar', score: (c, f) => plainWall(c) * 2 + Math.min(f.doorDist(c.x, c.z), 6) * 0.5 },
    ...many(Math.min(18, area / 5), set),
    plant(1.4), plant(1.2),
    picture(r.pick(FABRIC), 0.8), picture(r.pick(FABRIC), 0.8),
  ];
}

function cafeKitchen(): Item[] {
  return [
    { kind: 'kitchenRow', at: 'wall', widths: [3.6, 3.0, 2.4, 1.8], w: 3.6, d: 0.62, h: 0.92, color: [0.75, 0.76, 0.78], tall: true, front: 0.9, score: plainWall },
    { kind: 'kitchenRow', at: 'wall', widths: [2.4, 1.8], w: 2.4, d: 0.62, h: 0.92, color: [0.75, 0.76, 0.78], tall: true, front: 0.9, score: plainWall },
    { kind: 'fridge', at: 'wall', w: 0.8, d: 0.7, h: 1.9, color: [0.82, 0.83, 0.85], front: 0.8, score: (c, f) => -f.cornerGap(c) },
    { kind: 'shelf', at: 'wall', w: 0.9, d: 0.45, h: 1.8, color: METAL, front: 0.6 },
  ];
}
