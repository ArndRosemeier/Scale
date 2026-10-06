"""
Derive the male base body from the female one (same mesh topology, UVs and skeleton):
    python3 tools/avatar/base-bodies/make_male.py woman.glb man.glb

The female body is reshaped bone by bone. Every bone gets a scale in its own frame
(width / depth across the bone, length along it); a vertex moves with the blend of its
bones' transforms (the same weights that skin it), and every bone's head moves with its
parent's transform, so skeleton and skin stay in agreement. Joint rotations are left as
they are, so the game's retargeting treats both bodies the same. Local sculpts (chest,
crotch, brow, Adam's apple) are applied on top, then the whole body is scaled to height.
"""
import sys

import numpy as np

from glb import Glb, world_matrices

# Bone scales: (across-1, across-2, along). For upright bones across-1 is the body's width
# (x) and across-2 its depth; for sideways bones (arms) across-1 is up/down.
L = lambda n: [n.replace('*', 'Left'), n.replace('*', 'Right')] if '*' in n else [n.replace('#', 'L'), n.replace('#', 'R')]
SCALES = {
    'Hips': (1.0, 1.0, 1.0),
    'DEF-gluteus.#': (0.85, 0.80, 0.80),
    'Spine': (1.0, 1.04, 1.03),
    'DEF-spine-1': (1.0, 1.04, 1.03),
    'Chest': (1.04, 1.06, 1.04),
    'DEF-chest-1': (1.04, 1.06, 1.04),
    'DEF-stomach': (1.06, 0.96, 1.0),
    'DEF-pectoralis.#': (1.15, 1.15, 1.15),
    'breast.#': (0.80, 0.80, 0.32),
    '*Shoulder': (1.15, 1.15, 1.30),
    'DEF-deltoid.#': (1.18, 1.18, 1.12),
    'DEF-scapula.#': (1.12, 1.12, 1.12),
    'DEF-trapezius1.#': (1.2, 1.2, 1.1),
    'DEF-trapezius2.#': (1.15, 1.15, 1.1),
    'DEF-lat_dorsi.#': (1.15, 1.15, 1.1),
    '*UpperArm': (1.2, 1.2, 1.03),
    '*LowerArm': (1.16, 1.16, 1.03),
    'DEF-forearm.02.#': (1.12, 1.12, 1.03),
    'DEF-forearm.03.#': (1.10, 1.10, 1.03),
    '*Hand': (1.10, 1.10, 1.10),
    'Neck': (1.24, 1.16, 0.88),
    'DEF-platysma.#': (1.2, 1.2, 1.0),
    'Head': (1.04, 1.03, 1.03),
    'DEF-jaw': (1.14, 1.06, 1.02),
    '*UpperLeg': (1.03, 1.03, 1.02),
    'DEF-quadriceps.#': (1.06, 1.06, 1.02),
    'DEF-femoris.#': (1.03, 1.03, 1.02),
    '*LowerLeg': (1.06, 1.06, 1.02),
    'shin.#': (1.06, 1.06, 1.02),
    'DEF-soleus.#': (1.08, 1.08, 1.02),
    'DEF-shin.02.#': (1.05, 1.05, 1.02),
    'DEF-shin.03.#': (1.05, 1.05, 1.02),
    '*Foot': (1.07, 1.07, 1.06),
    '*Toes': (1.07, 1.07, 1.06),
}
FINGERS = (1.10, 1.10, 1.06)
# Torso width by height (m, factor): broader waist, narrower pelvis; arms are left out.
WIDTH = [(0.50, 1.0), (0.72, 0.97), (0.90, 0.89), (0.98, 0.92), (1.06, 1.02), (1.14, 1.11), (1.24, 1.09), (1.38, 1.0)]
ARM = ('Arm', 'Hand', 'forearm', 'f_', 'thumb', 'palm')
HEIGHT = 1.80


def expand(table):
    out = {}
    for k, v in table.items():
        for n in (L(k) if ('*' in k or '#' in k) else [k]):
            out[n] = v
    return out


