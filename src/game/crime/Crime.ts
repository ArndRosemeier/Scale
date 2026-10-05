/**
 * Crime base (PLAYGROUND_PLAN §4.1): a small state machine over real people.
 *
 *   approach → commit → escape (→ fight when cornered / surrender when outmatched)
 *            → subdued (KO'd or surrendered, waiting for the police) → resolved (arrested)
 *   … or failed (the criminals got away) / aborted (never happened: the site fell apart)
 *
 * Every crime owns its actors (criminals spawned out of view or converted walkers, a victim who
 * is a real passer-by, a shopkeeper), stages them so the situation reads without words (a scream,
 * pointing, a thief who sprints and looks back, witnesses who turn and film), and reports events
 * (KO, loot returned, resolved, failed) to the crime system, which pays karma and reputation.
 *
 * Generation is seeded (crime-local Rng from the director's roll); outcomes are live. All world
 * access goes through `CrimeWorld`, so a crime runs headless in tests with scripted time.
 */
import { Rng } from '../../core/rng';
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';
import type { StimulusKind } from '../Stimuli';
import type { Combat } from '../Combat';
import type { HurtKind } from '../PlayerHealth';
import { type Actor, type ActorRole, makeActor, attach, release, setState, play, followRoute, goTo, stand, lookAt, subdued, hold } from '../../sim/actors/Actor';
import { personStrength } from '../Consider';

export type CrimeKind = 'snatch' | 'mugging' | 'robbery' | 'racket' | 'tagging' | 'bomber';
/** Kinds only a villain group runs (factions): never rolled in nobody's turf. */
export const GROUP_KINDS: readonly CrimeKind[] = ['racket', 'tagging'];
export type CrimePhase = 'approach' | 'commit' | 'escape' | 'getaway' | 'subdued' | 'resolved' | 'failed' | 'aborted';
export type CrimeOutcome = 'arrested' | 'stopped' | 'escaped' | 'aborted';

export interface Loot {
  kind: 'bag' | 'wallet' | 'cash';
  x: number; y: number; z: number;
  /** Who it belongs to (returned to them). */
  owner: PedAgent | null;
  /** On the ground (null), carried by a criminal or by the player. */
  carrier: PedAgent | 'player' | null;
  returned: boolean;
  crime: number;
}

export interface CrimeEvent {
  type: 'commit' | 'ko' | 'surrender' | 'arrest' | 'returned' | 'resolved' | 'failed' | 'fight' | 'tagged';
  crime: Crime;
  who?: PedAgent;
}

export interface PlayerView {
  x: number; y: number; z: number;
  vx: number; vz: number;
  height: number;
  flying: boolean;
  /** Knocked down or out. */
  down?: boolean;
  /** Fighting strength (Con.playerStrength). */
  strength: number;
}

export interface CrimeWorld {
  /** Simulation time (s). */
  time: number;
  /** Hour of day 0..24. */
  hour: number;
  player: PlayerView;
  agents(): readonly PedAgent[];
  neighbours(x: number, z: number, r: number): PedAgent[];
  /** A synthetic citizen standing at a point (seed picks identity and look). */
  spawn(seed: number, x: number, z: number, heading: number, role: ActorRole): PedAgent | null;
  /** Sidewalk route between two points (Pedestrians.buildRoute). */
  route(ax: number, az: number, bx: number, bz: number): Float32Array | null;
  /** In the player's view (frustum and range)? */
  visible(x: number, y: number, z: number): boolean;
  emit(kind: StimulusKind, x: number, y: number, z: number, intensity: number, radius: number): void;
  sound(id: string, x: number, y: number, z: number, gain: number, pitch?: number): void;
  /** A positioned looping sound (alarm bell); null when audio is not running. */
  loop?(id: string, x: number, y: number, z: number, gain: number): { stop(): void } | null;
  combat: Combat;
  hurtPlayer(dmg: number, kind: HurtKind, fromX: number, fromZ: number): void;
  /** The police get a call (dispatch the nearest patrol car). */
  callPolice(c: Crime, delay: number): void;
  /** Live randomness for outcomes (not generation). */
  random(): number;
  /** Shop entrances (door point outside the wall and its outward normal) in a ring around the player. */
  shops?(rMin: number, rMax: number): { x: number; z: number; nx: number; nz: number }[];
  /** Building walls by a sidewalk (a door point outside the wall, its outward normal) in a ring around the player. */
  walls?(rMin: number, rMax: number): { x: number; z: number; nx: number; nz: number }[];
  /** A getaway car waiting at the kerb near a point (null: no road). */
  getaway?(x: number, z: number): GetawayCar | null;
  /** Officers on foot near a point (armed criminals turn on them). */
  officers?(x: number, z: number, r: number): PedAgent[];
  /**
   * A criminal's gun fired at the player or an officer — effects, damage (the player's through
   * PlayerHealth) and the stimulus are the world's. 'held': no clear shot (a wall, people in the line).
   */
  gunfire?(shooter: PedAgent, at: PedAgent | 'player'): 'hit' | 'miss' | 'held';
  /** A bomb lobbed from a person's hand to the ground at (x, z), going off after `fuse` s (crime/Bombs); false: none thrown. */
  bomb?(thrower: PedAgent, x: number, z: number, fuse: number): boolean;
  /** Cars (driving or parked, not wrecked) near a point. */
  cars?(x: number, z: number, r: number): { x: number; z: number }[];
}

