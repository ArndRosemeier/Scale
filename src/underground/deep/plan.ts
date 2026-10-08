/**
 * The deep realms under a city (pure data, deterministic per seed): where the slimes really live.
 * Every hidden colony leads down into a realm of its own (planDeeps); each has its own battleground.
 *
 *  - Road: from the colony's chamber a neck (roomy enough for a camera behind the player)
 *    widens into a broad descending gallery — spiralling down where the way is short — to the
 *    Great Hall.
 *  - The Glow (Lumen, ~60 m down): the Great Hall, a domed cavern with terraced slopes covered in
 *    dwellings round a pool and the Spire (a rock column ringed with fungus shelves); the Gardens
 *    (a forest of giant mushrooms), the Lake (a falls from a crack in the vault), the Archive
 *    (their collection of surface things, and the mosaics).
 *  - The Front: a gallery from the Hall to the Throat, a shaft 50 m deep with a ramp spiralling down
 *    its wall and a natural bridge across it. The Lumen hold its floor.
 *  - The Deep (Murk, ~110 m down): the Warrens (crystal spikes, hives, pens with captured Lumen)
 *    and the Heart chamber, where a shard of the falling star sits on a mound, veins running from it.
 *  - Where the realms meet, the Warrens' mouth by the Throat's floor, closed in by fallen rock to a
 *    passage: the Lumen's trench line — sandbagged bays with gaps between them, a belt of thorn wire,
 *    a cratered no-man's land and the Murk's own berm where the Warrens open. Its style differs from
 *    realm to realm (BattleStyle: a second line, a chasm with one bridge, flooded craters, a siege wall).
 *
 * The rock is one signed distance field (field.ts); this module lays out its shapes, the things
 * standing in it (decor), the light sources baked into the rock, and a waypoint graph the slimes
 * walk. Frame: origin O at the Hall's centre, u along the realm's axis, v across.
 */
import { Rng, deriveSeed } from '../../core/rng';
import type { Colony, RoomPlan } from '../rooms';
import { DeepField, primBounds, type Prim } from './field';
import { angleDiff } from '../../core/math';

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
  /** The trench war in the Warrens' mouth: its frame and lines (see `Trench`). */
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
 * The Warrens' mouth as a battlefield. Frame: origin (x, z) on the Throat's axis, `a` towards the
 * Warrens, `c` across; distances `s` along, `l` across (m), floor height y.
 *  - The Lumen's trench at `s`: dug bays (l0, l1) a metre deep behind sandbagged parapets, with
 *    gaps between them (`gaps`: l of each) where the Murk try to get through; `posts` are the
 *    fighting spots in the bays, `gapPosts` the spots guarding the gaps.
 *  - Thorn wire across `wire` (s band): it holds the Murk up under fire.
 *  - No-man's land over `noMans` (s band), pitted with craters.
 *  - The Murk's berm at `murkS`, where the Warrens open, where they gather to go over.
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
  /** The battleground's style (see `Battle`), the passage's half width, s of a second line behind (or null), the chasm (or null). */
  style: BattleStyle;
  hw: number;
  rear: number | null;
  chasm: { s: number; r: number; l: number } | null;
}

/** Tests a point against what is already underground (tunnels, rooms) and the ground above (cover). */
export type Blocked = (x: number, y: number, z: number) => boolean;

/** Depth of the Hall's base under the lowest ground over the realm (m); the Deep lies this much lower again. */
export const GLOW_DEPTH = 64, DEEP_DROP = 52;
/** Road gallery: radius, share of the radius the floor lies under the axis, steepest grade. */
const ROAD_R = 5.2, ROAD_FLAT = 0.5, ROAD_GRADE = 0.16;
const NECK_R = 2.3, NECK_FLAT = 0.42, NECK_GRADE = 0.3;
/** Rock kept between two realms (m). */
const REALM_GAP = 14;

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
 * Plan the realms: one below every colony, each reached from it alone, each with its own
 * battleground (a different style for each, see `Battle`). Colonies nearest the centre first; a
 * realm keeps clear of those planned before it. Tries axis directions and distances until the whole
 * realm lies deep under the ground and its road clear of everything else; a colony where nothing
 * fits gets none.
 */
