/**
 * Building destruction.
 *
 *  - Impacts (punches, bodies, falling chunks, blasts) break wall panels whose
 *    strength is exceeded. Broken panels vanish from the static mesh (element
 *    state texture) and turn into debris fragments, chips and dust.
 *  - After damage a building's structure is checked floor by floor: when a
 *    storey loses too much of its load-bearing perimeter (or a whole side),
 *    everything above fails.
 *  - Failure is animated cheaply and deterministically: symmetric damage →
 *    progressive "pancake" collapse that eats one storey after another;
 *    asymmetric damage → the upper part topples around the damaged side.
 *    Collapsing parts are split off as their own mesh (same material, own
 *    element texture), shed debris as they go and leave a rubble mound.
 *  - Collapses hit their surroundings (neighbouring panels, props, people).
 */
import * as THREE from 'three';
import { toGeometry, type CityStreamer, type CellState } from '../stream/CityStreamer';
import { MeshBuilder } from '../build/meshBuilder';
import { buildBuildingShell, facadeSpecs } from '../build/buildingShell';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { WorldIndex, BuildingRef } from '../world/WorldIndex';
import { buildingLayout, gridPoint, type BuildingLayout, type Panel, type FloorInfo } from '../build/buildingLayout';
import type { Terrain } from '../world/terrain';
import type { Debris } from './Debris';
import type { Dust } from './Dust';
import { createFacadeMaterial, createElemDepthMaterial } from '../render/materials/facade';
import type { TextureLibrary } from '../render/TextureLibrary';
import { polyCentroid, polyArea, minAreaRect } from '../core/geom2';
import { MinHeap } from '../core/heap';
import { WallMat } from '../plan/building';

/** Impulse (N·s) needed to break a panel per m² by wall material. */
const STRENGTH: Record<number, number> = {
  [WallMat.GlassCurtain]: 900, [WallMat.MetalPanel]: 4000, [WallMat.WoodSiding]: 3500, [WallMat.Timber]: 5000,
  [WallMat.Plaster]: 9000, [WallMat.Stucco]: 9000, [WallMat.BrickRed]: 14000, [WallMat.BrickBrown]: 14000,
  [WallMat.BrickYellow]: 14000, [WallMat.BrickWhite]: 14000, [WallMat.Brownstone]: 18000, [WallMat.Limestone]: 20000,
  [WallMat.Sandstone]: 18000, [WallMat.Granite]: 24000, [WallMat.Concrete]: 26000, [WallMat.ConcretePanel]: 24000,
};
/** Glass alone breaks much more easily (windows shatter before walls). */
const GLASS_IMPULSE = 120;

export interface ImpactEvent {
  x: number; y: number; z: number;
  energy: number;
  kind: 'glass' | 'wall' | 'collapse' | 'blast' | 'stomp';
}

interface Collapse {
  ref: BuildingRef;
  layout: BuildingLayout;
  mesh: THREE.Mesh;
  elemData: Uint8Array;
  elemTex: THREE.DataTexture;
  fromFloor: number;
  mode: 'pancake' | 'topple';
  t: number;
  drop: number;
  vel: number;
  angle: number;
  angVel: number;
  hingeX: number; hingeZ: number; axisX: number; axisZ: number;
  eaten: number;
  done: boolean;
  dustT: number;
  height: number;
  baseY: number;
  centroid: [number, number];
  radius: number;
  layer: number;
  tint: THREE.Color;
}

export interface RubbleMound { x: number; z: number; r: number; h: number; y: number }

export class Destruction {
  readonly group = new THREE.Group();
  private layouts = new Map<string, BuildingLayout>();
  private collapses: Collapse[] = [];
  private pendingChecks = new Set<BuildingRef>();
  /**
   * Destruction work queue: impacts and structural failures only decide what breaks; the
   * breaking itself (element update, debris, dust, follow-up checks) runs from here on a
   * per-frame time budget, nearest first, so cascades play out over time instead of
   * freezing the game.
   */
  private jobs: Job[] = [];
  private jobHeap = new MinHeap();
  private freeJobs: number[] = [];
  /** Elements queued to break (key as in `broken`). */
  private doomed = new Set<number>();
  private pendingByRef = new Map<BuildingRef, number>();
  private collapseQ: { ref: BuildingRef; L: BuildingLayout; from: number; asym: { x: number; z: number } }[] = [];
  private lastCollapse = -10;
  private clock = 0;
  /** Queued jobs (HUD / tests). */
  get backlog(): number { return this.jobHeap.size; }
  /** Slab tiles that broke or fell (key: cell id * 2^24 + element). */
  private broken = new Set<number>();
  /** Elements hidden by an open interior (still structurally present). Set by Interiors. */
  interiorHidden: ((cs: CellState, e: number) => boolean) | null = null;
  /** Wall panels near each slab tile (per building, per floor), for the support check. */
  private tileWalls = new WeakMap<BuildingRef, Map<number, number[][]>>();
  readonly mounds: RubbleMound[] = [];
  private moundMesh: THREE.InstancedMesh;
  onImpact?: (e: ImpactEvent) => void;

  constructor(
    private streamer: CityStreamer,
    private world: WorldIndex,
    private terrain: Terrain,
    private debris: Debris,
    private dust: Dust,
    private tex: TextureLibrary,
  ) {
    // Rubble mounds: a lumpy dome, instanced.
    const g = new THREE.SphereGeometry(1, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const n = 1 + 0.18 * Math.sin(x * 9.1 + z * 4.3) * Math.cos(z * 7.7 - x * 3.1) + 0.08 * Math.sin(x * 23 + z * 19);
      pos.setXYZ(i, x * n, y * (0.85 + 0.3 * n) - 0.05, z * n);
    }
    g.computeVertexNormals();
    const m = new THREE.MeshStandardMaterial({ color: 0x8a8279, roughness: 1, flatShading: false });
    this.moundMesh = new THREE.InstancedMesh(g, m, 400);
    this.moundMesh.count = 0;
    this.moundMesh.receiveShadow = true;
    this.moundMesh.castShadow = true;
    this.moundMesh.frustumCulled = false;
    this.group.add(this.moundMesh);
  }

