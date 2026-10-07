/**
 * Character creator (adapted from Norgo's, human-only): a live turntable preview with
 * body / face framing, sliders for build, body shape and face, skin, eyes, hair and a
 * modern city outfit from Scale's wardrobe. Opens as a full-screen dialog over the start
 * menu; Save hands back the look (appearance + outfit JSON) and a thumbnail.
 *
 * The preview (one WebGL context) is created once and reused for every opening; the game
 * start releases it (disposeCreatorPreview).
 */
import type { HumanoidAppearance } from '../humanoid/types';
import { HAIR_STYLES, BEARD_STYLES, BROW_STYLES } from '../humanoid/appearance';
import { HumanoidPreview } from '../humanoid/client/preview';
import {
  randomLook, normalizeLook, outfitVisuals, TOPS, OUTERS, BOTTOMS, SHOES, HATS, PATTERNS,
  type CharacterLook, type OutfitSpec, type RGB,
} from '../avatar/look';

type FaceKey = keyof HumanoidAppearance['face'];
type BodyKey = keyof HumanoidAppearance['body'];
type Tab = 'body' | 'face' | 'hair' | 'skin' | 'outfit';

const FACE: [FaceKey, string][] = [
  ['headRound', 'Head shape'], ['foreheadSlope', 'Forehead'], ['browRidge', 'Brow ridge'], ['eyeSize', 'Eye size'], ['eyeSpacing', 'Eye spacing'],
  ['noseSize', 'Nose size'], ['noseWidth', 'Nose width'], ['noseBridge', 'Nose bridge'], ['cheekbones', 'Cheekbones'], ['jaw', 'Jaw'],
  ['chin', 'Chin'], ['mouthWidth', 'Mouth width'], ['lipFullness', 'Lips'], ['earSize', 'Ears'],
  ['cheekFullness', 'Cheeks (lean – full)'], ['faceWidth', 'Face width'], ['smile', 'Expression (stern – smiling)'],
];
const BODY: [BodyKey, string][] = [
  ['shoulders', 'Shoulders'], ['chest', 'Chest'], ['waist', 'Waist'], ['hips', 'Hips'], ['belly', 'Belly'], ['neck', 'Neck'],
  ['armLength', 'Arm length'], ['legLength', 'Leg length'], ['hands', 'Hands'], ['feet', 'Feet'],
];
/** Fantasy-only options left out for city humans. */
const HAIR = HAIR_STYLES.filter((s) => s !== 'leaves' && s !== 'crest');
const BEARD = BEARD_STYLES;
const BROW = BROW_STYLES.filter((s) => s !== 'scaled');
const MARKS: [string, string][] = [
  ['scar_cheek', 'Cheek scar'], ['scar_brow', 'Brow scar'], ['scar_lip', 'Lip scar'], ['scar_eye', 'Eye scar'], ['scar_chin', 'Chin scar'],
  ['freckle_patch', 'Freckle patch'], ['tattoo_face', 'Face tattoo'],
];
const LABEL: Record<string, string> = {
  tshirt: 'T-shirt', shirt: 'Shirt', sweater: 'Sweater', dress: 'Dress', none: 'None', jacket: 'Jacket', suitjacket: 'Blazer', coat: 'Coat',
  jeans: 'Jeans', trousers: 'Trousers', shorts: 'Shorts', skirt: 'Skirt', sneakers: 'Sneakers', shoes: 'Shoes', boots: 'Boots', cap: 'Cap', beanie: 'Beanie',
  plain: 'Plain', stripes: 'Stripes', checks: 'Checks', mustache: 'Moustache', mutton: 'Mutton chops', chinstrap: 'Chinstrap', unibrow: 'Unibrow',
};

