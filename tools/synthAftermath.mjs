// Procedural sounds for the last resort and the aftermath (public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   nuke_siren        the civil-defence "attack" warning (loop): a motor siren wailing up and down fast, a
//                     second rotor a fifth above, echoing over the city — not the slow evacuation wind-up
//   blast_rumble      a strike far off: a dull flat crack, then a deep rumble rolling on for seconds
//   trapped_call      a muffled call for help from under rubble: a two-syllable voice-like cry, dull and
//                     boxed in (no words to make out)
//   dig_rubble        digging through rubble by hand: scrapes, a shifting slab, stones clattering
//   ambulance_siren   an ambulance's two-tone siren (loop)
//   crane_machinery   a mobile crane at work (loop): diesel idle, hydraulic whine, a chain clinking
// Run: node tools/synthAftermath.mjs
import { writeFileSync } from 'node:fs';

const SR = 22050;
let s = 0x5eed1e55;
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

function highpass(src, fc) {
  const lp = lowpass(src, fc);
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] - lp[i];
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

/** Echoes (facades, the open city): delayed, quieter copies; `wrap` for loops (seamless). */
function echo(x, taps, wrap = false) {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i];
  for (const [d, g] of taps) {
    const o = Math.round(d * SR);
    for (let i = 0; i < x.length; i++) {
      const j = i - o;
      if (j >= 0) out[i] += x[j] * g;
      else if (wrap) out[i] += x[j + x.length] * g;
    }
  }
  return out;
}

function write(name, out, { fadeOut = 0.05, peak: want = 0.89, loop = false } = {}) {
  const N = out.length;
  if (!loop) { const fade = Math.round(SR * fadeOut); for (let i = N - fade; i < N; i++) out[i] *= (N - i) / fade; }
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
  const g = want / (peak || 1);
  const buf = Buffer.alloc(44 + N * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(N * 2, 40);
  for (let i = 0; i < N; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(out[i] * g * 32767))), 44 + i * 2);
  writeFileSync(new URL(`../public/sounds/${name}.wav`, import.meta.url), buf);
  console.log(`${name}.wav`, (buf.length / 1024).toFixed(0), 'KB');
}

/** A motor siren's tone: the rotor's ports chop the air — a buzzy wave with a few strong harmonics. */
function sirenWave(ph) {
  return Math.sin(ph) + 0.55 * Math.sin(2 * ph + 0.3) + 0.32 * Math.sin(3 * ph + 0.9) + 0.18 * Math.sin(5 * ph + 1.7);
}

// ---------------------------------------------------------------- the attack warning (loop)
{
  // 12 s, a whole number of wails (period 3 s) so the loop is seamless; two rotors a fifth apart.
  const T = 12, N = T * SR, P = 3;
  const out = new Float32Array(N);
  let p1 = 0, p2 = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / P);
    const f = 390 + 260 * w;
    p1 += (2 * Math.PI * f) / SR;
    p2 += (2 * Math.PI * f * 1.5) / SR;
    out[i] = (sirenWave(p1) * 0.6 + sirenWave(p2) * 0.4) * (0.7 + 0.3 * w);
  }
  // Air, distance, the city answering.
  let x = lowpass(out, 2600);
  for (let i = 0; i < N; i++) x[i] += rnd() * 0.012;
  x = echo(x, [[0.37, 0.32], [0.81, 0.22], [1.43, 0.14], [2.2, 0.08]], true);
  write('nuke_siren', x, { loop: true, peak: 0.8 });
}

// ---------------------------------------------------------------- a strike far off
{
  const T = 9, N = T * SR;
  const out = new Float32Array(N);
  // A flat crack (the shock front, dulled by distance), then the rumble rolling for seconds.
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const crack = rnd() * Math.exp(-t * 18) * 0.9;
    ph += (2 * Math.PI * (28 + 16 * Math.exp(-t * 0.8))) / SR;
    const roll = (0.55 + 0.45 * Math.sin(t * 1.7 + 0.4 * Math.sin(t * 5.1))) * smooth(0, 0.25, t) * Math.exp(-t * 0.42);
    out[i] = crack + rnd() * roll * 0.7 + Math.sin(ph) * roll * 0.9;
  }
  let x = lowpass(out, (t) => 220 + 900 * Math.exp(-t * 4));
  x = lowpass(x, 600);
  x = echo(x, [[0.6, 0.35], [1.4, 0.25], [2.5, 0.15]]);
  write('blast_rumble', x, { fadeOut: 1.2, peak: 0.95 });
}

