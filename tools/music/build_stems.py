"""
Build Scale's background-music stems with Stable Audio 3 (adapted from Norgo).

  cd tools/music && uv run python build_stems.py [set ...] [--force]
  (or reuse Norgo's environment: C:/Projekte/Norgo/tools/music/.venv/Scripts/python build_stems.py)

Runs in a uv environment like Norgo's tools/music (torch cu128, stable-audio-3, librosa);
model weights come from the shared Hugging Face cache. The SoundStudio server
must not be running at the same time (GPU memory).

For every set/layer/variation it generates takes until one passes the checks,
keeping the best of up to MAX_TRIES:

  key      share of pitched energy inside the set's scale (pitched layers)
  locked   texture/perc: beat-tracked tempo within tolerance of the set's BPM (3 % drums, 0.8 % pitched)
           (or half/double) and timing wobble under 20 ms
  floating drone/melody: no strong competing pulse (they play in free time)
  level    not near-silent

Locked takes are resampled to the exact BPM (a few cents at most) and cut on a
beat. Every stem is cut to the set's loop length, wrapped seamlessly (the tail
past the loop end is cross-faded over the head), loudness-normalised per layer,
resampled to 48 kHz and written as Ogg Opus to
public/music/<set>/<layer>_<i>.ogg. manifest.json is rewritten
after every stem, so the game can use sets as soon as they exist.

Raw takes are cached in .cache/music-raw/ (keyed by prompt), so re-runs only
generate what's missing; a report of every stem's checks goes to
.cache/music-report.json.
"""
from __future__ import annotations

import json
import sys
import time
import zlib
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).parent))
from sets import LAYERS, LOCKED, MODES, NOTE_HZ, NOTE_PC, SETS, VARIATIONS_OF, loop_bars, plain_mode, prompt_for, safe_degrees  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public' / 'music'
RAW = ROOT / '.cache' / 'music-raw'
MANIFEST = OUT / 'manifest.json'
REPORT = ROOT / '.cache' / 'music-report.json'
MAX_TRIES = 16
OUT_SR = 48000
# Wrapped margins around each encoded loop (see to_opus).
LEAD_S = 0.05
TAIL_S = 0.2
LEAD_IN_S = 1.0
XFADE_S = {'drone': 4.0, 'melody': 3.0, 'texture': 1.5, 'perc': 0.6}
TARGET_RMS_DB = {'drone': -21.0, 'texture': -22.0, 'melody': -21.0, 'perc': -20.0}
# Allowed tempo deviation before resampling to the exact BPM: drums are unpitched, so
# they may move further; pitched textures shift by at most ~14 cents.
TEMPO_TOL = {'perc': 0.03, 'texture': 0.008, 'drone': 0.008, 'melody': 0.008}
WOBBLE_MAX = 0.020
# Beat-timing wobble above which a take has no steady grid at all (free time).
FREE_WOBBLE = 0.040


# ---------------------------------------------------------------- analysis

def chroma_share(y: np.ndarray, sr: int, tonic: str, mode: str) -> float:
    """Share of pitched energy (55 Hz–2.5 kHz) on the set's scale degrees."""
    n, hop = 8192, 4096
    win = np.hanning(n)
    frames = np.array([y[i:i + n] * win for i in range(0, len(y) - n, hop)])
    S = np.abs(np.fft.rfft(frames, axis=1)) ** 2
    f = np.fft.rfftfreq(n, 1 / sr)
    sel = (f > 55) & (f < 2500)
    pc = ((np.round(12 * np.log2(f[sel] / 440.0)) + 9) % 12).astype(int)
    c = np.bincount(pc, weights=S[:, sel].sum(axis=0), minlength=12)
    c /= c.sum() + 1e-12
    return float(sum(c[(NOTE_PC[tonic] + d) % 12] for d in MODES[mode]))


