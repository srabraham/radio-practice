import { RadioAudio } from './audio.js';
import { Link } from './net.js';
import { Transmitter } from './ptt.js';
import { logout, savedDevices, bindDevices, mount } from './common.js';
import { initAppControls, controlsMessage } from './controls.js';

const $ = (id) => document.getElementById(id);
const SCAN_HANG_MS = 3000;
const VOG = 'voice-of-god';

let audio, link, tx, me;
let channels = [];
let ch = localStorage.getItem('rp.ch') === null ? null : Number(localStorage.getItem('rp.ch'));
let scanning = localStorage.getItem('rp.scan') === '1';
// While scanning or on Voice of God: { ch, until } for the channel we stopped on.
let landed = null;
const callers = new Map(); // "ch:sid" -> callsign (digital caller ID)

export async function powerOn(who) {
  audio = new RadioAudio();
  try {
    await audio.init(savedDevices());
  } catch (e) {
    $('login-error').textContent = 'Microphone unavailable: ' + e.message;
    return;
  }
  mount('radio-view');
  me = who.callsign;
  $('me').textContent = me;
  bindDevices(audio);
  navigator.wakeLock?.request('screen').catch(() => {});

  link = new Link({ onMessage, onAudio, onStatus: netStatus });
  tx = new Transmitter({ link, audio, tot: 60, onChange: render });
  tx.bind($('ptt'), {
    latched: () => $('latch').checked,
    channel: () => ({ id: txChannel(), mode: channels[txChannel()]?.mode }),
  });
  initAppControls(link, me);
  link.connect();
  bindControls();
  setInterval(render, 100);
}

function onMessage(m) {
  switch (m.t) {
    case 'hello':
      channels = m.channels;
      tx.tot = m.tot;
      if (!Number.isInteger(ch) || ch < 0 || ch >= channels.length) {
        ch = Math.max(0, channels.findIndex((c) => c.default));
      }
      // The server starts every connection fresh; restore our knobs.
      link.send({ t: 'tune', ch });
      sendScan();
      controlsMessage(m);
      break;
    case 'rx_start':
      if (m.from) callers.set(m.ch + ':' + m.sid, m.from);
      break;
    case 'rx_end':
      audio.end(m.ch, m.sid);
      callers.delete(m.ch + ':' + m.sid);
      break;
    case 'state':
      controlsMessage(m);
      return;
    case 'msg':
      controlsMessage(m);
      if (m.from !== me) showMessage(m);
      break;
    default:
      tx.handle(m);
  }
  render();
}

function onAudio(c, sid, payload) {
  if (tx.keyed) return;
  const now = performance.now();
  if (!scanning && !hears(ch, c)) return;
  // A scanning radio stops on the first busy channel and stays there until
  // it has been quiet for the hang time. Voice of God listens to every
  // repeater the same way, so two talkers on different ones don't mix.
  if (scanning || channels[ch].mode === VOG) {
    if (landed && landed.ch !== c && now < landed.until) return;
    landed = { ch: c, until: now + SCAN_HANG_MS };
  }
  audio.frame(c, sid, payload, channels[c].mode);
}

// Whether a radio tuned to channel `tuned` hears traffic on channel c.
function hears(tuned, c) {
  return c === tuned || (channels[tuned].mode === VOG && channels[c].mode === 'digital-repeater');
}

function sendScan() {
  link.send({ t: 'scan', on: scanning, list: channels.filter((c) => c.mode !== VOG).map((c) => c.id) });
}

// Keying during scan hang time talks back on the channel we stopped on.
function txChannel() {
  if (scanning && landed && performance.now() < landed.until) return landed.ch;
  return ch;
}

function displayChannel() {
  return tx.keyed ? tx.ch : txChannel();
}

