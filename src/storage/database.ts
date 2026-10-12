export class LocalDatabase {
  private db: IDBDatabase | null = null;
  private memory = new Map<string, unknown>();
  mode: 'indexeddb' | 'localstorage' | 'memory' = 'memory';
  async open(): Promise<void> {
    try {
      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('radiodesk', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('workspace');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Storage upgrade blocked'));
      });
      this.mode = 'indexeddb';
    } catch {
      try { localStorage.setItem('radiodesk:probe', '1'); localStorage.removeItem('radiodesk:probe'); this.mode = 'localstorage'; } catch { this.mode = 'memory'; }
    }
  }
  async get<T>(key: string, fallback: T): Promise<T> {
    if (this.mode === 'indexeddb' && this.db) return new Promise((resolve, reject) => {
      const req = this.db!.transaction('workspace').objectStore('workspace').get(key);
      req.onsuccess = () => resolve(req.result ?? fallback); req.onerror = () => reject(req.error);
    });
    if (this.mode === 'localstorage') { const raw = localStorage.getItem(`radiodesk:${key}`); return raw ? JSON.parse(raw) as T : fallback; }
    return (this.memory.get(key) as T) ?? fallback;
  }
  async put(key: string, value: unknown): Promise<void> {
    if (this.mode === 'indexeddb' && this.db) return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('workspace', 'readwrite'); tx.objectStore('workspace').put(value, key);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('Save aborted'));
    });
    if (this.mode === 'localstorage') localStorage.setItem(`radiodesk:${key}`, JSON.stringify(value));
    else this.memory.set(key, value);
  }
}
