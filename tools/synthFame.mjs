// Procedural sounds of fame and infamy (game/fame; public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   camera_shutter  a press camera: the mirror slap and shutter, then the flash's short charging whine
//   crowd_boo       a small crowd booing: many low "boo" voices swelling and dying away, a whistle
//   protest_chant   a seamless loop: a crowd chanting two beats a bar ("Go home! Go home!"), with
//                   a drum on the beat and murmur between
//   fanfare         the statue's unveiling: a short brass fanfare (rising triad, a held chord)
// Run: node tools/synthFame.mjs
import { writeFileSync } from 'node:fs';

const SR = 22050;
let s = 0xfa3e5;
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
/** A resonant band (two-pole) at f with bandwidth bw (Hz). */
function band(x, f, bw) {
  const out = new Float32Array(x.length);
  const r = Math.exp((-Math.PI * bw) / SR), c = 2 * r * Math.cos((2 * Math.PI * f) / SR), r2 = r * r;
  let y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const y = (1 - r) * x[i] + c * y1 - r2 * y2; out[i] = y; y2 = y1; y1 = y; }
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

/** A click: a burst of filtered noise with a fast decay, at t (s). */
function click(mix, t, gain, decay, f) {
  const i0 = Math.round(t * SR), n = Math.round(decay * 6 * SR);
  const nz = new Float32Array(n);
  for (let k = 0; k < n; k++) nz[k] = rnd() * Math.exp(-k / (decay * SR));
  const b = band(nz, f, f * 0.8);
  for (let k = 0; k < n && i0 + k < mix.length; k++) mix[i0 + k] += b[k] * gain;
}

// ---------------------------------------------------------------- camera shutter
{
  const out = new Float32Array(Math.round(0.75 * SR));
  click(out, 0.0, 1.0, 0.004, 2600);   // mirror up
  click(out, 0.012, 0.6, 0.006, 900);  // its slap
  click(out, 0.055, 0.9, 0.003, 3800); // shutter curtain
  click(out, 0.07, 0.5, 0.005, 1500);
  // The flash recharging: a faint rising whine.
  for (let i = Math.round(0.12 * SR); i < out.length; i++) {
    const t = i / SR - 0.12, f = 3200 + t * 2600;
    out[i] += Math.sin(2 * Math.PI * f * t) * 0.035 * Math.exp(-t * 4) * Math.min(1, t * 30);
  }
  write('camera_shutter', highpass(out, 300));
}

/** One voice saying a vowel: a buzz at pitch f through formants f1, f2, with an envelope. */
function voice(mix, t0, dur, f, f1, f2, gain, glide = 0) {
  const i0 = Math.round(t0 * SR), n = Math.round(dur * SR);
  const src = new Float32Array(n);
  let ph = 0;
  const vib = u01() * 6;
  for (let k = 0; k < n; k++) {
    const t = k / SR, ff = f * (1 + glide * (t / dur)) * (1 + 0.012 * Math.sin(2 * Math.PI * (5 + vib) * t));
    ph += ff / SR;
    // A glottal-ish pulse: a sawtooth softened.
    src[k] = ((ph % 1) * 2 - 1) * 0.6 + rnd() * 0.08;
  }
  const a = band(src, f1, 90), b = band(src, f2, 140);
  for (let k = 0; k < n && i0 + k < mix.length; k++) {
    const t = k / n, env = Math.min(1, t * 8) * Math.min(1, (1 - t) * 5);
    mix[i0 + k] += (a[k] + b[k] * 0.5) * env * gain;
  }
}

// ---------------------------------------------------------------- crowd boo
{
  const D = 2.6, out = new Float32Array(Math.round(D * SR));
  for (let v = 0; v < 26; v++) {
    const male = u01() < 0.6;
    const f = male ? 100 + u01() * 50 : 190 + u01() * 70;
    const t0 = u01() * 0.35, dur = 1.3 + u01() * 0.9;
    // "boo": the vowel /u/ (formants ~300 and ~870 Hz), the pitch sagging at the end.
    voice(out, t0, Math.min(dur, D - t0 - 0.05), f, 300 + u01() * 60, 850 + u01() * 120, 0.5 + u01() * 0.5, -0.18);
  }
  // A whistle (two fingers) over it.
  for (let i = Math.round(0.5 * SR); i < Math.round(1.4 * SR); i++) {
    const t = i / SR - 0.5;
    out[i] += Math.sin(2 * Math.PI * (2400 + 300 * Math.sin(t * 7)) * t) * 0.05 * Math.min(1, t * 10) * Math.min(1, (0.9 - t) * 6);
  }
  // A murmur bed.
  const bed = new Float32Array(out.length);
  for (let i = 0; i < bed.length; i++) bed[i] = rnd() * 0.1;
  const m = band(bed, 450, 400);
  for (let i = 0; i < out.length; i++) { const t = i / out.length; out[i] += m[i] * Math.min(1, t * 5) * Math.min(1, (1 - t) * 4); }
  write('crowd_boo', highpass(out, 70));
}

