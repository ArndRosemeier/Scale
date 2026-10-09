// Procedural sounds for the Burrower (public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   burrower_rumble      (loop) the worm tunnelling under the street: a deep grinding rumble,
//                        rock crunching, a slow surge (seamless)
//   burrower_rumble_far  an omen: a long low rumble from under the street, a faint grinding
//   burrower_breach      the street caving in: asphalt cracking, a deep collapse boom, debris raining
//   burrower_roar        its call: a chorus of shrieking, grinding voices over a wet low gurgle,
//                        ending in a clicking rattle of the petals
//   burrower_slam        the head coming down on the street: a heavy thud, a crunch, a rumbling tail
//   burrower_dive        diving back in: a rush of air, soil and stone torn up, grinding away below
// Run: node tools/synthBurrower.mjs
// (Filters stay below ~3 kHz: the Chamberlin band-pass is unstable above ~3.7 kHz at 22.05 kHz.)
import { writeFileSync } from 'node:fs';

const SR = 22050;
let s = 0xb0bb1e55;
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

// ---------------------------------------------------------------- tunnelling (loop)
{
  const T = 6, N = Math.round(SR * T), X = Math.round(SR * 0.8);
  const L = N + X;
  const r = lowpass(rumble(L, 0.7, 1 / 3), 90);
  const c = bandpass(crunch(L, 28, 45), 700, 0.7);
  const g = bandpass(rumble(L, 0.3, 0.5), 240, 0.3);
  const mix = new Float32Array(L);
  for (let i = 0; i < L; i++) mix[i] = r[i] * 2.2 + c[i] * 0.35 + g[i] * 0.6;
  // Seamless: the extra tail crossfaded over the start.
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = mix[i];
  for (let i = 0; i < X; i++) { const k = i / X; out[i] = mix[i] * k + mix[N + i] * (1 - k); }
  write('burrower_rumble', out, { fadeOut: 0 });
}

// ---------------------------------------------------------------- the omen: far rumble
{
  const T = 4, N = Math.round(SR * T);
  const env = (t) => smooth(0, 0.8, t) * (1 - smooth(2.6, 4, t));
  const r = lowpass(rumble(N, 0.5, 0.6), 70);
  const c = bandpass(crunch(N, 10, 40, env), 500, 0.8);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = r[i] * env(i / SR) * 2.4 + c[i] * 0.2;
  write('burrower_rumble_far', out, { fadeOut: 0.4 });
}

// ---------------------------------------------------------------- the street caving in
{
  const T = 3.4, N = Math.round(SR * T);
  const out = new Float32Array(N);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    // Cracks first (0–0.5 s), the drop's boom at 0.45 s, a long rumble.
    const crack = t < 0.55 && rnd() > 0.992 - 0.02 * smooth(0, 0.5, t) ? rnd() * 0.9 : 0;
    const tb = Math.max(0, t - 0.45);
    ph += (2 * Math.PI * (26 + 40 * Math.exp(-tb * 7))) / SR;
    const boom = t > 0.45 ? Math.sin(ph) * Math.exp(-tb * 1.6) * smooth(0, 0.01, tb) : 0;
    const thud = t > 0.45 ? rnd() * Math.exp(-tb * 18) : 0;
    out[i] = crack + boom * 1.3 + thud * 0.8;
  }
  const deb = bandpass(crunch(N, 80, 30, (t) => smooth(0.5, 0.8, t) * Math.exp(-(t - 0.5) * 1.1)), 1200, 0.6);
  const lo = lowpass(out, (t) => 260 + 2400 * Math.exp(-Math.max(0, t - 0.45) * 10));
  const crk = bandpass(out, 2200, 0.5);
  const mix = new Float32Array(N);
  for (let i = 0; i < N; i++) mix[i] = lo[i] + crk[i] * 0.25 + deb[i] * 0.35;
  write('burrower_breach', echo(mix, [[0, 1], [0.19, 0.3], [0.44, 0.18], [0.86, 0.1]]), { fadeOut: 0.5 });
}

