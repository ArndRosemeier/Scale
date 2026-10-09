/**
 * The splitter: cuts a storey of any shape into rooms, walls and doors. The theme speaks first:
 * its program reserves the big spaces (a shop's sales floor, an open-plan office, a lobby behind
 * the street door) before anything else is divided, so big halls stay possible. Only the floor
 * left over is cut into rooms: oddly shaped leftovers are first cut at their inner corners into
 * roughly rectangular parts, deep parts get a corridor down the middle, and each strip is sliced
 * into the program's rooms in turn.
 *
 * Walls stand wherever two spaces meet. Doors are chosen so that every room can be reached from
 * the way in (the stair hall, the lift lobby or a reserved hall), through halls and corridors
 * where possible and never through a bathroom or a bedroom unless there is no other way.
 *
 * Callers: InteriorGen.planFloor (themes in fill/home, fill/work).
 */
import { minAreaRect, polyArea, pointInPoly, rectangularity, polyBounds, cleanPoly, ensureCCW, type Poly } from '../../core/geom2';
import { differencePos, intersectionPos, unionPos, offset, shapesToPolys } from '../../core/clip';
import type { Rng } from '../../core/rng';
import type { RoomType, IWall } from '../InteriorGen';

/** A space of the storey: a room, a corridor or a reserved hall. */
export interface Space {
  type: RoomType;
  poly: Poly;
  /** Circulation (corridors, halls, lobbies, open floors): other rooms open onto it. */
  hub?: boolean;
  /** Given by the caller (the stair hall, the lift lobby): never merged or reshaped. */
  fixed?: boolean;
  /** A leftover that could not join a neighbour: kept as a room of its own (a closet). */
  odd?: boolean;
}

/** A big space the theme claims before the rest is divided. */
export interface Reserve {
  type: RoomType;
  /**
   * Where: 'front' a band along the street front, 'back' one along the far side, 'all' the whole
   * floor left (an open hall).
   */
  at: 'front' | 'back' | 'all';
  /** Depth of the band (m), or its share of the floor's depth. */
  depth?: number; share?: number;
  /** Leftover depth below which the band takes everything (no slivers behind it). */
  minLeft?: number;
  /** On deep floors leave no more than this depth (m) behind the band, for one row of rooms. */
  leave?: number;
  /** Rooms may open onto it (default true). */
  hub?: boolean;
}

export interface Program {
  reserve: Reserve[];
  /**
   * Rooms the floor left over is cut into, taken in turn (from a random start), with their length
   * range along the strip; `max` rooms of a kind per storey at most (one toilet in a shop).
   */
  rooms: { type: RoomType; len: [number, number]; max?: number }[];
  /** Corridor width where a part is deep enough for rooms on both sides (0: never). */
  corridor: number;
  corridorType?: RoomType;
  /** Rooms one should not have to walk through (bathrooms, bedrooms). */
  leaf?: RoomType[];
}

export interface Storey {
  poly: Poly;
  /** Spaces already there (stair hall, lift lobby): kept as they are, rooms open onto them. */
  fixed: Space[];
  /** Inward normal of the street front (the way the building faces is minus this), or null. */
  front: [number, number] | null;
  /** Walls already standing (the stair core's, the lift shaft's): no second wall and no door where they are. */
  solid?: { ax: number; az: number; bx: number; bz: number }[];
}

export interface Split { spaces: Space[]; walls: IWall[] }

// Positive fill on counter-clockwise rings throughout: rings that touch themselves keep their
// holes out.
const ccw = (ps: Poly[]) => ps.map((p) => (polyArea(p) < 0 ? ensureCCW(p.slice()) : p));
const difference = (a: Poly[], b: Poly[]) => differencePos(ccw(a), ccw(b));
const intersection = (a: Poly[], b: Poly[]) => intersectionPos(ccw(a), ccw(b));
const union = (a: Poly[]) => unionPos(ccw(a));

/** Smallest room: area (m²) and narrowest side (m). */
const MIN_AREA = 2.5, MIN_SIDE = 1.2;
/** Door width, and how far from a wall's end it starts. */
const DOOR = 0.9, DOOR_END = 0.35;

