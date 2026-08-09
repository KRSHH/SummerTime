// Build a quaternion from a spherical coordinate (used by the character
// physics to orient the mesh). Port of the original `quaternionFromSpherical`.

import { Matrix4, Spherical, Vector3 } from 'three';

const BASE_UP = new Vector3(0, 1, 0);
const _forward = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _m = new Matrix4();
const ZERO = new Vector3();

export function quaternionFromSpherical(s: Spherical, target: { setFromRotationMatrix(m: Matrix4): void }): void {
  _forward.setFromSpherical(s);
  _right.crossVectors(_forward, BASE_UP);
  _up.crossVectors(_right, _forward);
  _m.lookAt(ZERO, _forward, _up);
  target.setFromRotationMatrix(_m);
}
