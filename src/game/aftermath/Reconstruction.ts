/**
 * Reconstruction (THREATS_PLAN §3 lifecycle "then scaffolding and cranes; reconstruction later",
 * Phase E): `game.aftermath.rebuild`. Damaged buildings get rebuilt over game hours to days.
 *
 *  - Every building that loses wall panels, slab tiles or its upper floors is logged (Destruction
 *    onDamage / onCollapse): where it stands, its footprint and its height as built.
 *  - When the damage round it has stopped for `quietH` game hours and no major incident is
 *    running nearby, the crews move in: damaged buildings close together become one site. A site
 *    gets scaffolding with netting round every damaged building (to its old height; round a
 *    collapsed one it climbs as the work goes on), a fence round collapsed plots, a site board,
 *    and a tower crane beside the worst-hit building, its jib slowly turning. A few broken panels
 *    only (no scaffolding) are mended quietly.
 *  - A district levelled by the last resort becomes one big site once its cordon is lifted: a
 *    fence ring at its streets, cranes over it, rebuilt after `districtH`.
 *  - When a site's time is up, each building is made whole again (Destruction.repairBuilding:
 *    elements, slabs, height, rubble on its plot) the moment it is out of sight: off screen or far
 *    off, never while the player watches. Buildings in cells that are not loaded are rebuilt as
 *    their cells stream in, before they are drawn. Saves keep the log, the sites and what is due.
 *
 * Game time: absolute game hours (sky.hoursAbs), as the rest of the aftermath.
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import type { CellState } from '../../stream/CityStreamer';
import type { BuildingRef } from '../../world/WorldIndex';
import type { StaticProp } from './Aftermath';
import { BAY, MAST, JIB } from '../../props/construction';
import { hash32 } from '../../core/rng';

export const REBUILD = {
  /** Game hours without new damage round a building (and no major incident within `calmR` m) before work starts. */
  quietH: 2, calmR: 700,
  /** Fewer broken elements than this and nothing collapsed: mended without scaffolding. */
  smallElems: 8,
  /** A site's hours: base, per scaffolded building, per collapsed one, at most; quiet mends. */
  siteH: [10, 4, 10, 60] as [number, number, number, number], smallH: 6,
  /** A levelled district's hours (after its cordon is lifted). */
  districtH: 72,
  /** Damaged buildings within this of each other share a site (m). */
  clusterR: 70,
  /** Rebuilt only out of sight: always beyond `farDist`, off screen beyond `nearDist` (m). */
  farDist: 450, nearDist: 60,
  /** Props drawn for sites within this of the player (m). */
  drawR: 700,
  /** A district is rebuilt with the camera at least this far outside it (m). */
  districtAway: 200,
};

interface Rec {
  cell: number; index: number;
  x: number; z: number; poly: number[]; base: number; top0: number;
  /** Last damage (abs game hours), broken elements, came down (part or all), highest damage (m). */
  last: number; n: number; collapsed: boolean; maxY: number;
  /** Site id, or −1. */
  site: number;
}

interface Site {
  id: number; kind: 'block' | 'district';
  x: number; z: number; r: number;
  start: number; done: number;
  keys: string[];
  /** Mended quietly: no props. */
  small: boolean;
  crane: { x: number; z: number; h: number; yaw0: number } | null;
}

/** Saved: logged buildings, sites, rebuilds due when their cells stream in. */
export interface SaveRebuild {
  recs: [number, number, number, number, number, number, number, number, number, number, number][];
  polys: number[][];
  sites: [number, string, number, number, number, number, number, number, string][];
  pending: [number, number[]][];
  circles: [number, number, number, number[]][];
}

const KEY = (cell: number, index: number) => `${cell}:${index}`;
const STEEL: [number, number, number] = [0.55, 0.42, 0.28];
const NETS: [number, number, number][] = [[0.18, 0.42, 0.3], [0.2, 0.36, 0.6], [0.82, 0.82, 0.8]];
const YELLOW: [number, number, number] = [0.92, 0.7, 0.12];
const FENCE: [number, number, number] = [0.14, 0.3, 0.22];
const BOARD: [number, number, number] = [0.12, 0.28, 0.55];
const _box = new THREE.Box3(), _fr = new THREE.Frustum(), _pm = new THREE.Matrix4(), _v = new THREE.Vector3();