def main(src, dst):
    g = Glb(src)
    j = g.json
    W, parent = world_matrices(j)
    skin = j['skins'][0]
    joints = skin['joints']
    names = [j['nodes'][i]['name'] for i in joints]
    scales = expand(SCALES)
    nb = len(joints)
    jindex = {n: k for k, n in enumerate(joints)}

    head = np.array([W[i][:3, 3] for i in joints])
    M = np.zeros((nb, 3, 3))
    for k, i in enumerate(joints):
        a = W[i][:3, 1] / np.linalg.norm(W[i][:3, 1])  # bones point along their local +Y
        ref = np.array([1.0, 0, 0]) if abs(a[0]) < 0.7 else np.array([0, 1.0, 0])
        u = ref - ref.dot(a) * a
        u /= np.linalg.norm(u)
        v = np.cross(a, u)
        B = np.stack([u, v, a], 1)
        s = scales.get(names[k], FINGERS if ('f_' in names[k] or 'thumb' in names[k] or 'palm' in names[k]) else (1, 1, 1))
        M[k] = B @ np.diag(s) @ B.T

    # New heads: each bone's head follows its parent's transform (parents come first? not
    # guaranteed in glTF: walk recursively).
    newhead = np.zeros_like(head)
    done = [False] * nb

    def place(k):
        if done[k]:
            return
        p = parent.get(joints[k])
        if p in jindex:
            pk = jindex[p]
            place(pk)
            newhead[k] = newhead[pk] + M[pk] @ (head[k] - head[pk])
        else:
            newhead[k] = head[k]
        done[k] = True
    for k in range(nb):
        place(k)

    for kk, n in enumerate(names):
        if not any(a in n for a in ARM):
            newhead[kk, 0] *= width(newhead[kk, 1])
    meshes = []
    for mi, node in [(n['mesh'], n) for n in j['nodes'] if 'mesh' in n]:
        for prim in j['meshes'][mi]['primitives']:
            at = prim['attributes']
            P = g.read(at['POSITION']).astype(np.float64)
            N = g.read(at['NORMAL']).astype(np.float64)
            J = g.read(at['JOINTS_0']).astype(int)
            Wt = g.read(at['WEIGHTS_0']).astype(np.float64)
            Wt /= Wt.sum(1, keepdims=True)
            # Skin joint indices are already indices into skin.joints.
            Ms = M[J]                                   # (n,4,3,3)
            d = P[:, None, :] - head[J]                 # (n,4,3)
            moved = newhead[J] + np.einsum('nkij,nkj->nki', Ms, d)
            P2 = (Wt[..., None] * moved).sum(1)
            Minv_t = np.linalg.inv(Ms).transpose(0, 1, 3, 2)
            N2 = (Wt[..., None] * np.einsum('nkij,nkj->nki', Minv_t, N[:, None, :].repeat(4, 1))).sum(1)
            arm = np.array([any(a in n for a in ARM) for n in names])
            mask = 1 - (Wt * arm[J]).sum(1)
            P2[:, 0] *= 1 + (width(P2[:, 1]) - 1) * mask
            # Flatter seat: pull the back of the pelvis forward.
            zc = -0.06
            sb = 1 + (np.interp(P2[:, 1], [0.78, 0.92, 1.0, 1.12], [1.0, 0.80, 0.85, 1.0]) - 1) * mask * np.clip((zc - P2[:, 2]) / 0.03, 0, 1)
            P2[:, 2] = zc + (P2[:, 2] - zc) * np.where(P2[:, 2] < zc, sb, 1)
            N2[:, 0] /= 1 + (width(P2[:, 1]) - 1) * mask
            meshes.append(dict(prim=prim, P=P2, N=N2, P0=P, name=j['meshes'][mi]['name'], idx=g.read(prim['indices']).ravel()))

    body = max(meshes, key=lambda m: len(m['P']))
    sculpt(body, names, head, newhead)

    # Height: scale everything about the floor point under the hips.
    allP = np.concatenate([m['P'] for m in meshes])
    ymin, ymax = allP[:, 1].min(), allP[:, 1].max()
    k = HEIGHT / (ymax - ymin)
    org = np.array([0, ymin, 0])
    for m in meshes:
        m['P'] = org * 0 + (m['P'] - org) * k
        g.write(m['prim']['attributes']['POSITION'], m['P'].astype(np.float32))
        n = m['N'] / np.linalg.norm(m['N'], axis=1, keepdims=True)
        g.write(m['prim']['attributes']['NORMAL'], n.astype(np.float32))
    newhead = (newhead - org) * k

    # Skeleton: keep every joint's rotation, move its translation; new inverse binds.
    Wn = {}
    for kk, i in enumerate(joints):
        m4 = W[i].copy()
        m4[:3, 3] = newhead[kk]
        Wn[i] = m4
    for kk, i in enumerate(joints):
        p = parent.get(i)
        pw = Wn[p] if p in Wn else W[p] if p is not None else np.eye(4)
        loc = np.linalg.inv(pw) @ Wn[i]
        j['nodes'][i]['translation'] = loc[:3, 3].tolist()
    ibm = np.stack([np.linalg.inv(Wn[i]).T for i in joints]).astype(np.float32)
    g.write(skin['inverseBindMatrices'], ibm.reshape(-1, 16))
    for m in j['meshes']:
        m['name'] = m['name'].replace('woman', 'man')
    for n in j['nodes']:
        n['name'] = n['name'].replace('woman', 'man')
    for m in j['materials']:
        m['name'] = m['name'].replace('woman', 'man')
    g.save(dst)
    print(f'{dst}: height {HEIGHT} m (x{k:.3f})')


