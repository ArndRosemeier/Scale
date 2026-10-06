/**
 * Fame: the city's reputation of the player made visible (Reputation, −100 … +100). Pure rules: no
 * three.js, no game — the game's `Fame` (fame/Fame.ts) and the headless checks share them.
 *
 *   ≥ FAME.pressAt   photographers turn up where the hero is and flash away; the more famous, the
 *                    more of them, then a TV crew (a reporter with a microphone and a camera operator)
 *   ≥ FAME.fansAt    fans run up for a selfie, passers-by call out to the hero
 *   ≥ FAME.statueAt  held for a while: the city council votes for a statue of the hero in front of
 *                    the town hall; it is built behind a fence, then unveiled, and stays
 *   < 0              protesters gather with placards near the hero and chant, passers-by grumble
 *                    and boo (unfriendly speech bubbles); the more hated, the bigger the crowd
 *   < 0 for a while  with a statue standing: protesters pull it down
 *
 * The police and the army escalate at a low reputation in the justice layer (a manhunt at
 * JUSTICE.manhunt) and the rampage watch (threats/rampageRules: any size, sooner the lower it is).
 */

export const FAME = {
  /** Photographers from here; a TV crew from `tvAt`. */
  pressAt: 35, tvAt: 65,
  /** Fans asking for a selfie from here; passers-by call out to the hero from `hailAt`. */
  fansAt: 50, hailAt: 30,
  /** The statue: the reputation held at `statueAt` for `statueHold` s brings the vote; building takes `buildT` s. */
  statueAt: 80, statueHold: 45, buildT: 150,
  /** Below 0 for `toppleHold` s: a standing statue is pulled down, one being built is called off. */
  toppleHold: 40,
  /** Unfriendly remarks below this; protests below `protestAt`. */
  booAt: 0, protestAt: 0,
  /** The press: a visit every `gap` s (random within), sooner after a good deed; it stays `stay` s. */
  press: { gap: [55, 110] as [number, number], afterDeed: 5, stay: 70, ring: [4.5, 8] as [number, number], flashGap: [0.9, 3.2] as [number, number], come: 45 },
  /** A fan: every `gap` s (random within), and how close they come (m). */
  fan: { gap: [35, 80] as [number, number], near: 1.6 },
  /** A protest: every `gap` s (random within) while hated, staying `stay` s; they follow at `follow` m. */
  protest: { gap: [70, 130] as [number, number], stay: 140, follow: [8, 15] as [number, number], come: 60 },
};

/** Photographers (not counting a TV crew) at this reputation. */
export function pressCount(rep: number): number {
  if (rep < FAME.pressAt) return 0;
  return rep >= 85 ? 3 : rep >= 60 ? 2 : 1;
}

/** A TV crew comes along at this reputation. */
export function tvCrew(rep: number): boolean { return rep >= FAME.tvAt; }

/** Protesters in a group at this reputation: none at 0 or above, 3 just below, up to 12. */
export function protestSize(rep: number): number {
  if (rep >= FAME.protestAt) return 0;
  return Math.min(12, 3 + Math.floor(-rep / 9));
}

/** The chance a passer-by close to the hero says something (per pass): friendly, unfriendly, or nothing. */
export function remarkKind(rep: number): 'hail' | 'boo' | null {
  if (rep >= FAME.hailAt) return 'hail';
  if (rep < FAME.booAt) return 'boo';
  return null;
}

export type StatueState = 'none' | 'building' | 'standing' | 'toppled';
export type StatueSignal = 'voted' | 'unveiled' | 'cancelled' | 'toppled';

/** The hero's statue: voted, built, unveiled, pulled down — step by step, by the reputation. */
export class StatueClock {
  state: StatueState = 'none';
  /** Seconds building; seconds the reputation held high (for the vote) or low (to pull it down). */
  t = 0;
  high = 0;
  low = 0;
  /** How often: unveiled, pulled down. */
  stats = { unveiled: 0, toppled: 0, cancelled: 0 };

  step(dt: number, rep: number): StatueSignal | null {
    const F = FAME;
    this.high = rep >= F.statueAt ? this.high + dt : 0;
    this.low = rep < 0 ? this.low + dt : 0;
    switch (this.state) {
      case 'none':
      case 'toppled':
        if (this.high < F.statueHold) return null;
        this.state = 'building'; this.t = 0; this.high = 0;
        return 'voted';
      case 'building':
        this.t += dt;
        if (this.low >= F.toppleHold) { this.state = 'none'; this.t = 0; this.stats.cancelled++; return 'cancelled'; }
        if (this.t < F.buildT) return null;
        this.state = 'standing'; this.stats.unveiled++;
        return 'unveiled';
      case 'standing':
        if (this.low < F.toppleHold) return null;
        this.state = 'toppled'; this.low = 0; this.stats.toppled++;
        return 'toppled';
    }
  }

  /** Building progress 0 … 1. */
  get progress(): number { return this.state === 'building' ? Math.min(1, this.t / FAME.buildT) : this.state === 'standing' ? 1 : 0; }

  serialize(): { state: StatueState; t: number } { return { state: this.state, t: Math.round(this.t * 10) / 10 }; }

  restore(o: { state?: unknown; t?: unknown } | null | undefined): void {
    const s = o?.state;
    this.state = s === 'building' || s === 'standing' || s === 'toppled' ? s : 'none';
    this.t = Math.max(0, Math.min(FAME.buildT, Number(o?.t) || 0));
    this.high = 0; this.low = 0;
  }
}

// ================================================================== lines

export const FAME_LINES = {
  press: ['Over here!', 'One more, please!', 'Look this way!', 'Smile!', 'Hero! Over here!', 'Just one shot!', 'Front page!'],
  pressQ: ['Any words for our readers?', 'How does it feel to save the city?', 'Who are you under there?', 'Can you fly for the camera?', 'What\'s your next move?'],
  tv: ['We\'re live! A word for the viewers?', 'This is Channel 6 — we\'re here with the hero!', 'Live on air: the city\'s hero!', 'Our viewers want to know: who are you?'],
  fan: ['Oh my god, it\'s you!', 'Can I get a selfie?', 'You\'re amazing!', 'Can I have a photo?', 'My kids love you!', 'I\'m your biggest fan!'],
  fanThanks: ['Thank you!', 'Best day ever!', 'Nobody will believe me!'],
  hail: ['It\'s the hero!', 'Thank you!', 'Look, it\'s them!', 'Hey, hero!', 'Keep it up!', 'You\'re the best!', 'Our hero!'],
  boo: ['Get lost!', 'Go away!', 'Menace!', 'We don\'t want you here!', 'Who pays for all this?', 'Leave us alone!', 'Shame on you!', 'Boo!'],
  chant: ['Go home! Go home!', 'Not our hero!', 'Menace out!', 'Hey hey, ho ho, the menace has to go!', 'Stop the damage!', 'Out of our city!', 'Lock them up!'],
  protestSee: ['There they are!', 'Shame! Shame!', 'Look what you did!', 'Get out of our city!'],
  statue: ['A statue! Can you believe it?', 'They built a statue of the hero!', 'Our hero, in bronze!'],
};

/** Placard texts (index = placard id 'placard_<i>'; humanoid/client/streetwear builds them). */
export { PLACARDS } from '../../humanoid/client/placards';
