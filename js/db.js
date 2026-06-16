/* db.js — IndexedDB layer (Plan §6.2: almacenamiento local).
 * The browser store is the temporary source of truth while offline.
 * Exposes a tiny promise-based wrapper on window.DB.
 */
(function () {
  const DB_NAME = 'oncogeriatria_seguimiento';
  const DB_VERSION = 1;

  // Object stores and their key/index setup.
  const STORES = {
    patients: { keyPath: 'client_id' },
    practitioners: { keyPath: 'id' },
    templates: { keyPath: 'id' },          // availability templates
    slots: { keyPath: 'id' },              // concrete agenda slots
    exceptions: { keyPath: 'id' },         // blocks / closures
    assessments: { keyPath: 'client_id' }, // follow-up assessments
    outbox: { keyPath: 'client_id' },      // offline operations queue
    conflicts: { keyPath: 'id' },          // conflict review queue
    notifications: { keyPath: 'client_id' },
    synclog: { keyPath: 'id' },            // human-readable sync events
    meta: { keyPath: 'k' }                 // misc flags (seeded, simOffline)
  };

  let _db = null;

  function open() {
    return new Promise((resolve, reject) => {
      if (_db) return resolve(_db);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        Object.entries(STORES).forEach(([name, cfg]) => {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: cfg.keyPath });
          }
        });
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode) {
    return open().then((db) => db.transaction(store, mode).objectStore(store));
  }

  const DB = {
    uuid() {
      if (crypto && crypto.randomUUID) return crypto.randomUUID();
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
    },

    put(store, value) {
      return tx(store, 'readwrite').then((os) => new Promise((res, rej) => {
        const r = os.put(value);
        r.onsuccess = () => res(value);
        r.onerror = () => rej(r.error);
      }));
    },

    bulkPut(store, values) {
      return open().then((db) => new Promise((res, rej) => {
        const t = db.transaction(store, 'readwrite');
        const os = t.objectStore(store);
        values.forEach((v) => os.put(v));
        t.oncomplete = () => res(values.length);
        t.onerror = () => rej(t.error);
      }));
    },

    get(store, key) {
      return tx(store, 'readonly').then((os) => new Promise((res, rej) => {
        const r = os.get(key);
        r.onsuccess = () => res(r.result || null);
        r.onerror = () => rej(r.error);
      }));
    },

    all(store) {
      return tx(store, 'readonly').then((os) => new Promise((res, rej) => {
        const r = os.getAll();
        r.onsuccess = () => res(r.result || []);
        r.onerror = () => rej(r.error);
      }));
    },

    delete(store, key) {
      return tx(store, 'readwrite').then((os) => new Promise((res, rej) => {
        const r = os.delete(key);
        r.onsuccess = () => res(true);
        r.onerror = () => rej(r.error);
      }));
    },

    clear(store) {
      return tx(store, 'readwrite').then((os) => new Promise((res, rej) => {
        const r = os.clear();
        r.onsuccess = () => res(true);
        r.onerror = () => rej(r.error);
      }));
    },

    async clearAll() {
      for (const name of Object.keys(STORES)) await this.clear(name);
    },

    async flag(k, v) {
      if (v === undefined) {
        const row = await this.get('meta', k);
        return row ? row.v : undefined;
      }
      return this.put('meta', { k, v });
    }
  };

  window.DB = DB;
})();
