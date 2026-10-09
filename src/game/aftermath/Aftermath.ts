/**
 * Consequences and the last resort (THREATS_PLAN Phase B stage 3; §2 "Casualties without gore",
 * "Show, don't tell", "How the player helps", level 5; §3 lifecycle / aftermath; PLAYGROUND_PLAN §0
 * decisions 2, 15, 19): `game.aftermath`, built after the army, updated every frame (prof
 * `aftermath`). It owns
 *
 *  - the casualty ledger (Casualties: evacuated / injured / trapped / rescued — never dead) and its
 *    small HUD chip (pictograms and numbers) while an incident and its aftermath last;
 *  - rescues and triage (Rescues): people trapped under rubble to dig out, the injured to carry to
 *    the EMS triage tent, paramedics, ambulances;
 *  - the last resort (LastResort, response level 5): the nuke countdown, the strike, levelled
 *    districts (`zones`: kept in saves, levelled again as their cells stream in, hidden in the far
 *    skyline);
 *  - show, don't tell: long-range smoke columns over every collapse and fire (SmokeColumns), the live
 *    news feed on the billboards (NewsFeed) and news pictograms afterwards, people stopping to point
 *    and film, phones glowing in crowds at night;
 *  - the aftermath: smoke lingering for hours, cordon tape and barriers round the worst damage, a
 *    memorial (flowers, candles, mourners) near it, the EMS staying a while, the carcass of a monster
 *    brought down — a landmark, then carted away by a crane and flatbeds (Cleanup);
 *  - the player leading the army (Command: G rally, T airstrike — reputation unlocks).
 *
 * Reconstruction (Reconstruction, `rebuild`): scaffolding and cranes on damaged buildings and on
 * the levelled districts, the buildings made whole again when the work is done.
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import { Rng, deriveSeed, hash32 } from '../../core/rng';
import { PState, type PedAgent } from '../../sim/Pedestrians';
import type { CellState } from '../../stream/CityStreamer';
import type { BuildingRef } from '../../world/WorldIndex';
import { attach, makeActor, play, stand, lookAt, release, AFTERMATH_OWNER } from '../../sim/actors/Actor';
import { G } from '../../render/materials/globals';
import type { MapMarker } from '../../ui/map/GameMap';
import type { SaveAftermath } from '../save/model';
import type { ThreatEvent } from '../threats/ThreatEvent';
import { Strider } from '../threats/Strider';
import { Burrower } from '../threats/burrower/Burrower';
import { Leviathan } from '../threats/leviathan/Leviathan';
import { Roc } from '../threats/roc/Roc';
import { Mech } from '../threats/mech/Mech';
import { PlayerRampage } from '../threats/PlayerRampage';
import { Reconstruction, type SaveRebuild } from './Reconstruction';
import { RESPONSE } from '../response/ResponseDirector';
import { CasualtyLedger } from './Casualties';
import { AFTERMATH, LAST_RESORT } from './rules';
import { SmokeColumns, type SmokeColumn } from './SmokeColumns';
import { AftermathProps, type PropKind } from './Props';
import { NewsFeed, FEED } from './NewsFeed';
import { Rescues } from './Rescues';
import { LastResort } from './LastResort';
import { Cleanup } from './Cleanup';
import { Command } from './Command';
import { FireCrew } from './FireCrew';

/** A prop that stays where it is (the triage tent, barriers, tape, the memorial): rebuilt when its owner's list changes. */
export interface StaticProp {
  kind: PropKind;
  x: number; y: number; z: number; yaw: number;
  paint: readonly [number, number, number];
  o?: { sx?: number; sy?: number; sz?: number; pitch?: number; roll?: number; lit?: number; blink?: number };
}

/** Where smoke rises (a collapse, a burnt facade, a struck district) and until when (absolute game hours). */
interface SmokeSource { x: number; y: number; z: number; strength: number; until: number; col: SmokeColumn }

/** A major incident's scene: where it raged, the worst damage (collapses), when it ended. */
interface Scene {
  ev: ThreatEvent;
  x: number; z: number;
  hot: { x: number; z: number; w: number }[];
  ended: number;
  triage: boolean;
}

interface Zone { x: number; z: number; r: number; when: number; settled: boolean; trapped: number }
interface Cordon { x: number; z: number; r: number; until: number; streets: boolean }
interface Memorial { x: number; z: number; yaw: number; since: number }

const CRANE_YELLOW: [number, number, number] = [0.92, 0.7, 0.12];
const STATIC_KINDS: PropKind[] = ['tent', 'sign', 'cot', 'barrier', 'tape', 'post', 'bouquet', 'candle', 'scaffold', 'net', 'mast', 'fence', 'board'];
const TAPE: [number, number, number] = [0.85, 0.12, 0.08];
const POST: [number, number, number] = [0.2, 0.2, 0.22];
const BARRIER: [number, number, number] = [0.78, 0.1, 0.07];
const FLOWERS: [number, number, number][] = [[0.85, 0.1, 0.12], [0.95, 0.92, 0.88], [0.95, 0.75, 0.1], [0.75, 0.35, 0.65], [0.9, 0.5, 0.55]];
const DUST = new THREE.Color(0.55, 0.52, 0.48);
const PHONE = new THREE.Color(0.6, 0.75, 1.0);

export class Aftermath {
  readonly ledger = new CasualtyLedger();
  readonly props: AftermathProps;
  readonly smoke: SmokeColumns;
  readonly feed: NewsFeed;
  readonly rescues: Rescues;
  readonly lastResort: LastResort;
  readonly cleanup: Cleanup;
  readonly command: Command;
  readonly fireCrew: FireCrew;
  /** Districts levelled by the last resort. */
  readonly zones: Zone[] = [];
  /** Reconstruction: crews, scaffolding and cranes; buildings made whole again. */
  readonly rebuild: Reconstruction;
  private sources: SmokeSource[] = [];
  private fireCols: SmokeColumn[] = [];
  private extraCols: SmokeColumn[] = [];
  private colsDirty = true;
  private scenes: Scene[] = [];
  private cordons: Cordon[] = [];
  private memorials: Memorial[] = [];
  private mourners: PedAgent[] = [];
  private newsKind = 0;
  private newsUntil = 0;
  private newsK = 0;
  private statics = new Map<string, StaticProp[]>();
  private staticDirty = true;
  private nightLit = -1;
  private cordonKey = '';
  private evacSeen = -1;
  private srcT = 0;
  private showT = 0;
  private phoneT = 0;
  private markT = 0;
  private zoneMark: { x: number; z: number; r: number; left: number } | null = null;
  private zoneKey = '';
  private warmed = 0;
  private hud: HTMLDivElement;
  private hudKey = '';
  private rng: Rng;
  private devDone = false;
  readonly log: { t: number; what: string }[] = [];
  stats = { collapses: 0, sources: 0, levelled: 0, cordons: 0, memorials: 0, msAvg: 0 };

