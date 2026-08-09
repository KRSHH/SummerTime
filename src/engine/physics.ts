// Capsule-vs-mesh collision + floor/jump logic. Port of the original
// `collisionPhysics`/`collider` classes (three-mesh-bvh accelerated).
// The collider mesh's BVH is built in a worker (see bvh-worker.ts).

import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Line3,
  Mesh,
  Raycaster,
  Sphere,
  Spherical,
  Vector3,
} from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import type { CharacterLocal } from './characters';
import { lerp, lerpCoefFPS, lerpFPS, getShortestRotationAngle, ratioFPS, frictionFPS, HALF_PI } from '../core/math';
import { clock } from './clock';
import { quaternionFromSpherical } from './quaternion';
import BvhWorker from './bvh-worker?worker';

export class Collider extends Mesh {}
Collider.prototype.raycast = acceleratedRaycast;

export interface CollisionOptions {
  colliderMesh: Mesh;
  substeps?: number;
  positionForce?: number;
  jumpForce?: number;
  gravity?: number;
  damp?: number;
  directionLerp?: number;
  rotVelocityMin?: number;
  rotVelocityMax?: number;
  canFly?: boolean;
  checkFalling?: boolean;
  radiusPercentage?: number;
  floorDetectInclination?: number;
  fallLimitDistance?: number;
  onCollisionsReady?: () => void;
}

const BASE_DOWN = new Vector3(0, -1, 0);

export class CollisionPhysics {
  readonly charactersCapsule: { radius: number; segment: Line3 };
  readonly rayCaster = new Raycaster();
  readonly collider: Collider | null = null;
  isMoving = false;
  canFly: boolean;
  nearestVerticalPoint = -1;

  /** Character bounding sphere; its center is offset per remote when
   *  testing visibility against the camera frustum. */
  readonly boundingSphere = new Sphere();
  readonly boundingSphereCenter = new Vector3();
  readonly boundingSphereOriginalCenter = new Vector3();

  get boundsTree() {
    return (this._geometry as any)?.boundsTree;
  }
  get geometry() {
    return this._geometry;
  }

  private _characters: { _localObject: CharacterLocal; _camera: { spherical: Spherical } };
  private _camera: { spherical: Spherical };
  private _colliderMesh: Mesh;
  private _substeps: number;
  private _positionForce: number;
  private _jumpForce: number;
  private _gravity: number;
  private _charDamp: number;
  private _directionLerp: number;
  private _rotVelocityMin: number;
  private _rotVelocityMax: number;
  private _checkFalling: boolean;
  private _floorDetectInclination: number;
  private _fallLimitDistance: number;
  private _geometry: BufferGeometry | null = null;
  private _prevIsOnFloor: boolean;
  private _prevIsOnFloorTime = -1;

  private _v0 = new Vector3();
  private _v1 = new Vector3();
  private _v2 = new Vector3();
  private _s0 = new Spherical();
  private _l0 = new Line3();
  private _l1 = new Line3();
  private _b = new Box3();

  constructor(characters: { _localObject: CharacterLocal; _camera: { spherical: Spherical } }, options: CollisionOptions) {
    this._characters = characters;
    this._camera = characters._camera;
    this._colliderMesh = options.colliderMesh;
    this._colliderMesh.geometry.computeBoundingSphere();
    this._substeps = options.substeps ?? 4;
    this._positionForce = options.positionForce ?? 0.0045;
    this._jumpForce = options.jumpForce ?? 0.2;
    this._gravity = options.gravity ?? -0.009832;
    this._charDamp = options.damp ?? 0.92;
    this._directionLerp = options.directionLerp ?? 0.075;
    this._rotVelocityMin = options.rotVelocityMin ?? 0.0035;
    this._rotVelocityMax = options.rotVelocityMax ?? 0.02;
    this.canFly = options.canFly === true;
    this._checkFalling = options.checkFalling !== false;
    this._floorDetectInclination = Math.min(1, options.floorDetectInclination ?? 0.7);
    this._fallLimitDistance = Math.min(1, options.fallLimitDistance ?? 10);
    this._prevIsOnFloor = this._characters._localObject.isOnFloor;

    const local = this._characters._localObject;
    const geo = (local.mesh as any).geometry;
    if (geo.boundingSphere) {
      this.boundingSphere.copy(geo.boundingSphere);
      this.boundingSphereCenter.copy(this.boundingSphere.center);
      this.boundingSphereOriginalCenter.copy(this.boundingSphere.center);
    }
    if (!geo.boundingBox) geo.computeBoundingBox();
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const charHeight = Math.abs(geo.boundingBox!.max.y - geo.boundingBox!.min.y);
    const radius = charHeight * Math.min(options.radiusPercentage ?? 0.2, 0.45);
    const segmentLength = charHeight - radius * 2;
    this.charactersCapsule = {
      radius,
      segment: new Line3(new Vector3(), new Vector3(0, segmentLength, 0)),
    };
    this.rayCaster.firstHitOnly = true;
    this._initializeGeometry(options);
  }

