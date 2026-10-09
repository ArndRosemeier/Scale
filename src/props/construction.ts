/**
 * Models of reconstruction (game/aftermath/Reconstruction): a scaffold bay, its safety netting, a
 * tower crane (mast sections and the slewing top with its jib), a site fence panel and a site board.
 *
 * Built like props/aftermath.ts: low-poly pieces, every vertex tagged with a `VPart`, drawn instanced
 * with the one shared vehicle material, no new program. Paint (per instance) colours the matte and
 * canvas parts: the crane's yellow, the boards' wood, the netting and fence cloth; tubes are alloy.
 * Origin at the foot, +Y up.
 */
import * as THREE from 'three';
import { Geo, rbox, finalize } from './vehicles';
import { v3cross, v3norm } from '../core/math';

// (Plain numbers, as in aftermath.ts: vehicles.ts may not be initialised while this module loads.)
const M = 17 /* Matte */, C = 18 /* Canvas */, A = 15 /* Alloy */, G = 1 /* Glass */, U = 10 /* Undercarriage */, X = 14 /* Cargo (off-white) */, P = 4 /* Plastic */;
const part = (p: number) => () => p;

type V3 = [number, number, number];

function box(g: Geo, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, p: number, r = 0.01): void {
  rbox(g, (x0 + x1) / 2, (x1 - x0) / 2, y0, y1, z0, z1, r, part(p), 1);
}

/** A square tube (half width h) from a to b, any direction: four sides, no caps. */
function beam(g: Geo, a: V3, b: V3, h: number, p: number): void {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(...d) || 1;
  const t: V3 = [d[0] / l, d[1] / l, d[2] / l];
  // Two axes across the tube.
  const ref: V3 = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = v3norm(v3cross(t, ref)) as V3;
  const v = v3cross(t, u) as V3;
  const c = (o: V3, su: number, sv: number): V3 => [o[0] + (u[0] * su + v[0] * sv) * h, o[1] + (u[1] * su + v[1] * sv) * h, o[2] + (u[2] * su + v[2] * sv) * h];
  const corners: [number, number][] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (let k = 0; k < 4; k++) {
    const [s0, t0] = corners[k], [s1, t1] = corners[(k + 1) % 4];
    const n: V3 = [u[0] * (s0 + s1) + v[0] * (t0 + t1), u[1] * (s0 + s1) + v[1] * (t0 + t1), u[2] * (s0 + s1) + v[2] * (t0 + t1)];
    g.quadN(c(a, s0, t0), c(a, s1, t1), c(b, s1, t1), c(b, s0, t0), [0, 0], [1, 0], [1, 1], [0, 1], p, n);
  }
}

/** Scaffold bay width (along the wall, +X), lift height and depth (out from the wall, +Z). */
export const BAY = { w: 2.5, h: 4, d: 1.1 };

/**
 * One scaffold bay, 2.5 m along +X, 4 m up (two 2 m lifts), standing 0.3–1.4 m out from the wall
 * (+Z): standards at x = 0 (the next bay's are its far side), ledgers, transoms, boarded decks
 * (paint: wood) with toe boards, a guard rail and a diagonal brace on the outside face.
 */
export function scaffoldBay(): THREE.BufferGeometry {
  const g = new Geo(), t = 0.03, { w, h } = BAY, zi = 0.3, zo = 0.3 + BAY.d;
  for (const z of [zi, zo]) beam(g, [0, 0, z], [0, h, z], t, A);
  for (const y of [2, 4]) {
    for (const z of [zi, zo]) beam(g, [0, y, z], [w, y, z], t * 0.9, A);
    beam(g, [0, y, zi - 0.1], [0, y, zo + 0.1], t * 0.9, A);
    // Deck boards (wood: paint) and a toe board.
    box(g, 0.02, w - 0.02, y + 0.03, y + 0.07, zi + 0.04, zo - 0.04, M, 0.005);
    box(g, 0.02, w - 0.02, y + 0.07, y + 0.22, zo - 0.05, zo - 0.03, M, 0.004);
    // Guard rail a metre above the deck.
    beam(g, [0, y - 1, zo], [w, y - 1, zo], t * 0.8, A);
  }
  beam(g, [0, 0.1, zo + 0.04], [w, 3.9, zo + 0.04], t * 0.8, A);
  // A base plate under each standard.
  for (const z of [zi, zo]) box(g, -0.08, 0.08, 0, 0.03, z - 0.08, z + 0.08, P, 0.005);
  return finalize(g, 30);
}