  constructor(private g: Game) {
    this.rng = new Rng(deriveSeed(g.settings.seed, 'aftermath'));
    this.props = new AftermathProps(g.vehicles.material);
    this.smoke = new SmokeColumns();
    g.renderer.scene.add(this.props.group, this.smoke.mesh);
    this.feed = new NewsFeed(g);
    this.rescues = new Rescues(g, this);
    this.lastResort = new LastResort(g, this);
    this.cleanup = new Cleanup(g, this);
    this.command = new Command(g);
    this.fireCrew = new FireCrew(g, this);
    // The service vehicles, built now (not on their first call).
    for (const k of ['ambulance', 'firetruck', 'flatbed', 'crane'] as const) g.vehicles['bucket'](k, 0);
    // Collapses smoke for hours and mark the worst damage of an incident.
    const prev = g.destruction.onImpact;
    g.destruction.onImpact = (e) => { prev?.(e); if (e.kind === 'collapse') this.collapsed(e.x, e.y, e.z, e.energy); };
    // A levelled district stays levelled when its cells stream in again.
    const ready = g.streamer.onCellReady;
    g.streamer.onCellReady = (c) => { ready?.(c); try { this.cellReady(c); } catch (err) { console.warn('[aftermath] levelled district', err); } };
    // (After the district hook: a rebuilt district's cells come in whole.)
    this.rebuild = new Reconstruction(g);
    // A monster brought down: when (the carcass schedule), the news.
    g.threats.onDefeated = (s) => { s.downAt = this.hours; this.news(3); this.note('the monster is down'); };
    this.hud = document.createElement('div');
    this.hud.id = 'casualties';
    this.hud.innerHTML = HUD_HTML;
    document.body.appendChild(this.hud);
    // The P screen tells how to lead the army (controls only).
    const info = g.powers.info;
    g.powers.info = () => `${info()} <span class="pw-rep">Army: <b>G</b> rally (reputation 40+) · <b>T</b> airstrike on a targeted creature (70+)</span>`;
  }

  /** Absolute game hours. */
  get hours(): number { return this.g.sky.hoursAbs; }

  /** Game hours after the strike that a levelled district's cordon stays (then the crews move in). */
  get zoneLiftH(): number { return AFTERMATH.zoneSmokeH; }

  /** A levelled district rebuilt (Reconstruction): no longer levelled as its cells stream in, gone from the skyline. */
  removeZone(x: number, z: number): void {
    const i = this.zones.findIndex((zn) => Math.abs(zn.x - x) < 1 && Math.abs(zn.z - z) < 1);
    if (i < 0) return;
    this.zones.splice(i, 1);
    const R = this.g.skyline.ruins;
    for (let k = 0; k < R.length; k++) { const zn = this.zones[k]; if (zn) R[k].set(zn.x, zn.z, zn.r, 1); else R[k].set(0, 0, 0, 0); }
    for (let k = this.cordons.length - 1; k >= 0; k--) { const c = this.cordons[k]; if (c.streets && Math.hypot(c.x - x, c.z - z) < 2) this.cordons.splice(k, 1); }
    this.cordonKey = '';
    this.note('a levelled district rebuilt');
  }

  /** No major incident running and no countdown: crews get to work. */
  get calm(): boolean {
    return !this.g.response.incidents.some((i) => !i.closed && i.ev.tier === 'major' && i.ev.active) && this.lastResort.state !== 'countdown';
  }

  /** Where collapses and knock-downs count for the rescues: a major incident's area, a struck district, a recent scene. */
  rescueArea(x: number, z: number): boolean {
    for (const s of this.scenes) if ((s.ev.active || this.hours - s.ended < 1) && Math.hypot(s.x - x, s.z - z) < 650) return true;
    for (const zn of this.zones) if (Math.hypot(zn.x - x, zn.z - z) < zn.r * 1.25) return true;
    return false;
  }

  /** Inside a levelled district (its rubble's trapped are planned by the strike, not by each mound). */
  inZone(x: number, z: number): boolean {
    for (const zn of this.zones) if (Math.hypot(zn.x - x, zn.z - z) < zn.r * 1.05) return true;
    return false;
  }

  /** Too dangerous for the medics: near a live monster, inside a strike zone before the strike. */
  danger(x: number, z: number): boolean {
    for (const ev of this.g.threats.events) if ((ev instanceof Strider || ev instanceof PlayerRampage || ev instanceof Burrower || ev instanceof Leviathan || ev instanceof Roc || ev instanceof Mech) && ev.targetable && Math.hypot(ev.x - x, ev.z - z) < 170) return true;
    const L = this.lastResort;
    return L.state === 'countdown' && Math.hypot(L.x - x, L.z - z) < L.r * 1.1;
  }

  note(what: string): void {
    this.log.push({ t: +this.hours.toFixed(3), what });
    if (this.log.length > 60) this.log.shift();
  }

  // ================================================================== frame

  update(dt: number): void {
    const t0 = performance.now();
    const g = this.g;
    if (!this.devDone) this.installDev();
    if (!g.gate.enabled) { this.warm(); return; }
    if (this.warmed === 1) { this.warmed = 2; this.props.clearAll(); this.staticDirty = true; this.colsDirty = true; }
    // Evacuated: the response's count.
    const ev = g.response.stats.evacuated;
    if (this.evacSeen >= 0 && ev > this.evacSeen) this.ledger.evacuate(ev - this.evacSeen);
    this.evacSeen = ev;
    this.scenesStep();
    this.lastResort.update(dt);
    this.props.clear('hook'); this.props.clear('cable'); this.props.clear('chunk');
    this.cleanup.update(dt);
    this.rescues.update(dt);
    this.fireCrew.update(dt);
    this.command.update(dt);
    this.zonesStep();
    this.smokeStep(dt);
    this.newsStep(dt);
    this.feedTarget();
    this.feed.update(dt);
    this.crowds(dt);
    this.memorialStep(dt);
    this.rebuild.update(dt);
    this.props.clear('craneTop');
    this.rebuild.drawCranes((x, y, z, yaw) => this.props.put('craneTop', x, y, z, yaw, CRANE_YELLOW));
    this.drawStatics();
    this.markers(dt);
    this.hudStep();
    this.stats.msAvg = this.stats.msAvg * 0.95 + (performance.now() - t0) * 0.05;
  }

