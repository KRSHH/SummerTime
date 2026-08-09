// Pointer/multi-touch input system. Port of the original `initTouches` +
// `touch` classes: pointer events are routed into N "touch" slots that
// expose position (px), position01 (0..1, y-up), position11 (-1..1),
// delta, dragged, velocity and swipe velocity, and emit bus events:
//   touch_start / touch_move / touch_drag / touch_end / touch_click
//   touch2_* ... (one eventID per finger slot)

import { Vector2 } from 'three';
import { events } from '../core/events';
import { client } from '../core/client';
import { frictionFPS } from '../core/math';
import { ticker } from '../core/ticker';

const CLICK_DISTANCE = 15;
const CLICK_TIME = 0.75;
const VELOCITY_FRICTION = 0.95;

export interface TouchPointerEvent {
  clientX: number;
  clientY: number;
  pointerType: string;
  button: number;
  type: string;
}

export interface TouchData {
  finger: number;
  eventID: string;
  currentInput: 'mouse' | 'touch';
  button: number;
  touching: boolean;
  position: Vector2;
  position01: Vector2;
  position11: Vector2;
  delta: Vector2;
  delta11: Vector2;
  dragged: Vector2;
  dragged11: Vector2;
  velocity: Vector2;
  swipeVelocity: Vector2;
}

export const touches: Touch[] = [];

export function getAvailableTouch(): Touch | undefined {
  return touches.find((t) => t.touchID === false);
}

export function findTouch(pointerId: number): Touch | undefined {
  return touches.find((t) => t.touchID === pointerId);
}

export function getActiveTouches(): Touch[] {
  return touches.filter((t) => t.touching);
}

export class Touch {
  readonly finger: number;
  readonly eventID: string;
  touchID: number | false;
  currentInput: 'mouse' | 'touch';
  button = 0;
  touching = false;
  position = new Vector2(client.screen.w * 0.5, client.screen.h * 0.5);
  position01 = new Vector2(0.5, 0.5);
  position11 = new Vector2();
  delta = new Vector2();
  delta11 = new Vector2();
  dragged = new Vector2();
  dragged11 = new Vector2();
  velocity = new Vector2();
  swipeVelocity = new Vector2();

  private _start = this.position.clone();
  private _start01 = this.position01.clone();
  private _last = this.position.clone();
  private _last01 = this.position01.clone();
  private _startTime = 0;
  private _v = new Vector2();

  constructor(finger = 0) {
    this.finger = finger;
    this.touchID = false;
    this.eventID = finger === 0 ? 'touch' : `touch${finger + 1}`;
    this.currentInput = finger === 0 ? 'mouse' : 'touch';
    events.on('webgl_prerender', this._updateVelocity);
  }

  onStart(e: TouchPointerEvent) {
    this.touching = true;
    this._startTime = ticker.time;
    this._updatePosition(e);
    this._saveLastPosition();
    this._updateDelta();
    this._saveStartPosition();
    this._updateDrag();
    events.emit(`${this.eventID}_start`, this);
  }

  onMove(e: TouchPointerEvent) {
    this._updatePosition(e);
    this._updateDelta();
    events.emit(`${this.eventID}_move`, this);
    if (this.touching) {
      this._updateDrag();
      events.emit(`${this.eventID}_drag`, this);
    }
  }

  onEnd(e: TouchPointerEvent) {
    this._updatePosition(e);
    this._updateDelta();
    this._updateDrag();
    const wasTouching = this.touching;
    this.touching = false;
    if (!wasTouching) return;
    const duration = Math.max(0.001, ticker.time - this._startTime);
    this.swipeVelocity.copy(this.dragged).divideScalar(duration);
    events.emit(`${this.eventID}_end`, this);
    if (this.dragged.length() < CLICK_DISTANCE && duration < CLICK_TIME && e.type !== 'pointerout') {
      events.emit(`${this.eventID}_click`, this);
    }
  }

  private _updatePosition(e: TouchPointerEvent) {
    this.position.set(e.clientX, e.clientY);
    this.position01.copy(this.position);
    this.position01.x /= client.screen.w;
    this.position01.y /= client.screen.h;
    this.position01.y = 1 - this.position01.y;
    this.position11.copy(this.position01).multiplyScalar(2).subScalar(1);
    this.currentInput = e.pointerType === 'mouse' ? 'mouse' : 'touch';
    this.button = e.button;
  }

  private _updateDrag() {
    this.dragged.copy(this.position).sub(this._start);
    this.dragged11.copy(this.position01).sub(this._start01);
  }

  private _saveStartPosition() {
    this._start.copy(this.position);
    this._start01.copy(this.position01);
  }

  private _updateDelta() {
    this.delta.copy(this.position).sub(this._last);
    this.delta11.copy(this.position01).sub(this._last01);
    this._saveLastPosition();
    this._v.copy(this.delta11).multiplyScalar(2);
    this.velocity.add(this._v);
  }

  private _saveLastPosition() {
    this._last.copy(this.position);
    this._last01.copy(this.position01);
  }

  private _updateVelocity = () => {
    this.velocity.multiplyScalar(frictionFPS(VELOCITY_FRICTION));
    this.velocity.clampScalar(-1, 1);
    if (this.velocity.length() < 0.001) this.velocity.setScalar(0);
  };
}

export interface InitTouchesOptions {
  element?: HTMLElement | Window;
  fingers?: number;
  contextMenu?: boolean;
}

export function initTouches({
  element = window,
  fingers = 2,
  contextMenu = false,
}: InitTouchesOptions = {}) {
  for (let i = 0; i < fingers; i++) touches.push(new Touch(i));
  const el = element as HTMLElement;
  el.style.touchAction = 'none';
  if (el instanceof HTMLCanvasElement) el.style.userSelect = 'none';

  let allowTouchStart = false;

  const preventDefault = (e: Event) => e.preventDefault();

  const onPointerDown = (e: PointerEvent) => {
    const t = getAvailableTouch();
    if (!t) return;
    if (el instanceof HTMLCanvasElement && getActiveTouches().length === 0) {
      el.setPointerCapture(e.pointerId);
    }
    t.touchID = e.pointerId;
    t.onStart(e);
  };

  const onPointerMove = (e: PointerEvent) => {
    const t = findTouch(e.pointerId);
    if (t) {
      t.onMove(e);
    } else if (e.pointerType === 'mouse' && getActiveTouches().length === 0) {
      touches[0].onMove(e);
    }
  };

  const onPointerEnd = (e: PointerEvent) => {
    const t = findTouch(e.pointerId);
    if (!t) return;
    t.onEnd(e);
    t.touchID = false;
    if (el instanceof HTMLCanvasElement && getActiveTouches().length === 0) {
      el.releasePointerCapture(e.pointerId);
    }
  };

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerEnd);
  el.addEventListener('pointerout', onPointerEnd);
  el.addEventListener('pointercancel', onPointerEnd);
  if (!contextMenu) el.addEventListener('contextmenu', preventDefault);
  el.addEventListener(
    'touchstart',
    (e) => {
      if (!allowTouchStart) e.preventDefault();
    },
    { passive: false },
  );
  document.addEventListener('dblclick', preventDefault);

  /** Allow default browser touch behavior (used by the UI layer when needed). */
  return {
    allowClickEvents(v: boolean) {
      allowTouchStart = v;
    },
  };
}
