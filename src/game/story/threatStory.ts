/**
 * Threats in the hero's tracker (GAME_MASTER_PLAN §3, the Threats tab): the strange signs the
 * hero sees before an event (the threat clock's omens: quiet, no toast, so they stay subtle), the
 * event itself when it comes, and how it ended. Boss operations belong to their group's thread
 * (villains), and a rampaging hero is not a story of their own.
 */
import type { Game } from '../Game';
import type { ThreatEvent, ThreatOutcome } from '../threats/ThreatEvent';
import type { ThreadInfo } from './knowledge';

/** What the hero sees of an omen (archetype:kind, else kind): never the monster's name. */
const OMEN: Record<string, string> = {
  glitch: 'Delivery robots glitching in the street',
  drone: 'A drone flying in strange loops',
  billboard: 'A billboard showing garbled code',
  chitter: 'A chittering from a drain',
  glimpse: 'Something small darting between the manholes',
  zip: 'Something zipped past low over the roofs',
  glyph: 'A strange glyph glowing on a facade',
  tremor: 'The ground trembled',
  'strider:wake': 'A long wake moving up the river',
  'leviathan:wake': 'A wake on the river, against the current',
  rumble: 'A deep rumble under the street',
  pothole: 'A pothole opened up out of nowhere',
  surge: 'The river heaved up at a bridge',
  cry: 'A huge cry from high above the town',
  flyover: 'Something enormous crossed the sky',
  bulletin: 'On the news: a walking weapons prototype has gone missing',
  stomps: 'Heavy metal footfalls, far off',
};

/** The event's name in the tracker and its glyph. */
const TITLE: Record<string, [string, string]> = {
  robots: ['Rogue robots', '⚙'],
  strider: ['A giant creature', '!'],
  burrower: ['A giant worm', '!'],
  leviathan: ['A river monster', '!'],
  roc: ['A giant bird of prey', '!'],
  mech: ['A rogue war machine', '⚙'],
  brood: ['A swarm from the sewers', '!'],
  murk: ['Creatures from below', '!'],
  tree: ['An awakened tree', '♣'],
  teens: ['A stolen saucer', '◎'],
};

const ENDING: Record<ThreatOutcome, string> = {
  stopped: 'Stopped', defeated: 'Brought down', destroyed: 'Destroyed', shutdown: 'Powered down',
  abandoned: 'It moved on', retreated: 'It retreated',
};

const omenThread = (n: number): ThreadInfo => ({ id: `omens:${n}`, tab: 'threats', title: 'Strange signs', glyph: '?', color: '#b9a4ff' });

const eventThread = (ev: ThreatEvent): ThreadInfo => {
  const [title, glyph] = TITLE[ev.archetype] ?? ['A threat', '!'];
  return { id: `threat:${ev.id}`, tab: 'threats', title, glyph };
};

/** Skipped: boss operations (their group's thread) and the hero's own rampage. */
const told = (ev: ThreatEvent) => ev.archetype !== 'boss' && ev.archetype !== 'rampage';

/** An omen was shown near the hero (ThreatDirector.showOmens): a quiet clue in the signs' thread. */
export function omenSeen(g: Game, n: number, archetype: string, kind: string): void {
  const text = OMEN[`${archetype}:${kind}`] ?? OMEN[kind];
  if (!text || !g.story) return;
  const p = g.player.pos;
  g.story.note(omenThread(n), `${text} ${g.story.where(p.x, p.z)}`.trim(), { x: p.x, z: p.z, src: 'seen' });
}

/** An event began (n: the clock's event number when it was heralded). */
export function threatStarted(g: Game, ev: ThreatEvent, n: number | null): void {
  const S = g.story;
  if (!S || !told(ev)) return;
  const info = eventThread(ev);
  // The signs came true.
  if (n !== null && S.know.threads.get(omenThread(n).id)?.open) S.close(omenThread(n), `It came: ${info.title.toLowerCase()}`);
  S.tell(info, `<b>${info.title}</b> ${verbOf(ev.archetype)} ${S.where(ev.x, ev.z)} — marked on your map`, { kind: 'warn', x: ev.x, z: ev.z, src: 'news' });
}

/** An event is over. */
export function threatEnded(g: Game, ev: ThreatEvent): void {
  const S = g.story;
  if (!S || !told(ev) || !S.know.threads.has(`threat:${ev.id}`)) return;
  const end = ev.outcome ? ENDING[ev.outcome] : 'Over';
  S.close(eventThread(ev), end);
}

function verbOf(archetype: string): string {
  switch (archetype) {
    case 'robots': return 'are attacking people';
    case 'brood': return 'is loose';
    case 'murk': return 'are loose';
    case 'leviathan': return 'is in the river';
    case 'roc': return 'is over the town';
    default: return 'is in the city';
  }
}
