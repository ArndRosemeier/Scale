// Procedural sounds for the deep realm and its slimes (public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   deep_glow        the Lumen's caverns: a soft airy hum, far drips, now and then glassy tones (loop)
//   deep_murk        the Murk's depths: a low rumble, slow wet movements, a distant beat (loop)
//   heart_pulse      the star shard deep down: a slow heavy throb under a shimmering crystal hum (loop)
//   murk_growl_1..2  a wet, gurgling growl
//   murk_spit        a wet spit launched
//   murk_slam        a heavy wet blow
//   maw_roar         a huge gurgling roar
//   lumen_chime_1..2 a soft bubbly chord (a greeting)
//   slime_battle     a skirmish of many slimes: squelches, slaps, growls (loop)
//   slime_call       a rising swirl of bubbles and a bright chime (the Lumen answering)
//   membrane         a wobbling, stretching membrane parting
// Run: node tools/synthDeep.mjs (the manifest entries are in public/sounds/manifest.json).
import { writeFileSync } from 'node:fs';

const SR = 22050;
let seed = 0x5eed1e55;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) * 2 - 1; };

function lowpass(src, fc) {
  const out = new Float32Array(src.length);
  let y = 0;
  for (let i = 0; i < src.length; i++) {
    const f = typeof fc === 'function' ? fc(i / SR) : fc;
    const a = 1 - Math.exp(-2 * Math.PI * f / SR);
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

/** Feedback delays: a cave's tail. */
function cave(src, mix = 0.35, len = 0.9) {
  const out = Float32Array.from(src);
  for (const d of [0.037, 0.053, 0.071, 0.097, 0.131, 0.173]) {
    const n = Math.round(d * SR), g = Math.pow(0.001, d / len);
    for (let i = n; i < out.length; i++) out[i] += out[i - n] * g * mix * 0.45;
  }
  return out;
}

function noise(n) { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = rnd(); return o; }

function write(name, out, { fadeOut = 0.03, loop = false, peak: target = 0.89 } = {}) {
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

/** Make a loop seamless: crossfade the last `x` seconds into the start. */
function seam(out, x = 0.8) {
  const n = Math.round(x * SR), N = out.length - n;
  const o = new Float32Array(N);
  for (let i = 0; i < N; i++) o[i] = out[i];
  for (let i = 0; i < n; i++) { const t = i / n; o[i] = out[i] * t + out[N + i] * (1 - t); }
  return o;
}

/** A wet squelch / blip: a falling resonant chirp in noise. */
function blip(out, at, dur, f0, f1, amp) {
  const s = Math.round(at * SR), n = Math.round(dur * SR);
  let ph = 0;
  for (let i = 0; i < n && s + i < out.length; i++) {
    const t = i / n;
    const f = f0 * Math.pow(f1 / f0, t);
    ph += 2 * Math.PI * f / SR;
    const env = Math.sin(Math.PI * Math.min(1, t * 4)) * Math.pow(1 - t, 1.5);
    out[s + i] += (Math.sin(ph) * 0.7 + Math.sin(ph * 2.03) * 0.2 + rnd() * 0.25) * env * amp;
  }
}

/** A growl: a rough low tone (pulse train through formants) with gurgles. */
function growl(dur, f0, rough, gain = 1) {
  const N = Math.round(dur * SR), src = new Float32Array(N);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const f = f0 * (1 + 0.15 * Math.sin(t * 7) + 0.1 * rnd() * rough);
    ph += f / SR;
    const pulse = (ph % 1) < 0.3 ? 1 : -0.4;
    const env = Math.min(1, t / 0.08) * Math.min(1, (dur - t) / 0.25);
    src[i] = (pulse + rnd() * rough * 0.8) * env * (0.7 + 0.3 * Math.sin(t * 23 + Math.sin(t * 5) * 3));
  }
  const a = bandpass(src, (t) => 300 + 120 * Math.sin(t * 4), 0.5), b = bandpass(src, 750, 0.6), c = lowpass(src, 220);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = (a[i] * 0.9 + b[i] * 0.4 + c[i] * 0.8) * gain;
  // Gurgling bubbles over it.
  for (let k = 0; k < dur * 14; k++) blip(out, Math.random() * (dur - 0.1), 0.04 + Math.random() * 0.05, 300 + Math.random() * 500, 120, 0.15);
  return out;
}

// ---- deep_glow: an airy hum with far drips and glassy tones (20 s loop)
{
  const dur = 20.8, N = Math.round(dur * SR);
  const air = lowpass(bandpass(noise(N), 420, 0.9), 900);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    out[i] = air[i] * (0.5 + 0.2 * Math.sin(t * 0.4)) + 0.05 * Math.sin(2 * Math.PI * 82 * t) * (0.6 + 0.4 * Math.sin(t * 0.3)) + 0.03 * Math.sin(2 * Math.PI * 123.5 * t);
  }
  for (let k = 0; k < 26; k++) blip(out, Math.random() * (dur - 1), 0.05, 1600 + Math.random() * 900, 700, 0.18);
  // Glassy tones: a few soft bell partials.
  for (let k = 0; k < 7; k++) {
    const at = Math.random() * (dur - 3), f = [523.3, 659.3, 783.9, 987.8, 1174.7][k % 5];
    const s = Math.round(at * SR);
    for (let i = 0; i < 3 * SR && s + i < N; i++) { const t = i / SR; out[s + i] += (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(2 * Math.PI * f * 2.76 * t)) * Math.exp(-t * 1.6) * 0.06 * Math.min(1, t * 40); }
  }
  write('deep_glow', seam(cave(out, 0.5, 1.6)), { loop: true, peak: 0.6 });
}

// ---- deep_murk: low rumble, wet movements, a distant beat (20 s loop)
{
  const dur = 20.8, N = Math.round(dur * SR);
  const rum = lowpass(noise(N), 90);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const beat = Math.exp(-((t % 1.6) * 9)) + 0.6 * Math.exp(-(((t + 0.32) % 1.6) * 9));
    out[i] = rum[i] * 3 + Math.sin(2 * Math.PI * 41 * t) * beat * 0.3 + Math.sin(2 * Math.PI * 55 * t) * 0.04;
  }
  for (let k = 0; k < 40; k++) blip(out, Math.random() * (dur - 1), 0.08 + Math.random() * 0.15, 220 + Math.random() * 200, 60, 0.22);
  write('deep_murk', seam(cave(out, 0.55, 1.8)), { loop: true, peak: 0.65 });
}

