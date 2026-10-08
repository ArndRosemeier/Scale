/**
 * Help dialog (H, or "Help" in the pause menu) with three tabs:
 *  - Keys: the controls in groups, every game key reassignable (keybinds.ts), reset to defaults;
 *    on a touch screen the on-screen controls come first.
 *  - Powers: every power with its exact numbers per rank, read from the same tables the game
 *    uses (defs.ts rankText / costText, tuning.ts), so they cannot drift from the code.
 *  - Manual: the player's manual (public/manual/manual.html), loaded when the tab is first opened.
 */
import type { Game } from '../game/Game';
import {
  KEY_ACTION, KEY_ACTIONS, KEY_GROUPS, bindingOf, gameCodeOf, bind, canBind, isDefaultBinding, keyName, keyLabel, powerKeyText, resetKeys, type KeyAction,
} from '../game/keybinds';
import { ABILITIES, GROUP_NAMES, hasSenseOption, senseCost, type AbilityGroup, type AbilityId } from '../game/abilities/defs';
import { powerDamage } from '../game/abilities/damage';
import { COMBAT } from '../game/Combat';
import { MUGGING } from '../game/crime/Mugging';
import { ROBBERY } from '../game/crime/Robbery';
import { LIEUTENANT } from '../game/crime/Crime';
import { BOSS } from '../game/factions/Bosses';
import { STRIDER } from '../game/threats/Strider';
import { TREE } from '../game/threats/AwakenedTree';
import { ENERGY, GIANT, KARMA, KARMA_COST, sizeUpkeep } from '../game/abilities/tuning';
import { isTouch } from './touch';
import { esc } from './esc';

export type HelpTab = 'keys' | 'powers' | 'manual';

/** On a touch screen (iPad): the on-screen controls (TouchControls). */
const TOUCH_CONTROLS: [string, string][] = [
  ['Left thumb', 'Walk where the thumb lands · push to the rim to run (in flight: boost), barely push to walk slowly'],
  ['Drag on the right', 'Look around · pinch: camera distance'],
  ['Tap', 'On someone or something: target it · on an elevator button: press it'],
  ['Jump', 'Jump · with super jump: hold to keep climbing (in flight: Up, hold)'],
  ['Fly / Land · Down', 'Toggle flight (when unlocked) · sink while flying'],
  ['Use', 'Lights up when there is something to do: help someone up, pick up, open a manhole … (hold to dig)'],
  ['Target · ✕', 'Pick a target near the centre / cycle · clear it'],
  ['Auto', 'Autorun / autoflight on / off · moving the stick forward or back stops it'],
  ['+  −', 'Grow / shrink (with size shift)'],
  ['Hotbar', 'Tap a power; hold for beams, jets, ice path; super speed switches on / off'],
  ['Powers · Map · ⋯ · ☰', 'Buy powers · city map (pinch to zoom) · more (rally, airstrike, time of day …) · pause & settings'],
];

/** Mouse and the keys that cannot be moved. */
const FIXED: [string, string][] = [
  ['Right mouse (hold)', 'Look around'],
  ['Mouse wheel', 'Camera distance'],
  ['Left click', 'On someone or something: target it (punch is a hotbar power, slot 1 by default)'],
  ['Esc', 'Clear the target · close a screen · pause & settings'],
  ['1 … 7 in a talk', 'Pick an answer'],
  ['F4', 'Detailed info line (frame rate, position, streaming)'],
];

/** While a key button waits for a key: this sees every keydown first. Registered when the module
 *  loads, before the map, the powers screen and Input add theirs, so nothing else reacts. */
let capture: ((e: KeyboardEvent) => void) | null = null;
window.addEventListener('keydown', (e) => { if (capture && e.isTrusted) capture(e); }, true);

export class HelpDialog {
  readonly el: HTMLDivElement;
  private tab: HelpTab = 'keys';
  private body: Record<HelpTab, HTMLElement>;
  private notice = '';
  private waiting: { id: string; i: number } | null = null;
  private manualLoaded = false;

