# WebGPU port — plan

Status: started 2026-10-06 (Arnd: "this is now your task in a branch, as a long running project").

## Why

- **Shader loading.** WebGL compiles a program the first time it is needed, and on Windows Chrome
  (ANGLE → Direct3D 11) the first draw of each program costs extra work in the GPU process. The
  warm-up (`render/WarmUp.ts`) and the shader gate (`render/ShaderGate.ts`) hide this, but a first
  start still spends ~11 s in "Preparing shaders" (RTX 5070, seed 1 @0.35, v0.075). WebGPU builds
  pipelines with `createRenderPipelineAsync`: the browser compiles many in the background, with no
  hidden first-draw stall.
- **Future-proofing.** New browser graphics work goes into WebGPU (Chrome/Edge since 2023,
  Firefox and Safari since 2025). three.js's `WebGPURenderer` falls back to a WebGL 2 backend where
  WebGPU is missing, so one code path serves both.
- **Later, not the goal of the port:** compute shaders (crowds, swarm, particles on the GPU), lower
  CPU cost per draw call.

What the port does *not* fix: frames that are slow because of our own JavaScript (simulation,
pathfinding, physics).

## Ground rules

1. **The WebGL renderer stays the default until the port is complete and measured.** The new path
   runs behind `?gpu=webgpu` (later also a setting). Nothing on `main` may look or run worse while
   the port is in progress.
2. **One material at a time.** Every custom material gets a TSL (node material) version next to the
   GLSL one, chosen by the renderer in use. When everything is ported and `?gpu=webgpu` is at least
   as good on Arnd's PC, the default flips; the GLSL versions are deleted after that.
3. **Same look.** Each ported material is compared against WebGL with screenshots (headless:
   Chromium + SwiftShader runs both WebGL and WebGPU in the cloud container; final check on Arnd's
   PC).
4. Each step is a PR of its own, merged after tests + GPU check like everything else.

## Inventory (v0.075)

### Renderer and plumbing

| What | Where | WebGPU counterpart |
|---|---|---|
| Renderer, reversed-Z depth, AgX, shadows (PCF) | `render/Renderer.ts` | `WebGPURenderer` (`reversedDepthBuffer`), same tone mapping / shadow settings |
| Post: RenderPass → UnrealBloom → Output → SMAA | `render/Renderer.ts` | `RenderPipeline`/`PostProcessing` with `pass()`, `bloom()`, `smaa()`/`fxaa()`, output transform |
| Quality levels, GPU timer (EXT_disjoint_timer_query) | `render/Graphics.ts` | `trackTimestamp` + `renderer.resolveTimestampsAsync()` |
| Shader warm-up | `render/WarmUp.ts` | `renderer.compileAsync()` (async pipelines) |
| Shader gate (stand-ins while compiling) | `render/ShaderGate.ts` | mostly unnecessary; keep a thin version if `compileAsync` per new object still stalls |
| Hitch monitor, HUD program count | `render/hitch`, `ui/Hud.ts` | `renderer.info` differs (no `programs`) |
| PMREM environment from the sky | `render/SkySystem.ts` | `PMREMGenerator` works with `WebGPURenderer` |
| Render targets read back on the CPU | `game/fame/PressPhoto.ts` (`readRenderTargetPixels`) | `readRenderTargetPixelsAsync` |
| Render target for the news screens | `game/aftermath/NewsFeed.ts` | `RenderTarget` |
| GPU probe on the start screen | `ui/GpuHint.ts` | add `navigator.gpu.requestAdapter()` info |

### Custom shader code (31 files, GLSL via `onBeforeCompile` or `ShaderMaterial`)

Ordered by how much of the screen they cover (port first what is always visible):

1. **City surfaces:** `render/materials/facade.ts` (buildings, windows, lit rooms, damage),
   `render/materials/ground.ts` (terrain, roads, holes), `render/materials/clearGlass.ts`,
   `stream/Skyline.ts` (far city), `render/skyOcclusion.ts`.
