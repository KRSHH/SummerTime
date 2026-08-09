import { gsap } from 'gsap';
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  sRGBEncoding,
  UnsignedByteType,
  WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { deferred, type Deferred } from '../core/deferred';
import { events } from '../core/events';
import { engine, globalUniforms } from '../engine/globals';
import { EnvironmentScene } from './environmentScene';
import { BaseShader, IntroShader } from './shaders-post';

function createFullscreenTriangle(): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  return new Mesh(geometry);
}

export class MainController {
  readonly ready: Deferred<void> = deferred();
  private state = 0;
  private readonly mainMesh: Mesh;
  private readonly baseMaterial: BaseShader;
  private readonly introMaterial: IntroShader;
  private environment!: EnvironmentScene;
  private environmentComposer!: EffectComposer;

  constructor() {
    this.baseMaterial = new BaseShader();
    this.introMaterial = new IntroShader();
    this.mainMesh = createFullscreenTriangle();
    this.mainMesh.frustumCulled = false;
    this.mainMesh.name = 'Main triangle mesh';
    void this.init();
  }

  private async init() {
    this.mainMesh.material = this.introMaterial;
    engine.mainScene.add(this.mainMesh);
    engine.mainScene.upload();

    this.environment = new EnvironmentScene(this);
    this.environmentComposer = new EffectComposer(engine.renderer, createComposerTarget());
    this.environmentComposer.renderToScreen = false;
    this.environmentComposer.addPass(new RenderPass(this.environment, this.environment.camera));
    this.environmentComposer.setSize(engine.renderer.domElement.width, engine.renderer.domElement.height);

    events.on('resize', this.resizeEnvironment);
    await Promise.all([
      this.environment.uploaded,
      this.loaded(this.introMaterial.uniforms.tIntro.value),
      this.loaded(this.introMaterial.uniforms.tLUT.value),
    ]);
    this.mainMesh.material = this.baseMaterial;
    engine.mainScene.upload();
    engine.mainScene.beforeRenderCbs.push(() => this.render());
    events.on('webgl_overlay_animation', this.overlayAnimation);
    this.ready.resolve();
    events.emit('webgl_render_active', true);

    await engine.initialSceneLoaded;
    void this.playIntro();
  }

  private loaded(texture: unknown): Promise<void> {
    const pending = (texture as { _loaded?: Promise<void> } | null)?._loaded;
    return pending ?? Promise.resolve();
  }

  private resizeEnvironment = () => {
    if (this.environmentComposer) {
      this.environmentComposer.setSize(globalUniforms.resolution.value.x, globalUniforms.resolution.value.y);
    }
  };

  private render() {
    this.environmentComposer.render();
    const sceneTexture = this.environmentComposer.readBuffer.texture;
    if (this.state === 0) {
      this.introMaterial.uniforms.tScene.value = sceneTexture;
      this.mainMesh.material = this.introMaterial;
    } else {
      this.baseMaterial.uniforms.tScene.value = sceneTexture;
      this.mainMesh.material = this.baseMaterial;
    }
  }

  private overlayAnimation = (value = 1) => {
    gsap.to(this.baseMaterial.uniforms.uOverlayTransition, {
      value,
      duration: 1,
      ease: 'power2.inOut',
    });
  };

  private async playIntro() {
    this.state = 0;
    this.environment.playIntroAnimation();
    await gsap.to(this.introMaterial.uniforms.uTransition, {
      value: 1,
      duration: 4,
      ease: 'none',
    });
    this.state = 1;
  }
}

function createComposerTarget(): WebGLRenderTarget {
  return new WebGLRenderTarget(2, 2, {
    type: UnsignedByteType,
    encoding: sRGBEncoding,
    depthBuffer: true,
    stencilBuffer: false,
  });
}
