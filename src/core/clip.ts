/**
 * Thin wrapper around Clipper (integer polygon booleans and offsetting).
 * Coordinates are scaled to centimetres. A "Shape" is an outer ring with
 * holes; all rings are flat [x,z,...] arrays (outer CCW, holes CW in the
 * output).
 */
import ClipperLib from 'clipper-lib';
import type { Poly } from './geom2';

const S = 100;

export interface Shape { outer: Poly; holes: Poly[] }

type IntPath = { X: number; Y: number }[];

function toPath(p: Poly): IntPath {
  const out: IntPath = [];
  for (let i = 0; i < p.length; i += 2) out.push({ X: Math.round(p[i] * S), Y: Math.round(p[i + 1] * S) });
  return out;
}
function fromPath(path: IntPath): Poly {
  const out: Poly = [];
  for (const pt of path) out.push(pt.X / S, pt.Y / S);
  return out;
}

function run(type: number, subj: Poly[], clip: Poly[], fill = ClipperLib.PolyFillType.pftNonZero): Shape[] {
  const c = new ClipperLib.Clipper();
  c.AddPaths(subj.map(toPath), ClipperLib.PolyType.ptSubject, true);
  if (clip.length) c.AddPaths(clip.map(toPath), ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(type, tree, fill, fill);
  return treeToShapes(tree);
}

function treeToShapes(tree: any): Shape[] {
  const shapes: Shape[] = [];
  const visit = (node: any) => {
    for (const child of node.Childs()) {
      if (!child.IsHole()) {
        const shape: Shape = { outer: fromPath(child.Contour()), holes: [] };
        for (const h of child.Childs()) {
          shape.holes.push(fromPath(h.Contour()));
          visit(h); // islands inside holes
        }
        if (shape.outer.length >= 6) shapes.push(shape);
      }
    }
  };
  visit(tree);
  return shapes;
}

export function union(polys: Poly[]): Shape[] {
  return run(ClipperLib.ClipType.ctUnion, polys, []);
}
export function difference(subj: Poly[], clip: Poly[]): Shape[] {
  return run(ClipperLib.ClipType.ctDifference, subj, clip);
}
export function intersection(subj: Poly[], clip: Poly[]): Shape[] {
  return run(ClipperLib.ClipType.ctIntersection, subj, clip);
}

export function shapesToPolys(shapes: Shape[]): Poly[] {
  const out: Poly[] = [];
  for (const s of shapes) { out.push(s.outer); for (const h of s.holes) out.push(h); }
  return out;
}

export type JoinKind = 'miter' | 'round' | 'square';
const JOIN: Record<JoinKind, number> = {
  miter: ClipperLib.JoinType.jtMiter,
  round: ClipperLib.JoinType.jtRound,
  square: ClipperLib.JoinType.jtSquare,
};

/** Offset closed polygons (positive grows). */
export function offset(polys: Poly[], delta: number, join: JoinKind = 'miter', miterLimit = 2.5): Shape[] {
  const co = new ClipperLib.ClipperOffset(miterLimit, 0.25 * S);
  co.AddPaths(polys.map(toPath), JOIN[join], ClipperLib.EndType.etClosedPolygon);
  const tree = new ClipperLib.PolyTree();
  co.Execute(tree, delta * S);
  return treeToShapes(tree);
}

/** Offset open polylines into thick strokes (buffer). */
export function strokePolylines(lines: number[][], halfWidth: number, join: JoinKind = 'round', cap: 'butt' | 'round' | 'square' = 'butt'): Shape[] {
  const co = new ClipperLib.ClipperOffset(2, 0.25 * S);
  const end = cap === 'round' ? ClipperLib.EndType.etOpenRound : cap === 'square' ? ClipperLib.EndType.etOpenSquare : ClipperLib.EndType.etOpenButt;
  for (const l of lines) co.AddPath(toPath(l), JOIN[join], end);
  const tree = new ClipperLib.PolyTree();
  co.Execute(tree, halfWidth * S);
  return treeToShapes(tree);
}

export function shapeArea(s: Shape): number {
  let a = Math.abs(ClipperLib.Clipper.Area(toPath(s.outer)));
  for (const h of s.holes) a -= Math.abs(ClipperLib.Clipper.Area(toPath(h)));
  return a / (S * S);
}

/** Simplify a polygon (removes self-intersections). */
export function cleanShapes(polys: Poly[]): Shape[] {
  return run(ClipperLib.ClipType.ctUnion, polys, [], ClipperLib.PolyFillType.pftNonZero);
}
