/**
 * The slime civilisation in the game (`game.slimeRealm`): the two peoples under the city, the war
 * between them and what the player means to the Lumen.
 *
 *  - Areas of the deep realm come alive near the player (Factions agents spawned from the war's
 *    state: the Hall full or held by the Murk, the Front's guards, the Warrens' pens …).
 *  - The war (War.ts) runs on game time; raids happen live at the trench when the player is near,
 *    else they are decided by strength. Between raids the Warrens' mouth is a trench war that never stops
 *    (TrenchWar): small pushes of Murk over no-man's land, shot down by the Lumen's sentries. A raid while the player is anywhere in the caves is
 *    announced. If the Murk hold the Hall and are strong they break out into the city at night
 *    (MurkBreach, a threat event: police, compass, music).
 *  - Trust (Trust.ts): gifts taken in the colonies, Murk killed, raids repelled with the player,
 *    pens broken open, the Maw brought down; hurting Lumen costs a lot. It runs the lift and
 *    brings glow pebbles (≥ Welcome), grants the Slime call
 *    (≥ Ally, rank 2 at Kin, 3 at full trust after the Maw), shows the second mosaic (Kin).
 *  - Slime call: Lumen pour out of the nearest manhole (in the sewers or caves: out of the cracks)
 *    to the target — holding a person down, stalling a car or machine, gnawing at a monster,
 *    fighting the Murk, smothering fires — and go back after a while.
 *  - The Heart: close to it the player's own shard answers (a pulse, a shake, its hum).
 *  - Saves: trust and war (SaveData.slimes); per city in localStorage too.
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import { Factions, MurkActor, type Blob, type FactionHost, type Role } from '../../underground/deep/Factions';
import { Trust, TRUST, callRank, tierOf, type TrustTier, type TrustData } from '../../underground/deep/Trust';
import { freshWar, stepWar, raiderDown, murkDown, endRaid, freePen, mawDown, parseWar, type WarState } from '../../underground/deep/War';
import type { DeepPlan } from '../../underground/deep/plan';
import type { DeepField } from '../../underground/deep/field';
import { MurkBreach } from './MurkBreach';
import { TrenchWar } from './TrenchWar';
import { statusFor } from '../../shared/status';
import { POWER_HIT, SLIME_COST, SLIME_COUNT, SLIME_HOLD, SLIME_REACH, SLIME_TIME } from '../abilities/tuning';
import { G } from '../../render/materials/globals';
import type { ThreatActor } from '../threats/ThreatEvent';
import type { Stimulus } from '../Stimuli';
import { Rng, deriveSeed } from '../../core/rng';

/** Areas: where they are, reach (m) — agents live while the player is within reach + SPAWN. */
const SPAWN = 110, DROP = 170;

/** `war` is the first realm's (older saves have only that); `wars` every realm's, by its colony. */
export interface SaveSlimes { trust: TrustData; war: WarState | null; wars?: Record<string, WarState> }

export class SlimeRealm {
  readonly trust: Trust;
  /** Each realm's war (one realm below each colony; game.underground.deeps' order). */
  private wars: WarState[] = [];
  /** The realm the player is near (game.underground.deep): its war is the live one, its agents are about. */
  private realm = 0;
  get war(): WarState { return this.wars[this.realm]; }
  readonly F: Factions | null = null;
  private plan: DeepPlan | null;
  private field: DeepField | null;
  private warT = 0;
  private hurtT = 0;
  private live = false;
  private raidT = 0;
  private pebble: { mesh: THREE.Mesh; x: number; y: number; z: number; t: number } | null = null;
  private pebbleT = 120;
  private heartLoop: ReturnType<Game['audio']['loop']> = null;
  private ambGlow: ReturnType<Game['audio']['loop']> = null;
  private ambMurk: ReturnType<Game['audio']['loop']> = null;
  private battleLoop: ReturnType<Game['audio']['loop']> = null;
  private breach: MurkBreach | null = null;
  readonly trenches: TrenchWar | null = null;
  private trenchOn = false;
  private lastRank = 0;
  /** Music (read by Music.probe): a fight with the Murk near, a raid / the Maw. */
  readonly music = { danger: 0, battle: 0 };
  /** Where the player is: in the caves, which part. */
  where: 'none' | 'road' | 'glow' | 'front' | 'deep' = 'none';
  private storeKey: string;
  private safe = new THREE.Vector3(1e9, 0, 0);

