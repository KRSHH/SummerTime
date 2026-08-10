// GPU particle system: positions computed on the GPU into a float texture
// (GPUComputationRenderer), consumed by a custom particle shader. Port of
// the original `particlesGPU*` helpers.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  FloatType,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  RGBAFormat,
  ShaderMaterial,
} from 'three';
import type { Material } from 'three';
import { GPUComputationRenderer, type Variable } from 'three/examples/jsm/misc/GPUComputationRenderer.js';
import { ceilPowerOfTwo } from '../core/math';
import { engine } from './globals';
import { globalUniforms } from './globals';

export interface ParticlesOptions {
  geometry?: 'points' | BufferGeometry;
  particles?: number;
  initialPositions?: Array<{ x: number; y: number; z: number }>;
}

export interface ParticlesMaterialOptions {
  uniforms?: Record<string, { value: unknown }>;
  vertexShader?: string;
  fragmentShader?: string;
  transparent?: boolean;
}

function createParticlesGeometry({
  geometry = 'points',
  particles = 1024,
  textureSize,
}: {
  geometry?: 'points' | BufferGeometry;
  particles?: number;
  textureSize: number;
}): BufferGeometry | InstancedBufferGeometry {
  const isPoints = geometry === 'points';
  let result: BufferGeometry | InstancedBufferGeometry;
  if (isPoints) {
    result = new BufferGeometry();
    result.setAttribute('position', new BufferAttribute(new Float32Array(particles * 3), 3));
  } else {
    const base = (geometry as BufferGeometry).clone();
    result = new InstancedBufferGeometry();
    (result as InstancedBufferGeometry).instanceCount = particles;
    result.setIndex(base.index);
    for (const name of Object.keys(base.attributes)) {
      result.setAttribute(name, base.attributes[name]);
    }
  }
  const rand: number[] = [];
  const texuv: number[] = [];
  const cell = (1 / textureSize) * 0.5;
  for (let i = 0; i < particles; i++) {
    rand.push(Math.random(), Math.random(), Math.random(), Math.random());
    texuv.push((i % textureSize) / textureSize + cell, Math.floor(i / textureSize) / textureSize + cell);
  }
  const Ctor = isPoints ? BufferAttribute : InstancedBufferAttribute;
  result.setAttribute('rand', new Ctor(new Float32Array(rand), 4));
  result.setAttribute('texuv', new Ctor(new Float32Array(texuv), 2));
  return result;
}

function createParticlesTexture(textureSize: number, initialPositions: Array<{ x: number; y: number; z: number }>): DataTexture {
  const data = new Float32Array(textureSize * textureSize * 4);
  initialPositions.forEach((p, i) => {
    const o = i * 4;
    data[o + 0] = p.x;
    data[o + 1] = p.y;
    data[o + 2] = p.z;
    data[o + 3] = Math.random();
  });
  const texture = new DataTexture(data, textureSize, textureSize, RGBAFormat, FloatType);
  texture.needsUpdate = true;
  return texture;
}

function createParticlesMaterial(
  positionsTexture: DataTexture,
  options: ParticlesMaterialOptions = {},
): ShaderMaterial {
  return new ShaderMaterial({
    ...options,
    uniforms: {
      uSize: { value: 200 },
      uColor: { value: new Color('#ffffff') },
      tPositions: { value: positionsTexture },
      ...globalUniforms,
      ...options.uniforms,
    },
    vertexShader:
      options.vertexShader ??
      `
        attribute vec2 texuv;
        uniform vec2 resolution;
        uniform sampler2D tPositions;
        uniform float uSize;

        void main() {
          vec3 pos = texture2D(tPositions, texuv).rgb;
          vec3 wPos = (modelMatrix * vec4(pos, 1.0)).xyz;
          vec3 vPos = (viewMatrix * vec4(pos, 1.0)).xyz;
          gl_PointSize = uSize / length(vPos.xyz) * (resolution.y / 1300.0);
          gl_Position = projectionMatrix * vec4(vPos, 1.0);
        }
      `,
    fragmentShader:
      options.fragmentShader ??
      `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          gl_FragColor.rgb = uColor;
          gl_FragColor.a = smoothstep(0.5, 0.45, length(gl_PointCoord.xy - 0.5));
        }
      `,
  });
}

export interface ComputationOptions {
  fragmentShader?: string;
  uniforms?: Record<string, { value: unknown }>;
  customVariables?: boolean;
  afterCompute?: () => void;
  autoCompute?: boolean;
}

/** GPU-computed particles: a mesh whose per-instance positions live in a
 *  float texture updated each frame by the GPU computation pass. */
export class ParticlesGPU extends InstancedMesh {
  isParticlesGPU = true;
  private _computation!: GPUComputationRenderer;
  private _positionsVar!: Variable;
  afterCompute: ((renderer?: any, scene?: any, camera?: any) => void) | null = null;

  constructor(geometry: InstancedBufferGeometry, material: Material, count: number) {
    super(geometry, material, count);
    this.name = 'GPU Particles';
    this.frustumCulled = false;
  }

  createComputation(options: ComputationOptions = {}) {
    const positionsTexture = (this.material as ShaderMaterial).uniforms.tPositions.value as DataTexture;
    this._computation = new GPUComputationRenderer(positionsTexture.image.width, positionsTexture.image.height, engine.renderer);
    if (!(engine.renderer.capabilities as any).floatRenderTarget) {
      this._computation.setDataType(HalfFloatType);
    }
    if (!options.customVariables) {
      this._positionsVar = this._computation.addVariable('tPositions', options.fragmentShader ?? '', positionsTexture);
      this._computation.setVariableDependencies(this._positionsVar, [this._positionsVar]);
      (this._positionsVar.material.uniforms as any) = {
        ...(this._positionsVar.material.uniforms ?? {}),
        ...(options.uniforms ?? {}),
      };
      this._computation.init();
    }
    if (options.afterCompute) this.afterCompute = options.afterCompute;
    if (options.autoCompute !== false) {
      this.onBeforeRender = this.compute.bind(this);
    }
  }

  compute(renderer?: any, scene?: any, camera?: any) {
    for (const variable of (this._computation as any).variables) {
      const uModel = variable.material.uniforms.uModelMatrix;
      const uView = variable.material.uniforms.uViewMatrix;
      const uProj = variable.material.uniforms.uProjMatrix;
      if (uModel) uModel.value.copy(this.matrixWorld);
      if (uView) uView.value.copy((this as any)._cameraMatrixWorldInverse);
      if (uProj) uProj.value.copy((this as any)._cameraProjectionMatrix);
    }
    this._computation.compute();
    const material = this.material as ShaderMaterial;
    if (material.uniforms.tPositions && this._positionsVar) {
      material.uniforms.tPositions.value = this._computation.getCurrentRenderTarget(this._positionsVar).texture;
    }
    this.afterCompute?.(renderer, scene, camera);
  }
}

/** Convenience factory matching the original `particlesGPU$1`. */
export function createParticles(
  options: ParticlesOptions = {},
  materialOptions: ParticlesMaterialOptions = {},
): ParticlesGPU {
  const initial = options.initialPositions ?? [];
  const particles = options.particles ?? (initial.length || 1024);
  const geometry = options.geometry ?? 'points';
  const textureSize = Math.max(2, ceilPowerOfTwo(particles));
  const geo = createParticlesGeometry({ geometry, particles, textureSize });
  const texture = createParticlesTexture(textureSize, initial);
  const material = createParticlesMaterial(texture, materialOptions);
  return new ParticlesGPU(geo as InstancedBufferGeometry, material, particles);
}
