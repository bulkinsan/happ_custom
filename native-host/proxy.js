const http = require('http');
const net = require('net');
const { URL } = require('url');
const crypto = require('crypto');

let config = null;
let proxyServer = null;
const PORT = 18080;

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
  return new Promise((resolve, reject) => {
    if (!config) return reject(new Error('No VLESS config'));

    const WebSocket = require('ws');
    const proto = config.security === 'tls' ? 'wss' : 'ws';
    const url = `${proto}://${config.server}:${config.port}${config.path}`;

    const ws = new WebSocket(url, {
      headers: { Host: config.host + ':' + config.port },
      handshakeTimeout: 10000
    });

    ws.on('open', () => {
      const handshake = buildVlessHandshake(config.uuid, targetHost, targetPort);
      ws.send(handshake);
      resolve(ws);
    });

    ws.on('error', (err) => {
      reject(err);
    });

    setTimeout(() => reject(new Error('WS timeout')), 10000);
  });
}

function handleConnect(req, clientSocket, head) {
  const [host, port] = req.url.split(':');
  const targetPort = parseInt(port) || 80;

  connectVless(host, targetPort).then((ws) => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) ws.send(head);

    clientSocket.on('data', (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    ws.on('message', (data) => {
      if (!clientSocket.destroyed) clientSocket.write(data);
    });

    ws.on('close', () => { if (!clientSocket.destroyed) clientSocket.end(); });
    clientSocket.on('close', () => { if (ws.readyState === WebSocket.OPEN) ws.close(); });
    clientSocket.on('error', () => { try { ws.close(); } catch {} });
    ws.on('error', () => { if (!clientSocket.destroyed) clientSocket.destroy(); });
  }).catch((err) => {
    console.error('VLESS connect failed:', err.message);
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    clientSocket.end();
  });
}

function startProxy() {
  return new Promise((resolve, reject) => {
    proxyServer = http.createServer(handleConnect);
    proxyServer.on('error', reject);
    proxyServer.listen(PORT, '127.0.0.1', () => {
      console.log(`Proxy listening on 127.0.0.1:${PORT}`);
      resolve(PORT);
    });
  });
}

function stopProxy() {
  return new Promise((resolve) => {
    if (proxyServer) {
      proxyServer.close(() => { proxyServer = null; resolve(); });
    } else {
      resolve();
    }
  });
}

function readMessage(stream) {
  return new Promise((resolve, reject) => {
    const lenBuf = Buffer.alloc(4);
    let read = 0;
    const onLength = (chunk) => {
      lenBuf.writeUInt32LE(chunk.readUInt32LE(0), 0);
      const msgLen = lenBuf.readUInt32LE(0);
      if (msgLen === 0) return resolve(null);
      stream.removeListener('data', onLength);
      const msgBuf = Buffer.alloc(msgLen);
      let msgRead = 0;
      const onMsg = (chunk) => {
        chunk.copy(msgBuf, msgRead);
        msgRead += chunk.length;
        if (msgRead >= msgLen) {
          stream.removeListener('data', onMsg);
          resolve(JSON.parse(msgBuf.toString('utf8')));
        }
      };
      stream.on('data', onMsg);
    };
    stream.on('data', onLength);
    stream.on('error', reject);
  });
}

function sendMessage(stream, obj) {
  const json = JSON.stringify(obj);
  const buf = Buffer.from(json, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  stream.write(len);
  stream.write(buf);
}

async function main() {
  const msg = await readMessage(process.stdin);

  if (msg.action === 'start') {
    config = msg.config;
    try {
      const port = await startProxy();
      sendMessage(process.stdout, { success: true, port });
    } catch (err) {
      sendMessage(process.stdout, { success: false, error: err.message });
    }
  } else if (msg.action === 'stop') {
    await stopProxy();
    sendMessage(process.stdout, { success: true });
    process.exit(0);
  }

  while (true) {
    const msg = await readMessage(process.stdin);
    if (!msg) break;
    if (msg.action === 'stop') {
      await stopProxy();
      sendMessage(process.stdout, { success: true });
      process.exit(0);
    }
    if (msg.action === 'update') {
      config = msg.config;
      sendMessage(process.stdout, { success: true });
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
