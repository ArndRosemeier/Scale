/**
 * Sound log (Shift+F7, off by default): a small box listing the sounds started in the last
 * 20 seconds, newest on top, with how far away each one was and its volume category. For
 * finding out what a sound you just heard was.
 */
import { categoryOf, SOUND_CATEGORIES, type Audio } from '../audio/Audio';

const WINDOW_S = 20;
const ROWS = 14;

export class SoundLog {
  private el: HTMLDivElement | null = null;
  private on = false;
  private timer = 0;

  constructor(private audio: Audio) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F7' && e.shiftKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopImmediatePropagation(); this.toggle(); }
    }, true);
  }

  toggle(on = !this.on): void {
    this.on = on;
    if (on && !this.el) {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:8px;bottom:120px;z-index:9000;pointer-events:none;'
        + 'font:12px/1.35 ui-monospace,Consolas,monospace;color:#e8f0ff;background:rgba(10,14,22,0.72);padding:4px 10px;border-radius:4px;white-space:pre';
      document.body.appendChild(el);
      this.el = el;
    }
    if (this.el) this.el.style.display = on ? '' : 'none';
    clearInterval(this.timer);
    if (on) { this.draw(); this.timer = window.setInterval(() => this.draw(), 250); }
  }

  private draw(): void {
    if (!this.el) return;
    const now = performance.now() / 1000;
    const rows = this.audio.recent.filter((n) => now - n.t < WINDOW_S).slice(-ROWS).reverse();
    const cat = (id: string) => SOUND_CATEGORIES.find((c) => c.id === (id.startsWith('chime_') ? 'ui' : categoryOf(id)))?.name ?? '';
    const lines = rows.map((n) => {
      const ago = `${(now - n.t).toFixed(1)} s`.padStart(7);
      const where = n.d < 0 ? 'here' : `${Math.round(n.d)} m`;
      return `${ago}  ${n.id.padEnd(20)} ${where.padStart(6)}  ${cat(n.id)}`;
    });
    this.el.textContent = `Sounds, last ${WINDOW_S} s (Shift+F7 hides)\n` + (lines.length ? lines.join('\n') : '(none)');
  }
}
