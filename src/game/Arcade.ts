/**
 * Arcades: some shop floors are halls of video game cabinets (InteriorGen isArcade, cabinet
 * pieces of kind 'arcade'). This puts a live screen and a lit title on every cabinet of an open
 * arcade, runs the games (arcade/games) and lets the hero play one right there in the world:
 * E in front of a cabinet starts it, the keyboard then drives the game (arrows / WASD, Space)
 * instead of the hero, E again steps back. Idle cabinets near the hero run their attract mode.
 * Outside, each arcade gets a neon sign over its shop front, and the map shows the nearest ones.
 */
import * as THREE from 'three';
import type { Game } from './Game';
import { CABINET, isArcade, type Furn } from '../interior/InteriorGen';
import { GAMES, SW, SH, screenText, type ArcadeGame, type Btn, type Pad } from '../arcade/games';
import type { MapMarker } from '../ui/map/GameMap';
import type { BuildingRef } from '../world/WorldIndex';

const KEYMAP: Record<string, Btn> = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
  Space: 'fire', Enter: 'fire', NumpadEnter: 'fire', KeyJ: 'fire', KeyK: 'fire', ControlLeft: 'fire', ControlRight: 'fire',
};

/** Keys that stay with the game while playing (pause menu). */
const PASS = new Set(['Escape']);

/** Screen and marquee on the cabinet's front (local: x across, y up from the floor, z out of the front). */
const SCREEN = { w: 1.5, h: 1.125, y: 1.95 };
const MARQUEE = { w: 1.6, h: 0.34, y: CABINET.h - 0.22 };
const FRONT_Z = CABINET.d / 2 - 0.3 + 0.012;

const HI_KEY = 'scale.arcade.hi';
let hiScores: Record<string, number> | null = null;
function hiTable(): Record<string, number> {
  if (!hiScores) {
    try { hiScores = JSON.parse(localStorage.getItem(HI_KEY) ?? '{}') as Record<string, number>; } catch { hiScores = {}; }
  }
  return hiScores;
}
function saveHi(title: string, score: number): void {
  const t = hiTable();
  if (score <= (t[title] ?? 0)) return;
  t[title] = score;
  try { localStorage.setItem(HI_KEY, JSON.stringify(t)); } catch { /* no storage: kept for this session */ }
}

function canvasPlane(w: number, h: number, cw: number, ch: number): { mesh: THREE.Mesh; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture } {
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d')!;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  return { mesh, canvas, ctx, tex };
}

class Cabinet {
  readonly group = new THREE.Group();
  readonly game: ArcadeGame;
  playing = false;
  /** Where the screen is (world) and the way it faces. */
  readonly sx: number; readonly sy: number; readonly sz: number;
  readonly nx: number; readonly nz: number;
  readonly yaw: number;
  /** Attract mode: time to the next idle frame. */
  wait = Math.random() * 0.2;
  private screen: ReturnType<typeof canvasPlane>;
  private marquee: ReturnType<typeof canvasPlane>;
  private blink = 0;

  constructor(readonly f: Furn, readonly floorY: number) {
    this.game = new GAMES[(f.game ?? 0) % GAMES.length]();
    this.game.reset();
    this.yaw = f.yaw;
    this.nx = Math.sin(f.yaw); this.nz = Math.cos(f.yaw);
    this.group.position.set(f.x, floorY, f.z);
    this.group.rotation.y = f.yaw;
    this.screen = canvasPlane(SCREEN.w, SCREEN.h, SW, SH);
    this.screen.mesh.position.set(0, SCREEN.y, FRONT_Z);
    this.marquee = canvasPlane(MARQUEE.w, MARQUEE.h, 320, 68);
    this.marquee.mesh.position.set(0, MARQUEE.y, FRONT_Z);
    this.group.add(this.screen.mesh, this.marquee.mesh);
    this.group.updateMatrixWorld(true);
    this.sx = f.x + this.nx * FRONT_Z; this.sy = floorY + SCREEN.y; this.sz = f.z + this.nz * FRONT_Z;
    this.paintMarquee();
    this.paint(0);
  }

  /** Where a player stands to play: in front of the control deck, how far out and across. */
  standOffset(x: number, z: number): { out: number; across: number } {
    const dx = x - this.f.x, dz = z - this.f.z;
    return { out: dx * this.nx + dz * this.nz - CABINET.d / 2, across: dx * this.nz - dz * this.nx };
  }