export function planDeeps(inp: PlanInput): DeepPlan[] {
  const out: DeepPlan[] = [];
  const order = inp.colonies.slice().sort((a, b) => Math.hypot(a.chamber.cx, a.chamber.cz) - Math.hypot(b.chamber.cx, b.chamber.cz));
  const styles = new Rng(deriveSeed(inp.seed, 'battles')).shuffle(BATTLE_STYLES.slice());
  for (const hub of order) {
    const before = out.map((p) => new DeepField(p.prims, p.seed));
    const blocked: Blocked = (x, y, z) => inp.blocked(x, y, z) || before.some((F) => F.near(x, y, z) && F.sdf(x, y, z) < REALM_GAP);
    const p = planRealm({ ...inp, blocked }, hub, styles[out.length % styles.length]);
    if (p) out.push(p);
  }
  return out;
}

/** The realm below one colony (null: nothing fits). */
export function planRealm(inp: PlanInput, hub: Colony, style: BattleStyle = 'line'): DeepPlan | null {
  const rng = new Rng(deriveSeed(inp.seed, 'deep' + hub.id));
  const base = Math.atan2(hub.chamber.uz, hub.chamber.ux);
  const turns = [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6, Math.PI, 2.3, -2.3];
  const jitter = rng.range(-0.25, 0.25);
  for (const t of turns) {
    for (const dist of [150, 190, 120, 240, 95]) {
      const p = tryPlan(inp, hub, base + t + jitter, dist, rng.nextU32(), style);
      if (p) return p;
    }
  }
  return null;
}

/**
 * A colony nothing fits below (rare: crowded by stations) would be a dead end: its room loses the gap
 * and it is dropped; the others are numbered anew (colony ids are indices), their realms and roads with them.
 * Returns the dropped ones (the caller takes their chamber and crawl out of its volumes).
 */
export function dropOutposts(rooms: RoomPlan, plans: DeepPlan[]): Colony[] {
  const keep = rooms.colonies.filter((c) => plans.some((p) => p.hub === c.id));
  const gone = rooms.colonies.filter((c) => !keep.includes(c));
  if (!gone.length) return gone;
  for (const c of gone) { const r = rooms.rooms[c.room]; r.gap = null; r.colony = -1; c.chamber.colony = undefined; }
  const id = new Map(keep.map((c, i) => [c.id, i]));
  for (const p of plans) {
    p.hub = id.get(p.hub)!;
    for (const r of p.roads) r.colony = id.get(r.colony)!;
    for (const n of p.nodes) { const m = /^gate(\d+)$/.exec(n.name); if (m) n.name = `gate${id.get(Number(m[1]))}`; }
  }
  keep.forEach((c, i) => { c.id = i; c.chamber.colony = i; rooms.rooms[c.room].colony = i; });
  rooms.colonies.length = 0;
  rooms.colonies.push(...keep);
  return gone;
}

/** The first realm (tests, tools). */
export function planDeep(inp: PlanInput): DeepPlan | null { return planDeeps(inp)[0] ?? null; }

/**
 * The battleground in a realm's Warrens' mouth, laid out procedurally. Every style keeps the same
 * frame (the Lumen's trench of bays and gaps, thorn wire, no-man's land, the Murk's berm) and varies
 * on it; the passage's width, the number of bays, the depths vary in every realm.
 *  - line: one trench line.
 *  - double: a second line of bays behind the first, more sentries further back.
 *  - chasm: a chasm across no-man's land, one rock bridge over it: the Murk come over single file.
 *  - flooded: many craters, deeper, standing full of water.
 *  - siege: the Murk's berm is a high wall bristling with crystal spikes.
 */
