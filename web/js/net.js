// WebSocket connection with automatic reconnect.
//
// connect(creds) sends `creds` as the join request: one of
//   { session }            rejoin with a session token
//   { key, name }          the GM key
//   { user_id, password }  a player account
// After the first welcome, reconnects use the session token instead, so the
// password is never kept around.

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

  connect(creds) {
    this.creds = creds;
    this.joined = false;
    this.closedByUser = false;
    this.ws?.close();
    this.open();
  }

  open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    let welcomed = false; // per socket: was this connection accepted?
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', ...this.creds }));
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'welcome') {
        welcomed = true;
        this.retry = 0;
        this.joined = true;
        this.creds = { session: msg.session };
        this.onStatus?.('online');
      }
      // A refused join (wrong password, expired session after a server
      // restart…) or a removed account must not retry forever.
      if (msg.type === 'error' && msg.message !== 'resync' && (!welcomed || /account was removed/i.test(msg.message))) {
        this.closedByUser = true;
        this.joined = false;
        msg.refused = true;
      }
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
