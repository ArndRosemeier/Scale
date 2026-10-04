// Procedural sounds for the threat layer (public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   civil_siren    civil-defence / evacuation siren over a district: a two-tone motor siren winding
//                  up, holding and winding down, with the city's echo (seamless loop)
//   robot_glitch   a machine glitching: stuttering bleeps, a bit-crushed buzz, a falling boop
//   robot_hostile  a machine turning hostile: a servo whine winding up into a harsh two-tone chirp
// Run: node tools/synthThreats.mjs
import { writeFileSync } from 'node:fs';

const SR = 22050;
let s = 0x7ea75eed;
const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

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

function lowpass(src, fc) {
  const out = new Float32Array(src.length);
  const a = 1 - Math.exp((-2 * Math.PI * fc) / SR);
  let y = 0;
  for (let i = 0; i < src.length; i++) { y += a * (src[i] - y); out[i] = y; }
  return out;
}

function write(name, out, { fadeOut = 0.02, loop = false } = {}) {
  const N = out.length;
  if (!loop) { const fade = Math.round(SR * fadeOut); for (let i = N - fade; i < N; i++) out[i] *= (N - i) / fade; }
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

/** Make a buffer loop seamlessly: crossfade its tail into its head. */
function loopify(x, xf) {
  const n = Math.round(xf * SR), N = x.length - n;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = x[i];
  for (let i = 0; i < n; i++) { const t = i / n; out[i] = x[i] * t + x[N + i] * (1 - t); }
  return out;
}

// ---------------------------------------------------------------- civil-defence siren
{
  // One cycle: wind up 3.2 s, hold 3.6 s, wind down 4.4 s (the rotor never quite stops),
  // plus the crossfade. Two rotors a minor third apart; the chopper ports give a rough timbre.
  const cyc = 11.2, N = Math.round(SR * (cyc + 1.0));
  const dry = new Float32Array(N);
  let p1 = 0, p2 = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR, u = t % cyc;
    const sp = u < 3.2 ? smooth(0, 3.2, u) : u < 6.8 ? 1 : 1 - 0.78 * smooth(6.8, cyc, u);
    const f1 = 140 + 300 * sp, f2 = f1 * 1.19;
    p1 += (2 * Math.PI * f1) / SR; p2 += (2 * Math.PI * f2) / SR;
    // Ported rotor: a rounded square (odd harmonics, softened).
    const sq = (p) => Math.sin(p) + Math.sin(3 * p) / 3.2 + Math.sin(5 * p) / 6 + Math.sin(7 * p) / 11;
    const wob = 1 + 0.04 * Math.sin(t * 2 * Math.PI * 0.6);
    dry[i] = (sq(p1) * 0.55 + sq(p2) * 0.45) * (0.35 + 0.65 * sp) * wob;
  }
  // The horn's band, then the city answering: echoes off facades, a soft tail.
  const horn = bandpass(dry, 700, 0.55);
  const body = lowpass(dry, 2200);
  const mix = new Float32Array(N);
  for (let i = 0; i < N; i++) mix[i] = body[i] * 0.55 + horn[i] * 0.7;
  const out = new Float32Array(N);
  const taps = [[0, 1], [0.17, 0.32], [0.39, 0.22], [0.71, 0.14], [1.13, 0.08]];
  for (const [d, g] of taps) { const o = Math.round(d * SR); for (let i = o; i < N; i++) out[i] += mix[i - o] * g; }
  write('civil_siren', loopify(lowpass(out, 3200), 1.0), { loop: true });
}

// ---------------------------------------------------------------- robot glitch
{
  const N = Math.round(SR * 0.75);
  const out = new Float32Array(N);
  // Stuttering bleeps at jumping pitches (each repeated a few times), bit-crushed.
  let t0 = 0, k = 0;
  while (t0 < 0.48) {
    const f = [880, 1320, 660, 1760, 990, 1480][k % 6] * (1 + rnd() * 0.04);
    const len = 0.035 + (k % 3) * 0.012, reps = 1 + (k % 3);
    for (let r = 0; r < reps; r++) {
      const i0 = Math.round((t0 + r * (len + 0.012)) * SR), n = Math.round(len * SR);
      for (let i = 0; i < n && i0 + i < N; i++) {
        const ph = (2 * Math.PI * f * i) / SR;
        const v = Math.sign(Math.sin(ph)) * 0.5 + Math.sin(ph) * 0.5;
        out[i0 + i] += Math.round(v * 4) / 4 * 0.55 * (1 - i / n * 0.5);
      }
    }
    t0 += reps * (len + 0.012) + 0.02;
    k++;
  }
  // A falling boop and a buzz of static at the end.
  for (let i = Math.round(0.46 * SR); i < N; i++) {
    const t = i / SR - 0.46;
    const f = 520 * Math.exp(-t * 6);
    out[i] += Math.sin(2 * Math.PI * (520 / 6) * (1 - Math.exp(-t * 6))) * 0.5 * Math.exp(-t * 7) + rnd() * 0.18 * Math.exp(-t * 10) * (Math.sin(t * 2 * Math.PI * 60) > 0 ? 1 : 0.2);
    void f;
  }
  write('robot_glitch', out, { fadeOut: 0.03 });
}

// ---------------------------------------------------------------- robot turning hostile
{
  const N = Math.round(SR * 1.05);
  const out = new Float32Array(N);
  let ph = 0, pb = 0, pc = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    // Servo whine winding up (0–0.45 s): a buzzy saw sweeping up with motor ripple.
    const fw = 180 + 900 * smooth(0, 0.45, t);
    ph += (2 * Math.PI * fw) / SR;
    const saw = ((ph / (2 * Math.PI)) % 1) * 2 - 1;
    const whine = (saw * 0.35 + Math.sin(ph * 2) * 0.2) * smooth(0, 0.05, t) * (1 - smooth(0.42, 0.55, t)) * (0.8 + 0.2 * Math.sin(t * 2 * Math.PI * 45));
    // Harsh two-tone chirp (0.5–1.0 s): high-low, square-ish.
    const fc = t < 0.72 ? 1250 : 830;
    pc += (2 * Math.PI * fc) / SR;
    const chirp = (Math.sign(Math.sin(pc)) * 0.4 + Math.sin(pc) * 0.3) * smooth(0.5, 0.52, t) * (1 - smooth(0.95, 1.04, t)) * (t > 0.7 && t < 0.74 ? 0.3 : 1);
    // A low electric buzz under it.
    pb += (2 * Math.PI * 95) / SR;
    const buzz = (Math.sign(Math.sin(pb)) * 0.25 + rnd() * 0.04) * smooth(0, 0.1, t) * (1 - smooth(0.85, 1.04, t));
    out[i] = whine + chirp + buzz;
  }
  write('robot_hostile', bandpass(out, 1600, 0.25).map((v, i) => v * 0.6 + out[i] * 0.55), { fadeOut: 0.04 });
}
