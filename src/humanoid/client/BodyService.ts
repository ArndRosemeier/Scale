/**
 * Main-thread front of the body pipeline: loads the human assets, owns the
 * shared static GPU data, runs character builds on a small worker pool with
 * a priority queue, and caches builds/geometry by appearance so identical
 * NPCs share one geometry. Falls back to building on the main thread when
 * workers are unavailable.
 */
import { loadHumanAssets, type HumanAssets } from '../assets';
import { buildCharacter, type CharacterBuild } from '../characterBuild';
import type { HumanoidAppearance } from '../types';
import { getHumanStatic, type HumanStatic } from './staticData';
import { CharacterGeometry } from './Character';
import { budgets } from '../../core/budgets';

interface Job {
  id: number;
  app: HumanoidAppearance;
  priority: number;
  resolve: (b: CharacterBuild) => void;
  reject: (e: unknown) => void;
}

/** Key of everything that changes the generated geometry (not colours). */
export function geometryKey(a: HumanoidAppearance): string {
  const r = (v: number) => Math.round(v * 1000);
  return [
    a.race, a.race2 ?? '-', r(a.raceMix), a.seed >>> 0, r(a.gender), r(a.age), r(a.muscle), r(a.weight), r(a.height), r(a.proportions),
    r(a.african), r(a.asian), r(a.caucasian), r(a.scale), ...Object.values(a.face).map(r), ...Object.values(a.body).map(r),
    a.hairStyle, a.beardStyle, r(a.tusks), a.horns.style, r(a.horns.size), a.tail.style, r(a.tail.length),
  ].join(',');
}

/** BodyService.collect: how often it runs on its own, and how long an unused geometry is kept at least. */
const COLLECT_EVERY_MS = 5000;
const IDLE_MS = 30000;

export class BodyService {
  private static inst: BodyService | null = null;
  static get(): BodyService {
    return (this.inst ??= new BodyService());
  }

  private assetsP: Promise<HumanAssets>;
  private st: HumanStatic | null = null;
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Job[] = [];
  private inflight = new Map<number, Job>();
  private nextId = 1;
  private noWorkers = false;
  private builds = new Map<string, Promise<CharacterGeometry>>();
  private geos = new Map<string, CharacterGeometry>();
  private collectedAt = 0;
  /** Diagnostics: last build durations (ms). */
  readonly stats = { builds: 0, avgMs: 0 };

  private constructor() {
    this.assetsP = loadHumanAssets();
    try {
      const n = budgets.bodyWorkers;
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL('../body.worker.ts', import.meta.url), { type: 'module' });
        w.addEventListener('message', (e) => this.onMessage(w, e.data));
        w.addEventListener('error', (e) => {
          console.warn('[humanoid] body worker failed, building on the main thread', e.message);
          this.noWorkers = true;
          this.flushToMainThread();
        });
        this.workers.push(w);
        this.idle.push(w);
      }
    } catch {
      this.noWorkers = true;
    }
  }

  async ready(): Promise<HumanStatic> {
    const as = await this.assetsP;
    this.st ??= getHumanStatic(as);
    return this.st;
  }

  get staticData(): HumanStatic | null {
    return this.st;
  }

  /** Geometry for an appearance (cached; lower priority value = sooner). */
  geometry(app: HumanoidAppearance, priority = 0): Promise<CharacterGeometry> {
    const key = geometryKey(app);
    const now = performance.now();
    if (now - this.collectedAt > COLLECT_EVERY_MS) {
      this.collectedAt = now;
      this.collect();
    }
    const had = this.geos.get(key);
    if (had) had.lastUsed = now;
    let p = this.builds.get(key);
    if (!p) {
      p = this.ready().then(async (st) => {
        const build = await this.build(app, priority);
        const g = new CharacterGeometry(st, build);
        this.geos.set(key, g);
        return g;
      });
      this.builds.set(key, p);
      p.catch(() => this.builds.delete(key));
    } else {
      // Raise priority of a queued job if someone needs it sooner.
      for (const j of this.queue) if (geometryKey(j.app) === key) j.priority = Math.min(j.priority, priority);
    }
    return p;
  }

  /** Synchronously available geometry (already built), or null. */
  cached(app: HumanoidAppearance): CharacterGeometry | null {
    return this.geos.get(geometryKey(app)) ?? null;
  }

  /**
   * Drop unreferenced geometries, all but the `keep` most recently used, and none used in the last
   * IDLE_MS (a rig may hold one between its build and its Character). Runs on its own from
   * geometry(): the crowd builds a new body for nearly every walker, and they used to stay cached
   * forever (about 3.5 MB each: on a PC over 1.5 GB after ten minutes of travel).
   */
  collect(keep = 24) {
    const now = performance.now();
    const unused = [...this.geos.entries()].filter(([, g]) => g.refs <= 0 && now - g.lastUsed > IDLE_MS).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, g] of unused.slice(0, Math.max(0, unused.length - keep))) {
      g.dispose();
      this.geos.delete(key);
      this.builds.delete(key);
    }
  }

  get pending() {
    return this.queue.length + this.inflight.size;
  }

  private build(app: HumanoidAppearance, priority: number): Promise<CharacterBuild> {
    return new Promise((resolve, reject) => {
      const job: Job = { id: this.nextId++, app, priority, resolve, reject };
      if (this.noWorkers) this.runMain(job);
      else {
        this.queue.push(job);
        this.pump();
      }
    });
  }

  private pump() {
    while (this.idle.length && this.queue.length) {
      this.queue.sort((a, b) => a.priority - b.priority);
      const job = this.queue.shift()!;
      const w = this.idle.pop()!;
      this.inflight.set(job.id, job);
      (job as Job & { worker?: Worker }).worker = w;
      w.postMessage({ id: job.id, app: job.app });
    }
  }

  private onMessage(w: Worker, data: { id?: number; build?: CharacterBuild; error?: string; type?: string }) {
    if (data.type === 'ready') return;
    const job = this.inflight.get(data.id!);
    this.idle.push(w);
    if (job) {
      this.inflight.delete(job.id);
      if (data.error) {
        console.error('[humanoid] build failed', data.error);
        job.reject(new Error(data.error));
      } else {
        this.stats.builds++;
        this.stats.avgMs = this.stats.avgMs * 0.9 + (data.build!.ms) * 0.1;
        job.resolve(data.build!);
      }
    }
    this.pump();
  }

  private async runMain(job: Job) {
    try {
      const as = await this.assetsP;
      await new Promise((r) => setTimeout(r, 0));
      job.resolve(buildCharacter(as, job.app));
    } catch (e) {
      job.reject(e);
    }
  }

  private flushToMainThread() {
    const jobs = [...this.queue, ...this.inflight.values()];
    this.queue = [];
    this.inflight.clear();
    for (const j of jobs) this.runMain(j);
  }
}
