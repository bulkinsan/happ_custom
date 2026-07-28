const state = {
  servers: [],
  connected: false,
  activeServer: null,
  stats: { rx: 0, tx: 0, sessionStart: null, connectedServer: null }
};

let statsInterval = null;

async function checkSetup() {
  const data = await chrome.storage.local.get('subUrl');
  const hasUrl = !!data.subUrl;
  document.getElementById('setup-panel').classList.toggle('hidden', hasUrl);
  document.getElementById('main-panel').classList.toggle('hidden', !hasUrl);
  return hasUrl;
}

async function loadServers() {
  const hasUrl = await checkSetup();
  if (!hasUrl) return;

  const list = document.getElementById('server-list');
  list.innerHTML = '<div class="loading">Loading servers...</div>';

  const resp = await chrome.runtime.sendMessage({ type: 'LOAD_SERVERS' });
  state.servers = resp?.servers || [];

  const conn = await chrome.storage.local.get('connected');
  state.connected = conn.connected || false;

  renderServerList();
  updateConnectionUI();
  updateStats();
  pingAllServers();
}

async function pingAllServers() {
  const btn = document.getElementById('ping-all-btn');
  const count = state.servers.length;
  if (!count) return;

  btn.disabled = true;
  btn.textContent = 'Pinging...';

  for (const s of state.servers) {
    s.ping = -1;
  }
  renderServerList();

  const resp = await chrome.runtime.sendMessage({ type: 'PING_ALL' });
  const results = resp?.results || [];

  for (const r of results) {
    const s = state.servers.find(x => x.name === r.name);
    if (s) s.ping = r.ping;
  }

  renderServerList();
  btn.disabled = false;
  btn.textContent = 'Ping All';
}

function renderServerList() {
  const list = document.getElementById('server-list');
  const count = document.getElementById('server-count');
  list.innerHTML = '';
  count.textContent = state.servers.length;

  if (state.servers.length === 0) {
    list.innerHTML = '<div class="empty-state">No servers found. Check your subscription URL in settings.</div>';
    return;
  }

  const autoItem = document.createElement('div');
  autoItem.className = 'server-item auto-server';
  autoItem.innerHTML = `
    <div class="server-flag">⚡</div>
    <div class="server-info">
      <div class="server-name-text">Connect to fastest</div>
      <div class="server-ping">Auto-select best server</div>
    </div>
    <div class="server-check"></div>
  `;
  autoItem.addEventListener('click', () => connectToServer(null));
  list.appendChild(autoItem);

  for (const s of state.servers) {
    const item = document.createElement('div');
    item.className = 'server-item';
    if (state.activeServer === s.name) item.classList.add('selected');

    const flagEmoji = getFlagEmoji(s.name);
    const pingText = s.ping ? `${s.ping}ms` : '--';
    const pingClass = s.ping ? (s.ping < 100 ? 'good' : s.ping < 250 ? 'ok' : 'bad') : '';

    item.innerHTML = `
      <div class="server-flag">${flagEmoji}</div>
      <div class="server-info">
        <div class="server-name-text">${escapeHtml(s.name)}</div>
        <div class="server-ping ${pingClass}">${pingText}</div>
      </div>
      <div class="server-check">✓</div>
    `;
    item.addEventListener('click', () => connectToServer(s.name));
    list.appendChild(item);
  }
}

