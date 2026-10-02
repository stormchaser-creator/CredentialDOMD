// A minimal in-memory IndexedDB for tests (the repo has no fake-indexeddb).
// Covers what src/utils/offlineStore.js uses: open with an upgrade, one
// object store, get/put/delete in readonly/readwrite transactions that run in
// the order they were created, a quota (in UTF-16 bytes, like Safari counts),
// an open that fails (private mode, a broken store; `failOpen` for every open,
// `failOpens` for the next n), a connection lost after it opened (`loseConnections`:
// every open connection's transactions then fail with UnknownError; and
// `closeConnections`: a closing one throws InvalidStateError), and writes refused by the store
// (`failWrites`). Synthetic data only.

function quotaError() {
  const error = new Error('The quota has been exceeded.');
  error.name = 'QuotaExceededError';
  error.code = 22;
  return error;
}

const later = () => new Promise(resolve => setImmediate(resolve));

export function createMemoryIndexedDB({ quotaBytes = Infinity } = {}) {
  const databases = new Map(); // name -> { version, stores: Map<storeName, Map<key, value>> }
  let chain = Promise.resolve();
  const connections = new Set();
  const factory = {
    failOpen: false,
    failOpens: 0,
    // The error a failing open reports (WebKit after iOS reclaimed the
    // IndexedDB process: UnknownError "Connection to Indexed Database server
    // lost"). Unset: the generic error the older tests expect.
    failOpenError: null,
    failWrites: false,
    quotaBytes,
    readHook: null,
    opened: 0,
    writes: [],
    /** Bytes held by every store, counted like localStorage (UTF-16). */
    usedBytes() {
      let n = 0;
      for (const db of databases.values()) for (const store of db.stores.values()) {
        for (const [k, v] of store) n += (String(k).length + (typeof v === 'string' ? v.length : JSON.stringify(v).length)) * 2;
      }
      return n;
    },
    /** The raw map of one store (for assertions). */
    dump(name = 'credentialdomd-offline', storeName = 'kv') {
      return databases.get(name)?.stores.get(storeName) || new Map();
    },
    /** Every connection open now is lost, as WebKit loses them after an installed app resumes. */
    loseConnections() { for (const db of connections) db.lost = true; },
    /** Every connection open now is closing without telling its holder: db.transaction throws InvalidStateError. */
    closeConnections() { for (const db of connections) db.closed = true; },
    open(name, version = 1) {
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      factory.opened += 1;
      setImmediate(() => {
        if (factory.failOpens > 0) {
          factory.failOpens -= 1;
          req.error = new Error('InvalidStateError');
          req.onerror?.({ target: req });
          return;
        }
        if (factory.failOpen) {
          req.error = factory.failOpenError
            ? Object.assign(new Error(factory.failOpenError.message || 'IndexedDB open failed'), { name: factory.failOpenError.name || 'Error' })
            : new Error('InvalidStateError');
          req.onerror?.({ target: req });
          return;
        }
        let rec = databases.get(name);
        const upgrade = !rec || rec.version < version;
        if (!rec) { rec = { version, stores: new Map() }; databases.set(name, rec); }
        const db = makeDb(rec);
        req.result = db;
        if (upgrade) { rec.version = version; req.onupgradeneeded?.({ target: req }); }
        req.onsuccess?.({ target: req });
      });
      return req;
    },
    deleteDatabase(name) { databases.delete(name); return { onsuccess: null }; },
  };

  function makeDb(rec) {
    const db = {
      closed: false,
      lost: false,
      objectStoreNames: { contains: n => rec.stores.has(n) },
      createObjectStore(n) { rec.stores.set(n, new Map()); return {}; },
      close() { this.closed = true; connections.delete(db); },
      transaction(storeName, mode = 'readonly') {
        if (db.closed) { const error = new Error('The database connection is closing.'); error.name = 'InvalidStateError'; throw error; }
        if (!rec.stores.has(storeName)) throw new Error('NotFoundError');
        const ops = [];
        const tx = { error: null, oncomplete: null, onerror: null, onabort: null, mode,
          objectStore() {
            const request = (fn) => { const r = { result: undefined, onsuccess: null }; ops.push({ r, fn }); return r; };
            return {
              get: key => request(store => (factory.readHook ? factory.readHook(key, store.get(key)) : store.get(key))),
              getAll: () => request(store => [...store.values()]),
              getAllKeys: () => request(store => [...store.keys()]),
              put: (value, key) => { if (mode !== 'readwrite') throw new Error('ReadOnlyError'); return request((store) => {
                const before = store.has(key) ? store.get(key) : null;
                const size = (v) => (typeof v === 'string' ? v.length : 0);
                const next = factory.usedBytes() - (before == null ? 0 : (String(key).length + size(before)) * 2) + (String(key).length + size(value)) * 2;
                if (next > factory.quotaBytes) throw quotaError();
                if (factory.failWrites) { const error = new Error('The transaction was aborted.'); error.name = 'AbortError'; throw error; }
                store.set(key, value);
                factory.writes.push(key);
                return key;
              }); },
              delete: key => { if (mode !== 'readwrite') throw new Error('ReadOnlyError'); return request(store => { store.delete(key); return undefined; }); },
            };
          },
        };
        chain = chain.then(later).then(() => {
          const store = rec.stores.get(storeName);
          const snapshot = new Map(store);
          if (db.lost) {
            const error = new Error('Connection to Indexed Database server lost. Refresh the page to try again');
            error.name = 'UnknownError';
            tx.error = error;
            tx.onerror?.({ target: tx });
            tx.onabort?.({ target: tx });
            return;
          }
          try {
            for (const { r, fn } of ops) { r.result = fn(store); r.onsuccess?.({ target: r }); }
          } catch (error) {
            // Aborted: nothing of the transaction stays.
            store.clear(); for (const [k, v] of snapshot) store.set(k, v);
            tx.error = error;
            tx.onerror?.({ target: tx });
            tx.onabort?.({ target: tx });
            return;
          }
          tx.oncomplete?.({ target: tx });
        });
        return tx;
      },
    };
    connections.add(db);
    return db;
  }
  return factory;
}

