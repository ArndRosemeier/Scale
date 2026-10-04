/**
 * Background music in the game: reads the game state (MusicSignals), lets the
 * MoodDirector choose what plays (mood.ts) and drives the StemPlayer.
 *
 * Level: the 'music' category of the sound mix (pause menu), under the master volume
 * and mute; the Music switch in the pause menu turns it off. Opening the pause menu ducks it.
 *
 * Dev (console): dev.music.status(), dev.music.mood('battle' | 'tension' | 'day' | … | null),
 * dev.music.auto(), dev.music.play() (a calm episode now), dev.music.rest(), dev.music.test(true)
 * (run the music even with ?mute — still silent there, but loading and mixing can be checked).
 */
import type { Game } from '../../game/Game';
import { G } from '../../render/materials/globals';
import { MoodDirector, MOODS, type Mood, type MusicSignals, type MoodOut } from './mood';
import { StemPlayer } from './StemPlayer';

const BASE = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';

export class Music {
  readonly director = new MoodDirector();
  readonly player = new StemPlayer(BASE);
  last: MoodOut = { mood: null, intensity: 0, why: 'start' };
  signals: MusicSignals | null = null;
  /** Dev: run even when muted (for headless tests with ?mute). */
  ignoreMute = false;
  private devDone = false;

  constructor(private g: Game) {}

  update(dt: number): void {
    if (!this.devDone) this.installDev();
    const a = this.g.audio;
    const out = a.musicOut();
    if (!out) return;
    if (!this.player.attached) this.player.attach(out.ctx, out.out);
    dt = Math.min(dt, 0.25);
    const s = this.probe();
    this.signals = s;
    this.last = this.director.update(dt, s);
    const on = a.musicOn && a.mix.music > 0 && ((!a.muted && a.volume > 0) || this.ignoreMute);
    this.player.update(dt, on ? this.last.mood : null, this.last.intensity, {
      duck: this.g.menu?.paused ? 0.35 : 1,
      rain: s.rain,
    });
  }

  /** The game state the music listens to (every part optional: systems may not exist yet). */
  probe(): MusicSignals {
    const g = this.g;
    const p = g.player.pos;
    const s: MusicSignals = { under: false, night: 0, rain: 0, danger: 0, battle: 0, grief: false, flySpeed: 0, hush: false };
    try {
      s.under = !!g.camRig?.underground;
      s.night = G.uNight.value;
      s.rain = g.weather?.p.rain ?? 0;
      s.hush = !!g.intro?.active || !!g.freeCam;
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
      const lr = g.aftermath?.lastResort.state;
      if (lr === 'countdown') s.battle = 1;
      // Crime: a robbery or mugging under way near the player; the police after the player.
      const crime = g.crime;
      if (crime) {
        for (const c of crime.crimes) {
          if (!c.active || !c.committed) continue;
          const d = Math.hypot(c.x - p.x, c.z - p.z);
          if (d < 90) s.danger = Math.max(s.danger, c.phase === 'getaway' || c.phase === 'escape' ? 1 : 0.6);
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
      /** Mood, why, signals, slots and layer gains, loaded stems. */
      status: () => ({ ...this.last, level: D.level, phase: D.phase, left: Math.round(D.left), forced: D.forced, signals: this.signals, player: this.player.status() }),
      /** Force a mood ('day' | 'night' | 'under' | 'hero' | 'tension' | 'battle' | 'elegy' | 'menu'), null = silence… use auto() to go back. */
      mood: (m: Mood | null) => {
        if (m !== null && !MOODS.includes(m)) return `moods: ${MOODS.join(', ')}`;
        D.forced = m;
        if (m === null) { D.forced = null; D.hushNow(); }
        return m;
      },
      auto: () => { D.forced = null; return 'auto'; },
      play: () => { D.forced = null; D.play(); return D.calm; },
      rest: () => { D.forced = null; D.hushNow(); return Math.round(D.left); },
      test: (on = true) => { this.ignoreMute = on; return on; },
    };
  }
}
