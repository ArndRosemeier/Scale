/**
 * The animator's clips from the Actors pack: the Quaternius Universal Animation Library clips
 * Actors ships (CC0), loaded as Actors clips. They are played through Actors' own retargeting
 * (`Retargeter`, `Locomotion` in @actors/core) on each character's fitted skeleton, exactly as
 * Actors' creator plays them; see anim/clips.ts.
 */
import type { ActorRuntime, Clip } from '@actors/core';

export interface ClipMeta {
  /** The animator's name for the clip (the Quaternius name). */
  name: string;
  loop: boolean;
  /** Loop or clip length (s). */
  dur: number;
  /**
   * Turn the whole body back to facing forward, whatever way the take faced (motion capture walks
   * about the studio): the pelvis's heading is taken off every bone alike, so the pose itself is
   * untouched. The body is also set on the floor (its lowest bone where the toes stand), as the
   * takes' heights start from their own first frame. Set for the CMU takes, which face any way.
   */
  level?: boolean;
}

export interface ClipLibraryData {
  clips: Map<string, { meta: ClipMeta; clip: Clip }>;
}

/** The animator's clip names ← the pack's clip names. */
const CLIPS: Record<string, string> = {
  Crouch_Fwd_Loop: 'crouch walk', Crouch_Idle_Loop: 'crouch', Dance_Loop: 'dance', Death01: 'death',
  Fixing_Kneeling: 'repair (kneeling)', Hit_Chest: 'hit to chest', Hit_Head: 'hit to head', Idle_Loop: 'idle',
  Idle_Talking_Loop: 'talk', Idle_Torch_Loop: 'hold torch', Interact: 'interact', Jog_Fwd_Loop: 'jog',
  Jump_Land: 'jump land', Jump_Loop: 'jump', Jump_Start: 'jump start', PickUp_Table: 'pick up',
  Punch_Cross: 'punch cross', Punch_Enter: 'fight stance', Punch_Jab: 'punch jab', Push_Loop: 'push',
  Roll: 'roll', Sitting_Enter: 'sit down', Sitting_Exit: 'stand up', Sitting_Idle_Loop: 'sit',
  Sitting_Talking_Loop: 'sit and talk', Spell_Simple_Enter: 'spell raise', Spell_Simple_Exit: 'spell lower',
  Spell_Simple_Idle_Loop: 'spell ready', Spell_Simple_Shoot: 'spell cast', Sprint_Loop: 'sprint',
  Swim_Fwd_Loop: 'swim', Swim_Idle_Loop: 'tread water', Sword_Attack: 'sword attack', Sword_Idle: 'sword idle',
  Walk_Formal_Loop: 'walk formal', Walk_Loop: 'walk',
};

/**
 * Takes from the pack's CMU motion-capture library (Actors' `cmu` clip library, CMU Graphics Lab, free
 * to use), by the animator's names. Only these files are kept from the library (tools/actors-packs.mjs).
 */
export const CMU_CLIPS: Record<string, string> = {
  /** Sitting on the ground, legs out, leaning back on the hands (subject 82, "sitting on ground relaxing"). */
  Sit_Floor_Loop: 'cmu 82_05',
  /** Getting up from sitting on the floor (played backwards: sitting down onto it). */
  Floor_Get_Up: 'cmu 111_06',
  /** A friendly wave hello (right hand up, waving). */
  Wave_Hello: 'cmu 111_37',
};

/** Loads the animator's clips from an Actors runtime (the human pack). */
export async function actorClipLibrary(runtime: ActorRuntime): Promise<ClipLibraryData> {
  const have = new Set(runtime.manifest.clips?.map((c) => c.name) ?? []);
  if (!have.has('idle')) throw new Error('the pack has no idle clip');
  const clips = new Map<string, { meta: ClipMeta; clip: Clip }>();
  await Promise.all(Object.entries(CLIPS).filter(([, a]) => have.has(a)).map(async ([name, a]) => {
    const clip = await runtime.loadClip(a);
    const d = clip.def;
    clips.set(name, { meta: { name, loop: d.loop, dur: (d.frameCount - 1) / d.fps }, clip });
  }));
  // The few CMU takes the game uses (missing files only lose those moves: their authored poses stand in).
  if (runtime.manifest.clipLibraries?.some((l) => l.name === 'cmu')) {
    try {
      await runtime.loadClipLibrary('cmu');
      await Promise.all(Object.entries(CMU_CLIPS).map(async ([name, a]) => {
        try {
          const clip = await runtime.loadClip(a);
          const d = clip.def;
          clips.set(name, { meta: { name, loop: d.loop, dur: (d.frameCount - 1) / d.fps, level: true }, clip });
        } catch (e) {
          console.warn(`[anim] CMU clip ${a} unavailable (npm run packs -- --force)`, e);
        }
      }));
    } catch (e) {
      console.warn('[anim] CMU clip library unavailable', e);
    }
  }
  return { clips };
}
