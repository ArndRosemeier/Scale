/**
 * Military models (THREATS_PLAN §4.5, Phase B stage 2): an army truck (6×6 with a canvas cover), an
 * eight-wheeled APC with a small autocannon turret, a main battle tank (tracks, road wheels, a
 * turret that turns and a gun that pitches and recoils), an attack helicopter (body, main and tail
 * rotors), a strike jet and a sandbag wall.
 *
 * Built like the other vehicles (props/vehicles.ts): low-poly pieces from the same builders, every
 * vertex tagged with a `VPart`, so everything draws with the one shared vehicle material (and its
 * program) — instanced, one draw call per kind. Military paint is `VPart.Matte` (the paint colour,
 * matte and dusty), covers and sandbags `VPart.Canvas`. Forward = −Z, up = +Y, metres.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Geo, rbox, blob, tubeZ, finalize, buildWheel, v3, VPart, type Built, type V3 } from './vehicles';

// (Plain numbers: vehicles.ts imports this module, so its VPart is not initialised yet while this
// module's top level runs — VPart is only read inside the builders.)
const M = 17 /* VPart.Matte */, C = 18 /* VPart.Canvas */, U = 10 /* VPart.Undercarriage */, P = 4 /* VPart.Plastic */, G = 1 /* VPart.Glass */;
const part = (p: number) => () => p;

/** An axis-aligned box (slightly rounded). */
function box(g: Geo, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, p: number, r = 0.03): void {
  rbox(g, (x0 + x1) / 2, (x1 - x0) / 2, y0, y1, z0, z1, r, part(p), 1);
}

/** A convex profile in the ZY plane (points in order round it) extruded from x0 to x1, with caps. */
function extrudeX(g: Geo, prof: [number, number][], x0: number, x1: number, p: number): void {
  let cz = 0, cy = 0;
  for (const [z, y] of prof) { cz += z; cy += y; }
  cz /= prof.length; cy /= prof.length;
  const n = prof.length;
  for (let i = 0; i < n; i++) {
    const [za, ya] = prof[i], [zb, yb] = prof[(i + 1) % n];
    const mz = (za + zb) / 2 - cz, my = (ya + yb) / 2 - cy;
    // Outward normal of the edge (perpendicular, pointing away from the centre).
    let nz = yb - ya, ny = -(zb - za);
    if (nz * mz + ny * my < 0) { nz = -nz; ny = -ny; }
    g.quadN([x0, ya, za], [x1, ya, za], [x1, yb, zb], [x0, yb, zb], [0, 0], [1, 0], [1, 1], [0, 1], p, [0, ny, nz]);
  }
  for (const [x, s] of [[x0, -1], [x1, 1]] as [number, number][]) {
    for (let i = 0; i < n; i++) {
      const [za, ya] = prof[i], [zb, yb] = prof[(i + 1) % n];
      g.triN([x, cy, cz], [x, ya, za], [x, yb, zb], [0.5, 0.5], [0, 0], [1, 0], p, [s, 0, 0]);
    }
  }
}

/** A flat plate in the XZ plane (convex outline), y0..y1 thick (wings, tailplanes). */
function plateY(g: Geo, outline: [number, number][], y0: number, y1: number, p: number): void {
  let cx = 0, cz = 0;
  for (const [x, z] of outline) { cx += x; cz += z; }
  cx /= outline.length; cz /= outline.length;
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const [xa, za] = outline[i], [xb, zb] = outline[(i + 1) % n];
    g.triN([cx, y1, cz], [xa, y1, za], [xb, y1, zb], [0.5, 0.5], [0, 0], [1, 0], p, [0, 1, 0]);
    g.triN([cx, y0, cz], [xa, y0, za], [xb, y0, zb], [0.5, 0.5], [0, 0], [1, 0], p, [0, -1, 0]);
    let nx = zb - za, nz = -(xb - xa);
    if (nx * ((xa + xb) / 2 - cx) + nz * ((za + zb) / 2 - cz) < 0) { nx = -nx; nz = -nz; }
    g.quadN([xa, y0, za], [xb, y0, zb], [xb, y1, zb], [xa, y1, za], [0, 0], [1, 0], [1, 1], [0, 1], p, [nx, 0, nz]);
  }
}