  private paintMarquee(): void {
    const { ctx: c, canvas } = this.marquee, g = this.game;
    const W = canvas.width, H = canvas.height;
    const grad = c.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#120a24'); grad.addColorStop(1, '#2a1240');
    c.fillStyle = grad;
    c.fillRect(0, 0, W, H);
    c.shadowColor = g.color;
    c.shadowBlur = 14;
    screenText(c, g.title, W / 2, H / 2 + 2, 34, g.color);
    c.shadowBlur = 0;
    screenText(c, g.title, W / 2, H / 2 + 2, 34, '#ffffff');
    c.globalAlpha = 0.85;
    screenText(c, g.title, W / 2, H / 2 + 2, 34, g.color);
    c.globalAlpha = 1;
    this.marquee.tex.needsUpdate = true;
  }

  /** Draw the screen (the game, and the title / game over cards over it). */
  paint(dt: number): void {
    const c = this.screen.ctx, g = this.game;
    this.blink += dt;
    c.fillStyle = '#000';
    c.fillRect(0, 0, SW, SH);
    c.save();
    g.draw(c);
    c.restore();
    const hi = Math.max(hiTable()[g.title] ?? 0, this.playing ? g.score : 0);
    const on = Math.floor(this.blink * 2) % 2 === 0;
    if (!this.playing) {
      c.fillStyle = 'rgba(0,0,0,0.45)';
      c.fillRect(0, 70, SW, 104);
      c.shadowColor = g.color; c.shadowBlur = 8;
      screenText(c, g.title, SW / 2, 96, 26, g.color);
      c.shadowBlur = 0;
      screenText(c, `HI-SCORE ${hi}`, SW / 2, 124, 12, '#ffffff');
      if (on) screenText(c, 'PRESS E TO PLAY', SW / 2, 150, 14, '#ffe14a');
    } else if (g.over) {
      c.fillStyle = 'rgba(0,0,0,0.55)';
      c.fillRect(0, 74, SW, 98);
      screenText(c, 'GAME OVER', SW / 2, 96, 26, '#ff5a5a');
      screenText(c, `SCORE ${g.score}   HI ${hi}`, SW / 2, 124, 12, '#ffffff');
      if (on) screenText(c, 'SPACE: AGAIN    E: LEAVE', SW / 2, 150, 12, '#ffe14a');
    }
    // Scanlines.
    c.fillStyle = 'rgba(0,0,0,0.22)';
    for (let y = 0; y < SH; y += 3) c.fillRect(0, y, SW, 1);
    this.screen.tex.needsUpdate = true;
  }

  dispose(): void {
    for (const p of [this.screen, this.marquee]) {
      p.mesh.geometry.dispose();
      (p.mesh.material as THREE.Material).dispose();
      p.tex.dispose();
    }
  }
}

export class Arcade {
  readonly group = new THREE.Group();
  private cabs = new Map<string, Cabinet>();
  private cur: Cabinet | null = null;
  private held = new Set<string>();
  private hits = new Set<Btn>();
  private leave = false;
  private syncT = 0;
  private markT = 0;
  private markKey = '';
  private signs = new Map<BuildingRef, THREE.Mesh>();
  private savedZoom = 0;

  constructor(private g: Game) {
    g.renderer.scene.add(this.group);
  }

  /** A game is being played: the keyboard belongs to it. */
  get playing(): boolean { return !!this.cur; }

  /** Before the hero's own controls: clicks fire in the game rather than punch. */
  takeInput(): void {
    if (!this.cur) return;
    const inp = this.g.input;
    if (inp.clicked & 1) this.hits.add('fire');
    inp.clicked = 0;
    inp.buttons &= ~1;
  }

  /** While playing: the circle people keep out of, from the hero back towards the camera (else null). */
  keepClear(): { x: number; z: number; r: number; h: number } | null {
    const c = this.cur, P = this.g.player;
    if (!c) return null;
    return { x: P.pos.x + c.nx * 1.1, z: P.pos.z + c.nz * 1.1, r: 1.3, h: P.height };
  }

  update(dt: number): void {
    this.syncT -= dt;
    if (this.syncT <= 0) { this.syncT = 0.4; this.sync(); }
    const P = this.g.player;
    const cur = this.cur;
    if (cur) {
      const st = cur.standOffset(P.pos.x, P.pos.z);
      if (this.leave || P.flying || P.downT > 0 || P.ragdoll || this.g.defeat.active || st.out > 2.6 || Math.abs(st.across) > 2 || Math.abs(P.pos.y - cur.floorY) > 1) this.stop();
      else {
        const g = cur.game;
        if (g.over) { if (this.hits.has('fire')) g.reset(); }
        else g.step(Math.min(dt, 0.05), this.pad());
        this.hits.clear();
        if (g.over || g.score > (hiTable()[g.title] ?? 0)) saveHi(g.title, g.score);
        cur.paint(dt);
      }
    }
    // Attract mode on the nearest idle cabinets (a few frames a second).
    const near = [...this.cabs.values()].filter((c) => c !== this.cur)
      .map((c) => ({ c, d: Math.hypot(c.sx - P.pos.x, c.sz - P.pos.z) }))
      .filter((e) => e.d < 14 && Math.abs(e.c.sy - P.pos.y) < 6)
      .sort((a, b) => a.d - b.d).slice(0, 8);
    for (const { c } of near) {
      c.game.idle(Math.min(dt, 0.05));
      c.wait -= dt;
      if (c.wait <= 0) { c.wait = 0.12; c.paint(0.12); }
    }
    this.markT -= dt;
    if (this.markT <= 0) { this.markT = 2; this.mapAndSigns(); }
  }

