/**
 * TrackPlayer: plays the score's pieces (tracks.ts) and crossfades between them.
 *
 *   deck (one piece) → deck gain (fade in / out) ┐
 *   live deck + fading decks ─────────────────────┴→ bus (level, pause duck) → lowpass (rain) → out
 *
 *  - A stream deck plays an MP3 once through an audio element (streamed: nothing is decoded up
 *    front, a 2½-minute piece costs no memory). Its end is reported (`ended`), so the owner can
 *    rest the music or move on.
 *  - A loop deck plays a bar-true Ogg cut from a decoded buffer, looped sample-exact for as long
 *    as the mood lasts. Buffers load lazily, two at a time, and are dropped after a while unused.
 *  - The track list (public/music/tracks.json) is fetched on first need.
 */
import { rainTint } from './mood';
import { parseTracks, type TrackInfo } from './tracks';

/** What the owner wants playing (id null: silence). */
export interface TrackWant {
  id: string | null;
  fadeIn: number;
  fadeOut: number;
  level: number;
  /** Seconds into the piece to start at (a cue joining a scene late). */
  offset?: number;
}

interface Deck {
  id: string;
  info: TrackInfo;
  out: GainNode;
  el: HTMLAudioElement | null;
  node: MediaElementAudioSourceNode | null;
  src: AudioBufferSourceNode | null;
  state: 'waiting' | 'live' | 'fading';
  fadeIn: number;
  level: number;
  offset: number;
  fadeEnd: number;
  ended: boolean;
  /** play() was refused (no gesture yet): try again later. */
  retryAt: number;
}

interface BufEntry { state: 'idle' | 'loading' | 'ready' | 'error'; buffer: AudioBuffer | null; lastUse: number; tries: number; retryAt: number }

const MAX_PARALLEL = 2;
/** Drop a decoded loop nobody used for this long (s). */
const EVICT_AFTER = 120;

export class TrackPlayer {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private lp: BiquadFilterNode | null = null;
  private tracks: Record<string, TrackInfo> | null = null;
  private listState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  private decks: Deck[] = [];
  private bufs = new Map<string, BufEntry>();
  /** Audio elements made ahead of need (a cue that must start at once). */
  private spare = new Map<string, HTMLAudioElement>();
  private loadingN = 0;
  private evictT = 0;
  /** A loop that does not decode (no Ogg in this browser): loops stay silent, streams still play. */
  loopsBroken = false;
  /** Bus level (1 = as mastered). */
  level = 1;

  constructor(private base: string) {}

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

  /** The piece playing now (not fading), or null. */
  get current(): string | null { return this.live()?.id ?? null; }

  /** Has the live piece played to its end (a stream; loops never end)? */
  ended(id: string): boolean {
    const d = this.live();
    return !!d && d.id === id && d.ended;
  }

  /** Per frame: what to play, and the surroundings (`duck` < 1 lowers the music: pause menu). */
  update(dt: number, want: TrackWant, env: { duck: number; rain: number }): void {
    const ctx = this.ctx;
    if (!ctx || !this.bus || !this.lp) return;
    const now = ctx.currentTime;
    if (want.id && this.listState === 'idle') this.loadList();
    let id = want.id;
    if (id && (!this.tracks || !this.tracks[id])) id = null;
    if (id && this.tracks![id].kind === 'loop' && this.loopsBroken) id = null;
    this.bus.gain.setTargetAtTime(this.level * env.duck, now, 0.4);
    this.lp.frequency.setTargetAtTime(rainTint(env.rain).lowpass, now, 1.5);

    const live = this.live();
    if ((live?.id ?? null) !== id) {
      if (live) this.fade(live, want.fadeOut);
      if (id) this.decks.push(this.newDeck(id, want));
    } else if (live && Math.abs(live.level - want.level) > 1e-3) {
      live.level = want.level;
      if (live.state === 'live') live.out.gain.setTargetAtTime(want.level, now, 1);
    }
    for (const d of this.decks) this.step(d, now);
    for (let i = this.decks.length - 1; i >= 0; i--) {
      const d = this.decks[i];
      if (d.state === 'fading' && now > d.fadeEnd) { this.stopDeck(d); this.decks.splice(i, 1); }
    }
    this.pump();
    this.evictT += dt;
    if (this.evictT > 10) { this.evictT = 0; this.evict(); }
  }