function wheelsAt(x: number, R: number, zs: number[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const z of zs) out.push(v3(x, R, z), v3(-x, R, z));
  return out;
}

const lamp = (g: Geo, x: number, y: number, z: number, p: number, s = 0.11) => box(g, x - s, x + s, y - s * 0.6, y + s * 0.6, z - 0.03, z + 0.03, p, 0.01);

// ---------------------------------------------------------------- army truck (6×6, canvas cover)

export function buildArmyTruck(): Built {
  const g = new Geo();
  const R = 0.56;
  // Chassis rails and the bed platform.
  for (const s of [-1, 1]) box(g, s * 0.62 - 0.08, s * 0.62 + 0.08, 0.75, 1.0, -3.9, 3.9, U);
  box(g, -1.24, 1.24, 1.0, 1.24, -1.85, 3.98, M);
  // Cab: boxy, a flat windscreen, side windows, a roof hatch.
  box(g, -1.17, 1.17, 1.0, 2.62, -3.95, -2.0, M, 0.12);
  box(g, -1.0, 1.0, 1.78, 2.42, -3.97, -3.92, G, 0.02);
  for (const s of [-1, 1]) box(g, s * 1.17 - 0.02, s * 1.17 + 0.02, 1.8, 2.35, -3.6, -2.5, G, 0.01);
  box(g, -0.35, 0.35, 2.62, 2.7, -3.2, -2.6, M, 0.03);
  // Bonnet and grille, bumper, headlights, mirrors.
  box(g, -1.05, 1.05, 0.95, 1.72, -4.45, -3.9, M, 0.08);
  box(g, -0.72, 0.72, 1.02, 1.6, -4.47, -4.42, P, 0.01);
  box(g, -1.2, 1.2, 0.72, 0.98, -4.6, -4.4, U, 0.03);
  for (const s of [-1, 1]) { lamp(g, s * 0.85, 1.38, -4.47, VPart.Headlight, 0.12); box(g, s * 1.3 - 0.05, s * 1.3 + 0.05, 1.9, 2.25, -3.7, -3.62, P, 0.01); }
  // Bed sides and the canvas cover on hoops.
  for (const s of [-1, 1]) box(g, s * 1.24 - 0.04, s * 1.24 + 0.04, 1.24, 1.82, -1.85, 3.98, M, 0.01);
  rbox(g, 0, 1.26, 1.3, 3.15, -1.8, 3.92, 0.55, (n) => (n[1] < -0.5 ? U : C), 4);
  // Tail lights, fuel tank, spare wheel carrier, mudguards.
  for (const s of [-1, 1]) lamp(g, s * 1.0, 0.95, 4.0, VPart.Taillight, 0.09);
  box(g, -1.22, -0.8, 0.6, 1.0, -1.7, -0.6, M, 0.12);
  for (const z of [-3.0, 1.55, 2.95]) for (const s of [-1, 1]) box(g, s * 1.08 - 0.3, s * 1.08 + 0.3, R * 2 + 0.03, R * 2 + 0.09, z - R - 0.15, z + R + 0.15, M, 0.02);
  return { body: finalize(g, 38), wheel: buildWheel(R, 0.42, 0.3, 'steel'), wheelRadius: R, wheels: wheelsAt(1.04, R, [-3.0, 1.55, 2.95]), mass: 11000, driverSeat: v3(-0.5, 1.6, -3.0) };
}

// ---------------------------------------------------------------- APC (8×8, small autocannon turret)