  layoutOf(ref: BuildingRef): BuildingLayout {
    const key = `${ref.cell.id}:${ref.index}`;
    let L = this.layouts.get(key);
    if (!L) {
      L = buildingLayout(ref.desc, this.terrain, ref.elemBase);
      this.layouts.set(key, L);
    }
    return L;
  }

  /**
   * The storey slabs of a building. Cells stream without them (they are most of a tower's
   * triangles and only show through broken walls); they are built here the first time the
   * building is damaged, in the cell's facade material so element states apply.
   */
  private ensureSlabs(ref: BuildingRef): THREE.Mesh | null {
    const cs = ref.cell;
    const name = 'slabs:' + ref.index;
    const have = cs.group.getObjectByName(name) as THREE.Mesh | undefined;
    if (have) return have;
    const facade = cs.group.children.find((o) => o.name === 'facade') as THREE.Mesh | undefined;
    if (!facade || !cs.facadeMat) return null;
    const mb = new MeshBuilder(facadeSpecs());
    mb.setOrigin(facade.position.x, facade.position.y, facade.position.z);
    buildBuildingShell(mb, ref.desc, ref.elemBase, this.terrain, 0, 'slabs');
    if (mb.empty) return null;
    const data = mb.build();
    const mesh = new THREE.Mesh(toGeometry(data), cs.facadeMat);
    mesh.position.set(...data.origin);
    mesh.customDepthMaterial = facade.customDepthMaterial;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = name;
    cs.group.add(mesh);
    this.streamer.account(cs, mesh.geometry);
    return mesh;
  }

  /** Rubble height at (x,z) (for walking on it), 0 if none. */
  rubbleHeight(x: number, z: number): number {
    let h = -Infinity;
    for (const m of this.mounds) {
      const d = Math.hypot(x - m.x, z - m.z) / m.r;
      if (d < 1) h = Math.max(h, m.y + m.h * Math.sqrt(1 - d * d));
    }
    return h;
  }

  /**
   * Apply an impact: impulse (N·s) delivered at a point within radius, from direction (dx,dy,dz).
   * Returns the number of panels broken.
   */
  impact(x: number, y: number, z: number, radius: number, impulse: number, dx: number, dy: number, dz: number, kind: ImpactEvent['kind'] = 'wall'): number {
    const refs = this.world.buildingsIn(x - radius - 2, z - radius - 2, x + radius + 2, z + radius + 2);
    let broken = 0;
    let glassBroken = 0;
    for (const ref of refs) {
      if (!ref.alive) continue;
      if (y + radius < ref.low || y - radius > ref.top + 3) continue;
      const cs = ref.cell;
      const L = this.layoutOf(ref);
      for (const p of L.panels) {
        if (!this.streamer.isAlive(cs, p.e) || this.doomed.has(cs.id * 16777216 + p.e)) continue;
        // Distance from the impact to the panel rectangle.
        const d = distToPanel(p, x, y, z);
        if (d > radius) continue;
        const fall = 1 - (d / Math.max(0.01, radius)) * 0.7;
        const w = Math.hypot(p.bx - p.ax, p.bz - p.az), h = p.y1 - p.y0;
        const area = w * h;
        const strength = (STRENGTH[ref.desc.wall] ?? 14000) * area;
        const j = impulse * fall;
        if (j > strength) {
          // Breaks spread outwards from the impact like a shock (nearest first).
          const pc = Math.hypot((p.ax + p.bx) / 2 - x, (p.y0 + p.y1) / 2 - y, (p.az + p.bz) / 2 - z);
          this.enqueue({ kind: 'panel', ref, panel: p, fl: null, c: 0, dx, dy, dz, power: Math.min(30, j / Math.max(1, strength) * 3) }, pc / WAVE_SPEED);
          broken++;
        } else if (j > GLASS_IMPULSE * area * 0.3 && ref.desc.style !== 'garage') {
          // Window glass shatters even when the wall holds.
          glassBroken++;
          const cx = (p.ax + p.bx) / 2, cz = (p.az + p.bz) / 2, cy = (p.y0 + p.y1) / 2;
          this.debris.chipBurst(cx + p.nx * 0.2, cy, cz + p.nz * 0.2, 6, 3, p.nx, 0, p.nz, new THREE.Color(0.75, 0.85, 0.9), 0.05, 2.5);
          this.streamer.setOpen(cs, p.e, 1, true);
        }
      }
      // Slab tiles in reach (floors and ceilings seen through the blast).
      for (const fl of L.floors) {
        if (fl.f === 0 || Math.abs(fl.y0 - y) > radius) continue;
        const g = L.tiers[fl.tier].grid;
        const ddx = x - g.cx, ddz = z - g.cz;
        const iu = (ddx * g.ux + ddz * g.uz - g.u0) / g.size, iv = (-ddx * g.uz + ddz * g.ux - g.v0) / g.size;
        const rr = radius / g.size + 1;
        const i0 = Math.max(0, Math.floor(iu - rr)), i1 = Math.min(g.nu - 1, Math.floor(iu + rr));
        const j0 = Math.max(0, Math.floor(iv - rr)), j1 = Math.min(g.nv - 1, Math.floor(iv + rr));
        for (let ii = i0; ii <= i1; ii++) for (let jj = j0; jj <= j1; jj++) {
          const c = ii * g.nv + jj;
          const e = fl.tiles[c];
          if (e < 0 || !this.solid(cs, e)) continue;
          const [tx, tz] = this.tileCenter(g, c);
          const d = Math.max(0, Math.hypot(tx - x, tz - z) - g.size * 0.6, Math.abs(fl.y0 - y) - 0.2);
          if (d > radius) continue;
          const area = g.size * g.size;
          const j = impulse * (1 - (d / Math.max(0.01, radius)) * 0.7);
          if (j > SLAB_STRENGTH * area) {
            this.enqueue({ kind: 'tile', ref, panel: null, fl, c, dx, dy, dz, power: Math.min(20, j / (SLAB_STRENGTH * area) * 2) }, Math.hypot(tx - x, fl.y0 - y, tz - z) / WAVE_SPEED);
            broken++;
          }
        }
      }
      if (broken) this.pendingChecks.add(ref);
    }
    if (broken || glassBroken) this.onImpact?.({ x, y, z, energy: impulse, kind: broken ? kind : 'glass' });
    return broken;
  }

