// Procedural quadcopter rotor buzz (public/sounds/drone_buzz.wav): four rotors with slightly
// different blade-pass frequencies (beating), their harmonics, and blade-modulated airflow
// noise. 2 s, 22.05 kHz mono, sample-continuous loop (all partials complete whole cycles,
// the noise tail is crossfaded into its head). Deterministic (seeded noise).
import { writeFileSync } from 'node:fs';

const SR = 22050, DUR = 2, N = SR * DUR;
const out = new Float32Array(N);
let s = 0x2545f491;
const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
// Rotor blade-pass fundamentals (Hz, multiples of 1/DUR so they loop).
const rotors = [176, 181.5, 187, 193];
for (const [ri, f0] of rotors.entries()) {
  const ph = ri * 1.3;
  for (let h = 1; h <= 9; h++) {
    const a = 0.22 / Math.pow(h, 1.15) * (h % 2 ? 1 : 0.7);
    const w = 2 * Math.PI * f0 * h / SR;
    for (let i = 0; i < N; i++) out[i] += a * Math.sin(w * i + ph * h);
  }
}
// Airflow noise: low-passed, amplitude-modulated by the blade pass.
const noise = new Float32Array(N + Math.floor(SR / 4));
let lp1 = 0, lp2 = 0;
for (let i = 0; i < noise.length; i++) { lp1 += (rnd() - lp1) * 0.18; lp2 += (lp1 - lp2) * 0.35; noise[i] = lp2; }
const X = Math.floor(SR / 4); // crossfade length
for (let i = 0; i < N; i++) {
  let n = noise[i];
  if (i < X) { const t = i / X; n = noise[i] * Math.sqrt(t) + noise[N + i] * Math.sqrt(1 - t); }
  const mod = 0.6 + 0.4 * Math.sin(2 * Math.PI * 181.5 * i / SR);
  out[i] += n * 2.2 * mod;
}
// Slow wobble (gusts / controller corrections), looping at 0.5 and 1 Hz.
for (let i = 0; i < N; i++) out[i] *= 0.9 + 0.07 * Math.sin(2 * Math.PI * 0.5 * i / SR) + 0.03 * Math.sin(2 * Math.PI * 1 * i / SR + 1);
// Normalise to about -14 dBFS RMS.
let rms = 0; for (const v of out) rms += v * v; rms = Math.sqrt(rms / N);
const g = 0.2 / rms;
const buf = Buffer.alloc(44 + N * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 2, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(N * 2, 40);
for (let i = 0; i < N; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(out[i] * g * 32767))), 44 + i * 2);
writeFileSync(new URL('../public/sounds/drone_buzz.wav', import.meta.url), buf);
console.log('drone_buzz.wav', (buf.length / 1024).toFixed(0), 'KB, peak', out.reduce((m, v) => Math.max(m, Math.abs(v * g)), 0).toFixed(2), "rms", rms.toFixed(3));
