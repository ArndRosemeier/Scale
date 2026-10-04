/**
 * StemPlayer: plays Scale's background-music stem sets (public/music, built by
 * tools/music/build_stems.py; adapted from Norgo's stem score).
 *
 *   layer source (looped buffer) → layer gain ┐
 *   drone / texture / melody / perc           ┴→ slot gain (crossfade) ┐
 *   live slot + fading slots ─────────────────────────────────────────┴→ bus (level, pause duck) → lowpass (rain) → out
 *
 *  - The manifest is fetched on first need; stems are fetched + decoded lazily (only the
 *    chosen variation of each layer, the drone first), so nothing loads before music is due.
 *    Unused buffers are dropped after a while (decoded stems are ~14 MB each).
 *  - All layers of a slot share one timeline (t0): late-loading layers join phase-aligned.
 *    Buffers carry a short wrapped margin (manifest `lead`); they loop between lead and
 *    lead + loopSeconds, so the seams stay clean.
 *  - Per loop: the perc may sit out (chance per mood), the texture may rest a loop, the
 *    melody plays phrases of 1–3 loops with long gaps (a new variation each time when
 *    one is loaded).
 *  - If the browser cannot decode Ogg Opus, the music stays off for the session.
 */
import { MOOD_MIX, rainTint, nextLikely, type Mood, type LayerMix } from './mood';

export type StemLayer = 'drone' | 'texture' | 'melody' | 'perc';
export const STEM_LAYERS: StemLayer[] = ['drone', 'texture', 'melody', 'perc'];

export interface StemSetInfo {
  id: string;
  bpm: number;
  beatsPerBar: number;
  bars: number;
  loopSeconds: number;
  layers: Partial<Record<StemLayer, string[]>>;
}
export interface StemManifest { lead: number; sets: Record<string, StemSetInfo> }

/** Parse the manifest (null when malformed). */
export function parseStemManifest(o: unknown): StemManifest | null {
  if (!o || typeof o !== 'object') return null;
  const m = o as { lead?: unknown; sets?: Record<string, Record<string, unknown>> };
  if (!m.sets || typeof m.sets !== 'object') return null;
  const sets: Record<string, StemSetInfo> = {};
  for (const [id, s] of Object.entries(m.sets)) {
    const loop = Number(s.loopSeconds), bpm = Number(s.bpm);
    const layers = (s.layers ?? {}) as Partial<Record<StemLayer, string[]>>;
    if (!(loop > 1) || !(bpm > 0) || !Array.isArray(layers.drone) || !layers.drone.length) continue;
    sets[id] = { id, bpm, beatsPerBar: Number(s.beatsPerBar) || 4, bars: Number(s.bars) || 8, loopSeconds: loop, layers };
  }
  return { lead: Number(m.lead) || 0, sets };
}

interface BufEntry {
  path: string;
  state: 'idle' | 'loading' | 'ready' | 'error';
  buffer: AudioBuffer | null;
  lastUse: number;
  prio: number;
  tries: number;
  retryAt: number;
}

interface LayerState {
  gain: GainNode;
  src: AudioBufferSourceNode | null;
  path: string | null;
  /** Target level (0 … 1, before the mood mix). */
  on: number;
}

interface Slot {
  mood: Mood;
  set: StemSetInfo;
  mix: LayerMix;
  out: GainNode;
  layers: Record<StemLayer, LayerState>;
  /** Context time of loop position 0; -1 until the drone is ready. */
  t0: number;
  state: 'waiting' | 'live' | 'fading';
  fadeEnd: number;
  loopIdx: number;
  phraseIdx: number;
  melOn: boolean;
  melPhrasesLeft: number;
  melNextAt: number;
  percGate: boolean;
  texOn: boolean;
  /** Variation choices per layer. */
  pick: Record<StemLayer, string | null>;
  born: number;
}

export interface StemStatus {
  ready: boolean;
  broken: boolean;
  mood: Mood | null;
  slots: { mood: Mood; state: string; loop: number; layers: Record<string, { path: string | null; gain: number; playing: boolean }> }[];
  loaded: string[];
  loading: string[];
  bus: number;
  lowpass: number;
}

const MAX_PARALLEL = 2;
/** Drop a decoded buffer nobody used for this long (s). */
const EVICT_AFTER = 120;

export class StemPlayer {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private lp: BiquadFilterNode | null = null;
  private manifest: StemManifest | null = null;
  private manifestState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  private bufs = new Map<string, BufEntry>();
  private loadingN = 0;
  private slots: Slot[] = [];
  private mood: Mood | null = null;
  /** Decoding failed for good (no Ogg Opus in this browser): stay silent. */
  broken = false;
  private evictT = 0;
  /** Bus level (1 = as mixed), set by the owner (e.g. the start screen plays lower). */
  level = 1;

