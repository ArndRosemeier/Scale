/**
 * Animated signage of the near-future city: LED fascias over shop fronts, vertical blade signs,
 * large billboard screens on downtown facades (cycling ads) and free-standing holographic
 * info kiosks on busy sidewalks.
 *
 * Placement is deterministic from (seed, cell, building) and follows the district: plenty
 * downtown and on commercial streets, a few in the old town, almost none in the suburbs.
 * Every facade sign is attached to the wall elements behind it (destruction element ids from
 * the building layout): a nearby blast makes it flicker, and when its wall breaks it sparks,
 * dies and is gone. Kiosks can be smashed.
 *
 * Rendering: one instanced quad mesh for all facade signs (unlit, its own small shader: LED
 * grid, ticker scroll, shine sweeps, slide shows, damage flicker), an additive billboard mesh
 * for the holograms and the kiosk pedestals in the furniture material.
 */
import * as THREE from 'three';
import { deriveSeed, hashToFloat, hash32 } from '../core/rng';
import { CURB_H } from '../build/ground';
import { G } from '../render/materials/globals';
import { WEBGPU, gpuKit } from '../render/gpuMode';
import type { CellState } from '../stream/CityStreamer';
import type { BuildingRef } from '../world/WorldIndex';
import type { District } from '../plan/types';
import type { Panel } from '../build/buildingLayout';
import { FurnBatch } from './batch';
import { kioskPedestalGeometry } from './models';
import { signAtlas, fasciaRect, bladeRect, holoRect, slideRect, ART } from './signArt';
import type { FutureCtx } from './ctx';
import { NameAtlas, NAME_SLOTS } from './eateryArt';
import { isArcade } from '../interior/InteriorGen';
import { eateryName, type Eatery } from '../plan/eatery';

const enum SMode { Static = 0, Ticker = 1, Shine = 2, Slides = 3, Chase = 4 }

interface Sign {
  cell: number;
  ref: BuildingRef;
  /** Wall elements the sign hangs on. */
  elems: number[];
  m: THREE.Matrix4;
  x: number; y: number; z: number;
  rect: [number, number, number, number];
  mode: SMode;
  seed: number;
  /** 1 fine, 0.5 flickering (damaged), 0 gone. */
  state: number;
  /** LED pitch: pixels across. */
  res: number;
  /** A café's / restaurant's name board (drawn from the name atlas). */
  eat?: { key: number; name: string; kind: Eatery; palette: number };
}

interface Kiosk { cell: number; x: number; y: number; z: number; yaw: number; art: number; seed: number; broken: boolean }

const DENSITY: Partial<Record<District, number>> = { downtown: 1, commercial: 0.8, oldtown: 0.45, apartments: 0.22, rowhouses: 0.12, port: 0.1, industrial: 0.08, suburban: 0.03 };
const DRAW_R = 950;
const CAP = 4096;
/** Café / restaurant name boards: drawn within NAME_R m, at most NAME_CAP. */
const NAME_R = 420;
const NAME_CAP = 768;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0);

export class Signs {
  readonly group = new THREE.Group();
  private byCell = new Map<number, { signs: Sign[]; kiosks: Kiosk[] }>();
  private known = new Set<number>();
  private mesh: THREE.InstancedMesh;
  private aRect: THREE.InstancedBufferAttribute;
  private aSign: THREE.InstancedBufferAttribute;
  private holo: THREE.InstancedMesh;
  private hRect: THREE.InstancedBufferAttribute;
  private hSign: THREE.InstancedBufferAttribute;
  private pedestals: FurnBatch;
  private dirty = true;
  private lastCam = new THREE.Vector3(1e9, 0, 0);
  private t = 0;
  private checkT = 0;
  private queue: CellState[] = [];
  /**
   * Red alert (a threat nearby, THREATS_PLAN §2 level 1): screens within uAlert.z m of (x, z)
   * show a flashing warning pictogram instead of their ads, strength uAlert.w (0 off).
   */
  readonly uniforms = {
    uTime: { value: 0 }, uAtlas: { value: null as THREE.Texture | null }, uNight: G.uNight, uAlert: { value: new THREE.Vector4(0, 0, 0, 0) },
    /**
     * The last resort (THREATS_PLAN §2 level 5): screens within uCount.z m of (x, z) show the strike
     * countdown — a warning symbol and the minutes and seconds left (uCount.w), no words; strength uCountOn.
     */
    uCount: { value: new THREE.Vector4(0, 0, 0, 0) }, uCountOn: { value: 0 },
    /**
     * The live news feed (the Cloverfield trick, src/game/aftermath/NewsFeed): billboards within
     * uFeedAt.z m of (x, z) show a low-res render of the monster (uFeed), strength uFeedAt.w.
     */
    uFeed: { value: blackTexture() as THREE.Texture }, uFeedAt: { value: new THREE.Vector4(0, 0, 0, 0) },
    /** City news on the billboards (a pictogram: 1 the city lost, 2 all clear, 3 the monster brought down), strength uNews.y. */
    uNews: { value: new THREE.Vector4(0, 0, 0, 0) },
    /**
     * City news cards (game/news, future/newsArt): the slide shows put one up in two of their eight
     * slots; uCards.x = cards on the canvas (0: ads only).
     */
    uCardTex: { value: blackTexture() as THREE.Texture }, uCards: { value: new THREE.Vector4(0, 0, 0, 0) },
  };
  /** Signs flickering for a while (an omen), back to normal after `until`. */
  private glitched: { s: Sign; until: number }[] = [];
  stats = { cells: 0, signs: 0, kiosks: 0, drawn: 0, broken: 0, names: 0 };
  /** Name boards of the cafés and restaurants: the sign shader on their own atlas. */
  private names: THREE.InstancedMesh;
  private nRect: THREE.InstancedBufferAttribute;
  private nSign: THREE.InstancedBufferAttribute;
  private nameAtlas = new NameAtlas();
  private nameSorted: { s: Sign; d: number }[] = [];

