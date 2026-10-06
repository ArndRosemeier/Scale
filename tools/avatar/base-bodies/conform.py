"""Reshape the MakeHuman human mesh onto the Woman / Man base bodies.

Writes public/assets/human/conform.{json,bin}:
  * female / male: per morph-vertex offsets (int16) that turn MakeHuman's average woman
    (gender 0) and man (gender 1) into our Woman and Man. The runtime adds them after the
    macro morph, blended by gender, so age, weight, muscle, height, races, clothes, LODs
    and expressions keep working on the same topology.
  * skinIdx / skinW: skin weights taken from the Woman's rig (her bones folded into
    MakeHuman's), replacing MakeHuman's own.

Steps per body: mirror + scale the target to MakeHuman's frame and height, warp
MakeHuman's hands and feet onto the target's joints, then non-rigid ICP (closest points
with a Laplacian displacement regulariser, stiffness decreasing). Eyes, teeth, tongue,
lashes and the virtual joint vertices follow the fitted skin.

Usage (numpy + scipy):
  npx tsx tools/avatar/base-bodies/mh-dump.ts /tmp/mh
  python tools/avatar/base-bodies/conform.py /tmp/mh [--obj outdir]
"""
import json
import os
import sys

import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spl
from scipy.spatial import cKDTree

sys.path.insert(0, os.path.dirname(__file__))
from glb import Glb, world_matrices  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
BODIES = os.path.join(ROOT, 'public/assets/bodies')
OUT = os.path.join(ROOT, 'public/assets/human')


# ------------------------------------------------------------------ inputs

def load_mh(d):
    meta = json.load(open(os.path.join(d, 'mh_meta.json')))
    rd = lambda n, t: np.fromfile(os.path.join(d, n), t)
    mh = dict(
        meta=meta,
        F=rd('mh_female.f32', np.float32).reshape(-1, 3).astype(np.float64),
        M=rd('mh_male.f32', np.float32).reshape(-1, 3).astype(np.float64),
        tris=rd('mh_tris.u32', np.uint32).reshape(-1, 3).astype(np.int64),
        sidx=rd('mh_skinidx.u8', np.uint8).reshape(-1, 4).astype(np.int64),
        sw=rd('mh_skinw.u8', np.uint8).reshape(-1, 4) / 255.0,
    )
    mh['bones'] = meta['bones']
    mh['bn'] = {b['name']: i for i, b in enumerate(meta['bones'])}
    mh['NB'] = meta['groups']['tongue'][0]
    return mh


def load_target(path):
    g = Glb(path)
    j = g.json
    W, parent = world_matrices(j)
    joints = j['skins'][0]['joints']
    names = [j['nodes'][i]['name'] for i in joints]
    head = np.array([W[i][:3, 3] for i in joints])
    prims = []
    for node in j['nodes']:
        if 'mesh' not in node:
            continue
        for prim in j['meshes'][node['mesh']]['primitives']:
            at = prim['attributes']
            prims.append(dict(P=g.read(at['POSITION']).astype(np.float64), J=g.read(at['JOINTS_0']).astype(np.int64),
                              W=g.read(at['WEIGHTS_0']).astype(np.float64), idx=g.read(prim['indices']).ravel().astype(np.int64)))
    body = max(prims, key=lambda p: len(p['P']))
    eyes = [p for p in prims if p is not body]
    return dict(names=names, head=head, body=body, eyes=eyes)


def to_mh_frame(t, mhP, NB):
    """glTF (+Z front, +X left) → MakeHuman (−Z front, −X left), MakeHuman's height and floor."""
    flip = np.array([-1.0, 1, -1])
    B = mhP[:NB]
    P = t['body']['P'] * flip
    k = (B[:, 1].max() - B[:, 1].min()) / (P[:, 1].max() - P[:, 1].min())
    y0 = P[:, 1].min()
    tf = lambda X: (X * flip - [0, y0, 0]) * k + [0, B[:, 1].min(), 0]
    for p in [t['body']] + t['eyes']:
        p['P'] = tf(p['P'])
    t['head'] = tf(t['head'])
    # Depth: centre the torsos on each other.
    sel = (np.abs(B[:, 0]) < 0.14) & (B[:, 1] > -0.05) & (B[:, 1] < 0.45)
    TP = t['body']['P']
    sel2 = (np.abs(TP[:, 0]) < 0.14) & (TP[:, 1] > -0.05) & (TP[:, 1] < 0.45)
    dz = B[sel, 2].mean() - TP[sel2, 2].mean()
    for p in [t['body']] + t['eyes']:
        p['P'][:, 2] += dz
    t['head'][:, 2] += dz