const SKIN = ['#f6dcc8', '#efcdb4', '#eac2a1', '#ddae8a', '#d9a47c', '#c99068', '#bf8560', '#a8734f', '#9c6644', '#865637', '#7a4b2f', '#5a3522', '#4a2c1c', '#3f2519'];
const EYES = ['#3f2410', '#1f120a', '#6b5224', '#47693d', '#4770a8', '#75848f', '#94662a', '#2e4a6e'];
const HAIR_COL = ['#0a0908', '#1c120c', '#341f12', '#5c3f26', '#85663f', '#bc9e6b', '#ddd0b0', '#6b2410', '#9e4c1e', '#8a8a86', '#d8d8d4', '#7a3a6a', '#2a4a7a'];
const FABRIC = [
  '#1f2128', '#33384d', '#4c4c52', '#8a8a8e', '#d9d9d1', '#f2ebd9', '#8c1f1f', '#c0392b', '#e5949b', '#d9a43a', '#b3992e',
  '#265a33', '#5a7a3a', '#33598c', '#4d8cc9', '#4d334d', '#8c6a4d', '#594d40',
];
const DENIM = ['#2e406b', '#1f2947', '#4d618c', '#141419', '#6b7d99', ...FABRIC.slice(0, 6)];
const SHOE_COL = ['#141414', '#40261a', '#e5e5e5', '#664d33', '#262e4d', '#8c1f1f', '#b3a07a'];

const FIRST = ['Alex', 'Sam', 'Robin', 'Jamie', 'Charlie', 'Noa', 'Kim', 'Toni', 'Max', 'Lou', 'Mika', 'Jo', 'Ari', 'Remy', 'Sasha', 'Jules', 'Eli', 'Nico', 'Rio', 'Kai'];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const hex = (c: RGB) => '#' + c.map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('');
const rgb = (s: string): RGB => [parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255];
const title = (s: string) => LABEL[s] ?? s.charAt(0).toUpperCase() + s.slice(1);

/** MakeHuman age parameter ↔ years (0.1875 → 11, 0.5 → 25, 1 → 90). */
const ageYears = (a: number) => Math.round(a < 0.5 ? 11 + ((a - 0.1875) / 0.3125) * 14 : 25 + ((a - 0.5) / 0.5) * 65);
/** Rough standing height (same estimate as the rig's placeholder). */
const heightCm = (a: HumanoidAppearance) => Math.round(172 * a.scale * (0.88 + a.height * 0.24));

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

interface Slider { el: HTMLElement; set(v: number): void }

function slider(label: string, value: number, min: number, max: number, fmt: (v: number) => string, onInput: (v: number) => void): Slider {
  const row = h('label', 'cc-slider');
  const name = h('span', 'cc-sl-name', label);
  const out = h('span', 'cc-sl-val');
  const inp = h('input');
  inp.type = 'range';
  inp.min = String(min);
  inp.max = String(max);
  inp.step = String((max - min) / 400);
  const show = () => { out.textContent = fmt(Number(inp.value)); };
  inp.value = String(value);
  show();
  inp.addEventListener('input', () => { show(); onInput(Number(inp.value)); });
  // Double-click resets a shape slider to neutral.
  if (min < 0) inp.addEventListener('dblclick', () => { inp.value = '0'; show(); onInput(0); });
  row.append(name, out, inp);
  return { el: row, set(v) { inp.value = String(v); show(); } };
}

function chips<T extends string>(options: readonly T[], value: T, onPick: (v: T) => void, name: (v: T) => string = title): HTMLElement {
  const wrap = h('div', 'cc-chips');
  for (const o of options) {
    const b = h('button', 'cc-chip' + (o === value ? ' on' : ''), name(o));
    b.type = 'button';
    b.onclick = () => {
      for (const x of wrap.children) x.classList.toggle('on', x === b);
      onPick(o);
    };
    wrap.appendChild(b);
  }
  return wrap;
}

function swatches(list: string[], value: RGB, onPick: (c: RGB) => void): HTMLElement {
  const cur = hex(value);
  const wrap = h('div', 'cc-swatches');
  const custom = h('input', 'cc-custom');
  custom.type = 'color';
  custom.title = 'Custom colour';
  custom.value = cur;
  const pick = (c: string) => {
    for (const b of wrap.querySelectorAll<HTMLElement>('.cc-swatch')) b.classList.toggle('on', b.dataset.c === c);
    custom.value = c;
    onPick(rgb(c));
  };
  for (const c of list) {
    const b = h('button', 'cc-swatch' + (c === cur ? ' on' : ''));
    b.type = 'button';
    b.dataset.c = c;
    b.style.background = c;
    b.title = c;
    b.onclick = () => pick(c);
    wrap.appendChild(b);
  }
  custom.addEventListener('input', () => pick(custom.value));
  wrap.appendChild(custom);
  return wrap;
}

