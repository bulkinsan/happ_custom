const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function log(...args) { process.stderr.write(args.join(' ') + '\n'); }

const DAEMON_JS = path.join(__dirname, 'daemon.js');
const PID_FILE = path.join(__dirname, 'proxy.pid');
const CONFIG_FILE = path.join(__dirname, 'proxy-config.json');

function readMessage(stream) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const msgLen = buf.readUInt32LE(0);
        if (buf.length < 4 + msgLen) break;
        stream.removeListener('data', onData);
        const json = buf.slice(4, 4 + msgLen).toString('utf8');
        buf = Buffer.alloc(0);
        try { resolve(JSON.parse(json)); } catch (e) { reject(e); }
        return;
      }
    };
    stream.on('data', onData);
    stream.on('error', reject);
    stream.on('end', () => resolve(null));
  });
}

function sendMessage(stream, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  stream.write(len);
  stream.write(buf);
}

function getRunningPid() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    process.kill(pid, 0);
    return pid;
  } catch {
    try { fs.unlinkSync(PID_FILE); } catch {}
    return null;
  }
}

function startDaemon(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config));
  const child = spawn(process.execPath, [DAEMON_JS], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore']
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  log('Daemon started with PID:', child.pid);
  return child.pid;
}

function stopDaemon() {
  const pid = getRunningPid();
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    log('Daemon stopped, PID:', pid);
  }
  try { fs.unlinkSync(PID_FILE); } catch {}
  try { fs.unlinkSync(CONFIG_FILE); } catch {}
}

async function main() {
  const msg = await readMessage(process.stdin);
  if (!msg || !msg.action) process.exit(1);

  if (msg.action === 'start') {
    const existingPid = getRunningPid();
    if (existingPid) {
      sendMessage(process.stdout, { success: true, port: 18080 });
      process.exit(0);
      return;
    }
    try {
      startDaemon(msg.config);
      sendMessage(process.stdout, { success: true, port: 18080 });
    } catch (err) {
      sendMessage(process.stdout, { success: false, error: err.message });
    }
  } else if (msg.action === 'stop') {
    stopDaemon();
    sendMessage(process.stdout, { success: true });
  } else if (msg.action === 'status') {
    const pid = getRunningPid();
    sendMessage(process.stdout, { running: !!pid, port: 18080, pid });
  }
}

main().catch(() => process.exit(1));
