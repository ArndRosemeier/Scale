// Procedural sounds for the giant mech (public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   mech_step    a footfall: a deep thud, a metal clang ringing off it, a hydraulic hiss
//   mech_launch  a missile leaving its tube: a sharp pop and a tearing rush of rocket exhaust
//   mech_cannon  a short burst (~0.35 s) of the rotary cannon: rapid hard pops over a motor whine
//   mech_vent    the heat vents opening: a clunk and a long roaring hiss of steam
//   mech_alarm   its warning klaxon: a two-tone blaring horn, echoing off the town
// Run: node tools/synthMech.mjs
// (The band-pass here stays below 3 kHz: the state-variable filter blows up above that.)
import { writeFileSync } from 'node:fs';

const SR = 22050;
let s = 0x3ec4a7;
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



const N = (T) => new Float32Array(Math.round(SR * T));
/** A struck metal plate: inharmonic partials decaying at their own rates. */
function clang(T, f0, partials, decay) {
  const out = N(T);
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    let v = 0;
    partials.forEach(([r, g, d], k) => { v += g * Math.sin(2 * Math.PI * f0 * r * t + k) * Math.exp(-t * decay * d); });
    out[i] = v * smooth(0, 0.002, t);
  }
  return out;
}
function mixInto(dst, src, at = 0, g = 1) { const o = Math.round(at * SR); for (let i = 0; i < src.length && i + o < dst.length; i++) dst[i + o] += src[i] * g; }
function noise(T, env) { const out = N(T); for (let i = 0; i < out.length; i++) out[i] = rnd() * env(i / SR); return out; }

// ---------------------------------------------------------------- the footfall
{
  const T = 1.6, out = N(T);
  // Thud: a falling sine with a soft noise body.
  let ph = 0;
  const thud = N(T);
  for (let i = 0; i < thud.length; i++) { const t = i / SR; ph += 2 * Math.PI * (32 + 70 * Math.exp(-t * 14)) / SR; thud[i] = Math.sin(ph) * Math.exp(-t * 4.5) * smooth(0, 0.004, t); }
  mixInto(out, thud, 0, 1);
  mixInto(out, lowpass(noise(T, (t) => Math.exp(-t * 9)), 300), 0, 0.8);
  // The clang of steel on steel, low and heavy.
  mixInto(out, lowpass(clang(T, 118, [[1, 0.6, 1], [2.76, 0.4, 1.6], [5.4, 0.25, 2.4], [8.9, 0.12, 3]], 3.2), 2400), 0.01, 0.55);
  // Hydraulics easing: a hiss after the weight lands.
  mixInto(out, bandpass(noise(0.7, (t) => smooth(0, 0.1, t) * (1 - smooth(0.2, 0.7, t))), 2600, 0.6), 0.22, 0.25);
  write('mech_step', echo(out, [[0, 1], [0.17, 0.22], [0.39, 0.1]]), { fadeOut: 0.3 });
}

// ---------------------------------------------------------------- a missile away
{
  const T = 1.5, out = N(T);
  mixInto(out, lowpass(noise(0.08, (t) => Math.exp(-t * 60)), 1800), 0, 1);
  // The motor: rough noise, bright at first, receding (pitch falls as it goes).
  const rush = noise(T, (t) => smooth(0, 0.03, t) * Math.exp(-t * 1.6) * (0.8 + 0.2 * Math.sin(t * 90)));
  mixInto(out, bandpass(rush, (t) => 2200 - t * 900, 0.5), 0, 0.8);
  mixInto(out, lowpass(rush, 500), 0, 0.6);
  write('mech_launch', echo(out, [[0, 1], [0.21, 0.25], [0.5, 0.12]]), { fadeOut: 0.4 });
}

// ---------------------------------------------------------------- a cannon burst
{
  const T = 0.6, out = N(T);
  for (let k = 0; k < 8; k++) {
    const at = k * 0.045;
    const pop = N(0.12);
    let ph = 0;
    for (let i = 0; i < pop.length; i++) { const t = i / SR; ph += 2 * Math.PI * (90 + 160 * Math.exp(-t * 40)) / SR; pop[i] = (Math.sin(ph) * 0.8 + rnd() * 0.9) * Math.exp(-t * 38); }
    mixInto(out, lowpass(pop, 2600), at, 0.9 + 0.1 * Math.sin(k));
  }
  // The barrels' motor whine under it.
  let wp = 0;
  for (let i = 0; i < out.length; i++) { const t = i / SR; wp += 2 * Math.PI * 420 / SR; out[i] += Math.sin(wp) * 0.08 * (1 - smooth(0.35, 0.6, t)); }
  write('mech_cannon', echo(out, [[0, 1], [0.12, 0.2]]), { fadeOut: 0.15 });
}

// ---------------------------------------------------------------- the vents
{
  const T = 3.0, out = N(T);
  mixInto(out, lowpass(clang(0.5, 140, [[1, 0.7, 1], [2.3, 0.3, 2]], 10), 1600), 0, 0.6);
  const hiss = noise(T, (t) => smooth(0.05, 0.35, t) * (1 - smooth(1.8, 3, t)) * (0.85 + 0.15 * Math.sin(t * 23)));
  mixInto(out, bandpass(hiss, 2800, 0.5), 0, 0.7);
  mixInto(out, lowpass(hiss, 700), 0, 0.5);
  write('mech_vent', out, { fadeOut: 0.5 });
}

// ---------------------------------------------------------------- the klaxon
{
  const T = 2.2, out = N(T);
  let p = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const f = Math.floor(t / 0.5) % 2 === 0 ? 392 : 311;
    p += 2 * Math.PI * f / SR;
    // A buzzy horn: a squared-off tone with odd harmonics.
    const v = Math.tanh(3 * (Math.sin(p) + 0.3 * Math.sin(3 * p)));
    out[i] = v * smooth(0, 0.03, t) * (1 - smooth(1.9, 2.2, t)) * (0.9 + 0.1 * Math.sin(2 * Math.PI * 6 * t));
  }
  write('mech_alarm', echo(lowpass(out, 2200), [[0, 1], [0.25, 0.35], [0.55, 0.2], [0.95, 0.1]]), { fadeOut: 0.3 });
}