/** Dev switches (dev.guns): every robbery and mugging has a gun. */
export const CRIME_DEV = { guns: false };

/**
 * Armed criminals with a gun (crime/Firearms GUNS.crook): mostly a threat — they aim, back off,
 * keep their distance — and shoot rarely: at a player who has hurt one of them, now and then at an
 * officer on their heels.
 */
export const GUNMAN = { keepMin: 4.5, keepMax: 13, gap: [2.6, 4.4], copEvery: [3, 6], copChance: 0.35, copR: 20, aimFor: 0.9 };

/** A car the robbers flee in (a traffic vehicle under the crime's control). */
export interface GetawayCar {
  readonly x: number;
  readonly z: number;
  readonly speed: number;
  /** Wrecked, crushed, frozen or badly damaged: they have to bail out. */
  readonly disabled: boolean;
  readonly alive: boolean;
  /** Pull away fast, away from (fx, fz). */
  drive(fx: number, fz: number): void;
  /** Hold still (doors open). */
  hold(): void;
  /** Hand the car back to traffic (or leave it standing as a wreck). */
  release(): void;
}

let NEXT_ID = 1;

export abstract class Crime {
  readonly id = NEXT_ID++;
  abstract readonly kind: CrimeKind;
  /** 1 street crime, 2 armed / organised (karma scale, con). */
  abstract readonly tier: number;
  phase: CrimePhase = 'approach';
  outcome: CrimeOutcome | null = null;
  /** Seconds since the crime began, and in the current phase. */
  t = 0;
  phaseT = 0;
  readonly rng: Rng;
  x = 0; z = 0;
  readonly criminals: PedAgent[] = [];
  readonly victims: PedAgent[] = [];
  readonly extras: PedAgent[] = [];
  loot: Loot | null = null;
  /** The player took part (hit a criminal, came close during the crime, returned the loot). */
  playerInvolved = false;
  /** Bystanders the player hurt while this crime ran (no-collateral bonus). */
  collateral = 0;
  /** The villain group behind it (factions/Factions: an operation in its turf); -1: nobody's. */
  faction = -1;
  /** Events for the crime system (drained every frame). */
  readonly events: CrimeEvent[] = [];
  /** Police have been called (the dispatcher may still be on the way). */
  policeCalled = false;
  /** Where the police should go (moves with the criminals). */
  readonly hot = { x: 0, z: 0 };
  /** Witnesses already staged (once each). */
  private staged = new WeakSet<PedAgent>();
  private stageT = 0;

  constructor(protected w: CrimeWorld, readonly seed: number) {
    this.rng = new Rng(seed);
  }

  /** Pick the site and the people; false when there is no fitting site now. */
  abstract setup(): boolean;
  protected abstract step(dt: number): void;

  get active(): boolean { return this.phase !== 'resolved' && this.phase !== 'failed' && this.phase !== 'aborted'; }
  get committed(): boolean { return this.phase !== 'approach' && this.phase !== 'aborted'; }

  protected go(p: CrimePhase): void {
    if (this.phase === p) return;
    this.phase = p;
    this.phaseT = 0;
  }

