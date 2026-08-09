// Terrain: terrain.bin + phongMaterial with road map, masks and noise/
// detail layers. Shader GLSL is verbatim from the original.

import { Mesh } from 'three';
import { geometryLoader } from '../engine/loaders/geometries';
import { phongMaterial } from './materials';
import { SceneModule } from './SceneModule';

export class Terrain extends SceneModule {
  declare mesh: Mesh;

  protected async init() {
    const geometry = await geometryLoader.load('terrain.bin');
    this.mesh = new Mesh(geometry, phongMaterial({ isTerrain: true }));
    this.mesh.name = 'terrain';
    this.mesh.updateMatrixWorld(true);
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.scene.add(this.mesh);
    this.ready.resolve();
  }
}
