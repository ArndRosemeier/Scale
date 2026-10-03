/**
 * Game orchestrator: world setup, streaming, simulation and the frame loop.
 */
import * as THREE from 'three';
import { Renderer } from '../render/Renderer';
import { SkySystem } from '../render/SkySystem';
import { TextureLibrary } from '../render/TextureLibrary';
import { WorkerPool } from '../stream/WorkerPool';
import { CityStreamer } from '../stream/CityStreamer';
import { makeProfile, type CitySettings, type WorldProfile } from '../world/settings';
import { Terrain } from '../world/terrain';
import type { MacroPlan } from '../plan/types';
import { Input } from './Input';
import { Hud } from '../ui/Hud';
import { WorldIndex } from '../world/WorldIndex';
import { Player } from '../player/Player';
import { CameraRig } from '../player/CameraRig';
import { bridgeProfiles } from '../build/bridges';
import { BodyService } from '../humanoid/client/BodyService';
import { clipLibraryReady } from '../humanoid/client/anim/clips';
import { frameWork } from '../core/frameWork';
import { Physics } from '../physics/Physics';
import { Debris } from '../destruction/Debris';
import { Dust } from '../destruction/Dust';
import { Destruction } from '../destruction/Destruction';
import { Collision } from '../world/Collision';
import { Interactions } from './Interactions';
import { Stimuli, noticeRadius } from './Stimuli';
import { Audio } from '../audio/Audio';
import { G } from '../render/materials/globals';
import { clamp, lerp, smoothstep } from '../core/math';
import { installDevtools } from '../debug/devtools';
import { hitch } from '../debug/HitchLog';
import { ShaderGate } from '../render/ShaderGate';
import { RoadNet } from '../sim/RoadNet';
import { Population } from '../sim/Population';
import { Pedestrians } from '../sim/Pedestrians';
import { Reactions } from '../sim/Reactions';
import { CrowdRenderer } from '../sim/CrowdRenderer';
import { bakeCrowdTemplates } from '../sim/CrowdBaker';
import { Traffic, VState, VehicleObstacles, type Vehicle, type VKind } from '../sim/Traffic';
import { VehicleRenderer } from '../sim/VehicleRenderer';
import { PropRenderer } from '../props/PropRenderer';
import { Interiors } from '../interior/Interiors';
import { interiorWarmup } from '../interior/InteriorBuilder';
import { Underground } from '../underground/Underground';
import { Skyline } from '../stream/Skyline';
import { FlightFX } from '../player/FlightFX';
import { Menu } from '../ui/Menu';
import { GameMap } from '../ui/map/GameMap';
import { terrainHoles } from '../render/materials/ground';
import { PropType } from '../plan/cell';
import { hash32 } from '../core/rng';
import type { CellState } from '../stream/CityStreamer';

export class Game {
  readonly renderer: Renderer;
  readonly input: Input;
  sky!: SkySystem;
  streamer!: CityStreamer;
  pool!: WorkerPool;
  terrain!: Terrain;
  profile!: WorldProfile;
  macro!: MacroPlan;
  hud!: Hud;
  world!: WorldIndex;
  player!: Player;
  camRig!: CameraRig;
  freeCam = false;
  physics!: Physics;
  debris!: Debris;
  dust!: Dust;
  destruction!: Destruction;
  collision!: Collision;
  interactions!: Interactions;
  stimuli = new Stimuli();
  audio = new Audio();
  tex!: TextureLibrary;
  net!: RoadNet;
  population!: Population;
  peds!: Pedestrians;
  reactions!: Reactions;
  crowd!: CrowdRenderer;
  private simT = 0;
  traffic!: Traffic;
  vehicles!: VehicleRenderer;
  props!: PropRenderer;
  interiors!: Interiors;
  underground!: Underground;
  gate!: ShaderGate;
  skyline!: Skyline;
  flightFx!: FlightFX;
  menu!: Menu;
  map!: GameMap;
  parked = new Map<number, Vehicle[]>();
  private parkedList: Vehicle[] = [];
  private clock = new THREE.Clock();
  private yaw = 0;
  private pitch = -0.1;
  private speed = 15;
  private running = false;

  constructor(canvas: HTMLCanvasElement, readonly settings: CitySettings) {
    this.renderer = new Renderer(canvas);
    hitch.attach(this.renderer.gl, this.renderer.scene);
    this.gate = new ShaderGate(this.renderer.gl, this.renderer.scene, this.renderer.camera, (fn) => this.renderer.asScenePass(fn));
    this.gate.enabled = false; // the start-up warm-up compiles everything present
    (window as unknown as { shaderGate: ShaderGate }).shaderGate = this.gate;
    this.input = new Input(canvas);
  }

