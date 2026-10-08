/**
 * How the sidekick grows and how far they trust the hero (docs/SIDEKICK_PLAN.md §5–6, phases 3
 * and 4). Pure (no game state): Companion.ts and Sidekick.ts act on it, tools/sidekickTest.ts
 * checks it.
 *
 *  - Karma: they earn their own (knock-outs, fights won, helping people up) and the hero can give
 *    them some, with a wish. They spend it themselves on the roster below, by their traits: the
 *    curious and outgoing on the flashy elements, the disagreeable on hard hitters, the dutiful on
 *    shield and stun, the nervous on wind, the charge and toughness. A wish is honoured or not by
 *    trust and by how well it fits them.
 *  - Trust (0…100): grows with time together, gifts, fights won side by side and the hero helping
 *    the people close to them; drops when the hero hurts bystanders near them, leaves them alone in
 *    a losing fight, or asks for things against their character.
 *  - Asks (help me, stay back, go home for now, come with me): yes or no by trust and character,
 *    always with a reason.
 */
import type { Temperament, Traits } from '../people/identity';
import { deriveSeed, hashToFloat } from '../../core/rng';
import type { MatePower } from './companionRules';

export type Gift = MatePower | 'shield' | 'strength' | 'toughness';

export const ROSTER: Record<Gift, { name: string; what: string; cost: readonly number[] }> = {
  fireball: { name: 'Fireballs', what: 'a ball of fire that bursts where it lands', cost: [60] },
  bolt: { name: 'Lightning', what: 'a bolt along a line that knocks people down', cost: [60] },
  quake: { name: 'Ground quake', what: 'a crack along the ground that floors whoever stands on it', cost: [50] },
  stun: { name: 'Stunning flash', what: 'a lobbed flash that knocks a crowd down for a moment', cost: [50] },
  gust: { name: 'Blast of wind', what: 'a cone of wind that shoves people off their feet', cost: [45] },
  dash: { name: 'Shoulder charge', what: 'a rush straight through the one in front', cost: [45] },
  shield: { name: 'Shield', what: 'a bubble that turns most blows for a few seconds', cost: [55] },
  strength: { name: 'Strength', what: 'harder punches', cost: [20, 45, 100] },
  toughness: { name: 'Toughness', what: 'more health', cost: [25, 50, 100] },
};
export const GIFTS = Object.keys(ROSTER) as Gift[];

export type Ranks = Partial<Record<Gift, number>>;

/** Karma they earn for their own deeds (at about the hero's rates). */
export const MATE_KARMA = {
  /** Knocking someone out (a boss or lieutenant counts double). */
  ko: 8, lead: 16,
  /** A fight won with the hero. */
  won: 10,
  /** Helping someone up who fell (and was left lying a while). */
  helpUp: 10,
};

export const TRUST = {
  start: 40, max: 100,
  /** Per second together (within 60 m, not in the ward). */
  together: 1 / 90,
  /** Per karma given, at most `giftMax` a gift. */
  giftPer: 0.25, giftMax: 12,
  won: 3,
  /** The hero helped or saved someone close to them. */
  friend: 6,
  /** The hero knocked down a bystander near them; someone close to them. */
  hurt: -3, hurtFriend: -8,
  /** Knocked out while the hero was far away (left alone in a losing fight). */
  left: -12,
  /** Asked for something against their character (and they did it anyway). */
  against: -4,
  /** The bond broke. */
  parted: -15,
};

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** The next rank's price (null: they have all of it). */
export function nextCost(g: Gift, ranks: Ranks): number | null {
  const r = ranks[g] ?? 0, c = ROSTER[g].cost;
  return r < c.length ? c[r] : null;
}

/** How much this suits them (about 0…1). */
export function leaning(g: Gift, t: Traits): number {
  switch (g) {
    case 'fireball': return 0.5 * t.o + 0.5 * t.e;
    case 'bolt': return 0.45 * t.o + 0.55 * t.e;
    case 'quake': return 1 - t.a;
    case 'dash': return 0.6 * (1 - t.a) + 0.4 * t.n;
    case 'strength': return 0.7 * (1 - t.a) + 0.3 * (1 - t.n);
    case 'gust': return t.n;
    case 'shield': return 0.6 * t.c + 0.4 * t.n;
    case 'stun': return t.c;
    case 'toughness': return 0.5 * t.c + 0.5 * t.n;
  }
}

