/**
 * Streams the city around the camera: cell meshes (ground + buildings),
 * terrain quadtree tiles, water tiles, bridges and landmarks. Cells keep their damage
 * state (element texture) when evicted and reapply it when reloaded.
 */
import { hitch } from '../debug/HitchLog';
import * as THREE from 'three';
import type { MacroPlan } from '../plan/types';
import type { MeshData } from '../build/meshBuilder';
import type { CellPlan } from '../plan/cell';
import { WorkerPool } from './WorkerPool';
import { BINFO_STRIDE, type CellResult, type FromWorker } from './protocol';
import { createFacadeMaterial, createElemDepthMaterial } from '../render/materials/facade';
import { clearGlassMaterial, clearGlassElemMaterial } from '../render/materials/clearGlass';
import type { WreckGrid } from '../build/landmarkDice';
import type { Landmark } from '../plan/landmarks';
import type { BridgeGapSpec } from '../build/bridges';
import { createGroundMaterial, createTerrainMaterial, createWaterMaterial } from '../render/materials/ground';
import type { TextureLibrary } from '../render/TextureLibrary';
import { releaseAfterUpload, UploadPrimer } from '../render/gpuOnly';

export function toGeometry(m: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const k in m.attrs) {
    const a = m.attrs[k];
    g.setAttribute(k, new THREE.BufferAttribute(a.array, a.size, a.normalized));
  }
  g.setIndex(new THREE.BufferAttribute(m.index, 1));
  const [x0, y0, z0, x1, y1, z1] = m.bounds;
  g.boundingBox = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2);
  return g;
}

/** Bytes of a geometry's buffers (before upload). */
function geoBytes(g: THREE.BufferGeometry): number {
  let n = g.index ? g.index.array.byteLength : 0;
  for (const k in g.attributes) n += (g.attributes[k] as THREE.BufferAttribute).array.byteLength;
  return n;
}

export class CellState {
  id: number;
  status: 'loading' | 'ready' = 'loading';
  group = new THREE.Group();
  plan: CellPlan | null = null;
  binfo: Float32Array | null = null;
  elemCount = 0;
  elemW = 1;
  elemData: Uint8Array | null = null;
  elemTex: THREE.DataTexture | null = null;
  facadeMat: THREE.MeshStandardMaterial | null = null;
  lod0: THREE.Mesh | null = null;
  lod1: THREE.Mesh | null = null;
  /** Memory this cell holds (geometry + element state), for the streaming budget. */
  bytes = 0;
  lastWanted = 0;
  constructor(id: number) { this.id = id; }
}

interface Tile { key: string; x0: number; z0: number; size: number; mesh: THREE.Mesh | null; status: 'loading' | 'ready'; used: number }

/**
 * A breakable landmark as loaded (destruction/LandmarkWreck breaks it): its pieces (landmarkDice
 * table), their element state (shared by the near, far and glass meshes) and the meshes. The near
 * meshes keep their CPU geometry (falling parts are cut out of it).
 */
export interface LandmarkWreckData {
  index: number;
  lm: Landmark;
  grid: WreckGrid;
  pieces: Float32Array;
  elemData: Uint8Array;
  elemTex: THREE.DataTexture;
  elemW: number;
  near: THREE.Mesh;
  nearGlass: THREE.Mesh | null;
  facadeMat: THREE.MeshStandardMaterial;
  glassMat: THREE.Material | null;
}

export class CityStreamer {
  readonly root = new THREE.Group();
  readonly cells = new Map<number, CellState>();
  /** Damage state survives eviction: cell id → element alive bytes. */
  private savedElems = new Map<number, Uint8Array>();
  private groundMat: THREE.MeshStandardMaterial;
  private terrainMat: THREE.MeshStandardMaterial;
  private waterMat: THREE.MeshPhysicalMaterial;
  private tiles = new Map<string, Tile>();
  private waterTiles = new Map<string, Tile>();
  private visibleTiles = new Set<string>();
  private t = 0;
  private lastUpdate = -1;
  loadRadius = 1400;
  /**
   * Budget for detailed cells (CPU + GPU geometry). Dense big cities hit it long before the
   * load radius: the nearest cells win, the skyline covers the rest.
   */
  memoryBudget = 700e6;
  /** Facade LOD switch distance multiplier (graphics settings). */
  lodScale = 1;
  /** Uploads the cell meshes that are hidden at first (their CPU copies go once on the GPU). */
  readonly primer = new UploadPrimer();
  /** Bytes held by loaded cells. */
  bytesLoaded = 0;
  frame = 0;
  onCellReady?: (c: CellState) => void;
  /** Async shader compile for new meshes (set by the game). */
  prepare: ((o: THREE.Object3D) => Promise<unknown>) | null = null;
  onCellEvicted?: (c: CellState) => void;
  /** Breakable landmarks (filled by loadLandmarks). */
  readonly wrecks: LandmarkWreckData[] = [];
  /** The one mesh of all bridges (loadBridges), its geometry swapped by rebuildBridges. */
  private bridgeMesh: THREE.Mesh | null = null;
  private bridgeTicket = 0;
  /** Fallen spans the bridge mesh leaves out (also for a load still to come). */
  private bridgeGaps: BridgeGapSpec[] = [];