# ------------------------------------------------------------------ geometry helpers

def vnormals(P, T):
    n = np.zeros_like(P)
    f = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
    for k in range(3):
        np.add.at(n, T[:, k], f)
    return n / (np.linalg.norm(n, axis=1, keepdims=True) + 1e-12)


class Surface:
    """Dense random samples of a triangle mesh (point, face normal, triangle, barycentrics)."""

    def __init__(self, P, T, n=1500000):
        a, b, c = P[T[:, 0]], P[T[:, 1]], P[T[:, 2]]
        fn = np.cross(b - a, c - a)
        area = np.linalg.norm(fn, axis=1) / 2
        fn /= (2 * area[:, None] + 1e-12)
        rng = np.random.default_rng(1)
        ti = rng.choice(len(T), n, p=area / area.sum())
        u, v = rng.random(n), rng.random(n)
        m = u + v > 1
        u[m], v[m] = 1 - u[m], 1 - v[m]
        self.S = a[ti] + (b[ti] - a[ti]) * u[:, None] + (c[ti] - a[ti]) * v[:, None]
        self.N = fn[ti]
        self.tri = ti
        self.bary = np.stack([1 - u - v, u, v], 1)
        self.tree = cKDTree(self.S)

    def closest(self, X, N, k=12, cos=0.4):
        d, j = self.tree.query(X, k=k)
        ok = (self.N[j] * N[:, None, :]).sum(2) > cos
        first = np.where(ok.any(1), ok.argmax(1), 0)
        r = np.arange(len(X))
        return j[r, first], d[r, first], ok.any(1)


def edges_of(T):
    E = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    return np.unique(np.sort(E, 1), axis=0)


def graph_laplacian(n, E):
    A = sp.coo_matrix((np.ones(len(E)), (E[:, 0], E[:, 1])), shape=(n, n))
    A = A + A.T
    return (sp.diags(np.asarray(A.sum(1)).ravel()) - A).tocsc()


# ------------------------------------------------------------------ hand / foot pre-warp

FING = {'1': 'thumb', '2': 'f_index', '3': 'f_middle', '4': 'f_ring', '5': 'f_pinky'}


def _frame(a, b):
    a = a / np.linalg.norm(a)
    b = b - b.dot(a) * a
    b /= np.linalg.norm(b)
    return np.stack([a, b, np.cross(a, b)], 1)


def _rot(a, b):
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    c = a.dot(b)
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3)
    K = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + K + K @ K / (1 + c)


def _seg_map(dm, dt):
    R = _rot(dm, dt)
    a = dt / np.linalg.norm(dt)
    return R + (np.linalg.norm(dt) / np.linalg.norm(dm) - 1) * np.outer(a, a) @ R


def prewarp(mh, P, t):
    """LBS-warp MakeHuman's hands and feet so their joints sit on the target's."""
    bones, bn = mh['bones'], mh['bn']
    H = np.array([P[b['head']] for b in bones])
    th = dict(zip(t['names'], t['head']))
    Ms = np.tile(np.eye(3), (len(bones), 1, 1))
    src, dst = H.copy(), H.copy()
    for s, S in (('L', 'Left'), ('R', 'Right')):
        w = bn[f'wrist.{s}']
        Fm = _frame(H[bn[f'finger3-1.{s}']] - H[w], H[bn[f'finger2-1.{s}']] - H[bn[f'finger5-1.{s}']])
        Ft = _frame(th[f'DEF-f_middle.01.{s}'] - th[f'{S}Hand'], th[f'DEF-f_index.01.{s}'] - th[f'DEF-f_pinky.01.{s}'])
        sc = np.linalg.norm(th[f'DEF-f_middle.01.{s}'] - th[f'{S}Hand']) / np.linalg.norm(H[bn[f'finger3-1.{s}']] - H[w])
        Ms[w] = sc * Ft @ Fm.T
        dst[w] = th[f'{S}Hand']
        for f, tn in FING.items():
            for k in (1, 2, 3):
                b = bn[f'finger{f}-{k}.{s}']
                if k < 3:
                    M = _seg_map(H[bn[f'finger{f}-{k + 1}.{s}']] - H[b], th[f'DEF-{tn}.0{k + 1}.{s}'] - th[f'DEF-{tn}.0{k}.{s}'])
                Ms[b] = M
                dst[b] = th[f'DEF-{tn}.0{k}.{s}']
        f, to = bn[f'foot.{s}'], bn[f'toes.{s}']
        M = _seg_map(H[to] - H[f], th[f'{S}Toes'] - th[f'{S}Foot'])
        Ms[f] = Ms[to] = M
        dst[f] = dst[to] = th[f'{S}Foot']
        src[to] = H[f]
    R = len(mh['sidx'])
    acc = np.zeros((R, 3))
    for k in range(4):
        b = mh['sidx'][:, k]
        acc += mh['sw'][:, k][:, None] * (np.einsum('nij,nj->ni', Ms[b], P[:R] - src[b]) + dst[b])
    tot = mh['sw'].sum(1)[:, None]
    out = P.copy()
    out[:R] = np.where(tot > 0, acc / np.maximum(tot, 1e-9), P[:R])
    return out


