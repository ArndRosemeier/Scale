/**
 * The city's own life and how the hero hears of it (game/news/pulse.ts for the rules): the live
 * crime index of every block and neighbourhood, crime away from the player, police presence by
 * area, and the news — on the billboards (future/newsArt cards in the slide shows), in what
 * passers-by say (ui/Barks via People.chatLine) and in the talk menu's "news" topic, on the map
 * (the crime layer, neighbourhood names, the hover line) and as a line when the hero walks into
 * another neighbourhood.
 *
 * Saved: the index's differences from the seeded one, the recent news, the tick counter.
 */
import type { Game } from '../Game';
import { crimeIndex } from '../crime/CrimeIndex';
import type { Crime } from '../crime/Crime';
import { ARCHETYPES } from '../factions/archetypes';
import { NewsArt, NEWS_CARDS, type NewsCard } from '../../future/newsArt';
import {
  planHoods, LiveIndex, LIVE, PULSE, rollOffScreen, policePresence, policeCarWeight, safetyOf, SAFETY_LABEL, presenceLabel,
  type Hoods, type Safety,
} from './pulse';
import { headline, gossip, localRemark, storyKind, whenWord, type NewsEnd, type NewsItem, type NewsWhat } from './headlines';

/** Recent news kept (and saved). */
const KEEP = 32;
/** Seconds between two map refreshes while the index moves. */
const MAP_REFRESH = 12;

export interface SavedNews { live: [number, number][]; news: NewsItem[]; tick: number }

export class CityNews {
  readonly hoods: Hoods;
  readonly base: Float32Array;
  readonly live: LiveIndex;
  /** Recent news, oldest first. */
  news: NewsItem[] = [];
  readonly art: NewsArt | null;
  private tick = 0;
  private acc = 0;
  private relaxAcc = 0;
  private mapT = 0;
  private mapDirty = false;
  private cardsT = 0;
  /** Each neighbourhood's safety band when last told (trend news). */
  private bands: Safety[];
  /** The neighbourhood the hero is in (-2: not looked yet — the first one is not told). */
  private hereHood = -2;
  private hereT = 0;
  /** Photos posted to the billboards (press shots of the hero …), newest last, until a game hour. */
  private photos: { card: NewsCard; until: number }[] = [];
  private photoN = 0;
  stats = { ticks: 0, offCrimes: 0, offStopped: 0, near: 0 };

  constructor(private g: Game) {
    const seed = g.settings.seed;
    this.base = crimeIndex(g.macro, seed);
    this.hoods = planHoods(g.macro, seed);
    this.live = new LiveIndex(this.base, this.hoods.near);
    this.bands = this.hoods.list.map((h) => safetyOf(this.hoodIndex(h.id)));
    let art: NewsArt | null = null;
    try { art = new NewsArt(); } catch (e) { console.warn('[news] no billboard cards', e); }
    this.art = art;
    g.traffic.policeWeight = (x, z) => policeCarWeight(this.presenceAt(x, z));
    g.map.hoodInfo = (x, z) => this.hoodLine(x, z);
    this.syncMapHoods();
  }

  /** A fresh game: the start cell's neighbourhood is held down to the start cap. */
  freshStart(cell: number): void {
    const h = cell >= 0 ? this.hoods.of[cell] : -1;
    const cells = h >= 0 ? this.hoods.list[h].cells : cell >= 0 ? [cell] : [];
    for (const i of [...cells, ...(cell >= 0 ? this.hoods.near[cell] : [])]) if (this.base[i] > 0) this.live.live[i] = Math.min(this.live.live[i], LIVE.startCap);
    this.bands = this.hoods.list.map((x) => safetyOf(this.hoodIndex(x.id)));
    this.mapDirty = true;
  }

  // ------------------------------------------------------------------ queries

  cellAt(x: number, z: number): number { return this.g.crime ? this.g.crime.cellAt(x, z) : -1; }

  indexAt(x: number, z: number): number {
    const i = this.cellAt(x, z);
    return i < 0 ? 0.3 : this.live.live[i];
  }

  /** Police presence at a point (0..1). */
  presenceAt(x: number, z: number): number { return policePresence(this.indexAt(x, z)); }

  hoodIndex(h: number): number {
    const cells = this.g.macro.cells;
    return this.live.mean(this.hoods.list[h].cells, (i) => cells[i].area);
  }

