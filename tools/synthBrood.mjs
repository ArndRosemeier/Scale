// Procedural sounds for the brood swarm (public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   brood_chitter   a swarm chittering: hundreds of dry clicks, rasps and short chirps from many
//                   small bodies, a scrabbling of claws on asphalt under it (seamless loop)
//   brood_screech   one creature shrieking (hit, dying, coming out of a hole): a rasping squeal
//   brood_bite      a quick snap of mandibles with a crunch
// Run: node tools/synthBrood.mjs
import { writeFileSync } from 'node:fs';

const SR = 22050;
let s = 0xb200d5ee;
const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
const rnd01 = () => (rnd() + 1) / 2;

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

function highpass(src, fc) {
  const out = new Float32Array(src.length);
  const a = Math.exp((-2 * Math.PI * fc) / SR);
  let y = 0, xp = 0;
  for (let i = 0; i < src.length; i++) { y = a * (y + src[i] - xp); xp = src[i]; out[i] = y; }
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

/** Add an event at time t (s) wrapping round a loop of N samples. */
function addWrap(out, i0, fn, n) { for (let i = 0; i < n; i++) out[(i0 + i) % out.length] += fn(i); }

// ---------------------------------------------------------------- the swarm chittering (loop)
{
  const L = 3.0, N = Math.round(SR * L);
  const out = new Float32Array(N);
  // Clicks: very short resonant ticks at random pitches, in little rattling runs.
  for (let k = 0; k < 900; k++) {
    const t0 = rnd01() * L, run = 1 + Math.floor(rnd01() * 5), f = 1800 + rnd01() * 4200, gap = 0.012 + rnd01() * 0.02, a = 0.25 + rnd01() * 0.6;
    for (let r = 0; r < run; r++) {
      const n = Math.round(SR * (0.004 + rnd01() * 0.004));
      addWrap(out, Math.round((t0 + r * gap) * SR), (i) => Math.sin((2 * Math.PI * f * i) / SR) * Math.exp(-i / (n * 0.3)) * a, n);
    }
  }
  // Chirps: short rasping squeaks sweeping up or down.
  for (let k = 0; k < 70; k++) {
    const t0 = rnd01() * L, d = 0.04 + rnd01() * 0.09, f0 = 2400 + rnd01() * 2500, sw = (rnd01() - 0.5) * 2600, a = 0.15 + rnd01() * 0.25;
    const n = Math.round(d * SR);
    let ph = 0;
    addWrap(out, Math.round(t0 * SR), (i) => {
      const u = i / n;
      ph += (2 * Math.PI * (f0 + sw * u)) / SR;
      const rasp = Math.sign(Math.sin(ph * 0.5 + Math.sin(i * 0.9) * 2)) * 0.5 + Math.sin(ph) * 0.5;
      return rasp * Math.sin(Math.PI * u) * a;
    }, n);
  }
  // Claws scrabbling: band-limited noise in fast jittery bursts.
  const noise = new Float32Array(N);
  for (let i = 0; i < N; i++) noise[i] = rnd() * (0.4 + 0.6 * Math.abs(Math.sin(i / SR * 2 * Math.PI * 23 + Math.sin(i / SR * 7) * 3)));
  const scrab = bandpass(noise, 3000, 0.7);
  for (let i = 0; i < N; i++) out[i] += scrab[i] * 0.55;
  write('brood_chitter', highpass(out, 500), { loop: true });
}

// ---------------------------------------------------------------- a screech
{
  const N = Math.round(SR * 0.48);
  const out = new Float32Array(N);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR, u = t / 0.48;
    const f = 1700 + 1500 * Math.sin(Math.PI * Math.min(1, u * 1.4)) - 600 * u + Math.sin(t * 2 * Math.PI * 38) * 220;
    ph += (2 * Math.PI * f) / SR;
    const env = Math.min(1, t / 0.02) * Math.pow(1 - u, 1.4);
    // A rasping (amplitude-chopped) squeal with a noisy edge.
    const chop = 0.55 + 0.45 * Math.sign(Math.sin(t * 2 * Math.PI * 95));
    out[i] = (Math.sin(ph) * 0.6 + Math.sin(ph * 2.01) * 0.25 + rnd() * 0.35) * env * chop;
  }
  write('brood_screech', bandpass(out, 2600, 0.35).map((v, i) => v * 0.7 + out[i] * 0.4), { fadeOut: 0.04 });
}

// ---------------------------------------------------------------- a bite
{
  const N = Math.round(SR * 0.16);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    // Two snaps of the mandibles, then a short crunch.
    const snap = (t0) => { const d = t - t0; return d >= 0 && d < 0.008 ? Math.sin(2 * Math.PI * 3400 * d) * Math.exp(-d / 0.0025) : 0; };
    const crunch = t > 0.03 ? rnd() * Math.exp(-(t - 0.03) / 0.035) * (0.5 + 0.5 * Math.sign(Math.sin(t * 2 * Math.PI * 160))) : 0;
    out[i] = snap(0) * 0.9 + snap(0.021) * 0.8 + crunch * 0.6;
  }
  write('brood_bite', bandpass(out, 2200, 0.5).map((v, i) => v * 0.6 + out[i] * 0.5));
}
