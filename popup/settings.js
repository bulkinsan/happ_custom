async function loadSettings() {
  const data = await chrome.storage.local.get(['subUrl', 'connected', 'activeServer']);
  document.getElementById('sub-url').value = data.subUrl || '';
  updateStatusDisplay(data.connected, data.activeServer);
}

async function updateStatusDisplay(connected, activeServer) {
  document.getElementById('status-display').textContent = connected ? 'Connected' : 'Disconnected';
  document.getElementById('server-display').textContent = activeServer?.name || '—';
  document.getElementById('debugger-display').textContent = connected ? 'Attached to tabs' : 'Not attached';
}

document.getElementById('save-btn').addEventListener('click', async () => {
  const url = document.getElementById('sub-url').value.trim();
  const status = document.getElementById('save-status');

  if (!url) {
    status.textContent = 'Please enter a subscription URL';
    status.className = 'save-err';
    return;
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    status.textContent = 'URL must start with http:// or https://';
    status.className = 'save-err';
    return;
  }

  await chrome.storage.local.set({ subUrl: url });
  await chrome.runtime.sendMessage({ type: 'SET_SUB_URL', url });
  status.textContent = 'Saved! Reloading servers...';
  status.className = 'save-ok';

  setTimeout(() => {
    status.textContent = '';
    status.className = '';
  }, 3000);
});

document.getElementById('test-btn').addEventListener('click', async () => {
  const url = document.getElementById('sub-url').value.trim();
  const status = document.getElementById('save-status');

  if (!url) {
    status.textContent = 'Enter a URL first';
    status.className = 'save-err';
    return;
  }

  status.textContent = 'Testing...';
  status.className = '';

  const resp = await chrome.runtime.sendMessage({ type: 'TEST_SUB_URL', url });
  if (resp.success) {
    status.textContent = `OK: ${resp.total} WS servers found (e.g. ${resp.name})`;
    status.className = 'save-ok';
  } else {
    status.textContent = `Error: ${resp.error}`;
    status.className = 'save-err';
  }
});

document.addEventListener('DOMContentLoaded', loadSettings);
chrome.storage.onChanged.addListener((changes) => {
  if (changes.connected || changes.activeServer) {
    chrome.storage.local.get(['connected', 'activeServer']).then(d => {
      updateStatusDisplay(d.connected, d.activeServer);
    });
  }
});
