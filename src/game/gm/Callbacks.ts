/**
 * The game master's callbacks and aftermath (GAME_MASTER_PLAN §2.2 tools 6–7, phase 4).
 *
 *   comeback   a boss who broke out of jail turns up in their old turf near the hero, leading one of
 *              the group's crimes; a group that had collapsed is back on its corners (a news line in
 *              its thread) and one of its crimes comes up near the hero. Through CrimeSystem.startFor,
 *              the same budget and rules as any crime.
 *   aftermath  a boss operation that went through (seen or not) leaves the site taped off for a
 *              while (Aftermath.tapeOff: police tape and barriers); passing it later, the hero sees
 *              what happened there (a line in the group's thread).
 *
 * Comebacks and scenes last hours of game time, so they are not saved (a load starts afresh; the
 * tape itself is the aftermath's and is saved with it).
 */
import type { Game } from '../Game';
import type { Faction } from '../factions/Factions';
import type { BossOpKind } from '../crime/Crime';
import type { Director } from './director';
import { deriveSeed, hashToFloat, hash32 } from '../../core/rng';
import { sceneSeen, backLine } from './signsText';

export const CALLBACKS = {
  /** A comeback comes this many game hours after the news, waits up to `keep` hours for the hero to be near the group's turf. */
  after: [0.3, 1.2] as [number, number], keep: 12,
  /** A scene stays taped off this many game hours; the hero passing within `seenR` m sees it. */
  sceneHours: 8, seenR: 35, tapeR: 11,
};

interface Comeback { fid: number; at: number; boss: boolean }
interface Scene { fid: number; kind: BossOpKind; x: number; z: number; until: number; seen: boolean }

export class Callbacks {
  readonly comebacks: Comeback[] = [];
  readonly scenes: Scene[] = [];
  private acc = 0;

  constructor(private g: Game, private dir: Director) {}

  private seed(tag: string): number {
    return hash32(deriveSeed(this.g.settings.seed, tag, this.dir.state.n, Math.floor(this.dir.state.played)));
  }

  /** A group's boss broke out of jail: they will be seen again. */
  brokeOut(f: Faction): void {
    this.queue(f, true);
  }

  /** A collapsed group is back (its boss out, or its stash restocked). */
  returned(f: Faction): void {
    const S = this.g.story;
    S?.note(S.group(f), backLine(f.name, hashToFloat(this.seed('gm-back'))), { src: 'news' });
    this.queue(f, false);
  }

  private queue(f: Faction, boss: boolean): void {
    if (this.comebacks.some((c) => c.fid === f.id)) return;
    const u = hashToFloat(this.seed('gm-comeback'));
    this.comebacks.push({ fid: f.id, at: this.g.sky.hoursAbs + CALLBACKS.after[0] + u * (CALLBACKS.after[1] - CALLBACKS.after[0]), boss });
  }

  /** A boss operation went through at a site: tape it off; the hero passing later sees it. */
  jobDone(f: Faction, kind: BossOpKind, x: number, z: number, seen: boolean): void {
    const now = this.g.sky.hoursAbs;
    this.g.aftermath?.tapeOff(x, z, CALLBACKS.tapeR, CALLBACKS.sceneHours);
    this.scenes.push({ fid: f.id, kind, x, z, until: now + CALLBACKS.sceneHours, seen });
    if (this.scenes.length > 6) this.scenes.shift();
  }

  update(dt: number): void {
    this.acc += dt;
    if (this.acc < 1) return;
    this.acc = 0;
    const g = this.g, C = g.crime, S = g.story, now = g.sky.hoursAbs, p = g.player.pos;
    if (!C || !S) return;
    for (let i = this.comebacks.length - 1; i >= 0; i--) {
      const K = this.comebacks[i], f = C.factions.factions[K.fid];
      if (!f || now > K.at + CALLBACKS.keep || C.collapsed(K.fid)) { this.comebacks.splice(i, 1); continue; }
      if (now < K.at) continue;
      const seed = this.seed('gm-comeback-crime');
      const c = C.startFor(K.fid, hashToFloat(seed), seed, K.boss);
      if (!c) continue;
      this.comebacks.splice(i, 1);
      this.dir.record({ at: now, tool: 'comeback', need: 'story', why: K.boss ? `${f.name}'s boss is out of jail: back on the street, leading a ${c.kind}` : `${f.name} are back after their collapse: a ${c.kind} near the hero`, x: c.x, z: c.z });
    }
    for (let i = this.scenes.length - 1; i >= 0; i--) {
      const s = this.scenes[i];
      if (now > s.until) { this.scenes.splice(i, 1); continue; }
      if (s.seen || Math.hypot(s.x - p.x, s.z - p.z) > CALLBACKS.seenR) continue;
      s.seen = true;
      const f = C.factions.factions[s.fid];
      if (f) S.note(S.group(f), sceneSeen(s.kind, f.name, S.where(s.x, s.z)), { x: s.x, z: s.z });
    }
  }

  status(): { comebacks: number; scenes: number } {
    return { comebacks: this.comebacks.length, scenes: this.scenes.length };
  }
}
