/**
 * Version label and "What's new": the version shows in the main menu and the pause menu;
 * clicking it opens CHANGELOG.md (rendered from a small Markdown subset: headings, bullets,
 * bold) in an overlay. Esc or a click outside closes it.
 */
import changelog from '../../CHANGELOG.md?raw';
import { VERSION } from '../version';
import { esc } from './esc';

let overlay: HTMLDivElement | null = null;

/** A small clickable "v0.001 · What's new" label. */
export function versionLink(): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ver-link';
  b.innerHTML = `v${VERSION} · What's new`;
  b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); showChangelog(); };
  return b;
}

export function showChangelog(): void {
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'changelog';
    overlay.innerHTML = `<div class="cl-panel"><button class="cl-close" title="Close (Esc)">×</button><div class="cl-body">${render(changelog)}</div></div>`;
    overlay.onclick = (e) => { if (e.target === overlay) hide(); };
    overlay.querySelector<HTMLButtonElement>('.cl-close')!.onclick = hide;
    window.addEventListener('keydown', (e) => {
      if (overlay?.classList.contains('open') && e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); hide(); }
    }, true);
    document.body.appendChild(overlay);
  }
  overlay.classList.add('open');
}

function hide(): void {
  overlay?.classList.remove('open');
}

/** Headings, nested bullets, paragraphs and **bold** — all CHANGELOG.md uses. */
function render(md: string): string {
  const out: string[] = [];
  let depth = 0;
  const close = (to: number) => { while (depth > to) { out.push('</ul>'); depth--; } };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const li = /^(\s*)-\s+(.*)$/.exec(line);
    if (h) { close(0); out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); }
    else if (li) {
      const d = Math.floor(li[1].length / 2) + 1;
      while (depth < d) { out.push('<ul>'); depth++; }
      close(d);
      out.push(`<li>${inline(li[2])}</li>`);
    } else if (line.trim()) { close(0); out.push(`<p>${inline(line)}</p>`); }
    else close(0);
  }
  close(0);
  return out.join('');
}
