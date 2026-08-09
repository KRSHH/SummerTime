// Geometry post-processing used across the scene: instancing, per-patch
// instancing (for frustum culling + LOD), vertex-texture animation, curve
// paths, skinned meshes and animation clips. Ports of the original
// `createInstancedGeometry*` / `createVertexAnimation` / `createCurves` /
// `createSkin*` helpers.

import {
  AnimationClip,
  Bone,
  BufferAttribute,
  BufferGeometry,
  CurvePath,
  DataTexture,
  FloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InterpolateLinear,
  LineCurve3,
  Matrix4,
  Quaternion,
  QuaternionKeyframeTrack,
  RGBAFormat,
  Skeleton,
  SkinnedMesh,
  Vector3,
  Vector4,
  VectorKeyframeTrack,
} from 'three';
import type { MeshNormalMaterial } from 'three';
import { ceilPowerOfTwo } from '../../core/math';

/** Instance attributes that map onto an Object3D transform. */
const INSTANCE_ATTRIBUTES = ['position', 'quaternion', 'scale'];

const _obj = { scale: new Vector3(), quaternion: new Quaternion(), position: new Vector3() };

/**
 * Merge a base mesh with an instancing data geometry (one row per instance).
 * Instance `position/quaternion/scale` rows become a baked matrix array
 * (`_matrixArray`) attached to the returned geometry; any other data
 * attribute becomes an InstancedBufferAttribute.
 */
export function createInstancedGeometry(
  base: BufferGeometry,
  data: BufferGeometry,
): InstancedBufferGeometry {
  const result = new InstancedBufferGeometry();
  const firstAttr = data.attributes[Object.keys(data.attributes)[0]];
  result.instanceCount = firstAttr.count;

  if (base.index) result.setIndex(base.index.clone());
  for (const name of Object.keys(base.attributes)) {
    result.setAttribute(name, base.attributes[name]);
  }

  for (const name of Object.keys(data.attributes)) {
    if (INSTANCE_ATTRIBUTES.includes(name)) continue;
    const attr = data.attributes[name];
    const instanced = new InstancedBufferAttribute(attr.array, attr.itemSize, attr.normalized, 1);
    if (name === 'color') (result as any)._colors = instanced;
    else result.setAttribute(name, instanced);
  }

  const matrices: number[] = [];
  for (let i = 0; i < result.instanceCount; i++) {
    _obj.scale.setScalar(1);
    _obj.quaternion.identity();
    _obj.position.setScalar(0);
    for (const name of INSTANCE_ATTRIBUTES) {
      const attr = data.attributes[name];
      if (!attr || name === 'color') continue;
      switch (name) {
        case 'scale':
          if (attr.itemSize === 1) _obj.scale.setScalar(attr.array[i]);
          else _obj.scale.fromArray(attr.array, i * 3);
          break;
        case 'quaternion':
          _obj.quaternion.fromArray(attr.array, i * 4).normalize();
          break;
        case 'position':
          _obj.position.fromArray(attr.array, i * 3);
          break;
      }
    }
    const m = new Matrix4();
    m.compose(_obj.position, _obj.quaternion, _obj.scale);
    matrices.push(...m.toArray());
  }
  (result as any)._matrixArray = new Float32Array(matrices);
  (result as any).__vertexAnimationUniforms = (base as any).__vertexAnimationUniforms;
  return result;
}

export interface PatchOptions {
  maxPerPatch?: number;
  maxDistance?: number;
}

/**
 * Split instance rows into spatial patches (clusters of ≤ maxPerPatch rows
 * within maxDistance) and return one instanced geometry per patch. Lets the
 * renderer frustum-cull and LOD individual patches.
 */
