/**
 * Wrapped stamping helpers for scattered geometry (pebbles, blades, rosettes) rendered into a
 * Tex with the height buffer as z-buffer.
 */
import { Rng } from '../../core/rng';
import { RGB, TNoise, Tex, mix, rnd, smooth } from './core';

/** Calls fn for every pixel whose center lies within radius r (m) of (cx, cy) (m), wrapping. */
export function splat(t: Tex, cx: number, cy: number, r: number, fn: (dx: number, dy: number, idx: number) => void): void {
  const s = t.size, ps = t.ps;
  const ci = cx / ps - 0.5, cj = cy / ps - 0.5, rp = r / ps, r2 = r * r;
  const j0 = Math.floor(cj - rp), j1 = Math.ceil(cj + rp), i0 = Math.floor(ci - rp), i1 = Math.ceil(ci + rp);
  for (let j = j0; j <= j1; j++) {
    const dy = (j - cj) * ps;
    if (dy * dy > r2) continue;
    const row = (((j % s) + s) % s) * s;
    for (let i = i0; i <= i1; i++) {
      const dx = (i - ci) * ps;
      if (dx * dx + dy * dy > r2) continue;
      fn(dx, dy, row + (((i % s) + s) % s));
    }
  }
}

/** Walks a thin segment from (x, y) in direction a for length len (m); fn(s 0..1, idx). */
export function stroke(t: Tex, x: number, y: number, a: number, len: number, fn: (s: number, idx: number) => void): void {
  const s = t.size, ps = t.ps;
  const n = Math.max(1, Math.ceil(len / (ps * 0.7)));
  const ca = Math.cos(a), sa = Math.sin(a);
  let last = -1;
  for (let k = 0; k <= n; k++) {
    const f = k / n;
    const i = Math.floor((x + ca * len * f) / ps), j = Math.floor((y + sa * len * f) / ps);
    const idx = (((j % s) + s) % s) * s + (((i % s) + s) % s);
    if (idx === last) continue;
    last = idx;
    fn(f, idx);
  }
}

export interface PebbleOpts {
  /** coverage multiplier (pebbles per own area) */
  count: number;
  rMin: number;
  rMax: number;
  /** dome height relative to radius */
  height: number;
  palette: RGB[];
  fines: RGB;
  finesH: number;
  /** optional mask (u,v) -> 0..1 of where pebbles may lie */
  mask?: (u: number, v: number) => number;
  dust?: number;
  /** false: keep the existing contents of t as the bed */
  bed?: boolean;
}

/** Scatter of overlapping, z-buffered ellipsoidal pebbles over a fines bed. */
export function pebbles(t: Tex, seed: number, o: PebbleOpts): void {
  const W = t.W;
  const nf = new TNoise(seed + 1, W), nd = new TNoise(seed + 2, W);
  // bed of fines
  if (o.bed !== false) t.each((u, v, _x, _y, idx) => {
    const k = 1 + nf.fbm(u, v, 0.02, 3) * 0.15 + (rnd(seed + 3, idx) - 0.5) * 0.25;
    t.set(idx, o.fines[0] * k, o.fines[1] * k, o.fines[2] * k, 0.95, o.finesH + nf.fbm(u, v, 0.05, 3) * 0.002);
  });
  const rng = new Rng(seed + 4);
  const rm = (o.rMin + o.rMax) / 2;
  const n = Math.round((W * W) / (Math.PI * rm * rm * 0.7) * o.count);
  for (let k = 0; k < n; k++) {
    const cx = rng.float() * W, cy = rng.float() * W;
    if (o.mask && rng.float() > o.mask(cx / W, cy / W)) continue;
    const a = rng.range(o.rMin, o.rMax), b = a * rng.range(0.55, 0.95), th = rng.float() * Math.PI;
    const ct = Math.cos(th), st = Math.sin(th);
    const base = -a * rng.range(0, 0.35) * o.height;
    const hk = a * o.height * rng.range(0.75, 1.1);
    const col = o.palette[Math.floor(rng.float() * o.palette.length)];
    const vk = rng.range(0.82, 1.15);
    const sk = rng.int(0, 1000000);
    splat(t, cx, cy, a, (dx, dy, idx) => {
      const px = dx * ct + dy * st, py = -dx * st + dy * ct;
      const q = (px / a) ** 2 + (py / b) ** 2;
      if (q >= 1) return;
      const z = base + Math.sqrt(1 - q) * hk;
      if (z <= t.h[idx]) return;
      const speck = 1 + (rnd(sk, idx) - 0.5) * 0.12;
      const rim = 0.8 + 0.2 * Math.sqrt(1 - q);
      const k = vk * speck * rim;
      t.set(idx, col[0] * k, col[1] * k, col[2] * k, 0.75 - 0.15 * (1 - q), z);
    });
  }
  if (o.dust) {
    t.each((u, v, _x, _y, idx) => {
      const d = smooth(-0.2, 0.6, nd.fbm(u, v, 0.4, 4)) * o.dust!;
      t.r[idx] = mix(t.r[idx], o.fines[0] * 1.1, d);
      t.g[idx] = mix(t.g[idx], o.fines[1] * 1.1, d);
      t.b[idx] = mix(t.b[idx], o.fines[2] * 1.1, d);
    });
  }
}