  private pad(): Pad {
    const p: Pad = { left: false, right: false, up: false, down: false, fire: false, hit: this.hits };
    for (const k of this.held) { const b = KEYMAP[k]; if (b) p[b] = true; }
    return p;
  }

  /** Cabinets come and go with the arcade interiors around the hero. */
  private sync(): void {
    const list = this.g.interiors.arcadeCabinets();
    const keep = new Set<string>();
    for (const { key, f, y } of list) {
      keep.add(key);
      const old = this.cabs.get(key);
      if (old && old.f === f) continue;
      if (old) this.remove(key, old);
      const c = new Cabinet(f, y);
      this.cabs.set(key, c);
      this.group.add(c.group);
    }
    for (const [k, c] of this.cabs) if (!keep.has(k)) this.remove(k, c);
  }

  private remove(key: string, c: Cabinet): void {
    if (this.cur === c) this.stop();
    this.group.remove(c.group);
    c.dispose();
    this.cabs.delete(key);
  }

  /** The cabinet the hero stands at (in front of its deck, facing roughly), or null. */
  private nearCab(): Cabinet | null {
    const P = this.g.player;
    if (P.flying || P.seat || P.ragdoll || P.downT > 0 || P.height > 2.4 || P.height < 1) return null;
    let best: Cabinet | null = null, bd = Infinity;
    for (const c of this.cabs.values()) {
      if (Math.abs(P.pos.y - c.floorY) > 0.8) continue;
      const s = c.standOffset(P.pos.x, P.pos.z);
      if (s.out < -0.1 || s.out > 1.7 || Math.abs(s.across) > CABINET.w / 2 + 0.25) continue;
      const d = s.out + Math.abs(s.across);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  hint(): string | null {
    if (this.cur) return `<b>${this.cur.game.title}</b> — ${this.cur.game.help} · <b>E</b> to stop playing`;
    const c = this.nearCab();
    return c ? `Arcade game <b>${c.game.title}</b> — press <b>E</b> to play` : null;
  }

  /** E at a cabinet: play. */
  use(): boolean {
    const c = this.nearCab();
    if (!c || this.cur) return false;
    this.start(c);
    return true;
  }

  private start(c: Cabinet): void {
    const g = this.g, inp = g.input;
    this.cur = c;
    c.playing = true;
    c.game.reset();
    c.game.beep = (f, d, w) => this.beep(f, d, w);
    this.held.clear(); this.hits.clear(); this.leave = false;
    inp.keys.clear(); inp.pressed.clear();
    inp.grab = (code, down, game) => this.key(code, down, game);
    // Face the screen; the camera behind the shoulder, a bit closer, looking over the head.
    g.player.yaw = c.yaw;
    g.camRig.yaw = c.yaw;
    g.camRig.pitch = -0.2;
    this.savedZoom = g.camRig.zoom;
    g.camRig.zoom = Math.min(g.camRig.zoom, 0.9);
  }

  stop(): void {
    const c = this.cur;
    if (!c) return;
    const g = this.g;
    saveHi(c.game.title, c.game.score);
    c.playing = false;
    c.game.beep = () => {};
    c.game.reset();
    c.paint(0);
    this.cur = null;
    g.input.grab = null;
    this.held.clear(); this.hits.clear();
    if (this.savedZoom) g.camRig.zoom = Math.max(g.camRig.zoom, this.savedZoom);
    this.savedZoom = 0;
  }

  private key(code: string, down: boolean, game: string): boolean {
    if (PASS.has(code)) return false;
    if (code === 'Blur') { this.held.clear(); return true; }
    if (!down) { this.held.delete(code); return true; }
    if (game === 'KeyE') { this.leave = true; return true; }
    const b = KEYMAP[code];
    if (b && !this.held.has(code)) this.hits.add(b);
    this.held.add(code);
    return true;
  }

  /** A short chiptune blip from the cabinet being played. */
  private beep(freq: number, dur: number, wave: OscillatorType = 'square'): void {
    const s = this.g.audio.synthOut();
    if (!s) return;
    const { ctx, out } = s, t0 = ctx.currentTime + 0.005;
    const o = ctx.createOscillator(), gn = ctx.createGain();
    o.type = wave;
    o.frequency.setValueAtTime(freq, t0);
    if (dur > 0.2) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * 0.4), t0 + dur);
    gn.gain.setValueAtTime(0.0001, t0);
    gn.gain.exponentialRampToValueAtTime(wave === 'square' || wave === 'sawtooth' ? 0.035 : 0.06, t0 + 0.005);
    gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(gn).connect(out);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
    o.onended = () => gn.disconnect();
  }