2. **Sky and weather:** `render/SkySystem.ts` (three's `Sky` + sun disc / moon patch, stars),
   `render/Weather.ts` (rain).
3. **Street life:** `sim/CrowdRenderer.ts` (vertex-animation crowds + depth), `props/vehicles.ts`,
   `props/vegetation.ts` (4 tree/leaf materials), `props/furniture.ts`, `stream/Countryside.ts`,
   `fauna/birdMesh.ts`, `future/Signs.ts`, `future/NavGlows.ts`.
4. **People and the player:** `humanoid/client/skinMaterial.ts`, `garmentMaterial.ts`,
   `hairShells.ts`, `partMaterials.ts` (eyes, brows, lashes, lips).
5. **Effects and events:** `destruction/Dust.ts`, `destruction/Debris.ts`,
   `game/powers/ElementFx.ts`, `game/aftermath/SmokeColumns.ts`, `game/intro/StarFx.ts`,
   `game/threats/brood/broodMesh.ts`, `game/threats/rig/CreatureMesh.ts`,
   `game/fame/HeroStatue.ts`.
6. **Underground:** `underground/Underground.ts` (metro trains), `underground/deep/DeepMeshes.ts`.

## Steps

1. **Renderer behind the flag.** `?gpu=webgpu` starts the game on `WebGPURenderer` with the same
   scene, camera, shadows and tone mapping, post-processing rebuilt as a node pipeline, the sky
   ported (else the screen is black). Custom materials still fall back to their plain base material
   (wrong look, but the game runs). The warm-up uses `compileAsync`; the gate is off. Console logs
   the same `[load]` line, so both paths can be timed.
2. **City surfaces** (group 1) → first real comparison of loading time and fps on Arnd's PC.
3. **Street life** (group 3), **people** (group 4).
4. **Effects, underground** (groups 5–6), weather.
5. **Plumbing:** GPU timer for the quality levels, press photo read-back, HUD stats.
6. **Measure and switch:** loading time and fps on Arnd's PC, both paths, several seeds. If WebGPU
   is as good or better: make it the default, keep `?gpu=webgl` for a while, then delete the GLSL.

## Log

- 2026-10-06: inventory, plan. Headless WebGPU works in the container (Chromium +
  `--enable-unsafe-webgpu --enable-features=Vulkan --use-webgpu-adapter=swiftshader`).
- 2026-10-06: steps 1–4 done in one go: every GLSL material has a node version (see
  WEBGPU_PORTING.md for how, and the traps). Headless `?gpu=webgpu-gl` screenshots match WebGL
  (street, aerial, night). All generated WGSL validates on Dawn. Fixed on the way: polygon offset
  under reversed depth (three's WebGPU backends don't flip it like WebGLRenderer), stars as sized
  sprites, press photos read back asynchronously. Headless real WebGPU (Dawn on SwiftShader) loses
  its device on the first frame even for a plain cube, so real WebGPU is checked on Arnd's PC.
  Open: GPU timer (quality auto-levels) on WebGPU; `info.programs` counts; vertex-buffer limit (8)
  for very large instanced meshes (furniture > ~1024 instances) to watch on real hardware.
- 2026-10-07: first runs on Arnd's PC (RTX 5070): everything renders, but loading 53–75 s
  (WebGL 10–20 s), fps 33–52. Cause of the loading time: the pipelines built ahead
  (`compileAsync`) never matched the ones the frames used, so ~4 of 5 were built on the spot while
  drawing, one by one. Three mismatches, all fixed: (1) three keys a pipeline by its render
  context, which includes the render call depth, and a `pass()` node renders the scene from inside
  the post pipeline's render; the scene is now drawn by a plain render into Post's own target;
  (2) every sky refresh made a new environment texture (new node, new key for every lit
  material); PMREM now re-renders into the same target on WebGPU; (3) `compileAsync` only takes
  what the camera sees and builds one pipeline after the other: Renderer.compileAsync turns
  frustum culling off while it collects and compiles the scene in ~16 parts side by side. The
  shader gate now also works on WebGPU: new meshes are compiled with compileAsync and hidden until
  it finishes (the frames skip a pipeline still being built). Headless webgpu-gl: shader
  preparation 260–400 s → 120–140 s, pipelines built while drawing 436 → 84 (the rest are
  shadow-map pipelines, which compileAsync cannot build). `[warm-up]` line now shows node builds
  and pipelines in advance / while drawing. `&offscreen` sends the final image to a render
  target (`window.grabFrame()` returns a PNG) for headless real-WebGPU checks.
- 2026-10-07 (later): PC re-time after the fix: WebGPU 48–51 s (WebGL 9–20 s), ~300 of ~630
  pipelines still built while drawing, and three pipelines failed (unresolved sampler / binding),
  most likely from several compileAsync calls interleaving their node builds: they now run one at
  a time (queue in Renderer.compileAsync). Why so many pipelines: an InstancedMesh whose matrices
  fit a uniform buffer gets that buffer's size and a per-object name in its vertex shader, so
  every batch had its own shader (557 vertex vs 162 fragment shaders). The kit now has three use
  the vertex-attribute path for them (as it does for large batches), where the matrix fits the
  attribute / buffer limits: 586 → 210 pipelines headless. Glass and environment reflections were
  compared on Dawn (SwiftShader) against WebGL2 on a test page: same; the PC difference is still
  open.
- 2026-10-07 (evening): PC at 64d3c9c: WebGPU 53–57 s (WebGL 8–17 s), fps 57 day / 50 night (was
  40 / 43), no pipeline errors, windows now match. Headless (real WebGPU) the pipeline builds were
  2/3 of the compile phase; they run strictly one after another. 48 of 141 were copies differing
  only in a uniform array's generated name (leaves per species, facades per chunk) or in the
  props' instance matrix (a uniform buffer sized per batch): uniform arrays now have fixed names
  and props read just the translation, so they fit the attribute path. 141 → 93 pipelines in
  advance, warm-up 100 → 71 s headless. The gate's calm wait (16–20 s on the PC) is the next
  target; `[gate] background compiles done at …` now logs when it goes idle.
- 2026-10-07 (night): PC at faeecc2 (another check ran alongside): WebGPU shader preparation
  39–50 s, calm still at its 20 s cap, fps 50 → 20 → 8 over three loads in one profile and a
  blurrier picture. Cause found: WebGPU has no GPU timer, so auto quality took the slow frames
  during the gate's background compiles for a slow GPU, stepped down (each step re-applies
  shadows / LOD and so rebuilds materials, more compiles) and remembered the low step for the next
  load. Auto quality now ignores frames while the gate is busy.