  hoodAt(x: number, z: number): number {
    const i = this.cellAt(x, z);
    return i < 0 ? -1 : this.hoods.of[i];
  }

  /** The map's hover line for a point: "Mill Quarter — crime low · strong police presence". */
  hoodLine(x: number, z: number): string | null {
    const h = this.hoodAt(x, z);
    if (h < 0) return null;
    const v = this.hoodIndex(h);
    return `${this.hoods.list[h].name} — crime ${SAFETY_LABEL[safetyOf(v)].toLowerCase()} · ${presenceLabel(policePresence(v))} police presence`;
  }

  // ------------------------------------------------------------------ what happened

  /** A crime near the player ended (CrimeSystem): the index moves, the news has it. */
  crimeEnded(c: Crime, hero: boolean): void {
    if (c.outcome === 'aborted' || c.kind === 'hideout' || c.kind === 'den') return;
    const cell = this.cellAt(c.x, c.z);
    if (cell < 0) return;
    this.stats.near++;
    const escaped = c.outcome === 'escaped';
    this.live.bump(cell, escaped ? LIVE.escaped : hero ? LIVE.heroStopped : LIVE.arrested);
    const f = c.faction >= 0 ? this.g.crime.factions.factions[c.faction] : null;
    this.push({ what: c.kind, hood: this.hoodName(cell), end: escaped ? 'escaped' : hero ? 'hero' : 'stopped', t: this.g.sky.hoursAbs, ...(f ? { group: f.name } : {}) });
    this.mapDirty = true;
  }

  /** A group's boss was jailed: their streets calm down. */
  bossJailed(faction: number): void {
    const F = this.g.crime.factions;
    for (let i = 0; i < F.holder.length; i++) if (F.holder[i] === faction) this.live.bump(i, LIVE.bossJailed / (1 + LIVE.spread * 3));
    this.mapDirty = true;
  }

  /** A group took a street (turf news, off-screen or near). */
  turfTaken(cell: number, faction: number): void {
    const f = this.g.crime?.factions.factions[faction];
    if (!f || cell < 0) return;
    const hood = this.hoodName(cell);
    // Once per neighbourhood and group in a while.
    if (this.news.some((n) => n.what === 'turf' && n.hood === hood && n.group === f.name && this.g.sky.hoursAbs - n.t < 12)) return;
    this.push({ what: 'turf', hood, end: 'none', t: this.g.sky.hoursAbs, group: f.name });
  }

  /**
   * Something another system made news of at a point (the glowing stone found …): on the
   * billboards and in what people say. Returns the neighbourhood's name.
   */
  report(what: NewsWhat, x: number, z: number, end: NewsEnd = 'none'): string {
    const h = this.hoodAt(x, z);
    const hood = h >= 0 ? this.hoods.list[h].name : 'the city';
    this.push({ what, hood, end, t: this.g.sky.hoursAbs });
    this.cardsT = 0;
    return hood;
  }

  private hoodName(cell: number): string {
    const h = this.hoods.of[cell];
    return h >= 0 ? this.hoods.list[h].name : 'the city';
  }

  private push(it: NewsItem): void {
    this.news.push(it);
    if (this.news.length > KEEP) this.news.splice(0, this.news.length - KEEP);
  }

  /**
   * Put a photo with a caption on the billboards (another system's news: a reporter's shot of the
   * hero …): it leads the cards for `hours` game hours (at most two photos at once, the newest).
   * `image`: a canvas or a loaded image; it is drawn once, so it may be reused afterwards.
   */
  postPhoto(image: CanvasImageSource & { width: number; height: number }, caption: string, sub = '', hours = 3): void {
    const now = this.g.sky.hoursAbs;
    const h = this.hoodAt(this.g.player.pos.x, this.g.player.pos.z);
    const card: NewsCard = { kind: 'photo', head: caption.slice(0, 120), sub: sub || (h >= 0 ? `${this.hoods.list[h].name} · just now` : 'just now'), image, imageKey: `p${++this.photoN}` };
    this.photos.push({ card, until: now + Math.max(0.1, hours) });
    if (this.photos.length > 2) this.photos.shift();
    this.cardsT = 0;
  }

  // ------------------------------------------------------------------ talk

