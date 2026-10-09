/**
 * One storey of a design divided and furnished by the interior core: the caller gives the outline
 * (local u, v), what it already reserved (fixed spaces, holes), the program and the theme's items;
 * the splitter (fill/split) cuts the rooms and their walls and doors, the filler (fill/place)
 * furnishes each room. The result goes into the design as walls, rooms (with their furniture and
 * the way out through their door) and a light per room.
 */
import type { Rng } from '../../core/rng';
import { Rng as R } from '../../core/rng';
import { pointInPoly, type Poly } from '../../core/geom2';
import { splitStorey, type Program, type Space, type Split } from '../fill/split';
import { roomArea, type Area, type EdgeKind } from '../fill/area';
import { Filler, type Item } from '../fill/place';
import type { RoomType } from '../InteriorGen';
import type { Design, P2, RoomFn } from './types';

export interface StoreyBrief {
  outline: Poly;
  fixed: Space[];
  holes?: Poly[];
  /** Inward normal of the front (where the way in is), or null. */
  front: [number, number] | null;
  program: Program;
  items: (type: RoomType, A: Area, r: Rng) => Item[];
  /** Floor top and the walls' top. */
  y: number;
  top: number;
  seed: number;
  /** What the outline's edges are (default: blind walls). */
  facade?: (ax: number, az: number, bx: number, bz: number) => EdgeKind;
  /** Walk grid cell for the filler (big plain rooms can do with a coarser one). */
  cell?: number;
  wallTh?: number;
}

/** Divides and furnishes the storey into D; returns the split (spaces with the fixed ones first). */
export function fillStorey(D: Design, b: StoreyBrief): Split {
  let seed = b.seed;
  const r = new R(seed++);
  const split = splitStorey({ poly: b.outline, fixed: b.fixed, front: b.front, holes: b.holes }, b.program, r);
  for (const w of split.walls) D.walls.push({ a: [w.ax, w.az], b: [w.bx, w.bz], y0: b.y, y1: b.top, th: b.wallTh ?? 0.2, kind: 'wall', doors: w.doors });
  const facade = b.facade ?? (() => 'blind' as EdgeKind);
  for (const sp of split.spaces) {
    if (sp.fixed) continue;
    const A = roomArea(sp.poly, split.walls, b.outline, facade, []);
    const furniture = new Filler(A, r, b.cell).fill(b.items(sp.type, A, r));
    const poly: P2[] = [];
    for (let k = 0; k < sp.poly.length; k += 2) poly.push([sp.poly[k], sp.poly[k + 1]]);
    const mid = mean(poly);
    const { door, facing } = doorOf(sp.poly, split.walls, mid);
    D.rooms.push({ fn: sp.type as RoomFn, poly, y: b.y, h: b.top - b.y, door, facing, seed: seed++, furniture });
    D.lights.push([mid[0], mid[1], b.top - 0.25]);
  }
  return split;
}

const mean = (p: P2[]): P2 => [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];

/** A room's door (the middle of the first door in its walls) and the way out through it. */
function doorOf(p: Poly, walls: Split['walls'], mid: P2): { door: P2; facing: P2 } {
  for (const w of walls) for (const [t0, t1] of w.doors) {
    const t = (t0 + t1) / 2, x = w.ax + (w.bx - w.ax) * t, z = w.az + (w.bz - w.az) * t;
    const L = Math.hypot(w.bx - w.ax, w.bz - w.az), nx = -(w.bz - w.az) / L, nz = (w.bx - w.ax) / L;
    const a = pointInPoly(p, x + nx * 0.3, z + nz * 0.3), c = pointInPoly(p, x - nx * 0.3, z - nz * 0.3);
    if (a !== c) return { door: [x, z], facing: a ? [-nx, -nz] : [nx, nz] };
  }
  return { door: mid, facing: [1, 0] };
}