function bindControls() {
  const tune = (d) => {
    if (tx.keyed || !channels.length) return;
    ch = (ch + d + channels.length) % channels.length;
    localStorage.setItem('rp.ch', ch);
    landed = null;
    link.send({ t: 'tune', ch });
    render();
  };
  $('ch-up').onclick = () => tune(1);
  $('ch-down').onclick = () => tune(-1);
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') tune(1);
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') tune(-1);
  });
  $('scan').onclick = () => {
    scanning = !scanning;
    localStorage.setItem('rp.scan', scanning ? '1' : '0');
    landed = null;
    sendScan();
    render();
  };
  $('volume').oninput = (e) => audio.setVolume(Number(e.target.value));
  $('logout').onclick = (e) => { e.preventDefault(); logout(); };
}

function render() {
  if (!channels.length) return;
  const dc = displayChannel();
  const c = channels[dc];
  const digital = c.mode !== 'fm-simplex';
  $('chnum').textContent = 'CH ' + (dc + 1);
  $('chname').textContent = c.name;
  $('chsub').hidden = c.mode !== VOG;
  $('mode').textContent = digital ? 'DIG' : 'FM';
  $('scan-ind').hidden = !scanning;
  $('scan').classList.toggle('on', scanning);
  $('scan').setAttribute('aria-pressed', scanning);

  const heard = audio.active().filter((s) => hears(dc, s.ch));

  const isLanded = landed && performance.now() < landed.until;
  let status = scanning && !isLanded ? 'SCANNING' : 'READY';
  if (heard.length) {
    const from = heard.map((s) => callers.get(s.ch + ':' + s.sid)).find(Boolean);
    status = digital && from ? 'RX ' + from : 'RX';
  }
  switch (tx.state) {
    case 'waiting': status = 'TX…'; break;
    case 'tx': status = 'TX ' + fmtSecs((performance.now() - tx.startedAt) / 1000); break;
    case 'denied': status = 'CHANNEL BUSY'; break;
    case 'alarm': status = 'TIME-OUT'; break;
    case 'preempted': if (!heard.length) status = 'PREEMPTED'; break;
  }
  if (lost) status = 'NO SIGNAL';
  $('status').textContent = status;
  // The talk timer would make a screen reader read the status every second.
  const spoken = tx.state === 'tx' && !lost ? 'Transmitting' : status;
  if ($('status-live').textContent !== spoken) $('status-live').textContent = spoken;
  $('led-tx').classList.toggle('on', tx.state === 'tx' || tx.state === 'waiting');
  $('led-rx').classList.toggle('on', heard.length > 0);
  $('ptt').classList.toggle('active', tx.keyed);
  $('ptt').setAttribute('aria-pressed', tx.keyed);
  $('ch-up').disabled = $('ch-down').disabled = tx.keyed;
}

let lost = false;
let connTimer;

// The footer always says how the link is; the banner only speaks up when
// it drops, and when it comes back.
function netStatus(s) {
  $('net').textContent = s;
  clearTimeout(connTimer);
  const banner = $('conn');
  const show = (text, kind) => {
    if (banner.textContent !== text) banner.textContent = text;
    banner.className = 'conn ' + kind;
  };
  if (s === 'online') {
    if (!lost) return;
    lost = false;
    show('Reconnected', 'ok');
    connTimer = setTimeout(() => (banner.textContent = ''), 4000);
  } else if (s === 'offline') {
    lost = true;
    show('Connection lost. Reconnecting…', 'bad');
  } else {
    lost = true;
    show(s[0].toUpperCase() + s.slice(1), 'bad');
  }
  render();
}

function showMessage(m) {
  const card = document.createElement('div');
  card.className = 'popup';
  const from = document.createElement('strong');
  from.textContent = `From ${m.from}:`;
  const text = document.createElement('p');
  text.textContent = m.text;
  const close = document.createElement('button');
  close.textContent = 'Dismiss';
  close.onclick = () => card.remove();
  card.append(from, text, close);
  $('popups').prepend(card);
  audio.beep(880, 0.1, { type: 'sine' });
}

function fmtSecs(s) {
  s = Math.floor(s);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
