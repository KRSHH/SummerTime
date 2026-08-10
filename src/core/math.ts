// Math helpers used across the engine. Faithful port of the original `math`
// namespace, rewritten as typed functions with the same semantics.

import { MathUtils } from 'three';
import { gsap } from 'gsap';
import { tickerRatio } from './ticker';

export const TWO_PI = Math.PI * 2;
export const HALF_PI = Math.PI * 0.5;

export const degrees = (rad: number) => MathUtils.radToDeg(rad);
export const radians = (deg: number) => MathUtils.degToRad(deg);
export const clamp = (v: number, min = 0, max = 1) => MathUtils.clamp(v, min, max);
export const lerp = (a: number, b: number, t: number) => MathUtils.lerp(a, b, t);

/** Frame-rate-independent lerp coefficient (0..1) from a per-second rate. */
export const lerpCoefFPS = (rate: number) => damp(rate, tickerRatio());
export const damp = (rate: number, delta: number) => 1 - Math.exp(Math.log(1 - rate) * delta);
export const lerpFPS = (a: number, b: number, rate: number) => lerp(a, b, lerpCoefFPS(rate));

/** Frame-rate-independent exponential friction. */
export const frictionFPS = (rate: number) => friction(rate, tickerRatio());
export const friction = (rate: number, delta: number) => Math.exp(Math.log(rate) * delta);

export const ratioFPS = () => tickerRatio();

export const efit = (x: number, a1: number, a2: number, b1: number, b2: number) =>
  MathUtils.mapLinear(x, a1, a2, b1, b2);
export const fit = (x: number, a1: number, a2: number, b1: number, b2: number) =>
  efit(clamp(x, Math.min(a1, a2), Math.max(a1, a2)), a1, a2, b1, b2);
export const fit01 = (x: number, b1: number, b2: number) => fit(x, 0, 1, b1, b2);
export const fit10 = (x: number, b1: number, b2: number) => fit(x, 1, 0, b1, b2);
export const fit11 = (x: number, b1: number, b2: number) => fit(x, -1, 1, b1, b2);

export const step = (threshold: number, v: number) => (v < threshold ? 0 : 1);
export const linearstep = (min: number, max: number, v: number) =>
  clamp((v - min) / (max - min), 0, 1);
export const smoothstep = (min: number, max: number, v: number) =>
  MathUtils.smoothstep(v, min, max);
export const smootherstep = (min: number, max: number, v: number) =>
  MathUtils.smootherstep(v, min, max);

export const parabola = (v: number, k: number) => Math.pow(4 * v * (1 - v), k);

/** Next power-of-two ≥ v. */
export const ceilPowerOfTwo = (v: number) => MathUtils.ceilPowerOfTwo(v);

/** Ease a value through a named easing curve (gsap). */
export function ease(t: number, name: string): number {
  try {
    return gsap.parseEase(name)(t);
  } catch {
    return t;
  }
}

/** Shortest-angle version of `to` relative to `from`, returns an ANGLE near
 *  `to` but in `from`'s revolution (original semantics: `from + diff`). */
export function getShortestRotationAngle(from: number, to: number): number {
  let diff = (to - from) % TWO_PI;
  if (diff > Math.PI) diff -= TWO_PI;
  if (diff < -Math.PI) diff += TWO_PI;
  return from + diff;
}
