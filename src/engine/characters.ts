// Instanced skinned character system. Port of the original
// `characterSkinnedMesh` + `characters$1`: up to 128 characters sharing one
// skinned mesh, per-instance bone matrices baked into a texture atlas,
// blended animation clips (idle/run/air/bored), local player physics +
// controls, and networked remote characters via the realm connection.

import {
  AnimationClip,
  AnimationMixer,
  DataTexture,
  FloatType,
  Frustum,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  RGBAFormat,
  Spherical,
  Vector3,
} from 'three';
import { events } from '../core/events';
import { deferred, type Deferred } from '../core/deferred';
import { ceilPowerOfTwo, clamp, fit, frictionFPS, HALF_PI, lerp, lerpCoefFPS, ratioFPS, TWO_PI } from '../core/math';
import { gsap } from 'gsap';
import { ticker } from '../core/ticker';
import { clock } from './clock';
import type { FollowCamera } from './camera';
import { Controls } from './controls';
import { CollisionPhysics } from './physics';
import { quaternionFromSpherical } from './quaternion';
import { P2PConnection, type P2PClientData } from './multiplayer/iroh';

const MAX_CHARS = 128;
const SECURE_EPS = 1e-4;

function secureLerp(v: number): number {
  return v > 0.9999 ? 1 : v < SECURE_EPS ? 0 : v;
}

/** Deep-clone an Object3D tree keeping skinned-mesh bone references intact. */
function cloneWithSkeleton(source: Object3D): Object3D {
  const sourceToClone = new Map<Object3D, Object3D>();
  const cloneToSource = new Map<Object3D, Object3D>();
  const result = source.clone();

  const parallelTraverse = (a: Object3D, b: Object3D, cb: (a: Object3D, b: Object3D) => void) => {
    cb(a, b);
    for (let i = 0; i < a.children.length; i++) {
      parallelTraverse(a.children[i], b.children[i], cb);
    }
  };
  parallelTraverse(source, result, (a, b) => {
    sourceToClone.set(b, a);
    cloneToSource.set(a, b);
  });

  result.traverse((obj) => {
    const skinned = obj as any;
    if (!skinned.isSkinnedMesh) return;
    const original = sourceToClone.get(obj) as any;
    skinned.skeleton = original.skeleton.clone();
    skinned.bindMatrix.copy(original.bindMatrix);
    skinned.skeleton.bones = original.skeleton.bones.map((bone: Object3D) => cloneToSource.get(bone));
    skinned.bind(skinned.skeleton, skinned.bindMatrix);
  });
  return result;
}

export interface CharacterLocal extends Object3D {
  instanceID: number;
  userData: Record<string, any>;
  acceleration: Vector3;
  velocity: Vector3;
  velocityHorizontal: number;
  spherical: Spherical;
  targetSpherical: Spherical;
  initialPosition: Vector3;
  isOnFloor: boolean;
  jumpRequested: boolean;
  animationOffset: number;
  animationWeights: number[];
  targetPosition?: Vector3;
  targetRotation?: Quaternion;
  mesh: Object3D;
}

export interface CharacterInstance {
  _localObject: CharacterLocal;
  _update(): void;
  _controls: Controls;
  _collisionPhysics: CollisionPhysics;
  _camera: { spherical: Spherical; isFollowCamera?: boolean; isPerspectiveCamera: boolean };
}

export interface CharacterOptions {
  animationsOptions?: Array<{ speed: number }>;
  colliderMesh: Mesh;
  radiusPercentage?: number;
  floorDetectInclination?: number;
  positionForce?: number;
  damp?: number;
  initialPosition?: number[];
  initialRadius?: number;
  camera: FollowCamera;
  relativeCameraPosition?: Vector3;
  lookatMeshOffset?: Vector3;
  skinShadows?: boolean;
  initialData?: Record<string, unknown>;
  positionCharLerp?: number;
  rotationCharLerp?: number;
  animationCharLerp?: number;
  remoteDamp?: number;
  positionDeltaLimitSnap?: number;
  inactiveTime?: number;
  customAttribUpdate?: (
    local: CharacterLocal,
    clientId: string,
    instanceId: number,
    visible: boolean,
    lerp: number,
  ) => void;
}

