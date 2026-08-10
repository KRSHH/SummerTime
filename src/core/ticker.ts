// A single global animation ticker. The original drove everything off
// GSAP's ticker; gsap 3.12+ replaced `ticker.ratio()` with the
// `ticker.deltaRatio` number, so the port exposes the same semantics.
import { gsap } from 'gsap';

export const ticker = gsap.ticker;

/** Frame-rate ratio (0..1-ish) of the last tick — original `ticker.ratio()`. */
export function tickerRatio(): number {
  return Math.min(5, ticker.deltaRatio());
}

/** Start the global render loop. Callbacks receive (time, deltaTime). */
export function onTick(callback: (time: number, delta: number) => void): () => void {
  ticker.add(callback);
  return () => ticker.remove(callback);
}
