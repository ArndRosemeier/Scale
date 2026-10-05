/**
 * The screen layer of a defeat (game/defeat/Defeat): letterbox bars, a full-screen fade (black or
 * white), a title card, a caption line, a skip hint, and the game over screen (load a save, or a
 * new game). While the bars are up the game's own interface is faded out (body.dcine-on).
 */
import type { Game } from '../game/Game';
import { fillSaveList } from './SaveUi';
import { saveStore } from '../game/save/SaveStore';

const CSS = `
#dcine { position: fixed; inset: 0; z-index: 58; pointer-events: none; user-select: none; }
#dcine .dc-bar { position: absolute; left: 0; right: 0; height: 11vh; background: #000; transition: transform 1s cubic-bezier(.6,0,.3,1); }
#dcine .dc-bar.top { top: 0; transform: translateY(-100%); }
#dcine .dc-bar.bot { bottom: 0; transform: translateY(100%); }
#dcine.bars .dc-bar { transform: translateY(0); }
#dcine .dc-fade { position: absolute; inset: 0; background: #000; opacity: 0; }
#dcine .dc-tint { position: absolute; inset: 0; opacity: 0; transition: opacity 1.4s ease;
  background: radial-gradient(ellipse at center, rgba(120,0,0,0) 35%, rgba(110,0,0,.55) 100%); }
#dcine .dc-tint.on { opacity: 1; }
#dcine .dc-title { position: absolute; left: 0; right: 0; top: 36%; text-align: center; color: #eef6fb; opacity: 0; transition: opacity 1s ease;
  font: 600 clamp(22px, 3.6vh, 42px)/1.25 system-ui, sans-serif; letter-spacing: .08em; text-shadow: 0 0 24px rgba(0,0,0,.9); }
#dcine .dc-title small { display: block; margin-top: .55em; font-size: .42em; font-weight: 500; letter-spacing: .32em; text-transform: uppercase; color: #8fe9ff; }
#dcine .dc-title.red { color: #ffdede; }
#dcine .dc-title.red small { color: #ff9a9a; }
#dcine .dc-title.show { opacity: 1; }
#dcine .dc-cap { position: absolute; left: 8vw; right: 8vw; bottom: 0; height: 11vh; display: flex; align-items: center; justify-content: center; text-align: center;
  color: #e6eef3; font: 400 clamp(14px, 2vh, 22px)/1.4 system-ui, sans-serif; letter-spacing: .02em; opacity: 0; transition: opacity .7s ease; }
#dcine .dc-cap.show { opacity: 1; }
#dcine .dc-cap b { color: #8fe9ff; font-weight: 600; }
#dcine .dc-skip { position: absolute; right: 2.2vw; top: calc(11vh + 12px); color: #cfd8de; font: 500 13px/1 system-ui, sans-serif; opacity: 0; transition: opacity .4s ease; }
#dcine .dc-skip.show { opacity: .8; }
#dcine .dc-skip kbd { border: 1px solid rgba(255,255,255,.4); border-radius: 4px; padding: 1px 6px; margin-right: 6px; font: inherit; }
body.dcine-on > :not(#view):not(#dcine):not(#dover) { opacity: 0 !important; pointer-events: none !important; transition: opacity .8s ease; }
#dover { position: fixed; inset: 0; z-index: 70; display: flex; align-items: center; justify-content: center; pointer-events: auto;
  background: radial-gradient(ellipse at center, rgba(40,4,6,.93), rgba(4,2,3,.98)); opacity: 0; transition: opacity 1.6s ease; }
#dover.show { opacity: 1; }
#dover .do-box { width: min(560px, 92vw); max-height: 88vh; overflow: auto; text-align: center; color: #f1e6e6; font: 400 15px/1.5 system-ui, sans-serif; }
#dover h1 { margin: 0 0 .2em; font: 700 clamp(38px, 7vh, 72px)/1.05 system-ui, sans-serif; letter-spacing: .14em; color: #ff5d5d; text-shadow: 0 0 30px rgba(255,40,40,.35); }
#dover .do-sub { color: #d9b9b9; margin-bottom: 1.6em; }
#dover .do-acts { display: flex; flex-direction: column; gap: 10px; align-items: stretch; margin: 0 auto; width: min(360px, 100%); }
#dover button.do-btn { padding: 12px 16px; border-radius: 8px; border: 1px solid rgba(255,255,255,.18); background: rgba(255,255,255,.06); color: #f6eeee;
  font: 600 15px/1.2 system-ui, sans-serif; cursor: pointer; }
#dover button.do-btn:hover { background: rgba(255,255,255,.14); }
#dover button.do-btn.main { background: #a52626; border-color: #d14a4a; }
#dover button.do-btn.main:hover { background: #bf3131; }
#dover .sv-list { margin-top: 14px; text-align: left; }
`;