  /** Start-up warm-up: draw a speck of every new program (and its shadow variant) behind the loading screen. */
  private warm(): void {
    const p = this.g.player.pos;
    this.props.warm(p.x, p.y - 60, p.z);
    this.smoke.warm(p.x, p.y - 60, p.z);
    if (this.warmed === 0) this.feed.render();
    this.warmed = 1;
  }

  // ---------------------------------------------------------------- scenes (major incidents)

  private scenesStep(): void {
    const g = this.g, now = this.hours;
    for (const inc of g.response.incidents) {
      const ev = inc.ev;
      if (ev.tier !== 'major' || this.scenes.some((s) => s.ev === ev)) continue;
      this.scenes.push({ ev, x: ev.x, z: ev.z, hot: [], ended: -1, triage: false });
    }
    for (const s of this.scenes) {
      const inc = g.response.incidents.find((i) => i.ev === s.ev);
      if (s.ev.active) { s.x = s.ev.x; s.z = s.ev.z; }
      // EMS: the triage tent outside the cordon once the response reaches level 2.
      if (!s.triage && s.ev.active && (inc?.level ?? 0) >= 2) {
        s.triage = this.rescues.setUp(s.ev.x, s.ev.z, RESPONSE.major.cordonR + 30);
        if (s.triage) this.note('triage tent up');
      }
      if (s.ended < 0 && (!s.ev.active || !inc || inc.closed)) this.sceneEnded(s);
    }
    // Long over: forgotten.
    for (let i = this.scenes.length - 1; i >= 0; i--) if (this.scenes[i].ended >= 0 && now - this.scenes[i].ended > 6) this.scenes.splice(i, 1);
  }

  /** It is over: the worst damage cordoned off, a memorial, the EMS stay a while, crews go to work. */
  private sceneEnded(s: Scene): void {
    const now = this.hours;
    s.ended = now;
    this.rescues.packUpAt(now + AFTERMATH.emsH);
    // (Damage inside a struck district: the district's own cordon covers it.)
    const hot = s.hot.filter((h) => !this.inZone(h.x, h.z)).sort((a, b) => b.w - a.w);
    for (const h of hot.slice(0, 2)) {
      if (this.cordons.some((c) => Math.hypot(c.x - h.x, c.z - h.z) < c.r + 20)) continue;
      this.cordons.push({ x: h.x, z: h.z, r: Math.max(26, Math.min(60, 24 + Math.sqrt(h.w) * 6)), until: now + AFTERMATH.cordonH, streets: false });
      this.stats.cordons++;
    }
    const zn = this.zones.find((z) => Math.hypot(z.x - s.x, z.z - s.z) < z.r * 1.2);
    if (zn) {
      // A struck district: the memorial at its edge, on the side towards the player.
      const p = this.g.player.pos, dx = p.x - zn.x, dz = p.z - zn.z, l = Math.hypot(dx, dz) || 1;
      this.placeMemorial(zn.x + (dx / l) * zn.r * 0.93, zn.z + (dz / l) * zn.r * 0.93, zn.r * 0.12);
    } else if (hot.length) this.placeMemorial(hot[0].x, hot[0].z, this.cordons.find((c) => Math.hypot(c.x - hot[0].x, c.z - hot[0].z) < 1)?.r ?? 30);
    this.cordonKey = '';
    this.note(`incident over: ${hot.length} damage clusters, ${this.cordons.length} cordons`);
  }

  /** A collapse: smoke for hours; in an incident, a mark of the worst damage. */
  private collapsed(x: number, y: number, z: number, energy: number): void {
    this.stats.collapses++;
    const s = Math.min(1, Math.max(0.3, (Math.log10(Math.max(10, energy)) - 4) / 4));
    this.addSmoke(x, y, z, s, this.hours + AFTERMATH.smokeH[0] + (AFTERMATH.smokeH[1] - AFTERMATH.smokeH[0]) * s);
    for (const sc of this.scenes) {
      if (sc.ended >= 0 || Math.hypot(sc.x - x, sc.z - z) > 700) continue;
      const h = sc.hot.find((q) => Math.hypot(q.x - x, q.z - z) < 45);
      if (h) { h.x = (h.x * h.w + x) / (h.w + 1); h.z = (h.z * h.w + z) / (h.w + 1); h.w++; } else sc.hot.push({ x, z, w: 1 });
    }
  }

  // ---------------------------------------------------------------- smoke

  /** Smoke rising at a point until `until` (abs game hours); a source close by grows instead. */
  addSmoke(x: number, y: number, z: number, strength: number, until: number): void {
    const near = this.sources.find((s) => Math.hypot(s.x - x, s.z - z) < 35);
    if (near) { near.strength = Math.min(1, near.strength + strength * 0.3); near.until = Math.max(near.until, until); this.colsDirty = true; return; }
    if (this.sources.length >= 64) { this.sources.sort((a, b) => b.until - a.until); this.sources.pop(); }
    const g = this.g, gy = Math.max(g.terrain.height(x, z), Math.min(y, g.terrain.height(x, z) + 12));
    this.sources.push({ x, y: gy, z, strength, until, col: { x, y: gy, z, height: 0, width: 0, density: 0, fire: 0, mushroom: 0, growth: 0, seed: hash32(Math.round(x) * 73856093 ^ Math.round(z) * 19349663) } });
    this.stats.sources++;
    this.colsDirty = true;
  }

  addColumn(c: SmokeColumn): void { this.extraCols.push(c); this.colsDirty = true; }
  removeColumn(c: SmokeColumn): void { const i = this.extraCols.indexOf(c); if (i >= 0) this.extraCols.splice(i, 1); this.colsDirty = true; }

