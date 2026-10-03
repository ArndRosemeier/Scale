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

const params = new URLSearchParams(location.search);
const menu = document.getElementById('menu') as HTMLDivElement;
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
seedIn.addEventListener('input', refresh);
sizeIn.addEventListener('input', refresh);
refresh();

async function start(): Promise<void> {
  const settings = { seed: parseSeed(seedIn.value), size: Number(sizeIn.value) };
  history.replaceState(null, '', `?seed=${encodeURIComponent(seedIn.value)}&size=${sizeIn.value}${params.has('auto') ? '&auto' : ''}`);
  menu.style.display = 'none';
  loading.style.display = 'flex';
  disposeCreatorPreview();
  // Character made in the creator (if one is selected): the player is built with its look.
  try {
    const sel = await loadSelectedLook();
    Player.look = sel ? normalizeLook(sel.look) : null;
    if (sel) console.log(`[avatar] ${sel.name}: created character`);
  } catch (e) {
    console.error('[avatar] could not load the selected character', e);
  }
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const game = new Game(canvas, settings);
  (window as unknown as { game: Game }).game = game;
  await game.start((msg, f) => {
    loadMsg.textContent = msg;
    loadBar.style.width = `${Math.round(f * 100)}%`;
  });
  loading.style.display = 'none';
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

startBtn.addEventListener('click', () => void start());
if (params.has('auto')) void start();
