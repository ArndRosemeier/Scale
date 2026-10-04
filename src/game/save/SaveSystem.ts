/**
 * Saves (`game.saves`): capture the session into a `SaveData`, store it (SaveStore), put a save
 * back into a freshly started city (`apply`), autosave, and the `dev.save` console helpers.
 *
 * Autosave: every 2 minutes of play, when the tab is hidden, after notable moments (a city event
 * or a crime ends, karma spent) and — best effort, synchronously into localStorage — when the
 * page goes away. Autosaves rotate over three slots (`auto-0..2`), so a write that fails or is
 * cut off never loses the previous one.
 *
 * Loading a save of another city (or any save from inside a running game) reloads the page with
 * `?seed&size&mode&load=<id>`; main.ts then starts that city with the save (Game.pendingSave),
 * the player streamed in at the saved spot (Game.startAt).
 */
import type { Game } from '../Game';
import { Player } from '../../player/Player';
import { avatarStore } from '../../avatar/AvatarStore';
import { cityName } from '../../plan/names';
import { CityDamage } from './CityDamage';
import { saveStore } from './SaveStore';
import { SAVE_VERSION, metaOf, parseSave, serializeSave, type SaveData, type SaveKind, type SaveMeta, type SavePlayer } from './model';

/** Seconds of play between autosaves. */
export const AUTOSAVE_EVERY = 120;
const AUTO_SLOTS = ['auto-0', 'auto-1', 'auto-2'];
/** Notable moments save at most this often (s). */
const NOTABLE_GAP = 25;

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

export class SaveSystem {
  /** Seconds played in this line of saves (carried over by loading). */
  playTime = 0;
  /** Real time (ms) of the last successful save, and what it was. */
  lastSaved = 0;
  lastKind: SaveKind | null = null;
  status: SaveStatus = 'idle';
  /** Status changes (HUD indicator, pause menu). */
  readonly listeners: ((s: SaveStatus) => void)[] = [];
  readonly damage: CityDamage;
  /** The save this session was loaded from (null: a new game). */
  loadedFrom: string | null = null;
  private autoT = AUTOSAVE_EVERY;
  private notableT = -1;
  private lastAutoAt = 0;
  private busy: Promise<unknown> | null = null;
  private lastTick = performance.now();
  private thumb: string | undefined;
  /** Leaving on purpose (loading a save, a new city): no last-moment save. */
  private leaving = false;
  private seen = { events: 0, resolved: 0, karma: 0 };

  constructor(private g: Game) {
    this.damage = new CityDamage(g);
    this.seen.karma = g.progress.karma;
    g.progress.onChange.push(() => {
      // Karma spent (a power bought / ranked up): worth an autosave.
      if (g.progress.karma < this.seen.karma) this.notable();
      this.seen.karma = g.progress.karma;
    });
    setInterval(() => this.tick(), 1000);
    document.addEventListener('visibilitychange', () => { if (document.hidden) void this.autosave('hidden'); });
    window.addEventListener('pagehide', () => this.lastMoment());
    window.addEventListener('beforeunload', () => this.lastMoment());
    this.installDev();
    // The newest autosave slot (the last-moment save goes to the one after it).
    void saveStore.list().then((l) => { this.lastAutoId ??= l.find((m) => AUTO_SLOTS.includes(m.id))?.id ?? null; }).catch(() => undefined);
  }

  // ------------------------------------------------------------------ timing

  private tick(): void {
    const now = performance.now(), dt = Math.min(5, (now - this.lastTick) / 1000);
    this.lastTick = now;
    if (document.hidden) return;
    this.playTime += dt;
    const g = this.g;
    // Notable moments: a city event or a crime ended.
    const events = g.threats?.events.filter((e) => e.active).length ?? 0, resolved = g.crime?.stats.resolved ?? 0;
    if (events < this.seen.events || resolved > this.seen.resolved) this.notable();
    this.seen.events = events; this.seen.resolved = resolved;
    if (this.notableT > 0 && (this.notableT -= dt) <= 0) { this.notableT = -1; void this.autosave('moment'); }
    this.autoT -= dt;
    if (this.autoT <= 0) void this.autosave('timer');
  }

  /** Something worth an autosave happened: save in a few seconds (rate-limited). */
  notable(): void {
    if (this.notableT < 0 && this.playTime - this.lastAutoAt > NOTABLE_GAP) this.notableT = 3;
  }

  // ------------------------------------------------------------------ capture