  /** Get a piece ready to start at once (a loop decoded, a stream buffering). */
  prepare(id: string): void {
    const info = this.tracks?.[id];
    if (!info || !this.ctx) { if (this.listState === 'idle' && this.ctx) this.loadList(); return; }
    if (info.kind === 'loop') this.want(id);
    else if (!this.spare.has(id) && !this.decks.some((d) => d.id === id)) this.spare.set(id, this.element(info));
  }

  // ---------------------------------------------------------------- decks

  private live(): Deck | null {
    for (let i = this.decks.length - 1; i >= 0; i--) if (this.decks[i].state !== 'fading') return this.decks[i];
    return null;
  }

  private element(info: TrackInfo): HTMLAudioElement {
    const el = new Audio();
    el.preload = 'auto';
    el.src = `${this.base}music/${info.file}`;
    return el;
  }

  private newDeck(id: string, want: TrackWant): Deck {
    const ctx = this.ctx!;
    const info = this.tracks![id];
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.bus!);
    const d: Deck = {
      id, info, out, el: null, node: null, src: null, state: 'waiting', fadeIn: want.fadeIn, level: want.level,
      offset: want.offset ?? 0, fadeEnd: 0, ended: false, retryAt: 0,
    };
    if (info.kind === 'stream') {
      const el = this.spare.get(id) ?? this.element(info);
      this.spare.delete(id);
      d.el = el;
      d.node = ctx.createMediaElementSource(el);
      d.node.connect(out);
      el.onended = () => { d.ended = true; };
    } else this.want(id);
    return d;
  }

  private step(d: Deck, now: number): void {
    if (d.state === 'fading') {
      if (d.src) this.touch(d.id, now);
      return;
    }
    if (d.state === 'waiting') {
      if (d.el) {
        if (now < d.retryAt || d.el.readyState < 3) return;
        if (d.offset > 0) d.el.currentTime = Math.min(d.offset, d.info.seconds - 0.5);
        d.retryAt = now + 1e9;
        d.el.play().then(() => { if (d.state === 'waiting') this.goLive(d); }).catch(() => { d.retryAt = (this.ctx?.currentTime ?? 0) + 1; });
        return;
      }
      const e = this.bufs.get(d.id);
      if (e?.state !== 'ready' || !e.buffer) return;
      const src = this.ctx!.createBufferSource();
      src.buffer = e.buffer;
      src.loop = true;
      src.loopStart = 0;
      src.loopEnd = Math.min(e.buffer.duration, d.info.seconds);
      src.connect(d.out);
      src.start(now + 0.03, d.offset % src.loopEnd);
      d.src = src;
      this.goLive(d);
    }
    if (d.src) this.touch(d.id, now);
  }

  private goLive(d: Deck): void {
    const now = this.ctx!.currentTime;
    d.state = 'live';
    d.out.gain.cancelScheduledValues(now);
    d.out.gain.setValueAtTime(d.out.gain.value, now);
    if (d.fadeIn <= 0.1) d.out.gain.setValueAtTime(d.level, now);
    else d.out.gain.setTargetAtTime(d.level, now, d.fadeIn / 3);
  }

  private fade(d: Deck, secs: number): void {
    const now = this.ctx!.currentTime;
    d.state = 'fading';
    secs = Math.max(0.1, secs);
    d.fadeEnd = now + secs * 1.6 + 0.2;
    d.out.gain.cancelScheduledValues(now);
    d.out.gain.setValueAtTime(d.out.gain.value, now);
    d.out.gain.setTargetAtTime(0, now, secs / 3);
  }

  private stopDeck(d: Deck): void {
    try { d.src?.stop(); } catch { /* not started */ }
    d.src?.disconnect();
    if (d.el) {
      d.el.onended = null;
      d.el.pause();
      d.el.removeAttribute('src');
      d.el.load();
    }
    d.node?.disconnect();
    d.out.disconnect();
  }

  // ---------------------------------------------------------------- loading

  private loadList(): void {
    this.listState = 'loading';
    fetch(`${this.base}music/tracks.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((o) => {
        this.tracks = parseTracks(o);
        this.listState = this.tracks ? 'ready' : 'error';
        if (!this.tracks) console.warn('[music] no track list');
      })
      .catch(() => { this.listState = 'error'; });
  }

  private want(id: string): void {
    const now = this.ctx?.currentTime ?? 0;
    const e = this.bufs.get(id);
    if (e) { e.lastUse = now; return; }
    this.bufs.set(id, { state: 'idle', buffer: null, lastUse: now, tries: 0, retryAt: 0 });
  }

  private touch(id: string, now: number): void {
    const e = this.bufs.get(id);
    if (e) e.lastUse = now;
  }

  private pump(): void {
    if (!this.ctx || this.loopsBroken || !this.tracks) return;
    const now = this.ctx.currentTime;
    while (this.loadingN < MAX_PARALLEL) {
      let next: [string, BufEntry] | null = null;
      for (const kv of this.bufs) {
        const e = kv[1];
        const due = e.state === 'idle' || (e.state === 'error' && e.tries < 3 && now >= e.retryAt);
        if (due && now - e.lastUse < 60 && (!next || e.lastUse > next[1].lastUse)) next = kv;
      }
      if (!next) return;
      this.load(next[0], next[1]);
    }
  }

  private load(id: string, e: BufEntry): void {
    const ctx = this.ctx!;
    const info = this.tracks![id];
    e.state = 'loading';
    e.tries++;
    this.loadingN++;
    let fetched = false;
    fetch(`${this.base}music/${info.file}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .then((ab) => { fetched = true; return ctx.decodeAudioData(ab); })
      .then((buf) => { e.buffer = buf; e.state = 'ready'; e.lastUse = ctx.currentTime; })
      .catch((err) => {
        e.state = 'error';
        e.retryAt = ctx.currentTime + 20;
        // Arrived but does not decode, and nothing ever did: no Ogg here.
        if (fetched && ![...this.bufs.values()].some((b) => b.state === 'ready')) {
          this.loopsBroken = true;
          console.warn('[music] cannot decode the looped music (Ogg) — danger music off', err);
        } else console.warn(`[music] ${id}:`, err);
      })
      .finally(() => { this.loadingN--; });
  }

  private evict(): void {
    const now = this.ctx!.currentTime;
    const used = new Set(this.decks.map((d) => d.id));
    for (const [id, e] of this.bufs) {
      if (e.state === 'ready' && !used.has(id) && now - e.lastUse > EVICT_AFTER) this.bufs.delete(id);
    }
  }

  // ---------------------------------------------------------------- debug / teardown

  status(): unknown {
    const now = this.ctx?.currentTime ?? 0;
    return {
      list: this.listState,
      loopsBroken: this.loopsBroken,
      decks: this.decks.map((d) => ({
        id: d.id, state: d.state, ended: d.ended, gain: +d.out.gain.value.toFixed(3),
        at: d.el ? +d.el.currentTime.toFixed(1) : d.src ? +((now % d.info.seconds)).toFixed(1) : -1,
      })),
      loops: [...this.bufs].map(([id, e]) => `${id}:${e.state}`),
      spare: [...this.spare.keys()],
      bus: +(this.bus?.gain.value ?? 0).toFixed(3),
      lowpass: Math.round(this.lp?.frequency.value ?? 0),
    };
  }

  /** Fade everything out (s). */
  stopAll(secs = 2): void {
    if (!this.ctx) return;
    for (const d of this.decks) if (d.state !== 'fading') this.fade(d, secs);
  }
}
