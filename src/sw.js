let activeConfig = null;
let isConnected = false;
let serverList = [];
let connecting = false;

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

function buildVlessHandshake(config, host, port) {
  const uuidBytes = uuidToBytes(config.uuid);
  const encoder = new TextEncoder();
  const hostBytes = encoder.encode(host);
  const packet = new Uint8Array(1 + 16 + 2 + 1 + 2 + 1 + 1 + hostBytes.length);
  let off = 0;
  packet[off++] = 0x00;
  packet.set(uuidBytes, off); off += 16;
  packet[off++] = 0x00; packet[off++] = 0x00;
  packet[off++] = 0x01;
  packet[off++] = (port >> 8) & 0xFF; packet[off++] = port & 0xFF;
  packet[off++] = 0x02;
  packet[off++] = hostBytes.length;
  packet.set(hostBytes, off);
  return packet;
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
  console.log('Response OK, length:', text.length, 'starts with:', text.slice(0, 30));
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
    console.error('Stack:', e.stack);
    const cached = await chrome.storage.local.get('servers');
    serverList = cached.servers || [];
  }
  return serverList;
}

async function addHostHeaderRules(serverList) {
  try {
    // Remove all existing host header rules first
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const toRemove = existing.map(r => r.id).filter(id => id !== 1);
    const rules = serverList.map((s, i) => ({
      id: 100 + i, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Host', operation: 'set', value: s.host + ':' + s.port }] },
      condition: { urlFilter: `||${s.server}` }
    }));
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: toRemove,
      addRules: rules
    });
  } catch (e) { console.error('DNR add rules failed:', e); }
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

async function addHostHeaderRule(server, host, port) {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [2],
      addRules: [{
        id: 2, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Host', operation: 'set', value: host + ':' + port }] },
        condition: { urlFilter: `||${server}` }
      }]
    });
  } catch (e) { console.error('DNR add rule failed:', e); }
  console.log('DNR rule set: Host ->', host);
}

async function clearDynamicRules() {
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const ids = existing.map(r => r.id);
    if (ids.length) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids, addRules: [] });
  } catch {}
}

let proxyTabId = null;

async function pingServer(config) {
  const proto = config.security === 'tls' ? 'wss' : 'ws';
  const url = `${proto}://${config.server}:${config.port}${config.path}`;
  const start = Date.now();
  try {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = () => { ws.close(); resolve(); };
      ws.onerror = (e) => { reject(new Error('WS error')); };
      setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
    });
    return Date.now() - start;
  } catch {
    return -1;
  }
}

