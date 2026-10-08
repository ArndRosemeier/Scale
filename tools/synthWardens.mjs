// Procedural sounds of the Wardens' discs (game/aliens):
//  - ufo_hum.wav: the low chord of a passing disc, a 4 s seamless loop: a soft open chord on A (55,
//    82.5, 110, 131, 164.75 Hz) with slowly beating twins, a faint glassy shimmer high above it and
//    a breath of low-passed air. All partials complete whole cycles in 4 s (multiples of 0.25 Hz),
//    the noise tail is crossfaded into its head.
//  - ufo_scan.wav: the soft rising tone when a scan cone comes on (1.5 s): a glassy, slightly
//    inharmonic tone sweeping up an octave and a half, a slow vibrato, a soft attack and tail.
//  - phase 2: teen_whine (loop), teen_zap, teen_giggle, teen_pod (the runaway teens' saucer) and
//    ufo_stern (the parent disc's tone when it catches them); see their blocks below.
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

// ---------------------------------------------------------------- the runaway teens' saucer (phase 2)
// teen_whine: a 3 s loop, a reedy warbling whine (two detuned square-ish tones 4 Hz vibrato, a
// chirpy arpeggio blip every half second) — a hot-rodded little disc. All rates whole cycles in 3 s.
{
  const DUR = 3, N = SR * DUR;
  const out = new Float32Array(N);
  for (const [f, a] of [[220, 0.32], [221 + 1 / 3, 0.22], [330, 0.14], [440, 0.08]]) {
    for (let i = 0; i < N; i++) {
      const t = i / SR;
      const ph = 2 * Math.PI * f * t + 0.012 * f / 4 * Math.sin(2 * Math.PI * 4 * t);
      // Soft square: a few odd harmonics.
      out[i] += a * (Math.sin(ph) + Math.sin(3 * ph) / 3 * 0.6 + Math.sin(5 * ph) / 5 * 0.3);
    }
  }
  // Blips: a little rising three-note arpeggio every 0.5 s.
  const notes = [880, 1108.73, 1318.51];
  for (let b = 0; b < 6; b++) for (let k = 0; k < 3; k++) {
    const t0 = b * 0.5 + k * 0.05, f = notes[(k + b) % 3];
    for (let j = 0; j < SR * 0.045; j++) {
      const i = Math.floor(t0 * SR) + j;
      if (i >= N) break;
      const e = Math.sin(Math.PI * j / (SR * 0.045));
      out[i] += 0.05 * e * Math.sign(Math.sin(2 * Math.PI * f * j / SR));
    }
  }
  wav('teen_whine', out, 0.17);
}

// teen_zap: the beam coming on (0.9 s): a buzzy sweep up with a crackle.
{
  const DUR = 0.9, N = Math.floor(SR * DUR);
  const out = new Float32Array(N);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR, u = t / DUR;
    const f = 160 * Math.pow(2, 2.5 * u) * (1 + 0.04 * Math.sin(2 * Math.PI * 30 * t));
    ph += 2 * Math.PI * f / SR;
    const saw = 2 * ((ph / (2 * Math.PI)) % 1) - 1;
    const env = Math.min(1, t / 0.02) * Math.pow(1 - u, 1.5);
    out[i] = env * (saw * 0.5 + Math.sin(ph * 2) * 0.3 + rnd() * 0.12 * (rnd() > 0.92 ? 3 : 1));
  }
  wav('teen_zap', out, 0.15);
}

// teen_giggle: a glitchy robotic giggle (1.0 s): quick falling chirps, bit-crushed.
{
  const DUR = 1.0, N = Math.floor(SR * DUR);
  const out = new Float32Array(N);
  const chirps = [[0, 1400], [0.11, 1250], [0.2, 1500], [0.3, 1200], [0.41, 1350], [0.5, 1100], [0.62, 1250], [0.72, 1000]];
  for (const [t0, f0] of chirps) {
    let ph = 0;
    const L = Math.floor(SR * 0.075);
    for (let j = 0; j < L; j++) {
      const i = Math.floor(t0 * SR) + j;
      if (i >= N) break;
      const u = j / L, f = f0 * (1.25 - 0.45 * u);
      ph += 2 * Math.PI * f / SR;
      const e = Math.sin(Math.PI * u) * (1 - t0 * 0.6);
      out[i] += e * (Math.sin(ph) + 0.35 * Math.sin(2 * ph));
    }
  }
  // Crush to 5 bits, every other sample held: a cheap toy voice.
  for (let i = 0; i < N; i++) out[i] = Math.round(out[i] * 16) / 16;
  for (let i = 1; i < N; i += 2) out[i] = out[i - 1];
  wav('teen_giggle', out, 0.16);
}

