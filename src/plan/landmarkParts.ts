/**
 * Landmark structures as lists of primitive parts (pure data): boxes, cylinders and cones,
 * domes, gable and pyramid roofs, sloped stands, beams, tubes, barrel vaults and flat surfaces,
 * each with a facade material (atlas layer, tint, window grammar).
 *
 * One description serves everything: the mesh (build/landmarks.ts, two LODs: parts flagged
 * `detail` are left out far away), collision (`partObstacles`: the solid parts become the
 * walker's boxes and cylinders), the map (`partFootprints`) and the cell planner (ground holes,
 * props kept off the structure). It is a pure function of the landmark (and the terrain under
 * walls that follow the ground), so workers and the main thread agree.
 *
 * Local frame: u = (cos angle, sin angle), v = (-sin, cos), origin at the site centre, the
 * front (entrance, square) towards -v. Heights are absolute (y up); `lm.base` is the floor level.
 */
import { Rng, deriveSeed } from '../core/rng';
import type { Poly } from '../core/geom2';
import type { Terrain } from '../world/terrain';
import type { Landmark } from './landmarks';
import { marvel } from './marvelParts';
import { cathedral } from './cathedralParts';
import { museum } from './museumParts';

export const enum PK { Box = 0, Cyl = 1, Dome = 2, Gable = 3, Pyramid = 4, Ramp = 5, Beam = 6, Tube = 7, Vault = 8, Flat = 9, Quad = 10, Lathe = 11, Prism = 12, Perf = 13, Helix = 14, Strut = 15 }

/** Surface material: facade atlas layer (walls 0–15, roofs 16–23), tint, facade flags and window grammar. */
export interface PartMat { layer: number; tint: [number, number, number]; flags: number; bay: number; fh: number; gh: number }

export interface LmPart {
  k: PK;
  /** Centre (Beam: start point) and the axis angle of the part (its u = (cos a, sin a)). */
  x: number;
  z: number;
  a: number;
  /** Half sizes along u and v. Ramp: hx at the front (low) edge, hx2 at the back (high) edge. Vault: hz = radius across. Dome: radii. */
  hx: number;
  hz: number;
  hx2?: number;
  /** Bottom and top. Ramp: front edge top yLo, back edge top y1. Dome: y1 = apex (below y0: hanging). Tube: y0/y1 = centre ∓ radius. */
  y0: number;
  y1: number;
  yLo?: number;
  /** Cylinder bottom / top radius (cone: r2 = 0). Tube: radius at -u / +u. Pyramid: r2 = top scale (0 = apex). */
  r?: number;
  r2?: number;
  /** Segments around (cylinders, domes, tubes, vaults). */
  seg?: number;
  /** Ramp: seat rows (stepped top in the near LOD). */
  rows?: number;
  /** Beam end and half thickness. */
  bx?: number;
  by?: number;
  bz?: number;
  w?: number;
  /** Quad: corners (x, y, z) × 4. Ramp: ground corners (x, z) × 4 — front left, front right, back right, back left. */
  q?: number[];
  m: PartMat;
  /** Material of top surfaces and roof slopes (default: m without openings). */
  top?: PartMat;
  /** Ramp: material of the back face (the outer facade of a stand). */
  back?: PartMat;
  /** Collision solid. */
  solid?: boolean;
  /** Close-range detail (left out of the far LOD and the map). */
  detail?: boolean;
  /** Foundation from this height up to y0 (walls standing on uneven ground). */
  foot?: number;
  /** Map category: 0 none, 1 building, 2 paving, 3 lawn / pitch, 4 running track, 5 road. */
  map?: number;
  /** Ramp: no end faces (segments of a ring). Lathe: no caps (a band of a longer body, a balustrade). */
  noSides?: boolean;
  /** Collision only (a simple volume standing in for an open structure): not drawn. */
  hidden?: boolean;
  /** Counts as solid ground cover for the planner and the map (a hollow building's outline) without being a solid. */
  footprint?: boolean;
  /**
   * Lathe: profile (r, y) pairs, bottom to top (closed when the last pair repeats the first: a
   * ring), radii scaled by hx along u and hz along v. Prism: outline (u, y) pairs in the part's
   * frame (u along its axis), extruded ±hz across. Perf: holes (u, y, radius) through the slab
   * along v.
   */
  pts?: number[];
  /** Helix: turns (the sign is the sense of rotation, + counter-clockwise from above). */
  turns?: number;
  /** Helix: clear height of the walkway. */
  hh?: number;
  /** Clear glass: drawn by the transparent glass mesh, not the facade one. */
  clear?: boolean;
  /** A floor to walk on however thin (PartObstacle.deck). */
  deck?: boolean;
  /** Vault, dome, cylinder: seen from inside (the faces turned inward, no end caps). */
  inward?: boolean;
  /** Dome or cylinder: only the half on the part's +v side (an apse's half dome or roof). */
  half?: boolean;
  /**
   * Inward dome as pendentives: the sphere through the corners of the square ±hx × ±hz (from y0
   * there) cut by the square's sides, up to the ring of radius r it reaches at y1.
   */
  pend?: boolean;
  /**
   * Window glass of a breakable landmark: diced into pieces of its own (beside the wall's in the
   * same grid cell) that break as easily as glass and hold nothing up. Its collision box (a
   * hidden solid) goes with them.
   */
  pane?: boolean;
  /**
   * Part of a walkable inside that the outside hides (a hall's galleries, rooms and furniture):
   * built into a mesh of its own (build/landmarks) that is only drawn close by.
   */
  inner?: boolean;
}

/** A walkable inside (the town hall's): its outline, height range and where its room lights hang. */
export interface LmRoom {
  /** Outline (world, CCW). */
  poly: Poly;
  y0: number;
  y1: number;
}

export interface LmInterior {
  rooms: LmRoom[];
  /** Light positions (x, y, z world). */
  lights: number[];
  /** Where people walk: a graph of points (x, y, z world) and their links (sim/LandmarkCrowds). */
  nav: number[];
  links: number[][];
  /** Ways out: a nav point at a door and the points on from it (x, y, z …) down to the square. */
  exits: { node: number; pts: number[] }[];
  /** Where people sit or stand, and who. */
  spots: LmSpot[];
}

/** Who uses a spot inside a landmark: visitors and the faithful, and the people who work there. */
export type SpotWho = 'visitor' | 'faithful' | 'priest' | 'server' | 'clerk' | 'client' | 'mayor' | 'aide' | 'councillor' | 'registrar' | 'couple' | 'guest' | 'porter';

/** A place to sit or stand inside a landmark (world), reached from a nav point over `via` (x, z pairs). */
export interface LmSpot {
  x: number; y: number; z: number;
  /** Facing (PedAgent.heading convention). */
  h: number;
  sit: boolean;
  who: SpotWho;
  node: number;
  via: number[];
  /** Where they look (x, y, z) while there: a window, the dome, a portrait. */
  look?: [number, number, number];
}

/** A solid for the walker (same shape as world/Collision's Obstacle). */
export interface PartObstacle {
  cyl: boolean;
  x: number; z: number;
  r: number;
  hx: number; hz: number;
  ux: number; uz: number;
  y0: number; y1: number;
  /** Broken away (breakable landmarks: world/LandmarkSolids). */
  dead?: boolean;
  /** Window glass (LmPart.pane): follows the glass pieces, not the wall's. */
  pane?: boolean;
  /** Walkable however thin (world/Collision: ground for any walker). */
  deck?: boolean;
}

// Facade flags (build/buildingShell FF): windows, curtain wall, arched, roof, front, stained glass.
export const WIN = 1, CURTAIN = 4, ARCH = 8, ROOF = 128, GLOW = 4096;
// Wall layers (plan/building WallMat) and roof layers (16 + RoofMat).
export const BRICK = 0, BRICK_BROWN = 1, LIME = 4, SAND = 5, PLASTER = 6, STUCCO = 7, CONC = 8, PANEL = 9, GLASS = 10, METAL = 11, GRANITE = 13, BRICK_WHITE = 15;
export const TAR = 16, CLAY = 17, SLATE = 18, ZINC = 19, ASPHALT = 20, METAL_ROOF = 21, GRAVEL = 22, GREEN_ROOF = 23;

export type RGB = [number, number, number];
export const mat = (layer: number, tint: RGB = [1, 1, 1], flags = 0, bay = 3, fh = 4, gh = 4.5): PartMat => ({ layer, tint, flags, bay, fh, gh });
export const WHITE: RGB = [1, 1, 1];
export const COPPER: RGB = [0.48, 0.72, 0.62];
export const GOLD: RGB = [1.25, 1.0, 0.45];
const BRONZE: RGB = [0.55, 0.42, 0.3];
/** Paint colours (team colours, wheels, liveries). */
const PAINT: RGB[] = [[0.85, 0.15, 0.12], [0.15, 0.3, 0.75], [0.95, 0.8, 0.15], [0.15, 0.6, 0.3], [0.95, 0.95, 0.95], [0.55, 0.15, 0.55], [0.95, 0.45, 0.1], [0.12, 0.12, 0.14]];
const STONES = [LIME, SAND, GRANITE, BRICK_WHITE];

export interface Opt {
  /** Turn relative to the current frame. */
  rot?: number;
  top?: PartMat;
  back?: PartMat;
  solid?: boolean;
  detail?: boolean;
  /** true: a foundation down to the site's lowest ground; a number: down to that height. */
  foot?: boolean | number;
  map?: number;
  seg?: number;
  /** Clear glass (see LmPart.clear). */
  clear?: boolean;
  /** Walkable however thin (LmPart.deck). */
  deck?: boolean;
}

/** Builds parts in a local frame (nested frames for sub-assemblies like planes). */
export class Kit {
  readonly parts: LmPart[] = [];
  readonly inside: LmInterior = { rooms: [], lights: [], nav: [], links: [], exits: [], spots: [] };
  private ox: number;
  private oz: number;
  private oa: number;
  /** Floor level and the foundation bottom. */
  readonly B: number;
  readonly F: number;

  constructor(readonly lm: Landmark, readonly T: Terrain) {
    this.ox = lm.x; this.oz = lm.z; this.oa = lm.angle;
    this.B = lm.base;
    this.F = lm.low - 0.4;
  }

  W(u: number, v: number): [number, number] {
    const c = Math.cos(this.oa), s = Math.sin(this.oa);
    return [this.ox + u * c - v * s, this.oz + u * s + v * c];
  }

  /** Natural ground at a local point. */
  ground(u: number, v: number): number {
    const [x, z] = this.W(u, v);
    return this.T.height(x, z);
  }

