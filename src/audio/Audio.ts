/**
 * Web Audio engine: spatial one-shots with variations and pitch, and an
 * ambience mixer whose layers crossfade with the context around the listener.
 * Audio starts on the first user gesture (browser autoplay rules).
 */
import * as THREE from 'three';
import { Spot, heard, listenerDist, listenerPos } from './hearing';
import { versioned } from '../core/versioned';

/** A streamed piece placed in the world (Audio.stream). */
export interface LiveStream {
  el: HTMLAudioElement;
  /** Position, gain and lowpass cutoff (Hz) now. */
  set(x: number, y: number, z: number, gain: number, cutoff?: number): void;
  /** Loudness of a band of the spectrum (fractions of Nyquist), 0…1. */
  level(lo?: number, hi?: number): number;
  /** Seconds into the piece. */
  time(): number;
  ended(): boolean;
  /** Fade out over about `sec` seconds (then stop it). */
  fade(sec: number): void;
  stop(): void;
}

/** One entry of the sound log. */
export interface SoundNote { t: number; id: string; d: number }

interface ManifestEntry { files: string[]; loop: boolean; gain: number; description?: string }
type Manifest = Record<string, ManifestEntry>;

export type AmbienceLayer = 'amb_city_day' | 'amb_city_night' | 'amb_park' | 'amb_river' | 'amb_sea' | 'amb_wind_flight' | 'amb_sewer' | 'amb_metro' | 'amb_interior' | 'amb_crowd' | 'amb_rain_light' | 'amb_rain_heavy' | 'amb_wind_gust';

/** Volume categories for the sound mix (pause menu): every sound belongs to one (see categoryOf). */
export type SoundCategory = 'music' | 'alarms' | 'voices' | 'traffic' | 'destruction' | 'powers' | 'monsters' | 'animals' | 'ambience' | 'steps' | 'ui';
export const SOUND_CATEGORIES: { id: SoundCategory; name: string }[] = [
  { id: 'music', name: 'Music' },
  { id: 'alarms', name: 'Alarms & sirens' },
  { id: 'voices', name: 'Voices & crowds' },
  { id: 'traffic', name: 'Traffic & trains' },
  { id: 'destruction', name: 'Destruction & explosions' },
  { id: 'powers', name: 'Powers & fighting' },
  { id: 'monsters', name: 'Monsters & machines' },
  { id: 'animals', name: 'Animals' },
  { id: 'ambience', name: 'City ambience & weather' },
  { id: 'steps', name: 'Footsteps & doors' },
  { id: 'ui', name: 'Interface chimes' },
];
const CATEGORY_RULES: [RegExp, SoundCategory][] = [
  [/^(siren_|civil_siren|alarm_bell|car_alarm)/, 'alarms'],
  [/^(scream_|crowd_|protest_|terrace_|amb_crowd|street_)/, 'voices'],
  [/^(amb_|thunder_|under_|deep_|heart_pulse)/, 'ambience'],
  [/^(strider_|burrower_|leviathan_|roc_|mech_|robot_|tremor_|step_giant|murk_|maw_|ufo_|teen_)/, 'monsters'],
  [/^(car_|bus_|tire_|metro_|drone_)/, 'traffic'],
  [/^(explosion|collapse_|concrete_|glass_|debris_|dust_|metal_|tree_|splash_)/, 'destruction'],
  [/^(bird_|slime_|lumen_|membrane)/, 'animals'],
  [/^(step_|door_)/, 'steps'],
];
/** The level a category starts at (and goes back to on reset): the background music sits lower than the rest. */
export function defaultMix(cat: SoundCategory): number { return cat === 'music' ? 0.65 : 1; }

/** The category of a sound id (anything unlisted counts as powers & fighting: punches, whooshes, impacts). */
export function categoryOf(id: string): SoundCategory {
  for (const [re, c] of CATEGORY_RULES) if (re.test(id)) return c;
  return 'powers';
}

