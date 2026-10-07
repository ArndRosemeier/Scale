/**
 * The sidekick (docs/SIDEKICK_PLAN.md), phase 1: the second shard and the person who takes it.
 *
 *  - The shard turns up the first time reputation reaches SHARD.unlockRep (Sandbox: soon after the
 *    start): a park or a square some way off (shardRules). The news has it (CityNews: billboards,
 *    gossip), a toast says so and the map draws a circle round where it was found.
 *  - The pull: within SHARD.pullR the hero feels it — its hum (the origin scene's), a soft glow at
 *    the screen's edge on its side, a mark on the compass. It lies in a glow of its own, motes rising.
 *  - Sometimes (SHARD.gangChance, where a group holds the street) the group got to it first: two or
 *    three of them stand guard round it (CrimeSystem.postGuards, like a hideout door). It can only
 *    be taken once they are dealt with.
 *  - E (or walking into it) takes it. Carried (a badge on screen), it can be offered to anyone in a conversation (the
 *    talk menu's "Offer them the shard"): shardRules.offerAnswer decides what they say. Someone
 *    with a matter of their own asks a favour first (People.askVisit) and says yes once it is done.
 *  - The awakening: the shard floats from the hero's hand to them, its light spirals into them, a
 *    flash; they say three things in their own temperament (in the talk panel, or as bubbles once
 *    the talk has ended). From then on they are the sidekick: kept in People for good, a gold dot.
 *  - Reputation below 0 breaks the bond (they leave); at SHARD.unlockRep again, talking to them can
 *    win them back.
 *
 * Saved per city in the browser and in save games. The sidekick's own life (being around, joining
 * fights, powers, karma) is the plan's phase 2 and later.
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';
import { makeActor, release, play, SIDEKICK_OWNER, PEOPLE_OWNER, STREET_OWNER, type Actor } from '../../sim/actors/Actor';
import { planCell } from '../../plan/cell';
import type { MapMarker } from '../../ui/map/GameMap';
import type { HideoutGuard } from '../crime/HideoutGuard';
import { StarFx } from '../intro/StarFx';
import { IntroSound } from '../intro/IntroSound';
import { addNote } from '../people/memory';
import { yearsOf } from '../people/identity';
import { gameTimeLabel } from '../save/model';
import { deriveSeed, hashToFloat } from '../../core/rng';
import { Companion, type MateSave } from './Companion';
import { MATE, MATE_POWERS, graveSpot } from './companionRules';
import { makeGrave } from './Grave';
import {
  SHARD, shardCells, resolveShard, sceptic, hasMatter, offerAnswer, accepts, answerLine, awakeningLines,
  type ShardSite, type OfferAnswer,
} from './shardRules';

export type ShardPhase = 'locked' | 'reported' | 'carried' | 'bonded' | 'parted';

/** What a save keeps (sanitised by `restore`). */
export interface SavedSidekick {
  v: 1;
  phase: ShardPhase;
  /** Shards reported so far (the next one's seed). */
  n: number;
  site: ShardSite | null;
  /** The group guarding it (-1: nobody), and whether they have been dealt with. */
  gang: number;
  cleared: boolean;
  /** The sidekick (citizen id; -1: none) and their name. */
  who: number;
  name: string;
  /** People who asked a favour before taking it: citizen id, their favours done and let down at the time. */
  matters: [number, number, number][];
  /** The sidekick's health, times taken to the ward, seconds still in it (phase 2; absent in older saves). */
  mate?: MateSave | null;
  /** Fallen sidekicks: their graves, who they were (never seen in the streets again), the next shard's game hour. */
  graves?: SavedGrave[];
  dead?: number[];
  nextAt?: number;
  /** A grave still to be placed (the name; '' none). */
  graveFor?: string;
}

export interface SavedGrave { name: string; x: number; y: number; z: number; yaw: number }

/** The awakening, in seconds: the shard floats over, its light pours in, the flash, the three lines, the end. */
const SCENE = { float: 0.9, flash: 4.2, gone: 4.6, line1: 1.3, line2: 5.2, line3: 7.8, end: 10.5 } as const;

interface Scene {
  a: PedAgent;
  name: string;
  t: number;
  lines: [string, string, string];
  said: number;
  /** Our actor holding them still once the talk has ended (null: the talk's own, or seated). */
  own: Actor | null;
  bonded: boolean;
  flashed: boolean;
}

const STORE = (g: Game) => `scale.sidekick.v1.${g.mode}.${g.settings.seed}.${g.settings.size.toFixed(2)}`;
const SHARD_COLOR = '#9fd0ff';

export class Sidekick {
  phase: ShardPhase = 'locked';
  private n = 0;
  site: ShardSite | null = null;
  private gang = -1;
  private cleared = false;
  private who = -1;
  private name = '';
  private matters = new Map<number, { favours: number; letDown: number }>();
  /** Candidate cells still to try for the next shard (one a frame: a cell plan may take a moment). */
  private search: number[] | null = null;
  private retryT = 0;
  private time = 0;
  private checkT = 0;
  private refined = false;
  private guards: HideoutGuard | null = null;
  private fx: StarFx;
  /** A faint column of light over the shard while the hero feels its pull. */
  private beam: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  private sound: IntroSound;
  private scene: Scene | null = null;
  private markKey = '';
  private edge: HTMLDivElement;
  private badge: HTMLDivElement;
  private camDir = new THREE.Vector3();
  private v = new THREE.Vector3();
  private w = new THREE.Vector3();
  /** The gang's line was said (once per approach). */
  private warned = false;
  /** Seconds the effects stay drawn after the shard went (its light pouring into the hero). */
  private fxHold = 0;
  stats = { reported: 0, taken: 0, offers: 0, refused: 0, bonded: 0, parted: 0, died: 0 };
  /** The sidekick around the hero (phase 2). */
  readonly mate: Companion;
  private graves: SavedGrave[] = [];
  private graveMeshes: THREE.Object3D[] = [];
  private dead: number[] = [];
  /** No shard before this game hour (after a death). */
  private nextAt = 0;
  /** A grave to place (the name) and the cemetery cells still to try. */
  private graveFor = '';
  private graveSearch: number[] | null = null;

