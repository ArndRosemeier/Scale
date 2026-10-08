# Porting a material to WebGPU (node materials)

How the GLSL materials are ported for `?gpu=webgpu` (see WEBGPU_PLAN.md). Worked examples:
`src/render/webgpu/facade.ts`, `ground.ts`, `city.ts`, `sky.ts`; shared helpers in `common.ts`.

## Shape of a port

- The GLSL stays as it is: WebGL remains the default. The node version lives in
  `src/render/webgpu/<area>.ts` (first line `// @ts-nocheck -- ...` like the others; import from
  `three/webgpu` and `three/tsl`, never from `three`).
- The original factory dispatches at its top:
  ```ts
  import { WEBGPU, gpuKit } from '<path>/render/gpuMode';
  if (WEBGPU) return gpuKit().createXNodeMaterial(...) as unknown as THREE.MeshStandardMaterial;
  ```
  and `src/render/webgpu/index.ts` re-exports `createXNodeMaterial`. Nothing in the main bundle may
  import `three/webgpu` or `three/tsl` directly (the kit is a lazily loaded chunk).
- Keep the node code line by line close to the GLSL, with the same comments, so the two can be
  compared and kept in step.
- Return the same kind of object the callers use: `MeshStandardNodeMaterial` for
  `MeshStandardMaterial`, `MeshPhysicalNodeMaterial`, `MeshBasicNodeMaterial`, `SpriteNodeMaterial`,
  `PointsNodeMaterial`, `LineBasicNodeMaterial`, or a plain `NodeMaterial` for `ShaderMaterial`
  (set `vertexNode`/`fragmentNode` or, better, `positionNode` + `colorNode`/`outputNode`).
  Callers that set `.color`, `.roughness`, `.opacity`, `.uniforms.x.value`, `.userData.uniforms`
  must keep working: expose `uniform()` nodes under the same names where code reads them.

## GLSL → TSL mapping

| GLSL hook | Node material |
|---|---|
| `diffuseColor.rgb = x` | `setDiffuse(mat, () => x)` from `webgpu/ground.ts` (not `colorNode`: the shadow pass evaluates `colorNode` for alpha) |
| `roughnessFactor = x` / `metalnessFactor` | `roughnessNode` / `metalnessNode` |
| `normal = perturbNormalUV(...)` | `normalNode = perturbNormalUV(positionView, normalView, uv, tn, strength)` (common.ts) |
| `totalEmissiveRadiance += x` | `emissiveNode = x` |
| `reflectedLight.indirectDiffuse *= ao` | `aoNode = ao` |
| vertex `transformed = ...` | `positionNode` (in r186 it is applied after skinning and instancing and replaces the result; displacements the GLSL applied before them go in through a `setupPosition` override writing `positionLocal`/`normalLocal`, see webgpu/people.ts, creatures.ts, vegetation.ts) |
| `gl_Position = vec4(0)` (hide) | `positionNode = select(hide, vec3(0), positionLocal)` |
| varyings | attributes read in the fragment become varyings by themselves; `varying(node, 'name')` for computed ones |
| `vWPos` / `vWNrm` | `positionWorld` / `normalWorldGeometry` (unflipped, like `mat3(modelMatrix)*objectNormal`) |
| `-vViewPosition` | `positionView` |
| `gl_FrontFacing` | `frontFacing` |
| `discard` | `Discard()` inside `If(...)` |
| `texelFetch(t, c, 0)` | `textureLoad(t, ivec2)` |
| `texture(arr, vec3(uv, layer))` | `texture(arr, uv).depth(int(layer + 0.5))` |
| `textureLod` | `texture(t, uv).level(l)` |
| `uniform float u[24]` | `uniformArray(jsArray, 'float')` and `.element(i)` (arrays of Vector4 are read every frame, in place updates work) |
| shared `G.uNight` etc. | `GN.uNight` (common.ts); any other `{ value }` object: `shared(obj)` |
| `int` flags `(f & 4) != 0` | `f.bitAnd(4).notEqual(0)` |
| `x ? a : b` | `select(x, a, b)` |
| `fogColor` | see `fogColor()` in ground.ts |
| hashes/noise h11 h21 h31 vnoise fbm2 | common.ts |
| `onBeforeRender` on a material | not called by WebGPURenderer: use `uniform(...).onRenderUpdate(...)` or `onObjectUpdate` instead |
| `customDepthMaterial` | not used: the shadow pass uses the material's `positionNode` (or `castShadowPositionNode`) |

## Traps (each cost a debugging round)

