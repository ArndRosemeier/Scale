/**
 * City news as words (pure; tested in selftest.ts): what happened, where and how it ended, as a
 * billboard headline and as something a passer-by would say about it ("Did you hear? …").
 *
 * An item is small data (kept in saves): what (a crime kind, a trend, the hero), the neighbourhood,
 * how it ended, the game hour, and the group behind it.
 */
import type { CrimeKind } from '../crime/Crime';
import type { Safety } from './pulse';

export type NewsWhat = CrimeKind | 'rising' | 'falling' | 'turf';
export type NewsEnd = 'stopped' | 'escaped' | 'hero' | 'none';

export interface NewsItem {
  what: NewsWhat;
  /** Neighbourhood name (stored as the name: a save keeps reading right). */
  hood: string;
  end: NewsEnd;
  /** Absolute game hours. */
  t: number;
  /** The group behind it (its name), if any. */
  group?: string;
}

type Pair = readonly [string, string];
/** Headlines per kind: [came off, stopped by the police]; the hero's own: HERO. {hood} {group}. */
const HEAD: Partial<Record<NewsWhat, Pair>> = {
  snatch: ['Bag snatcher strikes in {hood}', 'Police catch bag snatcher in {hood}'],
  mugging: ['Mugging in {hood}', 'Mugger arrested in {hood}'],
  robbery: ['Shop robbed in {hood}', 'Robbery foiled in {hood}'],
  racket: ['{Group} shake down shops in {hood}', 'Protection racket busted in {hood}'],
  tagging: ['{Group} tag the walls of {hood}', 'Taggers caught in {hood}'],
  brawl: ['Street fight in {hood}', 'Police break up gang fight in {hood}'],
  hijack: ['Robots hijacked in {hood}', 'Robot hijack stopped in {hood}'],
  ritual: ['Strange ritual in {hood}', 'Police end ritual in {hood}'],
  bomber: ['Bomb scare in {hood}', 'Bomber arrested in {hood}'],
  heist: ['{Group} rob a bank in {hood}', 'Police foil bank heist in {hood}'],
  takeover: ['{Group} take over streets in {hood}', 'Police end gang takeover in {hood}'],
  uprising: ['{Group} turn the robots in {hood}', 'Machine uprising put down in {hood}'],
  awakening: ['{Group} hold a great ritual in {hood}', 'Police break up great ritual in {hood}'],
  sabotage: ['{Group} wreck machines in {hood}', 'Saboteurs caught in {hood}'],
  raising: ['Skeletons seen in {hood}', 'Police break up grave rite in {hood}'],
  procession: ['People vanish in a trance in {hood}', 'Police end eerie procession in {hood}'],
  treewake: ['A tree walks in {hood}', 'Police stop tree singers in {hood}'],
  deadrise: ['The dead walk in {hood}', 'Police stop grave raising in {hood}'],
};
const HERO: Partial<Record<NewsWhat, string>> = {
  snatch: 'Hero stops bag snatcher in {hood}', mugging: 'Hero saves mugging victim in {hood}', robbery: 'Hero foils robbery in {hood}',
  racket: 'Hero breaks up racket in {hood}', tagging: 'Hero stops taggers in {hood}', brawl: 'Hero ends street fight in {hood}',
  hijack: 'Hero stops robot hijack in {hood}', ritual: 'Hero breaks up ritual in {hood}', bomber: 'Hero stops mad bomber in {hood}',
  heist: 'Hero foils bank heist in {hood}', takeover: 'Hero beats back gang takeover in {hood}', uprising: 'Hero stops machine uprising in {hood}',
  awakening: 'Hero breaks up great ritual in {hood}',
  sabotage: 'Hero stops saboteurs in {hood}', raising: 'Hero lays the dead to rest in {hood}', procession: 'Hero wakes the entranced in {hood}',
  treewake: 'Hero stops tree singers in {hood}', deadrise: 'Hero ends grave raising in {hood}',
};

/** What it is called in a sentence ("a mugging"). */
const NOUN: Partial<Record<NewsWhat, string>> = {
  snatch: 'a bag snatching', mugging: 'a mugging', robbery: 'a robbery', racket: 'a shakedown', tagging: 'some tagging', brawl: 'a gang fight',
  hijack: 'a robot hijack', ritual: 'some weird ritual', bomber: 'a bomb scare',
  heist: 'a bank heist', takeover: 'a gang takeover', uprising: 'robots running riot', awakening: 'a huge ritual',
  sabotage: 'machines wrecked', raising: 'skeletons in the park', procession: 'people led away in a trance', treewake: 'a walking tree', deadrise: 'the dead walking',
};

