// Runs in the Amazon Music page, not the extension isolated world.
// Handles are written here when the content script asks (type "put").
// Add songs is not handled in this page: the content script opens the picker.
(function () {
  'use strict';
  const DB_NAME = 'amfl-page-files';
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
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { db.close(); } catch (closeErr) { /* ignore */ }
        reject(err || new Error('handle transaction failed'));
      };
      try {
        const tx = db.transaction(STORE, mode);
        const request = fn(tx.objectStore(STORE));
        let value;
        request.onsuccess = () => { value = request.result; };
        request.onerror = () => fail(request.error || tx.error);
        tx.oncomplete = () => {
          if (settled) return;
          settled = true;
          resolve(value);
          try { db.close(); } catch (closeErr) { /* ignore */ }
        };
        tx.onerror = () => fail(tx.error || request.error);
        tx.onabort = () => fail(tx.error || new Error('handle transaction aborted'));
      } catch (err) {
        fail(err);
      }
    }));
  }

  function reply(token, payload) {
    window.postMessage(Object.assign({ source: 'amfl-page', token: token }, payload), '*');
  }


  let permitGestureArmed = false;
  let permitGestureItems = [];
  let permitGrantedHold = [];

  function permissionError(err) {
    const name = err && err.name;
    return name === 'NotAllowedError' || name === 'SecurityError' || name === 'AbortError';
  }

  async function finishPermit(items) {
    const files = [];
    const missing = [];
    const stillPrompt = [];
    for (const item of items) {
      if (!item || !item.id) continue;
      if (item.state !== 'granted') {
        stillPrompt.push(item.id);
        continue;
      }
      try {
        const file = await item.handle.getFile();
        files.push({ id: item.id, file: file });
      } catch (err) {
        if (err && err.name === 'NotFoundError') missing.push(item.id);
        else stillPrompt.push(item.id);
      }
    }
    return { ok: true, files: files, missing: missing, stillPrompt: stillPrompt, found: items.length };
  }

  function armPermitGesture(need, granted) {
    permitGestureItems = need;
    permitGrantedHold = granted || [];
    if (permitGestureArmed) return;
    permitGestureArmed = true;
    const once = () => {
      document.removeEventListener('pointerdown', once, true);
      document.removeEventListener('keydown', once, true);
      permitGestureArmed = false;
      const batch = permitGestureItems;
      const grantedNow = permitGrantedHold;
      permitGestureItems = [];
      permitGrantedHold = [];
      const reqs = batch.map((item) => {
        try {
          return item.handle.requestPermission({ mode: 'read' }).then((state) => {
            item.state = state || 'prompt';
          }).catch(() => { item.state = 'prompt'; });
        } catch (err) {
          item.state = 'prompt';
          return Promise.resolve();
        }
      });
      Promise.all(reqs).then(() => finishPermit(grantedNow.concat(batch))).then((result) => {
        window.postMessage(Object.assign({ source: 'amfl-page', type: 'permit-all-done' }, result), '*');
      });
    };
    document.addEventListener('pointerdown', once, true);
    document.addEventListener('keydown', once, true);
  }

  async function runPermitAll(ids) {
    const wanted = (ids && ids.length) ? ids : [];
    const items = [];
    for (const id of wanted) {
      if (!id || id === 'amfl-marker') continue;
      const handle = await withStore('readonly', (store) => store.get(id));
      if (!handle || typeof handle.getFile !== 'function') continue;
      let state = 'prompt';
      try {
        if (handle.queryPermission) state = await handle.queryPermission({ mode: 'read' });
      } catch (err) {
        state = 'prompt';
      }
      items.push({ id: id, handle: handle, state: state });
    }
    const need = items.filter((item) => item.state !== 'granted' && item.handle.requestPermission);
    const granted = items.filter((item) => item.state === 'granted');
    let notAllowed = false;
    if (need.length) {
      await Promise.all(need.map((item) => {
        try {
          return item.handle.requestPermission({ mode: 'read' }).then((state) => {
            item.state = state || 'prompt';
          }).catch((err) => {
            if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) notAllowed = true;
            item.state = item.state === 'granted' ? 'granted' : 'prompt';
          });
        } catch (err) {
          if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) notAllowed = true;
          item.state = 'prompt';
          return null;
        }
      }));
    }
    const stillNeed = need.filter((item) => item.state !== 'granted');
    if (notAllowed && stillNeed.length) {
      armPermitGesture(stillNeed, granted);
      const partial = await finishPermit(granted);
      partial.notAllowed = true;
      partial.armed = true;
      return partial;
    }
    return finishPermit(items);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'amfl-ext') return;
    const data = event.data;
    const token = data.token;
    if (data.type === 'put') {
      withStore('readwrite', (store) => store.put('yes', 'amfl-marker')).then(
        () => withStore('readwrite', (store) => store.put(data.handle, data.id))
      ).then(
        () => reply(token, { ok: true }),
        (err) => reply(token, { ok: false, error: (err && (err.name ? err.name + ': ' : '') + (err.message || err)) || 'put failed' })
      );
      return;
    }
    function permissionError(err) {
      const name = err && err.name;
      return name === 'NotAllowedError' || name === 'SecurityError' || name === 'AbortError';
    }

    function readSaved(id, ask) {
      return withStore('readonly', (store) => store.get(id)).then(async (handle) => {
        if (!handle || typeof handle.getFile !== 'function') {
          const keys = await withStore('readonly', (store) => store.getAllKeys());
          const names = (keys || []).map((key) => String(key)).join(',');
          return { ok: false, file: null, error: 'No saved handle (' + ((keys || []).length) + ' stored: ' + names + ').' };
        }
        let state = 'prompt';
        try {
          if (handle.queryPermission) state = await handle.queryPermission({ mode: 'read' });
        } catch (err) {
          state = 'prompt';
        }
        if (state !== 'granted' && ask && handle.requestPermission) {
          try { state = await handle.requestPermission({ mode: 'read' }); }
          catch (err) { state = 'prompt'; }
        }
        if (state !== 'granted') {
          return { ok: false, needsPermission: true, file: null, name: handle.name || '' };
        }
        try {
          const file = await handle.getFile();
          return { ok: true, file: file, name: handle.name || file.name || '' };
        } catch (err) {
          if (permissionError(err)) {
            return { ok: false, needsPermission: true, file: null, name: handle.name || '' };
          }
          const missing = err && err.name === 'NotFoundError';
          return { ok: false, file: null, missing: missing, error: (err && err.name) ? (err.name + ': ' + (err.message || '')) : String(err) };
        }
      });
    }

    if (data.type === 'permit-all') {
      runPermitAll(data.ids || []).then(
        (result) => reply(token, result),
        (err) => reply(token, { ok: false, error: String(err && err.message || err), notAllowed: !!(err && err.name === 'NotAllowedError') })
      );
      return;
    }
    if (data.type === 'read' || data.type === 'permit') {
      readSaved(data.id, data.type === 'permit').then(
        (result) => reply(token, result),
        (err) => reply(token, { ok: false, file: null, error: String(err && (err.name ? err.name + ': ' + err.message : err.message) || err) })
      );
      return;
    }
    if (data.type === 'get') {
      withStore('readonly', (store) => store.get(data.id)).then((handle) => {
        if (handle) {
          reply(token, { ok: true, handle: handle });
          return;
        }
        return withStore('readonly', (store) => store.getAllKeys()).then((keys) => {
          const n = (keys || []).length;
          const marker = (keys || []).indexOf('amfl-marker') !== -1;
          reply(token, { ok: false, handle: null, error: 'No saved handle (' + n + ' stored' + (marker ? ', marker' : '') + ').' });
        });
      }).catch((err) => reply(token, { ok: false, error: String(err && (err.name ? err.name + ': ' + err.message : err.message) || err), handle: null }));
      return;
    }
    if (data.type === 'stat') {
      withStore('readonly', (store) => store.getAllKeys()).then(
        (keys) => {
          const list = keys || [];
          reply(token, { ok: true, keys: list.length, marker: list.indexOf('amfl-marker') !== -1 });
        },
        (err) => reply(token, { ok: false, error: String(err && err.message || err), keys: 0 })
      );
      return;
    }
    if (data.type === 'delete') {
      withStore('readwrite', (store) => store.delete(data.id)).then(
        () => reply(token, { ok: true }),
        (err) => reply(token, { ok: false, error: String(err && err.message || err) })
      );
    }
  });


  document.addEventListener('dragover', (event) => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, true);
  document.addEventListener('drop', async (event) => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    event.stopPropagation();
    const list = event.dataTransfer.items ? Array.from(event.dataTransfer.items) : [];
    const fileList = event.dataTransfer.files ? Array.from(event.dataTransfer.files) : [];
    const items = [];
    const seen = new Set();
    function push(file, handle) {
      if (!file || seen.has(file)) return;
      seen.add(file);
      const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2);
      const real = handle && typeof handle.getFile === 'function' ? handle : null;
      items.push({ id: id, file: file, handle: real });
    }
    let chain = Promise.resolve();
    for (const item of list) {
      if (!item || item.kind !== 'file') continue;
      chain = chain.then(async () => {
        let handle = null;
        try {
          if (item.getAsFileSystemHandle) handle = await item.getAsFileSystemHandle();
        } catch (err) {
          handle = null;
        }
        if (handle && handle.requestPermission) {
          let state = 'prompt';
          try {
            if (handle.queryPermission) state = await handle.queryPermission({ mode: 'read' });
          } catch (err) {
            state = 'prompt';
          }
          if (state !== 'granted') {
            try { await handle.requestPermission({ mode: 'read' }); }
            catch (err) { /* permission is best-effort */ }
          }
        }
        push(item.getAsFile(), handle);
      });
    }
    await chain;
    for (const file of fileList) push(file, null);
    if (items.length) window.postMessage({ source: 'amfl-page', type: 'picked', ok: true, items: items }, '*');
  }, true);

})();
