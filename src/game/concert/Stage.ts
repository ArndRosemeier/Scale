/**
 * The concert stage in the stadium (game/concert): a deck at the end of the pitch with a drum riser,
 * a keyboard and a drum kit, an LED wall behind the band, truss towers with a roof, hanging speaker
 * arrays, a crush barrier, moving light beams into the crowd and searchlights into the night sky,
 * pyro jets for the big moments.
 *
 * No scene lights (their cost lands on every lit material): the show is emissive surfaces and
 * additive beams, all plain three.js materials (no shader of its own, so WebGL and WebGPU alike).
 * Local frame: origin at the back wall's centre at field level, +x across the stage, +z towards the
 * crowd (Concert places the group with `place`).
 */
import * as THREE from 'three';
import { STAGE } from './plan';
import { clamp } from '../../core/math';

const geo = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 18),
  /** A light beam: apex at the origin, opening along +y (length 1), open-ended. */
  beam: (() => { const g = new THREE.CylinderGeometry(1, 0.02, 1, 18, 1, true); g.translate(0, 0.5, 0); return g; })(),
};

const lit = (color: number, rough = 0.6, metal = 0.2) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });

/** Fades a beam out along its length (cylinder uv.y: 1 at the far end, 0 at the apex; the canvas's top is uv.y 1). */
function beamFade(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 128;
  const x = c.getContext('2d')!;
  const gr = x.createLinearGradient(0, 0, 0, 128);
  // (Grey, not alpha: an alpha map reads the green channel, and translucent white is still white.)
  gr.addColorStop(0, 'rgb(0,0,0)');
  gr.addColorStop(0.5, 'rgb(60,60,60)');
  gr.addColorStop(0.85, 'rgb(170,170,170)');
  gr.addColorStop(1, 'rgb(255,255,255)');
  x.fillStyle = gr;
  x.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(c);
}

interface Beam { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; halo: THREE.MeshBasicMaterial; base: THREE.Vector3; yaw: number; pitch: number; k: number; sky: boolean }

/** Colour palettes the show cycles through (one per song). */
const PALETTES: number[][] = [
  [0xff2a6d, 0x05d9e8, 0xd1f7ff],
  [0x9d4edd, 0xff9e00, 0xffffff],
  [0x00f5d4, 0x00bbf9, 0xfee440],
  [0xff006e, 0x8338ec, 0x3a86ff],
  [0xffbe0b, 0xfb5607, 0xffffff],
  [0x80ffdb, 0x5390d9, 0xe0aaff],
];

