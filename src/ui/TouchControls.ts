/**
 * On-screen controls for touch screens (iPad first): shown in touch mode (ui/touch.ts).
 *
 *  - Left side of the view: a floating stick where the thumb lands. Walk; pushed to the rim it
 *    runs (in flight: boost), barely pushed it walks slowly. It holds W/A/S/D like the keys.
 *  - Right side: drag to look around, pinch to zoom the camera, tap someone to target them
 *    (a tap is a left click at that point).
 *  - Buttons send the same keys as the keyboard (keydown on press, keyup on release), so held
 *    keys work as on a keyboard: hold Jump to charge a super jump or to rise in flight, hold
 *    Use to dig someone out. The hotbar slots take touches themselves.
 */
import type { Game } from '../game/Game';
import { isTouch, onTouchMode } from './touch';

const KEY_NAMES: Record<string, string> = {
  Space: ' ', Tab: 'Tab', Escape: 'Escape', Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']',
};

/** Send a key as if typed (window listeners and Input both see it). */
export function sendKey(code: string, down: boolean): void {
  const key = KEY_NAMES[code] ?? (code.startsWith('Key') ? code.slice(3).toLowerCase() : code);
  window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key, bubbles: true, cancelable: true }));
}

interface Btn { el: HTMLButtonElement; code: string | null; action?: () => void; held: number | null }

const STICK_R = 56;

export class TouchControls {
  private root: HTMLDivElement;
  private stickBase: HTMLDivElement;
  private stickKnob: HTMLDivElement;
  private more: HTMLDivElement;
  private btns = new Map<string, Btn>();
  private stick: { id: number; x: number; y: number } | null = null;
  private looks = new Map<number, { x: number; y: number; x0: number; y0: number; t0: number; tap: boolean }>();
  private pinchD = 0;
  private stickKeys = new Set<string>();
  private shown = false;
  private prompt: HTMLElement | null = null;
  private state = '';

  constructor(private game: Game) {
    // The centre dot: on touch, powers without a target go where the camera looks.
    if (!document.getElementById('crosshair')) {
      const c = document.createElement('div');
      c.id = 'crosshair';
      document.body.appendChild(c);
    }
    this.root = document.createElement('div');
    this.root.id = 'touch';
    this.root.innerHTML = `
      <div class="tc-stick"><div class="tc-knob"></div></div>
      <div class="tc-sys">
        <button data-id="powers" data-code="KeyP">Powers</button>
        <button data-id="map" data-code="KeyM">Map</button>
        <button data-id="more" aria-label="More">⋯</button>
        <button data-id="pause" aria-label="Pause and settings">☰</button>
      </div>
      <div class="tc-more">
        <button data-id="rally" data-code="KeyG">Rally army<i>G</i></button>
        <button data-id="strike" data-code="KeyT">Airstrike<i>T</i></button>
        <button data-id="mini" data-code="KeyN">Minimap<i>N</i></button>
        <button data-id="earlier" data-code="BracketLeft">Time −1 h<i>[</i></button>
        <button data-id="later" data-code="BracketRight">Time +1 h<i>]</i></button>
        <button data-id="blast" data-code="KeyB">Test blast<i>B</i></button>
        <button data-id="help" data-code="KeyH">Controls<i>H</i></button>
      </div>
      <div class="tc-acts">
        <button data-id="jump" data-code="Space" class="big"><span>Jump</span><i>␣</i></button>
        <button data-id="down" data-code="KeyC"><span>Down</span><i>C</i></button>
        <button data-id="fly" data-code="KeyF"><span>Fly</span><i>F</i></button>
        <button data-id="use" data-code="KeyE"><span>Use</span><i>E</i></button>
        <button data-id="target" data-code="Tab"><span>Target</span><i>Tab</i></button>
        <button data-id="untarget" data-code="Escape" aria-label="Clear target"><span>✕</span></button>
        <button data-id="auto" data-code="KeyR"><span>Auto</span><i>R</i></button>
        <button data-id="grow" data-code="Equal" class="small"><span>+</span></button>
        <button data-id="shrink" data-code="Minus" class="small"><span>−</span></button>
      </div>`;
    document.body.appendChild(this.root);
    this.stickBase = this.root.querySelector('.tc-stick') as HTMLDivElement;
    this.stickKnob = this.root.querySelector('.tc-knob') as HTMLDivElement;
    this.more = this.root.querySelector('.tc-more') as HTMLDivElement;
    for (const el of this.root.querySelectorAll<HTMLButtonElement>('button[data-id]')) {
      const b: Btn = { el, code: el.dataset.code ?? null, held: null };
      if (el.dataset.id === 'pause') b.action = () => { this.more.classList.remove('open'); game.menu?.show(); };
      if (el.dataset.id === 'more') b.action = () => this.more.classList.toggle('open');
      this.btns.set(el.dataset.id!, b);
      this.wire(b);
    }
    this.btns.get('blast')!.el.hidden = game.mode !== 'sandbox';

    const view = document.getElementById('view') as HTMLCanvasElement;
    const opts = { passive: false } as const;
    view.addEventListener('touchstart', (e) => this.touchStart(e), opts);
    view.addEventListener('touchmove', (e) => this.touchMove(e), opts);
    view.addEventListener('touchend', (e) => this.touchEnd(e), opts);
    view.addEventListener('touchcancel', (e) => this.touchEnd(e), opts);
    onTouchMode((on) => { if (!on) this.releaseAll(); });
    window.addEventListener('blur', () => this.releaseAll());
  }

