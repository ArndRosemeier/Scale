/**
 * Which music plays when (pure logic, no Web Audio: tested in tools/selftest.ts).
 *
 * The game is scored sparsely: calm music comes in episodes (one piece, then silence until the
 * next); danger always gets music while it lasts.
 *
 *   calm     day · night · under (sewers, metro) · halls (inside a landmark) · aliens (a Warden's
 *            disc or walker close by) · country (out of town by day) · hero (flying fast)
 *                                                                          — episodes and rests
 *   tension  a threat or a crime close by, the police after the player     — while it lasts
 *   villain  a named boss's operation or a cult's rite close by (instead of tension / battle)
 *   battle   the Strider rampaging nearby, robots in a full fight, the last-resort countdown
 *   slime    the war under the city in full swing (instead of battle down there)
 *   elegy    after a fight with casualties / a strike: one piece, then a long rest
 *
 * Danger levels go up quickly (after a short confirmation) and come down only after a hold
 * (hysteresis: a robot stepping in and out of range does not flap the score). Calm moods
 * switch with their own thresholds and delays (night at dusk, going underground …).
 * The pieces themselves (Lyria tracks) and the cues (victory, rescue, game over, the origin
 * scene) are chosen by Music / tracks.ts.
 */
import { saturate as clamp01 } from '../../core/math';

export type Mood = 'day' | 'night' | 'under' | 'halls' | 'aliens' | 'country' | 'hero' | 'tension' | 'villain' | 'battle' | 'slime' | 'elegy';
export const MOODS: Mood[] = ['day', 'night', 'under', 'halls', 'aliens', 'country', 'hero', 'tension', 'villain', 'battle', 'slime', 'elegy'];
/** Moods that loop for as long as they last (the rest play one piece). */
export const LOOPED: ReadonlySet<Mood> = new Set<Mood>(['tension', 'villain', 'battle', 'slime']);

/** What the game tells the music each frame (see Music.probe). */
export interface MusicSignals {
  /** The player is below the streets (sewers, metro). */
  under: boolean;
  /** Inside a landmark's halls (cathedral, museum, town hall, starship …). */
  halls: boolean;
  /** A Warden's disc hovering over the player, or a walker down close by. */
  aliens: boolean;
  /** Out of town (past the city's edge). */
  country: boolean;
  /** 0 day … 1 night. */
  night: number;
  /** 0 dry … 1 storm. */
  rain: number;
  /** 0 … 1: a threat or crime close by, the police after the player. */
  danger: number;
  /** 0 … 1: a full fight nearby (the Strider rampaging, the army, the countdown). */
  battle: number;
  /** A named boss's operation or a cult's rite is the danger close by. */
  villain: boolean;
  /** The war under the city is the fight. */
  slime: boolean;
  /** Casualties waiting / a struck district near the player. */
  grief: boolean;
  /** Player flight speed (m/s, scaled to body size; 0 on foot). */
  flySpeed: number;
  /** The origin scene (or anything else that wants silence) runs. */
  hush: boolean;
}

export const CALM_SIGNALS: MusicSignals = { under: false, halls: false, aliens: false, country: false, night: 0, rain: 0, danger: 0, battle: 0, villain: false, slime: false, grief: false, flySpeed: 0, hush: false };

/** Timing (seconds). */
export const MOOD_TUNING = {
  firstEpisode: [20, 45] as [number, number],
  /** Cap of a calm episode: normally the piece ending (endEpisode) ends it first. */
  episode: [240, 300] as [number, number],
  rest: [100, 240] as [number, number],
  /** Rest after a fight before calm music may come back. */
  restAfterFight: [70, 140] as [number, number],
  /** Time after the last rest began before a change of place (under / flight) may start an episode early. */
  placeRest: 40,
  dangerUp: 1.5, battleUp: 0.4,
  tensionHold: 14, battleHold: 20,
  /** Cap of an elegy (the piece ending ends it first). */
  elegy: [150, 170] as [number, number],
  elegyCooldown: 480,
  heroOn: 45, heroOff: 25, heroUpT: 3, heroDownT: 6, heroMax: 200,
  nightOn: 0.62, nightOff: 0.38,
  underT: 2.5,
  hallsT: 2,
  /** A disc must be about this long before its music comes (and gone this long before it goes). */
  aliensOn: 3, aliensOff: 20,
};

export type Phase = 'rest' | 'play';

export interface MoodOut {
  /** The set to play, or null for silence. */
  mood: Mood | null;
  /** 0 … 1 inside the mood (layers build up with it). */
  intensity: number;
  /** Why (debug). */
  why: string;
}

