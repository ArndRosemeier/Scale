/**
 * Contact sheets of the procedural texture layers:
 *   npx tsx tools/texdump.ts [outDir] [--lit] [--full f|g<index>...]
 * Writes facade_albedo.png, facade_normal.png, ground_albedo.png, ground_normal.png (each layer
 * tiled 2x2 so seams are visible, image up = +v). --lit adds *_lit.png (albedo * N.L * AO) and
 * --full f3 g5 ... writes full-resolution 2x2 tilings of single layers (albedo + lit).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Raster } from './raster';
import {
  TEX_SIZE, FACADE_LAYER_COUNT, GROUND_LAYER_COUNT, generateFacadeLayer, generateGroundLayer, TexLayer,
} from '../src/render/texgen/index';

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--') && !/^[fg]\d+$/.test(a)) ?? 'texdump';
const lit = args.includes('--lit');
const full = args.filter((a) => /^[fg]\d+$/.test(a));
mkdirSync(outDir, { recursive: true });

type Mode = 'albedo' | 'normal' | 'lit';
const S = TEX_SIZE;
const L = (() => { const l = [-0.55, 0.5, 0.55]; const n = Math.hypot(l[0], l[1], l[2]); return l.map((c) => c / n); })();

/** RGB of texel (i, j) in the given mode. */
function texel(t: TexLayer, i: number, j: number, mode: Mode, out: number[]): void {
  const o = (j * S + i) * 4;
  if (mode === 'albedo') { out[0] = t.albedo[o]; out[1] = t.albedo[o + 1]; out[2] = t.albedo[o + 2]; return; }
  if (mode === 'normal') { out[0] = t.normal[o]; out[1] = t.normal[o + 1]; out[2] = t.normal[o + 3]; return; }
  const nx = t.normal[o] / 127.5 - 1, ny = t.normal[o + 1] / 127.5 - 1;
  const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
  const ndl = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
  const ao = t.normal[o + 3] / 255;
  const rough = t.albedo[o + 3] / 255;
  // half vector spec for a camera straight on (cheap Blinn-Phong)
  const hz = L[2] + 1, hx = L[0], hy = L[1], hl = Math.hypot(hx, hy, hz);
  const ndh = Math.max(0, (nx * hx + ny * hy + nz * hz) / hl);
  const pw = 2 / Math.max(0.002, rough * rough * rough * rough) - 2;
  const sp = 0.04 * ((pw + 2) / 8) * Math.pow(ndh, pw) * ndl;
  for (let c = 0; c < 3; c++) {
    const a = Math.pow(t.albedo[o + c] / 255, 2.2);
    const lin = a * (ndl * 0.85 + 0.25 * ao) * (0.6 + 0.4 * ao) + sp * ao;
    out[c] = Math.min(255, Math.pow(lin, 1 / 2.2) * 255);
  }
}

/** Draws a layer tiled 2x2 into a cell of `cell` px at (ox, oy), box-filtered. */
function drawCell(r: Raster, t: TexLayer, ox: number, oy: number, cell: number, mode: Mode): void {
  const span = 2 * S, k = span / cell;
  const c = [0, 0, 0], acc = [0, 0, 0];
  const st = Math.max(1, Math.floor(k));
  for (let py = 0; py < cell; py++) for (let px = 0; px < cell; px++) {
    acc[0] = acc[1] = acc[2] = 0;
    let cnt = 0;
    for (let sy = 0; sy < st; sy++) for (let sx = 0; sx < st; sx++) {
      const gx = Math.floor(px * k + (sx + 0.5) * (k / st)), gy = Math.floor(py * k + (sy + 0.5) * (k / st));
      // image up = +v: flip rows
      texel(t, gx % S, (S - 1 - (gy % S)), mode, c);
      acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; cnt++;
    }
    const o = ((oy + py) * r.w + ox + px) * 3;
    r.px[o] = acc[0] / cnt; r.px[o + 1] = acc[1] / cnt; r.px[o + 2] = acc[2] / cnt;
  }
}

function sheet(name: string, layers: TexLayer[], mode: Mode): void {
  const cols = 6, gap = 4, cell = Math.floor((2048 - gap * (cols + 1)) / cols);
  const rows = Math.ceil(layers.length / cols);
  const r = new Raster(cols * cell + (cols + 1) * gap, rows * cell + (rows + 1) * gap, 0x202020);
  layers.forEach((t, i) => drawCell(r, t, gap + (i % cols) * (cell + gap), gap + Math.floor(i / cols) * (cell + gap), cell, mode));
  r.save(join(outDir, `${name}_${mode}.png`));
}

function gen(kind: 'facade' | 'ground', count: number, fn: (i: number) => TexLayer): TexLayer[] {
  const out: TexLayer[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    out.push(fn(i));
    const dt = performance.now() - t0;
    total += dt;
    console.log(`${kind} ${String(i).padStart(2)}: ${dt.toFixed(0).padStart(5)} ms`);
  }
  console.log(`${kind} total: ${total.toFixed(0)} ms`);
  return out;
}

if (full.length) {
  for (const f of full) {
    const idx = Number(f.slice(1));
    const t = f[0] === 'f' ? generateFacadeLayer(idx) : generateGroundLayer(idx);
    for (const mode of ['albedo', 'lit', 'normal'] as Mode[]) {
      const r = new Raster(2 * S, 2 * S);
      drawCell(r, t, 0, 0, 2 * S, mode);
      r.save(join(outDir, `${f}_${mode}.png`));
    }
  }
} else {
  const fac = gen('facade', FACADE_LAYER_COUNT, (i) => generateFacadeLayer(i));
  const gnd = gen('ground', GROUND_LAYER_COUNT, (i) => generateGroundLayer(i));
  for (const m of (lit ? ['albedo', 'normal', 'lit'] : ['albedo', 'normal']) as Mode[]) {
    sheet('facade', fac, m);
    sheet('ground', gnd, m);
  }
}
