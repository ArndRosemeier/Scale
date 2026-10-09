// Procedural sounds for the Roc (public/sounds/*.wav, 22.05 kHz mono, deterministic):
//   roc_screech  its scream: a harsh, rough descending "kee-eeer" round 1.3 kHz, echoing off the town
//   roc_cry_far  the same far off and high up (the omen): duller, more echo
//   roc_flap     a wingbeat: a great whoomp of air, a low thump
// Run: node tools/synthRoc.mjs
// (Only one-pole filters here: tones are synthesised, nothing band-passed high.)
import { writeFileSync } from 'node:fs';

const SR = 22050;
let s = 0x70c0a1;
const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function lowpass(src, fc) {
  const out = new Float32Array(src.length);
  let y = 0;
  for (let i = 0; i < src.length; i++) {
    const f = typeof fc === 'function' ? fc(i / SR) : fc;
    const a = 1 - Math.exp((-2 * Math.PI * f) / SR);
    y += a * (src[i] - y); out[i] = y;
  }
  return out;
}

function bandpass(src, fc, q = 0.4) {
  const out = new Float32Array(src.length);
  let low = 0, band = 0;
  for (let i = 0; i < src.length; i++) {
    const f = 2 * Math.sin(Math.PI * Math.min(3000, typeof fc === 'function' ? fc(i / SR) : fc) / SR);
    low += f * band;
    const high = src[i] - low - q * band;
    band += f * high;
    out[i] = band;
  }
  return out;
}

function echo(x, taps) {
  const out = new Float32Array(x.length);
  for (const [d, g] of taps) { const o = Math.round(d * SR); for (let i = o; i < x.length; i++) out[i] += x[i - o] * g; }
  return out;
}

function write(name, out, { fadeOut = 0.05, fadeIn = 0 } = {}) {
  const N = out.length;
  const fade = Math.round(SR * fadeOut); for (let i = N - fade; i < N; i++) out[i] *= (N - i) / fade;
  const fi = Math.round(SR * fadeIn); for (let i = 0; i < fi; i++) out[i] *= i / fi;
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


// ---------------------------------------------------------------- the screech: a harsh descending scream
function scream(T, f0, f1, rough) {
  const N = Math.round(SR * T);
  const out = new Float32Array(N);
  let p = 0, hp = 0, nprev = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR, u = t / T;
    const env = smooth(0, 0.06, t) * (1 - smooth(0.55, 1, u)) * (0.85 + 0.15 * Math.sin(2 * Math.PI * 7 * t));
    // Up a little at first ("kee"), then down ("eeer").
    const f = f0 + (f0 * 0.12) * Math.sin(Math.PI * Math.min(1, u / 0.18)) - (f0 - f1) * smooth(0.12, 1, u);
    const vib = 1 + 0.025 * Math.sin(2 * Math.PI * 31 * t) + 0.01 * rnd();
    p += (2 * Math.PI * f * vib) / SR;
    const tone = Math.sin(p) + 0.55 * Math.sin(2 * p + 0.3) + 0.35 * Math.sin(3 * p + 1.1) + 0.2 * Math.sin(4 * p);
    const am = 1 - rough + rough * (0.5 + 0.5 * Math.sin(2 * Math.PI * 47 * t + Math.sin(t * 13)));
    // Breath: noise with the low end taken off.
    const n = rnd(); hp = 0.9 * (hp + n - nprev); nprev = n;
    out[i] = (Math.tanh(1.8 * tone) * am + hp * 0.25) * env;
  }
  return out;
}
{
  const out = lowpass(scream(1.9, 1350, 760, 0.45), 3000);
  write('roc_screech', echo(out, [[0, 1], [0.18, 0.28], [0.41, 0.16], [0.8, 0.08]]), { fadeOut: 0.3 });
}
{
  // Far off and high up: duller, more of the sky's echo.
  const out = lowpass(scream(2.2, 1250, 700, 0.35), 1300);
  write('roc_cry_far', echo(out, [[0, 0.7], [0.3, 0.4], [0.7, 0.3], [1.2, 0.18], [1.8, 0.1]]), { fadeOut: 0.5 });
}

// ---------------------------------------------------------------- a wingbeat: a great whoomp of air
{
  const T = 1.1, N = Math.round(SR * T);
  const air = new Float32Array(N);
  let b = 0, ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    b = b * 0.97 + rnd() * 0.25;
    const env = smooth(0, 0.08, t) * Math.exp(-Math.max(0, t - 0.1) * 4.5);
    ph += (2 * Math.PI * (38 + 30 * Math.exp(-t * 8))) / SR;
    air[i] = b * env + Math.sin(ph) * env * 0.5;
  }
  const out = lowpass(air, (t) => 160 + 900 * Math.exp(-t * 6));
  write('roc_flap', echo(out, [[0, 1], [0.15, 0.2]]), { fadeOut: 0.25 });
}