/** Stateful mood selector with hysteresis. `update` once per frame with real seconds. */
export class MoodDirector {
  /** 0 calm, 1 tension, 2 battle. */
  level = 0;
  phase: Phase = 'rest';
  /** Seconds left in the current episode or rest. */
  left: number;
  /** Seconds spent in the current rest. */
  rested = 0;
  calm: Mood = 'day';
  night = false;
  under = false;
  hero = false;
  halls = false;
  aliens = false;
  country = false;
  /** Seconds of elegy left (> 0: playing it). */
  elegy = 0;
  /** Seconds since the last elegy (cooldown). */
  sinceElegy = 1e9;
  /** Forced mood (dev), null = automatic. */
  forced: Mood | null = null;
  private upT = 0;
  private downT = 0;
  private underT = 0;
  private hallsT = 0;
  private aliensT = 0;
  private heroT = 0;
  private heroPlay = 0;
  private fought = false;
  private griefSeen = false;
  intensity = 0;

  constructor(private rng: () => number = Math.random) {
    this.left = this.pick(MOOD_TUNING.firstEpisode);
  }

  private pick([a, b]: [number, number]): number { return a + (b - a) * this.rng(); }

  update(dt: number, s: MusicSignals): MoodOut {
    const T = MOOD_TUNING;
    if (this.forced) return { mood: this.forced, intensity: this.forced === 'battle' || this.forced === 'tension' ? 1 : 0.6, why: 'forced' };
    this.sinceElegy += dt;

    // ---- danger level, with confirmation going up and a hold going down
    const want = s.battle > 0.5 ? 2 : s.danger > 0.5 ? 1 : 0;
    if (want > this.level) {
      this.downT = 0;
      this.upT += dt;
      if (this.upT >= (want === 2 ? T.battleUp : T.dangerUp)) { this.level = want; this.upT = 0; this.fought = true; }
    } else if (want < this.level) {
      this.upT = 0;
      this.downT += dt;
      if (this.downT >= (this.level === 2 ? T.battleHold : T.tensionHold)) {
        this.level = want;
        this.downT = 0;
        if (this.level === 0) this.fightEnded(s);
      }
    } else { this.upT = 0; this.downT = 0; }
    const tgtI = this.level === 2 ? clamp01(0.55 + s.battle * 0.45) : this.level === 1 ? clamp01(0.35 + s.danger * 0.5) : 0.5;
    this.intensity += (tgtI - this.intensity) * Math.min(1, dt / 3);
    // A boss or a rite near: its own theme, unless a monster is the bigger fight.
    if (this.level >= 1 && s.villain && !(this.level === 2 && s.battle >= 1)) return { mood: 'villain', intensity: this.intensity, why: 'villain' };
    if (this.level === 2) return { mood: s.slime && s.under ? 'slime' : 'battle', intensity: this.intensity, why: 'battle' };
    if (this.level === 1) return { mood: 'tension', intensity: this.intensity, why: 'danger' };

    // ---- calm places (each with its own hysteresis)
    this.underT = s.under === this.under ? 0 : this.underT + dt;
    this.hallsT = s.halls === this.halls ? 0 : this.hallsT + dt;
    const prevPlace = this.place();
    if (this.underT >= T.underT) { this.under = s.under; this.underT = 0; }
    if (this.hallsT >= T.hallsT) { this.halls = s.halls; this.hallsT = 0; }
    this.country = s.country;
    this.aliensT = s.aliens === this.aliens ? 0 : this.aliensT + dt;
    if (this.aliensT >= (s.aliens ? T.aliensOn : T.aliensOff)) { this.aliens = s.aliens; this.aliensT = 0; }
    if (!this.night && s.night >= T.nightOn) this.night = true;
    else if (this.night && s.night <= T.nightOff) this.night = false;
    const fast = this.hero ? s.flySpeed > T.heroOff : s.flySpeed > T.heroOn;
    this.heroT = fast === this.hero ? 0 : this.heroT + dt;
    if (this.heroT >= (this.hero ? T.heroDownT : T.heroUpT)) {
      this.hero = fast;
      this.heroT = 0;
      this.heroPlay = 0;
      // Landing: the flight's music winds down soon (the calm set takes over for its last bars).
      if (!fast && this.phase === 'play') this.left = Math.min(this.left, 25);
    }
    this.calm = this.place();

    if (s.hush) return { mood: null, intensity: 0, why: 'hush' };

    // ---- elegy: after a fight with casualties, or when grief appears near the player
    if (s.grief && !this.griefSeen && this.elegy <= 0 && this.sinceElegy > T.elegyCooldown) this.startElegy();
    this.griefSeen = s.grief;
    if (this.elegy > 0) {
      this.elegy -= dt;
      if (this.elegy <= 0) this.rest(T.rest);
      else return { mood: 'elegy', intensity: 0.5, why: 'aftermath' };
    }

    // ---- episodes and rests
    this.left -= dt;
    if (this.phase === 'rest') {
      this.rested += dt;
      // A change of place (down into the tunnels, taking off at speed) may start music early.
      const placeChanged = this.calm !== prevPlace || (this.calm === 'hero' && this.heroPlay === 0);
      if (this.left <= 0 || (placeChanged && this.rested > T.placeRest && this.calm !== 'day' && this.calm !== 'night' && this.calm !== 'country')) {
        this.phase = 'play';
        this.left = this.pick(T.episode);
      }
    } else if (this.left <= 0) this.rest(T.rest);
    if (this.calm === 'hero' && this.phase === 'play') {
      this.heroPlay += dt;
      if (this.heroPlay > T.heroMax) { this.hero = false; this.heroPlay = 0; this.rest(T.rest); }
    }
    this.calm = this.place();
    if (this.phase === 'rest') return { mood: null, intensity: 0, why: `rest ${Math.round(this.left)} s` };
    return { mood: this.calm, intensity: 0.5, why: `episode ${Math.round(this.left)} s` };
  }

