let activeConfig = null;
let isConnected = false;
let serverList = [];
let connecting = false;
let proxyPort = 18080;

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function parseVlessUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    const params = new URLSearchParams(url.search);
    const name = decodeURIComponent(url.hash.replace('#', ''));
    let path = params.get('path');
    if (!path) path = url.pathname;
    return {
      uuid: url.username,
      server: url.hostname,
      port: parseInt(url.port),
      encryption: params.get('encryption') || 'none',
      type: params.get('type') || 'tcp',
      path: path || '/',
      host: params.get('host') || url.hostname,
      security: params.get('security') || 'none',
      name
    };
  } catch { return null; }
}

async function getSubUrl() {
  const data = await chrome.storage.local.get('subUrl');
  return data.subUrl || '';
}

async function fetchWithRetry(url, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'curl/8.0.1' }
      });
      if (resp.ok) return resp;
      console.warn(`Attempt ${attempt}/${maxAttempts} failed: HTTP ${resp.status}`);
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 2000 * attempt));
      else return resp;
    } catch (e) {
      console.warn(`Attempt ${attempt}/${maxAttempts} network error:`, e.message);
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 2000 * attempt));
      else throw e;
    }
  }
}

async function fetchSubscription() {
  const subUrl = await getSubUrl();
  if (!subUrl) throw new Error('No subscription URL configured');
  console.log('Fetching subscription from:', subUrl);
  await addSubFetchRule(subUrl);
  const resp = await fetchWithRetry(subUrl);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  const text = (await resp.text()).trim();
  console.log('Response OK, length:', text.length);
  let decoded;
  if (text.startsWith('vless://') || text.includes('\nvless://')) {
    decoded = text;
  } else {
    const clean = text.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const pad = clean.length % 4;
    const padded = pad ? clean + '='.repeat(4 - pad) : clean;
    const binary = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
    decoded = new TextDecoder().decode(binary);
  }
  const lines = decoded.split('\n').filter(l => l.trim());
  console.log('Decoded lines:', lines.length);
  const parsed = lines.map(parseVlessUrl).filter(s => s && s.type === 'ws');
  console.log('WS servers found:', parsed.length);
  return parsed;
}

async function loadServers() {
  try {
    serverList = await fetchSubscription();
    await chrome.storage.local.set({ servers: serverList });
  } catch (e) {
    console.error('Failed to fetch subscription:', e.message || e);
    const cached = await chrome.storage.local.get('servers');
    serverList = cached.servers || [];
  }
  return serverList;
}

async function addSubFetchRule(subUrl) {
  try {
    const domain = new URL(subUrl).hostname;
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1],
      addRules: [{
        id: 1, priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'User-Agent', operation: 'set', value: 'curl/8.0.1' }
          ]
        },
        condition: { urlFilter: `||${domain}`, resourceTypes: ['xmlhttprequest'] }
      }]
    });
  } catch (e) { console.error('DNR add fetch rule failed:', e); }
}

async function clearDynamicRules() {
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const ids = existing.map(r => r.id);
    if (ids.length) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids, addRules: [] });
  } catch {}
}

async function startNativeProxy(config) {
  try {
    console.log('Sending native message...');
    const resp = await chrome.runtime.sendNativeMessage('happ-vpn-proxy', { action: 'start', config });
    console.log('Native response:', resp);
    if (resp && resp.success) {
      proxyPort = resp.port;
      return resp.port;
    }
    throw new Error(resp?.error || 'Native host returned failure');
  } catch (e) {
    console.error('Native host error:', e.message);
    throw e;
  }
}

async function stopNativeProxy() {
  try {
    await chrome.runtime.sendNativeMessage('happ-vpn-proxy', { action: 'stop' });
  } catch {}
}

async function enableProxy() {
  return chrome.proxy.settings.set({
    value: {
      mode: 'fixed_servers',
      rules: { singleProxy: { scheme: 'http', host: '127.0.0.1', port: proxyPort } }
    },
    scope: 'regular'
  });
}

async function disableProxy() {
  return chrome.proxy.settings.clear({ scope: 'regular' });
}

