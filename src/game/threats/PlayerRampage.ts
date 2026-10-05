/**
 * The army against a rampaging giant player (THREATS_PLAN §5 question 2 as amended by PLAYGROUND_PLAN
 * §0 decision 19: no cap — the full ladder, after a clear warning sequence). The rules (fury, the
 * warnings, standing down, the body's zones) are pure: rampageRules.ts.
 *
 *  - `HostilePlayer` watches the player's own destruction (the collateral ledger). A giant
 *    (≥ RAMPAGE.minHeight) with a feared reputation who keeps levelling the city is warned — a police
 *    drone comes over, the screens round about switch to the red alert, a siren whoops, the nearest
 *    officer shouts — then warned a last time, then becomes a major threat to the city: a
 *    `PlayerRampage` event the response director escalates against like a monster's — patrol cars
 *    and a cordon, evacuation sirens, SWAT firing from a distance, the National Guard and the army and
 *    air (Forces: the player is an `ArmyFoe`), and, rarely, the last resort's countdown (its strike
 *    zone follows the player).
 *  - It ends when the player stands down (no destruction for a while, or human-sized again), is
 *    brought down (knocked out: taken into custody — the justice layer's arrest), or is caught in the
 *    strike. A relapse soon after brings the army back without new warnings.
 *  - The player's body (`PlayerBody`) is the incident's actor for the police and the army only (never
 *    the player's own target): army damage points become the player's health (RAMPAGE.hp a bar).
 *
 * Not kept in saves (like the army): a resumed rampage starts again from the warnings.
 */
import type { Game } from '../Game';
import type { DamageResult, DamageSource, ThreatActor, ThreatEvent, ThreatOutcome, ThreatTarget, ThreatZone } from './ThreatEvent';
import type { AirProvider, StriderBlow } from './Strider';
import type { ArmyFoe } from '../response/forces/Forces';
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';
import { DKind } from '../../future/Drones';
import type { HarmEntry } from '../Consequences';
import { PLAYER_ZONES, RAMPAGE, RampageWatch, furyOf, playerDamage, playerPath, playerSpawn } from './rampageRules';

let EVENT_ID = 5000;

/** The giant player's body as the police and the army see it (never a target for the player). */
export class PlayerBody implements ThreatActor {
  readonly name = 'Rampaging giant';
  readonly self = true;
  readonly maxHp = RAMPAGE.hp;
  readonly zones: ThreatZone[];
  readonly aggro = new Map<string, number>();
  /** Health points owed (small hits add up until they are worth a point). */
  private owed = 0;
  /** The event is on (the body is a target only then). */
  on = true;
  stats = { hits: 0, dealt: 0, health: 0 };

  constructor(private g: Game) {
    this.zones = PLAYER_ZONES.map((z) => ({ id: z.id, name: z.name, armour: z.armour, weak: false, exposed: false, x: 0, y: 0, z: 0, r: 1, recent: 0 }));
    this.place();
  }

  get x(): number { return this.g.player.pos.x; }
  get y(): number { return this.g.player.pos.y + this.g.player.height * 0.5; }
  get z(): number { return this.g.player.pos.z; }
  get height(): number { return this.g.player.height; }
  get hp(): number { const H = this.g.crime.health; return (H.hp / Math.max(1, H.max)) * RAMPAGE.hp; }
  get defeated(): boolean { return false; }
  get targetable(): boolean { return this.on && !this.g.crime.health.down; }

  /** Zones round the player's body now. */
  place(): void {
    const P = this.g.player, h = P.height;
    PLAYER_ZONES.forEach((s, i) => {
      const Z = this.zones[i];
      Z.x = P.pos.x; Z.y = P.pos.y + h * s.at; Z.z = P.pos.z; Z.r = Math.max(0.3, h * s.r);
    });
  }

