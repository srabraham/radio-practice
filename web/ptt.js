// Transmit-side state machine shared by the radio and the instructor console.
//
//   idle ──down──▶ waiting (digital: until the repeater grants) ──tx_ok──▶ tx
//   idle ──down──▶ tx (analog: keys immediately)
//   waiting ──tx_deny──▶ denied    tx ──tx_end──▶ alarm (TOT or forced)
//   tx ──tx_end(vog)──▶ preempted (Control's Voice of God; receives meanwhile)
//   any ──up──▶ idle
//
// Capture starts on press even for digital, so anything said before the
// talk-permit tone is lost, just like a real repeater. The server also drops
// the first half second after the tone, mimicking repeater key-up latency.

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

  // A preempted radio still has PTT held down but is back to receiving, so
  // the user hears the Voice of God call that cut them off.
  get keyed() { return this.state !== 'idle' && this.state !== 'preempted'; }

  // vog keys every repeater channel at once (instructor only).
  down(ch, mode, vog = false) {
    if (this.state !== 'idle') return;
    this.ch = ch;
    this.vog = vog;
    this.state = mode === 'digital-repeater' ? 'waiting' : 'tx';
    this.startedAt = performance.now();
    this.audio.startCapture();
    this.link.send({ t: 'key', ch, vog });
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
        this.audio.toneBusy();
        this.state = 'denied';
        this.reason = m.reason;
        break;
      case 'tx_end':
        // Crossed with our own unkey: the user already let go.
        if (this.state === 'idle') return;
        this.stop();
        if (m.reason === 'vog') {
          this.audio.toneBusy();
          this.state = 'preempted';
          this.reason = m.reason;
          break;
        }
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
      const { id, mode, vog } = channel();
      this.down(id, mode, vog);
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

    // The space bar anywhere, or Enter on the focused button. Both follow the
    // latch setting, so tap to talk also works for people who can't hold a key.
    const typing = (e) => /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox';
    const pttKey = (e) => (e.code === 'Space' && !typing(e)) || (e.key === 'Enter' && e.target === button);
    window.addEventListener('keydown', (e) => {
      if (!pttKey(e)) return;
      e.preventDefault();
      if (e.repeat) return;
      if (latched()) this.state === 'idle' ? press() : this.up();
      else press();
    });
    window.addEventListener('keyup', (e) => {
      if (!pttKey(e)) return;
      e.preventDefault();
      if (!latched()) this.up();
    });
    // A held button or space bar never sees its release once focus leaves, so
    // unkey then. A latched transmit is deliberate and keeps going in the
    // background (handy for testing with two windows); TOT still bounds it.
    const lostFocus = () => { if (!latched()) this.up(); };
    window.addEventListener('blur', lostFocus);
    document.addEventListener('visibilitychange', () => document.hidden && lostFocus());
  }
}
