import { RadioAudio } from './audio.js';
import { Link } from './net.js';
import { Transmitter } from './ptt.js';
import { MapView, CHANNEL_COLORS } from './map.js';
import { loginForm, logout, nearestLandmark } from './common.js';

const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

const PRESETS = [
  ['', '— choose a scenario —'],
  ['Radio check: call Control on DISPATCH and ask for a radio check.'],
  ['You have found a lost child (about 6 years old, blue tutu) at your location. Report it on DISPATCH.'],
  ['A participant is down but conscious and breathing at your location. Request help on MEDICAL.'],
  ['You can hear a teammate who can\'t reach the repeater. Relay their message to DISPATCH.'],
  ['Art car on fire at your location, no injuries. Report it on DISPATCH and stand by.'],
  ['Switch to TAC 1 and coordinate with the nearest radio to meet at Center Camp.'],
].map(([text, label]) => ({ text, label: label || text }));

let audio, link, tx, map;
let channels = [], landmarks = [];
let state = { clients: [], channels: [], zones: [], handheldRange: 2200 };
let monitor = new Set();
let tool = 'move';
let dragging = null; // { id, pos } while an instructor drags a radio
const callers = new Map();

loginForm({
  want: 'instructor',
  onInstructor: start,
  onParticipant: () => { location.href = '/'; },
});

async function start(who) {
  audio = new RadioAudio({ clean: true });
  try {
    await audio.init();
  } catch (e) {
    $('login-error').textContent = 'Microphone unavailable: ' + e.message;
    return;
  }
  $('login').hidden = true;
  $('console').hidden = false;
  $('me').textContent = who.callsign;
  if (audio.micError) $('mic-warn').textContent = `No microphone (${audio.micError.name}): receive only`;

  link = new Link({ onMessage, onAudio, onStatus: (s) => ($('net').textContent = s) });
  tx = new Transmitter({ link, audio, tot: 60, onChange: renderTx });
  tx.bind($('ptt'), {
    latched: () => $('latch').checked,
    channel: () => {
      const id = Number($('tx-ch').value);
      return { id, mode: channels[id].mode };
    },
  });
  link.connect();

  map = new MapView($('map'));
  bindMap();
  bindControls();
  requestAnimationFrame(frame);
  setInterval(renderChannels, 1000); // keep the talk timers ticking
}

function onMessage(m) {
  switch (m.t) {
    case 'hello':
      channels = m.channels;
      landmarks = m.landmarks;
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

function onAudio(ch, sid, q, payload) {
  if (!tx.keyed) audio.frame(ch, sid, q, payload, channels[ch].mode);
}

function frame(now) {
  requestAnimationFrame(frame);
  const heard = audio.active().map((s) => `CH${s.ch + 1} ${channels[s.ch].name}: ${callers.get(s.ch + ':' + s.sid) || '?'}`);
  $('hearing').textContent = heard.length ? '🔊 ' + heard.join(' · ') : '';
  if (dragging) {
    const cl = state.clients.find((c) => c.id === dragging.id);
    if (cl) cl.pos = dragging.pos;
  }
  if (channels.length) {
    map.draw({ landmarks, channels, clients: state.clients, zones: state.zones, handheldRange: state.handheldRange, now });
  }
}

// ---- map interaction ----

function bindMap() {
  const canvas = $('map');
  let lastSent = 0;
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const sendMove = () => link.send({ t: 'move', id: dragging.id, x: dragging.pos.x, y: dragging.pos.y });

  canvas.addEventListener('pointerdown', (e) => {
    const [x, y] = local(e);
    if (tool === 'zone') {
      const z = map.hitZone(state.zones, x, y);
      if (z) {
        link.send({ t: 'zone_del', id: z.id });
      } else {
        const w = map.toWorld(x, y);
        link.send({ t: 'zone_add', x: w.x, y: w.y, r: Number($('zone-r').value), loss: Number($('zone-loss').value) });
      }
      return;
    }
    const cl = map.hitClient(state.clients, x, y);
    if (cl) {
      dragging = { id: cl.id, pos: cl.pos };
      canvas.setPointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = local(e);
    if (!dragging) {
      canvas.style.cursor = tool === 'zone' ? 'crosshair' : map.hitClient(state.clients, x, y) ? 'grab' : 'default';
      return;
    }
    dragging.pos = map.toWorld(x, y);
    // Live updates while dragging, so people hear the signal fade as it happens.
    if (performance.now() - lastSent > 100) {
      sendMove();
      lastSent = performance.now();
    }
  });
  const drop = () => {
    if (dragging) sendMove();
    dragging = null;
  };
  canvas.addEventListener('pointerup', drop);
  canvas.addEventListener('pointercancel', drop);
}

// ---- panels ----

function bindControls() {
  const setTool = (t) => {
    tool = t;
    $('tool-move').classList.toggle('on', t === 'move');
    $('tool-zone').classList.toggle('on', t === 'zone');
  };
  $('tool-move').onclick = () => setTool('move');
  $('tool-zone').onclick = () => setTool('zone');
  $('zone-r').oninput = (e) => ($('zone-r-v').textContent = e.target.value + ' m');
  $('zone-loss').oninput = (e) => ($('zone-loss-v').textContent = Math.round(e.target.value * 100) + '%');
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
      act.append(el('span', { className: 'badge tx' }, `${cl.callsign} ${secs}s`), cutButton(cl));
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
    const lm = landmarks.find((l) => l.id === cl.loc);
    const where = lm ? lm.name : `near ${nearestLandmark(landmarks, cl.pos).name}`;
    const chText = (cl.scanning ? 'SCAN · ' : '') + `CH ${cl.channel + 1} ${ch ? ch.name : ''}`;
    const actions = el('td', {});
    if (cl.tx) actions.append(el('span', { className: 'badge tx' }, 'TX'), cutButton(cl));
    body.append(el('tr', {}, el('td', {}, cl.callsign), el('td', {}, chText), el('td', {}, where), actions));
  }
  if (!radios.length) body.append(el('tr', {}, el('td', { colSpan: 4, className: 'hint' }, 'No radios connected yet.')));
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
    tx: 'Transmitting',
    denied: tx.reason === 'no_repeater' ? 'No repeater' : 'Channel busy',
    alarm: 'Time-out: release the button',
  };
  $('tx-status').textContent = labels[tx.state];
  $('ptt').classList.toggle('active', tx.keyed);
  $('tx-ch').disabled = tx.keyed;
}