  update(dt: number): void {
    if (!this.active) return;
    this.t += dt;
    this.phaseT += dt;
    // Agents that vanished (despawned by something else, crushed) leave the crime.
    for (const list of [this.criminals, this.victims, this.extras]) {
      for (let i = list.length - 1; i >= 0; i--) if (!list[i].alive) { if (list[i].actor && list[i].actor!.state !== 'arrested') setState(list[i].actor!, 'gone'); }
    }
    this.step(dt);
    if (!this.active) return;
    // KO / surrender bookkeeping, loot dropping, the end states.
    for (const c of this.criminals) {
      const act = c.actor;
      if (!act) continue;
      if ((act.state === 'ko' || act.state === 'surrender') && !act.memo.down) {
        act.memo.down = 1;
        this.dropLoot(c);
        this.emit(act.state === 'ko' ? 'ko' : 'surrender', c);
      }
    }
    const crooks = this.criminals.filter((c) => c.actor && c.actor.state !== 'gone');
    if (this.committed && this.phase !== 'getaway') {
      if (crooks.length === 0 || this.criminals.every((c) => !c.actor || c.actor.state === 'gone' || c.actor.state === 'arrested' || c.actor.memo.escaped)) {
        const arrested = this.criminals.some((c) => c.actor?.state === 'arrested');
        const escaped = this.criminals.some((c) => c.actor?.memo.escaped || c.actor?.state === 'gone');
        if (arrested) this.finish('arrested');
        else if (escaped) this.finish('escaped');
        else this.finish('aborted');
      } else if (crooks.every((c) => subdued(c.actor!))) {
        if (this.phase !== 'subdued') this.go('subdued');
        // Nobody came for them: they come round and slink away (no arrest).
        if (this.phaseT > 150) this.finish('stopped');
      }
    }
    if (this.committed) this.stageWitnesses(dt);
    // The police go where the criminals are.
    const lead = crooks.find((c) => !subdued(c.actor!)) ?? crooks[0];
    if (lead) { this.hot.x = lead.x; this.hot.z = lead.z; }
  }

  protected emit(type: CrimeEvent['type'], who?: PedAgent): void {
    this.events.push({ type, crime: this, who });
  }

  /** Police cuff a subdued criminal. */
  arrest(c: PedAgent): void {
    const act = c.actor;
    if (!act || act.state === 'arrested') return;
    if (c.state === PState.Down) { c.state = PState.Idle; c.stateT = 0; }
    setState(act, 'arrested');
    act.goal = null;
    act.hostile = false;
    play(act, 'pray', 600);
    this.dropLoot(c);
    this.emit('arrest', c);
  }

  protected finish(o: CrimeOutcome): void {
    if (!this.active) return;
    this.outcome = o;
    this.go(o === 'arrested' || o === 'stopped' ? 'resolved' : o === 'aborted' ? 'aborted' : 'failed');
    this.emit(o === 'arrested' || o === 'stopped' ? 'resolved' : 'failed');
  }

  /** Abort before anything happened (site lost, budget). */
  abort(): void {
    if (this.committed) return;
    this.outcome = 'aborted';
    this.go('aborted');
  }

  /**
   * Hand everyone back: criminals who are still standing and out of sight vanish, arrested
   * ones are taken by the police (they remove them), the rest return to their day.
   */
  dispose(keepVictims = false): void {
    for (const c of this.criminals) {
      const act = c.actor;
      if (!act || act.state === 'arrested') continue; // the police take the arrested
      if (!c.alive) continue;
      // Out of sight: gone. In sight: they come round (if down) and walk off.
      if (!this.w.visible(c.x, c.y + 1, c.z) || this.distToPlayer(c) > 150) { c.alive = false; continue; }
      if (c.state === PState.Down) c.state = PState.Idle;
      release(c);
    }
    if (!keepVictims) this.releaseVictims();
  }

  /** The victim and others (shopkeeper) go back to their day. */
  releaseVictims(): void {
    for (const v of [...this.victims, ...this.extras]) if (v.actor && v.actor.owner === this.id) release(v);
  }

  // ------------------------------------------------------------------ people

  /** Attach an actor to a real walker. */
  protected adopt(a: PedAgent, role: ActorRole, o: Partial<Actor> = {}): Actor {
    if (role === 'victim' && !this.victims.includes(a)) this.victims.push(a);
    else if (role !== 'criminal' && !this.extras.includes(a)) this.extras.push(a);
    return attach(a, makeActor(role, this.id, o));
  }

  /** A spawned citizen owned by this crime (its actor's owner is the crime). */
  protected spawnOwned(seed: number, x: number, z: number, heading: number, role: ActorRole): PedAgent | null {
    const a = this.w.spawn(seed, x, z, heading, role);
    if (a?.actor) a.actor.owner = this.id;
    return a;
  }

