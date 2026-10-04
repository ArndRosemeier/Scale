// Procedural sounds of the street characters (public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   street_guitar   a seamless loop: a busker's acoustic guitar, strummed chords (C Am F G, then
//                   Am F C G) at 92 bpm, plucked strings by Karplus-Strong with a little body resonance
//   street_beat     a seamless loop: a boombox playing a boom-bap beat (kick, snare, hats, a bass line),
//                   a bit boxy and lo-fi as from a small speaker
//   street_coin     a coin dropped into a hat / guitar case: a bright clink and a short rattle
// Run: node tools/synthStreet.mjs
import { writeFileSync } from 'node:fs';

const SR = 22050;
let s = 0x5717ee7;
const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
const u01 = () => (rnd() + 1) / 2;

function lowpass(x, fc) {
  const out = new Float32Array(x.length);
  const a = 1 - Math.exp((-2 * Math.PI * fc) / SR);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y += a * (x[i] - y); out[i] = y; }
  return out;
}
function highpass(x, fc) {
  const lp = lowpass(x, fc);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] - lp[i];
  return out;
}

/** Cross-fade the tail (XF s past the loop length) into the start: a seamless loop of N - XF samples. */
function loopify(x, xf) {
  const n = Math.round(xf * SR), N = x.length - n;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = x[i];
  for (let i = 0; i < n; i++) { const t = i / n; out[i] = x[i] * t + x[N + i] * (1 - t); }
  return out;
}

function write(name, out) {
  const N = out.length;
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
  const g = 0.85 / (peak || 1);
  const buf = Buffer.alloc(44 + N * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(N * 2, 40);
  for (let i = 0; i < N; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(out[i] * g * 32767))), 44 + i * 2);
  writeFileSync(new URL(`../public/sounds/${name}.wav`, import.meta.url), buf);
  console.log(`${name}.wav`, (buf.length / 1024).toFixed(0), 'KB');
}

/** A plucked string (Karplus-Strong) added into `mix` at time t (s): frequency f, gain, decay (s). */
function pluck(mix, t, f, gain, decay = 2.2, bright = 0.5) {
  const i0 = Math.round(t * SR);
  const P = Math.max(2, Math.round(SR / f));
  const buf = new Float32Array(P);
  // Pick position: a softer pick is a smoothed burst.
  let prev = 0;
  for (let k = 0; k < P; k++) { const n = rnd(); prev = prev * (1 - bright) + n * bright; buf[k] = prev; }
  const loss = Math.pow(0.001, 1 / (decay * f));
  const len = Math.min(mix.length - i0, Math.round(decay * SR * 1.2));
  let p = 0;
  for (let i = 0; i < len; i++) {
    const a = buf[p], b = buf[(p + 1) % P];
    const y = (a + b) * 0.5 * loss;
    buf[p] = y;
    p = (p + 1) % P;
    if (i0 + i >= 0) mix[i0 + i] += a * gain;
  }
}

const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12);
// Open chords, low string to high (MIDI notes).
const CHORDS = {
  C: [48, 52, 55, 60, 64],
  Am: [45, 52, 57, 60, 64],
  F: [41, 48, 53, 57, 60, 65],
  G: [43, 47, 50, 55, 59, 67],
};

// ---------------------------------------------------------------- busker's guitar
{
  const bpm = 92, beat = 60 / bpm, bar = beat * 4;
  const prog = ['C', 'Am', 'F', 'G', 'Am', 'F', 'C', 'G'];
  const L = prog.length * bar, XF = 1.2, N = Math.round(SR * (L + XF + 2.5));
  const mix = new Float32Array(N);
  // Strum pattern (in eighths): D . D U . U D U
  const pat = [['D', 1], null, ['D', 0.7], ['U', 0.55], null, ['U', 0.6], ['D', 0.8], ['U', 0.5]];
  // The bars past the loop end repeat the start (so the cross-fade joins the same music).
  for (let b = 0; b < prog.length + 1; b++) {
    const ch = CHORDS[prog[b % prog.length]];
    for (let e = 0; e < 8; e++) {
      const st = pat[e];
      if (!st) continue;
      const [dir, g] = st;
      const t0 = b * bar + e * beat / 2 + (u01() - 0.5) * 0.012;
      const strings = dir === 'D' ? ch : [...ch].reverse().slice(0, 4);
      strings.forEach((n, k) => pluck(mix, t0 + k * 0.011, NOTE(n), g * (dir === 'U' ? 0.6 : 1) * (0.8 + u01() * 0.3), 1.6 + u01() * 0.6, 0.55));
    }
  }
  // Body: a little low resonance, less fizz.
  let out = lowpass(mix, 3800);
  const body = lowpass(highpass(mix, 90), 260);
  for (let i = 0; i < N; i++) out[i] = out[i] * 0.85 + body[i] * 0.5;
  write('street_guitar', loopify(out.slice(0, Math.round(SR * (L + XF))), XF));
}

