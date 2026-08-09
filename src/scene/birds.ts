// Birds: 25 instances of a vertex-animated bird mesh flying along curve
// paths, positions simulated on the GPU (velocity + position computation
// passes). Shader GLSL is verbatim from the original.

import { Color, DataTexture, FloatType, RGBAFormat } from 'three';
import { deferred } from '../core/deferred';
import { ceilPowerOfTwo, clamp } from '../core/math';
import { clock } from '../engine/clock';
import { geometryLoader } from '../engine/loaders/geometries';
import { globalUniforms } from '../engine/globals';
import { createParticles, type ParticlesGPU } from '../engine/particles';
import { SceneModule } from './SceneModule';
import sinenoiseGLSL from './glsl/sinenoise.glsl?raw';
import fitGLSL from './glsl/fit.glsl?raw';
import colorutilsGLSL from './glsl/colorutils.glsl?raw';
import fogChunkGLSL from './glsl/fogChunk.glsl?raw';
import rotateGLSL from './glsl/rotate.glsl?raw';
import vertexanimationGLSL from './glsl/vertexanimation.glsl?raw';

/** Build a float texture holding the curve paths (one row per curve). */
function createCurvesTexture(
  url: string,
  closed: boolean,
  pointDensity: number,
): DataTexture & { _loaded: Promise<void>; image: { data: Float32Array; width: number; height: number } } {
  const texture = new DataTexture(new Float32Array(16), 2, 2, RGBAFormat, FloatType) as any;
  texture._url = url;
  texture._closed = closed;
  texture._pointDensity = pointDensity;
  texture._loaded = deferred();
  setTimeout(async () => {
    const curves = await geometryLoader.curves(url, closed, pointDensity);
    const curveCount = Math.max(2, curves.length);
    const height = ceilPowerOfTwo(curveCount);
    let width = 2;
    let maxLength = 0;
    for (const c of curves) {
      width = Math.max(width, c.geometry.attributes.position.count);
      maxLength = Math.max(maxLength, c.curve.getLength());
    }
    width = clamp(ceilPowerOfTwo(width), 2, 2048);

    const data = new Float32Array(height * width * 4);
    curves.forEach((c, row) => {
      const points = c.curve.getSpacedPoints(width);
      const base = width * row * 4;
      const inv = 1 / (points.length - 1);
      points.forEach((p, i) => {
        const o = i * 4;
        data[base + o + 0] = p.x;
        data[base + o + 1] = p.y;
        data[base + o + 2] = p.z;
        data[base + o + 3] = inv * i;
      });
    });
    texture.image = { data, width, height };
    texture.needsUpdate = true;
    texture._loaded.resolve();
  }, 0);
  return texture;
}

export class Birds extends SceneModule {
  declare mesh: ParticlesGPU;
  declare fakeTime: { value: number };

