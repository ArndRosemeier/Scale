/**
 * Barks: short speech bubbles over people, used sparingly (PLAYGROUND_PLAN decision 15:
 * situational outbursts, never dialogue or instructions). They come from what people are doing,
 * watched here rather than wired into every system: someone starting to flee or gawk, a victim
 * pointing after a thief, a criminal giving up, an officer giving chase, someone helped up,
 * a pet owner calling — and now and then a bit of small talk from a passer-by.
 *
 * Sparse by design: only people within RANGE and on screen, at most MAX_SHOWN bubbles, a short
 * gap between new ones, a long pause per person, and most moments only bark some of the time.
 */
import * as THREE from 'three';
import type { Game } from '../game/Game';
import { PState, type PedAgent } from '../sim/Pedestrians';

const RANGE = 25;
const MAX_SHOWN = 3;
/** Seconds a bubble stays; between two new bubbles; before the same person speaks again. */
const SHOW = 2.6, GAP = 0.9, PERSON_PAUSE = 25;
/** Small talk: seconds between two lines (random within). */
const CHAT_MIN = 20, CHAT_MAX = 40;

type Lines = readonly string[];
const L = {
  flee: ['Run!', 'Move!', 'Oh no!', 'Get away from there!'],
  gawk: ['Whoa…', 'What is that?', 'Look at that!', 'Is that real?'],
  film: ['Are you getting this?', 'Oh my god.', 'Nobody will believe this.'],
  thanks: ['Thank you!', 'Thanks, I\'m okay.', 'Oh, thank you.'],
  ouch: ['Ow!', 'Ugh…', 'My knee…'],
  victimPoint: ['Thief! Stop him!', 'My bag!', 'Somebody stop him!'],
  victimCower: ['Please, don\'t hurt me!', 'Take it, just take it!'],
  victimHappy: ['Thank you!', 'You got it back!'],
  crookFight: ['Back off!', 'You want some?', 'Stay out of this!'],
  crookGiveUp: ['Okay, okay!', 'I give up!', 'Don\'t hit me!'],
  crookCuffed: ['This is a mistake!', 'I didn\'t do anything!'],
  shopkeeper: ['Help! Robbery!', 'Call the police!'],
  policeChase: ['Stop! Police!', 'Freeze!'],
  policeArrest: ['On the ground!', 'Hands behind your back!'],
  soldierFire: ['Open fire!', 'Keep it busy!', 'Aim for the throat!', 'Hit it!'],
  soldierBack: ['Fall back!', 'The line is breaking!', 'Move, move!'],
  ownerCall: ['Please, help!', 'Come back!', 'Oh no, oh no…'],
  ownerHappy: ['Thank you so much!', 'You found it!'],
  chat: ['Morning.', 'Excuse me.', 'Nice day, huh?', 'I\'m on my way.', 'Yeah, I\'ll call you back.', 'Did you see the news?', 'Running late again…', 'Sorry!'],
} as const satisfies Record<string, Lines>;

interface Seen { st: PState; act: string | null; helped: boolean }

export class Barks {
  private els: HTMLDivElement[] = [];
  private shown: { a: PedAgent; el: HTMLDivElement; t: number }[] = [];
  private seen = new WeakMap<PedAgent, Seen>();
  private quiet = new WeakMap<PedAgent, number>();
  private time = 0;
  private gapT = 0;
  private chatT = CHAT_MIN;
  private p = new THREE.Vector3();

  constructor(private game: Game) {
    for (let i = 0; i < MAX_SHOWN; i++) {
      const el = document.createElement('div');
      el.className = 'bark';
      document.body.appendChild(el);
      this.els.push(el);
    }
  }

  update(dt: number): void {
    this.time += dt;
    this.gapT -= dt;
    this.chatT -= dt;
    const g = this.game, cam = g.renderer.camera.position;
    const hidden = g.map.open || g.menu?.paused === true || g.freeCam;
    // Watch people near the camera for moments worth a word.
    for (const a of g.peds.agents) {
      if (!a.alive || Math.abs(a.x - cam.x) > RANGE || Math.abs(a.z - cam.z) > RANGE) continue;
      const act = a.actor;
      const now: Seen = { st: a.state, act: act ? `${act.role}:${act.state}:${act.mood}` : null, helped: !!a.helped };
      const was = this.seen.get(a);
      this.seen.set(a, now);
      if (!was || hidden) continue;
      const line = this.moment(a, was, now);
      if (line) this.say(a, line);
    }
    // Now and then a passer-by says something.
    if (this.chatT <= 0 && !hidden) {
      this.chatT = CHAT_MIN + Math.random() * (CHAT_MAX - CHAT_MIN);
      const near = g.peds.agents.filter((a) => a.alive && !a.actor && !a.inside && (a.state === PState.Walk || a.state === PState.Idle) && Math.hypot(a.x - cam.x, a.z - cam.z) < 12);
      if (near.length) this.say(near[Math.floor(Math.random() * near.length)], pick(L.chat));
    }
    this.draw(dt, hidden);
  }

