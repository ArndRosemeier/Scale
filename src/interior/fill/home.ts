/**
 * Theme: homes. What a living room, bedroom, kitchen, bathroom and hallway hold and how the pieces
 * belong together, as filler items (fill/place) in order of importance. The filler finds the
 * spots; this file only says what makes a spot good:
 *
 *  - living room: the sofa against a wall with room in front of it, away from the door, with the
 *    coffee table, rug, a lamp and an armchair round it; the TV across from the sofa, facing it;
 *    shelves, plants and pictures where they still fit; a dining table in a big room.
 *  - bedroom: the bed's head against a plain wall (not under a window), away from the door, with
 *    nightstands either side and a picture over it; the wardrobe with room to open it; a desk
 *    under the window.
 *  - kitchen: the counter row along a wall without windows (it has wall cabinets), the fridge at
 *    one of its ends, the table with chairs in the free floor.
 *  - bathroom: the tub in a corner, toilet and basin (mirror over it) along the walls.
 *  - hall: a coat rack by the door.
 */
import type { Rng } from '../../core/rng';
import type { Item, Cand, Filler, Kid } from './place';
import type { Area } from './area';
import { minAreaRect } from '../../core/geom2';
import { FABRIC, WOOD, LEAF, WHITE_WARE, type C3 } from './palette';
import type { Program } from './split';

/**
 * How a home storey is divided (fill/split): nothing reserved beyond the stairs; deep parts get a
 * corridor (the entrance hall on the ground floor) with rooms on both sides, each with its own
 * door; the rooms come in turn: living room, bedroom, kitchen, bathroom, bedroom.
 */
export function homeProgram(ground: boolean): Program {
  return {
    reserve: [],
    rooms: [{ type: 'living', len: [4.5, 6.5] }, { type: 'bedroom', len: [3.4, 4.5] }, { type: 'kitchen', len: [3, 4] }, { type: 'bath', len: [2.2, 3] }, { type: 'bedroom', len: [3.4, 4.5] }],
    corridor: 1.6, corridorType: ground ? 'hall' : 'corridor',
    leaf: ['bath', 'bedroom'],
  };
}

export type HomeRoom = 'living' | 'bedroom' | 'kitchen' | 'bath' | 'hall' | 'corridor';

/** The items for a room of a home (empty for anything else). */
export function homeItems(type: HomeRoom, A: Area, r: Rng): Item[] {
  switch (type) {
    case 'living': return living(A, r);
    case 'bedroom': return bedroom(A, r);
    case 'kitchen': return kitchen(A, r);
    case 'bath': return bath();
    case 'hall': case 'corridor': return hall(A);
  }
}

const plainWall = (c: Cand) => (c.edge && c.edge.kind !== 'window' ? 1 : 0);
const centred = (c: Cand) => (c.edge ? -Math.abs(c.s - c.edge.len / 2) : 0);
const plant = (h: number): Item => ({ kind: 'plant', at: 'wall', w: 0.5, d: 0.5, h, color: LEAF, score: (c, f) => -f.cornerGap(c) * 1.5 });
const picture = (fab: C3): Item => ({ kind: 'painting', at: 'wall', hung: true, w: 0.9, d: 0.04, h: 0.6, color: fab, score: centred });