export class Reconstruction {
  private recs = new Map<string, Rec>();
  readonly sites: Site[] = [];
  /** Cells not loaded when their buildings fell due: building indices to rebuild as they stream in. */
  private pending = new Map<number, Set<number>>();
  /** Rebuilt districts with cells still to stream in: everything inside rebuilt as they do. */
  private circles: { x: number; z: number; r: number; cells: Set<number> }[] = [];
  private nextId = 1;
  private stepT = 0;
  private drawKey = '';
  stats = { logged: 0, sites: 0, districts: 0, rebuilt: 0, onLoad: 0, quiet: 0 };

  constructor(private g: Game) {
    const D = g.destruction;
    const dmg = D.onDamage, col = D.onCollapse;
    D.onDamage = (e) => { dmg?.(e); this.damaged(e.ref, e.n, e.y, false); };
    D.onCollapse = (e) => { col?.(e); this.damaged(e.ref, 1, e.ref.top, true); };
    const ready = g.streamer.onCellReady;
    g.streamer.onCellReady = (c) => { ready?.(c); try { this.cellReady(c); } catch (err) { console.warn('[rebuild]', err); } };
  }

  private get hours(): number { return this.g.sky.hoursAbs; }

  /** Log a damaged building (outside a levelled district: the district is one site). */
  private damaged(ref: BuildingRef, n: number, y: number, collapsed: boolean): void {
    const [x0, z0, x1, z1] = ref.bounds, x = (x0 + x1) / 2, z = (z0 + z1) / 2;
    if (this.g.aftermath.inZone(x, z)) return;
    const k = KEY(ref.cell.id, ref.index);
    let r = this.recs.get(k);
    if (!r) {
      const b = this.g.streamer.buildingInfo(ref.cell, ref.index);
      r = { cell: ref.cell.id, index: ref.index, x, z, poly: Array.from(ref.poly), base: ref.base, top0: b ? b.base + b.height : ref.top, last: 0, n: 0, collapsed: false, maxY: ref.base, site: -1 };
      this.recs.set(k, r);
      this.stats.logged++;
    }
    r.last = this.hours;
    r.n += n;
    r.collapsed ||= collapsed;
    r.maxY = Math.max(r.maxY, Math.min(r.top0, y));
  }

  update(dt: number): void {
    if ((this.stepT -= dt) > 0) return;
    this.stepT = 0.5;
    this.formSites();
    this.districts();
    this.finish();
    this.draw();
  }

  /** Crews move in where the damage has stopped: buildings close together make one site. */
  private formSites(): void {
    const now = this.hours, g = this.g;
    const busy = g.response.incidents.filter((i) => !i.closed && i.ev.tier === 'major' && i.ev.active).map((i) => i.ev);
    const free = [...this.recs.entries()].filter(([, r]) => r.site < 0 && now - r.last >= REBUILD.quietH && !busy.some((e) => Math.hypot(e.x - r.x, e.z - r.z) < REBUILD.calmR));
    while (free.length) {
      const [k0, r0] = free.shift()!;
      const group: [string, Rec][] = [[k0, r0]];
      for (let i = 0; i < group.length; i++) {
        for (let j = free.length - 1; j >= 0; j--) {
          if (Math.hypot(free[j][1].x - group[i][1].x, free[j][1].z - group[i][1].z) < REBUILD.clusterR) group.push(...free.splice(j, 1));
        }
      }
      const big = group.filter(([, r]) => this.scaffolded(r)), fallen = big.filter(([, r]) => r.collapsed).length;
      const small = !big.length;
      const H = small ? REBUILD.smallH : Math.min(REBUILD.siteH[3], REBUILD.siteH[0] + REBUILD.siteH[1] * big.length + REBUILD.siteH[2] * fallen);
      const cx = group.reduce((s, [, r]) => s + r.x, 0) / group.length, cz = group.reduce((s, [, r]) => s + r.z, 0) / group.length;
      const rr = Math.max(30, ...group.map(([, r]) => Math.hypot(r.x - cx, r.z - cz) + 25));
      const site: Site = { id: this.nextId++, kind: 'block', x: cx, z: cz, r: rr, start: now, done: now + H, keys: group.map(([k]) => k), small, crane: null };
      if (!small) site.crane = this.placeCrane(big.map(([, r]) => r));
      for (const [, r] of group) r.site = site.id;
      this.sites.push(site);
      if (small) this.stats.quiet++; else this.stats.sites++;
      this.drawKey = '';
    }
  }