export function splitStorey(S: Storey, P: Program, r: Rng): Split {
  const spaces: Space[] = S.fixed.map((f) => ({ ...f, hub: f.hub ?? true, fixed: true }));
  // Fixed spaces that overlap (a lift lobby reaching over the stair hall): the earlier one keeps it.
  for (let j = 1; j < spaces.length; j++) {
    const before = spaces.slice(0, j).map((f) => f.poly);
    if (!before.some((f) => overlapsBox(f, spaces[j].poly))) continue;
    const q = shapesOf(difference([spaces[j].poly], before)).sort((a, b) => polyArea(b) - polyArea(a))[0];
    if (q) spaces[j] = { ...spaces[j], poly: q };
  }
  const nf = spaces.length, fixedPolys = () => spaces.slice(0, nf).map((f) => f.poly);
  // A stair hall standing free inside the floor reaches out to the nearest facade: no room or
  // hall has to wrap round it.
  for (let it = 0; it < 3; it++) {
    const holes = difference([S.poly], fixedPolys()).flatMap((w) => w.holes);
    if (!holes.length) break;
    for (const h of holes) {
      const [hx, hz] = centroidOf(h);
      let k = spaces.findIndex((f, i) => i < nf && pointInPoly(f.poly, hx, hz));
      if (k < 0) k = 0;
      const strip = reachOut(h, S.poly);
      if (!strip) continue;
      const others = spaces.slice(0, nf).filter((_, i) => i !== k).map((f) => f.poly);
      const add = others.length ? shapesOf(difference([strip], others)) : [strip];
      const u = union([spaces[k].poly, ...add]).filter((q) => polyArea(q.outer) > 0.5).sort((a, b) => polyArea(b.outer) - polyArea(a.outer))[0];
      if (u) spaces[k] = { ...spaces[k], poly: u.outer };
    }
  }
  // Without slivers thinner than 15 cm (between the stairs and the facade): they would leave
  // rooms touching themselves round the stairs.
  const opened = offset(shapesToPolys(difference([S.poly], fixedPolys())), -0.075);
  const whole = difference([S.poly], fixedPolys());
  let free = shapesOf(intersection(shapesToPolys(offset(shapesToPolys(opened), 0.075)).filter((p) => polyArea(p) > 0), whole.map((w) => w.outer)).flatMap((q) => difference([q.outer], whole.flatMap((w) => w.holes))));
  // 1. The theme's reservations.
  for (const R of P.reserve) {
    if (!free.length) break;
    const band = R.at === 'all' ? null : bandOf(free, S, R);
    const got = band ? shapesOf(intersection(free, [band])) : free;
    for (const q of got) if (Math.abs(polyArea(q)) > MIN_AREA) spaces.push({ type: R.type, poly: q, hub: R.hub ?? true });
    free = band ? shapesOf(difference(free, [band])) : [];
  }
  // 2. The rest, cut into rooms.
  const leaf = new Set(P.leaf ?? []);
  let k = r.int(0, Math.max(1, P.rooms.length));
  const count = new Map<RoomType, number>();
  for (const piece of free) {
    for (const part of rectParts(piece, 3)) {
      if (Math.abs(polyArea(part)) < MIN_AREA || !P.rooms.length) { spaces.push({ type: P.rooms[0]?.type ?? 'storage', poly: part }); continue; }
      const o = frameOf(part);
      const strips: [number, number][] = [];
      if (P.corridor > 0 && 2 * o.hv >= 2 * 3.2 + P.corridor) {
        const c = P.corridor / 2;
        const cq = shapesOf(intersection([part], [o.rect(-o.hu - 1, -c, o.hu + 1, c)]));
        for (const q of cq) spaces.push({ type: P.corridorType ?? 'corridor', poly: q, hub: true });
        strips.push([-o.hv - 1, -c], [c, o.hv + 1]);
      } else strips.push([-o.hv - 1, o.hv + 1]);
      for (const [v0, v1] of strips) {
        let u = -o.hu;
        while (u < o.hu - 0.3) {
          let want = P.rooms[k % P.rooms.length];
          for (let t = 0; t < P.rooms.length && want.max !== undefined && (count.get(want.type) ?? 0) >= want.max; t++) want = P.rooms[++k % P.rooms.length];
          count.set(want.type, (count.get(want.type) ?? 0) + 1);
          let u1 = Math.min(o.hu, u + r.range(want.len[0], want.len[1]));
          // A sliver too narrow for a room of its own goes to this one.
          if (o.hu - u1 < 2.4) u1 = o.hu;
          for (const q of shapesOf(intersection([part], [o.rect(u === -o.hu ? u - 1 : u, v0, u1 === o.hu ? u1 + 1 : u1, v1)]))) spaces.push({ type: want.type, poly: q });
          u = u1;
          k++;
        }
      }
    }
  }
  // 3. Straight walls without extra corners (the filler stands furniture along whole edges);
  // rooms too small or too oddly cut to use join a neighbour. No room may reach into the stair
  // hall or the lift lobby (a guarantee, whatever the cutting did).
  clearOfFixed(spaces, S.fixed.length);
  for (const sp of spaces) if (!sp.fixed) sp.poly = straight(sp.poly);
  mergeSmall(spaces);
  clearOfFixed(spaces, S.fixed.length);
  // 4. Walls where spaces meet, doors so that everything can be reached.
  return { spaces, walls: wallsAndDoors(spaces, leaf, mergeSmall, S.solid ?? []) };
}

