/**
 * Background music in the game: reads the game state (MusicSignals), lets the MoodDirector
 * choose the mood (mood.ts), picks the piece (tracks.ts) and drives the TrackPlayer.
 *
 * Cues play over the moods (the mood music fades while one runs):
 *   victory   a threat the music was fighting ends beaten near the player (the fight settles at once)
 *   rescue    the drones carry the defeated hero to the hospital
 *   gameover  the game over screen
 *   origin    the origin scene, its impact on the scene's; it plays out into the first seconds of
 *             the game (cut short when the scene is skipped)
 *
 * Level: the 'music' category of the sound mix (pause menu), under the master volume
 * and mute; the Music switch in the pause menu turns it off. Opening the pause menu ducks it.
 *
 * Dev (console): dev.music.status(), dev.music.mood('battle' | 'tension' | 'day' | … | null),
 * dev.music.auto(), dev.music.play() (a calm episode now), dev.music.rest(), dev.music.cue('victory'),
 * dev.music.test(true) (run the music even with ?mute — silent there, but loading and mixing can be checked).
 */
import type { Game } from '../../game/Game';
import { G } from '../../render/materials/globals';
import { boundaryAt } from '../../world/boundary';
import { BOSS_OP_KINDS, type CrimeKind } from '../../game/crime/Crime';
import { OriginIntro } from '../../game/intro/OriginIntro';
import { MoodDirector, MOODS, MOOD_FADE, LOOPED, CALM_SIGNALS, type Mood, type MusicSignals, type MoodOut } from './mood';
import { TrackPlayer, type TrackWant } from './TrackPlayer';
import { MOOD_TRACKS, CUES, ORIGIN_IMPACT, TENSION_HIGH, TENSION_HIGH_ON, TENSION_HIGH_OFF, type Cue } from './tracks';

const BASE = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
/** The pieces are mastered loud (normalised to −16 LUFS): this sits them under the game's sounds. */
const MUSIC_LEVEL = 0.55;
/** Crime kinds that are a villain's set piece (their own theme). */
const VILLAIN_KINDS: ReadonlySet<CrimeKind> = new Set<CrimeKind>([...BOSS_OP_KINDS, 'ritual', 'raising', 'procession']);
/** Out of town: this far past the city's edge (m), and back in this close. */
const COUNTRY_ON = 250, COUNTRY_OFF = 120;

export class Music {
  readonly director = new MoodDirector();
  readonly player = new TrackPlayer(BASE);
  last: MoodOut = { mood: null, intensity: 0, why: 'start' };
  signals: MusicSignals | null = null;
  /** Dev: run even when muted (for headless tests with ?mute). */
  ignoreMute = false;
  /** The cue playing (over the moods), when it began (s since), and whether it may go on. */
  cue: { cue: Cue; t: number; offset: number; dev: boolean } | null = null;
  private devDone = false;
  /** The piece chosen for the mood playing now (the mood's pieces take turns). */
  private pick: { mood: Mood; id: string } | null = null;
  private turn: Partial<Record<Mood, number>> = {};
  private high = false;
  private country = false;
  /** Threat events the music saw running (a victory is one of them ending beaten). */
  private running = new Set<object>();
  private rescueSeen = false;
  private overSeen = false;
  private originDone = false;

  constructor(private g: Game) {
    this.player.level = MUSIC_LEVEL;
  }

  update(dt: number): void {
    if (!this.devDone) this.installDev();
    const a = this.g.audio;
    const out = a.musicOut();
    if (!out) return;
    if (!this.player.attached) this.player.attach(out.ctx, out.out);
    dt = Math.min(dt, 0.25);
    const s = this.probe();
    this.signals = s;
    this.cues(dt, s);
    this.last = this.director.update(dt, s);
    const on = a.musicOn && a.mix.music > 0 && ((!a.muted && a.volume > 0) || this.ignoreMute);
    const want = on ? this.want() : { id: null, fadeIn: 1, fadeOut: 3, level: 0 };
    this.player.update(dt, want, { duck: this.g.menu?.paused ? 0.35 : 1, rain: s.rain });
    // A calm piece (or an elegy) played to its end: rest until the next episode.
    if (this.pick && !LOOPED.has(this.pick.mood) && !this.cue && this.player.ended(this.pick.id)) {
      this.director.endEpisode();
      this.pick = null;
    }
  }

