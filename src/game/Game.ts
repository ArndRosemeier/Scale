/**
 * Game orchestrator: world setup, streaming, simulation and the frame loop.
 */
import * as THREE from 'three';
import { Renderer } from '../render/Renderer';
import { Graphics } from '../render/Graphics';
import { SkySystem } from '../render/SkySystem';
import { Weather } from '../render/Weather';
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
import { LandmarkSolids } from '../world/LandmarkSolids';
import { LandmarkWrecks } from '../destruction/LandmarkWreck';
import { ENTRANCE_L } from '../plan/metroDims';
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
import { Later } from '../core/later';
import { Audio } from '../audio/Audio';
import { G } from '../render/materials/globals';
import { clamp, lerp, smoothstep } from '../core/math';
import { installDevtools } from '../debug/devtools';
import { hitch } from '../debug/HitchLog';
import { ShaderGate } from '../render/ShaderGate';
import { warmUp } from '../render/WarmUp';
import { OriginIntro } from './intro/OriginIntro';
import { RoadNet } from '../sim/RoadNet';
import { Population } from '../sim/Population';
import { Pedestrians, PState, type PedAgent } from '../sim/Pedestrians';
import { Reactions } from '../sim/Reactions';
import { CrowdRenderer } from '../sim/CrowdRenderer';
import { bakeCrowdTemplates } from '../sim/CrowdBaker';
import { Traffic, VState, VehicleObstacles, dentCar, type Vehicle, type VKind } from '../sim/Traffic';
import { VehicleRenderer } from '../sim/VehicleRenderer';
import { PropRenderer } from '../props/PropRenderer';
import { NearFuture } from '../future/NearFuture';
import { RagdollSystem, type CarBox } from '../physics/ragdoll/RagdollSystem';
import { Birds } from '../fauna/Birds';
import { LandmarkCrowds, roomFor } from '../sim/LandmarkCrowds';
import { Terraces } from '../sim/Terraces';
import { Interiors } from '../interior/Interiors';
import { interiorWarmup } from '../interior/InteriorBuilder';
import { Underground } from '../underground/Underground';
import { Skyline } from '../stream/Skyline';
import { Countryside } from '../stream/Countryside';
import { RuralStreamer } from '../stream/Rural';
import { terrainExtent } from '../world/boundary';
import { FlightFX } from '../player/FlightFX';
import { Menu } from '../ui/Menu';
import { GameMap } from '../ui/map/GameMap';
import { Compass } from '../ui/Compass';
import { Barks } from '../ui/Barks';
import { setSight, markerOnScreen, screenPoint } from '../render/screen';
import { makeSight } from './sightline';
import { AdminConsole } from '../ui/AdminConsole';
import { ShaderCounter } from '../debug/ShaderCounter';
import { terrainHoles } from '../render/materials/ground';
import { PropType } from '../plan/cell';
import { hash32 } from '../core/rng';
import type { CellState } from '../stream/CityStreamer';
import type { GameMode } from './mode';
import { Progress } from './abilities/Progress';
import { AbilitySystem } from './abilities/AbilitySystem';
import { setAimCursor } from './aimRay';
import { PowerFx } from './abilities/PowerFx';
import { ABILITY, ABILITIES } from './abilities/defs';
import { PowerCores } from './abilities/PowerCores';
import { planCoreSites, LOOT_INFO } from './abilities/cores';
import { Deeds } from './Deeds';
import { PowerHud } from '../ui/PowerHud';
import { PowersScreen } from '../ui/PowersScreen';
import { TouchControls } from '../ui/TouchControls';
import { isTouch } from '../ui/touch';
import { Targeting } from './Targeting';
import { Elements } from './powers/Elements';
import { Consequences } from './Consequences';
import { Sight } from './combat/sight';
import { PowerSynth } from '../audio/PowerSynth';
import { Music } from '../audio/music/Music';
import { TargetHud } from '../ui/TargetHud';
import { SidekickPanel } from '../ui/SidekickPanel';
import { CrimeSystem } from './crime/CrimeSystem';
import { CityNews } from './news/CityNews';
import { crimeIndex } from './crime/CrimeIndex';
import { safeStart } from './news/pulse';
import { planFactions } from './factions/Factions';
import { CITY_GROUPS } from './factions/archetypes';
import { StreetLife } from './street/StreetLife';
import { StationLife } from './metro/StationLife';
import { ThreatDirector } from './threats/ThreatDirector';
import { SlimeRealm } from './slimes/SlimeRealm';
import { ResponseDirector } from './response/ResponseDirector';
import { Forces } from './response/forces/Forces';
import { Aftermath } from './aftermath/Aftermath';
import { HostilePlayer } from './threats/PlayerRampage';
import { SaveSystem } from './save/SaveSystem';
import type { SaveData } from './save/model';
import { PauseSaves, SaveIndicator } from '../ui/SaveUi';
import { Defeat } from './defeat/Defeat';
import { ManholeClimb } from './ManholeClimb';
import { shaftPoint, LADDER_LAT } from '../underground/layout';
import { MedFleet } from './defeat/MedDrones';
import { Arcade } from './Arcade';
import { Wardrobe } from './Wardrobe';
import { People } from './people/People';
import { Fame } from './fame/Fame';
import { Sidekick } from './sidekick/Sidekick';
import type { Companion } from './sidekick/Companion';
import { Wardens } from './aliens/Wardens';
import { POWER_HIT } from './abilities/tuning';
import { downCauseOf, harmCauseOf } from '../shared/cause';

/** What someone a super speed runner brushed past calls after them: stern, not hurt. */
const BRUSH_LINES = ['Hey! Watch it!', 'Slow down, hero!', 'Some of us walk here!', 'Watch where you\'re running!', 'Unbelievable…', 'Mind the people!', 'This is a sidewalk!', 'Show-off!'];

export class Game {
  readonly renderer: Renderer;
  /** Graphics quality: presets, render scale, automatic adaptation to the GPU (render/Graphics). */
  readonly graphics: Graphics;
  readonly input: Input;
  sky!: SkySystem;
  /** Weather: the seeded schedule, sky / light / rain / wet streets, sounds, the city's reaction (render/Weather). */
  weather!: Weather;
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
  /** Game-time callbacks (instead of setTimeout for anything that changes the game). */
  readonly later = new Later();
  audio = new Audio();
  /** Background music (src/audio/music): moods from the game state, stems loaded on first need. */
  music = new Music(this);
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
  future!: NearFuture;
  /** People and the player knocked flying, tumbling, getting up (physics/ragdoll). */
  ragdolls!: RagdollSystem;
  birds!: Birds;
  /** People at the café and restaurant terraces (sim/Terraces). */
  terraces!: Terraces;
  /** People inside the town hall and the cathedral (sim/LandmarkCrowds). */
  halls!: LandmarkCrowds;
  interiors!: Interiors;
  underground!: Underground;
  gate!: ShaderGate;
  skyline!: Skyline;
  countryside!: Countryside;
  rural!: RuralStreamer;
  flightFx!: FlightFX;
  menu!: Menu;
  /** On-screen controls for touch screens (shown in touch mode). */
  touch!: TouchControls;
  map!: GameMap;
  compass!: Compass;
  barks!: Barks;
  admin!: AdminConsole;
  progress!: Progress;
  abilities!: AbilitySystem;
  powerFx!: PowerFx;
  /** Tab targeting (what the powers go for). */
  targeting!: Targeting;
  /** The elemental powers in the world (laser, fire, frost, ice, lightning, quake, wind, water, shrink). */
  elements!: Elements;
  /** Collateral ledger: everything the player's powers did to whom (stub for reputation / karma). */
  readonly consequences = new Consequences();
  /** Line of sight for everybody who shoots (combat/sight). */
  readonly sight = new Sight(this);
  targetHud!: TargetHud;
  matePanel!: SidekickPanel;
  synth!: PowerSynth;
  /** Street crime, police, justice, combat, the player's health, reputation, small deeds (src/game/crime). */
  crime!: CrimeSystem;
  /** The city's own life and its news: live crime index, neighbourhoods, police presence, off-screen crime (game/news). */
  city!: CityNews;
  /** A fresh game's start cell (the calmest neighbourhood near the centre; -1: a loaded save). */
  private startCell = -1;
  /** Street characters: buskers, the doomsayer, living statues, mimes … (src/game/street). */
  street: StreetLife | null = null;
  /** Commuters on the metro's stairs, platforms and trains near the player. */
  stationLife: StationLife | null = null;
  /** City threats (the threat clock, omens, robot malfunctions) and the city's response to them. */
  threats!: ThreatDirector;
  /** The slime civilisation under the city: the Lumen and the Murk, their war, the Lumen's trust. */
  slimeRealm!: SlimeRealm;
  response!: ResponseDirector;
  /** The army: response levels 3 (National Guard) and 4 (army & air) against a major threat (response/forces). */
  forces!: Forces;
  /** The army against a rampaging giant player: the warnings, then the player as a major threat (threats/PlayerRampage). */
  hostile!: HostilePlayer;
  /** Consequences and the last resort (src/game/aftermath): casualty ledger, rescues and triage, the nuke countdown, smoke, the news feed, the carcass cleanup. */
  aftermath!: Aftermath;
  /** The origin scene of a new Normal game (src/game/intro); drives the player and camera while active. */
  intro: OriginIntro | null = null;
  /** Saves: autosave, named saves, loading (src/game/save). */
  saves!: SaveSystem;
  /** Defeated: the rescue drones, the hospital's revival ward, or game over (src/game/defeat). */
  defeat!: Defeat;
  /** Going down / up a manhole (lid, ladder, the street's edge). */
  manhole!: ManholeClimb;
  /** A save to put into the city once it has started (set before `start`, by main.ts). */
  pendingSave: SaveData | null = null;
  /** Where to stream in and put the player (a loaded save's spot; default: the main centre). */
  startAt: { x: number; z: number } | null = null;
  /** Parked cars of the loaded cells. */
  get parkedCars(): Vehicle[] { return this.parkedList; }
  /** Power cores (Normal mode only). */
  cores: PowerCores | null = null;
  deeds!: Deeds;
  /** The city's people as individuals: names, personalities, talking (E), who remembers you (game/people). */
  people!: People;
  /** Fitting mirrors of clothes shops (E: character creator). */
  wardrobe!: Wardrobe;
  arcade!: Arcade;
  /** Reputation made visible: the press, fans, protesters, the hero's statue (game/fame). */
  fame!: Fame;
  /** The second shard and the person who takes it: the sidekick (game/sidekick). */
  sidekick!: Sidekick;
  /** The Wardens: the station in the sky, their discs and walkers, how people take them (game/aliens). */
  wardens!: Wardens;
  powerHud!: PowerHud;
  powers!: PowersScreen;
  parked = new Map<number, Vehicle[]>();
  private parkedList: Vehicle[] = [];
  private clock = new THREE.Timer();
  private yaw = 0;
  private pitch = -0.1;
  private speed = 15;
  private running = false;

