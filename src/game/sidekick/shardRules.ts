/**
 * The second shard (SIDEKICK_PLAN §2–3): where it turns up, whom it may go to, and what people say.
 * Pure: no three.js, no game. The game's `Sidekick` (sidekick/Sidekick.ts) and the self test share it.
 *
 *  - Where: a park or a square in a city cell some way from the hero (`shardCells` orders the
 *    candidates, `resolveShard` finds the spot in a cell's plan with the power cores' placement, so
 *    it never sits inside a fountain, a kiosk or a stairwell). The map shows a circle round it,
 *    not the spot: the news says where it was found, the pull does the rest.
 *  - Whom: `offerAnswer` decides what someone says to the offer, from who they are and how they
 *    feel about the hero. Most people say yes; children, people on duty, people who dislike the
 *    hero or are against heroes on principle say no; some have something to sort out first (a
 *    favour) and say yes once it is done.
 */
import { Rng, deriveSeed, hashToFloat } from '../../core/rng';
import { pointInPoly } from '../../core/geom2';
import type { MacroPlan } from '../../plan/types';
import type { CellPlan } from '../../plan/cell';
import type { Terrain } from '../../world/terrain';
import type { Citizen } from '../../sim/Population';
import type { Temperament, Traits } from '../people/identity';
import { resolveCoreSite, type CoreSite } from '../abilities/cores';

export const SHARD = {
  /** The shard turns up the first time reputation reaches this. */
  unlockRep: 30,
  /** Sandbox: seconds after the start before it is reported. */
  sandboxDelay: 20,
  /** Distance band (m from the hero) for the cell it turns up in. */
  near: 400, far: 1300,
  /** The map's circle: its radius, and how far its centre may be off the spot (m). */
  zoneR: 180, zoneOff: 100,
  /** Within this range the hero feels the pull (hum, edge glow, the compass). */
  pullR: 300,
  /** The shard is drawn within this range (m). */
  showR: 900,
  /** Reach to take it (m, from the body). */
  takeR: 1.4,
  /** Chance a gang holding the turf got to it first. */
  gangChance: 0.3,
  /** Their guards are posted within guardR (beyond guardMin, or out of sight), stood down beyond leaveR. */
  guardR: 110, guardMin: 55, leaveR: 260,
  /** Share of people with something to sort out first, and of people against heroes on principle (more of the disagreeable). */
  matterShare: 0.2, scepticBase: 0.04, scepticDisagree: 0.14,
  /** Opinion below which people turn the offer down. */
  dislikeBelow: -10,
} as const;

export type ShardKind = 'park' | 'plaza';

export interface ShardSite {
  cell: number;
  kind: ShardKind;
  /** The spot (y: ground, refined in the game once the collision ground is there). */
  x: number; y: number; z: number;
  /** The map's circle. */
  zx: number; zz: number; zr: number;
  seed: number;
}

/** Districts in order of preference for a found stone (parks first, never water). */
const PREFER: Record<string, number> = { park: 3, suburban: 2, apartments: 2, oldtown: 2, rowhouses: 1.5, commercial: 1.2, downtown: 1, port: 0.6, industrial: 0.5 };

/**
 * Candidate cells for the n-th shard (0: the first; later ones after a sidekick's death), the
 * hero at (px, pz): within the distance band, preferred districts first, in a seeded order. With
 * nothing in the band (a small city) the cells nearest to its middle come first.
 */
export function shardCells(macro: MacroPlan, seed: number, n: number, px: number, pz: number): number[] {
  const rng = new Rng(deriveSeed(seed, 'shard', n));
  const land = macro.cells.filter((c) => c.district !== 'water' && PREFER[c.district] !== undefined);
  const d = (c: (typeof land)[number]) => Math.hypot(c.centroid[0] - px, c.centroid[1] - pz);
  const mid = (SHARD.near + SHARD.far) / 2;
  const scored = land.map((c) => {
    const dc = d(c);
    const inBand = dc >= SHARD.near && dc <= SHARD.far;
    return { id: c.id, s: (inBand ? 1000 : 0) - (inBand ? 0 : Math.abs(dc - mid)) + PREFER[c.district] * 60 + rng.float() * 120, close: dc < 120 };
  }).filter((x) => !x.close);
  scored.sort((a, b) => b.s - a.s);
  return scored.map((x) => x.id);
}

