/**
 * In-game city map (M) and corner minimap (N).
 *
 * The full map is a 2D canvas overlay: drag to pan, wheel / + − to zoom,
 * layer toggles, metro lines with stations and street entrances, a marker
 * you set by clicking (the compass points to it; cleared on arrival) and, in
 * sandbox mode, click-to-travel (snapped to a safe spot on the street). The minimap is
 * north-up with a rotating player arrow. Both blit cached tiles from
 * MapTiles; only markers and labels are drawn per frame.
 *
 * While the map is open it owns the keyboard (capture listener) and the
 * mouse (the overlay covers the game canvas); the game keeps simulating.
 */
import * as THREE from 'three';
import type { Game } from '../../game/Game';
import { MapWorld, MapTiles, MAP_COLORS, hexColor, type MapLayers, type MapEntrance } from './MapTiles';
import { cityName, streetName } from '../../plan/names';
import { cityClass } from '../../world/settings';
import { STATION_HALF, ENTRANCE_L } from '../../plan/cell';
import { MapItem } from '../../stream/protocol';
import { clamp } from '../../core/math';

const LAYERS_KEY = 'scale.map.layers';
const MINI_KEY = 'scale.map.minimap';
const MINI_PX = 196;

type Queue = { L: number; tx: number; ty: number; d: number; stale: boolean }[];

interface Pick { x: number; z: number; station: number }

/** A point of interest drawn on the full map and the minimap (see GameMap.setMarkers). */
export interface MapMarker {
  x: number;
  z: number;
  /** CSS colour. */
  color: string;
  /** core: glowing diamond; alert: ring with "!"; dot: plain dot; pin: the player's own marker. */
  kind: 'core' | 'alert' | 'dot' | 'pin';
  title?: string;
  /** The compass shows it at any distance (pinned to its edge when behind), with the distance. */
  always?: boolean;
}

const DISTRICT_LABEL: Record<string, string> = {
  downtown: 'Downtown', commercial: 'Commercial district', oldtown: 'Old town', apartments: 'Apartment blocks', rowhouses: 'Row houses',
  suburban: 'Suburbs', industrial: 'Industrial area', port: 'Port', park: 'Park', water: 'Waterfront',
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function loadJSON<T>(key: string, def: T): T {
  try { const v = localStorage.getItem(key); return v ? { ...def, ...JSON.parse(v) } : def; } catch { return def; }
}

function saveJSON(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ }
}

export class GameMap {
  open = false;
  readonly world: MapWorld;
  readonly tiles: MapTiles;
  readonly layers: MapLayers;
  private root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private pop: HTMLDivElement;
  private scaleEl: HTMLDivElement;
  private scaleLabel: HTMLSpanElement;
  private status: HTMLDivElement;
  private mini: HTMLCanvasElement;
  private mg: CanvasRenderingContext2D;
  private miniOn: boolean;
  private queue: Queue = [];
  /** View: centre (world) and scale (CSS px per metre). */
  private cx = 0;
  private cz = 0;
  private s = 0.1;
  private drag: { x: number; y: number; cx: number; cz: number; moved: boolean } | null = null;
  private picked: Pick | null = null;
  private hoverStation = -1;
  private labelW = new Map<number, number>();
  private dir = new THREE.Vector3();
  /** After a trip: keep the player out of buildings while cells load; move to the real entrance once known. */
  private settle: { t: number; x: number; z: number; station: number } | null = null;
  private miniKey = '';
  private shadeMs = 0;
  private closedAt = -1e9;
  /** Marker layers from game systems (power cores, people needing help, …). */
  private markerSets = new Map<string, MapMarker[]>();
  /** Where the described markers were drawn last (canvas px), for the hover tooltip. */
  private hitsFull: { x: number; y: number; t: string }[] = [];
  private hitsMini: { x: number; y: number; t: string }[] = [];
  private tip: HTMLDivElement;
  private markerT = 0;

  /** The player's own marker (set on the map; the compass points to it), null: none. */
  waypoint: { x: number; z: number } | null = null;

  setWaypoint(p: { x: number; z: number } | null): void {
    this.waypoint = p;
    this.setMarkers('waypoint', p ? [{ x: p.x, z: p.z, color: '#e8483b', kind: 'pin', title: 'Your marker — the compass points to it' }] : []);
  }

  /** Every marker of every layer (the compass shows the nearby ones). */
  allMarkers(): MapMarker[] {
    return [...this.markerSets.values()].flat();
  }

  /** Replace one marker layer (call on change, not per frame: it redraws the minimap). */
  setMarkers(layer: string, list: MapMarker[]): void {
    this.markerSets.set(layer, list);
    this.miniKey = '';
  }

  /** Open, or just closed (the pointer-lock release of opening may arrive late): the pause menu stays away. */
  get holdsPointer(): boolean { return this.open || performance.now() - this.closedAt < 400; }

