/**
 * What people say about a rising villain and what the hero finds (SUPERVILLAINS_PLAN §3, phase 1).
 * Whispers are said as "I heard {heard}", so they start in lower case. Pure (selftest "supervillains").
 */
import type { Villain } from './villain';
import { aliasCap, tagWord } from './villain';

const pick = (l: readonly string[], u: number) => l[Math.min(l.length - 1, Math.floor(Math.max(0, u) * l.length))];
const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m).replace(/\s+([.,!?:])/g, '$1').replace(/\s{2,}/g, ' ').trim();

const RUMOUR = [
  'someone calling themselves {alias} is going round {where}',
  'there\'s a new name {where}: {alias}. Nobody knows who they are',
  'people {where} are scared of somebody called {alias}',
  'a crook told my cousin to watch out for {alias}. Whoever that is',
];

const SIGNS = [
  '{alias}\'s mark is turning up on walls {where}',
  'you see that mark on the walls {where}? That\'s {alias}',
  'nobody paints over the marks {where}. They say {alias} is watching',
];

const ORIGIN: Record<Villain['origin'], string[]> = {
  boss: ['{real} came back different. Calls themselves {alias} now', 'the old boss {real} isn\'t the old boss any more. {Alias}, they say now'],
  failed: ['{alias} says the hero ruined their life', '{alias} blames the hero for everything that happened to them'],
  accident: ['something happened at the {from}, and since then there\'s this {alias}', 'whatever happened at the {from} made {alias}'],
  outsider: ['{alias} came into town with a crew of their own', '{alias} isn\'t from here. Came in with a crew and big plans'],
};

/** The tracker thread's title until they show their face (phase 2). */
export function threadTitle(v: Pick<Villain, 'alias'>): string {
  return `Someone calling themselves ${v.alias}`;
}

/** A whisper about them, for someone asked for the news (`where`: "in Mill Quarter"). */
export function whisper(v: Villain, where: string, u: number, deep: boolean): string {
  const vars = { alias: v.alias, Alias: aliasCap(v), where, real: v.realName, from: v.from };
  if (deep && (v.origin !== 'boss' || v.realName) && (v.origin !== 'accident' || v.from)) return fill(pick(ORIGIN[v.origin], u), vars);
  return fill(pick(v.stage === 'signs' ? SIGNS : RUMOUR, u), vars);
}

/** The hero walks past their mark. */
export function markSeen(v: Pick<Villain, 'glyph' | 'alias'>, where: string): string {
  return fill(`A mark on a wall {where}: ${v.glyph} ${tagWord(v.alias)}, freshly sprayed`, { where });
}

/** The heard line in the thread. */
export function heardClue(text: string): string {
  return `Someone said: “${text[0].toUpperCase()}${text.slice(1)}”`;
}
