/**
 * Weather in the world: follows the seeded schedule (world/weather.ts) or a chosen state
 * (pause menu / admin console), and applies it — sky, light and fog (via SkySystem.wx), wet
 * streets (G.uWet), wind in the trees, rain streaks round the camera, lightning (a flash in
 * the sky and a brief ambient boost: no real light) with thunder delayed by distance, the
 * rain / wind ambience, and the city's reaction (fewer people out, the rest hurrying or under
 * umbrellas, some sheltering under awnings and bus stops when it starts, terraces emptying,
 * cars slower with their lights on, birds staying down, thunder making people look up).
 */
import * as THREE from 'three';
import type { Game } from '../game/Game';
import { WeatherSchedule, WEATHER, WEATHER_KINDS, WEATHER_LABEL, climateOf, stepWet, type WeatherKind, type WeatherParams } from '../world/weather';
import { G } from './materials/globals';
import { vegetationUniforms } from '../props/vegetation';
import { clamp, lerp, smoothstep } from '../core/math';
import { hash32, hashToFloat } from '../core/rng';
import { heldItem } from '../humanoid/client/wardrobe';
import { PState, type PedAgent } from '../sim/Pedestrians';

const KEY = 'scale.weather';
/** Rain streaks at full intensity (2 vertices each). */
const DROPS = 12000;

export type WeatherSetting = WeatherKind | 'auto';

/** Text glyphs (text presentation, not emoji) for the HUD. */
export const WEATHER_ICON: Record<WeatherKind, string> = {
  clear: '☀︎', fair: '⛅︎', cloudy: '☁︎', overcast: '☁︎', drizzle: '☂︎', rain: '☔︎', storm: '⚡︎', fog: '≡',
};

interface Shelter { a: PedAgent; x: number; z: number; yaw: number; wait: number; at: number }

export class Weather {
  readonly schedule: WeatherSchedule;
  /** Current (smoothed) parameters. */
  readonly p: WeatherParams = { ...WEATHER.fair };
  /** Wet ground 0..1. */
  wet = 0;
  /** Lightning flash 0..~1.5 (sky and ambient). */
  flash = 0;
  /** A fixed state instead of the schedule (null: auto). */
  override: WeatherKind | null = loadSetting();
  /** Wind direction (radians, where it blows to). */
  windDir = 0;
  readonly rain: RainFx;
  readonly stats = { strikes: 0, sheltering: 0, umbrellas: 0 };
  private target: WeatherParams = { ...WEATHER.fair };
  private first = true;
  private skipH = 0;
  /** Seconds of quick blending left after a manual change. */
  private manualT = 0;
  private pulses: { t: number; amp: number }[] = [];
  private nextStrike = 8;
  private thunder: { t: number; d: number }[] = [];
  private now = 0;
  private shelters = new Map<PedAgent, Shelter>();
  private wasDry = true;
  /** People holding an umbrella (rigs; weak: the agents come and go). */
  private umbrellas = new WeakSet<PedAgent>();
  private umbCount = 0;
  private ug = 0;
  private cullT = 0;

  constructor(private g: Game) {
    this.schedule = new WeatherSchedule(g.settings.seed, climateOf(g.profile));
    this.rain = new RainFx();
    g.renderer.scene.add(this.rain.mesh);
    this.windDir = hashToFloat(hash32(g.settings.seed ^ 0x77a1)) * Math.PI * 2;
  }

  /** The state shown (HUD, status): the chosen one, or the schedule's. */
  get kind(): WeatherKind {
    if (this.override) return this.override;
    return this.schedule.kindAt(this.g.sky.hoursAbs + this.skipH);
  }

  get label(): string { return WEATHER_LABEL[this.kind]; }

  /** Choose a state, or 'auto' for the schedule. */
  set(k: WeatherSetting): WeatherSetting {
    this.override = k === 'auto' ? null : k;
    this.manualT = 25;
    try { localStorage.setItem(KEY, k); } catch { /* storage unavailable */ }
    return k;
  }

  get setting(): WeatherSetting { return this.override ?? 'auto'; }

  /** Skip ahead to the schedule's next state (and back to auto). */
  next(): WeatherKind {
    const h = this.g.sky.hoursAbs + this.skipH;
    const n = this.schedule.nextChange(h);
    this.skipH += n.start + n.blend - h;
    this.set('auto');
    return n.kind;
  }

