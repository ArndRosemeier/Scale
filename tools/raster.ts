/** Minimal software rasterizer + PNG writer for headless debug maps. */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

export class Raster {
  readonly w: number;
  readonly h: number;
  readonly px: Uint8Array;
  /** world → pixel transform */
  cx = 0; cz = 0; scale = 1;

  constructor(w: number, h: number, bg = 0x101418) {
    this.w = w; this.h = h;
    this.px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { this.px[i * 3] = bg >> 16; this.px[i * 3 + 1] = (bg >> 8) & 255; this.px[i * 3 + 2] = bg & 255; }
  }

  view(cx: number, cz: number, worldWidth: number): void {
    this.cx = cx; this.cz = cz; this.scale = this.w / worldWidth;
  }
  X(x: number): number { return (x - this.cx) * this.scale + this.w / 2; }
  Y(z: number): number { return this.h / 2 - (z - this.cz) * this.scale; }

  set(x: number, y: number, c: number, a = 1): void {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 3;
    if (a >= 1) { this.px[o] = c >> 16; this.px[o + 1] = (c >> 8) & 255; this.px[o + 2] = c & 255; return; }
    this.px[o] = this.px[o] * (1 - a) + (c >> 16) * a;
    this.px[o + 1] = this.px[o + 1] * (1 - a) + ((c >> 8) & 255) * a;
    this.px[o + 2] = this.px[o + 2] * (1 - a) + (c & 255) * a;
  }

  /** Per-pixel world function. */
  shade(fn: (x: number, z: number) => number): void {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const wx = (x - this.w / 2) / this.scale + this.cx, wz = (this.h / 2 - y) / this.scale + this.cz;
      this.set(x, y, fn(wx, wz));
    }
  }

  line(x0: number, z0: number, x1: number, z1: number, c: number, width = 1): void {
    const ax = this.X(x0), ay = this.Y(z0), bx = this.X(x1), by = this.Y(z1);
    const n = Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))) + 1;
    const r = Math.max(0, (width - 1) / 2);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
      if (r < 0.5) this.set(x, y, c);
      else for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + 0.5) this.set(x + dx, y + dy, c);
    }
  }

  polyline(pts: ArrayLike<number>, c: number, width = 1): void {
    for (let i = 0; i + 3 < pts.length; i += 2) this.line(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], c, width);
  }

  polygon(pts: ArrayLike<number>, c: number, width = 1): void {
    this.polyline(pts, c, width);
    const n = pts.length;
    this.line(pts[n - 2], pts[n - 1], pts[0], pts[1], c, width);
  }

  /** Even-odd scanline fill; rings is a list of flat polygons (outer + holes). */
  fill(rings: ArrayLike<number>[], c: number, a = 1): void {
    let y0 = Infinity, y1 = -Infinity;
    for (const r of rings) for (let i = 1; i < r.length; i += 2) { const y = this.Y(r[i]); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(this.h - 1, Math.ceil(y1));
    const xs: number[] = [];
    for (let y = y0; y <= y1; y++) {
      xs.length = 0;
      const sy = y + 0.5;
      for (const r of rings) {
        const n = r.length >> 1;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const ay = this.Y(r[j * 2 + 1]), by = this.Y(r[i * 2 + 1]);
          if ((ay > sy) !== (by > sy)) {
            const ax = this.X(r[j * 2]), bx = this.X(r[i * 2]);
            xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
          }
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(this.w - 1, Math.floor(xs[k + 1] - 0.5)); x++) this.set(x, y, c, a);
      }
    }
  }

  dot(x: number, z: number, r: number, c: number): void {
    const px = this.X(x), py = this.Y(z);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) this.set(px + dx, py + dy, c);
  }

  save(path: string): void {
    const { w, h, px } = this;
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(px.buffer, px.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1); }
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  }
}

const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(b: Buffer): number { let c = -1; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8); return c ^ -1; }
