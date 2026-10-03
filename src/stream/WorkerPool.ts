/**
 * Pool of city workers with a priority queue. Every worker holds its own
 * deterministic copy of the world; jobs go to the least busy worker.
 */
import type { CitySettings } from '../world/settings';
import type { MacroPlan } from '../plan/types';
import type { FromWorker, ToWorker } from './protocol';

type Job = { msg: ToWorker; priority: number; resolve: (r: FromWorker) => void; reject: (e: Error) => void };

export class WorkerPool {
  private workers: Worker[] = [];
  private busy: number[] = [];
  private queue: Job[] = [];
  private pending = new Map<number, Job>();
  private nextJob = 1;
  readonly size: number;
  macro!: MacroPlan;

  constructor(size: number) {
    this.size = size;
  }

  async init(settings: CitySettings): Promise<MacroPlan> {
    const ready: Promise<FromWorker>[] = [];
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(new URL('./city.worker.ts', import.meta.url), { type: 'module' });
      this.workers.push(w);
      this.busy.push(0);
      ready.push(
        new Promise((res, rej) => {
          w.onmessage = (ev: MessageEvent<FromWorker>) => res(ev.data);
          w.onerror = (e) => rej(new Error(e.message));
        }),
      );
      w.postMessage({ type: 'init', settings, sendMacro: i === 0 } satisfies ToWorker);
    }
    const results = await Promise.all(ready);
    const first = results[0];
    if (first.type !== 'ready' || !first.macro) throw new Error('worker init failed: ' + JSON.stringify(first).slice(0, 300));
    this.macro = first.macro;
    this.workers.forEach((w, i) => {
      w.onmessage = (ev: MessageEvent<FromWorker>) => this.onMessage(i, ev.data);
      w.onerror = (e) => console.error('worker error', e.message);
    });
    return this.macro;
  }

  /** Queue a job; lower priority value runs first. */
  run<T extends FromWorker>(msg: ToWorker, priority: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job = { msg, priority, resolve: resolve as (r: FromWorker) => void, reject };
      (msg as { job: number }).job = this.nextJob++;
      this.queue.push(job);
      this.pump();
    });
  }

  /** Re-prioritise queued jobs (e.g. as the camera moves). */
  reprioritise(fn: (msg: ToWorker, current: number) => number | null): void {
    const keep: Job[] = [];
    for (const j of this.queue) {
      const p = fn(j.msg, j.priority);
      if (p === null) j.reject(new Error('cancelled'));
      else { j.priority = p; keep.push(j); }
    }
    this.queue = keep;
  }

  get queued(): number {
    return this.queue.length;
  }
  get inFlight(): number {
    return this.pending.size;
  }

  private pump(): void {
    while (this.queue.length) {
      let wi = -1, best = Infinity;
      for (let i = 0; i < this.workers.length; i++) if (this.busy[i] < best) { best = this.busy[i]; wi = i; }
      if (best >= 2) return; // at most 2 jobs per worker in flight
      let ji = 0;
      for (let i = 1; i < this.queue.length; i++) if (this.queue[i].priority < this.queue[ji].priority) ji = i;
      const job = this.queue.splice(ji, 1)[0];
      const id = (job.msg as { job: number }).job;
      this.pending.set(id, job);
      this.busy[wi]++;
      (job as Job & { worker: number }).worker = wi;
      this.workers[wi].postMessage(job.msg);
    }
  }

  private onMessage(wi: number, m: FromWorker): void {
    const id = (m as { job?: number }).job ?? -1;
    const job = this.pending.get(id);
    this.busy[wi] = Math.max(0, this.busy[wi] - 1);
    if (job) {
      this.pending.delete(id);
      if (m.type === 'error') job.reject(new Error(m.message));
      else job.resolve(m);
    } else if (m.type === 'error') console.error(m.message);
    this.pump();
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }
}