async function proxyHttpRequest(config, method, host, port, path, headers, body) {
  const proto = config.security === 'tls' ? 'wss' : 'ws';
  const url = `${proto}://${config.server}:${config.port}${config.path}`;

  const ws = new WebSocket(url);
  const openPromise = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('WS connect failed'));
    setTimeout(() => reject(new Error('WS timeout')), 10000);
  });
  await openPromise;

  const handshake = buildVlessHandshake(config, host, port);
  ws.send(handshake);

  let req = `${method} ${path} HTTP/1.1\r\nHost: ${host}${port !== 80 && port !== 443 ? ':' + port : ''}\r\n`;
  for (const [k, v] of headers) {
    if (k.toLowerCase() !== 'host') req += `${k}: ${v}\r\n`;
  }
  req += '\r\n';
  const encoder = new TextEncoder();
  const reqBytes = encoder.encode(req);
  let bodyBytes = new Uint8Array(0);
  if (body) {
    if (typeof body === 'string') bodyBytes = encoder.encode(body);
    else if (body instanceof ArrayBuffer) bodyBytes = new Uint8Array(body);
  }
  const full = new Uint8Array(reqBytes.length + bodyBytes.length);
  full.set(reqBytes, 0);
  full.set(bodyBytes, reqBytes.length);
  ws.send(full);

  return new Promise((resolve, reject) => {
    const chunks = [];
    ws.onmessage = (e) => {
      e.data.arrayBuffer().then(buf => {
        const bytes = new Uint8Array(buf);
        chunks.push(bytes);
        const fullResp = concatU8(chunks);
        const hEnd = indexOf(fullResp, new Uint8Array([13, 10, 13, 10]));
        if (hEnd === -1) return;

        const headerStr = new TextDecoder().decode(fullResp.slice(0, hEnd));
        const lines = headerStr.split('\r\n');
        const code = parseInt(lines[0].split(' ')[1]) || 200;
        const respHeaders = {};
        let isChunked = false;
        let cl = -1;
        for (let i = 1; i < lines.length; i++) {
          const ci = lines[i].indexOf(':');
          if (ci > 0) {
            const k = lines[i].slice(0, ci).trim().toLowerCase();
            const v = lines[i].slice(ci + 1).trim();
            respHeaders[k] = v;
            if (k === 'content-length') cl = parseInt(v);
            if (k === 'transfer-encoding' && v.includes('chunked')) isChunked = true;
          }
        }

        const bodyStart = hEnd + 4;
        let bodyData;
        if (isChunked) {
          bodyData = decodeChunked(fullResp.slice(bodyStart));
          delete respHeaders['transfer-encoding'];
        } else if (cl >= 0 && fullResp.length >= bodyStart + cl) {
          bodyData = fullResp.slice(bodyStart, bodyStart + cl);
        } else if (cl >= 0) {
          return;
        } else {
          bodyData = fullResp.slice(bodyStart);
        }

        ws.close();
        resolve(new Response(bodyData, {
          status: code,
          statusText: lines[0].split(' ').slice(2).join(' ') || 'OK',
          headers: Object.entries(respHeaders)
        }));
      });
    };
    ws.onerror = () => reject(new Error('WS error'));
    setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 30000);
  });
}

function concatU8(chunks) {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const r = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { r.set(c, off); off += c.length; }
  return r;
}

function indexOf(data, pattern) {
  for (let i = 0; i <= data.length - pattern.length; i++) {
    let match = true;
    for (let j = 0; j < pattern.length; j++) { if (data[i + j] !== pattern[j]) { match = false; break; } }
    if (match) return i;
  }
  return -1;
}

function decodeChunked(data) {
  const chunks = [];
  let off = 0;
  while (off < data.length) {
    let sizeStr = '';
    while (off < data.length && data[off] !== 13) { sizeStr += String.fromCharCode(data[off++]); }
    if (off >= data.length) break;
    off += 2;
    const size = parseInt(sizeStr, 16);
    if (size === 0) break;
    chunks.push(data.slice(off, off + size));
    off += size + 2;
  }
  return concatU8(chunks);
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

async function connectToServer(serverName) {
  if (connecting) throw new Error('Already connecting');
  connecting = true;
  console.log('connectToServer called with:', serverName);
  let config;
  if (!serverName || serverName === 'auto') {
    const pings = await Promise.allSettled(serverList.map(async s => ({ s, ping: await pingServer(s) })));
    const valid = pings.filter(r => r.status === 'fulfilled' && r.value.ping > 0).sort((a, b) => a.value.ping - b.value.ping);
    if (valid.length === 0) throw new Error('No reachable servers');
    config = valid[0].value.s;
  } else {
    config = serverList.find(s => s.name === serverName);
    if (!config) throw new Error('Server not found');
  }

  activeConfig = config;
  isConnected = true;
  const stats = await getStats();
  stats.sessionStart = Date.now();
  stats.connectedServer = config.name;
  await saveStats(stats);
  await chrome.storage.local.set({ connected: true, activeServer: config });

  await clearDynamicRules();
  await addSubFetchRule(await getSubUrl());
  await addHostHeaderRule(config.server, config.host, config.port);

  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let tab = tabs?.[0];
  if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    const all = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    tab = all?.[0];
  }
  if (tab && tab.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
    try {
      proxyTabId = tab.id;
      await chrome.debugger.attach({ tabId: tab.id }, '1.3');
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Fetch.enable', {
        patterns: [
          { urlPattern: 'http://*/*', requestStage: 'request' }
        ]
      });
      console.log('Debugger ready on tab', tab.id, tab.url);
    } catch (e) {
      console.error('Debugger attach failed:', e);
    }
  } else {
    console.error('No suitable tab for proxy.');
  }

  chrome.debugger.onEvent.removeListener(onDebuggerEvent);
  chrome.debugger.onEvent.addListener(onDebuggerEvent);
  chrome.debugger.onDetach.removeListener(onDebuggerDetach);
  chrome.debugger.onDetach.addListener(onDebuggerDetach);

  connecting = false;
  return config.name;
}

