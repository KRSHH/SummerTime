// Shared scene helpers: frustum culling for baked-instance meshes and the
// LOD container used by trees/bushes/palms/rocks/grass.

import {
  Box3,
  InstancedMesh,
  LOD,
  Matrix4,
  Mesh,
  Vector3,
} from 'three';
import type { Camera, Material } from 'three';

const _box = new Box3();
const _mat = new Matrix4();
const _v1 = new Vector3();
const _v2 = new Vector3();

/** Compute a tight bounding sphere over all instance positions so the mesh
 *  can be frustum culled as a whole. */
export function frustumcullInstanced(mesh: InstancedMesh): void {
  mesh.geometry.computeBoundingSphere();
  const matrix = mesh.instanceMatrix;
  _box.makeEmpty();
  let maxScale = 0;
  for (let i = 0; i < matrix.count; i++) {
    _mat.fromArray(matrix.array as Float32Array, i * 16);
    _v1.setFromMatrixPosition(_mat);
    _box.expandByPoint(_v1);
    _v1.setFromMatrixScale(_mat);
    maxScale = Math.max(maxScale, Math.max(_v1.x, _v1.y, _v1.z));
  }
  const sphere = mesh.geometry.boundingSphere!;
  _box.getCenter(sphere.center);
  let maxDist = 0;
  for (let i = 0; i < matrix.count; i++) {
    _mat.fromArray(matrix.array as Float32Array, i * 16);
    _v1.setFromMatrixPosition(_mat);
    maxDist = Math.max(maxDist, sphere.center.distanceToSquared(_v1));
  }
  sphere.radius = Math.sqrt(maxDist) + sphere.radius * maxScale;
  mesh.frustumCulled = true;
}

/** Build an InstancedMesh from a patched instanced geometry (baked matrices,
 *  optional per-instance colors) with frustum culling. */
export function makeInstanced(
  geometry: any,
  material: Material,
  name: string,
): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, geometry.instanceCount);
  mesh.instanceMatrix.array = geometry._matrixArray;
  if (geometry._colors) mesh.instanceColor = geometry._colors;
  frustumcullInstanced(mesh);
  mesh.name = name;
  mesh.updateMatrixWorld(true);
  mesh.matrixWorldAutoUpdate = false;
  mesh.receiveShadow = true;
  mesh.castShadow = geometry._castShadow ?? true;
  return mesh;
}

/** LOD container that hides levels beyond a distance (used for grass). */
export class LODExtended extends LOD {
  private _hideDistance: number;

  constructor({ hideDistance = Infinity }: { hideDistance?: number } = {}) {
    super();
    this._hideDistance = hideDistance;
    this.matrixWorldAutoUpdate = false;
  }

  override addLevel(object: Mesh, distance = 0, hysteresis = 0): this {
    if (!object.geometry.boundingSphere) object.geometry.computeBoundingSphere();
    return super.addLevel(object, distance, hysteresis);
  }

  override update(camera: Camera) {
    if (!this.levels.length) return;
    const cam = camera as unknown as { matrixWorld: { elements: number[] }; zoom: number };
    _v1.setFromMatrixPosition(camera.matrixWorld as any);
    _v2.setFromMatrixScale(this.matrixWorld);
    const scale = Math.max(_v2.x, _v2.y, _v2.z);
    const geometry = (this.levels[0].object as any).geometry;
    _v2.setFromMatrixPosition(this.matrixWorld).add(geometry.boundingSphere!.center);
    const distance = (_v1.distanceTo(_v2) - geometry.boundingSphere!.radius * scale) / cam.zoom;
    this.levels[0].object.visible = true;
    let level = 1;
    for (; level < this.levels.length; level++) {
      const threshold = this.levels[level].distance - (this.levels[level].object.visible ? this.levels[level].distance * this.levels[level].hysteresis : 0);
      if (distance >= threshold) {
        this.levels[level - 1].object.visible = false;
        this.levels[level].object.visible = true;
      } else break;
    }
    (this as any)._currentLevel = level - 1;
    if ((this as any)._currentLevel === this.levels.length - 1 && distance > this._hideDistance) level = 0;
    for (let i = 0; i < this.levels.length; i++) this.levels[i].object.visible = i === level - 1;
    if (level === 0) for (const l of this.levels) l.object.visible = false;
  }
}

export function makeGeometryLOD(
  patches: any[],
  levels: Array<{ mesh: string; distance: number; hysteresis: number }>,
  materialFactory: () => Material,
  name: string,
  hideDistance?: number,
): LODExtended[] {
  const lods: LODExtended[] = [];
  const patchCount = patches[0].length;
  for (let p = 0; p < patchCount; p++) {
    const lod = new LODExtended({ hideDistance });
    lods.push(lod);
    for (let l = 0; l < levels.length; l++) {
      const geometry = patches[l][p];
      const mesh = makeInstanced(geometry, materialFactory(), name);
      (mesh as any).ignore = p !== 0 || l !== 0;
      lod.addLevel(mesh, levels[l].distance, levels[l].hysteresis);
    }
    lod.updateMatrixWorld(true);
  }
  return lods;
}
