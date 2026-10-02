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

// Passes the mic through unchanged and reports its level for the settings meter.
class LevelProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.env = 0;
    const coef = (secs) => 1 - Math.exp(-1 / (secs * sampleRate));
    this.envAttack = coef(0.002);
    this.envRelease = coef(0.1);
    this.reportLen = Math.round(0.05 * sampleRate);
    this.sinceReport = 0;
  }

  process(inputs, outputs) {
    // Firefox passes no channels at all once the source is silent (e.g. a
    // muted mic). Treat that as silence so the meter still falls.
    const input = inputs[0] || [], output = outputs[0];
    const mono = input[0];
    const n = mono ? mono.length : (output[0]?.length ?? 128);
    for (let i = 0; i < n; i++) {
      const a = mono ? Math.abs(mono[i]) : 0;
      this.env += (a - this.env) * (a > this.env ? this.envAttack : this.envRelease);
      for (let c = 0; c < output.length; c++) output[c][i] = mono ? (input[c] || mono)[i] : 0;
    }
    this.sinceReport += n;
    if (this.sinceReport >= this.reportLen) {
      this.sinceReport = 0;
      this.port.postMessage({ db: 20 * Math.log10(this.env + 1e-9) });
    }
    return true;
  }
}

registerProcessor('level', LevelProcessor);
