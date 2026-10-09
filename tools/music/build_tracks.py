"""
Build Scale's music from Arnd's Lyria 3 Pro tracks (full mixed pieces, not stems).

  python3 tools/music/build_tracks.py <source dir> [name ...]
  (the sources: /mnt/project-files/music/lyria in the project; needs numpy, librosa, soundfile, ffmpeg)

Three kinds of output (TRACKS below):

  stream  a piece played once (a calm episode, a cue): leading / trailing silence trimmed, an
          optional cut and fade, normalised to TARGET_LUFS, written as MP3 to
          public/music/tracks/<name>.mp3 (streamed by an audio element, nothing decoded up front)
  loop    a danger loop: a bar-true loop found inside the piece (the lag where the music lines up
          with itself best), its tail cross-faded over its head so it wraps seamlessly; Ogg Vorbis
          to public/music/tracks/<name>.ogg (decoded and looped sample-exact by the player)
  sound   a world sound (the busker's guitar, the boombox, the statue's fanfare): a loop or a cut,
          mono, written over the clip in public/sounds/ (its manifest entry stays)

public/music/tracks.json lists every stream and loop with its length (and the loop's length).
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public' / 'music' / 'tracks'
SOUNDS = ROOT / 'public' / 'sounds'
MANIFEST = ROOT / 'public' / 'music' / 'tracks.json'
SR = 44100
TARGET_LUFS = -16.0
SOUND_LUFS = -18.0

# name: (kind, source file, options)
#   cut: [from, to] seconds of the source; fade: fade-out seconds at the end; fadeIn: seconds
#   window: [from, to] where a loop may lie; length: [min, max] loop seconds; xf: crossfade seconds
#   lufs: a world sound's loudness (matching the clip it replaces)
TRACKS: dict[str, tuple[str, str, dict]] = {
    'day-1': ('stream', 'city-by-day-1.mp3', {}),
    'day-2': ('stream', 'city-by-day-2.mp3', {}),
    'night-1': ('stream', 'city-by-night-1.mp3', {}),
    'night-2': ('stream', 'city-by-night-2.mp3', {}),
    'under-1': ('stream', 'under-the-city-1.mp3', {}),
    'under-2': ('stream', 'under-the-city-2.mp3', {}),
    'hero-1': ('stream', 'skyline-flight-1.mp3', {}),
    'hero-2': ('stream', 'skyline-flight-2.mp3', {}),
    'elegy-1': ('stream', 'elegy-1.mp3', {}),
    'elegy-2': ('stream', 'elegy-2.mp3', {}),
    'country': ('stream', 'beyond-the-city.mp3', {}),
    'halls': ('stream', 'grand-halls.mp3', {}),
    'gameover': ('stream', 'game-over.mp3', {}),
    'rescue': ('stream', 'rescue.mp3', {}),
    # Lyria makes a minute at least: the sting is the first phrase (a dip at ~10 s).
    'victory': ('stream', 'victory.mp3', {'cut': [0, 10.3], 'fade': 1.6}),
    # Kept whole (the impact at 8.0 s lines up with the scene's, see Music.ORIGIN_AT).
    'origin': ('stream', 'origin-falling-star.mp3', {'keepHead': True}),
    'tension-1': ('loop', 'danger-close-1.mp3', {'window': [1, 117], 'length': [50, 80]}),
    'tension-2': ('loop', 'danger-close-2.mp3', {'window': [1, 120], 'length': [50, 80]}),
    # It builds: only its full-strength second half loops.
    'tension-high': ('loop', 'danger-close-high.mp3', {'window': [50, 116], 'length': [36, 58]}),
    'battle-1': ('loop', 'giant-battle-1.mp3', {'window': [28, 122], 'length': [50, 80]}),
    'battle-2': ('loop', 'giant-battle-2.mp3', {'window': [1, 122], 'length': [50, 80]}),
    'villain': ('loop', 'villain-rising.mp3', {'window': [1, 121], 'length': [50, 80]}),
    'slime': ('loop', 'slime-war.mp3', {'window': [1, 118], 'length': [50, 80]}),
    'street_guitar': ('sound', 'busker-guitar.mp3', {'loop': True, 'window': [3, 62], 'length': [24, 40], 'lufs': -20}),
    'street_beat': ('sound', 'boombox-beat.mp3', {'loop': True, 'window': [1, 64], 'length': [20, 32], 'lufs': -15}),
    'fanfare': ('sound', 'statue-fanfare.mp3', {'cut': [0, 10.4], 'fade': 1.6, 'lufs': -15}),
}


def load(path: Path) -> np.ndarray:
    y, _ = librosa.load(str(path), sr=SR, mono=False)
    return np.atleast_2d(y)


def lufs(y: np.ndarray) -> float:
    """Integrated loudness (ffmpeg's ebur128 on a temp file)."""
    tmp = OUT / '_lufs.wav'
    sf.write(tmp, y.T, SR)
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', str(tmp), '-af', 'ebur128', '-f', 'null', '-'], capture_output=True, text=True)
    tmp.unlink()
    for line in reversed(r.stderr.splitlines()):
        if line.strip().startswith('I:'):
            return float(line.split()[1])
    raise RuntimeError('no loudness')


def normalise(y: np.ndarray, target: float) -> np.ndarray:
    g = 10 ** ((target - lufs(y)) / 20)
    y = y * g
    peak = np.abs(y).max()
    # Soft ceiling instead of clipping (rare: the sources are mastered loud).
    return np.tanh(y / 0.98) * 0.98 if peak > 0.98 else y


def trim(y: np.ndarray, head: bool = True) -> np.ndarray:
    mono = np.abs(y).max(axis=0)
    on = np.where(mono > 10 ** (-50 / 20))[0]
    if not len(on):
        return y
    a = max(0, on[0] - int(0.02 * SR)) if head else 0
    b = min(y.shape[1], on[-1] + int(0.3 * SR))
    return y[:, a:b]


def fades(y: np.ndarray, fade_in: float = 0.0, fade_out: float = 0.0) -> np.ndarray:
    y = y.copy()
    if fade_in > 0:
        n = int(fade_in * SR)
        y[:, :n] *= np.linspace(0, 1, n) ** 2
    if fade_out > 0:
        n = int(fade_out * SR)
        y[:, -n:] *= np.cos(np.linspace(0, np.pi / 2, n)) ** 2
    return y


def find_loop(y: np.ndarray, window: list[float], length: list[float], xf: float) -> tuple[int, int, float]:
    """(start, length) in samples of the best loop: where the music after `length` lines up with itself."""
    mono = librosa.to_mono(y)
    hop = 256
    onset = librosa.onset.onset_strength(y=mono, sr=SR, hop_length=hop)
    chroma = librosa.feature.chroma_stft(y=mono, sr=SR, hop_length=hop)
    fps = SR / hop
    W = int(8 * fps)
    a0, a1 = int(window[0] * fps), int(window[1] * fps)
    lmin, lmax = int(length[0] * fps), int(length[1] * fps)
    best = (-1e9, 0, 0)
    # Starts: the strongest onsets near the window's start (a downbeat is likelier there).
    region = onset[a0:a0 + int(6 * fps)]
    starts = [a0 + int(i) for i in np.argsort(region)[-6:]]
    for s in starts:
        A = onset[s:s + W]
        C = chroma[:, s:s + W]
        if len(A) < W:
            continue
        A = (A - A.mean()) / (A.std() + 1e-9)
        for L in range(lmin, lmax + 1):
            if s + L + W + int(xf * fps) > a1:
                break
            B = onset[s + L:s + L + W]
            B = (B - B.mean()) / (B.std() + 1e-9)
            r = float(np.dot(A, B) / W)
            D = chroma[:, s + L:s + L + W]
            c = float(np.mean(np.sum(C * D, axis=0) / (np.linalg.norm(C, axis=0) * np.linalg.norm(D, axis=0) + 1e-9)))
            score = r + 0.8 * c
            if score > best[0]:
                best = (score, s, L)
    score, s, L = best
    if L == 0:
        raise RuntimeError('no loop found')
    # Refine the lag to the sample on the waveform's envelope (±1 hop).
    s_smp, L_smp = s * hop, L * hop
    env = np.abs(mono)
    n = int(4 * SR)
    ref = env[s_smp:s_smp + n]
    bestc, bestd = -1e9, 0
    for d in range(-hop, hop + 1, 4):
        seg = env[s_smp + L_smp + d:s_smp + L_smp + d + n]
        if len(seg) < n:
            continue
        c = float(np.dot(ref - ref.mean(), seg - seg.mean()))
        if c > bestc:
            bestc, bestd = c, d
    return s_smp, L_smp + bestd, score


def make_loop(y: np.ndarray, s: int, L: int, xf: float) -> np.ndarray:
    """The loop with its tail (after L) cross-faded over its head: wraps without a seam."""
    n = int(xf * SR)
    seg = y[:, s:s + L + n]
    out = seg[:, :L].copy()
    t = np.linspace(0, np.pi / 2, n)
    out[:, :n] = seg[:, :n] * np.sin(t) + seg[:, L:L + n] * np.cos(t)
    return out


def encode(y: np.ndarray, dest: Path, fmt: str) -> None:
    tmp = dest.with_suffix('.wav')
    sf.write(tmp, y.T, SR, subtype='PCM_16')
    if fmt == 'mp3':
        args = ['-c:a', 'libmp3lame', '-b:a', '128k']
    else:
        args = ['-c:a', 'libvorbis', '-q:a', '5' if y.shape[0] > 1 else '4']
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(tmp), *args, str(dest)], check=True)
    tmp.unlink()


