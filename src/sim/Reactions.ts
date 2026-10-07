/**
 * Perception and reactions of pedestrians: fear and curiosity driven by
 * world events (stimuli) and by the player's size and behaviour.
 *
 *  - Loud, dangerous events nearby (collapses, blasts, giant stomps) → flee,
 *    scream; very close → knocked down.
 *  - Smaller events (glass, punches) → startle, stop and look, some film.
 *  - A slightly oversized person (2.3–5 m) draws a curious crowd that keeps
 *    its distance and films; a real giant (>6 m) makes everyone run.
 *  - A tiny person (< 0.4 m) is mostly unnoticed.
 *  - A monster's roar sends people running (the far, bold ones film it); a tremor makes them
 *    stop and look round.
 *  - Fear decays; people resume their routes afterwards.
 */
import type { Pedestrians, PedAgent, DownCause } from './Pedestrians';
import { PState, GAWK_CROWD, GAWK_R, canGawk, gawkersNear } from './Pedestrians';
import type { Stimuli, Stimulus } from '../game/Stimuli';
import type { Player } from '../player/Player';
import { statusOf } from '../shared/status';
import { calmRate } from '../game/people/behaviour';

export class Reactions {
  private lastSeen = 0;
  private screamCooldown = 0;
  onScream?: (x: number, y: number, z: number, crowd: boolean) => void;
  /**
   * After every knock-down (Combat applies damage and the collateral ledger from here; a
   * ragdoll system can take the body over). `power` is the fling speed (m/s).
   */
  onKnockDown: ((a: PedAgent, fx: number, fz: number, power: number, cause: DownCause) => void) | null = null;
  /**
   * A civil-defence siren (a 'siren' stimulus with `evac`) reached someone not yet evacuating:
   * the city response gives them a way to a metro entrance (PedAgent.evac).
   */
  onEvacuate: ((a: PedAgent, s: Stimulus) => void) | null = null;

  constructor(private peds: Pedestrians, private stimuli: Stimuli) {}