/** Safety netting over a bay's outside face (paint: the net's colour), 2.5 × 4 m, both faces. */
export function scaffoldNet(): THREE.BufferGeometry {
  const g = new Geo(), z = 0.3 + BAY.d + 0.08, { w, h } = BAY;
  g.quadN([0, 0.2, z], [w, 0.2, z], [w, h, z], [0, h, z], [0, 0], [1, 0], [1, 1], [0, 1], C, [0, 0, 1]);
  g.quadN([0, 0.2, z - 0.01], [w, 0.2, z - 0.01], [w, h, z - 0.01], [0, h, z - 0.01], [0, 0], [1, 0], [1, 1], [0, 1], C, [0, 0, -1]);
  return finalize(g, 30);
}

/** Tower crane mast section: 1.8 m square lattice, 4.5 m tall (paint: crane yellow). */
export const MAST = { w: 1.8, h: 4.5 };

export function craneMast(): THREE.BufferGeometry {
  const g = new Geo(), s = MAST.w / 2, h = MAST.h, t = 0.07;
  const cs: [number, number][] = [[-s, -s], [s, -s], [s, s], [-s, s]];
  for (const [x, z] of cs) beam(g, [x, 0, z], [x, h, z], t, M);
  for (let k = 0; k < 4; k++) {
    const [x0, z0] = cs[k], [x1, z1] = cs[(k + 1) % 4];
    beam(g, [x0, 0.05, z0], [x1, 0.05, z1], t * 0.6, M);
    beam(g, [x0, 0.05, z0], [x1, h / 2, z1], t * 0.5, M);
    beam(g, [x1, h / 2, z1], [x0, h - 0.05, z0], t * 0.5, M);
  }
  return finalize(g, 30);
}

/** Jib reach (m, along +X from the mast) and counter-jib length (−X). */
export const JIB = { reach: 40, back: 13, apex: 7 };

/**
 * The crane's top on a mast: slewing unit, the operator's cab, the tower head (apex), the jib (a
 * triangular lattice out along +X), the counter-jib with its concrete counterweights, tie bars,
 * the trolley with its hook hanging. Paint: crane yellow.
 */
