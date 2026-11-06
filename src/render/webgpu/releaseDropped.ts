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
 *   other render object uses such a geometry any more, its GPU buffers are freed as well (the CPU
 *   copy stays, so a mesh put back simply uploads it again).
 * - An ended render object releases its pipeline and node build when it was their last user; three
 *   then forgets the compiled shader, and the next mesh of that kind would compile it again (a
 *   hitch, against the shader budget). Released ones are kept on a list of the most recent instead
 *   and only really freed when pushed off its end.
 *
 * Internals (r186): `_objects` (RenderObjects: `_renderObjects`, `get`, `createRenderObject`),
 * `_pipelines` (`_releasePipeline`, `_releaseProgram`), `_nodes.nodeBuilderCache`.
 */
import type * as THREE from 'three/webgpu';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Released pipelines, programs and node builds kept compiled (most recently released last). */
const KEEP_PIPELINES = 256, KEEP_PROGRAMS = 512, KEEP_NODE_BUILDS = 160;
const SWEEP_MS = 10_000;

/** What was released and kept, and what the sweeps ended (dev: `releaseStats()`). */
export const releaseStats = { ended: 0, swept: 0, geometriesFreed: 0, sweeps: 0, lastSweepMs: 0 };

export function releaseDroppedRenderObjects(renderer: THREE.WebGPURenderer): boolean {
  const r = renderer as Any, objects = r._objects, pipelines = r._pipelines, nodes = r._nodes;
  if (!objects?._renderObjects || typeof objects.get !== 'function' || typeof objects.createRenderObject !== 'function') return false;
  if (typeof pipelines?._releasePipeline !== 'function' || typeof pipelines._releaseProgram !== 'function' || !(nodes?.nodeBuilderCache instanceof Map)) return false;
  if (objects.releasesDropped) return true;
  objects.releasesDropped = true;
  objects.releaseStats = releaseStats;
  keepReleasedCompiles(pipelines, nodes);

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
    hook(ro);
    return ro;
  };

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
    if (ended.size) {
      for (const ro of objects._renderObjects) ended.delete(ro.geometry);
      for (const g of ended) if (g && freeable(g)) { g.dispatchEvent({ type: 'dispose' }); releaseStats.geometriesFreed++; }
    }
    tick++;
    releaseStats.sweeps++;
    releaseStats.lastSweepMs = +(performance.now() - t0).toFixed(2);
  };
  // One clock for the renderer's life (the creator's preview renderer is dropped when it closes).
  const ref = new WeakRef(renderer);
  const id = setInterval(() => { if (ref.deref()) sweep(); else clearInterval(id); }, SWEEP_MS);
  return true;
}

/**
 * Geometry whose GPU buffers can be freed and uploaded again from the CPU copy: not one whose CPU
 * copy was dropped (gpuOnly), and not one the GPU writes itself (storage buffers, indirect draws).
 */
function freeable(g: Any): boolean {
  if (g.userData?.onGpu || g.indirect) return false;
  if (g.index && !g.index.array) return false;
  for (const k in g.attributes) {
    const a = g.attributes[k];
    if (a.isStorageBufferAttribute || a.isStorageInstancedBufferAttribute || !(a.array ?? a.data?.array)) return false;
  }
  return true;
}

/** Released pipelines, programs and node builds stay compiled until KEEP_* newer ones push them out. */
function keepReleasedCompiles(pipelines: Any, nodes: Any): void {
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
  // Node builds: three deletes the cache entry when the last render object using it ends.
  const cache: Map<unknown, Any> = nodes.nodeBuilderCache;
  const del = cache.delete.bind(cache);
  const build = keep<unknown>(KEEP_NODE_BUILDS, (k) => del(k), (k) => (cache.get(k)?.usedTimes ?? 0) === 0);
  cache.delete = (k: unknown) => { if (cache.has(k)) build(k); return true; };
}
