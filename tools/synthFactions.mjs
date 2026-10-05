// Procedural sounds for the villain groups (public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   spray_hiss   a spray can: a rattle (the mixing ball) and three bursts of aerosol hiss
//   `node tools/synthFactions.mjs`
import { writeFileSync } from 'node:fs';

const SR = 22050;
let s = 0x7a65f1c3;
const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function bandpass(src, fc, q = 0.4) {
  const out = new Float32Array(src.length);
  let low = 0, band = 0;
  const f = 2 * Math.sin(Math.PI * Math.min(SR * 0.45, fc) / SR);
  for (let i = 0; i < src.length; i++) {
    low += f * band;
    const high = src[i] - low - q * band;
    band += f * high;
    out[i] = band;
  }
  return out;
}

function write(name, out, fadeOut = 0.03) {
  const N = out.length;
  const fade = Math.round(SR * fadeOut);
  for (let i = N - fade; i < N; i++) out[i] *= (N - i) / fade;
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
  const g = 0.89 / (peak || 1);
  const buf = Buffer.alloc(44 + N * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(N * 2, 40);
  for (let i = 0; i < N; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(out[i] * g * 32767))), 44 + i * 2);
  writeFileSync(new URL(`../public/sounds/${name}.wav`, import.meta.url), buf);
  console.log(`${name}.wav`, (buf.length / 1024).toFixed(0), 'KB');
}

// ---------------------------------------------------------------- spray can
{
  const N = Math.round(SR * 3.2);
  const out = new Float32Array(N);
  // The rattle: a ball knocking in the can, eight clicks over 0.6 s.
  const clicks = new Float32Array(N);
  for (let c = 0; c < 8; c++) {
    const i0 = Math.round((0.04 + c * 0.075 + rnd() * 0.01) * SR);
    for (let i = 0; i < 300 && i0 + i < N; i++) clicks[i0 + i] += rnd() * Math.exp(-i / 45) * (0.7 + 0.3 * Math.abs(rnd()));
  }
  const cb = bandpass(clicks, 2800, 0.7);
  for (let i = 0; i < N; i++) out[i] += cb[i] * 0.9;
  // Three bursts of hiss: high, breathy noise.
  const noise = new Float32Array(N);
  for (let i = 0; i < N; i++) noise[i] = rnd();
  const hiss = bandpass(noise, 6500, 0.9), air = bandpass(noise, 3800, 1.2);
  for (const [a, b] of [[0.8, 1.6], [1.75, 2.35], [2.5, 3.15]]) {
    for (let i = Math.round(a * SR); i < Math.min(N, Math.round(b * SR)); i++) {
      const t = i / SR;
      const env = smooth(a, a + 0.04, t) * (1 - smooth(b - 0.08, b, t)) * (0.85 + 0.15 * Math.sin(t * 37));
      out[i] += (hiss[i] * 0.8 + air[i] * 0.35) * env;
    }
  }
  write('spray_hiss', out);
}