export class Stage {
  readonly group = new THREE.Group();
  private beams: Beam[] = [];
  private screen: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; mat: THREE.MeshBasicMaterial };
  private blinders: THREE.MeshBasicMaterial;
  private strips: THREE.MeshBasicMaterial;
  private pyro: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial }[] = [];
  private pyroT = 0;
  private screenT = 0;
  private palette = 0;
  private bars = new Float32Array(24);
  /** What the LED wall shows between songs (the act, a song's title, a goodnight). */
  title = '';
  act = 'VELA';
  private fade: THREE.Texture;

  constructor() {
    const g = this.group;
    const W = STAGE.w, D = STAGE.d, H = STAGE.h, R = STAGE.roof;
    const black = lit(0x111114, 0.8, 0.1), steel = lit(0x9a9ca2, 0.35, 0.8), deckTop = lit(0x1d1d22, 0.9, 0);
    const add = (geom: THREE.BufferGeometry, m: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number, shadow = true) => {
      const o = new THREE.Mesh(geom, m);
      o.scale.set(sx, sy, sz);
      o.position.set(x, y, z);
      o.castShadow = shadow;
      o.receiveShadow = true;
      g.add(o);
      return o;
    };
    // Deck, front skirt, drum riser, stairs at the sides.
    add(geo.box, black, W, H - 0.08, D, 0, (H - 0.08) / 2, D / 2);
    add(geo.box, deckTop, W, 0.08, D, 0, H - 0.04, D / 2);
    add(geo.box, black, 5, 0.5, 3.4, 0, H + 0.25, 3.2);
    for (const s of [-1, 1]) for (let k = 0; k < 6; k++) add(geo.box, black, 1.4, (k + 1) * 0.3, 0.32, s * (W / 2 + 0.75), ((k + 1) * 0.3) / 2, D - 2.2 - k * 0.32);
    // Truss towers, the roof truss and canopy, the front lighting truss.
    for (const s of [-1, 1]) {
      add(geo.box, steel, 0.55, R, 0.55, s * (W / 2 + 0.6), R / 2, 1.2);
      add(geo.box, steel, 0.55, R, 0.55, s * (W / 2 + 0.6), R / 2, D - 0.6);
    }
    add(geo.box, steel, W + 1.8, 0.55, 0.55, 0, R, 1.2);
    add(geo.box, steel, W + 1.8, 0.55, 0.55, 0, R - 0.8, D - 0.6);
    for (const s of [-1, 1]) add(geo.box, steel, 0.55, 0.55, D - 1.2, s * (W / 2 + 0.6), R, D / 2 + 0.3);
    add(geo.box, black, W + 3, 0.3, D + 1.4, 0, R + 0.6, D / 2, false);
    // Hanging line arrays and the subs on the ground in front.
    for (const s of [-1, 1]) {
      for (let k = 0; k < 7; k++) {
        const box = add(geo.box, black, 1.3, 0.42, 0.9, s * (W / 2 + 2.4), R - 1.6 - k * 0.44, D - 0.8 + k * 0.03);
        box.rotation.x = -0.04 * k;
      }
      add(geo.box, black, 2.2, 1.1, 1.2, s * (W / 2 - 1.5), 0.55, D + 0.8);
    }
    // The drum kit on the riser, the keyboard on its stand.
    const shell = lit(0xa31621, 0.35, 0.3), head = lit(0xe8e4dc, 0.7, 0), brass = lit(0xc9a43a, 0.3, 0.9);
    const kit = new THREE.Group();
    kit.position.set(0, H + 0.5, 3.6);
    const dr = (r: number, h: number, x: number, y: number, z: number, rx = Math.PI / 2) => { const o = new THREE.Mesh(geo.cyl, shell); o.scale.set(r, h, r); o.position.set(x, y, z); o.rotation.x = rx; kit.add(o); return o; };
    dr(0.3, 0.45, 0, 0.32, 0.55);
    dr(0.18, 0.18, -0.38, 0.62, 0.2, 0.3);
    dr(0.16, 0.16, 0.36, 0.66, 0.22, 0.3);
    dr(0.2, 0.25, 0.55, 0.42, -0.15, 0);
    const snare = new THREE.Mesh(geo.cyl, head); snare.scale.set(0.18, 0.12, 0.18); snare.position.set(-0.32, 0.6, -0.1); kit.add(snare);
    for (const [x, y, z, r] of [[-0.75, 1.2, 0.1, 0.24], [0.8, 1.35, 0.25, 0.28], [-0.55, 0.92, -0.35, 0.2]]) {
      const c = new THREE.Mesh(geo.cyl, brass); c.scale.set(r, 0.01, r); c.position.set(x, y, z); c.rotation.z = 0.15; kit.add(c);
      const st = new THREE.Mesh(geo.cyl, steel); st.scale.set(0.012, y, 0.012); st.position.set(x, y / 2, z); kit.add(st);
    }
    g.add(kit);
    const keys = new THREE.Group();
    keys.position.set(-8.2, H, 4.4 + 0.75);
    const kb = new THREE.Mesh(geo.box, black); kb.scale.set(1.25, 0.08, 0.36); kb.position.y = 0.95; keys.add(kb);
    const ivory = new THREE.Mesh(geo.box, head); ivory.scale.set(1.15, 0.02, 0.14); ivory.position.set(0, 1.0, 0.08); keys.add(ivory);
    for (const s of [-1, 1]) { const leg = new THREE.Mesh(geo.box, steel); leg.scale.set(0.04, 0.95, 0.04); leg.position.set(s * 0.5, 0.47, 0); keys.add(leg); }
    keys.rotation.y = 0.35;
    g.add(keys);
    // The crush barrier along the front of the pit.
    const barrier = lit(0x8f949c, 0.5, 0.6);
    add(geo.box, barrier, W + 6, 1.15, 0.12, 0, 0.58, D + 2.5);
    // LED wall (drawn on a canvas, a few times a second).
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const smat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(20, 8), smat);
    screen.position.set(0, H + 1.4 + 4, 0.35);
    g.add(screen);
    add(geo.box, black, 20.6, 8.6, 0.3, 0, H + 1.4 + 4, 0.15);
    this.screen = { canvas, ctx, tex, mat: smat };
    // Light strips along the deck's edge and blinders on the front truss (emissive, pulsing).
    this.strips = new THREE.MeshBasicMaterial({ color: 0xff2a6d, toneMapped: false });
    const strip = new THREE.Mesh(geo.box, this.strips);
    strip.scale.set(W, 0.06, 0.06); strip.position.set(0, H - 0.05, D + 0.02);
    g.add(strip);
    this.blinders = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
    for (let k = 0; k < 6; k++) {
      const b = new THREE.Mesh(geo.box, this.blinders);
      b.scale.set(0.9, 0.45, 0.12);
      b.position.set(-W / 2 + 2 + k * ((W - 4) / 5), R - 1.4, D - 0.3);
      g.add(b);
    }
    // Moving beams from the front truss into the crowd, and searchlights into the sky.
    this.fade = beamFade();
    const beam = (x: number, y: number, z: number, sky: boolean, k: number) => {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, alphaMap: this.fade, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false });
      const mesh = new THREE.Mesh(geo.beam, mat);
      mesh.position.set(x, y, z);
      mesh.frustumCulled = false;
      mesh.renderOrder = 5;
      g.add(mesh);
      // A wider, fainter cone round it: the beam's edge is a soft glow, not a hard wall.
      const halo = mat.clone();
      const h = new THREE.Mesh(geo.beam, halo);
      h.scale.set(HALO, 1, HALO);
      h.frustumCulled = false;
      h.renderOrder = 5;
      mesh.add(h);
      this.beams.push({ mesh, mat, halo, base: new THREE.Vector3(x, y, z), yaw: 0, pitch: 0, k, sky });
    };
    for (let k = 0; k < 8; k++) beam(-W / 2 + 1.5 + k * ((W - 3) / 7), R - 0.9, D - 0.6, false, k);
    for (const [s, z] of [[-1, 1.2], [1, 1.2], [-1, D - 0.6], [1, D - 0.6]]) beam(s * (W / 2 + 0.6), R + 0.8, z, true, this.beams.length);
    // Pyro jets at the front corners (shown for the big moments).
    for (const x of [-W / 2 + 1.2, -W / 4, W / 4, W / 2 - 1.2]) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffa040, alphaMap: this.fade, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false });
      const mesh = new THREE.Mesh(geo.beam, mat);
      mesh.position.set(x, H, D - 0.4);
      mesh.scale.set(0.5, 0.01, 0.5);
      mesh.visible = false;
      g.add(mesh);
      this.pyro.push({ mesh, mat });
    }
  }

  /** Put the stage in the world: its back wall's centre at (x, y, z), facing `heading` (Pedestrians convention). */
  place(x: number, y: number, z: number, heading: number): void {
    this.group.position.set(x, y, z);
    // (+z local is the way the band faces: heading h faces (-sin h, -cos h).)
    this.group.rotation.y = heading + Math.PI;
  }

  /** Fire the pyro jets (the opener's start, the last chorus). */
  boom(): void { this.pyroT = 1.6; }

  /** Next song: the next colours. */
  nextLook(): void { this.palette = (this.palette + 1) % PALETTES.length; }

  /**
   * One frame of the show. `energy` 0…1 (the music's loudness now), `beat` the song's beats (or NaN
   * between songs), `night` 0…1, `on` the show running (false: work lights, beams off).
   */
  update(dt: number, time: number, energy: number, beat: number, night: number, on: boolean, spectrum: (lo: number, hi: number) => number): void {
    const pal = PALETTES[this.palette];
    const song = on && !Number.isNaN(beat);
    const pulse = song ? Math.pow(1 - (((beat % 1) + 1) % 1), 3) : 0;
    const e = clamp(energy * 1.6, 0, 1);
    const col = new THREE.Color();
    for (const b of this.beams) {
      if (b.sky) {
        // Searchlights: slow sweeps, only after dusk, whenever the show is on.
        const a = time * 0.25 + b.k * 1.7;
        b.mesh.quaternion.setFromUnitVectors(_y, _d.set(Math.sin(a) * 0.4, 1, Math.cos(a * 0.8) * 0.4).normalize());
        // (Wide and faint: a shaft of light in the haze, not a stick.)
        b.mesh.scale.set(9, 240, 9);
        b.mat.opacity = on ? 0.02 * night : 0;
        b.mat.color.setHex(0xe8f0ff);
        b.halo.opacity = b.mat.opacity * 0.45;
        b.halo.color.copy(b.mat.color);
        continue;
      }
      // Into the crowd: fanning sweeps on the beat, colours from the song's palette.
      const t = (song ? beat * 0.5 : time * 0.3) + b.k * 0.6;
      // (Steep enough to land on the field, never out over the stands.)
      const yaw = Math.sin(t * 0.9 + b.k) * 0.55;
      const pitch = 0.5 + Math.sin(t * 0.7 + b.k * 0.4) * 0.2;
      b.mesh.quaternion.setFromUnitVectors(_y, _d.set(Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).normalize());
      // Just as long as it takes to reach the ground: there it has faded out (no bright cap).
      const len = b.base.y / Math.sin(pitch);
      b.mesh.scale.set(len * 0.045, len, len * 0.045);
      col.setHex(pal[(b.k + Math.floor(song ? beat / 8 : 0)) % pal.length]);
      b.mat.color.copy(col);
      b.mat.opacity = song ? (0.03 + 0.06 * e + 0.05 * pulse) * (0.45 + 0.55 * night) : on ? 0.02 : 0;
      b.halo.opacity = b.mat.opacity * 0.3;
      b.halo.color.copy(col);
    }
    // Edge strip and blinders: the beat.
    this.strips.color.setHex(pal[0]).multiplyScalar(song ? 0.6 + 1.6 * pulse * e : on ? 0.4 : 0.05);
    const hit = song && pulse > 0.8 && e > 0.55 && Math.floor(beat) % 4 === 0;
    this.blinders.color.setRGB(1, 0.93, 0.8).multiplyScalar(hit ? 3 : song ? 0.15 * e : 0);
    // Pyro.
    this.pyroT = Math.max(0, this.pyroT - dt);
    for (const p of this.pyro) {
      const f = this.pyroT > 0 ? Math.sin((this.pyroT / 1.6) * Math.PI) : 0;
      p.mesh.visible = f > 0.01;
      p.mesh.scale.set(0.45 + f * 0.25, 0.5 + f * 7 * (0.85 + Math.random() * 0.3), 0.45 + f * 0.25);
      p.mat.opacity = f * 0.9;
    }
    // The LED wall, ~15 times a second.
    this.screenT -= dt;
    if (this.screenT <= 0) { this.screenT = 1 / 15; this.drawScreen(time, song, beat, e, pal, on, spectrum); }
  }

  private drawScreen(time: number, song: boolean, beat: number, e: number, pal: number[], on: boolean, spectrum: (lo: number, hi: number) => number): void {
    const { ctx, canvas, tex } = this.screen;
    const w = canvas.width, h = canvas.height;
    const hex = (c: number, a = 1) => `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;
    ctx.fillStyle = '#05040a';
    ctx.fillRect(0, 0, w, h);
    if (!on) { tex.needsUpdate = true; return; }
    if (song) {
      // A spectrum of light bars, mirrored from the middle, over a moving gradient.
      const gr = ctx.createLinearGradient(0, 0, w, h);
      const s = (time * 0.1) % 1;
      gr.addColorStop(0, hex(pal[0], 0.35 + 0.3 * e));
      gr.addColorStop(clamp(0.3 + 0.4 * s, 0, 1), hex(pal[1], 0.25 + 0.25 * e));
      gr.addColorStop(1, hex(pal[2], 0.2));
      ctx.fillStyle = gr;
      ctx.fillRect(0, 0, w, h);
      const n = this.bars.length;
      for (let i = 0; i < n; i++) {
        const v = spectrum(i / n * 0.5, (i + 1) / n * 0.5);
        this.bars[i] = Math.max(v, this.bars[i] * 0.82);
      }
      const bw = w / (n * 2);
      for (let i = 0; i < n; i++) {
        const bh = this.bars[i] * h * 0.9;
        ctx.fillStyle = hex(pal[i % 2 ? 1 : 2], 0.85);
        ctx.fillRect(w / 2 + i * bw + 1, h - bh, bw - 2, bh);
        ctx.fillRect(w / 2 - (i + 1) * bw + 1, h - bh, bw - 2, bh);
      }
      // The act's name flashing in on the bar.
      const p = Math.pow(1 - (((beat % 4) + 4) % 4) / 4, 2);
      ctx.font = 'bold 96px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = `rgba(255,255,255,${0.15 + 0.6 * p})`;
      ctx.fillText(this.act, w / 2, h * 0.42);
    } else {
      ctx.font = 'bold 110px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = hex(pal[0], 0.9 + 0.1 * Math.sin(time * 2));
      ctx.fillText(this.act, w / 2, h * 0.4);
      if (this.title) {
        ctx.font = '36px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillText(this.title, w / 2, h * 0.78);
      }
    }
    tex.needsUpdate = true;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      for (const mt of Array.isArray(m.material) ? m.material : [m.material]) mt.dispose();
    });
    this.screen.tex.dispose();
    this.fade.dispose();
  }
}

const _y = new THREE.Vector3(0, 1, 0), _d = new THREE.Vector3();
/** The glow cone round a beam: this much wider. */
const HALO = 2.2;
