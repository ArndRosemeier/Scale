/**
 * Countryside trees around the camera, streamed in tiles from the city workers (build/forest).
 *
 * Tiles follow the terrain quadtree rule, so their size grows with distance and every tile
 * costs about the same:
 *  - 256 m tiles near the camera are "detail" tiles: their trees are drawn as full instanced
 *    models within NEAR (shadows within SHADOW) and as the ~90-triangle far hulls beyond;
 *  - every other tile is one or two instanced meshes of low-poly canopy clumps (each stands for
 *    a tree, or a patch of forest in the bigger tiles), up to FAR_R.
 * Trees use the street-tree models and materials (props/vegetation), shared with the city.
 * Trunks of nearby trees are obstacles for the player.
 */
import * as THREE from 'three';
import { hitch } from '../debug/HitchLog';
import type { WorkerPool } from './WorkerPool';
import type { FromWorker } from './protocol';
import { FOREST_DETAIL, FOREST_KINDS, FOREST_STRIDE } from '../build/forest';
import { treeModel, shrubModel, createBarkMaterial, createLeafMaterial, createFarTreeMaterial, applyVegetationShadow, batchCap, type TreeModel, type TreeSpecies } from '../props/vegetation';
import { TERRAIN_ROOT } from '../world/boundary';
import type { Obstacle } from '../world/Collision';
import { hash32, hashToFloat } from '../core/rng';
import { WEBGPU, gpuKit } from '../render/gpuMode';

/** Full tree models nearer than this (m). */
const NEAR = 75;
/** ...of which these cast shadows. */
const SHADOW = 45;
/** 256 m tiles nearer than this (3D, m) draw individual trees; farther tiles draw clumps. */
const DETAIL_R = 330;
/** No clumps beyond this (the terrain shader's canopy colour carries the forests on). */
const FAR_R = 11000;

interface FTile {
  key: string;
  x0: number; z0: number; size: number;
  status: 'loading' | 'ready';
  recs: Float32Array | null;
  /** Clump meshes (built when first shown). */
  clumps: THREE.InstancedMesh[] | null;
  used: number;
  bytes: number;
}

interface Batch { meshes: THREE.InstancedMesh[]; cap: number }

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _c = new THREE.Color();

export class Countryside {
  readonly group = new THREE.Group();
  private tiles = new Map<string, FTile>();
  /** Detail tiles currently drawn as trees. */
  private detail: FTile[] = [];
  private batches = new Map<string, Batch>();
  private bark = createBarkMaterial();
  private leafMats = new Map<string, THREE.Material>();
  private farMat = createFarTreeMaterial();
  private clumpMat = createClumpMaterial();
  private clumpGeo = [clumpGeometry(false), clumpGeometry(true)];
  private t = 0;
  private lastUpdate = -1;
  private lastNear = new THREE.Vector3(1e9, 0, 0);
  private detailKey = '';
  private nearKey = '';
  stats = { tiles: 0, trees: 0, clumps: 0, drawnFull: 0, drawnHull: 0, bytes: 0 };

  constructor(private pool: WorkerPool, private ext: number) {
    this.group.name = 'countryside';
    // Build the tree models now (during loading; ~5 ms each, shared with the street trees)
    // rather than as a hitch when the first forest comes near.
    for (let k = 0; k < FOREST_KINDS.length; k++) this.model(k);
  }

  update(dt: number, cam: THREE.Camera): void {
    this.t += dt;
    const cp = cam.position;
    if (this.t - this.lastUpdate >= 0.25) {
      this.lastUpdate = this.t;
      this.updateTiles(cp);
    }
    // Near tier: full trees and the hulls of the nearest tiles follow the camera closely.
    if (cp.distanceTo(this.lastNear) > 4) this.refreshNear(cp);
  }

  // ------------------------------------------------------------ tiles