def width(y):
    ys, fs = zip(*WIDTH)
    return np.interp(y, ys, fs)


def weld(P):
    """Map seam-split vertices to one id per position."""
    key = np.round(P * 1e5).astype(np.int64)
    _, inv = np.unique(key, axis=0, return_inverse=True)
    return inv.ravel()


def neighbours(idx, wid, n):
    tri = wid[idx.reshape(-1, 3)]
    e = np.concatenate([tri[:, [0, 1]], tri[:, [1, 2]], tri[:, [2, 0]]])
    e = np.concatenate([e, e[:, ::-1]])
    e = np.unique(e, axis=0)
    e = e[e[:, 0] != e[:, 1]]
    return e


def smooth(P, wid, edges, mask, iters):
    """Laplacian smoothing of welded vertices, blended by mask (0..1 per welded vertex)."""
    n = wid.max() + 1
    Q = np.zeros((n, 3))
    Q[wid] = P
    cnt = np.bincount(edges[:, 0], minlength=n)[:, None]
    for _ in range(iters):
        acc = np.zeros((n, 3))
        np.add.at(acc, edges[:, 0], Q[edges[:, 1]])
        avg = acc / np.maximum(cnt, 1)
        Q += (avg - Q) * mask[:, None] * 0.5
    return Q[wid]


def falloff(P, c, r, scale=(1, 1, 1)):
    d = (P - c) / np.array(scale)
    return np.exp(-(d * d).sum(1) / (r * r))


def sculpt(body, names, head0, head1):
    P = body['P']
    wid = weld(P)
    edges = neighbours(body['idx'], wid, len(P))
    nW = wid.max() + 1
    Pw = np.zeros((nW, 3))
    Pw[wid] = P
    # Landmarks from the reshaped skeleton (y up, +z front, +x = character's left).
    bi = {n: k for k, n in enumerate(names)}
    hipL, hipR = head1[bi['LeftUpperLeg']], head1[bi['RightUpperLeg']]
    mid = (hipL + hipR) / 2
    # Crotch: lowest midline torso vertex between the legs.
    sel = (np.abs(Pw[:, 0]) < 0.012) & (Pw[:, 1] > mid[1] - 0.25) & (Pw[:, 1] < mid[1])
    crotch = Pw[sel][np.argmin(Pw[sel][:, 1])]
    front = Pw[(np.abs(Pw[:, 0]) < 0.012) & (np.abs(Pw[:, 1] - (crotch[1] + 0.06)) < 0.02)]
    pubis = front[np.argmax(front[:, 2])]
    # Smooth away the female anatomy around the crotch, then add a modest bulge.
    print('crotch', crotch.round(3), 'pubis', pubis.round(3))
    m = falloff(Pw, (pubis + crotch) / 2, 0.07)
    Pw = smooth_w(Pw, edges, np.clip(m * 2.0, 0, 1), 80)
    b = falloff(Pw, pubis + np.array([0, -0.035, 0]), 0.03, (1.0, 1.4, 1)) * (Pw[:, 2] > pubis[2] - 0.05)
    Pw[:, 2] += 0.03 * b
    Pw[:, 1] -= 0.008 * b
    # Chest: each breast (already shrunk by its bone) is replaced by a taut membrane spanned by
    # the skin around it, which takes the fold under the breast with it; a modest pectoral
    # swell is added on top.
    for side in ('L', 'R'):
        c = head1[bi[f'breast.{side}']]
        ctr = np.array([c[0], c[1] - 0.015, 0])
        out = np.sign(c[0]) * (Pw[:, 0] - ctr[0]) > 0
        d = np.hypot((Pw[:, 0] - ctr[0]) / np.where(out, 1.25, 1.0), Pw[:, 1] - ctr[1])
        front = Pw[:, 2] > c[2] - 0.05
        reg = front & (d < 0.105)
        Pw = fill(Pw, edges, reg, harmonic=True)
        # Pectoral swell (upper, inner part of where the breast was).
        pc = np.array([c[0] * 0.8, c[1] + 0.01, 0])
        pm = np.exp(-(((Pw[:, 0] - pc[0]) / 0.07) ** 2 + ((Pw[:, 1] - pc[1]) / 0.055) ** 2)) * front
        Pw[:, 2] += 0.014 * pm
        # Blend the membrane's rim into the chest.
        rim = np.exp(-((d - 0.105) / 0.025) ** 2) * front
        Pw = smooth_w(Pw, edges, rim, 15)
        # Armpit: the wider shoulders pinch the skin into a few sharp folds.
        ua = head1[bi[('Left' if side == 'L' else 'Right') + 'UpperArm']]
        pit = falloff(Pw, ua + np.array([0, -0.05, 0.01]), 0.05)
        Pw = smooth_w(Pw, edges, np.clip(pit * 1.5, 0, 1), 20)
    # Hip sides: the narrower pelvis leaves a fold where the female hip curve was.
    for sx in (1, -1):
        hp = np.array([sx * 0.15, mid[1] - 0.01, -0.03])
        Pw = smooth_w(Pw, edges, np.clip(falloff(Pw, hp, 0.06, (0.8, 1.2, 1.2)) * 1.5, 0, 1), 25)
    # Brow ridge and Adam's apple.
    hd = head1[bi['Head']]
    eyes = (head1[bi['DEF-eye.L']] + head1[bi['DEF-eye.R']]) / 2
    fz = Pw[(np.abs(Pw[:, 0]) < 0.01) & (np.abs(Pw[:, 1] - eyes[1] - 0.03) < 0.01)][:, 2].max()
    brow = np.array([0, eyes[1] + 0.028, fz])
    bb = falloff(Pw, brow, 0.03, (1.8, 0.6, 1)) * (Pw[:, 2] > brow[2] - 0.03)
    Pw[:, 2] += 0.004 * bb
    # Thinner lips: squeeze the lips towards the mouth line and back a little.
    mid = (np.abs(Pw[:, 0]) < 0.004) & (Pw[:, 2] > hd[2])
    nz = Pw[mid & (Pw[:, 1] < eyes[1]) & (Pw[:, 1] > eyes[1] - 0.06)]
    nose = nz[np.argmax(nz[:, 2])]
    up = Pw[mid & (Pw[:, 1] < nose[1] - 0.012) & (Pw[:, 1] > nose[1] - 0.03)]
    up = up[np.argmax(up[:, 2])]
    lo = Pw[mid & (Pw[:, 1] < up[1] - 0.008) & (Pw[:, 1] > nose[1] - 0.055)]
    lo = lo[np.argmax(lo[:, 2])]
    mouth = (up + lo) / 2
    lm = falloff(Pw, mouth, 0.02, (1.4, 0.9, 1)) * (Pw[:, 2] > mouth[2] - 0.015)
    Pw[:, 1] += (mouth[1] - Pw[:, 1]) * 0.3 * lm
    Pw[:, 2] -= 0.003 * lm
    neck = head1[bi['Neck']]
    nz = Pw[(np.abs(Pw[:, 0]) < 0.01) & (np.abs(Pw[:, 1] - neck[1] - 0.02) < 0.01)][:, 2].max()
    ad = falloff(Pw, np.array([0, neck[1] + 0.02, nz]), 0.014, (1, 1.4, 1))
    Pw[:, 2] += 0.006 * ad
    body['P'] = Pw[wid]
    # Normals from the final shape (sculpts move vertices the skinning normals don't know).
    tri = wid[body['idx'].reshape(-1, 3)]
    fn = np.cross(Pw[tri[:, 1]] - Pw[tri[:, 0]], Pw[tri[:, 2]] - Pw[tri[:, 0]])
    vn = np.zeros_like(Pw)
    for c in range(3):
        np.add.at(vn, tri[:, c], fn)
    body['N'] = vn[wid]
    del hd


