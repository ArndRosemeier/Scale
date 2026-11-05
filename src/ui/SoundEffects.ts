/**
 * Sound effects list (pause menu › Sound effects): every sound the game has, grouped by its mix
 * category, each with an on/off checkbox. Ticking a box either way plays that sound once, so an
 * annoying sound can be found by ear and switched off. Off sounds never play in game (Audio.isOff,
 * PowerSynth.isOff) and stay off across sessions.
 */
import type { Game } from '../game/Game';
import { categoryOf, SOUND_CATEGORIES, type SoundCategory } from '../audio/Audio';
import { SYNTH_SOUNDS, type SynthLoop, type SynthShot } from '../audio/PowerSynth';
import { listenerPos } from '../audio/hearing';
import { esc } from './esc';

interface Entry { id: string; name: string; description: string; cat: SoundCategory }


export class SoundEffects {
  readonly el: HTMLDivElement;
  private list!: HTMLDivElement;
  private count!: HTMLSpanElement;
  private filter!: HTMLInputElement;
  private entries: Entry[] = [];

  constructor(private game: Game) {
    this.el = document.createElement('div');
    this.el.id = 'sfx';
    this.el.innerHTML = `
      <div class="panel sfx-panel" role="dialog" aria-label="Sound effects">
        <div class="sfx-head">
          <h2>Sound effects</h2>
          <input type="search" class="sfx-filter" placeholder="Find a sound…" aria-label="Find a sound">
          <span class="sfx-count"></span>
          <button type="button" class="sfx-all">All on</button>
          <button type="button" class="sfx-x" title="Close (Esc)">✕</button>
        </div>
        <p class="sfx-sub">Ticking or unticking a sound plays it once (▶ plays it without changing it). Unticked sounds stay silent in the game.</p>
        <div class="sfx-list"></div>
      </div>`;
    document.body.appendChild(this.el);
    this.list = this.el.querySelector('.sfx-list')!;
    this.count = this.el.querySelector('.sfx-count')!;
    this.filter = this.el.querySelector('.sfx-filter')!;
    this.el.querySelector<HTMLButtonElement>('.sfx-x')!.onclick = () => this.close();
    this.el.querySelector<HTMLButtonElement>('.sfx-all')!.onclick = () => {
      for (const e of this.entries) game.audio.setOff(e.id, false);
      this.render();
    };
    // Clicking the dark backdrop closes it.
    this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el) this.close(); });
    this.filter.oninput = () => this.applyFilter();
    // Typing in the search box must not reach the game's keys (H for help, map, powers …).
    this.filter.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') { e.preventDefault(); if (this.filter.value) { this.filter.value = ''; this.applyFilter(); } else this.close(); }
      e.stopPropagation();
    });
    this.list.addEventListener('change', (e) => {
      const box = e.target as HTMLInputElement;
      const id = box.dataset.id;
      if (!id) return;
      game.audio.setOff(id, !box.checked);
      box.closest('.sfx-row')?.classList.toggle('off', !box.checked);
      this.syncCount();
      this.play(id);
    });
    this.list.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-play]');
      if (b) this.play(b.dataset.play!);
    });
  }

  get isOpen(): boolean { return this.el.classList.contains('open'); }

  show(): void {
    this.entries = this.collect();
    this.render();
    this.el.classList.add('open');
    this.filter.focus();
  }

  close(): void { this.el.classList.remove('open'); }

  private collect(): Entry[] {
    const name = (id: string) => id.replace(/^chime_/, '').replace(/^synth_/, '').replace(/_/g, ' ');
    const out: Entry[] = this.game.audio.soundIds().map((s) => ({
      id: s.id, name: name(s.id), description: s.description + (s.loop && !/loop/.test(s.description) ? ' (loop)' : ''),
      cat: s.id.startsWith('chime_') ? 'ui' : categoryOf(s.id),
    }));
    for (const s of SYNTH_SOUNDS) out.push({ id: `synth_${s.kind}`, name: `${s.kind} (synth)`, description: s.description, cat: 'powers' });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private render(): void {
    const a = this.game.audio;
    this.list.innerHTML = SOUND_CATEGORIES.map((c) => {
      const rows = this.entries.filter((e) => e.cat === c.id);
      if (!rows.length) return '';
      return `<section class="sfx-cat"><h3>${esc(c.name)}</h3><div class="sfx-grid">${rows.map((e) => {
        const on = !a.isOff(e.id);
        return `<div class="sfx-row${on ? '' : ' off'}" data-find="${esc(`${e.id} ${e.name} ${e.description}`.toLowerCase())}">`
          + `<label title="${esc(e.description || e.id)}"><input type="checkbox" data-id="${esc(e.id)}"${on ? ' checked' : ''}>`
          + `<span class="sfx-name">${esc(e.name)}</span><span class="sfx-desc">${esc(e.description)}</span></label>`
          + `<button type="button" class="sfx-play" data-play="${esc(e.id)}" title="Play">▶</button></div>`;
      }).join('')}</div></section>`;
    }).join('');
    this.applyFilter();
    this.syncCount();
  }

  private applyFilter(): void {
    const q = this.filter.value.trim().toLowerCase();
    for (const r of this.list.querySelectorAll<HTMLElement>('.sfx-row')) r.style.display = !q || r.dataset.find!.includes(q) ? '' : 'none';
    for (const s of this.list.querySelectorAll<HTMLElement>('.sfx-cat')) s.style.display = s.querySelector('.sfx-row:not([style*="none"])') ? '' : 'none';
  }

  private syncCount(): void {
    const off = this.entries.filter((e) => this.game.audio.isOff(e.id)).length;
    this.count.textContent = off ? `${off} of ${this.entries.length} off` : `${this.entries.length} sounds, all on`;
  }

  private play(id: string): void {
    if (id.startsWith('synth_')) this.game.synth?.preview(id.slice(6) as SynthShot | SynthLoop, listenerPos);
    else this.game.audio.preview(id);
  }
}
