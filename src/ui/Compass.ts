/**
 * Compass strip at the top of the screen: heading ticks (N, NE, …) for the camera's view
 * direction, nearby points of interest (metro entrances, people needing help, crimes, small
 * deeds, power cores — the map's marker layers) and the player's own map marker, which is
 * always shown (pinned to the edge when behind) with its distance. Clicking a point of interest
 * targets what it stands for, when that is targetable (GameMap.targetAt).
 */
import * as THREE from 'three';
import type { Game } from '../game/Game';
import { targetsSomething, type MapMarker } from './map/GameMap';

/** Degrees across the strip. */
const SPAN = 180;
/** Points of interest within this range (m, × √size). */
const NEAR = 320;

interface Poi { x: number; z: number; cls: string; color: string; text: string; spot?: boolean }

export class Compass {
  private el: HTMLDivElement;
  private ticks: HTMLDivElement[] = [];
  private labels: HTMLDivElement[] = [];
  private pois: HTMLDivElement[] = [];
  /** World spot of each shown point of interest (null: nothing to target there, like a metro sign). */
  private spots: ({ x: number; z: number } | null)[] = [];
  private dir = new THREE.Vector3();

  constructor(private game: Game) {
    this.el = document.createElement('div');
    this.el.id = 'compass';
    this.el.innerHTML = '<div class="caret"></div>';
    document.body.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const i = this.pois.indexOf((e.target as HTMLElement).closest?.('.poi') as HTMLDivElement);
      const s = i >= 0 ? this.spots[i] : null;
      if (s) game.map.targetAt(s.x, s.z);
    });
  }

  update(): void {
    const g = this.game;
    const hide = g.map.open || g.menu?.paused === true;
    this.el.style.display = hide ? 'none' : '';
    if (hide) return;
    const W = this.el.clientWidth;
    const pxDeg = W / SPAN;
    g.renderer.camera.getWorldDirection(this.dir);
    // Bearing: 0 = north (−z), 90 = east (+x), as on the map.
    const head = (Math.atan2(this.dir.x, -this.dir.z) * 180) / Math.PI;
    const at = (bearing: number) => W / 2 + wrap(bearing - head) * pxDeg;

    // Ticks every 15°, letters every 45°.
    let ti = 0, li = 0;
    const first = Math.ceil((head - SPAN / 2) / 15) * 15;
    for (let b = first; b <= head + SPAN / 2; b += 15) {
      const x = at(b);
      const t = this.ticks[ti] ?? this.add(this.ticks, 'tick');
      ti++;
      t.style.display = '';
      t.style.left = `${x.toFixed(1)}px`;
      const n = ((b % 360) + 360) % 360;
      t.className = n % 45 === 0 ? 'tick major' : 'tick';
      if (n % 45 === 0) {
        const l = this.labels[li] ?? this.add(this.labels, 'lbl');
        li++;
        l.style.display = '';
        l.style.left = `${x.toFixed(1)}px`;
        const txt = CARD[n / 45];
        if (l.textContent !== txt) l.textContent = txt;
        l.className = n === 0 ? 'lbl n' : 'lbl';
      }
    }
    for (; ti < this.ticks.length; ti++) this.ticks[ti].style.display = 'none';
    for (; li < this.labels.length; li++) this.labels[li].style.display = 'none';

    // Points of interest.
    const p = g.freeCam ? g.renderer.camera.position : g.player.pos;
    const range = NEAR * Math.max(1, Math.sqrt(g.player?.k ?? 1));
    const list: Poi[] = [];
    const goals: MapMarker[] = [];
    for (const m of g.map.allMarkers()) {
      if (m.kind === 'pin' || m.kind === 'faint' || m.kind === 'badge') continue;
      if (m.always) { goals.push(m); continue; }
      // Landmarks are seen from further away.
      if (Math.hypot(m.x - p.x, m.z - p.z) > range * (m.kind === 'landmark' ? 4 : 1)) continue;
      list.push(poiOf(m));
    }
    // Metro: the nearest street entrance of each station in range.
    const m = g.macro;
    for (const [sid, ents] of g.map.world.entrances) {
      let best: { x: number; z: number } | null = null, bd = range;
      for (const e of ents) { const d = Math.hypot(e.x - p.x, e.z - p.z); if (d < bd) { bd = d; best = e; } }
      if (!best) continue;
      const col = m.metroLines[m.metroStations[sid].lines[0]]?.color ?? 0x1b3f8b;
      list.push({ x: best.x, z: best.z, cls: 'poi metro', color: `#${col.toString(16).padStart(6, '0')}`, text: 'M' });
    }
    let pi = 0;
    for (const q of list) {
      const b = bearingOf(q.x - p.x, q.z - p.z);
      const off = wrap(b - head);
      if (Math.abs(off) > SPAN / 2 - 4) continue;
      this.show(pi++, q.cls, q.color, q.text, '', W / 2 + off * pxDeg, q.spot ? q : null);
    }
    // The player's marker and goals (where carried loot goes back): always, pinned to the edge
    // when outside the strip, with the distance.
    const lim = SPAN / 2 - 5;
    const pinned = (x: number, z: number) => {
      const off = wrap(bearingOf(x - p.x, z - p.z) - head);
      return { edge: Math.abs(off) > lim, x: W / 2 + Math.max(-lim, Math.min(lim, off)) * pxDeg, d: dist(Math.hypot(x - p.x, z - p.z)) };
    };
    for (const m of goals) {
      // A zone: its nearest edge — from inside, the way out — with the distance to it.
      let gx = m.x, gz = m.z;
      if (m.kind === 'zone' && m.r) {
        const dx = p.x - m.x, dz = p.z - m.z, d = Math.hypot(dx, dz) || 1;
        gx = m.x + (dx / d) * m.r; gz = m.z + (dz / d) * m.r;
      }
      const q = pinned(gx, gz), poi = poiOf(m);
      this.show(pi++, `${poi.cls} goal${q.edge ? ' edge' : ''}`, poi.color, poi.text, q.d, q.x, targetsSomething(m) ? m : null);
    }
    const w = g.map.waypoint;
    if (w) {
      const q = pinned(w.x, w.z);
      this.show(pi++, q.edge ? 'poi pin edge' : 'poi pin', '', '', q.d, q.x, null);
    }
    for (; pi < this.pois.length; pi++) this.pois[pi].style.display = 'none';
  }

  private show(i: number, cls: string, color: string, icon: string, label: string, x: number, spot: { x: number; z: number } | null): void {
    let el = this.pois[i];
    if (!el) {
      el = this.add(this.pois, 'poi');
      el.innerHTML = '<i></i><b></b>';
    }
    el.style.display = '';
    this.spots[i] = spot;
    if (spot) cls += ' hit';
    if (el.className !== cls) el.className = cls;
    el.style.left = `${x.toFixed(1)}px`;
    const ic = el.firstElementChild as HTMLElement, lb = el.lastElementChild as HTMLElement;
    if (ic.textContent !== icon) ic.textContent = icon;
    if (ic.style.background !== color) ic.style.background = color;
    if (lb.textContent !== label) lb.textContent = label;
    lb.style.display = label ? '' : 'none';
  }

  private add(pool: HTMLDivElement[], cls: string): HTMLDivElement {
    const d = document.createElement('div');
    d.className = cls;
    this.el.appendChild(d);
    pool.push(d);
    return d;
  }
}

const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function dist(d: number): string {
  return d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`;
}

function bearingOf(dx: number, dz: number): number {
  return (Math.atan2(dx, -dz) * 180) / Math.PI;
}

/** Angle difference into −180 … 180. */
function wrap(a: number): number {
  return ((((a + 180) % 360) + 360) % 360) - 180;
}

function poiOf(m: MapMarker): Poi {
  const spot = targetsSomething(m);
  if (m.kind === 'alert') return { x: m.x, z: m.z, cls: 'poi alert', color: m.color, text: '!', spot };
  if (m.kind === 'core') return { x: m.x, z: m.z, cls: 'poi core', color: m.color, text: '' };
  if (m.kind === 'zone') return { x: m.x, z: m.z, cls: 'poi zone', color: m.color, text: '!' };
  if (m.kind === 'landmark') return { x: m.x, z: m.z, cls: 'poi landmark', color: m.color, text: '★' };
  return { x: m.x, z: m.z, cls: 'poi', color: m.color, text: '', spot };
}
