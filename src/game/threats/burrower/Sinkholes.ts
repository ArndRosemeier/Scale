/**
 * Sinkholes (THREATS_PLAN §1 #3): where the Burrower breaks through, the street caves in.
 *
 *  - A crater mesh per hole: a jagged rim of broken asphalt just above the street, a short sheer
 *    wall (asphalt, then the sub-base), a soil bowl going down to `depth`, tilted slabs of the
 *    road lying on the slope, a pipe stub sticking out of the wall, rubble. One plain vertex-coloured
 *    material (warmed during the start-up), so a hole costs no shader of its own.
 *  - The street and terrain are cut out over it (the street holes the shaders already discard:
 *    `holes`), the ground dips (`dip`: WorldIndex.surfaceOffset, so walking, physics, cars, decals
 *    and debris follow it), cars stop short of it (Traffic.holds) and people keep off (Pedestrians.pits).
 *  - Opening: the street sags and drops over a second and a half; cars on it are wrecked and fall in,
 *    people are knocked off their feet, street furniture is crushed, the foot of a building beside
 *    it is undermined; dust, a tremor, a collapse heard far off.
 *  - Holes stay SINK.keep game hours, then are filled in (when nobody is looking); saves keep them.
 *  - A small pothole (an omen) is the same with a 1–2 m mouth and no harm done.
 *
 * Holes only open where the street can cave in (`site`): on a carriageway, clear of buildings,
 * landmarks, water, bridges and metro entrances, with ground over any tunnel (the depth shrinks to
 * keep half a metre over a sewer or the metro, and a site with less than SINK.minDepth is refused).
 */
import * as THREE from 'three';
import type { Game } from '../../Game';
import { Rng } from '../../../core/rng';
import { PState } from '../../../sim/Pedestrians';
import { VState } from '../../../sim/Traffic';
import { DecalKind } from '../../powers/ElementFx';
import { closestOnPoly, distPointPolyEdge, pointInPoly } from '../../../core/geom2';

export const SINK = {
  /** Depth of a hole (m), the least worth opening, ground kept over a tunnel. */
  depth: [4.5, 6.5] as [number, number], minDepth: 1.4, deep: 2.2, overTunnel: 0.5,
  /** Opening time (s); how long a hole stays (game hours). */
  openT: 1.6, keep: 12,
  /** The sheer wall at the edge: its share of the radius and of the depth. */
  wallU: 0.97, wallD: 0.4,
  /** The broken rim round it (share of the radius beyond the edge) and its height over the street. */
  rim: 0.13, rimH: 0.07,
  /** Most holes kept at once (the oldest is filled first). */
  max: 12,
};

/** Crater depth below the street at u = distance / radius (0 centre … 1 edge), for depth D. */
export function craterDepth(u: number, D: number): number {
  if (u >= 1) return 0;
  const w = SINK.wallU, wd = D * SINK.wallD;
  if (u >= w) return wd * (1 - u) / (1 - w);
  const v = u / w;
  return wd + (D - wd) * (1 - v * v);
}

export interface Sinkhole {
  x: number; z: number; r: number; depth: number;
  /** Opening 0..1. */
  k: number;
  /** Absolute game hours when it is filled in. */
  until: number;
  small: boolean;
  seed: number;
  /** Edge radius per angle (jagged), NA entries. */
  edge: Float32Array;
  mesh: THREE.Mesh | null;
  /** The street height at each vertex and the crater depth there (opening animation). */
  base: Float32Array | null;
  drop: Float32Array | null;
  /** Its stop sign for cars and people. */
  hold: { x: number; z: number; r: number };
}

const NA = 48, NR = 13;
const DUST = new THREE.Color(0.5, 0.45, 0.38);
const ASPHALT: [number, number, number] = [0.045, 0.045, 0.048];
const BASE: [number, number, number] = [0.2, 0.18, 0.15];
const SOIL: [number, number, number] = [0.13, 0.085, 0.05];
const DEEP: [number, number, number] = [0.06, 0.04, 0.025];
const PIPE: [number, number, number] = [0.17, 0.16, 0.15];

export class Sinkholes {
  readonly list: Sinkhole[] = [];
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private warmMesh: THREE.Mesh;
  private checkT = 0;
  stats = { opened: 0, refused: 0, cars: 0, people: 0, filled: 0 };