  constructor(private ctx: FutureCtx, furnMat: THREE.Material) {
    this.uniforms.uAtlas.value = signAtlas();
    // Facade signs: unit quad facing +Z, origin at its centre.
    const g = new THREE.PlaneGeometry(1, 1);
    g.setAttribute('sUv', g.getAttribute('uv').clone());
    this.aRect = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aSign = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iRect', this.aRect);
    g.setAttribute('iSign', this.aSign);
    this.mesh = new THREE.InstancedMesh(g, this.signMaterial(), CAP);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    // Holograms: camera-facing quads above the kiosks, origin at the bottom centre.
    const hg = new THREE.PlaneGeometry(1, 1);
    hg.translate(0, 0.5, 0);
    hg.setAttribute('sUv', hg.getAttribute('uv').clone());
    this.hRect = new THREE.InstancedBufferAttribute(new Float32Array(256 * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.hSign = new THREE.InstancedBufferAttribute(new Float32Array(256 * 4), 4).setUsage(THREE.DynamicDrawUsage);
    hg.setAttribute('iRect', this.hRect);
    hg.setAttribute('iSign', this.hSign);
    this.holo = new THREE.InstancedMesh(hg, this.holoMaterial(), 256);
    this.holo.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.holo.count = 0;
    this.holo.frustumCulled = false;
    this.holo.renderOrder = 5;
    this.group.add(this.holo);
    this.pedestals = new FurnBatch(kioskPedestalGeometry(), furnMat, 256);
    this.group.add(this.pedestals.mesh);
    // Name boards: the same sign shader (same program) on the name atlas.
    const ng = new THREE.PlaneGeometry(1, 1);
    ng.setAttribute('sUv', ng.getAttribute('uv').clone());
    this.nRect = new THREE.InstancedBufferAttribute(new Float32Array(NAME_CAP * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.nSign = new THREE.InstancedBufferAttribute(new Float32Array(NAME_CAP * 4), 4).setUsage(THREE.DynamicDrawUsage);
    ng.setAttribute('iRect', this.nRect);
    ng.setAttribute('iSign', this.nSign);
    this.names = new THREE.InstancedMesh(ng, this.signMaterial({ ...this.uniforms, uAtlas: { value: this.nameAtlas.texture }, uAlert: { value: new THREE.Vector4(0, 0, 0, 0) }, uCountOn: { value: 0 }, uFeedAt: { value: new THREE.Vector4(0, 0, 0, 0) }, uNews: { value: new THREE.Vector4(0, 0, 0, 0) }, uCards: { value: new THREE.Vector4(0, 0, 0, 0) } }), NAME_CAP);
    this.names.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.names.count = 0;
    this.names.frustumCulled = false;
    this.group.add(this.names);
  }

  // ------------------------------------------------------------------ placement

  /** Track the streamer's ready cells (new ones are placed a few per frame). */
  private syncCells(): void {
    const S = this.ctx.streamer.cells;
    for (const [id, cs] of S) if (cs.status === 'ready' && !this.known.has(id)) { this.known.add(id); this.queue.push(cs); }
    for (const id of this.known) {
      const cs = S.get(id);
      if (!cs || cs.status !== 'ready') { this.known.delete(id); if (this.byCell.delete(id)) this.dirty = true; }
    }
  }

  /** Place a cell's signs building by building within a time budget (layouts of towers are not free). */
  private placeSome(budgetMs: number): void {
    const t0 = performance.now();
    while (performance.now() - t0 < budgetMs) {
      let job = this.job;
      if (!job) {
        const cs = this.queue.shift();
        if (!cs) return;
        if (!cs.plan || this.ctx.streamer.cells.get(cs.id) !== cs) continue;
        const district = this.ctx.macro.cells[cs.id]?.district ?? 'suburban';
        const dens = DENSITY[district] ?? 0;
        const [x0, z0, x1, z1] = cs.plan.bounds;
        const refs = dens > 0 ? this.ctx.world.buildingsIn(x0, z0, x1, z1).filter((r) => r.cell === cs) : [];
        job = this.job = { cs, district, dens, refs, i: 0, signs: [], kiosks: [] };
      }
      if (this.ctx.streamer.cells.get(job.cs.id) !== job.cs) { this.job = null; continue; }
      if (job.i < job.refs.length) { this.placeBuilding(job.refs[job.i++], job.dens, job.district, job.signs); continue; }
      if (job.dens > 0) this.placeKiosks(job.cs, job.dens, job.kiosks);
      this.byCell.set(job.cs.id, { signs: job.signs, kiosks: job.kiosks });
      this.job = null;
      this.dirty = true;
    }
  }
  private job: { cs: CellState; district: District; dens: number; refs: BuildingRef[]; i: number; signs: Sign[]; kiosks: Kiosk[] } | null = null;

  private placeBuilding(ref: BuildingRef, dens: number, district: District, out: Sign[]): void {
    const d = ref.desc;
    const h = deriveSeed(this.ctx.seed, 'signs', ref.cell.id, ref.index);
    const r1 = hashToFloat(h), r2 = hashToFloat(hash32(h + 1)), r3 = hashToFloat(hash32(h + 2));
    const wantFascia = d.shopfront && !d.eatery && !isArcade(d) && r1 < dens * 0.85;
    if (d.eatery) this.placeName(ref, h, out);
    const wantBlade = d.shopfront && d.floors >= 3 && r2 < dens * 0.3;
    const wantScreen = (district === 'downtown' || district === 'commercial') && d.floors >= 5 && r3 < dens * 0.25;
    if (!wantFascia && !wantBlade && !wantScreen) return;
    const L = this.ctx.destruction.layoutOnce(ref);
    const front = L.panels.filter((p) => p.edge === d.front);
    if (!front.length) return;
    const byFloor = (f: number) => front.filter((p) => p.floor === f);
    const g0 = byFloor(0);
    const edge = g0[0] ?? front[0];
    const ex = edge.bx - edge.ax, ez = edge.bz - edge.az, el = Math.hypot(ex, ez) || 1;
    const ux = ex / el, uz = ez / el, nx = edge.nx, nz = edge.nz;
    // Edge start and length from the panels of the floor.
    const span = (ps: Panel[]) => {
      let s0 = Infinity, s1 = -Infinity;
      for (const p of ps) { s0 = Math.min(s0, p.u0); s1 = Math.max(s1, p.u0 + p.bayW); }
      return [s0, s1];
    };
    const ox = edge.ax - ux * edge.u0, oz = edge.az - uz * edge.u0; // edge origin (u = 0)
    const covered = (ps: Panel[], s0: number, s1: number) => ps.filter((p) => p.u0 < s1 && p.u0 + p.bayW > s0).map((p) => p.e);
    /** A sign at arc length s of the edge, `off` out from the wall, facing (fx, fz) (default: the street). */
    const add = (s: number, y: number, w: number, hh: number, off: number, rect: [number, number, number, number], mode: SMode, elems: number[], fx = nx, fz = nz, lat = 0) => {
      if (!elems.length) return;
      const x = ox + ux * s + nx * off + ux * lat, z = oz + uz * s + nz * off + uz * lat;
      // Basis: x = reading direction seen from the front, z = the face normal.
      _m.makeBasis(_p.set(fz, 0, -fx), _Y, _s.set(fx, 0, fz));
      _m.scale(_s.set(w, hh, 1)).setPosition(x, y, z);
      out.push({ cell: ref.cell.id, ref, elems, m: _m.clone(), x, y, z, rect, mode, seed: hashToFloat(hash32(h + out.length * 7 + 3)), state: 1, res: Math.round(w * 36) });
    };
    if (wantFascia && g0.length) {
      const [s0, s1] = span(g0);
      const len = s1 - s0;
      const w = Math.min(len * 0.78, 5.2);
      if (w > 1.6) {
        const hh = Math.min(1.0, Math.max(0.42, w / 4.4));
        const sc = (s0 + s1) / 2 + (hashToFloat(hash32(h + 9)) - 0.5) * (len - w) * 0.5;
        const y = g0[0].y1 - 0.18 - hh / 2;
        const ticker = hashToFloat(hash32(h + 4)) < 0.14;
        const art = ticker ? ART.tickers[hash32(h + 5) % 4] : hash32(h + 5) % 28;
        const mode = ticker ? SMode.Ticker : hashToFloat(hash32(h + 6)) < 0.35 ? SMode.Shine : SMode.Static;
        add(sc, y, w, hh, 0.1, fasciaRect(art), mode, covered(g0, sc - w / 2, sc + w / 2));
      }
    }
    if (wantBlade) {
      const f1 = byFloor(1), f2 = byFloor(2);
      if (f1.length) {
        const [s0, s1] = span(f1);
        const atStart = (h & 1) === 0;
        const s = atStart ? s0 + 0.7 : s1 - 0.7;
        const hh = Math.min(3.2, (f2[0]?.y1 ?? f1[0].y1) - f1[0].y0 - 0.6);
        const y = f1[0].y0 + 0.3 + hh / 2;
        const art = bladeRect(hash32(h + 11) % ART.blades);
        const elems = [...covered(f1, s - 0.5, s + 0.5), ...covered(f2, s - 0.5, s + 0.5)];
        // Two faces back to back, perpendicular to the wall, sticking out 0.25–1.05 m.
        const w = 0.8;
        const mode = hashToFloat(hash32(h + 12)) < 0.5 ? SMode.Chase : SMode.Static;
        add(s, y, w, hh, 0.65, art, mode, elems, ux, uz, 0.025);
        add(s, y, w, hh, 0.65, art, mode, elems, -ux, -uz, -0.025);
      }
    }
    if (wantScreen) {
      const floors = Math.min(4, d.floors - 2);
      const fl = [1, 2, 3, 4].slice(0, floors).map(byFloor).filter((l) => l.length);
      if (fl.length >= 2) {
        const [s0, s1] = span(fl[0]);
        const len = s1 - s0;
        const top = fl[fl.length - 1][0].y1, bot = fl[0][0].y0 + 0.4;
        let w = Math.min(len * 0.62, 16), hh = w / 2;
        if (hh > top - bot - 0.3) { hh = top - bot - 0.3; w = hh * 2; }
        if (w > 3.5) {
          const sc = (s0 + s1) / 2;
          const elems = fl.flatMap((l) => covered(l, sc - w / 2, sc + w / 2));
          add(sc, bot + hh / 2 + 0.15, w, hh, 0.22, slideRect(hash32(h + 13) % ART.slides), SMode.Slides, elems);
        }
      }
    }
  }

  /**
   * A café's / restaurant's name board over the shop front, centred on the door (above the
   * awnings when there are some), attached to the ground-floor wall elements behind it.
   */
  private placeName(ref: BuildingRef, h: number, out: Sign[]): void {
    const d = ref.desc;
    const ep = ref.cell.plan?.eateries.find((e) => e.b === ref.index);
    if (!ep) return;
    const L = this.ctx.destruction.layoutOnce(ref);
    const g0 = L.panels.filter((p) => p.edge === d.front && p.floor === 0);
    if (!g0.length) return;
    const e0 = g0[0];
    const ex = e0.bx - e0.ax, ez = e0.bz - e0.az, el = Math.hypot(ex, ez) || 1;
    const ux = ex / el, uz = ez / el, nx = e0.nx, nz = e0.nz;
    const ox = e0.ax - ux * e0.u0, oz = e0.az - uz * e0.u0;
    let s0 = Infinity, s1 = -Infinity;
    for (const p of g0) { s0 = Math.min(s0, p.u0); s1 = Math.max(s1, p.u0 + p.bayW); }
    // Board height: what is left between the awnings and the top of the ground floor.
    const yTop = e0.y1 - 0.18;
    let hh = 0.42;
    if (ep.awnings.length) {
      const sy = this.ctx.terrain.height(ep.ax + ep.ux * ep.awnings[0], ep.az + ep.uz * ep.awnings[0]) + CURB_H;
      hh = Math.max(0.26, Math.min(0.42, yTop - (sy + ep.awnings[2] + 0.12)));
    }
    const w = Math.min(hh * 8, (s1 - s0) * 0.92);
    hh = w / 8;
    if (w < 1.6) return;
    // Centred over the door, kept on the front.
    const door = (ep.door[0] - ox) * ux + (ep.door[1] - oz) * uz;
    const sc = Math.max(s0 + w / 2 + 0.05, Math.min(s1 - w / 2 - 0.05, door));
    const x = ox + ux * sc + nx * 0.08, z = oz + uz * sc + nz * 0.08, y = yTop - hh / 2;
    const elems = g0.filter((p) => p.u0 < sc + w / 2 && p.u0 + p.bayW > sc - w / 2).map((p) => p.e);
    if (!elems.length) return;
    _m.makeBasis(_p.set(nz, 0, -nx), _Y, _s.set(nx, 0, nz));
    _m.scale(_s.set(w, hh, 1)).setPosition(x, y, z);
    const key = ref.cell.id * 4096 + ref.index;
    out.push({
      cell: ref.cell.id, ref, elems, m: _m.clone(), x, y, z, rect: this.nameAtlas.generic(ep.kind), mode: hashToFloat(hash32(h + 31)) < 0.3 ? SMode.Shine : SMode.Static,
      seed: hashToFloat(hash32(h + 32)), state: 1, res: 0,
      eat: { key, name: eateryName(this.ctx.seed, ref.cell.id, ref.index, ep.kind), kind: ep.kind, palette: ep.palette },
    });
  }

  private placeKiosks(cs: CellState, dens: number, out: Kiosk[]): void {
    const n = Math.round(dens * 3 * hashToFloat(deriveSeed(this.ctx.seed, 'kiosks', cs.id)) + dens * 1.2);
    const streets = cs.plan!.streets.filter((s) => s.sidewalk >= 2.5 && s.pts.length >= 4);
    if (!streets.length) return;
    for (let k = 0; k < n * 3 && out.length < n; k++) {
      const h = deriveSeed(this.ctx.seed, 'kiosk', cs.id, k);
      const st = streets[h % streets.length];
      // A point along the street, on one side's sidewalk (near the kerb).
      const segs = st.pts.length / 2 - 1;
      const si = hash32(h + 1) % segs, t = 0.25 + 0.5 * hashToFloat(hash32(h + 2));
      const ax = st.pts[si * 2], az = st.pts[si * 2 + 1], bx = st.pts[si * 2 + 2], bz = st.pts[si * 2 + 3];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 12) continue;
      const side = hash32(h + 3) & 1 ? 1 : -1;
      const nx = -(bz - az) / L * side, nz = (bx - ax) / L * side;
      const off = st.width / 2 + Math.min(1.4, st.sidewalk * 0.4);
      const x = ax + (bx - ax) * t + nx * off, z = az + (bz - az) * t + nz * off;
      if (this.ctx.world.buildingAt(x, z) || out.some((o) => Math.hypot(o.x - x, o.z - z) < 40)) continue;
      // Not inside the cell's carriageway of another street.
      if (cs.plan!.streets.some((o) => o !== st && nearPolyline(o.pts, x, z, o.width / 2 + 0.4))) continue;
      const y = this.ctx.terrain.height(x, z) + CURB_H;
      out.push({ cell: cs.id, x, y, z, yaw: Math.atan2(nx, nz), art: hash32(h + 4) % ART.holos, seed: hashToFloat(hash32(h + 5)), broken: false });
    }
  }

  // ------------------------------------------------------------------ frame

  update(dt: number, cam: THREE.Camera): void {
    this.t += dt;
    this.uniforms.uTime.value = this.t;
    for (let i = this.glitched.length - 1; i >= 0; i--) {
      const g = this.glitched[i];
      if (this.t < g.until) continue;
      this.glitched.splice(i, 1);
      if (g.s.state === 0.5 && g.s.elems.every((e) => this.ctx.streamer.isAlive(g.s.ref.cell, e))) { g.s.state = 1; this.dirty = true; }
    }
    this.syncCells();
    // A couple of cells per frame (layouts are cached by Destruction, cheap after the first).
    this.placeSome(0.8);
    this.nameAtlas.flush(this.t);
    // Wall state: a few times per second.
    this.checkT -= dt;
    if (this.checkT <= 0) { this.checkT = 0.25; this.checkWalls(); }
    const cp = cam.position;
    if (this.dirty || cp.distanceToSquared(this.lastCam) > 30 * 30) { this.dirty = false; this.lastCam.copy(cp); this.fill(cp); }
  }

  private checkWalls(): void {
    const S = this.ctx.streamer;
    for (const { signs } of this.byCell.values()) for (const s of signs) {
      if (s.state === 0) continue;
      const cs = s.ref.cell;
      let dead = 0;
      for (const e of s.elems) if (!S.isAlive(cs, e)) dead++;
      if (!s.ref.alive || dead === s.elems.length) this.kill(s);
      else if (dead > 0 && s.state === 1) { s.state = 0.5; this.sparks(s.x, s.y, s.z, 6); this.dirty = true; }
    }
  }

  private kill(s: Sign): void {
    s.state = 0;
    this.stats.broken++;
    this.sparks(s.x, s.y, s.z, 14);
    this.dirty = true;
  }

  private sparks(x: number, y: number, z: number, n: number): void {
    this.ctx.debris.chipBurst(x, y, z, n, 4, 0, -0.3, 0, new THREE.Color(4, 2.4, 0.7), 0.02, 0.8);
  }

  /** Screens near (x, z) flicker and tear for `dur` seconds, then recover (a malfunction omen). Returns how many. */
  glitch(x: number, z: number, r: number, dur: number, max = 4): number {
    let n = 0;
    for (const { signs } of this.byCell.values()) for (const s of signs) {
      if (n >= max) return n;
      if (s.state !== 1 || s.eat || Math.hypot(s.x - x, s.z - z) > r) continue;
      s.state = 0.5;
      this.glitched.push({ s, until: this.t + dur });
      this.dirty = true;
      n++;
    }
    return n;
  }

  /** Red alert pictograms on the screens within r of (x, z) (strength 0 = off). */
  alert(x: number, z: number, r: number, strength: number): void {
    this.uniforms.uAlert.value.set(x, z, r, strength);
  }

  /** The strike countdown on the screens within r of (x, z): `seconds` left (strength 0 = off). */
  countdown(x: number, z: number, r: number, seconds: number, strength: number): void {
    this.uniforms.uCount.value.set(x, z, r, Math.max(0, seconds));
    this.uniforms.uCountOn.value = strength;
  }

  /** The live feed on the billboards within r of (x, z) (null / strength 0: off; the texture is kept bound). */
  feed(tex: THREE.Texture | null, x: number, z: number, r: number, strength: number): void {
    if (tex) this.uniforms.uFeed.value = tex;
    this.uniforms.uFeedAt.value.set(x, z, r, tex ? strength : 0);
  }

  /** Big billboard screens (slide shows: they carry the live feed) still working within r of (x, z). */
  billboardsNear(x: number, z: number, r: number): number {
    let n = 0;
    for (const { signs } of this.byCell.values()) for (const s of signs) if (s.mode === SMode.Slides && s.state > 0.25 && Math.abs(s.x - x) < r && Math.abs(s.z - z) < r) n++;
    return n;
  }

  /** City news on the billboards: kind 1 the city lost, 2 all clear, 3 the monster brought down (0 / strength 0: off). */
  news(kind: number, strength: number): void {
    this.uniforms.uNews.value.set(kind, kind > 0 ? strength : 0, 0, 0);
  }

  /** The city news cards on the billboards' slide shows (count 0: ads only). */
  cards(tex: THREE.Texture, count: number): void {
    this.uniforms.uCardTex.value = tex;
    this.uniforms.uCards.value.x = count;
  }

  /** A blast / impact nearby: signs flicker, a direct hit kills them; kiosks smash. */
  impact(x: number, y: number, z: number, r: number, strong: boolean): void {
    for (const { signs, kiosks } of this.byCell.values()) {
      for (const s of signs) {
        if (s.state === 0) continue;
        const d = Math.hypot(s.x - x, s.y - y, s.z - z);
        if (d > r) continue;
        if (strong && d < r * 0.5) this.kill(s);
        else if (s.state === 1) { s.state = 0.5; this.sparks(s.x, s.y, s.z, 4); this.dirty = true; }
      }
      for (const k of kiosks) {
        if (k.broken || Math.hypot(k.x - x, k.y + 1 - y, k.z - z) > r + 0.4) continue;
        k.broken = true;
        this.sparks(k.x, k.y + 1.2, k.z, 12);
        this.ctx.debris.chipBurst(k.x, k.y + 1.2, k.z, 10, 3, 0, 0.5, 0, new THREE.Color(0.6, 0.9, 1.0), 0.04, 2);
        this.ctx.sound('glass_shatter', k.x, k.y + 1, k.z, 0.5, 1.3, 4);
        this.dirty = true;
      }
    }
  }

  private fill(cp: THREE.Vector3): void {
    let n = 0, hn = 0, signs = 0, kiosks = 0;
    this.pedestals.begin();
    const names = this.nameSorted;
    names.length = 0;
    for (const { signs: list, kiosks: kl } of this.byCell.values()) {
      signs += list.length; kiosks += kl.length;
      for (const s of list) {
        if (s.state === 0 || n >= CAP) continue;
        if (Math.abs(s.x - cp.x) > DRAW_R || Math.abs(s.z - cp.z) > DRAW_R) continue;
        if (s.eat) { if (Math.abs(s.x - cp.x) < NAME_R && Math.abs(s.z - cp.z) < NAME_R) names.push({ s, d: Math.hypot(s.x - cp.x, s.z - cp.z) }); continue; }
        this.mesh.setMatrixAt(n, s.m);
        this.aRect.setXYZW(n, s.rect[0], s.rect[1], s.rect[2], s.rect[3]);
        this.aSign.setXYZW(n, s.mode, s.seed, s.state, s.res);
        n++;
      }
      for (const k of kl) {
        if (Math.abs(k.x - cp.x) > 400 || Math.abs(k.z - cp.z) > 400) continue;
        _m.compose(_p.set(k.x, k.y, k.z), _q.setFromAxisAngle(_Y, k.yaw), _s.set(1, 1, 1));
        this.pedestals.push(_m, 0, 0, 0, 1, 0, k.seed, k.broken ? 2 : 0);
        if (k.broken || hn >= 256) continue;
        _m.compose(_p.set(k.x, k.y + 1.02, k.z), _q.identity(), _s.set(1.15, 1.15, 1));
        this.holo.setMatrixAt(hn, _m);
        const r = holoRect(k.art);
        this.hRect.setXYZW(hn, r[0], r[1], r[2], r[3]);
        this.hSign.setXYZW(hn, 0, k.seed, 1, 0);
        hn++;
      }
    }
    this.pedestals.end();
    // Name boards: the nearest ones get their own names, the rest a board saying what they are.
    names.sort((a, b) => a.d - b.d);
    this.nameAtlas.begin();
    let nn = 0;
    for (const { s, d } of names) {
      if (nn >= NAME_CAP) break;
      const e = s.eat!;
      const rect = (nn < NAME_SLOTS && d < 170 ? this.nameAtlas.named(e.key, e.name, e.kind, e.palette) : null) ?? s.rect;
      this.names.setMatrixAt(nn, s.m);
      this.nRect.setXYZW(nn, rect[0], rect[1], rect[2], rect[3]);
      this.nSign.setXYZW(nn, s.mode, s.seed, s.state, s.res);
      nn++;
    }
    this.names.count = nn;
    this.names.instanceMatrix.needsUpdate = true;
    this.nRect.needsUpdate = true;
    this.nSign.needsUpdate = true;
    this.stats.names = nn;
    this.mesh.count = n;
    this.holo.count = hn;
    for (const a of [this.aRect, this.aSign, this.hRect, this.hSign]) a.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.holo.instanceMatrix.needsUpdate = true;
    this.stats.cells = this.byCell.size; this.stats.signs = signs; this.stats.kiosks = kiosks; this.stats.drawn = n;
  }

  // ------------------------------------------------------------------ materials

  private signMaterial(u: Signs['uniforms'] = this.uniforms): THREE.MeshBasicMaterial {
    if (WEBGPU) return gpuKit().createSignNodeMaterial(u) as unknown as THREE.MeshBasicMaterial;
    const m = new THREE.MeshBasicMaterial({ color: 0xffffff });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = u.uTime; sh.uniforms.uAtlas = u.uAtlas; sh.uniforms.uNight = u.uNight; sh.uniforms.uAlert = u.uAlert;
      sh.uniforms.uCount = u.uCount; sh.uniforms.uCountOn = u.uCountOn; sh.uniforms.uFeed = u.uFeed; sh.uniforms.uFeedAt = u.uFeedAt; sh.uniforms.uNews = u.uNews; sh.uniforms.uCardTex = u.uCardTex; sh.uniforms.uCards = u.uCards;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec2 sUv; attribute vec4 iRect; attribute vec4 iSign;
uniform vec4 uAlert; uniform vec4 uCount; uniform float uCountOn; uniform vec4 uFeedAt; uniform vec4 uNews;
varying vec2 vL; varying vec4 vRect; varying vec4 vSign; varying float vAlert; varying float vCount; varying float vFeed; varying float vNews;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vL = sUv; vRect = iRect; vSign = iSign;
vec3 wc = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
vAlert = uAlert.w * step(distance(wc.xz, uAlert.xy), uAlert.z);
vCount = uCountOn * step(distance(wc.xz, uCount.xy), uCount.z);
// The big billboards (slide shows) carry the live feed near the player, and the news (most of them).
float bill = step(2.5, iSign.x) * step(iSign.x, 3.5);
vFeed = bill * uFeedAt.w * step(distance(wc.xz, uFeedAt.xy), uFeedAt.z);
vNews = bill * uNews.y * step(iSign.y, 0.7);`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform float uTime; uniform float uNight; uniform sampler2D uAtlas;
uniform vec4 uCount; uniform sampler2D uFeed; uniform vec4 uNews; uniform sampler2D uCardTex; uniform vec4 uCards;
varying vec2 vL; varying vec4 vRect; varying vec4 vSign; varying float vAlert; varying float vCount; varying float vFeed; varying float vNews;
float sh1(float x) { return fract(sin(x * 127.1) * 43758.5453); }
// Seven-segment digits (the countdown) and the shapes of the pictograms (no text anywhere).
float segLine(vec2 p, vec2 a, vec2 b, float w) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return 1.0 - smoothstep(w * 0.6, w, length(pa - ba * h));
}
float digit7(vec2 p, int d) {
  int m = d == 0 ? 63 : d == 1 ? 6 : d == 2 ? 91 : d == 3 ? 79 : d == 4 ? 102 : d == 5 ? 109 : d == 6 ? 125 : d == 7 ? 7 : d == 8 ? 127 : 111;
  vec2 TL = vec2(0.18, 0.88), TR = vec2(0.82, 0.88), ML = vec2(0.18, 0.5), MR = vec2(0.82, 0.5), BL = vec2(0.18, 0.12), BR = vec2(0.82, 0.12);
  float w = 0.1, c = 0.0;
  if ((m & 1) != 0) c = max(c, segLine(p, TL, TR, w));
  if ((m & 2) != 0) c = max(c, segLine(p, TR, MR, w));
  if ((m & 4) != 0) c = max(c, segLine(p, MR, BR, w));
  if ((m & 8) != 0) c = max(c, segLine(p, BL, BR, w));
  if ((m & 16) != 0) c = max(c, segLine(p, ML, BL, w));
  if ((m & 32) != 0) c = max(c, segLine(p, TL, ML, w));
  if ((m & 64) != 0) c = max(c, segLine(p, ML, MR, w));
  return c;
}
// A stylised hazard symbol: a black trefoil on a yellow disc (p centred, unit ≈ the disc's radius).
float trefoil(vec2 p) {
  float r = length(p), a = atan(p.y, p.x);
  float blade = step(0.24, r) * step(r, 0.86) * step(fract(a * 0.4774648 + 0.5), 0.5);
  return max(blade, step(r, 0.17));
}
// The countdown: the symbol and MM:SS in red LED digits, hazard stripes round the edge.
vec3 countPict(vec2 l, float aspect, float secs) {
  vec2 P = vec2(l.x * aspect, l.y);
  float edge = min(min(P.x, aspect - P.x), min(P.y, 1.0 - P.y));
  vec3 c = vec3(0.015, 0.01, 0.01);
  if (edge < 0.07) c = mix(vec3(0.02), vec3(1.0, 0.75, 0.0), step(0.5, fract((P.x + P.y) * 5.0)));
  bool wide = aspect > 1.6;
  vec2 sc = wide ? vec2(0.55, 0.5) : vec2(aspect * 0.5, 0.67);
  float sr = wide ? 0.34 : min(0.22, aspect * 0.36);
  vec2 sp = (P - sc) / sr;
  float blink = secs < 30.0 ? step(0.35, fract(uTime * 2.0)) : 1.0;
  if (length(sp) < 1.0) c = mix(vec3(1.0, 0.78, 0.0), vec3(0.02), trefoil(sp)) * mix(0.25, 1.0, blink);
  // MM:SS.
  float m = floor(secs / 60.0), s = floor(mod(secs, 60.0));
  vec2 d0 = wide ? vec2(1.05, 0.22) : vec2(aspect * 0.08, 0.1);
  float dw = wide ? (aspect - 1.15) / 4.6 : aspect * 0.84 / 4.6, dh = wide ? 0.56 : 0.3;
  dh = min(dh, dw * 1.8); dw = min(dw, dh / 1.3);
  vec2 q = (P - d0) / vec2(dw, dh);
  float lit = 0.0;
  if (q.y > 0.0 && q.y < 1.0 && q.x > 0.0 && q.x < 4.6) {
    float cell = q.x < 2.0 ? floor(q.x) : q.x < 2.6 ? -1.0 : floor(q.x - 0.6);
    vec2 f = vec2(q.x < 2.0 ? fract(q.x) : fract(q.x - 0.6), q.y);
    int dd = cell == 0.0 ? int(mod(floor(m / 10.0), 10.0)) : cell == 1.0 ? int(mod(m, 10.0)) : cell == 2.0 ? int(floor(s / 10.0)) : int(mod(s, 10.0));
    if (cell >= 0.0) lit = digit7(f, dd);
    else lit = step(length(vec2((q.x - 2.3) * 0.6, q.y - 0.3)), 0.07) + step(length(vec2((q.x - 2.3) * 0.6, q.y - 0.7)), 0.07);
  }
  c = mix(c, vec3(1.0, 0.18, 0.04) * 1.6, clamp(lit, 0.0, 1.0));
  return c;
}
// The live feed: the news drone's picture, scan lines, a blinking red dot, viewfinder corners.
vec3 feedPict(vec2 l, float aspect) {
  vec2 k = vec2(min(1.0, aspect / 1.7778), min(1.0, 1.7778 / aspect));
  vec3 f = texture2D(uFeed, (l - 0.5) * k + 0.5).rgb;
  f = f / (1.0 + f);
  f = f * f * 1.5 * (0.92 + 0.08 * sin(l.y * 420.0 - uTime * 30.0));
  vec2 P = vec2(l.x * aspect, l.y);
  float dotR = length(P - vec2(0.12, 0.86));
  f = mix(f, vec3(1.0, 0.05, 0.03), step(dotR, 0.045) * step(0.4, fract(uTime * 0.9)));
  vec2 e = min(P, vec2(aspect, 1.0) - P);
  float corner = step(min(e.x, e.y), 0.03) * step(max(e.x, e.y), 0.14) * step(0.012, min(e.x, e.y));
  return mix(f, vec3(0.9), corner);
}
// City news (pictograms): 1 the city lost — a mushroom cloud over a broken skyline; 2 all clear — a
// check over the skyline; 3 the monster brought down — its body lying before the skyline.
vec3 newsPict(vec2 l, float aspect, float kind) {
  vec2 P = vec2((l.x - 0.5) * aspect, l.y);
  vec3 bg = kind < 1.5 ? mix(vec3(0.25, 0.02, 0.0), vec3(0.06, 0.0, 0.0), l.y) : kind < 2.5 ? mix(vec3(0.05, 0.35, 0.12), vec3(0.02, 0.15, 0.05), l.y) : mix(vec3(0.05, 0.12, 0.3), vec3(0.02, 0.04, 0.12), l.y);
  vec3 fg = kind < 1.5 ? vec3(0.02) : vec3(0.9, 0.95, 0.9);
  float bx = floor(P.x * 9.0), hgt = 0.12 + 0.22 * sh1(bx * 3.7 + 1.0);
  if (kind < 1.5 && abs(P.x) < 0.3) hgt *= 0.25 + 0.2 * sh1(bx * 5.1);
  vec3 c = mix(bg, fg, step(l.y, hgt) * step(abs(P.x), aspect * 0.48));
  if (kind < 1.5) {
    float cap = step(length((P - vec2(0.0, 0.7)) * vec2(1.0, 1.5)), 0.2), stem = step(abs(P.x), 0.05 + 0.03 * (0.62 - l.y)) * step(0.2, l.y) * step(l.y, 0.62);
    c = mix(c, mix(vec3(1.0, 0.45, 0.1), vec3(0.45, 0.4, 0.36), l.y), max(cap, stem) * (0.85 + 0.15 * sin(uTime * 3.0)));
  } else if (kind < 2.5) {
    float ck = max(segLine(P, vec2(-0.16, 0.66), vec2(-0.05, 0.54), 0.05), segLine(P, vec2(-0.05, 0.54), vec2(0.2, 0.84), 0.05));
    c = mix(c, vec3(1.0), ck);
  } else {
    float body = step(length((P - vec2(-0.05, 0.12)) * vec2(1.0, 3.2)), 0.32) + step(length(P - vec2(0.3, 0.13)), 0.07) + step(length((P - vec2(-0.45, 0.08)) * vec2(1.0, 5.0)), 0.18);
    c = mix(c, vec3(0.15, 0.17, 0.2), clamp(body, 0.0, 1.0));
    float ck = max(segLine(P, vec2(0.18, 0.7), vec2(0.26, 0.62), 0.035), segLine(P, vec2(0.26, 0.62), vec2(0.42, 0.84), 0.035));
    c = mix(c, vec3(0.3, 1.0, 0.4), ck);
  }
  return c;
}
// Red alert: a white warning triangle with a black "!" on a flashing red field (no text).
vec3 alertPict(vec2 l, float aspect) {
  vec2 p = (l - 0.5) * vec2(aspect, 1.0) / min(1.0, aspect);
  float on = step(0.5, fract(uTime * 1.2));
  vec3 c = mix(vec3(0.35, 0.0, 0.0), vec3(1.0, 0.04, 0.02), on);
  float tri = step(-0.32, p.y) * step(p.y, 0.36) * step(abs(p.x), (0.36 - p.y) * 0.62);
  float inner = step(-0.25, p.y) * step(p.y, 0.25) * step(abs(p.x), (0.25 - p.y) * 0.6);
  float bang = step(abs(p.x), 0.033) * step(-0.06, p.y) * step(p.y, 0.17) + step(length(p - vec2(0.0, -0.15)), 0.042);
  c = mix(c, vec3(1.0, 0.04, 0.02), tri);
  c = mix(c, vec3(1.0, 0.95, 0.85), inner);
  c = mix(c, vec3(0.02), inner * min(1.0, bang));
  return c;
}
vec3 slide(float i, vec2 l) {
  float col = mod(i, 4.0), row = floor(i / 4.0);
  vec2 a = vec2(col * 0.25, 1.0 - (1536.0 + (row + 1.0) * 256.0) / 2048.0);
  return texture2D(uAtlas, a + l * vec2(0.25, 0.125) * 0.994 + 0.003 * vec2(0.25, 0.125)).rgb;
}
// A slide show's slot: slots 2 and 6 show a city news card when there are some (two across, four down).
vec3 slideOr(float i, vec2 l, float seed) {
  if (uCards.x > 0.5 && (i == 2.0 || i == 6.0)) {
    float k = mod(floor(seed * 13.0) + i * 0.5 + floor(uTime / 64.0), uCards.x);
    float col = mod(k, 2.0), row = floor(k / 2.0);
    vec2 q = clamp(l, 0.004, 0.996);
    return texture2D(uCardTex, vec2((col + q.x) * 0.5, 1.0 - (row + 1.0 - q.y) * 0.25)).rgb;
  }
  return slide(i, l);
}`)
        .replace('#include <map_fragment>', `
{
  int mode = int(vSign.x + 0.5);
  float seed = vSign.y, state = vSign.z;
  vec2 l = vL;
  if (mode == 1) l.x = fract(l.x + uTime * 0.07 + seed);
  vec3 c = texture2D(uAtlas, mix(vRect.xy, vRect.zw, l)).rgb;
  if (mode == 2) { // a light sweep across every few seconds
    float p = fract(uTime * 0.12 + seed) * 3.0 - 1.0;
    c *= 1.0 + 0.9 * smoothstep(0.12, 0.0, abs(l.x + l.y * 0.25 - p));
  } else if (mode == 3) { // slide show with a wipe
    float tt = uTime / 8.0 + seed * 8.0;
    float i0 = mod(floor(tt), 8.0), i1 = mod(i0 + 1.0, 8.0);
    float w = smoothstep(0.92, 1.0, fract(tt));
    c = mix(slideOr(i0, l, seed), slideOr(i1, l, seed), step(l.x, w));
    c *= 0.9 + 0.1 * sin(l.x * 6.0 - uTime * 0.7 + l.y * 3.0);
  } else if (mode == 4) { // letters light up top to bottom, then all blink
    float p = fract(uTime * 0.22 + seed) * 1.4;
    c *= p < 1.0 ? mix(0.25, 1.0, step(1.0 - l.y, p)) : 0.6 + 0.4 * step(0.5, fract(p * 20.0));
  }
  // LED pixels and a faint refresh band.
  vec2 cnt = vec2(vSign.w, vSign.w * (vRect.w - vRect.y) / (vRect.z - vRect.x));
  vec2 px = abs(fract(vL * cnt) - 0.5);
  float aa = clamp(1.0 - max(fwidth(vL.x * cnt.x), fwidth(vL.y * cnt.y)) * 1.5, 0.0, 1.0); // no moiré far away
  c *= 1.0 - 0.18 * aa * (1.0 - smoothstep(0.5, 0.3, max(px.x, px.y)));
  c *= 0.97 + 0.03 * sin(vL.y * 40.0 - uTime * 9.0);
  if (state < 0.75) { // damaged: drop-outs, a torn colour band
    float n = sh1(floor(uTime * 14.0) + seed * 91.0);
    c *= n < 0.35 ? 0.05 : n < 0.5 ? 0.5 : 1.0;
    if (abs(vL.y - fract(uTime * 0.5 + seed)) < 0.06) c = c.gbr * 1.4;
  }
  float asp = (vRect.z - vRect.x) / max(1e-4, vRect.w - vRect.y);
  if (vNews > 0.0 && state > 0.25) c = mix(c, newsPict(vL, asp, uNews.x), vNews);
  if (vAlert > 0.0 && state > 0.25) c = mix(c, alertPict(vL, asp), vAlert);
  if (vFeed > 0.0 && state > 0.25) c = mix(c, feedPict(vL, asp), vFeed);
  if (vCount > 0.0 && state > 0.25) c = mix(c, countPict(vL, asp, uCount.w), vCount);
  diffuseColor.rgb = c * mix(1.15, 2.7, uNight);
}`);
    };
    m.customProgramCacheKey = () => 'future-sign-v4';
    return m;
  }

  private holoMaterial(): THREE.MeshBasicMaterial {
    if (WEBGPU) return gpuKit().createHoloNodeMaterial(this.uniforms) as unknown as THREE.MeshBasicMaterial;
    const m = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
    const u = this.uniforms;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = u.uTime; sh.uniforms.uAtlas = u.uAtlas; sh.uniforms.uNight = u.uNight;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec2 sUv; attribute vec4 iRect; attribute vec4 iSign;
varying vec2 vL; varying vec4 vRect; varying vec4 vSign;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vL = sUv; vRect = iRect; vSign = iSign;`)
        .replace('#include <project_vertex>', `
// Cylindrical billboard: always turned to the camera, upright, with a slow hover.
vec4 cW = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
vec3 rt = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]) + 1e-5);
float sx = length(instanceMatrix[0].xyz), sy = length(instanceMatrix[1].xyz);
cW.y += 0.04 * sin(uTime * 1.3 + iSign.y * 20.0);
vec4 mvPosition = viewMatrix * vec4(cW.xyz + rt * transformed.x * sx + vec3(0.0, transformed.y * sy, 0.0), 1.0);
gl_Position = projectionMatrix * mvPosition;`);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform float uTime; uniform float uNight; uniform sampler2D uAtlas;
varying vec2 vL; varying vec4 vRect; varying vec4 vSign;`)
        .replace('#include <map_fragment>', `
{
  vec2 l = vL;
  float g = step(0.985, fract(uTime * 0.13 + vSign.y)); // rare glitch: a sideways jump
  l.x += g * 0.04 * sin(l.y * 80.0);
  vec3 c = texture2D(uAtlas, mix(vRect.xy, vRect.zw, clamp(l, 0.0, 1.0))).rgb;
  float lum = max(c.r, max(c.g, c.b));
  float scan = 0.6 + 0.4 * smoothstep(0.3, 0.7, fract(l.y * 60.0 - uTime * 2.0));
  float band = 1.0 + 0.8 * smoothstep(0.05, 0.0, abs(fract(uTime * 0.35 + vSign.y) - l.y));
  float fade = smoothstep(0.0, 0.18, l.y) * smoothstep(1.0, 0.9, l.y);
  vec3 tint = vec3(0.35, 0.85, 1.0);
  float beam = 1.0 - abs(l.x * 2.0 - 1.0);
  diffuseColor.rgb = tint * (lum * scan * band + 0.04 * beam * beam * (1.0 - l.y)) * fade * mix(0.9, 1.8, uNight);
}`);
    };
    m.customProgramCacheKey = () => 'future-holo-v1';
    return m;
  }
}

function nearPolyline(pts: number[], x: number, z: number, r: number): boolean {
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const ax = pts[k], az = pts[k + 1], bx = pts[k + 2], bz = pts[k + 3];
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    if (Math.hypot(ax + dx * t - x, az + dz * t - z) < r) return true;
  }
  return false;
}

/** A 1×1 black texture: the live-feed sampler is always bound (one program), the feed swaps it in. */
let black: THREE.DataTexture | null = null;
function blackTexture(): THREE.DataTexture {
  if (!black) { black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat); black.needsUpdate = true; }
  return black;
}