  constructor(private g: Game) {
    const sb = g.mode === 'sandbox';
    this.trust = new Trust(g.settings.seed, g.settings.size, g.mode, sb);
    const D = g.underground.deep;
    this.plan = D?.plan ?? null;
    this.field = D?.field ?? null;
    const now = g.sky.hoursAbs;
    this.storeKey = `scale.slimewar.v1.${g.mode}.${g.settings.seed}.${g.settings.size.toFixed(2)}`;
    const realms = g.underground.deeps;
    for (let i = 0; i < Math.max(1, realms.length); i++) {
      const pens = realms[i]?.plan.pens.length ?? 0;
      let w: WarState | null = null;
      try { w = parseWar(JSON.parse(localStorage.getItem(this.keyOf(i)) ?? 'null'), pens, now); } catch { /* storage unavailable */ }
      w ??= freshWar(now, pens, this.warRnd(i, now));
      // A save from another session's clock: never step from the far past or future.
      if (Math.abs(w.at - now) > 24 * 10) w.at = now;
      this.wars.push(w);
    }
    this.realm = D ? Math.max(0, realms.indexOf(D)) : 0;
    if (D) {
      const host: FactionHost = {
        field: D.field, plan: D.plan,
        player: () => { const P = g.player; return { x: P.pos.x, y: P.pos.y, z: P.pos.z, h: P.height, speed: Math.hypot(P.vel.x, P.vel.z) }; },
        hurtPlayer: (dmg, fx, fz, fy) => { g.crime?.health.damage(dmg, 'monster', fx, fz, fy); g.camRig.addShake(Math.min(0.5, dmg / 40)); },
        shovePlayer: (vx, vy, vz) => { const P = g.player; if (P.flying) return; P.vel.x += vx; P.vel.y += vy; P.vel.z += vz; P.grounded = false; },
        sound: (id, x, y, z, gain, pitch = 1) => g.audio.play(id, x, y, z, gain, pitch, 5, g.renderer.camera.position),
        ground: (x, z, y) => g.collision.groundAt(x, z, y, 0.6),
        trust: () => this.trust.value,
        clear: (ax, ay, az, bx, by, bz) => { const f = this.field!; return f.near(ax, ay, az) && f.air(ax, ay, az) ? f.lineClear(ax, ay, az, bx, by, bz, 0.3) : g.sight.clear(ax, ay, az, bx, by, bz, 0.3); },
        onKill: (b, byPlayer) => this.killed(b, byPlayer),
        onLumenHurt: (b, byPlayer) => this.lumenHurt(b, byPlayer),
        onSplat: (x, y, z, murk) => g.dust.burst(x, y + 0.2, z, 10, 0.4, 1.5, 0.3, 0.8, murk ? new THREE.Color(0.5, 0.05, 0.08) : new THREE.Color(0.2, 1.4, 1.0), 0, 0.5),
      };
      (this as { F: Factions | null }).F = new Factions(host);
      g.underground.group.add(this.F!.group);
      (this as { trenches: TrenchWar | null }).trenches = new TrenchWar(g, this.F!, D.plan, D.field);
      g.underground.group.add(this.trenches!.group);
    }
    // The colonies' own slimes: gifts and hurts count; friends are not fled from.
    const S = g.underground.slimes;
    S.onGift = (c) => {
      if (this.trust.gifted(c)) return;
      this.trust.addGift(c);
      this.trust.add(10, 'took a gift from them');
    };
    S.onHurt = () => this.lumenHurt(null, true);
    this.trust.on((d, v, reason, up) => this.trustChanged(d, v, reason, up));
    // The power.
    g.progress.granted.slimeCall = () => callRank(this.trust.value, this.wars.some((w) => w.stats.maw > 0));
    g.abilities.special.slimeCall = { cost: SLIME_COST, run: (r) => this.call(r) };
    this.lastRank = g.progress.rank('slimeCall');
    g.powers.grantInfo = (id) => (id === 'slimeCall' ? this.trustLine() : null);
    g.stimuli.on((s) => this.stimulus(s));
  }

  // ------------------------------------------------------------------ queries for the game

  /** The Murk near the player as threat actors (targeting). */
  actors(): ThreatActor[] {
    if (!this.F) return [];
    const p = this.g.player.pos;
    return this.F.actors(p.x, p.z, 160);
  }

  /** A physical strike (punch, blast) at a point. */
  blow(x: number, y: number, z: number, r: number, jx: number, jy: number, jz: number): void {
    this.F?.blow(x, y, z, r, jx, jy, jz, true);
  }

  // ------------------------------------------------------------------ per frame

  update(dt: number): void {
    const g = this.g, p = g.player.pos;
    const D = g.underground.deep;
    if (D && D.plan !== this.plan) this.rebind(g.underground.deeps.indexOf(D));
    // The colony slimes' manners follow the trust.
    g.underground.slimes.friendly = this.trust.value >= TRUST.welcome;
    // Where the player is.
    const F = this.field, P = this.plan;
    if (F && P && F.near(p.x, p.y + 0.5, p.z) && F.air(p.x, p.y + 0.6, p.z)) {
      F.sdf(p.x, p.y - 0.4, p.z);
      const reg = F.regionOfLast();
      this.where = reg === 0 ? 'road' : reg === 1 ? 'glow' : reg === 2 ? (p.y < (P.yGlow + P.yDeep) / 2 ? 'deep' : 'front') : 'deep';
    } else this.where = 'none';
    // A safety net: anyone who ends up below the realm (a teleport into rock, a glitch) goes back to
    // where they last stood in the caves.
    if (F && P) {
      if (this.where !== 'none' && g.player.grounded) this.safe.copy(p);
      else if (this.safe.x !== 1e9 && p.y < F.bounds[1] - 8 && Math.abs(p.x - this.safe.x) < 400 && Math.abs(p.z - this.safe.z) < 400) { p.copy(this.safe); p.y += 0.3; g.player.vel.set(0, 0, 0); }
    }
    if (P) this.warTick(dt);
    if (this.F && P) {
      this.areas();
      this.raidTick(dt);
      this.callTick(dt);
      const w = this.war;
      this.trenchOn = this.live && w.front < 0.5 && this.F.areas.has('trench');
      this.trenches?.update(dt, this.trenchOn, !!w.raid, w.murk, w.lumen, w.front);
      this.F.update(dt, g.renderer.camera.position);
      this.lift(dt);
      this.heart(dt);
      this.pebbles(dt);
      this.ambience();
    }
    if (this.breach && !this.breach.active) this.breach = null;
    // Music: a Murk fighting the player near, a raid live / the Maw.
    let danger = 0, battle = 0;
    if (this.F) for (const b of this.F.blobs) {
      if (b.fac !== 'murk' || b.mode !== 'fight' || b.foe) continue;
      if (Math.hypot(b.x - p.x, b.z - p.z) < 30) { danger = 1; if (b.role === 'maw') battle = 1; }
    }
    if (this.war.raid && this.nearTrench(60)) battle = 1;
    this.music.danger = danger; this.music.battle = battle;
    // The deep realm's look.
    if (D) {
      g.underground.deepState.lift = this.trust.value >= TRUST.welcome;
      g.underground.deepState.kin = this.trust.value >= TRUST.kin;
    }
    // Trust ranks the power: a new rank is announced.
    const r = g.progress.rank('slimeCall');
    if (r !== this.lastRank) {
      if (r > this.lastRank && g.mode !== 'sandbox') {
        g.powerHud.toast(r === 1 ? '<b>Slime call</b> — the Lumen will answer you now. Near a manhole, use it on a target (it is on your hotbar)' : `<b>Slime call</b> is now rank ${r}`, 'core', 9000);
        g.audio.chime('buy');
      }
      this.lastRank = r;
      g.progress.grantedChanged('slimeCall');
    }
    this.hurtT = Math.max(0, this.hurtT - dt);
  }