def beat_grid(y: np.ndarray, sr: int, bpm: float) -> dict:
    """Beat-track and fit a straight grid: actual tempo, phase and timing wobble."""
    oenv = librosa.onset.onset_strength(y=y, sr=sr)
    _, beats = librosa.beat.beat_track(onset_envelope=oenv, sr=sr, start_bpm=bpm, tightness=400, units='time')
    pulse = float(oenv.std() / (oenv.mean() + 1e-9))
    if len(beats) < 12:
        return dict(bpm=0.0, phase=0.0, wobble=1.0, pulse=pulse, mult=0.0)
    k = np.arange(len(beats))
    period, t0 = np.polyfit(k, beats, 1)
    wobble = float((beats - (period * k + t0)).std())
    fit = 60.0 / period
    # Which multiple of the set tempo the take is felt in (half, same, double).
    mult = min((0.5, 1.0, 2.0), key=lambda m: abs(fit / (bpm * m) - 1))
    return dict(bpm=float(fit), phase=float(t0 % period), wobble=wobble, pulse=pulse, mult=mult)


def score_take(x: np.ndarray, sr: int, set_id: str, layer: str) -> dict:
    s = SETS[set_id]
    y = librosa.resample(x.mean(axis=1), orig_sr=sr, target_sr=22050)
    rms_db = float(20 * np.log10(np.sqrt(np.mean(y ** 2)) + 1e-12))
    g = beat_grid(y, 22050, s['bpm'])
    # Modes are subtle; a take in the plain prompted key (e.g. aeolian for phrygian) is fine
    # too — the game's in-key accents only use the notes both share (safe_degrees).
    key = max(chroma_share(y, 22050, s['tonic'], s['mode']), chroma_share(y, 22050, s['tonic'], plain_mode(s['mode']))) if layer != 'perc' else 1.0
    dev = abs(g['bpm'] / (s['bpm'] * g['mult']) - 1) if g['mult'] else 1.0
    if layer in LOCKED:
        rhythm_ok = dev < TEMPO_TOL[layer] and g['wobble'] < WOBBLE_MAX
        rhythm_score = 2.0 - dev / TEMPO_TOL[layer] - g['wobble'] * 40
    else:
        # Floating layers may have clear note attacks, but must not carry a steady beat
        # at a foreign tempo: weak pulse, no steady grid (rubato), or exactly our grid.
        locked = dev < TEMPO_TOL[layer] and g['wobble'] < WOBBLE_MAX
        free = g['pulse'] < 1.1 or g['wobble'] > FREE_WOBBLE
        rhythm_ok = locked or free
        rhythm_score = 1.0 if rhythm_ok else 1.0 - (g['pulse'] - 1.1) - (FREE_WOBBLE - g['wobble']) * 20
    loud = rms_db > -45
    key_ok = key >= 0.75
    passed = bool(key_ok and rhythm_ok and loud)
    score = key * 3 + rhythm_score + (0 if loud else -5)
    return dict(passed=passed, score=round(float(score), 3), key=round(key, 3), bpm=round(g['bpm'], 2),
                mult=g['mult'], wobble_ms=round(g['wobble'] * 1000, 1), pulse=round(g['pulse'], 2),
                rms_db=round(rms_db, 1), _grid=g)


# ---------------------------------------------------------------- loop cutting

def make_loop(x: np.ndarray, sr: int, set_id: str, layer: str, grid: dict) -> np.ndarray:
    s = SETS[set_id]
    bpm = s['bpm']
    beat = 60.0 / bpm
    phase = 0.0
    if layer in LOCKED and grid['mult']:
        # Resample so the take's tempo becomes exactly the set's (pitch moves by a few cents).
        r = (bpm * grid['mult']) / grid['bpm']  # playback-rate factor that fixes the tempo
        x = librosa.resample(x.T, orig_sr=sr * r, target_sr=sr, res_type='soxr_hq').T
        phase = grid['phase'] / r
        beat_felt = beat / grid['mult']
        while phase < LEAD_IN_S:
            phase += beat_felt
    else:
        phase = LEAD_IN_S
    bars = loop_bars(bpm)
    L = int(round(bars * 4 * beat * sr))
    X = int(XFADE_S[layer] * sr)
    start = int(round(phase * sr))
    if start + L + X > len(x):
        raise ValueError(f'take too short for a {bars}-bar loop')
    seg = x[start:start + L + X]
    out = seg[:L].copy()
    t = np.linspace(0, np.pi / 2, X)[:, None]
    # Equal-power crossfade of the continuation over the head: seamless wrap.
    out[:X] = seg[:X] * np.sin(t) + seg[L:L + X] * np.cos(t)
    out *= 10 ** (TARGET_RMS_DB[layer] / 20) / (np.sqrt(np.mean(out ** 2)) + 1e-12)
    peak = np.abs(out).max()
    if peak > 0.97:
        out *= 0.97 / peak
    return out.astype(np.float32)


