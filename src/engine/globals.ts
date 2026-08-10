// The engine singleton: renderer, composer, global uniform block, input
// wiring and adaptive DPR. Port of the original `global$1/global$2`.

import {
  Color,
  ColorManagement,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  sRGBEncoding,
  UnsignedByteType,
  UniformsGroup,
  Vector2,
  WebGLRenderTarget,
  WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { GammaCorrectionShader } from 'three/examples/jsm/shaders/GammaCorrectionShader.js';
import { deferred, type Deferred } from '../core/deferred';
import { events } from '../core/events';
import { client } from '../core/client';
import { ratioFPS } from '../core/math';
import { initTouches } from './input';
import { initTextureLoader } from './loaders/textures';
import { clock } from './clock';

/** Shared uniform block consumed by every custom shader:
 *  `uniform Global { vec2 resolution; float time; float dtRatio; };` */
export const globalUniforms = {
  resolution: { value: new Vector2(2, 2) },
  time: { value: 0 },
  dtRatio: { value: 1 },
};

export const globalUBO = new UniformsGroup();
globalUBO.setName('Global');
globalUBO.add(globalUniforms.resolution as any);
globalUBO.add(globalUniforms.time as any);
globalUBO.add(globalUniforms.dtRatio as any);

events.on('resize', (w: number, h: number) => {
  globalUniforms.resolution.value.set(w, h).multiplyScalar(engine.DPR).floor();
});
events.on('webgl_prerender', (time: number) => {
  globalUniforms.time.value = time;
  globalUniforms.dtRatio.value = ratioFPS();
});

/** Adaptive DPR: step the pixel ratio down/up to hold 30–60 fps. */
const onFpsUpdate = (fps: number) => adaptiveDPR.update(fps);
const adaptiveDPR = {
  running: false,
  initialWaitTime: 2,
  measureInterval: 4,
  minThresholdFPS: 30,
  maxThresholdFPS: 60,
  dprStep: 0.1,
  dprMinLimit: 0.7,
  pingPongLimit: 4,
  lastUpdateTime: 2,
  averages: [] as number[],
  direction: 0,
  pingPongs: 0,

  update(fps: number) {
    if (clock.time < this.initialWaitTime) return;
    this.averages.push(fps);
    if (clock.time - this.lastUpdateTime < this.measureInterval) return;
    const avg = this.averages.reduce((a, b) => a + b, 0) / this.averages.length;
    if (avg < this.minThresholdFPS && engine.adaptiveMultiplier > this.dprMinLimit) {
      engine.adaptiveMultiplier = Math.max(this.dprMinLimit, engine.adaptiveMultiplier - this.dprStep);
      engine.applyDPR();
      if (this.direction === 1) this.pingPongs++;
      this.direction = -1;
    } else if (avg >= this.maxThresholdFPS && engine.adaptiveMultiplier < 1) {
      engine.adaptiveMultiplier = Math.min(1, engine.adaptiveMultiplier + this.dprStep);
      engine.applyDPR();
      if (this.direction === -1) this.pingPongs++;
      this.direction = 1;
    }
    this.averages.length = 0;
    this.lastUpdateTime = clock.time;
    if (this.pingPongs >= this.pingPongLimit) {
      console.warn('Adaptive DPR stopped.');
      this.stop();
    }
  },

  start() {
    if (this.running) return;
    this.running = true;
    this.initialWaitTime = clock.time + 2;
    this.lastUpdateTime = this.initialWaitTime;
    events.on('webgl_average_fps_update', onFpsUpdate);
  },

  stop() {
    this.running = false;
    events.off('webgl_average_fps_update', onFpsUpdate);
  },
};

/** The scene rendered by the main composer: holds the fullscreen triangle
 *  and runs per-frame callbacks before each render. */
export class ComposerScene extends Scene {
  beforeRenderCbs: Array<() => void> = [];

  /** Warm-up pass: render everything once so programs/textures compile. */
  upload(): void {
    const renderer = engine.renderer;
    const previousTarget = renderer.getRenderTarget();
    const dummy = new WebGLRenderTarget(4, 4);
    renderer.setRenderTarget(dummy);
    renderer.render(this, new PerspectiveCamera(50, 1, 0.1, 2000));
    renderer.render(this, new PerspectiveCamera(50, 1, 0.1, 2000));
    renderer.setRenderTarget(previousTarget);
    dummy.dispose();
  }
}

export interface EngineOptions {
  webglContainer: HTMLElement;
  fingers?: number;
  contextMenu?: boolean;
  DPR?: number;
  adaptiveDPR?: boolean;
}

class Engine {
  renderer!: WebGLRenderer;
  composer!: EffectComposer;
  renderPass!: RenderPass;
  baseDPR = 1;
  adaptiveMultiplier = 1;
  active = false;
  clearColor = new Color('#000000');
  clearAlpha = 1;
  initialSceneLoaded: Deferred<void> = deferred();

  get DPR(): number {
    return this.baseDPR * this.adaptiveMultiplier;
  }

  private _initialized = false;

  init({
    webglContainer,
    fingers = 1,
    contextMenu = false,
    DPR = 1,
    adaptiveDPR: useAdaptive = true,
  }: EngineOptions) {
    if (this._initialized) return;
    this._initialized = true;
    this.baseDPR = DPR;
    this.setupRenderer(webglContainer);
    this.setupComposer();
    this.applyDPR();
    (this as any).touchController = initTouches({ element: webglContainer, fingers, contextMenu });
    initKeys();
    initTextureLoader(this.renderer);
    events.on('resize', this.resize); 
    if (useAdaptive) {
      this.initialSceneLoaded.then(() => adaptiveDPR.start());
    }
  }

  setupRenderer(container: HTMLElement) {
    this.renderer = new WebGLRenderer({
      powerPreference: 'high-performance',
      alpha: false,
      antialias: false,
      stencil: false,
      depth: false,
    });
    this.renderer.setClearColor(this.clearColor, this.clearAlpha);
    this.renderer.outputEncoding = sRGBEncoding;
    ColorManagement.legacyMode = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.info.autoReset = false;
    (this.renderer.capabilities as any).floatRenderTarget = !!this.renderer.extensions.has('EXT_color_buffer_float');
    (this.renderer.capabilities as any).floatLinearFiltering = !!this.renderer.extensions.has('OES_texture_float_linear');

    const el = this.renderer.domElement;
    el.style.display = 'block';
    el.style.position = 'absolute';
    el.style.top = '0';
    el.style.left = '0';

    // The original hides the canvas inside a closed shadow root — the DOM
    // shows nothing (screenshot tools / querySelector find no canvas).
    const host = document.createElement('div');
    host.attachShadow({ mode: 'closed' }).append(el);
    container.prepend(host);

    // canvas sizing happens in applyDPR() once the composer exists (init)
    this.renderer.setPixelRatio(this.DPR);
    this.renderer.setSize(client.screen.w, client.screen.h, false);
    const { w, h } = client.screen;
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
  }

  setupComposer() {
    const target = new WebGLRenderTarget(2, 2, {
      type: UnsignedByteType,
      encoding: sRGBEncoding,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.composer = new EffectComposer(this.renderer, target);
    this.renderPass = new RenderPass(new ComposerScene(), new PerspectiveCamera(50, 1, 0.1, 2000));
    this.composer.addPass(this.renderPass);
    this.composer.addPass(new SMAAPass(1, 1));
    this.composer.addPass(new ShaderPass(GammaCorrectionShader));
  }

  /** The composer scene (hosts the fullscreen triangle). */
  get mainScene(): ComposerScene {
    return this.renderPass.scene as ComposerScene;
  }

  private resize = (w = client.screen.w, h = client.screen.h) => {
    if (!this.renderer) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.composer?.setSize(w, h);
  };

  /** Re-apply the current DPR (canvas + composer + resolution uniform). */
  applyDPR() {
    const { w, h } = client.screen;
    this.renderer.setPixelRatio(this.DPR);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.composer.setPixelRatio(this.DPR);
    this.composer.setSize(w, h);
    events.emit('resize', w, h);
  }

  render(_time: number, delta: number) {
    if (!this.active) return;
    this.renderer.info.reset();
    for (const cb of this.mainScene.beforeRenderCbs) cb();
    this.composer.render(delta);
  }
}

function initKeys() {
  window.addEventListener('keydown', (e) => events.emit('keydown', e));
  window.addEventListener('keyup', (e) => events.emit('keyup', e));
}

export const engine = new Engine();
