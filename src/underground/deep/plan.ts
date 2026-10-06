/**
 * The deep realm under a city (pure data, deterministic per seed): where the slimes really live.
 *
 *  - Roads: from a hidden colony's chamber a neck (roomy enough for a camera behind the player)
 *    widens into a broad descending gallery — spiralling down where the way is short — to the
 *    Great Hall. Colonies within reach each get their road; the others stay outposts.
 *  - The Glow (Lumen, ~60 m down): the Great Hall, a domed cavern with terraced slopes covered in
 *    dwellings round a pool and the Spire (a rock column ringed with fungus shelves); the Gardens
 *    (a forest of giant mushrooms), the Lake (a falls from a crack in the vault), the Archive
 *    (their collection of surface things, and the mosaics).
 *  - The Front: a gallery where the Lumen hold their trench line against the Murk coming up out of
 *    the Throat — sandbagged bays with gaps between them, a belt of thorn wire, a cratered no-man's
 *    land and the Murk's own berm at the lip. The Throat is a shaft 50 m deep with a ramp
 *    spiralling down its wall and a natural bridge across it.
 *  - The Deep (Murk, ~110 m down): the Warrens (crystal spikes, hives, pens with captured Lumen)
 *    and the Heart chamber, where a shard of the falling star sits on a mound, veins running from it.
 *
 * The rock is one signed distance field (field.ts); this module lays out its shapes, the things
 * standing in it (decor), the light sources baked into the rock, and a waypoint graph the slimes
 * walk. Frame: origin O at the Hall's centre, u along the realm's axis, v across.
 */
import { Rng, deriveSeed } from '../../core/rng';
import type { Colony } from '../rooms';
import { DeepField, primBounds, type Prim } from './field';

export type DecorKind =
  | 'dwelling' | 'mushroom' | 'fungus' | 'stalag' | 'stalac' | 'crystal' | 'murkCrystal' | 'shelf' | 'stone'
  | 'strand' | 'hive' | 'pen' | 'post' | 'cans' | 'phone' | 'wheel' | 'keys' | 'egg' | 'bone'
  | 'sack' | 'duck' | 'wire' | 'stain' | 'husk' | 'stake';

/** A thing standing in the caves: kind, position (floor), size, yaw, colour index (palette), region. */
export interface Decor { k: DecorKind; x: number; y: number; z: number; s: number; h: number; yaw: number; c: number; reg: number; tilt?: number }

export interface Road {
  colony: number;
  /** Floor points along the centreline (x, y, z each), from the gate to the Hall. */
  pts: number[];
  /** Where the neck leaves the chamber (the colony's way into the realm): centre, facing (out of the chamber), radius. */
  gate: { x: number; y: number; z: number; nx: number; nz: number; r: number };
  /** The opening cut into the chamber wall (chamber frame): which wall ('u+', 'v+', 'v-'), centre along it (v on u+, u on the side walls), half width, height. */
  hole: { wall: 'u+' | 'v+' | 'v-'; c: number; hw: number; h: number };
  /** Spiral section (the Spiral Road): centre and radius, or null. */
  spiral: { x: number; z: number; r: number } | null;
}

export interface NavNode { id: number; name: string; x: number; y: number; z: number; r: number }

export interface Water { x: number; y: number; z: number; rx: number; rz: number; yaw: number; reg: number }
export interface Falls { x: number; z: number; y0: number; y1: number; w: number; nx: number; nz: number }

export interface DeepPlan {
  seed: number;
  /** Hub colony (the Hall lies beyond it). */
  hub: number;
  /** Realm frame: origin, axis. */
  ox: number; oz: number; ux: number; uz: number;
  /** Floor levels: the Glow (Hall base) and the Deep. */
  yGlow: number; yDeep: number;
  prims: Prim[];
  roads: Road[];
  decor: Decor[];
  /** Baked light sources: x, y, z, r, g, b, radius per entry (flattened). */
  glows: number[];
  water: Water[];
  falls: Falls[];
  /** Named places (the slimes' work and the player's landmarks). */
  places: Record<string, { x: number; y: number; z: number; r: number }>;
  /** Pens in the Warrens (captured Lumen). */
  pens: { x: number; y: number; z: number; r: number }[];
  /** Hives of the Murk. */
  hives: { x: number; y: number; z: number; r: number }[];
  /** Dwellings in the Hall (the Lumen live and hide there). */
  dwellings: { x: number; y: number; z: number; r: number; h: number; yaw: number }[];
  /** The helix ramp down the Throat: centre, centreline radius, top at the lip, slope (dy per m), start angle, length. */
  ramp: { cx: number; cz: number; rc: number; y0: number; slope: number; a0: number; len: number; hw: number };
  /** The Lumen lift (a column of rising motes up the Throat). */
  lift: { x: number; z: number; y0: number; y1: number; r: number };
  /** Archive mosaics: centre, inward normal, size. */
  mosaics: { x: number; y: number; z: number; nx: number; nz: number; w: number; h: number }[];
  /** The Front's trench war: its frame and lines (see `Trench`). */
  trench: Trench;
  /** The Heart: the star shard on its mound. */
  heart: { x: number; y: number; z: number };
  /** Waypoint graph: nodes and edges (index pairs). */
  nodes: NavNode[];
  edges: [number, number][];
  /** Glowing veins on the floor of the Deep (polylines x, y, z …). */
  veins: number[][];
}

/**
 * The Front as a battlefield. Frame: origin (x, z) where the gallery leaves the Hall, `a` along it
 * towards the Throat, `c` across; distances `s` along, `l` across (m), floor height y.
 *  - The Lumen's trench at `s`: dug bays (l0, l1) a metre deep behind sandbagged parapets, with
 *    gaps between them (`gaps`: l of each) where the Murk try to get through; `posts` are the
 *    fighting spots in the bays, `gapPosts` the spots guarding the gaps.
 *  - Thorn wire across `wire` (s band): it holds the Murk up under fire.
 *  - No-man's land over `noMans` (s band), pitted with craters.
 *  - The Murk's berm at `murkS`, by the lip of the Throat, where they gather to go over.
 */
export interface Trench {
  x: number; y: number; z: number;
  ax: number; az: number; cx: number; cz: number;
  s: number;
  segs: [number, number][];
  gaps: number[];
  posts: { x: number; y: number; z: number }[];
  gapPosts: { x: number; y: number; z: number }[];
  wire: [number, number];
  noMans: [number, number];
  craters: { x: number; z: number; r: number }[];
  murkS: number;
}

/** Tests a point against what is already underground (tunnels, rooms) and the ground above (cover). */
export type Blocked = (x: number, y: number, z: number) => boolean;

/** Depth of the Hall's base under the lowest ground over the realm (m); the Deep lies this much lower again. */
export const GLOW_DEPTH = 64, DEEP_DROP = 52;
/** Road gallery: radius, share of the radius the floor lies under the axis, steepest grade. */
const ROAD_R = 5.2, ROAD_FLAT = 0.5, ROAD_GRADE = 0.16;
const NECK_R = 2.3, NECK_FLAT = 0.42, NECK_GRADE = 0.3;
/** Farthest colony that gets a road (m from the Hall). */
const ROAD_REACH = 950;

export interface PlanInput {
  seed: number;
  colonies: Colony[];
  /** Ground height. */
  ground: (x: number, z: number) => number;
  blocked: Blocked;
  /** Debug: why a try failed. */
  why?: (reason: string) => void;
}

/**
 * Plan the realm. Tries hub colonies and axis directions until the whole realm lies deep under the
 * ground and its roads clear of everything else; null when no colony can host it.
 */
export function planDeep(inp: PlanInput): DeepPlan | null {
  const { colonies } = inp;
  if (!colonies.length) return null;
  const rng = new Rng(deriveSeed(inp.seed, 'deep'));
  // The colony nearest the city centre hosts the Hall first.
  const order = colonies.slice().sort((a, b) => Math.hypot(a.chamber.cx, a.chamber.cz) - Math.hypot(b.chamber.cx, b.chamber.cz));
  for (const hub of order) {
    const base = Math.atan2(hub.chamber.uz, hub.chamber.ux);
    const turns = [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6, Math.PI];
    const jitter = rng.range(-0.25, 0.25);
    for (const t of turns) {
      for (const dist of [150, 190, 120]) {
        const p = tryPlan(inp, hub, base + t + jitter, dist, rng.nextU32());
        if (p) return p;
      }
    }
  }
  return null;
}

