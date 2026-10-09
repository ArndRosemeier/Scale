/**
 * Marvels: the rare, breathtaking near-future buildings some cities have (plan/landmarks plans
 * them, `Landmark.style` is the family, `p` its proportions). Each family is a recipe, not a
 * model: the seed sets the proportions, profile, count and spacing of fins, holes, turns, rings,
 * orbs or blocks, the materials and the crown, so no two come out alike.
 *
 *  0 starship spire   a hull of 400–1000 m standing on swept fins, engine pods, observation rings
 *  1 helix tower      a round core wound by one or two glazed walkways one can walk up to the roof
 *  2 porous slab      a slab tower pierced by giant round holes (one can fly through them)
 *  3 twisted tower    floor blocks turning a little more each storey, tapering
 *  4 skyship          two to four (leaning) towers carrying a long sky park
 *  5 halo tower       a tapering stalk with one to three inhabited rings on spokes
 *  6 orbs             spheres on a stalk (pearl), or a cube of spheres on its corner (atom)
 *  7 stack            blocks piled at angles around a core, cantilevering, with gaps
 *
 * Same frame and rules as the other landmarks (plan/landmarkParts): local u / v, absolute heights,
 * `k.B` the floor level. They are not destructible (no landmark is).
 */
import type { Rng } from '../core/rng';
import type { Landmark } from './landmarks';
import { Kit, mat, entranceSteps, WHITE, WIN, CURTAIN, ROOF, CONC, PANEL, GLASS, METAL, GRANITE, METAL_ROOF, GRAVEL, GREEN_ROOF, type PartMat, type RGB } from './landmarkParts';
import { designHall, type HallPlan } from '../interior/design/hall';
import { emitDesign } from '../interior/design/emit';
import { scifiTheme } from '../interior/design/theme';
import { starshipProgram, starshipItems } from '../interior/fill/starship';
import { ellipseStar, type Volume } from '../interior/design/types';
import { twistInside } from './twistParts';

export const MARVEL_STYLES = 8;
export const enum MS { Starship = 0, Helix = 1, Porous = 2, Twist = 3, Skyship = 4, Halo = 5, Orbs = 6, Stack = 7 }

/** Near-future palettes: [hull or wall tint, accent tint, glass tint]. */
const PALETTES: [RGB, RGB, RGB][] = [
  [[0.95, 0.95, 0.96], [0.85, 0.72, 0.45], [0.75, 0.88, 1.0]], // pearl and champagne
  [[0.42, 0.44, 0.48], [0.95, 0.55, 0.2], [0.7, 0.8, 0.9]],     // graphite and orange
  [[0.86, 0.9, 0.93], [0.3, 0.7, 0.75], [0.6, 0.95, 0.95]],     // white and teal
  [[0.72, 0.6, 0.48], [0.95, 0.85, 0.6], [1.0, 0.85, 0.65]],    // bronze and gold
  [[0.25, 0.27, 0.32], [0.6, 0.75, 1.0], [0.55, 0.65, 0.95]],   // night blue
  [[0.92, 0.9, 0.86], [0.75, 0.2, 0.18], [0.85, 0.9, 0.95]],    // ivory and red
];

interface Look { hull: PartMat; hullPlain: PartMat; accent: PartMat; glass: PartMat; clear: PartMat; roof: PartMat }

function look(col: number, r: Rng): Look {
  const [h, a, g] = PALETTES[col % PALETTES.length];
  const wallL = r.pick([METAL, PANEL, METAL, CONC]);
  return {
    hull: mat(wallL, h, WIN, r.range(1.8, 2.6), r.range(3.8, 4.4), 6),
    hullPlain: mat(wallL, h),
    accent: mat(METAL, a),
    glass: mat(GLASS, g, WIN | CURTAIN, 1.5, 4, 5),
    clear: mat(GLASS, g),
    roof: mat(r.chance(0.5) ? METAL_ROOF : GRAVEL, WHITE, ROOF),
  };
}

/** Profile (r, y) pairs sampling r = f(t) for t in [t0, t1] (y = B + t·H). */
function sample(f: (t: number) => number, t0: number, t1: number, B: number, H: number, per = 40): number[] {
  const n = Math.max(2, Math.ceil((t1 - t0) * per));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) { const t = t0 + ((t1 - t0) * i) / n; out.push(Math.max(0, f(t)), B + t * H); }
  return out;
}

/**
 * A lathe in bands of alternating material, cut at the given fractions of the height. Below
 * `hollow` (a fraction) the bands are a shell `wall` thick, in short rings (so the collision
 * follows the taper), open inside.
 */
