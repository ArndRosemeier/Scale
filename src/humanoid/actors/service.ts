/**
 * The Actors character library (github.com/ArndRosemeier/Actors) behind every person in the
 * game: loads its human pack once (public/packs, `npm run packs`), shapes bodies in a small pool
 * of Web Workers, and hands out `@actors/generator` characters that share the loaded pack.
 *
 * Main-thread cost of a new character is mostly writing its shape into GPU buffers when the
 * worker's result arrives; at most `MAX_LOADING` characters are on their way at a time, highest
 * priority first, so a street filling with people spreads over frames.
 */
import { Character as ActorCharacter, type CharacterCatalog, type CharacterPatch } from '@actors/generator';
import type { ActorMaterialKit } from '@actors/three';
import { WEBGPU } from '../../render/gpuMode';
import { budgets } from '../../core/budgets';

/** The Actors shape worker (loaded on first use: headless tests import this module without workers). */
export async function humanWorker(): Promise<new () => Worker> {
  return (await import('@actors/human/worker?worker')).default;
}

/** No Web Workers (headless tests): no Actors bodies are built; people keep their placeholder. */
export const HEADLESS = typeof Worker === 'undefined';

/** URL of the human pack's manifest (served from public/packs). */
export function packUrl(): string {
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return `${base}packs/human/manifest.json`;
}

/** Characters of city people: only CC0 assets (CC-BY garments and hairstyles would need a credit wherever they are seen). */
export function cc0Catalog(c: CharacterCatalog): CharacterCatalog {
  return { ...c, garments: c.garments.filter((g) => !g.credit), hair: c.hair.filter((h) => !h.credit) };
}

interface Request {
  patch: CharacterPatch;
  priority: number;
  renderer: unknown;
  catalog?: (c: CharacterCatalog) => CharacterCatalog;
  resolve: (c: ActorCharacter) => void;
  reject: (e: unknown) => void;
}

/** Characters being loaded at once (each one's shape lands on the main thread in one piece). */
const MAX_LOADING = 2;

class ActorService {
  private leadsP: Promise<ActorCharacter[]> | null = null;
  private kitP: Promise<ActorMaterialKit | undefined> | null = null;
  private next = 0;
  private queue: Request[] = [];
  private loading = 0;
  /** The game's renderer (photo skins are blended with it; set by Game). */
  renderer: unknown = null;
  /** Diagnostics. */
  readonly stats = { built: 0, failed: 0, ms: 0 };

  /** The material kit for the renderer in use: WebGL materials, or node materials on `?gpu=webgpu`. */
  kit(): Promise<ActorMaterialKit | undefined> {
    return (this.kitP ??= WEBGPU ? import('@actors/three/webgpu').then((m) => m.nodeMaterials) : Promise.resolve(undefined));
  }

  /** Loads the pack (once) and starts the worker pool; resolves to its leads. */
  ready(): Promise<ActorCharacter[]> {
    if (!this.leadsP) {
      this.leadsP = (async () => {
        if (HEADLESS) throw new Error('no Web Workers');
        const materials = await this.kit();
        const HumanWorker = await humanWorker();
        const n = Math.max(1, Math.min(3, budgets.bodyWorkers));
        const first = await ActorCharacter.load({ pack: packUrl(), renderer: null, materials, worker: new HumanWorker(), clipLibraries: false, config: { skin: 'procedural', blink: false } });
        const leads = [first];
        for (let i = 1; i < n; i++) leads.push(await ActorCharacter.load({ pack: packUrl(), shareWith: first, renderer: null, worker: new HumanWorker(), config: { skin: 'procedural', blink: false } }));
        return leads;
      })();
      this.leadsP.catch((e) => {
        if (HEADLESS) return;
        console.error('[actors] the human pack failed to load (npm run packs?)', e);
        this.leadsP = null;
      });
    }
    return this.leadsP;
  }

  /** A whole catalog, for UIs (the creator narrows nothing). */
  async catalog(): Promise<CharacterCatalog> {
    return (await this.ready())[0].catalog;
  }

  /**
   * A new character showing `patch` (resolves once its shape, outfit and hair are on).
   * Lower `priority` values load sooner.
   */
  character(patch: CharacterPatch, priority = 0, opts: { renderer?: unknown; catalog?: (c: CharacterCatalog) => CharacterCatalog } = {}): Promise<ActorCharacter> {
    return new Promise((resolve, reject) => {
      this.queue.push({ patch, priority, renderer: opts.renderer ?? this.renderer, catalog: opts.catalog ?? cc0Catalog, resolve, reject });
      this.pump();
    });
  }

  /** Requests waiting or loading (diagnostics). */
  get pending(): number {
    return this.queue.length + this.loading;
  }

  private pump(): void {
    while (this.loading < MAX_LOADING && this.queue.length) {
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) if (this.queue[i].priority < this.queue[best].priority) best = i;
      const req = this.queue.splice(best, 1)[0];
      this.loading++;
      const t0 = performance.now();
      this.ready()
        .then((leads) => ActorCharacter.load({ pack: packUrl(), shareWith: leads[this.next++ % leads.length], renderer: req.renderer, catalog: req.catalog, config: req.patch }))
        .then(
          (c) => {
            this.stats.built++;
            this.stats.ms += performance.now() - t0;
            req.resolve(c);
          },
          (e) => {
            this.stats.failed++;
            req.reject(e);
          },
        )
        .finally(() => {
          this.loading--;
          this.pump();
        });
    }
  }
}

export const actors = new ActorService();
if (typeof window !== 'undefined') (window as unknown as { scaleActors?: ActorService }).scaleActors = actors;
