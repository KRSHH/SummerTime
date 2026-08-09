// Planar reflector. Port of the original `reflector` class (planar
// reflection with oblique clipping plane), used by the sea.

import {
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  Plane,
  sRGBEncoding,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
} from 'three';
import type { BufferGeometry, Material, WebGLRenderer } from 'three';

export interface ReflectorOptions {
  textureSize?: number;
  samples?: number;
  clipBias?: number;
  mirrorCameraZoom?: number;
  meshNormal?: Vector3;
  cameraLayer?: number;
  onBeforeReflectorRender?: (reflector: Reflector) => void;
  onAfterReflectorRender?: (reflector: Reflector) => void;
  reflectedMeshes?: Mesh[];
}

export class Reflector extends Mesh {
  camera = new PerspectiveCamera(50, 1, 0.1, 2000);

  private _textureMatrix = new Matrix4();
  private _reflectedRT: WebGLRenderTarget;
  private _clipBias: number;
  private _mirrorCameraZoom: number;
  private _meshNormal: Vector3;
  private _cameraLayer: number;
  private _onBeforeReflectorRender?: (reflector: Reflector) => void;
  private _onAfterReflectorRender?: (reflector: Reflector) => void;

  private _plane = new Plane();
  private _v0 = new Vector3();
  private _v1 = new Vector3();
  private _v2 = new Vector3();
  private _m = new Matrix4();
  private _normal = new Vector3(0, 0, -1);
  private _w = new Vector4();
  private _viewPosition = new Vector3();
  private _viewDir = new Vector3();
  private _clipPlane = new Vector4();

  constructor(options: ReflectorOptions = {}, geometry: BufferGeometry, material: Material) {
    super(geometry, material);

    const textureSize = options.textureSize && isPowerOfTwo(options.textureSize) ? options.textureSize : 1024;
    this._reflectedRT = new WebGLRenderTarget(textureSize, textureSize, {
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: true,
      samples: options.samples ?? 0,
      type: HalfFloatType,
      encoding: sRGBEncoding,
    });

    this._clipBias = options.clipBias ?? 0;
    this._mirrorCameraZoom = options.mirrorCameraZoom ?? 1;
    this._meshNormal = options.meshNormal ?? new Vector3(0, 0, 1);
    this._cameraLayer = options.cameraLayer ?? 31;
    this._onBeforeReflectorRender = options.onBeforeReflectorRender;
    this._onAfterReflectorRender = options.onAfterReflectorRender;
    options.reflectedMeshes?.forEach((m) => this.addReflectedObject(m));

    // feed the reflection into the material uniforms
    const uniforms = (material as any).uniforms as Record<string, { value: unknown }> | undefined;
    if (uniforms) {
      const set = (name: string, value: unknown) => {
        if (uniforms[name]) uniforms[name].value = value;
        else uniforms[name] = { value };
      };
      set('tReflection', this._reflectedRT.texture);
      set('textureMatrix', this._textureMatrix);
      set('uReflectionResolution', new Vector2(textureSize, textureSize));
    }

    this.onBeforeRender = this._renderReflection;
  }

  private _renderReflection = (renderer: WebGLRenderer, scene: any, camera: any) => {
    if ('matrixWorldNeedsUpdate' in this) this.updateMatrixWorld();

    // world position of the reflector and the camera
    this._v0.setFromMatrixPosition(this.matrixWorld);
    this._v1.setFromMatrixPosition(camera.matrixWorld);

    // skip when the reflector faces away from the camera
    this._m.extractRotation(this.matrixWorld);
    this._v2.copy(this._meshNormal).applyMatrix4(this._m);
    const viewToReflector = this._viewPosition.subVectors(this._v0, this._v1);
    if (viewToReflector.dot(this._v2) > 0) return;

    // mirror the camera position and orientation across the reflector plane
    viewToReflector.reflect(this._v2).negate();
    viewToReflector.add(this._v0);
    this._m.extractRotation(camera.matrixWorld);
    this._normal.set(0, 0, -1).applyMatrix4(this._m).add(this._v1);
    this._viewDir.subVectors(this._v0, this._normal).reflect(this._v2).negate().add(this._v0);
    this.camera.copy(camera);
    this.camera.position.copy(viewToReflector);
    this.camera.up.set(0, 1, 0).applyMatrix4(this._m).reflect(this._v2);
    this.camera.lookAt(this._viewDir);
    this.camera.zoom *= this._mirrorCameraZoom;
    this.camera.updateMatrixWorld();
    this.camera.updateProjectionMatrix();
    this.camera.layers.set(this._cameraLayer);

    // texture matrix for projecting the reflection in the material
    this._textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this._textureMatrix.multiply(this.camera.projectionMatrix);
    this._textureMatrix.multiply(this.camera.matrixWorldInverse);
    this._textureMatrix.multiply(this.matrixWorld);

    // oblique clipping plane
    this._plane.setFromNormalAndCoplanarPoint(this._v2, this._v0);
    this._plane.applyMatrix4(this.camera.matrixWorldInverse);
    this._clipPlane.set(this._plane.normal.x, this._plane.normal.y, this._plane.normal.z, this._plane.constant);
    const projectionMatrix = this.camera.projectionMatrix;
    this._w.x = (Math.sign(this._clipPlane.x) + projectionMatrix.elements[8]) / projectionMatrix.elements[0];
    this._w.y = (Math.sign(this._clipPlane.y) + projectionMatrix.elements[9]) / projectionMatrix.elements[5];
    this._w.z = -1;
    this._w.w = (1 + projectionMatrix.elements[10]) / projectionMatrix.elements[14];
    this._clipPlane.multiplyScalar(2 / this._clipPlane.dot(this._w));
    projectionMatrix.elements[2] = this._clipPlane.x;
    projectionMatrix.elements[6] = this._clipPlane.y;
    projectionMatrix.elements[10] = this._clipPlane.z + 1 - this._clipBias;
    projectionMatrix.elements[14] = this._clipPlane.w;

    // render the scene from the mirrored camera into the target
    this.visible = false;
    this._onBeforeReflectorRender?.(this);
    const currentTarget = renderer.getRenderTarget();
    const xrEnabled = renderer.xr.enabled;
    const shadowAutoUpdate = renderer.shadowMap.autoUpdate;
    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this._reflectedRT);
    renderer.state.buffers.depth.setMask(true);
    if (renderer.autoClear === false) renderer.clear();
    renderer.render(scene, this.camera);
    renderer.xr.enabled = xrEnabled;
    renderer.shadowMap.autoUpdate = shadowAutoUpdate;
    renderer.setRenderTarget(currentTarget);
    this.visible = true;
    this._onAfterReflectorRender?.(this);
  };

  addReflectedObject(object: Mesh) {
    object.layers.enable(this._cameraLayer);
  }

  removeReflectedObject(object: Mesh) {
    object.layers.disable(this._cameraLayer);
  }
}

function isPowerOfTwo(value: number): boolean {
  return (value & (value - 1)) === 0 && value !== 0;
}