function bandedLathe(k: Kit, f: (t: number) => number, cuts: number[], B: number, H: number, mats: PartMat[], sx: number, sz: number, hollow = 0, wall = 1.2): void {
  for (let i = 0; i + 1 < cuts.length; i++) {
    let t0 = cuts[i];
    const t1 = cuts[i + 1];
    while (t0 < hollow - 1e-6 && t0 < t1 - 1e-6) {
      const tb = Math.min(t1, hollow, t0 + 6 / H);
      const out = sample(f, t0, tb, B, H, H / 2.5);
      const ring = out.slice();
      for (let j = out.length - 2; j >= 0; j -= 2) ring.push(Math.max(0.5, out[j] - wall), out[j + 1]);
      ring.push(ring[0], ring[1]);
      k.lathe(0, 0, ring, sx, sz, mats[i % mats.length], { seg: 40 });
      t0 = tb;
    }
    if (t0 >= t1 - 1e-6) continue;
    const p = k.lathe(0, 0, sample(f, t0, t1, B, H), sx, sz, mats[i % mats.length], { seg: 40 });
    // Inner joints need no caps.
    if (i + 2 < cuts.length || t0 > cuts[i]) p.noSides = true;
  }
}

/** A sphere of radius R centred at height y (around the local point u, v). */
function sphere(k: Kit, u: number, v: number, y: number, R: number, m: PartMat, clear = false, steps = 12): void {
  const prof: number[] = [];
  for (let i = 0; i <= steps; i++) { const a = -Math.PI / 2 + (i / steps) * Math.PI; prof.push(Math.cos(a) * R, y + Math.sin(a) * R); }
  k.lathe(u, v, prof, 1, 1, m, { seg: 24, clear, map: y - R < k.B + 2 ? 1 : 0 });
}

export function marvel(k: Kit, lm: Landmark, r: Rng): void {
  const L = look(lm.p.col, r);
  switch (lm.style as MS) {
    case MS.Starship: return starship(k, lm, r, L);
    case MS.Helix: return helixTower(k, lm, r, L);
    case MS.Porous: return porous(k, lm, r, L);
    case MS.Twist: return twist(k, lm, r, L);
    case MS.Skyship: return skyship(k, lm, r, L);
    case MS.Halo: return halo(k, lm, r, L);
    case MS.Orbs: return orbs(k, lm, r, L);
    case MS.Stack: return stack(k, lm, r, L);
  }
}

// ------------------------------------------------------------------ 0 starship spire