# ---------------------------------------------------------------- generation

_model = None


def model():
    global _model
    if _model is None:
        from stable_audio_3 import StableAudioModel
        print('loading small-music …', flush=True)
        _model = StableAudioModel.from_pretrained('small-music', device='cuda')
    return _model


def generate(prompt: str, seconds: float, seed: int) -> tuple[np.ndarray, int]:
    m = model()
    audio = m.generate(prompt=prompt, duration=seconds, seed=seed, batch_size=1)
    sr = int(m.model.sample_rate)
    x = audio[0].detach().float().cpu().numpy().T  # [samples, channels]
    if not np.isfinite(x).all():
        raise RuntimeError('non-finite audio')
    return np.clip(x, -1, 1), sr


# libsndfile's Opus 'compression level' → bitrate (stereo, measured): 0.8 ≈ 111 kbps, 0.85 ≈ 86 kbps.
OPUS_LEVEL = {'drone': 0.92, 'texture': 0.9, 'melody': 0.9, 'perc': 0.9}


def to_opus(x: np.ndarray, sr: int, path: Path, layer: str) -> None:
    if sr != OUT_SR:
        # Resample the loop cyclically (wrapped padding on both sides), so the seam stays seamless:
        # a plain resample treats the ends as silence and rings there (a click at every wrap).
        pad = int(0.25 * sr)
        ext = np.concatenate([x[-pad:], x, x[:pad]])
        y = librosa.resample(ext.T, orig_sr=sr, target_sr=OUT_SR, res_type='soxr_hq').T
        p_out = int(round(pad * OUT_SR / sr))
        y = y[p_out:p_out + int(round(len(x) * OUT_SR / sr))]
    else:
        y = x
    # Opus does not reproduce the first and last few ms of a file faithfully (encoder priming and
    # the zero-padded last frame): wrap a little of the loop around both ends. The game loops the
    # buffer between LEAD_S and LEAD_S + loopSeconds (manifest 'lead'), never touching the edges.
    y = np.concatenate([y[-int(LEAD_S * OUT_SR):], y, y[:int(TAIL_S * OUT_SR)]])
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), y, OUT_SR, format='OGG', subtype='OPUS', compression_level=OPUS_LEVEL[layer])


# ---------------------------------------------------------------- manifest

def write_manifest() -> None:
    sets = {}
    for set_id, s in SETS.items():
        layers = {}
        for layer in LAYERS:
            files = sorted(p.relative_to(OUT).as_posix() for p in (OUT / set_id).glob(f'{layer}_*.ogg'))
            if files:
                layers[layer] = files
        if 'drone' not in layers:
            continue  # a set needs at least its bed
        bars = loop_bars(s['bpm'])
        sets[set_id] = dict(
            tonic=s['tonic'], mode=s['mode'], tonicHz=NOTE_HZ[s['tonic']],
            scaleCents=[d * 100 for d in MODES[s['mode']]],
            # Notes safe for accents whether a stem played the mode or the plain key.
            safeCents=[d * 100 for d in safe_degrees(s['mode'])], bpm=s['bpm'], beatsPerBar=4, bars=bars,
            loopSeconds=round(bars * 4 * 60 / s['bpm'], 6), layers=layers,
        )
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(dict(version=2, sampleRate=OUT_SR, lead=LEAD_S, sets=sets), indent=1))


