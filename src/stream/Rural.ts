/**
 * The countryside's villages, farmsteads and roads around the camera, streamed in fixed tiles
 * from the city workers (build/rural). A tile holds the road ribbons, squares and yards running
 * through it and the buildings of the settlements centred in it: near tiles draw the full
 * building shells, the rest their simple far LOD, out to LOAD_R; roads fade out sooner.
 * The buildings share one facade material (no destruction state) and block the player.
 */
import * as THREE from 'three';
import { hitch } from '../debug/HitchLog';
import type { WorkerPool } from './WorkerPool';
import type { FromWorker } from './protocol';
import type { MeshData } from '../build/meshBuilder';
import { toGeometry } from './CityStreamer';
import { releaseAfterUpload } from '../render/gpuOnly';
import { createFacadeMaterial } from '../render/materials/facade';
import { createGroundMaterial } from '../render/materials/ground';
import type { TextureLibrary } from '../render/TextureLibrary';
import type { Obstacle } from '../world/Collision';
import { RURAL_OBST_STRIDE, ruralSurfaceAt } from '../build/rural';

const TILE = 1024;
/** Tiles nearer than this (3D distance to the tile, m) are loaded. */
const LOAD_R = 7000;
/** Full building shells within this distance of a tile (m, scaled by the graphics LOD setting). */
const NEAR = 420;
/** Roads, squares and yards within this distance. */
const GROUND_R = 5000;
/** Settlements reach this far beyond the tile holding their centre. */
const SPILL = 320;

interface RTile {
  key: string;
  x0: number; z0: number;
  status: 'loading' | 'ready';
  ground: THREE.Mesh | null;
  near: THREE.Mesh | null;
  far: THREE.Mesh | null;
  obst: Float32Array | null;
  surf: Float32Array | null;
  used: number;
}

export class RuralStreamer {
  readonly group = new THREE.Group();
  private tiles = new Map<string, RTile>();
  private facadeMat: THREE.MeshStandardMaterial;
  private groundMat: THREE.MeshStandardMaterial;
  private t = 0;
  private lastUpdate = -1;
  /** Facade LOD distance multiplier (graphics settings). */
  lodScale = 1;
  /** Async shader compile for new meshes (set by the game). */
  prepare: ((o: THREE.Object3D) => Promise<unknown>) | null = null;
  stats = { tiles: 0, buildings: 0, nearTiles: 0 };

  constructor(private pool: WorkerPool, private ext: number, tex: TextureLibrary) {
    this.group.name = 'rural';
    this.facadeMat = createFacadeMaterial(tex.facade, null);
    this.groundMat = createGroundMaterial(tex.ground);
    // Draped on the natural ground: stay on top of the (coarser, farther) terrain tiles.
    this.groundMat.polygonOffset = true;
    this.groundMat.polygonOffsetFactor = -1;
    this.groundMat.polygonOffsetUnits = -2;
  }

  update(_dt: number, cam: THREE.Vector3): void {
    this.t += _dt;
    if (this.t - this.lastUpdate < 0.25) return;
    this.lastUpdate = this.t;
    const camH = Math.max(0, cam.y);
    const dist = (x0: number, z0: number, m: number) => {
      const cx = Math.max(x0 - m, Math.min(x0 + TILE + m, cam.x)), cz = Math.max(z0 - m, Math.min(z0 + TILE + m, cam.z));
      return Math.hypot(cx - cam.x, cz - cam.z, camH);
    };
    const want = new Set<string>();
    const i0 = Math.max(-this.ext, Math.floor((cam.x - LOAD_R) / TILE) * TILE), i1 = Math.min(this.ext - TILE, Math.floor((cam.x + LOAD_R) / TILE) * TILE);
    const j0 = Math.max(-this.ext, Math.floor((cam.z - LOAD_R) / TILE) * TILE), j1 = Math.min(this.ext - TILE, Math.floor((cam.z + LOAD_R) / TILE) * TILE);
    let nearTiles = 0, buildings = 0;
    for (let x0 = i0; x0 <= i1; x0 += TILE) for (let z0 = j0; z0 <= j1; z0 += TILE) {
      const d = dist(x0, z0, SPILL);
      if (d > LOAD_R) continue;
      const key = `${x0},${z0}`;
      want.add(key);
      let t = this.tiles.get(key);
      if (!t) {
        t = { key, x0, z0, status: 'loading', ground: null, near: null, far: null, obst: null, surf: null, used: this.t };
        this.tiles.set(key, t);
        this.request(t, 130 + d * 0.5);
      }
      t.used = this.t;
      if (t.status !== 'ready') continue;
      const isNear = d < NEAR * this.lodScale;
      if (t.near) t.near.visible = isNear;
      if (t.far) t.far.visible = !isNear || !t.near;
      if (t.ground) t.ground.visible = dist(x0, z0, 0) < GROUND_R;
      if (isNear && t.near) nearTiles++;
      if (t.obst) buildings += t.obst.length / RURAL_OBST_STRIDE;
    }
    this.pool.reprioritise((m, cur) => {
      if (m.type !== 'rural') return cur;
      const key = `${m.x0},${m.z0}`;
      if (!want.has(key)) { this.tiles.delete(key); return null; }
      return 130 + dist(m.x0, m.z0, SPILL) * 0.5;
    });
    for (const [key, t] of this.tiles) {
      if (want.has(key)) continue;
      for (const m of [t.ground, t.near, t.far]) if (m) m.visible = false;
      if (this.t - t.used > 20 && t.status === 'ready') this.drop(t);
    }
    this.stats.tiles = this.tiles.size;
    this.stats.nearTiles = nearTiles;
    this.stats.buildings = buildings;
  }