  private smokeStep(dt: number): void {
    const g = this.g, now = this.hours;
    this.srcT -= dt;
    if (this.srcT <= 0) {
      this.srcT = 1;
      // Burning facades: a column each (merged), dark and lit from below; they keep smoking after.
      const fires = g.threats.fires.list;
      const cols: SmokeColumn[] = [];
      for (const f of fires) {
        const c = cols.find((q) => Math.hypot(q.x - f.x, q.z - f.z) < 30);
        if (c) { c.density = Math.min(0.95, c.density + 0.06); c.width = Math.min(44, c.width + 3); continue; }
        cols.push({ x: f.x + f.nx * 2, y: f.y, z: f.z + f.nz * 2, height: 280, width: 26, density: 0.75, fire: 0.8, mushroom: 0, growth: 0, seed: hash32(Math.round(f.x * 7) ^ Math.round(f.z * 13)) });
        if (f.life < 3) this.addSmoke(f.x, f.y - 6, f.z, 0.45, now + AFTERMATH.smokeH[0]);
      }
      if (cols.length !== this.fireCols.length || cols.some((c, i) => Math.abs(c.x - this.fireCols[i].x) > 1 || Math.abs(c.density - this.fireCols[i].density) > 0.01)) { this.fireCols = cols; this.colsDirty = true; }
      // Sources run out (fading over their last hour).
      for (let i = this.sources.length - 1; i >= 0; i--) {
        const s = this.sources[i], left = s.until - now;
        if (left <= 0) { this.sources.splice(i, 1); this.colsDirty = true; continue; }
        const k = Math.min(1, left), c = s.col;
        const h = 160 + 380 * s.strength, w = 22 + 36 * s.strength, d = (0.45 + 0.4 * s.strength) * k;
        if (Math.abs(c.height - h) > 1 || Math.abs(c.density - d) > 0.02) { c.height = h; c.width = w; c.density = d; this.colsDirty = true; }
      }
      this.smoke.wind(g.weather.windDir, g.weather.p.wind);
    }
    if (this.colsDirty) {
      this.colsDirty = false;
      this.smoke.set([...this.sources.map((s) => s.col), ...this.fireCols, ...this.extraCols]);
    }
    this.smoke.update(dt, g.renderer.camera.position);
  }

  // ---------------------------------------------------------------- levelled districts

  /** A district levelled by the strike: kept, smoking, levelled again as its cells stream in. */
  addZone(x: number, z: number, r: number, when = this.hours): void {
    this.zones.push({ x, z, r, when, settled: false, trapped: 0 });
    const R = this.g.skyline.ruins, i = Math.min(R.length - 1, this.zones.length - 1);
    R[i].set(x, z, r, 1);
    // A day of smoke over it.
    const rng = new Rng(deriveSeed(this.g.settings.seed, 'zone-smoke', Math.round(x), Math.round(z)));
    for (let k = 0; k < 9; k++) {
      const a = rng.range(0, Math.PI * 2), d = Math.sqrt(rng.float()) * r * 0.85;
      this.addSmoke(x + Math.cos(a) * d, this.g.terrain.height(x, z), z + Math.sin(a) * d, 0.75 + rng.float() * 0.25, when + AFTERMATH.zoneSmokeH * (0.6 + 0.4 * rng.float()));
    }
    this.cordons.push({ x, z, r: r * 1.08, until: when + AFTERMATH.zoneSmokeH, streets: true });
    this.cordonKey = '';
  }

  /**
   * Level a building (the strike's wave; a struck district's cell streaming in): every element of it
   * gone, the building gone, a rubble mound for the bigger ones; with `effects` dust and noise.
   */
  level(ref: BuildingRef, effects: boolean): void {
    if (!ref.alive) return;
    const g = this.g, cs = ref.cell;
    for (let e = ref.elemBase; e < ref.elemBase + ref.elemCount; e++) g.streamer.setElement(cs, e, false);
    const cx = (ref.bounds[0] + ref.bounds[2]) / 2, cz = (ref.bounds[1] + ref.bounds[3]) / 2;
    const rad = Math.max(ref.bounds[2] - ref.bounds[0], ref.bounds[3] - ref.bounds[1]) / 2, H = ref.top - ref.base;
    g.destruction.restoreBuilding(ref, -1);
    this.stats.levelled++;
    if (H >= 8 && rad > 4) {
      const quiet = this.rescues.quiet;
      this.rescues.quiet = true;
      g.destruction.restoreMound(cx, cz, Math.min(18, rad * 0.9), Math.min(8, 1.5 + H * 0.1), effects ? 3 : 0);
      this.rescues.quiet = quiet;
    }
    // Trees, lamps and benches round it go with it (flattened: no falling bodies).
    g.props.flatten(cx, cz, rad + 8);
    if (effects) {
      g.dust.burst(cx, ref.base + Math.min(20, H * 0.4), cz, 10, rad * 1.2, 8, rad * 0.8, 8, DUST, 0.3, 0.6);
      // (No collapse stimulus per building: its listeners wreck cars and props round it — milliseconds
      // each; the wave crushes what is in the district itself, one stimulus at its end.)
      if (this.stats.levelled % 4 === 0) g.audio.play('collapse_big', cx, ref.base + 5, cz, 1, 0.8 + Math.random() * 0.3, 60, g.renderer.camera.position);
    }
  }

  /** A cell streaming in inside a levelled district: its buildings go at once (no effects). */
  private cellReady(cs: CellState): void {
    if (!this.zones.length) return;
    const refs = this.g.world.cellBuildings(cs.id);
    for (const zn of this.zones) for (const ref of refs) {
      if (!ref.alive) continue;
      const cx = (ref.bounds[0] + ref.bounds[2]) / 2, cz = (ref.bounds[1] + ref.bounds[3]) / 2;
      if (Math.hypot(cx - zn.x, cz - zn.z) < zn.r) this.level(ref, false);
    }
    this.rescues.moundsSeen = this.g.destruction.mounds.length;
  }

  /** The strike's casualties: counted now; some of the trapped are placed on the rubble once it has settled. */
  strikeCasualties(x: number, z: number, r: number, trapped: number, injured: number): void {
    this.ledger.trap(trapped);
    this.ledger.injure(injured);
    const zn = this.zones.find((q) => Math.abs(q.x - x) < 1 && Math.abs(q.z - z) < 1);
    if (zn) zn.trapped = Math.min(12, trapped);
    this.rescues.setUp(x, z, r * 1.15);
  }