function starship(k: Kit, lm: Landmark, r: Rng, L: Look): void {
  const P = lm.p, B = k.B, H = P.h, R = P.R;
  // Hull radius over the height (t = 0 … 1): rocket, teardrop or stepped.
  const nose = r.range(0.8, 0.9), tip = r.range(0.035, 0.06);
  const f = P.prof === 0
    ? (t: number) => t < nose ? R * (1.04 - 0.28 * Math.pow(t / nose, 1.6) + 0.06 * Math.sin(Math.min(1, t / 0.15) * Math.PI)) : R * 0.76 * Math.sqrt(Math.max(0, 1 - Math.pow((t - nose) / (1 - nose), 2))) + R * tip * ((t - nose) / (1 - nose))
    : P.prof === 1
      ? (t: number) => R * (0.62 + 0.5 * Math.sin(Math.min(1, t / 0.28) * Math.PI / 2)) * Math.pow(Math.max(0, 1 - Math.pow(Math.max(0, t - 0.28) / 0.72, 1.7)), 0.55) + R * 0.02
      : (t: number) => {
        const st = t < 0.36 ? 1 : t < 0.4 ? 0.82 : t < 0.68 ? 0.86 : t < 0.72 ? 0.66 : 0.7;
        return t < 0.74 ? R * st : R * 0.7 * Math.pow(Math.max(0, 1 - (t - 0.74) / 0.26), 0.7) + R * tip * 0.5;
      };
  // The inside (its own seed, so the outside stays as it was): a great hall up the middle.
  const hall = starshipHall(lm, f, B, H, P.ell);
  if (hall) halls.set(lm, hall);
  const hollow = hall ? (hall.top - B) / H : 0, DOOR_T = 3.4 / H;
  // Bands: hull sections with windows, thin glass rings between them.
  const nb = r.int(5, 9), cuts = [0];
  for (let i = 1; i < nb; i++) {
    const t = (i / nb) * nose * 0.96;
    cuts.push(t - r.range(0.012, 0.025), t);
  }
  cuts.push(nose * 0.96, 1);
  const mats: PartMat[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) mats.push(i % 2 ? L.glass : i === cuts.length - 2 ? L.hullPlain : L.hull);
  if (hall) {
    // The doorways at the foot: the hull's lowest ring is wall pieces with gaps on the site's axes.
    bandedLathe(k, f, [DOOR_T, ...cuts.slice(1)], B, H, mats, 1, P.ell, hollow);
  } else bandedLathe(k, f, cuts, B, H, mats, 1, P.ell);
  // Needle and beacon.
  k.cyl(0, 0, R * 0.05, 0.3, B + H, B + H * 1.04, L.accent, { solid: false, seg: 8 });
  // Fins: swept buttresses from the ground up the hull (convex leading edge, like a rocket's),
  // with an engine pod at each foot; strap-on boosters between them on some.
  const fins = P.fins, a0 = r.range(0, Math.PI * 2), top = P.finTop * H, th = R * r.range(0.07, 0.11);
  const bulge = r.range(1.6, 3);
  const pr = R * r.range(0.18, 0.26), ph = H * r.range(0.05, 0.08);
  for (let i = 0; i < fins; i++) {
    const a = a0 + (i / fins) * Math.PI * 2;
    k.sub(0, 0, a, () => {
      const inner = f(P.finTop) * 0.85, foot = P.engines ? ph * 1.05 : H * 0.03;
      // (Its root runs up the hull's skin; with a hall inside it must not reach in.)
      const skin = (t: number) => f(t) / Math.hypot(Math.cos(a), Math.sin(a) / P.ell) * 0.94;
      const out: number[] = [hall ? skin(0) : R * 0.5, B, P.finR, B];
      const n = 12;
      for (let j = 0; j <= n; j++) {
        const s = j / n;
        out.push(inner + (P.finR - inner) * (1 - Math.pow(s, bulge)), B + foot + s * (top - foot));
      }
      out.push(hall ? skin(P.finTop) * 0.9 : R * 0.3, B + top + R * 0.4);
      k.prism(0, 0, out, th, L.hull, { top: L.accent });
      // A stripe along the fin's leading edge (near only).
      for (let j = 0; j < n; j++) {
        const s0 = j / n, s1 = (j + 1) / n;
        const u0 = inner + (P.finR - inner) * (1 - Math.pow(s0, bulge)), u1 = inner + (P.finR - inner) * (1 - Math.pow(s1, bulge));
        k.strut(u0 + 0.3, 0, B + foot + s0 * (top - foot), u1 + 0.3, 0, B + foot + s1 * (top - foot), th * 1.2, L.accent, { detail: true });
      }
      if (P.engines) {
        // Engine pod: a nacelle with a glowing ring, its bell flaring to the ground.
        k.lathe(P.finR, 0, [pr * 1.05, B, pr * 0.7, B + ph * 0.12, pr, B + ph * 0.3, pr, B + ph * 0.8, pr * 0.55, B + ph * 1.05, pr * 0.1, B + ph * 1.15], 1, 1, L.hull, { seg: 24 });
        k.cyl(P.finR, 0, pr * 1.02, pr * 1.02, B + ph * 0.5, B + ph * 0.58, L.glass, { solid: false, seg: 24, detail: true });
      }
    });
  }
  if (P.boosters) {
    const br = R * r.range(0.32, 0.45), bh = H * r.range(0.32, 0.55);
    for (let i = 0; i < fins; i++) {
      // (Hugging the hull, or just touching it when there is a hall inside.)
      const a = a0 + ((i + 0.5) / fins) * Math.PI * 2, d = hall ? Math.max(f(0), f(0.2)) + br * 1.03 : f(0.2) * 0.92 + br * 0.75;
      const bu = Math.cos(a) * d, bv = Math.sin(a) * d * P.ell;
      const bf = (t: number) => (t < 0.82 ? br * (t < 0.04 ? 0.8 + t * 5 : 1) : br * Math.sqrt(Math.max(0, 1 - (t - 0.82) / 0.18)) + 0.3);
      const cutsB = [0, 0.3, 0.31, 0.62, 0.63, 1];
      for (let j = 0; j + 1 < cutsB.length; j++) {
        const q = k.lathe(bu, bv, sample(bf, cutsB[j], cutsB[j + 1], B, bh, 30), 1, 1, j % 2 ? L.glass : L.hull, { seg: 24 });
        if (j + 2 < cutsB.length) q.noSides = true;
      }
    }
  }
  // Observation rings: decks around the hull with glass balustrades.
  for (let d = 0; d < P.decks; d++) {
    const t = r.range(0.35, nose * 0.9), y = B + t * H, rin = f(t) * 0.9, ext = R * r.range(0.18, 0.35);
    k.lathe(0, 0, [rin, y - 1.4, rin + ext, y - 0.5, rin + ext, y], 1, P.ell, L.accent, { map: 0 });
    const g = k.lathe(0, 0, [rin + ext - 0.3, y, rin + ext - 0.3, y + 1.3], 1, P.ell, L.clear, { clear: true, detail: true });
    g.noSides = true;
  }
  // The lobby at the foot: a glazed drum round the hull (with a hall: a way in between each fin
  // and the gap after it, clear of fins and boosters).
  if (hall) {
    const doors = Array.from({ length: fins }, (_, i) => a0 + ((i + 0.17) / fins) * Math.PI * 2);
    hallDoors.set(lm, doors);
    starshipInside(k, hall, f, B, P.ell, L, doors);
    return;
  }
  const lr = f(0) * P.ell * 1.08 + 4;
  k.cyl(0, 0, lr, lr, B, B + 7, L.glass, { foot: true, top: L.roof, seg: 40 });
}

const halls = new WeakMap<Landmark, HallPlan>(), hallDoors = new WeakMap<Landmark, number[]>();
/** The local angles of a starship's lobby doors (after its parts were made). */
export function marvelDoors(lm: Landmark): number[] { return hallDoors.get(lm) ?? []; }
/** A starship's great hall as planned (after its parts were made: plan/landmarkParts), or null. */
export function marvelHall(lm: Landmark): HallPlan | null { return halls.get(lm) ?? null; }

