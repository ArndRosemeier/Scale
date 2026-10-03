/**
 * Procedural street trees, shrubs and their materials.
 *
 * Everything is generated in code and deterministic per (species, variant):
 *  - wood: recursive branching (per-species level parameters, gravitropism, random curvature),
 *    every branch is limited by a species crown envelope so silhouettes read as the real species;
 *  - leaves: alpha-tested cards carrying whole twig clusters from a procedural leaf atlas,
 *    with spherical (crown-ellipsoid) normals for soft canopy lighting and baked crown occlusion;
 *  - far: a ≤150-triangle canopy hull (envelope-shaped, noise-dissolved edges in the shader).
 *
 * Materials are instancing-ready: wind phase comes from the instance's world position, the wind
 * direction is world-space (instances may have any yaw / uniform scale). Shadow casters must use
 * the matching depth material (applyVegetationShadow) so shadows sway and are leaf-shaped.
 *
 * Extra (optional) attributes beyond the documented ones:
 *  - aOcc  (float, 0 = open, 1 = deep inside the crown) on wood + leaves: baked crown occlusion.
 *  - wood uv.x encodes the bark atlas strip: uv.x = strip * 16 + u (u wraps around the branch).
 *  - far: color (vec3 linear), aAutumn (vec3 linear autumn colour), uv = (kind, deciduous).
 */
import * as THREE from 'three';
import { Rng, hash2i, hashToFloat } from '../core/rng';
import { Noise } from '../core/noise';

export type TreeSpecies = 'plane' | 'linden' | 'maple' | 'oak' | 'birch' | 'pine' | 'palm' | 'cypress' | 'chestnut' | 'ginkgo';
export const TREE_SPECIES: TreeSpecies[] = ['plane', 'linden', 'maple', 'oak', 'birch', 'pine', 'palm', 'cypress', 'chestnut', 'ginkgo'];

export interface TreeModel {
  species: TreeSpecies;
  height: number;
  trunkRadius: number;
  wood: THREE.BufferGeometry;
  leaves: THREE.BufferGeometry;
  far: THREE.BufferGeometry;
  /** true for shrubModel() results. */
  isShrub?: boolean;
  /** Crown radius (m), handy for spacing / culling. */
  crownRadius?: number;
}

export const vegetationUniforms = {
  uTime: { value: 0 },
  /** 0 = calm, 1 = strong breeze, 2 = storm. */
  uWind: { value: 0.5 },
  /** 0 = summer green, 0.5 = early autumn, 1 = full autumn colours (evergreens ignore it). */
  uSeason: { value: 0 },
};

// ---------------------------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------------------------

type V3 = THREE.Vector3;
const UP = new THREE.Vector3(0, 1, 0);
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const deg = Math.PI / 180;

function perpBasis(t: V3): [V3, V3] {
  const ref = Math.abs(t.y) < 0.92 ? UP : new THREE.Vector3(1, 0, 0);
  const p1 = new THREE.Vector3().crossVectors(t, ref).normalize();
  const p2 = new THREE.Vector3().crossVectors(t, p1).normalize();
  return [p1, p2];
}

function randUnit(rng: Rng): V3 {
  const o = rng.onSphere();
  return new THREE.Vector3(o[0], o[1], o[2]);
}

// ---------------------------------------------------------------------------------------------
// Geometry builder
// ---------------------------------------------------------------------------------------------

class VegBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  wind: number[] = [];
  tint: number[] = [];
  occ: number[] = [];
  idx: number[] = [];
  get count() { return this.pos.length / 3; }
  vert(p: V3, n: V3, u: number, v: number, w: number, tint: number, occ: number): number {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.wind.push(w);
    this.tint.push(tint);
    this.occ.push(occ);
    return this.count - 1;
  }
  tri(a: number, b: number, c: number) { this.idx.push(a, b, c); }
  build(withTint: boolean): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aWind', new THREE.Float32BufferAttribute(this.wind, 1));
    if (withTint) g.setAttribute('aLeafTint', new THREE.Float32BufferAttribute(this.tint, 1));
    g.setAttribute('aOcc', new THREE.Float32BufferAttribute(this.occ, 1));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------------------------
// Crown envelope
// ---------------------------------------------------------------------------------------------

class Envelope {
  constructor(
    public base: number,
    public top: number,
    public rx: number,
    public rz: number,
    public prof: (t: number) => number,
    public cx = 0,
    public cz = 0,
  ) {}
  get cy() { return (this.base + this.top) * 0.5; }
  get ry() { return (this.top - this.base) * 0.5; }
  /** Normalised "radius" (≈1 on the envelope surface). */
  rel(p: V3): number {
    const t = (p.y - this.base) / (this.top - this.base);
    if (t > 1) return 1 + (t - 1) * 4;
    const f = Math.max(0.02, this.prof(clamp(t, 0, 1)));
    const dx = (p.x - this.cx) / (this.rx * f), dz = (p.z - this.cz) / (this.rz * f);
    const r = Math.sqrt(dx * dx + dz * dz);
    return t < 0 ? Math.max(r, 1 + -t * 3) : r;
  }
  inside(p: V3, m = 1): boolean { return this.rel(p) <= m; }
  /** Ellipsoid-ish normal + depth (0 centre, 1 surface) for lighting. */
  shade(p: V3, out: V3): number {
    out.set((p.x - this.cx) / this.rx, (p.y - this.cy) / this.ry, (p.z - this.cz) / this.rz);
    const d = out.length();
    if (d < 1e-4) out.set(0, 1, 0);
    else out.multiplyScalar(1 / d);
    return d;
  }
  /** Distance from centre to envelope along a direction (for far hulls). */
  extent(dir: V3): number {
    const c = v3(this.cx, this.cy, this.cz);
    const p = v3();
    const maxR = Math.max(this.rx, this.rz, this.ry) * 1.6;
    let last = 0;
    for (let s = 0.05; s < maxR; s += 0.08) {
      p.copy(c).addScaledVector(dir, s);
      if (this.inside(p, 1)) last = s;
      else if (s > last + 1) break;
    }
    return last;
  }
}

// ---------------------------------------------------------------------------------------------
// Species configuration
// ---------------------------------------------------------------------------------------------

interface LevelCfg {
  n: [number, number];
  start: number;
  end: number;
  angle: number;
  angleVar: number;
  /** length: multiple of crown radius ('width') or of parent length ('parent'). */
  len: number;
  lenRef: 'width' | 'parent';
  rr: number;
  segs: number;
  radial: number;
  up: number;
  curve: number;
  phyllo: number;
  whorl?: number;
  /** extra length factor along the parent: f(t) where t = attach fraction. */
  lenProfile?: (t: number) => number;
}

type CardMode = 'cluster' | 'flat' | 'up' | 'tuft';

interface SpeciesCfg {
  height: [number, number];
  trunkR: number;
  bark: number;
  leafCell: number;
  leafSize: number;
  density: number;
  leafStart: number;
  cardMode: CardMode;
  width: number;
  crownBase: number;
  prof: (t: number) => number;
  trunkTop: number;
  trunkUp: number;
  trunkCurve: number;
  lean: number;
  flare: number;
  lobes: number;
  levels: LevelCfg[];
  /** levels whose branches carry leaves (default: last level). */
  leafLevels?: number[];
  /** cards on the trunk itself (columnar conifers). */
  trunkLeaves?: number;
  /** canopy colour for far LOD (sRGB) and autumn colour (sRGB). */
  farColor: [number, number, number];
  autumn: [number, number, number];
  evergreen?: boolean;
  /** leaf cards per tuft (crossed). */
  cross?: number;
  /** target number of leaf tufts (overrides density when given). */
  cards?: number;
}

const L = (o: Partial<LevelCfg> & Pick<LevelCfg, 'n'>): LevelCfg => ({
  start: 0.2, end: 1, angle: 45, angleVar: 12, len: 0.5, lenRef: 'parent', rr: 0.55,
  segs: 4, radial: 5, up: 0.05, curve: 0.25, phyllo: 137.5, ...o,
});