  /** A line for a passer-by: city gossip or a word about these streets (null: their own small talk). */
  chatLine(x: number, z: number, u = Math.random()): string | null {
    const now = this.g.sky.hoursAbs;
    const recent = this.news.filter((n) => now - n.t < 30);
    if (recent.length && u < 0.55) {
      // Big things, the hero's deeds and the nearby neighbourhoods first.
      const here = this.hoodAt(x, z), hereName = here >= 0 ? this.hoods.list[here].name : '';
      const w = recent.map((n) => (n.end === 'hero' ? 3 : 1) * (n.hood === hereName ? 2 : 1) * (n.what === 'bomber' || n.what === 'hijack' || n.what === 'ritual' ? 1.6 : 1) / (1 + (now - n.t) / 6));
      const tot = w.reduce((s, v) => s + v, 0);
      let t = Math.random() * tot;
      for (let i = 0; i < recent.length; i++) { t -= w[i]; if (t <= 0) return gossip(recent[i], now, Math.random()); }
      return gossip(recent[recent.length - 1], now, Math.random());
    }
    if (u < 0.8) return localRemark(safetyOf(this.indexAt(x, z)), Math.random());
    return null;
  }

  /** Talk facts: something heard lately (a full sentence) and how safe these streets are. */
  talkFacts(x: number, z: number, seed: number): { heard: string | null; hood: string | null; safety: Safety } {
    const now = this.g.sky.hoursAbs;
    const recent = this.news.filter((n) => now - n.t < 48);
    const h = this.hoodAt(x, z);
    const it = recent.length ? recent[(seed >>> 0) % recent.length] : null;
    return { heard: it ? gossip(it, now, ((seed >>> 8) % 1000) / 1000) : null, hood: h >= 0 ? this.hoods.list[h].name : null, safety: safetyOf(this.indexAt(x, z)) };
  }

  // ------------------------------------------------------------------ frame

  update(dt: number): void {
    const g = this.g;
    if (!g.crime) return;
    const F = g.crime.factions;
    // Relax toward the targets (a few times a minute).
    this.relaxAcc += dt;
    if (this.relaxAcc >= 5) {
      const held = (i: number) => F.holder[i] >= 0 && !g.crime.collapsed(F.holder[i]);
      this.live.relax(this.relaxAcc, held);
      this.relaxAcc = 0;
    }
    // Off-screen crime.
    this.acc += dt;
    if (this.acc >= PULSE.tick) {
      this.acc -= PULSE.tick;
      this.pulse();
    }
    this.watchHood(dt);
    // The map follows the index (not every frame: the tiles are redrawn).
    this.mapT -= dt;
    if (this.mapDirty && this.mapT <= 0) {
      this.mapT = MAP_REFRESH;
      this.mapDirty = false;
      g.map.tiles.invalidate();
      this.syncMapHoods();
    }
    // The billboards' cards.
    this.cardsT -= dt;
    if (this.cardsT <= 0 && this.art) {
      this.cardsT = 6;
      this.updateCards();
    }
  }

  private pulse(): void {
    const g = this.g, F = g.crime.factions, p = g.player.pos;
    this.tick++;
    this.stats.ticks++;
    const holder = (i: number) => {
      const f = F.holder[i];
      if (f < 0 || g.crime.collapsed(f)) return null;
      return { faction: f, ops: ARCHETYPES[F.factions[f].archetype].kinds };
    };
    const list = rollOffScreen(g.settings.seed, this.tick, this.hoods, this.live, g.macro, g.sky.hour, g.crime.setting, p.x, p.z, holder);
    for (const c of list) {
      this.stats.offCrimes++;
      if (c.stopped) this.stats.offStopped++;
      this.live.bump(c.cell, c.stopped ? LIVE.offStopped : LIVE.offEscaped);
      // Not every one makes the news: the stopped ones and the bigger ones mostly do.
      const big = c.kind === 'robbery' || c.kind === 'bomber' || c.kind === 'hijack' || c.kind === 'ritual' || c.kind === 'brawl';
      if (big || c.stopped || Math.random() < 0.45) {
        const f = c.faction >= 0 ? F.factions[c.faction] : null;
        this.push({ what: c.kind, hood: this.hoods.list[c.hood].name, end: c.stopped ? 'stopped' : 'escaped', t: g.sky.hoursAbs, ...(f ? { group: f.name } : {}) });
      }
    }
    if (list.length) this.mapDirty = true;
    // Trends: a neighbourhood that changed its band.
    this.hoods.list.forEach((h, k) => {
      const b = safetyOf(this.hoodIndex(k)), was = this.bands[k];
      if (b === was) return;
      const order: Safety[] = ['safe', 'quiet', 'mixed', 'rough', 'dangerous'];
      const up = order.indexOf(b) > order.indexOf(was);
      this.bands[k] = b;
      this.push({ what: up ? 'rising' : 'falling', hood: h.name, end: 'none', t: g.sky.hoursAbs });
      this.mapDirty = true;
    });
  }