# ------------------------------------------------------------------ registration

def register(mh, P, t, surf):
    NB = mh['NB']
    T = mh['body_tris']
    P0 = prewarp(mh, P, t)[:NB]
    X = P0.copy()
    for alpha, iters in ((50, 4), (20, 4), (8, 4), (3, 4), (1, 5), (0.4, 5)):
        A0 = alpha * mh['L']
        for _ in range(iters):
            jj, dd, ok = surf.closest(X, vnormals(X, T))
            w = (ok & (dd < 0.06)).astype(float)
            W = sp.diags(w)
            solve = spl.factorized((W + A0).tocsc())
            rhs = W @ surf.S[jj] + A0 @ P0
            X = np.stack([solve(rhs[:, c]) for c in range(3)], 1)
        d, _ = surf.tree.query(X)
        print(f'  stiffness {alpha:>4}: mean {d.mean() * 1000:.2f} mm, p95 {np.percentile(d, 95) * 1000:.2f} mm')
    return X


def full_offsets(mh, P, X, t):
    """Offsets for every morph vertex: fitted skin, eyes, mouth parts, lashes, joints."""
    meta, NB = mh['meta'], mh['NB']
    N = meta['morphVerts']
    off = np.zeros((N, 3))
    off[:NB] = X - P[:NB]
    B = P[:NB]
    tree = cKDTree(B)
    # Eyes: x/y from the target's eye, depth from the front of the eye (its eye mesh is a lens).
    E = t['eyes'][0]['P'] if t['eyes'] else None
    for g, sgn in (('eyeL', -1), ('eyeR', 1)):
        s, n = meta['groups'][g]
        G = P[s:s + n]
        c = G.mean(0)
        r = np.linalg.norm(G - c, axis=1).mean()
        ring = np.linalg.norm(B - c, axis=1) < r * 1.8
        o = off[:NB][ring].mean(0)
        if E is not None:
            Te = E[np.sign(E[:, 0]) == sgn]
            tc = (Te.min(0) + Te.max(0)) / 2
            o = np.array([tc[0] - c[0], tc[1] - c[1], Te[:, 2].min() - G[:, 2].min()])
        off[s:s + n] = o
    for g in ('tongue', 'teeth'):
        s, n = meta['groups'][g]
        c = P[s:s + n].mean(0)
        near = np.linalg.norm(B - c, axis=1) < 0.035
        off[s:s + n] = off[:NB][near].mean(0)
    s, n = meta['groups']['lashes']
    _, j = tree.query(P[s:s + n])
    off[s:s + n] = off[j]
    # Virtual joint vertices: Gaussian-weighted mean offset of the nearest skin.
    R = meta['realVerts']
    d, j = tree.query(P[R:N], k=40)
    sig = d[:, 19:20] + 1e-6
    w = np.exp(-(d / sig) ** 2)
    off[R:N] = (w[..., None] * off[j]).sum(1) / w.sum(1, keepdims=True)
    return off


# ------------------------------------------------------------------ skin weights

def mh_segments(mh):
    """MakeHuman bone → segment name."""
    seg = {}
    for i, b in enumerate(mh['bones']):
        n = b['name']
        base, _, s = n.partition('.')
        if base in ('root', 'spine01', 'spine02', 'spine03', 'spine04', 'spine05', 'pelvis'):
            g = 'torso'
        elif base.startswith('neck'):
            g = 'neck'
        elif base in ('head', 'jaw'):
            g = 'head'
        elif base in ('clavicle', 'shoulder01'):
            g = 'shoulder'
        elif base.startswith('upperarm'):
            g = 'upperarm'
        elif base.startswith('lowerarm'):
            g = 'forearm'
        elif base == 'wrist':
            g = 'hand'
        elif base.startswith('finger'):
            g = base
        elif base.startswith('upperleg'):
            g = 'thigh'
        elif base.startswith('lowerleg'):
            g = 'shin'
        else:
            g = base  # foot, toes
        seg[i] = g + ('.' + s if s else '')
    return seg