  constructor(readonly macro: MacroPlan, readonly pool: WorkerPool, readonly tex: TextureLibrary) {
    this.groundMat = createGroundMaterial(tex.ground);
    this.terrainMat = createTerrainMaterial(tex.ground, macro.seed);
    this.waterMat = createWaterMaterial();
    this.root.name = 'city';
  }

  async loadBridges(): Promise<void> {
    const r = await this.pool.run<Extract<FromWorker, { type: 'bridges' }>>({ type: 'bridges', job: 0, gaps: this.bridgeGaps }, -1);
    if (!r.mesh) return;
    const mat = createFacadeMaterial(this.tex.facade, null);
    const mesh = new THREE.Mesh(toGeometry(r.mesh), mat);
    mesh.position.set(...r.mesh.origin);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = 'bridges';
    this.root.add(mesh);
    this.bridgeMesh = mesh;
  }

  /**
   * Builds the bridges again with fallen spans left out (BridgeBreaks) and swaps the geometry of
   * the loaded mesh: same material, so no shader compiles. The newest request wins.
   */
  async rebuildBridges(gaps: BridgeGapSpec[]): Promise<void> {
    const ticket = ++this.bridgeTicket;
    this.bridgeGaps = gaps.map((g) => ({ edge: g.edge, s0: g.s0, s1: g.s1, seed: g.seed }));
    const r = await this.pool.run<Extract<FromWorker, { type: 'bridges' }>>({ type: 'bridges', job: 0, gaps: this.bridgeGaps }, -1);
    const mesh = this.bridgeMesh;
    if (ticket !== this.bridgeTicket || !mesh || !r.mesh) return;
    const old = mesh.geometry;
    mesh.geometry = toGeometry(r.mesh);
    mesh.position.set(...r.mesh.origin);
    old.dispose();
  }