  constructor(private game: Game) {
    const t0 = performance.now();
    this.world = new MapWorld(game.macro, game.terrain);
    this.layers = loadJSON<MapLayers>(LAYERS_KEY, { metro: true, buildings: true, labels: true, sewers: false, crime: true });
    this.tiles = new MapTiles(this.world, this.layers);
    this.miniOn = loadJSON(MINI_KEY, { on: true }).on;
    game.skyline.onBatch = (cells, rec, counts, map, off) => { this.tiles.invalidate(this.world.addBatch(cells, rec, counts, map, off)); this.miniKey = ''; };
    const ts = performance.now();
    this.world.buildShade(() => { this.shadeMs = performance.now() - ts; this.tiles.invalidate(); this.miniKey = ''; });

    // ---- DOM
    const m = game.macro;
    const prof = game.terrain.profile;
    this.root = document.createElement('div');
    this.root.id = 'map';
    const lines = m.metroLines.map((l, i) => `<div class="map-line" data-line="${i}"><span class="sw" style="background:${hexColor(l.color)}"></span><b>Line ${esc(l.name)}</b><span class="n">${l.stations.length} stations</span></div>`).join('');
    this.root.innerHTML = `
      <canvas class="map-canvas"></canvas>
      <div class="map-title">
        <div class="map-city">${esc(cityName(game.settings.seed))}</div>
        <div class="map-sub">${cityClass(prof.size)} · ${(prof.radius * 2 / 1000).toFixed(1)} km across · ${m.metroLines.length ? `${m.metroLines.length} metro line${m.metroLines.length > 1 ? 's' : ''}, ${m.metroStations.length} stations` : 'no metro'}</div>
      </div>
      <div class="map-legend">
        <h3>Layers</h3>
        <label><input type="checkbox" data-layer="metro"> Metro</label>
        <label><input type="checkbox" data-layer="buildings"> Buildings</label>
        <label><input type="checkbox" data-layer="labels"> Names</label>
        <label><input type="checkbox" data-layer="sewers"> Sewers &amp; manholes</label>
        <label title="Street crime by district: the redder, the rougher the area"><input type="checkbox" data-layer="crime"> Crime</label>
        <h3>Metro</h3>
        ${lines || '<div class="map-none">This town has no metro. Larger cities do.</div>'}
        ${lines ? '<div class="map-key"><span class="ent">M</span> street entrance (zoom in)</div>' : ''}
        <h3 style="margin-top:12px">Marks</h3>
        <div class="map-key"><span class="pin"></span> your marker (the compass points to it)</div>
        <div class="map-key"><span class="alert">!</span> someone needs help (E)</div>
        <div class="map-key"><span class="alert crime">!</span> a crime happening</div>
        <div class="map-key"><span class="alert back">!</span> where stolen goods go back</div>
        <div class="map-key"><span class="crimeheat"></span> rough area (crime layer)</div>
        ${game.mode === 'normal' ? '<div class="map-key"><span class="core"></span> power core (found nearby)</div>' : ''}
        <div class="map-status"></div>
      </div>
      <div class="map-tools">
        <button data-act="in" title="Zoom in (+)">+</button>
        <button data-act="out" title="Zoom out (−)">−</button>
        <button data-act="me" title="Centre on me (C)">◎</button>
        <button data-act="all" title="Whole city (0)">⤢</button>
      </div>
      <div class="map-scale"><div class="map-north" title="North">▲<span>N</span></div><div><div class="bar"></div><span class="lbl"></span></div></div>
      <div class="map-help">Drag to pan · Wheel to zoom · Click to set a marker${game.mode === 'sandbox' ? ' or travel' : ''} · <b>M</b> / <b>Esc</b> close</div>
      <button class="map-close" title="Close (M)">×</button>
      <div class="map-pop"></div>`;
    document.body.appendChild(this.root);
    const q = <T extends Element>(sel: string) => this.root.querySelector(sel) as T;
    this.canvas = q<HTMLCanvasElement>('.map-canvas');
    this.g = this.canvas.getContext('2d')!;
    this.pop = q<HTMLDivElement>('.map-pop');
    this.scaleEl = q<HTMLDivElement>('.map-scale .bar');
    this.scaleLabel = q<HTMLSpanElement>('.map-scale .lbl');
    this.status = q<HTMLDivElement>('.map-status');
    this.mini = document.createElement('canvas');
    this.mini.id = 'minimap';
    this.mini.width = this.mini.height = Math.round(MINI_PX * Math.min(2, window.devicePixelRatio || 1));
    this.mini.style.display = this.miniOn ? '' : 'none';
    this.mini.title = 'Minimap (N) — M for the full map';
    document.body.appendChild(this.mini);
    this.mg = this.mini.getContext('2d')!;
    this.mini.addEventListener('click', () => this.toggle(true));
    this.tip = document.createElement('div');
    this.tip.className = 'map-tip';
    document.body.appendChild(this.tip);
    this.mini.addEventListener('mousemove', (e) => {
      const k = MINI_PX / (this.mini.clientWidth || MINI_PX);
      this.hover(this.hitsMini, e.offsetX * k, e.offsetY * k, e.clientX, e.clientY, -1);
    });
    this.mini.addEventListener('mouseleave', () => { this.tip.style.display = 'none'; });

    for (const cb of this.root.querySelectorAll<HTMLInputElement>('input[data-layer]')) {
      const k = cb.dataset.layer as keyof MapLayers;
      cb.checked = this.layers[k];
      cb.onchange = () => { this.layers[k] = cb.checked; saveJSON(LAYERS_KEY, this.layers); this.tiles.invalidate(); this.miniKey = ''; };
    }
    for (const el of this.root.querySelectorAll<HTMLDivElement>('.map-line')) el.onclick = () => this.fitLine(Number(el.dataset.line));
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.map-tools button')) b.onclick = () => this.action(b.dataset.act!);
    q<HTMLButtonElement>('.map-close').onclick = () => this.toggle(false);

    // ---- mouse
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.drag = { x: e.clientX, y: e.clientY, cx: this.cx, cz: this.cz, moved: false };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.drag) {
        const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
        if (!this.drag.moved && Math.hypot(dx, dy) > 4) { this.drag.moved = true; this.hidePop(); this.canvas.classList.add('grab'); }
        if (this.drag.moved) { this.cx = this.drag.cx - dx / this.s; this.cz = this.drag.cz - dy / this.s; this.clampView(); }
        return;
      }
      this.hoverStation = this.stationNear(e.offsetX, e.offsetY);
      this.hover(this.hitsFull, e.offsetX, e.offsetY, e.clientX, e.clientY, this.hoverStation);
      this.canvas.style.cursor = this.hoverStation >= 0 ? 'pointer' : '';
    });
    this.canvas.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      this.canvas.classList.remove('grab');
      if (d && !d.moved) this.click(e.offsetX, e.offsetY);
    });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      this.zoomAt(Math.pow(1.0018, -dy), e.offsetX, e.offsetY);
    }, { passive: false });
    this.canvas.addEventListener('dblclick', (e) => this.zoomAt(2, e.offsetX, e.offsetY));
    this.canvas.addEventListener('pointerleave', () => { this.tip.style.display = 'none'; });

    // ---- keyboard: capture phase, so the game never sees keys while the map is open
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
      if (!this.open) {
        if (e.code === 'KeyM' && !e.repeat && this.game.player) { e.preventDefault(); e.stopImmediatePropagation(); this.toggle(true); }
        else if (e.code === 'KeyN' && !e.repeat) this.setMinimap(!this.miniOn);
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat && (e.code === 'KeyM' || e.code === 'Escape')) return;
      switch (e.code) {
        case 'KeyM': case 'Escape': this.toggle(false); break;
        case 'Equal': case 'NumpadAdd': this.action('in'); break;
        case 'Minus': case 'NumpadSubtract': this.action('out'); break;
        case 'KeyC': this.action('me'); break;
        case 'Digit0': case 'Numpad0': this.action('all'); break;
        case 'KeyN': this.setMinimap(!this.miniOn); break;
        case 'ArrowLeft': case 'KeyA': this.cx -= 120 / this.s; this.clampView(); break;
        case 'ArrowRight': case 'KeyD': this.cx += 120 / this.s; this.clampView(); break;
        case 'ArrowUp': case 'KeyW': this.cz -= 120 / this.s; this.clampView(); break;
        case 'ArrowDown': case 'KeyS': this.cz += 120 / this.s; this.clampView(); break;
      }
    }, true);
    console.log(`[map] data ${(performance.now() - t0).toFixed(0)} ms, ${this.tiles.maxLevel + 1} tile levels over ${(this.world.half * 2 / 1000).toFixed(1)} km`);
  }

  // ------------------------------------------------------------ open / close

  toggle(on = !this.open): void {
    if (on === this.open) return;
    this.open = on;
    this.root.classList.toggle('open', on);
    this.hidePop();
    this.tip.style.display = 'none';
    if (on) {
      // Release the mouse and drop held keys: the player stops while the map is open.
      this.game.input.keys.clear();
      this.game.input.buttons = 0;
      if (document.pointerLockElement) document.exitPointerLock();
      this.game.menu?.close();
      const p = this.focus();
      this.cx = p.x; this.cz = p.z;
      // Open at neighbourhood scale (about 1.6 km across), never closer than the whole city.
      this.s = Math.max(this.minScale(), Math.min(window.innerWidth, window.innerHeight) / 1600);
      this.clampView();
      this.status.textContent = '';
    } else {
      this.drag = null;
      this.closedAt = performance.now();
    }
  }

  private setMinimap(on: boolean): void {
    this.miniOn = on;
    this.mini.style.display = on ? '' : 'none';
    saveJSON(MINI_KEY, { on });
  }

  private focus(): THREE.Vector3 {
    return this.game.freeCam ? this.game.renderer.camera.position : this.game.player.pos;
  }

  private minScale(): number {
    return (Math.min(window.innerWidth, window.innerHeight) * 0.92) / (this.world.half * 2);
  }

  private clampView(): void {
    this.s = clamp(this.s, this.minScale(), 6);
    const h = this.world.half;
    this.cx = clamp(this.cx, -h, h);
    this.cz = clamp(this.cz, -h, h);
  }

  private zoomAt(f: number, sx: number, sy: number): void {
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    const wx = this.cx + (sx - W / 2) / this.s, wz = this.cz + (sy - H / 2) / this.s;
    this.s *= f;
    this.clampView();
    this.cx = wx - (sx - W / 2) / this.s;
    this.cz = wz - (sy - H / 2) / this.s;
    this.clampView();
    this.hidePop();
  }

  private action(a: string): void {
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    if (a === 'in') this.zoomAt(1.6, W / 2, H / 2);
    else if (a === 'out') this.zoomAt(1 / 1.6, W / 2, H / 2);
    else if (a === 'me') { const p = this.focus(); this.cx = p.x; this.cz = p.z; this.s = Math.max(this.s, 0.6); this.clampView(); }
    else if (a === 'all') { this.cx = 0; this.cz = 0; this.s = this.minScale(); }
    this.hidePop();
  }

  private fitLine(li: number): void {
    const l = this.game.macro.metroLines[li];
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < l.pts.length; i += 2) {
      x0 = Math.min(x0, l.pts[i]); x1 = Math.max(x1, l.pts[i]);
      z0 = Math.min(z0, l.pts[i + 1]); z1 = Math.max(z1, l.pts[i + 1]);
    }
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    this.cx = (x0 + x1) / 2; this.cz = (z0 + z1) / 2;
    this.s = Math.min((W - 520) / Math.max(200, x1 - x0), (H - 200) / Math.max(200, z1 - z0));
    this.clampView();
    this.hidePop();
  }

  // ------------------------------------------------------------ picking and travel

  private toScreen(x: number, z: number, W: number, H: number): [number, number] {
    return [W / 2 + (x - this.cx) * this.s, H / 2 + (z - this.cz) * this.s];
  }

  private stationNear(sx: number, sy: number): number {
    if (!this.layers.metro) return -1;
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    let best = -1, bd = 14;
    for (const st of this.game.macro.metroStations) {
      const [x, y] = this.toScreen(st.x, st.z, W, H);
      const d = Math.hypot(x - sx, y - sy);
      if (d < bd) { bd = d; best = st.id; }
    }
    return best;
  }

  private click(sx: number, sy: number): void {
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    const st = this.stationNear(sx, sy);
    const m = this.game.macro;
    let x = this.cx + (sx - W / 2) / this.s, z = this.cz + (sy - H / 2) / this.s;
    if (st >= 0) { x = m.metroStations[st].x; z = m.metroStations[st].z; }
    const w = this.waypoint;
    if (w && st < 0 && Math.hypot(w.x - x, w.z - z) * this.s < 16) { x = w.x; z = w.z; }
    this.picked = { x, z, station: st };
    const p = this.focus();
    const dist = Math.hypot(x - p.x, z - p.z);
    const far = dist < 1000 ? `${Math.round(dist / 10) * 10} m away` : `${(dist / 1000).toFixed(1)} km away`;
    let html: string;
    if (st >= 0) {
      const s = m.metroStations[st];
      const chips = s.lines.map((l) => `<span class="chip" style="background:${hexColor(m.metroLines[l].color)}">${esc(m.metroLines[l].name)}</span>`).join('');
      html = `<div class="t">${esc(s.name)}</div><div class="d">${chips} Metro station · ${far}</div>${this.buttons(`Travel to ${esc(s.name)} <small>(street entrance)</small>`)}`;
    } else {
      const c = this.world.cellAt(x, z);
      const wet = this.game.terrain.isWater(x, z, 0) && this.game.world.bridgeDeck(x, z) === -Infinity;
      const road = this.nearestArterial(x, z);
      const what = wet ? (this.game.terrain.coastDistance(x, z) < 0 ? 'The sea' : 'The river') : c >= 0 ? DISTRICT_LABEL[m.cells[c].district] : 'Outskirts';
      const near = road && road.d < 250 ? ` · near ${esc(streetName(this.game.settings.seed, road.edge, m.edges[road.edge].cls))}` : '';
      html = `<div class="t">${esc(what)}</div><div class="d">${far}${near}</div>${this.buttons(wet ? 'Travel to the nearest shore' : 'Travel here')}`;
    }
    this.pop.innerHTML = html;
    this.pop.style.display = 'block';
    const pw = this.pop.offsetWidth, ph = this.pop.offsetHeight;
    const [px, py] = this.toScreen(x, z, W, H);
    this.pop.style.left = `${clamp(px - pw / 2, 8, W - pw - 8)}px`;
    this.pop.style.top = `${py - ph - 18 < 8 ? py + 18 : py - ph - 18}px`;
    for (const b of this.pop.querySelectorAll<HTMLButtonElement>('button')) {
      b.onclick = () => {
        const pk = this.picked!;
        if (b.dataset.act === 'travel') this.travel(pk);
        else if (b.dataset.act === 'mark') { this.setWaypoint({ x: pk.x, z: pk.z }); this.hidePop(); }
        else { this.setWaypoint(null); this.hidePop(); }
      };
    }
  }

  /** Popup buttons: set (or remove) the marker; travel only in sandbox mode. */
  private buttons(travel: string): string {
    const pk = this.picked!, w = this.waypoint;
    const onMark = w && Math.hypot(w.x - pk.x, w.z - pk.z) * this.s < 16;
    const mark = onMark ? '<button data-act="unmark">Remove marker</button>' : '<button data-act="mark">Set marker</button>';
    return this.game.mode === 'sandbox' ? `${mark}<button data-act="travel">${travel}</button>` : mark;
  }

  private hidePop(): void {
    this.pop.style.display = 'none';
    this.picked = null;
  }

  private wet(x: number, z: number): boolean {
    return this.game.terrain.isWater(x, z, 1.5) && this.game.world.bridgeDeck(x, z) === -Infinity;
  }

  private blocked(x: number, z: number): boolean {
    if (this.wet(x, z) || this.game.world.buildingAt(x, z)) return true;
    return this.world.inBuilding(x, z, 1.2) === true;
  }

  private nearestArterial(x: number, z: number): { edge: number; d: number } | null {
    let best: { edge: number; d: number } | null = null;
    const E = this.game.macro.edges, B = this.world.edgeBox;
    for (let i = 0; i < E.length; i++) {
      const bd = best ? best.d : 1e9;
      if (x < B[i * 4] - bd || x > B[i * 4 + 2] + bd || z < B[i * 4 + 1] - bd || z > B[i * 4 + 3] + bd) continue;
      const d = polyDist(E[i].pts, 0, E[i].pts.length >> 1, x, z, null);
      if (!best || d < best.d) best = { edge: i, d };
    }
    return best;
  }

  /**
   * A safe place to stand near (x, z): the point itself when it is dry, outside
   * buildings and known; else the nearest street (beside the carriageway when
   * that is clear), local streets included where the cell's map items arrived.
   */
  private safeSpot(x: number, z: number): { x: number; z: number } {
    const known = this.world.inBuilding(x, z, 1.2);
    if (known === false && !this.blocked(x, z)) return { x, z };
    let best = Infinity, bx = x, bz = z;
    const cand = { x: 0, z: 0, nx: 0, nz: 0 };
    const tryLine = (pts: ArrayLike<number>, o: number, n: number, halfW: number) => {
      const d = polyDist(pts, o, n, x, z, cand);
      if (d >= best) return;
      // Beside the road (sidewalk) on the clicked side, else the centreline.
      const side = (x - cand.x) * cand.nx + (z - cand.z) * cand.nz >= 0 ? 1 : -1;
      for (const off of [halfW + 1.4, 0]) {
        const px = cand.x + cand.nx * side * off, pz = cand.z + cand.nz * side * off;
        if (!this.blocked(px, pz) || off === 0 && !this.wet(px, pz)) { best = d; bx = px; bz = pz; return; }
      }
    };
    const E = this.game.macro.edges, B = this.world.edgeBox;
    for (let i = 0; i < E.length; i++) {
      if (x < B[i * 4] - best || x > B[i * 4 + 2] + best || z < B[i * 4 + 1] - best || z > B[i * 4 + 3] + best) continue;
      tryLine(E[i].pts, 0, E[i].pts.length >> 1, E[i].width / 2);
    }
    const C = this.world.cellBox;
    for (let c = 0; c < this.world.cellItems.length; c++) {
      const it = this.world.cellItems[c];
      if (!it || x < C[c * 4] - best || x > C[c * 4 + 2] + best || z < C[c * 4 + 1] - best || z > C[c * 4 + 3] + best) continue;
      for (let o = 0; o < it.length; o += 4 + it[o + 3] * 2) if (it[o] === MapItem.Street && it[o + 1] < 4) tryLine(it, o + 4, it[o + 3], it[o + 2] / 2);
    }
    return { x: bx, z: bz };
  }

  /** Street-level spot at the top of an entrance's stairs, facing down them. */
  private standAt(e: MapEntrance): { x: number; z: number; fx: number; fz: number } {
    const st = this.game.macro.metroStations[e.station];
    const end = e.end ? 1 : -1;
    const ex = st.x + Math.cos(st.angle) * end * (STATION_HALF - 3), ez = st.z + Math.sin(st.angle) * end * (STATION_HALF - 3);
    const sg = (ex - e.x) * e.ux + (ez - e.z) * e.uz >= 0 ? 1 : -1;
    const fx = e.ux * sg, fz = e.uz * sg;
    return { x: e.x - fx * (ENTRANCE_L / 2 + 1.4), z: e.z - fz * (ENTRANCE_L / 2 + 1.4), fx, fz };
  }

  private travel(p: Pick): void {
    let x = p.x, z = p.z, face: [number, number] | null = null;
    if (p.station >= 0) {
      const list = this.world.entrances.get(p.station);
      if (list && list.length) {
        const me = this.focus();
        const e = list.reduce((a, b) => (Math.hypot(a.x - me.x, a.z - me.z) <= Math.hypot(b.x - me.x, b.z - me.z) ? a : b));
        const s = this.standAt(e);
        x = s.x; z = s.z; face = [s.fx, s.fz];
      } else {
        // Entrances not known yet: aim at a platform end, snap to the street, fix up when the cell loads.
        const st = this.game.macro.metroStations[p.station];
        const sp = this.safeSpot(st.x + Math.cos(st.angle) * (STATION_HALF - 12), st.z + Math.sin(st.angle) * (STATION_HALF - 12));
        x = sp.x; z = sp.z;
      }
    } else {
      const sp = this.safeSpot(x, z);
      x = sp.x; z = sp.z;
    }
    this.teleport(x, z, face);
    this.settle = { t: 8, x, z, station: p.station };
    this.toggle(false);
  }

  private teleport(x: number, z: number, face: [number, number] | null): void {
    const g = this.game;
    if (g.freeCam) {
      g.renderer.camera.position.set(x, g.terrain.height(x, z) + 40, z);
      return;
    }
    const pl = g.player;
    pl.pos.set(x, g.world.groundHeight(x, z) + 0.1, z);
    pl.vel.set(0, 0, 0);
    if (face) { g.camRig.yaw = Math.atan2(-face[0], -face[1]); g.camRig.pitch = -0.25; }
  }

  /** After a trip: entrance fix-up and pushing the player out of buildings that just streamed in. */
  private updateSettle(dt: number): void {
    const s = this.settle;
    if (!s || this.game.freeCam) return;
    s.t -= dt;
    const p = this.game.player.pos;
    if (s.t <= 0 || Math.hypot(p.x - s.x, p.z - s.z) > 30) { this.settle = null; return; }
    if (s.station >= 0) {
      for (const e of this.game.underground.entrances.values()) {
        if (e.station !== s.station || Math.hypot(e.x - s.x, e.z - s.z) > 400) continue;
        const st = this.standAt({ x: e.x, z: e.z, ux: e.ux, uz: e.uz, station: e.station, end: e.end });
        if (Math.hypot(st.x - p.x, st.z - p.z) > 3) this.teleport(st.x, st.z, [st.fx, st.fz]);
        s.station = -1; s.x = st.x; s.z = st.z;
        break;
      }
    }
    const b = this.game.world.buildingAt(p.x, p.z);
    if (b && p.y < b.top - 0.5) {
      for (let r = 2; r < 60; r += 2) {
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
          if (this.blocked(x, z)) continue;
          this.teleport(x, z, null);
          s.x = x; s.z = z;
          return;
        }
      }
    }
  }

  // ------------------------------------------------------------ per frame

  update(dt: number): void {
    this.updateSettle(dt);
    const w = this.waypoint, f = this.focus();
    if (w && Math.hypot(w.x - f.x, w.z - f.z) < Math.max(12, 3 * (this.game.player?.height ?? 1.8))) this.setWaypoint(null);
    this.tiles.beginFrame();
    if (this.open) this.drawFull();
    else if (this.miniOn && !this.game.menu?.paused) this.drawMini();
  }

  private drawFull(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
    }
    const g = this.g, s = this.s, half = this.world.half;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = MAP_COLORS.outside;
    g.fillRect(0, 0, W, H);
    const ox = W / 2 - this.cx * s, oy = H / 2 - this.cz * s;
    g.fillStyle = MAP_COLORS.land;
    g.fillRect(ox - half * s, oy - half * s, half * 2 * s, half * 2 * s);
    this.tiles.ensure(0, 0, 0);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    this.tiles.drawView(g, this.tiles.levelFor(s * dpr), s, ox, oy, W, H, this.queue);
    this.tiles.renderQueue(this.queue, 9);
    this.drawMarkers(g, W, H, s, ox, oy, true);
    this.drawCustom(g, W, H, s, ox, oy, true);
    this.drawPlayer(g, ox + this.focus().x * s, oy + this.focus().z * s, 1);
    if (this.picked) {
      const [x, y] = [ox + this.picked.x * s, oy + this.picked.z * s];
      if (this.picked.station < 0) drawPin(g, x, y);
    }
    this.updateScale();
    const m = this.game.macro;
    const known = this.world.cellsKnown, all = m.cells.length;
    const txt = known < all ? `Surveying the city… ${Math.floor((known / all) * 100)}%` : '';
    if (this.status.textContent !== txt) this.status.textContent = txt;
  }

  /** Stations, entrances, manholes and labels (per frame, screen space). */
  private drawMarkers(g: CanvasRenderingContext2D, W: number, H: number, s: number, ox: number, oy: number, full: boolean): void {
    const m = this.game.macro;
    const inView = (x: number, y: number, pad: number) => x > -pad && y > -pad && x < W + pad && y < H + pad;
    // Manholes (sewer layer, close up).
    if (full && this.layers.sewers && s > 0.6) {
      g.fillStyle = '#5b4a33';
      g.strokeStyle = '#f3ead9';
      g.lineWidth = 1;
      this.game.underground.forEachManhole((x, z) => {
        const sx = ox + x * s, sy = oy + z * s;
        if (!inView(sx, sy, 6)) return;
        g.beginPath(); g.arc(sx, sy, 3, 0, Math.PI * 2); g.fill(); g.stroke();
      });
    }
    if (!this.layers.metro || !m.metroStations.length) return;
    // Street entrances ("M" signs) when zoomed in.
    if (s > (full ? 0.42 : 0.3)) {
      const r = full ? 7 : 5.5;
      g.font = `700 ${full ? 10 : 8}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (const [sid, list] of this.world.entrances) {
        const col = hexColor(m.metroLines[m.metroStations[sid].lines[0]]?.color ?? 0x1b3f8b);
        for (const e of list) {
          const sx = ox + e.x * s, sy = oy + e.z * s;
          if (!inView(sx, sy, 10)) continue;
          g.fillStyle = '#ffffff';
          roundRect(g, sx - r - 1.2, sy - r - 1.2, (r + 1.2) * 2, (r + 1.2) * 2, 3.5); g.fill();
          g.fillStyle = col;
          roundRect(g, sx - r, sy - r, r * 2, r * 2, 2.5); g.fill();
          g.fillStyle = '#ffffff';
          g.fillText('M', sx, sy + 0.5);
        }
      }
    }
    // Stations: white dots ringed in the line colour; interchanges larger with a dark ring.
    const rad = full ? (s > 0.4 ? 6 : 4.5) : 3.5;
    for (const st of m.metroStations) {
      const sx = ox + st.x * s, sy = oy + st.z * s;
      if (!inView(sx, sy, 12)) continue;
      const inter = st.lines.length > 1;
      const r = inter ? rad + 1.5 : rad;
      g.beginPath();
      g.arc(sx, sy, r, 0, Math.PI * 2);
      g.fillStyle = '#ffffff';
      g.fill();
      g.lineWidth = inter ? 2.4 : 2.2;
      g.strokeStyle = inter ? '#1f252b' : hexColor(m.metroLines[st.lines[0]]?.color ?? 0x333333);
      g.stroke();
      if (full && st.id === this.hoverStation) {
        g.beginPath(); g.arc(sx, sy, r + 4, 0, Math.PI * 2);
        g.strokeStyle = 'rgba(31,37,43,0.45)'; g.lineWidth = 2; g.stroke();
      }
    }
    if (!full || !this.layers.labels) return;
    // Station names: interchanges first, greedy placement without overlaps.
    g.font = '600 12px system-ui, sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    const placed: number[] = [];
    const order = m.metroStations.filter((st) => inView(ox + st.x * s, oy + st.z * s, 0)).sort((a, b) => b.lines.length - a.lines.length || a.id - b.id);
    for (const st of order) {
      let w = this.labelW.get(st.id);
      if (w === undefined) { w = g.measureText(st.name).width; this.labelW.set(st.id, w); }
      const sx = ox + st.x * s, sy = oy + st.z * s;
      const opts: [number, number][] = [[sx + rad + 5, sy], [sx - rad - 5 - w, sy], [sx - w / 2, sy - rad - 10], [sx - w / 2, sy + rad + 10]];
      for (const [lx, ly] of opts) {
        const x0 = lx - 3, y0 = ly - 9, x1 = lx + w + 3, y1 = ly + 9;
        let hit = false;
        for (let i = 0; i < placed.length && !hit; i += 4) hit = !(x0 > placed[i + 2] || x1 < placed[i] || y0 > placed[i + 3] || y1 < placed[i + 1]);
        if (hit) continue;
        placed.push(x0, y0, x1, y1);
        g.lineWidth = 3.5;
        g.strokeStyle = 'rgba(255,255,255,0.92)';
        g.strokeText(st.name, lx, ly);
        g.fillStyle = '#1d242b';
        g.fillText(st.name, lx, ly);
        break;
      }
    }
  }

  /** Marker layers (screen space); on the minimap, markers outside are pinned to the edge. */
  private drawCustom(g: CanvasRenderingContext2D, W: number, H: number, s: number, ox: number, oy: number, full: boolean): void {
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
    const hits = full ? this.hitsFull : this.hitsMini;
    hits.length = 0;
    for (const list of this.markerSets.values()) {
      for (const m of list) {
        let x = ox + m.x * s, y = oy + m.z * s;
        let edge = false;
        if (!full) {
          const c = MINI_PX / 2, r = MINI_PX / 2 - 9;
          const dx = x - c, dy = y - c, d = Math.hypot(dx, dy);
          if (d > r) { if (m.kind !== 'alert' && m.kind !== 'pin') continue; x = c + (dx / d) * r; y = c + (dy / d) * r; edge = true; }
        } else if (x < -12 || y < -12 || x > W + 12 || y > H + 12) continue;
        const r = full ? 8 : 5;
        g.save();
        g.translate(x, y);
        if (m.title) hits.push({ x, y: m.kind === 'pin' ? y - (full ? 14 : 10) : y, t: m.title });
        if (m.kind === 'pin') {
          if (!full) g.scale(0.7, 0.7);
          drawPin(g, 0, 0);
        } else if (m.kind === 'core') {
          g.shadowColor = m.color;
          g.shadowBlur = full ? 12 : 8;
          g.beginPath();
          g.moveTo(0, -r * 1.35); g.lineTo(r, 0); g.lineTo(0, r * 1.35); g.lineTo(-r, 0); g.closePath();
          g.fillStyle = m.color; g.fill();
          g.shadowBlur = 0;
          g.lineWidth = 1.6; g.strokeStyle = '#ffffff'; g.stroke();
        } else if (m.kind === 'alert') {
          g.beginPath(); g.arc(0, 0, r + 3 + pulse * 3, 0, Math.PI * 2);
          g.strokeStyle = m.color; g.globalAlpha = 0.5 + (1 - pulse) * 0.4; g.lineWidth = 2; g.stroke();
          g.globalAlpha = edge ? 0.85 : 1;
          g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fillStyle = m.color; g.fill();
          g.lineWidth = 1.5; g.strokeStyle = '#ffffff'; g.stroke();
          g.fillStyle = '#1a1408'; g.font = `800 ${full ? 10 : 8}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText('!', 0, 0.5);
        } else {
          g.beginPath(); g.arc(0, 0, r * 0.6, 0, Math.PI * 2); g.fillStyle = m.color; g.fill();
        }
        g.restore();
      }
    }
  }

  /** Hovering a described marker (or a metro station on the full map): a short tooltip by the cursor. */
  private hover(hits: { x: number; y: number; t: string }[], x: number, y: number, cx: number, cy: number, station: number): void {
    let best: string | null = null, bd = 12;
    for (const h of hits) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d < bd) { bd = d; best = h.t; }
    }
    if (!best && station >= 0) {
      const m = this.game.macro, st = m.metroStations[station];
      best = `${st.name} — metro, line${st.lines.length > 1 ? 's' : ''} ${st.lines.map((l) => m.metroLines[l].name).join(', ')}`;
    }
    if (!best) { this.tip.style.display = 'none'; return; }
    if (this.tip.textContent !== best) this.tip.textContent = best;
    this.tip.style.display = 'block';
    const w = this.tip.offsetWidth;
    this.tip.style.left = `${Math.min(cx + 14, window.innerWidth - w - 8)}px`;
    this.tip.style.top = `${cy + 16}px`;
  }

  private drawPlayer(g: CanvasRenderingContext2D, x: number, y: number, k: number): void {
    const cam = this.game.renderer.camera;
    cam.getWorldDirection(this.dir);
    const a = Math.atan2(this.dir.z, this.dir.x);
    const under = this.game.camRig?.underground;
    g.save();
    g.translate(x, y);
    // View cone.
    const grad = g.createRadialGradient(0, 0, 2, 0, 0, 46 * k);
    grad.addColorStop(0, 'rgba(43,124,255,0.35)');
    grad.addColorStop(1, 'rgba(43,124,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, 46 * k, a - 0.55, a + 0.55);
    g.closePath();
    g.fill();
    // Arrow.
    g.rotate(a);
    g.beginPath();
    g.moveTo(11 * k, 0);
    g.lineTo(-7 * k, 7.5 * k);
    g.lineTo(-3.5 * k, 0);
    g.lineTo(-7 * k, -7.5 * k);
    g.closePath();
    g.fillStyle = under ? '#7a5cff' : '#2b7cff';
    g.strokeStyle = '#ffffff';
    g.lineWidth = 2.2;
    g.lineJoin = 'round';
    g.stroke();
    g.fill();
    g.restore();
  }

  private updateScale(): void {
    // Bar of a round length close to 110 px.
    const target = 110 / this.s;
    const p = Math.pow(10, Math.floor(Math.log10(target)));
    const v = [1, 2, 5, 10].map((f) => f * p).filter((d) => d <= target).pop() ?? p;
    this.scaleEl.style.width = `${v * this.s}px`;
    const t = v >= 1000 ? `${v / 1000} km` : `${v} m`;
    if (this.scaleLabel.textContent !== t) this.scaleLabel.textContent = t;
  }

  private drawMini(): void {
    const g = this.mg, P = this.mini.width, dpr = P / MINI_PX;
    const p = this.focus();
    const h = this.game.player?.height ?? 1.8;
    const span = 520 * clamp(Math.sqrt(h / 1.8), 1, 8) * (this.game.player?.flying ? 1.6 : 1);
    const s = MINI_PX / span;
    this.game.renderer.camera.getWorldDirection(this.dir);
    // Skip identical frames (standing still).
    const key = `${p.x.toFixed(1)},${p.z.toFixed(1)},${this.dir.x.toFixed(2)},${this.dir.z.toFixed(2)},${s.toFixed(4)}`;
    const alerts = [...this.markerSets.values()].some((l) => l.some((m) => m.kind === 'alert'));
    if (key === this.miniKey && !(alerts && (this.markerT = (this.markerT + 1) % 3) === 0)) return;
    this.miniKey = key;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = MAP_COLORS.outside;
    g.fillRect(0, 0, MINI_PX, MINI_PX);
    const ox = MINI_PX / 2 - p.x * s, oy = MINI_PX / 2 - p.z * s;
    this.tiles.ensure(0, 0, 0);
    g.imageSmoothingEnabled = true;
    this.tiles.drawView(g, this.tiles.levelFor(s * dpr), s, ox, oy, MINI_PX, MINI_PX, this.queue);
    // One tile per frame at most: the minimap must never cost a frame.
    if (this.tiles.renderQueue(this.queue, 2, 1)) this.miniKey = '';
    this.drawMarkers(g, MINI_PX, MINI_PX, s, ox, oy, false);
    this.drawCustom(g, MINI_PX, MINI_PX, s, ox, oy, false);
    if (this.game.camRig?.underground) {
      g.fillStyle = 'rgba(20,24,40,0.35)';
      g.fillRect(0, 0, MINI_PX, MINI_PX);
    }
    this.drawPlayer(g, MINI_PX / 2, MINI_PX / 2, 0.8);
    // North marker.
    g.font = '700 11px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.strokeText('N', MINI_PX / 2, 10);
    g.fillStyle = '#1d242b';
    g.fillText('N', MINI_PX / 2, 10);
  }

  /** Diagnostics for testing (window.game.map.debug()). */
  debug(): Record<string, number> {
    return { tilesRendered: this.tiles.stats.tiles, tileMs: Math.round(this.tiles.stats.ms), shadeMs: Math.round(this.shadeMs), cellsKnown: this.world.cellsKnown, cells: this.game.macro.cells.length };
  }
}