  private _shapecastFuncs = {
    intersectsBounds: (box: Box3) => box.intersectsBox(this._b),
    intersectsTriangle: (tri: any) => {
      const d = this._v0;
      const u = this._v1;
      const dist = tri.closestPointToSegment(this._l0, d, u);
      if (dist < this.charactersCapsule.radius) {
        const isStart = u.equals(this._l0.start);
        const depth = this.charactersCapsule.radius - dist;
        const dir = u.sub(d).normalize();
        this._l0.start.addScaledVector(dir, depth);
        this._l0.end.addScaledVector(dir, depth);
        if (isStart && dir.y > 0) {
          tri.getNormal(this._v2);
          if (this._v2.y > this._floorDetectInclination) {
            this._characters._localObject.isOnFloor = true;
          }
        }
      }
      return false;
    },
  };

  private _initializeGeometry(options: CollisionOptions) {
    const mesh = this._colliderMesh;
    mesh.updateMatrixWorld(true);
    const worker = new BvhWorker();
    worker.onmessage = (e: MessageEvent) => {
      const { serialized, position } = e.data;
      this._geometry = new BufferGeometry();
      this._geometry.setAttribute('position', new BufferAttribute(position, 3));
      if (mesh.geometry.index) {
        this._geometry.setIndex(new BufferAttribute(serialized.index, 1));
      }
      this._geometry.computeBoundingBox();
      this._geometry.boundsTree = MeshBVH.deserialize(serialized, this._geometry, { setIndex: false });
      (this as any).collider = new Collider(this._geometry);
      worker.terminate();
      options.onCollisionsReady?.();
    };
    const position = (mesh.geometry.attributes.position.array as Float32Array).slice();
    const sourceIndex = mesh.geometry.index?.array as Uint16Array | Uint32Array | undefined;
    const index = sourceIndex ? new Uint32Array(sourceIndex) : null;
    worker.postMessage(
      {
        position: position.buffer,
        index: index?.buffer ?? null,
        matrixWorld: mesh.matrixWorld.elements,
      },
      [position.buffer, ...(index ? [index.buffer] : [])],
    );
  }

  /** Advance the character one physics frame. `move` is the input vector. */
  update(move: Vector3, frameLerp: number) {
    const local = this._characters._localObject;
    this.isMoving = move.length() > 1e-5;

    if (this.isMoving) {
      move.multiplyScalar(this._positionForce);
      this._s0.setFromVector3(move);
      this._s0.theta += this._camera.spherical.theta;
      if (this.canFly) {
        if (move.z > 0) this._s0.phi += this._camera.spherical.phi - HALF_PI;
        else if (move.z < 0) this._s0.phi -= this._camera.spherical.phi - HALF_PI;
      }
      local.acceleration.setFromSpherical(this._s0).negate();
      const u = lerpCoefFPS(this._directionLerp);
      local.targetSpherical.theta = lerp(
        local.targetSpherical.theta,
        getShortestRotationAngle(local.spherical.theta, this._s0.theta),
        u,
      );
      local.targetSpherical.phi = lerp(
        local.targetSpherical.phi,
        getShortestRotationAngle(local.spherical.phi, this._s0.phi),
        u,
      );
    }

    if (!local.isOnFloor) local.acceleration.y += this._gravity;
    local.spherical.theta = lerp(local.spherical.theta, local.targetSpherical.theta, frameLerp);
    local.spherical.phi = lerp(local.spherical.phi, local.targetSpherical.phi, frameLerp);
    quaternionFromSpherical(local.spherical, local.quaternion);

    const ratio = ratioFPS();
    local.velocity.add(local.acceleration.multiplyScalar(ratio));
    const steps = Math.max(Math.round(ratio * this._substeps), 3);
    local.velocity.clampLength(0, steps * this.charactersCapsule.radius * 0.9);
    local.isOnFloor = false;

    for (let i = 0; i < steps; i++) this._substep(ratio / steps);

    local.velocity.multiplyScalar(frictionFPS(this._charDamp));
    local.velocityHorizontal = this._v0.copy(local.velocity).setY(0).length();
    local.acceleration.setScalar(0);

    if (local.velocityHorizontal > this._rotVelocityMin) {
      this._s0.setFromVector3(this._v0);
      local.targetSpherical.theta = lerpFPS(
        local.targetSpherical.theta,
        getShortestRotationAngle(
          local.targetSpherical.theta,
          this._s0.theta + Math.PI,
        ),
        this._directionLerp *
          Math.min(1, Math.max(0, (local.velocityHorizontal - this._rotVelocityMin) / (this._rotVelocityMax - this._rotVelocityMin))),
      );
    }

    this.rayCaster.set(
      this._v0.copy(local.position).add(this._v1.set(0, 0.001, 0)),
      BASE_DOWN,
    );
    const hit = this.rayCaster.intersectObject(this.collider as Mesh)[0];
    const offGround = !hit || hit.distance > 0.2;
    this._detectJump(local, offGround);
    this._updateNearestVerticalPoint(hit);

    if (this._checkFalling && this._geometry) {
      if (local.position.y + this._fallLimitDistance < this._geometry.boundingBox!.min.y) {
        local.position.copy(local.initialPosition);
      }
    }
  }

