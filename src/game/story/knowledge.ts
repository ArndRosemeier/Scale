/**
 * What the hero knows (GAME_MASTER_PLAN §3): story threads (a villain group, a threat, a favour,
 * the sidekick), each a short list of clues the hero saw or heard, newest last. The tracker shows
 * it; nothing here knows anything the hero has not come across (every clue has a source).
 *
 * Pure (no DOM, no three.js), saved per city; tested in selftest ("story knowledge").
 */

export type StoryTab = 'villains' | 'threats' | 'people';

export const STORY_TABS: readonly { id: StoryTab; label: string }[] = [
  { id: 'villains', label: 'Villains' },
  { id: 'threats', label: 'Threats' },
  { id: 'people', label: 'People' },
];

/** How the hero came to know it. */
export type ClueSource = 'seen' | 'heard' | 'news' | 'told' | 'done';

export interface Clue {
  /** Game hours (sky.hoursAbs). */
  at: number;
  /** Plain text (no HTML). */
  text: string;
  src: ClueSource;
  /** Where it happened, if anywhere (world x, z): the tracker can show it on the map. */
  x?: number;
  z?: number;
}

/** Who a thread is about: shown on the strip and at the top of its entry. */
export interface ThreadInfo {
  id: string;
  tab: StoryTab;
  title: string;
  /** CSS colour (a group's map colour); default by tab. */
  color?: string;
  /** One or two characters (a group's emblem, a monster glyph). */
  glyph?: string;
}

export interface Thread extends ThreadInfo {
  clues: Clue[];
  open: boolean;
  /** How it ended (closed threads). */
  ending?: string;
  /** Game hours of the last change. */
  t: number;
  /** Changed since the hero last looked at it in the tracker. */
  fresh: boolean;
  /** A place that belongs to the thread (a hideout found, a favour's street): pinned in the entry. */
  place?: { x: number; z: number; label: string };
}

export const KNOWLEDGE = {
  /** Clues kept per thread (older ones fold away). */
  clues: 10,
  /** Threads kept in all; closed ones go first. */
  threads: 40,
  /** Closed threads kept. */
  closed: 16,
};

const TABS = new Set<StoryTab>(['villains', 'threats', 'people']);
const SOURCES = new Set<ClueSource>(['seen', 'heard', 'news', 'told', 'done']);

export class Knowledge {
  readonly threads = new Map<string, Thread>();

  /**
   * Add a clue to a thread (made, or reopened, if need be). The same text twice within an hour is
   * one clue. Returns the thread and whether this was news (a new thread or a new clue).
   */
  note(info: ThreadInfo, clue: Clue): { thread: Thread; added: boolean; created: boolean } {
    let th = this.threads.get(info.id);
    const created = !th;
    if (!th) {
      th = { ...info, clues: [], open: true, t: clue.at, fresh: true };
      this.threads.set(info.id, th);
    }
    th.title = info.title || th.title;
    if (info.color) th.color = info.color;
    if (info.glyph) th.glyph = info.glyph;
    const last = th.clues[th.clues.length - 1];
    const dup = th.clues.some((c) => c.text === clue.text && Math.abs(c.at - clue.at) < 1);
    if (dup && th.open) return { thread: th, added: false, created };
    if (!th.open) { th.open = true; delete th.ending; }
    if (!dup) th.clues.push(cleanClue(clue));
    while (th.clues.length > KNOWLEDGE.clues) th.clues.shift();
    th.t = Math.max(th.t, clue.at, last?.at ?? 0);
    th.fresh = true;
    this.trim();
    return { thread: th, added: true, created };
  }

  /** The thread is over (the group collapsed, the monster fell, the favour done): `ending` says how. */
  close(id: string, ending: string, at: number): Thread | null {
    const th = this.threads.get(id);
    if (!th || !th.open) return null;
    th.open = false;
    th.ending = ending;
    th.t = Math.max(th.t, at);
    th.fresh = true;
    this.trim();
    return th;
  }