/** Distance from a point to a polyline (points o.. in a flat array); writes the closest point and unit normal. */
function polyDist(pts: ArrayLike<number>, o: number, n: number, x: number, z: number, out: { x: number; z: number; nx: number; nz: number } | null): number {
  let best = Infinity;
  for (let i = 0; i < n - 1; i++) {
    const ax = pts[o + i * 2], az = pts[o + i * 2 + 1], bx = pts[o + i * 2 + 2], bz = pts[o + i * 2 + 3];
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1) : 0;
    const qx = ax + dx * t, qz = az + dz * t;
    const d = Math.hypot(x - qx, z - qz);
    if (d < best) {
      best = d;
      if (out) { const l = Math.sqrt(l2) || 1; out.x = qx; out.z = qz; out.nx = -dz / l; out.nz = dx / l; }
    }
  }
  return best;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function drawPin(g: CanvasRenderingContext2D, x: number, y: number): void {
  g.save();
  g.beginPath();
  g.moveTo(x, y);
  g.bezierCurveTo(x - 4, y - 8, x - 9, y - 12, x - 9, y - 18);
  g.arc(x, y - 18, 9, Math.PI, 0);
  g.bezierCurveTo(x + 9, y - 12, x + 4, y - 8, x, y);
  g.fillStyle = '#e8483b';
  g.strokeStyle = '#ffffff';
  g.lineWidth = 2;
  g.fill();
  g.stroke();
  g.beginPath();
  g.arc(x, y - 18, 3.5, 0, Math.PI * 2);
  g.fillStyle = '#ffffff';
  g.fill();
  g.restore();
}