function speciesCfg(sp: TreeSpecies | 'shrub', variant: number): SpeciesCfg {
  switch (sp) {
    case 'plane':
      return {
        height: [14, 18], trunkR: 0.36, bark: 3, leafCell: 0, cards: 1700, leafSize: 1.35, density: 4.2, leafStart: 0.25, cardMode: 'cluster',
        width: 7.2, crownBase: 0.24, prof: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 0.55),
        trunkTop: 0.3, trunkUp: 0, trunkCurve: 0.08, lean: 0.04, flare: 0.35, lobes: 0.06,
        levels: [
          L({ n: [3, 4], start: 1, end: 1, whorl: 4, angle: 32, angleVar: 10, len: 1.25, lenRef: 'width', rr: 0.72, segs: 8, radial: 8, up: 0.06, curve: 0.22 }),
          L({ n: [8, 10], start: 0.18, end: 0.98, angle: 52, angleVar: 15, len: 0.55, rr: 0.5, segs: 4, radial: 5, up: 0.04, curve: 0.3 }),
          L({ n: [3, 4], start: 0.3, end: 1, angle: 48, angleVar: 15, len: 0.45, rr: 0.55, segs: 2, radial: 3, up: 0.0, curve: 0.3 }),
        ],
        farColor: [0.36, 0.45, 0.22], autumn: [0.72, 0.55, 0.25],
      };
    case 'linden':
      return {
        height: [13, 16], trunkR: 0.3, bark: 0, leafCell: 1, cards: 1600, leafSize: 1.15, density: 5.5, leafStart: 0.2, cardMode: 'cluster',
        width: 4.6, crownBase: 0.2, prof: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.85)), 0.7),
        trunkTop: 0.93, trunkUp: 0.02, trunkCurve: 0.05, lean: 0.02, flare: 0.3, lobes: 0.03,
        levels: [
          L({ n: [15, 19], start: 0.2, end: 0.92, angle: 58, angleVar: 12, len: 1.5, lenRef: 'width', rr: 0.42, segs: 5, radial: 6, up: 0.1, curve: 0.2 }),
          L({ n: [5, 7], start: 0.2, end: 0.95, angle: 48, angleVar: 14, len: 0.5, rr: 0.55, segs: 3, radial: 4, up: -0.04, curve: 0.3 }),
        ],
        leafLevels: [1, 2],
        farColor: [0.3, 0.42, 0.18], autumn: [0.82, 0.68, 0.22],
      };
    case 'maple':
      return {
        height: [11, 14], trunkR: 0.3, bark: 0, leafCell: 2, cards: 1500, leafSize: 1.2, density: 4.6, leafStart: 0.25, cardMode: 'cluster',
        width: 5.2, crownBase: 0.26, prof: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.9)), 0.5),
        trunkTop: 0.3, trunkUp: 0, trunkCurve: 0.06, lean: 0.03, flare: 0.3, lobes: 0.04,
        levels: [
          L({ n: [4, 5], start: 1, end: 1, whorl: 5, angle: 30, angleVar: 10, len: 1.3, lenRef: 'width', rr: 0.65, segs: 7, radial: 7, up: 0.08, curve: 0.2 }),
          L({ n: [7, 9], start: 0.2, end: 0.98, angle: 50, angleVar: 14, len: 0.55, rr: 0.5, segs: 3, radial: 4, up: 0.05, curve: 0.3 }),
          L({ n: [3, 3], start: 0.35, end: 1, angle: 45, angleVar: 12, len: 0.45, rr: 0.55, segs: 2, radial: 3, up: 0.02, curve: 0.3 }),
        ],
        farColor: [0.27, 0.4, 0.16], autumn: [0.85, 0.3, 0.08],
      };
    case 'oak':
      return {
        height: [12, 15], trunkR: 0.46, bark: 1, leafCell: 3, cards: 1700, leafSize: 1.15, density: 4.6, leafStart: 0.25, cardMode: 'cluster',
        width: 8, crownBase: 0.2, prof: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.72)), 0.45),
        trunkTop: 0.26, trunkUp: 0, trunkCurve: 0.14, lean: 0.06, flare: 0.45, lobes: 0.1,
        levels: [
          L({ n: [4, 5], start: 0.7, end: 1, whorl: 1, phyllo: 140, angle: 66, angleVar: 12, len: 1.3, lenRef: 'width', rr: 0.62, segs: 9, radial: 8, up: 0.0, curve: 0.95 }),
          L({ n: [7, 9], start: 0.15, end: 0.98, angle: 60, angleVar: 18, len: 0.55, rr: 0.5, segs: 4, radial: 4, up: 0.02, curve: 0.85 }),
          L({ n: [3, 4], start: 0.3, end: 1, angle: 50, angleVar: 18, len: 0.45, rr: 0.55, segs: 2, radial: 3, up: 0.02, curve: 0.5 }),
        ],
        farColor: [0.26, 0.36, 0.15], autumn: [0.55, 0.36, 0.12],
      };
    case 'birch':
      return {
        height: [13, 16], trunkR: 0.17, bark: 2, leafCell: 4, cards: 1150, leafSize: 0.95, density: 6.5, leafStart: 0.15, cardMode: 'cluster',
        width: 3.0, crownBase: 0.3, prof: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.9) * (1 - 0.25 * t),
        trunkTop: 0.96, trunkUp: 0.02, trunkCurve: 0.07, lean: 0.05, flare: 0.15, lobes: 0,
        levels: [
          L({ n: [20, 26], start: 0.28, end: 0.95, angle: 48, angleVar: 12, len: 1.6, lenRef: 'width', rr: 0.36, segs: 5, radial: 4, up: 0.02, curve: 0.25 }),
          L({ n: [4, 5], start: 0.25, end: 0.95, angle: 40, angleVar: 14, len: 0.6, rr: 0.55, segs: 3, radial: 3, up: -0.22, curve: 0.2 }),
        ],
        leafLevels: [1, 2],
        farColor: [0.38, 0.5, 0.22], autumn: [0.9, 0.75, 0.25],
      };
    case 'pine':
      if ((variant & 1) === 0) {
        // Stone / umbrella pine: tall bare trunk, flat spreading crown.
        return {
          height: [12, 15], trunkR: 0.3, bark: 4, leafCell: 8, cards: 950, leafSize: 1.05, density: 5, leafStart: 0.35, cardMode: 'tuft',
          width: 6, crownBase: 0.58,
          prof: (t) => (t < 0.45 ? Math.pow(t / 0.45, 0.6) : Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.45) / 0.55, 2.4)))),
          trunkTop: 0.6, trunkUp: 0.03, trunkCurve: 0.12, lean: 0.1, flare: 0.25, lobes: 0.03,
          levels: [
            L({ n: [4, 5], start: 1, end: 1, whorl: 5, angle: 42, angleVar: 10, len: 1.3, lenRef: 'width', rr: 0.65, segs: 6, radial: 6, up: 0.1, curve: 0.3 }),
            L({ n: [5, 7], start: 0.35, end: 0.98, angle: 45, angleVar: 14, len: 0.5, rr: 0.5, segs: 3, radial: 4, up: 0.08, curve: 0.3 }),
            L({ n: [3, 4], start: 0.4, end: 1, angle: 40, angleVar: 14, len: 0.4, rr: 0.55, segs: 2, radial: 3, up: 0.1, curve: 0.3 }),
          ],
          farColor: [0.17, 0.3, 0.14], autumn: [0.17, 0.3, 0.14], evergreen: true, cross: 2,
        };
      }
      // Conical, whorled pine / spruce form.
      return {
        height: [12, 16], trunkR: 0.27, bark: 4, leafCell: 10, cards: 1800, leafSize: 1.1, density: 3.4, leafStart: 0.1, cardMode: 'flat',
        width: 3.4, crownBase: 0.1, prof: (t) => Math.pow(1 - t, 0.95) * Math.min(1, 0.55 + t * 4),
        trunkTop: 1.0, trunkUp: 0.03, trunkCurve: 0.03, lean: 0.015, flare: 0.25, lobes: 0.02,
        levels: [
          L({ n: [22, 26], whorl: 4, phyllo: 41, start: 0.1, end: 0.97, angle: 82, angleVar: 8, len: 1.4, lenRef: 'width', rr: 0.32, segs: 4, radial: 4, up: -0.02, curve: 0.12 }),
        ],
        leafLevels: [1],
        trunkLeaves: 3,
        farColor: [0.13, 0.25, 0.14], autumn: [0.13, 0.25, 0.14], evergreen: true,
      };
    case 'cypress':
      return {
        height: [12, 16], trunkR: 0.24, bark: 6, leafCell: 9, cards: 1500, leafSize: 0.72, density: 9, leafStart: 0.0, cardMode: 'up',
        width: 1.0, crownBase: 0.03, prof: (t) => Math.pow(Math.min(1, t * 5 + 0.25), 0.5) * Math.pow(1 - t, 0.62),
        trunkTop: 0.98, trunkUp: 0.05, trunkCurve: 0.02, lean: 0.01, flare: 0.2, lobes: 0.04,
        levels: [
          L({ n: [44, 56], start: 0.04, end: 0.96, angle: 22, angleVar: 8, len: 2.2, lenRef: 'width', rr: 0.32, segs: 3, radial: 3, up: 0.25, curve: 0.15 }),
        ],
        leafLevels: [1],
        trunkLeaves: 9,
        farColor: [0.11, 0.22, 0.1], autumn: [0.11, 0.22, 0.1], evergreen: true,
      };
    case 'chestnut':
      return {
        height: [14, 17], trunkR: 0.42, bark: 1, leafCell: 5, cards: 1700, leafSize: 1.35, density: 4.4, leafStart: 0.25, cardMode: 'cluster',
        width: 6.2, crownBase: 0.24, prof: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 0.55),
        trunkTop: 0.32, trunkUp: 0, trunkCurve: 0.08, lean: 0.03, flare: 0.35, lobes: 0.06,
        levels: [
          L({ n: [3, 4], start: 1, end: 1, whorl: 4, angle: 30, angleVar: 9, len: 1.3, lenRef: 'width', rr: 0.7, segs: 8, radial: 8, up: 0.07, curve: 0.2 }),
          L({ n: [8, 10], start: 0.15, end: 0.98, angle: 55, angleVar: 14, len: 0.55, rr: 0.5, segs: 4, radial: 4, up: -0.03, curve: 0.25 }),
          L({ n: [3, 4], start: 0.3, end: 1, angle: 45, angleVar: 12, len: 0.45, rr: 0.55, segs: 2, radial: 3, up: 0.06, curve: 0.25 }),
        ],
        farColor: [0.24, 0.36, 0.14], autumn: [0.62, 0.42, 0.16],
      };
    case 'ginkgo':
      return {
        height: [12, 15], trunkR: 0.27, bark: 7, leafCell: 6, cards: 1150, leafSize: 1.0, density: 4.6, leafStart: 0.2, cardMode: 'cluster',
        width: 3.6, crownBase: 0.2, prof: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.62)), 0.75) * (1 - 0.3 * t),
        trunkTop: 0.94, trunkUp: 0.02, trunkCurve: 0.05, lean: 0.03, flare: 0.2, lobes: 0.03,
        levels: [
          L({ n: [10, 13], start: 0.2, end: 0.9, angle: 48, angleVar: 20, len: 1.5, lenRef: 'width', rr: 0.42, segs: 5, radial: 5, up: 0.16, curve: 0.3 }),
          L({ n: [4, 5], start: 0.2, end: 0.95, angle: 48, angleVar: 16, len: 0.45, rr: 0.55, segs: 3, radial: 3, up: 0.1, curve: 0.3 }),
        ],
        leafLevels: [1, 2],
        farColor: [0.36, 0.48, 0.2], autumn: [0.98, 0.78, 0.12],
      };
    case 'shrub': {
      const box = (variant & 1) === 1;
      return {
        height: [1.2, 1.8], trunkR: 0.035, bark: 7, leafCell: box ? 11 : 7, cards: 320, leafSize: 0.5, density: 15, leafStart: 0.1, cardMode: 'cluster',
        width: 0.85, crownBase: 0.04, prof: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.55),
        trunkTop: 0.02, trunkUp: 0, trunkCurve: 0, lean: 0, flare: 0, lobes: 0,
        levels: [
          L({ n: [6, 7], start: 1, end: 1, whorl: 7, angle: 38, angleVar: 16, len: 1.6, lenRef: 'width', rr: 1.0, segs: 4, radial: 4, up: 0.2, curve: 0.3 }),
          L({ n: [3, 4], start: 0.25, end: 0.95, angle: 45, angleVar: 14, len: 0.5, rr: 0.6, segs: 2, radial: 3, up: 0.1, curve: 0.3 }),
        ],
        leafLevels: [1, 2],
        farColor: box ? [0.16, 0.28, 0.12] : [0.27, 0.4, 0.17], autumn: box ? [0.16, 0.28, 0.12] : [0.7, 0.35, 0.12], evergreen: box,
      };
    }
    default:
      return speciesCfg('linden', variant);
  }
}

// ---------------------------------------------------------------------------------------------
// Branch growth
// ---------------------------------------------------------------------------------------------

interface Branch {
  pts: V3[];
  rad: number[];
  /** cumulative arc length per point */
  arc: number[];
  level: number;
  /** path distance from the root at the branch base */
  d0: number;
  children: Branch[];
}

function branchLen(b: Branch) { return b.arc[b.arc.length - 1]; }

function sampleBranch(b: Branch, t: number, outP: V3, outT: V3): number {
  const total = branchLen(b);
  const s = clamp(t, 0, 1) * total;
  let i = 1;
  while (i < b.arc.length - 1 && b.arc[i] < s) i++;
  const a0 = b.arc[i - 1], a1 = b.arc[i];
  const f = a1 > a0 ? (s - a0) / (a1 - a0) : 0;
  outP.lerpVectors(b.pts[i - 1], b.pts[i], f);
  outT.subVectors(b.pts[i], b.pts[i - 1]).normalize();
  return b.rad[i - 1] + (b.rad[i] - b.rad[i - 1]) * f;
}

