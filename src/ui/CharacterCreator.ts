/**
 * Character creator: the Actors character generator (github.com/ArndRosemeier/Actors) in a
 * full-screen dialog over the start menu or the clothes shop mirror. Its studio stage shows the
 * character (drag to orbit, scroll to zoom), its editor sets race, body, face, skin, hair and the
 * outfit from MakeHuman's wardrobe; Save hands back the look (the Actors configuration) and a
 * thumbnail.
 *
 * The stage (one WebGL context) and its character are made once and reused for every opening;
 * the game start releases them (disposeCreatorPreview).
 */
import { Character, CharacterEditor, CharacterStage, seededRandom, type CharacterPatch } from '@actors/generator';
import { holdBackdrop } from './backdrop/Backdrop';
import { normalizeLook, type CharacterLook } from '../avatar/look';
import { cc0Catalog, humanWorker, packUrl } from '../humanoid/actors/service';
import { WEBGPU, WEBGPU_FORCE_GL } from '../render/gpuMode';

const FIRST = ['Alex', 'Sam', 'Robin', 'Jamie', 'Charlie', 'Noa', 'Kim', 'Toni', 'Max', 'Lou', 'Mika', 'Jo', 'Ari', 'Remy', 'Sasha', 'Jules', 'Eli', 'Nico', 'Rio', 'Kai'];

/** Settings the game decides (it animates the hero; no anatomy in the city). */
const GAME_ONLY: CharacterPatch = { anatomy: false, blink: true, expression: 'neutral' };

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

// ------------------------------------------------------------------ shared stage

interface Studio {
  host: HTMLDivElement;
  stage: CharacterStage;
  character: Character;
}

let studio: Promise<Studio> | null = null;

function sharedStudio(): Promise<Studio> {
  return (studio ??= (async () => {
    const host = h('div', 'cc-canvas');
    // (Parked, hidden, until a dialog takes it: the stage sizes itself to its container.)
    host.style.cssText = 'position:absolute;inset:0;display:none';
    document.body.appendChild(host);
    const stage = await CharacterStage.create(host, { renderer: WEBGPU ? (WEBGPU_FORCE_GL ? 'webgpu-gl' : 'webgpu') : 'webgl', background: 0x10161d });
    // The dialog runs its own loop (paused while closed).
    stage.renderer.setAnimationLoop(null);
    const character = await Character.load({
      pack: packUrl(), renderer: stage.renderer, materials: stage.materials, worker: new (await humanWorker())(), clipLibraries: false,
      // City-safe choices only: CC0 assets (CC-BY ones would need a credit wherever the hero is seen).
      catalog: cc0Catalog,
      config: { ...GAME_ONLY, animation: 'idle' },
    });
    stage.scene.add(character.object);
    return { host, stage, character };
  })().catch((e) => {
    studio = null;
    throw e;
  }));
}

