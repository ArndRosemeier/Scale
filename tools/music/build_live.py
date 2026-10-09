"""
Build the live music: the stadium concert's songs and the street bands' pieces (Arnd's Lyria 3 Pro
tracks; prompts in the project files, music/concert-prompts.md).

  python3 tools/music/build_live.py <source dir> [name ...]
  python3 tools/music/build_live.py --placeholders      (stand-ins from the score until the songs come)

  song   a concert song (concert-1.mp3 …): silence trimmed, normalised, MP3 to public/music/live/;
         its tempo and first beat are measured (the lights and the crowd keep its beat)
  band   a street band's piece (band-folk.mp3 …): a bar-true loop found inside it (as the score's
         danger loops, build_tracks.find_loop), MP3 to public/music/live/

public/music/live.json lists the act, the songs in the set (title, file, length, bpm, first beat,
opener / closer) and the bands' files by style. A song or band whose source is missing keeps its
entry (a placeholder stays until the real one is built).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import librosa
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_tracks import SR, TARGET_LUFS, ROOT, load, trim, fades, normalise, encode, find_loop, make_loop  # noqa: E402

OUT = ROOT / 'public' / 'music' / 'live'
MANIFEST = ROOT / 'public' / 'music' / 'live.json'
ACT = 'VELA'

# id: (title, source, tempo asked for in the prompt, options)
SONGS: dict[str, tuple[str, str, float, dict]] = {
    'concert-1': ('City of Lights', 'concert-1.mp3', 126, {'opener': True}),
    'concert-2': ('Neon Heartbeat', 'concert-2.mp3', 118, {}),
    'concert-3': ('Paper Wings', 'concert-3.mp3', 94, {}),
    'concert-4': ('Hold On to the Night', 'concert-4.mp3', 70, {}),
    'concert-5': ('Gravity', 'concert-5.mp3', 140, {}),
    'concert-6': ('Rise', 'concert-6.mp3', 124, {'closer': True}),
}
BANDS: dict[str, str] = {'folk': 'band-folk.mp3', 'bossa': 'band-bossa.mp3', 'swing': 'band-swing.mp3'}

# Until Arnd's songs are made: pieces of the score stand in (no vocals, the right energy).
PLACEHOLDERS: dict[str, str] = {
    'concert-1': 'hero-1', 'concert-2': 'day-1', 'concert-3': 'night-2', 'concert-6': 'hero-2',
}


def beat_of(y: np.ndarray, hint: float = 0) -> tuple[float, float]:
    """(bpm, time of the first beat in s) of a piece (`hint`: the tempo the prompt asked for, to
    tell a ballad from its double time)."""
    mono = librosa.to_mono(y) if y.ndim > 1 else y
    tempo, beats = librosa.beat.beat_track(y=mono, sr=SR, units='time')
    bpm = float(np.atleast_1d(tempo)[0])
    if hint and (bpm > hint * 1.5 or bpm < hint / 1.5):
        tempo, beats = librosa.beat.beat_track(y=mono, sr=SR, units='time', start_bpm=hint)
        bpm = float(np.atleast_1d(tempo)[0])
    # Lyria's tempos are steady: fit the grid to all the beats found (a better phase than the first one).
    if len(beats) > 8:
        period = 60 / bpm
        phase = float(np.median(np.mod(beats, period)))
        return round(bpm, 2), round(phase, 3)
    return round(bpm, 2), round(float(beats[0]) if len(beats) else 0.0, 3)


def read() -> dict:
    if MANIFEST.exists():
        return json.loads(MANIFEST.read_text())
    return {'act': ACT, 'songs': [], 'bands': {}}


def write(m: dict) -> None:
    order = list(SONGS)
    m['songs'] = sorted(m['songs'], key=lambda s: order.index(s['id']) if s['id'] in order else 99)
    m['act'] = ACT
    MANIFEST.write_text(json.dumps(m, indent=1) + '\n')


def put_song(m: dict, entry: dict) -> None:
    m['songs'] = [s for s in m['songs'] if s['id'] != entry['id']] + [entry]


def song(src: Path, sid: str, m: dict) -> None:
    title, file, hint, o = SONGS[sid]
    path = src / file
    if not path.exists():
        print(f'{sid}: no {file}, kept as it was')
        return
    y = fades(trim(load(path)), 0, 0.4)
    y = normalise(y, TARGET_LUFS)
    OUT.mkdir(parents=True, exist_ok=True)
    dest = OUT / f'{sid}.mp3'
    encode(y, dest, 'mp3')
    bpm, beat0 = beat_of(y, hint)
    put_song(m, {'id': sid, 'title': title, 'file': f'music/live/{sid}.mp3', 'seconds': round(y.shape[1] / SR, 3), 'bpm': bpm, 'beat0': beat0, **o})
    print(f'{sid}: {y.shape[1] / SR:.1f} s, {bpm} bpm -> {dest.relative_to(ROOT)}')


def band(src: Path, style: str, m: dict) -> None:
    path = src / BANDS[style]
    if not path.exists():
        print(f'band-{style}: no {BANDS[style]}, kept as it was')
        return
    y = load(path)
    dur = y.shape[1] / SR
    s, L, score = find_loop(y, [1, dur - 2], [min(40, dur * 0.5), min(80, dur - 6)], 0.8)
    y = normalise(make_loop(y, s, L, 0.8), -18)
    OUT.mkdir(parents=True, exist_ok=True)
    dest = OUT / f'band-{style}.mp3'
    encode(y, dest, 'mp3')
    m['bands'][style] = f'music/live/band-{style}.mp3'
    print(f'band-{style}: loop {L / SR:.1f} s (match {score:.2f}) -> {dest.relative_to(ROOT)}')


def placeholders(m: dict) -> None:
    for sid, track in PLACEHOLDERS.items():
        if any(s['id'] == sid and s['file'].startswith('music/live/') for s in m['songs']):
            continue
        title, _, _, o = SONGS[sid]
        f = ROOT / 'public' / 'music' / 'tracks' / f'{track}.mp3'
        y = load(f)
        bpm, beat0 = beat_of(y)
        put_song(m, {'id': sid, 'title': title, 'file': f'music/tracks/{track}.mp3', 'seconds': round(y.shape[1] / SR, 3), 'bpm': bpm, 'beat0': beat0, 'placeholder': True, **o})
        print(f'{sid}: placeholder {track} ({bpm} bpm)')


def main() -> None:
    m = read()
    if sys.argv[1:2] == ['--placeholders']:
        placeholders(m)
        write(m)
        return
    src = Path(sys.argv[1])
    names = sys.argv[2:] or [*SONGS, *(f'band-{b}' for b in BANDS)]
    for n in names:
        if n in SONGS:
            song(src, n, m)
        elif n.startswith('band-') and n[5:] in BANDS:
            band(src, n[5:], m)
        else:
            print(f'{n}: unknown')
    write(m)


if __name__ == '__main__':
    main()
