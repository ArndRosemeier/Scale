/**
 * Supervillains (SUPERVILLAINS_PLAN §1–2, phase 1): the villain record, the seeded generator and
 * the villain pressure that makes one rise. Pure (no DOM, no three.js; selftest "supervillains").
 *
 * Nothing here is fixed: who rises, why, with which powers and where comes from the city's seed and
 * from what the city offers at the moment they rise (a boss with a long record, someone the hero
 * hurt, an accident at a landmark or at a threat's remains, an outsider). A city starts with none.
 */
import { Rng, deriveSeed } from '../../core/rng';
import type { VillainPower } from '../powers/Caster';

export type Theme = 'storm' | 'frost' | 'fire' | 'metal' | 'bone' | 'beast' | 'mind' | 'shadow';
export type Motive = 'money' | 'revenge' | 'creed' | 'rule' | 'fame';
export type Origin = 'boss' | 'failed' | 'accident' | 'outsider';
/** Signature powers (§4); phase 2 gives them a body. */
export type Signature = 'chain' | 'quakeRing' | 'blink' | 'stormCloud' | 'frostWall' | 'swarm' | 'drain' | 'mindTurn' | 'cloak';
/**
 * How far their arc has come (§3). Phase 1 has the first two: whispers only, then their symbol on
 * walls. Later phases add the rest.
 */
export type Stage = 'rumour' | 'signs';
export const STAGES: readonly Stage[] = ['rumour', 'signs'];
export const THEMES: readonly Theme[] = ['storm', 'frost', 'fire', 'metal', 'bone', 'beast', 'mind', 'shadow'];
export const ORIGINS: readonly Origin[] = ['boss', 'failed', 'accident', 'outsider'];
export const MOTIVES: readonly Motive[] = ['money', 'revenge', 'creed', 'rule', 'fame'];

interface ThemeDef {
  /** Weighted villain powers. */
  powers: Partial<Record<VillainPower, number>>;
  signature: Signature[];
  /** Symbol colour (linear 0..1, the graffiti paint) and the glyph on their walls. */
  colors: [number, number, number][];
  glyphs: string[];
  /** Alias parts: "the {adj} {noun}", "{one}", "{title} {noun}". */
  adj: string[];
  noun: string[];
  one: string[];
}

export const THEME: Record<Theme, ThemeDef> = {
  storm: {
    powers: { bolt: 3, gust: 3, emp: 2, stun: 1, dash: 1 }, signature: ['chain', 'stormCloud'],
    colors: [[0.35, 0.6, 1], [0.75, 0.85, 1]], glyphs: ['ϟ', '☈'],
    adj: ['Thundering', 'Livid', 'Howling', 'Crackling'], noun: ['Squall', 'Tempest', 'Gale', 'Volt'], one: ['Stormcrow', 'Voltaine', 'Galeforce', 'Thunderhead'],
  },
  frost: {
    powers: { frost: 4, shield: 2, gust: 1, stun: 1, drain: 1 }, signature: ['frostWall', 'blink'],
    colors: [[0.55, 0.9, 1], [0.8, 0.95, 1]], glyphs: ['❄', '✱'],
    adj: ['Pale', 'Winter', 'Silent', 'Glass'], noun: ['Widow', 'Frost', 'Hoar', 'Rime'], one: ['Glacia', 'Coldsnap', 'Permafrost', 'Icicle'],
  },
  fire: {
    powers: { fireball: 4, smoke: 2, quake: 1, dash: 1, shield: 1 }, signature: ['quakeRing', 'stormCloud'],
    colors: [[1, 0.45, 0.1], [1, 0.75, 0.2]], glyphs: ['♨', '✹'],
    adj: ['Burning', 'Scorched', 'Red', 'Ember'], noun: ['Pyre', 'Cinder', 'Ash', 'Brand'], one: ['Pyrelord', 'Kindle', 'Magmar', 'Scorch'],
  },
  metal: {
    powers: { shield: 3, quake: 2, emp: 2, bolt: 1, dash: 1 }, signature: ['quakeRing', 'chain'],
    colors: [[0.85, 0.7, 0.35], [0.7, 0.75, 0.8]], glyphs: ['⚙', '⛓'],
    adj: ['Gilded', 'Iron', 'Steel', 'Chrome'], noun: ['Fang', 'Gauntlet', 'Anvil', 'Magnate'], one: ['Magnetar', 'Ironclad', 'Alloy', 'Rivet'],
  },
  bone: {
    powers: { curse: 3, drain: 3, wail: 2, smoke: 1 }, signature: ['drain', 'swarm'],
    colors: [[0.9, 0.88, 0.75], [0.6, 0.85, 0.5]], glyphs: ['☠', '⚰'],
    adj: ['Hollow', 'Grinning', 'Rattling', 'Grave'], noun: ['Marrow', 'Ossuary', 'Jawbone', 'Sexton'], one: ['Ossifer', 'Marrowgast', 'Skullduggery', 'Boneyard'],
  },
  beast: {
    powers: { whistle: 4, dash: 2, wail: 1, gust: 1, stun: 1 }, signature: ['swarm', 'blink'],
    colors: [[0.55, 0.85, 0.25], [0.95, 0.6, 0.2]], glyphs: ['✺', '❦'],
    adj: ['Feral', 'Wild', 'Snarling', 'Hungry'], noun: ['Hound', 'Jackal', 'Rook', 'Matriarch'], one: ['Packmother', 'Rattus', 'Wolfsbane', 'Hornet'],
  },
  mind: {
    powers: { stun: 3, wail: 2, curse: 1, emp: 1, drain: 1 }, signature: ['mindTurn', 'cloak'],
    colors: [[0.85, 0.4, 1], [1, 0.35, 0.7]], glyphs: ['◉', '✧'],
    adj: ['Smiling', 'Velvet', 'Whispering', 'Dreaming'], noun: ['Puppeteer', 'Hypnos', 'Mesmer', 'Choir'], one: ['Mesmera', 'Mindwright', 'Lullaby', 'Psyche'],
  },
  shadow: {
    powers: { smoke: 3, dash: 3, curse: 1, stun: 1, drain: 1 }, signature: ['cloak', 'blink'],
    colors: [[0.55, 0.45, 0.9], [0.3, 0.3, 0.4]], glyphs: ['☾', '◐'],
    adj: ['Nameless', 'Hooded', 'Midnight', 'Faceless'], noun: ['Shade', 'Umbra', 'Veil', 'Gloam'], one: ['Nightjar', 'Umbra', 'Duskwalker', 'Blackout'],
  },
};

