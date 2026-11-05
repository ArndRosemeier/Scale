/**
 * The game master's signs (GAME_MASTER_PLAN §2.2 tools 2–4, phase 3): what tells the hero a group
 * is up to something, and what a group does after the hero hurt it.
 *
 *   casing    a boss operation is planned ahead (site and time) instead of starting at once; until
 *             then its members are seen at the site (crime/Lookout). Seen, it goes into the tracker;
 *             a caught lookout tells when the job is. When the time comes it starts if the hero is
 *             about; if not, it happens without them (a news line, if they knew of it).
 *   calling   after a boss operation stopped or a stash busted, a group that has its eye on the hero
 *   card      (notoriety wary or more) sends one member to tell them so to their face.
 *   witness   a group's crime got away near the hero: someone who saw it waits at the scene and
 *             tells the hero where that lot go in (the hideout's street, by sight).
 *
 * Plans, calling cards and witnesses last minutes, so they are not saved (a load starts afresh).
 */
import type { Game } from '../Game';
import type { Faction } from '../factions/Factions';
import type { Crime, BossOpKind } from '../crime/Crime';
import type { Lookout } from '../crime/Lookout';
import type { BossSite } from '../crime/BossOp';
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';
import { makeActor, release, PEOPLE_OWNER, type Actor } from '../../sim/actors/Actor';
import { NOTORIETY } from '../factions/Bosses';
import { hideoutCell } from '../factions/Hideouts';
import { deriveSeed, hashToFloat, hash32 } from '../../core/rng';
import { casingSeen, caughtLine, offscreenNews, tauntLine, witnessLine, whenSaid } from './signsText';
import type { Director, Need } from './director';

export const SIGNS = {
  /** Game hours from the plan to the job (casing time in between). */
  lead: [1.5, 3] as [number, number],
  /** The job starts if the hero is within this of the site (m); else it waits this many hours, then happens without them. */
  startR: 380, wait: 3,
  /** Lookouts come while the hero is within this of the site (m), at most this often (game hours) and this many times. */
  caseR: 220, caseEvery: 0.5, caseTimes: 2,
  /** The hero this close to a lookout sees them at it (m). */
  seenR: 45,
  /** A calling card comes this many game hours after the blow, with this chance. */
  cardAfter: [0.25, 0.75] as [number, number], cardChance: 0.75,
  /** A witness: the escape this close to the hero (m), with this chance, at most this often (s of play); waits this long (s). */
  witnessR: 160, witnessChance: 0.6, witnessGap: 300, witnessFor: 150, sayR: 6,
};

interface Plan { fid: number; kind: BossOpKind; site: BossSite; at: number; seen: boolean; told: boolean; cased: number; lastCase: number; look: Lookout | null }
interface Card { fid: number; at: number; why: 'op' | 'stash' }
interface Witness { a: PedAgent; act: Actor; fid: number; line: string; x: number; z: number; t: number; said: boolean }

export class Signs {
  readonly plans: Plan[] = [];
  readonly cards: Card[] = [];
  witness: Witness | null = null;
  private lastWitness = -1e9;
  /** A job went through without the hero (the callbacks tape the site off). */
  onJobDone: ((f: Faction, kind: BossOpKind, x: number, z: number) => void) | null = null;
  private acc = 0;

  constructor(private g: Game, private dir: Director) {}

  private seed(tag: string): number {
    return hash32(deriveSeed(this.g.settings.seed, tag, this.dir.state.n, Math.floor(this.dir.state.played)));
  }

  private log(tool: string, need: Need, why: string, x?: number, z?: number): void {
    this.dir.record({ at: this.g.sky.hoursAbs, tool, need, why, ...(x !== undefined ? { x, z } : {}) });
  }

  /** The hero can be shown something in the street (outdoors, human-sized, above ground, past the intro). */
  private heroFree(): boolean {
    const g = this.g, p = g.player.pos;
    return !g.intro && g.player.height <= 6 && !g.underground.feetUnder(p.x, p.y, p.z) && !g.indoorsAt(p.x, p.y + 0.5, p.z);
  }

  private dist(x: number, z: number): number {
    const p = this.g.player.pos;
    return Math.hypot(x - p.x, z - p.z);
  }

  // ------------------------------------------------------------------ casing

