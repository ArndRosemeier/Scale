// Procedural weather sounds (public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   amb_rain_light  light rain / drizzle: a soft hiss with fine pattering drops (seamless loop)
//   amb_rain_heavy  a downpour: dense roar, splashing, gurgling gutters, low drumming (seamless loop)
//   amb_wind_gust   wind at street level: gusts swelling and dying away, a faint whistle (seamless loop)
//   thunder_near_*  a close strike: the crack, then a rolling, rattling rumble (3 variations)
//   thunder_far_*   distant thunder: a low roll with no crack (3 variations)
// Run: node tools/synthWeather.mjs (then the manifest entries in public/sounds/manifest.json).
import { writeFileSync } from 'node:fs';

const SR = 22050;
let s = 0x3c6ef372;
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
  const out = new Float32Array(src.length);
  let y = 0;
  for (let i = 0; i < src.length; i++) {
    const a = 1 - Math.exp(-2 * Math.PI * (typeof fc === 'function' ? fc(i / SR) : fc) / SR);
    y += a * (src[i] - y);
    out[i] = y;
  }
  return out;
}

function highpass(src, fc) {
  const lo = lowpass(src, fc), out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] - lo[i];
  return out;
}

function noise(N) { const n = new Float32Array(N); for (let i = 0; i < N; i++) n[i] = rnd(); return n; }

function write(name, out, { fadeOut = 0.02, loop = false, level = 0.89 } = {}) {
  const N = out.length;
  if (!loop) { const fade = Math.round(SR * fadeOut); for (let i = N - fade; i < N; i++) out[i] *= (N - i) / fade; }
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
  const g = level / (peak || 1);
  const buf = Buffer.alloc(44 + N * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(N * 2, 40);
  for (let i = 0; i < N; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(out[i] * g * 32767))), 44 + i * 2);
  writeFileSync(new URL(`../public/sounds/${name}.wav`, import.meta.url), buf);
  console.log(`${name}.wav`, (buf.length / 1024).toFixed(0), 'KB');
}

/** Make a buffer loop seamlessly: crossfade its tail into its head (equal power). */
function loopify(x, xf) {
  const n = Math.round(xf * SR), N = x.length - n;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = x[i];
  for (let i = 0; i < n; i++) { const t = i / n; out[i] = x[i] * Math.sin(t * Math.PI / 2) + x[N + i] * Math.cos(t * Math.PI / 2); }
  return out;
}

/** A raindrop hitting something hard: a tiny damped click with a pitch (higher = smaller drop). */
function drop(out, i0, g, f) {
  const n = Math.round(SR * 0.025);
  for (let i = 0; i < n && i0 + i < out.length; i++) {
    const t = i / SR;
    out[i0 + i] += (Math.sin(2 * Math.PI * f * t * (1 - t * 8)) * 0.6 + rnd() * 0.5) * Math.exp(-t * 260) * g;
  }
}

// ---------------------------------------------------------------- amb_rain_light (loop)
{
  const dur = 9, xf = 0.8, N = Math.round(SR * (dur + xf));
  const n = noise(N);
  const hiss = highpass(bandpass(n, 4200, 0.7), 1500);
  const soft = bandpass(n, 1200, 0.9);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    out[i] = hiss[i] * (0.32 + 0.05 * Math.sin(t * 0.9)) + soft[i] * 0.05;
  }
  // Sparse drops on pavement, leaves and metal.
  for (let k = 0; k < dur * 55; k++) drop(out, Math.floor(((rnd() + 1) / 2) * (N - 600)), 0.06 + ((rnd() + 1) / 2) * 0.18, 1800 + ((rnd() + 1) / 2) * 3800);
  write('amb_rain_light', loopify(out, xf), { loop: true, level: 0.7 });
}