const TITLES = ['Mother', 'Baron', 'Doctor', 'Madame', 'Captain', 'Lady', 'Count', 'Professor'];
const FIRST = ['Mara', 'Victor', 'Selene', 'Gideon', 'Odile', 'Felix', 'Petra', 'Lucan', 'Ines', 'Bram', 'Nadia', 'Cyrus', 'Elsa', 'Tobias', 'Vera', 'Hugo'];
const LAST = ['Kessler', 'Moreau', 'Hale', 'Strand', 'Okonkwo', 'Varga', 'Lindqvist', 'Abara', 'Roche', 'Petrov', 'Quill', 'Danner', 'Sato', 'Wilde'];

/** Which themes suit what the city offers (a group's kind, a landmark, a threat's remains). */
export const THEME_HINT: Record<string, Theme[]> = {
  gang: ['metal', 'fire', 'beast', 'storm'], syndicate: ['metal', 'mind', 'frost'], techno: ['storm', 'metal', 'mind'],
  cult: ['fire', 'shadow', 'mind', 'bone'], eco: ['beast', 'storm', 'frost'], necro: ['bone', 'shadow'],
  museum: ['bone', 'mind', 'metal'], tower: ['storm', 'metal'], lighthouse: ['storm', 'frost'], cathedral: ['shadow', 'bone', 'mind'],
  fortress: ['metal', 'fire'], glasshouse: ['beast', 'frost'], monument: ['metal', 'shadow'], wheel: ['storm', 'mind'],
  townhall: ['mind', 'metal'], stadium: ['fire', 'beast'], airport: ['storm', 'metal'], marvel: ['mind', 'storm', 'shadow'],
  robots: ['metal', 'storm'], brood: ['beast', 'bone'], teens: ['mind', 'storm'], strider: ['metal', 'fire'], burrower: ['beast', 'fire'],
  leviathan: ['frost', 'storm'], roc: ['storm', 'beast'], mech: ['metal', 'fire'],
};

const MOTIVE_BY_ORIGIN: Record<Origin, Partial<Record<Motive, number>>> = {
  boss: { money: 3, rule: 3, revenge: 1, fame: 1 },
  failed: { revenge: 6, fame: 1, creed: 1 },
  accident: { creed: 3, rule: 2, fame: 2, revenge: 1 },
  outsider: { money: 3, rule: 2, fame: 2, creed: 1 },
};

export interface VillainRecord { schemes: number; stopped: number; fights: number; escapes: number; jailed: number }

