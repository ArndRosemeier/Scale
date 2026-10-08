/**
 * The hero's three costumes (F1–F3, Wardrobe). All three start as the look the hero began with;
 * the fitting mirror changes only the one being worn. Pure (no DOM, no three.js): the saved form
 * and its sanitising, tested in selftest.ts.
 */
import { normalizeLook, type CharacterLook } from '../avatar/look';

export const COSTUME_COUNT = 3;

/** In a save: which costume is worn and the three looks (null: the look the hero started with). */
export interface SavedCostumes { active: number; looks: (CharacterLook | null)[] }

/** A saved costume set, sanitised (null when there is nothing usable). */
export function readCostumes(raw: unknown): SavedCostumes | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { active?: unknown; looks?: unknown };
  if (!Array.isArray(o.looks)) return null;
  const looks: (CharacterLook | null)[] = [];
  for (let i = 0; i < COSTUME_COUNT; i++) {
    const l = o.looks[i] as CharacterLook | null | undefined;
    let ok: CharacterLook | null = null;
    if (l && typeof l === 'object' && l.appearance && typeof l.appearance === 'object' && l.outfit && typeof l.outfit === 'object') {
      try { ok = normalizeLook(l); } catch { ok = null; }
    }
    looks.push(ok);
  }
  const a = Number(o.active);
  const active = Number.isInteger(a) && a >= 0 && a < COSTUME_COUNT ? a : 0;
  return { active, looks };
}
