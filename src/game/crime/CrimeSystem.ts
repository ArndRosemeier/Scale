/**
 * The street-crime layer in the game ("Street Hero", PLAYGROUND_PLAN §5 Phase 1): ties the director,
 * the crimes, the police, justice, combat, the player's health, reputation and the small deeds to
 * the living city, and draws what belongs to it (dropped loot, a caret over a fleeing criminal, map
 * marks, the crime-index map layer, health / reputation / wanted in the HUD).
 *
 * Rewards (Normal mode; karma, reputation):
 *   knocking out a criminal yourself   per kind (crime/kinds: snatch 8 · mugging 10 · robbery 14 …), +2 rep
 *   a criminal giving up to you        6 karma, +1 rep
 *   the crime stopped with your help   per kind (snatch 10 · mugging 15 · robbery 25 …; +25 % with no
 *                                      bystander hurt), its reputation, the crowd cheers
 *   returning the stolen bag / wallet  8 karma, +2 rep
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import { aimDir } from '../aimRay';
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';
import type { Vehicle, VKind } from '../../sim/Traffic';
import { VState } from '../../sim/Traffic';
import { Role, doorOf, type Citizen } from '../../sim/Population';
import { cityOutfit } from '../../humanoid/client/wardrobe';
import { hash32 } from '../../core/rng';
import { pointInPoly } from '../../core/geom2';
import { statusOf } from '../../shared/status';
import { makeActor, attach, setState, tickActor, AFTERMATH_OWNER, STREET_OWNER, type ActorRole } from '../../sim/actors/Actor';
import { Combat } from '../Combat';
import { PlayerHealth, type HurtKind } from '../PlayerHealth';
import { Reputation } from '../Reputation';
import { CON_COLOR, conLevel, personStrength, playerStrength } from '../Consider';
import { crimeIndex, SETTING_MAX, type CrimeSetting } from './CrimeIndex';
import { CrimeDirector, type CrimeRoll } from './CrimeDirector';
import { Crime, CRIME_DEV, GROUP_KINDS, type CrimeKind, type CrimeWorld, type GetawayCar, type Loot, type PlayerView } from './Crime';
import { Robbery } from './Robbery';
import { Tagging, TAGGING } from './Tagging';
import { TurfBrawl } from './TurfBrawl';
import { HideoutGuard } from './HideoutGuard';
import { Ritual, type RitualElement } from './Ritual';
import { Channeling } from './Channeling';
import { HijackedFleet } from './HijackedFleet';
import { KINDS } from './kinds';
import { Police, policeOutfit, POLICE } from './Police';
import { Justice } from './Justice';
import { Firearms, GUNS, MUZZLE_Y, gunJ, type GunSpec } from './Firearms';
import { Bombs } from './Bombs';
import { VillainCasts } from './VillainCasts';
import { VILLAIN_POWERS, type VillainPower } from '../powers/Caster';
import { SmallDeeds, type SmallDeedKind } from '../deeds/SmallDeeds';
import { makeItem, makeGlint } from '../deeds/critters';
import type { MapMarker } from '../../ui/map/GameMap';
import type { Target } from '../Targeting';
import type { StreetProp } from '../../props/PropRenderer';
import { CrimeHud } from '../../ui/CrimeHud';
import { ABILITIES } from '../abilities/defs';
import { planFactions, inSentence, shift, saveFactions, restoreFactions, drift, rivalsAt, relation, SHIFT, DRIFT, HOLD, type Faction, type FactionMap } from '../factions/Factions';
import { planHideouts, hideoutCell, pickDoor, saveHideouts, restoreHideouts, HIDEOUTS, type Hideout } from '../factions/Hideouts';
import { Graffiti, type Tag } from '../factions/Graffiti';
import { ARCHETYPES, CITY_GROUPS } from '../factions/archetypes';
import { siteToWorld } from '../../plan/landmarks';
import { RState } from '../../future/Robots';
import { factionOutfit, lieutenantOutfit } from '../factions/outfits';

/** Rewards common to every kind (the per-kind ones are in crime/kinds). */
export const CRIME_KARMA = {
  surrender: 6,
  cleanBonus: 0.25,
  returned: 8,
};


export const ACTOR_BUDGET = 40;
const SETTING_KEY = 'scale.crime.setting';

/** Names shown on the target frame for actors (the frame is the one place a role is named). */
/** A cult's element by its colours. */
const RITUAL_ELEMENT: Record<string, RitualElement> = { ember: 'fire', frost: 'frost', violet: 'storm' };
const ROLE_NAME: Record<string, string> = { police: 'Police officer', shopkeeper: 'Shopkeeper', soldier: 'Soldier' };

const _v = new THREE.Vector3();

export class CrimeSystem {
  readonly combat: Combat;
  /** Small arms (police, SWAT, armed robbers): rules, effects (crime/Firearms). */
  readonly guns: Firearms;
  /** Villains' bombs (the mad bomber): in flight, on a lit fuse, going off (crime/Bombs). */
  readonly bombs: Bombs;
  /** Lieutenants' powers in the world: tells, beams, orbs, cracks, flashes (crime/VillainCasts). */
  readonly casts: VillainCasts;
  /** Machines turned by a techno-cult hack (crime/Hijack), until they reboot. */
  readonly fleets: HijackedFleet[] = [];
  private fleetKey = '';
  /** Dev: the next crime's group sends its lieutenant (dev.crime(kind, dist, group, 'lt')). */
  private devLieutenant = false;
  readonly health: PlayerHealth;
  readonly rep: Reputation;
  readonly director: CrimeDirector;
  readonly police: Police;
  readonly justice: Justice;
  readonly deeds: SmallDeeds;
  readonly crimes: Crime[] = [];
  readonly index: Float32Array;
  /** The city's villain groups and their turf (VILLAINS_PLAN, Phase 1). */
  readonly factions: FactionMap;
  /** Gang tags on the walls (factions/Graffiti). */
  readonly graffiti: Graffiti;
  /** Villain group results (saved with the turf): operations stopped, come off, tags finished, cells lost, brawls, busts. */
  factionStats: Record<string, number> = { stopped: 0, succeeded: 0, tags: 0, lost: 0, gained: 0, brawls: 0, busts: 0, drifted: 0 };
  /** Each group's hideout (factions/Hideouts; saved with the turf). */
  hideouts: Hideout[];
  /** Guards posted at a hideout, by faction id. */
  private guards = new Map<number, HideoutGuard>();
  /** Groups whose hideout has had its guards posted since the player came near (not again until they leave). */
  private posted = new Set<number>();
  /** The last game hour the turf drifted (off-screen drift, once per hour). */
  private driftHour = -1;
  private hideT = 0;
  private hideKey = '';
  readonly hud: CrimeHud;
  /** Loot lying about or carried (outlives its crime for a while). */
  private loots: { loot: Loot; crime: Crime; obj: THREE.Group; glint: THREE.Sprite; endT: number }[] = [];
  readonly group = new THREE.Group();
  time = 0;
  private frustum = new THREE.Frustum();
  private m4 = new THREE.Matrix4();
  readonly view: PlayerView = { x: 0, y: 0, z: 0, vx: 0, vz: 0, height: 1.8, flying: false, strength: 1 };
  private world: CrimeWorld;
  private markT = 0;
  private markKey = '';
  private repT = 0;
  private tackleT = 0;
  private warmT = 0;
  private devDone = false;
  private wake: { x: number; y: number; z: number } | null = null;
  actorCount = 0;
  stats = { started: 0, resolved: 0, failed: 0, aborted: 0, kos: 0, msAvg: 0 };

