/**
 * The hero's tracker (GAME_MASTER_PLAN §3): a small strip above the minimap, one round chip per
 * open story thread (a group's emblem in its colour, a monster, a person), pulsing when something
 * new comes in. A click (or J) opens the panel: tabs for Villains, Threats and People, each thread
 * with what the hero knows, newest first, and how it ended. Clues and places with a spot in the
 * city show it on the map (and set the compass marker there).
 *
 * Plain DOM, redrawn only when the story changes. Normal mode only (game/story/Story).
 */
import type { Game } from '../game/Game';
import type { Story } from '../game/story/Story';
import { TAB_COLOR } from '../game/story/Story';
import { STORY_TABS, clueTime, type StoryTab, type Thread } from '../game/story/knowledge';
import { isAction } from '../game/keybinds';
import { esc } from './esc';

/** Chips on the strip at most (the newest open threads). */
const CHIPS = 6;
/** Seconds a chip pulses after a change. */
const PULSE = 2.4;

export class Tracker {
  private strip: HTMLDivElement;
  private book: HTMLButtonElement;
  private chips: HTMLDivElement;
  private panel: HTMLDivElement;
  private open = false;
  private tab: StoryTab = 'villains';
  /** A thread to scroll to and highlight when the panel opens on it. */
  private focusId: string | null = null;
  private pulses = new Map<string, number>();
  private dirty = true;
  private visible = true;
  private bottom = '';
  private mapWas = false;

  constructor(private g: Game, private story: Story) {
    this.strip = document.createElement('div');
    this.strip.id = 'tracker';
    this.chips = document.createElement('div');
    this.chips.className = 'tr-chips';
    this.book = document.createElement('button');
    this.book.className = 'tr-book';
    this.book.title = 'Your story so far (J)';
    this.book.innerHTML = '<span class="ic">☰</span><span class="n"></span>';
    this.book.onclick = () => this.toggle();
    this.strip.append(this.chips, this.book);
    this.panel = document.createElement('div');
    this.panel.id = 'tracker-panel';
    document.body.append(this.strip, this.panel);
    this.panel.addEventListener('click', (e) => this.click(e));
    // (Clicks on the strip and panel are the tracker's, not the game's.)
    for (const el of [this.strip, this.panel]) for (const ev of ['mousedown', 'pointerdown', 'wheel'] as const) el.addEventListener(ev, (e) => e.stopPropagation());
    story.onChange = (pulse) => {
      if (pulse) this.pulses.set(pulse, PULSE);
      this.dirty = true;
    };
    window.addEventListener('keydown', (e) => {
      if (!this.story.enabled || e.repeat || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (this.g.map.open || this.g.menu?.paused === true) return;
      if (isAction(e, 'tracker')) { this.toggle(); return; }
      if (e.code === 'Escape' && this.open) { e.stopImmediatePropagation(); this.toggle(false); }
    }, true);
  }

  /** Hidden with the HUD (photo mode, menus); never shown in the sandbox. */
  setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    this.dirty = true;
  }

  toggle(on = !this.open, tab?: StoryTab, focus?: string): void {
    if (!this.story.enabled) return;
    this.open = on;
    if (tab) this.tab = tab;
    this.focusId = focus ?? null;
    this.dirty = true;
    this.draw();
  }

  get isOpen(): boolean {
    return this.open;
  }

  update(dt: number): void {
    for (const [id, t] of this.pulses) {
      const n = t - dt;
      if (n <= 0) { this.pulses.delete(id); this.dirty = true; } else this.pulses.set(id, n);
    }
    // Above the minimap (or in its place when it is off); touch layouts keep theirs in CSS.
    const mini = document.getElementById('minimap');
    const bottom = mini && mini.style.display !== 'none' && !document.body.classList.contains('touch') ? `${16 + (mini.offsetHeight || 196) + 10}px` : '';
    if (bottom !== this.bottom) { this.bottom = bottom; this.strip.style.bottom = bottom; this.panel.style.bottom = bottom ? `${parseFloat(bottom) + 46}px` : ''; }
    if (this.g.map.open !== this.mapWas) { this.mapWas = this.g.map.open; this.dirty = true; }
    if (this.dirty) this.draw();
  }

