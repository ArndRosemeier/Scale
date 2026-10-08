/**
 * Behaviour from personality (NPC_PERSONALITY_PLAN §3.5, phase 2): the rules that turn someone's
 * Big Five traits and their opinion of the hero into what they do in the street. Manners.ts does
 * it to the people around you; perception (sim/Reactions) reads `nerve` and `curiosity` itself.
 *
 *  - Pace: outgoing and conscientious people walk briskly, dreamers dawdle.
 *  - Fear: the calm get over a scare quickly, the nervous run longer (sim/Reactions).
 *  - Gawking: the curious stop to look longer (sim/Pedestrians.gawkOver).
 *  - Keeping away: people who dislike the hero give them a wide berth and won't talk to them.
 *  - Kindness: the agreeable help someone up who fell, and point out a fleeing thief.
 *  - Words: what someone shouts when they run, gawk or get up is in their temperament.
 *
 * Pure: no DOM, no three.js.
 */
import type { Traits, Temperament } from './identity';

export const MANNERS = {
  /** Walking pace: 1 + (E − ½)·paceE + (C − ½)·paceC, never outside paceMin..paceMax. */
  paceE: 0.3, paceC: 0.22, paceMin: 0.8, paceMax: 1.22,
  /** Opinion at which someone keeps out of your way, and at which they won't talk to you. */
  wary: -30, refuse: -65,
  /** Room they keep (m): at `wary`, and at −100. */
  berthMin: 2.5, berthMax: 6,
  /** Helping someone up: agreeableness needed, how far they come (m), how long the fallen lie first (s). */
  helpAgree: 0.66, helpR: 22, helpAfter: 9,
  /** An everyday fall (the hero's karma) is left to the hero this long before a stranger helps (s). */
  helpAfterAccident: 40,
  /** Pointing out a fleeing thief: agreeableness needed, how near the thief runs past (m). */
  pointAgree: 0.6, pointR: 14,
  /** People busy with a good turn at once, at most. */
  maxBusy: 3,
  /** Street chats at once (pairs, phase 4), and the chance per second of looking for someone to stop for a snack. */
  maxChats: 2, snackChance: 0.12,
  /** Waving at a hero they like: opinion needed (extraverts wave sooner, by up to waveE). */
  wave: 35, waveE: 25,
} as const;

/** Walking pace multiplier for a person (1 = the population's usual). */
export function paceOf(t: Traits): number {
  const k = 1 + (t.e - 0.5) * MANNERS.paceE + (t.c - 0.5) * MANNERS.paceC - (t.o > 0.8 && t.c < 0.35 ? 0.06 : 0);
  return Math.max(MANNERS.paceMin, Math.min(MANNERS.paceMax, k));
}

/** How fast a scare wears off (fear per second): the calm recover three times as fast as the nervous. */
export function calmRate(nerve: number): number {
  return 0.09 - 0.06 * Math.max(0, Math.min(1, nerve));
}

/** Seconds they stand and look at something before walking on (the curious stay longer). */
export function gawkFor(curiosity: number, look: number): number {
  return 3 + curiosity * 9 + (look % 4);
}

/** Room (m) someone keeps from the hero, 0: none (they don't mind you). Agreeable people keep a little less. */
export function berthOf(opinion: number, t: Traits): number {
  if (opinion > MANNERS.wary) return 0;
  const k = Math.min(1, (MANNERS.wary - opinion) / (MANNERS.wary + 100));
  return (MANNERS.berthMin + (MANNERS.berthMax - MANNERS.berthMin) * k) * (1.15 - t.a * 0.3);
}

/** Won't talk to you at all. */
export function refuses(opinion: number): boolean {
  return opinion <= MANNERS.refuse;
}

/** Steps over to help someone up who fell (kind, not too frightened, not a child). */
export function helps(t: Traits, fear: number, child: boolean): boolean {
  return !child && t.a >= MANNERS.helpAgree && fear < 0.3 && t.n < 0.8;
}

/** Points after a thief running past (agreeable, and bold enough). */
export function points(t: Traits, fear: number): boolean {
  return t.a >= MANNERS.pointAgree && t.n < 0.7 && fear < 0.6;
}

/** Waves to the hero (they know and like you; outgoing people wave sooner). */
export function waves(opinion: number, t: Traits): boolean {
  return opinion >= MANNERS.wave + (0.5 - t.e) * 2 * MANNERS.waveE;
}

// ------------------------------------------------------------------ words

export type Moment = 'flee' | 'gawk' | 'film' | 'thanks' | 'ouch' | 'away' | 'refuse' | 'point' | 'helper';