  // ------------------------------------------------------------------ the war

  private warTick(dt: number): void {
    this.warT -= dt;
    if (this.warT > 0) return;
    this.warT = 1;
    const now = this.g.sky.hoursAbs, P = this.plan!;
    const p = this.g.player.pos;
    const fr = P.places.front;
    this.live = !!fr && this.where !== 'none' && (Math.hypot(p.x - fr.x, p.z - fr.z) < 140 || this.nearTrench(110));
    const night = G.uNight.value > 0.5;
    // The clock set back (the hour changed, an older save): the war goes on from now.
    const w = this.war;
    if (w.at > now) { const d = w.at - now; w.at = now; w.nextRaid -= d; w.nextBreach -= d; if (w.mawBack > 0) w.mawBack -= d; }
    stepWar(this.war, now, this.live, night, {
      raid: () => this.raidStart(),
      resolved: (murkWon) => {
        if (this.where !== 'none' && this.where !== 'road') this.g.powerHud.toast(murkWon ? 'Far off, the Lumen lost ground to the Murk' : 'Far off, the Lumen held the Murk back', 'info', 5000);
        this.respawnFront();
      },
      breach: () => this.startBreach(),
      mawBack: () => { this.F?.despawn('heart'); },
    }, this.warRnd(this.realm, now));
    // The other realms' wars go on unseen (decided by strength; their breakouts still come up).
    this.wars.forEach((o, i) => {
      if (i === this.realm) return;
      if (o.at > now) o.at = now;
      stepWar(o, now, false, night, { raid: () => {}, resolved: () => {}, breach: () => this.startBreach(i), mawBack: () => {} }, this.warRnd(i, now));
    });
    this.saveLocal();
  }

  /** The player went down below another colony: that realm's agents, trench and war. */
  private rebind(i: number): void {
    const D = this.g.underground.deeps[i];
    if (!D || !this.F) return;
    this.saveLocal();
    this.realm = i;
    this.plan = D.plan; this.field = D.field;
    this.F.rebind(D.plan, D.field);
    if (this.war.raid) this.war.raid = null;
    this.trenches?.dispose(); this.trenches?.group.removeFromParent();
    (this as { trenches: TrenchWar | null }).trenches = new TrenchWar(this.g, this.F, D.plan, D.field);
    this.g.underground.group.add(this.trenches!.group);
    this.safe.set(1e9, 0, 0);
    this.live = false; this.trenchOn = false;
  }

  /** The war's dice: from the city seed, the realm and the war's clock, so a loaded game rolls the same. */
  private warRnd(i: number, now: number): () => number {
    const r = new Rng(deriveSeed(this.g.settings.seed, 'slimewar', i, Math.floor(now * 60)));
    return () => r.float();
  }

  private keyOf(i: number): string {
    // The first realm keeps the key from before there were several.
    const D = this.g.underground.deeps[i];
    return i === 0 || !D ? this.storeKey : `${this.storeKey}.c${D.plan.hub}`;
  }

  private raidStart(): void {
    const F = this.F, P = this.plan;
    if (!F || !P) return;
    const n = this.war.raid?.n ?? 6;
    // They come out of the Warrens: over the berm, across no-man's land at the trench's gaps.
    const start = P.nodes.find((q) => q.name === 'warrens');
    const line = P.nodes.find((q) => q.name === 'murkLine');
    const gaps = P.nodes.filter((q) => q.name.startsWith('trench'));
    if (!start || !line || !gaps.length) return;
    for (let i = 0; i < n; i++) {
      const target = gaps[i % gaps.length];
      const b = F.spawn('murk', i === 0 && n >= 9 ? 'brute' : 'raider', start.x + (Math.random() - 0.5) * 6, start.y, start.z + (Math.random() - 0.5) * 6, 'raid');
      b.wait = i * 0.6;
      F.goTo(b, line.id);
      b.path.push(...F.route(line.id, target.id));
      // Through the line, on into the Hall.
      const hall = P.nodes.find((q) => q.name === 'hall');
      if (hall) b.path.push(...F.route(target.id, hall.id));
    }
    this.raidT = 0;
    this.g.audio.play('murk_growl', start.x, start.y, start.z, 1, 0.6, 30, this.g.renderer.camera.position);
    if (this.where !== 'none') this.g.powerHud.toast('The Murk are storming out of the Warrens — the Lumen are holding their trenches', 'deny', 7000);
  }

  private raidTick(dt: number): void {
    const w = this.war, F = this.F!, P = this.plan!;
    if (!w.raid) return;
    this.raidT += dt;
    const raiders = F.blobs.filter((b) => b.area === 'raid' && b.mode !== 'dead');
    const guards = F.blobs.filter((b) => (b.area === 'front' || b.area === 'trench') && (b.role === 'guard' || b.role === 'sentry') && b.mode !== 'dead');
    // Through: raiders behind the trench, on the floor of the Throat.
    const T = P.trench;
    const through = raiders.filter((b) => (b.x - T.x) * T.ax + (b.z - T.z) * T.az < T.s - 5).length;
    const done = raiders.length === 0 || through >= 2 || this.raidT > 200 || !this.live;
    if (!done) return;
    const murkWon = through >= 2 || (raiders.length > 0 && guards.length === 0) || (this.raidT > 200 && raiders.length > guards.length);
    const withPlayer = this.nearTrench(80);
    endRaid(w, murkWon, this.warRnd(this.realm, this.g.sky.hoursAbs + 0.5));
    if (!murkWon && withPlayer && this.raidT < 200) this.trust.add(8, 'helped the Lumen hold their trenches');
    this.g.powerHud.toast(murkWon ? 'The Murk broke through the Lumen\'s trenches' : 'The Murk fall back into the Warrens', murkWon ? 'deny' : 'karma', 5000);
    if (!murkWon) for (const b of raiders) { b.path = []; F.goTo(b, F.nodeNear(P.places.warrens.x, P.places.warrens.y, P.places.warrens.z, 'warrens')); b.area = 'retreat'; b.ttl = 60; }
    this.respawnFront();
    this.g.saves?.notable();
  }

