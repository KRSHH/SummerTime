// Geometry loader facade: promise-cached loading of the site's `.bin`
// format with all the scene entry points (plain, instanced, patched,
// vertex-animated, skinned, curves). Port of the original `geometryLoader`.

import { BufferGeometry, BoxGeometry } from 'three';
import { parseBin, decodeGeometry, TYPED_ARRAYS, type TypedArrayName } from './bin';
import {
  createCurves,
  createInstancedGeometry,
  createInstancedGeometryPatches,
  createSkin,
  createSkinAnimation,
  createVertexAnimation,
  type PatchOptions,
} from './instancing';

type GeometryWithData = BufferGeometry & {
  userData: any;
  __vertexAnimationUniforms?: Record<string, unknown>;
};

const cache = new Map<string, Promise<any>>();

function initLoad<T>(key: string, load: () => Promise<T>): Promise<T> {
  let promise = cache.get(key);
  if (!promise) {
    promise = load();
    cache.set(key, promise);
  }
  return promise;
}

/** Empty geometry returned when a model fails to load (original behavior). */
const createFallbackGeometry = () => { const g = new BoxGeometry(1, 1, 1); (g as any)._fallback = true; return g; };

async function loadBin(url: string): Promise<GeometryWithData> {
  const response = await fetch(new URL('assets/geometries/' + url, window.location.href));
  if (!response.ok) throw new Error(`${url} could not be loaded (${response.status})`);
  const buffer = await response.arrayBuffer();
  const { header, payload } = parseBin(buffer);

  const attributeIDs: Record<string, number> = {};
  const attributeTypes: Record<string, TypedArrayName> = {};
  header.attributes.forEach(([name, typeId], index) => {
    attributeIDs[name] = index;
    attributeTypes[name] = TYPED_ARRAYS[typeId] as TypedArrayName;
  });

  const geometry = await decodeGeometry(payload, { attributeIDs, attributeTypes });
  if (header.userData) geometry.userData = header.userData;
  return geometry as GeometryWithData;
}

export const geometryLoader = {
  load(url: string, loadMode = 'default'): Promise<BufferGeometry> {
    return initLoad(`${url}_<>_${loadMode}`, async () => {
      try {
        const geometry = await loadBin(url);
        (geometry as any)._loadMode = loadMode;
        return geometry;
      } catch (err) {
        console.warn('Geometry load failed:', url, err);
        return createFallbackGeometry();
      }
    });
  },

  instanced(url: string, instancesUrl: string, loadMode = 'load'): Promise<BufferGeometry> {
    return initLoad(`instanced_<>_${url}-${instancesUrl}`, async () => {
      const [base, data] = await Promise.all([
        (this as any)[loadMode](url),
        this.load(instancesUrl),
      ]);
      return createInstancedGeometry(base, data);
    });
  },

  instancedPatches(
    url: string,
    instancesUrl: string,
    options: PatchOptions = {},
    loadMode = 'load',
  ): Promise<BufferGeometry[]> {
    const { maxPerPatch = 25, maxDistance = 50 } = options;
    return initLoad(
      `instancedPatches_<>_${url}-${instancesUrl}-${maxPerPatch}-${maxDistance}`,
      async () => {
        const [base, data] = await Promise.all([
          (this as any)[loadMode](url),
          this.load(instancesUrl),
        ]);
        return createInstancedGeometryPatches(base, data, {
          maxPerPatch,
          maxDistance,
        });
      },
    );
  },

  vertexAnimation(url: string): Promise<BufferGeometry> {
    return initLoad(`vertexanimation_<>_${url}`, async () => {
      const geometry = await this.load(url);
      return createVertexAnimation(geometry);
    });
  },

  curves(url: string, autoClose = false, density = 1): Promise<ReturnType<typeof createCurves>> {
    return initLoad(`curves_<>_${url}-${autoClose}-${density}`, async () => {
      const geometry = await this.load(url);
      return createCurves(geometry, autoClose, density);
    });
  },

  skin(url: string, bonesUrl: string): Promise<ReturnType<typeof createSkin>> {
    return initLoad(`skin_<>_${url}-${bonesUrl}`, async () => {
      const [mesh, bones] = await Promise.all([this.load(url), this.load(bonesUrl)]);
      return createSkin(mesh, bones);
    });
  },

  skinAnimation(url: string): Promise<ReturnType<typeof createSkinAnimation>> {
    return initLoad(`skinanimation_<>_${url}`, async () => {
      const geometry = await this.load(url);
      return createSkinAnimation(url, geometry);
    });
  },
};