  /** Lowest ground under a local rectangle (for walls that follow the terrain). */
  groundMin(u: number, v: number, hu: number, hv: number, rot = 0): number {
    let m = Infinity;
    const c = Math.cos(rot), s = Math.sin(rot);
    for (const [a, b] of [[0, 0], [-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) m = Math.min(m, this.ground(u + a * hu * c - b * hv * s, v + a * hu * s + b * hv * c));
    return m;
  }

  groundMax(u: number, v: number, hu: number, hv: number, rot = 0): number {
    let m = -Infinity;
    const c = Math.cos(rot), s = Math.sin(rot);
    for (const [a, b] of [[0, 0], [-1, -1], [1, -1], [1, 1], [-1, 1]]) m = Math.max(m, this.ground(u + a * hu * c - b * hv * s, v + a * hu * s + b * hv * c));
    return m;
  }

  /** Run `fn` in a sub-frame at (u, v) turned by rot. */
  sub(u: number, v: number, rot: number, fn: () => void): void {
    const [x, z] = this.W(u, v);
    const s = [this.ox, this.oz, this.oa] as const;
    this.ox = x; this.oz = z; this.oa += rot;
    fn();
    [this.ox, this.oz, this.oa] = s;
  }

  private foot(o: Opt): number | undefined {
    return o.foot === true ? this.F : typeof o.foot === 'number' ? o.foot : undefined;
  }

  private add(k: PK, u: number, v: number, p: Partial<LmPart> & { hx: number; hz: number; y0: number; y1: number; m: PartMat }, o: Opt, solid: boolean, map: number): LmPart {
    const [x, z] = this.W(u, v);
    const part: LmPart = {
      k, x, z, a: this.oa + (o.rot ?? 0), ...p,
      top: o.top, back: o.back, solid: o.solid ?? (solid && !o.detail && !o.clear), detail: o.detail, foot: this.foot(o),
      map: o.map ?? (o.detail ? 0 : map), seg: o.seg ?? p.seg,
    };
    if (o.clear) part.clear = true;
    if (o.deck) part.deck = true;
    this.parts.push(part);
    return part;
  }

  box(u: number, v: number, hu: number, hv: number, y0: number, y1: number, m: PartMat, o: Opt = {}): LmPart {
    return this.add(PK.Box, u, v, { hx: hu, hz: hv, y0, y1, m }, o, true, 1);
  }

  cyl(u: number, v: number, r: number, r2: number, y0: number, y1: number, m: PartMat, o: Opt = {}): LmPart {
    return this.add(PK.Cyl, u, v, { hx: r, hz: r, r, r2, y0, y1, m, seg: 20 }, o, true, 1);
  }

  /** Half ellipsoid with radii (rx, rz), springing at y0, apex at y1 (below y0: hanging). */
  dome(u: number, v: number, rx: number, rz: number, y0: number, y1: number, m: PartMat, o: Opt = {}): LmPart {
    return this.add(PK.Dome, u, v, { hx: rx, hz: rz, y0, y1, m, seg: 20 }, o, false, 0);
  }

  /** Gable roof over a rectangle, ridge along the part's u (hu along it; with rot π/2 along the frame's v): eaves at y0, ridge at y1 (gable ends in m, slopes in top). */
  gable(u: number, v: number, hu: number, hv: number, y0: number, y1: number, m: PartMat, top: PartMat, o: Opt = {}): LmPart {
    return this.add(PK.Gable, u, v, { hx: hu, hz: hv, y0, y1, m }, { ...o, top }, false, 0);
  }

  /** Pyramid / spire / hipped roof: rectangle at y0 tapering to `t` of its size at y1. */
  pyramid(u: number, v: number, hu: number, hv: number, y0: number, y1: number, t: number, m: PartMat, o: Opt = {}): LmPart {
    return this.add(PK.Pyramid, u, v, { hx: hu, hz: hv, y0, y1, r2: t, m }, o, false, 0);
  }

  /** Sloped stand: front edge (-v) of half length hu at yLo, back edge (+v) of half length hu2 at y1. */
  ramp(u: number, v: number, hu: number, hu2: number, hv: number, y0: number, yLo: number, y1: number, rows: number, m: PartMat, o: Opt & { noSides?: boolean } = {}): LmPart {
    const p = this.add(PK.Ramp, u, v, { hx: hu, hx2: hu2, hz: hv, y0, yLo, y1, rows, m }, o, true, 1);
    p.noSides = o.noSides;
    return p;
  }

  /** Sloped stand on a quadrilateral (local corners: front left, front right, back right, back left). */
  rampQ(c: [number, number][], y0: number, yLo: number, y1: number, rows: number, m: PartMat, o: Opt & { noSides?: boolean } = {}): LmPart {
    const w = c.map(([u, v]) => this.W(u, v));
    const fx = (w[1][0] - w[0][0]), fz = (w[1][1] - w[0][1]);
    const cu = (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4, cv = (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4;
    const dm = Math.hypot((w[2][0] + w[3][0] - w[0][0] - w[1][0]) / 2, (w[2][1] + w[3][1] - w[0][1] - w[1][1]) / 2);
    const p = this.add(PK.Ramp, cu, cv, {
      hx: Math.hypot(fx, fz) / 2, hx2: Math.hypot(w[2][0] - w[3][0], w[2][1] - w[3][1]) / 2, hz: dm / 2, y0, yLo, y1, rows, m,
      q: w.flat(),
    }, { ...o, rot: Math.atan2(fz, fx) - this.oa }, true, 1);
    p.noSides = o.noSides;
    return p;
  }

  beam(u0: number, v0: number, y0: number, u1: number, v1: number, y1: number, w: number, m: PartMat, o: Opt = {}): LmPart {
    const [bx, bz] = this.W(u1, v1);
    return this.add(PK.Beam, u0, v0, { hx: 0, hz: 0, y0, y1: y0, bx, by: y1, bz, w, m }, o, false, 0);
  }

  /** Horizontal cylinder along u (centre height y, half length hu), radius r at -u and r2 at +u. */
  tube(u: number, v: number, y: number, hu: number, r: number, r2: number, m: PartMat, o: Opt = {}): LmPart {
    return this.add(PK.Tube, u, v, { hx: hu, hz: Math.max(r, r2), r, r2, y0: y - Math.max(r, r2), y1: y + Math.max(r, r2), m, seg: 14 }, o, false, 0);
  }

  /** Barrel vault along u over a strip 2 hv wide, springing at y0, crown at y1. */
  vault(u: number, v: number, hu: number, hv: number, y0: number, y1: number, m: PartMat, o: Opt = {}): LmPart {
    return this.add(PK.Vault, u, v, { hx: hu, hz: hv, y0, y1, m, seg: 14 }, o, true, 1);
  }

  /** Flat horizontal surface at height y (pavement, pitch, markings). */
  flat(u: number, v: number, hu: number, hv: number, y: number, m: PartMat, o: Opt = {}): LmPart {
    return this.add(PK.Flat, u, v, { hx: hu, hz: hv, y0: y, y1: y, m }, o, false, 2);
  }

  /** An invisible solid box (collision volume of an open structure: a wheel, a sphere). */
  solidBox(u: number, v: number, hu: number, hv: number, y0: number, y1: number, map = 0): void {
    const p = this.box(u, v, hu, hv, y0, y1, mat(CONC), { solid: true, map });
    p.hidden = true;
  }

  solidCyl(u: number, v: number, r: number, y0: number, y1: number): void {
    const p = this.cyl(u, v, r, r, y0, y1, mat(CONC), { solid: true, map: 0 });
    p.hidden = true;
  }

  /**
   * Surface of revolution about a vertical axis at (u, v): profile (r, y) pairs from bottom to top
   * (repeat the first pair at the end for a closed ring), radii scaled by sx along u and sz along v.
   */
  lathe(u: number, v: number, prof: number[], sx: number, sz: number, m: PartMat, o: Opt = {}): LmPart {
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 1; i < prof.length; i += 2) { y0 = Math.min(y0, prof[i]); y1 = Math.max(y1, prof[i]); }
    return this.add(PK.Lathe, u, v, { hx: sx, hz: sz, y0, y1, pts: prof.slice(), m, seg: 32 }, o, true, 1);
  }

  /** A slab in the vertical plane along u: outline (du, y) pairs around (u, v) (CCW), 2 hv thick. */
  prism(u: number, v: number, outline: number[], hv: number, m: PartMat, o: Opt = {}): LmPart {
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 1; i < outline.length; i += 2) { y0 = Math.min(y0, outline[i]); y1 = Math.max(y1, outline[i]); }
    return this.add(PK.Prism, u, v, { hx: 0, hz: hv, y0, y1, pts: outline.slice(), m }, o, true, 1);
  }

  /** A slab (2 hu × 2 hv, y0–y1) pierced along v by round holes (du, y, radius). */
  perf(u: number, v: number, hu: number, hv: number, y0: number, y1: number, holes: number[], m: PartMat, o: Opt = {}): LmPart {
    return this.add(PK.Perf, u, v, { hx: hu, hz: hv, y0, y1, pts: holes.slice(), m, seg: 24 }, o, true, 1);
  }

  /**
   * A walkway winding up around a vertical axis at (u, v) between radii r and r2: its floor rises
   * from yA to yB over `turns` turns (sign: sense), starting at angle a0 (local), hh high inside.
   * Two parts: the floor slabs and roof edge (m), and the clear glass walls and roof (glass).
   */
  helix(u: number, v: number, r: number, r2: number, yA: number, yB: number, turns: number, a0: number, hh: number, m: PartMat, glass: PartMat, o: Opt = {}): void {
    const p = { hx: r2, hz: r2, r, r2, y0: yA, y1: yB, turns, hh, m, seg: 48 };
    this.add(PK.Helix, u, v, p, { ...o, rot: a0 }, true, 1);
    this.add(PK.Helix, u, v, { ...p, m: glass }, { ...o, rot: a0, clear: true, solid: false, map: 0 }, false, 0);
  }

  /** A walkable room over the local rectangle (u0, v0)–(u1, v1), from y0 to y1. */
  room(u0: number, v0: number, u1: number, v1: number, y0: number, y1: number): void {
    this.inside.rooms.push({ poly: [...this.W(u0, v0), ...this.W(u1, v0), ...this.W(u1, v1), ...this.W(u0, v1)], y0, y1 });
  }

  /** Mark the parts `fn` adds as inside parts (LmPart.inner). */
  inner(fn: () => void): void {
    const n0 = this.parts.length;
    fn();
    for (let i = n0; i < this.parts.length; i++) this.parts[i].inner = true;
  }

  /** A walkable room of any outline (local points, CCW), from y0 to y1. */
  roomPoly(pts: [number, number][], y0: number, y1: number): void {
    this.inside.rooms.push({ poly: pts.flatMap(([u, v]) => this.W(u, v)), y0, y1 });
  }

  /** A nav point (sim/LandmarkCrowds) at a local point, standing height y; returns its index. */
  node(u: number, v: number, y: number): number {
    const [x, z] = this.W(u, v);
    this.inside.nav.push(x, y, z);
    this.inside.links.push([]);
    return this.inside.links.length - 1;
  }

  /** Nav links along a chain of points. */
  path(...ids: number[]): void {
    for (let i = 0; i + 1 < ids.length; i++) {
      const a = ids[i], b = ids[i + 1], L = this.inside.links;
      if (a === b || L[a].includes(b)) continue;
      L[a].push(b);
      L[b].push(a);
    }
  }

  /**
   * A spot to sit or stand at a local point, facing local +v turned by `rot` (as chairs), reached
   * from nav point `node` over local points `via`; `look` (local u, v, y) is where they look.
   */
  spot(u: number, v: number, y: number, rot: number, sit: boolean, who: SpotWho, node: number, via: [number, number][] = [], look?: [number, number, number]): void {
    const [x, z] = this.W(u, v);
    const vw: number[] = [];
    for (const [a, b] of via) vw.push(...this.W(a, b));
    const l = look ? this.W(look[0], look[1]) : null;
    this.inside.spots.push({ x, y, z, h: Math.PI - (this.oa + rot), sit, who, node, via: vw, look: l && look ? [l[0], look[2], l[1]] : undefined });
  }

  /** A way out from nav point `node` (at a door) over local points (u, v, y) to the ground at (u, v). */
  exit(node: number, way: [number, number, number][], u: number, v: number): void {
    const pts: number[] = [];
    for (const [a, b, y] of way) { const [x, z] = this.W(a, b); pts.push(x, y, z); }
    const [x, z] = this.W(u, v);
    pts.push(x, this.T.height(x, z), z);
    this.inside.exits.push({ node, pts });
  }

  /** A room light at a local point. */
  light(u: number, v: number, y: number): void {
    const [x, z] = this.W(u, v);
    this.inside.lights.push(x, y, z);
  }

  /** A round strut (cylinder of radius rad) between two local points at any slope. */
  strut(u0: number, v0: number, y0: number, u1: number, v1: number, y1: number, rad: number, m: PartMat, o: Opt = {}): LmPart {
    const [bx, bz] = this.W(u1, v1);
    return this.add(PK.Strut, u0, v0, { hx: 0, hz: 0, y0, y1: y0, bx, by: y1, bz, w: rad, m, seg: 10 }, o, false, 0);
  }

  /** Free quad (world corners, x y z × 4, counter-clockwise from above). */
  quad(q: number[], m: PartMat, o: Opt = {}): LmPart {
    const part: LmPart = { k: PK.Quad, x: (q[0] + q[6]) / 2, z: (q[2] + q[8]) / 2, a: 0, hx: 0, hz: 0, y0: Math.min(q[1], q[4], q[7], q[10]), y1: Math.max(q[1], q[4], q[7], q[10]), q, m, map: o.map ?? 5, detail: o.detail };
    this.parts.push(part);
    return part;
  }
}

// ---------------------------------------------------------------------- kinds

function townhall(k: Kit, lm: Landmark, r: Rng): void {
  const P = lm.p, B = k.B;
  const st = lm.style;
  const wallL = st === 0 ? STONES[P.wall % 4] : st === 1 ? [BRICK, SAND, BRICK_BROWN, LIME][P.wall % 4] : st === 2 ? [PLASTER, STUCCO, PLASTER, SAND][P.wall % 4] : [CONC, PANEL, CONC, LIME][P.wall % 4];
  const pastel: RGB = st === 2 ? r.pick<RGB>([[0.96, 0.88, 0.7], [0.92, 0.8, 0.72], [0.95, 0.93, 0.86], [0.85, 0.88, 0.8]]) : WHITE;
  const fh = 4.6, gh = 5.4, H = gh + (P.floors - 1) * fh;
  const flags = WIN | (st === 1 ? ARCH : 0);
  const wall = mat(wallL, pastel, flags, st === 3 ? 2.2 : 3.2, fh, gh);
  const plain = mat(wallL, [pastel[0] * 0.92, pastel[1] * 0.92, pastel[2] * 0.92]);
  const roofM = st === 1 ? mat(r.pick([SLATE, CLAY]), WHITE, ROOF) : st === 2 ? mat(SLATE, WHITE, ROOF) : mat(st === 3 ? GRAVEL : ZINC, WHITE, ROOF);
  const vb = lm.hv - 4 - P.d / 2;
  const hw = P.w / 2, hd = P.d / 2;
  const fv = vb - hd; // front facade line
  // The main block is a shell one can walk into: walls with the doorway in the middle of the
  // front, floors and rooms inside (townhallInterior), solid above the public storeys. The map,
  // the ground and the props still see one solid block (a footprint-only part).
  const sh = townhallShell(k, lm, st === 3 ? gh - 0.3 : gh + fh);
  const foot = k.box(0, vb, hw, hd, B, B + H, plain, { solid: false, map: 1 });
  foot.hidden = true;
  foot.footprint = true;
  if (st === 3) {
    // Modern: a glazed ground floor under a solid slab, the council chamber a drum beside it.
    sh.walls(B, B + gh, mat(GLASS, WHITE, WIN | CURTAIN, 1.6, gh, gh), plain);
    k.box(0, vb + 1.5, hw + 1, hd + 1.5, B + gh, B + H, mat(wallL, WHITE, WIN, 2.0, fh, fh), { top: mat(GRAVEL, WHITE, ROOF) });
  } else {
    sh.walls(B, B + H, wall, roofM);
  }
  if (st === 1) k.gable(0, vb, hw, hd, B + H, B + H + P.d * 0.55, plain, roofM);
  if (st === 2) k.pyramid(0, vb, hw + 0.3, hd + 0.3, B + H, B + H + 5, 0.75, roofM);
  if (st === 0 || st === 3) {
    // Balustrade / parapet.
    k.box(0, vb - hd + 0.3, hw, 0.3, B + H, B + H + 1.1, plain, { detail: true });
    k.box(0, vb + hd - 0.3, hw, 0.3, B + H, B + H + 1.1, plain, { detail: true });
    for (const s of [-1, 1]) k.box(s * (hw - 0.3), vb, 0.3, hd, B + H, B + H + 1.1, plain, { detail: true });
  }
  // Wings reaching forward around the square (a U).
  if (P.wings) {
    const ww = Math.min(12, P.w * 0.2), wv = vb - hd - P.wingD / 2;
    for (const s of [-1, 1]) {
      k.box(s * (hw - ww / 2), wv, ww / 2, P.wingD / 2 + 0.5, B, B + H - fh, wall, { foot: true, top: roofM });
      if (st === 1) k.gable(s * (hw - ww / 2), wv, P.wingD / 2 + 0.5, ww / 2, B + H - fh, B + H - fh + ww * 0.5, plain, roofM, { rot: Math.PI / 2 });
    }
  }
  // Portico (classical): columns, entablature and pediment.
  if (st === 0) {
    const n = r.pick([6, 6, 8]), pw = Math.min(P.w * 0.45, n * 3.6), cv = fv - 3.2;
    const colM = mat(wallL, WHITE);
    for (let i = 0; i < n; i++) k.cyl(-pw / 2 + (i + 0.5) * (pw / n), cv, 0.75, 0.65, B, B + H - 2.2, colM, { seg: 12 });
    k.box(0, cv + 0.6, pw / 2 + 0.8, 2.6, B + H - 2.2, B + H, plain, { solid: false });
    k.gable(0, cv + 0.6, 2.6, pw / 2 + 0.8, B + H, B + H + pw * 0.16, plain, roofM, { rot: Math.PI / 2, detail: false });
  }
  /** Where the entrance steps start (with a gateway tower: in front of the tower). */
  let stepV = fv;
  // Tower: clock tower (belfry, spire or cupola) or a dome on a drum.
  if (P.tower === 2) {
    const dr = Math.min(P.w, P.d) * 0.24;
    k.cyl(0, vb, dr, dr, B + H, B + H + 7, mat(wallL, pastel, WIN | ARCH, 2.4, 7, 7), { solid: false });
    k.dome(0, vb, dr + 0.4, dr + 0.4, B + H + 7, B + H + 7 + dr * 1.15, mat(r.pick([ZINC, SLATE, METAL_ROOF]), r.chance(0.5) ? COPPER : r.chance(0.5) ? GOLD : WHITE, ROOF));
    k.cyl(0, vb, 1.4, 1.4, B + H + 7 + dr * 1.1, B + H + 11 + dr * 1.1, mat(wallL, pastel), { solid: false, detail: true });
    k.dome(0, vb, 1.7, 1.7, B + H + 11 + dr * 1.1, B + H + 13 + dr * 1.1, mat(ZINC, COPPER, ROOF), { detail: true });
  } else if (P.tower === 1) {
    // (Modern: a campanile on the square beside the slab's end.)
    const ts = st === 3 ? 4.5 : r.range(4, 5.2), tv = st === 3 ? fv - 8 : fv + ts * 0.6, tu = st === 3 ? hw - 5 : 0;
    const th = B + Math.max(P.towerH, H + 14);
    const towerM = mat(wallL, pastel, WIN | (st === 1 ? ARCH : 0), ts, 6, gh);
    if (st === 3) k.box(tu, tv, ts, ts, B, th, towerM, { foot: true, top: roofM });
    else {
      // In the middle of the front: its base is the gateway to the door (a passage between two
      // piers); the part inside the block only starts at the roof.
      const f0 = tv - ts, dp = (fv - f0) / 2, dw = sh.doorW / 2;
      for (const s of [-1, 1]) k.box(s * (dw + (ts - dw) / 2), f0 + dp, (ts - dw) / 2, dp, B, B + sh.doorH, towerM, { foot: true });
      k.box(0, f0 + dp, ts, dp, B + sh.doorH, th, towerM, { top: roofM });
      k.box(0, (fv + tv + ts) / 2, ts, (tv + ts - fv) / 2, B + H - 0.05, th, towerM, { top: roofM });
      k.box(0, f0 + dp, dw, dp, B - 0.3, B, mat(GRANITE, [0.85, 0.85, 0.85]), { map: 0, foot: true });
      stepV = f0;
    }
    // Clock faces near the top.
    const cy = th - 4;
    for (const [du, dv, rot] of [[0, -ts - 0.12, 0], [0, ts + 0.12, 0], [-ts - 0.12, 0, Math.PI / 2], [ts + 0.12, 0, Math.PI / 2]] as const) {
      k.box(tu + du, tv + dv, 1.9, 0.12, cy - 1.9, cy + 1.9, mat(PLASTER, [1.15, 1.12, 1.02]), { rot, detail: true, solid: false });
      k.box(tu + du * 1.03, tv + dv * 1.03, 0.12, 0.06, cy - 0.1, cy + 1.5, mat(METAL, [0.1, 0.1, 0.1]), { rot, detail: true, solid: false });
    }
    if (st === 1) k.pyramid(tu, tv, ts + 0.3, ts + 0.3, th, th + ts * 3.2, 0, mat(r.pick([SLATE, ZINC]), r.chance(0.4) ? COPPER : WHITE, ROOF));
    else if (st === 2) {
      k.cyl(tu, tv, ts * 0.8, ts * 0.8, th, th + 4, mat(wallL, pastel, WIN | ARCH, 2, 4, 4), { solid: false });
      k.dome(tu, tv, ts * 0.85, ts * 0.85, th + 4, th + 4 + ts * 1.4, mat(ZINC, r.chance(0.6) ? COPPER : WHITE, ROOF));
      k.cyl(tu, tv, 0.25, 0.05, th + 4 + ts * 1.3, th + 9 + ts * 1.3, mat(METAL, GOLD), { detail: true, solid: false });
    } else k.box(tu, tv, ts + 0.4, ts + 0.4, th, th + 0.8, plain, { solid: false });
  }
  // Entrance steps across the middle (in front of the gateway when the tower stands there),
  // solid and as many as it takes from the square up to the floor (the block may stand on a
  // terrace well above the ground).
  const stepsFoot = entranceSteps(k, stepV, P.w * 0.18 + 1, B, mat(GRANITE, [0.85, 0.85, 0.85]));
  if (st === 3) k.cyl(-hw + 10, fv - 12, 9, 9, B, B + 9, mat(GLASS, WHITE, WIN | CURTAIN, 1.8, 9, 9), { foot: true, top: mat(METAL_ROOF, WHITE, ROOF) });
  // Flagpoles in front.
  const flagC = r.pick(PAINT);
  for (const s of [-1, 0, 1]) {
    const u = s * P.w * 0.22, v = fv - 9;
    k.cyl(u, v, 0.12, 0.08, B - 0.1, B + 12, mat(METAL, [0.85, 0.85, 0.85]), { detail: true, solid: false, seg: 6 });
    k.box(u + 1.3, v, 1.2, 0.03, B + 10.2, B + 11.8, mat(PLASTER, s === 0 ? WHITE : flagC), { detail: true, solid: false });
  }
  const door = townhallInterior(k, lm, sh, flagC, pastel);
  k.exit(door, [[0, sh.iv0 - 0.7, B], [0, stepV, B]], 0, stepsFoot);
}

// ------------------------------------------------------------ town hall: shell and interior

/** A wall opening: centre along the wall, width, bottom and top. */
export interface Opening { a: number; w: number; y0: number; y1: number }

/**
 * A straight wall from a0 to a1 along u (axis 'u', at v = c) or along v (axis 'v', at u = c),
 * thickness th, between y0 and y1, with openings: full-height pieces between them, a sill
 * below and a lintel above each.
 */
/**
 * Solid entrance steps running out from v = stepV (towards -v) down from the floor at B to the
 * ground: 17 cm each, steeper (up to 30 cm) where the ground lies far below, at most 24.
 */
export function entranceSteps(k: Kit, stepV: number, hw: number, B: number, m: PartMat): number {
  const tread = 0.36, drop = (n: number) => B - k.ground(0, stepV - n * tread);
  let n = 3;
  while (n < 24 && drop(n) / n > 0.17) n++;
  const rise = Math.max(0.17, Math.min(0.3, drop(n) / n));
  for (let i = 0; i < n; i++) k.box(0, stepV - tread / 2 - i * tread, hw + i * 0.05, tread / 2, k.F, B - i * rise, m, { solid: true, map: 2 });
  // (Where the steps meet the square.)
  return stepV - n * tread - 0.6;
}

export function wallRun(k: Kit, axis: 'u' | 'v', c: number, a0: number, a1: number, y0: number, y1: number, th: number, m: PartMat, open: Opening[], o: Opt = {}): void {
  // (Lintels over openings stand on the wall beside them: no foundation filling the opening.)
  const lintel: Opt = { ...o, foot: undefined };
  const put = (s0: number, s1: number, b: number, t: number) => {
    if (s1 - s0 < 0.02 || t - b < 0.02) return;
    const mid = (s0 + s1) / 2, h = (s1 - s0) / 2, oo = b > y0 + 0.01 ? lintel : o;
    if (axis === 'u') k.box(mid, c, h, th / 2, b, t, m, oo);
    else k.box(c, mid, th / 2, h, b, t, m, oo);
  };
  // Openings may stack (a door under a rose): each strip between their edges is filled round
  // the ones that cover it, bottom to top.
  const edges = [...new Set([a0, a1, ...open.flatMap((op) => [op.a - op.w / 2, op.a + op.w / 2])])].filter((e) => e >= a0 && e <= a1).sort((p, q) => p - q);
  for (let i = 0; i + 1 < edges.length; i++) {
    const l = edges[i], r = edges[i + 1], m = (l + r) / 2;
    let b = y0;
    const over = open.filter((q) => Math.abs(m - q.a) < q.w / 2).sort((p, q) => p.y0 - q.y0);
    // (A doorway's threshold: the wall's foundation, up to the floor, so there is no pit under it.)
    if (o.foot !== undefined && over.length && over[0].y0 <= y0 + 0.01) put(l, r, y0 - 0.3, y0);
    for (const op of over) {
      put(l, r, b, op.y0);
      b = Math.max(b, op.y1);
    }
    put(l, r, b, y1);
  }
}

interface Shell {
  /** Inner extents (local): u in ±iu, v from iv0 (front) to iv1 (back). */
  iu: number; iv0: number; iv1: number;
  /** Ceiling of the public storeys (above it the block is solid). */
  ceil: number;
  doorW: number; doorH: number;
  /** The outer walls (and the solid block above the ceiling) from y0 to y1. */
  walls(y0: number, y1: number, m: PartMat, top: PartMat): void;
}

function townhallShell(k: Kit, lm: Landmark, ceilH: number): Shell {
  const P = lm.p, B = k.B, t = 0.6;
  const hw = P.w / 2, hd = P.d / 2, vb = lm.hv - 4 - P.d / 2, fv = vb - hd, bv = vb + hd;
  const doorW = 4.4, doorH = 4.4;
  const sh: Shell = {
    iu: hw - t, iv0: fv + t, iv1: bv - t, ceil: B + ceilH, doorW, doorH,
    walls(y0, y1, m, top) {
      const o: Opt = { foot: true, top, map: 0 };
      wallRun(k, 'u', fv + t / 2, -hw, hw, y0, y1, t, m, [{ a: 0, w: doorW, y0, y1: y0 + doorH }], o);
      wallRun(k, 'u', bv - t / 2, -hw, hw, y0, y1, t, m, [], o);
      for (const s of [-1, 1]) wallRun(k, 'v', s * (hw - t / 2), fv + t, bv - t, y0, y1, t, m, [], o);
      // Above the public storeys: solid up to the roof (its underside is the ceiling).
      if (y1 > sh.ceil + 0.05) k.box(0, (sh.iv0 + sh.iv1) / 2, sh.iu - 0.01, (sh.iv1 - sh.iv0) / 2 - 0.01, sh.ceil, y1, mat(PLASTER, [1.02, 1, 0.95]), { top, map: 0 });
    },
  };
  return sh;
}

/** Interior palette per style (0 classical, 1 gothic, 2 baroque, 3 modern). */
function hallPalette(st: number, pastel: RGB) {
  const warm: RGB = st === 2 ? [pastel[0] * 1.05, pastel[1] * 1.05, pastel[2] * 1.05] : st === 1 ? [0.96, 0.9, 0.8] : st === 3 ? [1.02, 1.02, 1.02] : [1.06, 1.0, 0.88];
  return {
    wall: mat(st === 1 ? LIME : st === 3 ? PLASTER : STUCCO, warm),
    stone: mat(st === 1 ? SAND : LIME, [1.12, 1.1, 1.04]),
    floorA: mat(st === 3 ? CONC : st === 1 ? SAND : LIME, st === 3 ? [1.05, 1.05, 1.05] : [1.18, 1.16, 1.1]),
    floorB: mat(st === 1 ? BRICK_BROWN : GRANITE, st === 1 ? [0.8, 0.6, 0.5] : st === 2 ? [0.78, 0.48, 0.45] : [0.42, 0.42, 0.46]),
    wood: mat(PLASTER, st === 3 ? [0.72, 0.55, 0.38] : [0.42, 0.26, 0.15]),
    dark: mat(PLASTER, st === 3 ? [0.2, 0.2, 0.22] : [0.25, 0.14, 0.08]),
    red: mat(PLASTER, st === 3 ? [0.15, 0.3, 0.5] : [0.52, 0.07, 0.08]),
    gold: mat(METAL, GOLD),
    ceil: mat(PLASTER, [1.02, 1, 0.95]),
    // (Daylight through the panes: glass reads black indoors, where the sky reflection is dimmed.)
    glass: mat(PLASTER, [1.2, 1.35, 1.55]),
    leaf: mat(PLASTER, [0.2, 0.42, 0.18]),
    pot: mat(BRICK, [0.8, 0.55, 0.4]),
    screen: mat(PLASTER, [0.25, 0.75, 1.6]),
    cloth: mat(PLASTER, [1.15, 1.13, 1.08]),
  };
}
type Palette = ReturnType<typeof hallPalette>;

export const D: Opt = { detail: true };
export const DS: Opt = { detail: true, solid: true };

/** Furnishes the town hall's inside; returns the nav point inside its door (sim/LandmarkCrowds). */
function townhallInterior(k: Kit, lm: Landmark, sh: Shell, flagC: RGB, pastel: RGB): number {
  const r = new Rng(deriveSeed(lm.seed, 'interior'));
  const st = lm.style, B = k.B;
  const C = hallPalette(st, pastel);
  const { iu, iv0, iv1, ceil } = sh;
  const dw = sh.doorW / 2;
  const grand = st !== 3 && iu >= 12.5 && iv1 - iv0 >= 15;

  // Floor over the whole inside, solid (with a foundation: the ground may fall away under the block).
  k.box(0, (iv0 + iv1) / 2, iu, (iv1 - iv0) / 2, B - 0.3, B, C.floorA, { map: 0, foot: true });
  k.room(-iu, iv0, iu, iv1, B - 0.5, ceil);

  // Lining in front of the outer walls (their inner faces carry the facade's windows), with
  // tall glazed windows on the sides and the back.
  const lin = 0.05;
  wallRun(k, 'u', iv0 + lin / 2, -iu, iu, B, ceil, lin, C.wall, [{ a: 0, w: sh.doorW, y0: B, y1: B + sh.doorH }], D);
  wallRun(k, 'u', iv1 - lin / 2, -iu, iu, B, ceil, lin, C.wall, [], D);
  for (const s of [-1, 1]) wallRun(k, 'v', s * (iu - lin / 2), iv0, iv1, B, ceil, lin, C.wall, [], D);
  const storeys = grand ? [B, B + 5.4] : [B];
  for (const y of storeys) {
    const top = Math.min(ceil, y + 5.4);
    for (let a = -iu + 2.2; a < iu - 1.6; a += 3.2) k.box(a, iv1 - lin - 0.03, 0.6, 0.03, y + 1.0, Math.min(top - 0.6, y + 3.4), C.glass, D);
    for (const s of [-1, 1]) for (let a = iv0 + 2.2; a < iv1 - 1.6; a += 3.2) k.box(s * (iu - lin - 0.03), a, 0.03, 0.6, y + 1.0, Math.min(top - 0.6, y + 3.4), C.glass, D);
  }

  // The doorway: open double doors swung inward, a stone frame and a gilded plaque outside.
  const fv = iv0 - 0.6;
  for (const s of [-1, 1]) {
    k.box(s * (dw - 0.06), iv0 + dw / 2 + 0.05, 0.05, dw / 2, B, B + sh.doorH - 0.05, C.dark, DS);
    k.box(s * (dw + 0.35), fv - 0.18, 0.35, 0.18, B, B + sh.doorH + 0.3, C.stone, D);
    k.cyl(s * (dw + 1.2), fv - 0.3, 0.18, 0.12, B + 2.6, B + 3.2, mat(PLASTER, [1.6, 1.4, 1.0]), { detail: true, seg: 8, solid: false });
  }
  k.box(0, fv - 0.2, dw + 0.8, 0.2, B + sh.doorH, B + sh.doorH + 0.6, C.stone, D);
  k.box(0, fv - 0.42, 1.6, 0.03, B + sh.doorH + 0.75, B + sh.doorH + 1.3, C.gold, D);
  k.flat(0, iv0 + 1.2, dw, 0.9, B + 0.012, C.dark, D);

  const door = k.node(0, iv0 + 1.4, B);
  if (grand) grandHall(k, sh, C, r, flagC, door);
  else compactHall(k, sh, C, r, flagC, door);
  return door;
}

// --------------------------------------------------------------- furniture (local frame)

/** A chair facing +v of its frame (rot turns it), the back towards -v. */
function chair(k: Kit, u: number, v: number, rot: number, y: number, m: PartMat, high = false): void {
  k.sub(u, v, rot, () => {
    k.box(0, 0, 0.24, 0.24, y + 0.42, y + 0.48, m, D);
    k.box(0, -0.22, 0.24, 0.03, y + 0.48, y + (high ? 1.55 : 1.0), m, D);
    for (const [a, b] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) k.box(a, b, 0.025, 0.025, y, y + 0.42, m, D);
  });
}

export function bench(k: Kit, u: number, v: number, rot: number, y: number, len: number, m: PartMat): void {
  k.sub(u, v, rot, () => {
    k.box(0, 0, len / 2, 0.22, y + 0.4, y + 0.46, m, D);
    k.box(0, -0.2, len / 2, 0.03, y + 0.46, y + 0.95, m, D);
    for (const s of [-1, 1]) k.box(s * (len / 2 - 0.1), 0, 0.04, 0.2, y, y + 0.4, m, D);
  });
}

function plant(k: Kit, u: number, v: number, y: number, C: Palette, s = 1, leaf = C.leaf): void {
  k.cyl(u, v, 0.3 * s, 0.22 * s, y, y + 0.55 * s, C.pot, { ...D, seg: 10 });
  k.dome(u, v, 0.55 * s, 0.55 * s, y + 0.5 * s, y + 1.5 * s, leaf, { ...D, seg: 10 });
}

/** A chandelier hanging from the ceiling at (u, v); registers a room light under it. */
function chandelier(k: Kit, u: number, v: number, ceil: number, rad: number, C: Palette, floor: number): void {
  const y = ceil - Math.min(2.2, (ceil - floor) * 0.3);
  k.cyl(u, v, 0.03, 0.03, y, ceil, C.gold, { ...D, seg: 6 });
  k.cyl(u, v, rad, rad * 0.8, y - 0.12, y, C.gold, { ...D, seg: 14 });
  const n = Math.max(6, Math.round(rad * 8));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    k.dome(u + Math.cos(a) * rad * 0.9, v + Math.sin(a) * rad * 0.9, 0.09, 0.09, y, y + 0.22, mat(PLASTER, [2.2, 1.9, 1.4]), { ...D, seg: 6 });
  }
  k.dome(u, v, rad * 0.35, rad * 0.35, y - 0.12, y - 0.7, C.gold, { ...D, seg: 10 });
  k.light(u, v, Math.min(y - 0.5, floor + 4.5));
}

/** A framed portrait on a wall, facing +v of its frame. */
function portrait(k: Kit, u: number, v: number, rot: number, y: number, C: Palette, r: Rng): void {
  const col = r.pick<RGB>([[0.35, 0.25, 0.18], [0.22, 0.25, 0.32], [0.4, 0.3, 0.22], [0.25, 0.3, 0.22]]);
  k.sub(u, v, rot, () => {
    k.box(0, 0, 0.62, 0.04, y, y + 1.5, C.gold, D);
    k.box(0, 0.03, 0.52, 0.03, y + 0.1, y + 1.4, mat(PLASTER, col), D);
  });
}

function flagStand(k: Kit, u: number, v: number, y: number, col: RGB, C: Palette): void {
  k.cyl(u, v, 0.25, 0.25, y, y + 0.06, C.gold, { ...D, seg: 8 });
  k.cyl(u, v, 0.03, 0.03, y, y + 2.6, C.gold, { ...D, seg: 6 });
  k.box(u + 0.5, v, 0.48, 0.02, y + 1.3, y + 2.5, mat(PLASTER, col), D);
}

/** Council chamber: rows of desks on circles round a dais at the back (v1), facing it. */
function chamber(k: Kit, u0: number, u1: number, v0: number, v1: number, y: number, ceil: number, C: Palette, r: Rng, flagC: RGB, entry: number): void {
  const cu = (u0 + u1) / 2, half = (u1 - u0) / 2;
  const dh = Math.min(half - 0.8, 4.5);
  // (Reaching down into the slab: tall enough to be stood on.)
  k.box(cu, v1 - 1.5, dh, 1.4, y - 0.5, y + 0.4, C.dark, { ...DS, top: C.red });
  k.box(cu, v1 - 2.1, Math.min(2.4, dh - 0.4), 0.4, y + 0.4, y + 1.2, C.wood, DS);
  for (const s of [-1, 0, 1]) chair(k, cu + s * 1.1, v1 - 1.2, Math.PI, y + 0.4, C.red, s === 0);
  // Coat of arms between two flags.
  k.box(cu, v1 - 0.09, 0.8, 0.04, y + 2.3, y + 3.5, C.gold, D);
  k.box(cu, v1 - 0.12, 0.6, 0.03, y + 2.45, y + 3.35, mat(PLASTER, flagC), D);
  for (const s of [-1, 1]) flagStand(k, cu + s * Math.min(3.2, dh), v1 - 0.6, y + 0.4, s < 0 ? flagC : WHITE, C);
  const vc = v1 - 2.1;
  k.flat(cu, (v0 + vc) / 2, half - 0.5, Math.max(0.3, (vc - v0) / 2 - 0.3), y + 0.012, C.red, D);
  for (let R = 3.2; vc - R - 1.2 > v0 + 0.6; R += 1.9) {
    const m = Math.max(2, Math.floor((R * 2.4) / 1.75));
    for (let i = 0; i < m; i++) {
      const th = -1.2 + (2.4 * (i + 0.5)) / m;
      const u = cu + R * Math.sin(th), v = vc - R * Math.cos(th);
      if (Math.abs(u - cu) > half - 1) continue;
      // (In the desk's frame +v points at the dais.)
      k.sub(u, v, th, () => {
        k.box(0, 0, 0.72, 0.28, y, y + 0.76, C.wood, { ...DS, top: C.dark });
        k.beam(0.3, 0.1, y + 0.76, 0.3, 0.2, y + 1.1, 0.012, C.dark, D);
        chair(k, 0, -0.62, 0, y, C.red);
        // (Out between the rows, then to the front: the desks are in the way here and there.)
        k.spot(0, -0.6, y, 0, true, 'councillor', entry, [[0, -1.2]]);
      });
    }
  }
  chandelier(k, cu, (v0 + v1) / 2, ceil, Math.min(1.4, half * 0.2), C, y);
  for (const s of [-1, 1]) portrait(k, cu + s * (half - 0.09), (v0 + v1) / 2, s * Math.PI / 2, y + 1.4, C, r);
}

/**
 * The grand layout: a two-storey hall with side galleries and a twin staircase, the service
 * hall behind it, and upstairs the council chamber between the mayor's office and the wedding room.
 */
function grandHall(k: Kit, sh: Shell, C: Palette, r: Rng, flagC: RGB, door: number): void {
  // (Walkable parts are at least ~0.75 m tall: world/Collision only stands on obstacle tops
  // taller than 1.4 × the step height, and walks into lower ones. Slabs are thick, steps and
  // the dais reach down into the floor.)
  const B = k.B, gh = 5.4, L1 = B + gh, slab = 0.8;
  const { iu, iv0, iv1, ceil } = sh;
  const pt = 0.3, vP = iv0 + (iv1 - iv0) * 0.6;
  const gW = Math.min(4.2, Math.max(3, iu * 0.22));
  const uTop = iu - gW;
  const n = Math.round(gh / 0.18), rise = gh / n;
  const tread = Math.min(0.32, (uTop - 2.0) / n);
  const uBot = uTop - n * tread;
  const sw = 2.2, vS = vP - pt / 2 - sw / 2;
  const hallV1 = vP - pt / 2;

  // Hall floor: a chequer of two stones, the emblem in the middle, a runner from the door.
  const tile = 2;
  for (let u = -iu, i = 0; u < iu - 0.01; u += tile, i++)
    for (let v = iv0, j = 0; v < hallV1 - 0.01; v += tile, j++) {
      if (!((i + j) % 2)) continue;
      const hu = Math.min(tile, iu - u) / 2, hv = Math.min(tile, hallV1 - v) / 2;
      k.flat(u + hu, v + hv, hu, hv, B + 0.006, C.floorB, D);
    }
  const ev = (iv0 + vS - sw / 2) / 2;
  k.cyl(0, ev, 2.6, 2.6, B, B + 0.015, C.floorB, { ...D, seg: 24 });
  k.cyl(0, ev, 2.2, 2.2, B, B + 0.02, C.gold, { ...D, seg: 24 });
  k.cyl(0, ev, 1.4, 1.4, B, B + 0.025, mat(PLASTER, flagC), { ...D, seg: 24 });
  if (ev - 2.6 > iv0 + 2.4) k.flat(0, (iv0 + 2.2 + ev - 2.6) / 2, 1.1, (ev - 2.6 - iv0 - 2.2) / 2, B + 0.014, C.red, D);

  for (const s of [-1, 1]) {
    // Gallery along the side wall, carried by columns that run up to the ceiling.
    k.box(s * (iu - gW / 2), (iv0 + hallV1) / 2, gW / 2, (hallV1 - iv0) / 2, L1 - slab, L1, C.ceil, { ...DS, top: C.wood });
    const cu = s * (uTop + 0.35);
    for (let v = iv0 + 2.5; v < vS - sw / 2 - 0.8; v += 4.2) {
      k.cyl(cu, v, 0.42, 0.42, B, ceil, C.stone, { ...DS, seg: 14 });
      k.box(cu, v, 0.55, 0.55, ceil - 0.4, ceil, C.stone, D);
      k.box(cu, v, 0.52, 0.52, B, B + 0.35, C.stone, D);
      plant(k, cu - s * 1.2, v, B, C, 0.9);
    }
    // Balustrade (open where the stairs arrive) and banners in the city's colours under it.
    const b0 = iv0 + 0.2, b1 = vS - sw / 2 - 0.1;
    k.box(s * (uTop + 0.08), (b0 + b1) / 2, 0.07, (b1 - b0) / 2, L1, L1 + 1.0, C.stone, DS);
    k.box(s * (uTop + 0.08), (b0 + b1) / 2, 0.12, (b1 - b0) / 2 + 0.05, L1 + 1.0, L1 + 1.08, C.stone, D);
    for (let v = b0 + 3, i = 0; v < b1 - 2; v += 6, i++) k.box(s * (uTop - 0.02), v, 0.02, 0.7, L1 - 2.8, L1 - slab - 0.1, mat(PLASTER, i % 2 ? WHITE : flagC), D);
    // Benches and portraits under the gallery.
    for (let v = iv0 + 5.1; v < vS - sw / 2 - 2; v += 4.2) {
      bench(k, s * (iu - 0.5), v, s * Math.PI / 2, B, 2.2, C.wood);
      portrait(k, s * (iu - 0.12), v, s * Math.PI / 2, B + 1.8, C, r);
    }
    // The staircase: a flight along the back of the hall, rising outwards to the gallery.
    for (let i = 0; i < n; i++) k.box(s * (uBot + (i + 0.5) * tread), vS, tread / 2, sw / 2, B - 1, B + (i + 1) * rise, C.stone, DS);
    const vr = vS - sw / 2 + 0.06;
    k.beam(s * uBot, vr, B + 1.0, s * uTop, vr, L1 + 1.0, 0.05, C.gold, D);
    for (const [u, y] of [[uBot, B], [uTop, L1]] as const) k.cyl(s * u, vr, 0.09, 0.09, y, y + 1.1, C.gold, { ...D, seg: 8 });
  }
  // Information desk and a bust of the founder.
  const du = -Math.min(uTop - 3, 8);
  k.box(du, iv0 + 5, 2, 0.5, B, B + 0.95, C.wood, { ...DS, top: C.stone });
  // (A plate on its front, not a sign on top: from the hall the clerk behind it is seen.)
  k.box(du, iv0 + 4.47, 0.5, 0.03, B + 0.45, B + 0.85, C.gold, D);
  k.box(-du, iv0 + 5, 0.55, 0.55, B, B + 1.3, C.stone, DS);
  figure(k, -du, iv0 + 5, B + 1.3, 1.1, mat(METAL, BRONZE), false);
  for (const f of [0.3, 0.75]) chandelier(k, 0, iv0 + (hallV1 - iv0) * f, ceil, 1.6, C, B);

  // The wall between the hall and the rooms behind: a door to the service hall below, doors
  // from the galleries into the mayor's office and the wedding room above.
  wallRun(k, 'u', vP, -iu, iu, B, ceil, pt, C.wall, [
    { a: 0, w: 3, y0: B, y1: B + 3.4 },
    { a: -(iu - gW / 2), w: 1.6, y0: L1, y1: L1 + 2.5 },
    { a: iu - gW / 2, w: 1.6, y0: L1, y1: L1 + 2.5 },
  ], DS);
  k.box(0, vP - pt / 2 - 0.05, 1.9, 0.05, B + 3.4, B + 3.9, C.gold, D);

  // Service hall (ground floor behind): counters, waiting benches, a number display.
  const sv0 = vP + pt / 2, sTop = L1 - slab;
  k.box(0, (sv0 + iv1) / 2, iu - 0.01, (iv1 - sv0) / 2, L1 - slab, L1, C.ceil, { top: C.wood, map: 0 });
  const cv = iv1 - 2.4;
  k.box(0, cv, iu - 1.5, 0.35, B, B + 1.1, C.wood, { ...DS, top: C.stone });
  for (let u = -iu + 2.5; u < iu - 2; u += 2.8) {
    k.box(u, cv - 0.05, 0.25, 0.03, B + 1.1, B + 1.45, C.dark, D);
  }
  for (let row = 0, v = sv0 + 1.8; v < cv - 2 && row < 3; v += 1.5, row++)
    for (const s of [-1, 1]) bench(k, s * Math.min(iu * 0.45, 5), v, 0, B, Math.min(iu * 0.6, 5.5), C.wood);
  k.box(0, sv0 + 0.06, 1.3, 0.04, B + 2.4, B + 3.1, C.screen, D);
  for (const f of [-0.5, 0.5]) k.light(f * iu, (sv0 + iv1) / 2, sTop - 0.8);
  plant(k, -iu + 1, sv0 + 1, B, C);
  plant(k, iu - 1, sv0 + 1, B, C);

  // Upstairs: the mayor's office | the council chamber | the wedding room.
  const cw = iu - gW - 1.6;
  for (const s of [-1, 1]) wallRun(k, 'v', s * cw, sv0, iv1, L1, ceil, 0.25, C.wall, [{ a: sv0 + 1.4, w: 1.3, y0: L1, y1: L1 + 2.4 }], DS);
  const cM = k.node(0, sv0 + 0.8, L1);
  chamber(k, -cw + 0.125, cw - 0.125, sv0, iv1, L1, ceil, C, r, flagC, cM);
  {
    // The mayor's office (left): desk, chairs, bookcase, flag, rug, plant.
    const u0 = -iu, u1 = -cw - 0.125, um = (u0 + u1) / 2, vm = (sv0 + iv1) / 2;
    k.flat(um, vm + 0.6, (u1 - u0) / 2 - 0.5, Math.max(0.4, (iv1 - sv0) / 2 - 1.1), L1 + 0.012, C.red, D);
    k.box(um, iv1 - 1.8, 1.0, 0.35, L1, L1 + 0.76, C.wood, { ...DS, top: C.dark });
    chair(k, um, iv1 - 0.85, Math.PI, L1, C.red, true);
    for (const s of [-1, 1]) chair(k, um + s * 0.6, iv1 - 3.0, 0, L1, C.dark);
    const bu = u0 + 0.3, bh = Math.min(1.6, (iv1 - sv0) / 2 - 0.8);
    k.box(bu, vm, 0.25, bh, L1, L1 + 2.3, C.wood, D);
    for (let y = L1 + 0.4; y < L1 + 2.2; y += 0.45)
      for (let v = vm - bh + 0.25; v < vm + bh - 0.2; v += 0.35) k.box(bu + 0.06, v, 0.18, 0.13, y, y + r.range(0.25, 0.36), mat(PLASTER, r.pick<RGB>([[0.5, 0.1, 0.1], [0.15, 0.2, 0.4], [0.2, 0.35, 0.2], [0.55, 0.45, 0.3], [0.2, 0.15, 0.1]])), D);
    flagStand(k, u1 - 0.8, iv1 - 0.6, L1, flagC, C);
    portrait(k, um, iv1 - 0.12, Math.PI, L1 + 1.5, C, r);
    plant(k, u0 + 0.7, iv1 - 0.7, L1, C);
    k.light(um, vm, ceil - 0.8);
  }
  {
    // The wedding room (right): a table with flowers, the couple's chairs, rows for the guests.
    const u0 = cw + 0.125, u1 = iu, um = (u0 + u1) / 2, vm = (sv0 + iv1) / 2;
    k.box(um, iv1 - 1.6, 1.1, 0.45, L1, L1 + 0.78, C.cloth, DS);
    for (const s of [-1, 1]) {
      plant(k, um + s * 0.8, iv1 - 1.6, L1 + 0.78, C, 0.35, mat(PLASTER, s < 0 ? [1.3, 1.1, 1.15] : [1.2, 0.5, 0.6]));
      chair(k, um + s * 0.5, iv1 - 2.75, 0, L1, C.cloth, true);
    }
    for (let v = iv1 - 3.8; v > sv0 + 2.2; v -= 1.0)
      for (const s of [-1, 1]) for (const d of [0.55, 1.15]) chair(k, um + s * d, v, 0, L1, C.wood);
    k.flat(um, vm, 0.35, (iv1 - sv0) / 2 - 0.4, L1 + 0.012, C.red, D);
    k.light(um, vm, ceil - 0.8);
  }
  grandWays(k, sh, door, cM, { L1, gW, uTop, uBot, tread, rise, vS, sw, vP, pt, du, cv, cw });
}

/**
 * Where people walk and stay in the grand town hall (sim/LandmarkCrowds). The hall: in at the
 * door, up the middle, along under the galleries (benches), round the information desk and the
 * founder's bust; up the twin stairs to the galleries (looking down into the hall) and on into
 * the mayor's office and the wedding room, both opening into the council chamber between them.
 * Behind the hall the service hall: waiting benches, a counter with its clerks.
 */
function grandWays(k: Kit, sh: Shell, door: number, cM: number, g: { L1: number; gW: number; uTop: number; uBot: number; tread: number; rise: number; vS: number; sw: number; vP: number; pt: number; du: number; cv: number; cw: number }): void {
  const B = k.B, { iu, iv0, iv1, ceil } = sh, { L1, gW, uTop, uBot, vS, sw, vP, du, cv, cw } = g;
  const sv0 = vP + g.pt / 2, ug = iu - gW / 2, lane = iu - 1.6;
  // The hall's middle line, the desk (a clerk behind it, someone asking) and the bust.
  const c1 = k.node(0, iv0 + 3.4, B), c2 = k.node(0, iv0 + 7, B), cB = k.node(0, vP - 1.0, B);
  k.path(door, c1, c2, cB);
  k.spot(du, iv0 + 5.85, B, Math.PI, false, 'clerk', c2, [[du, iv0 + 7]]);
  k.spot(du + 0.6, iv0 + 3.9, B, 0, false, 'client', c1);
  k.spot(-du, iv0 + 3.75, B, 0, false, 'visitor', c1, [], [-du, iv0 + 5, B + 2.1]);
  k.spot(1.5, (iv0 + vS - sw / 2) / 2 + 1, B, 2.6, false, 'visitor', c2, [], [0, (iv0 + vP) / 2, ceil - 1]);
  k.spot(-1.2, (iv0 + vS - sw / 2) / 2 - 0.5, B, 0.4, false, 'visitor', c2, [], [-uTop, (iv0 + vP) / 2, L1 + 1.5]);
  for (const s of [-1, 1]) {
    // Under the gallery: a lane past the benches (people resting, looking up at the portraits).
    let prev = k.node(s * lane, iv0 + 3.4, B);
    k.path(c1, prev);
    for (let v = iv0 + 5.1; v < vS - sw / 2 - 2; v += 4.2) {
      const n = k.node(s * lane, v, B);
      k.path(prev, n);
      prev = n;
      for (const dv of [-0.5, 0.5]) k.spot(s * (iu - 0.52), v + dv, B, s * Math.PI / 2, true, 'visitor', n, [[s * (iu - 1.2), v + dv]]);
    }
    // The stairs: from the foot by the middle, outwards up the flight to the gallery.
    const f0 = k.node(s * (uBot - 0.6), vS, B), f1 = k.node(s * uBot, vS, B + g.rise * 0.5), f2 = k.node(s * (uTop - g.tread / 2), vS, L1);
    const t = k.node(s * (uTop + 0.7), vS, L1), q = k.node(s * ug, vS, L1);
    k.path(cB, f0, f1, f2, t, q);
    // Along the gallery to its front, looking down into the hall between the columns.
    const gaps: number[] = [];
    for (let v = iv0 + 4.6; v < vS - sw / 2 - 1.2; v += 4.2) gaps.unshift(v);
    let gp = q;
    for (const v of gaps) {
      const n = k.node(s * ug, v, L1);
      k.path(gp, n);
      gp = n;
      k.spot(s * (uTop + 0.75), v, L1, s * Math.PI / 2, false, 'visitor', n, [], [0, v, B + 0.5]);
    }
    // Through the gallery's door into the room behind.
    const gd = k.node(s * ug, vP - 0.7, L1), gi = k.node(s * ug, sv0 + 0.9, L1);
    k.path(q, gd, gi);
    // The door from the room into the chamber.
    const rd = k.node(s * (cw + 0.75), sv0 + 1.4, L1), cd = k.node(s * (cw - 0.75), sv0 + 1.4, L1);
    k.path(gi, rd, cd, cM);
    if (s < 0) {
      // The mayor's office: the mayor at the desk, an aide or a visitor in front of it.
      const um = (-iu - cw - 0.125) / 2, oA = k.node(um, iv1 - 3.8, L1);
      k.path(gi, oA, rd);
      k.spot(um, iv1 - 0.85, L1, Math.PI, true, 'mayor', oA, [[um + 1.45, iv1 - 3.0], [um + 1.45, iv1 - 0.85]]);
      for (const d of [-0.6, 0.6]) k.spot(um + d, iv1 - 3.0, L1, 0, true, 'aide', oA, [[um + d, iv1 - 3.5]]);
    } else {
      // The wedding room: the couple at the table, the registrar behind it, guests in rows.
      const um = (cw + 0.125 + iu) / 2, wE = k.node(um, sv0 + 1.0, L1);
      k.path(gi, wE, rd);
      let prev = wE;
      const rows: number[] = [];
      for (let v = iv1 - 3.8; v > sv0 + 2.2; v -= 1.0) rows.unshift(v);
      for (const v of rows) {
        const n = k.node(um, v - 0.5, L1);
        k.path(prev, n);
        prev = n;
        for (const s2 of [-1, 1]) for (const d of [0.55, 1.15]) k.spot(um + s2 * d, v, L1, 0, true, 'guest', n, [[um + s2 * d, v - 0.5]]);
      }
      const wF = k.node(um, iv1 - 3.2, L1);
      k.path(prev, wF);
      for (const d of [-0.5, 0.5]) k.spot(um + d, iv1 - 2.75, L1, 0, true, 'couple', wF, [[um + d, iv1 - 3.2]]);
      k.spot(um, iv1 - 0.6, L1, Math.PI, false, 'registrar', wF, [[um + 1.55, iv1 - 3.2], [um + 1.55, iv1 - 0.6]]);
    }
  }
  // The service hall: through the door behind the hall, rows of waiting benches facing the counter.
  const sD = k.node(0, sv0 + 0.9, B);
  k.path(cB, sD);
  let prev = sD;
  const bx = Math.min(iu * 0.45, 5), bl = Math.min(iu * 0.6, 5.5);
  for (let row = 0, v = sv0 + 1.8; v < cv - 2 && row < 3; v += 1.5, row++) {
    const n = k.node(0, v + 0.6, B);
    k.path(prev, n);
    prev = n;
    for (const s of [-1, 1]) for (let u = bx - bl / 2 + 0.35; u < bx + bl / 2 - 0.3; u += 0.62) k.spot(s * u, v + 0.03, B, 0, true, 'client', n, [[s * u, v + 0.6]]);
  }
  // The counter: clients in front of it, clerks standing behind it (seated, a 1.1 m counter hid them), in round its ends.
  const front: number[] = [], back: number[] = [];
  const us: number[] = [];
  for (let u = -iu + 2.5; u < iu - 2; u += 2.8) us.push(u);
  const fe = [k.node(-(iu - 0.75), cv - 1.2, B)], be = [k.node(-(iu - 0.75), cv + 1.75, B)];
  for (const u of us) {
    const f = k.node(u, cv - 1.2, B), b = k.node(u, cv + 1.75, B);
    front.push(f); back.push(b);
    k.spot(u, cv - 0.75, B, 0, false, 'client', f);
    k.spot(u, cv + 0.75, B, Math.PI, false, 'clerk', b);
  }
  fe.push(k.node(iu - 0.75, cv - 1.2, B));
  be.push(k.node(iu - 0.75, cv + 1.75, B));
  k.path(fe[0], ...front, fe[1]);
  k.path(be[0], ...back, be[1]);
  k.path(fe[0], be[0]);
  k.path(fe[1], be[1]);
  // (The middle line meets the counter's lane at the slot nearest the middle.)
  let mid = 0;
  for (let i = 1; i < us.length; i++) if (Math.abs(us[i]) < Math.abs(us[mid])) mid = i;
  if (front.length) k.path(prev, front[mid]);
}

/** The compact layout (smaller and modern town halls): the hall in front, the council chamber behind it, one storey. */
function compactHall(k: Kit, sh: Shell, C: Palette, r: Rng, flagC: RGB, door: number): void {
  const B = k.B;
  const { iu, iv0, iv1, ceil } = sh;
  const pt = 0.25, vP = iv0 + (iv1 - iv0) * 0.5;
  wallRun(k, 'u', vP, -iu, iu, B, ceil, pt, C.wall, [{ a: 0, w: 2.4, y0: B, y1: B + 3 }], DS);
  k.box(0, vP - pt / 2 - 0.05, 1.5, 0.05, B + 3, B + 3.4, C.gold, D);
  // Hall: the emblem, an information desk, benches, plants, a chandelier.
  const ev = (iv0 + vP) / 2, er = Math.min(2.2, (vP - iv0) * 0.3);
  k.cyl(0, ev, er, er, B, B + 0.02, C.gold, { ...D, seg: 24 });
  k.cyl(0, ev, er * 0.65, er * 0.65, B, B + 0.025, mat(PLASTER, flagC), { ...D, seg: 24 });
  const du = -Math.min(iu - 2, 5);
  // (Low enough to see the clerk standing behind it.)
  k.box(du, ev, 1.4, 0.45, B, B + 0.95, C.wood, { ...DS, top: C.stone });
  for (const s of [-1, 1]) {
    bench(k, s * (iu - 0.5), ev, s * Math.PI / 2, B, Math.max(1.2, Math.min(2.4, vP - iv0 - 2)), C.wood);
    plant(k, s * (iu - 0.8), iv0 + 0.9, B, C);
    portrait(k, s * (iu - 0.12), ev, s * Math.PI / 2, B + 1.8, C, r);
  }
  chandelier(k, 0, ev, ceil, 1.2, C, B);
  const cM = k.node(0, vP + pt / 2 + 0.9, B);
  chamber(k, -iu, iu, vP + pt / 2, iv1, B, ceil, C, r, flagC, cM);

  // Where people walk and stay (sim/LandmarkCrowds): in at the door, across the hall, through
  // into the chamber; the clerk at the desk, someone asking there, people waiting on the benches.
  const hC = k.node(0, ev, B), hB = k.node(0, vP - 0.9, B);
  k.path(door, hC, hB, cM);
  for (const s of [-1, 1]) {
    const cs = k.node(s * (iu - 1.2), vP + pt / 2 + 0.9, B);
    k.path(cM, cs);
  }
  k.spot(du, ev + 0.8, B, Math.PI, false, 'clerk', hC, [[du, ev + 1.6]]);
  k.spot(du, ev - 0.95, B, 0, false, 'client', hC);
  const bl = Math.max(1.2, Math.min(2.4, vP - iv0 - 2));
  // (The right bench: the desk stands in front of the left one.)
  for (const dv of bl > 1.6 ? [-0.45, 0.45] : [0]) k.spot(iu - 0.52, ev + dv, B, Math.PI / 2, true, 'visitor', hC, [[iu - 1.2, ev + dv]]);
  k.spot(1.6, ev - er - 0.6, B, -0.3, false, 'visitor', hC, [], [0, ev, ceil - 0.8]);
  k.spot(-0.9, iv0 + 2.4, B, 0.2, false, 'visitor', door, [], [0, vP, B + 3.2]);
}

/** Point on a superellipse |x/a|^n + |z/b|^n = 1 at angle t. */
function superE(a: number, b: number, n: number, t: number): [number, number] {
  const c = Math.cos(t), s = Math.sin(t);
  return [a * Math.sign(c) * Math.pow(Math.abs(c), 2 / n), b * Math.sign(s) * Math.pow(Math.abs(s), 2 / n)];
}

function stadium(k: Kit, lm: Landmark, r: Rng): void {
  const P = lm.p, B = k.B;
  const n = P.shape ? 6 : 2, N = 48;
  const wallL = [CONC, METAL, BRICK][P.wall % 3];
  const facade = mat(wallL, wallL === METAL ? r.pick<RGB>([[0.9, 0.9, 0.92], [0.55, 0.6, 0.68], PAINT[P.seatA]]) : WHITE, WIN, 5, 4.5, 6);
  const under = mat(CONC, [0.8, 0.8, 0.8]);
  const seatA = mat(PANEL, PAINT[P.seatA]), seatB = mat(PANEL, PAINT[P.seatB === P.seatA ? (P.seatB + 3) % 8 : P.seatB]);
  // Bowl: tiers of sloped stands around the field, stepped seat rows near.
  const rise = 0.52;
  const tierY = (t: number) => B + 1.4 + t * (P.depth * rise + 3.2);
  const ring: { u: number; v: number; nu: number; nv: number }[] = [];
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2;
    const [u, v] = superE(P.ia, P.ib, n, t);
    const [u1, v1] = superE(P.ia, P.ib, n, t + 0.01), [u0, v0] = superE(P.ia, P.ib, n, t - 0.01);
    const tu = u1 - u0, tv = v1 - v0, tl = Math.hypot(tu, tv) || 1;
    ring.push({ u, v, nu: tv / tl, nv: -tu / tl });
  }
  let topY = B;
  for (let i = 0; i < N; i++) {
    const p0 = ring[i], p1 = ring[i + 1];
    // Gates at the ends of the long axis (the players' tunnel, the marathon gate).
    const t = ((i + 0.5) / N) * Math.PI * 2;
    if (Math.abs(Math.sin(t)) < 0.07) continue;
    const seat = (Math.floor(i / 4) % 3 === 2) ? seatB : seatA;
    // Offsets along each ring vertex's own normal: tiers and segments meet without gaps.
    const at = (q: typeof p0, o: number): [number, number] => [q.u + q.nu * o, q.v + q.nv * o];
    for (let tr = 0; tr < P.tiers; tr++) {
      const o0 = tr * P.depth, o1 = o0 + P.depth;
      const y0 = tierY(tr), y1 = y0 + P.depth * rise;
      topY = Math.max(topY, y1);
      k.rampQ([at(p1, o0), at(p0, o0), at(p0, o1), at(p1, o1)], B, y0, y1, Math.round(P.depth / 0.85), under,
        { top: seat, back: tr === P.tiers - 1 ? facade : under, noSides: true, foot: true });
    }
  }
  // Roof: a canopy over the long sides, over the whole ring, or closed over the field too.
  if (P.roof > 0) {
    const roofM = mat(METAL_ROOF, r.pick<RGB>([[0.95, 0.95, 0.95], [0.75, 0.78, 0.8], [0.6, 0.62, 0.66]]));
    const ry = topY + 6, out = P.tiers * P.depth;
    for (let i = 0; i < N; i++) {
      const t = ((i + 0.5) / N) * Math.PI * 2;
      if (P.roof === 1 && Math.abs(Math.sin(t)) < 0.6) continue;
      const p0 = ring[i], p1 = ring[i + 1];
      const nu = (p0.nu + p1.nu) / 2, nv = (p0.nv + p1.nv) / 2, nl = Math.hypot(nu, nv);
      const at = (q: typeof p0, o: number): [number, number] => [q.u + q.nu * o, q.v + q.nv * o];
      const o0 = out * 0.15, o1 = out + 1;
      k.rampQ([at(p1, o0), at(p0, o0), at(p0, o1), at(p1, o1)], ry - 0.6, ry - 0.1, ry + 3, 0, roofM, { top: roofM, noSides: true, solid: false, map: 0 });
      // Columns at the back (every other segment).
      if (i % 2 === 0) {
        const cu = (p0.u + p1.u) / 2 + (nu / nl) * (out + 1.2), cv = (p0.v + p1.v) / 2 + (nv / nl) * (out + 1.2);
        k.cyl(cu, cv, 0.6, 0.6, B, ry + 3, mat(METAL, [0.8, 0.8, 0.82]), { detail: true, solid: false, seg: 8 });
      }
    }
    if (P.roof === 3) k.dome(0, 0, P.ia + out * 0.5, P.ib + out * 0.5, ry + 2.5, ry + 2.5 + Math.min(P.ia, P.ib) * 0.25, mat(METAL_ROOF, [0.92, 0.92, 0.94], ROOF));
  }
  // Floodlight masts on the diagonals.
  if (P.lights) {
    const out = P.tiers * P.depth + 6, mh = topY - B + 22;
    for (const [su, sv] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const [cu, cv] = superE(P.ia + out, P.ib + out, n, Math.atan2(sv, su * 1.3));
      k.cyl(cu, cv, 0.9, 0.6, B, B + mh, mat(METAL, [0.75, 0.76, 0.78]), { seg: 10 });
      k.box(cu, cv, 3.4, 0.9, B + mh, B + mh + 4.2, mat(GLASS, [1.3, 1.3, 1.25], WIN | CURTAIN, 1.1, 1.4, 1.4), { rot: Math.atan2(cv, cu) + Math.PI / 2, solid: false });
    }
  }
  // Scoreboard over the stand at one end.
  k.box(-(P.ia + P.depth * P.tiers * 0.6), 0, 1, 9, topY + 1, topY + 8, mat(GLASS, [0.3, 0.32, 0.35], WIN | CURTAIN, 1.2, 1.2, 1.2), { solid: false, detail: true });
  // The field: grass in mown stripes, a running track around it, markings and goals.
  const gy = B + 0.02;
  const grass = (t: number): PartMat => mat(GREEN_ROOF, [0.5 * t, 0.85 * t, 0.42 * t]);
  k.flat(0, 0, P.ia, P.ib, gy, grass(0.9), { foot: true, map: 3 });
  for (let s = 0; s < 10; s++) k.flat(-52.5 + (s + 0.5) * 10.5, 0, 5.25, 34, gy + 0.015, grass(s % 2 ? 0.92 : 1.04), { detail: true });
  const line = mat(PLASTER, [1.3, 1.3, 1.3]);
  const L = (u0: number, v0: number, u1: number, v1: number) => k.flat((u0 + u1) / 2, (v0 + v1) / 2, Math.max(0.06, Math.abs(u1 - u0) / 2), Math.max(0.06, Math.abs(v1 - v0) / 2), gy + 0.03, line, { detail: true });
  L(-52.5, -34, 52.5, -34); L(-52.5, 34, 52.5, 34); L(-52.5, -34, -52.5, 34); L(52.5, -34, 52.5, 34); L(0, -34, 0, 34);
  for (const s of [-1, 1]) { L(s * 52.5, -20, s * 36, -20); L(s * 52.5, 20, s * 36, 20); L(s * 36, -20, s * 36, 20); }
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    k.flat(Math.cos(a) * 9.15, Math.sin(a) * 9.15, 1.2, 0.06, gy + 0.03, line, { rot: a + Math.PI / 2, detail: true });
  }
  for (const s of [-1, 1]) {
    const post = mat(PLASTER, [1.2, 1.2, 1.2]);
    k.box(s * 52.6, -3.66, 0.06, 0.06, gy, gy + 2.44, post, { detail: true });
    k.box(s * 52.6, 3.66, 0.06, 0.06, gy, gy + 2.44, post, { detail: true });
    k.box(s * 52.6, 0, 0.06, 3.72, gy + 2.38, gy + 2.5, post, { detail: true });
  }
  if (P.track) {
    const tr = mat(TAR, [0.78, 0.36, 0.26]);
    for (let i = 0; i < N; i++) {
      const t0 = (i / N) * Math.PI * 2, t1 = ((i + 1) / N) * Math.PI * 2;
      const [a0, b0] = superE(P.ia - 0.5, P.ib - 0.5, 2, t0), [a1, b1] = superE(P.ia - 0.5, P.ib - 0.5, 2, t1);
      const [c0, d0] = superE(P.ia - 10, P.ib - 10, 2, t0), [c1, d1] = superE(P.ia - 10, P.ib - 10, 2, t1);
      const W = (u: number, v: number) => k.W(u, v);
      const q = [...W(a0, b0), ...W(a1, b1), ...W(c1, d1), ...W(c0, d0)];
      k.quad([q[0], gy + 0.025, q[1], q[2], gy + 0.025, q[3], q[4], gy + 0.025, q[5], q[6], gy + 0.025, q[7]], tr, { map: 4 });
    }
  }
}

