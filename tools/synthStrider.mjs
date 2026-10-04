// Procedural sounds for the Strider (public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   strider_step_1/2  a 40 m creature's footfall: a sub-bass boom, the ground thump, a rattle of
//                     debris and a long rumbling tail (two variants)
//   strider_roar      the two-tone roar: a bellow sliding up into a rasping upper tone, both
//                     voices beating against each other, ending in a guttural fall and the city's echo
//   strider_charge    the breath charging (≈2.2 s): a rising electric hum with a crackle building up
//   strider_breath    the breath (≈3.6 s): a roaring, tearing plasma rush with a sizzling top
//   tremor_rumble     an omen: the ground trembling far off, a low rumble with faint rattling
//   car_alarm         an omen: a car alarm going off (whooping siren, then a fast warble)
// Run: node tools/synthStrider.mjs
import { writeFileSync } from 'node:fs';

const SR = 22050;
let s = 0x5717de75;
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
    const f = 2 * Math.sin(Math.PI * Math.min(SR * 0.45, typeof fc === 'function' ? fc(i / SR) : fc) / SR);
    low += f * band;
    const high = src[i] - low - q * band;
    band += f * high;
    out[i] = band;
  }
  return out;
}

/** Echoes off facades: delayed, quieter, duller copies. */
function echo(x, taps) {
  const out = new Float32Array(x.length);
  for (const [d, g] of taps) { const o = Math.round(d * SR); for (let i = o; i < x.length; i++) out[i] += x[i - o] * g; }
  return out;
}

function write(name, out, { fadeOut = 0.05 } = {}) {
  const N = out.length;
  const fade = Math.round(SR * fadeOut); for (let i = N - fade; i < N; i++) out[i] *= (N - i) / fade;
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

// ---------------------------------------------------------------- footsteps
for (const v of [1, 2]) {
  const N = Math.round(SR * 3.2);
  const out = new Float32Array(N);
  const f0 = v === 1 ? 31 : 27;
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    // Sub-bass boom: a falling sine with a hard attack.
    const f = f0 + 38 * Math.exp(-t * 9);
    ph += (2 * Math.PI * f) / SR;
    const boom = Math.sin(ph) * Math.exp(-t * 2.2) * smooth(0, 0.008, t);
    // The thump of the ground: a short noise burst, low-passed.
    const thump = rnd() * Math.exp(-t * 26) * 0.9;
    // A long rumble (filtered noise below) and debris rattle (sparse clicks).
    const rumble = rnd() * Math.exp(-t * 1.2) * 0.35;
    const rattle = rnd() > 0.985 - 0.01 * Math.exp(-t * 3) ? rnd() * 0.6 * Math.exp(-t * 2.5) * smooth(0.05, 0.12, t) : 0;
    out[i] = boom * 1.0 + thump + rumble * 0.6 + rattle * 0.5;
  }
  const lo = lowpass(out, (t) => 220 + 1600 * Math.exp(-t * 18));
  const rat = bandpass(out, 2400, 0.6);
  const mix = new Float32Array(N);
  for (let i = 0; i < N; i++) mix[i] = lo[i] * 1.0 + rat[i] * 0.12;
  write(`strider_step_${v}`, echo(mix, [[0, 1], [0.21, 0.28], [0.47, 0.17], [0.9, 0.09]]), { fadeOut: 0.4 });
}

// ---------------------------------------------------------------- roar (two-tone)
{
  const T = 4.2, N = Math.round(SR * T);
  const dry = new Float32Array(N);
  let p1 = 0, p2 = 0, pg = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    // Envelope: a fast swell, a long hold, a guttural fall at the end.
    const env = smooth(0, 0.35, t) * (1 - smooth(3.0, 4.1, t));
    // Lower voice: a bellow sliding from 70 to 95 Hz, wobbling; upper voice: a rasping tone a
    // tritone-ish above, entering late and sliding up — the two-tone call.
    const vib = 1 + 0.03 * Math.sin(t * 2 * Math.PI * 5.5) + 0.02 * rnd();
    const f1 = (70 + 25 * smooth(0, 1.6, t) - 30 * smooth(2.9, 4.0, t)) * vib;
    const f2 = (198 + 70 * smooth(0.6, 2.2, t) - 90 * smooth(2.8, 4.0, t)) * vib;
    p1 += (2 * Math.PI * f1) / SR; p2 += (2 * Math.PI * f2) / SR;
    // Buzzy glottal source: a pulse train with many harmonics.
    const pulse = (p) => { const x = (p / (2 * Math.PI)) % 1; return Math.exp(-x * 9) * 2 - 0.22; };
    const lowV = pulse(p1) * 0.9;
    const highV = (pulse(p2) * 0.7 + rnd() * 0.25) * smooth(0.5, 1.0, t);
    // Growl: amplitude modulation at ~28 Hz (roughness).
    pg += (2 * Math.PI * 28) / SR;
    const growl = 0.7 + 0.3 * Math.sin(pg);
    dry[i] = (lowV + highV) * growl * env + rnd() * 0.12 * env;
  }
  // Formants: a big throat (two resonances that open up), body, rasp.
  const fA = bandpass(dry, (t) => 380 + 240 * smooth(0.2, 1.4, t), 0.35);
  const fB = bandpass(dry, (t) => 1100 + 500 * smooth(0.6, 2.2, t), 0.45);
  const body = lowpass(dry, 260);
  const mix = new Float32Array(N);
  for (let i = 0; i < N; i++) mix[i] = body[i] * 0.9 + fA[i] * 1.1 + fB[i] * 0.55;
  write('strider_roar', echo(lowpass(mix, 4200), [[0, 1], [0.23, 0.35], [0.52, 0.22], [0.95, 0.13], [1.5, 0.07]]), { fadeOut: 0.3 });
}