  /** The piece to play now: a cue, else the mood's piece. */
  private want(): TrackWant {
    if (this.cue) {
      const c = CUES[this.cue.cue];
      return { id: c.track, fadeIn: c.fadeIn, fadeOut: 2, level: c.level, offset: this.cue.offset };
    }
    const m = this.last.mood;
    if (!m) { this.pick = null; return { id: null, fadeIn: 1, fadeOut: this.fadeOutNow(), level: 0 }; }
    const f = MOOD_FADE[m];
    if (m === 'tension') {
      const I = this.last.intensity;
      this.high = this.high ? I > TENSION_HIGH_OFF : I > TENSION_HIGH_ON;
    } else this.high = false;
    if (this.pick?.mood !== m) {
      const list = MOOD_TRACKS[m];
      const n = this.turn[m] ?? Math.floor(Math.random() * list.length);
      this.turn[m] = n + 1;
      this.pick = { mood: m, id: list[n % list.length] };
      // The fight may come next: get its loop ready.
      if (m === 'tension') { this.player.prepare(MOOD_TRACKS.battle[(this.turn.battle ?? 0) % 2]); this.player.prepare('victory'); }
      if (m === 'battle' || m === 'villain' || m === 'slime') this.player.prepare('victory');
    }
    const id = this.high ? TENSION_HIGH : this.pick.id;
    return { id, fadeIn: f.fadeIn, fadeOut: this.fadeOutNow(m), level: f.level };
  }

  /** How fast what plays now gives way (to `next`, or to silence). */
  private fadeOutNow(next?: Mood): number {
    const cur = this.pick?.mood;
    const out = cur ? MOOD_FADE[cur].fadeOut : 4;
    return next ? Math.min(out, MOOD_FADE[next].fadeIn * 1.5 + 0.5) : out;
  }

  /** Start and end the cues. */
  private cues(dt: number, s: MusicSignals): void {
    const g = this.g;
    if (this.cue) {
      this.cue.t += dt;
      const c = this.cue.cue;
      const done = this.player.ended(CUES[c].track) && this.player.current === CUES[c].track;
      const phase = g.defeat?.phase ?? 'idle';
      const intro = g.intro;
      // A cue ends with its piece, or when what it plays for is over.
      const over = done || (!this.cue.dev && (
        (c === 'rescue' && !['down', 'inbound', 'lift', 'flight', 'arrive'].includes(phase))
        || (c === 'gameover' && phase !== 'over')
        || (c === 'origin' && !intro?.active && this.cue.t < OriginIntro.END - OriginIntro.IMPACT + ORIGIN_IMPACT - 1.5)))
        || this.cue.t > 180;
      if (over) {
        this.cue = null;
        if (c !== 'victory') this.director.hushNow();
      }
    }
    // The origin scene: the piece's impact on the scene's (it may start a little in, if the scene runs ahead).
    const intro = g.intro;
    if (intro?.active && !this.originDone) {
      const at = intro.time - (OriginIntro.IMPACT - ORIGIN_IMPACT);
      if (at > -6) this.player.prepare(CUES.origin.track);
      if (at >= 0) { this.originDone = true; this.start('origin', at); }
    }
    // Defeat: the rescue flight, or the game over screen.
    const phase = g.defeat?.phase ?? 'idle';
    const rescuing = phase === 'inbound' || phase === 'lift' || phase === 'flight';
    if (rescuing && !this.rescueSeen) this.start('rescue');
    this.rescueSeen = rescuing || (this.rescueSeen && phase !== 'idle' && phase !== 'ward' && phase !== 'leaving');
    const over = phase === 'over' && !!g.defeat?.ui.gameOverShown;
    if (over && !this.overSeen) this.start('gameover');
    this.overSeen = over;
    // Victory: a threat the music was fighting ends beaten near the player.
    const p = g.player.pos;
    const seen = new Set<object>();
    for (const ev of g.threats?.events ?? []) {
      if (ev.active) { seen.add(ev); continue; }
      if (!this.running.has(ev) || ev.archetype === 'rampage') continue;
      const won = ev.outcome === 'defeated' || ev.outcome === 'stopped';
      const d = Math.hypot(ev.x - p.x, ev.z - p.z) - ev.radius;
      if (won && d < (ev.tier === 'major' ? 700 : 250) && this.director.level >= 1 && !this.cue) {
        this.start('victory');
        this.director.settle(s);
      }
    }
    this.running = seen;
  }

  /** Play a cue now (over the mood music). */
  private start(cue: Cue, offset = 0, dev = false): void {
    if (this.cue && this.cue.cue === cue) return;
    this.cue = { cue, t: offset, offset, dev };
    this.pick = null;
  }