function tower(k: Kit, lm: Landmark, r: Rng): void {
  const P = lm.p, B = k.B, H = B + P.h;
  const conc = mat(CONC, [0.93, 0.93, 0.92]);
  const glass = mat(GLASS, WHITE, WIN | CURTAIN, 1.6, 3.2, 3.2);
  const stripe = PAINT[[0, 4, 6, 0][P.colour % 4]];
  if (lm.style === 0) {
    // Concrete TV tower: tapering shaft, a pod (sphere, disc stack or saucer), antenna.
    const pr = P.podR, py = B + P.h * P.pod;
    k.cyl(0, 0, 16, 16, B, B + 6, glass, { foot: true, top: mat(GRAVEL, WHITE, ROOF) });
    k.cyl(0, 0, P.r * 1.7, P.r, B, py, conc, { seg: 24 });
    if (P.tiers === 1) {
      k.dome(0, 0, pr, pr, py + pr, py + 2 * pr, mat(METAL_ROOF, [0.85, 0.86, 0.9], ROOF), { seg: 24 });
      k.dome(0, 0, pr, pr, py + pr, py, mat(METAL_ROOF, [0.85, 0.86, 0.9], ROOF), { seg: 24 });
      k.cyl(0, 0, pr + 0.05, pr + 0.05, py + pr - 1.4, py + pr + 1.4, glass, { seg: 24 });
      k.solidCyl(0, 0, pr, py, py + 2 * pr);
      k.cyl(0, 0, P.r, P.r * 0.7, py + 2 * pr, B + P.h * 0.86, conc, { seg: 16 });
    } else {
      // Stacked discs: a restaurant ring of glass between concrete rims.
      for (let t = 0; t < P.tiers; t++) {
        const y = py + t * 7, rr = pr * (1 - t * 0.12);
        k.cyl(0, 0, rr * 0.55, rr, y, y + 1.6, conc, { seg: 24 });
        k.cyl(0, 0, rr - 0.4, rr - 0.4, y + 1.6, y + 5.2, glass, { seg: 24 });
        k.cyl(0, 0, rr, rr * 0.8, y + 5.2, y + 6.4, conc, { seg: 24 });
      }
      k.cyl(0, 0, P.r, P.r * 0.7, py + P.tiers * 7, B + P.h * 0.86, conc, { seg: 16 });
    }
    k.cyl(0, 0, 1.2, 0.35, B + P.h * 0.86, H, mat(METAL, stripe), { seg: 8 });
    for (let s = 0; s < 3; s++) k.cyl(0, 0, 1.15 - s * 0.25, 1.1 - s * 0.25, B + P.h * (0.89 + s * 0.035), B + P.h * (0.9 + s * 0.035), mat(PLASTER, [1.2, 1.2, 1.2]), { detail: true, solid: false, seg: 8 });
  } else if (lm.style === 1) {
    // Steel lattice tower: four curved legs meeting at the top, platforms, bracing.
    const col = P.colour % 2 ? mat(METAL, [0.62, 0.45, 0.32]) : mat(METAL, [0.82, 0.36, 0.22]);
    const s0 = P.h * 0.13, legs = 7;
    const sAt = (y: number) => 1.6 + (s0 - 1.6) * Math.pow(1 - y, 1.9);
    for (const [su, sv] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
      for (let i = 0; i < legs; i++) {
        const ya = i / legs, yb = (i + 1) / legs;
        k.beam(su * sAt(ya), sv * sAt(ya), B + P.h * 0.85 * ya, su * sAt(yb), sv * sAt(yb), B + P.h * 0.85 * yb, 0.9 * (1 - ya * 0.6), col, { detail: false });
      }
      k.box(su * s0, sv * s0, 2.2, 2.2, B, B + 4, mat(GRANITE, [0.8, 0.78, 0.74]), { foot: true });
    }
    // Bracing on each face per level (near only).
    for (let i = 0; i < legs; i++) {
      const ya = i / legs, yb = (i + 1) / legs, sa = sAt(ya), sb = sAt(yb);
      const y0 = B + P.h * 0.85 * ya, y1 = B + P.h * 0.85 * yb;
      for (const [a, b] of [[[1, 1], [-1, 1]], [[-1, 1], [-1, -1]], [[-1, -1], [1, -1]], [[1, -1], [1, 1]]] as const) {
        k.beam(a[0] * sa, a[1] * sa, y0, b[0] * sb, b[1] * sb, y1, 0.25, col, { detail: true });
        k.beam(b[0] * sa, b[1] * sa, y0, a[0] * sb, a[1] * sb, y1, 0.25, col, { detail: true });
      }
    }
    for (const f of [0.2, 0.45]) {
      const y = B + P.h * 0.85 * f, s = sAt(f) + 1.5;
      k.box(0, 0, s, s, y - 1.2, y + 1.6, col, { solid: true, map: 0 });
      k.box(0, 0, s - 0.6, s - 0.6, y + 1.6, y + 4.5, glass, { detail: true, solid: false });
    }
    k.box(0, 0, 3, 3, B + P.h * 0.85, B + P.h * 0.88, glass, { solid: false });
    k.cyl(0, 0, 0.8, 0.2, B + P.h * 0.88, H, col, { seg: 6 });
    k.box(0, 0, s0 * 0.9, s0 * 0.9, B, B + 0.4, mat(GRANITE), { solid: false, detail: true });
  } else {
    // Slender glass tower: square shaft, an observation box, a spire.
    const w = P.r * 1.3, oy = B + P.h * P.pod;
    k.box(0, 0, w, w, B, oy, mat(GLASS, [0.85, 0.92, 1], WIN | CURTAIN, 1.5, 3.6, 5), { foot: true });
    k.box(0, 0, w + 0.4, 0.4, B, oy, mat(PANEL, WHITE), { solid: false, rot: Math.PI / 4, detail: true });
    k.box(0, 0, w + 5, w + 5, oy, oy + 12, glass, { top: mat(GRAVEL, WHITE, ROOF) });
    k.box(0, 0, w + 5.5, w + 5.5, oy + 12, oy + 13, mat(PANEL, WHITE), { solid: false });
    k.pyramid(0, 0, w * 0.8, w * 0.8, oy + 13, H, 0, mat(METAL, [0.9, 0.9, 0.92]));
  }
}

