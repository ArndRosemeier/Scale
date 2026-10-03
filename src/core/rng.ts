/**
 * Deterministic random utilities.
 *
 * Everything procedural in Norgo derives from the world seed through these
 * functions, so the same seed always produces the same world on every client
 * and on the (mock) server.
 */

/** 32-bit integer hash (lowbias32 by Chris Wellons). */
export function hash32(x: number): number {
  x |= 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

export function hashCombine(a: number, b: number): number {
  return hash32((a ^ Math.imul(b + 0x9e3779b9, 0x85ebca6b)) >>> 0);
}

export function hash2i(seed: number, x: number, y: number): number {
  return hash32(seed ^ hash32(Math.imul(x, 0x27d4eb2d) ^ hash32(Math.imul(y, 0x165667b1))));
}

export function hash3i(seed: number, x: number, y: number, z: number): number {
  return hash32(seed ^ hash32(Math.imul(x, 0x27d4eb2d) ^ hash32(Math.imul(y, 0x165667b1) ^ hash32(Math.imul(z, 0x9e3779b1)))));
}

/** Hash → float in [0,1). */
export function hashToFloat(h: number): number {
  return (h >>> 8) / 16777216;
}

export function hash2f(seed: number, x: number, y: number): number {
  return hashToFloat(hash2i(seed, x, y));
}

export function hash3f(seed: number, x: number, y: number, z: number): number {
  return hashToFloat(hash3i(seed, x, y, z));
}

/** Stable string hash (FNV-1a followed by avalanche). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return hash32(h);
}

/** Derive a sub-seed for a named subsystem: deriveSeed(world, 'flora', 3). */
export function deriveSeed(seed: number, ...parts: (string | number)[]): number {
  let h = hash32(seed);
  for (const p of parts) h = hashCombine(h, typeof p === 'number' ? hash32(p | 0) : hashString(p));
  return h;
}

/**
 * Small, fast, high quality PRNG (sfc32). Use `fork` to derive independent
 * streams so that adding a random call in one subsystem does not change
 * another subsystem's output.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.a = 0x9e3779b9;
    this.b = 0x243f6a88;
    this.c = 0xb7e15162;
    this.d = this.seed;
    for (let i = 0; i < 12; i++) this.nextU32();
  }

  static from(...parts: (string | number)[]): Rng {
    return new Rng(deriveSeed(0x5eed, ...parts));
  }

  nextU32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** [0,1) */
  float(): number {
    return this.nextU32() / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.float();
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.float() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.float() < p;
  }

  sign(): number {
    return this.float() < 0.5 ? -1 : 1;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.float() * arr.length)];
  }

  /** Pick using weights (parallel array or accessor). */
  weighted<T>(items: readonly T[], weight: (t: T, i: number) => number): T {
    let total = 0;
    for (let i = 0; i < items.length; i++) total += Math.max(0, weight(items[i], i));
    let r = this.float() * total;
    for (let i = 0; i < items.length; i++) {
      r -= Math.max(0, weight(items[i], i));
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  /** Standard normal via Box-Muller. */
  gaussian(mean = 0, std = 1): number {
    let u = 0;
    while (u === 0) u = this.float();
    const v = this.float();
    return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Gaussian clamped into [min,max]. */
  normalIn(min: number, max: number): number {
    const m = (min + max) / 2;
    const g = this.gaussian(m, (max - min) / 5);
    return Math.min(max, Math.max(min, g));
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.float() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /** Choose k distinct elements. */
  sample<T>(arr: readonly T[], k: number): T[] {
    return this.shuffle(arr.slice()).slice(0, Math.min(k, arr.length));
  }

  fork(...parts: (string | number)[]): Rng {
    return new Rng(deriveSeed(this.seed, ...parts));
  }

  /** Uniform point on unit sphere. */
  onSphere(out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    const z = this.range(-1, 1);
    const a = this.range(0, Math.PI * 2);
    const r = Math.sqrt(1 - z * z);
    out[0] = r * Math.cos(a);
    out[1] = r * Math.sin(a);
    out[2] = z;
    return out;
  }
}

/** Parse a user seed (number or arbitrary text) into a 32-bit seed. */
export function parseSeed(input: string | number): number {
  if (typeof input === 'number') return input >>> 0;
  const t = input.trim();
  if (/^\d+$/.test(t)) return Number(BigInt(t) & 0xffffffffn) >>> 0;
  return hashString(t);
}