def build(src_dir: Path, name: str, info: dict) -> None:
    kind, file, o = TRACKS[name]
    y = load(src_dir / file)
    if 'cut' in o:
        a, b = o['cut']
        y = y[:, int(a * SR):int(b * SR)]
    if kind == 'loop' or (kind == 'sound' and o.get('loop')):
        xf = o.get('xf', 1.5 if kind == 'loop' else 0.8)
        s, L, score = find_loop(y, o['window'], o['length'], xf)
        y = make_loop(y, s, L, xf)
        note = f'loop {L / SR:.3f} s from {s / SR:.2f} s (match {score:.2f})'
    else:
        y = trim(y, head=not o.get('keepHead'))
        y = fades(y, o.get('fadeIn', 0), o.get('fade', 0))
        note = f'{y.shape[1] / SR:.1f} s'
    if kind == 'sound':
        y = librosa.to_mono(y)[None, :]
        y = normalise(y, o.get('lufs', SOUND_LUFS))
        dest = SOUNDS / f'{name}.ogg'
        encode(y, dest, 'ogg')
        old = SOUNDS / f'{name}.wav'
        if old.exists():
            old.unlink()
        print(f'{name}: sound {note} -> {dest.relative_to(ROOT)}')
        return
    y = normalise(y, TARGET_LUFS)
    ext = 'mp3' if kind == 'stream' else 'ogg'
    dest = OUT / f'{name}.{ext}'
    encode(y, dest, ext)
    info[name] = {'file': f'tracks/{name}.{ext}', 'kind': kind, 'seconds': round(y.shape[1] / SR, 3)}
    print(f'{name}: {kind} {note} -> {dest.relative_to(ROOT)}')


def main() -> None:
    src = Path(sys.argv[1])
    names = sys.argv[2:] or list(TRACKS)
    OUT.mkdir(parents=True, exist_ok=True)
    info = json.loads(MANIFEST.read_text())['tracks'] if MANIFEST.exists() else {}
    for n in names:
        build(src, n, info)
    MANIFEST.write_text(json.dumps({'version': 1, 'tracks': dict(sorted(info.items()))}, indent=1) + '\n')


if __name__ == '__main__':
    main()