/** Lobby height, hull skin thickness and door width at the foot of a starship with a hall. */
const LOBBY_H = 7, SKIN = 1.2, DOOR_W = 4.2;

/** The starship's great hall: the designer's plan for the hull's lower part, or null if too slim. */
function starshipHall(lm: Landmark, f: (t: number) => number, B: number, H: number, ell: number): HallPlan | null {
  const vol: Volume = { y0: B, y1: B + H, section: (y) => ellipseStar(0, 0, f((y - B) / H) - SKIN - 0.1, ell) };
  return designHall(vol, {
    y0: B, yMax: B + Math.min(66, Math.max(40, H * 0.08)), levelH: 5, slab: 0.5, walk: 3.6, depth: 13, minDepth: 8, roomW: 11,
    rooms: starshipProgram, items: starshipItems,
    seed: (lm.seed ^ 0x51f1) >>> 0, bridgeEvery: 3,
  });
}

/**
 * Inside the starship: the lobby drum round the foot with doors on the site's four axes (where
 * the site's approaches arrive), doorways through the hull, the great hall from the designer, and
 * a glowing core up the middle of the void with bridges out to it every few levels.
 */
function starshipInside(k: Kit, hall: HallPlan, f: (t: number) => number, B: number, ell: number, L: Look, doorsAt: number[]): void {
  const T = scifiTheme(L.accent.tint);
  const rh = f(0), lr = rh * 1.08 + 4, F = k.F;
  const P = (a: number, rr: number, sz = ell): [number, number] => [Math.cos(a) * rr, Math.sin(a) * rr * sz];
  // The floor: one plate under lobby and hall, down to the ground.
  k.cyl(0, 0, lr, lr, F, B, L.hullPlain, { top: T.walk, seg: 40 });
  // Ring pieces round (u, v) radius rr scaled by sz, with gaps at the doors (half width hw).
  const ring = (rr: number, sz: number, y0: number, y1: number, th: number, m: PartMat, seg: number, hw: number) => {
    for (let j = 0; j < seg; j++) {
      const a0 = (j / seg) * Math.PI * 2, a1 = ((j + 1) / seg) * Math.PI * 2, am = (a0 + a1) / 2;
      const p0 = P(a0, rr, sz), p1 = P(a1, rr, sz);
      // (On an oval ring the door's direction is a different angle along the ring.)
      if (doorsAt.some((d) => { const t = Math.atan2(Math.sin(d), Math.cos(d) * sz); return Math.abs(Math.atan2(Math.sin(am - t), Math.cos(am - t))) * rr * Math.min(1, sz) < hw + (Math.PI * rr) / seg; })) {
        // A door piece: only the lintel above it.
        k.box((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / 2 + 0.05, th / 2, y0 + 3.2, y1, m, { rot: Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) });
        continue;
      }
      k.box((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / 2 + 0.05, th / 2, y0, y1, m, { rot: Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) });
    }
  };
  // The drum (glass, its roof a ring from the hull out) and the hull's foot with its doorways.
  ring(lr, 1, B, B + LOBBY_H, 0.3, L.glass, 48, DOOR_W / 2);
  // (Plates from the hull's skin, oval or not, out to the round drum.)
  for (let j = 0; j < 48; j++) {
    const a0 = (j / 48) * Math.PI * 2, a1 = ((j + 1) / 48) * Math.PI * 2;
    const t0 = Math.atan2(Math.sin(a0), Math.cos(a0) * ell), t1 = Math.atan2(Math.sin(a1), Math.cos(a1) * ell);
    k.rampQ([P(t0, rh), P(t1, rh), P(a1, lr + 0.4, 1), P(a0, lr + 0.4, 1)], B + LOBBY_H - 0.4, B + LOBBY_H, B + LOBBY_H, 0, L.roof, { top: L.roof, noSides: true, map: 0 });
  }
  ring(rh - SKIN / 2, ell, B, B + 3.4, SKIN, L.hullPlain, 56, DOOR_W / 2);
  for (const d of doorsAt) {
    // Steps down to the square outside each door (the floor stands at the site's highest ground).
    k.sub(0, 0, d + Math.PI / 2, () => entranceSteps(k, -lr, DOOR_W / 2 + 0.4, B, mat(GRANITE, [0.8, 0.8, 0.82])));
    // A glowing frame round the lobby door, benches and planters along the lobby.
    const [du, dv] = P(d, lr - 0.4, 1);
    k.box(du, dv, 0.15, DOOR_W / 2 + 0.3, B + 3.2, B + 3.45, T.glow, { detail: true, map: 0, rot: d });
  }
  // The great hall (drawn only close by: the hull hides it).
  const top = hall.top, cr = Math.max(1.8, hall.voidR * 0.14);
  k.inner(() => {
    emitDesign(k, hall.design, T);
    // The core: a glowing column with metal rings, standing in a pool of light.
    k.cyl(0, 0, cr, cr, B, top - 0.5, T.glow, { detail: true, map: 0, seg: 20 });
    k.solidCyl(0, 0, cr, B, top);
    for (let y = B + 6; y < top - 2; y += 9) k.cyl(0, 0, cr + 0.4, cr + 0.4, y, y + 0.6, T.trim, { detail: true, map: 0, seg: 20 });
    k.cyl(0, 0, cr + 3, cr + 3, B, B + 0.06, T.glow, { detail: true, map: 0, seg: 28 });
    // Bridges from the galleries to a ring round the core on every third level.
    hall.levels.forEach((y, i) => {
      if (!hall.bridges[i]) return;
      const rin = cr + 1.2, rout = cr + 4.2;
      k.lathe(0, 0, [rin, y - 0.4, rout, y - 0.4, rout, y, rin, y, rin, y - 0.4], 1, 1, T.walk, { detail: true, solid: true, deck: true, map: 0, seg: 28 });
      for (const w of hall.bridges[i] ?? []) {
        const a = ((w + 0.5) / hall.n) * Math.PI * 2;
        const p0 = P(a, rout - 0.3, 1), p1 = P(a, hall.voidR + 0.4);
        const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        k.box((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, len / 2, 1.2, y - 0.4, y, T.walk, { detail: true, solid: true, deck: true, map: 0, rot: Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) });
        for (const s of [-1, 1]) k.box((p0[0] + p1[0]) / 2 - Math.sin(Math.atan2(p1[1] - p0[1], p1[0] - p0[0])) * 1.15 * s, (p0[1] + p1[1]) / 2 + Math.cos(Math.atan2(p1[1] - p0[1], p1[0] - p0[0])) * 1.15 * s, len / 2, 0.04, y, y + 0.08, T.glow, { detail: true, map: 0, rot: Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) });
      }
    });
  });
  // Indoors: the whole hall (lobby ring and galleries), lit up the core.
  const poly: [number, number][] = [];
  for (let j = 0; j < 24; j++) poly.push(P((j / 24) * Math.PI * 2, rh));
  k.roomPoly(poly, B - 0.5, top);
  for (let y = B + 4; y < top; y += 10) for (const a of [0, 2.1, 4.2]) { const [u, v] = P(a, cr + 2, 1); k.light(u, v, y); }
}

