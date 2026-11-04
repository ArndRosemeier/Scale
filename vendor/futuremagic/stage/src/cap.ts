/**
 * The shader cap (see the game's docs/SHADERS.md): after the loading screen, shader builds take at most a third of
 * the time (`share`), spread evenly: a build that took t ms is followed by at least 2t ms without one, and there is at
 * most one per frame. Quick builds (a skinned mesh's shadow shader, 1 to 2 ms) follow each other closely; a slow one
 * keeps the next one waiting longer. With each build under 100 ms, the game never freezes. During warm-up
 * (`active = false`) everything builds at full speed.
 *
 * Each slot is given back with the function `slot` resolves to, once its build is done: the build's time sets the
 * wait before the next one. A slot never given back holds the cap for at most `STALE_MS`.
 *
 * Ported from Scale (src/render/shaderCap.ts) via Dunfinity, with the clock injectable for tests; the share of time in
 * place of a count per second (Arnd, 2026-10-22: "shader time can only be 1/3 of the time and needs to be spaced out
 * evenly").
 */
const STALE_MS = 1000;

/** Gives the slot back once its build is done (again: nothing). */
export type Release = () => void;

export class ShaderCap {
  /** The most of any stretch of time that shader builds may take. */
  share = 1 / 3;
  /** Off during warm-up. */
  active = false;
  /** Builds waiting for room right now. */
  waiting = 0;
  /** No build starts before this time (the wait after the last one). */
  private freeAt = -1e9;
  /** When the slot still out was taken (null: none is out). */
  private busySince: number | null = null;
  private frameTaken = false;

  constructor(private readonly now: () => number = () => performance.now(), private readonly nextFrame: (fn: () => void) => void = (fn) => requestAnimationFrame(fn)) {}

  /** Once per frame, before anything starts a build. */
  newFrame(): void { this.frameTaken = false; }

  room(): boolean {
    if (!this.active || this.share >= 1) return true;
    const t = this.now();
    if (this.busySince !== null && t - this.busySince < STALE_MS) return false;
    return !this.frameTaken && t >= this.freeAt;
  }

  /** Book one build starting now. */
  take(): Release {
    const t0 = this.now();
    this.frameTaken = true;
    this.busySince = t0;
    let given = false;
    return () => {
      if (given) return;
      given = true;
      const t = this.now();
      if (this.busySince === t0) this.busySince = null;
      if (this.share > 0) this.freeAt = Math.max(this.freeAt, t + (t - t0) * (1 / this.share - 1));
    };
  }

  /**
   * A build that did not wait for a slot (a synchronous one: something drawn that was never compiled ahead) still
   * spent the time: the next build waits after it as after any other, so one stray build does not set off a burst.
   */
  spent(t0: number, t1: number): void {
    if (!this.active || this.share >= 1 || this.share <= 0 || this.busySince !== null) return; // inside a slot: its release counts it
    this.freeAt = Math.max(this.freeAt, t1 + (t1 - t0) * (1 / this.share - 1));
  }

  /** Resolves on a frame with room, and takes it; give it back once the build is done. */
  slot(): Promise<Release> {
    if (this.room()) return Promise.resolve(this.take());
    this.waiting++;
    return new Promise((res) => {
      const again = (): void => {
        if (!this.room()) { this.nextFrame(again); return; }
        this.waiting--;
        res(this.take());
      };
      this.nextFrame(again);
    });
  }
}
