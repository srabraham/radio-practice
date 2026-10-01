import { RadioAudio } from './audio.js';
import { Link, me } from './net.js';
import { Transmitter } from './ptt.js';
import { loginForm, logout, savedDevices, bindDevices } from './common.js';

const $ = (id) => document.getElementById(id);
const SCAN_HANG_MS = 3000;

let audio, link, tx;
let channels = [];
let ch = localStorage.getItem('rp.ch') === null ? null : Number(localStorage.getItem('rp.ch'));
let scanning = localStorage.getItem('rp.scan') === '1';
let landed = null; // while scanning: { ch, until } for the channel we stopped on
const callers = new Map(); // "ch:sid" -> callsign (digital caller ID)

loginForm({
  onInstructor: () => { location.href = '/instructor.html'; },
  onParticipant: powerOn,
});

async function powerOn(who) {
  audio = new RadioAudio();
  try {
    await audio.init(savedDevices());
  } catch (e) {
    $('login-error').textContent = 'Microphone unavailable: ' + e.message;
    return;
  }
  $('login').hidden = true;
  $('radio').hidden = false;
  $('me').textContent = who.callsign;
  bindDevices(audio);
  navigator.wakeLock?.request('screen').catch(() => {});

  link = new Link({ onMessage, onAudio, onStatus: (s) => ($('net').textContent = s) });
  tx = new Transmitter({ link, audio, tot: 60, onChange: render });
  tx.bind($('ptt'), {
    latched: () => $('latch').checked,
    channel: () => ({ id: txChannel(), mode: channels[txChannel()]?.mode }),
  });
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
      link.send({ t: 'scan', on: scanning, list: channels.map((c) => c.id) });
      break;
    case 'rx_start':
      if (m.from) callers.set(m.ch + ':' + m.sid, m.from);
      break;
    case 'rx_end':
      audio.end(m.ch, m.sid);
      callers.delete(m.ch + ':' + m.sid);
      break;
    case 'prompt':
      showPrompt(m);
      break;
    default:
      tx.handle(m);
  }
  render();
}

function onAudio(c, sid, payload) {
  if (tx.keyed) return;
  const now = performance.now();
  if (!scanning) {
    if (c !== ch) return;
  } else {
    // A scanning radio stops on the first busy channel and stays there
    // until it has been quiet for the hang time.
    if (landed && landed.ch !== c && now < landed.until) return;
    landed = { ch: c, until: now + SCAN_HANG_MS };
  }
  audio.frame(c, sid, payload, channels[c].mode);
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
    link.send({ t: 'scan', on: scanning, list: channels.map((c) => c.id) });
    render();
  };
  $('volume').oninput = (e) => audio.setVolume(Number(e.target.value));
  $('logout').onclick = (e) => { e.preventDefault(); logout(); };
}

function render() {
  if (!channels.length) return;
  const dc = displayChannel();
  const c = channels[dc];
  const digital = c.mode === 'digital-repeater';
  $('chnum').textContent = 'CH ' + (dc + 1);
  $('chname').textContent = c.name;
  $('mode').textContent = digital ? 'DIG' : 'FM';
  $('scan-ind').hidden = !scanning;
  $('scan').classList.toggle('on', scanning);

  const heard = audio.active().filter((s) => s.ch === dc);

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
    case 'alarm': status = tx.reason === 'forced' ? 'CUT BY CONTROL' : 'TIME-OUT'; break;
    case 'preempted': if (!heard.length) status = 'PREEMPTED'; break;
  }
  $('status').textContent = status;
  $('led-tx').classList.toggle('on', tx.state === 'tx' || tx.state === 'waiting');
  $('led-rx').classList.toggle('on', heard.length > 0);
  $('ptt').classList.toggle('active', tx.keyed);
  $('ch-up').disabled = $('ch-down').disabled = tx.keyed;
}

function showPrompt(m) {
  const card = document.createElement('div');
  card.className = 'prompt';
  const from = document.createElement('strong');
  from.textContent = `From ${m.from}:`;
  const text = document.createElement('p');
  text.textContent = m.text;
  const close = document.createElement('button');
  close.textContent = 'Dismiss';
  close.onclick = () => card.remove();
  card.append(from, text, close);
  $('prompts').prepend(card);
  audio.beep(880, 0.1, { type: 'sine' });
}

function fmtSecs(s) {
  s = Math.floor(s);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
