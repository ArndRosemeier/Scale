/**
 * Resource budgets: one table of device-dependent limits (worker counts, cache sizes,
 * decoded-audio residency, particle density) derived from `platform`. Modules read
 * their limit here instead of hard-coding it, so a device class is tuned in one place.
 *
 * Why tablets get much smaller numbers than desktops: iPadOS kills a Safari tab
 * (the whole page, workers included) well before the device's RAM is used up — on
 * 4–8 GB iPads the practical ceiling is roughly 1–1.5 GB for everything. Decoded music,
 * terrain collision grids and chunk meshes are the big consumers we control.
 *
 * Values are read at use time (not copied at import), so workers can switch class
 * with `applyDeviceClass` after their init message (they cannot detect the device:
 * no screen / touch info inside a worker).
 */
// Scale is desktop-only: a minimal platform stand-in for the borrowed Norgo budgets table.
const platform = {
  info: { cores: (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 8, touch: false, mobileUA: false, screenMin: 1080, memoryGB: 16 } as Record<string, any>,
  note(_k: string, _v: unknown): void {},
};

export type DeviceClass = 'desktop' | 'desktop-low' | 'tablet' | 'phone';

export interface Budgets {
  deviceClass: DeviceClass;
  /** Terrain chunk workers (`ChunkWorkerPool`). Each holds a full WorldGenerator. */
  chunkWorkers: number;
  /** Humanoid body-build workers (`BodyService`). */
  bodyWorkers: number;
  /** Terrain chunk entries kept by the streamer (meshes + scatter) before LRU trimming. */
  chunkCache: number;
  /** Full-resolution density grids for collision (≈ 233 KB each). */
  colliderGrids: number;
  /** Decoded stem sets resident at once (a set is ≈ 60–90 MB of float PCM). */
  stemSets: number;
  /** Hard cap on decoded stem bytes. */
  stemBytes: number;
  /** Melody variations kept per set. */
  stemMelodies: number;
  /** Concurrent stem fetch+decode jobs (decoding spikes memory: compressed + PCM). */
  stemLoads: number;
  /** Apparel pattern canvas textures (256² RGBA + mips ≈ 350 KB each). */
  patternTextures: number;
  /** Building blueprints (piece lists) cached per realm (client and server worker). */
  blueprintCache: number;
  /** POI structure blueprints cached per realm. */
  poiCache: number;
  /** Settlement layouts kept by the client renderer. */
  settlementLayouts: number;
  /** Server: chunk object-record cache (ObjectSystem). */
  objectChunks: number;
  /** Upper bound for devicePixelRatio before the render-scale setting applies. */
  maxPixelRatio: number;
  /** Weather particle density multiplier. */
  weatherParticles: number;
}

const MB = 1024 * 1024;
const clampI = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

function table(c: DeviceClass, cores: number): Budgets {
  switch (c) {
    case 'tablet':
      return {
        deviceClass: c, chunkWorkers: clampI(cores - 2, 2, 3), bodyWorkers: 1, chunkCache: 900, colliderGrids: 140,
        stemSets: 2, stemBytes: 130 * MB, stemMelodies: 1, stemLoads: 1, patternTextures: 24, blueprintCache: 400,
        poiCache: 120, settlementLayouts: 24, objectChunks: 260, maxPixelRatio: 1.5, weatherParticles: 0.6,
      };
    case 'phone':
      return {
        deviceClass: c, chunkWorkers: 2, bodyWorkers: 1, chunkCache: 700, colliderGrids: 110,
        stemSets: 2, stemBytes: 100 * MB, stemMelodies: 1, stemLoads: 1, patternTextures: 16, blueprintCache: 300,
        poiCache: 100, settlementLayouts: 16, objectChunks: 200, maxPixelRatio: 1.5, weatherParticles: 0.5,
      };
    case 'desktop-low':
      return {
        deviceClass: c, chunkWorkers: clampI(cores - 1, 2, 3), bodyWorkers: 1, chunkCache: 1200, colliderGrids: 180,
        stemSets: 3, stemBytes: 200 * MB, stemMelodies: 2, stemLoads: 2, patternTextures: 40, blueprintCache: 700,
        poiCache: 200, settlementLayouts: 32, objectChunks: 360, maxPixelRatio: 1.5, weatherParticles: 0.8,
      };
    default:
      return {
        deviceClass: 'desktop', chunkWorkers: clampI(cores - 2, 2, 8), bodyWorkers: clampI(cores >> 2, 1, 3), chunkCache: 1600,
        colliderGrids: 220, stemSets: 3, stemBytes: 240 * MB, stemMelodies: 2, stemLoads: 2, patternTextures: 48,
        blueprintCache: 900, poiCache: 300, settlementLayouts: 40, objectChunks: 420, maxPixelRatio: 1.5, weatherParticles: 1,
      };
  }
}

/** Device class from the platform: form factor first, then hardware hints for desktops. */
export function detectDeviceClass(): DeviceClass {
  // Workers and Node tools can't see the device: keep the desktop table until told otherwise.
  if (typeof window === 'undefined') return 'desktop';
  const i = platform.info;
  if (i.formFactor === 'tablet') return 'tablet';
  if (i.formFactor === 'phone') return 'phone';
  // deviceMemory is Chromium-only (and capped at 8); cores is a coarse but universal hint.
  if ((i.memoryGB !== undefined && i.memoryGB <= 4) || i.cores <= 4) return 'desktop-low';
  return 'desktop';
}

/** The live budget table (mutated in place by `applyDeviceClass`). */
export const budgets: Budgets = table(detectDeviceClass(), platform.info.cores);

/** Switch the device class (workers call this with the class the main thread sent them). */
export function applyDeviceClass(c: DeviceClass, cores = platform.info.cores): void {
  Object.assign(budgets, table(c, cores));
}

platform.note('budgets', budgets);