  // ------------------------------------------------------------------ outside: map and signs

  private mapAndSigns(): void {
    const p = this.g.player.pos, R = 600;
    const all = this.g.world.buildingsIn(p.x - R, p.z - R, p.x + R, p.z + R).filter((b) => b.alive && isArcade(b.desc));
    const at = (b: BuildingRef) => ({ x: (b.bounds[0] + b.bounds[2]) / 2, z: (b.bounds[1] + b.bounds[3]) / 2 });
    const nearest = all.map((b) => ({ b, ...at(b) })).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    const shown = nearest.slice(0, 4);
    const key = shown.map((s) => `${s.x.toFixed(0)},${s.z.toFixed(0)}`).join(';');
    if (key !== this.markKey) {
      this.markKey = key;
      this.g.map.setMarkers('arcades', shown.map((s): MapMarker => ({ x: s.x, z: s.z, color: '#3fe0ff', kind: 'badge', glyph: 'A', title: 'Arcade — classic video games inside (E at a cabinet to play)' })));
    }
    // Neon signs within sight.
    const want = new Set(nearest.filter((s) => Math.hypot(s.x - p.x, s.z - p.z) < 300).map((s) => s.b));
    for (const [b, m] of this.signs) {
      if (want.has(b)) continue;
      this.group.remove(m);
      m.geometry.dispose();
      (m.material as THREE.MeshBasicMaterial).dispose();
      this.signs.delete(b);
    }
    for (const b of want) if (!this.signs.has(b)) { const m = this.makeSign(b); if (m) { this.signs.set(b, m); this.group.add(m); } }
  }

  /** "ARCADE" in neon over the shop front, centred on its ground floor. */
  private makeSign(ref: BuildingRef): THREE.Mesh | null {
    const d = ref.desc;
    const L = this.g.destruction.layoutOf(ref);
    const g0 = L.panels.filter((q) => q.edge === d.front && q.floor === 0);
    if (!g0.length) return null;
    const e0 = g0[0];
    const ex = e0.bx - e0.ax, ez = e0.bz - e0.az, el = Math.hypot(ex, ez) || 1;
    const ux = ex / el, uz = ez / el;
    let s0 = Infinity, s1 = -Infinity;
    for (const q of g0) { s0 = Math.min(s0, q.u0); s1 = Math.max(s1, q.u0 + q.bayW); }
    const w = Math.min((s1 - s0) * 0.6, 4.4), hh = Math.min(0.95, w / 4.2);
    if (w < 1.6) return null;
    const s = (s0 + s1) / 2;
    const ox = e0.ax - ux * e0.u0, oz = e0.az - uz * e0.u0;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, hh), new THREE.MeshBasicMaterial({ map: signTexture(), transparent: true, toneMapped: false, depthWrite: false }));
    m.position.set(ox + ux * s + e0.nx * 0.14, e0.y1 - 0.2 - hh / 2, oz + uz * s + e0.nz * 0.14);
    m.rotation.y = Math.atan2(e0.nx, e0.nz);
    return m;
  }
}

let signTex: THREE.CanvasTexture | null = null;
/** The neon "ARCADE" board (shared by all signs). */
function signTexture(): THREE.CanvasTexture {
  if (signTex) return signTex;
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 116;
  const c = cv.getContext('2d')!;
  c.fillStyle = 'rgba(14,8,30,0.82)';
  c.beginPath(); c.roundRect(4, 4, 504, 108, 18); c.fill();
  c.lineWidth = 5;
  c.strokeStyle = '#3fe0ff';
  c.shadowColor = '#3fe0ff'; c.shadowBlur = 16;
  c.beginPath(); c.roundRect(10, 10, 492, 96, 14); c.stroke();
  c.font = 'bold 74px "Arial Black", "Segoe UI", sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.shadowColor = '#ff4fd8'; c.shadowBlur = 22;
  c.fillStyle = '#ff7fe6';
  c.fillText('ARCADE', 256, 62);
  c.shadowBlur = 0;
  c.fillStyle = '#ffe6fb';
  c.fillText('ARCADE', 256, 62);
  signTex = new THREE.CanvasTexture(cv);
  signTex.colorSpace = THREE.SRGBColorSpace;
  signTex.anisotropy = 4;
  return signTex;
}
