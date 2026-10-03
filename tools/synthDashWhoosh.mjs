// Procedural dash whoosh (public/sounds/dash_whoosh.wav): a burst of air past the ears — noise
// through a resonant band-pass sweeping up then down (doppler-like), a low body thump at the
// push-off and a short airy tail. 0.6 s, 22.05 kHz mono. Deterministic (seeded noise).
import { writeFileSync } from 'node:fs';

const SR = 22050, DUR = 0.6, N = Math.round(SR * DUR);
const out = new Float32Array(N);
let s = 0x1b873593;
const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// State-variable band-pass, centre frequency swept 350 → 2600 → 500 Hz.
let low = 0, band = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const fc = t < 0.11 ? 350 + (2600 - 350) * smooth(0, 0.11, t) : 2600 - 2100 * smooth(0.11, 0.5, t);
  const f = 2 * Math.sin(Math.PI * fc / SR), q = 0.32;
  const x = rnd();
  low += f * band;
  const high = x - low - q * band;
  band += f * high;
  // Envelope: fast swell to the pass-by at ~0.1 s, long airy decay.
  const env = smooth(0, 0.09, t) * Math.exp(-Math.max(0, t - 0.1) * 7.5);
  out[i] = band * env * 0.9 + low * env * 0.25;
}
// Body thump at the push-off: a falling sine 95 → 45 Hz.
let ph = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR;
  ph += 2 * Math.PI * (45 + 50 * Math.exp(-t * 18)) / SR;
  out[i] += Math.sin(ph) * 0.55 * smooth(0, 0.01, t) * Math.exp(-t * 14);
}
// Fade the last 30 ms to silence.
for (let i = N - Math.round(SR * 0.03); i < N; i++) out[i] *= (N - i) / (SR * 0.03);
let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
const g = 0.89 / peak;
const buf = Buffer.alloc(44 + N * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 2, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(N * 2, 40);
for (let i = 0; i < N; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(out[i] * g * 32767))), 44 + i * 2);
writeFileSync(new URL('../public/sounds/dash_whoosh.wav', import.meta.url), buf);
console.log('dash_whoosh.wav', (buf.length / 1024).toFixed(0), 'KB');