export type BattleStyle = 'line' | 'double' | 'chasm' | 'flooded' | 'siege';
export const BATTLE_STYLES: BattleStyle[] = ['line', 'chasm', 'flooded', 'double', 'siege'];
export interface Battle {
  style: BattleStyle;
  /** Half width of the passage; s of the trench line, of the Murk's berm; l of the berm's gap. */
  hw: number; ts: number; murkS: number; mL: number;
  segs: [number, number][]; gaps: number[];
  rear: { s: number; segs: [number, number][] } | null;
  chasm: { s: number; r: number; l: number } | null;
  noMans: [number, number];
  wire: [number, number];
}

export function battleFor(style: BattleStyle, rng: Rng): Battle {
  const hw = rng.range(8.6, 12);
  const ts = 30 + rng.range(0, 2.5) + (style === 'double' ? 6 : 0);
  const n = Math.max(2, Math.min(4, Math.round((hw * 2 - 3.2) / 5)));
  const a = -hw + 1.6, b = hw - 1.6, gapW = 2, len = (b - a - (n - 1) * gapW) / n;
  const segs: [number, number][] = [], gaps: number[] = [];
  for (let i = 0; i < n; i++) {
    const l0 = a + i * (len + gapW);
    segs.push([l0, l0 + len]);
    if (i > 0) gaps.push(l0 - gapW / 2);
  }
  const chasm = style === 'chasm' ? { s: ts + 16, r: 2.6, l: rng.range(-hw + 3.5, hw - 3.5) } : null;
  const murkS = chasm ? chasm.s + 9 : ts + rng.range(19, 24);
  return {
    style, hw, ts, murkS, mL: rng.range(-hw / 3, hw / 3), segs, gaps,
    rear: style === 'double' ? { s: ts - 7, segs: [[a, -1.2], [1.2, b]] } : null,
    chasm,
    noMans: [ts + 8, chasm ? chasm.s - 3.6 : murkS - 3],
    wire: [ts + 4.5, ts + 6.5],
  };
}

type V = { x: number; y: number; z: number };