// teen_pod: a hover pod knocked out (0.6 s): a pop, a fizzing crackle, a falling whir.
{
  const DUR = 0.6, N = Math.floor(SR * DUR);
  const out = new Float32Array(N);
  let ph = 0, lp = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR, u = t / DUR;
    const f = 600 * Math.pow(0.25, u);
    ph += 2 * Math.PI * f / SR;
    lp += (rnd() - lp) * 0.35;
    const pop = Math.exp(-t * 60);
    out[i] = pop * rnd() * 1.4 + Math.exp(-t * 6) * (Math.sin(ph) * 0.4 + lp * (rnd() > 0.85 ? 1.2 : 0.3));
  }
  wav('teen_pod', out, 0.2);
}

// ufo_stern: the parent disc's stern tone (2.6 s): a deep, slightly brassy two-note fall (A2 → E2,
// "tut-tut"), an octave below for weight, a slow swell and a long tail — rolls over the block.
{
  const DUR = 2.6, N = Math.floor(SR * DUR);
  const out = new Float32Array(N);
  const notes = [[0, 1.0, 110], [1.05, 1.5, 82.41]];
  for (const [t0, len, f] of notes) {
    let ph = 0;
    for (let j = 0; j < SR * (len + 0.4); j++) {
      const i = Math.floor(t0 * SR) + j;
      if (i >= N) break;
      const t = j / SR;
      ph += 2 * Math.PI * f * (1 + 0.003 * Math.sin(2 * Math.PI * 5 * t)) / SR;
      const env = Math.min(1, t / 0.12) * (t < len ? 1 : Math.exp(-(t - len) * 9)) * (0.85 + 0.15 * Math.sin(Math.PI * Math.min(1, t / len)));
      let v = 0;
      for (let h = 1; h <= 7; h++) v += Math.sin(ph * h) / Math.pow(h, 1.25);
      out[i] += env * (v * 0.5 + Math.sin(ph * 0.5) * 0.45);
    }
  }
  wav('ufo_stern', out, 0.22);
}

// ---------------------------------------------------------------- manifest
const mf = new URL('../public/sounds/manifest.json', import.meta.url);
const m = JSON.parse(readFileSync(mf, 'utf8'));
m.ufo_hum = { files: ['ufo_hum.wav'], loop: true, gain: 0.55, description: 'Warden disc: low chord loop (procedural, tools/synthWardens.mjs)' };
m.ufo_scan = { files: ['ufo_scan.wav'], loop: false, gain: 0.5, description: 'Warden disc: soft rising tone when a scan cone comes on (procedural, tools/synthWardens.mjs)' };
m.teen_whine = { files: ['teen_whine.wav'], loop: true, gain: 0.5, description: 'Runaway teens\' saucer: reedy warbling whine loop (procedural, tools/synthWardens.mjs)' };
m.teen_zap = { files: ['teen_zap.wav'], loop: false, gain: 0.55, description: 'Runaway teens\' saucer: buzzy beam coming on (procedural, tools/synthWardens.mjs)' };
m.teen_giggle = { files: ['teen_giggle.wav'], loop: false, gain: 0.55, description: 'Runaway teens: glitchy robotic giggle after a prank (procedural, tools/synthWardens.mjs)' };
m.teen_pod = { files: ['teen_pod.wav'], loop: false, gain: 0.6, description: 'Runaway teens\' saucer: a hover pod knocked out, pop and fizz (procedural, tools/synthWardens.mjs)' };
m.ufo_stern = { files: ['ufo_stern.wav'], loop: false, gain: 0.7, description: 'Parent Warden disc: deep stern two-note tone over the block (procedural, tools/synthWardens.mjs)' };
writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
console.log('manifest updated');
