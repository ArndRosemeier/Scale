/// <reference lib="webworker" />
/**
 * The sentence model's worker (typed NPC chat): loads onnxruntime's wasm build and
 * all-MiniLM-L6-v2 (public/models/minilm) once, then turns batches of sentences into vectors
 * (embedCore.ts). Off the main thread, so neither loading nor the example vectors cost a frame.
 */
import * as ort from 'onnxruntime-web/wasm';
import { SentenceModel } from './embedCore';

let model: Promise<SentenceModel> | null = null;

function load(base: string, wasm: string): Promise<SentenceModel> {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = { wasm };
  return Promise.all([
    fetch(`${base}model_q8.onnx`).then((r) => { if (!r.ok) throw new Error(`model ${r.status}`); return r.arrayBuffer(); }),
    fetch(`${base}vocab.txt`).then((r) => { if (!r.ok) throw new Error(`vocab ${r.status}`); return r.text(); }),
  ]).then(([m, v]) => SentenceModel.create(ort, new Uint8Array(m), v));
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data as { type: 'init'; base: string; wasm: string } | { type: 'embed'; id: number; texts: string[] };
  try {
    if (m.type === 'init') {
      model ??= load(m.base, m.wasm);
      await model;
      (self as unknown as Worker).postMessage({ type: 'ready' });
      return;
    }
    if (!model) throw new Error('not initialised');
    const v = await (await model).embed(m.texts);
    (self as unknown as Worker).postMessage({ type: 'vecs', id: m.id, v }, [v.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', id: (m as { id?: number }).id, message: String(err) });
  }
};