  /** The session as a save (synchronous; no storage). */
  capture(kind: SaveKind, name: string, id: string): SaveData {
    const g = this.g, P = g.player, p = P.pos;
    const under = g.underground.isUnder(p.x, p.y + 0.5, p.z);
    const indoors = !!g.interiors.insideAt(p.x, p.y + 0.5, p.z);
    const player: SavePlayer = {
      x: r3(p.x), y: r3(p.y), z: r3(p.z), yaw: r3(P.yaw), height: r3(P.height), sizeOverride: P.sizeOverride, flying: P.flying,
      under, indoors, hp: r3(g.crime.health.hp), invulnerable: g.crime.health.invulnerable, energy: r3(g.abilities.energy), slot: g.abilities.selected,
    };
    const W = g.weather as unknown as { setting?: string; wet?: number; skipH?: number; serialize?: () => SaveData['weather'] } | undefined;
    // (Weather hook: a `serialize()` / `restore()` pair on render/Weather wins over the fields read here.)
    const weather = !W ? null : W.serialize ? W.serialize() : { setting: String(W.setting ?? 'auto'), wet: r3(W.wet ?? 0), skipH: r3(W.skipH ?? 0) };
    let damage: SaveData['damage'] = null;
    try { damage = this.damage.capture(); } catch (e) { console.warn('[saves] could not capture the city damage', e); }
    return {
      v: SAVE_VERSION, id, name, kind, created: Date.now(), playTime: Math.round(this.playTime),
      city: { seed: g.settings.seed, size: g.settings.size }, mode: g.mode,
      character: { id: avatarStore.selected(), look: Player.look ?? null },
      player,
      camera: { yaw: r3(g.camRig.yaw), pitch: r3(g.camRig.pitch), zoom: r3(g.camRig.zoom) },
      sky: { day: g.sky.day, hour: r3(g.sky.hour), timeScale: g.sky.timeScale },
      weather,
      progress: g.progress.serialize() as unknown as Record<string, unknown>,
      reputation: g.crime.rep.serialize(),
      justice: g.crime.justice.serialize(),
      threats: g.threats.saveState(),
      waypoint: g.map.waypoint ? { x: r3(g.map.waypoint.x), z: r3(g.map.waypoint.z) } : null,
      settings: { crime: g.crime.setting, events: g.threats.setting },
      damage,
      aftermath: g.aftermath ? g.aftermath.saveState() : null,
      slimes: g.slimeRealm ? g.slimeRealm.saveState() : null,
    };
  }