  constructor(private g: Game) {
    const seed = g.settings.seed;
    this.index = crimeIndex(g.macro, seed);
    g.map.world.crimeIndex = this.index;
    this.factions = planFactions(g.macro, seed, this.index, CITY_GROUPS);
    this.hideouts = planHideouts(this.factions);
    g.map.setTurf(this.factions);
    this.graffiti = new Graffiti((a) => this.factions.factions.find((f) => f.archetype === a) ?? null);
    g.renderer.scene.add(this.graffiti.group);
    g.map.tiles.invalidate();
    this.combat = new Combat({
      knockDown: (a, fx, fz, power, cause) => g.reactions.knockDown(a, fx, fz, power, cause),
      record: (power, target, effect, x, z, ref) => this.record(power, target, effect, x, z, ref),
      sound: (id, x, y, z, gain, pitch) => this.sound(id, x, y, z, gain, pitch),
    });
    g.reactions.onKnockDown = (a, fx, fz, power, cause) => {
      this.combat.knocked(a, fx, fz, power, cause);
      // Knocked down by the player without a power entry (a giant's feet, a blast): on the ledger.
      if (cause === 'player') this.record('body', 'person', 'knockdown', a.x, a.z, a);
    };
    this.guns = new Firearms(g);
    this.bombs = new Bombs(g);
    this.bombs.hurtPlayer = (d, k, fx, fz) => this.hurtPlayer(d, k, fx, fz);
    this.casts = new VillainCasts(g);
    this.casts.hurtPlayer = (d, k, fx, fz) => this.hurtPlayer(d, k, fx, fz);
    this.health = new PlayerHealth(g.player, g.mode === 'sandbox');
    this.rep = new Reputation(seed, g.settings.size, g.mode);
    this.world = this.makeWorld();
    const self = this;
    this.police = new Police({
      get time() { return self.time; },
      player: this.view,
      traffic: g.traffic,
      combat: this.combat,
      spawnOfficer: (s, x, z, h) => this.spawn(s, x, z, h, 'police'),
      route: (ax, az, bx, bz) => g.peds.buildRoute(ax, az, bx, bz),
      visible: (x, y, z) => this.visible(x, y, z),
      sound: (id, x, y, z, gain, pitch) => this.sound(id, x, y, z, gain, pitch),
      sirenLoop: () => g.audio.loop('siren_loop', 14),
      emit: (k, x, y, z, i, r) => g.stimuli.emit(k, x, y, z, i, r),
      hurtPlayer: (d, k, fx, fz) => this.hurtPlayer(d, k, fx, fz),
      playerDown: () => g.player.downT > 0 || this.health.down,
      arrestPlayer: () => this.playerArrested(),
      wanted: () => this.justice.wanted,
      guns: this.guns,
      gunAt: (o, c, spec) => this.gunAt(o, c, spec),
      gunAtPlayer: (o, spec, car) => this.gunAtPlayer(o, spec, car),
    });
    this.justice = new Justice({
      get time() { return self.time; },
      player: this.view,
      witnesses: (x, z, r, except) => this.witnesses(x, z, r, except),
      officersNear: (x, z, r) => this.officersNear(x, z, r),
      karma: (n, reason) => g.progress.addKarma(n, reason),
      rep: (d, reason) => this.rep.add(d, reason),
      repValue: () => this.rep.value,
      pursue: (lvl) => this.police.pursuePlayer(lvl),
      toast: (html, kind) => g.powerHud.toast(html, kind),
      get noKarma() { return g.progress.sandbox; },
      sound: (id, gain) => g.audio.play2d(id, gain),
      hostileThing: (ref) => g.threats?.isHostile(ref) ?? false,
    });
    g.consequences.onRecord = (e) => {
      this.justice.record(e);
      const a = e.ref as PedAgent | undefined;
      if (e.cause === 'player' && e.target === 'person' && a && a.actor?.role !== 'criminal') for (const c of this.crimes) if (c.committed) c.collateral++;
    };
    this.director = new CrimeDirector(seed, {
      hoursAbs: () => g.sky.hoursAbs,
      playerCell: () => this.playerCell(),
      activeCount: () => this.crimes.filter((c) => c.active).length,
      start: (r) => this.startRoll(r),
    });
    this.director.setting = loadSetting();
    this.combat.onHit = (a, r, source) => {
      const act = a.actor;
      if (source === 'player' && act?.role === 'criminal') {
        const c = this.crimeOf(a);
        if (c) c.playerInvolved = true;
      }
      if (source === 'player' && r.effect !== 'none') g.audio.play('punch_impact', a.x, a.y + 1.1, a.z, r.effect === 'stagger' ? 0.55 : 0.8, r.effect === 'ko' ? 0.8 : 1, 5, g.renderer.camera.position);
    };
    this.deeds = new SmallDeeds({
      seed,
      time: () => this.time,
      hoursAbs: () => g.sky.hoursAbs,
      player: g.player,
      peds: g.peds,
      scene: this.group,
      trees: (x, z, r) => { const out: StreetProp[] = []; g.props.query(x, z, r, (p) => { if (p.tree && !p.broken && p.kind.startsWith('tree:')) out.push(p); }); return out; },
      route: (ax, az, bx, bz) => g.peds.buildRoute(ax, az, bx, bz),
      spawn: (s, x, z, h) => this.spawn(s, x, z, h, 'owner'),
      ground: (x, z) => g.world.groundHeight(x, z),
      inBuilding: (x, z) => !!g.world.buildingAt(x, z),
      visible: (x, y, z) => this.visible(x, y, z),
      sound: (id, x, y, z, gain, pitch) => this.sound(id, x, y, z, gain, pitch),
      reward: (k, r, reason) => { g.progress.addKarma(k, reason); this.rep.add(r, reason); this.rep.count('deeds'); this.justice.atone(0.8); },
      markers: (m) => g.map.setMarkers('smalldeeds', m),
      busy: () => this.crimes.some((c) => c.active && c.committed),
    });
    this.deeds.enabled = this.director.setting !== 'off';
    g.renderer.scene.add(this.group);
    // Health: falls, cars, collapses.
    const land = g.player.events.onLand;
    g.player.events.onLand = (x, y, z, e, h) => { land?.(x, y, z, e, h); this.health.land(e, g.player.landedLeap > 0); };
    g.stimuli.on((s) => {
      if (s.kind !== 'collapse') return;
      const d = Math.hypot(s.x - g.player.pos.x, s.z - g.player.pos.z);
      const r = Math.min(40, Math.max(8, s.radius * 0.04));
      if (d < r && Math.abs(s.y - g.player.pos.y) < 30) this.health.damage(35 * (1 - d / r) + 10, 'collapse', s.x, s.z);
    });
    this.health.onHurt = (d, kind, fx, fz) => {
      g.camRig.addShake(Math.min(0.5, 0.1 + d / 60));
      if (kind !== 'fall') g.player.action = { id: d > 15 ? 'stagger' : 'flinch', t0: g.player.animClock, dur: 0.6 };
      void fx; void fz;
    };
    this.health.onKnockout = (kind) => this.knockedOut(kind);
    this.health.onWake = () => this.wakeUp();
    this.hud = new CrimeHud(g, this);
    // Karma toasts for misdeeds that Justice does not announce itself.
    g.progress.onKarma((amount, reason) => { if (amount < 0 && !/turned yourself in|arrested|bystander|car|officer|gave up/.test(reason)) g.powerHud.toast(`<b>${amount} karma</b> — ${reason}`, 'warn'); });
    // Targeting: con colours, health, actor names, hostiles first; punches lock onto a close target.
    g.targeting.describe = (t) => this.describe(t);
    g.targeting.priority = (t) => (t.kind === 'threat' ? -1 : t.kind === 'person' && t.obj.actor ? (t.obj.actor.hostile ? -0.6 : -0.08) : 0);
    g.interactions.aimYaw = () => this.punchAim();
    // P screen: reputation.
    const info = g.powers.info;
    g.powers.info = () => `${info()} <span class="pw-rep">Reputation: <b>${this.rep.label()}</b> (${this.rep.value > 0 ? '+' : ''}${Math.round(this.rep.value)}) · crimes stopped ${this.rep.stats.stopped} · deeds ${this.rep.stats.deeds}</span>`;
    g.gate?.precompile?.(SmallDeeds.warmup());
    if (this.factions.factions[0]) g.gate?.precompile?.(this.graffiti.warmup(this.factions.factions[0]));
  }

  // ================================================================== settings

  get setting(): CrimeSetting { return this.director.setting; }
  set setting(s: CrimeSetting) {
    this.director.setting = s;
    this.deeds.enabled = s !== 'off';
    try { localStorage.setItem(SETTING_KEY, s); } catch { /* storage unavailable */ }
  }

  // ================================================================== the world for crimes

  private makeWorld(): CrimeWorld {
    const g = this.g, self = this;
    return {
      get time() { return self.time; },
      get hour() { return g.sky.hour; },
      player: this.view,
      agents: () => g.peds.agents,
      neighbours: (x, z, r) => g.peds.neighbours(x, z, r, []),
      spawn: (s, x, z, h, role) => this.spawn(s, x, z, h, role),
      route: (ax, az, bx, bz) => g.peds.buildRoute(ax, az, bx, bz),
      visible: (x, y, z) => this.visible(x, y, z),
      emit: (k, x, y, z, i, r) => g.stimuli.emit(k, x, y, z, i, r),
      sound: (id, x, y, z, gain, pitch) => this.sound(id, x, y, z, gain, pitch),
      loop: (id, x, y, z, gain) => { const h = g.audio.loop(id, 12); if (!h) return null; h.set(x, g.world.groundHeight(x, z) + y, z, gain); return h; },
      combat: this.combat,
      hurtPlayer: (d, k, fx, fz) => this.hurtPlayer(d, k, fx, fz),
      callPolice: (c, delay) => this.police.call(c, delay),
      random: Math.random,
      shops: (rMin, rMax) => this.shops(rMin, rMax),
      walls: (rMin, rMax) => this.shops(rMin, rMax, true),
      getaway: (x, z) => this.getaway(x, z),
      officers: (x, z, r) => this.officersAround(x, z, r),
      gunfire: (c, at) => this.crookShot(c, at),
      bomb: (c, x, z, fuse) => this.bombs.throw(c, x, z, fuse),
      cast: (c, power, stage, x, y, z) => this.casts.cast(c, power, stage, x, y, z),
      clearLine: (ax, ay, az, bx, by, bz, skip) => g.sight.clear(ax, ay, az, bx, by, bz, 0.25, skip),
      machines: (rMin, rMax) => this.machines(rMin, rMax),
      landmarks: (rMin, rMax) => this.landmarkSpots(rMin, rMax),
      opFx: (look, x, z, share, workers) => this.casts.opFx(look, x, z, share, workers),
      hijack: (c, x, z, n) => { if (g.threats) this.fleets.push(new HijackedFleet(g, g.threats.rogue, c, x, z, n)); },
      ritual: (c, x, z, element) => this.casts.ritualBurst(c.criminals, x, z, element),
      cars: (x, z, r) => {
        const out: { x: number; z: number }[] = [];
        for (const list of [g.traffic.vehicles, g.parkedCars]) for (const v of list) if (v.state !== VState.Wreck && v.state !== VState.Crushed && Math.hypot(v.x - x, v.z - z) < r) out.push(v);
        return out;
      },
    };
  }

  /** Officers on foot near a point (armed criminals turn on them). */
  private officersAround(x: number, z: number, r: number): PedAgent[] {
    const out: PedAgent[] = [];
    for (const u of this.police.units) for (const o of u.officers) {
      if (!o.alive || !o.actor || o.state === PState.Down || Math.hypot(o.x - x, o.z - z) > r) continue;
      out.push(o);
    }
    return out;
  }

  /** Where a person's chest is to a gun. */
  private chest(a: PedAgent): number { return a.y + (a.state === PState.Down ? 0.35 : 1.25); }

  /** Where the player's chest is to a gun (a giant: the shins). */
  private playerChest(): number { const P = this.g.player; return P.pos.y + Math.min(P.height * 0.7, 1.3); }

  /**
   * A criminal fires at the player or an officer (the target they chose — combat/shot.ts): a clear
   * line and nobody else in it, or the shot is not taken ('held'); fired, it hits (the player
   * through PlayerHealth — size, invulnerability — an officer through Combat).
   */
  private crookShot(c: PedAgent, at: PedAgent | 'player'): 'hit' | 'miss' | 'held' {
    const g = this.g, S = GUNS.crook, P = g.player;
    const tx = at === 'player' ? P.pos.x : at.x, tz = at === 'player' ? P.pos.z : at.z;
    const ty = at === 'player' ? this.playerChest() : this.chest(at);
    const fx = tx - c.x, fz = tz - c.z, fl = Math.hypot(fx, fz) || 1;
    const mx = c.x + (fx / fl) * 0.5, my = c.y + MUZZLE_Y.stand, mz = c.z + (fz / fl) * 0.5;
    const d = Math.hypot(tx - mx, ty - my, tz - mz);
    if (d > S.range || !this.guns.los(mx, my, mz, tx, ty, tz, 0.5)) return 'held';
    if (!this.guns.clear(c, mx, my, mz, tx, ty, tz, at === 'player' ? null : at, false, at === 'player')) return 'held';
    this.guns.fire(c, S, mx, my, mz, tx, ty, tz, 1, false, false, undefined);
    if (at === 'player') this.hurtPlayer(S.player * (0.8 + Math.random() * 0.4), 'gun', c.x, c.z);
    else this.combat.hitActor(at, (fx / fl) * gunJ(S.person), 20, (fz / fl) * gunJ(S.person), 'gun', 'npc', c.x, c.z);
    return 'hit';
  }