/** The band of a reservation, as a big quad in the front's frame. */
function bandOf(free: Poly[], S: Storey, R: Reserve): Poly {
  // Depth axis: inward from the street front (else the floor's short axis).
  let nx: number, nz: number;
  if (S.front) [nx, nz] = S.front;
  else { const o = minAreaRect(S.poly); const long = o.hu >= o.hv; nx = long ? -o.uz : o.ux; nz = long ? o.ux : o.uz; }
  const ux = -nz, uz = nx;
  let d0 = Infinity, d1 = -Infinity, s0 = Infinity, s1 = -Infinity;
  for (const p of free) for (let i = 0; i < p.length; i += 2) {
    const d = p[i] * nx + p[i + 1] * nz, s = p[i] * ux + p[i + 1] * uz;
    d0 = Math.min(d0, d); d1 = Math.max(d1, d); s0 = Math.min(s0, s); s1 = Math.max(s1, s);
  }
  const span = d1 - d0;
  let depth = R.depth ?? (R.share ?? 0.5) * span;
  if (R.leave !== undefined) depth = Math.max(depth, span - R.leave);
  if (span - depth < (R.minLeft ?? 0)) depth = span;
  let a = d0 - 1, b = d0 + depth;
  if (R.at === 'back') { a = d1 - depth; b = d1 + 1; }
  if (depth >= span) { a = d0 - 1; b = d1 + 1; }
  const P = (s: number, d: number) => [ux * s + nx * d, uz * s + nz * d];
  return [...P(s0 - 1, a), ...P(s1 + 1, a), ...P(s1 + 1, b), ...P(s0 - 1, b)];
}

/** Outer rings of shapes worth keeping; a ring with holes is cut through them first. */
function shapesOf(shapes: { outer: Poly; holes: Poly[] }[]): Poly[] {
  const out: Poly[] = [];
  for (const s of shapes) {
    // (Clipper's outer rings wind positive; a negative one is a hole it split off a keyhole.)
    if (polyArea(s.outer) < 0.5) continue;
    if (!s.holes.length) { for (const q of loops(s.outer)) out.push(q); continue; }
    // Cut across the first hole along the shape's short axis: the hole becomes two notches.
    const h = s.holes[0], [x0, z0, x1, z1] = polyBounds(h), cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const o = minAreaRect(s.outer), long = o.hu >= o.hv, ux = long ? o.ux : -o.uz, uz = long ? o.uz : o.ux;
    const big = 1000, half = (sg: number) => [cx - uz * big, cz + ux * big, cx + uz * big, cz - ux * big, cx + uz * big + ux * big * sg, cz - ux * big + uz * big * sg, cx - uz * big + ux * big * sg, cz + ux * big + uz * big * sg];
    for (const sg of [1, -1]) {
      const side = intersection([s.outer], [half(sg)]).map((q) => q.outer);
      out.push(...shapesOf(difference(side, s.holes)));
    }
  }
  return out;
}

/**
 * A ring that touches itself (Clipper keeps a hole joined to the outline at a vertex: a room
 * wrapped round the stairs) split into simple rings; the ones wound backwards are holes, dropped.
 */
function loops(p: Poly): Poly[] {
  const n = p.length >> 1;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (Math.abs(p[i * 2] - p[j * 2]) > 0.01 || Math.abs(p[i * 2 + 1] - p[j * 2 + 1]) > 0.01) continue;
    const inner = p.slice(i * 2, j * 2), outer = [...p.slice(0, i * 2), ...p.slice(j * 2)];
    return [...loops(cleanPoly(inner, 1e-3)), ...loops(cleanPoly(outer, 1e-3))].filter((q) => q.length >= 6 && polyArea(q) > 0.5);
  }
  return [p];
}