function wheel(k: Kit, lm: Landmark, r: Rng): void {
  const P = lm.p, B = k.B, R = P.D / 2, hy = B + R + 4.5, hw = P.w / 2;
  const col = mat(METAL, PAINT[[4, 0, 1, 2, 3, 4][P.colour % 6]]);
  const steel = mat(METAL, [0.82, 0.83, 0.86]);
  const N = 36;
  // Two rims, spokes, cross ties, gondolas.
  for (const s of [-1, 1]) {
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
      k.beam(Math.cos(a0) * R, s * hw, hy + Math.sin(a0) * R, Math.cos(a1) * R, s * hw, hy + Math.sin(a1) * R, 0.45, col);
      if (i % 2 === 0) k.beam(0, s * 1.2, hy, Math.cos(a0) * R, s * hw, hy + Math.sin(a0) * R, 0.12, steel, { detail: i % 4 !== 0 });
    }
  }
  for (let i = 0; i < N; i += 2) {
    const a = (i / N) * Math.PI * 2;
    k.beam(Math.cos(a) * R, -hw, hy + Math.sin(a) * R, Math.cos(a) * R, hw, hy + Math.sin(a) * R, 0.15, col, { detail: true });
  }
  const pod = mat(lm.style ? GLASS : PANEL, lm.style ? [0.9, 0.95, 1] : PAINT[r.int(0, 7)], lm.style ? WIN | CURTAIN : 0, 1.2, 2.4, 2.4);
  for (let i = 0; i < P.n; i++) {
    const a = (i / P.n) * Math.PI * 2;
    const gu = Math.cos(a) * (R + (lm.style ? 1.6 : 0)), gy = hy + Math.sin(a) * (R + (lm.style ? 1.6 : 0)) - (lm.style ? 1.2 : 2.6);
    if (lm.style) k.tube(gu, 0, gy, 1.5, 1.4, 1.4, pod, { rot: Math.PI / 2, detail: false, seg: 10 });
    else {
      k.box(gu, 0, 1.0, 1.3, gy - 1.1, gy + 1.0, pod, { solid: false, detail: false });
      k.beam(gu, 0, gy + 1.0, gu, 0, gy + 2.6, 0.08, steel, { detail: true });
    }
  }
  // Hub and A-frame legs on both sides.
  k.tube(0, 0, hy, hw + 1.5, 1.6, 1.6, steel, { rot: Math.PI / 2 });
  for (const s of [-1, 1]) for (const lu of [-1, 1]) {
    const fu = lu * R * 0.42, fv = s * (hw + 2.5);
    k.beam(fu, fv, B, 0, s * (hw + 0.8), hy, 0.8, steel);
    k.box(fu, fv, 1.4, 1.4, B, B + 1.2, mat(CONC, [0.8, 0.8, 0.8]), { foot: true });
  }
  // Boarding platform and a ticket booth.
  k.box(0, 0, 9, hw + 4, B, B + 1.2, mat(CONC, [0.85, 0.85, 0.83]), { foot: true });
  k.box(0, -(hw + 9), 2.5, 1.8, B, B + 2.8, mat(PANEL, PAINT[r.int(0, 7)], WIN, 1.5, 2.8, 2.8), { top: mat(METAL_ROOF, WHITE, ROOF) });
  // The wheel itself is a solid for flyers (above the heads of people on the ground).
  k.solidBox(0, 0, R, hw + 0.6, hy - R + 0.5, hy + R, 1);
}

