/**
 * Worker-side mesh accumulation. Produces transferable typed arrays.
 */

export interface AttrSpec {
  name: string;
  size: number;
  /** Storage type of the output array. */
  type?: 'f32' | 'u8n' | 'u16' | 'i8n';
}

export interface MeshData {
  attrs: Record<string, { array: Float32Array | Uint8Array | Uint16Array | Int8Array; size: number; normalized: boolean }>;
  index: Uint32Array | Uint16Array;
  /** Local origin (world position of local (0,0,0)). */
  origin: [number, number, number];
  bounds: [number, number, number, number, number, number];
}

type Store = Float32Array | Uint8Array | Uint16Array | Int8Array;

/** Growable typed array of an attribute's final storage type (8-bit types quantised on write). */
class AttrBuf {
  arr: Store;
  n = 0;
  constructor(readonly type: NonNullable<AttrSpec['type']>, cap: number) { this.arr = this.alloc(cap); }
  private alloc(n: number): Store {
    return this.type === 'u8n' ? new Uint8Array(n) : this.type === 'i8n' ? new Int8Array(n) : this.type === 'u16' ? new Uint16Array(n) : new Float32Array(n);
  }
  reserve(k: number): void {
    if (this.n + k <= this.arr.length) return;
    const a = this.alloc(Math.max(this.n + k, this.arr.length * 2));
    a.set(this.arr.subarray(0, this.n));
    this.arr = a;
  }
  put(v: number): void {
    const t = this.type;
    this.arr[this.n++] = t === 'u8n' ? Math.max(0, Math.min(255, Math.round(v * 255))) : t === 'i8n' ? Math.max(-127, Math.min(127, Math.round(v * 127))) : v;
  }
  done(): Store { return this.arr.slice(0, this.n); }
}

/**
 * Accumulates vertices straight into typed arrays: a downtown cell has millions of values,
 * and plain number arrays (8+ bytes each plus growth slack, in every worker) cost gigabytes.
 */
export class MeshBuilder {
  readonly specs: AttrSpec[];
  private data: Record<string, AttrBuf> = {};
  private other: { s: AttrSpec; b: AttrBuf; c: number[] }[] = [];
  private idx = new Uint32Array(1024);
  private ni = 0;
  vcount = 0;
  ox = 0; oy = 0; oz = 0;
  /** Current values for constant-per-batch attributes. */
  cur: Record<string, number[]> = {};

  constructor(specs: AttrSpec[]) {
    this.specs = [{ name: 'position', size: 3 }, { name: 'normal', size: 3 }, ...specs];
    for (const s of this.specs) {
      this.data[s.name] = new AttrBuf(s.type ?? 'f32', 256 * s.size);
      this.cur[s.name] = new Array(s.size).fill(0);
      if (s.name !== 'position' && s.name !== 'normal' && s.name !== 'uv') this.other.push({ s, b: this.data[s.name], c: this.cur[s.name] });
    }
  }

  setOrigin(x: number, y: number, z: number): void {
    this.ox = x; this.oy = y; this.oz = z;
  }

  set(name: string, ...v: number[]): this {
    const c = this.cur[name];
    for (let i = 0; i < c.length; i++) c[i] = v[i] ?? 0;
    return this;
  }