// ------------------------------------------------------------------ 1 helix tower

function helixTower(k: Kit, lm: Landmark, r: Rng, L: Look): void {
  const P = lm.p, B = k.B, H = P.h, R = P.coreR;
  const core = r.chance(0.5) ? L.glass : L.hull;
  const yTop = B + H;
  k.cyl(0, 0, R, R, B, yTop, core, { foot: true, top: L.roof, seg: 36 });
  // The walkway(s): from the ground to the roof, glazed all round; its floor a light stone.
  const floorM = mat(GRANITE, [0.92, 0.9, 0.86]);
  const frame = { ...L.accent, flags: 0 };
  const sense = r.chance(0.5) ? 1 : -1, a0 = r.range(0, Math.PI * 2);
  const inner = R * Math.cos(Math.PI / 36) - 0.05;
  const walks = P.double ? 2 : 1;
  for (let w = 0; w < walks; w++) {
    k.helix(0, 0, inner, R + P.w, B, yTop, sense * P.turns, a0 + w * Math.PI, P.hh, frame, L.clear, { top: floorM });
  }
  // Roof: a parapet ring of glass (clear) and the crown.
  const par = k.lathe(0, 0, [R - 0.2, yTop, R - 0.2, yTop + 1.2], 1, 1, L.clear, { clear: true, detail: true });
  par.noSides = true;
  if (P.crown === 0) {
    // A glass dome over the roof garden (one can stand under it).
    const dr = R * 0.8, prof: number[] = [];
    for (let i = 0; i <= 8; i++) { const a = (i / 8) * Math.PI / 2; prof.push(Math.cos(a) * dr + 0.01, yTop + Math.sin(a) * dr * 0.7); }
    k.lathe(0, 0, prof, 1, 1, L.clear, { clear: true });
    k.cyl(0, 0, 0.3, 0.1, yTop + dr * 0.7, yTop + dr * 0.7 + R * 1.2, L.accent, { solid: false, seg: 6 });
  } else if (P.crown === 1) {
    // A spire with stacked rings.
    k.cyl(0, 0, R * 0.12, 0.2, yTop, yTop + H * 0.2, L.accent, { seg: 10 });
    for (let i = 0; i < 4; i++) {
      const y = yTop + H * 0.03 + i * H * 0.035, rr = R * (0.55 - i * 0.1);
      k.lathe(0, 0, [rr, y, rr, y + 1.2], 1, 1, L.accent, { solid: false, map: 0 }).noSides = true;
    }
  } else {
    // A tilted-looking crown: a cone of fins round a lantern.
    k.cyl(0, 0, R * 0.45, R * 0.4, yTop, yTop + 6, L.glass, { seg: 24 });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      k.sub(0, 0, a, () => k.prism(0, 0, [R * 0.4, yTop, R * 0.95, yTop, R * 0.2, yTop + R * 1.6], 0.25, L.accent, { solid: false }));
    }
  }
}