async function disconnect() {
  await clearDynamicRules();
  await addSubFetchRule(await getSubUrl());
  chrome.debugger.onEvent.removeListener(onDebuggerEvent);
  chrome.debugger.onDetach.removeListener(onDebuggerDetach);

  if (proxyTabId) {
    try { await chrome.debugger.detach({ tabId: proxyTabId }); } catch {}
    proxyTabId = null;
  }

  activeConfig = null;
  isConnected = false;
  const stats = await getStats();
  stats.sessionStart = null;
  stats.connectedServer = null;
  await saveStats(stats);
  await chrome.storage.local.set({ connected: false, activeServer: null });
}

function onDebuggerDetach(source) {
  if (!isConnected || !source.tabId) return;
  console.warn('Debugger detached from tab', source.tabId);
  setTimeout(async () => {
    try {
      proxyTabId = source.tabId;
      await chrome.debugger.attach({ tabId: source.tabId }, '1.3');
      await chrome.debugger.sendCommand({ tabId: source.tabId }, 'Fetch.enable', {
        patterns: [
          { urlPattern: 'http://*/*', requestStage: 'request' }
        ]
      });
      console.log('Debugger re-attached to tab', source.tabId);
    } catch (e) {
      console.error('Re-attach failed:', e);
    }
  }, 1000);
}

async function onDebuggerEvent(source, method, params) {
  if (method !== 'Fetch.requestPaused') return;
  const { requestId, request } = params;
  const url = request.url;

  try {
    if (url.startsWith('http://') && activeConfig) {
      const parsed = new URL(url);
      const hdrs = Array.isArray(request.headers) ? request.headers.map(h => [h.name, h.value]) : Object.entries(request.headers || {});
      const resp = await proxyHttpRequest(activeConfig, request.method, parsed.hostname, parsed.port || 80, parsed.pathname + parsed.search, hdrs, request.postData || null);
      const body = await resp.arrayBuffer();
      const b64 = arrayBufferToBase64(body);
      const respHeaders = [];
      resp.headers.forEach((v, k) => respHeaders.push({ name: k, value: v }));

      await chrome.debugger.sendCommand(
        { tabId: source.tabId, sessionId: source.sessionId },
        'Fetch.fulfillRequest',
        { requestId, responseCode: resp.status, responseHeaders: respHeaders, body: b64 }
      );

      const stats = await getStats();
      stats.rx += body.byteLength;
      stats.tx += (request.postData?.length || 0);
      await saveStats(stats);
    } else {
      await chrome.debugger.sendCommand(
        { tabId: source.tabId, sessionId: source.sessionId },
        'Fetch.continueRequest',
        { requestId }
      );
    }
  } catch (e) {
    console.error('onDebuggerEvent error:', e);
    try {
      await chrome.debugger.sendCommand(
        { tabId: source.tabId, sessionId: source.sessionId },
        'Fetch.continueRequest',
        { requestId }
      );
    } catch {}
  }
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
        }
        sendResponse({ results });
      })();
      return true;

    case 'CONNECT':
      connectToServer(msg.serverName).then(n => sendResponse({ success: true, serverName: n })).catch(e => sendResponse({ success: false, error: e.message }));
      return true;

    case 'DISCONNECT':
      disconnect().then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: e.message }));
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
