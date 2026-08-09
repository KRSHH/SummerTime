// Global clock + frame loop. Port of the original `renderInfo`: one time
// source driven by the ticker; before each frame it updates `time`/`delta`,
// averages FPS and emits `webgl_prerender` → `webgl_render`.

import { events } from '../core/events';
import { onTick } from '../core/ticker';

export const clock = {
  time: 0,
  delta: 0,
  averageFPS: 0,

  private: {
    lastFramerateUpdateTime: 0,
    fpsAccumulator: 0,
    frames: 0,
  },

  /** Start the frame loop. Callbacks: onRender(time, delta). */
  start(onRender: (time: number, delta: number) => void): () => void {
    let last = 0;
    return onTick((time, _delta) => {
      const delta = last === 0 ? 0 : time - last;
      last = time;
      this.time = time;
      this.delta = delta;

      this.private.fpsAccumulator += delta;
      this.private.frames++;
      if (time - this.private.lastFramerateUpdateTime >= 1) {
        this.averageFPS = this.private.frames / Math.max(delta, 1e-6);
        this.private.lastFramerateUpdateTime = time;
        this.private.frames = 0;
        this.private.fpsAccumulator = 0;
      }

      events.emit('webgl_prerender', time, delta);
      events.emit('webgl_average_fps_update', this.averageFPS);
      onRender(time, delta);
      events.emit('webgl_render', time, delta);
    });
  },
};