  private breakPanel(ref: BuildingRef, p: Panel, dx: number, dy: number, dz: number, power: number): void {
    const cs = ref.cell;
    this.ensureSlabs(ref);
    this.streamer.setElement(cs, p.e, false);
    const w = Math.hypot(p.bx - p.ax, p.bz - p.az), h = p.y1 - p.y0;
    const tint = new THREE.Color(0.85, 0.82, 0.78);
    const layer = ref.desc.wall;
    // Fragments: about one per 1.5 m², sized to fill the panel.
    const n = Math.max(2, Math.min(10, Math.round((w * h) / 1.6)));
    const s = Math.sqrt((w * h) / n) * 0.9;
    for (let k = 0; k < n; k++) {
      const t = Math.random(), u = Math.random();
      const x = p.ax + (p.bx - p.ax) * t, z = p.az + (p.bz - p.az) * t, y = p.y0 + h * u;
      const sp = 1 + power * (0.3 + Math.random() * 0.7);
      // Pushed inward along the impact, with some outward spall.
      this.debris.spawn(x, y, z, s * (0.6 + Math.random() * 0.6), s * (0.4 + Math.random() * 0.5), 0.25 + Math.random() * 0.15,
        dx * sp + (Math.random() - 0.5) * 2, dy * sp + Math.random() * 1.5, dz * sp + (Math.random() - 0.5) * 2, layer, tint);
    }
    const cx = (p.ax + p.bx) / 2, cz = (p.az + p.bz) / 2, cy = (p.y0 + p.y1) / 2;
    this.debris.chipBurst(cx, cy, cz, 14, 4 + power * 0.3, dx, dy, dz, new THREE.Color(0.6, 0.57, 0.53), 0.08, 3);
    if (ref.desc.wall !== WallMat.GlassCurtain) this.debris.chipBurst(cx + p.nx * 0.3, cy, cz + p.nz * 0.3, 10, 3, p.nx, 0.2, p.nz, new THREE.Color(0.75, 0.85, 0.9), 0.05, 2.5);
    this.dust.burst(cx, cy, cz, 6, Math.max(w, h) * 0.4, 1.5 + power * 0.1, 1.8, 5, new THREE.Color(0.62, 0.6, 0.56), 0.3, 0.45);
    // The building is open now: show its real interior through the windows.
    this.streamer.setOpen(cs, p.e, 1, true);
  }

  /** Run pending structural checks (call each frame; cheap). */
  update(dt: number): void {
    this.clock += dt;
    const t0 = performance.now();
    // 1. Due breaks, nearest/earliest first, within the frame budget.
    let n = 0;
    while (this.jobHeap.size && this.jobHeap.peekPriority() <= this.clock && n < MAX_JOBS_PER_FRAME && performance.now() - t0 < BUDGET_MS) {
      const id = this.jobHeap.pop();
      const j = this.jobs[id];
      this.freeJobs.push(id);
      this.runJob(j);
      n++;
    }
    // 2. Structural checks of buildings whose queued breaks are done (a few per frame).
    let checks = 0;
    for (const ref of this.pendingChecks) {
      if ((this.pendingByRef.get(ref) ?? 0) > 0) continue;
      if (checks >= 2 || performance.now() - t0 > BUDGET_MS * 1.5) break;
      this.pendingChecks.delete(ref);
      this.checkStructure(ref);
      checks++;
    }
    // 3. Collapses start one at a time (geometry extraction is heavy).
    if (this.collapseQ.length && this.clock - this.lastCollapse > 0.4) {
      const q = this.collapseQ.shift()!;
      if (q.ref.alive) { this.lastCollapse = this.clock; this.startCollapse(q.ref, q.L, q.from, q.asym); }
    }
    for (const c of this.collapses) if (!c.done) this.stepCollapse(c, dt);
    for (let i = this.collapses.length - 1; i >= 0; i--) {
      const c = this.collapses[i];
      if (c.done) {
        this.group.remove(c.mesh);
        c.mesh.geometry.dispose();
        (c.mesh.material as THREE.Material).dispose();
        c.elemTex.dispose();
        this.collapses.splice(i, 1);
      }
    }
  }