  status(): Record<string, unknown> {
    const h = this.g.sky.hoursAbs + this.skipH;
    const n = this.schedule.nextChange(h);
    const r2 = (v: number) => Math.round(v * 100) / 100;
    return {
      kind: this.kind, setting: this.setting, wet: r2(this.wet),
      ...Object.fromEntries(Object.entries(this.p).map(([k, v]) => [k, r2(v)])),
      next: `${n.kind} at ${fmtH(n.start)}`, strikes: this.stats.strikes, sheltering: this.shelters.size, umbrellas: this.stats.umbrellas,
    };
  }

  /** The next states of the schedule (from now), for the console. */
  forecast(n = 8): string[] {
    const h = this.g.sky.hoursAbs + this.skipH;
    const out: string[] = [];
    let i = this.schedule.indexAt(h);
    for (let k = 0; k < n; k++, i++) { const s = this.schedule.segAt(i); out.push(`${fmtH(s.start)} ${s.kind}`); }
    return out;
  }

  update(dt: number): void {
    const g = this.g, sky = g.sky;
    this.now += dt;
    const h = sky.hoursAbs + this.skipH;
    if (this.override) Object.assign(this.target, WEATHER[this.override]); else this.schedule.at(h, this.target);
    // Follow the target: the schedule is smooth already (this only softens jumps of the clock);
    // a manual change blends over ~20 s, the rain coming after the clouds.
    if (this.first) { Object.assign(this.p, this.target); this.wet = this.p.rain > 0.05 ? clamp(0.35 + this.p.rain * 1.2, 0, 1) : 0; this.first = false; }
    this.manualT = Math.max(0, this.manualT - dt);
    const tau = this.manualT > 0 ? 6 : 1.5;
    const k = 1 - Math.exp(-dt / tau), kr = 1 - Math.exp(-dt / (tau * (this.target.rain > this.p.rain ? 1.8 : 0.8)));
    for (const key of Object.keys(this.p) as (keyof WeatherParams)[]) this.p[key] += (this.target[key] - this.p[key]) * (key === 'rain' || key === 'lightning' ? kr : k);
    const p = this.p;
    // Rain only falls from a covered sky (a manual change brings the clouds first).
    p.rain = Math.min(p.rain, this.target.rain * smoothstep(0.5, 0.92, p.cover));
    // Wet ground (game time).
    this.wet = stepWet(this.wet, p.rain, p.sun, (dt * sky.timeScale) / 3600 + (this.manualT > 0 ? dt / 600 : 0));
    G.uWet.value = this.wet;
    this.windDir += (hashToFloat(hash32(Math.floor(h * 2) * 7919)) - 0.5) * dt * 0.002;
    vegetationUniforms.uWind.value = 0.15 + p.wind * 1.7;
    this.lightning(dt);
    // Sky, light, fog.
    const wx = sky.wx;
    wx.cover = p.cover; wx.density = p.density; wx.dark = p.dark; wx.sun = p.sun; wx.fog = p.fog; wx.rain = p.rain; wx.flash = this.flash;
    // Rain round the camera (not indoors or underground).
    const cam = g.renderer.camera;
    const pl = g.player;
    this.ug = clamp(this.ug + (g.camRig?.underground ? dt : -dt) * 2.5, 0, 1);
    const scale = g.freeCam ? clamp(Math.max(1.8, cam.position.y - g.terrain.height(cam.position.x, cam.position.z)) / 6, 0.3, 60) : clamp(pl.height / 1.8, 0.12, 60);
    const out = (1 - sky.indoor) * (1 - this.ug);
    this.rain.update(cam, scale, p.rain * out, p.wind, this.windDir, this.now, G.uDayLight.value, this.flash);
    this.city(dt);
    this.stats.umbrellas = this.umbCount; // (rigs shown with one last frame)
    this.umbCount = 0;
  }

