/**
 * The page's first script: the start screen's styles and its moving backdrop, which run while
 * the game's big bundle (main.ts) is still loading.
 */
import './style.css';
import { parseSeed } from './core/rng';
import { startBackdrop, menuSeedText } from './ui/backdrop/Backdrop';

const host = document.querySelector<HTMLElement>('#menu .menu-bg');
const params = new URLSearchParams(location.search);
// Automatic starts and loads go straight into the city: no backdrop for them.
if (host && !params.has('auto') && !params.get('load')) startBackdrop(host, parseSeed(menuSeedText()));

void import('./main');