  /** A criminal out of view near (x, z) (or a converted walker), facing the heading. */
  protected spawnCriminal(x: number, z: number, heading: number, o: Partial<Actor>): PedAgent | null {
    const seed = this.rng.nextU32();
    const a = this.w.spawn(seed, x, z, heading, 'criminal');
    if (!a) return null;
    const act = a.actor ?? this.adopt(a, 'criminal');
    Object.assign(act, makeActor('criminal', this.id, o), { held: o.held ?? null });
    a.actor = act;
    this.criminals.push(a);
    return a;
  }

  /** Walkers that fit (alive, outside, walking on the sidewalk, not already taken). */
  protected walkers(x: number, z: number, r: number, adultsOnly = false): PedAgent[] {
    return this.w.neighbours(x, z, r).filter((a) => a.alive && !a.inside && !a.actor && a.state === PState.Walk && !a.onRoad && (!adultsOnly || a.cit.role !== 0));
  }

  protected distToPlayer(a: { x: number; z: number }): number {
    return Math.hypot(a.x - this.w.player.x, a.z - this.w.player.z);
  }

  /** The player is close and in the open (criminals react to them). */
  protected playerNear(a: { x: number; z: number }, r: number): boolean {
    const p = this.w.player;
    return this.distToPlayer(a) < r && (!p.flying || p.y - 0 < 40);
  }

  /** Strength of a criminal with friends from the same crime around (con, fight-or-flight). */
  protected strengthOf(c: PedAgent): number {
    const friends = this.criminals.filter((o) => o !== c && o.actor && !subdued(o.actor) && Math.hypot(o.x - c.x, o.z - c.z) < 15).length;
    return personStrength(c, friends);
  }

  // ------------------------------------------------------------------ shared criminal behaviour

  /**
   * Escape on foot with replanning: a sidewalk route to a point well away from the player,
   * renewed when the player cuts across it. Sprints while chased (stamina), walks to blend in
   * when nobody follows, looks back over the shoulder. Returns false when the criminal got away.
   */
  protected flee(c: PedAgent, dt: number): boolean {
    const act = c.actor!;
    const p = this.w.player;
    if (this.turnOnPolice(c, dt)) return true;
    if (act.action?.id === 'aim_pistol') act.action = null;
    const d = this.distToPlayer(c);
    const ps = Math.hypot(p.vx, p.vz);
    // Chased: the player is close, or closing in at a run.
    const toC = { x: c.x - p.x, z: c.z - p.z };
    const closing = ps > 2.5 && (p.vx * toC.x + p.vz * toC.z) / (ps * (d || 1)) > 0.6;
    const chased = d < 22 || (d < 70 && closing) || act.memo.panic > 0;
    act.memo.panic = Math.max(0, (act.memo.panic ?? 0) - dt);
    act.memo.stamina = (act.memo.stamina ?? 14) + (chased ? -dt : dt * 0.35);
    act.memo.stamina = Math.min(14, act.memo.stamina);
    const sprint = act.memo.stamina > 0 ? 5.05 : 3.9;
    const speed = chased ? sprint : act.stateT < 6 ? 4.6 : 1.75;
    // Replan: no route, route used up, or the player stands in the way.
    const R = act.route;
    let blocked = false;
    if (R && act.wp < R.length / 3) {
      const tx = R[act.wp * 3] - c.x, tz = R[act.wp * 3 + 1] - c.z, tl = Math.hypot(tx, tz) || 1;
      blocked = d < 30 && (-toC.x * tx - toC.z * tz) / ((d || 1) * tl) > 0.55;
    }
    if (!R || act.wp >= R.length / 3 || (blocked && act.replanT <= 0)) {
      act.replanT = 3;
      // Away from the player (or from the scene when the player is far), with some spread.
      let ax = c.x - p.x, az = c.z - p.z;
      if (d > 120) { ax = c.x - this.x; az = c.z - this.z; }
      const al = Math.hypot(ax, az) || 1;
      const turn = (this.rng.float() - 0.5) * 1.6;
      const ux = (ax / al) * Math.cos(turn) - (az / al) * Math.sin(turn), uz = (ax / al) * Math.sin(turn) + (az / al) * Math.cos(turn);
      const route = this.w.route(c.x, c.z, c.x + ux * 220, c.z + uz * 220);
      act.route = route; act.wp = 1;
      if (!route) goTo(act, c.x + ux * 30, c.z + uz * 30, speed);
    }
    if (act.route) followRoute(c, act, speed);
    else if (act.goal) act.speed = speed;
    setState(act, 'run');
    act.mood = chased ? 'afraid' : 'focused';
    // Looks back now and then (head turns to the player).
    act.memo.lookT = (act.memo.lookT ?? 1.5) - dt;
    if (act.memo.lookT < 0) { act.memo.lookT = chased ? 1.2 + this.rng.float() : 2.5 + this.rng.float() * 2; act.memo.looking = 0.7; }
    act.memo.looking = Math.max(0, (act.memo.looking ?? 0) - dt);
    act.face = act.memo.looking > 0 ? { x: p.x, y: p.y + p.height * 0.8, z: p.z } : null;
    // Got away: long gone and out of sight, or very far.
    const away = (this.t > 90 && d > 110 && !this.w.visible(c.x, c.y + 1, c.z)) || d > 330;
    if (away) { act.memo.escaped = 1; setState(act, 'gone'); c.alive = false; return false; }
    return true;
  }