/**
 * What they save for next: the roster item that suits them best, with a little luck (the same for
 * the same person and the same number of purchases); further ranks of a passive suit them less and less.
 */
export function nextWant(t: Traits, ranks: Ranks, seed: number, who: number, bought: number): Gift | null {
  let best: Gift | null = null, bs = -Infinity;
  for (const g of GIFTS) {
    if (nextCost(g, ranks) === null) continue;
    const u = hashToFloat(deriveSeed(seed, `want:${who}:${bought}:${g}`));
    const s = leaning(g, t) * Math.pow(0.75, ranks[g] ?? 0) * (0.7 + 0.6 * u);
    if (s > bs) { bs = s; best = g; }
  }
  return best;
}

/** Do they take the hero's wish to heart? By trust, by how well it suits them, by how agreeable they are. */
export function honoursWish(g: Gift, trust: number, t: Traits, u: number): boolean {
  const p = 0.12 + (trust / 100) * 0.6 + (leaning(g, t) - 0.5) * 0.6 + (t.a - 0.5) * 0.3;
  return u < clamp(p, 0.05, 0.95);
}

type Pool = string[];
const pick = (l: Pool, u: number) => l[Math.floor(u * l.length) % l.length];
const own = <T extends string>(L: { any: Pool } & Partial<Record<T, Pool>>, k: T, u: number) => {
  const o = L[k];
  return pick(o && (u * 7.3) % 1 < 0.7 ? o : L.any, u);
};

/** What they say when they have learned something (a bubble). */
export function buyLine(g: Gift, temper: Temperament, u: number): string {
  const L: Record<Gift, Pool> = {
    fireball: ['Fire. I can make fire now. Stand back.', 'I always wondered what it would feel like. Warm.'],
    bolt: ['Lightning! In my hands! Did you see that?', 'It crackles when I think about it. Useful.'],
    quake: ['The ground listens to me now. Nobody else does.', 'One stamp and they all go down. I like it.'],
    stun: ['A flash and they\'re down. Nobody gets hurt. Much.', 'Something that stops a fight without breaking anyone.'],
    gust: ['Wind. Keep them at arm\'s length, that\'s what I want.', 'Whoosh. Ha. They won\'t get near me now.'],
    dash: ['Anyone in my way now goes flying.', 'I just run through them. Simple.'],
    shield: ['A shield. Let them try.', 'Now I can get between them and the people.'],
    strength: ['Feel that grip? Neither do I. Too strong.', 'My punches mean something now.'],
    toughness: ['I can take a hit now. A real one.', 'Harder to knock down. Good.'],
  };
  const t: Partial<Record<Temperament, string>> = { grumpy: 'About time.', proud: 'Naturally.', cheerful: 'Look at this!', anxious: 'I think I did it right…' };
  const tag = t[temper];
  const line = pick(L[g], u);
  return tag && (u * 5.1) % 1 < 0.4 ? `${tag} ${line}` : line;
}

/** Thanks for karma (a talk line); `share` = the gift against what they had. */
export function giftLine(temper: Temperament, share: number, u: number): string {
  const big = share > 0.8;
  const L = {
    any: big ? ['That\'s a lot. Thank you. I mean it.', 'You\'re sure? …Thank you.'] : ['Thanks. Every bit helps.', 'That\'s kind of you.'],
    grumpy: ['Hm. Thanks, I suppose.'],
    cheerful: big ? ['Wow! Thank you!'] : ['Ooh, thank you!'],
    proud: ['I\'ll put it to good use. Better than you would.'],
    kind: ['You didn\'t have to. Thank you.'],
    shy: ['For me? Oh. Thank you…'],
  } as { any: Pool } & Partial<Record<Temperament, Pool>>;
  return own(L, temper, u);
}

