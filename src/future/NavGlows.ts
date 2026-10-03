/**
 * Additive glow dots for small lights (drone navigation lights and strobes): camera-facing
 * quads that keep a minimum size on screen, so the blinking lights read in the night sky
 * long after the model itself is sub-pixel. Kinds: 0 steady, 1 anti-collision double
 * flash, 2 police red / blue.
 */
import * as THREE from 'three';
import { G } from '../render/materials/globals';
import { furnitureUniforms } from '../props/furniture';

export class NavGlows {
  readonly mesh: THREE.InstancedMesh;
  private col: THREE.InstancedBufferAttribute;
  private ph: THREE.InstancedBufferAttribute;
  private n = 0;
  private cam: THREE.Vector3 = new THREE.Vector3();
  private m = new THREE.Matrix4();
  /** Shared clock with the furniture shader, so glows blink in step with the lamps on the models. */
  readonly uniforms = { uTime: furnitureUniforms.uTime, uNight: G.uNight };

  constructor(private cap: number) {
    const g = new THREE.PlaneGeometry(1, 1);
    g.setAttribute('sUv', g.getAttribute('uv').clone());
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const ph = this.ph = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iGlow', this.col);
    g.setAttribute('iPhase', ph);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const u = this.uniforms;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = u.uTime; sh.uniforms.uNight = u.uNight;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec2 sUv; attribute vec4 iGlow; attribute float iPhase;
varying vec2 vG; varying vec4 vGlow; varying float vPh;`)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvG = sUv; vGlow = iGlow; vPh = iPhase;')
        .replace('#include <project_vertex>', `
vec4 cW = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
float s = length(instanceMatrix[0].xyz);
vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
vec4 mvPosition = viewMatrix * vec4(cW.xyz + (camR * transformed.x + camU * transformed.y) * s, 1.0);
gl_Position = projectionMatrix * mvPosition;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform float uTime; uniform float uNight;
varying vec2 vG; varying vec4 vGlow; varying float vPh;`)
        .replace('#include <map_fragment>', `
{
  vec2 q = vG * 2.0 - 1.0;
  float r2 = dot(q, q);
  float a = exp(-r2 * 7.0) + 0.6 * exp(-r2 * 40.0);
  vec3 c = vGlow.rgb;
  float k = 1.0;
  int kind = int(vGlow.a + 0.5);
  if (kind == 1) { float ph = fract(uTime * 0.9 + vPh); k = step(ph, 0.04) + step(abs(ph - 0.13), 0.02); }
  else if (kind == 2) { bool red = fract(uTime * 2.0 + vPh) < 0.5; c = red ? vec3(1.0, 0.08, 0.05) : vec3(0.1, 0.25, 1.0); k = step(0.5, fract(uTime * 8.0)); }
  // Steady lights mostly at dusk and night; strobes are seen in daylight too.
  float vis = kind == 0 ? uNight : mix(0.35, 1.0, uNight);
  diffuseColor.rgb = c * a * k * vis * 2.2;
}`);
    };
    mat.customProgramCacheKey = () => 'future-navglow-v1';
    this.mesh = new THREE.InstancedMesh(g, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
  }

  begin(cam: THREE.Camera): void {
    this.n = 0;
    this.cam.copy(cam.position);
  }

  /** A light at world position p, colour (linear), kind and blink phase. */
  push(p: THREE.Vector3, r: number, g: number, b: number, kind: number, phase: number): void {
    if (this.n >= this.cap) return;
    const i = this.n++;
    // ~5 px at any distance (vertical fov ≈ 60°, 720 px), never smaller than the lamp itself.
    const s = Math.max(0.16, p.distanceTo(this.cam) * 0.01);
    this.m.makeScale(s, s, s).setPosition(p);
    this.mesh.setMatrixAt(i, this.m);
    this.col.setXYZW(i, r, g, b, kind);
    this.ph.setX(i, phase);
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.col.needsUpdate = true;
    this.ph.needsUpdate = true;
  }
}
