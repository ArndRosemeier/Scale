/**
 * UFOs over the start screen's city: a few saucers circling high up, now and then sweeping a
 * beam over the roofs, and every so often one that dives straight at the camera (with a flash, a
 * shake and, once the page has heard a click or key, a rising hum and a whoosh). Their motion is
 * worked out here each frame; the shaders only draw them (see shaders.ts, UFO_*).
 */
import { smoothstep as smooth, v3cross, v3norm, type Vec3 } from '../../core/math';

/** Saucers drawn at once: the circling ones plus the one that dives at the camera. */
export const UFO_MAX = 4;
const AMBIENT = 3;
/** Saucer radius in metres. */
const RADIUS = 15;
/** Seconds the dive takes, from far away to past the camera. */
const DIVE = 3.2;

export class Ufos {
  /** Per saucer: x, y, z, spin. */
  readonly pos = new Float32Array(UFO_MAX * 4);
  /** Per saucer: tilt axis × angle (x, z), radius, beam strength 0..1. */
  readonly pose = new Float32Array(UFO_MAX * 4);
  count = 0;
  /** True on the frame the diving saucer reaches the camera (flash and shake). */
  hit = false;
  /** True on the frame a dive begins (the hum starts). */
  started = false;
  private next: number;
  private diveAt = -1;
  private hitDone = false;

  constructor(private seed: number, time: number, private dives: boolean) {
    this.next = time + 12 + (seed % 7);
  }

  update(t: number, eye: Vec3, fwd: Vec3): void {
    this.hit = false;
    this.started = false;
    let n = 0;
    for (let i = 0; i < AMBIENT; i++) {
      const dir = i % 2 ? -1 : 1;
      const a = (this.seed % 360) * 0.0175 + i * 2.1 + t * 0.035 * dir;
      const R = 260 + i * 160 + Math.sin(t * 0.05 + i) * 60;
      // A slow scan every half minute: it sinks a little and sweeps its beam over the roofs.
      const ph = ((t + i * 11) / 29) % 1;
      const beam = smooth(0.55, 0.62, ph) * (1 - smooth(0.8, 0.86, ph));
      const y = 185 + i * 30 + Math.sin(t * 0.4 + i * 1.7) * 8 - beam * 40;
      const x = Math.cos(a) * R + Math.sin(t * 0.7 + i) * 10, z = Math.sin(a) * R + Math.cos(t * 0.53 + i) * 10;
      // Tilted a little into its flight direction.
      const vx = -Math.sin(a) * dir, vz = Math.cos(a) * dir;
      this.set(n++, x, y, z, t * (1.2 + i * 0.4), vz * 0.12, -vx * 0.12, RADIUS, beam);
    }
    if (this.dives) {
      if (this.diveAt < 0 && t >= this.next) { this.diveAt = t; this.hitDone = false; this.started = true; }
      if (this.diveAt >= 0) {
        const s = (t - this.diveAt) / DIVE;
        if (s >= 1) {
          this.diveAt = -1;
          this.next = t + 40 + ((this.seed + Math.floor(t)) % 37);
        } else {
          // From far ahead, curving in and speeding up, straight past the camera's face.
          const ahead = v3norm([fwd[0], 0, fwd[2]]);
          const right = v3norm(v3cross(ahead, [0, 1, 0]));
          const d = 1200 + (-25 - 1200) * s ** 2.4;
          const lift = 140 * (1 - s) ** 1.6 + 2, side = -180 * (1 - s) ** 1.5;
          const x = eye[0] + ahead[0] * d + right[0] * side, y = eye[1] + lift, z = eye[2] + ahead[2] * d + right[2] * side;
          // Nose down towards the camera, so its glowing belly faces you as it arrives.
          const tilt = 0.25 + 0.35 * s;
          const ax = v3norm(v3cross([-fwd[0], 0, -fwd[2]], [0, 1, 0]));
          this.set(n++, x, y, z, t * 6, ax[0] * tilt, ax[2] * tilt, RADIUS, 0);
          if (!this.hitDone && d < 30) { this.hit = true; this.hitDone = true; }
        }
      }
    }
    this.count = n;
  }

