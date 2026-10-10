/**
 * Pause menu (Esc / pointer released), help dialog (H: keys, powers, manual — HelpDialog) and settings.
 */
import type { Game } from '../game/Game';
import { versionLink } from './Changelog';
import { feedbackLink } from './Feedback';
import { manualLink } from './Manual';
import { SOUND_CATEGORIES, defaultMix, type SoundCategory } from '../audio/Audio';
import { saveTimeScale } from '../render/SkySystem';
import type { WeatherSetting } from '../render/Weather';
import type { QualitySetting } from '../render/Graphics';
import { probeGpu, maybeShowGpuHint } from './GpuHint';
import { isTouch } from './touch';
import { HelpDialog, type HelpTab } from './HelpDialog';
import { isAction, keyLabel } from '../game/keybinds';
import { clipStore, clipTime, exportClip, CLIP_MAX_S } from './Recorder';

export class Menu {
  private el: HTMLDivElement;
  readonly help: HelpDialog;
  private open = false;

  constructor(private game: Game) {
    this.el = document.createElement('div');
    this.el.id = 'pause';
    this.el.innerHTML = `
      <div class="panel">
        <h2>Paused</h2>
        <div class="row"><label>Time speed</label><select id="pTime">
          <option value="0">Stopped</option><option value="1">Real time</option><option value="20">20×</option><option value="60">60×</option><option value="600">600×</option>
        </select></div>
        <div class="row"><label>Time of day</label><input id="pHour" type="range" min="0" max="24" step="0.25"><span id="pHourV"></span></div>
        <div class="row"><label>Weather</label><select id="pWeather" title="Auto: the city's own weather, mostly sunny with clouds">
          <option value="auto">Auto</option><option value="clear">Clear</option><option value="fair">Fair</option><option value="cloudy">Cloudy</option><option value="rain">Rain</option><option value="storm">Storm</option><option value="fog">Fog</option>
        </select></div>
        <div class="row"><label>Volume</label><input id="pVol" type="range" min="0" max="1" step="0.05"></div>
        <div class="row"><label>Mute</label><input id="pMute" type="checkbox"></div>
        <div class="row"><label>Music</label><input id="pMusic" type="checkbox" title="Background music (its level is in the sound mix)"></div>
        <div class="row"><label>Sound mix</label><button type="button" id="pMixBtn" class="mix-btn">Adjust…</button></div>
        <div id="pMix" class="mix-panel"></div>
        <div class="row"><label>Graphics</label><select id="pGfx" title="Auto: adapts to your graphics card while you play (remembered per card)">
          <option value="auto">Auto</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="ultra">Ultra</option>
        </select><span id="pGfxV" class="sub"></span></div>
        <div class="row"><label>Render scale</label><select id="pScale" title="Auto: as the graphics level sets it">
          <option value="auto">Auto</option><option value="0.5">50%</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option>
        </select></div>
        <div class="row"><label>Body size</label><span id="pSize"></span><button id="pReset">Normal size</button></div>
        <div class="row"><label>Street crime</label><select id="pCrime" title="How often crimes happen near you (depends on the district and the hour)">
          <option value="off">Off</option><option value="calm">Calm</option><option value="normal">Normal</option><option value="chaos">Chaos</option>
        </select></div>
        <div class="row"><label>City events</label><select id="pEvents" title="How often the city is hit by events (rogue robots and, later, worse); they are heralded by strange signs first">
          <option value="off">Off</option><option value="rare">Rare</option><option value="normal">Normal</option><option value="frequent">Frequent</option>
        </select></div>
        <div class="row"><label>Video clip</label><span id="pClip" class="sub"></span><button type="button" id="pClipExport" title="Save the last recorded clip as a file">Export</button></div>
        <div class="row" id="pInvRow"><label>Invulnerable</label><input id="pInv" type="checkbox"></div>
        <div class="buttons"><button id="pResume">Resume</button><button id="pHelp">Help</button><button id="pNew">New city…</button></div>
      </div>`;
    const ver = versionLink();
    this.el.querySelector('h2')?.after(ver);
    const fb = feedbackLink();
    ver.after(fb);
    fb.after(manualLink());
    document.body.appendChild(this.el);
    this.help = new HelpDialog(game);
    const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    $<HTMLSelectElement>('pTime').onchange = (e) => { game.sky.timeScale = Number((e.target as HTMLSelectElement).value); saveTimeScale(game.sky.timeScale); };
    $<HTMLInputElement>('pHour').oninput = (e) => { game.sky.hour = Number((e.target as HTMLInputElement).value) % 24; this.sync(); };
    $<HTMLSelectElement>('pWeather').onchange = (e) => { game.weather?.set((e.target as HTMLSelectElement).value as WeatherSetting); };
    $<HTMLInputElement>('pVol').oninput = (e) => { game.audio.setVolume(Number((e.target as HTMLInputElement).value)); this.sync(); };
    $<HTMLInputElement>('pMute').onchange = (e) => game.audio.setMuted((e.target as HTMLInputElement).checked);
    $<HTMLInputElement>('pMusic').onchange = (e) => game.audio.setMusicOn((e.target as HTMLInputElement).checked);
    // Sound mix: one slider per category (0–150 %, 100 % = as designed), and a reset.
    const mix = $<HTMLDivElement>('pMix');
    mix.innerHTML = SOUND_CATEGORIES.map((c) => `<div class="mix-row"><span>${c.name}</span><input type="range" min="0" max="1.5" step="0.05" data-cat="${c.id}"><b></b></div>`).join('')
      + '<div class="mix-foot"><span class="sub">100 % is the normal level (music starts at 65 %)</span><button type="button" class="mix-reset">Reset all</button></div>';
    const syncMix = () => {
      for (const inp of mix.querySelectorAll<HTMLInputElement>('input[data-cat]')) {
        const v = game.audio.mix[inp.dataset.cat as SoundCategory];
        inp.value = String(v);
        inp.nextElementSibling!.textContent = `${Math.round(v * 100)} %`;
      }
    };
    for (const inp of mix.querySelectorAll<HTMLInputElement>('input[data-cat]')) inp.oninput = () => { game.audio.setMix(inp.dataset.cat as SoundCategory, Number(inp.value)); syncMix(); };
    mix.querySelector<HTMLButtonElement>('.mix-reset')!.onclick = () => { for (const c of SOUND_CATEGORIES) game.audio.setMix(c.id, defaultMix(c.id)); syncMix(); };
    $<HTMLButtonElement>('pMixBtn').onclick = () => { syncMix(); mix.classList.toggle('open'); };
    $<HTMLSelectElement>('pGfx').onchange = (e) => { game.graphics.set((e.target as HTMLSelectElement).value as QualitySetting); this.sync(); };
    $<HTMLSelectElement>('pScale').onchange = (e) => { const v = (e.target as HTMLSelectElement).value; game.graphics.setScale(v === 'auto' ? null : Number(v)); };
    game.graphics.onChange = (level) => {
      if (this.open) this.sync();
      // Auto had to go down to Low: the browser may be on the wrong GPU.
      if (level.shadows === false) void probeGpu(game.graphics.gpu).then((p) => maybeShowGpuHint(p, true));
    };
    $<HTMLButtonElement>('pReset').onclick = () => { game.player.height = 1.8; this.sync(); };
    $<HTMLSelectElement>('pCrime').onchange = (e) => { if (game.crime) game.crime.setting = (e.target as HTMLSelectElement).value as typeof game.crime.setting; };
    $<HTMLSelectElement>('pEvents').onchange = (e) => { if (game.threats) game.threats.setting = (e.target as HTMLSelectElement).value as typeof game.threats.setting; };
    $<HTMLInputElement>('pInv').onchange = (e) => { if (game.crime) { game.crime.health.invulnerable = (e.target as HTMLInputElement).checked; if (game.crime.health.invulnerable) game.crime.health.reset(); } };
    $<HTMLButtonElement>('pClipExport').onclick = () => void exportClip().then((ok) => { if (!ok) this.syncClip(); });
    $<HTMLButtonElement>('pResume').onclick = () => this.close();
    $<HTMLButtonElement>('pHelp').onclick = () => this.toggleHelp(true);
    $<HTMLButtonElement>('pNew').onclick = () => { location.href = location.pathname; };
    // Looking around (right mouse) closes the menu.
    document.addEventListener('pointerlockchange', () => { if (document.pointerLockElement) this.close(); });
    window.addEventListener('keydown', (e) => {
      // (Esc that just closed the map or the powers screen does not open the pause menu.)
      // (With a target, Esc first clears the target — Targeting — and opens the menu next time.)
      // Esc closes the help dialog first.
      if (e.code === 'Escape' && this.help.isOpen) { e.preventDefault(); this.toggleHelp(false); return; }
      if (e.code === 'Escape' && !this.game.map?.holdsPointer && !this.game.powers?.holdsPointer && !this.game.people?.holdsPointer && !this.game.wardrobe?.holdsPointer) { if (this.open) this.close(); else if (!this.game.targeting?.current) this.show(); }
      if (isAction(e, 'help') && !e.repeat) this.toggleHelp();
    });
    // First-time hint.
    const hint = document.createElement('div');
    hint.id = 'hint';
    hint.textContent = isTouch()
      ? 'Left thumb walks · drag on the right to look · tap someone to target them · ☰ for settings and controls'
      : `Hold right mouse to look around · click someone to target them · ${keyLabel('map')} for the map · ${keyLabel('help')} for help and keys · Esc for settings`;
    document.body.appendChild(hint);
    setTimeout(() => hint.classList.add('fade'), 9000);
  }

