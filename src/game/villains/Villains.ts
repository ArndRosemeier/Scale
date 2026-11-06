/**
 * The city's supervillains (SUPERVILLAINS_PLAN, phase 1: the villain table and the rise). No body
 * yet: once per game hour the villain pressure grows with what happens in the city (crime, gangs
 * that collapsed, the hero's fame, threats, the harm the hero did); past its mark, with room for
 * one more, a villain rises (villain.ts, seeded by the city and shaped by its state). They start
 * quietly:
 *
 *   rumour  people asked for the news may whisper their name; hearing it opens their thread in the
 *           tracker ("Someone calling themselves …")
 *   signs   their mark goes up on walls in their crew's turf (out of sight, a few per game day);
 *           walking past one is a clue
 *
 * Normal mode only. Saved per city in the browser and in save files (SaveData.villains). Developer
 * view: dev.villains.*, admin console "Supervillains".
 */
import type { Game } from '../Game';
import type { Faction } from '../factions/Factions';
import type { ThreadInfo } from '../story/knowledge';
import { Graffiti, type Tag } from '../factions/Graffiti';
import { hashToFloat, hash32, hashCombine } from '../../core/rng';
import {
  type Villain, type VillainsState, type RiseContext, type Origin, ORIGINS,
  freshState, step, risen, advanceStages, makeVillain, pressureGain, mark, room, restoreState, saveState,
} from './villain';
import { threadTitle, whisper, markSeen, heardClue } from './villainText';

const STORE = (g: Game) => `scale.villains.v1.${g.mode}.${g.settings.seed}.${g.settings.size.toFixed(2)}`;

export const MARKS = {
  /** Most marks per villain on the walls, and in all. */
  each: 8, max: 24,
  /** Game hours between two marks of one villain; ring (m) round the hero they go up in. */
  every: 1.5, rMin: 25, rMax: 110,
  /** The hero sees a mark within this many m. */
  seenR: 12,
  /** Share of the people asked for the news who whisper about a villain (when nothing else goes round). */
  whisper: 0.35,
};

const THREAT_SITE: Record<string, string> = {
  robots: 'robot depot', brood: 'nest', teens: 'saucer\'s crash site', strider: 'strider\'s wreck',
  burrower: 'sinkhole', leviathan: 'harbour', roc: 'roc\'s nest', mech: 'mech\'s wreck',
};

interface Mark extends Tag { villain: number; seen: boolean }

export class Villains {
  state: VillainsState;
  readonly graffiti: Graffiti;
  private marks: Mark[] = [];
  private acc = 0;
  private seeAcc = 0;
  private saveT = 20;
  private devDone = false;
  /** Whispers said lately (text → villain id): hearing one opens the thread. */
  private said = new Map<string, number>();
  /** Game hour of each villain's last mark (not saved: a load waits a little). */
  private markAt = new Map<number, number>();

  constructor(private g: Game) {
    this.state = freshState(g.sky.hoursAbs);
    this.graffiti = new Graffiti((a) => this.markFaction(a));
    g.renderer.scene.add(this.graffiti.group);
    if (!this.enabled) return;
    try { this.load(JSON.parse(localStorage.getItem(STORE(g)) ?? 'null')); } catch { /* storage unavailable */ }
  }

  get enabled(): boolean {
    return this.g.mode !== 'sandbox';
  }

  get villains(): readonly Villain[] {
    return this.state.villains;
  }

  /** The tracker thread of a villain. */
  thread(v: Villain): ThreadInfo {
    return { id: `villain:${v.id}`, tab: 'villains', title: threadTitle(v), color: css(v.color), glyph: v.glyph };
  }

  /** The look of a villain's mark (Graffiti draws a group's tag from a faction's name, emblem, colour). */
  private markFaction(a: string): Faction | null {
    const v = this.state.villains.find((x) => `villain:${x.id}` === a);
    if (!v) return null;
    return { id: -1, archetype: a as Faction['archetype'], name: v.alias, emblem: v.glyph, home: v.base, palette: { name: v.theme, map: css(v.color), primary: v.color, accent: v.color } };
  }