  update(dt: number, player: Player): void {
    this.screamCooldown -= dt;
    const fresh: Stimulus[] = [];
    // (By emission order: what was emitted later in the last frame, after this ran, counts too.)
    for (const s of this.stimuli.recent) if (s.seq > this.lastSeen) fresh.push(s);
    this.lastSeen = this.stimuli.seq;
    const H = player.height;
    const px = player.pos.x, py = player.pos.y, pz = player.pos.z;
    const flyingFast = player.flying && player.vel.length() > 15 * Math.sqrt(player.k);
    // Room for more gawkers per incident (and around a strange tall player): a crowd of
    // GAWK_CROWD at most, counting those already standing there.
    this.room.length = fresh.length;
    for (let k = 0; k < fresh.length; k++) this.room[k] = GAWK_CROWD - gawkersNear(this.peds, fresh[k].x, fresh[k].z, GAWK_R, this.tmp);
    this.playerRoom = H > 2.3 || flyingFast ? GAWK_CROWD + 6 - gawkersNear(this.peds, px, pz, Math.min(6 * H, 60), this.tmp) : 0;
    let screamers = 0;
    for (const a of this.peds.agents) {
      // Actors (crime, police, deeds) are staged by their owner.
      if (a.state === PState.Down || a.actor) continue;
      // Frozen solid: no reactions until thawed.
      const st = statusOf(a);
      if (st && st.frozen > 0) continue;
      const nerve = 0.4 + a.cit.nerve * 0.9;
      const before = a.fear;
      if (a.evac && a.state !== PState.Flee) {
        // Evacuating: on the way to the metro; only danger right next to them makes them run.
        for (const s of fresh) if ((s.kind === 'threat' || s.kind === 'blast' || s.kind === 'collapse' || s.kind === 'roar') && Math.hypot(a.x - s.x, a.z - s.z) < Math.min(s.kind === 'roar' ? 120 : 14, s.radius * 0.3)) { a.fear = Math.min(2, a.fear + 0.9); this.flee(a, s.x, s.z); }
        continue;
      }
      // ---- events
      for (let k = 0; k < fresh.length; k++) {
        const s = fresh[k];
        this.cur = k;
        const d = Math.hypot(a.x - s.x, a.z - s.z);
        if (d > s.radius) continue;
        const prox = 1 - d / s.radius;
        switch (s.kind) {
          case 'collapse':
          case 'blast':
          case 'sonic':
          case 'crash': {
            a.fear = Math.min(2, a.fear + prox * nerve * (s.kind === 'crash' ? 0.6 : 1.4));
            // Blast wave / falling debris knocks people down close by.
            const knock = s.kind === 'blast' ? s.radius * 0.12 : s.kind === 'collapse' ? Math.min(40, s.radius * 0.05) : 0;
            if (d < knock) this.knockDown(a, s.x, s.z, (1 - d / knock) * 9, s.kind === 'blast' ? 'player' : 'collapse');
            else this.flee(a, s.x, s.z);
            break;
          }
          case 'power':
            // Beams, flames, bolts, quakes: frightening, but they only hurt what they hit.
            a.fear = Math.min(2, a.fear + prox * nerve * 0.8);
            if (a.fear > 0.5) this.flee(a, s.x, s.z); else this.gawk(a, s.x, s.y, s.z);
            break;
          case 'stomp':
            // By the size of whoever stepped (the player, a monster), booked to it.
            a.fear = Math.min(2, a.fear + prox * nerve * 0.9);
            if (d < Math.max(1.5, (s.size ?? H) * 0.12)) this.knockDown(a, s.x, s.z, 4, s.cause === 'threat' ? 'threat' : s.cause === 'world' ? 'other' : 'player');
            break;
          case 'roar':
            // A monster's roar: run (far off, the bold stop, turn and film it).
            a.fear = Math.min(2, a.fear + (0.35 + prox) * nerve * 1.1);
            if (a.fear > 0.5 || prox > 0.45) this.flee(a, s.x, s.z); else this.gawk(a, s.x, s.y, s.z);
            break;
          case 'tremor':
            // The ground shakes: stop and look round (the nervous hurry off).
            if (a.state === PState.Walk && !a.glance) { a.glance = 1.5 + prox * 2; a.lookX = a.x + (Math.random() - 0.5) * 20; a.lookY = a.y + 1.6 + Math.random() * 6; a.lookZ = a.z + (Math.random() - 0.5) * 20; }
            a.fear = Math.min(2, a.fear + prox * nerve * 0.25);
            break;
          case 'thunder':
            // A thunderclap: a start, a glance at the sky (never a panic).
            if ((a.state === PState.Walk || a.state === PState.Idle) && !a.glance && Math.random() < 0.6) { a.glance = 1 + prox * 1.5; a.lookX = a.x + (Math.random() - 0.5) * 30; a.lookY = a.y + 20 + Math.random() * 30; a.lookZ = a.z + (Math.random() - 0.5) * 30; }
            a.fear = Math.max(a.fear, Math.min(0.35, a.fear + prox * nerve * 0.12));
            break;
          case 'cry':
          case 'alarm':
            // Someone shouting for help / an alarm bell: turn, stop and watch (the curious film,
            // the nervous back off a little). Witnesses look at the source (s.y: where to look).
            if (prox > 0.15 && a.state !== PState.Flee) {
              if (a.cit.nerve > 0.75 && prox > 0.6) { a.fear = Math.min(2, a.fear + 0.62); this.flee(a, s.x, s.z); }
              else { a.fear = Math.min(0.45, a.fear + prox * 0.2); this.gawk(a, s.x, s.y, s.z); }
            }
            break;
          case 'siren':
            if (s.evac) { if (!a.evac) this.onEvacuate?.(a, s); break; }
            if (prox > 0.4 && a.state === PState.Walk && a.cit.curiosity > 0.5 && !a.glance) { a.glance = 2.5; a.lookX = s.x; a.lookY = s.y; a.lookZ = s.z; }
            break;
          case 'gunfire':
            // The army firing: close by, run (away from the guns); farther off, start, look and hurry on.
            a.fear = Math.min(2, a.fear + prox * nerve * 0.9);
            if (a.fear > 0.4) this.flee(a, s.x, s.z); else if (prox > 0.3) this.gawk(a, s.x, s.y, s.z);
            break;
          case 'threat':
            // Rogue machines ramming and diving at people: run (the bolder keep their distance and film).
            a.fear = Math.min(2, a.fear + prox * nerve * 1.1);
            if (a.fear > 0.45) this.flee(a, s.x, s.z); else this.gawk(a, s.x, s.y, s.z);
            break;
          case 'impact':
          case 'glass':
            if (prox > 0.2) {
              a.fear = Math.min(2, a.fear + prox * nerve * 0.35);
              if (a.fear < 0.5) this.gawk(a, s.x, s.y, s.z);
            }
            break;
          default:
            break;
        }
      }
      // ---- the player's presence
      this.cur = -1;
      const dp = Math.hypot(a.x - px, a.z - pz);
      if (H > 2.3 && dp < 14 * H) {
        const seen = 1 - dp / (14 * H);
        if (H > 6) {
          // A giant: run, the bigger and closer the more urgently.
          a.fear = Math.min(2, a.fear + dt * seen * nerve * (H / 6) * 1.5);
        } else {
          // Strange tall person: curiosity, with some unease up close.
          if (dp < H * 1.6) a.fear = Math.min(2, a.fear + dt * 0.4 * nerve);
          else if (a.cit.curiosity > 0.45 && a.state === PState.Walk && a.fear < 0.3 && dp < 6 * H && canGawk(a) && this.playerRoom > 0) {
            a.state = a.cit.curiosity > 0.7 ? PState.Film : PState.Gawk;
            a.stateT = 0;
            this.playerRoom--;
            a.lookX = px; a.lookZ = pz; a.lookY = py + H * 0.8;
          }
          if (a.state === PState.Gawk || a.state === PState.Film) { a.lookX = px; a.lookZ = pz; a.lookY = py + H * 0.8; a.stateT = Math.min(a.stateT, 2); }
        }
        if (a.fear > 0.5) this.flee(a, px, pz);
      }
      if (flyingFast && dp < 60 && a.state === PState.Walk && a.fear < 0.3 && a.cit.curiosity > 0.3) this.gawk(a, px, py, pz);
      // ---- fear dynamics
      // (The calm get over it quickly, the nervous keep running: game/people.)
      a.fear = Math.max(0, a.fear - dt * calmRate(a.cit.nerve));
      if (a.fear > 0.55 && a.state !== PState.Flee) this.flee(a, a.fearX || px, a.fearZ || pz);
      if (before < 0.6 && a.fear >= 0.6) screamers++;
    }
    if (screamers > 0 && this.screamCooldown <= 0) {
      const a = this.peds.agents.find((x) => x.fear >= 0.6);
      if (a) this.onScream?.(a.x, a.y + 1.6, a.z, screamers > 4);
      this.screamCooldown = screamers > 4 ? 2.5 : 1.2;
    }
  }

