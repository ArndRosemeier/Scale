/**
 * Models of the aftermath (THREATS_PLAN §2–3, src/game/aftermath): the EMS triage tent with its sign
 * (a white cross on green, the first-aid sign) and cots, police barriers with a warning lamp, cordon
 * tape and its posts, a memorial's flowers and candles, a piece of a carcass and the crane's hook.
 *
 * Built like the military models (props/military.ts): low-poly pieces, every vertex tagged with a
 * `VPart`, drawn instanced with the one shared vehicle material — no new program. Colours come from
 * the per-instance paint (canvas, matte paint); candle flames are headlight parts (lit with
 * iState.x), barrier lamps are indicators (blinking with iState.z = 2). Origin at the foot, +Y up.
 */
import * as THREE from 'three';
import { Geo, rbox, blob, finalize, VPart } from './vehicles';

// (Plain numbers, as in military.ts: vehicles.ts may not be initialised while this module loads.)
const M = 17 /* Matte */, C = 18 /* Canvas */, P = 4 /* Plastic */, X = 14 /* Cargo (off-white) */, H = 5 /* Headlight */, I = 8 /* Indicator */, U = 10 /* Undercarriage */;
const part = (p: number) => () => p;

function box(g: Geo, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, p: number, r = 0.02): void {
  rbox(g, (x0 + x1) / 2, (x1 - x0) / 2, y0, y1, z0, z1, r, part(p), 1);
}

/** A slanted thin panel between two edges (a tent roof half): quad from (x0,y0) to (x1,y1) across z0..z1, both faces. */
function slab(g: Geo, x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, p: number): void {
  const nx = -(y1 - y0), ny = x1 - x0, l = Math.hypot(nx, ny) || 1;
  const n: [number, number, number] = [nx / l, ny / l, 0];
  g.quadN([x0, y0, z0], [x1, y1, z0], [x1, y1, z1], [x0, y0, z1], [0, 0], [1, 0], [1, 1], [0, 1], p, n);
  g.quadN([x0, y0, z0], [x1, y1, z0], [x1, y1, z1], [x0, y0, z1], [0, 0], [1, 0], [1, 1], [0, 1], p, [-n[0], -n[1], 0]);
}

/** The triage tent: 6 × 4.2 m, walls on three sides, a ridged roof, poles; open towards +Z. */
export function triageTent(): THREE.BufferGeometry {
  const g = new Geo();
  const w = 3, d = 2.1, eave = 2.0, ridge = 2.8;
  slab(g, -w, eave, 0, ridge, -d, d, C);
  slab(g, 0, ridge, w, eave, -d, d, C);
  // Back and side walls (thin boxes of canvas), gables.
  box(g, -w, w, 0, eave, -d - 0.02, -d + 0.02, C, 0.01);
  for (const sx of [-1, 1]) box(g, sx * w - 0.02, sx * w + 0.02, 0, eave, -d, d * 0.35, C, 0.01);
  for (const z of [-d, d]) g.quadN([-w, eave, z], [w, eave, z], [0, ridge, z], [0, ridge, z], [0, 0], [1, 0], [0.5, 1], [0.5, 1], C, [0, 0, z < 0 ? -1 : 1]);
  // Poles at the corners and the ridge ends.
  for (const sx of [-1, 1]) for (const z of [-d, d]) box(g, sx * w - 0.04, sx * w + 0.04, 0, eave, z - 0.04, z + 0.04, P, 0.01);
  for (const z of [-d, d]) box(g, -0.04, 0.04, 0, ridge, z - 0.04, z + 0.04, P, 0.01);
  return finalize(g, 30);
}

/** The first-aid sign over the tent's opening: a green panel (paint) with a white cross. */
export function tentSign(): THREE.BufferGeometry {
  const g = new Geo();
  box(g, -0.55, 0.55, 0, 1.1, -0.03, 0.03, M, 0.02);
  box(g, -0.12, 0.12, 0.2, 0.9, 0.03, 0.06, X, 0.01);
  box(g, -0.35, 0.35, 0.43, 0.67, 0.03, 0.06, X, 0.01);
  return finalize(g, 30);
}

/** A field cot: a frame on folding legs, a canvas top (paint), 2 × 0.7 m along Z. */
export function cot(): THREE.BufferGeometry {
  const g = new Geo();
  box(g, -0.35, 0.35, 0.44, 0.5, -1, 1, C, 0.02);
  for (const sx of [-1, 1]) box(g, sx * 0.35 - 0.025, sx * 0.35 + 0.025, 0.4, 0.5, -1.02, 1.02, P, 0.01);
  for (const z of [-0.85, 0.85]) for (const sx of [-1, 1]) box(g, sx * 0.3 - 0.02, sx * 0.3 + 0.02, 0, 0.42, z - 0.02, z + 0.02, P, 0.005);
  return finalize(g, 30);
}

