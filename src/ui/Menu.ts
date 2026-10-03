/**
 * Pause menu (Esc / pointer released), help overlay (H) and settings.
 */
import type { Game } from '../game/Game';

const CONTROLS: [string, string][] = [
  ['W A S D', 'Walk (in flight: fly)'],
  ['Shift', 'Run / boost'],
  ['Space', 'Jump · hold to charge a super jump (in flight: up)'],
  ['Ctrl / C', 'Down (in flight)'],
  ['F', 'Toggle flight (when unlocked)'],
  ['Numpad + / −  (or = / −)', 'Grow / shrink (size shift; range grows with rank)'],
  ['1 … 8', 'Use a hotbar power (and select its slot)'],
  ['Right click', 'Use the selected hotbar power'],
  ['P', 'Powers: buy, upgrade, assign to the hotbar'],
  ['Mouse', 'Look around'],
  ['Mouse wheel', 'Camera distance'],
  ['Left click', 'Punch / push'],
  ['E', 'Help someone up · open a manhole / climb out of the sewer'],
  ['M', 'City map: metro, stations, travel'],
  ['N', 'Minimap on / off'],
  ['B', 'Test blast where you look (sandbox)'],
  ['T', 'Fast time on/off'],
  ['[  ]', 'Time of day −1 h / +1 h'],
  ['F8', 'Free camera'],
  ['H', 'This help'],
  ['Esc', 'Pause & settings'],
];

export class Menu {
  private el: HTMLDivElement;
  private help: HTMLDivElement;
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
        <div class="row"><label>Volume</label><input id="pVol" type="range" min="0" max="1" step="0.05"></div>
        <div class="row"><label>Shadows</label><input id="pShadow" type="checkbox"></div>
        <div class="row"><label>Render scale</label><select id="pScale"><option value="0.75">75%</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option></select></div>
        <div class="row"><label>Body size</label><span id="pSize"></span><button id="pReset">Normal size</button></div>
        <div class="buttons"><button id="pResume">Resume</button><button id="pHelp">Controls</button><button id="pNew">New city…</button></div>
      </div>`;
    document.body.appendChild(this.el);
    this.help = document.createElement('div');
    this.help.id = 'help';
    this.help.innerHTML = `<div class="panel"><h2>Controls</h2><table>${CONTROLS.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join('')}</table><p class="sub">Normal mode: help people to earn karma and buy powers with P. Everything can be destroyed. People live their own days — and they notice what you do.</p></div>`;
    document.body.appendChild(this.help);
    const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    $<HTMLSelectElement>('pTime').onchange = (e) => { game.sky.timeScale = Number((e.target as HTMLSelectElement).value); };
    $<HTMLInputElement>('pHour').oninput = (e) => { game.sky.hour = Number((e.target as HTMLInputElement).value) % 24; this.sync(); };
    $<HTMLInputElement>('pVol').oninput = (e) => game.audio.setVolume(Number((e.target as HTMLInputElement).value));
    $<HTMLInputElement>('pShadow').onchange = (e) => { game.renderer.gl.shadowMap.enabled = (e.target as HTMLInputElement).checked; game.renderer.scene.traverse((o) => { const m = (o as { material?: { needsUpdate: boolean } }).material; if (m) m.needsUpdate = true; }); };
    $<HTMLSelectElement>('pScale').onchange = (e) => { game.renderer.gl.setPixelRatio(Number((e.target as HTMLSelectElement).value) * (window.devicePixelRatio > 1 ? 1 : 1)); game.renderer.resize(); };
    $<HTMLButtonElement>('pReset').onclick = () => { game.player.height = 1.8; this.sync(); };
    $<HTMLButtonElement>('pResume').onclick = () => this.close();
    $<HTMLButtonElement>('pHelp').onclick = () => this.toggleHelp(true);
    $<HTMLButtonElement>('pNew').onclick = () => { location.href = location.pathname; };
    this.help.onclick = () => this.toggleHelp(false);
    let wasLocked = false;
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement) { wasLocked = true; this.close(); }
      else if (wasLocked && !this.open && !this.game.map?.holdsPointer && !this.game.powers?.holdsPointer) this.show(); // Esc released the mouse (not the map opening)
    });
    window.addEventListener('keydown', (e) => {
      // (Esc that just closed the map or the powers screen does not open the pause menu.)
      if (e.code === 'Escape' && !this.game.map?.holdsPointer && !this.game.powers?.holdsPointer) { if (this.open) this.close(); else this.show(); }
      if (e.code === 'KeyH') this.toggleHelp();
    });
    // First-time hint.
    const hint = document.createElement('div');
    hint.id = 'hint';
    hint.textContent = 'Click to look around · M for the map · H for controls · Esc for settings';
    document.body.appendChild(hint);
    setTimeout(() => hint.classList.add('fade'), 9000);
  }

  private sync(): void {
    const g = this.game;
    (document.getElementById('pTime') as HTMLSelectElement).value = String(g.sky.timeScale);
    (document.getElementById('pHour') as HTMLInputElement).value = String(g.sky.hour);
    const hh = Math.floor(g.sky.hour), mm = Math.floor((g.sky.hour - hh) * 60);
    document.getElementById('pHourV')!.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    (document.getElementById('pVol') as HTMLInputElement).value = String(g.audio.volume);
    (document.getElementById('pShadow') as HTMLInputElement).checked = g.renderer.gl.shadowMap.enabled;
    document.getElementById('pSize')!.textContent = `${g.player.height < 1 ? (g.player.height * 100).toFixed(0) + ' cm' : g.player.height.toFixed(1) + ' m'}`;
  }

  show(): void {
    this.open = true;
    this.sync();
    this.el.classList.add('open');
    if (document.pointerLockElement) document.exitPointerLock();
  }

  close(): void {
    this.open = false;
    this.el.classList.remove('open');
  }

  toggleHelp(v?: boolean): void {
    const on = v ?? !this.help.classList.contains('open');
    this.help.classList.toggle('open', on);
  }

  get paused(): boolean { return this.open; }
}