type V = { x: number; y: number; z: number };

function tryPlan(inp: PlanInput, hub: Colony, ang: number, dist: number, seed: number): DeepPlan | null {
  const rng = new Rng(seed);
  const ux = Math.cos(ang), uz = Math.sin(ang);
  const ch = hub.chamber;
  const ox = ch.cx + ux * dist, oz = ch.cz + uz * dist;
  const W = (u: number, v: number): [number, number] => [ox + ux * u - uz * v, oz + uz * u + ux * v];
  // Ground over the realm: the lowest within its footprint (u −80…350, v −110…110).
  let gTop = Infinity;
  for (let u = -90; u <= 350; u += 20) for (let v = -110; v <= 110; v += 20) {
    const [x, z] = W(u, v);
    gTop = Math.min(gTop, inp.ground(x, z));
  }
  const yc = ch.y0;
  const L1 = Math.min(gTop - GLOW_DEPTH, yc - 34);
  const L2 = L1 - DEEP_DROP;
  const prims: Prim[] = [];
  const P = (t: Prim['t'], rock: boolean, k: number, n: number, reg: number, a: number[]) => { prims.push({ t, rock, k, n, a, reg }); };
  const yawW = ang;
  /** A gallery between floor points (a capsule / cone with a flat floor). */
  const gallery = (a: V, b: V, ra: number, rb: number, reg: number, n = 0.8, k = 3, flat = 0.45) => {
    P('cap', false, k, n, reg, [a.x, a.y + ra * flat, a.z, b.x, b.y + rb * flat, b.z, ra, rb, flat]);
  };
  const at = (u: number, v: number, y: number): V => { const [x, z] = W(u, v); return { x, y, z }; };

  // ---------------------------------------------------------------- the Glow
  const hallRx = 58, hallRz = 46;
  P('ell', false, 0, 1.1, 1, [ox, L1 + 8, oz, hallRx, 30, hallRz, yawW, L1 - 3]);
  // Terraced slopes rising to the walls.
  const steps = 4, stepH = 2.2;
  P('bowl', true, 1.2, 0.35, 1, [ox, oz, yawW, hallRx, hallRz, L1, 0.42, steps, stepH, 0.62]);
  const rimY = L1 + steps * stepH;
  /** The terraced floor at a local point (as the bowl shape lays it). */
  const hallFloor = (u: number, v: number) => L1 + terraceH(Math.hypot(u / hallRx, v / hallRz), 0.42, steps, stepH, 0.62);
  // The pool (after the terraces: carved into the floor).
  const pool = at(-8, 10, L1);
  P('ell', false, 1.0, 0.1, 1, [pool.x, L1 + 0.1, pool.z, 13, 1.25, 9, yawW + 0.4, -1e9]);
  // The Spire: a rock column flaring into floor and vault.
  const spire = at(15, -9, L1);
  P('cap', true, 4.5, 0.7, 1, [spire.x, L1 - 2, spire.z, spire.x, L1 + 44, spire.z, 5.2, 3.0, 0]);
  // Hanging rock masses in the vault.
  for (const [u, v, s] of [[-28, 14, 7], [30, 20, 6], [-6, -26, 5]]) { const p = at(u, v, 0); P('ell', true, 3, 1.2, 1, [p.x, L1 + 36, p.z, s, s * 1.4, s, 0, -1e9]); }
  // The Gardens.
  const gC = at(46, -66, 0);
  P('ell', false, 2, 1.0, 1, [gC.x, L1 + 10, gC.z, 30, 16, 24, yawW + 0.5, L1 + 2]);
  gallery(at(30, -33, hallFloor(30, -33) - 0.3), at(42, -54, L1 + 2), 7.5, 7, 1, 0.9, 4);
  // The Lake.
  const lC = at(-34, 72, 0);
  P('ell', false, 2, 1.1, 1, [lC.x, L1 + 7, lC.z, 36, 17, 26, yawW - 0.3, L1 - 1.6]);
  gallery(at(-18, 36, hallFloor(-18, 36) - 0.3), at(-30, 58, L1 - 1.2), 7.5, 7.5, 1, 0.9, 4);
  // The Archive: an alcove at the top terrace.
  const aC = at(-64, -20, 0);
  P('ell', false, 2.5, 0.6, 1, [aC.x, rimY + 3.5, aC.z, 13, 7, 9, yawW + 0.35, rimY]);

  // ---------------------------------------------------------------- the Front and the Throat
  const frontY = hallFloor(50, 14) - 0.2;
  const fA = at(50, 14, frontY), fB = at(114, 28, frontY);
  gallery(fA, fB, 8.5, 8.5, 2, 1.0, 4);
  const tC = at(142, 32, 0);
  const R = 26;
  P('cyl', false, 3, 1.0, 2, [tC.x, tC.z, L2 - 1, frontY + 14, R]);
  P('ell', false, 4, 1.0, 2, [tC.x, frontY + 12, tC.z, R + 4, 12, R + 4, 0, -1e9]);
  // The ramp: from the lip where the Front comes in, down the wall to the floor of the Deep.
  const hw = 3.6, rc = R - hw + 0.6, slope = -0.2;
  const a0 = Math.atan2(fB.z - tC.z, fB.x - tC.x);
  const len = (frontY - (L2 - 0.6)) / -slope;
  // A landing at the lip (where the gallery meets the ramp), level with both.
  const lip = { x: tC.x + Math.cos(a0) * rc, y: frontY, z: tC.z + Math.sin(a0) * rc };
  // The natural bridge across the shaft, a sixth of a turn down, to a lookout niche opposite.
  const sB = 26, aB = a0 + sB / rc, yB = frontY + slope * sB;
  const bA = { x: tC.x + Math.cos(aB) * (rc - 1), z: tC.z + Math.sin(aB) * (rc - 1) };
  const bE = { x: tC.x - Math.cos(aB) * (R + 2), z: tC.z - Math.sin(aB) * (R + 2) };
  const look = { x: tC.x - Math.cos(aB) * (R + 5), z: tC.z - Math.sin(aB) * (R + 5) };

  // ---------------------------------------------------------------- the Deep
  const wC = at(214, 22, 0);
  P('ell', false, 4, 1.25, 3, [wC.x, L2 + 7, wC.z, 64, 17, 48, yawW + 0.1, L2 - 1]);
  // Pillars holding the low vault.
  const pillars: V[] = [];
  for (const [u, v, r] of [[196, -8, 3.6], [232, 34, 4.2], [250, -14, 3.2], [206, 50, 3.5], [258, 30, 3]]) {
    const p = at(u, v, 0);
    pillars.push({ x: p.x, y: r, z: p.z });
    P('cap', true, 3, 1.0, 3, [p.x, L2 - 2, p.z, p.x, L2 + 26, p.z, r, r * 0.8, 0]);
  }
  const hC = at(304, -12, 0);
  P('ell', false, 3, 1.0, 3, [hC.x, L2 + 12, hC.z, 32, 26, 30, yawW, L2 - 3]);
  gallery(at(268, 6, L2 - 1), at(284, -4, L2 - 2.6), 9, 9, 3, 1.1, 4);
  // The mound under the Heart.
  P('ell', true, 2.5, 0.4, 3, [hC.x, L2 - 3, hC.z, 7.5, 4.2, 7.5, 0, -1e9]);
  // Rock and air of the Throat that the Deep's caverns must not undo: the ramp, the bridge, the lookout.
  P('helix', true, 0.8, 0.25, 2, [tC.x, tC.z, rc, hw, 3.2, frontY, slope, a0, len]);
  P('cap', true, 1.5, 0.35, 2, [bA.x, yB - 1.6, bA.z, bE.x, yB - 1.6, bE.z, 1.65, 1.65, 0]);
  P('ell', false, 2, 0.7, 2, [look.x, yB + 2.2, look.z, 6, 4.2, 6, aB, yB + 0.05]);

  // ---------------------------------------------------------------- the trench war at the Front
  // Gallery frame: s along from fA towards the Throat, l across.
  const gLen = Math.hypot(64, 14), gdu = 64 / gLen, gdv = 14 / gLen;
  const tAx = ux * gdu - uz * gdv, tAz = uz * gdu + ux * gdv, tCx = -tAz, tCz = tAx;
  const G = (s: number, l: number) => ({ x: fA.x + tAx * s + tCx * l, y: frontY, z: fA.z + tAz * s + tCz * l });
  const across = Math.atan2(tCz, tCx);
  const TS = 33;
  const segs: [number, number][] = [[-7.8, -3.1], [-1.1, 2.5], [4.5, 7.9]];
  const gaps = [-2.1, 3.5];
  for (const [l0, l1] of segs) {
    const m = G(TS, (l0 + l1) / 2), q = G(TS + 1.4, (l0 + l1) / 2), hl = (l1 - l0) / 2;
    // The bay: a metre deep, its lips worn round.
    P('box', false, 0.45, 0.25, 2, [m.x, frontY - 0.25, m.z, hl, 0.75, 0.85, across]);
    // The parapet in front of it (sandbags go on top).
    P('box', true, 0.3, 0.15, 2, [q.x, frontY + 0.2, q.z, hl + 0.25, 0.65, 0.45, across]);
  }
  // The Throat's lip in the frame: the Murk's berm a few metres short of it, open where they come up.
  const lipS = (lip.x - fA.x) * tAx + (lip.z - fA.z) * tAz, lipL = Math.max(-4, Math.min(4, (lip.x - fA.x) * tCx + (lip.z - fA.z) * tCz));
  const murkS = Math.min(58, lipS - 6);
  for (const [l0, l1] of [[-7.5, lipL - 1.8], [lipL + 1.8, 7.5]]) {
    if (l1 - l0 < 1.5) continue;
    const m = G(murkS, (l0 + l1) / 2);
    P('box', true, 0.5, 0.45, 2, [m.x, frontY + 0.05, m.z, (l1 - l0) / 2, 0.6, 0.7, across]);
  }
  // Craters in no-man's land (not on the line the Murk come over by).
  const noMans: [number, number] = [41, murkS - 3];
  const craters: Trench['craters'] = [];
  for (let i = 0; i < 40 && craters.length < 8; i++) {
    const s = rng.range(noMans[0] + 1, noMans[1]), l = rng.range(-6.2, 6.2), r = rng.range(1.5, 2.9);
    if (l + r > -0.6 && l - r < 2.2) continue;
    const c = G(s, l);
    if (craters.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < o.r + r - 0.6)) continue;
    craters.push({ x: c.x, z: c.z, r });
    const d = rng.range(0.45, 0.8);
    P('ell', false, 1.0, 0.35, 2, [c.x, frontY - d + r * 0.45, c.z, r, r * 0.45, r, 0, -1e9]);
  }

  // ---------------------------------------------------------------- roads
  const realmPrims = prims.slice();
  const roads: Road[] = [];
  const hubRoad = planRoad(inp, hub, ox, oz, ux, uz, hallRx, hallRz, hallFloor, prims, true, rng);
  if (!hubRoad) { inp.why?.('hub road'); return null; }
  roads.push(hubRoad);
  for (const c of inp.colonies) {
    if (c === hub) continue;
    if (Math.hypot(c.chamber.cx - ox, c.chamber.cz - oz) > ROAD_REACH) continue;
    const r = planRoad(inp, c, ox, oz, ux, uz, hallRx, hallRz, hallFloor, prims, false, rng);
    if (r) roads.push(r);
  }

  const field = new DeepField(prims, seed);
  // Deep enough everywhere: the realm's air stays well under the ground (sampled).
  for (const p of realmPrims) {
    if (p.rock) continue;
    const b = boundsOf(p);
    for (let x = b[0]; x <= b[3]; x += 12) for (let z = b[2]; z <= b[5]; z += 12) {
      if (inp.ground(x, z) - 14 < b[4] && field.air(x, Math.min(b[4], inp.ground(x, z) - 14), z)) { inp.why?.('cover'); return null; }
    }
  }
  // Clear of everything else underground (the realm itself is deep: spot checks on a grid).
  for (const p of realmPrims) {
    if (p.rock) continue;
    const b = boundsOf(p);
    for (let x = b[0]; x <= b[3]; x += 9) for (let z = b[2]; z <= b[5]; z += 9) for (let y = b[1]; y <= b[4]; y += 6) {
      if (field.sdf(x, y, z) < 0.5 && inp.blocked(x, y, z)) { inp.why?.('blocked'); return null; }
    }
  }

  // ---------------------------------------------------------------- places, decor, light
  const floorNear = (x: number, y: number, z: number): number | null => {
    for (const up of [2.5, 6, 12, 1]) { const f = field.floorAt(x, y + up, z, up + 12); if (f !== null) return f; }
    return null;
  };
  const F = (u: number, v: number, yGuess: number): V | null => { const [x, z] = W(u, v); const y = floorNear(x, yGuess, z); return y === null ? null : { x, y, z }; };
  const places: DeepPlan['places'] = {};
  const place = (name: string, u: number, v: number, yGuess: number, r: number) => {
    const p = F(u, v, yGuess);
    if (p) places[name] = { ...p, r };
    return p;
  };
  place('hall', -6, -12, L1, 12);
  place('pool', -8, 10, L1, 8);
  place('spire', 23, -9, L1 + 3, 6);
  place('council', -26, -20, L1 + 3, 5);
  place('nursery', 24, 22, L1 + 3, 6);
  place('archive', -64, -20, rimY + 1, 6);
  place('gardens', 46, -66, L1 + 3, 14);
  place('lake', -40, 64, L1, 12);
  place('front', 72, 18, frontY, 6);
  places['lip'] = { ...lip, r: 3 };
  {
    const gp = (name: string, s: number, l: number, r: number) => { const p = G(s, l); const y = floorNear(p.x, frontY + 1, p.z); if (y !== null) places[name] = { x: p.x, y, z: p.z, r }; };
    gp('trench', TS - 4, 0.7, 4);
    gp('noMans', (noMans[0] + noMans[1]) / 2, 0.8, 4);
    gp('murkLine', murkS - 1.2, lipL, 3);
  }
  place('bottom', 142 + 8, 32, L2, 10);
  place('warrens', 214, 22, L2, 18);
  place('heart', 304 - 12, -12, L2, 10);
  places['lookout'] = { x: look.x, y: yB + 0.1, z: look.z, r: 2 };
  places['bridge'] = { x: (bA.x + bE.x) / 2, y: yB, z: (bA.z + bE.z) / 2, r: 2 };
  if (!places.hall || !places.warrens || !places.heart || !places.bottom || !places.front) { inp.why?.('places ' + ['hall', 'warrens', 'heart', 'bottom', 'front'].filter((k) => !places[k]).join(',')); return null; }
  const heartTop = floorNear(hC.x, L2 + 2, hC.z) ?? L2;
  const heart = { x: hC.x, y: heartTop, z: hC.z };

  const decor: Decor[] = [];
  const glows: number[] = [];
  const glow = (x: number, y: number, z: number, c: [number, number, number], r: number, s = 1) => { glows.push(x, y, z, c[0] * s, c[1] * s, c[2] * s, r); };
  const LUMEN: [number, number, number][] = [[0.15, 1.0, 0.75], [0.45, 1.0, 0.3], [0.2, 0.65, 1.0], [1.0, 0.8, 0.35]];
  const MURK: [number, number, number][] = [[1.0, 0.18, 0.12], [0.8, 0.12, 0.5], [1.0, 0.45, 0.1]];
  const free = (x: number, z: number, r: number, list: { x: number; z: number; r: number }[]) => list.every((o) => Math.hypot(o.x - x, o.z - z) > o.r + r);
  const taken: { x: number; z: number; r: number }[] = [
    { x: spire.x, z: spire.z, r: 8 }, { x: pool.x, z: pool.z, r: 13 },
    { ...places.council, r: 6 }, { ...places.hall, r: 7 },
  ];
  // Dwellings on the terraces (doors facing the middle), warm light inside.
  const dwellings: DeepPlan['dwellings'] = [];
  const localAng = (x: number, z: number) => { const dx = x - ox, dz = z - oz; return Math.atan2((-dx * uz + dz * ux) / hallRz, (dx * ux + dz * uz) / hallRx); };
  const mouths = [Math.atan2(14 / hallRz, 50 / hallRx), Math.atan2(-33 / hallRz, 30 / hallRx), Math.atan2(36 / hallRz, -18 / hallRx), Math.atan2(-20 / hallRz, -64 / hallRx)];
  for (const r of roads) mouths.push(localAng(r.pts[r.pts.length - 3], r.pts[r.pts.length - 1]));
  for (let i = 0, tries = 0; dwellings.length < 46 && tries < 900; tries++) {
    const a = rng.range(0, Math.PI * 2), q = rng.range(0.5, 0.96);
    const u = Math.cos(a) * hallRx * q, v = Math.sin(a) * hallRz * q;
    // Keep the ways to the galleries and roads clear.
    const am = Math.atan2(v / hallRz, u / hallRx);
    if (mouths.some((m) => Math.abs(angDiff(am, m)) < 0.2)) continue;
    const r = rng.range(0.9, 2.3);
    const [x, z] = W(u, v);
    if (!free(x, z, r + 1.2, taken)) continue;
    const y = floorNear(x, L1 + 4, z);
    if (y === null) continue;
    // Level enough to stand on.
    const y2 = floorNear(x + r, y, z), y3 = floorNear(x, y, z + r);
    if (y2 === null || y3 === null || Math.abs(y2 - y) > 0.7 || Math.abs(y3 - y) > 0.7) continue;
    const yaw = Math.atan2(ox - x, oz - z);
    dwellings.push({ x, y, z, r, h: r * rng.range(0.95, 1.35), yaw });
    decor.push({ k: 'dwelling', x, y, z, s: r, h: r * 1.15, yaw, c: i % LUMEN.length, reg: 1 });
    glow(x + Math.sin(yaw) * r * 1.1, y + 0.4, z + Math.cos(yaw) * r * 1.1, [1.0, 0.7, 0.35], 4 + r * 1.5, 0.8);
    taken.push({ x, z, r: r + 0.8 });
    i++;
  }
  // Fungus lamps everywhere in the Glow, giant mushrooms in the Gardens.
  const scatter = (cu: number, cv: number, ru: number, rv: number, n: number, yGuess: number, fn: (x: number, y: number, z: number, r: Rng) => void) => {
    for (let i = 0, tries = 0; i < n && tries < n * 8; tries++) {
      const a = rng.range(0, Math.PI * 2), q = Math.sqrt(rng.float());
      const [x, z] = W(cu + Math.cos(a) * ru * q, cv + Math.sin(a) * rv * q);
      if (!free(x, z, 0.6, taken)) continue;
      const y = floorNear(x, yGuess, z);
      if (y === null) continue;
      fn(x, y, z, rng);
      i++;
    }
  };
  scatter(0, 0, hallRx * 0.95, hallRz * 0.95, 140, L1 + 4, (x, y, z, r) => {
    const c = r.int(0, 3);
    decor.push({ k: 'fungus', x, y, z, s: r.range(0.15, 0.4), h: r.range(0.2, 0.7), yaw: r.range(0, 6.3), c, reg: 1 });
    glow(x, y + 0.4, z, LUMEN[c], 3.2, 0.5);
  });
  scatter(46, -66, 26, 20, 34, L1 + 3, (x, y, z, r) => {
    const s = r.range(1.0, 4.4), c = r.int(0, 3);
    decor.push({ k: 'mushroom', x, y, z, s, h: s * r.range(1.4, 2.2), yaw: r.range(0, 6.3), c, reg: 1, tilt: r.range(-0.15, 0.15) });
    glow(x, y + s * 1.6, z, LUMEN[c], 5 + s * 2, 0.45);
    taken.push({ x, z, r: s * 0.5 });
  });
  scatter(46, -66, 28, 22, 90, L1 + 3, (x, y, z, r) => {
    const c = r.int(0, 3);
    decor.push({ k: 'fungus', x, y, z, s: r.range(0.15, 0.45), h: r.range(0.2, 0.9), yaw: r.range(0, 6.3), c, reg: 1 });
    if (r.chance(0.3)) glow(x, y + 0.4, z, LUMEN[c], 3, 0.5);
  });
  // The Lake: pale crystals along the shore.
  scatter(-34, 72, 32, 23, 40, L1, (x, y, z, r) => {
    if (y < L1 - 0.5) return;
    const s = r.range(0.3, 1.4);
    decor.push({ k: 'crystal', x, y, z, s, h: s * r.range(2, 4), yaw: r.range(0, 6.3), c: 2, reg: 1, tilt: r.range(-0.4, 0.4) });
    glow(x, y + s * 1.5, z, LUMEN[2], 4 + s * 3, 0.7);
  });
  // The Spire: fungus shelves winding up the column.
  for (let i = 0; i < 26; i++) {
    const t = i / 26, a = t * Math.PI * 7, yy = L1 + 2 + t * 34, rr = 5.2 - t * 2.2 + 0.4;
    const x = spire.x + Math.cos(a) * rr, z = spire.z + Math.sin(a) * rr;
    const c = i % LUMEN.length;
    decor.push({ k: 'shelf', x, y: yy, z, s: rng.range(0.9, 1.7), h: 0.25, yaw: a, c, reg: 1 });
    glow(x + Math.cos(a) * 0.8, yy + 0.2, z + Math.sin(a) * 0.8, LUMEN[c], 7, 0.75);
  }
  // Glowing strands hanging from the vault.
  for (let i = 0; i < 70; i++) {
    const a = rng.range(0, Math.PI * 2), q = Math.sqrt(rng.float()) * 0.85;
    const [x, z] = W(Math.cos(a) * hallRx * q, Math.sin(a) * hallRz * q);
    const top = field.ceilingAt(x, L1 + 12, z, 50);
    if (!Number.isFinite(top)) continue;
    const l = rng.range(1.5, 7);
    const c = rng.int(0, 3);
    decor.push({ k: 'strand', x, y: top, z, s: 0.03, h: l, yaw: 0, c, reg: 1 });
    glow(x, top - l, z, LUMEN[c], 3.5, 0.35);
  }
  // The council: a ring of standing stones.
  if (places.council) {
    const c = places.council;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2, x = c.x + Math.cos(a) * 4.2, z = c.z + Math.sin(a) * 4.2;
      const y = floorNear(x, c.y, z) ?? c.y;
      decor.push({ k: 'stone', x, y, z, s: 0.45, h: rng.range(0.9, 1.6), yaw: a, c: 0, reg: 1 });
    }
    glow(c.x, c.y + 1, c.z, LUMEN[0], 9, 0.6);
  }
  // The Archive: salvaged things in rows; the mosaics on its back wall.
  const mosaics: DeepPlan['mosaics'] = [];
  if (places.archive) {
    const A = places.archive;
    const kinds: DecorKind[] = ['cans', 'phone', 'keys', 'wheel', 'cans', 'phone', 'egg', 'keys'];
    for (let i = 0; i < 26; i++) {
      const uu = -64 + rng.range(-8, 8), vv = -20 + rng.range(-5, 5);
      const p = F(uu, vv, A.y + 1);
      if (!p) continue;
      decor.push({ k: kinds[i % kinds.length], x: p.x, y: p.y, z: p.z, s: rng.range(0.6, 1.2), h: 0, yaw: rng.range(0, 6.3), c: i % 4, reg: 1 });
    }
    // Back wall (toward −u): find the rock along −u from the archive's centre.
    const dir = { x: -ux, z: -uz };
    const tWall = field.ray(A.x, A.y + 2.4, A.z, dir.x, 0, dir.z, 30);
    if (Number.isFinite(tWall)) {
      const cx = A.x + dir.x * (tWall - 0.45), cz = A.z + dir.z * (tWall - 0.45);
      const sx = -dir.z, sz = dir.x;
      mosaics.push({ x: cx + sx * 2.4, y: A.y + 2.4, z: cz + sz * 2.4, nx: -dir.x, nz: -dir.z, w: 3.6, h: 2.4 });
      mosaics.push({ x: cx - sx * 2.4, y: A.y + 2.4, z: cz - sz * 2.4, nx: -dir.x, nz: -dir.z, w: 3.6, h: 2.4 });
      glow(A.x + dir.x * (tWall - 2), A.y + 2.4, A.z + dir.z * (tWall - 2), [0.8, 0.9, 1.0], 8, 0.6);
    }
  }
  // The nursery: soft egg-like domes.
  if (places.nursery) {
    const N = places.nursery;
    for (let i = 0; i < 9; i++) {
      const a = rng.range(0, 6.3), d = rng.range(0, 4.5), x = N.x + Math.cos(a) * d, z = N.z + Math.sin(a) * d;
      const y = floorNear(x, N.y, z) ?? N.y;
      decor.push({ k: 'egg', x, y, z, s: rng.range(0.3, 0.6), h: 0, yaw: a, c: i % 3, reg: 1 });
    }
    glow(N.x, N.y + 0.6, N.z, [1.0, 0.85, 0.6], 8, 0.7);
  }
  // Stalactites and stalagmites everywhere (plain rock).
  for (const p of realmPrims) {
    if (p.rock || p.t === 'cyl') continue;
    const b = boundsOf(p);
    const area = (b[3] - b[0]) * (b[5] - b[2]);
    const n = Math.min(60, Math.round(area / 260));
    for (let i = 0; i < n; i++) {
      const x = rng.range(b[0], b[3]), z = rng.range(b[2], b[5]);
      const mid = (b[1] + b[4]) / 2;
      if (!field.air(x, mid, z, 1)) continue;
      if (rng.chance(0.55)) {
        const top = field.ceilingAt(x, mid, z, 40);
        if (!Number.isFinite(top)) continue;
        decor.push({ k: 'stalac', x, y: top + 0.3, z, s: rng.range(0.3, 1.1), h: rng.range(1.2, 5), yaw: rng.range(0, 6.3), c: 0, reg: p.reg });
      } else {
        const y = field.floorAt(x, mid, z, 40);
        if (y === null || !free(x, z, 1.2, taken)) continue;
        decor.push({ k: 'stalag', x, y: y - 0.2, z, s: rng.range(0.3, 0.9), h: rng.range(0.8, 3.5), yaw: rng.range(0, 6.3), c: 0, reg: p.reg });
        taken.push({ x, z, r: 0.8 });
      }
    }
  }
  // The Front: the Lumen's bays (duckboards, sandbags, lamps), thorn wire, a cratered no-man's land,
  // the Murk's berm and their dead.
  const posts: Trench['posts'] = [], gapPosts: Trench['gapPosts'] = [];
  for (const [l0, l1] of segs) {
    for (let l = l0 + 0.35; l < l1 - 0.2; l += 0.9) {
      const p = G(TS, l), y = floorNear(p.x, frontY - 0.2, p.z);
      if (y === null) continue;
      decor.push({ k: 'duck', x: p.x, y, z: p.z, s: 0.45, h: 0.6, yaw: across, c: 0, reg: 2 });
    }
    for (let l = l0 + 0.6; l < l1 - 0.3; l += 1.5) {
      const p = G(TS - 0.1, l), y = floorNear(p.x, frontY - 0.2, p.z);
      if (y !== null && y < frontY - 0.4) posts.push({ x: p.x, y, z: p.z });
    }
    // Sandbags along the parapet, two rows and a few on top.
    for (const [ds, dy, step] of [[1.1, 0, 0.62], [1.65, 0, 0.62], [1.35, 0.3, 0.7]] as const) {
      for (let l = l0 - 0.1 + (dy ? 0.4 : 0); l < l1 + 0.1; l += step) {
        const p = G(TS + ds, l), y = floorNear(p.x, frontY + 2, p.z);
        if (y === null || y < frontY + 0.3) continue;
        decor.push({ k: 'sack', x: p.x, y: y - 0.06 + dy, z: p.z, s: 0.32 + rng.range(-0.03, 0.03), h: 0.32, yaw: across + rng.range(-0.15, 0.15), c: rng.int(0, 3), reg: 2 });
      }
    }
    // Warm lamps in the bay, low (the light stays in the trench).
    for (let l = l0 + 1; l < l1; l += 3) { const p = G(TS - 0.5, l); glow(p.x, frontY - 0.2, p.z, LUMEN[3], 4.5, 0.7); }
  }
  for (const l of gaps) {
    const p = G(TS + 0.6, l), y = floorNear(p.x, frontY + 1, p.z);
    if (y !== null) gapPosts.push({ x: p.x, y, z: p.z });
    // A stake either side of the gap with a glowing tip: the Lumen's mark.
    for (const side of [-1.15, 1.15]) {
      const q = G(TS + 0.9, l + side), yq = floorNear(q.x, frontY + 1, q.z);
      if (yq !== null) decor.push({ k: 'post', x: q.x, y: yq, z: q.z, s: 0.14, h: rng.range(1.2, 1.6), yaw: 0, c: 0, reg: 2 });
    }
  }
  // Thorn wire: knife rests end to end across the gallery, a little askew.
  const wire: [number, number] = [TS + 4.5, TS + 6.5];
  for (let l = -7.4; l < 7.6; l += 2.3) {
    const s = rng.range(wire[0] + 0.4, wire[1] - 0.4), p = G(s, l + rng.range(-0.2, 0.2)), y = floorNear(p.x, frontY + 1, p.z);
    if (y === null) continue;
    decor.push({ k: 'wire', x: p.x, y, z: p.z, s: 1.15, h: 0.95, yaw: across + rng.range(-0.25, 0.25), c: 0, reg: 2 });
  }
  // Stakes of the wire's second row, broken thorns.
  for (let i = 0; i < 14; i++) {
    const p = G(rng.range(wire[0] - 1, wire[1] + 2.5), rng.range(-7, 7)), y = floorNear(p.x, frontY + 1, p.z);
    if (y !== null) decor.push({ k: 'stake', x: p.x, y, z: p.z, s: 0.07, h: rng.range(0.4, 1.1), yaw: rng.range(0, 6.3), c: 0, reg: 2, tilt: rng.range(-0.5, 0.5) });
  }
  // No-man's land: ooze stains, the husks of fallen Murk, burnt-out glow where Lumen fell.
  for (let i = 0; i < 46; i++) {
    const s = rng.range(wire[0] - 1, murkS + 1), l = rng.range(-6.8, 6.8), p = G(s, l), y = floorNear(p.x, frontY + 1.5, p.z);
    if (y === null) continue;
    const murk = rng.chance(0.8);
    decor.push({ k: 'stain', x: p.x, y, z: p.z, s: rng.range(0.4, 1.3), h: 0, yaw: rng.range(0, 6.3), c: murk ? 1 : 0, reg: 2 });
    if (murk && rng.chance(0.45)) glow(p.x, y + 0.3, p.z, MURK[0], 2.5, 0.35);
  }
  for (let i = 0; i < 16; i++) {
    const s = rng.range(wire[0] - 0.5, murkS - 1), l = rng.range(-6.5, 6.5), p = G(s, l), y = floorNear(p.x, frontY + 1.5, p.z);
    if (y !== null) decor.push({ k: 'husk', x: p.x, y, z: p.z, s: rng.range(0.3, 0.6), h: 0, yaw: rng.range(0, 6.3), c: rng.int(0, 2), reg: 2 });
  }
  // The Murk's side: crystal spikes along their berm, its red glow.
  for (let i = 0; i < 18; i++) {
    const p = G(murkS + rng.range(-0.5, 2.5), rng.range(-7.2, 7.2)), y = floorNear(p.x, frontY + 1.5, p.z);
    if (y === null || Math.abs((p.x - fA.x) * tCx + (p.z - fA.z) * tCz - lipL) < 1.6) continue;
    const c = rng.int(0, 2), sz = rng.range(0.25, 0.7);
    decor.push({ k: 'murkCrystal', x: p.x, y, z: p.z, s: sz, h: sz * rng.range(2, 4), yaw: rng.range(0, 6.3), c, reg: 2, tilt: rng.range(-0.6, 0.6) });
  }
  for (const l of [-5, 0, 5]) { const p = G(murkS + 2, l); glow(p.x, frontY + 1.2, p.z, MURK[0], 9, 0.7); }
  const trench: Trench = { x: fA.x, y: frontY, z: fA.z, ax: tAx, az: tAz, cx: tCx, cz: tCz, s: TS, segs, gaps, posts, gapPosts, wire, noMans, craters, murkS };
  for (const t of [0.15, 0.38]) {
    const x = fA.x + (fB.x - fA.x) * t, z = fA.z + (fB.z - fA.z) * t;
    glow(x, frontY + 6, z, LUMEN[2], 11, 0.4);
  }
  // The Throat: crystals of both kinds where the realms meet; a pale glow at the lip.
  glow(lip.x, frontY + 2, lip.z, LUMEN[0], 10, 0.7);
  glow(places.lookout.x, places.lookout.y + 1.5, places.lookout.z, LUMEN[3], 7, 0.8);
  // The Deep's red glow rising from the bottom of the shaft.
  glow(tC.x, L2 + 4, tC.z, MURK[0], 46, 1.1);
  glow(tC.x, L2 + 22, tC.z, MURK[1], 30, 0.45);
  for (let i = 0; i < 40; i++) {
    const s = (i + rng.range(0.1, 0.9)) * (len / 40), a = a0 + s / rc, yy = frontY + slope * s;
    const x = tC.x + Math.cos(a) * (rc + hw - 0.7), z = tC.z + Math.sin(a) * (rc + hw - 0.7);
    const murk = yy < (frontY + L2) / 2;
    const c = rng.int(0, 2);
    decor.push({ k: murk ? 'murkCrystal' : 'crystal', x, y: yy, z, s: rng.range(0.3, 0.9), h: rng.range(1, 2.6), yaw: a, c: murk ? c : 2, reg: murk ? 3 : 2, tilt: rng.range(-0.4, 0.4) });
    glow(x, yy + 1.2, z, murk ? MURK[c] : LUMEN[2], 7, 0.65);
  }
  // The Deep: crystal spikes, hives, pens; veins to the Heart.
  scatter(214, 22, 60, 44, 120, L2 + 2, (x, y, z, r) => {
    if (pillars.some((p) => Math.hypot(p.x - x, p.z - z) < p.y + 1)) return;
    const s = r.range(0.25, 1.4), c = r.int(0, 2);
    decor.push({ k: 'murkCrystal', x, y, z, s, h: s * r.range(2, 5), yaw: r.range(0, 6.3), c, reg: 3, tilt: r.range(-0.5, 0.5) });
    if (s > 0.6 || r.chance(0.25)) glow(x, y + s * 2, z, MURK[c], 4 + s * 4, 0.6);
    taken.push({ x, z, r: s });
  });
  const hives: DeepPlan['hives'] = [];
  for (const [u, v] of [[186, 30], [226, -10], [244, 48], [262, 4], [200, 60], [238, 16]]) {
    const p = F(u, v, L2 + 2);
    if (!p) continue;
    const r = rng.range(3, 5);
    hives.push({ ...p, r });
    decor.push({ k: 'hive', x: p.x, y: p.y, z: p.z, s: r, h: r * rng.range(1.3, 1.8), yaw: rng.range(0, 6.3), c: 0, reg: 3 });
    glow(p.x, p.y + r * 0.8, p.z, MURK[0], 9 + r, 0.8);
    taken.push({ x: p.x, z: p.z, r: r + 1 });
  }
  const pens: DeepPlan['pens'] = [];
  for (const [u, v] of [[206, 10], [236, -24], [250, 22]]) {
    const p = F(u, v, L2 + 2);
    if (!p) continue;
    pens.push({ ...p, r: 2.4 });
    decor.push({ k: 'pen', x: p.x, y: p.y, z: p.z, s: 2.4, h: 2.2, yaw: rng.range(0, 6.3), c: 0, reg: 3 });
    glow(p.x, p.y + 1, p.z, LUMEN[0], 6, 0.35);
    taken.push({ x: p.x, z: p.z, r: 3.2 });
  }
  // Bones of their meals: grey heaps of absorbed things.
  scatter(214, 22, 56, 40, 24, L2 + 2, (x, y, z, r) => { decor.push({ k: 'bone', x, y, z, s: r.range(0.4, 1.1), h: 0, yaw: r.range(0, 6.3), c: 0, reg: 3 }); });
  // The Heart chamber: tall crystals round the mound.
  scatter(304, -12, 28, 26, 40, L2, (x, y, z, r) => {
    if (Math.hypot(x - heart.x, z - heart.z) < 9) return;
    const s = r.range(0.4, 1.8), c = r.int(0, 2);
    decor.push({ k: 'murkCrystal', x, y, z, s, h: s * r.range(3, 6), yaw: r.range(0, 6.3), c, reg: 3, tilt: r.range(-0.3, 0.3) });
    glow(x, y + s * 2.5, z, MURK[c], 6 + s * 3, 0.55);
  });
  glow(heart.x, heart.y + 3, heart.z, [0.35, 0.75, 1.5], 34, 1.6);
  glow(heart.x, heart.y + 1, heart.z, [1.0, 0.2, 0.25], 22, 0.9);
  // Veins: from each pen and hive to the Heart along the floor.
  const veins: number[][] = [];
  for (const src of [...pens, ...hives]) {
    const pts: number[] = [];
    const n = Math.ceil(Math.hypot(heart.x - src.x, heart.z - src.z) / 3);
    const wob = rng.range(-1, 1);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = src.x + (heart.x - src.x) * t + Math.sin(t * 9 + wob * 4) * 1.6 * (1 - t);
      const z = src.z + (heart.z - src.z) * t + Math.cos(t * 7 + wob * 3) * 1.6 * (1 - t);
      const y = floorNear(x, L2 + 1, z);
      if (y === null) { if (pts.length >= 6) veins.push(pts.splice(0)); else pts.length = 0; continue; }
      pts.push(x, y + 0.04, z);
    }
    if (pts.length >= 6) veins.push(pts);
  }
  // Water: the pool and the lake; the falls.
  const water: Water[] = [
    { x: pool.x, y: L1 - 0.35, z: pool.z, rx: 12.2, rz: 8.4, yaw: yawW + 0.4, reg: 1 },
    { ...at(-36, 74, L1 - 0.6), rx: 26, rz: 15, yaw: yawW - 0.3, reg: 1 },
  ];
  glow(pool.x, L1, pool.z, LUMEN[2], 12, 0.4);
  const falls: Falls[] = [];
  {
    const fp = at(-40, 93, 0), nIn = { x: lC.x - fp.x, z: lC.z - fp.z }, nl = Math.hypot(nIn.x, nIn.z) || 1;
    const tW = field.ray(lC.x, L1 + 4, lC.z, -nIn.x / nl, 0, -nIn.z / nl, 60);
    if (Number.isFinite(tW)) {
      const x = lC.x - (nIn.x / nl) * (tW - 1.2), z = lC.z - (nIn.z / nl) * (tW - 1.2);
      const top = field.ceilingAt(x, L1 + 4, z, 40);
      falls.push({ x, z, y0: L1 - 0.6, y1: Number.isFinite(top) ? top : L1 + 16, w: 3.2, nx: nIn.x / nl, nz: nIn.z / nl });
      glow(x, L1 + 2, z, [0.6, 0.85, 1.0], 12, 0.5);
    }
  }
  // Beside the lip, just off the gallery's mouth: step off the edge into it.
  const la = a0 - 0.3;
  const lift = { x: tC.x + Math.cos(la) * (R - 4.2), z: tC.z + Math.sin(la) * (R - 4.2), y0: L2 - 1, y1: frontY + 2.5, r: 3.0 };
  for (let y = L2 + 4; y < frontY; y += 12) glow(lift.x, y, lift.z, LUMEN[0], 14, 0.35);

  // ---------------------------------------------------------------- the waypoint graph
  const nodes: NavNode[] = [];
  const edges: [number, number][] = [];
  const node = (name: string, p: V | { x: number; y: number; z: number } | null, r = 3): number => {
    if (!p) return -1;
    nodes.push({ id: nodes.length, name, x: p.x, y: p.y, z: p.z, r });
    return nodes.length - 1;
  };
  const link = (a: number, b: number) => {
    if (a < 0 || b < 0 || a === b) return;
    const A = nodes[a], B = nodes[b];
    if (walkable(field, A, B)) { edges.push([a, b]); return; }
    // Round an obstacle (a pillar, the Spire's foot): a waypoint off to one side.
    const L = Math.hypot(B.x - A.x, B.z - A.z) || 1, px = -(B.z - A.z) / L, pz = (B.x - A.x) / L;
    for (const off of [5, -5, 9, -9, 14, -14]) for (const t of [0.5, 0.35, 0.65]) {
      const x = A.x + (B.x - A.x) * t + px * off, z = A.z + (B.z - A.z) * t + pz * off;
      const y = floorNear(x, A.y + (B.y - A.y) * t, z);
      if (y === null) continue;
      const V = { id: -1, name: 'via', x, y, z, r: 2 };
      if (!walkable(field, A, V) || !walkable(field, V, B)) continue;
      nodes.push({ ...V, id: nodes.length });
      edges.push([a, nodes.length - 1], [nodes.length - 1, b]);
      return;
    }
    edges.push([a, b]);
  };
  const nHall = node('hall', places.hall, 10);
  for (const nm of ['spire', 'pool', 'council', 'nursery']) if (places[nm]) link(nHall, node(nm, places[nm], places[nm].r));
  // Ring of terrace nodes (the Lumen walk round their hall).
  const ring: number[] = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ring.push(node(`terrace${i}`, F(Math.cos(a) * hallRx * 0.74, Math.sin(a) * hallRz * 0.74, L1 + 5), 4));
  }
  ring.forEach((n, i) => { link(n, ring[(i + 1) % ring.length]); if (i % 3 === 0) link(n, nHall); });
  const rimNode = (u: number, v: number) => { let best = -1, bd = Infinity; const [x, z] = W(u, v); for (const n of ring) if (n >= 0 && Math.hypot(nodes[n].x - x, nodes[n].z - z) < bd) { bd = Math.hypot(nodes[n].x - x, nodes[n].z - z); best = n; } return best; };
  const nArch = node('archive', places.archive, 5); link(nArch, rimNode(-55, -18));
  const nGL = node('gardensLink', F(36, -44, L1 + 4), 4); link(nGL, rimNode(28, -32));
  const nG = node('gardens', places.gardens, 12); link(nGL, nG);
  const nLL = node('lakeLink', F(-22, 46, L1 + 2), 4); link(nLL, rimNode(-16, 34));
  const nL = node('lake', places.lake, 10); link(nLL, nL);
  const nF0 = node('frontIn', F(54, 15, frontY), 5); link(nF0, rimNode(48, 13));
  const nF = node('front', places.front, 5); link(nF0, nF);
  // Through the trench line by its gaps, over no-man's land, past the Murk's berm to the lip.
  const nNM = node('noMans', places.noMans, 4);
  gaps.forEach((l, i) => { const p = G(TS, l); const y = floorNear(p.x, frontY + 1, p.z); const n = node(`trench${i}`, y === null ? null : { x: p.x, y, z: p.z }, 1); link(nF, n); link(n, nNM); });
  const nML = node('murkLine', places.murkLine, 3); link(nNM, nML);
  const nLip = node('lip', places.lip, 3); link(nML, nLip);
  // Down the ramp.
  let prev = nLip;
  for (let s = 14; s < len - 4; s += 14) {
    const a = a0 + s / rc;
    const n = node(`ramp${Math.round(s)}`, { x: tC.x + Math.cos(a) * rc, y: frontY + slope * s, z: tC.z + Math.sin(a) * rc }, 2.5);
    link(prev, n);
    prev = n;
  }
  const nBot = node('bottom', places.bottom, 8); link(prev, nBot);
  const nW = node('warrens', places.warrens, 16); link(nBot, nW);
  const nHL = node('heartLink', F(276, 1, L2), 5); link(nW, nHL);
  const nH = node('heart', places.heart, 8); link(nHL, nH);
  pens.forEach((p, i) => link(nW, node(`pen${i}`, p, 3)));
  hives.forEach((p, i) => link(nW, node(`hive${i}`, p, 4)));
  // Roads: every ~16 m a node, the last joined to the nearest terrace.
  for (const r of roads) {
    let last = -1;
    for (let i = 0; i < r.pts.length; i += 3) {
      const n = node(i === 0 ? `gate${r.colony}` : `road${r.colony}_${i / 3}`, { x: r.pts[i], y: r.pts[i + 1], z: r.pts[i + 2] }, 2.5);
      link(last, n);
      last = n;
    }
    let best = -1, bd = Infinity;
    for (const n of [...ring, nHall]) if (n >= 0) { const d = Math.hypot(nodes[n].x - nodes[last].x, nodes[n].z - nodes[last].z); if (d < bd) { bd = d; best = n; } }
    link(last, best);
  }

  return {
    seed, hub: hub.id, ox, oz, ux, uz, yGlow: L1, yDeep: L2, prims, roads, decor, glows, water, falls, places, pens, hives, dwellings,
    ramp: { cx: tC.x, cz: tC.z, rc, y0: frontY, slope, a0, len, hw }, lift, mosaics, trench, heart, nodes, edges, veins,
  };
}