  update(dt: number): void {
    this.place();
    for (const Z of this.zones) Z.recent *= Math.exp(-dt / 4);
    for (const [k, v] of this.aggro) { const nv = v * Math.exp(-dt / 90); if (nv < 1) this.aggro.delete(k); else this.aggro.set(k, nv); }
  }

  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): { t: number; zone: ThreatZone } | null {
    let best: { t: number; zone: ThreatZone } | null = null;
    for (const Z of this.zones) {
      const lx = Z.x - ox, ly = Z.y - oy, lz = Z.z - oz;
      const tc = lx * dx + ly * dy + lz * dz;
      if (tc < 0) continue;
      const d2 = lx * lx + ly * ly + lz * lz - tc * tc;
      if (d2 > Z.r * Z.r) continue;
      const t = tc - Math.sqrt(Z.r * Z.r - d2);
      if (t <= maxT && (!best || t < best.t)) best = { t: Math.max(0, t), zone: Z };
    }
    return best;
  }

  zoneAt(x: number, y: number, z: number): { zone: ThreatZone; d: number } | null {
    let best: { zone: ThreatZone; d: number } | null = null;
    for (const Z of this.zones) { const d = Math.hypot(Z.x - x, Z.y - y, Z.z - z) - Z.r; if (!best || d < best.d) best = { zone: Z, d }; }
    return best;
  }

  /** Army / police damage points on a zone: after its armour, turned into the player's health. */
  damage(zone: ThreatZone | string | null, amount: number, src: DamageSource): DamageResult {
    if (!this.targetable || amount <= 0) return { dealt: 0, zone: null, weak: false };
    const Z = (typeof zone === 'string' ? this.zones.find((z) => z.id === zone) : zone) ?? (src.x !== undefined ? this.zoneAt(src.x, src.y ?? this.y, src.z ?? this.z)?.zone : null) ?? this.zones[1];
    const dealt = playerDamage(Z.armour, amount);
    const key = src.key ?? src.cause;
    this.aggro.set(key, (this.aggro.get(key) ?? 0) + dealt + (src.aggro ?? 0));
    Z.recent += dealt;
    this.stats.hits++;
    this.stats.dealt += dealt;
    const H = this.g.crime.health;
    if (H.invulnerable) return { dealt, zone: Z, weak: false };
    this.owed += dealt * H.max / RAMPAGE.hp;
    if (this.owed >= 0.6) {
      // (Health divides a blow by the body's mass — a giant shrugs off a mugger's knife; the army's numbers are meant for a giant already.)
      const k3 = this.g.player.k ** 3;
      const d = H.damage(this.owed * k3, 'military', src.x ?? this.x, src.z ?? this.z);
      this.stats.health += d;
      this.owed = 0;
    }
    return { dealt, zone: Z, weak: false };
  }

  /** The player's own blows never land on the player. */
  blow(): DamageResult | null { return null; }

  conStrength(): number { return 4 + this.height; }
}

/** The incident a rampaging giant player is to the city's response. */
export class PlayerRampage implements ThreatEvent, ArmyFoe {
  readonly id = EVENT_ID++;
  readonly archetype = 'rampage';
  readonly tier = 'major';
  readonly engageOnFoot = false;
  readonly body: PlayerBody;
  readonly actors: ThreatActor[];
  t = 0;
  active = true;
  outcome: ThreatOutcome | null = null;
  hurt = 0;
  /** What the battle model reads: the player is "in downtown" (the end of their route) — the army rings them. */
  readonly mode = 'rampage';
  readonly route = { pts: [] as number[], s: [] as number[], length: 0, start: { x: 0, z: 0 }, end: { x: 0, z: 0 } };
  readonly chased = true;
  stay = false;
  airTargets: AirProvider[] = [];
  unitAt: ((key: string) => { x: number; y: number; z: number } | null) | null = null;
  onBlow: ((kind: StriderBlow, x: number, y: number, z: number, r: number) => void) | null = null;
  private readonly head = { x: 0, y: 0, z: 0 };

