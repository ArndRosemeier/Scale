/** Keyboard / mouse state with pointer lock. */
export class Input {
  readonly keys = new Set<string>();
  readonly pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  buttons = 0;
  clicked = 0;
  locked = false;

  constructor(el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (['Space', 'Tab', 'NumpadAdd', 'NumpadSubtract', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    el.addEventListener('mousedown', (e) => {
      this.buttons |= 1 << e.button;
      this.clicked |= 1 << e.button;
      if (!this.locked) el.requestPointerLock?.();
    });
    window.addEventListener('mouseup', (e) => (this.buttons &= ~(1 << e.button)));
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    el.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => (this.locked = document.pointerLockElement === el));
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }
  hit(code: string): boolean {
    return this.pressed.has(code);
  }
  endFrame(): void {
    this.pressed.clear();
    this.mouseDX = this.mouseDY = 0;
    this.wheel = 0;
    this.clicked = 0;
  }
}