  update(dt: number): void {
    if (!this.devDone) this.installDev();
    if (!this.enabled || this.g.intro || !this.g.crime) return;
    this.acc += dt;
    if (this.acc >= 1) { this.acc = 0; this.hourly(); this.signs(); }
    this.seeAcc += dt;
    if (this.seeAcc >= 0.5) { this.seeAcc = 0; this.look(); }
    this.saveT -= dt;
    if (this.saveT <= 0) { this.saveT = 20; this.persist(); }
  }

  // ------------------------------------------------------------------ pressure and rising

  private hourly(): void {
    const S = this.state, now = this.g.sky.hoursAbs, h = Math.floor(now);
    if (h < S.hour) S.hour = h;
    let steps = Math.min(48, h - S.hour);
    S.hour = h;
    if (steps <= 0) return;
    const gain = pressureGain(this.input());
    while (steps-- > 0) if (step(S, this.g.settings.seed, now, gain)) { this.rise(); break; }
    advanceStages(S, now);
  }

  /** What the city is like now, for the pressure. */
  input(): { crime: number; collapsed: number; fame: number; threats: number; harm: number } {
    const C = this.g.crime, idx = C.index;
    let sum = 0;
    for (let i = 0; i < idx.length; i++) sum += idx[i];
    return {
      crime: idx.length ? sum / idx.length : 0,
      collapsed: C.factions.factions.filter((f) => C.collapsed(f.id)).length,
      fame: Math.abs(C.rep.value) / 100,
      threats: (this.g.threats?.events ?? []).filter((e) => e.outcome).length,
      harm: this.harm().harm,
    };
  }

  private harm(): { harm: number; cell: number } {
    const log = this.g.consequences.log;
    let n = 0, last: { x: number; z: number } | null = null;
    for (const e of log) if (e.cause === 'player' && (e.target === 'person' || e.effect === 'collapse' || e.effect === 'wreck')) { n++; last = e; }
    return { harm: Math.min(1, n / 120), cell: last ? this.g.crime.cellAt(last.x, last.z) : -1 };
  }

  /** What the city offers a villain rising now. */
  context(): RiseContext {
    const g = this.g, C = g.crime, F = C.factions, now = g.sky.hoursAbs, led = new Set(this.state.villains.map((v) => v.crew));
    const holds = (f: Faction) => { for (let i = 0; i < F.holder.length; i++) if (F.holder[i] === f.id) return i; return f.home; };
    const bosses = C.bosses.filter((b) => b.beaten + b.escapes + b.jailed >= 2 && b.jailedUntil <= now && !led.has(F.factions[b.faction]?.archetype))
      .map((b) => ({ archetype: F.factions[b.faction].archetype, name: b.name, cell: F.factions[b.faction].home }));
    const sites = (g.macro.landmarks ?? []).filter((l) => l.cell >= 0).map((l) => ({ kind: l.kind as string, label: l.name.replace(/^the\s+/i, ''), cell: l.cell }));
    for (const e of g.threats?.events ?? []) if (e.outcome && THREAT_SITE[e.archetype]) sites.push({ kind: e.archetype, label: THREAT_SITE[e.archetype], cell: C.cellAt(e.x, e.z) });
    const groups = F.factions.filter((f) => !led.has(f.archetype) && !C.collapsed(f.id))
      .map((f) => ({ f, n: F.holder.reduce((s, h) => s + (h === f.id ? 1 : 0), 0) }))
      .sort((a, b) => a.n - b.n).map(({ f }) => ({ archetype: f.archetype as string, cell: holds(f) }));
    const h = this.harm();
    return { now, bosses, harm: h.harm, harmCell: h.cell, sites: sites.filter((s) => s.cell >= 0), groups, cells: g.macro.cells.length };
  }

  /** One rises now (dev: of a given origin, past the pressure and room). */
  rise(origin?: Origin): Villain {
    const S = this.state, now = this.g.sky.hoursAbs;
    const v = makeVillain(this.g.settings.seed, S.n + 1, this.context(), S.villains, origin);
    risen(S, v, now);
    this.persist();
    return v;
  }

  // ------------------------------------------------------------------ signs: their mark on walls

