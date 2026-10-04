/**
 * The start screen's theme: plays quietly after the first click or key on the menu
 * (browsers block audio before a gesture), through the loading screen, and fades out
 * when the game begins (the game's own music takes over later, sparsely).
 * Respects the stored volume, mute, music switch and music level, and `?mute` (tests).
 */
import { storedMusicLevel } from '../Audio';
import { StemPlayer } from './StemPlayer';

const BASE = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
/** The menu theme sits lower than in-game music. */
const MENU_LEVEL = 0.55;

export class MenuMusic {
  private ctx: AudioContext | null = null;
  private player = new StemPlayer(BASE);
  private timer = 0;
  private last = 0;
  private stopped = false;
  private readonly onGesture = () => this.begin();

  constructor() {
    if (storedMusicLevel() <= 0) return;
    window.addEventListener('pointerdown', this.onGesture);
    window.addEventListener('keydown', this.onGesture);
  }

  private begin(): void {
    window.removeEventListener('pointerdown', this.onGesture);
    window.removeEventListener('keydown', this.onGesture);
    if (this.ctx || this.stopped) return;
    const level = storedMusicLevel();
    if (level <= 0) return;
    try { this.ctx = new AudioContext(); } catch { return; }
    const out = this.ctx.createGain();
    out.gain.value = level * MENU_LEVEL;
    out.connect(this.ctx.destination);
    this.player.attach(this.ctx, out);
    this.last = performance.now();
    this.timer = window.setInterval(() => {
      const now = performance.now(), dt = (now - this.last) / 1000;
      this.last = now;
      this.player.update(dt, this.stopped ? null : 'menu', 0.5, { duck: 1, rain: 0 });
    }, 200);
  }

  /** Fade out over `secs` and release the audio context. */
  stop(secs = 4): void {
    if (this.stopped) return;
    this.stopped = true;
    window.removeEventListener('pointerdown', this.onGesture);
    window.removeEventListener('keydown', this.onGesture);
    if (!this.ctx) return;
    this.player.stopAll(secs);
    const ctx = this.ctx;
    window.setTimeout(() => {
      window.clearInterval(this.timer);
      void ctx.close().catch(() => {});
    }, secs * 1000 * 1.8 + 500);
  }

  /** Debug. */
  status(): unknown { return { running: !!this.ctx, stopped: this.stopped, ...this.player.status() }; }
}