/** localStorage with Safari's ~5 MB per-origin quota counted in UTF-16 bytes. */
export class QuotaLocalStorage {
  constructor(quotaBytes = 5 * 1024 * 1024) { this.map = new Map(); this.quotaBytes = quotaBytes; this.failAll = false; }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { if (this.failAll) throw new Error('SecurityError'); return this.map.has(k) ? this.map.get(k) : null; }
  usedBytes() { let n = 0; for (const [k, v] of this.map) n += (k.length + v.length) * 2; return n; }
  setItem(k, v) {
    if (this.failAll) throw new Error('SecurityError');
    const value = String(v);
    const before = this.map.has(k) ? (k.length + this.map.get(k).length) * 2 : 0;
    if (this.usedBytes() - before + (k.length + value.length) * 2 > this.quotaBytes) throw quotaError();
    this.map.set(k, value);
  }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

/**
 * localStorage as WebKit counts it (measured in Playwright's WebKit,
 * 2026-10-02): 5 MiB an origin, a key or value at 1 byte a character when
 * every character is U+00FF or below, else at 2 bytes a character for the
 * whole string. One em dash in the offline file doubles what it costs.
 */
export class WebKitLocalStorage {
  constructor(quotaBytes = 5 * 1024 * 1024) { this.map = new Map(); this.quotaBytes = quotaBytes; }
  static cost(s) { const t = String(s); return t.length * (/[\u0100-\uffff]/.test(t) ? 2 : 1); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  usedBytes() { let n = 0; for (const [k, v] of this.map) n += WebKitLocalStorage.cost(k) + WebKitLocalStorage.cost(v); return n; }
  freeBytes() { return this.quotaBytes - this.usedBytes(); }
  setItem(k, v) {
    const value = String(v);
    const before = this.map.has(k) ? WebKitLocalStorage.cost(k) + WebKitLocalStorage.cost(this.map.get(k)) : 0;
    if (this.usedBytes() - before + WebKitLocalStorage.cost(k) + WebKitLocalStorage.cost(value) > this.quotaBytes) throw quotaError();
    this.map.set(k, value);
  }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