- **Shared nodes first used inside a branch.** `normalView`, `normalWorldGeometry`, `positionWorld`
  etc. are vars assigned where first generated. If that is inside an `If` (or a `select` whose
  branches are not trivial), they stay unset outside it: black lighting. Do
  `const nW = normalWorldGeometry.toVar()` at the top of the function before any branch.
- `.toVar()` puts the value on the stack at that point; plain expressions are inlined where used.
  Make anything used more than once, or assigned to, a `.toVar()`.
- No early `return` with a value in `Fn`: flatten with a `done` flag (`bool(false).toVar()`) or
  nested `If/ElseIf/Else`. Struct results: `struct({...}, 'Name')`, call it like a function,
  `.toVar('name')` once, read with `.get('field')` (see facade.ts).
- `Fn` with a layout (`{ a: 'float', return: 'vec3' }`) becomes a real function; without one it is
  inlined. Loops: `Loop(n, ({ i }) => ...)`, `Break()`.
- An `InstancedBufferGeometry` must have a finite `instanceCount` (default Infinity breaks WebGPU).
- Integer / uint math: `int()`, `uint()`, `.shiftRight`, `.bitXor`, `.mod` (see parcel hashes in ground.ts).
- `ShaderMaterial`/`RawShaderMaterial`/`onBeforeCompile` are ignored by the WebGPU renderer (it
  logs `Material "ShaderMaterial" is not compatible` and draws a default material).

## Checking

`npx tsc --noEmit -p .` must pass. Visual checks run the game with `?gpu=webgpu-gl` (headless
SwiftShader) or `?gpu=webgpu` (real GPU) next to plain WebGL; `renderer.gl.debug.getShaderAsync(scene,
camera, mesh)` shows the generated shader.

## Pipelines built ahead must match

three keys each render pipeline by the material, the object (instanced meshes by uuid), the
scene's environment and fog nodes, the lights, and the render context, which includes the depth
of nested `render()` calls. `compileAsync` only helps when all of these are the same as in the
frame: compile through `Renderer.compileAsync` (it targets the scene's render target at the top
level, like `Post.render`), never swap `scene.environment` for a new texture, and don't render
the scene from inside a node (`pass()`).

## Shaders shared between materials

three builds each pipeline one after the other (compileAsync waits for every pipeline before the
next object), ~100 ms each on the PC, so every distinct shader counts. Two materials share a
pipeline only when their WGSL is identical, and a `uniformArray` / `buffer` is written into the
code as `NodeBuffer_<node id>`, a new name per material: give each one a fixed name with
`.setName('uTile')` (unique within one shader). Instanced matrices go through the attribute path
where they fit (shareInstancedShaders in `webgpu/index.ts`); a material whose nodes read the
matrix again declares how many attribute slots that takes in `userData.instanceReads` (default 4),
and reads only what it needs (`instanceTranslationOf` is one slot).

Apart from the pipeline, every material with its own node instances gets its own node build (the
node cache key is made of node ids), which is a stall of its own whenever a new one first draws.
Materials that differ only in values therefore share one graph (`webgpu/sharedGraph.ts`): the graph
is built once per kind, every caller gets a clone with the same nodes, and the uniforms read the
drawn material's own values in `onObjectUpdate`. People (skin, garments, fur shells, eyes, hair,
horns, lashes, simple parts) and the destroyed-element facades and glass work this way. Rules:
material properties that vary go in `params` (set on the clone), never in the graph; own setup
hooks are copied to the clone; a texture that varies per material is set from another uniform's
`onObjectUpdate` (`elemState` in `webgpu/common.ts`), because a TextureNode resets its own update
type when it is built.

## Dynamic attributes

WebGPU uploads an attribute with `DynamicDrawUsage` again on every frame, whole; WebGL takes the
usage as a hint and uploads on `needsUpdate`. The game sets `needsUpdate` everywhere, so the kit
maps DynamicDrawUsage to StaticDrawUsage on WebGPU (`noPerFrameUploads`). Mark changes with
`needsUpdate` (or `addUpdateRange` + `needsUpdate`), never rely on per-frame uploads.

## Parallel compiles

Most of WebGPU's loading time is GPU pipeline compiles (`&buildlog` prints the time spent in the
WebGPU API calls). three's compileAsync waits for each object's pipeline before the next, and the
game ran one compileAsync at a time because two whose node builds interleave (async builds yield to
the main thread) produce broken shaders. `oneNodeBuildAtATime` (webgpu/index.ts) queues the async
node builds instead, so `Renderer.compileAsync` runs up to four calls at once and their pipelines
compile in parallel; the warm-up compiles the scene in parts for that (`compileParts`). Internal:
wraps `renderer._nodes.getForRenderAsync` (r186); without it, compiles run one at a time as before.