  /**
   * Fight the player: close in, then punch / stab / swing with a cooldown. Damage lands after a
   * wind-up if the player is still in reach (so dodging works).
   */
  protected fight(c: PedAgent, dt: number): void {
    const act = c.actor!;
    const p = this.w.player;
    // The player is down: done here, run (until hit again).
    if (p.down) { act.memo.choice = 0; act.memo.decHp = act.hp; act.memo.panic = 3; setState(act, 'run'); if (act.action?.id === 'aim_pistol') act.action = null; return; }
    // A gun: keep off and aim (a pistol-whip only when the player is right there).
    if (act.armed === 'gun' && this.distToPlayer(c) > 1.8) { this.gunFight(c, dt); return; }
    if (act.action?.id === 'aim_pistol') act.action = null;
    setState(act, 'fight');
    act.mood = 'angry';
    act.hostile = true;
    const d = this.distToPlayer(c);
    // At most two at a time get stuck in; the others circle at a few metres, waiting for a gap.
    const closer = this.criminals.filter((o) => o !== c && o.alive && o.actor?.state === 'fight' && this.distToPlayer(o) < d).length;
    if (closer >= 2) {
      lookAt(act, p.x, p.y + p.height * 0.8, p.z);
      const ang = Math.atan2(c.x - p.x, c.z - p.z) + 0.4;
      goTo(act, p.x + Math.sin(ang) * 3.2, p.z + Math.cos(ang) * 3.2, 1.6);
      return;
    }
    lookAt(act, p.x, p.y + p.height * 0.8, p.z);
    if (d > 1.15) goTo(act, p.x, p.z, d > 6 ? 4.6 : 2.6);
    else stand(act);
    const pending = act.memo.windup ?? 0;
    if (pending > 0) {
      act.memo.windup = pending - dt;
      if (act.memo.windup <= 0) {
        act.memo.windup = 0;
        if (this.distToPlayer(c) < 1.75 && act.staggerT <= 0 && c.state !== PState.Down && Math.abs(p.y - c.y) < 1.6) {
          const kind = act.armed === 'knife' ? 'knife' : act.armed === 'bat' ? 'bat' : 'punch';
          const dmg = (kind === 'knife' ? 15 : kind === 'bat' ? 13 : 7) * (0.8 + 0.4 * this.w.random()) * Math.sqrt(act.strength);
          this.w.hurtPlayer(dmg, kind, c.x, c.z);
          this.w.sound('punch_impact', p.x, p.y + 1.2, p.z, 0.7, kind === 'knife' ? 1.4 : 1);
        }
      }
    } else if (d < 1.6 && act.attackT <= 0 && act.staggerT <= 0) {
      act.attackT = (act.armed === 'none' ? 1.1 : 1.25) + this.w.random() * 0.45;
      act.memo.windup = 0.32;
      play(act, act.armed === 'knife' ? 'stab' : act.armed === 'bat' ? 'swing_1h' : this.w.random() < 0.7 ? 'punch' : 'kick', 0.7);
    }
  }

  /** An armed criminal gives up under police fire (Police.workCrime). */
  yieldTo(c: PedAgent): void {
    if (c.actor && !subdued(c.actor) && c.state !== PState.Down) this.surrender(c);
  }