  /**
   * Landmarks (town hall, stadium, attractions, airport): always present, one LOD object each
   * (near mesh with all details, far mesh without), sharing one facade material. Breakable ones
   * (the marvels) get their own element state and materials and keep the near geometry.
   */
  async loadLandmarks(): Promise<void> {
    if (!this.macro.landmarks?.length) return;
    const r = await this.pool.run<Extract<FromWorker, { type: 'landmarks' }>>({ type: 'landmarks', job: 0 }, -1);
    const shared = createFacadeMaterial(this.tex.facade, null);
    r.meshes.forEach(([near, far], i) => {
      const lm = this.macro.landmarks[i];
      const wr = r.wreck?.[i] ?? null;
      let mat: THREE.MeshStandardMaterial = shared, glassMat: THREE.Material = clearGlassMaterial(), depth: THREE.Material | undefined;
      let elem: { data: Uint8Array; tex: THREE.DataTexture; w: number } | null = null;
      if (wr) {
        const w = 1024, h = Math.max(1, Math.ceil((wr.pieces.length / 12 + 1) / w));
        const data = new Uint8Array(w * h * 2).fill(255);
        const tex = new THREE.DataTexture(data, w, h, THREE.RGFormat, THREE.UnsignedByteType);
        tex.needsUpdate = true;
        elem = { data, tex, w };
        mat = createFacadeMaterial(this.tex.facade, tex, w);
        depth = createElemDepthMaterial(tex, w);
        glassMat = clearGlassElemMaterial(tex, w);
      }
      // Switch to the far mesh a little beyond the site (the airport is kilometres long), and
      // not while one is up a tall one (LOD distances are measured to its foot).
      const switchAt = 450 + Math.max(Math.hypot(lm.hu, lm.hv) * 0.6, near.bounds[4] * 1.1);
      const add = (meshes: [MeshData, MeshData], m: THREE.Material, glass: boolean): THREE.Mesh => {
        const lod = new THREE.LOD();
        lod.name = `landmark:${lm.kind}${glass ? ':glass' : ''}`;
        // LOD distances are measured to the object's own position: put it at the landmark.
        lod.position.set(...meshes[0].origin);
        let first: THREE.Mesh | null = null;
        for (const [md, d] of [[meshes[0], 0], [meshes[1], switchAt]] as const) {
          const mesh = new THREE.Mesh(toGeometry(md), m);
          mesh.position.set(md.origin[0] - meshes[0].origin[0], md.origin[1] - meshes[0].origin[1], md.origin[2] - meshes[0].origin[2]);
          // (Clear glass casts no shadow and draws after the opaque world.)
          mesh.castShadow = !glass;
          mesh.receiveShadow = true;
          if (glass) mesh.renderOrder = 2;
          if (depth && !glass) mesh.customDepthMaterial = depth;
          // (The near mesh of a breakable one stays on the CPU too: falling parts are cut from it.)
          if (!(elem && d === 0)) releaseAfterUpload(mesh.geometry);
          lod.addLevel(mesh, d);
          first ??= mesh;
        }
        this.root.add(lod);
        return first!;
      };
      const nearMesh = add([near, far], mat, false);
      const g = r.glass[i];
      const nearGlass = g ? add(g, glassMat, true) : null;
      // The inside (a starship's great hall): drawn only close by, where one can see into it.
      const ins = r.inner?.[i];
      if (ins) {
        const reach = Math.hypot(lm.hu, lm.hv) * 0.6 + 120;
        ins.forEach((md, gi) => {
          if (!md) return;
          const lod = new THREE.LOD();
          lod.name = `landmark:${lm.kind}:inside${gi ? ':glass' : ''}`;
          lod.position.set(...md.origin);
          const mesh = new THREE.Mesh(toGeometry(md), gi ? glassMat : mat);
          mesh.castShadow = !gi;
          mesh.receiveShadow = true;
          if (gi) mesh.renderOrder = 2;
          else if (depth) mesh.customDepthMaterial = depth;
          releaseAfterUpload(mesh.geometry);
          lod.addLevel(mesh, 0);
          lod.addLevel(new THREE.Object3D(), reach);
          this.root.add(lod);
        });
      }
      if (wr && elem) {
        this.wrecks.push({
          index: i, lm, grid: wr.grid, pieces: wr.pieces, elemData: elem.data, elemTex: elem.tex, elemW: elem.w,
          near: nearMesh, nearGlass, facadeMat: mat, glassMat: g ? glassMat : null,
        });
      }
    });
  }

  update(dt: number, cam: THREE.Vector3): void {
    this.primer.settle();
    this.updateCells(dt, cam);
    this.primer.prime((m) => { const id = m.parent?.userData.cell as number | undefined; return id !== undefined && this.cells.get(id)?.group === m.parent; });
  }