async function pingServer(config) {
  try {
    const proto = config.security === 'tls' ? 'https' : 'http';
    const url = `${proto}://${config.server}:${config.port}${config.path}`;
    const start = Date.now();
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    await fetch(url, { mode: 'no-cors', signal: controller.signal });
    clearTimeout(t);
    return Date.now() - start;
  } catch {
    return -1;
  }
}

async function connectToServer(serverName) {
  if (connecting) throw new Error('Already connecting');
  connecting = true;
  console.log('connectToServer called with:', serverName);

  let config;
  if (!serverName || serverName === 'auto') {
    config = serverList[0];
    if (!config) throw new Error('No servers available');
  } else {
    config = serverList.find(s => s.name === serverName);
    if (!config) throw new Error('Server not found: ' + serverName);
  }

  try {
    await startNativeProxy(config);
    await enableProxy();

    activeConfig = config;
    isConnected = true;
    const stats = await getStats();
    stats.sessionStart = Date.now();
    stats.connectedServer = config.name;
    await saveStats(stats);
    await chrome.storage.local.set({ connected: true, activeServer: config });

    connecting = false;
    return config.name;
  } catch (e) {
    connecting = false;
    await stopNativeProxy().catch(() => {});
    throw e;
  }
}

async function disconnect() {
  await disableProxy().catch(() => {});
  await stopNativeProxy();

  activeConfig = null;
  isConnected = false;
  const stats = await getStats();
  stats.sessionStart = null;
  stats.connectedServer = null;
  await saveStats(stats);
  await chrome.storage.local.set({ connected: false, activeServer: null });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  return btoa(binary);
}

async function getStats() {
  const data = await chrome.storage.local.get('happ_stats');
  return data.happ_stats || { rx: 0, tx: 0, sessionStart: null, connectedServer: null };
}

async function saveStats(stats) {
  await chrome.storage.local.set({ happ_stats: stats });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'LOAD_SERVERS':
      loadServers().then(s => sendResponse({ servers: s }));
      return true;

    case 'PING_SERVER':
      pingServer(msg.config).then(p => sendResponse({ ping: p }));
      return true;

    case 'PING_ALL':
      (async () => {
        const results = [];
        for (const s of serverList) {
          const p = await pingServer(s);
          results.push({ name: s.name, ping: p });
          if (serverList.length > 5) await new Promise(r => setTimeout(r, 100));
        }
        sendResponse({ results });
      })();
      return true;

    case 'CONNECT':
      connectToServer(msg.serverName)
        .then(n => {
          console.log('CONNECT success:', n);
          sendResponse({ success: true, serverName: n });
        })
        .catch(e => {
          console.error('CONNECT error:', e);
          sendResponse({ success: false, error: e.message });
        });
      return true;

    case 'DISCONNECT':
      disconnect()
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;

    case 'GET_STATUS':
      sendResponse({ connected: isConnected, activeServer: activeConfig?.name || null });
      return true;

    case 'GET_STATS':
      getStats().then(s => sendResponse({ stats: s }));
      return true;

    case 'RESET_STATS':
      getStats().then(s => { s.rx = 0; s.tx = 0; saveStats(s); });
      sendResponse({ success: true });
      return true;

    case 'SET_SUB_URL':
      loadServers();
      sendResponse({ success: true });
      return true;

    case 'TEST_SUB_URL':
      (async () => {
        try {
          const subUrl = msg.url || await getSubUrl();
          await addSubFetchRule(subUrl);
          const resp = await fetchWithRetry(subUrl);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const text = (await resp.text()).trim();
          let decoded;
          if (text.startsWith('vless://') || text.includes('\nvless://')) {
            decoded = text;
          } else {
            const clean = text.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
            const pad = clean.length % 4;
            const padded = pad ? clean + '='.repeat(4 - pad) : clean;
            decoded = new TextDecoder().decode(Uint8Array.from(atob(padded), c => c.charCodeAt(0)));
          }
          const lines = decoded.split('\n').filter(l => l.trim()).map(parseVlessUrl).filter(s => s && s.type === 'ws');
          sendResponse({ success: true, total: lines.length, name: lines[0]?.name || 'none' });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  if (!serverList.length) loadServers();
});

console.log('Happ VPN SW loaded');
