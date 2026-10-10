/**
 * Hard cap on new shaders: at most `maxPerSecond` per second, spaced evenly (one start at most
 * every 1/maxPerSecond s, so five never come back to back), once the game runs (the start-up
 * warm-up compiles at full speed). Content that would need a new shader past the cap stays hidden
 * until there is room: looking odd for a moment beats a hitch.
 *
 * WebGL: the shader gate hands new meshes to the compiler only while there is room. WebGPU: every
 * background node build waits for room (webgpu/index.ts, oneNodeBuildAtATime). Shaders that start
 * while drawing (a material switched on an existing mesh, WebGPU shadow passes) cannot wait, but
 * they count against the cap all the same.
 *
 * Console: `shaderCap.maxPerSecond = n` (0 = no cap). URL: `&shadercap=n`. Shift+F11 shows it.
 */
const fromUrl = /[?&]shadercap=(\d+)/.exec(location.search);

class ShaderCap {
  maxPerSecond = fromUrl ? +fromUrl[1] : 5;
  /** Off during the start-up warm-up. */
  active = false;
  /** [time, new shaders] of the last second. */
  private spent: [number, number][] = [];
  private frameTaken = false;
  /** Meshes or builds waiting for room right now (for the Shift+F11 box). */
  waiting = 0;

  /** Book new shaders (whoever started them). */
  book(n: number): void {
    if (n > 0) { this.spent.push([performance.now(), n]); this.lastAt = performance.now(); }
  }

  /** Once per frame, before anything is started. */
  newFrame(): void { this.frameTaken = false; }

  get lastSecond(): number {
    const cut = performance.now() - 1000;
    while (this.spent.length && this.spent[0][0] < cut) this.spent.shift();
    let n = 0;
    for (const e of this.spent) n += e[1];
    return n;
  }

  /** When the last new shader was booked. */
  private lastAt = -1e9;

  room(): boolean {
    if (!this.active || this.maxPerSecond <= 0) return true;
    // Spaced, not bunched (Arnd: "no 0.5 second hitch"): with each compile under 0.1 s, at most
    // half of any stretch of time goes to shaders.
    return !this.frameTaken && performance.now() - this.lastAt >= 1000 / this.maxPerSecond && this.lastSecond < this.maxPerSecond;
  }

  /** Something that will build new shaders starts in this frame. */
  take(): void { this.frameTaken = true; }

  /** Resolves on a frame with room (and takes it). */
  slot(): Promise<void> {
    if (this.room()) { this.take(); return Promise.resolve(); }
    this.waiting++;
    return new Promise((res) => {
      const again = (): void => {
        if (!this.room()) { requestAnimationFrame(again); return; }
        this.waiting--;
        this.take();
        res();
      };
      requestAnimationFrame(again);
    });
  }
}

export const shaderCap = new ShaderCap();
(window as unknown as { shaderCap: ShaderCap }).shaderCap = shaderCap;