function monument(k: Kit, lm: Landmark, r: Rng): void {
  const P = lm.p, B = k.B, h = P.h;
  const stoneL = [LIME, GRANITE, SAND][P.stone % 3];
  const stone = mat(stoneL, [0.95, 0.93, 0.9]);
  const step = mat(GRANITE, [0.82, 0.82, 0.82]);
  const statue = r.pick<RGB>([COPPER, BRONZE, GOLD, [0.92, 0.92, 0.9]]);
  const fig = mat(METAL, statue);
  // Plinth steps.
  const base = lm.style === 2 ? 0 : 3;
  for (let i = 0; i < base; i++) k.box(0, 0, 7 - i * 1.6, 7 - i * 1.6, i === 0 ? k.F : B + i * 0.6, B + (i + 1) * 0.6, step, { foot: i === 0 });
  const y0 = B + base * 0.6;
  if (lm.style === 0) {
    k.box(0, 0, 2.8, 2.8, y0, y0 + 4, stone);
    k.pyramid(0, 0, 2.1, 2.1, y0 + 4, B + h * 0.93, 0.62, stone, { solid: true });
    k.pyramid(0, 0, 1.3, 1.3, B + h * 0.93, B + h, 0, mat(METAL, GOLD));
  } else if (lm.style === 1) {
    k.box(0, 0, 3.2, 3.2, y0, y0 + 6, stone);
    k.cyl(0, 0, 2.0, 2.0, y0 + 6, y0 + 7, stone, { seg: 16 });
    k.cyl(0, 0, 1.6, 1.35, y0 + 7, B + h * 0.86, stone, { seg: 16 });
    k.box(0, 0, 2.0, 2.0, B + h * 0.86, B + h * 0.88, stone, { solid: false });
    figure(k, 0, 0, B + h * 0.88, h * 0.12, fig, r.chance(0.5));
  } else if (lm.style === 2) {
    // Triumphal arch: two piers, the span, an attic with a quadriga.
    const W = Math.min(h * 0.9, P.R * 1.3), D = W * 0.32, ah = Math.min(h, W * 1.1);
    const pw = W * 0.3;
    for (const s of [-1, 1]) k.box(s * (W / 2 - pw / 2), 0, pw / 2, D / 2, B, B + ah * 0.62, mat(stoneL, [0.95, 0.93, 0.9], WIN | ARCH, pw, ah * 0.3, ah * 0.3), { foot: true });
    k.box(0, 0, W / 2, D / 2, B + ah * 0.62, B + ah * 0.82, stone);
    k.box(0, 0, W / 2 + 0.4, D / 2 + 0.4, B + ah * 0.82, B + ah * 0.85, stone, { solid: false });
    k.box(0, 0, W / 2 - 1, D / 2 - 0.5, B + ah * 0.85, B + ah, stone);
    k.box(0, 0, W * 0.12, D * 0.25, B + ah, B + ah + 2.5, fig, { detail: true, solid: false });
    for (const s of [-1, 1]) k.box(s * W * 0.07, 0, W * 0.04, D * 0.2, B + ah, B + ah + 3.5, fig, { detail: true, solid: false });
  } else {
    // A figure on a high pedestal, a torch raised.
    const ph = h * 0.38;
    k.box(0, 0, 4, 4, y0, y0 + ph * 0.25, stone);
    k.pyramid(0, 0, 3.4, 3.4, y0 + ph * 0.25, y0 + ph, 0.8, stone, { solid: true });
    figure(k, 0, 0, y0 + ph, h - ph - base * 0.6, fig, true);
  }
}

