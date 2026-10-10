/**
 * City map data and its tile renderer (2D canvas).
 *
 * Static content is rendered into a pyramid of cached 512 px tiles over one
 * square covering the city: level 0 is the whole square, every level halves
 * the tile size. Tiles are drawn lazily (nearest the view first, within a
 * per-frame time budget) and kept in an LRU cache; the full map and the
 * minimap only blit them. Detail follows the tile resolution: districts,
 * water, arterials and metro always; local streets, parks and building
 * footprints once they are legible.
 *
 * Data: the macro plan (cells, arterials, bridges, metro, sewers, landmarks), the terrain
 * (hillshade, rivers, sea) and per-cell items that arrive with the skyline
 * batches (building boxes, local streets, parks, plazas, metro entrances) —
 * the whole city without loading it in detail.
 */
import type { MacroPlan, District } from '../../plan/types';
import type { Terrain } from '../../world/terrain';
import { seaPolygon } from '../../plan/water';
import { pointInPoly } from '../../core/geom2';
import { SKY_STRIDE, MapItem } from '../../stream/protocol';
import { landmarkParts, partFootprints, solidFootprints } from '../../plan/landmarkParts';

export const TILE_PX = 512;

export interface MapLayers { metro: boolean; buildings: boolean; labels: boolean; sewers: boolean; crime: boolean; turf: boolean }

/** Villain group turf for the map (game/factions): the holder per macro cell, a colour per group, the borders. */
export interface MapTurf {
  holder: Int8Array;
  colors: string[];
  /** Cell edges where a group's turf ends (its colour, on its side). */
  borders: { pts: number[]; box: [number, number, number, number]; group: number }[];
}

/** A metro entrance as the cell planner placed it (opening centre, long axis u). */
export interface MapEntrance { x: number; z: number; ux: number; uz: number; station: number; end: number }

// Palette: light "paper" map, readable under any time of day in the game.
export const MAP_COLORS = {
  land: '#ece7dc',
  outside: '#e2ddd2',
  water: '#a8cbe7',
  waterEdge: '#87b2d6',
  park: '#c3dcaa',
  plaza: '#e3dccf',
  bld: ['#dcd3c6', '#d0c6b8', '#c0b6ab'],
  bldEdge: '#b6aa9a',
  street: '#ffffff',
  streetCase: '#d3c9b9',
  path: '#f6f1e6',
  avenue: '#ffffff',
  avenueCase: '#bfb19b',
  boulevard: '#fbdf98',
  boulevardCase: '#d4a548',
  bridgeCase: '#5f574e',
  sewer: '#8d6b3f',
  /** Landmarks: buildings, paving (aprons, runways), pitches, running tracks, roads. */
  landmark: ['', '#b9a58c', '#cfcac0', '#9dcd85', '#d98a70', '#fbf8f0'],
  landmarkEdge: '#8f7b63',
};

const DISTRICT_TINT: Partial<Record<District, string>> = {
  downtown: '#e0d6c9',
  commercial: '#e5dccf',
  oldtown: '#e8d8c2',
  apartments: '#e6e0d5',
  rowhouses: '#e8dccf',
  suburban: '#e7e8d8',
  industrial: '#dbdad6',
  port: '#d7dce0',
  park: MAP_COLORS.park,
};

export function hexColor(c: number): string {
  return '#' + c.toString(16).padStart(6, '0');
}

interface Chunk { pts: number[]; box: [number, number, number, number] }
interface RiverChunk extends Chunk { hw: number }
interface MetroChunk extends Chunk { line: number }

interface Tile {
  L: number;
  tx: number;
  ty: number;
  canvas: HTMLCanvasElement;
  ready: boolean;
  stale: boolean;
  used: number;
  /** A drawing in progress (split into parts over several frames): its canvas and the next part. */
  next: HTMLCanvasElement | null;
  part: number;
}