  private zonesStep(): void {
    const now = this.hours;
    for (const zn of this.zones) {
      // The rubble has settled: some of the trapped where the player can reach them (counted already).
      if (zn.trapped > 0 && this.lastResort.state !== 'strike') {
        const p = this.g.player.pos;
        const mounds = this.g.destruction.mounds.filter((m) => Math.hypot(m.x - zn.x, m.z - zn.z) < zn.r && m.r >= 3)
          .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
        for (let k = 0; k < zn.trapped && k < mounds.length; k++) this.rescues.addTrapped(mounds[k].x, mounds[k].z, mounds[k].r, mounds[k].h, hash32(k * 7919 + Math.round(zn.x)), false);
        zn.trapped = 0;
        this.rescues.moundsSeen = this.g.destruction.mounds.length;
      }
      // A few game hours on, the crews have found everyone.
      if (!zn.settled && now - zn.when > 4) { zn.settled = true; this.rescues.settle(); this.note('the crews have searched the ruins'); }
    }
  }

  // ---------------------------------------------------------------- news, the feed, the crowds

  /** City news on the billboards (1 the city lost, 2 all clear, 3 the monster brought down). */
  news(kind: number): void {
    // (The strike's news is not replaced by an all clear.)
    if (this.newsKind === 1 && kind !== 1 && this.hours < this.newsUntil) return;
    this.newsKind = kind;
    this.newsUntil = this.hours + AFTERMATH.newsH;
  }

  private newsStep(dt: number): void {
    const on = this.newsKind > 0 && this.hours < this.newsUntil && this.calm ? 1 : 0;
    this.newsK += (on - this.newsK) * Math.min(1, dt * 0.5);
    this.g.future.signs.news(this.newsK > 0.01 ? this.newsKind : 0, this.newsK);
  }

  /** What the news drone films: the monster; the cloud after the strike; a carcass for its first hour. */
  private feedTarget(): void {
    const g = this.g;
    let T = null as typeof this.feed.target;
    const L = this.lastResort;
    if (L.state === 'strike') T = { x: L.x, y: g.terrain.height(L.x, L.z) + 420, z: L.z, dist: 2600, alt: -150 };
    else {
      for (const ev of g.threats.events) if (ev instanceof Strider && ev.targetable) { T = { x: ev.x, y: ev.y + 6, z: ev.z, dist: FEED.dist, alt: Math.max(FEED.alt, this.skyClear(ev.x, ev.z) - ev.y + 20) }; break; }
      // (The worm while it is up, a rampaging giant player: on the news too.)
      if (!T) for (const ev of g.threats.events) if ((ev instanceof Burrower || ev instanceof Leviathan) && ev.targetable && ev.surfaced) { T = { x: ev.x, y: ev.y + 6, z: ev.z, dist: FEED.dist, alt: Math.max(FEED.alt, this.skyClear(ev.x, ev.z) - ev.y + 20) }; break; }
      if (!T) for (const ev of g.threats.events) if (ev instanceof Mech && ev.targetable) { T = { x: ev.x, y: ev.y + 4, z: ev.z, dist: FEED.dist, alt: Math.max(FEED.alt, this.skyClear(ev.x, ev.z) - ev.y + 20) }; break; }
      if (!T) for (const ev of g.threats.events) if (ev instanceof Roc && ev.targetable) { T = { x: ev.x, y: ev.y, z: ev.z, dist: FEED.dist * 1.5, alt: 20 }; break; }
      if (!T) for (const ev of g.threats.events) if (ev instanceof PlayerRampage && ev.targetable) { T = { x: ev.x, y: ev.y, z: ev.z, dist: FEED.dist, alt: Math.max(FEED.alt, this.skyClear(ev.x, ev.z) - ev.y + 20) }; break; }
      if (!T) for (const b of g.threats.remains) if (this.hours - b.downAt < 1) { T = { x: b.x, y: b.y + 2, z: b.z, dist: 150, alt: 70 }; break; }
    }
    this.feed.target = T;
  }

  /** The tallest roof round a point (the news drone flies above them), looked up every couple of seconds. */
  private skyClear(x: number, z: number): number {
    const c = this.clearAt;
    if (Math.hypot(c.x - x, c.z - z) < 40 && this.hours - c.t < 0.01) return c.top;
    let top = this.g.terrain.height(x, z);
    for (const b of this.g.world.buildingsIn(x - 260, z - 260, x + 260, z + 260)) if (b.alive) top = Math.max(top, b.top);
    this.clearAt = { x, z, top, t: this.hours };
    return top;
  }
  private clearAt = { x: 1e9, z: 0, top: 0, t: -1 };

  /** During an incident people stop to point and film; at night their phones glow. */
  private crowds(dt: number): void {
    const g = this.g, p = g.player.pos;
    let look: { x: number; y: number; z: number } | null = null;
    for (const ev of g.threats.events) if (ev instanceof Strider && ev.targetable) { const h = ev.rig.headPos; look = { x: h.x, y: h.y, z: h.z }; break; }
    if (!look) for (const ev of g.threats.events) if ((ev instanceof Burrower || ev instanceof Leviathan) && ev.targetable && ev.surfaced) { const h = ev.headPos; look = { x: h.x, y: h.y, z: h.z }; break; }
    if (!look) for (const ev of g.threats.events) if (ev instanceof Mech && ev.targetable) { const h = ev.headPos; look = { x: h.x, y: h.y, z: h.z }; break; }
    if (!look) for (const ev of g.threats.events) if (ev instanceof Roc && ev.targetable) { const h = ev.headPos; look = { x: h.x, y: h.y, z: h.z }; break; }
    if (!look && this.lastResort.state === 'strike') look = { x: this.lastResort.x, y: g.terrain.height(this.lastResort.x, this.lastResort.z) + 500, z: this.lastResort.z };
    this.showT -= dt;
    if (look && this.showT <= 0) {
      this.showT = 1;
      let n = 0;
      for (const a of g.peds.neighbours(p.x, p.z, 140, [])) {
        if (n >= 4 || a.actor || a.inside || a.evac || a.state !== PState.Walk || a.fear > 0.4) continue;
        if (Math.hypot(a.x - look.x, a.z - look.z) < 200 || this.rng.float() > 0.35) continue;
        a.state = a.cit.curiosity > 0.55 ? PState.Film : PState.Gawk;
        a.stateT = 0;
        a.lookX = look.x; a.lookY = look.y; a.lookZ = look.z;
        n++;
      }
    }
    // Phones at night: a small glow at the hand of everyone filming nearby.
    this.phoneT -= dt;
    if (this.phoneT <= 0 && G.uNight.value > 0.35) {
      this.phoneT = 0.25;
      let n = 0;
      for (const a of g.peds.neighbours(p.x, p.z, 90, [])) {
        if (n >= 24 || a.state !== PState.Film) continue;
        const fx = -Math.sin(a.heading), fz = -Math.cos(a.heading);
        g.elements.fx.glow(a.x + fx * 0.4, a.y + 1.5, a.z + fz * 0.4, 0, 0, 0, 0.32, 0.12, 0.12, PHONE, PHONE, 0.9, 1, 0);
        n++;
      }
    }
  }

