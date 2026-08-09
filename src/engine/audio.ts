// Ambient audio controller. Port of the original `audioController`: five
// preloaded tracks (forest/beach/steps/song/click1) played through a
// positional AudioListener, crossfaded by the player's position on the map,
// with visibility muting, overlay-volume ducking and GSAP-synced looping.

import { Audio, AudioListener } from 'three';
import { gsap } from 'gsap';
import { deferred, type Deferred } from '../core/deferred';
import { events } from '../core/events';
import { clock } from './clock';
import { ease, fit } from '../core/math';
import type { BaseScene } from './scene';
import { scheduleIdle } from '../core/idle';

const AUDIO_URL = '/assets/audio/';

/** three.js Audio extended with a loop offset for GSAP-synced looping. */
export class LoopAudio extends Audio {
  loopOffset = 0;
  _progress = 0;

  /** Restart the loop from a computed position (used for sync). */
  syncLoop(time: number): void {
    this.pause();
    this._progress =
      ((time + this.loopOffset) * this.playbackRate) % (this.buffer?.duration || 1);
    this.offset = this._progress;
    this.play();
  }
}

export class AudioController {
  canPlaySound: Deferred<void> = deferred();

  private _scene: BaseScene;
  private _defaultVolume: number;
  private _multiplierVolume = 1;
  private _hasStarted = false;
  private _hasLoaded = false;
  private _listener: AudioListener | null = null;
  private _audios: Record<string, LoopAudio> = {};
  private _syncLoops: LoopAudio[] = [];
  private _syncGSAPOffset = 0;
  private _visibleState = true;
  private _muted = true;
  private _filesPreloaded: Deferred<void> = deferred();
  private _filesBuffers: ArrayBuffer[] = [];
  private _files: Array<{ name: string; url: string }> = [
    { name: 'forest', url: `${AUDIO_URL}forest.mp3` },
    { name: 'beach', url: `${AUDIO_URL}beach.mp3` },
    { name: 'steps', url: `${AUDIO_URL}footsteps.mp3` },
    { name: 'song', url: `${AUDIO_URL}song.mp3` },
    { name: 'click1', url: `${AUDIO_URL}click1.mp3` },
  ];

  constructor(scene: BaseScene, defaultVolume = 1) {
    this._scene = scene;
    this._defaultVolume = defaultVolume;

    events.on('visibility_change', this._onVisibilityChange);
    events.on('webgl_audio_mute_toggle', this._muteToggle);
    events.on('webgl_audio_play_sound', this.playSound);
    events.on('webgl_audio_overlay_volume', this.overlayVolume);

    scene.uploaded.then(async () => {
      const buffers = await Promise.all(
        this._files.map(async (f) => {
          const res = await fetch(f.url);
          if (!res.ok) throw new Error(`audio ${f.url} failed`);
          return res.arrayBuffer();
        }),
      );
      this._filesBuffers = buffers;
      this._filesPreloaded.resolve();
    });

    // start on first user interaction (autoplay policy)
    const start = () => this._start();
    document.body.addEventListener('click', start);
    events.on('touch_end', start);
    events.on('keydown', start);
  }

  private async _start() {
    if (!this._listener) {
      this._listener = new AudioListener();
      this._listener.setMasterVolume(0);
      this._scene.add(this._listener);
    }
    await this._listener.context.resume();
    if (this._hasStarted) return;
    this._hasStarted = true;
    if (this._muted) this._muteToggle();
    await Promise.all([this._createAudios(), new Promise((r) => setTimeout(r, 500)), this.canPlaySound]);

    const click = this._audios.click1!;
    click.setLoop(false);
    click.stop();
    click.setVolume(0.25);
    this._audios.steps!.loopOffset = 0.125;
    this._syncLoops.push(this._audios.steps!);
    this._hasLoaded = true;
    if (this._visibleState && !this._muted) {
      this._listener.gain.gain.setTargetAtTime(this._defaultVolume, this._listener.context.currentTime, 1);
    }
  }

  private async _createAudios() {
    await this._filesPreloaded;
    const done = deferred<void>();
    let next = 0;
    let loaded = 0;
    const step = () => {
      const index = next++;
      if (index === this._files.length) {
        done.resolve();
        return;
      }
      const buffer = this._filesBuffers[index]!.slice(0);
      this._listener!.context.decodeAudioData(buffer, (decoded) => {
        const audio = new LoopAudio(this._listener!);
        this._audios[this._files[index].name] = audio;
        audio.setBuffer(decoded);
        audio.setLoop(true);
        audio.setVolume(0);
        audio.play();
        if (++loaded === this._files.length) done.resolve();
      });
      scheduleIdle(step);
    };
    step();
    await done;
  }

  private _onVisibilityChange = (visible: boolean) => {
    if (!this._hasLoaded || !this._listener) return;
    if (visible) {
      if (!this._visibleState) {
        this._visibleState = true;
        if (!this._muted) {
          this._listener.gain.gain.setTargetAtTime(this._defaultVolume, this._listener.context.currentTime, 2);
        }
      }
    } else if (this._visibleState) {
      this._visibleState = false;
      this._listener.gain.gain.setTargetAtTime(0, this._listener.context.currentTime, 0.5);
    }
  };

  private _muteToggle = () => {
    this._muted = !this._muted;
    events.emit('webgl_audio_update_mute', this._muted);
    if (this._hasLoaded && this._listener) {
      const target = this._muted ? 0 : this._defaultVolume;
      this._listener.gain.gain.setTargetAtTime(target, this._listener.context.currentTime, this._muted ? 0.25 : 0.5);
    }
  };

  private _syncAudioWithGsap() {
    if (!this._listener) return;
    const drift = clock.time - this._listener.context.currentTime;
    if (Math.abs(drift - this._syncGSAPOffset) > 0.025) {
      for (const loop of this._syncLoops) loop.syncLoop(clock.time);
      this._syncGSAPOffset = drift;
    }
  }

  playSound = (name: string) => {
    this._audios[name]?.stop();
    this._audios[name]?.play(0);
  };

  overlayVolume = (volume = 1) => {
    gsap.to(this, {
      _multiplierVolume: volume,
      duration: 1.35,
    });
  };

  /** Called every frame with the player's world position + speed. */
  updatePlayerPosition(position: number[] = [0, 0, 0], speed = 0, onFloor = true) {
    if (!this._hasLoaded || !this._visibleState) return;
    this._syncAudioWithGsap();
    this._audios.song?.setVolume(0.5 * this._multiplierVolume);

    // crossfade forest ↔ beach by world X position
    const blend = fit(position[0], 35, 65, 0, 1);
    (['forest', 'beach'] as const).forEach((name, i) => {
      const audio = this._audios[name];
      const volume = (i === 0 ? 1 - blend : blend) * this._multiplierVolume;
      audio.setVolume(volume);
      if (volume === 0) {
        if (audio.isPlaying) audio.pause();
      } else if (!audio.isPlaying) {
        audio.play();
      }
    });

    this._audios.steps.setVolume(
      ease(fit(speed, 0.001, 0.05, 0, 1) * (onFloor ? 1 : 0), 'power2.in') * this._multiplierVolume,
    );
  }
}
