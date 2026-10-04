// Procedural ambience of a busy café terrace (public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   terrace_murmur   a seamless loop: a dozen voices talking at tables around the listener (indistinct
//                    babble, men and women, near and farther off), now and then a laugh, cups set on
//                    saucers, spoons and cutlery clinking
// Voices are additive harmonics shaped by moving formants (as in synthCrime.mjs).
// Run: node tools/synthTerrace.mjs
import { writeFileSync } from 'node:fs';

const SR = 22050;
let s = 0x7e88ace;
const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
const u01 = () => (rnd() + 1) / 2;

function lowpass(x, fc) {
  const out = new Float32Array(x.length);
  const a = 1 - Math.exp((-2 * Math.PI * fc) / SR);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y += a * (x[i] - y); out[i] = y; }
  return out;
}

// Vowel formants [F1, F2, F3] (Hz), scaled for women / men.
const VOWELS = [[730, 1090, 2440], [530, 1840, 2480], [270, 2290, 3010], [570, 840, 2410], [300, 870, 2240], [660, 1720, 2410], [490, 1350, 1690]];

/** One talker: syllables in phrases with pauses, a moving pitch contour. */
function talker(N, female, level) {
  const out = new Float32Array(N);
  const f0b = female ? 190 + u01() * 50 : 100 + u01() * 35;
  const fk = female ? 1.15 : 1.0;
  // Syllable timeline.
  const syl = [];
  let t = u01() * 1.5;
  while (t < N / SR) {
    const phrase = 3 + Math.floor(u01() * 9);
    for (let k = 0; k < phrase && t < N / SR; k++) {
      const d = 0.11 + u01() * 0.16;
      syl.push({ t0: t, d, v: VOWELS[Math.floor(u01() * VOWELS.length)], p: 1 + rnd() * 0.12 + (k === phrase - 1 ? -0.1 : 0.04) });
      t += d + 0.02 + u01() * 0.05;
    }
    t += 0.35 + u01() * 1.6;
  }
  let ph = 0, si = 0;
  for (let i = 0; i < N; i++) {
    const tt = i / SR;
    while (si < syl.length - 1 && tt > syl[si].t0 + syl[si].d) si++;
    const sy = syl[si];
    const x = (tt - sy.t0) / sy.d;
    const env = x < 0 || x > 1 ? 0 : Math.sin(Math.PI * x) ** 0.7;
    if (env <= 0) continue;
    const f0 = f0b * sy.p * (1 + 0.03 * Math.sin(tt * 3.1));
    ph += (2 * Math.PI * f0) / SR;
    let v = 0;
    for (let k = 1; k * f0 < 3800 && k < 30; k++) {
      const hf = k * f0;
      let g = 0;
      for (let j = 0; j < 3; j++) { const ff = sy.v[j] * fk, bw = 90 + j * 60; const dd = (hf - ff) / bw; g += Math.exp(-0.5 * dd * dd) * (j === 0 ? 1 : 0.6 / j); }
      v += Math.sin(ph * k) * g / Math.sqrt(k);
    }
    out[i] = v * env * level;
  }
  return out;
}

/** A short laugh: "ha-ha-ha" bursts. */
function laugh(out, at, female, level) {
  const f0b = female ? 260 : 150;
  for (let k = 0; k < 4 + Math.floor(u01() * 3); k++) {
    const t0 = at + k * 0.17, n = Math.round(0.12 * SR);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const j = Math.round(t0 * SR) + i;
      if (j >= out.length) return;
      const x = i / n, env = Math.sin(Math.PI * x) ** 0.6;
      const f0 = f0b * (1.1 - k * 0.04);
      ph += (2 * Math.PI * f0) / SR;
      let v = rnd() * 0.25;
      for (let h = 1; h < 14; h++) { const dd = (h * f0 - 750) / 260; v += Math.sin(ph * h) * Math.exp(-0.5 * dd * dd) / Math.sqrt(h); }
      out[j] += v * env * level;
    }
  }
}

/** Porcelain / metal clink: inharmonic partials with fast decays. */
function clink(out, at, kind, level) {
  const parts = kind === 'cup' ? [[2650, 0.06], [4120, 0.04], [6210, 0.025]] : kind === 'spoon' ? [[5200, 0.03], [7600, 0.02], [9100, 0.012]] : [[3400, 0.05], [5650, 0.035], [8300, 0.02]];
  const n = Math.round(0.25 * SR), i0 = Math.round(at * SR);
  const jit = 1 + rnd() * 0.06;
  for (let i = 0; i < n && i0 + i < out.length; i++) {
    const t = i / SR;
    let v = 0;
    for (const [f, d] of parts) v += Math.sin(2 * Math.PI * f * jit * t) * Math.exp(-t / d);
    out[i0 + i] += (v * 0.5 + (i < 30 ? rnd() * (1 - i / 30) * 0.6 : 0)) * level;
  }
}

/** Make a buffer loop seamlessly: crossfade its tail into its head. */
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

// ---------------------------------------------------------------- terrace murmur
{
  const L = 12, XF = 1.5, N = Math.round(SR * (L + XF));
  const mix = new Float32Array(N);
  // Talkers at the tables: the nearer ones brighter and louder, the farther ones dull.
  for (let k = 0; k < 12; k++) {
    const female = k % 2 === 0;
    const near = k < 4;
    let v = talker(N, female, near ? 0.55 : 0.32);
    v = lowpass(v, near ? 3000 : 1300 + u01() * 600);
    for (let i = 0; i < N; i++) mix[i] += v[i];
  }
  for (let k = 0; k < 3; k++) laugh(mix, 1 + u01() * (L - 2), k !== 1, 0.5);
  // Cups on saucers, spoons, cutlery.
  for (let t = 0.3; t < L + XF - 0.3; t += 0.25 + u01() * 1.2) clink(mix, t, u01() < 0.45 ? 'cup' : u01() < 0.5 ? 'spoon' : 'fork', 0.08 + u01() * 0.16);
  // A soft bed of room tone (distant voices, street).
  let b = 0;
  for (let i = 0; i < N; i++) { b += 0.02 * (rnd() - b); mix[i] += b * 0.6; }
  write('terrace_murmur', loopify(mix, XF));
}
