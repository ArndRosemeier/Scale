/**
 * Loads the converted MakeHuman assets (`public/assets/human/`) into typed
 * arrays. Worker-safe (no DOM / three.js). Loaded once per thread and cached.
 */
import { HUMAN_ASSET_DIR, HUMAN_ASSET_VERSION, type HumanManifest, type LocalTargetDef } from './assetFormat';

export interface HumanAssets {
  manifest: HumanManifest;
  basePos: Float32Array;
  renderSrc: Uint16Array;
  renderUV: Float32Array;
  index: Uint16Array;
  lodIndex: Uint16Array;
  skinIdx: Uint8Array;
  skinW: Uint8Array;
  pcaMean: Int16Array;
  pcaBasis16: Int16Array;
  pcaBasis8: Int8Array;
  pcaProj: Float32Array;
  localIdx8: Uint16Array;
  localDelta8: Int8Array;
  localIdx16: Uint16Array;
  localDelta16: Int16Array;
  exprVerts: Uint16Array;
  exprDelta: Int16Array;
  localByName: Map<string, LocalTargetDef>;
  boneByName: Map<string, number>;
}

let cache: Promise<HumanAssets> | null = null;

/** Base URL of the asset folder (works on the main thread and in Vite workers). */
export function humanAssetUrl(file: string): string {
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  const loc = (globalThis as { location?: { origin?: string } }).location;
  const prefix = loc?.origin ? loc.origin : '';
  return `${prefix}${base}${HUMAN_ASSET_DIR}${file}`;
}

/** Load (once) and parse the human assets. */
export function loadHumanAssets(): Promise<HumanAssets> {
  if (!cache) cache = doLoad().catch((e) => { cache = null; throw e; });
  return cache;
}

async function doLoad(): Promise<HumanAssets> {
  const manifest = (await (await fetch(humanAssetUrl('manifest.json'))).json()) as HumanManifest;
  if (manifest.version !== HUMAN_ASSET_VERSION) throw new Error(`human assets version ${manifest.version}, expected ${HUMAN_ASSET_VERSION}`);
  const buf = await (await fetch(humanAssetUrl(manifest.file))).arrayBuffer();
  return parseHumanAssets(manifest, buf);
}

/** Wrap the binary blob into typed views according to the manifest. */
export function parseHumanAssets(manifest: HumanManifest, buf: ArrayBuffer): HumanAssets {
  const view = <T>(name: string, ctor: new (b: ArrayBuffer, o: number, l: number) => T): T => {
    const s = manifest.sections[name];
    if (!s) throw new Error(`human assets: missing section ${name}`);
    return new ctor(buf, s.offset, s.length);
  };
  const localByName = new Map<string, LocalTargetDef>();
  for (const d of manifest.local) localByName.set(d.name, d);
  const boneByName = new Map<string, number>();
  manifest.bones.forEach((b, i) => boneByName.set(b.name, i));
  return {
    manifest,
    basePos: view('basePos', Float32Array),
    renderSrc: view('renderSrc', Uint16Array),
    renderUV: view('renderUV', Float32Array),
    index: view('index', Uint16Array),
    lodIndex: view('lodIndex', Uint16Array),
    skinIdx: view('skinIdx', Uint8Array),
    skinW: view('skinW', Uint8Array),
    pcaMean: view('pcaMean', Int16Array),
    pcaBasis16: view('pcaBasis16', Int16Array),
    pcaBasis8: view('pcaBasis8', Int8Array),
    pcaProj: view('pcaProj', Float32Array),
    localIdx8: view('localIdx8', Uint16Array),
    localDelta8: view('localDelta8', Int8Array),
    localIdx16: view('localIdx16', Uint16Array),
    localDelta16: view('localDelta16', Int16Array),
    exprVerts: view('exprVerts', Uint16Array),
    exprDelta: view('exprDelta', Int16Array),
    localByName,
    boneByName,
  };
}
