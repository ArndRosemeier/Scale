/**
 * Power HUD: hotbar (8 slots with icon, key, cooldown sweep, selection), energy bar,
 * super-jump charge, karma balance, a small mode chip, and toasts for awards and events.
 */
import type { AbilitySystem } from '../game/abilities/AbilitySystem';
import { ABILITY, ABILITIES, HOTBAR_SLOTS } from '../game/abilities/defs';

export type ToastKind = 'karma' | 'info' | 'warn' | 'core' | 'deny';

export class PowerHud {
  private root: HTMLDivElement;
  private slots: HTMLDivElement[] = [];
  private energyFill: HTMLDivElement;
  private energyText: HTMLSpanElement;
  private chargeFill: HTMLDivElement;
  private karmaEl: HTMLDivElement;
  private toasts: HTMLDivElement;
  private chip: HTMLDivElement;
  private shown = '';
  private lastE = '';
  private lastTrend = '';
  private lastDeny = '';
  private lastDenyT = 0;

  constructor(private abilities: AbilitySystem) {
    const sandbox = abilities.progress.sandbox;
    this.root = document.createElement('div');
    this.root.id = 'powerbar';
    this.root.innerHTML = `
      <div class="pb-top">
        <div class="pb-energy" title="Energy"><div class="pb-efill"></div><div class="pb-charge"></div><span class="pb-etext"></span></div>
        <div class="pb-karma" title="Karma — earned by good deeds, spent on powers (P)"></div>
      </div>
      <div class="pb-slots"></div>`;
    document.body.appendChild(this.root);
    const q = <T extends Element>(s: string) => this.root.querySelector(s) as T;
    this.energyFill = q('.pb-efill');
    this.energyText = q('.pb-etext');
    this.chargeFill = q('.pb-charge');
    this.karmaEl = q('.pb-karma');
    this.karmaEl.style.display = sandbox ? 'none' : '';
    const bar = q<HTMLDivElement>('.pb-slots');
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const s = document.createElement('div');
      s.className = 'pslot';
      // Clickable with the cursor or a finger: tap powers fire, held powers run while it is down.
      s.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); this.abilities.click(i); });
      s.addEventListener('contextmenu', (e) => e.preventDefault());
      bar.appendChild(s);
      this.slots.push(s);
    }
    this.toasts = document.createElement('div');
    this.toasts.id = 'toasts';
    document.body.appendChild(this.toasts);
    this.chip = document.createElement('div');
    this.chip.id = 'modechip';
    this.chip.className = sandbox ? 'sandbox' : 'normal';
    this.chip.textContent = sandbox ? 'Sandbox' : 'Normal';
    this.chip.title = sandbox ? 'Sandbox mode: every power at full strength' : 'Normal mode: earn karma with good deeds, buy powers with P';
    document.body.appendChild(this.chip);
    abilities.progress.onChange.push(() => { this.shown = ''; });
  }

  toast(html: string, kind: ToastKind = 'info', ms = 4200): void {
    if (kind === 'deny') {
      // Refusals repeat quickly (holding a key): one at a time.
      const now = performance.now();
      if (html === this.lastDeny && now - this.lastDenyT < 2500) return;
      this.lastDeny = html; this.lastDenyT = now;
    }
    const d = document.createElement('div');
    d.className = `toast ${kind}`;
    d.innerHTML = html;
    this.toasts.appendChild(d);
    while (this.toasts.children.length > 4) this.toasts.firstElementChild!.remove();
    requestAnimationFrame(() => d.classList.add('in'));
    setTimeout(() => { d.classList.remove('in'); d.classList.add('out'); setTimeout(() => d.remove(), 500); }, ms);
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
  }

  update(): void {
    const a = this.abilities, pr = a.progress;
    // Slots: rebuild the content only on change.
    const key = `${pr.slots.join(',')}|${a.selected}|${pr.karma}|${ABILITIES.map((d) => pr.rank(d.id)).join('')}`;
    if (key !== this.shown) {
      this.shown = key;
      this.slots.forEach((el, i) => {
        const id = pr.slots[i];
        const def = id ? ABILITY[id] : null;
        el.classList.toggle('sel', i === a.selected);
        el.classList.toggle('empty', !def);
        el.classList.toggle('locked', !!def && !pr.unlocked(def.id));
        el.innerHTML = `<span class="k">${(i + 1) % 10}</span>${def ? `<span class="ic">${def.icon}</span><span class="cd"></span>` : ''}`;
        el.title = def ? `${def.name}${pr.unlocked(def.id) ? ` (rank ${pr.rank(def.id)})` : ' (locked)'}` : 'Empty slot — assign a power with P';
      });
      this.karmaEl.innerHTML = `<b>${pr.karma}</b> karma`;
    }
    // Cooldown sweeps and the active flight state.
    this.slots.forEach((el, i) => {
      const id = pr.slots[i];
      if (!id) return;
      const c = a.cooldown.get(id);
      const f = c ? Math.max(0, c.left / c.full) : 0;
      const cd = el.querySelector<HTMLSpanElement>('.cd');
      if (cd) cd.style.setProperty('--f', String(f));
      el.classList.toggle('cooling', f > 0);
      el.classList.toggle('on', a.active(id));
    });
    const trend = a.energyRate < -0.05 ? 'drain' : a.energyRate < 0.05 && a.energy < a.maxEnergy ? 'hold' : '';
    if (trend !== this.lastTrend) {
      this.lastTrend = trend;
      this.energyFill.classList.toggle('drain', trend === 'drain');
      this.energyFill.classList.toggle('hold', trend === 'hold');
      this.energyFill.parentElement!.title = trend === 'drain' ? 'Energy — your giant size is draining it' : trend === 'hold' ? 'Energy — not recovering (flying, or your size eats the regeneration)' : 'Energy';
    }
    const e = `${Math.floor(a.energy)}/${Math.round(a.maxEnergy)}|${a.charge.toFixed(2)}`;
    if (e !== this.lastE) {
      this.lastE = e;
      this.energyFill.style.width = `${(a.energy / a.maxEnergy) * 100}%`;
      this.energyText.textContent = pr.sandbox ? '∞' : `${Math.floor(a.energy)}`;
      this.chargeFill.style.width = a.charge >= 0 ? `${a.charge * 100}%` : '0%';
      this.chargeFill.style.opacity = a.charge >= 0 ? '1' : '0';
    }
  }
}
