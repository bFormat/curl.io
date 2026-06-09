/* net.js — WebSocket 래퍼. JSON 송수신 + RTT 측정 + 자동 재접속(지수 백오프). */
export class Net {
  constructor() {
    this.ws = null;
    this.handlers = {};
    this.rtt = 0;
    this._pingTimer = null;
    this._reconnectTimer = null;
    this._onOpen = null;
    this._onStatus = null;
    this._stopped = true;
    this._attempt = 0;
  }

  /* onOpen: 연결될 때마다 호출(첫 연결 + 재연결) — JOIN을 다시 보내야 한다.
   * onStatus: {state:'connecting'|'open'|'lost'|'gone', attempt} 상태 알림. */
  connect(onOpen, onStatus) {
    this._onOpen = onOpen;
    this._onStatus = onStatus;
    this._stopped = false;
    this._attempt = 0;
    this._open();
  }

  close() {
    this._stopped = true;
    clearTimeout(this._reconnectTimer);
    clearInterval(this._pingTimer);
    if (this.ws) this.ws.close();
  }

  _open() {
    if (this._stopped) return;
    this._status('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}`);
    this.ws = ws;
    ws.onopen = () => {
      this._attempt = 0;
      this._pingTimer = setInterval(() => {
        this.send({ type: 'PING', t: performance.now() });
      }, 1000);
      this._status('open');
      this._onOpen && this._onOpen();
    };
    ws.onclose = () => {
      clearInterval(this._pingTimer);
      if (this._stopped) return;
      if (this._attempt >= 6) { this._status('gone'); return; }
      const delay = Math.min(8000, 500 * Math.pow(2, this._attempt));
      this._attempt++;
      this._status('lost');
      this._reconnectTimer = setTimeout(() => this._open(), delay);
    };
    ws.onerror = () => {};
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      if (msg.type === 'PONG') {
        this.rtt = performance.now() - msg.t;
        return;
      }
      const h = this.handlers[msg.type];
      if (h) h(msg);
    };
  }

  _status(state) {
    if (this._onStatus) this._onStatus({ state, attempt: this._attempt });
  }

  on(type, fn) { this.handlers[type] = fn; }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
    }
  }
}
