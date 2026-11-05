// Procedural sounds of the magnetic grandma (public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   magnet_clink   a small metal thing snapping onto her coat: a dull magnetic "tock" and a bright ring
//   junk_clatter   a dozen bits of metal falling to the pavement when she shakes them off
// Run: node tools/synthMagnet.mjs
import { writeFileSync } from 'node:fs';

const SR = 22050;
let s = 0x3a6e7;
const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
const u = () => (rnd() + 1) / 2;

function lowpass(x, fc) {
  const out = new Float32Array(x.length);
  const a = 1 - Math.exp((-2 * Math.PI * fc) / SR);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y += a * (x[i] - y); out[i] = y; }
  return out;
}
function highpass(x, fc) {
  const lp = lowpass(x, fc);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] - lp[i];
  return out;
}
function write(name, out) {
  const N = out.length;
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
  const g = 0.85 / (peak || 1);
  const buf = Buffer.alloc(44 + N * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(N * 2, 40);
  for (let i = 0; i < N; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(out[i] * g * 32767))), 44 + i * 2);
  writeFileSync(new URL(`../public/sounds/${name}.wav`, import.meta.url), buf);
  console.log(`${name}.wav`, (buf.length / 1024).toFixed(0), 'KB');
}
/** A struck bit of metal at t0: inharmonic partials decaying, plus a click of noise. */
function hit(out, t0, g, f0, decay, click = 0.3) {
  const i0 = Math.round(t0 * SR), N = out.length;
  const parts = [[1, 1], [2.76, 0.55], [5.4, 0.3], [8.93, 0.16]];
  for (let i = 0; i0 + i < N && i < SR * 1.2; i++) {
    const x = i / SR;
    let v = 0;
    for (const [m, a] of parts) v += Math.sin(2 * Math.PI * f0 * m * x) * a * Math.exp(-x * decay * (0.7 + m * 0.3));
    if (i < 300) v += rnd() * click * Math.exp(-i / 50);
    out[i0 + i] += v * g;
  }
}

// ---------------------------------------------------------------- clink
{
  const N = Math.round(SR * 0.5);
  const out = new Float32Array(N);
  // The magnetic snap: a short low thump.
  for (let i = 0; i < 900; i++) out[i] += Math.sin(2 * Math.PI * 140 * (i / SR)) * Math.exp(-i / 180) * 0.8;
  hit(out, 0.003, 0.7, 1850, 26, 0.5);
  hit(out, 0.05, 0.18, 1910, 40, 0.1);
  write('magnet_clink', highpass(out, 90));
}

// ---------------------------------------------------------------- clatter
{
  const N = Math.round(SR * 1.3);
  const out = new Float32Array(N);
  let t = 0.02;
  for (let k = 0; k < 22; k++) {
    hit(out, t, 0.35 + u() * 0.6, 900 + u() * 2600, 18 + u() * 30, 0.6);
    t += 0.015 + u() * 0.07 * (1 + k / 12);
    if (t > 1.0) break;
  }
  // A heavier one (the pan) in the middle.
  hit(out, 0.21, 0.9, 420, 9, 0.8);
  write('junk_clatter', highpass(out, 120));
}