  constructor(private base: string, private rng: () => number = Math.random) {}

  /** Connect to an audio graph (once the context exists). */
  attach(ctx: AudioContext, out: AudioNode): void {
    if (this.ctx) return;
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 18000;
    this.lp.Q.value = 0.5;
    this.bus.connect(this.lp).connect(out);
  }

  get attached(): boolean { return !!this.ctx; }

  /**
   * Per frame: the mood to play (null = silence), its intensity, and the surroundings.
   * `duck` < 1 lowers the music (pause menu).
   */
  update(dt: number, mood: Mood | null, intensity: number, env: { duck: number; rain: number }): void {
    const ctx = this.ctx;
    if (!ctx || !this.bus || !this.lp) return;
    const now = ctx.currentTime;
    if (mood && this.manifestState === 'idle') this.loadManifest();
    if (this.broken || !this.manifest) mood = null;
    if (mood && !this.manifest?.sets[mood]) mood = null;
    this.bus.gain.setTargetAtTime(this.level * env.duck, now, 0.4);
    const tint = rainTint(env.rain);
    this.lp.frequency.setTargetAtTime(tint.lowpass, now, 1.5);

    // ---- mood changes: a new live slot, the old one fades
    if (mood !== this.mood) {
      const prev = this.liveSlot();
      if (prev) this.fade(prev, mood ? Math.min(prev.mix.fadeOut, MOOD_MIX[mood].fadeIn * 1.5) : prev.mix.fadeOut);
      // A waiting slot that never started just goes.
      this.mood = mood;
      if (mood && this.manifest) this.slots.push(this.newSlot(mood, this.manifest.sets[mood]));
      for (const m of nextLikely(mood)) this.preload(m);
    }

    for (const s of this.slots) this.step(s, now, intensity, tint.perc);
    // Done fading: stop the sources.
    for (let i = this.slots.length - 1; i >= 0; i--) {
      const s = this.slots[i];
      if ((s.state === 'fading' && now > s.fadeEnd) || (s.state === 'waiting' && s.mood !== this.mood)) {
        this.stopSlot(s);
        this.slots.splice(i, 1);
      }
    }
    this.pump();
    this.evictT += dt;
    if (this.evictT > 10) { this.evictT = 0; this.evict(); }
  }

  /** Fetch a set's first stems ahead of need. */
  preload(mood: Mood): void {
    const set = this.manifest?.sets[mood];
    if (!set || this.broken) return;
    for (const l of ['drone', 'texture', 'perc'] as StemLayer[]) {
      const p = set.layers[l]?.[0];
      if (p) this.want(p, 5);
    }
  }

  // ---------------------------------------------------------------- slots

  private liveSlot(): Slot | null {
    for (const s of this.slots) if (s.state !== 'fading') return s;
    return null;
  }