def target_segments(name):
    """Woman rig bone → [(segment, share)] (anatomical: what the bone's skin moves with)."""
    s = 'L' if name.endswith('.L') or name.startswith('Left') else 'R' if name.endswith('.R') or name.startswith('Right') else ''
    sd = lambda g: g + '.' + s
    base = name.replace('DEF-', '').replace('Left', '').replace('Right', '').split('.')[0]
    if name.startswith('DEF-f_') or name.startswith('DEF-thumb'):
        f = {'thumb': '1', 'f_index': '2', 'f_middle': '3', 'f_ring': '4', 'f_pinky': '5'}[name[4:].split('.')[0]]
        return [(sd(f'finger{f}-{int(name.split(".")[1])}'), 1)]
    table = {
        'Hips': 'torso', 'Spine': 'torso', 'Chest': 'torso', 'chest-1': 'torso', 'spine-1': 'torso', 'stomach': 'torso',
        'pectoralis': 'torso', 'breast': 'torso', 'trapezius2': 'torso', 'gluteus': 'torso',
        'Neck': 'neck', 'platysma': 'neck', 'trapezius1': 'neck',
        'Head': 'head', 'jaw': 'head', 'uplid': 'head', 'lolid': 'head', 'eye': 'head',
        'Shoulder': 'shoulder*', 'scapula': 'shoulder*', 'deltoid': 'upperarm*', 'UpperArm': 'upperarm*',
        'LowerArm': 'forearm*', 'forearm': 'forearm*', 'Hand': 'hand*', 'palm_index': 'hand*', 'palm_middle': 'hand*',
        'palm_ring': 'hand*', 'palm_pinky': 'hand*',
        'UpperLeg': 'thigh*', 'femoris': 'thigh*', 'quadriceps': 'thigh*',
        'LowerLeg': 'shin*', 'shin': 'shin*', 'soleus': 'shin*', 'Foot': 'foot*', 'Toes': 'toes*',
    }
    if base == 'lat_dorsi':
        return [('torso', 0.5), (sd('upperarm'), 0.5)]
    g = table[base]
    return [(sd(g[:-1]) if g.endswith('*') else g, 1)]


def transfer_weights(mh, X, t):
    """Woman's skin weights → MakeHuman body vertices (fitted positions X), in MakeHuman bones."""
    NB = mh['NB']
    segof = mh_segments(mh)
    segs = sorted(set(segof.values()))
    si = {g: i for i, g in enumerate(segs)}
    # Per target vertex segment weights.
    body = t['body']
    Wt = body['W'] / body['W'].sum(1, keepdims=True)
    tseg = np.zeros((len(body['P']), len(segs)))
    share = [target_segments(n) for n in t['names']]
    for k in range(4):
        for b in np.unique(body['J'][:, k]):
            m = body['J'][:, k] == b
            for g, f in share[b]:
                tseg[m, si[g]] += Wt[m, k] * f
    surf = Surface(body['P'], body['idx'].reshape(-1, 3))
    jj, _, _ = surf.closest(X, vnormals(X, mh['body_tris']))
    tri = body['idx'].reshape(-1, 3)[surf.tri[jj]]
    vseg = (surf.bary[jj][..., None] * tseg[tri]).sum(1)  # (NB, nseg)
    # Segment → MakeHuman bones: MakeHuman's own split inside the segment, else the closest bone.
    bones = mh['bones']
    P = mh['F']
    H = np.array([P[b['head']] for b in bones])
    Tl = np.array([P[b['tail']] for b in bones])
    seg_bones = {g: [i for i in range(len(bones)) if segof[i] == g] for g in segs}
    own = np.zeros((NB, len(bones)))
    for k in range(4):
        np.add.at(own, (np.arange(NB), mh['sidx'][:NB, k]), mh['sw'][:NB, k])

    def seg_dist(v, i):
        a, b = H[i], Tl[i]
        u = np.clip(((P[v] - a) @ (b - a)) / max((b - a) @ (b - a), 1e-12), 0, 1)
        return np.linalg.norm(P[v] - (a + u[:, None] * (b - a)), axis=1)
    out = np.zeros((NB, len(bones)))
    for g, gi in si.items():
        v = np.nonzero(vseg[:, gi] > 1e-4)[0]
        if not len(v):
            continue
        bs = seg_bones[g]
        o = own[np.ix_(v, bs)]
        tot = o.sum(1, keepdims=True)
        if len(bs) > 1:
            dist = np.stack([seg_dist(v, i) for i in bs], 1)
            closest = (dist == dist.min(1, keepdims=True)).astype(float)
            split = np.where(tot > 0.05, o / np.maximum(tot, 1e-9), closest / closest.sum(1, keepdims=True))
        else:
            split = np.ones((len(v), 1))
        out[np.ix_(v, bs)] += vseg[v, gi][:, None] * split
    # Top 4, normalised, u8 summing to 255.
    idx = np.argsort(-out, 1)[:, :4]
    w = np.take_along_axis(out, idx, 1)
    w /= w.sum(1, keepdims=True)
    q = np.floor(w * 255 + 0.5).astype(int)
    q[:, 0] += 255 - q.sum(1)
    idx[q == 0] = 0
    sidx = mh['sidx'].copy()
    swq = np.round(mh['sw'] * 255).astype(int)
    sidx[:NB], swq[:NB] = idx, q
    return sidx.astype(np.uint8), swq.astype(np.uint8)


