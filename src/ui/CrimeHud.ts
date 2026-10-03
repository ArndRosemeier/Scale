/**
 * HUD of the street-crime layer: a health bar in the power bar (above energy; hidden while full
 * and calm), a small reputation chip next to karma, wanted stars, a red vignette when hurt, the
 * knock-out fade, and a small red caret over a fleeing criminal within 80 m (show, don't tell:
 * no text, no objective).
 */
import * as THREE from 'three';
import type { Game } from '../game/Game';
import type { CrimeSystem } from '../game/crime/CrimeSystem';

const _p = new THREE.Vector3();

export class CrimeHud {
  private hp: HTMLDivElement;
  private hpFill: HTMLDivElement;
  private rep: HTMLDivElement;
  private wanted: HTMLDivElement;
  private vignette: HTMLDivElement;
  private fadeEl: HTMLDivElement;
  private carets: HTMLDivElement[] = [];
  private last = '';
  private shownHp = -1;

  constructor(private g: Game, private sys: CrimeSystem) {
    const top = document.querySelector('#powerbar .pb-top') ?? document.body;
    this.hp = document.createElement('div');
    this.hp.className = 'pb-health';
    this.hp.title = 'Health — regenerates out of combat';
    this.hp.innerHTML = '<div class="pb-hfill"></div>';
    this.hpFill = this.hp.firstElementChild as HTMLDivElement;
    this.rep = document.createElement('div');
    this.rep.className = 'pb-rep';
    this.wanted = document.createElement('div');
    this.wanted.className = 'pb-wanted';
    this.wanted.title = 'The police are after you — get away, or turn yourself in (E next to an officer)';
    top.prepend(this.hp);
    top.append(this.rep, this.wanted);
    this.vignette = document.createElement('div');
    this.vignette.id = 'hurtvig';
    this.fadeEl = document.createElement('div');
    this.fadeEl.id = 'kofade';
    document.body.append(this.vignette, this.fadeEl);
    for (let i = 0; i < 4; i++) {
      const c = document.createElement('div');
      c.className = 'crimecaret';
      document.body.appendChild(c);
      this.carets.push(c);
    }
  }

  fade(on: boolean): void {
    this.fadeEl.classList.toggle('on', on);
  }

  update(_dt: number): void {
    const s = this.sys, H = s.health;
    // Health: shown when not full, in a fight, or vulnerable and hurt recently.
    const frac = Math.max(0, Math.min(1, H.frac));
    const show = !H.invulnerable && (frac < 0.999 || H.inCombat);
    const pct = Math.round(frac * 100);
    if (pct !== this.shownHp || this.hp.classList.contains('show') !== show) {
      this.shownHp = pct;
      this.hp.classList.toggle('show', show);
      this.hpFill.style.width = `${pct}%`;
      this.hp.classList.toggle('low', frac < 0.3);
    }
    this.vignette.style.opacity = String(Math.min(0.85, H.flash * 0.6 + (show ? Math.max(0, 0.35 - frac) * 1.4 : 0)));
    // Reputation and wanted.
    const r = Math.round(s.rep.value);
    const w = s.justice.wanted;
    const key = `${r}|${w}|${this.g.mode}`;
    if (key !== this.last) {
      this.last = key;
      this.rep.innerHTML = `<b>${r > 0 ? '+' : ''}${r}</b> rep`;
      this.rep.title = `Reputation: ${s.rep.label()} — what the city thinks of you (good deeds raise it, hurting people lowers it)`;
      this.rep.className = `pb-rep ${r >= 30 ? 'good' : r <= -30 ? 'bad' : ''}`;
      this.rep.style.display = this.g.mode === 'sandbox' && r === 0 ? 'none' : '';
      this.wanted.innerHTML = w > 0 ? '★'.repeat(w) + '<i>' + '★'.repeat(3 - w) + '</i>' : '';
      this.wanted.style.display = w > 0 ? '' : 'none';
    }
    // Carets over fleeing criminals.
    const cam = this.g.renderer.camera, W = window.innerWidth, Hh = window.innerHeight;
    let n = 0;
    for (const a of s.fleeing()) {
      if (n >= this.carets.length) break;
      _p.set(a.x, a.y + 2.25, a.z).project(cam);
      if (_p.z > 1 || Math.abs(_p.x) > 1 || Math.abs(_p.y) > 1) continue;
      const el = this.carets[n++];
      el.style.display = 'block';
      el.style.transform = `translate(${((_p.x * 0.5 + 0.5) * W - 6).toFixed(1)}px, ${((-_p.y * 0.5 + 0.5) * Hh - 10).toFixed(1)}px)`;
    }
    for (; n < this.carets.length; n++) this.carets[n].style.display = 'none';
  }
}
