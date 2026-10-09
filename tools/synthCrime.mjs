// Procedural sounds for the street-crime layer (public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   siren_loop    police siren "wail" (seamless loop)          siren_short   a single whoop
//   alarm_bell    shop alarm bell, hammer on a bell (loop)      cuffs         handcuffs ratcheting shut
//   crowd_cheer   a small crowd cheering and clapping
// (Cries, shouts and animal calls are speech bubbles now: src/ui/voices.ts.)
import { writeFileSync } from 'node:fs';

const SR = 22050;
let s = 0x5eed1234;
const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

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

/**
 * A voiced sound: f0(t) Hz, formants(t) → [[freq, bandwidth, gain], …], amp(t), breath noise share.
 */
function voice(N, f0, formants, amp, breath = 0.05, tilt = 0.7, jit = 0.004) {
  const out = new Float32Array(N);
  let ph = 0, j = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    j = j * 0.995 + rnd() * jit;
    const f = f0(t) * (1 + j);
    ph += (2 * Math.PI * f) / SR;
    const F = formants(t);
    let v = 0;
    for (let k = 1; k * f < SR * 0.45 && k < 60; k++) {
      const hf = k * f;
      let g = 0;
      for (const [ff, bw, a] of F) { const d = (hf - ff) / bw; g += a * Math.exp(-0.5 * d * d); }
      v += Math.sin(ph * k) * g / Math.pow(k, tilt * 0.3);
    }
    out[i] = (v + rnd() * breath * 3) * amp(t);
  }
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

// ---------------------------------------------------------------- siren (wail)
{
  const period = 3.4, N = Math.round(SR * (period * 2 + 0.4));
  const out = new Float32Array(N);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const u = (t % period) / period;
    // Rise fast, fall slower (a motor siren), 620 … 1480 Hz.
    const sw = u < 0.42 ? smooth(0, 0.42, u) : 1 - smooth(0.42, 1, u);
    const f = 620 + 860 * sw;
    ph += (2 * Math.PI * f) / SR;
    out[i] = Math.sin(ph) * 0.8 + Math.sin(ph * 2) * 0.22 + Math.sin(ph * 3) * 0.12 + Math.sin(ph * 5) * 0.05;
  }
  // A touch of a loudspeaker horn: band-limited.
  const b = bandpass(out, 1400, 0.9);
  for (let i = 0; i < N; i++) out[i] = out[i] * 0.7 + b[i] * 0.6;
  write('siren_loop', loopify(out, 0.4), { loop: true });
}
{
  const N = Math.round(SR * 0.9);
  const out = new Float32Array(N);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const f = 520 + 1000 * smooth(0, 0.55, t) - 300 * smooth(0.55, 0.9, t);
    ph += (2 * Math.PI * f) / SR;
    out[i] = (Math.sin(ph) * 0.8 + Math.sin(ph * 2) * 0.2 + Math.sin(ph * 3) * 0.1) * smooth(0, 0.03, t) * (1 - smooth(0.6, 0.9, t));
  }
  write('siren_short', out);
}

// ---------------------------------------------------------------- alarm bell
{
  const N = Math.round(SR * 2.0);
  const out = new Float32Array(N);
  const parts = [[1, 1], [2.0, 0.5], [2.76, 0.35], [5.4, 0.18], [8.93, 0.08]];
  const f0 = 1180;
  // Hammer strikes at 17 Hz; each excites the partials, which ring and overlap.
  for (let h = 0; h < 34; h++) {
    const i0 = Math.round((h / 17) * SR);
    for (const [r, a] of parts) {
      const f = f0 * r, dec = 0.18 / r;
      for (let i = 0; i < SR * 0.5 && i0 + i < N; i++) {
        const t = i / SR;
        out[i0 + i] += Math.sin(2 * Math.PI * f * t) * a * Math.exp(-t / dec) * (0.85 + 0.15 * Math.sin(h));
      }
    }
    for (let i = 0; i < 40 && i0 + i < N; i++) out[i0 + i] += rnd() * 0.5 * Math.exp(-i / 8);
  }
  // Wrap the ringing tail into the start so the loop is seamless.
  const L = Math.round(SR * 2.0);
  write('alarm_bell', out.slice(0, L), { loop: true });
}

// ---------------------------------------------------------------- handcuffs
{
  const N = Math.round(SR * 0.95);
  const out = new Float32Array(N);
  const ratchet = (t0, n, rate, gain) => {
    for (let k = 0; k < n; k++) {
      const i0 = Math.round((t0 + k / rate) * SR);
      for (let i = 0; i < 160 && i0 + i < N; i++) out[i0 + i] += rnd() * Math.exp(-i / 25) * gain * (0.7 + 0.3 * Math.abs(rnd()));
      // Metallic ring.
      for (let i = 0; i < 1200 && i0 + i < N; i++) out[i0 + i] += Math.sin(2 * Math.PI * 3150 * i / SR) * 0.05 * gain * Math.exp(-i / 300);
    }
  };
  ratchet(0.02, 9, 42, 1);
  ratchet(0.48, 7, 46, 0.85);
  const b = bandpass(out, 4200, 0.7);
  for (let i = 0; i < N; i++) out[i] = b[i] * 1.2 + out[i] * 0.3;
  write('cuffs', out);
}

// ---------------------------------------------------------------- crowd cheer
{
  const N = Math.round(SR * 2.6);
  const out = new Float32Array(N);
  for (let k = 0; k < 14; k++) {
    const female = k % 2 === 0;
    const base = (female ? 240 : 140) * (1 + rnd() * 0.15);
    const t0 = Math.abs(rnd()) * 0.35, dur = 1.0 + Math.abs(rnd()) * 1.0;
    const n = Math.round(dur * SR);
    const vow = Math.abs(rnd());
    const v = voice(n, (t) => base * (1 + 0.25 * smooth(0, 0.3, t) - 0.15 * smooth(0.4, dur, t)), () => vow > 0.5 ? [[750, 150, 1], [1200, 200, 0.6], [2600, 300, 0.2]] : [[550, 150, 1], [1800, 200, 0.6], [2600, 300, 0.25]], (t) => smooth(0, 0.12, t) * (1 - smooth(dur * 0.5, dur, t)), 0.08, 0.6, 0.01);
    const i0 = Math.round(t0 * SR);
    for (let i = 0; i < n && i0 + i < N; i++) out[i0 + i] += v[i] * 0.25;
  }
  // Clapping: many hands, random claps.
  const claps = new Float32Array(N);
  for (let c = 0; c < 140; c++) {
    const t0 = 0.2 + Math.abs(rnd()) * 2.2, i0 = Math.round(t0 * SR);
    const g = Math.exp(-Math.max(0, t0 - 1.6) * 1.5);
    for (let i = 0; i < 220 && i0 + i < N; i++) claps[i0 + i] += rnd() * Math.exp(-i / 40) * g;
  }
  const cb = bandpass(claps, 1600, 0.8);
  for (let i = 0; i < N; i++) out[i] += cb[i] * 0.55;
  write('crowd_cheer', out, { fadeOut: 0.25 });
}
