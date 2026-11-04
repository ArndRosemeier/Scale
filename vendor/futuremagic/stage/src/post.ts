/**
 * The post chain: the scene drawn into a render target of its own, then bloom, then the renderer's
 * tone curve, then FXAA. Hand `target` and `draw` to the Stage (StageOptions), so shaders are compiled
 * against that target and the chain's own shaders are built in the warm-up, not on the render path.
 *
 * The scene is drawn by `draw` itself, at the top level, not by a `pass()` node inside the pipeline:
 * three keys a render context by call depth too, and a pass draws one level down (inside the
 * pipeline's own quad), so everything the Stage compiled ahead at the top level was built again in
 * play, shadows included.
 */
import { DepthTexture, FloatType, HalfFloatType, Matrix4, NodeMaterial, QuadMesh, RenderPipeline, RenderTarget, Vector2, WebGLCoordinateSystem, type Camera, type Material, type Node, type Scene, type WebGPURenderer } from 'three/webgpu';
import { abs, convertToTexture, float, mix, positionWorld, renderGroup, renderOutput, texture, uniform, vec2, vec4 } from 'three/tsl';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { ao as gtao } from 'three/examples/jsm/tsl/display/GTAONode.js';
import { depthAwareBlur } from 'three/examples/jsm/tsl/display/depthAwareBlur.js';
import { fxaa } from 'three/examples/jsm/tsl/display/FXAANode.js';

export interface PostOptions {
  /** Glow around what is brighter than `threshold` (scene light before exposure); off without it. */
  bloom?: { strength: number; radius: number; threshold: number };
  /**
   * Multisampling of the scene target (default 0). On WebGL2 resolving a multisampled float depth
   * buffer fails (glBlitFramebuffer) and the frame comes out black, so smoothing is FXAA by default.
   */
  samples?: number;
  /** FXAA after the tone curve (default true). */
  fxaa?: boolean;
  /**
   * Ambient occlusion (GTAO, half resolution, blurred along surfaces): contact shade in corners and
   * under things, on indirect light only (sky, environment), not on the sun or lamps. Lit materials read
   * the frame before's AO (one more texture in every lit shader). `radius` in world units; `strength`
   * 0..1 how dark full occlusion makes the indirect light.
   */
  ao?: { radius: number; strength: number; samples?: number };
  /** A float depth buffer for the scene target (a reversed depth buffer needs one; default true). */
  floatDepth?: boolean;
  /**
   * A veil over the drawn scene before bloom and the tone curve (the water a camera is under, or the waterline across
   * it): the scene's colour and its depth buffer's value in, the colour out. Built once with the chain.
   */
  veil?: (color: Node<'vec4'>, depth: Node<'float'>) => Node<'vec4'>;
}

/**
 * Work slotted into a frame (a portal's view, src/portal.ts): `before` runs before the scene is drawn (the
 * renderer's target as the caller left it), `between` after the scene is drawn into the chain's target and
 * before bloom and the tone curve, with that target still set: what it draws there is graded with the rest.
 * A `between` that draws must turn the renderer's autoClear off, or it clears the scene away.
 */
export interface PostHooks {
  before?(): void;
  between?(): void;
}

export interface Post {
  /** Draws one frame through the chain (`hooks`: work slotted in, see PostHooks). */
  draw(hooks?: PostHooks): void;
  /**
   * A second target just like the scene's (size, colour and depth formats, samples): a view drawn into it builds
   * no new pipeline, since three keys pipelines by those formats, not by the target.
   */
  twin(): RenderTarget;
  /** Where the scene itself is drawn (compile against it). */
  target(): RenderTarget;
  /** Bloom's knobs, live (uniforms); null without bloom. */
  readonly bloom: { strength: { value: number }; radius: { value: number }; threshold: { value: number } } | null;
  /** Ambient occlusion's knobs, live (uniforms); null without it. */
  readonly ao: { strength: { value: number }; radius: { value: number } } | null;
}

