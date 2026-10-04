/// <reference lib="webworker" />
/**
 * The deep realm's mesher in its own thread: `init` with the plan (and the chamber boxes the realm
 * opens into), then `chunks` (the list of chunks worth building) and `build` per chunk; geometry
 * comes back as transferable arrays.
 */
import { Mesher, type SkipBox } from './mesher';
import type { DeepPlan } from './plan';

let mesher: Mesher | null = null;

self.onmessage = (e: MessageEvent) => {
  const m = e.data as { type: 'init'; plan: DeepPlan; skip: SkipBox[] } | { type: 'chunks' } | { type: 'build'; i: number; j: number; k: number };
  try {
    if (m.type === 'init') { mesher = new Mesher(m.plan, m.skip); return; }
    if (!mesher) return;
    if (m.type === 'chunks') { (self as unknown as Worker).postMessage({ type: 'chunks', list: mesher.chunks() }); return; }
    if (m.type === 'build') {
      const t0 = performance.now();
      const d = mesher.build(m.i, m.j, m.k);
      (self as unknown as Worker).postMessage({ type: 'chunk', data: d, ms: performance.now() - t0 }, [d.pos.buffer, d.nor.buffer, d.col.buffer, d.glow.buffer, d.idx.buffer, d.epos.buffer, d.ecol.buffer, d.eidx.buffer]);
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', message: String(err) });
  }
};