  /** The trench's, the Front's and the Hall's populations follow the line. */
  private respawnFront(): void {
    this.F?.despawn('trench');
    this.F?.despawn('front');
    this.F?.despawn('hall');
    this.F?.despawn('push');
  }

  private killed(b: Blob, byPlayer: boolean): void {
    const g = this.g;
    if (b.fac === 'murk') {
      // The trench war's endless pushes leave the war as it is (only the player's kills count).
      if (b.area === 'push' && !byPlayer) return;
      if (b.area === 'raid') raiderDown(this.war, byPlayer); else murkDown(this.war, byPlayer);
      if (b.role === 'maw') {
        mawDown(this.war);
        if (byPlayer) {
          this.trust.add(25, 'brought down the Maw');
          g.crime.reward({ karma: 60, why: 'The Maw is down', stopped: true });
        }
        g.powerHud.toast('The Maw collapses — the Heart dims, and the Murk scatter', 'core', 9000);
        g.audio.play('maw_roar', b.x, b.y, b.z, 1, 0.5, 30, g.renderer.camera.position);
        g.saves?.notable();
        for (const o of this.F!.blobs) if (o.fac === 'murk' && o.area === 'heart' && o !== b) { o.mode = 'flee'; o.tx = o.x + (o.x - b.x) * 3; o.tz = o.z + (o.z - b.z) * 3; o.ttl = 20; }
        return;
      }
      if (byPlayer) {
        // The Lumen see it: a little trust when it happens in their sight.
        const near = this.F!.nearest(b, 'lumen', 25);
        if (near || b.surface) this.trust.add(b.role === 'brute' ? 2 : 0.6, 'fought the Murk');
        if (b.surface) g.crime.reward({ karma: b.role === 'brute' ? 8 : 3, why: 'Stopped a creature from below', rep: b.role === 'brute' ? 0.5 : 0, news: 'creature from below' });
      }
    } else if (byPlayer) {
      this.trust.add(-8, 'killed one of them');
    }
  }

  private lumenHurt(_b: Blob | null, byPlayer: boolean): void {
    if (!byPlayer) return;
    if (this.hurtT > 0) return;
    this.hurtT = 4;
    this.trust.add(-6, 'hurt one of them');
    // They all hide for a while.
    if (this.F) for (const o of this.F.blobs) if (o.fac === 'lumen' && o.role !== 'guard' && o.role !== 'captive' && o.role !== 'support' && Math.hypot(o.x - this.g.player.pos.x, o.z - this.g.player.pos.z) < 40) {
      if (o.den) { o.mode = 'hide'; o.tx = o.den.x; o.tz = o.den.z; o.wait = 120; }
    }
  }

  /** Something violent near Lumen (powers, blasts, stomps): those in reach are hurt; area effects too. */
  private stimulus(s: Stimulus): void {
    if (!this.F || s.cause !== 'player') return;
    const reach = s.kind === 'impact' ? 0 : s.kind === 'power' || s.kind === 'blast' || s.kind === 'stomp' ? Math.min(6, s.radius * 0.2 + 1) : 0;
    if (reach <= 0) return;
    for (const b of this.F.blobs) {
      if (b.fac !== 'lumen' || b.mode === 'dead' || b.mode === 'hidden' || b.role === 'support') continue;
      if (Math.hypot(b.x - s.x, b.y - s.y, b.z - s.z) < reach + b.r) this.F.hurt(b, 1.5, true, s.x, s.z);
    }
  }

  /** The player within `r` m (and on its level) of the trench line. */
  private nearTrench(r: number): boolean {
    const t = this.plan?.places.trench, p = this.g.player.pos;
    return !!t && this.where !== 'none' && Math.hypot(p.x - t.x, p.z - t.z) < r && Math.abs(p.y - t.y) < 25;
  }

  // ------------------------------------------------------------------ areas

  private areas(): void {
    const F = this.F!, P = this.plan!, p = this.g.player.pos;
    const list: [string, { x: number; y: number; z: number; r: number } | undefined][] = [
      ['hall', P.places.hall && { ...P.places.hall, r: 60 }], ['gardens', P.places.gardens], ['lake', P.places.lake], ['archive', P.places.archive],
      ['front', P.places.front && { ...P.places.front, r: 30 }], ['trench', P.places.trench && { ...P.places.trench, r: 30 }], ['lookout', P.places.lookout], ['warrens', P.places.warrens && { ...P.places.warrens, r: 55 }],
      ['heart', P.places.heart && { ...P.places.heart, r: 25 }],
      ...P.roads.map((r): [string, { x: number; y: number; z: number; r: number }] => [`road${r.colony}`, { x: r.pts[3], y: r.pts[4], z: r.pts[5], r: 20 }]),
    ];
    for (const [name, at] of list) {
      if (!at) continue;
      const d = Math.hypot(at.x - p.x, at.z - p.z) - at.r;
      const dy = Math.abs(at.y - p.y);
      if (!F.areas.has(name) && d < SPAWN && dy < 70) { this.populate(name); F.areas.set(name, this.g.sky.hoursAbs); }
      else if (F.areas.has(name) && (d > DROP || dy > 100)) F.despawn(name);
    }
  }