  /**
   * An officer fires at an armed criminal (Police.workCrime): as crookShot, from the officer's
   * side. 'held' when there is no clear line or someone is in it; fired, it hits.
   */
  private gunAt(o: PedAgent, c: PedAgent, S: GunSpec): 'hit' | 'miss' | 'held' {
    const tx = c.x, tz = c.z, ty = this.chest(c);
    const fx = tx - o.x, fz = tz - o.z, fl = Math.hypot(fx, fz) || 1;
    const mx = o.x + (fx / fl) * 0.5, my = o.y + MUZZLE_Y.stand, mz = o.z + (fz / fl) * 0.5;
    const d = Math.hypot(tx - mx, ty - my, tz - mz);
    if (d > S.range || !this.guns.los(mx, my, mz, tx, ty, tz, 0.5)) return 'held';
    if (!this.guns.clear(o, mx, my, mz, tx, ty, tz, c, true)) return 'held';
    this.guns.fire(o, S, mx, my, mz, tx, ty, tz, 1, false, true, 'police');
    this.combat.hitActor(c, (fx / fl) * gunJ(S.person), 20, (fz / fl) * gunJ(S.person), 'gun', 'police', o.x, o.z);
    return 'hit';
  }

  /**
   * An officer fires at the wanted player (Police.workPlayer, wanted level ≥ POLICE.shootAt): the
   * same rules — a clear line (their own car is cover, not a wall), nobody else in it; every round
   * fired hits, through PlayerHealth (size, sandbox invulnerability).
   */
  private gunAtPlayer(o: PedAgent, S: GunSpec, car: object | null): 'hit' | 'held' {
    const P = this.g.player;
    const tx = P.pos.x, tz = P.pos.z, ty = this.playerChest();
    const fx = tx - o.x, fz = tz - o.z, fl = Math.hypot(fx, fz) || 1;
    const mx = o.x + (fx / fl) * 0.5, my = o.y + MUZZLE_Y.stand, mz = o.z + (fz / fl) * 0.5;
    const d = Math.hypot(tx - mx, ty - my, tz - mz);
    if (d > S.range || !this.guns.los(mx, my, mz, tx, ty, tz, 0.5, car)) return 'held';
    if (!this.guns.clear(o, mx, my, mz, tx, ty, tz, null, false, true)) return 'held';
    this.guns.fire(o, S, mx, my, mz, tx, ty, tz, S.burst, false, false, 'police');
    this.guns.stats.atPlayer += S.burst;
    this.hurtPlayer(S.player * S.burst, 'police', o.x, o.z);
    return 'hit';
  }

  /** In the player's view (camera frustum, within 220 m)? */
  visible(x: number, y: number, z: number): boolean {
    const c = this.g.renderer.camera.position;
    if (Math.hypot(x - c.x, z - c.z) > 220) return false;
    return this.frustum.containsPoint(_v.set(x, y, z));
  }

  sound(id: string, x: number, y: number, z: number, gain: number, pitch = 1): void {
    this.g.audio.play(id, x, y, z, gain, pitch, 8, this.g.renderer.camera.position);
  }

  /** A citizen for an actor: criminals are adults in casual clothes with a cap or hood up, police in uniform. */
  private citizen(seed: number, role: ActorRole): Citizen {
    const pop = this.g.population;
    let best: Citizen | null = null;
    for (let k = 0; k < 40; k++) {
      const c = pop.synthetic(hash32(seed + k * 7919) || 1);
      if (c.role !== Role.Adult) continue;
      if (role === 'criminal') {
        const eq = cityOutfit(c.seed, c.gender, c.age, 0.08, 0.3);
        if (c.age > 0.45 || (!eq.head && !eq.back)) { best = best ?? c; continue; }
        return c;
      }
      if (role === 'police' && c.age > 0.5) { best = best ?? c; continue; }
      return c;
    }
    return best ?? pop.synthetic(seed || 1);
  }

  /** A synthetic citizen standing at a point with an actor attached. */
  spawn(seed: number, x: number, z: number, heading: number, role: ActorRole): PedAgent | null {
    if (this.actorCount >= ACTOR_BUDGET) return null;
    const c = this.citizen(seed, role);
    const a = this.g.peds.spawnAt(c, x, z, heading);
    if (!a) return null;
    const act = attach(a, makeActor(role, -1));
    if (role === 'police') Object.assign(act, { outfit: policeOutfit(c.seed), hp: POLICE.officerHp, maxHp: POLICE.officerHp, strength: POLICE.officerStrength, held: null });
    this.actorCount++;
    return a;
  }