// ---------------------------------------------------------------- boombox beat
{
  const bpm = 92, beat = 60 / bpm, bar = beat * 4, bars = 4;
  const L = bars * bar, XF = 0.4, N = Math.round(SR * (L + XF + 1));
  const mix = new Float32Array(N);
  const add = (t, f) => { const i0 = Math.round(t * SR); for (let i = 0; i0 + i < N && i < SR; i++) { const v = f(i / SR); if (v === null) break; mix[i0 + i] += v; } };
  const kick = (t) => add(t, (x) => (x > 0.35 ? null : Math.sin(2 * Math.PI * (45 * x + 60 * (1 - Math.exp(-x * 30)) / 30)) * Math.exp(-x * 9) * 0.9));
  const snare = (t) => add(t, (x) => (x > 0.25 ? null : (rnd() * 0.7 * Math.exp(-x * 18) + Math.sin(2 * Math.PI * 190 * x) * 0.35 * Math.exp(-x * 25))));
  const hat = (t, g) => add(t, (x) => (x > 0.06 ? null : rnd() * g * Math.exp(-x * 70)));
  const bass = (t, f, d) => add(t, (x) => (x > d ? null : Math.sin(2 * Math.PI * f * x) * 0.45 * Math.min(1, x * 80) * Math.exp(-x * 2)));
  const roots = [36, 36, 41, 43];
  for (let b = 0; b < bars + 1; b++) {
    const t = b * bar;
    kick(t); kick(t + beat * 1.5); kick(t + beat * 2.25);
    snare(t + beat); snare(t + beat * 3);
    for (let e = 0; e < 8; e++) hat(t + e * beat / 2 + (e % 2 ? 0.02 : 0), e % 2 ? 0.12 : 0.2);
    const r = NOTE(roots[b % bars]);
    bass(t, r, beat * 1.4); bass(t + beat * 1.5, r, beat * 0.4); bass(t + beat * 2.5, r * 1.5, beat * 0.9);
  }
  // A small speaker: no deep lows, no air, a little saturation.
  let out = lowpass(highpass(mix, 70), 5200);
  for (let i = 0; i < N; i++) out[i] = Math.tanh(out[i] * 1.6);
  write('street_beat', loopify(out.slice(0, Math.round(SR * (L + XF))), XF));
}

// ---------------------------------------------------------------- coin
{
  const N = Math.round(SR * 0.6);
  const out = new Float32Array(N);
  const ring = (t0, g, fs) => {
    const i0 = Math.round(t0 * SR);
    for (let i = 0; i0 + i < N; i++) {
      const x = i / SR;
      let v = 0;
      for (const [f, a, d] of fs) v += Math.sin(2 * Math.PI * f * x) * a * Math.exp(-x * d);
      out[i0 + i] += v * g;
    }
  };
  const partials = [[3150, 0.5, 22], [5480, 0.35, 30], [7900, 0.2, 45], [2240, 0.25, 26]];
  ring(0, 1, partials);
  ring(0.09, 0.45, partials.map(([f, a, d]) => [f * 1.02, a, d * 1.3]));
  ring(0.16, 0.25, partials.map(([f, a, d]) => [f * 0.98, a, d * 1.6]));
  // A soft thud of the hat / velvet underneath.
  for (let i = 0; i < 400; i++) out[i] += rnd() * 0.15 * Math.exp(-i / 60);
  write('street_coin', highpass(out, 400));
}