export interface Villain {
  /** Number in this city (1, 2, …): their tracker thread is `villain:<id>`. */
  id: number;
  seed: number;
  alias: string;
  /** Their name before (a boss's own name for "the boss who rose"). */
  realName: string;
  origin: Origin;
  /** What it was: the group the boss led (its kind), the place of the accident (its name), '' for none. */
  from: string;
  motive: Motive;
  /** Whom they hate: 'hero', 'city' or a group's kind. */
  grudge: string;
  style: { showy: boolean; cruel: boolean };
  theme: Theme;
  color: [number, number, number];
  glyph: string;
  powers: VillainPower[];
  signature: Signature;
  /** 1 … grows with time and their wins, drops when the hero beats their plans (never tuned to the hero). */
  level: number;
  /** The group they lead (its kind), or null (a lone villain so far). */
  crew: string | null;
  /** Macro cell of their base. */
  base: number;
  stage: Stage;
  /** Game hours (absolute): risen, next stage. */
  risen: number;
  next: number;
  /** The hero has heard of them (their thread exists). */
  known: boolean;
  record: VillainRecord;
}

/** What the city offers at the moment one rises. */
export interface RiseContext {
  now: number;
  /** Group kinds with a boss whose record is long (beaten + escapes + jailed ≥ 2), not yet a villain. */
  bosses: { archetype: string; name: string; cell: number }[];
  /** How much harm the hero did (0..1) and where most of it was (cell, -1: nowhere). */
  harm: number;
  harmCell: number;
  /** Places for an accident: landmarks and ended threats (kind for the theme hint, cell). */
  sites: { kind: string; label: string; cell: number }[];
  /** Groups free to be taken over (not led by a villain, not collapsed), weakest first, with a cell they hold. */
  groups: { archetype: string; cell: number }[];
  /** Cells of the city (a fallback base). */
  cells: number;
}

export const RISE = {
  /** Most villains at once: 1 early, one more every `perDays` game days, up to `max`. */
  max: 3, perDays: 5,
  /** Pressure mark for the next one: base × (1 + count) × (0.8 … 1.2, seeded). */
  mark: 30,
  /** Not two within this many game hours. */
  gap: 24,
  /** Rumour stage lasts this many game hours (seeded in between). */
  rumourHours: [6, 12] as [number, number],
};

/** Inputs of the pressure, per game hour. */
export interface PressureInput {
  /** Mean crime index of the city (0..1). */
  crime: number;
  /** Collapsed groups now (a gap to fill). */
  collapsed: number;
  /** The hero's fame (|reputation| / 100). */
  fame: number;
  /** Threats ended so far (sources of power). */
  threats: number;
  /** Harm done by the hero (0..1, someone they hurt). */
  harm: number;
}

/** Villain pressure gained in one game hour. */
export function pressureGain(i: PressureInput): number {
  const c = (v: number, a: number, b: number) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : 0));
  return 0.6 + c(i.crime, 0, 1) * 1.0 + c(i.collapsed, 0, 4) * 0.5 + c(i.fame, 0, 1.5) * 0.6 + c(i.threats, 0, 4) * 0.25 + c(i.harm, 0, 1) * 0.8;
}

/** How many may be about at once on this game day. */
export function room(day: number): number {
  return Math.min(RISE.max, 1 + Math.floor(Math.max(0, day) / RISE.perDays));
}

/** The pressure mark for the next one (n: rises so far; alive: about now). */
export function mark(seed: number, n: number, alive: number): number {
  return RISE.mark * (1 + alive) * (0.8 + 0.4 * new Rng(deriveSeed(seed, 'villain-mark', n)).float());
}

function weighted<T extends string>(r: Rng, w: Partial<Record<T, number>>): T {
  const e = Object.entries(w) as [T, number][];
  let t = r.float() * e.reduce((s, [, v]) => s + v, 0);
  for (const [k, v] of e) { t -= v; if (t <= 0) return k; }
  return e[e.length - 1][0];
}

/** Which origin, from what the city offers (seeded; an outsider can always come). */
export function pickOrigin(r: Rng, ctx: RiseContext): Origin {
  const w: Partial<Record<Origin, number>> = { outsider: 1 };
  if (ctx.bosses.length) w.boss = 2.5;
  if (ctx.harm > 0.15) w.failed = 1 + ctx.harm * 2;
  if (ctx.sites.length) w.accident = 1.5;
  return weighted(r, w);
}