  private draw(): void {
    this.dirty = false;
    const K = this.story.know, on = this.story.enabled && this.visible && !this.g.map.open;
    const any = K.threads.size > 0;
    this.strip.style.display = on && any ? 'flex' : 'none';
    if (!on) { this.panel.style.display = 'none'; return; }
    // The strip: the newest open threads.
    const open = K.open().slice(0, CHIPS);
    this.chips.innerHTML = open.map((t) => `<div class="tr-chip${this.pulses.has(t.id) ? ' pulse' : ''}${t.fresh ? ' fresh' : ''}" data-id="${esc(t.id)}" style="--c:${colorOf(t)}" title="${esc(t.title)}${t.clues.length ? ` — ${esc(t.clues[t.clues.length - 1].text)}` : ''}">${esc(glyphOf(t))}</div>`).join('');
    for (const el of this.chips.querySelectorAll<HTMLDivElement>('.tr-chip')) {
      el.onclick = () => { const t = K.threads.get(el.dataset.id ?? ''); if (t) this.toggle(true, t.tab, t.id); };
    }
    const fresh = K.fresh();
    const n = this.book.querySelector('.n') as HTMLSpanElement;
    n.textContent = fresh ? String(fresh) : '';
    this.book.classList.toggle('fresh', fresh > 0);
    this.book.classList.toggle('on', this.open);
    // The panel.
    this.panel.style.display = this.open ? 'flex' : 'none';
    if (!this.open) return;
    const list = K.list(this.tab);
    const tabs = STORY_TABS.map((t) => {
      const f = K.fresh(t.id);
      return `<button class="tr-tab${t.id === this.tab ? ' sel' : ''}" data-tab="${t.id}">${t.label}${f ? ` <span class="n">${f}</span>` : ''}</button>`;
    }).join('');
    const body = list.length ? list.map((t) => this.entry(t)).join('') : `<div class="tr-empty">${EMPTY[this.tab]}</div>`;
    this.panel.innerHTML = `<div class="tr-head"><div class="tr-tabs">${tabs}</div><button class="tr-close" title="Close (J)">×</button></div><div class="tr-list">${body}</div>`;
    if (this.focusId) {
      const el = this.panel.querySelector<HTMLElement>(`[data-thread="${CSS.escape(this.focusId)}"]`);
      el?.classList.add('focus');
      el?.scrollIntoView({ block: 'nearest' });
    }
    // What is shown has been read.
    K.read(list.map((t) => t.id));
  }

  private entry(t: Thread): string {
    const c = colorOf(t);
    const place = t.place ? `<div class="tr-place"><button class="tr-pin" data-x="${t.place.x.toFixed(1)}" data-z="${t.place.z.toFixed(1)}" title="Show on the map">⌖</button>${esc(t.place.label)}</div>` : '';
    const clues = t.clues.slice().reverse().map((k) => `<li><span class="when">${clueTime(k.at)}</span>${k.x !== undefined && k.z !== undefined ? `<button class="tr-pin" data-x="${k.x.toFixed(1)}" data-z="${k.z.toFixed(1)}" title="Show on the map">⌖</button>` : ''}${esc(k.text)}</li>`).join('');
    const state = t.open ? '' : `<div class="tr-ending">${esc(t.ending ?? 'Over')}</div>`;
    return `<div class="tr-thread${t.open ? '' : ' closed'}${t.fresh ? ' fresh' : ''}" data-thread="${esc(t.id)}" style="--c:${c}">
      <div class="tr-title"><span class="tr-glyph">${esc(glyphOf(t))}</span><b>${esc(t.title)}</b></div>${state}${place}<ul>${clues}</ul></div>`;
  }

  private click(e: MouseEvent): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!el) return;
    if (el.classList.contains('tr-close')) { this.toggle(false); return; }
    if (el.dataset.tab) { this.tab = el.dataset.tab as StoryTab; this.focusId = null; this.draw(); return; }
    if (el.classList.contains('tr-pin')) {
      const x = Number(el.dataset.x), z = Number(el.dataset.z);
      if (Number.isFinite(x) && Number.isFinite(z)) this.g.map.showAt(x, z);
    }
  }
}

const EMPTY: Record<StoryTab, string> = {
  villains: 'Nothing yet. Stop a crime, and what you learn about the gangs behind it shows up here.',
  threats: 'Nothing yet. Strange signs and the threats that follow them show up here.',
  people: 'Nothing yet. Favours people ask of you and your sidekick show up here.',
};

function colorOf(t: Thread): string {
  return t.color ?? TAB_COLOR[t.tab];
}

function glyphOf(t: Thread): string {
  return t.glyph ?? (t.tab === 'threats' ? '!' : t.tab === 'people' ? '●' : '◆');
}
