// Procedural sounds of the street characters (public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   street_coin     a coin dropped into a hat / guitar case: a bright clink and a short rattle
// (The busker's guitar and the boombox are Lyria pieces now: tools/music/build_tracks.py.)
// Run: node tools/synthStreet.mjs
import { writeFileSync } from 'node:fs';

const SR = 22050;
let s = 0x5717ee7;
const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };

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

// ---------------------------------------------------------------- coin
{
  const N = Math.round(SR * 0.6);
  const out = new Float32Array(N);
  const ring = (t0, g, fs) => {
    const i0 = Math.round(t0 * SR);
    for (let i = 0; i0 + i < N; i++) {
      const x = i / SR;
      let v = 0;
      for (const [f, a, d] of fs) v += Math.sin(2 * Math.PI * f * x) * a * Math.exp(-x * d);
      out[i0 + i] += v * g;
    }
  };
  const partials = [[3150, 0.5, 22], [5480, 0.35, 30], [7900, 0.2, 45], [2240, 0.25, 26]];
  ring(0, 1, partials);
  ring(0.09, 0.45, partials.map(([f, a, d]) => [f * 1.02, a, d * 1.3]));
  ring(0.16, 0.25, partials.map(([f, a, d]) => [f * 0.98, a, d * 1.6]));
  // A soft thud of the hat / velvet underneath.
  for (let i = 0; i < 400; i++) out[i] += rnd() * 0.15 * Math.exp(-i / 60);
  write('street_coin', highpass(out, 400));
}
