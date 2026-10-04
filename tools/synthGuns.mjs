// Procedural sounds for small arms (public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   gun_pistol    one pistol shot: a sharp crack, a short body thump, a slap off the facades
//   gun_rifle     a rifle's three-round burst (SWAT), a little heavier than the pistol
//   gun_ricochet  a round striking a machine: a bright metallic tick with a short ring
// Run: node tools/synthGuns.mjs   (adds / refreshes their entries in public/sounds/manifest.json)
import { writeFileSync, readFileSync } from 'node:fs';

const SR = 22050;
let s = 0x5eed9a11;
const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };

function lowpass(src, fc) {
  const out = new Float32Array(src.length);
  let y = 0;
  const a = 1 - Math.exp((-2 * Math.PI * fc) / SR);
  for (let i = 0; i < src.length; i++) { y += a * (src[i] - y); out[i] = y; }
  return out;
}

function bandpass(src, fc, q = 0.4) {
  const out = new Float32Array(src.length);
  let low = 0, band = 0;
  const f = 2 * Math.sin(Math.PI * Math.min(SR * 0.45, fc) / SR);
  for (let i = 0; i < src.length; i++) {
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

function write(name, out, { fadeOut = 0.05, peak: want = 0.89 } = {}) {
  const N = out.length;
  const fade = Math.round(SR * fadeOut);
  for (let i = N - fade; i < N; i++) out[i] *= (N - i) / fade;
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
    if (t > 0.8) break;
    ph += (2 * Math.PI * (boomF + boomF * 2 * Math.exp(-t * 50))) / SR;
    out[i] += gain * (rnd() * Math.exp(-t * crackDecay) + Math.sin(ph) * Math.exp(-t * boomDecay) * boomGain);
  }
}

// ---------------------------------------------------------------- pistol
{
  const N = Math.round(SR * 0.75), out = new Float32Array(N);
  shot(out, 8, 1, 140, 150, 38, 0.55);
  const hi = bandpass(out, 3200, 0.6), lo = lowpass(out, 1100);
  const mix = new Float32Array(N);
  for (let i = 0; i < N; i++) mix[i] = hi[i] * 0.9 + lo[i];
  write('gun_pistol', echo(mix, [[0, 1], [0.07, 0.28], [0.16, 0.14], [0.29, 0.06]]), { fadeOut: 0.15 });
}

// ---------------------------------------------------------------- rifle, three-round burst
{
  const N = Math.round(SR * 0.9), out = new Float32Array(N);
  for (let k = 0; k < 3; k++) shot(out, Math.round((0.01 + k * 0.09) * SR), 0.9 + rnd() * 0.1, 110, 125, 32, 0.7);
  const hi = bandpass(out, 2700, 0.6), lo = lowpass(out, 1000);
  const mix = new Float32Array(N);
  for (let i = 0; i < N; i++) mix[i] = hi[i] * 0.85 + lo[i];
  write('gun_rifle', echo(mix, [[0, 1], [0.08, 0.3], [0.19, 0.15], [0.33, 0.07]]), { fadeOut: 0.2 });
}

// ---------------------------------------------------------------- ricochet / hit on metal
{
  const N = Math.round(SR * 0.4), out = new Float32Array(N);
  let p1 = 0, p2 = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    p1 += (2 * Math.PI * 3100) / SR; p2 += (2 * Math.PI * 4650) / SR;
    out[i] = rnd() * Math.exp(-t * 260) * 0.9 + (Math.sin(p1) * 0.5 + Math.sin(p2) * 0.3) * Math.exp(-t * 22);
  }
  write('gun_ricochet', bandpass(out, 3400, 0.5), { fadeOut: 0.08, peak: 0.7 });
}

// ---------------------------------------------------------------- manifest
const mf = new URL('../public/sounds/manifest.json', import.meta.url);
const m = JSON.parse(readFileSync(mf, 'utf8'));
m.gun_pistol = { files: ['gun_pistol.wav'], loop: false, gain: 0.7, description: 'a single pistol shot: a sharp crack and a short slap off the facades (procedural, tools/synthGuns.mjs)' };
m.gun_rifle = { files: ['gun_rifle.wav'], loop: false, gain: 0.72, description: "a rifle's three-round burst (procedural, tools/synthGuns.mjs)" };
m.gun_ricochet = { files: ['gun_ricochet.wav'], loop: false, gain: 0.6, description: 'a round striking a machine: a bright metallic tick (procedural, tools/synthGuns.mjs)' };
writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
console.log('manifest updated');