  /** Walking into another neighbourhood: its name, crime level and police presence. */
  private watchHood(dt: number): void {
    this.hereT -= dt;
    if (this.hereT > 0) return;
    this.hereT = 1.5;
    const g = this.g, p = g.player.pos;
    if (g.camRig?.underground) return;
    const h = this.hoodAt(p.x, p.z);
    if (h === this.hereHood) return;
    const first = this.hereHood === -2;
    this.hereHood = h;
    if (h < 0 || first || g.intro) return;
    const v = this.hoodIndex(h), s = safetyOf(v);
    const col = s === 'safe' || s === 'quiet' ? '#4ade80' : s === 'mixed' ? '#facc15' : '#f87171';
    g.powerHud.toast(`<b>${this.hoods.list[h].name}</b> · crime <b style="color:${col}">${SAFETY_LABEL[s].toLowerCase()}</b> · ${presenceLabel(policePresence(v))} police presence`, s === 'rough' || s === 'dangerous' ? 'warn' : 'info', 3600);
  }

  private updateCards(): void {
    const g = this.g, p = g.player.pos, now = g.sky.hoursAbs;
    const h = this.hoodAt(p.x, p.z);
    const areaCard = (): NewsCard | null => {
      if (h < 0) return null;
      const v = this.hoodIndex(h), s = safetyOf(v);
      return { kind: 'area', head: `${this.hoods.list[h].name}: crime ${SAFETY_LABEL[s].toLowerCase()}`, sub: `${presenceLabel(policePresence(v))} police presence`.replace(/^./, (c) => c.toUpperCase()), level: Math.min(1, v / 0.8) };
    };
    this.photos = this.photos.filter((p) => p.until > now);
    const photos = this.photos.map((p) => p.card).reverse();
    // Newest first, one card per headline.
    const seen = new Set<string>(), items: NewsItem[] = [];
    for (let i = this.news.length - 1; i >= 0 && items.length < NEWS_CARDS - 1 - photos.length; i--) {
      const n = this.news[i];
      if (now - n.t >= 36 || seen.has(headline(n))) continue;
      seen.add(headline(n));
      items.push(n);
    }
    const cards: NewsCard[] = [...photos, ...items.map((n) => ({ kind: storyKind(n), head: headline(n), sub: `${n.hood} · ${whenWord(n.t, now)}` }))];
    const a = areaCard();
    if (a) cards.push(a);
    this.art!.set(cards);
    g.future.signs.cards(this.art!.texture, this.art!.count);
  }

  private syncMapHoods(): void {
    this.g.map.hoods = this.hoods.list.map((h) => ({ x: h.x, z: h.z, name: h.name, index: this.hoodIndex(h.id) }));
  }

  // ------------------------------------------------------------------ saves

  save(): SavedNews {
    return { live: this.live.save(), news: this.news.slice(-24).map((n) => ({ ...n, t: Math.round(n.t * 100) / 100 })), tick: this.tick };
  }

  restore(d: unknown): void {
    const o = (d && typeof d === 'object' ? d : {}) as Partial<SavedNews>;
    this.live.restore(o.live ?? null);
    this.tick = Number.isInteger(o.tick) ? (o.tick as number) : 0;
    const ok = (n: unknown): n is NewsItem => {
      const x = n as NewsItem;
      return !!x && typeof x.what === 'string' && typeof x.hood === 'string' && typeof x.end === 'string' && Number.isFinite(x.t) && (x.group === undefined || typeof x.group === 'string');
    };
    this.news = Array.isArray(o.news) ? o.news.filter(ok).slice(-KEEP).map((n) => ({ what: n.what, hood: n.hood.slice(0, 60), end: n.end, t: n.t, ...(n.group ? { group: n.group.slice(0, 60) } : {}) })) : [];
    this.bands = this.hoods.list.map((h) => safetyOf(this.hoodIndex(h.id)));
    this.hereHood = -2;
    this.mapDirty = true;
    this.mapT = 0;
  }
}
