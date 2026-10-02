// Amazon Music Local Files.
// Anchors to a real playlist titled exactly "LOCAL PLACEHOLDER".
// Audio bytes are never written to chrome.storage. Persistent picks are
// File System Access handles in IndexedDB. A plain file input keeps File
// objects in memory for the session only.
(function () {
  'use strict';

  const PLACEHOLDER = 'LOCAL PLACEHOLDER';
  const DISPLAY = 'Local Files';
  const AMFL_MARK = 'amfl-20261002p';
  const WEB_API_KEY = 'amzn1.application.4ff5579ca2e3407aba989a1f5dbdaf69';

  const sessionFiles = new Map();
  const pendingPaths = new Set();
  const handleCache = new Map();
  const fileErrors = new Map();
  const MISSING_FILE = "Couldn't open this file. It may have been moved.";
  let files = [];
  let storedId = '';
  let amazonTracksSweepStarted = false;
  let observer = null;
  let scheduled = false;
  let silenceTimer = 0;
  let barHide = null;
  let queueCleared = false;
  let autoTried = false;
  let objectUrl = '';
  let queueKeySeq = 1;
  let playlistSort = 'added';

  const player = {
    queue: [],
    // Unshuffled queue keys. Not the on-screen order: the playing song is
    // always shown first, even when it was not first here.
    order: [],
    index: 0,
    shuffle: false,
    repeat: 'off',
    queueOpen: false,
    only: false,
    active: false,
    dragging: false
  };

  const audio = document.createElement('audio');
  audio.id = 'amfl-audio';
  audio.className = 'amfl-audio';
  audio.preload = 'auto';

  function tld() {
    const match = location.hostname.match(/\.amazon\.(com|ca|com\.br|com\.mx|co\.uk|de|fr|it|es|in|co\.jp|com\.au|ae)$/);
    return match ? match[1] : 'com';
  }

  function ensurePageStore() {
    let script = document.getElementById('amfl-page-files');
    if (script && script.dataset.loaded === '1') return Promise.resolve();
    if (!script) {
      script = document.createElement('script');
      script.id = 'amfl-page-files';
      script.src = chrome.runtime.getURL('page-files.js');
      (document.head || document.documentElement).appendChild(script);
    }
    return new Promise((resolve, reject) => {
      const done = () => { script.dataset.loaded = '1'; resolve(); };
      if (script.dataset.loaded === '1') { resolve(); return; }
      script.addEventListener('load', done, { once: true });
      script.addEventListener('error', () => reject(new Error('page store failed to load')), { once: true });
    });
  }

  async function pageSend(message, timeoutMs) {
    await ensurePageStore();
    const token = Math.random().toString(16).slice(2);
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve({ ok: false, error: 'page store timeout' });
      }, timeoutMs || 4000);
      function onMsg(event) {
        if (event.source !== window || !event.data || event.data.source !== 'amfl-page' || event.data.token !== token) return;
        window.clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(event.data);
      }
      window.addEventListener('message', onMsg);
      window.postMessage(Object.assign({ source: 'amfl-ext', token: token }, message), '*');
    });
  }


  function openCsDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('amfl-cs-files', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function withCs(mode, fn) {
    return openCsDb().then((db) => new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { db.close(); } catch (closeErr) { /* ignore */ }
        reject(err || new Error('handle transaction failed'));
      };
      try {
        const tx = db.transaction('handles', mode);
        const request = fn(tx.objectStore('handles'));
        let value;
        if (request) {
          request.onsuccess = () => { value = request.result; };
          request.onerror = () => fail(request.error || tx.error);
        }
        tx.oncomplete = () => {
          if (settled) return;
          settled = true;
          resolve(value);
          try { db.close(); } catch (closeErr) { /* ignore */ }
        };
        tx.onerror = () => fail(tx.error || new Error('handle transaction failed'));
        tx.onabort = () => fail(tx.error || new Error('handle transaction aborted'));
      } catch (err) {
        fail(err);
      }
    }));
  }

  async function csKeys() {
    try {
      const keys = await withCs('readonly', (store) => store.getAllKeys());
      return keys || [];
    } catch (err) {
      return ['err:' + ((err && err.message) || err)];
    }
  }

  function workerSend(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const err = chrome.runtime.lastError;
          if (err) resolve({ ok: false, error: err.message || String(err) });
          else resolve(response || { ok: false, error: 'empty background response' });
        });
      } catch (err) {
        resolve({ ok: false, error: (err && err.message) || String(err) });
      }
    });
  }

  async function idbPut(id, handle) {
    if (handle) handleCache.set(id, handle);
    const bg = await workerSend({ type: 'amfl-handle-put', id: id, handle: handle });
    const pagePut = await pageSend({ type: 'put', id: id, handle: handle });
    const pageStat = await pageSend({ type: 'stat' });
    const landed = !!(bg && bg.stored) || !!(pageStat && pageStat.marker);
    if (!landed) throw new Error('Could not store the file handle.');
    return true;
  }
  async function idbGet(id) {
    if (handleCache.has(id)) return handleCache.get(id);
    const page = await pageSend({ type: 'read', id: id });
    if (page && page.file) {
      const handle = {
        getFile: () => Promise.resolve(page.file),
        queryPermission: () => Promise.resolve('granted'),
        requestPermission: () => Promise.resolve('granted')
      };
      handleCache.set(id, handle);
      sessionFiles.set(id, page.file);
      fileErrors.delete(id);
      return handle;
    }
    if (page && page.needsPermission) {
      fileErrors.set(id, 'Click the song to allow access.');
      return { needsPermission: true };
    }
    const bg = await workerSend({ type: 'amfl-handle-get', id: id });
    const bgHandle = bg && bg.handle;
    if (bgHandle && typeof bgHandle.getFile === 'function') {
      handleCache.set(id, bgHandle);
      return bgHandle;
    }
    if (page && page.missing) {
      fileErrors.set(id, MISSING_FILE);
      return null;
    }
    const pageWhy = (page && page.error) || 'page missing';
    fileErrors.set(id, page && page.error ? 'Click the song to allow access.' : MISSING_FILE);
    if (pageWhy) return null;
    return null;
  }
  async function idbDelete(id) {
    handleCache.delete(id);
    try { await workerSend({ type: 'amfl-handle-delete', id: id }); } catch (err) { /* ignore */ }
    try { await withCs('readwrite', (store) => store.delete(id)); } catch (err) { /* ignore */ }
    await pageSend({ type: 'delete', id: id });
  }

  async function loadMeta() {
    const data = await chrome.storage.local.get({
      files: [],
      pendingDeletes: [],
      placeholderId: '',
      shuffle: false
    });
    if (data.placeholderId) storedId = data.placeholderId;
    player.shuffle = !!data.shuffle;
    const pending = data.pendingDeletes || [];
    for (const id of pending) {
      sessionFiles.delete(id);
      fileErrors.delete(id);
      try { await idbDelete(id); } catch (err) { /* ignore */ }
    }
    let stored = (data.files || []).slice();
    if (pending.length) {
      const drop = new Set(pending);
      const kept = stored.filter((file) => !drop.has(file.id));
      stored = kept;
      await chrome.storage.local.set({ files: kept, pendingDeletes: [] });
    }
    // A failed or empty handle read must not shrink chrome.storage. Only an
    // explicit delete (pendingDeletes / remove) removes a song.
    files = stored;
    for (const file of files) {
      if (!file || !file.persistent || sessionFiles.has(file.id)) continue;
      try { await idbGet(file.id); } catch (err) { /* keep the row either way */ }
    }
    files.forEach((file) => {
      if (file && sessionFiles.has(file.id)) ensureCover(file.id, sessionFiles.get(file.id));
    });
  }

  async function saveFiles() {
    await chrome.storage.local.set({ files: files });
  }

  function stripExt(name) {
    return String(name || '').replace(/\.[^.]+$/, '');
  }

  function fromFilename(name) {
    const base = stripExt(name);
    const match = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (match) return { artist: match[1].trim(), title: match[2].trim() };
    return { artist: '', title: base || 'Untitled' };
  }

  function decodeText(bytes, encoding) {
    try {
      if (encoding === 0) return new TextDecoder('iso-8859-1').decode(bytes);
      if (encoding === 1 || encoding === 2) return new TextDecoder('utf-16').decode(bytes);
      return new TextDecoder('utf-8').decode(bytes);
    } catch (err) {
      return '';
    }
  }

  function frameText(body) {
    if (!body || !body.length) return '';
    const text = decodeText(body.subarray(1), body[0]).replace(/\0/g, '').trim();
    return text;
  }

  async function readTags(file) {
    const fallback = fromFilename(file.name);
    try {
      const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
      if (head.length > 10 && String.fromCharCode(head[0], head[1], head[2]) === 'ID3') {
        const size = ((head[6] & 127) << 21) | ((head[7] & 127) << 14) | ((head[8] & 127) << 7) | (head[9] & 127);
        let offset = 10;
        const end = Math.min(head.length, 10 + size);
        let title = '';
        let artist = '';
        let duration = 0;
        while (offset + 10 < end) {
          const id = String.fromCharCode(head[offset], head[offset + 1], head[offset + 2], head[offset + 3]);
          const len = (head[offset + 4] << 24) | (head[offset + 5] << 16) | (head[offset + 6] << 8) | head[offset + 7];
          if (!id || id === '\0\0\0\0' || len <= 0) break;
          const body = head.subarray(offset + 10, offset + 10 + len);
          if (id === 'TIT2') title = frameText(body);
          if (id === 'TPE1') artist = frameText(body);
          if (id === 'TLEN') {
            const ms = Number(frameText(body));
            if (Number.isFinite(ms) && ms > 0) duration = ms / 1000;
          }
          offset += 10 + len;
        }
        if (title || artist || duration) {
          return { title: title || fallback.title, artist: artist || fallback.artist, duration: duration };
        }
      }
      const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 128)).arrayBuffer());
      if (tail.length === 128 && String.fromCharCode(tail[0], tail[1], tail[2]) === 'TAG') {
        const title = decodeText(tail.subarray(3, 33), 0).replace(/\0/g, '').trim();
        const artist = decodeText(tail.subarray(33, 63), 0).replace(/\0/g, '').trim();
        if (title || artist) return { title: title || fallback.title, artist: artist || fallback.artist };
      }
    } catch (err) { /* tags are optional */ }
    return fallback;
  }

  function knownDuration(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 6 * 3600) return 0;
    return seconds;
  }

  function probeDuration(file) {
    return new Promise((resolve) => {
      let url = '';
      try {
        if (!file || typeof URL.createObjectURL !== 'function') {
          resolve(0);
          return;
        }
        url = URL.createObjectURL(file);
        const el = document.createElement('audio');
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (url) URL.revokeObjectURL(url);
          el.removeAttribute('src');
          try { el.load(); } catch (err) { /* ignore */ }
          resolve(knownDuration(value));
        };
        const timer = setTimeout(() => finish(0), 2500);
        el.preload = 'metadata';
        el.addEventListener('loadedmetadata', () => finish(el.duration));
        el.addEventListener('error', () => finish(0));
        el.src = url;
      } catch (err) {
        if (url) URL.revokeObjectURL(url);
        resolve(0);
      }
    });
  }

  const coverUrls = new Map();
  const coverMiss = new Set();
  const coverPending = new Set();

  function sniffMime(bytes) {
    if (!bytes || bytes.length < 12) return '';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
    return '';
  }

  function u32(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
  }

  function synchsafeAt(bytes, offset) {
    return ((bytes[offset] & 127) << 21) | ((bytes[offset + 1] & 127) << 14) | ((bytes[offset + 2] & 127) << 7) | (bytes[offset + 3] & 127);
  }

  function latin1(bytes, start, len) {
    let out = '';
    const end = Math.min(bytes.length, start + len);
    for (let i = start; i < end; i += 1) out += String.fromCharCode(bytes[i]);
    return out;
  }

  function deunsync(bytes) {
    const out = new Uint8Array(bytes.length);
    let n = 0;
    for (let i = 0; i < bytes.length; i += 1) {
      out[n] = bytes[i];
      n += 1;
      if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i += 1;
    }
    return out.subarray(0, n);
  }

  function pictureRank(type) {
    if (type === 3) return 0;
    if (type === 0) return 1;
    return 2;
  }

  function keepPicture(best, next) {
    if (!next || !next.data || next.data.length < 32) return best;
    const mime = sniffMime(next.data) || (next.mime && next.mime.indexOf('image/') === 0 ? next.mime : '');
    if (!mime) return best;
    next.mime = mime;
    if (!best || pictureRank(next.type) < pictureRank(best.type)) return next;
    return best;
  }

  function parseApic(body) {
    if (!body || body.length < 4) return null;
    let i = 0;
    const encoding = body[i];
    i += 1;
    let mimeEnd = i;
    while (mimeEnd < body.length && body[mimeEnd] !== 0) mimeEnd += 1;
    const mime = latin1(body, i, mimeEnd - i).trim().toLowerCase();
    i = mimeEnd + 1;
    if (i >= body.length || mime === '-->') return null;
    const type = body[i];
    i += 1;
    if (encoding === 1 || encoding === 2) {
      while (i + 1 < body.length && !(body[i] === 0 && body[i + 1] === 0)) i += 2;
      i += 2;
    } else {
      while (i < body.length && body[i] !== 0) i += 1;
      i += 1;
    }
    if (i >= body.length) return null;
    return { mime: mime, type: type, data: body.subarray(i) };
  }

  function parsePicV22(body) {
    if (!body || body.length < 6) return null;
    let i = 1;
    const format = latin1(body, i, 3).toUpperCase();
    i += 3;
    const type = body[i];
    i += 1;
    const encoding = body[0];
    if (encoding === 1 || encoding === 2) {
      while (i + 1 < body.length && !(body[i] === 0 && body[i + 1] === 0)) i += 2;
      i += 2;
    } else {
      while (i < body.length && body[i] !== 0) i += 1;
      i += 1;
    }
    if (i >= body.length) return null;
    const mime = format === 'PNG' ? 'image/png' : (format === 'JPG' || format === 'JPEG' ? 'image/jpeg' : '');
    return { mime: mime, type: type, data: body.subarray(i) };
  }

  async function extractId3Picture(file) {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head.length < 10 || latin1(head, 0, 3) !== 'ID3') return null;
    const version = head[3];
    if (version < 2 || version > 4) return null;
    const flags = head[5];
    let size = synchsafeAt(head, 6);
    if (size <= 0) return null;
    const cap = 8 * 1024 * 1024;
    if (size > cap) size = cap;
    let tag = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
    if (!tag.length) return null;
    if (flags & 0x80) tag = deunsync(tag);
    let offset = 0;
    if (flags & 0x40 && tag.length >= 4) {
      if (version === 4) {
        const ext = synchsafeAt(tag, 0);
        if (ext >= 6 && ext <= tag.length) offset = ext;
      } else {
        const ext = u32(tag, 0);
        const next = 4 + ext;
        if (next > 0 && next <= tag.length) offset = next;
      }
    }
    let best = null;
    if (version === 2) {
      while (offset + 6 <= tag.length) {
        const id = latin1(tag, offset, 3);
        if (!/^[A-Z0-9]{3}$/.test(id)) break;
        const len = (tag[offset + 3] << 16) | (tag[offset + 4] << 8) | tag[offset + 5];
        offset += 6;
        if (len <= 0 || offset + len > tag.length) break;
        const body = tag.subarray(offset, offset + len);
        offset += len;
        if (id === 'PIC') best = keepPicture(best, parsePicV22(body));
      }
      return best;
    }
    while (offset + 10 <= tag.length) {
      const id = latin1(tag, offset, 4);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const len = version === 4 ? synchsafeAt(tag, offset + 4) : u32(tag, offset + 4);
      const formatFlags = tag[offset + 9];
      offset += 10;
      if (len <= 0 || offset + len > tag.length) break;
      let body = tag.subarray(offset, offset + len);
      offset += len;
      if (id !== 'APIC') continue;
      if (version === 3 && (formatFlags & 0xc0)) continue;
      if (version === 4) {
        if (formatFlags & 0x0c) continue;
        if (formatFlags & 0x01 && body.length >= 4) body = body.subarray(4);
        if (formatFlags & 0x02) body = deunsync(body);
      }
      best = keepPicture(best, parseApic(body));
    }
    return best;
  }

  function parseVorbisPicture(block) {
    if (!block || block.length < 32) return null;
    let offset = 0;
    const type = u32(block, offset);
    offset += 4;
    const mimeLen = u32(block, offset);
    offset += 4;
    if (mimeLen > 256 || offset + mimeLen + 4 > block.length) return null;
    const mime = latin1(block, offset, mimeLen).trim().toLowerCase();
    offset += mimeLen;
    const descLen = u32(block, offset);
    offset += 4;
    if (descLen > 4096 || offset + descLen + 20 > block.length) return null;
    offset += descLen + 16;
    const dataLen = u32(block, offset);
    offset += 4;
    if (dataLen < 32 || offset + dataLen > block.length) return null;
    return { mime: mime, type: type, data: block.subarray(offset, offset + dataLen) };
  }

  async function extractFlacPicture(file) {
    const marker = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (marker.length < 4 || latin1(marker, 0, 4) !== 'fLaC') return null;
    let offset = 4;
    let best = null;
    for (let n = 0; n < 24; n += 1) {
      const hdr = new Uint8Array(await file.slice(offset, offset + 4).arrayBuffer());
      if (hdr.length < 4) break;
      const last = hdr[0] & 0x80;
      const type = hdr[0] & 0x7f;
      const len = (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
      offset += 4;
      if (type === 6 && len > 32 && len <= 8 * 1024 * 1024) {
        const block = new Uint8Array(await file.slice(offset, offset + len).arrayBuffer());
        best = keepPicture(best, parseVorbisPicture(block));
      }
      offset += len;
      if (last || offset >= file.size) break;
    }
    return best;
  }

  function findCovr(bytes) {
    let best = null;
    for (let i = 4; i + 24 < bytes.length; i += 1) {
      if (bytes[i] !== 0x63 || bytes[i + 1] !== 0x6f || bytes[i + 2] !== 0x76 || bytes[i + 3] !== 0x72) continue;
      const size = u32(bytes, i - 4);
      if (size < 24 || size > 8 * 1024 * 1024 || i - 4 + size > bytes.length) continue;
      let child = i + 4;
      const end = i - 4 + size;
      while (child + 16 <= end) {
        const childSize = u32(bytes, child);
        const kind = latin1(bytes, child + 4, 4);
        if (childSize < 16 || child + childSize > end) break;
        if (kind === 'data') {
          const flags = bytes[child + 11];
          const data = bytes.subarray(child + 16, child + childSize);
          let mime = sniffMime(data);
          if (!mime && flags === 13) mime = 'image/jpeg';
          if (!mime && flags === 14) mime = 'image/png';
          best = keepPicture(best, { mime: mime, type: 3, data: data });
        }
        child += childSize;
      }
    }
    return best;
  }

  async function extractMp4Picture(file) {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (head.length < 12 || latin1(head, 4, 4) !== 'ftyp') return null;
    const chunks = [];
    const first = Math.min(file.size, 2 * 1024 * 1024);
    chunks.push(new Uint8Array(await file.slice(0, first).arrayBuffer()));
    if (file.size > first + 32) {
      const tailStart = Math.max(first, file.size - 3 * 1024 * 1024);
      chunks.push(new Uint8Array(await file.slice(tailStart, file.size).arrayBuffer()));
    }
    let best = null;
    chunks.forEach((chunk) => {
      best = keepPicture(best, findCovr(chunk));
    });
    return best;
  }

  async function extractVorbisPicture(file) {
    const slice = new Uint8Array(await file.slice(0, Math.min(file.size, 512 * 1024)).arrayBuffer());
    const text = latin1(slice, 0, slice.length);
    const key = 'METADATA_BLOCK_PICTURE=';
    const at = text.indexOf(key);
    if (at < 0) return null;
    let b64 = text.slice(at + key.length);
    const end = b64.search(/[\s\u0000]/);
    if (end >= 0) b64 = b64.slice(0, end);
    try {
      const binary = atob(b64);
      const raw = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) raw[i] = binary.charCodeAt(i) & 255;
      return keepPicture(null, parseVorbisPicture(raw));
    } catch (err) {
      return null;
    }
  }

  async function extractPicture(file) {
    if (!file || typeof file.slice !== 'function') return null;
    const id3 = await extractId3Picture(file);
    if (id3) return id3;
    const flac = await extractFlacPicture(file);
    if (flac) return flac;
    const mp4 = await extractMp4Picture(file);
    if (mp4) return mp4;
    return extractVorbisPicture(file);
  }

  function shrinkCover(bytes, mime) {
    const blob = new Blob([bytes], { type: mime || 'image/jpeg' });
    const rawUrl = URL.createObjectURL(blob);
    return new Promise((resolve) => {
      const img = new Image();
      const finish = (url) => {
        if (url !== rawUrl) URL.revokeObjectURL(rawUrl);
        resolve(url || '');
      };
      img.onload = () => {
        try {
          const max = 112;
          const longest = Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height, 1);
          const scale = Math.min(1, max / longest);
          const width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
          const height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            finish(rawUrl);
            return;
          }
          ctx.drawImage(img, 0, 0, width, height);
          finish(canvas.toDataURL('image/jpeg', 0.72));
        } catch (err) {
          finish(rawUrl);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(rawUrl);
        resolve('');
      };
      img.src = rawUrl;
    });
  }

  async function coverSource(id, file) {
    if (file) return file;
    if (sessionFiles.has(id)) return sessionFiles.get(id);
    const handle = handleCache.get(id);
    if (!handle || typeof handle.getFile !== 'function') return null;
    try {
      let perm = 'granted';
      if (handle.queryPermission) perm = await handle.queryPermission({ mode: 'read' });
      if (perm !== 'granted') return null;
      const opened = await handle.getFile();
      if (opened) sessionFiles.set(id, opened);
      return opened || null;
    } catch (err) {
      return null;
    }
  }

  function dropCover(id) {
    const url = coverUrls.get(id);
    if (url && url.indexOf('blob:') === 0) URL.revokeObjectURL(url);
    coverUrls.delete(id);
    coverMiss.delete(id);
    coverPending.delete(id);
  }

  async function ensureCover(id, file) {
    if (!id || coverUrls.has(id) || coverMiss.has(id) || coverPending.has(id)) return;
    coverPending.add(id);
    try {
      const src = await coverSource(id, file);
      if (!src) return;
      const picture = await extractPicture(src);
      if (!picture) {
        coverMiss.add(id);
        return;
      }
      const url = await shrinkCover(picture.data, picture.mime);
      if (!url) {
        coverMiss.add(id);
        return;
      }
      coverUrls.set(id, url);
      const host = document.getElementById('amfl-tracks');
      if (host) delete host.dataset.sig;
      paintTracks();
      paintPlayer();
    } catch (err) {
      coverMiss.add(id);
    } finally {
      coverPending.delete(id);
    }
  }

  async function loadWebConfig() {
    try {
      if (window.amznMusic && window.amznMusic.configPromise) {
        const cached = await window.amznMusic.configPromise;
        if (cached && !cached.redirectUrl) return cached;
      }
    } catch (err) { /* fall through */ }
    const url = new URL(location.href);
    url.pathname = '/config.json';
    url.search = '';
    url.searchParams.set('clientApplication', 'hornet');
    url.searchParams.set('skipToken', 'true');
    const res = await fetch(url.href, { method: 'POST', credentials: 'include' });
    if (!res.ok) throw new Error('Amazon Music config was not available (' + res.status + ').');
    return res.json();
  }

  async function gql(operationName, query, variables) {
    const config = await loadWebConfig();
    const headers = {
      'content-type': 'application/json',
      accept: 'application/graphql-response+json, application/json;q=0.9',
      'x-api-key': WEB_API_KEY
    };
    if (config) {
      if (config.deviceId) headers['x-amzn-device-id'] = config.deviceId;
      if (config.deviceType) headers['x-amzn-device-type'] = config.deviceType;
      if (config.sessionId) headers['x-amzn-session-id'] = config.sessionId;
      if (config.musicTerritory) headers['music-territory'] = config.musicTerritory;
      if (config.csrf) {
        if (config.csrf.rnd) headers['csrf-rnd'] = config.csrf.rnd;
        if (config.csrf.token) headers['csrf-token'] = config.csrf.token;
        if (config.csrf.ts != null) headers['csrf-ts'] = String(config.csrf.ts);
      }
    }
    const base = 'https://gql.music.amazon.' + tld();
    let lastError = null;
    for (const url of [base, base + '/graphql']) {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: headers,
        body: JSON.stringify({ operationName: operationName, query: query, variables: variables })
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (err) { json = null; }
      if (!json) {
        lastError = new Error('Playlist API did not return JSON (' + res.status + ').');
        continue;
      }
      if (json.errors && json.errors.length) {
        lastError = new Error(json.errors[0].message || 'Playlist API error');
        if (res.status === 404) continue;
        throw lastError;
      }
      if (!res.ok) {
        lastError = new Error('Playlist API HTTP ' + res.status);
        continue;
      }
      return json.data || {};
    }
    throw lastError || new Error('Playlist API failed');
  }

  const LIST_QUERY = 'query LocalFilesPlaceholderLookup($limit: Float!, $cursor: String) { user { id playlists(limit: $limit, cursor: $cursor) { pageInfo { hasNextPage token } edges { node { id title url } } } } }';
  const CREATE_MUTATION = 'mutation PlaylistModalCreatePlaylist($title: String!, $description: String, $visibility: String, $trackAsins: [String]) { createPlaylist(title: $title, description: $description, visibility: $visibility, trackAsins: $trackAsins) { id title url } }';
  // bagOfTracksGetPlaylist and addedToPlaylistTracks from dragonfly.c7d7c2a41670d3b13237.js.
  // Selections are the fragment-free fields those operations already request (plus Track.id / Track.asin).
  const PLAYLIST_TITLE_QUERY = 'query bagOfTracksGetPlaylist($id: String!) { playlist(id: $id) { id title } }';
  const PLAYLIST_TRACKS_QUERY = 'query addedToPlaylistTracks($id: String!, $cursor: String!) { playlist(id: $id) { id title tracks(limit: 100, cursor: $cursor) { edges { cursor node { id } } edgeCount pageInfo { hasNextPage token } } } }';
  const REMOVE_TRACKS_MUTATION = 'mutation removeTracks($playlistId: String!, $entryIds: [String]) { removeTracks(playlistId: $playlistId, entryIds: $entryIds) { id } }';

  async function findPlaceholderOnServer() {
    let cursor = null;
    for (let page = 0; page < 30; page += 1) {
      const data = await gql('LocalFilesPlaceholderLookup', LIST_QUERY, { limit: 50, cursor: cursor });
      const connection = data && data.user && data.user.playlists;
      const edges = (connection && connection.edges) || [];
      for (const edge of edges) {
        const node = edge && edge.node;
        if (node && node.title === PLACEHOLDER) return node;
      }
      if (!connection || !connection.pageInfo || !connection.pageInfo.hasNextPage || !connection.pageInfo.token) break;
      cursor = connection.pageInfo.token;
    }
    return null;
  }


  const UPDATE_VISIBILITY_MUTATION = 'mutation updatePlaylistProperties($id: String!, $title: String!, $visibility: String) { updatePlaylist(playlistId: $id, title: $title, visibility: $visibility) { id } }';

  async function makePlaceholderPrivate(id) {
    if (!id) return;
    try {
      const stored = await chrome.storage.local.get({ placeholderPrivateId: '' });
      if (stored.placeholderPrivateId === id) return;
      await gql('updatePlaylistProperties', UPDATE_VISIBILITY_MUTATION, {
        id: id,
        title: PLACEHOLDER,
        visibility: 'PRIVATE'
      });
      await chrome.storage.local.set({ placeholderPrivateId: id });
    } catch (err) {
      console.debug('amfl: could not set playlist private', err && err.message ? err.message : err);
    }
  }

  async function createIfMissing() {
    const existing = await findPlaceholderOnServer();
    if (existing && existing.id) {
      storedId = existing.id;
      await chrome.storage.local.set({ placeholderId: existing.id });
      await makePlaceholderPrivate(existing.id);
      return { ok: true, created: false, id: existing.id };
    }
    const data = await gql('PlaylistModalCreatePlaylist', CREATE_MUTATION, {
      title: PLACEHOLDER,
      visibility: 'PRIVATE',
      trackAsins: null
    });
    const created = data && data.createPlaylist;
    if (!created || !created.id) return { ok: false, error: 'Amazon Music did not return a playlist id.' };
    const again = await findPlaceholderOnServer();
    if (again && again.id && again.id !== created.id && again.title === PLACEHOLDER) {
      storedId = again.id;
      await chrome.storage.local.set({ placeholderId: again.id });
      await makePlaceholderPrivate(again.id);
      return { ok: true, created: false, id: again.id };
    }
    storedId = created.id;
    await chrome.storage.local.set({ placeholderId: created.id });
    showCreatedToast();
    createdThisDocument = true;
    await chrome.storage.local.set({ amflPendingLibraryRefresh: true });
    return { ok: true, created: true, id: created.id };
  }

  // Cursor shape used by useRemoveFromPlaylist: getIdentifier splits on ":" and keeps the entry id.
  function entryIdFromCursor(cursor) {
    if (typeof cursor !== 'string' || cursor.indexOf(':') === -1) return '';
    const parts = cursor.split(':');
    return parts[parts.length - 1] || '';
  }

  async function sweepAmazonTracks() {
    if (amazonTracksSweepStarted || !onLocalPage()) return;
    const id = playlistIdFromPath() || storedId;
    if (!id) {
      return;
    }
    amazonTracksSweepStarted = true;
    try {
      const meta = await gql('bagOfTracksGetPlaylist', PLAYLIST_TITLE_QUERY, { id: id });
      const listed = meta && meta.playlist;
      if (!listed || listed.title !== PLACEHOLDER || (listed.id && listed.id !== id)) {
        console.debug('amfl: skip amazon track cleanup; playlist is not LOCAL PLACEHOLDER');
        return;
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let cursor = '';
        const entryIds = [];
        let titleOk = true;
        for (let page = 0; page < 3; page += 1) {
          const data = await gql('addedToPlaylistTracks', PLAYLIST_TRACKS_QUERY, { id: id, cursor: cursor });
          const playlist = data && data.playlist;
          if (!playlist || playlist.title !== PLACEHOLDER || (playlist.id && playlist.id !== id)) {
            titleOk = false;
            break;
          }
          const connection = playlist.tracks || {};
          const edges = connection.edges || [];
          edges.forEach((edge) => {
            const entryId = entryIdFromCursor(edge && edge.cursor);
            if (entryId) entryIds.push(entryId);
          });
          const info = connection.pageInfo;
          if (!info || !info.hasNextPage || !info.token) break;
          cursor = info.token;
        }
        if (!titleOk) {
          console.debug('amfl: skip amazon track cleanup; playlist title changed');
          return;
        }
        if (!entryIds.length) {
          return;
        }
        await gql('removeTracks', REMOVE_TRACKS_MUTATION, { playlistId: id, entryIds: entryIds });
      }
    } catch (err) {
      console.debug('amfl: amazon track cleanup failed', err && err.message ? err.message : err);
    }
  }

  function playlistIdFromPath() {
    const match = location.pathname.match(/\/(?:user-)?playlists\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function exactTextNodes(root) {
    const out = [];
    if (!root) return out;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeValue && node.nodeValue.trim() === PLACEHOLDER) out.push(node);
      node = walker.nextNode();
    }
    return out;
  }

  function renameNode(node) {
    const parent = node.parentElement;
    if (!parent || parent.closest('#amfl-player, #amfl-tracks, #amfl-add')) return;
    if (node.nodeValue.trim() !== DISPLAY) node.nodeValue = node.nodeValue.replace(PLACEHOLDER, DISPLAY);
    parent.dataset.amflRenamed = '1';
    const link = parent.closest('a[href]');
    if (link) {
      const match = link.href.match(/\/(?:user-)?playlists\/([^/?#]+)/);
      if (match) {
        const seenId = decodeURIComponent(match[1]);
        // Do not replace the id createIfMissing just stored. A deleted
        // playlist card can still be in the DOM with the old id.
        if (!storedId) {
          storedId = seenId;
          chrome.storage.local.set({ placeholderId: storedId });
        }
      }
    }
    if (parent.getAttribute('aria-label') === PLACEHOLDER) parent.setAttribute('aria-label', DISPLAY);
    if (parent.getAttribute('title') === PLACEHOLDER) parent.setAttribute('title', DISPLAY);
  }

  function scrubRenames() {
    document.querySelectorAll('[data-amfl-renamed]').forEach((el) => {
      const text = (el.textContent || '').trim();
      if (text !== DISPLAY && text !== PLACEHOLDER) delete el.dataset.amflRenamed;
    });
  }

  function domHasPlaceholder() {
    if (document.querySelector('[aria-label="' + PLACEHOLDER + '"], [title="' + PLACEHOLDER + '"]')) return true;
    return !!(document.body && document.body.textContent && document.body.textContent.indexOf(PLACEHOLDER) !== -1);
  }

  function anchorVisible() {
    scrubRenames();
    if (document.querySelector('[data-amfl-renamed]')) return true;
    return domHasPlaceholder();
  }

  function headerTitleEl() {
    const nodes = document.querySelectorAll('h1, h2, [role="heading"]');
    for (const el of nodes) {
      if (el.closest('#amfl-player, #amfl-tracks')) continue;
      const text = (el.textContent || '').trim();
      if (text === PLACEHOLDER || (text === DISPLAY && el.dataset.amflRenamed === '1')) return el;
    }
    return null;
  }

  function onLocalPage() {
    const id = playlistIdFromPath();
    if (!id) return false;
    if (storedId && id === storedId) return true;
    const title = headerTitleEl();
    if (title && ((title.textContent || '').trim() === PLACEHOLDER || (title.textContent || '').trim() === DISPLAY)) {
      if (!storedId) {
        storedId = id;
        chrome.storage.local.set({ placeholderId: id });
        return true;
      }
      return id === storedId;
    }
    return false;
  }

  function engaged() {
    return player.active || onLocalPage() || anchorVisible();
  }

  function renameAnchors() {
    exactTextNodes(document.body).forEach(renameNode);
    document.querySelectorAll('[aria-label="' + PLACEHOLDER + '"], [title="' + PLACEHOLDER + '"]').forEach((el) => {
      if (el.closest('#amfl-player, #amfl-tracks')) return;
      if (el.getAttribute('aria-label') === PLACEHOLDER) el.setAttribute('aria-label', DISPLAY);
      if (el.getAttribute('title') === PLACEHOLDER) el.setAttribute('title', DISPLAY);
      el.dataset.amflRenamed = '1';
    });
    hideLocalFromAddPlaylist();
  }

  // Add-to-playlist dialog only. Never match a playlist just because its
  // visible name is "Local Files" — that string is also our rename.
  function addPlaylistTitleIsOurs(title) {
    if (!title) return false;
    if (title.getAttribute('data-amfl-renamed') === '1') return true;
    const text = (title.textContent || '').trim();
    const label = (title.getAttribute('aria-label') || '').trim();
    return text === PLACEHOLDER || label === PLACEHOLDER;
  }

  function isAddPlaylistDivider(el) {
    if (!el || el.nodeType !== 1) return false;
    const test = el.getAttribute('data-testid') || '';
    if (test.indexOf('AddToPlaylist_Item_') === 0) return false;
    if (el.querySelector('[data-testid^="AddToPlaylist_Item_"], [data-testid="PlaylistItem_Title"]')) return false;
    if (el.tagName === 'HR' || el.getAttribute('role') === 'separator') return true;
    if (/divider|separator/i.test(test)) return true;
    const rect = el.getBoundingClientRect();
    return rect.width >= 8 && rect.height > 0 && rect.height <= 1.5;
  }

  function hideAddPlaylistDivider(row) {
    const next = row.nextElementSibling;
    const prev = row.previousElementSibling;
    let laterItem = false;
    for (let el = next; el; el = el.nextElementSibling) {
      const test = el.getAttribute('data-testid') || '';
      if (test.indexOf('AddToPlaylist_Item_') === 0 && !el.classList.contains('amfl-add-playlist-hidden')) {
        laterItem = true;
        break;
      }
    }
    // The 1px rule after this row belongs to it. Dropping it avoids a double
    // line. If this row was last, the rule above it would sit at the end.
    if (isAddPlaylistDivider(next)) next.classList.add('amfl-add-playlist-hidden');
    if (!laterItem && isAddPlaylistDivider(prev)) prev.classList.add('amfl-add-playlist-hidden');
  }

  let addPlaylistHideQueued = false;

  function hideLocalFromAddPlaylist() {
    const modal = document.querySelector('[data-testid="AddToPlaylistModal"]');
    if (!modal) return;
    modal.querySelectorAll('.amfl-add-playlist-hidden').forEach((el) => {
      el.classList.remove('amfl-add-playlist-hidden');
    });
    modal.querySelectorAll('[data-testid^="AddToPlaylist_Item_"]').forEach((row) => {
      const title = row.querySelector('[data-testid="PlaylistItem_Title"]');
      if (!addPlaylistTitleIsOurs(title)) return;
      row.classList.add('amfl-add-playlist-hidden');
      hideAddPlaylistDivider(row);
    });
  }

  function scheduleHideLocalFromAddPlaylist() {
    if (addPlaylistHideQueued) return;
    addPlaylistHideQueued = true;
    requestAnimationFrame(() => {
      addPlaylistHideQueued = false;
      hideLocalFromAddPlaylist();
    });
  }

  function recordHitsAddPlaylist(record) {
    const target = record.target;
    const el = target && (target.nodeType === 1 ? target : target.parentElement);
    if (el && el.closest && el.closest('[data-testid="AddToPlaylistModal"]')) return true;
    const nodes = record.addedNodes;
    if (!nodes || !nodes.length) return false;
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (!node || node.nodeType !== 1) continue;
      if (node.getAttribute('data-testid') === 'AddToPlaylistModal') return true;
      if (node.querySelector && node.querySelector('[data-testid="AddToPlaylistModal"]')) return true;
    }
    return false;
  }

  function icon(name) {
    const paths = {
      play: '<path d="M23.46 11.05 6.39.16A1.2 1.2 0 0 0 4.8 1.2v21.6c0 .43.2.82.53 1.03.33.22.75.22 1.06.01l17.07-10.7a1.2 1.2 0 0 0 0-2.09z"/>',
      pause: '<path d="M8.4 24H4.8A1.2 1.2 0 0 1 3.6 22.8V1.2A1.2 1.2 0 0 1 4.8 0h3.6a1.2 1.2 0 0 1 1.2 1.2v21.6A1.2 1.2 0 0 1 8.4 24zm12 0h-3.6a1.2 1.2 0 0 1-1.2-1.2V1.2A1.2 1.2 0 0 1 16.8 0h3.6a1.2 1.2 0 0 1 1.2 1.2v21.6a1.2 1.2 0 0 1-1.2 1.2z"/>',
      prev: '<path d="M20.61 1.48a1.33 1.33 0 0 0-1.38.09L8 9.44V1.33A1.33 1.33 0 0 0 6.67 0H4a1.33 1.33 0 0 0-1.33 1.33v21.34A1.33 1.33 0 0 0 4 24h2.67A1.33 1.33 0 0 0 8 22.67v-8.11l11.23 7.87a1.33 1.33 0 0 0 2.1-1.09V2.67c0-.5-.28-.95-.72-1.19z"/>',
      next: '<path d="M3.39 22.52a1.33 1.33 0 0 0 1.38-.09L16 14.56v8.11A1.33 1.33 0 0 0 17.33 24H20a1.33 1.33 0 0 0 1.33-1.33V1.33A1.33 1.33 0 0 0 20 0h-2.67A1.33 1.33 0 0 0 16 1.33v8.11L4.77 1.57A1.33 1.33 0 0 0 2.67 2.67v18.66c0 .5.28.95.72 1.19z"/>',
      shuffle: '<path d="M.5 6.54c0-.6.49-1.09 1.09-1.09 3.45 0 5.84 1.9 7.98 4.12-.3.32-.59.65-.87.96-.2.23-.4.45-.6.67C6.21 9.23 4.26 7.63 1.59 7.63c-.6 0-1.09-.48-1.09-1.09zm23.27 10.46-5.46-3.82a.64.64 0 0 0-1.03.45v2.63a9.2 9.2 0 0 0-5.42-3.46 12 12 0 0 0-1.46 1.62c1.9 1.98 4.01 3.7 6.88 4.05v2.8c0 .2.11.39.3.48.16.09.36.07.51-.01l5.46-3.82a.64.64 0 0 0 0-1.12zM23.77 6.1 18.31 2.28a.64.64 0 0 0-1.03.45v2.8c-3.67.45-6.1 3.13-8.45 5.74C6.35 13.89 4.12 16.36 1.59 16.36c-.6 0-1.09.49-1.09 1.09s.49 1.09 1.09 1.09c4.3 0 6.96-2.96 9.54-5.82 2.09-2.32 4.08-4.52 6.82-4.99v2.63c0 .2.12.39.3.48.16.09.35.07.5-.02l5.46-3.82a.64.64 0 0 0 0-1.12z"/>',
      repeat: '<path d="M8.73 17.45c0 .6-.49 1.09-1.09 1.09H6.55A6.55 6.55 0 0 1 0 12a6.55 6.55 0 0 1 6.55-6.55V2.73c0-.2.11-.39.29-.48.18-.1.4-.08.57.04l5.46 3.82c.14.1.23.27.23.45s-.08.35-.23.45l-5.46 3.82a.55.55 0 0 1-.86-.45V7.63A4.36 4.36 0 0 0 2.18 12a4.36 4.36 0 0 0 4.37 4.36h1.09c.6 0 1.09.49 1.09 1.09zM24 12a6.55 6.55 0 0 0-6.55-6.55h-1.09c-.6 0-1.09.49-1.09 1.09s.49 1.09 1.09 1.09h1.09A4.36 4.36 0 0 1 21.82 12a4.36 4.36 0 0 1-4.36 4.36v-2.73c0-.2-.11-.39-.3-.48a.55.55 0 0 0-.56.04l-5.46 3.82c-.14.1-.23.27-.23.45s.08.34.23.45l5.46 3.82c.09.06.2.1.31.1.09 0 .17-.02.25-.06.18-.1.29-.28.29-.48v-2.73A6.55 6.55 0 0 0 24 12z"/>',
      volume: '<path d="M15.37.13A1.2 1.2 0 0 0 14.17.24L6.86 6H2.29C1.03 6 0 7.08 0 8.4v7.2C0 16.92 1.03 18 2.29 18h4.57l7.31 5.76c.2.16.44.24.69.24.17 0 .35-.04.51-.13.39-.2.63-.62.63-1.07V1.2c0-.45-.24-.87-.63-1.07z"/><path d="M18.15 14.7a.85.85 0 0 1 .06-1.16 4.15 4.15 0 0 0 0-4.88.85.85 0 0 1 1.22-1.18 5.85 5.85 0 0 1 0 7.24.85.85 0 0 1-1.16.1.85.85 0 0 1-.12-.12z"/><path d="M20.45 16.88a.9.9 0 0 1 .11-1.19 8.2 8.2 0 0 0 0-9.52.9.9 0 0 1 1.28-1.05 10.2 10.2 0 0 1 0 12.63.9.9 0 0 1-1.16-.1.9.9 0 0 1-.23-.77z"/>',
      'volume-low': '<path d="M15.37.13A1.2 1.2 0 0 0 14.17.24L6.86 6H2.29C1.03 6 0 7.08 0 8.4v7.2C0 16.92 1.03 18 2.29 18h4.57l7.31 5.76c.2.16.44.24.69.24.17 0 .35-.04.51-.13.39-.2.63-.62.63-1.07V1.2c0-.45-.24-.87-.63-1.07z"/><path d="M18.15 14.7a.85.85 0 0 1 .06-1.16 4.15 4.15 0 0 0 0-4.88.85.85 0 0 1 1.22-1.18 5.85 5.85 0 0 1 0 7.24.85.85 0 0 1-1.16.1.85.85 0 0 1-.12-.12z"/>',
      'volume-mute': '<path d="M15.37.13A1.2 1.2 0 0 0 14.17.24L6.86 6H2.29C1.03 6 0 7.08 0 8.4v7.2C0 16.92 1.03 18 2.29 18h4.57l7.31 5.76c.2.16.44.24.69.24.17 0 .35-.04.51-.13.39-.2.63-.62.63-1.07V1.2c0-.45-.24-.87-.63-1.07z"/><path d="M22.55 8.05 21 6.5l-2.45 2.45L16.1 6.5 14.55 8.05 17 10.5l-2.45 2.45L16.1 14.4l2.45-2.45 2.45 2.45 1.55-1.45-2.45-2.45z"/>',
      song: '<circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="1.35"/><circle cx="12" cy="12" r="5.15" fill="none" stroke="currentColor" stroke-width="1"/><circle cx="12" cy="12" r="2.35" fill="none" stroke="currentColor" stroke-width="1.15"/><circle cx="12" cy="12" r="0.85"/>',
      queue: '<path d="M24 21.6c0 .66-.54 1.2-1.2 1.2H1.2A1.2 1.2 0 0 1 0 21.6c0-.66.54-1.2 1.2-1.2h21.6c.66 0 1.2.54 1.2 1.2zM1.2 3.6h21.6c.66 0 1.2-.54 1.2-1.2S23.46 1.2 22.8 1.2H1.2A1.2 1.2 0 0 0 0 2.4c0 .66.54 1.2 1.2 1.2zm21.6 2.4H13.2A1.2 1.2 0 0 0 12 7.2c0 .66.54 1.2 1.2 1.2h9.6c.66 0 1.2-.54 1.2-1.2s-.54-1.2-1.2-1.2zm0 4.8H13.2a1.2 1.2 0 0 0 0 2.4h9.6a1.2 1.2 0 0 0 0-2.4zm0 4.8H13.2a1.2 1.2 0 0 0 0 2.4h9.6a1.2 1.2 0 0 0 0-2.4zM.31 17.93A.6.6 0 0 1 0 17.4V6.6c0-.22.12-.42.31-.53.19-.1.43-.1.61.02l8.4 5.4c.17.11.28.3.28.51s-.11.4-.28.5l-8.4 5.41a.6.6 0 0 1-.61.02z"/>',
      trash: '<path d="M9 3.5h6l.7 1.8H20v1.7H4V5.3h4.3L9 3.5zM7.2 9h1.7v9H7.2V9zm3.9 0h1.7v9h-1.7V9zm3.9 0H17v9h-1.9V9z"/>',
      edit: '<path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>'
    };
    return '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="currentColor">' + (paths[name] || '') + '</svg>';
  }

  function ensurePlayer() {
    let root = document.getElementById('amfl-player');
    if (root && root.dataset.amflBuild !== '7') {
      if (audio.parentElement) audio.parentElement.removeChild(audio);
      root.remove();
      root = null;
    }
    if (root) return root;
    root = document.createElement('div');
    root.id = 'amfl-player';
    root.className = 'amfl-player';
    root.dataset.amflBuild = '7';
    root.hidden = true;
    root.innerHTML = [
      '<div class="amfl-progress" data-layout="progress-row">',
      '<div class="amfl-progress-track"><div class="amfl-progress-played"></div></div>',
      '<input type="range" min="0" max="1000" value="0" aria-label="Playback progress" />',
      '</div>',
      '<div class="amfl-content" data-layout="content-row">',
      '<div class="amfl-left">',
      '<div class="amfl-art" aria-hidden="true"></div>',
      '<div class="amfl-meta"><div class="amfl-now-title"></div><div class="amfl-now-artist"></div></div>',
      '</div>',
      '<div class="amfl-transport" data-layout="transport">',
      '<button type="button" data-act="repeat" aria-label="Repeat"></button>',
      '<button type="button" data-act="prev" aria-label="Previous"></button>',
      '<button type="button" data-act="play" class="amfl-play" aria-label="Play"></button>',
      '<button type="button" data-act="next" aria-label="Next"></button>',
      '<button type="button" data-act="shuffle" aria-label="Shuffle"></button>',
      '</div>',
      '<div class="amfl-side">',
      '<div class="amfl-volume">',
      '<div class="amfl-volume-pop" hidden>',
      '<input type="range" class="amfl-volume-slider" min="0" max="100" value="100" step="1" aria-label="Volume" />',
      '</div>',
      '<button type="button" data-act="volume" aria-label="Volume" aria-pressed="false" aria-expanded="false"></button>',
      '</div>',
      '<button type="button" data-act="queueview" aria-label="View Queue" aria-pressed="false"></button>',
      '</div></div>',
      '<div class="amfl-queue" hidden>',
      '<div class="amfl-queue-header">',
      '<div class="amfl-queue-title">Queue</div>',
      '<button type="button" class="amfl-queue-clear" data-act="queueclear" aria-label="Clear queue">Clear queue</button>',
      '</div>',
      '<div class="amfl-queue-list"></div>',
      '</div>'
    ].join('');
    root.querySelector('.amfl-art').innerHTML = icon('song');
    root.querySelector('[data-act="repeat"]').innerHTML = icon('repeat');
    root.querySelector('[data-act="prev"]').innerHTML = icon('prev');
    root.querySelector('[data-act="play"]').innerHTML = icon('play');
    root.querySelector('[data-act="play"]').dataset.icon = 'play';
    root.querySelector('[data-act="next"]').innerHTML = icon('next');
    root.querySelector('[data-act="shuffle"]').innerHTML = icon('shuffle');
    root.querySelector('[data-act="queueview"]').innerHTML = icon('queue');
    root.querySelector('[data-act="volume"]').innerHTML = icon('volume');
    const volumeSlider = root.querySelector('.amfl-volume-slider');
    volumeSlider.addEventListener('pointerdown', (event) => {
      volumeDragging = true;
      event.stopPropagation();
    });
    volumeSlider.addEventListener('input', () => {
      const level = Number(volumeSlider.value) / 100;
      if (level > 0) volumeHold = level;
      writeAmazonVolume(level, level === 0);
    });
    volumeSlider.addEventListener('change', () => { volumeDragging = false; paintVolumeControl(); });
    root.appendChild(audio);
    root.addEventListener('pointerdown', onPlayerPointerDown);
    const range = root.querySelector('.amfl-progress input[type="range"]');
    range.addEventListener('pointerdown', (event) => {
      player.dragging = true;
      event.stopPropagation();
    });
    range.addEventListener('input', () => {
      if (!audio.duration || !isFinite(audio.duration)) return;
      audio.currentTime = (Number(range.value) / 1000) * audio.duration;
      const played = root.querySelector('.amfl-progress-played');
      if (played) played.style.width = (Number(range.value) / 10) + '%';
    });
    range.addEventListener('change', () => { player.dragging = false; });
    document.documentElement.appendChild(root);
    applyBarInset();
    return root;
  }

  function fmt(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const whole = Math.floor(seconds);
    const m = Math.floor(whole / 60);
    const s = whole % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function queueEntry(id) {
    const entry = { id: id, key: queueKeySeq };
    queueKeySeq += 1;
    return entry;
  }

  function playingEntry() {
    const item = player.queue[player.index];
    return item || null;
  }

  function playingId() {
    const item = playingEntry();
    return item ? item.id : '';
  }

  function currentMeta() {
    const id = playingId();
    return files.find((file) => file.id === id) || null;
  }

  function setBtnIcon(btn, name) {
    if (!btn) return;
    if (btn.dataset.icon === name && btn.querySelector('svg')) return;
    btn.dataset.icon = name;
    btn.innerHTML = icon(name);
  }

  function fillArtistOnly(container, artistName) {
    if (!container) return;
    const name = artistName ? String(artistName).trim() : '';
    const sig = 'artist:' + name;
    if (container.dataset.amflCredit === sig && !container.querySelector('[data-amfl-open-local]')) return;
    container.dataset.amflCredit = sig;
    container.replaceChildren();
    if (!name) return;
    const artist = document.createElement('span');
    artist.className = 'amfl-credit-artist';
    artist.textContent = name;
    container.appendChild(artist);
  }

  function fillLocalCredit(container, artistName) {
    if (!container) return;
    const name = artistName ? String(artistName).trim() : '';
    const sig = name + '\nLocal';
    if (container.dataset.amflCredit === sig && container.querySelector('[data-amfl-open-local]')) return;
    container.dataset.amflCredit = sig;
    container.replaceChildren();
    if (name) {
      const artist = document.createElement('span');
      artist.className = 'amfl-credit-artist';
      artist.textContent = name;
      const sep = document.createElement('span');
      sep.className = 'amfl-credit-sep';
      sep.textContent = ' - ';
      container.append(artist, sep);
    }
    const local = document.createElement('span');
    local.className = 'amfl-local-label';
    local.dataset.amflOpenLocal = '1';
    local.setAttribute('role', 'link');
    local.tabIndex = 0;
    local.textContent = 'Local';
    local.setAttribute('aria-label', 'Open Local Files');
    container.appendChild(local);
  }

  function localPlaylistHref(id, url) {
    if (id) {
      const link = document.querySelector('a[href*="' + id + '"]');
      if (link && /playlist/i.test(link.href || '')) return link.href;
    }
    if (url && typeof url === 'string') {
      if (/^https?:\/\//i.test(url)) return url;
      if (url.charAt(0) === '/') return location.origin + url;
    }
    if (id) return location.origin + '/playlists/' + encodeURIComponent(id);
    return '';
  }

  function playlistTargetPath(id, url) {
    const href = localPlaylistHref(id, url || '');
    if (!href) return '';
    try {
      const parsed = new URL(href, location.origin);
      if (parsed.origin !== location.origin) return '';
      return parsed.pathname + parsed.search + parsed.hash;
    } catch (err) {
      return '';
    }
  }

  function alreadyOnPlaylist(path) {
    if (onLocalPage()) return true;
    if (!path) return false;
    try {
      const parsed = new URL(path, location.origin);
      const match = parsed.pathname.match(/\/(?:user-)?playlists\/([^/?#]+)/);
      const id = match ? decodeURIComponent(match[1]) : '';
      const current = playlistIdFromPath();
      if (id && current && id === current) return true;
      return parsed.pathname === location.pathname && parsed.search === location.search;
    } catch (err) {
      return false;
    }
  }

  function findLocalPlaylistLink(id) {
    const want = id || storedId;
    if (!want) return null;
    let hidden = null;
    const anchors = document.querySelectorAll('a[href]');
    for (let i = 0; i < anchors.length; i += 1) {
      const anchor = anchors[i];
      if (anchor.closest('#amfl-player, #amfl-tracks, #amfl-add, #amfl-search')) continue;
      const href = anchor.getAttribute('href') || '';
      const abs = anchor.href || '';
      if (!/playlist/i.test(href) && !/playlist/i.test(abs)) continue;
      if (href.indexOf(want) === -1 && abs.indexOf(want) === -1) continue;
      const rect = anchor.getBoundingClientRect();
      if (rect.width > 2 && rect.height > 2) return anchor;
      if (!hidden) hidden = anchor;
    }
    return hidden;
  }

  // Click the real playlist anchor so Amazon's router runs. preventDefault only
  // after that, and only if the router did not, so the browser never full-loads.
  function routeViaPlaylistLink(link) {
    if (!link) return false;
    let wePrevented = false;
    const stopper = (event) => {
      const target = event.target;
      if (target !== link && !(target && link.contains && link.contains(target))) return;
      if (event.defaultPrevented) return;
      event.preventDefault();
      wePrevented = true;
    };
    window.addEventListener('click', stopper, false);
    const click = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0
    });
    link.dispatchEvent(click);
    window.removeEventListener('click', stopper, false);
    return click.defaultPrevented && !wePrevented;
  }

  function pushPlaylistPath(path) {
    if (!path || alreadyOnPlaylist(path)) return;
    history.pushState(history.state, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }

  function openLocalPlaylist(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    }
    if (onLocalPage()) return;
    // Live id: memory updated by createIfMissing, and chrome.storage placeholderId.
    const id = storedId || '';
    const path = playlistTargetPath(id, '');
    if (alreadyOnPlaylist(path)) return;
    const link = findLocalPlaylistLink(id);
    if (link && routeViaPlaylistLink(link)) return;
    if (path) {
      pushPlaylistPath(path);
      return;
    }
    findPlaceholderOnServer().then((node) => {
      if (!node || !node.id) return;
      storedId = node.id;
      chrome.storage.local.set({ placeholderId: node.id });
      if (onLocalPage()) return;
      const nextPath = playlistTargetPath(node.id, node.url || '');
      if (alreadyOnPlaylist(nextPath)) return;
      const nextLink = findLocalPlaylistLink(node.id);
      if (nextLink && routeViaPlaylistLink(nextLink)) return;
      pushPlaylistPath(nextPath);
    }).catch(() => {});
  }

  function paintPlayer() {
    const root = document.getElementById('amfl-player');
    if (!root) return;
    const meta = currentMeta();
    const title = root.querySelector('.amfl-now-title');
    const artist = root.querySelector('.amfl-now-artist');
    if (title) title.textContent = meta ? (meta.title || meta.filename) : '';
    if (artist) {
      const name = meta && meta.artist ? String(meta.artist).trim() : '';
      fillLocalCredit(artist, name);
    }
    paintNowArt(root);
    const playBtn = root.querySelector('[data-act="play"]');
    const paused = audio.paused || !player.active;
    setBtnIcon(playBtn, paused ? 'play' : 'pause');
    if (playBtn) playBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    const shuffleBtn = root.querySelector('[data-act="shuffle"]');
    if (shuffleBtn) shuffleBtn.classList.toggle('is-on', player.shuffle);
    const repeatBtn = root.querySelector('[data-act="repeat"]');
    if (repeatBtn) {
      const mode = player.repeat || 'off';
      repeatBtn.classList.toggle('is-on', mode !== 'off');
      repeatBtn.classList.toggle('is-one', mode === 'one');
      repeatBtn.setAttribute('aria-pressed', mode === 'off' ? 'false' : 'true');
      repeatBtn.setAttribute('aria-label', mode === 'one' ? 'Repeat one' : (mode === 'all' ? 'Repeat all' : 'Repeat'));
    }
    const queueBtn = root.querySelector('[data-act="queueview"]');
    if (queueBtn) {
      queueBtn.classList.toggle('is-on', !!player.queueOpen);
      queueBtn.setAttribute('aria-pressed', player.queueOpen ? 'true' : 'false');
    }
    paintQueue();
    let frac = 0;
    if (audio.duration && isFinite(audio.duration) && audio.duration > 0) {
      frac = Math.min(1, Math.max(0, audio.currentTime / audio.duration));
    }
    const played = root.querySelector('.amfl-progress-played');
    if (played && !player.dragging) played.style.width = (frac * 100) + '%';
    if (!player.dragging) {
      const range = root.querySelector('.amfl-progress input[type="range"]');
      if (range) range.value = String(Math.round(frac * 1000));
    }
    paintVolumeControl();
    paintTrackOverlays();
  }

  function paintNowArt(root) {
    const art = root.querySelector('.amfl-art');
    if (!art) return;
    const id = playingId();
    const cover = id ? coverUrls.get(id) : '';
    if (cover) {
      let img = art.querySelector('img');
      if (!img) {
        art.replaceChildren();
        img = document.createElement('img');
        img.alt = '';
        art.appendChild(img);
      }
      if (img.getAttribute('src') !== cover) img.src = cover;
      return;
    }
    if (!art.querySelector('svg') || art.querySelector('img')) art.innerHTML = icon('song');
    if (id && !coverMiss.has(id)) ensureCover(id);
  }

  function showPlayer(on) {
    const root = ensurePlayer();
    root.hidden = !on;
    if (!on) restoreBar();
    else alignPlayerBar();
    blockAmazonBarQueue(!!on);
  }

  function revealHiddenChain(el) {
    const changed = [];
    let node = el;
    while (node && node !== document.documentElement) {
      if (node.style && node.style.getPropertyValue('display') === 'none') {
        changed.push(node);
        node.style.removeProperty('display');
      }
      node = node.parentElement;
    }
    return changed;
  }

  function rehideChain(nodes) {
    nodes.forEach((node) => {
      if (node && node.style) node.style.setProperty('display', 'none', 'important');
    });
  }

  function bottomStripRect(rect) {
    if (!rect || rect.width < 160 || rect.height < 48 || rect.height > 150) return false;
    if (rect.bottom < window.innerHeight - 6) return false;
    if (rect.top < window.innerHeight - 200) return false;
    return true;
  }

  // Amazon's bottom bar only. Not the window, not a parent that also holds
  // the queue or lyrics column (those are taller than the bar), and not an
  // inner control cluster (narrower than the bar). Width is the element's
  // own layout box, never window.innerWidth.
  function findBar() {
    const seeds = [];
    document.querySelectorAll('[data-testid*="MiniPlayer_"], [data-testid*="NowPlaying_"]').forEach((el) => {
      if (!el || (el.closest && el.closest('#amfl-player'))) return;
      seeds.push(el);
    });
    if (barHide && barHide.el && barHide.el.isConnected && barHide.el.id !== 'amfl-player') seeds.push(barHide.el);
    let best = null;
    let bestWidth = 0;
    seeds.forEach((seed) => {
      const revealed = revealHiddenChain(seed);
      let node = seed;
      for (let i = 0; node && node !== document.body && i < 10; i += 1) {
        if (node.id === 'amfl-player') break;
        if (!nodeHoldsOpenQueue(node)) {
          const rect = node.getBoundingClientRect();
          if (bottomStripRect(rect) && rect.width > bestWidth + 1) {
            best = node;
            bestWidth = rect.width;
          }
        }
        node = node.parentElement;
      }
      rehideChain(revealed);
    });
    return best;
  }

  function nodeHoldsOpenQueue(node) {
    if (!node || !node.querySelectorAll) return false;
    return [...node.querySelectorAll('[data-testid*="Queue"], [data-testid*="queue"], [role="dialog"]')].some((el) => {
      if (el.closest && el.closest('#amfl-player')) return false;
      const test = el.getAttribute('data-testid') || '';
      if (/Toolbar_|IconButton|Add_To_Queue/i.test(test)) return false;
      const box = el.getBoundingClientRect();
      return box.width > 240 && box.height > 180;
    });
  }

  let volumeMarks = [];
  let volumeObserver = null;
  const hookedMedia = new WeakSet();
  let volumeOpen = false;
  let volumeHold = 1;
  let volumeDragging = false;
  let writingVolume = false;
  let barContentInset = { left: 24, right: 24 };
  // Last artwork-left and queue-button-left that were actually on screen.
  // A hidden Amazon bar must not replace these with window or row guesses.
  let lastControlAnchors = null;

  function acrossParent(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode && node.getRootNode();
    if (root && root.host) return root.host;
    return null;
  }

  function collectDeep(selector, scope, out, depth, maxDepth) {
    const cap = maxDepth || 8;
    if (!scope || !scope.querySelectorAll || depth > cap) return;
    scope.querySelectorAll(selector).forEach((el) => out.push(el));
    scope.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) collectDeep(selector, el.shadowRoot, out, depth + 1, cap);
    });
  }

  function volumeText(el) {
    if (!el || !el.getAttribute) return '';
    return [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-testid'),
      el.getAttribute('data-icon'),
      el.getAttribute('icon-name'),
      el.id,
      typeof el.className === 'string' ? el.className : ''
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').toLowerCase();
  }

  function isVolumeNamed(el) {
    if (!el || !el.getAttribute) return false;
    if (el.closest && el.closest('#amfl-player, #amfl-tracks, #amfl-add')) return false;
    let text = volumeText(el);
    if (!el.getAttribute('aria-label') && el.querySelector) {
      const inner = el.querySelector('[aria-label*="olume" i], [aria-label*="ute" i], [title*="olume" i], [title*="ute" i]');
      if (inner) text += ' ' + volumeText(inner);
    }
    if (/queue|seek|scrub|progress|playback time|shuffle|repeat|\bskip\b|\bnext\b|previous|\bplay\b|\bpause\b|lyrics|\bcast\b|\bdevice\b|connect/.test(text) && !/volume|mute/.test(text)) return false;
    return /volume|mute/.test(text);
  }

  function inPlayerStrip(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    return rect.bottom >= window.innerHeight - 280 && rect.top >= window.innerHeight - 460;
  }

  function insideNode(root, node) {
    let current = node;
    while (current) {
      if (current === root) return true;
      if (current.parentElement) current = current.parentElement;
      else if (current.getRootNode && current.getRootNode().host) current = current.getRootNode().host;
      else current = null;
    }
    return false;
  }

  function findVolumeRoot(scope) {
    const nodes = [];
    const deep = !!(scope && scope !== document);
    if (deep) collectDeep('button, [role="button"], [role="slider"], input[type="range"]', scope, nodes, 0);
    else document.querySelectorAll('button, [role="button"], [role="slider"], input[type="range"]').forEach((el) => nodes.push(el));
    const candidates = [];
    nodes.forEach((el) => {
      if (!isVolumeNamed(el)) return;
      if (!deep && !inPlayerStrip(el)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      candidates.push(el);
    });
    if (!candidates.length) return null;
    const button = candidates.find((el) => el.matches && el.matches('button, [role="button"]'));
    let node = button || candidates[0];
    let parent = acrossParent(node);
    while (parent && parent !== document.body && parent !== document.documentElement) {
      if (parent.id === 'amfl-player') break;
      if (deep && scope.contains && !scope.contains(parent) && parent !== scope) break;
      const rect = parent.getBoundingClientRect();
      if (rect.width > 260 || rect.height > 380) break;
      const controls = [];
      collectDeep('button, [role="button"], a, input[type="range"], [role="slider"]', parent, controls, 0);
      let foreign = false;
      for (const el of controls) {
        if (candidates.indexOf(el) !== -1 || isVolumeNamed(el)) continue;
        const box = el.getBoundingClientRect();
        if (box.width < 2 || box.height < 2) continue;
        const narrowSlider = el.matches && el.matches('[role="slider"], input[type="range"]') && box.width <= 180 && box.height <= 220;
        if (narrowSlider) continue;
        foreign = true;
        break;
      }
      if (foreign) break;
      node = parent;
      parent = acrossParent(node);
    }
    while (node && node.getRootNode && node.getRootNode() instanceof ShadowRoot) node = node.getRootNode().host;
    if (!node || node === document.body || node === document.documentElement || node.id === 'amfl-player') return null;
    if (deep && node === scope) return null;
    return node;
  }

  function readSliderValue(el) {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width > 220 && rect.width > rect.height * 3) return null;
    let raw = null;
    const nowAttr = el.getAttribute('aria-valuenow');
    if (nowAttr != null && nowAttr !== '') raw = Number(nowAttr);
    else if (el.matches && el.matches('input') && el.value !== '') raw = Number(el.value);
    else if (el.getAttribute('aria-valuetext')) {
      const match = String(el.getAttribute('aria-valuetext')).match(/(\d+(?:\.\d+)?)/);
      if (match) raw = Number(match[1]);
    }
    if (!Number.isFinite(raw)) return null;
    let min = Number(el.getAttribute('aria-valuemin'));
    if (!Number.isFinite(min)) min = Number(el.min);
    if (!Number.isFinite(min)) min = 0;
    let max = Number(el.getAttribute('aria-valuemax'));
    if (!Number.isFinite(max)) max = Number(el.max);
    if (!Number.isFinite(max) || max === min) max = raw <= 1 ? 1 : 100;
    if (max === min) return null;
    return Math.min(1, Math.max(0, (raw - min) / (max - min)));
  }

  function sliderLevel(scope) {
    if (!scope || !scope.querySelectorAll) return null;
    const nodes = [];
    if (scope.matches && scope.matches('[role="slider"], input[type="range"]')) nodes.push(scope);
    if (scope === document) document.querySelectorAll('[role="slider"], input[type="range"]').forEach((el) => nodes.push(el));
    else collectDeep('[role="slider"], input[type="range"]', scope, nodes, 0);
    for (const el of nodes) {
      if (el.closest && el.closest('#amfl-player')) continue;
      if (scope === document && (!isVolumeNamed(el) || !inPlayerStrip(el))) continue;
      const level = readSliderValue(el);
      if (level != null) return level;
    }
    return null;
  }

  function muteFromButtons(scope) {
    if (!scope || !scope.querySelectorAll) return null;
    const buttons = [];
    if (scope.matches && scope.matches('button, [role="button"]')) buttons.push(scope);
    if (scope === document) document.querySelectorAll('button, [role="button"]').forEach((el) => buttons.push(el));
    else collectDeep('button, [role="button"]', scope, buttons, 0);
    let seen = false;
    for (const btn of buttons) {
      if (scope === document && !inPlayerStrip(btn)) continue;
      if (!isVolumeNamed(btn)) continue;
      const label = ((btn.getAttribute('aria-label') || '') + ' ' + (btn.getAttribute('title') || '')).toLowerCase();
      seen = true;
      if (/\bunmute\b|\bmuted\b/.test(label)) return true;
      if (btn.getAttribute('aria-pressed') === 'true' && /\bmute\b/.test(label)) return true;
    }
    return seen ? false : null;
  }

  function eachAmazonMedia(fn) {
    document.querySelectorAll('audio, video').forEach(fn);
    if (barHide && barHide.el) {
      const extra = [];
      collectDeep('audio, video', barHide.el, extra, 0);
      extra.forEach(fn);
    }
  }

  function hookAmazonMedia() {
    eachAmazonMedia((media) => {
      if (media === audio || hookedMedia.has(media)) return;
      if (media.closest && media.closest('#amfl-player')) return;
      hookedMedia.add(media);
      media.addEventListener('volumechange', applyAmazonVolume);
    });
  }

  function amazonMediaLevel() {
    let picked = null;
    eachAmazonMedia((media) => {
      if (media === audio || (media.closest && media.closest('#amfl-player'))) return;
      if (typeof media.volume !== 'number' || !Number.isFinite(media.volume)) return;
      const inBar = !!(barHide && barHide.el && barHide.el.contains && barHide.el.contains(media));
      const main = inBar || !!(media.currentSrc || media.getAttribute('src'));
      if (!main && picked) return;
      picked = { level: media.volume, muted: !!media.muted, main: main };
    });
    return picked;
  }

  function readAmazonVolumeState() {
    hookAmazonMedia();
    const media = amazonMediaLevel();
    const bar = barHide && barHide.el;
    let level = media ? media.level : null;
    let muted = media ? !!media.muted : null;
    if (level == null && bar) level = sliderLevel(bar);
    if (level == null) level = sliderLevel(document);
    if (muted == null) {
      const fromButton = bar ? muteFromButtons(bar) : muteFromButtons(document);
      muted = fromButton === true;
    }
    if (level == null) return null;
    return { level: Math.min(1, Math.max(0, level)), muted: !!muted };
  }

  function applyAmazonVolume() {
    if (writingVolume) return;
    const overlay = document.getElementById('amfl-player');
    if (!player.active || !overlay || overlay.hidden) return;
    const state = readAmazonVolumeState();
    if (!state) return;
    if (Math.abs(audio.volume - state.level) > 0.001) audio.volume = state.level;
    if (audio.muted !== state.muted) audio.muted = state.muted;
    if (!state.muted && state.level > 0) volumeHold = state.level;
    paintVolumeControl();
  }

  function writeControlValue(el, level) {
    const frac = Math.min(1, Math.max(0, Number(level) || 0));
    let min = Number(el.getAttribute('aria-valuemin'));
    if (!Number.isFinite(min)) min = Number(el.min);
    if (!Number.isFinite(min)) min = 0;
    let max = Number(el.getAttribute('aria-valuemax'));
    if (!Number.isFinite(max)) max = Number(el.max);
    const nowRaw = Number(el.getAttribute('aria-valuenow'));
    const valueRaw = (el.matches && el.matches('input')) ? Number(el.value) : nowRaw;
    if (!Number.isFinite(max) || max === min) {
      max = (Number.isFinite(valueRaw) && valueRaw > 1) ? 100 : 1;
    }
    const raw = min + (frac * (max - min));
    const text = String(max > 1 ? Math.round(raw) : raw);
    if (el.matches && el.matches('input')) {
      const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      const previous = el.value;
      if (proto && proto.set) proto.set.call(el, text);
      else el.value = text;
      // React ignores input unless its value tracker still holds the old value.
      const tracker = el._valueTracker;
      if (tracker && typeof tracker.setValue === 'function') tracker.setValue(String(previous));
    } else if ('value' in el) {
      try { el.value = text; } catch (err) { /* custom slider */ }
    }
    el.setAttribute('aria-valuenow', text);
    if (max > 1) el.setAttribute('aria-valuetext', Math.round(frac * 100) + '%');
    else el.setAttribute('aria-valuetext', text);
    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    } catch (err) {
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function amazonVolumeSlider(el) {
    if (!el || !el.getAttribute) return false;
    if (el.closest && el.closest('#amfl-player, #amfl-tracks, #amfl-add')) return false;
    const role = (el.getAttribute('role') || '').toLowerCase();
    const isSlider = role === 'slider' || (el.matches && el.matches('input[type="range"]'));
    if (!isSlider) return false;
    if (looksLikeSeek(el)) return false;
    if (isVolumeNamed(el) || /volume/i.test(el.getAttribute('data-testid') || '')) return true;
    let parent = el.parentElement || (el.getRootNode && el.getRootNode().host);
    for (let i = 0; parent && i < 8; i += 1) {
      if (parent.id === 'amfl-player') return false;
      const test = (parent.getAttribute && parent.getAttribute('data-testid')) || '';
      const label = ((parent.getAttribute && parent.getAttribute('aria-label')) || '') + ' ' + ((parent.getAttribute && parent.getAttribute('title')) || '');
      if (/volume/i.test(test) || /volume|mute/i.test(label)) return true;
      if (parent.parentElement) parent = parent.parentElement;
      else if (parent.getRootNode && parent.getRootNode().host) parent = parent.getRootNode().host;
      else parent = null;
    }
    if (barHide && barHide.el && insideNode(barHide.el, el)) return true;
    return false;
  }

  function writeAmazonVolume(level, muted) {
    const next = Math.min(1, Math.max(0, Number(level) || 0));
    const mute = !!muted || next === 0;
    writingVolume = true;
    try {
      const sliders = [];
      collectDeep('[role="slider"], input[type="range"]', document.documentElement, sliders, 0, 16);
      sliders.forEach((el) => {
        if (!amazonVolumeSlider(el)) return;
        writeControlValue(el, next);
      });
      eachAmazonMedia((media) => {
        if (media === audio || (media.closest && media.closest('#amfl-player'))) return;
        try {
          if (Math.abs(media.volume - next) > 0.001) media.volume = next;
          if (media.muted !== mute) media.muted = mute;
        } catch (err) { /* ignore */ }
      });
      audio.volume = next;
      audio.muted = mute;
      if (!mute && next > 0) volumeHold = next;
    } finally {
      writingVolume = false;
    }
    paintVolumeControl();
  }

  function paintVolumeControl() {
    const root = document.getElementById('amfl-player');
    if (!root) return;
    const btn = root.querySelector('[data-act="volume"]');
    const pop = root.querySelector('.amfl-volume-pop');
    const slider = root.querySelector('.amfl-volume-slider');
    if (!btn || !pop || !slider) return;
    const level = Number.isFinite(audio.volume) ? audio.volume : volumeHold;
    // Always the two-wave speaker. The button only shows the slider; it does not mute.
    setBtnIcon(btn, 'volume');
    btn.setAttribute('aria-label', 'Volume');
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-expanded', volumeOpen ? 'true' : 'false');
    if (!volumeDragging) slider.value = String(Math.round(Math.min(1, Math.max(0, level)) * 100));
    pop.hidden = !volumeOpen;
  }

  function toggleOurVolume() {
    // pointerdown and the click that follows both used to toggle, so a normal
    // click opened the slider and the release closed it. One toggle per press.
    const now = Date.now();
    if (now - volumeToggleAt < 400) return;
    volumeToggleAt = now;
    volumeOpen = !volumeOpen;
    paintVolumeControl();
  }

  function watchVolumeRoot(root) {
    if (!root) return;
    if (!volumeObserver) volumeObserver = new MutationObserver(() => applyAmazonVolume());
    const opts = {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-valuenow', 'aria-valuetext', 'aria-valuemin', 'aria-valuemax', 'aria-label', 'aria-pressed', 'value']
    };
    volumeObserver.observe(root, opts);
    if (root.shadowRoot) volumeObserver.observe(root.shadowRoot, opts);
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) volumeObserver.observe(el.shadowRoot, opts);
    });
  }

  function clearBarStack() {
    document.querySelectorAll('[data-amfl-stack-saved]').forEach((el) => {
      el.style.removeProperty('z-index');
      el.style.removeProperty('position');
      if (el.dataset.amflStackZ) el.style.zIndex = el.dataset.amflStackZ;
      if (el.dataset.amflStackPos) el.style.position = el.dataset.amflStackPos;
      delete el.dataset.amflStackSaved;
      delete el.dataset.amflStackZ;
      delete el.dataset.amflStackPos;
    });
  }

  function clearPinnedVolume() {
    document.querySelectorAll('[data-amfl-volume-live], [data-amfl-volume-slider], [data-amfl-volume-pin], [data-amfl-bar-piece]').forEach((el) => {
      ['visibility', 'pointer-events', 'display', 'opacity', 'position', 'left', 'top', 'width', 'height', 'max-height', 'min-width', 'min-height', 'z-index', 'margin', 'overflow'].forEach((prop) => {
        el.style.removeProperty(prop);
      });
      delete el.dataset.amflVolumeLive;
      delete el.dataset.amflVolumeSlider;
      delete el.dataset.amflVolumePin;
      delete el.dataset.amflBarPiece;
    });
    const overlay = document.getElementById('amfl-player');
    if (overlay) {
      overlay.classList.remove('amfl-pass-volume');
      overlay.style.removeProperty('background-image');
    }
  }

  function looksLikeSeek(el) {
    if (!el || !el.getAttribute) return false;
    const text = volumeText(el);
    if (/volume|mute/.test(text)) return false;
    if (/seek|scrub|progress|playback|duration|timeline|\btime\b/.test(text)) return true;
    const rect = el.getBoundingClientRect();
    return rect.width > 220 && rect.width > rect.height * 3;
  }

  function applyBarInset() {
    const root = document.getElementById('amfl-player');
    if (!root) return;
    root.style.setProperty('--amfl-bar-left', barContentInset.left + 'px');
    root.style.setProperty('--amfl-bar-right', barContentInset.right + 'px');
  }

  function addSongsBoxRect() {
    const add = document.querySelector('[data-amfl-wire="add"]') || document.getElementById('amfl-add');
    if (!add || !add.isConnected) return null;
    let box = add;
    let node = add;
    const host = document.getElementById('amfl-tracks');
    const hostRect = host ? host.getBoundingClientRect() : null;
    for (let i = 0; node && i < 6; i += 1) {
      const rect = node.getBoundingClientRect();
      if (rect.width >= 160 && rect.height >= 24 && rect.height <= 140) box = node;
      if (hostRect && rect.width > hostRect.width + 140) break;
      node = node.parentElement;
    }
    const rect = box.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 8) return null;
    return rect;
  }

  // Do not size #amfl-player from the window, the song-row highlight, or
  // Amazon's full-width bar. Those three disagree across monitors.
  // Repeat, previous, play, next, and shuffle stay in the centered
  // .amfl-transport cluster (normal flex flow, not equal gaps). Shift
  // .amfl-left and .amfl-side by the same delta: Amazon now-playing art
  // left minus our cover left. If the bar is hidden or missing, keep the
  // last measured art anchor.
  // Artwork: img / [role=img] / Imagery* inside the mini-player cluster.
  // MiniPlayer_ and NowPlaying_ are the bar seeds already used here.
  // MiniPlayer_Title is the live mini-player title (comma testids, e.g.
  // IconButton,MiniPlayer_Pause). Queue control is isAmazonBarQueueControl
  // (aria-label / data-testid already used for that button). No new test ids.
  function unhideForAnchorMeasure(seeds) {
    const saved = [];
    const seen = new Set();
    seeds.forEach((start) => {
      let node = start;
      while (node && node !== document.documentElement) {
        if (!seen.has(node)) {
          seen.add(node);
          const attr = !!(node.hasAttribute && node.hasAttribute('data-amfl-bar-hidden'));
          const display = node.style ? node.style.getPropertyValue('display') : '';
          const priority = node.style ? node.style.getPropertyPriority('display') : '';
          if (attr || display === 'none') {
            saved.push({ node: node, attr: attr, display: display, priority: priority });
            if (attr) node.removeAttribute('data-amfl-bar-hidden');
            if (display === 'none' && node.style) node.style.removeProperty('display');
          }
        }
        node = node.parentElement;
      }
    });
    return saved;
  }

  function restoreAnchorMeasure(saved) {
    for (let i = saved.length - 1; i >= 0; i -= 1) {
      const item = saved[i];
      if (!item.node) continue;
      if (item.attr && item.node.setAttribute) item.node.setAttribute('data-amfl-bar-hidden', '1');
      if (item.display === 'none' && item.node.style) {
        item.node.style.setProperty('display', 'none', item.priority || 'important');
      }
    }
  }

  function isMiniPlayerMark(node) {
    if (!node || !node.getAttribute) return false;
    const test = node.getAttribute('data-testid') || '';
    if (test.indexOf('MiniPlayer_') !== -1 || test.indexOf('NowPlaying_') !== -1) return true;
    return node.matches && node.matches('a[data-testid="MiniPlayer_Title"]');
  }

  function inMiniPlayerCluster(el) {
    let node = el;
    for (let i = 0; node && node !== document.body && i < 8; i += 1) {
      if (isMiniPlayerMark(node)) return true;
      const rect = node.getBoundingClientRect();
      if (rect.height > 220) break;
      if (node.querySelector && node.querySelector('[data-testid*="MiniPlayer_"], [data-testid*="NowPlaying_"], a[data-testid="MiniPlayer_Title"]')) return true;
      node = node.parentElement;
    }
    return false;
  }

  function looksLikeNowArt(rect) {
    if (!rect || rect.width < 32 || rect.height < 32 || rect.width > 112 || rect.height > 112) return false;
    const ratio = rect.width / rect.height;
    if (ratio < 0.8 || ratio > 1.25) return false;
    if (rect.bottom < window.innerHeight - 200) return false;
    if (rect.top < window.innerHeight - 240) return false;
    return true;
  }

  function findAmazonNowArt() {
    const nodes = [];
    collectDeep('img, [role="img"], [data-testid*="Imagery"]', document.documentElement, nodes, 0, 12);
    const titles = [];
    collectDeep('a[data-testid="MiniPlayer_Title"]', document.documentElement, titles, 0, 12);
    const title = titles.find((el) => el && !(el.closest && el.closest('#amfl-player')));
    const titleRect = title ? title.getBoundingClientRect() : null;
    let best = null;
    nodes.forEach((el) => {
      if (!el || (el.closest && el.closest('#amfl-player, #amfl-tracks, #amfl-add'))) return;
      const test = (el.getAttribute && el.getAttribute('data-testid')) || '';
      if (test.indexOf('Stage_') !== -1) return;
      if (!inMiniPlayerCluster(el)) return;
      const rect = el.getBoundingClientRect();
      if (!looksLikeNowArt(rect)) return;
      if (titleRect && titleRect.width > 2 && rect.left > titleRect.left + 4) return;
      if (!best || rect.left < best.left) best = rect;
    });
    return best;
  }

  function findAmazonQueueButton() {
    const nodes = [];
    collectDeep('button, [role="button"]', document.documentElement, nodes, 0, 14);
    let best = null;
    nodes.forEach((btn) => {
      if (!isAmazonBarQueueControl(btn)) return;
      if (!inMiniPlayerCluster(btn)) return;
      const rect = btn.getBoundingClientRect();
      if (!best || rect.left > best.left) best = rect;
    });
    return best;
  }

  function measureAmazonControlAnchors() {
    const seeds = [];
    collectDeep('[data-testid*="MiniPlayer_"], [data-testid*="NowPlaying_"], a[data-testid="MiniPlayer_Title"]', document.documentElement, seeds, 0, 14);
    document.querySelectorAll('[data-amfl-bar-hidden]').forEach((el) => seeds.push(el));
    const saved = unhideForAnchorMeasure(seeds);
    let art = null;
    let queue = null;
    try {
      art = findAmazonNowArt();
      queue = findAmazonQueueButton();
    } finally {
      restoreAnchorMeasure(saved);
    }
    if (!art || art.width < 32) return null;
    return {
      artLeft: art.left,
      queueLeft: queue ? queue.left : null,
      queueWidth: queue ? queue.width : 0
    };
  }

  function releaseAnchorPlacement(el) {
    if (!el || !el.style) return;
    ['position', 'left', 'top', 'right', 'bottom', 'transform', 'margin', 'z-index', 'width', 'max-width', 'flex'].forEach((prop) => {
      el.style.removeProperty(prop);
    });
  }

  function applyControlAnchors(root, anchors) {
    const art = root.querySelector('.amfl-art');
    const left = root.querySelector('.amfl-left');
    const side = root.querySelector('.amfl-side');
    const queueBtn = root.querySelector('[data-act="queueview"]');
    const volume = root.querySelector('.amfl-volume');
    const transport = root.querySelector('.amfl-transport');
    const content = root.querySelector('.amfl-content');
    const buttons = transport ? [...transport.querySelectorAll('button')] : [];
    // Drop the equal-gap absolute layout. Center buttons stay in .amfl-transport flow.
    buttons.forEach(releaseAnchorPlacement);
    releaseAnchorPlacement(volume);
    releaseAnchorPlacement(queueBtn);
    releaseAnchorPlacement(left);
    releaseAnchorPlacement(side);
    if (transport) transport.style.removeProperty('position');
    if (content) {
      content.style.removeProperty('padding-left');
      content.style.removeProperty('padding-right');
    }
    root.style.setProperty('--amfl-bar-left', '24px');
    root.style.setProperty('--amfl-bar-right', '24px');
    if (!art || !left || !side || !anchors) return;
    const naturalPadLeft = content ? getComputedStyle(content).paddingLeft : '24px';
    const naturalPadRight = content ? getComputedStyle(content).paddingRight : '24px';
    const playerRect = root.getBoundingClientRect();
    const ourArtLeft = art.getBoundingClientRect().left;
    const artDelta = anchors.artLeft - ourArtLeft;
    left.style.setProperty('transform', 'translateX(' + artDelta + 'px)');
    // Line our queue button up with Amazon's. Volume stays in the side group, so it moves with the queue.
    let sideDelta = 0;
    if (queueBtn && anchors.queueLeft) {
      sideDelta = anchors.queueLeft - queueBtn.getBoundingClientRect().left;
      const queueRight = queueBtn.getBoundingClientRect().right + sideDelta;
      const limit = playerRect.right - 8;
      if (queueRight > limit) sideDelta -= queueRight - limit;
    }
    side.style.setProperty('transform', 'translateX(' + sideDelta + 'px)');
    if (content) {
      content.style.setProperty('padding-left', naturalPadLeft, 'important');
      content.style.setProperty('padding-right', naturalPadRight, 'important');
    }
    const artRect = art.getBoundingClientRect();
    const queueRect = queueBtn ? queueBtn.getBoundingClientRect() : null;
    const progressLeft = Math.round(artRect.left - playerRect.left);
    const progressRight = queueRect ? Math.round(playerRect.right - queueRect.right) : 24;
    root.style.setProperty('--amfl-bar-left', progressLeft + 'px');
    root.style.setProperty('--amfl-bar-right', progressRight + 'px');
    barContentInset = { left: progressLeft, right: progressRight };
  }

  function alignPlayerBar() {
    const root = document.getElementById('amfl-player');
    if (!root || root.hidden) return;
    root.style.removeProperty('left');
    root.style.removeProperty('width');
    root.style.removeProperty('right');
    root.style.removeProperty('max-width');
    const measured = measureAmazonControlAnchors();
    if (measured) lastControlAnchors = measured;
    if (!lastControlAnchors) return;
    applyControlAnchors(root, lastControlAnchors);
  }

  function innerBarContentRect() {
    const bar = findBar();
    if (!bar) return null;
    const revealed = revealHiddenChain(bar);
    const outer = bar.getBoundingClientRect();
    let best = null;
    let bestInset = 0;
    const consider = (el) => {
      if (!el || el.nodeType !== 1 || el.id === 'amfl-player') return;
      if (el.closest && el.closest('#amfl-player')) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 16 || rect.height > 140) return;
      const insetL = rect.left - outer.left;
      const insetR = outer.right - rect.right;
      if (insetL < 12 || insetR < 12) return;
      const inset = Math.min(insetL, insetR);
      if (inset <= bestInset) return;
      best = rect;
      bestInset = inset;
    };
    [...bar.children].forEach(consider);
    if (bar.querySelectorAll) bar.querySelectorAll('div, section').forEach(consider);
    rehideChain(revealed);
    return best;
  }

  function volumeEventHit(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    for (const node of path) {
      if (!node || node.nodeType !== 1) continue;
      if (node.id === 'amfl-player' || (node.closest && node.closest('#amfl-player'))) return false;
      if (node === audio) return false;
      if (isVolumeNamed(node)) return true;
    }
    return false;
  }

  function onAmazonVolumeSignal(event) {
    if (!player.active || writingVolume) return;
    if (!volumeEventHit(event)) return;
    applyAmazonVolume();
  }

  let barHiddenPieces = [];

  function pieceSnapshot(el) {
    return {
      el: el,
      display: el.style.display,
      visibility: el.style.visibility,
      pointerEvents: el.style.pointerEvents
    };
  }

  function concealBarPiece(el) {
    if (!el || el.id === 'amfl-player' || el === document.body || el === document.documentElement) return;
    if (!barHiddenPieces.some((item) => item.el === el)) barHiddenPieces.push(pieceSnapshot(el));
    el.dataset.amflBarHidden = '1';
    el.style.setProperty('display', 'none', 'important');
  }

  // The gray strip is often a parent or sibling of the controls findBar returns.
  // Hide that backdrop with the bar, and keep it on the same restore list.
  function amazonBarPieces(bar) {
    const out = [];
    const add = (el) => {
      if (!el || el.id === 'amfl-player' || el === document.body || el === document.documentElement) return;
      if (out.indexOf(el) === -1) out.push(el);
    };
    add(bar);
    const bottomStrip = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width >= window.innerWidth * 0.5 && rect.bottom >= window.innerHeight - 16 && rect.height >= 8 && rect.height <= 240;
    };
    let node = bar.parentElement;
    for (let i = 0; node && node !== document.body && i < 6; i += 1) {
      const rect = node.getBoundingClientRect();
      if (rect.height > 240 && rect.height > window.innerHeight * 0.35) break;
      if (bottomStrip(node)) add(node);
      node = node.parentElement;
    }
    const scope = bar.parentElement;
    if (scope) {
      [...scope.children].forEach((el) => {
        if (el !== bar && bottomStrip(el)) add(el);
      });
    }
    const barRect = bar.getBoundingClientRect();
    // Gray backdrop child. Not the latched controls node findBar keeps.
    // concealBarPiece sets data-amfl-bar-hidden and display:none on it.
    [...bar.children].forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < barRect.width * 0.8 || rect.height < 8 || rect.height > 240) return;
      const bg = getComputedStyle(el).backgroundColor || '';
      if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') add(el);
    });
    return out;
  }

  function hideBar() {
    if (amazonHandoff || !player.active) return;
    if (barHide && barHide.el && nodeHoldsOpenQueue(barHide.el)) restoreBar();
    const bar = findBar();
    if (!bar || bar.id === 'amfl-player') return;
    if (nodeHoldsOpenQueue(bar)) {
      restoreBar();
      return;
    }
    if (!barHide || barHide.el !== bar) {
      const already = barHiddenPieces.find((item) => item.el === bar);
      // Do not snapshot after conceal. A later findBar hit is often the gray
      // parent, and its inline display is already none.
      barHide = already || pieceSnapshot(bar);
    }
    clearPinnedVolume();
    amazonBarPieces(bar).forEach(concealBarPiece);
    watchVolumeRoot(bar);
    alignPlayerBar();
    applyAmazonVolume();
  }

  function releaseHiddenBarPiece(el, saved) {
    if (!el || !el.style || el.id === 'amfl-player') return;
    // Drop our hide only. Never write display:none back, and never strip
    // background: the gray strip's color is that background. Clearing
    // data-amfl-bar-hidden on the latched controls parent is not enough;
    // amazonBarPieces also conceals the full-width gray child (and the
    // bottom-strip parent/sibling). Those must lose display:none too.
    if (el.dataset) delete el.dataset.amflBarHidden;
    if (el.removeAttribute) el.removeAttribute('data-amfl-bar-hidden');
    el.style.removeProperty('display');
    el.style.removeProperty('visibility');
    el.style.removeProperty('pointer-events');
    const opacity = (el.style.getPropertyValue('opacity') || '').trim();
    if (opacity === '0') el.style.removeProperty('opacity');
    const height = (el.style.getPropertyValue('height') || '').trim();
    if (height === '0' || height === '0px') el.style.removeProperty('height');
    if (saved) {
      if (saved.display && saved.display !== 'none') el.style.display = saved.display;
      if (saved.visibility && saved.visibility !== 'hidden') el.style.visibility = saved.visibility;
      if (saved.pointerEvents && saved.pointerEvents !== 'none') el.style.pointerEvents = saved.pointerEvents;
    }
  }

  function ourDisplayNone(el) {
    if (!el || !el.style) return false;
    if (el.getAttribute && el.getAttribute('data-amfl-bar-hidden') != null) return true;
    return el.style.display === 'none' && el.style.getPropertyPriority('display') === 'important';
  }

  function restoreBar() {
    if (volumeObserver) volumeObserver.disconnect();
    clearPinnedVolume();
    clearBarStack();
    const savedByEl = new Map();
    barHiddenPieces.forEach((item) => {
      if (item && item.el) savedByEl.set(item.el, item);
    });
    if (barHide && barHide.el && !savedByEl.has(barHide.el)) savedByEl.set(barHide.el, barHide);
    const nodes = [];
    const push = (el) => {
      if (!el || el.nodeType !== 1 || el.id === 'amfl-player') return;
      if (el === document.body || el === document.documentElement) return;
      if (nodes.indexOf(el) === -1) nodes.push(el);
    };
    document.querySelectorAll('[data-amfl-bar-hidden]').forEach(push);
    const deep = [];
    collectDeep('[data-amfl-bar-hidden]', document.documentElement, deep, 0, 16);
    deep.forEach(push);
    savedByEl.forEach((item, el) => push(el));
    const seeds = nodes.slice();
    seeds.forEach((el) => {
      let parent = el.parentElement;
      for (let i = 0; parent && parent !== document.body && parent !== document.documentElement && i < 8; i += 1) {
        if (ourDisplayNone(parent) || savedByEl.has(parent)) push(parent);
        parent = parent.parentElement;
      }
      const parentEl = el.parentElement;
      if (!parentEl) return;
      [...parentEl.children].forEach((sib) => {
        if (ourDisplayNone(sib) || savedByEl.has(sib)) push(sib);
      });
    });
    nodes.forEach((el) => releaseHiddenBarPiece(el, savedByEl.get(el)));
    // Second pass: a gray child can sit under the latched parent and still
    // carry data-amfl-bar-hidden or display:none !important after the first
    // release if its snapshot was taken after conceal.
    const again = [];
    document.querySelectorAll('[data-amfl-bar-hidden]').forEach((el) => again.push(el));
    collectDeep('[data-amfl-bar-hidden]', document.documentElement, again, 0, 16);
    again.forEach((el) => releaseHiddenBarPiece(el, savedByEl.get(el)));
    barHiddenPieces = [];
    barHide = null;
    if (!player.active || amazonHandoff) {
      const overlay = document.getElementById('amfl-player');
      if (overlay) overlay.hidden = true;
    }
  }

  // Set when a local Play / shuffle / song row starts. Amazon play events in
  // this window are the pause echo, not a takeover. Refreshed only when a
  // local start pauses Amazon, not by the keep-alive timer.
  let localGestureUntil = 0;
  let amazonHandoff = false;
  let pageGoingAway = false;
  let resumeOnShow = false;
  let volumeToggleAt = 0;
  let silencingAmazon = false;

  function beginLocalTakeover() {
    amazonHandoff = false;
    localGestureUntil = Date.now() + 700;
  }

  function silenceAmazon(fromLocalStart) {
    if (silencingAmazon) return;
    silencingAmazon = true;
    try {
      document.querySelectorAll('audio, video').forEach((media) => {
        if (media === audio || media.closest('#amfl-player')) return;
        try {
          if (!media.paused) media.pause();
        } catch (err) { /* ignore */ }
      });
    } finally {
      silencingAmazon = false;
    }
    if (fromLocalStart) {
      localGestureUntil = Date.now() + 700;
      scheduleAmazonRewind();
    }
  }

  let amazonRewindA = 0;
  let amazonRewindB = 0;

  function eachAmazonMediaDeep(fn) {
    const seen = new Set();
    const visit = (media) => {
      if (!media || seen.has(media)) return;
      seen.add(media);
      fn(media);
    };
    document.querySelectorAll('audio, video').forEach(visit);
    const extra = [];
    collectDeep('audio, video', document.documentElement, extra, 0, 16);
    extra.forEach(visit);
  }

  // Local start only. handoffToAmazon never calls this. Timeouts no-op once
  // Amazon has taken the player back (player.active is cleared).
  function rewindAmazonPlayback() {
    if (!player.active || Date.now() >= localGestureUntil) return;
    const sliders = [];
    collectDeep('[role="slider"], input[type="range"], [role="progressbar"]', document.documentElement, sliders, 0, 16);
    sliders.forEach((el) => {
      if (!el || (el.closest && el.closest('#amfl-player, #amfl-tracks, #amfl-add'))) return;
      if (isVolumeNamed(el) || amazonVolumeSlider(el)) return;
      const role = ((el.getAttribute && el.getAttribute('role')) || '').toLowerCase();
      const test = (el.getAttribute && el.getAttribute('data-testid')) || '';
      const seek = looksLikeSeek(el) || role === 'progressbar' || /progress|seek|scrub|playback/i.test(test);
      if (!seek) return;
      try { writeControlValue(el, 0); } catch (err) { /* ignore */ }
      if (role === 'progressbar') el.setAttribute('aria-valuenow', '0');
    });
    eachAmazonMediaDeep((media) => {
      if (media === audio || (media.closest && media.closest('#amfl-player'))) return;
      try {
        if (!media.paused && !media.ended) media.pause();
        if (Number.isFinite(media.currentTime) && media.currentTime !== 0) media.currentTime = 0;
      } catch (err) { /* ignore */ }
    });
    const roots = [];
    if (barHide && barHide.el) roots.push(barHide.el);
    const bar = findBar();
    if (bar && roots.indexOf(bar) === -1) roots.push(bar);
    roots.forEach((root) => {
      const fills = [];
      collectDeep('[data-testid*="rogress"], [data-testid*="eek"], [data-testid*="layback"], [class*="progress"], [class*="Progress"], [class*="seek"]', root, fills, 0, 8);
      fills.forEach((el) => {
        if (!el || !el.style || (el.closest && el.closest('#amfl-player'))) return;
        if (isVolumeNamed(el) || amazonVolumeSlider(el)) return;
        if (el.getBoundingClientRect().height > 16) return;
        const inline = (el.style.width || '').trim();
        if (/^[\d.]+%$/.test(inline)) el.style.width = '0%';
        if (/scaleX|translateX/i.test(el.style.transform || '')) el.style.transform = 'scaleX(0)';
      });
    });
  }

  function scheduleAmazonRewind() {
    rewindAmazonPlayback();
    if (amazonRewindA) clearTimeout(amazonRewindA);
    if (amazonRewindB) clearTimeout(amazonRewindB);
    amazonRewindA = window.setTimeout(rewindAmazonPlayback, 80);
    amazonRewindB = window.setTimeout(rewindAmazonPlayback, 300);
  }

  function tryClearQueue() {
    const buttons = document.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      if (btn.closest('#amfl-player, #amfl-tracks, #amfl-add')) continue;
      const label = ((btn.getAttribute('aria-label') || '') + ' ' + (btn.textContent || '')).replace(/\s+/g, ' ').toLowerCase();
      if (label.includes('queue') && (label.includes('clear') || label.includes('remove all'))) {
        btn.click();
        return true;
      }
    }
    return false;
  }

  function isLocallyPlaying() {
    return !!(player.active && audio.currentSrc && !audio.paused && !audio.ended);
  }

  // Amazon's media actually started. Stop local audio, clear the local queue,
  // hide the overlay, and restore Amazon's bar. Do not pause Amazon.
  function handoffToAmazon() {
    amazonHandoff = true;
    const overlay = document.getElementById('amfl-player');
    if (overlay) overlay.hidden = true;
    if (!player.active) {
      stopSilence();
      restoreBar();
      return;
    }
    stopLocal();
    if (overlay) overlay.hidden = true;
    restoreBar();
  }

  function syncAmazonChrome() {
    const overlay = document.getElementById('amfl-player');
    const overlayUp = !!(player.active && !amazonHandoff && overlay && !overlay.hidden);
    if (!amazonHandoff && (overlayUp || player.active)) {
      // Re-pause only inside the post-pause window. After that, a real
      // Amazon play event hides us and must not be paused again here.
      if (Date.now() < localGestureUntil) silenceAmazon();
      if (!player.active) {
        restoreBar();
        return;
      }
      hideBar();
      alignPlayerBar();
      if (overlay) overlay.hidden = false;
      blockAmazonBarQueue(true);
      applyAmazonVolume();
      liftAmazonToasts();
      return;
    }
    if (overlay) overlay.hidden = true;
    blockAmazonBarQueue(false);
    restoreBar();
    liftAmazonToasts();
  }

  function clearToastLift(el) {
    if (!el || !el.dataset || el.dataset.amflToastLift !== '1') return;
    if (el.dataset.amflToastBottom) el.style.bottom = el.dataset.amflToastBottom;
    else el.style.removeProperty('bottom');
    if (el.dataset.amflToastTransform) el.style.transform = el.dataset.amflToastTransform;
    else el.style.removeProperty('transform');
    if (el.dataset.amflToastZ) el.style.zIndex = el.dataset.amflToastZ;
    else el.style.removeProperty('z-index');
    delete el.dataset.amflToastLift;
    delete el.dataset.amflToastBottom;
    delete el.dataset.amflToastTransform;
    delete el.dataset.amflToastZ;
  }

  function rememberToastLift(el) {
    if (!el || el.dataset.amflToastLift === '1') return;
    el.dataset.amflToastLift = '1';
    el.dataset.amflToastBottom = el.style.bottom || '';
    el.dataset.amflToastTransform = el.style.transform || '';
    el.dataset.amflToastZ = el.style.zIndex || '';
  }

  function resetToastShift(el) {
    if (!el || el.dataset.amflToastLift !== '1') return;
    if (el.dataset.amflToastBottom) el.style.bottom = el.dataset.amflToastBottom;
    else el.style.removeProperty('bottom');
    if (el.dataset.amflToastTransform) el.style.transform = el.dataset.amflToastTransform;
    else el.style.removeProperty('transform');
  }

  // data-testid="Toast" and the fixed/absolute ancestors that pin it to the
  // bottom. Raise those above #amfl-player and move the positioning box up
  // so the toast, including Toast_CloseButton, is fully above our bar.
  function liftAmazonToasts() {
    const overlay = document.getElementById('amfl-player');
    const up = !!(player.active && overlay && !overlay.hidden);
    const found = [];
    if (up) collectDeep('[data-testid="Toast"]', document.documentElement, found, 0);
    const seen = new Set();
    const barTop = up ? overlay.getBoundingClientRect().top : 0;
    found.forEach((toast) => {
      if (!toast || toast.nodeType !== 1 || seen.has(toast)) return;
      if (toast.closest && toast.closest('#amfl-player, #amfl-tracks, #amfl-add')) return;
      seen.add(toast);
      const chain = [];
      let node = toast;
      let guard = 0;
      while (node && node !== document.body && node !== document.documentElement && guard < 10) {
        chain.push(node);
        node = node.parentElement;
        guard += 1;
      }
      const positioned = [];
      chain.forEach((el) => {
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'absolute') return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return;
        if (rect.height > window.innerHeight * 0.55 && rect.width > window.innerWidth * 0.7) return;
        if (rect.bottom < window.innerHeight - 280 && el !== toast) return;
        positioned.push(el);
      });
      const raise = [toast].concat(positioned.filter((el) => el !== toast));
      raise.forEach((el) => {
        rememberToastLift(el);
        seen.add(el);
        el.style.setProperty('z-index', '2147483647', 'important');
      });
      const mover = positioned.length ? positioned[positioned.length - 1] : toast;
      resetToastShift(mover);
      const rect = toast.getBoundingClientRect();
      const overlap = rect.bottom - barTop;
      if (overlap > -6) {
        const shift = Math.ceil(overlap + 12);
        const cs = getComputedStyle(mover);
        const bottom = parseFloat(cs.bottom);
        if ((cs.position === 'fixed' || cs.position === 'absolute') && Number.isFinite(bottom)) {
          mover.style.setProperty('bottom', (bottom + shift) + 'px', 'important');
        } else {
          const prev = mover.dataset.amflToastTransform || '';
          mover.style.setProperty('transform', (prev ? prev + ' ' : '') + 'translateY(-' + shift + 'px)', 'important');
        }
      }
    });
    const lifted = [];
    collectDeep('[data-amfl-toast-lift]', document.documentElement, lifted, 0);
    lifted.forEach((el) => {
      if (!seen.has(el)) clearToastLift(el);
    });
  }

  function armSilence() {
    syncAmazonChrome();
    if (silenceTimer) return;
    silenceTimer = window.setInterval(() => {
      if (!player.active) {
        restoreBar();
        blockAmazonBarQueue(false);
        return;
      }
      syncAmazonChrome();
    }, 700);
  }

  function stopSilence() {
    if (silenceTimer) {
      clearInterval(silenceTimer);
      silenceTimer = 0;
    }
    queueCleared = false;
  }

  function markMissing(id) {
    fileErrors.set(id, MISSING_FILE);
  }

  async function fileFor(id, allowPrompt) {
    if (sessionFiles.has(id)) {
      fileErrors.delete(id);
      const cached = sessionFiles.get(id);
      ensureCover(id, cached);
      return cached;
    }
    let handle = null;
    try { handle = await idbGet(id); } catch (err) { handle = null; }
    if (handle && handle.needsPermission) {
      if (!allowPrompt) return null;
      const permitted = await pageSend({ type: 'permit', id: id });
      if (permitted && permitted.file) {
        sessionFiles.set(id, permitted.file);
        fileErrors.delete(id);
        ensureCover(id, permitted.file);
        return permitted.file;
      }
      if (permitted && permitted.missing) markMissing(id);
      else fileErrors.set(id, 'Click the song to allow access.');
      return null;
    }
    if (!handle || typeof handle.getFile !== 'function') {
      if (!fileErrors.has(id)) fileErrors.set(id, 'No saved handle for this song.');
      return null;
    }
    try {
      let perm = 'prompt';
      try { perm = await handle.queryPermission({ mode: 'read' }); } catch (err) { perm = 'prompt'; }
      if (perm !== 'granted') {
        if (!allowPrompt || !handle.requestPermission) {
          fileErrors.set(id, 'Click the song to allow access.');
          return null;
        }
        try { perm = await handle.requestPermission({ mode: 'read' }); } catch (err) {
          fileErrors.set(id, 'Click the song to allow access.');
          return null;
        }
        if (perm !== 'granted') {
          fileErrors.set(id, 'Click the song to allow access.');
          return null;
        }
      }
      const file = await handle.getFile();
      fileErrors.delete(id);
      ensureCover(id, file);
      return file;
    } catch (err) {
      const name = err && err.name;
      if (name === 'NotFoundError') markMissing(id);
      else fileErrors.set(id, (name || 'Error') + (err && err.message ? ': ' + err.message : ''));
      return null;
    }
  }

  function shuffleIds(ids) {
    const copy = ids.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy;
  }

  // Unshuffled key order, minus entries that have left the queue. New entries
  // are appended. This never reinserts a song that already finished or was removed.
  function retainOrder() {
    const live = new Set(player.queue.map((item) => item.key));
    const known = new Set();
    const next = [];
    player.order.forEach((key) => {
      if (!live.has(key) || known.has(key)) return;
      known.add(key);
      next.push(key);
    });
    player.queue.forEach((item) => {
      if (known.has(item.key)) return;
      known.add(item.key);
      next.push(item.key);
    });
    player.order = next;
  }

  // Playing song first, then every other entry still queued, in saved order.
  function layoutUnshuffled() {
    if (!player.queue.length) {
      player.index = 0;
      player.order = [];
      return;
    }
    if (player.index < 0 || player.index >= player.queue.length) player.index = 0;
    const current = player.queue[player.index];
    retainOrder();
    const byKey = new Map(player.queue.map((item) => [item.key, item]));
    const rest = [];
    player.order.forEach((key) => {
      if (key !== current.key) rest.push(byKey.get(key));
    });
    player.queue = [current].concat(rest);
    player.index = 0;
  }

  // Keep the playing song at the top without reshuffling the songs after it.
  function pinPlayingFirst() {
    if (!player.queue.length) {
      player.index = 0;
      player.order = [];
      return;
    }
    if (player.index < 0 || player.index >= player.queue.length) player.index = 0;
    if (player.index !== 0) {
      const item = player.queue[player.index];
      player.queue.splice(player.index, 1);
      player.queue.unshift(item);
      player.index = 0;
    }
    retainOrder();
  }

  function normalizeQueue() {
    if (player.shuffle) pinPlayingFirst();
    else layoutUnshuffled();
  }

  // Fresh Fisher-Yates of every queued entry that is not playing.
  // Built from the remembered unshuffled order, so turning shuffle off and
  // on again never replays one saved permutation. Duplicates stay.
  // player.order is only the unshuffled key list and is not rewritten here.
  function shuffleQueuedEntries() {
    layoutUnshuffled();
    if (player.queue.length < 2) {
      player.index = 0;
      return;
    }
    const rest = shuffleIds(player.queue.slice(1));
    player.queue = [player.queue[0]].concat(rest);
    player.index = 0;
  }

  function buildQueue(startId) {
    player.only = false;
    const entries = files.map((file) => queueEntry(file.id));
    player.queue = entries;
    player.order = entries.map((item) => item.key);
    const at = entries.findIndex((item) => item.id === startId);
    player.index = at < 0 ? 0 : at;
    if (player.shuffle && player.queue.length) {
      const current = player.queue[player.index];
      const rest = shuffleIds(player.queue.filter((item) => item.key !== current.key));
      player.queue = [current].concat(rest);
      player.index = 0;
    } else {
      layoutUnshuffled();
    }
  }

  async function startIndex(index, allowPrompt, keepQueueOrder) {
    if (!player.queue.length) return;
    const mode = player.repeat || 'off';
    const len = player.queue.length;
    let start = index;
    if (start < 0 || start >= len) {
      if (mode === 'all') start = ((start % len) + len) % len;
      else {
        stopLocal();
        return;
      }
    }
    beginLocalTakeover();
    const steps = mode === 'one' ? 1 : (mode === 'all' ? len : len - start);
    let file = null;
    let id = '';
    let missingId = '';
    for (let step = 0; step < steps; step += 1) {
      const at = mode === 'all' ? (start + step) % len : start + step;
      id = player.queue[at].id;
      file = await fileFor(id, !!(allowPrompt && step === 0));
      if (file) {
        player.index = at;
        fileErrors.delete(id);
        break;
      }
      if (fileErrors.has(id)) missingId = id;
      file = null;
    }
    if (!file) {
      showPlayer(false);
      restoreBar();
      paintTracks();
      return;
    }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    audio.src = objectUrl;
    player.active = true;
    beginLocalTakeover();
    silenceAmazon(true);
    showPlayer(true);
    armSilence();
    applyAmazonVolume();
    try {
      await audio.play();
      resumeOnShow = false;
    } catch (err) {
      player.active = true;
      resumeOnShow = document.visibilityState === 'hidden';
    }
    syncAmazonChrome();
    if (!keepQueueOrder) normalizeQueue();
    paintPlayer();
    paintTracks();
  }

  async function playId(id) {
    if (!files.length) return;
    buildQueue(id);
    await startIndex(player.index, true);
  }

  async function playAll() {
    if (!files.length) return;
    player.only = false;
    const first = player.shuffle ? shuffleIds(files.map((file) => file.id))[0] : files[0].id;
    await playId(first);
  }

  async function playOnly(id) {
    if (!files.some((file) => file.id === id)) return;
    player.only = true;
    const entry = queueEntry(id);
    player.queue = [entry];
    player.order = [entry.key];
    player.index = 0;
    await startIndex(0, true);
  }

  async function toggleRowPlayback(id) {
    if (player.active && playingId() === id && (audio.currentSrc || audio.src)) {
      if (audio.paused || audio.ended) {
        player.active = true;
        beginLocalTakeover();
        silenceAmazon(true);
        armSilence();
        applyAmazonVolume();
        try { await audio.play(); } catch (err) { /* ignore */ }
        syncAmazonChrome();
      } else {
        try { audio.pause(); } catch (err) { /* ignore */ }
        syncAmazonChrome();
      }
      paintPlayer();
      return;
    }
    await playOnly(id);
  }

  async function addToQueue(id) {
    if (!files.some((file) => file.id === id)) return;
    const wasEmpty = player.queue.length === 0;
    if (wasEmpty) {
      // A queue click on an empty queue is also the first play request.
      if (!isLocallyPlaying()) {
        await playOnly(id);
      } else {
        const entry = queueEntry(id);
        player.queue = [entry];
        player.order = [entry.key];
        player.index = 0;
        paintQueue();
      }
      return;
    }
    const entry = queueEntry(id);
    player.queue.push(entry);
    player.order.push(entry.key);
    if (player.queue.length > 1) player.only = false;
    if (!player.shuffle) layoutUnshuffled();
    paintQueue();
  }

  function cycleRepeat() {
    const order = ['off', 'all', 'one'];
    const cur = order.indexOf(player.repeat || 'off');
    player.repeat = order[(cur + 1) % order.length];
    paintPlayer();
  }

  function toggleQueueView() {
    player.queueOpen = !player.queueOpen;
    const current = playingId();
    if (player.queueOpen && current && !player.queue.some((item) => item.id === current)) addToQueue(current);
    paintQueue();
    paintPlayer();
  }

  function clearQueue() {
    stopLocal();
  }

  async function removeFromQueue(index) {
    if (!Number.isInteger(index) || index < 0 || index >= player.queue.length) return;
    const wasCurrent = index === player.index;
    const removed = player.queue[index];
    player.queue.splice(index, 1);
    if (removed) player.order = player.order.filter((key) => key !== removed.key);

    if (!player.queue.length) {
      stopLocal();
      return;
    }

    if (!wasCurrent) {
      if (index < player.index) player.index -= 1;
      normalizeQueue();
      paintPlayer();
      return;
    }

    const mode = player.repeat || 'off';
    let nextIndex = index;
    if (nextIndex >= player.queue.length) {
      if (mode === 'all') nextIndex = 0;
      else {
        // A removed repeat-one item must not be loaded again.
        stopLocal();
        return;
      }
    }
    await startIndex(nextIndex, true);
  }

  function paintQueue() {
    const root = document.getElementById('amfl-player');
    if (!root) return;
    const panel = root.querySelector('.amfl-queue');
    const list = root.querySelector('.amfl-queue-list');
    if (!panel || !list) return;
    const open = !!player.queueOpen && !root.hidden;
    panel.hidden = !open;
    if (!open) return;
    const sig = player.index + ':' + player.queue.map((item) => item.key + '=' + item.id + (coverUrls.has(item.id) ? '*' : '')).join(',');
    if (list.querySelector('[data-amfl-open-local]')) delete list.dataset.sig;
    if (list.dataset.sig === sig && list.childElementCount) return;
    list.dataset.sig = sig;
    list.replaceChildren();
    if (!player.queue.length) {
      const empty = document.createElement('div');
      empty.className = 'amfl-queue-empty';
      empty.textContent = 'Queue is empty.';
      list.appendChild(empty);
      return;
    }
    player.queue.forEach((item, i) => {
      const id = item.id;
      const meta = files.find((file) => file.id === id);
      const row = document.createElement('div');
      row.className = 'amfl-queue-item' + (i === player.index ? ' is-current' : '');
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'amfl-queue-name';
      jump.dataset.act = 'queuejump';
      jump.dataset.index = String(i);
      const art = document.createElement('span');
      art.className = 'amfl-queue-art';
      const cover = coverUrls.get(id);
      if (cover) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = cover;
        art.appendChild(img);
      } else {
        art.innerHTML = icon('song');
        ensureCover(id);
      }
      const textWrap = document.createElement('span');
      textWrap.className = 'amfl-queue-text';
      const titleEl = document.createElement('span');
      titleEl.className = 'amfl-queue-track';
      titleEl.textContent = (meta && (meta.title || meta.filename)) || 'Local song';
      const artistEl = document.createElement('span');
      artistEl.className = 'amfl-queue-artist';
      fillArtistOnly(artistEl, (meta && meta.artist) || '');
      textWrap.append(titleEl, artistEl);
      jump.append(art, textWrap);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'amfl-queue-remove';
      remove.dataset.act = 'queueremove';
      remove.dataset.index = String(i);
      remove.setAttribute('aria-label', 'Remove from queue');
      remove.title = 'Remove from queue';
      remove.textContent = '×';
      row.append(jump, remove);
      list.appendChild(row);
    });
  }

  async function replayCurrent(allowPrompt) {
    if (!player.queue.length) return;
    if (audio.src && player.active) {
      try {
        audio.currentTime = 0;
        player.active = true;
        beginLocalTakeover();
        silenceAmazon(true);
        showPlayer(true);
        armSilence();
        applyAmazonVolume();
        await audio.play();
        syncAmazonChrome();
        paintPlayer();
        paintTracks();
        return;
      } catch (err) { /* reload the file */ }
    }
    await startIndex(player.index, !!allowPrompt);
  }

  function moveFinishedToBottom(index) {
    if (!player.queue.length) return 0;
    if (index < 0 || index >= player.queue.length) index = 0;
    const wasLast = index === player.queue.length - 1;
    const item = player.queue[index];
    player.queue.splice(index, 1);
    if (item) player.queue.push(item);
    if (item && item.key != null) {
      const at = player.order.indexOf(item.key);
      if (at !== -1) {
        player.order.splice(at, 1);
        player.order.push(item.key);
      }
    }
    if (!player.queue.length) return 0;
    return wasLast ? 0 : index;
  }

  async function removeCurrentAndAdvance(allowPrompt, replayOne) {
    const mode = player.repeat || 'off';
    const current = player.index;
    if (!player.queue.length || current < 0 || current >= player.queue.length) return;

    // Repeat one replays this song on natural end and on skip forward.
    // It must not advance and must not drop the song. replayOne is unused.
    if (mode === 'one') {
      await replayCurrent(allowPrompt);
      return;
    }

    // Repeat all keeps every queued song. The one that ended or was skipped
    // goes to the bottom; playback continues at the new front. A queue click
    // does not come through here: pinPlayingFirst moves the song that was
    // playing down one slot instead.
    // Repeat one never reaches this: it replays above and does not advance.
    if (mode === 'all') {
      const next = moveFinishedToBottom(current);
      await startIndex(next, allowPrompt);
      return;
    }

    // Repeat off: finishing or skipping forward consumes the song.
    // Drop it from the saved order too so shuffle-off cannot put it back.
    const removed = player.queue[current];
    player.queue.splice(current, 1);
    if (removed) player.order = player.order.filter((key) => key !== removed.key);
    if (!player.queue.length) {
      stopLocal();
      return;
    }
    player.index = current >= player.queue.length ? 0 : current;
    if (current >= player.queue.length) {
      stopLocal();
      return;
    }
    await startIndex(current, allowPrompt);
  }

  async function goNext(allowPrompt) {
    await removeCurrentAndAdvance(allowPrompt, false);
  }

  async function goPrev(allowPrompt) {
    const mode = player.repeat || 'off';
    const len = player.queue.length;
    if (!len) return;
    // Skip-back never consumes the song it lands on, including a one-song queue.
    if (len === 1) {
      await replayCurrent(allowPrompt);
      return;
    }
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      paintPlayer();
      return;
    }
    if (player.index > 0) {
      await startIndex(player.index - 1, allowPrompt);
      return;
    }
    if (mode === 'one') {
      await replayCurrent(allowPrompt);
      return;
    }
    if (mode === 'all') {
      await startIndex(len - 1, allowPrompt);
      return;
    }
    audio.currentTime = 0;
    paintPlayer();
  }

  const PLAYER_SESSION_KEY = 'amflPlayerSession';

  function localPlayerOpen() {
    const overlay = document.getElementById('amfl-player');
    const overlayUp = !!(overlay && !overlay.hidden);
    const current = playingId();
    if (!current || !player.queue.length) return false;
    return !!(player.active || overlayUp);
  }

  function playerSessionSnapshot() {
    const idByKey = new Map(player.queue.map((item) => [item.key, item.id]));
    const orderIds = [];
    (player.order || []).forEach((key) => {
      if (idByKey.has(key)) orderIds.push(idByKey.get(key));
    });
    let currentTime = 0;
    try {
      if (Number.isFinite(audio.currentTime) && audio.currentTime > 0) currentTime = audio.currentTime;
    } catch (err) {
      currentTime = 0;
    }
    const repeat = player.repeat === 'all' || player.repeat === 'one' ? player.repeat : 'off';
    return {
      queue: player.queue.map((item) => item.id),
      order: orderIds,
      index: player.index,
      currentTime: currentTime,
      shuffle: !!player.shuffle,
      repeat: repeat,
      only: !!player.only,
      paused: true
    };
  }

  function clearPlayerSession() {
    // Sync flag so a reload cannot revive a player stopLocal already closed
    // if the chrome.storage remove has not landed yet.
    try { sessionStorage.setItem(PLAYER_SESSION_KEY + ':cleared', '1'); } catch (err) { /* ignore */ }
    try { sessionStorage.removeItem(PLAYER_SESSION_KEY); } catch (err) { /* ignore */ }
    try { chrome.storage.local.remove(PLAYER_SESSION_KEY); } catch (err) { /* ignore */ }
  }

  function usablePlayerSession(session) {
    return !!(session && session.paused !== false && Array.isArray(session.queue) && session.queue.length);
  }

  // pagehide cannot await chrome.storage. sessionStorage is the same-tab
  // snapshot written synchronously; chrome.storage.local key amflPlayerSession
  // is the stored copy.
  function writePlayerSessionNow() {
    if (!localPlayerOpen()) {
      clearPlayerSession();
      return;
    }
    const snap = playerSessionSnapshot();
    try { sessionStorage.removeItem(PLAYER_SESSION_KEY + ':cleared'); } catch (err) { /* ignore */ }
    try { sessionStorage.setItem(PLAYER_SESSION_KEY, JSON.stringify(snap)); } catch (err) { /* ignore */ }
    try {
      const payload = {};
      payload[PLAYER_SESSION_KEY] = snap;
      chrome.storage.local.set(payload);
    } catch (err) { /* ignore */ }
  }

  function readTabPlayerSession() {
    try {
      const raw = sessionStorage.getItem(PLAYER_SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (err) {
      return null;
    }
  }

  function seekRestoredTime(seconds) {
    const t = Number(seconds);
    if (!Number.isFinite(t) || t <= 0) return;
    const apply = () => {
      try {
        const dur = audio.duration;
        let at = t;
        if (Number.isFinite(dur) && dur > 0) at = Math.min(t, Math.max(0, dur - 0.05));
        if (at > 0) audio.currentTime = at;
      } catch (err) { /* ignore */ }
      paintPlayer();
    };
    if (audio.readyState >= 1) apply();
    else audio.addEventListener('loadedmetadata', apply, { once: true });
  }

  // Reopen the saved song paused. This path must not call audio.play()
  // and must not set resumeOnShow.
  async function restorePausedSession() {
    let stored = null;
    try {
      const data = await chrome.storage.local.get(PLAYER_SESSION_KEY);
      stored = data && data[PLAYER_SESSION_KEY];
    } catch (err) {
      stored = null;
    }
    let cleared = false;
    try { cleared = sessionStorage.getItem(PLAYER_SESSION_KEY + ':cleared') === '1'; } catch (err) { cleared = false; }
    if (cleared) {
      clearPlayerSession();
      return;
    }
    const backup = readTabPlayerSession();
    // Same-tab reload reads the synchronous snapshot first. chrome.storage
    // covers a load where that snapshot is missing.
    const session = usablePlayerSession(backup) ? backup : (usablePlayerSession(stored) ? stored : null);
    if (!session) return;
    const queueIds = session.queue.filter((id) => typeof id === 'string' && id);
    if (!queueIds.length) {
      clearPlayerSession();
      return;
    }
    let index = Number(session.index);
    if (!Number.isInteger(index) || index < 0 || index >= queueIds.length) index = 0;
    const currentId = queueIds[index];
    if (!files.some((file) => file && file.id === currentId)) {
      clearPlayerSession();
      return;
    }
    const file = await fileFor(currentId, false);
    if (!file) {
      clearPlayerSession();
      return;
    }
    const known = new Set(files.map((item) => item && item.id).filter(Boolean));
    const kept = [];
    let keptIndex = 0;
    queueIds.forEach((id, at) => {
      if (!known.has(id)) return;
      if (at === index) keptIndex = kept.length;
      kept.push(id);
    });
    if (!kept.length || kept[keptIndex] !== currentId) {
      clearPlayerSession();
      return;
    }
    const entries = kept.map((id) => queueEntry(id));
    player.queue = entries;
    const pool = entries.slice();
    const orderIds = Array.isArray(session.order) ? session.order : kept;
    const order = [];
    orderIds.forEach((id) => {
      const at = pool.findIndex((item) => item.id === id);
      if (at < 0) return;
      order.push(pool[at].key);
      pool.splice(at, 1);
    });
    pool.forEach((item) => order.push(item.key));
    player.order = order;
    player.index = keptIndex;
    player.shuffle = !!session.shuffle;
    player.repeat = session.repeat === 'all' || session.repeat === 'one' ? session.repeat : 'off';
    player.only = !!session.only;
    player.queueOpen = false;
    player.active = true;
    resumeOnShow = false;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    audio.src = objectUrl;
    try { audio.pause(); } catch (err) { /* ignore */ }
    seekRestoredTime(session.currentTime);
    beginLocalTakeover();
    silenceAmazon();
    showPlayer(true);
    armSilence();
    applyAmazonVolume();
    syncAmazonChrome();
    paintPlayer();
    paintTracks();
    resumeOnShow = false;
  }

  function stopLocal() {
    player.active = false;
    player.only = false;
    player.queueOpen = false;
    player.queue = [];
    player.order = [];
    player.index = 0;
    clearPlayerSession();
    try { audio.pause(); } catch (err) { /* ignore */ }
    audio.removeAttribute('src');
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = '';
    }
    stopSilence();
    showPlayer(false);
    paintTracks();
    paintLocalCardPlay();
  }

  let playerActAt = 0;
  let playerActName = '';

  function onPlayerPointerDown(event) {
    const btn = event.target.closest && event.target.closest('button');
    if (!btn || !btn.closest('#amfl-player')) return;
    if (event.button != null && event.button !== 0) return;
    // Volume is a click toggle. Handling it on pointerdown as well made the
    // following click close the popover, so it only stayed open while held
    // (or if the pointer was dragged off the button before release).
    if (btn.dataset.act === 'volume') return;
    event.preventDefault();
    event.stopPropagation();
    // Queue sits on Amazon's queue control. Stop every remaining listener,
    // including the page world, or the click still opens Amazon's queue.
    if (btn.dataset.act === 'queueview') event.stopImmediatePropagation();
    onPlayerClick({ target: btn });
  }

  async function onPlayerClick(event) {
    const btn = event.target.closest ? event.target.closest('button') : event.target;
    if (!btn || !btn.dataset) return;
    const act = btn.dataset.act;
    if (!act) return;
    if (act === 'volume') {
      toggleOurVolume();
      return;
    }
    const now = Date.now();
    if (playerActName === act && now - playerActAt < 280) return;
    playerActName = act;
    playerActAt = now;
    if (act === 'repeat') {
      cycleRepeat();
      return;
    }
    if (act === 'queueview') {
      toggleQueueView();
      return;
    }
    if (act === 'queueclear') {
      clearQueue();
      return;
    }
    if (act === 'queuejump') {
      const index = Number(btn.dataset.index);
      if (!Number.isInteger(index) || index < 0 || index >= player.queue.length) return;
      // Play that song and move the one that was playing down one slot.
      // pinPlayingFirst splices the clicked entry to the front, so the old
      // song shifts down one. Do not swap slots and do not send it to the bottom.
      if (index !== player.index) {
        player.index = index;
        pinPlayingFirst();
      }
      await startIndex(player.index, true, true);
      return;
    }
    if (act === 'queueremove') {
      const index = Number(btn.dataset.index);
      if (!Number.isFinite(index)) return;
      await removeFromQueue(index);
      return;
    }
    if (act === 'play') {
      if (!player.active && !audio.src) return;
      if (audio.paused) {
        player.active = true;
        beginLocalTakeover();
        silenceAmazon(true);
        armSilence();
        applyAmazonVolume();
        try { await audio.play(); } catch (err) { /* ignore */ }
        syncAmazonChrome();
      } else {
        audio.pause();
        syncAmazonChrome();
      }
      paintPlayer();
    } else if (act === 'next') {
      await goNext(true);
    } else if (act === 'prev') {
      await goPrev(true);
    } else if (act === 'shuffle') {
      player.shuffle = !player.shuffle;
      chrome.storage.local.set({ shuffle: player.shuffle });
      // Off restores the remembered unshuffled order (current first, songs
      // that already finished or were skipped stay gone). On runs a new
      // Fisher-Yates of whatever is not playing. No shuffled order is saved.
      if (player.shuffle) shuffleQueuedEntries();
      else layoutUnshuffled();
      paintPlayer();
    }
  }

  function headerButtons(titleEl) {
    if (!titleEl) return [];
    let scope = titleEl.parentElement;
    for (let depth = 0; scope && depth < 7; depth += 1) {
      const buttons = [...scope.querySelectorAll('button, [role="button"]')].filter((btn) => {
        if (btn.closest('#amfl-tracks, #amfl-player')) return false;
        if (btn.id === 'amfl-add') return false;
        const rect = btn.getBoundingClientRect();
        const titleRect = titleEl.getBoundingClientRect();
        return rect.width > 0 && rect.top < titleRect.bottom + 200 && rect.bottom > titleRect.top - 20;
      });
      if (buttons.length) return buttons;
      scope = scope.parentElement;
    }
    return [];
  }


  let wiredStamp = { key: '', at: 0 };

  function inQueueOrPlayer(el) {
    let node = el && el.parentElement;
    while (node && node !== document.documentElement) {
      const test = (node.getAttribute && node.getAttribute('data-testid')) || '';
      const id = node.id || '';
      const label = (node.getAttribute && node.getAttribute('aria-label')) || '';
      if (/miniplayer|nowplaying/i.test(test)) return true;
      if (/queue/i.test(test) || /queue/i.test(id) || /queue/i.test(label)) return true;
      const role = (node.getAttribute && node.getAttribute('role')) || '';
      if (role === 'dialog' || node.getAttribute('aria-modal') === 'true') return true;
      node = node.parentElement;
    }
    return false;
  }

  function isExtensionUi(el) {
    return !!(el && el.closest && el.closest('#amfl-player, #amfl-tracks, #amfl-add, #amfl-sort-control, [data-amfl-sort-control], [data-amfl-clone]'));
  }

  function findPlayButton() {
    const nodes = [...document.querySelectorAll('[data-testid="IconButton,Toolbar_Play_Button"], [data-testid="IconButton,Toolbar_Pause_Button"]')];
    return nodes.find((el) => !isExtensionUi(el) && !inQueueOrPlayer(el) && el.dataset.amflWire !== 'shuffle' && !el.dataset.amflClone) || null;
  }

  function findAddButton() {
    const nodes = [...document.querySelectorAll('[data-testid="ListItem,add-songs-button"], [data-testid*="add-songs" i]')];
    const tagged = nodes.find((el) => !isExtensionUi(el) && !inQueueOrPlayer(el));
    if (tagged) return tagged;
    const buttons = document.querySelectorAll('button, [role="button"], a');
    for (const el of buttons) {
      if (isExtensionUi(el) || inQueueOrPlayer(el) || el.id === 'amfl-add') continue;
      const text = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).replace(/\s+/g, ' ').trim().toLowerCase();
      if (text.length > 48) continue;
      if (text === 'add songs' || text === 'add song') return el;
    }
    return null;
  }

  function findShuffleButton() {
    const nodes = document.querySelectorAll('button, [role="button"]');
    for (const el of nodes) {
      if (isExtensionUi(el) || inQueueOrPlayer(el) || el.dataset.amflClone) continue;
      const test = el.getAttribute('data-testid') || '';
      const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + test).toLowerCase();
      if (/station|similar|radio/.test(label)) continue;
      if (/\bshuffle\b/.test(label)) return el;
    }
    return null;
  }

  function controlShell(el) {
    const trigger = el.closest('[data-testid="tooltip-trigger"]');
    const wrap = trigger && trigger.parentElement;
    if (wrap && wrap.querySelectorAll('[data-testid*="Toolbar_"]').length === 1 && !wrap.querySelector('#amfl-tracks, #amfl-add, #amfl-player, [data-amfl-clone]')) {
      return wrap;
    }
    return el;
  }

  function amazonBarShuffleIcon() {
    const scopes = [];
    const bar = findBar();
    if (bar) scopes.push(bar);
    document.querySelectorAll('[data-testid*="MiniPlayer_"], [data-testid*="NowPlaying_"]').forEach((el) => {
      if (el.closest('#amfl-player')) return;
      let node = el;
      for (let i = 0; node && i < 6; i += 1) {
        if (inQueueOrPlayer(node) || (bar && bar.contains(node))) {
          scopes.push(node);
          break;
        }
        node = node.parentElement;
      }
    });
    const seen = new Set();
    for (const scope of scopes) {
      if (!scope || seen.has(scope)) continue;
      seen.add(scope);
      const buttons = scope.querySelectorAll('button, [role="button"]');
      for (const el of buttons) {
        if (el.closest('#amfl-player, #amfl-tracks, #amfl-add, [data-amfl-header-shuffle]')) continue;
        const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.getAttribute('data-testid') || '')).toLowerCase();
        if (!/\bshuffle\b/.test(label) || /station|similar|radio/.test(label)) continue;
        const svg = el.querySelector('svg');
        if (svg) return svg;
      }
    }
    return null;
  }

  function fillHeaderShuffleIcon(btn) {
    if (btn.dataset.amflIcon === 'amazon' && btn.querySelector('svg')) return;
    const src = amazonBarShuffleIcon();
    if (!src) return;
    const svg = src.cloneNode(true);
    svg.removeAttribute('id');
    svg.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
    svg.setAttribute('aria-hidden', 'true');
    btn.replaceChildren(svg);
    btn.dataset.amflIcon = 'amazon';
  }

  function headerShuffleButton() {
    const native = findShuffleButton();
    const title = headerTitleEl();
    if (!native || !title) return null;
    const rect = native.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    if (rect.top > titleRect.bottom + 220 || rect.bottom < titleRect.top - 40) return null;
    return native;
  }

  function hideNativeHeaderShuffle(play, playShell) {
    const hideShell = (el) => {
      if (!el || el.dataset.amflHeaderShuffle || el.closest('#amfl-player, [data-amfl-header-shuffle], [data-amfl-play-row]')) return;
      if (inQueueOrPlayer(el)) return;
      const shell = controlShell(el);
      if (shell === playShell || playShell.contains(el) || shell.contains(play)) {
        if (el !== play && !playShell.contains(el)) el.classList.add('amfl-native-hidden');
        return;
      }
      shell.classList.add('amfl-native-hidden');
    };
    document.querySelectorAll('[data-testid="IconButton,Toolbar_Shuffle_Button"]').forEach(hideShell);
    const native = headerShuffleButton();
    if (native) hideShell(native);
  }

  function ensurePlayRow(playShell) {
    let row = playShell.closest('[data-amfl-play-row]');
    if (!row) {
      const parent = playShell.parentElement;
      if (!parent) return null;
      row = document.createElement('div');
      row.className = 'amfl-play-row';
      row.dataset.amflPlayRow = '1';
      parent.insertBefore(row, playShell);
      row.appendChild(playShell);
    } else if (row.firstElementChild !== playShell) {
      row.insertBefore(playShell, row.firstChild);
    }
    document.querySelectorAll('[data-amfl-play-row]').forEach((other) => {
      if (other !== row) other.remove();
    });
    return row;
  }

  function ensureShuffleControl(play) {
    ensureNativeHideStyle();
    document.querySelectorAll('[data-amfl-clone="shuffle"]').forEach((el) => {
      if (!el.dataset.amflHeaderShuffle && !el.closest('[data-amfl-header-shuffle]')) el.remove();
    });
    if (!play) return document.querySelector('[data-amfl-header-shuffle]');
    const playShell = controlShell(play);
    hideNativeHeaderShuffle(play, playShell);
    const row = ensurePlayRow(playShell);
    if (!row) return null;
    let btn = document.querySelector('[data-amfl-header-shuffle]');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'amfl-header-shuffle';
      btn.dataset.amflClone = 'shuffle';
      btn.dataset.amflHeaderShuffle = '1';
      btn.setAttribute('aria-label', 'Shuffle');
    }
    if (!btn.querySelector('svg')) btn.innerHTML = icon('shuffle');
    fillHeaderShuffleIcon(btn);
    if (!btn.querySelector('svg')) btn.innerHTML = icon('shuffle');
    if (btn.parentElement !== row || playShell.nextElementSibling !== btn) {
      playShell.insertAdjacentElement('afterend', btn);
    }
    return btn;
  }

  function playlistSortTitle(file) {
    return String((file && (file.title || file.filename)) || '');
  }

  function playlistFilesInSortOrder() {
    const ordered = files.slice();
    if (playlistSort === 'added') return ordered;
    const addedIndex = new Map(files.map((file, index) => [file.id, index]));
    const direction = playlistSort === 'title-desc' ? -1 : 1;
    ordered.sort((a, b) => {
      const titleResult = playlistSortTitle(a).localeCompare(playlistSortTitle(b), undefined, {
        numeric: true,
        sensitivity: 'base'
      });
      return (titleResult * direction) || (addedIndex.get(a.id) - addedIndex.get(b.id));
    });
    return ordered;
  }

  function removeSortControl() {
    document.querySelectorAll('#amfl-sort-control, [data-amfl-sort-control], .amfl-sort-menu').forEach((el) => el.remove());
  }

  const SORT_OPTIONS = [
    ['title-asc', 'Title A to Z'],
    ['title-desc', 'Title Z to A'],
    ['added', 'Added order']
  ];

  function sortLabel(value) {
    const match = SORT_OPTIONS.find((pair) => pair[0] === value);
    return match ? match[1] : 'Added order';
  }

  function sortMenuEl() {
    return document.querySelector('.amfl-sort-menu');
  }

  function closeSortMenu() {
    const menu = sortMenuEl();
    const button = document.querySelector('#amfl-sort-control .amfl-sort-button');
    if (menu) menu.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
  }

  function syncSortControl() {
    const control = document.getElementById('amfl-sort-control');
    if (control) {
      const valueEl = control.querySelector('.amfl-sort-value');
      if (valueEl) valueEl.textContent = sortLabel(playlistSort);
    }
    // placeSortMenu moves the menu onto document.body, outside the control.
    document.querySelectorAll('.amfl-sort-option').forEach((option) => {
      const on = option.dataset.value === playlistSort;
      option.setAttribute('aria-selected', on ? 'true' : 'false');
      option.classList.toggle('is-selected', on);
    });
  }

  function applyPlaylistSort(value) {
    if (value !== 'title-asc' && value !== 'title-desc' && value !== 'added') return;
    if (playlistSort === value) {
      syncSortControl();
      return;
    }
    playlistSort = value;
    const host = document.getElementById('amfl-tracks');
    if (host) delete host.dataset.sig;
    syncSortControl();
    paintTracks();
  }

  function placeSortMenu(button, menu) {
    if (menu.parentElement !== document.body) document.body.appendChild(menu);
    const rect = button.getBoundingClientRect();
    menu.style.top = Math.round(rect.bottom + 4) + 'px';
    menu.style.left = Math.round(rect.left) + 'px';
    menu.style.minWidth = Math.round(Math.max(rect.width, 168)) + 'px';
  }

  function onSortClick(event) {
    const control = document.getElementById('amfl-sort-control');
    if (!control) return;
    const button = control.querySelector('.amfl-sort-button');
    const menu = sortMenuEl();
    if (!button || !menu) return;
    const option = event.target.closest && event.target.closest('.amfl-sort-option');
    // placeSortMenu moves the menu to document.body, so it is not inside the control.
    if (option && option.closest('.amfl-sort-menu')) {
      applyPlaylistSort(option.dataset.value);
      closeSortMenu();
      button.focus();
      return;
    }
    if (event.target.closest && event.target.closest('.amfl-sort-button')) {
      const open = menu.hidden;
      if (open) {
        placeSortMenu(button, menu);
        menu.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        const selected = menu.querySelector('.is-selected') || menu.querySelector('.amfl-sort-option');
        if (selected) selected.focus();
      } else {
        closeSortMenu();
      }
    }
  }

  function onSortKey(event) {
    const control = document.getElementById('amfl-sort-control');
    const button = control && control.querySelector('.amfl-sort-button');
    const menu = sortMenuEl();
    if (!button || !menu) return;
    const options = [...menu.querySelectorAll('.amfl-sort-option')];
    if (!options.length) return;
    const current = options.findIndex((opt) => opt === document.activeElement);
    if (event.key === 'Escape') {
      if (!menu.hidden) {
        event.preventDefault();
        event.stopPropagation();
        closeSortMenu();
        button.focus();
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      if (menu.hidden) {
        placeSortMenu(button, menu);
        menu.hidden = false;
        button.setAttribute('aria-expanded', 'true');
      }
      let next = event.key === 'ArrowDown' ? current + 1 : current - 1;
      if (current < 0) next = event.key === 'ArrowDown' ? 0 : options.length - 1;
      if (next < 0) next = options.length - 1;
      if (next >= options.length) next = 0;
      options[next].focus();
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && current >= 0) {
      event.preventDefault();
      event.stopPropagation();
      applyPlaylistSort(options[current].dataset.value);
      closeSortMenu();
      button.focus();
    }
  }

  function ensureSortControl() {
    if (!onLocalPage()) {
      removeSortControl();
      return null;
    }
    const row = document.querySelector('[data-amfl-play-row]');
    if (!row || !row.parentElement) return null;
    let control = document.getElementById('amfl-sort-control');
    if (control && !control.querySelector('.amfl-sort-button')) {
      control.remove();
      control = null;
    }
    if (!control) {
      control = document.createElement('div');
      control.id = 'amfl-sort-control';
      control.className = 'amfl-sort-control';
      control.dataset.amflSortControl = '1';
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'amfl-sort';
      button.className = 'amfl-sort-button';
      button.setAttribute('aria-haspopup', 'listbox');
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-label', 'Sort playlist');
      const value = document.createElement('span');
      value.className = 'amfl-sort-value';
      const caret = document.createElement('span');
      caret.className = 'amfl-sort-caret';
      caret.setAttribute('aria-hidden', 'true');
      button.append(value, caret);
      const menu = document.createElement('div');
      menu.className = 'amfl-sort-menu';
      menu.setAttribute('role', 'listbox');
      menu.setAttribute('aria-label', 'Sort playlist');
      menu.hidden = true;
      SORT_OPTIONS.forEach(([val, label]) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'amfl-sort-option';
        option.setAttribute('role', 'option');
        option.dataset.value = val;
        option.textContent = label;
        menu.appendChild(option);
      });
      control.addEventListener('keydown', onSortKey);
      menu.addEventListener('keydown', onSortKey);
      menu.addEventListener('click', (event) => {
        const option = event.target.closest && event.target.closest('.amfl-sort-option');
        if (!option) return;
        event.preventDefault();
        event.stopPropagation();
        applyPlaylistSort(option.dataset.value);
        closeSortMenu();
        const sortButton = document.getElementById('amfl-sort');
        if (sortButton) sortButton.focus();
      });
      control.append(button, menu);
    }
    syncSortControl();
    const search = document.getElementById('amfl-search');
    if (search && search.parentElement === row) {
      if (control.nextElementSibling !== search) row.insertBefore(control, search);
    } else if (control.parentElement !== row || control !== row.lastElementChild) {
      row.appendChild(control);
    }
    placeLocalSearch(search);
    return control.querySelector('.amfl-sort-button');
  }

  function setControlEnabled(el, on) {
    if (!el) return;
    const nodes = [el];
    const inner = el.querySelector && el.querySelector('button, [role="button"]');
    if (inner && nodes.indexOf(inner) === -1) nodes.push(inner);
    const outer = el.closest && el.closest('button, [role="button"]');
    if (outer && nodes.indexOf(outer) === -1) nodes.push(outer);
    nodes.forEach((node) => {
      if (on) {
        node.disabled = false;
        node.removeAttribute('disabled');
        node.removeAttribute('aria-disabled');
        node.style.setProperty('pointer-events', 'auto', 'important');
        node.style.setProperty('opacity', '1', 'important');
        node.classList.remove('amfl-no-songs');
        node.classList.add('amfl-force-on');
        delete node.dataset.amflLocked;
      } else {
        node.dataset.amflLocked = '1';
        node.setAttribute('aria-disabled', 'true');
        if ('disabled' in node) node.disabled = true;
        node.classList.add('amfl-no-songs');
        node.classList.remove('amfl-force-on');
        node.style.removeProperty('pointer-events');
        node.style.removeProperty('opacity');
      }
    });
  }

  function paintLibraryControls() {
    const empty = files.length === 0;
    document.querySelectorAll('[data-amfl-wire="play"], [data-amfl-wire="shuffle"]').forEach((el) => {
      if (el.closest && el.closest('#amfl-player')) return;
      setControlEnabled(el, !empty);
    });
  }

  function runWired(kind) {
    if (kind === 'add') {
      openPicker();
      return;
    }
    if (!files.length) return;
    if (kind === 'shuffle') {
      player.shuffle = true;
      player.only = false;
      chrome.storage.local.set({ shuffle: true });
      playAll();
      return;
    }
    if (kind === 'play') {
      player.shuffle = false;
      player.only = false;
      chrome.storage.local.set({ shuffle: false });
      playAll();
    }
  }

  function actWired(el) {
    const kind = el && el.dataset.amflWire;
    if (!kind || !onLocalPage()) return;
    const now = Date.now();
    if (wiredStamp.key === kind && now - wiredStamp.at < 450) return;
    wiredStamp = { key: kind, at: now };
    runWired(kind);
  }

  function onWiredEvent(event) {
    const el = event.target && event.target.closest && event.target.closest('[data-amfl-wire]');
    if (!el || !onLocalPage()) return;
    if (event.button != null && event.button !== 0) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return;
    }
    event.stopPropagation();
    event.stopImmediatePropagation();
    // preventDefault on pointerdown cancels the click, and the file picker
    // only counts a click as the user gesture. Block Amazon here, open on click.
    if (event.type === 'click') {
      event.preventDefault();
      actWired(el);
    }
  }

  function onWiredKey(event) {
    if (event.repeat) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const el = event.target && event.target.closest && event.target.closest('[data-amfl-wire]');
    if (!el || !onLocalPage()) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    actWired(el);
  }

  let wiredListening = false;
  function ensureWiredListeners() {
    if (wiredListening) return;
    wiredListening = true;
    ['pointerdown', 'mousedown', 'click'].forEach((type) => {
      window.addEventListener(type, onWiredEvent, true);
    });
    window.addEventListener('keydown', onWiredKey, true);
  }

  function wireLocalControls() {
    ensureWiredListeners();
    const play = findPlayButton();
    const add = findAddButton();
    const shuffle = ensureShuffleControl(play);
    ensureSortControl();
    if (play) play.dataset.amflWire = 'play';
    if (add) add.dataset.amflWire = 'add';
    if (shuffle) shuffle.dataset.amflWire = 'shuffle';
    paintLibraryControls();
  }

  function clearWiredControls() {
    document.querySelectorAll('[data-amfl-wire], .amfl-force-on').forEach((el) => {
      el.classList.remove('amfl-no-songs');
      el.classList.remove('amfl-force-on');
      el.style.removeProperty('pointer-events');
      el.style.removeProperty('opacity');
      if ('disabled' in el) {
        el.disabled = false;
        el.removeAttribute('disabled');
      }
      delete el.dataset.amflLocked;
      el.removeAttribute('aria-disabled');
      if (!el.dataset.amflClone) delete el.dataset.amflWire;
    });
    document.querySelectorAll('[data-amfl-clone="shuffle"]').forEach((el) => el.remove());
  }

  function ensureFileInput() {
    if (typeof showOpenFilePicker === 'function') {
      const existing = document.getElementById('amfl-file');
      if (existing) existing.remove();
      return null;
    }
    let input = document.getElementById('amfl-file');
    if (!input) {
      input = document.createElement('input');
      input.id = 'amfl-file';
      input.className = 'amfl-file';
      input.type = 'file';
      input.multiple = true;
      input.accept = 'audio/*,.mp3,.m4a,.mp4,.flac,.wav,.ogg,.aac,.opus,.webm';
      input.addEventListener('change', onFileInput);
      document.documentElement.appendChild(input);
    }
    return input;
  }

  function trimPath(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function filePath(file, handle, pathHint) {
    const hinted = trimPath(pathHint);
    if (hinted) return hinted;
    const candidates = [
      file && file.path,
      file && file.webkitRelativePath,
      file && file.fullPath,
      handle && handle.path,
      handle && handle.fullPath,
      file && file.name
    ];
    for (const candidate of candidates) {
      const path = trimPath(candidate);
      if (path) return path;
    }
    return '';
  }

  function storedFilePath(file) {
    return trimPath(file && file.path) || trimPath(file && file.filename);
  }

  function pathAlreadyStored(path) {
    const wanted = trimPath(path);
    return !!wanted && files.some((file) => storedFilePath(file) === wanted);
  }

  function duplicateResult(path) {
    if (!path) return null;
    if (pathAlreadyStored(path) || pendingPaths.has(path)) {
      return { ok: false, duplicate: true, path: path };
    }
    return null;
  }

  function showDuplicateStatus(result) {
    return !!(result && result.duplicate);
  }

  function ensureAddControl() {
    ensureFileInput();
    if (document.querySelector('[data-amfl-wire="add"]')) {
      const dup = document.getElementById('amfl-add');
      if (dup) dup.remove();
      return;
    }
    const title = headerTitleEl();
    const buttons = headerButtons(title);
    if (!title || !buttons.length) {
      const stale = document.getElementById('amfl-add');
      if (stale) stale.remove();
      return;
    }
    const parent = buttons[0].parentElement;
    let button = document.getElementById('amfl-add');
    if (!button) {
      button = document.createElement('button');
      button.id = 'amfl-add';
      button.type = 'button';
      button.className = 'amfl-add';
      button.textContent = 'Add songs';
      button.addEventListener('click', onAddClick);
    }
    if (button.parentElement !== parent) parent.appendChild(button);
  }

  async function rememberFile(file, handle, presetId, pathHint) {
    const path = filePath(file, handle, pathHint);
    const duplicate = duplicateResult(path);
    if (duplicate) return duplicate;
    if (path) pendingPaths.add(path);
    try {
      const tags = await readTags(file);
      let duration = knownDuration(tags && tags.duration);
      if (!duration) duration = await probeDuration(file);
      const id = presetId || ((crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2));
      let persisted = false;
      let saveError = '';
    if (handle) {
      try {
        await idbPut(id, handle);
        persisted = true;
        sessionFiles.set(id, file);
      } catch (err) {
        saveError = 'Could not store the file handle.';
        handleCache.set(id, handle);
        sessionFiles.set(id, file);
      }
    } else {
      sessionFiles.set(id, file);
    }
      const entry = {
        id: id,
        filename: file.name,
        path: path,
        title: tags.title || stripExt(file.name),
        artist: tags.artist || '',
        persistent: persisted,
        saveError: saveError
      };
      if (duration > 0) entry.duration = duration;
      files.push(entry);
      await saveFiles();
      ensureCover(id, file);
      return { ok: true, id: id, path: path };
    } finally {
      if (path) pendingPaths.delete(path);
    }
  }

  function openPicker() {
    if (typeof showOpenFilePicker !== 'function') {
      const input = document.getElementById('amfl-file');
      if (input) input.click();
      return;
    }
    let pending;
    try {
      pending = showOpenFilePicker({
        multiple: true,
        types: [{
          description: 'Audio',
          accept: { 'audio/*': ['.mp3', '.m4a', '.mp4', '.flac', '.wav', '.ogg', '.aac', '.opus', '.webm'] }
        }]
      });
    } catch (err) {
      return;
    }
    pending.then(async (handles) => {
      let duplicate = false;
      for (const handle of handles) {
        const file = await handle.getFile();
        const result = await rememberFile(file, handle);
        duplicate = showDuplicateStatus(result) || duplicate;
      }
  
      paintTracks();
      paintLibraryControls();
    }).catch(() => {});
  }

  async function onAddClick(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    await openPicker();
  }

  async function onFileInput(event) {
    const picked = [...(event.target.files || [])];
    event.target.value = '';
    let duplicate = false;
    for (const file of picked) {
      const result = await rememberFile(file, null);
      duplicate = showDuplicateStatus(result) || duplicate;
    }

    paintTracks();
  }

  async function renameLocal(id, rawTitle) {
    const next = String(rawTitle || '').replace(/\s+/g, ' ').trim();
    const file = files.find((item) => item.id === id);
    const host = document.getElementById('amfl-tracks');
    if (!file || !next || file.title === next) {
      if (host) delete host.dataset.sig;
      paintTracks();
      return;
    }
    // Display name only. Path stays so dedupe still matches the same file,
    // and audio bytes are never written to chrome.storage.
    file.title = next;
    await saveFiles();
    if (host) delete host.dataset.sig;
    const queueList = document.querySelector('#amfl-player .amfl-queue-list');
    if (queueList) delete queueList.dataset.sig;
    paintTracks();
    paintPlayer();
  }

  function beginRename(id, row) {
    const file = files.find((item) => item.id === id);
    if (!file || !row || row.querySelector('.amfl-rename')) return;
    const titleEl = row.querySelector('.amfl-title');
    if (!titleEl) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'amfl-rename';
    input.value = file.title || stripExt(file.filename) || '';
    input.setAttribute('aria-label', 'Song name');
    input.maxLength = 200;
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let closed = false;
    const close = (save) => {
      if (closed) return;
      closed = true;
      input.removeEventListener('keydown', onKey);
      input.removeEventListener('blur', onBlur);
      if (save) renameLocal(id, input.value);
      else {
        const host = document.getElementById('amfl-tracks');
        if (host) delete host.dataset.sig;
        paintTracks();
      }
    };
    const onKey = (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        close(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close(false);
      }
    };
    const onBlur = () => close(true);
    input.addEventListener('keydown', onKey);
    input.addEventListener('blur', onBlur);
  }

  async function removePlaylistSongFromQueue(id) {
    // Playlist removal drops that song from the queue too. Queue-only songs
    // that are still in the playlist are left alone.
    while (player.queue.some((item) => item && item.id === id)) {
      const at = player.queue.findIndex((item) => item && item.id === id);
      if (at < 0) break;
      const before = player.queue.length;
      await removeFromQueue(at);
      if (!player.queue.length || player.queue.length >= before) break;
    }
  }

  async function removeLocal(id) {
    dropCover(id);
    sessionFiles.delete(id);
    try { await idbDelete(id); } catch (err) { /* ignore */ }
    files = files.filter((file) => file.id !== id);
    await saveFiles();
    await removePlaylistSongFromQueue(id);
    paintTracks();
  }

  function nativeTrackRows() {
    if (!onLocalPage()) return [];
    const title = headerTitleEl();
    const titleBottom = title ? title.getBoundingClientRect().bottom : 0;
    return [...document.querySelectorAll('[data-testid="ListItem"]')].filter((el) => {
      if (el.closest('#amfl-tracks, music-shoveler, music-horizontal-item')) return false;
      if (inQueueOrPlayer(el)) return false;
      if (!title) return true;
      const rect = el.getBoundingClientRect();
      return rect.bottom === 0 || rect.top >= titleBottom - 8;
    });
  }

  function suppressNativeRows(on) {
    if (!on || !onLocalPage()) {
      document.querySelectorAll('.amfl-suppressed').forEach((el) => el.classList.remove('amfl-suppressed'));
      return;
    }
    const rows = nativeTrackRows();
    const keep = new Set(rows);
    document.querySelectorAll('.amfl-suppressed').forEach((el) => {
      if (!keep.has(el)) el.classList.remove('amfl-suppressed');
    });
    rows.forEach((el) => {
      if (!el.classList.contains('amfl-suppressed')) el.classList.add('amfl-suppressed');
    });
  }

  function emptyMessageAnchor() {
    const add = document.querySelector('[data-amfl-wire="add"]') || document.getElementById('amfl-add');
    if (!add || !add.isConnected) return null;
    const title = headerTitleEl();
    const play = findPlayButton();
    const parent = add.parentElement;
    if (parent && (!title || !parent.contains(title)) && (!play || parent.contains(play))) return parent;
    return add;
  }

  function pinEmptyMessage() {
    if (!onLocalPage() || files.length) {
      const gone = document.getElementById('amfl-empty');
      if (gone) gone.remove();
      return;
    }
    if (document.getElementById('amfl-empty')) return;
    ensureNativeHideStyle();
    const anchor = emptyMessageAnchor();
    if (!anchor || !anchor.parentElement) return;
    const empty = document.createElement('div');
    empty.id = 'amfl-empty';
    empty.className = 'amfl-empty';
    empty.textContent = 'No local songs yet. Use Add songs.';
    anchor.insertAdjacentElement('afterend', empty);
  }

  function pinTrackList(host) {
    const anchor = emptyMessageAnchor();
    if (!anchor || !anchor.isConnected || !anchor.parentElement) return false;
    placeLocalSearch(document.getElementById('amfl-search'));
    if (anchor.nextElementSibling === host) return true;
    anchor.insertAdjacentElement('afterend', host);
    return true;
  }

  function headerCountLabel() {
    const count = files.length;
    const songs = count === 1 ? '1 SONG' : (count + ' SONGS');
    let seconds = 0;
    let known = false;
    files.forEach((file) => {
      const duration = knownDuration(file && file.duration);
      if (!duration) return;
      seconds += duration;
      known = true;
    });
    if (!known) return songs;
    const minsTotal = Math.round(seconds / 60);
    if (minsTotal <= 0) return songs;
    const hours = Math.floor(minsTotal / 60);
    const mins = minsTotal % 60;
    const time = hours > 0 ? (hours + ' hr ' + mins + ' min') : (mins + ' min');
    return songs + ' \u2022 ' + time;
  }

  function headerCountNodes(scope, marked, texts, depth) {
    if (!scope || depth > 6) return;
    const kids = scope.childNodes || [];
    for (let i = 0; i < kids.length; i += 1) {
      const child = kids[i];
      if (child.nodeType === 3) texts.push(child);
      else if (child.nodeType === 1) {
        if (child.dataset && child.dataset.amflSongCount === '1') marked.push(child);
        headerCountNodes(child, marked, texts, depth);
        if (child.shadowRoot) headerCountNodes(child.shadowRoot, marked, texts, depth + 1);
      }
    }
  }

  function paintHeaderSongCount() {
    const on = onLocalPage();
    const label = on ? headerCountLabel() : '';
    const marked = [];
    const texts = [];
    headerCountNodes(document.body, marked, on ? texts : [], 0);
    marked.forEach((el) => {
      const node = [...el.childNodes].find((child) => child.nodeType === 3 && (child.nodeValue || '').trim());
      if (!node) return;
      if (!on) {
        if (el.dataset.amflSongCountWas != null) node.nodeValue = el.dataset.amflSongCountWas;
        delete el.dataset.amflSongCount;
        delete el.dataset.amflSongCountWas;
        return;
      }
      if (node.nodeValue.trim() !== label) node.nodeValue = label;
    });
    if (!on) return;
    const title = headerTitleEl();
    const titleRect = title ? title.getBoundingClientRect() : null;
    texts.forEach((node) => {
      const parent = node.parentElement;
      const trimmed = (node.nodeValue || '').trim();
      if (!parent || parent.dataset.amflSongCount === '1' || !/^(?:public|private)$/i.test(trimmed)) return;
      if (parent.closest && parent.closest('#amfl-player, #amfl-tracks, #amfl-add, #amfl-sort-control')) return;
      let near = false;
      if (titleRect) {
        const rect = parent.getBoundingClientRect();
        near = rect.height > 0 && rect.top < titleRect.bottom + 240 && rect.bottom > titleRect.top - 80;
      } else if (parent.closest && parent.closest('[data-testid*="PageHeader" i], [data-testid*="Metadata" i]')) {
        near = true;
      }
      if (!near) return;
      parent.dataset.amflSongCount = '1';
      parent.dataset.amflSongCountWas = node.nodeValue;
      node.nodeValue = label;
    });
  }

  const durationMiss = new Set();
  let durationScan = null;

  function learnDurations() {
    if (durationScan) return durationScan;
    const pending = files.filter((file) => file && !knownDuration(file.duration) && sessionFiles.has(file.id) && !durationMiss.has(file.id));
    if (!pending.length) return Promise.resolve();
    durationScan = (async () => {
      let changed = false;
      for (const file of pending) {
        const seconds = await probeDuration(sessionFiles.get(file.id));
        if (seconds > 0) {
          file.duration = seconds;
          changed = true;
        } else {
          durationMiss.add(file.id);
        }
      }
      if (changed) await saveFiles();
      paintHeaderSongCount();
    })().finally(() => { durationScan = null; });
    return durationScan;
  }

  function paintTracks() {
    if (!onLocalPage()) {
      const old = document.getElementById('amfl-tracks');
      if (old) old.remove();
      const search = document.getElementById('amfl-search');
      if (search) search.remove();
      const empty = document.getElementById('amfl-empty');
      if (empty) empty.remove();
      suppressNativeRows(false);
      return;
    }
    suppressNativeRows(true);
    if (!files.length) {
      const old = document.getElementById('amfl-tracks');
      if (old) old.remove();
      const search = document.getElementById('amfl-search');
      if (search) search.remove();
      pinEmptyMessage();
      paintLibraryControls();
      return;
    }
    const emptyGone = document.getElementById('amfl-empty');
    if (emptyGone) emptyGone.remove();
    let host = document.getElementById('amfl-tracks');
    if (!host) {
      host = document.createElement('div');
      host.id = 'amfl-tracks';
      host.className = 'amfl-tracks';
    }
    ensureLocalSearch(host);
    if (!pinTrackList(host)) {
      paintLibraryControls();
      return;
    }
    const orderedFiles = playlistFilesInSortOrder();
    const sig = playlistSort + ':' + orderedFiles.map((file) => file.id + '\n' + (file.title || '') + (coverUrls.has(file.id) ? '*' : '') + (fileErrors.has(file.id) ? '!' : '')).join('|') + ':' + (player.active ? playingId() : '');
    const staleCount = host.querySelector('.amfl-count');
    if (staleCount) staleCount.remove();
    if (host.querySelector('[data-amfl-open-local]')) delete host.dataset.sig;
    if (host.dataset.sig === sig && host.childElementCount) {
      applyLocalSearchFilter();
      paintLibraryControls();
      return;
    }
    host.dataset.sig = sig;
    host.replaceChildren();
    orderedFiles.forEach((file, index) => {
      const name = file.title || file.filename;
      const row = document.createElement('div');
      row.className = 'amfl-row' + (player.active && playingId() === file.id ? ' is-current' : '') + (fileErrors.has(file.id) ? ' is-missing' : '');
      row.dataset.amflLocal = '1';
      row.dataset.id = file.id;
      const num = document.createElement('div');
      num.className = 'amfl-num';
      num.textContent = String(index + 1);
      const iconBtn = document.createElement('button');
      iconBtn.type = 'button';
      iconBtn.className = 'amfl-song-icon';
      iconBtn.dataset.act = 'play';
      iconBtn.setAttribute('aria-label', 'Play ' + name);
      const disc = document.createElement('span');
      disc.className = 'amfl-disc';
      const cover = coverUrls.get(file.id);
      if (cover) {
        disc.classList.add('amfl-cover');
        const img = document.createElement('img');
        img.alt = '';
        img.src = cover;
        disc.appendChild(img);
      } else {
        disc.innerHTML = icon('song');
        ensureCover(file.id);
      }
      const hint = document.createElement('span');
      hint.className = 'amfl-playhint';
      hint.innerHTML = icon('play');
      iconBtn.append(disc, hint);
      iconBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        // fileFor asks only when queryPermission is not already granted.
        toggleRowPlayback(file.id);
      });
      const text = document.createElement('div');
      const titleEl = document.createElement('div');
      titleEl.className = 'amfl-title';
      titleEl.textContent = name;
      const artistEl = document.createElement('div');
      artistEl.className = 'amfl-artist';
      if (fileErrors.get(file.id)) artistEl.textContent = fileErrors.get(file.id);
      else fillArtistOnly(artistEl, file.artist || file.filename || '');
      text.append(titleEl, artistEl);
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'amfl-iconbtn';
      editBtn.dataset.act = 'edit';
      editBtn.setAttribute('aria-label', 'Edit name for ' + name);
      editBtn.title = 'Edit name';
      editBtn.innerHTML = icon('edit');
      const queueBtn = document.createElement('button');
      queueBtn.type = 'button';
      queueBtn.className = 'amfl-iconbtn';
      queueBtn.dataset.act = 'queue';
      queueBtn.setAttribute('aria-label', 'Add ' + name + ' to queue');
      queueBtn.innerHTML = icon('queue');
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'amfl-iconbtn';
      deleteBtn.dataset.act = 'delete';
      deleteBtn.setAttribute('aria-label', 'Delete ' + name);
      deleteBtn.innerHTML = icon('trash');
      row.append(num, iconBtn, text, editBtn, queueBtn, deleteBtn);
      host.appendChild(row);
    });
    delete host.dataset.overlay;
    applyLocalSearchFilter();
    paintTrackOverlays();
    paintLibraryControls();
  }

  let localSearchQuery = '';

  function localSongHaystack(file, row) {
    const parts = [];
    if (file) {
      if (file.title) parts.push(file.title);
      if (file.artist) parts.push(file.artist);
      if (file.filename) parts.push(file.filename);
      parts.push(file.title || file.filename || '');
    }
    if (row) {
      const title = row.querySelector('.amfl-title');
      const artist = row.querySelector('.amfl-credit-artist');
      if (title) parts.push(title.textContent || '');
      if (artist) parts.push(artist.textContent || '');
    }
    return parts.join(' ').toLowerCase();
  }

  function applyLocalSearchFilter() {
    const host = document.getElementById('amfl-tracks');
    if (!host) return;
    const query = (localSearchQuery || '').trim().toLowerCase();
    host.querySelectorAll('.amfl-row').forEach((row) => {
      if (!query) {
        row.classList.remove('amfl-filter-hide');
        return;
      }
      const file = files.find((item) => item.id === row.dataset.id);
      const show = localSongHaystack(file, row).indexOf(query) !== -1;
      row.classList.toggle('amfl-filter-hide', !show);
    });
  }

  function ensureLocalSearch(host) {
    if (!onLocalPage() || !files.length) {
      const gone = document.getElementById('amfl-search');
      if (gone) gone.remove();
      return null;
    }
    let box = document.getElementById('amfl-search');
    if (!box) {
      box = document.createElement('div');
      box.id = 'amfl-search';
      box.className = 'amfl-search';
      box.dataset.amflMark = AMFL_MARK;
      const input = document.createElement('input');
      input.type = 'search';
      input.id = 'amfl-search-input';
      input.className = 'amfl-search-input';
      input.placeholder = 'Search local songs';
      input.setAttribute('aria-label', 'Search local songs');
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.value = localSearchQuery;
      input.addEventListener('input', () => {
        localSearchQuery = input.value || '';
        applyLocalSearchFilter();
      });
      const stop = (event) => {
        event.stopPropagation();
      };
      input.addEventListener('keydown', stop);
      input.addEventListener('keyup', stop);
      input.addEventListener('click', (event) => {
        event.stopPropagation();
      });
      box.appendChild(input);
    }
    placeLocalSearch(box);
    return box;
  }

  function placeLocalSearch(box) {
    if (!box || !onLocalPage()) return;
    const row = document.querySelector('[data-amfl-play-row]');
    if (!row) return;
    const sort = document.getElementById('amfl-sort-control');
    if (sort && sort.parentElement === row) {
      if (sort.nextElementSibling !== box) sort.insertAdjacentElement('afterend', box);
      return;
    }
    if (box.parentElement !== row) row.appendChild(box);
  }

  function paintTrackOverlays() {
    const host = document.getElementById('amfl-tracks');
    if (!host) return;
    const current = player.active ? playingId() : '';
    const playing = !!(current && !audio.paused && !audio.ended);
    const key = current + (playing ? ':1' : ':0');
    if (host.dataset.overlay === key) return;
    host.dataset.overlay = key;
    host.querySelectorAll('.amfl-row').forEach((row) => {
      const on = !!current && row.dataset.id === current;
      row.classList.toggle('is-current', on);
      row.classList.toggle('is-paused', on && !playing);
      const iconBtn = row.querySelector('.amfl-song-icon');
      if (!iconBtn) return;
      const hint = iconBtn.querySelector('.amfl-playhint');
      const titleEl = row.querySelector('.amfl-title');
      const name = (titleEl && titleEl.textContent) || '';
      const glyph = on && playing ? 'pause' : 'play';
      if (hint && hint.dataset.glyph !== glyph) {
        hint.dataset.glyph = glyph;
        hint.innerHTML = icon(glyph);
      }
      const label = (on && playing ? 'Pause ' : 'Play ') + name;
      if (iconBtn.getAttribute('aria-label') !== label) iconBtn.setAttribute('aria-label', label);
    });
  }

  function isHeaderTransport(target) {
    if (!onLocalPage()) return false;
    const btn = target.closest && target.closest('button, [role="button"]');
    if (!btn || btn.closest('#amfl-player, #amfl-tracks, [data-amfl-wire], [data-amfl-clone]') || btn.id === 'amfl-add') return false;
    if (btn.dataset.amflWire || inQueueOrPlayer(btn)) return false;
    const title = headerTitleEl();
    if (!title) return false;
    const rect = btn.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    if (rect.top > titleRect.bottom + 200 || rect.bottom < titleRect.top - 20) return false;
    const label = ((btn.getAttribute('aria-label') || '') + ' ' + (btn.getAttribute('data-testid') || '') + ' ' + (btn.textContent || '')).toLowerCase();
    return /\bplay\b|\bpause\b|shuffle|playpause|play_button/.test(label);
  }

  function onDocClick(event) {
    const localLabel = event.target.closest && event.target.closest('[data-amfl-open-local]');
    if (localLabel) {
      openLocalPlaylist(event);
      return;
    }
    const sortHit = event.target.closest && event.target.closest('#amfl-sort-control, [data-amfl-sort-control], .amfl-sort-menu');
    if (!sortHit) closeSortMenu();
    if (sortHit) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      onSortClick(event);
      return;
    }
    const wired = event.target.closest && event.target.closest('[data-amfl-wire]');
    if (wired && onLocalPage()) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      actWired(wired);
      return;
    }
    const add = event.target.closest && event.target.closest('#amfl-add');
    if (add) return;
    if (event.target.closest && event.target.closest('#amfl-tracks .amfl-rename')) return;
    const rowBtn = event.target.closest && event.target.closest('#amfl-tracks button');
    const rowHit = event.target.closest && event.target.closest('#amfl-tracks .amfl-row');
    if (rowBtn || rowHit) {
      event.preventDefault();
      event.stopPropagation();
      const row = (rowBtn && rowBtn.closest('.amfl-row')) || rowHit;
      const id = row && row.dataset.id;
      if (!id) return;
      const act = rowBtn && rowBtn.dataset.act;
      if (act === 'delete') removeLocal(id);
      else if (act === 'queue') addToQueue(id);
      else if (act === 'edit') beginRename(id, row);
      else if (act === 'play' && rowBtn.classList.contains('amfl-song-icon')) toggleRowPlayback(id);
      else playOnly(id);
      return;
    }
    const playerBtn = event.target.closest && event.target.closest('#amfl-player button');
    if (playerBtn) {
      event.preventDefault();
      event.stopPropagation();
      if (playerBtn.dataset.act === 'queueview') event.stopImmediatePropagation();
      onPlayerClick(event);
      return;
    }
    if (isHeaderTransport(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      if (!files.length) return;
      const label = ((event.target.closest('button, [role="button"]').getAttribute('aria-label') || '') + ' ' + (event.target.textContent || '')).toLowerCase();
      player.only = false;
      if (label.includes('shuffle')) {
        player.shuffle = true;
        chrome.storage.local.set({ shuffle: true });
      } else {
        player.shuffle = false;
        chrome.storage.local.set({ shuffle: false });
      }
      playAll();
      return;
    }
    const own = ownLocalAction(event);
    if (own) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      beginLocalTakeover();
      player.only = false;
      if (own === 'shuffle') {
        player.shuffle = true;
        chrome.storage.local.set({ shuffle: true });
      } else {
        player.shuffle = false;
        chrome.storage.local.set({ shuffle: false });
      }
      playAll();
      return;
    }
  }

  function eventElements(event) {
    if (!event) return [];
    if (typeof event.composedPath === 'function') {
      const path = event.composedPath().filter((node) => node && node.nodeType === 1);
      if (path.length) return path;
    }
    const nodes = [];
    let node = event.target && event.target.nodeType === 1 ? event.target : (event.nodeType === 1 ? event : null);
    let guard = 0;
    while (node && guard < 30) {
      nodes.push(node);
      if (node.parentElement) node = node.parentElement;
      else if (node.getRootNode && node.getRootNode().host) node = node.getRootNode().host;
      else node = null;
      guard += 1;
    }
    return nodes;
  }

  function isLocalToolbarNode(node) {
    if (!node || node.nodeType !== 1 || !onLocalPage()) return false;
    if (node.closest && node.closest('#amfl-tracks, #amfl-player, #amfl-add')) return false;
    const wire = node.dataset && node.dataset.amflWire;
    if (wire === 'play' || wire === 'shuffle') return true;
    const test = (node.getAttribute && node.getAttribute('data-testid')) || '';
    if (/toolbar_play_button|toolbar_pause_button|toolbar_shuffle/i.test(test)) return true;
    return isHeaderTransport(node);
  }

  // 'play' or 'shuffle' when the gesture is OUR playlist header control.
  // Empty for Amazon pages, song rows, and ordinary playlist links.
  function ownLocalAction(event) {
    if (!onLocalPage() || !event) return '';
    const nodes = eventElements(event);
    for (const node of nodes) {
      if (!node || node.nodeType !== 1) continue;
      if (node.id === 'amfl-tracks' || node.id === 'amfl-player' || node.id === 'amfl-add') return '';
      if (node.closest && node.closest('#amfl-tracks, #amfl-player, #amfl-add')) return '';
    }
    let action = '';
    for (const node of nodes) {
      if (!isLocalToolbarNode(node)) continue;
      const wire = node.dataset && node.dataset.amflWire;
      const test = (node.getAttribute && node.getAttribute('data-testid')) || '';
      const label = ((node.getAttribute && node.getAttribute('aria-label')) || '').toLowerCase();
      if (wire === 'shuffle' || /shuffle/i.test(test) || label.includes('shuffle')) return 'shuffle';
      action = 'play';
    }
    return action;
  }

  function overlayQueueButton() {
    const overlay = document.getElementById('amfl-player');
    if (!overlay || overlay.hidden) return null;
    return overlay.querySelector('[data-act="queueview"]');
  }

  function isAmazonBarQueueControl(el) {
    if (!el || !el.closest) return false;
    if (el.closest('#amfl-player, #amfl-tracks, #amfl-add')) return false;
    const btn = el.closest('button, [role="button"]');
    if (!btn) return false;
    const test = btn.getAttribute('data-testid') || '';
    const label = ((btn.getAttribute('aria-label') || '') + ' ' + (btn.getAttribute('title') || '')).replace(/\s+/g, ' ').trim().toLowerCase();
    if (/add|clear|remove|save/.test(label) || /add|clear|remove|save/i.test(test)) return false;
    const named = /^(?:(?:view|show|hide|open|close|play)\s+)?queue\b/.test(label);
    if (!named && !/queue/i.test(test)) return false;
    const rect = btn.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (rect.bottom < window.innerHeight - 200) return false;
    return true;
  }

  function blockAmazonBarQueue(on) {
    document.querySelectorAll('.amfl-amazon-queue-block').forEach((btn) => {
      if (!on || !isAmazonBarQueueControl(btn)) btn.classList.remove('amfl-amazon-queue-block');
    });
    if (!on) return;
    document.querySelectorAll('button, [role="button"]').forEach((btn) => {
      if (isAmazonBarQueueControl(btn)) btn.classList.add('amfl-amazon-queue-block');
    });
  }

  // Capture phase, before the event reaches Amazon's button. pointerdown
  // preventDefault also suppresses the click that React turns into "open queue".
  function takeLocalQueuePointer(event) {
    const target = event.target;
    if (!target || !target.closest) return false;
    const own = target.closest('#amfl-player [data-act="queueview"]');
    const foreign = !own && isAmazonBarQueueControl(target);
    if (!own && !foreign) return false;
    const btn = own || overlayQueueButton();
    if (!btn) return false;
    if (event.button != null && event.button !== 0) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return true;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (foreign) blockAmazonBarQueue(true);
    if (event.type === 'pointerdown' || event.type === 'click') onPlayerClick({ target: btn });
    return true;
  }

  function onWindowPointerDown(event) {
    const sortHit = event.target.closest && event.target.closest('#amfl-sort-control, [data-amfl-sort-control], .amfl-sort-menu');
    if (!sortHit) closeSortMenu();
    if (takeLocalQueuePointer(event)) return;
    if (event.button != null && event.button !== 0) return;
    // Extension playlist Play/Shuffle, a local song row, or our bar.
    // Playback starts on click. Arm the ignore window now so a pause echo
    // cannot hide our player. This listener does not decide Amazon handoff.
    const cardPlay = event.target && event.target.closest && event.target.closest('.amfl-card-play');
    if (cardPlay) {
      event.preventDefault();
      event.stopPropagation();
      beginLocalTakeover();
      onLocalCardPlay(event);
      return;
    }
    const localUi = event.target && event.target.closest && event.target.closest('[data-amfl-wire="play"], [data-amfl-wire="shuffle"], #amfl-tracks .amfl-row, #amfl-player, .amfl-card-play');
    if (localUi || ownLocalAction(event)) beginLocalTakeover();
  }

  function amazonPlayingMedia(event) {
    const nodes = [];
    if (event.target && event.target.nodeType === 1) nodes.push(event.target);
    if (typeof event.composedPath === 'function') {
      event.composedPath().forEach((node) => {
        if (node && node.nodeType === 1 && nodes.indexOf(node) === -1) nodes.push(node);
      });
    }
    for (const node of nodes) {
      if (node.tagName !== 'AUDIO' && node.tagName !== 'VIDEO') continue;
      if (node === audio || node.id === 'amfl-audio') return null;
      if (node.closest && node.closest('#amfl-player')) return null;
      if (node.paused || node.ended) continue;
      return node;
    }
    return null;
  }

  // Home and playlist track rows play through an anchor such as
  // /tracks/B089DNMYFB?do=play (data-testid TrackItem_Title or any other
  // anchor, including one inside an open shadow path). A playlist open
  // (/user-playlists/ or /playlists/ without do=play) does not match.
  function isTrackPlayHref(href) {
    const text = String(href || '');
    return text.includes('/tracks/') && text.includes('do=play');
  }

  function amazonTrackPlayClick(event) {
    if (!event || !player.active) return false;
    const nodes = eventElements(event);
    for (const node of nodes) {
      if (!node || node.nodeType !== 1) continue;
      if (node.closest && node.closest('#amfl-player, #amfl-tracks, #amfl-add')) return false;
      if (node.tagName !== 'A') continue;
      const href = (node.getAttribute && node.getAttribute('href')) || node.href || '';
      if (isTrackPlayHref(href)) return true;
    }
    return false;
  }

  // play/playing do not bubble and are not composed, so a document listener
  // never sees them when Amazon's media lives in a shadow root. composedPath
  // on that document listener is not a workaround. Listen on each open shadow
  // root (capture) and on media elements inside those roots.
  const shadowPlayRoots = new WeakSet();
  const shadowPlayMedia = new WeakSet();

  function bindShadowMedia(media) {
    if (!media || shadowPlayMedia.has(media)) return;
    if (media === audio || media.id === 'amfl-audio') return;
    if (media.closest && media.closest('#amfl-player')) return;
    const root = media.getRootNode && media.getRootNode();
    if (!root || root.nodeType !== 11) return;
    shadowPlayMedia.add(media);
    media.addEventListener('play', onMediaPlay);
    media.addEventListener('playing', onMediaPlay);
  }

  function bindShadowPlayRoot(root) {
    if (!root || root.nodeType !== 11 || shadowPlayRoots.has(root)) return;
    shadowPlayRoots.add(root);
    root.addEventListener('play', onMediaPlay, true);
    root.addEventListener('playing', onMediaPlay, true);
    let nodes = [];
    try { nodes = root.querySelectorAll('*'); } catch (err) { nodes = []; }
    nodes.forEach((el) => {
      if (!el || el.nodeType !== 1) return;
      if (el.tagName === 'AUDIO' || el.tagName === 'VIDEO') bindShadowMedia(el);
      if (el.shadowRoot) bindShadowPlayRoot(el.shadowRoot);
    });
    const obs = new MutationObserver((records) => {
      records.forEach((record) => {
        record.addedNodes.forEach((node) => noteNodeForShadowPlay(node));
      });
    });
    obs.observe(root, { childList: true, subtree: true });
  }

  function noteNodeForShadowPlay(node) {
    if (!node) return;
    if (node.nodeType === 11) {
      bindShadowPlayRoot(node);
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.shadowRoot) bindShadowPlayRoot(node.shadowRoot);
    if (node.tagName === 'AUDIO' || node.tagName === 'VIDEO') bindShadowMedia(node);
    if (!node.querySelectorAll) return;
    let nodes = [];
    try { nodes = node.querySelectorAll('*'); } catch (err) { nodes = []; }
    nodes.forEach((el) => {
      if (!el || el.nodeType !== 1) return;
      if (el.shadowRoot) bindShadowPlayRoot(el.shadowRoot);
      if (el.tagName === 'AUDIO' || el.tagName === 'VIDEO') bindShadowMedia(el);
    });
  }

  function scanOpenShadowPlay() {
    noteNodeForShadowPlay(document.documentElement);
  }

  // Handoff only when Amazon's own audio/video actually starts. Opening a
  // playlist or any other navigation never reaches here. Do not pause Amazon.
  function onMediaPlay(event) {
    if (!player.active) return;
    if (!amazonPlayingMedia(event)) return;
    if (silencingAmazon || Date.now() < localGestureUntil) return;
    handoffToAmazon();
  }

  function ensureNativeHideStyle() {
    let style = document.getElementById('amfl-native-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'amfl-native-style';
    }
    const css = [
      '.amfl-native-hidden{display:none !important}',
      '.amfl-card-play-hidden{display:none !important}',
      '.amfl-local-cover-hidden{display:none !important}',
      '.amfl-file-tile{position:relative !important}',
      '.amfl-file-tile > .amfl-file-cover{position:absolute;inset:0;z-index:5;display:flex;align-items:center;justify-content:center;pointer-events:none;background:#14191a;background-color:#14191a;border-radius:inherit}',
      '.amfl-file-cover svg{width:37.5%;height:37.5%;display:block;fill:rgba(255,255,255,.65)}',
      '#amfl-search.amfl-search{display:inline-flex !important;align-items:center !important;width:auto !important;flex:0 0 auto !important;margin:0 !important;padding:0 !important;box-sizing:border-box;visibility:visible !important;opacity:1 !important;pointer-events:auto !important}',
      '.amfl-search-input{appearance:none;width:220px;max-width:34vw;height:36px;margin:0;padding:0 16px;border:1px solid rgba(255,255,255,.18);border-radius:20px;background:#1c1c1c;color:#fff;box-shadow:none;font:14px/1.2 system-ui,sans-serif;outline:none}',
      '.amfl-search-input::placeholder{color:rgba(255,255,255,.55)}',
      '.amfl-search-input:hover{background:#252525}',
      '.amfl-search-input:focus{border-color:rgba(255,255,255,.5)}',
      '#amfl-tracks .amfl-row.amfl-filter-hide{display:none !important}',
      '.amfl-local-label{appearance:none;display:inline;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;line-height:inherit;cursor:pointer;text-decoration:none}',
      '.amfl-local-label:hover,.amfl-local-label:focus-visible{text-decoration:underline;outline:none}',
      'html body .amfl-card-play.amfl-card-play,html body .amfl-card-play.amfl-card-play:hover,html body .amfl-card-play.amfl-card-play.is-hot,html body .amfl-card-play.amfl-card-play.is-on{position:fixed !important;transform:translate(-50%,-50%) !important;z-index:2147483000 !important;width:80px;height:80px;margin:0;padding:0;border:2px solid #fff !important;border-color:#fff !important;border-radius:50%;clip-path:circle(50%);display:grid;place-items:center;background:transparent !important;background-color:transparent !important;background-image:none !important;color:#fff !important;box-shadow:none !important;filter:none !important;mix-blend-mode:normal !important;cursor:pointer}',
      'html body .amfl-card-play.amfl-card-play{opacity:0 !important;pointer-events:none !important}',
      'html body .amfl-card-play.amfl-card-play.is-hot,html body .amfl-card-play.amfl-card-play.is-on{opacity:1 !important;pointer-events:auto !important}',
      'html body .amfl-card-play.amfl-card-play::before{content:"";position:absolute;inset:0;border-radius:inherit;background:transparent !important;background-image:none !important;box-shadow:none !important;filter:none !important;z-index:0;pointer-events:none}',
      'html body .amfl-card-play.amfl-card-play:hover::before,html body .amfl-card-play.amfl-card-play.is-btn-hot::before{background:rgba(255,255,255,.22) !important}',
      '.amfl-lib-tile > .amfl-file-cover.amfl-btn-tint::after{content:"";position:absolute;inset:0;z-index:1;border-radius:inherit;background:rgba(0,0,0,0.4);pointer-events:none}',
      '[data-amfl-nav="1"] svg,[data-amfl-nav="1"] svg path{fill:none !important;stroke:#fff !important;color:#fff !important}',
      '#amfl-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:2147483001;max-width:min(560px,calc(100vw - 32px));margin:0;padding:12px 12px 12px 16px;border-radius:8px;background:#14191a;background-color:#14191a;-webkit-backdrop-filter:blur(30px);backdrop-filter:blur(30px);color:#fff;border:0;box-shadow:0 8px 24px rgba(0,0,0,.35);font:14px/1.4 system-ui,sans-serif;pointer-events:auto;display:flex;align-items:center;gap:12px}','#amfl-toast .amfl-toast-text{flex:1 1 auto;color:#fff}','#amfl-toast .amfl-toast-x{appearance:none;flex:0 0 auto;width:28px;height:28px;margin:0;padding:0;border:0;border-radius:6px;background:transparent;color:#fff;font:22px/1 system-ui,sans-serif;cursor:pointer}','#amfl-toast .amfl-toast-x:hover{background:rgba(255,255,255,.18)}','[data-amfl-nav="1"],[data-amfl-nav="1"] *{color:#fff !important}','[data-amfl-nav="1"] svg,[data-amfl-nav="1"] svg path{stroke:#fff !important;fill:none !important;color:#fff !important}',
      'html body .amfl-card-play.amfl-card-play svg,html body .amfl-card-play.amfl-card-play:hover svg{position:relative;z-index:1;width:36px;height:36px;display:block;fill:#fff !important;color:#fff !important;filter:none !important;opacity:1 !important;background:transparent !important}',
      'html body .amfl-card-play.amfl-card-play svg path,html body .amfl-card-play.amfl-card-play:hover svg path{fill:#fff !important;color:#fff !important;filter:none !important;opacity:1 !important}',
      '.amfl-no-songs{opacity:.38 !important;cursor:default !important;filter:grayscale(1) !important}',
      '.amfl-force-on{opacity:1 !important;pointer-events:auto !important;filter:none !important}',
      'body:has([data-amfl-wire="add"]) #amfl-add{display:none !important}',
      '#amfl-tracks .amfl-row{position:relative;z-index:0;background:transparent !important;grid-template-columns:32px 56px minmax(0,1fr) auto auto auto !important;min-height:72px;margin-left:0 !important}','#amfl-tracks .amfl-num{position:relative !important;left:-36px !important;z-index:2 !important;align-self:center !important;text-align:right !important;pointer-events:none !important}','#amfl-tracks .amfl-row::before{content:"";position:absolute;z-index:-1;left:var(--amfl-hover-left,0px);width:var(--amfl-hover-width,100%);top:0;bottom:0;border-radius:8px;pointer-events:none}','#amfl-tracks .amfl-row.is-current:not(:hover)::before{background:transparent !important}','#amfl-tracks .amfl-row:hover::before{background:rgba(255,255,255,.08) !important}',
      '.amfl-song-icon{position:relative;width:56px;height:56px;border:0;border-radius:4px;padding:0;margin-left:-16.5px !important;background:#252727;color:#fff;cursor:pointer;display:grid;place-items:center}', /* playlist row icons only: -16.5px */
      '.amfl-song-icon svg{width:25.2px;height:25.2px;display:block;fill:#fff;color:#fff}',
      '.amfl-iconbtn{display:inline-grid !important;place-items:center !important;padding:0 !important;line-height:0 !important;width:44.8px;height:44.8px;color:#fff}',
      '.amfl-iconbtn svg{width:25.2px;height:25.2px;display:block;margin:0 !important;fill:#fff;color:#fff}',
      '.amfl-song-icon{overflow:hidden}',
      '.amfl-song-icon .amfl-cover,.amfl-song-icon .amfl-cover img{width:56px;height:56px;object-fit:cover;display:block;border-radius:4px}',
      '.amfl-song-icon .amfl-playhint{display:none;position:absolute;inset:0;z-index:1;margin:0;border-radius:4px;background:rgba(0,0,0,.32);color:#fff;pointer-events:none}',
      '.amfl-song-icon .amfl-playhint svg{width:28px;height:28px;display:block;fill:#fff;color:#fff}',
      '.amfl-row:hover .amfl-song-icon .amfl-disc,.amfl-row.is-current .amfl-song-icon .amfl-disc,.amfl-song-icon:focus-visible .amfl-disc{filter:brightness(.7)}',
      '.amfl-row:hover .amfl-song-icon .amfl-playhint,.amfl-row.is-current .amfl-song-icon .amfl-playhint,.amfl-song-icon:focus-visible .amfl-playhint{display:grid;place-items:center}',
      '.amfl-disc{display:grid;place-items:center}',
      '.amfl-play-row{display:flex !important;flex-direction:row !important;flex-wrap:nowrap !important;align-items:center !important;justify-content:flex-start !important;gap:8px !important;width:max-content !important;max-width:none !important;overflow:visible !important}',
      '.amfl-sort-control{position:relative;display:inline-flex !important;align-items:center !important;visibility:visible !important;opacity:1 !important;pointer-events:auto !important}',
      '.amfl-sort-button{appearance:none !important;display:inline-flex !important;align-items:center !important;gap:8px !important;height:36px !important;min-height:36px !important;width:auto !important;margin:0 !important;padding:0 12px !important;border:1px solid rgba(255,255,255,.16) !important;border-radius:8px !important;background:#1c1c1c !important;color:#f5f5f5 !important;box-shadow:0 4px 16px rgba(0,0,0,.35) !important;font:14px/1.2 system-ui,sans-serif !important;cursor:pointer !important}',
      '.amfl-sort-button:hover{background:#252525 !important}',
      '.amfl-sort-menu{position:fixed;z-index:2147483000;margin:0;padding:4px;background:#181818;color:#fff;border:1px solid rgba(255,255,255,.12);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.45)}',
      '.amfl-sort-menu[hidden]{display:none !important}',
      '.amfl-sort-option{appearance:none !important;display:block !important;width:100% !important;height:auto !important;min-height:0 !important;margin:0 !important;padding:8px 12px !important;border:0 !important;border-radius:6px !important;background:transparent !important;color:#f5f5f5 !important;text-align:left !important;font:14px/1.2 system-ui,sans-serif !important;cursor:pointer !important}',
      '.amfl-sort-option:not(.is-selected){background:transparent !important;font-weight:400 !important}',
      '.amfl-sort-option:hover,.amfl-sort-option:focus-visible{background:rgba(255,255,255,.08) !important;outline:none}',
      '.amfl-sort-option:focus:not(.is-selected):not(:hover){background:transparent !important;font-weight:400 !important}',
      '.amfl-sort-option.is-selected,.amfl-sort-option.is-selected:hover,.amfl-sort-option.is-selected:focus,.amfl-sort-option.is-selected:focus-visible{background:rgba(255,255,255,.16) !important;font-weight:600 !important}',
      '.amfl-header-shuffle{display:inline-flex !important;align-items:center !important;justify-content:center !important;align-self:center !important;width:48px !important;height:48px !important;margin:0 !important;padding:0 !important;border:0 !important;border-radius:50% !important;background:transparent !important;color:#fff !important;cursor:pointer !important;flex:0 0 48px !important}',
      '.amfl-header-shuffle svg,.amfl-header-shuffle svg path{width:24px;height:24px;display:block;fill:#fff;color:#fff}',
      '[data-amfl-nav="1"].amfl-nav-active,[data-amfl-nav="1"].amfl-nav-active *{color:#25d1da !important}','[data-amfl-nav="1"].amfl-nav-active svg,[data-amfl-nav="1"].amfl-nav-active svg *{stroke:#25d1da !important;color:#25d1da !important;fill:none !important}',
      '#amfl-empty{flex:1 0 100%;display:block;width:100%;margin:12px 0 24px;padding:0 12px;font-family:AmazonEmber-Regular,system-ui,sans-serif}','.amfl-rename{width:100%;box-sizing:border-box;border:1px solid rgba(255,255,255,.45);background:rgba(0,0,0,.35);color:#fff;border-radius:6px;padding:4px 8px;font:inherit;font-weight:600}'
    ].join('');
    if (style.dataset.amflMark !== AMFL_MARK || style.textContent !== css) {
      style.dataset.amflMark = AMFL_MARK;
      style.textContent = css;
    }
    const parent = document.head || document.documentElement;
    if (style.parentNode !== parent || parent.lastElementChild !== style) parent.appendChild(style);
  }

  function clearNativePlaylistUi() {
    document.querySelectorAll('.amfl-native-hidden').forEach((el) => {
      el.classList.remove('amfl-native-hidden');
    });
  }

  function hideNativePlaylistUi(on) {
    if (!on || !onLocalPage()) {
      clearNativePlaylistUi();
      return;
    }
    ensureNativeHideStyle();
    const mark = (el) => {
      if (!el || el.classList.contains('amfl-native-hidden')) return;
      if (el.closest('#amfl-player, #amfl-tracks, #amfl-add, #amfl-sort-control, [data-amfl-sort-control], [data-amfl-clone]')) return;
      if (el.dataset && (el.dataset.amflWire || el.dataset.amflClone)) return;
      if (inQueueOrPlayer(el)) return;
      if (el.closest('[data-testid="IconButton,Toolbar_Play_Button"], [data-testid="ListItem,add-songs-button"], [data-amfl-wire], [data-amfl-clone]')) return;
      if (el.querySelector('[data-testid="IconButton,Toolbar_Play_Button"], [data-testid="ListItem,add-songs-button"], [data-amfl-wire], [data-amfl-clone]')) return;
      el.classList.add('amfl-native-hidden');
    };
    [
      'IconButton,Toolbar_Station_Button',
      'IconButton,Toolbar_Share_Button',
      'IconButton,Toolbar_Edit_Button',
      'IconButton,Toolbar_Remove_Button',
      'IconButton,Toolbar_Add_To_Queue_Button'
    ].forEach((test) => {
      document.querySelectorAll('[data-testid="' + test + '"]').forEach((btn) => {
        if (inQueueOrPlayer(btn)) return;
        const trigger = btn.closest('[data-testid="tooltip-trigger"]');
        const wrap = trigger && trigger.parentElement;
        if (wrap && !wrap.querySelector('#amfl-tracks, #amfl-add, #amfl-player, [data-testid="PageHeaderMetadata"]') && wrap.querySelectorAll('[data-testid*="Toolbar_"]').length === 1) {
          mark(wrap);
        } else {
          mark(trigger || btn);
        }
      });
    });
    document.querySelectorAll('[data-testid="Box,WidgetHeader"]').forEach((header) => {
      if (!/suggest/i.test(header.textContent || '')) return;
      const section = header.parentElement;
      if (section && section.querySelector('[data-testid="Carousel"]') && !section.querySelector('#amfl-tracks, #amfl-add, #amfl-player, [data-testid="PageHeaderMetadata_Headline"]')) {
        mark(section);
      } else {
        mark(header);
        const carousel = header.parentElement && header.parentElement.querySelector('[data-testid="Carousel"]');
        mark(carousel);
      }
    });
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const value = node.nodeValue && node.nodeValue.trim();
      if (value === "Let's add some songs") {
        const host = node.parentElement;
        if (host && !host.querySelector('#amfl-tracks, #amfl-add, #amfl-player, [data-testid="ListItem,add-songs-button"], [data-amfl-wire]') && !host.closest('#amfl-tracks, #amfl-add, #amfl-player, [data-testid="ListItem,add-songs-button"], [data-amfl-wire]') && !inQueueOrPlayer(host)) {
          mark(host);
        }
      } else if (value && /^suggestions$|^new suggestions$/i.test(value)) {
        let host = node.parentElement;
        for (let depth = 0; host && depth < 6; depth += 1) {
          if (host.id === 'amfl-tracks' || host.id === 'amfl-player') break;
          if (host.querySelector && host.querySelector('#amfl-tracks, #amfl-player, [data-testid="PageHeaderMetadata_Headline"]')) break;
          const test = (host.getAttribute && host.getAttribute('data-testid')) || '';
          const carousel = host.querySelector && host.querySelector('[data-testid="Carousel"], music-shoveler');
          if (carousel || /suggest/i.test(test)) {
            mark(host);
            break;
          }
          host = host.parentElement;
        }
      }
      node = walker.nextNode();
    }
    const title = headerTitleEl();
    if (title) {
      headerButtons(title).forEach((btn) => {
        if (btn.dataset.amflWire || btn.dataset.amflClone || btn.dataset.amflHeaderShuffle) return;
        if (btn.closest('[data-amfl-clone], [data-amfl-header-shuffle], [data-amfl-wire="play"], [data-amfl-wire="add"], [data-amfl-wire="shuffle"]')) return;
        const test = btn.getAttribute('data-testid') || '';
        const label = ((btn.getAttribute('aria-label') || '') + ' ' + (btn.getAttribute('title') || '') + ' ' + (btn.textContent || '') + ' ' + test).replace(/\s+/g, ' ').toLowerCase();
        if (/\bplay\b|\bpause\b|shuffle|add song/.test(label) || /toolbar_play|add-songs/i.test(test)) return;
        mark(controlShell(btn));
      });
    }
    document.querySelectorAll('music-shoveler, music-horizontal-item, [data-testid*="Shoveler" i], [data-testid*="Suggestion" i]').forEach((el) => {
      if (el.closest('#amfl-tracks, #amfl-player, #amfl-add')) return;
      mark(el);
    });
    document.querySelectorAll('button, a, [role="button"]').forEach((el) => {
      if (el.closest('#amfl-player, #amfl-tracks, #amfl-add, #amfl-sort-control, [data-amfl-sort-control], [data-amfl-wire], [data-amfl-clone]')) return;
      if (inQueueOrPlayer(el)) return;
      const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).replace(/\s+/g, ' ').trim().toLowerCase();
      if (!label || label.length > 80 || label.indexOf('suggestion') === -1) return;
      mark(el);
    });
  }

  function removeUi() {
    clearWiredControls();
    clearNativePlaylistUi();
    const tracks = document.getElementById('amfl-tracks');
    if (tracks) tracks.remove();
    const search = document.getElementById('amfl-search');
    if (search) search.remove();
    const emptyMsg = document.getElementById('amfl-empty');
    if (emptyMsg) emptyMsg.remove();
    const add = document.getElementById('amfl-add');
    if (add) add.remove();
    removeSortControl();
    const input = document.getElementById('amfl-file');
    if (input) input.remove();
    suppressNativeRows(false);
    if (!player.active) {
      const overlay = document.getElementById('amfl-player');
      if (overlay) overlay.hidden = true;
      restoreBar();
    }
  }

  function alignTrackIcons() {
    const host = document.getElementById('amfl-tracks');
    if (!host || !host.querySelector('.amfl-song-icon')) return;
    const add = document.querySelector('[data-amfl-wire="add"]') || document.getElementById('amfl-add');
    if (!add || !add.isConnected) return;
    const plus = add.querySelector('svg, [data-testid="Icon"]') || add;
    const plusRect = plus.getBoundingClientRect();
    if (plusRect.width < 2 || plusRect.height < 2) return;
    const songIcon = [...host.querySelectorAll('.amfl-row:not(.amfl-filter-hide) .amfl-song-icon')][0] || host.querySelector('.amfl-song-icon');
    // Nudge: CSS margin-left -16.5px on the playlist row icon only. Measure
    // without it so this helper does not cancel that pixel or shift titles.
    const nudge = parseFloat(getComputedStyle(songIcon).marginLeft) || 0;
    const iconLeft = songIcon.getBoundingClientRect().left - nudge;
    const delta = Math.round(plusRect.left - iconLeft);
    if (Math.abs(delta) < 1) return;
    const current = parseFloat(host.style.marginLeft) || 0;
    const next = current + delta;
    if (next < -160 || next > 320) return;
    host.style.marginLeft = next + 'px';
    alignRowHover();
  }

  function alignRowHover() {
    const host = document.getElementById('amfl-tracks');
    if (!host) return;
    const add = document.querySelector('[data-amfl-wire="add"]') || document.getElementById('amfl-add');
    if (!add || !add.isConnected) return;
    let box = add;
    let node = add;
    const hostRect = host.getBoundingClientRect();
    for (let i = 0; node && i < 6; i += 1) {
      const rect = node.getBoundingClientRect();
      if (rect.width >= 160 && rect.height >= 24 && rect.height <= 140) box = node;
      if (rect.width > hostRect.width + 140) break;
      node = node.parentElement;
    }
    const addRect = box.getBoundingClientRect();
    if (addRect.width < 40 || addRect.height < 8) return;
    const row = host.querySelector('.amfl-row') || host;
    const base = row.getBoundingClientRect();
    host.style.setProperty('--amfl-hover-left', Math.round(addRect.left - base.left) + 'px');
    host.style.setProperty('--amfl-hover-width', Math.round(addRect.width) + 'px');
    alignPlayerBar();
  }


  function eachPlaceholderAnchor(fn) {
    document.querySelectorAll('[data-amfl-renamed]').forEach((el) => fn(el));
    if (!storedId) return;
    document.querySelectorAll('a[href]').forEach((a) => {
      if (a.href.indexOf(storedId) !== -1 && /playlist/i.test(a.href)) fn(a);
    });
  }

  function cardShell(el) {
    let node = el;
    let best = null;
    for (let i = 0; node && i < 8; i += 1) {
      const rect = node.getBoundingClientRect();
      if (rect.width >= 72 && rect.width <= 440 && rect.height >= 72 && rect.height <= 560 && node.querySelector('img')) best = node;
      if (rect.width > 680 || rect.height > 860) break;
      node = node.parentElement;
    }
    return best;
  }

  function clearLibraryPlays() {
    document.querySelectorAll('[data-amfl-lib-play]').forEach((el) => el.remove());
    document.querySelectorAll('[data-amfl-placeholder-card]').forEach((el) => {
      delete el.dataset.amflPlaceholderCard;
    });
    document.querySelectorAll('.amfl-native-card-play').forEach((el) => el.classList.remove('amfl-native-card-play'));
    document.querySelectorAll('.amfl-lib-play').forEach((el) => el.remove());
  }

  function absoluteCenterWrap(node) {
    if (!node || node.nodeType !== 1) return false;
    const style = node.getAttribute('style') || '';
    if (/position\s*:\s*absolute/i.test(style) && /top\s*:\s*50%/i.test(style) && /left\s*:\s*50%/i.test(style)) return true;
    let computed = null;
    try { computed = getComputedStyle(node); } catch (err) { computed = null; }
    if (!computed || computed.position !== 'absolute') return false;
    return computed.top.indexOf('50%') !== -1 && computed.left.indexOf('50%') !== -1;
  }

  function hidePlaceholderHoverPlay() {
    ensureNativeHideStyle();
    eachPlaceholderAnchor((anchor) => {
      const card = cardShell(anchor);
      if (!card) return;
      card.querySelectorAll('button').forEach((btn) => {
        if (btn.hasAttribute('data-amfl-card-play')) return;
        const label = (btn.getAttribute('aria-label') || '').trim();
        if (label !== 'Play' && label !== 'Pause') return;
        const test = btn.getAttribute('data-testid') || '';
        if (test.indexOf('Toolbar_Play_Button') !== -1 || test.indexOf('Toolbar_Pause_Button') !== -1) return;
        if (btn.closest('#amfl-player, #amfl-tracks, [data-amfl-wire]')) return;
        if (!card.contains(btn)) return;
        let wrap = null;
        let node = btn;
        for (let i = 0; node && i < 6; i += 1) {
          if (node === card) break;
          if (absoluteCenterWrap(node)) {
            wrap = node;
            break;
          }
          node = node.parentElement;
        }
        const target = wrap || btn;
        if (target.closest('#amfl-player, #amfl-tracks, [data-amfl-wire]')) return;
        target.classList.add('amfl-card-play-hidden');
      });
    });
  }


  const FILE_COVER_ICON = '<svg viewBox="0 0 24 24" fill="rgba(255,255,255,0.65)" aria-hidden="true"><path d="M2.4 6.2A2.2 2.2 0 0 1 4.6 4h4.2l1.6 1.8h9a2.2 2.2 0 0 1 2.2 2.2v9.8a2.2 2.2 0 0 1-2.2 2.2H4.6a2.2 2.2 0 0 1-2.2-2.2V6.2z"/></svg>';

  function localCoverAnchors() {
    const out = [];
    const seen = new Set();
    const headerTiles = new Set(localPageCoverTiles());
    const headline = document.querySelector('[data-testid="PageHeaderMetadata_Headline"]');
    document.querySelectorAll('a[href*="playlist"]').forEach((anchor) => {
      if (seen.has(anchor) || anchor.closest('#amfl-player, #amfl-tracks, #amfl-add')) return;
      if (headline && anchor.contains(headline)) return;
      const headerTile = anchor.querySelector('[data-testid="Tile,VerticalItem_Tile"]');
      if (headerTile && headerTiles.has(headerTile)) return;
      const label = ((anchor.getAttribute('aria-label') || '').replace(/\s+/g, ' ')).trim();
      const ours = label === PLACEHOLDER || label === ('Navigate to ' + PLACEHOLDER) || (storedId && anchor.href.indexOf(storedId) !== -1 && anchor.querySelector('[data-testid="Tile,VerticalItem_Tile"], [data-testid="PlaceholderArt"]'));
      if (!ours) return;
      if (!anchor.querySelector('[data-testid="Tile,VerticalItem_Tile"], [data-testid="Tile_ImageBackground"], [data-testid="PlaceholderArt"], img')) return;
      seen.add(anchor);
      out.push(anchor);
    });
    return out;
  }

  function localPageCoverTiles() {
    if (!onLocalPage()) return [];
    const headline = document.querySelector('[data-testid="PageHeaderMetadata_Headline"]') || headerTitleEl();
    const hr = headline ? headline.getBoundingClientRect() : null;
    const out = [];
    document.querySelectorAll('[data-testid="Tile,VerticalItem_Tile"]').forEach((tile) => {
      if (tile.closest('#amfl-player, #amfl-tracks, [data-testid="Carousel"]')) return;
      const rect = tile.getBoundingClientRect();
      if (rect.width < 160 || rect.width > 360 || rect.height < 120) return;
      if (hr && hr.width > 0 && hr.height > 0) {
        const nearTitle = rect.bottom > hr.top - 180 && rect.top < hr.bottom + 120;
        const leftOfTitle = rect.left < hr.left + 8;
        if (!nearTitle || !leftOfTitle) return;
      } else if (tile.closest('a[href*="playlist"]')) {
        return;
      }
      out.push(tile);
    });
    return out;
  }

  function paintLocalFileCover() {
    ensureNativeHideStyle();
    const tiles = new Set();
    localCoverAnchors().forEach((anchor) => {
      const tile = anchor.querySelector('[data-testid="Tile,VerticalItem_Tile"]') || anchor;
      tiles.add(tile);
      tile.classList.add('amfl-file-tile', 'amfl-lib-tile');
      tile.querySelectorAll('[data-testid="Tile_ImageBackground"], [data-testid="PlaceholderArt"], [data-testid="ImageDimensionWrapper"], img').forEach((el) => {
        if (el.closest('.amfl-file-cover')) return;
        el.classList.add('amfl-local-cover-hidden');
      });
      if (!tile.querySelector(':scope > .amfl-file-cover')) {
        const cover = document.createElement('div');
        cover.className = 'amfl-file-cover';
        cover.setAttribute('aria-hidden', 'true');
        cover.innerHTML = FILE_COVER_ICON;
        tile.appendChild(cover);
      }
    });
    localPageCoverTiles().forEach((tile) => {
      tiles.add(tile);
      tile.classList.add('amfl-file-tile');
      tile.classList.remove('amfl-lib-tile', 'amfl-cover-hot', 'amfl-hold-tint');
      tile.dataset.amflNoPlay = '1';
      tile.querySelectorAll('[data-testid="Tile_ImageBackground"], [data-testid="PlaceholderArt"], [data-testid="ImageDimensionWrapper"], img').forEach((el) => {
        if (el.closest('.amfl-file-cover')) return;
        el.classList.add('amfl-local-cover-hidden');
      });
      if (!tile.querySelector(':scope > .amfl-file-cover')) {
        const cover = document.createElement('div');
        cover.className = 'amfl-file-cover';
        cover.setAttribute('aria-hidden', 'true');
        cover.innerHTML = FILE_COVER_ICON;
        tile.appendChild(cover);
      }
    });
    releaseStaleAmazonTint();
    document.querySelectorAll('.amfl-file-cover').forEach((cover) => {
      const tile = cover.parentElement;
      if (tile && tiles.has(tile)) return;
      if (tile) {
        tile.classList.remove('amfl-file-tile', 'amfl-lib-tile', 'amfl-cover-hot', 'amfl-hold-tint');
        tile.querySelectorAll('.amfl-btn-tint').forEach((el) => el.classList.remove('amfl-btn-tint'));
        tile.querySelectorAll('.amfl-local-cover-hidden').forEach((el) => el.classList.remove('amfl-local-cover-hidden'));
      }
      cover.remove();
    });
  }

  function paintLibraryPlaceholder() {
    // Other library cards keep Amazon's hover play. Our tile gets its own button.
    clearLibraryPlays();
  }

  let cardPlayAt = 0;

  let cardPlayPtr = 0;

  function onLocalCardPlay(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.button != null && event.button !== 0) return;
    // pointerdown preventDefault can swallow the click. Act on pointerdown,
    // and let that click through only as a navigation block.
    if (event.type === 'click' && Date.now() - cardPlayPtr < 800) return;
    if (event.type === 'pointerdown') cardPlayPtr = Date.now();
    const now = Date.now();
    if (now - cardPlayAt < 280) return;
    cardPlayAt = now;
    toggleLocalCardPlay();
  }

  async function toggleLocalCardPlay() {
    if (isLocallyPlaying()) {
      try { audio.pause(); } catch (err) { /* ignore */ }
      syncAmazonChrome();
      paintPlayer();
      paintLocalCardPlay();
      return;
    }
    if (player.active && (audio.currentSrc || audio.src) && (audio.paused || audio.ended)) {
      player.active = true;
      beginLocalTakeover();
      silenceAmazon(true);
      armSilence();
      applyAmazonVolume();
      try { await audio.play(); } catch (err) { /* ignore */ }
      syncAmazonChrome();
      paintPlayer();
      paintLocalCardPlay();
      return;
    }
    if (!files.length) await loadMeta();
    await playAll();
    paintLocalCardPlay();
  }

  function releaseStaleAmazonTint() {
    const props = ['background', 'background-color', 'background-image', 'box-shadow', 'filter', 'opacity', 'visibility', 'pointer-events'];
    const wipe = (el) => {
      if (!el || el.nodeType !== 1) return;
      if (el.classList.contains('amfl-card-play') || el.hasAttribute('data-amfl-card-play')) return;
      props.forEach((name) => el.style.removeProperty(name));
      el.classList.remove('amfl-amazon-scrim', 'amfl-amazon-scrim-host', 'amfl-cover-hot', 'amfl-hold-tint');
    };
    const stamped = (el) => el && el.style && el.style.getPropertyPriority('background') === 'important'
      && el.style.getPropertyValue('background-image') === 'none'
      && el.style.getPropertyValue('filter') === 'none'
      && el.style.getPropertyValue('box-shadow') === 'none';
    document.querySelectorAll('.amfl-amazon-scrim, .amfl-amazon-scrim-host').forEach(wipe);
    document.querySelectorAll('.amfl-file-tile, .amfl-lib-tile').forEach((tile) => {
      tile.classList.remove('amfl-cover-hot', 'amfl-hold-tint');
      if (stamped(tile)) props.forEach((name) => tile.style.removeProperty(name));
      tile.querySelectorAll('*').forEach((el) => {
        if (el.classList.contains('amfl-file-cover') || (el.closest && el.closest('.amfl-file-cover'))) return;
        el.classList.remove('amfl-amazon-scrim', 'amfl-cover-hot', 'amfl-hold-tint');
        if (stamped(el)) props.forEach((name) => el.style.removeProperty(name));
      });
      const cover = tile.querySelector(':scope > .amfl-file-cover');
      if (cover && cover.style.getPropertyPriority('background') === 'important') {
        props.forEach((name) => cover.style.removeProperty(name));
      }
      const parent = tile.parentElement;
      if (parent && parent.classList.contains('amfl-amazon-scrim-host')) wipe(parent);
    });
  }

  const cardButtons = new Map();

  let coverPtr = null;
  let coverHoverListening = false;

  function rectContainsPoint(rect, x, y, pad) {
    if (!rect || rect.width < 2 || rect.height < 2) return false;
    return x >= rect.left - pad && y >= rect.top - pad && x <= rect.right + pad && y <= rect.bottom + pad;
  }

  function pointInCircle(rect, x, y) {
    if (!rect || rect.width < 2 || rect.height < 2) return false;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const radius = Math.min(rect.width, rect.height) / 2;
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  }

  function eventOverButton(btn, event) {
    if (!btn || btn.hidden) return false;
    const rel = event && event.relatedTarget;
    if (rel && (rel === btn || (btn.contains && btn.contains(rel)))) {
      const x = event.clientX;
      const y = event.clientY;
      if (x == null || y == null) return true;
      return pointInCircle(btn.getBoundingClientRect(), x, y);
    }
    const x = event && event.clientX;
    const y = event && event.clientY;
    if (x == null || y == null) return false;
    return pointInCircle(btn.getBoundingClientRect(), x, y);
  }

  function bindCoverPointer(tile, btn) {
    if (!tile || !tile.classList.contains('amfl-lib-tile') || tile.dataset.amflNoPlay === '1') return;
    if (btn && btn.dataset.amflHoverBound !== '1') {
      btn.dataset.amflHoverBound = '1';
      const enter = (event) => {
        if (event.clientX != null) coverPtr = { x: event.clientX, y: event.clientY };
        btn.classList.add('is-hot');
      };
      btn.addEventListener('pointerenter', enter);
      btn.addEventListener('pointerleave', (event) => {
        if (event.clientX != null) coverPtr = { x: event.clientX, y: event.clientY };
        syncCoverHover();
      });
    }
    if (tile && tile.dataset.amflHoverBound !== '1') {
      tile.dataset.amflHoverBound = '1';
      tile.addEventListener('pointerenter', (event) => {
        if (event.clientX != null) coverPtr = { x: event.clientX, y: event.clientY };
        const live = cardButtons.get(tile);
        if (live) live.classList.add('is-hot');
      });
      tile.addEventListener('pointerleave', (event) => {
        const live = cardButtons.get(tile);
        if (event.clientX != null) coverPtr = { x: event.clientX, y: event.clientY };
        if (eventOverButton(live, event)) {
          if (live) live.classList.add('is-hot');
          return;
        }
        syncCoverHover();
      });
    }
  }

  function syncCoverHover() {
    const x = coverPtr ? coverPtr.x : -100000;
    const y = coverPtr ? coverPtr.y : -100000;
    document.querySelectorAll('.amfl-lib-tile').forEach((tile) => {
      if (tile.dataset.amflNoPlay === '1') return;
      const tileRect = tile.getBoundingClientRect();
      const btn = cardButtons.get(tile);
      const overBtn = !!(btn && !btn.hidden && pointInCircle(btn.getBoundingClientRect(), x, y));
      const overTile = rectContainsPoint(tileRect, x, y, 2);
      const on = overTile || overBtn;
      if (btn) {
        btn.classList.toggle('is-hot', on);
        btn.classList.toggle('is-btn-hot', overBtn);
      }
      const cover = tile.classList.contains('amfl-lib-tile') ? tile.querySelector(':scope > .amfl-file-cover') : null;
      if (cover) cover.classList.toggle('amfl-btn-tint', overBtn);
    });
  }

  function ensureCoverHover() {
    if (coverHoverListening) return;
    coverHoverListening = true;
    const track = (event) => {
      if (!event || event.clientX == null || event.clientY == null) return;
      coverPtr = { x: event.clientX, y: event.clientY };
      syncCoverHover();
    };
    window.addEventListener('pointermove', track, true);
    window.addEventListener('pointerover', track, true);
    window.addEventListener('pointerdown', track, true);
    document.documentElement.addEventListener('pointerleave', (event) => {
      if (event.relatedTarget) return;
      coverPtr = null;
      syncCoverHover();
    }, true);
  }

  function paintLocalCardPlay() {
    const playing = isLocallyPlaying();
    const name = playing ? 'pause' : 'play';
    const label = playing ? 'Pause' : 'Play';
    const live = new Set();
    document.querySelectorAll('.amfl-lib-tile').forEach((tile) => {
      if (tile.dataset.amflNoPlay === '1') return;
      live.add(tile);
      let btn = cardButtons.get(tile);
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'amfl-card-play';
        btn.setAttribute('data-amfl-card-play', '1');
        btn.addEventListener('pointerdown', onLocalCardPlay);
        btn.addEventListener('click', onLocalCardPlay);
        document.body.appendChild(btn);
        cardButtons.set(tile, btn);
        ensureCoverHover();
      }
      bindCoverPointer(tile, btn);
      const rect = tile.getBoundingClientRect();
      btn.style.left = (rect.left + rect.width / 2) + 'px';
      btn.style.top = (rect.top + rect.height / 2) + 'px';
      btn.hidden = rect.width < 20 || rect.bottom < 0 || rect.top > window.innerHeight;
      btn.classList.remove('amfl-card-play-hidden');
      btn.classList.toggle('is-on', playing);
      btn.setAttribute('aria-label', label);
      setBtnIcon(btn, name);
    });
    ensureCoverHover();
    syncCoverHover();
    cardButtons.forEach((btn, tile) => {
      if (live.has(tile) && tile.isConnected) return;
      btn.remove();
      cardButtons.delete(tile);
    });
  }

  function paintPlaceholderChrome() {
    clearLibraryPlays();
    hidePlaceholderHoverPlay();
    paintLocalFileCover();
    paintLocalCardPlay();
  }

  function takePermitFiles(payload) {
    if (!payload) return;
    (payload.files || []).forEach((item) => {
      if (!item || !item.id || !item.file) return;
      sessionFiles.set(item.id, item.file);
      fileErrors.delete(item.id);
      ensureCover(item.id, item.file);
    });
    (payload.missing || []).forEach((id) => {
      if (!sessionFiles.has(id)) fileErrors.set(id, MISSING_FILE);
    });
    (payload.stillPrompt || []).forEach((id) => {
      if (!sessionFiles.has(id)) fileErrors.set(id, 'Click the song to allow access.');
    });
    const host = document.getElementById('amfl-tracks');
    if (host) delete host.dataset.sig;
    if (onLocalPage()) paintTracks();
  }

  let permitAllStarted = false;

  function maybePromptSavedHandles() {
    if (!onLocalPage() || permitAllStarted) return;
    const ids = files.filter((file) => file && file.persistent && !sessionFiles.has(file.id)).map((file) => file.id);
    if (!ids.length) return;
    permitAllStarted = true;
    pageSend({ type: 'permit-all', ids: ids }, 180000).then((result) => {
      if (result) takePermitFiles(result);
    });
  }

  function apply() {
    const live = engaged();
    setObserver(live);
    if (!live) {
      removeUi();
      return;
    }
    if (domHasPlaceholder() || document.querySelector('[data-amfl-renamed]')) renameAnchors();
    else hideLocalFromAddPlaylist();
    if (onLocalPage()) {
      renameAnchors();
      wireLocalControls();
      ensureAddControl();

      paintTracks();
      paintHeaderSongCount();
      learnDurations();
      hideNativePlaylistUi(true);
      paintLibraryControls();
      alignTrackIcons();
      maybePromptSavedHandles();
      sweepAmazonTracks();
    } else {
      const add = document.getElementById('amfl-add');
      if (add) add.remove();
      const input = document.getElementById('amfl-file');
      if (input) input.remove();
      const tracks = document.getElementById('amfl-tracks');
      if (tracks) tracks.remove();
      removeSortControl();
      const emptyMsg = document.getElementById('amfl-empty');
      if (emptyMsg) emptyMsg.remove();
      suppressNativeRows(false);
      clearNativePlaylistUi();
      clearWiredControls();
      paintHeaderSongCount();
    }
    paintPlaceholderChrome();
    ensureLocalNav();
    if (player.active) {
      syncAmazonChrome();
      paintPlayer();
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      apply();
    });
  }

  function setObserver(on) {
    if (on) {
      if (observer) return;
      observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      return;
    }
    if (!observer) return;
    observer.disconnect();
    observer = null;
  }

  function onLibraryPage() {
    // The local playlist is not the library, even when Library's tab stays current.
    if (onLocalPage()) return false;
    const path = (location.pathname || '') + (location.search || '');
    if (/(^|\/)library(\/|$)/i.test(path)) return true;
    if (/(^|\/)my-library(\/|$)/i.test(path)) return true;
    const tabs = [];
    collectDeep('[data-testid="TopNavBar_LibraryTab"]', document.documentElement, tabs, 0, 16);
    return tabs.some((el) => {
      if (!el || !el.getAttribute) return false;
      const current = (el.getAttribute('aria-current') || '').toLowerCase();
      const selected = (el.getAttribute('aria-selected') || '').toLowerCase();
      const pressed = (el.getAttribute('aria-pressed') || '').toLowerCase();
      if (current && current !== 'false') return true;
      if (selected === 'true' || pressed === 'true') return true;
      return false;
    });
  }

  const LIBRARY_REFRESH_KEY = 'amflPendingLibraryRefresh';
  let createdThisDocument = false;
  let leftLibrarySinceLoad = false;
  let libraryReloadSent = false;
  let libraryReadySince = 0;

  function libraryFinishedLoading() {
    if (document.readyState !== 'complete') return false;
    const tiles = [];
    collectDeep('[data-testid="Tile,VerticalItem_Tile"]', document.documentElement, tiles, 0, 14);
    const painted = tiles.some((el) => {
      if (!el || (el.closest && el.closest('#amfl-player, [data-amfl-nav]'))) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 40 && rect.height > 40 && rect.bottom > 80 && rect.top < window.innerHeight;
    });
    if (!painted) return false;
    if (!libraryReadySince) libraryReadySince = Date.now();
    return Date.now() - libraryReadySince >= 400;
  }

  function maybeHardLibraryRefresh() {
    if (libraryReloadSent || pageGoingAway) return;
    // Opening Local must not consume amflPendingLibraryRefresh. onLocalPage
    // is not the library screen. Leaving the flag set is the whole point.
    if (onLocalPage()) {
      leftLibrarySinceLoad = true;
      libraryReadySince = 0;
      return;
    }
    if (!onLibraryPage()) {
      leftLibrarySinceLoad = true;
      libraryReadySince = 0;
      return;
    }
    if (!libraryFinishedLoading()) return;
    // First entry after a real create. Skip the page we are already on
    // when this document created the playlist. Retry later if audio is playing.
    if (createdThisDocument && !leftLibrarySinceLoad) return;
    if (isLocallyPlaying()) return;
    chrome.storage.local.get(LIBRARY_REFRESH_KEY, (data) => {
      const pending = !!(data && data[LIBRARY_REFRESH_KEY]);
      if (!pending || libraryReloadSent || pageGoingAway) return;
      if (onLocalPage() || !onLibraryPage() || isLocallyPlaying() || !libraryFinishedLoading()) return;
      if (createdThisDocument && !leftLibrarySinceLoad) return;
      libraryReloadSent = true;
      chrome.storage.local.remove(LIBRARY_REFRESH_KEY, () => {
        chrome.runtime.sendMessage({ type: 'amfl-hard-reload' });
      });
    });
  }

  let createdToastTimer = 0;

  function dismissCreatedToast() {
    if (createdToastTimer) {
      window.clearTimeout(createdToastTimer);
      createdToastTimer = 0;
    }
    const live = document.getElementById('amfl-toast');
    if (live) live.remove();
  }

  function showCreatedToast() {
    ensureNativeHideStyle();
    let toast = document.getElementById('amfl-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'amfl-toast';
      toast.setAttribute('role', 'status');
      const text = document.createElement('span');
      text.className = 'amfl-toast-text';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'amfl-toast-x';
      close.setAttribute('aria-label', 'Dismiss');
      close.textContent = '\u00d7';
      close.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        dismissCreatedToast();
      });
      toast.appendChild(text);
      toast.appendChild(close);
      document.documentElement.appendChild(toast);
    }
    const text = toast.querySelector('.amfl-toast-text');
    if (text) text.textContent = 'Local playlist created. Check the library and refresh if it is not there.';
    toast.hidden = false;
    if (createdToastTimer) window.clearTimeout(createdToastTimer);
    createdToastTimer = window.setTimeout(dismissCreatedToast, 6000);
  }

  const NAV_LABELS = /^(home|podcasts|library|find|search)$/i;
  const NAV_FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path fill="none" stroke="#fff" d="M2.4 6.2A2.2 2.2 0 0 1 4.6 4h4.2l1.6 1.8h9a2.2 2.2 0 0 1 2.2 2.2v9.8a2.2 2.2 0 0 1-2.2 2.2H4.6a2.2 2.2 0 0 1-2.2-2.2V6.2z"/></svg>';

  function eachShadowElement(visit) {
    const stack = [document];
    let seen = 0;
    while (stack.length && seen < 8000) {
      const root = stack.pop();
      if (!root || !root.querySelectorAll) continue;
      const list = root.querySelectorAll('*');
      for (let i = 0; i < list.length; i += 1) {
        seen += 1;
        const el = list[i];
        visit(el);
        if (el.shadowRoot) stack.push(el.shadowRoot);
        if (seen >= 8000) break;
      }
    }
  }

  function navLabelOf(el) {
    if (!el || (el.closest && el.closest('#amfl-player, #amfl-tracks, #amfl-add, [data-amfl-nav]'))) return '';
    const aria = ((el.getAttribute('aria-label') || '').replace(/\s+/g, ' ')).trim();
    if (NAV_LABELS.test(aria)) return aria;
    let own = '';
    el.childNodes.forEach((node) => {
      if (node.nodeType === 3) own += node.nodeValue;
    });
    own = own.replace(/\s+/g, ' ').trim();
    if (NAV_LABELS.test(own)) return own;
    const text = ((el.textContent || '').replace(/\s+/g, ' ')).trim();
    if (NAV_LABELS.test(text)) return text;
    return '';
  }

  function findNavSamples() {
    const hits = [];
    eachShadowElement((el) => {
      if (el.getAttribute && el.getAttribute('data-amfl-nav') === '1') return;
      const label = navLabelOf(el);
      if (!label) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8 || rect.width > 420 || rect.height > 160) return;
      hits.push({ el: el, label: label });
    });
    return hits.filter((hit) => !hits.some((other) => other.el !== hit.el && hit.el.contains(other.el)));
  }

  function matchNavCase(sample) {
    const raw = String(sample || '').trim();
    if (raw && raw === raw.toUpperCase()) return 'LOCAL';
    if (raw && raw === raw.toLowerCase()) return 'local';
    return 'Local';
  }

  function applyNavLabel(item, label) {
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    const texts = [];
    let node = walker.nextNode();
    while (node) {
      if (node.nodeValue && node.nodeValue.trim()) texts.push(node);
      node = walker.nextNode();
    }
    if (!texts.length) item.appendChild(document.createTextNode(label));
    else {
      texts[texts.length - 1].nodeValue = label;
      texts.slice(0, -1).forEach((textNode) => {
        if (textNode.nodeValue.trim().length < 24) textNode.nodeValue = '';
      });
    }
    item.setAttribute('aria-label', label);
    if (item.hasAttribute('title')) item.setAttribute('title', label);
  }

  function replaceNavIcon(item) {
    const holder = document.createElement('div');
    holder.innerHTML = NAV_FOLDER;
    const svg = holder.firstChild;
    const old = item.querySelector('svg');
    if (old) {
      const width = old.getAttribute('width');
      const height = old.getAttribute('height');
      if (width) svg.setAttribute('width', width);
      if (height) svg.setAttribute('height', height);
      try {
        const cs = getComputedStyle(old);
        if (cs.width && cs.width !== 'auto') svg.style.width = cs.width;
        if (cs.height && cs.height !== 'auto') svg.style.height = cs.height;
      } catch (err) { /* keep viewBox size */ }
      old.replaceWith(svg);
      return;
    }
    svg.style.width = '24px';
    svg.style.height = '24px';
    item.prepend(svg);
  }

  let localNavEl = null;

  function syncLocalNavHref(item) {
    if (!item || item.tagName !== 'A') return;
    const path = playlistTargetPath(storedId || '', '');
    if (path) item.setAttribute('href', path);
  }

  function findExistingLocalNav() {
    let found = null;
    eachShadowElement((el) => {
      if (found) return;
      if (el.id === 'amfl-nav-local' || (el.getAttribute && el.getAttribute('data-amfl-nav') === '1')) found = el;
    });
    return found && found.isConnected ? found : null;
  }

  function findTopLibraryButton() {
    const found = [];
    const direct = document.querySelector('nav[role="navigation"] button[data-testid="TopNavBar_LibraryTab"]');
    if (direct) found.push(direct);
    collectDeep('button[data-testid="TopNavBar_LibraryTab"]', document.documentElement, found, 0, 16);
    for (let i = 0; i < found.length; i += 1) {
      const el = found[i];
      if (!el || !el.isConnected) continue;
      if (el.closest && el.closest('#amfl-player, #amfl-tracks, #amfl-add, [data-amfl-nav]')) continue;
      const nav = el.closest && el.closest('nav[role="navigation"]');
      if (nav) return el;
    }
    return found.length ? found[0] : null;
  }

  function libraryLabelText(library) {
    const text = ((library && library.textContent) || '').replace(/\s+/g, ' ').trim();
    if (/^library$/i.test(text)) return text;
    return 'LIBRARY';
  }

  function navLabelHost(root) {
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let host = null;
    while (node) {
      if (node.nodeValue && node.nodeValue.trim()) host = node.parentElement;
      node = walker.nextNode();
    }
    return host || root;
  }

  function copyNavType(library, item) {
    const from = navLabelHost(library);
    const to = navLabelHost(item);
    if (!from || !to) return;
    let cs;
    try { cs = getComputedStyle(from); } catch (err) { return; }
    ['font-family', 'font-size', 'font-style', 'letter-spacing', 'line-height'].forEach((key) => {
      const value = cs.getPropertyValue(key);
      if (value) to.style.setProperty(key, value, 'important');
    });
    to.style.setProperty('text-transform', 'none', 'important');
  }

  function paintLocalNavState(item) {
    if (!item) return;
    const active = onLocalPage();
    const color = active ? '#25d1da' : '#fff';
    item.classList.toggle('amfl-nav-active', active);
    item.setAttribute('aria-current', active ? 'page' : 'false');
    item.style.setProperty('color', color, 'important');
    item.querySelectorAll('*').forEach((el) => {
      if (el.closest && el.closest('svg')) return;
      el.style.setProperty('color', color, 'important');
    });
    item.querySelectorAll('svg, svg *').forEach((el) => {
      el.style.setProperty('stroke', color, 'important');
      el.style.setProperty('color', color, 'important');
      el.style.setProperty('fill', 'none', 'important');
    });
    applyNavLabel(item, 'Local');
    copyNavType(findTopLibraryButton(), item);
    item.style.setProperty('text-transform', 'none', 'important');
    item.style.setProperty('font-weight', '700', 'important');
    const host = navLabelHost(item);
    if (host) {
      host.style.setProperty('text-transform', 'none', 'important');
      host.style.setProperty('font-weight', '700', 'important');
    }
  }

  function ensureLocalNav() {
    const library = findTopLibraryButton();
    if (!library || !library.parentElement) return;
    const parent = library.parentElement;
    let item = parent.querySelector(':scope > [data-amfl-nav="1"]');
    if (item && item.previousElementSibling !== library) {
      parent.insertBefore(item, library.nextSibling);
    }
    if (!item) {
      document.querySelectorAll('[data-amfl-nav="1"]').forEach((el) => {
        if (el.parentElement !== parent) el.remove();
      });
      item = library.cloneNode(true);
      item.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
      item.id = 'amfl-nav-local';
      item.setAttribute('data-amfl-nav', '1');
      item.setAttribute('data-amfl-open-local', '1');
      item.removeAttribute('aria-current');
      item.removeAttribute('aria-selected');
      applyNavLabel(item, matchNavCase(libraryLabelText(library)));
      replaceNavIcon(item);
      syncLocalNavHref(item);
      parent.insertBefore(item, library.nextSibling);
    }
    paintLocalNavState(item);
    localNavEl = item;
  }

  let navScheduled = false;
  function scheduleLocalNav() {
    if (navScheduled) return;
    navScheduled = true;
    requestAnimationFrame(() => {
      navScheduled = false;
      ensureLocalNav();
    });
  }

  async function maybeAutoCreate() {
    if (autoTried) return;
    try {
      const config = await loadWebConfig();
      if (!config || !config.customerId) return;
      autoTried = true;
      await createIfMissing();
    } catch (err) {
      /* try again on a later pass until the session answers */
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;
    if (message.type === 'amfl-remove') {
      removeLocal(message.id).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message.type === 'amfl-create') {
      createIfMissing().then(sendResponse).catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
      return true;
    }
    return undefined;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.placeholderId && changes.placeholderId.newValue) {
      storedId = changes.placeholderId.newValue;
      if (localNavEl && localNavEl.isConnected) syncLocalNavHref(localNavEl);
    }
    if (!changes.files) return;
    loadMeta().then(paintTracks);
  });

  audio.addEventListener('timeupdate', paintPlayer);
  audio.addEventListener('play', () => {
    if (amazonHandoff) return;
    player.active = true;
    paintPlayer();
    syncAmazonChrome();
    paintLocalCardPlay();
  });
  audio.addEventListener('pause', () => { paintPlayer(); syncAmazonChrome(); paintLocalCardPlay(); });
  audio.addEventListener('ended', () => {
    if (pageGoingAway || !player.active) return;
    removeCurrentAndAdvance(false, true);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !resumeOnShow || !player.active || pageGoingAway) return;
    resumeOnShow = false;
    audio.play().catch(() => { resumeOnShow = true; });
  });

  function openLocalTarget(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (let i = 0; i < path.length; i += 1) {
      const node = path[i];
      if (!node || node.nodeType !== 1) continue;
      if (node.hasAttribute && node.hasAttribute('data-amfl-open-local')) return node;
    }
    const target = event.target;
    if (target && target.closest) return target.closest('[data-amfl-open-local]');
    return null;
  }

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!openLocalTarget(event)) return;
    openLocalPlaylist(event);
  }, true);
  window.addEventListener('click', (event) => {
    const localLabel = openLocalTarget(event);
    if (localLabel) {
      openLocalPlaylist(event);
      return;
    }
    if (event.target && event.target.closest && event.target.closest('.amfl-card-play')) {
      event.preventDefault();
      event.stopPropagation();
      onLocalCardPlay(event);
      return;
    }
    if (takeLocalQueuePointer(event)) return;
    // Track link only. Do not preventDefault: Amazon must keep playing.
    if (amazonTrackPlayClick(event)) handoffToAmazon();
    onDocClick(event);
  }, true);
  window.addEventListener('pointerdown', onWindowPointerDown, true);
  window.addEventListener('scroll', () => paintLocalCardPlay(), true);
  window.addEventListener('resize', () => {
    paintLocalCardPlay();
    if (player.active) alignPlayerBar();
  });
  ['mousedown', 'pointerup', 'mouseup'].forEach((type) => {
    window.addEventListener(type, takeLocalQueuePointer, true);
  });
  document.addEventListener('play', onMediaPlay, true);
  document.addEventListener('playing', onMediaPlay, true);
  scanOpenShadowPlay();
  new MutationObserver((records) => {
    let addPlaylist = false;
    records.forEach((record) => {
      record.addedNodes.forEach((node) => noteNodeForShadowPlay(node));
      if (!addPlaylist && recordHitsAddPlaylist(record)) addPlaylist = true;
    });
    if (addPlaylist) scheduleHideLocalFromAddPlaylist();
    scheduleLocalNav();
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  ['input', 'change', 'pointermove', 'pointerup', 'pointerdown', 'click', 'keyup'].forEach((type) => {
    window.addEventListener(type, onAmazonVolumeSignal, true);
  });

  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'amfl-page') return;
    if (event.data.type === 'permit-all-done') {
      takePermitFiles(event.data);
      return;
    }
    if (event.data.type !== 'picked') return;
    if (!event.data.ok) return;
    const items = event.data.items || [];
    let duplicate = false;
    for (const item of items) {
      if (!item || !item.file) continue;
      const result = await rememberFile(item.file, item.handle || null, item.id || '');
      duplicate = showDuplicateStatus(result) || duplicate;
    }

    paintTracks();
    paintLibraryControls();
  });
  ensurePageStore();

  loadMeta().then(() => restorePausedSession()).then(() => {
    apply();
    ensureLocalNav();
    leftLibrarySinceLoad = !onLibraryPage();
    maybeHardLibraryRefresh();
    maybeAutoCreate();
  });

  function onPageLeaving() {
    pageGoingAway = true;
    writePlayerSessionNow();
  }
  window.addEventListener('pagehide', onPageLeaving);
  window.addEventListener('beforeunload', onPageLeaving);

  window.setInterval(() => {
    if (!autoTried) maybeAutoCreate();
    ensureLocalNav();
    maybeHardLibraryRefresh();
    scanOpenShadowPlay();
    if (!player.active && !onLocalPage() && !anchorVisible()) {
      setObserver(false);
      removeUi();
      return;
    }
    apply();
  }, 1200);
})();
