/**
 * Save game UI: the list of saves (thumbnail, name, city, mode, game day / time, real date; load
 * and delete with an inline confirm), Continue / Load game on the start screen, Save / Load and the
 * autosave status in the pause menu, saving to and loading from a file (saveFiles.ts), and the
 * small "Saving…" indicator.
 */
import './saves.css';
import type { Game } from '../game/Game';
import { saveStore } from '../game/save/SaveStore';
import { agoLabel, gameTimeLabel, playTimeLabel, type SaveMeta } from '../game/save/model';
import { manualId, type SaveStatus } from '../game/save/SaveSystem';
import { cityClass } from '../world/settings';
import { MODE_INFO } from '../game/mode';
import { hasSaveDialog, loadFromFile, writeSaveFile, writeStored } from './saveFiles';
import { esc } from './esc';

const thumbHtml = (m: SaveMeta) => (m.thumb ? `<img src="${esc(m.thumb)}" alt="">` : '<div class="sv-noimg"></div>');

/** "Lindenford · Normal · Day 3, 18:45" (HTML) */
export function saveLine(m: SaveMeta): string {
  return `<span title="${esc(cityClass(m.size))}, seed ${m.seed}">${esc(m.city)}</span> · ${MODE_INFO[m.mode]?.name ?? m.mode} · ${gameTimeLabel(m.day, m.hour)}`;
}

/**
 * A list of saves into `el`: the player's own (named) saves first, then the autosaves in a section
 * of their own, folded unless there is nothing else (the rotating autosaves are always the newest
 * and used to bury the named ones). `onLoad` / delete per row.
 */
export async function fillSaveList(el: HTMLElement, onLoad: (m: SaveMeta) => void, after?: (list: SaveMeta[]) => void): Promise<SaveMeta[]> {
  const list = await saveStore.list();
  el.innerHTML = '';
  const named = list.filter((m) => m.kind !== 'auto'), autos = list.filter((m) => m.kind === 'auto');
  const row = (m: SaveMeta, parent: HTMLElement) => {
    const r = document.createElement('div');
    r.className = 'sv-row';
    r.innerHTML = `${thumbHtml(m)}<div class="sv-info"><div class="sv-name">${esc(m.name)}</div>
      <div class="sv-sub">${saveLine(m)}</div><div class="sv-sub">${agoLabel(m.created)} · played <b>${playTimeLabel(m.playTime)}</b>${m.mode === 'normal' ? ` · ${m.karma} karma` : ''}</div></div>
      <div class="sv-acts"><button type="button" class="sv-load">Load</button><button type="button" class="sv-file" title="Save to a file">⇩</button><button type="button" class="sv-del" title="Delete this save">✕</button></div>`;
    const acts = r.querySelector('.sv-acts') as HTMLElement;
    const normal = acts.innerHTML;
    const wire = () => {
      (acts.querySelector('.sv-load') as HTMLButtonElement).onclick = () => onLoad(m);
      const file = acts.querySelector('.sv-file') as HTMLButtonElement;
      file.onclick = async () => {
        file.disabled = true;
        try { await writeStored(m); file.title = 'Save to a file'; } catch (e) { console.warn('[saves] file', e); file.title = 'That save could not be written to a file'; }
        file.disabled = false;
      };
      (acts.querySelector('.sv-del') as HTMLButtonElement).onclick = () => {
        acts.innerHTML = `<span class="sv-ask">Delete?</span><button type="button" class="sv-yes">Delete</button><button type="button" class="sv-no">Keep</button>`;
        (acts.querySelector('.sv-yes') as HTMLButtonElement).onclick = async () => { await saveStore.remove(m.id); r.remove(); after?.(await saveStore.list()); };
        (acts.querySelector('.sv-no') as HTMLButtonElement).onclick = () => { acts.innerHTML = normal; wire(); };
      };
    };
    wire();
    parent.appendChild(r);
  };
  const head = document.createElement('div');
  head.className = 'sv-sec';
  head.textContent = 'Your saves';
  el.appendChild(head);
  if (named.length) for (const m of named) row(m, el);
  else {
    const empty = document.createElement('div');
    empty.className = 'sv-empty';
    empty.textContent = 'No saved games yet — give one a name in the pause menu (Esc).';
    el.appendChild(empty);
  }
  if (autos.length) {
    const open = !named.length;
    const tog = document.createElement('button');
    tog.type = 'button';
    tog.className = 'sv-sec sv-toggle';
    const box = document.createElement('div');
    box.className = 'sv-autos';
    box.hidden = !open;
    const label = () => { tog.innerHTML = `<span>${box.hidden ? '▸' : '▾'}</span> Autosaves <span class="sv-count">${autos.length}</span>`; };
    tog.onclick = () => { box.hidden = !box.hidden; label(); };
    label();
    el.appendChild(tog);
    el.appendChild(box);
    for (const m of autos) row(m, box);
  }
  after?.(list);
  return list;
}

/**
 * Start screen: a prominent Continue (the newest save) and Load game (the list), above the
 * seed / size / mode / character choice for a new city.
 */
