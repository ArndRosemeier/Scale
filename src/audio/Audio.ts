/**
 * Web Audio engine: spatial one-shots with variations and pitch, and an
 * ambience mixer whose layers crossfade with the context around the listener.
 * Audio starts on the first user gesture (browser autoplay rules).
 */
import * as THREE from 'three';

interface ManifestEntry { files: string[]; loop: boolean; gain: number; description?: string }
type Manifest = Record<string, ManifestEntry>;

export type AmbienceLayer = 'amb_city_day' | 'amb_city_night' | 'amb_park' | 'amb_river' | 'amb_sea' | 'amb_wind_flight' | 'amb_sewer' | 'amb_metro' | 'amb_interior' | 'amb_crowd';

export class Audio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private ambBus!: GainNode;
  private manifest: Manifest = {};
  private buffers = new Map<string, AudioBuffer[]>();
  private loading = new Map<string, Promise<AudioBuffer[]>>();
  private amb = new Map<string, { src: AudioBufferSourceNode; gain: GainNode; target: number }>();
  private base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  private voices = 0;
  enabled = true;
  /** Master volume 0…1 and mute, remembered across sessions; `?mute` in the URL forces silence (tests). */
  volume = readNum(VOL_KEY, 0.8);
  muted = readNum(MUTE_KEY, 0) > 0 || new URLSearchParams(location.search).has('mute');

  async init(): Promise<void> {
    try {
      this.manifest = await (await fetch(`${this.base}sounds/manifest.json`)).json();
    } catch { this.manifest = {}; }
    const start = () => {
      if (this.ctx) return;
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.gain;
      // Gentle limiter so explosions don't clip.
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -10; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.25;
      this.master.connect(comp).connect(this.ctx.destination);
      this.sfxBus = this.ctx.createGain();
      this.ambBus = this.ctx.createGain();
      this.sfxBus.connect(this.master);
      this.ambBus.connect(this.master);
      for (const id of Object.keys(this.manifest)) if (id.startsWith('amb_')) void this.load(id);
    };
    window.addEventListener('pointerdown', start, { once: false });
    window.addEventListener('keydown', start, { once: false });
  }

  private load(id: string): Promise<AudioBuffer[]> {
    const m = this.manifest[id];
    if (!m || !this.ctx) return Promise.resolve([]);
    let p = this.loading.get(id);
    if (p) return p;
    const ctx = this.ctx;
    p = Promise.all(m.files.map(async (f) => ctx.decodeAudioData(await (await fetch(`${this.base}sounds/${f}`)).arrayBuffer()))).then((bufs) => {
      this.buffers.set(id, bufs);
      return bufs;
    }).catch(() => []);
    this.loading.set(id, p);
    return p;
  }

  /** Listener at the camera. */
  updateListener(cam: THREE.Camera): void {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const p = cam.position;
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const u = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(p.x, t); l.positionY.setValueAtTime(p.y, t); l.positionZ.setValueAtTime(p.z, t);
      l.forwardX.setValueAtTime(f.x, t); l.forwardY.setValueAtTime(f.y, t); l.forwardZ.setValueAtTime(f.z, t);
      l.upX.setValueAtTime(u.x, t); l.upY.setValueAtTime(u.y, t); l.upZ.setValueAtTime(u.z, t);
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
  }

  /**
   * Spatial one-shot. `refDist` is the distance at which the sound plays at full gain
   * (bigger for big events). Sound travels: a delay of distance / 343 m/s is applied.
   */
  play(id: string, x: number, y: number, z: number, gain = 1, pitch = 1, refDist = 4, listener?: THREE.Vector3): void {
    if (!this.ctx || !this.enabled || this.voices > 48) return;
    const m = this.manifest[id];
    if (!m) return;
    const ctx = this.ctx;
    const go = (bufs: AudioBuffer[]) => {
      if (!bufs.length) return;
      const src = ctx.createBufferSource();
      src.buffer = bufs[(Math.random() * bufs.length) | 0];
      src.playbackRate.value = pitch * (0.94 + Math.random() * 0.12);
      const g = ctx.createGain();
      g.gain.value = gain * m.gain;
      const pan = ctx.createPanner();
      pan.panningModel = 'HRTF';
      pan.distanceModel = 'inverse';
      pan.refDistance = refDist;
      pan.rolloffFactor = 1;
      pan.maxDistance = 20000;
      pan.positionX.value = x; pan.positionY.value = y; pan.positionZ.value = z;
      src.connect(g).connect(pan).connect(this.sfxBus);
      const delay = listener ? Math.min(3, listener.distanceTo(new THREE.Vector3(x, y, z)) / 343) : 0;
      src.start(ctx.currentTime + delay);
      this.voices++;
      src.onended = () => { this.voices--; g.disconnect(); pan.disconnect(); };
    };
    const b = this.buffers.get(id);
    if (b) go(b);
    else void this.load(id).then(go);
  }

  /** Non-spatial one-shot (UI, the player's own body). */
  play2d(id: string, gain = 1, pitch = 1): void {
    if (!this.ctx || !this.enabled) return;
    const m = this.manifest[id];
    if (!m) return;
    const go = (bufs: AudioBuffer[]) => {
      if (!bufs.length || !this.ctx) return;
      const src = this.ctx.createBufferSource();
      src.buffer = bufs[(Math.random() * bufs.length) | 0];
      src.playbackRate.value = pitch;
      const g = this.ctx.createGain();
      g.gain.value = gain * m.gain;
      src.connect(g).connect(this.sfxBus);
      src.start();
    };
    const b = this.buffers.get(id);
    if (b) go(b);
    else void this.load(id).then(go);
  }

  /**
   * Short synthesized UI tones (no clip needed): a power core pickup, karma, buying a
   * power, a refused action.
   */
  chime(kind: 'core' | 'karma' | 'buy' | 'deny', gain = 0.5): void {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx, t0 = ctx.currentTime + 0.01;
    const notes: [number, number, number][] = kind === 'core' ? [[660, 0, 0.5], [990, 0.07, 0.55], [1320, 0.14, 0.7], [1980, 0.22, 0.9]]
      : kind === 'karma' ? [[784, 0, 0.35], [1175, 0.09, 0.5]]
      : kind === 'buy' ? [[523, 0, 0.4], [659, 0.06, 0.4], [784, 0.12, 0.45], [1047, 0.18, 0.7]]
      : [[220, 0, 0.18], [185, 0.08, 0.22]];
    for (const [f, dt, dur] of notes) {
      const o = ctx.createOscillator();
      o.type = kind === 'deny' ? 'square' : 'sine';
      o.frequency.setValueAtTime(f, t0 + dt);
      if (kind === 'core') o.frequency.exponentialRampToValueAtTime(f * 1.01, t0 + dt + dur);
      const g = ctx.createGain();
      const peak = gain * (kind === 'deny' ? 0.08 : 0.22);
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(peak, t0 + dt + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + dur);
      o.connect(g).connect(this.sfxBus);
      o.start(t0 + dt);
      o.stop(t0 + dt + dur + 0.05);
      o.onended = () => g.disconnect();
    }
  }

  /**
   * A positioned looping source (rotor buzz, motor hum) that its owner moves every frame.
   * Null until audio has started and the clip is loaded (call again later).
   */
  loop(id: string, refDist = 5): { set(x: number, y: number, z: number, gain: number, rate?: number): void; stop(): void } | null {
    if (!this.ctx || !this.enabled) return null;
    const m = this.manifest[id];
    const bufs = this.buffers.get(id);
    if (!m || !bufs?.length) { if (m) void this.load(id); return null; }
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = bufs[0];
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = 0;
    const pan = ctx.createPanner();
    pan.panningModel = 'HRTF';
    pan.distanceModel = 'inverse';
    pan.refDistance = refDist;
    pan.rolloffFactor = 1.2;
    src.connect(g).connect(pan).connect(this.sfxBus);
    src.start(0, Math.random() * bufs[0].duration);
    return {
      set: (x, y, z, gain, rate = 1) => {
        const t = ctx.currentTime;
        pan.positionX.setTargetAtTime(x, t, 0.05); pan.positionY.setTargetAtTime(y, t, 0.05); pan.positionZ.setTargetAtTime(z, t, 0.05);
        g.gain.setTargetAtTime(gain * m.gain, t, 0.15);
        src.playbackRate.setTargetAtTime(rate, t, 0.2);
      },
      stop: () => { try { src.stop(); } catch { /* not started */ } g.disconnect(); pan.disconnect(); },
    };
  }

  /** The effects bus for procedural sounds (PowerSynth); null until audio has started. */
  synthOut(): { ctx: AudioContext; out: AudioNode } | null {
    return this.ctx && this.enabled ? { ctx: this.ctx, out: this.sfxBus } : null;
  }

  /** Set target levels for ambience layers (0..1); they crossfade smoothly. */
  setAmbience(levels: Partial<Record<AmbienceLayer, number>>, rates: Partial<Record<AmbienceLayer, number>> = {}): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    for (const [id, lvl] of Object.entries(levels) as [AmbienceLayer, number][]) {
      let a = this.amb.get(id);
      const bufs = this.buffers.get(id);
      if (!a) {
        if (!bufs?.length || lvl <= 0.001) continue;
        const src = ctx.createBufferSource();
        src.buffer = bufs[0];
        src.loop = true;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        src.connect(gain).connect(this.ambBus);
        src.start(0, Math.random() * bufs[0].duration);
        a = { src, gain, target: 0 };
        this.amb.set(id, a);
      }
      a.target = lvl * (this.manifest[id]?.gain ?? 1);
      a.gain.gain.setTargetAtTime(a.target, ctx.currentTime, 0.6);
      const r = rates[id];
      if (r !== undefined) a.src.playbackRate.setTargetAtTime(r, ctx.currentTime, 0.2);
    }
  }

  private get gain(): number { return this.muted ? 0 : this.volume; }

  setVolume(v: number): void {
    this.volume = v;
    if (v > 0) this.muted = false;
    this.apply();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.apply();
  }

  private apply(): void {
    if (this.master) this.master.gain.value = this.gain;
    try {
      localStorage.setItem(VOL_KEY, String(this.volume));
      localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch { /* storage unavailable */ }
  }
}

const VOL_KEY = 'scale.volume', MUTE_KEY = 'scale.muted';
function readNum(key: string, def: number): number {
  try { const v = localStorage.getItem(key); return v === null || isNaN(Number(v)) ? def : Number(v); } catch { return def; }
}
