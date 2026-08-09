// Sky dome: skydome.bin + a custom shader with flowmapped drifting clouds.
// Shader GLSL is verbatim from the original.

import { Color, Mesh, ShaderMaterial } from 'three';
import { geometryLoader } from '../engine/loaders/geometries';
import { textureLoader } from '../engine/loaders/textures';
import { globalUBO } from '../engine/globals';
import { SceneModule } from './SceneModule';
import easesGLSL from './glsl/eases.glsl?raw';
import flowmapGLSL from './glsl/flowmap.glsl?raw';
import fitGLSL from './glsl/fit.glsl?raw';
import falloffGLSL from './glsl/falloff.glsl?raw';
import { globalUBODeclaration } from './materials';

export class Sky extends SceneModule {
  declare mesh: Mesh;

  protected async init() {
    const dome = await geometryLoader.load('skydome.bin');
    const material = new ShaderMaterial({
      uniformsGroups: [globalUBO],
      uniforms: {
        tMap: { value: textureLoader.load('sky-srgb-highq.png', 'srgb-repeat') },
        tFlow: { value: textureLoader.load('skyflow-highq.ktx2', 'repeat') },
        uColorHorizon: { value: new Color('#caf0fe') },
        uColorHorizonOverlay: { value: new Color('#d8eeff') },
        uColorSky: { value: new Color('#248fd5') },
        uColorClouds: { value: new Color('#ffe5c4') },
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 wPos;

        void main() {
          vUv = uv;
          wPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tMap;
        uniform sampler2D tFlow;
        uniform vec3 uColorHorizon;
        uniform vec3 uColorHorizonOverlay;
        uniform vec3 uColorSky;
        uniform vec3 uColorClouds;
        uniform vec3 uColorSun;
        varying vec2 vUv;
        varying vec3 wPos;

        ${globalUBODeclaration}
        ${easesGLSL}
        ${flowmapGLSL}
        ${fitGLSL}
        ${falloffGLSL}

        void main() {
          float limits = smoothstep(0.0, 0.025, vUv.y) * smoothstep(1.0, 1.0 - 0.025, vUv.y);
          float clouds = applyFlowmap(tMap, vUv * vec2(2.0, 1.0) + vec2(time * 0.001 + 0.135, 0.0), tFlow, vUv, 0.2, vec2(0.125, 0.075) * limits).r;

          vec3 color = mix(uColorHorizon, uColorSky, power1InOut(fit(wPos.y, -0.2, 0.35, 0.0, 1.0))); // horizon
          color = mix(color, uColorClouds, power2Out(clouds)); // clouds
          color = mix(color, uColorHorizonOverlay, fit(wPos.y, -0.04, 0.06, 1.0, 0.0)); // far horizon

          gl_FragColor.rgb = color;
          gl_FragColor.a = 1.0;
        }
      `,
      depthWrite: false,
    });

    this.mesh = new Mesh(dome, material);
    this.mesh.name = 'sky';
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.scale.setScalar(2);

    // the dome follows the camera
    this.scene.beforeRenderCbs.push(() => {
      this.mesh.position.copy(this.scene.camera.position);
    });

    this.scene.add(this.mesh);
    this.ready.resolve();
  }
}
