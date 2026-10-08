/**
 * Reassignable keys (the Keys tab of the help dialog).
 *
 * The game code keeps checking each action's default key code (its "game code", e.g. 'KeyW' for
 * walking forward). Input translates the key the player actually pressed into that game code:
 *  - a key bound to an action becomes the action's game code;
 *  - a default key that was moved away from its action is swallowed (it no longer does that);
 *  - every other key passes through unchanged (Esc, F4, keys only dialogs use …).
 * Synthetic key events (the touch controls send them) already carry game codes and are not
 * translated, so the iPad controls work whatever the keyboard bindings are.
 *
 * Bindings are kept in localStorage per browser; "Reset to defaults" restores the defaults.
 */

export type KeyGroup = 'move' | 'powers' | 'act' | 'view';
export const KEY_GROUPS: { id: KeyGroup; name: string }[] = [
  { id: 'move', name: 'Moving' },
  { id: 'powers', name: 'Powers' },
  { id: 'act', name: 'Doing things' },
  { id: 'view', name: 'Screens and view' },
];

export interface KeyAction {
  id: string;
  group: KeyGroup;
  label: string;
  /** Longer explanation (tooltip / second line). */
  info?: string;
  /** Default keys (up to two). The first is the game code the game checks. */
  defaults: string[];
}

const slot = (n: number): KeyAction => ({
  id: `slot${n}`, group: 'powers', label: `Hotbar slot ${n}`,
  info: n === 1 ? 'Use the power in this slot (and select it); hold for beams, jets, ice path; super speed switches on / off' : undefined,
  defaults: [`Digit${n % 10}`, `Numpad${n % 10}`],
});

export const KEY_ACTIONS: KeyAction[] = [
  { id: 'fwd', group: 'move', label: 'Forward', info: 'Walk (in flight: fly)', defaults: ['KeyW'] },
  { id: 'back', group: 'move', label: 'Back', defaults: ['KeyS'] },
  { id: 'left', group: 'move', label: 'Left', defaults: ['KeyA'] },
  { id: 'right', group: 'move', label: 'Right', defaults: ['KeyD'] },
  { id: 'run', group: 'move', label: 'Run / boost', defaults: ['ShiftLeft', 'ShiftRight'] },
  { id: 'slow', group: 'move', label: 'Walk slowly', info: 'Hold to stroll', defaults: ['AltLeft'] },
  { id: 'auto', group: 'move', label: 'Autorun', info: 'In flight: autoflight · Forward or Back stops it', defaults: ['KeyR'] },
  { id: 'jump', group: 'move', label: 'Jump / up', info: 'With super jump: hold to keep climbing · in flight: up', defaults: ['Space'] },
  { id: 'down', group: 'move', label: 'Down (in flight)', defaults: ['ControlLeft', 'KeyC'] },
  { id: 'fly', group: 'move', label: 'Flight on / off', info: 'Once Flight is unlocked', defaults: ['KeyF'] },
  { id: 'grow', group: 'move', label: 'Grow', info: 'Size shift; the range grows with its rank', defaults: ['NumpadAdd', 'Equal'] },
  { id: 'shrink', group: 'move', label: 'Shrink', defaults: ['NumpadSubtract', 'Minus'] },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(slot),
  { id: 'powers', group: 'powers', label: 'Powers screen', info: 'Buy, upgrade, assign to the hotbar', defaults: ['KeyP'] },
  { id: 'target', group: 'act', label: 'Target', info: 'Pick a target near the crosshair; again: cycle (with Shift: back). On a giant creature: its body parts, weak spots first. Esc clears it', defaults: ['Tab'] },
  { id: 'use', group: 'act', label: 'Use / talk', info: 'Talk to someone · help someone up · pick up / give back · turn yourself in next to an officer · fitting mirror · open a manhole · hold to dig someone out · carry the injured to the triage tent', defaults: ['KeyE'] },
  { id: 'rally', group: 'act', label: 'Rally soldiers', info: 'The soldiers near you follow you (reputation 40+ with the army)', defaults: ['KeyG'] },
  { id: 'strike', group: 'act', label: 'Airstrike', info: 'On your target, a giant creature (reputation 70+)', defaults: ['KeyT'] },
  { id: 'sidekick', group: 'act', label: 'Call your sidekick', info: 'Once you have given someone the second shard', defaults: ['KeyK'] },
  ...[1, 2, 3].map((n): KeyAction => ({
    id: `costume${n}`, group: 'act', label: `Costume ${n}`,
    info: n === 1 ? 'Put on this costume. All three start the same; the fitting mirror changes the one you wear' : undefined,
    defaults: [`F${n}`],
  })),
  { id: 'blast', group: 'act', label: 'Test blast', info: 'Sandbox only', defaults: ['KeyB'] },
  { id: 'map', group: 'view', label: 'City map', info: 'Click to set a marker the compass points to', defaults: ['KeyM'] },
  { id: 'minimap', group: 'view', label: 'Minimap on / off', defaults: ['KeyN'] },
  { id: 'hourDown', group: 'view', label: 'Time of day −1 h', defaults: ['BracketLeft'] },
  { id: 'hourUp', group: 'view', label: 'Time of day +1 h', defaults: ['BracketRight'] },
  { id: 'freeCam', group: 'view', label: 'Free camera', defaults: ['F8'] },
  { id: 'help', group: 'view', label: 'Help', info: 'This dialog', defaults: ['KeyH'] },
];

export const KEY_ACTION: Record<string, KeyAction> = Object.fromEntries(KEY_ACTIONS.map((a) => [a.id, a]));

