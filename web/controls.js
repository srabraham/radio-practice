// The "Show app controls" column: everyone on the network, and text messages
// to all of them. The server only sends roster updates while it's open.

const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

let link, me;
let channels = [];
let clients = [];

export function initAppControls(l, callsign) {
  link = l;
  me = callsign;
  const box = $('show-controls');
  box.checked = load() === '1';
  show();
  box.onchange = () => {
    save(box.checked ? '1' : '0');
    show();
    link.send({ t: 'watch', on: box.checked });
  };
  $('msg-form').onsubmit = (e) => {
    e.preventDefault();
    const text = $('msg-text').value.trim();
    if (!text) return;
    link.send({ t: 'msg', text });
    $('msg-text').value = '';
  };
  setInterval(() => !$('app-controls').hidden && renderRoster(), 1000); // talk timers
}

function show() {
  const on = $('show-controls').checked;
  $('app-controls').hidden = !on;
  if (!on) clients = [];
}

export function controlsMessage(m) {
  switch (m.t) {
    case 'hello':
      channels = m.channels;
      // The server starts every connection fresh.
      link.send({ t: 'watch', on: $('show-controls').checked });
      $('msg-log').replaceChildren();
      for (const msg of m.messages || []) logMessage(msg);
      break;
    case 'state':
      clients = m.clients;
      renderRoster();
      break;
    case 'msg':
      logMessage(m);
      break;
  }
}

function renderRoster() {
  const body = $('roster');
  body.replaceChildren();
  const sorted = [...clients].sort((a, b) => a.callsign.localeCompare(b.callsign));
  for (const cl of sorted) {
    const ch = channels[cl.channel];
    const chText = (cl.scanning ? 'SCAN · ' : '') + `CH ${cl.channel + 1} ${ch ? ch.name : ''}`;
    const who = el('td', {}, cl.callsign);
    if (cl.callsign === me) who.append(el('span', { className: 'hint' }, ' (you)'));
    const tx = el('td', {});
    if (cl.tx) {
      const on = channels[cl.tx.ch];
      const secs = Math.max(0, Math.floor((Date.now() - cl.tx.since) / 1000));
      tx.append(el('span', { className: 'badge tx', title: on ? `Transmitting on ${on.name}` : 'Transmitting' }, `TX ${secs}s`));
    }
    body.append(el('tr', {}, who, el('td', {}, chText), tx));
  }
  if (!sorted.length) body.append(el('tr', {}, el('td', { colSpan: 3, className: 'hint' }, 'Nobody yet.')));
}

function logMessage(m) {
  const log = $('msg-log');
  const time = new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  log.append(el('li', {}, el('time', { className: 'hint', dateTime: new Date(m.at).toISOString() }, time), ' ',
    el('strong', {}, m.from), ' ', m.text));
  log.scrollTop = log.scrollHeight;
}

function load() {
  try {
    return localStorage.getItem('rp.controls');
  } catch {
    return null;
  }
}

function save(v) {
  try {
    localStorage.setItem('rp.controls', v);
  } catch {}
}
