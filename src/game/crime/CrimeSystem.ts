/**
 * The street-crime layer in the game ("Street Hero", PLAYGROUND_PLAN §5 Phase 1): ties the director,
 * the crimes, the police, justice, combat, the player's health, reputation and the small deeds to
 * the living city, and draws what belongs to it (dropped loot, a caret over a fleeing criminal, map
 * marks, the crime-index map layer, health / reputation / wanted in the HUD).
 *
 * Rewards (Normal mode; karma, reputation):
 *   knocking out a criminal yourself   snatch 8 · mugging 10 · robbery 14 karma, +2 rep
 *   a criminal giving up to you        6 karma, +1 rep
 *   the crime stopped with your help   snatch 10 · mugging 15 · robbery 25 karma (+25 % with no
 *                                      bystander hurt), +3 / +4 / +6 rep, the crowd cheers
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
import { makeActor, attach, setState, tickActor, type ActorRole } from '../../sim/actors/Actor';
import { Combat } from '../Combat';
import { PlayerHealth, type HurtKind } from '../PlayerHealth';
import { Reputation } from '../Reputation';
import { CON_COLOR, conLevel, personStrength, playerStrength } from '../Consider';
import { crimeIndex, SETTING_MAX, type CrimeSetting } from './CrimeIndex';
import { CrimeDirector, type CrimeRoll } from './CrimeDirector';
import { Crime, type CrimeKind, type CrimeWorld, type GetawayCar, type Loot, type PlayerView } from './Crime';
import { Snatch } from './Snatch';
import { Mugging } from './Mugging';
import { Robbery } from './Robbery';
import { Police, policeOutfit, POLICE } from './Police';
import { Justice } from './Justice';
import { SmallDeeds, type SmallDeedKind } from '../deeds/SmallDeeds';
import { makeItem, makeGlint } from '../deeds/critters';
import type { MapMarker } from '../../ui/map/GameMap';
import type { Target } from '../Targeting';
import type { StreetProp } from '../../props/PropRenderer';
import { CrimeHud } from '../../ui/CrimeHud';
import { ABILITIES } from '../abilities/defs';

export const CRIME_KARMA = {
  ko: { snatch: 8, mugging: 10, robbery: 14 } as Record<CrimeKind, number>,
  surrender: 6,
  resolved: { snatch: 10, mugging: 15, robbery: 25 } as Record<CrimeKind, number>,
  resolvedRep: { snatch: 3, mugging: 4, robbery: 6 } as Record<CrimeKind, number>,
  cleanBonus: 0.25,
  returned: 8,
};

export const ACTOR_BUDGET = 40;
const SETTING_KEY = 'scale.crime.setting';

/** Names shown on the target frame for actors (the frame is the one place a role is named). */
const ROLE_NAME: Record<string, string> = { police: 'Police officer', shopkeeper: 'Shopkeeper' };
const CRIMINAL_NAME: Record<CrimeKind, string> = { snatch: 'Thief', mugging: 'Mugger', robbery: 'Robber' };

const _v = new THREE.Vector3();