  private set(i: number, x: number, y: number, z: number, spin: number, tx: number, tz: number, r: number, beam: number): void {
    this.pos.set([x, y, z, spin], i * 4);
    this.pose.set([tx, tz, r, beam], i * 4);
  }
}

/** The saucer: a lathe of its profile (unit radius), position + normal per vertex. */
export function saucerMesh(): Float32Array {
  const prof: [number, number][] = [[0, -0.24], [0.3, -0.21], [0.78, -0.1], [1, 0], [0.86, 0.08], [0.5, 0.15], [0.36, 0.17], [0.34, 0.3], [0.25, 0.42], [0.13, 0.49], [0, 0.51]];
  const seg = 36, out: number[] = [];
  for (let k = 0; k + 1 < prof.length; k++) {
    const [r0, y0] = prof[k], [r1, y1] = prof[k + 1];
    const nl = Math.hypot(y1 - y0, r1 - r0) || 1;
    const nr = (y1 - y0) / nl, ny = -(r1 - r0) / nl;
    for (let s = 0; s < seg; s++) {
      const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
      const v = (r: number, y: number, a: number): number[] => [Math.cos(a) * r, y, Math.sin(a) * r, Math.cos(a) * nr, ny, Math.sin(a) * nr];
      out.push(...v(r0, y0, a0), ...v(r1, y1, a0), ...v(r1, y1, a1), ...v(r0, y0, a0), ...v(r1, y1, a1), ...v(r0, y0, a1));
    }
  }
  return new Float32Array(out);
}

/** The beam: an open cone, apex ring at y = 0, wide ring at y = -1 (x, z carry the direction, the
 * normal slot carries the radius factor). */
export function beamMesh(): Float32Array {
  const seg = 28, out: number[] = [];
  for (let s = 0; s < seg; s++) {
    const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
    const v = (a: number, y: number): number[] => [Math.cos(a), y, Math.sin(a), y === 0 ? 0.32 : 1.9, 0, 0];
    out.push(...v(a0, 0), ...v(a0, -1), ...v(a1, -1), ...v(a0, 0), ...v(a1, -1), ...v(a1, 0));
  }
  return new Float32Array(out);
}

/** The dive's sound: a hum rising to a shriek, then a whoosh as it passes. Quiet, short, made on the spot. */
export function diveSound(ctx: AudioContext): void {
  const t = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.value = 0.22;
  out.connect(ctx.destination);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.6, t + 2.4);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 3.3);
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(300, t);
  f.frequency.exponentialRampToValueAtTime(4000, t + 2.6);
  f.connect(g).connect(out);
  for (const det of [0, 7]) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(55 + det, t);
    o.frequency.exponentialRampToValueAtTime(420 + det * 4, t + 2.65);
    o.frequency.exponentialRampToValueAtTime(90, t + 3.3);
    // A wobble, the way saucers sound in old films.
    const lfo = ctx.createOscillator(), depth = ctx.createGain();
    lfo.frequency.value = 7 + det;
    depth.gain.value = 12;
    lfo.connect(depth).connect(o.frequency);
    o.connect(f);
    o.start(t); lfo.start(t);
    o.stop(t + 3.4); lfo.stop(t + 3.4);
  }
  // Whoosh: noise through a band-pass sweeping down as it goes past.
  const len = Math.floor(ctx.sampleRate * 1.2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 0.8;
  const w = t + 2.55;
  bp.frequency.setValueAtTime(2500, w);
  bp.frequency.exponentialRampToValueAtTime(300, w + 1.1);
  const wg = ctx.createGain();
  wg.gain.setValueAtTime(0.0001, w);
  wg.gain.exponentialRampToValueAtTime(1.4, w + 0.12);
  wg.gain.exponentialRampToValueAtTime(0.0001, w + 1.1);
  src.connect(bp).connect(wg).connect(out);
  src.start(w);
}