# ------------------------------------------------------------------ main

def write_obj(path, P, T):
    with open(path, 'w') as f:
        for p in P:
            f.write(f'v {-p[0]:.5f} {p[1]:.5f} {-p[2]:.5f}\n')
        for t3 in T + 1:
            f.write(f'f {t3[0]} {t3[1]} {t3[2]}\n')


def main(mhdir, objdir=None):
    mh = load_mh(mhdir)
    NB = mh['NB']
    mh['body_tris'] = mh['tris'][(mh['tris'] < NB).all(1)]
    mh['L'] = graph_laplacian(NB, edges_of(mh['body_tris']))
    offs, fits = {}, {}
    for name, P in (('woman', mh['F']), ('man', mh['M'])):
        print(name)
        t = load_target(os.path.join(BODIES, name + '.glb'))
        to_mh_frame(t, P, NB)
        surf = Surface(t['body']['P'], t['body']['idx'].reshape(-1, 3))
        X = register(mh, P, t, surf)
        offs[name] = full_offsets(mh, P, X, t)
        fits[name] = (X, t)
        if objdir:
            write_obj(os.path.join(objdir, f'fit_{name}.obj'), X, mh['body_tris'])
            write_obj(os.path.join(objdir, f'mh_{name}.obj'), P[:NB], mh['body_tris'])
            write_obj(os.path.join(objdir, f'tgt_{name}.obj'), t['body']['P'], t['body']['idx'].reshape(-1, 3))
            np.save(os.path.join(objdir, f'off_{name}.npy'), offs[name])
    sidx, sw = transfer_weights(mh, *fits['woman'])
    scale = max(np.abs(offs['woman']).max(), np.abs(offs['man']).max()) / 32000
    parts = [('female', np.round(offs['woman'] / scale).astype(np.int16)), ('male', np.round(offs['man'] / scale).astype(np.int16)),
             ('skinIdx', sidx.ravel()), ('skinW', sw.ravel())]
    blob, sections = b'', {}
    for n, a in parts:
        blob += b'\0' * ((-len(blob)) % 4)
        sections[n] = {'offset': len(blob), 'length': int(a.size), 'type': {np.dtype(np.int16): 'i16', np.dtype(np.uint8): 'u8'}[a.dtype]}
        blob += a.tobytes()
    open(os.path.join(OUT, 'conform.bin'), 'wb').write(blob)
    json.dump({
        'version': 1, 'file': 'conform.bin', 'bytes': len(blob),
        'note': 'MakeHuman mesh reshaped onto the Woman/Man base bodies (tools/avatar/base-bodies/conform.py)',
        'morphVerts': mh['meta']['morphVerts'], 'realVerts': mh['meta']['realVerts'],
        'offsetScale': scale, 'sections': sections,
    }, open(os.path.join(OUT, 'conform.json'), 'w'), indent=1)
    print(f'conform.bin: {len(blob)} bytes, offset scale {scale:.3g} m, max offset {scale * 32000 * 100:.1f} cm')


if __name__ == '__main__':
    a = sys.argv[1:]
    main(a[0], a[a.index('--obj') + 1] if '--obj' in a else None)
