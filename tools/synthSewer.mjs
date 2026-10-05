// Procedural sounds for life in the sewers and the bigger side rooms (public/sounds/*.wav,
// 22.05 kHz mono, deterministic):
//   rat_squeak_1..3  a rat's short, high squeak (a chirp or two), in a tunnel
//   under_engine     a pump engine running in a machine hall: a heavy rhythmic thump, a hiss, a whine (loop)
//   under_gears      the winding gear of a sluice turning slowly: clanking teeth, a ratchet, a low hum (loop)
//   under_fire       a fire in an oil drum: crackles and pops over a soft roar (loop)
// Run: node tools/synthSewer.mjs (then the manifest entries in public/sounds/manifest.json).
import { writeFileSync } from 'node:fs';

const SR = 22050;
let seed = 0x5e3a11c7;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) * 2 - 1; };

function lowpass(src, fc) {
  const out = new Float32Array(src.length), a = 1 - Math.exp(-2 * Math.PI * fc / SR);
  let y = 0;
  for (let i = 0; i < src.length; i++) { y += a * (src[i] - y); out[i] = y; }
  return out;
}

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

/** A small reverberant tail (a few feedback delays): tunnels and chambers. */
function cave(src, mix = 0.35, len = 0.6) {
  const out = Float32Array.from(src);
  const taps = [0.031, 0.047, 0.067, 0.089, 0.113];
  for (const d of taps) {
    const n = Math.round(d * SR), g = Math.pow(0.001, d / len);
    for (let i = n; i < out.length; i++) out[i] += out[i - n] * g * mix * 0.5;
  }
  return out;
}

function write(name, out, { fadeOut = 0.02, loop = false, peak: target = 0.89 } = {}) {
  const N = out.length;
  if (!loop) { const fade = Math.round(SR * fadeOut); for (let i = N - fade; i < N; i++) out[i] *= (N - i) / fade; }
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
  const g = target / (peak || 1);
  const buf = Buffer.alloc(44 + N * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(N * 2, 40);
  for (let i = 0; i < N; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(out[i] * g * 32767))), 44 + i * 2);
  writeFileSync(new URL(`../public/sounds/${name}.wav`, import.meta.url), buf);
  console.log(`${name}.wav`, (buf.length / 1024).toFixed(0), 'KB');
}

/** Seamless loop: crossfade the tail into the head. */
function loopify(x, xf) {
  const n = Math.round(xf * SR), N = x.length - n;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = x[i];
  for (let i = 0; i < n; i++) { const t = i / n; out[i] = x[i] * t + x[N + i] * (1 - t); }
  return out;
}

// ---- rat squeaks: one to three fast chirps around 3–5 kHz with a pitch bend
[[3600, 2], [4300, 1], [3100, 3]].forEach(([f0, n], k) => {
  const N = Math.round(0.6 * SR), out = new Float32Array(N);
  let t0 = 0.02;
  for (let c = 0; c < n; c++) {
    const len = 0.05 + (rnd() * 0.5 + 0.5) * 0.06, i0 = Math.round(t0 * SR);
    for (let i = 0; i < len * SR && i0 + i < N; i++) {
      const t = i / SR, q = t / len;
      const f = f0 * (1 + 0.25 * Math.sin(q * Math.PI) - 0.15 * q) * (1 + c * 0.06);
      const env = Math.sin(Math.PI * q) ** 0.6;
      out[i0 + i] += (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t) + rnd() * 0.15) * env;
    }
    t0 += len + 0.03 + (rnd() * 0.5 + 0.5) * 0.05;
  }
  write(`rat_squeak_${k + 1}`, cave(bandpass(out, 3800, 0.6), 0.35, 0.5), { fadeOut: 0.08, peak: 0.7 });
});

// ---- engine: thump at ~2.2 Hz (a two-stroke rhythm), steam-like hiss, gear whine
{
  const N = Math.round(4 * SR), out = new Float32Array(N);
  const noise = new Float32Array(N); for (let i = 0; i < N; i++) noise[i] = rnd();
  const hiss = bandpass(noise, 2600, 1.0), rum = lowpass(noise, 90);
  const beat = 2.25; // 9 beats in 4 s: seamless
  for (let i = 0; i < N; i++) {
    const t = i / SR, ph = (t * beat) % 1, ph2 = (t * beat + 0.5) % 1;
    const thump = Math.exp(-ph * 14) * Math.sin(2 * Math.PI * 48 * t) * 1.2 + Math.exp(-ph2 * 18) * Math.sin(2 * Math.PI * 62 * t) * 0.5;
    const puff = Math.exp(-((ph - 0.12 + 1) % 1) * 9) * 0.6;
    out[i] = thump + hiss[i] * (0.15 + puff) + rum[i] * 4 + Math.sin(2 * Math.PI * 330 * t) * 0.03 + Math.sin(2 * Math.PI * 25 * t) * 0.15;
  }
  write('under_engine', cave(out, 0.3), { loop: true, peak: 0.8 });
}

// ---- gears: tooth clicks at ~7 Hz (irregular strength), a ratchet every so often, a low hum
{
  const N = Math.round(6 * SR), out = new Float32Array(N);
  const click = (i0, g, f) => { for (let i = 0; i < 0.05 * SR && i0 + i < N; i++) { const t = i / SR; out[i0 + i] += (Math.sin(2 * Math.PI * f * t) * 0.7 + rnd() * 0.5) * Math.exp(-t * 90) * g; } };
  for (let k = 0; k < 42; k++) click(Math.round((k / 7) * SR), 0.35 + (rnd() * 0.5 + 0.5) * 0.5, 900 + (rnd() * 0.5 + 0.5) * 500);
  for (const t0 of [1.3, 4.1]) for (let k = 0; k < 6; k++) click(Math.round((t0 + k * 0.045) * SR), 0.8, 2200);
  for (let i = 0; i < N; i++) { const t = i / SR; out[i] += Math.sin(2 * Math.PI * 55 * t) * 0.08 + Math.sin(2 * Math.PI * 110 * t) * 0.04; }
  write('under_gears', cave(out, 0.4), { loop: true, peak: 0.7 });
}

// ---- fire: a soft roar with crackles and the odd pop
{
  const N = Math.round(5 * SR), out = new Float32Array(N);
  const noise = new Float32Array(N); for (let i = 0; i < N; i++) noise[i] = rnd();
  const roar = lowpass(noise, 400), air = bandpass(noise, 1200, 1.4);
  for (let i = 0; i < N; i++) { const t = i / SR; out[i] = roar[i] * 2.2 * (0.8 + 0.2 * Math.sin(t * 5.3)) + air[i] * 0.25; }
  for (let k = 0; k < 120; k++) {
    const i0 = Math.floor((rnd() * 0.5 + 0.5) * (N - 600)), g = Math.pow(rnd() * 0.5 + 0.5, 3) * (rnd() > 0.92 ? 3 : 1.2);
    for (let i = 0; i < 300; i++) out[i0 + i] += rnd() * Math.exp(-i / 40) * g;
  }
  write('under_fire', loopify(out, 0.4), { loop: true, peak: 0.6 });
}
