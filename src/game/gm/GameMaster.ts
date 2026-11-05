/**
 * The game master (GAME_MASTER_PLAN §2, phase 2): it reads what the city's systems are doing and
 * decides what of it reaches the player, when. It never shows its hand: what it does looks like the
 * city's own life. Its moves go through the existing systems (the crime system's budget and rules),
 * never by moving people about.
 *
 * Tools so far, cheapest first per need:
 *   rumour      (story)      people asked for the news pass on where the followed group hides out
 *   group-crime (challenge, story)  one of the followed group's own operations near the hero, in
 *                             its turf, so one gang's story keeps coming back where the hero plays
 * and the signs (gm/Signs, phase 3): boss operations cased before they happen, calling cards after
 * the hero hurt a group, witnesses of a crime that got away.
 *
 * Normal mode only (like the tracker). Saved per city in the browser and in save files (SaveData.gm).
 * The developer panel (dev.gm.panel(), admin console "Game master") shows its moves and why.
 */
import type { Game } from '../Game';
import { Director, GM, NEEDS, followedGroup, hideoutRumour, type GmMove, type Need } from './director';
import { hideoutCell } from '../factions/Hideouts';
import { deriveSeed, hashToFloat, hash32 } from '../../core/rng';
import { clueTime } from '../story/knowledge';
import { esc } from '../../ui/esc';
import { Signs } from './Signs';
import type { Faction } from '../factions/Factions';
import type { Crime } from '../crime/Crime';
import type { Lookout } from '../crime/Lookout';
import type { PedAgent } from '../../sim/Pedestrians';

const STORE = (g: Game) => `scale.gm.v1.${g.mode}.${g.settings.seed}.${g.settings.size.toFixed(2)}`;

export class GameMaster {
  readonly dir = new Director();
  readonly signs: Signs;
  private acc = 0;
  private saveT = 20;
  private devDone = false;
  private panel: HTMLDivElement | null = null;
  private panelKey = '';

  constructor(private g: Game) {
    this.signs = new Signs(g, this.dir);
    if (!this.enabled) return;
    try { this.dir.restore(JSON.parse(localStorage.getItem(STORE(g)) ?? 'null')); } catch { /* storage unavailable */ }
  }

  /** Normal mode only (the sandbox is not for real challenges). */
  get enabled(): boolean {
    return this.g.mode !== 'sandbox';
  }

  /** The hero did something that meets a need (Story: a clue; CrimeSystem: a fight won; People: a talk). */
  met(need: Need): void {
    if (this.enabled) this.dir.met(need);
  }

  update(dt: number): void {
    if (!this.devDone) this.installDev();
    if (!this.enabled || this.g.intro) return;
    this.dir.state.played += dt;
    this.acc += dt;
    if (this.acc >= GM.tick) { this.acc = 0; this.think(); }
    this.signs.update(dt);
    this.saveT -= dt;
    if (this.saveT <= 0) { this.saveT = 20; this.persist(); }
    if (this.panel) this.drawPanel();
  }

  /** Look at the needs; answer the most overdue one with the cheapest tool that fits now. */
  private think(force?: Need): GmMove | null {
    const R = this.dir.state.rumour;
    if (R && R.until < this.g.sky.hoursAbs) this.dir.state.rumour = null;
    const due = force ? [force] : this.dir.due();
    for (const need of due) {
      const m = this.answer(need);
      if (m) return m;
    }
    return null;
  }

  private answer(need: Need): GmMove | null {
    if (need === 'story') return this.rumour(need) ?? this.groupCrime(need);
    if (need === 'challenge') return this.groupCrime(need);
    return null;
  }

  /** The group whose story to bring back (its id), or null. */
  private followed(): number | null {
    const g = this.g, C = g.crime, S = g.story;
    if (!C || !S) return null;
    const F = C.factions.factions, p = g.player.pos;
    const byThread = (id: string) => F.find((f) => `group:${f.archetype}` === id) ?? null;
    const hereF = C.factionAt(p.x, p.z);
    const id = followedGroup(S.know.list('villains'), hereF ? `group:${hereF.archetype}` : null, (tid) => { const f = byThread(tid); return !!f && !C.collapsed(f.id); });
    return id ? byThread(id)?.id ?? null : null;
  }