/** A stylised standing figure (robe, torso, head, a raised arm with a torch or wreath) of height h. */
function figure(k: Kit, u: number, v: number, y: number, h: number, m: PartMat, torch: boolean): void {
  k.cyl(u, v, h * 0.17, h * 0.1, y, y + h * 0.55, m, { seg: 12 });
  k.cyl(u, v, h * 0.1, h * 0.09, y + h * 0.55, y + h * 0.8, m, { seg: 10, solid: false });
  k.dome(u, v, h * 0.075, h * 0.075, y + h * 0.8, y + h * 0.92, m, { seg: 10 });
  k.dome(u, v, h * 0.075, h * 0.075, y + h * 0.82, y + h * 0.8, m, { seg: 10 });
  k.beam(u + h * 0.08, v, y + h * 0.75, u + h * 0.15, v, y + h * 1.02, h * 0.035, m);
  if (torch) {
    k.cyl(u + h * 0.16, v, h * 0.03, h * 0.05, y + h * 1.0, y + h * 1.08, m, { detail: true, solid: false, seg: 8 });
    k.dome(u + h * 0.16, v, h * 0.05, h * 0.05, y + h * 1.08, y + h * 1.16, mat(METAL, GOLD), { detail: true, seg: 8 });
  }
}

function lighthouse(k: Kit, lm: Landmark, r: Rng): void {
  const P = lm.p, B = k.B, H = B + P.h;
  const bands = P.stripes ? 6 : 1;
  const c1: RGB = [1, 1, 1], c2: RGB = P.stripes === 1 ? [0.85, 0.15, 0.12] : [0.15, 0.15, 0.16];
  for (let i = 0; i < bands; i++) {
    const y0 = B + (P.h * i) / bands, y1 = B + (P.h * (i + 1)) / bands;
    const ra = P.r * (1.35 - 0.35 * (i / bands)), rb = P.r * (1.35 - 0.35 * ((i + 1) / bands));
    k.cyl(0, 0, ra, rb, y0, y1, mat(PLASTER, i % 2 ? c2 : c1, WIN, 9, 7, 7), { foot: i === 0, seg: 18 });
  }
  k.cyl(0, 0, P.r + 1.3, P.r + 1.3, H, H + 0.5, mat(METAL, [0.2, 0.2, 0.22]), { seg: 18 });
  k.cyl(0, 0, P.r * 0.75, P.r * 0.75, H + 0.5, H + 3.8, mat(GLASS, [1.3, 1.25, 1.1], WIN | CURTAIN, 1.2, 3.3, 3.3), { seg: 12 });
  k.cyl(0, 0, P.r * 0.9, 0, H + 3.8, H + 6, mat(METAL_ROOF, PAINT[[0, 3, 7][P.colour % 3]], ROOF), { seg: 12, solid: false });
  k.dome(0, 0, 0.4, 0.4, H + 5.9, H + 6.6, mat(METAL, [0.2, 0.2, 0.2]), { detail: true, seg: 6 });
  // Keeper's house.
  const hv = P.r * 1.5 + 5;
  k.box(0, -hv, 5, 3.5, B, B + 3.2, mat(PLASTER, WHITE, WIN, 2.5, 3.2, 3.2), { foot: true });
  k.gable(0, -hv, 5, 3.5, B + 3.2, B + 5.6, mat(PLASTER, WHITE), mat(CLAY, WHITE, ROOF));
  void r;
}

