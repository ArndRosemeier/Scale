/**
 * The save game model (pure: no DOM, no three.js; round trip and migrations tested in
 * selftest.ts). A save is one versioned JSON object; `parseSave` upgrades older versions step by
 * step (`MIGRATIONS[v]` turns version v into v + 1) and sanitises every field, so a damaged or
 * partial save still loads with defaults instead of breaking the game.
 *
 * What is NOT in a save (deliberately): people, cars, robots and drones (they are a function of
 * the seed and the clock), running crimes, robot malfunctions, small deeds and fires (ended on
 * load), loose debris, wrecked cars and broken street props (the next visit is a clean street),
 * the open interior (the player is put outside the door).
 */
import type { GameMode } from '../mode';

export const SAVE_VERSION = 4;

export type SaveKind = 'auto' | 'manual';

/** The small index entry shown in the lists (stored apart from the data). */
export interface SaveMeta {
  id: string;
  name: string;
  kind: SaveKind;
  seed: number;
  size: number;
  mode: GameMode;
  /** City name at the time of saving (the list shows it without generating the city). */
  city: string;
  day: number;
  hour: number;
  /** Real time of the save (ms since epoch). */
  created: number;
  /** Seconds played in this session line (carried over from save to save). */
  playTime: number;
  karma: number;
  /** Small JPEG data URL of the view. */
  thumb?: string;
  /** Stored size in bytes (data + thumbnail). */
  bytes?: number;
}

export interface SavePlayer {
  x: number; y: number; z: number;
  yaw: number;
  height: number;
  /** Admin size beyond the size power's range. */
  sizeOverride: boolean;
  flying: boolean;
  /** Where the spot was: in the sewer / metro, inside a building (restored to a safe spot outside). */
  under: boolean;
  indoors: boolean;
  hp: number;
  invulnerable: boolean;
  energy: number;
  slot: number;
}

export interface SaveCamera { yaw: number; pitch: number; zoom: number }
export interface SaveSky { day: number; hour: number; timeScale: number }
export interface SaveWeather { setting: string; wet: number; skipH: number }

/**
 * A defeated monster's body lying in the city: where, and since when (absolute game hours; −1:
 * unknown, counted from the load) and how much of it the cleanup crews have carted away (0..1).
 */
export interface SaveBody { kind: string; x: number; z: number; yaw: number; side: number; s: number; downAt: number; cleared: number }
/** A Strider on the move (resumed at its route position; the response back at its level — the army's units come in anew). */
export interface SaveStrider { s: number; hp: number; mode: string; level?: number }

export interface SaveThreats {
  /** ThreatClock state (ClockState v1). */
  clock: Record<string, unknown> | null;
  setting: string;
  remains: SaveBody[];
  strider: SaveStrider | null;
}

/**
 * The aftermath of the city's incidents (src/game/aftermath): the casualty ledger, districts a
 * last-resort strike levelled, smoke still rising, cordoned damage, memorials, the news on the
 * screens. Times are absolute game hours (Sky.hoursAbs). A running countdown is not kept: the
 * resumed monster brings the response back to level 4 at most, and level 5 comes again if due.
 */
export interface SaveAftermath {
  ledger: { evacuated: number; injured: number; trapped: number; rescued: number; byPlayer: number };
  /** Levelled districts: [x, z, r, when]. */
  zones: [number, number, number, number][];
  /** Smoke columns: [x, z, strength, until]. */
  smoke: [number, number, number, number][];
  /** Cordon tape round the worst damage: [x, z, r, until]. */
  cordons: [number, number, number, number][];
  /** Memorials (flowers, candles): [x, z, yaw, since]. */
  memorials: [number, number, number, number][];
  /** City news on the screens (a pictogram: 'lost' — the strike; 'saved' — called off; 'down' — the monster brought down) until when. */
  news: { kind: string; until: number } | null;
}

/** One cell's damage: index sets (codec.encodeIndexSet) over its elements. */
export interface SaveCellDamage {
  id: number;
  /** Element count of the cell when saved (a mismatch on load: the cell is skipped). */
  n: number;
  /** Dead elements (broken walls, roofs, slabs). */
  dead: string;
  /** Shattered windows in standing walls. */
  glass: string;
  /** Broken slab tiles (they stay down even when an interior opens and closes over them). */
  slabs: string;
}

export interface SaveDamage {
  cells: SaveCellDamage[];
  /** Collapsed buildings: [cell, building index, top (−1: gone entirely)]. */
  buildings: [number, number, number][];
  /** Rubble mounds: [x, z, r, h]. */
  mounds: [number, number, number, number][];
  /** Broken pieces of breakable landmarks: [landmark index, piece count, index set]. */
  landmarks?: [number, number, string][];
}

