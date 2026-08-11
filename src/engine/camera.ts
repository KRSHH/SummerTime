// Follow camera (merged port of `baseCamera`/`orbitCamera`/`followCamera`):
// spherical orbit around a followed mesh, lerped pos/target/rot, parallax,
// shake, collision zoom.

import {
  Matrix4,
  PerspectiveCamera,
  Quaternion,
  Spherical,
  Vector2,
  Vector3,
} from 'three';
import { client } from '../core/client';
import { events } from '../core/events';
import { clamp, fit, getShortestRotationAngle, lerp, lerpCoefFPS, lerpFPS } from '../core/math';
import { clock } from './clock';
import { touches } from './input';
import type { CollisionPhysics } from './physics';

const EPS = 1e-6;
const HALF_PI = Math.PI * 0.5;
const ZERO_V2 = new Vector2();
const UP = new Vector3(0, 1, 0);

/** Deterministic noise used for the camera shake. */
function sineNoise1(x: number, y: number, z: number): number {
  const dir = new Vector3();
  const p = new Vector3(x, y, z);
  let r = 0;
  r += Math.sin(p.dot(dir.set(1.5, 3.4598, 1.234)));
  r += Math.sin(p.dot(dir.set(3.12, -3.234, 4.221)));
  r += Math.sin(p.dot(dir.set(0.355, 2.3, -1.375)));
  r += Math.sin(p.dot(dir.set(-0.156, -3.34, -0.4566)));
  r += Math.sin(p.dot(dir.set(-4.1235, -0.485, -1.45)));
  r += Math.sin(p.dot(dir.set(2.54, -0.879, -2.123)));
  return r / 6;
}

/** Minimal surface of the followed character used by the camera. */
export interface CharacterLike {
  _localObject: {
    position: Vector3;
    spherical: Spherical;
    targetSpherical: Spherical;
  };
  _collisionPhysics: CollisionPhysics;
}

export interface FollowOptions {
  mesh?: CharacterLike | null;
  relativeCameraPosition?: Vector3;
  lookatMeshOffset?: Vector3;
  cameraCollisions?: boolean;
  cameraRotationLerp?: number;
  cameraInactiveMultiplier?: number;
}

export class FollowCamera extends PerspectiveCamera {
  isFollowCamera = true;

  target = new Vector3();
  basePosition = new Vector3(0, 0, 6);
  baseTarget = new Vector3();
  baseUp = new Vector3(0, 1, 0);

  displacement = { position: new Vector2(-0.075, -0.05), target: new Vector2(), rotation: 0 };
  shake = new Vector3();
  shakeSpeed = new Vector3(1, 1, 1);
  touchAmount = 1;

  lerpPosition = 0.035;
  lerpTarget = 0.035;
  lerpRotate = 0.075;
  lerpZoom = 0.05;
  lerpPan = client.device === 'mobile' ? 0.175 : 0.15;

  minPolarAngle = 0.25;
  maxPolarAngle = Math.PI - 0.25;

  /** Added to the orbit radius (intro zoom-out uses this). */
  followSphericalZoom = 0;

  // ---- follow state ----
  private _followedMesh: CharacterLike | null = null;
  private _cameraCollisions = false;
  private _cameraRotationLerp = 0.03;
  private _cameraInactiveMultiplier = 0.025;
  private _followedMeshDistance = 1;
  private _followedMeshOffset = new Vector3();
  private _panTargetOffset = new Vector3();

  // ---- orbit state (public: the character system reads these) ----
  spherical = new Spherical();
  sphericalTarget = new Spherical();
  private _panTarget = new Vector3();

  // ---- base state ----
  private _firstUpdate = true;
  private _size = new Vector2(client.screen.w, client.screen.h);
  private _prevSize = this._size.clone();
  private _prevPosition = new Vector3();
  private _prevTarget = new Vector3();
  private _prevUp = new Vector3();
  private _additionalSphericalPosition = new Spherical();
  private _additionalSphericalTarget = new Spherical();

  private _v0 = new Vector3();
  private _v1 = new Vector3();
  private _s0 = new Spherical();
  private _q0 = new Quaternion();
  private _m0 = new Matrix4();

  constructor() {
    super(45, client.screen.w / client.screen.h, 0.1, 1000);
    events.on('touch_start', this._touchStart);
    events.on('touch2_start', this._touchStart);
    events.on('wheel', this._onWheel);
  }