  // ---------------------------------------------------------------- cordons, memorials

  private placeMemorial(hx: number, hz: number, r: number): void {
    const g = this.g, o = { x: 0, z: 0, dx: 0, dz: 0 };
    // On the pavement just outside the cordon, towards the nearest street.
    const ne = g.net.nearestEdge(hx, hz, r + 80);
    let x = hx + r + 4, z = hz;
    if (ne) {
      const e = g.net.edges[ne.e];
      g.net.pointAt(e, ne.s, (e.width / 2 + 1.6) * (ne.side >= 0 ? 1 : -1), o);
      const dx = o.x - hx, dz = o.z - hz, d = Math.hypot(dx, dz) || 1;
      const k = Math.max(d, r + 4) / d;
      x = hx + dx * k; z = hz + dz * k;
    }
    for (let k = 0; k < 8 && !g.world.standable(x, z); k++) { x += (x - hx) * 0.08; z += (z - hz) * 0.08; }
    this.memorials.push({ x, z, yaw: Math.atan2(hx - x, hz - z), since: this.hours });
    this.stats.memorials++;
    this.cordonKey = '';
  }

  /** Mourners at a memorial near the player (a few, now and then; heads bowed). */
  private memorialStep(dt: number): void {
    const g = this.g, p = g.player.pos, now = this.hours;
    for (let i = this.memorials.length - 1; i >= 0; i--) if (now - this.memorials[i].since > AFTERMATH.memorialH) { this.memorials.splice(i, 1); this.cordonKey = ''; }
    for (let i = this.cordons.length - 1; i >= 0; i--) if (now > this.cordons[i].until) { this.cordons.splice(i, 1); this.cordonKey = ''; }
    const M = this.memorials.find((m) => Math.hypot(m.x - p.x, m.z - p.z) < 120);
    for (let i = this.mourners.length - 1; i >= 0; i--) {
      const a = this.mourners[i];
      if (!a.alive || !a.actor || !M || (a.actor.memo.leaveT ?? 0) < now) {
        if (a.alive && a.actor) { release(a); a.state = PState.Walk; }
        this.mourners.splice(i, 1);
        continue;
      }
      const act = a.actor;
      stand(act);
      lookAt(act, M.x, a.y + 0.2, M.z);
      if (!act.action) play(act, this.rng.chance(0.5) ? 'pray' : 'bow', 4);
    }
    if (M && this.mourners.length < 3 && this.rng.float() < dt * 0.15) {
      const c = g.population.synthetic(hash32(Math.floor(now * 60) * 131 + this.mourners.length) || 1);
      const ang = M.yaw + Math.PI + this.rng.range(-0.8, 0.8), d = this.rng.range(1.6, 2.6);
      const x = M.x + Math.sin(ang) * d, z = M.z + Math.cos(ang) * d;
      if (g.world.standable(x, z) && !g.crime.visible(x, 1.5, z)) {
        const a = g.peds.spawnAt(c, x, z, ang + Math.PI, false);
        if (a) { attach(a, makeActor('bystander', AFTERMATH_OWNER, { mood: 'sad', held: null, memo: { leaveT: now + this.rng.range(0.15, 0.4) } })); this.mourners.push(a); }
      }
    }
  }

  /** Static props of an owner (the triage tent, the carcass cordon, …): replaced, drawn on the next frame. */
  setStatic(owner: string, list: StaticProp[]): void { this.statics.set(owner, list); this.staticDirty = true; }

  /** Cordon tape and barriers round the worst damage and the struck districts, the memorials (near the player). */
  private drawStatics(): void {
    const g = this.g, p = g.player.pos;
    const night = G.uNight.value > 0.3 ? 1 : 0;
    const key = `${Math.round(p.x / 80)},${Math.round(p.z / 80)}:${this.cordons.length}:${this.memorials.length}`;
    if (key !== this.cordonKey || night !== this.nightLit) {
      this.cordonKey = key;
      this.nightLit = night;
      const list: StaticProp[] = [];
      for (const c of this.cordons) if (Math.hypot(c.x - p.x, c.z - p.z) < c.r + 500) this.cordonProps(c, list);
      for (const m of this.memorials) if (Math.hypot(m.x - p.x, m.z - p.z) < 500) this.memorialProps(m, list, night);
      this.setStatic('aftermath', list);
    }
    if (!this.staticDirty) return;
    this.staticDirty = false;
    for (const k of STATIC_KINDS) this.props.clear(k);
    for (const list of this.statics.values()) for (const s of list) this.props.put(s.kind, s.x, s.y, s.z, s.yaw, s.paint, s.o);
  }

  /** Tape on posts round the ring (not through buildings); barriers where it crosses a street. A struck district: barriers at its streets only. */
  private cordonProps(c: Cordon, out: StaticProp[]): void {
    const g = this.g, W = g.world, net = g.net;
    if (!c.streets) {
      const n = Math.max(12, Math.round((Math.PI * 2 * c.r) / 6));
      let prev: { x: number; y: number; z: number } | null = null;
      for (let k = 0; k <= n; k++) {
        const a = (k / n) * Math.PI * 2, x = c.x + Math.cos(a) * c.r, z = c.z + Math.sin(a) * c.r;
        if (!W.standable(x, z, 0)) { prev = null; continue; }
        const y = W.groundHeight(x, z);
        if (k < n) out.push({ kind: 'post', x, y, z, yaw: 0, paint: POST });
        if (prev) {
          const dx = x - prev.x, dz = z - prev.z, L = Math.hypot(dx, dz);
          out.push({ kind: 'tape', x: prev.x, y: prev.y, z: prev.z, yaw: Math.atan2(-dz, dx), paint: TAPE, o: { sx: L, pitch: 0, roll: Math.atan2(y - prev.y, L) } });
        }
        prev = { x, y, z };
      }
    }
    // Barriers where streets cross the ring, turned across the street (lamps blinking).
    for (const e of net.edges) {
      if (e.cls > 4) continue;
      const P = e.pts;
      for (let k = 0; k + 3 < P.length; k += 2) {
        const da = Math.hypot(P[k] - c.x, P[k + 1] - c.z), db = Math.hypot(P[k + 2] - c.x, P[k + 3] - c.z);
        if ((da < c.r) === (db < c.r)) continue;
        const t = (c.r - da) / (db - da || 1e-6);
        const x = P[k] + (P[k + 2] - P[k]) * t, z = P[k + 1] + (P[k + 3] - P[k + 1]) * t;
        if (Math.hypot(x - g.player.pos.x, z - g.player.pos.z) > 600) continue;
        const ux = P[k + 2] - P[k], uz = P[k + 3] - P[k + 1], ul = Math.hypot(ux, uz) || 1;
        const across = Math.atan2(-uz / ul, ux / ul) + Math.PI / 2;
        for (const off of [-3, 0, 3]) {
          const bx = x + (-uz / ul) * off, bz = z + (ux / ul) * off;
          out.push({ kind: 'barrier', x: bx, y: W.groundHeight(bx, bz), z: bz, yaw: across, paint: BARRIER, o: { blink: off === 0 ? 2 : 0 } });
        }
      }
    }
  }