  constructor(private g: Game) {
    this.body = new PlayerBody(g);
    this.actors = [this.body];
    this.path();
  }

  get x(): number { return this.g.player.pos.x; }
  get y(): number { return this.body.y; }
  get z(): number { return this.g.player.pos.z; }
  get radius(): number { return RAMPAGE.radius + this.g.player.height * RAMPAGE.radiusK; }
  get s(): number { return this.route.length; }
  get zones(): ThreatZone[] { return this.body.zones; }
  get aggro(): ReadonlyMap<string, number> { return this.body.aggro; }
  get maxHp(): number { return this.body.maxHp; }
  get hp(): number { return this.body.hp; }
  get targetable(): boolean { return this.active && this.body.targetable; }
  get defeated(): boolean { return false; }
  get headPos(): { x: number; y: number; z: number } {
    const P = this.g.player;
    this.head.x = P.pos.x; this.head.y = P.pos.y + P.height * 0.92; this.head.z = P.pos.z;
    return this.head;
  }

  /** Still in action (the share of the health left: a beaten-down giant is not worth sending more for). */
  strength(): number {
    if (!this.active) return 0;
    const H = this.g.crime.health;
    return H.invulnerable ? 1 : H.frac;
  }

  damage(zone: ThreatZone | string | null, amount: number, src: DamageSource): DamageResult { return this.body.damage(zone, amount, src); }

  targetsNear(): ThreatTarget[] { return []; }
  strike(): void { /* nothing to strike on foot */ }

  /** Where the army comes from: the city's side of the player, spread round them. */
  spawnPoint(k: number): { x: number; z: number } {
    const c = this.g.macro.centres[0];
    return playerSpawn(c.x, c.z, this.x, this.z, k);
  }

  /** The artillery beyond the city edge: out past the player from the centre. */
  batteryAt(): { x: number; z: number } {
    const R = this.route, dx = R.end.x - R.start.x, dz = R.end.z - R.start.z, l = Math.hypot(dx, dz) || 1;
    return { x: R.end.x + (dx / l) * 3200, z: R.end.z + (dz / l) * 3200 };
  }

  private path(): void {
    const c = this.g.macro.centres[0];
    playerPath(this.route, c.x, c.z, this.x, this.z);
  }

  update(dt: number): void {
    this.t += dt;
    this.body.update(dt);
    if (!this.active) return;
    this.path();
    // (Under fire from the army: no catching one's breath — health comes back slowly.)
    this.g.crime.health.regenK = RAMPAGE.regenK;
    // Brought down: taken into custody.
    if (this.g.crime.health.down) this.end('stopped');
  }

  end(outcome: ThreatOutcome): void {
    if (!this.active) return;
    this.active = false;
    this.outcome = outcome;
    this.body.on = false;
    this.g.crime.health.regenK = 1;
  }

  /** The response gives up on it (dev: threat.stop): it is over. */
  shutdown(): void { this.end('abandoned'); }

  /** The last resort's strike (the player caught in it is knocked out by the blast: LastResort). */
  obliterate(): void { this.end('destroyed'); }

  dispose(): void { this.body.on = false; }

  snapshot(): Record<string, unknown> {
    return { id: this.id, archetype: this.archetype, t: +this.t.toFixed(1), active: this.active, outcome: this.outcome, hurt: this.hurt, strength: +this.strength().toFixed(2), body: { ...this.body.stats }, aggro: Object.fromEntries([...this.body.aggro].map(([k, v]) => [k, Math.round(v)])) };
  }
}

/** Watches the player's destruction, gives the warnings, and turns a rampaging giant into an incident. */
export class HostilePlayer {
  readonly watch = new RampageWatch();
  ev: PlayerRampage | null = null;
  /** Off: no warnings, no army (dev.rampage.enabled(false)). */
  enabled = true;
  private seen: HarmEntry | null = null;
  private felled = new WeakSet<object>();
  private recent = new WeakMap<object, number>();
  private facadeT = -1e9;
  private alertK = 0;
  private droneT = 0;
  private retryT = 0;
  private busy = false;
  private devDone = false;
  readonly log: { t: number; what: string }[] = [];

