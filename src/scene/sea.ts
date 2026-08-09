// Sea: a large plane with a planar reflection of the scene, animated water
// (two sine swells), perturbed normals, fresnel, procedural foam and cloud
// shadows. Shader GLSL is verbatim from the original.

import { Color, Matrix4, Mesh, PlaneGeometry, ShaderMaterial, Vector2, Vector3 } from 'three';
import { textureLoader } from '../engine/loaders/textures';
import { globalUBO } from '../engine/globals';
import { Reflector } from '../engine/reflector';
import { SceneModule } from './SceneModule';
import { globalUBODeclaration } from './materials';
import blendmodesGLSL from './glsl/blendmodes.glsl?raw';
import perturbnormalGLSL from './glsl/perturbnormal.glsl?raw';
import fresnelGLSL from './glsl/fresnel.glsl?raw';
import fitGLSL from './glsl/fit.glsl?raw';
import sinenoiseGLSL from './glsl/sinenoise.glsl?raw';
import colorutilsGLSL from './glsl/colorutils.glsl?raw';
import cloudsChunkGLSL from './glsl/cloudsChunk.glsl?raw';

export class Sea extends SceneModule {
  declare mesh: Mesh;

  protected init() {
    const geometry = new PlaneGeometry(500, 500);
    const skyPosition = new Vector3();

    const material = new ShaderMaterial({
      uniformsGroups: [globalUBO],
      uniforms: {
        tMap1: { value: textureLoader.load('sea1-normal-highq.ktx2', 'repeat') },
        uColor: { value: new Color('#5a7aa2') },
        uColorFoam: { value: new Color('#ffffff') },
        tCloudsTop: { value: textureLoader.load('clouds_top-highq.png', 'repeat') },
        tReflection: { value: null },
        textureMatrix: { value: new Matrix4() },
        uReflectionResolution: { value: new Vector2() },
        uNormalStr: { value: 0.2 },
      },
      vertexShader: `
        uniform mat4 textureMatrix;

        ${globalUBODeclaration}

        varying vec4 vCoord;
        varying vec3 vNormal;
        varying vec3 wPos;
        varying vec3 vPos;
        varying vec2 vUv;

        void main() {
          vUv = uv;
          vNormal = normalize(normalMatrix * normal);
          vCoord = textureMatrix * vec4(position, 1.0);

          float up = (sin(time * 0.5 + 23.124) + sin(time * 0.15 + 3213.32)) * 0.2;
          vec3 pos = (modelMatrix * vec4(position, 1.0)).xyz + vec3(0.0, up, 0.0);
          wPos = pos;
          vec4 viewPos = viewMatrix * vec4(pos, 1.0);

          vPos = viewPos.xyz;
          gl_Position = projectionMatrix * viewPos;
        }
      `,
      fragmentShader: `
        uniform sampler2D tCloudsTop;
        uniform sampler2D tMap1;
        uniform vec3 uColor;
        uniform vec3 uColorFoam;

        uniform sampler2D tReflection;
        uniform vec2 uReflectionResolution;
        uniform float uNormalStr;

        varying vec4 vCoord;
        varying vec3 vNormal;
        varying vec3 wPos;
        varying vec3 vPos;
        varying vec2 vUv;

        ${globalUBODeclaration}
        ${blendmodesGLSL}
        ${perturbnormalGLSL}
        ${fresnelGLSL}
        ${fitGLSL}
        ${sinenoiseGLSL}
        ${colorutilsGLSL}

        highp float rand(const in vec2 uv) {
          const highp float a = 12.9898, b = 78.233, c = 43758.5453;
          highp float dt = dot(uv.xy, vec2(a, b)), sn = mod(dt, 3.141592653589793);
          return fract(sin(sn) * c);
        }

        vec4 getReflection(sampler2D tMap, vec2 tMapResolution, vec2 uv, float roughness) {
          float framebufferLod = log2(tMapResolution.x) * roughness;
          return texture2D(tMap, uv, framebufferLod);
        }

        void main() {
          vec3 normal = normalize(vNormal);
          vec3 baseNormal = normal;
          vec2 uv1 = vUv * vec2(2.0) + vec2(time * 0.001, time * 0.002);
          vec3 normal1 = perturbNormal(-vPos, normal, tMap1, uv1, 1.4, 1.0);
          vec2 uv2 = vUv * vec2(1.0) + vec2(time * 0.003 + 123.23, time * 0.001);
          vec3 normal2 = perturbNormal(-vPos, normal, tMap1, uv2, 0.8, 1.0);
          normal = min(normal1, normal2);

          // reflection
          vec3 coord = vCoord.xyz / vCoord.w;
          vec2 normalDistortion = coord.z * normal.xz * uNormalStr;
          vec2 uvRef = (coord.xy - normalDistortion);
          vec4 ref = getReflection(tReflection, uReflectionResolution, uvRef, 0.0);
          vec3 col = mix(uColor, blendScreen(ref.rgb, uColor), fresnel(vPos, normal, 2.0));
          float fooam = step(0.1, sinenoise1(wPos.xyz * vec3(1.2, 1.0, 0.2) + vec3(time * 0.6, 0.0, 0.0))) *
            step(0.1, sinenoise1(wPos.xyz * vec3(1.1, 0.0, 0.2) + vec3(time * 1.1, 0.0, 0.0))) *
            step(0.1, sinenoise1(wPos.xyz * vec3(1.1, 2.0, 0.05) + vec3(time * 1.05, 2.0, 0.0)));

          // top clouds
          ${cloudsChunkGLSL}

          col *= fit(cloudsMult, 0.0, 1.0, 0.9, 1.0);
          col = mix(col, uColorFoam * fit(cloudsMult, 0.0, 1.0, 0.7, 1.0), fooam);

          gl_FragColor.rgb = col;
          gl_FragColor.a = 1.0;
        }
      `,
    });

    const reflector = new Reflector(
      {
        textureSize: 256,
        mirrorCameraZoom: 0.8,
        onBeforeReflectorRender: () => {
          const sky = this.scene.sky?.mesh;
          if (sky) {
            skyPosition.copy(sky.position);
            sky.position.setScalar(0);
            sky.scale.setScalar(1e5);
          }
        },
        onAfterReflectorRender: () => {
          const sky = this.scene.sky?.mesh;
          if (sky) {
            sky.position.copy(skyPosition);
            sky.scale.setScalar(2);
          }
        },
      },
      geometry,
      material,
    );

    this.mesh = reflector;
    this.mesh.name = 'sea';
    this.mesh.position.set(312, -0.815, 0);
    this.mesh.rotation.x = Math.PI * -0.5;
    this.mesh.updateMatrixWorld(true);
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.scene.add(this.mesh);
    this.ready.resolve();
  }
}