export class CharacterSkinnedMesh extends InstancedMesh {
  skeleton!: ReturnType<typeof cloneWithSkeleton> extends never ? never : any;
  actions: Array<{ setEffectiveWeight(w: number): void; setEffectiveTimeScale(s: number): void; enabled: boolean; play(): void }> = [];

  private _mixer: AnimationMixer;
  private _boneMatrix = new Matrix4();
  declare _localObject: CharacterLocal;

  constructor(
    skinnedMesh: import('three').SkinnedMesh,
    clips: AnimationClip[],
    options: { animationsOptions?: Array<{ speed: number }>; skinShadows?: boolean },
  ) {
    super(createInstancedGeometry(skinnedMesh.geometry), skinnedMesh.material, MAX_CHARS);
    (this as any).isSkinnedMesh = true;
    this.frustumCulled = false;
    this.matrixWorldAutoUpdate = false;
    (this as any).customDepthMaterial = (skinnedMesh as any).customDepthMaterial;
    (this as any).customDistanceMaterial = (skinnedMesh as any).customDistanceMaterial;
    this.receiveShadow = options.skinShadows !== false;
    this.castShadow = options.skinShadows !== false;

    const clone = cloneWithSkeleton(skinnedMesh) as import('three').SkinnedMesh;
    (this as any).bindMode = clone.bindMode;
    (this as any).bindMatrix = clone.bindMatrix;
    (this as any).bindMatrixInverse = clone.bindMatrixInverse;
    this.skeleton = clone.skeleton;
    clone.children.forEach((child) => this.add(child));

    this._mixer = new AnimationMixer(this);
    const animOptions = options.animationsOptions ?? [];
    this.actions = clips.map((clip, i) => {
      const action = this._mixer.clipAction(clip);
      action.setEffectiveTimeScale(animOptions[i]?.speed ?? 1);
      action.play();
      action.enabled = false;
      return action;
    });

    // Per-instance bone matrices as a texture (boneTextureSize x MAX_CHARS)
    const boneTextureSize = ceilPowerOfTwo(this.skeleton.bones.length * 4);
    const charSize = ceilPowerOfTwo(MAX_CHARS);
    const data = new Float32Array(boneTextureSize * charSize * 4);
    const boneTexture = new DataTexture(data, boneTextureSize, charSize, RGBAFormat, FloatType);
    boneTexture.needsUpdate = true;
    (this.skeleton as any).boneMatrices = data;
    (this.skeleton as any).boneTexture = boneTexture;
    (this.skeleton as any).boneTextureSize = boneTextureSize;
    (this.skeleton as any).computeBoneTexture = () => {};
    (this.skeleton as any).update = () => {};
  }

  /** Update animation weights + write bone matrices for one character instance. */
  _updateAnimations(local: CharacterLocal, inView: boolean, frameLerp: number) {
    const weights = local.animationWeights;
    const speedFactor = fit(local.velocityHorizontal, 0.001, 0.045, 1, 0);
    weights[0] = secureLerp(lerp(weights[0], speedFactor, frameLerp));
    weights[1] = 1 - weights[0];
    for (let i = 2; i < weights.length; i++) {
      const active = local.userData.a === i - 1;
      weights[i] = secureLerp(lerp(weights[i], active ? 1 : 0, frameLerp));
    }

    if (local.instanceID !== 0 && (!inView || local.position.distanceTo(this._localObject.position) > 100)) {
      return;
    }

    this.actions.forEach((action, i) => {
      let otherWeight = 0;
      for (let w = weights.length - 1; w > Math.max(1, i); w--) otherWeight += weights[w];
      const base = 1 - clamp(otherWeight, 0, 1);
      const weight = weights[i] * base;
      action.enabled = weight > 0;
      action.setEffectiveWeight(weight);
    });
    this._mixer.setTime(ticker.time + local.animationOffset);
    this.children.forEach((child) => child.updateMatrixWorld());

    const offset = local.instanceID * this.skeleton.boneTextureSize * 4;
    for (let b = 0; b < this.skeleton.bones.length; b++) {
      this._boneMatrix.multiplyMatrices(this.skeleton.bones[b].matrixWorld, this.skeleton.boneInverses[b]);
      this._boneMatrix.toArray(this.skeleton.boneMatrices, offset + b * 16);
    }
  }

