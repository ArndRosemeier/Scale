// Procedural sounds for the army (public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   army_rifle       a rifle squad's burst: a ragged string of sharp cracks (several rifles) with a
//                    short slap off the facades
//   army_autocannon  an APC's autocannon: five heavy thuds a little apart, metallic ring, echo
//   army_tank        a tank's gun: a hard crack, a deep boom and a rolling tail through the streets
//   army_rotor       an attack helicopter's rotor (loop): blade slap at ~18 Hz over turbine whine
//   army_jet         a jet flyby: a rising roar, a crack as it passes overhead, a falling rumble
//   army_rocket      a rocket salvo leaving the pods: a string of whooshes with a hiss
//   army_explosion   a shell / rocket going off: crack, boom, debris rattle
//   army_bomb        a bomb: a bigger, deeper explosion with a long rumble
//   army_hit         a shell hitting the monster's hide: a dull thud and a ringing crack
//   army_artillery   artillery far off: a deep, muffled thump rolling over the city
//   army_whistle     an incoming shell's whistle, falling in pitch
// Run: node tools/synthArmy.mjs
import { writeFileSync } from 'node:fs';

const SR = 22050;
let s = 0xa7e1c0de;
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

/** One gunshot at sample offset `at`: a crack (noise burst) and a body thump. */
function shot(out, at, gain, crackDecay, boomF, boomDecay, boomGain) {
  let ph = 0;
  for (let i = at; i < out.length; i++) {
    const t = (i - at) / SR;
    if (t > 1.2) break;
    ph += (2 * Math.PI * (boomF + boomF * 2 * Math.exp(-t * 40))) / SR;
    out[i] += gain * (rnd() * Math.exp(-t * crackDecay) + Math.sin(ph) * Math.exp(-t * boomDecay) * boomGain);
  }
}

// ---------------------------------------------------------------- rifle burst (a squad)
{
  const N = Math.round(SR * 1.6), out = new Float32Array(N);
  let t = 0.02;
  for (let k = 0; k < 18; k++) { shot(out, Math.round(t * SR), 0.6 + rnd() * 0.3, 90, 120, 30, 0.5); t += 0.045 + Math.abs(rnd()) * 0.06; }
  const hi = bandpass(out, 2600, 0.7), lo = lowpass(out, 900);
  const mix = new Float32Array(N);
  for (let i = 0; i < N; i++) mix[i] = hi[i] * 0.8 + lo[i];
  write('army_rifle', echo(mix, [[0, 1], [0.09, 0.3], [0.21, 0.15]]), { fadeOut: 0.2 });
}

// ---------------------------------------------------------------- autocannon (APC)
{
  const N = Math.round(SR * 1.8), out = new Float32Array(N);
  for (let k = 0; k < 4; k++) shot(out, Math.round((0.02 + k * 0.17) * SR), 1, 45, 70, 9, 1.4);
  const ring = bandpass(out, 1400, 0.25);
  const mix = new Float32Array(N);
  const lo = lowpass(out, 1200);
  for (let i = 0; i < N; i++) mix[i] = lo[i] + ring[i] * 0.3;
  write('army_autocannon', echo(mix, [[0, 1], [0.13, 0.32], [0.33, 0.18], [0.6, 0.08]]), { fadeOut: 0.3 });
}

// ---------------------------------------------------------------- tank gun
{
  const N = Math.round(SR * 3.4), out = new Float32Array(N);
  shot(out, 10, 1.2, 60, 38, 3.2, 2.2);
  for (let i = 0; i < N; i++) { const t = i / SR; out[i] += rnd() * 0.35 * Math.exp(-t * 1.6) * smooth(0, 0.05, t); }
  const lo = lowpass(out, (t) => 300 + 2500 * Math.exp(-t * 25));
  write('army_tank', echo(lo, [[0, 1], [0.18, 0.38], [0.42, 0.25], [0.8, 0.14], [1.3, 0.08]]), { fadeOut: 0.6 });
}

// ---------------------------------------------------------------- helicopter rotor (loop, 2 s)
{
  const T = 2, N = Math.round(SR * T), out = new Float32Array(N);
  const blade = 18; // blade passes a second (a whole number of cycles in the loop)
  let pw = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const ph = (t * blade) % 1;
    const slap = Math.exp(-ph * 18) * (0.8 + 0.2 * Math.sin(2 * Math.PI * t * 0.5));
    pw += (2 * Math.PI * 820) / SR;
    out[i] = rnd() * slap * 0.9 + Math.sin(ph * Math.PI * 2) * 0.25 + Math.sin(pw) * 0.03 + rnd() * 0.06;
  }
  const lo = lowpass(out, 1100);
  write('army_rotor', lo, { loop: true, peak: 0.8 });
}