function section(titleText: string, ...kids: (Node | null)[]): HTMLElement {
  const s = h('section', 'cc-sec');
  s.appendChild(h('div', 'cc-sec-title', titleText));
  for (const k of kids) if (k) s.appendChild(k);
  return s;
}

function field(label: string, control: Node): HTMLElement {
  const d = h('div', 'cc-field');
  d.append(h('div', 'cc-field-label', label), control);
  return d;
}

// ------------------------------------------------------------------ shared preview

let shared: { canvas: HTMLCanvasElement; preview: HumanoidPreview } | null = null;

function sharedPreview(): { canvas: HTMLCanvasElement; preview: HumanoidPreview } {
  if (!shared) {
    const canvas = h('canvas', 'cc-canvas');
    shared = { canvas, preview: new HumanoidPreview(canvas) };
  }
  return shared;
}

/** Release the creator's WebGL context (called when the game starts). */
export function disposeCreatorPreview(): void {
  shared?.preview.dispose();
  shared = null;
}

// ------------------------------------------------------------------ dialog

export interface CreatorResult {
  name: string;
  look: CharacterLook;
  thumb?: string;
}

export interface CreatorOptions {
  /** Edit an existing character (otherwise a random new one). */
  name?: string;
  look?: CharacterLook;
  onSave: (r: CreatorResult) => void | Promise<void>;
  onClose?: () => void;
}

