// The kid character: skinned mesh, four animation clips (idle/run/air/
// bored), local physics + controls, multiplayer connection, random colors.

import { Color, InstancedBufferAttribute, Mesh, Vector3 } from 'three';
import { events } from '../core/events';
import { geometryLoader } from '../engine/loaders/geometries';
import { Characters } from '../engine/characters';
import { depthCharsMaterial, phongMaterial } from './materials';
import { SceneModule } from './SceneModule';

export class CharactersModule extends SceneModule {
  declare mesh: Characters;
  seed = 0;

  protected async init() {
    const [skinned, clips, colliderGeometry] = await Promise.all([
      geometryLoader.skin('kid.bin', 'kid-bones.bin'),
      Promise.all(['kid-idle.bin', 'kid-run.bin', 'kid-air.bin', 'kid-bored.bin'].map((c) => geometryLoader.skinAnimation(c))),
      geometryLoader.load('collider.bin'),
    ]);

    skinned.geometry.setAttribute('instanceSeed', new InstancedBufferAttribute(new Float32Array(128), 1));
    skinned.material = phongMaterial({ isCharacters: true });
    skinned.customDepthMaterial = depthCharsMaterial();
    this.changeColor();
    events.on('webgl_character_randomize_color', this.changeColor);
    events.on('webgl_character_controls_enable', this.enableControls);

    const colliderMesh = new Mesh(colliderGeometry);

    this.mesh = new Characters(skinned, clips, {
      animationsOptions: [{ speed: 1 }, { speed: 1.1 }, { speed: 1 }, { speed: 1 }],
      colliderMesh,
      radiusPercentage: 0.2,
      floorDetectInclination: 0.8,
      positionForce: 0.005,
      damp: 0.92,
      initialPosition: [12.2, 2.25, -58],
      initialRadius: 4,
      camera: this.scene.camera,
      relativeCameraPosition: new Vector3(0, 1, -5.75),
      lookatMeshOffset: new Vector3(0, 1.1, 0.5),
      initialData: { seed: this.seed },
      customAttribUpdate: (local, _clientId, instanceId) => {
        this.mesh.geometry.attributes.instanceSeed.setX(instanceId, local.userData.seed);
      },
    });

    this.scene.beforeRenderCbs.push(() => {
      this.mesh.geometry.attributes.instanceSeed.needsUpdate = true;
      this.mesh.update();
      this.scene.audioController?.updatePlayerPosition(
        this.mesh._localObject.position.toArray(),
        this.mesh._localObject.velocityHorizontal,
        this.mesh._localObject.userData.a === 0,
      );
    });

    this.scene.add(this.mesh);
    this.scene.add(this.mesh._controls.circles);
    this.ready.resolve();
  }

  enableControls = (enabled: boolean) => {
    if (enabled) this.mesh._controls.enable();
    else this.mesh._controls.disable();
  };

  changeColor = () => {
    const color = Math.floor(Math.random() * 4);
    const seed = this.seed % 1;
    let hue = Math.random();
    while (Math.abs(hue - seed) < 0.2) hue = Math.random();
    this.seed = color + hue;
    if (this.mesh) this.mesh._localObject.userData.seed = this.seed;
    const c = new Color().setHSL(hue, 0.4, 0.3);
    events.emit('webgl_character_update_color', `#${c.getHexString()}`);
  };
}
