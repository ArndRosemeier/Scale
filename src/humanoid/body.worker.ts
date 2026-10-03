/**
 * Body worker: builds characters (morph, skeleton, hair, add-ons) off the
 * main thread. Protocol: { id, app } → { id, build } | { id, error }.
 */
import { loadHumanAssets } from './assets';
import { buildCharacter, buildTransfers } from './characterBuild';
import type { HumanoidAppearance } from './types';

const ctx = self as unknown as { postMessage(m: unknown, t?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };

ctx.onmessage = async (e: MessageEvent<{ id: number; app: HumanoidAppearance }>) => {
  const { id, app } = e.data;
  try {
    const as = await loadHumanAssets();
    const build = buildCharacter(as, app);
    // The morph-space arrays are not needed on the main thread.
    build.body.pos = new Float32Array(0);
    build.body.normal = new Float32Array(0);
    ctx.postMessage({ id, build }, buildTransfers(build));
  } catch (err) {
    ctx.postMessage({ id, error: String((err as Error)?.stack ?? err) });
  }
};
ctx.postMessage({ type: 'ready' });
