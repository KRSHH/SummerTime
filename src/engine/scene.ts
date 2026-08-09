// Base scene: owns the follow camera, runs a warm-up "upload pass" that
// forces every material/texture into the GPU before the first visible frame,
// and drives the camera + per-frame callbacks from updateMatrixWorld.
// Port of the original `scene` class.

import {
  Scene,
  WebGLRenderTarget,
  type Camera,
  type Material,
  type Object3D,
  type Texture,
} from 'three';
import { deferred, type Deferred } from '../core/deferred';
import { clock } from './clock';
import { engine } from './globals';
import { FollowCamera } from './camera';
import { scheduleIdle } from '../core/idle';

interface UploadVars {
  cull: boolean;
  vis1: boolean;
  vis2: boolean;
  vis3?: boolean;
  vis4?: boolean;
  autoUpdate?: boolean;
}

export class BaseScene extends Scene {
  camera: FollowCamera;
  beforeRenderCbs: Array<() => void> = [];
  ready: Deferred<void> = deferred();
  uploaded: Deferred<void> = deferred();

  private _textures = new Set<Texture>();
  private _lastUpdate = -1;
  private _uploadRT: WebGLRenderTarget | null = null;

  constructor() {
    super();
    this.matrixWorldAutoUpdate = true;
    this.matrixAutoUpdate = false;
    this.camera = new FollowCamera();
    this.ready.then(() => this._upload());
  }

  /** Warm-up pass: render the whole scene twice into a dummy target so all
   *  programs compile and textures upload, then wait for every texture and
   *  force-init it. Guarantees no first-frame stalls. */
  private async _upload() {
    const renderer = engine.renderer;

    this.traverse((obj) => {
      const material = (obj as any).material as Material | undefined;
      if (material?.isMaterial) {
        if (obj.frustumCulled === true && (obj as any).geometry?.boundingSphere === null) {
          (obj as any).geometry.computeBoundingSphere();
        }
        const textures = collectMaterialTextures(material);
        for (const t of textures) {
          if ((t as any)._loaded) this._textures.add(t);
        }
        const vars: UploadVars = {
          cull: obj.frustumCulled,
          vis1: obj.visible,
          vis2: material.visible,
        };
        obj.frustumCulled = false;
        obj.visible = true;
        material.visible = true;
        const customDepth = (obj as any).customDepthMaterial as Material | undefined;
        if (customDepth) {
          vars.vis3 = customDepth.visible;
          customDepth.visible = true;
        }
        const customDistance = (obj as any).customDistanceMaterial as Material | undefined;
        if (customDistance) {
          vars.vis4 = customDistance.visible;
          customDistance.visible = true;
        }
        (obj as any).__uploadVars = vars;
      } else if ((obj as any).isLOD) {
        (obj as any).__uploadVars = { autoUpdate: (obj as any).autoUpdate };
        (obj as any).autoUpdate = false;
      }
    });

    const previousTarget = renderer.getRenderTarget();
    this._uploadRT ??= new WebGLRenderTarget(4, 4);
    renderer.setRenderTarget(this._uploadRT);
    renderer.render(this, this.camera as unknown as Camera);
    renderer.render(this, this.camera as unknown as Camera);
    renderer.setRenderTarget(previousTarget);

    this.traverse((obj) => {
      const vars = (obj as any).__uploadVars as UploadVars | undefined;
      if (!vars) return;
      const material = (obj as any).material as Material | undefined;
      if (material?.isMaterial) {
        obj.frustumCulled = vars.cull;
        obj.visible = vars.vis1;
        material.visible = vars.vis2;
        const customDepth = (obj as any).customDepthMaterial as Material | undefined;
        if (customDepth) customDepth.visible = vars.vis3 ?? true;
        const customDistance = (obj as any).customDistanceMaterial as Material | undefined;
        if (customDistance) customDistance.visible = vars.vis4 ?? true;
      } else if ((obj as any).isLOD) {
        (obj as any).autoUpdate = vars.autoUpdate ?? true;
      }
      delete (obj as any).__uploadVars;
    });

    if (this._textures.size === 0) {
      this.uploaded.resolve();
      return;
    }
    const pending = [...this._textures];
    await Promise.all(pending.map((t) => (t as any)._loaded));
    await new Promise<void>((resolve) => {
      const step = () => {
        const t = pending.shift();
        if (!t) {
          resolve();
          return;
        }
        renderer.initTexture(t);
        scheduleIdle(step);
      };
      step();
    });
    this.uploaded.resolve();
  }

  override updateMatrixWorld(force?: boolean): void {
    if (this._lastUpdate !== clock.time) {
      this._lastUpdate = clock.time;
      this.camera.updateCamera();
      for (const cb of this.beforeRenderCbs) cb();
    }
    super.updateMatrixWorld(force);
  }

  dispose() {
    this.beforeRenderCbs = [];
    for (const t of this._textures) t.dispose();
    this._textures.clear();
    this.traverse((obj) => {
      if ((obj as any).isScene) return;
      (obj as any).geometry?.dispose?.();
      const material = (obj as any).material as Material | undefined;
      if (material?.isMaterial) {
        for (const t of collectMaterialTextures(material)) t.dispose();
        material.dispose();
      }
    });
    this._uploadRT?.dispose();
  }
}

function collectMaterialTextures(material: Material): Texture[] {
  const out: Texture[] = [];
  const uniforms = (material as any).uniforms as Record<string, { value: unknown }> | undefined;
  if (uniforms) {
    for (const key of Object.keys(uniforms)) {
      const value = uniforms[key].value;
      if (value && (value as Texture).isTexture) out.push(value as Texture);
    }
  } else {
    for (const key of Object.keys(material)) {
      const value = (material as any)[key];
      if (value && (value as Texture).isTexture) out.push(value as Texture);
    }
  }
  return out;
}

// re-export for typing convenience
export type { Object3D };
