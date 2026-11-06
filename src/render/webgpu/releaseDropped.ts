/**
 * WebGPU memory: three's WebGPURenderer keeps one render object per drawn mesh (per pass), and a
 * render object lives until its mesh or its material dispatches `dispose`. Disposing the mesh's
 * geometry does not end it (r186: it only forgets the attribute list), and taking the mesh out of
 * the scene does nothing at all. Each render object holds its mesh, so the mesh's geometry with its
 * vertex arrays (kept on the CPU too under WebGPU, see gpuOnly.ts) and its bind groups stayed alive
 * for the whole session. The WebGL renderer has no such list, so the same game code was fine there.
 *
 * PC 2026-11-06 (tools/memwatch.cjs, size 1, a teleport every 6 s): WebGPU went from 1.3 to 11.9 GB
 * of the page's memory in 2.5 minutes (render objects of meshes out of the scene 483 → 3942:
 * streamed terrain, ground, facades, water, clumps, props), then "Array buffer allocation failed".
 * WebGL stayed flat at 1.0–1.7 GB.
 *
 * So, on the WebGPU path:
 * - a render object ends when its geometry is disposed (city cells, terrain and water tiles do that
 *   when they stream out), and
 * - every 10 s, render objects not drawn since the last sweep whose mesh is no longer in a scene
 *   end too (meshes dropped without a dispose, with shared geometry or none of their own). If no
 *   other render object uses such a geometry any more, the renderer's strong reference to it (its
 *   dispose-listener map) is dropped, so the geometry and its buffers go with the garbage collector
 *   once the game lets go of it; a mesh put back still finds its buffers. (Dispatching `dispose`
 *   instead, to free the buffers at once, broke meshes put back: their vertex buffers were gone.)
 * - An ended render object releases its pipeline when it was its last user; three then forgets the
 *   compiled shader, and the next mesh of that kind would compile it again (a hitch, against the
 *   shader budget). Released pipelines and programs are kept on a list of the most recent instead
 *   and only really freed when pushed off its end.
 *
 * Internals (r186): `_objects` (RenderObjects: `_renderObjects`, `get`, `createRenderObject`),
 * `_pipelines` (`_releasePipeline`, `_releaseProgram`).
 */
import type * as THREE from 'three/webgpu';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Released pipelines and programs kept compiled (most recently released last). */
const KEEP_PIPELINES = 256, KEEP_PROGRAMS = 512;
const SWEEP_MS = 10_000;

/** What was released and kept, and what the sweeps ended (dev: `releaseStats()`). */
export const releaseStats = { ended: 0, swept: 0, geometriesFreed: 0, sweeps: 0, lastSweepMs: 0 };

export function releaseDroppedRenderObjects(renderer: THREE.WebGPURenderer): boolean {
  const r = renderer as Any, objects = r._objects, pipelines = r._pipelines;
  if (!objects?._renderObjects || typeof objects.get !== 'function' || typeof objects.createRenderObject !== 'function') return false;
  if (typeof pipelines?._releasePipeline !== 'function' || typeof pipelines._releaseProgram !== 'function') return false;
  if (objects.releasesDropped) return true;
  // (Debug: &rdo=off | geo (end with geometry only) | sweep (sweep only) | nofree (no geometry freeing) | nokeep.)
  const url = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.name ?? location.href;
  const mode = new URL(url).searchParams.get('rdo') ?? '';
  if (mode === 'off') return true;
  objects.releasesDropped = true;
  objects.releaseStats = releaseStats;
  if (mode !== 'nokeep') keepReleasedCompiles(pipelines);

  let tick = 0;
  const hook = (ro: Any): void => {
    const g = ro.geometry;
    if (ro.endsWith === g) return;
    if (ro.endsWith) ro.endsWith.removeEventListener('dispose', ro.endOnGeometry);
    ro.endsWith = g;
    // (After the geometry's other dispose listeners: three's own frees the buffers through this render object.)
    if (!ro.endOnGeometry) ro.endOnGeometry = () => queueMicrotask(() => { if (!ro.ended) { releaseStats.ended++; ro.dispose(); } });
    g?.addEventListener('dispose', ro.endOnGeometry);
  };

  const create = objects.createRenderObject;
  objects.createRenderObject = function (this: Any, ...a: unknown[]) {
    const ro = create.apply(this, a);
    const onDispose = ro.onDispose;
    ro.onDispose = () => {
      if (ro.ended) return;
      ro.ended = true;
      ro.endsWith?.removeEventListener('dispose', ro.endOnGeometry);
      ro.endsWith = null;
      onDispose();
    };
    return ro;
  };

  const get = objects.get;
  objects.get = function (this: Any, ...a: unknown[]) {
    const ro = get.apply(this, a);
    ro.seen = tick;
    if (mode !== 'sweep') hook(ro);
    return ro;
  };

  const listeners: Map<unknown, unknown> | undefined = r._geometries?._geometryDisposeListeners;
  const inScene = (o: Any): boolean => { while (o.parent) o = o.parent; return o.isScene === true; };
  const sweep = (): void => {
    const t0 = performance.now();
    const ended = new Set<Any>();
    for (const ro of [...objects._renderObjects]) {
      if (ro.seen !== undefined && ro.seen >= tick) continue;
      if (inScene(ro.object)) continue;
      ended.add(ro.geometry);
      ro.dispose();
      releaseStats.swept++;
    }
    if (ended.size && mode !== 'nofree' && listeners) {
      for (const ro of objects._renderObjects) ended.delete(ro.geometry);
      for (const g of ended) if (g && listeners.delete(g)) releaseStats.geometriesFreed++;
    }
    tick++;
    releaseStats.sweeps++;
    releaseStats.lastSweepMs = +(performance.now() - t0).toFixed(2);
  };
  objects.sweepNow = sweep;
  // One clock for the renderer's life (the creator's preview renderer is dropped when it closes).
  const ref = new WeakRef(renderer);
  const id = setInterval(() => { if (mode === 'geo') return; if (ref.deref()) sweep(); else clearInterval(id); }, SWEEP_MS);
  return true;
}

/**
 * Released pipelines and programs stay compiled until KEEP_* newer ones push them out. (Not node
 * builds: a node build owns its material's shared bind groups, which three frees together with the
 * last render object using them; a kept build would hand the next mesh freed uniform buffers. The
 * PC showed bare grey ground, no trees, a black screen. A rebuilt node build makes the same shader
 * code, so it finds its program and pipeline here.)
 */
function keepReleasedCompiles(pipelines: Any): void {
  const keep = <T>(cap: number, free: (x: T) => void, unused: (x: T) => boolean) => {
    const list = new Map<T, true>();
    return (x: T): void => {
      list.delete(x);
      list.set(x, true);
      while (list.size > cap) {
        const old = list.keys().next().value as T;
        list.delete(old);
        if (unused(old)) free(old);
      }
    };
  };
  const releasePipeline = pipelines._releasePipeline, releaseProgram = pipelines._releaseProgram;
  const pipe = keep<Any>(KEEP_PIPELINES, (p) => releasePipeline.call(pipelines, p), (p) => p.usedTimes === 0);
  const prog = keep<Any>(KEEP_PROGRAMS, (p) => releaseProgram.call(pipelines, p), (p) => p.usedTimes === 0);
  pipelines._releasePipeline = (p: Any) => pipe(p);
  pipelines._releaseProgram = (p: Any) => prog(p);
}
