// Injected before any page script runs (see fixtures.ts). It gives every
// browser the same controllable microphone and lets tests observe what the
// page actually sends to the speakers.
//
//   window.__mic  - a synthetic mic: an oscillator on the page's own
//                   AudioContext, so it works in every engine without device
//                   permissions. Tests change its frequency and level, or make
//                   getUserMedia fail the way a real browser would.
//   window.__tap  - every connection to ctx.destination is also fed to an
//                   AnalyserNode, sampled every 20 ms into __tap.log.
(() => {
  const cfg = window.__E2E_AUDIO || {};
  const Base = window.AudioContext || window.webkitAudioContext;
  if (!Base) return;

  // Frequencies the app produces: received voice (the test mic's 700 Hz), busy
  // bonk (440/330), a second test voice (600), message beep (880), TOT warn/alarm (1000), talk permit
  // (1400/1900), and the FM hiss band (2200).
  const BANDS = [330, 440, 600, 700, 880, 1000, 1400, 1900, 2200];
  const contexts = [];
  const taps = new Map();
  const connect = AudioNode.prototype.connect;

  const tap = {
    log: [],
    contexts,
    // The last context the app created (the console and radio make one each).
    ctx: () => contexts[contexts.length - 1],
    state: () => tap.ctx()?.state ?? 'none',
    // Wall-clock ms, so timelines from different pages line up.
    now: () => performance.timeOrigin + performance.now(),
    clear: () => { tap.log.length = 0; },
  };
  window.__tap = tap;

  function tapFor(ctx) {
    let t = taps.get(ctx);
    if (t) return t;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;
    // An analyser has to be pulled by the graph in some engines. Route it to
    // the destination through a muted gain so it adds nothing audible.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    connect.call(analyser, mute);
    connect.call(mute, ctx.destination);
    const freq = new Float32Array(analyser.frequencyBinCount);
    const time = new Float32Array(analyser.fftSize);
    const binHz = ctx.sampleRate / analyser.fftSize;
    const level = (hz) => {
      const b = Math.round(hz / binHz);
      let m = -Infinity;
      for (let i = Math.max(0, b - 1); i <= b + 1; i++) m = Math.max(m, freq[i]);
      return m;
    };
    setInterval(() => {
      if (ctx.state === 'closed') return;
      analyser.getFloatFrequencyData(freq);
      analyser.getFloatTimeDomainData(time);
      let sum = 0;
      for (const v of time) sum += v * v;
      const rms = 10 * Math.log10(sum / time.length + 1e-12);
      let peak = 0;
      const lo = Math.round(200 / binHz), hi = Math.round(4000 / binHz);
      for (let i = lo; i < hi; i++) if (freq[i] > freq[peak] || peak === 0) peak = i;
      // Median level across the voice band: a tone stands well above it, noise doesn't.
      const voice = Array.from(freq.subarray(lo, hi)).sort((a, b) => a - b);
      const bands = {};
      for (const hz of BANDS) bands[hz] = level(hz);
      tap.log.push({
        t: tap.now(),
        state: ctx.state,
        rms,
        peakHz: Math.round(peak * binHz),
        peakDb: freq[peak],
        floor: voice[voice.length >> 1],
        bands,
      });
      if (tap.log.length > 3000) tap.log.splice(0, 1000);
    }, 20);
    taps.set(ctx, analyser);
    return analyser;
  }

  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode) connect.call(this, tapFor(this.context));
    return connect.call(this, dest, ...rest);
  };

  class TrackedAudioContext extends Base {
    constructor(...args) {
      super(...args);
      contexts.push(this);
    }
  }
  window.AudioContext = TrackedAudioContext;
  if (window.webkitAudioContext) window.webkitAudioContext = TrackedAudioContext;

  if (!cfg.fakeMic) return;

  const mic = {
    freq: cfg.micFreq ?? 700,
    level: cfg.micLevel ?? 0.5,
    // null, or the DOMException name getUserMedia should reject with.
    fail: cfg.micFail ?? null,
    calls: 0,
    stream: null,
    set({ freq, level, fail } = {}) {
      if (fail !== undefined) mic.fail = fail;
      if (freq !== undefined) {
        mic.freq = freq;
        mic.osc?.frequency.setValueAtTime(freq, mic.osc.context.currentTime);
      }
      if (level !== undefined) {
        mic.level = level;
        mic.gain?.gain.setValueAtTime(level, mic.gain.context.currentTime);
      }
    },
  };
  window.__mic = mic;

  const md = navigator.mediaDevices;
  // Report which fake device a track came from. Keyed by track id: WebKit
  // doesn't keep expando properties on track wrappers.
  const trackDevice = new Map();
  const getSettings = MediaStreamTrack.prototype.getSettings;
  MediaStreamTrack.prototype.getSettings = function () {
    const s = getSettings.call(this);
    return trackDevice.has(this.id) ? { ...s, deviceId: trackDevice.get(this.id) } : s;
  };
  md.getUserMedia = async (constraints) => {
    mic.calls++;
    mic.constraints = constraints;
    if (mic.fail) throw new DOMException('fake mic: ' + mic.fail, mic.fail);
    const ctx = tap.ctx();
    if (!ctx) throw new DOMException('no AudioContext yet', 'NotReadableError');
    if (!mic.osc) {
      mic.osc = ctx.createOscillator();
      mic.osc.frequency.value = mic.freq;
      mic.gain = ctx.createGain();
      mic.gain.gain.value = mic.level;
      connect.call(mic.osc, mic.gain);
      mic.osc.start();
    }
    const want = constraints?.audio?.deviceId?.exact;
    const mics = mic.devices.filter((d) => d.kind === 'audioinput');
    if (want && !mics.some((d) => d.deviceId === want)) {
      throw new DOMException('fake mic: no device ' + want, 'OverconstrainedError');
    }
    const deviceId = want || mics[0]?.deviceId || '';
    const dest = ctx.createMediaStreamDestination();
    connect.call(mic.gain, dest);
    trackDevice.set(dest.stream.getAudioTracks()[0].id, deviceId);
    mic.stream = dest.stream;
    mic.deviceId = deviceId;
    return dest.stream;
  };
  mic.devices = [
    { kind: 'audioinput', deviceId: 'fake-mic-1', groupId: 'g1', label: 'Fake mic 1' },
    { kind: 'audioinput', deviceId: 'fake-mic-2', groupId: 'g2', label: 'Fake mic 2' },
    { kind: 'audiooutput', deviceId: 'fake-spk-1', groupId: 'g1', label: 'Fake speaker 1' },
  ];
  md.enumerateDevices = async () => mic.devices.map((d) => ({ ...d, toJSON: () => d }));
  // Simulates plugging in or pulling out a device.
  mic.setDevices = (devices) => {
    mic.devices = devices;
    md.dispatchEvent(new Event('devicechange'));
  };
})();