  private checkStructure(ref: BuildingRef): void {
    if (!ref.alive) return;
    const L = this.layoutOf(ref);
    const cs = ref.cell;
    this.checkSlabs(ref, L);
    let failFloor = -1;
    let asym = { x: 0, z: 0 };
    for (const fl of L.floors) {
      let alive = 0, run = 0, worstRun = 0, firstRun = -1, total = 0;
      let dx = 0, dz = 0;
      const perim: number[] = [];
      for (let k = fl.panelStart; k < fl.panelStart + fl.panelCount; k++) {
        const p = L.panels[k];
        const w = Math.hypot(p.bx - p.ax, p.bz - p.az);
        perim.push(w);
        total += w;
        if (this.streamer.isAlive(cs, p.e)) {
          alive += w;
          if (firstRun < 0) firstRun = run;
          worstRun = Math.max(worstRun, run);
          run = 0;
        } else {
          run += w;
          dx += ((p.ax + p.bx) / 2 - L.centroid[0]) * w;
          dz += ((p.az + p.bz) / 2 - L.centroid[1]) * w;
        }
      }
      // Wrap-around run (end + start of the ring).
      worstRun = Math.max(worstRun, run + Math.max(0, firstRun));
      const ratio = alive / Math.max(1e-6, total);
      if (ratio < 0.5 || worstRun > total * 0.42) {
        failFloor = fl.f;
        asym = { x: dx, z: dz };
        break;
      }
    }
    if (failFloor < 0) return;
    if (!this.collapseQ.some((q) => q.ref === ref)) this.collapseQ.push({ ref, L, from: failFloor, asym });
  }

  // ------------------------------------------------------------ work queue

  /** Run `fn` later from the destruction queue (inside the frame budget). */
  private later(delay: number, fn: () => void): void {
    const id = this.freeJobs.length ? this.freeJobs.pop()! : this.jobs.length;
    this.jobs[id] = { kind: 'fn', ref: null, fn, panel: null, fl: null, c: 0, dx: 0, dy: 0, dz: 0, power: 0, key: -1 };
    this.jobHeap.push(this.clock + delay, id);
  }

  private enqueue(j: Omit<Job, 'key'>, delay: number): void {
    const ref = j.ref!;
    const e = j.kind === 'panel' ? j.panel!.e : j.fl!.tiles[j.c];
    const key = ref.cell.id * 16777216 + e;
    if (this.doomed.has(key)) return;
    this.doomed.add(key);
    const job: Job = { ...j, key };
    const id = this.freeJobs.length ? this.freeJobs.pop()! : this.jobs.length;
    this.jobs[id] = job;
    this.jobHeap.push(this.clock + delay + Math.random() * 0.04, id);
    this.pendingByRef.set(ref, (this.pendingByRef.get(ref) ?? 0) + 1);
  }

  private runJob(j: Job): void {
    if (j.kind === 'fn') { j.fn!(); return; }
    const ref = j.ref!;
    this.doomed.delete(j.key);
    const left = (this.pendingByRef.get(ref) ?? 1) - 1;
    if (left > 0) this.pendingByRef.set(ref, left); else this.pendingByRef.delete(ref);
    if (!ref.alive || ref.cell.status !== 'ready') return;
    const cs = ref.cell;
    if (j.kind === 'panel') {
      if (!this.streamer.isAlive(cs, j.panel!.e)) return;
      this.breakPanel(ref, j.panel!, j.dx, j.dy, j.dz, j.power);
    } else {
      const e = j.fl!.tiles[j.c];
      if (this.broken.has(j.key) || !(this.streamer.isAlive(cs, e) || this.interiorHidden?.(cs, e))) return;
      this.breakTile(ref, this.layoutOf(ref), j.fl!, j.c, j.dx, j.dy, j.dz, j.power);
    }
    this.pendingChecks.add(ref);
  }

  // ------------------------------------------------------------ slab tiles

  /** Structurally present: alive, or only hidden by an open interior (and not broken). */
  private solid(cs: CellState, e: number): boolean {
    const key = cs.id * 16777216 + e;
    if (this.broken.has(key) || this.doomed.has(key)) return false;
    return this.streamer.isAlive(cs, e) || !!this.interiorHidden?.(cs, e);
  }

  isBroken(cs: CellState, e: number): boolean { return this.broken.has(cs.id * 16777216 + e); }

  private tileCenter(g: BuildingLayout['tiers'][number]['grid'], c: number): [number, number] {
    const i = Math.floor(c / g.nv), j = c % g.nv;
    return gridPoint(g, g.u0 + (i + 0.5) * g.size, g.v0 + (j + 0.5) * g.size);
  }

