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