  /** Worth scaffolding: a collapse, or more than a few broken panels. */
  private scaffolded(r: Rec): boolean { return r.collapsed || r.n >= REBUILD.smallElems; }

  /** A tower crane beside the tallest damaged building: on open ground just off its plot. */
  private placeCrane(list: Rec[]): Site['crane'] {
    const W = this.g.world, r = list.slice().sort((a, b) => (b.collapsed ? 1 : 0) - (a.collapsed ? 1 : 0) || b.top0 - a.top0)[0];
    const h = Math.max(25, Math.min(90, r.top0 - r.base + 14));
    const seed = hash32(r.cell * 7919 + r.index);
    // On its own plot when it came down (the plot is clear), else on open ground beside it.
    const cands: { x: number; z: number }[] = r.collapsed ? [{ x: r.x, z: r.z }] : [];
    let rad = 0;
    for (let i = 0; i < r.poly.length; i += 2) rad = Math.max(rad, Math.hypot(r.poly[i] - r.x, r.poly[i + 1] - r.z));
    for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2 + (seed % 100) / 16; cands.push({ x: r.x + Math.cos(a) * (rad + 6), z: r.z + Math.sin(a) * (rad + 6) }); }
    for (const c of cands) {
      if (W.buildingAt(c.x, c.z)) continue;
      if (W.wet(c.x, c.z)) continue;
      return { x: c.x, z: c.z, h, yaw0: (seed % 628) / 100 };
    }
    return null;
  }

  /** A levelled district becomes a site once its cordon is lifted (smoke gone). */
  private districts(): void {
    const A = this.g.aftermath, now = this.hours;
    for (const zn of A.zones) {
      if (now - zn.when < A.zoneLiftH || this.sites.some((s) => s.kind === 'district' && Math.abs(s.x - zn.x) < 1 && Math.abs(s.z - zn.z) < 1)) continue;
      const site: Site = { id: this.nextId++, kind: 'district', x: zn.x, z: zn.z, r: zn.r, start: now, done: now + REBUILD.districtH, keys: [], small: false, crane: null };
      this.sites.push(site);
      this.stats.districts++;
      this.drawKey = '';
    }
  }

  /** Is a box in view (on screen and not far)? */
  private seen(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number): boolean {
    const cam = this.g.renderer.camera, d = Math.hypot((x0 + x1) / 2 - cam.position.x, (z0 + z1) / 2 - cam.position.z);
    if (d > REBUILD.farDist) return false;
    if (d < REBUILD.nearDist) return true;
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _fr.setFromProjectionMatrix(_pm);
    return _fr.intersectsBox(_box.set(_v.set(x0, y0, z0), new THREE.Vector3(x1, y1, z1)));
  }

  /** Sites whose time is up: each building rebuilt once out of sight (or when its cell streams in). */
  private finish(): void {
    const now = this.hours, A = this.g.aftermath, cam = this.g.renderer.camera.position;
    for (let i = this.sites.length - 1; i >= 0; i--) {
      const s = this.sites[i];
      if (now < s.done) continue;
      if (s.kind === 'district') {
        if (Math.hypot(cam.x - s.x, cam.z - s.z) < s.r + REBUILD.districtAway) continue;
        A.removeZone(s.x, s.z);
        this.rebuildCircle(s.x, s.z, s.r);
        this.sites.splice(i, 1);
        this.drawKey = '';
        continue;
      }
      for (let k = s.keys.length - 1; k >= 0; k--) {
        const key = s.keys[k], r = this.recs.get(key);
        if (!r || this.rebuild(r)) { s.keys.splice(k, 1); this.recs.delete(key); this.drawKey = ''; }
      }
      if (!s.keys.length) { this.sites.splice(i, 1); this.drawKey = ''; }
    }
  }

  /** Rebuild one logged building: now when its cell is loaded and it is out of sight; its cell not loaded, when it streams in. */
  private rebuild(r: Rec): boolean {
    const ref = this.g.world.cellBuildings(r.cell)[r.index];
    if (!ref) {
      let s = this.pending.get(r.cell);
      if (!s) this.pending.set(r.cell, (s = new Set()));
      s.add(r.index);
      return true;
    }
    const [x0, z0, x1, z1] = ref.bounds;
    if (this.seen(x0, z0, x1, z1, ref.low, r.top0 + 4)) return false;
    this.repair(ref, r.top0);
    return true;
  }

  private repair(ref: BuildingRef, top0: number): void {
    this.g.destruction.repairBuilding(ref, top0);
    this.g.saves?.damage.forget(ref.cell.id, ref.index);
    this.g.aftermath.rescues.moundsSeen = this.g.destruction.mounds.length;
    this.stats.rebuilt++;
  }

  /** A district rebuilt: every building inside it in loaded cells now, the rest as their cells stream in. */
  private rebuildCircle(x: number, z: number, r: number): void {
    const S = this.g.streamer, cells = new Set<number>();
    for (const c of this.g.macro.cells) {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < c.poly.length; i += 2) { x0 = Math.min(x0, c.poly[i]); x1 = Math.max(x1, c.poly[i]); z0 = Math.min(z0, c.poly[i + 1]); z1 = Math.max(z1, c.poly[i + 1]); }
      if (x1 < x - r || x0 > x + r || z1 < z - r || z0 > z + r) continue;
      const cs = S.cells.get(c.id);
      if (cs?.status === 'ready') this.repairIn(cs, x, z, r);
      else cells.add(c.id);
    }
    if (cells.size) this.circles.push({ x, z, r, cells });
  }

  private repairIn(cs: CellState, x: number, z: number, r: number): void {
    for (const ref of this.g.world.cellBuildings(cs.id)) {
      const cx = (ref.bounds[0] + ref.bounds[2]) / 2, cz = (ref.bounds[1] + ref.bounds[3]) / 2;
      if (Math.hypot(cx - x, cz - z) >= r) continue;
      const b = this.g.streamer.buildingInfo(cs, ref.index);
      this.repair(ref, b ? b.base + b.height : ref.top);
    }
  }

  /** A cell streaming in: buildings due for rebuilding are rebuilt before it is drawn. */
  private cellReady(cs: CellState): void {
    const due = this.pending.get(cs.id);
    if (due) {
      this.pending.delete(cs.id);
      const refs = this.g.world.cellBuildings(cs.id);
      for (const i of due) { const ref = refs[i]; if (!ref) continue; const b = this.g.streamer.buildingInfo(cs, i); this.repair(ref, b ? b.base + b.height : ref.top); this.stats.onLoad++; }
    }
    for (let k = this.circles.length - 1; k >= 0; k--) {
      const c = this.circles[k];
      if (!c.cells.delete(cs.id)) continue;
      this.repairIn(cs, c.x, c.z, c.r);
      if (!c.cells.size) this.circles.splice(k, 1);
    }
  }

  // ---------------------------------------------------------------- the sites' props

  /** Scaffolding, nets, fences, boards and masts (static, near the player); the crane tops turn each frame. */
  private draw(): void {
    const g = this.g, p = g.player.pos, now = this.hours;
    // (Nearest first: the instance caps fill from there.)
    const near = this.sites.filter((s) => !s.small && Math.hypot(s.x - p.x, s.z - p.z) < REBUILD.drawR + s.r)
      .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    const key = `${Math.round(p.x / 100)},${Math.round(p.z / 100)}:` + near.map((s) => `${s.id}:${s.keys.length}:${Math.floor(this.progress(s, now) * 12)}`).join(',');
    if (key === this.drawKey) return;
    this.drawKey = key;
    const list: StaticProp[] = [];
    for (const s of near) {
      if (s.kind === 'district') this.districtProps(s, list, now);
      else for (const k of s.keys) { const r = this.recs.get(k); if (r && this.scaffolded(r)) this.buildingProps(r, s, list, now); }
      for (const c of this.cranesOf(s)) this.mastProps(c, list);
    }
    g.aftermath.setStatic('rebuild', list);
  }

  /** Crane tops (every frame: the jib slowly slews back and forth). */
  drawCranes(put: (x: number, y: number, z: number, yaw: number) => void): void {
    const p = this.g.player.pos, t = this.hours * 3600;
    for (const s of this.sites) {
      if (s.small || Math.hypot(s.x - p.x, s.z - p.z) > REBUILD.drawR + s.r) continue;
      for (const c of this.cranesOf(s)) {
        const y = this.g.world.groundHeight(c.x, c.z) + Math.ceil(c.h / MAST.h) * MAST.h;
        put(c.x, y, c.z, c.yaw0 + Math.sin(t / 240 + c.yaw0 * 3) * 1.1);
      }
    }
  }

  private cranesOf(s: Site): NonNullable<Site['crane']>[] {
    if (s.crane) return [s.crane];
    if (s.kind !== 'district') return [];
    const out: NonNullable<Site['crane']>[] = [], n = Math.max(2, Math.min(6, Math.round(s.r / 70)));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + 0.4, d = s.r * (k % 2 ? 0.55 : 0.3);
      const x = s.x + Math.cos(a) * d, z = s.z + Math.sin(a) * d;
      if (this.g.world.wet(x, z)) continue;
      out.push({ x, z, h: 40 + (hash32(k * 31 + Math.round(s.x)) % 30), yaw0: a + Math.PI / 2 });
    }
    return out;
  }

  private progress(s: Site, now: number): number { return Math.max(0, Math.min(1, (now - s.start) / Math.max(0.01, s.done - s.start))); }

  /** Scaffolding round one building, along each footprint edge, a little out from the wall; nets on the outer face. */
  /** A lamp post, signal, sign or tree standing where this bay (corner x, z; along u, out n) would go. */
  private poleIn(x: number, z: number, ux: number, uz: number, nx: number, nz: number): boolean {
    let hit = false;
    this.g.props.query(x + ux * BAY.w / 2 + nx * 0.9, z + uz * BAY.w / 2 + nz * 0.9, 1.6, (p) => {
      if (hit || p.broken || p.height < 2) return;
      const a = (p.x - x) * ux + (p.z - z) * uz, o = (p.x - x) * nx + (p.z - z) * nz;
      if (a > -p.radius && a < BAY.w + p.radius && o > -p.radius && o < 0.3 + BAY.d + 0.4 + p.radius) hit = true;
    });
    return hit;
  }

  private buildingProps(r: Rec, s: Site, out: StaticProp[], now: number): void {
    const W = this.g.world, k = this.progress(s, now);
    // Standing: to above the highest damage (all of it for a collapse); a collapsed one's frame climbs with the work.
    const H = r.collapsed ? Math.max(BAY.h, (r.top0 - r.base) * (0.15 + 0.85 * k)) : Math.min(r.top0 - r.base, r.maxY - r.base + 8);
    const lifts = Math.max(1, Math.ceil(H / BAY.h));
    const P = r.poly, n = P.length >> 1, ccw = signedArea(P) > 0;
    const net = NETS[hash32(r.cell * 131 + r.index) % NETS.length];
    for (let i = 0; i < n; i++) {
      const ax = P[i * 2], az = P[i * 2 + 1], bx = P[((i + 1) % n) * 2], bz = P[((i + 1) % n) * 2 + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 2) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      // Outward normal of this edge.
      const nx = ccw ? uz : -uz, nz = ccw ? -ux : ux;
      // The bay's +X runs along the edge, its +Z outwards: yaw so that local X = (ux, uz).
      const yaw = Math.atan2(-uz, ux);
      const bays = Math.max(1, Math.floor(L / BAY.w));
      const off = (L - bays * BAY.w) / 2;
      for (let b = 0; b < bays; b++) {
        const x = ax + ux * (off + b * BAY.w) + nx * 0.05, z = az + uz * (off + b * BAY.w) + nz * 0.05;
        const mx = x + ux * BAY.w / 2 + nx * 0.9, mz = z + uz * BAY.w / 2 + nz * 0.9;
        if (W.wet(mx, mz) || this.poleIn(x, z, ux, uz, nx, nz)) continue;
        const y0 = Math.max(r.base, W.groundHeight(mx, mz));
        for (let l = 0; l < lifts; l++) {
          out.push({ kind: 'scaffold', x, y: y0 + l * BAY.h, z, yaw, paint: STEEL });
          if ((l + b) % 3 !== 0 || l > 0) out.push({ kind: 'net', x, y: y0 + l * BAY.h, z, yaw, paint: net });
        }
      }
      // A fence round a collapsed plot, a few metres further out.
      if (r.collapsed) {
        const panels = Math.max(1, Math.floor((L + 6) / 3.5));
        for (let f = 0; f < panels; f++) {
          const x = ax - ux * 3 + ux * f * 3.5 + nx * 4, z = az - uz * 3 + uz * f * 3.5 + nz * 4;
          if (W.wet(x, z) || W.buildingAt(x, z)) continue;
          out.push({ kind: 'fence', x, y: W.groundHeight(x, z), z, yaw, paint: FENCE });
        }
      }
    }
    // The site board at the first edge's middle, facing out.
    if (n >= 2) {
      const ax = P[0], az = P[1], bx = P[2], bz = P[3], L = Math.hypot(bx - ax, bz - az) || 1, ux = (bx - ax) / L, uz = (bz - az) / L;
      const nx = ccw ? uz : -uz, nz = ccw ? -ux : ux, x = (ax + bx) / 2 + nx * 3.2, z = (az + bz) / 2 + nz * 3.2;
      if (!W.wet(x, z) && !W.buildingAt(x, z)) out.push({ kind: 'board', x, y: W.groundHeight(x, z), z, yaw: Math.atan2(nx, nz), paint: BOARD });
    }
  }

  /** A levelled district: a fence ring on its streets, scaffold frames climbing on the plots near its edge. */
  private districtProps(s: Site, out: StaticProp[], now: number): void {
    const W = this.g.world, n = Math.max(24, Math.round((Math.PI * 2 * s.r) / 3.5));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2, x = s.x + Math.cos(a) * s.r, z = s.z + Math.sin(a) * s.r;
      if (W.wet(x, z) || W.buildingAt(x, z)) continue;
      out.push({ kind: 'fence', x, y: W.groundHeight(x, z), z, yaw: -a - Math.PI / 2, paint: FENCE });
    }
    const k = this.progress(s, now), refs = W.buildingsIn(s.x - s.r, s.z - s.r, s.x + s.r, s.z + s.r);
    let shown = 0;
    for (const ref of refs) {
      const cx = (ref.bounds[0] + ref.bounds[2]) / 2, cz = (ref.bounds[1] + ref.bounds[3]) / 2;
      if (Math.hypot(cx - s.x, cz - s.z) > s.r * 0.95 || shown > 40) continue;
      if (hash32(ref.cell.id * 977 + ref.index) % 3 !== 0) continue;
      const b = this.g.streamer.buildingInfo(ref.cell, ref.index);
      if (!b) continue;
      shown++;
      const site = { ...s, start: s.start, done: s.done };
      this.buildingProps({ cell: ref.cell.id, index: ref.index, x: cx, z: cz, poly: Array.from(ref.poly), base: ref.base, top0: b.base + Math.min(b.height, 40), last: 0, n: 99, collapsed: true, maxY: ref.base, site: s.id }, site, out, s.start + (s.done - s.start) * k * 0.8);
    }
  }

  /** A crane's mast: sections up to its height. */
  private mastProps(c: NonNullable<Site['crane']>, out: StaticProp[]): void {
    const y0 = this.g.world.groundHeight(c.x, c.z), n = Math.ceil(c.h / MAST.h);
    for (let i = 0; i < n; i++) out.push({ kind: 'mast', x: c.x, y: y0 + i * MAST.h, z: c.z, yaw: c.yaw0, paint: YELLOW });
  }

  // ---------------------------------------------------------------- saves and dev

  saveState(): SaveRebuild {
    const r2 = (v: number) => Math.round(v * 100) / 100, r3 = (v: number) => Math.round(v * 1000) / 1000;
    const keys = [...this.recs.keys()], idx = new Map(keys.map((k, i) => [k, i]));
    return {
      recs: keys.map((k) => { const r = this.recs.get(k)!; return [r.cell, r.index, r2(r.x), r2(r.z), r2(r.base), r2(r.top0), r3(r.last), r.n, r.collapsed ? 1 : 0, r2(r.maxY), r.site]; }),
      polys: keys.map((k) => this.recs.get(k)!.poly.map(r2)),
      sites: this.sites.map((s) => [s.id, s.kind, r2(s.x), r2(s.z), r2(s.r), r3(s.start), r3(s.done), s.small ? 1 : 0, JSON.stringify({ k: s.keys.map((k) => idx.get(k) ?? -1), c: s.crane })]),
      pending: [...this.pending].map(([c, s]) => [c, [...s]]),
      circles: this.circles.map((c) => [r2(c.x), r2(c.z), r2(c.r), [...c.cells]]),
    };
  }

  restore(d: SaveRebuild | null | undefined): void {
    if (!d) return;
    const keys: string[] = [];
    d.recs.forEach(([cell, index, x, z, base, top0, last, n, col, maxY, site], i) => {
      const k = KEY(cell, index);
      keys.push(k);
      this.recs.set(k, { cell, index, x, z, poly: d.polys[i] ?? [], base, top0, last, n, collapsed: !!col, maxY, site });
    });
    for (const [id, kind, x, z, r, start, done, small, extra] of d.sites) {
      let e: { k: number[]; c: Site['crane'] } = { k: [], c: null };
      try { e = JSON.parse(extra); } catch { /* old or broken: no buildings */ }
      this.sites.push({ id, kind: kind === 'district' ? 'district' : 'block', x, z, r, start, done, small: !!small, keys: e.k.map((i) => keys[i]).filter(Boolean), crane: e.c });
      this.nextId = Math.max(this.nextId, id + 1);
    }
    for (const [c, list] of d.pending) this.pending.set(c, new Set(list));
    for (const [x, z, r, cells] of d.circles) this.circles.push({ x, z, r, cells: new Set(cells) });
    // Cells already loaded.
    for (const cs of this.g.streamer.cells.values()) if (cs.status === 'ready') this.cellReady(cs);
    this.drawKey = '';
  }

  status(): Record<string, unknown> {
    const now = this.hours;
    return {
      logged: this.recs.size, pending: [...this.pending.values()].reduce((s, v) => s + v.size, 0), circles: this.circles.length, stats: this.stats,
      sites: this.sites.map((s) => ({ id: s.id, kind: s.kind, x: Math.round(s.x), z: Math.round(s.z), r: Math.round(s.r), buildings: s.keys.length, small: s.small, crane: !!s.crane, progress: +this.progress(s, now).toFixed(2), left: +(s.done - now).toFixed(2) })),
    };
  }

  /** Dev: every site's time up now (with `start`: start the crews on everything logged now). */
  devHurry(start = true): string {
    if (start) for (const r of this.recs.values()) r.last = Math.min(r.last, this.hours - REBUILD.quietH - 0.01);
    this.formSites();
    for (const s of this.sites) { s.start -= 1000; s.done = this.hours; }
    for (const zn of this.g.aftermath.zones) zn.when = Math.min(zn.when, this.hours - this.g.aftermath.zoneLiftH - 0.01);
    this.districts();
    for (const s of this.sites) s.done = this.hours;
    this.drawKey = '';
    return `${this.sites.length} sites due`;
  }

  /** Dev: the crews in now, halfway through (to look at the sites). */
  devHalfway(): string {
    for (const r of this.recs.values()) r.last = Math.min(r.last, this.hours - REBUILD.quietH - 0.01);
    for (const zn of this.g.aftermath.zones) zn.when = Math.min(zn.when, this.hours - this.g.aftermath.zoneLiftH - 0.01);
    this.formSites();
    this.districts();
    for (const s of this.sites) { const H = s.done - s.start; s.start = this.hours - H / 2; s.done = this.hours + H / 2; }
    this.drawKey = '';
    return `${this.sites.length} sites`;
  }
}

function signedArea(P: number[]): number {
  let a = 0;
  for (let i = 0, n = P.length >> 1; i < n; i++) { const j = (i + 1) % n; a += P[i * 2] * P[j * 2 + 1] - P[j * 2] * P[i * 2 + 1]; }
  return a / 2;
}