  constructor(canvas: HTMLCanvasElement, readonly settings: CitySettings, readonly mode: GameMode = 'normal') {
    this.renderer = new Renderer(canvas);
    this.graphics = new Graphics(this.renderer.gl, this.renderer.webgpu);
    // A start without shadows compiles the shaders without them (the cheapest for weak GPUs).
    this.renderer.gl.shadowMap.enabled = this.graphics.startShadows;
    if (!this.renderer.webgpu) hitch.attach(this.renderer.gl, this.renderer.scene);
    this.gate = new ShaderGate(this.renderer.gl, this.renderer.scene, this.renderer.camera, (fn) => this.renderer.asScenePass(fn));
    this.gate.enabled = false; // the start-up warm-up compiles everything present
    (window as unknown as { shaderGate: ShaderGate }).shaderGate = this.gate;
    if (this.renderer.webgpu) this.gate.gpuCompile = (o) => this.renderer.compileAsync(o);
    this.input = new Input(canvas);
  }

  async start(progress: (msg: string, f: number) => void): Promise<void> {
    const loadT0 = performance.now();
    await this.renderer.init();
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
    this.attachGraphics();
    this.world = new WorldIndex(this.terrain, (id) => macro.cells[id].poly);
    this.world.bridges = bridgeProfiles(macro, this.terrain);
    // Landmarks (town hall, stadium, attractions, airport): solid for the walker, the physics
    // ground and ray casts.
    const landmarks = new LandmarkSolids(macro, this.terrain);
    this.world.landmarks = landmarks;
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
    this.collision.obstacleProviders.push(landmarks.provider);
    this.underground = new Underground(macro, this.terrain, tex, (x, z) => this.terrain.height(x, z) + this.world.surfaceOffset(x, z));
    this.collision.under = this.underground;
    this.world.underRay = (ox, oy, oz, dx, dy, dz, maxT) => this.underground.caveRay(ox, oy, oz, dx, dy, dz, maxT) ?? this.underground.tunnelRay(ox, oy, oz, dx, dy, dz, maxT);
    this.underground.onTrainSound = (id, x, y, z, gain) => this.audio.play(id, x, y, z, gain, 1, 10, this.renderer.camera.position);
    this.underground.onEntrance = (e) => this.props?.addExtra(e.cell, 'metroEntrance', e.x, e.z, Math.atan2(e.dx, e.dz));
    this.underground.onManhole = (cell, x, z, yaw) => this.props?.addExtra(cell, 'manhole', x, z, yaw);
    this.underground.sound = this.audio;
    setSight(makeSight(this.world, () => this.camRig?.underground ?? false, (x, feet, z) => this.underground.feetUnder(x, feet, z)));
    this.stimuli.on((s) => this.underground.onStimulus(s.kind, s.x, s.y, s.z, s.radius));
    this.renderer.scene.add(this.underground.group);
    this.net = new RoadNet(macro);
    this.skyline = new Skyline(macro, this.pool, tex.facade);
    this.renderer.scene.add(this.skyline.group);
    this.countryside = new Countryside(this.pool, terrainExtent(macro.boundary));
    this.renderer.scene.add(this.countryside.group);
    this.rural = new RuralStreamer(this.pool, terrainExtent(macro.boundary), tex);
    this.rural.prepare = (o) => this.renderer.compileAsync(o);
    this.renderer.scene.add(this.rural.group);
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
    await Promise.all([this.streamer.loadBridges(), this.streamer.loadLandmarks()]);
    // The marvels break piece by piece (their meshes came diced).
    if (this.streamer.wrecks.length) {
      this.destruction.landmarks = new LandmarkWrecks(this.streamer.wrecks, this.destruction, this.debris, this.dust, this.terrain, landmarks, tex.facade);
      this.renderer.scene.add(this.destruction.landmarks.group);
    }
    // Start in the calmest neighbourhood near the centre (game/news: a very low crime index), or at
    // a loaded save's spot, at street level.
    if (!this.startAt && !this.pendingSave) {
      const idx = crimeIndex(macro, this.settings.seed);
      const F = planFactions(macro, this.settings.seed, idx, CITY_GROUPS);
      const cell = safeStart(macro, idx, (i) => F.holder[i] >= 0);
      if (cell >= 0) {
        const mc = macro.cells[cell];
        // A corner of the block (on the arterial), a little in toward its middle.
        let bx = mc.poly[0], bz = mc.poly[1], bd = Infinity;
        for (let k = 0; k < mc.poly.length; k += 2) {
          const d = Math.hypot(mc.poly[k] - macro.centres[0].x, mc.poly[k + 1] - macro.centres[0].z);
          if (d < bd) { bd = d; bx = mc.poly[k]; bz = mc.poly[k + 1]; }
        }
        const dx = mc.centroid[0] - bx, dz = mc.centroid[1] - bz, dl = Math.hypot(dx, dz) || 1;
        this.startAt = { x: bx + (dx / dl) * Math.min(14, dl * 0.3), z: bz + (dz / dl) * Math.min(14, dl * 0.3) };
        this.startCell = cell;
      }
    }
    const c = this.startAt ?? macro.centres[0];
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
    // People to hop over at super speed: upright, about head high (lying, seated and indoor ones not).
    this.player.hopPeople = (x0, z0, x1, z1, out) => {
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, r = Math.hypot(x1 - x0, z1 - z0) / 2;
      for (const a of this.peds.neighbours(cx, cz, r, this.hopTmp)) {
        if (!a.alive || a.state === PState.Down || a.state === PState.Sit || (a.inside && !a.hall) || a.ragdoll) continue;
        const o = this.hopObs;
        o.x = a.x; o.z = a.z; o.y0 = a.y; o.y1 = a.y + 1.85;
        out(o);
      }
    };
    let sx = c.x, sz = c.z;
    for (let k = 0; k < 200 && (this.world.buildingAt(sx, sz) || landmarks.onFootprint(sx, sz, 1)); k++) { sx += (k % 7) * 3 - 9; sz += Math.floor(k / 7) * 3 - 9; }
    this.player.pos.set(sx, this.world.groundHeight(sx, sz) + 0.05, sz);
    this.renderer.scene.add(this.player.rig.object);
    this.camRig = new CameraRig(cam, this.world);
    this.interactions = new Interactions(this.player, this.destruction, this.dust, this.debris, cam, this.camRig, this.world, this.collision, this.stimuli);
    this.interactions.onSound = (id, x, y, z, gain, pitch, ref) => this.audio.play(id, x, y, z, gain, pitch ?? 1, ref ?? 4 * Math.max(1, this.player.height / 1.8), cam.position);
    this.destruction.onImpact = (e) => {
      this.stimuli.emit(e.kind === 'collapse' ? 'collapse' : e.kind === 'glass' ? 'glass' : 'impact', e.x, e.y, e.z, Math.log10(Math.max(1, e.energy)), noticeRadius(e.energy * 10));
      if (e.kind === 'collapse') {
        this.audio.play('collapse_big', e.x, e.y, e.z, 1, 0.9 + Math.random() * 0.2, 40, cam.position);
        const d = Math.hypot(e.x - this.player.pos.x, e.z - this.player.pos.z);
        this.camRig.addShake(Math.min(0.8, 60 / Math.max(20, d)));
      } else if (e.kind === 'glass') this.audio.play('glass_shatter', e.x, e.y, e.z, 0.8, 1, 6, cam.position);
    };
    // Buildings: every panel the player breaks and every collapse go into the ledger, booked to
    // whoever broke the building last (crime/Justice prices the player's share). Rubble flying out
    // of a collapse and a flung hero's body are nobody's blow ('world'): never the player's.
    this.destruction.onDamage = (e) => { if (e.cause === 'player') this.consequences.record('impact', 'building', 'facade', e.x, e.z, e.ref); };
    this.destruction.onCollapse = (e) => {
      if (e.cause) this.consequences.record('impact', 'building', 'collapse', e.x, e.z, e.ref, harmCauseOf(e.cause), e.floors);
    };
    this.player.events.onSizeChange = (_h, dir) => { if (Math.random() < 0.05) this.audio.play2d(dir > 0 ? 'grow_rumble' : 'shrink_whoosh', 0.5); };
    this.player.events.onFlightToggle = (f) => { if (f) this.audio.play2d('whoosh_takeoff', 0.7); };
    this.net.build([...this.streamer.cells.values()].filter((c) => c.status === 'ready'));
    this.peds = new Pedestrians(this.population, this.net, this.world, this.terrain, macro, this.streamer);
    // A sewer den's crew walks the underground's floors.
    this.peds.underFloor = (x, y, z) => this.underground.floorAt(x, y, z);
    this.reactions = new Reactions(this.peds, this.stimuli);
    // Blasts and footfalls knock down only those on their side of the pavement.
    this.reactions.sameSide = (ax, ay, az, bx, by, bz) => this.underground.sameSide(ax, ay, az, bx, by, bz);
    this.interiors = new Interiors(this.world, this.destruction, this.streamer, this.collision, this.population, this.peds);
    // The town hall's rooms light up like the buildings' interiors.
    this.interiors.extraLights = (x, y, z) => landmarks.lightsNear(x, y, z);
    // Indoors the camera collides with the shell, interior walls and floors instead of building prisms.
    this.camRig.solidAt = (x, y, z) => {
      const p = this.player;
      if (this.defeat?.inWard) return !this.defeat.ward.cameraFree(x, y, z);
      if (this.camRig.underground) return !this.underground.cameraFree(x, y, z, 0.12);
      const inside = this.interiors.insideAt(p.pos.x, p.pos.y + p.height * 0.5, p.pos.z);
      if (inside) return this.interiors.solidIndoors(inside, x, y, z);
      if (y < this.terrain.height(x, z) + 0.05) return true;
      // Landmark walls and floors (the town hall can be walked into: the camera stays inside).
      if (landmarks.hit(x, y, z)) return true;
      const b = this.world.buildingAt(x, z);
      // (Outside, a building is solid even when its interior is loaded — the camera stayed free
      // in there and swung through the wall into the rooms.)
      return !!b && y < b.top && y > b.low;
    };
    this.renderer.scene.add(this.interiors.group);
    this.traffic = new Traffic(this.net, this.peds, this.stimuli, this.terrain, this.profile.rightHand, this.settings.seed);
    this.traffic.surface = (x, z, hx, hz) => Math.max(this.terrain.height(x, z), this.world.bridgeDeck(x, z, hx, hz));
    this.vehicles = new VehicleRenderer(this.physics);
    this.renderer.scene.add(this.vehicles.group);
    this.props = new PropRenderer(this.terrain, this.profile.warmth, this.physics, this.net, (n, e, off) => this.traffic.signalGreen(n, this.net.edges[e], this.traffic.time + off));
    // Trees, street furniture and vehicles block the player (size-aware, see Collision).
    this.collision.obstacleProviders.push(
      (x0, z0, x1, z1, out) => this.props.obstaclesIn(x0, z0, x1, z1, out),
      (x0, z0, x1, z1, out) => this.countryside.obstaclesIn(x0, z0, x1, z1, out),
      (x0, z0, x1, z1, out) => this.rural.obstaclesIn(x0, z0, x1, z1, out),
      new VehicleObstacles(() => [...this.traffic.vehicles, ...this.parkedList]).provider,
      (x0, z0, x1, z1, out) => this.underground.carObstacles(x0, z0, x1, z1, out),
      this.collision.roofEquipmentIn,
    );
    this.underground.body = this.player;
    this.underground.seatTaken = (x, y, z) => this.peds.neighbours(x, z, 0.4, []).some((a) => Math.abs(a.y - y) < 1 && (a.state === PState.Sit || a.actor?.move === 'sit'));
    this.renderer.scene.add(this.props.group);
    this.props.onBreak = (p) => this.audio.play(p.tree ? 'tree_crack_fall' : 'metal_bend', p.x, p.y + 1, p.z, 0.8, 1, 8, cam.position);
    for (const c of this.streamer.cells.values()) if (c.status === 'ready') { this.addParked(c); this.props.addCell(c, macro.cells[c.id].district); this.underground.addCell(c); }
    for (const e of this.underground.entrances.values()) this.props.addExtra(e.cell, 'metroEntrance', e.x, e.z, Math.atan2(e.dx, e.dz));
    this.peds.onCarReady = (a) => { if (a.carDest) this.traffic.spawnTrip(a.cit, a.x, a.z, a.carDest.x, a.carDest.z); };
    this.peds.entranceNear = (x, z, r) => {
      let best: { x: number; z: number } | null = null, bd = r;
      for (const e of this.underground.entrances.values()) {
        // Top of the stairs: half the opening against the descent direction, plus a step onto the sidewalk.
        const tx = e.x - e.dx * (ENTRANCE_L / 2 + 0.8), tz = e.z - e.dz * (ENTRANCE_L / 2 + 0.8);
        const d = Math.hypot(tx - x, tz - z);
        if (d < bd) { bd = d; best = { x: tx, z: tz }; }
      }
      return best;
    };
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
    // Near-future city: delivery robots, drones, animated signage (src/future).
    this.future = new NearFuture({ seed: this.settings.seed, macro, terrain: this.terrain, world: this.world, streamer: this.streamer, peds: this.peds, traffic: this.traffic, net: this.net, physics: this.physics, debris: this.debris, dust: this.dust, destruction: this.destruction, sound: (id, x, y, z, g, p, r) => this.audio.play(id, x, y, z, g, p, r, cam.position) }, this.stimuli);
    this.future.loop = (id, r) => this.audio.loop(id, r);
    this.collision.obstacleProviders.push(this.future.service.provider);
    this.renderer.scene.add(this.future.group);
    // Birds: pigeons and sparrows on the ground, flocks, gulls and crows (src/fauna).
    this.birds = new Birds({ terrain: this.terrain, world: this.world, peds: this.peds, traffic: this.traffic, drones: this.future.drones, dust: this.dust, debris: this.debris, sound: (id, x, y, z, g, p, r) => this.audio.play(id, x, y, z, g, p, r, cam.position) }, this.stimuli);
    this.renderer.scene.add(this.birds.mesh);
    this.terraces = new Terraces({ seed: this.settings.seed, macro, terrain: this.terrain, world: this.world, streamer: this.streamer, peds: this.peds, pop: this.population, props: this.props, destruction: this.destruction, loop: (id, r) => this.audio.loop(id, r) });
    this.halls = new LandmarkCrowds({
      macro, terrain: this.terrain, world: this.world, peds: this.peds, pop: this.population,
      floor: (x, y, z) => this.world.landmarks?.topAt(x, z, y, 0) ?? -Infinity,
      clear: (x, y, z) => !!this.world.landmarks && roomFor(this.world.landmarks, x, y, z),
      standing: (i) => this.destruction.landmarks?.share(i) ?? 1,
    });
    this.crowd.outfit = (a) => this.halls.outfit(a);
    this.weather = new Weather(this);
    // Cups at the terraces first, then umbrellas in the rain.
    // (Nothing in hand inside a landmark: no coffee in the pews, no umbrella indoors.)
    this.crowd.heldFor = (a) => { if (a.hall) return null; const t = this.terraces.heldFor(a); return t !== undefined ? t : this.weather.heldFor(a); };
    this.crowd.talking = (a, t) => this.terraces.talking(a, t);
    this.interactions.onStrike = (x, y, z, r, jx, jy, jz) => this.strike(x, y, z, r, jx, jy, jz);
    this.reactions.onScream = (x, y, z, crowd) => this.audio.play(crowd ? 'scream_crowd' : 'scream_single', x, y, z, 0.8, 0.95 + Math.random() * 0.1, 12, cam.position);
    this.crowd.rigGround = (x, y, z) => this.collision.groundAt(x, z, y + 0.4, 0.3);
    this.ragdolls = new RagdollSystem({
      physics: this.physics, ground: this.future.ground, peds: this.peds, crowd: this.crowd, player: this.player,
      groundAt: (x, y, z) => this.collision.groundAt(x, z, y, 0.3),
      cars: () => this.carBoxes(),
      underground: (x, y, z) => this.collision.underground(x, y, z),
    });
    const onLand = this.player.events.onLand;
    this.player.events.onLand = (x, y, z, e, h) => {
      onLand?.(x, y, z, e, h);
      this.ragdolls.landed(Math.sqrt((2 * e) / this.player.mass));
    };
    // Giants crush people and cars under their feet (by the size of whoever stepped: the player or a
    // monster, booked to it); collapses crush what is around them.
    this.stimuli.on((s) => {
      if (s.kind === 'stomp') {
        const h = s.size ?? this.player.height, hero = downCauseOf(s.cause) === 'player';
        const r = Math.max(0.6, h * 0.09);
        for (const a of this.peds.agents) if (Math.hypot(a.x - s.x, a.z - s.z) < r && this.underground.sameSide(s.x, s.y, s.z, a.x, a.y, a.z)) this.reactions.knockDown(a, s.x, s.z, 2, downCauseOf(s.cause));
        if (h > 6) for (const v of [...this.traffic.vehicles, ...this.parkedList]) {
          if (v.state === VState.Crushed || Math.hypot(v.x - s.x, v.z - s.z) >= r + v.length * 0.3) continue;
          this.traffic.crush(v);
          if (s.cause !== 'world') this.consequences.record('body', 'car', 'wreck', v.x, v.z, v, s.cause ?? 'player');
        }
        if (h > 4) this.props.crush(s.x, s.z, r);
        // A giant hero's foot comes down on the brood.
        if (hero && h > 3) this.threats?.broodHit(s.x, s.y + 0.3, s.z, r + 0.4, 'blow', 20, 3);
        // A giant hero stamping on a monster's foot or tail.
        if (hero && h > 8) this.threats?.blow(s.x, s.y + h * 0.05, s.z, r, 0, -Math.pow(10, s.intensity / 2) * 80, 0, { cause: 'player', x: s.x, y: s.y, z: s.z });
      } else if (s.kind === 'collapse') {
        const r = Math.min(40, Math.max(8, s.radius * 0.04));
        this.props.crush(s.x, s.z, r);
        for (const v of [...this.traffic.vehicles, ...this.parkedList]) {
          const d = Math.hypot(v.x - s.x, v.z - s.z);
          if (d < r) this.traffic.crush(v);
          // (Armour shrugs off the blast round a collapse; only what falls on it crushes it.)
          else if (d < r * 2 && v.kind !== 'tank' && v.kind !== 'apc') { this.vehicles.makeWreck(v, v.x, v.y + 1, v.z, ((v.x - s.x) / d) * 6000, 9000, ((v.z - s.z) / d) * 6000); this.traffic.wreckIt(v); }
        }
      }
    });
    // The map listens to the skyline batches (building boxes, local streets, entrances for the whole city).
    this.map = new GameMap(this);
    this.compass = new Compass(this);
    this.barks = new Barks(this);
    this.admin = new AdminConsole(this);
    new ShaderCounter(this.renderer.gl as unknown as THREE.WebGLRenderer, this.renderer.webgpu);
    this.skyline.start(this.player.pos.x, this.player.pos.z);
    this.flightFx = new FlightFX(this.dust);
    this.renderer.scene.add(this.flightFx.group);
    this.hud = new Hud(this);
    this.menu = new Menu(this);
    this.setupPowers();
    this.touch = new TouchControls(this);
    installDevtools(this);
    this.defeat = new Defeat(this);
    this.manhole = new ManholeClimb({
      player: this.player, camRig: this.camRig, camera: this.renderer.camera, input: this.input, underground: this.underground, scene: this.renderer.scene,
      hideLid: (x, z) => this.props.flatten(x, z, 0.2),
      sound: (id, x, y, z, gain, pitch) => this.audio.play(id, x, y, z, gain, pitch, 4, this.renderer.camera.position),
    });
    {
      const dev = (window as unknown as { dev?: Record<string, unknown> }).dev;
      // The nearest manhole: stand by it in the street ('down') or in the sewer ('up') and use it.
      if (dev) dev.manhole = (dir: 'down' | 'up' = 'down', r = 400) => {
        const p = this.player.pos, m = this.underground.nearestManhole(p.x, p.z, r);
        if (!m) return 'no manhole within ' + r + ' m';
        this.player.flying = false;
        const at = dir === 'down' ? shaftPoint(m, -0.6, 1.5, this.underground.groundAt(m.x, m.z) - m.floor) : shaftPoint(m, LADDER_LAT - 0.6, 1.8, 0);
        p.set(at[0], at[1], at[2]);
        this.player.vel.set(0, 0, 0);
        this.camRig.snap();
        this.manhole.start(m, dir);
        return { x: m.x, z: m.z, floor: m.floor, side: m.side };
      };
      if (dev) dev.people = { list: () => this.people.report(), forget: () => this.people.forget(), talk: () => this.people.use() };
      if (dev) dev.sidekick = {
        status: () => this.sidekick.status(),
        report: (gang?: boolean) => this.sidekick.devReport(gang),
        go: (back?: number) => this.sidekick.devGo(back),
        take: () => { this.sidekick.take(); return this.sidekick.status(); },
        reset: () => { this.sidekick.devReset(); return this.sidekick.status(); },
        bond: () => this.sidekick.devBond(),
        call: () => { this.sidekick.mate.call(); return this.sidekick.mate.status(); },
        mate: () => this.sidekick.mate.status(),
        power: (p?: string) => { const m = this.sidekick.mate; if (p) m.power = p as typeof m.power; return m.power; },
        karma: (n = 50) => { this.sidekick.mate.earn(n); return this.sidekick.mate.status(); },
        trust: (n?: number) => { const m = this.sidekick.mate; if (n !== undefined) m.trustBy(n - m.trust); return m.trust; },
        ask: (k: 'help' | 'back' | 'home' | 'come') => this.sidekick.mate.ask(k),
        give: (n: number, wish?: string) => this.sidekick.mate.give(n, (wish ?? null) as Parameters<Companion['give']>[1]),
        ko: () => { this.sidekick.mate.devKo(); return this.sidekick.mate.status(); },
        ward: (make?: boolean) => { this.sidekick.mate.devWard(make); return this.sidekick.status(); },
      };
      if (dev) dev.halls = { stats: () => this.halls.stats, list: () => this.halls.report(), go: (kind: 'cathedral' | 'townhall' = 'cathedral') => {
        // Just inside the door, looking in.
        const d = this.halls.door(kind);
        if (!d) return null;
        this.freeCam = false;
        this.player.pos.set(d.x, d.y + 0.1, d.z);
        this.player.vel.set(0, 0, 0);
        this.camRig.yaw = d.yaw;
        return d;
      } };
      this.halls.busy = (a) => this.people.partner === a;
      if (dev) dev.defeat = { status: () => this.defeat.status(), down: (kind?: Parameters<Defeat['down']>[0]) => this.defeat.down(kind), rep: (v: number) => { this.crime.rep.add(v - this.crime.rep.value, 'dev'); return this.crime.rep.value; } };
    }
    this.saves = new SaveSystem(this);
    new PauseSaves(this);
    new SaveIndicator(this);
    if (this.pendingSave) this.saves.apply(this.pendingSave);
    if (OriginIntro.wanted(this)) {
      try { this.intro = new OriginIntro(this); this.intro.prepare(); } catch (e) { console.error('[intro]', e); this.intro = null; }
    }
    (window as unknown as { prof: Record<string, number> }).prof = this.prof;
    this.running = true;
    this.clock.reset();
    document.addEventListener('visibilitychange', this.schedule);
    // Warm-up behind the loading screen (render/WarmUp): textures uploaded, every material compiled
    // in parallel before the first frame (then the frame loop starts), the start looked at from all
    // round, content that only appears later (interiors, trees, furniture) staged via small meshes,
    // then simulating until frames are calm — so nothing compiles or uploads once the player sees it.
    progress('Preparing shaders', 0.97);
    const shadersAt = performance.now();
    const warm = await warmUp(this, (f) => progress('Preparing shaders', 0.97 + f * 0.03), {
      staging: [interiorWarmup(), this.gate.warmStandins()],
      later: [this.props.warmupObject(), this.countryside.warmupObject(), this.rural.warmupObject(), MedFleet.warmupObject(), this.defeat.ward.warmupObject(), Wardens.warmupObject(), ...(this.intro?.stagingObjects() ?? [Sidekick.warmupObject()])],
      views: this.intro?.warmViews(),
    });
    (window as unknown as { warmReport: unknown }).warmReport = warm;
    console.log(`[warm-up] ${warm.totalMs.toFixed(0)} ms: ${warm.textures} textures ${warm.texMs.toFixed(0)} ms, compile ${warm.compileMs.toFixed(0)} ms (${warm.programsCompiled} programs), ${warm.views} views ${warm.viewsMs.toFixed(0)} ms, calm ${warm.calmMs.toFixed(0)} ms, ${warm.programs} programs${warm.nodeBuilds ? `, node builds ${warm.nodeBuilds.join(' / ')} (pipelines ${(window as unknown as { nodeBuilds: { asyncPipes: number } }).nodeBuilds.asyncPipes} in advance, ${(window as unknown as { nodeBuilds: { syncPipes: number } }).nodeBuilds.syncPipes} while drawing)` : ''}`);
    if (warm.gateWaiting.length) console.log(`[warm-up] still waiting for shaders: ${warm.gateWaiting.join(", ")}`);
    console.log(`[load] ${((performance.now() - loadT0) / 1000).toFixed(1)} s in all, ${((performance.now() - shadersAt) / 1000).toFixed(1)} s preparing shaders`);
    hitch.clear();
    // From now on nothing new may stall a frame on a shader compile.
    this.gate.adoptScene();
    this.gate.enabled = true;
    // Background: compile what appears later (all tree species, furniture, …) on driver threads.
    this.gate.precompile(this.props.warmupObject());
    this.gate.precompile(this.countryside.warmupObject());
    this.gate.precompile(this.rural.warmupObject());
    this.gate.precompile(MedFleet.warmupObject());
    this.gate.precompile(this.defeat.ward.warmupObject());
    this.gate.precompile(Wardens.warmupObject());
    void this.intro?.play();
  }