function makeBranch(pts: V3[], r0: number, rTip: number, level: number, d0: number, taperPow = 1): Branch {
  const arc = [0];
  for (let i = 1; i < pts.length; i++) arc.push(arc[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const total = arc[arc.length - 1] || 1;
  const rad = arc.map((a) => rTip + (r0 - rTip) * Math.pow(1 - a / total, taperPow));
  return { pts, rad, arc, level, d0, children: [] };
}

function growPath(rng: Rng, start: V3, dir: V3, len: number, segs: number, up: number, curve: number, env: Envelope | null, minLen: number): V3[] {
  const pts = [start.clone()];
  const d = dir.clone().normalize();
  const p = start.clone();
  const segL = len / segs;
  let acc = 0;
  for (let i = 0; i < segs; i++) {
    if (i > 0) {
      d.addScaledVector(UP, up * segL);
      d.addScaledVector(randUnit(rng), curve * Math.sqrt(segL) * 0.45);
      d.normalize();
    }
    const np = p.clone().addScaledVector(d, segL);
    if (env && acc + segL > minLen && !env.inside(np, 1)) {
      // bisect to the envelope boundary
      let lo = 0, hi = 1;
      const q = v3();
      for (let k = 0; k < 6; k++) {
        const m = (lo + hi) / 2;
        q.copy(p).addScaledVector(d, segL * m);
        if (env.inside(q, 1)) lo = m; else hi = m;
      }
      if (lo * segL > 0.08) pts.push(p.clone().addScaledVector(d, segL * lo));
      break;
    }
    p.copy(np);
    acc += segL;
    pts.push(p.clone());
  }
  return pts;
}

interface TreeSkeleton {
  branches: Branch[];
  env: Envelope;
  height: number;
  maxPath: number;
}

function buildSkeleton(cfg: SpeciesCfg, rng: Rng): TreeSkeleton {
  const H = rng.range(cfg.height[0], cfg.height[1]);
  const wScale = rng.range(0.88, 1.12);
  const branches: Branch[] = [];

  // Trunk
  const leanDir = randUnit(rng).setY(0).normalize();
  const trunkDir = UP.clone().addScaledVector(leanDir, cfg.lean * rng.range(0.4, 1.2)).normalize();
  const trunkLen = Math.max(0.05, H * cfg.trunkTop);
  const trunkSegs = trunkLen < 0.5 ? 1 : Math.max(6, Math.round(trunkLen / 0.7));
  const tPts = growPath(rng, v3(0, -0.15, 0), trunkDir, trunkLen + 0.15, trunkSegs, cfg.trunkUp, cfg.trunkCurve, null, 0);
  const excurrent = cfg.trunkTop > 0.8;
  const trunkR = cfg.trunkR * rng.range(0.9, 1.1);
  const trunk = makeBranch(tPts, trunkR * 1.05, excurrent ? 0.02 : trunkR * 0.78, 0, 0, excurrent ? 0.9 : 1);
  branches.push(trunk);
  const top = tPts[tPts.length - 1];

  const envBase = H * cfg.crownBase;
  const env = new Envelope(
    envBase, H,
    cfg.width * wScale * rng.range(0.92, 1.08), cfg.width * wScale * rng.range(0.92, 1.08),
    cfg.prof,
    excurrent ? top.x * 0.4 + rng.range(-0.2, 0.2) : top.x + rng.range(-0.3, 0.3),
    excurrent ? top.z * 0.4 + rng.range(-0.2, 0.2) : top.z + rng.range(-0.3, 0.3),
  );

  const P = v3(), T = v3();
  const spawn = (parent: Branch, li: number) => {
    const lv = cfg.levels[li];
    if (!lv) return;
    const nodes = rng.int(lv.n[0], lv.n[1]);
    const perNode = lv.whorl && lv.start < 1 ? lv.whorl : 1;
    const isTop = lv.start >= 1;
    let az = rng.range(0, Math.PI * 2);
    const pLen = branchLen(parent);
    const count = isTop ? nodes : nodes;
    for (let k = 0; k < count; k++) {
      const t = isTop ? 1 : lv.start + (lv.end - lv.start) * ((k + 0.5 + rng.range(-0.35, 0.35)) / count);
      const pr = sampleBranch(parent, t, P, T);
      for (let w = 0; w < perNode; w++) {
        let a = az + (perNode > 1 ? (w / perNode) * Math.PI * 2 + rng.range(-0.25, 0.25) : 0);
        if (isTop) a = az + (k / count) * Math.PI * 2 + rng.range(-0.3, 0.3);
        const ang = (lv.angle + rng.range(-lv.angleVar, lv.angleVar)) * deg;
        const [p1, p2] = perpBasis(T);
        const mk = (aa: number) => {
          const radial = p1.clone().multiplyScalar(Math.cos(aa)).addScaledVector(p2, Math.sin(aa));
          return T.clone().multiplyScalar(Math.cos(ang)).addScaledVector(radial, Math.sin(ang)).normalize();
        };
        let dir = mk(a);
        if (dir.y < -0.3 && li > 0) dir = mk(a + Math.PI);
        let len = lv.lenRef === 'width' ? lv.len * env.rx : lv.len * pLen * (1 - t * 0.45);
        len *= rng.range(0.75, 1.1) * (lv.lenProfile ? lv.lenProfile(t) : 1);
        const segs = Math.max(1, lv.segs);
        const minLen = Math.min(len, lv.lenRef === 'width' ? 0.8 : 0.25);
        const pts = growPath(rng, P, dir, len, segs, lv.up, lv.curve, env, minLen);
        if (pts.length < 2) continue;
        const r0 = Math.max(0.008, pr * lv.rr * rng.range(0.85, 1.05));
        const parentArcAt = parent.d0 + t * pLen;
        const b = makeBranch(pts, r0, Math.max(0.004, r0 * 0.18), li + 1, parentArcAt);
        parent.children.push(b);
        branches.push(b);
        spawn(b, li + 1);
      }
      az += lv.phyllo * deg + rng.range(-0.3, 0.3);
    }
  };
  spawn(trunk, 0);

  let maxPath = 1, maxY = 0;
  for (const b of branches) {
    maxPath = Math.max(maxPath, b.d0 + branchLen(b));
    for (const p of b.pts) maxY = Math.max(maxY, p.y);
  }
  return { branches, env, height: Math.max(H, maxY), maxPath };
}

// ---------------------------------------------------------------------------------------------
// Wood mesh
// ---------------------------------------------------------------------------------------------

const BARK_STRIPS = 8;
const woodNoise = new Noise(0x7ee5);

function tube(bld: VegBuilder, b: Branch, radial: number, strip: number, maxPath: number, env: Envelope | null, trunk: SpeciesCfg | null, seed: number) {
  const n = b.pts.length;
  if (n < 2) return;
  // parallel transport frames
  const tans: V3[] = [];
  for (let i = 0; i < n; i++) {
    const a = b.pts[Math.max(0, i - 1)], c = b.pts[Math.min(n - 1, i + 1)];
    tans.push(c.clone().sub(a).normalize());
  }
  let [nx, ny] = perpBasis(tans[0]);
  const frames: [V3, V3][] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const q = new THREE.Quaternion().setFromUnitVectors(tans[i - 1], tans[i]);
      nx = nx.clone().applyQuaternion(q);
      ny = new THREE.Vector3().crossVectors(tans[i], nx).normalize();
      nx = new THREE.Vector3().crossVectors(ny, tans[i]).normalize();
    }
    frames.push([nx, ny]);
  }
  const r0 = b.rad[0];
  const wraps = Math.max(1, Math.round((2 * Math.PI * r0) / 0.55));
  const wrapWidth = (2 * Math.PI * Math.max(r0, 0.02)) / wraps;
  const base = bld.count;
  let v = (seed % 97) * 0.173;
  const p = v3(), nn = v3(), sh = v3();
  for (let i = 0; i < n; i++) {
    if (i > 0) v += b.pts[i].distanceTo(b.pts[i - 1]) / (wrapWidth * 4 * Math.max(0.35, b.rad[i] / r0));
    const c = b.pts[i];
    let r = b.rad[i];
    const y = c.y;
    if (trunk) r *= 1 + trunk.flare * Math.exp(-Math.max(0, y) / 0.45);
    const w = (b.d0 + b.arc[i]) / maxPath;
    let occ = 0;
    if (env) {
      const d = env.shade(c, sh);
      if (d < 1.05) occ = 0.55 * (1 - smooth(0.2, 1.05, d));
    }
    occ = Math.max(occ, 0.5 * Math.exp(-Math.max(0, y) / 0.35));
    const [fx, fy] = frames[i];
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      nn.copy(fx).multiplyScalar(ca).addScaledVector(fy, sa);
      let rr = r;
      if (trunk && trunk.lobes > 0) {
        const k = woodNoise.n2(ca * 1.3 + seed * 0.01, y * 0.35) * 0.6 + woodNoise.n2(sa * 2.1, y * 0.9 + 4.2) * 0.4;
        rr *= 1 + trunk.lobes * k * (1 + 1.5 * Math.exp(-Math.max(0, y) / 0.8));
      }
      p.copy(c).addScaledVector(nn, rr);
      bld.vert(p, nn, strip * 16 + (j / radial) * wraps, v, w, 0, occ);
    }
  }
  const rs = radial + 1;
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = base + i * rs + j, b2 = a + rs;
      bld.tri(a, b2, a + 1);
      bld.tri(a + 1, b2, b2 + 1);
    }
  }
}

function buildWood(cfg: SpeciesCfg, sk: TreeSkeleton, seed: number): THREE.BufferGeometry {
  const bld = new VegBuilder();
  sk.branches.forEach((b, i) => {
    const radial = b.level === 0 ? (cfg.trunkR > 0.1 ? 10 : 6) : cfg.levels[b.level - 1].radial;
    tube(bld, b, radial, cfg.bark, sk.maxPath, b.level === 0 ? null : sk.env, b.level === 0 ? cfg : null, seed + i * 7);
  });
  return bld.build(false);
}

// ---------------------------------------------------------------------------------------------
// Leaf cards
// ---------------------------------------------------------------------------------------------

const ATLAS_GRID = 4;
/** atlas uv for a cell: (u,v) in [0,1], v = 0 at the card base. */
function cellUV(cell: number, u: number, v: number, wideCells = 1): [number, number] {
  const cx = cell % ATLAS_GRID, cy = Math.floor(cell / ATLAS_GRID);
  const m = 0.006;
  const uu = (cx + m + u * (wideCells - 2 * m)) / ATLAS_GRID;
  const vv = (cy + 1 - m - v * (1 - 2 * m)) / ATLAS_GRID;
  return [uu, vv];
}

function addCard(bld: VegBuilder, base: V3, axis: V3, side: V3, w: number, h: number, cell: number, sphN: V3, cardN: V3, wind: number, tint: number, occ: number, flip: boolean) {
  const s = cardN.dot(sphN) >= 0 ? 1 : -1;
  const n = sphN.clone().multiplyScalar(0.78).addScaledVector(cardN, 0.22 * s).normalize();
  const i0 = bld.count;
  const corners: [number, number][] = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]];
  const p = v3();
  for (const [a, b] of corners) {
    p.copy(base).addScaledVector(side, a * w).addScaledVector(axis, b * h);
    const [u, v] = cellUV(cell, flip ? 0.5 - a : a + 0.5, b);
    bld.vert(p, n, u, v, Math.min(1, wind + b * 0.12), tint, occ);
  }
  bld.tri(i0, i0 + 1, i0 + 2);
  bld.tri(i0, i0 + 2, i0 + 3);
}

function buildLeaves(cfg: SpeciesCfg, sk: TreeSkeleton, rng: Rng): THREE.BufferGeometry {
  const bld = new VegBuilder();
  const env = sk.env;
  const P = v3(), T = v3(), sph = v3();
  const leafLevels = cfg.leafLevels ?? [cfg.levels.length];
  const maxLevel = cfg.levels.length;

  const placeCard = (pt: V3, tan: V3, wPath: number, sizeMul: number) => {
    pt = pt.clone();
    const size = cfg.leafSize * 1.3 * sizeMul * rng.range(0.8, 1.2);
    // unmodelled twigs: scatter the tuft around the branch, biased outwards
    if (cfg.cardMode !== 'flat') {
      const [q1, q2] = perpBasis(tan);
      const a = rng.range(0, Math.PI * 2);
      const off = q1.multiplyScalar(Math.cos(a)).addScaledVector(q2, Math.sin(a));
      const toOut = v3(pt.x - env.cx, pt.y - env.cy, pt.z - env.cz).normalize();
      if (off.dot(toOut) < 0) off.multiplyScalar(-0.6);
      pt = pt.clone().addScaledVector(off, rng.range(0, cfg.leafSize * 0.7));
    }
    const d = env.shade(pt, sph);
    const outward = v3(pt.x - env.cx, 0, pt.z - env.cz);
    if (outward.lengthSq() < 1e-4) outward.copy(randUnit(rng)).setY(0);
    outward.normalize();
    let axis: V3, nrm0: V3;
    switch (cfg.cardMode) {
      case 'flat': {
        const sideDir = v3().crossVectors(tan, UP).normalize().multiplyScalar(rng.sign());
        axis = tan.clone().addScaledVector(sideDir, rng.range(0.3, 1.0)).addScaledVector(UP, rng.range(-0.45, 0.35)).normalize();
        pt.y += rng.range(-0.25, 0.2);
        nrm0 = UP.clone().addScaledVector(randUnit(rng), 0.25);
        break;
      }
      case 'up':
        axis = UP.clone().multiplyScalar(1.2).addScaledVector(outward, rng.range(0.2, 0.7)).addScaledVector(randUnit(rng), 0.35).normalize();
        nrm0 = outward.clone().addScaledVector(randUnit(rng), 0.6);
        break;
      case 'tuft':
        axis = UP.clone().multiplyScalar(0.9).addScaledVector(tan, 0.6).addScaledVector(outward, 0.3).addScaledVector(randUnit(rng), 0.45).normalize();
        nrm0 = randUnit(rng);
        break;
      default: {
        const rnd = randUnit(rng);
        axis = tan.clone().multiplyScalar(0.55).addScaledVector(outward, 0.5).addScaledVector(rnd, 0.75).addScaledVector(UP, 0.25).normalize();
        nrm0 = UP.clone().multiplyScalar(0.7).addScaledVector(sph, 0.5).addScaledVector(randUnit(rng), 0.8);
      }
    }
    nrm0.addScaledVector(axis, -nrm0.dot(axis));
    if (nrm0.lengthSq() < 1e-4) nrm0.copy(perpBasis(axis)[0]);
    nrm0.normalize();
    const side = v3().crossVectors(axis, nrm0).normalize();
    const occ = clamp(0.8 * (1 - smooth(0.25, 1.0, d)) + 0.25 * clamp(-sph.y, 0, 1), 0, 1);
    const tint = rng.float();
    const base = pt.clone().addScaledVector(axis, -size * 0.08);
    const nCross = cfg.cross ?? 1;
    for (let c = 0; c < nCross; c++) {
      let sd = side, nr = nrm0;
      if (c > 0) {
        const q = new THREE.Quaternion().setFromAxisAngle(axis, (Math.PI / nCross) * c);
        sd = side.clone().applyQuaternion(q);
        nr = nrm0.clone().applyQuaternion(q);
      }
      addCard(bld, base, axis, sd, size, size, cfg.leafCell, sph, nr, wPath, tint, occ, rng.chance(0.5));
    }
  };

  let density = cfg.density;
  if (cfg.cards) {
    let total = 0, n = 0;
    for (const b of sk.branches) {
      if (!leafLevels.includes(b.level)) continue;
      const terminal = b.level === maxLevel || b.children.length === 0;
      const start = terminal ? cfg.leafStart : Math.max(cfg.leafStart, 0.55);
      total += branchLen(b) * (1 - start);
      n++;
    }
    density = Math.max(0.5, (cfg.cards - n) / Math.max(1, total));
  }
  for (const b of sk.branches) {
    const isLeafy = leafLevels.includes(b.level);
    if (!isLeafy) continue;
    const len = branchLen(b);
    const terminal = b.level === maxLevel || b.children.length === 0;
    const start = terminal ? cfg.leafStart : Math.max(cfg.leafStart, 0.55);
    const count = Math.max(1, Math.round(len * (1 - start) * density * rng.range(0.85, 1.15)));
    for (let i = 0; i < count; i++) {
      const t = start + (1 - start) * ((i + rng.range(0.1, 0.9)) / count);
      sampleBranch(b, t, P, T);
      const w = (b.d0 + t * len) / sk.maxPath;
      placeCard(P, T, Math.max(0.35, w), 1);
    }
    // tip card
    sampleBranch(b, 1, P, T);
    placeCard(P, T, Math.max(0.4, (b.d0 + len) / sk.maxPath), 1.1);
  }

  if (cfg.trunkLeaves) {
    const trunk = sk.branches[0];
    const tl = branchLen(trunk);
    const s0 = Math.max(0.02, (env.base - trunk.pts[0].y) / tl);
    const count = Math.round(tl * (1 - s0) * cfg.trunkLeaves);
    for (let i = 0; i < count; i++) {
      const t = s0 + (1 - s0) * ((i + rng.float()) / count);
      sampleBranch(trunk, t, P, T);
      const out = randUnit(rng).setY(0).normalize();
      const r = env.rx * cfg.prof(clamp((P.y - env.base) / (env.top - env.base), 0, 1)) * rng.range(0.1, 0.6);
      P.addScaledVector(out, r);
      placeCard(P, cfg.cardMode === 'flat' ? out : T, Math.max(0.3, (t * tl) / sk.maxPath), 0.95);
    }
  }
  return bld.build(true);
}