export function createInstancedGeometryPatches(
  base: BufferGeometry,
  data: BufferGeometry,
  { maxPerPatch = 25, maxDistance = 50 }: PatchOptions = {},
): InstancedBufferGeometry[] {
  const names = Object.keys(data.attributes);
  const positions = data.attributes.position;
  const count = positions.count;

  const remaining = Array.from({ length: count }, (_, i) => i);
  const patches: InstancedBufferGeometry[] = [];
  const _v1 = new Vector3();
  const _v2 = new Vector3();

  while (remaining.length > 0) {
    const current = remaining.splice(0, 1)[0];
    const cluster = [current];
    _v1.fromBufferAttribute(positions, current);

    let next: number | null = null;
    let best = Infinity;
    let valid = false;
    for (const i of remaining) {
      _v2.fromBufferAttribute(positions, i);
      const d = _v2.distanceToSquared(_v1);
      if (d < best) {
        next = i;
        best = d;
      }
    }
    if (next !== null) {
      const dist = Math.sqrt(best);
      if (dist < maxDistance) valid = true;
      // consume nearest row so the next patch starts somewhere sensible
      remaining.splice(remaining.indexOf(next), 1);
      cluster.push(next);
    }

    // continue filling the cluster while rows are close enough
    let grew = true;
    while (grew && cluster.length < maxPerPatch) {
      grew = false;
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        _v2.fromBufferAttribute(positions, remaining[i]);
        const d = _v2.distanceToSquared(_v1);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0 && Math.sqrt(bestDist) < maxDistance) {
        cluster.push(remaining.splice(bestIdx, 1)[0]);
        grew = true;
      }
    }
    void valid;

    const patchGeo = new BufferGeometry();
    for (const name of names) {
      const src = data.attributes[name];
      const arr = new Float32Array(src.itemSize * cluster.length);
      for (let c = 0; c < cluster.length; c++) {
        const offset = cluster[c] * src.itemSize;
        const values = src.array as ArrayLike<number>;
        for (let i = 0; i < src.itemSize; i++) arr[c * src.itemSize + i] = values[offset + i];
      }
      patchGeo.setAttribute(name, new BufferAttribute(arr, src.itemSize));
    }
    patches.push(createInstancedGeometry(base, patchGeo));
  }
  return patches;
}

/**
 * Convert a vertex-animation geometry (attributes named `X_1..X_frames`)
 * into a static geometry plus a texture atlas holding every frame, exposed
 * as `__vertexAnimationUniforms` for the animation shader.
 */
export function createVertexAnimation(geometry: BufferGeometry): BufferGeometry {
  const userData = geometry.userData as { frames: number; fps: number };
  const names = Object.keys(geometry.attributes);
  const base = names.filter((n) => n.endsWith('_1')).map((n) => n.slice(0, -2));
  const animated = names.filter((n) => n.endsWith('_2')).map((n) => n.slice(0, -2));

  const result = new BufferGeometry();
  if (geometry.index) result.setIndex(geometry.index.clone());
  for (const name of base) {
    result.setAttribute(name, geometry.attributes[`${name}_1`].clone());
  }

  const uniforms: Record<string, { value: DataTexture | Vector4; ignore?: boolean }> = {};
  if (animated.length > 0) {
    const vertexCount = geometry.attributes[`${animated[0]}_1`].count;
    const total = vertexCount * userData.frames;
    const size = Math.max(2, ceilPowerOfTwo(total));
    const atlasSize = size * size;

    uniforms.uAnimInfo = { value: new Vector4(userData.fps, userData.frames, vertexCount, size), ignore: true };

    const vpos = new Float32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) vpos[i] = i;
    result.setAttribute('vposition', new BufferAttribute(vpos, 1));

    for (const name of animated) {
      const data = new Float32Array(atlasSize * 4);
      for (let frame = 0; frame < userData.frames; frame++) {
        const src = geometry.attributes[`${name}_${frame + 1}`].array;
        for (let v = 0; v < vertexCount; v++) {
          const dst = frame * vertexCount * 4 + v * 4;
          const s = v * 3;
          data[dst + 0] = src[s + 0];
          data[dst + 1] = src[s + 1];
          data[dst + 2] = src[s + 2];
          data[dst + 3] = 1;
        }
      }
      const texture = new DataTexture(data, size, size, RGBAFormat, FloatType);
      texture.needsUpdate = true;
      uniforms[`t${name.charAt(0).toUpperCase()}${name.slice(1)}`] = { value: texture };
    }
  }
  (result as any).__vertexAnimationUniforms = uniforms;
  return result;
}