  private request(t: RTile, priority: number): void {
    this.pool.run<Extract<FromWorker, { type: 'rural' }>>({ type: 'rural', job: 0, x0: t.x0, z0: t.z0, size: TILE }, priority).then(
      (r) => hitch.measure('rural:apply', () => {
        if (this.tiles.get(t.key) !== t) return;
        t.ground = this.mesh(r.ground, this.groundMat, 'ruralGround', false);
        t.near = this.mesh(r.facade, this.facadeMat, 'ruralNear', true);
        t.far = this.mesh(r.facadeLod, this.facadeMat, 'ruralFar', false);
        t.obst = r.obstacles;
        t.surf = r.surfaces;
        t.status = 'ready';
      }),
      () => { if (this.tiles.get(t.key) === t) this.tiles.delete(t.key); },
    );
  }

  private mesh(m: MeshData | null, mat: THREE.Material, name: string, shadow: boolean): THREE.Mesh | null {
    if (!m) return null;
    const mesh = new THREE.Mesh(toGeometry(m), mat);
    mesh.position.set(...m.origin);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.visible = false;
    mesh.name = name;
    releaseAfterUpload(mesh.geometry);
    this.group.add(mesh);
    void this.prepare?.(mesh);
    return mesh;
  }

  private drop(t: RTile): void {
    for (const m of [t.ground, t.near, t.far]) if (m) { this.group.remove(m); m.geometry.dispose(); }
    this.tiles.delete(t.key);
  }

  /** Building boxes overlapping a box, for player collision. */
  obstaclesIn(x0: number, z0: number, x1: number, z1: number, out: (o: Obstacle) => void): void {
    for (const t of this.tiles.values()) {
      const B = t.obst;
      if (!B || !B.length) continue;
      if (t.x0 - SPILL > x1 || t.x0 + TILE + SPILL < x0 || t.z0 - SPILL > z1 || t.z0 + TILE + SPILL < z0) continue;
      for (let o = 0; o < B.length; o += RURAL_OBST_STRIDE) {
        const r = B[o + 2] + B[o + 3];
        if (B[o] + r < x0 || B[o] - r > x1 || B[o + 1] + r < z0 || B[o + 1] - r > z1) continue;
        out({ cyl: false, x: B[o], z: B[o + 1], r: 0, hx: B[o + 2], hz: B[o + 3], ux: B[o + 4], uz: B[o + 5], y0: B[o + 6], y1: B[o + 7] });
      }
    }
  }

  /** Is (x, z) on a road, village square or farmyard of a loaded tile? */
  onSurface(x: number, z: number): boolean {
    for (const t of this.tiles.values()) {
      if (!t.surf?.length || x < t.x0 - SPILL || x > t.x0 + TILE + SPILL || z < t.z0 - SPILL || z > t.z0 + TILE + SPILL) continue;
      if (ruralSurfaceAt(t.surf, x, z)) return true;
    }
    return false;
  }

  /** One tiny mesh per material for background shader compilation (not added to the scene). */
  warmupObject(): THREE.Object3D {
    const g = new THREE.Group();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    for (const [n, s] of [['normal', 3], ['uv', 2], ['aLayer', 1], ['aTint', 3], ['aFacade', 4], ['aSeed', 1], ['aElem', 1]] as const) geo.setAttribute(n, new THREE.BufferAttribute(new Float32Array(3 * s), s));
    g.add(new THREE.Mesh(geo, this.facadeMat), new THREE.Mesh(geo, this.groundMat));
    return g;
  }
}