  private populate(area: string): void {
    const F = this.F!, P = this.plan!, w = this.war;
    const rnd = Math.random;
    const at = (name: string) => P.places[name];
    const around = (c: { x: number; y: number; z: number }, r: number) => {
      for (let k = 0; k < 8; k++) {
        const a = rnd() * 6.28, d = Math.sqrt(rnd()) * r, x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
        const y = this.field!.floorAt(x, c.y + 3, z, 8);
        if (y !== null) return { x, y, z };
      }
      return { x: c.x, y: c.y, z: c.z };
    };
    const lumen = (role: Role, c: { x: number; y: number; z: number }, r: number, den: { x: number; y: number; z: number } | null = null) => {
      const q = around(c, r);
      const b = F.spawn('lumen', role, q.x, q.y, q.z, area);
      b.den = den;
      return b;
    };
    const murk = (role: Role, c: { x: number; y: number; z: number }, r: number) => {
      const q = around(c, r);
      const b = F.spawn('murk', role, q.x, q.y, q.z, area);
      b.den = { ...c };
      return b;
    };
    const held = w.front >= 0.95;
    switch (area) {
      case 'hall': {
        const n = held ? 12 : 44;
        P.dwellings.forEach((d, i) => {
          if (i >= n) return;
          const door = { x: d.x + Math.sin(d.yaw) * (d.r * 0.85), y: d.y, z: d.z + Math.cos(d.yaw) * (d.r * 0.85) };
          const b = lumen('dweller', { x: d.x + Math.sin(d.yaw) * (d.r + 1.5), y: d.y, z: d.z + Math.cos(d.yaw) * (d.r + 1.5) }, 2, door);
          if (held) { b.mode = 'hidden'; b.x = door.x; b.z = door.z; b.wait = 1e9; }
        });
        if (held) { for (let i = 0; i < 10; i++) murk(i % 4 === 0 ? 'raider' : 'drone', at('hall'), 30); break; }
        const c = at('council');
        if (c) for (let i = 0; i < 9; i++) { const b = lumen('council', c, 3); b.seat = i; }
        const nu = at('nursery');
        if (nu) for (let i = 0; i < 8; i++) lumen('child', nu, 4);
        for (let i = 0; i < 6; i++) lumen('carrier', at('hall'), 25);
        break;
      }
      case 'gardens': for (let i = 0; i < 12; i++) lumen('tender', at('gardens'), 18); break;
      case 'lake': for (let i = 0; i < 6; i++) lumen('tender', at('lake'), 12); break;
      case 'archive': for (let i = 0; i < 3; i++) lumen('carrier', at('archive'), 4); break;
      case 'lookout': lumen('guard', at('lookout'), 1, { ...at('lookout') }); break;
      case 'front': {
        // The Lumen's rear guard in the gallery; once the Murk hold the Throat they come up to the lip too.
        const post = { ...at('front') };
        const n = w.front < 0.5 ? 3 : Math.max(2, Math.round(11 * w.lumen * (1 - w.front)));
        for (let i = 0; i < n; i++) lumen('guard', post, 5, { ...post });
        if (w.front >= 0.5 && at('lip')) for (let i = 0; i < 5; i++) murk('raider', at('lip'), 4);
        break;
      }
      case 'trench': {
        const T = P.trench;
        if (w.front < 0.5) {
          // The Lumen hold their trench: sentries in the bays and at the gaps.
          const spots = [...T.gapPosts, ...T.posts.slice().sort(() => rnd() - 0.5).slice(0, TrenchWar.sentries(P, w.lumen, w.front))];
          for (const q of spots) { const b = F.spawn('lumen', 'sentry', q.x, q.y, q.z, area); b.den = { ...q }; b.wait = rnd() * 2; }
        } else {
          // The Murk have taken it: they sit in the Lumen's trench.
          for (const q of T.posts.slice(0, 6)) { const b = F.spawn('murk', 'raider', q.x, q.y, q.z, area); b.den = { ...q }; }
        }
        break;
      }
      case 'warrens': {
        const n = Math.round(10 + w.murk * 14) - (w.mawBack > w.at ? 6 : 0);
        for (let i = 0; i < n; i++) murk('drone', at('warrens'), 45);
        for (let i = 0; i < Math.round(1 + w.murk * 3); i++) murk('brute', at('warrens'), 30);
        P.pens.forEach((pen, i) => {
          murk('jailer', pen, 4);
          for (let k = 0; k < (w.captives[i] ?? 0); k++) { const b = lumen('captive', pen, 1.2, { ...pen }); b.wait = rnd() * 3; }
        });
        break;
      }
      case 'heart': {
        if (w.mawBack > w.at) { for (let i = 0; i < 3; i++) murk('drone', at('heart'), 12); break; }
        const H = P.heart;
        murk('maw', { x: H.x + 6, y: at('heart').y, z: H.z }, 3);
        for (let i = 0; i < 6; i++) murk('drone', at('heart'), 14);
        break;
      }
      default: {
        const m = /^road(\d+)$/.exec(area);
        if (!m) break;
        const r = P.roads.find((q) => q.colony === Number(m[1]));
        if (!r) break;
        for (let i = 0; i < 3; i++) {
          const j = Math.floor(rnd() * (r.pts.length / 3 - 4)) + 3;
          const b = lumen('caravan', { x: r.pts[j * 3], y: r.pts[j * 3 + 1], z: r.pts[j * 3 + 2] }, 1);
          b.wait = rnd() * 5;
        }
      }
    }
  }

  // ------------------------------------------------------------------ the lift, the Heart, pebbles