function boundsOf(p: Prim): number[] {
  return primBounds(p);
}

/**
 * Can a walker go straight from A to B on the field's floors? Half-metre steps, rises of at most
 * 0.55 m a step, room for the body (as the self test walks the graph).
 */
export function walkable(F: DeepField, A: { x: number; y: number; z: number }, B: { x: number; y: number; z: number }): boolean {
  const L = Math.hypot(B.x - A.x, B.z - A.z), n = Math.max(1, Math.ceil(L / 0.5));
  let y = A.y;
  for (let i = 1; i <= n; i++) {
    const x = A.x + ((B.x - A.x) * i) / n, z = A.z + ((B.z - A.z) * i) / n;
    const f = F.floorAt(x, y + 0.85, z, 6);
    if (f === null || f - y > 0.55 || !F.air(x, f + 1.7, z)) return false;
    y = f;
  }
  return Math.abs(y - B.y) < 1.5;
}

/** Height of a terraced floor at elliptical radius q (as the field's bowl shape). */
export function terraceH(q: number, q0: number, steps: number, stepH: number, ramp: number): number {
  if (q <= q0) return 0;
  const tt = ((q - q0) / (1 - q0)) * steps;
  const i = Math.floor(tt), f = tt - i, r0 = 1 - ramp;
  const w = f <= r0 ? 0 : (f - r0) / ramp;
  return i >= steps ? stepH * steps : stepH * (i + w * w * (3 - 2 * w));
}

