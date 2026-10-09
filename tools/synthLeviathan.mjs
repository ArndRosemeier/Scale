// Procedural sounds for the Leviathan (public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   leviathan_surface  the river heaving as it comes up (or goes under): a deep surge, a wash, spray
//   leviathan_roar     its call: a deep wet bellow with a whale-like moan and a gurgle
//   leviathan_slap     a tentacle slapping down on a deck or quay: a heavy wet thud
// Run: node tools/synthLeviathan.mjs
// (Filters stay below ~3 kHz: the Chamberlin band-pass is unstable above ~3.7 kHz at 22.05 kHz.)
import { writeFileSync } from 'node:fs';

const SR = 22050;
let s = 0x1e7a7a11;
const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function lowpass(src, fc) {
  const out = new Float32Array(src.length);
  let y = 0;
  for (let i = 0; i < src.length; i++) {
    const f = typeof fc === 'function' ? fc(i / SR) : fc;
    const a = 1 - Math.exp((-2 * Math.PI * f) / SR);
    y += a * (src[i] - y); out[i] = y;
  }
  return out;
}

function bandpass(src, fc, q = 0.4) {
  const out = new Float32Array(src.length);
  let low = 0, band = 0;
  for (let i = 0; i < src.length; i++) {
    const f = 2 * Math.sin(Math.PI * Math.min(3000, typeof fc === 'function' ? fc(i / SR) : fc) / SR);
    low += f * band;
    const high = src[i] - low - q * band;
    band += f * high;
    out[i] = band;
  }
  return out;
}

function echo(x, taps) {
  const out = new Float32Array(x.length);
  for (const [d, g] of taps) { const o = Math.round(d * SR); for (let i = o; i < x.length; i++) out[i] += x[i - o] * g; }
  return out;
}

function write(name, out, { fadeOut = 0.05, fadeIn = 0 } = {}) {
  const N = out.length;
  const fade = Math.round(SR * fadeOut); for (let i = N - fade; i < N; i++) out[i] *= (N - i) / fade;
  const fi = Math.round(SR * fadeIn); for (let i = 0; i < fi; i++) out[i] *= i / fi;
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

/** Deep rumble source: brown noise with a slow surge. */
function rumble(N, surge = 0.6, rate = 0.35) {
  const out = new Float32Array(N);
  let b = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    b = b * 0.995 + rnd() * 0.06;
    out[i] = b * (1 - surge * 0.5 + surge * 0.5 * Math.sin(2 * Math.PI * rate * t));
  }
  return out;
}

/** Sparse crunches of rock (short decaying noise bursts), density per second. */
function crunch(N, density, decay = 60, env = () => 1) {
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    if (rnd() * 0.5 + 0.5 < density / SR * env(t)) {
      const a = (0.3 + Math.abs(rnd()) * 0.7) * env(t), L = Math.round(SR * (0.02 + Math.abs(rnd()) * 0.08));
      for (let k = 0; k < L && i + k < N; k++) out[i + k] += rnd() * a * Math.exp(-(k / SR) * decay);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the water heaving (surface / surge)
{
  const T = 3.2, N = Math.round(SR * T);
  const env = (t) => smooth(0, 0.35, t) * (1 - smooth(1.6, 3.2, t));
  const surge = lowpass(rumble(N, 0.8, 0.7), 110);
  const wash = bandpass(rumble(N, 0.4, 0.4), (t) => 380 + 500 * smooth(0, 1, t) - 300 * smooth(1.2, 3, t), 0.5);
  const spray = bandpass(crunch(N, 160, 70, (t) => smooth(0.2, 0.6, t) * Math.exp(-Math.max(0, t - 0.6) * 1.4)), 1800, 0.6);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) { const t = i / SR; out[i] = surge[i] * env(t) * 2.6 + wash[i] * env(t) * 1.1 + spray[i] * 0.35; }
  write('leviathan_surface', echo(out, [[0, 1], [0.23, 0.25], [0.52, 0.12]]), { fadeOut: 0.6 });
}

// ---------------------------------------------------------------- the roar: a deep bellow, wet and gurgling, a whale-like moan
{
  const T = 3.6, N = Math.round(SR * T);
  const env = (t) => smooth(0, 0.25, t) * (1 - smooth(2.4, 3.6, t));
  const out = new Float32Array(N);
  let p1 = 0, p2 = 0, p3 = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const f = 62 + 26 * Math.sin(Math.PI * Math.min(1, t / 3)) - 14 * smooth(2, 3.4, t);
    p1 += (2 * Math.PI * f) / SR; p2 += (2 * Math.PI * f * 1.51) / SR; p3 += (2 * Math.PI * (f * 3.02 + 8 * Math.sin(t * 7))) / SR;
    const growl = 0.6 + 0.4 * Math.sin(2 * Math.PI * 23 * t + Math.sin(t * 3) * 2);
    out[i] = (Math.sin(p1) + 0.6 * Math.sin(p2) + 0.35 * Math.tanh(3 * Math.sin(p3))) * growl * env(t);
  }
  const gurgle = bandpass(crunch(N, 50, 35, env), 420, 0.6);
  const breath = bandpass(rumble(N, 0.5, 1.3), 700, 0.4);
  const mix = new Float32Array(N);
  const lo = lowpass(out, 900);
  for (let i = 0; i < N; i++) mix[i] = lo[i] + gurgle[i] * 0.5 + breath[i] * env(i / SR) * 0.6;
  write('leviathan_roar', echo(mix, [[0, 1], [0.21, 0.3], [0.47, 0.2], [0.9, 0.1]]), { fadeOut: 0.5 });
}

// ---------------------------------------------------------------- a tentacle slapping down on a deck or quay
{
  const T = 1.2, N = Math.round(SR * T);
  const out = new Float32Array(N);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (48 + 70 * Math.exp(-t * 14))) / SR;
    const thud = Math.sin(ph) * Math.exp(-t * 6) * smooth(0, 0.004, t);
    const slap = rnd() * Math.exp(-t * 40);
    out[i] = thud * 1.2 + slap * 0.9;
  }
  const wet = bandpass(crunch(N, 90, 50, (t) => Math.exp(-t * 4)), 1500, 0.6);
  const lo = lowpass(out, (t) => 400 + 2400 * Math.exp(-t * 25));
  const mix = new Float32Array(N);
  for (let i = 0; i < N; i++) mix[i] = lo[i] + wet[i] * 0.4;
  write('leviathan_slap', echo(mix, [[0, 1], [0.12, 0.2]]), { fadeOut: 0.3 });
}