/**
 * A piece cut into roughly rectangular parts: while it is far from a rectangle, cut it along a
 * line through one of its inner corners, the cut that leaves the most rectangular parts.
 */
function rectParts(p: Poly, depth: number): Poly[] {
  if (depth <= 0 || Math.abs(polyArea(p)) < 12 || rectangularity(p) > 0.85) return [p];
  const n = p.length >> 1, ccw = polyArea(p) > 0;
  let best: Poly[] | null = null, bestScore = rectangularity(p) + 0.05;
  for (let i = 0; i < n; i++) {
    const a = ((i + n - 1) % n) * 2, b = i * 2, c = ((i + 1) % n) * 2;
    const cr = (p[b] - p[a]) * (p[c + 1] - p[b + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[b]);
    if ((ccw ? cr : -cr) >= -1e-6) continue; // not an inner corner
    // Extend either wall that meets at the corner.
    for (const [qx, qz] of [[p[b] - p[a], p[b + 1] - p[a + 1]], [p[c] - p[b], p[c + 1] - p[b + 1]]]) {
      const l = Math.hypot(qx, qz);
      if (l < 1e-6) continue;
      const dx = qx / l, dz = qz / l, nx = -dz, nz = dx, big = 1000;
      const half = (sg: number) => {
        const ox = p[b], oz = p[b + 1];
        return [ox - dx * big, oz - dz * big, ox + dx * big, oz + dz * big, ox + dx * big + nx * big * sg, oz + dz * big + nz * big * sg, ox - dx * big + nx * big * sg, oz - dz * big + nz * big * sg];
      };
      const parts = [...shapesOf(intersection([p], [half(1)])), ...shapesOf(intersection([p], [half(-1)]))];
      if (parts.length < 2) continue;
      let tot = 0, sc = 0;
      for (const q of parts) { const A = Math.abs(polyArea(q)); tot += A; sc += A * rectangularity(q); if (thin(q) < 1.6) sc -= A; }
      if (sc / tot > bestScore) { bestScore = sc / tot; best = parts; }
    }
  }
  return best ? best.flatMap((q) => rectParts(q, depth - 1)) : [p];
}

/** Mean of a ring's corners. */
function centroidOf(p: Poly): [number, number] {
  let x = 0, z = 0;
  const n = p.length >> 1;
  for (let i = 0; i < n; i++) { x += p[i * 2]; z += p[i * 2 + 1]; }
  return [x / n, z / n];
}

/**
 * The floor between a hole (a stair hall inside the floor) and the nearest facade: a strip as wide
 * as the hole, out along one of its axes, the one that takes the least floor.
 */
function reachOut(h: Poly, outline: Poly): Poly | null {
  const o = minAreaRect(h);
  let best: Poly | null = null, ba = Infinity;
  for (const [dx, dz, half, side] of [[o.ux, o.uz, o.hu, o.hv], [-o.ux, -o.uz, o.hu, o.hv], [-o.uz, o.ux, o.hv, o.hu], [o.uz, -o.ux, o.hv, o.hu]]) {
    const px = -dz, pz = dx;
    const P = (t: number, s: number) => [o.cx + dx * t + px * s, o.cz + dz * t + pz * s];
    const R = [...P(half - 0.05, -side), ...P(half + 200, -side), ...P(half + 200, side), ...P(half - 0.05, side)];
    // The piece of the floor right next to the hole.
    const [mx, mz] = P(half + 0.03, 0);
    const piece = intersection([outline], [R]).map((q) => q.outer).find((q) => pointInPoly(q, mx, mz));
    if (!piece) continue;
    const a = polyArea(piece);
    if (a < ba) { ba = a; best = piece; }
  }
  return best;
}

/** Cuts the fixed spaces (the first nf) out of every other space; pieces split off become rooms of their own. */
function clearOfFixed(spaces: Space[], nf: number): void {
  const fixed = spaces.slice(0, nf).map((f) => f.poly);
  if (!fixed.length) return;
  for (let i = spaces.length - 1; i >= nf; i--) {
    const s = spaces[i];
    if (!fixed.some((f) => overlapsBox(f, s.poly))) continue;
    const parts = shapesOf(difference([s.poly], fixed)).sort((a, b) => polyArea(b) - polyArea(a));
    if (!parts.length) { spaces.splice(i, 1); continue; }
    if (Math.abs(polyArea(parts[0]) - Math.abs(polyArea(s.poly))) < 0.02) continue;
    spaces[i] = { ...s, poly: parts[0] };
    for (const q of parts.slice(1)) spaces.push({ type: s.type, poly: q });
  }
}

/** Do two polygons' bounding boxes overlap? */
function overlapsBox(a: Poly, b: Poly): boolean {
  const [ax0, az0, ax1, az1] = polyBounds(a), [bx0, bz0, bx1, bz1] = polyBounds(b);
  return ax0 < bx1 && bx0 < ax1 && az0 < bz1 && bz0 < az1;
}

/** A polygon without corners that are nearly straight (within 2 cm). */
function straight(p: Poly): Poly {
  const q = cleanPoly(p, 0.02);
  return q.length >= 6 ? q : p;
}

/** Narrowest side of a piece's bounding rectangle. */
function thin(p: Poly): number {
  const o = minAreaRect(p);
  return 2 * Math.min(o.hu, o.hv);
}

/** A piece's frame: long axis u, short axis v, and rectangles in it. */
function frameOf(p: Poly) {
  const o = minAreaRect(p);
  let ux = o.ux, uz = o.uz, hu = o.hu, hv = o.hv;
  if (hv > hu) { ux = -o.uz; uz = o.ux; [hu, hv] = [hv, hu]; }
  const P = (u: number, v: number) => [o.cx + ux * u - uz * v, o.cz + uz * u + ux * v];
  return { hu, hv, rect: (u0: number, v0: number, u1: number, v1: number): Poly => [...P(u0, v0), ...P(u1, v0), ...P(u1, v1), ...P(u0, v1)] };
}

/** Joins rooms that are too small or too narrow to use to the neighbour they share most wall with. */
function mergeSmall(spaces: Space[]): void {
  for (let guard = 0; guard < 40; guard++) {
    const i = spaces.findIndex((s) => !s.fixed && !s.hub && !s.odd && (Math.abs(polyArea(s.poly)) < MIN_AREA || thin(s.poly) < MIN_SIDE || (Math.abs(polyArea(s.poly)) < 10 && rectangularity(s.poly) < 0.6)));
    if (i < 0) return;
    // (Never dropped: that would leave a hole in the floor. A scrap too small for a closet goes
    // to the stair hall or lobby next to it.)
    if (!joinToNeighbour(spaces, i) && !(Math.abs(polyArea(spaces[i].poly)) < MIN_AREA && joinToNeighbour(spaces, i, undefined, true))) spaces[i] = { ...spaces[i], type: 'storage', odd: true };
  }
}

/** Merges space i into the neighbour it shares the longest boundary with (a fixed one only with intoFixed); false if it has none. */
function joinToNeighbour(spaces: Space[], i: number, notThrough?: Set<number>, intoFixed = false): boolean {
  let best = -1, bl = 0.05;
  for (let j = 0; j < spaces.length; j++) {
    if (j === i || !!spaces[j].fixed !== intoFixed || notThrough?.has(j)) continue;
    const l = shared(spaces[i].poly, spaces[j].poly, 0.05).reduce((a, s) => a + s.len, 0);
    if (l > bl) { bl = l; best = j; }
  }
  if (best < 0) return false;
  const u = union([spaces[best].poly, spaces[i].poly]).filter((s) => Math.abs(polyArea(s.outer)) > 0.5);
  // One piece without a hole (a room wrapped round the stairs would cover them).
  if (u.length !== 1 || u[0].holes.length) return false;
  spaces[best] = { ...spaces[best], poly: straight(u[0].outer) };
  spaces.splice(i, 1);
  return true;
}

interface Seg { ax: number; az: number; bx: number; bz: number; len: number }

/** Stretches of boundary two polygons share (collinear edges within 3 cm, overlapping more than 30 cm). */
export function shared(a: Poly, b: Poly, min = 0.3): Seg[] {
  // Both counter-clockwise: a stretch they share runs opposite ways in the two (one on either
  // side of it); running the same way, both lie on the same side (a facade they both touch).
  a = ensureCCW(a); b = ensureCCW(b);
  const out: Seg[] = [];
  const na = a.length >> 1, nb = b.length >> 1;
  for (let i = 0; i < na; i++) {
    const i2 = (i + 1) % na, ax = a[i * 2], az = a[i * 2 + 1], ex = a[i2 * 2] - ax, ez = a[i2 * 2 + 1] - az, L = Math.hypot(ex, ez);
    if (L < 0.3) continue;
    const ux = ex / L, uz = ez / L;
    for (let j = 0; j < nb; j++) {
      const j2 = (j + 1) % nb, bx = b[j * 2], bz = b[j * 2 + 1], cx = b[j2 * 2], cz = b[j2 * 2 + 1];
      if ((cx - bx) * ux + (cz - bz) * uz >= 0) continue;
      // Both ends of b's edge on a's edge line.
      if (Math.abs((bx - ax) * uz - (bz - az) * ux) > 0.03 || Math.abs((cx - ax) * uz - (cz - az) * ux) > 0.03) continue;
      const s0 = (bx - ax) * ux + (bz - az) * uz, s1 = (cx - ax) * ux + (cz - az) * uz;
      const lo = Math.max(0, Math.min(s0, s1)), hi = Math.min(L, Math.max(s0, s1));
      if (hi - lo < min) continue;
      out.push({ ax: ax + ux * lo, az: az + uz * lo, bx: ax + ux * hi, bz: az + uz * hi, len: hi - lo });
    }
  }
  return out;
}

/**
 * The walls between the spaces and their doors: a spanning tree from the way in (the first hub)
 * that goes through halls and corridors first and through rooms one shouldn't walk through only
 * when nothing else reaches. A room no door can reach joins a neighbour.
 */
function wallsAndDoors(spaces: Space[], leaf: Set<RoomType>, tidy: (s: Space[]) => void, solid: NonNullable<Storey['solid']>): IWall[] {
  for (let guard = 0; guard < 20; guard++) {
    const n = spaces.length;
    // Shared stretches per pair (less what standing walls already close); a stretch takes a door
    // when it is long enough.
    const segs = new Map<number, Seg[]>();
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const s = shared(spaces[i].poly, spaces[j].poly).flatMap((q) => open(q, solid));
      if (s.length) segs.set(i * n + j, s);
    }
    const pair = (i: number, j: number) => segs.get(Math.min(i, j) * n + Math.max(i, j)) ?? [];
    // A door only where a step through it leads from the one space into the other (a stretch can
    // border a void the outline leaves, such as the stairwell, on one side).
    const through = (s: Seg, i: number, j: number) => {
      const [t0, t1] = doorSpan(s, spaces[i], spaces[j]), t = (t0 + t1) / 2;
      const x = s.ax + (s.bx - s.ax) * t, z = s.az + (s.bz - s.az) * t, nx = -(s.bz - s.az) / s.len, nz = (s.bx - s.ax) / s.len;
      const a = spaceAt(spaces, x + nx * 0.3, z + nz * 0.3), b = spaceAt(spaces, x - nx * 0.3, z - nz * 0.3);
      return (a === i && b === j) || (a === j && b === i);
    };
    const best = new Map<number, Seg | null>();
    const doorSeg = (i: number, j: number) => {
      const k = Math.min(i, j) * n + Math.max(i, j);
      if (!best.has(k)) best.set(k, pair(i, j).filter((s) => s.len >= DOOR + 0.3).sort((p, q) => q.len - p.len).find((s) => through(s, Math.min(i, j), Math.max(i, j))) ?? null);
      return best.get(k) ?? undefined;
    };
    // Prim from the way in.
    let root = spaces.findIndex((s) => s.fixed && s.hub);
    if (root < 0) root = spaces.findIndex((s) => s.hub);
    if (root < 0) root = spaces.reduce((m, s, i) => (Math.abs(polyArea(s.poly)) > Math.abs(polyArea(spaces[m].poly)) ? i : m), 0);
    const inTree = new Uint8Array(n);
    inTree[root] = 1;
    const doors: [number, number][] = [];
    for (;;) {
      let bi = -1, bj = -1, bc = Infinity;
      for (let i = 0; i < n; i++) {
        if (!inTree[i]) continue;
        for (let j = 0; j < n; j++) {
          if (inTree[j]) continue;
          const s = doorSeg(i, j);
          // (Nobody walks through a closet to the rooms beyond.)
          if (!s || spaces[i].odd) continue;
          const c = (spaces[i].hub ? 0 : leaf.has(spaces[i].type) ? 10 : 1) - Math.min(s.len, 3) * 0.01;
          if (c < bc) { bc = c; bi = i; bj = j; }
        }
      }
      if (bi < 0) {
        // A hall no door reaches (the street door leads into it) starts a tree of its own.
        const h = spaces.findIndex((s, i) => !inTree[i] && s.hub);
        if (h < 0) break;
        inTree[h] = 1;
        continue;
      }
      inTree[bj] = 1;
      doors.push([bi, bj]);
    }
    const lost = spaces.findIndex((s, i) => !inTree[i] && !s.fixed && !s.odd);
    if (lost >= 0) {
      // Join the room to a neighbour (one in reach first), then plan again.
      const out = new Set<number>();
      for (let j = 0; j < n; j++) if (!inTree[j]) out.add(j);
      if (!joinToNeighbour(spaces, lost, out) && !joinToNeighbour(spaces, lost)) spaces[lost] = { ...spaces[lost], type: 'storage', odd: true };
      tidy(spaces);
      continue;
    }
    const isDoor = new Set(doors.map(([i, j]) => Math.min(i, j) * n + Math.max(i, j)));
    const walls: IWall[] = [];
    for (const [key, list] of segs) {
      const i = Math.floor(key / n), j = key % n;
      const d = isDoor.has(key) ? doorSeg(i, j) : null;
      for (const s of list) {
        const w: IWall = { ax: s.ax, az: s.az, bx: s.bx, bz: s.bz, doors: [] };
        if (s === d) w.doors.push(doorSpan(s, spaces[i], spaces[j]));
        walls.push(w);
      }
    }
    return walls;
  }
  return [];
}

