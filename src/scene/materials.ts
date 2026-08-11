// Shared scene material: one ShaderMaterial with per-object `defines` switching
// features (grass, terrain, wind, toon, skinning...); GLSL is verbatim from the
// original in src/scene/glsl/. Also rewrites `lights_fragment_begin` to blend
// each light's shadow term with a custom cascaded shadow map (CSM).

import {
  Color,
  Matrix4,
  MeshDepthMaterial,
  RGBADepthPacking,
  ShaderChunk,
  ShaderMaterial,
  UniformsUtils,
  UniformsLib,
  Vector2,
  Vector3,
  Vector4,
  DoubleSide,
  FrontSide,
} from 'three';
import { engine, globalUBO } from '../engine/globals';
import { textureLoader } from '../engine/loaders/textures';

// ---- GLSL chunks (verbatim from the decompiled bundle) ----
import vertexSource from './glsl/vertex.glsl?raw';
import fragmentSource from './glsl/fragment.glsl?raw';
import fitSource from './glsl/fit.glsl?raw';
import sinenoiseSource from './glsl/sinenoise.glsl?raw';
import colorutilsSource from './glsl/colorutils.glsl?raw';
import cloudsChunkSource from './glsl/cloudsChunk.glsl?raw';
import fogChunkSource from './glsl/fogChunk.glsl?raw';

export const globalUBODeclaration = 'uniform Global{vec2 resolution;float time;float dtRatio;};';

/** Apply the original CSM shadow rewrite to three.js's r148 light chunk. */
function buildTweakedLightsFragment(): string {
  const searchStr = 'directLight.color *= ';
  let tweaked = ShaderChunk.lights_fragment_begin;
  let start = tweaked.indexOf(searchStr);
  while (start !== -1) {
    const end = tweaked.indexOf(';', start);
    const statement = tweaked.substring(start, end);
    const shadowExpr = statement.substring(searchStr.length);
    // The original material uses one shared shadow channel for the active
    // light. This is intentionally `_shadow0`; the ramp shader reads that
    // same value for terrain, props, foliage, and characters.
    const shadowVar = '_shadow0';
    const csmVar = '_csmShadow0';
    tweaked = tweaked.replace(
      `${statement};`,
      `
        float shadowTransition = linearstep(csmOptions.z, csmOptions.w, length(csmTarget - wPos));

        ${shadowVar} = shadowTransition < 0.999 && ${shadowExpr};
        ${csmVar} = shadowTransition > 0.001 ? getShadow(csmMap, vec2(csmOptions.x), csmBiases.y, csmOptions.y, vCsmShadowCoord) : 1.0;

        // shorten range and smooth shadow borders so shadowmap pixels are less obvious
        ${shadowVar} = smoothstep(0.1, 0.9, ${shadowVar});
        ${csmVar} = smoothstep(0.1, 1.0, ${csmVar});

        #ifndef IS_INTERIOR
            ${shadowVar} = mix(${shadowVar}, ${csmVar}, shadowTransition);
        #endif

        // same as three.js
        directLight.color = directLight.color * ${shadowVar};
      `,
    );
    start = tweaked.indexOf(searchStr);
  }
  return tweaked;
}

const tweakedLightsFragment = buildTweakedLightsFragment();

/** Base uniforms for every phong material (three common+lights + customs). */
const uniforms = UniformsUtils.merge([
  UniformsLib.common,
  UniformsLib.lights,
  {
    emissive: { value: new Color(0) },
    specular: { value: new Color(0x111111) },
    shininess: { value: 30 },
    tRamp: { value: null },
    tCloudsTop: { value: null },
    csmMap: { value: null },
    csmMatrix: { value: new Matrix4() },
    csmOptions: { value: new Vector4() },
    csmBiases: { value: new Vector2(0.07, 1e-6) },
    csmTarget: { value: new Vector3() },
  },
]);

export interface PhongMaterialOptions {
  isHouse?: boolean;
  isHouse2?: boolean;
  isWarehouse?: boolean;
  isMachine?: boolean;
  isParasol?: boolean;
  isBlocker?: boolean;
  isSign?: boolean;
  isCharacters?: boolean;
  isTerrain?: boolean;
  isTree?: boolean;
  isBush?: boolean;
  isLightPost?: boolean;
  isWires?: boolean;
  isRock?: boolean;
  isPalmTree?: boolean;
  isCastles?: boolean;
  isGrass?: boolean;
  isUFO?: boolean;
  isAlien?: boolean;
  isCats?: boolean;
  isSloth?: boolean;
  isGossip?: boolean;
}