export interface SaveData {
  v: typeof SAVE_VERSION;
  id: string;
  name: string;
  kind: SaveKind;
  created: number;
  playTime: number;
  city: { seed: number; size: number };
  mode: GameMode;
  /** The selected character (AvatarStore id; null: the seed's default human) and a created look as a fallback. */
  character: { id: string | null; look: unknown | null };
  player: SavePlayer;
  camera: SaveCamera;
  sky: SaveSky;
  weather: SaveWeather | null;
  /** Progress data (karma, ranks, hotbar, cores, bonuses; abilities/Progress ProgressData). */
  progress: Record<string, unknown> | null;
  reputation: { v: number; stats: Record<string, number> };
  justice: { heat: number; wanted: number; stats: Record<string, number> };
  threats: SaveThreats;
  waypoint: { x: number; z: number } | null;
  settings: { crime: string; events: string };
  damage: SaveDamage | null;
  aftermath: SaveAftermath | null;
  /**
   * The slime civilisation (game/slimes): the Lumen's trust (deep/Trust TrustData) and the war
   * (deep/War WarState), sanitised by their own parsers on restore.
   */
  slimes: { trust: unknown; war: unknown } | null;
  /**
   * The villain groups (game/factions): how their turf moved from the seeded one (Factions
   * SavedFactions, sanitised by `restoreFactions`), the tags on the walls and the hideouts (Hideouts
   * SavedHideout, sanitised by `restoreHideouts`; older saves have none: not found yet).
   */
  factions: { turf: unknown; tags: unknown[]; hideouts?: unknown[]; bosses?: unknown[] } | null;
  /**
   * The people the hero met and what they remember (game/people memory SavedPeople, sanitised by
   * `restorePeople`); older saves have none (null: the browser's own record for the city stays).
   */
  people?: unknown;
  /**
   * Fame (game/fame): the hero's statue in front of the town hall ({ statue: { state, t } }, sanitised
   * by StatueClock.restore); older saves have none (the browser's own record for the city stays).
   */
  fame?: unknown;
  /**
   * The city's live crime index and recent news (game/news CityNews SavedNews, sanitised by
   * `CityNews.restore`); older saves have none (the seeded index, no news).
   */
  cityLife?: unknown;
  /**
   * The second shard and the sidekick (game/sidekick Sidekick SavedSidekick, sanitised by
   * `Sidekick.restore`); older saves have none (the browser's own record for the city stays).
   */
  sidekick?: unknown;
  /**
   * The Wardens' regard (game/aliens teenRules Regard, sanitised by `readRegard`); older saves have
   * none (the browser's own record for the city stays).
   */
  wardens?: unknown;
}

// ------------------------------------------------------------------ sanitising helpers

const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const str = (v: unknown, d: string, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : d);
const bool = (v: unknown, d = false): boolean => (typeof v === 'boolean' ? v : d);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const numRecord = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(obj(v))) if (Number.isFinite(x)) out[k] = x as number;
  return out;
};
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
/** Rows of four finite numbers (zones, smoke, cordons, memorials), at most `max`. */
const rows4 = (v: unknown, max: number): [number, number, number, number][] =>
  (Array.isArray(v) ? v : []).filter((r): r is [number, number, number, number] => Array.isArray(r) && r.length >= 4 && r.slice(0, 4).every(Number.isFinite)).slice(0, max).map((r) => [r[0], r[1], r[2], r[3]]);

export const CRIME_SETTINGS = ['off', 'calm', 'normal', 'chaos'] as const;
export const EVENT_SETTINGS = ['off', 'rare', 'normal', 'frequent'] as const;

// ------------------------------------------------------------------ migrations

/**
 * MIGRATIONS[v] upgrades a save of version v to v + 1. Version 0 is the pre-release shape
 * (flat fields, `pos: [x, y, z]`): kept as the pattern for the next real migration.
 */
export const MIGRATIONS: Record<number, (o: Record<string, unknown>) => Record<string, unknown>> = {
  0: (o) => {
    const pos = Array.isArray(o.pos) ? (o.pos as unknown[]) : [];
    return {
      ...o,
      v: 1,
      city: { seed: o.seed, size: o.size },
      player: { x: pos[0], y: pos[1], z: pos[2], yaw: o.yaw, height: o.height, hp: o.hp },
      sky: { day: o.day, hour: o.hour, timeScale: o.timeScale },
      progress: o.progress ?? null,
    };
  },
  // 1 → 2: the aftermath (casualty ledger, levelled districts, smoke, cordons, memorials, news) and
  // the carcass cleanup per body; old saves start with none (a body lying there counts from the load).
  1: (o) => ({ ...o, v: 2, aftermath: null }),
  // 2 → 3: the slime civilisation (trust and war); old saves take the city's stored ones.
  2: (o) => ({ ...o, v: 3, slimes: null }),
  // 3 → 4: the villain groups' turf and tags; old saves start with the seeded turf and clean walls.
  3: (o) => ({ ...o, v: 4, factions: null }),
};

