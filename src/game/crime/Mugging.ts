/**
 * Mugging (tier 1, worse at night). One or two muggers (one with a knife) walk up to a lone
 * passer-by on a quiet street and corner them: the victim cowers with their hands up, the muggers
 * loom and jab, the wallet changes hands, a shove, and they walk off. Shouts for help carry down
 * the street. When the player shows up the muggers weigh them up (con): a weak-looking hero gets
 * the knife, a strong one sees them run; a lone mugger who is hurt gives up. The victim may be
 * left on the ground — help them up afterwards.
 */
import { Crime, type CrimeWorld, play, setState, stand, lookAt, goTo, subdued } from './Crime';
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';
import { release } from '../../sim/actors/Actor';

export const MUGGING = { ringMin: 120, ringMax: 320, quietR: 22, quietMax: 3, approachTimeout: 50, hp: 55, strength: 1.05, threatenFor: 7, robFor: 13 };

export class Mugging extends Crime {
  readonly kind = 'mugging' as const;
  readonly tier = 1;
  victim: PedAgent | null = null;
  private shoutT = 0;
  private confronted = false;

  constructor(w: CrimeWorld, seed: number, private near: { x: number; z: number } | null = null) {
    super(w, seed);
  }

  setup(): boolean {
    const p = this.w.player;
    const cx = this.near?.x ?? p.x, cz = this.near?.z ?? p.z;
    const cands = this.walkers(cx, cz, this.near ? 70 : MUGGING.ringMax, true).filter((a) => {
      if (!this.near) { const d = this.distToPlayer(a); if (d < MUGGING.ringMin || d > MUGGING.ringMax) return false; }
      return this.w.neighbours(a.x, a.z, MUGGING.quietR).filter((o) => !o.inside).length <= MUGGING.quietMax;
    });
    if (!cands.length) return false;
    const victim = cands[this.rng.int(0, cands.length - 1)];
    const night = this.w.hour >= 20 || this.w.hour < 5;
    const n = this.rng.chance(night ? 0.6 : 0.35) ? 2 : 1;
    const fx = -Math.sin(victim.heading), fz = -Math.cos(victim.heading);
    for (let i = 0; i < n; i++) {
      let c: PedAgent | null = null;
      for (let k = 0; k < 6 && !c; k++) {
        // Ahead of the victim (they meet face to face), out of the player's view.
        const ahead = 26 + k * 4 + i * 3, side = (i ? 1.5 : -1.5) + (this.rng.float() - 0.5) * 2;
        const x = victim.x + fx * ahead - fz * side, z = victim.z + fz * ahead + fx * side;
        if (this.w.visible(x, victim.y + 1, z) && this.distToPlayer({ x, z }) < 90) continue;
        c = this.spawnCriminal(x, z, victim.heading + Math.PI, {
          hp: MUGGING.hp, maxHp: MUGGING.hp, strength: MUGGING.strength, armed: i === 0 && this.rng.chance(night ? 0.8 : 0.55) ? 'knife' : 'none',
        });
      }
      if (!c) break;
      c.actor!.held = c.actor!.armed === 'knife' ? 'knife' : null;
      c.actor!.memo.brave = this.rng.chance(0.4) ? 1 : 0;
    }
    if (!this.criminals.length) return false;
    this.victim = victim;
    this.x = victim.x; this.z = victim.z;
    this.hot.x = victim.x; this.hot.z = victim.z;
    this.loot = { kind: 'wallet', x: victim.x, y: victim.y, z: victim.z, owner: victim, carrier: null, returned: false, crime: this.id };
    return true;
  }

  protected step(dt: number): void {
    const v = this.victim;
    if (!v) { this.abort(); return; }
    const crooks = this.criminals.filter((c) => c.alive && c.actor && c.actor.state !== 'gone');
    switch (this.phase) {
      case 'approach': {
        if (!v.alive || v.inside || v.state === PState.Down || (v.actor && v.actor.owner !== this.id) || this.phaseT > MUGGING.approachTimeout) { this.abort(); return; }
        let met = false;
        crooks.forEach((c, i) => {
          const act = c.actor!;
          // Walk towards the victim, the second one a little to the side (to box them in).
          const side = i ? 1.1 : -0.2;
          const tx = v.x - Math.cos(v.heading) * side, tz = v.z + Math.sin(v.heading) * side;
          goTo(act, tx, tz, 1.55);
          setState(act, 'walk');
          if (Math.hypot(v.x - c.x, v.z - c.z) < 2.0) met = true;
        });
        if (met) this.commit();
        break;
      }
      case 'commit': {
        // Cornered: the victim cowers, the muggers loom and jab; the wallet changes hands.
        this.victimStaging(dt);
        if (this.reactToPlayer(crooks, dt)) break;
        crooks.forEach((c, i) => {
          const act = c.actor!;
          const ang = Math.atan2(c.x - v.x, c.z - v.z) + (i ? 0.7 : -0.3);
          const tx = v.x + Math.sin(ang) * 1.05, tz = v.z + Math.cos(ang) * 1.05;
          if (Math.hypot(tx - c.x, tz - c.z) > 0.25) goTo(act, tx, tz, 1.2); else stand(act);
          lookAt(act, v.x, v.y + 1.4, v.z);
          setState(act, 'fight');
          act.mood = 'angry';
          act.memo.jab = (act.memo.jab ?? 1 + i) - dt;
          if (act.memo.jab < 0) { act.memo.jab = 1.8 + this.rng.float() * 1.6; play(act, act.armed === 'knife' && this.rng.chance(0.5) ? 'stab' : 'gesture_point', 0.7); }
        });
        if (this.phaseT > MUGGING.threatenFor && this.loot && this.loot.carrier === null && !this.loot.returned && crooks[0]) {
          // The wallet goes over.
          this.loot.carrier = crooks[0];
          crooks[0].actor!.held = crooks[0].actor!.armed === 'knife' ? 'knife' : 'wallet';
          if (v.actor) play(v.actor, 'pickup', 0.9);
        }
        if (this.phaseT > MUGGING.robFor) {
          // A shove, and off they go (walking: nobody chases).
          if (v.actor && this.rng.chance(0.6)) this.w.combat.hitActor(v, (v.x - crooks[0].x) * 260, 80, (v.z - crooks[0].z) * 260, 'shove', 'npc', crooks[0].x, crooks[0].z);
          for (const c of crooks) { setState(c.actor!, 'run'); c.actor!.face = null; c.actor!.memo.calm = 1; }
          this.go('escape');
        }
        break;
      }
      case 'escape':
      case 'subdued': {
        this.victimStaging(dt);
        if (this.reactToPlayer(crooks, dt)) break;
        for (const c of crooks) {
          const act = c.actor!;
          if (subdued(act) || act.state === 'down') continue;
          if (act.state === 'fight') this.fight(c, dt);
          else this.flee(c, dt);
        }
        break;
      }
      default:
        this.victimStaging(dt);
    }
  }