export function fillNews(s: string, it: NewsItem): string {
  const group = it.group ?? 'A gang';
  return s.replace(/\{hood\}/g, it.hood).replace(/\{Group\}/g, group).replace(/\{group\}/g, it.group ?? 'a gang');
}

/** The billboard headline. */
export function headline(it: NewsItem): string {
  if (it.what === 'rising') return `Crime on the rise in ${it.hood}`;
  if (it.what === 'falling') return `${it.hood} getting safer`;
  if (it.what === 'turf') return `${it.group ?? 'A gang'} moves into ${it.hood}`;
  if (it.end === 'hero') return fillNews(HERO[it.what] ?? 'Hero steps in in {hood}', it);
  const p = HEAD[it.what];
  return p ? fillNews(it.end === 'stopped' ? p[1] : p[0], it) : `Trouble in ${it.hood}`;
}

/** The kind of story (the card's colour band): crime, police, hero, city. */
export function storyKind(it: NewsItem): 'crime' | 'police' | 'hero' | 'city' {
  if (it.what === 'rising' || it.what === 'falling' || it.what === 'turf') return 'city';
  return it.end === 'hero' ? 'hero' : it.end === 'stopped' ? 'police' : 'crime';
}

/** "just now", "an hour ago", "this morning", "last night", "yesterday", "a few days ago". */
export function whenWord(t: number, now: number): string {
  const ago = now - t;
  if (ago < 0.75) return 'just now';
  if (ago < 3) return 'earlier today';
  const day = Math.floor(t / 24), today = Math.floor(now / 24), h = t - day * 24;
  const part = h < 5 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
  if (day === today) return part === 'night' ? 'last night' : `this ${part}`;
  if (day === today - 1) return part === 'night' || part === 'evening' ? 'last night' : 'yesterday';
  return 'a few days ago';
}

/** A passer-by's line about a news item (rng: a number in [0, 1)). */
export function gossip(it: NewsItem, now: number, u: number): string {
  const when = whenWord(it.t, now);
  const pick = (l: readonly string[]) => fillNews(l[Math.floor(u * l.length) % l.length], it).replace('{when}', when);
  if (it.what === 'rising') return pick(['They say {hood} is getting rougher by the day.', 'I don\'t go to {hood} after dark any more.']);
  if (it.what === 'falling') return pick(['{hood} has really calmed down lately.', 'My sister says {hood} is safe again. Finally.']);
  if (it.what === 'turf') return pick(['{Group} are moving into {hood}, I heard.', 'Word is {group} took over part of {hood}.']);
  const noun = NOUN[it.what] ?? 'some trouble';
  if (it.end === 'hero') return pick([`Did you hear? A hero stopped ${noun} in {hood} {when}!`, `Someone said a hero broke up ${noun} in {hood}. Was that you?`]);
  if (it.end === 'stopped') return pick([`The police caught someone after ${noun} in {hood} {when}.`, `There was ${noun} in {hood} {when}, but the cops got them.`]);
  return pick([`Did you hear? There was ${noun} in {hood} {when}.`, `${cap(noun)} in {hood} {when}, and they got away.`, `My neighbour says there was ${noun} over in {hood} {when}.`]);
}

/** What a passer-by says about the streets they are in. */
export function localRemark(s: Safety, u: number): string {
  const L: Record<Safety, readonly string[]> = {
    safe: ['Nice and quiet round here.', 'Plenty of police about. Good.', 'Nothing ever happens here. I like it.'],
    quiet: ['Pretty safe around here, mostly.', 'You see a patrol car now and then. Helps.'],
    mixed: ['Keep an eye on your bag around here.', 'Could be worse, could be better, this area.'],
    rough: ['Never see a cop round here when you need one.', 'Don\'t walk here alone at night.', 'Hand on your wallet, round here.'],
    dangerous: ['This place is falling apart. Nobody helps.', 'The police don\'t even come here any more.', 'I\'m moving out the first chance I get.'],
  };
  const l = L[s];
  return l[Math.floor(u * l.length) % l.length];
}

function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
