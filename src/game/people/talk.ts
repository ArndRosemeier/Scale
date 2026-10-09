/**
 * Talking (NPC_PERSONALITY_PLAN §3.2): the facts a line can depend on, picking the most specific
 * matching line (lines.ts), filling in its tokens, and the backend interface a language model can
 * plug into later (§4). The rule backend is the default and the fallback: instant, free, the
 * same person says the same kind of thing, and it already knows the game world.
 *
 * Pure: no DOM, no three.js.
 */
import { Rng, hashString } from '../../core/rng';
import type { Job, MoodWord, Temperament, Traits } from './identity';
import type { Safety } from '../news/pulse';
import { LINES, type FavourState, type LineEntry, type Topic, type When } from './lines';

export interface TalkFacts {
  first: string;
  last: string;
  full: string;
  years: number;
  child: boolean;
  senior: boolean;
  traits: Traits;
  temper: Temperament;
  job: Job;
  interest: string;
  mood: number;
  moodWord: MoodWord;
  /** Times met before this conversation (0: a stranger). */
  met: number;
  /** What mattered most between them (saved > helped > hurt, the latest), or null. */
  deed: 'helped' | 'saved' | 'hurt' | null;
  /** Days since you last met (0 for a stranger). */
  days: number;
  /** −100..100 */
  opinion: number;
  hour: number;
  weather: string;
  /** 0..1 destruction or danger nearby lately. */
  trouble: number;
  /** A big threat in the city lately. */
  threat: boolean;
  street: string | null;
  /** Where you met them last time something happened (helped up, …). */
  metStreet: string | null;
  city: string;
  group: string | null;
  boss: string | null;
  giant: boolean;
  /** City news they heard lately, as a sentence (game/news), or null. */
  heard?: string | null;
  /** The neighbourhood here and how safe it is (game/news). */
  hood?: string | null;
  safety?: Safety;
  /** Word that got round (social.ts hearsay): who told them ({teller}, their {bond}) and what you did to them. */
  teller?: string | null;
  bond?: string;
  told?: 'helped' | 'saved' | 'hurt' | null;
  /** The need pressing on them now. */
  need?: 'hunger' | 'tired' | 'lonely' | null;
  /** The Wardens about now (game/aliens). */
  nannies?: 'swarm' | 'walker' | 'disc' | 'sky' | null;
  /** Where the favour they asked stands, the one to look in on ({who}, their {word}), and who sent you ({asker}). */
  favour?: FavourState;
  who?: string;
  word?: string;
  asker?: string | null;
  /** Way topic: the place asked for, its direction and distance. */
  place?: string;
  dir?: string;
  dist?: number;
  /** Flags a line can ask for (typed chat: what the answer is about, chat/answers.ts). */
  flags?: ReadonlySet<string>;
}

const WET = new Set(['drizzle', 'rain', 'storm']);

/** Does an entry's every criterion hold? */
export function matches(w: When, f: TalkFacts): boolean {
  if (w.temper && !w.temper.includes(f.temper)) return false;
  if (w.mood && (f.mood < w.mood[0] || f.mood > w.mood[1])) return false;
  if (w.op && (f.opinion < w.op[0] || f.opinion > w.op[1])) return false;
  if (w.met !== undefined && w.met !== f.met > 0) return false;
  if (w.deed && w.deed !== f.deed) return false;
  if (w.away !== undefined && (f.met === 0 || f.days < w.away)) return false;
  if (w.night !== undefined && w.night !== (f.hour >= 22 || f.hour < 5)) return false;
  if (w.morning !== undefined && w.morning !== (f.hour >= 5 && f.hour < 9)) return false;
  if (w.wet !== undefined && w.wet !== WET.has(f.weather)) return false;
  if (w.storm !== undefined && w.storm !== (f.weather === 'storm')) return false;
  if (w.trouble !== undefined && w.trouble !== f.trouble > 0.3) return false;
  if (w.threat !== undefined && w.threat !== f.threat) return false;
  if (w.child !== undefined && w.child !== f.child) return false;
  if (w.senior !== undefined && w.senior !== f.senior) return false;
  if (w.job && !w.job.includes(f.job.kind)) return false;
  if (w.title && !w.title.includes(f.job.title)) return false;
  if (w.interest && !w.interest.includes(f.interest)) return false;
  if (w.group !== undefined && w.group !== !!f.group) return false;
  if (w.boss !== undefined && w.boss !== !!f.boss) return false;
  if (w.street !== undefined && w.street !== !!f.street) return false;
  if (w.metStreet !== undefined && w.metStreet !== !!f.metStreet) return false;
  if (w.giant !== undefined && w.giant !== f.giant) return false;
  if (w.far !== undefined && w.far !== (f.dist ?? 0) > 2500) return false;
  if (w.heard !== undefined && w.heard !== !!f.heard) return false;
  if (w.safety && (!f.safety || !f.hood || !w.safety.includes(f.safety))) return false;
  if (w.told && (w.told !== f.told || !f.teller)) return false;
  if (w.need && w.need !== f.need) return false;
  if (w.favour && !w.favour.includes(f.favour ?? 'none')) return false;
  if (w.sent !== undefined && w.sent !== !!f.asker) return false;
  if (w.flag && !w.flag.every((x) => f.flags?.has(x))) return false;
  if (w.nannies && (!f.nannies || f.nannies === 'sky' || !w.nannies.includes(f.nannies))) return false;
  return true;
}

