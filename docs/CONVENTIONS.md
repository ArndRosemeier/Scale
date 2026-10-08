# Scale — Conventions: use the shared helper

Many systems need the same answer: "is this underground?", "can a person stand here?", "is that
on screen?" When each system writes its own version, a fix in one place misses the others. The
Tab-targeting-in-the-sewers bug is the example: about eight systems each did their own distance
and line-of-sight checks.

**Read this before writing gameplay code.** If your code needs one of the answers below, call
the helper and don't re-derive it. If the helper doesn't fit, extend the helper. Where a
selftest guard exists (`npm test`), it fails on a stray copy.

To look for new copies, use the two finders from Arnd's Toolbox. Both write reading lists, not verdicts.
`npm run dup` lists functions that share a name (`reports/duplicate-candidates.md`). `npm run repeated` lists
the same body under different names and inline snippets pasted into several files (`reports/repeated-code.md`).

The audit that started this list (v0.130) is in the project files, `code-audit/findings.md`.
Its open items are consolidated here one PR at a time.

## Space

| Question | Use | Not |
|---|---|---|
| Are two bodies on the same side of the street (both underground or both up top)? | `Underground.sameSide(ax, ay, az, bx, by, bz)` with **feet** heights. A blow, blast or footfall point counts as feet. | `Math.abs(dy) < r`, `s.y > a.y - 2`, or a 2D `hypot` alone |
| Does a blow, blast, stomp or shove reach a person? | 2D/3D range **and** `sameSide`. `Reactions.sameSide` is wired to it. | Range alone. A street stomp must not floor the sewer crew below. |
| Does a blow reach the player? | `PlayerHealth.damage(…, x, z, y)` with the source's real height (the type requires it). It refuses blows from the other side. | Writing `hp`. Passing the player's own `y` as the source height. |
| Can the camera see a person (markers, tags)? | `makeSight` (`game/sightline.ts`) via `render/screen.ts` `setSight` | A raycast of your own |
| Where on screen is a world point? | `render/screen.ts` `toScreen` / `screenPoint` | `.project(cam…)` (**guarded**: the selftest fails on it anywhere else) |
| Can someone shoot or see from A to B? | `game.sight.clear` (`game/combat/sight.ts`: caves, tunnels, buildings, cars, facade holes) | `world.raycast` with your own tolerances |

## The ledger and blame

| Question | Use | Not |
|---|---|---|
| The player knocked someone down | `reactions.knockDown(a, …, 'player')`. It books the `body` entry **with the victim** through `CrimeSystem`. | An extra `consequences.record(…, 'person', 'knockdown', x, z)` without a ref. Justice can't tell a mugger from a bystander, and the threat clock counts it twice. |
| The player's blow hits a car (punch, shockwave, dash) | `Game.hitCar`: a wreck or a dent, booked on the ledger with the car | `wreckIt` + `makeWreck` or a dent with no ledger entry (wrecking a police car with a punch used to cost nothing) |
| Add damage to a car | `dentCar(v, amount, cap?)` (`sim/Traffic.ts`; never lowers it) | `v.damage = Math.min(…)` by hand (**guarded**) |
| Karma | `Progress.addKarma` (it already ignores the sandbox) | Your own `sandbox` check in front of it |

## Small helpers

| Need | Use | Not |
|---|---|---|
| clamp, 0..1 clamp, lerp, smoothstep | `core/math.ts`: `clamp`, `saturate`, `lerp`, `smoothstep` (import with an alias such as `saturate as clamp01` or `smoothstep as smooth` if the short name reads better) | A local `const clamp = …` (**guarded**) |
| Text into HTML | `esc` from `ui/esc.ts` (escapes `& < > " '`) | A local `esc` (the six old copies escaped different sets; **guarded**) |
| Polygon or polyline maths (area, bounds, point in polygon, distance to the outline, length, reverse, rectangularity) | `core/geom2.ts`: `polyArea`, `polyBounds`, `pointInPoly`, `distPointPolyEdge`, `polylineLength` (`stride` 3 for x,z,extra routes), `reversePoly`, `rectangularity` | A local `polyBox`, `routeLength`, `reversed`, … (**guarded by body, not name**) |
| Angle difference, turning toward an angle, 3D vector basics | `core/math.ts`: `angleDiff(from, to)` (= to − from, wrapped to ±π), `lerpAngle`, `v3add`, `v3sub`, `v3scale`, `v3madd`, `v3dot`, `v3cross`, `v3len`, `v3norm`, `v3lerp` (alias them to short names if you like) | A local `angDiff` / `turn` / `norm` / `cross` (**guarded by body**; a typed-out cross product is **guarded** too) |
| Find more copies | `npm run dup`, `npm run repeated` | |

## Shaders

Every GLSL shader has a TSL twin in `src/render/webgpu/` (see `docs/WEBGPU_PORTING.md`). If you
change one, change the other. The twin's header comment names the GLSL file it mirrors.