  /** The crime system's roll says the group's boss comes out: plan it ahead instead (true: taken over). */
  planOp(f: Faction): boolean {
    const C = this.g.crime, now = this.g.sky.hoursAbs;
    if (this.plans.some((p) => p.fid === f.id)) return true;
    if (this.plans.length) return true; // one job at a time in the city
    const s = C.bossSite(f.id);
    if (!s) return false;
    const u = hashToFloat(this.seed('gm-plan'));
    const at = now + SIGNS.lead[0] + u * (SIGNS.lead[1] - SIGNS.lead[0]);
    this.plans.push({ fid: f.id, kind: s.kind, site: s.site, at, seen: false, told: false, cased: 0, lastCase: -1e9, look: null });
    // (The boss's gap to the next operation counts from now.)
    const B = C.bosses[f.id];
    if (B) B.opAt = now;
    this.log('casing', 'story', `${f.name} plan a ${s.kind} ${this.g.story.where(s.site.x, s.site.z)} at ${whenSaid(at, now)}: lookouts first`, s.site.x, s.site.z);
    return true;
  }

  private updatePlans(): void {
    const g = this.g, C = g.crime, S = g.story, now = g.sky.hoursAbs;
    for (let i = this.plans.length - 1; i >= 0; i--) {
      const P = this.plans[i], f = C.factions.factions[P.fid];
      if (!f || C.collapsed(P.fid)) { this.plans.splice(i, 1); continue; }
      const d = this.dist(P.site.x, P.site.z), where = S.where(P.site.x, P.site.z);
      // Seen at it.
      if (P.look?.active && P.look.watched && !P.seen && P.look.criminals.some((c) => c.alive && this.dist(c.x, c.z) < SIGNS.seenR)) {
        P.seen = true;
        S.note(S.group(f), casingSeen(P.kind, f.name, where), { x: P.site.x, z: P.site.z });
      }
      if (now >= P.at) {
        if (d < SIGNS.startR && this.heroFree() && C.bossOpRoom(P.fid)) {
          const c = C.startBossOp(P.fid, null, P.site);
          if (c) { this.plans.splice(i, 1); this.log('casing', 'challenge', `the ${P.kind} of ${f.name} begins as planned${P.seen ? ' (the hero knew)' : ''}`, c.x, c.z); continue; }
        }
        if (now > P.at + SIGNS.wait) {
          this.plans.splice(i, 1);
          if (P.seen || P.told) S.note(S.group(f), offscreenNews(P.kind, f.name, where), { src: 'news', x: P.site.x, z: P.site.z });
          this.onJobDone?.(f, P.kind, P.site.x, P.site.z);
          this.log('casing', 'story', `the ${P.kind} of ${f.name} happened without the hero (away ${Math.round(d)} m)`, P.site.x, P.site.z);
        }
        continue;
      }
      // Lookouts while the hero is about.
      if (!P.look?.active && P.cased < SIGNS.caseTimes && now < P.at - 0.2 && now - P.lastCase > SIGNS.caseEvery && d < SIGNS.caseR && this.heroFree()) {
        const L = C.startLookout(P.fid, 'casing', P.site, this.seed('gm-case'));
        if (L) { P.look = L; P.cased++; P.lastCase = now; }
      }
    }
  }

  /** A lookout of a planned job was caught (surrender or cuffs): they tell when it is (true: told). */
  caught(c: Lookout, who: PedAgent): boolean {
    const P = this.plans.find((p) => p.look === c);
    if (!P || P.told || !who.actor) return false;
    const g = this.g, S = g.story, f = g.crime.factions.factions[P.fid];
    P.told = P.seen = true;
    const line = caughtLine(P.kind, S.where(P.site.x, P.site.z), whenSaid(P.at, g.sky.hoursAbs), hashToFloat(this.seed('gm-told')));
    S.say(who, S.group(f), line, { x: P.site.x, z: P.site.z, src: 'told' });
    return true;
  }

  // ------------------------------------------------------------------ calling cards

  /** The hero hurt the group (a boss operation stopped, its stash busted). */
  hurt(f: Faction, why: 'op' | 'stash'): void {
    const g = this.g, now = g.sky.hoursAbs, n = g.crime.notoriety[f.id] ?? 0;
    if (n < NOTORIETY.wary || g.crime.collapsed(f.id) || this.cards.some((c) => c.fid === f.id)) return;
    const u = hashToFloat(this.seed('gm-card'));
    if (u > SIGNS.cardChance) return;
    this.cards.push({ fid: f.id, at: now + SIGNS.cardAfter[0] + (u / SIGNS.cardChance) * (SIGNS.cardAfter[1] - SIGNS.cardAfter[0]), why });
  }

  private updateCards(): void {
    const g = this.g, C = g.crime, now = g.sky.hoursAbs;
    for (let i = this.cards.length - 1; i >= 0; i--) {
      const K = this.cards[i];
      if (now > K.at + 6 || C.collapsed(K.fid)) { this.cards.splice(i, 1); continue; }
      if (now < K.at || !this.heroFree() || g.player.flying) continue;
      // Not in the middle of a fight.
      const p = g.player.pos;
      if (C.crimes.some((c) => c.active && Math.hypot(c.x - p.x, c.z - p.z) < 60)) continue;
      const L = C.startLookout(K.fid, 'taunt', null, this.seed('gm-taunt'));
      if (!L) continue;
      L.memoWhy = K.why;
      this.cards.splice(i, 1);
      this.log('calling-card', 'story', `${C.factions.factions[K.fid].name} answer the hero (${K.why === 'op' ? 'their operation was stopped' : 'their stash was busted'})`, p.x, p.z);
    }
  }

