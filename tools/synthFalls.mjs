// Procedural fall cries (public/sounds/fall_*.wav, 22.05 kHz mono, deterministic): the short, mild
// vocal reactions of someone who trips and lands on the pavement. Startled and a bit hurt, never a
// scream. Each word is rendered as a man's and a woman's voice, with small random differences.
//   fall_oof      a winded "oof" (vowel, then a breath of f)
//   fall_ow       a quick "ow!"
//   fall_whoa     a startled "whoa" as the feet go
//   fall_ugh      a low, creaky grunt
//   fall_ah       a short surprised "ah!"
//   fall_whoops   "whoops" (w, vowel, p burst, s hiss)
// Voices are additive harmonics shaped by moving formants (gaussian resonances per harmonic).
// Run: node tools/synthFalls.mjs
import { writeFileSync } from 'node:fs';

const SR = 22050;
let s = 0x0f411ed5;
const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

/** RBJ biquad band-pass (constant 0 dB peak), stable up to Nyquist. */
function bandpass(src, fc, q = 0.6) {
  const w = (2 * Math.PI * Math.min(SR * 0.45, fc)) / SR, al = Math.sin(w) / (2 * Math.max(0.3, 1 / q));
  const a0 = 1 + al, b0 = al / a0, b2 = -al / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - al) / a0;
  const out = new Float32Array(src.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < src.length; i++) {
    const y = b0 * src[i] + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = src[i]; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}

/** A voiced sound: f0(t) Hz, formants(t) → [[freq, bandwidth, gain], …], amp(t), breath noise share. */
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

const noise = (N) => Float32Array.from({ length: N }, () => rnd());

