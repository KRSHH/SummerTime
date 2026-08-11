// The sun (port of `followCSMLight`): camera-following directional light with
// a custom cascaded shadow map (CSM) into LOD-level targets, blended in
// materials via `csmMap`/`csmMatrix`/... uniforms.

import {
  Color,
  DirectionalLight,
  Matrix4,
  MeshDepthMaterial,
  NearestFilter,
  OrthographicCamera,
  RGBADepthPacking,
  Sphere,
  Spherical,
  Vector3,
  WebGLRenderTarget,
} from 'three';
import { client } from '../core/client';
import { clock } from './clock';
import { engine } from './globals';
import type { BaseScene } from './scene';

const depthMaterial = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });

function setOrthographicFrustum(camera: OrthographicCamera, size: number): void {
  camera.left = -size;
  camera.right = size;
  camera.top = size;
  camera.bottom = -size;
  camera.updateProjectionMatrix();
}

export interface FollowSunLightOptions {
  color?: string;
  intensity?: number;
  scene: BaseScene;
  positionOffset?: Spherical;
  forwardOffset?: number;
  castShadow?: boolean;
  shadowMapSize?: number;
  shadowSize?: number;
  csm?: boolean;
  csmMapSize?: number;
  csmBoundingSphere?: Sphere;
  csmNear?: number;
  csmLODLevel?: number;
  cameraLayer?: number;
  skipCSMMeshes?: Array<{ uuid: string }>;
}

export class FollowSunLight extends DirectionalLight {
  csmMaps: WebGLRenderTarget[] = [];
  csmMatrix = new Matrix4();

  private _scene: BaseScene;
  private _camera: BaseScene['camera'];
  private _offset: Vector3;
  private _forwardOffset: number;
  private _shadowMapSize: number;
  private _lastLightUpdate = -1;

  private _v0 = new Vector3();

  constructor(options: FollowSunLightOptions) {
    super(options.color ?? '#ffffff', options.intensity ?? 1);
    if (!options.scene) throw new Error('Follow CSM light requires a scene');
    this.name = 'followCSM';
    this._scene = options.scene;
    this._camera = this._scene.camera;
    this._offset = new Vector3().setFromSpherical(options.positionOffset ?? new Spherical(2, Math.PI * 0.2, 0));
    this._forwardOffset = options.forwardOffset ?? 5;
    this._shadowMapSize = options.shadowMapSize ?? 2048;
    this.castShadow = options.castShadow ?? true;
    this.shadow.mapSize.width = this._shadowMapSize;
    this.shadow.mapSize.height = this._shadowMapSize;
    setOrthographicFrustum(this.shadow.camera, options.shadowSize ?? 12);

    if (options.csm !== false) {
      this._setupCSM(options);
    }
  }

  private _setupCSM(options: FollowSunLightOptions) {
    const levels = options.csmLODLevel ?? 1;
    const mapSize = Math.min(
      client.device === 'mobile' ? 4096 : 8192,
      engine.renderer.capabilities.maxTextureSize,
    );
    const cameraLayer = options.cameraLayer ?? 30;
    const boundingSphere = options.csmBoundingSphere ?? new Sphere(new Vector3(), 1);

    this.csmMaps = Array.from({ length: levels }, () => new WebGLRenderTarget(mapSize, mapSize, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    }));

    const csmCamera = new OrthographicCamera();
    const spherical = new Spherical().copy(options.positionOffset ?? new Spherical(2, Math.PI * 0.2, 0));
    spherical.radius = Math.max(spherical.radius, boundingSphere.radius);
    csmCamera.position.copy(boundingSphere.center).add(this._v0.setFromSpherical(spherical));
    csmCamera.lookAt(boundingSphere.center);
    csmCamera.near = options.csmNear ?? 1;
    csmCamera.far = spherical.radius * 2 - (options.csmNear ?? 1);
    setOrthographicFrustum(csmCamera, spherical.radius);
    csmCamera.updateMatrixWorld();
    csmCamera.layers.set(cameraLayer);

    this.csmMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.csmMatrix.multiply(csmCamera.projectionMatrix);
    this.csmMatrix.multiply(csmCamera.matrixWorldInverse);

    const skip = options.skipCSMMeshes ?? [];
    const renderer = engine.renderer;

