import { describe, expect, test } from "bun:test";
import { NotificationDatabase } from "./notification-db";

/** A deliberately bounded IDB protocol stub: serialized readwrite transactions,
 * cloned rows, commit/abort, and controllable completion. Not browser IDB proof. */
export function controlledIDB() {
  const tables = new Map<string, Map<string, any>>();
  const waiting: (() => void)[] = [];
  let busy = false;
  const control = {
    quota: false, hold: false, commits: 0, aborts: 0, closed: 0,
    pending: [] as (() => void)[],
    release() { this.pending.splice(0).forEach(fn => fn()); },
    rows(table: string, scope: string) {
      return [...(tables.get(table)?.values() ?? [])].filter(r => r.scope === scope).map(r => structuredClone(r));
    },
    factory: { open: (_name: string, _version: number) => {
      const request: any = {};
      queueMicrotask(() => {
        const db: any = {
          objectStoreNames: { contains: (name: string) => tables.has(name) },
          createObjectStore(name: string, options: any) {
            expect(options.keyPath).toEqual(["scope", "key"]);
            tables.set(name, new Map());
            return { createIndex: (index: string, key: string) => { expect([index, key]).toEqual(["scope", "scope"]); } };
          },
          close: () => { control.closed++; },
          transaction(names: string[], mode: string) {
            expect(mode).toBe("readwrite");
            const reads: (() => void)[] = [];
            let draft: Map<string, Map<string, any>>, aborted = false;
            const tx: any = {
              error: null,
              abort() { aborted = true; },
              objectStore(name: string) {
                return {
                  index: (index: string) => {
                    expect(index).toBe("scope");
                    return { getAll(scope: string) {
                      const request: any = {};
                      reads.push(() => {
                        request.result = [...draft.get(name)!.values()].filter(r => r.scope === scope).map(r => structuredClone(r));
                        request.onsuccess?.();
                      });
                      return request;
                    } };
                  },
                  put(row: any) {
                    if (control.quota) { tx.error = new DOMException("Quota exceeded", "QuotaExceededError"); aborted = true; return; }
                    draft.get(name)!.set(JSON.stringify([row.scope, row.key]), structuredClone(row));
                  },
                  delete: (key: string[]) => { draft.get(name)!.delete(JSON.stringify(key)); },
                };
              },
            };
            const start = () => {
              busy = true;
              draft = new Map(names.map(name => [name, new Map([...tables.get(name)!].map(([key, row]) => [key, structuredClone(row)]))]));
              queueMicrotask(() => {
                for (const read of reads) { if (aborted) break; read(); }
                const finish = () => {
                  if (aborted) { control.aborts++; tx.onabort?.(); }
                  else { control.commits++; for (const [name, rows] of draft) tables.set(name, rows); tx.oncomplete?.(); }
                  busy = false; waiting.shift()?.();
                };
                if (control.hold) control.pending.push(finish); else queueMicrotask(finish);
              });
            };
            if (busy) waiting.push(start); else start();
            return tx;
          },
        };
        request.result = db;
        request.onupgradeneeded?.(); request.onsuccess?.();
      });
      return request;
    } },
  };
  return control;
}

export function installIDB(control?: ReturnType<typeof controlledIDB>) {
  const saved = ["indexedDB", "IDBKeyRange"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: control?.factory });
  Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, value: { only: (scope: string) => scope } });
  return () => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } };
}

export const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe("NotificationDatabase transactional protocol (controlled stub, not browser cross-tab verification)", () => {
  test("unavailable IDB rejects rather than silently claiming durability", async () => {
    const restore = installIDB();
    try { await expect(new NotificationDatabase().transaction("owner", () => 1, () => true)).rejects.toThrow("IndexedDB unavailable"); }
    finally { restore(); }
  });

  test("results wait for commit; all tables isolate owners and persist in-place mutations/deletes", async () => {
    const idb = controlledIDB(), restore = installIDB(idb), db = new NotificationDatabase();
    try {
      await db.transaction("other", rows => rows.events.set("same", { untouched: true }), () => true);
      idb.hold = true;
      let resolved = false;
      const pending = db.transaction("owner", rows => {
        rows.resume.set("state", { cursor: { after: 1 } }); rows.events.set("same", { value: 1 });
        rows.reads.set("read", 1); rows.accepted.set("run", { at: 1 }); rows.legacy.set("sidecar", { floor: 0 });
        return "committed";
      }, () => true).then(value => { resolved = true; return value; });
      await tick(); expect(resolved).toBe(false); expect(idb.rows("events", "owner")).toEqual([]);
      idb.hold = false; idb.release(); expect(await pending).toBe("committed");
      await db.transaction("owner", rows => {
        (rows.resume.get("state") as any).cursor.after = 2;
        (rows.events.get("same") as any).value = 2;
        rows.reads.delete("read");
      }, () => true);
      expect(idb.rows("resume", "owner")[0].value.cursor.after).toBe(2);
      expect(idb.rows("events", "owner")[0].value.value).toBe(2);
      expect(idb.rows("reads", "owner")).toEqual([]);
      expect(idb.rows("events", "other")[0].value).toEqual({ untouched: true });
      expect(idb.rows("accepted", "owner")).toHaveLength(1); expect(idb.rows("legacy", "owner")).toHaveLength(1);
    } finally { db.close(); restore(); }
  });

  test("serialized independent connections see prior committed cursor, and quota abort rolls back everything", async () => {
    const idb = controlledIDB(), restore = installIDB(idb), a = new NotificationDatabase(), b = new NotificationDatabase();
    try {
      const results = await Promise.all([a, b].map(db => db.transaction("owner", rows => {
        const before = rows.resume.get("cursor") ?? 0;
        if (before === 0) { rows.resume.set("cursor", 1); rows.events.set("E1", true); }
        return before;
      }, () => true)));
      expect(results).toEqual([0, 1]);
      idb.quota = true;
      await expect(a.transaction("owner", rows => { rows.events.delete("E1"); rows.resume.set("cursor", 2); rows.reads.set("E1", 1); }, () => true)).rejects.toThrow("Quota exceeded");
      expect(idb.rows("resume", "owner")[0].value).toBe(1);
      expect(idb.rows("events", "owner")).toHaveLength(1); expect(idb.rows("reads", "owner")).toEqual([]);
      idb.quota = false;
      expect(await b.transaction("owner", rows => rows.resume.get("cursor"), () => true)).toBe(1);
    } finally { a.close(); b.close(); restore(); }
  });

  test("throwing mutator and owner change abort before committing", async () => {
    const idb = controlledIDB(), restore = installIDB(idb), db = new NotificationDatabase();
    try {
      await expect(db.transaction("owner", rows => { rows.events.set("E1", true); throw new Error("invalid rows"); }, () => true)).rejects.toThrow("invalid rows");
      let checks = 0, mutations = 0;
      await expect(db.transaction("owner", () => { mutations++; }, () => ++checks === 1)).rejects.toThrow("Notification commit aborted");
      expect(mutations).toBe(0); expect(idb.rows("events", "owner")).toEqual([]);
    } finally { db.close(); restore(); }
  });

  test("close abandons an asynchronous open from the old binding", async () => {
    const idb = controlledIDB(), restore = installIDB(idb), db = new NotificationDatabase();
    try {
      const pending = db.transaction("old", () => true, () => true); db.close();
      await expect(pending).rejects.toThrow("binding changed"); expect(idb.closed).toBeGreaterThan(0);
      expect(await db.transaction("new", () => true, () => true)).toBe(true);
    } finally { db.close(); restore(); }
  });
});