/** The spot in a cell (its plan built): a park lawn or a square, kept clear of anything solid; null: none here. */
export function resolveShard(macro: MacroPlan, cell: number, plan: CellPlan, terrain: Terrain, seed: number, n: number): ShardSite | null {
  const c = macro.cells[cell];
  if (!c) return null;
  const s = deriveSeed(seed, 'shardSpot', n, cell);
  const kind: ShardKind = c.district === 'park' || c.district === 'suburban' || hashToFloat(s) < 0.5 ? 'park' : 'plaza';
  const site: CoreSite = { id: -1, kind, loot: 'energy', cell, x: c.centroid[0], y: NaN, z: c.centroid[1], seed: s, height: 0 };
  const spot = resolveCoreSite(site, plan, terrain);
  if (!spot || spot.surface !== 'ground' || !pointInPoly(c.poly, spot.x, spot.z)) return null;
  // Which it really is (resolveCoreSite falls back from parks to squares and back).
  const inPark = plan.parks.some((p) => pointInPoly(p.outer, spot.x, spot.z));
  // The circle: its centre a seeded way off the spot, so the spot is inside but not in the middle.
  const r = new Rng(s ^ 0x5eed);
  const a = r.float() * Math.PI * 2, off = SHARD.zoneOff * (0.35 + 0.65 * r.float());
  return { cell, kind: inPark ? 'park' : 'plaza', x: spot.x, y: spot.y, z: spot.z, zx: spot.x + Math.cos(a) * off, zz: spot.z + Math.sin(a) * off, zr: SHARD.zoneR, seed: s };
}

// ------------------------------------------------------------------ the offer

/** Against heroes on principle (a few people, more of the disagreeable ones): the same every time. */
export function sceptic(cit: Citizen, t: Traits): boolean {
  return hashToFloat(deriveSeed(cit.seed, 'sceptic')) < SHARD.scepticBase + SHARD.scepticDisagree * (1 - t.a);
}

/** Has something to sort out first (a relative to look in on): the same every time. */
export function hasMatter(cit: Citizen): boolean {
  return hashToFloat(deriveSeed(cit.seed, 'matter')) < SHARD.matterShare;
}

export interface OfferFacts {
  child: boolean;
  /** Working right now as something another system drives (an officer, a busker …). */
  duty: boolean;
  rep: number;
  opinion: number;
  sceptic: boolean;
  matter: boolean;
  /** Where the matter stands: not asked yet, the favour open, done, or let down. */
  matterState: 'none' | 'open' | 'done' | 'lost';
}

export type OfferAnswer = 'yes' | 'child' | 'duty' | 'rep' | 'dislike' | 'principle' | 'matter' | 'waiting' | 'letdown' | 'grateful';

/** What someone says to the shard (in order: who they are, the hero's name, their opinion, their principles, their own life). */
export function offerAnswer(f: OfferFacts): OfferAnswer {
  if (f.child) return 'child';
  if (f.duty) return 'duty';
  if (f.rep < 0) return 'rep';
  if (f.opinion < SHARD.dislikeBelow) return 'dislike';
  if (f.sceptic) return 'principle';
  if (f.matter) {
    if (f.matterState === 'none') return 'matter';
    if (f.matterState === 'open') return 'waiting';
    if (f.matterState === 'lost') return 'letdown';
    return 'grateful';
  }
  return 'yes';
}

/** Whether an answer is a yes. */
export function accepts(a: OfferAnswer): boolean { return a === 'yes' || a === 'grateful'; }

// ------------------------------------------------------------------ words

