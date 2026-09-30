// Transmit-side state machine shared by the radio and the instructor console.
//
//   idle ──down──▶ waiting (digital: until the repeater grants) ──tx_ok──▶ tx
//   idle ──down──▶ tx (analog: keys immediately)
//   waiting ──tx_deny──▶ denied    tx ──tx_end──▶ alarm (TOT or forced)
//   any ──up──▶ idle
//
// Capture starts on press even for digital, so anything said before the
// talk-permit tone is lost, just like a real repeater.

export class Transmitter {
  constructor({ link, audio, tot, onChange }) {
    this.link = link;
    this.audio = audio;
    this.tot = tot;
    this.onChange = onChange || (() => {});
    this.state = 'idle';
    this.reason = '';
    audio.onFrame = (f) => {
      if (this.state === 'tx' || this.state === 'waiting') link.sendAudio(f);
    };
  }

  get keyed() { return this.state !== 'idle'; }

  down(ch, mode) {
    if (this.state !== 'idle') return;
    this.ch = ch;
    this.state = mode === 'digital-repeater' ? 'waiting' : 'tx';
    this.startedAt = performance.now();
    this.audio.startCapture();
    this.link.send({ t: 'key', ch });
    if (this.tot > 6) {
      this.warn = setTimeout(() => this.state === 'tx' && this.audio.toneTotWarn(), (this.tot - 5) * 1000);
    }
    this.onChange();
  }

  up() {
    if (this.state === 'tx' || this.state === 'waiting') this.link.send({ t: 'unkey' });
    this.reset();
  }

  handle(m) {
    switch (m.t) {
      case 'tx_ok':
        if (this.state === 'waiting') this.audio.tonePermit();
        if (this.state === 'waiting' || this.state === 'tx') this.state = 'tx';
        break;
      case 'tx_deny':
        if (this.state !== 'waiting') return;
        this.stop();
        m.reason === 'no_repeater' ? this.audio.toneNoRepeater() : this.audio.toneBusy();
        this.state = 'denied';
        this.reason = m.reason;
        break;
      case 'tx_end':
        this.stop();
        this.audio.alarm(true);
        this.state = 'alarm';
        this.reason = m.reason;
        break;
      default:
        return;
    }
    this.onChange();
  }

  stop() {
    this.audio.stopCapture();
    clearTimeout(this.warn);
  }

  reset() {
    this.stop();
    this.audio.alarm(false);
    this.state = 'idle';
    this.reason = '';
    this.onChange();
  }

  // Wires a button (press-and-hold, or tap-to-latch) and the space bar.
  bind(button, { latched, channel }) {
    const press = () => {
      const { id, mode } = channel();
      this.down(id, mode);
    };
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      button.setPointerCapture(e.pointerId);
      if (latched()) this.state === 'idle' ? press() : this.up();
      else press();
    });
    const release = () => { if (!latched()) this.up(); };
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('contextmenu', (e) => e.preventDefault());

    const typing = (e) => /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox';
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || typing(e)) return;
      e.preventDefault();
      if (!e.repeat) press();
    });
    window.addEventListener('keyup', (e) => {
      if (e.code !== 'Space' || typing(e)) return;
      e.preventDefault();
      this.up();
    });
    // Never leave a mic stuck open when the tab loses focus or the phone sleeps.
    window.addEventListener('blur', () => this.up());
    document.addEventListener('visibilitychange', () => document.hidden && this.up());
  }
}