  /** Tool "rumour": people asked for the news pass on roughly where the followed group hides out. */
  private rumour(need: Need): GmMove | null {
    const g = this.g, C = g.crime, S = g.story, fid = this.followed();
    if (fid === null || this.dir.state.rumour) return null;
    const f = C.factions.factions[fid], h = C.hideouts[fid], now = g.sky.hoursAbs;
    if (!f || !h || h.found || h.bustedUntil > now) return null;
    let x: number, z: number;
    if (h.door) { x = h.door.x; z = h.door.z; } else {
      const cell = hideoutCell(C.factions, fid);
      if (cell < 0) return null;
      [x, z] = g.macro.cells[cell].centroid;
    }
    const where = S.where(x, z);
    if (!where) return null;
    const u = hashToFloat(deriveSeed(g.settings.seed, 'gm-rumour', this.dir.state.n));
    const text = hideoutRumour(f.name, where, u);
    this.dir.state.rumour = { thread: `group:${f.archetype}`, text, x, z, until: now + GM.rumourHours, heard: false };
    return this.dir.record({ at: now, tool: 'rumour', need, why: `the hideout of ${f.name} is not found yet: people asked for the news now say it is ${where}`, x, z });
  }

  /** Tool "group-crime": one of the followed group's own operations near the hero, in its turf. */
  private groupCrime(need: Need): GmMove | null {
    const g = this.g, fid = this.followed();
    if (fid === null) return null;
    const f = g.crime.factions.factions[fid], n = this.dir.state.n;
    const seed = hash32(deriveSeed(g.settings.seed, 'gm-crime', n));
    const c = g.crime.startFor(fid, hashToFloat(seed), seed);
    if (!c) return null;
    const waited = Math.round(this.dir.waited(need) / 60);
    return this.dir.record({ at: g.sky.hoursAbs, tool: 'group-crime', need, why: `${need} unmet for ${waited} min: a ${c.kind} by ${f.name}, the group the hero follows`, x: c.x, z: c.z });
  }

  // ------------------------------------------------------------------ signs (CrimeSystem's hooks)

  /** A group's boss would come out now: plan it ahead and have it cased (true: the game master took it). */
  planOp(f: Faction): boolean {
    return this.enabled && !this.g.intro && this.signs.planOp(f);
  }

  /** A lookout was caught: they may tell when the job is (true: told). */
  caught(c: Lookout, who: PedAgent): boolean {
    return this.enabled && this.signs.caught(c, who);
  }

  /** A group's messenger reached the hero. */
  taunt(c: Lookout, who: PedAgent): void {
    if (this.enabled) this.signs.taunt(c, who);
  }

  /** The hero hurt a group (stopped its boss operation, busted its stash). */
  hurt(f: Faction, why: 'op' | 'stash'): void {
    if (this.enabled) this.signs.hurt(f, why);
  }

  /** A group's crime got away (or went through) near the hero. */
  escaped(c: Crime, f: Faction): void {
    if (this.enabled) this.signs.escaped(c, f);
  }

  // ------------------------------------------------------------------ talk

  /**
   * What someone asked for the news says (People.facts): the game master's rumour while it goes
   * round, for about half the people (seeded per person); else nothing of its own.
   */
  talkFacts(personSeed: number): { heard: string } | null {
    const R = this.dir.state.rumour;
    if (!this.enabled || !R || R.until < this.g.sky.hoursAbs) return null;
    return hashToFloat(hash32(personSeed ^ 0x6d2b79f5)) < 0.55 ? { heard: R.text } : null;
  }

  /** Someone told the hero the rumour (People.ask): a clue in the group's thread. */
  heard(text: string): void {
    const R = this.dir.state.rumour, S = this.g.story;
    if (!R || R.text !== text || !S) return;
    const info = S.know.threads.get(R.thread);
    const f = this.g.crime.factions.factions.find((x) => `group:${x.archetype}` === R.thread);
    if (!f) return;
    S.note(info ?? S.group(f), `Someone said: “${text}”`, { src: 'heard', x: R.x, z: R.z });
    if (!R.heard && !info?.place) S.place(R.thread, { x: R.x, z: R.z, label: `Their hideout, by hearsay: ${S.where(R.x, R.z)}` });
    R.heard = true;
  }

  // ------------------------------------------------------------------ save

  save(): unknown {
    return this.enabled ? this.dir.save() : null;
  }

  restore(d: unknown): void {
    if (!this.enabled) return;
    this.dir.restore(d ?? null);
    this.persist();
  }

  private persist(): void {
    if (!this.enabled) return;
    try { localStorage.setItem(STORE(this.g), JSON.stringify(this.dir.save())); } catch { /* storage unavailable or full */ }
  }

  // ------------------------------------------------------------------ developer view