    // swap every cast-shadow material for its depth variant
    this._scene.traverse((obj) => {
      const material = (obj as any).material as any;
      if (material?.isMaterial) {
        if ((obj.visible || (obj.parent as any)?.isLOD) && obj.castShadow && !skip.some((s) => s.uuid === obj.uuid)) {
          (obj as any).__prevMaterial = material;
          (obj as any).material = (obj as any).customDepthMaterial ?? depthMaterial;
          obj.layers.enable(cameraLayer);
        }
      }
      if ((obj as any).isLOD) {
        (obj as any).__prevAutoUpdate = (obj as any).autoUpdate;
        (obj as any).autoUpdate = false;
      }
    });

    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    const previousClearColor = renderer.getClearColor(new Color()).clone();
    const previousClearAlpha = renderer.getClearAlpha();

    for (let i = 0; i < this.csmMaps.length; i++) {
      // show only the LOD level matching this cascade
      this._scene.traverse((obj) => {
        if ((obj as any).isLOD) {
          (obj as any).levels.forEach((level: any, index: number) => {
            level.object.visible = index === i;
          });
        }
      });
      renderer.setRenderTarget(this.csmMaps[i]);
      renderer.autoClear = false;
      renderer.setClearColor('#ffffff', 1);
      renderer.clear(true, true, false);
      renderer.render(this._scene, csmCamera);
    }

    renderer.setClearColor(previousClearColor, previousClearAlpha);
    renderer.autoClear = previousAutoClear;
    renderer.setRenderTarget(previousTarget);

    // restore materials and wire the CSM uniforms
    this._scene.traverse((obj) => {
      if ((obj as any).isLOD) {
        (obj as any).autoUpdate = (obj as any).__prevAutoUpdate ?? true;
        delete (obj as any).__prevAutoUpdate;
      }
      if ((obj as any).__prevMaterial) {
        (obj as any).material = (obj as any).__prevMaterial;
        delete (obj as any).__prevMaterial;
      }
      if (((obj.layers as any).mask & (1 << cameraLayer)) !== 0) obj.layers.disable(cameraLayer);
      const material = (obj as any).material as any;
      if (!material?.isMaterial) return;
      const uniforms = material.uniforms;
      if (!uniforms) return;
      if (uniforms.csmMap) {
        if ((obj.parent as any)?.isLOD) {
          const levelIndex = (obj.parent as any).levels.findIndex((l: any) => l.object === obj);
          uniforms.csmMap.value = this.csmMaps[levelIndex >= 0 && levelIndex < this.csmMaps.length ? levelIndex : 0].texture;
        } else {
          uniforms.csmMap.value = this.csmMaps[0].texture;
        }
      }
      if (uniforms.csmMatrix?.value) uniforms.csmMatrix.value.copy(this.csmMatrix);
      if (uniforms.csmOptions?.value) {
        uniforms.csmOptions.value.set(mapSize, 1, (options.shadowSize ?? 12) * 0.75, options.shadowSize ?? 12);
      }
      if (uniforms.csmTarget?.value) uniforms.csmTarget.value = this.target.position;
    });
  }

  override updateMatrixWorld(force?: boolean): void {
    if (this._lastLightUpdate !== clock.time) {
      this._lastLightUpdate = clock.time;
      this.target.position.copy(this._camera.target);
      this.target.position.addScaledVector(
        this._v0.copy(this._camera.target).sub(this._camera.position).normalize(),
        this._forwardOffset,
      );
      this.target.updateMatrixWorld();
      this.position.copy(this.target.position).add(this._offset);

      // adapt shadow map resolution with adaptive DPR
      if (engine.adaptiveMultiplier < 0.9) {
        if (this.shadow.mapSize.width > this._shadowMapSize * 0.5) {
          this.shadow.mapSize.width = this._shadowMapSize * 0.5;
          this.shadow.mapSize.height = this._shadowMapSize * 0.5;
          this.shadow.map?.dispose();
          (this.shadow as any).map = null;
        }
      } else if (this.shadow.mapSize.width < this._shadowMapSize) {
        this.shadow.mapSize.width = this._shadowMapSize;
        this.shadow.mapSize.height = this._shadowMapSize;
        this.shadow.map?.dispose();
        (this.shadow as any).map = null;
      }
    }
    super.updateMatrixWorld(force);
  }
}

