/**
 * Entry point: start menu (seed, size), loading screen, game.
 */
import './style.css';
import { Game } from './game/Game';
import { parseSeed } from './core/rng';
import { cityRadius, cityClass } from './world/settings';
import { cityName } from './plan/names';
import { AvatarMenu, loadSelectedAvatar, loadSelectedLook } from './ui/AvatarMenu';
import { disposeCreatorPreview } from './ui/CharacterCreator';
import { Player } from './player/Player';
import { normalizeLook } from './avatar/look';
import { loadMode, saveMode, MODE_INFO, type GameMode } from './game/mode';
import { saveStore } from './game/save/SaveStore';
import type { SaveData } from './game/save/model';
import { avatarStore } from './avatar/AvatarStore';
import type { CharacterLook } from './avatar/look';
import { MainMenuSaves } from './ui/SaveUi';
import { versionLink } from './ui/Changelog';
import { MenuMusic } from './audio/music/MenuMusic';

const params = new URLSearchParams(location.search);
const menu = document.getElementById('menu') as HTMLDivElement;
menu.querySelector('.sub')?.after(versionLink());
const seedIn = document.getElementById('seed') as HTMLInputElement;
const sizeIn = document.getElementById('size') as HTMLInputElement;
const sizeLabel = document.getElementById('sizeLabel') as HTMLSpanElement;
const nameLabel = document.getElementById('cityName') as HTMLSpanElement;
const startBtn = document.getElementById('start') as HTMLButtonElement;
const loading = document.getElementById('loading') as HTMLDivElement;
const loadMsg = document.getElementById('loadMsg') as HTMLDivElement;
const loadBar = document.getElementById('loadBar') as HTMLDivElement;

seedIn.value = params.get('seed') ?? String(Math.floor(Math.random() * 1e6));
sizeIn.value = params.get('size') ?? '0.35';

function refresh(): void {
  const size = Number(sizeIn.value);
  const r = cityRadius(size);
  const cls = cityClass(size);
  sizeLabel.textContent = `${cls} · ${(r * 2 / 1000).toFixed(1)} km across`;
  nameLabel.textContent = cityName(parseSeed(seedIn.value));
}
// Character picker (imported models persist in the browser).
startBtn.before(new AvatarMenu(startBtn.parentElement as HTMLElement).el);
// Game mode (remembered; ?mode=sandbox|normal overrides for this start).
let mode: GameMode = params.get('mode') === 'sandbox' ? 'sandbox' : params.get('mode') === 'normal' ? 'normal' : loadMode();
const modeBtns = [...document.querySelectorAll<HTMLButtonElement>('#modes .mode')];
function showMode(): void {
  for (const b of modeBtns) {
    const m = b.dataset.mode as GameMode;
    b.classList.toggle('sel', m === mode);
    b.setAttribute('aria-pressed', String(m === mode));
    (b.querySelector('.mode-desc') as HTMLElement).textContent = MODE_INFO[m].desc;
  }
}
for (const b of modeBtns) b.addEventListener('click', () => { mode = b.dataset.mode as GameMode; saveMode(mode); showMode(); });
showMode();
// Saves: Continue (the newest) and Load game, above the choice for a new city.
new MainMenuSaves(document.getElementById('menuResume') as HTMLElement, null, (m) => void startFromSave(m.id));
seedIn.addEventListener('input', refresh);
sizeIn.addEventListener('input', refresh);
refresh();

// The start screen's theme (after the first click or key; not for automatic starts).
const menuMusic = params.has('auto') || params.get('load') ? null : new MenuMusic();
(window as unknown as { menuMusic: MenuMusic | null }).menuMusic = menuMusic;

let starting = false;

async function start(save: SaveData | null = null): Promise<void> {
  if (starting) return;
  starting = true;
  const settings = save ? { ...save.city } : { seed: parseSeed(seedIn.value), size: Number(sizeIn.value) };
  if (save) mode = save.mode;
  // (The load flag is dropped: a reload later starts from the menu, not from that old save again.)
  history.replaceState(null, '', `?seed=${encodeURIComponent(seedIn.value)}&size=${sizeIn.value}${params.has('mode') || save ? `&mode=${mode}` : ''}${params.has('auto') ? '&auto' : ''}${params.has('mute') ? '&mute' : ''}${['intro', 'warm'].map((k) => (params.has(k) ? `&${k}${params.get(k) ? `=${params.get(k)}` : ''}` : '')).join('')}`);
  menu.style.display = 'none';
  loading.style.display = 'flex';
  disposeCreatorPreview();
  // Character made in the creator (if one is selected): the player is built with its look.
  // A save brings its character back (the stored one when it still exists, else the look it kept).
  let savedLook: CharacterLook | null = null;
  if (save) {
    try {
      const id = save.character.id;
      if (id && await avatarStore.get(id)) avatarStore.select(id);
      else { avatarStore.select(null); savedLook = save.character.look as CharacterLook | null; }
    } catch (e) { console.warn('[saves] character', e); }
  }
  try {
    const sel = await loadSelectedLook();
    Player.look = sel ? normalizeLook(sel.look) : savedLook ? normalizeLook(savedLook) : null;
    if (sel) console.log(`[avatar] ${sel.name}: created character`);
  } catch (e) {
    console.error('[avatar] could not load the selected character', e);
  }
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const game = new Game(canvas, settings, mode);
  (window as unknown as { game: Game }).game = game;
  if (save) { game.pendingSave = save; game.startAt = { x: save.player.x, z: save.player.z }; }
  await game.start((msg, f) => {
    loadMsg.textContent = msg;
    loadBar.style.width = `${Math.round(f * 100)}%`;
  });
  loading.style.display = 'none';
  menuMusic?.stop(4);
  // Imported character (if one is selected).
  try {
    const sel = await loadSelectedAvatar();
    if (sel) {
      const a = await game.player.setAvatar(sel.model, !!sel.stored.forceClips);
      console.log(`[avatar] ${sel.stored.name}: ${a?.mode} (${a?.mapping.source})`);
    }
  } catch (e) {
    console.error('[avatar] could not load the selected character', e);
    flash('Your imported character could not be loaded — playing the default human.');
  }
}

function flash(text: string): void {
  const d = document.createElement('div');
  d.id = 'hint';
  d.textContent = text;
  document.body.appendChild(d);
  setTimeout(() => d.classList.add('fade'), 6000);
}

/** Start the city of a save, with the save (Continue, Load game, `?load=<id>`). */
async function startFromSave(id: string): Promise<void> {
  let d: SaveData | null = null;
  try { await saveStore.recover(); d = await saveStore.get(id); } catch (e) { console.warn('[saves]', e); }
  if (!d) { flash('That saved game could not be read — choose a city to start a new game.'); menu.style.display = ''; return; }
  seedIn.value = String(d.city.seed);
  sizeIn.value = String(d.city.size);
  refresh();
  await start(d);
}

startBtn.addEventListener('click', () => void start());
if (params.get('load')) void startFromSave(params.get('load')!);
else if (params.has('auto')) void start();