// ---------------------------------------------------------------- protest chant (a loop)
{
  const bar = 1.6, bars = 4, XF = 0.25, D = bar * bars + XF;
  const out = new Float32Array(Math.round(D * SR));
  for (let b = 0; b < bars + 1; b++) {
    const t = b * bar;
    // "Go home! Go home!": two syllable pairs; vowels /o/ (450, 800) and /o:/ held a little longer.
    for (const [dt, len, f1, f2, up] of [[0, 0.22, 480, 850, 0.05], [0.32, 0.38, 430, 780, -0.08], [0.8, 0.22, 480, 850, 0.05], [1.12, 0.4, 430, 780, -0.1]]) {
      for (let v = 0; v < 12; v++) {
        const f = u01() < 0.55 ? 110 + u01() * 40 : 200 + u01() * 60;
        voice(out, t + dt + u01() * 0.05, len + u01() * 0.06, f, f1 + u01() * 40, f2 + u01() * 60, 0.35 + u01() * 0.3, up);
      }
    }
    // A drum on the beat.
    for (const dt of [0, 0.8]) {
      const i0 = Math.round((t + dt) * SR);
      for (let k = 0; k < Math.round(0.25 * SR) && i0 + k < out.length; k++) {
        const tt = k / SR;
        out[i0 + k] += Math.sin(2 * Math.PI * (70 + 40 * Math.exp(-tt * 30)) * tt) * Math.exp(-tt * 14) * 0.9 + rnd() * Math.exp(-tt * 60) * 0.2;
      }
    }
  }
  const bed = new Float32Array(out.length);
  for (let i = 0; i < bed.length; i++) bed[i] = rnd() * 0.12;
  const m = band(bed, 500, 500);
  for (let i = 0; i < out.length; i++) out[i] += m[i];
  write('protest_chant', loopify(highpass(out, 60), XF));
}

// ---------------------------------------------------------------- fanfare
{
  const D = 3.4, out = new Float32Array(Math.round(D * SR));
  /** A brass note: harmonics with a slow attack and brightness that follows the loudness. */
  const brass = (t0, dur, f, gain) => {
    const i0 = Math.round(t0 * SR), n = Math.round(dur * SR);
    for (let k = 0; k < n && i0 + k < out.length; k++) {
      const t = k / SR, env = Math.min(1, t * 18) * Math.min(1, (dur - t) * 6) * (0.85 + 0.15 * Math.exp(-t * 6));
      let v = 0;
      for (let h = 1; h <= 9; h++) v += Math.sin(2 * Math.PI * f * h * t * (1 + 0.003 * Math.sin(t * 30))) * Math.pow(0.62 + 0.25 * env, h) / h;
      out[i0 + k] += v * env * gain;
    }
  };
  // G4 C5 E5 — G5 held over a C major chord.
  const G4 = 392, C5 = 523.25, E5 = 659.25, G5 = 783.99, C4 = 261.63, E4 = 329.63;
  brass(0.0, 0.22, G4, 0.5); brass(0.24, 0.22, C5, 0.5); brass(0.48, 0.22, E5, 0.5);
  brass(0.74, 0.18, C5, 0.45); brass(0.94, 0.4, E5, 0.5);
  brass(1.4, 1.9, G5, 0.5); brass(1.4, 1.9, E5, 0.35); brass(1.4, 1.9, C5, 0.35); brass(1.4, 1.9, C4, 0.4); brass(1.4, 1.9, E4, 0.25);
  // A cymbal on the held chord.
  for (let i = Math.round(1.4 * SR); i < out.length; i++) { const t = i / SR - 1.4; out[i] += rnd() * 0.12 * Math.exp(-t * 2.2); }
  write('fanfare', highpass(out, 80));
}
