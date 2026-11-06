// Tiny IndexedDB key-value store. Keeps the chosen folder handle, which can't be
// stored in chrome.storage. Shared by the settings page, popup and offscreen
// document (same extension origin).

const DB_NAME = "video-downloader";
const STORE = "kv";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet(key) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbSet(key, value) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// The chosen folder handle and whether we may write to it right now.
export async function folderAccess() {
  const dir = (await idbGet("dir")) || null;
  if (!dir) return { dir: null, permission: null };
  try {
    return { dir, permission: await dir.queryPermission({ mode: "readwrite" }) };
  } catch {
    return { dir, permission: "denied" };
  }
}