// ---------------------------------------------------------------------------------------------
// Far LOD
// ---------------------------------------------------------------------------------------------

const srgbToLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

class FarBuilder {
  pos: number[] = []; nrm: number[] = []; uv: number[] = []; col: number[] = []; aut: number[] = []; wind: number[] = [];
  push(p: V3, n: V3, kind: number, decid: number, col: [number, number, number], aut: [number, number, number], w: number) {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(kind, decid);
    this.col.push(srgbToLin(col[0]), srgbToLin(col[1]), srgbToLin(col[2]));
    this.aut.push(srgbToLin(aut[0]), srgbToLin(aut[1]), srgbToLin(aut[2]));
    this.wind.push(w);
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aAutumn', new THREE.Float32BufferAttribute(this.aut, 3));
    g.setAttribute('aWind', new THREE.Float32BufferAttribute(this.wind, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

const BARK_FAR: [number, number, number][] = [
  [0.33, 0.29, 0.25], [0.3, 0.26, 0.22], [0.82, 0.8, 0.76], [0.55, 0.53, 0.43],
  [0.45, 0.3, 0.22], [0.47, 0.42, 0.35], [0.4, 0.29, 0.22], [0.38, 0.35, 0.31],
];

function farTrunk(fb: FarBuilder, base: V3, top: V3, r: number, barkIdx: number, sides = 4) {
  const col = BARK_FAR[barkIdx];
  const p = v3(), n = v3();
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2 + 0.4, a1 = ((i + 1) / sides) * Math.PI * 2 + 0.4;
    const q = (a: number, c: V3, rr: number, out: V3) => out.set(c.x + Math.cos(a) * rr, c.y, c.z + Math.sin(a) * rr);
    const am = (a0 + a1) / 2;
    n.set(Math.cos(am), 0, Math.sin(am));
    const quad = [q(a0, base, r, v3()), q(a1, base, r, v3()), q(a1, top, r * 0.6, v3()), q(a0, top, r * 0.6, v3())];
    for (const k of [0, 2, 1, 0, 3, 2]) {
      p.copy(quad[k]);
      fb.push(p, n, 0, 0, col, col, k >= 2 ? 0.3 : 0);
    }
  }
}

function buildFar(cfg: SpeciesCfg, sk: TreeSkeleton): THREE.BufferGeometry {
  const fb = new FarBuilder();
  const env = sk.env;
  const trunk = sk.branches[0];
  const tTop = trunk.pts[trunk.pts.length - 1].clone();
  const tTopY = Math.min(tTop.y, env.base + (env.top - env.base) * 0.35);
  tTop.y = tTopY;
  farTrunk(fb, v3(0, -0.1, 0), tTop, cfg.trunkR * 1.1, cfg.bark);
  const ico = new THREE.IcosahedronGeometry(1, 1);
  const pa = ico.getAttribute('position');
  const c = v3(env.cx, env.cy, env.cz);
  const d = v3(), p = v3(), n = v3();
  const decid = cfg.evergreen ? 0 : 1;
  for (let i = 0; i < pa.count; i++) {
    d.fromBufferAttribute(pa, i).normalize();
    let e = env.extent(d) * 0.97;
    e *= 1 + 0.12 * woodNoise.n3(d.x * 1.7 + 3.1, d.y * 1.7, d.z * 1.7);
    p.copy(c).addScaledVector(d, Math.max(0.3, e));
    env.shade(p, n);
    n.lerp(d, 0.4).normalize();
    const shade = 0.75 + 0.25 * clamp(d.y * 0.5 + 0.5, 0, 1);
    const col: [number, number, number] = [cfg.farColor[0] * shade, cfg.farColor[1] * shade, cfg.farColor[2] * shade];
    const aut: [number, number, number] = [cfg.autumn[0] * shade * 0.85, cfg.autumn[1] * shade * 0.85, cfg.autumn[2] * shade * 0.85];
    fb.push(p, n, 1, decid, col, aut, 0.75);
  }
  ico.dispose();
  return fb.build();
}

// ---------------------------------------------------------------------------------------------
// Palm (dedicated builder)
// ---------------------------------------------------------------------------------------------

function buildPalm(variant: number): TreeModel {
  const rng = Rng.from('tree', 'palm', variant);
  const H = rng.range(8.5, 11.5);
  const wood = new VegBuilder();
  const leaves = new VegBuilder();
  const leanDir = randUnit(rng).setY(0).normalize();
  const lean = rng.range(0.25, 0.5);
  // curved trunk: leans out at the base and gravitropically turns up again
  const pts: V3[] = [v3(0, -0.15, 0)];
  const d = UP.clone().addScaledVector(leanDir, lean).normalize();
  const segs = 16;
  const segL = H / segs;
  const p = pts[0].clone();
  for (let i = 0; i < segs; i++) {
    p.addScaledVector(d, segL);
    pts.push(p.clone());
    d.addScaledVector(UP, 0.05 + 0.02 * (i / segs));
    d.addScaledVector(randUnit(rng), 0.015);
    d.normalize();
  }
  const trunk = makeBranch(pts, 0.22, 0.2, 0, 0);
  for (let i = 0; i < trunk.rad.length; i++) {
    const y = pts[i].y;
    trunk.rad[i] = 0.2 + 0.12 * Math.exp(-Math.max(0, y) / 0.6) + (i >= segs - 1 ? 0.03 : 0);
  }
  const maxPath = branchLen(trunk) + 4.5;
  tube(wood, trunk, 9, 5, maxPath, null, null, variant * 31);
  const top = pts[pts.length - 1].clone();
  const tTan = top.clone().sub(pts[pts.length - 2]).normalize();
  const crownC = top.clone().add(v3(0, 0.4, 0));
  const env = new Envelope(top.y - 3, top.y + 2.5, 4.5, 4.5, (t) => Math.sin(Math.PI * t), top.x, top.z);

  // leaf-base "boots" knob under the crown
  const boot = makeBranch([top.clone().addScaledVector(tTan, -0.7), top.clone().addScaledVector(tTan, 0.25)], 0.27, 0.16, 1, branchLen(trunk) - 0.7);
  tube(wood, boot, 9, 5, maxPath, null, null, 5);

  const nFronds = rng.int(18, 23);
  const frond = (az: number, elev: number, len: number, dead: boolean) => {
    const dir0 = v3(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev));
    const start = top.clone().addScaledVector(dir0, 0.12);
    // petiole (wood)
    const petLen = dead ? 0.4 : 0.55;
    const pet = makeBranch([start.clone(), start.clone().addScaledVector(dir0, petLen)], 0.045, 0.03, 2, branchLen(trunk));
    tube(wood, pet, 4, 5, maxPath, null, null, 3);
    // leaflet strip with a V fold
    const fs = 11;
    const fd = dir0.clone();
    const c = pet.pts[1].clone();
    const halfW = dead ? 0.42 : 0.62;
    const cell = dead ? 14 : 12;
    const tint = rng.float();
    const base = leaves.count;
    const sl = (len - petLen) / fs;
    const sph = v3();
    for (let i = 0; i <= fs; i++) {
      const t = i / fs;
      if (i > 0) {
        fd.addScaledVector(UP, dead ? -0.5 * sl : -(0.12 + 0.25 * t) * sl * 1.6);
        fd.normalize();
        c.addScaledVector(fd, sl);
      }
      const side = v3().crossVectors(fd, UP);
      if (side.lengthSq() < 1e-4) side.set(Math.sin(az), 0, -Math.cos(az));
      side.normalize();
      const upP = v3().crossVectors(side, fd).normalize();
      const w = halfW * (i === fs ? 0.35 : 1) * (dead ? 0.8 : 1);
      const fold = dead ? -0.5 : 0.38;
      const wind = clamp((branchLen(trunk) + petLen + t * len) / maxPath, 0.5, 1);
      sph.subVectors(c, crownC).normalize();
      const occ = dead ? 0.35 : 0.15 * (1 - t);
      const nL = sph.clone().multiplyScalar(0.55).addScaledVector(upP, 0.45).normalize();
      const [u0, vL] = cellUV(cell, t, 1, 2);
      const [, vC] = cellUV(cell, t, 0.5, 2);
      const [, vR] = cellUV(cell, t, 0, 2);
      leaves.vert(c.clone().addScaledVector(side, -w).addScaledVector(upP, w * fold), nL, u0, vL, wind, tint, occ);
      leaves.vert(c.clone().addScaledVector(upP, -0.02), nL, u0, vC, wind, tint, occ);
      leaves.vert(c.clone().addScaledVector(side, w).addScaledVector(upP, w * fold), nL, u0, vR, wind, tint, occ);
    }
    for (let i = 0; i < fs; i++) {
      const a = base + i * 3, b = a + 3;
      leaves.tri(a, b, a + 1); leaves.tri(a + 1, b, b + 1);
      leaves.tri(a + 1, b + 1, a + 2); leaves.tri(a + 2, b + 1, b + 2);
    }
  };
  let az = rng.range(0, Math.PI * 2);
  for (let i = 0; i < nFronds; i++) {
    const f = i / (nFronds - 1);
    const elev = (70 - f * 95 + rng.range(-8, 8)) * deg;
    const len = rng.range(3.4, 4.4) * (f < 0.15 ? 0.8 : 1);
    frond(az, elev, len, false);
    az += 137.5 * deg + rng.range(-0.15, 0.15);
  }
  const nDead = rng.int(3, 6);
  for (let i = 0; i < nDead; i++) frond(rng.range(0, Math.PI * 2), rng.range(-82, -65) * deg, rng.range(2.2, 2.9), true);

  // far: trunk + 9 frond ribbons
  const fb = new FarBuilder();
  farTrunk(fb, v3(0, -0.1, 0), top, 0.24, 5);
  const green: [number, number, number] = [0.3, 0.42, 0.18];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.3;
    const elev = (i % 3 === 0 ? 30 : i % 3 === 1 ? 0 : -25) * deg;
    const dir = v3(Math.cos(a) * Math.cos(elev), Math.sin(elev), Math.sin(a) * Math.cos(elev));
    const side = v3(-Math.sin(a), 0, Math.cos(a));
    const mid = top.clone().addScaledVector(dir, 2.0).add(v3(0, -0.2, 0));
    const tip = top.clone().addScaledVector(dir, 3.8).add(v3(0, -1.2, 0));
    const n = v3(0, 1, 0);
    const q = [top.clone().addScaledVector(side, 0.15), mid.clone().addScaledVector(side, 0.55), tip, mid.clone().addScaledVector(side, -0.55), top.clone().addScaledVector(side, -0.15)];
    for (const k of [0, 1, 4, 1, 3, 4, 1, 2, 3]) fb.push(q[k], n, 0.5, 0, green, green, 0.8);
  }
  const height = top.y + 2.2;
  return {
    species: 'palm', height, trunkRadius: 0.22,
    wood: wood.build(false), leaves: leaves.build(true), far: fb.build(), crownRadius: 4.2,
  };
}

// ---------------------------------------------------------------------------------------------
// Public model API
// ---------------------------------------------------------------------------------------------

const treeCache = new Map<string, TreeModel>();

function buildGeneric(kind: TreeSpecies | 'shrub', variant: number): TreeModel {
  const cfg = speciesCfg(kind, variant);
  const rng = Rng.from('tree', kind, variant);
  const sk = buildSkeleton(cfg, rng.fork('skeleton'));
  const wood = buildWood(cfg, sk, variant * 131 + 7);
  const leaves = buildLeaves(cfg, sk, rng.fork('leaves'));
  const far = buildFar(cfg, sk);
  const bb = leaves.boundingBox!;
  const height = Math.max(sk.height, bb.max.y);
  return {
    species: kind === 'shrub' ? 'linden' : kind,
    height,
    trunkRadius: cfg.trunkR,
    wood, leaves, far,
    isShrub: kind === 'shrub' ? true : undefined,
    crownRadius: Math.max(sk.env.rx, sk.env.rz),
  };
}

export function treeModel(species: TreeSpecies, variant = 0): TreeModel {
  const v = Math.abs(variant | 0) % 64;
  const key = species + ':' + v;
  let m = treeCache.get(key);
  if (!m) {
    m = species === 'palm' ? buildPalm(v) : buildGeneric(species, v);
    treeCache.set(key, m);
  }
  return m;
}

export function shrubModel(variant = 0): TreeModel {
  const v = Math.abs(variant | 0) % 64;
  const key = 'shrub:' + v;
  let m = treeCache.get(key);
  if (!m) {
    m = buildGeneric('shrub', v);
    treeCache.set(key, m);
  }
  return m;
}

// ---------------------------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------------------------

function fade(t: number) { return t * t * t * (t * (t * 6 - 15) + 10); }
const imod = (a: number, b: number) => ((a % b) + b) % b;

/** Periodic value noise in [0,1]; x period px, y period py (integers). */
function pnoise(seed: number, x: number, y: number, px: number, py: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = fade(x - xi), fy = fade(y - yi);
  const h = (i: number, j: number) => hashToFloat(hash2i(seed, imod(i, px), imod(j, py)));
  const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function pfbm(seed: number, x: number, y: number, px: number, py: number, oct: number): number {
  let s = 0, amp = 0.5, norm = 0, f = 1;
  for (let o = 0; o < oct; o++) {
    s += amp * pnoise(seed + o * 101, x * f, y * f, px * f, py * f);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return s / norm;
}

/** Periodic worley: returns [f1, f2, id]. */
function pworley(seed: number, x: number, y: number, px: number, py: number, jitter = 0.9): [number, number, number] {
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 9, f2 = 9, id = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = xi + i, cy = yi + j;
    const h = hash2i(seed, imod(cx, px), imod(cy, py));
    const fx = cx + 0.5 + (hashToFloat(h) - 0.5) * jitter;
    const fy = cy + 0.5 + (hashToFloat(Math.imul(h, 2654435761)) - 0.5) * jitter;
    const dd = Math.hypot(fx - x, fy - y);
    if (dd < f1) { f2 = f1; f1 = dd; id = h; } else if (dd < f2) f2 = dd;
  }
  return [f1, f2, id];
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
type RGBH = [number, number, number, number];

function barkPixel(strip: number, u: number, v: number): RGBH {
  // u in [0,1) around the branch, v in [0,1) along (one tile = 4 circumferences)
  switch (strip) {
    case 0: { // linden / maple: interlaced shallow furrows
      const n = pfbm(11, u * 9 + pfbm(12, u * 4, v * 3, 4, 3, 2) * 1.5, v * 5, 9, 5, 4);
      const ridge = 1 - Math.abs(2 * n - 1);
      const fine = pfbm(13, u * 40, v * 60, 40, 60, 2);
      const h = Math.pow(ridge, 1.6) * 0.8 + fine * 0.2;
      const lich = smooth(0.62, 0.75, pfbm(14, u * 3, v * 5, 3, 5, 3));
      const r = mix(0.16, 0.42, h), g = mix(0.14, 0.39, h), b = mix(0.12, 0.35, h);
      return [mix(r, 0.42, lich * 0.5), mix(g, 0.46, lich * 0.5), mix(b, 0.3, lich * 0.5), h];
    }
    case 1: { // oak / chestnut: deep blocky fissures
      const warpU = pfbm(21, u * 5, v * 4, 5, 4, 2) * 0.6;
      const [f1, f2] = pworley(22, u * 7 + warpU, v * 7, 7, 7, 0.85);
      const crack = smooth(0.0, 0.16, f2 - f1);
      const fine = pfbm(23, u * 30, v * 50, 30, 50, 3);
      const plate = pfbm(24, u * 14, v * 12, 14, 12, 2);
      const h = crack * (0.65 + 0.35 * plate) * 0.85 + fine * 0.15;
      return [mix(0.09, 0.36, h), mix(0.08, 0.33, h), mix(0.07, 0.29, h), h];
    }
    case 2: { // birch: white with dark lenticels and black patches
      const lent = smooth(0.66, 0.72, pfbm(31, u * 7, v * 140, 7, 140, 2));
      const patch = smooth(0.66, 0.7, pfbm(32, u * 3 + pfbm(35, u * 6, v * 20, 6, 20, 2) * 0.8, v * 9, 3, 9, 4));
      const fine = pfbm(33, u * 24, v * 90, 24, 90, 2);
      const warm = pfbm(34, u * 4, v * 10, 4, 10, 2);
      let r = 0.86 - fine * 0.1 + warm * 0.04, g = 0.85 - fine * 0.1, b = 0.8 - fine * 0.1 - warm * 0.04;
      const dark = Math.max(lent * 0.75, patch);
      r = mix(r, 0.12, dark); g = mix(g, 0.11, dark); b = mix(b, 0.11, dark);
      return [r, g, b, 0.7 - dark * 0.45 + fine * 0.15];
    }
    case 3: { // plane: camouflage patches
      const wu = u * 4 + (pfbm(41, u * 6, v * 12, 6, 12, 3) - 0.5) * 1.3;
      const wv = v * 9 + (pfbm(42, u * 6, v * 12, 6, 12, 3) - 0.5) * 2.6;
      const [f1, f2, id] = pworley(43, wu, wv, 4, 9, 0.95);
      const pal: [number, number, number][] = [[0.5, 0.5, 0.38], [0.8, 0.77, 0.62], [0.55, 0.5, 0.4], [0.66, 0.67, 0.53], [0.42, 0.44, 0.34], [0.74, 0.72, 0.6]];
      const c = pal[id % pal.length];
      const edge = smooth(0.0, 0.07, f2 - f1);
      const fine = pfbm(44, u * 30, v * 60, 30, 60, 2);
      const k = (0.85 + 0.15 * edge) * (0.92 + fine * 0.16);
      return [c[0] * k, c[1] * k, c[2] * k, 0.5 + (id % 3) * 0.08 + fine * 0.1 + edge * 0.1];
    }
    case 4: { // pine: reddish plates
      const [f1, f2, id] = pworley(51, u * 5 + pfbm(52, u * 5, v * 5, 5, 5, 2) * 0.5, v * 8, 5, 8, 0.9);
      const crack = smooth(0.0, 0.1, f2 - f1);
      const fine = pfbm(53, u * 30, v * 40, 30, 40, 2);
      const red = hashToFloat(id) * 0.5 + 0.5;
      const h = crack * (0.7 + fine * 0.3);
      return [mix(0.12, 0.5 * red + 0.12, h), mix(0.09, 0.3 * red + 0.07, h), mix(0.08, 0.2 * red + 0.06, h), h];
    }
    case 5: { // palm: horizontal leaf-scar rings, fibrous
      const ringV = v * 22 + (pfbm(61, u * 3, v * 22, 3, 22, 2) - 0.5) * 0.5;
      const fr = ringV - Math.floor(ringV);
      const ring = smooth(0.0, 0.18, fr) * smooth(1.0, 0.75, fr);
      const fib = pfbm(62, u * 60, v * 22, 60, 22, 2);
      const h = ring * 0.75 + fib * 0.25;
      return [mix(0.22, 0.52, h), mix(0.19, 0.47, h), mix(0.15, 0.39, h), h];
    }
    case 6: { // cypress: stringy fibrous strips
      const n = pfbm(71, u * 26 + pfbm(72, u * 4, v * 3, 4, 3, 2) * 3, v * 3, 26, 3, 3);
      const ridge = 1 - Math.abs(2 * n - 1);
      const g2 = pfbm(73, u * 5, v * 8, 5, 8, 2);
      const h = Math.pow(ridge, 1.3);
      return [mix(0.16, 0.46 - g2 * 0.1, h), mix(0.11, 0.33, h), mix(0.09, 0.27 + g2 * 0.05, h), h];
    }
    default: { // ginkgo / shrub: grey, fine furrows
      const n = pfbm(81, u * 14, v * 7, 14, 7, 4);
      const ridge = 1 - Math.abs(2 * n - 1);
      const fine = pfbm(82, u * 40, v * 60, 40, 60, 2);
      const h = Math.pow(ridge, 2) * 0.7 + fine * 0.3;
      return [mix(0.2, 0.43, h), mix(0.18, 0.4, h), mix(0.16, 0.36, h), h];
    }
  }
}

let barkTex: { map: THREE.DataTexture; normal: THREE.DataTexture } | null = null;

function getBarkTextures() {
  if (barkTex) return barkTex;
  const SW = 128, SH = 512, W = SW * BARK_STRIPS;
  const col = new Uint8Array(W * SH * 4);
  const nor = new Uint8Array(W * SH * 4);
  const hgt = new Float32Array(W * SH);
  for (let s = 0; s < BARK_STRIPS; s++) {
    for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
      const px = barkPixel(s, x / SW, y / SH);
      const i = y * W + s * SW + x;
      col[i * 4] = clamp(Math.pow(px[0], 1 / 1) * 255, 0, 255);
      col[i * 4 + 1] = clamp(px[1] * 255, 0, 255);
      col[i * 4 + 2] = clamp(px[2] * 255, 0, 255);
      col[i * 4 + 3] = 255;
      hgt[i] = px[3];
    }
  }
  const strength = [3.5, 5, 1.2, 1.2, 4, 3, 3.5, 2.5];
  for (let s = 0; s < BARK_STRIPS; s++) {
    for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
      const at = (xx: number, yy: number) => hgt[imod(yy, SH) * W + s * SW + imod(xx, SW)];
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength[s];
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength[s];
      const len = Math.hypot(dx, dy, 1);
      const i = (y * W + s * SW + x) * 4;
      nor[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      nor[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      nor[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      nor[i + 3] = 255;
    }
  }
  const mk = (data: Uint8Array, srgb: boolean) => {
    const t = new THREE.DataTexture(data, W, SH, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  barkTex = { map: mk(col, true), normal: mk(nor, false) };
  return barkTex;
}

// ---- leaf atlas ------------------------------------------------------------------------------

type Pt = [number, number];
type HSL = [number, number, number];

function hslStr(c: HSL, a = 1, dl = 0) { return `hsla(${c[0]},${c[1]}%,${clamp(c[2] + dl, 0, 100)}%,${a})`; }

/** Polygon for an elongated leaf: base (0,0), tip (0,-len); hw(t) half width as fraction of width. */
function leafPoly(len: number, width: number, hw: (t: number) => number, teeth = 0, toothAmp = 0): Pt[] {
  const N = 36;
  const right: Pt[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    let w = hw(t) * width * 0.5;
    if (teeth > 0) w *= 1 + toothAmp * (((t * teeth) % 1) - 0.5);
    right.push([w, -t * len]);
  }
  const left = right.slice(0, -1).reverse().map(([x, y]) => [-x, y] as Pt);
  return [...right, ...left];
}

/** Palmate polygon centred on the petiole attachment, lobes pointing up (angle 0 = up). */
function palmPoly(R: number, lobes: { a: number; l: number }[], lobeW: number, base: number, sharp: number, teeth: number): Pt[] {
  const pts: Pt[] = [];
  const N = 120;
  for (let i = 0; i < N; i++) {
    const phi = -Math.PI + (i / N) * Math.PI * 2;
    let r = base;
    for (const lb of lobes) {
      let dd = Math.abs(phi - lb.a);
      dd = Math.min(dd, Math.PI * 2 - dd);
      const k = Math.max(0, 1 - dd / lobeW);
      r = Math.max(r, base + (lb.l - base) * Math.pow(k, sharp));
    }
    const bottom = Math.abs(Math.abs(phi) - Math.PI);
    if (bottom < 0.5) r *= 0.35 + 0.65 * (bottom / 0.5);
    r *= 1 + 0.035 * Math.sin(phi * teeth);
    pts.push([Math.sin(phi) * r * R, -Math.cos(phi) * r * R]);
  }
  return pts;
}

function fillLeaf(g: CanvasRenderingContext2D, poly: Pt[], col: HSL, len: number, veins: { from: Pt; to: Pt }[], rng: Rng) {
  g.beginPath();
  g.moveTo(poly[0][0], poly[0][1]);
  for (let i = 1; i < poly.length; i++) g.lineTo(poly[i][0], poly[i][1]);
  g.closePath();
  const lgt = rng.range(-5, 6);
  g.fillStyle = hslStr(col, 1, lgt);
  g.fill();
  g.save();
  g.clip();
  // fold shading across the midrib + base-to-tip gradient (pseudo normals)
  let maxX = 1;
  for (const p of poly) maxX = Math.max(maxX, Math.abs(p[0]));
  const gr = g.createLinearGradient(-maxX, 0, maxX, 0);
  gr.addColorStop(0, 'rgba(0,0,0,0.22)');
  gr.addColorStop(0.48, 'rgba(0,0,0,0.0)');
  gr.addColorStop(0.52, 'rgba(255,255,230,0.06)');
  gr.addColorStop(1, 'rgba(255,255,220,0.0)');
  g.fillStyle = gr;
  g.fillRect(-maxX, -len * 1.5, maxX * 2, len * 2);
  const gv = g.createLinearGradient(0, 0, 0, -len);
  gv.addColorStop(0, 'rgba(0,0,0,0.12)');
  gv.addColorStop(0.5, 'rgba(255,255,200,0.04)');
  gv.addColorStop(1, 'rgba(0,0,0,0.08)');
  g.fillStyle = gv;
  g.fillRect(-maxX, -len * 1.5, maxX * 2, len * 2);
  // veins
  g.strokeStyle = hslStr(col, 0.5, 9);
  g.lineCap = 'round';
  for (const v of veins) {
    g.lineWidth = Math.max(0.6, len * 0.012);
    g.beginPath();
    g.moveTo(v.from[0], v.from[1]);
    g.lineTo(v.to[0], v.to[1]);
    g.stroke();
  }
  g.restore();
  g.strokeStyle = hslStr(col, 0.55, -10);
  g.lineWidth = 0.9;
  g.stroke();
}

function midribVeins(len: number, width: number, n: number, hw: (t: number) => number): { from: Pt; to: Pt }[] {
  const out: { from: Pt; to: Pt }[] = [{ from: [0, 0], to: [0, -len * 0.96] }];
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    const w = hw(Math.min(1, t + 0.1)) * width * 0.45;
    out.push({ from: [0, -t * len], to: [w, -(t + 0.12) * len] });
    out.push({ from: [0, -t * len], to: [-w, -(t + 0.12) * len] });
  }
  return out;
}

type LeafFn = (g: CanvasRenderingContext2D, s: number, rng: Rng) => void;

function ovalLeaf(col: HSL, len: number, width: number, hw: (t: number) => number, teeth = 0, toothAmp = 0, veins = 5): LeafFn {
  return (g, s, rng) => {
    const l = len * s, w = width * s;
    fillLeaf(g, leafPoly(l, w, hw, teeth, toothAmp), col, l, midribVeins(l, w, veins, hw), rng);
  };
}

function palmateLeaf(col: HSL, R: number, lobes: { a: number; l: number }[], lobeW: number, base: number, sharp: number, teeth: number): LeafFn {
  return (g, s, rng) => {
    const r = R * s;
    const poly = palmPoly(r, lobes, lobeW, base, sharp, teeth);
    const veins = lobes.map((lb) => ({ from: [0, 0] as Pt, to: [Math.sin(lb.a) * lb.l * r * 0.9, -Math.cos(lb.a) * lb.l * r * 0.9] as Pt }));
    fillLeaf(g, poly, col, r * 1.6, veins, rng);
  };
}

function withJitter(c: HSL, rng: Rng, dh = 6, ds = 6, dl = 4): HSL {
  return [c[0] + rng.range(-dh, dh), clamp(c[1] + rng.range(-ds, ds), 0, 100), c[2] + rng.range(-dl, dl)];
}

/** Draws a twig with leaves inside a cell. Origin = bottom centre of the cell. */
function drawTwigCell(
  g: CanvasRenderingContext2D, rng: Rng,
  o: { nodes: number; twigLen: number; bend: number; spread: [number, number]; opposite?: boolean; petiole: number; size: [number, number]; leaf: (rng: Rng) => LeafFn; twigW: number; tip?: boolean; startT?: number; twigCol?: HSL },
) {
  const C = 256;
  const twig: Pt[] = [];
  const N = 20;
  const bend = o.bend;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    twig.push([bend * Math.sin(t * Math.PI * 0.9) * C + Math.sin(t * 9) * 3, -t * o.twigLen * C]);
  }
  const twigCol: HSL = o.twigCol ?? [28, 22, 26];
  g.strokeStyle = hslStr(twigCol);
  g.lineCap = 'round';
  for (let i = 0; i < N; i++) {
    g.lineWidth = o.twigW * (1 - (i / N) * 0.6);
    g.beginPath();
    g.moveTo(twig[i][0], twig[i][1]);
    g.lineTo(twig[i + 1][0], twig[i + 1][1]);
    g.stroke();
  }
  const at = (t: number): [Pt, number] => {
    const f = t * N;
    const i = Math.min(N - 1, Math.floor(f));
    const k = f - i;
    const p: Pt = [twig[i][0] + (twig[i + 1][0] - twig[i][0]) * k, twig[i][1] + (twig[i + 1][1] - twig[i][1]) * k];
    const ang = Math.atan2(twig[i + 1][0] - twig[i][0], -(twig[i + 1][1] - twig[i][1]));
    return [p, ang];
  };
  const leavesToDraw: { p: Pt; a: number; s: number }[] = [];
  const st = o.startT ?? 0.15;
  for (let k = 0; k < o.nodes; k++) {
    const t = st + (1 - st) * (k / Math.max(1, o.nodes - (o.tip ? 0 : 1))) * (o.tip ? 0.92 : 1);
    const [p, ta] = at(Math.min(1, t));
    const sides = o.opposite ? [-1, 1] : [k % 2 === 0 ? -1 : 1];
    for (const sd of sides) {
      const a = ta + sd * rng.range(o.spread[0], o.spread[1]) * deg;
      const sz = rng.range(o.size[0], o.size[1]) * (0.75 + 0.35 * Math.sin(Math.PI * (0.25 + 0.6 * t)));
      leavesToDraw.push({ p, a, s: sz });
    }
  }
  if (o.tip) {
    const [p, ta] = at(1);
    leavesToDraw.push({ p, a: ta + rng.range(-8, 8) * deg, s: o.size[1] });
  }
  for (const lf of leavesToDraw) {
    g.save();
    g.translate(lf.p[0], lf.p[1]);
    g.rotate(lf.a);
    if (o.petiole > 0) {
      g.strokeStyle = hslStr([70, 30, 30]);
      g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -o.petiole * lf.s); g.stroke();
      g.translate(0, -o.petiole * lf.s);
    }
    o.leaf(rng)(g, lf.s, rng);
    g.restore();
  }
}

function drawNeedleTuft(g: CanvasRenderingContext2D, rng: Rng, col: HSL, len: number, nNeedle: number, twigLen: number) {
  g.lineCap = 'round';
  g.strokeStyle = hslStr([25, 30, 24]);
  g.lineWidth = 4;
  g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -twigLen); g.stroke();
  const needles: { x: number; y: number; a: number; l: number; c: HSL }[] = [];
  for (let i = 0; i < nNeedle; i++) {
    const t = Math.pow(rng.float(), 0.7);
    const y = -twigLen * (0.15 + 0.85 * t);
    const a = rng.sign() * rng.range(12, 62) * deg * (1 - 0.5 * t);
    needles.push({ x: rng.range(-2, 2), y, a, l: len * rng.range(0.7, 1.05), c: withJitter(col, rng, 8, 8, 7) });
  }
  needles.sort((a, b) => a.l - b.l);
  for (const n of needles) {
    g.strokeStyle = hslStr(n.c);
    g.lineWidth = rng.range(1.6, 2.4);
    g.beginPath();
    g.moveTo(n.x, n.y);
    const ex = n.x + Math.sin(n.a) * n.l, ey = n.y - Math.cos(n.a) * n.l;
    g.quadraticCurveTo(n.x + Math.sin(n.a) * n.l * 0.5, n.y - Math.cos(n.a) * n.l * 0.55 - 3, ex, ey);
    g.stroke();
    g.strokeStyle = hslStr(n.c, 0.6, 12);
    g.lineWidth = 0.7;
    g.stroke();
  }
}

function drawCypressSpray(g: CanvasRenderingContext2D, rng: Rng, x: number, y: number, ang: number, len: number, depth: number, col: HSL) {
  const steps = Math.max(3, Math.round(len / 5));
  let px = x, py = y;
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    const nx = px + Math.sin(ang) * (len / steps), ny = py - Math.cos(ang) * (len / steps);
    const w = (2.2 + depth * 1.5) * (1 - t * 0.5);
    g.fillStyle = hslStr(withJitter(col, rng, 5, 5, 5), 1, t * 8);
    g.beginPath();
    g.ellipse(nx, ny, w, w * 1.6, ang, 0, Math.PI * 2);
    g.fill();
    if (depth > 0 && i > 0 && i % 2 === 0) {
      const sd = (i / 2) % 2 === 0 ? 1 : -1;
      drawCypressSpray(g, rng, nx, ny, ang + sd * rng.range(35, 55) * deg, len * rng.range(0.35, 0.55) * (1 - t * 0.6), depth - 1, col);
    }
    px = nx; py = ny;
  }
}

function drawFrond(g: CanvasRenderingContext2D, rng: Rng, w: number, h: number, col: HSL, dead: boolean) {
  const cy = h / 2;
  const nL = 62;
  const leaflets: { x: number; side: number; l: number; a: number; c: HSL }[] = [];
  for (let i = 0; i < nL; i++) {
    const t = (i + 0.5) / nL;
    const x = 6 + t * (w - 12);
    const l = (h / 2 - 6) * Math.pow(Math.sin(Math.PI * (0.12 + 0.88 * t)), 0.55) * (t < 0.06 ? 0.4 : 1) * rng.range(0.85, 1.0);
    for (const side of [-1, 1]) leaflets.push({ x, side, l, a: (dead ? rng.range(20, 50) : rng.range(42, 58)) * deg, c: withJitter(col, rng, 5, 6, 5) });
  }
  for (const lf of leaflets) {
    const ex = lf.x + Math.cos(lf.a) * lf.l, ey = cy + lf.side * Math.sin(lf.a) * lf.l;
    g.save();
    g.translate(lf.x, cy);
    g.rotate(Math.atan2(ey - cy, ex - lf.x) + Math.PI / 2);
    const len = Math.hypot(ex - lf.x, ey - cy);
    const poly = leafPoly(len, dead ? 5 : 7.5, (t) => Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 0.6));
    g.beginPath();
    g.moveTo(poly[0][0], poly[0][1]);
    for (const p of poly) g.lineTo(p[0], p[1]);
    g.closePath();
    g.fillStyle = hslStr(lf.c);
    g.fill();
    g.strokeStyle = hslStr(lf.c, 0.7, 10);
    g.lineWidth = 0.8;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -len); g.stroke();
    g.restore();
  }
  g.strokeStyle = hslStr(dead ? [30, 25, 40] : [65, 30, 42]);
  g.lineWidth = 4;
  g.beginPath(); g.moveTo(0, cy); g.lineTo(w, cy); g.stroke();
}

