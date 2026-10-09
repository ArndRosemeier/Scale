/**
 * The sentence model for the browser (typed NPC chat): a worker (embed.worker.ts) started the
 * first time someone talks to a person, so nobody pays for it (about 22 MB of model and 14 MB of
 * runtime, cached by the browser) before they use the chat. Until it is ready, and if it fails,
 * `embed` answers null and the chat understands by patterns and word overlap (understand.ts).
 */
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import type { Embedder } from './understand';

export class WorkerEmbedder implements Embedder {
  private w: Worker | null = null;
  private ready: Promise<boolean> | null = null;
  private waiting = new Map<number, (v: Float32Array | null) => void>();
  private next = 1;
  /** Set when loading failed (the chat then stays on patterns and words). */
  failed = false;

  /** Start loading (idempotent); true once the model answers. */
  start(): Promise<boolean> {
    this.ready ??= new Promise<boolean>((resolve) => {
      try {
        const w = new Worker(new URL('./embed.worker.ts', import.meta.url), { type: 'module' });
        this.w = w;
        w.onmessage = (e: MessageEvent) => {
          const m = e.data as { type: string; id?: number; v?: Float32Array; message?: string };
          if (m.type === 'ready') resolve(true);
          else if (m.type === 'vecs' && m.id) { this.waiting.get(m.id)?.(m.v ?? null); this.waiting.delete(m.id); }
          else if (m.type === 'error') {
            if (m.id) { this.waiting.get(m.id)?.(null); this.waiting.delete(m.id); }
            else { this.failed = true; console.warn('[chat] sentence model unavailable:', m.message); resolve(false); }
          }
        };
        w.onerror = () => { this.failed = true; resolve(false); };
        w.postMessage({ type: 'init', base: `${import.meta.env.BASE_URL}models/minilm/`, wasm: new URL(wasmUrl, location.href).href });
      } catch { this.failed = true; resolve(false); }
    });
    return this.ready;
  }

  async embed(texts: readonly string[]): Promise<Float32Array | null> {
    if (!(await this.start()) || !this.w) return null;
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.w!.postMessage({ type: 'embed', id, texts: [...texts] });
    });
  }
}
