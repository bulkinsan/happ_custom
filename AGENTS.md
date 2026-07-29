# Build Instructions — Happ Custom VPN

## Versioning

**При каждом изменении проекта увеличивать версию в `manifest.json` на 1 (1.0.x → 1.0.x+1).**

## Project Structure

```
happ_castom_v1/
├── manifest.json              # Manifest v3, version, permissions
├── src/sw.js                  # Service Worker: proxy engine, subscription
├── native-host/               # Native messaging host (Node.js)
│   ├── proxy.js               # Native host entry (handles start/stop/status messages)
│   ├── daemon.js              # Background proxy daemon (HTTP CONNECT + VLESS WS)
│   ├── package.json           # Node.js dependencies
│   ├── install.bat            # Windows installer (registers with Chrome)
│   └── happ-vpn-proxy.json   # Native host manifest (auto-generated)
├── popup/
│   ├── popup.html             # Main popup UI
│   ├── popup.js               # Popup logic
│   ├── popup.css              # Dark theme styles
│   ├── settings.html          # Settings page (subscription URL)
│   └── settings.js            # Settings logic
├── icons/                     # Extension icons
└── AGENTS.md                  # This file
```

## Setup (Windows)

### 1. Install native host

```bash
cd native-host
install.bat
```

This will:
- Find node.exe path
- Install npm dependencies (ws)
- Register native host in Windows Registry

### 2. Install extension

1. Open `chrome://extensions`
2. Enable Developer Mode
3. Click "Load unpacked"
4. Select the `happ_castom_v1` directory

### 3. Update native host manifest

After loading the extension, copy the Extension ID from chrome://extensions and update `native-host/happ-vpn-proxy.json`:
```json
"allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID/"]
```

Then re-run `install.bat`.

## Architecture

### Proxy Flow

```
Browser HTTP/HTTPS request
  → chrome.proxy (127.0.0.1:18080)
  → Native host (proxy.js) - local HTTP CONNECT proxy
  → WebSocket to VLESS server (with correct Host header)
  → VLESS server forwards to target
  → Response flows back
```

### Key Components

- **Native host** (`proxy.js`): Handles `sendNativeMessage` calls from Chrome (start/stop/status), spawns daemon
- **Daemon** (`daemon.js`): Background HTTP CONNECT proxy, creates WebSocket to VLESS server with correct Host header
- **Service Worker** (`sw.js`): Manages subscription, server list, sends native messages, controls chrome.proxy
- **DNR rule**: User-Agent override for subscription fetch

### Permissions Required

- `storage` — save subscription URL, servers, stats
- `declarativeNetRequest` — User-Agent override for subscription
- `alarms` — periodic tasks
- `nativeMessaging` — communicate with native proxy host
- `proxy` — control Chrome proxy settings

### Why Native Host?

Chrome MV3 does not allow setting custom HTTP headers on WebSocket connections from Service Worker or content scripts. The VLESS server requires a specific `Host` header in the WebSocket upgrade request. A native host (Node.js) can set any headers, solving this limitation.

### Why sendNativeMessage?

Chrome MV3 service workers cannot use `chrome.runtime.connectNative()` for persistent native messaging connections (gives "Invalid native messaging host name specified" error). Instead, we use `chrome.runtime.sendNativeMessage()` for one-shot messages. The native host (`proxy.js`) spawns a background daemon process that persists after the native messaging connection closes.

## Git Workflow

- `main` branch: empty (reserved)
- `dev` branch: all development
- Each commit is tagged: `v1.0.x`
- Push: `git push origin dev && git push origin v1.0.x`