  private updateTiles(cp: THREE.Vector3): void {
    const camH = Math.max(0, cp.y);
    const leaves: { x0: number; z0: number; size: number; d: number }[] = [];
    const split = (x0: number, z0: number, size: number) => {
      const cx = Math.max(x0, Math.min(x0 + size, cp.x)), cz = Math.max(z0, Math.min(z0 + size, cp.z));
      const d = Math.hypot(cx - cp.x, cz - cp.z, camH);
      if (d > FAR_R) return;
      if (size > FOREST_DETAIL && d < size * 1.6) {
        const h = size / 2;
        split(x0, z0, h); split(x0 + h, z0, h); split(x0, z0 + h, h); split(x0 + h, z0 + h, h);
      } else leaves.push({ x0, z0, size, d });
    };
    for (let x = -this.ext; x < this.ext; x += TERRAIN_ROOT) for (let z = -this.ext; z < this.ext; z += TERRAIN_ROOT) split(x, z, TERRAIN_ROOT);
    const want = new Set<string>();
    let allReady = true;
    for (const L of leaves) {
      const key = `${L.x0},${L.z0},${L.size}`;
      want.add(key);
      let t = this.tiles.get(key);
      if (!t) {
        t = { key, x0: L.x0, z0: L.z0, size: L.size, status: 'loading', recs: null, clumps: null, used: this.t, bytes: 0 };
        this.tiles.set(key, t);
        this.request(t, 120 + L.d * 0.5);
      }
      t.used = this.t;
      if (t.status !== 'ready') allReady = false;
    }
    this.pool.reprioritise((m, cur) => {
      if (m.type !== 'forest') return cur;
      const key = `${m.x0},${m.z0},${m.size}`;
      if (!want.has(key)) { this.tiles.delete(key); return null; }
      const cx = Math.max(m.x0, Math.min(m.x0 + m.size, cp.x)), cz = Math.max(m.z0, Math.min(m.z0 + m.size, cp.z));
      return 120 + Math.hypot(cx - cp.x, cz - cp.z, camH) * 0.5;
    });
    // Swap the drawn set only when it is complete (no holes), like the terrain.
    if (allReady || !this.detailKey) {
      const detail: FTile[] = [];
      for (const L of leaves) {
        const t = this.tiles.get(`${L.x0},${L.z0},${L.size}`)!;
        if (t.status !== 'ready') continue;
        if (L.size <= FOREST_DETAIL && L.d < DETAIL_R) { detail.push(t); this.showClumps(t, false); }
        else this.showClumps(t, true);
      }
      for (const [key, t] of this.tiles) {
        if (want.has(key)) continue;
        this.showClumps(t, false);
        if (this.t - t.used > 15 && t.status === 'ready') this.dropTile(t);
      }
      const dk = detail.map((t) => t.key).join(';');
      if (dk !== this.detailKey) {
        this.detailKey = dk || '-';
        this.detail = detail;
        this.nearKey = '';
        this.refreshNear(cp);
      }
    }
    let trees = 0, clumps = 0, bytes = 0;
    for (const t of this.tiles.values()) {
      if (!t.recs) continue;
      if (t.size <= FOREST_DETAIL) trees += t.recs.length / FOREST_STRIDE;
      if (t.clumps) clumps += t.clumps.reduce((a, m) => a + m.count, 0);
      bytes += t.bytes;
    }
    for (const b of this.batches.values()) bytes += b.cap * 64 * b.meshes.length;
    this.stats.tiles = this.tiles.size;
    this.stats.trees = trees;
    this.stats.clumps = clumps;
    this.stats.bytes = bytes;
  }

  private request(t: FTile, priority: number): void {
    this.pool.run<Extract<FromWorker, { type: 'forest' }>>({ type: 'forest', job: 0, x0: t.x0, z0: t.z0, size: t.size }, priority).then(
      (r) => {
        if (this.tiles.get(t.key) !== t) return;
        t.recs = r.trees;
        t.bytes = r.trees.byteLength;
        t.status = 'ready';
        // Clumps right away (hidden): results arrive spread over frames, the swap stays cheap.
        hitch.measure('country:clumps', () => this.buildClumps(t));
      },
      () => { if (this.tiles.get(t.key) === t) this.tiles.delete(t.key); },
    );
  }

  private dropTile(t: FTile): void {
    if (t.clumps) for (const m of t.clumps) { this.group.remove(m); m.dispose(); }
    this.tiles.delete(t.key);
  }

  /** Canopy clumps of a tile: one instanced mesh for broadleaves, one for conifers. */
  private showClumps(t: FTile, on: boolean): void {
    if (!on) { if (t.clumps) for (const m of t.clumps) m.visible = false; return; }
    if (!t.clumps) this.buildClumps(t);
    for (const m of t.clumps!) m.visible = true;
  }

  private buildClumps(t: FTile): void {
    const R = t.recs!, n = R.length / FOREST_STRIDE;
    const counts = [0, 0];
    for (let i = 0; i < n; i++) counts[FOREST_KINDS[R[i * FOREST_STRIDE + 5]].conifer ? 1 : 0]++;
    t.clumps = [];
    for (let k = 0; k < 2; k++) {
      if (!counts[k]) continue;
      const im = new THREE.InstancedMesh(this.clumpGeo[k], this.clumpMat, counts[k]);
      im.castShadow = false;
      im.receiveShadow = true;
      let c = 0;
      for (let i = 0; i < n; i++) {
        const o = i * FOREST_STRIDE;
        const K = FOREST_KINDS[R[o + 5]];
        if ((K.conifer ? 1 : 0) !== k) continue;
        const sc = R[o + 3], spread = R[o + 6];
        const rh = K.crown * sc * Math.max(1, spread * 0.85), ht = K.height * sc * (1 + Math.min(0.4, (spread - 1) * 0.04));
        _q.setFromAxisAngle(_up, R[o + 4]);
        _m.compose(_p.set(R[o], R[o + 1], R[o + 2]), _q, _s.set(rh, ht, rh));
        im.setMatrixAt(c, _m);
        // Colour: per kind with a little variation (linear).
        const v = 0.82 + 0.36 * hashToFloat(hash32((R[o] * 7.3 + R[o + 2] * 3.1) | 0));
        if (K.conifer) _c.setRGB(0.028 * v, 0.06 * v, 0.024 * v);
        else if (K.species === 'birch') _c.setRGB(0.07 * v, 0.11 * v, 0.03 * v);
        else _c.setRGB(0.045 * v, 0.08 * v, 0.022 * v);
        im.setColorAt(c, _c);
        c++;
      }
      im.computeBoundingSphere();
      im.visible = false;
      im.name = 'clumps';
      t.clumps.push(im);
      t.bytes += counts[k] * (64 + 12);
      this.group.add(im);
    }
  }