  /**
   * Slab tiles stand if an intact wall runs beside them (this storey or the one below), if
   * they sit on an interior column (every third tile, standing on the slab below), or if a
   * supported tile is at most two tiles away. Everything else falls. Bottom-up, so a falling
   * column tile takes the ones above with it in the same pass.
   */
  private checkSlabs(ref: BuildingRef, L: BuildingLayout): void {
    const cs = ref.cell;
    const walls = this.wallsNearTiles(ref, L);
    for (const fl of L.floors) {
      if (fl.f === 0) continue;
      const g = L.tiers[fl.tier].grid, T = fl.tiles, n = T.length;
      const dist = new Int32Array(n).fill(99);
      const queue: number[] = [];
      const below = L.floors.find((x) => x.f === fl.f - 1);
      const wl = walls.get(fl.f)!;
      for (let c = 0; c < n; c++) {
        if (T[c] < 0 || !this.solid(cs, T[c])) continue;
        let ok = wl[c].some((e) => this.solid(cs, e));
        const i = Math.floor(c / g.nv), j = c % g.nv;
        if (!ok && i % 3 === 1 && j % 3 === 1 && below) {
          // Column: the slab tile directly below must still be there (ground floor: always).
          if (below.f === 0) ok = true;
          else {
            const bg = L.tiers[below.tier].grid;
            const [cx, cz] = this.tileCenter(g, c);
            const bi = gridCellOf(bg, cx, cz);
            ok = bi >= 0 && below.tiles[bi] >= 0 && this.solid(cs, below.tiles[bi]);
          }
        }
        if (ok) { dist[c] = 0; queue.push(c); }
      }
      // Spread support up to two tiles through intact neighbours.
      while (queue.length) {
        const c = queue.shift()!;
        if (dist[c] >= 2) continue;
        const i = Math.floor(c / g.nv), j = c % g.nv;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= g.nu || nj >= g.nv) continue;
          const nc = ni * g.nv + nj;
          if (T[nc] < 0 || dist[nc] <= dist[c] + 1 || !this.solid(cs, T[nc])) continue;
          dist[nc] = dist[c] + 1;
          queue.push(nc);
        }
      }
      for (let c = 0; c < n; c++) {
        if (T[c] < 0 || dist[c] !== 99 || !this.solid(cs, T[c])) continue;
        // Unsupported slabs sag and let go one after another, not all in the same instant.
        this.enqueue({ kind: 'tile', ref, panel: null, fl, c, dx: 0, dy: -1, dz: 0, power: 0 }, 0.15 + Math.random() * 0.9);
      }
    }
  }

  /** Per floor and tile: wall panels of that storey and the one below beside the tile. */
  private wallsNearTiles(ref: BuildingRef, L: BuildingLayout): Map<number, number[][]> {
    let m = this.tileWalls.get(ref);
    if (m) return m;
    m = new Map();
    for (const fl of L.floors) {
      const g = L.tiers[fl.tier].grid;
      const lists: number[][] = [];
      // Panels of this storey and the one below are contiguous ranges of the panel list.
      const cand: Panel[] = [];
      for (const q of L.floors) if (q.f === fl.f || q.f === fl.f - 1) for (let k = q.panelStart; k < q.panelStart + q.panelCount; k++) cand.push(L.panels[k]);
      for (let c = 0; c < fl.tiles.length; c++) {
        const out: number[] = [];
        if (fl.tiles[c] >= 0) {
          const [tx, tz] = this.tileCenter(g, c);
          const reach = g.size * 0.5 + 1.2;
          for (const p of cand) if (distSeg(tx, tz, p.ax, p.az, p.bx, p.bz) < reach) out.push(p.e);
        }
        lists.push(out);
      }
      m.set(fl.f, lists);
    }
    this.tileWalls.set(ref, m);
    return m;
  }

  private breakTile(ref: BuildingRef, L: BuildingLayout, fl: FloorInfo, c: number, dx: number, dy: number, dz: number, power: number): void {
    const cs = ref.cell, e = fl.tiles[c];
    this.broken.add(cs.id * 16777216 + e);
    this.streamer.setElement(cs, e, false);
    const g = L.tiers[fl.tier].grid;
    const [x, z] = this.tileCenter(g, c);
    const hs = g.size * 0.75;
    this.debris.release(x - hs, z - hs, x + hs, z + hs, fl.y0 - 0.6, fl.y0 + 4);
    const tint = new THREE.Color(0.8, 0.78, 0.74);
    // The slab breaks into a few heavy plates that drop (or fly, when blasted).
    const n = 3 + (power > 2 ? 2 : 0);
    for (let k = 0; k < n; k++) {
      const sz = g.size * (0.3 + Math.random() * 0.2);
      this.debris.spawn(x + (Math.random() - 0.5) * g.size * 0.6, fl.y0 - 0.1, z + (Math.random() - 0.5) * g.size * 0.6, sz, 0.22, sz * (0.7 + Math.random() * 0.3),
        dx * power + (Math.random() - 0.5) * 1.5, dy * power - 1, dz * power + (Math.random() - 0.5) * 1.5, 8, tint, 1.2);
    }
    this.debris.chipBurst(x, fl.y0, z, 12, 2 + power * 0.3, dx, dy - 0.5, dz, new THREE.Color(0.6, 0.58, 0.55), 0.08, 3);
    this.dust.burst(x, fl.y0, z, 5, g.size * 0.5, 1.2, 1.6, 5, new THREE.Color(0.62, 0.6, 0.56), 0.3, 0.45);
    this.onImpact?.({ x, y: fl.y0, z, energy: 2e5, kind: 'wall' });
  }

  private startCollapse(ref: BuildingRef, L: BuildingLayout, fromFloor: number, asym: { x: number; z: number }): void {
    const cs = ref.cell;
    const facade = cs.group.children.find((o) => o.name === 'facade') as THREE.Mesh | undefined;
    if (!facade) return;
    // Elements of the collapsing part.
    const set = new Set<number>();
    for (const fl of L.floors) {
      if (fl.f < fromFloor) continue;
      for (const t of fl.tiles) if (t >= 0) set.add(t);
      set.add(fl.slab);
      for (let k = fl.panelStart; k < fl.panelStart + fl.panelCount; k++) set.add(L.panels[k].e);
    }
    set.add(L.roof);
    // Extract geometry of those elements (shell, and the slabs if they were built).
    const slabs = this.ensureSlabs(ref);
    const parts = [extractElements(facade.geometry, set), slabs ? extractElements(slabs.geometry, set) : null].filter((g): g is THREE.BufferGeometry => !!g);
    if (!parts.length) return;
    const geo = parts.length > 1 ? mergeGeometries(parts) ?? parts[0] : parts[0];
    // Hide them in the static mesh; debris resting on the falling part comes down too.
    for (const e of set) this.streamer.setElement(cs, e, false);
    {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < ref.poly.length; i += 2) { x0 = Math.min(x0, ref.poly[i]); x1 = Math.max(x1, ref.poly[i]); z0 = Math.min(z0, ref.poly[i + 1]); z1 = Math.max(z1, ref.poly[i + 1]); }
      this.debris.release(x0 - 1, z0 - 1, x1 + 1, z1 + 1, L.base - 1, L.base + L.height + 6);
    }
    // Own element state for progressive eating.
    const w = 1024, h = Math.max(1, Math.ceil((L.elemBase + L.elemCount) / w));
    const data = new Uint8Array(w * h * 2).fill(255);
    // Show glass open (no fake rooms on a falling part).
    for (const e of set) data[e * 2 + 1] = 0;
    const tex = new THREE.DataTexture(data, w, h, THREE.RGFormat, THREE.UnsignedByteType);
    tex.needsUpdate = true;
    const mat = createFacadeMaterial(this.tex.facade, tex, w);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.customDepthMaterial = createElemDepthMaterial(tex, w);
    mesh.position.copy(facade.position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    const fl0 = L.floors.find((f) => f.f === fromFloor)!;
    const height = L.base + L.height - fl0.y0;
    const asymMag = Math.hypot(asym.x, asym.z);
    const area = Math.abs(polyArea(ref.poly));
    const rad = Math.sqrt(area / Math.PI);
    // Topple when the missing walls are concentrated on one side and the part is slender enough.
    const topple = asymMag > rad * 2.5 && height > rad * 0.8;
    const obb = minAreaRect(ref.poly);
    let ax = 0, az = 0, hx = L.centroid[0], hz = L.centroid[1];
    if (topple) {
      const nx = asym.x / asymMag, nz = asym.z / asymMag;
      // Hinge line: footprint edge on the damaged side; rotation axis perpendicular to the fall direction.
      const reach = Math.abs(nx * obb.ux + nz * obb.uz) * obb.hu + Math.abs(nx * -obb.uz + nz * obb.ux) * obb.hv;
      hx = L.centroid[0] + nx * reach; hz = L.centroid[1] + nz * reach;
      ax = -nz; az = nx;
    }
    const c: Collapse = {
      ref, layout: L, mesh, elemData: data, elemTex: tex, fromFloor, mode: topple ? 'topple' : 'pancake',
      t: 0, drop: 0, vel: 0, angle: 0.03, angVel: 0.18, hingeX: hx, hingeZ: hz, axisX: ax, axisZ: az, eaten: fromFloor,
      done: false, dustT: 0, height, baseY: fl0.y0, centroid: L.centroid, radius: rad,
      layer: ref.desc.wall, tint: new THREE.Color(0.85, 0.82, 0.78),
    };
    this.collapses.push(c);
    // If the whole building goes, it no longer blocks movement.
    if (fromFloor === 0) ref.alive = false;
    else ref.top = fl0.y0;
    {
      // Physics ground over the building had its roof in it: rebuild it, drop what rests there.
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < ref.poly.length; i += 2) { x0 = Math.min(x0, ref.poly[i]); x1 = Math.max(x1, ref.poly[i]); z0 = Math.min(z0, ref.poly[i + 1]); z1 = Math.max(z1, ref.poly[i + 1]); }
      this.debris.groundChanged(x0 - 1, z0 - 1, x1 + 1, z1 + 1, fl0.y0 - 1, L.base + L.height + 6);
    }
    this.onImpact?.({ x: L.centroid[0], y: fl0.y0, z: L.centroid[1], energy: area * height * 3000, kind: 'collapse' });
    // Initial dust ring at the failing storey.
    this.dust.burst(L.centroid[0], fl0.y0 + 2, L.centroid[1], 40, rad, 4, rad * 0.6 + 3, 9, new THREE.Color(0.66, 0.63, 0.58), 0.4, 0.5);
  }

  private stepCollapse(c: Collapse, dt: number): void {
    c.t += dt;
    const L = c.layout;
    const g = 9.81;
    c.dustT += dt;
    if (c.mode === 'pancake') {
      // Resisted fall: each storey crushed absorbs energy.
      c.vel += g * 0.62 * dt;
      c.drop += c.vel * dt;
      c.mesh.position.y = c.mesh.userData.y0 === undefined ? (c.mesh.userData.y0 = c.mesh.position.y) - c.drop : c.mesh.userData.y0 - c.drop;
      // Eat storeys whose bottom passed below the failure level.
      while (c.eaten < L.floors.length) {
        const fl = L.floors[c.eaten];
        const bottomNow = fl.y0 - c.drop;
        if (bottomNow > c.baseY + 0.3) break;
        this.eatFloor(c, fl.f, true);
        c.eaten++;
      }
      if (c.eaten >= L.floors.length) this.finishCollapse(c);
    } else {
      // Rigid toppling about the hinge: alpha = (m g r sinθ) / I, I ≈ m (h²/3).
      const r = c.height * 0.5;
      const I = (c.height * c.height) / 3 + c.radius * c.radius / 4;
      c.angVel += ((g * r * Math.sin(c.angle + 0.05)) / I) * dt;
      c.angle += c.angVel * dt;
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(c.axisX, 0, c.axisZ), c.angle);
      // Rotate around the hinge point (world) → mesh transform.
      const origin = c.mesh.userData.origin ?? (c.mesh.userData.origin = c.mesh.position.clone());
      const hinge = new THREE.Vector3(c.hingeX, c.baseY, c.hingeZ);
      const off = origin.clone().sub(hinge).applyQuaternion(q).add(hinge);
      c.mesh.position.copy(off);
      c.mesh.quaternion.copy(q);
      // Shed debris from the crushed hinge zone.
      if (c.dustT > 0.15) {
        c.dustT = 0;
        this.dust.burst(c.hingeX, c.baseY + 1, c.hingeZ, 3, 3, 2, 3, 5, new THREE.Color(0.6, 0.58, 0.55), 0.3, 0.4);
      }
      // Impact: the top has swung down to the ground (or ~75°).
      if (c.angle > 1.3 || c.angle * c.height > c.height * 1.25) this.shatterToppled(c, q, hinge);
    }
  }

  /** Remove one storey from a falling part and turn it into debris + dust. */
  private eatFloor(c: Collapse, f: number, pancake: boolean): void {
    const L = c.layout;
    const fl = L.floors.find((x) => x.f === f);
    if (!fl) return;
    const set: number[] = [fl.slab, ...Array.from(fl.tiles).filter((t) => t >= 0)];
    for (let k = fl.panelStart; k < fl.panelStart + fl.panelCount; k++) set.push(L.panels[k].e);
    for (const e of set) c.elemData[e * 2] = 0;
    c.elemTex.needsUpdate = true;
    const y = c.baseY;
    const [cx, cz] = c.centroid;
    // Debris: some physical fragments, many chips, a dust puff.
    const nFrag = Math.min(14, 3 + Math.round(c.radius));
    for (let k = 0; k < nFrag; k++) {
      const p = L.panels[fl.panelStart + Math.floor(Math.random() * Math.max(1, fl.panelCount))];
      if (!p) continue;
      const t = Math.random();
      const x = p.ax + (p.bx - p.ax) * t, z = p.az + (p.bz - p.az) * t;
      const out = 2 + Math.random() * 5;
      this.debris.spawn(x, y + 1 + Math.random() * 2, z, 0.8 + Math.random() * 1.2, 0.4 + Math.random() * 0.8, 0.5 + Math.random(), p.nx * out, 1 + Math.random() * 2, p.nz * out, c.layer, c.tint);
    }
    this.debris.chipBurst(cx, y + 1, cz, 40, 6, 0, 0.2, 0, new THREE.Color(0.55, 0.53, 0.5), 0.12, 3);
    this.dust.burst(cx, y + 1, cz, pancake ? 18 : 10, c.radius * 1.1, 6 + c.radius * 0.2, c.radius * 0.4 + 4, 14, new THREE.Color(0.68, 0.65, 0.6), 0.25, 0.55);
    // Crush what is around the base.
    this.onImpact?.({ x: cx, y, z: cz, energy: c.radius * c.radius * 3.2 * 20000, kind: 'collapse' });
    // Neighbours get hit by outward-flying material (a moment later, from the queue).
    this.later(0.05, () => this.impact(cx, y + 2, cz, c.radius + 4, 2e5, 0, -1, 0, 'collapse'));
  }

  private shatterToppled(c: Collapse, q: THREE.Quaternion, hinge: THREE.Vector3): void {
    const L = c.layout;
    const dirX = c.hingeX - c.centroid[0], dirZ = c.hingeZ - c.centroid[1];
    const dl = Math.hypot(dirX, dirZ) || 1;
    const fx = dirX / dl, fz = dirZ / dl;
    const len = c.height;
    const total = Math.min(120, 20 + Math.round(len * c.radius * 0.15));
    const segs = Math.max(1, Math.ceil(len / 6));
    const per = Math.ceil(total / segs);
    this.onImpact?.({ x: c.hingeX + fx * len * 0.5, y: hinge.y, z: c.hingeZ + fz * len * 0.5, energy: L.height * c.radius * c.radius * 50000, kind: 'collapse' });
    // The impact sweeps along the fallen body from the hinge to the top (one segment per
    // queued job, so a tall tower lands over a fraction of a second instead of one frame).
    for (let k = 0; k < segs; k++) {
      const s0 = k * 6;
      this.later((s0 / Math.max(1, len)) * 0.6, () => {
        const sx = c.hingeX + fx * (s0 + 3), sz = c.hingeZ + fz * (s0 + 3);
        const ground = this.world.groundHeight(sx, sz);
        for (let m = 0; m < per; m++) {
          const s = s0 + Math.random() * 6;
          const x = c.hingeX + fx * s + (Math.random() - 0.5) * c.radius * 1.5;
          const z = c.hingeZ + fz * s + (Math.random() - 0.5) * c.radius * 1.5;
          const v = c.angVel * s;
          const sy = 0.5 + Math.random();
          // A few fly as rigid bodies; the rest is static rubble lying on the ground.
          const dyn = m < 4;
          this.debris.spawn(x, dyn ? ground + 1.5 + Math.random() * 3 : this.world.groundHeight(x, z) + sy * 0.35, z, 0.8 + Math.random() * 1.6, sy, 0.6 + Math.random(), fx * v * 0.3, -2, fz * v * 0.3, c.layer, c.tint, 3, dyn);
        }
        this.dust.burst(sx, ground + 2, sz, 6, c.radius, 8, c.radius * 0.5 + 4, 16, new THREE.Color(0.68, 0.65, 0.6), 0.25, 0.6);
        this.impact(sx, ground + 3, sz, c.radius + 2, 3e5, fx, -1, fz, 'collapse');
        if (s0 >= c.radius && (k % 2 === 0)) this.addMound(sx, sz, c.radius * 1.1, Math.min(6, c.radius * 0.5));
      });
    }
    void q;
    c.done = true;
  }


  private finishCollapse(c: Collapse): void {
    const [cx, cz] = c.centroid;
    const vol = Math.PI * c.radius * c.radius * c.height;
    // Rubble is ~15-25% of the building volume (buildings are mostly air).
    const h = Math.min(c.height * 0.3, Math.cbrt(vol * 0.18 / Math.PI) * 0.9);
    this.addMound(cx, cz, c.radius * 1.35, Math.max(1, h));
    this.dust.burst(cx, c.baseY + 3, cz, 60, c.radius * 1.5, 10 + c.radius * 0.3, c.radius * 0.8 + 6, 22, new THREE.Color(0.7, 0.67, 0.62), 0.2, 0.6);
    c.done = true;
  }

  private addMound(x: number, z: number, r: number, h: number): void {
    const y = this.terrain.height(x, z);
    this.mounds.push({ x, z, r, h, y });
    const i = this.moundMesh.count;
    if (i >= 400) return;
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * 6), new THREE.Vector3(r, h, r));
    this.moundMesh.setMatrixAt(i, m);
    this.moundMesh.count = i + 1;
    this.moundMesh.instanceMatrix.needsUpdate = true;
    // Scatter static debris on the mound for texture.
    for (let k = 0; k < Math.min(60, r * 4); k++) {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r * 0.95;
      const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
      const py = y + h * Math.sqrt(Math.max(0, 1 - (d / r) ** 2));
      this.debris.spawn(px, py, pz, 0.5 + Math.random() * 1.5, 0.3 + Math.random() * 0.6, 0.5 + Math.random(), 0, 0, 0, Math.floor(Math.random() * 16), new THREE.Color(0.8, 0.78, 0.74), 0, false);
    }
  }

  /** A load from above broke the slab or roof at height y: drop it (and check the structure). */
  crushAt(ref: BuildingRef, y: number): void {
    this.ensureSlabs(ref);
    const L = this.layoutOf(ref);
    const cs = ref.cell;
    if (Math.abs(L.base + L.height - y) < 0.8) this.streamer.setElement(cs, L.roof, false);
    for (const fl of L.floors) {
      if (Math.abs(fl.y0 - y) >= 0.8 || fl.f === 0) continue;
      for (const t of fl.tiles) if (t >= 0) { this.broken.add(cs.id * 16777216 + t); this.streamer.setElement(cs, t, false); }
    }
    this.debris.chipBurst(L.centroid[0], y, L.centroid[1], 30, 4, 0, -0.5, 0, new THREE.Color(0.6, 0.58, 0.55), 0.1, 3);
    this.pendingChecks.add(ref);
  }

  /** Is a building (index) visible as damaged? */
  isCollapsing(): boolean {
    return this.collapses.length > 0;
  }

  /** Remove everything bound to a cell (when evicted). */
  forgetCell(cs: CellState): void {
    for (const k of [...this.layouts.keys()]) if (k.startsWith(cs.id + ':')) this.layouts.delete(k);
  }
}