  private place(): Mood {
    return this.under ? 'under' : this.halls ? 'halls' : this.aliens ? 'aliens' : this.hero ? 'hero' : this.night ? 'night' : this.country ? 'country' : 'day';
  }

  /** The calm piece played to its end: rest until the next episode. */
  endEpisode(): void {
    if (this.phase === 'play' && this.level === 0 && this.elegy <= 0) this.rest(MOOD_TUNING.rest);
    else if (this.elegy > 0) { this.elegy = 0; this.rest(MOOD_TUNING.rest); }
  }

  /** The fight was won (the victory cue plays): the danger is over now, not after the hold. */
  settle(s: MusicSignals): void {
    if (this.level === 0) return;
    this.level = 0;
    this.upT = 0;
    this.downT = 0;
    this.fightEnded(s);
  }

  private fightEnded(s: MusicSignals): void {
    if (!this.fought) return;
    this.fought = false;
    if (s.grief && this.sinceElegy > T_ELEGY_AFTER_FIGHT) this.startElegy();
    else this.rest(MOOD_TUNING.restAfterFight);
  }

  private startElegy(): void {
    this.elegy = this.pick(MOOD_TUNING.elegy);
    this.sinceElegy = 0;
    this.phase = 'rest';
    this.rested = 0;
  }

  private rest(r: [number, number]): void {
    this.phase = 'rest';
    this.left = this.pick(r);
    this.rested = 0;
  }

  /** Dev: start a calm episode now. */
  play(): void { this.phase = 'play'; this.left = this.pick(MOOD_TUNING.episode); this.elegy = 0; }
  /** Dev: rest now. */
  hushNow(): void { this.elegy = 0; this.rest(MOOD_TUNING.rest); }
}

/** After a fight, an elegy may follow even if one played this long ago. */
const T_ELEGY_AFTER_FIGHT = 120;

/** How a mood comes and goes: crossfade in / out (s) and its level in the mix. */
export const MOOD_FADE: Record<Mood, { fadeIn: number; fadeOut: number; level: number }> = {
  day: { fadeIn: 4, fadeOut: 8, level: 0.85 },
  night: { fadeIn: 4, fadeOut: 8, level: 0.85 },
  under: { fadeIn: 4, fadeOut: 8, level: 0.85 },
  halls: { fadeIn: 4, fadeOut: 6, level: 0.75 },
  aliens: { fadeIn: 4, fadeOut: 8, level: 0.85 },
  country: { fadeIn: 4, fadeOut: 8, level: 0.85 },
  hero: { fadeIn: 1.5, fadeOut: 5, level: 0.9 },
  tension: { fadeIn: 2, fadeOut: 6, level: 0.9 },
  villain: { fadeIn: 2, fadeOut: 6, level: 0.95 },
  battle: { fadeIn: 1, fadeOut: 6, level: 1 },
  slime: { fadeIn: 1, fadeOut: 6, level: 1 },
  elegy: { fadeIn: 6, fadeOut: 10, level: 0.85 },
};

/** Rain darkens the score a little: lowpass cutoff (Hz). */
export function rainTint(rain: number): { lowpass: number } {
  return { lowpass: 18000 - 10000 * Math.sqrt(clamp01(rain)) };
}
