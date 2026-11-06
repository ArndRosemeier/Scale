/**
 * Memory check for the admin console: what the page holds now, and a garbage collection on demand,
 * to tell garbage that simply was not collected yet from memory that is really held.
 *
 * A page cannot start a collection itself. With Chrome started with `--js-flags=--expose-gc` there is
 * `window.gc()` (a full collection). Otherwise the collector is pushed into one: short-lived buffers
 * of a few hundred MB make V8 run a full mark-compact for the external memory, which also finalizes
 * GPU buffers and textures nothing refers to any more (the GPU process frees them a moment later).
 * DevTools' "Collect garbage" button (Performance or Memory panel) is the exact equivalent.
 */
import type { Game } from '../game/Game';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const mb = (b: number): number => Math.round(b / 1048576);

/** One line of numbers: JS heap, renderer counters, and on WebGPU the render objects and release counters. */
export function memoryReport(game: Game): Record<string, unknown> {
  const pm = (performance as Any).memory;
  const gl = game.renderer.gl as Any;
  const out: Record<string, unknown> = {
    jsHeapMB: pm ? mb(pm.usedJSHeapSize) : 'n/a',
    jsHeapLimitMB: pm ? mb(pm.jsHeapSizeLimit) : 'n/a',
    geometries: gl.info?.memory?.geometries,
    textures: gl.info?.memory?.textures,
    renderer: game.renderer.webgpu ? 'webgpu' : 'webgl',
  };
  const ros: Set<Any> | undefined = gl._objects?._renderObjects;
  if (ros) {
    let detached = 0;
    for (const ro of ros) { let o = ro.object; while (o.parent) o = o.parent; if (!o.isScene) detached++; }
    out.renderObjects = ros.size;
    out.notInScene = detached;
    out.released = gl._objects.releaseStats;
  }
  return out;
}

/** A full garbage collection (or as close as a page gets), then the report before and after. */
export async function forceGc(game: Game): Promise<Record<string, unknown>> {
  const before = memoryReport(game);
  const gc = (globalThis as Any).gc as (() => void) | undefined;
  let how: string;
  if (typeof gc === 'function') {
    gc();
    how = 'window.gc()';
  } else {
    // External memory pressure: 4 × 64 MB, touched so they are really allocated, then dropped.
    for (let round = 0; round < 3; round++) {
      let hold: Uint8Array[] | null = [];
      for (let i = 0; i < 4; i++) { const a = new Uint8Array(64 << 20); a[a.length - 1] = 1; hold.push(a); }
      hold = null;
      await new Promise((r) => setTimeout(r, 300));
    }
    how = 'memory pressure (start Chrome with --js-flags=--expose-gc for an exact one)';
  }
  // Give finalizers (GPU buffers, textures) a moment.
  await new Promise((r) => setTimeout(r, 1500));
  const after = memoryReport(game);
  return { how, heapMB: `${before.jsHeapMB} → ${after.jsHeapMB}`, after };
}
