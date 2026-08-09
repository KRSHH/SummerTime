// Static structures: houses, warehouses, machines, lightposts (with their
// wires), parasol, sandcastles, road blockers.

import { InstancedMesh, Mesh } from 'three';
import { geometryLoader } from '../engine/loaders/geometries';
import { makeInstanced } from './helpers';
import { phongMaterial } from './materials';
import { SceneModule } from './SceneModule';

export class Houses extends SceneModule {
  meshes: Mesh[] = [];
  protected async init() {
    const geos = await Promise.all([
      geometryLoader.load('house1.bin'),
      geometryLoader.load('house2.bin'),
      geometryLoader.load('house3.bin'),
    ]);
    this.meshes = geos.map((geometry, i) => {
      const mesh = new Mesh(geometry, phongMaterial(i === 0 ? { isHouse: true } : { isHouse2: true }));
      mesh.name = `house${i}`;
      mesh.updateMatrixWorld(true);
      mesh.matrixWorldAutoUpdate = false;
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      this.scene.add(mesh);
      return mesh;
    });
    this.ready.resolve();
  }
}

export class Warehouses extends SceneModule {
  meshes: Mesh[] = [];
  protected async init() {
    const geos = await Promise.all([
      geometryLoader.load('warehouse1.bin'),
      geometryLoader.load('warehouse2.bin'),
      geometryLoader.load('warehouse3.bin'),
    ]);
    this.meshes = geos.map((geometry, i) => {
      const mesh = new Mesh(geometry, phongMaterial({ isWarehouse: true }));
      mesh.name = `warehouse${i}`;
      mesh.updateMatrixWorld(true);
      mesh.matrixWorldAutoUpdate = false;
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      this.scene.add(mesh);
      return mesh;
    });
    this.ready.resolve();
  }
}

export class Machines extends SceneModule {
  meshes: InstancedMesh[] = [];
  protected async init() {
    const patches = await geometryLoader.instancedPatches('machine.bin', 'machine-instances.bin', {
      maxPerPatch: 5,
      maxDistance: 30,
    });
    const material = phongMaterial({ isMachine: true });
    this.meshes = patches.map((geometry, i) => {
      const mesh = makeInstanced(geometry, material, 'machines');
      (mesh as any).ignore = i !== 0;
      this.scene.add(mesh);
      return mesh;
    });
    this.ready.resolve();
  }
}

export class Lightposts extends SceneModule {
  meshes: InstancedMesh[] = [];
  declare meshWire: Mesh;
  protected async init() {
    const patches = await geometryLoader.instancedPatches('lightpost.bin', 'lightposts-instances.bin', {
      maxPerPatch: 5,
      maxDistance: 30,
    });
    const material = phongMaterial({ isLightPost: true });
    this.meshes = patches.map((geometry, i) => {
      const mesh = makeInstanced(geometry, material, 'lightposts');
      (mesh as any).ignore = i !== 0;
      this.scene.add(mesh);
      return mesh;
    });

    const wires = await geometryLoader.load('lightposts-wires.bin');
    this.meshWire = new Mesh(wires, phongMaterial({ isWires: true }));
    this.meshWire.name = 'lightposts wires';
    this.meshWire.updateMatrixWorld(true);
    this.meshWire.matrixWorldAutoUpdate = false;
    this.meshWire.receiveShadow = true;
    this.meshWire.castShadow = true;
    this.scene.add(this.meshWire);
    this.ready.resolve();
  }
}

export class Parasols extends SceneModule {
  declare mesh: Mesh;
  protected async init() {
    const geometry = await geometryLoader.load('parasol.bin');
    this.mesh = new Mesh(geometry, phongMaterial({ isParasol: true }));
    this.mesh.name = 'parasol';
    this.mesh.updateMatrixWorld(true);
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.scene.add(this.mesh);
    this.ready.resolve();
  }
}

export class Castles extends SceneModule {
  meshes: Mesh[] = [];
  protected async init() {
    const geos = await Promise.all([geometryLoader.load('sandcastles1.bin'), geometryLoader.load('sandcastles2.bin')]);
    this.meshes = geos.map((geometry, i) => {
      const mesh = new Mesh(geometry, phongMaterial({ isCastles: true }));
      mesh.name = `castles${i}`;
      mesh.updateMatrixWorld(true);
      mesh.matrixWorldAutoUpdate = false;
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      this.scene.add(mesh);
      return mesh;
    });
    this.ready.resolve();
  }
}

export class Blockers extends SceneModule {
  meshes: Mesh[] = [];
  protected async init() {
    const geos = await Promise.all([geometryLoader.load('blockers1.bin'), geometryLoader.load('blockers2.bin')]);
    this.meshes = geos.map((geometry, i) => {
      const mesh = new Mesh(geometry, phongMaterial({ isBlocker: true }));
      mesh.name = `road blocker ${i}`;
      mesh.updateMatrixWorld(true);
      mesh.matrixWorldAutoUpdate = false;
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      this.scene.add(mesh);
      return mesh;
    });
    this.ready.resolve();
  }
}
