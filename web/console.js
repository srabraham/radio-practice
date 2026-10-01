import { RadioAudio } from './audio.js';
import { Link } from './net.js';
import { Transmitter } from './ptt.js';
import { loginForm, logout, savedDevices, bindDevices } from './common.js';

const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

const CHANNEL_COLORS = ['#e4572e', '#2e86ab', '#a23b72', '#3bb273', '#f18f01', '#6c5ce7', '#17a398', '#c44536'];

const PRESETS = [
  ['', '— choose a scenario —'],
  ['Radio check: call Control on DISPATCH and ask for a radio check.'],
  ['You have found a lost child (about 6 years old, blue tutu) at your location. Report it on DISPATCH.'],
  ['A participant is down but conscious and breathing at your location. Request help on MEDICAL.'],
  ['Art car on fire at your location, no injuries. Report it on DISPATCH and stand by.'],
  ['Switch to TAC 1 and coordinate a meeting point with another radio.'],
].map(([text, label]) => ({ text, label: label || text }));

let audio, link, tx;
let channels = [];
let state = { clients: [], channels: [] };
let monitor = new Set();
const callers = new Map();

loginForm({
  want: 'instructor',
  onInstructor: start,
  onParticipant: () => { location.href = '/'; },
});

async function start(who) {
  audio = new RadioAudio({ clean: true });
  try {
    await audio.init(savedDevices());
  } catch (e) {
    $('login-error').textContent = 'Microphone unavailable: ' + e.message;
    return;
  }
  $('login').hidden = true;
  $('console').hidden = false;
  $('me').textContent = who.callsign;
  bindDevices(audio);

  link = new Link({ onMessage, onAudio, onStatus: (s) => ($('net').textContent = s) });
  tx = new Transmitter({ link, audio, tot: 60, onChange: renderTx });
  tx.bind($('ptt'), {
    latched: () => $('latch').checked,
    channel: () => {
      const v = $('tx-ch').value;
      if (v === 'vog') return { mode: 'digital-repeater', vog: true };
      return { id: Number(v), mode: channels[v].mode };
    },
  });
  link.connect();
  bindControls();
  setInterval(renderHearing, 100);
  setInterval(renderChannels, 1000); // keep the talk timers ticking
}

function onMessage(m) {
  switch (m.t) {
    case 'hello':
      channels = m.channels;
      tx.tot = m.tot;
      if (!monitor.size) monitor = new Set(channels.map((c) => c.id));
      link.send({ t: 'monitor', list: [...monitor] });
      buildChannels();
      break;
    case 'state':
      state = m;
      renderChannels();
      renderRoster();
      break;
    case 'rx_start':
      callers.set(m.ch + ':' + m.sid, m.from);
      break;
    case 'rx_end':
      audio.end(m.ch, m.sid);
      callers.delete(m.ch + ':' + m.sid);
      break;
    default:
      tx.handle(m);
  }
}

function onAudio(ch, sid, payload) {
  if (!tx.keyed) audio.frame(ch, sid, payload, channels[ch].mode);
}

function renderHearing() {
  const heard = audio.active().map((s) => `CH${s.ch + 1} ${channels[s.ch].name}: ${callers.get(s.ch + ':' + s.sid) || '?'}`);
  $('hearing').textContent = heard.length ? '🔊 ' + heard.join(' · ') : '';
}

// ---- panels ----

function bindControls() {
  $('volume').oninput = (e) => audio.setVolume(Number(e.target.value));
  $('logout').onclick = (e) => { e.preventDefault(); logout(); };

  for (const p of PRESETS) $('prompt-preset').add(new Option(p.label, p.text));
  $('prompt-preset').onchange = (e) => { if (e.target.value) $('prompt-text').value = e.target.value; };
  $('prompt-send').onclick = () => {
    const text = $('prompt-text').value.trim();
    if (!text) return;
    link.send({ t: 'prompt', text, to: Number($('prompt-to').value) });
    $('prompt-text').value = '';
    $('prompt-preset').value = '';
  };
}