  /** Strikes now and then in a storm: flash pulses, thunder after distance / 343 m/s. */
  private lightning(dt: number): void {
    const p = this.p, g = this.g;
    if (p.lightning > 0.02) {
      this.nextStrike -= dt;
      if (this.nextStrike <= 0) {
        this.nextStrike = (5 + Math.random() * 28) / Math.max(0.04, p.lightning);
        this.strike();
      }
    } else this.nextStrike = Math.max(this.nextStrike, 4);
    let f = 0;
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const q = this.pulses[i], t = this.now - q.t;
      if (t > 1.2) { this.pulses.splice(i, 1); continue; }
      if (t >= 0) f += q.amp * Math.exp(-t / 0.07);
    }
    // A glare from elsewhere (the last resort's flash) fades over a few seconds.
    this.glareK = Math.max(0, this.glareK - this.glareK * Math.min(1, dt * 0.6) - dt * 0.02);
    this.flash = Math.min(1.6, f + this.glareK);
    for (let i = this.thunder.length - 1; i >= 0; i--) {
      const th = this.thunder[i];
      if (this.now < th.t) continue;
      this.thunder.splice(i, 1);
      const near = th.d < 1400;
      // Indoors / underground it is muffled.
      const muf = (1 - 0.6 * g.sky.indoor) * (1 - 0.85 * this.ug);
      g.audio.play2d(near ? 'thunder_near' : 'thunder_far', clamp(1.25 / (1 + th.d / 2500), 0.15, 1) * muf, 0.9 + Math.random() * 0.2);
      if (th.d < 900) g.camRig?.addShake(0.12 * (1 - th.d / 900));
      // A close one makes people near the player flinch and look up (birds lift).
      if (th.d < 2500 && !this.ug) { const P = g.player.pos; g.stimuli.emit('thunder', P.x, P.y, P.z, 3 * (1 - th.d / 2500), 350); }
    }
  }

  /** A glare lighting up the sky and everything (the last resort's flash): it fades over seconds. */
  glare(amp: number): void { this.glareK = Math.max(this.glareK, amp); }
  private glareK = 0;

  /** A lightning strike somewhere round the city (admin: dev.weather.strike()). */
  strike(dist?: number): number {
    const d = dist ?? 350 + Math.pow(Math.random(), 0.7) * 7000;
    const amp = clamp(1.6 / (1 + d / 1800), 0.15, 1.3);
    const a = Math.random() * Math.PI * 2;
    this.g.sky.wx.flashDir.set(Math.cos(a), 0.25 + Math.random() * 0.35, Math.sin(a)).normalize();
    this.pulses.push({ t: this.now, amp });
    const n = 1 + Math.floor(Math.random() * 3);
    let t = this.now;
    for (let i = 0; i < n; i++) { t += 0.06 + Math.random() * 0.16; this.pulses.push({ t, amp: amp * (0.5 + Math.random() * 0.6) }); }
    this.thunder.push({ t: this.now + d / 343, d });
    this.stats.strikes++;
    return Math.round(d);
  }

  // ------------------------------------------------------------------ the city reacts

  private city(dt: number): void {
    const g = this.g, p = this.p;
    const r = p.rain;
    const rainy = smoothstep(0.08, 0.6, r);
    g.peds.outdoorShare = 1 - 0.55 * rainy - 0.1 * p.fog;
    g.peds.paceK = 1 + 0.2 * smoothstep(0.1, 0.5, r);
    g.terraces.rain = r;
    g.traffic.weatherK = 1 - 0.15 * rainy - 0.15 * smoothstep(0.4, 1, p.fog);
    g.vehicles.weatherLights = r > 0.15 || p.fog > 0.45 || p.dark > 0.6;
    g.birds.rain = r;
    // Fewer people out: walkers who would not be out in this go in (only where nobody sees it).
    this.cullT -= dt;
    if (this.cullT <= 0 && g.peds.outdoorShare < 0.98) {
      this.cullT = 0.5;
      const cam = g.renderer.camera, cp = cam.position;
      cam.getWorldDirection(_fwd);
      for (const a of g.peds.agents) {
        if (a.state !== PState.Walk || a.actor || a.inside || a.evac || this.shelters.has(a)) continue;
        if (hashToFloat(hash32(a.cit.seed * 7 + 11)) < g.peds.outdoorShare) continue;
        const dx = a.x - cp.x, dz = a.z - cp.z, d = Math.hypot(dx, dz);
        if (d < 45 || (d < 160 && dx * _fwd.x + dz * _fwd.z > -0.2 * d)) continue;
        a.alive = false;
      }
    }
    // When it starts to rain some walkers hurry under the nearest awning or bus stop for a while.
    if (this.wasDry && r > 0.18) { this.wasDry = false; this.seekShelter(); }
    else if (r < 0.06) this.wasDry = true;
    this.stats.sheltering = 0;
    for (const [a, s] of this.shelters) {
      if (!a.alive || a.actor || a.state === PState.Flee || a.state === PState.Down) { this.shelters.delete(a); continue; }
      if (s.at === 0) {
        if (a.state === PState.Walk && a.wp >= 2 && Math.hypot(a.x - s.x, a.z - s.z) < 1.6) {
          s.at = this.now;
          a.state = PState.Idle; a.speed = 0; a.heading = s.yaw;
          a.stateT = -s.wait; // Idle resumes the route after its usual few seconds
        } else if (a.wp >= 3) this.shelters.delete(a); // went past it (crowded)
        continue;
      }
      this.stats.sheltering++;
      if (a.state === PState.Idle && r < 0.08) a.stateT = Math.max(a.stateT, 0); // it stopped: off they go
      if (a.state !== PState.Idle) this.shelters.delete(a);
    }
    void dt;
  }

  private seekShelter(): void {
    const g = this.g, P = g.player.pos;
    const cand = g.peds.neighbours(P.x, P.z, 120, []);
    let n = 0;
    const taken = new Map<object, number>();
    for (const a of cand) {
      if (n >= 18) break;
      if (a.state !== PState.Walk || a.actor || a.inside || a.evac || this.shelters.has(a)) continue;
      // Those without an umbrella (see heldFor), about half of them.
      if (hashToFloat(hash32(a.cit.seed ^ 0x0b1e)) < 0.8 || hashToFloat(hash32(a.cit.seed ^ 0x5be1)) > 0.5) continue;
      let best: { x: number; z: number; yaw: number } | null = null, bd = 22, bp: object | null = null;
      g.props.query(a.x, a.z, 22, (pr) => {
        if (pr.broken || (taken.get(pr) ?? 0) >= 3) return;
        const awning = pr.kind.startsWith('furn:awning'), bus = pr.kind.startsWith('furn:busStop');
        if (!awning && !bus) return;
        // Under the awning (it reaches out from the wall, local +z) / inside the shelter.
        const fx = Math.sin(pr.yaw), fz = Math.cos(pr.yaw);
        const side = (hashToFloat(hash32(a.id * 31 + 7)) - 0.5) * (awning ? 1.6 : 1.4);
        const out = awning ? 0.8 : 0.1;
        const x = pr.x + fx * out + fz * side, z = pr.z + fz * out - fx * side;
        const d = Math.hypot(x - a.x, z - a.z);
        if (d < bd) { bd = d; bp = pr; best = { x, z, yaw: Math.atan2(fx, fz) + Math.PI }; }
      });
      if (!best || !bp) continue;
      taken.set(bp, (taken.get(bp) ?? 0) + 1);
      const b = best as { x: number; z: number; yaw: number };
      // Detour: to the shelter, then on along the rest of the route.
      const rest = a.route.subarray(Math.min(a.wp, a.route.length / 3 - 1) * 3);
      const route = new Float32Array(6 + rest.length);
      route.set([a.x, a.z, 0, b.x, b.z, 0]);
      route.set(rest, 6);
      a.route = route; a.wp = 1; a.wpD = undefined; a.onRoad = false;
      // Facing out to the street (heading convention: forward is (-sin, -cos)).
      this.shelters.set(a, { a, x: b.x, z: b.z, yaw: Math.atan2(Math.sin(b.yaw), Math.cos(b.yaw)), wait: 15 + hashToFloat(hash32(a.id * 13)) * 45, at: 0 });
      n++;
    }
    return;
  }

  /**
   * Umbrellas in the rain (CrowdRenderer.heldFor, after the terraces): a share of the people
   * out walking; back to their own item when it stops. undefined: no change.
   */
  heldFor(a: PedAgent): string | null | undefined {
    const r = this.p.rain;
    const share = r < 0.08 ? 0 : 0.35 + 0.45 * smoothstep(0.1, 0.6, r);
    const out = !a.inside && !this.shelters.get(a)?.at && a.state !== PState.Sit && a.state !== PState.Down && a.state !== PState.Flee && !a.actor && !this.ug;
    if (out && share > 0 && hashToFloat(hash32(a.cit.seed ^ 0x0b1e)) < share) {
      this.umbrellas.add(a);
      this.umbCount++;
      return 'umbrella';
    }
    if (this.umbrellas.delete(a)) return heldItem(a.cit.seed)?.defId ?? null;
    return undefined;
  }
}

