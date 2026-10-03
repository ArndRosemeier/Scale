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
 *  - Fear decays; people resume their routes afterwards.
 */
import type { Pedestrians, PedAgent, DownCause } from './Pedestrians';
import { PState, GAWK_CROWD, GAWK_R, canGawk, gawkersNear } from './Pedestrians';
import type { Stimuli, Stimulus } from '../game/Stimuli';
import type { Player } from '../player/Player';
import { statusOf } from '../shared/status';

export class Reactions {
  private lastSeen = 0;
  private screamCooldown = 0;
  onScream?: (x: number, y: number, z: number, crowd: boolean) => void;
  /**
   * After every knock-down (Combat applies damage and the collateral ledger from here; a
   * ragdoll system can take the body over). `power` is the fling speed (m/s).
   */
  onKnockDown: ((a: PedAgent, fx: number, fz: number, power: number, cause: DownCause) => void) | null = null;

  constructor(private peds: Pedestrians, private stimuli: Stimuli) {}

  update(dt: number, player: Player): void {
    this.screamCooldown -= dt;
    const fresh: Stimulus[] = [];
    for (const s of this.stimuli.recent) if (s.time > this.lastSeen) fresh.push(s);
    this.lastSeen = this.stimuli.time;
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
            a.fear = Math.min(2, a.fear + prox * nerve * 0.9);
            if (d < Math.max(1.5, H * 0.12)) this.knockDown(a, s.x, s.z, 4, 'player');
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
            if (prox > 0.4 && a.state === PState.Walk && a.cit.curiosity > 0.5 && !a.glance) { a.glance = 2.5; a.lookX = s.x; a.lookY = s.y; a.lookZ = s.z; }
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
      a.fear = Math.max(0, a.fear - dt * 0.06);
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