  /** Flowers along the pavement, candles in front (lit at night). */
  private memorialProps(m: Memorial, out: StaticProp[], night: number): void {
    const g = this.g, rng = new Rng(hash32(Math.round(m.x * 10) ^ Math.round(m.z * 10)));
    const rx = Math.cos(m.yaw), rz = -Math.sin(m.yaw), fx = Math.sin(m.yaw), fz = Math.cos(m.yaw);
    for (let k = 0; k < 14; k++) {
      const u = (k / 13 - 0.5) * 3.4 + rng.range(-0.15, 0.15), v = rng.range(-0.3, 0.3);
      const x = m.x + rx * u + fx * v, z = m.z + rz * u + fz * v;
      out.push({ kind: 'bouquet', x, y: g.world.groundHeight(x, z), z, yaw: m.yaw + rng.range(-0.6, 0.6), paint: FLOWERS[rng.int(0, FLOWERS.length - 1)] });
    }
    for (let k = 0; k < 16; k++) {
      const u = (k / 15 - 0.5) * 2.8 + rng.range(-0.1, 0.1), v = -0.55 - rng.range(0, 0.35);
      const x = m.x + rx * u + fx * v, z = m.z + rz * u + fz * v;
      out.push({ kind: 'candle', x, y: g.world.groundHeight(x, z), z, yaw: 0, paint: [0.9, 0.88, 0.8], o: { lit: night } });
    }
  }

  // ---------------------------------------------------------------- map, HUD

  /** The strike zone while it counts down (LastResort): a ring on the map, the way out on the compass. */
  zoneMarker(z: { x: number; z: number; r: number; left: number } | null): void { this.zoneMark = z; }

  private markers(dt: number): void {
    this.markT -= dt;
    if (this.markT > 0) return;
    this.markT = 0.5;
    const list: MapMarker[] = [];
    const Z = this.zoneMark;
    if (Z) list.push({ x: Z.x, z: Z.z, r: Z.r, color: '#ffcc00', kind: 'zone', title: 'Strike zone — get out', always: true });
    for (const zn of this.zones) if (this.hours - zn.when < AFTERMATH.zoneSmokeH) list.push({ x: zn.x, z: zn.z, r: zn.r, color: '#8e8e93', kind: 'zone', title: 'Levelled district' });
    for (const m of this.memorials) list.push({ x: m.x, z: m.z, color: '#d1c4e9', kind: 'dot', place: true, title: 'A memorial — flowers and candles' });
    const key = list.map((m) => `${Math.round(m.x)},${Math.round(m.z)},${m.kind}`).join(';');
    if (key !== this.zoneKey) { this.zoneKey = key; this.g.map.setMarkers('aftermath', list); }
  }

  /** The casualty ledger as four pictograms with numbers, while an incident or its aftermath lasts. */
  private hudStep(): void {
    const g = this.g, c = this.ledger.c;
    const recent = this.scenes.some((s) => s.ev.active || this.hours - s.ended < 1.5) || this.zones.some((z) => this.hours - z.when < 2);
    const show = recent && this.ledger.any && !g.map.open && !g.menu.paused;
    const key = show ? `${c.evacuated},${c.injured},${c.trapped},${c.rescued},${c.byPlayer}` : '';
    if (key === this.hudKey) return;
    this.hudKey = key;
    this.hud.classList.toggle('on', show);
    if (!show) return;
    const set = (cls: string, v: number, title: string) => { const el = this.hud.querySelector(`.${cls}`) as HTMLElement; el.querySelector('b')!.textContent = String(v); el.title = title; };
    set('ev', c.evacuated, 'Evacuated');
    set('in', c.injured, 'Injured — waiting for care');
    set('tr', c.trapped, 'Trapped under rubble');
    set('re', c.rescued, `Rescued (${c.byPlayer} by you)`);
  }

  // ---------------------------------------------------------------- the player (E)

  use(): boolean { return this.rescues.use(); }
  hint(): string | null { return this.rescues.hint(); }

  // ---------------------------------------------------------------- saves

  saveState(): SaveAftermath {
    const r2 = (v: number) => Math.round(v * 100) / 100, r3 = (v: number) => Math.round(v * 1000) / 1000;
    return {
      ledger: this.ledger.serialize(),
      zones: this.zones.map((z) => [r2(z.x), r2(z.z), r2(z.r), r3(z.when)]),
      smoke: this.sources.filter((s) => s.until > this.hours).slice(0, 48).map((s) => [r2(s.x), r2(s.z), r2(s.strength), r3(s.until)]),
      cordons: this.cordons.filter((c) => !c.streets).slice(0, 16).map((c) => [r2(c.x), r2(c.z), r2(c.r), r3(c.until)]),
      memorials: this.memorials.slice(0, 8).map((m) => [r2(m.x), r2(m.z), r2(m.yaw), r3(m.since)]),
      news: this.newsKind > 0 && this.hours < this.newsUntil ? { kind: NEWS_KINDS[this.newsKind] ?? 'lost', until: r3(this.newsUntil) } : null,
      rebuild: this.rebuild.saveState(),
    };
  }