  /** The developer panel: the game master's moves, newest first, its needs and pacing. */
  togglePanel(on = !this.panel): boolean {
    if (!on) { this.panel?.remove(); this.panel = null; return false; }
    if (!this.panel) {
      this.panel = document.createElement('div');
      this.panel.id = 'gm-panel';
      this.panel.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
        if (!b) return;
        if (b.dataset.act) this.think(b.dataset.act as Need);
        else if (b.dataset.x) { this.g.map.showAt(Number(b.dataset.x), Number(b.dataset.z)); }
        else if (b.classList.contains('gm-x')) this.togglePanel(false);
        this.panelKey = '';
      });
      document.body.append(this.panel);
    }
    this.panelKey = '';
    return true;
  }

  private drawPanel(): void {
    const D = this.dir, S = D.state;
    const needs = NEEDS.map((n) => `${n} ${Math.round(D.waited(n) / 60)}/${Math.round(GM.overdue[n] / 60)} min`).join(' · ');
    const sg = this.signs.status();
    const key = `${S.n}|${needs}|${D.pacing()}|${S.rumour?.heard}|${sg.plans.join()}|${sg.cards}|${sg.witness}`;
    if (key === this.panelKey) return;
    this.panelKey = key;
    const f = this.followed();
    const fname = f === null ? 'none' : this.g.crime.factions.factions[f].name;
    const moves = S.log.slice().reverse().slice(0, 14).map((m) => `<li><span class="w">${clueTime(m.at)} · ${m.tool} · ${m.need}</span>${m.x !== undefined ? `<button data-x="${m.x.toFixed(1)}" data-z="${m.z!.toFixed(1)}">⌖</button>` : ''}${esc(m.why)}</li>`).join('');
    this.panel!.innerHTML = `<div class="gm-h"><b>Game master</b><button class="gm-x">×</button></div>
      <div class="gm-s">${D.pacing()} · following ${esc(fname)}<br>${needs}${S.rumour ? `<br>rumour${S.rumour.heard ? ' (heard)' : ''}: ${esc(S.rumour.text)}` : ''}${sg.plans.map((p) => `<br>planned: ${esc(p)}`).join('')}${sg.cards ? `<br>calling cards due: ${sg.cards}` : ''}${sg.witness ? '<br>a witness is waiting' : ''}</div>
      <div class="gm-b">Act now: ${NEEDS.map((n) => `<button data-act="${n}">${n}</button>`).join('')}</div>
      <ul>${moves || '<li>No moves yet.</li>'}</ul>`;
  }

  private installDev(): void {
    const dev = (window as unknown as { dev?: Record<string, unknown> }).dev;
    if (!dev) return;
    this.devDone = true;
    dev.gm = {
      gm: this,
      /** Needs (minutes unmet / overdue at), pacing, the followed group, the rumour. */
      status: () => ({ pacing: this.dir.pacing(), needs: Object.fromEntries(NEEDS.map((n) => [n, +(this.dir.waited(n) / 60).toFixed(1)])), followed: this.followed(), rumour: this.dir.state.rumour, moves: this.dir.state.n }),
      /** The moves, newest last. */
      log: () => this.dir.state.log.map((m) => `${clueTime(m.at)} ${m.tool} (${m.need}): ${m.why}`),
      /** Answer a need now (past the pacing). */
      act: (need: Need = 'story') => this.think(need),
      /** Show / hide the developer panel. */
      panel: (on?: boolean) => this.togglePanel(on),
      /** Planned jobs, calling cards due, a waiting witness. */
      signs: () => this.signs.status(),
      /** Plan a group's boss operation now (archetype or id), cased first; `soon` h until it starts. */
      plan: (group: string | number = 'syndicate', soon?: number) => {
        const F = this.g.crime.factions.factions, f = typeof group === 'number' ? F[group] : F.find((x) => x.archetype === group);
        if (!f) return 'no such group';
        if (!this.signs.planOp(f)) return 'no site for it here';
        const P = this.signs.plans.find((p) => p.fid === f.id);
        if (P && soon !== undefined) P.at = this.g.sky.hoursAbs + soon;
        return this.signs.status();
      },
      /** A calling card from a group now (needs it to have its eye on the hero: notoriety raised to wary). */
      card: (group: string = 'gang', why: 'op' | 'stash' = 'stash') => {
        const C = this.g.crime, f = C.factions.factions.find((x) => x.archetype === group);
        if (!f) return 'no such group';
        C.notoriety[f.id] = Math.max(C.notoriety[f.id] ?? 0, 30);
        this.signs.cards.push({ fid: f.id, at: this.g.sky.hoursAbs, why });
        return this.signs.status();
      },
      /** Make every need overdue now. */
      starve: () => { for (const n of NEEDS) this.dir.state.met[n] = this.dir.state.played - GM.overdue[n] - 1; this.dir.state.calmUntil = 0; this.dir.state.lastMove = -1e9; return this.dir.due(); },
    };
  }
}
