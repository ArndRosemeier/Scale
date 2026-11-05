/**
 * The game master's director (GAME_MASTER_PLAN §2.1, phase 2): what the player needs now. A few
 * needs grow while unmet (seconds of play since the last time) and are met by what the hero does:
 *
 *   story       something new about a thread reaches the hero (a clue in the tracker)
 *   challenge   a fight won (a criminal knocked out, a crime stopped)
 *   people      a talk with someone
 *
 * The tension curve keeps a rhythm: after a payoff (a fight won) a calm stretch where the game
 * master sends nothing; it acts only when a need is overdue, at most once per `minGap`. Every
 * move is logged with the tool, the need and why (the developer panel shows it).
 *
 * Pure (no DOM, no three.js), saved; tested in selftest ("game master").
 */

export type Need = 'story' | 'challenge' | 'people';
export const NEEDS: readonly Need[] = ['story', 'challenge', 'people'];

export const GM = {
  /** Seconds between two looks at the needs. */
  tick: 4,
  /** A need is overdue after this many seconds of play unmet. */
  overdue: { story: 360, challenge: 300, people: 600 } as Record<Need, number>,
  /** Calm after a payoff (s): the game master sends nothing new. */
  calmAfter: 150,
  /** Seconds between two moves at least. */
  minGap: 120,
  /** A rumour goes round for this many game hours. */
  rumourHours: 24,
  /** Moves kept in the log. */
  logKeep: 60,
};

export type Pacing = 'calm' | 'build';

/** One thing the game master did, and why. */
export interface GmMove {
  /** Seconds of play (this city) and game hours. */
  t: number;
  at: number;
  tool: string;
  need: Need;
  why: string;
  x?: number;
  z?: number;
}

/** Gossip the game master put about: what people say when asked for the news. */
export interface Rumour {
  /** The thread it belongs to (a group's: `group:<archetype>`). */
  thread: string;
  text: string;
  /** Where it points (the clue's spot). */
  x: number;
  z: number;
  /** Game hours it goes round until. */
  until: number;
  heard: boolean;
}

export interface GmState {
  v: 1;
  played: number;
  /** Seconds of play when each need was last met. */
  met: Record<Need, number>;
  calmUntil: number;
  lastMove: number;
  n: number;
  rumour: Rumour | null;
  log: GmMove[];
}

export const freshState = (): GmState => ({ v: 1, played: 0, met: { story: 0, challenge: 0, people: 0 }, calmUntil: 0, lastMove: -1e9, n: 0, rumour: null, log: [] });

export class Director {
  state: GmState = freshState();

  /** The hero did something that meets a need. A won fight is a payoff: calm follows. */
  met(need: Need): void {
    const S = this.state;
    S.met[need] = S.played;
    if (need === 'challenge') S.calmUntil = Math.max(S.calmUntil, S.played + GM.calmAfter);
  }

  /** Seconds a need has gone unmet. */
  waited(need: Need): number {
    return this.state.played - this.state.met[need];
  }

  pacing(): Pacing {
    return this.state.played < this.state.calmUntil ? 'calm' : 'build';
  }

  /** Overdue needs, the longest overdue first (by share of its limit); none while calm or just after a move. */
  due(): Need[] {
    const S = this.state;
    if (this.pacing() === 'calm' || S.played - S.lastMove < GM.minGap) return [];
    return NEEDS.filter((n) => this.waited(n) >= GM.overdue[n]).sort((a, b) => this.waited(b) / GM.overdue[b] - this.waited(a) / GM.overdue[a]);
  }

  /** Book a move: the log, the gap to the next one. */
  record(m: Omit<GmMove, 't'>): GmMove {
    const S = this.state, move: GmMove = { ...m, t: Math.round(S.played) };
    S.log.push(move);
    while (S.log.length > GM.logKeep) S.log.shift();
    S.lastMove = S.played;
    S.n++;
    return move;
  }

  save(): GmState {
    return JSON.parse(JSON.stringify(this.state)) as GmState;
  }

  /** Put a save back; damaged parts come back fresh. */
  restore(d: unknown): void {
    const o = d as Partial<GmState> | null, S = freshState();
    if (o && o.v === 1) {
      const fin = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
      S.played = Math.max(0, fin(o.played, 0));
      for (const n of NEEDS) S.met[n] = Math.min(S.played, fin(o.met?.[n], S.played));
      S.calmUntil = fin(o.calmUntil, 0);
      S.lastMove = fin(o.lastMove, -1e9);
      S.n = Math.max(0, Math.floor(fin(o.n, 0)));
      const r = o.rumour;
      if (r && typeof r.thread === 'string' && typeof r.text === 'string' && [r.x, r.z, r.until].every(Number.isFinite)) S.rumour = { thread: r.thread, text: r.text, x: r.x, z: r.z, until: r.until, heard: !!r.heard };
      if (Array.isArray(o.log)) {
        S.log = o.log.filter((m): m is GmMove => !!m && typeof m.tool === 'string' && typeof m.why === 'string' && NEEDS.includes(m.need) && Number.isFinite(m.t) && Number.isFinite(m.at)).slice(-GM.logKeep)
          .map((m) => ({ t: m.t, at: m.at, tool: m.tool, need: m.need, why: m.why, ...(Number.isFinite(m.x) && Number.isFinite(m.z) ? { x: m.x, z: m.z } : {}) }));
      }
    }
    this.state = S;
  }
}

/** A thread the hero is following, as the director sees it. */
export interface Followed { id: string; t: number; open: boolean }

/**
 * Which villain group's story to bring back: the open group thread with the newest news; with
 * none, the group whose turf the hero stands in (`here`, a thread id or null).
 */
export function followedGroup(threads: readonly Followed[], here: string | null, alive: (id: string) => boolean): string | null {
  let best: Followed | null = null;
  for (const t of threads) if (t.open && t.id.startsWith('group:') && alive(t.id) && (!best || t.t > best.t)) best = t;
  return best?.id ?? (here && alive(here) ? here : null);
}

const HIDEOUT_RUMOURS = [
  'Word is {group} keep their stash somewhere {where}.',
  'People say {group} have a back room {where}. I keep well away from it.',
  'My cousin swears {group} meet behind some door {where}.',
  'You didn\'t hear it from me, but {group} hide out {where}.',
];

/** A rumour about where a group hides out (seeded pick of the wording). */
export function hideoutRumour(group: string, where: string, u: number): string {
  const l = HIDEOUT_RUMOURS[Math.min(HIDEOUT_RUMOURS.length - 1, Math.floor(u * HIDEOUT_RUMOURS.length))];
  return l.replace('{group}', group).replace('{where}', where);
}
