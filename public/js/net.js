/* net.js — WebSocket 래퍼. JSON 메시지 송수신 + RTT 측정. */
export class Net {
  constructor() {
    this.ws = null;
    this.handlers = {};
    this.rtt = 0;
    this._pingTimer = null;
  }

  connect(onOpen, onClose) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}`);
    this.ws.onopen = () => {
      this._pingTimer = setInterval(() => {
        this.send({ type: 'PING', t: performance.now() });
      }, 1000);
      onOpen && onOpen();
    };
    this.ws.onclose = () => {
      clearInterval(this._pingTimer);
      onClose && onClose();
    };
    this.ws.onerror = () => {};
    this.ws.onmessage = (e) => {
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

  on(type, fn) { this.handlers[type] = fn; }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
    }
  }
}