export class Audio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  /** The last node before the speakers (after the limiter): what the clip recorder taps. */
  private out: AudioNode | null = null;
  private sfxBus!: GainNode;
  private ambBus!: GainNode;
  /** One gain per category between the sources and the buses (the sound mix). */
  private cats = new Map<SoundCategory, GainNode>();
  /** Category levels 0…1.5 (1 = as designed), remembered across sessions. */
  readonly mix: Record<SoundCategory, number> = readMix();
  private manifest: Manifest = {};
  private buffers = new Map<string, AudioBuffer[]>();
  private loading = new Map<string, Promise<AudioBuffer[]>>();
  private amb = new Map<string, { src: AudioBufferSourceNode; gain: GainNode; target: number }>();
  /** When each sound was last wanted (s): decoded clips nobody wanted for IDLE_S are dropped. */
  private used = new Map<string, number>();
  private sweptAt = 0;
  private base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  private voices = 0;
  enabled = true;
  /** Master volume 0…1 and mute, remembered across sessions; `?mute` in the URL forces silence (tests). */
  volume = readNum(VOL_KEY, 0.8);
  muted = readNum(MUTE_KEY, 0) > 0 || new URLSearchParams(location.search).has('mute');
  /** The last sounds started (newest last): the sound log (debug/SoundLog, Shift+F7). */
  readonly recent: SoundNote[] = [];

  /** Note a sound for the sound log: `d` metres from the listener, -1 = not placed (UI, the hero's own). */
  note(id: string, d: number): void {
    this.recent.push({ t: performance.now() / 1000, id, d });
    if (this.recent.length > 60) this.recent.shift();
  }

  /** Sounds switched off one by one (pause menu › Sound effects), remembered: they never play. */
  private off: Set<string> = readOff();
  /** Bypasses the switches while a sound is previewed. */
  private previewing = false;

  isOff(id: string): boolean { return !this.previewing && this.off.has(id); }

  /** Switch one sound off or on (remembered across sessions). */
  setOff(id: string, off: boolean): void {
    if (off) this.off.add(id); else this.off.delete(id);
    try { localStorage.setItem(OFF_KEY, JSON.stringify([...this.off])); } catch { /* storage unavailable */ }
  }

  /** Every clip sound and synthesized chime the game has (the Sound effects list). */
  soundIds(): { id: string; description: string; loop: boolean }[] {
    return [
      ...Object.entries(this.manifest).map(([id, m]) => ({ id, description: m.description ?? '', loop: m.loop })),
      ...CHIME_KINDS.map((k) => ({ id: `chime_${k}`, description: CHIME_TEXT[k], loop: false })),
    ];
  }

  /**
   * Play a sound once, here, whatever its switch says (the Sound effects list): a loop plays
   * for a few seconds and fades. It goes through its category's level of the mix as in game.
   */
  preview(id: string): void {
    this.wake();
    if (!this.ctx) return;
    if (id.startsWith('chime_')) {
      this.previewing = true;
      try { this.chime(id.slice(6) as ChimeKind); } finally { this.previewing = false; }
      return;
    }
    const m = this.manifest[id];
    if (!m) return;
    const ctx = this.ctx;
    const go = (bufs: AudioBuffer[]) => {
      if (!bufs.length) return;
      const src = ctx.createBufferSource();
      src.buffer = bufs[(Math.random() * bufs.length) | 0];
      const g = ctx.createGain();
      g.gain.value = m.gain;
      src.connect(g).connect(this.bus(id));
      const t = ctx.currentTime;
      src.start(t);
      if (m.loop || src.buffer.duration > PREVIEW_S) {
        src.loop = m.loop;
        g.gain.setValueAtTime(m.gain, t + PREVIEW_S - 0.6);
        g.gain.linearRampToValueAtTime(0, t + PREVIEW_S);
        src.stop(t + PREVIEW_S + 0.05);
      }
      src.onended = () => g.disconnect();
    };
    const b = this.buffers.get(id);
    if (b) { this.used.set(id, performance.now() / 1000); go(b); } else void this.load(id).then(go);
  }

  /** Background music on/off (pause menu), remembered; its level is the 'music' category of the mix. */
  musicOn = readNum(MUSIC_KEY, 1) > 0;

  async init(): Promise<void> {
    try {
      this.manifest = await (await fetch(versioned(`${this.base}sounds/manifest.json`))).json();
    } catch { this.manifest = {}; }
    const start = () => {
      if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {}); return; }
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.gain;
      // Gentle limiter so explosions don't clip.
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -10; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.25;
      this.master.connect(comp).connect(this.ctx.destination);
      this.out = comp;
      this.sfxBus = this.ctx.createGain();
      this.ambBus = this.ctx.createGain();
      this.sfxBus.connect(this.master);
      this.ambBus.connect(this.master);
      for (const c of SOUND_CATEGORIES) {
        const g = this.ctx.createGain();
        g.gain.value = this.mix[c.id];
        g.connect(c.id === 'ambience' ? this.ambBus : c.id === 'music' ? this.master : this.sfxBus);
        this.cats.set(c.id, g);
      }
    };
    // (iPad Safari only lets a touch's end start audio: pointerdown is not a gesture there.)
    for (const ev of ['pointerdown', 'pointerup', 'touchend', 'keydown']) window.addEventListener(ev, start, { passive: true });
    this.wake = start;
    // After a gesture on the page (the start menu's click) the context may start right away.
    if ((navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive) start();
  }

  /** Start (or resume) the audio context now — allowed once the page has had a user gesture. */
  wake: () => void = () => {};

  private load(id: string): Promise<AudioBuffer[]> {
    this.used.set(id, performance.now() / 1000);
    const m = this.manifest[id];
    if (!m || !this.ctx) return Promise.resolve([]);
    let p = this.loading.get(id);
    if (p) return p;
    const ctx = this.ctx;
    p = Promise.all(m.files.map(async (f) => ctx.decodeAudioData(await (await fetch(versioned(`${this.base}sounds/${f}`))).arrayBuffer()))).then((bufs) => {
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
    listenerPos.copy(p);
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
   * Out of its audible range (hearing.ts: by loudness and refDist) it is not played at all.
   */
  play(id: string, x: number, y: number, z: number, gain = 1, pitch = 1, refDist = 4, listener?: THREE.Vector3): void {
    if (!this.ctx || !this.enabled || this.voices > 48 || this.isOff(id)) return;
    const m = this.manifest[id];
    if (!m || !heard(x, y, z, gain * m.gain, refDist)) return;
    this.note(id, listenerDist(x, y, z));
    const ctx = this.ctx;
    const go = (bufs: AudioBuffer[]) => {
      if (!bufs.length) return;
      const src = ctx.createBufferSource();
      src.buffer = bufs[(Math.random() * bufs.length) | 0];
      src.playbackRate.value = pitch * (0.94 + Math.random() * 0.12);
      const g = ctx.createGain();
      g.gain.value = gain * m.gain;
      const spot = new Spot(ctx, this.bus(id), refDist);
      spot.place(x, y, z, gain * m.gain, true);
      src.connect(g).connect(spot.input);
      const delay = listener ? Math.min(3, listener.distanceTo(new THREE.Vector3(x, y, z)) / 343) : 0;
      src.start(ctx.currentTime + delay);
      this.voices++;
      src.onended = () => { this.voices--; g.disconnect(); spot.disconnect(); };
    };
    const b = this.buffers.get(id);
    if (b) { this.used.set(id, performance.now() / 1000); go(b); } else void this.load(id).then(go);
  }

  /** Non-spatial one-shot (UI, the player's own body). */
  play2d(id: string, gain = 1, pitch = 1): void {
    if (!this.ctx || !this.enabled || this.isOff(id)) return;
    const m = this.manifest[id];
    if (!m) return;
    this.note(id, -1);
    const go = (bufs: AudioBuffer[]) => {
      if (!bufs.length || !this.ctx) return;
      const src = this.ctx.createBufferSource();
      src.buffer = bufs[(Math.random() * bufs.length) | 0];
      src.playbackRate.value = pitch;
      const g = this.ctx.createGain();
      g.gain.value = gain * m.gain;
      src.connect(g).connect(this.bus(id));
      src.start();
    };
    const b = this.buffers.get(id);
    if (b) { this.used.set(id, performance.now() / 1000); go(b); } else void this.load(id).then(go);
  }

  /**
   * Short synthesized UI tones (no clip needed): a power core pickup, karma, buying a
   * power, a refused action.
   */
  chime(kind: ChimeKind, gain = 0.5): void {
    if (!this.ctx || !this.enabled || this.isOff(`chime_${kind}`)) return;
    this.note(`chime_${kind}`, -1);
    const ctx = this.ctx, t0 = ctx.currentTime + 0.01;
    if (kind === 'radio') { this.squelch(gain); return; }
    const notes: [number, number, number][] = kind === 'core' ? [[660, 0, 0.5], [990, 0.07, 0.55], [1320, 0.14, 0.7], [1980, 0.22, 0.9]]
      : kind === 'karma' ? [[784, 0, 0.35], [1175, 0.09, 0.5]]
      : kind === 'buy' ? [[523, 0, 0.4], [659, 0.06, 0.4], [784, 0.12, 0.45], [1047, 0.18, 0.7]]
      // An important line for the tracker (game/story): two soft low notes, unlike any other.
      : kind === 'story' ? [[392, 0, 0.55], [587, 0.16, 0.8]]
      : [[220, 0, 0.18], [185, 0.08, 0.22]];
    for (const [f, dt, dur] of notes) {
      const o = ctx.createOscillator();
      o.type = kind === 'deny' ? 'square' : kind === 'story' ? 'triangle' : 'sine';
      o.frequency.setValueAtTime(f, t0 + dt);
      if (kind === 'core') o.frequency.exponentialRampToValueAtTime(f * 1.01, t0 + dt + dur);
      const g = ctx.createGain();
      const peak = gain * (kind === 'deny' ? 0.08 : 0.22);
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(peak, t0 + dt + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + dur);
      o.connect(g).connect(this.cats.get('ui') ?? this.sfxBus);
      o.start(t0 + dt);
      o.stop(t0 + dt + dur + 0.05);
      o.onended = () => g.disconnect();
    }
  }

  /**
   * The police radio (game/crime/PoliceRadio): a short burst of band-passed static, then the
   * two-tone talk-permit chirp of a handheld radio. No voice: the words are a toast.
   */
  private squelch(gain: number): void {
    const ctx = this.ctx!, t0 = ctx.currentTime + 0.01, out = this.cats.get('ui') ?? this.sfxBus;
    const len = Math.floor(ctx.sampleRate * 0.16), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const n = ctx.createBufferSource();
    n.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.9;
    const ng = ctx.createGain();
    ng.gain.value = gain * 0.16;
    n.connect(bp).connect(ng).connect(out);
    n.start(t0);
    n.onended = () => { bp.disconnect(); ng.disconnect(); };
    for (const [f, dt, dur] of [[1250, 0.17, 0.07], [1650, 0.245, 0.09]] as const) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.setValueAtTime(f, t0 + dt);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(gain * 0.045, t0 + dt + 0.006);
      g.gain.setValueAtTime(gain * 0.045, t0 + dt + dur - 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + dur);
      o.connect(g).connect(out);
      o.start(t0 + dt);
      o.stop(t0 + dt + dur + 0.03);
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
    this.used.set(id, performance.now() / 1000);
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = bufs[0];
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = 0;
    const spot = new Spot(ctx, this.bus(id), refDist, 1.2);
    src.connect(g).connect(spot.input);
    src.start(0, Math.random() * bufs[0].duration);
    return {
      set: (x, y, z, gain, rate = 1) => {
        const t = ctx.currentTime;
        // (A sound switched off keeps running silent, so switching it on again brings it back.)
        const v = this.off.has(id) ? 0 : gain * m.gain;
        spot.place(x, y, z, v);
        g.gain.setTargetAtTime(v, t, 0.15);
        src.playbackRate.setTargetAtTime(rate, t, 0.2);
      },
      stop: () => { try { src.stop(); } catch { /* not started */ } g.disconnect(); spot.disconnect(); },
    };
  }

  /**
   * A positioned streamed piece (an MP3 through an audio element: nothing is decoded up front, a
   * three-minute song costs no memory) that its owner moves and sets every frame: the stadium
   * concert, a street band. `set` takes a lowpass cutoff too (far off, or heard through the stands,
   * only the low end carries). `level()` is the music's loudness now (0…1, for lights and crowds).
   * Null until audio has started.
   */
  stream(url: string, o: { refDist?: number; rolloff?: number; loop?: boolean; cat?: SoundCategory; offset?: number } = {}): LiveStream | null {
    if (!this.ctx || !this.enabled) return null;
    const ctx = this.ctx;
    const el = new window.Audio();
    el.src = url.startsWith('http') ? url : versioned(url.startsWith('/') ? url : `${this.base}${url}`);
    el.preload = 'auto';
    el.loop = !!o.loop;
    if (o.offset) el.currentTime = o.offset;
    const node = ctx.createMediaElementSource(el);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 18000;
    lp.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.value = 0;
    const spot = new Spot(ctx, this.cats.get(o.cat ?? 'music') ?? this.sfxBus, o.refDist ?? 5, o.rolloff ?? 1, 'equalpower');
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    an.smoothingTimeConstant = 0.5;
    const bins = new Uint8Array(an.frequencyBinCount);
    node.connect(an);
    node.connect(lp).connect(g).connect(spot.input);
    let started = false, retryAt = 0, stopped = false;
    const tryPlay = () => {
      if (started || stopped || performance.now() < retryAt) return;
      started = true;
      el.play().catch(() => { started = false; retryAt = performance.now() + 1500; });
    };
    tryPlay();
    return {
      el,
      set: (x, y, z, gain, cutoff = 18000) => {
        if (stopped) return;
        tryPlay();
        const t = ctx.currentTime;
        spot.place(x, y, z, gain);
        g.gain.setTargetAtTime(gain, t, 0.25);
        lp.frequency.setTargetAtTime(cutoff, t, 0.3);
      },
      level: (lo = 0, hi = 1) => {
        an.getByteFrequencyData(bins);
        const a = Math.floor(lo * bins.length), b = Math.max(a + 1, Math.floor(hi * bins.length));
        let s = 0;
        for (let i = a; i < b; i++) s += bins[i];
        return s / ((b - a) * 255);
      },
      time: () => el.currentTime,
      ended: () => el.ended,
      fade: (sec) => { if (!stopped) g.gain.setTargetAtTime(0, ctx.currentTime, Math.max(0.05, sec / 3)); },
      stop: () => {
        if (stopped) return;
        stopped = true;
        el.pause();
        el.removeAttribute('src');
        el.load();
        node.disconnect(); an.disconnect(); lp.disconnect(); g.disconnect(); spot.disconnect();
      },
    };
  }

  /** The effects bus for procedural sounds (PowerSynth); null until audio has started. */
  synthOut(): { ctx: AudioContext; out: AudioNode } | null {
    return this.ctx && this.enabled ? { ctx: this.ctx, out: this.cats.get('powers') ?? this.sfxBus } : null;
  }

  /** Set target levels for ambience layers (0..1); they crossfade smoothly. */
  setAmbience(levels: Partial<Record<AmbienceLayer, number>>, rates: Partial<Record<AmbienceLayer, number>> = {}): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const now = performance.now() / 1000;
    for (const [id, lvl] of Object.entries(levels) as [AmbienceLayer, number][]) {
      let a = this.amb.get(id);
      const bufs = this.buffers.get(id);
      // A layer is loaded when it is first heard (it fades in once decoded), not all at start.
      if (lvl > 0.001) { if (bufs?.length) this.used.set(id, now); else if (this.manifest[id]) void this.load(id); }
      if (!a) {
        if (!bufs?.length || lvl <= 0.001) continue;
        const src = ctx.createBufferSource();
        src.buffer = bufs[0];
        src.loop = true;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        src.connect(gain).connect(this.bus(id));
        src.start(0, Math.random() * bufs[0].duration);
        a = { src, gain, target: 0 };
        this.amb.set(id, a);
      }
      a.target = this.off.has(id) ? 0 : lvl * (this.manifest[id]?.gain ?? 1);
      a.gain.gain.setTargetAtTime(a.target, ctx.currentTime, 0.6);
      const r = rates[id];
      if (r !== undefined) a.src.playbackRate.setTargetAtTime(r, ctx.currentTime, 0.2);
    }
    if (now - this.sweptAt > 10) { this.sweptAt = now; this.dropIdle(now); }
  }

  /**
   * Decoded audio is float PCM, about ten times its file size (an ambience bed ≈ 8 MB): clips
   * and ambience layers nobody wanted for IDLE_S are dropped and decoded again when next needed.
   * (A source still playing keeps its own buffer until it ends.)
   */
  private dropIdle(now: number): void {
    for (const id of [...this.buffers.keys()]) {
      if (now - (this.used.get(id) ?? 0) < IDLE_S) continue;
      const a = this.amb.get(id);
      if (a) { try { a.src.stop(); } catch { /* not started */ } a.src.disconnect(); a.gain.disconnect(); this.amb.delete(id); }
      this.buffers.delete(id);
      this.loading.delete(id);
    }
  }

  /** Where the background music plays into (the 'music' category of the mix), once audio runs. */
  musicOut(): { ctx: AudioContext; out: AudioNode } | null {
    const g = this.cats.get('music');
    return this.ctx && g ? { ctx: this.ctx, out: g } : null;
  }

  setMusicOn(on: boolean): void {
    this.musicOn = on;
    try { localStorage.setItem(MUSIC_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
  }

  /** The category gain a sound plays through. */
  private bus(id: string): AudioNode {
    return this.cats.get(categoryOf(id)) ?? (id.startsWith('amb_') ? this.ambBus : this.sfxBus);
  }

  /** Set one category's level (0…1.5) of the sound mix; remembered. */
  setMix(cat: SoundCategory, v: number): void {
    this.mix[cat] = Math.max(0, Math.min(1.5, v));
    const g = this.cats.get(cat);
    if (g && this.ctx) g.gain.setTargetAtTime(this.mix[cat], this.ctx.currentTime, 0.05);
    try { localStorage.setItem(MIX_KEY, JSON.stringify(this.mix)); } catch { /* storage unavailable */ }
  }

  private get gain(): number { return this.muted ? 0 : this.volume; }

  setVolume(v: number): void {
    this.volume = v;
    if (v > 0) this.muted = false;
    this.apply();
  }

  /** A live copy of everything the game plays, as heard (for the clip recorder); null before
   *  the first sound. Hand it back to `untap` when done. */
  tap(): MediaStreamAudioDestinationNode | null {
    if (!this.ctx || !this.out) return null;
    const d = this.ctx.createMediaStreamDestination();
    this.out.connect(d);
    return d;
  }

  untap(d: MediaStreamAudioDestinationNode): void {
    try { this.out?.disconnect(d); } catch { /* already gone */ }
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

/** The synthesized UI tones (Audio.chime). */
export type ChimeKind = 'core' | 'karma' | 'buy' | 'deny' | 'story' | 'radio';
const CHIME_KINDS: ChimeKind[] = ['core', 'karma', 'buy', 'deny', 'story', 'radio'];
const CHIME_TEXT: Record<ChimeKind, string> = {
  core: 'power core picked up', karma: 'karma earned', buy: 'a power bought', deny: 'action refused',
  story: 'an important tracker line', radio: 'police radio squelch',
};
/** How long a looping or long sound plays when previewed (s). */
const PREVIEW_S = 3.5;

/** Seconds a decoded clip may go unwanted before it is dropped (Audio.dropIdle). */
const IDLE_S = 90;
const VOL_KEY = 'scale.volume', MUTE_KEY = 'scale.muted', MIX_KEY = 'scale.soundMix', MUSIC_KEY = 'scale.music', OFF_KEY = 'scale.soundsOff';

/** The stored master volume, mute, music switch and music level (the start screen's music reads them before the game's Audio exists). */
export function storedMusicLevel(): number {
  if (new URLSearchParams(location.search).has('mute') || readNum(MUTE_KEY, 0) > 0 || readNum(MUSIC_KEY, 1) <= 0) return 0;
  return readNum(VOL_KEY, 0.8) * readMix().music;
}

function readMix(): Record<SoundCategory, number> {
  const mix = Object.fromEntries(SOUND_CATEGORIES.map((c) => [c.id, defaultMix(c.id)])) as Record<SoundCategory, number>;
  try {
    const o = JSON.parse(localStorage.getItem(MIX_KEY) ?? '{}') as Record<string, unknown>;
    for (const c of SOUND_CATEGORIES) { const v = Number(o[c.id]); if (Number.isFinite(v)) mix[c.id] = Math.max(0, Math.min(1.5, v)); }
  } catch { /* storage unavailable */ }
  return mix;
}
function readOff(): Set<string> {
  try {
    const a = JSON.parse(localStorage.getItem(OFF_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []);
  } catch { return new Set(); }
}
function readNum(key: string, def: number): number {
  try { const v = localStorage.getItem(key); return v === null || isNaN(Number(v)) ? def : Number(v); } catch { return def; }
}
