/**
 * The hero's story so far (GAME_MASTER_PLAN §3, phase 1): systems tell the hero something here
 * (a group noticed them, a hideout found, a boss jailed, a monster in the city, a favour asked)
 * and it becomes a short toast or an important speech bubble and a clue in the tracker
 * (ui/Tracker). Only what the hero saw or heard goes in.
 *
 * Normal mode only (Arnd: the sandbox is not for real challenges): in the sandbox the toasts still
 * show, nothing is recorded and the tracker stays hidden.
 *
 * Saved per city in the browser and in save files (SaveData.story).
 */
import type { Game } from '../Game';
import type { Faction } from '../factions/Factions';
import type { ToastKind } from '../../ui/PowerHud';
import { Knowledge, plainText, type ClueSource, type StoryTab, type Thread, type ThreadInfo } from './knowledge';
import { esc } from '../../ui/esc';
import { STORY_SAY, type StoryAnchor, sayStory } from './storyVoice';

const STORE = (g: Game) => `scale.story.v1.${g.mode}.${g.settings.seed}.${g.settings.size.toFixed(2)}`;

/** Colours of threads that have none of their own, by tab. */
export const TAB_COLOR: Record<StoryTab, string> = { villains: '#d8b56a', threats: '#ff6b5e', people: '#7fc8ff' };

export interface TellOpts {
  kind?: ToastKind;
  ms?: number;
  /** Where (world): the clue can be shown on the map. */
  x?: number;
  z?: number;
  src?: ClueSource;
  /** No toast (it was said in a bubble, or it is a quiet sign: the strip only pulses). */
  quiet?: boolean;
}

export class Story {
  readonly know = new Knowledge();
  /** The tracker redraws (and pulses the thread) when something changes. */
  onChange: ((pulse: string | null) => void) | null = null;
  private saveT = 0;
  private dirty = false;
  private devDone = false;

  constructor(private g: Game) {
    if (!this.enabled) return;
    try { this.know.restore(JSON.parse(localStorage.getItem(STORE(g)) ?? 'null')); } catch { /* storage unavailable */ }
  }

  /** Normal mode only. */
  get enabled(): boolean {
    return this.g.mode !== 'sandbox';
  }

  /** A villain group's thread. */
  group(f: Faction): ThreadInfo {
    return { id: `group:${f.archetype}`, tab: 'villains', title: f.name, color: f.palette.map, glyph: f.emblem };
  }

  /**
   * Tell the hero something: a toast (unless quiet) and, in Normal mode, a clue in the thread.
   * `html` is the toast; the clue is its plain text.
   */
  tell(info: ThreadInfo, html: string, o: TellOpts = {}): void {
    if (!o.quiet) this.g.powerHud?.toast(html, o.kind ?? 'info', o.ms, info.color ?? TAB_COLOR[info.tab]);
    this.note(info, plainText(html), o);
  }

  /** A clue without a toast of its own (the caller showed it some other way). */
  note(info: ThreadInfo, text: string, o: TellOpts = {}): Thread | null {
    if (!this.enabled) return null;
    const r = this.know.note(info, { at: this.g.sky.hoursAbs, text, src: o.src ?? 'seen', ...(Number.isFinite(o.x) && Number.isFinite(o.z) ? { x: o.x, z: o.z } : {}) });
    if (r.added) { this.changed(r.thread.id); this.g.gm?.met('story'); }
    return r.thread;
  }

  /** The thread is over; `html` (optional) is told as a toast and is the last clue. */
  close(info: ThreadInfo, ending: string, html?: string, o: TellOpts = {}): void {
    if (html) this.tell(info, html, { ...o, src: o.src ?? 'done' });
    if (!this.enabled || !this.know.threads.has(info.id)) return;
    if (this.know.close(info.id, ending, this.g.sky.hoursAbs)) this.changed(info.id);
  }

  /** A place for the thread (a hideout found: "Show on map"); null takes it away. */
  place(id: string, p: { x: number; z: number; label: string } | null): void {
    if (!this.enabled) return;
    this.know.setPlace(id, p);
    this.changed(null);
  }

  /**
   * An important line from someone (a cuffed crook giving up the hideout, a witness): a speech
   * bubble that stands out from the street's chatter (a coloured edge with the thread's emblem, a
   * chime, the speaker turning to the hero, said again when the hero walks up), and a clue. When the
   * bubble cannot be shown (off screen), the line comes as a toast instead.
   */
  say(a: StoryAnchor, info: ThreadInfo, line: string, o: TellOpts = {}): void {
    const shown = sayStory(this.g, a, line, info.color ?? TAB_COLOR[info.tab], info.glyph ?? '');
    if (!shown) this.g.powerHud?.toast(`<b style="color:${info.color ?? TAB_COLOR[info.tab]}">${info.glyph ?? ''} ${esc(info.title)}</b>: “${esc(line)}”`, o.kind ?? 'info', o.ms, info.color ?? TAB_COLOR[info.tab]);
    else this.g.audio?.chime('story', 0.55);
    this.note(info, `“${line}”`, { ...o, src: o.src ?? 'heard', x: o.x ?? a.x, z: o.z ?? a.z });
  }

