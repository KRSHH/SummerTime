// The environment: composes every scene module, the sun (CSM), audio, intro.

import { HemisphereLight, Spherical } from 'three';
import { gsap } from 'gsap';
import { CustomEase } from 'gsap/CustomEase';
import { events } from '../core/events';
import { client } from '../core/client';
import { BaseScene } from '../engine/scene';
import { AudioController } from '../engine/audio';
import { FollowSunLight } from '../engine/sunlight';
import { SceneModule } from './SceneModule';
import { Sky } from './sky';
import { Terrain } from './terrain';
import { Sea } from './sea';
import { Birds } from './birds';
import { Trees, Bushes, Palmtrees, Rocks1, Rocks2, Grass } from './vegetation';
import { Houses, Warehouses, Machines, Lightposts, Parasols, Castles, Blockers } from './structures';
import { UFO, Alien, Cats, Sloth, Sign, Gossip } from './setpieces';
import { CharactersModule } from './characters';
import type { MainController } from './mainController';

gsap.registerPlugin(CustomEase);

export class EnvironmentScene extends BaseScene {
  declare audioController: AudioController;
  declare sky: Sky;
  declare terrain: Terrain;
  declare sea: Sea;
  declare birds: Birds;
  declare trees: Trees;
  declare bushes: Bushes;
  declare lightposts: Lightposts;
  declare palmtrees: Palmtrees;
  declare houses: Houses;
  declare warehouses: Warehouses;
  declare machines: Machines;
  declare rocks1: Rocks1;
  declare rocks2: Rocks2;
  declare grass: Grass;
  declare parasols: Parasols;
  declare castles: Castles;
  declare blockers: Blockers;
  declare ufo: UFO;
  declare alien: Alien;
  declare sign: Sign;
  declare cats: Cats;
  declare sloth: Sloth;
  declare gossip: Gossip;
  declare characters: CharactersModule;

  constructor(_mainController: MainController) {
    super();
    this.init();
  }

  private async init() {
    this.setupCamera();
    this.audioController = new AudioController(this, 0.25);

    type ModuleCtor = new (scene: EnvironmentScene) => SceneModule;
    const modules: Array<[string, ModuleCtor]> = [
        ['characters', CharactersModule],
        ['sky', Sky],
        ['terrain', Terrain],
        ['sea', Sea],
        ['birds', Birds],
        ['trees', Trees],
        ['bushes', Bushes],
        ['lightposts', Lightposts],
        ['palmtrees', Palmtrees],
        ['houses', Houses],
        ['warehouses', Warehouses],
        ['machines', Machines],
        ['rocks1', Rocks1],
        ['rocks2', Rocks2],
        ['parasols', Parasols],
        ['castles', Castles],
        ['grass', Grass],
        ['blockers', Blockers],
        ['ufo', UFO],
        ['alien', Alien],
        ['sign', Sign],
        ['cats', Cats],
        ['sloth', Sloth],
        ['gossip', Gossip],
      ];
    await Promise.all(
      modules.map(([name, Module]) => {
        (this as any)[name] = new Module(this);
        return (this as any)[name].ready;
      }),
    );

    this.setupLights();
    (this.sea.mesh as any).addReflectedObject(this.sky.mesh);
    this.ready.resolve();
  }

  private setupCamera() {
    this.camera.shake.set(0.08, 0.08, 0.02);
    this.camera.shakeSpeed.setScalar(0.2);
    this.camera.near = 1;
    this.camera.far = 175;
    this.camera.updateProjectionMatrix();
    if (client.device === 'mobile') {
      this.camera.displacement.position.y = 0;
    }
  }

  private setupLights() {
    const hemi = new HemisphereLight('#33434f', '#737575', 0.7);
    this.add(hemi);

    const sun = new FollowSunLight({
      scene: this,
      positionOffset: new Spherical(100, Math.PI * 0.2, Math.PI * -1.75),
      forwardOffset: 6,
      castShadow: true,
      shadowMapSize: 2048,
      shadowSize: 12,
      csm: true,
      csmBoundingSphere: (this.characters.mesh._collisionPhysics as any)._colliderMesh?.geometry?.boundingSphere,
      csmNear: 50,
      csmLODLevel: client.oldIphone ? 1 : 3,
      skipCSMMeshes: [this.characters.mesh, this.sky.mesh, this.sea.mesh, this.birds.mesh],
    });
    sun.shadow.normalBias = 0.07;
    this.add(sun);
  }

  playIntroAnimation() {
    this.camera.followSphericalZoom = 12;
    this.camera.updateCamera();
    this.camera.spherical.copy(this.camera.sphericalTarget);
    gsap.to(this.camera, {
      followSphericalZoom: 0,
      delay: 0,
      ease: 'inOut3',
      duration: 6,
    });
    this.camera.touchAmount = 0;
    gsap.to(this.camera, {
      touchAmount: 1,
      delay: 4,
      duration: 4,
    });
    gsap.delayedCall(1.5, () => {
      events.emit('webgl_character_controls_enable', true);
      this.audioController.canPlaySound.resolve();
    });
  }
}