export function buildApc(): Built {
  const g = new Geo();
  const R = 0.58;
  // Hull: a sloped glacis, flat sides, a raised rear compartment.
  extrudeX(g, [[-3.85, 0.95], [-3.35, 0.52], [3.55, 0.52], [3.78, 1.0], [3.72, 2.18], [-1.7, 2.25], [-3.9, 1.38]], -1.42, 1.42, M);
  // Turret ring, turret and autocannon.
  rbox(g, 0, 0.72, 2.22, 2.78, -0.5, 0.95, 0.12, part(M), 2);
  box(g, -0.24, 0.24, 2.36, 2.64, -1.0, -0.5, M, 0.04);
  tubeZ(g, [0, 2.5, -2.0], 0.065, 2.1, 8, U, U, 1);
  tubeZ(g, [0.42, 2.66, -0.7], 0.09, 0.5, 8, M, U, 1);
  // Vision blocks, hatches, headlights, rear door, stowage, side skirts over the wheels.
  box(g, -0.9, 0.9, 1.72, 1.86, -3.12, -3.0, G, 0.01);
  for (const z of [1.4, 2.6]) box(g, -0.5, 0.5, 2.2, 2.3, z - 0.4, z + 0.4, M, 0.04);
  for (const s of [-1, 1]) { lamp(g, s * 1.1, 1.2, -3.86, VPart.Headlight, 0.1); lamp(g, s * 1.15, 1.6, 3.76, VPart.Taillight, 0.08); }
  box(g, -0.7, 0.7, 0.8, 1.95, 3.74, 3.8, M, 0.02);
  for (const s of [-1, 1]) {
    box(g, s * 1.44 - 0.04, s * 1.44 + 0.04, 1.2, 1.55, -3.2, 3.3, M, 0.02);
    box(g, s * 1.3 - 0.2, s * 1.3 + 0.2, 1.95, 2.2, 0.0, 3.0, C, 0.06);
  }
  return { body: finalize(g, 38), wheel: buildWheel(R, 0.42, 0.3, 'steel'), wheelRadius: R, wheels: wheelsAt(1.3, R, [-2.7, -1.45, 1.0, 2.25]), mass: 22000, driverSeat: v3(-0.6, 1.4, -2.6) };
}

// ---------------------------------------------------------------- main battle tank

/** Turret pivot (body space) and gun pivot (turret space). */
export const TANK_TURRET: V3 = [0, 1.55, 0.35];
export const TANK_GUN: V3 = [0, 0.5, -2.2];

export function buildTank(): Built {
  const g = new Geo();
  const R = 0.36;
  // Hull between the tracks, a long glacis, the engine deck.
  extrudeX(g, [[-3.75, 0.85], [-3.25, 0.42], [3.4, 0.42], [3.75, 0.8], [3.7, 1.5], [-2.3, 1.56], [-3.8, 1.02]], -1.3, 1.3, M);
  // Sponsons over the tracks, side skirts.
  for (const s of [-1, 1]) {
    box(g, s * 1.3 - (s > 0 ? 0 : 0.58), s * 1.3 + (s > 0 ? 0.58 : 0), 1.16, 1.52, -3.55, 3.65, M, 0.04);
    box(g, s * 1.9 - 0.04, s * 1.9 + 0.04, 0.58, 1.18, -3.45, 3.45, M, 0.02);
    // The track: a long rounded loop (dark), its top run showing above the skirt line at the ends.
    rbox(g, s * 1.6, 0.27, 0.05, 1.0, -3.7, 3.65, 0.46, part(U), 4);
  }
  // Engine deck grilles, headlights, tail lights, tow hooks.
  box(g, -1.0, 1.0, 1.5, 1.57, 2.0, 3.4, P, 0.01);
  for (const s of [-1, 1]) { lamp(g, s * 1.15, 1.32, -3.79, VPart.Headlight, 0.08); lamp(g, s * 1.2, 1.3, 3.72, VPart.Taillight, 0.07); }
  return {
    body: finalize(g, 38), wheel: buildWheel(R, 0.36, 0.28, 'steel'), wheelRadius: R, wheels: wheelsAt(1.6, R + 0.02, [-2.6, -1.56, -0.52, 0.52, 1.56, 2.6]), mass: 60000, driverSeat: v3(-0.6, 1.2, -2.4),
    turret: { geo: tankTurret(), pivot: TANK_TURRET, gun: tankGun(), gunPivot: TANK_GUN },
  };
}

