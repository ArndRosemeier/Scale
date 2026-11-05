/**
 * The things that stick to the magnetic grandma: cutlery, tins, keys, a pot lid, a frying pan, a
 * wrench, scissors, a horseshoe, bottle caps … and now and then a whole bicycle.
 *
 * A few primitives each. Geometries and materials are shared by every piece (built once, never
 * disposed): a handful of plain MeshStandardMaterials, so no new shader programs beyond the
 * standard one every prop already uses (Arnd's shader budget).
 *
 * Convention: the side that touches her is at z = 0 and the piece stands out along +Z; its long
 * axis is +Y. The bicycle lies in the x–y plane (its wheels flat against her back).
 */
import * as THREE from 'three';
import { srgbColor } from '../../../render/color';

export type JunkKind = 'fork' | 'spoon' | 'knife' | 'tin' | 'keys' | 'lid' | 'pan' | 'wrench' | 'scissors' | 'horseshoe' | 'caps' | 'whisk' | 'bicycle';

export interface JunkDef {
  /** What she calls it in a line. */
  word: string;
  /** How often it comes (relative). */
  weight: number;
  /** Where it comes from: a café table, a shop door, a passer-by's pocket, the street. */
  from: readonly ('table' | 'shop' | 'pocket' | 'street')[];
}

export const JUNK: Record<JunkKind, JunkDef> = {
  fork: { word: 'a fork', weight: 3, from: ['table', 'shop'] },
  spoon: { word: 'a teaspoon', weight: 3, from: ['table', 'pocket'] },
  knife: { word: 'a butter knife', weight: 2, from: ['table'] },
  tin: { word: 'a tin of peas', weight: 3, from: ['shop', 'street'] },
  keys: { word: 'somebody\'s keys', weight: 2.5, from: ['pocket'] },
  lid: { word: 'a pot lid', weight: 1.2, from: ['shop'] },
  pan: { word: 'a frying pan', weight: 0.8, from: ['shop'] },
  wrench: { word: 'a spanner', weight: 1, from: ['street', 'shop'] },
  scissors: { word: 'a pair of scissors', weight: 1, from: ['shop', 'pocket'] },
  horseshoe: { word: 'a horseshoe', weight: 0.6, from: ['street'] },
  caps: { word: 'bottle caps', weight: 2, from: ['table', 'street'] },
  whisk: { word: 'a whisk', weight: 0.8, from: ['shop'] },
  bicycle: { word: 'a bicycle', weight: 0, from: ['street'] },
};

export const SMALL_JUNK: JunkKind[] = (Object.keys(JUNK) as JunkKind[]).filter((k) => k !== 'bicycle');

type C3 = [number, number, number];
const mats = new Map<string, THREE.MeshStandardMaterial>();
const mat = (key: string, c: C3, rough: number, metal: number): THREE.MeshStandardMaterial => {
  let m = mats.get(key);
  if (!m) { m = new THREE.MeshStandardMaterial({ color: srgbColor(c), roughness: rough, metalness: metal }); mats.set(key, m); }
  return m;
};
const STEEL = () => mat('steel', [0.78, 0.79, 0.8], 0.28, 0.9);
const IRON = () => mat('iron', [0.16, 0.16, 0.17], 0.55, 0.7);
const BRASS = () => mat('brass', [0.78, 0.6, 0.28], 0.35, 0.85);
const RED = () => mat('red', [0.72, 0.1, 0.08], 0.5, 0.3);
const BLUE = () => mat('blue', [0.12, 0.3, 0.62], 0.5, 0.3);
const LABELS: (() => THREE.MeshStandardMaterial)[] = [
  () => mat('lbl-g', [0.24, 0.55, 0.2], 0.6, 0.1), () => mat('lbl-r', [0.75, 0.16, 0.12], 0.6, 0.1),
  () => mat('lbl-y', [0.9, 0.72, 0.18], 0.6, 0.1), () => mat('lbl-b', [0.2, 0.36, 0.7], 0.6, 0.1),
];
const BLACK = () => mat('black', [0.05, 0.05, 0.05], 0.6, 0.2);

