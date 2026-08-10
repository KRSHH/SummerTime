export function scheduleIdle(callback: () => void): void {
  const ric = (window as any).requestIdleCallback as ((cb: () => void) => number) | undefined;
  if (ric) ric(callback);
  else window.setTimeout(callback, 16);
}