  /** The Lumen lift in the Throat: rising motes carry a friend up (Ctrl / C: down). */
  private lift(dt: number): void {
    const L = this.plan!.lift, P = this.g.player, p = P.pos;
    if (this.trust.value < TRUST.welcome || P.flying) return;
    if (Math.hypot(p.x - L.x, p.z - L.z) > L.r || p.y < L.y0 - 1 || p.y > L.y1 + 0.5) return;
    const down = this.g.input.down('ControlLeft') || this.g.input.down('KeyC');
    const want = down ? -4.5 : p.y < L.y1 - 0.3 ? 5.5 : 0;
    P.vel.y += (want - P.vel.y) * Math.min(1, dt * 3);
    P.vel.y += 9.81 * dt;
    // At the top, a nudge towards the lip.
    if (p.y > L.y1 - 1 && !down) {
      const lip = this.plan!.places.lip;
      const dx = lip.x - p.x, dz = lip.z - p.z, d = Math.hypot(dx, dz) || 1;
      P.vel.x += (dx / d) * dt * 6; P.vel.z += (dz / d) * dt * 6;
    }
    P.grounded = false;
  }

  private heart(dt: number): void {
    const H = this.plan!.heart, p = this.g.player.pos;
    const d = Math.hypot(H.x - p.x, H.y + 2 - p.y, H.z - p.z);
    const dim = this.war.mawBack > this.war.at;
    if (d < 60 && this.where === 'deep') {
      this.heartLoop ??= this.g.audio.loop('heart_pulse', 8);
      this.heartLoop?.set(H.x, H.y + 2, H.z, (dim ? 0.4 : 1) * Math.max(0, 1 - d / 60));
      if (d < 14) {
        // The player's shard answers: a slow pulse through the body.
        const beat = Math.sin(this.g.sky.hoursAbs * 3600 * 0.9);
        if (beat > 0.97) this.g.camRig.addShake(dim ? 0.03 : 0.08);
        if (this.trust.mark('heart')) {
          this.g.audio.chime('core', 0.6);
          this.trust.add(3, 'saw the Heart');
        }
      }
    } else this.heartLoop?.set(p.x, p.y, p.z, 0);
    void dt;
  }