/** Their answer to a wish. */
export function wishLine(yes: boolean, g: Gift, temper: Temperament, u: number): string {
  const n = ROSTER[g].name.toLowerCase();
  if (yes) {
    const L = { any: [`All right. I'll save for ${n}.`, `${ROSTER[g].name}? Fine, if you think so.`], grumpy: [`${ROSTER[g].name}. Fine. Happy now?`], cheerful: [`${ROSTER[g].name}! Why not!`], kind: ['If that helps you most, then yes.'] } as { any: Pool } & Partial<Record<Temperament, Pool>>;
    return own(L, temper, u);
  }
  const L = {
    any: [`${ROSTER[g].name}? That's not me. I'll spend it my way.`, 'Thanks. But I know what I need.'],
    grumpy: ['I\'ll spend it how I like.'],
    proud: ['I know better than you what I need.'],
    shy: [`Um. ${ROSTER[g].name}… isn't really me. Sorry.`],
  } as { any: Pool } & Partial<Record<Temperament, Pool>>;
  return own(L, temper, u);
}

/** Trust in a few words (their talk line, the status). */
export function trustWord(trust: number): string {
  return trust < 20 ? 'wary of you' : trust < 40 ? 'not sure about you yet' : trust < 60 ? 'warming to you' : trust < 80 ? 'trusts you' : 'would follow you anywhere';
}

// ------------------------------------------------------------------ asks

export type Ask = 'help' | 'back' | 'home' | 'come';
export interface AskCtx {
  /** A fight is on near the hero. */
  fight: boolean;
}
export interface AskAnswer {
  ok: boolean;
  line: string;
  /** They do it, but it goes against them (a little trust lost). */
  against: boolean;
}

/** Hard-headed or proud: hiding from a fight goes against them. */
const fighter = (t: Traits, temper: Temperament) => temper === 'proud' || t.a < 0.35;

export function askAnswer(ask: Ask, trust: number, t: Traits, temper: Temperament, ctx: AskCtx, u: number): AskAnswer {
  const L = (yes: Pool, no: Pool, ok: boolean, against = false): AskAnswer => ({ ok, line: pick(ok ? yes : no, u), against });
  switch (ask) {
    case 'help': {
      const ok = trust >= 15 || u < trust / 15;
      return L(
        temper === 'grumpy' ? ['Yes, yes. I\'m here.'] : temper === 'cheerful' ? ['Always!'] : ['Of course. Where?', 'I\'ve got your back.'],
        ['Help you? After everything? Not today.', 'Ask me again when I trust you.'],
        ok);
    }
    case 'back': {
      if (ctx.fight && fighter(t, temper)) {
        const ok = trust >= 70;
        return L(['…Fine. I don\'t like it. But fine.'], [temper === 'proud' ? 'Me? Hide? No.' : 'In the middle of this? No chance.', 'Stay back yourself.'], ok, ok);
      }
      return L(temper === 'anxious' || temper === 'shy' ? ['Oh, good. I mean, all right.'] : ['All right, I\'ll keep my distance.', 'I\'ll hang back. Shout if you need me.'], [], true, fighter(t, temper));
    }
    case 'home': {
      if (ctx.fight && temper !== 'anxious' && temper !== 'shy') {
        const ok = trust >= 80;
        return L(['Now? …All right, if you\'re sure.'], ['Now? While this is going on? No.', 'I\'m not leaving you in this.'], ok, ok);
      }
      return L(temper === 'grumpy' ? ['Finally, some peace.'] : temper === 'chatty' ? ['Home! I\'ll tell you all about it later. Call me (K).'] : ['I\'ll be home. Call me if you need me (K).', 'All right. You know where to find me.'], [], true);
    }
    case 'come': {
      const ok = trust >= 10 || u < 0.5;
      return L(temper === 'cheerful' ? ['Let\'s go!'] : ['Right behind you.', 'Coming.'], ['I\'ll stay here for now.'], ok);
    }
  }
}

/** K pressed: do they come? Nearly always; the wary ones sometimes don't. */
export function answersCall(trust: number, u: number): boolean {
  return trust >= 25 || u < 0.3 + trust / 40;
}
