const net = require('net');
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
  const packet = Buffer.alloc(1 + 16 + 2 + 1 + 2 + 1 + 1 + hostBytes.length);
  let off = 0;
  packet[off++] = 0x00;
  uuidBytes.copy(packet, off); off += 16;
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
    log('WS', url, 'Host:', config.host + ':' + config.port, 'target:', targetHost + ':' + targetPort);
    const ws = new WebSocket(url, {
      headers: { Host: config.host + ':' + config.port },
      perMessageDeflate: false
    });
    ws.on('open', () => {
      log('WS open for', targetHost + ':' + targetPort);
      // Send handshake + first payload in a single WebSocket frame
      const handshake = buildVlessHandshake(config.uuid, targetHost, targetPort);
      if (firstPayload && firstPayload.length > 0) {
        const combined = Buffer.concat([handshake, firstPayload]);
        ws.send(combined);
      } else {
        ws.send(handshake);
      }
      resolve(ws);
    });
    ws.on('error', (err) => { log('WS error:', err.message); reject(err); });
    const t = setTimeout(() => { log('WS timeout'); reject(new Error('WS timeout')); }, 10000);
    ws.on('open', () => clearTimeout(t));
  });
}

function tunnel(ws, clientSocket, label) {
  let sent = 0, recv = 0;
  clientSocket.on('data', (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      sent += data.length;
      ws.send(data);
    }
  });
  ws.on('message', (data) => {
    recv += data.length;
    if (!clientSocket.destroyed) clientSocket.write(data);
  });
  ws.on('close', () => { log('WS closed', label, '- sent:', sent, 'recv:', recv); try { clientSocket.end(); } catch {} });
  clientSocket.on('close', () => { log('Client closed', label, '- sent:', sent, 'recv:', recv); try { ws.close(); } catch {} });
  clientSocket.on('error', () => { try { ws.close(); } catch {} });
  ws.on('error', () => { try { clientSocket.destroy(); } catch {} });
}

const server = net.createServer((clientSocket) => {
  clientSocket.once('data', (data) => {
    const firstLine = data.toString('utf8').split('\r\n')[0];

    if (firstLine.startsWith('CONNECT ')) {
      const parts = firstLine.split(' ');
      const addr = parts[1];
      const [host, portStr] = addr.split(':');
      const targetPort = parseInt(portStr) || 443;
      log('CONNECT', addr);

      const ws = connectVless(host, targetPort, null);
      ws.then((wsConn) => {
        log('Tunnel for', addr);
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        tunnel(wsConn, clientSocket, addr);
      }).catch((err) => {
        log('CONNECT fail:', err.message, addr);
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.end();
      });
    } else {
      const urlMatch = firstLine.match(/^[A-Z]+\s+(https?:\/\/[^\s]+)\s+HTTP/);
      if (!urlMatch) {
        log('Unknown request:', firstLine);
        clientSocket.end();
        return;
      }
      const fullUrl = urlMatch[1];
      const urlObj = new URL(fullUrl);
      const host = urlObj.hostname;
      const targetPort = parseInt(urlObj.port) || 80;
      log('HTTP', firstLine, '->', host + ':' + targetPort);

      // Rewrite request: replace absolute URL with relative path
      const relativePath = urlObj.pathname + urlObj.search;
      let modified = data.toString('utf8').replace(fullUrl, relativePath);
      modified = modified.replace(/^Proxy-.*\r\n/gmi, '');
      modified = modified.replace(/^Host: .*\r\n/im, 'Host: ' + host + ':' + targetPort + '\r\n');
      const firstPayload = Buffer.from(modified, 'utf8');

      connectVless(host, targetPort, firstPayload).then((wsConn) => {
        log('HTTP tunnel for', host + ':' + targetPort);
        tunnel(wsConn, clientSocket, host + ':' + targetPort);
      }).catch((err) => {
        log('HTTP fail:', err.message, host + ':' + targetPort);
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.end();
      });
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
