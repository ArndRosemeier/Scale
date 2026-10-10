/**
 * Hidden admin console (Ctrl+Shift+F12): "Go to" buttons for every place worth a look in this city
 * (debug/goTo: landmarks and their insides, shops, cemeteries, the underground, what is going on), buttons for the things worth trying out — spawn the
 * Strider or a robot malfunction, set the city response level, start crimes and small deeds, call up street characters,
 * karma, health, size, time of day, the slime colonies — and a command line that runs any
 * JavaScript with `game` and `dev` in scope (Up / Down for history).
 *
 * Built on the console helpers (`window.dev`, installed by the systems themselves); a button
 * whose helper is missing just says so. While open, the game gets no keyboard input.
 */
import type { Game } from '../game/Game';

type Dev = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Btn { label: string; run: (g: Game, dev: Dev) => unknown }

const HISTORY_KEY = 'scale.admin.history';

export class AdminConsole {
  private el: HTMLDivElement;
  private log: HTMLDivElement;
  private input: HTMLInputElement;
  private history: string[] = [];
  private hi = -1;
  /** The "Go to" sections: made from the city each time the console opens (debug/goTo). */
  private places: HTMLDivElement;
  open = false;

  constructor(private game: Game) {
    this.el = document.createElement('div');
    this.el.id = 'admin';
    this.el.innerHTML = `<div class="adm-head"><b>Admin console</b><span>Ctrl+Shift+F12 / Esc to close</span></div><div class="adm-body"></div>
      <div class="adm-log"></div><input class="adm-cmd" type="text" spellcheck="false" placeholder="JavaScript — game, dev in scope (e.g. dev.threat.strider.status())">`;
    document.body.appendChild(this.el);
    this.log = this.el.querySelector('.adm-log')!;
    this.input = this.el.querySelector('.adm-cmd')!;
    try { this.history = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]'); } catch { /* storage unavailable */ }
    const body = this.el.querySelector('.adm-body')!;
    this.places = document.createElement('div');
    body.appendChild(this.places);
    for (const [title, btns] of SECTIONS) {
      const sec = document.createElement('div');
      sec.className = 'adm-sec';
      sec.innerHTML = `<h4>${title}</h4>`;
      for (const b of btns) {
        const e = document.createElement('button');
        e.textContent = b.label;
        e.onclick = () => this.exec(b.label, () => b.run(this.game, this.dev()));
        sec.appendChild(e);
      }
      body.appendChild(sec);
    }
    // Capture phase: the map and the game never see these keys.
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F12' && e.ctrlKey && e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); this.toggle(); return; }
      if (!this.open) return;
      if (e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.toggle(false); return; }
      if (e.target !== this.input) return;
      e.stopImmediatePropagation();
      if (e.code === 'Enter') { e.preventDefault(); this.command(this.input.value); }
      else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        e.preventDefault();
        if (!this.history.length) return;
        this.hi = Math.max(-1, Math.min(this.history.length - 1, this.hi + (e.code === 'ArrowUp' ? 1 : -1)));
        this.input.value = this.hi < 0 ? '' : this.history[this.history.length - 1 - this.hi];
      }
    }, true);
  }

  toggle(on = !this.open): void {
    this.open = on;
    this.el.classList.toggle('open', on);
    const g = this.game;
    if (on) {
      g.input.keys.clear();
      g.input.buttons = 0;
      if (document.pointerLockElement) document.exitPointerLock();
      this.fillPlaces();
      setTimeout(() => this.input.focus(), 0);
    } else this.input.blur();
  }

  /** One section per group of places (landmarks, city, underground, now); several of a kind step on. */
  private fillPlaces(): void {
    this.places.textContent = '';
    const list = this.dev().goto?.places?.() as { group: string; label: string; go: () => unknown }[] | undefined;
    if (!list) return;
    const groups = new Map<string, HTMLDivElement>();
    for (const p of list) {
      let sec = groups.get(p.group);
      if (!sec) {
        sec = document.createElement('div');
        sec.className = 'adm-sec';
        sec.innerHTML = `<h4>Go to: ${p.group}</h4>`;
        groups.set(p.group, sec);
        this.places.appendChild(sec);
      }
      const e = document.createElement('button');
      e.textContent = p.label;
      e.onclick = () => this.exec('Go to ' + p.label, () => p.go());
      sec.appendChild(e);
    }
  }

  private dev(): Dev {
    return ((window as unknown as { dev?: Dev }).dev ?? {}) as Dev;
  }

  private command(src: string): void {
    const s = src.trim();
    if (!s) return;
    this.history = this.history.filter((h) => h !== s).concat(s).slice(-50);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(this.history)); } catch { /* storage unavailable */ }
    this.hi = -1;
    this.input.value = '';
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('game', 'dev', `return (${s});`) as (g: Game, d: Dev) => unknown;
    this.exec(s, () => fn(this.game, this.dev()));
  }

  private exec(label: string, f: () => unknown): void {
    let out: string;
    let bad = false;
    try {
      const r = f();
      if (r instanceof Promise) { r.then((v) => this.print(`${label} → ${show(v)}`), (e) => this.print(`${label} → ${e}`, true)); return; }
      out = show(r);
    } catch (e) { out = String(e); bad = true; }
    this.print(`${label} → ${out}`, bad);
  }

  private print(text: string, bad = false): void {
    const line = document.createElement('div');
    line.textContent = text;
    if (bad) line.className = 'bad';
    this.log.appendChild(line);
    while (this.log.children.length > 60) this.log.firstElementChild!.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }
}

