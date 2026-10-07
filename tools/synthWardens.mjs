// Procedural sounds of the Wardens' discs (game/aliens):
//  - ufo_hum.wav: the low chord of a passing disc, a 4 s seamless loop: a soft open chord on A (55,
//    82.5, 110, 131, 164.75 Hz) with slowly beating twins, a faint glassy shimmer high above it and
//    a breath of low-passed air. All partials complete whole cycles in 4 s (multiples of 0.25 Hz),
//    the noise tail is crossfaded into its head.
//  - ufo_scan.wav: the soft rising tone when a scan cone comes on (1.5 s): a glassy, slightly
//    inharmonic tone sweeping up an octave and a half, a slow vibrato, a soft attack and tail.
// 22.05 kHz mono 16-bit, deterministic (seeded noise).
// Run: node tools/synthWardens.mjs   (adds / refreshes their entries in public/sounds/manifest.json)
import { readFileSync, writeFileSync } from 'node:fs';

const SR = 22050;
let s = 0x6d2b79f5;
const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };

function wav(name, out, rmsTarget) {
  const N = out.length;
  let rms = 0; for (const v of out) rms += v * v; rms = Math.sqrt(rms / N);
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
  const g = Math.min(rmsTarget / rms, 0.95 / peak);
  const buf = Buffer.alloc(44 + N * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(N * 2, 40);
  for (let i = 0; i < N; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(out[i] * g * 32767))), 44 + i * 2);
  writeFileSync(new URL(`../public/sounds/${name}.wav`, import.meta.url), buf);
  console.log(`${name}.wav`, (buf.length / 1024).toFixed(0), 'KB, gain', g.toFixed(2));
}

// ---------------------------------------------------------------- the hum
{
  const DUR = 4, N = SR * DUR;
  const out = new Float32Array(N);
  // [frequency, amplitude]; twins 0.25 / 0.5 Hz apart beat slowly.
  const parts = [[55, 0.5], [55.25, 0.35], [82.5, 0.32], [110, 0.3], [110.5, 0.18], [131, 0.16], [164.75, 0.12], [220, 0.06]];
  for (const [f, a] of parts) {
    const w = 2 * Math.PI * f / SR, ph = rnd() * Math.PI;
    for (let i = 0; i < N; i++) out[i] += a * Math.sin(w * i + ph);
  }
  // The shimmer: two glassy partials swelling at 0.5 and 0.25 Hz.
  for (const [f, a, m] of [[880, 0.025, 0.5], [1319.75, 0.016, 0.25]]) {
    const w = 2 * Math.PI * f / SR;
    for (let i = 0; i < N; i++) out[i] += a * (0.5 + 0.5 * Math.sin(2 * Math.PI * m * i / SR)) * Math.sin(w * i);
  }
  // Air: low-passed noise, crossfaded into a loop.
  const X = Math.floor(SR / 2), noise = new Float32Array(N + X);
  let l1 = 0, l2 = 0;
  for (let i = 0; i < noise.length; i++) { l1 += (rnd() - l1) * 0.05; l2 += (l1 - l2) * 0.08; noise[i] = l2; }
  for (let i = 0; i < N; i++) {
    let n = noise[i];
    if (i < X) { const t = i / X; n = noise[i] * Math.sqrt(t) + noise[N + i] * Math.sqrt(1 - t); }
    out[i] += n * 1.6;
  }
  wav('ufo_hum', out, 0.2);
}

// ---------------------------------------------------------------- the scan tone
{
  const DUR = 1.5, N = Math.floor(SR * DUR);
  const out = new Float32Array(N);
  let ph1 = 0, ph2 = 0, ph3 = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR, u = t / DUR;
    // Rising from 330 Hz an octave and a half, easing in.
    const f = 330 * Math.pow(2, 1.5 * (1 - Math.pow(1 - u, 2))) * (1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * t));
    ph1 += 2 * Math.PI * f / SR; ph2 += 2 * Math.PI * f * 2.01 / SR; ph3 += 2 * Math.PI * f * 3.03 / SR;
    const env = Math.min(1, t / 0.28) * Math.pow(1 - u, 1.3);
    out[i] = env * (Math.sin(ph1) * 0.6 + Math.sin(ph2) * 0.22 + Math.sin(ph3) * 0.1);
  }
  wav('ufo_scan', out, 0.16);
}

// ---------------------------------------------------------------- manifest
const mf = new URL('../public/sounds/manifest.json', import.meta.url);
const m = JSON.parse(readFileSync(mf, 'utf8'));
m.ufo_hum = { files: ['ufo_hum.wav'], loop: true, gain: 0.55, description: 'Warden disc: low chord loop (procedural, tools/synthWardens.mjs)' };
m.ufo_scan = { files: ['ufo_scan.wav'], loop: false, gain: 0.5, description: 'Warden disc: soft rising tone when a scan cone comes on (procedural, tools/synthWardens.mjs)' };
writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
console.log('manifest updated');
