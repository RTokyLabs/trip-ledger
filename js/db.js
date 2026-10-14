// Local storage on the device (IndexedDB). The app reads and writes only here;
// sync.js copies changes to and from Supabase when there is a connection.
//
// Stores:
//   trips, expenses  — records, keyed by UUID. `dirty: 1` = changed here, not yet uploaded.
//                      Deleted records stay as tombstones (`deleted: true`) so the deletion syncs.
//   files            — receipt images/PDFs: { id, blob, type, uploaded: 0|1 }
//   meta             — { key, value } small settings (sync cursor, pending file deletions)

const DB_NAME = "trip-ledger";
const DB_VERSION = 1;
let dbp = null;

function req(r) {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

export function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const name of ["trips", "expenses"]) {
        const s = db.createObjectStore(name, { keyPath: "id" });
        s.createIndex("dirty", "dirty");
      }
      db.createObjectStore("files", { keyPath: "id" }).createIndex("uploaded", "uploaded");
      db.createObjectStore("meta", { keyPath: "key" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error("Close other open copies of the app and reload."));
  });
  return dbp;
}

async function tx(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then(v => { out = v; }, reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Storage transaction aborted"));
  });
}

export const getAll = store => tx([store], "readonly", t => req(t.objectStore(store).getAll()));
export const get = (store, id) => tx([store], "readonly", t => req(t.objectStore(store).get(id)));
export const put = (store, obj) => tx([store], "readwrite", t => req(t.objectStore(store).put(obj)));
export const del = (store, id) => tx([store], "readwrite", t => req(t.objectStore(store).delete(id)));
export const putMany = (store, objs) => tx([store], "readwrite", t => Promise.all(objs.map(o => req(t.objectStore(store).put(o)))));
export const getByIndex = (store, index, value) => tx([store], "readonly", t => req(t.objectStore(store).index(index).getAll(value)));

export async function getMeta(key, fallback = null) {
  const r = await get("meta", key);
  return r ? r.value : fallback;
}
export const setMeta = (key, value) => put("meta", { key, value });

/** Wipe everything on this device (used by "Remove data from this device"). */
export const clearAll = () => tx(["trips", "expenses", "files", "meta"], "readwrite",
  t => Promise.all(["trips", "expenses", "files", "meta"].map(s => req(t.objectStore(s).clear()))));
