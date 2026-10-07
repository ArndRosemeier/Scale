// @ts-nocheck -- three's TSL typings infer swizzles and vector widths poorly; checked by rendering (docs/WEBGPU_PLAN.md).
/**
 * Materials that differ only in uniform values share one node graph, so the renderer builds their
 * shader once instead of once per material (three keys node builds by the nodes' ids, so materials
 * with their own node instances never share a build; clones sharing the nodes do).
 * See docs/WEBGPU_PORTING.md, "Shaders shared between materials".
 */
import * as THREE from 'three/webgpu';
import { uniform, uniformArray } from 'three/tsl';

/** The material's own values, read by its shared graph's uniforms. */
const OWN = Symbol('ownValues');
export type Values = Record<string, { value: unknown }>;

/** A uniform of a shared graph, fed from the drawn material's `{ value }` named `name`. */
function fed(name: string, init: unknown) {
  const own = ({ material }) => material?.[OWN]?.[name]?.value;
  if (Array.isArray(init) || ArrayBuffer.isView(init)) {
    return uniformArray(init.slice(), 'float').setName(name).onObjectUpdate((frame, self) => {
      const a = own(frame);
      if (a) self.array = a;
    });
  }
  return uniform(typeof init === 'number' ? init : init.clone()).onObjectUpdate(own);
}

const graphs = new Map<string, THREE.NodeMaterial>();

/**
 * A material of the kind `key`: `build` makes the graph once per key (that material is never
 * drawn), taking its uniforms from `P(name)`; every caller gets a clone with the same nodes, its own
 * `values` and its own `params` (material properties that vary between callers). The uniforms read
 * the values of the material being drawn (`onObjectUpdate`, i.e. per object).
 */
export function sharedGraph<M extends THREE.NodeMaterial>(key: string, values: Values, params: Record<string, unknown>, build: (P: (name: string) => unknown) => M): { material: M; graph: M } {
  let graph = graphs.get(key) as M | undefined;
  if (!graph) {
    graph = build((name) => fed(name, values[name].value));
    graphs.set(key, graph);
  }
  const material = graph.clone() as M;
  // Setup hooks (setDiffuse, onLightingModel, setupPosition overrides) are own functions; clone() skips them.
  for (const k of Object.keys(graph)) if (typeof graph[k] === 'function') material[k] = graph[k];
  material.setValues(params);
  material[OWN] = values;
  return { material, graph };
}

/** The drawn material's own values (in a node's `onObjectUpdate`), for a graph from `sharedGraph`. */
export function ownValues(material): Values | undefined {
  return material?.[OWN];
}
