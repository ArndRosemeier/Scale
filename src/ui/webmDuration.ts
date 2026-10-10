/**
 * MediaRecorder writes WebM as a live stream: the file has no duration, so players show no
 * length and seek badly. This writes the duration into the file's Segment > Info (patching only
 * the first bytes; the clusters are copied as they are). Anything unexpected: the clip as it was.
 */

const ID_EBML = 0x1a45dfa3, ID_SEGMENT = 0x18538067, ID_INFO = 0x1549a966, ID_CLUSTER = 0x1f43b675;
const ID_SCALE = 0x2ad7b1, ID_DURATION = 0x4489;
const HEAD = 64 * 1024;

interface Vint { value: number; len: number; unknown: boolean }

/** An element id (marker bits kept). */
function readId(b: Uint8Array, p: number): Vint | null {
  const len = vlen(b[p]);
  if (!len || len > 4 || p + len > b.length) return null;
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[p + i];
  return { value: v, len, unknown: false };
}

/** An element size (marker bit dropped; all ones = unknown size). */
function readSize(b: Uint8Array, p: number): Vint | null {
  const len = vlen(b[p]);
  if (!len || p + len > b.length) return null;
  let v = b[p] & (0xff >> len), ones = v === 0xff >> len;
  for (let i = 1; i < len; i++) { v = v * 256 + b[p + i]; ones &&= b[p + i] === 0xff; }
  return { value: v, len, unknown: ones };
}

function vlen(first: number | undefined): number {
  if (!first) return 0;
  let len = 1;
  for (let m = 0x80; !(first & m); m >>= 1) len++;
  return len;
}

/** The blob with its duration written in (ms), or the blob itself when that is not possible. */
export async function withWebmDuration(blob: Blob, ms: number): Promise<Blob> {
  try {
    const head = new Uint8Array(await blob.slice(0, HEAD).arrayBuffer());
    const out = patch(head, ms);
    return out ? new Blob([out as BlobPart, blob.slice(HEAD)], { type: blob.type }) : blob;
  } catch {
    return blob;
  }
}

function patch(b: Uint8Array, ms: number): Uint8Array | null {
  let id = readId(b, 0);
  if (!id || id.value !== ID_EBML) return null;
  let size = readSize(b, id.len);
  if (!size || size.unknown) return null;
  let p = id.len + size.len + size.value;
  id = readId(b, p);
  if (!id || id.value !== ID_SEGMENT) return null;
  size = readSize(b, p + id.len);
  if (!size) return null;
  p += id.len + size.len;
  // The Segment's children up to the first cluster: find Info.
  for (;;) {
    const cid = readId(b, p);
    if (!cid || cid.value === ID_CLUSTER) return null;
    const cs = readSize(b, p + cid.len);
    if (!cs || cs.unknown) return null;
    const start = p + cid.len + cs.len, end = start + cs.value;
    if (end > b.length) return null;
    if (cid.value === ID_INFO) return patchInfo(b, p, start, end, ms);
    p = end;
  }
}

function patchInfo(b: Uint8Array, at: number, start: number, end: number, ms: number): Uint8Array | null {
  let scale = 1e6;
  let dur: { p: number; len: number } | null = null;
  for (let p = start; p < end;) {
    const id = readId(b, p);
    const s = id && readSize(b, p + id.len);
    if (!id || !s || s.unknown) return null;
    const data = p + id.len + s.len;
    if (id.value === ID_SCALE) { scale = 0; for (let i = 0; i < s.value; i++) scale = scale * 256 + b[data + i]; }
    if (id.value === ID_DURATION) dur = { p: data, len: s.value };
    p = data + s.value;
  }
  if (!scale) return null;
  const value = (ms * 1e6) / scale;
  if (dur) {
    const out = b.slice();
    const v = new DataView(out.buffer, dur.p, dur.len);
    if (dur.len === 8) v.setFloat64(0, value);
    else if (dur.len === 4) v.setFloat32(0, value);
    else return null;
    return out;
  }
  // No Duration yet: a new Info with one appended (its size written as an 8-byte vint). The
  // recorder's segment has an unknown size and no seek index, so nothing else needs to move.
  const children = b.subarray(start, end);
  const el = new Uint8Array(11);
  el.set([0x44, 0x89, 0x88]);
  new DataView(el.buffer).setFloat64(3, value);
  const n = children.length + el.length;
  const info = new Uint8Array(4 + 8 + n);
  info.set([0x15, 0x49, 0xa9, 0x66, 0x01]);
  for (let i = 0, v = n; i < 7; i++, v = Math.floor(v / 256)) info[11 - i] = v & 0xff;
  info.set(children, 12);
  info.set(el, 12 + children.length);
  const out = new Uint8Array(at + info.length + (b.length - end));
  out.set(b.subarray(0, at));
  out.set(info, at);
  out.set(b.subarray(end), at + info.length);
  return out;
}