function fortress(k: Kit, lm: Landmark, r: Rng): void {
  const P = lm.p, n = P.sides, R = P.R;
  const ruin = lm.style === 1;
  const stoneL = [GRANITE, SAND, LIME][P.stone % 3];
  const tint: RGB = ruin ? [0.78, 0.76, 0.72] : [0.88, 0.85, 0.8];
  const wall = mat(stoneL, tint);
  const wallW = mat(stoneL, tint, WIN | ARCH, 6.5, 9, 9);
  const roofM = mat(SLATE, WHITE, ROOF);
  const a0 = r.range(0, Math.PI * 2 / n) - Math.PI / 2;
  const corners: [number, number][] = [];
  for (let i = 0; i < n; i++) { const a = a0 + (i / n) * Math.PI * 2; corners.push([Math.cos(a) * R, Math.sin(a) * R]); }
  // Gate in the edge whose middle faces -v most.
  let gate = 0, gv = Infinity;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n, mv = (corners[i][1] + corners[j][1]) / 2; if (mv < gv) { gv = mv; gate = i; } }
  for (let i = 0; i < n; i++) {
    const [ua, va] = corners[i], [ub, vb] = corners[(i + 1) % n];
    const L = Math.hypot(ub - ua, vb - va), rot = Math.atan2(vb - va, ub - ua);
    const pieces = ruin ? r.int(2, 4) : 1;
    for (let p = 0; p < pieces; p++) {
      const t0 = p / pieces, t1 = (p + 1) / pieces;
      // The gate: a gap in the middle of the gate wall with a gatehouse.
      if (i === gate && t0 < 0.55 && t1 > 0.45 && pieces > 1) continue;
      const tm = (t0 + t1) / 2, mu = ua + (ub - ua) * tm, mv = va + (vb - va) * tm, hl = (L * (t1 - t0)) / 2 - (pieces > 1 ? 0.4 : 0);
      if (ruin && r.chance(0.18)) continue; // fallen
      const gmin = k.groundMin(mu, mv, hl, 1.3, rot), gmax = k.groundMax(mu, mv, hl, 1.3, rot);
      const h = P.wallH * (ruin ? r.range(0.35, 1) : 1);
      if (i === gate && pieces === 1) {
        // Intact: the gate passage through the middle.
        for (const s of [-1, 1]) {
          const su = ua + (ub - ua) * (0.5 + s * 0.27), sv = va + (vb - va) * (0.5 + s * 0.27);
          k.box(su, sv, L * 0.23, 1.3, gmin - 0.5, gmax + h, wall, { rot });
        }
        const gu = (ua + ub) / 2, gvv = (va + vb) / 2;
        k.box(gu, gvv, 3.4, 1.3, gmax + 4.2, gmax + h + 1, wall, { rot });
        for (const s of [-1, 1]) {
          const tu = gu + Math.cos(rot) * s * 5.5, tv = gvv + Math.sin(rot) * s * 5.5;
          k.cyl(tu, tv, 3.2, 3.0, k.groundMin(tu, tv, 3, 3) - 0.5, gmax + h + 4, wallW, { seg: 12 });
          k.cyl(tu, tv, 3.5, 0, gmax + h + 4, gmax + h + 10, roofM, { seg: 12, solid: false });
        }
        continue;
      }
      k.box(mu, mv, hl, 1.3, gmin - 0.5, gmax + h, wall, { rot });
      // Crenellations on intact stretches.
      if (!ruin || h > P.wallH * 0.95) for (let s = -hl + 0.8; s < hl - 0.4; s += 2.4) k.box(mu + Math.cos(rot) * s, mv + Math.sin(rot) * s, 0.6, 1.3, gmax + h, gmax + h + 1.1, wall, { rot, detail: true, solid: false });
    }
  }
  // Towers at the corners.
  for (const [u, v] of corners) {
    if (ruin && r.chance(0.2)) continue;
    const g = k.groundMin(u, v, 5, 5), gt = k.groundMax(u, v, 5, 5);
    const th = (P.wallH + 6) * (ruin ? r.range(0.45, 1) : 1);
    const tr = r.range(4.2, 5.6);
    k.cyl(u, v, tr + 0.4, tr, g - 0.5, gt + th, wallW, { seg: 14 });
    if (!ruin) k.cyl(u, v, tr + 0.5, 0, gt + th, gt + th + tr * 1.6, roofM, { seg: 14, solid: false });
  }
  // The keep at the back.
  const kv = R * 0.25, ks = R * 0.22;
  const g = k.groundMin(0, kv, ks, ks), gt = k.groundMax(0, kv, ks, ks);
  const kh = P.keepH * (ruin ? 0.7 : 1);
  k.box(0, kv, ks, ks, g - 0.5, gt + kh, wallW, { top: ruin ? wall : roofM });
  if (!ruin) {
    k.pyramid(0, kv, ks + 0.3, ks + 0.3, gt + kh, gt + kh + ks * 1.1, 0, roofM);
    for (const [cu, cv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      k.cyl(cu * ks, kv + cv * ks, 1.6, 1.6, gt + kh - 4, gt + kh + 3, wall, { detail: true, solid: false, seg: 8 });
      k.cyl(cu * ks, kv + cv * ks, 1.8, 0, gt + kh + 3, gt + kh + 7, roofM, { detail: true, solid: false, seg: 8 });
    }
  } else {
    // Broken top: a few jagged blocks.
    for (let i = 0; i < 5; i++) k.box(r.range(-ks, ks) * 0.8, kv + r.range(-ks, ks) * 0.8, r.range(1, 2.5), r.range(1, 2.5), gt + kh, gt + kh + r.range(1, 4), wall, { detail: true, solid: false });
  }
}

function glasshouse(k: Kit, lm: Landmark, r: Rng): void {
  const P = lm.p, B = k.B;
  const frame: RGB = [[1.15, 1.15, 1.12], [0.35, 0.55, 0.42], [0.25, 0.26, 0.28]][P.frame % 3] as RGB;
  const glass = mat(GLASS, [0.88 * frame[0] * 0.5 + 0.5, 0.95 * frame[1] * 0.4 + 0.6, 0.95], WIN | CURTAIN, 1.6, 2.2, 2.2);
  const plinth = mat(BRICK, [0.9, 0.85, 0.8]);
  const hw = P.W / 2, hl = P.L / 2;
  if (lm.style === 0) {
    // Palm house: a domed middle, vaulted wings either side.
    const dr = hw * 1.1;
    k.cyl(0, 0, dr, dr, B, B + 1, plinth, { foot: true });
    k.cyl(0, 0, dr, dr, B + 1, B + P.H * 0.5, glass, { seg: 20 });
    k.dome(0, 0, dr, dr, B + P.H * 0.5, B + P.H * 0.5 + dr, glass, { seg: 20 });
    k.cyl(0, 0, 1.5, 1.2, B + P.H * 0.5 + dr - 0.3, B + P.H * 0.5 + dr + 2.5, mat(METAL, frame), { detail: true, solid: false, seg: 8 });
    for (const s of [-1, 1]) {
      const wu = s * (dr + (hl - dr) / 2 - 1), wl = (hl - dr) / 2 + 1.5;
      k.box(wu, 0, wl, hw * 0.75, B, B + 1, plinth, { foot: true });
      k.box(wu, 0, wl, hw * 0.75, B + 1, B + P.H * 0.28, glass, { solid: false });
      k.vault(wu, 0, wl, hw * 0.75, B + P.H * 0.28, B + P.H * 0.28 + hw * 0.7, glass);
    }
    k.solidBox(0, 0, hl - 1, hw * 0.75, B, B + P.H * 0.28 + hw * 0.7);
  } else if (lm.style === 1) {
    const dr = Math.min(hl, hw * 1.6);
    k.cyl(0, 0, dr, dr, B, B + 1.2, plinth, { foot: true });
    k.cyl(0, 0, dr, dr * 0.96, B + 1.2, B + P.H * 0.4, glass, { seg: 24 });
    k.dome(0, 0, dr * 0.96, dr * 0.96, B + P.H * 0.4, B + P.H * 0.4 + dr * 0.75, glass, { seg: 24 });
  } else {
    for (const [i, s] of [[0, -1], [1, 0], [2, 1]] as const) {
      const len = hl * (i === 1 ? 1 : 0.75), w = hw * 0.36, h = P.H * (i === 1 ? 0.8 : 0.6);
      k.box(0, s * w * 2.05, len, w, B, B + 1, plinth, { foot: true });
      k.box(0, s * w * 2.05, len, w, B + 1, B + h * 0.35, glass, { solid: false });
      k.vault(0, s * w * 2.05, len, w, B + h * 0.35, B + h * 0.35 + w * 1.1, glass);
      // Glass end walls.
      for (const e of [-1, 1]) k.box(e * len, s * w * 2.05, 0.05, w, B + 1, B + h * 0.35, glass, { detail: true, solid: false });
    }
  }
  void r;
}

function airport(k: Kit, lm: Landmark, r: Rng): void {
  const P = lm.p, B = k.B, hv = lm.hv, len = P.len;
  const asph = mat(TAR, [0.55, 0.55, 0.56]), asphD = mat(ASPHALT, [0.6, 0.6, 0.62]);
  const conc = mat(CONC, [0.95, 0.95, 0.92]);
  const white = mat(PLASTER, [1.35, 1.35, 1.35]), yellow = mat(PLASTER, [1.3, 1.05, 0.25]);
  // Along v (front, landside at -v): car park, terminal, apron, taxiway, runway(s).
  const tw = P.tw, vT0 = -hv + 70, vT1 = vT0 + 58, vA0 = vT1 + 8, vA1 = vA0 + 170;
  const vTx = vA1 + 22, vRw = vTx + 190;
  const apronHu = tw / 2 + 190;
  k.flat(0, -hv + 34, tw / 2 + 40, 28, B + 0.02, asphD);
  k.flat(0, (vA0 + vA1) / 2, apronHu, (vA1 - vA0) / 2, B + 0.03, conc);
  k.flat(0, vTx, len / 2 - 60, 12, B + 0.03, asph);
  for (let i = 0; i < P.runways; i++) {
    const v = vRw + i * 270;
    k.flat(0, v, len / 2, 30, B + 0.03, asph, { map: 2 });
    k.flat(0, v, len / 2 - 2, 22.5, B + 0.04, asphD, { detail: false });
    // Centre line, threshold bars, touchdown zone, edge lines.
    for (let u = -len / 2 + 80; u < len / 2 - 80; u += 50) k.flat(u + 15, v, 15, 0.45, B + 0.06, white, { detail: true });
    for (const s of [-1, 1]) {
      for (let b = 0; b < 8; b++) k.flat(s * (len / 2 - 25), v - 19 + b * 5.4, 22, 0.9, B + 0.06, white, { detail: true });
      for (const o of [-1, 1]) k.flat(s * (len / 2 - 330), v + o * 10, 25, 1.5, B + 0.06, white, { detail: true });
      k.flat(0, v + s * 21.8, len / 2 - 5, 0.4, B + 0.06, white, { detail: true });
    }
    // Links from the taxiway (or from the runway before).
    const prev = i ? vRw + (i - 1) * 270 : vTx;
    for (const f of [-0.48, -0.2, 0.2, 0.48]) k.flat(f * len, (prev + v) / 2, 12, (v - prev) / 2, B + 0.025, asph);
  }
  for (let u = -len / 2 + 70; u < len / 2 - 70; u += 30) k.flat(u, vTx, 9, 0.2, B + 0.05, yellow, { detail: true });
  for (const f of [-0.35, 0, 0.35]) k.flat(f * apronHu * 1.4, (vA1 + vTx) / 2, 12, (vTx - vA1) / 2 + 1, B + 0.025, asph);
  // Terminal: a long glazed hall under a flat, waved or saw-tooth roof; piers out onto the apron.
  const tc = (vT0 + vT1) / 2, th = 18 + r.range(0, 6);
  const glassT = mat(GLASS, [0.85, 0.92, 1], WIN | CURTAIN, 2.2, 4.5, 6);
  k.box(0, tc, tw / 2, (vT1 - vT0) / 2, B, B + th, glassT, { top: mat(METAL_ROOF, [0.9, 0.9, 0.92], ROOF) });
  if (lm.style === 1) k.vault(0, tc, tw / 2 + 4, (vT1 - vT0) / 2 + 6, B + th, B + th + 9, mat(METAL_ROOF, [0.92, 0.92, 0.94], ROOF), { solid: false });
  else if (lm.style === 2) {
    const nb = Math.max(3, Math.round(tw / 70));
    for (let i = 0; i < nb; i++) k.vault(-tw / 2 + (i + 0.5) * (tw / nb), tc, 2 + (vT1 - vT0) / 2, tw / nb / 2, B + th, B + th + 7, mat(METAL_ROOF, [0.88, 0.9, 0.92], ROOF), { rot: Math.PI / 2, solid: false });
  } else k.box(0, tc - 3, tw / 2 + 6, (vT1 - vT0) / 2 + 6, B + th, B + th + 1.2, mat(PANEL, WHITE), { solid: false });
  // Landside canopy over the kerb.
  k.box(0, vT0 - 7, tw * 0.4, 5, B + 6, B + 6.6, mat(PANEL, WHITE), { solid: false });
  const gates = P.gates, gw = tw / gates;
  const planesU: number[] = [];
  for (let g = 0; g < gates; g++) {
    const u = -tw / 2 + (g + 0.5) * gw;
    // Jet bridge from the terminal out towards the stand.
    k.box(u, vT1 + 9, 1.6, 9, B + 4.2, B + 7, mat(METAL, [0.82, 0.83, 0.85], WIN, 2, 2.8, 2.8), { solid: false, detail: true });
    k.cyl(u, vT1 + 16, 0.5, 0.5, B, B + 4.2, mat(METAL, [0.5, 0.5, 0.5]), { detail: true, solid: false, seg: 6 });
    planesU.push(u);
  }
  // Control tower beside the terminal, hangars at the far end of the apron.
  const ctU = tw / 2 + 60, ctV = vT0 + 20, ctH = 42 + r.range(0, 30);
  k.box(ctU, ctV, 9, 7, B, B + 8, mat(CONC, WHITE, WIN, 2.5, 4, 4), { top: mat(GRAVEL, WHITE, ROOF) });
  k.cyl(ctU, ctV, 3.6, 3.2, B, B + ctH, mat(CONC, [0.95, 0.95, 0.95], WIN, 4, 6, 8), { seg: 16 });
  k.cyl(ctU, ctV, 5.5, 8.5, B + ctH, B + ctH + 1.2, mat(CONC, WHITE), { seg: 16 });
  k.cyl(ctU, ctV, 8.2, 8.6, B + ctH + 1.2, B + ctH + 5.2, mat(GLASS, [0.6, 0.75, 0.85], WIN | CURTAIN, 1.5, 4, 4), { seg: 16 });
  k.cyl(ctU, ctV, 9, 9, B + ctH + 5.2, B + ctH + 6, mat(CONC, WHITE), { seg: 16, top: mat(GRAVEL, WHITE, ROOF) });
  k.cyl(ctU, ctV, 0.2, 0.1, B + ctH + 6, B + ctH + 13, mat(METAL, [0.8, 0.2, 0.15]), { detail: true, solid: false, seg: 6 });
  for (let h = 0; h < P.hangars; h++) {
    const hu = -(tw / 2 + 70 + h * 72), hvv = vA0 + 38;
    const hm = mat(METAL, r.pick<RGB>([[0.85, 0.87, 0.9], [0.6, 0.65, 0.7], [0.75, 0.78, 0.72]]));
    k.box(hu, hvv, 30, 26, B, B + 14, hm, { top: mat(METAL_ROOF, WHITE, ROOF) });
    k.vault(hu, hvv, 26, 30, B + 14, B + 21, mat(METAL_ROOF, [0.9, 0.9, 0.9], ROOF), { rot: Math.PI / 2, solid: false });
    k.box(hu, hvv + 26.05, 26, 0.1, B, B + 12.5, mat(METAL, [0.45, 0.47, 0.5]), { solid: false, detail: true });
  }
  // Aircraft at the gates (nose towards the terminal) and one holding at the runway end.
  const liveries = [r.int(0, 7), r.int(0, 7), r.int(0, 7)];
  for (let i = 0; i < Math.min(P.planes, planesU.length); i++) {
    const big = r.chance(0.35);
    k.sub(planesU[i], vT1 + 26 + (big ? 32 : 22), -Math.PI / 2, () => plane(k, B, big ? 62 : 38, PAINT[liveries[i % 3]]));
  }
  k.sub(-len / 2 + 120, vTx, 0, () => plane(k, B, 44, PAINT[liveries[0]]));
}

/** An airliner, nose towards local +u: fuselage, wings, tail, engines, landing gear. */
function plane(k: Kit, B: number, L: number, livery: RGB): void {
  const R = L * 0.055, y = B + R + 1.6 + L * 0.01;
  const body = mat(PANEL, [1.05, 1.05, 1.05], WIN, 1.0, R * 1.2, R * 0.9);
  const tail = mat(PANEL, livery);
  k.tube(0, 0, y, L * 0.4, R, R, body, { solid: true, map: 1 });
  k.tube(L * 0.45, 0, y - R * 0.1, L * 0.05, R, R * 0.3, body);
  k.tube(-L * 0.46, 0, y + R * 0.25, L * 0.06, R * 0.35, R, body);
  // Wings (swept), tailplane, fin.
  const span = L * 0.55;
  for (const s of [-1, 1]) {
    k.box(-L * 0.04, s * span * 0.27, L * 0.09, span * 0.25, y - R * 0.55, y - R * 0.4, body, { rot: s * 0.45, solid: false });
    k.box(-L * 0.45, s * L * 0.1, L * 0.04, L * 0.09, y + R * 0.2, y + R * 0.3, body, { rot: s * 0.5, solid: false });
    k.tube(L * 0.04, s * span * 0.2, y - R * 1.05, L * 0.05, R * 0.45, R * 0.42, mat(METAL, [0.85, 0.86, 0.9]), { detail: false });
    k.box(-L * 0.02, s * R * 0.8, 0.2, 0.2, B, y - R * 0.6, mat(METAL, [0.3, 0.3, 0.3]), { detail: true, solid: false });
  }
  k.box(-L * 0.44, 0, L * 0.06, 0.25, y + R * 0.6, y + R + L * 0.15, tail, { solid: false });
  k.box(L * 0.4, 0, 0.15, 0.15, B, y - R * 0.7, mat(METAL, [0.3, 0.3, 0.3]), { detail: true, solid: false });
  // A livery stripe along the body (near only).
  for (const s of [-1, 1]) k.box(0, s * R * 1.0, L * 0.36, 0.04, y - R * 0.15, y + R * 0.05, tail, { detail: true, solid: false });
}