export class DefeatUi {
  private root = document.createElement('div');
  private fadeEl = document.createElement('div');
  private tint = document.createElement('div');
  private title = document.createElement('div');
  private cap = document.createElement('div');
  private skip = document.createElement('div');
  private over: HTMLDivElement | null = null;
  private capText = '';
  private lastFade = '';

  constructor(private g: Game) {
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    this.root.id = 'dcine';
    const top = document.createElement('div'); top.className = 'dc-bar top';
    const bot = document.createElement('div'); bot.className = 'dc-bar bot';
    this.fadeEl.className = 'dc-fade';
    this.tint.className = 'dc-tint';
    this.title.className = 'dc-title';
    this.cap.className = 'dc-cap';
    this.skip.className = 'dc-skip';
    this.skip.innerHTML = '<kbd>Space</kbd>skip';
    this.root.append(this.tint, top, bot, this.fadeEl, this.title, this.cap, this.skip);
    document.body.appendChild(this.root);
  }

  /** Letterbox bars and the game's interface hidden (true), or back (false). */
  cinema(on: boolean): void {
    this.root.classList.toggle('bars', on);
    document.body.classList.toggle('dcine-on', on);
  }

  /** The red edge of being down. */
  hurt(on: boolean): void { this.tint.classList.toggle('on', on); }

  /** Full-screen fade: 0 clear … 1 covered; black (white = 0) to cool white (1). */
  fade(a: number, white = 0): void {
    const o = (Math.round(Math.max(0, Math.min(1, a)) * 1000) / 1000).toString();
    const w = Math.max(0, Math.min(1, white));
    const key = `${o}|${w.toFixed(2)}`;
    if (key === this.lastFade) return;
    this.lastFade = key;
    this.fadeEl.style.opacity = o;
    this.fadeEl.style.background = `rgb(${Math.round(235 * w)}, ${Math.round(250 * w)}, ${Math.round(255 * w)})`;
  }

  titleCard(html: string, red = false): void {
    if (html) { this.title.innerHTML = html; this.title.classList.toggle('red', red); }
    this.title.classList.toggle('show', !!html);
  }

  caption(html: string): void {
    if (html === this.capText) return;
    this.capText = html;
    this.cap.classList.remove('show');
    if (!html) return;
    window.setTimeout(() => { if (this.capText === html) { this.cap.innerHTML = `<span>${html}</span>`; this.cap.classList.add('show'); } }, this.cap.innerHTML ? 350 : 0);
  }

  skippable(on: boolean): void { this.skip.classList.toggle('show', on); }

  /** Everything off (the defeat is over). */
  clear(): void {
    this.cinema(false);
    this.hurt(false);
    this.fade(0);
    this.titleCard('');
    this.caption('');
    this.skippable(false);
  }

  /** The game over screen: load a save (the newest at the top), or start a new game. */
  gameOver(reason: string): void {
    if (this.over) return;
    try { document.exitPointerLock(); } catch { /* not locked */ }
    const o = document.createElement('div');
    o.id = 'dover';
    o.innerHTML = `<div class="do-box"><h1>GAME OVER</h1><div class="do-sub">${reason}</div>
      <div class="do-acts"><button type="button" class="do-btn main do-latest" hidden>Load the latest save</button>
      <button type="button" class="do-btn do-load">Load a save…</button><button type="button" class="do-btn do-new">New game</button></div>
      <div class="sv-list" hidden></div></div>`;
    // Keys must not reach the game behind it (Esc would open the pause menu).
    o.addEventListener('keydown', (e) => e.stopPropagation());
    document.body.appendChild(o);
    this.over = o;
    requestAnimationFrame(() => o.classList.add('show'));
    const $ = <T extends Element>(s: string) => o.querySelector(s) as T;
    const list = $<HTMLDivElement>('.sv-list');
    const latest = $<HTMLButtonElement>('.do-latest');
    void saveStore.list().then((l) => {
      const m = l[0];
      if (!m) return;
      latest.hidden = false;
      latest.onclick = () => { latest.disabled = true; latest.textContent = 'Loading…'; void this.g.saves.load(m.id); };
    }).catch(() => undefined);
    $<HTMLButtonElement>('.do-load').onclick = () => {
      list.hidden = !list.hidden;
      if (!list.hidden) void fillSaveList(list, (m) => { void this.g.saves.load(m.id); });
    };
    $<HTMLButtonElement>('.do-new').onclick = () => { location.href = location.pathname; };
  }

  get gameOverShown(): boolean { return !!this.over; }
}
