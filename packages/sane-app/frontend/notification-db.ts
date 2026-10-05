/** All stores use a compound owner/key primary key. A readwrite transaction on
 * these stores serializes cross-tab page commits, including cursor comparison. */
const STORES = ["resume", "events", "reads", "accepted", "legacy"] as const;
export type NotificationTable = typeof STORES[number];
export type NotificationRows = Record<NotificationTable, Map<string, unknown>>;
const emptyRows = (): NotificationRows => ({ resume: new Map(), events: new Map(), reads: new Map(), accepted: new Map(), legacy: new Map() });
type Row = { scope: string; key: string; value: unknown };

export class NotificationDatabase {
  private connection: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;
  private generation = 0;
  close(): void { this.generation++; this.connection?.close(); this.connection = null; this.opening = null; }

  private open(): Promise<IDBDatabase> {
    if (this.connection) return Promise.resolve(this.connection);
    if (this.opening) return this.opening;
    const generation = this.generation;
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB unavailable")); return; }
      const request = indexedDB.open("sane.notifications.v3", 1);
      let abandoned = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of STORES) if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: ["scope", "key"] });
          store.createIndex("scope", "scope");
        }
      };
      request.onblocked = () => { abandoned = true; reject(new Error("Notification database upgrade blocked")); };
      request.onerror = () => reject(request.error ?? new Error("Notification database unavailable"));
      request.onsuccess = () => {
        const db = request.result;
        if (abandoned || generation !== this.generation) { db.close(); reject(new Error("Notification database binding changed")); return; }
        db.onversionchange = () => { db.close(); if (this.connection === db) this.connection = null; };
        db.onclose = () => { if (this.connection === db) this.connection = null; };
        this.connection = db; resolve(db);
      };
    });
    this.opening = pending;
    void pending.then(() => { if (this.opening === pending) this.opening = null; }, () => { if (this.opening === pending) this.opening = null; });
    return pending;
  }

  /** Mutator must be synchronous: it runs inside the last IDB request callback.
   * Results are returned only after oncomplete, never after a successful put. */
  async transaction<T>(scope: string, mutate: (rows: NotificationRows) => T, current: () => boolean): Promise<T> {
    const db = await this.open();
    if (!current()) throw new Error("Notification owner changed");
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction([...STORES], "readwrite"), rows = emptyRows();
      let remaining = STORES.length, result: T, failure: unknown;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => { /* onabort is the definitive failed-commit signal */ };
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("Notification commit aborted"));
      for (const name of STORES) {
        const store = tx.objectStore(name), request = store.index("scope").getAll(IDBKeyRange.only(scope));
        request.onsuccess = () => {
          try {
            for (const row of request.result as Row[]) {
              if (row.scope !== scope || typeof row.key !== "string") throw new Error("Invalid notification owner row");
              rows[name].set(row.key, row.value);
            }
            if (--remaining) return;
            if (!current()) { tx.abort(); return; }
            // Snapshot bytes, not references: the mutator may edit loaded
            // metadata/receipt objects in place before replacing table maps.
            const before = Object.fromEntries(STORES.map(n => [n,
              new Map([...rows[n]].map(([key, value]) => [key, JSON.stringify(value)])),
            ])) as Record<NotificationTable, Map<string, string | undefined>>;
            result = mutate(rows);
            for (const table of STORES) {
              const target = tx.objectStore(table);
              for (const key of before[table].keys()) if (!rows[table].has(key)) target.delete([scope, key]);
              for (const [key, value] of rows[table]) {
                if (!before[table].has(key) || before[table].get(key) !== JSON.stringify(value)) target.put({ scope, key, value } satisfies Row);
              }
            }
          } catch (error) { failure = error; tx.abort(); }
        };
      }
    });
  }
}