export class MainMenuSaves {
  readonly el: HTMLDivElement;
  private list: HTMLDivElement;

  constructor(parent: HTMLElement, before: Element | null, private onLoad: (m: SaveMeta) => void) {
    this.el = document.createElement('div');
    this.el.className = 'sv-main';
    this.el.style.display = 'none';
    parent.insertBefore(this.el, before);
    this.list = document.createElement('div');
    void this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      await saveStore.recover();
      const all = await saveStore.list();
      const latest = all[0];
      this.el.style.display = '';
      if (!latest) {
        // No saves in this browser: a save file can still be loaded.
        this.el.innerHTML = `<button type="button" class="sv-filebtn">Load from file…</button><div class="sv-fmsg"></div><div class="sv-or">or a new city</div>`;
        this.wireFile();
        return;
      }
      this.el.innerHTML = `<button type="button" class="sv-continue">${thumbHtml(latest)}<span class="sv-txt"><span class="sv-big">Continue</span>
        <span class="sv-line">${esc(latest.city)} (${cityClass(latest.size).toLowerCase()}) · ${MODE_INFO[latest.mode]?.name ?? latest.mode}</span>
        <span class="sv-line">${gameTimeLabel(latest.day, latest.hour)} · played ${playTimeLabel(latest.playTime)}</span>
        <span class="sv-line">${latest.kind === 'auto' ? 'Autosave' : esc(latest.name)} · ${agoLabel(latest.created)}</span></span></button>
        <div class="sv-btns"><button type="button" class="sv-loadbtn">Load game… (${all.length})</button><button type="button" class="sv-filebtn" title="Load a game saved to a file (.scale)">Load from file…</button></div>
        <div class="sv-fmsg"></div><div class="sv-or">or a new city</div>`;
      this.list.className = 'sv-list';
      this.list.hidden = true;
      this.el.insertBefore(this.list, this.el.querySelector('.sv-or'));
      (this.el.querySelector('.sv-continue') as HTMLButtonElement).onclick = () => this.onLoad(latest);
      const btn = this.el.querySelector('.sv-loadbtn') as HTMLButtonElement;
      btn.onclick = async () => {
        this.list.hidden = !this.list.hidden;
        if (!this.list.hidden) await fillSaveList(this.list, (m) => this.onLoad(m), (l) => { btn.textContent = `Load game… (${l.length})`; if (!l.length) void this.refresh(); });
      };
      this.wireFile();
    } catch (e) {
      console.warn('[saves] menu', e);
      this.el.style.display = 'none';
    }
  }

  private wireFile(): void {
    const msg = this.el.querySelector('.sv-fmsg') as HTMLElement;
    (this.el.querySelector('.sv-filebtn') as HTMLButtonElement).onclick = () => void loadFromFile((m) => this.onLoad(m), (t, err) => {
      msg.className = `sv-fmsg${err ? ' err' : ''}`;
      msg.textContent = t;
    });
  }
}

/** Pause menu: Save game (a name; overwrite confirm), Load game (the list), the autosave status. */
export class PauseSaves {
  private el: HTMLDivElement;
  private status: HTMLSpanElement;
  private name: HTMLInputElement;
  private confirm: HTMLDivElement;
  private list: HTMLDivElement;
  private msg: HTMLDivElement;