  private updateCells(dt: number, cam: THREE.Vector3): void {
    this.t += dt;
    this.frame++;
    if (this.t - this.lastUpdate < 0.25) return;
    this.lastUpdate = this.t;
    const now = this.t;
    // --- cells
    const R = this.loadRadius + Math.min(600, Math.max(0, cam.y) * 2);
    let wanted: { id: number; d: number }[] = [];
    for (const c of this.macro.cells) {
      const d = Math.max(0, Math.hypot(c.centroid[0] - cam.x, c.centroid[1] - cam.z) - c.radius);
      if (d < R) wanted.push({ id: c.id, d });
    }
    wanted.sort((a, b) => a.d - b.d);
    // Memory budget: nearest first; unknown cells count as the average loaded cell (before any
    // has arrived, as a dense one: underestimating made the first wave of a big city overshoot).
    let ready = 0, readyBytes = 0;
    for (const cs of this.cells.values()) if (cs.status === 'ready') { ready++; readyBytes += cs.bytes; }
    const avg = ready >= 4 ? readyBytes / ready : Math.max(30e6, ready ? readyBytes / ready : 0);
    let acc = 0, keep = 0;
    for (const w of wanted) {
      const cs = this.cells.get(w.id);
      acc += cs && cs.status === 'ready' ? cs.bytes : avg;
      if (acc > this.memoryBudget && keep > 4) break;
      keep++;
    }
    wanted = wanted.slice(0, keep);
    for (const w of wanted) {
      let cs = this.cells.get(w.id);
      if (!cs) {
        cs = new CellState(w.id);
        this.cells.set(w.id, cs);
        this.requestCell(cs, w.d);
      }
      cs.lastWanted = now;
    }
    for (const [id, cs] of this.cells) {
      if (now - cs.lastWanted > 3 && cs.status === 'ready') this.evict(cs);
      else if (now - cs.lastWanted > 3 && cs.status === 'loading') { /* will be dropped on arrival */ void id; }
    }
    this.pool.reprioritise((m, cur) => {
      if (m.type !== 'cell') return cur;
      // Not wanted any more (the player moved on): cancel instead of building it for nothing.
      const st = this.cells.get(m.cell);
      if (!st || now - st.lastWanted > 1) return null;
      const c = this.macro.cells[m.cell];
      return Math.hypot(c.centroid[0] - cam.x, c.centroid[1] - cam.z);
    });
    // --- facade LOD per cell
    for (const cs of this.cells.values()) {
      if (cs.status !== 'ready' || !cs.lod0 || !cs.lod1) continue;
      const c = this.macro.cells[cs.id];
      const d = Math.max(0, Math.hypot(c.centroid[0] - cam.x, c.centroid[1] - cam.z) - c.radius);
      const far = d > ((cs.lod1.visible ? 380 : 420) + Math.max(0, cam.y) * 0.5) * this.lodScale;
      cs.lod0.visible = !far;
      cs.lod1.visible = far;
    }
    // --- terrain quadtree
    this.updateTerrain(cam);
  }

  private requestCell(cs: CellState, priority: number): void {
    this.pool.run<CellResult>({ type: 'cell', job: 0, cell: cs.id }, priority).then(
      (r) => hitch.measure('cell:apply', () => this.onCell(cs, r)),
      () => { this.cells.delete(cs.id); },
    );
  }

  private onCell(cs: CellState, r: CellResult): void {
    if (this.cells.get(cs.id) !== cs || this.t - cs.lastWanted > 3) { this.cells.delete(cs.id); return; }
    cs.plan = r.plan;
    cs.binfo = r.binfo;
    cs.elemCount = r.elemCount;
    // Element state texture.
    const w = 1024;
    const h = Math.max(1, Math.ceil(Math.max(1, r.elemCount) / w));
    const saved = this.savedElems.get(cs.id);
    const data = saved && saved.length === w * h * 2 ? saved : new Uint8Array(w * h * 2).fill(255);
    const tex = new THREE.DataTexture(data, w, h, THREE.RGFormat, THREE.UnsignedByteType);
    tex.needsUpdate = true;
    cs.elemData = data;
    cs.elemTex = tex;
    cs.elemW = w;
    const ground = new THREE.Mesh(toGeometry(r.ground), this.groundMat);
    ground.position.set(...r.ground.origin);
    ground.receiveShadow = true;
    ground.name = 'ground';
    cs.facadeMat = createFacadeMaterial(this.tex.facade, tex, w);
    const facade = new THREE.Mesh(toGeometry(r.facade), cs.facadeMat);
    facade.position.set(...r.facade.origin);
    facade.castShadow = true;
    facade.receiveShadow = true;
    facade.customDepthMaterial = createElemDepthMaterial(tex, w);
    facade.name = 'facade';
    const lod = new THREE.Mesh(toGeometry(r.facadeLod), cs.facadeMat);
    lod.position.set(...r.facadeLod.origin);
    lod.castShadow = true;
    lod.receiveShadow = true;
    lod.customDepthMaterial = facade.customDepthMaterial;
    lod.name = 'facadeLod';
    lod.visible = false;
    cs.lod0 = facade;
    cs.lod1 = lod;
    cs.bytes = geoBytes(ground.geometry) * 2 + geoBytes(facade.geometry) * 2 + geoBytes(lod.geometry) + data.byteLength;
    this.bytesLoaded += cs.bytes;
    // Cell meshes are never read back on the CPU: keep only the GPU copy. (Collapses rebuild the
    // one building's shell to cut the falling part from, Destruction.shellOf; the detailed facade's
    // CPU copy was about half of all city memory.)
    releaseAfterUpload(ground.geometry);
    releaseAfterUpload(facade.geometry);
    releaseAfterUpload(lod.geometry);
    this.primer.add(facade);
    this.primer.add(lod);
    cs.group.add(ground, facade, lod);
    cs.group.userData.cell = cs.id;
    this.root.add(cs.group);
    cs.status = 'ready';
    hitch.note(`cell ${cs.id} ready (${((r.facade.index?.length ?? 0) / 3000).toFixed(0)}k facade tris, ${r.elemCount} elems)`);
    this.onCellReady?.(cs);
  }