function tankTurret(): THREE.BufferGeometry {
  const g = new Geo();
  // A low, wide turret with a wedge front and a bustle at the back.
  extrudeX(g, [[-1.75, 0.0], [-2.25, 0.42], [-1.7, 0.86], [1.85, 0.86], [2.25, 0.5], [2.0, 0.05]], -1.62, 1.62, M);
  // Mantlet, commander's cupola, sights, stowage basket, smoke dischargers.
  box(g, -0.45, 0.45, 0.22, 0.78, -2.45, -2.0, M, 0.05);
  blob(g, [0.62, 0.98, 0.45], [0.36, 0.16, 0.36], 10, 6, 0.6, part(M));
  box(g, -0.95, -0.55, 0.86, 1.08, -1.2, -0.85, G, 0.03);
  box(g, -1.3, 1.3, 0.3, 0.75, 2.2, 2.6, C, 0.08);
  for (const s of [-1, 1]) for (let k = 0; k < 3; k++) tubeZ(g, [s * (1.25 + k * 0.08), 0.75, -1.7 - k * 0.02], 0.06, 0.25, 6, M, U, 1);
  return finalize(g, 38);
}

function tankGun(): THREE.BufferGeometry {
  const g = new Geo();
  // Barrel along −Z from the pivot (in the mantlet), a fume extractor, the muzzle.
  tubeZ(g, [0, 0, -2.7], 0.1, 5.4, 10, M, U, 1);
  tubeZ(g, [0, 0, -2.9], 0.16, 0.75, 10, M, U, 1);
  tubeZ(g, [0, 0, -5.3], 0.13, 0.28, 10, U, U, 1);
  return finalize(g, 38);
}

// ---------------------------------------------------------------- aircraft

/** Attack helicopter: main rotor hub (body space) and tail rotor hub. */
export const HELI_ROTOR: V3 = [0, 1.95, -0.2];
export const HELI_TAIL: V3 = [0.35, 1.45, 7.55];
export const HELI_R = 7.3;

export function heliBody(): THREE.BufferGeometry {
  const g = new Geo();
  // Narrow fuselage, stepped tandem canopy, engine nacelles, tail boom and fin.
  blob(g, [0, 0, -0.5], [0.82, 1.0, 3.2], 16, 10, 0.75, part(M));
  blob(g, [0, -0.25, -3.5], [0.48, 0.5, 0.95], 12, 8, 0.8, part(M));
  blob(g, [0, 0.55, -2.45], [0.52, 0.48, 0.95], 12, 8, 0.7, part(G));
  blob(g, [0, 0.88, -1.25], [0.52, 0.5, 0.85], 12, 8, 0.7, part(G));
  for (const s of [-1, 1]) blob(g, [s * 0.78, 0.8, 0.5], [0.36, 0.36, 1.35], 10, 6, 0.8, part(M));
  blob(g, [0, 0.35, 4.3], [0.3, 0.36, 3.4], 10, 6, 0.85, part(M));
  box(g, -0.06, 0.06, 0.25, 2.25, 7.0, 7.95, M, 0.03);
  box(g, -1.15, 1.15, 0.32, 0.42, 6.55, 7.15, M, 0.03);
  // Stub wings with rocket pods, the chin gun, skids, the rotor mast.
  box(g, -2.25, 2.25, 0.05, 0.2, -0.3, 0.55, M, 0.04);
  for (const s of [-1, 1]) { tubeZ(g, [s * 1.85, -0.15, 0.12], 0.22, 1.45, 10, M, U, 1); tubeZ(g, [s * 0.95, -1.42, -0.3], 0.06, 3.6, 6, U, U, 1); box(g, s * 0.95 - 0.04, s * 0.95 + 0.04, -1.42, -0.7, -1.3, -1.2, U, 0.01); box(g, s * 0.95 - 0.04, s * 0.95 + 0.04, -1.42, -0.7, 0.7, 0.8, U, 0.01); }
  tubeZ(g, [0, -0.88, -3.45], 0.05, 1.1, 6, U, U, 1);
  box(g, -0.14, 0.14, 0.95, HELI_ROTOR[1] - 0.05, -0.35, -0.05, U, 0.04);
  lamp(g, 0, -0.6, -2.0, VPart.Taillight, 0.06);
  return finalize(g, 38);
}