export function boxOf(pts: ArrayLike<number>, i0 = 0, i1 = pts.length): [number, number, number, number] {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = i0; i < i1; i += 2) {
    const x = pts[i], z = pts[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return [x0, z0, x1, z1];
}

/** Split a polyline into overlapping chunks of n points (cheap culling). */
function chunks(pts: ArrayLike<number>, n: number): Chunk[] {
  const out: Chunk[] = [];
  const N = pts.length >> 1;
  for (let i = 0; i < N - 1; i += n - 1) {
    const j = Math.min(N, i + n);
    const p: number[] = [];
    for (let k = i * 2; k < j * 2; k++) p.push(pts[k]);
    out.push({ pts: p, box: boxOf(p) });
  }
  return out;
}

/** Everything the map draws, indexed for cheap culling. */
export class MapWorld {
  /** Half side of the map square (centred on the origin). */
  readonly half: number;
  readonly cellBox: Float64Array;
  /** Skyline records per cell (subarray of a batch), null until the batch arrived. */
  readonly cellBld: (Float32Array | null)[];
  /** Packed map items per cell (see MapItem). */
  readonly cellItems: (Float32Array | null)[];
  readonly entrances = new Map<number, MapEntrance[]>();
  readonly edgeBox: Float64Array;
  readonly rivers: RiverChunk[] = [];
  readonly metro: MetroChunk[] = [];
  readonly sea: number[] | null;
  /** Elevation tint + hillshade over the map square (filled progressively). */
  readonly shade: HTMLCanvasElement;
  shadeDone = false;
  cellsKnown = 0;
  /** Street-crime index per cell (0..1, game/crime/CrimeIndex), set by the crime layer. */
  crimeIndex: Float32Array | null = null;
  /** Villain group turf, set by the crime layer. */
  turf: MapTurf | null = null;
  /** Landmark footprints (map category, outline, bounds), drawn at every zoom. */
  readonly landmarkShapes: { cat: number; poly: number[]; box: [number, number, number, number] }[] = [];
  /** Ground outlines of the landmarks' solid parts (safe spots stay off them). */
  private landmarkSolids: { poly: number[]; box: [number, number, number, number] }[] = [];

  constructor(readonly macro: MacroPlan, readonly terrain: Terrain) {
    const R = terrain.profile.radius;
    // The square reaches out to the landmarks (the airport lies beyond the city).
    let half = R * 1.3 + 400;
    for (const l of macro.landmarks ?? []) half = Math.max(half, Math.max(Math.abs(l.x), Math.abs(l.z)) + Math.hypot(l.hu, l.hv) + 300);
    this.half = Math.ceil(half / 100) * 100;
    for (const l of macro.landmarks ?? []) {
      const parts = landmarkParts(l, terrain);
      for (const f of partFootprints(parts)) this.landmarkShapes.push({ ...f, box: boxOf(f.poly) });
      for (const p of solidFootprints(l, parts, 0)) this.landmarkSolids.push({ poly: p, box: boxOf(p) });
    }
    const n = macro.cells.length;
    this.cellBox = new Float64Array(n * 4);
    macro.cells.forEach((c, i) => this.cellBox.set(boxOf(c.poly), i * 4));
    this.cellBld = new Array(n).fill(null);
    this.cellItems = new Array(n).fill(null);
    this.edgeBox = new Float64Array(macro.edges.length * 4);
    macro.edges.forEach((e, i) => this.edgeBox.set(boxOf(e.pts), i * 4));
    terrain.rivers.forEach((r, ri) => {
      for (const c of chunks(r.pts, 10)) {
        // Width at the chunk's middle (the river widens slowly downstream).
        const mx = (c.box[0] + c.box[2]) / 2, mz = (c.box[1] + c.box[3]) / 2;
        let best = 0, bd = Infinity;
        for (let k = 0; k < r.pts.length; k += 2) {
          const d = (r.pts[k] - mx) ** 2 + (r.pts[k + 1] - mz) ** 2;
          if (d < bd) { bd = d; best = k >> 1; }
        }
        this.rivers.push({ ...c, hw: terrain.riverHalfWidthAt(ri, r.s[best]) });
      }
    });
    macro.metroLines.forEach((l, li) => { for (const c of chunks(l.pts, 40)) this.metro.push({ ...c, line: li }); });
    this.sea = seaPolygon(terrain, 0, 60);
    const SH = 320;
    this.shade = document.createElement('canvas');
    this.shade.width = this.shade.height = SH;
  }

  /** A skyline batch arrived: keep its building records and map items per cell. Returns the batch bounds. */
  addBatch(cells: number[], records: Float32Array, counts: number[], map: Float32Array, mapOff: Int32Array): [number, number, number, number] {
    let o = 0;
    const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    cells.forEach((id, i) => {
      const n = counts[i] * SKY_STRIDE;
      this.cellBld[id] = records.subarray(o, o + n);
      o += n;
      const items = map.subarray(mapOff[i], mapOff[i + 1]);
      this.cellItems[id] = items;
      this.cellsKnown++;
      for (let k = 0; k < items.length; k += 4 + items[k + 3] * 2) {
        if (items[k] !== MapItem.Entrance) continue;
        const st = items[k + 1];
        let l = this.entrances.get(st);
        if (!l) this.entrances.set(st, (l = []));
        l.push({ x: items[k + 4], z: items[k + 5], ux: items[k + 6], uz: items[k + 7], station: st, end: items[k + 2] });
      }
      const b = this.cellBox;
      box[0] = Math.min(box[0], b[id * 4]); box[1] = Math.min(box[1], b[id * 4 + 1]);
      box[2] = Math.max(box[2], b[id * 4 + 2]); box[3] = Math.max(box[3], b[id * 4 + 3]);
    });
    return box;
  }

  /** Cell containing a point (-1 outside the city). */
  cellAt(x: number, z: number): number {
    const b = this.cellBox, cells = this.macro.cells;
    for (let i = 0; i < cells.length; i++) {
      if (x < b[i * 4] || x > b[i * 4 + 2] || z < b[i * 4 + 1] || z > b[i * 4 + 3]) continue;
      if (pointInPoly(cells[i].poly, x, z)) return i;
    }
    return -1;
  }

  /** Is the point inside a building footprint (with margin)? null when the cell's buildings are not known yet. */
  inBuilding(x: number, z: number, margin: number): boolean | null {
    for (const s of this.landmarkSolids) {
      const b = s.box;
      if (x < b[0] - margin || x > b[2] + margin || z < b[1] - margin || z > b[3] + margin) continue;
      if (pointInPoly(s.poly, x, z)) return true;
    }
    const c = this.cellAt(x, z);
    if (c < 0) return false;
    const R = this.cellBld[c];
    if (!R) return null;
    for (let o = 0; o < R.length; o += SKY_STRIDE) {
      const dx = x - R[o], dz = z - R[o + 1];
      if (Math.abs(dx) > R[o + 2] + R[o + 3] + margin || Math.abs(dz) > R[o + 2] + R[o + 3] + margin) continue;
      const ca = Math.cos(R[o + 4]), sa = Math.sin(R[o + 4]);
      const u = dx * ca + dz * sa, v = -dx * sa + dz * ca;
      if (Math.abs(u) < R[o + 2] + margin && Math.abs(v) < R[o + 3] + margin) return true;
    }
    return false;
  }

  /**
   * Fill the hillshade raster a slice at a time (keeps frames smooth); calls
   * done() once finished.
   */
  buildShade(done: () => void): void {
    const SH = this.shade.width;
    const t = this.terrain, half = this.half;
    const step = (half * 2) / SH;
    const H = new Float32Array((SH + 1) * (SH + 1));
    let row = 0;
    const slice = () => {
      const t0 = performance.now();
      while (row <= SH && performance.now() - t0 < 6) {
        for (let i = 0; i <= SH; i++) H[row * (SH + 1) + i] = t.height(-half + i * step, -half + row * step);
        row++;
      }
      if (row <= SH) { setTimeout(slice, 0); return; }
      let lo = Infinity, hi = -Infinity;
      for (const h of H) { if (h < lo) lo = h; if (h > hi) hi = h; }
      const g = this.shade.getContext('2d')!;
      const img = g.createImageData(SH, SH);
      // Light from the north-west, slopes exaggerated so gentle hills still read.
      const ex = 3 / step;
      const flat = 1.5 / Math.sqrt(4.25);
      for (let j = 0; j < SH; j++) {
        for (let i = 0; i < SH; i++) {
          const h00 = H[j * (SH + 1) + i];
          const gx = (H[j * (SH + 1) + i + 1] - h00) * ex, gz = (H[(j + 1) * (SH + 1) + i] - h00) * ex;
          const lit = (gx + gz + 1.5) / (Math.sqrt(gx * gx + 1 + gz * gz) * Math.sqrt(4.25)) / flat;
          const s = Math.max(0.82, Math.min(1.08, 0.88 + 0.12 * lit));
          const e = hi > lo ? (h00 - lo) / (hi - lo) : 0;
          // Low ground warm paper, high ground slightly darker and greener.
          const r = (236 - 14 * e) * s, gg = (231 - 8 * e) * s, b = (220 - 20 * e) * s;
          const o = (j * SH + i) * 4;
          img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
      this.shadeDone = true;
      done();
    };
    setTimeout(slice, 0);
  }
}

/** Lazily rendered, LRU-cached tile pyramid over the map square. */
export class MapTiles {
  readonly size: number;
  readonly maxLevel: number;
  private tiles = new Map<number, Tile>();
  private frame = 0;
  private cap = 110;
  /** Total time spent rendering tiles (ms) and tile count, for diagnostics. */
  stats = { ms: 0, tiles: 0 };

  constructor(readonly world: MapWorld, readonly layers: MapLayers) {
    this.size = world.half * 2;
    // Finest level ≈ 0.2 m per tile pixel.
    this.maxLevel = Math.max(0, Math.ceil(Math.log2(this.size / (TILE_PX * 0.2))));
  }

  /** Level whose tiles have at least `devPxPerM` device pixels per metre. */
  levelFor(devPxPerM: number): number {
    const L = Math.ceil(Math.log2((this.size * devPxPerM) / TILE_PX) - 0.2);
    return Math.max(0, Math.min(this.maxLevel, L));
  }

  tileSize(L: number): number { return this.size / (1 << L); }

  private key(L: number, tx: number, ty: number): number { return L * 1e7 + ty * 4096 + tx; }

  beginFrame(): void { this.frame++; }

  /** Rendered tile (possibly stale) or null; marks it used. */
  peek(L: number, tx: number, ty: number): Tile | null {
    const t = this.tiles.get(this.key(L, tx, ty));
    if (!t || !t.ready) return null;
    t.used = this.frame;
    return t;
  }

  /**
   * Draw the tiles covering a view. `toScreen` maps a world point to screen
   * (CSS) pixels via scale s (px per m) and offset ox/oy (screen position of
   * world 0,0). Missing tiles are drawn from a coarser ancestor and queued.
   */
  drawView(g: CanvasRenderingContext2D, L: number, s: number, ox: number, oy: number, vw: number, vh: number, queue: { L: number; tx: number; ty: number; d: number; stale: boolean }[]): void {
    const ts = this.tileSize(L), n = 1 << L, half = this.world.half;
    const tx0 = Math.max(0, Math.floor((-ox / s + half) / ts)), tx1 = Math.min(n - 1, Math.floor(((vw - ox) / s + half) / ts));
    const ty0 = Math.max(0, Math.floor((-oy / s + half) / ts)), ty1 = Math.min(n - 1, Math.floor(((vh - oy) / s + half) / ts));
    const cx = vw / 2, cy = vh / 2;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const x0 = Math.floor(ox + (-half + tx * ts) * s), y0 = Math.floor(oy + (-half + ty * ts) * s);
        const x1 = Math.ceil(ox + (-half + (tx + 1) * ts) * s), y1 = Math.ceil(oy + (-half + (ty + 1) * ts) * s);
        const t = this.peek(L, tx, ty);
        const d = Math.hypot((x0 + x1) / 2 - cx, (y0 + y1) / 2 - cy);
        if (t) {
          g.drawImage(t.canvas, x0, y0, x1 - x0, y1 - y0);
          if (t.stale) queue.push({ L, tx, ty, d, stale: true });
          continue;
        }
        queue.push({ L, tx, ty, d, stale: false });
        // Fallback: the nearest rendered ancestor, scaled up.
        for (let k = 1; k <= L; k++) {
          const a = this.peek(L - k, tx >> k, ty >> k);
          if (!a) continue;
          const f = TILE_PX / (1 << k);
          const sx = (tx & ((1 << k) - 1)) * f, sy = (ty & ((1 << k) - 1)) * f;
          g.drawImage(a.canvas, sx, sy, f, f, x0, y0, x1 - x0, y1 - y0);
          break;
        }
      }
    }
  }

  /**
   * Render queued tiles (missing first, nearest first) within a time budget. Returns how many were
   * finished. With `split` > 1 a tile is drawn in split × split parts, as many per call as fit the
   * budget (at least one), and shows when its last part is drawn (a stale tile keeps its old
   * picture until then): a whole 512 px tile of dense city took 50-70 ms on a fast PC, a visible
   * hitch every time the minimap reached new ground.
   */
  renderQueue(queue: { L: number; tx: number; ty: number; d: number; stale: boolean }[], budgetMs: number, maxTiles = Infinity, split = 1): number {
    if (!queue.length) return 0;
    queue.sort((a, b) => (a.stale === b.stale ? a.d - b.d : a.stale ? 1 : -1));
    const t0 = performance.now();
    let done = 0, drew = false;
    for (const q of queue) {
      if (done >= maxTiles) break;
      if (split <= 1) {
        if (drew && performance.now() - t0 > budgetMs) break;
        this.render(q.L, q.tx, q.ty);
        drew = true;
        done++;
        continue;
      }
      let finished = false;
      while (!finished && !(drew && performance.now() - t0 > budgetMs)) {
        finished = this.renderPart(q.L, q.tx, q.ty, split);
        drew = true;
      }
      if (!finished) break;
      done++;
    }
    queue.length = 0;
    return done;
  }

  /** Make sure a tile exists (rendered synchronously). */
  ensure(L: number, tx: number, ty: number): void {
    if (!this.peek(L, tx, ty)) this.render(L, tx, ty);
  }

  /** Mark tiles stale (redrawn when next seen). With a box only detailed tiles inside it. */
  invalidate(box?: [number, number, number, number]): void {
    for (const t of this.tiles.values()) {
      if (!box) { t.stale = true; t.part = 0; continue; }
      const ts = this.tileSize(t.L);
      if (ts / TILE_PX > DETAIL_MPP) continue; // coarse tiles show no per-cell items
      const x0 = -this.world.half + t.tx * ts, z0 = -this.world.half + t.ty * ts;
      if (x0 > box[2] || x0 + ts < box[0] || z0 > box[3] || z0 + ts < box[1]) continue;
      t.stale = true;
      t.part = 0; // parts drawn so far are out of date
    }
  }

  private tile(L: number, tx: number, ty: number): Tile {
    const key = this.key(L, tx, ty);
    let t = this.tiles.get(key);
    if (!t) {
      t = { L, tx, ty, canvas: newTileCanvas(), ready: false, stale: false, used: this.frame, next: null, part: 0 };
      this.tiles.set(key, t);
      this.evict();
    }
    return t;
  }

  private render(L: number, tx: number, ty: number): void {
    const t0 = performance.now();
    const t = this.tile(L, tx, ty);
    const ts = this.tileSize(L);
    drawTile(t.canvas.getContext('2d')!, this.world, this.layers, -this.world.half + tx * ts, -this.world.half + ty * ts, ts);
    if (t.next && t.next !== t.canvas) this.spare = t.next;
    t.next = null;
    t.part = 0;
    t.ready = true;
    t.stale = false;
    t.used = this.frame;
    this.stats.ms += performance.now() - t0;
    this.stats.tiles++;
  }

  /** A canvas left over from a finished redraw, reused for the next one. */
  private spare: HTMLCanvasElement | null = null;

  /** Draw the next of a tile's split × split parts; true when that finished the tile. */
  private renderPart(L: number, tx: number, ty: number, split: number): boolean {
    const t0 = performance.now();
    const t = this.tile(L, tx, ty);
    if (t.ready && !t.stale) return true;
    // A new tile is drawn in place (an ancestor stands in meanwhile); a stale one into a second
    // canvas, so the old picture stays up until the new one is whole.
    if (!t.next || t.part === 0) {
      if (!t.ready) t.next = t.canvas;
      else if (!t.next || t.next === t.canvas) { t.next = this.spare ?? newTileCanvas(); this.spare = null; }
      t.part = 0;
    }
    const ts = this.tileSize(L);
    drawTile(t.next.getContext('2d')!, this.world, this.layers, -this.world.half + tx * ts, -this.world.half + ty * ts, ts, { i: t.part, n: split });
    t.part++;
    t.used = this.frame;
    this.stats.ms += performance.now() - t0;
    if (t.part < split * split) return false;
    if (t.next !== t.canvas) { this.spare = t.canvas; t.canvas = t.next; }
    t.next = null;
    t.part = 0;
    t.ready = true;
    t.stale = false;
    this.stats.tiles++;
    return true;
  }

  private evict(): void {
    if (this.tiles.size <= this.cap) return;
    const list = [...this.tiles.entries()].filter(([, t]) => t.L > 1 && t.used < this.frame - 1).sort((a, b) => a[1].used - b[1].used);
    for (const [k] of list.slice(0, this.tiles.size - this.cap)) this.tiles.delete(k);
  }
}

/** Tiles at or below this many metres per pixel show per-cell detail (streets, parks, buildings). */
const DETAIL_MPP = 8;

function newTileCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = TILE_PX;
  return c;
}

