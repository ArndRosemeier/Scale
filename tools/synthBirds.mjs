// Procedural bird sounds (public/sounds/bird_*.wav) for src/fauna/Birds.ts, 22.05 kHz mono,
// deterministic (seeded noise):
//   bird_flutter  a few pigeons flushing: overlapping trains of wing claps that slow down
// (Bird calls are bubbles now: src/ui/voices.ts.)
import { writeFileSync } from 'node:fs';

const SR = 22050;
let s = 0x2c1b3c6d;
const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** State-variable filter (band-pass output) with a per-sample centre frequency. */
function bandpass(src, fc, q = 0.4) {
  const out = new Float32Array(src.length);
  let low = 0, band = 0;
  for (let i = 0; i < src.length; i++) {
    const f = 2 * Math.sin(Math.PI * Math.min(SR * 0.45, typeof fc === 'function' ? fc(i / SR) : fc) / SR);
    low += f * band;
    const high = src[i] - low - q * band;
    band += f * high;
    out[i] = band;
  }
  return out;
}

function write(name, out) {
  const N = out.length;
  const fade = Math.round(SR * 0.02);
  for (let i = N - fade; i < N; i++) out[i] *= (N - i) / fade;
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
  const g = 0.89 / peak;
  const buf = Buffer.alloc(44 + N * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(N * 2, 40);
  for (let i = 0; i < N; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(out[i] * g * 32767))), 44 + i * 2);
  writeFileSync(new URL(`../public/sounds/${name}.wav`, import.meta.url), buf);
  console.log(`${name}.wav`, (buf.length / 1024).toFixed(0), 'KB');
}

// ---------------------------------------------------------------- flutter
{
  const N = Math.round(SR * 1.3);
  const out = new Float32Array(N);
  for (let b = 0; b < 4; b++) {
    // One bird: wing beats at ~15 Hz slowing to ~8 Hz as it climbs away, getting quieter.
    let t = 0.02 + b * 0.07 + Math.abs(rnd()) * 0.05;
    const amp = 1 - b * 0.15;
    let k = 0;
    while (t < 1.2) {
      const rate = 15 - 7 * smooth(0, 0.9, t) + rnd() * 0.8;
      const a = amp * Math.exp(-t * 2.2) * (0.75 + Math.abs(rnd()) * 0.3);
      // A clap: a few ms of noise, sharp attack, plus the softer "whup" of the down-stroke.
      const i0 = Math.round(t * SR), len = Math.round(SR * 0.022);
      for (let i = 0; i < len && i0 + i < N; i++) {
        const e = Math.exp(-i / (SR * 0.004));
        const w = Math.sin(Math.PI * i / len);
        out[i0 + i] += rnd() * e * a + Math.sin(2 * Math.PI * 160 * i / SR) * w * a * 0.35;
      }
      t += 1 / rate;
      k++;
    }
  }
  // Feathery colour: keep 600 Hz – 4 kHz, plus some of the dry thump.
  const hp = bandpass(out, 1800, 0.9);
  for (let i = 0; i < N; i++) out[i] = hp[i] * 1.2 + out[i] * 0.25;
  write('bird_flutter', out);
}