function living(A: Area, r: Rng): Item[] {
  const o = minAreaRect(A.poly), short = 2 * Math.min(o.hu, o.hv), area = 4 * o.hu * o.hv;
  const fabric = r.pick(FABRIC), wood = r.pick(WOOD);
  const sw = Math.min(2.2, Math.max(1.6, short * 0.55)), sd = 0.9;
  const kids: Kid[] = [
    { kind: 'coffeeTable', du: 0, dv: sd / 2 + 0.75, w: 1.1, d: 0.6, h: 0.42, color: wood, need: true },
    { kind: 'rug', du: 0, dv: sd / 2 + 0.65, w: Math.min(2.6, sw + 0.4), d: 1.8, h: 0.01, color: r.pick(FABRIC), flat: true },
    { kind: 'floorLamp', du: (sw / 2 + 0.3) * r.sign(), dv: -sd / 2 + 0.2, w: 0.35, d: 0.35, h: 1.6, color: [0.9, 0.85, 0.7], tall: false },
    { kind: 'painting', du: 0, dv: -sd / 2 + 0.01, w: 0.9, d: 0.04, h: 0.6, color: r.pick(FABRIC), hung: true },
  ];
  // An armchair to one side of the coffee table, turned towards it.
  if (short > 3.4) { const s = r.sign(); kids.push({ kind: 'armchair', du: s * (0.55 + 0.75), dv: sd / 2 + 0.75, dyaw: -s * Math.PI / 2, w: 0.85, d: 0.85, h: 0.9, color: r.pick(FABRIC), use: 'sit' }); }
  const items: Item[] = [
    {
      kind: 'sofa', at: 'wall', w: sw, d: sd, h: 0.85, color: fabric, use: 'sit', tag: 'sofa', kids,
      // Room in front for the table and a TV across, away from the door, a plain wall behind.
      score: (c, f) => {
        const a = f.across(c, sd, 1.7);
        return (a.dist < 2.4 ? -10 : Math.min(a.dist, 4.5) * 0.6) + (a.free ? 2 : 0) + Math.min(f.doorDist(c.x, c.z), 4) * 0.5 + plainWall(c) * 0.6 + centred(c) * 0.25;
      },
    },
    {
      kind: 'tvStand', at: 'wall', w: 1.6, d: 0.45, h: 0.5, color: wood, tag: 'tv',
      kids: [{ kind: 'tv', du: 0, dv: 0, w: 1.2, d: 0.08, h: 0.7, color: [0.05, 0.05, 0.06], onTop: true }],
      score: (c, f) => f.faces(c, 'sofa', 3) * 6, min: 1.5,
    },
    { kind: 'bookshelf', at: 'wall', w: Math.min(1.8, short * 0.45), d: 0.35, h: 2.0, color: wood, front: 0.5, score: (c, f) => Math.min(f.doorDist(c.x, c.z), 3) * 0.3 - f.faces(c, 'sofa', 3) * 4 },
  ];
  if (area > 24) items.push(diningSet(r.pick(WOOD), r, 'free'));
  items.push(plant(1.3));
  if (r.chance(0.6)) items.push(plant(1.0));
  if (r.chance(0.7)) items.push(picture(r.pick(FABRIC)));
  return items;
}

function bedroom(A: Area, r: Rng): Item[] {
  const o = minAreaRect(A.poly), short = 2 * Math.min(o.hu, o.hv);
  const dbl = short > 3.2 && r.chance(0.7), wood = r.pick(WOOD);
  const bw = dbl ? 1.6 : 0.95, bd = 2.05;
  const kids: Kid[] = [
    { kind: 'nightstand', du: bw / 2 + 0.27, dv: -bd / 2 + 0.2, w: 0.45, d: 0.4, h: 0.55, color: wood },
    { kind: 'painting', du: 0, dv: -bd / 2 + 0.01, w: 0.8, d: 0.04, h: 0.55, color: r.pick(FABRIC), hung: true },
    { kind: 'rug', du: 0, dv: bd / 2 - 0.1, w: bw + 0.9, d: 1.3, h: 0.01, color: r.pick(FABRIC), flat: true },
  ];
  if (dbl) kids.push({ kind: 'nightstand', du: -(bw / 2 + 0.27), dv: -bd / 2 + 0.2, w: 0.45, d: 0.4, h: 0.55, color: wood });
  const items: Item[] = [
    {
      kind: dbl ? 'bedDouble' : 'bed', at: 'wall', w: bw, d: bd, h: 0.55, color: r.pick(FABRIC), use: 'sleep', front: 0.6, kids,
      // Head against a plain wall, away from the door, centred on it with room at the foot.
      score: (c, f) => plainWall(c) * 2.5 + Math.min(f.doorDist(c.x, c.z), 4) * 0.4 + centred(c) * 0.4 + (f.ahead(c, bd) < 0.9 ? -6 : 0),
    },
    { kind: 'wardrobe', at: 'wall', widths: [2.0, 1.6, 1.2], w: 2.0, d: 0.6, h: 2.1, color: wood, front: 0.7, score: (c, f) => -f.cornerGap(c) * 0.4 },
  ];
  if (r.chance(0.6)) {
    items.push({
      kind: 'desk', at: 'wall', w: 1.1, d: 0.6, h: 0.74, color: wood,
      kids: [{ kind: 'chair', du: 0, dv: 0.6 / 2 + 0.3, dyaw: Math.PI, w: 0.45, d: 0.45, h: 0.9, color: wood, use: 'sit', need: true }],
      // At the window, if there is one.
      score: (c) => (c.edge?.kind === 'window' ? 2 : 0),
    });
  }
  if (r.chance(0.5)) items.push(plant(1.1));
  return items;
}

