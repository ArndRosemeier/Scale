/**
 * Frame-budgeted main-thread work.
 *
 * Expensive main-thread steps that don't have to happen in a particular frame (e.g.
 * finishing a character after its body was built in a worker: materials, skeleton,
 * clothing) are queued here and run a few milliseconds' worth per frame, highest
 * priority first and always at least one job per frame, instead of all at once.
 * Results arriving together — a town's worth of bodies — then spread over frames
 * rather than freezing the game for seconds.
 *
 * Jobs are plain callbacks run synchronously inside `pump()` (not promise slots:
 * continuations of resolved promises would all run after the pump, ignoring the
 * budget). The game loop calls `pump()` once per frame; without a loop (sandboxes,
 * tests) a fallback timer drains the queue.
 */
import { budgets } from './budgets';

interface Job {
  run: () => void;
  priority: number;
  seq: number;
  label: string;
}

/** Milliseconds of queued work per frame, by device class. */
const BUDGET_MS = { desktop: 4, 'desktop-low': 3, tablet: 3, phone: 2 } as const;

class FrameWork {
  private queue: Job[] = [];
  private seq = 0;
  private lastPump = 0;
  private fallback = 0;
  /** Jobs run and time spent (diagnostics). */
  readonly stats = { jobs: 0, ms: 0, maxQueue: 0 };

  /** Called for a single job that took over 150 ms (diagnostics → hitch journal). */
  onSlowJob: ((label: string, ms: number) => void) | null = null;

  /** Queue work; lower priority values run sooner (ties: first come, first served). */
  run(fn: () => void, priority = 0, label = 'job'): void {
    this.queue.push({ run: fn, priority, seq: this.seq++, label });
    this.stats.maxQueue = Math.max(this.stats.maxQueue, this.queue.length);
    this.armFallback();
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Run queued work within this frame's budget (at least one job). */
  pump(budgetMs = BUDGET_MS[budgets.deviceClass] ?? 4): void {
    this.lastPump = performance.now();
    if (!this.queue.length) return;
    this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    const t0 = performance.now();
    let n = 0;
    while (this.queue.length && (n === 0 || performance.now() - t0 < budgetMs)) {
      const job = this.queue.shift()!;
      n++;
      const tj = performance.now();
      try {
        job.run();
      } catch (e) {
        console.error('[frameWork] job failed', e);
      }
      const dj = performance.now() - tj;
      if (dj > 150) this.onSlowJob?.(job.label, dj);
    }
    this.stats.jobs += n;
    this.stats.ms += performance.now() - t0;
  }

  /** Drain via timers when no frame loop pumps (sandboxes, tests, hidden tabs). */
  private armFallback() {
    if (this.fallback || typeof setTimeout === 'undefined') return;
    this.fallback = setTimeout(() => {
      this.fallback = 0;
      if (performance.now() - this.lastPump > 150) this.pump();
      if (this.queue.length) this.armFallback();
    }, 200) as unknown as number;
  }
}

/** The main-thread frame work queue. */
export const frameWork = new FrameWork();