  private evict(cs: CellState): void {
    if (cs.elemData) {
      let damaged = false;
      for (let i = 0; i < cs.elemCount; i++) if (cs.elemData[i * 2] < 255) { damaged = true; break; }
      if (damaged) this.savedElems.set(cs.id, cs.elemData);
    }
    this.onCellEvicted?.(cs);
    this.bytesLoaded -= cs.bytes;
    this.root.remove(cs.group);
    cs.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose(); });
    cs.facadeMat?.dispose();
    (cs.lod0 as THREE.Mesh | undefined)?.customDepthMaterial?.dispose();
    cs.elemTex?.dispose();
    this.cells.delete(cs.id);
  }

  /** Geometry added to a loaded cell later (e.g. a damaged building's slabs) counts toward the budget. */
  account(cs: CellState, g: THREE.BufferGeometry): void {
    const b = geoBytes(g) * 2;
    cs.bytes += b;
    this.bytesLoaded += b;
  }

  /** Mark an element dead/alive in a cell (destruction). */
  setElement(cs: CellState, elem: number, alive: boolean): void {
    if (!cs.elemData || !cs.elemTex) return;
    cs.elemData[elem * 2] = alive ? 255 : 0;
    cs.elemTex.needsUpdate = true;
  }

  /** Open (real interior visible through glass) or close the windows of an element range. */
  setOpen(cs: CellState, e0: number, count: number, open: boolean): void {
    if (!cs.elemData || !cs.elemTex) return;
    for (let e = e0; e < e0 + count; e++) cs.elemData[e * 2 + 1] = open ? 0 : 255;
    cs.elemTex.needsUpdate = true;
  }

  /**
   * Saves: element state of every cell that has some (loaded cells and evicted damaged ones):
   * cell id → [element count, interleaved bytes (alive, closed) per element].
   */
  elementStates(): Map<number, { count: number; data: Uint8Array; cell: CellState | null }> {
    const out = new Map<number, { count: number; data: Uint8Array; cell: CellState | null }>();
    for (const [id, data] of this.savedElems) if (!this.cells.get(id)?.elemData) out.set(id, { count: data.length / 2, data, cell: null });
    for (const cs of this.cells.values()) if (cs.status === 'ready' && cs.elemData) out.set(cs.id, { count: cs.elemCount, data: cs.elemData, cell: cs });
    return out;
  }

  /**
   * Saves: put saved element bytes back — into a loaded cell at once (element count must match),
   * else kept for when it streams in (like damage that survived eviction).
   */
  restoreElements(id: number, count: number, apply: (data: Uint8Array) => void): boolean {
    const cs = this.cells.get(id);
    if (cs && cs.status === 'ready' && cs.elemData && cs.elemTex) {
      if (cs.elemCount !== count) return false;
      apply(cs.elemData);
      cs.elemTex.needsUpdate = true;
      return true;
    }
    const w = 1024, h = Math.max(1, Math.ceil(Math.max(1, count) / w));
    const data = this.savedElems.get(id) ?? new Uint8Array(w * h * 2).fill(255);
    if (data.length !== w * h * 2) return false;
    apply(data);
    this.savedElems.set(id, data);
    return true;
  }

  isAlive(cs: CellState, elem: number): boolean {
    return !!cs.elemData && cs.elemData[elem * 2] > 127;
  }

  buildingInfo(cs: CellState, b: number): { base: number; height: number; elemBase: number; elemCount: number; cx: number; cz: number; rad: number; low: number } | null {
    if (!cs.binfo) return null;
    const o = b * BINFO_STRIDE;
    const f = cs.binfo;
    return { base: f[o], height: f[o + 1], elemBase: f[o + 2], elemCount: f[o + 3], cx: f[o + 4], cz: f[o + 5], rad: f[o + 6], low: f[o + 7] };
  }

  // ------------------------------------------------------------ terrain

  private updateTerrain(cam: THREE.Vector3): void {
    const ROOT = 8192, MIN = 256;
    const ext = Math.ceil((this.macro.boundary.reduce((a, b) => Math.max(a, b), 0) * 1.6 + 6000) / ROOT) * ROOT;
    const leaves: { x0: number; z0: number; size: number }[] = [];
    const camH = Math.max(0, cam.y);
    const split = (x0: number, z0: number, size: number) => {
      const cx = Math.max(x0, Math.min(x0 + size, cam.x)), cz = Math.max(z0, Math.min(z0 + size, cam.z));
      const d = Math.hypot(cx - cam.x, cz - cam.z, camH);
      if (size > MIN && d < size * 1.6) {
        const h = size / 2;
        split(x0, z0, h); split(x0 + h, z0, h); split(x0, z0 + h, h); split(x0 + h, z0 + h, h);
      } else leaves.push({ x0, z0, size });
    };
    for (let x = -ext; x < ext; x += ROOT) for (let z = -ext; z < ext; z += ROOT) split(x, z, ROOT);
    const want = new Set<string>();
    let allReady = true;
    for (const L of leaves) {
      const key = `${L.x0},${L.z0},${L.size}`;
      want.add(key);
      let t = this.tiles.get(key);
      if (!t) {
        t = { key, x0: L.x0, z0: L.z0, size: L.size, mesh: null, status: 'loading', used: this.t };
        this.tiles.set(key, t);
        const pri = 50 + Math.hypot(L.x0 + L.size / 2 - cam.x, L.z0 + L.size / 2 - cam.z) * 0.5;
        const tile = t;
        this.pool.run<Extract<FromWorker, { type: 'terrain' }>>({ type: 'terrain', job: 0, x0: L.x0, z0: L.z0, size: L.size, res: 40, skirt: Math.max(2, L.size / 40) }, pri).then((r) => hitch.measure('terrain:apply', () => {
          const mesh = new THREE.Mesh(toGeometry(r.mesh), this.terrainMat);
          mesh.position.set(...r.mesh.origin);
          mesh.receiveShadow = true;
          mesh.visible = false;
          mesh.name = 'terrain';
          tile.mesh = mesh;
          tile.status = 'ready';
          this.root.add(mesh);
          void this.prepare?.(mesh);
        }));
        // Water tile alongside (coarser tessellation, same key).
        const wt: Tile = { key, x0: L.x0, z0: L.z0, size: L.size, mesh: null, status: 'loading', used: this.t };
        this.waterTiles.set(key, wt);
        this.pool.run<Extract<FromWorker, { type: 'water' }>>({ type: 'water', job: 0, x0: L.x0, z0: L.z0, size: L.size }, pri + 1).then((r) => hitch.measure('water:apply', () => {
          wt.status = 'ready';
          if (!r.mesh) return;
          const mesh = new THREE.Mesh(toGeometry(r.mesh), this.waterMat);
          mesh.position.set(...r.mesh.origin);
          mesh.receiveShadow = true;
          mesh.visible = false;
          mesh.name = 'water';
          wt.mesh = mesh;
          this.root.add(mesh);
          void this.prepare?.(mesh);
        }));
      }
      t.used = this.t;
      if (t.status !== 'ready' || this.waterTiles.get(key)?.status !== 'ready') allReady = false;
    }
    // Swap visible set only when the new set is complete (no holes).
    if (allReady || this.visibleTiles.size === 0) {
      for (const [key, t] of this.tiles) {
        const vis = want.has(key);
        if (t.mesh) t.mesh.visible = vis;
        const w = this.waterTiles.get(key);
        if (w?.mesh) w.mesh.visible = vis;
      }
      this.visibleTiles = want;
      // Drop tiles unused for a while.
      for (const [key, t] of this.tiles) {
        if (!want.has(key) && this.t - t.used > 20 && t.status === 'ready') {
          if (t.mesh) { this.root.remove(t.mesh); t.mesh.geometry.dispose(); }
          const w = this.waterTiles.get(key);
          if (w?.mesh) { this.root.remove(w.mesh); w.mesh.geometry.dispose(); }
          this.tiles.delete(key);
          this.waterTiles.delete(key);
        }
      }
    }
  }
}