function kitchen(A: Area, r: Rng): Item[] {
  const o = minAreaRect(A.poly), short = 2 * Math.min(o.hu, o.hv);
  const wood = r.pick(WOOD);
  return [
    { kind: 'kitchenRow', at: 'wall', widths: [3.6, 3.0, 2.4, 1.8], w: 3.6, d: 0.62, h: 0.92, color: [0.92, 0.92, 0.9], tall: true, front: 0.9, tag: 'row', score: (c) => plainWall(c) * 0.5 },
    {
      kind: 'fridge', at: 'wall', w: 0.7, d: 0.68, h: 1.85, color: [0.9, 0.9, 0.9], front: 0.8,
      // At one end of the counter row, on the same wall.
      score: (c, f) => {
        const t = f.get('row');
        if (!t) return 0;
        const ux = Math.cos(t.yaw), uz = -Math.sin(t.yaw);
        const side = Math.abs((c.x - t.x) * Math.sin(t.yaw) + (c.z - t.z) * Math.cos(t.yaw));
        const gap = Math.abs((c.x - t.x) * ux + (c.z - t.z) * uz) - (t.w / 2 + c.w / 2);
        return side < 0.1 ? 3 - Math.abs(gap) * 3 : -1;
      },
    },
    ...(short > 2.4 ? [diningSet(wood, r, 'free')] : []),
  ];
}

function bath(): Item[] {
  return [
    { kind: 'bathtub', at: 'wall', widths: [1.7, 1.5], w: 1.7, d: 0.75, h: 0.55, color: WHITE_WARE, front: 0.5, score: (c, f) => -f.cornerGap(c) * 2 },
    { kind: 'toilet', at: 'wall', w: 0.4, d: 0.65, h: 0.75, color: WHITE_WARE, front: 0.55, score: (c, f) => -f.cornerGap(c) * 0.3 },
    {
      kind: 'sink', at: 'wall', w: 0.55, d: 0.45, h: 0.85, color: WHITE_WARE, front: 0.6,
      kids: [{ kind: 'mirror', du: 0, dv: -0.45 / 2 + 0.01, w: 0.6, d: 0.03, h: 0.8, color: [0.7, 0.78, 0.82], hung: true }],
      score: plainWall,
    },
  ];
}

function hall(A: Area): Item[] {
  const o = minAreaRect(A.poly);
  if (2 * Math.min(o.hu, o.hv) < 1.4) return [];
  return [{ kind: 'coatRack', at: 'wall', w: 0.4, d: 0.4, h: 1.8, color: [0.25, 0.2, 0.16], tall: false, score: (c, f) => -f.doorDist(c.x, c.z), min: -3 }];
}

/** A dining table with chairs on its long sides (two needed, two more where they fit). */
function diningSet(wood: C3, r: Rng, at: 'free'): Item {
  const tw = 1.4, td = 0.85;
  const chair = (du: number, side: number, need: boolean): Kid => ({ kind: 'chair', du, dv: side * (td / 2 + 0.28), dyaw: side > 0 ? Math.PI : 0, w: 0.45, d: 0.45, h: 0.9, color: wood, use: 'sit', need });
  return {
    kind: 'diningTable', at, sym: true, w: tw, d: td, h: 0.75, color: wood, tag: 'table',
    kids: [chair(-0.4, 1, true), chair(-0.4, -1, true), chair(0.4, 1, false), chair(0.4, -1, false)],
    // In the open, away from the sofa and the counter, with room for the chairs.
    score: (c, f) => {
      const s = f.get('sofa') ?? f.get('row');
      return (s ? Math.min(Math.hypot(c.x - s.x, c.z - s.z), 4) * 0.5 : 0) + r.float() * 0.1;
    },
  };
}