/** The parts of a stretch no standing wall runs along (within 12 cm), 30 cm or longer. */
function open(s: Seg, solid: NonNullable<Storey['solid']>): Seg[] {
  const ux = (s.bx - s.ax) / s.len, uz = (s.bz - s.az) / s.len;
  const cov: [number, number][] = [];
  for (const w of solid) {
    if (Math.abs((w.ax - s.ax) * uz - (w.az - s.az) * ux) > 0.12 || Math.abs((w.bx - s.ax) * uz - (w.bz - s.az) * ux) > 0.12) continue;
    const a = (w.ax - s.ax) * ux + (w.az - s.az) * uz, b = (w.bx - s.ax) * ux + (w.bz - s.az) * uz;
    cov.push([Math.min(a, b), Math.max(a, b)]);
  }
  if (!cov.length) return [s];
  cov.sort((p, q) => p[0] - q[0]);
  const out: Seg[] = [];
  let t = 0;
  const part = (a: number, b: number) => { if (b - a >= 0.3) out.push({ ax: s.ax + ux * a, az: s.az + uz * a, bx: s.ax + ux * b, bz: s.az + uz * b, len: b - a }); };
  for (const [a, b] of cov) { if (a > t) part(t, Math.min(a, s.len)); t = Math.max(t, b); }
  if (t < s.len) part(t, s.len);
  return out;
}

/**
 * Where on a shared stretch the door goes, as [t0, t1] along it: between two halls in the middle
 * and wider; into a room near one end (the end nearer the hall's middle), so the room keeps its
 * walls for furniture.
 */
function doorSpan(s: Seg, a: Space, b: Space): [number, number] {
  const w = a.hub && b.hub ? Math.min(1.4, s.len - 0.4) : DOOR;
  if (a.hub && b.hub || s.len < w + 2 * DOOR_END + 0.6) { const m = 0.5, h = w / 2 / s.len; return [m - h, m + h]; }
  const hub = a.hub ? a : b.hub ? b : a;
  const [x0, z0, x1, z1] = polyBounds(hub.poly), cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const nearA = Math.hypot(s.ax - cx, s.az - cz) <= Math.hypot(s.bx - cx, s.bz - cz);
  const t0 = nearA ? DOOR_END / s.len : 1 - (DOOR_END + w) / s.len;
  return [t0, t0 + w / s.len];
}

/** The space a point is in (for tests and callers). */
export function spaceAt(spaces: Space[], x: number, z: number): number {
  return spaces.findIndex((s) => pointInPoly(s.poly, x, z));
}
