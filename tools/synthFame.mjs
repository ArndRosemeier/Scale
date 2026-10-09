// Procedural sounds of fame and infamy (game/fame; public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   camera_shutter  a press camera: the mirror slap and shutter, then the flash's short charging whine
//   protest_drum    a seamless loop: a protest's drum, two beats a bar, over a crowd's murmur bed (the
//                   chant itself is in the protesters' bubbles: procedural voices never made words)
// Run: node tools/synthFame.mjs [names…]   (only the named sounds when given)
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

const ONLY = process.argv.slice(2);

function write(name, out) {
  if (ONLY.length && !ONLY.includes(name)) return;
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

// ---------------------------------------------------------------- protest drum (a loop)
{
  const bar = 1.6, bars = 4, XF = 0.25, D = bar * bars + XF;
  const out = new Float32Array(Math.round(D * SR));
  for (let b = 0; b < bars + 1; b++) {
    const t = b * bar;
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
  write('protest_drum', loopify(highpass(out, 60), XF));
}
