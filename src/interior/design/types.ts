/**
 * The interior designer's data (docs: /interiors proposal): a design is plain geometry in a
 * frame's local (u, v) with absolute heights, made in three steps that know nothing about the
 * building they work for:
 *
 *  1. Volume  – what the outline is at a height (a star-shaped section round a centre, so round,
 *               oval, polygonal and tapering bodies all work, not only four-sided boxes).
 *  2. Section – the vertical plan first: tall halls, a void through several levels, the levels
 *               round it (design/section).
 *  3. Layout  – each level divided and furnished by the interior core (fill/split, fill/place)
 *               with a theme (fill/starship), so the same section can be a starship or an office.
 *
 * design/emit turns a design into landmark parts (plan/landmarkParts Kit).
 */

import type { Furn } from '../InteriorGen';

export type P2 = [number, number];

/**
 * A level's outline as a star round a centre: `at(θ, r)` is the point at angle parameter θ and
 * radius r (an ellipse scales u and v; a polygon walks the ray), `edge(θ)` the outline's radius
 * there. Radial lines (θ fixed) are straight, so walls between rooms are plain segments.
 */
export interface Star {
  at(theta: number, r: number): P2;
  edge(theta: number): number;
}

/** A body that has an outline at every height between y0 and y1. */
export interface Volume {
  y0: number;
  y1: number;
  /** Inside outline (the inner face of the outer wall) at height y. */
  section(y: number): Star;
}

/** What a room is for: the theme furnishes it accordingly. */
export type RoomFn = 'quarters' | 'lab' | 'mess' | 'lounge' | 'storage' | 'control' | 'stairs' | 'lobby' | 'hall' | 'gallery'
  | 'exhibit' | 'shop' | 'cafe' | 'corridor' | 'office' | 'garden' | 'checkin' | 'security' | 'gates';

/** A flat floor plate (four corners, counter-clockwise from above), its top at y. */
export interface DFloor { q: [P2, P2, P2, P2]; y: number; th: number; fn: RoomFn }

/** A straight wall from a to b; doors are [t0, t1] spans along it left open. */
export interface DWall { a: P2; b: P2; y0: number; y1: number; th: number; kind: 'wall' | 'glass' | 'rail'; doors: [number, number][] }

/** A room: its outline, floor height and clear height, what it is for, where its door is (facing: the way out) and its furniture (fill/place, x/z = u/v). */
export interface DRoom { fn: RoomFn; poly: P2[]; y: number; h: number; door: P2; facing: P2; seed: number; furniture: Furn[] }

/** A straight flight of steps from `from` along `dir` (unit), climbing y0 → y1. */
export interface DStair { from: P2; dir: P2; width: number; tread: number; y0: number; y1: number; n: number }

export interface Design {
  floors: DFloor[];
  walls: DWall[];
  rooms: DRoom[];
  stairs: DStair[];
  /** Ceiling lights (u, v, y). */
  lights: [number, number, number][];
}

export const emptyDesign = (): Design => ({ floors: [], walls: [], rooms: [], stairs: [], lights: [] });

/** An ellipse section centred at (cu, cv): radius r along u, r·sz along v. */
export function ellipseStar(cu: number, cv: number, r: number, sz: number): Star {
  return {
    at: (t, rr) => [cu + Math.cos(t) * rr, cv + Math.sin(t) * rr * sz],
    edge: () => r,
  };
}