/** Upgrade a raw save object to the current version (throws on a save from a newer game). */
export function migrate(raw: unknown): Record<string, unknown> {
  let o = obj(raw);
  let v = num(o.v, 0);
  if (v > SAVE_VERSION) throw new Error(`save version ${v} is newer than this game (${SAVE_VERSION})`);
  while (v < SAVE_VERSION) {
    const m = MIGRATIONS[v];
    if (!m) throw new Error(`no migration from save version ${v}`);
    o = m(o);
    v = num(o.v, v + 1);
  }
  return o;
}

/** Parse (JSON text or an object), migrate and sanitise. Throws only on unusable input. */
export function parseSave(input: string | unknown): SaveData {
  const raw = typeof input === 'string' ? JSON.parse(input) : input;
  const o = migrate(raw);
  const city = obj(o.city);
  const seed = Math.floor(num(city.seed, NaN));
  const size = num(city.size, NaN, 0, 1);
  if (!Number.isFinite(seed) || !Number.isFinite(size)) throw new Error('save without a city');
  const p = obj(o.player), c = obj(o.camera), sky = obj(o.sky), ch = obj(o.character);
  const rep = obj(o.reputation), jus = obj(o.justice), thr = obj(o.threats), set = obj(o.settings);
  const w = o.weather ? obj(o.weather) : null;
  const wp = o.waypoint ? obj(o.waypoint) : null;
  const dmg = o.damage ? obj(o.damage) : null;
  const aft = o.aftermath ? obj(o.aftermath) : null;
  return {
    v: SAVE_VERSION,
    id: str(o.id, ''),
    name: str(o.name, 'Saved game', 60),
    kind: oneOf(o.kind, ['auto', 'manual'] as const, 'manual'),
    created: num(o.created, 0),
    playTime: num(o.playTime, 0, 0),
    city: { seed, size },
    mode: oneOf(o.mode, ['normal', 'sandbox'] as const, 'normal'),
    character: { id: typeof ch.id === 'string' ? ch.id : null, look: ch.look && typeof ch.look === 'object' ? ch.look : null },
    player: {
      x: num(p.x, 0), y: num(p.y, 0), z: num(p.z, 0), yaw: num(p.yaw, 0),
      height: num(p.height, 1.8, 0.1, 100), sizeOverride: bool(p.sizeOverride), flying: bool(p.flying),
      under: bool(p.under), indoors: bool(p.indoors), hp: num(p.hp, 100, 0), invulnerable: bool(p.invulnerable),
      energy: num(p.energy, -1), slot: Math.floor(num(p.slot, 0, 0, 9)),
    },
    camera: { yaw: num(c.yaw, num(p.yaw, 0)), pitch: num(c.pitch, -0.2, -1.6, 1.6), zoom: num(c.zoom, 2.6, 0.05, 1000) },
    sky: { day: Math.floor(num(sky.day, 0, 0)), hour: num(sky.hour, 10.5, 0, 23.999), timeScale: num(sky.timeScale, 1, 0, 10000) },
    weather: w ? { setting: str(w.setting, 'auto', 20), wet: num(w.wet, 0, 0, 1), skipH: num(w.skipH, 0) } : null,
    progress: o.progress && typeof o.progress === 'object' ? (o.progress as Record<string, unknown>) : null,
    reputation: { v: num(rep.v, 0, -100), stats: numRecord(rep.stats) },
    justice: { heat: num(jus.heat, 0, 0), wanted: Math.floor(num(jus.wanted, 0, 0, 3)), stats: numRecord(jus.stats) },
    threats: {
      clock: thr.clock && typeof thr.clock === 'object' ? (thr.clock as Record<string, unknown>) : null,
      setting: oneOf(thr.setting ?? set.events, EVENT_SETTINGS, 'normal'),
      remains: (Array.isArray(thr.remains) ? thr.remains : []).map(obj).filter((b) => Number.isFinite(b.x) && Number.isFinite(b.z)).slice(0, 8).map((b) => ({
        kind: str(b.kind, 'strider', 20), x: num(b.x, 0), z: num(b.z, 0), yaw: num(b.yaw, 0), side: num(b.side, 1) < 0 ? -1 : 1, s: num(b.s, 0, 0),
        downAt: num(b.downAt, -1, -1), cleared: num(b.cleared, 0, 0, 1),
      })),
      strider: thr.strider ? (() => { const s = obj(thr.strider); return { s: num(s.s, 0, 0), hp: num(s.hp, 1, 0), mode: str(s.mode, 'advance', 20), ...(s.level !== undefined ? { level: Math.min(4, Math.round(num(s.level, 0, 0))) } : {}) }; })() : null,
    },
    waypoint: wp && Number.isFinite(wp.x) && Number.isFinite(wp.z) ? { x: wp.x as number, z: wp.z as number } : null,
    settings: { crime: oneOf(set.crime, CRIME_SETTINGS, 'normal'), events: oneOf(set.events ?? thr.setting, EVENT_SETTINGS, 'normal') },
    damage: dmg ? {
      cells: (Array.isArray(dmg.cells) ? dmg.cells : []).map(obj).filter((cd) => Number.isInteger(cd.id)).map((cd) => ({
        id: cd.id as number, n: Math.floor(num(cd.n, 0, 0)), dead: str(cd.dead, '', 1 << 26), glass: str(cd.glass, '', 1 << 26), slabs: str(cd.slabs, '', 1 << 26),
      })),
      buildings: (Array.isArray(dmg.buildings) ? dmg.buildings : []).filter((b): b is [number, number, number] => Array.isArray(b) && b.length >= 3 && b.every(Number.isFinite)).map((b) => [b[0], b[1], b[2]]),
      mounds: (Array.isArray(dmg.mounds) ? dmg.mounds : []).filter((m): m is [number, number, number, number] => Array.isArray(m) && m.length >= 4 && m.every(Number.isFinite)).map((m) => [m[0], m[1], m[2], m[3]]),
      ...(Array.isArray(dmg.landmarks) ? { landmarks: dmg.landmarks.filter((l): l is [number, number, string] => Array.isArray(l) && l.length >= 3 && Number.isInteger(l[0]) && Number.isInteger(l[1]) && typeof l[2] === 'string').map((l) => [l[0], l[1], str(l[2], '', 1 << 20)] as [number, number, string]) } : {}),
    } : null,
    aftermath: aft ? (() => {
      const L = obj(aft.ledger), n = (v: unknown) => Math.floor(num(v, 0, 0));
      const nw = aft.news ? obj(aft.news) : null;
      return {
        ledger: { evacuated: n(L.evacuated), injured: n(L.injured), trapped: n(L.trapped), rescued: n(L.rescued), byPlayer: n(L.byPlayer) },
        zones: rows4(aft.zones, 8), smoke: rows4(aft.smoke, 48), cordons: rows4(aft.cordons, 16), memorials: rows4(aft.memorials, 8),
        news: nw && typeof nw.kind === 'string' ? { kind: str(nw.kind, 'lost', 12), until: num(nw.until, 0) } : null,
      };
    })() : null,
    slimes: o.slimes && typeof o.slimes === 'object' ? { trust: obj(o.slimes).trust ?? null, war: obj(o.slimes).war ?? null } : null,
    factions: o.factions && typeof o.factions === 'object' ? {
      turf: obj(o.factions).turf ?? null,
      tags: (Array.isArray(obj(o.factions).tags) ? (obj(o.factions).tags as unknown[]) : []).slice(-64),
      hideouts: (Array.isArray(obj(o.factions).hideouts) ? (obj(o.factions).hideouts as unknown[]) : []).slice(0, 16),
      bosses: (Array.isArray(obj(o.factions).bosses) ? (obj(o.factions).bosses as unknown[]) : []).slice(0, 16),
    } : null,
    ...(o.people && typeof o.people === 'object' ? { people: o.people } : {}),
    ...(o.fame && typeof o.fame === 'object' ? { fame: o.fame } : {}),
    ...(o.cityLife && typeof o.cityLife === 'object' ? { cityLife: o.cityLife } : {}),
    ...(o.sidekick && typeof o.sidekick === 'object' ? { sidekick: o.sidekick } : {}),
    ...(o.wardens && typeof o.wardens === 'object' ? { wardens: o.wardens } : {}),
  };
}

export function serializeSave(d: SaveData): string {
  return JSON.stringify(d);
}

/** The index entry of a save. */
export function metaOf(d: SaveData, city: string, thumb?: string, karma = 0): SaveMeta {
  return {
    id: d.id, name: d.name, kind: d.kind, seed: d.city.seed, size: d.city.size, mode: d.mode, city,
    day: d.sky.day, hour: d.sky.hour, created: d.created, playTime: d.playTime, karma, thumb,
  };
}

/** "Day 3, 18:45" */
export function gameTimeLabel(day: number, hour: number): string {
  const h = Math.floor(hour), m = Math.floor((hour - h) * 60);
  return `Day ${day + 1}, ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** "1 h 05 min" / "12 min" / "40 s" */
export function playTimeLabel(s: number): string {
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** "12 s ago", "5 min ago", "yesterday 14:02", "3 Oct 14:02" */
export function agoLabel(t: number, now = Date.now()): string {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return `${Math.round(s)} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const d = new Date(t), hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (s < 12 * 3600) return `${Math.floor(s / 3600)} h ago`;
  return `${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${hm}`;
}
