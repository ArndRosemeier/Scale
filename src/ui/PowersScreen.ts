/**
 * Powers screen (P): every ability with icon, description, rank pips and effects;
 * buying unlocks and ranks with karma (Normal) or trying any rank (Sandbox); hotbar
 * assignment by drag and drop, by clicking a power and then a slot, or by hovering a
 * power and pressing 1–8. Like the map, it owns keyboard and mouse while open.
 */
import type { Game } from '../game/Game';
import type { AbilitySystem } from '../game/abilities/AbilitySystem';
import { ABILITIES, ABILITY, HOTBAR_SLOTS, GROUP_NAMES, type AbilityId } from '../game/abilities/defs';
import { KARMA } from '../game/abilities/tuning';

export class PowersScreen {
  open = false;
  private root: HTMLDivElement;
  private list: HTMLDivElement;
  private bar: HTMLDivElement;
  private karmaEl: HTMLDivElement;
  private foot: HTMLDivElement;
  private picked: AbilityId | null = null;
  private hovered: AbilityId | null = null;
  private closedAt = -1e9;
  private confirmReset = 0;
  /** Extra footer info (power cores found). */
  info: () => string = () => '';
  onBuy?: (id: AbilityId, rank: number) => void;
  /** A granted power's progress line (how far to the next rank), or null. */
  grantInfo: ((id: AbilityId) => string | null) | null = null;

  get holdsPointer(): boolean { return this.open || performance.now() - this.closedAt < 400; }

