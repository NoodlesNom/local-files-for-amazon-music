const list = document.getElementById('list');
const empty = document.getElementById('empty');
const statusEl = document.getElementById('status');

function setStatus(text) {
  statusEl.textContent = text || '';
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function render() {
  const data = await chrome.storage.local.get({ files: [] });
  const files = data.files || [];
  list.replaceChildren();
  empty.hidden = files.length > 0;
  files.forEach((file) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    const title = document.createElement('b');
    title.textContent = file.title || file.filename || 'Untitled';
    const artist = document.createElement('em');
    artist.textContent = file.artist || file.filename || '';
    span.append(title, artist);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => removeFile(file.id));
    li.append(span, remove);
    list.append(li);
  });
}

async function removeFile(id) {
  const data = await chrome.storage.local.get({ files: [], pendingDeletes: [] });
  const files = (data.files || []).filter((file) => file.id !== id);
  const pendingDeletes = (data.pendingDeletes || []).concat(id);
  await chrome.storage.local.set({ files, pendingDeletes });
  const tab = await activeTab();
  if (tab && tab.id && /^https:\/\/music\.amazon\./.test(tab.url || '')) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'amfl-remove', id });
    } catch (err) {
      setStatus('Removed from the list. Open Amazon Music to drop the file handle.');
    }
  }
  await render();
}

document.getElementById('create').addEventListener('click', async () => {
  setStatus('Checking Amazon Music…');
  const tab = await activeTab();
  if (!tab || !tab.id || !/^https:\/\/music\.amazon\./.test(tab.url || '')) {
    setStatus('Open music.amazon.com, then try again.');
    return;
  }
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'amfl-create' });
    if (!result) {
      setStatus('No response from the Amazon Music tab.');
      return;
    }
    if (result.ok && result.created) setStatus('Created the empty LOCAL PLACEHOLDER playlist.');
    else if (result.ok) setStatus('LOCAL PLACEHOLDER already exists. It was not created again.');
    else setStatus(result.error || 'Could not create the playlist.');
  } catch (err) {
    setStatus('Open a music.amazon.com tab and reload it, then try again.');
  }
});

render();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.files) render();
});
