export class EventBus<Events extends object> {
  private listeners = new Map<keyof Events, Set<(value: never) => void>>();
  on<K extends keyof Events>(event: K, listener: (value: Events[K]) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as (value: never) => void); this.listeners.set(event, set);
    return () => set.delete(listener as (value: never) => void);
  }
  emit<K extends keyof Events>(event: K, value: Events[K]): void {
    this.listeners.get(event)?.forEach(listener => listener(value as never));
  }
}