/** Access road: draped quads along the polyline. */
function road(k: Kit, pts: number[]): void {
  const m = mat(TAR, [0.5, 0.5, 0.52]), hw = 5.5;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1) continue;
    const nx = -(bz - az) / L * hw, nz = (bx - ax) / L * hw;
    const n = Math.ceil(L / 12);
    for (let s = 0; s < n; s++) {
      const t0 = s / n, t1 = (s + 1) / n;
      const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0, x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
      const h = (x: number, z: number) => k.T.height(x, z) + 0.12;
      k.quad([x0 - nx, h(x0 - nx, z0 - nz), z0 - nz, x1 - nx, h(x1 - nx, z1 - nz), z1 - nz, x1 + nx, h(x1 + nx, z1 + nz), z1 + nz, x0 + nx, h(x0 + nx, z0 + nz), z0 + nz], m);
    }
  }
}

// ------------------------------------------------------------------------ API

const cache = new WeakMap<Landmark, LmPart[]>();

/** The parts of a landmark (cached per landmark object). */
export function landmarkParts(lm: Landmark, terrain: Terrain): LmPart[] {
  let parts = cache.get(lm);
  if (parts) return parts;
  const k = new Kit(lm, terrain);
  const r = new Rng(lm.seed);
  switch (lm.kind) {
    case 'townhall': townhall(k, lm, r); break;
    case 'stadium': stadium(k, lm, r); break;
    case 'tower': tower(k, lm, r); break;
    case 'cathedral': cathedral(k, lm, r); break;
    case 'wheel': wheel(k, lm, r); break;
    case 'monument': monument(k, lm, r); break;
    case 'museum': museum(k, lm, r); break;
    case 'lighthouse': lighthouse(k, lm, r); break;
    case 'fortress': fortress(k, lm, r); break;
    case 'glasshouse': glasshouse(k, lm, r); break;
    case 'airport': airport(k, lm, r); if (lm.road) road(k, lm.road); break;
    case 'marvel': marvel(k, lm, r); break;
  }
  parts = k.parts;
  cache.set(lm, parts);
  if (k.inside.rooms.length) insideCache.set(lm, k.inside);
  return parts;
}

const insideCache = new WeakMap<Landmark, LmInterior>();

/** The landmark's walkable inside (the town hall), or null. */
export function landmarkInterior(lm: Landmark, terrain: Terrain): LmInterior | null {
  landmarkParts(lm, terrain);
  return insideCache.get(lm) ?? null;
}

/** Collision solids of the parts (boxes and cylinders, with their bottom and top). */
export function partObstacles(parts: LmPart[]): PartObstacle[] {
  const out: PartObstacle[] = [];
  for (const p of parts) {
    if (!p.solid) continue;
    const first = out.length;
    obstaclesOf(p, out);
    if (p.deck) for (let i = first; i < out.length; i++) out[i].deck = true;
  }
  return out;
}

function obstaclesOf(p: LmPart, out: PartObstacle[]): void {
  const y0 = Math.min(p.y0, p.foot ?? p.y0);
    const ux = Math.cos(p.a), uz = Math.sin(p.a);
    switch (p.k) {
      case PK.Cyl: case PK.Dome: {
        const r = p.k === PK.Cyl ? Math.max(p.r ?? 0, p.r2 ?? 0) : Math.max(p.hx, p.hz) * 0.9;
        out.push({ cyl: true, x: p.x, z: p.z, r, hx: r, hz: r, ux, uz, y0, y1: Math.max(p.y0, p.y1) });
        break;
      }
      case PK.Beam: case PK.Strut: {
        const dx = p.bx! - p.x, dz = p.bz! - p.z, L = Math.hypot(dx, dz) || 1;
        out.push({ cyl: false, x: (p.x + p.bx!) / 2, z: (p.z + p.bz!) / 2, r: 0, hx: L / 2, hz: p.w!, ux: dx / L, uz: dz / L, y0: Math.min(p.y0, p.by!) - p.w!, y1: Math.max(p.y0, p.by!) + p.w! });
        break;
      }
      case PK.Quad: case PK.Flat: case PK.Helix: break; // (the helix: world/LandmarkSolids, analytically)
      case PK.Lathe: latheObstacles(p, out); break;
      case PK.Prism: prismObstacles(p, out); break;
      case PK.Perf: perfObstacles(p, out); break;
      default:
        out.push({ cyl: false, x: p.x, z: p.z, r: 0, hx: Math.max(p.hx, p.hx2 ?? 0), hz: p.hz, ux, uz, y0, y1: p.y1, ...(p.pane ? { pane: true } : {}) });
    }
}

/** Is a lathe profile closed (a ring)? */
export function latheClosed(P: number[]): boolean {
  const n = P.length;
  return n >= 6 && Math.abs(P[0] - P[n - 2]) < 1e-6 && Math.abs(P[1] - P[n - 1]) < 1e-6;
}

/**
 * A lathe as solids: a ring (closed profile) as boxes around it, anything else as a stack of
 * cylinders (boxes when clearly elliptical), one per profile step, of the step's mean radius.
 */
function latheObstacles(p: LmPart, out: PartObstacle[]): void {
  const P = p.pts!, ux = Math.cos(p.a), uz = Math.sin(p.a), sx = p.hx, sz = p.hz;
  const ell = Math.max(sx, sz) / Math.max(1e-6, Math.min(sx, sz)) > 1.25;
  if (latheClosed(P)) {
    let r0 = Infinity, r1 = 0, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < P.length; i += 2) { r0 = Math.min(r0, P[i]); r1 = Math.max(r1, P[i]); y0 = Math.min(y0, P[i + 1]); y1 = Math.max(y1, P[i + 1]); }
    const rm = (r0 + r1) / 2, n = 28;
    for (let k = 0; k < n; k++) {
      const t = ((k + 0.5) / n) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
      // Tangent of the (possibly elliptical) ring at t, in the part frame, then in the world.
      const lu = c * rm * sx, lv = s * rm * sz, tu = -s * sx, tv = c * sz, tl = Math.hypot(tu, tv);
      const wx = p.x + lu * ux - lv * uz, wz = p.z + lu * uz + lv * ux;
      const dx = (tu * ux - tv * uz) / tl, dz = (tu * uz + tv * ux) / tl;
      const chord = (Math.PI * 2 * rm * Math.max(sx, sz)) / n;
      out.push({ cyl: false, x: wx, z: wz, r: 0, hx: chord / 2 + 0.3, hz: ((r1 - r0) / 2) * Math.min(sx, sz), ux: dx, uz: dz, y0, y1 });
    }
    return;
  }
  for (let i = 0; i + 3 < P.length; i += 2) {
    const ya = Math.min(P[i + 1], P[i + 3]), yb = Math.max(P[i + 1], P[i + 3]);
    const r = (P[i] + P[i + 2]) / 2;
    if (yb - ya < 0.05 || r < 0.4) continue;
    if (ell) out.push({ cyl: false, x: p.x, z: p.z, r: 0, hx: r * sx * 0.85, hz: r * sz * 0.85, ux, uz, y0: ya, y1: yb });
    else out.push({ cyl: true, x: p.x, z: p.z, r: r * Math.min(sx, sz), hx: 0, hz: 0, ux, uz, y0: ya, y1: yb });
  }
}

/** Extent along u of a closed (u, y) outline between heights ya and yb, or null. */
function bandExtent(P: number[], ya: number, yb: number): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  const n = P.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, au = P[i * 2], ay = P[i * 2 + 1], bu = P[j * 2], by = P[j * 2 + 1];
    if (ay >= ya && ay <= yb) { lo = Math.min(lo, au); hi = Math.max(hi, au); }
    for (const y of [ya, yb]) if ((ay - y) * (by - y) < 0) { const u = au + ((bu - au) * (y - ay)) / (by - ay); lo = Math.min(lo, u); hi = Math.max(hi, u); }
  }
  return hi - lo > 0.05 ? [lo, hi] : null;
}

/** A prism as a stack of boxes, each spanning the outline's width in its height band. */
function prismObstacles(p: LmPart, out: PartObstacle[]): void {
  const P = p.pts!, ux = Math.cos(p.a), uz = Math.sin(p.a);
  const n = Math.max(1, Math.min(24, Math.ceil((p.y1 - p.y0) / 6)));
  for (let b = 0; b < n; b++) {
    const ya = p.y0 + ((p.y1 - p.y0) * b) / n, yb = p.y0 + ((p.y1 - p.y0) * (b + 1)) / n;
    const e = bandExtent(P, ya, yb);
    if (!e) continue;
    const um = (e[0] + e[1]) / 2;
    out.push({ cyl: false, x: p.x + um * ux, z: p.z + um * uz, r: 0, hx: (e[1] - e[0]) / 2, hz: p.hz, ux, uz, y0: ya, y1: yb });
  }
}

/** Share of a hole's radius kept open in the collision (the square inside the circle, a little more). */
const HOLE_OPEN = 0.74;

/** A pierced slab as boxes around its holes (one can fly or walk through them). */
function perfObstacles(p: LmPart, out: PartObstacle[]): void {
  const H = p.pts!, ux = Math.cos(p.a), uz = Math.sin(p.a);
  const y0 = Math.min(p.y0, p.foot ?? p.y0);
  const ys = [y0, p.y1];
  for (let i = 0; i < H.length; i += 3) ys.push(H[i + 1] - H[i + 2] * HOLE_OPEN, H[i + 1] + H[i + 2] * HOLE_OPEN);
  ys.sort((a, b) => a - b);
  for (let k = 0; k + 1 < ys.length; k++) {
    const ya = ys[k], yb = ys[k + 1], ym = (ya + yb) / 2;
    if (yb - ya < 0.05) continue;
    const cut: [number, number][] = [];
    for (let i = 0; i < H.length; i += 3) if (Math.abs(ym - H[i + 1]) < H[i + 2] * HOLE_OPEN) cut.push([H[i] - H[i + 2] * HOLE_OPEN, H[i] + H[i + 2] * HOLE_OPEN]);
    cut.sort((a, b) => a[0] - b[0]);
    let u = -p.hx;
    const put = (a: number, b: number) => { if (b - a > 0.05) out.push({ cyl: false, x: p.x + ((a + b) / 2) * ux, z: p.z + ((a + b) / 2) * uz, r: 0, hx: (b - a) / 2, hz: p.hz, ux, uz, y0: ya, y1: yb }); };
    for (const [a, b] of cut) { put(u, a); u = Math.max(u, b); }
    put(u, p.hx);
  }
}

/** Walkway slab thickness of a helix (the mesh; the solid is a little thicker). */
export const HELIX_SLAB = 0.5;

/** Floor height of a helix at turn angle φ from its start (0 … 2π·|turns|). */
export function helixFloorAt(p: LmPart, phi: number): number {
  const full = Math.abs(p.turns!) * Math.PI * 2;
  return p.y0 + ((p.y1 - p.y0) * phi) / full;
}

/**
 * Floor heights of a helix over the world point (x, z) (one per turn passing over it, lowest
 * first), or none when the point is off the walkway's annulus (grown by m).
 */
export function helixFloorsAt(p: LmPart, x: number, z: number, m = 0, out: number[] = []): number[] {
  out.length = 0;
  const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz);
  if (d < p.r! - m || d > p.r2! + m) return out;
  const sg = p.turns! < 0 ? -1 : 1, full = Math.abs(p.turns!) * Math.PI * 2, T = Math.PI * 2;
  let phi = (sg * (Math.atan2(dz, dx) - p.a)) % T;
  if (phi < 0) phi += T;
  for (; phi <= full; phi += T) out.push(helixFloorAt(p, phi));
  return out;
}

/** Outline of a part on the ground (CCW), grown by m; null for parts without one. */
export function partOutline(p: LmPart, m = 0): Poly | null {
  const c = Math.cos(p.a), s = Math.sin(p.a);
  const P = (u: number, v: number) => [p.x + u * c - v * s, p.z + u * s + v * c];
  switch (p.k) {
    case PK.Cyl: case PK.Dome: {
      // (A dome may be elliptical: radii hx along u, hz along v.)
      const rx = (p.k === PK.Cyl ? Math.max(p.r ?? 0, p.r2 ?? 0) : p.hx) + m, rz = (p.k === PK.Cyl ? rx - m : p.hz) + m;
      const out: number[] = [];
      for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; out.push(...P(Math.cos(a) * rx, Math.sin(a) * rz)); }
      return out;
    }
    case PK.Ramp: {
      if (p.q && p.q.length === 8) {
        if (m === 0) return p.q.slice();
        const cx = (p.q[0] + p.q[2] + p.q[4] + p.q[6]) / 4, cz = (p.q[1] + p.q[3] + p.q[5] + p.q[7]) / 4;
        return p.q.map((v, i) => { const c0 = i % 2 ? cz : cx, d = Math.hypot(p.q![i - (i % 2)] - cx, p.q![i - (i % 2) + 1] - cz) || 1; return v + ((v - c0) / d) * m; });
      }
      const a = p.hx + m, b = (p.hx2 ?? p.hx) + m, h = p.hz + m;
      return [...P(-a, -h), ...P(a, -h), ...P(b, h), ...P(-b, h)];
    }
    case PK.Quad: return [p.q![0], p.q![2], p.q![3], p.q![5], p.q![6], p.q![8], p.q![9], p.q![11]];
    case PK.Beam: case PK.Strut: return null;
    case PK.Lathe: case PK.Helix: {
      let rm = 0;
      if (p.k === PK.Helix) rm = p.r2!;
      else for (let i = 0; i < p.pts!.length; i += 2) rm = Math.max(rm, p.pts![i]);
      const sx = p.k === PK.Lathe ? p.hx : 1, sz = p.k === PK.Lathe ? p.hz : 1;
      const out: number[] = [];
      for (let i = 0; i < 20; i++) { const a = (i / 20) * Math.PI * 2; out.push(...P(Math.cos(a) * (rm * sx + m), Math.sin(a) * (rm * sz + m))); }
      return out;
    }
    case PK.Prism: {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < p.pts!.length; i += 2) { lo = Math.min(lo, p.pts![i]); hi = Math.max(hi, p.pts![i]); }
      return [...P(lo - m, -p.hz - m), ...P(hi + m, -p.hz - m), ...P(hi + m, p.hz + m), ...P(lo - m, p.hz + m)];
    }
    default: return [...P(-p.hx - m, -p.hz - m), ...P(p.hx + m, -p.hz - m), ...P(p.hx + m, p.hz + m), ...P(-p.hx - m, p.hz + m)];
  }
}

/** Ground footprints of the solid parts standing on the site (for the cell planner), grown by m. */
export function solidFootprints(lm: Landmark, parts: LmPart[], m = 0.8): Poly[] {
  const out: Poly[] = [];
  for (const p of parts) {
    if ((!p.solid && !p.footprint) || p.k === PK.Beam || p.k === PK.Strut) continue;
    if (Math.min(p.y0, p.foot ?? p.y0) > lm.base + 2.5) continue; // up in the air
    const o = partOutline(p, m);
    if (o) out.push(o);
  }
  return out;
}

/** Map footprints: [category, outline] for every part with a map category (largest first). */
export function partFootprints(parts: LmPart[]): { cat: number; poly: Poly }[] {
  const out: { cat: number; poly: Poly; area: number }[] = [];
  for (const p of parts) {
    if (!p.map || (p.detail && !p.hidden)) continue;
    const o = partOutline(p);
    if (!o) continue;
    let a = 0;
    for (let i = 0, n = o.length >> 1, j = n - 1; i < n; j = i++) a += o[j * 2] * o[i * 2 + 1] - o[i * 2] * o[j * 2 + 1];
    out.push({ cat: p.map, poly: o, area: Math.abs(a) });
  }
  // Paving under buildings: draw the big flat areas first.
  out.sort((a, b) => (a.cat === 1 ? 1 : 0) - (b.cat === 1 ? 1 : 0) || b.area - a.area);
  return out;
}