  /** Add a vertex with world position, normal and optional uv; other attrs from `cur`. */
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, w = 0): number {
    const d = this.data;
    const P = d.position, N = d.normal;
    P.reserve(3); N.reserve(3);
    P.put(x - this.ox); P.put(y - this.oy); P.put(z - this.oz);
    N.put(nx); N.put(ny); N.put(nz);
    const uv = d.uv;
    if (uv) { uv.reserve(2); uv.put(u); uv.put(w); }
    for (const o of this.other) {
      o.b.reserve(o.s.size);
      for (let i = 0; i < o.s.size; i++) o.b.put(o.c[i]);
    }
    return this.vcount++;
  }

  private ensureIdx(k: number): void {
    if (this.ni + k <= this.idx.length) return;
    const a = new Uint32Array(Math.max(this.ni + k, this.idx.length * 2));
    a.set(this.idx.subarray(0, this.ni));
    this.idx = a;
  }

  tri(a: number, b: number, c: number): void {
    this.ensureIdx(3);
    const I = this.idx;
    I[this.ni++] = a; I[this.ni++] = b; I[this.ni++] = c;
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.ensureIdx(6);
    const I = this.idx;
    I[this.ni++] = a; I[this.ni++] = b; I[this.ni++] = c;
    I[this.ni++] = a; I[this.ni++] = c; I[this.ni++] = d;
  }

  /** Planar quad from 4 corners (CCW seen from the normal side); uv per corner. */
  quadP(
    p: number[], // 12 numbers: 4 corners xyz
    uv: number[], // 8 numbers
  ): void {
    const ax = p[3] - p[0], ay = p[4] - p[1], az = p[5] - p[2];
    const bx = p[9] - p[0], by = p[10] - p[1], bz = p[11] - p[2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const i0 = this.v(p[0], p[1], p[2], nx, ny, nz, uv[0], uv[1]);
    this.v(p[3], p[4], p[5], nx, ny, nz, uv[2], uv[3]);
    this.v(p[6], p[7], p[8], nx, ny, nz, uv[4], uv[5]);
    this.v(p[9], p[10], p[11], nx, ny, nz, uv[6], uv[7]);
    this.quad(i0, i0 + 1, i0 + 2, i0 + 3);
  }

  /**
   * Axis-aligned-in-local-frame box: centre (x,y,z), half extents (hx,hy,hz),
   * rotated by yaw around Y. uvScale maps meters → uv.
   */
  box(x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw = 0, faces = 0x3f, uvScale = 1): void {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const P = (lx: number, ly: number, lz: number): [number, number, number] => [x + lx * c + lz * s, y + ly, z - lx * s + lz * c];
    const N = (lx: number, lz: number): [number, number] => [lx * c + lz * s, -lx * s + lz * c];
    const face = (corners: [number, number, number][], n: [number, number, number], w: number, h: number) => {
      const i0 = this.v(...corners[0], ...n, 0, 0);
      this.v(...corners[1], ...n, w * uvScale, 0);
      this.v(...corners[2], ...n, w * uvScale, h * uvScale);
      this.v(...corners[3], ...n, 0, h * uvScale);
      this.quad(i0, i0 + 1, i0 + 2, i0 + 3);
    };
    // +X
    if (faces & 1) { const n = N(1, 0); face([P(hx, -hy, hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(hx, hy, hz)], [n[0], 0, n[1]], hz * 2, hy * 2); }
    // -X
    if (faces & 2) { const n = N(-1, 0); face([P(-hx, -hy, -hz), P(-hx, -hy, hz), P(-hx, hy, hz), P(-hx, hy, -hz)], [n[0], 0, n[1]], hz * 2, hy * 2); }
    // +Y
    if (faces & 4) face([P(-hx, hy, hz), P(hx, hy, hz), P(hx, hy, -hz), P(-hx, hy, -hz)], [0, 1, 0], hx * 2, hz * 2);
    // -Y
    if (faces & 8) face([P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, -hy, hz), P(-hx, -hy, hz)], [0, -1, 0], hx * 2, hz * 2);
    // +Z
    if (faces & 16) { const n = N(0, 1); face([P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz)], [n[0], 0, n[1]], hx * 2, hy * 2); }
    // -Z
    if (faces & 32) { const n = N(0, -1); face([P(hx, -hy, -hz), P(-hx, -hy, -hz), P(-hx, hy, -hz), P(hx, hy, -hz)], [n[0], 0, n[1]], hx * 2, hy * 2); }
  }

  /** Box between two points (a beam), with square section of half-size r (horizontal/vertical frame). */
  beam(ax: number, ay: number, az: number, bx: number, by: number, bz: number, hw: number, hh: number): void {
    const dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, by - ay, dz);
    if (L < 1e-4) return;
    if (Math.abs(by - ay) > 0.9 * L) {
      // vertical
      this.box((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2, hw, L / 2, hh, Math.atan2(dx, dz));
      return;
    }
    const yaw = Math.atan2(dz, dx);
    // local x along beam: box with hx = L/2, rotated so that +x maps to (dx,dz): yaw' = -yaw
    this.box((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2, L / 2, hh, hw, -yaw);
  }

  get empty(): boolean {
    return this.vcount === 0;
  }

  build(): MeshData {
    const attrs: MeshData['attrs'] = {};
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    const pos = this.data.position.arr, n = this.data.position.n;
    for (let i = 0; i < n; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    for (const s of this.specs) {
      const t = s.type ?? 'f32';
      attrs[s.name] = { array: this.data[s.name].done(), size: s.size, normalized: t === 'u8n' || t === 'i8n' };
    }
    const I = this.idx.subarray(0, this.ni);
    const index = this.vcount < 65536 ? Uint16Array.from(I) : I.slice();
    return { attrs, index, origin: [this.ox, this.oy, this.oz], bounds: [x0, y0, z0, x1, y1, z1] };
  }
}

export function meshTransferables(m: MeshData): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const k in m.attrs) out.push(m.attrs[k].array.buffer as ArrayBuffer);
  out.push(m.index.buffer as ArrayBuffer);
  return out;
}
