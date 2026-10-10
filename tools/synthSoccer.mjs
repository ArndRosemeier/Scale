// Procedural sounds of soccer in the stadium (game/soccer; public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   ref_whistle       the referee's pea whistle, one short blast (a foul, a restart)
//   ref_whistle_long  one long blast (kick-off, half time, the last of the full-time three)
//   ball_kick         a boot on a leather ball: a low thump and the slap of the panel
// Run: node tools/synthSoccer.mjs [names…]   (only the named sounds when given)
import { writeFileSync } from 'node:fs';

const SR = 22050;
let s = 0x50cce7;
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

/**
 * A pea whistle: a tone near 2.9 kHz warbled by the pea rattling in the chamber (a fast, uneven
 * trill in pitch and loudness), with breath noise around the tone; len s, blown with an attack.
 */
function whistle(len, pitch) {
  const N = Math.round((len + 0.08) * SR), out = new Float32Array(N), nz = new Float32Array(N);
  let ph = 0, tr = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.012) * (t < len ? 1 : Math.exp(-(t - len) / 0.018)) * (1 - 0.15 * Math.min(1, t / len));
    // The pea: a trill near 28 Hz, its rate drifting a little.
    tr += (2 * Math.PI * (27 + 4 * Math.sin(t * 3.1))) / SR;
    const pea = Math.sin(tr), f = pitch * (1 + 0.045 * pea + 0.01 * Math.sin(t * 7));
    ph += (2 * Math.PI * f) / SR;
    const am = 0.72 + 0.28 * Math.max(-1, Math.min(1, pea * 1.6));
    out[i] = (Math.sin(ph) + 0.18 * Math.sin(2 * ph) + 0.05 * Math.sin(3 * ph)) * env * am;
    nz[i] = rnd() * env;
  }
  const breath = band(nz, pitch, 900), hiss = highpass(nz, 5000);
  for (let i = 0; i < N; i++) out[i] += breath[i] * 2.2 + hiss[i] * 0.05;
  return out;
}

write('ref_whistle', whistle(0.32, 2950));
write('ref_whistle_long', whistle(1.05, 2900));

// ---------------------------------------------------------------- ball kick
{
  const N = Math.round(0.32 * SR), out = new Float32Array(N), nz = new Float32Array(N);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    // The thump: a falling low tone (the ball's air), short.
    const f = 70 + 85 * Math.exp(-t / 0.025);
    ph += (2 * Math.PI * f) / SR;
    out[i] = Math.sin(ph) * Math.exp(-t / 0.05) * 0.9;
    nz[i] = rnd() * Math.exp(-t / 0.009);
  }
  // The slap of boot on leather: a short bright burst, and a hollow knock in the ball.
  const slap = band(nz, 1500, 1400), knock = band(nz, 420, 160);
  for (let i = 0; i < N; i++) out[i] += slap[i] * 3.2 + knock[i] * 4.5;
  write('ball_kick', lowpass(out, 6000));
}