/** What people say in a moment, by temperament (missing: the common lines in ui/Barks). */
export const REACT: Record<Moment, Partial<Record<Temperament, readonly string[]>>> = {
  flee: {
    anxious: ['Oh no, oh no, oh no!', 'I knew it! I knew this would happen!', 'Help!'],
    grumpy: ['Not again!', 'Every single week!', 'Somebody do something!'],
    cheerful: ['Okay, time to go!', 'Nope! Nope!'],
    proud: ['Out of my way!', 'This is outrageous!'],
    shy: ['Eek!'],
    steady: ['Everyone keep calm! Move!', 'This way, quickly!'],
    kind: ['Come on, this way!', 'Mind the children!'],
  },
  gawk: {
    nosy: ['What\'s going on?', 'Ooh, what happened?', 'Did you see that?'],
    dreamy: ['Wow…', 'That\'s… beautiful, somehow.'],
    grumpy: ['Oh, great.', 'And who pays for that?'],
    anxious: ['Is that safe?', 'Should we be standing here?'],
    chatty: ['Wait till I tell everyone!', 'Did you see that?!'],
    steady: ['Hm.', 'Stay back, people.'],
  },
  film: {
    chatty: ['This is going straight online!', 'Are you seeing this, guys?'],
    nosy: ['Got it, got it!', 'Zoom in, zoom in…'],
    cheerful: ['Oh, this is amazing!'],
    dreamy: ['Look at the light…'],
  },
  thanks: {
    grumpy: ['…Thanks, I suppose.', 'Took you long enough.'],
    shy: ['Th-thank you.', 'Oh… thanks.'],
    cheerful: ['You\'re a star!', 'Thank you so much!'],
    proud: ['I\'m perfectly fine. But thank you.'],
    kind: ['Bless you.', 'You\'re very kind, thank you.'],
    chatty: ['Thank you! You won\'t believe what happened—'],
    anxious: ['Is it over? Thank you, thank you.'],
  },
  ouch: {
    grumpy: ['Who put that there?!', 'Typical!'],
    proud: ['I\'m fine! I\'m fine.'],
    anxious: ['Ow… is it broken?'],
    dreamy: ['Huh… how did I get down here?'],
  },
  away: {
    grumpy: ['Keep away from me.', 'Don\'t you come near me.', 'Hmph.'],
    anxious: ['Please, just leave me alone.', 'Don\'t hurt me!'],
    proud: ['Some hero you are.', 'Don\'t touch me.'],
    shy: ['…'],
    chatty: ['Oh, look who it is. Wrecked anything today?', 'Stay away, I mean it!'],
    kind: ['I\'d rather you kept your distance.'],
    cheerful: ['Uh, I\'ll just… go this way.'],
    nosy: ['Keep away from me, you menace.'],
    dreamy: ['Oh. You.'],
    steady: ['Keep your distance, please.'],
  },
  refuse: {
    grumpy: ['I\'ve got nothing to say to you.', 'Get lost.'],
    anxious: ['No. No, please, just go.', 'Leave me alone!'],
    proud: ['I don\'t talk to people like you.', 'We have nothing to discuss.'],
    shy: ['…No.'],
    chatty: ['Oh, now you want to talk? After what you did? No.'],
    kind: ['I\'m sorry, I can\'t talk to you. Not after that.'],
    cheerful: ['Uh, no. No thanks.'],
    nosy: ['Talk to you? After what you did? No way.'],
    dreamy: ['I\'d rather not.'],
    steady: ['No. Good day.'],
  },
  point: {
    grumpy: ['Oi! That way!', 'Thief! There!'],
    anxious: ['There! There they go!'],
    proud: ['Stop, thief!', 'That way! After them!'],
    chatty: ['They ran that way! I saw everything!', 'That way, that way!'],
    kind: ['Over there! Quick!'],
    steady: ['That way. Go!', 'Heading for the corner, there!'],
    cheerful: ['There they go! Get them!'],
    nosy: ['That way! I saw the whole thing!'],
    dreamy: ['Wasn\'t that… yes, that way!'],
    shy: ['Th-there! That way!'],
  },
  helper: {
    kind: ['Here, let me help you.', 'Are you all right? Take my hand.', 'Easy now, easy.'],
    cheerful: ['Up you get!', 'Whoops, there we go!'],
    steady: ['Take my arm. Slowly.', 'Can you stand? Good.'],
    chatty: ['Oh dear, are you hurt? Let me help.', 'Come on, up you get, that looked nasty!'],
    nosy: ['Goodness, what happened? Here.'],
    proud: ['Allow me.'],
    dreamy: ['Oh! Here, let me help.'],
    shy: ['Um… need a hand?'],
    anxious: ['Are you okay? Oh dear. Here.'],
    grumpy: ['Come on, up you get.'],
  },
};

/** A line for a moment in this temperament, or null (the common line will do). */
export function reactLine(m: Moment, t: Temperament, u: number): string | null {
  const l = REACT[m][t];
  if (!l?.length) return null;
  // The common line now and then even for those who have their own (less samey crowds); never for the moments only people have.
  if (u > 0.8 && (m === 'flee' || m === 'gawk' || m === 'film' || m === 'thanks' || m === 'ouch')) return null;
  return l[Math.floor((u / 0.8 % 1) * l.length) % l.length];
}