const geos = new Map<string, THREE.BufferGeometry>();
const geo = (key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry => {
  let g = geos.get(key);
  if (!g) { g = make(); geos.set(key, g); }
  return g;
};
const box = (w: number, h: number, d: number) => geo(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
const cyl = (rt: number, rb: number, h: number, n = 12) => geo(`c${rt},${rb},${h},${n}`, () => new THREE.CylinderGeometry(rt, rb, h, n));
const torus = (r: number, t: number, arc = Math.PI * 2, n = 18) => geo(`t${r},${t},${arc},${n}`, () => new THREE.TorusGeometry(r, t, 5, n, arc));
const sphere = (r: number) => geo(`s${r}`, () => new THREE.SphereGeometry(r, 8, 6));

function put(g: THREE.Group, gm: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s?: [number, number, number]): THREE.Mesh {
  const o = new THREE.Mesh(gm, m);
  o.position.set(x, y, z);
  o.rotation.set(rx, ry, rz);
  if (s) o.scale.set(...s);
  o.castShadow = true;
  g.add(o);
  return o;
}

/** One piece of the kind (`v` picks the colour of tins and handles). */
export function junkMesh(kind: JunkKind, v = 0): THREE.Object3D {
  const g = new THREE.Group();
  g.name = `junk:${kind}`;
  const S = STEEL();
  switch (kind) {
    case 'fork':
      put(g, box(0.012, 0.11, 0.004), S, 0, -0.03, 0.004);
      for (let k = 0; k < 4; k++) put(g, box(0.003, 0.045, 0.003), S, -0.0075 + k * 0.005, 0.05, 0.004);
      put(g, box(0.024, 0.012, 0.004), S, 0, 0.026, 0.004);
      break;
    case 'spoon':
      put(g, box(0.009, 0.09, 0.004), S, 0, -0.025, 0.004);
      put(g, sphere(0.018), S, 0, 0.035, 0.006, 0, 0, 0, [0.8, 1.2, 0.3]);
      break;
    case 'knife':
      put(g, box(0.014, 0.08, 0.005), S, 0, 0.045, 0.004);
      put(g, box(0.012, 0.075, 0.008), v % 2 ? BLACK() : S, 0, -0.035, 0.005);
      break;
    case 'tin':
      // Lying on its side against her: its axis across (x).
      put(g, cyl(0.035, 0.035, 0.09, 14), LABELS[v % LABELS.length](), 0, 0, 0.036, 0, 0, Math.PI / 2);
      for (const sx of [-1, 1]) put(g, cyl(0.036, 0.036, 0.006, 14), S, sx * 0.046, 0, 0.036, 0, 0, Math.PI / 2);
      break;
    case 'keys': {
      put(g, torus(0.016, 0.0025), S, 0, 0.02, 0.003);
      const m = v % 2 ? BRASS() : S;
      for (let k = 0; k < 3; k++) {
        const a = -0.5 + k * 0.5;
        const key = new THREE.Group();
        put(key, box(0.008, 0.045, 0.003), m, 0, -0.03, 0);
        put(key, cyl(0.011, 0.011, 0.003, 10), m, 0, -0.002, 0, Math.PI / 2);
        key.position.set(0, 0.006, 0.004 + k * 0.002);
        key.rotation.z = a;
        g.add(key);
      }
      break;
    }
    case 'lid':
      put(g, cyl(0.1, 0.11, 0.012, 20), S, 0, 0, 0.008, Math.PI / 2);
      put(g, sphere(0.018), BLACK(), 0, 0, 0.026);
      break;
    case 'pan':
      put(g, cyl(0.12, 0.1, 0.03, 20), IRON(), 0, 0.04, 0.016, Math.PI / 2);
      put(g, box(0.024, 0.16, 0.014), BLACK(), 0, -0.15, 0.016);
      break;
    case 'wrench':
      put(g, box(0.018, 0.16, 0.006), S, 0, 0, 0.004);
      put(g, torus(0.016, 0.006, Math.PI * 1.4, 10), S, 0, 0.09, 0.004, 0, 0, -Math.PI * 0.2);
      put(g, torus(0.013, 0.005), S, 0, -0.088, 0.004);
      break;
    case 'scissors':
      for (const sx of [-1, 1]) {
        put(g, box(0.008, 0.075, 0.003), S, sx * 0.006, 0.035, 0.003 + (sx > 0 ? 0.003 : 0), 0, 0, sx * 0.12);
        put(g, torus(0.014, 0.004), v % 2 ? RED() : BLUE(), sx * 0.016, -0.02, 0.004);
      }
      break;
    case 'horseshoe':
      put(g, torus(0.05, 0.009, Math.PI * 1.4, 16), IRON(), 0, 0, 0.009, 0, 0, -Math.PI * 0.2);
      break;
    case 'caps':
      for (let k = 0; k < 4; k++) put(g, cyl(0.014, 0.014, 0.005, 10), k % 2 ? RED() : S, (k - 1.5) * 0.024, ((k * 7) % 3 - 1) * 0.015, 0.003, Math.PI / 2);
      break;
    case 'whisk':
      put(g, cyl(0.01, 0.01, 0.1, 8), S, 0, -0.07, 0.012);
      for (let k = 0; k < 3; k++) put(g, torus(0.03, 0.0018, Math.PI * 2, 16), S, 0, 0.03, 0.02, 0, k * (Math.PI / 3), 0, [0.6, 1.3, 1]);
      break;
    case 'bicycle':
      return bicycle(v);
  }
  return g;
}

/** A plain town bike, flat in the x–y plane (wheels round z), its middle at the origin. */
function bicycle(v: number): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'junk:bicycle';
  const frame = [RED, BLUE, () => mat('green', [0.18, 0.42, 0.3], 0.5, 0.3), BLACK][v % 4]();
  const S = STEEL(), T = BLACK();
  const R = 0.33, wb = 1.02;
  for (const sx of [-1, 1]) {
    put(g, torus(R, 0.022, Math.PI * 2, 28), T, sx * wb / 2, 0, 0);
    put(g, torus(R - 0.03, 0.006, Math.PI * 2, 24), S, sx * wb / 2, 0, 0);
    for (let k = 0; k < 4; k++) put(g, box(0.004, (R - 0.03) * 2, 0.004), S, sx * wb / 2, 0, 0, 0, 0, (k * Math.PI) / 4);
  }
  // Frame tubes (centre, length, angle in the plane).
  const tube = (x0: number, y0: number, x1: number, y1: number, r = 0.018, m: THREE.Material = frame) => {
    const L = Math.hypot(x1 - x0, y1 - y0);
    put(g, cyl(r, r, L, 8), m, (x0 + x1) / 2, (y0 + y1) / 2, 0, 0, 0, Math.atan2(-(x1 - x0), y1 - y0));
  };
  const bb: [number, number] = [-0.02, -0.02], seat: [number, number] = [-0.18, 0.42], head: [number, number] = [0.36, 0.4];
  tube(...bb, ...seat); tube(...bb, ...head); tube(...seat, ...head);
  tube(...bb, -wb / 2, 0); tube(...seat, -wb / 2, 0);
  tube(...head, wb / 2, 0, 0.015);
  tube(seat[0], seat[1], seat[0] - 0.03, seat[1] + 0.14, 0.012, S);
  put(g, box(0.2, 0.05, 0.1), T, seat[0] - 0.05, seat[1] + 0.16, 0);
  tube(head[0], head[1], head[0] - 0.04, head[1] + 0.18, 0.013, S);
  put(g, cyl(0.012, 0.012, 0.5, 8), S, head[0] - 0.05, head[1] + 0.19, 0, Math.PI / 2);
  put(g, cyl(0.06, 0.06, 0.012, 14), S, bb[0], bb[1], 0.03, Math.PI / 2);
  // A basket on the front (it's that kind of bike).
  put(g, box(0.26, 0.18, 0.3), mat('wicker', [0.55, 0.4, 0.22], 0.9, 0), head[0] + 0.14, head[1] + 0.02, 0);
  // (A small town bike: a little under full size, so it reads on her back.)
  g.scale.setScalar(0.85);
  return g;
}

/** Rough size (m) of a piece: how far it stands out and how big it is in the hand. */
export const junkSize = (k: JunkKind): number => (k === 'bicycle' ? 1.4 : k === 'pan' ? 0.3 : k === 'lid' ? 0.22 : k === 'wrench' ? 0.18 : 0.11);
