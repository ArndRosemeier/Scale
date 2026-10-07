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
