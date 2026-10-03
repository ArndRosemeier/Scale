/**
 * Complete CPU build of a character from its appearance: body (morph,
 * skeleton, sockets, fit), render-vertex expansion and add-on parts for the
 * near (0) and mid (1) LODs. Runs in the body worker; the main thread falls
 * back to calling it directly if workers are unavailable.
 */
import type { HumanAssets } from './assets';
import { buildBody, type BodyData } from './bodyBuild';
import { buildParts, type PartsResult } from './parts';
import type { HumanoidAppearance } from './types';

export interface CharacterBuild {
  body: BodyData;
  renderPos: Float32Array;
  renderNormal: Float32Array;
  parts: [PartsResult, PartsResult];
  ms: number;
}

export function buildCharacter(as: HumanAssets, app: HumanoidAppearance): CharacterBuild {
  const t0 = performance.now();
  const body = buildBody(as, app);
  const RV = as.manifest.renderVerts;
  const src = as.renderSrc;
  const renderPos = new Float32Array(RV * 3), renderNormal = new Float32Array(RV * 3);
  for (let r = 0; r < RV; r++) {
    const v = src[r] * 3;
    renderPos[r * 3] = body.pos[v]; renderPos[r * 3 + 1] = body.pos[v + 1]; renderPos[r * 3 + 2] = body.pos[v + 2];
    renderNormal[r * 3] = body.normal[v]; renderNormal[r * 3 + 1] = body.normal[v + 1]; renderNormal[r * 3 + 2] = body.normal[v + 2];
  }
  const parts: [PartsResult, PartsResult] = [buildParts(as, body, app, 0), buildParts(as, body, app, 1)];
  return { body, renderPos, renderNormal, parts, ms: performance.now() - t0 };
}

/** Transferable buffers of a build (for postMessage). */
export function buildTransfers(b: CharacterBuild): ArrayBuffer[] {
  const out: ArrayBuffer[] = [b.renderPos.buffer as ArrayBuffer, b.renderNormal.buffer as ArrayBuffer, b.body.heads.buffer as ArrayBuffer, b.body.tails.buffer as ArrayBuffer];
  for (const pr of b.parts) for (const p of pr.parts) {
    out.push(p.position.buffer as ArrayBuffer, p.normal.buffer as ArrayBuffer, p.uv.buffer as ArrayBuffer, p.tangent.buffer as ArrayBuffer, p.aux.buffer as ArrayBuffer, p.skinIndex.buffer as ArrayBuffer, p.skinWeight.buffer as ArrayBuffer, p.index.buffer as ArrayBuffer);
  }
  return out;
}
