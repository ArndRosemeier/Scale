/**
 * The start screen's theme ("Dusk Awakening", public/music/title): starts after the first click
 * or key on the menu (browsers block audio before a gesture), loops, plays on through the
 * loading screen and fades out when the game begins (the game's own music takes over later).
 * Streamed from an audio element, so nothing is downloaded before it plays and the page loads
 * no slower. Respects the stored volume, mute, music switch and music level, and `?mute` (tests).
 */
import { storedMusicLevel } from '../Audio';

const BASE = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
const TRACK = `${BASE}music/title/dusk-awakening.mp3`;
/** The theme is mastered louder than the in-game stems; this sits it at the old menu level. */
const MENU_LEVEL = 0.34;
/** Seconds to fade in. */
const FADE_IN = 2.5;
/** Events that may start audio (iPad Safari: only a touch's end, not its start). */
const GESTURES = ['pointerdown', 'pointerup', 'touchend', 'keydown'];

export class MenuMusic {
  private ctx: AudioContext | null = null;
  private audio: HTMLAudioElement | null = null;
  private out: GainNode | null = null;
  private stopped = false;
  private readonly onGesture = () => this.begin();

  constructor() {
    if (storedMusicLevel() <= 0) return;
    for (const ev of GESTURES) window.addEventListener(ev, this.onGesture, { passive: true });
  }

  private begin(): void {
    // A context made on a touch's start stays suspended on iPad Safari: resume it (and the
    // track) on the next gesture (the touch's end counts there) and stop listening once it plays.
    if (this.ctx) {
      if (this.ctx.state === 'running' && !this.audio?.paused) this.unlisten();
      else {
        void this.ctx.resume().then(() => this.audio?.play()).then(() => { if (this.ctx?.state === 'running') this.unlisten(); }).catch(() => {});
      }
      return;
    }
    if (this.stopped) { this.unlisten(); return; }
    const level = storedMusicLevel();
    if (level <= 0) return;
    try { this.ctx = new AudioContext(); } catch { this.unlisten(); return; }
    const audio = new Audio();
    audio.src = TRACK;
    audio.loop = true;
    audio.preload = 'auto';
    this.audio = audio;
    const out = this.ctx.createGain();
    const t = this.ctx.currentTime;
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(level * MENU_LEVEL, t + FADE_IN);
    this.ctx.createMediaElementSource(audio).connect(out).connect(this.ctx.destination);
    this.out = out;
    void audio.play().then(() => { if (this.ctx?.state === 'running') this.unlisten(); }).catch(() => { /* next gesture */ });
  }

  private unlisten(): void {
    for (const ev of GESTURES) window.removeEventListener(ev, this.onGesture);
  }

  /** Fade out over `secs` and release the audio context. */
  stop(secs = 4): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unlisten();
    const ctx = this.ctx, out = this.out, audio = this.audio;
    if (!ctx || !out) return;
    const t = ctx.currentTime;
    out.gain.cancelScheduledValues(t);
    out.gain.setValueAtTime(Math.max(out.gain.value, 0.0001), t);
    out.gain.exponentialRampToValueAtTime(0.0001, t + secs);
    window.setTimeout(() => {
      audio?.pause();
      if (audio) audio.src = '';
      void ctx.close().catch(() => {});
    }, secs * 1000 + 300);
  }

  /** Debug. */
  status(): unknown {
    return { running: !!this.ctx, stopped: this.stopped, state: this.ctx?.state, time: this.audio?.currentTime, paused: this.audio?.paused, gain: this.out?.gain.value };
  }
}
