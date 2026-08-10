// Set pieces and easter eggs: ufo, alien, sign, cats, sloth, gossip —
// skinned animated characters and interactable secrets (the hidden
// easter-egg modal triggers).

import { AnimationMixer, Mesh, Object3D } from 'three';
import { events } from '../core/events';
import { radians } from '../core/math';
import { clock } from '../engine/clock';
import { geometryLoader } from '../engine/loaders/geometries';
import { phongMaterial } from './materials';
import { SceneModule } from './SceneModule';

/** An easter egg: when the player gets close enough, show its text modal. */
export class Secret {
  completed = false;
  private _mesh: Mesh;
  private _player: Object3D;
  private _distance: number;
  private _text: string;

  constructor(options: { mesh: Mesh; player: Object3D; distance: number; text: string }) {
    this._mesh = options.mesh;
    this._player = options.player;
    this._distance = options.distance;
    this._text = options.text;
    events.emit('webgl_increase_easer_count');
  }

  check() {
    if (this.completed) return;
    if (this._mesh.position.distanceTo(this._player.position) < this._distance) {
      this.completed = true;
      events.emit('webgl_show_modal', this._text);
    }
  }
}

/** Animated skinned set piece (alien / cats / sloth). */
abstract class AnimatedCharacter extends SceneModule {
  declare mesh: Mesh;
  private _secret: Secret | null = null;
  protected _animRange = 10;
  protected _secretDistance = 3;

  protected async initCharacter(
    meshFile: string,
    bonesFile: string,
    animFile: string,
    materialOptions: Parameters<typeof phongMaterial>[0],
    position: [number, number, number],
    rotation?: [number, number, number],
    scale?: number,
    secretText?: string,
  ) {
    const [skinned, clip] = await Promise.all([
      geometryLoader.skin(meshFile, bonesFile),
      geometryLoader.skinAnimation(animFile),
    ]);
    skinned.material = phongMaterial(materialOptions);
    this.mesh = skinned;
    this.mesh.name = meshFile.replace('.bin', '');
    this.mesh.position.set(...position);
    if (rotation) this.mesh.rotation.set(radians(rotation[0]), radians(rotation[1]), radians(rotation[2]));
    if (scale) this.mesh.scale.setScalar(scale);
    this.mesh.updateMatrixWorld(true);
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.scene.add(this.mesh);

    const mixer = new AnimationMixer(this.mesh);
    const action = mixer.clipAction(clip);
    action.enabled = true;
    action.setEffectiveTimeScale(1);
    action.setEffectiveWeight(1);
    action.play();
    mixer.update(0.1);
    this.mesh.updateMatrixWorld();
    (this.mesh as any).skeleton.computeBoneTexture();

    this.mesh.onBeforeRender = () => {
      const player = this.scene.characters?.mesh?._localObject;
      if (!player) return;
      if (this.mesh.position.distanceTo(player.position) > this._animRange) return;
      mixer.update(clock.delta * 0.001);
      this.mesh.updateMatrixWorld();
      this._secret?.check();
    };

    this.scene.ready.then(() => {
      if (secretText) {
        this._secret = new Secret({
          mesh: this.mesh,
          player: this.scene.characters.mesh._localObject,
          distance: this._secretDistance,
          text: secretText,
        });
      }
    });
    this.ready.resolve();
  }
}

export class UFO extends SceneModule {
  declare mesh: Mesh;
  private _secret: Secret | null = null;

  protected async init() {
    const geometry = await geometryLoader.load('ufo.bin');
    this.mesh = new Mesh(geometry, phongMaterial({ isUFO: true }));
    this.mesh.name = 'ufo';
    this.mesh.position.set(-56.9402, 2.6553, 22.7015);
    this.mesh.updateMatrixWorld(true);
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.mesh.onBeforeRender = () => this._secret?.check();
    this.scene.add(this.mesh);
    this.scene.ready.then(() => {
      this._secret = new Secret({
        mesh: this.mesh,
        player: this.scene.characters.mesh._localObject,
        distance: 10,
        text: "It's a big metallic object. You want to believe it's some kind of vehicle.",
      });
    });
    this.ready.resolve();
  }
}

export class Alien extends AnimatedCharacter {
  protected _animRange = 30;
  protected init() {
    return super.initCharacter(
      'alien.bin',
      'alien-bones.bin',
      'alien-chill.bin',
      { isAlien: true },
      [60.14, 0.1, 40.6],
      [-90, 87.1, 90],
      undefined,
      "It's a very pale and strange looking man. He probably spends too much time on the computer.",
    );
  }
}

export class Cats extends AnimatedCharacter {
  protected _secretDistance = 2;
  protected init() {
    return super.initCharacter(
      'cats.bin',
      'cats-bones.bin',
      'cats-anim.bin',
      { isCats: true },
      [27.4644, 3.18224, -4.1086],
      [0, -106.078, 0],
      undefined,
      "If these two white cats weren't next to each other it would seem like they were the same one.",
    );
  }
}

export class Sloth extends AnimatedCharacter {
  protected init() {
    return super.initCharacter(
      'sloth.bin',
      'sloth-bones.bin',
      'sloth-anim.bin',
      { isSloth: true },
      [-8.38, 1.47, 46.16],
      [-30.8, -42.5, -25.7],
      0.8,
      'A sloth? That permanent smile it has is so creepy. What is it doing there?',
    );
  }
}

export class Sign extends SceneModule {
  declare mesh: Mesh;
  protected async init() {
    const geometry = await geometryLoader.load('sign.bin');
    this.mesh = new Mesh(geometry, phongMaterial({ isSign: true }));
    this.mesh.name = 'sign';
    this.mesh.updateMatrixWorld(true);
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.scene.add(this.mesh);
    this.ready.resolve();
  }
}

export class Gossip extends SceneModule {
  declare mesh: Mesh;
  private _secret: Secret | null = null;

  protected async init() {
    const geometry = await geometryLoader.load('gossip.bin');
    this.mesh = new Mesh(geometry, phongMaterial({ isGossip: true }));
    this.mesh.name = 'gossip';
    this.mesh.position.set(-55.9016, 1.47639, -47.3277);
    this.mesh.rotation.set(0, radians(-87.0408), 0);
    this.mesh.updateMatrixWorld(true);
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.onBeforeRender = () => this._secret?.check();
    this.scene.add(this.mesh);
    this.scene.ready.then(() => {
      this._secret = new Secret({
        mesh: this.mesh,
        player: this.scene.characters.mesh._localObject,
        distance: 2,
        text: 'These things look as if they have been taken out of a video game.',
      });
    });
    this.ready.resolve();
  }
}