  /** The game state the music listens to (every part optional: systems may not exist yet). */
  probe(): MusicSignals {
    const g = this.g;
    const p = g.player.pos;
    const s: MusicSignals = { ...CALM_SIGNALS };
    try {
      s.under = !!g.camRig?.underground;
      s.halls = !!g.world?.landmarks?.insideAt(p.x, p.y + 1, p.z);
      s.aliens = !!g.wardens?.visitingNear(p.x, p.z);
      if (g.macro) {
        const out = Math.hypot(p.x, p.z) - boundaryAt(g.macro.boundary, p.x, p.z);
        this.country = this.country ? out > COUNTRY_OFF : out > COUNTRY_ON;
        s.country = this.country;
      }
      s.night = G.uNight.value;
      s.rain = g.weather?.p.rain ?? 0;
      s.hush = !!g.intro?.active || !!g.freeCam || g.defeat?.phase === 'revive' || g.defeat?.phase === 'over';
      s.flySpeed = g.player.flying ? g.player.vel.length() / Math.sqrt(Math.max(0.05, g.player.k)) : 0;
      // Threats: the Strider (major) anywhere near is tension, close is battle; robots near are tension,
      // a full fight with them (the response escalated) is battle.
      const resp = g.response;
      for (const ev of g.threats?.events ?? []) {
        if (!ev.active) continue;
        const d = Math.hypot(ev.x - p.x, ev.z - p.z) - ev.radius;
        if (ev.tier === 'major') {
          if (d < 450) s.battle = 1;
          else if (d < 1600) s.danger = Math.max(s.danger, 1);
        } else {
          if (d < 160) s.danger = Math.max(s.danger, d < 60 ? 1 : 0.7);
          if (d < 40 && (resp?.level ?? 0) >= 2) s.battle = Math.max(s.battle, 0.7);
        }
      }
      // The war under the city: a Murk on the player, a raid at the Front, the Maw.
      const sr = g.slimeRealm?.music;
      if (sr) { s.danger = Math.max(s.danger, sr.danger); s.battle = Math.max(s.battle, sr.battle); s.slime = sr.battle > 0.5; }
      const lr = g.aftermath?.lastResort.state;
      if (lr === 'countdown') s.battle = 1;
      // Crime: a robbery or mugging under way near the player; the police after the player;
      // a boss's operation or a cult's rite close by (the villain's theme).
      const crime = g.crime;
      if (crime) {
        for (const c of crime.crimes) {
          if (!c.active || !c.committed) continue;
          const d = Math.hypot(c.x - p.x, c.z - p.z);
          if (VILLAIN_KINDS.has(c.kind) && d < 160) { s.villain = true; s.danger = 1; }
          else if (d < 90) s.danger = Math.max(s.danger, c.phase === 'getaway' || c.phase === 'escape' ? 1 : 0.6);
        }
        if (crime.justice.wanted > 0) s.danger = Math.max(s.danger, crime.justice.wanted >= 2 ? 1 : 0.6);
      }
      // Aftermath: people still waiting for help near the player, or a struck district.
      const A = g.aftermath;
      if (A) {
        const c = A.ledger.c;
        s.grief = lr === 'strike' || (c.injured + c.trapped > 0 && A.rescueArea(p.x, p.z));
      }
    } catch { /* a system missing or mid-rebuild: keep what was read */ }
    return s;
  }

  private installDev(): void {
    const dev = (window as unknown as { dev?: Record<string, unknown> }).dev;
    if (!dev) return;
    this.devDone = true;
    const D = this.director;
    dev.music = {
      music: this,
      /** Mood, why, signals, cue, decks. */
      status: () => ({ ...this.last, level: D.level, phase: D.phase, left: Math.round(D.left), forced: D.forced, cue: this.cue, pick: this.pick, high: this.high, signals: this.signals, player: this.player.status() }),
      /** Force a mood (see MOODS), null = silence … use auto() to go back. */
      mood: (m: Mood | null) => {
        if (m !== null && !MOODS.includes(m)) return `moods: ${MOODS.join(', ')}`;
        D.forced = m;
        if (m === null) { D.forced = null; D.hushNow(); }
        return m;
      },
      auto: () => { D.forced = null; return 'auto'; },
      play: () => { D.forced = null; D.play(); return D.calm; },
      rest: () => { D.forced = null; D.hushNow(); return Math.round(D.left); },
      /** Play a cue now ('victory' | 'rescue' | 'gameover' | 'origin'). */
      cue: (c: Cue = 'victory') => { if (!CUES[c]) return `cues: ${Object.keys(CUES).join(', ')}`; this.cue = null; this.start(c, 0, true); return c; },
      test: (on = true) => { this.ignoreMute = on; return on; },
    };
  }
}
