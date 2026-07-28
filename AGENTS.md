# Build Instructions — Happ Custom VPN

## Versioning

**При каждом изменении проекта увеличивать версию в `manifest.json` на 1 (1.0.x → 1.0.x+1).**

## Project Structure

```
happ_castom_v1/
├── manifest.json          # Manifest v3, version, permissions
├── src/sw.js              # Service Worker: proxy engine, subscription, DNR
├── popup/
│   ├── popup.html         # Main popup UI
│   ├── popup.js           # Popup logic (connect, ping, server list)
│   ├── popup.css          # Dark theme styles
│   └── settings.html      # Settings page (subscription URL)
│   └── settings.js        # Settings logic
├── icons/                 # Extension icons
└── AGENTS.md              # This file
```

## How to Deploy

1. Open `chrome://extensions`
2. Enable Developer Mode
3. Click "Load unpacked"
4. Select the `happ_castom_v1` directory
5. To update: click the reload (reload) button on the extension card

## Git Workflow

- `main` branch: empty (reserved)
- `dev` branch: all development
- Each commit is tagged: `v1.0.x`
- Push: `git push origin dev && git push origin v1.0.x`

## Architecture

### Proxy Flow

```
Tab HTTP request
  → Chrome Debugger (Fetch.requestPaused, http://*/*)
  → proxyHttpRequest()
  → SW creates WebSocket to VLESS server
  → VLESS handshake + HTTP request sent through WS
  → Response parsed and returned via Fetch.fulfillRequest
```

### Key Components

- **DNR rule 1**: User-Agent override for subscription fetch
- **DNR rule 2**: Host header for WebSocket (may not work from SW context)
- **Debugger**: Intercepts HTTP requests from active tab (`http://*/*`)
- **SW WebSocket**: Creates WebSocket directly from Service Worker

### Known Limitations

1. **Host header for WebSocket**: DNR `modifyHeaders` does NOT apply to WebSocket connections from Service Worker context. The server may reject the connection (404).
2. **Debugger**: Cannot intercept WebSocket URLs (`ws://*/*`, `wss://*/*`) — causes Chrome crash.
3. **HTTPS**: Only HTTP requests are proxied. HTTPS requests pass through directly.
4. **Single tab**: Proxy only works for the tab the debugger is attached to.

### Permissions Required

- `storage` — save subscription URL, servers, stats
- `debugger` — intercept HTTP requests via CDP Fetch domain
- `declarativeNetRequest` — User-Agent override for subscription
- `alarms` — periodic tasks