// ---- heart_pulse: a slow heavy throb under a shimmering crystal hum (shard-like) (9.6 s loop: six beats)
{
  const dur = 9.6 + 0.8, N = Math.round(dur * SR);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const p = t % 1.6;
    const thump = Math.exp(-p * 7) * Math.sin(2 * Math.PI * (48 - p * 20) * t) + 0.7 * Math.exp(-Math.max(0, p - 0.28) * 8) * (p > 0.28 ? 1 : 0) * Math.sin(2 * Math.PI * 44 * t);
    const shimmer = (Math.sin(2 * Math.PI * 440 * t + Math.sin(t * 3.1) * 2) + Math.sin(2 * Math.PI * 660.5 * t) * 0.6 + Math.sin(2 * Math.PI * 990.2 * t + Math.sin(t * 1.7)) * 0.35) * (0.08 + 0.05 * Math.sin(t * 0.9));
    out[i] = thump * 0.9 + shimmer * 0.5;
  }
  write('heart_pulse', seam(cave(out, 0.45, 1.5)), { loop: true, peak: 0.75 });
}

// ---- growls, spit, slam, roar
for (const [k, f0] of [[1, 62], [2, 78]]) write(`murk_growl_${k}`, cave(growl(1.1 + k * 0.2, f0, 0.8), 0.3, 0.8));
{
  const N = Math.round(0.5 * SR), out = new Float32Array(N);
  blip(out, 0, 0.18, 900, 250, 1);
  const n = bandpass(noise(N), (t) => 2500 - t * 3000, 0.6);
  for (let i = 0; i < N; i++) { const t = i / SR; out[i] += n[i] * Math.exp(-t * 12) * 0.8; }
  write('murk_spit', cave(out, 0.25, 0.5));
}
{
  const N = Math.round(0.9 * SR), out = new Float32Array(N);
  const n = lowpass(noise(N), 300);
  for (let i = 0; i < N; i++) { const t = i / SR; out[i] = n[i] * 4 * Math.exp(-t * 7) + Math.sin(2 * Math.PI * (70 - t * 40) * t) * Math.exp(-t * 6) * 0.9; }
  blip(out, 0.02, 0.2, 400, 90, 0.6);
  write('murk_slam', cave(out, 0.35, 0.8));
}
write('maw_roar', cave(growl(3.2, 38, 1.0, 1.3), 0.55, 2.2));