// ---------------------------------------------------------------- jet flyby
{
  const T = 6.5, N = Math.round(SR * T), out = new Float32Array(N);
  const tPass = 3.0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const near = Math.exp(-((t - tPass) ** 2) / 0.9);
    const roar = rnd() * (0.15 + 0.85 * near) * smooth(0, 1.5, t) * (1 - smooth(5.2, 6.4, t) * 0.9);
    out[i] = roar;
  }
  // The pitch of the roar falls as it passes (a doppler sweep in the filter), then the crack.
  const body = bandpass(out, (t) => 900 * Math.pow(2, -1.6 * smooth(tPass - 0.6, tPass + 0.8, t)) + 200, 0.5);
  const lo = lowpass(out, 400);
  const mix = new Float32Array(N);
  for (let i = 0; i < N; i++) mix[i] = body[i] * 0.9 + lo[i] * 1.2;
  shot(mix, Math.round((tPass + 0.15) * SR), 1.1, 35, 30, 4, 1.5);
  write('army_jet', echo(mix, [[0, 1], [0.25, 0.25], [0.6, 0.12]]), { fadeOut: 0.5 });
}

// ---------------------------------------------------------------- rocket salvo
{
  const N = Math.round(SR * 2.6), out = new Float32Array(N);
  for (let k = 0; k < 8; k++) {
    const at = 0.02 + k * 0.18;
    for (let i = Math.round(at * SR); i < N; i++) {
      const t = i / SR - at;
      if (t > 1.2) break;
      out[i] += rnd() * Math.exp(-t * 3) * smooth(0, 0.02, t) * 0.7;
    }
    shot(out, Math.round(at * SR), 0.5, 70, 90, 20, 0.6);
  }
  const hiss = bandpass(out, (t) => 2200 - 600 * smooth(0, 2, t), 0.6);
  const lo = lowpass(out, 700);
  const mix = new Float32Array(N);
  for (let i = 0; i < N; i++) mix[i] = hiss[i] * 0.8 + lo[i];
  write('army_rocket', mix, { fadeOut: 0.3 });
}

// ---------------------------------------------------------------- explosions
for (const [name, T, f, decay, rumbleT] of [['army_explosion', 2.6, 45, 4, 1.3], ['army_bomb', 4.5, 30, 2.2, 0.6]]) {
  const N = Math.round(SR * T), out = new Float32Array(N);
  shot(out, 10, 1.3, 25, f, decay, 2.4);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    out[i] += rnd() * 0.5 * Math.exp(-t * rumbleT) * smooth(0, 0.03, t);
    if (rnd() > 0.992 - 0.006 * Math.exp(-t * 2)) out[i] += rnd() * 0.5 * Math.exp(-t * 1.5) * smooth(0.1, 0.25, t);
  }
  const lo = lowpass(out, (t) => 250 + 3000 * Math.exp(-t * 20));
  write(name, echo(lo, [[0, 1], [0.2, 0.35], [0.5, 0.2], [1.0, 0.1]]), { fadeOut: 0.6 });
}

// ---------------------------------------------------------------- a hit on the hide
{
  const N = Math.round(SR * 1.6), out = new Float32Array(N);
  shot(out, 10, 1.2, 50, 55, 7, 2);
  const ring = bandpass(out, 620, 0.12);
  const mix = new Float32Array(N);
  const lo = lowpass(out, 1500);
  for (let i = 0; i < N; i++) mix[i] = lo[i] + ring[i] * 0.25;
  write('army_hit', echo(mix, [[0, 1], [0.17, 0.3], [0.4, 0.15]]), { fadeOut: 0.3 });
}

// ---------------------------------------------------------------- distant artillery
{
  const N = Math.round(SR * 4), out = new Float32Array(N);
  shot(out, 10, 1, 8, 26, 2.2, 2.6);
  for (let i = 0; i < N; i++) { const t = i / SR; out[i] += rnd() * 0.25 * Math.exp(-t * 0.9) * smooth(0, 0.15, t); }
  write('army_artillery', echo(lowpass(out, 220), [[0, 1], [0.6, 0.4], [1.4, 0.25], [2.3, 0.12]]), { fadeOut: 0.8 });
}

// ---------------------------------------------------------------- incoming whistle
{
  const T = 1.4, N = Math.round(SR * T), out = new Float32Array(N);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const f = 1800 - 1000 * (t / T) ** 1.4;
    ph += (2 * Math.PI * f) / SR;
    out[i] = (Math.sin(ph) * 0.6 + rnd() * 0.2) * smooth(0, 0.5, t) * (0.6 + 0.4 * t / T);
  }
  write('army_whistle', bandpass(out, (t) => 1800 - 1000 * (t / T) ** 1.4, 0.3), { fadeOut: 0.02 });
}