  /**
   * Shop entrances in a ring around the player; with `walls`, the doors of buildings without a shop
   * front instead (walls to tag beside them, with the facade's bay width: no shop windows).
   */
  private shops(rMin: number, rMax: number, walls = false): { x: number; z: number; nx: number; nz: number; bay: number }[] {
    const p = this.g.player.pos, W = this.g.world;
    const out: { x: number; z: number; nx: number; nz: number; bay: number; d: number }[] = [];
    for (const r of W.buildingsIn(p.x - rMax, p.z - rMax, p.x + rMax, p.z + rMax)) {
      const d = r.desc;
      const shop = !!d.shopfront || d.use === 'retail';
      if (!r.alive || shop === walls) continue;
      const door = doorOf(d);
      const dist = Math.hypot(door.x - p.x, door.z - p.z);
      if (dist < rMin || dist > rMax) continue;
      // The pavement in front must be free (not inside another building).
      const fx = door.x + door.nx * 3, fz = door.z + door.nz * 3;
      if (W.buildingAt(fx, fz)) continue;
      out.push({ ...door, bay: d.bay, d: dist });
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }

  private getaway(x: number, z: number): GetawayCar | null {
    const tr = this.g.traffic;
    const kinds: VKind[] = ['sedan', 'suv', 'hatch', 'van'];
    const v = tr.spawnVehicle(kinds[(Math.random() * kinds.length) | 0], x, z, 40);
    if (!v) return null;
    v.task = { x: v.x, z: v.z, arrived: false, hold: true };
    v.speed = 0;
    v.paint = [0.08, 0.08, 0.09];
    const alive = () => v.alive && tr.vehicles.includes(v);
    return {
      get x() { return v.x; }, get z() { return v.z; }, get speed() { return v.speed; },
      get alive() { return alive(); },
      get disabled() { const st = statusOf(v); return v.state >= VState.Abandoned || v.damage > 0.45 || !!(st && (st.frozen > 0 || st.stunned > 0)); },
      drive: (fx, fz) => {
        v.task = undefined;
        v.state = VState.Fleeing;
        v.vmax = 17;
        v.speed = Math.max(v.speed, 2);
        // Away from the player: route to a point 400 m off.
        const dx = v.x - fx, dz = v.z - fz, l = Math.hypot(dx, dz) || 1;
        tr.sendTo(v, v.x + (dx / l) * 400, v.z + (dz / l) * 400);
        this.sound('tire_screech', v.x, v.y, v.z, 0.9);
      },
      hold: () => { if (v.task) v.task.hold = true; },
      release: () => { if (v.task) v.task = undefined; if (v.state === VState.Fleeing) v.state = VState.Drive; },
    };
  }

  private witnesses(x: number, z: number, r: number, except?: object): number {
    let n = 0;
    for (const a of this.g.peds.neighbours(x, z, r, [])) if (a !== except && a.alive && !a.inside && !a.actor && a.state !== PState.Down) n++;
    return n;
  }

  private officersNear(x: number, z: number, r: number): number {
    let n = 0;
    for (const u of this.police.units) {
      for (const o of u.officers) if (o.alive && o.state !== PState.Down && Math.hypot(o.x - x, o.z - z) < r) n++;
      // A patrol car on the way counts as eyes too.
      if (u.state !== 'leaving' && u.car.alive && Math.hypot(u.car.x - x, u.car.z - z) < r) n++;
    }
    return n;
  }

  private record(power: string, target: Parameters<Game['consequences']['record']>[1], effect: Parameters<Game['consequences']['record']>[2], x: number, z: number, ref?: object): void {
    const C = this.g.consequences;
    // Once per hit: a power that knocked someone down has already put it on the ledger.
    const L = C.log;
    for (let i = L.length - 1; i >= Math.max(0, L.length - 6); i--) if (L[i].ref === ref && C.time - L[i].t < 0.05) return;
    C.record(power, target, effect, x, z, ref);
  }

  // ================================================================== starting crimes

  /** Macro cell at a point (the containing one, else the nearest within reach; -1: outside the city). */
  cellAt(x: number, z: number): number {
    const cells = this.g.macro.cells;
    let best = -1, bd = Infinity;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const d = Math.hypot(c.centroid[0] - x, c.centroid[1] - z);
      if (d > c.radius + 50) continue;
      if (pointInPoly(c.poly, x, z)) { best = i; break; }
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** The group holding a point's cell, or null. */
  factionAt(x: number, z: number): Faction | null {
    const i = this.cellAt(x, z);
    const f = i < 0 ? -1 : this.factions.holder[i];
    return f < 0 ? null : this.factions.factions[f];
  }

  private playerCell(): { cell: number; district: import('../../plan/types').District; index: number; ops: Record<CrimeKind, number> | null } | null {
    const p = this.g.player.pos, cells = this.g.macro.cells;
    const best = this.cellAt(p.x, p.z);
    if (best < 0) return null;
    const f = this.factions.holder[best];
    if (f < 0) return { cell: best, district: cells[best].district, index: this.index[best], ops: null };
    // Turf brawls only where a rival group holds the street next door (or has a hold here).
    const ops = { ...ARCHETYPES[this.factions.factions[f].archetype].kinds };
    if (!rivalsAt(this.factions, best, f).length) ops.brawl = 0;
    return { cell: best, district: cells[best].district, index: this.index[best], ops };
  }

  /** A crime in a group's turf is its operation: its members wear its colours and name (a brawl's other side: the rival's). */
  private enlist(c: Crime, f: Faction): void {
    c.faction = f.id;
    const rival = c instanceof TurfBrawl && c.rival >= 0 ? this.factions.factions[c.rival] : null;
    for (const a of c.criminals) {
      const act = a.actor;
      if (!act) continue;
      const by = rival && act.memo.side === 1 ? rival : f;
      act.faction = by.id;
      act.outfit = factionOutfit(by, a.cit.seed);
      act.title = `${by.emblem} ${by.name} · ${KINDS[c.kind].criminal}`;
    }
    // A lieutenant leads it now and then (one per side): tougher, with the group's powers.
    const sides = rival ? [f, rival] : [f];
    const roll = c.rng.fork('lieutenant');
    sides.forEach((by, side) => {
      const L = ARCHETYPES[by.archetype].lieutenant;
      if (!this.devLieutenant && !roll.chance(L.chance[c.kind] ?? 0)) return;
      const a = c.criminals.find((x) => x.actor && (!rival || (x.actor.memo.side ?? 0) === side));
      if (!a) return;
      c.promote(a, L.powers);
      a.actor!.outfit = lieutenantOutfit(by, a.cit.seed);
      a.actor!.title = `${by.emblem} ${by.name} · ${L.title}`;
    });
  }

  /** The group behind a crime, or null. */
  factionOf(c: Crime): Faction | null { return c.faction < 0 ? null : this.factions.factions[c.faction] ?? null; }

  /** Delivery robots standing free on the pavement near the player: a point beside one (hack it there). */
  private machines(rMin: number, rMax: number): { x: number; z: number; nx: number; nz: number }[] {
    const p = this.g.player.pos, W = this.g.world, out: { x: number; z: number; nx: number; nz: number; d: number }[] = [];
    for (const r of this.g.future.robots.list) {
      if (!r.alive || r.mal || r.state >= RState.Down || r.onRoad) continue;
      const d = Math.hypot(r.x - p.x, r.z - p.z);
      if (d < rMin || d > rMax) continue;
      // The guards stand out on the side away from the buildings (square to its heading).
      let nx = Math.cos(r.yaw), nz = -Math.sin(r.yaw);
      if (W.buildingAt(r.x + nx * 4.5, r.z + nz * 4.5)) { nx = -nx; nz = -nz; }
      if (W.buildingAt(r.x + nx * 4.5, r.z + nz * 4.5)) continue;
      out.push({ x: r.x, z: r.z, nx, nz, d });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  /** Open ground in front of the city's landmarks near the player: the circle's centre, the way out. */
  private landmarkSpots(rMin: number, rMax: number): { x: number; z: number; nx: number; nz: number }[] {
    const p = this.g.player.pos, W = this.g.world, out: { x: number; z: number; nx: number; nz: number; d: number }[] = [];
    for (const lm of this.g.macro.landmarks ?? []) {
      if (lm.kind === 'airport' || lm.cell < 0) continue;
      const nx = Math.sin(lm.angle), nz = -Math.cos(lm.angle);
      // From the edge of the front square inwards: the first point clear of the structure.
      for (let v = -lm.hv + 4; v < -lm.hv + 16 && v < 0; v += 2) {
        const [x, z] = siteToWorld(lm, 0, v);
        const d = Math.hypot(x - p.x, z - p.z);
        if (d < rMin || d > rMax) break;
        if (W.landmarks?.onFootprint(x, z, 3.5) || W.buildingAt(x, z)) continue;
        out.push({ x, z, nx, nz, d });
        break;
      }
    }
    return out.sort((a, b) => a.d - b.d);
  }

  /** A tagging crime's tag on the wall. */
  private tagOf(c: Tagging, f: Faction): Tag {
    const S = c.spot!;
    return { x: S.x, y: S.y, z: S.z, nx: S.nx, nz: S.nz, archetype: f.archetype, seed: c.seed };
  }

  /** Move a group's turf at a crime's site; streets changing hands are redrawn and told. */
  private turf(c: Crime, f: Faction, amount: number): void {
    const changed = shift(this.factions, this.cellAt(c.x, c.z), f.id, amount);
    if (!changed.length) return;
    this.g.map.setTurf(this.factions);
    const lost = changed.filter((x) => x.from === f.id).length, won = changed.filter((x) => x.to === f.id).length;
    this.factionStats.lost += lost;
    this.factionStats.gained += won;
    const who = `<b style="color:${f.palette.map}">${f.emblem} ${f.name}</b>`;
    if (lost) this.g.powerHud.toast(`${who} lost their grip on ${lost > 1 ? `${lost} blocks` : 'a block'}`, 'info');
    else if (won) this.g.powerHud.toast(`${who} took over ${won > 1 ? `${won} more blocks` : 'another block'}`, 'warn');
  }

  /** Turf, tags and hideouts for a save (SaveData.factions). */
  saveFactions(): { turf: unknown; tags: Tag[]; hideouts: unknown[] } {
    return { turf: saveFactions(this.factions, this.factionStats), tags: this.graffiti.tags.map((t) => ({ ...t })), hideouts: saveHideouts(this.factions, this.hideouts) };
  }

  /** Put saved turf, tags and hideouts back (null: the seeded turf, no tags, hideouts not yet found). */
  restoreFactions(d: { turf: unknown; tags: unknown; hideouts?: unknown } | null): void {
    const stats = restoreFactions(this.factions, d?.turf ?? null);
    this.factionStats = { stopped: 0, succeeded: 0, tags: 0, lost: 0, gained: 0, brawls: 0, busts: 0, drifted: 0, ...stats };
    for (const gd of this.guards.values()) gd.standDown();
    this.guards.clear();
    this.posted.clear();
    this.hideouts = restoreHideouts(this.factions, d?.hideouts ?? null);
    this.driftHour = Math.floor(this.g.sky.hoursAbs);
    this.hideKey = '';
    const tags = Array.isArray(d?.tags) ? (d!.tags as unknown[]).filter((t): t is Tag => {
      const o = t as Tag;
      return !!o && [o.x, o.y, o.z, o.nx, o.nz, o.seed].every(Number.isFinite) && typeof o.archetype === 'string';
    }) : [];
    this.graffiti.restore(tags);
    this.g.map.setTurf(this.factions);
  }

  // ================================================================== turf over time, hideouts

  /** Off-screen drift once per game hour (catching up at most DRIFT.maxCatchUp hours after a jump). */
  private driftTurf(): void {
    const h = Math.floor(this.g.sky.hoursAbs);
    if (this.driftHour < 0 || h < this.driftHour) { this.driftHour = h; return; }
    if (h === this.driftHour) return;
    const from = Math.max(this.driftHour + 1, h - DRIFT.maxCatchUp + 1);
    let changed = 0;
    const p = this.g.player.pos, here = this.cellAt(p.x, p.z);
    let hereNow: { from: number; to: number } | null = null;
    for (let k = from; k <= h; k++) {
      for (const x of drift(this.factions, this.g.settings.seed, k)) { changed++; if (x.cell === here) hereNow = x; }
    }
    this.driftHour = h;
    if (!changed) return;
    this.factionStats.drifted += changed;
    this.g.map.setTurf(this.factions);
    // Told only when it is the street the player stands in.
    if (hereNow) {
      const F = this.factions.factions, to = hereNow.to >= 0 ? F[hereNow.to] : null, was = hereNow.from >= 0 ? F[hereNow.from] : null;
      if (to) this.g.powerHud.toast(`<b style="color:${to.palette.map}">${to.emblem} ${to.name}</b> ${was ? `pushed ${inSentence(was)} out of` : 'moved into'} this block`, 'warn');
      else if (was) this.g.powerHud.toast(`<b style="color:${was.palette.map}">${was.emblem} ${was.name}</b> lost their hold on this block`, 'info');
    }
  }

  /** The player learns where a group's hideout is (spotted, or a cuffed member told). */
  private reveal(f: number, how: 'seen' | 'told'): void {
    const h = this.hideouts[f], F = this.factions.factions[f];
    if (!h || !F || h.found || !h.door || h.bustedUntil > this.g.sky.hoursAbs) return;
    h.found = true;
    this.hideKey = '';
    const who = `<b style="color:${F.palette.map}">${F.emblem} ${F.name}</b>`;
    this.g.powerHud.toast(how === 'seen' ? `You found the hideout of ${who} — marked on your map` : `A cuffed member of ${who} gave up their hideout — marked on your map`, 'info');
  }

  /**
   * Hideouts: placed in the group's stash cell once the player is near it, spotted when passed, guards
   * posted while the player is close, moved after a bust once the group has lain low.
   */
  private updateHideouts(dt: number): void {
    this.hideT -= dt;
    if (this.hideT > 0) return;
    this.hideT = 0.5;
    const g = this.g, p = g.player.pos, now = g.sky.hoursAbs, F = this.factions, cells = g.macro.cells;
    for (const h of this.hideouts) {
      const f = F.factions[h.faction];
      if (!f) continue;
      // Lying low after a bust: then set up again in its strongest cell, behind another door.
      if (h.bustedUntil > 0 && now >= h.bustedUntil) { h.bustedUntil = -1; h.door = null; h.found = false; h.cell = hideoutCell(F, f.id); this.hideKey = ''; }
      if (h.bustedUntil > now) continue;
      if (!h.door) {
        const cell = h.cell >= 0 && F.holder[h.cell] === f.id ? h.cell : hideoutCell(F, f.id);
        if (cell < 0) continue;
        h.cell = cell;
        const c = cells[cell];
        if (Math.hypot(c.centroid[0] - p.x, c.centroid[1] - p.z) > c.radius + HIDEOUTS.placeR) continue;
        h.door = pickDoor(this.doorsIn(cell), g.settings.seed, f.id, h.moves, c.centroid[0], c.centroid[1], c.radius);
        if (!h.door) continue;
      }
      const D = h.door, d = Math.hypot(D.x - p.x, D.z - p.z);
      if (!h.found && d < HIDEOUTS.spotR && this.visible(D.x, g.world.groundHeight(D.x, D.z) + 1.5, D.z)) this.reveal(f.id, 'seen');
      // Guards at the door while the player is around.
      const gd = this.guards.get(f.id);
      if (gd && !gd.active) this.guards.delete(f.id);
      if (!this.guards.has(f.id) && d < HIDEOUTS.guardR && (d > HIDEOUTS.guardMin || !this.visible(D.x, g.world.groundHeight(D.x, D.z) + 1, D.z)) && this.actorCount < ACTOR_BUDGET - 6 && !this.posted.has(f.id)) {
        const c = new HideoutGuard(this.world, hash32(g.settings.seed ^ (f.id * 7919) ^ Math.floor(now * 4)), D);
        if (this.begin(c, f)) { this.guards.set(f.id, c); this.posted.add(f.id); }
      } else if (gd && d > HIDEOUTS.leaveR && !gd.committed) { gd.standDown(); this.guards.delete(f.id); }
      // Gone far enough: next time the guards are back at the door.
      if (d > HIDEOUTS.leaveR) this.posted.delete(f.id);
    }
    this.hideoutMarkers();
  }

  /** Doors of ordinary buildings (no shops) in a macro cell. */
  private doorsIn(cell: number): { x: number; z: number; nx: number; nz: number }[] {
    // (Only once the cell is loaded, all of it: the pick is the same whichever way the player came.)
    const c = this.g.macro.cells[cell], W = this.g.world;
    const out: { x: number; z: number; nx: number; nz: number }[] = [];
    for (const r of W.cellBuildings(cell)) {
      const d = r.desc;
      if (!r.alive || d.shopfront || d.use === 'retail' || d.floors <= 0) continue;
      const door = doorOf(d);
      if (!pointInPoly(c.poly, door.x, door.z) || W.buildingAt(door.x + door.nx * 3, door.z + door.nz * 3)) continue;
      out.push(door);
    }
    return out;
  }

  /** The hideout at the player's feet that can be busted now (guards out of the way), or null. */
  private bustable(): Hideout | null {
    const p = this.g.player.pos, now = this.g.sky.hoursAbs;
    for (const h of this.hideouts) {
      if (!h.door || h.bustedUntil > now || Math.hypot(h.door.x - p.x, h.door.z - p.z) > HIDEOUTS.useR) continue;
      const gd = this.guards.get(h.faction);
      if (gd && gd.active && gd.guarding > 0) return null;
      return h;
    }
    return null;
  }

  /** E at a hideout's door: the stash is busted — a big loss of turf for the group; it lies low. */
  private bust(h: Hideout): void {
    const g = this.g, f = this.factions.factions[h.faction];
    h.bustedUntil = g.sky.hoursAbs + HIDEOUTS.lieLow;
    h.found = true;
    h.moves++;
    this.factionStats.busts++;
    g.player.action = { id: 'kick', t0: g.player.animClock, dur: 0.7 };
    this.sound('punch_impact', h.door!.x, g.player.pos.y + 1, h.door!.z, 1, 0.6);
    g.progress.addKarma(20, `busted the stash of ${inSentence(f)}`);
    this.rep.add(5, 'hideout busted');
    this.rep.count('stopped');
    this.cheer();
    const changed = shift(this.factions, h.cell, f.id, SHIFT.bust, 0.6);
    // Its stash block is lost outright (no longer held: the turf map shows it); its home ground comes back with drift.
    const left = this.factions.influence[f.id][h.cell] - (HOLD - SHIFT.bustBelow);
    if (left > 0) for (const x of shift(this.factions, h.cell, f.id, -left, 0)) {
      const was = changed.find((y) => y.cell === x.cell);
      if (was) was.to = x.to; else changed.push(x);
    }
    this.factionStats.lost += changed.filter((x) => x.from === f.id).length;
    g.map.setTurf(this.factions);
    g.powerHud.toast(`You busted the stash of <b style="color:${f.palette.map}">${f.emblem} ${f.name}</b>${changed.length ? ` — they lost ${changed.filter((x) => x.from === f.id).length || 'some'} ${changed.length === 1 ? 'block' : 'blocks'}` : ''}. They will lie low for a while.`, 'info');
    this.hideKey = '';
  }

  /** Found hideouts on the map (a diamond in the group's colour; grey while it lies low). */
  private hideoutMarkers(): void {
    const now = this.g.sky.hoursAbs, list: MapMarker[] = [];
    for (const h of this.hideouts) {
      const f = this.factions.factions[h.faction];
      if (!f || !h.door || !h.found) continue;
      const busted = h.bustedUntil > now;
      list.push({ x: h.door.x, z: h.door.z, color: busted ? '#8a8f98' : f.palette.map, kind: busted ? 'dot' : 'core', title: busted ? `${f.emblem} ${f.name}: hideout (busted)` : `${f.emblem} ${f.name}: hideout — bust the stash (E at the door)` });
    }
    const key = list.map((m) => `${m.kind}${Math.round(m.x)},${Math.round(m.z)}`).join(';');
    if (key !== this.hideKey) { this.hideKey = key; this.g.map.setMarkers('hideouts', list); }
  }

  private make(kind: CrimeKind, seed: number, near: { x: number; z: number } | null): Crime {
    return KINDS[kind].make(this.world, seed, near);
  }

  private startRoll(r: CrimeRoll): boolean {
    if (this.actorCount > ACTOR_BUDGET - 6 || this.crimes.filter((c) => c.active).length >= 3) return false;
    if (this.g.player.height > 6 || this.g.underground.isUnder(this.g.player.pos.x, this.g.player.pos.y + 0.5, this.g.player.pos.z)) return false;
    return this.begin(this.make(r.kind, r.seed, null));
  }

  private begin(c: Crime, faction?: Faction | null): boolean {
    if (!c.setup()) { c.abort(); c.dispose(); return false; }
    // The group whose turf it is (a group-only kind just outside it: the player's cell's group).
    const p = this.g.player.pos, own = GROUP_KINDS.includes(c.kind);
    const f = faction === undefined ? this.factionAt(c.x, c.z) ?? (own ? this.factionAt(p.x, p.z) : null) : faction;
    if (!f && own) { c.abort(); c.dispose(); return false; }
    if (c instanceof TurfBrawl && f) {
      // The rivals who came to take the street: whoever presses here, else any hostile group.
      const F = this.factions;
      c.rival = rivalsAt(F, this.cellAt(c.x, c.z), f.id)[0] ?? F.factions.find((o) => relation(F, f.id, o.id) === 'hostile')?.id ?? -1;
      if (c.rival < 0) { c.abort(); c.dispose(); return false; }
    }
    if (f) this.enlist(c, f);
    if (c instanceof Ritual && f) c.element = RITUAL_ELEMENT[f.palette.name] ?? c.element;
    this.crimes.push(c);
    this.stats.started++;
    return true;
  }

  /**
   * Dev / test: a crime of a kind near the player (dist m away) or at a point; by a group (its id;
   * -1: nobody) or the turf's. `lt`: 'lt' — the group's lieutenant leads it; a list of powers
   * ('bolt,fireball') — the first criminal gets those (any crime, any group or none).
   */
  spawnCrime(kind: CrimeKind, near?: { x: number; z: number }, faction?: number, lt?: string): Crime | null {
    const c = this.make(kind, (Math.random() * 2 ** 32) >>> 0, near ?? null);
    const f = faction === undefined ? undefined : this.factions.factions[faction] ?? null;
    this.devLieutenant = lt === 'lt';
    try { if (!this.begin(c, f)) return null; } finally { this.devLieutenant = false; }
    const powers = lt && lt !== 'lt' ? lt.split(',').map((x) => x.trim()).filter((x): x is VillainPower => x in VILLAIN_POWERS) : [];
    const a = c.criminals.find((x) => x.actor);
    if (powers.length && a) {
      c.casters.delete(a);
      c.promote(a, powers);
      a.actor!.title = `${a.actor!.title ?? KINDS[c.kind].criminal} · ${powers.join(', ')}`;
    }
    return c;
  }

  crimeOf(a: PedAgent): Crime | null {
    const id = a.actor?.owner;
    return id === undefined ? null : this.crimes.find((c) => c.id === id) ?? null;
  }

  // ================================================================== per frame

  update(dt: number): void {
    const t0 = performance.now();
    const g = this.g, P = g.player;
    this.time += dt;
    const cam = g.renderer.camera;
    this.frustum.setFromProjectionMatrix(this.m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    // What the crimes see of the player.
    const V = this.view;
    V.x = P.pos.x; V.y = P.pos.y; V.z = P.pos.z; V.vx = P.vel.x; V.vz = P.vel.z; V.height = P.height; V.flying = P.flying;
    V.down = this.health.down || P.downT > 0;
    this.health.strengthRank = g.abilities.rank('strength');
    V.strength = this.playerStrength();
    this.health.update(dt);
    this.upkeep(dt);
    this.director.update(dt);
    for (let i = this.crimes.length - 1; i >= 0; i--) {
      const c = this.crimes[i];
      c.update(dt);
      for (const e of c.events) this.onEvent(e.type, c, e.who);
      c.events.length = 0;
      // A tag in progress fades in on the wall; an interrupted one goes.
      if (c instanceof Tagging && c.spot && !c.done) {
        const f = this.factionOf(c);
        if (f && c.phase === 'commit') this.graffiti.paint(c.id, this.tagOf(c, f), c.progress / TAGGING.paintFor);
        else if (c.phase !== 'approach') this.graffiti.drop(c.id);
      }
      if (!c.active) {
        // The victim waits a while for the stolen things (lying in the street or with the player).
        const l = c.loot;
        const keep = !!l && !l.returned && Number.isFinite(l.x) && [...c.victims, ...c.extras].some((v) => v.alive && v.actor);
        c.dispose(keep);
        if (keep) this.lingering.push({ c, t: 0 });
        this.crimes.splice(i, 1);
        if (c.outcome === 'aborted') this.stats.aborted++;
        else if (c.outcome === 'escaped') this.stats.failed++;
        else this.stats.resolved++;
        this.director.ended();
      }
    }
    this.linger(dt);
    this.driftTurf();
    this.updateHideouts(dt);
    this.bombs.update(dt);
    this.casts.update(dt);
    this.updateFleets(dt);
    this.police.update(dt);
    this.guns.update(dt);
    this.justice.update(dt);
    this.deeds.update(dt);
    this.tackle(dt);
    this.updateLoot(dt);
    this.crowdAttitude(dt);
    this.markers(dt);
    this.hud.update(dt);
    // Sounds load on first use: ask for the loops early (once audio runs).
    this.warmT -= dt;
    if (this.warmT <= 0) { this.warmT = 5; for (const id of ['siren_loop', 'alarm_bell']) g.audio.loop(id)?.stop(); }
    if (!this.devDone) this.installDev();
    const ms = performance.now() - t0;
    this.stats.msAvg = this.stats.msAvg * 0.95 + ms * 0.05;
  }

  private lingering: { c: Crime; t: number }[] = [];

  /** Hijacked machines: run their course; the link cut when the hackers are stopped; red dots on the map. */
  private updateFleets(dt: number): void {
    const g = this.g, p = g.player.pos, list: MapMarker[] = [];
    for (let i = this.fleets.length - 1; i >= 0; i--) {
      const F = this.fleets[i], was = F.active;
      F.update(dt);
      if (was && !F.active && F.end === 'cut' && Math.hypot(F.x - p.x, F.z - p.z) < 200) g.powerHud.toast('With the hackers stopped, the hijacked robots go dark', 'info');
      if (F.done) { this.fleets.splice(i, 1); continue; }
      for (const m of F.live()) if (Math.hypot(m.obj.x - p.x, m.obj.z - p.z) < 250) list.push({ x: m.obj.x, z: m.obj.z, color: '#ff6b5e', kind: 'dot', title: 'A hijacked machine' });
    }
    const key = list.map((m) => `${Math.round(m.x / 3)},${Math.round(m.z / 3)}`).join(';');
    if (key !== this.fleetKey) { this.fleetKey = key; g.map.setMarkers('hijack', list); }
  }

  /** After a crime: the victim (or shopkeeper) waits, upset, for their things; cheers when they come back. */
  private linger(dt: number): void {
    const p = this.g.player.pos;
    for (let i = this.lingering.length - 1; i >= 0; i--) {
      const L = this.lingering[i];
      L.t += dt;
      const l = L.c.loot!;
      let alive = 0;
      for (const v of [...L.c.victims, ...L.c.extras]) {
        const act = v.actor;
        if (!v.alive || !act || act.owner !== L.c.id || v.state === PState.Down) continue;
        alive++;
        act.goal = null;
        const d = Math.hypot(v.x - p.x, v.z - p.z);
        if (l.returned) {
          act.mood = 'happy';
          if (!act.memo.cheered) { act.memo.cheered = 1; act.action = { id: 'cheer', age: 0, dur: 2.6 }; act.memo.cheerT = L.t; }
        } else act.mood = 'sad';
        act.face = d < 20 ? { x: p.x, y: p.y + 1.5, z: p.z } : null;
      }
      const done = (l.returned && L.t - (L.c.victims[0]?.actor?.memo.cheerT ?? L.t) > 4) || L.t > 100 || alive === 0 || (!l.returned && !Number.isFinite(l.x));
      if (done) { L.c.releaseVictims(); this.lingering.splice(i, 1); }
    }
  }

  /** Actor timers, getting up after a knock-down, the budget count. */
  private upkeep(dt: number): void {
    let n = 0;
    for (const a of this.g.peds.agents) {
      const act = a.actor;
      if (!act) continue;
      // (Soldiers, the aftermath's people and the street characters have their own budgets:
      // response/forces, game/aftermath, game/street.)
      const uniformed = act.role === 'police' || act.role === 'soldier';
      if (act.role !== 'soldier' && act.owner !== AFTERMATH_OWNER && act.owner !== STREET_OWNER) n++;
      tickActor(act, dt);
      if (a.state === PState.Down && (act.state === 'down' || (act.state === 'ko' && uniformed))) {
        act.upT -= dt;
        if (act.upT <= (act.state === 'ko' ? -18 : 0)) {
          a.state = PState.Idle; a.vx = a.vz = a.vy = 0; a.stateT = 0;
          if (uniformed) act.hp = Math.max(act.hp, act.maxHp * 0.5);
          setState(act, act.role === 'criminal' ? 'run' : 'idle');
        }
      } else if (a.state !== PState.Down && (act.state === 'down')) setState(act, act.role === 'criminal' ? 'run' : 'idle');
      // Orphans (their owner is gone): back to ordinary life.
      if (act.owner > 0 && act.role !== 'police' && !this.crimes.some((c) => c.id === act.owner) && !this.lingering.some((l) => l.c.id === act.owner) && act.state !== 'arrested') {
        if (act.role === 'criminal' && !this.visible(a.x, a.y + 1, a.z)) a.alive = false;
        else { a.actor = undefined; if (a.state !== PState.Down) { a.state = PState.Flee; a.fear = 0; } }
      }
    }
    this.actorCount = n;
  }

  // ================================================================== events and rewards

  private onEvent(type: string, c: Crime, who?: PedAgent): void {
    const g = this.g;
    const near = (a: PedAgent) => Math.hypot(a.x - g.player.pos.x, a.z - g.player.pos.z);
    switch (type) {
      case 'ko':
        if (who?.actor?.koByPlayer) {
          c.playerInvolved = true;
          this.stats.kos++;
          this.rep.count('kos');
          // A lieutenant counts double (and says which: the group's Brute or Enforcer).
          const f = who.actor.memo.lt ? this.factions.factions[who.actor.faction ?? c.faction] ?? null : null;
          const lt = who.actor.memo.lt ? (f ? ARCHETYPES[f.archetype].lieutenant.title : 'Lieutenant') : null;
          { const name = (lt ?? KINDS[c.kind].criminal).toLowerCase(); g.progress.addKarma(KINDS[c.kind].ko * (lt ? 2 : 1), `knocked out ${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}${f ? ` of ${inSentence(f)}` : ''}`); }
          this.rep.add(lt ? 4 : 2, 'ko');
        }
        break;
      case 'surrender':
        if (who && near(who) < 8) {
          c.playerInvolved = true;
          g.progress.addKarma(CRIME_KARMA.surrender, `a ${KINDS[c.kind].criminal.toLowerCase()} gave up`);
          this.rep.add(1, 'surrender');
        }
        break;
      case 'arrest':
        this.rep.count('arrests');
        // A cuffed group member may give the hideout away.
        if (who?.actor?.faction !== undefined && Math.random() < HIDEOUTS.tellChance) this.reveal(who.actor.faction, 'told');
        break;
      case 'tagged': {
        const f = this.factionOf(c);
        if (f && c instanceof Tagging) {
          this.graffiti.finish(c.id, this.tagOf(c, f));
          this.factionStats.tags++;
          this.turf(c, f, SHIFT.tag);
        }
        break;
      }
      case 'done': {
        // A hack went through, a ritual was completed: the group's hold on the street grows.
        const f = this.factionOf(c);
        if (!f) break;
        this.factionStats.succeeded++;
        this.turf(c, f, SHIFT.ritual);
        if (Math.hypot(c.x - g.player.pos.x, c.z - g.player.pos.z) < 220) {
          const what = c instanceof Ritual ? 'completed a ritual' : 'hijacked the robots';
          g.powerHud.toast(`<b style="color:${f.palette.map}">${f.emblem} ${f.name}</b> ${what} here`, 'warn');
        }
        break;
      }
      case 'failed': {
        // An operation came off: the group's hold on the street grows (a brawl's result is 'won', a
        // hack's or a ritual's is 'done').
        const f = this.factionOf(c);
        if (f && c.outcome === 'escaped' && !(c instanceof TurfBrawl) && !(c instanceof HideoutGuard) && !(c instanceof Channeling)) { this.factionStats.succeeded++; this.turf(c, f, SHIFT.succeeded); }
        break;
      }
      case 'won': {
        // A turf brawl was decided: the winners take the street from the losers.
        if (!(c instanceof TurfBrawl) || c.winner < 0) break;
        const F = this.factions.factions, win = F[c.winner], lose = F[c.winner === c.faction ? c.rival : c.faction];
        this.factionStats.brawls++;
        if (Math.hypot(c.x - g.player.pos.x, c.z - g.player.pos.z) < 140) g.powerHud.toast(`<b style="color:${win.palette.map}">${win.emblem} ${win.name}</b> beat ${lose ? inSentence(lose) : 'their rivals'} in a street fight`, 'warn');
        this.turf(c, win, SHIFT.brawlWon);
        if (lose) this.turf(c, lose, SHIFT.brawlLost);
        break;
      }
      case 'subdued':
      case 'resolved':
        // Stopped: rewarded once, as soon as they are all down or giving up (the police cuff them
        // later). Involved: a KO, a surrender in front of the player, or any blow the player landed
        // on one of them (a thief knocked down by the player and cuffed by the police counts).
        if (!c.paid && (c.playerInvolved || c.criminals.some((a) => a.actor?.hitByPlayer))) {
          c.paid = true;
          // A brawl that one side had already won: the player only cleaned up (the KOs count).
          if (c instanceof TurfBrawl && c.winner >= 0) break;
          this.stopped(c);
        }
        break;
      default:
        break;
    }
    // Loot of this crime: track it for drawing and returning.
    if (c.loot && !this.loots.some((l) => l.loot === c.loot)) {
      const obj = makeItem(c.loot.kind);
      const glint = makeGlint();
      obj.visible = glint.visible = false;
      this.group.add(obj, glint);
      this.loots.push({ loot: c.loot, crime: c, obj, glint, endT: 0 });
    }
  }

  /** The player stopped a crime: karma, reputation, cheers; a group's operation costs it ground. */
  private stopped(c: Crime): void {
    const g = this.g;
    const clean = c.collateral === 0;
    const k = Math.round(KINDS[c.kind].resolved * (clean ? 1 + CRIME_KARMA.cleanBonus : 1));
    const by = this.factionOf(c);
    const rival = c instanceof TurfBrawl && c.rival >= 0 ? this.factions.factions[c.rival] : null;
    const who = by ? ` by ${inSentence(by)}${rival ? ` and ${inSentence(rival)}` : ''}` : '';
    g.progress.addKarma(k, `stopped ${KINDS[c.kind].stopped}${who}${clean ? ' — nobody else hurt' : ''}`);
    this.rep.add(KINDS[c.kind].rep, 'crime stopped');
    this.rep.count('stopped');
    this.justice.atone(1.5);
    this.cheer();
    if (by) { this.factionStats.stopped++; this.turf(c, by, SHIFT.stopped); }
    // Breaking up a brawl: both groups lose face on that street.
    if (rival) this.turf(c, rival, SHIFT.stopped * 0.7);
  }

  /** People nearby cheer (wave) when the player stopped a crime; a cheer goes up. */
  cheer(): void {
    const g = this.g, p = g.player.pos;
    if (this.rep.value < -20) return;
    let n = 0;
    for (const a of g.peds.neighbours(p.x, p.z, 26, [])) {
      if (a.actor || a.inside || a.state === PState.Down || a.state === PState.Flee) continue;
      a.state = PState.Idle; a.stateT = 0; a.helped = true; a.speed = 0;
      a.heading = Math.atan2(-(p.x - a.x), -(p.z - a.z));
      n++;
    }
    if (n > 0 || this.rep.cheers) g.audio.play('crowd_cheer', p.x, p.y + 2, p.z, Math.min(1, 0.35 + n * 0.08), 1, 10, g.renderer.camera.position);
  }

  // ================================================================== the player's side

  private playerStrength(): number {
    const g = this.g;
    let powers = 0;
    for (const d of ABILITIES) if (d.kind === 'active' && d.id !== 'punch' && d.id !== 'flight' && d.id !== 'superJump' && d.id !== 'speed' && g.abilities.rank(d.id) > 0) powers++;
    return playerStrength(g.abilities.rank('strength'), g.player.k, this.health.frac, powers);
  }

  private hurtPlayer(dmg: number, kind: HurtKind, fx: number, fz: number): void {
    const d = this.health.damage(dmg, kind, fx, fz);
    if (d > 0) this.g.audio.play2d('punch_impact', 0.5, 0.8);
  }

  /**
   * Knocked out: by the police (or while wanted) a fade and the officers cuff them; otherwise
   * defeated — the hospital's rescue drones, or game over with the city against them (game/defeat).
   */
  private knockedOut(kind: HurtKind): void {
    const p = this.g.player.pos;
    this.wake = { x: p.x, y: p.y, z: p.z };
    if (kind === 'police' || this.justice.wanted > 0) { this.hud.fade(true); return; } // the officers cuff them (arrest) or not
    // (The rescue is decided on the reputation before the knockout's own cost.)
    if (!this.g.defeat?.begin(kind)) this.hud.fade(true);
    if (kind === 'robot' || kind === 'monster' || kind === 'military') return; // a threat (or the army's stray fire) knocked them out: no karma penalty (THREATS_PLAN §5.6)
    this.g.progress.addKarma(-5, 'knocked out');
    this.rep.add(-1, 'knocked out');
  }

  private wakeUp(): void {
    this.hud.fade(false);
    const P = this.g.player;
    P.downT = 0.8;
    // Whoever did it has gone; the criminals of an active crime may have run.
    this.g.powerHud.toast('You come round, sore but alive', 'info');
  }

  /** An officer cuffed the player. */
  private playerArrested(): void {
    this.justice.arrested();
    this.rep.count('busted');
    this.health.koT = 0;
    this.health.hp = this.health.max * 0.6;
    this.hud.fade(true);
    setTimeout(() => this.hud.fade(false), 2200);
    this.g.player.downT = 2.2;
    for (const u of this.police.units) if (u.job.kind === 'player') u.state = 'leaving';
  }

  /** Running into a criminal at full tilt brings them down. */
  private tackle(dt: number): void {
    this.tackleT -= dt;
    const P = this.g.player;
    const sp = Math.hypot(P.vel.x, P.vel.z);
    if (this.tackleT > 0 || sp < 4.4 * Math.sqrt(P.k) || P.flying || P.downT > 0) return;
    for (const a of this.g.peds.neighbours(P.pos.x, P.pos.z, P.radius + 1.0, [])) {
      const act = a.actor;
      if (!act || !act.hostile || a.state === PState.Down || Math.abs(a.y - P.pos.y) > 1.2) continue;
      if (Math.hypot(a.x - P.pos.x, a.z - P.pos.z) > P.radius + 0.55) continue;
      const J = 75 * P.mass / 80 * sp;
      this.combat.hitActor(a, (P.vel.x / sp) * J, J * 0.2, (P.vel.z / sp) * J, 'tackle', 'player', P.pos.x, P.pos.z);
      P.vel.x *= 0.3; P.vel.z *= 0.3;
      P.action = { id: 'stagger', t0: P.animClock, dur: 0.5 };
      this.g.camRig.addShake(0.2);
      this.tackleT = 1.2;
      break;
    }
  }

  /** Soft lock for punches: the selected (or nearest hostile) person within reach. */
  private punchAim(): number | null {
    const g = this.g, p = g.player.pos;
    let tgt: PedAgent | null = null;
    const cur = g.targeting.current;
    if (cur?.kind === 'person' && Math.hypot(cur.obj.x - p.x, cur.obj.z - p.z) < 2.8) tgt = cur.obj;
    if (!tgt) {
      let bd = 2.2;
      const d = aimDir(g.renderer.camera, new THREE.Vector3());
      const fy = Math.hypot(d.x, d.z) > 0.05 ? Math.atan2(-d.x, -d.z) : g.camRig.forwardYaw, fx = -Math.sin(fy), fz = -Math.cos(fy);
      for (const a of g.peds.neighbours(p.x, p.z, 2.4, [])) {
        if (!a.actor?.hostile || a.state === PState.Down) continue;
        const dx = a.x - p.x, dz = a.z - p.z, d = Math.hypot(dx, dz);
        if (d < bd && (dx * fx + dz * fz) / (d || 1) > 0.3) { bd = d; tgt = a; }
      }
    }
    return tgt ? Math.atan2(-(tgt.x - p.x), -(tgt.z - p.z)) : null;
  }

  /** Target frame: names for actors, con colour, health. */
  private describe(t: Target): { name?: string; con: string | null; health: number | null } {
    // A monster: its strength against the player's (deadly, unless the hero is a giant too).
    if (t.kind === 'threat') return { con: CON_COLOR[conLevel(t.obj.conStrength() / Math.max(0.05, this.view.strength))], health: t.obj.hp / t.obj.maxHp };
    if (t.kind !== 'person') return { con: null, health: null };
    const a = t.obj, act = a.actor;
    let name: string | undefined;
    let friends = 0;
    if (act) {
      const c = this.crimeOf(a);
      if (act.role === 'criminal' && c) {
        name = act.title ?? KINDS[c.kind].criminal;
        friends = c.criminals.filter((o) => o !== a && o.alive && o.actor && o.actor.hostile && Math.hypot(o.x - a.x, o.z - a.z) < 15).length;
      } else name = act.title ?? ROLE_NAME[act.role];
      if (name) {
        const st = act.state === 'arrested' ? ' (cuffed)' : act.state === 'surrender' ? ' (hands up)' : act.state === 'ko' ? ' (out cold)' : a.state === PState.Down ? ' (down)' : act.armed !== 'none' && act.hostile ? ` (${act.armed})` : '';
        name += st;
      }
    }
    const lvl = conLevel(personStrength(a, friends) / Math.max(0.05, this.view.strength));
    return { name, con: CON_COLOR[lvl], health: this.combat.hpOf(a) / this.combat.maxHpOf(a) };
  }

  // ================================================================== loot and E

  private updateLoot(dt: number): void {
    const g = this.g, P = g.player, p = P.pos;
    const now = this.time;
    for (let i = this.loots.length - 1; i >= 0; i--) {
      const L = this.loots[i], l = L.loot;
      if (!L.crime.active && !L.endT) L.endT = now;
      const far = Math.hypot(l.x - p.x, l.z - p.z) > 220;
      if (l.returned || (L.endT && now - L.endT > 120 && l.carrier !== 'player') || (far && l.carrier !== 'player' && !L.crime.active) || (Number.isNaN(l.x) && !L.crime.active)) {
        this.group.remove(L.obj, L.glint);
        L.glint.material.map?.dispose(); L.glint.material.dispose();
        this.loots.splice(i, 1);
        continue;
      }
      const ground = l.carrier === null && Number.isFinite(l.x);
      L.obj.visible = ground || l.carrier === 'player';
      L.glint.visible = ground;
      if (ground) {
        const y = g.collision.groundAt(l.x, l.z, l.y + 1, 1.5);
        L.obj.position.set(l.x, y + 0.01, l.z);
        L.obj.rotation.set(0, 0.7, l.kind === 'bag' ? 1.5 : 0);
        const k = 0.5 + 0.5 * Math.sin(now * 3.1);
        L.glint.position.set(l.x, y + 0.3, l.z);
        L.glint.material.opacity = 0.25 + 0.75 * k * k;
        L.glint.scale.setScalar(0.24 + 0.16 * k);
      } else if (l.carrier === 'player') {
        const h = P.height, fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw);
        L.obj.position.set(p.x + fx * 0.28 * h / 1.8 + fz * 0.2, p.y + h * 0.48, p.z + fz * 0.28 * h / 1.8 - fx * 0.2);
        L.obj.rotation.set(0, P.yaw, 0);
        l.x = p.x; l.z = p.z; l.y = p.y;
      }
      void dt;
    }
  }

  /** Who takes the loot back: its owner (victim), else the shopkeeper / an officer. */
  private returnTo(L: { loot: Loot; crime: Crime }): PedAgent | null {
    const cands: PedAgent[] = [];
    if (L.loot.owner?.alive) cands.push(L.loot.owner);
    for (const e of L.crime.extras) if (e.alive && e.actor?.role === 'shopkeeper') cands.push(e);
    return cands[0] ?? null;
  }

  /**
   * Where carried loot goes back: its owner / the shopkeeper; with nobody waiting any more, the
   * police (the nearest officer, else a patrol car near by); else the spot of the crime (the shop).
   */
  private returnTarget(L: { loot: Loot; crime: Crime }): { x: number; z: number; who: PedAgent | null; kind: 'owner' | 'police' | 'site' } {
    const who = this.returnTo(L);
    if (who) return { x: who.x, z: who.z, who, kind: 'owner' };
    const p = this.g.player.pos;
    const o = this.police.nearestOfficer(p.x, p.z, Infinity);
    if (o) return { x: o.x, z: o.z, who: o, kind: 'police' };
    const car = this.police.nearestCar(p.x, p.z, 400);
    if (car) return { x: car.x, z: car.z, who: null, kind: 'police' };
    return { x: L.crime.x, z: L.crime.z, who: null, kind: 'site' };
  }

  /** Text for E, or null. */
  hint(): string | null {
    const p = this.g.player.pos;
    for (const L of this.loots) {
      const l = L.loot;
      if (l.carrier === null && Number.isFinite(l.x) && Math.hypot(l.x - p.x, l.z - p.z) < 1.6) return `Press <b>E</b> to pick up the ${l.kind === 'cash' ? 'cash bag' : l.kind}`;
      if (l.carrier === 'player') {
        const what = l.kind === 'cash' || l.kind === 'envelope' ? 'money' : l.kind;
        const T = this.returnTarget(L);
        const d = Math.hypot(T.x - p.x, T.z - p.z);
        if (T.kind === 'owner' && d < 2.8) return `Press <b>E</b> to give the ${what} back`;
        if (T.kind === 'police' && (this.police.nearestOfficer(p.x, p.z, 2.6) || this.police.nearestCar(p.x, p.z, 4))) return `Press <b>E</b> to hand the ${what} to the police`;
        if (T.kind === 'site' && d < 4) return `Press <b>E</b> to leave the ${what} ${l.kind === 'cash' || l.kind === 'envelope' ? 'at the shop' : 'here'}`;
        // On the way: say where it goes (the green mark on the map and compass).
        const to = T.kind === 'police' ? 'to the police' : l.kind === 'cash' || l.kind === 'envelope' ? 'back to the shop' : 'back to its owner';
        return `Bring the ${what} ${to} — the green mark on your map and compass`;
      }
    }
    if (this.justice.hot && (this.police.nearestOfficer(p.x, p.z, 2.6) || this.police.nearestCar(p.x, p.z, 4))) return 'Press <b>E</b> to turn yourself in';
    const h = this.bustable();
    if (h) return `Press <b>E</b> to bust the stash of ${inSentence(this.factions.factions[h.faction])}`;
    return this.deeds.hint();
  }

  /** E: pick up / give back loot, turn yourself in, small deeds. True when used. */
  use(): boolean {
    const g = this.g, P = g.player, p = P.pos;
    for (const L of this.loots) {
      const l = L.loot;
      if (l.carrier === null && Number.isFinite(l.x) && Math.hypot(l.x - p.x, l.z - p.z) < 1.6) {
        l.carrier = 'player';
        P.action = { id: 'pickup', t0: P.animClock, dur: 0.9 };
        return true;
      }
      if (l.carrier === 'player') {
        const T = this.returnTarget(L);
        const who = T.kind === 'owner' ? T.who : null;
        const officer = T.kind === 'police' && (this.police.nearestOfficer(p.x, p.z, 2.6) || this.police.nearestCar(p.x, p.z, 4)) ? true : null;
        if ((who && Math.hypot(who.x - p.x, who.z - p.z) < 2.8) || officer || (T.kind === 'site' && Math.hypot(T.x - p.x, T.z - p.z) < 4)) {
          l.carrier = null;
          l.returned = true;
          L.crime.playerInvolved = true;
          P.action = { id: 'pickup', t0: P.animClock, dur: 0.8 };
          const k = officer ? Math.round(CRIME_KARMA.returned / 2) : CRIME_KARMA.returned;
          g.progress.addKarma(k, officer ? 'handed in stolen property' : `returned the stolen ${l.kind === 'cash' || l.kind === 'envelope' ? 'money' : l.kind}`);
          this.rep.add(officer ? 1 : 2, 'returned');
          this.rep.count('returned');
          if (who?.actor) { who.actor.held = l.kind === 'bag' ? 'bag' : null; who.actor.mood = 'happy'; }
          else if (who) { who.helped = true; who.state = PState.Idle; who.stateT = 0; }
          this.sound('crowd_cheer', p.x, p.y + 2, p.z, 0.25);
          return true;
        }
      }
    }
    if (this.justice.hot && (this.police.nearestOfficer(p.x, p.z, 2.6) || this.police.nearestCar(p.x, p.z, 4))) {
      this.justice.turnIn();
      for (const u of this.police.units) if (u.job.kind === 'player') u.state = 'leaving';
      P.action = { id: 'pickup', t0: P.animClock, dur: 0.8 };
      return true;
    }
    const h = this.bustable();
    if (h) { this.bust(h); return true; }
    return this.deeds.use();
  }

  // ================================================================== world reactions, map

  /** Reputation in the street: the feared make people step away, the loved get waves. */
  private crowdAttitude(dt: number): void {
    this.repT -= dt;
    if (this.repT > 0) return;
    this.repT = 1.2;
    const g = this.g, p = g.player.pos, r = this.rep;
    if (!r.feared && !r.cheers) return;
    for (const a of g.peds.neighbours(p.x, p.z, r.feared ? 7 : 9, [])) {
      if (a.actor || a.inside || a.state === PState.Down || a.state === PState.Flee) continue;
      if (r.feared) { a.fear = Math.min(2, a.fear + 0.7); a.fearX = p.x; a.fearZ = p.z; a.state = PState.Flee; a.stateT = 0; }
      else if (a.state === PState.Walk && hash32(a.id * 31 + Math.floor(this.time / 20)) % 9 === 0) { a.state = PState.Idle; a.stateT = 0; a.helped = true; a.heading = Math.atan2(-(p.x - a.x), -(p.z - a.z)); }
    }
  }

  private markers(dt: number): void {
    this.markT -= dt;
    if (this.markT > 0) return;
    this.markT = 0.4;
    const list: MapMarker[] = [];
    for (const c of this.crimes) {
      if (!c.committed || !c.active) continue;
      // A group's operation: its colour and name.
      const f = this.factionOf(c), color = f ? f.palette.map : '#ff3b30', by = f ? `${f.emblem} ${f.name}: ` : '';
      for (const a of c.criminals) {
        const act = a.actor;
        if (!a.alive || !act || act.state === 'gone' || act.state === 'arrested') continue;
        const down = act.state === 'ko' || act.state === 'surrender';
        list.push({ x: a.x, z: a.z, color, kind: down ? 'dot' : 'alert', title: down ? 'A criminal, stopped — the police will take over' : by + KINDS[c.kind].title });
      }
      if (c instanceof Robbery && c.phase === 'getaway' && c.car) list.push({ x: c.car.x, z: c.car.z, color, kind: 'alert', title: `${by}Getaway car — block it or stop it` });
    }
    for (const u of this.police.units) list.push({ x: u.car.x, z: u.car.z, color: '#3b82f6', kind: 'dot', title: 'Police' });
    // Carried loot: where it goes back (also on the compass at any distance).
    for (const L of this.loots) {
      if (L.loot.carrier !== 'player') continue;
      const T = this.returnTarget(L);
      list.push({ x: T.x, z: T.z, color: '#4cd964', kind: 'alert', title: 'The stolen goods go back here (E)', always: true });
    }
    const key = list.map((m) => `${m.kind[0]}${Math.round(m.x / 2)},${Math.round(m.z / 2)}`).join(';');
    if (key !== this.markKey) { this.markKey = key; this.g.map.setMarkers('crime', list); }
  }

  /** Criminals for the HUD tags: committed, standing, within 80 m. */
  *fleeing(): Generator<PedAgent> {
    for (const c of this.crimes) {
      if (!c.committed || !c.active) continue;
      for (const a of c.criminals) {
        const act = a.actor;
        if (!a.alive || !act || !act.hostile || a.state === PState.Down || act.state === 'surrender' || act.state === 'ko' || act.state === 'arrested') continue;
        if (Math.hypot(a.x - this.view.x, a.z - this.view.z) < 80) yield a;
      }
    }
  }

  // ================================================================== dev console

  private installDev(): void {
    const dev = (window as unknown as { dev?: Record<string, unknown> }).dev;
    if (!dev) return;
    this.devDone = true;
    const g = this.g;
    Object.assign(dev, {
      crimeSystem: this,
      /** Start a crime near the player (dist: metres to the site, along the view). */
      crime: (kind: CrimeKind = 'snatch', dist = 25, faction?: number | string, lt?: string) => {
        const p = g.player.pos, fy = g.camRig.forwardYaw;
        // A group by id, or by kind ('techno': the city's techno-cult).
        const fid = typeof faction === 'string' ? this.factions.factions.find((f) => f.archetype === faction)?.id ?? -1 : faction;
        const c = this.spawnCrime(kind, { x: p.x - Math.sin(fy) * dist, z: p.z - Math.cos(fy) * dist }, fid, lt);
        return c ? c.snapshot() : 'no site';
      },
      /** Hacks and rituals under way: nearly done (the next second finishes them). */
      rushOps: () => {
        let n = 0;
        for (const c of this.crimes) if (c instanceof Channeling && c.phase === 'commit') { c.progress = Math.max(c.progress, c.spec.workFor - 1); n++; }
        return n;
      },
      /** Hijacked machines: per hack, how many are still at it and how it ended. */
      fleets: () => this.fleets.map((F) => ({ crime: F.crime.id, t: Math.round(F.t), active: F.active, end: F.end, units: F.units.length, live: F.live().length, byPlayer: F.byPlayer })),
      /** The city's villain groups: name, kind, home cell, cells held; the one whose turf the player stands in. */
      factions: () => {
        const F = this.factions, p = g.player.pos, here = this.factionAt(p.x, p.z);
        return {
          here: here?.name ?? null, stats: { ...this.factionStats }, tags: this.graffiti.tags.length,
          groups: F.factions.map((f) => {
            const h = this.hideouts[f.id];
            return { id: f.id, name: f.name, archetype: f.archetype, colour: f.palette.name, emblem: f.emblem, home: f.home, cells: F.holder.filter((x) => x === f.id).length, hideout: h ? { cell: h.cell, door: h.door ? { x: Math.round(h.door.x * 10) / 10, z: Math.round(h.door.z * 10) / 10 } : null, found: h.found, bustedUntil: Math.round(h.bustedUntil * 10) / 10, moves: h.moves, guards: this.guards.get(f.id)?.guarding ?? 0 } : null };
          }),
        };
      },
      /**
       * Hideouts: dev.hideout(id) places the group's hideout now (wherever the player is: its cell's
       * doors must be loaded), marks it found and returns where it is; dev.hideout(id, 'go') also
       * puts the player 75 m in front of it (far enough for the guards to be posted out of view).
       */
      hideout: (id = 0, go?: 'go') => {
        const h = this.hideouts[id];
        if (!h) return 'no such group';
        if (!h.door) {
          const cell = hideoutCell(this.factions, id);
          const c = g.macro.cells[cell];
          if (!c) return 'no turf';
          h.cell = cell;
          h.door = pickDoor(this.doorsIn(cell), g.settings.seed, id, h.moves, c.centroid[0], c.centroid[1], c.radius);
          if (!h.door) {
            // Its block is not loaded yet: go there first (then ask again).
            if (go) g.player.pos.set(c.centroid[0], g.world.groundHeight(c.centroid[0], c.centroid[1]) + 3, c.centroid[1]);
            return `cell ${cell} not loaded yet${go ? ': flown over it — call again in a moment' : ` (it is at ${Math.round(c.centroid[0])}, ${Math.round(c.centroid[1])})`}`;
          }
        }
        h.found = true;
        this.hideKey = '';
        if (go) { const D = h.door, r = 75; g.player.pos.set(D.x + D.nx * r, g.world.groundHeight(D.x + D.nx * r, D.z + D.nz * r) + 1, D.z + D.nz * r); }
        return { cell: h.cell, door: h.door };
      },
      /** Off-screen drift: run n game hours of it now (the map updates); returns the cells that changed hands. */
      drift: (hours = 24) => {
        let n = 0;
        const h0 = Math.floor(g.sky.hoursAbs);
        for (let k = 1; k <= hours; k++) n += drift(this.factions, g.settings.seed, h0 + 1000 + k).length;
        this.factionStats.drifted += n;
        g.map.setTurf(this.factions);
        return n;
      },
      crimes: () => this.crimes.map((c) => c.snapshot()),
      crimeStats: () => ({ ...this.stats, actors: this.actorCount, director: this.director.stats, police: this.police.summary(), wanted: this.justice.wanted, heat: +this.justice.heat.toFixed(2), rep: this.rep.value, hp: Math.round(this.health.hp), combat: this.combat.stats }),
      deed: (kind: SmallDeedKind = 'cat') => this.deeds.start(kind),
      /**
       * Small arms: dev.guns() → stats; dev.guns(true) arms every robbery / mugging leader with a gun
       * (false: back to chance).
       */
      guns: (on?: boolean) => { if (on !== undefined) CRIME_DEV.guns = on; return { force: CRIME_DEV.guns, ...this.guns.stats, police: { ...this.police.stats }, response: this.g.response ? { ...this.g.response.stats } : null }; },
      wanted: (n = 1) => { this.justice.heat = [0, 2.6, 6.1, 12.1][Math.max(0, Math.min(3, n))]; (this.justice as unknown as { levelUp(): void }).levelUp(); return this.justice.wanted; },
      setCrime: (s: CrimeSetting) => { this.setting = s; return s; },
      maxCrimes: SETTING_MAX,
    });
  }
}

function loadSetting(): CrimeSetting {
  try { const s = localStorage.getItem(SETTING_KEY); if (s === 'off' || s === 'calm' || s === 'normal' || s === 'chaos') return s; } catch { /* storage unavailable */ }
  return 'normal';
}

export type { Vehicle };
