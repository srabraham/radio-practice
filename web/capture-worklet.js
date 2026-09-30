// Resamples the (already band-limited) mic signal to 8 kHz, μ-law encodes it,
// and posts 20 ms frames (160 bytes) to the main thread while active.

const FRAME = 160;

function linToUlaw(x) {
  let s = Math.max(-1, Math.min(1, x)) * 32767 | 0;
  const sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > 32635) s = 32635;
  s += 0x84;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1);
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 8000;
    this.pos = 0;
    this.buf = new Uint8Array(FRAME);
    this.n = 0;
    this.active = false;
    this.port.onmessage = (e) => {
      this.active = e.data.active;
      this.n = 0;
      this.pos = 0;
    };
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input || !this.active) return true;
    while (this.pos < input.length) {
      const i = Math.floor(this.pos);
      const f = this.pos - i;
      const s = i + 1 < input.length ? input[i] * (1 - f) + input[i + 1] * f : input[i];
      this.buf[this.n++] = linToUlaw(s);
      if (this.n === FRAME) {
        this.port.postMessage(this.buf.slice());
        this.n = 0;
      }
      this.pos += this.step;
    }
    this.pos -= input.length;
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
