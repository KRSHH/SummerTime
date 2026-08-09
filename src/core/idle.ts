export function scheduleIdle(callback: () => void): void {
  window.setTimeout(callback, 0);
}