  /** Saves: the aftermath back (on a fresh city). Anyone still waiting was looked after meanwhile. */
  restore(d: SaveAftermath | null): void {
    if (!d) return;
    this.ledger.restore(d.ledger);
    this.ledger.settle();
    for (const [x, z, r, when] of d.zones) this.addZone(x, z, r, when);
    this.sources.length = 0;
    for (const [x, z, s, until] of d.smoke) this.addSmoke(x, this.g.terrain.height(x, z), z, s, until);
    for (const [x, z, r, until] of d.cordons) this.cordons.push({ x, z, r, until, streets: false });
    for (const [x, z, yaw, since] of d.memorials) this.memorials.push({ x, z, yaw, since });
    if (d.news) { this.newsKind = Math.max(1, NEWS_KINDS.indexOf(d.news.kind)); this.newsUntil = d.news.until; }
    this.cordonKey = '';
    // Zones of cells already loaded.
    for (const cs of this.g.streamer.cells.values()) if (cs.status === 'ready') this.cellReady(cs);
    this.rebuild.restore(d.rebuild as SaveRebuild | undefined);
    this.rescues.moundsSeen = this.g.destruction.mounds.length;
  }

  // ---------------------------------------------------------------- dev

  status(): Record<string, unknown> {
    return {
      ledger: { ...this.ledger.c }, calm: this.calm, hours: +this.hours.toFixed(3),
      scenes: this.scenes.map((s) => ({ active: s.ev.active, x: Math.round(s.x), z: Math.round(s.z), hot: s.hot.length, ended: +s.ended.toFixed(2), triage: s.triage })),
      zones: this.zones.map((z) => ({ x: Math.round(z.x), z: Math.round(z.z), r: z.r, when: +z.when.toFixed(2), settled: z.settled })),
      smoke: { sources: this.sources.length, fires: this.fireCols.length, extra: this.extraCols.length, drawn: this.smoke.stats },
      cordons: this.cordons.length, memorials: this.memorials.length, mourners: this.mourners.length,
      news: this.newsKind ? { kind: NEWS_KINDS[this.newsKind], until: +this.newsUntil.toFixed(2), k: +this.newsK.toFixed(2) } : null,
      feed: { on: !!this.feed.target, ...this.feed.stats }, stats: this.stats, log: this.log.slice(-8).map((l) => `${l.t}: ${l.what}`),
    };
  }

  private installDev(): void {
    const dev = (window as unknown as { dev?: Record<string, unknown> }).dev;
    if (!dev) return;
    this.devDone = true;
    const g = this.g;
    dev.aftermath = {
      aftermath: this,
      status: () => this.status(),
      rescues: () => this.rescues.status(),
      rebuild: () => this.rebuild.status(),
      rebuildHalfway: () => this.rebuild.devHalfway(),
      rebuildNow: () => this.rebuild.devHurry(),
      fire: () => this.fireCrew.status(),
      /** Someone trapped at the nearest rubble mound (or a fresh one ahead). */
      trap: () => this.rescues.devTrap(),
      /** Knock n people near the player down as injured by the monster. */
      injure: (n = 2) => this.rescues.devInjure(n),
      /** The triage tent near the player (outside 40 m). */
      triage: () => { const p = g.player.pos; return this.rescues.setUp(p.x, p.z, 40) ? this.rescues.status().triage : 'no spot'; },
      /** Smoke rising ahead of the player (strength 0..1, game hours). */
      smoke: (strength = 0.8, hours = 3) => { const p = g.player.pos, fy = g.camRig.forwardYaw; this.addSmoke(p.x - Math.sin(fy) * 120, p.y, p.z - Math.cos(fy) * 120, strength, this.hours + hours); return this.sources.length; },
      /** Level a district now (the strike without the countdown): at (x, z) or ahead, radius r. */
      zone: (r = 180, x?: number, z?: number) => {
        const p = g.player.pos, fy = g.camRig.forwardYaw;
        const cx = x ?? p.x - Math.sin(fy) * (r + 120), cz = z ?? p.z - Math.cos(fy) * (r + 120);
        this.addZone(cx, cz, r);
        let n = 0;
        for (const ref of g.world.buildingsIn(cx - r, cz - r, cx + r, cz + r)) if (ref.alive && Math.hypot((ref.bounds[0] + ref.bounds[2]) / 2 - cx, (ref.bounds[1] + ref.bounds[3]) / 2 - cz) < r) { this.level(ref, true); n++; }
        return { levelled: n };
      },
      /** The carcass: fast-forward its schedule by h game hours (all bodies lying in the city). */
      carcass: (h = 1) => { for (const b of g.threats.remains) b.downAt -= h; for (const ev of g.threats.events) if (ev instanceof Strider && ev.defeated) ev.downAt -= h; return this.cleanup.status(); },
      cleanup: () => this.cleanup.status(),
      news: (kind = 1) => { this.news(kind); return kind; },
      settle: () => { this.rescues.settle(); return { ...this.ledger.c }; },
      log: () => this.log,
      command: this.command,
    };
    dev.lastResort = {
      status: () => this.lastResort.status(),
      /** Force level 5 now (a major incident at level 4 or climbing to it: dev.response.level(5) climbs). */
      force: () => { this.lastResort.forced = true; const inc = g.response.incidents.find((i) => !i.closed && i.ev.tier === 'major'); return inc ? g.response.setLevel(5) : 'no major incident (spawn the Strider first)'; },
      /** Seconds left on the clock (0: the strike next frame). */
      left: (s = 10) => this.lastResort.setLeft(s),
      enabled: (on?: boolean) => { if (on !== undefined) LAST_RESORT.enabled = on; return LAST_RESORT.enabled; },
      tuning: LAST_RESORT,
    };
  }
}

const NEWS_KINDS = ['', 'lost', 'saved', 'down'];

/** The ledger chip: four pictograms (inline SVG) with numbers — evacuated, injured, trapped, rescued. */
const HUD_HTML = `
<span class="ev"><svg viewBox="0 0 16 16"><circle cx="9" cy="3" r="1.6"/><path d="M8 5.5 5.5 9l2 .8L9 7.6l1 2.6-2.2 3.6 1.3.8 2.6-4.2L10.5 6zM3 8h3v1.3H3z"/><path d="M12 7l3 2-3 2z"/></svg><b>0</b></span>
<span class="in"><svg viewBox="0 0 16 16"><path d="M6 2h4v4h4v4h-4v4H6v-4H2V6h4z"/></svg><b>0</b></span>
<span class="tr"><svg viewBox="0 0 16 16"><path d="M1 14 5 8l2 2 3-5 5 9z"/><circle cx="8" cy="11" r="1.3"/></svg><b>0</b></span>
<span class="re"><svg viewBox="0 0 16 16"><path d="M6.2 11.5 2.5 7.8l1.4-1.4 2.3 2.3 6-6 1.4 1.4z"/></svg><b>0</b></span>`;