function buildChannels() {
  const sel = $('tx-ch');
  const prev = sel.value;
  sel.innerHTML = '';
  const box = $('channels');
  box.innerHTML = '';
  for (const c of channels) {
    sel.add(new Option(`CH ${c.id + 1} ${c.name}`, c.id));
    const cb = el('input', { type: 'checkbox', checked: monitor.has(c.id), title: 'Monitor this channel' });
    cb.onchange = () => {
      cb.checked ? monitor.add(c.id) : monitor.delete(c.id);
      link.send({ t: 'monitor', list: [...monitor] });
    };
    const row = el('div', { className: 'ch-row', id: 'ch-row-' + c.id },
      el('label', { className: 'ch-name' }, cb,
        el('i', { className: 'dot', style: `background:${CHANNEL_COLORS[c.id % CHANNEL_COLORS.length]}` }),
        `CH ${c.id + 1} ${c.name}`),
      el('span', { className: 'tag' }, c.mode === 'fm-simplex' ? 'FM simplex' : 'Digital rptr'),
      el('span', { className: 'ch-activity', id: 'ch-act-' + c.id }, 'idle'));
    box.append(row);
  }
  if (channels.some((c) => c.mode === 'digital-repeater')) {
    sel.add(new Option('ALL REPEATERS (Voice of God)', 'vog'));
  }
  if (prev) sel.value = prev;
}

function renderChannels() {
  const byId = new Map(state.clients.map((c) => [c.id, c]));
  for (const c of state.channels) {
    const act = $('ch-act-' + c.id);
    if (!act) continue;
    act.innerHTML = '';
    if (!c.txers.length) {
      act.textContent = 'idle';
      continue;
    }
    if (c.txers.length > 1) act.append(el('span', { className: 'badge warn' }, 'DOUBLED'));
    for (const id of c.txers) {
      const cl = byId.get(id);
      if (!cl) continue;
      const secs = Math.floor((Date.now() - cl.tx.since) / 1000);
      const who = cl.tx.vog ? `${cl.callsign} (Voice of God)` : cl.callsign;
      act.append(el('span', { className: 'badge tx' }, `${who} ${secs}s`), cutButton(cl));
    }
  }
}

function renderRoster() {
  const to = $('prompt-to');
  const prevTo = to.value;
  to.innerHTML = '';
  to.add(new Option('Everyone', 0));

  const body = $('roster');
  body.innerHTML = '';
  const radios = state.clients.filter((c) => c.role === 'participant').sort((a, b) => a.callsign.localeCompare(b.callsign));
  for (const cl of radios) {
    to.add(new Option(cl.callsign, cl.id));
    const ch = channels[cl.channel];
    const chText = (cl.scanning ? 'SCAN · ' : '') + `CH ${cl.channel + 1} ${ch ? ch.name : ''}`;
    const actions = el('td', {});
    if (cl.tx) actions.append(el('span', { className: 'badge tx' }, 'TX'), cutButton(cl));
    body.append(el('tr', {}, el('td', {}, cl.callsign), el('td', {}, chText), actions));
  }
  if (!radios.length) body.append(el('tr', {}, el('td', { colSpan: 3, className: 'hint' }, 'No radios connected yet.')));
  to.value = [...to.options].some((o) => o.value === prevTo) ? prevTo : '0';
}

function cutButton(cl) {
  const b = el('button', { className: 'cut', title: 'Force unkey (stuck mic)' }, 'Cut');
  b.onclick = () => link.send({ t: 'force_unkey', id: cl.id });
  return b;
}

function renderTx() {
  const labels = {
    idle: 'Ready',
    waiting: 'Requesting repeater…',
    tx: tx.vog ? 'Voice of God: transmitting on every repeater' : 'Transmitting',
    denied: tx.vog ? 'Another Voice of God is on the air' : 'Channel busy',
    alarm: 'Time-out: release the button',
    preempted: 'Cut off by Voice of God',
  };
  $('tx-status').textContent = labels[tx.state];
  $('ptt').classList.toggle('active', tx.keyed);
  $('tx-ch').disabled = tx.keyed;
}
