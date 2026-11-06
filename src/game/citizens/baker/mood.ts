/**
 * The weather-moody baker's mood (pure: no three.js, the self test runs it).
 *
 * Mood is -1 (heartbroken) … +1 (beaming). Every game day has its own baseline from the seed: a
 * good day, an ordinary one or a bad one with a reason (the oven went out, the sourdough starter
 * died …). The mood drifts towards the baseline over a couple of game hours; what the hero does
 * (a kind word, a joke, buying a loaf, a crime stopped on his street, a punch, a wrecked shop
 * front) moves it at once and fades back the same way. Anger (being hit, his bakery damaged) is
 * separate: it makes the gloom a thunderstorm, and cools off in about an hour.
 *
 * His mood is the weather over his street: `moodWeather` pulls the city's weather towards clear
 * skies when he is happy and towards drizzle, rain or a storm when he is sad or cross, weighted
 * by how close the camera is to him.
 */
import { clamp, lerp, smoothstep } from '../../../core/math';
import { Rng, deriveSeed } from '../../../core/rng';
import { WEATHER, blendParams, type WeatherParams } from '../../../world/weather';

export const MOOD = {
  /** Game hours for the mood to drift (halfway-ish) back to the day's baseline. */
  tau: 2.2,
  /** Game hours for anger to cool off. */
  angerTau: 0.9,
  /** Radius (m) of his weather: full strength within `inner`, none beyond `outer`. */
  inner: 38,
  outer: 85,
  /** Moods at which the sky starts to clear / the gloom starts. */
  sunAt: 0.25,
  gloomAt: -0.15,
};

/** What kind of day it is for him, from the seed. */
export interface BakerDay {
  /** Baseline mood of the day. */
  base: number;
  /** Index into the day's reason lines (lines.ts TROUBLES or JOYS), -1 for an ordinary day. */
  reason: number;
  kind: 'bad' | 'fair' | 'good';
}

/** The day's baseline (deterministic per seed and game day). `nTroubles`/`nJoys`: lengths of the reason lists. */
export function bakerDay(seed: number, day: number, nTroubles: number, nJoys: number): BakerDay {
  const r = new Rng(deriveSeed(seed, 'baker-day', day));
  const u = r.float();
  // Bad days are common (that is the fun of him), good ones a little less so.
  if (u < 0.45) return { base: -0.35 - r.float() * 0.5, reason: r.int(0, nTroubles - 1), kind: 'bad' };
  if (u < 0.75) return { base: -0.05 + r.float() * 0.2, reason: -1, kind: 'fair' };
  return { base: 0.4 + r.float() * 0.4, reason: r.int(0, nJoys - 1), kind: 'good' };
}

export interface MoodState {
  /** -1 … 1. */
  mood: number;
  /** 0 … 1. */
  anger: number;
}

/** Step the mood towards the baseline over dtH game hours. */
export function stepMood(s: MoodState, base: number, dtH: number): void {
  const k = 1 - Math.exp(-Math.max(0, dtH) / MOOD.tau);
  s.mood = clamp(s.mood + (base - s.mood) * k, -1, 1);
  s.anger = clamp(s.anger * Math.exp(-Math.max(0, dtH) / MOOD.angerTau), 0, 1);
}

/** Something happened: the mood moves by d (a lift is smaller the happier he already is). */
export function nudge(s: MoodState, d: number, anger = 0): void {
  const room = d > 0 ? 1 - Math.max(0, s.mood) * 0.6 : 1;
  s.mood = clamp(s.mood + d * room, -1, 1);
  s.anger = clamp(s.anger + anger, 0, 1);
  // Cheering up calms him down too.
  if (d > 0) s.anger = Math.max(0, s.anger - d * 0.8);
}

/** The weather he would make on his own: clear for a good mood, drizzle → rain → storm for a bad one. */
export function ownWeather(s: MoodState, out: WeatherParams): WeatherParams {
  if (s.mood >= 0) {
    Object.assign(out, WEATHER.clear);
    out.cover = 0.03; out.wind = 0.08;
    return out;
  }
  const sad = smoothstep(MOOD.gloomAt, -0.95, s.mood);
  blendParams(WEATHER.drizzle, WEATHER.rain, smoothstep(0.3, 0.85, sad), out);
  if (s.anger > 0.05) blendParams({ ...out }, WEATHER.storm, smoothstep(0.05, 0.6, s.anger), out);
  return out;
}

/** How much of his weather there is at distance d (m) from him, for this mood (0 … 1). */
export function moodWeight(s: MoodState, d: number): number {
  const near = 1 - smoothstep(MOOD.inner, MOOD.outer, d);
  const strength = s.mood >= 0 ? smoothstep(MOOD.sunAt, 0.75, s.mood) : Math.max(smoothstep(MOOD.gloomAt, -0.55, s.mood), smoothstep(0.05, 0.4, s.anger));
  return near * strength;
}

const own: WeatherParams = { ...WEATHER.fair };

/** Pull the city's weather (`target`, changed in place) towards his, by `w` (0 … 1). */
export function moodWeather(s: MoodState, w: number, target: WeatherParams): WeatherParams {
  if (w <= 0) return target;
  ownWeather(s, own);
  for (const k of Object.keys(target) as (keyof WeatherParams)[]) target[k] = lerp(target[k], own[k], w);
  return target;
}

/** A word for the mood (status, console). */
export function moodWord(s: MoodState): string {
  if (s.anger > 0.35) return 'furious';
  const m = s.mood;
  return m > 0.6 ? 'beaming' : m > 0.25 ? 'cheerful' : m > -0.15 ? 'all right' : m > -0.5 ? 'glum' : 'heartbroken';
}
