/**
 * The cutscene's screen layer: letterbox bars, captions, a full-screen fade (black or white),
 * the skip prompt. While it is up the game's own interface is faded out (body.cine-on) and the
 * keyboard and mouse belong to the cutscene.
 */

const CSS = `
#cine { position: fixed; inset: 0; z-index: 60; pointer-events: auto; cursor: none; user-select: none; }
#cine .cine-bar { position: absolute; left: 0; right: 0; height: 12.5vh; background: #000; transition: transform 1.1s cubic-bezier(.6,0,.3,1); }
#cine .cine-bar.top { top: 0; transform: translateY(0); }
#cine .cine-bar.bot { bottom: 0; transform: translateY(0); }
#cine.open-bars .cine-bar.top { transform: translateY(-100%); }
#cine.open-bars .cine-bar.bot { transform: translateY(100%); }
#cine .cine-fade { position: absolute; inset: 0; background: #000; opacity: 1; pointer-events: none; }
#cine .cine-cap { position: absolute; left: 8vw; right: 8vw; bottom: 0; height: 12.5vh; display: flex; align-items: center; justify-content: center;
  text-align: center; color: #e9e4d8; font: 400 clamp(15px, 2.1vh, 24px)/1.4 Georgia, 'Times New Roman', serif; letter-spacing: .02em;
  opacity: 0; transition: opacity .9s ease; text-shadow: 0 0 18px rgba(0,0,0,.9); }
#cine .cine-cap.show { opacity: 1; }
#cine .cine-cap b { color: #ffe9a8; font-weight: 600; }
#cine .cine-cap kbd { display: inline-block; min-width: 1.3em; padding: 0 .35em; margin: 0 .1em; border: 1px solid rgba(255,233,168,.55); border-radius: 4px;
  font: 600 .85em/1.35 system-ui, sans-serif; color: #ffe9a8; background: rgba(255,233,168,.08); }
#cine .cine-title { position: absolute; left: 0; right: 0; top: 38%; text-align: center; color: #efe9dc; opacity: 0; transition: opacity 1.2s ease;
  font: 400 clamp(20px, 3.4vh, 40px)/1.3 Georgia, 'Times New Roman', serif; letter-spacing: .06em; text-shadow: 0 0 24px rgba(0,0,0,.95); }
#cine .cine-title small { display: block; margin-top: .5em; font-size: .5em; letter-spacing: .3em; text-transform: uppercase; color: #b9b2a2; }
#cine .cine-title.show { opacity: 1; }
#cine .cine-skip { position: absolute; right: 2.2vw; bottom: calc(12.5vh + 12px); display: flex; align-items: center; gap: 8px; color: #cfc8b8;
  font: 500 13px/1 system-ui, sans-serif; letter-spacing: .04em; opacity: 0; transition: opacity .4s ease; }
#cine .cine-skip.show { opacity: .85; }
#cine .cine-skip svg { width: 22px; height: 22px; transform: rotate(-90deg); }
#cine .cine-skip circle { fill: none; stroke-width: 3; }
#cine .cine-skip .bg { stroke: rgba(255,255,255,.18); }
#cine .cine-skip .fg { stroke: #ffe9a8; stroke-linecap: round; }
body.cine-on > :not(#view):not(#cine) { opacity: 0 !important; pointer-events: none !important; }
body.cine-out > :not(#view):not(#cine) { transition: opacity 1.2s ease; }
`;

const RING = 2 * Math.PI * 9;

export class IntroUi {
  readonly root = document.createElement('div');
  private fadeEl = document.createElement('div');
  private cap = document.createElement('div');
  private title = document.createElement('div');
  private skip = document.createElement('div');
  private ring!: SVGCircleElement;
  private style = document.createElement('style');
  private capText = '';

  constructor() {
    this.style.textContent = CSS;
    document.head.appendChild(this.style);
    this.root.id = 'cine';
    const top = document.createElement('div'); top.className = 'cine-bar top';
    const bot = document.createElement('div'); bot.className = 'cine-bar bot';
    this.fadeEl.className = 'cine-fade';
    this.cap.className = 'cine-cap';
    this.title.className = 'cine-title';
    this.skip.className = 'cine-skip';
    this.skip.innerHTML = `<svg viewBox="0 0 22 22"><circle class="bg" cx="11" cy="11" r="9"/><circle class="fg" cx="11" cy="11" r="9" stroke-dasharray="${RING}" stroke-dashoffset="${RING}"/></svg><span></span>`;
    this.ring = this.skip.querySelector('.fg') as SVGCircleElement;
    this.root.append(this.fadeEl, top, bot, this.title, this.cap, this.skip);
    document.body.appendChild(this.root);
    document.body.classList.add('cine-on');
  }

  /** Full-screen fade: 0 clear … 1 covered; colour from black (0) to warm white (1). */
  fade(a: number, white = 0): void {
    const o = String(Math.round(Math.max(0, Math.min(1, a)) * 1000) / 1000);
    if (this.fadeEl.style.opacity !== o) this.fadeEl.style.opacity = o;
    const w = Math.max(0, Math.min(1, white));
    const c = `rgb(${Math.round(255 * w)}, ${Math.round(250 * w)}, ${Math.round(240 * w)})`;
    if (this.lastColor !== c) { this.lastColor = c; this.fadeEl.style.background = c; }
  }
  private lastColor = '';

  caption(html: string): void {
    if (html === this.capText) return;
    this.capText = html;
    if (!html) { this.cap.classList.remove('show'); return; }
    // Fade out, swap, fade in.
    this.cap.classList.remove('show');
    // (In a span: the bar is a flex box, which would drop the spaces round <b> and <kbd>.)
    window.setTimeout(() => { if (this.capText === html) { this.cap.innerHTML = `<span>${html}</span>`; this.cap.classList.add('show'); } }, this.cap.innerHTML ? 450 : 0);
  }

  titleCard(html: string): void {
    if (html) this.title.innerHTML = html;
    this.title.classList.toggle('show', !!html);
  }

  /** Skip prompt: hidden (null), or shown with a label and the hold progress 0..1. */
  skipPrompt(label: string | null, f = 0): void {
    this.skip.classList.toggle('show', label !== null);
    if (label !== null) {
      const s = this.skip.querySelector('span') as HTMLSpanElement;
      if (s.textContent !== label) s.textContent = label;
      this.ring.setAttribute('stroke-dashoffset', String(RING * (1 - Math.max(0, Math.min(1, f)))));
    }
  }

  /** Bars out, the game's interface back (faded in), then the layer is removed. */
  close(): void {
    this.root.classList.add('open-bars');
    this.caption('');
    this.titleCard('');
    this.skipPrompt(null);
    this.root.style.pointerEvents = 'none';
    this.root.style.cursor = '';
    document.body.classList.add('cine-out');
    document.body.classList.remove('cine-on');
    window.setTimeout(() => {
      this.root.remove();
      this.style.remove();
      document.body.classList.remove('cine-out');
    }, 1400);
  }
}
