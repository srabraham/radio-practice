// WebSocket link to the server with automatic reconnect. Phones drop sockets
// whenever the screen sleeps, so reconnecting quietly matters.

export class Link {
  constructor({ onMessage, onAudio, onStatus }) {
    this.onMessage = onMessage;
    this.onAudio = onAudio;
    this.onStatus = onStatus || (() => {});
    this.seq = 0;
    this.backoff = 500;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => { this.backoff = 500; this.onStatus('online'); };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        this.onMessage(JSON.parse(e.data));
        return;
      }
      const b = new Uint8Array(e.data);
      // [ch u8][sid u16][quality u8][seq u16][payload]
      this.onAudio(b[0], (b[1] << 8) | b[2], b[3] / 255, b.subarray(6));
    };
    ws.onclose = async () => {
      this.onStatus('offline');
      const me = await fetch('/api/me').catch(() => null);
      if (me && me.status === 401) {
        location.href = '/';
        return;
      }
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 8000);
    };
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  sendAudio(frame) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const out = new Uint8Array(2 + frame.length);
    out[0] = (this.seq >> 8) & 0xff;
    out[1] = this.seq & 0xff;
    out.set(frame, 2);
    this.seq = (this.seq + 1) & 0xffff;
    this.ws.send(out);
  }
}

export async function me() {
  const r = await fetch('/api/me');
  return r.ok ? r.json() : null;
}