function write(name, out, fadeOut = 0.03) {
  const N = out.length;
  const fade = Math.round(SR * fadeOut);
  for (let i = N - fade; i < N; i++) out[i] *= (N - i) / fade;
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

// A speaker: pitch scale and formant scale (a woman's voice: higher pitch, shorter vocal tract),
// plus a small personal jitter so the two takes of a word never sound cloned.
const SPEAKERS = { m: { p: 1, f: 1, br: 0.05 }, f: { p: 1.75, f: 1.16, br: 0.07 } };
const scaleF = (F, k) => F.map(([f, bw, a]) => [f * k, bw * k, a]);

/** Mix a fricative / breath noise burst into v: centre freq, from t0 to t1 (s), gain. */
function hiss(v, fc, t0, t1, gain, q = 0.6, attack = 0.015, release = 0.04) {
  const b = bandpass(noise(v.length), fc, q);
  for (let i = 0; i < v.length; i++) {
    const t = i / SR;
    v[i] += b[i] * gain * smooth(t0, t0 + attack, t) * (1 - smooth(t1 - release, t1, t));
  }
}

const words = {
  // "oof": winded, falling pitch, rounded vowel, then the f.
  oof(sp) {
    const dur = 0.36, N = Math.round(SR * dur);
    const p0 = 150 * sp.p * (1 + rnd() * 0.06);
    const v = voice(N, (t) => p0 * (1 - 0.3 * smooth(0, 0.22, t)),
      (t) => scaleF([[lerp(520, 420, smooth(0.02, 0.2, t)), 110, 1], [lerp(1100, 950, smooth(0, 0.2, t)), 160, 0.55], [2350, 260, 0.18]], sp.f),
      (t) => smooth(0.0, 0.018, t) * (1 - smooth(0.12, 0.24, t)), sp.br, 0.75, 0.007);
    hiss(v, 5200, 0.17, 0.34, 0.5, 0.8, 0.03, 0.12);
    hiss(v, 1400, 0, 0.04, 0.12);
    return v;
  },
  // "ow!": a quick a→u glide, pitch pops up then falls.
  ow(sp) {
    const dur = 0.42, N = Math.round(SR * dur);
    const p0 = 190 * sp.p * (1 + rnd() * 0.06);
    const v = voice(N, (t) => p0 * (1 + 0.12 * smooth(0, 0.05, t) - 0.32 * smooth(0.06, 0.34, t)),
      (t) => { const g = smooth(0.08, 0.3, t); return scaleF([[lerp(760, 430, g), 120, 1], [lerp(1250, 850, g), 170, 0.6], [2500, 280, 0.2]], sp.f); },
      (t) => smooth(0.0, 0.02, t) * (1 - smooth(0.22, 0.38, t)), sp.br, 0.65, 0.006);
    return v;
  },
  // "whoa": rounded onset, opening vowel, pitch up as the feet go, then down.
  whoa(sp) {
    const dur = 0.55, N = Math.round(SR * dur);
    const p0 = 165 * sp.p * (1 + rnd() * 0.06);
    const v = voice(N, (t) => p0 * (1 + 0.28 * smooth(0.02, 0.2, t) - 0.38 * smooth(0.22, 0.5, t)),
      (t) => {
        const w = smooth(0.0, 0.1, t), o = smooth(0.18, 0.42, t);
        return scaleF([[lerp(lerp(320, 560, w), 660, o), 120, 1], [lerp(lerp(700, 950, w), 1150, o), 170, lerp(0.35, 0.55, w)], [2450, 280, 0.18]], sp.f);
      },
      (t) => smooth(0.0, 0.05, t) * (1 - smooth(0.3, 0.52, t)), sp.br, 0.7, 0.006);
    return v;
  },
  // "ugh": a short low grunt with a creaky (jittery) voice, cut by a glottal stop.
  ugh(sp) {
    const dur = 0.3, N = Math.round(SR * dur);
    const p0 = 125 * sp.p * (1 + rnd() * 0.06);
    const v = voice(N, (t) => p0 * (1 - 0.18 * smooth(0, 0.2, t)),
      () => scaleF([[640, 120, 1], [1190, 170, 0.55], [2400, 260, 0.2]], sp.f),
      (t) => smooth(0.0, 0.025, t) * (1 - smooth(0.16, 0.2, t)), sp.br * 1.4, 0.85, 0.02);
    hiss(v, 1300, 0, 0.05, 0.1);
    return v;
  },
  // "ah!": short and surprised, open vowel.
  ah(sp) {
    const dur = 0.3, N = Math.round(SR * dur);
    const p0 = 200 * sp.p * (1 + rnd() * 0.06);
    const v = voice(N, (t) => p0 * (1 + 0.08 * smooth(0, 0.04, t) - 0.22 * smooth(0.05, 0.26, t)),
      () => scaleF([[780, 130, 1], [1260, 180, 0.6], [2550, 280, 0.22]], sp.f),
      (t) => smooth(0.0, 0.015, t) * (1 - smooth(0.12, 0.27, t)), sp.br, 0.65, 0.006);
    return v;
  },
  // "whoops": w, rounded vowel, the lips close, a little p burst, an s.
  whoops(sp) {
    const dur = 0.52, N = Math.round(SR * dur);
    const p0 = 175 * sp.p * (1 + rnd() * 0.06);
    const v = voice(N, (t) => p0 * (1 + 0.2 * smooth(0.0, 0.1, t) - 0.15 * smooth(0.1, 0.22, t)),
      (t) => { const w = smooth(0.0, 0.07, t); return scaleF([[lerp(320, 470, w), 110, 1], [lerp(720, 1050, w), 160, 0.5], [2300, 260, 0.16]], sp.f); },
      (t) => smooth(0.0, 0.03, t) * (1 - smooth(0.17, 0.22, t)), sp.br, 0.7, 0.006);
    for (let i = 0; i < N; i++) { const t = i / SR; if (t > 0.27 && t < 0.31) v[i] += rnd() * 0.3 * Math.exp(-(t - 0.27) * 120); }
    hiss(v, 6000, 0.31, 0.5, 0.75, 0.9, 0.02, 0.1);
    return v;
  },
};

for (const [word, make] of Object.entries(words)) {
  for (const [who, sp] of Object.entries(SPEAKERS)) write(`fall_${word}_${who}`, make(sp));
}