type Pool = readonly string[];
const ANSWER: Record<OfferAnswer, Pool> = {
  yes: ['Me? You want to give that… to me? All right. Yes.', 'That\'s the thing from the news, isn\'t it? …Yes. I\'ll take it.', 'I don\'t know why you\'d pick me. But yes.'],
  grateful: ['You looked in on {who} for me. Of course I\'ll take it. Yes.', 'You did what I asked. Now I\'ll do this for you. Yes.'],
  child: ['Whoa, cool! …My mum would never let me, though.', 'Really? For me? …I\'m not allowed. I\'m only a kid.'],
  duty: ['Not while I\'m working. Sorry.', 'I can\'t, I\'m on duty.'],
  rep: ['From you? Not with what people say about you.', 'No. Not from you. Not now.'],
  dislike: ['From you? No thanks.', 'Keep it. I don\'t want anything of yours.'],
  principle: ['People like you shouldn\'t exist, if you ask me. And I won\'t become one.', 'No. The city needs fewer masked heroes, not more.', 'Powers? No. Leave it to the police.'],
  matter: ['I would… but I can\'t think of anything but {who} right now. My {word} hasn\'t been well. Could you look in on them first?', 'Not before I know {who} is all right. My {word}. Look in on them for me, and ask me again.'],
  waiting: ['Did you look in on {who} yet? Ask me again after.', 'First {who}. Please.'],
  letdown: ['You never looked in on {who}. Why should I trust you with this?', 'You didn\'t do what I asked. No.'],
};

/** What they answer (u: a number in [0, 1)); {who}, {word}: the one they want you to look in on. */
export function answerLine(a: OfferAnswer, u: number, who = 'my friend', word = 'friend'): string {
  const l = ANSWER[a];
  return l[Math.floor(u * l.length) % l.length].replace(/\{who\}/g, who).replace(/\{word\}/g, word);
}

/** The three things they say as the shard's light pours into them: at once, as it fills them, and when it has. */
export function awakeningLines(t: Temperament, u: number): [string, string, string] {
  const first: Partial<Record<Temperament, Pool>> = {
    anxious: ['Oh no. Oh no, it\'s warm. Is it supposed to be warm?'],
    shy: ['It\'s… it\'s glowing. In my hands.'],
    grumpy: ['Great. It\'s humming at me.'],
    chatty: ['It\'s warm! It\'s actually warm! Can you feel that? Of course you can.'],
    dreamy: ['It sings. Can you hear it sing?'],
    proud: ['It chose well, then.'],
  };
  const second: Partial<Record<Temperament, Pool>> = {
    anxious: ['I can hear everything. Everyone. Make it stop… no, wait. It\'s all right. It\'s all right.'],
    grumpy: ['Every street. Every idiot in every street. I can feel them all.'],
    kind: ['Someone is crying three streets away. I can feel it. I have to help her.'],
    cheerful: ['I feel… amazing. Like I could jump over a house!'],
    steady: ['So this is how it feels. Every street, all at once.'],
    nosy: ['I can feel what\'s going on in every street. Oh, this is going to be interesting.'],
    dreamy: ['The whole city is breathing. I never knew.'],
  };
  const third: Partial<Record<Temperament, Pool>> = {
    proud: ['Don\'t expect me to follow you around. I\'ll be there when it matters.'],
    grumpy: ['Fine. I\'m in. But I don\'t take orders.'],
    kind: ['I\'ll help. Whoever needs it. You too.'],
    shy: ['I\'ll… I\'ll try. I\'ll be around.'],
    chatty: ['We\'re a team now! Well, sort of. I\'ll do things my way. But a team!'],
    steady: ['All right. I\'ll look out for this city. And for you.'],
  };
  const any1: Pool = ['What… what is this?', 'It\'s so light. It\'s… going into me.'];
  const any2: Pool = ['I can feel it. Every street. Everyone who needs help.', 'Something just woke up in me.'];
  const any3: Pool = ['I\'ll be around. Not at your heels, but around.', 'I\'m in. My way, though.'];
  const p = (l: Pool | undefined, d: Pool, k: number) => { const pool = l ?? d; return pool[Math.floor(((u * 7.31 + k * 0.37) % 1) * pool.length) % pool.length]; };
  return [p(first[t], any1, 1), p(second[t], any2, 2), p(third[t], any3, 3)];
}

/** The news: the billboard headline and what passers-by say (u in [0, 1)). */
export function shardHeadline(hood: string, kind: ShardKind): string {
  return kind === 'park' ? `Strange glowing stone found in a park in ${hood}` : `Glowing stone found on a square in ${hood}`;
}