/** How specific an entry is: the number of criteria it names. */
export function specificity(w: When): number {
  let n = 0;
  // (A line for a special character — the mime, the officer — beats any temperament or memory line;
  // being sent by a friend, or having heard of the hero from one, beats a temperament's usual hello.)
  const weight: Record<string, number> = { title: 6, sent: 4, told: 2 };
  for (const k in w) if ((w as Record<string, unknown>)[k] !== undefined) n += k === 'flag' ? w.flag!.length : weight[k] ?? 1;
  return n;
}

export interface Picked { id: string; text: string }

/**
 * The line for a topic: the most specific matching entry, preferring entries this person has not
 * said yet (`used` holds "id#variant" keys), the variant picked with `seed` (the person's and
 * the moment's), tokens filled in.
 */
export function pickLine(topic: Topic, f: TalkFacts, seed: number, used: ReadonlySet<string> = new Set(), lines: readonly LineEntry[] = LINES[topic]): Picked {
  const r = new Rng(seed ^ hashString(topic));
  const ok = lines.filter((e) => matches(e.when, f));
  if (!ok.length) return { id: `${topic}:none`, text: '…' };
  const fresh = (e: LineEntry) => e.say.some((_, i) => !used.has(`${e.id}#${i}`));
  const pool0 = ok.some(fresh) ? ok.filter(fresh) : ok;
  // Most specific first; among equally specific entries, pick one at random.
  const top = Math.max(...pool0.map((e) => specificity(e.when)));
  const best = pool0.filter((e) => specificity(e.when) === top);
  const e = r.pick(best);
  const variants = e.say.map((_, i) => i).filter((i) => !used.has(`${e.id}#${i}`));
  const i = variants.length ? r.pick(variants) : r.int(0, e.say.length - 1);
  return { id: `${e.id}#${i}`, text: fill(e.say[i], f) };
}

const VOWEL = /^[aeiou]/i;

/** "a nurse", "an office worker" */
export function withArticle(s: string): string {
  return `${VOWEL.test(s) ? 'an' : 'a'} ${s}`;
}

/** "about 300 m", "about 1.2 km" */
export function distLabel(d: number): string {
  return d < 1000 ? `${Math.max(50, Math.round(d / 50) * 50)} m` : `${(d / 1000).toFixed(1)} km`;
}

/** Compass word for a direction from (dx, dz) in world space (−z is north, as on the map). */
export function dirWord(dx: number, dz: number): string {
  const a = Math.atan2(dx, -dz);
  const W = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return W[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
}

/** Fill a line's tokens; a capital first letter in the token capitalises the value. */
export function fill(s: string, f: TalkFacts): string {
  const v: Record<string, string> = {
    first: f.first, last: f.last, full: f.full, title: f.job.title, atitle: withArticle(f.job.title), interest: f.interest.replace(/^their /, 'my '),
    street: f.street ?? 'here', metstreet: f.metStreet ?? f.street ?? 'the street', group: f.group ?? 'some gang', boss: f.boss ?? 'their boss',
    city: f.city, place: f.place ?? 'there', dir: f.dir ?? 'that way', dist: distLabel(f.dist ?? 0), days: String(Math.max(1, Math.round(f.days))),
    years: String(f.years + 1), heard: f.heard ?? '', hood: f.hood ?? 'this part of town',
    teller: f.teller ?? 'a friend', bond: f.bond ?? 'friend', who: f.who ?? 'my friend', word: f.word ?? 'friend', asker: f.asker ?? 'a friend',
  };
  return s.replace(/\{(\w+)\}/g, (m, k: string) => {
    const val = v[k.toLowerCase()];
    if (val === undefined) return m;
    return k[0] === k[0].toUpperCase() ? val.charAt(0).toUpperCase() + val.slice(1) : val;
  });
}

// ------------------------------------------------------------------ backends

/** A topic asked from the menu, or (with a language model) the player's own words. */
export interface TalkRequest {
  topic: Topic;
  facts: TalkFacts;
  /** Seed for the rule pick (the person's and the moment's). */
  seed: number;
  used: ReadonlySet<string>;
  /** The player's own words (free text; language-model backends only). */
  text?: string;
  /** What this person remembers of the hero (short dated notes, newest last). */
  memory?: readonly string[];
}

/**
 * Where answers come from. The rule backend answers at once; a language-model backend (phase 3:
 * OpenRouter) may take a moment and may fail: the caller shows the rule line when it returns null.
 */
export interface TalkBackend {
  readonly id: string;
  answer(req: TalkRequest): Promise<Picked | null>;
}

export class RuleBackend implements TalkBackend {
  readonly id = 'rules';
  answer(req: TalkRequest): Promise<Picked | null> {
    return Promise.resolve(ruleAnswer(req));
  }
}

/** The rule answer (synchronous): the job topic adds a line about their hobby. */
export function ruleAnswer(req: TalkRequest): Picked {
  const p = pickLine(req.topic, req.facts, req.seed, req.used);
  // (Pupils, and special characters answering as what they are — the mime, the officer — say no more.)
  if (req.topic !== 'job' || req.facts.job.kind === 'pupil' || p.id.startsWith('js')) return p;
  const h = pickLine('hobby', req.facts, req.seed + 1, req.used);
  return { id: `${p.id} ${h.id}`, text: `${p.text} ${h.text}` };
}
