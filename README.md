# Scale

A seed-driven, walkable, living and destructible 3D city in the browser
(TypeScript · three.js · Rapier · Vite). Every seed is a different place, from a
small river town to a New-York-sized metropolis. You can grow from 10 cm to
100 m, fly, enter buildings, ride down into the metro or crawl through the
sewers. Everything you do has physical consequences that the citizens notice.

## Run

```bash
npm install
npm run dev          # http://localhost:5180
npm test             # headless determinism / invariant checks (all sections, parallel)
npm run test:quick   # only the sections touching what changed against origin/main
npm run build        # type-check + production bundle
npm run build:publish # the same, based for the shared host's /scale/ subpath
```

**Publishing.** The app is served at `https://apps.futuremagic.de/scale/`, so the bundle
must carry that base: publish with `npm run build:publish` (`vite --mode publish` → base
`/scale/`; `SCALE_BASE` overrides it, e.g. to host under another folder name). The plain
`npm run build` stays root-relative for local previews — served under the subpath its
output is a blank page. `public/futuremagic.json` ships the hub manifesto (title, tagline,
tags, screenshot) with every build; the app goes live by symlinking the shared host's app
folder at this `dist`.

**Your own character.** The start screen has an **Import model…** button (or drop a file on
it): GLB, glTF, VRM and FBX load directly and are kept in the browser. Humanoid rigs
(Mixamo, VRM, Unreal-style, Rigify, most named or even unnamed humanoid skeletons) are
driven by the game's own animation (walk/run, foot placement, flight pose, punches, size
scaling) via retargeting from the built-in human; other rigs (robots, animals) play their
own animation clips. For other formats (.blend, OBJ, DAE, or more reliable FBX) the start
screen links a small Windows converter that installs a portable Blender on first use.

Avatar converter (character models for the player, via headless Blender):

```bash
npm run avatar -- model.fbx [Idle.fbx Walking.fbx ...] [--out file.glb]
```

