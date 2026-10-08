/**
 * The talk panel (game/people, NPC_PERSONALITY_PLAN §1): who you are talking to (name, job, age,
 * temperament, mood, whether you met before and how they feel about you), what they just said,
 * and what you can say: keys 1–9 or a click. "Show me the way" lists places (the nearest metro
 * station and landmarks); Esc or E closes. While open it takes the number keys (no powers go
 * off) and Esc; walking keys still move the hero.
 */
import type { Topic } from '../game/people/lines';
import type { Destination } from '../game/people/People';
import { isAction } from '../game/keybinds';

export interface TalkUiHooks {
  choose(topic: Topic): void;
  way(d: Destination): void;
  close(): void;
  destinations(): Destination[];
  /** More things to say while they apply (offering the shard …), after the usual topics. */
  extras(): { label: string; run: () => void }[];
}

const TOPICS: { topic: Topic; label: string }[] = [
  { topic: 'hello', label: 'Hello!' },
  { topic: 'mood', label: 'How are you?' },
  { topic: 'job', label: 'What do you do?' },
  { topic: 'news', label: 'What\'s going on around here?' },
  { topic: 'way', label: 'Can you show me the way to …' },
  { topic: 'favour', label: 'Can I do anything for you?' },
  { topic: 'me', label: 'What do you think of me?' },
  { topic: 'bye', label: 'Goodbye.' },
];

export class TalkUi {
  open = false;
  private root: HTMLDivElement;
  private nm: HTMLDivElement;
  private sub: HTMLDivElement;
  private known: HTMLDivElement;
  private said: HTMLDivElement;
  private opts: HTMLDivElement;
  private actions: (() => void)[] = [];
  private closedAt = -1e9;

  /** Open, or just closed (Esc that closed the talk does not open the pause menu). */
  get holdsPointer(): boolean { return this.open || performance.now() - this.closedAt < 400; }

  constructor(private hooks: TalkUiHooks) {
    this.root = document.createElement('div');
    this.root.id = 'talk';
    this.root.innerHTML = `
      <div class="tk-head"><div class="tk-nm"></div><button class="tk-x" title="Close (Esc / E)">×</button></div>
      <div class="tk-sub"></div>
      <div class="tk-known"></div>
      <div class="tk-said"></div>
      <div class="tk-opts"></div>`;
    document.body.appendChild(this.root);
    const q = <T extends Element>(s: string) => this.root.querySelector(s) as T;
    this.nm = q('.tk-nm');
    this.sub = q('.tk-sub');
    this.known = q('.tk-known');
    this.said = q('.tk-said');
    this.opts = q('.tk-opts');
    q<HTMLButtonElement>('.tk-x').onclick = () => this.hooks.close();
    // Clicks on the panel are not clicks in the game (targeting, punches).
    for (const ev of ['pointerdown', 'mousedown', 'wheel', 'contextmenu'] as const) this.root.addEventListener(ev, (e) => e.stopPropagation());
    window.addEventListener('keydown', (e) => {
      if (!this.open) return;
      if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
      if (e.code === 'Escape' || isAction(e, 'use')) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (!e.repeat) this.hooks.close();
        return;
      }
      const m = /^(Digit|Numpad)([0-9])$/.exec(e.code);
      if (!m) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.repeat) return;
      const i = (Number(m[2]) + 9) % 10;
      this.actions[i]?.();
    }, true);
  }

  showOpen(head: { name: string; sub: string; known: string }, line: string): void {
    this.nm.textContent = head.name;
    this.sub.textContent = head.sub;
    this.known.textContent = head.known;
    this.line(line);
    this.showTopics();
    this.root.classList.remove('closing');
    this.root.classList.add('open');
    this.open = true;
  }

  line(text: string): void {
    this.said.textContent = `“${text}”`;
    this.said.classList.remove('new');
    void this.said.offsetWidth;
    this.said.classList.add('new');
  }

  /** After a goodbye: the options fade while they say it. */
  closing(): void {
    this.root.classList.add('closing');
    this.setOptions([]);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.closedAt = performance.now();
    this.root.classList.remove('open', 'closing');
  }

  showTopics(): void {
    // The extras (offering the shard) first: they are why you came.
    this.setOptions([...this.hooks.extras(), ...TOPICS.map((t) => ({ label: t.label, run: () => this.hooks.choose(t.topic) }))]);
  }

  /** Options of another system's (the sidekick's: amounts, wishes); "Never mind." goes back to the topics. */
  choices(list: { label: string; run: () => void }[]): void {
    this.setOptions([...list, { label: 'Never mind.', run: () => this.showTopics() }]);
  }

  /** No options for now (a scene plays out in the panel). */
  clearOptions(): void {
    this.setOptions([]);
  }

  showDestinations(): void {
    const ds = this.hooks.destinations();
    this.setOptions([
      ...ds.map((d) => ({ label: `… ${d.label}`, run: () => this.hooks.way(d) })),
      { label: 'Never mind.', run: () => this.showTopics() },
    ]);
  }

  private setOptions(list: { label: string; run: () => void }[]): void {
    this.opts.innerHTML = '';
    this.actions = list.map((o) => o.run);
    list.forEach((o, i) => {
      const b = document.createElement('button');
      b.innerHTML = `<span>${(i + 1) % 10}</span>`;
      b.append(o.label);
      b.onclick = () => o.run();
      this.opts.appendChild(b);
    });
  }
}
