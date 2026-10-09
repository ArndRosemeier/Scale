/**
 * The pieces of the score (Arnd's Lyria tracks, built by tools/music/build_tracks.py into
 * public/music/tracks, listed in public/music/tracks.json): which plays for which mood, and the
 * cues that play over everything else (pure data, tested in tools/selftest.ts).
 *
 * Calm moods and cues stream one piece (an MP3, played once); the danger moods loop a bar-true
 * cut (Ogg, decoded and looped sample-exact). Where a mood has two pieces, they take turns.
 */
import type { Mood } from './mood';

export const MOOD_TRACKS: Record<Mood, readonly string[]> = {
  day: ['day-1', 'day-2'],
  night: ['night-1', 'night-2'],
  under: ['under-1', 'under-2'],
  halls: ['halls'],
  country: ['country'],
  hero: ['hero-1', 'hero-2'],
  tension: ['tension-1', 'tension-2'],
  villain: ['villain'],
  battle: ['battle-1', 'battle-2'],
  slime: ['slime'],
  elegy: ['elegy-1', 'elegy-2'],
};

/** The danger very close (tension at full intensity): the harder loop. */
export const TENSION_HIGH = 'tension-high';
/** Tension intensity that brings in the harder loop, and where it goes back. */
export const TENSION_HIGH_ON = 0.8;
export const TENSION_HIGH_OFF = 0.62;

export type Cue = 'victory' | 'rescue' | 'gameover' | 'origin';
export const CUES: Record<Cue, { track: string; fadeIn: number; fadeOut: number; level: number }> = {
  /** A big threat beaten near the player (a sting over the fading fight). */
  victory: { track: 'victory', fadeIn: 0.05, fadeOut: 2, level: 1 },
  /** The drones carry the hero to the hospital. */
  rescue: { track: 'rescue', fadeIn: 1.5, fadeOut: 3, level: 0.9 },
  /** The game over screen. */
  gameover: { track: 'gameover', fadeIn: 0.5, fadeOut: 3, level: 0.9 },
  /** The origin scene (its impact lines up with the scene's: ORIGIN_IMPACT). */
  origin: { track: 'origin', fadeIn: 0.3, fadeOut: 4, level: 0.85 },
};
/** Where the impact is in the origin piece (s). */
export const ORIGIN_IMPACT = 8.0;

export interface TrackInfo { file: string; kind: 'stream' | 'loop'; seconds: number }

/** Parse public/music/tracks.json (null when malformed). */
export function parseTracks(o: unknown): Record<string, TrackInfo> | null {
  const t = (o as { tracks?: Record<string, Partial<TrackInfo>> } | null)?.tracks;
  if (!t || typeof t !== 'object') return null;
  const out: Record<string, TrackInfo> = {};
  for (const [id, v] of Object.entries(t)) {
    if (typeof v?.file !== 'string' || (v.kind !== 'stream' && v.kind !== 'loop') || !(Number(v.seconds) > 0)) continue;
    out[id] = { file: v.file, kind: v.kind, seconds: Number(v.seconds) };
  }
  return out;
}
