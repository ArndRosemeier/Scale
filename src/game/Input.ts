import { gameCode } from './keybinds';

/**
 * Keyboard / mouse state. Keys are kept as game codes (keybinds.ts: a reassigned key arrives as
 * the code of the action it is bound to). The cursor stays visible (left click picks targets and presses
 * buttons); holding the right mouse button looks around (pointer lock while held).
 */
export class Input {
  readonly keys = new Set<string>();
  readonly pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  buttons = 0;
  clicked = 0;
  locked = false;
  /** Cursor position in the canvas (CSS px) and the canvas size, for picking under the mouse. */
  mouseX = -1;
  mouseY = -1;
  /** Touch controls (TouchControls): a look drag in progress, and the stick's run / slow walk. */
  touchLook = false;
  touchRun = false;
  touchSlow = false;
  /** A tap set the cursor for one frame (picking): it is dropped again at the end of the frame. */
  private tapped = false;
  private el: HTMLElement;
  private _suspended = false;
  /** A dialog over the game (the character creator) has the keyboard: game keys are ignored. */
  get suspended(): boolean { return this._suspended; }
  set suspended(v: boolean) { this._suspended = v; this.keys.clear(); this.held.clear(); this.pressed.clear(); }

  /**
   * Something in the world takes the keyboard (an arcade game being played): it sees every key
   * going down and up first, and the game never sees the ones it returns true for.
   */
  grab: ((code: string, down: boolean, game: string) => boolean) | null = null;
  /** Shift held (whatever Shift is bound to): reverses target cycling. */
  shift = false;
  /** Physical key -> the game code its keydown added (so its keyup removes the same one). */
  private held = new Map<string, string>();

  constructor(el: HTMLElement) {
    this.el = el;
    window.addEventListener('keydown', (e) => {
      this.shift = e.shiftKey;
      if (e.target instanceof HTMLInputElement || this._suspended) return;
      const code = gameCode(e);
      if (this.grab?.(e.code, true, code)) { e.preventDefault(); return; }
      if (['Space', 'Tab', 'NumpadAdd', 'NumpadSubtract', 'ArrowUp', 'ArrowDown'].includes(code || e.code)) e.preventDefault();
      if (!code) return;
      const was = this.held.get(e.code);
      if (was && was !== code) this.keys.delete(was);
      this.held.set(e.code, code);
      if (!this.keys.has(code)) this.pressed.add(code);
      this.keys.add(code);
    });
    window.addEventListener('keyup', (e) => {
      this.shift = e.shiftKey;
      const code = this.held.get(e.code) ?? gameCode(e);
      this.held.delete(e.code);
      this.grab?.(e.code, false, code);
      if (code) this.keys.delete(code);
    });
    window.addEventListener('blur', () => { this.grab?.('Blur', false, 'Blur'); this.keys.clear(); this.held.clear(); this.shift = false; this.buttons = 0; this.releaseLook(); });
    el.addEventListener('mousedown', (e) => {
      this.buttons |= 1 << e.button;
      this.clicked |= 1 << e.button;
      if (e.button === 2 && !this.locked) {
        try { const r = el.requestPointerLock?.() as unknown as Promise<void> | undefined; r?.catch?.(() => {}); } catch { /* not allowed now */ }
      }
    });
    window.addEventListener('mouseup', (e) => {
      this.buttons &= ~(1 << e.button);
      if (e.button === 2) this.releaseLook();
    });
    window.addEventListener('mousemove', (e) => {
      // Look while the right button is held (locked, or the lock not granted yet).
      if (this.locked || this.buttons & 4) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
      // Over the HUD (hotbar …) the last position over the view stays the aim point.
      if (!this.locked && e.target === el) {
        const r = el.getBoundingClientRect();
        this.mouseX = e.clientX - r.left;
        this.mouseY = e.clientY - r.top;
      }
    });
    document.documentElement.addEventListener('mouseleave', () => { if (!this.locked) this.mouseX = this.mouseY = -1; });
    el.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => (this.locked = document.pointerLockElement === el));
  }

  /** Mouse look in progress (right button held)? */
  get looking(): boolean { return this.locked || (this.buttons & 4) !== 0 || this.touchLook; }

  /** Hold or release a key from the touch controls (polled keys only: no keydown event). */
  setKey(code: string, on: boolean): void {
    if (this.grab?.(code, on, code) && on) return;
    if (on) { if (!this.keys.has(code)) this.pressed.add(code); this.keys.add(code); }
    else this.keys.delete(code);
  }

  /** A tap on the view (touch): a left click at that point, for this frame only. */
  tap(clientX: number, clientY: number): void {
    const r = this.el.getBoundingClientRect();
    this.mouseX = clientX - r.left;
    this.mouseY = clientY - r.top;
    this.clicked |= 1;
    this.tapped = true;
  }

  /** Cursor in normalised device coordinates (null: not over the view, or looking). */
  cursorNdc(): { x: number; y: number } | null {
    if (this.looking || this.mouseX < 0) return null;
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h || this.mouseX > w || this.mouseY > h) return null;
    return { x: (this.mouseX / w) * 2 - 1, y: 1 - (this.mouseY / h) * 2 };
  }

  releaseLook(): void {
    if (document.pointerLockElement === this.el) document.exitPointerLock();
  }

  /** Per frame: body.looking shows the centre crosshair while looking around. */
  private wasLooking = false;
  syncLookClass(): void {
    const l = this.looking;
    if (l !== this.wasLooking) { this.wasLooking = l; document.body.classList.toggle('looking', l); }
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }
  hit(code: string): boolean {
    return this.pressed.has(code);
  }
  endFrame(): void {
    this.syncLookClass();
    if (this.tapped) { this.tapped = false; this.mouseX = this.mouseY = -1; }
    this.pressed.clear();
    this.mouseDX = this.mouseDY = 0;
    this.wheel = 0;
    this.clicked = 0;
  }
}
