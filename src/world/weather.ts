/**
 * Weather schedule (pure, deterministic per seed): a Markov chain of weather states over game
 * time — clear, fair (sunny with clouds, the most common), cloudy, overcast, drizzle, rain,
 * thunderstorm (rare, mostly warm afternoons), fog (mornings, more at the coast). Each state
 * lasts tens of minutes to hours of game time; the change to the next one blends over a few
 * game minutes (rain sets in after the clouds have come and stops before they go). Within a
 * state the rain comes in showers and the wind in gusts (smooth noise over game time).
 *
 * The render / audio / city side lives in render/Weather.ts; this file has no three.js so
 * the self test can run it.
 */
import { clamp, lerp, smoothstep } from '../core/math';
import { Rng, deriveSeed, hash32, hashToFloat } from '../core/rng';

export type WeatherKind = 'clear' | 'fair' | 'cloudy' | 'overcast' | 'drizzle' | 'rain' | 'storm' | 'fog';
export const WEATHER_KINDS: readonly WeatherKind[] = ['clear', 'fair', 'cloudy', 'overcast', 'drizzle', 'rain', 'storm', 'fog'];

/** Continuous weather parameters (all 0..1). */
export interface WeatherParams {
  /** Cloud coverage of the sky shader. */
  cover: number;
  /** Cloud opacity. */
  density: number;
  /** How dark / grey the clouds and the sky are (rain clouds). */
  dark: number;
  /** Rain intensity (0 none, ~0.2 drizzle, ~0.6 rain, 1 downpour). */
  rain: number;
  /** Ground fog / mist / rain haze. */
  fog: number;
  /** Wind strength. */
  wind: number;
  /** Direct sunlight left (1 clear sky, ~0.1 under rain clouds). */
  sun: number;
  /** Lightning rate (storms). */
  lightning: number;
}

export const WEATHER: Record<WeatherKind, WeatherParams> = {
  clear: { cover: 0.06, density: 0.3, dark: 0, rain: 0, fog: 0, wind: 0.12, sun: 1, lightning: 0 },
  fair: { cover: 0.36, density: 0.45, dark: 0, rain: 0, fog: 0, wind: 0.22, sun: 1, lightning: 0 },
  cloudy: { cover: 0.62, density: 0.62, dark: 0.18, rain: 0, fog: 0.05, wind: 0.35, sun: 0.7, lightning: 0 },
  overcast: { cover: 0.97, density: 0.9, dark: 0.45, rain: 0, fog: 0.18, wind: 0.3, sun: 0.22, lightning: 0 },
  drizzle: { cover: 1, density: 0.92, dark: 0.55, rain: 0.22, fog: 0.3, wind: 0.3, sun: 0.16, lightning: 0 },
  rain: { cover: 1, density: 0.95, dark: 0.68, rain: 0.62, fog: 0.38, wind: 0.5, sun: 0.1, lightning: 0.04 },
  storm: { cover: 1, density: 1, dark: 0.88, rain: 1, fog: 0.45, wind: 0.95, sun: 0.05, lightning: 1 },
  fog: { cover: 0.25, density: 0.4, dark: 0.1, rain: 0, fog: 1, wind: 0.04, sun: 0.45, lightning: 0 },
};

export const WEATHER_LABEL: Record<WeatherKind, string> = {
  clear: 'Clear', fair: 'Fair', cloudy: 'Cloudy', overcast: 'Overcast', drizzle: 'Drizzle', rain: 'Rain', storm: 'Thunderstorm', fog: 'Fog',
};

/** Climate of the city (from the world profile). */
export interface Climate {
  /** By the sea: more fog, drizzle and rain. */
  coastal: boolean;
  /** 0 cold … 1 warm: warm cities are sunnier, with more afternoon thunderstorms. */
  warmth: number;
}

export function climateOf(p: { coastal: boolean; warmth: number }): Climate {
  return { coastal: p.coastal, warmth: p.warmth };
}

export interface WeatherSegment {
  kind: WeatherKind;
  /** Absolute game hours. */
  start: number;
  end: number;
  /** Blend time (h) from the previous state, from `start`. */
  blend: number;
}

/** Typical durations (h): [min, max]. */
const DUR: Record<WeatherKind, [number, number]> = {
  clear: [1.5, 6], fair: [2, 8], cloudy: [1, 4.5], overcast: [1.5, 5], drizzle: [0.6, 2.5], rain: [0.5, 2.5], storm: [0.35, 1.2], fog: [1, 3.5],
};