  /** Attach the camera to a character. */
  follow({
    mesh = null,
    relativeCameraPosition = new Vector3(0, 1, -2),
    lookatMeshOffset = new Vector3(),
    cameraCollisions = true,
    cameraRotationLerp = 0.03,
    cameraInactiveMultiplier = 0.025,
  }: FollowOptions = {}) {
    if (!mesh) throw new Error('follow camera needs a mesh');
    if (this._firstUpdate) this._update();
    this._followedMesh = mesh;
    this._cameraCollisions = cameraCollisions;
    this._cameraRotationLerp = cameraRotationLerp;
    this._cameraInactiveMultiplier = cameraInactiveMultiplier;

    this._v0.copy(relativeCameraPosition);
    this._followedMeshDistance = this._v0.length();
    this._followedMeshOffset.copy(lookatMeshOffset);
    this._panTargetOffset.copy(lookatMeshOffset);
    this._panTarget.copy(mesh._localObject.position).add(this._followedMeshOffset);
    this.baseTarget.copy(this._panTarget);
    this.basePosition.copy(this._v0.add(this.baseTarget));
    this._snap();
    if ((this._followedMesh as any)._camera === this) {
      this._followedMesh._localObject.spherical.theta = this.spherical.theta;
      this._followedMesh._localObject.targetSpherical.theta = this.spherical.theta;
      if (this._followedMesh._collisionPhysics.canFly) {
        this._followedMesh._localObject.spherical.phi = this.spherical.phi;
        this._followedMesh._localObject.targetSpherical.phi = this.spherical.phi;
      }
    }
  }

  /** Called once per frame by the scene. */
  updateCamera() {
    this._resize();
    this._update();
  }

  private _update() {
    if (this._followedMesh) {
      const local = this._followedMesh._localObject;
      const physics = this._followedMesh._collisionPhysics;

      // Rotate the camera offset with the character's facing direction.
      this._v0
        .copy(this._followedMeshOffset)
        .applyQuaternion(this._q0.setFromAxisAngle(UP, local.spherical.theta + Math.PI));
      this._panTargetOffset.lerp(this._v0, lerpCoefFPS(0.0125));
      this._panTarget.copy(local.position).add(this._panTargetOffset);

      // Camera rotation catches up faster while the character moves.
      this._v0.setFromSpherical(this.spherical).setY(0).normalize();
      this._v1.setFromSpherical(local.targetSpherical).setY(0).normalize();
      const facing = fit(this._v0.dot(this._v1), -1, 0, 0, 1);
      const lerpScale = physics.isMoving
        ? facing
        : this._cameraInactiveMultiplier;
      const r = lerpCoefFPS(this._cameraRotationLerp * lerpScale);
      const target = this.sphericalTarget;
      target.theta = lerp(
        target.theta,
        getShortestRotationAngle(target.theta, local.spherical.theta),
        r,
      );
      if (physics.canFly) {
        target.phi = lerp(
          target.phi,
          getShortestRotationAngle(local.spherical.phi, target.phi),
          r,
        );
      }

      // Collision: pull the camera closer if the collider blocks the view.
      let collided = false;
      if (this._cameraCollisions && physics.collider) {
        physics.rayCaster.set(
          this.baseTarget,
          this._v0.copy(this.basePosition).sub(this.baseTarget).normalize(),
        );
        const hits = physics.rayCaster.intersectObject(physics.collider as any);
        if (hits.length > 0) {
          const hit = hits[0];
          if (hit.distance < this._followedMeshDistance) {
            collided = true;
            target.radius = Math.max(
              physics.charactersCapsule.radius * 1.25,
              hit.distance * 0.9,
            );
          }
        }
      }
      if (!collided) target.radius = this._followedMeshDistance;
      target.radius += this.followSphericalZoom;
    }

    this._updateOrbit();
    this._updateBase();
  }

  // ---- orbit update ----
  private _updateOrbit() {
    const t = this.sphericalTarget;
    t.phi = clamp(t.phi, this.minPolarAngle, this.maxPolarAngle);
    t.phi = clamp(t.phi, EPS, Math.PI - EPS);

    this.spherical.theta = lerpFPS(this.spherical.theta, t.theta, this.lerpRotate);
    this.spherical.phi = lerpFPS(this.spherical.phi, t.phi, this.lerpRotate);
    this.spherical.radius = lerpFPS(this.spherical.radius, t.radius, this.lerpZoom);

    this.baseTarget.lerp(this._panTarget, lerpCoefFPS(this.lerpPan));
    this._v0.setFromSpherical(this.spherical);
    this.basePosition.copy(this.baseTarget).add(this._v0);
  }

