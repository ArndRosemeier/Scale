// Procedural bird sounds (public/sounds/bird_*.wav) for src/fauna/Birds.ts, 22.05 kHz mono,
// deterministic (seeded noise):
//   bird_flutter  a few pigeons flushing: overlapping trains of wing claps that slow down
//   pigeon_coo    a soft two-part "hroo-coo" with a throaty tremolo
//   gull_call     a gull's "kyow-kyow-kow": nasal descending calls
//   crow_caw      two harsh caws
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

/** Band-limited harmonic tone with a pitch curve f0(t), harmonic weights w[k]. */
function tone(N, f0, w, jitter = 0) {
  const out = new Float32Array(N);
  let ph = 0, j = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    if (jitter) j = j * 0.97 + rnd() * jitter * 0.03 * 10;
    const f = f0(t) * (1 + j);
    ph += 2 * Math.PI * f / SR;
    let v = 0;
    for (let k = 0; k < w.length; k++) if ((k + 1) * f < SR * 0.45) v += Math.sin(ph * (k + 1)) * w[k];
    out[i] = v;
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

// ---------------------------------------------------------------- pigeon coo
{
  const N = Math.round(SR * 1.15);
  const f0 = (t) => (t < 0.28 ? 330 + 90 * smooth(0, 0.22, t) : 410 - 70 * smooth(0.4, 1.0, t)) * (1 + 0.012 * Math.sin(t * 2 * Math.PI * 6));
  const v = tone(N, f0, [1, 0.45, 0.18, 0.06], 0.002);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const env = smooth(0.0, 0.05, t) * (1 - smooth(0.2, 0.3, t)) * 0.7 + smooth(0.38, 0.48, t) * (1 - smooth(0.85, 1.1, t));
    // Throaty: a fast tremolo and a little breath noise.
    const trem = 0.72 + 0.28 * Math.sin(t * 2 * Math.PI * 28);
    out[i] = (v[i] * trem + rnd() * 0.04) * env;
  }
  const lp = bandpass(out, 520, 1.2);
  for (let i = 0; i < N; i++) out[i] = lp[i] * 0.8 + out[i] * 0.35;
  write('pigeon_coo', out);
}

// ---------------------------------------------------------------- gull
{
  const N = Math.round(SR * 1.25);
  const out = new Float32Array(N);
  const calls = [[0.0, 0.34, 1.0], [0.42, 0.3, 0.85], [0.8, 0.4, 0.95]];
  for (const [t0, d, a] of calls) {
    const n = Math.round(d * SR);
    // "kyow": a quick rise then a long fall, nasal (strong upper harmonics).
    const f0 = (t) => 720 + 520 * smooth(0, 0.05, t) - 560 * smooth(0.05, d, t);
    const v = tone(n, f0, [0.5, 1, 0.8, 0.6, 0.35, 0.2, 0.12], 0.004);
    const i0 = Math.round(t0 * SR);
    for (let i = 0; i < n && i0 + i < N; i++) {
      const t = i / SR;
      const env = smooth(0, 0.02, t) * (1 - smooth(d * 0.6, d, t));
      out[i0 + i] += v[i] * env * a;
    }
  }
  const f = bandpass(out, 2400, 0.7);
  for (let i = 0; i < N; i++) out[i] = out[i] * 0.55 + f[i] * 0.6;
  write('gull_call', out);
}

// ---------------------------------------------------------------- crow
{
  const N = Math.round(SR * 1.0);
  const out = new Float32Array(N);
  for (const [t0, d] of [[0.0, 0.32], [0.45, 0.36]]) {
    const n = Math.round(d * SR);
    const f0 = (t) => 520 + 80 * smooth(0, 0.08, t) - 120 * smooth(0.1, d, t);
    const v = tone(n, f0, [0.7, 1, 0.9, 0.8, 0.6, 0.5, 0.4, 0.3, 0.2], 0.02);
    const i0 = Math.round(t0 * SR);
    for (let i = 0; i < n && i0 + i < N; i++) {
      const t = i / SR;
      // Harsh: noise-modulated amplitude (the rasp) under a quick attack and decay.
      const env = smooth(0, 0.015, t) * (1 - smooth(d * 0.5, d, t));
      out[i0 + i] += v[i] * env * (0.7 + 0.3 * rnd());
    }
  }
  const f = bandpass(out, 1500, 0.8);
  for (let i = 0; i < N; i++) out[i] = out[i] * 0.4 + f[i] * 0.8;
  write('crow_caw', out);
}