  private raf = 0;
  private frameWaiters: (() => void)[] = [];
  /** Resolves after the next game frame (frames keep running in background tabs, page timers don't). */
  nextFrame(): Promise<void> { return new Promise<void>((r) => this.frameWaiters.push(r)); }
  /** Start the frame loop (the warm-up does, once the scene's shaders are compiled). */
  startLoop(): void { if (!this.raf && !this.timerPending) this.loop(); }
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
    const raw = this.clock.update().getDelta();
    hitch.beginFrame();
    const t0 = performance.now();
    // Hidden tabs are throttled to ~1 Hz: catch up in substeps so the world keeps real time.
    if (document.hidden && raw > 0.12) {
      let left = Math.min(0.4, raw);
      while (left > 0.1) { this.tick(0.05, false); left -= 0.05; }
      this.tick(left, true);
    } else this.tick(Math.min(0.1, raw), true);
    // (While the shader gate still compiles in the background the frames are no measure of the
    // GPU: on WebGPU that runs for many seconds after loading, and auto quality stepped down then.)
    this.graphics.frame(raw * 1000, performance.now() - t0 - this.renderMs, (this.menu?.paused ?? false) || (this.gate?.busy ?? 0) > 0);
    hitch.endFrame();
    if (this.frameWaiters.length) { const w = this.frameWaiters; this.frameWaiters = []; for (const r of w) r(); }
  };

  /** Per-subsystem frame cost (ms, smoothed) — window.prof. */
  readonly prof: Record<string, number> = {};
  private failed = new Set<string>();
  /** CPU time of the last scene render (the graphics auto mode tells simulation from rendering). */
  private renderMs = 0;

  /** The graphics settings drive the renderer, the sun's shadows and the facade LOD. */
  private attachGraphics(): void {
    const r = this.renderer;
    r.onResize = () => this.graphics.apply();
    this.graphics.attach({
      setPixelRatio: (pr) => r.setPixelRatio(pr),
      setPost: (bloom, smaa) => r.setPost(bloom, smaa),
      setShadows: (on, size) => {
        // Started without shadows: turning them on needs the shaders recompiled (a short stall).
        if (on && !r.gl.shadowMap.enabled) {
          r.gl.shadowMap.enabled = true;
          r.scene.traverse((o) => { const m = (o as { material?: THREE.Material | THREE.Material[] }).material; if (m) for (const x of Array.isArray(m) ? m : [m]) x.needsUpdate = true; });
        }
        this.sky.setShadows(on, size);
      },
      setLod: (k) => { this.streamer.lodScale = k; if (this.rural) this.rural.lodScale = k; },
    });
  }

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
      // Cars stop short of a manhole the hero is climbing (the lid lies beside it on the road).
      const ms = this.manhole.spot, H = this.traffic.holds;
      H.length = 0;
      if (ms) H.push({ x: ms.x, z: ms.z, r: 1.7 });
      if (this.intro?.active) this.intro.update(dt);
      else if (this.freeCam) this.updateFreeCam(dt);
      else if (this.defeat.drives) { /* the defeat's scene moves the body and the camera (below) */ }
      else if (this.manhole.active) {
        // Down or up a manhole: the scene moves the body and the camera.
        if (this.defeat.active) this.manhole.abort();
        else this.manhole.update(dt);
        this.interiors.panels.hidePrompt();
      } else {
        this.arcade?.takeInput();
        this.abilities.enabled = !this.powers.open && !this.map.open && !this.people.talking;
        this.abilities.preUpdate(dt, this.input);
        this.defeat.gate();
        this.player.update(dt, this.input, this.camRig.yaw, this.camRig.pitch);
        this.defeat.afterPlayer(dt);
        this.camRig.underground = this.defeat.inWard || this.underground.feetUnder(this.player.pos.x, this.player.pos.y, this.player.pos.z);
        this.camRig.update(dt, this.player, this.input);
        // In-world panels (elevator buttons) get the click first when the crosshair is on one in reach.
        const hand = _hand.copy(this.player.pos); hand.y += this.player.height * 0.6;
        this.interiors.panels.external = this.usableHint();
        this.interiors.panels.update(this.renderer.camera, hand, this.player.height * 0.9 + 0.5, this.input);
        this.abilities.postUpdate(this.input);
        this.targeting.update(dt, this.abilities.enabled ? this.input : null);
        this.interactions.update(dt, this.input, this.clock.getElapsed());
      }
    });
    if (!this.intro?.active && !this.freeCam) this.T('defeat', () => this.defeat.update(dt));
    // (The ward lies deep under the hospital: lit, heard and seen like the underground.)
    if (this.defeat.inWard) this.camRig.underground = true;
    this.stimuli.update(dt);
    this.later.update(dt);
    this.simT += dt;
    const readyCells = [...this.streamer.cells.values()].filter((c) => c.status === 'ready');
    this.T('net', () => this.net.maybeRebuild(this.simT, readyCells));
    const pp = this.freeCam ? this.renderer.camera.position : this.player.pos;
    this.peds.setPlayer(pp.x, pp.z);
    // (At an arcade cabinet the space behind the hero is kept clear too: nobody walks into the view of the screen.)
    this.peds.playerObstacle = this.freeCam ? null : this.arcade?.keepClear() ?? { x: this.player.pos.x, z: this.player.pos.z, r: this.player.radius + 0.25, h: this.player.height };
    this.T('peds', () => this.peds.update(dt, this.sky.hoursAbs, pp.x, pp.z, dt * this.sky.timeScale));
    this.T('react', () => this.reactions.update(dt, this.player));
    this.T('terraces', () => this.terraces.update(dt, this.sky.hoursAbs, pp.x, pp.z));
    this.T('halls', () => this.halls.update(dt, this.sky.hoursAbs, pp.x, pp.z, pp.y));
    this.T('interiors', () => this.interiors.update(dt, this.player.pos.x, this.player.pos.y, this.player.pos.z, this.player.height, this.sky.hoursAbs));
    // Cars only brake for a player on the street (not one under it in the sewer or metro).
    this.traffic.player = this.freeCam || this.underground.feetUnder(this.player.pos.x, this.player.pos.y, this.player.pos.z) ? null : { x: this.player.pos.x, z: this.player.pos.z, r: this.player.radius, h: this.player.height };
    this.T('traffic', () => this.traffic.update(dt, this.sky.hoursAbs, pp.x, pp.z));
    if (!this.freeCam) this.bodyContacts(dt);
    this.T('elements', () => this.elements.update(dt, this.freeCam ? null : this.abilities.channel));
    if (!this.freeCam && !this.intro?.active) this.T('powers', () => { this.deeds.quiet = this.defeat.active; this.deeds.update(dt); this.cores?.update(dt, this.player); });
    this.T('crime', () => { this.crime.update(dt); this.city.update(dt); });
    this.wardrobe?.update(dt);
    this.T('arcade', () => this.arcade?.update(dt));
    this.T('street', () => this.street?.update(dt));
    this.T('people', () => { this.people?.update(dt); if (!this.freeCam) this.sidekick?.update(dt); });
    if (!this.intro?.active) this.T('fame', () => this.fame?.update(dt));
    this.T('threats', () => { this.threats.update(dt); this.response.update(dt); });
    if (!this.freeCam && !this.intro?.active) this.T('slimes', () => this.slimeRealm.update(dt));
    this.T('army', () => { this.hostile.update(dt); this.forces.update(dt); });
    this.T('aftermath', () => this.aftermath.update(dt));
    this.T('underground', () => {
      this.underground.update(dt, this.traffic.time, this.renderer.camera, this.player.pos, this.player.height);
      this.stationLife?.update(dt, this.player.pos.x, this.player.pos.y, this.player.pos.z);
      this.rideFx(dt);
      this.updateHoles();
      this.manholeKey();
    });
    this.T('ragdoll', () => this.ragdolls.update(dt, this.renderer.camera.position));
    this.T('physics', () => this.physics.step(dt));
    this.T('ragdollPost', () => this.ragdolls.post(dt));
    this.T('debris', () => { this.debris.update(dt); this.dust.update(dt); this.destruction.update(dt); });
    if (!this.freeCam) this.powerFx.update(dt, this.abilities.charge, this.abilities.rank('superJump'));
    if (!this.freeCam) this.flightFx.update(dt, this.player, this.renderer.camera, this.world.groundHeight(this.player.pos.x, this.player.pos.z));
    this.T('audio', () => this.updateAudio(dt));
    this.T('framework', () => frameWork.pump());
    this.timeKeys();
    const cam = this.renderer.camera;
    this.T('stream', () => this.streamer.update(dt, cam.position));
    this.T('country', () => this.countryside.update(dt, cam));
    this.T('rural', () => this.rural.update(dt, cam.position));
    const focus = this.freeCam ? cam.position : this.player.pos;
    this.sky.setShadowExtent(this.freeCam ? 80 + Math.max(0, cam.position.y - this.terrain.height(cam.position.x, cam.position.z)) * 1.5 : 25 + this.player.height * 12 + cam.position.distanceTo(this.player.pos) * 1.2);
    this.sky.underground = clamp(this.sky.underground + (this.camRig.underground ? dt : -dt) * 2.5, 0, 1);
    // (The manhole climb cuts between the street and the sewer: the light follows at once, no washed-out sewer.)
    if (this.manhole.active) this.sky.underground = this.camRig.underground ? 1 : 0;
    {
      // In the deep realm's caves: their own light (teal haze in the Glow, a red one in the Deep).
      const F = this.underground.deep?.field, c = this.renderer.camera.position;
      const inDeep = !!F && this.camRig.underground && F.near(c.x, c.y, c.z) && F.air(c.x, c.y, c.z);
      this.sky.deep = clamp(this.sky.deep + (inDeep ? dt : -dt) * 1.5, 0, 1);
      const m = this.underground.deepState.murk;
      this.sky.deepTint.setRGB(lerp(0.004, 0.022, m), lerp(0.013, 0.003, m), lerp(0.014, 0.006, m));
    }
    const cp = this.renderer.camera.position;
    this.sky.indoor = clamp(this.sky.indoor + (this.indoorsAt(cp.x, cp.y, cp.z) ? dt : -dt) * 2, 0, 1);
    this.T('weather', () => this.weather.update(dt));
    this.T('sky', () => this.sky.update(dt, focus, cam));
    this.T('wardens', () => this.wardens?.update(dt));
    this.renderer.setBloom(lerp(0.16, 0.08, this.sky.underground));
    const P = this.player;
    this.T('future', () => this.future.update(dt, this.sky.hoursAbs, focus, { active: !this.freeCam, x: P.pos.x, y: P.pos.y, z: P.pos.z, vx: P.vel.x, vy: P.vel.y, vz: P.vel.z, height: P.height, radius: P.radius, mass: P.mass }, cam));
    this.elements.postFuture();
    this.T('birds', () => this.birds.update(dt, this.sky.hour, focus, this.freeCam ? null : this.player, cam));
    if (render) {
      this.T('crowd', () => this.crowd.update(dt, this.simT, this.peds.agents, this.renderer.camera));
      this.T('ragdollPose', () => this.ragdolls.pose());
      this.T('vehicles', () => this.vehicles.update(dt, this.traffic.vehicles, this.parkedList, this.renderer.camera));
      this.T('props', () => this.props.update(dt, this.renderer.camera));
      this.T('elementFx', () => this.elements.render(dt));
      this.T('gate', () => this.gate.update());
      this.T('render', () => { const t = performance.now(); this.graphics.render(() => this.renderer.render()); this.renderMs = performance.now() - t; });
      this.hud.update(dt);
      this.powerHud.update();
      this.targetHud.update();
      this.matePanel?.update();
      this.touch.update();
      this.T('map', () => { this.map.update(dt); this.compass.update(); this.barks.update(dt); });
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
  /** Dash in progress: rank, last position, and who/what it already hit. */
  private dashRank = 0;
  private readonly dashFrom = new THREE.Vector3();
  private readonly dashHit = new Set<object>();
  private speedHitT = 0;
  private readonly hopTmp: PedAgent[] = [];
  private readonly hopObs = { cyl: true, x: 0, z: 0, r: 0.4, hx: 0, hz: 0, ux: 1, uz: 0, y0: 0, y1: 0 };
  /** Last stern word from someone a super speed runner brushed past (game time, s). */
  private brushT = -99;

  /**
   * A dash shoves what lies along its path, once per dash: people are knocked down (unless
   * the dasher is much smaller), props and robots take a hit, cars get dented (a giant wrecks
   * them). Strength grows with rank and body mass.
   */
  private dashSweep(dt: number): void {
    const p = this.player;
    // Super speed: people passed are spun aside (each once every 1.5 s), like a dash.
    const running = p.speeding && Math.hypot(p.vel.x, p.vel.z) > 8 * Math.sqrt(p.k);
    if (!p.dashing && !running) { this.dashRank = 0; this.dashFrom.copy(p.pos); return; }
    if (running && !p.dashing) {
      this.dashRank = this.abilities.rank('speed');
      this.speedHitT -= dt;
      if (this.speedHitT <= 0) { this.speedHitT = 1.5; this.dashHit.clear(); }
    }
    const x0 = this.dashFrom.x, z0 = this.dashFrom.z, x1 = p.pos.x, z1 = p.pos.z;
    this.dashFrom.copy(p.pos);
    const sx = x1 - x0, sz = z1 - z0, L = Math.hypot(sx, sz);
    if (L < 1e-4) return;
    const dx = sx / L, dz = sz / L, k = p.k, r = p.radius + 0.25 * p.height;
    // Shove impulse (N·s): a fraction of the body's momentum at a run, by rank.
    const J = 110 * k ** 3 * (2 + this.dashRank);
    const segDist = (x: number, z: number) => {
      const t = Math.max(0, Math.min(1, ((x - x0) * sx + (z - z0) * sz) / (L * L)));
      return Math.hypot(x - (x0 + sx * t), z - (z0 + sz * t));
    };
    const y = p.pos.y + p.height * 0.5;
    const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
    this.props.hit(mx, y, mz, r + L / 2, dx * J, J * 0.15, dz * J);
    this.future.hit(mx, y, mz, r + L / 2, dx * J, J * 0.15, dz * J);
    // (In a super speed hop the arc was planned over everyone under it.)
    if (k > 0.45 && !(running && p.hopping)) for (const a of this.peds.neighbours(mx, mz, r + L / 2 + 0.5, [])) {
      if (this.dashHit.has(a) || a.state === 5 || (a.inside && !a.hall) || Math.abs(a.y - p.pos.y) > Math.max(1.8, p.height) || !this.underground.sameSide(p.pos.x, p.pos.y, p.pos.z, a.x, a.y, a.z)) continue;
      if (segDist(a.x, a.z) > r + 0.3) continue;
      this.dashHit.add(a);
      // Flung forward and aside: the "from" point lies behind them on the dash line (a runner
      // spins them off to the side they stood on).
      const side = Math.sign((a.x - x0) * -dz + (a.z - z0) * dx) || 1;
      const fx = running ? a.x - (dx * 0.6 - dz * side) * 1.5 : a.x - dx * 1.5, fz = running ? a.z - (dz * 0.6 + dx * side) * 1.5 : a.z - dz * 1.5;
      // A runner of about human size who could not hop over them only brushes past: they
      // stumble, are cross with the speedster and get up again (no harm on the ledger, no
      // reputation lost: one cannot run at super speed through a city and never touch anyone).
      const brush = running && p.height < 3;
      this.reactions.knockDown(a, fx, fz, Math.min(brush ? 5 : POWER_HIT.dashKnockMax, (POWER_HIT.dashKnock + POWER_HIT.dashKnockPerRank * this.dashRank) * Math.sqrt(k)), brush ? 'brush' : 'player');
      if (running) a.heading += side * 2.5;
      if (brush) { this.brushedBy(a); continue; }
      this.audio.play('punch_impact', a.x, a.y + 1, a.z, 0.5, 0.9, 4, this.renderer.camera.position);
      this.stimuli.emit('impact', a.x, a.y + 1, a.z, 3, 30);
    }
    if (running && !p.dashing) return; // a runner vaults cars (Player parkour) instead of ramming them
    for (const v of [...this.traffic.vehicles, ...this.parkedList]) {
      if (this.dashHit.has(v) || Math.abs(v.y - p.pos.y) > 2 + p.height || segDist(v.x, v.z) > r + v.length * 0.4) continue;
      this.dashHit.add(v);
      this.hitCar(v, J, v.x, v.y + 0.8, v.z, dx * J, J * 0.3, dz * J, 'speed');
    }
  }

  /** Someone a super speed runner brushed past calls after them (now and then, see BRUSH_LINES). */
  private brushedBy(a: PedAgent): void {
    this.audio.play('punch_impact', a.x, a.y + 1, a.z, 0.3, 1.1, 4, this.renderer.camera.position);
    const now = this.consequences.time;
    if (now - this.brushT < 4) return;
    this.brushT = now;
    const who = this.people ? this.people.person(a.cit).first : null;
    this.barks.shout(a, BRUSH_LINES[Math.floor(Math.random() * BRUSH_LINES.length)], who);
  }

  /** Mass-weighted contacts between the player and pedestrians / vehicles. */
  private bodyContacts(dt: number): void {
    const p = this.player;
    this.kickCooldown -= dt;
    this.dashSweep(dt);
    const pm = p.mass, pr = p.radius;
    const near = this.peds.neighbours(p.pos.x, p.pos.z, pr + 1.5, []);
    for (const a of near) {
      // (Indoors only those in a landmark's hall are in reach; seated ones stay in their seat.)
      if (a.state === 5 || (a.inside && (!a.hall || a.state === PState.Sit))) continue;
      if (Math.abs(a.y - p.pos.y) > Math.max(1.8, p.height) || !this.underground.sameSide(p.pos.x, p.pos.y, p.pos.z, a.x, a.y, a.z)) continue;
      const dx = p.pos.x - a.x, dz = p.pos.z - a.z;
      const d = Math.hypot(dx, dz);
      const rr = pr + 0.25;
      // (!(d < rr): a person at a non-finite spot must not drag the hero there too.)
      if (!(d < rr) || d < 1e-4) continue;
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
    // A giant's body pushes over trees, lamps and the like it walks into (not only under its feet).
    if (p.height >= 3) {
      const sp = Math.hypot(p.vel.x, p.vel.z);
      const dx = sp > 0.1 ? p.vel.x / sp : -Math.sin(p.yaw), dz = sp > 0.1 ? p.vel.z / sp : -Math.cos(p.yaw);
      this.props.shove(p.pos.x, p.pos.z, pr, p.height, dx, dz); // (props.onBreak plays the crack)
    }
    // Vehicles: an unseen tiny player is hit; everyone else is pushed out of the car body.
    for (const v of this.traffic.vehicles) {
      const dx = p.pos.x - v.x, dz = p.pos.z - v.z;
      if (dx * dx + dz * dz > (v.length + pr + 2) ** 2) continue;
      const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
      const along = dx * fx + dz * fz, lat = dx * -fz + dz * fx;
      // Above the car (on its roof, flying) or below it (sewer, metro, a cellar): no contact.
      if (Math.abs(along) > v.length / 2 + pr || Math.abs(lat) > v.width / 2 + pr || p.pos.y > v.y + 1.6 || p.pos.y + p.height < v.y - 0.3) continue;
      if (p.mass < 300 && v.speed > 1.5) {
        // Hit by the car.
        p.vel.x = fx * v.speed * 1.2; p.vel.z = fz * v.speed * 1.2; p.vel.y = 2 + v.speed * 0.3;
        p.grounded = false;
        p.pos.x += fx * 0.3; p.pos.z += fz * 0.3;
        if (this.kickCooldown <= 0) { this.audio.play('car_crash', p.pos.x, p.pos.y, p.pos.z, 0.4, 1.3, 4, this.renderer.camera.position); this.kickCooldown = 1; this.camRig.addShake(0.3); this.crime?.health.damage(6 + v.speed * 3.2, 'car', v.x, v.z, v.y); }
      } else {
        const pushLat = (v.width / 2 + pr - Math.abs(lat)) * Math.sign(lat || 1);
        p.pos.x += -fz * pushLat; p.pos.z += fx * pushLat;
        if (p.mass > 20000 && v.speed > 0.5) { this.traffic.wreckIt(v); this.vehicles.makeWreck(v, v.x, v.y + 0.8, v.z, -dx * 3000, 4000, -dz * 3000); }
      }
    }
  }

  /** Powers: progression, abilities, HUD, powers screen (P), good deeds and power cores. */
  private setupPowers(): void {
    const cam = this.renderer.camera;
    const normal = this.mode === 'normal';
    this.progress = new Progress(this.settings.seed, this.settings.size, this.mode);
    setAimCursor(() => this.input.cursorNdc());
    this.abilities = new AbilitySystem(this.progress, this.player, this.interactions, cam);
    this.powerHud = new PowerHud(this.abilities);
    this.powerFx = new PowerFx(this.renderer.scene, this.dust, this.player);
    this.powers = new PowersScreen(this, this.abilities);
    // Targeting and the elemental powers.
    this.synth = new PowerSynth(() => this.audio.synthOut());
    this.targeting = new Targeting({
      peds: this.peds, traffic: this.traffic, parked: () => this.parkedList, future: this.future, props: this.props, world: this.world,
      destruction: this.destruction, streamer: this.streamer, player: this.player, camera: cam,
      threats: () => { const a = this.threats?.actors() ?? []; const b = this.slimeRealm?.actors() ?? []; return b.length ? [...a, ...b] : a; },
      under: {
        ray: (ox, oy, oz, dx, dy, dz, maxT) => this.underground.caveRay(ox, oy, oz, dx, dy, dz, maxT) ?? this.underground.tunnelRay(ox, oy, oz, dx, dy, dz, maxT),
        line: (ax, ay, az, bx, by, bz) => this.underground.caveLine(ax, ay, az, bx, by, bz, 1.0) ?? this.underground.tunnelLine(ax, ay, az, bx, by, bz, 1.0),
        isUnder: (x, y, z) => this.underground.isUnder(x, y, z),
      },
    });
    this.elements = new Elements({
      player: this.player, camera: cam, camRig: this.camRig, targeting: this.targeting, synth: this.synth, destruction: this.destruction,
      debris: this.debris, dust: this.dust, world: this.world, collision: this.collision, peds: this.peds, reactions: this.reactions,
      traffic: this.traffic, vehicles: this.vehicles, parked: () => this.parkedList, future: this.future, props: this.props,
      stimuli: this.stimuli, consequences: this.consequences, sight: this.sight, deny: (msg) => this.abilities.hooks.deny?.(msg),
      sound: (id, x, y, z, g, pitch = 1, ref = 6) => this.audio.play(id, x, y, z, g, pitch, ref, cam.position),
      douse: (x, y, z, r, amount) => { this.threats?.fires.douse(x, y, z, r, amount); },
      swarm: (effect, x, y, z, r, dmg, fling) => [...(this.threats?.broodHit(x, y, z, r, effect, dmg, fling) ?? []), ...(this.crime?.packs.hit(x, y, z, r, effect, dmg, fling) ?? [])],
    });
    this.renderer.scene.add(this.elements.fx.group);
    this.abilities.effects = this.elements;
    this.targetHud = new TargetHud(this.targeting, cam);
    this.targeting.onChange = (t) => { if (t) this.audio.chime('karma', 0.12); };
    const toast = this.powerHud.toast.bind(this.powerHud);
    this.abilities.hooks = {
      sound: (id, g, p) => this.audio.play2d(id, g, p),
      deny: (msg) => { toast(msg, 'deny', 2200); this.audio.chime('deny', 0.4); },
      dashFx: (_dx, _dy, _dz, dur, rank) => {
        const p = this.player, h = p.height;
        this.dust.burst(p.pos.x, p.pos.y + 0.2 * h, p.pos.z, 10, h * 0.25, h * 0.6, h * 0.2 + 0.3, 1.5, new THREE.Color(0.75, 0.73, 0.7), 0.05, 0.3);
        this.powerFx.dash(dur, rank);
        this.camRig.kickFov(7 + rank * 1.5, dur);
        this.audio.play2d('dash_whoosh', 0.55 + rank * 0.07, 1.15 / Math.pow(p.k, 0.15));
        this.dashRank = rank;
        this.dashFrom.copy(p.pos);
        this.dashHit.clear();
      },
      leapFx: (f) => {
        const p = this.player, h = p.height, sk = Math.sqrt(p.k);
        this.dust.burst(p.pos.x, p.pos.y + 0.05 * h, p.pos.z, Math.round(8 + 16 * f), h * 0.3, (1 + 3 * f) * sk, h * 0.15 + 0.1, 1.2, new THREE.Color(0.62, 0.6, 0.56), 0.1, 0.4);
        this.camRig.addShake(0.15 * f);
      },
    };
    this.progress.onKarma((amount, reason) => {
      if (amount <= 0) return;
      toast(`<b>+${amount} karma</b> — ${reason}`, 'karma');
      this.audio.chime('karma');
    });
    this.powers.onBuy = (id, r) => {
      toast(r === 1 ? `<b>${ABILITY[id].name}</b> unlocked!${ABILITY[id].kind === 'active' ? ` It's on your hotbar.` : ''}` : `<b>${ABILITY[id].name}</b> is now rank ${r}`, 'core');
      this.audio.chime('buy');
    };
    this.deeds = new Deeds(this.peds, this.reactions, this.player, this.progress);
    const deedView = screenPoint();
    this.deeds.hooks = {
      toast,
      reachable: (a) => {
        if (a.inside) return false;
        const g = this.world.groundHeight(a.x, a.z, a.y + 0.5);
        if (Math.abs(a.y - g) > 1.2) return false;
        return !this.world.wet(a.x, a.z, 0);
      },
      sound: (id, x, y, z, g, pitch = 1) => this.audio.play(id, x, y, z, g, pitch, 8, cam.position),
      inView: (x, feet, z) => {
        // Not from indoors (an interior, a landmark's rooms, a building prism): the street is out of sight.
        const c = cam.position;
        if (this.indoorsAt(c.x, c.y, c.z)) return false;
        const b = this.world.buildingAt(c.x, c.z);
        if (b && c.y < b.top && c.y > b.low) return false;
        return markerOnScreen(x, feet + 1.2, z, feet, cam, deedView, 0.85);
      },
      markers: (m) => this.map.setMarkers('deeds', m),
      rep: (d, reason) => this.crime?.rep.add(d, reason),
    };
    if (normal) {
      const cores = new PowerCores(
        planCoreSites(this.macro, this.terrain), this.terrain,
        (cell) => { const c = this.streamer.cells.get(cell); return c && c.status === 'ready' ? c.plan : null; },
        (x, y, z) => { const g = this.collision.groundAt(x, z, y + 0.6, 1.2); return Math.abs(g - y) < 1.5 ? g : NaN; },
        this.progress,
      );
      this.cores = cores;
      this.renderer.scene.add(cores.group);
      cores.onMarkers = (m) => this.map.setMarkers('cores', m);
      // Say what a core gives, how to take it, and (before any power uses energy) why energy matters.
      cores.onDiscover = (site) => {
        const L = LOOT_INFO[site.loot];
        toast(`You sense a <b>${L.name}</b> nearby (${L.text}) — walk into its glow to take it. It is marked on your map`, 'info', 8000);
      };
      cores.onCollect = (site, spot) => {
        const L = LOOT_INFO[site.loot];
        const usesEnergy = ABILITIES.some((d) => d.kind === 'active' && d.id !== 'punch' && this.progress.unlocked(d.id));
        if (site.loot !== 'karma') toast(`<b>${L.name}</b> collected — ${L.text}${usesEnergy ? '' : '. Powers you buy (<b>P</b>) run on energy'}`, 'core', 7000);
        this.audio.chime('core', 0.7);
        this.dust.burst(spot.x, spot.y + 1, spot.z, 24, 0.6, 3, 1.2, 1.2, new THREE.Color(L.color).multiplyScalar(3), 0, 0.6);
        this.abilities.energy = this.abilities.maxEnergy;
      };
      this.powers.info = () => `Power cores found: <b>${this.progress.coresCollected}</b> of ${cores.total} (rare glowing loot — rooftops, parks, metro, sewers).`;
    }
    // Street crime, police, justice, health and reputation (needs the map, HUD and targeting).
    this.city = new CityNews(this);
    if (this.startCell >= 0) this.city.freshStart(this.startCell);
    this.crime = new CrimeSystem(this);
    // Sewer hideouts wear the colours and tags of the group holding the street above.
    this.underground.hideoutLook = (x, z, seed) => {
      const f = this.crime.factionAt(x, z);
      return f ? { accent: f.palette.accent, tag: this.crime.graffiti.tagMaterial(f, seed) } : null;
    };
    this.response = new ResponseDirector(this);
    this.threats = new ThreatDirector(this);
    this.forces = new Forces(this);
    this.hostile = new HostilePlayer(this);
    this.aftermath = new Aftermath(this);
    this.street = new StreetLife(this);
    this.stationLife = new StationLife(this.underground, { spawnAt: (c, x, z, h) => this.peds.spawnAt(c, x, z, h), citizen: (seed) => this.population.synthetic(seed) }, this.macro.metroLines);
    this.slimeRealm = new SlimeRealm(this);
    this.people = new People(this);
    this.wardrobe = new Wardrobe(this);
    this.arcade = new Arcade(this);
    this.fame = new Fame(this);
    this.sidekick = new Sidekick(this);
    this.matePanel = new SidekickPanel(this.targeting, this.sidekick);
    this.wardens = new Wardens(this);
    this.targeting.personLabel = (a) => this.people.label(a);
    // (Not when a save is loaded: the player has been here before.)
    // (Nor after the origin scene: it tells the story and gives the hint itself.)
    if (!this.pendingSave && !OriginIntro.wanted(this)) setTimeout(() => toast(normal
      ? isTouch()
        ? 'You are an ordinary person — for now. Help people (<b>Use</b>) to earn karma, then tap <b>Powers</b> to buy powers.'
        : 'You are an ordinary person — for now. Help people (<b>E</b>) to earn karma, then press <b>P</b> to buy powers.'
      : isTouch()
        ? 'Sandbox: every power is yours. Tap the hotbar (hold for beams and super speed), tap someone or <b>Target</b> to pick a target, <b>Powers</b> manages powers.'
        : 'Sandbox: every power is yours. <b>1–9, 0</b> use the hotbar (hold for beams and super speed), click or <b>Tab</b> picks a target, <b>P</b> manages powers.', 'info', 10000), 9500);
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
      this.traffic.settle(v);
      list.push(v);
    }
    this.parked.set(c.id, list);
    this.parkedList = [...this.parked.values()].flat();
  }

  /**
   * The player's own blow on a car (a punch, a shockwave, a dash; impulse J N·s, pushed from
   * (x, y, z) by (jx, jy, jz)): a wreck past 2500 N·s, else a dent, and booked on the ledger with the
   * car either way (Justice decides what that costs: a dent only for a police car).
   */
  private hitCar(v: Vehicle, J: number, x: number, y: number, z: number, jx: number, jy: number, jz: number, power: string): void {
    // (Pushing a wreck or a flattened car about is no new harm.)
    const intact = v.state !== VState.Wreck && v.state !== VState.Crushed, wreck = J > 2500;
    if (wreck) {
      this.traffic.wreckIt(v);
      this.vehicles.makeWreck(v, x, y, z, jx, jy, jz);
      this.audio.play('car_crash', v.x, v.y, v.z, Math.min(1, J / 20000 + 0.3), 1, 10, this.renderer.camera.position);
    } else dentCar(v, J / 5000);
    if (intact) this.consequences.record(power, 'car', wreck ? 'wreck' : 'damage', v.x, v.z, v);
  }

  /** A physical strike at a point hits cars, people and props. */
  strike(x: number, y: number, z: number, r: number, jx: number, jy: number, jz: number): void {
    const J = Math.hypot(jx, jy, jz);
    // A monster in reach takes the blow (armour, weak spots).
    this.threats?.blow(x, y, z, r, jx, jy, jz, { cause: 'player', x: this.player.pos.x, y: this.player.pos.y, z: this.player.pos.z });
    this.slimeRealm?.blow(x, y, z, r, jx, jy, jz);
    // The brood's creatures (a punch kills a small one; a blast a clump).
    if (J > 0) this.threats?.broodHit(x, y, z, r + 0.3, 'blow', J / 150, Math.min(10, J / 60));
    // A Beast-master's dogs.
    if (J > 0) this.crime?.packs.hit(x, y, z, r + 0.3, 'blow', J / 150, Math.min(10, J / 60));
    // The army's helicopters, when they are after the player.
    this.forces?.struck(x, y, z, r, jx, jy, jz);
    this.props.hit(x, y, z, r, jx, jy, jz);
    this.future.hit(x, y, z, r, jx, jy, jz);
    this.birds.hit(x, y, z, r, jx, jy, jz);
    for (const v of [...this.traffic.vehicles, ...this.parkedList]) {
      const d = Math.hypot(v.x - x, v.z - z);
      if (d > r + v.length / 2 || y > v.y + 3 + r) continue;
      this.hitCar(v, J, x, y, z, jx, jy, jz, 'strike');
    }
    // People: through the combat model (stagger, knock-down, KO by impulse and health). A punch
    // (small radius) lands on one body — the nearest, the soft-locked target first; a blast hits all.
    const hit = this.peds.neighbours(x, z, r + 0.5, []).filter((a) => Math.hypot(a.x - x, a.z - z) < r + 0.4 && Math.abs(a.y + 0.9 - y) < r + 1.5 && this.underground.sameSide(x, y, z, a.x, a.y, a.z));
    if (r <= this.player.height * 0.5 && hit.length > 1) {
      const cur = this.targeting.current?.kind === 'person' ? this.targeting.current.obj : null;
      hit.sort((a, b) => (a === cur ? -1 : b === cur ? 1 : 0) || (b.actor?.hostile ? 1 : 0) - (a.actor?.hostile ? 1 : 0) || Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
      hit.length = 1;
    }
    for (const a of hit) this.crime.combat.hitActor(a, jx, jy, jz, 'strike', 'player');
  }

  /** Nearest street holes and whether the camera is underground -> terrain shader. */
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
    // Also while the player is in an entrance's stairwell or a passage with the camera still up at
    // street level: the skirts along the tiles' edges hang through the passages there, walls one
    // walked through on the way down.
    const p = this.player.pos;
    const under = c.y < this.terrain.height(c.x, c.z) - 0.5 || this.underground.inHole(c.x, c.z) || (!this.freeCam && this.underground.floorAt(p.x, p.y + 0.5, p.z) !== null);
    terrainHoles.uUnder.value = under ? 1 : 0;
  }

  /** Inside a building (an active interior) or a landmark's rooms (the town hall)? */
  indoorsAt(x: number, y: number, z: number): boolean {
    return !!this.interiors.insideAt(x, y, z) || !!this.world.landmarks?.insideAt(x, y, z);
  }

  /** On-screen hint for something usable where the player stands (null: nothing). */
  private usableHint(): string | null {
    if (this.manhole.active) return null;
    if (this.freeCam) return null;
    if (this.arcade?.playing) return this.arcade.hint();
    const metro = this.underground.metroHint(!!this.underground.ride && !this.player.seat && !!this.seatNear());
    // On a platform bench the getting-up hint beats the platform's own.
    if (metro && this.player.seat && !this.underground.ride) return 'Move or press <b>E</b> to get up';
    if (metro) return metro;
    // A hint offering E beats a passive one ("Bring the bag back …"): someone to help up right
    // here must show even while the player carries loot home.
    const hints = [this.aftermath?.hint(), this.crime?.hint(), this.deeds?.hint()];
    const act = hints.find((h) => h && h.includes('<b>E</b>'));
    if (act) return act;
    const passive = hints.find((h) => h);
    if (passive) return passive;
    const slime = this.slimeRealm?.hint();
    if (slime) return slime;
    if (this.player.seat) return 'Move or press <b>E</b> to get up';
    const arcade = this.arcade?.hint();
    if (arcade) return arcade;
    const dress = this.wardrobe?.hint();
    if (dress) return dress;
    const shard = this.sidekick?.hint();
    if (shard) return shard;
    const talk = this.people?.hint();
    if (talk) return talk;
    if (this.seatNear()) return 'Press <b>E</b> to sit down';
    const p = this.player.pos;
    // Manholes are climbed from the sewers only (not from metro halls, passages or trains).
    const under = this.underground.inSewer(p.x, p.y + 0.5, p.z);
    const m = under || !this.underground.feetUnder(p.x, p.y, p.z) ? this.underground.nearestManhole(p.x, p.z, under ? 3 : 1.4) : null;
    if (!m) return this.crime?.deeds.putDownHint() ?? null;
    if (under) return 'Manhole above — press <b>E</b> to climb out';
    if (this.player.height >= 2.4) return 'A manhole — you are too big to fit through';
    return this.underground.isOpen(m) ? 'Open manhole — press <b>E</b> to climb down into the sewer' : 'Manhole — press <b>E</b> to open it and climb down into the sewer';
  }

  /** A free seat within reach of an ordinary-sized player on foot (benches, café chairs), or null. */
  private seatNear(): { x: number; z: number; yaw: number; car?: { u: number; v: number } } | null {
    const P = this.player;
    if (P.flying || !P.grounded || P.height > 2.4 || P.height < 1.2 || P.downT > 0 || P.ragdoll) return null;
    // Underground: train seats, platform benches.
    if (this.underground.feetUnder(P.pos.x, P.pos.y, P.pos.z) || this.underground.ride) return this.underground.seatNear(P.pos.x, P.pos.y, P.pos.z, 1.3);
    let best: { x: number; z: number; yaw: number } | null = null, bd = 1.3;
    this.props.query(P.pos.x, P.pos.z, 1.6, (pr) => {
      if (pr.broken || !/^furn:(bench|cafeChair):/.test(pr.kind)) return;
      if (Math.abs(pr.y - P.pos.y) > 0.6) return;
      const d = Math.hypot(pr.x - P.pos.x, pr.z - P.pos.z);
      if (d >= bd) return;
      // Someone sitting there already?
      if (this.peds.neighbours(pr.x, pr.z, 0.45, []).some((a) => a.state === PState.Sit)) return;
      bd = d;
      best = { x: pr.x, z: pr.z, yaw: pr.yaw };
    });
    // Indoors: chairs, sofas, armchairs of the open interior.
    return best ?? this.interiors.seatNear(P.pos.x, P.pos.y, P.pos.z, 1.3);
  }

  /** E: open a manhole above a sewer and drop in; underground: climb out at the nearest manhole. */
  private manholeKey(): void {
    if (this.freeCam || this.manhole.active || !this.input.hit('KeyE')) return;
    if (this.aftermath.use() || this.crime.use() || this.deeds.help() || this.slimeRealm?.use()) { this.input.pressed.delete('KeyE'); return; }
    // Get up from a seat (before the metro: seated in a train, E gets up rather than off).
    if (this.player.seat) { this.player.standUp(); this.input.pressed.delete('KeyE'); return; }
    // In a train, a free seat in reach wins over the doors (getting off: walk out an open door).
    const rideSeat = this.underground.ride ? this.seatNear() : null;
    if (rideSeat && 'car' in rideSeat && rideSeat.car) {
      this.player.sitOn(rideSeat.x, rideSeat.z, rideSeat.yaw);
      if (this.player.seat) this.underground.sitInCar(rideSeat.car);
      this.input.pressed.delete('KeyE');
      return;
    }
    if (this.underground.metroKey()) { this.input.pressed.delete('KeyE'); return; }
    // At a clothes shop's fitting mirror: change your look.
    if (this.wardrobe?.use()) { this.input.pressed.delete('KeyE'); return; }
    // At an arcade cabinet: play.
    if (this.arcade?.use()) { this.input.pressed.delete('KeyE'); return; }
    // Take the glowing stone (the second shard).
    if (this.sidekick?.use()) { this.input.pressed.delete('KeyE'); return; }
    // Talk to the person in front (or the one targeted).
    if (this.people.use()) { this.input.pressed.delete('KeyE'); return; }
    const seat = this.seatNear();
    // Sit down on a bench or café chair in reach (a train seat: the ride holds you on it).
    if (seat) {
      this.player.sitOn(seat.x, seat.z, seat.yaw);
      if ('car' in seat && seat.car && this.player.seat) this.underground.sitInCar(seat.car);
      this.input.pressed.delete('KeyE');
      return;
    }
    const p = this.player.pos;
    const under = this.underground.inSewer(p.x, p.y + 0.5, p.z);
    const m = under || !this.underground.feetUnder(p.x, p.y, p.z) ? this.underground.nearestManhole(p.x, p.z, under ? 3 : 1.4) : null;
    // Nothing else to do with E: put down what you carry (a rescued cat, a found wallet).
    if (!m) { if (this.crime.deeds.putDown()) this.input.pressed.delete('KeyE'); return; }
    // Climb out (pushing the lid off if it is on) or open the lid and climb down: see ManholeClimb.
    if (under) { this.manhole.start(m, 'up'); this.input.pressed.delete('KeyE'); }
    else if (ManholeClimb.fits(this.player.height)) { this.manhole.start(m, 'down'); this.input.pressed.delete('KeyE'); }
  }

  /**
   * Riding the metro: the running sound (faster with the speed), a knock through the car at every
   * rail joint, a constant fine rattle, and a lurch when the train pulls away or brakes.
   */
  private rideLoop: ReturnType<Audio['loop']> = null;
  private rideDist = 0;
  private rideV = 0;
  private rideA = 0;
  private rideFx(dt: number): void {
    const r = this.underground.riding, cam = this.renderer.camera.position;
    if (!r) {
      this.rideLoop?.set(cam.x, cam.y, cam.z, 0);
      this.rideDist = 0; this.rideV = 0; this.rideA = 0;
      return;
    }
    this.rideLoop ??= this.audio.loop('metro_run', 6);
    // Speed and its change smoothed (the per-frame acceleration is noisy and grows with speed:
    // fed to the shake every frame it piled up until the view shook wildly late in a ride).
    const prevV = this.rideV;
    this.rideV += (r.speed - this.rideV) * Math.min(1, dt * 2);
    this.rideA += ((this.rideV - prevV) / Math.max(1e-3, dt) - this.rideA) * Math.min(1, dt * 2);
    const f = clamp(r.speed / 16, 0, 1.2);
    this.rideLoop?.set(cam.x, cam.y, cam.z, 0.2 + 0.8 * Math.min(1, f), 0.55 + 0.45 * f);
    const before = this.rideDist;
    this.rideDist += r.speed * dt;
    // Rail joints every 18 m: the front bogie, then the rear one 2.5 m later.
    for (const off of [0, 2.5]) if (r.speed > 3 && Math.floor((this.rideDist - off) / 18) !== Math.floor((before - off) / 18)) this.camRig.addShake(0.3 + 0.15 * f);
    // A fine rattle at speed and a lurch pulling away / braking: a level the shake is held at, not an increment.
    const lurch = Math.min(0.35, Math.max(0, Math.abs(this.rideA) - 0.4) * 0.3);
    this.camRig.shakeFloor(0.12 * Math.min(1, f) + lurch);
  }

  /** Cars as boxes for the ragdolls (wrecks are physical bodies already). */
  private *carBoxes(): Generator<CarBox> {
    for (const list of [this.traffic.vehicles, this.parkedList]) for (const v of list) {
      if (this.vehicles.extra(v).body) continue;
      const h = v.kind === 'bus' || v.kind === 'truck' ? 3.0 : v.kind === 'van' || v.kind === 'delivery' || v.kind === 'shuttle' ? 2.3 : v.kind === 'suv' || v.kind === 'pickup' ? 1.8 : 1.5;
      yield { ref: v, x: v.x, y: v.y, z: v.z, yaw: v.yaw, length: v.length, width: v.width, height: h };
    }
  }

  private flightSpeedPrev = 0;
  private updateAudio(_dt: number): void {
    const cam = this.renderer.camera;
    this.audio.updateListener(cam);
    this.music.update(_dt);
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
    const ward = !!this.defeat?.inWard;
    const ug = !ward && this.underground.feetUnder(p.pos.x, p.pos.y, p.pos.z);
    const inStation = ug && this.underground.boxes.some((b) => b.kind === 'station' && Math.hypot(b.cx - p.pos.x, b.cz - p.pos.z) < b.hu + 5);
    const surf = ug ? 0.08 : ward ? 0 : 1;
    // Weather: rain (light / heavy) and gusts, muffled indoors and underground; a wet city is quieter.
    const W = this.weather.p, rain = W.rain;
    const shut = (1 - 0.75 * this.sky.indoor) * (ug ? 0.05 : ward ? 0 : 1);
    const quiet = 1 - 0.3 * smoothstep(0.1, 0.7, rain);
    this.audio.setAmbience({
      amb_sewer: ug && !inStation ? 0.9 : 0,
      amb_metro: inStation ? 0.9 : 0,
      amb_city_day: (1 - night) * 0.9 * altFade * surf * quiet,
      amb_city_night: night * 0.9 * altFade * surf * quiet,
      amb_river: ward ? 0 : nearWater * 0.8,
      amb_sea: ward ? 0 : nearSea * 0.8,
      amb_interior: ward ? 0.55 : 0,
      amb_wind_flight: wind,
      amb_rain_light: clamp(rain * 4, 0, 1) * (1 - smoothstep(0.35, 0.8, rain) * 0.6) * shut,
      amb_rain_heavy: smoothstep(0.25, 0.85, rain) * shut,
      amb_wind_gust: smoothstep(0.3, 0.9, W.wind) * 0.8 * shut,
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