  constructor(private game: Game) {
    this.el = document.createElement('div');
    this.el.id = 'help';
    this.el.innerHTML = `
      <div class="panel help-panel" role="dialog" aria-label="Help">
        <div class="help-head">
          <div class="help-tabs" role="tablist">
            <button type="button" role="tab" data-tab="keys">Keys</button>
            <button type="button" role="tab" data-tab="powers">Powers</button>
            <button type="button" role="tab" data-tab="manual">Manual</button>
          </div>
          <button type="button" class="help-x" title="Close (H)">✕</button>
        </div>
        <div class="help-body" data-tab="keys"></div>
        <div class="help-body" data-tab="powers"></div>
        <div class="help-body help-manual" data-tab="manual"></div>
      </div>`;
    document.body.appendChild(this.el);
    const q = (t: HelpTab) => this.el.querySelector<HTMLElement>(`.help-body[data-tab="${t}"]`)!;
    this.body = { keys: q('keys'), powers: q('powers'), manual: q('manual') };
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('.help-tabs button')) b.onclick = () => this.show(b.dataset.tab as HelpTab);
    this.el.querySelector<HTMLButtonElement>('.help-x')!.onclick = () => this.toggle(false);
    // A click on the dimmed backdrop closes; clicks inside are not clicks in the game.
    this.el.addEventListener('pointerdown', (e) => { if (e.target === this.el) this.toggle(false); });
    for (const ev of ['mousedown', 'wheel', 'contextmenu'] as const) this.el.querySelector('.panel')!.addEventListener(ev, (e) => e.stopPropagation());
  }

  get isOpen(): boolean { return this.el.classList.contains('open'); }
  /** A key button is waiting for a key. */
  get capturing(): boolean { return this.waiting !== null; }

  toggle(v?: boolean): void {
    const on = v ?? !this.isOpen;
    if (!on) this.stopWaiting();
    this.el.classList.toggle('open', on);
    if (on) this.show(this.tab);
  }

  /** Open on a tab (or switch tabs while open). */
  show(tab: HelpTab): void {
    this.tab = tab;
    this.stopWaiting();
    if (!this.isOpen) this.el.classList.add('open');
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('.help-tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
    for (const [t, el] of Object.entries(this.body)) el.classList.toggle('on', t === tab);
    if (tab === 'keys') this.renderKeys();
    else if (tab === 'powers') this.renderPowers();
    else this.loadManual();
  }

  // ------------------------------------------------------------------ keys

  private renderKeys(): void {
    const keyBtn = (a: KeyAction, i: number) => {
      const c = bindingOf(a.id)[i];
      const w = this.waiting && this.waiting.id === a.id && this.waiting.i === i;
      const cls = `hk${w ? ' wait' : ''}${c ? '' : ' none'}`;
      return `<button type="button" class="${cls}" data-id="${a.id}" data-i="${i}" title="${i ? 'Second key' : 'Key'}: click, then press the new key">${w ? 'press…' : esc(keyName(c))}</button>`;
    };
    const groups = KEY_GROUPS.map((g) => `
      <div class="hk-group">
        <h3>${g.name}</h3>
        ${KEY_ACTIONS.filter((a) => a.group === g.id).map((a) => `
          <div class="hk-row"${a.info ? ` title="${esc(a.info)}"` : ''}>
            <div class="hk-label">${a.label}${a.info ? `<small>${a.info}</small>` : ''}</div>
            <div class="hk-keys">${keyBtn(a, 0)}${keyBtn(a, 1)}</div>
          </div>`).join('')}
      </div>`).join('');
    const fixed = `<div class="hk-group"><h3>Mouse and fixed keys</h3>${FIXED.map(([k, v]) => `<div class="hk-row"><div class="hk-label">${v}</div><div class="hk-keys"><span class="hk fixed">${k}</span></div></div>`).join('')}</div>`;
    const touch = isTouch() ? `<div class="hk-touch"><h3>On the screen</h3><table>${TOUCH_CONTROLS.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join('')}</table><h3>With a keyboard</h3></div>` : '';
    const state = this.waiting
      ? 'Press the new key · <b>Esc</b> cancels · <b>Backspace</b> clears this key'
      : this.notice || 'Click a key to change it. Each action can have two keys. Your keys are kept in this browser.';
    this.body.keys.innerHTML = `
      <div class="help-foot">
        <span class="hk-state">${state}</span>
        <button type="button" class="hk-reset" ${isDefaultBinding() ? 'disabled' : ''}>Reset to defaults</button>
      </div>${touch}
      <div class="hk-grid">${groups}${fixed}</div>
      <p class="sub">Normal mode: help people to earn karma and buy powers with ${keyLabel('powers') || 'the powers screen'}. Everything can be destroyed. People live their own days, and they notice what you do.</p>`;
    for (const b of this.body.keys.querySelectorAll<HTMLButtonElement>('button.hk')) {
      b.onclick = (e) => {
        e.stopPropagation();
        const id = b.dataset.id!, i = Number(b.dataset.i);
        if (this.waiting && this.waiting.id === id && this.waiting.i === i) { this.stopWaiting(); this.renderKeys(); return; }
        this.notice = '';
        this.waiting = { id, i };
        capture = (ev) => this.onCapture(ev);
        this.renderKeys();
      };
    }
    this.body.keys.querySelector<HTMLButtonElement>('.hk-reset')!.onclick = () => {
      resetKeys();
      this.notice = 'All keys are back to their defaults.';
      this.renderKeys();
    };
  }

  private onCapture(e: KeyboardEvent): void {
    e.preventDefault();
    e.stopImmediatePropagation();
    const w = this.waiting;
    if (!w || e.repeat) return;
    const a = KEY_ACTIONS.find((x) => x.id === w.id)!;
    if (e.code === 'Escape') { this.notice = ''; }
    else if (e.code === 'Backspace' || e.code === 'Delete') {
      bind(w.id, w.i, null);
      this.notice = `${a.label}: key cleared.`;
    } else if (!canBind(e.code)) {
      this.notice = `${keyName(e.code)} cannot be used: it keeps its own meaning.`;
    } else {
      const took = bind(w.id, w.i, e.code);
      this.notice = `${a.label}: ${keyName(e.code)}${took ? ` (taken from ${took}, which needs a new key)` : ''}.`;
    }
    this.stopWaiting();
    this.renderKeys();
  }

  private stopWaiting(): void {
    this.waiting = null;
    capture = null;
  }

  // ------------------------------------------------------------------ powers

  private renderPowers(): void {
    const pr = this.game.progress;
    const sandbox = pr?.sandbox ?? false;
    const fmt = (n: number) => String(Math.round(n * 10) / 10);
    const dmg = (id: AbilityId, rk: number) => {
      const v = powerDamage(id, id === 'punch' ? 0 : rk);
      return v ? `<div><b>People</b> ${v.people}</div><div><b>Creatures</b> ${v.creatures}</div>` : '—';
    };
    const groups = (Object.keys(GROUP_NAMES) as AbilityGroup[]).map((g) => {
      const cards = ABILITIES.filter((d) => d.group === g).map((d) => {
        const r = pr ? pr.rank(d.id) : 0;
        const prices = (KARMA_COST as Record<string, readonly number[]>)[d.id] ?? [];
        const tag = d.kind === 'passive' ? 'Passive' : d.trigger === 'toggle' ? 'Switch on / off' : d.trigger === 'hold' ? 'Hold' : 'Tap';
        const key = powerKeyText(d.id);
        const rows = Array.from({ length: d.maxRank }, (_, i) => {
          const rk = i + 1;
          const price = d.id === 'punch' ? 'free' : d.granted ? '—' : prices[i] !== undefined ? String(prices[i]) : '—';
          return `<tr class="${rk === r ? 'cur' : ''}"><td class="rk">${d.maxRank > 1 ? rk : '—'}</td><td class="kc">${price}</td><td>${d.rankText(rk)}</td><td class="dm">${dmg(d.id, rk)}</td><td class="en">${d.costText ? d.costText(rk) : 'none'}</td></tr>`;
        }).join('');
        return `
          <div class="hp-card">
            <div class="hp-head"><span class="hp-ic">${d.icon}</span><span class="hp-name">${d.name}</span><span class="hp-tag">${tag}${key ? ` · ${esc(key)}` : ''}</span>${r > 0 && d.maxRank > 1 ? `<span class="hp-you">your rank ${r}</span>` : ''}</div>
            <div class="hp-desc">${d.desc}${d.granted ? ` <i>${d.granted}.</i>` : ''}</div>
            <table class="hp-t"><thead><tr><th>Rank</th><th>Karma</th><th>Effect</th><th>Damage</th><th>Energy</th></tr></thead><tbody>${rows}</tbody></table>
            ${hasSenseOption(d.id) ? `<div class="hp-desc"><b>Friend/foe sense</b> (${senseCost(d.id)} karma, once the power is unlocked): it then hurts only foes (criminals still fighting, monsters, rogue machines) and leaves people, police, cars, props and buildings alone. A giant body loses it: above normal size the power hits everything again.${pr?.hasSense(d.id) ? ' <i>You have it.</i>' : ''}</div>` : ''}
          </div>`;
      }).join('');
      return `<h3 class="hp-group">${GROUP_NAMES[g]}</h3>${cards}`;
    }).join('');
    const up = (h: number) => fmt(sizeUpkeep(h));
    this.body.powers.innerHTML = `
      <div class="hp-facts">
        <div><b>Energy</b> ${ENERGY.max} at the start, refills ${ENERGY.regen} / s. Each power core: +${ENERGY.coreMax} max, +${ENERGY.coreRegen} / s.</div>
        <div><b>Flight</b> costs nothing, but energy does not refill in the air.</div>
        <div><b>Giant body</b> upkeep: free up to 1.8 m · ${up(5)} / s at 5 m · ${up(GIANT.even)} / s at ${GIANT.even} m · ${up(50)} / s at 50 m · ${up(GIANT.top)} / s at ${GIANT.top} m. Out of energy, you shrink back to ${GIANT.fallback} m.</div>
        <div><b>Damage</b> to <b>people</b> is the health they lose: a passer-by has ${COMBAT.civilianHp}, a mugger ${MUGGING.hp}, a robber ${ROBBERY.hp}; a lieutenant ×${LIEUTENANT.hp}, a boss ×${fmt(LIEUTENANT.hp * BOSS.hp)}. Most powers floor a person only once until they are back on their feet; punches on someone who is down do half. To <b>giant creatures</b> it is points before their armour: the Strider has ${STRIDER.hp} (an open weak spot takes ×${STRIDER.weakMul}), the awakened tree ${TREE.hp} (its heart ×${TREE.heartMul}; fire ×${TREE.fire}, lightning ×${TREE.shock}).</div>
        <div><b>Karma</b> ${KARMA.start} at the start · +${KARMA.helpUp} for helping someone up (+${KARMA.helpUpCollapse} after a collapse, nothing for someone you knocked down) · +${KARMA.coreKarma} from a karma core. Prices below are for reaching that rank.</div>
        ${sandbox ? '<div><b>Sandbox:</b> energy is unlimited and ranks are set freely in the powers screen.</div>' : ''}
        <div class="sub">Values are for a body of normal size (1.8 m); a bigger body hits harder and reaches farther. Your current rank is highlighted.</div>
      </div>
      ${groups}`;
  }

  // ------------------------------------------------------------------ manual

  private loadManual(): void {
    if (this.manualLoaded) return;
    this.manualLoaded = true;
    const base = import.meta.env.BASE_URL;
    this.body.manual.innerHTML = `
      <iframe class="help-iframe" title="Player's manual" src="${base}manual/manual.html"></iframe>
      <div class="help-foot"><span class="sub">The manual describes version 0.167; the Keys and Powers tabs are always current.</span>
        <a class="hm-pdf" href="${base}manual/Scale-Manual.pdf" target="_blank" rel="noopener">Open as PDF</a></div>`;
    // While the manual has the keyboard (after a click into it): Esc and the help key still close.
    const frame = this.body.manual.querySelector<HTMLIFrameElement>('iframe')!;
    frame.addEventListener('load', () => {
      try {
        frame.contentWindow?.addEventListener('keydown', (e) => {
          if (e.code === 'Escape' || gameCodeOf(e.code) === KEY_ACTION.help.defaults[0]) { e.preventDefault(); this.toggle(false); window.focus(); }
        });
      } catch { /* not reachable: the close button still works */ }
    });
  }
}
