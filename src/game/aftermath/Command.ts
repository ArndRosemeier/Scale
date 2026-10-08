/**
 * The player leading the army (THREATS_PLAN §2 "How the player helps", high power; Phase E hooks of
 * response/forces): with a good reputation the soldiers in the field listen to the player.
 *
 *  G  rally (reputation ≥ COMMAND.rallyRep): the squads near the player gather on them and follow
 *     for a while (Forces.rally every few seconds) — a soldier calls out "On you!".
 *  T  airstrike (reputation ≥ COMMAND.strikeRep): two jets roar in and bomb the Tab target (a giant
 *     creature), a few minutes between calls (Forces.airstrike) — "Copy, jets inbound!".
 *
 * Show, don't tell: the answer is a bark and the units moving / the jets coming; only a refusal says
 * why, in one short line. The army against a rampaging giant player (Forces.hostilePlayer) is not
 * here — see ARCHITECTURE.md, "The army".
 */
import type { Game } from '../Game';
import { type PedAgent, hasRole } from '../../sim/Pedestrians';

export const COMMAND = {
  /** Reputation needed to rally the squads / call an airstrike. */
  rallyRep: 40, strikeRep: 70,
  /** Squads within this range follow (m); for this long (s), re-gathered every few seconds. */
  rallyR: 350, rallyT: 60, rallyEvery: 4,
  /** Seconds between airstrikes; a call waits this long at most for the jets to be free. */
  strikeCool: 150, strikeWait: 20,
};

export class Command {
  /** Following the player: seconds left. */
  rallyLeft = 0;
  private rallyT = 0;
  private strikeT = 0;
  /** A called strike waiting for the jets (they are on a run): where, how long it may still wait. */
  private queued: { x: number; z: number; t: number } | null = null;
  stats = { rallies: 0, strikes: 0, denied: 0 };

  constructor(private g: Game) {}

  update(dt: number): void {
    const g = this.g, inp = g.input;
    this.strikeT -= dt;
    if (!g.freeCam && !g.powers.open && !g.map.open && !g.menu.paused) {
      if (inp.hit('KeyG')) this.rally();
      if (inp.hit('KeyT')) this.airstrike();
    }
    if (this.rallyLeft > 0) {
      this.rallyLeft -= dt;
      this.rallyT -= dt;
      if (this.rallyT <= 0) {
        this.rallyT = COMMAND.rallyEvery;
        const p = g.player.pos;
        if (!g.forces.rally(p.x, p.z, COMMAND.rallyR)) this.rallyLeft = 0;
      }
    }
    if (this.queued) {
      this.queued.t -= dt;
      if (!g.forces.air.jetsActive) { const q = this.queued; this.queued = null; this.launch(q.x, q.z); }
      else if (this.queued.t <= 0) this.queued = null;
    }
  }

  /** G: the soldiers near the player follow them. True when they do. */
  rally(): boolean {
    const g = this.g, p = g.player.pos;
    if (!g.forces.squads.length) return false;
    if (g.crime.rep.value < COMMAND.rallyRep) { this.deny('The soldiers don\'t take orders from you — not yet'); return false; }
    const n = g.forces.rally(p.x, p.z, COMMAND.rallyR);
    if (!n) { this.deny('No soldiers near enough'); return false; }
    this.rallyLeft = COMMAND.rallyT;
    this.rallyT = COMMAND.rallyEvery;
    this.stats.rallies++;
    const s = this.soldierNear();
    if (s) g.barks.say(s, pick(['On you!', 'Right behind you!', 'Moving up with you!']));
    g.audio.play2d('cuffs', 0.25, 1.6);
    return true;
  }

  /** T: an airstrike on the Tab target (a giant creature). True when it is called. */
  airstrike(): boolean {
    const g = this.g, t = g.targeting.current;
    if (!t || t.kind !== 'threat') { this.deny('Target a giant creature first (Tab)'); return false; }
    if (g.crime.rep.value < COMMAND.strikeRep) { this.deny('The army won\'t send jets for you — not yet'); return false; }
    if (this.strikeT > 0 || this.queued) { this.deny('The jets are rearming'); return false; }
    const o = t.obj as { x: number; z: number };
    this.strikeT = COMMAND.strikeCool;
    this.stats.strikes++;
    const s = this.soldierNear();
    if (s) g.barks.say(s, pick(['Copy — jets inbound!', 'Danger close, get down!', 'Jets on the way!']));
    if (g.forces.air.jetsActive) { this.queued = { x: o.x, z: o.z, t: COMMAND.strikeWait }; return true; }
    this.launch(o.x, o.z);
    return true;
  }

  private launch(x: number, z: number): void { this.g.forces.airstrike(x, z); }

  private soldierNear(): PedAgent | null {
    const g = this.g, p = g.player.pos;
    return g.peds.nearest(p.x, p.z, 30, (a) => hasRole(a, 'soldier'));
  }

  private deny(msg: string): void {
    this.stats.denied++;
    this.g.powerHud.toast(msg, 'deny', 2200);
    this.g.audio.chime('deny', 0.3);
  }
}

function pick(l: string[]): string { return l[Math.floor(Math.random() * l.length)]; }
