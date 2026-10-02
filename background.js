// Extension-origin IndexedDB. FileSystemHandles stored here survive
// toggling the extension off/on and reloading it. Audio bytes are never stored.
const DB_NAME = 'amfl-local-files';
const STORE = 'handles';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function withStore(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try { db.close(); } catch (closeErr) { /* ignore */ }
      if (err) reject(err);
      else resolve(value);
    };
    try {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      let value;
      if (request) {
        request.onsuccess = () => { value = request.result; };
        request.onerror = () => finish(request.error || tx.error);
      }
      tx.oncomplete = () => finish(null, value);
      tx.onerror = () => finish(tx.error || new Error('handle transaction failed'));
      tx.onabort = () => finish(tx.error || new Error('handle transaction aborted'));
    } catch (err) {
      finish(err);
    }
  }));
}

function putHandle(id, handle) {
  if (!id || !handle) return Promise.resolve(false);
  return withStore('readwrite', (store) => store.put('yes', 'amfl-marker')).then(() => (
    withStore('readwrite', (store) => store.put(handle, id)).then(() => true)
  ));
}

function keyList() {
  return withStore('readonly', (store) => store.getAllKeys()).then((keys) => keys || []);
}

function getHandle(id) {
  return withStore('readonly', (store) => store.get(id));
}

function deleteHandle(id) {
  return withStore('readwrite', (store) => store.delete(id)).then(() => true);
}

function allHandles() {
  return withStore('readonly', (store) => store.getAllKeys()).then((keys) => {
    const ids = keys || [];
    return ids.reduce((chain, id) => chain.then(async (map) => {
      map[id] = await getHandle(id);
      return map;
    }), Promise.resolve({}));
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'amfl-hard-reload') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (typeof tabId === 'number') chrome.tabs.reload(tabId, { bypassCache: true });
    return;
  }
  if (!message || !message.type || message.type.indexOf('amfl-handle-') !== 0) return;
  const done = (payload) => {
    try { sendResponse(payload); } catch (err) { /* port closed */ }
  };
  if (message.type === 'amfl-handle-put') {
    putHandle(message.id, message.handle).then(() => (
      Promise.all([getHandle(message.id), keyList()])
    )).then(([handle, keys]) => done({
      ok: !!(handle && typeof handle.getFile === 'function'),
      stored: !!(handle && typeof handle.getFile === 'function'),
      keys: (keys || []).length,
      marker: (keys || []).indexOf('amfl-marker') !== -1
    })).catch((err) => done({ ok: false, error: String(err && (err.name ? err.name + ': ' + err.message : err.message) || err) }));
    return true;
  }
  if (message.type === 'amfl-handle-get') {
    Promise.all([getHandle(message.id), keyList()]).then(([handle, keys]) => done({
      ok: true,
      handle: handle || null,
      keys: (keys || []).length,
      marker: (keys || []).indexOf('amfl-marker') !== -1
    })).catch((err) => done({ ok: false, error: String(err && err.message || err), handle: null, keys: 0 }));
    return true;
  }
  if (message.type === 'amfl-handle-all') {
    allHandles().then((handles) => done({ ok: true, handles: handles })).catch((err) => done({ ok: false, error: String(err && err.message || err), handles: {} }));
    return true;
  }
  if (message.type === 'amfl-handle-delete') {
    deleteHandle(message.id).then(() => done({ ok: true })).catch((err) => done({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  return undefined;
});