/** A villain for this city: seeded by the city and their number, shaped by what the city offers. */
export function makeVillain(seed: number, id: number, ctx: RiseContext, taken: readonly Villain[] = [], origin?: Origin): Villain {
  const r = new Rng(deriveSeed(seed, 'villain', id));
  const o = origin ?? pickOrigin(r, ctx);
  let from = '', realName = `${r.pick(FIRST)} ${r.pick(LAST)}`, base = -1, crew: string | null = null, hint: Theme[] = [];
  const free = ctx.groups.filter((g) => !taken.some((v) => v.crew === g.archetype));
  if (o === 'boss' && ctx.bosses.length) {
    const b = r.pick(ctx.bosses);
    from = b.archetype; realName = b.name; base = b.cell; crew = b.archetype; hint = THEME_HINT[b.archetype] ?? [];
  } else if (o === 'accident' && ctx.sites.length) {
    const s = r.pick(ctx.sites);
    from = s.label; base = s.cell; hint = THEME_HINT[s.kind.replace(/^threat:/, '')] ?? [];
  } else if (o === 'failed') {
    base = ctx.harmCell;
  }
  // A crew: the boss's own gang, else the weakest free group (an outsider takes turf from it), else none yet.
  if (!crew && free.length && (o === 'outsider' || r.chance(0.6))) {
    const g = free[o === 'outsider' ? 0 : r.int(0, Math.min(free.length, 3) - 1)];
    crew = g.archetype;
    if (base < 0 || o === 'outsider') base = g.cell;
  }
  if (base < 0) base = r.int(0, Math.max(1, ctx.cells) - 1);
  const pool = THEMES.filter((t) => !taken.some((v) => v.theme === t));
  const hinted = hint.filter((t) => pool.includes(t));
  const theme = hinted.length && r.chance(0.75) ? r.pick(hinted) : r.pick(pool.length ? pool : THEMES);
  const T = THEME[theme];
  const motive = weighted(r, MOTIVE_BY_ORIGIN[o]);
  const grudge = o === 'failed' || (motive === 'revenge' && r.chance(0.6)) ? 'hero' : motive === 'revenge' && free.length ? r.pick(free).archetype : 'city';
  const style = { showy: r.chance(motive === 'fame' ? 0.85 : 0.45), cruel: r.chance(o === 'failed' ? 0.55 : 0.4) };
  // Powers: 3–4 different ones, weighted by theme.
  const n = r.chance(0.5) ? 4 : 3, powers: VillainPower[] = [], w = { ...T.powers };
  while (powers.length < n && Object.keys(w).length) {
    const p = weighted(r, w);
    powers.push(p);
    delete w[p];
  }
  const alias = aliasFor(r, T, taken.map((v) => v.alias));
  const now = ctx.now;
  return {
    id, seed: deriveSeed(seed, 'villain-look', id), alias, realName, origin: o, from, motive, grudge, style, theme,
    color: r.pick(T.colors), glyph: r.pick(T.glyphs), powers, signature: r.pick(T.signature),
    level: 1, crew, base, stage: 'rumour', risen: now,
    next: now + RISE.rumourHours[0] + r.float() * (RISE.rumourHours[1] - RISE.rumourHours[0]),
    known: false, record: { schemes: 0, stopped: 0, fights: 0, escapes: 0, jailed: 0 },
  };
}

function aliasFor(r: Rng, T: ThemeDef, used: readonly string[]): string {
  for (let k = 0; k < 8; k++) {
    const u = r.float();
    const a = u < 0.4 ? `the ${r.pick(T.adj)} ${r.pick(T.noun)}` : u < 0.75 ? r.pick(T.one) : `${r.pick(TITLES)} ${r.pick(T.noun)}`;
    if (!used.some((x) => x.toLowerCase() === a.toLowerCase())) return a;
  }
  return `${r.pick(T.one)} ${used.length + 1}`;
}

/** "The Gilded Fang" / "Magnetar": the alias at the start of a sentence. */
export function aliasCap(v: Pick<Villain, 'alias'>): string {
  return v.alias[0].toUpperCase() + v.alias.slice(1);
}

/** The word on their walls: the last word of the alias, in capitals (as Graffiti paints it). */
export function tagWord(alias: string): string {
  return (alias.split(/\s+/).pop() ?? alias).replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 8);
}

// ------------------------------------------------------------------ the city's villains (saved)

export interface VillainsState {
  pressure: number;
  /** Villains risen so far (the next one's number is n + 1). */
  n: number;
  /** Game hour of the last rise (-1: none yet) and of the last pressure step. */
  lastRise: number;
  hour: number;
  villains: Villain[];
}

export function freshState(now = 0): VillainsState {
  return { pressure: 0, n: 0, lastRise: -1, hour: Math.floor(now), villains: [] };
}

/**
 * One game hour of pressure; returns true when one should rise now (past the mark, room for one,
 * the gap since the last). The caller makes them (it knows the city) and calls `risen`.
 */
