// WebSocket connection with automatic reconnect.

export class Connection {
  constructor({ onMessage, onStatus }) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.ws = null;
    this.creds = null;
    this.retry = 0;
    this.nextReq = 1;
    this.joined = false;
    this.closedByUser = false;
  }

  connect(name, key) {
    this.creds = { name, key: key || null };
    this.closedByUser = false;
    this.open();
  }

  open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', ...this.creds }));
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'welcome') { this.retry = 0; this.joined = true; this.onStatus?.('online'); }
      if (msg.type === 'error' && !this.joined) { this.closedByUser = true; }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws || this.closedByUser) return;
      this.onStatus?.('offline');
      const delay = Math.min(10000, 500 * 2 ** this.retry++);
      setTimeout(() => this.open(), delay);
    };
  }

  close() {
    this.closedByUser = true;
    this.joined = false;
    this.ws?.close();
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Send an op; returns its request id (echoed back on rejection). */
  op(op) {
    const req = this.nextReq++;
    this.send({ type: 'op', op, req });
    return req;
  }
}