function tryPlan(inp: PlanInput, hub: Colony, ang: number, dist: number, seed: number, style: BattleStyle): DeepPlan | null {
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
  // ---------------------------------------------------------------- where the realms meet
  // The Lumen hold the floor of the Throat, the Murk the Warrens beyond. Between them the Warrens'
  // mouth, closed in by fallen rock to a passage, is the battlefield (see `Trench`). Frame: s from the
  // shaft's axis towards the Warrens, l across.
  const tDl = Math.hypot(wC.x - tC.x, wC.z - tC.z);
  const tAx = (wC.x - tC.x) / tDl, tAz = (wC.z - tC.z) / tDl, tCx = -tAz, tCz = tAx;
  const across = Math.atan2(tCz, tCx);
  const G0 = (s: number, l: number) => ({ x: tC.x + tAx * s + tCx * l, z: tC.z + tAz * s + tCz * l });
  // The battleground's shape (its style and measures, see `Battle`).
  const B = battleFor(style, new Rng(deriveSeed(seed, 'battle')));
  const mouthEnd = B.murkS + 7;
  for (const side of [-1, 1]) {
    const m = G0(mouthEnd / 2, side * (B.hw + 25));
    P('box', true, 2.5, 1.0, 3, [m.x, L2 + 14, m.z, 25, 20, mouthEnd / 2, across]);
    // Fallen blocks along the passage's sides.
    for (let s = 31; s < mouthEnd; s += rng.range(4, 7)) {
      const r = rng.range(1.6, 3), q = G0(s, side * (B.hw + r * 0.5));
      P('ell', true, 1.2, 1.1, 3, [q.x, L2 + rng.range(-0.5, 1.5), q.z, r, r * rng.range(0.8, 1.4), r, rng.range(0, 6.3), -1e9]);
    }
  }
  // The shaft open again where the fallen rock reached into it.
  P('cyl', false, 0.5, 1.0, 2, [tC.x, tC.z, L2 - 1, L2 + 38, R]);
  // Rock and air of the Throat that the Deep's caverns must not undo: the ramp, the bridge, the lookout.
  P('helix', true, 0.8, 0.25, 2, [tC.x, tC.z, rc, hw, 3.2, frontY, slope, a0, len]);
  P('cap', true, 1.5, 0.35, 2, [bA.x, yB - 1.6, bA.z, bE.x, yB - 1.6, bE.z, 1.65, 1.65, 0]);
  P('ell', false, 2, 0.7, 2, [look.x, yB + 2.2, look.z, 6, 4.2, 6, aB, yB + 0.05]);

  // ---------------------------------------------------------------- the trench war
  const tFloor = G0(B.ts + 10, 0);
  const ty = new DeepField(prims, seed).floorAt(tFloor.x, L2 + 4, tFloor.z, 12) ?? L2 - 1;
  const G = (s: number, l: number) => ({ ...G0(s, l), y: ty });
  const TS = B.ts, segs = B.segs, gaps = B.gaps, murkS = B.murkS, mL = B.mL, hwB = B.hw;
  /** A line of bays at `at`: a metre deep, lips worn round, the parapet in front (sandbags go on top). */
  const bays = (at: number, list: [number, number][]) => {
    for (const [l0, l1] of list) {
      const m = G(at, (l0 + l1) / 2), q = G(at + 1.4, (l0 + l1) / 2), hl = (l1 - l0) / 2;
      P('box', false, 0.45, 0.25, 2, [m.x, ty - 0.25, m.z, hl, 0.75, 0.85, across]);
      P('box', true, 0.3, 0.15, 2, [q.x, ty + 0.2, q.z, hl + 0.25, 0.65, 0.45, across]);
    }
  };
  bays(TS, segs);
  if (B.rear) bays(B.rear.s, B.rear.segs);
  // The Murk's berm short of the Warrens, open where they come over (a high wall when they besiege).
  const bermH = B.style === 'siege' ? 1.25 : 0.6;
  for (const [l0, l1] of [[-hwB + 1.5, mL - 1.8], [mL + 1.8, hwB - 1.5]]) {
    if (l1 - l0 < 1.5) continue;
    const m = G(murkS, (l0 + l1) / 2);
    P('box', true, 0.5, 0.45, 2, [m.x, ty + bermH - 0.55, m.z, (l1 - l0) / 2, bermH, 0.7 + (bermH - 0.6), across]);
  }
  // A chasm across no-man's land, with one rock bridge over it.
  const chasm = B.chasm;
  if (chasm) {
    const c = G(chasm.s, 0), b = G(chasm.s, chasm.l);
    P('ell', false, 1.2, 0.6, 2, [c.x, ty - 1, c.z, hwB + 4, 6, chasm.r, across, -1e9]);
    P('box', true, 0.6, 0.45, 2, [b.x, ty - 3, b.z, 1.4, 3, chasm.r + 1.2, across]);
  }
  // Craters in no-man's land (not on the line the Murk come over by); flooded ones hold water.
  const noMans = B.noMans;
  const craters: Trench['craters'] = [], pools: { x: number; z: number; r: number; y: number }[] = [];
  const wantCraters = B.style === 'flooded' ? 13 : 8;
  for (let i = 0; i < 80 && craters.length < wantCraters; i++) {
    const s = rng.range(noMans[0] + 1, noMans[1]), l = rng.range(-hwB + 2.2, hwB - 2.2), r = rng.range(1.5, B.style === 'flooded' ? 3.3 : 2.9);
    // (The lane the Murk come down from their gap stays clear.)
    if (Math.abs(l - mL) < r + 1.4) continue;
    // (Nor the ways from the trench's gaps to the middle of no-man's land.)
    const nmS = (noMans[0] + noMans[1]) / 2;
    if (gaps.some((gl) => segDist(s, l, TS, gl, nmS, mL) < r + 1.2)) continue;
    const c = G(s, l);
    if (craters.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < o.r + r - 0.6)) continue;
    craters.push({ x: c.x, z: c.z, r });
    const d = B.style === 'flooded' ? rng.range(0.9, 1.3) : rng.range(0.45, 0.8);
    P('ell', false, 1.0, 0.35, 2, [c.x, ty - d + r * 0.45, c.z, r, r * 0.45, r, 0, -1e9]);
    if (B.style === 'flooded') pools.push({ x: c.x, z: c.z, r: r * 0.8, y: ty - d + 0.45 });
  }

  // ---------------------------------------------------------------- roads
  const realmPrims = prims.slice();
  const roads: Road[] = [];
  const hubRoad = planRoad(inp, hub, ox, oz, ux, uz, hallRx, hallRz, hallFloor, prims, true, rng);
  if (!hubRoad) { inp.why?.('hub road'); return null; }
  roads.push(hubRoad);

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
  {
    // The lip can sit on the edge of a knob of rock: the nearest clear floor at the gallery's level.
    const clear = (x: number, z: number) => [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]].every(([dx, dz]) => {
      const y = field.floorAt(x + dx, frontY + 0.85, z + dz, 3);
      return y !== null && Math.abs(y - frontY) < 0.4 && field.air(x + dx, y + 1.7, z + dz);
    });
    let best: V = lip, bd = Infinity;
    for (let dx = -2.5; dx <= 2.5; dx += 0.5) for (let dz = -2.5; dz <= 2.5; dz += 0.5) {
      const d = Math.hypot(dx, dz);
      if (d < bd && clear(lip.x + dx, lip.z + dz)) { bd = d; best = { x: lip.x + dx, y: field.floorAt(lip.x + dx, frontY + 0.85, lip.z + dz, 3)!, z: lip.z + dz }; }
    }
    places['lip'] = { ...best, r: 3 };
  }
  {
    const gp = (name: string, s: number, l: number, r: number) => { const p = G(s, l); const y = floorNear(p.x, ty + 1, p.z); if (y !== null) places[name] = { x: p.x, y, z: p.z, r }; };
    gp('trench', TS - 4, 0.7, 4);
    gp('noMans', (noMans[0] + noMans[1]) / 2, mL, 4);
    gp('murkLine', murkS - 1.2, mL, 3);
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
    if (mouths.some((m) => Math.abs(angleDiff(am, m)) < 0.2)) continue;
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
  // The trench war in the Warrens' mouth: the Lumen's bays (duckboards, sandbags, lamps), thorn wire,
  // a cratered no-man's land, the Murk's berm and their dead.
  const posts: Trench['posts'] = [], gapPosts: Trench['gapPosts'] = [];
  const dress = (at: number, list: [number, number][]) => {
    for (const [l0, l1] of list) {
      for (let l = l0 + 0.35; l < l1 - 0.2; l += 0.9) {
        const p = G(at, l), y = floorNear(p.x, ty - 0.2, p.z);
        if (y === null) continue;
        decor.push({ k: 'duck', x: p.x, y, z: p.z, s: 0.45, h: 0.6, yaw: across, c: 0, reg: 2 });
      }
      for (let l = l0 + 0.6; l < l1 - 0.3; l += 1.5) {
        const p = G(at - 0.1, l), y = floorNear(p.x, ty - 0.2, p.z);
        if (y !== null && y < ty - 0.4) posts.push({ x: p.x, y, z: p.z });
      }
      // Sandbags along the parapet, two rows and a few on top.
      for (const [ds, dy, step] of [[1.1, 0, 0.62], [1.65, 0, 0.62], [1.35, 0.3, 0.7]] as const) {
        for (let l = l0 - 0.1 + (dy ? 0.4 : 0); l < l1 + 0.1; l += step) {
          const p = G(at + ds, l), y = floorNear(p.x, ty + 2, p.z);
          if (y === null || y < ty + 0.3) continue;
          decor.push({ k: 'sack', x: p.x, y: y - 0.06 + dy, z: p.z, s: 0.32 + rng.range(-0.03, 0.03), h: 0.32, yaw: across + rng.range(-0.15, 0.15), c: rng.int(0, 3), reg: 2 });
        }
      }
      // Warm lamps in the bay, low (the light stays in the trench).
      for (let l = l0 + 1; l < l1; l += 3) { const p = G(at - 0.5, l); glow(p.x, ty - 0.2, p.z, LUMEN[3], 4.5, 0.7); }
    }
  };
  dress(TS, segs);
  if (B.rear) dress(B.rear.s, B.rear.segs);
  for (const l of gaps) {
    const p = G(TS + 0.6, l), y = floorNear(p.x, ty + 1, p.z);
    if (y !== null) gapPosts.push({ x: p.x, y, z: p.z });
    // A stake either side of the gap with a glowing tip: the Lumen's mark.
    for (const side of [-1.15, 1.15]) {
      const q = G(TS + 0.9, l + side), yq = floorNear(q.x, ty + 1, q.z);
      if (yq !== null) decor.push({ k: 'post', x: q.x, y: yq, z: q.z, s: 0.14, h: rng.range(1.2, 1.6), yaw: 0, c: 0, reg: 2 });
    }
  }
  // Thorn wire: knife rests end to end across the passage, a little askew.
  const wire = B.wire;
  for (let l = -hwB + 2.2; l < hwB - 2; l += 2.3) {
    const s = rng.range(wire[0] + 0.4, wire[1] - 0.4), p = G(s, l + rng.range(-0.2, 0.2)), y = floorNear(p.x, ty + 1, p.z);
    if (y === null) continue;
    decor.push({ k: 'wire', x: p.x, y, z: p.z, s: 1.15, h: 0.95, yaw: across + rng.range(-0.25, 0.25), c: 0, reg: 2 });
  }
  // Stakes of the wire's second row, broken thorns.
  for (let i = 0; i < 14; i++) {
    const p = G(rng.range(wire[0] - 1, wire[1] + 2.5), rng.range(-hwB + 2.6, hwB - 2.6)), y = floorNear(p.x, ty + 1, p.z);
    if (y !== null) decor.push({ k: 'stake', x: p.x, y, z: p.z, s: 0.07, h: rng.range(0.4, 1.1), yaw: rng.range(0, 6.3), c: 0, reg: 2, tilt: rng.range(-0.5, 0.5) });
  }
  // No-man's land: ooze stains, the husks of fallen Murk, burnt-out glow where Lumen fell.
  const ld = hwB - 2.8;
  for (let i = 0; i < 46; i++) {
    const s = rng.range(wire[0] - 1, murkS + 1), l = rng.range(-ld, ld), p = G(s, l), y = floorNear(p.x, ty + 1.5, p.z);
    if (y === null || y < ty - 0.6) continue;
    const murk = rng.chance(0.8);
    decor.push({ k: 'stain', x: p.x, y, z: p.z, s: rng.range(0.4, 1.3), h: 0, yaw: rng.range(0, 6.3), c: murk ? 1 : 0, reg: 2 });
    if (murk && rng.chance(0.45)) glow(p.x, y + 0.3, p.z, MURK[0], 2.5, 0.35);
  }
  for (let i = 0; i < 16; i++) {
    const s = rng.range(wire[0] - 0.5, murkS - 1), l = rng.range(-ld, ld), p = G(s, l), y = floorNear(p.x, ty + 1.5, p.z);
    if (y !== null && y > ty - 0.6) decor.push({ k: 'husk', x: p.x, y, z: p.z, s: rng.range(0.3, 0.6), h: 0, yaw: rng.range(0, 6.3), c: rng.int(0, 2), reg: 2 });
  }
  // The Murk's side: crystal spikes along their berm (a palisade of tall ones when they besiege), its red glow.
  const siege = B.style === 'siege';
  for (let i = 0; i < (siege ? 46 : 18); i++) {
    const p = G(murkS + rng.range(-0.5, siege ? 1.5 : 2.5), rng.range(-hwB + 1.6, hwB - 1.6)), y = floorNear(p.x, ty + 3, p.z);
    if (y === null || Math.abs((p.x - tC.x) * tCx + (p.z - tC.z) * tCz - mL) < 1.6) continue;
    const c = rng.int(0, 2), sz = siege ? rng.range(0.5, 1.1) : rng.range(0.25, 0.7);
    decor.push({ k: 'murkCrystal', x: p.x, y, z: p.z, s: sz, h: sz * rng.range(siege ? 3 : 2, siege ? 5.5 : 4), yaw: rng.range(0, 6.3), c, reg: 2, tilt: rng.range(-0.6, 0.6) * (siege ? 0.4 : 1) });
  }
  if (siege) {
    // Towers of hive at the wall's ends, glaring.
    for (const side of [-1, 1]) {
      const p = G(murkS + 1.5, side * (hwB - 2.6)), y = floorNear(p.x, ty + 3, p.z);
      if (y === null) continue;
      decor.push({ k: 'hive', x: p.x, y, z: p.z, s: 2.2, h: 5.5, yaw: rng.range(0, 6.3), c: 0, reg: 3 });
      glow(p.x, y + 4, p.z, MURK[0], 12, 0.9);
    }
  }
  for (const l of [-hwB / 2, 0, hwB / 2]) { const p = G(murkS + 2, l); glow(p.x, ty + 1.2, p.z, MURK[0], 9, 0.7); }
  // The chasm: a red glow rising out of it, stakes marking the bridge on the Lumen's side.
  if (chasm) {
    for (const l of [-hwB / 2, hwB / 2]) { const p = G(chasm.s, l); glow(p.x, ty - 4, p.z, MURK[1], 10, 0.7); }
    for (const side of [-1.6, 1.6]) {
      const q = G(chasm.s - chasm.r - 0.8, chasm.l + side), yq = floorNear(q.x, ty + 1, q.z);
      if (yq !== null) decor.push({ k: 'post', x: q.x, y: yq, z: q.z, s: 0.14, h: 1.4, yaw: 0, c: 0, reg: 2 });
    }
  }
  const trench: Trench = { x: tC.x, y: ty, z: tC.z, ax: tAx, az: tAz, cx: tCx, cz: tCz, s: TS, segs, gaps, posts, gapPosts, wire, noMans, craters, murkS, style: B.style, hw: hwB, rear: B.rear?.s ?? null, chasm };
  // Nothing of the Warrens' own on the battlefield.
  for (let s = (B.rear?.s ?? TS) - 6; s <= mouthEnd; s += 4) for (let l = -hwB; l <= hwB; l += 6) { const p = G(s, l); taken.push({ x: p.x, z: p.z, r: 4.2 }); }
  for (const t of [0.15, 0.4, 0.65]) {
    const x = fA.x + (fB.x - fA.x) * t, z = fA.z + (fB.z - fA.z) * t;
    glow(x, frontY + 6, z, LUMEN[2], 11, 0.4);
  }
  // The Throat: crystals of both kinds where the realms meet; a pale glow at the lip.
  glow(lip.x, frontY + 2, lip.z, LUMEN[0], 10, 0.7);
  glow(places.lookout.x, places.lookout.y + 1.5, places.lookout.z, LUMEN[3], 7, 0.8);
  // The Lumen's pale light on the floor of the shaft they hold; the Deep's red glow beyond the berm.
  glow(tC.x, L2 + 4, tC.z, LUMEN[0], 30, 0.55);
  { const p = G(murkS + 14, 0); glow(p.x, ty + 5, p.z, MURK[0], 34, 1.1); }
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
  // (Not in the rock that closes in the Warrens' mouth: its length differs from realm to realm.)
  const inMouth = (p: { x: number; z: number }) => (p.x - tC.x) * tAx + (p.z - tC.z) * tAz < mouthEnd + 6;
  const hives: DeepPlan['hives'] = [];
  for (const [u, v] of [[214, 44], [226, -10], [244, 48], [262, 4], [210, -14], [238, 16]]) {
    const p = F(u, v, L2 + 2);
    if (!p || inMouth(p)) continue;
    const r = rng.range(3, 5);
    hives.push({ ...p, r });
    decor.push({ k: 'hive', x: p.x, y: p.y, z: p.z, s: r, h: r * rng.range(1.3, 1.8), yaw: rng.range(0, 6.3), c: 0, reg: 3 });
    glow(p.x, p.y + r * 0.8, p.z, MURK[0], 9 + r, 0.8);
    taken.push({ x: p.x, z: p.z, r: r + 1 });
  }
  const pens: DeepPlan['pens'] = [];
  for (const [u, v] of [[206, 10], [236, -24], [250, 22], [258, -16], [222, 30]]) {
    if (pens.length >= 3) break;
    const p = F(u, v, L2 + 2);
    if (!p || inMouth(p)) continue;
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
  // Flooded craters on the battleground.
  for (const q of pools) water.push({ x: q.x, y: q.y, z: q.z, rx: q.r, rz: q.r, yaw: 0, reg: 2 });
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
  const nFE = node('frontEnd', F(106, 26, frontY), 4); link(nF, nFE);
  const nLip = node('lip', places.lip, 3); link(nFE, nLip);
  // Down the ramp.
  let prev = nLip;
  for (let s = 14; s < len - 4; s += 14) {
    const a = a0 + s / rc;
    const n = node(`ramp${Math.round(s)}`, { x: tC.x + Math.cos(a) * rc, y: frontY + slope * s, z: tC.z + Math.sin(a) * rc }, 2.5);
    link(prev, n);
    prev = n;
  }
  const nBot = node('bottom', places.bottom, 8); link(prev, nBot);
  // Through the trench line by its gaps, over no-man's land, past the Murk's berm into the Warrens.
  const nNM = node('noMans', places.noMans, 4);
  // A second line behind: through its one gap first.
  let nRear = nBot;
  if (B.rear) {
    const at = (name: string, s: number) => { const p = G(s, 0); const y = floorNear(p.x, ty + 1, p.z); return node(name, y === null ? null : { x: p.x, y, z: p.z }, 1); };
    const g0 = at('rearGap', B.rear.s);
    link(nBot, g0);
    // Out in the open between the lines before turning to a gap of the front line.
    nRear = at('betweenLines', (B.rear.s + TS) / 2);
    link(g0, nRear);
  }
  // Each gap is gone through straight: a waypoint just behind it and one just out in front (a slant clips the bays).
  gaps.forEach((l, i) => {
    const at = (name: string, s: number, r: number) => { const p = G(s, l); const y = floorNear(p.x, ty + 1, p.z); return node(name, y === null ? null : { x: p.x, y, z: p.z }, r); };
    const back = at(`gapBack${i}`, TS - 2.6, 1), n = at(`trench${i}`, TS, 1), out = at(`gapOut${i}`, TS + 2.6, 1);
    link(nRear, back); link(back, n); link(n, out); link(out, nNM);
  });
  const nML = node('murkLine', places.murkLine, 3);
  if (chasm) {
    // Over the chasm only by its bridge.
    const end = (name: string, ds: number) => { const p = G(chasm.s + ds, chasm.l); const y = floorNear(p.x, ty + 1, p.z); return node(name, y === null ? null : { x: p.x, y, z: p.z }, 1.2); };
    const nB0 = end('bridge0', -chasm.r - 1.6), nB1 = end('bridge1', chasm.r + 1.6);
    link(nNM, nB0); link(nB0, nB1); link(nB1, nML);
  } else link(nNM, nML);
  const nW = node('warrens', places.warrens, 16); link(nML, nW);
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

/** Distance from (x, y) to the segment (ax, ay)–(bx, by). */
function segDist(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
  return Math.hypot(x - ax - dx * t, y - ay - dy * t);
}
