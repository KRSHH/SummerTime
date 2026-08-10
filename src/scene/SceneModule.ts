// Scene module base: every element of the world (sky, terrain, birds, ...)
// follows the same lifecycle, construct with the environment scene, load
// its assets, resolve `ready`.

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
