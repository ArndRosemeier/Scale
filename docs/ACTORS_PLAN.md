# Actors — full adaptation plan

Status: **plan** (2026-10-21). Brief (Arnd, project thread "Game won't start after model import"): "The actors lib
is the future. Instead of this zombie half and half what we have now I want a FULL adaptation, and where Actors is
missing something, bring it over. New capabilities are always welcome to have there."

## 1. Where we are (v0.259)

v0.259 took Actors' **bodies**: shape and detail levels, skin/eye/hair materials, the fitted wardrobe, hair, beards,
races, face expressions and blinking, the crowd mesh and the creator (Actors' `CharacterEditor`).

It did **not** take Actors' **motion**. Every Scale character sets `animation: null`, so Actors never poses its own
skeleton. Instead:

1. A hidden *proxy skeleton* with the old MakeHuman bone names (spine05…01, upperarm01/02, …) sits on the Actors
   joints (`src/humanoid/actors/rig.ts`).
2. Scale's old `Animator` (`src/humanoid/client/anim/`) poses that proxy, exactly as it posed the MakeHuman bodies.
3. `RigBridge.sync` copies the proxy pose onto the Actors bones every frame and re-aims each bone at the proxy joints.
4. Actors' clips are re-encoded into the old clip format (`src/humanoid/actors/clips.ts`): 22 of 52 bones, no
   fingers, against a Rigify-style rest pose, and blended as Euler angles.
5. The old body's corrections still run: collarbones turned ~26° forward and ~29° down on every clip and pushed
   forward again while walking, arms pushed out while walking, hands spread from the thighs while standing. Idles
   are three CMU takes played at half speed with the head damped; Actors' own `Idle_Loop` is only a fallback.

Those corrections cancelled out faults of the old MakeHuman body against Rigify clips. With Actors at both ends they
only bend the body away from the clip, which is why walk and idle look goofy next to Actors' own creator.

## 2. Goal

- **Actors poses every human.** Clips play on Actors' skeleton through Actors' `Retargeter`, all bones, fingers
  included, untouched unless a layer means to change them. Actors' retargeting is tuned carefully (Arnd: "that took
  quite some doing to make them fit as well as they do now"): its output is the baseline, and Scale never adds
  corrections of its own on top of it. If a clip looks wrong, it gets fixed in Actors, for every user.
- **Scale's motion features live in Actors**, as renderer-free building blocks in `@actors/core` with thin three.js
  glue in `@actors/three`: anything another game would want too. Scale keeps only game decisions (when to run,
  what to hold, which action to play).
- **No proxy skeleton, no MakeHuman bone names** left in Scale's human code; ragdolls, first person, sockets, the
  crowd baker and imported avatars all work on Actors' skeleton (game-engine names: pelvis, spine_01, upperarm_l…).
- **Every Actors clip is usable**, plus the CMU library on demand.
- Nothing players can do today gets lost on the way (see the checklist in §5).

## 3. What Actors gets (new capabilities)

All in `@actors/core` unless noted, renderer-free, with tests. Each lands in Actors first (own PRs there), then
Scale picks it up through a new vendored build or an Actors release.

| Building block | Comes from Scale | Notes |
|---|---|---|
| **Pose buffers and blending**: sample any clip into a pose (local quaternions + root), blend poses (nlerp/slerp, never Euler), per-bone masks (upper body, arms, legs, one side), additive layers relative to a reference pose | Animator layers, Euler blending | The core every other block uses |
| **Locomotion blend**: idle → walk → jog → sprint (+ crouch, + backpedal/strafe) by speed, phase advanced by distance / stride so feet never slide, foot-strike sync between clips | `clipGait`, `applyClipGait`, gait phase | Stride and strike times measured from each clip's root motion when the pack is built |
| **Two-bone IK** with pole vectors (legs to ground with pelvis drop and foot alignment; hands to goals, palm orientation) | `footIK`, `reachIK`, limb goals | Ground is a callback, so no physics dependency |
| **Look-at chain** (spine → neck → head → eyes, weighted, clamped) | look-at layer | Eyes use the existing eye pivots |
| **Procedural additives**: breathing (integrated phase), acceleration lean, hit-reaction springs, tail sway | Animator layer 4 | Integrate phases, never `sin(time × variable rate)` (lesson from v0.121) |
| **Hand poses**: grips by class (fist, cup, pole, phone…), finger curl | finger curl, `GripClass` | Uses the real finger bones the old pipeline dropped |
| **Authored poses as data**: flight (Superman), hero landing, carry poses per held item, sit, sleep, stunned | `pose.ts`, `actions.ts` poses | Written once against Actors' rest, stored like short clips |
| **Action layer**: one-shot clips or authored poses on a mask with fade in/out, events at named times (hit frame) | `actions.ts` (punches, powers, throws…) | Scale keeps the action list and timing |
| **Pose read/write for physics** (`@actors/three`): read bone world transforms, drive bones from rigid bodies, blend back to animation | ragdoll drive, get-up | Physics (Rapier) stays in Scale |
| **Baked animation textures for crowds** | `CrowdBaker` | Fills the roadmap gap "no instancing or baked animation textures" |
| **Humanoid retarget for foreign rigs** (VRM/Mixamo/…) onto Actors' skeleton | `src/avatar/HumanoidMap.ts` | Imported avatars play the same clips |

## 4. Phases

Each phase is one Scale PR (plus the Actors PRs it needs), merged when headless checks pass and, since these are
visual changes, after a GPU look on Arnd's PC.

1. **Clips as they are: walk, run, idle.** Actors: pose buffers, blending, locomotion blend, look-at, breathing.
   Scale: ground locomotion and standing idle pose Actors' skeleton directly; the proxy skeleton follows the Actors
   pose (reverse bridge) so everything not ported yet keeps working. The old collarbone and arm corrections, the
   half-speed CMU idles and the Euler blending are gone. Check: Scale's walk and idle side by side with the same body
   in Actors' creator.
2. **Feet and hands.** Actors: two-bone IK, hand poses with real fingers. Scale: foot placement on slopes and stairs,
   hands on goals (reach, ledges, the manhole), grips for held items.
3. **Everything else that moves.** Actors: authored poses, action layer. Scale: swim, jump, sit, sleep, stunned,
   dead, flight and super-speed poses, punches, powers, carry poses, idle personalities, talking, dancing, groove.
4. **Physics and special views.** Actors: pose read/write for physics. Scale: ragdolls and the get-up, first person,
   sockets and held items, the roc's grab, the origin intro. After this the proxy skeleton, `RigBridge`, the old
   clip format and `src/humanoid/client/anim/pose.ts` are deleted.
5. **Crowds and avatars.** Actors: baked animation textures, humanoid retarget for foreign rigs. Scale: the crowd
   baker and imported avatars on Actors.
6. **More motion.** Wire up the clips Scale never used: phone and folded-arms idles, nods, leaning on a rail, carry
   walk, zombie walk (the necromancers' dead), knockback, throw, climb, slide, sword and pistol sets; pick CMU takes
   for walk and idle variety.

## 5. Must keep working (check per phase)

Walk/jog/sprint/crouch with no foot sliding, strafing and backpedalling; foot placement on slopes and stairs; idle
variety and personalities; look-at and talking faces; swim and tread water; jump, leap, landing, super speed; flight
poses; sitting (cafés, interiors), sleeping, stunned, knocked down, dead, getting up; every action and power
(punches, throws, casting, carrying, busker guitar, torch/lantern processions, groove at concerts); ragdolls; the
manhole climb; first person; giant and shrink sizes; tails on races; sidekick, villains, police, army; crowds at all
distances; imported avatars; WebGPU (`?gpu=webgpu`) twins.

## 6. Packaging

- Actors changes go to Actors PRs. Until an Actors release contains them, Scale vendors builds in `vendor/actors/`
  (see its README). Once released, Scale points `package.json` at the release URLs and drops the vendored copies.
  Bumping Actors' package versions makes its CI publish a GitHub release; nothing goes to the public npm registry
  without Arnd's OK.
- The character pack (`public/packs`, ~310 MB) is uploaded with `dist`; deploys must include `dist/packs`.

## 7. Open questions

- Should Scale's superhero look (patterned tights and masks, dropped in v0.259) come back as Actors garments and
  skin patterns? *(default: yes, as part of phase 3 or its own small PR)*