  constructor(private g: Game) {}

  update(dt: number): void {
    const g = this.g;
    if (!this.devDone) this.installDev();
    const added = this.read();
    const P = g.player;
    const was = this.watch.state;
    const sig = this.enabled ? this.watch.step(dt, added, P.height, g.crime.rep.value) : null;
    if (sig) this.signal(sig);
    if (!this.enabled && was !== 'calm') { this.watch.reset(); this.ev?.end('abandoned'); }
    // The incident over by other means (brought down, the strike, dev).
    const ev = this.ev;
    if (ev && !ev.active) {
      if (ev.outcome === 'stopped') {
        g.crime.justice.arrested();
        this.note('brought down — taken into custody');
      } else this.note(`over: ${ev.outcome}`);
      if (ev.outcome === 'stopped') this.watch.served();
      else if (this.watch.state === 'hostile') this.watch.reset();
      g.forces.hostilePlayer = false;
      this.ev = null;
    }
    // Hostile while the army was busy with a monster: it comes once it is free.
    this.retryT -= dt;
    if (this.enabled && this.watch.state === 'hostile' && !this.ev && this.retryT <= 0) { this.retryT = 2; this.signal('hostile'); }
    this.warnings(dt);
  }

  /** New entries of the player's in the collateral ledger: the fury they add (and people hurt for the incident). */
  private read(): number {
    const log = this.g.consequences.log;
    let i = log.length - 1;
    while (i >= 0 && log[i] !== this.seen) i--;
    let add = 0;
    for (let k = i + 1; k < log.length; k++) {
      const e = log[k];
      if (e.cause !== 'player') continue;
      if (e.ref && this.g.threats.isHostile(e.ref)) continue;
      // (As the justice layer counts: a building comes down once; a beam on a facade or the same
      // person or car hit again and again is one deed every couple of seconds.)
      const now = this.watch.now;
      if (e.target === 'building' && e.effect === 'collapse') { const r = e.ref ?? e; if (this.felled.has(r)) continue; this.felled.add(r); }
      else if (e.target === 'building') { if (now - this.facadeT < 1.5) continue; this.facadeT = now; }
      else if (e.ref) { const last = this.recent.get(e.ref); if (last !== undefined && now - last < 3) continue; this.recent.set(e.ref, now); }
      const a = e.target === 'person' ? (e.ref as PedAgent | undefined) : undefined;
      add += furyOf({ target: e.target, effect: e.effect, size: e.size, role: a?.actor?.role });
      if (this.ev && a && e.effect === 'knockdown') this.ev.hurt++;
    }
    this.seen = log[log.length - 1] ?? null;
    return add;
  }

  private signal(sig: string): void {
    const g = this.g, H = g.powerHud, p = g.player.pos;
    switch (sig) {
      case 'warn':
        H.toast('<b>Warning</b> — the city sees a giant on the rampage. Stop the destruction, or the army is called in', 'warn', 6000);
        g.audio.play2d('siren_short', 0.6);
        this.shout(['Stand down! Now!', 'Stop right there!', 'This is your only warning!']);
        g.future.drones.incident(DKind.Police, p.x, p.z, p.x, p.z);
        this.note('warning');
        break;
      case 'final':
        H.toast('<b>Final warning</b> — the National Guard is being called. Stop now, or shrink back to human size', 'warn', 6000);
        g.audio.play2d('siren_short', 0.8);
        this.shout(['Last warning!', 'The Guard is coming — stand down!']);
        this.note('final warning');
        break;
      case 'hostile': {
        // (The army is busy with a monster: the police deal with the player for now.)
        if (g.threats.events.some((e) => e.active && e.tier === 'major')) { if (!this.busy) this.note('hostile — the army is busy elsewhere'); this.busy = true; break; }
        this.busy = false;
        const ev = g.threats.start('rampage', 0, {}, { x: p.x, z: p.z }) as PlayerRampage | null;
        if (!ev) break;
        this.ev = ev;
        g.forces.hostilePlayer = true;
        H.toast('The city treats you as a threat — the army is coming. Stand down (no more destruction, or human size) to end it', 'warn', 7000);
        this.note(`hostile: incident #${ev.id}`);
        break;
      }
      case 'lapse':
        H.toast('You stopped in time — the warnings lapse', 'info');
        this.note('warnings lapsed');
        break;
      case 'standDown':
        if (this.ev?.active) {
          this.ev.end('abandoned');
          H.toast('You stood down — the army pulls back', 'info');
        }
        this.note('stood down');
        break;
    }
  }