/** First segment starts this long before game time 0, so the start has a history. */
const T0 = -48;

const hourOf = (h: number) => ((h % 24) + 24) % 24;

/**
 * Next state after `from`, for a change at hour `h` (absolute): transition weights by state,
 * modulated by the time of day (fog only before ~9 am, thunderstorms mostly 12–20 h) and the
 * climate.
 */
function nextKind(from: WeatherKind, h: number, c: Climate, r: Rng): WeatherKind {
  const hr = hourOf(h);
  const morning = hr >= 2.5 && hr < 8.5;
  const afternoon = hr >= 12 && hr < 19.5;
  const sea = c.coastal ? 1 : 0;
  const warm = c.warmth;
  const fogW = morning ? (sea ? 2.6 : 1.4) : 0;
  const stormW = (afternoon ? 0.6 + 1.4 * warm : 0.06) * (sea ? 0.8 : 1.15);
  const wet = 1 + 0.35 * sea - 0.3 * warm; // rain / drizzle / overcast
  const sunny = 1 + 0.4 * warm;
  const w: Partial<Record<WeatherKind, number>> =
    from === 'clear' ? { fair: 6 * sunny, cloudy: 1.2, fog: fogW, storm: stormW * 0.3 }
    : from === 'fair' ? { clear: 2.4 * sunny, cloudy: 3.6, rain: 0.35 * wet, fog: fogW * 0.8, storm: stormW }
    : from === 'cloudy' ? { fair: 4.5 * sunny, clear: 0.6, overcast: 2.4 * wet, drizzle: 0.8 * wet, rain: 1.0 * wet, storm: stormW * 0.9, fog: fogW * 0.6 }
    : from === 'overcast' ? { cloudy: 3.2, fair: 0.8 * sunny, drizzle: 2.2 * wet, rain: 2.0 * wet, fog: fogW * 0.5 }
    : from === 'drizzle' ? { overcast: 2.6, cloudy: 2.6, rain: 1.4 * wet, fair: 0.6 }
    : from === 'rain' ? { overcast: 2.4, cloudy: 2.8, drizzle: 1.6, fair: 0.8, storm: stormW * 0.6 }
    : from === 'storm' ? { rain: 3.5, cloudy: 2.5, overcast: 1.2, fair: 0.8 }
    : /* fog */ { fair: 4.5 * sunny, cloudy: 2.6, clear: 1.6, overcast: 1.0 * wet };
  let sum = 0;
  for (const k of WEATHER_KINDS) sum += w[k] ?? 0;
  let x = r.float() * sum;
  for (const k of WEATHER_KINDS) { x -= w[k] ?? 0; if (x < 0) return k; }
  return 'fair';
}

/** Blend time (h) from one state to the next: fronts take a while, storms roll in faster. */
function blendTime(a: WeatherKind, b: WeatherKind): number {
  if (a === 'storm' || b === 'storm') return 0.15;
  if (a === 'fog' || b === 'fog') return 0.45;
  if (b === 'rain' || b === 'drizzle' || a === 'rain' || a === 'drizzle') return 0.25;
  return 0.3;
}

/** Smooth 1D value noise over game time (period in h), in 0..1. */
function vnoise(seed: number, t: number, period: number): number {
  const x = t / period, i = Math.floor(x), f = x - i;
  const a = hashToFloat(hash32(seed ^ (i * 0x27d4eb2d))), b = hashToFloat(hash32(seed ^ ((i + 1) * 0x27d4eb2d)));
  return lerp(a, b, f * f * (3 - 2 * f));
}

export class WeatherSchedule {
  readonly segs: WeatherSegment[] = [];
  private seedN: number;

  constructor(readonly seed: number, readonly climate: Climate) {
    this.seedN = deriveSeed(seed, 'weather-noise');
    // Start in a typical state: fair most of the time.
    const r = new Rng(deriveSeed(seed, 'weather', 0));
    const kind: WeatherKind = r.chance(0.55) ? 'fair' : r.chance(0.5) ? 'clear' : 'cloudy';
    this.segs.push({ kind, start: T0, end: T0 + r.range(...DUR[kind]), blend: 0 });
  }

  /** Extend the chain until it covers time `h`. */
  private extend(h: number): void {
    while (this.segs[this.segs.length - 1].end <= h) {
      const prev = this.segs[this.segs.length - 1];
      const i = this.segs.length;
      const r = new Rng(deriveSeed(this.seed, 'weather', i));
      const kind = nextKind(prev.kind, prev.end, this.climate, r);
      let dur = r.range(...DUR[kind]);
      // Fog burns off by late morning.
      if (kind === 'fog') {
        const hr = hourOf(prev.end);
        dur = Math.max(0.8, Math.min(dur, 11 - hr));
      }
      const blend = Math.min(blendTime(prev.kind, kind), dur * 0.4);
      this.segs.push({ kind, start: prev.end, end: prev.end + dur, blend });
    }
  }

