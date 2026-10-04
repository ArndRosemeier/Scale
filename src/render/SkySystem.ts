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
  /** Game seconds per real second: real time by default; the pause menu sets it (remembered). */
  timeScale = loadTimeScale();
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
  /**
   * Weather (written by render/Weather before update): cloud cover / opacity / darkness, direct
   * sun left, fog, rain, and a lightning flash (0..~1.5) lighting the clouds towards flashDir.
   */
  readonly wx = { cover: 0.35, density: 0.45, dark: 0, sun: 1, fog: 0, rain: 0, flash: 0, flashDir: new THREE.Vector3(0, 0.5, 1) };
  private cloudT = 0;
  private envBase = 0.1;
  private envWx = -1;

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
    // Weather in the sky shader (the environment sky too, without the flash); stars behind clouds.
    const wx = this.wx;
    const overcast = smoothstep(0.55, 1, wx.cover) * 0.9;
    const skyFog = clamp(wx.fog * 1.1 + wx.rain * 0.25, 0, 1);
    for (const s of [this.sky, this.envSky]) {
      const U = s.material.uniforms;
      U.cloudCoverage.value = wx.cover; U.cloudDensity.value = wx.density; U.cloudDark.value = wx.dark; U.overcast.value = overcast; U.skyFog.value = skyFog;
    }
    this.sky.material.uniforms.flash.value = wx.flash;
    this.sky.material.uniforms.flashDir.value.copy(wx.flashDir);
    (this.stars.material as THREE.PointsMaterial).opacity = night * (1 - smoothstep(0.4, 0.85, wx.cover)) * (1 - skyFog);

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
      this.sun.intensity = 3.2 * smoothstep(-0.05, 0.12, sunUp) * wx.sun;
    } else {
      this.sun.color.setRGB(0.55, 0.65, 0.9);
      this.sun.intensity = 0.25 * night * wx.sun;
    }
    // Under clouds the light is diffuse: less sun, a little more (greyer) sky light; a flash lights everything.
    const dull = 1 - wx.sun;
    this.hemi.intensity = lerp(0.06, 0.75, day) * (1 + 0.35 * dull) * (1 - 0.4 * wx.dark) + wx.flash * 1.4;
    this.hemi.color.setRGB(lerp(0.25, 0.75, day), lerp(0.3, 0.84, day), lerp(0.5, 1.0, day));
    this.hemi.color.lerp(_grey.setScalar((this.hemi.color.r + this.hemi.color.g + this.hemi.color.b) / 3), dull * 0.75);
    this.hemi.color.lerp(_flashCol, clamp(wx.flash, 0, 1));
    this.hemi.groundColor.setRGB(lerp(0.06, 0.38, day), lerp(0.06, 0.34, day), lerp(0.08, 0.28, day));

    // Fog colour follows the horizon.
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.setRGB(lerp(0.03, 0.72, day) + golden * 0.15, lerp(0.04, 0.8, day) + golden * 0.05, lerp(0.07, 0.9, day) - golden * 0.1);
    // Weather: grey haze under clouds, in fog and rain (lit up by a flash).
    const g = lerp(0.035, 0.66 * (1 - 0.6 * wx.dark), day);
    fog.color.lerp(_grey.setRGB(g * 0.96, g, g * 1.03), Math.max(overcast, Math.min(1, wx.fog * 1.3)));
    fog.color.addScalar(wx.flash * 0.2);
    const fogD = 0.00012 + 0.0062 * Math.pow(wx.fog, 2.2) + 0.0011 * wx.rain;
    this.sky.material.uniforms.fogCol.value.copy(fog.color);
    this.envSky.material.uniforms.fogCol.value.copy(fog.color);

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
    this.renderer.toneMappingExposure = lerp(1.6, 0.55, day) * (1 + 0.45 * dull * day) * (1 - 0.45 * wx.dark * day);

    // Environment map refresh when the sun moved noticeably.
    const envWx = wx.cover + wx.dark + skyFog;
    if (this.lastEnvSun.distanceTo(this.sunDir) > 0.02 || Math.abs(envWx - this.envWx) > 0.08) {
      this.lastEnvSun.copy(this.sunDir);
      this.envWx = envWx;
      const rt = this.pmrem.fromScene(this.envScene, 0, 1, 2000);
      if (this.envRT) this.envRT.dispose();
      this.envRT = rt;
      this.scene.environment = rt.texture;
      this.envBase = lerp(0.05, 0.22, day) * (1 - 0.3 * wx.dark);
    }
    // Underground: no sun or sky; a faint neutral fill, dense dark haze, slightly higher exposure.
    const u = this.underground;
    const ind = this.indoor * (1 - u);
    this.scene.environmentIntensity = (this.envBase + wx.flash * 0.25) * (1 - 0.92 * u) * (1 - 0.6 * ind);
    if (ind > 0) {
      this.hemi.intensity *= 1 - 0.7 * ind;
    }
    if (u > 0) {
      this.sun.intensity *= 1 - u;
      this.hemi.intensity = lerp(this.hemi.intensity, 0.05, u);
      this.hemi.color.lerp(_tunnelFill, u);
      this.hemi.groundColor.lerp(_tunnelGround, u);
      fog.color.lerp(_tunnelFog, u);
      fog.density = lerp(fogD, 0.012, u);
      this.renderer.toneMappingExposure = lerp(this.renderer.toneMappingExposure, 0.85, u);
    } else fog.density = fogD;
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
  // Weather: darker / greyer clouds, an overcast sky without blue or sun disc, fog towards the
  // horizon (everywhere in thick fog), lightning lighting the clouds.
  Object.assign(u, { cloudDark: { value: 0 }, overcast: { value: 0 }, flash: { value: 0 }, flashDir: { value: new THREE.Vector3(0, 0.5, 1) }, skyFog: { value: 0 }, fogCol: { value: new THREE.Color() } });
  const fs = (a: string, b: string) => {
    if (!sky.material.fragmentShader.includes(a)) throw new Error(`Sky shader changed: ${a}`);
    sky.material.fragmentShader = sky.material.fragmentShader.replace(a, b);
  };
  fs('uniform float time;', 'uniform float time;\nuniform float cloudDark; uniform float overcast; uniform float flash; uniform vec3 flashDir; uniform float skyFog; uniform vec3 fogCol;');
  fs('vec3 sundiscColor = ( 760.0 * sundisc )', 'vec3 sundiscColor = ( 760.0 * sundisc * ( 1.0 - overcast ) )');
  fs('cloudColor *= max( dayFactor, 0.03 );', `cloudColor *= max( dayFactor, 0.03 );
				cloudColor *= 1.0 - 0.72 * cloudDark;
				cloudColor += vec3( 0.75, 0.8, 1.0 ) * flash * ( 0.25 + 2.5 * pow( max( dot( direction, flashDir ), 0.0 ), 8.0 ) ) * 3.0;`);
  fs('gl_FragColor = vec4( texColor, 1.0 );', `float skyLum = dot( texColor, vec3( 0.2126, 0.7152, 0.0722 ) );
			texColor = mix( texColor, vec3( skyLum ) * ( 0.72 - 0.4 * cloudDark ), overcast );
			texColor += vec3( 0.7, 0.75, 0.9 ) * flash * 0.5 * ( 0.3 + pow( max( dot( direction, flashDir ), 0.0 ), 4.0 ) );
			float hz = 1.0 - smoothstep( -0.02, 0.4, direction.y );
			texColor = mix( texColor, fogCol, clamp( skyFog * mix( hz, 1.0, skyFog * skyFog ), 0.0, 1.0 ) );
			gl_FragColor = vec4( texColor, 1.0 );`);
  if (reversed) {
    sky.material.vertexShader = sky.material.vertexShader.replace('gl_Position.z = gl_Position.w;', 'gl_Position.z = 0.0;');
  }
  return sky;
}

const _grey = new THREE.Color();
const _flashCol = new THREE.Color(0.8, 0.85, 1.0);
const _tunnelFill = new THREE.Color(0.9, 0.85, 0.75);
const _tunnelGround = new THREE.Color(0.35, 0.3, 0.25);
const _tunnelFog = new THREE.Color(0.02, 0.018, 0.015);

const TIME_KEY = 'scale.timeScale';

function loadTimeScale(): number {
  try { const v = Number(localStorage.getItem(TIME_KEY)); return Number.isFinite(v) && v >= 0 && localStorage.getItem(TIME_KEY) !== null ? v : 1; } catch { return 1; }
}

/** Remember the chosen time speed (pause menu, admin console). */
export function saveTimeScale(v: number): void {
  try { localStorage.setItem(TIME_KEY, String(v)); } catch { /* storage unavailable */ }
}
