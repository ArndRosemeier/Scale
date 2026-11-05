/**
 * The gentle giant (the pure part: no three.js, runs in the self test). Earlier in the year one of
 * the city's crystals made someone grow to about ten metres, nothing more: no powers, no side in
 * anything. They live with it as well as they can, a friendly, careful, slightly awkward local
 * celebrity at the stadium (GentleGiant.ts is the body and the street around them).
 *
 *  - Where: the stadium. `giantPlan(lm)` gives the walk round the stadium on its apron (a ring past
 *    the stands' backs and the floodlight masts), the +u gate (the end without the scoreboard, which
 *    hangs lower than their head over the other one) in and out of the bowl, the bed on the pitch, and
 *    the places they like to sit (the long sides and the corners: the ends can be car parks).
 *  - When: `dayOf(hour)`: asleep on the pitch after the concert (the stage is gone by OUT) until the
 *    morning, out before the first match, about the stadium all day, sitting outside the gate while
 *    the concert plays, in again when the crowd has gone.
 */
import { siteToWorld, worldToSite, type Landmark } from '../../../plan/landmarks';
import { stadiumBowl, superE } from '../../../plan/landmarkParts';
import { OUT } from '../../concert/plan';
import { FIRST } from '../../soccer/plan';
import { Rng, deriveSeed } from '../../../core/rng';

export const GIANT = {
  /** Height (m). */
  height: 10,
  /** Walking speed as a share of the Froude speed for their size (they walk carefully). */
  pace: 0.5,
  /** Turn rate (rad/s) while walking. */
  turn: 0.45,
  /** Someone this close (m) ahead of their feet: they stop and wait. */
  mind: 5.5,
  /** Sitting down and getting up (s: seat 0 → 1), lying down (1 → 2). */
  sitT: 4.5,
  lieT: 3.5,
  /** Ring offset past the stands' backs (m): clear of the floodlight masts (6 m out) and the car parks at the ends (10 m out). */
  ring: 8,
  /** Seconds between waves (at least), and how near (m) someone must be. */
  waveGap: 9,
  waveR: 28,
  /** Seconds between giving someone a lift for a photo (roughly, while people are about). */
  carryGap: [70, 150] as const,
  /** Seconds a lift lasts (held up), and the photographer's distance (m). */
  carryHold: 9,
  photoD: 9,
  /** The press: seconds between visits, how long they stay, how many. */
  pressGap: [50, 110] as const,
  pressStay: [60, 120] as const,
  /** The body is drawn within this of the camera (m); it goes again beyond DROP_R. */
  rigR: 1400,
  dropR: 1600,
  /** Farther than this from where the player looks (m), they skip to where their day takes them. */
  farR: 600,
} as const;

/** Game hours: waking (out before the first match), the concert's doors (they sit outside then). */
export const WAKE = 8.25, LEAVE_BY = FIRST - 0.75, CONCERT_SIT = 17.9;

export type DayPart = 'sleep' | 'wake' | 'roam' | 'concert' | 'bed';

/** What the day asks of them at this hour (0…24). */
export function dayOf(h: number): DayPart {
  if (h < WAKE) return 'sleep';
  if (h < LEAVE_BY) return 'wake';
  if (h < CONCERT_SIT) return 'roam';
  if (h < OUT) return 'concert';
  return 'bed';
}

export interface Spot { x: number; z: number; heading: number }

export interface GiantPlan {
  lm: Landmark;
  /** The pitch's floor height. */
  field: number;
  /** World point on the walk round at ring angle t (0: outside the gate, the +u end). */
  ring(t: number): [number, number];
  /** Ring angle nearest a world point. */
  angleOf(x: number, z: number): number;
  /** Inside the bowl along the gate's line (u; field level), and outside on the apron. */
  gateIn: [number, number];
  gateOut: [number, number];
  /** The bed on the pitch: where they lie, the way their feet point. */
  bed: Spot;
  /** Sitting outside the gate during the concert (facing out). */
  concert: Spot;
  /** Ring angles where they like to sit a while (the ends' aprons are widest). */
  sits: number[];
  /** Heading facing out from the stadium at ring angle t. */
  outward(t: number): number;
}

/** Heading (Scale: facing -Z at 0) from (x, z) towards (tx, tz). */
export const headingTo = (x: number, z: number, tx: number, tz: number): number => Math.atan2(-(tx - x), -(tz - z));