function show(v: unknown): string {
  if (v === undefined) return 'ok';
  if (typeof v === 'string') return v;
  try {
    const s = JSON.stringify(v, (_k, x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : x));
    if (s === undefined) return String(v);
    if (s.length <= 400) return s;
    // Too long for the log: the whole of it goes to the clipboard (to paste into a bug report).
    navigator.clipboard?.writeText(s).catch(() => { /* no clipboard access */ });
    return `${s.slice(0, 400)}… (full output copied to the clipboard)`;
  } catch { return String(v); }
}

/** Calls a helper that may not exist (a system not built in this mode / build). */
function call(dev: Dev, path: string, ...args: unknown[]): unknown {
  let o: Dev | undefined = dev, parent: Dev | undefined;
  for (const k of path.split('.')) { parent = o; o = o?.[k]; }
  if (typeof o !== 'function') return `no dev.${path} here`;
  return (o as (...a: unknown[]) => unknown).apply(parent, args);
}

const SECTIONS: [string, Btn[]][] = [
  ['Strider', [
    { label: 'Spawn (river)', run: (_g, d) => call(d, 'threat.spawn', 'strider', { from: 'river' }) },
    { label: 'Spawn + go there', run: (_g, d) => { const r = call(d, 'threat.spawn', 'strider', { from: 'river' }); call(d, 'threat.strider.player', 120); return r; } },
    { label: 'Roar', run: (_g, d) => call(d, 'threat.strider.roar') },
    { label: 'Rear + roar', run: (_g, d) => call(d, 'threat.strider.roar', true) },
    { label: 'Breathe', run: (_g, d) => call(d, 'threat.strider.breathe') },
    { label: 'Tail swipe', run: (_g, d) => call(d, 'threat.strider.swipe') },
    { label: 'Expose throat', run: (_g, d) => call(d, 'threat.strider.expose', 'throat') },
    { label: 'Damage 300', run: (_g, d) => call(d, 'threat.strider.damage', 'back', 300) },
    { label: 'Skip 100 m', run: (_g, d) => call(d, 'threat.strider.skip', 100) },
    { label: 'Retreat', run: (_g, d) => call(d, 'threat.strider.retreat') },
    { label: 'Kill', run: (_g, d) => call(d, 'threat.strider.die') },
    { label: 'Status', run: (_g, d) => call(d, 'threat.strider.status') },
  ]],
  ['Giant worm', [
    { label: 'Spawn (its way in)', run: (_g, d) => call(d, 'threat.spawn', 'burrower') },
    { label: 'Spawn under you', run: (_g, d) => { const r = call(d, 'threat.spawn', 'burrower', { near: true }); call(d, 'threat.burrower.breach', true); return r; } },
    { label: 'Break out (ahead)', run: (_g, d) => call(d, 'threat.burrower.breach') },
    { label: 'Break out at you', run: (_g, d) => call(d, 'threat.burrower.breach', true) },
    { label: 'Slam at you', run: (_g, d) => call(d, 'threat.burrower.slam') },
    { label: 'Dive', run: (_g, d) => call(d, 'threat.burrower.dive') },
    { label: 'Damage 300', run: (_g, d) => call(d, 'threat.burrower.damage', 'body', 300) },
    { label: 'Skip 100 m', run: (_g, d) => call(d, 'threat.burrower.skip', 100) },
    { label: 'Retreat', run: (_g, d) => call(d, 'threat.burrower.retreat') },
    { label: 'Kill (when up)', run: (_g, d) => call(d, 'threat.burrower.die') },
    { label: 'Sinkhole ahead', run: (_g, d) => call(d, 'threat.burrower.hole', 22, 7) },
    { label: 'Omen: rumble', run: (_g, d) => call(d, 'threat.burrower.omen', 'rumble') },
    { label: 'Omen: pothole', run: (_g, d) => call(d, 'threat.burrower.omen', 'pothole') },
    { label: 'Status', run: (_g, d) => call(d, 'threat.burrower.status') },
  ]],
  ['Roc', [
    { label: 'Spawn (flies in)', run: (_g, d) => call(d, 'threat.spawn', 'roc') },
    { label: 'Spawn circling overhead', run: (_g, d) => call(d, 'threat.spawn', 'roc', { near: true }) },
    { label: 'Perch on a roof', run: (_g, d) => call(d, 'threat.roc.perch') },
    { label: 'Snatch a car', run: (_g, d) => call(d, 'threat.roc.snatch') },
    { label: 'Swoop at me', run: (_g, d) => call(d, 'threat.roc.swoop') },
    { label: 'Dive on a flier', run: (_g, d) => call(d, 'threat.roc.dive') },
    { label: 'Ground it', run: (_g, d) => call(d, 'threat.roc.ground') },
    { label: 'Damage 300', run: (_g, d) => call(d, 'threat.roc.damage', 'body', 300) },
    { label: 'Fly off', run: (_g, d) => call(d, 'threat.roc.leave') },
    { label: 'Kill', run: (_g, d) => call(d, 'threat.roc.die') },
    { label: 'Omen: cry', run: (_g, d) => call(d, 'threat.roc.omen', 'cry') },
    { label: 'Omen: fly-over', run: (_g, d) => call(d, 'threat.roc.omen', 'flyover') },
    { label: 'Status', run: (_g, d) => call(d, 'threat.roc.status') },
  ]],
  ['Giant mech', [
    { label: 'Spawn (walks in)', run: (_g, d) => call(d, 'threat.spawn', 'mech') },
    { label: 'Spawn near me', run: (_g, d) => call(d, 'threat.spawn', 'mech', { near: true }) },
    { label: 'Jump downtown', run: (_g, d) => call(d, 'threat.mech.downtown') },
    { label: 'Missile salvo', run: (_g, d) => call(d, 'threat.mech.salvo') },
    { label: 'Cannon at a flier', run: (_g, d) => call(d, 'threat.mech.cannon') },
    { label: 'Hammer blow', run: (_g, d) => call(d, 'threat.mech.smash') },
    { label: 'Vent heat', run: (_g, d) => call(d, 'threat.mech.vent') },
    { label: 'Freeze (shut down)', run: (_g, d) => call(d, 'threat.mech.freeze') },
    { label: 'Buckle a knee', run: (_g, d) => call(d, 'threat.mech.kneel') },
    { label: 'Damage 300', run: (_g, d) => call(d, 'threat.mech.damage', 'body', 300) },
    { label: 'Walk off', run: (_g, d) => call(d, 'threat.mech.leave') },
    { label: 'Destroy', run: (_g, d) => call(d, 'threat.mech.die') },
    { label: 'Omen: footfalls', run: (_g, d) => call(d, 'threat.mech.omen', 'stomps') },
    { label: 'Omen: news bulletin', run: (_g, d) => call(d, 'threat.mech.omen', 'bulletin') },
    { label: 'Status', run: (_g, d) => call(d, 'threat.mech.status') },
  ]],
  ['Leviathan', [
    { label: 'Spawn (up the river)', run: (_g, d) => call(d, 'threat.spawn', 'leviathan') },
    { label: 'Spawn at the nearest bridge', run: (_g, d) => { const r = call(d, 'threat.spawn', 'leviathan', { near: true }); call(d, 'threat.leviathan.surface'); return r; } },
    { label: 'Surface now', run: (_g, d) => call(d, 'threat.leviathan.surface') },
    { label: 'Sink', run: (_g, d) => call(d, 'threat.leviathan.sink') },
    { label: 'Break a span', run: (_g, d) => call(d, 'threat.leviathan.breakSpan') },
    { label: 'Freeze 4 s', run: (_g, d) => call(d, 'threat.leviathan.freeze', 4) },
    { label: 'Damage 300', run: (_g, d) => call(d, 'threat.leviathan.damage', 'neck', 300) },
    { label: 'Retreat', run: (_g, d) => call(d, 'threat.leviathan.retreat') },
    { label: 'Kill (when up)', run: (_g, d) => call(d, 'threat.leviathan.die') },
    { label: 'Omen: wake', run: (_g, d) => call(d, 'threat.leviathan.omen', 'wake') },
    { label: 'Omen: surge', run: (_g, d) => call(d, 'threat.leviathan.omen', 'surge') },
    { label: 'Broken bridges', run: (_g, d) => call(d, 'threat.leviathan.bridges') },
    { label: 'Status', run: (_g, d) => call(d, 'threat.leviathan.status') },
  ]],
  ['City events', [
    { label: 'Robot malfunction', run: (_g, d) => call(d, 'threat.spawn', 'robots') },
    { label: 'Swarm (scout pack)', run: (_g, d) => call(d, 'threat.spawn', 'brood', { dist: 50 }) },
    { label: 'Swarm (150)', run: (_g, d) => call(d, 'threat.spawn', 'brood', { dist: 60, count: 150 }) },
    { label: 'Awakened tree (the tree nearest you)', run: (_g, d) => call(d, 'threat.spawn', 'tree', { dist: 30 }) },
    { label: 'Swarm status', run: (_g, d) => call(d, 'threat.brood.status') },
    { label: 'Omen: chitter', run: (_g, d) => call(d, 'threat.omen', 'chitter') },
    { label: 'Omen: glimpse', run: (_g, d) => call(d, 'threat.omen', 'glimpse') },
    { label: 'Omen: glitch', run: (_g, d) => call(d, 'threat.omen', 'glitch') },
    { label: 'Omen: tremor', run: (_g, d) => call(d, 'threat.strider.omen', 'tremor') },
    { label: 'Stop all events', run: (_g, d) => call(d, 'threat.stop') },
    ...[0, 1, 2, 3, 4, 5].map((n) => ({ label: `Response ${n}`, run: (_g: Game, d: Dev) => call(d, 'response.level', n) })),
    { label: 'Events status', run: (_g, d) => call(d, 'threat.events') },
  ]],
  ['Army', [
    { label: 'Battle status', run: (_g, d) => call(d, 'army.status') },
    { label: 'Spawn tank', run: (_g, d) => call(d, 'army.spawn', 'tank', 40) },
    { label: 'Spawn helicopter', run: (_g, d) => call(d, 'army.spawn', 'heli', 60) },
    { label: 'Spawn squad', run: (_g, d) => call(d, 'army.spawn', 'rifles', 25) },
    { label: 'Spawn APC', run: (_g, d) => call(d, 'army.spawn', 'apc', 40) },
    { label: 'Airstrike', run: (_g, d) => call(d, 'army.airstrike') },
    { label: 'No-player battle (sim)', run: (g, d) => { const r = call(d, 'army.sim', g.settings.seed) as Record<string, unknown> | string; return typeof r === 'string' ? r : { winner: r.winner, outcome: r.outcome, t: Math.round(r.t as number), hp: r.hp, lost: r.lost }; } },
  ]],
  ['Crime & deeds', [
    { label: 'Snatch', run: (_g, d) => call(d, 'crime', 'snatch', 25) },
    { label: 'Mugging', run: (_g, d) => call(d, 'crime', 'mugging', 25) },
    { label: 'Robbery', run: (_g, d) => call(d, 'crime', 'robbery', 40) },
    { label: 'Racket (gang)', run: (_g, d) => call(d, 'crime', 'racket', 30, 0) },
    { label: 'Tagging (gang)', run: (_g, d) => call(d, 'crime', 'tagging', 30, 0) },
    { label: 'Turf brawl', run: (_g, d) => call(d, 'crime', 'brawl', 35, 0) },
    { label: 'Gang Brute (mugging)', run: (_g, d) => call(d, 'crime', 'mugging', 25, 0, 'lt') },
    { label: 'Syndicate Enforcer (robbery)', run: (_g, d) => call(d, 'crime', 'robbery', 30, 1, 'lt') },
    { label: 'Brawl with lieutenants', run: (_g, d) => call(d, 'crime', 'brawl', 35, 0, 'lt') },
    { label: 'Robot hijack (techno-cult)', run: (_g, d) => call(d, 'crime', 'hijack', 40, 'techno') },
    { label: 'Ritual (elemental cult)', run: (_g, d) => call(d, 'crime', 'ritual', 40, 'cult') },
    { label: 'Technomancer (hijack)', run: (_g, d) => call(d, 'crime', 'hijack', 40, 'techno', 'lt') },
    { label: 'Invoker (ritual)', run: (_g, d) => call(d, 'crime', 'ritual', 40, 'cult', 'lt') },
    { label: 'Sabotage (eco-radicals)', run: (_g, d) => call(d, 'crime', 'sabotage', 40, 'eco') },
    { label: 'Beast-master + dogs (sabotage)', run: (_g, d) => call(d, 'crime', 'sabotage', 40, 'eco', 'lt') },
    { label: 'Raising (necromancers)', run: (_g, d) => call(d, 'crime', 'raising', 40, 'necro') },
    { label: 'Procession of thralls', run: (_g, d) => call(d, 'crime', 'procession', 40, 'necro') },
    { label: 'Bone-caller (raising)', run: (_g, d) => call(d, 'crime', 'raising', 40, 'necro', 'lt') },
    { label: 'Boss op: tree waking (eco)', run: (_g, d) => call(d, 'bossOp', 'eco', 60) },
    { label: 'Boss op: the dead rise (necro)', run: (_g, d) => call(d, 'bossOp', 'necro', 60) },
    { label: 'Rush hacks and rituals', run: (_g, d) => call(d, 'rushOps') },
    { label: 'Gang boss (mugging)', run: (_g, d) => call(d, 'crime', 'mugging', 25, 'gang', 'boss') },
    { label: 'Syndicate boss (robbery)', run: (_g, d) => call(d, 'crime', 'robbery', 30, 'syndicate', 'boss') },
    { label: 'Cult boss (ritual)', run: (_g, d) => call(d, 'crime', 'ritual', 40, 'cult', 'boss') },
    { label: 'Gang hunts you (notoriety 80)', run: (_g, d) => call(d, 'bosses', 'gang', 80) },
    { label: 'Bosses and notoriety', run: (_g, d) => call(d, 'bosses') },
    { label: 'Caster: bolt, fireball, gust', run: (_g, d) => call(d, 'crime', 'mugging', 25, -1, 'bolt,fireball,gust') },
    { label: 'Groups & hideouts', run: (_g, d) => call(d, 'factions') },
    { label: 'Go to gang hideout', run: (_g, d) => call(d, 'hideout', 0, 'go') },
    { label: 'Turf drift 24 h', run: (_g, d) => call(d, 'drift', 24) },
    { label: 'Mad bomber', run: (_g, d) => call(d, 'crime', 'bomber', 40) },
    { label: 'Cat in tree', run: (_g, d) => call(d, 'deed', 'cat') },
    { label: 'Runaway dog', run: (_g, d) => call(d, 'deed', 'dog') },
    { label: 'Lost wallet', run: (_g, d) => call(d, 'deed', 'wallet') },
    { label: 'Wanted 3', run: (_g, d) => call(d, 'wanted', 3) },
    { label: 'Wanted 0', run: (_g, d) => call(d, 'wanted', 0) },
  ]],
  ['Street life', [
    ...(['preacher', 'busker', 'statue', 'mime', 'juggler', 'dancer', 'mascot', 'conspiracy', 'pigeons', 'sleepwalker', 'tourist', 'jogger'] as const).map((k) => ({ label: k[0].toUpperCase() + k.slice(1), run: (_g: Game, d: Dev) => call(d, 'street.spawn', k, 7) })),
    { label: 'Who is about', run: (_g, d) => call(d, 'street.list') },
    { label: 'Sites near', run: (_g, d) => call(d, 'street.sites') },
    { label: 'Clear', run: (_g, d) => call(d, 'street.clear') },
  ]],
  ['Player', [
    { label: '+100 karma', run: (g) => { g.progress.addKarma(100, 'admin'); return g.progress.sandbox ? 'sandbox has no karma' : g.progress.karma; } },
    { label: 'Heal', run: (g) => { g.crime.health.hp = g.crime.health.max; return 'healed'; } },
    { label: 'Invulnerable on/off', run: (g) => (g.crime.health.invulnerable = !g.crime.health.invulnerable) },
    // Sizes beyond what the size power's rank allows stay until "Size: normal" (Player.sizeOverride).
    ...[0.3, 10, 25].map((h) => ({ label: `Size ${h} m`, run: (g: Game) => { g.player.sizeOverride = true; g.player.height = h; return h; } })),
    { label: 'Size: normal', run: (g) => { g.player.sizeOverride = false; g.player.height = 1.8; return 1.8; } },
    { label: 'Go to map marker', run: (g, d) => { const w = g.map.waypoint; if (!w) return 'set a marker on the map first'; return call(d, 'teleport', w.x, w.z); } },
  ]],
  ['World', [
    ...[6, 12, 18, 22].map((h) => ({ label: `${h}:00`, run: (_g: Game, d: Dev) => call(d, 'hour', h) })),
    { label: 'Fast time on/off', run: (g) => (g.sky.timeScale = g.sky.timeScale >= 600 ? 1 : 600) },
    ...[0, 1, 2].map((i) => ({ label: `Slime colony ${i}`, run: (_g: Game, d: Dev) => call(d, 'colony', i) })),
  ]],
  ['Slimes', [
    ...['hall', 'gardens', 'lake', 'archive', 'front', 'trench', 'noMans', 'lookout', 'bottom', 'warrens', 'heart'].map((k) => ({ label: 'Go: ' + k, run: (_g: Game, d: Dev) => call(d, 'deep.go', k) })),
    { label: 'Trust +25', run: (g) => { g.slimeRealm.trust.add(25, 'admin'); return g.slimeRealm.trust.value; } },
    { label: 'Trust -25', run: (g) => { g.slimeRealm.trust.add(-25, 'admin'); return g.slimeRealm.trust.value; } },
    { label: 'Raid now', run: (g) => { g.slimeRealm.devRaid(); return 'raid due'; } },
    { label: 'Murk break out', run: (g) => { g.slimeRealm.devBreach(); return 'breach'; } },
    { label: 'Status', run: (g) => g.slimeRealm.debug() },
  ]],
  ['Weather', [
    ...(['clear', 'fair', 'cloudy', 'overcast', 'drizzle', 'rain', 'storm', 'fog'] as const).map((k) => ({ label: k[0].toUpperCase() + k.slice(1), run: (_g: Game, d: Dev) => call(d, 'weather.set', k) })),
    { label: 'Next', run: (_g, d) => call(d, 'weather.next') },
    { label: 'Clear (auto)', run: (_g, d) => call(d, 'weather.auto') },
    { label: 'Lightning', run: (_g, d) => call(d, 'weather.strike', 800) },
    { label: 'Status', run: (_g, d) => call(d, 'weather.status') },
    { label: 'Forecast', run: (_g, d) => call(d, 'weather.forecast', 8) },
  ]],
  ['Saves', [
    { label: 'Save now', run: (_g, d) => call(d, 'save.now', 'Quick save') },
    { label: 'Autosave now', run: (_g, d) => call(d, 'save.auto') },
    { label: 'Load latest', run: (_g, d) => call(d, 'save.load', 'latest') },
    { label: 'List saves', run: (_g, d) => call(d, 'save.list') },
    { label: 'Save sizes', run: (_g, d) => call(d, 'save.sizes') },
    { label: 'Status', run: (_g, d) => call(d, 'save.status') },
  ]],
];
