/**
 * The origin scene's sounds, synthesized at run time (no clips): the falling star's rushing
 * streak, the crack when it breaks apart, the impact (a deep thud and a glassy ring), the shard's
 * crystalline hum (a loop), the surge when its light pours into the player, and the soft chord
 * that carries the white-out into the morning. Played through the effects bus of the game's audio.
 */
import type { Audio } from '../../audio/Audio';

type Kind = 'streak' | 'crack' | 'impact' | 'hum' | 'surge' | 'dawn';

const SR = 22050;

export class IntroSound {
  private bufs = new Map<Kind, AudioBuffer>();
  private hum: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private live: { src: AudioBufferSourceNode; gain: GainNode }[] = [];

  constructor(private audio: Audio) {}

  private out(): { ctx: AudioContext; out: AudioNode } | null {
    return this.audio.synthOut();
  }

  private buf(kind: Kind): AudioBuffer | null {
    const o = this.out();
    if (!o) return null;
    let b = this.bufs.get(kind);
    if (!b) {
      const data = SYNTH[kind]();
      b = o.ctx.createBuffer(1, data.length, SR);
      b.getChannelData(0).set(data);
      this.bufs.set(kind, b);
    }
    return b;
  }

  /** Make the buffers now (when audio runs), so the first play does not wait. */
  prepare(): void {
    for (const k of Object.keys(SYNTH) as Kind[]) this.buf(k);
  }

  play(kind: Exclude<Kind, 'hum'>, gain = 1, rate = 1): void {
    const o = this.out(), b = this.buf(kind);
    if (!o || !b) return;
    const src = o.ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = rate;
    const g = o.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(o.out);
    src.start();
    const e = { src, gain: g };
    this.live.push(e);
    src.onended = () => { g.disconnect(); this.live = this.live.filter((x) => x !== e); };
  }

  /** The shard's hum: level 0..1 (smoothed); 0 stops nothing, `stop()` does. */
  humLevel(level: number, rate = 1): void {
    const o = this.out();
    if (!o) return;
    if (!this.hum) {
      const b = this.buf('hum');
      if (!b || level <= 0.001) return;
      const src = o.ctx.createBufferSource();
      src.buffer = b;
      src.loop = true;
      const gain = o.ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain).connect(o.out);
      src.start();
      this.hum = { src, gain };
    }
    const t = o.ctx.currentTime;
    this.hum.gain.gain.setTargetAtTime(level, t, 0.25);
    this.hum.src.playbackRate.setTargetAtTime(rate, t, 0.3);
  }

  /** Everything off (fading over a moment). */
  stop(fade = 0.4): void {
    const o = this.out();
    if (!o) return;
    const t = o.ctx.currentTime;
    for (const e of [...this.live, ...(this.hum ? [this.hum] : [])]) {
      e.gain.gain.setTargetAtTime(0, t, fade / 3);
      try { e.src.stop(t + fade + 0.1); } catch { /* stopped */ }
    }
    this.hum = null;
    this.live = [];
  }
}

// ------------------------------------------------------------------ synthesis

let seed = 0x0c1a55ed;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) * 2 - 1; };
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** One-pole low-pass with a (time-varying) cutoff. */
function lowpass(x: Float32Array, fc: (t: number) => number): Float32Array {
  const out = new Float32Array(x.length);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    const a = 1 - Math.exp((-2 * Math.PI * fc(i / SR)) / SR);
    y += a * (x[i] - y);
    out[i] = y;
  }
  return out;
}

/** State-variable band-pass. */
function bandpass(x: Float32Array, fc: (t: number) => number, q = 0.5): Float32Array {
  const out = new Float32Array(x.length);
  let low = 0, band = 0;
  for (let i = 0; i < x.length; i++) {
    const f = 2 * Math.sin((Math.PI * Math.min(SR * 0.45, fc(i / SR))) / SR);
    low += f * band;
    const high = x[i] - low - q * band;
    band += f * high;
    out[i] = band;
  }
  return out;
}

function noise(n: number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = rnd();
  return a;
}

/** Feedback echoes (a cheap open-air reverb). */
function echoes(x: Float32Array, taps: [number, number][]): Float32Array {
  const out = Float32Array.from(x);
  for (const [d, g] of taps) {
    const o = Math.round(d * SR);
    for (let i = o; i < out.length; i++) out[i] += out[i - o] * g;
  }
  return out;
}

function normalize(x: Float32Array, peak = 0.9): Float32Array {
  let m = 1e-6;
  for (const v of x) m = Math.max(m, Math.abs(v));
  for (let i = 0; i < x.length; i++) x[i] *= peak / m;
  return x;
}