export function craneTop(): THREE.BufferGeometry {
  const g = new Geo(), t = 0.06, s = MAST.w / 2;
  // Slewing unit and cab.
  box(g, -1.1, 1.1, 0, 0.9, -1.1, 1.1, M, 0.05);
  box(g, 0.4, 2.4, -0.4, 1.9, 1.0, 2.6, M, 0.08);
  box(g, 2.38, 2.44, 0.2, 1.7, 1.1, 2.5, G, 0.02);
  box(g, 0.5, 2.3, 0.6, 1.7, 2.58, 2.64, G, 0.02);
  // Tower head.
  const top: V3 = [0, 0.9 + JIB.apex, 0];
  for (const [x, z] of [[-s, -s], [s, -s], [s, s], [-s, s]] as [number, number][]) beam(g, [x, 0.9, z], top, t * 1.2, M);
  // Jib: two bottom chords and a top chord, zigzag diagonals.
  const y0 = 0.9, w = 0.8, hj = 1.6, L = JIB.reach;
  beam(g, [0, y0, -w], [L, y0, -w], t, M);
  beam(g, [0, y0, w], [L, y0, w], t, M);
  beam(g, [0, y0 + hj, 0], [L - 1, y0 + hj * 0.4, 0], t, M);
  for (let x = 0; x < L - 1; x += 2) {
    const k = 1 - (x / L) * 0.6, yt = y0 + hj * k, xn = x + 2, ytn = y0 + hj * (1 - (xn / L) * 0.6);
    for (const z of [-w, w]) { beam(g, [x, y0, z], [x + 1, yt, 0], t * 0.5, M); beam(g, [x + 1, yt, 0], [xn, y0, z], t * 0.5, M); }
    beam(g, [x, y0, -w], [x, y0, w], t * 0.5, M);
    void ytn;
  }
  // Counter-jib: a flat frame, a walkway, counterweights.
  const B = JIB.back;
  for (const z of [-w, w]) beam(g, [0, y0, z], [-B, y0, z], t * 1.2, M);
  for (let x = -2; x >= -B; x -= 2.2) beam(g, [x, y0, -w], [x, y0, w], t * 0.6, M);
  box(g, -B + 0.2, -0.5, y0 + 0.05, y0 + 0.1, -w + 0.1, w - 0.1, U, 0.01);
  for (let k = 0; k < 4; k++) box(g, -B + 0.3 + k * 1.05, -B + 1.25 + k * 1.05, y0 - 2.2, y0 + 0.4, -w - 0.1, w + 0.1, X, 0.05);
  // Tie bars from the apex.
  for (const z of [-0.25, 0.25]) { beam(g, top, [L * 0.62, y0 + hj * 0.63, z], t * 0.45, A); beam(g, top, [-B + 0.5, y0 + 0.1, z], t * 0.45, A); }
  // Trolley, the hook on its ropes (8 m down).
  const tx = L * 0.55;
  box(g, tx - 0.6, tx + 0.6, y0 - 0.4, y0, -w + 0.1, w - 0.1, U, 0.03);
  for (const z of [-0.12, 0.12]) beam(g, [tx, y0 - 0.4, z], [tx, y0 - 8, z], 0.015, U);
  box(g, tx - 0.25, tx + 0.25, y0 - 8.7, y0 - 8, -0.18, 0.18, M, 0.05);
  box(g, tx - 0.06, tx + 0.06, y0 - 9.2, y0 - 8.7, -0.06, 0.06, A, 0.02);
  return finalize(g, 30);
}

/** A mobile site fence panel, 3.5 m along +X, 2 m high: an alloy frame, cloth (paint), concrete feet. */
export function siteFence(): THREE.BufferGeometry {
  const g = new Geo(), L = 3.5, H = 2;
  for (const x of [0.05, L - 0.05]) {
    beam(g, [x, 0.1, 0], [x, H, 0], 0.025, A);
    box(g, x - 0.12, x + 0.12, 0, 0.14, -0.35, 0.35, X, 0.02);
  }
  for (const y of [0.15, H]) beam(g, [0.05, y, 0], [L - 0.05, y, 0], 0.022, A);
  g.quadN([0.08, 0.2, 0.01], [L - 0.08, 0.2, 0.01], [L - 0.08, H - 0.05, 0.01], [0.08, H - 0.05, 0.01], [0, 0], [1, 0], [1, 1], [0, 1], C, [0, 0, 1]);
  g.quadN([0.08, 0.2, -0.01], [L - 0.08, 0.2, -0.01], [L - 0.08, H - 0.05, -0.01], [0.08, H - 0.05, -0.01], [0, 0], [1, 0], [1, 1], [0, 1], C, [0, 0, -1]);
  return finalize(g, 30);
}

/** The site board: a 3 × 1.8 m panel (paint) with white lines of lettering, on two posts; faces +Z. */
export function siteBoard(): THREE.BufferGeometry {
  const g = new Geo();
  for (const x of [-1.2, 1.2]) beam(g, [x, 0, -0.05], [x, 3.2, -0.05], 0.05, A);
  box(g, -1.5, 1.5, 1.4, 3.2, -0.02, 0.02, M, 0.01);
  box(g, -1.3, 1.3, 2.75, 3.0, 0.02, 0.035, X, 0.003);
  for (let k = 0; k < 4; k++) box(g, -1.3, 0.2 + (k % 2) * 0.8, 1.6 + k * 0.25, 1.72 + k * 0.25, 0.02, 0.03, X, 0.002);
  return finalize(g, 30);
}