- 2026-10-07 (night, later): PC at 8db07d9: auto quality no longer drops during loading; brick
  windows match. But ~30 s at 8–10 fps after loading, in waves until ~150 s (`[gate]` 1500–1900
  meshes): three keys an InstancedMesh's node build by its uuid, so every new instanced batch
  builds its shaders again (main and shadow pass), and the tree / prop batches were rebuilt each
  time their count outgrew the capacity (×2 steps). Capacities now start at 512 and grow ×4
  (`batchCap`). After that WebGPU holds 42–47 fps at High (WebGL 60 at Ultra), open.
  `&buildlog` prints every 10 s what had node shaders built and the fps.
- 2026-10-07 (late): PC `&buildlog` (d17db81): of ~1900 node builds in the first 4 minutes ~1000
  were the far skyline (an InstancedMesh per 1.5 km tile, rebuilt whenever a tile got more
  buildings), then cars (~240 incl. shadow), trees and props (~200, one per kind), people (each
  person's own materials), facades (a few every 10 s while streaming). The skyline is now one
  instanced mesh for the whole city, grown in ×4 steps (WebGL screenshot identical).
- 2026-10-07 (late, 2): PC at 68806c3: node builds after loading 1900 → ~800, but WebGPU ran at
  11 fps at every quality level: the new single skyline mesh had DynamicDrawUsage buffers sized
  for growth, and WebGPU uploads dynamic attributes whole every frame (~8 MB). That also costs
  every other dynamic instance buffer (props, vehicles, crowd), likely part of the 42–47 fps at
  High. Dynamic usage now maps to static on WebGPU (uploads on `needsUpdate`, as on WebGL).
- 2026-10-07 (late, 3): PC at 0099f34 (High): WebGPU 53–56 fps (WebGL 60), load 74.5 s vs
  52.4 s, skyline and fog match. While playing, every new person (each with own materials) and
  facade chunk built its shaders again (fps dips to ~45). People and destroyed-element facades /
  glass now share one node graph per kind (`webgpu/sharedGraph.ts`): headless, 3 person node
  builds instead of one set per person, 1 facade build; a test page renders three horn colours,
  two simple parts and an alive vs. collapsed facade correctly from shared graphs.
- 2026-10-08: PC at 66c73f6: city matches WebGL, people normal and varied, builds while playing
  1–2 per 10–30 s (was 10–27 per wave + facades); load 80 s vs WebGL 53–61 s (29 s shaders vs
  9). `&buildlog` now also times the WebGPU API calls: headless, async pipeline compiles were busy
  24 of the 35 s compile phase, strictly one at a time; node builds are the smaller part. Pipelines
  now compile up to four at once (node builds still one at a time): headless compile phase 43.6 →
  30.5 s.