  setPlace(id: string, place: Thread['place'] | null): void {
    const th = this.threads.get(id);
    if (!th) return;
    if (place) th.place = { ...place }; else delete th.place;
  }

  /** Threads of a tab: open ones first (newest first), then closed ones (newest first). */
  list(tab?: StoryTab): Thread[] {
    return [...this.threads.values()].filter((t) => !tab || t.tab === tab).sort((a, b) => Number(b.open) - Number(a.open) || b.t - a.t);
  }

  open(): Thread[] {
    return this.list().filter((t) => t.open);
  }

  /** Something new the hero has not looked at in the tracker yet (per tab). */
  fresh(tab?: StoryTab): number {
    let n = 0;
    for (const t of this.threads.values()) if (t.fresh && (!tab || t.tab === tab)) n++;
    return n;
  }

  /** The hero looked at these threads in the tracker. */
  read(ids: Iterable<string>): void {
    for (const id of ids) { const t = this.threads.get(id); if (t) t.fresh = false; }
  }

  clear(): void {
    this.threads.clear();
  }

  save(): unknown {
    return { v: 1, threads: this.list().map((t) => ({ ...t, clues: t.clues.map((c) => ({ ...c })), ...(t.place ? { place: { ...t.place } } : {}) })) };
  }

  /** Put a save back; anything damaged is left out (null: nothing known). */
  restore(d: unknown): void {
    this.threads.clear();
    const o = d as { v?: number; threads?: unknown[] } | null;
    if (!o || o.v !== 1 || !Array.isArray(o.threads)) return;
    for (const r of o.threads) {
      const t = r as Partial<Thread>;
      if (!t || typeof t.id !== 'string' || typeof t.title !== 'string' || !TABS.has(t.tab as StoryTab) || !Array.isArray(t.clues)) continue;
      const clues = (t.clues as Partial<Clue>[]).filter((c) => !!c && typeof c.text === 'string' && Number.isFinite(c.at) && SOURCES.has(c.src as ClueSource)).map((c) => cleanClue(c as Clue)).slice(-KNOWLEDGE.clues);
      const th: Thread = {
        id: t.id, tab: t.tab as StoryTab, title: t.title, clues, open: t.open !== false, t: Number.isFinite(t.t) ? t.t! : clues[clues.length - 1]?.at ?? 0, fresh: !!t.fresh,
        ...(typeof t.color === 'string' ? { color: t.color } : {}), ...(typeof t.glyph === 'string' ? { glyph: t.glyph } : {}),
        ...(t.open === false && typeof t.ending === 'string' ? { ending: t.ending } : {}),
      };
      const p = t.place;
      if (p && Number.isFinite(p.x) && Number.isFinite(p.z) && typeof p.label === 'string') th.place = { x: p.x, z: p.z, label: p.label };
      this.threads.set(th.id, th);
    }
    this.trim();
  }

  /** Keep within KNOWLEDGE: the oldest closed threads go first, then the oldest open ones. */
  private trim(): void {
    const closed = this.list().filter((t) => !t.open);
    for (const t of closed.slice(KNOWLEDGE.closed)) this.threads.delete(t.id);
    const all = this.list();
    for (const t of all.slice(KNOWLEDGE.threads)) this.threads.delete(t.id);
  }
}

function cleanClue(c: Clue): Clue {
  const out: Clue = { at: c.at, text: c.text, src: c.src };
  if (Number.isFinite(c.x) && Number.isFinite(c.z)) { out.x = c.x; out.z = c.z; }
  return out;
}

/** "Day 3, 14:05" for a clue's time. */
export function clueTime(at: number): string {
  const day = Math.floor(at / 24), h = ((at % 24) + 24) % 24, hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
  return `Day ${day + 1}, ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** HTML of a toast or bubble line made plain for a clue ("<b>…</b>" and entities out). */
export function plainText(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/\s+/g, ' ').trim();
}
