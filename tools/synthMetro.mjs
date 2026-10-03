// Procedural sounds for riding the metro (public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   metro_run    inside a running carriage: low rumble, wheel hiss and the "clack-clack" of the
//                bogies over rail joints (seamless loop; played faster / slower with the speed)
//   metro_pass   an oncoming train rushing past in the tunnel: a roaring whoosh with fast clacks
// Run: node tools/synthMetro.mjs (then the manifest entries in public/sounds/manifest.json).
import { writeFileSync } from 'node:fs';

const SR = 22050;
let s = 0x6d37a0c1;
const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

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

function lowpass(src, fc) {
  const out = new Float32Array(src.length), a = 1 - Math.exp(-2 * Math.PI * fc / SR);
  let y = 0;
  for (let i = 0; i < src.length; i++) { y += a * (src[i] - y); out[i] = y; }
  return out;
}

function write(name, out, { fadeOut = 0.02, loop = false } = {}) {
  const N = out.length;
  if (!loop) { const fade = Math.round(SR * fadeOut); for (let i = N - fade; i < N; i++) out[i] *= (N - i) / fade; }
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

/** Make a buffer loop seamlessly: crossfade its tail into its head. */
function loopify(x, xf) {
  const n = Math.round(xf * SR), N = x.length - n;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = x[i];
  for (let i = 0; i < n; i++) { const t = i / n; out[i] = x[i] * t + x[N + i] * (1 - t); }
  return out;
}

/** A wheel hitting a rail joint: a dull thump with a short metallic ring. */
function clack(out, i0, g, ring = 1) {
  for (let i = 0; i < 2600 && i0 + i < out.length; i++) {
    const t = i / SR;
    const thump = Math.sin(2 * Math.PI * 70 * t) * Math.exp(-t * 38);
    const metal = (Math.sin(2 * Math.PI * 1310 * t) * 0.5 + Math.sin(2 * Math.PI * 2270 * t) * 0.3) * Math.exp(-t * 60) * ring;
    out[i0 + i] += (thump * 1.0 + metal * 0.35 + rnd() * Math.exp(-t * 120) * 0.4) * g;
  }
}

// ---------------------------------------------------------------- metro_run (loop)
{
  // 16 m/s over 18 m rails: a joint every 1.125 s; each bogie's two axles 2.5 m apart → a pair.
  const beat = 1.125, beats = 4, xf = 0.3;
  const N = Math.round(SR * (beat * beats + xf));
  const noise = new Float32Array(N);
  for (let i = 0; i < N; i++) noise[i] = rnd();
  const rumble = lowpass(lowpass(noise, 140), 140);
  const body = bandpass(noise, 320, 0.9);
  const hiss = bandpass(noise, 2400, 0.5);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    // A slow swell (the car rocking, tunnel sections) on the rumble.
    const swell = 0.85 + 0.15 * Math.sin(2 * Math.PI * t / (beat * 2));
    out[i] = rumble[i] * 7 * swell + body[i] * 0.35 + hiss[i] * 0.06 + Math.sin(2 * Math.PI * 48 * t) * 0.05;
  }
  for (let b = 0; b < beats + 1; b++) {
    const t0 = b * beat;
    // Front bogie of this car, then (quieter, farther) the rear bogie of the car ahead.
    clack(out, Math.round(t0 * SR), 0.5);
    clack(out, Math.round((t0 + 0.156) * SR), 0.45);
    clack(out, Math.round((t0 + 0.62) * SR), 0.22, 0.6);
    clack(out, Math.round((t0 + 0.776) * SR), 0.2, 0.6);
  }
  write('metro_run', loopify(out, xf), { loop: true });
}

// ---------------------------------------------------------------- metro_pass (one shot)
{
  const dur = 2.6, N = Math.round(SR * dur), peak = 1.0;
  const noise = new Float32Array(N);
  for (let i = 0; i < N; i++) noise[i] = rnd();
  // The roar sweeps down past the listener (Doppler-ish), loudest when the cars are alongside.
  const roar = bandpass(noise, (t) => 900 - 500 * smooth(0.6, 1.6, t), 0.35);
  const low = lowpass(lowpass(noise, 120), 120);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const env = smooth(0, peak, t) * (1 - smooth(peak + 0.6, dur, t));
    out[i] = (roar[i] * 0.9 + low[i] * 6) * env;
  }
  // Fast clacks while the cars rush by (six cars, two bogies each).
  for (let c = 0; c < 12; c++) {
    const t0 = 0.55 + c * 0.11 + rnd() * 0.01;
    const g = 0.35 * Math.exp(-Math.pow((t0 - 1.1) / 0.5, 2));
    clack(out, Math.round(t0 * SR), g);
    clack(out, Math.round((t0 + 0.05) * SR), g * 0.9);
  }
  write('metro_pass', out, { fadeOut: 0.3 });
}
