/**
 * Seeing through a portal: an opening at one place (`from`) that shows another (`to`), as if the two were
 * joined. The view through it is the camera moved by the same step that takes `from` onto `to`, drawn with
 * its near plane laid on the far opening (nothing between the camera and the opening on that side shows), and
 * only over the opening's rectangle on the screen. Pure maths on three's cameras and matrices: the game draws
 * the view into a twin of its scene target (Post.twin) and lays it into the opening's shape.
 *
 * The frames are rigid (a turn and a step): the opening at the frame's origin, its plane the frame's xy, the
 * way through it the frame's -z. A point just behind `from` (local z < 0) is seen at the same local point
 * behind `to`.
 */
import { Matrix4, Plane, Vector3, Vector4, WebGLCoordinateSystem, type Camera, type PerspectiveCamera } from 'three/webgpu';

const _step = new Matrix4(), _inv = new Matrix4(), _v = new Vector4(), _p = new Vector3();

/** The step that takes `from`'s frame onto `to`'s: to · from⁻¹. */
export function portalStep(from: Matrix4, to: Matrix4, out = new Matrix4()): Matrix4 {
  return out.multiplyMatrices(to, _inv.copy(from).invert());
}

/**
 * The camera that sees through the opening: `camera` moved by the portal's step, with its projection and
 * set-up (depth, coordinate system). `out` is placed and its matrices made; its projection is the camera's
 * until `clipNear` lays the near plane on the opening.
 */
export function throughPortal<C extends Camera>(camera: C, from: Matrix4, to: Matrix4, out: C): C {
  camera.updateMatrixWorld();
  out.copy(camera, false);
  const c = camera as unknown as { _reversedDepth?: boolean; coordinateSystem: number };
  const o = out as unknown as { _reversedDepth?: boolean; coordinateSystem: number };
  o._reversedDepth = c._reversedDepth;
  o.coordinateSystem = c.coordinateSystem;
  out.projectionMatrix.copy(camera.projectionMatrix);
  out.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
  portalStep(from, to, _step).multiply(camera.matrixWorld).decompose(out.position, out.quaternion, out.scale);
  out.updateMatrixWorld(true);
  return out;
}

/** The opening's plane in world space, facing the side that is seen through it (behind the frame: its -z). */
export function openingPlane(frame: Matrix4, out = new Plane()): Plane {
  const n = new Vector3(0, 0, -1).transformDirection(frame);
  return out.setFromNormalAndCoplanarPoint(n, _p.setFromMatrixPosition(frame));
}

/**
 * Lay the camera's near plane on `plane` (world space; its normal towards what is to be seen), so nothing in
 * front of it is drawn (an oblique near plane, after Lengyel). The far plane tilts to pass through the far
 * corners of the view. False (and the projection left alone) when nothing beyond the plane is in view.
 * Works for reversed depth and for three's WebGL and WebGPU clip conventions.
 */
export function clipNear(camera: PerspectiveCamera, plane: Plane): boolean {
  camera.updateMatrixWorld();
  // The plane in view space (planes go by the inverse transpose; the view matrix is the world matrix's inverse).
  const view = camera.matrixWorldInverse;
  const pv = plane.clone().applyMatrix4(view);
  const C = _v.set(pv.normal.x, pv.normal.y, pv.normal.z, pv.constant);
  const m = camera.projectionMatrix, e = m.elements;
  // How far beyond the plane the far corners lie, per unit of w (= distance along the view).
  const far = camera.far, ty = Math.tan((camera.fov * Math.PI) / 360) / camera.zoom, tx = ty * camera.aspect;
  let most = -Infinity;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const x = sx * tx * far, y = sy * ty * far, z = -far;
    most = Math.max(most, (C.x * x + C.y * y + C.z * z + C.w) / far);
  }
  if (!(most > 0)) return false;
  const reversed = !!(camera as unknown as { _reversedDepth?: boolean })._reversedDepth;
  const gl = camera.coordinateSystem === WebGLCoordinateSystem && !reversed;
  // Row 3 gives w; row 2 is replaced so the near clip test is C·v >= 0 and the far one still holds out to `far`.
  const r3 = [e[3], e[7], e[11], e[15]];
  const s = (gl ? 2 : 1) / most;
  const row = reversed
    ? [r3[0] - s * C.x, r3[1] - s * C.y, r3[2] - s * C.z, r3[3] - s * C.w] // near: z <= w; far: z >= 0
    : gl
      ? [s * C.x - r3[0], s * C.y - r3[1], s * C.z - r3[2], s * C.w - r3[3]] // near: z >= -w; far: z <= w
      : [s * C.x, s * C.y, s * C.z, s * C.w]; // near: z >= 0; far: z <= w
  e[2] = row[0]; e[6] = row[1]; e[10] = row[2]; e[14] = row[3];
  camera.projectionMatrixInverse.copy(m).invert();
  return true;
}

/**
 * Where the opening (its outline's corners, world space) covers the screen: a pixel rectangle on a `w`×`h`
 * target, a pixel of margin round it, or null when it is all behind the camera or off the screen. A corner
 * behind the camera makes it the whole screen (the opening wraps round the eye).
 */
export function screenRect(corners: readonly Vector3[], camera: Camera, w: number, h: number): { x: number; y: number; w: number; h: number } | null {
  camera.updateMatrixWorld();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = 0;
  const vp = _step.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  for (const c of corners) {
    _v.set(c.x, c.y, c.z, 1).applyMatrix4(vp);
    if (_v.w <= 1e-6) { behind++; continue; }
    const sx = _v.x / _v.w, sy = _v.y / _v.w;
    x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
  }
  if (behind === corners.length) return null;
  if (behind) return { x: 0, y: 0, w, h };
  if (x1 < -1 || x0 > 1 || y1 < -1 || y0 > 1) return null;
  const px0 = Math.max(0, Math.floor(((x0 + 1) / 2) * w) - 1), px1 = Math.min(w, Math.ceil(((x1 + 1) / 2) * w) + 1);
  // Screen y runs up in clip space and down in pixels.
  const py0 = Math.max(0, Math.floor(((1 - y1) / 2) * h) - 1), py1 = Math.min(h, Math.ceil(((1 - y0) / 2) * h) + 1);
  if (px1 <= px0 || py1 <= py0) return null;
  return { x: px0, y: py0, w: px1 - px0, h: py1 - py0 };
}