  /** A small JPEG of the view (renders one frame; in the same task, so no preserved buffer is needed). */
  thumbnail(): string | undefined {
    try {
      const src = this.g.renderer.gl.domElement;
      const c = document.createElement('canvas');
      c.width = 192; c.height = 108;
      const ctx = c.getContext('2d');
      if (!ctx || !src.width) return this.thumb;
      this.g.renderer.render();
      const a = src.width / src.height, b = c.width / c.height;
      const sw = a > b ? src.height * b : src.width, sh = a > b ? src.height : src.width / b;
      ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, c.width, c.height);
      this.thumb = c.toDataURL('image/jpeg', 0.72);
    } catch (e) { console.warn('[saves] thumbnail', e); }
    return this.thumb;
  }

  private meta(d: SaveData, thumb?: string): SaveMeta {
    return metaOf(d, cityName(d.city.seed), thumb, this.g.progress.karma);
  }

  // ------------------------------------------------------------------ store

  private setStatus(s: SaveStatus): void {
    this.status = s;
    for (const f of this.listeners) { try { f(s); } catch { /* UI */ } }
  }

  /** Capture and store (one at a time). Resolves to the index entry, or null on failure. */
  private async write(kind: SaveKind, name: string, id: string): Promise<SaveMeta | null> {
    while (this.busy) await this.busy.catch(() => undefined);
    const run = (async () => {
      this.setStatus('saving');
      try {
        const d = this.capture(kind, name, id);
        const meta = this.meta(d, this.thumbnail());
        const ok = await saveStore.put(d, meta);
        if (!ok) { this.setStatus('failed'); return null; }
        this.lastSaved = Date.now();
        this.lastKind = kind;
        this.setStatus('saved');
        return { ...meta, bytes: saveStore.lastBytes };
      } catch (e) {
        console.warn('[saves] save failed', e);
        this.setStatus('failed');
        return null;
      }
    })();
    this.busy = run;
    try { return await run; } finally { if (this.busy === run) this.busy = null; }
  }

  /** A named save (the same name overwrites it). */
  save(name: string): Promise<SaveMeta | null> {
    const n = name.trim().slice(0, 40) || 'Saved game';
    return this.write('manual', n, manualId(n));
  }

  /** The rolling autosave: the oldest of the three slots. */
  async autosave(reason = 'manual'): Promise<SaveMeta | null> {
    if (this.leaving || !this.g.player) return null;
    this.autoT = AUTOSAVE_EVERY;
    this.lastAutoAt = this.playTime;
    const id = await this.nextSlot();
    const m = await this.write('auto', 'Autosave', id);
    if (m) this.lastAutoId = id;
    if (m) console.log(`[saves] autosave (${reason}) → ${id}, ${(m.bytes ?? 0) / 1000 | 0} kB`);
    return m;
  }

  private async nextSlot(): Promise<string> {
    const metas = (await saveStore.list()).filter((m) => AUTO_SLOTS.includes(m.id));
    for (const s of AUTO_SLOTS) if (!metas.some((m) => m.id === s)) return s;
    return metas.sort((a, b) => a.created - b.created)[0].id;
  }

  /** Page hide / unload: a synchronous save into localStorage (folded into IndexedDB next start). */
  private lastMoment(): void {
    if (this.leaving || !this.g.player) return;
    try {
      // The slot after the newest autosave's (rotation), known without waiting on IndexedDB.
      const slot = AUTO_SLOTS[(AUTO_SLOTS.indexOf(this.lastAutoSlot) + 1) % AUTO_SLOTS.length];
      const d = this.capture('auto', 'Autosave', slot);
      saveStore.putSync(d, this.meta(d, this.thumb));
    } catch (e) { console.warn('[saves] last-moment save failed', e); }
  }

  private get lastAutoSlot(): string {
    return this.lastAutoId ?? AUTO_SLOTS[AUTO_SLOTS.length - 1];
  }
  private lastAutoId: string | null = null;

  // ------------------------------------------------------------------ load

  /**
   * Load a save: always through a page reload with `load=<id>` (a clean city with that seed, size
   * and mode, streamed in at the saved spot).
   */
  async load(id: string): Promise<boolean> {
    const d = await saveStore.get(id);
    if (!d) return false;
    this.leaving = true;
    location.href = loadUrl(d);
    return true;
  }

  /** Put a save into this freshly started city (Game.start, before the warm-up). */
  apply(d: SaveData): void {
    const g = this.g;
    const step = (what: string, fn: () => void) => { try { fn(); } catch (e) { console.warn(`[saves] could not restore ${what}`, e); } };
    this.loadedFrom = d.id;
    this.playTime = d.playTime;
    if (d.kind === 'auto') this.lastAutoId = d.id;
    step('the clock', () => { g.sky.day = d.sky.day; g.sky.hour = d.sky.hour; g.sky.timeScale = d.sky.timeScale; });
    step('the weather', () => {
      const w = d.weather;
      const W = g.weather as unknown as { set?: (s: string) => unknown; wet?: number; skipH?: number; restore?: (o: unknown) => void } | undefined;
      if (!w || !W) return;
      if (W.restore) { W.restore(w); return; }
      W.set?.(w.setting);
      if ('wet' in W) W.wet = w.wet;
      if ('skipH' in W) W.skipH = w.skipH;
    });
    step('progress', () => { if (d.progress) g.progress.restore(d.progress); });
    step('reputation', () => g.crime.rep.restore(d.reputation));
    step('settings', () => { g.crime.setting = d.settings.crime as typeof g.crime.setting; });
    step('the threats', () => g.threats.restoreState({ ...d.threats, setting: d.settings.events || d.threats.setting }));
    step('the city damage', () => { const n = this.damage.restore(d.damage); if (n) console.log(`[saves] damage restored in ${n} cells`); });
    step('the aftermath', () => g.aftermath.restore(d.aftermath));
    step('the slimes', () => g.slimeRealm?.restore(d.slimes as Parameters<typeof g.slimeRealm.restore>[0]));
    step('the player', () => this.placePlayer(d.player));
    step('the camera', () => { g.camRig.yaw = d.camera.yaw; g.camRig.pitch = d.camera.pitch; g.camRig.zoom = d.camera.zoom; });
    step('health', () => {
      const H = g.crime.health;
      H.strengthRank = g.abilities.rank('strength');
      H.invulnerable = d.player.invulnerable;
      H.hp = Math.max(1, Math.min(H.max, d.player.hp));
      if (d.player.energy >= 0) g.abilities.energy = Math.min(g.abilities.maxEnergy, d.player.energy);
      g.abilities.selected = d.player.slot;
    });
    step('justice', () => g.crime.justice.restore(d.justice));
    step('the marker', () => g.map.setWaypoint(d.waypoint));
    this.seen.karma = g.progress.karma;
    this.lastSaved = d.created;
    this.lastKind = d.kind;
    console.log(`[saves] loaded "${d.name}" (${d.id}): ${cityName(d.city.seed)}, day ${d.sky.day + 1} ${d.sky.hour.toFixed(2)} h`);
  }

  /** The player back at the saved spot, or at a safe one nearby when that spot cannot be restored as it was. */
  private placePlayer(s: SavePlayer): void {
    const g = this.g, P = g.player;
    P.sizeOverride = s.sizeOverride;
    P.height = P.targetHeight = s.height;
    P.vel.set(0, 0, 0);
    P.yaw = s.yaw;
    if (P.seat) P.standUp();
    if (s.flying !== P.flying && (P.flightAllowed || !s.flying)) P.toggleFlight();
    let exact = false;
    if (s.indoors) exact = false; // interiors open on approach: outside the door is the safe spot
    else if (s.under) exact = g.underground.isUnder(s.x, s.y + 0.5, s.z);
    else if (s.flying && P.flying) exact = s.y > g.world.groundHeight(s.x, s.z) - 0.5;
    else {
      const ground = g.collision.groundAt(s.x, s.z, s.y + 0.6, 1.2);
      exact = Number.isFinite(ground) && Math.abs(ground - s.y) < 1.5 && !g.terrain.isWater(s.x, s.z, 0);
      if (exact) s = { ...s, y: Math.max(s.y, ground) };
    }
    if (exact) P.pos.set(s.x, s.y + 0.05, s.z);
    else {
      const sp = g.map.placeSafely(s.x, s.z);
      console.log(`[saves] the saved spot (${s.under ? 'underground' : s.indoors ? 'indoors' : 'street'}) could not be restored exactly: placed at ${sp.x.toFixed(0)}, ${sp.z.toFixed(0)}`);
    }
  }

  // ------------------------------------------------------------------ console

  private installDev(): void {
    const w = window as unknown as { dev?: Record<string, unknown> };
    w.dev ??= {};
    w.dev.save = {
      /** Save now under a name (default "Quick save"). */
      now: (name = 'Quick save') => this.save(name),
      auto: () => this.autosave('console'),
      list: async () => (await saveStore.list()).map((m) => ({ id: m.id, name: m.name, city: m.city, mode: m.mode, day: m.day, hour: +m.hour.toFixed(2), created: new Date(m.created).toISOString(), playTime: m.playTime, kB: +((m.bytes ?? 0) / 1000).toFixed(1) })),
      load: async (id: string = 'latest') => { const m = id === 'latest' ? await saveStore.latest() : { id }; return m ? this.load(m.id) : 'no saves'; },
      latest: () => saveStore.latest(),
      get: (id: string) => saveStore.get(id),
      remove: (id: string) => saveStore.remove(id),
      capture: () => this.capture('manual', 'capture', 'capture'),
      /** Sizes of the save as it is now: JSON, with and without the city damage. */
      sizes: () => {
        const d = this.capture('manual', 'size', 'size');
        const all = serializeSave(d).length, bare = serializeSave({ ...d, damage: null }).length;
        return { json: all, withoutDamage: bare, damage: all - bare, damagedCells: d.damage?.cells.length ?? 0, collapsed: d.damage?.buildings.length ?? 0, mounds: d.damage?.mounds.length ?? 0, lastStored: saveStore.lastBytes, lastRaw: saveStore.lastRawBytes };
      },
      status: () => ({ status: this.status, lastSaved: this.lastSaved ? new Date(this.lastSaved).toISOString() : null, agoS: this.lastSaved ? Math.round((Date.now() - this.lastSaved) / 1000) : null, playTime: Math.round(this.playTime), nextAutoS: Math.round(this.autoT), loadedFrom: this.loadedFrom }),
      parse: parseSave,
    };
  }
}

/** URL that starts the save's city with the save. Test flags (mute, auto) are kept. */
export function loadUrl(d: { id: string; city: { seed: number; size: number }; mode: string }): string {
  const cur = new URLSearchParams(location.search);
  const q = new URLSearchParams();
  q.set('seed', String(d.city.seed));
  q.set('size', String(d.city.size));
  q.set('mode', d.mode);
  q.set('load', d.id);
  for (const k of ['mute']) if (cur.has(k)) q.set(k, cur.get(k) ?? '');
  return `${location.pathname}?${q.toString().replace(/=(&|$)/g, '$1')}`;
}

/** Same name → same id (overwrite). */
export function manualId(name: string): string {
  let h = 2166136261;
  const s = name.trim().toLowerCase();
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `save-${(h >>> 0).toString(36)}`;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