// ------------------------------------------------------------------ 2 porous slab

/** Round holes for a slab (u ∈ ±hu, y ∈ y0 … y1): big ones first, apart from each other and the edges. */
function placeHoles(r: Rng, hu: number, y0: number, y1: number, want: number, rMin: number, rMax: number): number[] {
  const out: number[] = [];
  const edge = Math.max(3, hu * 0.12);
  for (let tries = 0; tries < 400 && out.length / 3 < want; tries++) {
    const big = 1 - (out.length / 3) / Math.max(1, want);
    const rad = Math.min(hu - edge, rMin + (rMax - rMin) * r.float() * (0.4 + 0.6 * big));
    if (rad < rMin * 0.8) continue;
    const u = r.range(-hu + edge + rad, hu - edge - rad);
    const y = r.range(y0 + 10 + rad, y1 - 6 - rad);
    if (y - rad < y0 + 8 || y + rad > y1 - 5) continue;
    let ok = true;
    for (let i = 0; i < out.length && ok; i += 3) ok = Math.hypot(out[i] - u, out[i + 1] - y) > out[i + 2] + rad + 4;
    if (ok) out.push(u, y, rad);
  }
  return out;
}

function porous(k: Kit, lm: Landmark, r: Rng, L: Look): void {
  const P = lm.p, B = k.B, H = P.h, hw = P.w / 2, hd = P.d / 2;
  const lining = r.pick([L.accent, mat(GREEN_ROOF, [0.8, 1, 0.8]), mat(PANEL, [1, 0.97, 0.9])]);
  const wall = r.chance(0.5) ? L.glass : L.hull;
  const slabs = P.twin ? 2 : 1;
  const gap = P.twin ? r.range(6, 12) : 0;
  const t = slabs === 1 ? hd : (hd * 2 - gap) / 4;
  for (let i = 0; i < slabs; i++) {
    const v = slabs === 1 ? 0 : (i ? 1 : -1) * (t + gap / 2);
    const h = H * (i ? r.range(0.75, 0.95) : 1);
    const holes = placeHoles(r, hw, B, B + h, P.holes, Math.max(5, hw * 0.22), hw * 0.85);
    k.perf(0, v, hw, t, B, B + h, holes, wall, { foot: true, top: L.roof, back: lining });
  }
  if (P.twin) {
    // Bridges between the twin slabs every so often.
    const n = r.int(2, 4);
    for (let i = 0; i < n; i++) {
      const y = B + H * r.range(0.2, 0.7), u = r.range(-hw * 0.6, hw * 0.6);
      k.box(u, 0, r.range(4, 8), gap / 2 + 0.5, y, y + r.range(4, 8), L.glass, { solid: true, map: 0 });
    }
  }
  // A crown: a thin glass slab or a row of masts.
  if (r.chance(0.5)) k.box(0, 0, hw * 0.7, hd * 0.5, B + H, B + H + r.range(6, 14), L.glass, { top: L.roof });
  else for (let i = 0; i < 3; i++) k.cyl((i - 1) * hw * 0.5, 0, 0.4, 0.15, B + H, B + H + r.range(12, 30), L.accent, { solid: false, seg: 6 });
}

// ------------------------------------------------------------------ 3 twisted tower

function twist(k: Kit, lm: Landmark, r: Rng, L: Look): void {
  const P = lm.p, B = k.B, H = P.h, n = Math.max(8, Math.round(H / P.segH)), dh = H / n;
  const wall = r.chance(0.6) ? L.glass : L.hull;
  const ease = r.chance(0.5);
  const tw = (i: number) => { const t = i / n; return P.twist * (ease ? (1 - Math.cos(t * Math.PI)) / 2 : t); };
  const sz = (i: number) => 1 - (1 - P.taper) * (i / n);
  // The lowest storeys walkable (plan/twistParts), solid blocks above.
  const [, a, g] = PALETTES[P.col % PALETTES.length];
  const m = twistInside(k, lm, { n, dh, tw, s: sz, wall, plain: L.hullPlain, roof: L.roof, accent: a, glass: g });
  for (let i = m; i < n; i++) {
    const s = sz(i), y = B + i * dh;
    k.box(0, 0, P.side * s, P.side * s * P.aspect, y, y + dh, wall, { rot: tw(i), foot: i === 0 ? true : undefined, top: L.roof });
    // Floor plate lips every other block (near only).
    if (i % 2 === 1) k.box(0, 0, P.side * s + 0.6, P.side * s * P.aspect + 0.6, y + dh - 0.4, y + dh, L.hullPlain, { rot: tw(i), detail: true, solid: false });
  }
  const tw1 = P.twist, s1 = P.taper;
  if (r.chance(0.5)) k.pyramid(0, 0, P.side * s1, P.side * s1 * P.aspect, B + H, B + H + P.side * s1 * r.range(1.5, 3), 0, L.accent, { rot: tw1 });
  else k.cyl(0, 0, 0.6, 0.15, B + H, B + H + H * 0.12, L.accent, { solid: false, seg: 6 });
}

