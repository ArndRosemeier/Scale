/**
 * Breakable landmarks (the marvels). Their meshes come diced into pieces (build/landmarkDice: one
 * grid cell of geometry each, one element of the mesh), so they break like the city's buildings
 * but piece by piece instead of panel by panel:
 *
 *  - Impacts break the pieces whose strength (wall material × area, capped like a panel) they
 *    exceed; the breaks spread from the impact, shed debris, chips and dust.
 *  - When the breaks have settled the structure is checked: what no longer connects to the
 *    ground through standing pieces, or stands above a level that lost most of its pieces, fails.
 *  - Small loose bits shatter; larger parts are cut out of the mesh and fall: slender ones topple
 *    toward the damaged side (in the air they drop as they turn) and smash along the line they land
 *    on; squat ones come straight down, crushing what is under them, and pile up as rubble.
 *
 * Collision (world/LandmarkSolids) follows the broken pieces; saves keep them (game/save).
 */
import * as THREE from 'three';
import type { LandmarkWreckData } from '../stream/CityStreamer';
import { PIECE_STRIDE, gridKey, gridCells, type WreckGrid } from '../build/landmarkDice';
import type { Destruction } from './Destruction';
import { extractElements } from './extract';
import { createFacadeMaterial, createElemDepthMaterial } from '../render/materials/facade';
import { clearGlassElemMaterial } from '../render/materials/clearGlass';
import type { MaterialArrays } from '../render/TextureLibrary';
import { WALL_STRENGTH, GLASS_IMPULSE } from './wallStrength';
import { MinHeap } from '../core/heap';
import type { Debris } from './Debris';
import type { Dust } from './Dust';
import type { Terrain } from '../world/terrain';
import type { LandmarkSolids } from '../world/LandmarkSolids';

/** Breaks spread from an impact at this speed (m/s), like the buildings'. */
const WAVE_SPEED = 60;
const BUDGET_MS = 2.5;
const MAX_JOBS_PER_FRAME = 40;
/** A piece resists like a wall panel of at most this area (m²): big cells are not tougher, and a test blast (B) breaks concrete. */
const PANEL_AREA = 6;
/** A level that keeps less than this share of its pieces fails, with everything above it. */
const LEVEL_FAIL = 0.35;
/** Loose parts smaller than this (pieces) just shatter. */
const MIN_FALL = 10;
const DUST = new THREE.Color(0.68, 0.65, 0.6);
const CHIPS = new THREE.Color(0.6, 0.58, 0.55);
/** Colours of stained glass shards (a cathedral's windows). */
const STAINED = [[0.25, 0.4, 1.0], [1.0, 0.22, 0.2], [1.0, 0.78, 0.25], [0.3, 0.85, 0.4], [0.7, 0.3, 1.0]].map(([r, g, b]) => new THREE.Color(r, g, b));

interface Wreck {
  d: LandmarkWreckData;
  g: WreckGrid;
  n: number;
  T: Float32Array;
  ijk: Int32Array;
  /** Neighbours (26-neighbourhood) of each piece: nbr[nbrAt[p] .. nbrAt[p + 1]). */
  nbrAt: Int32Array;
  nbr: Int32Array;
  alive: Uint8Array;
  doomed: Uint8Array;
  grounded: Uint8Array;
  /** Window glass: breaks easily, holds nothing up, does not count toward its level. */
  pane: Uint8Array;
  levelTotal: Int32Array;
  levelAlive: Int32Array;
  /** Queued breaks not run yet. */
  pending: number;
  /** Structure check due (after the breaks settle). */
  dirty: boolean;
  checkAt: number;
  /** Pieces broken this frame (for collision and the physics ground). */
  fresh: number[];
  box: [number, number, number, number, number, number];
  /** World position of the near mesh (its geometry's origin). */
  origin: THREE.Vector3;
}