function getFlagEmoji(name) {
  const lower = name.toLowerCase();
  if (lower.includes('auto')) return '🌐';
  if (lower.includes('vena') || lower.includes('austria')) return '🇦🇹';
  if (lower.includes('amsterdam') || lower.includes('netherlands')) return '🇳🇱';
  if (lower.includes('frankfurt') || lower.includes('germany')) return '🇩🇪';
  if (lower.includes('zurich') || lower.includes('switzerland')) return '🇨🇭';
  if (lower.includes('helsinki') || lower.includes('finland')) return '🇫🇮';
  if (lower.includes('stockholm') || lower.includes('sweden')) return '🇸🇪';
  if (lower.includes('brussels') || lower.includes('belgium')) return '🇧🇪';
  if (lower.includes('london') || lower.includes('uk')) return '🇬🇧';
  if (lower.includes('zagreb') || lower.includes('croatia')) return '🇭🇷';
  if (lower.includes('usa') || lower.includes('united states')) return '🇺🇸';
  if (lower.includes('lisbon') || lower.includes('portugal')) return '🇵🇹';
  if (lower.includes('paris') || lower.includes('france')) return '🇫🇷';
  return '🌍';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function connectToServer(serverName) {
  const connectBtn = document.getElementById('connect-btn');
  const statusText = document.getElementById('status-text');

  if (state.connected) {
    connectBtn.disabled = true;
    statusText.textContent = 'Disconnecting...';
    const resp = await chrome.runtime.sendMessage({ type: 'DISCONNECT' });
    state.connected = false;
    state.activeServer = null;
    clearInterval(statsInterval);
    updateConnectionUI();
    renderServerList();
    connectBtn.disabled = false;
    return;
  }

  connectBtn.disabled = true;
  statusText.textContent = 'Connecting...';

  const targetServer = serverName || 'auto';

  const resp = await chrome.runtime.sendMessage({
    type: 'CONNECT',
    serverName: targetServer
  });

  if (resp && resp.success) {
    state.connected = true;
    state.activeServer = resp.serverName || targetServer;
    updateConnectionUI();
    renderServerList();
    startStatsInterval();
  } else {
    statusText.textContent = `Error: ${resp?.error || 'Connection failed'}`;
    statusText.classList.remove('connected');
  }

  connectBtn.disabled = false;
}

function updateConnectionUI() {
  const connectBtn = document.getElementById('connect-btn');
  const label = document.getElementById('connect-label');
  const statusText = document.getElementById('status-text');
  const serverName = document.getElementById('server-name');
  const statsPanel = document.getElementById('stats-panel');

  if (state.connected) {
    connectBtn.classList.add('connected');
    label.textContent = 'Disconnect';
    statusText.textContent = 'Connected';
    statusText.classList.add('connected');
    serverName.textContent = state.activeServer || '';
    serverName.classList.remove('hidden');
    statsPanel.classList.remove('hidden');
  } else {
    connectBtn.classList.remove('connected');
    label.textContent = 'Connect';
    statusText.textContent = 'Disconnected';
    statusText.classList.remove('connected');
    serverName.textContent = '';
    serverName.classList.add('hidden');
    statsPanel.classList.add('hidden');
  }
}

async function updateStats() {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
  if (resp && resp.stats) {
    state.stats = resp.stats;
    document.getElementById('rx-value').textContent = formatBytes(state.stats.rx);
    document.getElementById('tx-value').textContent = formatBytes(state.stats.tx);
    if (state.stats.sessionStart) {
      document.getElementById('duration-value').textContent = formatDuration(Date.now() - state.stats.sessionStart);
    } else {
      document.getElementById('duration-value').textContent = '0s';
    }
  }
}

function startStatsInterval() {
  clearInterval(statsInterval);
  statsInterval = setInterval(updateStats, 2000);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatDuration(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  if (min < 60) return `${min}m ${s}s`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${m}m`;
}

document.addEventListener('DOMContentLoaded', () => {
  loadServers();

  document.getElementById('connect-btn').addEventListener('click', () => connectToServer(state.activeServer));

  document.getElementById('ping-all-btn').addEventListener('click', pingAllServers);

  document.getElementById('refresh-config-btn').addEventListener('click', () => {
    loadServers();
  });

  document.getElementById('refresh-btn').addEventListener('click', loadServers);

  document.getElementById('settings-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: 'popup/settings.html' });
  });

  document.getElementById('goto-settings-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: 'popup/settings.html' });
  });

  document.getElementById('search-input').addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    const items = document.querySelectorAll('.server-item');
    for (const item of items) {
      item.style.display = item.textContent.toLowerCase().includes(query) ? '' : 'none';
    }
  });
});