// ---------------------------------------------------------------- a muffled call for help
{
  const T = 1.5, N = Math.round(T * SR);
  const out = new Float32Array(N);
  // Two syllables ("he-elp" in shape, no words): a pitched voice through vowel formants.
  const syl = [[0.05, 0.42, 230, 250], [0.55, 1.15, 255, 205]];
  let ph = 0;
  const src = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    let a = 0, f = 220;
    for (const [t0, t1, fa, fb] of syl) if (t >= t0 && t < t1) { const k = (t - t0) / (t1 - t0); a = smooth(0, 0.12, k) * (1 - smooth(0.7, 1, k)); f = fa + (fb - fa) * k + 4 * Math.sin(t * 34); }
    ph += (2 * Math.PI * f) / SR;
    // Glottal pulse: a sawtooth with a soft edge.
    const saw = ((ph / (2 * Math.PI)) % 1) * 2 - 1;
    src[i] = a * (saw * 0.8 + rnd() * 0.15);
  }
  const f1 = bandpass(src, (t) => (t < 0.5 ? 560 : 640), 0.25), f2 = bandpass(src, (t) => (t < 0.5 ? 1800 : 1250), 0.3), f3 = bandpass(src, 2500, 0.4);
  for (let i = 0; i < N; i++) out[i] = f1[i] + f2[i] * 0.6 + f3[i] * 0.25;
  // Under rubble: dull, boxed in, a short slap.
  let x = lowpass(out, 950);
  x = lowpass(x, 1400);
  x = echo(x, [[0.045, 0.45], [0.09, 0.25], [0.16, 0.12]]);
  write('trapped_call', x, { fadeOut: 0.15, peak: 0.75 });
}

// ---------------------------------------------------------------- digging through rubble
{
  const T = 1.4, N = Math.round(T * SR);
  const out = new Float32Array(N);
  // Scrapes: noise swells; a slab shifting (a low grind); stones knocking.
  for (const [t0, len, g] of [[0.0, 0.35, 0.6], [0.45, 0.4, 0.8], [0.95, 0.3, 0.5]]) {
    for (let i = Math.round(t0 * SR); i < Math.min(N, Math.round((t0 + len) * SR)); i++) {
      const k = (i / SR - t0) / len;
      out[i] += rnd() * g * Math.sin(Math.PI * k) * (0.6 + 0.4 * Math.sin(i / SR * 90));
    }
  }
  let scr = bandpass(out, 1900, 0.6);
  let grind = new Float32Array(N);
  let ph = 0;
  for (let i = 0; i < N; i++) { const t = i / SR; ph += (2 * Math.PI * (55 + 20 * rnd())) / SR; grind[i] = Math.sin(ph) * smooth(0.4, 0.55, t) * (1 - smooth(0.75, 0.95, t)) * 0.5; }
  grind = lowpass(grind, 300);
  const clk = new Float32Array(N);
  for (let n = 0; n < 14; n++) {
    const at = Math.round((0.05 + ((n * 0.61803) % 1) * 1.25) * SR), f = 900 + ((n * 37) % 11) * 230, g = 0.35 + ((n * 13) % 7) * 0.08;
    for (let i = at; i < Math.min(N, at + 0.08 * SR); i++) { const t = (i - at) / SR; clk[i] += Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 70) * g + rnd() * Math.exp(-t * 200) * g * 0.6; }
  }
  for (let i = 0; i < N; i++) out[i] = scr[i] * 0.8 + grind[i] + clk[i];
  write('dig_rubble', lowpass(out, 6000), { fadeOut: 0.1, peak: 0.8 });
}

// ---------------------------------------------------------------- the ambulance's two-tone (loop)
{
  // Hi–lo, 0.55 s each: 2.2 s (two cycles), seamless.
  const half = 0.55, T = half * 4, N = Math.round(T * SR);
  const out = new Float32Array(N);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR, k = Math.floor(t / half) % 2;
    const f = k === 0 ? 660 : 495;
    ph += (2 * Math.PI * f) / SR;
    // A horn's buzzy square-ish wave.
    out[i] = Math.tanh(Math.sin(ph) * 2.2) * 0.7 + Math.sin(2 * ph) * 0.15;
  }
  let x = highpass(lowpass(out, 3800), 250);
  x = echo(x, [[0.21, 0.22], [0.47, 0.12]], true);
  write('ambulance_siren', x, { loop: true, peak: 0.75 });
}

// ---------------------------------------------------------------- a crane at work (loop)
{
  const T = 6, N = T * SR;
  const out = new Float32Array(N);
  // Diesel idle: firing pulses at ~24 Hz (a whole number of them in the loop).
  const fire = 24;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const pulse = Math.pow(0.5 + 0.5 * Math.cos(2 * Math.PI * fire * t), 6);
    out[i] = pulse * (0.7 + 0.3 * Math.sin(2 * Math.PI * t / 3)) + rnd() * 0.08;
  }
  let x = lowpass(out, 420);
  // Hydraulic whine swelling and easing (the boom moving), twice per loop.
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR, w = Math.pow(Math.sin((Math.PI * t) / 3), 2);
    ph += (2 * Math.PI * (380 + 140 * w)) / SR;
    x[i] += Math.sin(ph) * 0.12 * w + Math.sin(ph * 2.01) * 0.04 * w;
  }
  // A chain clinking now and then.
  for (const at of [0.8, 1.05, 1.3, 3.9, 4.1, 4.45]) {
    const i0 = Math.round(at * SR);
    for (let i = i0; i < Math.min(N, i0 + 0.12 * SR); i++) { const t = (i - i0) / SR; x[i] += (Math.sin(2 * Math.PI * 2300 * t) + 0.6 * Math.sin(2 * Math.PI * 3700 * t)) * Math.exp(-t * 45) * 0.18; }
  }
  x = echo(x, [[0.18, 0.2], [0.41, 0.1]], true);
  write('crane_machinery', x, { loop: true, peak: 0.7 });
}
