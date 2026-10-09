/**
 * Sentence vectors from the small sentence model (all-MiniLM-L6-v2, int8, public/models/minilm):
 * word pieces in, the mean of the last hidden layer over the real tokens out, scaled to length 1,
 * so the dot product of two vectors is how close the two sentences are in meaning (−1..1).
 *
 * The ONNX runtime is passed in (the browser worker loads onnxruntime-web's wasm build, the self
 * test the same package in Node), so this file has no DOM and no loader of its own.
 */
import type * as Ort from 'onnxruntime-web';
import { WordPiece } from './wordpiece';

export const DIM = 384;

export class SentenceModel {
  private constructor(private ort: typeof Ort, private session: Ort.InferenceSession, private wp: WordPiece) {}

  static async create(ort: typeof Ort, model: Uint8Array, vocab: string): Promise<SentenceModel> {
    const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    return new SentenceModel(ort, session, new WordPiece(vocab));
  }

  /** One unit vector per sentence (DIM floats each, packed). Sentences are padded to the longest in the batch. */
  async embed(texts: readonly string[]): Promise<Float32Array> {
    const out = new Float32Array(texts.length * DIM);
    if (!texts.length) return out;
    const enc = texts.map((t) => this.wp.encode(t));
    const len = Math.max(...enc.map((e) => e.length));
    const n = texts.length;
    const ids = new BigInt64Array(n * len), mask = new BigInt64Array(n * len), types = new BigInt64Array(n * len);
    enc.forEach((e, i) => e.forEach((id, j) => { ids[i * len + j] = BigInt(id); mask[i * len + j] = 1n; }));
    const T = this.ort.Tensor;
    const res = await this.session.run({
      input_ids: new T('int64', ids, [n, len]),
      attention_mask: new T('int64', mask, [n, len]),
      token_type_ids: new T('int64', types, [n, len]),
    });
    const h = res.last_hidden_state.data as Float32Array;
    for (let i = 0; i < n; i++) {
      const m = enc[i].length, o = out.subarray(i * DIM, (i + 1) * DIM);
      for (let j = 0; j < m; j++) {
        const base = (i * len + j) * DIM;
        for (let d = 0; d < DIM; d++) o[d] += h[base + d];
      }
      let s = 0;
      for (let d = 0; d < DIM; d++) s += o[d] * o[d];
      s = Math.sqrt(s) || 1;
      for (let d = 0; d < DIM; d++) o[d] /= s;
    }
    for (const k in res) res[k].dispose?.();
    return out;
  }
}