  protected async init() {
    const curveTexture = createCurvesTexture('birds-curve.bin', true, 1);
    const [birdGeometry] = await Promise.all([
      geometryLoader.vertexAnimation('bird.bin'),
      curveTexture._loaded,
    ]);
    const COUNT = 25;

    this.mesh = createParticles(
      { geometry: birdGeometry as any, particles: COUNT },
      {
        uniforms: {
          tPositionsPrev: { value: null },
          uColor: { value: new Color('#dfdfdf') },
          ...(birdGeometry as any).__vertexAnimationUniforms,
        },
        vertexShader: `
          attribute vec2 texuv;
          attribute vec4 rand;

          uniform sampler2D tPositions;
          uniform sampler2D tPositionsPrev;

          ${rotateGLSL}
          ${vertexanimationGLSL}

          uniform sampler2D tPosition;
          uniform sampler2D tNormal;

          varying vec3 vNormal;
          varying vec3 vLDir;
          varying float vVar;
          varying vec4 vPos;

          void main() {
            vec4 currentOffset = texture2D(tPositions, texuv);
            vec4 prevOffset = texture2D(tPositionsPrev, texuv);

            float timeoffset = rand.x * 10.0;
            vec3 pos = getAnimData(tPosition, timeoffset);
            vec3 n = getAnimData(tNormal, timeoffset);

            vec3 dir = normalize(prevOffset.xyz - currentOffset.xyz);
            mat3 rotX = rotateX(-dir.y);
            mat3 rotY = rotateY(atan(dir.x, dir.z));
            pos = rotY * rotX * pos;
            n = rotY * rotX * n;

            vNormal = normalize(normalMatrix * n);
            vLDir = (viewMatrix * vec4(normalize(vec3(1.0)), 0.0)).xyz;
            vVar = rand.y;
            vPos = viewMatrix * vec4(pos + currentOffset.xyz, 1.0);
            gl_Position = projectionMatrix * vPos;
          }
        `,
        fragmentShader: `
          ${colorutilsGLSL}
          ${fitGLSL}
          ${fogChunkGLSL}

          uniform vec3 uColor;

          varying vec3 vLDir;
          varying vec3 vNormal;
          varying float vVar;
          varying vec4 vPos;

          void main() {
            float sh = max(0.0, dot(normalize(vNormal), normalize(vLDir)));
            sh = step(0.5, sh);

            vec3 col = uColor * 0.95 + uColor * vVar * 0.05;
            col = mix(col * 0.1, col, sh);

            addFog(col, length(-vPos.xyz));

            gl_FragColor.rgb = col;
            gl_FragColor.a = 1.0;
          }
        `,
        transparent: false,
      },
    );
    this.mesh.name = 'birds';
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.createComputation({ customVariables: true });

    const positionsTexture = (this.mesh.material as any).uniforms.tPositions.value as DataTexture;
    const size = positionsTexture.image.width;

    // random lifetimes in the 4th channel
    const randData = new Float32Array(size * size * 4);
    for (let i = 3; i < randData.length; i += 4) randData[i] = Math.random();
    const randTexture = new DataTexture(randData, size, size, RGBAFormat, FloatType);
    randTexture.needsUpdate = true;

    const computation = (this.mesh as any)._computation;

    const velocityVar = computation.addVariable(
      'tVelocities',
      `
        uniform float dtRatio;
        uniform float uTime;
        uniform float uCurveWidth;
        uniform float uSnap;
        uniform sampler2D tCurve;

        ${sinenoiseGLSL}
        ${fitGLSL}

        float hash11(float p) {
          p = fract(p * .1031);
          p *= p + 33.33;
          p *= p + p;
          return fract(p);
        }

        void main() {
          vec2 vUv = gl_FragCoord.xy / resolution.xy;

          // calculate the next point in curve according to uTime
          float groups = 5.0;
          float offset = floor(vUv.x / (1.0 / groups));
          float hash = hash11(offset);
          float direction = fit(floor(hash * 2.0), 0.0, 1.0, -1.0, 1.0);
          float speed = 2.0 * direction * fit(hash, 0.0, 1.0, 0.75, 1.0);
          float progress = uTime * speed + uCurveWidth * (1.0 / groups) * offset;
          vec3 c1 = texture2D(tCurve, vec2(floor(mod(progress, uCurveWidth)) / uCurveWidth, 0.0)).rgb;
          vec3 c2 = texture2D(tCurve, vec2(floor(mod(progress + 1.0, uCurveWidth)) / uCurveWidth, 0.0)).rgb;
          vec3 target = mix(c1, c2, fract(progress));

          vec4 prevVel = texture2D(tVelocities, vUv);

          if (uSnap > 0.9) {
            prevVel.xyz = target;
          } else if (uSnap > 0.4) {
            prevVel.xyz = vec3(0.0);
          } else {
            vec4 prevPos = texture2D(tPositions, vUv);

            // add some noise
            float nAmount = 0.005 * dtRatio;
            prevVel.x += sinenoise1(prevPos.xyz + prevVel.w * 12.245243 + uTime * 0.05) * nAmount;
            prevVel.y += sinenoise1(prevPos.xyz + prevVel.w * 532.564 + uTime * 0.1) * nAmount;
            prevVel.z += sinenoise1(prevPos.xyz + prevVel.w * 645653.34523 + uTime * 0.025) * nAmount;

            // go towards target
            vec3 delta = (target - prevPos.xyz) * 0.000275;
            prevVel.xyz += delta * dtRatio;

            // friction
            prevVel.xyz *= exp2(log2(0.99) * dtRatio);
          }

          gl_FragColor.rgb = prevVel.xyz;
          gl_FragColor.a = prevVel.w;
        }
      `,
      randTexture,
    );
    velocityVar.material.uniforms = {
      ...velocityVar.uniforms,
      ...globalUniforms,
      uCurveWidth: { value: curveTexture.image.width },
      tCurve: { value: curveTexture },
      uTime: { value: 0 },
      uSnap: { value: 0 },
    };

    const positionVar = computation.addVariable(
      'tPositions',
      `
        uniform float dtRatio;
        uniform float uSnap;

        void main() {
          vec2 vUv = gl_FragCoord.xy / resolution.xy;

          vec4 prevPos = texture2D(tPositions, vUv);
          vec4 prevVel = texture2D(tVelocities, vUv);

          vec3 pos;

          if (uSnap > 0.9) pos = prevVel.xyz;
          else if (uSnap > 0.4) pos = prevPos.rgb;
          else pos = prevPos.xyz + prevVel.xyz * dtRatio;

          gl_FragColor.rgb = pos;
          gl_FragColor.a = prevPos.w;
        }
      `,
      positionsTexture,
    );
    positionVar.material.uniforms = {
      uSnap: { value: 0 },
      ...positionVar.uniforms,
      ...globalUniforms,
    };

    computation.setVariableDependencies(velocityVar, [positionVar, velocityVar]);
    computation.setVariableDependencies(positionVar, [positionVar, velocityVar]);
    computation.init();

    this.fakeTime = velocityVar.material.uniforms.uTime;
    this.snap();

    (this.mesh as any)._computation = computation;
    (this.mesh as any).afterCompute = () => {
      (this.mesh.material as any).uniforms.tPositions.value = computation.getCurrentRenderTarget(positionVar).texture;
      (this.mesh.material as any).uniforms.tPositionsPrev.value = computation.getAlternateRenderTarget(positionVar).texture;
      this.fakeTime.value += clock.delta * 0.001;
    };

    this.scene.add(this.mesh);
    this.ready.resolve();
  }

  snap() {
    const computation = (this.mesh as any)._computation;
    const [velocityVar, positionVar] = computation.variables;
    this.fakeTime.value = 0;
    velocityVar.material.uniforms.uSnap.value = 1;
    positionVar.material.uniforms.uSnap.value = 1;
    computation.compute();
    computation.compute();
    velocityVar.material.uniforms.uSnap.value = 0.5;
    positionVar.material.uniforms.uSnap.value = 0.5;
    computation.compute();
    computation.compute();
    velocityVar.material.uniforms.uSnap.value = 0;
    positionVar.material.uniforms.uSnap.value = 0;
  }
}