/**
 * Rain streaks in a box round the camera: one line per drop, positions from a per-drop random
 * point moved by the fall velocity and wrapped into the box in the vertex shader (no CPU work
 * per drop). Box, streak length and fall speed scale with the player's size, so a giant sees
 * rain as a person does (and a tiny player too).
 */
class RainFx {
  readonly mesh: THREE.LineSegments;
  /** Tests: hide the streaks (frame-cost comparison). */
  forceHide = false;
  private mat: THREE.ShaderMaterial;

  constructor() {
    const pos = new Float32Array(DROPS * 2 * 3);
    const drop = new Float32Array(DROPS * 2 * 4);
    let s = 0x2545f491;
    const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
    for (let i = 0; i < DROPS; i++) {
      const x = rnd(), y = rnd(), z = rnd(), w = rnd();
      for (let e = 0; e < 2; e++) {
        const v = i * 2 + e;
        pos[v * 3] = e; // 0 head, 1 tail
        drop.set([x, y, z, w], v * 4);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aDrop', new THREE.BufferAttribute(drop, 4));
    geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uCam: { value: new THREE.Vector3() }, uBox: { value: 30 }, uVel: { value: new THREE.Vector3(0, -9, 0) }, uLen: { value: 0.05 },
        uT: { value: 0 }, uAlpha: { value: 0 }, uCol: { value: new THREE.Color(0.7, 0.75, 0.8) },
      },
      vertexShader: /* glsl */ `
attribute vec4 aDrop;
uniform vec3 uCam; uniform float uBox; uniform vec3 uVel; uniform float uLen; uniform float uT;
varying float vA;
void main() {
  // Each drop falls at its own speed (90..110 %); wrapped into the box round the camera.
  vec3 vel = uVel * (0.9 + 0.2 * aDrop.w);
  vec3 o = uCam - vec3(uBox * 0.5);
  vec3 head = o + mod(aDrop.xyz * uBox + vel * uT - o, vec3(uBox));
  vec3 p = head - vel * uLen * position.x;
  // Fade at the box faces (no popping as drops wrap) and right in front of the lens.
  vec3 q = abs(head - uCam) / (uBox * 0.5);
  float edge = 1.0 - smoothstep(0.7, 1.0, max(max(q.x, q.y), q.z));
  float dc = length(head - uCam) / uBox;
  vA = edge * smoothstep(0.015, 0.06, dc) * (0.55 + 0.45 * aDrop.w) * (1.0 - 0.6 * position.x);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`,
      fragmentShader: /* glsl */ `
uniform float uAlpha; uniform vec3 uCol;
varying float vA;
void main() { gl_FragColor = vec4(uCol, vA * uAlpha); }`,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.LineSegments(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 900;
    this.mesh.name = 'rain';
  }

  update(cam: THREE.Camera, scale: number, rain: number, wind: number, windDir: number, t: number, day: number, flash: number): void {
    const n = rain < 0.01 ? 0 : Math.round(DROPS * clamp(0.12 + rain * 0.95, 0, 1));
    this.mesh.geometry.setDrawRange(0, n * 2);
    this.mesh.visible = n > 0 && !this.forceHide;
    if (!n) return;
    const u = this.mat.uniforms;
    u.uCam.value.copy(cam.position);
    // (Less than in proportion for a giant: what it sees is mostly near, between it and the next towers.)
    u.uBox.value = 26 * Math.pow(scale, 0.75);
    // Fall ~8 m/s at person size (faster for a giant, so it reads the same on screen); the wind slants it.
    const fall = 8.5 * Math.pow(scale, 0.8);
    const w = wind * 4 * Math.pow(scale, 0.8);
    u.uVel.value.set(Math.cos(windDir) * w, -fall, Math.sin(windDir) * w);
    u.uLen.value = 0.06 * Math.pow(scale, 0.2); // streaks as long as the box is big (on screen the same at any size)
    u.uT.value = t % 1000;
    u.uAlpha.value = lerp(0.18, 0.42, smoothstep(0.1, 0.9, rain)) * lerp(0.45, 1, day) + flash * 0.4;
    u.uCol.value.setRGB(lerp(0.32, 0.72, day) + flash, lerp(0.35, 0.76, day) + flash, lerp(0.42, 0.82, day) + flash);
  }
}

const _fwd = new THREE.Vector3();

function fmtH(h: number): string {
  const d = Math.floor(h / 24), hr = ((h % 24) + 24) % 24, hh = Math.floor(hr), mm = Math.floor((hr - hh) * 60);
  return `day ${d} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function loadSetting(): WeatherKind | null {
  try {
    const v = localStorage.getItem(KEY);
    return v && (WEATHER_KINDS as readonly string[]).includes(v) ? (v as WeatherKind) : null;
  } catch { return null; }
}