/** Keys that cannot be bound (they keep their fixed meaning). */
const RESERVED = new Set(['Escape', 'F4', 'F5', 'F11', 'F12', 'MetaLeft', 'MetaRight', 'ContextMenu']);

const STORE = 'scale.keys.v1';

type Bindings = Record<string, (string | null)[]>;

let bindings: Bindings = load();
/** Physical code -> game code (null: swallowed). Rebuilt on every change. */
let route = new Map<string, string | null>();
let version = 0;
const listeners: (() => void)[] = [];

function defaults(): Bindings {
  return Object.fromEntries(KEY_ACTIONS.map((a) => [a.id, [a.defaults[0] ?? null, a.defaults[1] ?? null]]));
}

function load(): Bindings {
  const b = defaults();
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const saved = JSON.parse(raw) as Bindings;
      for (const id of Object.keys(b)) {
        const s = saved[id];
        if (Array.isArray(s)) b[id] = [typeof s[0] === 'string' ? s[0] : null, typeof s[1] === 'string' ? s[1] : null];
      }
    }
  } catch { /* storage blocked or broken: defaults */ }
  return b;
}

function save(): void {
  try {
    const def = defaults();
    const changed = KEY_ACTIONS.some((a) => bindings[a.id].join() !== def[a.id].join());
    if (changed) localStorage.setItem(STORE, JSON.stringify(bindings));
    else localStorage.removeItem(STORE);
  } catch { /* not kept: fine for this session */ }
}

function rebuild(): void {
  route = new Map();
  // Default keys of the actions are game codes: unless bound somewhere, they now do nothing.
  for (const a of KEY_ACTIONS) for (const c of a.defaults) route.set(c, null);
  for (const a of KEY_ACTIONS) for (const c of bindings[a.id]) if (c) route.set(c, a.defaults[0]);
  version++;
  for (const l of listeners) l();
}
rebuild();

/** The game code for a pressed physical key ('' when it is swallowed). */
export function gameCodeOf(code: string): string {
  const r = route.get(code);
  return r === undefined ? code : r ?? '';
}

/** The game code of a keyboard event: real key presses are translated, synthetic ones (touch
 *  controls) already carry game codes. */
export function gameCode(e: KeyboardEvent): string {
  return e.isTrusted ? gameCodeOf(e.code) : e.code;
}

/** Is this key event the given action? */
export function isAction(e: KeyboardEvent, id: string): boolean {
  const g = gameCode(e);
  return g !== '' && g === KEY_ACTION[id].defaults[0];
}

export function bindingOf(id: string): (string | null)[] { return bindings[id]; }

/** Bind a key to an action's slot (0: main, 1: second). The key is taken away from any other
 *  action that had it; returns that action's label (for a notice), or null. */
export function bind(id: string, i: number, code: string | null): string | null {
  let took: string | null = null;
  if (code) {
    for (const a of KEY_ACTIONS) {
      const b = bindings[a.id];
      for (let j = 0; j < b.length; j++) {
        if (b[j] === code && !(a.id === id && j === i)) { b[j] = null; if (a.id !== id) took = a.label; }
      }
    }
  }
  bindings[id][i] = code;
  // Keep the main key filled when there is a second one.
  if (!bindings[id][0] && bindings[id][1]) { bindings[id][0] = bindings[id][1]; bindings[id][1] = null; }
  save();
  rebuild();
  return took;
}

export function resetKeys(): void {
  bindings = defaults();
  save();
  rebuild();
}

export function isDefaultBinding(): boolean {
  const def = defaults();
  return KEY_ACTIONS.every((a) => bindings[a.id].join() === def[a.id].join());
}

export function canBind(code: string): boolean { return !RESERVED.has(code); }

/** Bumps on every change (for UI that caches labels). */
export function keysVersion(): number { return version; }
export function onKeysChange(f: () => void): void { listeners.push(f); }

const NAMES: Record<string, string> = {
  Space: 'Space', ShiftLeft: 'Shift', ShiftRight: 'Right Shift', ControlLeft: 'Ctrl', ControlRight: 'Right Ctrl',
  AltLeft: 'Alt', AltRight: 'Alt Gr', Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace', CapsLock: 'Caps Lock',
  Equal: '=', Minus: '−', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Backquote: '`',
  Backslash: '\\', IntlBackslash: '<', Comma: ',', Period: '.', Slash: '/',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  NumpadAdd: 'Num +', NumpadSubtract: 'Num −', NumpadMultiply: 'Num *', NumpadDivide: 'Num /',
  NumpadEnter: 'Num Enter', NumpadDecimal: 'Num ,', Insert: 'Ins', Delete: 'Del', PageUp: 'Page Up', PageDown: 'Page Down',
};

/** Display name of a key code. */
export function keyName(code: string | null): string {
  if (!code) return '—';
  if (NAMES[code]) return NAMES[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1];
  m = /^Numpad(\d)$/.exec(code);
  if (m) return `Num ${m[1]}`;
  return code;
}

/** Short label of an action's main key (e.g. for the hotbar), '' when unbound. */
export function keyLabel(id: string): string {
  const c = bindings[id]?.[0] ?? null;
  return c ? keyName(c) : '';
}

/** A power's own key (besides the hotbar), as currently bound; undefined: none. */
export function powerKeyText(id: string): string | undefined {
  if (id === 'superJump') return `Hold ${keyLabel('jump') || '—'}`;
  if (id === 'flight') return keyLabel('fly') || '—';
  if (id === 'size') return `${keyLabel('grow') || '—'} / ${keyLabel('shrink') || '—'}`;
  return undefined;
}