export class CharacterCreator {
  readonly el: HTMLDivElement;
  private look: CharacterLook;
  private initial: CharacterLook;
  private name: HTMLInputElement;
  private tab: Tab = 'body';
  private tabsEl: HTMLElement;
  private editor: HTMLElement;
  private stageMsg: HTMLElement;
  private focusBtns: HTMLElement;
  private yaw = 0.35;
  private pose = 'idle';
  private focus: 'body' | 'face' = 'body';
  private dirty = true;
  private outfitDirty = true;
  /** Measured / estimated height of the last built body (corrects the cm readout). */
  private heightFactor = 1;
  private heightSlider: Slider | null = null;
  private lastPush = 0;
  private raf = 0;
  private closed = false;
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); this.close(); }
  };

  constructor(private opts: CreatorOptions) {
    this.look = structuredClone(opts.look ? normalizeLook(opts.look) : randomLook((Math.random() * 2 ** 32) >>> 0));
    this.initial = structuredClone(this.look);
    this.el = h('div', 'cc');
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Character creator');

    // ---- stage (preview)
    const { canvas } = sharedPreview();
    const stage = h('div', 'cc-stage');
    this.stageMsg = h('div', 'cc-stage-msg', 'Loading the body…');
    this.focusBtns = h('div', 'cc-seg');
    const bar = h('div', 'cc-stage-bar');
    const poseBtns = h('div', 'cc-seg');
    for (const [id, label] of [['idle', 'Stand'], ['walk', 'Walk']] as const) {
      const b = h('button', id === this.pose ? 'on' : '', label);
      b.type = 'button';
      b.onclick = () => {
        this.pose = id;
        sharedPreview().preview.setPose(id);
        for (const x of poseBtns.children) x.classList.toggle('on', x === b);
      };
      poseBtns.appendChild(b);
    }
    const rnd = h('button', 'cc-btn', '🎲 Randomize');
    rnd.type = 'button';
    rnd.title = 'Random body, face, hair and outfit (keeps the sex)';
    rnd.onclick = () => this.randomize();
    bar.append(this.focusBtns, poseBtns, rnd);
    stage.append(h('div', 'cc-halo'), canvas, this.stageMsg, bar, h('div', 'cc-hint', 'Drag to rotate · scroll to zoom to the face'));
    this.bindRotate(canvas);

    // ---- side panel
    const side = h('div', 'cc-side');
    const head = h('div', 'cc-head');
    head.appendChild(h('div', 'cc-title', opts.look ? 'Edit character' : 'Create character'));
    this.name = h('input', 'cc-name');
    this.name.type = 'text';
    this.name.maxLength = 24;
    this.name.spellcheck = false;
    this.name.placeholder = 'Name';
    this.name.value = opts.name ?? FIRST[Math.floor(Math.random() * FIRST.length)];
    this.name.setAttribute('aria-label', 'Character name');
    head.appendChild(this.name);
    this.tabsEl = h('div', 'cc-tabs');
    for (const [id, label] of [['body', 'Body'], ['face', 'Face'], ['hair', 'Hair'], ['skin', 'Skin & eyes'], ['outfit', 'Outfit']] as [Tab, string][]) {
      const b = h('button', id === this.tab ? 'on' : '', label);
      b.type = 'button';
      b.dataset.tab = id;
      b.onclick = () => this.setTab(id);
      this.tabsEl.appendChild(b);
    }
    this.editor = h('div', 'cc-editor');
    const foot = h('div', 'cc-foot');
    const reset = h('button', 'cc-btn ghost', 'Reset');
    reset.type = 'button';
    reset.title = opts.look ? 'Back to the saved version' : 'Back to the first suggestion';
    reset.onclick = () => { this.look = structuredClone(this.initial); this.changed(true); this.renderEditor(); };
    const cancel = h('button', 'cc-btn ghost', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = () => this.close();
    const save = h('button', 'cc-btn primary', 'Save character');
    save.type = 'button';
    save.onclick = () => void this.save(save);
    // Attribution the body's licence asks for (CC BY 3.0, see public/assets/human/LICENSE.txt).
    const credit = h('div', 'cc-credit', 'Body based on "Woman_model" by Bananaboy (Blend Swap), CC BY 3.0');
    foot.append(reset, credit, h('div', 'cc-spacer'), cancel, save);
    side.append(head, this.tabsEl, this.editor, foot);

    this.el.append(stage, side);
    document.body.appendChild(this.el);
    window.addEventListener('keydown', this.onKey);
    this.renderFocus();
    this.renderEditor();
    void this.initPreview();
  }

  // ---------------------------------------------------------------- preview

  private async initPreview(): Promise<void> {
    const { preview } = sharedPreview();
    try {
      await preview.ready();
    } catch (e) {
      console.warn('[creator] preview unavailable', e);
      this.stageMsg.textContent = '3D preview unavailable';
      return;
    }
    if (this.closed) return;
    preview.setFocus(this.focus);
    preview.setPose(this.pose);
    preview.setYaw(this.yaw);
    preview.start();
    const tick = () => {
      if (this.closed) return;
      this.raf = requestAnimationFrame(tick);
      const now = performance.now();
      // Body rebuilds run in a worker; while a slider is dragged, send at most ~8 per second.
      if (this.dirty && now - this.lastPush > 120) {
        this.dirty = false;
        this.lastPush = now;
        preview.setAppearance(structuredClone(this.look.appearance));
      }
      if (this.outfitDirty) {
        this.outfitDirty = false;
        preview.setEquipment(outfitVisuals(this.look.outfit));
      }
      const built = preview.built;
      const body = preview.body;
      if (body) {
        const f = (body.height * 100) / heightCm(body.app);
        if (Math.abs(f - this.heightFactor) > 1e-3) {
          this.heightFactor = f;
          this.heightSlider?.set(this.look.appearance.height);
        }
      }
      if (built) this.stageMsg.textContent = 'Updating…';
      this.stageMsg.classList.toggle('hide', built);
    };
    tick();
  }

  private bindRotate(canvas: HTMLCanvasElement): void {
    let drag = false, lastX = 0;
    canvas.onpointerdown = (e) => { drag = true; lastX = e.clientX; canvas.setPointerCapture(e.pointerId); };
    canvas.onpointermove = (e) => {
      if (!drag) return;
      this.yaw += (e.clientX - lastX) * 0.012;
      lastX = e.clientX;
      sharedPreview().preview.setYaw(this.yaw);
    };
    canvas.onpointerup = () => { drag = false; };
    canvas.onwheel = (e) => { e.preventDefault(); this.setFocus(e.deltaY < 0 ? 'face' : 'body'); };
  }

  private setFocus(f: 'body' | 'face'): void {
    if (f === this.focus) return;
    this.focus = f;
    sharedPreview().preview.setFocus(f);
    this.renderFocus();
  }

  private renderFocus(): void {
    this.focusBtns.replaceChildren();
    for (const [id, label] of [['body', 'Body'], ['face', 'Face']] as const) {
      const b = h('button', id === this.focus ? 'on' : '', label);
      b.type = 'button';
      b.onclick = () => this.setFocus(id);
      this.focusBtns.appendChild(b);
    }
  }

  // ---------------------------------------------------------------- editing

  private changed(outfit = false): void {
    this.dirty = true;
    if (outfit) this.outfitDirty = true;
  }

  private setA<K extends keyof HumanoidAppearance>(k: K, v: HumanoidAppearance[K]): void {
    this.look.appearance[k] = v;
    this.changed();
  }

  private setO<K extends keyof OutfitSpec>(k: K, v: OutfitSpec[K], rerender = false): void {
    this.look.outfit[k] = v;
    this.outfitDirty = true;
    if (rerender) this.renderEditor();
  }

  private randomize(): void {
    const g = this.look.appearance.gender;
    this.look = randomLook((Math.random() * 2 ** 32) >>> 0, g);
    this.changed(true);
    this.renderEditor();
  }

  private setTab(t: Tab): void {
    this.tab = t;
    for (const b of this.tabsEl.children) b.classList.toggle('on', (b as HTMLElement).dataset.tab === t);
    this.renderEditor();
    this.setFocus(t === 'face' || t === 'hair' || t === 'skin' ? 'face' : 'body');
    this.editor.scrollTop = 0;
  }

  private renderEditor(): void {
    const a = this.look.appearance, o = this.look.outfit;
    const pct = (v: number) => `${Math.round(v * 100)}`;
    const signed = (v: number) => (v > 0.005 ? '+' : '') + Math.round(v * 100);
    let kids: HTMLElement[] = [];
    this.heightSlider = null;
    switch (this.tab) {
      case 'body': {
        const genderS = slider('Feminine ↔ Masculine', a.gender, 0, 1, pct, (v) => { this.setA('gender', v); sync(); });
        const sexChips = h('div', 'cc-chips');
        const sync = () => { for (const b of sexChips.children) b.classList.toggle('on', (b as HTMLElement).dataset.m === (this.look.appearance.gender > 0.5 ? 'm' : 'f')); };
        for (const [m, label] of [['f', 'Female'], ['m', 'Male']] as const) {
          const b = h('button', 'cc-chip', label);
          b.type = 'button';
          b.dataset.m = m;
          b.onclick = () => {
            const ap = this.look.appearance;
            const want = m === 'm' ? 0.92 : 0.06;
            if ((ap.gender > 0.5) !== (m === 'm')) {
              ap.gender = want;
              // Sensible defaults when switching: no beard on a woman, shorter hair for a man.
              if (m === 'f') ap.beardStyle = 'none';
              genderS.set(want);
              this.changed();
            }
            sync();
          };
          sexChips.appendChild(b);
        }
        sync();
        const heightS = slider('Height', a.height, 0, 1, () => `${Math.round(heightCm(this.look.appearance) * this.heightFactor)} cm`, (v) => this.setA('height', v));
        this.heightSlider = heightS;
        kids = [
          section('Build',
            field('Body', sexChips), genderS.el,
            slider('Age', clamp01(a.age), 0.35, 0.95, (v) => `${ageYears(v)} years`, (v) => this.setA('age', v)).el,
            heightS.el,
            slider('Weight', a.weight, 0, 1, pct, (v) => this.setA('weight', v)).el,
            slider('Muscle', a.muscle, 0, 1, pct, (v) => this.setA('muscle', v)).el,
            slider('Proportions', a.proportions, 0, 1, pct, (v) => this.setA('proportions', v)).el,
          ),
          section('Shape', ...BODY.map(([k, label]) => slider(label, a.body[k], -1, 1, signed, (v) => { this.look.appearance.body[k] = v; this.changed(); }).el)),
          section('Ancestry', ...this.ancestry()),
          h('p', 'cc-note', 'Height is how you look next to the people in the city. Growing and shrinking (+ / −) still works from there.'),
        ];
        break;
      }
      case 'face':
        kids = [
          section('Features', ...FACE.map(([k, label]) => slider(label, a.face[k] ?? 0, -1, 1, signed, (v) => { this.look.appearance.face[k] = v; this.changed(); }).el)),
          h('p', 'cc-note', 'Double-click a slider to reset it to average.'),
        ];
        break;
      case 'hair':
        kids = [
          section('Hair', field('Style', chips(withCur(HAIR, a.hairStyle), a.hairStyle, (v) => this.setA('hairStyle', v))), field('Colour', swatches(HAIR_COL, a.hairColor, (c) => this.setA('hairColor', c)))),
          section('Facial hair', field('Beard', chips(withCur(BEARD, a.beardStyle), a.beardStyle, (v) => this.setA('beardStyle', v))), field('Eyebrows', chips(withCur(BROW, a.browStyle), a.browStyle, (v) => this.setA('browStyle', v)))),
        ];
        break;
      case 'skin': {
        const freckles = a.skinPattern === 'freckles' ? a.patternStrength : 0;
        kids = [
          section('Skin', field('Tone', swatches(SKIN, a.skinTone, (c) => {
            const ap = this.look.appearance;
            ap.skinTone = c;
            ap.skinAccent = [c[0] * 0.55, c[1] * 0.45, c[2] * 0.4];
            this.changed();
          })),
          slider('Freckles', freckles, 0, 1, pct, (v) => {
            const ap = this.look.appearance;
            ap.skinPattern = v > 0.02 ? 'freckles' : 'none';
            ap.patternStrength = v;
            this.changed();
          }).el,
          field('Marks', this.marks())),
          section('Eyes', field('Colour', swatches(EYES, a.eyeColor, (c) => this.setA('eyeColor', c)))),
        ];
        break;
      }
      case 'outfit':
        kids = [
          section('Top',
            chips(TOPS, o.top, (v) => this.setO('top', v, true)),
            o.top === 'none' ? null : field('Colour', swatches(FABRIC, o.topColor, (c) => this.setO('topColor', c))),
            o.top === 'none' ? null : field('Pattern', chips(PATTERNS, (PATTERNS as readonly string[]).includes(o.topPattern) ? o.topPattern as (typeof PATTERNS)[number] : 'plain', (v) => this.setO('topPattern', v))),
            o.top === 'none' ? null : field('Trim / pattern colour', swatches(FABRIC, o.topColor2, (c) => this.setO('topColor2', c))),
          ),
          section('Outer layer',
            chips(OUTERS, o.outer, (v) => this.setO('outer', v, true)),
            o.outer !== 'none' ? field('Colour', swatches(FABRIC, o.outerColor, (c) => this.setO('outerColor', c))) : null,
            o.outer === 'jacket' ? field('Material', chips(['cloth', 'leather'] as const, o.outerLeather ? 'leather' : 'cloth', (v) => this.setO('outerLeather', v === 'leather'))) : null,
          ),
          o.top === 'dress' ? section('Bottom', h('p', 'cc-note', 'The dress replaces trousers or skirt.')) : section('Bottom',
            chips(BOTTOMS, o.bottom, (v) => this.setO('bottom', v, true)),
            o.bottom === 'none' ? null : field('Colour', swatches(o.bottom === 'jeans' ? DENIM : FABRIC, o.bottomColor, (c) => this.setO('bottomColor', c))),
          ),
          section('Shoes', chips(SHOES, o.shoes, (v) => this.setO('shoes', v, true)), o.shoes === 'none' ? null : field('Colour', swatches(SHOE_COL, o.shoesColor, (c) => this.setO('shoesColor', c)))),
          section('Underwear', h('p', 'cc-note', 'Worn wherever nothing else covers'),
            chips(['shown', 'removed'] as const, o.underwear === false ? 'removed' : 'shown', (v) => this.setO('underwear', v === 'shown', true))),
          section('Hat',
            chips(HATS, o.hat, (v) => this.setO('hat', v, true)),
            o.hat !== 'none' ? field('Colour', swatches(FABRIC, o.hatColor, (c) => this.setO('hatColor', c))) : null,
          ),
          section('Cut', h('p', 'cc-note', 'Skirt and dress length, sleeves'), (() => {
            const b = h('button', 'cc-btn small', 'Vary the cut');
            b.type = 'button';
            b.onclick = () => this.setO('seed', (this.look.outfit.seed + 1) >>> 0);
            return b;
          })()),
        ];
        break;
    }
    this.editor.replaceChildren(...kids);
  }

  /** Three ancestry weights kept summing to 1 (MakeHuman's ethnic base shapes). */
  private ancestry(): HTMLElement[] {
    const keys: ['african' | 'asian' | 'caucasian', string][] = [['african', 'African'], ['asian', 'Asian'], ['caucasian', 'European']];
    const els: Slider[] = [];
    keys.forEach(([k, label]) => {
      els.push(slider(label, this.look.appearance[k], 0, 1, (v) => `${Math.round(v * 100)}%`, (v) => {
        const a = this.look.appearance;
        const others = keys.map((x) => x[0]).filter((x) => x !== k);
        const rest = others.reduce((s, x) => s + a[x], 0);
        a[k] = v;
        for (const x of others) a[x] = rest > 1e-4 ? (a[x] / rest) * (1 - v) : (1 - v) / 2;
        keys.forEach(([kk], i) => { if (kk !== k) els[i].set(a[kk]); });
        this.changed();
      }));
    });
    return els.map((s) => s.el);
  }

  private marks(): HTMLElement {
    const wrap = h('div', 'cc-chips');
    for (const [id, label] of MARKS) {
      const b = h('button', 'cc-chip' + (this.look.appearance.marks.includes(id) ? ' on' : ''), label);
      b.type = 'button';
      b.onclick = () => {
        const m = this.look.appearance.marks;
        const i = m.indexOf(id);
        if (i >= 0) m.splice(i, 1);
        else m.push(id);
        b.classList.toggle('on', i < 0);
        this.changed();
      };
      wrap.appendChild(b);
    }
    return wrap;
  }

  // ---------------------------------------------------------------- save / close

  private async save(btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    btn.textContent = 'Saving…';
    const { preview } = sharedPreview();
    // Make sure the preview shows the final look before the thumbnail is taken.
    if (this.dirty || this.outfitDirty) {
      this.dirty = false;
      this.outfitDirty = false;
      preview.setAppearance(structuredClone(this.look.appearance));
      preview.setEquipment(outfitVisuals(this.look.outfit));
    }
    await waitFor(() => preview.built, 4000);
    await new Promise((r) => setTimeout(r, 350));
    const thumb = preview.thumbnail();
    const name = this.name.value.trim() || 'Me';
    try {
      await this.opts.onSave({ name, look: structuredClone(this.look), thumb });
      this.close();
    } catch (e) {
      console.error(e);
      btn.disabled = false;
      btn.textContent = 'Save character';
      alert(`Could not save: ${(e as Error).message}`);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
    shared?.preview.stop();
    this.el.remove();
    this.opts.onClose?.();
  }
}

function withCur(list: readonly string[], cur: string): string[] {
  return cur && !list.includes(cur) ? [cur, ...list] : [...list];
}

async function waitFor(cond: () => boolean, ms: number): Promise<void> {
  const t0 = performance.now();
  while (!cond() && performance.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
}