Converts FBX / glTF / OBJ / DAE / .blend into one GLB (metric, Y-up, PBR, embedded
textures). Extra files are animations for the same rig and become named clips. Rigs are
not copied but rebuilt: the converter measures how every bone moves the mesh (through
control bones, constraints, deform cages, lattices, bone-parented props, extra
armatures), bakes that into plain skin weights on a clean skeleton with standard body
bone names (found by name in several languages, else by the skeleton's shape) and bakes
the rig's animations onto it. It then poses the result and refuses (exit code 2, no GLB)
when the body is not a humanoid the game can drive and has no clips, or when the mesh
tears. A JSON report (rig, bones, height, clips, warnings or the error) is written next
to it. Blender comes from `BLENDER_BIN` or AssetGenerator's pinned install.
`npx tsx tools/avatar/check-glb.ts file.glb` shows how the game reads a GLB (mode,
mapped bones, clips).
`npm run build-converter` packages the downloadable Windows version
(`public/converter/ScaleAvatarConverter.zip`, from `tools/avatar/converter-package`).

URL options: `?seed=<text or number>&size=<0..1>` (size 0 = town, 1 ≈ New York),
`&auto` skips the menu. In the console `window.dev` has test helpers
(`dev.door(true)`, `dev.blastBuilding(dev.nearestBuilding())`, `dev.setSize(30)`,
`dev.hour(21)`), and `window.prof` holds per-subsystem frame cost.

**Hitch log.** `hitches.report()` in the console lists frames whose main-thread work
exceeded 30 ms with the cause: per-subsystem time, work done between frames
(streaming results), new shader programs (with the scene objects using them and the
cache-key fields that differed), GPU uploads and browser long tasks.
`hitches.list` has the raw records, `hitches.json()` exports them.

**Shaders never stall a frame.** Everything visible at start is compiled behind the
loading screen. After that every new mesh passes the shader gate
(`src/render/ShaderGate.ts`): its program (and its shadow-map variant) compiles on the
driver's threads, and until it is ready the mesh draws with a pre-compiled stand-in
material, or stays hidden if its shader has custom vertex code. `shaderGate.stats` shows
what had to wait.

**World panels** (`src/ui3d`) are clickable 2D canvases in the 3D world (elevator
keypads, call buttons); `PanelManager` routes the crosshair to them.

## Controls

| Key | Action |
| --- | --- |
| W A S D | Walk (in flight: fly) |
| Shift | Run / boost |
| Space | Jump (in flight: up) |
| Ctrl / C | Down (in flight) |
| F | Toggle flight |
| Numpad + / − (or = / −) | Grow / shrink (10 cm … 100 m) |
| Mouse / wheel | Look / camera distance |
| Left click | Punch |
| E | Open a manhole and drop into the sewer / climb out |
| B | Test blast where the camera looks |
| T, [ ] | Fast time on/off, time of day ±1 h |
| F8 | Free camera |
| F1 / F2 / F3 | Put on costume 1 / 2 / 3 (the fitting mirror changes the one you wear) |
| H, Esc, F4 | Help, pause & settings, detailed HUD |

## The city

* **World.** Terrain, river(s) and the optional sea are global functions of
  position (`src/world`). The city sits in a river valley; hilly seeds have real
  slopes, and coastal seeds have a shoreline, a port and a promenade.
* **Macro plan** (`src/plan/macro.ts`). City centres and a density field drive
  an organic arterial web: a variable-density Poisson set, Delaunay
  triangulation, a Gabriel filter, then quad-dominant merging. Bank roads and
  bridges cross the rivers, and boulevards emerge from traffic between centres.
  The faces of this web are the **cells**, and each cell gets a district:
  downtown, commercial, old town, apartments, rowhouses, suburbs, industrial,
  port or park. The macro plan also lays out metro lines and stations, and
  sewer trunks.
* **Cell plan** (`src/plan/cell.ts`). Local streets come from recursive
  splitting of the cell, with a different grammar per district:
  * gridded blocks, aligned across arterials
  * organic old-town lanes
  * curved suburban streets

  From these streets the planner derives:
  * **Surfaces:** carriageway, sidewalks with rounded kerbs, blocks and quay
    promenades, all from polygon booleans.
  * **Lots:** perimeter lots with corner and courtyard handling, detached
    lots, and whole-block towers on plazas.
  * **Buildings:** 15 styles (rowhouse, tenement, Haussmann, timber, old stone,
    art deco, glass tower, modern, brutalist, house, warehouse, church, shop,
    garage, Mediterranean).
  * **Extras:** parks, plazas, metro entrances and street furniture.
* **Geometry** (`src/build`) is built in a worker pool. Building shells are
  made of *elements*, one wall panel per window bay per floor plus slabs, roof
  and plinth, so destruction is a texture update. Facades, windows, shopfronts,
  curtain walls and interiors-behind-glass are drawn by one shader
  (`src/render/materials/facade.ts`) on top of procedural PBR textures
  (`src/render/texgen`). Ground uses adaptive tessellation; distant cells
  switch to a LOD, and the far skyline is instanced (`src/stream/Skyline.ts`).
* **Props and vehicles** (`src/props`). Ten procedural tree species with wind,
  21 kinds of street furniture with working lamps and signals, and 12 vehicle
  kinds with lights, indicators, brake lights and damage.

## Life

* **Citizens** (`src/sim/Population.ts`) are deterministic identities:
  * non-workers are anchored at their home
  * workers are anchored at their job, with a deterministic home elsewhere

  Their day (wake, commute, lunch, errands, evenings out, sleep) is a pure
  function of identity and day. As in Vuntra City, nobody is simulated while
  unseen; "where is X now" is computed when the player comes near.
* **Pedestrians** (`src/sim/Pedestrians.ts`). The walking legs of trips near
  the player become agents. They follow real sidewalk routes over the road
  graph, cross at corners, avoid each other, enter doors, walk to their cars or
  to metro entrances, and despawn far away while their schedule continues.
  * **Rendering:** vertex-animated instanced crowds baked from the Norgo
    humans, and full skinned rigs up close, in the citizen's own outfit
    (`src/sim/CrowdRenderer.ts`).
  * **Indoors:** people are present inside entered buildings according to
    their schedules, at desks, on sofas, or asleep at night.
* **Traffic** (`src/sim/Traffic.ts`):
  * lane following with IDM car-following and curved junction turns
  * signals as a pure function of time, giving way to pedestrians
  * citizens' car trips plus rush-hour through traffic
* **Reactions** (`src/sim/Reactions.ts`):
  * collapses, blasts and giant footsteps make people flee, scream or get
    knocked down
  * breaking glass and punches make them stop and stare or film
  * a 3 m person draws a curious crowd; a 30 m giant empties the street
  * drivers brake, honk, U-turn or abandon their cars and run

## Size, flight and destruction

* **Size** (`src/player/Player.ts`). Height ranges from 0.1 to 100 m, with
  k = height / 1.8. The scaling laws are physical:
  * mass ∝ k³ and strength ∝ k²
  * walking speed ∝ √k (Froude similarity), and the animation runs at 1/√k, so
    giants move in slow motion and tiny people scurry
  * terminal velocity ∝ √k
  * footstep energy ∝ mass, so giants shake the camera, crush cars, people and
    lamps, crack roofs they stand on, and smash walls when their momentum
    exceeds the wall's strength
  * tiny people go unnoticed, get kicked along by walkers' feet and can be hit
    by cars that don't see them
* **Flight** (F). A hover pose when slow and a prone superhero pose with
  banking when fast, plus:
  * speed streaks and a speed-dependent field of view
  * vapour trails, and downwash dust near the ground
  * a vapour cone and sonic boom at Mach 1
* **Destruction** (`src/destruction`):
  * **Panels:** wall panels break under impulses above their material
    strength, turning into Rapier debris, chips and dust; glass shatters first.
  * **Structure:** every damaged building is checked floor by floor. Symmetric
    failure gives a progressive pancake collapse, which eats storeys; one-sided
    failure makes the upper part topple around a hinge.
  * **Aftermath:** collapses leave rubble mounds you can walk on, hit their
    neighbours, crush cars and scare everyone.
  * **Props:** trees and lamps topple, cars become physical wrecks or are
    crushed flat.
  * **Bounded cost:** debris uses a fixed pool of rigid bodies that freeze into
    static rubble.

## Inside, under and around

* **Interiors** (`src/interior`) are generated when you approach a door or a
  breach:
  * **Layouts by use:** apartments (living rooms, bedrooms, kitchens,
    bathrooms), open-plan offices with meeting rooms, lobbies, shops, cafés,
    warehouses and church naves.
  * **Moving around:** multi-storey buildings have a working elevator. Call it with the
    button beside the landing doors, ride the cabin and pick a floor on its keypad
    (aim the crosshair at a button within reach and left-click). Entrance doors swing
    open when someone approaches.
  * **Windows:** they become real windows in both directions.
* **Metro** (`src/underground`). Tunnels follow the planned lines. Stations
  have platforms, columns, signs and lights, and street entrances lead down
  stairs. Trains run on analytic timetables and stop at stations.
* **Sewers.** Arched brick tunnels with a water channel run under the
  arterials and are entered through manholes.
* **Day and night.** A physical sky with clouds, sun and moon light, lit
  windows by time of day, street lamps with real lights near you, and
  headlights.
* **Sound.** Spatial effects and context ambience (city day/night, river, sea,
  wind in flight, metro, sewer), generated with the local SoundStudio
  (`docs/SOUNDS.md`).

## Architecture

See `docs/ARCHITECTURE.md`. In short: plan (pure data, workers) → mesh
(workers, transferable buffers) → simulate (main thread) → render. All of it
derives from `(seed, size)`, so any cell can be regenerated anywhere,
identically.

## Credits

* Human body, morphs and skeleton: MakeHuman 1.1 (CC0), via the Norgo humanoid
  pipeline.
* Animation clips: Quaternius Universal Animation Library (CC0).
* Sounds: generated locally with Stable Audio 3 (see `docs/SOUNDS.md`).
* Music: Arnd's pieces made with Google Lyria 3 Pro, built into the game by `tools/music/build_tracks.py` (prompts in the project files, `music/lyria-prompts.md`).
* Everything else (textures, buildings, vehicles, trees, furniture, layouts)
  is procedural code in this repository.
