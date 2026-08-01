// IndexedDB wrapper. No external dependency — schema is small and stable.
const DB_NAME = 'serifu-trainer';
const DB_VERSION = 1;

const STORES = {
  scripts: 'id',
  roles: 'id',
  blocks: 'id',
  appearances: 'id',
  progress: 'blockId',
  sceneNotes: 'id',
};

const INDEXES = {
  roles: [['scriptId', 'scriptId', false]],
  blocks: [
    ['scriptId', 'scriptId', false],
    ['scriptId_order', ['scriptId', 'order'], false],
  ],
  appearances: [['scriptId', 'scriptId', false]],
  sceneNotes: [['scriptId', 'scriptId', false]],
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath });
        }
      }
      for (const [storeName, idxList] of Object.entries(INDEXES)) {
        const store = req.transaction.objectStore(storeName);
        for (const [idxName, keyPath] of idxList) {
          if (!store.indexNames.contains(idxName)) {
            store.createIndex(idxName, keyPath);
          }
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDb().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function wrapReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const db = {
  async put(storeName, value) {
    const store = await tx(storeName, 'readwrite');
    return wrapReq(store.put(value));
  },
  async putMany(storeName, values) {
    const store = await tx(storeName, 'readwrite');
    await Promise.all(values.map((v) => wrapReq(store.put(v))));
  },
  async get(storeName, key) {
    const store = await tx(storeName, 'readonly');
    return wrapReq(store.get(key));
  },
  async delete(storeName, key) {
    const store = await tx(storeName, 'readwrite');
    return wrapReq(store.delete(key));
  },
  async all(storeName) {
    const store = await tx(storeName, 'readonly');
    return wrapReq(store.getAll());
  },
  async byIndex(storeName, indexName, value) {
    const store = await tx(storeName, 'readonly');
    return wrapReq(store.index(indexName).getAll(value));
  },
  async clearByIndex(storeName, indexName, value) {
    const store = await tx(storeName, 'readwrite');
    const idx = store.index(indexName);
    const keys = await wrapReq(idx.getAllKeys(value));
    await Promise.all(keys.map((k) => wrapReq(store.delete(k))));
  },
  async deleteScriptCascade(scriptId) {
    await this.delete('scripts', scriptId);
    const roles = await this.byIndex('roles', 'scriptId', scriptId);
    const blocks = await this.byIndex('blocks', 'scriptId', scriptId);
    const appearances = await this.byIndex('appearances', 'scriptId', scriptId);
    const notes = await this.byIndex('sceneNotes', 'scriptId', scriptId);
    const store = await tx('roles', 'readwrite');
    await Promise.all(roles.map((r) => wrapReq(store.delete(r.id))));
    const bstore = await tx('blocks', 'readwrite');
    await Promise.all(blocks.map((b) => wrapReq(bstore.delete(b.id))));
    const astore = await tx('appearances', 'readwrite');
    await Promise.all(appearances.map((a) => wrapReq(astore.delete(a.id))));
    const nstore = await tx('sceneNotes', 'readwrite');
    await Promise.all(notes.map((n) => wrapReq(nstore.delete(n.id))));
    const pstore = await tx('progress', 'readwrite');
    const blockIds = new Set(blocks.map((b) => b.id));
    const allProgress = await this.all('progress');
    await Promise.all(
      allProgress.filter((p) => blockIds.has(p.blockId)).map((p) => wrapReq(pstore.delete(p.blockId)))
    );
  },
  async exportAll() {
    const names = Object.keys(STORES);
    const out = {};
    for (const name of names) out[name] = await this.all(name);
    return { version: DB_VERSION, exportedAt: Date.now(), data: out };
  },
  async importAll(payload) {
    if (!payload || !payload.data) throw new Error('不正なバックアップファイルです');
    for (const [name, rows] of Object.entries(payload.data)) {
      if (!STORES[name]) continue;
      await this.putMany(name, rows);
    }
  },
};

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}