  /** Index of the segment at time h (absolute game hours). */
  indexAt(h: number): number {
    if (h < T0) return 0;
    this.extend(h);
    let lo = 0, hi = this.segs.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (this.segs[m].start <= h) lo = m; else hi = m - 1;
    }
    return lo;
  }

  segmentAt(h: number): WeatherSegment { return this.segs[this.indexAt(h)]; }

  /** Segment number i (the chain is extended as needed). */
  segAt(i: number): WeatherSegment {
    while (this.segs.length <= i) this.extend(this.segs[this.segs.length - 1].end + 0.01);
    return this.segs[i];
  }

  /** The state that dominates at time h (the incoming one past half its blend). */
  kindAt(h: number): WeatherKind {
    const i = this.indexAt(h), s = this.segs[i];
    return i > 0 && h - s.start < s.blend * 0.5 ? this.segs[i - 1].kind : s.kind;
  }

  /** Next change after h: the coming state and when it starts. */
  nextChange(h: number): WeatherSegment {
    const i = this.indexAt(h);
    this.extend(this.segs[i].end + 0.01);
    return this.segs[i + 1];
  }

  /** Continuous weather parameters at time h (absolute game hours). */
  at(h: number, out: WeatherParams = { ...WEATHER.fair }): WeatherParams {
    const i = this.indexAt(h), s = this.segs[i];
    const cur = WEATHER[s.kind];
    const prev = i > 0 ? WEATHER[this.segs[i - 1].kind] : cur;
    const f = s.blend > 0 ? smoothstep(0, s.blend, h - s.start) : 1;
    blendParams(prev, cur, f, out);
    vary(out, h, this.seedN);
    return out;
  }
}

/**
 * Blend two states (f 0 → a, 1 → b): clouds first, then the rain (rain sets in late in the
 * blend and stops early), so a shower never falls from a blue sky.
 */
export function blendParams(a: WeatherParams, b: WeatherParams, f: number, out: WeatherParams): WeatherParams {
  const fr = b.rain >= a.rain ? smoothstep(0.45, 1, f) : smoothstep(0, 0.55, f);
  out.cover = lerp(a.cover, b.cover, f);
  out.density = lerp(a.density, b.density, f);
  out.dark = lerp(a.dark, b.dark, f);
  out.sun = lerp(a.sun, b.sun, f);
  out.fog = lerp(a.fog, b.fog, f);
  out.wind = lerp(a.wind, b.wind, f);
  out.rain = lerp(a.rain, b.rain, fr);
  out.lightning = lerp(a.lightning, b.lightning, fr);
  return out;
}

/**
 * Variation inside a state (continuous in time): showers (rain between ~70 % and 100 %),
 * drifting cloud amount, wind gusts; morning fog thins out as the day warms up.
 */
export function vary(p: WeatherParams, h: number, seed: number): void {
  const n1 = vnoise(seed, h, 0.17), n2 = vnoise(seed ^ 0x51ed, h, 0.6), n3 = vnoise(seed ^ 0x9e37, h, 0.05);
  p.rain *= 0.7 + 0.3 * n1;
  p.cover = clamp(p.cover + (n2 - 0.5) * 0.12 * (1 - p.cover) * 2, 0, 1);
  p.wind = clamp(p.wind * (0.7 + 0.6 * n3), 0, 1);
  const hr = hourOf(h);
  // Fog lifts towards noon (and the haze of rain stays).
  const lift = smoothstep(9, 12.5, hr) * (1 - smoothstep(19, 22, hr));
  p.fog = Math.max(p.fog * (1 - 0.75 * lift), Math.min(p.fog, p.rain * 0.45));
}

/**
 * Wet ground 0..1 after dtH game hours: soaks within minutes in rain, dries over an hour or
 * two (faster in sunshine, slower in fog / overcast).
 */
export function stepWet(wet: number, rain: number, sun: number, dtH: number): number {
  if (rain > 0.03) {
    const target = clamp(0.35 + rain * 1.2, 0, 1);
    if (wet < target) return Math.min(target, wet + dtH * (1.5 + rain * 10));
  }
  return Math.max(0, wet - dtH * (0.25 + 0.75 * sun));
}
