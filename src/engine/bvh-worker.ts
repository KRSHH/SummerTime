// BVH build worker: transforms the collider geometry into world space and
// builds + serializes a three-mesh-bvh tree off the main thread.
import { BufferAttribute, BufferGeometry, Matrix4 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

self.onmessage = (e: MessageEvent) => {
  const { position, index, matrixWorld }: { position: ArrayBuffer; index?: ArrayBuffer; matrixWorld: number[] } =
    e.data;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(position), 3));
  if (index) geometry.setIndex(new BufferAttribute(new Uint32Array(index), 1));
  geometry.applyMatrix4(new Matrix4().fromArray(matrixWorld));

  const bvh = new MeshBVH(geometry);
  const serialized = MeshBVH.serialize(bvh, { cloneBuffers: true });
  const out = geometry.attributes.position.array as Float32Array;
  (self as any).postMessage({ serialized, position: out }, [out.buffer]);
};