  private _substep(dt: number) {
    const local = this._characters._localObject;
    this._v0.copy(local.velocity).multiplyScalar(dt);
    local.position.add(this._v0);
    local.updateMatrix();

    this._l0.copy(this.charactersCapsule.segment);
    this._l0.start.y += this.charactersCapsule.radius;
    this._l0.end.y += this.charactersCapsule.radius;
    local.updateMatrix();
    this._l0.start.applyMatrix4(local.matrix);
    this._l0.end.applyMatrix4(local.matrix);
    this._l1.copy(this._l0);
    this._b.makeEmpty();
    this._b.expandByPoint(this._l0.start);
    this._b.expandByPoint(this._l0.end);
    this._b.min.addScalar(-this.charactersCapsule.radius);
    this._b.max.addScalar(this.charactersCapsule.radius);
    (this._geometry as any)!.boundsTree.shapecast(this._shapecastFuncs);

    const correction = this._v0;
    correction.subVectors(this._l0.start, this._l1.start);
    const len = Math.max(0, correction.length() - 1e-5 * dt);
    correction.normalize();
    local.position.addScaledVector(correction, len);
    local.velocity.addScaledVector(correction, -correction.dot(local.velocity));
  }

  private _detectJump(local: CharacterLocal, offGround: boolean) {
    if (this._prevIsOnFloor !== local.isOnFloor) {
      if (!this._prevIsOnFloor) {
        this._prevIsOnFloor = true;
        local.userData.a = 0;
      } else {
        const t = clock.time;
        if (this._prevIsOnFloorTime === -1) {
          this._prevIsOnFloorTime = t;
        } else if (t - this._prevIsOnFloorTime > 0.045 && offGround) {
          this._prevIsOnFloor = false;
          this._prevIsOnFloorTime = -1;
          local.userData.a = 1;
        }
      }
    } else {
      this._prevIsOnFloorTime = -1;
    }
    if (!this._prevIsOnFloor) {
      if (!offGround && local.userData.a === 1) local.userData.a = 0;
      if (offGround && local.userData.a === 0) local.userData.a = 1;
    }
    if (local.jumpRequested && local.isOnFloor) {
      local.jumpRequested = false;
      local.velocity.y += this._jumpForce;
    }
  }

  private _updateNearestVerticalPoint(hit: any) {
    if (!hit) {
      this.nearestVerticalPoint = -1;
      return;
    }
    const positions = this._colliderMesh.geometry.attributes.position;
    const a = this._v0.fromBufferAttribute(positions, hit.face.a).distanceToSquared(hit.point);
    const b = this._v1.fromBufferAttribute(positions, hit.face.b).distanceToSquared(hit.point);
    const c = this._v2.fromBufferAttribute(positions, hit.face.c).distanceToSquared(hit.point);
    let closest = hit.face.a;
    if (b < a && b < c) closest = hit.face.b;
    if (c < a && c < b) closest = hit.face.c;
    this.nearestVerticalPoint = closest;
  }
}