  /** A line for what just changed about this person, or null (most moments pass silently). */
  private moment(a: PedAgent, was: Seen, now: Seen): string | null {
    const act = a.actor;
    if (act) {
      if (now.act === was.act) return null;
      const [role, state, mood] = now.act!.split(':');
      const prev = was.act?.split(':')[1];
      if (state === prev && mood === 'happy' && (role === 'victim' || role === 'owner')) return pick(role === 'owner' ? L.ownerHappy : L.victimHappy);
      if (state === prev) return null;
      switch (role) {
        case 'victim': return state === 'point' ? pick(L.victimPoint) : state === 'cower' ? pick(L.victimCower) : state === 'cheer' ? pick(L.victimHappy) : null;
        case 'criminal':
          if (state === 'surrender') return pick(L.crookGiveUp);
          if (state === 'arrested') return chance(0.5) ? pick(L.crookCuffed) : null;
          return state === 'fight' && chance(0.5) ? pick(L.crookFight) : null;
        case 'police': return state === 'run' && chance(0.6) ? pick(L.policeChase) : state === 'fight' ? pick(L.policeArrest) : null;
        case 'soldier': return state === 'run' && chance(0.5) ? pick(L.soldierBack) : state === 'fight' && chance(0.2) ? pick(L.soldierFire) : null;
        case 'shopkeeper': return state === 'point' ? pick(L.shopkeeper) : null;
        case 'owner': return state === 'point' || state === 'run' ? (chance(0.6) ? pick(L.ownerCall) : null) : state === 'cheer' ? pick(L.ownerHappy) : null;
        default: return null;
      }
    }
    if (now.helped && !was.helped && now.st !== PState.Down) return pick(L.thanks);
    if (now.st === was.st) return null;
    switch (now.st) {
      case PState.Flee: return chance(0.25) ? pick(L.flee) : null;
      case PState.Gawk: return chance(0.3) ? pick(L.gawk) : null;
      case PState.Film: return chance(0.3) ? pick(L.film) : null;
      case PState.Down: return a.downBy === 'accident' && chance(0.6) ? pick(L.ouch) : null;
      default: return null;
    }
  }

  private say(a: PedAgent, text: string): void {
    if (this.gapT > 0 || this.shown.some((s) => s.a === a)) return;
    if (this.time < (this.quiet.get(a) ?? -Infinity)) return;
    // Only where it can be seen.
    const cam = this.game.renderer.camera;
    this.p.set(a.x, a.y + 2.05, a.z).project(cam);
    if (this.p.z > 1 || Math.abs(this.p.x) > 0.95 || Math.abs(this.p.y) > 0.95) return;
    if (this.shown.length >= MAX_SHOWN) return;
    const el = this.els.find((e) => !this.shown.some((s) => s.el === e))!;
    el.textContent = text;
    el.classList.remove('out');
    this.shown.push({ a, el, t: 0 });
    this.quiet.set(a, this.time + PERSON_PAUSE);
    this.gapT = GAP;
  }

  private draw(dt: number, hidden: boolean): void {
    const cam = this.game.renderer.camera, W = window.innerWidth, H = window.innerHeight;
    for (let i = this.shown.length - 1; i >= 0; i--) {
      const s = this.shown[i];
      s.t += dt;
      const gone = !s.a.alive || s.t > SHOW;
      this.p.set(s.a.x, s.a.y + 2.05, s.a.z).project(cam);
      const off = hidden || this.p.z > 1 || Math.abs(this.p.x) > 1.05 || Math.abs(this.p.y) > 1.05;
      if (gone) { s.el.style.display = 'none'; this.shown.splice(i, 1); continue; }
      s.el.style.display = off ? 'none' : 'block';
      if (off) continue;
      if (s.t > SHOW - 0.35) s.el.classList.add('out');
      const d = cam.position.distanceTo(_v.set(s.a.x, s.a.y + 1.8, s.a.z));
      const k = Math.max(0.7, Math.min(1.1, 9 / Math.max(1, d)));
      s.el.style.transform = `translate(${((this.p.x * 0.5 + 0.5) * W).toFixed(1)}px, ${((-this.p.y * 0.5 + 0.5) * H).toFixed(1)}px) translate(-50%, -100%) scale(${k.toFixed(2)})`;
    }
  }
}

const _v = new THREE.Vector3();

function pick(l: Lines): string {
  return l[Math.floor(Math.random() * l.length)];
}

function chance(p: number): boolean {
  return Math.random() < p;
}