  constructor(private g: Game) {
    this.mate = new Companion(g, { died: () => this.died(), persist: () => this.persist() });
    this.fx = new StarFx();
    this.fx.group.name = 'shard';
    this.fx.group.visible = false;
    g.renderer.scene.add(this.fx.group);
    this.beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.18, 50, 12, 1, true).translate(0, 25, 0),
      // Plain blending in a pale tint and no fog: added light vanishes against a bright day sky.
      new THREE.MeshBasicMaterial({ color: new THREE.Color(SHARD_COLOR).lerp(new THREE.Color(0xffffff), 0.55), transparent: true, opacity: 0, depthWrite: false, fog: false, side: THREE.DoubleSide }),
    );
    this.beam.castShadow = this.beam.receiveShadow = false;
    this.beam.visible = false;
    this.fx.group.add(this.beam);
    this.sound = new IntroSound(g.audio);
    this.edge = document.createElement('div');
    this.edge.id = 'shard-pull';
    document.body.appendChild(this.edge);
    this.badge = document.createElement('div');
    this.badge.id = 'shard-badge';
    this.badge.innerHTML = '<i></i><span><b>You carry the second shard</b><br>Talk to someone (E) to offer it</span>';
    this.badge.title = 'You carry the second shard. Offer it to someone you trust: talk to them (E).';
    document.body.appendChild(this.badge);
    try { this.restore(JSON.parse(localStorage.getItem(STORE(g)) ?? 'null'), false); } catch { /* storage unavailable */ }
    g.people.extraOptions = (a) => this.options(a);
  }

  /** One of everything the shard draws (for the start-up warm-up). */
  static warmupObject(): THREE.Object3D { return new StarFx().warmObject(); }

  get sidekickId(): number { return this.phase === 'bonded' ? this.who : -1; }

  // ------------------------------------------------------------------ per frame

  update(dt: number): void {
    const g = this.g;
    this.time += dt;
    if (g.intro?.active) return;
    const rep = g.crime?.rep.value ?? 0;
    this.checkT -= dt;
    if (this.phase === 'locked' && !this.search && this.checkT <= 0) {
      this.checkT = 1;
      this.retryT -= 1;
      const ready = (g.mode === 'sandbox' ? this.time > SHARD.sandboxDelay : rep >= SHARD.unlockRep) && g.sky.hoursAbs >= this.nextAt;
      if (ready && this.retryT <= 0) this.startSearch();
    }
    if (this.search) this.searchStep();
    if (this.phase === 'reported') this.reported(dt);
    else this.quiet();
    if (this.phase === 'bonded' && rep < 0 && !this.scene) this.part();
    if (this.scene) this.stepScene(dt);
    else if (this.phase === 'bonded') {
      if (g.input.hit('KeyK') && !g.powers.open && !g.map.open && !g.menu.paused) this.mate.call();
      this.mate.update(dt);
    }
    if (this.graveFor && !this.graveSearch) this.startGraveSearch();
    if (this.graveSearch) this.graveStep();
    this.fxHold -= dt;
    this.fx.group.visible = !!this.scene || (this.phase === 'reported' && this.fx.shard.visible) || this.fxHold > 0;
    if (this.fx.group.visible) this.fx.update(dt, this.time, g.renderer.camera, g.renderer.gl);
    this.badge.classList.toggle('on', this.phase === 'carried' && !g.map.open);
    this.markers();
  }

  /** Pick where the next shard turns up (the candidates are tried a cell a frame). */
  private startSearch(): void {
    const p = this.g.player.pos;
    this.search = shardCells(this.g.macro, this.g.settings.seed, this.n, p.x, p.z).slice(0, 24);
  }

  private searchStep(): void {
    const g = this.g, list = this.search!;
    const cell = list.shift();
    if (cell === undefined) { this.search = null; this.retryT = 120; return; }
    const st = g.streamer.cells.get(cell);
    const plan = st && st.status === 'ready' && st.plan ? st.plan : planCell(g.macro, g.macro.cells[cell], g.terrain);
    const site = resolveShard(g.macro, cell, plan, g.terrain, g.settings.seed, this.n);
    if (!site) return;
    this.search = null;
    this.report(site);
  }

  /** The shard is found: the news, a toast, the circle on the map; a group may have got to it first. */
  report(site: ShardSite): void {
    const g = this.g;
    this.site = site;
    this.phase = 'reported';
    this.refined = false;
    this.cleared = false;
    this.warned = false;
    this.n++;
    this.stats.reported++;
    const F = g.crime?.factions;
    const holder = F ? F.holder[site.cell] ?? -1 : -1;
    this.gang = holder >= 0 && !g.crime.collapsed(holder) && hashToFloat(deriveSeed(site.seed, 'gang')) < SHARD.gangChance ? holder : -1;
    const hood = g.city ? g.city.report('shard', site.x, site.z) : 'the city';
    g.powerHud.toast(`<b>On the news:</b> a strange glowing stone was found ${site.kind === 'park' ? 'in a park' : 'on a square'} in <b>${hood}</b>. It looks like your shard. Its area is marked on your map`, 'core', 9000);
    g.audio.chime('core', 0.5);
    this.persist();
  }

  /** The shard lies there: drawn near, its pull, the gang round it. */
  private reported(dt: number): void {
    const g = this.g, s = this.site!, P = g.player, p = P.pos;
    const d = Math.hypot(s.x - p.x, s.z - p.z);
    // Walking into it takes it too (like a power core), unless a gang still guards it.
    if (d < 0.9 + P.radius && this.inReach() && !this.guarded()) { this.take(); return; }
    if (!this.refined && d < 220) {
      const y = g.collision.groundAt(s.x, s.z, s.y + 0.6, 1.2);
      if (Number.isFinite(y) && Math.abs(y - s.y) < 1.5) { s.y = y; this.refined = true; }
    }
    const show = d < SHARD.showR;
    this.fx.shard.visible = show;
    if (show) {
      const pulse = 0.85 + 0.15 * Math.sin(this.time * 2.3);
      this.fx.placeShard(s.x, s.y, s.z, s.seed % 6.28);
      this.fx.ground.scale.setScalar(1.3);
      this.fx.ground.position.y = s.y + 0.06;
      this.fx.shard.scale.setScalar(1);
      this.fx.shardU.uI.value = 1.15 * pulse;
      this.fx.groundU.uI.value = 0.3 * pulse;
      this.fx.ground.visible = true;
      this.fx.scorch.visible = false;
      this.fx.shardGlow.set(this.v.set(s.x, s.y + 0.35, s.z), 0.55 * pulse, 0.5);
      // The column of light: wider and taller with distance so it stays a few pixels wide and
      // over the roofs (a thin line is lost at 100 m), a little stronger in the pull.
      const kb = d < SHARD.pullR ? 1 - d / SHARD.pullR : 0;
      const w = Math.max(1, d / 40);
      this.beam.position.set(s.x, s.y, s.z);
      this.beam.scale.set(w, Math.max(1, d / 120), w);
      this.beam.material.opacity = (0.16 + 0.08 * kb) * pulse;
      this.beam.visible = true;
      if (d < 80 && Math.random() < dt * 6) this.fx.particles.mote(this.v.set(s.x + (Math.random() - 0.5) * 0.8, s.y + 0.1, s.z + (Math.random() - 0.5) * 0.8), 2.5, 0.06);
    } else this.beam.visible = false;
    this.watchGang(d);
    // The pull: the hum and the glow at the screen's edge, stronger closer.
    const k = d < SHARD.pullR ? 1 - d / SHARD.pullR : 0;
    this.sound.humLevel(k > 0 ? 0.04 + 0.4 * k * k : 0, 0.9 + 0.2 * k);
    this.edgeGlow(k, s.x, s.z, d);
  }

  /** Nothing to feel: hum off, edge clear. */
  private quiet(): void {
    if (this.edge.style.opacity !== '0') this.edge.style.opacity = '0';
    if (!this.scene) this.sound.humLevel(0);
  }

  /** The soft glow at the edge of the screen on the shard's side (fades when it is in plain view close by). */
  private edgeGlow(k: number, x: number, z: number, d: number): void {
    if (k <= 0 || this.g.map.open) { this.edge.style.opacity = '0'; return; }
    this.g.renderer.camera.getWorldDirection(this.camDir);
    const head = Math.atan2(this.camDir.x, -this.camDir.z);
    const p = this.g.player.pos;
    const rel = Math.atan2(x - p.x, -(z - p.z)) - head;
    const sx = Math.sin(rel), sy = -Math.cos(rel);
    const m = Math.max(Math.abs(sx), Math.abs(sy)) || 1;
    const ex = 50 + (sx / m) * 50, ey = 50 + (sy / m) * 50;
    // (Close by, it is in plain sight: no need to point.)
    const near = Math.min(1, Math.max(0, (d - 12) / 25));
    const a = (0.55 + 0.4 * k) * (0.85 + 0.15 * Math.sin(this.time * 2.4)) * near;
    this.edge.style.background = `radial-gradient(ellipse 34% 40% at ${ex.toFixed(1)}% ${ey.toFixed(1)}%, rgba(90, 170, 255, 0.95) 0%, rgba(70, 130, 255, 0.55) 35%, rgba(70, 130, 255, 0) 100%)`;
    this.edge.style.opacity = a.toFixed(3);
  }

  /** The group's guards round the shard: posted as the hero comes, stood down if they leave, cleared when beaten. */
  private watchGang(d: number): void {
    const g = this.g, s = this.site!;
    if (this.gang < 0 || this.cleared || !g.crime) return;
    if (g.crime.collapsed(this.gang)) { this.cleared = true; this.persist(); return; }
    const gd = this.guards;
    if (gd && !gd.active) {
      this.guards = null;
      // Fought and ended (beaten, run off, arrested): the stone is free.
      if (gd.committed) { this.clear(); return; }
    }
    if (gd && gd.active) {
      if (gd.committed && gd.guarding === 0) { this.clear(); return; }
      if (d > SHARD.leaveR && !gd.committed) { gd.standDown(); this.guards = null; this.warned = false; }
      if (gd.committed && !this.warned) {
        this.warned = true;
        const f = g.crime.factions.factions[this.gang];
        g.powerHud.toast(`<b>${f ? f.name : 'A gang'}</b> got to the stone first. Take it from them`, 'warn', 6000);
      }
      return;
    }
    if (d < SHARD.guardR && (d > SHARD.guardMin || !g.crime.visible(s.x, s.y + 1, s.z))) {
      const a = (s.seed % 628) / 100;
      this.guards = g.crime.postGuards({ x: s.x, z: s.z, nx: Math.cos(a), nz: Math.sin(a) }, this.gang);
    }
  }

  private clear(): void {
    this.cleared = true;
    this.guards = null;
    this.g.powerHud.toast('The gang is out of the way. <b>The stone is free</b>', 'info', 5000);
    this.persist();
  }

  /** Whether the guards still keep the hero off the stone. */
  private guarded(): boolean {
    return this.gang >= 0 && !this.cleared && !!this.guards?.active && this.guards.guarding > 0;
  }

  // ------------------------------------------------------------------ taking it

  private inReach(): boolean {
    const s = this.site, P = this.g.player;
    if (this.phase !== 'reported' || !s || P.height > 2.6) return false;
    return Math.hypot(s.x - P.pos.x, s.z - P.pos.z) < SHARD.takeR + P.radius && Math.abs(s.y - P.pos.y) < 2;
  }

  hint(): string | null {
    if (!this.inReach()) return null;
    return this.guarded() ? 'They won\'t let you near the stone. <b>Deal with them first</b>' : 'Press <b>E</b> to take the glowing stone';
  }

  /** E: take the shard. True when used. */
  use(): boolean {
    if (!this.inReach()) return false;
    if (this.guarded()) { this.g.powerHud.toast('They won\'t let you near the stone', 'deny'); return true; }
    this.take();
    return true;
  }

  /** The hero has the shard now (also dev). */
  take(): void {
    const g = this.g, s = this.site, P = g.player;
    this.phase = 'carried';
    this.stats.taken++;
    this.guards = null;
    if (s) {
      // Its light into the hero's hands, a soft chime.
      this.fx.particles.target.set(P.pos.x, P.pos.y + P.height * 0.55, P.pos.z);
      for (let i = 0; i < 40; i++) this.fx.particles.stream(this.v.set(s.x + (Math.random() - 0.5) * 0.3, s.y + 0.2 + Math.random() * 0.3, s.z + (Math.random() - 0.5) * 0.3), 0.8 + Math.random() * 0.6, 0.07, Math.random() * 6.28);
      this.fxHold = 1.6;
    }
    this.fx.shard.visible = false;
    this.fx.ground.visible = false;
    this.beam.visible = false;
    this.fx.shardGlow.set(this.v.set(0, -1e4, 0), 0);
    this.sound.stop(1.2);
    g.audio.chime('core', 0.7);
    g.powerHud.toast('You have the <b>second shard</b>. Give it to someone you trust: talk to them (<b>E</b>) and offer it', 'core', 9000);
    this.persist();
  }

  // ------------------------------------------------------------------ the offer

  /** What the talk menu offers for this person (the shard; or winning a parted sidekick back). */
  private options(a: PedAgent): { label: string; run: () => void }[] {
    if (this.scene) return [];
    if (this.phase === 'carried') return [{ label: 'Here, take this. (Offer them the shard)', run: () => this.offer() }];
    if (this.phase === 'parted' && a.cit.id === this.who && (this.g.crime?.rep.value ?? 0) >= SHARD.unlockRep) return [{ label: 'Will you stand with me again?', run: () => this.rejoin() }];
    return [];
  }

  private offer(): void {
    const g = this.g, P = g.people, info = P.talkInfo();
    if (!info || this.phase !== 'carried') return;
    this.stats.offers++;
    const cit = info.person.cit, k = info.known;
    const m = this.matters.get(cit.id);
    const fv = k.favour;
    const state: 'none' | 'open' | 'done' | 'lost' = !m ? 'none'
      : k.favours > m.favours ? 'done'
        : k.letDown > m.letDown ? 'lost'
          : fv && fv.done === undefined && !fv.lost ? 'open' : 'none';
    let ans: OfferAnswer = offerAnswer({
      child: info.child || info.person.years < 18, duty: onDuty(info.foreign), rep: g.crime?.rep.value ?? 0, opinion: info.opinion,
      sceptic: sceptic(cit, info.person.traits), matter: hasMatter(cit), matterState: state,
    });
    let who = fv?.whoName?.split(' ')[0] ?? 'my friend', word = fv?.word ?? 'friend';
    if (ans === 'matter') {
      const f = P.askVisit();
      if (f) {
        this.matters.set(cit.id, { favours: k.favours, letDown: k.letDown });
        who = f.whoName?.split(' ')[0] ?? who; word = f.word ?? word;
      } else ans = k.favour ? 'waiting' : 'yes';
    }
    // Let down: they ask again next time.
    if (ans === 'letdown') this.matters.delete(cit.id);
    const u = Math.random();
    const line = answerLine(ans, u, who, word);
    if (!accepts(ans)) {
      this.stats.refused++;
      P.speak(line);
      this.persist();
      return;
    }
    this.matters.delete(cit.id);
    P.speak(line, true);
    this.startScene(info.a, info.person.full, info.person.temper);
  }

  private rejoin(): void {
    const P = this.g.people, info = P.talkInfo();
    if (!info || this.phase !== 'parted' || info.a.cit.id !== this.who) return;
    if (info.opinion < SHARD.dislikeBelow) { P.speak(answerLine('dislike', Math.random())); return; }
    P.speak(['…All right. I missed this, if I\'m honest. I\'m back.', 'The city likes you again. So do I. I\'m in.', 'Fine. But don\'t make me regret it.'][Math.floor(Math.random() * 3)]);
    this.phase = 'bonded';
    P.setSidekick(this.who, true);
    this.g.powerHud.toast(`<b>${this.name}</b> is your sidekick again`, 'core', 6000);
    this.persist();
  }

  /** Reputation below 0: the sidekick leaves. */
  private part(): void {
    const g = this.g;
    this.phase = 'parted';
    this.stats.parted++;
    this.mate.dismiss();
    g.people.setSidekick(this.who, false);
    const k = g.people.find(this.who);
    if (k) addNote(k, g.sky.hoursAbs, `${gameTimeLabel(Math.floor(g.sky.hoursAbs / 24), g.sky.hoursAbs % 24)}: left the hero when the city turned against them`);
    g.powerHud.toast(`<b>${this.name}</b> has left you. They can't stand by a hero the city has turned against`, 'warn', 8000);
    this.persist();
  }

  // ------------------------------------------------------------------ the awakening

  private startScene(a: PedAgent, name: string, temper: Parameters<typeof awakeningLines>[0]): void {
    this.scene = { a, name, t: 0, lines: awakeningLines(temper, Math.random()), said: 0, own: null, bonded: false, flashed: false };
    this.fx.group.visible = true;
    this.fx.shard.visible = true;
    this.fx.ground.visible = false;
    this.fx.scorch.visible = false;
  }

  private stepScene(dt: number): void {
    const S = this.scene!, g = this.g, a = S.a, P = g.player;
    S.t += dt;
    const t = S.t;
    // Gone, or knocked down before the light was in them: the shard comes back to the hero.
    if (!a.alive || (!S.bonded && (a.state === PState.Down || a.ragdoll))) { this.abortScene(); return; }
    // Held still and facing the hero: the talk's own actor while it lasts, then ours.
    const talking = g.people.partner === a;
    if (!talking && !S.own && a.state !== PState.Sit && (!a.actor || a.actor.owner === PEOPLE_OWNER)) {
      if (a.actor) release(a);
      S.own = makeActor('bystander', SIDEKICK_OWNER, { title: S.name });
      a.actor = S.own;
    }
    const act = a.actor && (a.actor === S.own || a.actor.owner === PEOPLE_OWNER) ? a.actor : null;
    if (act) {
      act.face = { x: P.pos.x, y: P.pos.y + P.height * 0.9, z: P.pos.z };
      act.goal = null; act.speed = 0;
      act.mood = t < SCENE.flash ? 'surprised' : t < SCENE.line3 ? 'focused' : 'happy';
      if (t > SCENE.float && t < SCENE.flash && (!act.action || act.action.id !== 'channel')) play(act, 'channel', SCENE.flash - t + 0.2);
      if (t >= SCENE.flash && !S.flashed) play(act, 'stagger', 0.9);
    }
    // Where things are: the hero's hand, their chest, a little in front of it.
    const fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw), h = P.height;
    const hand = this.v.set(P.pos.x + fx * 0.38 * h / 1.8, P.pos.y + h * 0.6, P.pos.z + fz * 0.38 * h / 1.8);
    const chest = this.w.set(a.x, a.y + (a.state === PState.Sit ? 0.85 : 1.25), a.z);
    const tx = P.pos.x - a.x, tz = P.pos.z - a.z, tl = Math.hypot(tx, tz) || 1;
    const front = { x: chest.x + (tx / tl) * 0.38, y: chest.y + 0.05, z: chest.z + (tz / tl) * 0.38 };
    const shard = this.fx.shard;
    if (t < SCENE.float) {
      const e = t / SCENE.float, s = e * e * (3 - 2 * e);
      shard.position.set(hand.x + (front.x - hand.x) * s, hand.y + (front.y - hand.y) * s + Math.sin(Math.PI * e) * 0.35, hand.z + (front.z - hand.z) * s);
    } else shard.position.set(front.x, front.y + Math.sin(t * 2.2) * 0.04, front.z);
    shard.rotation.set(0.25, t * 1.8, 0.1);
    const shrink = t < SCENE.flash ? 1 : Math.max(0, 1 - (t - SCENE.flash) / (SCENE.gone - SCENE.flash));
    shard.scale.setScalar(0.55 * shrink);
    shard.visible = shrink > 0.01;
    this.fx.shardU.uI.value = 1.1 + 1.4 * Math.min(1, Math.max(0, (t - SCENE.float) / (SCENE.flash - SCENE.float)));
    this.fx.shardGlow.set(this.fx.shard.position, shard.visible ? 0.6 + 0.6 * Math.min(1, t / SCENE.flash) : 0, 0.45);
    // Its light spirals into them.
    this.fx.particles.target.copy(chest);
    if (t > SCENE.float && t < SCENE.flash) for (let i = 0; i < 2; i++) this.fx.particles.stream(this.fx.shard.position, 0.9 + Math.random() * 0.5, 0.06, Math.random() * 6.28);
    const fill = t < SCENE.float ? 0 : t < SCENE.flash ? (t - SCENE.float) / (SCENE.flash - SCENE.float) : Math.max(0, 1 - (t - SCENE.flash) / 5);
    this.fx.chestGlow.set(chest, 0.25 + 1.1 * fill * (0.85 + 0.15 * Math.sin(t * 9)), 0.55);
    if (t < SCENE.flash) this.sound.humLevel(0.12 + 0.35 * fill, 0.9 + 0.3 * fill);
    // The flash: the light is in them.
    if (t >= SCENE.flash && !S.flashed) {
      S.flashed = true;
      this.sound.stop(0.3);
      this.sound.play('surge', 0.8);
      for (let i = 0; i < 46; i++) { const u = Math.random() * 6.28, v = Math.random() * 2 - 1; this.fx.particles.spark(chest, Math.cos(u) * 3 * (1 - v * v), v * 3 + 1, Math.sin(u) * 3 * (1 - v * v), 0.9 + Math.random() * 0.6, 0.05, 0.6, 1.2, 2.2); }
      g.dust.burst(a.x, a.y + 0.2, a.z, 18, 0.5, 2.2, 0.8, 1.1, new THREE.Color(0.55, 0.8, 1.4), 0.2, 0.35);
      this.bond(a, S.name);
      S.bonded = true;
    }
    const fl = t >= SCENE.flash ? Math.max(0, 1 - (t - SCENE.flash) / 0.6) : 0;
    this.fx.flash.set(chest, fl * 3.2, 1.4);
    if (t > SCENE.gone && t < SCENE.line3 && Math.random() < dt * 10) this.fx.particles.mote(this.v.set(a.x + (Math.random() - 0.5) * 0.7, a.y + Math.random() * 1.6, a.z + (Math.random() - 0.5) * 0.7), 2, 0.05);
    // What they say: in the talk panel while it is open, else over their head.
    const at = [SCENE.line1, SCENE.line2, SCENE.line3];
    if (S.said < 3 && t >= at[S.said]) {
      const line = S.lines[S.said++];
      if (g.people.partner === a) g.people.speak(line, true);
      else g.barks?.line(a, line);
      if (S.said === 3) g.powerHud.toast(`<b>${S.name}</b> has the shard's power now: your sidekick. They can fly, and the shard gave them <b>${MATE_POWERS[this.mate.power].name}</b>. Their gold dot on the map shows where they are`, 'core', 8000);
    }
    if (t >= SCENE.end) this.endScene();
  }

  /** The light is in them: the bond is made (and kept). */
  private bond(a: PedAgent, name: string): void {
    const g = this.g;
    this.phase = 'bonded';
    this.who = a.cit.id;
    this.name = name;
    this.stats.bonded++;
    g.people.setSidekick(a.cit.id, true);
    this.mate.start(a.cit.id, name);
    const k = g.people.find(a.cit.id);
    if (k) addNote(k, g.sky.hoursAbs, `${gameTimeLabel(Math.floor(g.sky.hoursAbs / 24), g.sky.hoursAbs % 24)}: took the shard from the hero and gained powers`);
    this.persist();
  }

  private endScene(): void {
    const S = this.scene!, g = this.g;
    this.scene = null;
    if (g.people.partner === S.a) g.people.end();
    if (S.own && S.a.actor === S.own) release(S.a);
    this.fx.shard.visible = false;
    for (const gl of [this.fx.chestGlow, this.fx.flash, this.fx.shardGlow]) gl.set(this.v.set(0, -1e4, 0), 0);
  }

  private abortScene(): void {
    const S = this.scene!;
    this.endScene();
    if (!S.bonded) {
      this.phase = 'carried';
      this.sound.stop(0.3);
      this.g.powerHud.toast('The shard\'s light pulled back. <b>You still have it</b>', 'warn', 5000);
    }
  }

  // ------------------------------------------------------------------ death and the grave

  /** The revival failed: they are gone. A grave in a cemetery, the news, and in time another shard. */
  private died(): void {
    const g = this.g, name = this.name, who = this.who;
    this.stats.died++;
    this.mate.dismiss();
    g.people.setSidekick(who, false);
    g.people.remove(who);
    g.peds.absent.add(who);
    this.dead.push(who);
    this.phase = 'locked';
    this.who = -1;
    this.name = '';
    this.retryT = 0;
    this.nextAt = g.sky.hoursAbs + MATE.nextShardHours;
    const p = g.player.pos;
    g.city?.report('mourn', p.x, p.z);
    g.powerHud.toast(`<b>${name}</b> did not survive: the revival failed. They will be buried in a cemetery nearby. Somewhere, in time, another shard will turn up`, 'warn', 11000);
    this.graveFor = name;
    this.startGraveSearch();
    this.persist();
  }

  /** The cells to try for a cemetery, nearest the hero first. */
  private startGraveSearch(): void {
    const g = this.g, p = g.player.pos;
    this.graveSearch = g.macro.cells
      .map((c, i) => ({ i, d: Math.hypot(c.centroid[0] - p.x, c.centroid[1] - p.z), water: c.district === 'water' }))
      .filter((c) => !c.water && c.d < 2500)
      .sort((a, b) => a.d - b.d)
      .slice(0, 60)
      .map((c) => c.i);
  }

  private graveStep(): void {
    const g = this.g, list = this.graveSearch!;
    const cell = list.shift();
    if (cell === undefined) {
      // No cemetery anywhere near: next to where they fell, then (rare: a city without one in reach).
      this.graveSearch = null;
      const p = g.player.pos;
      this.placeGrave({ name: this.graveFor, x: p.x + 3, y: g.world.groundHeight(p.x + 3, p.z), z: p.z, yaw: 0 });
      return;
    }
    const st = g.streamer.cells.get(cell);
    const plan = st && st.status === 'ready' && st.plan ? st.plan : planCell(g.macro, g.macro.cells[cell], g.terrain);
    if (!plan.cemeteries.length) return;
    const spot = graveSpot(plan, deriveSeed(g.settings.seed, `grave:${this.dead.length}`));
    if (!spot) return;
    this.graveSearch = null;
    this.placeGrave({ name: this.graveFor, x: spot.x, y: g.world.groundHeight(spot.x, spot.z), z: spot.z, yaw: spot.yaw });
  }

  private placeGrave(gr: SavedGrave): void {
    this.graves.push(gr);
    this.graveFor = '';
    this.addGraveMesh(gr);
    this.markKey = '#stale';
    this.g.powerHud.toast(`<b>${gr.name}</b> was laid to rest. The grave is marked on your map`, 'info', 6000);
    this.persist();
  }

  private addGraveMesh(gr: SavedGrave): void {
    const m = makeGrave(gr.name, gr.yaw);
    m.position.set(gr.x, gr.y, gr.z);
    this.g.renderer.scene.add(m);
    this.graveMeshes.push(m);
  }

  // ------------------------------------------------------------------ map

  private markers(): void {
    const s = this.site, list: MapMarker[] = [];
    if (this.phase === 'reported' && s) {
      list.push({ x: s.zx, z: s.zz, r: s.zr, color: SHARD_COLOR, kind: 'zone', always: true, title: 'A strange glowing stone was found around here (on the news). Up close you will feel its pull' });
      const p = this.g.player.pos;
      // Close enough to feel it: exactly where it lies; else the middle of the area the news gave.
      if (Math.hypot(s.x - p.x, s.z - p.z) < SHARD.pullR) list.push({ x: s.x, z: s.z, color: SHARD_COLOR, kind: 'shard', always: true, title: 'The second shard: it lies here. Press E or walk into it to take it' });
      else list.push({ x: s.zx, z: s.zz, color: SHARD_COLOR, kind: 'shard', always: true, title: 'The second shard (on the news): somewhere in this circle. Up close you will feel its pull' });
    }
    for (const gr of this.graves) list.push({ x: gr.x, z: gr.z, color: '#c9c6bd', kind: 'dot', title: `The grave of ${gr.name}, who stood by you` });
    const key = list.map((m) => `${m.kind}${m.x.toFixed(0)},${m.z.toFixed(0)}`).join(';');
    if (key === this.markKey) return;
    this.markKey = key;
    this.g.map.setMarkers('shard', list);
  }

  // ------------------------------------------------------------------ saves

  private persist(): void {
    try { localStorage.setItem(STORE(this.g), JSON.stringify(this.save())); } catch { /* storage unavailable or full */ }
  }

  save(): SavedSidekick {
    return {
      v: 1, phase: this.phase, n: this.n, site: this.site ? { ...this.site } : null, gang: this.gang, cleared: this.cleared, who: this.who, name: this.name,
      matters: [...this.matters].map(([id, m]) => [id, m.favours, m.letDown]),
      mate: this.phase === 'bonded' ? this.mate.save() : null,
      graves: this.graves.map((gr) => ({ ...gr })), dead: [...this.dead], nextAt: this.nextAt, graveFor: this.graveFor,
    };
  }

  /** A save's state (null: an older save, keep what the browser remembers). */
  restore(raw: unknown, store = true): void {
    if (raw === null || raw === undefined) return;
    const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<SavedSidekick>;
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const phases: ShardPhase[] = ['locked', 'reported', 'carried', 'bonded', 'parted'];
    const site = o.site && typeof o.site === 'object' ? o.site as Partial<ShardSite> : null;
    const okSite = site && ['x', 'y', 'z', 'zx', 'zz', 'zr', 'cell', 'seed'].every((k) => Number.isFinite((site as Record<string, unknown>)[k])) && (site.kind === 'park' || site.kind === 'plaza');
    if (this.scene) this.endScene();
    this.phase = phases.includes(o.phase as ShardPhase) ? o.phase as ShardPhase : 'locked';
    this.site = okSite ? { cell: site.cell!, kind: site.kind!, x: site.x!, y: site.y!, z: site.z!, zx: site.zx!, zz: site.zz!, zr: site.zr!, seed: site.seed! } : null;
    if (this.phase === 'reported' && !this.site) this.phase = 'locked';
    this.n = Math.max(0, Math.floor(num(o.n, 0)));
    this.gang = Math.floor(num(o.gang, -1));
    this.cleared = o.cleared === true;
    this.who = Math.floor(num(o.who, -1));
    this.name = typeof o.name === 'string' ? o.name.slice(0, 60) : '';
    if ((this.phase === 'bonded' || this.phase === 'parted') && this.who < 0) this.phase = 'locked';
    this.matters.clear();
    for (const e of Array.isArray(o.matters) ? o.matters : []) if (Array.isArray(e) && e.length === 3 && e.every((x) => Number.isFinite(x))) this.matters.set(e[0], { favours: e[1], letDown: e[2] });
    // Phase 2: the sidekick's own state, the fallen and their graves.
    const g = this.g;
    for (const id of this.dead) g.peds.absent.delete(id);
    this.dead = (Array.isArray(o.dead) ? o.dead : []).filter((x) => Number.isFinite(x)).map((x) => Math.floor(x));
    for (const id of this.dead) g.peds.absent.add(id);
    for (const m of this.graveMeshes) m.removeFromParent();
    this.graveMeshes = [];
    this.graves = (Array.isArray(o.graves) ? o.graves : []).filter((gr): gr is SavedGrave => !!gr && typeof gr === 'object' && typeof gr.name === 'string' && ['x', 'y', 'z', 'yaw'].every((k) => Number.isFinite((gr as unknown as Record<string, unknown>)[k])))
      .map((gr) => ({ name: gr.name.slice(0, 60), x: gr.x, y: gr.y, z: gr.z, yaw: gr.yaw }));
    for (const gr of this.graves) this.addGraveMesh(gr);
    this.nextAt = num(o.nextAt, 0);
    this.graveFor = typeof o.graveFor === 'string' ? o.graveFor.slice(0, 60) : '';
    this.graveSearch = null;
    const m = o.mate && typeof o.mate === 'object' ? o.mate as Partial<MateSave> : null;
    const mate: MateSave | null = m ? { hp: num(m.hp, MATE.hp), k: Math.max(0, Math.floor(num(m.k, 0))), ward: Math.max(0, num(m.ward, 0)) } : null;
    if (this.phase === 'bonded') this.mate.start(this.who, this.name, mate);
    else this.mate.dismiss();
    this.guards = null;
    this.search = null;
    this.refined = false;
    this.markKey = '#stale';
    if (this.phase !== 'reported') { this.fx.shard.visible = false; this.beam.visible = false; this.sound.stop(0.2); }
    if (store) this.persist();
  }

  /** dev: what is going on. */
  status(): Record<string, unknown> {
    const s = this.site, p = this.g.player.pos;
    return {
      phase: this.phase, n: this.n, site: s ? { kind: s.kind, x: +s.x.toFixed(1), y: +s.y.toFixed(2), z: +s.z.toFixed(1), dist: Math.round(Math.hypot(s.x - p.x, s.z - p.z)) } : null,
      gang: this.gang, cleared: this.cleared, guards: this.guards ? { active: this.guards.active, committed: this.guards.committed, guarding: this.guards.guarding } : null,
      who: this.who, name: this.name, scene: this.scene ? +this.scene.t.toFixed(1) : null, stats: { ...this.stats },
      mate: this.phase === 'bonded' ? this.mate.status() : null, graves: this.graves.map((gr) => gr.name), nextAt: this.nextAt,
    };
  }

  /** dev: report a shard now (gang: force one, or none), whatever the reputation. */
  devReport(gang?: boolean): Record<string, unknown> {
    const g = this.g, p = g.player.pos;
    for (const cell of shardCells(g.macro, g.settings.seed, this.n, p.x, p.z).slice(0, 30)) {
      const st = g.streamer.cells.get(cell);
      const plan = st && st.status === 'ready' && st.plan ? st.plan : planCell(g.macro, g.macro.cells[cell], g.terrain);
      const site = resolveShard(g.macro, cell, plan, g.terrain, g.settings.seed, this.n);
      if (!site) continue;
      this.report(site);
      if (gang === false) this.gang = -1;
      if (gang === true) this.gang = g.crime?.factions.holder[site.cell] ?? -1;
      if (gang === true && this.gang < 0) this.gang = g.crime?.factions.factions[0]?.id ?? -1;
      this.persist();
      return this.status();
    }
    return { error: 'no spot found' };
  }

  /** dev: stand the hero `back` m from the shard, facing it. */
  devGo(back = 6): Record<string, unknown> | null {
    const s = this.site, g = this.g;
    if (!s) return null;
    const a = (s.seed % 628) / 100 + Math.PI / 2;
    const x = s.x + Math.cos(a) * back, z = s.z + Math.sin(a) * back;
    g.player.flying = false;
    g.player.pos.set(x, g.collision.groundAt(x, z, s.y + 2, 1.2) + 0.05, z);
    g.player.vel.set(0, 0, 0);
    g.player.yaw = Math.atan2(-(s.x - x), -(s.z - z));
    g.camRig.yaw = Math.atan2(x - s.x, z - s.z);
    g.camRig.snap?.();
    return { x, z };
  }

  /** dev: make the nearest grown-up (within 200 m) the sidekick at once (no shard, no scene). */
  devBond(): Record<string, unknown> {
    const g = this.g, p = g.player.pos;
    let best: PedAgent | null = null, bd = 200;
    for (const a of g.peds.neighbours(p.x, p.z, 200, [])) {
      const d = Math.hypot(a.x - p.x, a.z - p.z);
      if (a.alive && !a.actor && !a.inside && a.state !== PState.Down && yearsOf(a.cit) >= 18 && d < bd) { bd = d; best = a; }
    }
    if (!best) return { error: 'nobody near' };
    if (this.phase === 'bonded') { this.mate.dismiss(); g.people.setSidekick(this.who, false); }
    const k = g.people.note(best, 'talked');
    this.bond(best, k.name);
    return this.status();
  }

  /** dev: back to the start (nothing reported, nobody bonded). */
  devReset(): void {
    if (this.who >= 0) this.g.people.setSidekick(this.who, false);
    this.mate.dismiss();
    this.restore({ v: 1, phase: 'locked', n: 0, site: null, gang: -1, cleared: false, who: -1, name: '', matters: [], graves: [], dead: [], nextAt: 0, graveFor: '' });
    this.fx.group.visible = false;
  }
}

/** Working right now (an officer, a paramedic, a soldier, a shopkeeper, a cleanup worker, a street performer). */
function onDuty(act: Actor | null): boolean {
  if (!act) return false;
  return act.owner === STREET_OWNER || act.role === 'police' || act.role === 'medic' || act.role === 'soldier' || act.role === 'worker' || act.role === 'shopkeeper';
}
