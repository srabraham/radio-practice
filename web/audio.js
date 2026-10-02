// Mic capture, receive-side playback, and the "sounds like a radio" effects:
// band-limiting, FM hiss and squelch tails, FM doubling, and alert tones.

const RATE = 8000;
const JITTER = 0.1; // seconds of buffering before playout
const ACTIVE_MS = 150; // a stream with no frame for this long is idle

const ULAW = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const exp = (u >> 4) & 7;
  const mag = (((u & 0x0f) << 3) + 0x84 << exp) - 0x84;
  ULAW[i] = (u & 0x80 ? -mag : mag) / 32768;
}

export class RadioAudio {
  // clean: monitor mode for the instructor console. Every stream is mixed
  // straight through with no doubling effect or noise.
  constructor({ clean = false } = {}) {
    this.clean = clean;
    this.streams = new Map();
    this.onFrame = null;
    this.onMicLevel = null; // ({ db, open }) about 20 times a second
    this.onSpeakerState = null; // the AudioContext started or stopped running
  }

  // Must be called from a user gesture (autoplay + mic permission rules).
  // mic / speaker: saved device IDs; a device that has gone away falls back
  // to the system default.
  async init({ mic = '', speaker = '' } = {}) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    ctx.onstatechange = () => this.onSpeakerState && this.onSpeakerState();
    // Not awaited: if the gesture has expired by now (e.g. login took a
    // while) the browser keeps the context suspended and this promise pending
    // until a later gesture, which would hang power-on.
    ctx.resume().catch(() => {});
    if (speaker) await this.setSpeaker(speaker).catch(() => {});

    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(ctx.destination);

    // Everything received passes through a radio-ish voice chain.
    this.rxBus = ctx.createGain();
    const hp = biquad(ctx, 'highpass', 300);
    const lp = biquad(ctx, 'lowpass', 3000);
    const shaper = ctx.createWaveShaper();
    shaper.curve = softClip(2.5);
    this.rxBus.connect(hp).connect(lp).connect(shaper).connect(this.master);

    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    noise.loop = true;
    const noiseBand = biquad(ctx, 'bandpass', 2200, 0.4);
    this.hiss = ctx.createGain();
    this.hiss.gain.value = 0;
    this.tail = ctx.createGain();
    this.tail.gain.value = 0;
    noise.connect(noiseBand);
    noiseBand.connect(this.hiss).connect(this.master);
    noiseBand.connect(this.tail).connect(this.master);
    noise.start();

    // Heterodyne whine heard when two FM carriers of similar strength collide.
    this.het = ctx.createOscillator();
    this.het.type = 'sawtooth';
    this.hetGain = ctx.createGain();
    this.hetGain.gain.value = 0;
    this.het.connect(this.hetGain).connect(this.rxBus);
    this.het.start();

    this.timer = setInterval(() => this.update(), 30);