  private flee(a: PedAgent, fx: number, fz: number): void {
    if (a.state === PState.Down) return;
    a.fearX = fx;
    a.fearZ = fz;
    if (a.state !== PState.Flee) { a.state = PState.Flee; a.stateT = 0; }
  }

  /** Per fresh stimulus (index `cur`, −1: the player): gawkers it may still add. */
  private room: number[] = [];
  private playerRoom = 0;
  private cur = -1;
  private tmp: PedAgent[] = [];

  /**
   * Stop and look (the curious film). Someone already looking just turns to the new thing (a
   * shout repeated every few seconds must not keep a crowd standing for ever); a full crowd
   * or someone bored of gawking walks on.
   */
  private gawk(a: PedAgent, x: number, y: number, z: number): void {
    if (a.state === PState.Flee || a.state === PState.Down) return;
    if (a.state === PState.Gawk || a.state === PState.Film) { a.lookX = x; a.lookY = y; a.lookZ = z; return; }
    if (!canGawk(a)) return;
    if (this.cur >= 0 ? this.room[this.cur]-- <= 0 : this.playerRoom-- <= 0) return;
    a.state = a.cit.curiosity > 0.75 ? PState.Film : PState.Gawk;
    a.stateT = 0;
    a.lookX = x; a.lookY = y; a.lookZ = z;
  }

  knockDown(a: PedAgent, fx: number, fz: number, power: number, cause: DownCause = 'other'): void {
    a.downBy = cause;
    a.helped = false;
    const dx = a.x - fx, dz = a.z - fz;
    const d = Math.hypot(dx, dz) || 1;
    a.state = PState.Down;
    a.stateT = 0;
    a.vx = (dx / d) * power;
    a.vz = (dz / d) * power;
    a.vy = power * 0.4;
    a.fear = 2;
    this.onKnockDown?.(a, fx, fz, power, cause);
  }
}
