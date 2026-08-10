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
    let lastFpsTime = 0;
    const deltas: number[] = [];
    return onTick((time, _delta) => {
      const delta = last === 0 ? 16 : Math.round((time - last) * 1000);
      last = time;
      this.time = time;
      this.delta = delta;

      this.private.fpsAccumulator += delta;
      this.private.frames++;
      deltas.push(delta);
      if (time - lastFpsTime >= 0.5 && deltas.length > 1) {
        const avgDelta = deltas.reduce((a,b)=>a+b,0) / deltas.length;
        this.averageFPS = Math.round(1000 / Math.max(avgDelta, 1));
        deltas.length = 0; lastFpsTime = time;
        this.private.lastFramerateUpdateTime = time;
        }

      events.emit('webgl_prerender', time, delta);
      events.emit('webgl_average_fps_update', this.averageFPS);
      onRender(time, delta);
      events.emit('webgl_render', time, delta);
      events.emit('webgl_postrender', time, delta);
    });
  },
};