    // Without a mic the radio still works receive-only.
    try {
      await this.initMic(mic);
    } catch (e) {
      this.micError = e;
    }
  }

  async initMic(deviceId) {
    const ctx = this.ctx;
    await ctx.audioWorklet.addModule('capture-worklet.js');
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -30;
    comp.ratio.value = 8;
    this.capture = new AudioWorkletNode(ctx, 'capture', { numberOfOutputs: 1 });
    this.capture.port.onmessage = (e) => this.onFrame && this.onFrame(e.data);
    const level = new AudioWorkletNode(ctx, 'level');
    level.port.onmessage = (e) => this.onMicLevel && this.onMicLevel(e.data);
    this.micIn = biquad(ctx, 'highpass', 300);
    this.micIn.connect(biquad(ctx, 'lowpass', 3000)).connect(level).connect(comp).connect(this.capture);
    // Keep the worklet pulled by the graph without making it audible.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    this.capture.connect(sink).connect(ctx.destination);

    await this.openMic(deviceId);
  }

  // Another go at the mic after init failed, e.g. the user blocked it by
  // mistake. Must be called from a user gesture.
  async retryMic(deviceId) {
    if (!this.micIn) await this.initMic(deviceId);
    else await this.openMic(deviceId);
  }

  async openMic(deviceId) {
    try {
      await this.setMic(deviceId);
    } catch (e) {
      if (!deviceId || e.name !== 'OverconstrainedError') throw e;
      await this.setMic('');
    }
  }

  // Swaps the capture source. The old stream is kept if the new one fails.
  async setMic(deviceId) {
    if (!this.micIn) throw new Error('audio capture unavailable');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // AGC would boost distant sound (e.g. a nearby radio's speaker) in the
        // pauses between speech, which is what drives feedback between devices.
        echoCancellation: true, noiseSuppression: true, autoGainControl: false,
        ...(deviceId && { deviceId: { exact: deviceId } }),
      },
    });
    this.micSource?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = stream;
    this.micSource = this.ctx.createMediaStreamSource(stream);
    this.micSource.connect(this.micIn);
    this.micError = null;
  }

  micId() { return this.stream?.getAudioTracks()[0]?.getSettings().deviceId || ''; }

  // AudioContext.setSinkId is Chromium-only so far.
  canSetSpeaker() { return typeof this.ctx?.setSinkId === 'function'; }
  setSpeaker(deviceId) { return this.ctx.setSinkId(deviceId); }

  // Suspended by autoplay rules, or "interrupted" on iOS (e.g. a phone call).
  // Nothing plays and the mic isn't processed until it runs again.
  speakerBlocked() { return this.ctx.state !== 'running'; }
  // Must be called from a user gesture.
  resumeSpeaker() { return this.ctx.resume(); }

  setVolume(v) { this.master.gain.value = v; }

  startCapture() { this.capture?.port.postMessage({ active: true }); }
  stopCapture() { this.capture?.port.postMessage({ active: false }); }

  // A received frame. mode is the channel's mode.
  frame(ch, sid, payload, mode) {
    const key = ch + ':' + sid;
    let s = this.streams.get(key);
    if (!s) {
      const gain = this.ctx.createGain();
      gain.connect(this.rxBus);
      s = { key, ch, sid, mode, gain, nextTime: 0, lastAt: 0 };
      this.streams.set(key, s);
    }
    s.lastAt = performance.now();

    const pcm = new Float32Array(payload.length);
    for (let i = 0; i < payload.length; i++) pcm[i] = ULAW[payload[i]];

    const buf = this.upsample(pcm);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(s.gain);
    const now = this.ctx.currentTime;
    if (s.nextTime < now) s.nextTime = now + JITTER;
    src.start(s.nextTime);
    s.nextTime += buf.duration;
  }

  // Transmission over. FM receivers hear a burst of noise as the carrier
  // drops before the squelch closes.
  end(ch, sid) {
    const s = this.streams.get(ch + ':' + sid);
    if (!s) return;
    this.streams.delete(s.key);
    const at = Math.max(this.ctx.currentTime, s.nextTime);
    setTimeout(() => s.gain.disconnect(), (at - this.ctx.currentTime + 1) * 1000);
    if (s.mode === 'fm-simplex' && !this.clean && s.lastAt > 0) {
      const g = this.tail.gain;
      g.setValueAtTime(0.25, at);
      g.setValueAtTime(0, at + 0.16);
    }
  }

  active() {
    const now = performance.now();
    return [...this.streams.values()].filter((s) => now - s.lastAt < ACTIVE_MS);
  }

  update() {
    const t = this.ctx.currentTime;
    const active = this.active();
    // Streams whose rx_end we never saw (e.g. we tuned away mid-call).
    for (const s of this.streams.values()) {
      if (performance.now() - s.lastAt > 5000) {
        this.streams.delete(s.key);
        s.gain.disconnect();
      }
    }
    let hiss = 0, het = 0;

    if (this.clean) {
      for (const s of this.streams.values()) s.gain.gain.setTargetAtTime(1, t, 0.01);
    } else {
      const fm = active.filter((s) => s.mode === 'fm-simplex');
      for (const s of active) if (s.mode !== 'fm-simplex') s.gain.gain.setTargetAtTime(1, t, 0.01);
      if (fm.length) {
        hiss = 0.02; // open squelch
        if (fm.length > 1) {
          // Two talkers at once: neither captures the receiver. Garbled mix.
          fm.forEach((s) => s.gain.gain.setTargetAtTime(0.55, t, 0.01));
          het = 0.08;
          hiss += 0.15;
          this.het.frequency.setTargetAtTime(600 + Math.random() * 1800, t, 0.05);
        } else {
          fm[0].gain.gain.setTargetAtTime(1, t, 0.01);
        }
      }
    }
    this.hiss.gain.setTargetAtTime(hiss, t, 0.03);
    this.hetGain.gain.setTargetAtTime(het, t, 0.03);
  }

  upsample(pcm) {
    const rate = this.ctx.sampleRate;
    const n = Math.floor(pcm.length * rate / RATE);
    const buf = this.ctx.createBuffer(1, n, rate);
    const out = buf.getChannelData(0);
    const step = RATE / rate;
    for (let i = 0; i < n; i++) {
      const p = i * step, j = Math.floor(p), f = p - j;
      out[i] = pcm[j] * (1 - f) + (pcm[j + 1] ?? pcm[j]) * f;
    }
    return buf;
  }

  // ---- tones ----

  beep(freq, dur, { when = 0, type = 'square', vol = 0.12 } = {}) {
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.setValueAtTime(0, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  toneBusy() { this.beep(440, 0.15); this.beep(330, 0.3, { when: 0.16 }); }
  tonePermit() { this.beep(1400, 0.05, { type: 'sine', vol: 0.2 }); this.beep(1900, 0.06, { when: 0.06, type: 'sine', vol: 0.2 }); }
  toneTotWarn() { this.beep(1000, 0.08, { type: 'sine', vol: 0.15 }); }

  alarm(on) {
    if (on && !this.alarmOsc) {
      this.alarmOsc = this.ctx.createOscillator();
      this.alarmOsc.frequency.value = 1000;
      const g = this.ctx.createGain();
      g.gain.value = 0.08;
      this.alarmOsc.connect(g).connect(this.master);
      this.alarmOsc.start();
    } else if (!on && this.alarmOsc) {
      this.alarmOsc.stop();
      this.alarmOsc = null;
    }
  }
}

function biquad(ctx, type, freq, q) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  if (q !== undefined) f.Q.value = q;
  return f;
}

function softClip(k) {
  const n = 1024, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * 2 / n - 1;
    c[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return c;
}