interface Fall {
  w: Wreck;
  pieces: number[];
  group: THREE.Group;
  meshes: THREE.Mesh[];
  data: Uint8Array;
  tex: THREE.DataTexture;
  mode: 'topple' | 'drop' | 'pancake';
  /** Lowest level, height, radius and centre of the part (world). */
  baseY: number; height: number; radius: number; cx: number; cz: number;
  /** Fall direction (topple), hinge on the ground plan, rotation axis. */
  fx: number; fz: number; hx: number; hz: number;
  angle: number; angVel: number;
  drop: number; vel: number;
  /** Pancake: levels eaten from the bottom; the level it rests on next (static pieces or ground). */
  eaten: number; levels: number[][]; restOn: number; restIsGround: boolean;
  dustT: number; t: number;
  layer: number;
  done: boolean;
  origin: THREE.Vector3;
}

interface Job { w: Wreck | null; p: number; dx: number; dy: number; dz: number; power: number; fn: (() => void) | null }

export class LandmarkWrecks {
  readonly group = new THREE.Group();
  readonly wrecks: Wreck[] = [];
  private falls: Fall[] = [];
  private jobs: Job[] = [];
  private free: number[] = [];
  private heap = new MinHeap();
  private clock = 0;
  private startQ: { w: Wreck; pieces: number[] }[] = [];
  private lastStart = -10;
  /** Of the pieces the last impact broke, how many were window glass. */
  lastPanes = 0;

  constructor(
    data: LandmarkWreckData[],
    private D: Destruction,
    private debris: Debris,
    private dust: Dust,
    private terrain: Terrain,
    private solids: LandmarkSolids | null,
    private facade: MaterialArrays,
  ) {
    this.group.name = 'landmark-wrecks';
    for (const d of data) this.wrecks.push(this.prepare(d));
  }