/** A police barrier, 2 m along X: two splayed legs, a striped board (paint with off-white bands), an amber lamp. */
export function barrier(): THREE.BufferGeometry {
  const g = new Geo();
  for (const sx of [-0.85, 0.85]) {
    box(g, sx - 0.04, sx + 0.04, 0, 1.0, -0.04, 0.04, P, 0.01);
    box(g, sx - 0.05, sx + 0.05, 0, 0.05, -0.3, 0.3, P, 0.01);
  }
  box(g, -1, 1, 0.72, 1.0, -0.03, 0.03, M, 0.01);
  for (let k = 0; k < 5; k++) { const x = -0.8 + k * 0.4; box(g, x - 0.08, x + 0.08, 0.73, 0.99, -0.034, 0.034, X, 0.004); }
  box(g, 0.75, 0.95, 1.0, 1.04, -0.03, 0.03, P, 0.005);
  blob(g, [0.85, 1.1, 0], [0.07, 0.06, 0.07], 8, 4, 0.6, part(I));
  return finalize(g, 30);
}

/** Cordon tape: a 1 m band along +X at 0.95 m (scaled along X to the span), paint with off-white bands. */
export function tape(): THREE.BufferGeometry {
  const g = new Geo();
  for (let k = 0; k < 4; k++) box(g, k * 0.25, k * 0.25 + 0.125, 0.92, 0.99, -0.004, 0.004, M, 0.001);
  for (let k = 0; k < 4; k++) box(g, k * 0.25 + 0.125, k * 0.25 + 0.25, 0.92, 0.99, -0.004, 0.004, X, 0.001);
  return finalize(g, 30);
}

/** A tape post: a pole on a round weighted foot. */
export function tapePost(): THREE.BufferGeometry {
  const g = new Geo();
  box(g, -0.025, 0.025, 0, 1.02, -0.025, 0.025, M, 0.01);
  blob(g, [0, 0.03, 0], [0.18, 0.04, 0.18], 10, 3, 0.8, part(P));
  return finalize(g, 30);
}

/** A bouquet lying on the ground: blooms (paint), a paper wrap (off-white), along +Z. */
export function bouquet(): THREE.BufferGeometry {
  const g = new Geo();
  blob(g, [0, 0.06, 0.12], [0.1, 0.05, 0.22], 8, 4, 0.8, part(X));
  for (let k = 0; k < 5; k++) {
    const a = k * 2.4, r = 0.06;
    blob(g, [Math.cos(a) * r, 0.1 + (k % 2) * 0.03, -0.12 + Math.sin(a) * r * 0.6], [0.06, 0.05, 0.06], 6, 4, 0.7, part(C));
  }
  return finalize(g, 30);
}

/** A candle in a glass: an off-white body and a flame (a headlight part: lit at night). */
export function candle(): THREE.BufferGeometry {
  const g = new Geo();
  box(g, -0.045, 0.045, 0, 0.14, -0.045, 0.045, X, 0.02);
  blob(g, [0, 0.165, 0], [0.018, 0.035, 0.018], 6, 4, 0.7, part(H));
  return finalize(g, 30);
}

/** A cut piece of the carcass (hide: matte paint, dark), about 1 m across (scaled per piece). */
export function chunk(): THREE.BufferGeometry {
  const g = new Geo();
  blob(g, [0, 0.45, 0], [0.62, 0.45, 0.5], 10, 6, 0.75, part(M));
  blob(g, [0.25, 0.65, 0.15], [0.35, 0.3, 0.32], 8, 5, 0.7, part(M));
  blob(g, [-0.3, 0.3, -0.1], [0.3, 0.28, 0.35], 8, 5, 0.7, part(U));
  return finalize(g, 30);
}

/** The crane's hook block hanging under the boom tip: a cable from the origin down 1 m (scaled to its length) is separate. */
export function hookBlock(): THREE.BufferGeometry {
  const g = new Geo();
  box(g, -0.22, 0.22, -0.6, 0, -0.14, 0.14, M, 0.04);
  blob(g, [0, -0.85, 0], [0.12, 0.2, 0.06], 8, 4, 0.6, part(P));
  return finalize(g, 30);
}

/** A cable: 1 m down from the origin (scaled along Y). */
export function cable(): THREE.BufferGeometry {
  const g = new Geo();
  box(g, -0.025, 0.025, -1, 0, -0.025, 0.025, P, 0.005);
  return finalize(g, 30);
}

export { VPart };