let leafAtlas: THREE.DataTexture | null = null;

function getLeafAtlas(): THREE.DataTexture {
  if (leafAtlas) return leafAtlas;
  const S = 1024, C = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  g.clearRect(0, 0, S, S);
  const rng = Rng.from('leaf-atlas');
  const cell = (i: number, w: number, draw: () => void) => {
    const cx = (i % 4) * C, cy = Math.floor(i / 4) * C;
    g.save();
    g.beginPath(); g.rect(cx + 3, cy + 3, C * w - 6, C - 6); g.clip();
    g.translate(cx + (C * w) / 2, cy + C - 4);
    draw();
    g.restore();
  };
  const ov = (t: number) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.8);
  // 0 plane: large palmate, shallow lobes
  cell(0, 1, () => drawTwigCell(g, rng.fork('plane'), {
    nodes: 4, twigLen: 0.42, bend: 0.03, spread: [40, 70], petiole: 26, size: [0.85, 1.0], twigW: 5, tip: true, startT: 0.35,
    leaf: (r) => palmateLeaf(withJitter([88, 42, 32], r), 46, [{ a: 0, l: 1.15 }, { a: -0.95, l: 1.0 }, { a: 0.95, l: 1.0 }, { a: -1.9, l: 0.62 }, { a: 1.9, l: 0.62 }], 0.62, 0.55, 1.3, 26),
  }));
  // 1 linden: heart leaves
  cell(1, 1, () => drawTwigCell(g, rng.fork('linden'), {
    nodes: 7, twigLen: 0.8, bend: 0.06, spread: [45, 80], petiole: 12, size: [0.75, 1.0], twigW: 3.5, tip: true,
    leaf: (r) => ovalLeaf(withJitter([88, 44, 28], r), 62, 60, (t) => Math.pow(Math.sin(Math.PI * Math.pow(0.08 + 0.92 * t, 0.7)), 0.75), 22, 0.07, 4),
  }));
  // 2 maple: sharp 5-lobed, opposite
  cell(2, 1, () => drawTwigCell(g, rng.fork('maple'), {
    nodes: 3, twigLen: 0.45, bend: 0.02, spread: [50, 75], opposite: true, petiole: 30, size: [0.8, 1.0], twigW: 4.5, tip: true, startT: 0.3,
    leaf: (r) => palmateLeaf(withJitter([96, 48, 28], r), 40, [{ a: 0, l: 1.15 }, { a: -0.85, l: 1.05 }, { a: 0.85, l: 1.05 }, { a: -1.75, l: 0.7 }, { a: 1.75, l: 0.7 }], 0.42, 0.38, 1.9, 14),
  }));
  // 3 oak: lobed leaves clustered near the tip
  cell(3, 1, () => drawTwigCell(g, rng.fork('oak'), {
    nodes: 7, twigLen: 0.5, bend: 0.04, spread: [15, 75], petiole: 4, size: [0.8, 1.0], twigW: 4.5, tip: true, startT: 0.55,
    leaf: (r) => ovalLeaf(withJitter([82, 38, 25], r), 92, 48, (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.85)), 0.7) * (0.55 + 0.45 * Math.pow(Math.abs(Math.sin(t * Math.PI * 4.5)), 0.6)), 0, 0, 4),
  }));
  // 4 birch: small serrated deltoid leaves on a drooping twig
  cell(4, 1, () => {
    const r = rng.fork('birch');
    for (const [dx, bend, len] of [[-50, -0.12, 0.85], [45, 0.1, 0.8], [0, 0.02, 0.95]] as [number, number, number][]) {
      g.save();
      g.translate(dx, 0);
      drawTwigCell(g, r, {
        nodes: 7, twigLen: len, bend, spread: [40, 70], petiole: 8, size: [0.75, 1.0], twigW: 2, tip: true, twigCol: [20, 25, 22],
        leaf: (rr) => ovalLeaf(withJitter([84, 46, 31], rr), 36, 26, (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.55)), 0.9), 14, 0.14, 3),
      });
      g.restore();
    }
  });
  // 5 chestnut: palmate compound leaves (7 leaflets)
  cell(5, 1, () => {
    const r = rng.fork('chestnut');
    const compound = (x: number, y: number, a: number, s: number) => {
      g.save(); g.translate(x, y); g.rotate(a);
      g.strokeStyle = hslStr([60, 30, 32]); g.lineWidth = 2.4;
      g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -38 * s); g.stroke();
      g.translate(0, -38 * s);
      const n = 7;
      for (let i = 0; i < n; i++) {
        const la = (-1 + (2 * i) / (n - 1)) * 1.45;
        const ll = (1 - 0.45 * Math.abs(la) / 1.45) * 78 * s;
        g.save(); g.rotate(la);
        ovalLeaf(withJitter([90, 44, 27], r), ll, ll * 0.42, (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 1.35)), 0.75), 24, 0.08, 6)(g, 1, r);
        g.restore();
      }
      g.restore();
    };
    g.strokeStyle = hslStr([28, 22, 26]); g.lineWidth = 5;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -70); g.stroke();
    compound(0, -60, -0.7, 0.9);
    compound(0, -70, 0.75, 0.88);
    compound(0, -70, 0.02, 1.0);
  });
  // 6 ginkgo: fan leaves on spur shoots
  cell(6, 1, () => {
    const r = rng.fork('ginkgo');
    const fan: LeafFn = (gg, s, rr) => {
      const R = 34 * s;
      const pts: Pt[] = [[0, 0]];
      for (let i = 0; i <= 30; i++) {
        const a = (-58 + (116 * i) / 30) * deg;
        let rad = R * (1 + 0.04 * Math.sin(i * 1.7));
        if (Math.abs(a) < 0.12) rad *= 0.78 + 0.22 * (Math.abs(a) / 0.12);
        pts.push([Math.sin(a) * rad, -Math.cos(a) * rad]);
      }
      const veins: { from: Pt; to: Pt }[] = [];
      for (let i = 0; i < 9; i++) {
        const a = (-50 + (100 * i) / 8) * deg;
        veins.push({ from: [0, 0], to: [Math.sin(a) * R * 0.95, -Math.cos(a) * R * 0.95] });
      }
      fillLeaf(gg, pts, withJitter([70, 52, 40], rr), R, veins, rr);
    };
    g.strokeStyle = hslStr([28, 15, 32]); g.lineWidth = 5;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(6, -120); g.lineTo(2, -190); g.stroke();
    const spurs: [number, number, number][] = [[2, -60, -1], [5, -110, 1], [4, -160, -1], [2, -195, 0]];
    for (const [sx, sy, side] of spurs) {
      const n = r.int(4, 5);
      for (let k = 0; k < n; k++) {
        const a = side * 0.7 + (-0.9 + (1.8 * k) / (n - 1)) * (side === 0 ? 1 : 0.8);
        g.save(); g.translate(sx, sy); g.rotate(a);
        g.strokeStyle = hslStr([70, 30, 35]); g.lineWidth = 1.4;
        g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -26); g.stroke();
        g.translate(0, -26);
        fan(g, r.range(0.85, 1.1), r);
        g.restore();
      }
    }
  });
  // 7 shrub (deciduous): dense small leaves on 3 twigs
  cell(7, 1, () => {
    const r = rng.fork('shrub');
    for (const [dx, bend, len] of [[-40, -0.1, 0.8], [40, 0.1, 0.78], [0, 0.0, 0.92]] as [number, number, number][]) {
      g.save(); g.translate(dx, 0);
      drawTwigCell(g, r, {
        nodes: 10, twigLen: len, bend, spread: [35, 75], petiole: 3, size: [0.8, 1.0], twigW: 2.5, tip: true,
        leaf: (rr) => ovalLeaf(withJitter([92, 38, 29], rr), 30, 17, ov, 0, 0, 2),
      });
      g.restore();
    }
  });
  // 8 pine needle tufts (umbrella pine)
  cell(8, 1, () => {
    const r = rng.fork('pine');
    for (const [dx, a, s] of [[-45, -0.35, 0.85], [45, 0.35, 0.85], [0, 0, 1]] as [number, number, number][]) {
      g.save(); g.translate(dx * 0.6, 0); g.rotate(a);
      drawNeedleTuft(g, r, [118, 28, 25], 95 * s, 170, 150 * s);
      g.restore();
    }
  });
  // 9 cypress scale-leaf sprays
  cell(9, 1, () => {
    const r = rng.fork('cypress');
    for (const [dx, a] of [[-30, -0.35], [30, 0.35], [0, 0], [-10, -0.12], [12, 0.15]] as [number, number][]) {
      drawCypressSpray(g, r, dx, -4, a, r.range(170, 230), 2, [118, 30, 16]);
    }
  });
  // 10 spruce / conical pine branchlet (flat, comb needles)
  cell(10, 1, () => {
    const r = rng.fork('spruce');
    const col: HSL = [135, 26, 22];
    const axis = (x: number, y: number, a: number, len: number, depth: number) => {
      const steps = Math.round(len / 4);
      for (let i = 0; i < steps; i++) {
        const t = i / steps;
        const px = x + Math.sin(a) * len * t, py = y - Math.cos(a) * len * t;
        for (const sd of [-1, 1]) {
          const na = a + sd * r.range(50, 80) * deg;
          const nl = r.range(11, 16) * (1 - t * 0.3);
          g.strokeStyle = hslStr(withJitter(col, r, 6, 6, 6));
          g.lineWidth = 1.8;
          g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.sin(na) * nl, py - Math.cos(na) * nl); g.stroke();
        }
        if (depth > 0 && i > 2 && i % 4 === 0) {
          const sd = (i / 4) % 2 === 0 ? 1 : -1;
          axis(px, py, a + sd * 50 * deg, len * (1 - t) * 0.55, depth - 1);
        }
      }
      g.strokeStyle = hslStr([25, 30, 28]); g.lineWidth = 2;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.sin(a) * len, y - Math.cos(a) * len); g.stroke();
    };
    axis(0, 0, 0, 236, 1);
  });
  // 11 boxwood / evergreen shrub
  cell(11, 1, () => {
    const r = rng.fork('box');
    for (const [dx, bend, len] of [[-45, -0.12, 0.75], [45, 0.12, 0.75], [-15, -0.03, 0.9], [18, 0.04, 0.88]] as [number, number, number][]) {
      g.save(); g.translate(dx, 0);
      drawTwigCell(g, r, {
        nodes: 12, twigLen: len, bend, spread: [30, 70], opposite: true, petiole: 0, size: [0.8, 1.0], twigW: 2, tip: true,
        leaf: (rr) => ovalLeaf(withJitter([105, 42, 21], rr), 19, 11, (t) => Math.pow(Math.sin(Math.PI * t), 0.7), 0, 0, 0),
      });
      g.restore();
    }
  });
  // 12–13 palm frond (2 cells wide), 14–15 dead frond
  for (const [ci, dead] of [[12, false], [14, true]] as [number, boolean][]) {
    const cx = (ci % 4) * C, cy = Math.floor(ci / 4) * C;
    g.save();
    g.beginPath(); g.rect(cx + 3, cy + 3, C * 2 - 6, C - 6); g.clip();
    g.translate(cx + 3, cy);
    drawFrond(g, rng.fork('frond', ci), C * 2 - 6, C, dead ? [34, 38, 36] : [82, 40, 30], dead);
    g.restore();
  }

  // dilate colours into transparent texels so mip-mapping doesn't bleed dark fringes
  const img = g.getImageData(0, 0, S, S);
  const d = img.data;
  const valid = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) valid[i] = d[i * 4 + 3] > 100 ? 1 : 0;
  for (let pass = 0; pass < 10; pass++) {
    const next = valid.slice();
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = y * S + x;
      if (valid[i]) continue;
      let r = 0, gg = 0, b = 0, n = 0;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + ox, yy = y + oy;
        if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue;
        const j = yy * S + xx;
        if (!valid[j]) continue;
        r += d[j * 4]; gg += d[j * 4 + 1]; b += d[j * 4 + 2]; n++;
      }
      if (n) {
        d[i * 4] = r / n; d[i * 4 + 1] = gg / n; d[i * 4 + 2] = b / n;
        next[i] = 1;
      }
    }
    valid.set(next);
  }
  const tex = new THREE.DataTexture(new Uint8Array(d.buffer.slice(0)), S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  leafAtlas = tex;
  return tex;
}