  /** Friends get glow pebbles now and then in the Glow: energy. */
  private pebbles(dt: number): void {
    const g = this.g, p = g.player.pos;
    if (this.pebble) {
      const b = this.pebble;
      b.t += dt;
      b.mesh.position.y = b.y + 0.08 + Math.sin(b.t * 3) * 0.03;
      (b.mesh.material as THREE.MeshBasicMaterial).color.setScalar(1.2 + 0.4 * Math.sin(b.t * 4));
      if (Math.hypot(b.x - p.x, b.z - p.z) < 0.7 && Math.abs(b.y - p.y) < 1.5) {
        g.abilities.energy = g.abilities.maxEnergy;
        g.audio.chime('core', 0.5);
        g.powerHud.toast('A glow pebble — your energy is full', 'core', 3500);
        this.drop();
      } else if (b.t > 90) this.drop();
      return;
    }
    if (this.where !== 'glow' || this.trust.value < TRUST.welcome) return;
    this.pebbleT -= dt;
    if (this.pebbleT > 0) return;
    this.pebbleT = 200 + Math.random() * 120;
    // A Lumen near brings it.
    const b = this.F!.nearest(p, 'lumen', 14);
    if (!b) { this.pebbleT = 20; return; }
    const y = this.field!.floorAt(b.x, b.y + 1, b.z, 3) ?? b.y;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), new THREE.MeshBasicMaterial({ color: 0xfff2c0 }));
    mesh.position.set(b.x, y + 0.08, b.z);
    g.underground.group.add(mesh);
    this.pebble = { mesh, x: b.x, y, z: b.z, t: 0 };
    g.audio.play('slime_gift', b.x, y, b.z, 0.7, 1, 4, g.renderer.camera.position);
  }

  private drop(): void {
    if (!this.pebble) return;
    this.pebble.mesh.removeFromParent();
    this.pebble.mesh.geometry.dispose();
    this.pebble = null;
  }

  private ambience(): void {
    const g = this.g, cam = g.renderer.camera.position;
    const glow = this.where === 'glow' || this.where === 'front' || this.where === 'road' ? 1 : 0, murk = this.where === 'deep' ? 1 : 0;
    this.ambGlow ??= g.audio.loop('deep_glow', 50);
    this.ambMurk ??= g.audio.loop('deep_murk', 50);
    this.ambGlow?.set(cam.x, cam.y, cam.z, glow * (this.where === 'road' ? 0.5 : 0.85));
    this.ambMurk?.set(cam.x, cam.y, cam.z, murk * 0.9);
    // The noise of the fight at the trenches.
    const fr = this.plan!.places.noMans ?? this.plan!.places.trench;
    const fight = fr ? (this.war.raid ? 1 : this.trenchOn ? 0.45 : 0) : 0;
    this.battleLoop ??= g.audio.loop('slime_battle', 10);
    this.battleLoop?.set(fr?.x ?? cam.x, (fr?.y ?? cam.y) + 1, fr?.z ?? cam.z, fight * 0.8);
  }

  // ------------------------------------------------------------------ E: pens

  /** What E would do here (null: nothing of ours). */
  hint(): string | null {
    const pen = this.penNear();
    if (pen >= 0) return 'Press <b>E</b> to tear the pen open';
    return null;
  }

  use(): boolean {
    const pen = this.penNear();
    if (pen < 0) return false;
    const P = this.plan!, F = this.F!, pp = P.pens[pen];
    const n = freePen(this.war, pen);
    this.g.audio.play('membrane', pp.x, pp.y + 1, pp.z, 1, 0.7, 6, this.g.renderer.camera.position);
    this.g.camRig.addShake(0.2);
    // The captives go home: up the Throat to the Hall.
    const hall = P.nodes.find((q) => q.name === 'hall');
    for (const b of F.blobs) {
      if (b.role !== 'captive' || !b.den || Math.hypot(b.den.x - pp.x, b.den.z - pp.z) > 0.5) continue;
      b.mode = 'free';
      if (hall) { b.path = F.route(F.nodeNear(b.x, b.y, b.z), hall.id); b.mode = 'free'; const nx = b.path.shift(); if (nx !== undefined) { b.tx = P.nodes[nx].x; b.tz = P.nodes[nx].z; } }
      b.area = 'freed';
      b.ttl = 240;
    }
    // The jailers come for the player.
    for (const b of F.blobs) if (b.role === 'jailer' && Math.hypot(b.x - pp.x, b.z - pp.z) < 20) { b.mode = 'fight'; b.foe = null; }
    this.trust.add(3 + n, 'freed their captives');
    this.g.progress.addKarma(5 + n * 2, 'Freed the captive Lumen');
    this.g.saves?.notable();
    return true;
  }

  private penNear(): number {
    const P = this.plan, p = this.g.player.pos;
    if (!P || this.where !== 'deep') return -1;
    return P.pens.findIndex((q, i) => (this.war.captives[i] ?? 0) > 0 && Math.hypot(q.x - p.x, q.z - p.z) < q.r + 1.4 && Math.abs(q.y - p.y) < 2.5);
  }

  // ------------------------------------------------------------------ the slime call

  /** Use the Slime call at rank r: true when the Lumen came. */
  private call(r: number): boolean {
    const g = this.g, p = g.player.pos;
    const F = this.F;
    if (!F) { g.abilities.hooks.deny?.('No Lumen live under this city'); return false; }
    const inCaves = this.where !== 'none';
    const inSewer = g.underground.inSewer(p.x, p.y + 0.5, p.z);
    let from: { x: number; y: number; z: number } | null = null;
    if (inCaves || inSewer) from = { x: p.x + (Math.random() - 0.5) * 3, y: p.y, z: p.z + (Math.random() - 0.5) * 3 };
    else {
      const m = g.underground.nearestManhole(p.x, p.z, SLIME_REACH[r]);
      if (m) from = { x: m.x, y: g.world.groundHeight(m.x, m.z), z: m.z };
    }
    if (!from) { g.abilities.hooks.deny?.(`No manhole within ${SLIME_REACH[r]} m — the Lumen come up through the sewers`); return false; }
    // Where they go: the target, or what is in front of the player.
    const t = g.targeting.current;
    let tx = 0, ty = 0, tz = 0, kind: 'hold' | 'douse' | 'fight' = 'hold', obj: object | null = null, foe: Blob | null = null;
    if (t) {
      const c = g.targeting.centre(t, _v);
      tx = c.x; ty = c.y; tz = c.z; obj = t.obj;
      if (t.kind === 'threat' && t.obj instanceof MurkActor) { kind = 'fight'; foe = t.obj.b; }
    } else {
      const cam = g.renderer.camera, d = new THREE.Vector3();
      cam.getWorldDirection(d);
      const h = g.targeting.probe(cam.position.x, cam.position.y, cam.position.z, d.x, d.y, d.z, 60);
      tx = h.x; ty = h.y; tz = h.z; kind = 'douse';
    }
    const n = SLIME_COUNT[r], life = SLIME_TIME[r];
    const surface = !inCaves;
    const home = { ...from };
    for (let i = 0; i < n; i++) {
      const b = F.spawn('lumen', 'support', from.x, from.y, from.z, 'support', surface);
      b.vy = surface ? 3 + Math.random() * 3 : 0;
      b.y = from.y + (surface ? 0.1 : 0);
      b.wait = 0;
      b.ttl = life + 12;
      const a = (i / n) * Math.PI * 2;
      b.task = { kind, x: tx + Math.cos(a) * 0.9, y: ty, z: tz + Math.sin(a) * 0.9, obj, home };
      if (foe) b.foe = foe;
      b.mode = 'move';
    }
    this.calls.push({ t: 0, life, rank: r, obj, kind, from: home, x: tx, y: ty, z: tz });
    g.audio.play('slime_call', from.x, from.y, from.z, 1, 1, 8, g.renderer.camera.position);
    if (surface && !inSewer) g.audio.play('metal_bend', from.x, from.y, from.z, 0.6, 1.5, 8, g.renderer.camera.position);
    g.dust.burst(from.x, from.y + 0.3, from.z, 16, 0.3, 2.5, 0.5, 1, new THREE.Color(0.2, 1.4, 1.0), 0, 0.6);
    return true;
  }

  private calls: { t: number; life: number; rank: number; obj: object | null; kind: string; from: { x: number; y: number; z: number }; x: number; y: number; z: number }[] = [];

  /** Called slime work: holding the target down while they are on it; going home when the time is up. */
  callTick(dt: number): void {
    const F = this.F;
    if (!F) return;
    for (let i = this.calls.length - 1; i >= 0; i--) {
      const c = this.calls[i];
      c.t += dt;
      const crew = F.blobs.filter((b) => b.role === 'support' && b.task?.home === c.from && b.mode !== 'dead');
      const onIt = crew.filter((b) => Math.hypot(b.x - c.x, b.z - c.z) < 2.5).length;
      if (c.obj && onIt >= 2 && c.kind === 'hold') {
        // The target follows its body (people, cars, machines move).
        const t = this.g.targeting.current;
        if (t && t.obj === c.obj) { const p = this.g.targeting.centre(t, _v); c.x = p.x; c.y = p.y; c.z = p.z; for (const b of crew) if (b.task) { b.task.x = p.x + Math.cos(b.ph) * 0.8; b.task.z = p.z + Math.sin(b.ph) * 0.8; } }
        const st = statusFor(c.obj);
        st.stunned = Math.max(st.stunned, Math.min(SLIME_HOLD[c.rank], 1.5));
        // A monster: they gnaw at it (a little damage, a lot of distraction).
        const actor = c.obj as Partial<ThreatActor>;
        if (typeof actor.damage === 'function' && typeof actor.zones !== 'undefined') actor.damage(null, dt * POWER_HIT.lumenCreature * onIt, { cause: 'player', key: 'lumen', aggro: dt * 20 });
      }
      if (c.kind === 'douse' && onIt >= 2) this.g.threats?.fires.douse(c.x, c.y, c.z, 4, dt * 2);
      if (c.t > Math.min(c.life, c.kind === 'hold' ? SLIME_HOLD[c.rank] + 4 : c.life)) {
        for (const b of crew) if (b.task) { b.task.kind = 'return'; b.foe = null; }
        this.calls.splice(i, 1);
      }
    }
  }

  // ------------------------------------------------------------------ breaking out

  /** The war's breakout: a threat event at a manhole near the hub colony (or near the player). */
  private startBreach(realm = this.realm): void {
    if (this.breach || !this.g.threats) return;
    const P = this.g.underground.deeps[realm]?.plan ?? this.plan!, c = this.g.underground.rooms.colonies[P.hub];
    const p = this.g.player.pos;
    const near = c ? { x: c.chamber.cx, z: c.chamber.cz } : { x: p.x, z: p.z };
    const at = Math.hypot(p.x - near.x, p.z - near.z) < 600 ? p : near;
    this.g.threats.start('murk', (Math.random() * 2 ** 32) >>> 0, {}, { x: at.x, z: at.z });
  }

  /** The threat director's 'murk' archetype: the breakout itself. */
  breachEvent(site: { x: number; z: number }): MurkBreach | null {
    if (!this.F) return null;
    const m = this.g.underground.nearestManhole(site.x, site.z, 200) ?? this.g.underground.nearestManhole(site.x, site.z, 600);
    if (!m) return null;
    this.breach = new MurkBreach(this.g, this.F, { x: m.x, z: m.z }, Math.round(5 + this.war.murk * 6));
    this.g.powerHud.toast('Something is coming up out of the sewers', 'deny', 6000);
    return this.breach;
  }

  // ------------------------------------------------------------------ trust

  private trustChanged(d: number, v: number, reason: string, up: TrustTier | null): void {
    const g = this.g;
    if (g.mode === 'sandbox') return;
    if (Math.abs(d) >= 2) g.powerHud.toast(`${d > 0 ? 'The Lumen trust you more' : 'The Lumen trust you less'} — you ${reason}`, d > 0 ? 'karma' : 'deny', 4500);
    if (up) {
      const msg: Partial<Record<TrustTier, string>> = {
        Noticed: 'The Lumen have <b>noticed</b> you — they no longer hide from you',
        Welcome: 'You are <b>welcome</b> among the Lumen',
        Ally: 'The Lumen count you an <b>ally</b>',
        Kin: 'The Lumen see you as <b>kin</b>',
      };
      if (msg[up]) { g.powerHud.toast(msg[up]!, 'core', 7000); g.audio.chime('core', 0.6); }
    }
    g.saves?.notable();
    void v;
  }

  /** The powers screen's line: trust now and what the next rank needs. */
  trustLine(): string {
    const v = this.trust.value;
    const next = v < TRUST.ally ? TRUST.ally : v < TRUST.kin ? TRUST.kin : v < 100 ? 100 : null;
    return `trust: <b>${tierOf(v)}</b> (${Math.round(v)})${next !== null ? `, next rank at ${next}${next === 100 ? ' after the Maw falls' : ''}` : ''}`;
  }

  // ------------------------------------------------------------------ saves

  saveState(): SaveSlimes {
    const copy = (w: WarState) => JSON.parse(JSON.stringify({ ...w, raid: null })) as WarState;
    const wars: Record<string, WarState> = {};
    this.g.underground.deeps.forEach((d, i) => { if (this.wars[i]) wars[d.plan.hub] = copy(this.wars[i]); });
    return { trust: this.trust.serialize(), war: copy(this.wars[0]), wars };
  }

  restore(o: SaveSlimes | null): void {
    if (!o) return;
    this.trust.restore(o.trust);
    const now = this.g.sky.hoursAbs, realms = this.g.underground.deeps;
    for (let i = 0; i < this.wars.length; i++) {
      const D = realms[i];
      const w = parseWar(o.wars && D ? o.wars[D.plan.hub] ?? (i === 0 ? o.war : null) : i === 0 ? o.war : null, D?.plan.pens.length ?? 0, now);
      if (w) { if (Math.abs(w.at - now) > 24 * 10) w.at = now; this.wars[i] = w; }
    }
    if (this.F) for (const a of [...this.F.areas.keys()]) this.F.despawn(a);
    this.saveLocal();
  }

  private saveLocal(): void {
    try { this.wars.forEach((w, i) => localStorage.setItem(this.keyOf(i), JSON.stringify({ ...w, raid: null }))); } catch { /* storage unavailable */ }
  }

  /** For the dev console and tests. */
  debug(): Record<string, unknown> {
    const w = this.war;
    return {
      trust: this.trust.value, tier: this.trust.tier, where: this.where, front: +w.front.toFixed(2), murk: +w.murk.toFixed(2), lumen: +w.lumen.toFixed(2),
      raid: w.raid, nextRaid: +(w.nextRaid - w.at).toFixed(1), mawDown: w.mawBack > w.at, captives: w.captives, stats: w.stats,
      agents: this.F ? { ...this.F.stats, areas: [...this.F.areas.keys()] } : null, rank: this.g.progress.rank('slimeCall'), trench: this.trenches?.stats,
    };
  }

  /** Dev: a raid now (live if near the Front or the trench). */
  devRaid(): void { this.war.nextRaid = this.war.at; this.warT = 0; }
  devBreach(): void { this.war.front = 1; this.war.murk = 1; this.war.nextBreach = this.war.at; this.startBreach(); }
}

const _v = new THREE.Vector3();
