// Procedural sounds for the side rooms and the hidden chambers (public/sounds/*.wav, 22.05 kHz
// mono, deterministic):
//   under_drip_1..3  a water drop falling into a puddle, with a short cave-like tail
//   under_falls      water falling through a street grate into a basin (seamless loop)
//   under_hum        electrical cabinets / a pump: mains hum with a buzz and slow beating (loop)
//   under_fan        a big ventilation fan turning slowly: whoosh pulses, low rumble (loop)
//   slime_burble     soft, wet, bubbling murmurs of the slimes "talking" (loop, quiet)
//   slime_squish_1..2  a soft wet squelch (a slime squeezing away, or splattering)
//   slime_gift       a small glassy chime (the brave one leaves something)
// Run: node tools/synthUnder.mjs (then the manifest entries in public/sounds/manifest.json).
import { writeFileSync } from 'node:fs';

const SR = 22050;
let seed = 0x2b7e1516;
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

/** A drop: a tiny click, then a rising "plink" (the bubble), into a cave tail. */
function drip(out, i0, f0, g) {
  for (let i = 0; i < 0.12 * SR && i0 + i < out.length; i++) {
    const t = i / SR;
    const f = f0 * (1 + t * 9);
    const env = Math.exp(-t * 38) * Math.min(1, t * 900);
    out[i0 + i] += Math.sin(2 * Math.PI * f * t + Math.sin(t * 90) * 0.3) * env * g;
    if (i < 40) out[i0 + i] += rnd() * (1 - i / 40) * 0.3 * g;
  }
}

// ---- drips
[[900, 1], [1250, 2], [700, 3]].forEach(([f, k]) => {
  const out = new Float32Array(Math.round(0.9 * SR));
  drip(out, 200, f, 1);
  if (k === 2) drip(out, Math.round(0.21 * SR), f * 1.3, 0.35);
  write(`under_drip_${k}`, cave(out, 0.55, 0.8), { fadeOut: 0.1 });
});

// ---- falling water: broadband rush with gurgles and splashes
{
  const N = Math.round(6.5 * SR), out = new Float32Array(N);
  const noise = new Float32Array(N); for (let i = 0; i < N; i++) noise[i] = rnd();
  const rush = bandpass(noise, (t) => 1400 + Math.sin(t * 1.7) * 300 + Math.sin(t * 5.3) * 150, 0.9);
  const low = lowpass(noise, 300);
  for (let i = 0; i < N; i++) out[i] = rush[i] * 0.6 + low[i] * 1.6;
  for (let k = 0; k < 60; k++) drip(out, Math.floor((rnd() * 0.5 + 0.5) * (N - 3000)), 400 + (rnd() * 0.5 + 0.5) * 900, 0.25);
  write('under_falls', loopify(cave(out, 0.3), 0.5), { loop: true });
}

// ---- hum: 50 Hz mains with harmonics, a slight buzz, slow beating
{
  const N = Math.round(4 * SR), out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    let v = Math.sin(2 * Math.PI * 100 * t) * 0.6 + Math.sin(2 * Math.PI * 50 * t) * 0.5 + Math.sin(2 * Math.PI * 150 * t) * 0.25 + Math.sin(2 * Math.PI * 200.5 * t) * 0.15;
    v += Math.sign(Math.sin(2 * Math.PI * 100 * t)) * 0.06;
    v *= 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.5 * t);
    out[i] = v + rnd() * 0.02;
  }
  write('under_hum', lowpass(out, 1800), { loop: true, peak: 0.7 });
}

// ---- fan: blade-pass whoosh (~3 Hz) over a low rumble
{
  const N = Math.round(4 * SR), out = new Float32Array(N);
  const noise = new Float32Array(N); for (let i = 0; i < N; i++) noise[i] = rnd();
  const air = bandpass(noise, 700, 1.2), rum = lowpass(noise, 120);
  for (let i = 0; i < N; i++) {
    const t = i / SR, bp = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t);
    out[i] = air[i] * (0.25 + 0.75 * bp * bp) * 0.8 + rum[i] * 3 + Math.sin(2 * Math.PI * 45 * t) * 0.05;
  }
  write('under_fan', cave(out, 0.25), { loop: true, peak: 0.75 });
}

// ---- slime burble: soft bubbling vowels, pitched, in phrases with pauses
{
  const N = Math.round(9 * SR), out = new Float32Array(N);
  let t0 = 0.2;
  while (t0 < 8.3) {
    const len = 0.25 + (rnd() * 0.5 + 0.5) * 0.6, f0 = 180 + (rnd() * 0.5 + 0.5) * 160, form = 500 + (rnd() * 0.5 + 0.5) * 900;
    const i0 = Math.round(t0 * SR), n = Math.round(len * SR);
    const tone = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR, f = f0 * (1 + 0.25 * Math.sin(t * 11 + f0) + 0.15 * (t / len));
      const env = Math.sin(Math.PI * Math.min(1, t / len)) ** 2;
      // A wobbly, bubbly carrier (amplitude flutter like air through liquid).
      tone[i] = (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(4 * Math.PI * f * t)) * env * (0.6 + 0.4 * Math.sin(t * 2 * Math.PI * 18));
    }
    const shaped = bandpass(tone, form, 1.4);
    for (let i = 0; i < n && i0 + i < N; i++) out[i0 + i] += shaped[i];
    t0 += len + (rnd() > 0.4 ? 0.05 : 0.4 + (rnd() * 0.5 + 0.5) * 0.6);
  }
  write('slime_burble', loopify(cave(out, 0.4), 0.4), { loop: true, peak: 0.6 });
}

// ---- squish: a wet, low squelch (filtered noise burst with a pitch drop)
for (const k of [1, 2]) {
  const N = Math.round(0.45 * SR), out = new Float32Array(N);
  const noise = new Float32Array(N); for (let i = 0; i < N; i++) noise[i] = rnd();
  const wet = bandpass(noise, (t) => 900 * Math.exp(-t * (k === 1 ? 6 : 9)) + 200, 2.2);
  for (let i = 0; i < N; i++) {
    const t = i / SR, env = Math.min(1, t * 120) * Math.exp(-t * 9);
    out[i] = wet[i] * env + Math.sin(2 * Math.PI * (160 - t * 200) * t) * env * 0.3;
  }
  write(`slime_squish_${k}`, cave(out, 0.3), { fadeOut: 0.06 });
}

// ---- gift: a soft glassy chime (three partials, slow decay)
{
  const N = Math.round(1.8 * SR), out = new Float32Array(N);
  for (const [f, d, g] of [[1046.5, 0, 1], [1568, 0.09, 0.7], [2093, 0.2, 0.5], [2637, 0.32, 0.3]]) {
    const i0 = Math.round(d * SR);
    for (let i = 0; i + i0 < N; i++) {
      const t = i / SR, env = Math.min(1, t * 400) * Math.exp(-t * 2.6);
      out[i0 + i] += (Math.sin(2 * Math.PI * f * t) + 0.2 * Math.sin(2 * Math.PI * f * 2.76 * t) * Math.exp(-t * 8)) * env * g;
    }
  }
  write('slime_gift', cave(out, 0.35, 1.2), { fadeOut: 0.2, peak: 0.6 });
}