/** For debugging: the procedural atlases. */
export function vegetationTextures() {
  return { leaves: getLeafAtlas(), bark: getBarkTextures().map, barkNormal: getBarkTextures().normal };
}

// ---------------------------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------------------------

const WIND_PARS = /* glsl */ `
uniform float uTime;
uniform float uWind;
attribute float aWind;
vec3 vegWind(vec3 p, vec3 n, float w, float flutter, float seed) {
  vec3 org = vec3(0.0);
  mat3 rot = mat3(1.0);
#ifdef USE_INSTANCING
  org = instanceMatrix[3].xyz;
  rot = mat3(instanceMatrix);
#endif
  vec3 wo = (modelMatrix * vec4(org, 1.0)).xyz;
  float ph = dot(wo.xz, vec2(0.137, 0.213));
  float sc = max(1e-3, length(rot[0]));
  vec3 dirW = normalize(vec3(1.0, 0.0, 0.42));
  vec3 dir = (transpose(rot) * dirW) / sc;
  float t = uTime;
  float gust = 0.55 + 0.45 * sin(t * 0.37 + ph * 0.5) * sin(t * 0.23 + ph * 0.9 + 1.3);
  float s = uWind * (0.35 + gust);
  float w2 = w * w;
  float sway = 0.55 + 0.45 * sin(t * 1.05 + ph);
  vec3 off = dir * (s * w2 * 0.42 * sway);
  float bp = ph * 3.0 + dot(p, vec3(0.45, 0.31, 0.38));
  vec3 osc = vec3(sin(t * 2.1 + bp), 0.35 * sin(t * 2.7 + bp * 1.3), sin(t * 1.8 + bp * 0.8 + 1.7));
  off += osc * (s * w2 * w * 0.13);
  off += n * (sin(t * 9.0 + seed * 40.0 + bp * 2.0) * flutter * s * w * 0.05);
  off.y -= dot(off.xz, off.xz) * 0.12;
  return p + off;
}
`;

