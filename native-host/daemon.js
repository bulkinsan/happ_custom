const http = require('http');
const fs = require('fs');
const path = require('path');

function log(...args) { const s = args.join(' ') + '\n'; process.stderr.write(s); }

const PID_FILE = path.join(__dirname, 'proxy.pid');
const CONFIG_FILE = path.join(__dirname, 'proxy-config.json');
const PORT = 18080;

let config = null;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  log('Daemon config:', JSON.stringify(config));
} catch (e) {
  log('No config file, exiting:', e.message);
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

function connectVless(targetHost, targetPort) {
  const WebSocket = require('ws');
  return new Promise((resolve, reject) => {
    const proto = config.security === 'tls' ? 'wss' : 'ws';
    const url = `${proto}://${config.server}:${config.port}${config.path}`;
    log('WS connect to:', url, 'Host:', config.host + ':' + config.port);
    const ws = new WebSocket(url, {
      headers: { Host: config.host + ':' + config.port }
    });
    ws.on('open', () => {
      log('WS open, sending handshake for', targetHost + ':' + targetPort);
      const handshake = buildVlessHandshake(config.uuid, targetHost, targetPort);
      ws.send(handshake);
      resolve(ws);
    });
    ws.on('error', (err) => {
      log('WS error:', err.message);
      reject(err);
    });
    const t = setTimeout(() => {
      log('WS timeout after 10s');
      reject(new Error('WS timeout'));
    }, 10000);
    ws.on('open', () => clearTimeout(t));
  });
}

function handleConnect(req, clientSocket, head) {
  const [host, port] = req.url.split(':');
  const targetPort = parseInt(port) || 80;
  log('CONNECT', req.url, '->', host + ':' + targetPort);

  connectVless(host, targetPort).then((ws) => {
    log('VLESS connected for', host + ':' + targetPort);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) ws.send(head);
    clientSocket.on('data', (data) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
    ws.on('message', (data) => { if (!clientSocket.destroyed) clientSocket.write(data); });
    ws.on('close', () => { if (!clientSocket.destroyed) clientSocket.end(); });
    clientSocket.on('close', () => { try { ws.close(); } catch {} });
    clientSocket.on('error', () => { try { ws.close(); } catch {} });
    ws.on('error', () => { if (!clientSocket.destroyed) clientSocket.destroy(); });
  }).catch((err) => {
    log('Connect failed:', err.message, 'for', host + ':' + targetPort);
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    clientSocket.end();
  });
}

const server = http.createServer(handleConnect);
server.listen(PORT, '127.0.0.1', () => {
  log('Daemon proxy listening on 127.0.0.1:' + PORT);
});

function cleanup() {
  log('Daemon shutting down');
  try { fs.unlinkSync(PID_FILE); } catch {}
  try { fs.unlinkSync(CONFIG_FILE); } catch {}
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
process.on('disconnect', cleanup);