export function createPost(renderer: WebGPURenderer, scene: Scene, camera: Camera, opts: PostOptions = {}): Post {
  const made = () => {
    const d = new DepthTexture(1, 1);
    if (opts.floatDepth ?? true) d.type = FloatType;
    return new RenderTarget(1, 1, { type: HalfFloatType, depthTexture: d, samples: opts.samples ?? 0 });
  };
  const rt = made(), depth = rt.depthTexture!;
  const twins: RenderTarget[] = [];
  let color: Node<'vec4'> = vec4(texture(rt.texture));
  const size = new Vector2();
  const texel = uniform(new Vector2(1, 1));
  let shade: Post['ao'] = null;
  let fixProjection = (): void => {};
  let hooksOff = (fn: () => void): (() => void) => fn;
  let shadeAfter = (): void => {};
  if (opts.ao) {
    // AO darkens indirect light only (hemisphere, environment), never the sun or lamps: three's lighting models
    // multiply their indirect terms by the context's `getAO`. The scene's own depth has to be drawn before AO
    // exists, so lit materials read the AO of the frame before, reprojected with that frame's camera; where the
    // depth there does not match (newly revealed, moved), they take none. No prepass: one scene draw a frame.
    const depthNode = texture(depth);
    const a = gtao(depthNode, null as unknown as typeof depthNode, camera); // no normals: from depth
    a.resolutionScale = 0.5;
    a.samples.value = opts.ao.samples ?? 8;
    a.radius.value = opts.ao.radius;
    fixProjection = webglReversedFix(renderer, camera, a as unknown as GtaoMatrices);
    const raw = a.getTextureNode();
    const across = convertToTexture(vec4(depthAwareBlur(raw, depthNode, vec2(texel.x, 0), camera, 2, opts.ao.radius)));
    const blurred = depthAwareBlur(across, depthNode, vec2(0, texel.y), camera, 2, opts.ao.radius);
    // The AO's uniforms are read by every lit material: in the render group (one buffer per render call), not each
    // object's own (three's default), where the camera matrix changing every frame re-uploaded every lit object's buffer.
    const strength = uniform(opts.ao.strength).setGroup(renderGroup);
    // The AO and the depth it was taken at, half resolution (zero at first: no depth matches, so no AO).
    const held = new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
    const quad = new QuadMesh(new NodeMaterial());
    (quad.material as NodeMaterial).fragmentNode = vec4(blurred, depthNode.r, 0, 1);
    // The camera the held AO was taken with (origin-relative, as positionWorld is), and 0 while another view draws.
    const heldViewProj = uniform(new Matrix4()).setGroup(renderGroup);
    const on = uniform(1).setGroup(renderGroup);
    const reversed = renderer.reversedDepthBuffer, glDepth = renderer.coordinateSystem === WebGLCoordinateSystem && !reversed;
    const sampled = texture(held.texture);
    const factorAt = (): Node<'float'> => {
      const clip = heldViewProj.mul(vec4(positionWorld, 1));
      const ndc = clip.xyz.div(clip.w);
      const uv = ndc.xy.mul(vec2(0.5, -0.5)).add(0.5); // clip to texture coordinates, v down
      const s = sampled.sample(uv);
      const want = glDepth ? ndc.z.mul(0.5).add(0.5) : ndc.z;
      // Reversed depth is about 1/distance, so a relative tolerance is one in distance too.
      const near = reversed ? abs(s.g.sub(want)).lessThan(want.mul(0.04)) : abs(s.g.sub(want)).lessThan(0.002);
      const inside = clip.w.greaterThan(0).and(uv.x.greaterThanEqual(0)).and(uv.x.lessThanEqual(1)).and(uv.y.greaterThanEqual(0)).and(uv.y.lessThanEqual(1));
      return inside.and(near).select(mix(float(1), s.r, strength.mul(on)), float(1));
    };
    // Into the renderer's own context (as three's highPrecision does): a context node of our own instead
    // made the hemisphere and environment light fall away on WebGL (seen, not understood).
    const ctx = (renderer.contextNode as unknown as { value: Record<string, unknown> }).value;
    ctx.getAO = (input: Node<'float'> | null, { material }: { material: Material & { isMeshBasicNodeMaterial?: boolean } }) => {
      if (material.transparent || material.isMeshBasicNodeMaterial) return input; // unlit look: left alone
      const f = factorAt();
      return input !== null ? input.mul(f) : f;
    };
    shade = { strength, radius: a.radius };
    const camView = camera as Camera & { projectionMatrix: Matrix4; matrixWorldInverse: Matrix4 };
    hooksOff = (fn) => () => { on.value = 0; try { fn(); } finally { on.value = 1; } };
    shadeAfter = () => {
      const w = Math.max(1, Math.floor(size.x / 2)), h = Math.max(1, Math.floor(size.y / 2));
      if (held.width !== w || held.height !== h) held.setSize(w, h);
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(held);
      quad.render(renderer);
      renderer.setRenderTarget(prev);
      heldViewProj.value.multiplyMatrices(camView.projectionMatrix, camView.matrixWorldInverse);
    };
  }
  if (opts.veil) color = opts.veil(color, texture(depth).r);
  let out = color;
  let glow: Post['bloom'] = null;
  if (opts.bloom) {
    const b = bloom(color, uniform(opts.bloom.strength), uniform(opts.bloom.radius), uniform(opts.bloom.threshold));
    glow = { strength: b.strength, radius: b.radius, threshold: b.threshold };
    out = color.add(b);
  }
  const pipeline = new RenderPipeline(renderer, out);
  if (opts.fxaa ?? true) {
    pipeline.outputNode = fxaa(renderOutput(out)) as unknown as typeof out;
    pipeline.outputColorTransform = false;
  }
  return {
    draw: (hooks) => {
      renderer.getDrawingBufferSize(size);
      if (rt.width !== size.x || rt.height !== size.y) rt.setSize(size.x, size.y);
      for (const t of twins) if (t.width !== size.x || t.height !== size.y) t.setSize(size.x, size.y);
      if (hooks?.before) hooksOff(hooks.before)();
      texel.value.set(1 / size.x, 1 / size.y);
      fixProjection();
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      if (hooks?.between) hooksOff(hooks.between)();
      renderer.setRenderTarget(prev);
      pipeline.render();
      shadeAfter();
    },
    twin: () => {
      const t = made();
      t.setSize(Math.max(1, rt.width), Math.max(1, rt.height));
      twins.push(t);
      return t;
    },
    target: () => rt,
    bloom: glow,
    ao: shade,
  };
}

/** GTAONode's camera matrices (uniforms it keeps). */
interface GtaoMatrices { _cameraProjectionMatrix: { value: Matrix4 }; _cameraProjectionMatrixInverse: { value: Matrix4 } }

/**
 * GTAO turns depth back into positions the WebGL way (clip z = 2·depth - 1), but a reversed depth
 * buffer on WebGL (clip control) keeps clip z in 0..1. So on that backend it gets the camera's
 * projection followed by that same remap (z' = 2z - w), which its inverse undoes. Elsewhere: no-op.
 */
function webglReversedFix(renderer: WebGPURenderer, camera: Camera, a: GtaoMatrices): () => void {
  if (!renderer.reversedDepthBuffer || renderer.coordinateSystem !== WebGLCoordinateSystem) return () => {};
  const remap = new Matrix4().set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, -1, 0, 0, 0, 1);
  const proj = new Matrix4(), inv = new Matrix4();
  a._cameraProjectionMatrix.value = proj;
  a._cameraProjectionMatrixInverse.value = inv;
  return () => {
    proj.multiplyMatrices(remap, camera.projectionMatrix);
    inv.copy(proj).invert();
  };
}