/**
 * A colony's road: out through a wall of its chamber (a neck), widening into
 * the broad gallery that descends to the Hall's rim, spiralling where the way is too short for the
 * drop. Null when no way out is clear.
 */
function planRoad(inp: PlanInput, c: Colony, ox: number, oz: number, ux: number, uz: number, hallRx: number, hallRz: number, hallFloor: (u: number, v: number) => number, prims: Prim[], hub: boolean, rng: Rng): Road | null {
  const b = c.chamber;
  const yc = b.y0;
  const walls: ('u+' | 'v+' | 'v-')[] = ['u+', 'v+', 'v-'];
  // Prefer the wall facing the Hall.
  const toHall = Math.atan2(oz - b.cz, ox - b.cx);
  const wallDir = (w: 'u+' | 'v+' | 'v-') => (w === 'u+' ? Math.atan2(b.uz, b.ux) : w === 'v+' ? Math.atan2(b.ux, -b.uz) : Math.atan2(-b.ux, b.uz));
  walls.sort((p, q) => Math.abs(angleDiff(wallDir(p), toHall)) - Math.abs(angleDiff(wallDir(q), toHall)));
  for (const w of walls) {
    const d = wallDir(w), dx = Math.cos(d), dz = Math.sin(d);
    // Where the neck leaves the chamber (clear of the crawl's end wall: never the u− wall).
    const half = w === 'u+' ? b.hv : b.hu;
    for (const off of [0, rng.range(-0.4, 0.4) * half, half * 0.45, -half * 0.45]) {
      if (w !== 'u+' && off < -half + 2.5) continue;
      const sx = -dz, sz = dx;
      const wallDist = w === 'u+' ? b.hu : b.hv;
      const wx = b.cx + dx * wallDist + sx * off, wz = b.cz + dz * wallDist + sz * off;
      const p0 = { x: wx - dx * 0.6, y: yc, z: wz - dz * 0.6 };
      const p1 = { x: wx + dx * 6, y: yc, z: wz + dz * 6 };
      // The neck goes on, steeper than the road, until the wide gallery fits under the ground.
      const neck: V[] = [p1];
      const roof = ROAD_R * (1 + ROAD_FLAT) + 5;
      let q = { ...p1 };
      const lowAround = (x: number, z: number) => Math.min(inp.ground(x, z), inp.ground(x + 7, z), inp.ground(x - 7, z), inp.ground(x, z + 7), inp.ground(x, z - 7));
      for (let i = 0; i < 16 && q.y > lowAround(q.x + dx * 14, q.z + dz * 14) - roof; i++) {
        q = { x: q.x + dx * 3, y: q.y - 3 * NECK_GRADE, z: q.z + dz * 3 };
        neck.push(q);
      }
      if (q.y > lowAround(q.x + dx * 14, q.z + dz * 14) - roof) { inp.why?.('neck shallow'); continue; }
      const p2 = { x: q.x + dx * 14, y: q.y - 14 * ROAD_GRADE, z: q.z + dz * 14 };
      // The entrance on the Hall's rim, on the side facing this road.
      const back = Math.atan2(p2.z - oz, p2.x - ox);
      const lu = Math.cos(back) * ux + Math.sin(back) * uz, lv = -Math.cos(back) * uz + Math.sin(back) * ux;
      const ang = Math.atan2(lv / hallRz, lu / hallRx);
      const qe = 0.93;
      const eu = Math.cos(ang) * hallRx * qe, ev = Math.sin(ang) * hallRz * qe;
      const E = { x: ox + ux * eu - uz * ev, y: hallFloor(eu, ev) - 0.2, z: oz + uz * eu + ux * ev };
      const drop = p2.y - E.y;
      if (drop < -2) { inp.why?.('road rises'); continue; }
      const D = Math.hypot(E.x - p2.x, E.z - p2.z);
      const need = drop / ROAD_GRADE;
      const head: number[] = [p0.x, p0.y, p0.z];
      for (const n of neck) head.push(n.x, n.y, n.z);
      head.push(p2.x, p2.y, p2.z);
      /** Index (vertex) where the wide gallery starts (p2). */
      const wide = head.length / 3 - 1;
      const pts: number[] = head.slice();
      let spiral: Road['spiral'] = null;
      for (const side of [1, -1]) {
        pts.length = head.length;
        spiral = null;
        let cur = { ...p2 };
        if (need > D * 1.05) {
          // A spiral first: round a centre beside the way, losing height until the rest fits straight.
          const Rs = 24;
          const hx = (E.x - p2.x) / (D || 1), hz = (E.z - p2.z) / (D || 1);
          const cx = p2.x + (-hz * side) * Rs + hx * 4, cz = p2.z + (hx * side) * Rs + hz * 4;
          spiral = { x: cx, z: cz, r: Rs };
          let a = Math.atan2(p2.z - cz, p2.x - cx);
          const turnLen = need - D * 0.95;
          const n = Math.ceil(turnLen / 10);
          for (let i = 1; i <= n; i++) {
            a += (-side * (turnLen / n)) / Rs;
            cur = { x: cx + Math.cos(a) * Rs, y: cur.y - (turnLen / n) * ROAD_GRADE, z: cz + Math.sin(a) * Rs };
            pts.push(cur.x, cur.y, cur.z);
          }
        }
        // Straight on to the Hall, descending evenly (with a gentle meander).
        const D2 = Math.hypot(E.x - cur.x, E.z - cur.z);
        const n = Math.max(2, Math.ceil(D2 / 14));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const m = Math.sin(t * Math.PI) * 3 * side;
          const hx = (E.x - cur.x) / (D2 || 1), hz = (E.z - cur.z) / (D2 || 1);
          pts.push(cur.x + (E.x - cur.x) * t - hz * m, cur.y + (E.y - cur.y) * t, cur.z + (E.z - cur.z) * t + hx * m);
        }
        // Grade check, then clearance along it (the neck opens into the chamber).
        let ok = true;
        for (let i = (wide + 1) * 3; i + 2 < pts.length; i += 3) {
          const L = Math.hypot(pts[i] - pts[i - 3], pts[i + 2] - pts[i - 1]);
          if (Math.abs(pts[i + 1] - pts[i - 2]) > L * (ROAD_GRADE + 0.05) + 0.05) { ok = false; break; }
        }
        if (!ok) { inp.why?.('road grade'); continue; }
        if (!roadClear(inp, pts, wide, b, ox, oz, hallRx)) continue;
        // Shapes: the neck, its widening, the gallery.
        const cap = (i: number, ra: number, rb: number, fa: number, fb: number, k: number, n: number) => {
          const j = i - 3;
          prims.push({ t: 'cap', rock: false, k, n, reg: 0, a: [pts[j], pts[j + 1] + ra * fa, pts[j + 2], pts[i], pts[i + 1] + rb * fb, pts[i + 2], ra, rb, Math.max(fa, fb)] });
        };
        for (let i = 3; i < wide * 3; i += 3) cap(i, NECK_R, NECK_R, NECK_FLAT, NECK_FLAT, 0.4, 0.15);
        cap(wide * 3, NECK_R, ROAD_R, NECK_FLAT, ROAD_FLAT, 1.2, 0.4);
        for (let i = (wide + 1) * 3; i < pts.length; i += 3) cap(i, ROAD_R, ROAD_R, ROAD_FLAT, ROAD_FLAT, 2.5, 0.85);
        const gate = { x: (p0.x + p1.x) / 2 + dx * 0.2, y: yc + NECK_R * NECK_FLAT, z: (p0.z + p1.z) / 2 + dz * 0.2, nx: dx, nz: dz, r: NECK_R + 0.25 };
        const hole = { wall: w, c: w === 'v+' ? -off : off, hw: NECK_R * 0.92, h: NECK_R * (1 + NECK_FLAT) * 0.97 };
        void hub;
        return { colony: c.id, pts: pts.slice(), gate, hole, spiral };
      }
    }
  }
  return null;
}