/** Release the creator's stage (its WebGL context; called when the game starts). */
export function disposeCreatorPreview(): void {
  const s = studio;
  studio = null;
  void s?.then((x) => {
    x.character.dispose();
    x.stage.dispose();
    x.host.remove();
  }, () => undefined);
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
  private name: HTMLInputElement;
  private stageEl: HTMLDivElement;
  private stageMsg: HTMLElement;
  private panel: HTMLDivElement;
  private editor: CharacterEditor | null = null;
  private initial: CharacterPatch | null = null;
  private studio: Studio | null = null;
  private closed = false;
  private offShape: (() => void) | null = null;
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); this.close(); }
  };

  constructor(private opts: CreatorOptions) {
    this.el = h('div', 'cc');
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Character creator');

    // ---- stage
    this.stageEl = h('div', 'cc-stage');
    this.stageMsg = h('div', 'cc-stage-msg', 'Loading the character generator…');
    const bar = h('div', 'cc-stage-bar');
    const poseBtns = h('div', 'cc-seg');
    for (const [id, label] of [['idle', 'Stand'], ['walk', 'Walk']] as const) {
      const b = h('button', id === 'idle' ? 'on' : '', label);
      b.type = 'button';
      b.onclick = () => {
        void this.studio?.character.play(id);
        for (const x of poseBtns.children) x.classList.toggle('on', x === b);
      };
      poseBtns.appendChild(b);
    }
    const face = h('button', 'cc-btn', 'Face');
    face.type = 'button';
    face.title = 'Look at the face';
    face.onclick = () => {
      const s = this.studio;
      if (!s) return;
      const y = s.character.height * 0.93;
      s.stage.view([0.15, y, 0.9], [0, y, 0]);
    };
    const body = h('button', 'cc-btn', 'Body');
    body.type = 'button';
    body.onclick = () => this.frameBody();
    bar.append(body, face, poseBtns);
    this.stageEl.append(h('div', 'cc-halo'), this.stageMsg, bar, h('div', 'cc-hint', 'Drag to rotate · scroll to zoom'));

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
    this.panel = h('div', 'cc-editor cc-actors');
    const foot = h('div', 'cc-foot');
    const reset = h('button', 'cc-btn ghost', 'Reset');
    reset.type = 'button';
    reset.title = opts.look ? 'Back to the saved version' : 'Back to the first suggestion';
    reset.onclick = () => { if (this.initial) void this.studio?.character.set(structuredClone(this.initial)); };
    const cancel = h('button', 'cc-btn ghost', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = () => this.close();
    const save = h('button', 'cc-btn primary', 'Save character');
    save.type = 'button';
    save.onclick = () => void this.save(save);
    const credit = h('div', 'cc-credit', 'Characters: Actors (MakeHuman CC0 assets, Quaternius CC0 animations)');
    foot.append(reset, credit, h('div', 'cc-spacer'), cancel, save);
    side.append(head, this.panel, foot);

    this.el.append(this.stageEl, side);
    document.body.appendChild(this.el);
    holdBackdrop(true);
    window.addEventListener('keydown', this.onKey);
    void this.init();
  }

  private async init(): Promise<void> {
    let s: Studio;
    try {
      s = await sharedStudio();
    } catch (e) {
      console.error(e);
      this.stageMsg.textContent = `The character generator could not load (${(e as Error).message}).`;
      return;
    }
    if (this.closed) return;
    this.studio = s;
    this.stageEl.insertBefore(s.host, this.stageMsg);
    s.host.style.display = '';
    const { character, stage } = s;
    // A new body height (a slider, a race) re-frames the camera.
    this.offShape = character.onShape(() => this.frameBody());
    // The look to edit, or a random new person in everyday clothes.
    if (this.opts.look) await character.set({ ...normalizeLook(this.opts.look).actor, ...GAME_ONLY, animation: 'idle' });
    else {
      const seed = (Math.random() * 2 ** 32) >>> 0;
      await character.randomize({ random: seededRandom(seed), outfit: true, robot: false, race: 'human', gender: Math.random() < 0.5 ? 'female' : 'male' });
      await character.set({ ...GAME_ONLY, animation: 'idle', skin: 'photo' });
    }
    if (this.closed) return;
    this.initial = character.config;
    this.editor = new CharacterEditor(character, this.panel, {
      title: 'Look',
      sections: ['race', 'robot', 'body', 'look', 'outfit', 'details'],
      buttons: ['randomize'],
      // The game animates the face and keeps everyone decent.
      hide: ['anatomy', 'expression', 'expressionIntensity', 'blink', 'lod'],
      randomize: () => character.randomize({ outfit: true }).then((c) => ({ ...c, ...GAME_ONLY, animation: character.config.animation })),
    });
    this.frameBody();
    this.stageMsg.classList.add('hide');
    let last = performance.now();
    stage.renderer.setAnimationLoop(() => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      character.update(dt);
      stage.controls.update();
      stage.renderer.render(stage.scene, stage.camera);
    });
  }

  /** The whole body in view, clear of the bar at the bottom. */
  private frameBody(): void {
    const s = this.studio;
    if (!s) return;
    const k = Math.max(0.3, s.character.height || 1.75) / 1.7;
    s.stage.view([0.55 * k, 1.05 * k, 4.9 * k], [0, 0.82 * k, 0]);
  }

  /** A small front view of the character (PNG). */
  private thumbnail(w = 120, hgt = 160): string | undefined {
    const s = this.studio;
    if (!s) return undefined;
    const { stage, character } = s;
    try {
      const keepPos = stage.camera.position.clone(), keepTarget = stage.controls.target.clone();
      const ht = character.height || 1.75;
      stage.view([0, ht * 0.55, ht * 2.6], [0, ht * 0.5, 0]);
      stage.renderer.render(stage.scene, stage.camera);
      const src = stage.renderer.domElement;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = hgt;
      const ctx = c.getContext('2d')!;
      // Centre crop of the frame to the thumbnail's aspect.
      const aspect = w / hgt;
      const sw = Math.min(src.width, src.height * aspect), sh = sw / aspect;
      ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, w, hgt);
      stage.view(keepPos.toArray(), keepTarget.toArray());
      return c.toDataURL('image/png');
    } catch (e) {
      console.warn('[creator] no thumbnail', e);
      return undefined;
    }
  }

  private async save(btn: HTMLButtonElement): Promise<void> {
    const s = this.studio;
    if (!s) return;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    // Wait for the last change to show before the thumbnail is taken.
    await s.character.set({});
    const thumb = this.thumbnail();
    const name = this.name.value.trim() || 'Me';
    const config: CharacterPatch = { ...s.character.config, ...GAME_ONLY, animation: null };
    try {
      await this.opts.onSave({ name, look: { actor: config }, thumb });
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
    window.removeEventListener('keydown', this.onKey);
    const s = this.studio;
    if (s) {
      s.stage.renderer.setAnimationLoop(null);
      s.host.style.display = 'none';
      document.body.appendChild(s.host);
    }
    this.editor?.dispose();
    this.offShape?.();
    this.el.remove();
    holdBackdrop(false);
    this.opts.onClose?.();
  }
}