/**
 * Draw one tile: world square [x0, x0+ts] × [z0, z0+ts] into a TILE_PX canvas. With `part`, only
 * square i of an n × n grid over the tile (clipped; culling against that square).
 */
function drawTile(g: CanvasRenderingContext2D, w: MapWorld, layers: MapLayers, x0: number, z0: number, ts: number, part?: { i: number; n: number }): void {
  const k = TILE_PX / ts, mpp = 1 / k;
  const macro = w.macro;
  const n = part?.n ?? 1, pp = TILE_PX / n;
  const pxL = part ? (part.i % n) * pp : 0, pyT = part ? Math.floor(part.i / n) * pp : 0;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.save();
  if (part) { g.beginPath(); g.rect(pxL, pyT, pp, pp); g.clip(); }
  g.fillStyle = MAP_COLORS.land;
  g.fillRect(pxL, pyT, pp, pp);
  g.setTransform(k, 0, 0, k, -x0 * k, -z0 * k);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const pad = 40 + 16 * mpp;
  const sx0 = x0 + pxL * mpp, sz0 = z0 + pyT * mpp, ss = ts / n;
  const bx0 = sx0 - pad, bz0 = sz0 - pad, bx1 = sx0 + ss + pad, bz1 = sz0 + ss + pad;
  const vis = (b: ArrayLike<number>, o = 0) => !(b[o] > bx1 || b[o + 2] < bx0 || b[o + 1] > bz1 || b[o + 3] < bz0);
  const px = (p: number) => p * mpp;

  // Terrain: elevation tint and hillshade.
  if (w.shadeDone) {
    g.imageSmoothingEnabled = true;
    g.drawImage(w.shade, -w.half, -w.half, w.half * 2, w.half * 2);
  }

  // Districts (subtle tints; parks green).
  const cellVis: number[] = [];
  for (let i = 0; i < macro.cells.length; i++) if (vis(w.cellBox, i * 4)) cellVis.push(i);
  const byTint = new Map<string, Path2D>();
  for (const i of cellVis) {
    const c = macro.cells[i];
    const tint = DISTRICT_TINT[c.district];
    if (!tint) continue;
    let p = byTint.get(tint);
    if (!p) byTint.set(tint, (p = new Path2D()));
    addPoly(p, c.poly, true);
  }
  g.globalAlpha = w.shadeDone ? 0.75 : 1;
  for (const [tint, p] of byTint) { g.fillStyle = tint; g.fill(p); }
  g.globalAlpha = 1;

  // Crime layer: every block tinted by its live crime index (game/news), green where it is safe and
  // the police are many, through yellow to red where crime is high (ten bands).
  if (layers.crime && w.crimeIndex) {
    const bands = new Map<number, Path2D>();
    for (const i of cellVis) {
      const v = w.crimeIndex[i];
      if (macro.cells[i].district === 'water') continue;
      const b = Math.max(0, Math.min(9, Math.floor((v / 0.75) * 10)));
      let p = bands.get(b);
      if (!p) bands.set(b, (p = new Path2D()));
      addPoly(p, macro.cells[i].poly, true);
    }
    for (const [b, p] of bands) {
      const v = ((b + 0.5) / 10) * 0.75;
      // Strongest at both ends (the rough end clearly red, not to be taken for a gang's turf), faint in the middle.
      const a = b >= 5 ? 0.12 + 0.3 * (b - 4.5) / 4.5 : 0.1 + 0.16 * (4.5 - b) / 4.5;
      g.fillStyle = crimeColor(v, a);
      g.fill(p);
    }
  }

  // Turf layer: each villain group's cells in its colour (its borders go over the arterials, below).
  if (layers.turf && w.turf) {
    const T = w.turf, fills = new Map<number, Path2D>();
    for (const i of cellVis) {
      const f = T.holder[i];
      if (f < 0) continue;
      let p = fills.get(f);
      if (!p) fills.set(f, (p = new Path2D()));
      addPoly(p, macro.cells[i].poly, true);
    }
    g.globalAlpha = 0.26;
    for (const [f, p] of fills) { g.fillStyle = T.colors[f]; g.fill(p); }
    g.globalAlpha = 1;
  }

  const detail = mpp <= DETAIL_MPP;
  // Parks and plazas inside the cells.
  if (detail) {
    const parks = new Path2D(), plazas = new Path2D();
    for (const i of cellVis) {
      const it = w.cellItems[i];
      if (!it) continue;
      for (let o = 0; o < it.length; o += 4 + it[o + 3] * 2) {
        if (it[o] === MapItem.Park) addPolyF(parks, it, o + 4, it[o + 3], true);
        else if (it[o] === MapItem.Plaza) addPolyF(plazas, it, o + 4, it[o + 3], true);
      }
    }
    g.fillStyle = MAP_COLORS.plaza; g.fill(plazas);
    g.fillStyle = MAP_COLORS.park; g.fill(parks);
  }

  // Water: sea and rivers (edge pass, then fill pass so chunks merge).
  if (w.sea) {
    const p = new Path2D();
    addPoly(p, w.sea, true);
    g.fillStyle = MAP_COLORS.water;
    g.fill(p);
    g.strokeStyle = MAP_COLORS.waterEdge;
    g.lineWidth = px(1.2);
    g.stroke(p);
  }
  const rv = w.rivers.filter((c) => !(c.box[0] - c.hw > bx1 || c.box[2] + c.hw < bx0 || c.box[1] - c.hw > bz1 || c.box[3] + c.hw < bz0));
  for (const pass of [0, 1]) {
    g.strokeStyle = pass ? MAP_COLORS.water : MAP_COLORS.waterEdge;
    for (const c of rv) {
      g.lineWidth = Math.max(px(pass ? 2 : 3.6), c.hw * 2 + (pass ? 0 : px(1.6)));
      g.beginPath();
      addLine(g, c.pts);
      g.stroke();
    }
  }

  // Building footprints (oriented boxes), three tones by height.
  if (layers.buildings && mpp <= 3) {
    const tone = [new Path2D(), new Path2D(), new Path2D()];
    for (const i of cellVis) {
      const R = w.cellBld[i];
      if (!R) continue;
      for (let o = 0; o < R.length; o += SKY_STRIDE) {
        const cx = R[o], cz = R[o + 1], hu = R[o + 2], hv = R[o + 3];
        if (cx + hu + hv < bx0 || cx - hu - hv > bx1 || cz + hu + hv < bz0 || cz - hu - hv > bz1) continue;
        const ca = Math.cos(R[o + 4]), sa = Math.sin(R[o + 4]);
        const ux = ca * hu, uz = sa * hu, vx = -sa * hv, vz = ca * hv;
        const h = R[o + 6];
        const p = tone[h < 12 ? 0 : h < 40 ? 1 : 2];
        p.moveTo(cx - ux - vx, cz - uz - vz);
        p.lineTo(cx + ux - vx, cz + uz - vz);
        p.lineTo(cx + ux + vx, cz + uz + vz);
        p.lineTo(cx - ux + vx, cz - uz + vz);
        p.closePath();
      }
    }
    for (let i = 0; i < 3; i++) { g.fillStyle = MAP_COLORS.bld[i]; g.fill(tone[i]); }
    if (mpp <= 0.9) {
      g.strokeStyle = MAP_COLORS.bldEdge;
      g.lineWidth = px(0.8);
      for (const p of tone) g.stroke(p);
    }
  }

  // Landmarks: their aprons, pitches and tracks, then their buildings (outlined).
  {
    const paths = new Map<number, Path2D>();
    for (const s of w.landmarkShapes) {
      if (!vis(s.box)) continue;
      let p = paths.get(s.cat);
      if (!p) paths.set(s.cat, (p = new Path2D()));
      addPoly(p, s.poly, true);
    }
    for (const cat of [5, 2, 3, 4, 1]) {
      const p = paths.get(cat);
      if (!p) continue;
      g.fillStyle = MAP_COLORS.landmark[cat];
      g.fill(p);
      if (cat === 1) { g.strokeStyle = MAP_COLORS.landmarkEdge; g.lineWidth = px(0.9); g.stroke(p); }
    }
  }

  // Local streets (by class: 2 street, 3 lane, 4 path).
  if (detail) {
    const cls: Path2D[] = [new Path2D(), new Path2D(), new Path2D()];
    const widths = [0, 0, 0];
    for (const i of cellVis) {
      const it = w.cellItems[i];
      if (!it) continue;
      for (let o = 0; o < it.length; o += 4 + it[o + 3] * 2) {
        if (it[o] !== MapItem.Street) continue;
        const c = Math.max(0, Math.min(2, it[o + 1] - 2));
        widths[c] = Math.max(widths[c], it[o + 2]);
        addPolyF(cls[c], it, o + 4, it[o + 3], false);
      }
    }
    const minPx = mpp > 4 ? [1.1, 0.9, 0] : [1.8, 1.3, 0.9];
    const wpx = (c: number) => Math.max(minPx[c], (widths[c] || 6) / mpp);
    const casing = mpp <= 4;
    if (casing) {
      g.strokeStyle = MAP_COLORS.streetCase;
      for (const c of [0, 1]) { g.lineWidth = px(wpx(c) + 1.6); g.stroke(cls[c]); }
    }
    if (minPx[2] > 0) {
      g.strokeStyle = MAP_COLORS.path;
      g.lineWidth = px(minPx[2]);
      g.setLineDash([px(3), px(2.5)]);
      g.stroke(cls[2]);
      g.setLineDash([]);
    }
    g.strokeStyle = casing ? MAP_COLORS.street : '#f8f4ec';
    for (const c of [1, 0]) { g.lineWidth = px(wpx(c)); g.stroke(cls[c]); }
  }

  // Arterials: casings, then fills; boulevards on top.
  const art = [new Path2D(), new Path2D()];
  let avW = 0, blW = 0;
  for (let i = 0; i < macro.edges.length; i++) {
    if (!vis(w.edgeBox, i * 4)) continue;
    const e = macro.edges[i];
    if (e.bridge) continue;
    const c = e.cls === 0 ? 1 : 0;
    if (c) blW = Math.max(blW, e.width); else avW = Math.max(avW, e.width);
    addPoly(art[c], e.pts, false);
  }
  const coarse = mpp > 20;
  const avPx = Math.max(coarse ? 0.9 : mpp > 8 ? 1.7 : 2.4, (avW || 12) / mpp);
  const blPx = Math.max(coarse ? 1.7 : mpp > 8 ? 2.8 : 3.6, (blW || 20) / mpp);
  const caseW = coarse ? 0.6 : 1.1;
  g.strokeStyle = MAP_COLORS.avenueCase; g.lineWidth = px(avPx + caseW * 2); g.stroke(art[0]);
  g.strokeStyle = MAP_COLORS.boulevardCase; g.lineWidth = px(blPx + caseW * 2); g.stroke(art[1]);
  g.strokeStyle = MAP_COLORS.avenue; g.lineWidth = px(avPx); g.stroke(art[0]);
  g.strokeStyle = MAP_COLORS.boulevard; g.lineWidth = px(blPx); g.stroke(art[1]);

  // Bridges: dark casing so they read as structures over the water.
  for (const b of macro.bridges) {
    const bb = boxOf(b.pts);
    if (!vis(bb)) continue;
    const e = macro.edges[b.edge];
    const wp = Math.max(e && e.cls === 0 ? blPx : avPx, b.width / mpp);
    g.beginPath();
    addLine(g, b.pts);
    g.strokeStyle = MAP_COLORS.bridgeCase;
    g.lineWidth = px(wp + (coarse ? 1.4 : 2.6));
    g.lineCap = 'butt';
    g.stroke();
    g.strokeStyle = e && e.cls === 0 ? MAP_COLORS.boulevard : MAP_COLORS.avenue;
    g.lineWidth = px(wp);
    g.stroke();
    g.lineCap = 'round';
  }

  // Turf borders: dashed lines in the group's colour along the arterials where its turf ends
  // (drawn after the roads, which would cover them).
  if (layers.turf && w.turf) {
    g.globalAlpha = 0.9;
    g.lineWidth = px(2.4);
    g.setLineDash([px(6), px(4)]);
    for (const b of w.turf.borders) {
      if (!vis(b.box)) continue;
      g.strokeStyle = w.turf.colors[b.group];
      g.beginPath(); addLine(g, b.pts); g.stroke();
    }
    g.setLineDash([]);
    g.globalAlpha = 1;
  }

  // Sewer trunks (optional layer).
  if (layers.sewers) {
    const p = new Path2D();
    for (const s of macro.sewers) if (vis(boxOf(s.pts))) addPoly(p, s.pts, false);
    g.strokeStyle = MAP_COLORS.sewer;
    g.globalAlpha = 0.8;
    g.lineWidth = px(coarse ? 0.8 : 1.6);
    g.setLineDash([px(5), px(3.5)]);
    g.stroke(p);
    g.setLineDash([]);
    g.globalAlpha = 1;
  }

  // Metro lines: white casing, then the line colours.
  if (layers.metro && w.metro.length) {
    const lw = mpp > 10 ? 2.6 : mpp > 2 ? 4 : Math.min(9, 4 + (2 - mpp) * 2.6);
    const paths = new Map<number, Path2D>();
    for (const c of w.metro) {
      if (!vis(c.box)) continue;
      let p = paths.get(c.line);
      if (!p) paths.set(c.line, (p = new Path2D()));
      addPoly(p, c.pts, false);
    }
    g.strokeStyle = '#ffffff';
    g.lineWidth = px(lw + 3);
    for (const p of paths.values()) g.stroke(p);
    for (const [li, p] of paths) {
      g.strokeStyle = hexColor(macro.metroLines[li].color);
      g.lineWidth = px(lw);
      g.stroke(p);
    }
  }
  g.restore();
  g.setTransform(1, 0, 0, 1, 0, 0);
}