  private signs(): void {
    const g = this.g, C = g.crime, p = g.player.pos, now = g.sky.hoursAbs;
    if (this.marks.length >= MARKS.max) return;
    const cell = C.cellAt(p.x, p.z);
    if (cell < 0) return;
    const holder = C.factions.holder[cell];
    for (const v of this.state.villains) {
      if (v.stage !== 'signs') continue;
      const mine = this.marks.filter((m) => m.villain === v.id);
      if (mine.length >= MARKS.each) continue;
      const last = this.markAt.get(v.id) ?? -Infinity;
      if (now - last < MARKS.every) continue;
      const crew = v.crew ? C.factions.factions.find((f) => f.archetype === v.crew) : null;
      const here = crew ? holder === crew.id : cell === v.base;
      if (!here) continue;
      if (this.paint(v)) this.markAt.set(v.id, now);
    }
  }

  /** Put one of their marks on a wall near the hero, out of sight. */
  paint(v: Villain, anywhere = false): Mark | null {
    const g = this.g, C = g.crime;
    const walls = C.tagWalls(MARKS.rMin, MARKS.rMax);
    const u = hashCombine(v.seed, this.marks.length * 7919 + Math.floor(g.sky.hoursAbs));
    for (let k = 0; k < Math.min(walls.length, 10); k++) {
      const w = walls[(u + k) % walls.length];
      const ax = -w.nz, az = w.nx, side = (u >>> (k + 1)) & 1 ? 1 : -1, off = Math.max(1.1, (w.bay || 4.2) * 0.5);
      const x = w.x + ax * side * off, z = w.z + az * side * off, y = g.world.groundHeight(x, z) + 1.25;
      if (!anywhere && C.visible(x, y, z)) continue;
      if (this.marks.some((m) => Math.hypot(m.x - x, m.z - z) < 6) || C.graffiti.tags.some((t) => Math.hypot(t.x - x, t.z - z) < 2.5)) continue;
      const m: Mark = { x, y, z, nx: w.nx, nz: w.nz, archetype: `villain:${v.id}`, seed: hash32(u + k), villain: v.id, seen: false };
      this.marks.push(m);
      this.graffiti.add(m);
      return m;
    }
    return null;
  }

  /** Walking past a mark: a clue in their thread. */
  private look(): void {
    const g = this.g, S = g.story, p = g.player.pos;
    if (!S) return;
    for (const m of this.marks) {
      if (m.seen || Math.abs(m.x - p.x) > MARKS.seenR || Math.abs(m.z - p.z) > MARKS.seenR || Math.hypot(m.x - p.x, m.z - p.z) > MARKS.seenR) continue;
      if (!g.crime.visible(m.x, m.y, m.z)) continue;
      // Facing the street: seen only from the front.
      if ((p.x - m.x) * m.nx + (p.z - m.z) * m.nz < 0.3) continue;
      const v = this.state.villains.find((x) => x.id === m.villain);
      m.seen = true;
      if (!v) continue;
      v.known = true;
      S.note(this.thread(v), markSeen(v, S.where(m.x, m.z)), { x: m.x, z: m.z });
    }
  }

  // ------------------------------------------------------------------ whispers

  /** Talk facts: a whisper about a villain for some of the people asked for the news. */
  talkFacts(personSeed: number): { heard: string } | null {
    const vs = this.state.villains;
    if (!this.enabled || !vs.length) return null;
    const h = hash32(personSeed ^ 0x51ab9e37 ^ Math.floor(this.g.sky.hoursAbs / 6));
    if (hashToFloat(h) >= MARKS.whisper) return null;
    const v = vs[(h >>> 8) % vs.length];
    const [x, z] = this.g.macro.cells[v.base]?.centroid ?? [0, 0];
    const hood = this.g.city?.hoodNameAt(x, z);
    const text = whisper(v, hood ? `in ${hood}` : 'around town', hashToFloat(hash32(h + 1)), v.known && hashToFloat(hash32(h + 2)) < 0.4);
    this.said.set(text, v.id);
    if (this.said.size > 40) this.said.delete(this.said.keys().next().value!);
    return { heard: text };
  }

  /** People said a line to the hero: a whisper in it opens (or adds to) the villain's thread. */
  heard(line: string): void {
    const S = this.g.story;
    if (!S || !this.said.size) return;
    for (const [text, id] of this.said) {
      if (!line.includes(text)) continue;
      const v = this.state.villains.find((x) => x.id === id);
      if (!v) return;
      v.known = true;
      const [x, z] = this.g.macro.cells[v.base]?.centroid ?? [NaN, NaN];
      S.note(this.thread(v), heardClue(text), { src: 'heard', x, z });
      return;
    }
  }