/** The road's tube stays clear of every other underground volume and under the ground. */
function roadClear(inp: PlanInput, pts: number[], wide: number, b: Colony['chamber'], ox: number, oz: number, hallR: number): boolean {
  for (let i = 3; i < pts.length; i += 3) {
    const ax = pts[i - 3], ay = pts[i - 2], az = pts[i - 1], bx = pts[i], by = pts[i + 1], bz = pts[i + 2];
    const L = Math.hypot(bx - ax, bz - az);
    const hx = (bx - ax) / (L || 1), hz = (bz - az) / (L || 1);
    const r = i / 3 <= wide ? NECK_R : ROAD_R;
    for (let s = 0; s <= L; s += 2.5) {
      const t = s / (L || 1);
      const x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t;
      // Inside the chamber and the Hall it may be.
      const du = (x - b.cx) * b.ux + (z - b.cz) * b.uz, dv = -(x - b.cx) * b.uz + (z - b.cz) * b.ux;
      if (Math.abs(du) < b.hu + 1.2 && Math.abs(dv) < b.hv + 1.2) continue;
      if (Math.hypot(x - ox, z - oz) < hallR * 0.95) continue;
      for (const l of [-r - 0.6, 0, r + 0.6]) for (const hy of [0.2, r, r * 1.5 + 0.6]) {
        const px = x - hz * l, pz = z + hx * l, py = y + hy;
        if (inp.blocked(px, py, pz)) { inp.why?.(`road blocked ${i / 3}/${pts.length / 3}`); return false; }
        if (py > inp.ground(px, pz) - 4) { inp.why?.(`road cover ${i / 3}/${pts.length / 3}`); return false; }
      }
    }
  }
  return true;
}

function angDiff(a: number, b: number): number {
  return angleDiff(a, b);
}

function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
