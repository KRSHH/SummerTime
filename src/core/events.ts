// Minimal typed event bus. Port of the original eventemitter3-based `events`
// singleton, same event names and semantics, no dependency.

type Handler = (...args: any[]) => void;

const listeners = new Map<string, Set<Handler>>();

export const events = {
  on(event: string, handler: Handler): void {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(handler);
  },

  off(event: string, handler: Handler): void {
    listeners.get(event)?.delete(handler);
  },

  emit(event: string, ...args: any[]): void {
    const set = listeners.get(event);
    if (!set) return;
    for (const handler of [...set]) handler(...args);
  },
};