  // ------------------------------------------------------------ detail tiers

  private model(kind: number): TreeModel {
    const K = FOREST_KINDS[kind];
    return K.species === 'shrub' ? shrubModel(K.variant) : treeModel(K.species as TreeSpecies, K.variant);
  }

  private batch(key: string, cap: number): Batch {
    let b = this.batches.get(key);
    if (b && b.cap >= cap) return b;
    if (b) for (const m of b.meshes) { this.group.remove(m); m.dispose(); }
    const tier = key[0], kind = Number(key.slice(2));
    const K = FOREST_KINDS[kind];
    const m = this.model(kind);
    const meshes: THREE.InstancedMesh[] = [];
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, shadow: boolean) => {
      const g = new THREE.BufferGeometry();
      for (const n of Object.keys(geo.attributes)) g.setAttribute(n, geo.attributes[n]);
      g.setIndex(geo.index);
      const im = new THREE.InstancedMesh(g, mat, cap);
      im.count = 0;
      im.frustumCulled = false;
      im.receiveShadow = true;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (shadow) applyVegetationShadow(im);
      im.castShadow = shadow;
      meshes.push(im);
      this.group.add(im);
    };
    if (tier === 'h' || tier === 'f') mk(m.far, this.farMat, false);
    else {
      const lk = K.species === 'shrub' ? 'shrub' : K.species;
      let lm = this.leafMats.get(lk);
      if (!lm) { lm = createLeafMaterial(K.species === 'shrub' ? undefined : (K.species as TreeSpecies)); this.leafMats.set(lk, lm); }
      mk(m.wood, this.bark, tier === 's');
      mk(m.leaves, lm, tier === 's');
    }
    b = { meshes, cap };
    this.batches.set(key, b);
    return b;
  }

  /**
   * Detail tiles touching the near range: full trees (shadowed nearest) and hulls beyond NEAR,
   * every few metres. The other detail tiles' hulls change only with the tile set.
   */
  private refreshNear(cp: THREE.Vector3): void {
    this.lastNear.copy(cp);
    const nearTiles: FTile[] = [], farTiles: FTile[] = [];
    for (const t of this.detail) {
      const cx = Math.max(t.x0, Math.min(t.x0 + t.size, cp.x)), cz = Math.max(t.z0, Math.min(t.z0 + t.size, cp.z));
      (Math.hypot(cx - cp.x, cz - cp.z) < NEAR + 10 ? nearTiles : farTiles).push(t);
    }
    const groups = new Map<string, number[]>();
    const push = (k: string, o: number, R: Float32Array) => { let l = groups.get(k); if (!l) groups.set(k, (l = [])); l.push(R[o], R[o + 1], R[o + 2], R[o + 3], R[o + 4]); };
    let full = 0, hull = 0;
    for (const t of nearTiles) {
      const R = t.recs!;
      for (let o = 0; o < R.length; o += FOREST_STRIDE) {
        const d = Math.hypot(R[o] - cp.x, R[o + 2] - cp.z);
        const kind = R[o + 5];
        if (d < NEAR) { push((d < SHADOW ? 's:' : 'm:') + kind, o, R); full++; } else { push('h:' + kind, o, R); hull++; }
      }
    }
    this.fill(groups, (k) => k[0] !== 'f');
    const nk = farTiles.map((t) => t.key).join(';');
    if (nk !== this.nearKey) {
      this.nearKey = nk;
      const fg = new Map<string, number[]>();
      for (const t of farTiles) {
        const R = t.recs!;
        for (let o = 0; o < R.length; o += FOREST_STRIDE) {
          let l = fg.get('f:' + R[o + 5]);
          if (!l) fg.set('f:' + R[o + 5], (l = []));
          l.push(R[o], R[o + 1], R[o + 2], R[o + 3], R[o + 4]);
        }
      }
      this.fill(fg, (k) => k[0] === 'f');
    }
    let fh = 0;
    for (const [k, b] of this.batches) if (k[0] === 'f') fh += b.meshes[0].count;
    this.stats.drawnFull = full;
    this.stats.drawnHull = hull + fh;
  }

  private fill(groups: Map<string, number[]>, owns: (k: string) => boolean): void {
    for (const [k, b] of this.batches) if (owns(k) && !groups.has(k)) for (const m of b.meshes) m.count = 0;
    for (const [k, L] of groups) {
      const n = L.length / 5;
      const b = this.batch(k, batchCap(n));
      for (let i = 0; i < n; i++) {
        _q.setFromAxisAngle(_up, L[i * 5 + 4]);
        _m.compose(_p.set(L[i * 5], L[i * 5 + 1], L[i * 5 + 2]), _q, _s.setScalar(L[i * 5 + 3]));
        for (const m of b.meshes) m.setMatrixAt(i, _m);
      }
      for (const m of b.meshes) { m.count = n; m.instanceMatrix.needsUpdate = true; }
    }
  }

  // ------------------------------------------------------------ queries

  /** Tree trunks overlapping a box, for player collision (shrubs are walk-through). */
  obstaclesIn(x0: number, z0: number, x1: number, z1: number, out: (o: Obstacle) => void): void {
    for (const t of this.detail) {
      if (t.x0 > x1 + 2 || t.x0 + t.size < x0 - 2 || t.z0 > z1 + 2 || t.z0 + t.size < z0 - 2) continue;
      const R = t.recs!;
      for (let o = 0; o < R.length; o += FOREST_STRIDE) {
        const x = R[o], z = R[o + 2];
        if (x < x0 - 1 || x > x1 + 1 || z < z0 - 1 || z > z1 + 1) continue;
        const K = FOREST_KINDS[R[o + 5]];
        if (K.species === 'shrub') continue;
        const sc = R[o + 3];
        out({ cyl: true, x, z, r: Math.max(0.15, 0.3 * sc), hx: 0, hz: 0, ux: 1, uz: 0, y0: R[o + 1], y1: R[o + 1] + K.height * sc });
      }
    }
  }

  /** One tiny mesh per material for background shader compilation (not added to the scene). */
  warmupObject(): THREE.Object3D {
    const g = new THREE.Group();
    const geo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    const im = new THREE.InstancedMesh(this.clumpGeo[0], this.clumpMat, 1);
    im.setColorAt(0, _c.setRGB(0.1, 0.2, 0.1));
    g.add(im);
    for (const K of FOREST_KINDS) {
      const lk = K.species === 'shrub' ? 'shrub' : K.species;
      if (!this.leafMats.has(lk)) this.leafMats.set(lk, createLeafMaterial(K.species === 'shrub' ? undefined : (K.species as TreeSpecies)));
    }
    for (const m of [this.bark, this.farMat, ...this.leafMats.values()]) {
      const w = new THREE.InstancedMesh(geo, m, 1);
      if (m !== this.farMat) applyVegetationShadow(w);
      g.add(w);
    }
    return g;
  }
}