function distToPanel(p: Panel, x: number, y: number, z: number): number {
  const dx = p.bx - p.ax, dz = p.bz - p.az;
  const L2 = dx * dx + dz * dz;
  let t = L2 > 0 ? ((x - p.ax) * dx + (z - p.az) * dz) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = p.ax + dx * t, qz = p.az + dz * t;
  const qy = Math.max(p.y0, Math.min(p.y1, y));
  return Math.hypot(x - qx, y - qy, z - qz);
}

/** Copy the triangles whose vertices belong to the given element ids into a new geometry. */
function extractElements(src: THREE.BufferGeometry, elems: Set<number>): THREE.BufferGeometry | null {
  // Runs on the whole cell's facade mesh: typed arrays and flat lookup tables only.
  const idx = src.getIndex()!.array as ArrayLike<number>;
  const aElem = (src.getAttribute('aElem') as THREE.BufferAttribute).array as ArrayLike<number>;
  let maxE = 0;
  for (const e of elems) if (e > maxE) maxE = e;
  const want = new Uint8Array(maxE + 1);
  for (const e of elems) want[e] = 1;
  const vCount = (src.getAttribute('position') as THREE.BufferAttribute).count;
  const map = new Int32Array(vCount).fill(-1);
  const order: number[] = [];
  const outIdx: number[] = [];
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i];
    const e = Math.round(aElem[a]);
    if (e > maxE || !want[e]) continue;
    for (let k = 0; k < 3; k++) {
      const v = idx[i + k];
      let m = map[v];
      if (m < 0) { m = order.length; map[v] = m; order.push(v); }
      outIdx.push(m);
    }
  }
  if (!outIdx.length) return null;
  const g = new THREE.BufferGeometry();
  for (const name of Object.keys(src.attributes)) {
    const a = src.getAttribute(name) as THREE.BufferAttribute;
    const size = a.itemSize;
    const arr = a.array as unknown as Float32Array;
    const Arr = (arr as unknown as { constructor: new (n: number) => Float32Array }).constructor;
    const out = new Arr(order.length * size);
    for (let i = 0; i < order.length; i++) {
      const o = order[i] * size, d = i * size;
      for (let k = 0; k < size; k++) out[d + k] = arr[o + k];
    }
    g.setAttribute(name, new THREE.BufferAttribute(out, size, a.normalized));
  }
  g.setIndex(order.length < 65536 ? new THREE.BufferAttribute(Uint16Array.from(outIdx), 1) : new THREE.BufferAttribute(Uint32Array.from(outIdx), 1));
  g.computeBoundingSphere();
  return g;
}

export { polyCentroid };

const SLAB_STRENGTH = 26000; // N·s per m² of slab (reinforced concrete: tougher than walls)

function distSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

function gridCellOf(g: BuildingLayout['tiers'][number]['grid'], x: number, z: number): number {
  const dx = x - g.cx, dz = z - g.cz;
  const i = Math.floor((dx * g.ux + dz * g.uz - g.u0) / g.size), j = Math.floor((-dx * g.uz + dz * g.ux - g.v0) / g.size);
  return i < 0 || j < 0 || i >= g.nu || j >= g.nv ? -1 : i * g.nv + j;
}

/** Visual speed at which breaks spread from an impact (m/s). */
const WAVE_SPEED = 60;
const BUDGET_MS = 3;
const MAX_JOBS_PER_FRAME = 40;

interface Job {
  kind: 'panel' | 'tile' | 'fn';
  ref: BuildingRef | null;
  /** kind 'fn': deferred work (collapse aftermath), run like any other job. */
  fn?: () => void;
  panel: Panel | null;
  fl: FloorInfo | null;
  c: number;
  dx: number; dy: number; dz: number;
  power: number;
  key: number;
}