  /** The player has hurt one of this crime's criminals (an armed one may shoot back). */
  protected get playerAttacked(): boolean { return this.criminals.some((c) => c.actor?.hitByPlayer); }

  /**
   * A gunman facing the player: keeps a few metres off (backs away, comes on), aims, and shoots
   * only at a player who has hurt one of them — otherwise the gun is a threat.
   */
  protected gunFight(c: PedAgent, dt: number): void {
    const act = c.actor!, p = this.w.player, G = GUNMAN;
    setState(act, 'fight');
    act.mood = 'angry';
    act.hostile = true;
    act.held = 'pistol';
    const d = this.distToPlayer(c);
    // An officer closing in (nearer than the player) draws the gun instead (looked for once a second).
    act.memo.copScanT = (act.memo.copScanT ?? 0) - dt;
    if (act.memo.copScanT <= 0 && this.w.officers) {
      act.memo.copScanT = 1;
      const cop = this.w.officers(c.x, c.z, Math.min(G.copR, d)).sort((a, b) => Math.hypot(a.x - c.x, a.z - c.z) - Math.hypot(b.x - c.x, b.z - c.z))[0];
      act.memo.copId = cop ? cop.id : 0;
    }
    const cop = act.memo.copId && this.w.officers ? this.w.officers(c.x, c.z, G.copR + 4).find((o) => o.id === act.memo.copId) : undefined;
    const tx = cop ? cop.x : p.x, tz = cop ? cop.z : p.z, td = cop ? Math.hypot(cop.x - c.x, cop.z - c.z) : d;
    lookAt(act, tx, cop ? cop.y + 1.3 : p.y + Math.min(p.height * 0.7, 1.3), tz);
    // Keep a few metres off the player: back away when they close in, come on when far.
    const ax = c.x - p.x, az = c.z - p.z, al = Math.hypot(ax, az) || 1;
    if (d < G.keepMin) { goTo(act, c.x + (ax / al) * 3, c.z + (az / al) * 3, 3.2); if (act.action?.id === 'aim_pistol') act.action = null; }
    else if (d > G.keepMax && !cop) { goTo(act, p.x + (ax / al) * 9, p.z + (az / al) * 9, 3.4); if (act.action?.id === 'aim_pistol') act.action = null; }
    else { stand(act); hold(act, 'aim_pistol'); }
    act.memo.gunT = (act.memo.gunT ?? 0.8 + this.w.random() * 1.2) - dt;
    if (act.memo.gunT > 0 || d < G.keepMin || td > 24 || !act.action) return;
    act.memo.gunT = G.gap[0] + this.w.random() * (G.gap[1] - G.gap[0]);
    if (!this.w.gunfire || act.staggerT > 0) return;
    // Rarely: at an officer now and then, at the player only once they have hurt one of them.
    if (cop) { if (this.w.random() < G.copChance + 0.15 && this.w.gunfire(c, cop) !== 'held') act.memo.shotAt = this.t + 1e-3; return; }
    if (!this.playerAttacked) return;
    if (this.w.gunfire(c, 'player') !== 'held') act.memo.shotAt = this.t + 1e-3;
  }

  /**
   * On the run with a gun: now and then turn on an officer close behind and fire (true while
   * doing so: the caller leaves the frame to it).
   */
  protected turnOnPolice(c: PedAgent, dt: number): boolean {
    const act = c.actor!, G = GUNMAN;
    if (act.armed !== 'gun' || !this.w.officers || !this.w.gunfire) return false;
    act.memo.copT = (act.memo.copT ?? G.copEvery[0]) - dt;
    if (act.memo.copT <= 0 && !(act.memo.aimT > 0)) {
      act.memo.copT = G.copEvery[0] + this.w.random() * (G.copEvery[1] - G.copEvery[0]);
      const cops = this.w.officers(c.x, c.z, G.copR);
      if (cops.length && this.w.random() < G.copChance) { act.memo.aimT = G.aimFor; act.memo.copId = cops[0].id; act.memo.fired = 0; }
    }
    if (!(act.memo.aimT > 0)) return false;
    const cop = this.w.officers(c.x, c.z, G.copR + 6).find((o) => o.id === act.memo.copId);
    if (!cop) { act.memo.aimT = 0; return false; }
    act.memo.aimT -= dt;
    stand(act);
    // ('point', not 'fight': the crimes send fighters after the player.)
    setState(act, 'point');
    act.held = 'pistol';
    lookAt(act, cop.x, cop.y + 1.3, cop.z);
    hold(act, 'aim_pistol');
    if (act.memo.aimT < G.aimFor * 0.45 && !act.memo.fired) {
      act.memo.fired = 1;
      if (this.w.gunfire(c, cop) !== 'held') act.memo.shotAt = this.t + 1e-3;
    }
    if (act.memo.aimT <= 0) act.action = null;
    return true;
  }

