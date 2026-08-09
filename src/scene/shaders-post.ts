// Final image composition: the environment is rendered into a render target
// and drawn as a fullscreen triangle through one of two shaders:
//
//  - introShader (state 0): LUT grade + crossfade from the intro photo
//  - baseShader  (state 1):  LUT grade + white overlay flash
//
// Shader GLSL is verbatim from the original (3D LUT with tetrahedral
// interpolation).

import { Color, ShaderMaterial } from 'three';
import { textureLoader } from '../engine/loaders/textures';
import { globalUBO } from '../engine/globals';
import { globalUBODeclaration } from './materials';
import falloffGLSL from './glsl/falloff.glsl?raw';
import transformUVGLSL from './glsl/transformUV.glsl?raw';
import lutGLSL from './glsl/lut.glsl?raw';

const fullscreenVS = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

/** Load the LUT texture and report its size once ready. */
async function applyLUTSize(material: ShaderMaterial): Promise<void> {
  const lut = material.uniforms.tLUT.value as any;
  await lut._loaded;
  material.uniforms.uLUTSize.value = lut.image.width;
}

export class BaseShader extends ShaderMaterial {
  constructor() {
    super({
      uniformsGroups: [globalUBO],
      uniforms: {
        tScene: { value: null },
        tLUT: { value: textureLoader.load('lut.CUBE_1.LUT.ktx2', 'luttetrahedral') },
        uLUTSize: { value: 1 },
        uLUTIntensity: { value: 1 },
        uOverlayColor: { value: new Color('#FFF9EE') },
        uOverlayTransition: { value: 0 },
      },
      vertexShader: fullscreenVS,
      fragmentShader: `
        ${globalUBODeclaration}
        ${lutGLSL}

        uniform sampler2D tScene;
        uniform sampler3D tLUT;
        uniform float uLUTSize;
        uniform float uLUTIntensity;
        uniform vec3 uOverlayColor;
        uniform float uOverlayTransition;

        varying vec2 vUv;

        void main() {
          vec4 scene = texture2D(tScene, vUv);

          // 3D lut
          vec3 col = apply3DLUTTetrahedral(scene.rgb, tLUT, uLUTSize, uLUTIntensity);

          // white transition
          vec3 color = mix(col, uOverlayColor, uOverlayTransition * 0.9);

          gl_FragColor = vec4(color, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    setTimeout(() => void applyLUTSize(this), 0);
  }
}

export class IntroShader extends ShaderMaterial {
  constructor() {
    super({
      uniformsGroups: [globalUBO],
      uniforms: {
        tScene: { value: null },
        tLUT: { value: textureLoader.load('lut.CUBE_1.LUT.ktx2', 'luttetrahedral') },
        uLUTSize: { value: 1 },
        uLUTIntensity: { value: 1 },
        tIntro: { value: textureLoader.load('transition-intro.jpg') },
        uInitialColor: { value: new Color('#FFFDF8') },
        uTransition: { value: 0 },
      },
      vertexShader: fullscreenVS,
      fragmentShader: `
        ${globalUBODeclaration}
        ${falloffGLSL}
        ${transformUVGLSL}
        ${lutGLSL}

        uniform sampler2D tScene;
        uniform sampler3D tLUT;
        uniform float uLUTSize;
        uniform float uLUTIntensity;
        uniform sampler2D tIntro;
        uniform vec3 uInitialColor;
        uniform float uTransition;

        varying vec2 vUv;

        void main() {
          vec4 scene = texture2D(tScene, vUv);

          // 3D lut
          vec3 color = apply3DLUTTetrahedral(scene.rgb, tLUT, uLUTSize, uLUTIntensity);

          vec2 uvIntro = vUv - 0.5;
          uvIntro *= resolution / max(resolution.x, resolution.y);
          uvIntro += 0.5;

          uvIntro = scaleUV(uvIntro, 1.0 + 1.0 * uTransition);

          float t = 1.0 - texture2D(tIntro, uvIntro).r;
          vec3 col = mix(uInitialColor, color, falloffsmooth(t, 0.0, 1.0, 0.001, uTransition));

          gl_FragColor = vec4(col, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    setTimeout(() => void applyLUTSize(this), 0);
  }
}