  override updateMatrixWorld(force?: boolean): void {
    super.updateMatrixWorld(force);
    const bindMode = (this as any).bindMode;
    if (bindMode === 'attached') {
      (this as any).bindMatrixInverse.copy(this.matrixWorld).invert();
    } else if (bindMode === 'detached') {
      (this as any).bindMatrixInverse.copy((this as any).bindMatrix).invert();
    }
  }
}

function createInstancedGeometry(geometry: import('three').BufferGeometry): InstancedBufferGeometry {
  const result = new InstancedBufferGeometry();
  const clone = geometry.clone();
  if (clone.index) result.setIndex(clone.index);
  for (const name of Object.keys(clone.attributes)) {
    result.setAttribute(name, clone.attributes[name]);
  }
  result.setAttribute(
    'instanceID',
    new InstancedBufferAttribute(new Int32Array(Array.from({ length: MAX_CHARS }, (_, i) => i)), 1),
  );
  return result;
}

/** The character system: local player + networked remotes, one instanced mesh. */
export class Characters extends CharacterSkinnedMesh {
  count = 1;
  connected: Deferred<void> = deferred();
  _controls!: Controls;
  _collisionPhysics!: CollisionPhysics;
  _camera!: FollowCamera;

  private _charactersObjects = new Map<string, CharacterLocal>();
  private _connection!: P2PConnection;
  private _positionCharLerp: number;
  private _rotationCharLerp: number;
  private _animationCharLerp: number;
  private _remoteCharDamp: number;
  private _positionDeltaLimitSnap: number;
  private _customAttribUpdate: CharacterOptions['customAttribUpdate'];
  private _inactiveTime: number;
  private _inactiveMilliseconds = 0;
  private _dataUpdate = { p: [0, 0, 0], r: [0, 0], a: 0 } as P2PClientData;

  private _v0 = new Vector3();
  private _v1 = new Vector3();
  private _v2 = new Vector3();
  private _q0 = new Quaternion();
  private _f0 = new Frustum();
  private _m0 = new Matrix4();

  constructor(
    skinnedMesh: import('three').SkinnedMesh,
    clips: AnimationClip[],
    options: CharacterOptions = {} as CharacterOptions,
  ) {
    super(skinnedMesh, clips, options);
    this.name = 'Characters';
    this._positionCharLerp = options.positionCharLerp ?? 0.4;
    this._rotationCharLerp = options.rotationCharLerp ?? 0.4;
    this._animationCharLerp = options.animationCharLerp ?? 0.1;
    this._remoteCharDamp = options.remoteDamp ?? 0.625;
    this._positionDeltaLimitSnap = options.positionDeltaLimitSnap ?? 10;
    this._customAttribUpdate = options.customAttribUpdate;
    this._inactiveTime = (options.inactiveTime ?? 60) * 1000;
    this._camera = options.camera;

    this._localObject = new Object3D() as CharacterLocal;
    this._localObject.instanceID = 0;
    this._localObject.userData = { a: 0, ...(options.initialData ?? {}) };
    this._localObject.acceleration = new Vector3();
    this._localObject.velocity = new Vector3();
    this._localObject.velocityHorizontal = 0;
    this._localObject.spherical = new Spherical(1, HALF_PI);
    this._localObject.targetSpherical = this._camera.spherical.clone();
    this._localObject.targetSpherical.phi = HALF_PI;
    this._localObject.initialPosition = new Vector3();
    this._localObject.isOnFloor = false;
    this._localObject.jumpRequested = false;
    this._localObject.animationOffset = Math.random() * 100;
    this._localObject.animationWeights = this.actions.map((_, i) => (i === 0 ? 1 : 0));
    (this._localObject as any).mesh = this;
    this._charactersObjects.set('local', this._localObject);

    this._controls = new Controls(this as unknown as CharacterInstance, {
      mouseToggleCb: (active) => events.emit('webgl_mouse_toggle', active),
    });
    this._collisionPhysics = new CollisionPhysics(this as unknown as CharacterInstance, {
      colliderMesh: options.colliderMesh,
      radiusPercentage: options.radiusPercentage,
      floorDetectInclination: options.floorDetectInclination,
      positionForce: options.positionForce,
      damp: options.damp,
      onCollisionsReady: () => {
        this._setInitialPosition(options.initialPosition ?? [0, 0, 0], options.initialRadius ?? 2);
        (this._camera as any).isFollowCamera && this._camera.follow({
          mesh: this as unknown as any,
          relativeCameraPosition: options.relativeCameraPosition,
          lookatMeshOffset: options.lookatMeshOffset,
        });
        // Join the single shared P2P room (iroh-gossip over WebAssembly,
        // hardcoded room, no server) and mirror remote characters.
        this._connection = new P2PConnection({
          data: this._dataUpdate,
          onConnect: () => this.connected.resolve(),
          addClient: (id, data) => this._addCharacter(id, data),
          removeClient: (id) => this._removeCharacter(id),
          removeAllClients: () => this._removeAllCharacters(),
        });
      },
    });
  }