// ------------------------------------------------------------------ 4 skyship

function skyship(k: Kit, lm: Landmark, r: Rng, L: Look): void {
  const P = lm.p, B = k.B, H = P.towerH, n = P.towers, tw = P.towerT / 2, td = P.towerD / 2;
  const span = (n - 1) * P.gap;
  const wall = r.chance(0.5) ? L.glass : L.hull;
  for (let i = 0; i < n; i++) {
    const u = -span / 2 + i * P.gap;
    if (P.lean) {
      // Two legs, one upright and one leaning in, joined towards the top (a flared tower).
      const lean = td * r.range(0.6, 1.1);
      k.sub(u, 0, Math.PI / 2, () => {
        k.prism(0, 0, [-td, B, -td * 0.1, B, -td * 0.1 + lean * 0.15, B + H, -td, B + H], tw, wall, { top: L.roof, foot: true });
        k.prism(0, 0, [td * 0.1 + lean, B, td + lean, B, td, B + H, td * 0.1, B + H], tw, wall, { top: L.roof, foot: true });
      });
    } else k.box(u, 0, tw, td, B, B + H, wall, { foot: true, top: L.roof });
  }
  // The sky park: a long boat-shaped deck on the towers, cantilevering beyond the last one.
  const dl = P.deckL / 2, dw = P.deckW / 2, y = B + H;
  const deck = k.lathe(0, 0, [0.82, y - 1, 1, y + 2.5, 1, y + 4.5], dl, dw, L.hull, { top: mat(GREEN_ROOF), map: 0 });
  void deck;
  // A pool along the deck and a glass balustrade round it.
  k.flat(-dl * 0.25, -dw * 0.35, dl * 0.45, dw * 0.22, y + 4.55, mat(GLASS, [0.3, 0.75, 0.95]), { detail: true, map: 0 });
  const bal = k.lathe(0, 0, [0.985, y + 4.5, 0.985, y + 5.7], dl, dw, L.clear, { clear: true, detail: true });
  bal.noSides = true;
  // Pavilions on the deck.
  for (let i = 0; i < 3; i++) k.box(dl * (0.2 + i * 0.22), dw * 0.2, r.range(4, 7), r.range(3, 5), y + 4.5, y + 8, L.glass, { top: L.roof, map: 0 });
}

// ------------------------------------------------------------------ 5 halo tower

function halo(k: Kit, lm: Landmark, r: Rng, L: Look): void {
  const P = lm.p, B = k.B, H = P.h, S = P.stalkR;
  const f = (t: number) => S * (1.7 - 1.1 * t) * (t > 0.96 ? Math.max(0.1, (1 - t) / 0.04) : 1);
  const cuts = [0];
  const nb = r.int(4, 7);
  for (let i = 1; i < nb; i++) cuts.push(i / nb - 0.015, i / nb);
  cuts.push(1);
  bandedLathe(k, f, cuts, B, H, cuts.slice(1).map((_, i) => (i % 2 ? L.glass : L.hull)), 1, 1);
  k.cyl(0, 0, 0.5, 0.1, B + H, B + H * 1.08, L.accent, { solid: false, seg: 6 });
  // Rings: an inhabited torus (flattened section) on spokes, the biggest lowest.
  const flat = r.range(0.45, 0.75);
  for (let i = 0; i < P.rings; i++) {
    const t = P.ringAt - i * r.range(0.12, 0.18);
    if (t < 0.3) break;
    const yc = B + t * H, RR = P.ringR * (1 - i * 0.22), T = P.tubeR * (1 - i * 0.15);
    const prof: number[] = [];
    for (let j = 0; j <= 16; j++) { const a = -Math.PI / 2 + (j / 16) * Math.PI * 2; prof.push(RR + Math.cos(a) * T, yc + Math.sin(a) * T * flat); }
    k.lathe(0, 0, prof, 1, 1, r.chance(0.6) ? L.glass : L.hull, { seg: 48, map: 0 });
    const sp = P.spokes, a0 = r.range(0, Math.PI);
    for (let s = 0; s < sp; s++) {
      const a = a0 + (s / sp) * Math.PI * 2, rs = f(t);
      k.sub(0, 0, a, () => k.tube((rs + RR - T) / 2, 0, yc, (RR - T - rs) / 2 + 0.5, T * 0.22, T * 0.16, L.accent, { map: 0 }));
    }
  }
}

// ------------------------------------------------------------------ 6 orbs