/**
 * Build curve paths from a data geometry of points (one attribute row per
 * point). `autoClose` closes each loop; density scales the sampled points.
 */
export function createCurves(
  geometry: BufferGeometry,
  autoClose = false,
  density = 1,
): Array<{ curve: CurvePath<Vector3>; geometry: BufferGeometry }> {
  const result: Array<{ curve: CurvePath<Vector3>; geometry: BufferGeometry }> = [];
  for (const name of Object.keys(geometry.attributes)) {
    const attr = geometry.attributes[name];
    const count = attr.count;
    const array = attr.array;
    const points: Vector3[] = [];
    for (let i = 0; i < count; i++) {
      points.push(new Vector3(array[i * 3 + 0], array[i * 3 + 1], array[i * 3 + 2]));
    }
    const curve = new CurvePath<Vector3>();
    for (let i = 0; i < points.length - 1; i++) {
      curve.add(new LineCurve3(points[i], points[i + 1]));
    }
    if (autoClose) curve.autoClose = true;
    const sampled = curve.getPoints(Math.round(curve.getLength() * 10 * density));
    result.push({ curve, geometry: new BufferGeometry().setFromPoints(sampled) });
  }
  return result;
}

/** Build a skinned mesh from a mesh geometry + a bones data geometry. */
export function createSkin(
  mesh: BufferGeometry,
  bones: BufferGeometry,
): SkinnedMesh {
  const boneList: Bone[] = [];
  for (let i = 0; i < bones.attributes.position.count; i++) {
    const bone = new Bone();
    bone.name = `bone_${i}`;
    bone.position.fromArray(bones.attributes.position.array as Float32Array, i * 3);
    bone.quaternion.fromArray(bones.attributes.quaternion.array as Float32Array, i * 4).normalize();
    bone.scale.fromArray(bones.attributes.scale.array as Float32Array, i * 3);
    boneList.push(bone);
  }
  const roots: number[] = [];
  const hierarchy = bones.attributes.hierarchy.array as Uint16Array;
  for (let i = 0; i < hierarchy.length; i++) {
    const parent = hierarchy[i] - 1;
    if (parent === -1) roots.push(i);
    else boneList[parent].add(boneList[i]);
  }
  const skeleton = new Skeleton(boneList);
  const skinned = new SkinnedMesh(mesh, undefined as unknown as MeshNormalMaterial);
  for (const root of roots) skinned.add(skeleton.bones[root]);
  skinned.bind(skeleton);
  skinned.normalizeSkinWeights();
  return skinned;
}

const ANIMATION_ATTRIBUTES = ['scale', 'quaternion', 'position'];

/**
 * Convert a frame-data geometry (position/quaternion/scale rows, one block
 * per frame) into a three.js AnimationClip for a skinned mesh.
 */
export function createSkinAnimation(name: string, data: BufferGeometry): AnimationClip {
  const userData = data.userData as { frames: number; fps: number };
  const frames = userData.frames;
  const bones = data.attributes.position.count / frames;
  const duration = frames / userData.fps;
  const step = duration / (frames - 1);
  const times = Array.from({ length: frames }, (_, i) => i * step);

  const tracksData: Record<string, { size: number; arr: number[] }> = {};
  for (const attrName of ANIMATION_ATTRIBUTES) {
    const attr = data.attributes[attrName];
    const array = attr.array;
    const itemSize = attr.itemSize;
    for (let b = 0; b < bones; b++) {
      const key = `bone_${b}.${attrName}`;
      tracksData[key] = { size: itemSize, arr: [] };
      for (let f = 0; f < frames; f++) {
        const base = f * bones * itemSize;
        for (let c = 0; c < itemSize; c++) {
          tracksData[key].arr.push(array[base + b * itemSize + c] as number);
        }
      }
    }
  }

  const tracks = Object.keys(tracksData).map((key) => {
    const { size, arr } = tracksData[key];
    const Track = size === 4 ? QuaternionKeyframeTrack : VectorKeyframeTrack;
    return new Track(key, times, arr, InterpolateLinear);
  });
  return new AnimationClip(name, duration, tracks);
}
