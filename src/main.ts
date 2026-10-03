/**
 * Entry point: start menu (seed, size), loading screen, game.
 */
import './style.css';
import { Game } from './game/Game';
import { parseSeed } from './core/rng';
import { cityRadius, cityClass } from './world/settings';
import { cityName } from './plan/names';

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
seedIn.addEventListener('input', refresh);
sizeIn.addEventListener('input', refresh);
refresh();

async function start(): Promise<void> {
  const settings = { seed: parseSeed(seedIn.value), size: Number(sizeIn.value) };
  history.replaceState(null, '', `?seed=${encodeURIComponent(seedIn.value)}&size=${sizeIn.value}${params.has('auto') ? '&auto' : ''}`);
  menu.style.display = 'none';
  loading.style.display = 'flex';
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const game = new Game(canvas, settings);
  (window as unknown as { game: Game }).game = game;
  await game.start((msg, f) => {
    loadMsg.textContent = msg;
    loadBar.style.width = `${Math.round(f * 100)}%`;
  });
  loading.style.display = 'none';
}

startBtn.addEventListener('click', () => void start());
if (params.has('auto')) void start();