// ---------------------------------------------------------------- breath charging
{
  const T = 2.3, N = Math.round(SR * T);
  const out = new Float32Array(N);
  let ph = 0, pw = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR, k = t / T;
    // A hum rising an octave and a fifth, with a wobbling sub; crackle builds up.
    const f = 55 * Math.pow(2, 1.6 * k * k);
    ph += (2 * Math.PI * f) / SR;
    pw += (2 * Math.PI * f * 3.01) / SR;
    const hum = (Math.sin(ph) * 0.7 + Math.sin(pw) * 0.25 * k) * smooth(0, 0.2, t);
    const crack = rnd() > 0.995 - 0.02 * k * k ? rnd() * (0.4 + k) : 0;
    const hiss = rnd() * 0.08 * k * k;
    out[i] = hum * (0.5 + 0.5 * k) + crack + hiss;
  }
  write('strider_charge', lowpass(out, 5000), { fadeOut: 0.06 });
}

// ---------------------------------------------------------------- breath
{
  const T = 3.8, N = Math.round(SR * T);
  const src = new Float32Array(N);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const env = smooth(0, 0.12, t) * (1 - smooth(3.2, 3.8, t));
    ph += (2 * Math.PI * (48 + 6 * Math.sin(t * 7))) / SR;
    // A tearing rush (noise), a deep roar under it, a sizzling top that flickers.
    const rush = rnd();
    const roar = Math.sin(ph) * 0.6 + Math.sin(ph * 2.03) * 0.3;
    const sizzle = rnd() * (0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 13)) * 0.35;
    src[i] = (rush * 0.8 + roar * 0.6) * env;
    src[i + 0] += sizzle * env;
  }
  const lo = lowpass(src, 900), mid = bandpass(src, (t) => 1600 + 600 * Math.sin(t * 3), 0.5), hi = bandpass(src, 5200, 0.7);
  const mix = new Float32Array(N);
  for (let i = 0; i < N; i++) mix[i] = lo[i] * 1.0 + mid[i] * 0.6 + hi[i] * 0.25;
  write('strider_breath', mix, { fadeOut: 0.25 });
}

// ---------------------------------------------------------------- tremor (omen)
{
  const T = 3.4, N = Math.round(SR * T);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const env = smooth(0, 0.8, t) * (1 - smooth(2.2, 3.4, t));
    const shake = 0.6 + 0.4 * Math.sin(t * 2 * Math.PI * 7.5 + Math.sin(t * 3));
    const rattle = rnd() > 0.992 ? rnd() * 0.5 : 0;
    out[i] = rnd() * env * shake + rattle * env;
  }
  const lo = lowpass(lowpass(out, 90), 120), rat = bandpass(out, 3000, 0.8);
  const mix = new Float32Array(N);
  for (let i = 0; i < N; i++) mix[i] = lo[i] * 4 + rat[i] * 0.15;
  write('tremor_rumble', mix, { fadeOut: 0.3 });
}

// ---------------------------------------------------------------- car alarm (omen)
{
  const T = 2.6, N = Math.round(SR * T);
  const out = new Float32Array(N);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    // Whoop up (0–1.2 s, three sweeps), then a fast two-tone warble.
    let f;
    if (t < 1.2) f = 900 + 900 * ((t * 2.5) % 1);
    else f = ((t * 9) % 1) < 0.5 ? 1500 : 1100;
    ph += (2 * Math.PI * f) / SR;
    const sq = Math.sign(Math.sin(ph)) * 0.5 + Math.sin(ph) * 0.4;
    out[i] = sq * smooth(0, 0.02, t);
  }
  write('car_alarm', bandpass(out, 1400, 0.5).map((v, i) => v * 0.7 + out[i] * 0.3), { fadeOut: 0.05 });
}
