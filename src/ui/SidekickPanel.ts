/**
 * The sidekick's info panel: click (or tap) your sidekick and a small see-through card shows
 * above the target frame with who they are, how they are, their trust and karma and the powers
 * they have learned with their levels. It goes with the target (Esc, another click).
 */
import type { Targeting } from '../game/Targeting';
import type { Sidekick } from '../game/sidekick/Sidekick';
import type { MatePanel } from '../game/sidekick/Companion';

const DOING: Record<MatePanel['mode'], string> = {
  around: 'Around you', fight: 'Fighting', back: 'On the way back', down: 'Knocked out',
  ward: 'In hospital', home: 'At home', gone: '',
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export class SidekickPanel {
  private el: HTMLDivElement;
  private shown = false;
  private last = '';

  constructor(private targeting: Targeting, private sidekick: Sidekick) {
    this.el = document.createElement('div');
    this.el.id = 'mate-panel';
    document.body.append(this.el);
  }

  setVisible(v: boolean): void {
    if (!v && this.shown) { this.el.style.display = 'none'; this.shown = false; this.last = ''; }
  }

  update(): void {
    const t = this.targeting.current, m = this.sidekick.mate;
    const on = !!t && t.kind === 'person' && this.sidekick.phase === 'bonded' && m.a !== null && t.obj === m.a;
    if (!on) { this.setVisible(false); return; }
    if (!this.shown) { this.el.style.display = 'block'; this.shown = true; }
    // Above the target frame, whatever its height.
    const fr = document.getElementById('tframe');
    const above = fr && fr.offsetHeight ? fr.offsetHeight + 24 : 16;
    if (this.el.style.bottom !== `${above}px`) this.el.style.bottom = `${above}px`;
    const p = m.panel();
    const key = JSON.stringify(p);
    if (key === this.last) return;
    this.last = key;
    const doing = p.away === 'hold' && (p.mode === 'around' || p.mode === 'back') ? 'Keeping back' : (p.flying && p.mode !== 'fight' ? 'Flying' : DOING[p.mode]);
    const hp = Math.max(0, Math.min(1, p.hp / Math.max(1, p.maxHp)));
    const pips = (r: number, n: number) => n > 1 ? `<span class="pips">${'<i class="on"></i>'.repeat(r)}${'<i></i>'.repeat(n - r)}</span>` : '<span class="pips"><i class="on"></i></span>';
    const rows = p.powers.map((w) => `<div class="pw"><span>${esc(w.name)}${w.first ? ' <em>shard gift</em>' : ''}</span>${pips(w.rank, w.max)}</div>`).join('');
    this.el.innerHTML =
      `<div class="hd"><b>${esc(p.name)}</b><span class="tag">Sidekick</span></div>` +
      `<div class="sub">${esc(p.temper)} · flies · ${doing}</div>` +
      `<div class="bar"><span>Health</span><div class="meter hp"><div style="width:${Math.round(hp * 100)}%"></div></div><span class="n">${p.hp}/${p.maxHp}</span></div>` +
      `<div class="bar"><span>Trust</span><div class="meter tr"><div style="width:${p.trust}%"></div></div><span class="n">${p.trust}</span></div>` +
      `<div class="tw">${esc(p.trustWord)}</div>` +
      `<div class="kr">Karma <b>${p.karma}</b>${p.want ? ` · saving for ${esc(p.want)}${p.wantCost !== null ? ` (${p.wantCost})` : ''}${p.wished ? ', your wish' : ''}` : ''}</div>` +
      `<div class="pws">${rows || '<div class="pw none">No powers yet</div>'}</div>`;
  }
}
