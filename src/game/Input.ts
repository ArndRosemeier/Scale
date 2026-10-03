/**
 * Keyboard / mouse state. The cursor stays visible (left click picks targets and presses
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
  private el: HTMLElement;

  constructor(el: HTMLElement) {
    this.el = el;
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (['Space', 'Tab', 'NumpadAdd', 'NumpadSubtract', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.buttons = 0; this.releaseLook(); });
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
  get looking(): boolean { return this.locked || (this.buttons & 4) !== 0; }

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
    this.pressed.clear();
    this.mouseDX = this.mouseDY = 0;
    this.wheel = 0;
    this.clicked = 0;
  }
}