  /** While warned: the red alert on the screens round the player, a police drone overhead. */
  private warnings(dt: number): void {
    const g = this.g, s = this.watch.state, p = g.player.pos;
    const on = this.enabled && (s === 'warned' || s === 'final');
    if (on) {
      this.droneT -= dt;
      if (this.droneT <= 0) { this.droneT = 30; g.future.drones.incident(DKind.Police, p.x, p.z, p.x, p.z); }
    } else this.droneT = 0;
    const k = this.alertK;
    this.alertK += ((on ? 1 : 0) - k) * Math.min(1, dt * 1.5);
    // (Only while no incident has the screens: the response's own alert takes over then.)
    if ((on || k > 0.02) && !g.response.incidents.some((i) => !i.closed)) g.future.signs.alert(p.x, p.z, 400, this.alertK > 0.02 ? this.alertK : 0);
  }

  /** The nearest officer (or soldier) shouts up at the giant. */
  private shout(lines: string[]): void {
    const g = this.g, p = g.player.pos;
    let best: PedAgent | null = null, bd = 120;
    for (const a of g.peds.neighbours(p.x, p.z, 120, [])) {
      const r = a.actor?.role;
      if ((r !== 'police' && r !== 'soldier') || a.state === PState.Down) continue;
      const d = Math.hypot(a.x - p.x, a.z - p.z);
      if (d < bd) { bd = d; best = a; }
    }
    if (best) g.barks.say(best, lines[Math.floor(Math.random() * lines.length)]);
  }

  private note(what: string): void {
    this.log.push({ t: +this.watch.now.toFixed(1), what });
    if (this.log.length > 40) this.log.shift();
  }

  status(): Record<string, unknown> {
    const W = this.watch;
    return {
      enabled: this.enabled, state: W.state, fury: +W.fury.toFixed(2), t: +W.t.toFixed(1), quiet: +W.quiet.toFixed(1),
      height: +this.g.player.height.toFixed(1), rep: this.g.crime.rep.value, incident: this.ev?.snapshot() ?? null, stats: { ...W.stats },
      log: this.log.slice(-8).map((l) => `${l.t}: ${l.what}`),
    };
  }

  private installDev(): void {
    const dev = (window as unknown as { dev?: Record<string, unknown> }).dev;
    if (!dev) return;
    this.devDone = true;
    dev.rampage = {
      hostile: this,
      /** Where the watch stands: state, fury, the incident. */
      status: () => this.status(),
      /** Add fury now (as if the player had levelled that much). */
      fury: (n = RAMPAGE.act + 2) => { this.watch.fury += n; return this.status(); },
      /** Skip the warnings: the army comes for the player now (needs a giant). */
      now: () => { if (this.watch.state !== 'hostile') this.signal(this.watch.force()); return this.status(); },
      /** Stand down now. */
      stop: () => { if (this.watch.state === 'hostile') { this.watch.reset(); this.signal('standDown'); } return this.status(); },
      enabled: (on?: boolean) => { if (on !== undefined) this.enabled = on; return this.enabled; },
      tuning: RAMPAGE,
    };
  }
}