  async start(progress: (msg: string, f: number) => void): Promise<void> {
    this.profile = makeProfile(this.settings);
    progress('Generating materials', 0);
    const tex = new TextureLibrary();
    const texP = tex.load((f) => progress('Generating materials', f * 0.5));
    progress('Planning the city', 0.05);
    this.terrain = new Terrain(this.profile);
    // Each city worker holds the terrain and plan and builds whole cells: 4 keep streaming fast
    // (more mainly multiplied memory - all workers live in the tab's process).
    this.pool = new WorkerPool(Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 2)));
    const macroP = this.pool.init(this.settings);
    const [macro] = await Promise.all([macroP, texP]);
    this.macro = macro;
    progress('Building streets', 0.6);
    this.sky = new SkySystem(this.renderer.gl, this.renderer.scene, this.renderer.reversed);
    this.streamer = new CityStreamer(macro, this.pool, tex);
    this.renderer.scene.add(this.streamer.root);
    this.streamer.prepare = (o) => this.renderer.compileAsync(o);
    this.world = new WorldIndex(this.terrain, (id) => macro.cells[id].poly);
    this.world.bridges = bridgeProfiles(macro, this.terrain);
    this.streamer.onCellReady = (c) => this.world.addCell(c);
    this.streamer.onCellEvicted = (c) => this.world.removeCell(c);
    this.tex = tex;
    progress('Waking up the people', 0.62);
    this.physics = new Physics(this.terrain, (x, z) => this.world.groundHeight(x, z));
    await Promise.all([BodyService.get().ready(), clipLibraryReady(), this.physics.init(), this.audio.init()]);
    this.debris = new Debris(this.physics, tex.facade, (x, z, y = 1e9) => this.collision ? this.collision.groundAt(x, z, y, 0) : this.world.groundHeight(x, z, y, 0));
    this.dust = new Dust();
    this.renderer.scene.add(this.debris.group, this.dust.mesh);
    this.destruction = new Destruction(this.streamer, this.world, this.terrain, this.debris, this.dust, tex);
    this.renderer.scene.add(this.destruction.group);
    this.collision = new Collision(this.world, this.destruction, this.streamer);
    this.underground = new Underground(macro, this.terrain, tex, (x, z) => this.terrain.height(x, z) + this.world.surfaceOffset(x, z));
    this.collision.under = this.underground;
    this.underground.onEntrance = (e) => this.props?.addExtra(e.cell, 'metroEntrance', e.x, e.z, Math.atan2(e.dx, e.dz));
    this.underground.onManhole = (cell, x, z, yaw) => this.props?.addExtra(cell, 'manhole', x, z, yaw);
    this.renderer.scene.add(this.underground.group);
    this.net = new RoadNet(macro);
    this.skyline = new Skyline(macro, this.pool, tex.facade);
    this.renderer.scene.add(this.skyline.group);
    const syncSky = () => this.skyline.setLoaded([...this.streamer.cells.values()].filter((c) => c.status === 'ready').map((c) => c.id));
    this.streamer.onCellReady = (c) => {
      hitch.measure('cell:world', () => this.world.addCell(c));
      this.net.markDirty();
      hitch.measure('cell:parked', () => this.addParked(c));
      hitch.measure('cell:props', () => this.props?.addCell(c, macro.cells[c.id].district));
      hitch.measure('cell:underground', () => this.underground.addCell(c));
      hitch.measure('cell:skyline', () => syncSky());
    };
    this.streamer.onCellEvicted = (c) => hitch.measure('cell:evict', () => { this.world.removeCell(c); this.destruction.forgetCell(c); this.net.markDirty(); this.parked.delete(c.id); this.parkedList = [...this.parked.values()].flat(); this.props?.removeCell(c); setTimeout(syncSky, 0); });
    progress('Teaching people to walk', 0.64);
    const templates = await bakeCrowdTemplates((f) => progress('Teaching people to walk', 0.64 + f * 0.1));
    this.crowd = new CrowdRenderer(templates, this.renderer.scene);
    this.renderer.scene.add(this.crowd.group);
    this.crowd.prepare = (o) => this.renderer.compileAsync(o);
    this.population = new Population(macro, this.settings.seed);
    await this.streamer.loadBridges();
    // Start at the main centre, at street level.
    const c = macro.centres[0];
    const cam = this.renderer.camera;
    cam.position.set(c.x, this.terrain.height(c.x, c.z) + 1.7, c.z);
    // Wait for the nearest cells.
    const t0 = performance.now();
    while (performance.now() - t0 < 20000) {
      this.streamer.update(0.3, cam.position);
      const near = [...this.streamer.cells.values()].filter((s) => s.status === 'ready').length;
      progress('Building streets', 0.6 + Math.min(1, near / 12) * 0.4);
      if (near >= 12 || (near > 0 && this.pool.queued === 0 && this.pool.inFlight === 0)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // Player at street level near the centre, on a sidewalk or road (not inside a building).
    this.player = new Player(this.settings.seed, this.world);
    this.player.collision = this.collision;
    let sx = c.x, sz = c.z;
    for (let k = 0; k < 200 && this.world.buildingAt(sx, sz); k++) { sx += (k % 7) * 3 - 9; sz += Math.floor(k / 7) * 3 - 9; }
    this.player.pos.set(sx, this.world.groundHeight(sx, sz) + 0.05, sz);
    this.renderer.scene.add(this.player.rig.object);
    this.camRig = new CameraRig(cam, this.world);
    this.interactions = new Interactions(this.player, this.destruction, this.dust, this.debris, cam, this.camRig, this.world, this.collision, this.stimuli);
    this.interactions.onSound = (id, x, y, z, gain, pitch) => this.audio.play(id, x, y, z, gain, pitch ?? 1, 4 * Math.max(1, this.player.height / 1.8), cam.position);
    this.destruction.onImpact = (e) => {
      this.stimuli.emit(e.kind === 'collapse' ? 'collapse' : e.kind === 'glass' ? 'glass' : 'impact', e.x, e.y, e.z, Math.log10(Math.max(1, e.energy)), noticeRadius(e.energy * 10));
      if (e.kind === 'collapse') {
        this.audio.play('collapse_big', e.x, e.y, e.z, 1, 0.9 + Math.random() * 0.2, 40, cam.position);
        const d = Math.hypot(e.x - this.player.pos.x, e.z - this.player.pos.z);
        this.camRig.addShake(Math.min(0.8, 60 / Math.max(20, d)));
      } else if (e.kind === 'glass') this.audio.play('glass_shatter', e.x, e.y, e.z, 0.8, 1, 6, cam.position);
    };
    this.player.events.onSizeChange = (_h, dir) => { if (Math.random() < 0.05) this.audio.play2d(dir > 0 ? 'grow_rumble' : 'shrink_whoosh', 0.5); };
    this.player.events.onFlightToggle = (f) => { if (f) this.audio.play2d('whoosh_takeoff', 0.7); };
    this.net.build([...this.streamer.cells.values()].filter((c) => c.status === 'ready'));
    this.peds = new Pedestrians(this.population, this.net, this.world, this.terrain, macro, this.streamer);
    this.reactions = new Reactions(this.peds, this.stimuli);
    this.interiors = new Interiors(this.world, this.destruction, this.streamer, this.collision, this.population, this.peds);
    // Indoors the camera collides with the shell, interior walls and floors instead of building prisms.
    this.camRig.solidAt = (x, y, z) => {
      const p = this.player;
      if (this.camRig.underground) return !this.underground.cameraFree(x, y, z, 0.12);
      const inside = this.interiors.insideAt(p.pos.x, p.pos.y + p.height * 0.5, p.pos.z);
      if (inside) return this.interiors.solidIndoors(inside, x, y, z);
      if (y < this.terrain.height(x, z) + 0.05) return true;
      const b = this.world.buildingAt(x, z);
      return !!b && y < b.top && y > b.low && !this.interiors.insideAt(x, y, z);
    };
    this.renderer.scene.add(this.interiors.group);
    this.traffic = new Traffic(this.net, this.peds, this.stimuli, this.terrain, this.profile.rightHand, this.settings.seed);
    this.vehicles = new VehicleRenderer(this.physics);
    this.renderer.scene.add(this.vehicles.group);
    this.props = new PropRenderer(this.terrain, this.profile.warmth, this.physics, this.net, (n, e, off) => this.traffic.signalGreen(n, this.net.edges[e], this.traffic.time + off));
    // Trees, street furniture and vehicles block the player (size-aware, see Collision).
    this.collision.obstacleProviders.push(
      (x0, z0, x1, z1, out) => this.props.obstaclesIn(x0, z0, x1, z1, out),
      new VehicleObstacles(() => [...this.traffic.vehicles, ...this.parkedList]).provider,
    );
    this.renderer.scene.add(this.props.group);
    this.props.onBreak = (p) => this.audio.play(p.tree ? 'tree_crack_fall' : 'metal_bend', p.x, p.y + 1, p.z, 0.8, 1, 8, cam.position);
    for (const c of this.streamer.cells.values()) if (c.status === 'ready') { this.addParked(c); this.props.addCell(c, macro.cells[c.id].district); this.underground.addCell(c); }
    for (const e of this.underground.entrances.values()) this.props.addExtra(e.cell, 'metroEntrance', e.x, e.z, Math.atan2(e.dx, e.dz));
    this.peds.onCarReady = (a) => { if (a.carDest) this.traffic.spawnTrip(a.cit, a.x, a.z, a.carDest.x, a.carDest.z); };
    this.traffic.onAbandon = (v) => {
      const c = v.driver ?? this.population.synthetic(hash32(v.id * 977));
      this.peds.spawnFleeing(c, v.x + Math.cos(v.yaw) * 1.2, v.z - Math.sin(v.yaw) * 1.2, this.player.pos.x, this.player.pos.z);
      this.audio.play('door_open', v.x, v.y + 1, v.z, 0.6, 1, 6, cam.position);
    };
    this.traffic.onHitPed = (v, p) => {
      this.reactions.knockDown(p, v.x, v.z, v.speed * 0.7);
      this.stimuli.emit('crash', p.x, p.y, p.z, 3, 60);
      this.audio.play('tire_screech', v.x, v.y, v.z, 0.8, 1, 10, cam.position);
    };
    this.traffic.onHorn = (v) => this.audio.play(Math.random() < 0.7 ? 'car_horn_short' : 'car_horn_long', v.x, v.y + 1, v.z, 0.7, 0.95 + Math.random() * 0.1, 8, cam.position);
    this.traffic.onCrash = (v, x, y, z) => { this.audio.play('car_crash', x, y, z, 0.9, 1, 10, cam.position); this.stimuli.emit('crash', x, y, z, 4, 80); };
    this.interactions.onStrike = (x, y, z, r, jx, jy, jz) => this.strike(x, y, z, r, jx, jy, jz);
    this.reactions.onScream = (x, y, z, crowd) => this.audio.play(crowd ? 'scream_crowd' : 'scream_single', x, y, z, 0.8, 0.95 + Math.random() * 0.1, 12, cam.position);
    this.crowd.rigGround = (x, y, z) => this.collision.groundAt(x, z, y + 0.4, 0.3);
    // Giants crush people and cars under their feet; collapses crush what is around them.
    this.stimuli.on((s) => {
      if (s.kind === 'stomp') {
        const r = Math.max(0.6, this.player.height * 0.09);
        for (const a of this.peds.agents) if (Math.hypot(a.x - s.x, a.z - s.z) < r) this.reactions.knockDown(a, s.x, s.z, 2);
        if (this.player.height > 6) for (const v of [...this.traffic.vehicles, ...this.parkedList]) if (Math.hypot(v.x - s.x, v.z - s.z) < r + v.length * 0.3) this.traffic.crush(v);
        if (this.player.height > 4) this.props.crush(s.x, s.z, r);
      } else if (s.kind === 'collapse') {
        const r = Math.min(40, Math.max(8, s.radius * 0.04));
        this.props.crush(s.x, s.z, r);
        for (const v of [...this.traffic.vehicles, ...this.parkedList]) {
          const d = Math.hypot(v.x - s.x, v.z - s.z);
          if (d < r) this.traffic.crush(v);
          else if (d < r * 2) { this.vehicles.makeWreck(v, v.x, v.y + 1, v.z, ((v.x - s.x) / d) * 6000, 9000, ((v.z - s.z) / d) * 6000); this.traffic.wreckIt(v); }
        }
      }
    });
    // The map listens to the skyline batches (building boxes, local streets, entrances for the whole city).
    this.map = new GameMap(this);
    this.skyline.start(this.player.pos.x, this.player.pos.z);
    this.flightFx = new FlightFX(this.dust);
    this.renderer.scene.add(this.flightFx.group);
    this.hud = new Hud(this);
    this.menu = new Menu(this);
    installDevtools(this);
    (window as unknown as { prof: Record<string, number> }).prof = this.prof;
    this.running = true;
    this.clock.start();
    document.addEventListener('visibilitychange', this.schedule);
    this.loop();
    // Warm-up behind the loading screen: compile every material in the scene (in parallel
    // where the driver supports it), then keep simulating until frames are calm, so shader
    // variants (shadows, first agents and cars) compile before the player sees anything.
    progress('Preparing shaders', 0.97);
    const tc = performance.now();
    // Content that only appears later (interiors) is compiled now via stand-in meshes.
    const warm = interiorWarmup();
    warm.add(this.gate.warmStandins());
    warm.position.copy(this.player.pos).y -= 50;
    this.renderer.scene.add(warm);
    await this.renderer.compileAsync(this.renderer.scene);
    this.renderer.scene.remove(warm);
    console.log(`[warm-up] compileAsync ${(performance.now() - tc).toFixed(0)} ms`);
    let calm = 0;
    const tw = performance.now();
    while (calm < 20 && performance.now() - tw < 8000) {
      // Wait on the game's own frames (they keep running in background tabs, page timers don't).
      const f0 = performance.now();
      await new Promise<void>((r) => this.frameWaiters.push(r));
      calm = performance.now() - f0 < 45 ? calm + 1 : 0;
      progress('Preparing shaders', 0.97 + Math.min(1, calm / 20) * 0.03);
    }
    hitch.clear();
    // From now on nothing new may stall a frame on a shader compile.
    this.gate.adoptScene();
    this.gate.enabled = true;
    // Background: compile what appears later (all tree species, furniture, …) on driver threads.
    this.gate.precompile(this.props.warmupObject());
  }

  private raf = 0;
  private frameWaiters: (() => void)[] = [];
  private timerPending = false;
  /** Next frame: animation frames when visible, a worker timer when hidden (rAF stops there). */
  private schedule = () => {
    if (!this.running) return;
    if (document.hidden) {
      if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
      if (!this.timerPending) { this.timerPending = true; hiddenTimer(() => { this.timerPending = false; this.loop(); }); }
    } else if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.loop(); });
  };

  private loop = () => {
    if (!this.running) return;
    // Keep simulating in hidden tabs (timer fallback) so background testing works.
    this.schedule();
    const raw = this.clock.getDelta();
    hitch.beginFrame();
    // Hidden tabs are throttled to ~1 Hz: catch up in substeps so the world keeps real time.
    if (document.hidden && raw > 0.12) {
      let left = Math.min(0.4, raw);
      while (left > 0.1) { this.tick(0.05, false); left -= 0.05; }
      this.tick(left, true);
    } else this.tick(Math.min(0.1, raw), true);
    hitch.endFrame();
    if (this.frameWaiters.length) { const w = this.frameWaiters; this.frameWaiters = []; for (const r of w) r(); }
  };

  /** Per-subsystem frame cost (ms, smoothed) — window.prof. */
  readonly prof: Record<string, number> = {};
  private failed = new Set<string>();
  private T(name: string, fn: () => void): void {
    const t0 = performance.now();
    // A failing subsystem must not stop the frame (or rendering); report it once.
    try { fn(); } catch (err) {
      if (!this.failed.has(name)) { this.failed.add(name); console.error(`[${name}]`, err); }
    }
    const ms = performance.now() - t0;
    this.prof[name] = (this.prof[name] ?? ms) * 0.9 + ms * 0.1;
    hitch.section(name, ms);
  }

  private tick(dt: number, render: boolean): void {
    if (this.input.hit('F8')) this.freeCam = !this.freeCam;
    this.T('player', () => {
      if (this.freeCam) this.updateFreeCam(dt);
      else {
        this.player.update(dt, this.input, this.camRig.yaw, this.camRig.pitch);
        this.camRig.underground = this.underground.isUnder(this.player.pos.x, this.player.pos.y + 0.5, this.player.pos.z);
        this.camRig.update(dt, this.player, this.input);
        // In-world panels (elevator buttons) get the click first when the crosshair is on one in reach.
        const hand = _hand.copy(this.player.pos); hand.y += this.player.height * 0.6;
        this.interiors.panels.external = this.usableHint();
        this.interiors.panels.update(this.renderer.camera, hand, this.player.height * 0.9 + 0.5, this.input);
        this.interactions.update(dt, this.input, this.clock.elapsedTime);
      }
    });
    this.stimuli.update(dt);
    this.simT += dt;
    const readyCells = [...this.streamer.cells.values()].filter((c) => c.status === 'ready');
    this.T('net', () => this.net.maybeRebuild(this.simT, readyCells));
    const pp = this.freeCam ? this.renderer.camera.position : this.player.pos;
    this.peds.setPlayer(pp.x, pp.z);
    this.peds.playerObstacle = this.freeCam ? null : { x: this.player.pos.x, z: this.player.pos.z, r: this.player.radius + 0.25, h: this.player.height };
    this.T('peds', () => this.peds.update(dt, this.sky.hoursAbs, pp.x, pp.z, dt * this.sky.timeScale));
    this.T('react', () => this.reactions.update(dt, this.player));
    this.T('interiors', () => this.interiors.update(dt, this.player.pos.x, this.player.pos.y, this.player.pos.z, this.player.height, this.sky.hoursAbs));
    this.traffic.player = this.freeCam ? null : { x: this.player.pos.x, z: this.player.pos.z, r: this.player.radius, h: this.player.height };
    this.T('traffic', () => this.traffic.update(dt, this.sky.hoursAbs, pp.x, pp.z));
    if (!this.freeCam) this.bodyContacts(dt);
    this.T('underground', () => {
      this.underground.update(dt, this.traffic.time, this.renderer.camera, this.player.pos, this.player.height);
      this.updateHoles();
      this.manholeKey();
    });
    this.T('physics', () => this.physics.step(dt));
    this.T('debris', () => { this.debris.update(dt); this.dust.update(dt); this.destruction.update(dt); });
    if (!this.freeCam) this.flightFx.update(dt, this.player, this.renderer.camera, this.world.groundHeight(this.player.pos.x, this.player.pos.z));
    this.T('audio', () => this.updateAudio(dt));
    this.T('framework', () => frameWork.pump());
    this.timeKeys();
    const cam = this.renderer.camera;
    this.T('stream', () => this.streamer.update(dt, cam.position));
    const focus = this.freeCam ? cam.position : this.player.pos;
    this.sky.setShadowExtent(this.freeCam ? 80 + Math.max(0, cam.position.y - this.terrain.height(cam.position.x, cam.position.z)) * 1.5 : 25 + this.player.height * 12 + cam.position.distanceTo(this.player.pos) * 1.2);
    this.sky.underground = clamp(this.sky.underground + (this.camRig.underground ? dt : -dt) * 2.5, 0, 1);
    const cp = this.renderer.camera.position;
    this.sky.indoor = clamp(this.sky.indoor + (this.interiors.insideAt(cp.x, cp.y, cp.z) ? dt : -dt) * 2, 0, 1);
    this.T('sky', () => this.sky.update(dt, focus, cam));
    this.renderer.setBloom(lerp(0.16, 0.08, this.sky.underground));
    if (render) {
      this.T('crowd', () => this.crowd.update(dt, this.simT, this.peds.agents, this.renderer.camera));
      this.T('vehicles', () => this.vehicles.update(dt, this.traffic.vehicles, this.parkedList, this.renderer.camera));
      this.T('props', () => this.props.update(dt, this.renderer.camera));
      this.T('gate', () => this.gate.update());
      this.T('render', () => this.renderer.render());
      this.hud.update(dt);
      this.T('map', () => this.map.update(dt));
      this.input.endFrame();
    }
  }

  private updateFreeCam(dt: number): void {
    const i = this.input;
    this.yaw -= i.mouseDX * 0.0022;
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - i.mouseDY * 0.0022));
    if (i.wheel) this.speed = Math.max(1, Math.min(2000, this.speed * Math.pow(1.25, -i.wheel)));
    const cam = this.renderer.camera;
    cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const r = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const v = new THREE.Vector3();
    if (i.down('KeyW')) v.add(f);
    if (i.down('KeyS')) v.sub(f);
    if (i.down('KeyD')) v.add(r);
    if (i.down('KeyA')) v.sub(r);
    if (i.down('KeyE') || i.down('Space')) v.y += 1;
    if (i.down('KeyQ') || i.down('ControlLeft')) v.y -= 1;
    const sp = this.speed * (i.down('ShiftLeft') ? 5 : 1);
    cam.position.addScaledVector(v, sp * dt);
    const g = this.terrain.height(cam.position.x, cam.position.z) + 0.5;
    if (cam.position.y < g) cam.position.y = g;
  }

  private kickCooldown = 0;

  /** Mass-weighted contacts between the player and pedestrians / vehicles. */
  private bodyContacts(dt: number): void {
    const p = this.player;
    this.kickCooldown -= dt;
    const pm = p.mass, pr = p.radius;
    const near = this.peds.neighbours(p.pos.x, p.pos.z, pr + 1.5, []);
    for (const a of near) {
      if (a.state === 5 || a.inside) continue;
      if (Math.abs(a.y - p.pos.y) > Math.max(1.8, p.height)) continue;
      const dx = p.pos.x - a.x, dz = p.pos.z - a.z;
      const d = Math.hypot(dx, dz);
      const rr = pr + 0.25;
      if (d >= rr || d < 1e-4) continue;
      const nx = dx / d, nz = dz / d, pen = rr - d;
      const am = 70;
      const wp = am / (am + pm), wa = pm / (am + pm);
      p.pos.x += nx * pen * wp; p.pos.z += nz * pen * wp;
      a.x -= nx * pen * wa; a.z -= nz * pen * wa;
      // A walking person kicks a tiny player along.
      if (p.height < 0.6 && a.speed > 0.3 && this.kickCooldown <= 0) {
        const vx = -Math.sin(a.heading) * a.speed, vz = -Math.cos(a.heading) * a.speed;
        p.vel.x += vx * 1.6; p.vel.z += vz * 1.6; p.vel.y += 1.2 + a.speed * 0.6;
        p.grounded = false;
        this.kickCooldown = 0.6;
        this.audio.play('punch_impact', p.pos.x, p.pos.y, p.pos.z, 0.25, 1.6, 2, this.renderer.camera.position);
      }
    }
    // Vehicles: an unseen tiny player is hit; everyone else is pushed out of the car body.
    for (const v of this.traffic.vehicles) {
      const dx = p.pos.x - v.x, dz = p.pos.z - v.z;
      if (dx * dx + dz * dz > (v.length + pr + 2) ** 2) continue;
      const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
      const along = dx * fx + dz * fz, lat = dx * -fz + dz * fx;
      if (Math.abs(along) > v.length / 2 + pr || Math.abs(lat) > v.width / 2 + pr || p.pos.y > v.y + 1.6) continue;
      if (p.mass < 300 && v.speed > 1.5) {
        // Hit by the car.
        p.vel.x = fx * v.speed * 1.2; p.vel.z = fz * v.speed * 1.2; p.vel.y = 2 + v.speed * 0.3;
        p.grounded = false;
        p.pos.x += fx * 0.3; p.pos.z += fz * 0.3;
        if (this.kickCooldown <= 0) { this.audio.play('car_crash', p.pos.x, p.pos.y, p.pos.z, 0.4, 1.3, 4, this.renderer.camera.position); this.kickCooldown = 1; this.camRig.addShake(0.3); }
      } else {
        const pushLat = (v.width / 2 + pr - Math.abs(lat)) * Math.sign(lat || 1);
        p.pos.x += -fz * pushLat; p.pos.z += fx * pushLat;
        if (p.mass > 20000 && v.speed > 0.5) { this.traffic.wreckIt(v); this.vehicles.makeWreck(v, v.x, v.y + 0.8, v.z, -dx * 3000, 4000, -dz * 3000); }
      }
    }
  }

  /** Parked cars from a cell's street plan. */
  private addParked(c: CellState): void {
    if (!c.plan || !this.traffic) return;
    const list: Vehicle[] = [];
    const P = c.plan.props;
    const kinds: VKind[] = ['sedan', 'sedan', 'hatch', 'suv', 'wagon', 'suv', 'hatch', 'van', 'pickup', 'sports', 'sedan', 'delivery'];
    for (let i = 0; i < P.length; i += 6) {
      if (P[i] !== PropType.ParkedCar) continue;
      const seed = P[i + 5];
      const kind = kinds[seed % kinds.length];
      const v: Vehicle = {
        id: 1_000_000 + c.id * 4096 + i / 6, kind, variant: (seed >> 4) % 4, paint: [0, 0, 0], length: kind === 'van' || kind === 'pickup' ? 5.3 : 4.6, width: 1.9,
        edge: -1, fwd: true, lane: 0, s: 0, route: { edges: [], fwd: [] }, ri: 0, speed: 0, vmax: 0, state: VState.Stopped,
        x: P[i + 1], y: this.terrain.height(P[i + 1], P[i + 2]), z: P[i + 2], yaw: P[i + 3], turn: null, brake: 0, indicator: 0, headlights: 0,
        damage: 0, driver: null, stateT: 0, fear: 0, wait: 0, wreck: -1, alive: true,
      };
      list.push(v);
    }
    this.parked.set(c.id, list);
    this.parkedList = [...this.parked.values()].flat();
  }

  /** A physical strike at a point hits cars, people and props. */
  strike(x: number, y: number, z: number, r: number, jx: number, jy: number, jz: number): void {
    const J = Math.hypot(jx, jy, jz);
    this.props.hit(x, y, z, r, jx, jy, jz);
    for (const v of [...this.traffic.vehicles, ...this.parkedList]) {
      const d = Math.hypot(v.x - x, v.z - z);
      if (d > r + v.length / 2 || y > v.y + 3 + r) continue;
      if (J > 2500) {
        this.traffic.wreckIt(v);
        this.vehicles.makeWreck(v, x, y, z, jx, jy, jz);
        this.audio.play('car_crash', v.x, v.y, v.z, Math.min(1, J / 20000 + 0.3), 1, 10, this.renderer.camera.position);
      } else v.damage = Math.min(1, v.damage + J / 5000);
    }
    for (const a of this.peds.agents) {
      const d = Math.hypot(a.x - x, a.z - z);
      if (d < r + 0.4 && J > 150) this.reactions.knockDown(a, x - jx * 0.001, z - jz * 0.001, Math.min(15, J / 400));
    }
  }

  /** Nearest street holes -> terrain shader. */
  private updateHoles(): void {
    const H = this.underground.holes;
    const c = this.renderer.camera.position;
    const list: number[] = [];
    for (let i = 0; i < H.length; i += 6) list.push(i);
    list.sort((a, b) => Math.hypot(H[a] - c.x, H[a + 1] - c.z) - Math.hypot(H[b] - c.x, H[b + 1] - c.z));
    let n = 0;
    for (const i of list.slice(0, 16)) {
      terrainHoles.uHoleA.value[n].set(H[i], H[i + 1], H[i + 2], H[i + 3]);
      terrainHoles.uHoleB.value[n].set(H[i + 4], H[i + 5], 0, 0);
      n++;
    }
    terrainHoles.uHoleN.value = n;
  }

  /** On-screen hint for something usable where the player stands (null: nothing). */
  private usableHint(): string | null {
    if (this.freeCam) return null;
    const p = this.player.pos;
    const under = this.underground.isUnder(p.x, p.y + 0.5, p.z);
    const m = this.underground.nearestManhole(p.x, p.z, under ? 3 : 1.4);
    if (!m) return null;
    if (under) return 'Manhole above — press <b>E</b> to climb out';
    if (this.player.height >= 2.4) return 'A manhole — you are too big to fit through';
    return 'Manhole — press <b>E</b> to open it and climb down into the sewer';
  }

  /** E: open a manhole above a sewer and drop in; underground: climb out at the nearest manhole. */
  private manholeKey(): void {
    if (this.freeCam || !this.input.hit('KeyE')) return;
    const p = this.player.pos;
    const under = this.underground.isUnder(p.x, p.y + 0.5, p.z);
    const m = this.underground.nearestManhole(p.x, p.z, under ? 3 : 1.4);
    if (!m) return;
    if (under) {
      const g = this.world.groundHeight(m.x, m.z);
      p.set(m.x + 0.8, g + 0.2, m.z);
      this.player.vel.set(0, 0, 0);
      this.audio.play('door_close', p.x, p.y, p.z, 0.6, 0.8, 4, this.renderer.camera.position);
    } else if (this.player.height < 2.4) {
      this.underground.openManholes.push({ x: m.x, z: m.z });
      this.underground.holes.push(m.x, m.z, 1, 0, 0.45, 0.45);
      this.props.crush(m.x, m.z, 0.2); // the lid comes off
      p.set(m.x, p.y, m.z);
      this.audio.play('metal_bend', p.x, p.y, p.z, 0.5, 1.4, 4, this.renderer.camera.position);
    }
  }

  private flightSpeedPrev = 0;
  private updateAudio(_dt: number): void {
    const cam = this.renderer.camera;
    this.audio.updateListener(cam);
    const p = this.player;
    const night = G.uNight.value;
    // Context: water nearby, parks, flight, altitude.
    const wl = this.terrain.water(cam.position.x, cam.position.z);
    const nearWater = wl.river >= 0 ? clamp(1 - (wl.d - wl.halfWidth) / 80, 0, 1) : 0;
    const coast = this.terrain.coastDistance(cam.position.x, cam.position.z);
    const nearSea = isFinite(coast) ? clamp(1 - coast / 250, 0, 1) : 0;
    const alt = Math.max(0, cam.position.y - this.terrain.height(cam.position.x, cam.position.z));
    const altFade = 1 - smoothstep(30, 400, alt);
    const speed = p.flying ? p.vel.length() / Math.sqrt(p.k) : 0;
    const wind = p.flying ? clamp(speed / 60, 0.08, 1) : clamp(alt / 300, 0, 0.4);
    const ug = this.underground.isUnder(p.pos.x, p.pos.y + 0.5, p.pos.z);
    const inStation = ug && this.underground.boxes.some((b) => Math.hypot(b.cx - p.pos.x, b.cz - p.pos.z) < b.hu + 5);
    const surf = ug ? 0.08 : 1;
    this.audio.setAmbience({
      amb_sewer: ug && !inStation ? 0.9 : 0,
      amb_metro: inStation ? 0.9 : 0,
      amb_city_day: (1 - night) * 0.9 * altFade * surf,
      amb_city_night: night * 0.9 * altFade * surf,
      amb_river: nearWater * 0.8,
      amb_sea: nearSea * 0.8,
      amb_wind_flight: wind,
    }, { amb_wind_flight: 0.8 + clamp(speed / 120, 0, 0.6) });
    // Sonic boom when crossing Mach 1.
    const v = p.vel.length();
    if (p.flying && v > 343 && this.flightSpeedPrev <= 343) {
      this.audio.play('sonic_boom', p.pos.x, p.pos.y, p.pos.z, 1, 1, 200, cam.position);
      this.stimuli.emit('sonic', p.pos.x, p.pos.y, p.pos.z, 8, 3000);
      this.dust.burst(p.pos.x, p.pos.y, p.pos.z, 30, p.height, 40, p.height * 2 + 10, 1.2, new THREE.Color(0.9, 0.92, 0.95), 0, 0.25);
    }
    this.flightSpeedPrev = v;
  }

  private timeKeys(): void {
    const i = this.input;
    if (i.hit('KeyT')) this.sky.timeScale = this.sky.timeScale === 20 ? 600 : 20;
    if (i.hit('BracketRight')) this.sky.hour = (this.sky.hour + 1) % 24;
    if (i.hit('BracketLeft')) this.sky.hour = (this.sky.hour + 23) % 24;
  }
}

/**
 * Timer for hidden tabs. Chrome throttles page timers in background tabs to
 * about one per minute after a while; dedicated-worker timers are exempt.
 */
let tickWorker: Worker | null = null;
let tickCb: (() => void) | null = null;
function hiddenTimer(cb: () => void): void {
  tickCb = cb;
  if (!tickWorker) {
    try {
      const src = 'onmessage = () => setTimeout(() => postMessage(0), 33);';
      tickWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      tickWorker.onmessage = () => { const f = tickCb; tickCb = null; f?.(); };
    } catch {
      setTimeout(cb, 33);
      return;
    }
  }
  tickWorker.postMessage(0);
}

const _hand = new THREE.Vector3();
