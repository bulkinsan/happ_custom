const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');

function log(...args) { const s = args.join(' ') + '\n'; process.stderr.write(s); }

const CONFIG_FILE = path.join(__dirname, 'proxy-config.json');
const PORT = 18080;

let config = null;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  log('Config loaded');
} catch (e) {
  log('No config:', e.message);
  process.exit(1);
}

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, '');
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function buildVlessHandshake(uuid, targetHost, targetPort) {
  const uuidBytes = uuidToBytes(uuid);
  const hostBytes = Buffer.from(targetHost, 'utf8');
  const packet = Buffer.alloc(1 + 16 + 4 + 1 + 2 + 1 + 1 + hostBytes.length);
  let off = 0;
  packet[off++] = 0x00;
  uuidBytes.copy(packet, off); off += 16;
  packet[off++] = 0x00; packet[off++] = 0x01;
  packet[off++] = 0x00; packet[off++] = 0x00;
  packet[off++] = 0x01;
  packet[off++] = (targetPort >> 8) & 0xFF; packet[off++] = targetPort & 0xFF;
  packet[off++] = 0x02;
  packet[off++] = hostBytes.length;
  hostBytes.copy(packet, off);
  return packet;
}

function connectVless(targetHost, targetPort, firstPayload) {
  const WebSocket = require('ws');
  return new Promise((resolve, reject) => {
    const proto = config.security === 'tls' ? 'wss' : 'ws';
    const url = `${proto}://${config.server}:${config.port}${config.path}`;
    const ws = new WebSocket(url, {
      headers: { Host: config.host + ':' + config.port },
      perMessageDeflate: false
    });
    ws.on('open', () => {
      const handshake = buildVlessHandshake(config.uuid, targetHost, targetPort);
      if (firstPayload && firstPayload.length > 0) {
        ws.send(Buffer.concat([handshake, firstPayload]));
      } else {
        ws.send(handshake);
      }
      resolve(ws);
    });
    ws.on('error', reject);
    const t = setTimeout(() => reject(new Error('WS timeout')), 10000);
    ws.on('open', () => clearTimeout(t));
  });
}

function tunnel(ws, clientSocket, label) {
  let sent = 0, recv = 0, hasVlessResp = false;
  clientSocket.on('data', (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      sent += data.length;
      ws.send(data);
    }
  });
  ws.on('message', (data) => {
    // Skip the first VLESS response (typically 2 bytes: 0x00 0x00)
    if (!hasVlessResp && data.length <= 4) {
      hasVlessResp = true;
      log('VLESS resp for', label, ':', data.toString('hex'));
      return;
    }
    recv += data.length;
    if (!clientSocket.destroyed) clientSocket.write(data);
  });
  ws.on('close', () => {
    log('Closed', label, '- sent:', sent, 'recv:', recv);
    if (!clientSocket.destroyed) clientSocket.end();
  });
  clientSocket.on('close', () => { try { ws.close(); } catch {} });
  clientSocket.on('error', () => { try { ws.close(); } catch {} });
  ws.on('error', () => { try { clientSocket.destroy(); } catch {} });
}

const server = net.createServer((clientSocket) => {
  clientSocket.once('data', (data) => {
    const firstLine = data.toString('utf8').split('\r\n')[0];

    if (firstLine.startsWith('CONNECT ')) {
      // HTTPS via VLESS tunnel
      const parts = firstLine.split(' ');
      const addr = parts[1];
      const [host, portStr] = addr.split(':');
      const targetPort = parseInt(portStr) || 443;
      log('CONNECT', addr);

      connectVless(host, targetPort, null).then((ws) => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        tunnel(ws, clientSocket, addr);
      }).catch((err) => {
        log('CONNECT fail:', err.message, addr);
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.end();
      });
    } else {
      // HTTP direct (bypass VLESS - via Node.js http module)
      const urlMatch = firstLine.match(/^[A-Z]+\s+(https?:\/\/[^\s]+)\s+HTTP/);
      if (!urlMatch) {
        log('Unknown:', firstLine);
        clientSocket.end();
        return;
      }
      const fullUrl = urlMatch[1];
      const urlObj = new URL(fullUrl);
      log('HTTP', firstLine, '-> direct', urlObj.host);
      
      // Forward HTTP request directly
      const options = {
        hostname: urlObj.hostname,
        port: parseInt(urlObj.port) || 80,
        path: urlObj.pathname + urlObj.search,
        method: firstLine.split(' ')[0],
        headers: {}
      };
      
      // Parse headers from original request
      const headerLines = data.toString('utf8').split('\r\n');
      for (let i = 1; i < headerLines.length; i++) {
        const line = headerLines[i];
        if (!line || line.startsWith('Proxy-')) continue;
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
          const name = line.substring(0, colonIdx).trim();
          const val = line.substring(colonIdx + 1).trim();
          if (name.toLowerCase() !== 'host' && name.toLowerCase() !== 'proxy-connection') {
            options.headers[name] = val;
          }
        }
      }
      options.headers['Host'] = urlObj.hostname;
      options.headers['Connection'] = 'close';
      
      const proxyReq = http.request(options, (proxyRes) => {
        const statusLine = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
        let headerStr = statusLine;
        for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
          headerStr += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i+1]}\r\n`;
        }
        headerStr += '\r\n';
        clientSocket.write(headerStr);
        proxyRes.pipe(clientSocket);
      });
      
      proxyReq.on('error', (err) => {
        log('Direct HTTP fail:', err.message, 'for', urlObj.host);
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.end();
      });
      
      // Send body if any (for POST, etc.)
      const bodyMatch = data.toString('utf8').split('\r\n\r\n');
      if (bodyMatch.length > 1) {
        proxyReq.write(bodyMatch[1]);
      }
      proxyReq.end();
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  log('Proxy on 127.0.0.1:' + PORT);
});

function cleanup() {
  log('Shutdown');
  try { fs.unlinkSync(path.join(__dirname, 'proxy.pid')); } catch {}
  try { fs.unlinkSync(CONFIG_FILE); } catch {}
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
process.on('disconnect', cleanup);