  /** "on Elm Street" / "in Mill Quarter" / "" for a point of the city. */
  where(x: number, z: number): string {
    const street = this.g.people?.streetAt(x, z);
    if (street) return `on ${street}`;
    const hood = this.g.city?.hoodNameAt(x, z);
    return hood ? `in ${hood}` : '';
  }

  update(dt: number): void {
    if (!this.devDone) this.installDev();
    STORY_SAY.update(this.g, dt);
    this.saveT -= dt;
    if (this.dirty && this.saveT <= 0) this.persist();
  }

  save(): unknown {
    return this.enabled ? this.know.save() : null;
  }

  restore(d: unknown): void {
    if (!this.enabled) return;
    this.know.restore(d ?? null);
    this.persist();
    this.onChange?.(null);
  }

  /** Forget everything (dev). */
  clear(): void {
    this.know.clear();
    this.persist();
    this.onChange?.(null);
  }

  private installDev(): void {
    const dev = (window as unknown as { dev?: Record<string, unknown> }).dev;
    if (!dev) return;
    this.devDone = true;
    const g = this.g;
    dev.story = {
      story: this,
      /** Every thread with its clues. */
      status: () => this.know.list().map((t) => ({ id: t.id, tab: t.tab, title: t.title, open: t.open, ending: t.ending, clues: t.clues.map((c) => c.text) })),
      /** Open or close the tracker's panel on a tab. */
      open: (tab: StoryTab = 'villains') => g.tracker?.toggle(true, tab),
      close: () => g.tracker?.toggle(false),
      clear: () => this.clear(),
      /** An important bubble over the nearest passer-by (for a look at it). */
      say: (line = 'They went into the back of the laundry round the corner!') => {
        const p = g.player.pos;
        const a = g.peds.nearest(p.x, p.z, 25, (x) => x.alive && !x.inside);
        const f = g.crime.factions.factions[0];
        if (!a || !f) return 'nobody near';
        this.say(a, this.group(f), line);
        return a.cit.id;
      },
      /** A few threads of every kind, made up from the city's real groups (for a look at the tracker). */
      demo: () => {
        const F = g.crime.factions.factions, p = g.player.pos, h = g.sky.hoursAbs;
        const at = (dx: number, dz: number) => ({ x: p.x + dx, z: p.z + dz });
        const add = (info: ThreadInfo, text: string, dh: number, w?: { x: number; z: number }, src: ClueSource = 'seen') =>
          this.know.note(info, { at: Math.max(0, h - dh), text, src, ...(w ? { x: w.x, z: w.z } : {}) });
        if (F[0]) {
          const A = this.group(F[0]);
          add(A, `You stopped a mugging ${this.where(p.x + 40, p.z)}`.trim(), 26, at(40, 0));
          add(A, `${F[0].name} have noticed you — expect their lieutenants`, 20);
          add(A, `“Fine! The hideout is ${this.where(p.x - 80, p.z + 60) || 'round the corner'}. Happy now?”`, 3, at(-80, 60), 'told');
          this.know.setPlace(A.id, { ...at(-80, 60), label: `Their hideout ${this.where(p.x - 80, p.z + 60)}`.trim() });
        }
        if (F[1]) {
          const B = this.group(F[1]);
          add(B, `${F[1].name} took over another block`, 8, at(120, -40));
          add(B, `You knocked out their boss — the police will take them in`, 5, at(100, -30));
        }
        if (F[2]) { const C = this.group(F[2]); add(C, `You stopped a robbery ${this.where(p.x, p.z - 90)}`.trim(), 40, at(0, -90)); this.know.close(C.id, 'Collapsed: their boss is behind bars and their stash is gone', h - 30); }
        const O: ThreadInfo = { id: 'omens:dev', tab: 'threats', title: 'Strange signs', glyph: '?', color: '#b9a4ff' };
        add(O, 'A deep rumble under the street', 2, at(10, 10));
        add(O, 'A pothole opened up out of nowhere', 1, at(-30, 20));
        const T: ThreadInfo = { id: 'threat:dev', tab: 'threats', title: 'Rogue robots', glyph: '⚙' };
        add(T, 'Rogue robots are attacking people — marked on your map', 30, at(200, 50), 'news');
        this.know.close(T.id, 'Stopped', h - 29);
        const P: ThreadInfo = { id: 'favour:dev', tab: 'people', title: 'A favour for Mara Lindqvist', glyph: '●', color: '#7fc8ff' };
        add(P, 'Asked you to look in on their sister Ida Lindqvist within two days', 4, at(5, 5), 'told');
        this.know.setPlace(P.id, { ...at(150, 90), label: 'Ida Lindqvist was last seen nearby' });
        this.changed(F[0] ? `group:${F[0].archetype}` : null);
        return this.know.list().length;
      },
    };
  }

  private changed(pulse: string | null): void {
    this.dirty = true;
    if (this.saveT <= 0) this.saveT = 3;
    this.onChange?.(pulse);
  }

  private persist(): void {
    this.dirty = false;
    this.saveT = 0;
    if (!this.enabled) return;
    try { localStorage.setItem(STORE(this.g), JSON.stringify(this.know.save())); } catch { /* storage unavailable or full */ }
  }
}