def prune(set_id: str, layer: str, report: dict) -> None:
    """Never ship a failing stem when the layer has a passing variation: a failing take
    is only kept (flagged in the report) as the sole option for its layer."""
    entries = [(v, report.get(f'{set_id}/{layer}_{v}')) for v in range(VARIATIONS_OF[set_id][layer])]
    if not any(r and r['passed'] for _, r in entries):
        return
    for v, r in entries:
        p = OUT / set_id / f'{layer}_{v}.ogg'
        if r and not r['passed'] and p.exists():
            p.unlink()
            r['dropped'] = True
            print(f'- dropped {set_id}/{layer}_{v} (failed; layer has passing variations)', flush=True)
    write_manifest()
    save_report(report)


def save_report(entries: dict) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(list(entries.values()), indent=1))


# ---------------------------------------------------------------- main

def build(set_ids: list[str], force: bool) -> None:
    report = {r['stem']: r for r in json.loads(REPORT.read_text())} if REPORT.exists() else {}
    built = 0
    for set_id in set_ids:
        s = SETS[set_id]
        loop_s = loop_bars(s['bpm']) * 4 * 60 / s['bpm']
        gen_s = min(120.0, loop_s + max(XFADE_S.values()) + LEAD_IN_S + 2 * 60 / s['bpm'] + 4.0)
        for layer in LAYERS:
            if not VARIATIONS_OF[set_id][layer]:
                continue
            prompt = prompt_for(set_id, layer)
            ph = f'{zlib.crc32(prompt.encode()):08x}'
            for v in range(VARIATIONS_OF[set_id][layer]):
                out = OUT / set_id / f'{layer}_{v}.ogg'
                prev = report.get(f'{set_id}/{layer}_{v}')
                if not force and (out.exists() or (prev and prev.get('dropped'))):
                    continue
                best = None
                for k in range(MAX_TRIES):
                    seed = zlib.crc32(f'{set_id}/{layer}/{v}/{k}/{ph}'.encode()) % 2_000_000_000
                    raw = RAW / set_id / f'{layer}_{v}_{k}_{ph}.wav'
                    if raw.exists():
                        x, sr = sf.read(str(raw), always_2d=True)
                    else:
                        t0 = time.time()
                        x, sr = generate(prompt, gen_s, seed)
                        raw.parent.mkdir(parents=True, exist_ok=True)
                        sf.write(str(raw), x, sr, subtype='FLOAT')
                        print(f'  generated {set_id}/{layer}_{v} try {k} in {time.time() - t0:.1f}s', flush=True)
                    sc = score_take(x, sr, set_id, layer)
                    shown = {k2: v2 for k2, v2 in sc.items() if not k2.startswith('_')}
                    print(f'  {set_id}/{layer}_{v} try {k}: {shown}', flush=True)
                    if best is None or sc['score'] > best[0]['score']:
                        best = (sc, x, sr, k)
                    if sc['passed']:
                        break
                sc, x, sr, k = best
                to_opus(make_loop(x, sr, set_id, layer, sc['_grid']), sr, out, layer)
                report[f'{set_id}/{layer}_{v}'] = dict(stem=f'{set_id}/{layer}_{v}', take=k,
                                                       **{k2: v2 for k2, v2 in sc.items() if not k2.startswith('_')})
                save_report(report)
                write_manifest()
                built += 1
                print(f'+ {out.relative_to(ROOT)} (take {k}, passed={sc["passed"]})', flush=True)
            prune(set_id, layer, report)
    write_manifest()
    failed = sorted(r['stem'] for r in report.values() if not r['passed'] and not r.get('dropped'))
    dropped = sorted(r['stem'] for r in report.values() if r.get('dropped'))
    print(f'done. {built} stems built; shipped below threshold: {failed or "none"}; dropped: {dropped or "none"}')


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    unknown = [a for a in args if a not in SETS]
    if unknown:
        sys.exit(f'unknown set(s): {unknown}; known: {list(SETS)}')
    build(args or list(SETS), '--force' in sys.argv)