// ---------------------------------------------------------------- the roar
{
  const T = 3.8, N = Math.round(SR * T);
  const dry = new Float32Array(N);
  const voices = [310, 377, 452, 541, 655].map((f, k) => ({ f, ph: 0, wob: 4 + k * 1.3, d: k * 0.07 }));
  let pl = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const env = smooth(0, 0.25, t) * (1 - smooth(2.5, 3.3, t));
    let v = 0;
    for (const V of voices) {
      // A shriek sliding up and down, each voice wobbling against the others (the grinding).
      const f = V.f * (1 + 0.28 * smooth(V.d, 0.9 + V.d, t) - 0.35 * smooth(2.0, 3.2, t)) * (1 + 0.025 * Math.sin(2 * Math.PI * V.wob * t));
      V.ph += (2 * Math.PI * f) / SR;
      const x = (V.ph / (2 * Math.PI)) % 1;
      v += (x < 0.5 ? 4 * x - 1 : 3 - 4 * x) * 0.35 + (Math.exp(-x * 7) - 0.14) * 0.3;
    }
    // A wet low gurgle under it (amplitude-modulated low voice).
    pl += (2 * Math.PI * (58 + 8 * Math.sin(t * 3))) / SR;
    const gurgle = Math.sin(pl) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 17 * t)) * smooth(0, 0.5, t) * (1 - smooth(2.8, 3.4, t));
    // The petals' rattle at the end.
    const click = t > 2.6 && t < 3.7 && (i % Math.round(SR / (34 - 10 * (t - 2.6)))) < 40 ? rnd() * 0.9 * (1 - smooth(3.2, 3.7, t)) : 0;
    dry[i] = v * env * (0.75 + 0.25 * rnd()) + gurgle * 0.9 + click;
  }
  const fA = bandpass(dry, (t) => 900 + 500 * smooth(0.2, 1.2, t), 0.4);
  const fB = bandpass(dry, 2200, 0.5);
  const body = lowpass(dry, 300);
  const mix = new Float32Array(N);
  for (let i = 0; i < N; i++) mix[i] = body[i] * 0.9 + fA[i] * 1.0 + fB[i] * 0.45;
  write('burrower_roar', echo(lowpass(mix, 4500), [[0, 1], [0.26, 0.33], [0.58, 0.2], [1.05, 0.12], [1.6, 0.06]]), { fadeOut: 0.25 });
}

// ---------------------------------------------------------------- the slam
{
  const T = 2.6, N = Math.round(SR * T);
  const out = new Float32Array(N);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (34 + 50 * Math.exp(-t * 10))) / SR;
    out[i] = Math.sin(ph) * Math.exp(-t * 2.4) * smooth(0, 0.006, t) * 1.2 + rnd() * Math.exp(-t * 30) + rnd() * Math.exp(-t * 1.6) * 0.25;
  }
  const deb = bandpass(crunch(N, 60, 40, (t) => Math.exp(-t * 2.2) * smooth(0.02, 0.1, t)), 1400, 0.6);
  const lo = lowpass(out, (t) => 200 + 1800 * Math.exp(-t * 16));
  const mix = new Float32Array(N);
  for (let i = 0; i < N; i++) mix[i] = lo[i] + deb[i] * 0.3;
  write('burrower_slam', echo(mix, [[0, 1], [0.2, 0.28], [0.46, 0.16], [0.9, 0.08]]), { fadeOut: 0.35 });
}

// ---------------------------------------------------------------- the dive
{
  const T = 3, N = Math.round(SR * T);
  const air = bandpass(rumble(N, 0, 1).map((v, i) => rnd() * 0.5 + v), (t) => 300 + 900 * smooth(0, 1.2, t) - 700 * smooth(1.3, 2.4, t), 0.5);
  const env = (t) => smooth(0, 0.6, t) * (1 - smooth(1.8, 3, t));
  const tear = bandpass(crunch(N, 120, 35, (t) => smooth(1.0, 1.4, t) * Math.exp(-Math.max(0, t - 1.4) * 1.4)), 900, 0.6);
  const grind = lowpass(rumble(N, 0.4, 0.8), 110);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) { const t = i / SR; out[i] = air[i] * env(t) * 0.8 + tear[i] * 0.5 + grind[i] * smooth(1.1, 1.6, t) * 2.2; }
  write('burrower_dive', echo(out, [[0, 1], [0.22, 0.25], [0.5, 0.12]]), { fadeOut: 0.4 });
}
