// Geometry post-processing for the scene (port of `createInstancedGeometry*`,
// `createVertexAnimation`, `createCurves`, `createSkin*`): instancing,
// per-patch instancing, vertex-texture animation, curves, skin + clips.

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
/** Merge a base mesh with per-instance data; pos/rot/scale rows → `_matrixArray`,
 *  other attributes → InstancedBufferAttribute. */
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
/** Split instances into spatial patches (≤ maxPerPatch within maxDistance) for
 *  per-patch frustum culling + LOD. Returns one geometry per patch. */
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

  let current = 0;
  const cluster: number[] = [];
  while (remaining.length > 0) {
    cluster.push(current);
    remaining.splice(remaining.indexOf(current), 1);
    _v1.fromBufferAttribute(positions, current);
    let next: number | null = null; let best = Infinity;
    for (const i of remaining) { _v2.fromBufferAttribute(positions, i); const d = _v2.distanceToSquared(_v1); if (d < best) { best = d; next = i; } }
    const valid = next !== null && Math.sqrt(best) < maxDistance;
    if (next !== null && valid && cluster.length < maxPerPatch) { current = next; continue; }
    const patchGeo = new BufferGeometry();
    for (const name of names) {
      const src = data.attributes[name]; const arr = new Float32Array(src.itemSize * cluster.length);
      for (let c = 0; c < cluster.length; c++) { const offset = cluster[c] * src.itemSize; for (let i = 0; i < src.itemSize; i++) arr[c * src.itemSize + i] = (src.array as ArrayLike<number>)[offset + i]; }
      patchGeo.setAttribute(name, new BufferAttribute(arr, src.itemSize));
    }
    patches.push(createInstancedGeometry(base, patchGeo));
    cluster.length = 0;
    if (remaining.length) current = remaining[0];
  }
  return patches;
}

/**
/** Vertex-animation geometry (`X_1..X_frames` attrs) → static geometry + a
 *  per-frame texture atlas exposed as `__vertexAnimationUniforms`. */
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
/** Build curve paths from a point data geometry; `autoClose` closes loops,
 *  `density` scales samples. */
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
/** Frame-data geometry (pos/quat/scale per frame) → three.js AnimationClip. */
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