  constructor(private game: Game) {
    const panel = document.querySelector('#pause .panel');
    this.el = document.createElement('div');
    this.el.className = 'sv-pause';
    this.el.innerHTML = `<div class="sv-head"><span>Saved games</span><span class="sv-status"></span></div>
      <div class="sv-saverow"><input type="text" maxlength="40" placeholder="Name of the save" title="Name of the save (the same name overwrites it)" spellcheck="false"><button type="button" class="sv-save">Save game</button><button type="button" class="sv-open">Load game…</button></div>
      <div class="sv-filerow"><button type="button" class="sv-tofile" title="Download the game as a file (.scale) to keep, move to another computer or share">Save to file</button><button type="button" class="sv-fromfile" title="Load a game saved to a file (.scale)">Load from file…</button></div>
      <div class="sv-confirm" hidden><span></span><button type="button" class="sv-over">Overwrite</button><button type="button" class="sv-cancel">Cancel</button></div>
      <div class="sv-msg"></div><div class="sv-list" hidden></div>`;
    // Right under the title: saving and loading come first.
    panel?.insertBefore(this.el, panel.querySelector('h2')?.nextSibling ?? null);
    const $ = <T extends Element>(s: string) => this.el.querySelector(s) as T;
    this.status = $('.sv-status');
    this.name = $('input');
    this.confirm = $('.sv-confirm');
    this.list = $('.sv-list');
    this.msg = $('.sv-msg');
    // Typing a name must not reach the game (H, WASD, Esc are game keys).
    this.name.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Enter') { e.preventDefault(); void this.trySave(); }
      if (e.code === 'Escape') this.name.blur();
    });
    this.name.addEventListener('keyup', (e) => e.stopPropagation());
    this.name.addEventListener('input', () => { this.confirm.hidden = true; });
    $<HTMLButtonElement>('.sv-save').onclick = () => void this.trySave();
    $<HTMLButtonElement>('.sv-over').onclick = () => void this.doSave();
    $<HTMLButtonElement>('.sv-cancel').onclick = () => { this.confirm.hidden = true; };
    $<HTMLButtonElement>('.sv-tofile').onclick = () => void this.toFile();
    $<HTMLButtonElement>('.sv-fromfile').onclick = () => void loadFromFile((m) => { void this.game.saves.load(m.id); }, (t, err) => this.say(t, err));
    $<HTMLButtonElement>('.sv-open').onclick = () => {
      this.list.hidden = !this.list.hidden;
      if (!this.list.hidden) void this.fill();
    };
    // While the menu is open: refresh the status line each second.
    setInterval(() => { if (document.getElementById('pause')?.classList.contains('open')) this.sync(); }, 1000);
    new MutationObserver(() => this.sync()).observe(document.getElementById('pause')!, { attributes: true, attributeFilter: ['class'] });
    game.saves.listeners.push(() => this.sync());
    this.sync();
  }

  private fill(): Promise<SaveMeta[]> {
    return fillSaveList(this.list, (m) => {
      this.msg.className = 'sv-msg';
      this.msg.textContent = `Loading "${m.name}"…`;
      void this.game.saves.load(m.id).then((ok) => { if (!ok) { this.msg.className = 'sv-msg err'; this.msg.textContent = 'That save could not be read.'; } });
    });
  }

  private say(text: string, err = false): void {
    this.msg.className = `sv-msg${err ? ' err' : ''}`;
    this.msg.textContent = text;
  }

  /** The game as it is now, as a download (named like a save; nothing stored in the browser). */
  private async toFile(): Promise<void> {
    try {
      // Captured at the click (the game runs on behind the dialog), written once a place is chosen.
      const { data, meta } = this.game.saves.snapshot(this.name.value.trim() || this.defaultName());
      const file = await writeSaveFile(meta, async () => data);
      if (file) this.say(hasSaveDialog() ? `Saved to "${file}"` : `Saved to "${file}" (your downloads)`);
    } catch (e) {
      console.warn('[saves] file', e);
      this.say('Saving to a file failed — the game goes on.', true);
    }
  }

  private sync(): void {
    const S = this.game.saves;
    if (S.status === 'saving') { this.status.className = 'sv-status'; this.status.textContent = 'Saving…'; return; }
    if (S.status === 'failed') { this.status.className = 'sv-status'; this.status.textContent = 'The last save failed'; return; }
    this.status.className = 'sv-status ok';
    this.status.innerHTML = S.lastSaved ? `${S.lastKind === 'auto' ? 'Autosaved' : 'Saved'} <b>${agoLabel(S.lastSaved)}</b>` : 'Not saved yet';
    if (!this.name.value && document.activeElement !== this.name) this.name.placeholder = this.defaultName();
  }

  private defaultName(): string {
    const s = this.game.sky, h = Math.floor(s.hour), m = Math.floor((s.hour - h) * 60);
    return `Day ${s.day + 1} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  /** Save; a save of that name already there asks first (inline). */
  private async trySave(): Promise<void> {
    const name = this.name.value.trim() || this.defaultName();
    const id = manualId(name);
    const have = (await saveStore.list()).find((m) => m.id === id);
    if (have) {
      (this.confirm.querySelector('span') as HTMLElement).innerHTML = `A save called <b>${esc(have.name)}</b> exists (${agoLabel(have.created)}) — overwrite it?`;
      this.confirm.hidden = false;
      return;
    }
    await this.doSave();
  }

  private async doSave(): Promise<void> {
    this.confirm.hidden = true;
    const name = this.name.value.trim() || this.defaultName();
    this.msg.className = 'sv-msg';
    this.msg.textContent = 'Saving…';
    const m = await this.game.saves.save(name);
    if (m) { this.msg.textContent = `Saved as "${m.name}"`; this.name.value = ''; }
    else { this.msg.className = 'sv-msg err'; this.msg.textContent = 'Saving failed (storage full or unavailable) — the game goes on.'; }
    if (!this.list.hidden) void this.fill();
    this.sync();
  }
}

/** HUD: "Saving…" while a save is written, "Saved" for a moment after. */
export class SaveIndicator {
  private el: HTMLDivElement;
  private hideT = 0;

  constructor(game: Game) {
    this.el = document.createElement('div');
    this.el.id = 'sv-ind';
    document.body.appendChild(this.el);
    game.saves.listeners.push((s) => this.show(s));
  }

  private show(s: SaveStatus): void {
    clearTimeout(this.hideT);
    this.el.className = `on ${s}`;
    this.el.textContent = s === 'saving' ? 'Saving…' : s === 'saved' ? 'Saved' : s === 'failed' ? 'Save failed' : '';
    if (s !== 'saving') this.hideT = window.setTimeout(() => { this.el.className = s; }, s === 'failed' ? 3500 : 1600);
  }
}