const LEAF_VERT_PARS = /* glsl */ `
attribute float aLeafTint;
attribute float aOcc;
varying float vTint;
varying float vOcc;
varying vec2 vLeafUv;
`;

const AUTUMN: [number, number, number, number][] = [
  [0.62, 0.42, 0.12, 1], // plane: dull ochre-brown
  [0.85, 0.7, 0.18, 1], // linden: yellow
  [0.85, 0.22, 0.06, 1], // maple: red-orange
  [0.5, 0.3, 0.1, 1], // oak: russet
  [0.92, 0.78, 0.2, 1], // birch: golden
  [0.72, 0.45, 0.14, 1], // chestnut: orange-brown
  [1.0, 0.82, 0.12, 1], // ginkgo: bright yellow
  [0.75, 0.3, 0.12, 1], // shrub
  [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0],
  [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0],
];

const LEAF_ALPHA_BOOST = /* glsl */ `
#ifdef USE_MAP
{
  vec2 dxA = dFdx(vMapUv * 1024.0), dyA = dFdy(vMapUv * 1024.0);
  float lodA = max(0.0, 0.5 * log2(max(dot(dxA, dxA), dot(dyA, dyA))));
  diffuseColor.a = clamp(diffuseColor.a * (1.0 + lodA * 0.32), 0.0, 1.0);
}
#endif
`;