  constructor(private game: Game, private abilities: AbilitySystem) {
    const sandbox = abilities.progress.sandbox;
    this.root = document.createElement('div');
    this.root.id = 'powers';
    this.root.innerHTML = `
      <div class="pw-panel">
        <div class="pw-head">
          <div>
            <div class="pw-title">Powers <span class="pw-mode ${sandbox ? 'sandbox' : 'normal'}">${sandbox ? 'Sandbox' : 'Normal'}</span></div>
            <div class="pw-sub">${sandbox ? 'Everything unlocked. Try any rank, put any power on any slot.' : 'Spend karma on any power you like. Good deeds earn more.'}</div>
          </div>
          <div class="pw-karma"></div>
          <button class="pw-close" title="Close (P / Esc)">×</button>
        </div>
        <div class="pw-list"></div>
        <div class="pw-hot">
          <div class="pw-hot-label">Hotbar <span>drag a power onto a slot · or click a power, then a slot · or hover a power and press 1–9, 0 · right-click a slot to clear · Tab picks a target</span></div>
          <div class="pw-slots"></div>
        </div>
        <div class="pw-foot"></div>
      </div>`;
    document.body.appendChild(this.root);
    const q = <T extends Element>(s: string) => this.root.querySelector(s) as T;
    this.list = q('.pw-list');
    this.bar = q('.pw-slots');
    this.karmaEl = q('.pw-karma');
    this.foot = q('.pw-foot');
    q<HTMLButtonElement>('.pw-close').onclick = () => this.toggle(false);
    this.root.addEventListener('pointerdown', (e) => { if (e.target === this.root) this.toggle(false); });
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    abilities.progress.onChange.push(() => { if (this.open) this.render(); });

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
      if (!this.open) {
        if (e.code === 'KeyP' && !e.repeat && this.game.player && !this.game.map?.open) { e.preventDefault(); e.stopImmediatePropagation(); this.toggle(true); }
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (e.code === 'KeyP' || e.code === 'Escape') { this.toggle(false); return; }
      const m = /^(Digit|Numpad)([0-9])$/.exec(e.code);
      const id = this.hovered ?? this.picked;
      const slot = m ? (Number(m[2]) + 9) % 10 : -1;
      if (m && id && ABILITY[id].kind === 'active' && slot < HOTBAR_SLOTS) { this.abilities.progress.assign(slot, id); this.flashSlot(slot); }
    }, true);
  }

  toggle(on = !this.open): void {
    if (on === this.open) return;
    this.open = on;
    this.root.classList.toggle('open', on);
    this.abilities.enabled = !on;
    if (on) {
      this.game.input.keys.clear();
      this.game.input.buttons = 0;
      if (document.pointerLockElement) document.exitPointerLock();
      this.game.menu?.close();
      this.picked = null;
      this.confirmReset = 0;
      this.render();
    } else {
      this.closedAt = performance.now();
    }
  }

  private render(): void {
    const pr = this.abilities.progress, sandbox = pr.sandbox;
    this.karmaEl.innerHTML = sandbox ? '' : `<b>${pr.karma}</b><span>karma</span>`;
    this.list.innerHTML = '';
    let group = '';
    const order = ['body', 'movement', 'elemental', 'support'];
    const sorted = ABILITIES.slice().sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
    for (const def of sorted) {
      if (def.group !== group) {
        group = def.group;
        const h = document.createElement('div');
        h.className = 'pw-group';
        h.textContent = GROUP_NAMES[def.group];
        this.list.appendChild(h);
      }
      const r = pr.rank(def.id);
      const cost = pr.nextCost(def.id);
      const card = document.createElement('div');
      card.className = `pw-card${r > 0 ? '' : ' locked'}${this.picked === def.id ? ' picked' : ''}`;
      card.draggable = def.kind === 'active' && r > 0;
      const pips = Array.from({ length: def.maxRank }, (_, i) => `<span class="pip${i < r ? ' on' : ''}"></span>`).join('');
      const tag = def.kind === 'passive' ? 'Passive' : def.trigger === 'toggle' ? 'Toggle' : def.trigger === 'hold' ? 'Hold' : 'Active';
      const now = r > 0 ? `<div class="pw-eff"><span>Now</span>${def.rankText(r)}</div>` : '';
      const next = r < def.maxRank ? `<div class="pw-eff next"><span>${r > 0 ? 'Next' : 'Unlock'}</span>${def.rankText(r + 1)}</div>` : '';
      const costLine = def.costText ? `<div class="pw-cost">${def.costText(Math.max(1, r))}</div>` : '';
      let action: string;
      if (sandbox) action = `<div class="pw-sb"><button data-act="down" ${r <= 0 ? 'disabled' : ''}>−</button><span>Rank ${r}</span><button data-act="up" ${r >= def.maxRank ? 'disabled' : ''}>+</button></div>`;
      else if (def.granted) action = `<button class="pw-buy max" disabled>${r >= def.maxRank ? 'Max rank' : r > 0 ? `Rank ${r}` : 'Not yet'}</button>`;
      else if (cost === null) action = `<button class="pw-buy max" disabled>Max rank</button>`;
      else action = `<button class="pw-buy${pr.karma >= cost ? '' : ' poor'}" data-act="buy" ${pr.karma >= cost ? '' : 'disabled'}>${r > 0 ? `Rank ${r + 1}` : 'Unlock'} <b>${cost}</b> karma</button>`;
      const slotIdx = pr.slots.indexOf(def.id);
      const where = def.kind === 'active' ? (slotIdx >= 0 ? `<span class="pw-slotnum">slot ${slotIdx + 1}</span>` : r > 0 ? '<span class="pw-slotnum none">not on the hotbar</span>' : '') : '';
      card.innerHTML = `
        <div class="pw-icon">${def.icon}</div>
        <div class="pw-body">
          <div class="pw-name">${def.name} <span class="pw-tag">${tag}${def.key ? ` · ${def.key}` : ''}</span>${where}</div>
          <div class="pw-desc">${def.desc}</div>
          ${now}${next}${costLine}
          ${def.granted && !sandbox ? `<div class="pw-how">${def.granted}${this.grantInfo?.(def.id) ? ` — ${this.grantInfo(def.id)}` : ''}</div>` : r > 0 || sandbox ? '' : `<div class="pw-how">Locked — earn karma by helping people (E next to someone who fell)</div>`}
        </div>
        <div class="pw-side"><div class="pw-pips">${pips}</div>${action}</div>`;
      card.onmouseenter = () => { this.hovered = def.id; };
      card.onmouseleave = () => { if (this.hovered === def.id) this.hovered = null; };
      card.onclick = (e) => {
        const act = (e.target as HTMLElement).closest('button')?.dataset.act;
        if (act === 'buy') {
          if (pr.buy(def.id)) { this.onBuy?.(def.id, pr.rank(def.id)); }
          return;
        }
        if (act === 'up' || act === 'down') { pr.setRank(def.id, r + (act === 'up' ? 1 : -1)); return; }
        if (def.kind === 'active' && pr.rank(def.id) > 0) { this.picked = this.picked === def.id ? null : def.id; this.render(); }
      };
      card.ondragstart = (e) => { e.dataTransfer?.setData('text/plain', def.id); card.classList.add('drag'); };
      card.ondragend = () => card.classList.remove('drag');
      this.list.appendChild(card);
    }
    // Hotbar slots.
    this.bar.innerHTML = '';
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const id = pr.slots[i];
      const def = id ? ABILITY[id] : null;
      const s = document.createElement('div');
      s.className = `pw-slot${def ? '' : ' empty'}${this.picked ? ' target' : ''}`;
      s.innerHTML = `<span class="k">${(i + 1) % 10}</span>${def ? `<span class="ic">${def.icon}</span><span class="nm">${def.name}</span>` : '<span class="nm">empty</span>'}`;
      s.draggable = !!def;
      s.ondragstart = (e) => { if (def) e.dataTransfer?.setData('text/plain', def.id); };
      s.ondragover = (e) => { e.preventDefault(); s.classList.add('over'); };
      s.ondragleave = () => s.classList.remove('over');
      s.ondrop = (e) => {
        e.preventDefault();
        const did = e.dataTransfer?.getData('text/plain') as AbilityId;
        if (did && ABILITY[did]?.kind === 'active' && pr.unlocked(did)) pr.assign(i, did);
      };
      s.onclick = () => { if (this.picked) { pr.assign(i, this.picked); this.picked = null; this.render(); } };
      s.oncontextmenu = (e) => { e.preventDefault(); pr.assign(i, null); };
      this.bar.appendChild(s);
    }
    // Footer: how to earn karma, cores, reset.
    const info = this.info();
    this.foot.innerHTML = `
      <div class="pw-tips">${sandbox ? 'Sandbox: energy is unlimited; cooldowns are short. <b>B</b> fires a test blast.' : `Earn karma: help people who fell or were hurt (<b>E</b>) · +${KARMA.helpUp} each. ${info}`}</div>
      <button class="pw-reset">${sandbox ? 'Reset to defaults' : this.confirmReset ? 'Click again to erase all progress' : 'Reset progress…'}</button>`;
    const rb = this.foot.querySelector<HTMLButtonElement>('.pw-reset')!;
    rb.classList.toggle('danger', this.confirmReset > 0);
    rb.onclick = () => {
      if (!sandbox && !this.confirmReset) { this.confirmReset = 1; this.render(); return; }
      this.confirmReset = 0;
      pr.reset();
    };
  }

  private flashSlot(i: number): void {
    const el = this.bar.children[i] as HTMLElement | undefined;
    if (!el) return;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 400);
  }
}