/** Unit canopy clump: a rounded crown (broadleaf) or a cone (conifer), base at y = 0, top at 1. */
function clumpGeometry(conifer: boolean): THREE.BufferGeometry {
  const g = conifer ? new THREE.ConeGeometry(1, 0.85, 7, 1, true) : new THREE.IcosahedronGeometry(1, 0);
  const P = g.getAttribute('position') as THREE.BufferAttribute;
  const N = new Float32Array(P.count * 3);
  for (let i = 0; i < P.count; i++) {
    let x = P.getX(i), y = P.getY(i), z = P.getZ(i);
    if (conifer) {
      y += 0.425 + 0.15; // base at 0.15 (bare trunks below), tip at 1
      const l = Math.hypot(x, z) || 1;
      N.set([(x / l) * 0.8, 0.6, (z / l) * 0.8], i * 3);
    } else {
      const l = Math.hypot(x, y, z) || 1;
      N.set([x / l, y / l, z / l], i * 3);
      // Crown from 30% of the height to the top, slightly flattened underneath.
      y = 0.65 + y * (y < 0 ? 0.3 : 0.35);
    }
    P.setXYZ(i, x, y, z);
  }
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.deleteAttribute('uv');
  return g;
}

/** Clump material: instance colour, darker towards the base of the crown. */
function createClumpMaterial(): THREE.MeshStandardMaterial {
  if (WEBGPU) return gpuKit().createClumpNodeMaterial() as unknown as THREE.MeshStandardMaterial;
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vClumpY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvClumpY = position.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vClumpY;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(0.5, 1.1, smoothstep(0.2, 1.0, vClumpY));');
  };
  m.customProgramCacheKey = () => 'clump-v1';
  return m;
}