function patchWindVertex(shader: THREE.WebGLProgramParametersWithUniforms, leaf: boolean, extra = '') {
  shader.uniforms.uTime = vegetationUniforms.uTime;
  shader.uniforms.uWind = vegetationUniforms.uWind;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + WIND_PARS + (leaf ? 'attribute float aLeafTint;\n' : '') + extra)
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      transformed = vegWind(transformed, normal, aWind, ${leaf ? '1.0' : '0.0'}, ${leaf ? 'aLeafTint' : '0.0'});`,
    );
}

function makeDepthMaterial(leaf: boolean, key: string): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (shader) => {
    patchWindVertex(shader, leaf);
    if (leaf) shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', LEAF_ALPHA_BOOST + '\n#include <alphatest_fragment>');
  };
  m.customProgramCacheKey = () => 'vegDepth-' + key;
  return m;
}

/** Sets mesh.customDepthMaterial from a vegetation material (call after creating the mesh). */
export function applyVegetationShadow(mesh: THREE.Mesh) {
  const mat = mesh.material as THREE.Material;
  const dm = mat?.userData?.depthMaterial as THREE.Material | undefined;
  if (dm) mesh.customDepthMaterial = dm;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
}

export function createBarkMaterial(): THREE.MeshStandardMaterial {
  const tex = getBarkTextures();
  const m = new THREE.MeshStandardMaterial({
    map: tex.map,
    normalMap: tex.normal,
    normalScale: new THREE.Vector2(1.1, 1.1),
    roughness: 0.92,
    metalness: 0,
  });
  m.onBeforeCompile = (shader) => {
    patchWindVertex(shader, false, 'attribute float aOcc;\nvarying float vOcc;\n');
    shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\nvOcc = aOcc;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vOcc;')
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        float bStrip = floor(vMapUv.x / 16.0);
        vec2 bUv = vec2(vMapUv.x - bStrip * 16.0, vMapUv.y);
        vec2 bAt = vec2((bStrip + 0.012 + fract(bUv.x) * 0.976) / ${BARK_STRIPS.toFixed(1)}, bUv.y);
        vec2 bGx = dFdx(bUv) * vec2(0.976 / ${BARK_STRIPS.toFixed(1)}, 1.0);
        vec2 bGy = dFdy(bUv) * vec2(0.976 / ${BARK_STRIPS.toFixed(1)}, 1.0);
        diffuseColor *= textureGrad(map, bAt, bGx, bGy);
        diffuseColor.rgb *= 1.0 - vOcc * 0.6;
        `,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        {
          vec3 mapN = textureGrad(normalMap, bAt, bGx, bGy).xyz * 2.0 - 1.0;
          mapN.xy *= normalScale;
          normal = normalize(tbn * mapN);
        }
        `,
      )
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= 1.0 - vOcc * 0.5;\nreflectedLight.indirectSpecular *= 1.0 - vOcc * 0.7;');
  };
  m.customProgramCacheKey = () => 'vegBark';
  m.userData.depthMaterial = makeDepthMaterial(false, 'bark');
  return m;
}

export function createLeafMaterial(species?: TreeSpecies): THREE.MeshStandardMaterial {
  const tex = getLeafAtlas();
  const m = new THREE.MeshStandardMaterial({
    map: tex,
    alphaTest: 0.45,
    side: THREE.DoubleSide,
    roughness: 0.78,
    metalness: 0,
    alphaToCoverage: false,
  });
  m.shadowSide = THREE.DoubleSide;
  const autumn = AUTUMN.map((a) => new THREE.Vector4(srgbToLin(a[0]), srgbToLin(a[1]), srgbToLin(a[2]), a[3]));
  const trans = species === 'pine' || species === 'cypress' ? 0.35 : 0.85;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSeason = vegetationUniforms.uSeason;
    shader.uniforms.uAutumn = { value: autumn };
    shader.uniforms.uTrans = { value: trans };
    patchWindVertex(shader, true, 'attribute float aOcc;\nvarying float vTint;\nvarying float vOcc;\n');
    shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\nvTint = aLeafTint; vOcc = aOcc;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform float uSeason;
        uniform float uTrans;
        uniform vec4 uAutumn[16];
        varying float vTint;
        varying float vOcc;
        `,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
        ${LEAF_ALPHA_BOOST}
        {
          // fade cards seen edge-on (they would read as streaks)
          vec3 fN = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
          float edgeOn = abs(dot(fN, normalize(vViewPosition)));
          diffuseColor.a *= smoothstep(0.04, 0.32, edgeOn) * 0.55 + 0.45;
        }
        {
          vec2 cellI = floor(clamp(vMapUv, 0.0, 0.9999) * 4.0);
          int ci = int(cellI.y) * 4 + int(cellI.x);
          vec4 aut = uAutumn[ci];
          vec3 c = diffuseColor.rgb;
          float tv = vTint - 0.5;
          c *= 1.0 + tv * 0.4;
          c = mix(c, c * vec3(1.12, 1.06, 0.7), max(tv, 0.0) * 0.5);
          float lum = dot(c, vec3(0.3, 0.59, 0.11));
          float turn = clamp(uSeason * 1.6 - vTint * 0.6, 0.0, 1.0) * aut.a;
          c = mix(c, aut.rgb * (lum * 3.2 + 0.015), turn);
          c *= 1.0 - vOcc * 0.62;
          diffuseColor.rgb = c;
        }
        `,
      )
      .replace(
        '#include <normal_fragment_begin>',
        /* glsl */ `#include <normal_fragment_begin>
        #ifdef DOUBLE_SIDED
          normal *= faceDirection;
          nonPerturbedNormal = normal;
        #endif
        `,
      )
      .replace(
        '#include <lights_fragment_begin>',
        THREE.ShaderChunk.lights_fragment_begin.split(
          'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );',
        ).join(
          'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );\n' +
            '{ float bk = pow(saturate(dot(geometryViewDir, -directLight.direction)), 6.0); float wr = saturate(0.5 - 0.5 * dot(geometryNormal, directLight.direction));' +
            ' reflectedLight.directDiffuse += directLight.color * material.diffuseColor * (bk * 0.8 + wr * 0.18) * uTrans * (1.0 - vOcc * 0.6); }',
        ),
      )
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= 1.0 - vOcc * 0.45;\nreflectedLight.indirectSpecular *= (1.0 - vOcc * 0.8) * 0.3;\nreflectedLight.directSpecular *= 0.45;');
  };
  m.customProgramCacheKey = () => 'vegLeaf';
  m.userData.depthMaterial = makeDepthMaterial(true, 'leaf');
  return m;
}

export function createFarTreeMaterial(): THREE.Material {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSeason = vegetationUniforms.uSeason;
    patchWindVertex(shader, false, 'attribute vec3 aAutumn;\nvarying vec3 vAutumn;\nvarying vec2 vKind;\nvarying vec3 vObjPos;\n');
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      '#include <uv_vertex>\nvAutumn = aAutumn; vKind = uv; vObjPos = position;\n#ifdef USE_INSTANCING\nvObjPos += instanceMatrix[3].xyz * 0.37;\n#endif',
    );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform float uSeason;
        varying vec3 vAutumn;
        varying vec2 vKind;
        varying vec3 vObjPos;
        float vhash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float vnoise(vec3 x) {
          vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(vhash(i), vhash(i + vec3(1,0,0)), f.x), mix(vhash(i + vec3(0,1,0)), vhash(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(vhash(i + vec3(0,0,1)), vhash(i + vec3(1,0,1)), f.x), mix(vhash(i + vec3(0,1,1)), vhash(i + vec3(1,1,1)), f.x), f.y), f.z);
        }
        `,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        {
          float nz = vnoise(vObjPos * 2.2) * 0.6 + vnoise(vObjPos * 5.1) * 0.4;
          if (vKind.x > 0.75) {
            float edge = 1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition)));
            if (edge * edge * 1.25 > nz + 0.12) discard;
          }
          if (vKind.x > 0.25) {
            diffuseColor.rgb *= 0.78 + nz * 0.45;
            diffuseColor.rgb = mix(diffuseColor.rgb, vAutumn * (0.78 + nz * 0.45), clamp(uSeason * 1.4 - nz * 0.4, 0.0, 1.0) * vKind.y);
          }
        }
        `,
      );
  };
  m.customProgramCacheKey = () => 'vegFar';
  m.userData.depthMaterial = makeDepthMaterial(false, 'far');
  return m;
}