/** Build a phong ShaderMaterial with the feature defines toggled on. */
export function phongMaterial(options: PhongMaterialOptions = {}): ShaderMaterial {
  const defines: Record<string, string | number | boolean> = {};
  const material = new ShaderMaterial({
    defines,
    uniformsGroups: [globalUBO],
    uniforms: UniformsUtils.clone(uniforms),
    vertexShader: vertexSource
      .replace('${globalUBO}', globalUBODeclaration)
      .replace('${sinenoise}', sinenoiseSource)
      .replace('${fit}', fitSource),
    fragmentShader: fragmentSource
      .replace('${globalUBO}', globalUBODeclaration)
      .replace('${linearstep}', 'float linearstep(float begin,float end,float t){return clamp((t-begin)/(end-begin),0.0,1.0);}')
      .replace('${fit}', fitSource)
      .replace('${colorutils}', colorutilsSource)
      .replace('${cloudsChunk}', cloudsChunkSource)
      .replace('${fogChunk}', fogChunkSource)
      .replace('${tweakedLightsFragment}', tweakedLightsFragment),
    lights: true,
  });

  defines.RECEIVE_SHADOW_CLOUDS = 1;
  defines.USE_RAMP = 1;
  material.uniforms.tCloudsTop.value = textureLoader.load('clouds_top.ktx2', 'repeat');
  // progressive: swap in the high-quality clouds texture after the initial load
  engine.initialSceneLoaded.then(() => textureLoader.loadProgressive('clouds_top-highq.ktx2', material.uniforms.tCloudsTop));

  if (options.isCharacters) {
    defines.IS_CHARACTER = 1;
    material.shadowSide = 0; // FrontSide
  }
  if (options.isTerrain) {
    defines.IS_TERRAIN = 1;
    material.uniforms.map.value = textureLoader.load('terrain-road-highq.png', 'colordata');
    (material as any).map = material.uniforms.map.value;
    material.uniforms.tMasks = { value: textureLoader.load('masks.ktx2') };
    material.uniforms.tTerrNoises = { value: textureLoader.load('terrain-noises-highq.png', 'repeat') };
    material.uniforms.tTerrDetails = { value: textureLoader.load('terrain-details-highq.png', 'repeat') };
    material.uniforms.grassColor1 = { value: new Color('#558f6e') };
    material.uniforms.grassColor2 = { value: new Color('#9bc2a4') };
    engine.initialSceneLoaded.then(() => textureLoader.loadProgressive('masks.png', material.uniforms.tMasks));
  }
  if (options.isTree || options.isBush) {
    defines.SHAKE = 1;
    material.shadowSide = 0;
  }
  if (options.isLightPost) {
    defines.USE_RAMP = 1;
  }
  if (options.isWires) {
    defines.SHAKE = 1;
    defines.LIGHTWIRES = 1;
    material.side = DoubleSide
  }
  if (options.isRock) {
    material.shadowSide = 0;
  }
  if (options.isPalmTree) {
    material.shadowSide = 0;
    material.side = DoubleSide
    defines.SHAKE = 1;
  }
  if (options.isHouse2 || options.isCastles) {
    material.shadowSide = 0;
  }
  if (options.isGrass) {
    material.side = FrontSide
    material.transparent = true;
    material.uniforms.map.value = textureLoader.load('grass-patches-highq.ktx2', 'colordata');
    material.uniforms.charPos = { value: new Vector3() };
    material.uniforms.charSpeed = { value: 0 };
    defines.GRASS = 1;
    defines.REACT_CHARACTER = 1;
    defines.PLANE_FACE_CHARACTER = 1;
    defines.FADE_AWAY = '60.0';
    defines.RANDOM_ATTRIB = 1;
    (material as any).map = material.uniforms.map.value;
  }
  if (options.isUFO) {
    material.side = FrontSide;
  }
  if (options.isAlien || options.isCats || options.isSloth) {
    material.shadowSide = 0;
  }
  if (options.isGossip) {
    defines.GOSSIP = 1;
    defines.IS_INTERIOR = 1;
    material.uniforms.map.value = textureLoader.load('gossip.ktx2');
    (material as any).map = material.uniforms.map.value;
  }
  if (defines.USE_RAMP) {
    material.uniforms.tRamp.value = textureLoader.load('ramps.png', 'srgb-colordata');
  }
  (material as any).ignore = true;
  return material;
}

/** Custom depth material for the skinned character (instanced bone texture). */
export function depthCharsMaterial(): MeshDepthMaterial {
  const material = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <skinning_pars_vertex>',
      `
        #ifdef USE_SKINNING
            attribute int instanceID;

            uniform mat4 bindMatrix;
            uniform mat4 bindMatrixInverse;
            uniform sampler2D boneTexture;
            uniform int boneTextureSize;

            mat4 getBoneMatrix(const in float i) {
                int x = int(i) * 4;
                vec4 v1 = texelFetch(boneTexture, ivec2(x, instanceID), 0);
                vec4 v2 = texelFetch(boneTexture, ivec2(x + 1, instanceID), 0);
                vec4 v3 = texelFetch(boneTexture, ivec2(x + 2, instanceID), 0);
                vec4 v4 = texelFetch(boneTexture, ivec2(x + 3, instanceID), 0);
                mat4 bone = mat4(v1, v2, v3, v4);
                return bone;
            }
        #endif
      `,
    );
  };
  (material as any).ignore = true;
  return material;
}