  constructor(private g: Game) {
    this.group.name = 'sinkholes';
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    // A speck drawn during the warm-up (the program compiles behind the loading screen).
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0.01, 0, 0, 0, 0, 0.01]), 3));
    wg.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
    wg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(9), 3));
    this.warmMesh = new THREE.Mesh(wg, this.material);
    this.warmMesh.frustumCulled = false;
    this.group.add(this.warmMesh);
    g.renderer.scene.add(this.group);
    g.world.dip = (x, z) => this.dip(x, z);
    g.peds.pits = this.list.map((h) => h.hold);
  }

  /** How far the ground is sunk at (x, z) (0 off every hole). */
  dip(x: number, z: number): number {
    let d = 0;
    for (const h of this.list) {
      const dx = x - h.x, dz = z - h.z;
      const R = h.r * 1.08;
      if (dx * dx + dz * dz > R * R) continue;
      const e = edgeAt(h, Math.atan2(dz, dx));
      d = Math.max(d, craterDepth(Math.hypot(dx, dz) / e, h.depth) * ease(h.k));
    }
    return d;
  }

  /** Holes for the street / terrain shaders (Game.updateHoles): x, z, cos, sin, radius, −1 (round). */
  holes(out: number[]): void {
    for (const h of this.list) if (h.k > 0.02) out.push(h.x, h.z, 1, 0, h.r * (h.small ? 0.96 : 0.985), -1);
  }

  /**
   * Can the street cave in here with a mouth of radius r? The site (moved onto the carriageway's
   * middle when it is near one) and how deep it may go, or null.
   */
  site(x: number, z: number, r: number, small = false): { x: number; z: number; r: number; depth: number } | null {
    const g = this.g, W = g.world;
    // (nearestEdge searches in rings from 32 m, so a smaller radius finds nothing.)
    const ne = g.net.nearestEdge(x, z, 32);
    if (ne && ne.d < 30) {
      const o = { x: 0, z: 0, dx: 0, dz: 0 };
      g.net.pointAt(g.net.edges[ne.e], ne.s, 0, o);
      x = o.x; z = o.z;
    } else if (!small) return this.refuse('no street');
    if (!W.loaded(x, z)) return this.refuse('not loaded');
    if (W.wet(x, z, r + 3)) return this.refuse('water'); // (on a bridge: refused just below)
    for (let i = 0; i < 9; i++) {
      const a = (i / 8) * Math.PI * 2, rr = i === 8 ? 0 : r + 1;
      if (W.bridgeDeck(x + Math.cos(a) * rr, z + Math.sin(a) * rr) > -Infinity) return this.refuse('bridge');
    }
    for (const ref of W.buildingsIn(x - r - 2, z - r - 2, x + r + 2, z + r + 2)) {
      if (ref.alive && (pointInPoly(ref.poly, x, z) || distPointPolyEdge(ref.poly, x, z) < r + 0.5)) return this.refuse('building');
    }
    if (W.landmarks?.onFootprint(x, z, r + 1)) return this.refuse('landmark');
    const H = g.underground.holes;
    for (let i = 0; i < H.length; i += 6) if (Math.hypot(H[i] - x, H[i + 1] - z) < r + 6) return this.refuse('metro entrance');
    for (const h of this.list) if (Math.hypot(h.x - x, h.z - z) < h.r + r + 2) return this.refuse('another hole');
    // Ground over the sewers and the metro.
    const top = g.terrain.height(x, z) + W.surfaceOffset(x, z);
    let depth = small ? 0.7 : SINK.depth[1];
    for (let y = 1; y <= depth + SINK.overTunnel + 0.01; y += 0.5) {
      let hit = false;
      for (let i = 0; i < 5 && !hit; i++) {
        const a = (i / 4) * Math.PI * 2, rr = i === 4 ? 0 : r * 0.6;
        if (g.underground.contains(x + Math.cos(a) * rr, top - y, z + Math.sin(a) * rr, 0)) hit = true;
      }
      if (hit) { depth = Math.min(depth, y - SINK.overTunnel); break; }
    }
    if (!small && depth < SINK.minDepth) return this.refuse(`tunnel ${depth.toFixed(1)} m down`);
    return { x, z, r, depth: Math.max(0.4, depth) };
  }

  /** Why the last site was refused (dev status). */
  why = '';
  private refuse(why: string): null { this.why = why; this.stats.refused++; return null; }

  /** Open a hole at a site (`site`'s answer): it caves in over SINK.openT. */
  open(at: { x: number; z: number; r: number; depth: number }, seed: number, small = false): Sinkhole {
    const g = this.g;
    const h = this.add(at, seed, small, small ? at.depth : undefined);
    this.stats.opened++;
    const y = g.terrain.height(h.x, h.z), cam = g.renderer.camera.position;
    if (!small) {
      g.stimuli.emit('collapse', h.x, y, h.z, 7, 450, { cause: 'threat' });
      g.audio.play('burrower_breach', h.x, y, h.z, 1, 0.9 + Math.random() * 0.15, 120, cam);
    } else g.audio.play('debris_small', h.x, y, h.z, 0.8, 0.8, 20, cam);
    return h;
  }

  /** A hole in the list with its mesh (not yet open: k = 0), the oldest filled first when full. */
  private add(at: { x: number; z: number; r: number; depth: number }, seed: number, small: boolean, depth?: number): Sinkhole {
    while (this.list.length >= SINK.max) this.remove(this.list[0]);
    const rng = new Rng(seed);
    const d = depth ?? Math.min(at.depth, rng.range(SINK.depth[0], SINK.depth[1]));
    const edge = new Float32Array(NA);
    // A jagged mouth: a few lobes and some sharp notches.
    const p1 = rng.range(0, 6.28), p2 = rng.range(0, 6.28);
    for (let i = 0; i < NA; i++) {
      const a = (i / NA) * Math.PI * 2;
      edge[i] = at.r * (1 + 0.06 * Math.sin(a * 3 + p1) + 0.035 * Math.sin(a * 7 + p2) + rng.range(-0.035, 0.035));
    }
    const h: Sinkhole = {
      x: at.x, z: at.z, r: at.r, depth: d, k: 0, until: this.g.sky.hoursAbs + SINK.keep, small, seed, edge,
      mesh: null, base: null, drop: null, hold: { x: at.x, z: at.z, r: at.r * 1.1 + 0.5 },
    };
    this.build(h);
    this.list.push(h);
    this.syncHolds();
    return h;
  }

  update(dt: number): void {
    const g = this.g;
    this.warmMesh.visible = !g.gate.enabled;
    if (this.warmMesh.visible) { const p = g.player.pos; this.warmMesh.position.set(p.x, p.y - 2, p.z); }
    for (const h of this.list) {
      if (h.k >= 1) continue;
      const before = h.k;
      h.k = Math.min(1, h.k + dt / (h.small ? 0.5 : SINK.openT));
      // (Eased: a sag, then the drop.)
      this.pose(h, ease(h.k));
      if (!h.small) this.caveIn(h, before, h.k, dt);
      if (h.k >= 1 || Math.floor(before * 4) !== Math.floor(h.k * 4)) g.physics.invalidateGround(h.x - h.r - 2, h.z - h.r - 2, h.x + h.r + 2, h.z + h.r + 2);
    }
    // Filled in when their time is up and nobody is near to see it.
    this.checkT -= dt;
    if (this.checkT > 0) return;
    this.checkT = 5;
    const c = g.renderer.camera.position, now = g.sky.hoursAbs;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const h = this.list[i];
      if (now > h.until && Math.hypot(h.x - c.x, h.z - c.z) > 260) { this.remove(h); this.stats.filled++; }
    }
  }

  /** What the ground giving way does to what stands on it (once per stage of the opening). */
  private caveIn(h: Sinkhole, before: number, k: number, _dt: number): void {
    const g = this.g, y = g.terrain.height(h.x, h.z), R = h.r;
    const cam = g.renderer.camera.position;
    if (before === 0) {
      // Cracks first, the sag: a shudder; dust from the rim.
      g.elements.fx.decal(DecalKind.Crack, h.x, y + 0.05, h.z, 0, 1, 0, R * 2.6, R * 2.6, Math.random() * 6, 300);
      const d = Math.hypot(g.player.pos.x - h.x, g.player.pos.z - h.z);
      if (d < 160) g.camRig.addShake(0.4 * (1 - d / 160));
    }
    if (before < 0.45 && k >= 0.45) {
      // The drop: what is on it goes down with it.
      for (const v of [...g.traffic.vehicles, ...g.parkedCars]) {
        if (v.state === VState.Crushed || v.state === VState.Wreck || Math.hypot(v.x - h.x, v.z - h.z) > R + v.length * 0.3) continue;
        g.traffic.wreckIt(v);
        const dx = h.x - v.x, dz = h.z - v.z, l = Math.hypot(dx, dz) || 1;
        g.vehicles.makeWreck(v, v.x, v.y + 0.4, v.z, (dx / l) * 1500, -800, (dz / l) * 1500);
        g.consequences.record('burrower', 'car', 'wreck', v.x, v.z, v, 'threat');
        this.stats.cars++;
      }
      for (const a of g.peds.neighbours(h.x, h.z, R + 2.5, [])) {
        if (a.inside || a.state === PState.Down || Math.abs(a.y - y) > 3) continue;
        const d = Math.hypot(a.x - h.x, a.z - h.z);
        if (d > R + 2.5) continue;
        // On it: down they go; at the edge: thrown off their feet.
        g.reactions.knockDown(a, h.x, h.z, d < R ? 3 : 5, 'threat');
        g.consequences.record('burrower', 'person', 'knockdown', a.x, a.z, a, 'threat');
        this.stats.people++;
      }
      g.props.crush(h.x, h.z, R + 0.5);
      // The foot of a building beside it undermined.
      for (const ref of g.world.buildingsIn(h.x - R - 6, h.z - R - 6, h.x + R + 6, h.z + R + 6)) {
        if (!ref.alive) continue;
        const c = closestOnPoly(ref.poly, h.x, h.z);
        if (Math.hypot(c.x - h.x, c.z - h.z) > R + 5) continue;
        const dx = h.x - c.x, dz = h.z - c.z, l = Math.hypot(dx, dz) || 1;
        g.destruction.as('threat', () => g.destruction.impact(c.x - (dx / l) * 0.3, ref.base + 1.5, c.z - (dz / l) * 0.3, 3.2, 4.5e5, dx / l, -0.5, dz / l, 'stomp'));
      }
      g.dust.burst(h.x, y + 1, h.z, 18, R, 5, 3.5, 4, DUST, 0.35, 0.45);
      g.audio.play('tree_crack_fall', h.x, y, h.z, 0.9, 0.55, 50, cam);
    }
    if (k >= 1) {
      // The last of the rim falls in; dust hangs over it.
      for (let i = 0; i < 6; i++) {
        const a = Math.random() * Math.PI * 2;
        g.dust.burst(h.x + Math.cos(a) * R * 0.8, y - h.depth * 0.5, h.z + Math.sin(a) * R * 0.8, 5, 2, 2, 3, 4, DUST, 0.5, 0.4);
      }
    }
  }

  private remove(h: Sinkhole): void {
    const i = this.list.indexOf(h);
    if (i < 0) return;
    this.list.splice(i, 1);
    if (h.mesh) { this.group.remove(h.mesh); h.mesh.geometry.dispose(); }
    this.syncHolds();
    this.g.physics.invalidateGround(h.x - h.r - 2, h.z - h.r - 2, h.x + h.r + 2, h.z + h.r + 2);
  }

  private syncHolds(): void {
    const T = this.g.traffic.holds;
    for (let i = T.length - 1; i >= 0; i--) if ((T[i] as { sink?: boolean }).sink) T.splice(i, 1);
    for (const h of this.list) if (!h.small) T.push(Object.assign(h.hold, { sink: true }));
    this.g.peds.pits = this.list.map((h) => h.hold);
  }

  /** Saves: [x, z, r, depth, until, small] per hole. */
  saveState(): number[][] {
    return this.list.map((h) => [Math.round(h.x * 10) / 10, Math.round(h.z * 10) / 10, Math.round(h.r * 100) / 100, Math.round(h.depth * 100) / 100, Math.round(h.until * 1000) / 1000, h.small ? 1 : 0, h.seed]);
  }

  restoreState(rows: number[][]): void {
    for (const h of [...this.list]) this.remove(h);
    for (const r of rows) {
      if (r.length < 6 || !r.every(Number.isFinite)) continue;
      const h = this.add({ x: r[0], z: r[1], r: Math.max(0.8, Math.min(12, r[2])), depth: 8 }, (r[6] ?? 1) >>> 0, r[5] === 1, Math.max(0.3, Math.min(8, r[3])));
      h.until = r[4];
      h.k = 1;
      this.pose(h, 1);
    }
    this.g.physics.invalidateGround(-1e5, -1e5, 1e5, 1e5);
  }

  // ------------------------------------------------------------------ the crater mesh

  /** The crater's geometry (street heights sampled now, before the hole dips the street). */
  private build(h: Sinkhole): void {
    const g = this.g;
    if (h.mesh) { this.group.remove(h.mesh); h.mesh.geometry.dispose(); }
    // (Sampled with this hole not yet counted: its own dip must not be in the street height.)
    const was = this.list.indexOf(h);
    if (was >= 0) this.list.splice(was, 1);
    const street = (x: number, z: number) => g.terrain.height(x, z) + g.world.surfaceOffset(x, z);
    const geo = buildCrater(h, street);
    if (was >= 0) this.list.splice(was, 0, h);
    const mesh = new THREE.Mesh(geo.geometry, this.material);
    mesh.position.set(h.x, geo.y0, h.z);
    mesh.updateMatrix();
    mesh.name = 'sinkhole';
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.raycast = () => {};
    this.group.add(mesh);
    h.mesh = mesh;
    h.base = geo.base;
    h.drop = geo.drop;
    this.pose(h, ease(h.k));
  }

  /** The opening: every vertex between the street and its place in the crater. */
  private pose(h: Sinkhole, k: number): void {
    if (!h.mesh || !h.base || !h.drop) return;
    const P = h.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const A = P.array as Float32Array, B = h.base, D = h.drop;
    for (let i = 0; i < B.length; i++) A[i * 3 + 1] = B[i] - D[i] * k;
    P.needsUpdate = true;
    h.mesh.geometry.computeVertexNormals();
    h.mesh.geometry.computeBoundingSphere();
  }

  /** Dev: status. */
  status(): Record<string, unknown> {
    return { why: this.why, holes: this.list.map((h) => ({ x: Math.round(h.x), z: Math.round(h.z), r: +h.r.toFixed(1), depth: +h.depth.toFixed(1), k: +h.k.toFixed(2), small: h.small })), ...this.stats };
  }
}

