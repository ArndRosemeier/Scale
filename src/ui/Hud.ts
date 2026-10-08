/** Minimal on-screen info: fps, time of day, position, streaming stats. */
import type { Game } from '../game/Game';
import { WEATHER_ICON } from '../render/Weather';

export class Hud {
  private el: HTMLDivElement;
  private acc = 0;
  private frames = 0;
  private fps = 0;

  private detail = false;

  constructor(private game: Game) {
    this.el = document.createElement('div');
    this.el.id = 'hud';
    document.body.appendChild(this.el);
    window.addEventListener('keydown', (e) => { if (e.code === 'F4') { this.detail = !this.detail; e.preventDefault(); } });
  }

  update(dt: number): void {
    this.acc += dt;
    this.frames++;
    if (this.acc < 0.5) return;
    this.fps = this.frames / this.acc;
    this.acc = 0;
    this.frames = 0;
    const g = this.game;
    const p = g.renderer.camera.position;
    const h = g.sky.hour;
    const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
    const info = g.renderer.gl.info;
    const pl = g.player;
    const size = pl ? (pl.height < 1 ? `${(pl.height * 100).toFixed(0)} cm` : `${pl.height.toFixed(pl.height < 10 ? 2 : 1)} m`) : '';
    const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][g.sky.day % 7];
    if (!this.detail) {
      // The time speed only when it is not real time (stopped / faster), so it is never a surprise.
      const ts = g.sky.timeScale, speed = ts === 1 ? '' : ts === 0 ? ' (stopped)' : ` (${ts}×)`;
      // The weather as a small glyph after the time.
      const wk = g.weather?.kind;
      const wx = wk ? ` ${WEATHER_ICON[wk]}` : '';
      this.el.textContent = `${day} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}${wx}${speed} · ${size}${pl?.flying ? ' · flying' : ''} · ${this.fps.toFixed(0)} fps`;
      return;
    }
    this.el.textContent =
      `${this.fps.toFixed(0)} fps · ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} · ` +
      `${p.x.toFixed(0)}, ${p.y.toFixed(1)}, ${p.z.toFixed(0)} · cells ${g.streamer.cells.size} · jobs ${g.pool.queued}/${g.pool.inFlight} · ` +
      `peds ${g.peds?.agents.length ?? 0} (crowd ${g.crowd?.stats.crowd ?? 0}, rigs ${g.crowd?.stats.rigs ?? 0}) · debris ${g.debris?.activeCount ?? 0} · size ${g.player?.height.toFixed(2)} m${g.player?.flying ? ' ✈' : ''}`;
    void info;
  }
}
