/**
 * What the game master's signs say (GAME_MASTER_PLAN §2.2, phase 3): the tracker's lines for a site
 * being cased, what a caught lookout gives away, a group's calling card, a witness, a job done while
 * the hero was elsewhere. Pure (selftest "game master").
 */
import type { BossOpKind } from '../crime/Crime';

/** Seen: members casing the site ("{group}" "{where}" filled in). */
export const CASING_SEEN: Record<BossOpKind, string> = {
  heist: '{group} watching a bank {where}, a little too closely',
  takeover: '{group} pacing out a block {where}, sizing it up',
  uprising: '{group} hackers poking at the delivery robots {where}',
  awakening: 'Robed {group} marking the ground {where}',
  treewake: '{group} walking round an old tree {where}, humming',
  deadrise: '{group} counting the graves {where}',
};

/** What the job is, as a caught lookout puts it ("{when}" filled in). */
export const CASING_JOB: Record<BossOpKind, string> = {
  heist: 'The boss takes the bank {where} {when}',
  takeover: 'We take the whole street {where} {when}',
  uprising: 'The Architect takes the robots {where} {when}',
  awakening: 'The great circle meets {where} {when}',
  treewake: 'The Elder wakes the tree {where} {when}',
  deadrise: 'The Grave Lord raises the dead {where} {when}',
};

const CAUGHT = ['{job}. That\'s all I know, I swear!', 'All right, all right! {job}.', '{job}. You won\'t stop them anyway.'];

/** Done while the hero was elsewhere (a news line in the group's thread). */
export const OFFSCREEN: Record<BossOpKind, string> = {
  heist: 'News: {group} robbed the bank {where}',
  takeover: 'News: {group} took a street {where} by force',
  uprising: 'News: {group} turned the robots {where} against people',
  awakening: 'News: {group} held a great ritual {where}',
  treewake: 'News: {group} woke a tree {where}',
  deadrise: 'News: {group} raised the dead {where}',
};

const TAUNT = {
  op: ['You spoiled the boss\'s big day. {group} don\'t forget.', 'That job was months of work. {group} will see you again.', 'Enjoy it while it lasts. {group} are coming for you.'],
  stash: ['That was our stash. {group} will be seeing you.', 'You kicked in the wrong door. {group} know your face now.', 'Nice work on the stash. Watch your back, hero. Love, {group}.'],
};

const WITNESS = [
  'I saw them go. That lot always go in at a door {where}.',
  'They ran off that way. I\'ve seen their sort go in at a door {where}.',
  'Are you after them? They come and go through a door {where}. I didn\'t tell you.',
];

const pick = (l: readonly string[], u: number) => l[Math.min(l.length - 1, Math.floor(u * l.length))];
const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m).replace(/\s+([.,!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();

/** When a planned job is, as people say it ("within the hour", "around 22:00", "tomorrow around 9:00"). */
export function whenSaid(at: number, now: number): string {
  if (at - now < 1) return 'within the hour';
  const h = Math.round(at) % 24, day = Math.floor(Math.round(at) / 24) - Math.floor(now / 24);
  return `${day >= 1 ? 'tomorrow ' : h >= 18 ? 'tonight ' : ''}around ${h}:00`;
}

export function casingSeen(kind: BossOpKind, group: string, where: string): string {
  const t = fill(CASING_SEEN[kind], { group, where });
  return t[0].toUpperCase() + t.slice(1);
}

export function caughtLine(kind: BossOpKind, where: string, when: string, u: number): string {
  return fill(pick(CAUGHT, u), { job: fill(CASING_JOB[kind], { where, when }) });
}

export function offscreenNews(kind: BossOpKind, group: string, where: string): string {
  return fill(OFFSCREEN[kind], { group, where });
}

export function tauntLine(why: 'op' | 'stash', group: string, u: number): string {
  return fill(pick(TAUNT[why], u), { group });
}

export function witnessLine(where: string, u: number): string {
  return fill(pick(WITNESS, u), { where });
}

/** Passing the taped-off site of a job that went through. */
export const SCENE_SEEN: Record<BossOpKind, string> = {
  heist: 'Police tape round the bank {where}: {group} cracked the vault',
  takeover: 'Police tape {where}, cars burnt out: {group} took the street',
  uprising: 'Police tape {where}: {group} turned the robots here',
  awakening: 'Police tape {where}: {group} held their great ritual here',
  treewake: 'Police tape {where}: {group} woke a tree here',
  deadrise: 'Police tape {where}: {group} raised the dead here',
};

const BACK = ['News: {group} are back. New faces on their old corners.', 'News: {group} are back in business, people say.', 'News: {group} are on the streets again.'];

export function sceneSeen(kind: BossOpKind, group: string, where: string): string {
  return fill(SCENE_SEEN[kind], { group, where });
}

export function backLine(group: string, u: number): string {
  return fill(pick(BACK, u), { group });
}