function ease(k: number): number { return k < 0.4 ? 0.12 * (k / 0.4) : 0.12 + 0.88 * (1 - Math.pow(1 - (k - 0.4) / 0.6, 3)); }

/** The jagged edge radius in direction a. */
function edgeAt(h: { edge: Float32Array }, a: number): number {
  const f = ((a / (Math.PI * 2)) % 1 + 1) % 1 * NA;
  const i = Math.floor(f), t = f - i;
  return h.edge[i % NA] * (1 - t) + h.edge[(i + 1) % NA] * t;
}

/**
 * The crater as a mesh: positions are written by the opening (`base` − `drop` × k per vertex).
 * Exported for the self-test (watertight bowl, profile).
 */
export function buildCrater(h: { x: number; z: number; r: number; depth: number; seed: number; edge: Float32Array; small: boolean }, street: (x: number, z: number) => number): { geometry: THREE.BufferGeometry; base: Float32Array; drop: Float32Array; y0: number } {
  const rng = new Rng(h.seed ^ 0x51ab);
  const pos: number[] = [], col: number[] = [], base: number[] = [], drop: number[] = [], idx: number[] = [];
  const D = h.depth, y0 = street(h.x, h.z);
  // (Positions relative to the centre on the street: the mesh sits there.)
  const vert = (x: number, z: number, b: number, d: number, c: [number, number, number], shade = 1) => {
    pos.push(x - h.x, b - y0 - d, z - h.z); base.push(b - y0); drop.push(d);
    col.push(c[0] * shade, c[1] * shade, c[2] * shade);
    return base.length - 1;
  };
  const colourAt = (d: number, u: number): [number, number, number] => {
    if (u > 1) return ASPHALT;
    if (d < 0.22) return ASPHALT;
    if (d < 0.9) return BASE;
    const t = Math.min(1, (d - 0.9) / Math.max(0.5, D - 0.9));
    return [SOIL[0] + (DEEP[0] - SOIL[0]) * t, SOIL[1] + (DEEP[1] - SOIL[1]) * t, SOIL[2] + (DEEP[2] - SOIL[2]) * t];
  };
  // ---- the bowl: rings from the centre to the rim, NA spokes
  const us: number[] = [];
  for (let k = 0; k < NR - 3; k++) us.push((k + 1) / (NR - 3) * SINK.wallU * 0.999);
  us.push(SINK.wallU, 0.995, 1.0, 1 + SINK.rim);
  const c0 = vert(h.x, h.z, y0, D, DEEP);
  const ring: number[][] = [];
  for (let k = 0; k < us.length; k++) {
    const u = us[k], row: number[] = [];
    for (let i = 0; i < NA; i++) {
      const a = (i / NA) * Math.PI * 2, e = h.edge[i];
      // (The wall's layers: a little ragged; the rim lies on the street, broken.)
      const jit = u < 1 && u > 0.2 ? rng.range(-0.04, 0.04) * e : 0;
      const rr = u * e + jit;
      const x = h.x + Math.cos(a) * rr, z = h.z + Math.sin(a) * rr;
      const b = street(x, z);
      let d = craterDepth(Math.min(u, 0.9999), D) * (u >= 1 ? 0 : 1);
      if (u < SINK.wallU) d += rng.range(-0.12, 0.12) * D * 0.15;
      let c = colourAt(d, u);
      if (u > 1) d = -SINK.rimH * rng.range(0.3, 1.4);
      if (u === 1) d = -SINK.rimH;
      const shade = 0.82 + rng.range(0, 0.3);
      if (u >= SINK.wallU && u <= 1) c = d < 0.22 ? ASPHALT : BASE;
      row.push(vert(x, z, b, d, c, shade));
    }
    ring.push(row);
  }
  for (let i = 0; i < NA; i++) { const j = (i + 1) % NA; idx.push(c0, ring[0][j], ring[0][i]); }
  for (let k = 0; k + 1 < ring.length; k++) {
    const A = ring[k], B = ring[k + 1];
    for (let i = 0; i < NA; i++) {
      const j = (i + 1) % NA;
      idx.push(A[i], A[j], B[j], A[i], B[j], B[i]);
    }
  }
  if (!h.small) {
    // ---- slabs of the road on the slope, rubble, a pipe stub in the wall
    const box = (cx: number, cz: number, u: number, w: number, l: number, t: number, yaw: number, tilt: number, c: [number, number, number]) => {
      const b = street(cx, cz), d = craterDepth(u, D) - t * 0.5;
      const cy = Math.cos(yaw), sy = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
      const v0 = base.length;
      for (const [px, py, pz] of [[-w, -t, -l], [w, -t, -l], [w, -t, l], [-w, -t, l], [-w, t, -l], [w, t, -l], [w, t, l], [-w, t, l]]) {
        // Tilted about its local x (down the slope), then turned.
        const ly = py * ct - pz * st, lz = py * st + pz * ct;
        vert(cx + px * cy - lz * sy, cz + px * sy + lz * cy, b, d - ly, c, 0.8 + rng.range(0, 0.35));
      }
      for (const [a, bb, cc, dd] of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) idx.push(v0 + a, v0 + bb, v0 + cc, v0 + a, v0 + cc, v0 + dd);
    };
    const nSlab = 4 + rng.int(0, 3);
    for (let s = 0; s < nSlab; s++) {
      const a = rng.range(0, Math.PI * 2), u = rng.range(0.55, 0.88), rr = u * h.r;
      // Down the slope: the slab's long axis points at the centre, tipped in.
      box(h.x + Math.cos(a) * rr, h.z + Math.sin(a) * rr, u, rng.range(0.9, 1.8), rng.range(1.2, 2.2), 0.14, a + Math.PI / 2 + rng.range(-0.5, 0.5), rng.range(0.35, 0.8), ASPHALT);
    }
    const nRub = 10 + rng.int(0, 8);
    for (let s = 0; s < nRub; s++) {
      const a = rng.range(0, Math.PI * 2), u = rng.range(0.05, 0.8), rr = u * h.r, sz = rng.range(0.2, 0.6);
      box(h.x + Math.cos(a) * rr, h.z + Math.sin(a) * rr, u, sz, sz * rng.range(0.7, 1.4), sz * 0.7, rng.range(0, 6.28), rng.range(-0.6, 0.6), rng.chance(0.4) ? ASPHALT : BASE);
    }
    // A pipe out of the wall, broken off.
    {
      const a = rng.range(0, Math.PI * 2), e = edgeAt(h, a), pd = Math.min(D * 0.6, 1.6), pr = 0.22, L = 1.4;
      const ox = Math.cos(a), oz = Math.sin(a), px = -oz, pz = ox;
      const v0 = base.length, n = 8;
      const sx = h.x + ox * (e * 1.02), sz2 = h.z + oz * (e * 1.02), b = street(sx, sz2);
      for (let end = 0; end < 2; end++) {
        const along = end ? e * 1.02 - L : e * 1.02;
        for (let i = 0; i < n; i++) {
          const t = (i / n) * Math.PI * 2;
          vert(h.x + ox * along + px * Math.cos(t) * pr, h.z + oz * along + pz * Math.cos(t) * pr, b, pd + Math.sin(t) * pr, PIPE, 0.9);
        }
      }
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; idx.push(v0 + i, v0 + j, v0 + n + j, v0 + i, v0 + n + j, v0 + n + i); }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(pos.length), 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  geometry.setIndex(idx);
  geometry.computeVertexNormals();
  return { geometry, base: new Float32Array(base), drop: new Float32Array(drop), y0 };
}
