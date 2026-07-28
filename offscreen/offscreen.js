const port = chrome.runtime.connect({ name: 'ws-proxy' });
const pending = {};

port.onMessage.addListener((msg) => {
  if (msg.type === 'WS_CREATE') {
    const ws = new WebSocket(msg.url);
    ws.onopen = () => port.postMessage({ type: 'WS_OPEN', reqId: msg.reqId });
    ws.onmessage = async (e) => {
      const buf = await e.data.arrayBuffer();
      port.postMessage({ type: 'WS_DATA', reqId: msg.reqId, data: Array.from(new Uint8Array(buf)) });
    };
    ws.onerror = () => port.postMessage({ type: 'WS_ERR', reqId: msg.reqId });
    pending[msg.reqId] = ws;
  }
  if (msg.type === 'WS_SEND') {
    const ws = pending[msg.reqId];
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(new Uint8Array(msg.data));
      port.postMessage({ type: 'WS_SEND_OK', reqId: msg.reqId });
    } else {
      port.postMessage({ type: 'WS_SEND_ERR', reqId: msg.reqId });
    }
  }
});

port.postMessage({ type: 'READY' });