  update() {
    if (!this._collisionPhysics.collider) return;
    const delta = clock.delta;
    const ratio = ratioFPS();
    const positionLerp = lerpCoefFPS(this._positionCharLerp);
    const rotationLerp = lerpCoefFPS(this._rotationCharLerp);
    const animLerp = lerpCoefFPS(this._animationCharLerp);
    const remoteDamp = frictionFPS(this._remoteCharDamp);

    const move = this._controls.update();
    this._collisionPhysics.update(move, rotationLerp);
    this._localObject.updateMatrixWorld();

    if (this._localObject.velocity.manhattanLength() < 1e-5) {
      this._inactiveMilliseconds += delta;
      if (this._inactiveMilliseconds > this._inactiveTime && this._localObject.userData.a === 0) {
        this._localObject.userData.a = 2;
      }
    } else {
      this._inactiveMilliseconds = 0;
      if (this._localObject.userData.a === 2) this._localObject.userData.a = 0;
    }

    // publish local state to the realm
    this._dataUpdate.p = this._localObject.position.toArray().map((v) => +Number(v).toFixed(2));
    this._dataUpdate.r = [
      +Number(this._localObject.spherical.phi % TWO_PI).toFixed(2),
      +Number(this._localObject.spherical.theta % TWO_PI).toFixed(2),
    ];
    this._dataUpdate.a = this._localObject.userData.a;
    this._dataUpdate.seed = this._localObject.userData.seed;
    if (this._connection) {
      (this._connection as any)._data = this._dataUpdate;
    }

    if (this._camera.isPerspectiveCamera) {
      this._m0.multiplyMatrices(this._camera.projectionMatrix, this._camera.matrixWorldInverse);
      this._f0.setFromProjectionMatrix(this._m0);
    }

    const snap = delta > 2000;
    const posLerp = snap ? 1 : positionLerp;
    const rotLerp = snap ? 1 : rotationLerp;
    const animFactor = snap ? 0 : 1;

    let instance = 0;
    this._charactersObjects.forEach((remote, id) => {
      if (instance > 0) {
        const clientData = this._connection?._clients.get(id);
        if (clientData) {
          for (const key of Object.keys(clientData)) {
            if (key === 'p') {
              const p = clientData.p as number[];
              if (p.length !== 3) continue;
              this._v1.copy(remote.position);
              this._v0.fromArray(p);
              const teleport = this._v0.distanceTo(this._v1) > this._positionDeltaLimitSnap;
              const lerpAmount = teleport ? 1 : posLerp;
              const dampFactor = teleport ? 0 : 1;
              (remote.targetPosition ??= new Vector3()).lerp(this._v0, lerpAmount);
              remote.position.lerp((remote as any).targetPosition, lerpAmount);
              remote.velocity.add(this._v2.subVectors(remote.position, this._v1).multiplyScalar(ratio));
              remote.velocity.multiplyScalar(remoteDamp * animFactor * dampFactor);
              remote.velocityHorizontal = this._v0.copy(remote.velocity).setY(0).length();
            } else if (key === 'r') {
              const r = clientData.r as number[];
              if (r.length !== 2) continue;
              remote.spherical.phi = r[0];
              remote.spherical.theta = r[1];
              quaternionFromSpherical(remote.spherical, this._q0);
              (remote.targetRotation ??= new Quaternion()).slerp(this._q0, rotLerp);
              remote.quaternion.slerp(remote.targetRotation as Quaternion, rotLerp);
            } else {
              remote.userData[key] = clientData[key];
            }
          }
        }
      }
      this._collisionPhysics.boundingSphere.center.add(remote.position);
      const visible = this._camera.isPerspectiveCamera
        ? this._f0.intersectsSphere(this._collisionPhysics.boundingSphere)
        : true;
      this._collisionPhysics.boundingSphere.center.copy(this._collisionPhysics.boundingSphereOriginalCenter);
      this._customAttribUpdate?.(remote, id, instance, visible, animLerp);
      remote.updateMatrix();
      this.setMatrixAt(instance++, remote.matrix);
      this._updateAnimations(remote, visible, animLerp);
    });
    this.instanceMatrix.needsUpdate = true;
    this.skeleton.boneTexture.needsUpdate = true;
  }