  private newSlot(mood: Mood, set: StemSetInfo): Slot {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.bus!);
    const layers = {} as Record<StemLayer, LayerState>;
    const pick = {} as Record<StemLayer, string | null>;
    for (const l of STEM_LAYERS) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(out);
      layers[l] = { gain: g, src: null, path: null, on: 0 };
      const v = set.layers[l];
      pick[l] = v?.length ? v[Math.floor(this.rng() * v.length)] : null;
    }
    const mix = MOOD_MIX[mood];
    const now = ctx.currentTime;
    const slot: Slot = {
      mood, set, mix, out, layers, t0: -1, state: 'waiting', fadeEnd: 0, loopIdx: -1, phraseIdx: -1,
      melOn: false, melPhrasesLeft: 0, melNextAt: now + this.between(mix.melFirst), percGate: false, texOn: true, pick, born: now,
    };
    // Load order: the bed first, then texture and perc, the melody last.
    const prio: Record<StemLayer, number> = { drone: 0, texture: 1, perc: 2, melody: 3 };
    for (const l of STEM_LAYERS) if (pick[l]) this.want(pick[l]!, prio[l]);
    return slot;
  }

  private fade(s: Slot, secs: number): void {
    const now = this.ctx!.currentTime;
    s.state = 'fading';
    s.fadeEnd = now + secs * 1.6 + 0.2;
    s.out.gain.cancelScheduledValues(now);
    s.out.gain.setValueAtTime(s.out.gain.value, now);
    s.out.gain.setTargetAtTime(0, now, secs / 3);
  }

  private stopSlot(s: Slot): void {
    for (const l of STEM_LAYERS) {
      const L = s.layers[l];
      try { L.src?.stop(); } catch { /* not started */ }
      L.src?.disconnect();
      L.gain.disconnect();
    }
    s.out.disconnect();
  }

  private step(s: Slot, now: number, intensity: number, rainPerc: number): void {
    if (s.state === 'fading') {
      this.touch(s);
      return;
    }
    const drone = this.ready(s.pick.drone);
    if (s.state === 'waiting') {
      if (!drone) return;
      s.t0 = now + 0.08;
      s.state = 'live';
      s.out.gain.setValueAtTime(0, now);
      s.out.gain.setTargetAtTime(s.mix.level, now, s.mix.fadeIn / 3);
    }
    const L = s.set.loopSeconds;
    const pos = now - s.t0;
    const idx = Math.max(0, Math.floor(pos / L));
    const danger = s.mood === 'tension' || s.mood === 'battle';
    if (idx !== s.loopIdx) {
      // ---- a new loop: roll the gates
      s.loopIdx = idx;
      const chance = danger ? Math.min(1, s.mix.percChance * (0.6 + intensity * 0.6)) : s.mix.percChance;
      s.percGate = idx === 0 && !danger ? false : this.rng() < chance;
      s.texOn = idx === 0 ? true : this.rng() >= s.mix.texRest;
    }
    // ---- melody phrases, on 4-bar boundaries: on for 1–3 loops' worth of phrases, then a long gap
    const phrase = Math.max(0, Math.floor(pos / (4 * s.set.beatsPerBar * 60 / s.set.bpm)));
    if (phrase !== s.phraseIdx) {
      s.phraseIdx = phrase;
      if (s.melOn) {
        if (--s.melPhrasesLeft <= 0) {
          s.melOn = false;
          s.melNextAt = now + this.between(s.mix.melOff);
          this.nextMelody(s);
        }
      } else if (now >= s.melNextAt && this.ready(s.pick.melody) && s.layers.melody.path === s.pick.melody) {
        s.melOn = true;
        s.melPhrasesLeft = Math.max(1, Math.round(this.between(s.mix.melLoops) * s.set.bars / 4));
      }
    }
    const I = danger ? 0.6 + 0.4 * intensity : 1;
    const target: Record<StemLayer, number> = {
      drone: s.mix.drone,
      texture: s.texOn ? s.mix.texture * (danger ? 0.75 + 0.25 * intensity : 1) : 0,
      melody: s.melOn ? s.mix.melody : 0,
      perc: s.percGate ? s.mix.perc * I * rainPerc : 0,
    };
    for (const l of STEM_LAYERS) {
      const st = s.layers[l];
      const path = s.pick[l];
      // Start (or swap in) the source phase-aligned once its buffer is ready.
      // (A new variation swaps in only while the layer is silent: the melody between phrases.)
      if (path && st.path !== path && this.ready(path) && (!st.src || st.gain.gain.value < 0.005)) this.startSource(s, l, path, now);
      const tc = l === 'melody' ? 1.2 : l === 'perc' ? 0.5 : 1.0;
      const v = st.src ? target[l] : 0;
      if (Math.abs(v - st.on) > 1e-3) {
        st.on = v;
        st.gain.gain.setTargetAtTime(v, now, tc);
      }
    }
    this.touch(s);
  }

  private startSource(s: Slot, l: StemLayer, path: string, now: number): void {
    const ctx = this.ctx!;
    const e = this.bufs.get(path)!;
    const st = s.layers[l];
    const lead = this.manifest!.lead;
    const L = s.set.loopSeconds;
    const when = Math.max(now + 0.03, s.t0);
    const off = lead + (((when - s.t0) % L) + L) % L;
    const src = ctx.createBufferSource();
    src.buffer = e.buffer;
    src.loop = true;
    src.loopStart = lead;
    src.loopEnd = Math.min(e.buffer!.duration, lead + L);
    src.connect(st.gain);
    src.start(when, off);
    if (st.src) {
      try { st.src.stop(when); } catch { /* already stopped */ }
      const old = st.src;
      old.onended = () => old.disconnect();
    }
    st.src = src;
    st.path = path;
  }

  /** Between phrases: choose the next melody variation (loading it when needed). */
  private nextMelody(s: Slot): void {
    const v = s.set.layers.melody;
    if (!v || v.length < 2) return;
    const other = v.filter((p) => p !== s.pick.melody);
    const p = other[Math.floor(this.rng() * other.length)];
    s.pick.melody = p;
    this.want(p, 4);
  }

  private touch(s: Slot): void {
    const t = this.ctx!.currentTime;
    for (const l of STEM_LAYERS) {
      const p = s.layers[l].path ?? s.pick[l];
      const e = p ? this.bufs.get(p) : undefined;
      if (e) e.lastUse = t;
    }
  }

  private between([a, b]: [number, number]): number { return a + (b - a) * this.rng(); }

  // ---------------------------------------------------------------- loading

  private loadManifest(): void {
    this.manifestState = 'loading';
    fetch(`${this.base}music/manifest.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((o) => {
        this.manifest = parseStemManifest(o);
        this.manifestState = this.manifest ? 'ready' : 'error';
        if (!this.manifest) console.warn('[music] no music manifest');
      })
      .catch(() => { this.manifestState = 'error'; });
  }

  private ready(path: string | null): boolean {
    return !!path && this.bufs.get(path)?.state === 'ready';
  }

  private want(path: string, prio: number): void {
    const e = this.bufs.get(path);
    if (e) {
      e.prio = Math.min(e.prio, prio);
      if (e.state === 'idle' || (e.state === 'error' && e.tries < 3)) e.lastUse = this.ctx?.currentTime ?? 0;
      return;
    }
    this.bufs.set(path, { path, state: 'idle', buffer: null, lastUse: this.ctx?.currentTime ?? 0, prio, tries: 0, retryAt: 0 });
  }

  private pump(): void {
    if (this.broken || !this.ctx) return;
    const now = this.ctx.currentTime;
    const used = this.usedPaths();
    while (this.loadingN < MAX_PARALLEL) {
      let best: BufEntry | null = null;
      for (const e of this.bufs.values()) {
        const due = e.state === 'idle' || (e.state === 'error' && e.tries < 3 && now >= e.retryAt);
        // Only load what a slot wants, or a recent preload.
        if (!due || (!used.has(e.path) && now - e.lastUse > 60)) continue;
        if (!best || e.prio < best.prio) best = e;
      }
      if (!best) return;
      this.load(best);
    }
  }

  private load(e: BufEntry): void {
    const ctx = this.ctx!;
    e.state = 'loading';
    e.tries++;
    this.loadingN++;
    let fetched = false;
    fetch(`${this.base}music/${e.path}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .then((ab) => { fetched = true; return ctx.decodeAudioData(ab); })
      .then((buf) => {
        e.buffer = buf;
        e.state = 'ready';
        e.lastUse = ctx.currentTime;
      })
      .catch((err) => {
        e.state = 'error';
        e.retryAt = ctx.currentTime + 20;
        // A file that arrived but does not decode: this browser has no Ogg Opus. Music off.
        if (fetched && ![...this.bufs.values()].some((b) => b.state === 'ready')) {
          this.broken = true;
          console.warn('[music] cannot decode the music (Ogg Opus) — music off', err);
        } else console.warn(`[music] ${e.path}:`, err);
      })
      .finally(() => { this.loadingN--; });
  }

  private usedPaths(): Set<string> {
    const u = new Set<string>();
    for (const s of this.slots) for (const l of STEM_LAYERS) {
      const p = s.pick[l], q = s.layers[l].path;
      if (p && s.state !== 'fading') u.add(p);
      if (q) u.add(q);
    }
    return u;
  }

  private evict(): void {
    const now = this.ctx!.currentTime;
    const used = this.usedPaths();
    for (const e of this.bufs.values()) {
      if (e.state === 'ready' && !used.has(e.path) && now - e.lastUse > EVICT_AFTER) {
        e.buffer = null;
        e.state = 'idle';
        e.tries = 0;
      }
    }
  }

  // ---------------------------------------------------------------- debug / teardown

  status(): StemStatus {
    const now = this.ctx?.currentTime ?? 0;
    return {
      ready: this.manifestState === 'ready',
      broken: this.broken,
      mood: this.mood,
      slots: this.slots.map((s) => ({
        mood: s.mood,
        state: s.state,
        loop: s.t0 < 0 ? -1 : Math.floor((now - s.t0) / s.set.loopSeconds),
        layers: Object.fromEntries(STEM_LAYERS.map((l) => [l, { path: s.layers[l].path, gain: +s.layers[l].gain.gain.value.toFixed(3), playing: !!s.layers[l].src }])),
      })),
      loaded: [...this.bufs.values()].filter((e) => e.state === 'ready').map((e) => e.path),
      loading: [...this.bufs.values()].filter((e) => e.state === 'loading').map((e) => e.path),
      bus: +(this.bus?.gain.value ?? 0).toFixed(3),
      lowpass: Math.round(this.lp?.frequency.value ?? 0),
    };
  }

  /** Fade everything out (s) and forget the slots. */
  stopAll(secs = 2): void {
    if (!this.ctx) return;
    for (const s of this.slots) if (s.state !== 'fading') this.fade(s, secs);
    this.mood = null;
  }
}
