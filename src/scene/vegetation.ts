// Trees, bushes, palms, rocks and grass: instanced patches with LOD levels.

import { geometryLoader } from '../engine/loaders/geometries';
import { makeGeometryLOD, LODExtended } from './helpers';
import { phongMaterial } from './materials';
import { SceneModule } from './SceneModule';

const LEVELS_TREES = [
  { mesh: 'tree.bin', distance: 0, hysteresis: 0 },
  { mesh: 'tree-lod2.bin', distance: 30, hysteresis: 0 },
  { mesh: 'tree-lod3.bin', distance: 50, hysteresis: 0 },
];
const LEVELS_BUSHES = [
  { mesh: 'bush.bin', distance: 0, hysteresis: 0 },
  { mesh: 'bush-lod2.bin', distance: 30, hysteresis: 0 },
  { mesh: 'bush-lod3.bin', distance: 50, hysteresis: 0 },
];
const LEVELS_PALMS = [
  { mesh: 'palmtree.bin', distance: 0, hysteresis: 0 },
  { mesh: 'palmtree-lod2.bin', distance: 60, hysteresis: 0 },
];
const LEVELS_ROCKS1 = [
  { mesh: 'rock1.bin', distance: 0, hysteresis: 0 },
  { mesh: 'rock1-lod2.bin', distance: 40, hysteresis: 0 },
];
const LEVELS_ROCKS2 = [
  { mesh: 'rock2.bin', distance: 0, hysteresis: 0 },
  { mesh: 'rock2-lod2.bin', distance: 70, hysteresis: 0 },
];

export class Trees extends SceneModule {
  meshes: LODExtended[] = [];
  protected async init() {
    const patches = await Promise.all(
      LEVELS_TREES.map((l) =>
        geometryLoader.instancedPatches(l.mesh, 'tree-instances.bin', { maxPerPatch: 30, maxDistance: 30 }),
      ),
    );
    this.meshes = makeGeometryLOD(patches as any, LEVELS_TREES, () => phongMaterial({ isTree: true }), 'trees');
    this.meshes.forEach((lod) => this.scene.add(lod));
    this.ready.resolve();
  }
}

export class Bushes extends SceneModule {
  meshes: LODExtended[] = [];
  protected async init() {
    const patches = await Promise.all(
      LEVELS_BUSHES.map((l) =>
        geometryLoader.instancedPatches(l.mesh, 'bush-instances.bin', { maxPerPatch: 25, maxDistance: 30 }),
      ),
    );
    this.meshes = makeGeometryLOD(patches as any, LEVELS_BUSHES, () => phongMaterial({ isBush: true }), 'bushes');
    this.meshes.forEach((lod) => this.scene.add(lod));
    this.ready.resolve();
  }
}

export class Palmtrees extends SceneModule {
  meshes: LODExtended[] = [];
  protected async init() {
    const patches = await Promise.all(
      LEVELS_PALMS.map((l) =>
        geometryLoader.instancedPatches(l.mesh, 'palmtree-instances.bin', { maxPerPatch: 30, maxDistance: 40 }),
      ),
    );
    this.meshes = makeGeometryLOD(patches as any, LEVELS_PALMS, () => phongMaterial({ isPalmTree: true }), 'palmtrees');
    this.meshes.forEach((lod) => this.scene.add(lod));
    this.ready.resolve();
  }
}

export class Rocks1 extends SceneModule {
  meshes: LODExtended[] = [];
  protected async init() {
    const patches = await Promise.all(
      LEVELS_ROCKS1.map((l) =>
        geometryLoader.instancedPatches(l.mesh, 'rock1-instances.bin', { maxPerPatch: 40, maxDistance: 50 }),
      ),
    );
    this.meshes = makeGeometryLOD(patches as any, LEVELS_ROCKS1, () => phongMaterial({ isRock: true }), 'rocks1', 70);
    this.meshes.forEach((lod) => this.scene.add(lod));
    this.ready.resolve();
  }
}

export class Rocks2 extends SceneModule {
  meshes: LODExtended[] = [];
  protected async init() {
    const patches = await Promise.all(
      LEVELS_ROCKS2.map((l) =>
        geometryLoader.instancedPatches(l.mesh, 'rock2-instances.bin', { maxPerPatch: 15, maxDistance: 40 }),
      ),
    );
    this.meshes = makeGeometryLOD(patches as any, LEVELS_ROCKS2, () => phongMaterial({ isRock: true }), 'rocks2');
    this.meshes.forEach((lod) => this.scene.add(lod));
    this.ready.resolve();
  }
}

export class Grass extends SceneModule {
  meshes: LODExtended[] = [];
  protected async init() {
    const patches = await geometryLoader.instancedPatches('grass.bin', 'grass-instances.bin', {
      maxPerPatch: 500,
      maxDistance: 25,
    });
    this.meshes = makeGeometryLOD(
      [patches as any],
      [{ mesh: 'grass.bin', distance: 0, hysteresis: 0 }],
      () => { const m = phongMaterial({ isGrass: true }); return m; },
      'grass',
      55,
    );
    this.meshes.forEach((lod) => { lod.traverse((obj) => { if ((obj as any).isInstancedMesh) (obj as any).castShadow = false; }); this.scene.add(lod); });

    // grass reacts to the player character
    const charPos = { value: new (await import('three')).Vector3() };
    const charSpeed = { value: 0 };
    this.meshes.forEach((lod) =>
      lod.traverse((obj) => {
        const material = (obj as any).material;
        if (material?.isMaterial) {
          material.uniforms.charPos = charPos;
          material.uniforms.charSpeed = charSpeed;
        }
      }),
    );
    this.scene.beforeRenderCbs.push(() => {
      const local = this.scene.characters?.mesh?._localObject;
      if (local) {
        charPos.value.copy(local.position);
        charSpeed.value = local.velocityHorizontal;
      }
    });
    this.ready.resolve();
  }
}