export function step(S: VillainsState, seed: number, now: number, gain: number): boolean {
  S.pressure += Math.max(0, gain);
  const alive = S.villains.length;
  if (alive >= room(Math.floor(now / 24))) { S.pressure = Math.min(S.pressure, mark(seed, S.n, alive)); return false; }
  if (S.lastRise >= 0 && now - S.lastRise < RISE.gap) return false;
  return S.pressure >= mark(seed, S.n, alive);
}

export function risen(S: VillainsState, v: Villain, now: number): void {
  S.villains.push(v);
  S.n = Math.max(S.n, v.id);
  S.lastRise = now;
  S.pressure = 0;
}

/** Next stage once its hour came; returns the villain whose stage changed, if any. */
export function advanceStages(S: VillainsState, now: number): Villain[] {
  const out: Villain[] = [];
  for (const v of S.villains) {
    if (v.stage === 'rumour' && now >= v.next) { v.stage = 'signs'; v.next = Infinity; out.push(v); }
  }
  return out;
}

export function saveState(S: VillainsState): unknown {
  return { ...S, pressure: Math.round(S.pressure * 100) / 100, villains: S.villains.map((v) => ({ ...v, next: Number.isFinite(v.next) ? v.next : -1, powers: [...v.powers], record: { ...v.record }, style: { ...v.style }, color: [...v.color] })) };
}

const POWERS = new Set(Object.values(THEME).flatMap((t) => Object.keys(t.powers)));
const SIGS = new Set(Object.values(THEME).flatMap((t) => t.signature));

/** A saved state back (broken entries dropped, numbers clamped); null: a fresh one. */
export function restoreState(raw: unknown, now = 0): VillainsState {
  const S = freshState(now);
  if (!raw || typeof raw !== 'object') return S;
  const o = raw as Partial<VillainsState>;
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const s = (v: unknown, d: string) => (typeof v === 'string' && v.length < 80 ? v : d);
  S.pressure = Math.max(0, Math.min(1000, n(o.pressure, 0)));
  S.lastRise = n(o.lastRise, -1);
  S.hour = Math.floor(n(o.hour, S.hour));
  const seen = new Set<number>();
  for (const x of Array.isArray(o.villains) ? o.villains.slice(0, 12) : []) {
    if (!x || typeof x !== 'object') continue;
    const v = x as Partial<Villain>;
    const id = Math.round(n(v.id, -1));
    if (id < 1 || seen.has(id) || typeof v.alias !== 'string' || !v.alias || !THEMES.includes(v.theme as Theme)) continue;
    seen.add(id);
    const T = THEME[v.theme as Theme];
    const powers = (Array.isArray(v.powers) ? v.powers : []).filter((p): p is VillainPower => POWERS.has(p as string)).slice(0, 4);
    const col = Array.isArray(v.color) && v.color.length === 3 && v.color.every((c) => typeof c === 'number' && c >= 0 && c <= 1) ? v.color as [number, number, number] : T.colors[0];
    const rec = (v.record ?? {}) as Partial<VillainRecord>;
    S.villains.push({
      id, seed: n(v.seed, id) >>> 0, alias: s(v.alias, 'Someone'), realName: s(v.realName, ''),
      origin: ORIGINS.includes(v.origin as Origin) ? v.origin as Origin : 'outsider', from: s(v.from, ''),
      motive: MOTIVES.includes(v.motive as Motive) ? v.motive as Motive : 'money', grudge: s(v.grudge, 'city'),
      style: { showy: !!v.style?.showy, cruel: !!v.style?.cruel }, theme: v.theme as Theme, color: [...col],
      glyph: s(v.glyph, T.glyphs[0]).slice(0, 2), powers: powers.length ? powers : [Object.keys(T.powers)[0] as VillainPower],
      signature: SIGS.has(v.signature as Signature) ? v.signature as Signature : T.signature[0],
      level: Math.max(1, Math.min(10, n(v.level, 1))), crew: typeof v.crew === 'string' ? v.crew : null,
      base: Math.max(0, Math.round(n(v.base, 0))), stage: STAGES.includes(v.stage as Stage) ? v.stage as Stage : 'rumour',
      risen: n(v.risen, 0), next: n(v.next, -1) < 0 ? Infinity : n(v.next, Infinity), known: !!v.known,
      record: { schemes: n(rec.schemes, 0), stopped: n(rec.stopped, 0), fights: n(rec.fights, 0), escapes: n(rec.escapes, 0), jailed: n(rec.jailed, 0) },
    });
  }
  S.n = Math.max(Math.round(n(o.n, 0)), ...S.villains.map((v) => v.id), 0);
  return S;
}
