# Happ Custom VPN

Unofficial Chrome extension for Happ VPN — works with VLESS+WS proxy configurations.

## Features

- Connect to any VLESS+WebSocket server
- Auto-select fastest server (ping-based)
- Server list with search and manual selection
- Traffic stats (RX/TX, session duration)
- Works via `chrome.debugger` — no system installs, no native messaging

## Usage

1. Open extension settings
2. Paste your subscription URL
3. Servers load automatically
4. Click **Connect** or pick a specific server

## Security

- Keys are stored only in `chrome.storage.local` (never in code or git)
- No telemetry, no external requests except to your subscription URL and proxy servers
- Not published to Chrome Web Store — sideloaded as unpacked extension

## Build

Load as unpacked extension in `chrome://extensions` (enable Developer mode).
