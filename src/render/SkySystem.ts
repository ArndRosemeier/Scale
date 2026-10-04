/**
 * Day/night cycle: physical sky with clouds, sun and moon light, stars,
 * environment map (PMREM of the sky), fog, and the shared lighting uniforms.
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { G } from './materials/globals';
import { clamp, smoothstep, lerp } from '../core/math';

export class SkySystem {
  readonly sky: Sky;
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xbfd6ff, 0x5a5040, 0.6);
  readonly stars: THREE.Points;
  /** Hours 0..24. */
  hour = 10.5;
  /** Days since the start (weekday = day % 7, 0 = Monday). */
  day = 0;
  /** Game seconds per real second. */
  timeScale = 20;
  private pmrem: THREE.PMREMGenerator;
  private envScene = new THREE.Scene();
  private envSky: Sky;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private lastEnvSun = new THREE.Vector3(0, -2, 0);
  readonly sunDir = new THREE.Vector3();
  private shadowExtent = 120;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, reversed: boolean) {
    this.sky = makeSky(reversed);
    this.sky.scale.setScalar(45000);
    this.sky.renderOrder = -1000;
    this.sky.frustumCulled = false;
    scene.add(this.sky);
    this.envSky = makeSky(false);
    this.envSky.scale.setScalar(1000);
    this.envScene.add(this.envSky);
    this.pmrem = new THREE.PMREMGenerator(renderer);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    scene.add(this.sun, this.sun.target, this.hemi);

    // Stars.
    const n = 4000;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      pos.set([Math.cos(a) * r * 40000, Math.abs(u) * 40000, Math.sin(a) * r * 40000], i * 3);
      const b = 0.4 + Math.random() * 0.6;
      col.set([b, b * (0.9 + Math.random() * 0.1), b * (0.85 + Math.random() * 0.2)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false }));
    this.stars.renderOrder = -999;
    this.stars.frustumCulled = false;
    scene.add(this.stars);
    scene.fog = new THREE.FogExp2(0xbfd0e0, 0.00012);
  }

  /** Shadow frustum size around the focus (scales with player size / camera distance). */
  setShadowExtent(m: number): void {
    this.shadowExtent = clamp(m, 15, 3000);
  }

  /** 0..1 while the camera is underground: daylight, sky light and fog give way to tunnel lighting. */
  underground = 0;
  /** 0..1 while the camera is inside a building: sky ambient is mostly shut out (light comes through windows). */
  indoor = 0;
  private cloudT = 0;
  private envBase = 0.1;

  /** Absolute game time in hours. */
  get hoursAbs(): number { return this.day * 24 + this.hour; }

  update(dtReal: number, focus: THREE.Vector3, camera: THREE.Camera): void {
    this.hour += (dtReal * this.timeScale) / 3600;
    if (this.hour >= 24) { this.hour -= 24; this.day++; }
    G.uTime.value += dtReal;
    // Sun path for ~45°N around the equinox.
    const t = ((this.hour - 6) / 24) * Math.PI * 2;
    const elev = Math.sin(t) * 0.8; // radians-ish
    const az = t * 1.0 + 0.4;
    this.sunDir.set(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev) * 0.6 + 0.35).normalize();
    const sunUp = this.sunDir.y;
    const day = smoothstep(-0.12, 0.15, sunUp);
    const night = 1 - smoothstep(-0.2, 0.02, sunUp);
    const golden = smoothstep(0.35, 0.02, sunUp) * day;

    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
    // Clouds drift at real speed; fast time (T / pause menu) speeds them up gently, not linearly.
    this.cloudT += dtReal * (1 + Math.sqrt(Math.max(0, this.timeScale / 20 - 1)) * 2); // 1× at the default 20× day, ~12× at 600×
    this.sky.material.uniforms.time.value = this.cloudT;
    this.envSky.material.uniforms.sunPosition.value.copy(this.sunDir);
    this.sky.position.copy(camera.position);
    this.stars.position.copy(camera.position);
    (this.stars.material as THREE.PointsMaterial).opacity = night;

    // Sun / moon light.
    const lightDir = sunUp > -0.05 ? this.sunDir : new THREE.Vector3(-this.sunDir.x, -this.sunDir.y, -this.sunDir.z);
    const ext = this.shadowExtent;
    // Snap the shadow camera to texels to avoid shimmering.
    const texel = (ext * 2) / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx + lightDir.x * ext * 3, focus.y + lightDir.y * ext * 3, fz + lightDir.z * ext * 3);
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    if (sc.right !== ext) {
      sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext;
      sc.near = 0.5; sc.far = ext * 7;
      sc.updateProjectionMatrix();
    }
    this.sun.shadow.normalBias = 0.02 * ext / 60;
    const sunCol = new THREE.Color().setRGB(1, lerp(0.95, 0.62, golden), lerp(0.9, 0.42, golden));
    if (sunUp > -0.05) {
      this.sun.color.copy(sunCol);
      this.sun.intensity = 3.2 * smoothstep(-0.05, 0.12, sunUp);
    } else {
      this.sun.color.setRGB(0.55, 0.65, 0.9);
      this.sun.intensity = 0.25 * night;
    }
    this.hemi.intensity = lerp(0.06, 0.75, day);
    this.hemi.color.setRGB(lerp(0.25, 0.75, day), lerp(0.3, 0.84, day), lerp(0.5, 1.0, day));
    this.hemi.groundColor.setRGB(lerp(0.06, 0.38, day), lerp(0.06, 0.34, day), lerp(0.08, 0.28, day));

    // Fog colour follows the horizon.
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.setRGB(lerp(0.03, 0.72, day) + golden * 0.15, lerp(0.04, 0.8, day) + golden * 0.05, lerp(0.07, 0.9, day) - golden * 0.1);

    // Shared material uniforms.
    G.uNight.value = night;
    G.uDayLight.value = day;
    G.uSunDir.value.copy(this.sunDir);
    const h = this.hour;
    // Fraction of lit windows over the day: low during the day, peak in the evening, few after 1 am.
    G.uLitFrac.value = h < 5 ? 0.06 : h < 7 ? 0.25 : h < 9 ? 0.15 : h < 17 ? 0.05 : h < 19 ? 0.3 : h < 23 ? 0.55 : 0.25;
    G.uLitFrac.value = lerp(0.04, G.uLitFrac.value, Math.max(night, 0.15));
    G.uShopLit.value = h > 7.5 && h < 21.5 ? 0.92 : 0.12;
    G.uEatLit.value = h > 6.5 && h < 22 ? 0.97 : h >= 22 ? 0.8 : h < 1.5 ? 0.45 : 0.06;
    G.uLampOn.value = smoothstep(0.08, -0.06, sunUp);

    // Exposure: compensate darkness a bit at night.
    this.renderer.toneMappingExposure = lerp(1.6, 0.55, day);

    // Environment map refresh when the sun moved noticeably.
    if (this.lastEnvSun.distanceTo(this.sunDir) > 0.02) {
      this.lastEnvSun.copy(this.sunDir);
      const rt = this.pmrem.fromScene(this.envScene, 0, 1, 2000);
      if (this.envRT) this.envRT.dispose();
      this.envRT = rt;
      this.scene.environment = rt.texture;
      this.envBase = lerp(0.05, 0.22, day);
    }
    // Underground: no sun or sky; a faint neutral fill, dense dark haze, slightly higher exposure.
    const u = this.underground;
    const ind = this.indoor * (1 - u);
    this.scene.environmentIntensity = this.envBase * (1 - 0.92 * u) * (1 - 0.6 * ind);
    if (ind > 0) {
      this.hemi.intensity *= 1 - 0.7 * ind;
    }
    if (u > 0) {
      this.sun.intensity *= 1 - u;
      this.hemi.intensity = lerp(this.hemi.intensity, 0.05, u);
      this.hemi.color.lerp(_tunnelFill, u);
      this.hemi.groundColor.lerp(_tunnelGround, u);
      fog.color.lerp(_tunnelFog, u);
      fog.density = lerp(0.00012, 0.012, u);
      this.renderer.toneMappingExposure = lerp(this.renderer.toneMappingExposure, 0.85, u);
    } else fog.density = 0.00012;
  }
}

function makeSky(reversed: boolean): Sky {
  const sky = new Sky();
  const u = sky.material.uniforms;
  u.turbidity.value = 4;
  u.rayleigh.value = 1.4;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.8;
  u.cloudCoverage.value = 0.35;
  u.cloudDensity.value = 0.45;
  if (reversed) {
    sky.material.vertexShader = sky.material.vertexShader.replace('gl_Position.z = gl_Position.w;', 'gl_Position.z = 0.0;');
  }
  return sky;
}

const _tunnelFill = new THREE.Color(0.9, 0.85, 0.75);
const _tunnelGround = new THREE.Color(0.35, 0.3, 0.25);
const _tunnelFog = new THREE.Color(0.02, 0.018, 0.015);