// ---- lumen chimes: soft bubbly chords
for (const [k, base] of [[1, 523.3], [2, 587.3]]) {
  const N = Math.round(1.6 * SR), out = new Float32Array(N);
  [1, 1.25, 1.5, 2].forEach((m, j) => {
    const s = Math.round(j * 0.07 * SR);
    for (let i = 0; i < N - s; i++) { const t = i / SR; out[s + i] += Math.sin(2 * Math.PI * base * m * t + Math.sin(t * 30) * 0.3) * Math.exp(-t * 3) * Math.min(1, t * 60) * 0.3; }
  });
  for (let j = 0; j < 6; j++) blip(out, j * 0.05, 0.05, 1200 + j * 150, 900, 0.15);
  write(`lumen_chime_${k}`, cave(out, 0.4, 1.0));
}

// ---- slime_battle: a skirmish (8 s loop)
{
  const dur = 8.8, N = Math.round(dur * SR), out = new Float32Array(N);
  for (let k = 0; k < dur * 22; k++) blip(out, Math.random() * (dur - 0.3), 0.05 + Math.random() * 0.12, 150 + Math.random() * 700, 50 + Math.random() * 100, 0.3 + Math.random() * 0.4);
  for (let k = 0; k < 5; k++) { const g = growl(0.6 + Math.random() * 0.4, 60 + Math.random() * 40, 0.9, 0.35); const s = Math.round(Math.random() * (dur - 1.2) * SR); for (let i = 0; i < g.length && s + i < N; i++) out[s + i] += g[i]; }
  write('slime_battle', seam(cave(out, 0.4, 1.0)), { loop: true, peak: 0.7 });
}

// ---- slime_call: rising swirl of bubbles and a bright chime
{
  const N = Math.round(2.4 * SR), out = new Float32Array(N);
  for (let k = 0; k < 70; k++) { const t = (k / 70) * 1.6; blip(out, t + Math.random() * 0.05, 0.05, 300 + t * 1100 + Math.random() * 200, 600 + t * 900, 0.35); }
  const s = Math.round(1.5 * SR);
  for (const m of [1, 1.5, 2, 3]) for (let i = 0; i < N - s; i++) { const t = i / SR; out[s + i] += Math.sin(2 * Math.PI * 784 * m * t) * Math.exp(-t * 2.5) * 0.22 / m; }
  write('slime_call', cave(out, 0.4, 1.2));
}

// ---- membrane: a stretching, wobbling part
{
  const N = Math.round(1.3 * SR), out = new Float32Array(N);
  const n = noise(N);
  const b = bandpass(n, (t) => 250 + 900 * t + 120 * Math.sin(t * 40), 0.25);
  for (let i = 0; i < N; i++) { const t = i / SR; out[i] = b[i] * Math.sin(Math.PI * Math.min(1, t / 1.2)) * (0.7 + 0.3 * Math.sin(t * 55)); }
  blip(out, 0.85, 0.2, 500, 150, 0.6);
  write('membrane', cave(out, 0.3, 0.7));
}