def fill(Pw, edges, region, harmonic=False):
    """Membrane fill of a region with everything outside held in place: harmonic (every
    vertex at the mean of its neighbours: a taut skin that cannot fold or overshoot) or
    biharmonic (min |L x|^2: also continues the surrounding curvature)."""
    n = len(Pw)
    nb = [[] for _ in range(n)]
    for a, b in edges:
        nb[a].append(b)
    R = np.flatnonzero(region)
    ring = set(R)
    for _ in range(2):
        ring |= {b for a in list(ring) for b in nb[a]}
    S = np.array(sorted(ring))
    col = {v: i for i, v in enumerate(S)}
    rows = list(R) if harmonic else [v for v in S if all(b in col for b in nb[v])]
    Lm = np.zeros((len(rows), len(S)))
    for r, v in enumerate(rows):
        Lm[r, col[v]] = 1
        for b in nb[v]:
            Lm[r, col[b]] -= 1 / len(nb[v])
    free = np.isin(S, R)
    A = Lm[:, free]
    rhs = -Lm[:, ~free] @ Pw[S[~free]]
    x = np.linalg.lstsq(A, rhs, rcond=None)[0]
    Pw = Pw.copy()
    Pw[S[free]] = x
    return Pw


def smooth_w(Pw, edges, mask, iters):
    n = len(Pw)
    Q = Pw.copy()
    cnt = np.bincount(edges[:, 0], minlength=n)[:, None]
    for _ in range(iters):
        acc = np.zeros((n, 3))
        np.add.at(acc, edges[:, 0], Q[edges[:, 1]])
        Q += (acc / np.maximum(cnt, 1) - Q) * mask[:, None] * 0.5
    return Q


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