  private sync(): void {
    const g = this.game;
    (document.getElementById('pTime') as HTMLSelectElement).value = String(g.sky.timeScale);
    (document.getElementById('pHour') as HTMLInputElement).value = String(g.sky.hour);
    // (Drizzle / overcast, set from the console, show as their nearest menu entry.)
    if (g.weather) { const s = g.weather.setting; (document.getElementById('pWeather') as HTMLSelectElement).value = s === 'drizzle' ? 'rain' : s === 'overcast' ? 'cloudy' : s; }
    const hh = Math.floor(g.sky.hour), mm = Math.floor((g.sky.hour - hh) * 60);
    document.getElementById('pHourV')!.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    (document.getElementById('pVol') as HTMLInputElement).value = String(g.audio.volume);
    (document.getElementById('pMute') as HTMLInputElement).checked = g.audio.muted;
    (document.getElementById('pMusic') as HTMLInputElement).checked = g.audio.musicOn;
    const gfx = g.graphics;
    (document.getElementById('pGfx') as HTMLSelectElement).value = gfx.setting;
    document.getElementById('pGfxV')!.textContent = gfx.auto ? gfx.level.name : '';
    document.getElementById('pGfxV')!.title = gfx.gpu;
    (document.getElementById('pScale') as HTMLSelectElement).value = gfx.scaleOverride === null ? 'auto' : String(gfx.scaleOverride);
    if (g.crime) {
      (document.getElementById('pCrime') as HTMLSelectElement).value = g.crime.setting;
      (document.getElementById('pInv') as HTMLInputElement).checked = g.crime.health.invulnerable;
      // Invulnerability is a sandbox toggle (Normal mode: the player can be hurt).
      document.getElementById('pInvRow')!.style.display = g.mode === 'sandbox' ? '' : 'none';
    }
    if (g.threats) (document.getElementById('pEvents') as HTMLSelectElement).value = g.threats.setting;
    document.getElementById('pSize')!.textContent = `${g.player.height < 1 ? (g.player.height * 100).toFixed(0) + ' cm' : g.player.height.toFixed(1) + ' m'}`;
  }

  /** The pause menu's clip row: the stored clip, or how to record one. */
  syncClip(): void {
    const info = document.getElementById('pClip')!, btn = document.getElementById('pClipExport') as HTMLButtonElement;
    const none = () => {
      info.textContent = `None yet: ${keyLabel('record') || 'the Record key'} records up to ${CLIP_MAX_S} s`;
      btn.disabled = true;
    };
    void clipStore.get().then((c) => {
      if (!c) { none(); return; }
      const d = new Date(c.at);
      info.textContent = `${clipTime(c.ms)}, ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      btn.disabled = false;
    }, none);
  }

  show(): void {
    this.open = true;
    this.sync();
    this.syncClip();
    this.el.classList.add('open');
    if (document.pointerLockElement) document.exitPointerLock();
  }

  close(): void {
    this.open = false;
    this.el.classList.remove('open');
  }

  toggleHelp(v?: boolean): void {
    this.help.toggle(v);
  }

  /** Open the help dialog on a tab. */
  showHelp(tab: HelpTab): void {
    this.help.show(tab);
  }

  get paused(): boolean { return this.open; }
}