function addPoly(p: Path2D, pts: ArrayLike<number>, close: boolean): void {
  p.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i], pts[i + 1]);
  if (close) p.closePath();
}

function addPolyF(p: Path2D, a: Float32Array, o: number, n: number, close: boolean): void {
  p.moveTo(a[o], a[o + 1]);
  for (let i = 1; i < n; i++) p.lineTo(a[o + i * 2], a[o + i * 2 + 1]);
  if (close) p.closePath();
}

function addLine(g: CanvasRenderingContext2D, pts: ArrayLike<number>): void {
  g.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
}

/** The crime layer's colour for an index (0..1): green (safe, many police) through yellow to red. */
export function crimeColor(v: number, alpha: number): string {
  const t = Math.max(0, Math.min(1, v / 0.75));
  const r = t < 0.5 ? 47 + (230 - 47) * (t / 0.5) : 230 - (230 - 214) * ((t - 0.5) / 0.5);
  const gg = t < 0.5 ? 175 + (194 - 175) * (t / 0.5) : 194 - (194 - 52) * ((t - 0.5) / 0.5);
  const b = t < 0.5 ? 100 - (100 - 41) * (t / 0.5) : 41 + (40 - 41) * ((t - 0.5) / 0.5);
  return `rgba(${Math.round(r)}, ${Math.round(gg)}, ${Math.round(b)}, ${alpha.toFixed(3)})`;
}