export function giantPlan(lm: Landmark): GiantPlan {
  const P = lm.p, bowl = stadiumBowl(lm);
  const out = P.tiers * P.depth;
  // (The ring's offset path is a superellipse a little larger than the stands' backs.)
  const a = P.ia + out + GIANT.ring, b = P.ib + out + GIANT.ring;
  const n = bowl.n;
  const ring = (t: number): [number, number] => {
    const [u, v] = superE(a, b, n, t);
    return siteToWorld(lm, u, v);
  };
  const angleOf = (x: number, z: number): number => {
    const [u, v] = worldToSite(lm, x, z);
    // Inverse of the superellipse's parameter: sign-preserving powers.
    const cu = Math.sign(u) * Math.pow(Math.abs(u) / a, n / 2), sv = Math.sign(v) * Math.pow(Math.abs(v) / b, n / 2);
    return Math.atan2(sv, cu);
  };
  const outward = (t: number): number => {
    const [x, z] = ring(t), [x2, z2] = siteToWorld(lm, ...superE(a + 10, b + 10, n, t));
    return headingTo(x, z, x2, z2);
  };
  const gateIn = siteToWorld(lm, P.ia - 6, 0), gateOut = siteToWorld(lm, P.ia + out + 4, 0);
  // The bed: on the pitch, feet towards the gate.
  const [bx, bz] = siteToWorld(lm, P.ia - 30, 0);
  const bed: Spot = { x: bx, z: bz, heading: headingTo(bx, bz, gateIn[0], gateIn[1]) };
  // The concert: by the corner near the gate (off the way out, clear of a car park at the end), facing out.
  const tc = 0.7;
  const [cx, cz] = ring(tc);
  const concert: Spot = { x: cx, z: cz, heading: outward(tc) };
  const r = new Rng(deriveSeed(lm.id, 'gentle', 'sits'));
  // (The long sides and the corners: the ends may be car parks, and they sit facing out.)
  const sits = [Math.PI / 2 + r.range(-0.4, 0.4), -Math.PI / 2 + r.range(-0.4, 0.4), Math.PI / 2 + r.range(-0.4, 0.4), -Math.PI / 2 + r.range(-0.4, 0.4), 0.75, -0.75, Math.PI - 0.75, Math.PI + 0.75];
  return { lm, field: bowl.field, ring, angleOf, gateIn, gateOut, bed, concert, sits, outward };
}

/** Wrapped difference b - a of two angles (−π…π). */
export function angDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Waypoints walking round the ring from angle t0 to t1, the shorter way (a point every `step`
 * radians, the last one at t1).
 */
export function ringWay(plan: GiantPlan, t0: number, t1: number, step = 0.12): [number, number][] {
  const d = angDiff(t0, t1), k = Math.max(1, Math.ceil(Math.abs(d) / step));
  const pts: [number, number][] = [];
  for (let i = 1; i <= k; i++) pts.push(plan.ring(t0 + (d * i) / k));
  return pts;
}

// ================================================================== what they say

export const GIANT_LINES = {
  greet: ['Oh, hello down there!', 'Hi! Mind your toes!', 'Hello! Lovely day, isn\'t it?', 'Hi there! Don\'t worry, I\'m watching my feet.', 'Oh! Hello, little one.'],
  hero: ['Oh, it\'s you! The hero! Hi!', 'Hello, hero! Don\'t fly into my nose, okay?', 'Hi! You\'re much braver than me.', 'Hello! People keep asking if we\'re related.'],
  heroGiant: ['Oh! Someone my size! Hello!', 'Finally, someone I can look in the eye!', 'Wow, hi! Do you also get headaches from street lamps?'],
  careful: ['Careful… careful…', 'Excuse me, coming through. Slowly.', 'Sorry! Just… stay there a moment.', 'Oops! Let me step around you.'],
  sit: ['Phew. I\'ll sit for a bit.', 'Sitting down! Everybody clear?', 'Less looming, more sitting.'],
  rise: ['Up we go… slowly.', 'Back on my feet!', 'Everybody clear? Standing up!'],
  lift: ['Want a lift? Hold on tight!', 'Up you go! Wave to your friend!', 'Say cheese!'],
  down: ['And back down you go.', 'There you are, safe and sound.', 'That\'s a good one for the album!'],
  press: ['Again? You took that one yesterday!', 'Do you really need another picture of my knees?', 'Please, not the left side, it\'s my bad side.', 'No comment! …Well, maybe a small one.'],
  concert: ['I love this song!', 'Best seat in the house. Outside.', 'I can see the stage over the stands, shh.'],
  sleepy: ['Big yawn… goodnight, city!', 'Time for bed. The grass is soft.'],
  morning: ['Morning, everyone! Out before the match.', 'Rise and shine… carefully.'],
  hurt: ['Ow! Please don\'t!', 'Hey! I\'m on nobody\'s side!', 'Ouch… what did I do?'],
} as const;

/** What people call out about them. */
export const CROWD_LINES = {
  see: ['It\'s {name}!', 'Look, it\'s {name}!', 'Hi, {name}!', '{name}! Over here!', 'Wave, {name}!'],
  lifted: ['I\'m so high up!', 'Take the picture!', 'Woohoo!', 'Don\'t drop me!'],
  photo: ['Smile!', 'Got it!', 'One more!', 'That\'s the one!'],
  thanks: ['Thank you, {name}!', 'Best day ever!', 'Wait till I post this!'],
  press: ['{name}, over here!', 'How\'s the weather up there?', 'Any news on a cure?', '{name}, one more!'],
} as const;

export const pickLine = (list: readonly string[], u: number, name = ''): string => list[Math.min(list.length - 1, Math.floor(u * list.length))].replace(/\{name\}/g, name);