function orbs(k: Kit, lm: Landmark, r: Rng, L: Look): void {
  const P = lm.p, B = k.B;
  const orbM = (i: number) => (i % 3 === 2 ? L.glass : mat(METAL, [0.9, 0.92, 0.95], WIN, 2.2, 4, 4));
  if (P.atom) {
    // A cube of spheres standing on a corner (its diagonal upright), joined along its edges and to its centre.
    const e = P.edge, R = P.R, yc = B + P.lift + e * Math.sqrt(3) / 2;
    const yaw = r.range(0, Math.PI * 2);
    // Rotation that turns (1, 1, 1) upright, then a turn about the vertical.
    const pts: [number, number, number][] = [];
    for (let i = 0; i < 8; i++) {
      const x = (i & 1 ? 1 : -1) * e / 2, y = (i & 2 ? 1 : -1) * e / 2, z = (i & 4 ? 1 : -1) * e / 2;
      // Basis: up = (1, 1, 1)/√3, a = (1, -1, 0)/√2, b = (1, 1, -2)/√6.
      const up = (x + y + z) / Math.sqrt(3), a = (x - y) / Math.SQRT2, b = (x + y - 2 * z) / Math.sqrt(6);
      pts.push([a * Math.cos(yaw) - b * Math.sin(yaw), yc + up, a * Math.sin(yaw) + b * Math.cos(yaw)]);
    }
    const tube = R * 0.22;
    for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
      const d = i ^ j;
      if (d !== 1 && d !== 2 && d !== 4) continue;
      k.strut(pts[i][0], pts[i][2], pts[i][1], pts[j][0], pts[j][2], pts[j][1], tube, L.accent);
    }
    for (let i = 0; i < 8; i++) k.strut(pts[i][0], pts[i][2], pts[i][1], 0, 0, yc, tube, L.accent);
    pts.forEach((q, i) => sphere(k, q[0], q[2], q[1], R, orbM(i)));
    sphere(k, 0, 0, yc, R, orbM(2));
    // The lowest sphere stands on a pedestal; three legs hold the cube.
    const low = pts.reduce((a, b) => (b[1] < a[1] ? b : a));
    k.cyl(low[0], low[2], R * 0.4, R * 0.3, B, low[1] - R * 0.9, L.hullPlain, { foot: true, seg: 16 });
    for (let i = 0; i < 3; i++) {
      const a = yaw + (i / 3) * Math.PI * 2 + 0.5, d = e * 0.75;
      k.strut(Math.cos(a) * d, Math.sin(a) * d, B, 0, 0, yc - e * 0.25, tube * 1.3, L.hullPlain);
      k.cyl(Math.cos(a) * d, Math.sin(a) * d, tube * 2, tube * 2, B, B + 3, L.hullPlain, { foot: true, seg: 10 });
    }
    return;
  }
  // Pearl: spheres strung along a tapering stalk, some offset on arms.
  const H = P.h, S = P.R * 0.28;
  k.cyl(0, 0, S, S * 0.6, B, B + H, L.hullPlain, { foot: true, seg: 16 });
  k.cyl(0, 0, S * 0.5, 0.1, B + H, B + H * 1.15, L.accent, { solid: false, seg: 8 });
  let y = B + H * r.range(0.18, 0.28);
  for (let i = 0; i < P.n && y < B + H; i++) {
    const R = P.R * r.range(0.45, 1);
    const off = i > 0 && r.chance(0.4) ? R + S + r.range(4, 10) : 0, a = r.range(0, Math.PI * 2);
    const u = Math.cos(a) * off, v = Math.sin(a) * off;
    if (off) k.sub(0, 0, a, () => k.tube(off / 2, 0, y + R * 0.1, off / 2, S * 0.6, S * 0.6, L.accent));
    sphere(k, u, v, y + R * 0.1, R, orbM(i), r.chance(0.2));
    y += R * 2 + r.range(4, 14);
  }
}

// ------------------------------------------------------------------ 7 stack

function stack(k: Kit, lm: Landmark, r: Rng, L: Look): void {
  const P = lm.p, B = k.B, n = P.blocks;
  const coreR = Math.min(P.W, P.L) * 0.22;
  let y = B, ang = r.range(0, Math.PI), top = B;
  const walls = [L.glass, L.hull, mat(PANEL, [0.95, 0.95, 0.95], WIN, 2.4, 3.6, 4)];
  for (let i = 0; i < n; i++) {
    const h = r.range(P.H * 0.7, P.H * 1.25);
    const du = (r.float() * 2 - 1) * P.off, dv = (r.float() * 2 - 1) * P.off * 0.5;
    ang += P.mode === 0 ? Math.PI / 2 + r.range(-0.1, 0.1) : r.range(0.25, 0.75) * (r.chance(0.5) ? 1 : -1);
    k.sub(0, 0, ang, () => {
      k.box(du, dv, P.L / 2, P.W / 2, y, y + h, walls[(i + P.col) % walls.length], { top: mat(GREEN_ROOF), foot: i === 0 ? true : undefined });
    });
    top = y + h;
    // Gaps between some blocks show the core.
    y = top + (i < n - 1 && r.chance(P.gaps) ? r.range(4, 9) : 0);
  }
  k.cyl(0, 0, coreR, coreR, B, top, L.hullPlain, { foot: true, seg: 16 });
  k.cyl(0, 0, coreR * 0.7, coreR * 0.7, top, top + 5, L.glass, { top: L.roof, seg: 16 });
}