  // ---- base camera update (displacement, shake, up, lookAt) ----
  private _updateBase() {
    if (this._firstUpdate) {
      this._firstUpdate = false;
      this.position.copy(this.basePosition);
      this.target.copy(this.baseTarget);
      this.up.copy(this.baseUp);
    }

    const reset = touches[0].currentInput === 'touch' && !touches[0].touching;
    const lerpScale = reset ? 0.5 : 1;
    const touchX =
      fit(reset ? 0 : touches[0].position11.x, -1, 1, -HALF_PI, HALF_PI) * this.touchAmount;
    const touchY =
      fit(reset ? 0 : touches[0].position11.y, 1, -1, -HALF_PI, HALF_PI) * this.touchAmount;

    // ---- position ----
    this._v0.copy(this.basePosition).sub(this.baseTarget);
    if (this.displacement.position.equals(ZERO_V2)) {
      this.position.copy(this.basePosition);
      this._additionalSphericalPosition.set(1, 0, 0);
    } else {
      this._additionalSphericalPosition.theta = lerpFPS(
        this._additionalSphericalPosition.theta,
        touchX * this.displacement.position.x,
        this.lerpPosition * lerpScale,
      );
      this._additionalSphericalPosition.phi = lerpFPS(
        this._additionalSphericalPosition.phi,
        touchY * this.displacement.position.y,
        this.lerpPosition * lerpScale,
      );
      this._s0.setFromVector3(this._v0);
      this._s0.theta += this._additionalSphericalPosition.theta;
      this._s0.phi = clamp(this._s0.phi + this._additionalSphericalPosition.phi, EPS, Math.PI - EPS);
      this._v0.setFromSpherical(this._s0);
      this.position.copy(this.baseTarget).add(this._v0);
    }

    // ---- target ----
    this._v0.copy(this.baseTarget).sub(this.basePosition);
    if (this.displacement.target.equals(ZERO_V2) && this.shake.x === 0 && this.shake.y === 0) {
      this.target.copy(this.baseTarget);
      this._additionalSphericalTarget.set(1, 0, 0);
    } else {
      this._additionalSphericalTarget.theta = lerpFPS(
        this._additionalSphericalTarget.theta,
        touchX * this.displacement.target.x,
        this.lerpTarget * lerpScale,
      );
      this._additionalSphericalTarget.phi = lerpFPS(
        this._additionalSphericalTarget.phi,
        touchY * this.displacement.target.y,
        this.lerpTarget * lerpScale,
      );
      const t = clock.time;
      const shakeX =
        this.shake.x === 0
          ? 0
          : sineNoise1(12.23, 3.44, -3.234 + t * this.shakeSpeed.x) * this.shake.x * this.touchAmount;
      const shakeY =
        this.shake.y === 0
          ? 0
          : sineNoise1(-2.45, 4.789, 7.343 + t * this.shakeSpeed.y) * this.shake.y * this.touchAmount;
      this._s0.setFromVector3(this._v0);
      this._s0.theta += this._additionalSphericalTarget.theta + shakeX;
      this._s0.phi = clamp(this._s0.phi + this._additionalSphericalTarget.phi + shakeY, EPS, Math.PI - EPS);
      this._v0.setFromSpherical(this._s0);
      this.target.copy(this.basePosition).add(this._v0);
    }

    // ---- up ----
    if (this.displacement.rotation === 0 && this.shake.z === 0) {
      this.up.copy(this.baseUp);
    } else {
      this._v0.copy(this.basePosition).sub(this.baseTarget);
      if (this._v0.lengthSq() === 0) this._v0.z = 1;
      this._v0.normalize();
      this._v1.crossVectors(this.baseUp, this._v0);
      if (this._v1.lengthSq() === 0) {
        if (Math.abs(this.baseUp.z) === 1) this._v0.x += 1e-4;
        else this._v0.z += 1e-4;
        this._v0.normalize();
        this._v1.crossVectors(this.baseUp, this._v0);
      }
      this._v1.normalize();
      const shakeZ =
        this.shake.z === 0
          ? 0
          : sineNoise1(23.434, -1.565, 8.454 + clock.time * this.shakeSpeed.z) * this.shake.z * this.touchAmount;
      this._v1.multiplyScalar(this.displacement.rotation * touches[0].velocity.x * this.touchAmount + shakeZ);
      this._v0.copy(this.baseUp).add(this._v1).normalize();
      this.up.lerp(this._v0, lerpCoefFPS(this.lerpRotate * lerpScale)).normalize();
    }

    if (
      !this.position.equals(this._prevPosition) ||
      !this.target.equals(this._prevTarget) ||
      !this.up.equals(this._prevUp)
    ) {
      this._prevPosition.copy(this.position);
      this._prevTarget.copy(this.target);
      this._prevUp.copy(this.up);
      this._m0.lookAt(this.position, this.target, this.up);
      this.quaternion.setFromRotationMatrix(this._m0);
    }
  }

  private _snap() {
    this._v0.copy(this.basePosition).sub(this.baseTarget);
    this.spherical.setFromVector3(this._v0);
    this.sphericalTarget.copy(this.spherical);
    this._panTarget.copy(this.baseTarget);
  }

  private _resize() {
    this._size.set(client.screen.w, client.screen.h);
    if (!this._prevSize.equals(this._size)) {
      this._prevSize.copy(this._size);
      this.aspect = this._size.x / this._size.y;
      this.updateProjectionMatrix();
    }
  }

  // Orbit-style touch input is disabled on the follow camera in the original
  // (enableRotate/enablePan/enableZoom = false), so handlers are no-ops,
  // kept as listeners for API parity.
  private _touchStart = () => {};
  private _onWheel = () => {};
}