  // ------------------------------------------------------------------ buttons

  private wire(b: Btn): void {
    const el = b.el;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (b.held !== null) return;
      b.held = e.pointerId;
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      el.classList.add('down');
      if (b.code) sendKey(b.code, true);
      // (The overflow menu closes after one of its actions.)
      if (el.parentElement === this.more) window.setTimeout(() => this.more.classList.remove('open'), 120);
    });
    const up = (e: PointerEvent) => {
      if (b.held !== e.pointerId) return;
      b.held = null;
      el.classList.remove('down');
      if (b.code) sendKey(b.code, false);
      b.action?.();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    // No click after the touch: it would land on what the button just opened (the controls
    // overlay closes on a click).
    el.addEventListener('touchend', (e) => e.preventDefault(), { passive: false });
  }

  // ------------------------------------------------------------------ view touches

  private touchStart(e: TouchEvent): void {
    if (!isTouch()) return;
    e.preventDefault();
    this.more.classList.remove('open');
    for (const t of e.changedTouches) {
      const leftSide = t.clientX < window.innerWidth * 0.42 && t.clientY > window.innerHeight * 0.22;
      if (leftSide && !this.stick && this.shown) {
        // The stick sits where the thumb lands (kept clear of the screen edge).
        const x = Math.max(STICK_R + 8, t.clientX), y = Math.min(window.innerHeight - STICK_R - 8, t.clientY);
        this.stick = { id: t.identifier, x, y };
        this.stickBase.classList.add('active');
        this.stickBase.style.transform = `translate(${x - STICK_R}px, ${y - STICK_R}px)`;
        this.moveStick(t.clientX, t.clientY);
        continue;
      }
      this.looks.set(t.identifier, { x: t.clientX, y: t.clientY, x0: t.clientX, y0: t.clientY, t0: performance.now(), tap: this.looks.size === 0 });
      if (this.looks.size >= 2) {
        // A second finger: pinch, not a tap.
        for (const l of this.looks.values()) l.tap = false;
        this.pinchD = this.pinchDist();
      }
    }
    this.syncLook();
  }

  private touchMove(e: TouchEvent): void {
    if (!isTouch()) return;
    e.preventDefault();
    const input = this.game.input;
    let pinched = false;
    for (const t of e.changedTouches) {
      if (this.stick?.id === t.identifier) { this.moveStick(t.clientX, t.clientY); continue; }
      const l = this.looks.get(t.identifier);
      if (!l) continue;
      const dx = t.clientX - l.x, dy = t.clientY - l.y;
      l.x = t.clientX; l.y = t.clientY;
      if (l.tap && Math.hypot(l.x - l.x0, l.y - l.y0) > 10) l.tap = false;
      if (this.looks.size >= 2) { pinched = true; continue; }
      // About half a turn per 60 % of the screen's width.
      const k = 2200 / Math.max(600, window.innerWidth);
      input.mouseDX += dx * k;
      input.mouseDY += dy * k;
    }
    if (pinched) {
      const d = this.pinchDist();
      // Fingers apart: closer (as the wheel turned forward).
      if (this.pinchD > 0 && d > 0) input.wheel -= Math.log(d / this.pinchD) / Math.log(1.15);
      this.pinchD = d;
    }
  }

  private touchEnd(e: TouchEvent): void {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (this.stick?.id === t.identifier) { this.endStick(); continue; }
      const l = this.looks.get(t.identifier);
      if (!l) continue;
      this.looks.delete(t.identifier);
      if (e.type === 'touchend' && l.tap && performance.now() - l.t0 < 350 && isTouch()) this.game.input.tap(t.clientX, t.clientY);
    }
    if (this.looks.size >= 2) this.pinchD = this.pinchDist();
    this.syncLook();
  }

  private pinchDist(): number {
    const [a, b] = [...this.looks.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  private syncLook(): void {
    // The centre dot shows while a finger drags the view (as while the right mouse button is held).
    this.game.input.touchLook = this.looks.size > 0 && [...this.looks.values()].some((l) => !l.tap);
  }

  private moveStick(cx: number, cy: number): void {
    const s = this.stick!;
    let dx = cx - s.x, dy = cy - s.y;
    const len = Math.hypot(dx, dy);
    const mag = len / STICK_R;
    if (len > STICK_R) { dx *= STICK_R / len; dy *= STICK_R / len; }
    this.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    const want = new Set<string>();
    if (mag > 0.2) {
      // Eight directions (22.5° either side of each axis).
      const ux = dx / Math.max(1e-6, Math.hypot(dx, dy)), uy = dy / Math.max(1e-6, Math.hypot(dx, dy));
      if (uy < -0.38) want.add('KeyW');
      if (uy > 0.38) want.add('KeyS');
      if (ux > 0.38) want.add('KeyD');
      if (ux < -0.38) want.add('KeyA');
    }
    this.setStickKeys(want);
    const input = this.game.input;
    input.touchRun = mag >= 0.98;
    input.touchSlow = mag > 0.2 && mag < 0.5;
    this.stickBase.classList.toggle('run', input.touchRun);
  }

  private setStickKeys(want: Set<string>): void {
    const input = this.game.input;
    for (const k of this.stickKeys) if (!want.has(k)) input.setKey(k, false);
    for (const k of want) if (!this.stickKeys.has(k)) input.setKey(k, true);
    this.stickKeys = want;
  }

  private endStick(): void {
    this.stick = null;
    this.setStickKeys(new Set());
    this.game.input.touchRun = this.game.input.touchSlow = false;
    this.stickBase.classList.remove('active', 'run');
    this.stickBase.style.transform = '';
    this.stickKnob.style.transform = '';
  }

  private releaseAll(): void {
    if (this.stick) this.endStick();
    this.looks.clear();
    this.syncLook();
    for (const b of this.btns.values()) {
      if (b.held === null) continue;
      b.held = null;
      b.el.classList.remove('down');
      if (b.code) sendKey(b.code, false);
    }
    this.more.classList.remove('open');
  }

  // ------------------------------------------------------------------ per frame

  update(): void {
    const g = this.game;
    const show = isTouch() && !g.menu?.paused && !g.map?.open && !g.powers?.open && !g.intro?.active && !g.people?.talking;
    if (show !== this.shown) {
      this.shown = show;
      this.root.classList.toggle('on', show);
      if (!show) this.releaseAll();
    }
    if (!show) return;
    const p = g.player;
    this.prompt ??= document.getElementById('panel-prompt');
    const useReady = !!this.prompt?.classList.contains('show') && this.prompt.innerHTML.includes('<b>E</b>');
    const sized = p.sizeOverride || p.maxHeight - p.minHeight > 0.05;
    const state = `${p.flying ? 1 : 0}${p.flightAllowed ? 1 : 0}${g.targeting?.current ? 1 : 0}${p.autoMove ? 1 : 0}${useReady ? 1 : 0}${sized ? 1 : 0}`;
    if (state === this.state) return;
    this.state = state;
    const B = (id: string) => this.btns.get(id)!.el;
    B('jump').querySelector('span')!.textContent = p.flying ? 'Up' : 'Jump';
    B('down').hidden = !p.flying;
    B('fly').hidden = !p.flightAllowed;
    B('fly').querySelector('span')!.textContent = p.flying ? 'Land' : 'Fly';
    B('untarget').hidden = !g.targeting?.current;
    B('auto').classList.toggle('lit', p.autoMove);
    B('use').classList.toggle('lit', useReady);
    B('grow').hidden = B('shrink').hidden = !sized;
  }
}
