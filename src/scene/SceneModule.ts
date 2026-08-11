// Scene module base: construct with the scene, load assets, resolve `ready`.

import { deferred, type Deferred } from '../core/deferred';
import type { EnvironmentScene } from './environmentScene';

export abstract class SceneModule {
  readonly scene: EnvironmentScene;
  readonly ready: Deferred<void> = deferred();

  constructor(scene: EnvironmentScene) {
    this.scene = scene;
    this.init();
  }

  protected abstract init(): void;
}