const SYNTH: Record<Kind, () => Float32Array> = {
  /** 7 s: a far hiss swelling to a roaring rush overhead, crackling, pitch rising as it nears. */
  streak: () => {
    const n = 7 * SR;
    const nz = noise(n);
    const body = bandpass(nz, (t) => 300 + 1400 * smooth(0, 6, t) ** 2, 0.7);
    const rumble = lowpass(noise(n), () => 90);
    const out = new Float32Array(n);
    let crackle = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const env = smooth(0, 5.5, t) ** 2 * (1 - smooth(6.2, 7, t));
      if (rnd() > 0.9985 - 0.002 * smooth(2, 6, t)) crackle = 0.6 + 0.4 * Math.abs(rnd());
      crackle *= 0.985;
      out[i] = env * (body[i] * 1.6 + rumble[i] * 2.5 + crackle * rnd() * 0.5);
    }
    return normalize(out, 0.8);
  },
  /** 3 s: the star breaking apart: a sharp crack, then a rolling rumble with echoes. */
  crack: () => {
    const n = 3 * SR;
    const nz = noise(n);
    const lo = lowpass(noise(n), () => 140);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      out[i] = nz[i] * Math.exp(-t * 28) * 1.2 + lo[i] * 3 * Math.exp(-t * 1.6) * smooth(0, 0.05, t);
    }
    return normalize(echoes(out, [[0.21, 0.35], [0.47, 0.22], [0.83, 0.12]]), 0.85);
  },
  /** 4.5 s: the shard coming down: a deep thud, dirt and stone, then a glassy ring dying away. */
  impact: () => {
    const n = Math.round(4.5 * SR);
    const out = new Float32Array(n);
    const dirt = lowpass(noise(n), (t) => 2400 * Math.exp(-t * 6) + 200);
    const ring = [1, 2.76, 5.4, 8.93, 13.3].map((r, k) => ({ f: 520 * r, a: 0.5 / (1 + k * 0.7), d: 1.4 + k * -0.2 }));
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const thud = Math.sin(2 * Math.PI * (38 * t + 30 * (1 - Math.exp(-t * 8)) / 8)) * Math.exp(-t * 5) * 1.4;
      let r = 0;
      for (const p of ring) r += Math.sin(2 * Math.PI * p.f * t) * p.a * Math.exp(-t / Math.max(0.25, p.d));
      out[i] = thud + dirt[i] * 2.2 * Math.exp(-t * 4) + r * 0.35 * smooth(0, 0.01, t);
    }
    return normalize(echoes(out, [[0.18, 0.3], [0.39, 0.18]]), 0.9);
  },
  /** 4 s loop: a crystalline shimmer — beating sines over a soft low drone (seamless). */
  hum: () => {
    const L = 4, n = L * SR;
    const out = new Float32Array(n);
    // Frequencies whole-numbered over the loop length, so it wraps without a click.
    const parts: [number, number][] = [[110, 0.5], [165.25, 0.3], [220.5, 0.32], [330, 0.2], [441, 0.14], [660.25, 0.1], [880.5, 0.07], [1320, 0.05]];
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let v = 0;
      for (const [f, a] of parts) v += Math.sin(2 * Math.PI * f * t) * a;
      const trem = 0.8 + 0.2 * Math.sin((2 * Math.PI * t) / L * 3);
      out[i] = v * trem;
    }
    return normalize(out, 0.5);
  },
  /** 4 s: light pouring in — partials gliding upward, rushing air, a bright bloom at the end. */
  surge: () => {
    const n = 4 * SR;
    const out = new Float32Array(n);
    const air = bandpass(noise(n), (t) => 400 + 3000 * smooth(0, 3.4, t), 0.6);
    const base = [220, 277.2, 329.6, 440, 554.4, 659.3];
    const ph = base.map(() => 0);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const glide = 1 + 1.0 * smooth(0, 3.2, t) ** 1.5;
      let v = 0;
      base.forEach((f, k) => { ph[k] += (2 * Math.PI * f * glide) / SR; v += Math.sin(ph[k]) / (1 + k * 0.4); });
      const env = smooth(0, 3.2, t) ** 1.6 * (1 - smooth(3.5, 4, t));
      out[i] = v * env * 0.5 + air[i] * env * 1.4;
    }
    return normalize(out, 0.85);
  },
  /** 6 s: the white-out into the morning — a soft major chord swelling and dying away. */
  dawn: () => {
    const n = 6 * SR;
    const out = new Float32Array(n);
    const ch = [261.6, 329.6, 392, 523.3, 659.3, 784];
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let v = 0;
      ch.forEach((f, k) => { v += Math.sin(2 * Math.PI * f * t * (1 + 0.002 * Math.sin(t * 3 + k))) / (1 + k * 0.5); });
      out[i] = v * smooth(0, 0.08, t) * Math.exp(-t * 0.55);
    }
    return normalize(echoes(out, [[0.31, 0.3], [0.67, 0.2]]), 0.6);
  },
};