  /** Give up: hands up, stand still (the police cuff them). */
  protected surrender(c: PedAgent): void {
    const act = c.actor!;
    setState(act, 'surrender');
    act.hostile = false;
    act.goal = null;
    act.route = null;
    act.mood = 'afraid';
    play(act, 'hands_up', 600);
    this.dropLoot(c);
  }

  /**
   * Fight or flight when the player confronts a criminal: outmatched → flee (or surrender if
   * cornered and unarmed), the player is weaker and they are armed / in a group → fight.
   */
  protected decide(c: PedAgent): 'fight' | 'flee' | 'surrender' {
    const act = c.actor!;
    const ratio = this.strengthOf(c) / Math.max(0.1, this.w.player.strength);
    const hurt = act.hp < act.maxHp * 0.45;
    if (ratio < 0.3 && this.distToPlayer(c) < 5) return 'surrender';
    if (hurt && act.armed === 'none' && this.distToPlayer(c) < 3) return act.memo.brave ? 'fight' : 'surrender';
    if (ratio > 1.25 && act.armed !== 'none') return 'fight';
    if (ratio > 1.6) return 'fight';
    return 'flee';
  }

  /** The loot falls where the criminal stands (bag on the pavement). */
  protected dropLoot(c: PedAgent): void {
    const L = this.loot;
    if (!L || L.carrier !== c) return;
    L.carrier = null;
    L.x = c.x + Math.sin(c.heading) * 0.5; L.z = c.z + Math.cos(c.heading) * 0.5; L.y = c.y;
    if (c.actor) c.actor.held = null;
  }

  /** Witnesses near a running criminal turn their heads; the curious point and film. */
  private stageWitnesses(dt: number): void {
    this.stageT -= dt;
    if (this.stageT > 0) return;
    this.stageT = 0.5;
    for (const c of this.criminals) {
      const act = c.actor;
      if (!act || act.state === 'gone' || act.state === 'arrested' || !c.alive) continue;
      for (const o of this.w.neighbours(c.x, c.z, act.state === 'fight' ? 18 : 12)) {
        if (o === c || o.actor || o.inside || o.state === PState.Down || this.staged.has(o)) continue;
        this.staged.add(o);
        o.lookX = c.x; o.lookY = c.y + 1.2; o.lookZ = c.z;
        if (act.state === 'fight' || act.state === 'ko') {
          // A fight: people back off and film from a distance.
          if (o.cit.nerve > 0.6) { o.fear = Math.min(2, o.fear + 0.7); o.fearX = c.x; o.fearZ = c.z; o.state = PState.Flee; o.stateT = 0; }
          else { o.state = o.cit.curiosity > 0.45 ? PState.Film : PState.Gawk; o.stateT = 0; }
        } else if (o.cit.curiosity > 0.65) { o.state = PState.Film; o.stateT = 0; }
        else o.glance = 1.6;
      }
    }
  }

  /** Serializable summary (tests, dev console). */
  snapshot(): { id: number; kind: CrimeKind; faction: number; phase: CrimePhase; outcome: CrimeOutcome | null; t: number; x: number; z: number; criminals: { state: string; hp: number; x: number; z: number }[]; loot: string | null } {
    return {
      id: this.id, kind: this.kind, faction: this.faction, phase: this.phase, outcome: this.outcome, t: Math.round(this.t * 10) / 10, x: Math.round(this.x), z: Math.round(this.z),
      criminals: this.criminals.map((c) => ({ state: c.actor?.state ?? '-', hp: Math.round(c.actor?.hp ?? 0), x: Math.round(c.x), z: Math.round(c.z) })),
      loot: this.loot ? (this.loot.returned ? 'returned' : this.loot.carrier === 'player' ? 'player' : this.loot.carrier ? 'criminal' : 'ground') : null,
    };
  }
}

export { stand, goTo, lookAt, play, setState, followRoute, release, subdued };
