// Procedural ambience of a busy café terrace (public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   terrace_clatter  a seamless loop: cups set on saucers, spoons and cutlery clinking over a soft room
//                    tone (no voices: the guests' talk is in bubbles, procedural voices never made words)
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

// ---------------------------------------------------------------- terrace clatter
{
  const L = 12, XF = 1.5, N = Math.round(SR * (L + XF));
  const mix = new Float32Array(N);
  // Cups on saucers, spoons, cutlery.
  for (let t = 0.3; t < L + XF - 0.3; t += 0.25 + u01() * 1.2) clink(mix, t, u01() < 0.45 ? 'cup' : u01() < 0.5 ? 'spoon' : 'fork', 0.08 + u01() * 0.16);
  // A soft bed of room tone (the street).
  let b = 0;
  for (let i = 0; i < N; i++) { b += 0.02 * (rnd() - b); mix[i] += b * 0.6; }
  write('terrace_clatter', loopify(lowpass(mix, 9000), XF));
}