  // ------------------------------------------------------------------ saves

  save(): unknown {
    if (!this.enabled) return null;
    return { ...(saveState(this.state) as object), marks: this.marks.map((m) => ({ ...m })) };
  }

  restore(d: unknown): void {
    if (!this.enabled) return;
    this.load(d ?? null);
    this.persist();
  }

  private load(d: unknown): void {
    this.state = restoreState(d, this.g.sky.hoursAbs);
    const raw = d && typeof d === 'object' ? (d as { marks?: unknown }).marks : null;
    const ids = new Set(this.state.villains.map((v) => v.id));
    this.marks = (Array.isArray(raw) ? raw : []).filter((t): t is Mark => {
      const o = t as Mark;
      return !!o && [o.x, o.y, o.z, o.nx, o.nz, o.seed, o.villain].every(Number.isFinite) && ids.has(o.villain);
    }).slice(-MARKS.max).map((m) => ({ x: m.x, y: m.y, z: m.z, nx: m.nx, nz: m.nz, seed: m.seed, villain: m.villain, archetype: `villain:${m.villain}`, seen: !!m.seen }));
    this.graffiti.restore(this.marks);
    this.said.clear();
  }

  private persist(): void {
    if (!this.enabled) return;
    try { localStorage.setItem(STORE(this.g), JSON.stringify(this.save())); } catch { /* storage unavailable or full */ }
  }

  // ------------------------------------------------------------------ developer view

  status(): unknown {
    const S = this.state, now = this.g.sky.hoursAbs;
    return {
      pressure: +S.pressure.toFixed(1), mark: +mark(this.g.settings.seed, S.n, S.villains.length).toFixed(1),
      gainPerHour: +pressureGain(this.input()).toFixed(2), room: room(Math.floor(now / 24)), risen: S.n, marks: this.marks.length,
      villains: S.villains.map((v) => ({
        id: v.id, alias: v.alias, realName: v.realName, origin: v.origin, from: v.from, motive: v.motive, grudge: v.grudge,
        style: v.style, theme: v.theme, powers: v.powers, signature: v.signature, crew: v.crew, base: v.base, stage: v.stage,
        nextStageIn: Number.isFinite(v.next) ? +(v.next - now).toFixed(1) : null, known: v.known,
      })),
    };
  }

  private installDev(): void {
    const dev = (window as unknown as { dev?: Record<string, unknown> }).dev;
    if (!dev) return;
    this.devDone = true;
    dev.villains = {
      villains: this,
      /** Pressure, its mark, room and every villain's record. */
      status: () => this.status(),
      /** One rises now ('boss' | 'failed' | 'accident' | 'outsider', or as the city has it). */
      rise: (origin?: Origin) => { const v = this.rise(ORIGINS.includes(origin as Origin) ? origin : undefined); return { id: v.id, alias: v.alias, origin: v.origin, theme: v.theme, crew: v.crew }; },
      /** Their next stage now (default: the newest). */
      stage: (id?: number) => { const v = this.pick(id); if (!v) return 'none'; v.next = this.g.sky.hoursAbs; advanceStages(this.state, v.next); return v.stage; },
      /** One of their marks on a wall near the hero now (in sight too). */
      mark: (id?: number) => { const v = this.pick(id); if (!v) return 'none'; const m = this.paint(v, true); return m ? { x: +m.x.toFixed(1), z: +m.z.toFixed(1) } : 'no wall near'; },
      /** What someone asked for the news would whisper (and the hero hears it). */
      whisper: () => { for (let s = 1; s < 200; s++) { const f = this.talkFacts(s * 7717); if (f) { this.heard(f.heard); return f.heard; } } return 'none'; },
      /** Forget them all (a fresh city). */
      clear: () => { this.state = freshState(this.g.sky.hoursAbs); this.marks = []; this.graffiti.restore([]); this.persist(); return 'cleared'; },
    };
  }

  private pick(id?: number): Villain | undefined {
    const vs = this.state.villains;
    return id === undefined ? vs[vs.length - 1] : vs.find((v) => v.id === id);
  }
}

function css(c: readonly number[]): string {
  return `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
}