export class CrimeSystem {
  readonly combat: Combat;
  readonly health: PlayerHealth;
  readonly rep: Reputation;
  readonly director: CrimeDirector;
  readonly police: Police;
  readonly justice: Justice;
  readonly deeds: SmallDeeds;
  readonly crimes: Crime[] = [];
  readonly index: Float32Array;
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
    g.targeting.priority = (t) => (t.kind === 'person' && t.obj.actor ? (t.obj.actor.hostile ? -0.6 : -0.08) : 0);
    g.interactions.aimYaw = () => this.punchAim();
    // P screen: reputation.
    const info = g.powers.info;
    g.powers.info = () => `${info()} <span class="pw-rep">Reputation: <b>${this.rep.label()}</b> (${this.rep.value > 0 ? '+' : ''}${Math.round(this.rep.value)}) · crimes stopped ${this.rep.stats.stopped} · deeds ${this.rep.stats.deeds}</span>`;
    g.gate?.precompile?.(SmallDeeds.warmup());
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
      getaway: (x, z) => this.getaway(x, z),
    };
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

  private shops(rMin: number, rMax: number): { x: number; z: number; nx: number; nz: number }[] {
    const p = this.g.player.pos, W = this.g.world;
    const out: { x: number; z: number; nx: number; nz: number; d: number }[] = [];
    for (const r of W.buildingsIn(p.x - rMax, p.z - rMax, p.x + rMax, p.z + rMax)) {
      const d = r.desc;
      if (!r.alive || !(d.shopfront || d.use === 'retail')) continue;
      const door = doorOf(d);
      const dist = Math.hypot(door.x - p.x, door.z - p.z);
      if (dist < rMin || dist > rMax) continue;
      // The pavement in front must be free (not inside another building).
      const fx = door.x + door.nx * 3, fz = door.z + door.nz * 3;
      if (W.buildingAt(fx, fz)) continue;
      out.push({ ...door, d: dist });
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

  private playerCell(): { cell: number; district: import('../../plan/types').District; index: number } | null {
    const p = this.g.player.pos, cells = this.g.macro.cells;
    let best = -1, bd = Infinity;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const d = Math.hypot(c.centroid[0] - p.x, c.centroid[1] - p.z);
      if (d > c.radius + 50) continue;
      if (pointInPoly(c.poly, p.x, p.z)) { best = i; break; }
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) return null;
    return { cell: best, district: cells[best].district, index: this.index[best] };
  }

  private make(kind: CrimeKind, seed: number, near: { x: number; z: number } | null): Crime {
    return kind === 'snatch' ? new Snatch(this.world, seed, near) : kind === 'mugging' ? new Mugging(this.world, seed, near) : new Robbery(this.world, seed, near);
  }

  private startRoll(r: CrimeRoll): boolean {
    if (this.actorCount > ACTOR_BUDGET - 6 || this.crimes.filter((c) => c.active).length >= 3) return false;
    if (this.g.player.height > 6 || this.g.underground.isUnder(this.g.player.pos.x, this.g.player.pos.y + 0.5, this.g.player.pos.z)) return false;
    return this.begin(this.make(r.kind, r.seed, null));
  }

  private begin(c: Crime): boolean {
    if (!c.setup()) { c.abort(); c.dispose(); return false; }
    this.crimes.push(c);
    this.stats.started++;
    return true;
  }

  /** Dev / test: a crime of a kind near the player (dist m away) or at a point. */
  spawnCrime(kind: CrimeKind, near?: { x: number; z: number }): Crime | null {
    const c = this.make(kind, (Math.random() * 2 ** 32) >>> 0, near ?? null);
    return this.begin(c) ? c : null;
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
    this.police.update(dt);
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
      n++;
      tickActor(act, dt);
      if (a.state === PState.Down && (act.state === 'down' || (act.state === 'ko' && act.role === 'police'))) {
        act.upT -= dt;
        if (act.upT <= (act.state === 'ko' ? -18 : 0)) {
          a.state = PState.Idle; a.vx = a.vz = a.vy = 0; a.stateT = 0;
          if (act.role === 'police') act.hp = Math.max(act.hp, act.maxHp * 0.5);
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
          g.progress.addKarma(CRIME_KARMA.ko[c.kind], `knocked out a ${CRIMINAL_NAME[c.kind].toLowerCase()}`);
          this.rep.add(2, 'ko');
        }
        break;
      case 'surrender':
        if (who && near(who) < 8) {
          c.playerInvolved = true;
          g.progress.addKarma(CRIME_KARMA.surrender, `a ${CRIMINAL_NAME[c.kind].toLowerCase()} gave up`);
          this.rep.add(1, 'surrender');
        }
        break;
      case 'arrest':
        this.rep.count('arrests');
        break;
      case 'resolved':
        if (c.playerInvolved) {
          const clean = c.collateral === 0;
          const k = Math.round(CRIME_KARMA.resolved[c.kind] * (clean ? 1 + CRIME_KARMA.cleanBonus : 1));
          g.progress.addKarma(k, `stopped a ${c.kind === 'snatch' ? 'purse snatching' : c.kind === 'mugging' ? 'mugging' : 'robbery'}${clean ? ' — nobody else hurt' : ''}`);
          this.rep.add(CRIME_KARMA.resolvedRep[c.kind], 'crime stopped');
          this.rep.count('stopped');
          this.justice.atone(1.5);
          this.cheer();
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

  /** Knocked out: fade, wake up where one fell (or, cuffed, released at the scene). */
  private knockedOut(kind: HurtKind): void {
    const p = this.g.player.pos;
    this.wake = { x: p.x, y: p.y, z: p.z };
    this.hud.fade(true);
    if (kind === 'police' || this.justice.wanted > 0) return; // the officers cuff them (arrest) or not
    if (kind === 'robot') return; // a threat knocked them out: no karma penalty (THREATS_PLAN §5.6)
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
    if (t.kind !== 'person') return { con: null, health: null };
    const a = t.obj, act = a.actor;
    let name: string | undefined;
    let friends = 0;
    if (act) {
      const c = this.crimeOf(a);
      if (act.role === 'criminal' && c) {
        name = CRIMINAL_NAME[c.kind];
        friends = c.criminals.filter((o) => o !== a && o.alive && o.actor && o.actor.hostile && Math.hypot(o.x - a.x, o.z - a.z) < 15).length;
      } else name = ROLE_NAME[act.role];
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
        const what = l.kind === 'cash' ? 'money' : l.kind;
        const T = this.returnTarget(L);
        const d = Math.hypot(T.x - p.x, T.z - p.z);
        if (T.kind === 'owner' && d < 2.8) return `Press <b>E</b> to give the ${what} back`;
        if (T.kind === 'police' && (this.police.nearestOfficer(p.x, p.z, 2.6) || this.police.nearestCar(p.x, p.z, 4))) return `Press <b>E</b> to hand the ${what} to the police`;
        if (T.kind === 'site' && d < 4) return `Press <b>E</b> to leave the ${what} ${l.kind === 'cash' ? 'at the shop' : 'here'}`;
        // On the way: say where it goes (the green mark on the map and compass).
        const to = T.kind === 'police' ? 'to the police' : l.kind === 'cash' ? 'back to the shop' : 'back to its owner';
        return `Bring the ${what} ${to} — the green mark on your map and compass`;
      }
    }
    if (this.justice.hot && (this.police.nearestOfficer(p.x, p.z, 2.6) || this.police.nearestCar(p.x, p.z, 4))) return 'Press <b>E</b> to turn yourself in';
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
          g.progress.addKarma(k, officer ? 'handed in stolen property' : `returned the stolen ${l.kind === 'cash' ? 'money' : l.kind}`);
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
      for (const a of c.criminals) {
        const act = a.actor;
        if (!a.alive || !act || act.state === 'gone' || act.state === 'arrested') continue;
        list.push({ x: a.x, z: a.z, color: '#ff3b30', kind: act.state === 'ko' || act.state === 'surrender' ? 'dot' : 'alert', title: '' });
      }
      if (c instanceof Robbery && c.phase === 'getaway' && c.car) list.push({ x: c.car.x, z: c.car.z, color: '#ff3b30', kind: 'alert', title: '' });
    }
    for (const u of this.police.units) list.push({ x: u.car.x, z: u.car.z, color: '#3b82f6', kind: 'dot', title: '' });
    // Carried loot: where it goes back (also on the compass at any distance).
    for (const L of this.loots) {
      if (L.loot.carrier !== 'player') continue;
      const T = this.returnTarget(L);
      list.push({ x: T.x, z: T.z, color: '#4cd964', kind: 'alert', title: 'Give it back here', always: true });
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
      crime: (kind: CrimeKind = 'snatch', dist = 25) => {
        const p = g.player.pos, fy = g.camRig.forwardYaw;
        const c = this.spawnCrime(kind, { x: p.x - Math.sin(fy) * dist, z: p.z - Math.cos(fy) * dist });
        return c ? c.snapshot() : 'no site';
      },
      crimes: () => this.crimes.map((c) => c.snapshot()),
      crimeStats: () => ({ ...this.stats, actors: this.actorCount, director: this.director.stats, police: this.police.summary(), wanted: this.justice.wanted, heat: +this.justice.heat.toFixed(2), rep: this.rep.value, hp: Math.round(this.health.hp), combat: this.combat.stats }),
      deed: (kind: SmallDeedKind = 'cat') => this.deeds.start(kind),
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