/** Four main rotor blades round the hub (at the origin, turning about Y). */
export function heliRotor(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 4; k++) {
    const g = new Geo();
    rbox(g, 0, 0.26, -0.03, 0.03, 0.3, HELI_R, 0.02, part(U), 1);
    if (k === 0) blob(g, [0, 0, 0], [0.32, 0.16, 0.32], 10, 6, 0.7, part(U));
    parts.push(finalize(g, 38).rotateY((k * Math.PI) / 2));
  }
  return mergeGeometries(parts)!;
}

/** Tail rotor: two crossed blades turning about X. */
export function heliTailRotor(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 2; k++) {
    const g = new Geo();
    rbox(g, 0, 0.03, -0.1, 0.1, -0.75, 0.75, 0.01, part(U), 1);
    parts.push(finalize(g, 38).rotateX((k * Math.PI) / 2));
  }
  return mergeGeometries(parts)!;
}

/** Strike jet: fuselage, canopy, delta wings, twin fins, nozzles. */
export function jetBody(): THREE.BufferGeometry {
  const g = new Geo();
  blob(g, [0, 0, 0.2], [0.78, 0.82, 7.4], 16, 10, 0.8, part(M));
  blob(g, [0, -0.05, -6.9], [0.42, 0.42, 1.7], 12, 8, 0.9, part(M));
  blob(g, [0, 0.62, -4.3], [0.4, 0.42, 1.4], 12, 8, 0.75, part(G));
  for (const s of [-1, 1]) {
    plateY(g, [[s * 0.6, -2.0], [s * 5.4, 3.3], [s * 5.4, 4.4], [s * 0.6, 5.0]], -0.08, 0.06, M);
    plateY(g, [[s * 0.5, 5.4], [s * 2.6, 6.9], [s * 2.6, 7.5], [s * 0.5, 7.5]], -0.04, 0.04, M);
    extrudeX(g, [[4.6, 0.6], [6.8, 3.1], [7.6, 3.1], [7.6, 0.6]], s * 1.0 - 0.05, s * 1.0 + 0.05, M);
    box(g, s * 0.8 - 0.32, s * 0.8 + 0.32, -0.55, 0.15, -3.0, -0.5, M, 0.1);
    tubeZ(g, [s * 0.42, -0.05, 7.5], 0.4, 0.9, 10, U, U, 1);
  }
  return finalize(g, 38);
}

// ---------------------------------------------------------------- sandbags

/** A sandbag wall: a 3.2 m run, three layers of bags (along X), its foot at y = 0. */
export function sandbagWall(): THREE.BufferGeometry {
  const g = new Geo();
  for (let layer = 0; layer < 3; layer++) {
    const n = layer === 2 ? 5 : 6, off = layer % 2 ? 0.27 : 0;
    for (let i = 0; i < n; i++) {
      const x = -1.35 + off + i * 0.54;
      blob(g, [x, 0.12 + layer * 0.22, (layer & 1) * 0.04 - 0.02], [0.29, 0.13, 0.23], 8, 5, 0.55, part(C));
    }
  }
  return finalize(g, 50);
}