// ---------------------------------------------------------------- amb_rain_heavy (loop)
{
  const dur = 10, xf = 1, N = Math.round(SR * (dur + xf));
  const n = noise(N), n2 = noise(N);
  const roar = bandpass(n, 2200, 1.2);
  const body = bandpass(n2, 700, 0.8);
  const drum = lowpass(lowpass(n, 160), 160);
  // Gutters and downpipes: a gurgle (slowly wobbling band) under the roar.
  const gurgle = bandpass(n2, (t) => 420 + 160 * Math.sin(t * 7.1) + 90 * Math.sin(t * 13.3), 0.15);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const surge = 0.85 + 0.15 * Math.sin(t * 2 * Math.PI / (dur + xf) * 2) * Math.sin(t * 1.3);
    out[i] = (roar[i] * 0.7 + body[i] * 0.35 + drum[i] * 5 + gurgle[i] * 0.05) * surge;
  }
  for (let k = 0; k < dur * 160; k++) drop(out, Math.floor(((rnd() + 1) / 2) * (N - 600)), 0.08 + ((rnd() + 1) / 2) * 0.2, 1200 + ((rnd() + 1) / 2) * 3000);
  write('amb_rain_heavy', loopify(out, xf), { loop: true, level: 0.75 });
}

// ---------------------------------------------------------------- amb_wind_gust (loop)
{
  const dur = 16, xf = 2, N = Math.round(SR * (dur + xf));
  const n = noise(N);
  // Gust envelope: a few swells of different length.
  const env = (t) => 0.35 + 0.65 * Math.pow(Math.max(0, Math.sin(t * 0.41) * 0.6 + Math.sin(t * 0.93 + 1.3) * 0.4), 1.5);
  const air = bandpass(n, (t) => 260 + 520 * env(t), 0.35);
  const rush = highpass(bandpass(n, (t) => 1300 + 900 * env(t), 0.6), 700);
  const whistle = bandpass(n, (t) => 880 + 140 * Math.sin(t * 0.7), 0.02);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR, e = env(t);
    out[i] = (air[i] * 1.0 + rush[i] * 0.25 * e) * e + whistle[i] * 0.02 * e * e;
  }
  write('amb_wind_gust', loopify(out, xf), { loop: true, level: 0.75 });
}

// ---------------------------------------------------------------- thunder
/** Rolling rumble: a train of low bursts (echoes off clouds and hills) under a low roar. */
function rumble(out, t0, dur, g, fc, rolls) {
  const N = out.length, n = noise(N);
  const lo = lowpass(lowpass(n, fc), fc);
  const mid = bandpass(n, fc * 2.5, 0.6);
  const bursts = [];
  for (let k = 0; k < rolls; k++) bursts.push([t0 + Math.pow((rnd() + 1) / 2, 1.4) * dur * 0.8, 0.4 + ((rnd() + 1) / 2) * 0.6, 0.25 + ((rnd() + 1) / 2) * 0.9]);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    if (t < t0) continue;
    const base = smooth(t0, t0 + 0.35, t) * Math.exp(-(t - t0) / (dur * 0.45));
    let b = 0;
    for (const [tb, a, w] of bursts) if (t > tb) b += a * Math.exp(-(t - tb) / w) * smooth(tb, tb + 0.05, t);
    out[i] += (lo[i] * 9 + mid[i] * 0.4) * (base * 0.6 + b * 0.8) * g;
  }
}

for (let v = 1; v <= 3; v++) {
  // Near: the crack (a tearing, crackling broadband burst), then the roll.
  const dur = 6 + v, N = Math.round(SR * dur);
  const out = new Float32Array(N);
  const n = noise(N);
  const crackHi = highpass(n, 900);
  const tc = 0.03 + v * 0.02;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    if (t < tc) continue;
    const dt = t - tc;
    // Crackle: a burst of irregular spikes over ~0.25 s.
    const crackle = (rnd() > 0.93 ? 1 : 0.25) * Math.exp(-dt / (0.07 + v * 0.02));
    out[i] += crackHi[i] * crackle * 1.4 + n[i] * Math.exp(-dt / 0.02) * 0.8;
  }
  rumble(out, tc + 0.08, dur - 0.5, 1, 90 + v * 12, 5 + v * 2);
  write(`thunder_near_${v}`, out, { fadeOut: 1.2 });
}

for (let v = 1; v <= 3; v++) {
  const dur = 7 + v * 1.2, N = Math.round(SR * dur);
  const out = new Float32Array(N);
  rumble(out, 0.15 + v * 0.1, dur - 1, 1, 55 + v * 10, 6 + v * 2);
  // Distance takes the highs: a gentle extra lowpass.
  write(`thunder_far_${v}`, lowpass(out, 300), { fadeOut: 1.5 });
}
