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
  return { clips };
}
