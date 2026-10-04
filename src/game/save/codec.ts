/**
 * Compact codecs for save data (pure, no DOM / three.js; tested in selftest.ts).
 *
 * Index sets (dead wall panels, shattered windows, broken slab tiles of a cell) are stored as
 * runs: for each run of consecutive indices the gap since the end of the previous run and the
 * run's length, both as LEB128 varints, the bytes as base64. A wall blown out of a building is a
 * handful of runs, so a heavily damaged cell of 100 k elements takes a few hundred bytes.
 */

/** Sorted, de-duplicated indices → run-length varint bytes → base64. */
export function encodeIndexSet(indices: ArrayLike<number>): string {
  const sorted = Array.from(indices).filter((v) => Number.isInteger(v) && v >= 0).sort((a, b) => a - b);
  const bytes: number[] = [];
  const varint = (v: number) => {
    while (v >= 0x80) { bytes.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    bytes.push(v);
  };
  let prevEnd = 0, i = 0;
  while (i < sorted.length) {
    const start = sorted[i];
    let end = start + 1;
    i++;
    while (i < sorted.length && sorted[i] <= end) { if (sorted[i] === end) end++; i++; }
    varint(start - prevEnd);
    varint(end - start);
    prevEnd = end;
  }
  return toBase64(Uint8Array.from(bytes));
}

/** Inverse of `encodeIndexSet` (bad input yields what could be read, never throws). */
export function decodeIndexSet(s: string): number[] {
  const out: number[] = [];
  if (!s) return out;
  let bytes: Uint8Array;
  try { bytes = fromBase64(s); } catch { return out; }
  let p = 0, prevEnd = 0;
  const varint = (): number => {
    let v = 0, mul = 1;
    while (p < bytes.length) {
      const b = bytes[p++];
      v += (b & 0x7f) * mul;
      if (!(b & 0x80)) return v;
      mul *= 128;
    }
    return -1;
  };
  while (p < bytes.length) {
    const gap = varint(), len = varint();
    if (gap < 0 || len < 0 || out.length + len > 1 << 26) break;
    const start = prevEnd + gap;
    for (let k = 0; k < len; k++) out.push(start + k);
    prevEnd = start + len;
  }
  return out;
}

/** Indices where a channel of interleaved element bytes (stride, offset) is below 128. */
export function lowIndices(data: Uint8Array, count: number, stride: number, offset: number, keep?: (i: number) => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) if (data[i * stride + offset] < 128 && (!keep || keep(i))) out.push(i);
  return out;
}

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
