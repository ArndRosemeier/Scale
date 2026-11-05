/**
 * Important speech bubbles (GAME_MASTER_PLAN §3.3): what someone tells the hero that belongs in
 * the tracker. It must stand out from the street's chatter, so several things happen at once:
 * the bubble has a coloured edge with the thread's emblem (ui/Barks `story`), it stays up longer,
 * a soft chime only these bubbles use plays (Story.say), the speaker turns to the hero and points,
 * and walking up to them again has them say it once more.
 */
import type { Game } from '../Game';
import type { VoiceAnchor } from '../../ui/voices';
import type { Actor } from '../../sim/actors/Actor';

/** A person (or anything with a position) saying the line; `actor` turns to the hero. */
export type StoryAnchor = VoiceAnchor & { actor?: Actor | null };

/** Said again when the hero comes this close (m), within this long (s) after it was first said. */
const AGAIN_R = 5, AGAIN_FOR = 120;

interface Said { a: StoryAnchor; line: string; color: string; glyph: string; t: number; again: number; away: boolean }

/** The bubble now; false when it could not be shown (off screen, no bubbles in headless runs). */
export function sayStory(g: Game, a: StoryAnchor, line: string, color: string, glyph: string): boolean {
  const shown = g.barks?.story(a, line, color, glyph) ?? false;
  turnToHero(g, a);
  STORY_SAY.remember(a, line, color, glyph);
  return shown;
}

function turnToHero(g: Game, a: StoryAnchor): void {
  const act = a.actor;
  if (!act || act.state === 'down' || act.state === 'ko' || act.state === 'gone') return;
  const P = g.player.pos;
  act.face = { x: P.x, y: P.y + g.player.height * 0.9, z: P.z };
  if (act.state !== 'arrested' && !act.action) act.action = { id: 'gesture_point', age: 0, dur: 1.6 };
}

class StorySay {
  private said: Said[] = [];
  private t = 0;

  remember(a: StoryAnchor, line: string, color: string, glyph: string): void {
    this.said = this.said.filter((s) => s.a !== a);
    this.said.push({ a, line, color, glyph, t: this.t, again: 1, away: false });
    if (this.said.length > 6) this.said.shift();
  }

  update(g: Game, dt: number): void {
    this.t += dt;
    if (!this.said.length) return;
    const P = g.player.pos;
    for (let i = this.said.length - 1; i >= 0; i--) {
      const s = this.said[i];
      if (this.t - s.t > AGAIN_FOR || s.a.alive === false) { this.said.splice(i, 1); continue; }
      const d = Math.hypot(s.a.x - P.x, s.a.z - P.z);
      // Walked off and back: once more.
      if (d > AGAIN_R * 2) s.away = true;
      else if (s.away && d < AGAIN_R && s.again > 0) {
        s.again--;
        s.away = false;
        if (g.barks?.story(s.a, s.line, s.color, s.glyph)) turnToHero(g, s.a);
      }
    }
  }
}

export const STORY_SAY = new StorySay();