  private prepare(d: LandmarkWreckData): Wreck {
    const g = d.grid, T = d.pieces, n = T.length / PIECE_STRIDE, cells = gridCells(g);
    const ijk = new Int32Array(n * 3);
    const byKey = new Map<number, number>();
    const pane = new Uint8Array(n);
    const box: Wreck['box'] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let p = 0; p < n; p++) {
      const key = T[p * PIECE_STRIDE], cell = key % cells;
      byKey.set(key, p);
      if (key >= cells) pane[p] = 1;
      const i = cell % g.nu, r = Math.floor(cell / g.nu), j = r % g.nv, k = Math.floor(r / g.nv);
      ijk[p * 3] = i; ijk[p * 3 + 1] = j; ijk[p * 3 + 2] = k;
      for (let a = 0; a < 3; a++) { box[a] = Math.min(box[a], T[p * PIECE_STRIDE + 5 + a]); box[a + 3] = Math.max(box[a + 3], T[p * PIECE_STRIDE + 8 + a]); }
    }
    const nbrAt = new Int32Array(n + 1), list: number[] = [];
    for (let p = 0; p < n; p++) {
      nbrAt[p] = list.length;
      const i = ijk[p * 3], j = ijk[p * 3 + 1], k = ijk[p * 3 + 2];
      // (A cell's wall and glass pieces are neighbours of each other and of the cells around.)
      for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const a = i + di, b = j + dj, c = k + dk;
        if (a < 0 || b < 0 || c < 0 || a >= g.nu || b >= g.nv || c >= g.ny) continue;
        for (const off of [0, cells]) {
          const q = byKey.get(gridKey(g, a, b, c) + off);
          if (q !== undefined && q !== p) list.push(q);
        }
      }
    }
    nbrAt[n] = list.length;
    // Grounded: the piece's cell reaches down to the ground (or the landmark's platform).
    const grounded = new Uint8Array(n);
    const levelTotal = new Int32Array(g.ny);
    for (let p = 0; p < n; p++) {
      const o = p * PIECE_STRIDE, bottom = g.y0 + ijk[p * 3 + 2] * g.ch;
      if (pane[p]) continue;
      if (bottom <= Math.max(this.terrain.height(T[o + 2], T[o + 4]), d.lm.base) + 0.5) grounded[p] = 1;
      levelTotal[ijk[p * 3 + 2]]++;
    }
    const origin = new THREE.Vector3();
    d.near.getWorldPosition(origin);
    const w: Wreck = {
      d, g, n, T, ijk, nbrAt, nbr: Int32Array.from(list), alive: new Uint8Array(n).fill(1), doomed: new Uint8Array(n), grounded, pane,
      levelTotal, levelAlive: levelTotal.slice(), pending: 0, dirty: false, checkAt: 0, fresh: [], box, origin,
    };
    this.solids?.attachWreck(d.index, g, T, w.alive);
    return w;
  }

  /** Pieces standing (tests, HUD). */
  standing(index: number): number {
    const w = this.wrecks.find((x) => x.d.index === index);
    if (!w) return 0;
    let s = 0;
    for (let p = 0; p < w.n; p++) s += w.alive[p];
    return s;
  }

  get busy(): boolean { return this.falls.length > 0 || this.startQ.length > 0 || this.heap.size > 0; }

  // ------------------------------------------------------------ impacts

  /** An impact (as Destruction.impact): queues the pieces it breaks, returns how many. */
  impact(x: number, y: number, z: number, radius: number, impulse: number, dx: number, dy: number, dz: number): number {
    let broken = 0;
    this.lastPanes = 0;
    for (const w of this.wrecks) {
      const b = w.box;
      if (x + radius < b[0] || x - radius > b[3] || y + radius < b[1] || y - radius > b[4] || z + radius < b[2] || z - radius > b[5]) continue;
      const T = w.T;
      for (let p = 0; p < w.n; p++) {
        if (!w.alive[p] || w.doomed[p]) continue;
        const o = p * PIECE_STRIDE;
        const ex = Math.max(T[o + 5] - x, 0, x - T[o + 8]), ey = Math.max(T[o + 6] - y, 0, y - T[o + 9]), ez = Math.max(T[o + 7] - z, 0, z - T[o + 10]);
        const dd = Math.hypot(ex, ey, ez);
        if (dd > radius) continue;
        const j = impulse * (1 - (dd / Math.max(0.01, radius)) * 0.7);
        const strength = this.strength(w, p);
        if (j <= strength) continue;
        const dc = Math.hypot(T[o + 2] - x, T[o + 3] - y, T[o + 4] - z);
        w.doomed[p] = 1;
        w.pending++;
        this.push({ w, p, dx, dy, dz, power: Math.min(30, (j / strength) * 3), fn: null }, dc / WAVE_SPEED);
        broken++;
        this.lastPanes += w.pane[p];
      }
    }
    return broken;
  }

  private strength(w: Wreck, p: number): number {
    const o = p * PIECE_STRIDE, layer = w.T[o + 11];
    // (Window glass: like the buildings' panes, which shatter even when the wall holds.)
    if (w.pane[p]) return GLASS_IMPULSE * Math.max(1, w.T[o + 1]) * 0.3;
    return (WALL_STRENGTH[layer] ?? 14000) * Math.min(PANEL_AREA, Math.max(1, w.T[o + 1]));
  }

  private push(j: Job, delay: number): void {
    const id = this.free.length ? this.free.pop()! : this.jobs.length;
    this.jobs[id] = j;
    this.heap.push(this.clock + delay, id);
  }

  private later(delay: number, fn: () => void): void {
    this.push({ w: null, p: 0, dx: 0, dy: 0, dz: 0, power: 0, fn }, delay);
  }

  /** Take a piece out of the standing landmark (state, collision); `fx`: with debris and dust. */
  private kill(w: Wreck, p: number, fx: boolean, dx = 0, dy = 0, dz = 0, power = 1): void {
    if (!w.alive[p]) return;
    w.alive[p] = 0;
    w.doomed[p] = 0;
    w.d.elemData[(p + 1) * 2] = 0;
    w.d.elemTex.needsUpdate = true;
    if (!w.pane[p]) w.levelAlive[w.ijk[p * 3 + 2]]--;
    w.fresh.push(p);
    w.dirty = true;
    w.checkAt = this.clock + 0.25;
    if (!fx) return;
    const T = w.T, o = p * PIECE_STRIDE;
    const x = T[o + 2], y = T[o + 3], z = T[o + 4], area = T[o + 1], layer = T[o + 11];
    if (w.pane[p]) {
      // Stained glass: a burst of coloured shards, no rubble.
      for (let c = 0; c < 3; c++) this.debris.chipBurst(x, y, z, 8, 2.5 + power * 0.3, dx, dy, dz, STAINED[Math.floor(Math.random() * STAINED.length)], 0.05, 3);
      return;
    }
    const glass = layer === 10;
    const tint = glass ? new THREE.Color(0.75, 0.85, 0.9) : new THREE.Color(0.85, 0.82, 0.78);
    const nFrag = glass ? 0 : Math.max(1, Math.min(5, Math.round(area / 3)));
    const s = Math.min(2.2, Math.sqrt(area / Math.max(1, nFrag)) * 0.7);
    const hw = w.g.cs * 0.4, hh = w.g.ch * 0.4;
    for (let k = 0; k < nFrag; k++) {
      const sp = 1 + power * (0.3 + Math.random() * 0.7);
      this.debris.spawn(x + (Math.random() - 0.5) * hw, y + (Math.random() - 0.5) * hh, z + (Math.random() - 0.5) * hw,
        s * (0.6 + Math.random() * 0.6), s * (0.4 + Math.random() * 0.5), 0.3 + Math.random() * 0.3,
        dx * sp + (Math.random() - 0.5) * 3, dy * sp + Math.random() * 1.5, dz * sp + (Math.random() - 0.5) * 3, layer, tint);
    }
    this.debris.chipBurst(x, y, z, glass ? 16 : 10, 3 + power * 0.3, dx, dy, dz, glass ? tint : CHIPS, glass ? 0.05 : 0.08, 3);
    if (!glass) this.dust.burst(x, y, z, 4, Math.max(w.g.cs, w.g.ch) * 0.4, 1.5 + power * 0.1, 1.8, 5, DUST, 0.3, 0.45);
  }

  // ------------------------------------------------------------ frame

  update(dt: number): void {
    this.clock += dt;
    const t0 = performance.now();
    let n = 0;
    while (this.heap.size && this.heap.peekPriority() <= this.clock && n < MAX_JOBS_PER_FRAME && performance.now() - t0 < BUDGET_MS) {
      const id = this.heap.pop();
      const j = this.jobs[id];
      this.free.push(id);
      if (j.fn) j.fn();
      else if (j.w) {
        j.w.pending--;
        if (j.w.doomed[j.p]) this.kill(j.w, j.p, true, j.dx, j.dy, j.dz, j.power);
      }
      n++;
    }
    for (const w of this.wrecks) {
      if (w.fresh.length) this.flush(w);
      if (w.dirty && w.pending <= 0 && this.clock >= w.checkAt) {
        w.dirty = false;
        this.check(w, false);
      }
    }
    // Falling parts start one at a time (cutting them out of the mesh is the heavy part).
    if (this.startQ.length && this.clock - this.lastStart > 0.3) {
      const q = this.startQ.shift()!;
      this.lastStart = this.clock;
      this.startFall(q.w, q.pieces);
    }
    for (const f of this.falls) if (!f.done) this.stepFall(f, dt);
    for (let i = this.falls.length - 1; i >= 0; i--) {
      const f = this.falls[i];
      if (!f.done) continue;
      this.group.remove(f.group);
      for (const m of f.meshes) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
      f.tex.dispose();
      this.falls.splice(i, 1);
    }
  }

  /** Broken pieces this frame: collision and the physics ground over them. */
  private flush(w: Wreck): void {
    const T = w.T;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const p of w.fresh) {
      const o = p * PIECE_STRIDE;
      x0 = Math.min(x0, T[o + 5]); y0 = Math.min(y0, T[o + 6]); z0 = Math.min(z0, T[o + 7]);
      x1 = Math.max(x1, T[o + 8]); y1 = Math.max(y1, T[o + 9]); z1 = Math.max(z1, T[o + 10]);
    }
    this.solids?.piecesBroken(w.d.index, w.fresh);
    w.fresh.length = 0;
    this.debris.groundChanged(x0 - 1, z0 - 1, x1 + 1, z1 + 1, y0 - 1, y1 + 2);
  }

  // ------------------------------------------------------------ structure

  /**
   * What still stands: pieces connected to the ground through standing pieces, and not above a
   * level that lost most of its pieces. The rest fails: small loose bits shatter (or, quiet, are
   * just gone: restoring a save), larger connected parts fall.
   */
  private check(w: Wreck, quiet: boolean): void {
    const n = w.n, ijk = w.ijk;
    let failK = Infinity;
    for (let k = 0; k < w.g.ny; k++) {
      if (w.levelTotal[k] >= 6 && w.levelAlive[k] < w.levelTotal[k] * LEVEL_FAIL) { failK = k; break; }
    }
    const held = new Uint8Array(n), queue = new Int32Array(n);
    let qh = 0, qt = 0;
    for (let p = 0; p < n; p++) if (w.alive[p] && !w.doomed[p] && w.grounded[p] && ijk[p * 3 + 2] <= failK) { held[p] = 1; queue[qt++] = p; }
    while (qh < qt) {
      const p = queue[qh++];
      if (w.pane[p]) continue; // (glass holds nothing up)
      for (let e = w.nbrAt[p]; e < w.nbrAt[p + 1]; e++) {
        const q = w.nbr[e];
        if (held[q] || !w.alive[q] || w.doomed[q] || ijk[q * 3 + 2] > failK) continue;
        held[q] = 1;
        queue[qt++] = q;
      }
    }
    // Loose parts: connected components of what is not held.
    const comp = new Uint8Array(n);
    for (let s = 0; s < n; s++) {
      if (!w.alive[s] || w.doomed[s] || held[s] || comp[s]) continue;
      const part: number[] = [s];
      comp[s] = 1;
      for (let h = 0; h < part.length; h++) {
        const p = part[h];
        for (let e = w.nbrAt[p]; e < w.nbrAt[p + 1]; e++) {
          const q = w.nbr[e];
          if (comp[q] || held[q] || !w.alive[q] || w.doomed[q]) continue;
          comp[q] = 1;
          part.push(q);
        }
      }
      if (quiet) for (const p of part) this.kill(w, p, false);
      else if (part.length < MIN_FALL) {
        for (const p of part) {
          w.doomed[p] = 1;
          w.pending++;
          this.push({ w, p, dx: 0, dy: -1, dz: 0, power: 2, fn: null }, Math.random() * 0.2);
        }
      } else {
        // Out of the standing landmark now (the falling part draws it), so nothing breaks it twice.
        for (const p of part) { w.doomed[p] = 1; }
        this.startQ.push({ w, pieces: part });
      }
    }
    if (quiet && w.fresh.length) this.flush(w);
  }

  // ------------------------------------------------------------ falling parts

  private startFall(w: Wreck, pieces: number[]): void {
    pieces = pieces.filter((p) => w.alive[p]);
    if (!pieces.length) return;
    const elems = new Set<number>(pieces.map((p) => p + 1));
    const d = w.d;
    const geos = [extractElements(d.near.geometry, elems), d.nearGlass ? extractElements(d.nearGlass.geometry, elems) : null];
    for (const p of pieces) this.kill(w, p, false);
    this.flush(w);
    // Own element state: the part is eaten level by level as it hits the ground.
    const W = d.elemW, H = Math.max(1, Math.ceil((w.n + 1) / W));
    const data = new Uint8Array(W * H * 2).fill(255);
    const tex = new THREE.DataTexture(data, W, H, THREE.RGFormat, THREE.UnsignedByteType);
    tex.needsUpdate = true;
    const group = new THREE.Group();
    group.position.copy(w.origin);
    const meshes: THREE.Mesh[] = [];
    if (geos[0]) {
      const m = new THREE.Mesh(geos[0], createFacadeMaterial(this.facade, tex, W));
      m.customDepthMaterial = createElemDepthMaterial(tex, W);
      m.castShadow = m.receiveShadow = true;
      m.frustumCulled = false;
      meshes.push(m);
    }
    if (geos[1]) {
      const m = new THREE.Mesh(geos[1], clearGlassElemMaterial(tex, W));
      m.renderOrder = 2;
      m.frustumCulled = false;
      meshes.push(m);
    }
    for (const m of meshes) group.add(m);
    this.group.add(group);
    // Shape of the part: its levels, extent, and where the standing structure under it is gone.
    const T = w.T, g = w.g;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, kMin = Infinity, kMax = -Infinity, cx = 0, cz = 0, a = 0;
    const layerArea = new Map<number, number>();
    for (const p of pieces) {
      const o = p * PIECE_STRIDE;
      x0 = Math.min(x0, T[o + 5]); x1 = Math.max(x1, T[o + 8]); z0 = Math.min(z0, T[o + 7]); z1 = Math.max(z1, T[o + 10]);
      const k = w.ijk[p * 3 + 2];
      kMin = Math.min(kMin, k); kMax = Math.max(kMax, k);
      cx += T[o + 2] * T[o + 1]; cz += T[o + 4] * T[o + 1]; a += T[o + 1];
      layerArea.set(T[o + 11], (layerArea.get(T[o + 11]) ?? 0) + T[o + 1]);
    }
    cx /= Math.max(1e-6, a); cz /= Math.max(1e-6, a);
    const baseY = g.y0 + kMin * g.ch, height = (kMax - kMin + 1) * g.ch;
    const radius = Math.max(2, Math.max(x1 - x0, z1 - z0) / 2);
    let layer = 8, best = -1;
    for (const [l, ar] of layerArea) if (ar > best && l !== 10) { best = ar; layer = l; }
    // Fall direction: toward the broken side of the level under the part (else any way).
    let fx = 0, fz = 0;
    const mine = new Uint8Array(w.n);
    for (const p of pieces) mine[p] = 1;
    for (let p = 0; p < w.n; p++) {
      const k = w.ijk[p * 3 + 2];
      if (w.alive[p] || mine[p] || k < kMin - 2 || k > kMin) continue;
      const o = p * PIECE_STRIDE;
      if (T[o + 2] < x0 - g.cs || T[o + 2] > x1 + g.cs || T[o + 4] < z0 - g.cs || T[o + 4] > z1 + g.cs) continue;
      fx += T[o + 2] - cx; fz += T[o + 4] - cz;
    }
    let fl = Math.hypot(fx, fz);
    if (fl < radius * 0.5) {
      const ang = Math.random() * Math.PI * 2;
      fx = Math.cos(ang); fz = Math.sin(ang); fl = 1;
    }
    fx /= fl; fz /= fl;
    const levels: number[][] = [];
    for (const p of pieces) (levels[w.ijk[p * 3 + 2] - kMin] ??= []).push(p);
    const f: Fall = {
      w, pieces, group, meshes, data, tex, mode: height > radius * 2 ? 'topple' : 'pancake',
      baseY, height, radius, cx, cz, fx, fz, hx: cx + fx * radius * 0.8, hz: cz + fz * radius * 0.8,
      angle: 0.03, angVel: 0.15, drop: 0, vel: 0, eaten: 0, levels, restOn: 0, restIsGround: true, dustT: 0, t: 0, layer, done: false,
      origin: w.origin.clone(),
    };
    if (f.mode === 'pancake') this.findRest(f);
    this.falls.push(f);
    this.D.onImpact?.({ x: cx, y: baseY, z: cz, energy: a * height * 2000, kind: 'collapse' });
    this.dust.burst(cx, baseY + 2, cz, 30, radius, 4, radius * 0.6 + 3, 9, DUST, 0.4, 0.5);
  }

  /** The level a pancaking part comes down on: the highest standing piece under it, else the ground. */
  private findRest(f: Fall): void {
    const w = f.w, T = w.T, bottom = f.baseY - f.drop;
    let top = -Infinity;
    for (let p = 0; p < w.n; p++) {
      if (!w.alive[p] || w.doomed[p]) continue;
      const o = p * PIECE_STRIDE;
      if (Math.abs(T[o + 2] - f.cx) > f.radius || Math.abs(T[o + 4] - f.cz) > f.radius) continue;
      const t = w.g.y0 + (w.ijk[p * 3 + 2] + 1) * w.g.ch;
      if (t <= bottom + 0.5 && t > top) top = t;
    }
    const ground = this.terrain.height(f.cx, f.cz);
    f.restIsGround = top <= ground + 0.5;
    f.restOn = f.restIsGround ? ground : top;
  }

  private stepFall(f: Fall, dt: number): void {
    f.t += dt;
    f.dustT += dt;
    const g = 9.81;
    if (f.mode === 'pancake') {
      f.vel += g * (f.restIsGround ? 0.8 : 0.7) * dt;
      f.drop += f.vel * dt;
      f.group.position.y = f.origin.y - f.drop;
      // Coming down on standing parts: crush them, slow down, lose the bottom level.
      if (!f.restIsGround && f.baseY - f.drop <= f.restOn) {
        const y = f.restOn;
        this.D.impact(f.cx, y - 1, f.cz, f.radius + 2, 1.2e6 + f.vel * 1e5, 0, -1, 0, 'collapse');
        f.vel *= 0.45;
        if (f.eaten < f.levels.length) this.eat(f, f.eaten++);
        this.findRest(f);
      }
      // On the ground: each level is eaten as it reaches it.
      while (f.restIsGround && f.eaten < f.levels.length && f.baseY + f.eaten * f.w.g.ch - f.drop <= f.restOn + 0.3) this.eat(f, f.eaten++);
      if (f.eaten >= f.levels.length) this.finish(f);
      return;
    }
    const ground = this.terrain.height(f.hx, f.hz);
    const raised = f.baseY - f.drop - ground;
    if (f.mode === 'topple') {
      // Rigid toppling about the hinge (as the buildings): α = m g r sinθ / I.
      const r = f.height * 0.5, I = (f.height * f.height) / 3 + (f.radius * f.radius) / 4;
      f.angVel += ((g * r * Math.sin(f.angle + 0.05)) / I) * dt;
      // High up there is nothing to lean on: past a small tilt it drops as it turns.
      if (raised > 4 && f.angle > 0.3) f.mode = 'drop';
    } else {
      f.vel += g * dt;
      f.drop += f.vel * dt;
    }
    f.angle += f.angVel * dt;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(f.fz, 0, -f.fx), f.angle);
    const hinge = new THREE.Vector3(f.hx, f.baseY - f.drop, f.hz);
    const pivot = new THREE.Vector3(f.hx, f.baseY, f.hz);
    f.group.position.copy(f.origin).sub(pivot).applyQuaternion(q).add(hinge);
    f.group.quaternion.copy(q);
    if (f.dustT > 0.15 && raised < 4) {
      f.dustT = 0;
      this.dust.burst(f.hx, f.baseY + 1, f.hz, 3, 3, 2, 3, 5, CHIPS, 0.3, 0.4);
    }
    // Landed: the top swung down (on the ground), or the lowest end of the falling body hit it.
    const topY = hinge.y + f.height * Math.cos(f.angle);
    const tx = f.hx + f.fx * f.height * Math.sin(f.angle), tz = f.hz + f.fz * f.height * Math.sin(f.angle);
    if ((f.mode === 'topple' && f.angle > 1.3) || hinge.y <= ground + 0.3 || topY <= this.terrain.height(tx, tz) + 0.5) this.smash(f, Math.min(f.angle, Math.PI / 2));
  }

  /** A level of a pancaking part breaks up where it hits: debris, dust, a hit around it. */
  private eat(f: Fall, i: number): void {
    const ps = f.levels[i];
    if (ps) for (const p of ps) f.data[(p + 1) * 2] = 0;
    f.tex.needsUpdate = true;
    const y = f.restOn;
    const nFrag = Math.min(12, 3 + Math.round(f.radius * 0.5));
    for (let k = 0; k < nFrag; k++) {
      const a = Math.random() * Math.PI * 2, rr = f.radius * (0.4 + Math.random() * 0.6), out = 2 + Math.random() * 5;
      this.debris.spawn(f.cx + Math.cos(a) * rr, y + 1 + Math.random() * 2, f.cz + Math.sin(a) * rr, 0.8 + Math.random() * 1.2, 0.4 + Math.random() * 0.8, 0.5 + Math.random(),
        Math.cos(a) * out, 1 + Math.random() * 2, Math.sin(a) * out, f.layer, new THREE.Color(0.85, 0.82, 0.78));
    }
    this.debris.chipBurst(f.cx, y + 1, f.cz, 30, 6, 0, 0.2, 0, CHIPS, 0.12, 3);
    this.dust.burst(f.cx, y + 1, f.cz, 14, f.radius * 1.1, 6 + f.radius * 0.2, f.radius * 0.4 + 4, 14, DUST, 0.25, 0.55);
    this.D.onImpact?.({ x: f.cx, y, z: f.cz, energy: f.radius * f.radius * 3.2 * 20000, kind: 'collapse' });
    if (f.restIsGround) {
      const cx = f.cx, cz = f.cz, r = f.radius;
      this.later(0.05, () => this.D.impact(cx, y + 2, cz, r + 4, 2e5, 0, -1, 0, 'collapse'));
    }
  }

  private finish(f: Fall): void {
    const g = f.w.g;
    const vol = f.pieces.length * g.cs * g.cs * g.ch;
    const r = Math.max(4, f.radius * 1.3);
    const h = Math.max(1, Math.min(14, (vol * 0.12) / (Math.PI * r * r) * 2));
    this.D.restoreMound(f.cx, f.cz, r, h);
    this.dust.burst(f.cx, f.restOn + 3, f.cz, 50, f.radius * 1.5, 10 + f.radius * 0.3, f.radius * 0.8 + 6, 22, DUST, 0.2, 0.6);
    f.done = true;
  }

  /**
   * A toppled or dropped part hits the ground lying along its fall: the hit sweeps from the hinge
   * outward (a tall one lands over a moment), with rubble and mounds along the line.
   */
  private smash(f: Fall, angle: number): void {
    const len = Math.max(f.radius, f.height * Math.sin(angle) + f.radius * 0.5);
    const g = f.w.g;
    const vol = f.pieces.length * g.cs * g.cs * g.ch;
    const seg = Math.max(6, len / 60);
    const segs = Math.max(1, Math.ceil(len / seg));
    const per = Math.min(10, Math.ceil(Math.min(160, 20 + (len * f.radius) * 0.1) / segs) + 1);
    const moundEvery = Math.max(1, Math.round(segs / 10));
    const mr = f.radius * 1.1, mh = Math.max(1, Math.min(8, (vol * 0.1) / (segs / moundEvery) / (Math.PI * mr * mr) * 2));
    const ex = f.hx, ez = f.hz, fx = f.fx, fz = f.fz, rad = f.radius, layer = f.layer, v0 = Math.max(4, f.angVel * len * 0.5);
    this.D.onImpact?.({ x: ex + fx * len * 0.5, y: this.terrain.height(ex, ez), z: ez + fz * len * 0.5, energy: f.height * rad * rad * 50000, kind: 'collapse' });
    for (let k = 0; k < segs; k++) {
      const s0 = k * seg;
      this.later((s0 / Math.max(1, len)) * 0.8, () => {
        const sx = ex + fx * (s0 + seg / 2), sz = ez + fz * (s0 + seg / 2);
        const ground = this.terrain.height(sx, sz);
        for (let m = 0; m < per; m++) {
          const s = s0 + Math.random() * seg;
          const x = ex + fx * s + (Math.random() - 0.5) * rad * 1.5, z = ez + fz * s + (Math.random() - 0.5) * rad * 1.5;
          const sy = 0.5 + Math.random(), dyn = m < 3;
          this.debris.spawn(x, dyn ? ground + 1.5 + Math.random() * 3 : this.terrain.height(x, z) + sy * 0.35, z, 0.8 + Math.random() * 1.6, sy, 0.6 + Math.random(),
            fx * v0 * 0.3, -2, fz * v0 * 0.3, layer, new THREE.Color(0.85, 0.82, 0.78), 3, dyn);
        }
        this.dust.burst(sx, ground + 2, sz, 6, rad, 8, rad * 0.5 + 4, 16, DUST, 0.25, 0.6);
        this.D.impact(sx, ground + 3, sz, rad + 2, 3e5, fx, -1, fz, 'collapse');
        if (k % moundEvery === 0) this.D.restoreMound(sx, sz, mr, mh);
      });
    }
    f.done = true;
  }

  // ------------------------------------------------------------ saves

  /** Saves: per breakable landmark with damage, [landmark index, piece count, broken pieces]. */
  capture(): [number, number, number[]][] {
    const out: [number, number, number[]][] = [];
    for (const w of this.wrecks) {
      const dead: number[] = [];
      for (let p = 0; p < w.n; p++) if (!w.alive[p]) dead.push(p);
      if (dead.length) out.push([w.d.index, w.n, dead]);
    }
    return out;
  }

  /** Saves: broken pieces back (quietly; what they held up is gone too). False: the landmark changed. */
  restore(index: number, n: number, dead: Iterable<number>): boolean {
    const w = this.wrecks.find((x) => x.d.index === index);
    if (!w || w.n !== n) return false;
    for (const p of dead) if (p >= 0 && p < w.n) this.kill(w, p, false);
    this.check(w, true);
    w.dirty = false;
    return true;
  }
}