  /** The messenger is face to face with the hero: the group's answer. */
  taunt(c: Lookout, who: PedAgent): void {
    const g = this.g, S = g.story, f = g.crime.factionOf(c);
    if (!f) return;
    S.say(who, S.group(f), tauntLine(c.memoWhy ?? 'op', f.name, hashToFloat(this.seed('gm-taunt-line'))));
  }

  // ------------------------------------------------------------------ witnesses

  /** A group's crime got away (or went through) near the hero: someone saw where they went. */
  escaped(c: Crime, f: Faction): void {
    const g = this.g, C = g.crime, played = this.dir.state.played;
    if (this.witness || played - this.lastWitness < SIGNS.witnessGap || this.dist(c.x, c.z) > SIGNS.witnessR) return;
    if (hashToFloat(this.seed('gm-witness')) > SIGNS.witnessChance) return;
    const h = C.hideouts[f.id];
    if (!h || h.found || h.bustedUntil > g.sky.hoursAbs) return;
    let hx: number, hz: number;
    if (h.door) { hx = h.door.x; hz = h.door.z; } else {
      const cell = hideoutCell(C.factions, f.id);
      if (cell < 0) return;
      [hx, hz] = g.macro.cells[cell].centroid;
    }
    const where = g.story.where(hx, hz);
    if (!where) return;
    // Someone at the scene who saw it: on foot, out in the street, nobody else's.
    const a = g.peds.neighbours(c.x, c.z, 45, []).filter((o) => o.alive && !o.actor && !o.inside && !o.under && o.state !== PState.Down && o.state !== PState.Sit && o.cit.role !== 0)
      .sort((p, q) => Math.hypot(p.x - c.x, p.z - c.z) - Math.hypot(q.x - c.x, q.z - c.z))[0];
    if (!a) return;
    const P = g.player.pos;
    const act = makeActor('bystander', PEOPLE_OWNER, { title: 'Witness', face: { x: P.x, y: P.y + 1.6, z: P.z } });
    a.actor = act;
    a.state = PState.Idle; a.stateT = 0;
    this.witness = { a, act, fid: f.id, line: witnessLine(where, hashToFloat(this.seed('gm-witness-line'))), x: hx, z: hz, t: played, said: false };
    this.lastWitness = played;
    this.log('witness', 'story', `someone saw ${f.name} get away and knows their door ${where}`, a.x, a.z);
  }

  private updateWitness(): void {
    const W = this.witness;
    if (!W) return;
    const g = this.g, a = W.a, P = g.player.pos, d = this.dist(a.x, a.z);
    const gone = !a.alive || a.actor !== W.act || a.state === PState.Down;
    if (gone || this.dir.state.played - W.t > SIGNS.witnessFor || (W.said && d > 25)) {
      if (!gone && a.actor === W.act) release(a);
      this.witness = null;
      return;
    }
    W.act.face = { x: P.x, y: P.y + g.player.height * 0.9, z: P.z };
    if (!W.said && d < SIGNS.sayR) {
      W.said = true;
      const S = g.story, f = g.crime.factions.factions[W.fid];
      S.say(a, S.group(f), W.line, { x: W.x, z: W.z, src: 'told' });
      const th = S.know.threads.get(`group:${f.archetype}`);
      if (!th?.place) S.place(`group:${f.archetype}`, { x: W.x, z: W.z, label: `Their door, a witness says: ${S.where(W.x, W.z)}` });
    }
  }

  // ------------------------------------------------------------------

  update(dt: number): void {
    this.acc += dt;
    if (this.acc < 0.5) return;
    this.acc = 0;
    if (!this.g.crime || !this.g.story) return;
    this.updatePlans();
    this.updateCards();
    this.updateWitness();
  }

  /** For the developer panel. */
  status(): { plans: string[]; cards: number; witness: boolean } {
    const now = this.g.sky.hoursAbs, F = this.g.crime.factions.factions;
    return {
      plans: this.plans.map((p) => `${F[p.fid]?.name}: ${p.kind} in ${(p.at - now).toFixed(1)} h${p.seen ? ', seen' : ''}${p.told ? ', told' : ''} (cased ${p.cased}×)`),
      cards: this.cards.length,
      witness: !!this.witness,
    };
  }
}
