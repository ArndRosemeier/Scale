/**
 * Game-time callbacks. `after(s, fn)` runs `fn` once `s` seconds of simulated time have passed:
 * it follows the simulation's own clock (capped steps on slow frames, headless runs), which a
 * wall-clock `setTimeout` does not. Use it for anything that changes the game (see docs/CONVENTIONS.md).
 */
export class Later {
  private queue: { t: number; fn: () => void }[] = [];
  private now = 0;

  after(seconds: number, fn: () => void): void {
    this.queue.push({ t: this.now + Math.max(0, seconds), fn });
  }

  update(dt: number): void {
    this.now += dt;
    if (!this.queue.some((e) => e.t <= this.now)) return;
    const due = this.queue.filter((e) => e.t <= this.now).sort((a, b) => a.t - b.t);
    this.queue = this.queue.filter((e) => e.t > this.now);
    for (const e of due) e.fn();
  }

  get pending(): number { return this.queue.length; }
}
