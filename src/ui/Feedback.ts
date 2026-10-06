/**
 * Feedback: a "Feedback" link next to the version label (main menu and pause menu) opens a
 * small form. Sending it opens the player's own mail program with a ready-made message
 * (mailto:), since the game is a static site with no server of its own.
 *
 * The recipient never appears as text: not in the page, not in the source, not in the
 * bundle. It is kept as XOR-scrambled bytes and only put together in memory at the moment
 * Send is clicked, then handed straight to the mailto: link, so address harvesters that
 * scan pages or scripts find nothing.
 */
import { VERSION } from '../version';

/** The scrambled recipient (byte i XOR key i; the key steps k → 31·k + 7 mod 256 from 0x5c). */
const TO = [47, 72, 93, 39, 121, 43, 154, 254, 168, 222, 206, 174, 241, 138, 27, 98, 63, 5, 88, 46];

function recipient(): string {
  let k = 0x5c, s = '';
  for (const b of TO) { s += String.fromCharCode(b ^ k); k = (k * 31 + 7) & 255; }
  return s;
}

const KINDS = ['Bug', 'Idea', 'Praise', 'Other'] as const;

let overlay: HTMLDivElement | null = null;

/** A small clickable "Feedback" label, styled like the version link. */
export function feedbackLink(): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ver-link fb-link';
  b.textContent = 'Feedback';
  b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); showFeedback(); };
  return b;
}

export function showFeedback(): void {
  if (!overlay) build();
  overlay!.classList.add('open');
  overlay!.querySelector<HTMLElement>('.fb-status')!.textContent = '';
  if (document.pointerLockElement) document.exitPointerLock();
  setTimeout(() => overlay?.querySelector<HTMLTextAreaElement>('.fb-text')?.focus(), 0);
}

function hide(): void {
  overlay?.classList.remove('open');
}

function build(): void {
  const o = document.createElement('div');
  o.id = 'feedback';
  o.innerHTML = `<div class="fb-panel">
      <button type="button" class="fb-close" title="Close (Esc)">×</button>
      <h2>Feedback</h2>
      <p class="fb-sub">Found a bug, have an idea, or just want to say something? Write it here. Send opens your mail program with the message ready to go.</p>
      <div class="fb-kinds">${KINDS.map((k, i) => `<label><input type="radio" name="fbKind" value="${k}"${i === 0 ? ' checked' : ''}> ${k}</label>`).join('')}</div>
      <textarea class="fb-text" rows="8" maxlength="1500" placeholder="What happened, or what would you like to see?"></textarea>
      <label class="fb-info"><input type="checkbox" class="fb-env" checked> Add game version, city seed and browser (helps with bugs)</label>
      <div class="fb-buttons"><button type="button" class="fb-send">Send…</button><button type="button" class="fb-copy">Copy text</button></div>
      <p class="fb-status"></p>
    </div>`;
  // Typing in the form must not drive the game (WASD, M, H, E …); Esc closes it.
  o.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.code === 'Escape') { e.preventDefault(); hide(); }
  });
  o.addEventListener('keyup', (e) => e.stopPropagation());
  o.onclick = (e) => { if (e.target === o) hide(); };
  o.querySelector<HTMLButtonElement>('.fb-close')!.onclick = hide;
  const text = o.querySelector<HTMLTextAreaElement>('.fb-text')!;
  const status = o.querySelector<HTMLElement>('.fb-status')!;
  const kind = () => o.querySelector<HTMLInputElement>('input[name="fbKind"]:checked')?.value ?? 'Other';
  const body = () => {
    let s = text.value.trim();
    if (o.querySelector<HTMLInputElement>('.fb-env')!.checked) s += `\n\n--\n${environment()}`;
    return s;
  };
  o.querySelector<HTMLButtonElement>('.fb-send')!.onclick = () => {
    if (!text.value.trim()) { status.textContent = 'Please write something first.'; text.focus(); return; }
    const subject = `Scale feedback (${kind()}) v${VERSION}`;
    const url = `mailto:${recipient()}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body())}`;
    // A throwaway link, clicked and dropped at once: the address never stays in the page.
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    status.textContent = 'Your mail program should open with the message. Thank you! If nothing opened, there is no mail program set up on this device.';
  };
  o.querySelector<HTMLButtonElement>('.fb-copy')!.onclick = () => {
    void navigator.clipboard?.writeText(`${kind()}: ${body()}`)
      .then(() => { status.textContent = 'Copied.'; })
      .catch(() => { status.textContent = 'Copying is not allowed here.'; });
  };
  document.body.appendChild(o);
  overlay = o;
}

/** Version, city seed/size (from the address bar) and browser, for bug reports. */
function environment(): string {
  const p = new URLSearchParams(location.search);
  const city = p.get('seed') ? `seed ${p.get('seed')}${p.get('size') ? `, size ${p.get('size')}` : ''}` : 'no city loaded';
  return `Scale v${VERSION} · ${city}\n${navigator.userAgent}`;
}