  private _updateCharacterIDs() {
    let i = 0;
    this._charactersObjects.forEach((obj) => {
      obj.instanceID = i++;
    });
  }

  private _addCharacter(id: string, data: P2PClientData) {
    const remote = new Object3D() as CharacterLocal;
    remote.spherical = new Spherical(1, HALF_PI);
    remote.targetPosition = new Vector3();
    remote.targetRotation = new Quaternion();
    remote.velocity = new Vector3();
    remote.velocityHorizontal = 0;
    remote.userData = { a: 0 };
    remote.animationOffset = Math.random() * 100;
    remote.animationWeights = this.actions.map((_, i) => (i === 0 ? 1 : 0));
    for (const key of Object.keys(data)) {
      if (key === 'p') {
        const p = data.p as number[];
        if (p.length !== 3) continue;
        remote.position.fromArray(p);
        remote.targetPosition.copy(remote.position);
      } else if (key === 'r') {
        const r = data.r as number[];
        if (r.length !== 2) continue;
        remote.spherical.phi = r[0] || HALF_PI;
        remote.spherical.theta = r[1] || 0;
        quaternionFromSpherical(remote.spherical, remote.targetRotation);
        remote.quaternion.copy(remote.targetRotation);
      } else {
        remote.userData[key] = data[key];
      }
    }
    this._charactersObjects.set(id, remote);
    this._updateCharacterIDs();
    this.count++;
    gsap.fromTo(
      remote.scale,
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 1, ease: 'power2.out', duration: 0.35 },
    );
  }

  private _removeCharacter(id: string) {
    const remote = this._charactersObjects.get(id);
    if (!remote) return;
    this._charactersObjects.delete(id);
    this._updateCharacterIDs();
    this.count = Math.max(1, this.count - 1);
  }

  private _removeAllCharacters() {
    this._charactersObjects.clear();
    this._updateCharacterIDs();
    this._charactersObjects.set('local', this._localObject);
    this.count = 1;
  }

  private _setInitialPosition(position: number[], radius: number) {
    if (!this._collisionPhysics.collider) return;
    this._v0.set(
      (Math.random() * 2 - 1) * radius,
      (Math.random() * 2 - 1) * radius,
      (Math.random() * 2 - 1) * radius,
    );
    this._v1.fromArray(position).add(this._v0);
    const closest = this._collisionPhysics.boundsTree.closestPointToPoint(this._v1);
    this._localObject.initialPosition.copy(closest.point);
    this.snap(this._localObject.initialPosition.toArray());
  }

  snap(position: number[] = [0, 0, 0]) {
    this._localObject.position.fromArray(position);
    this._localObject.velocity.setScalar(0);
    this._localObject.velocityHorizontal = 0;
    this._localObject.acceleration.setScalar(0);
  }

  dispose() {
    (this.skeleton as any).dispose?.();
    this._controls.disable();
    this._connection?._dispose();
    this._collisionPhysics.geometry?.dispose();
  }
}