  private commit(): void {
    const v = this.victim!;
    this.adopt(v, 'victim', { hp: 32, maxHp: 32, strength: 0.4, mood: 'afraid', held: null });
    for (const c of this.criminals) if (c.actor) c.actor.hostile = true;
    this.shoutT = 1.2;
    this.w.sound('scream_single', v.x, v.y + 1.6, v.z, 0.6, 1.1);
    this.w.emit('cry', v.x, v.y + 1.6, v.z, 1.5, 30);
    if (!this.policeCalled) { this.policeCalled = true; this.w.callPolice(this, 26); }
    this.go('commit');
    this.emit('commit');
  }

  /**
   * The player confronts them (within 14 m): each mugger decides once per blow taken — fight,
   * flee (with the wallet) or surrender. Returns true when this took over the frame.
   */
  private reactToPlayer(crooks: PedAgent[], dt: number): boolean {
    const close = crooks.some((c) => this.distToPlayer(c) < 14);
    if (!close && !this.confronted) return false;
    if (close && !this.confronted) {
      this.confronted = true;
      this.playerInvolved = true;
      if (this.phase === 'commit') this.go('escape');
    }
    for (const c of crooks) {
      const act = c.actor!;
      if (subdued(act) || act.state === 'down') continue;
      if (act.memo.decHp !== act.hp) {
        act.memo.decHp = act.hp;
        const d = this.decide(c);
        act.memo.choice = d === 'surrender' ? 2 : d === 'fight' ? 1 : 0;
        // The one with the wallet runs first, the knife covers him.
        if (d === 'fight' && this.loot?.carrier === c && crooks.length > 1 && act.armed === 'none') act.memo.choice = 0;
        if (act.memo.choice === 1) this.emit('fight', c);
      }
      if (act.memo.choice === 2) { if (act.state !== 'surrender') this.surrender(c); continue; }
      if (act.memo.choice === 1 && this.distToPlayer(c) < 25) this.fight(c, dt);
      else { act.memo.panic = 4; this.flee(c, dt); }
    }
    return true;
  }

  /** Cowering with hands up, crying for help; afterwards sitting there shaken (or down). */
  private victimStaging(dt: number): void {
    const v = this.victim;
    if (!v || !v.actor || !v.alive) return;
    const va = v.actor;
    if (v.state === PState.Down) {
      // Shoved down: stays down — someone should help them up (handed to the help-up deeds).
      if (this.phase !== 'commit' && va.state !== 'ko') { release(v); v.downBy = 'other'; }
      return;
    }
    stand(va);
    const crook = this.criminals.find((c) => c.alive && c.actor && !subdued(c.actor) && Math.hypot(c.x - v.x, c.z - v.z) < 40);
    if (this.loot?.returned) {
      va.mood = 'happy';
      lookAt(va, this.w.player.x, this.w.player.y + 1.5, this.w.player.z);
      if (va.state !== 'cheer') { setState(va, 'cheer'); play(va, 'cheer', 2.6); }
      return;
    }
    if (this.phase === 'commit' || (crook && Math.hypot(crook.x - v.x, crook.z - v.z) < 4)) {
      setState(va, 'cower');
      va.mood = 'afraid';
      if (crook) lookAt(va, crook.x, crook.y + 1.5, crook.z);
      if (!va.action || va.action.id !== 'hands_up') play(va, 'hands_up', 3);
    } else if (crook) {
      setState(va, 'point');
      lookAt(va, crook.x, crook.y + 1.2, crook.z);
      if (!va.action || va.action.id !== 'gesture_point') play(va, 'gesture_point', 2.4);
    } else { va.mood = 'sad'; setState(va, 'idle'); }
    this.shoutT -= dt;
    if (this.shoutT <= 0 && (this.distToPlayer(v) < 60 || this.phase === 'commit') && this.t < 60) {
      this.shoutT = 3.5 + this.rng.float() * 2.5;
      this.w.sound('cry_help', v.x, v.y + 1.6, v.z, 0.75, v.cit.gender < 0.5 ? 1.05 : 0.8);
      this.w.emit('cry', v.x, v.y + 1.6, v.z, 1, 26);
    }
  }
}
