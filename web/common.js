import { me } from './net.js';

const $ = (id) => document.getElementById(id);

// Drives the login card. An existing session skips the password, but we still
// need a click: browsers only allow audio and mic after a user gesture.
export async function loginForm({ onInstructor, onParticipant, want }) {
  let who = await me();
  // e.g. a participant session opening the console: ask for the instructor login.
  if (who && want && who.role !== want) who = null;
  // On the radio page an instructor session just redirects to the console.
  if (who && who.role === 'instructor' && !want) {
    onInstructor(who);
    return;
  }
  // Sessions don't survive a server restart, so remember the last login and
  // prefill it. The passwords are shared practice passwords, not real secrets.
  const saveKey = 'rp.login.' + (want || 'participant');
  const saved = loadLogin(saveKey);
  if (saved) {
    $('callsign').value = saved.callsign;
    $('password').value = saved.password;
  }
  if (new URLSearchParams(location.search).has('taken')) {
    $('login-error').textContent = 'Someone else is on the air with that callsign. Pick another.';
    history.replaceState(null, '', location.pathname);
  }
  if (who) {
    $('callsign').value = who.callsign;
    $('callsign').readOnly = true;
    $('pw-row').hidden = true;
    $('password').required = false;
  }
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').textContent = '';
    if (!who) {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callsign: $('callsign').value, password: $('password').value }),
      });
      if (!r.ok) {
        $('login-error').textContent = (await r.text()).trim();
        return;
      }
      who = await r.json();
      saveLogin(saveKey, { callsign: $('callsign').value, password: $('password').value });
    }
    if (who.role === 'instructor' && onInstructor) onInstructor(who);
    else onParticipant(who);
  });
}

function loadLogin(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function saveLogin(key, login) {
  try {
    localStorage.setItem(key, JSON.stringify(login));
  } catch {}
}

export function savedDevices() {
  try {
    return { mic: localStorage.getItem('rp.mic') || '', speaker: localStorage.getItem('rp.speaker') || '' };
  } catch {
    return {};
  }
}

function saveDevice(kind, id) {
  try {
    localStorage.setItem('rp.' + kind, id);
  } catch {}
}

// Fills the #mic-sel / #spk-sel pickers and keeps them in sync as devices
// are plugged in or removed.
export function bindDevices(audio) {
  const micSel = $('mic-sel'), spkSel = $('spk-sel');
  let speaker = savedDevices().speaker || '';
  $('spk-row').hidden = !audio.canSetSpeaker();

  const showMicError = () => {
    $('mic-warn').textContent = audio.micError ? `No microphone (${audio.micError.name}): receive only` : '';
  };

  const fill = (sel, devices, current, noun) => {
    sel.innerHTML = '';
    sel.add(new Option('System default', ''));
    // Chrome lists "default"/"communications" aliases; the first entry covers them.
    devices.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .forEach((d, i) => sel.add(new Option(d.label || `${noun} ${i + 1}`, d.deviceId)));
    sel.value = [...sel.options].some((o) => o.value === current) ? current : '';
  };

  const refresh = async () => {
    const all = await navigator.mediaDevices.enumerateDevices();
    const mics = all.filter((d) => d.kind === 'audioinput');
    const spks = all.filter((d) => d.kind === 'audiooutput');
    const track = audio.stream?.getAudioTracks()[0];
    // The mic in use was unplugged: fall back to the default one.
    if (track && (track.readyState === 'ended' || (audio.micId() && !mics.some((d) => d.deviceId === audio.micId())))) {
      await audio.setMic('').catch((e) => (audio.micError = e));
      showMicError();
    }
    fill(micSel, mics, savedDevices().mic ? audio.micId() : '', 'Microphone');
    fill(spkSel, spks, speaker, 'Speaker');
  };

  micSel.onchange = async () => {
    const id = micSel.value;
    try {
      await audio.setMic(id);
      saveDevice('mic', id);
    } catch (e) {
      audio.micError = audio.stream ? null : e;
      alert(`Couldn't switch microphone: ${e.message || e.name}`);
    }
    showMicError();
    refresh();
  };
  spkSel.onchange = async () => {
    try {
      await audio.setSpeaker(spkSel.value);
      speaker = spkSel.value;
      saveDevice('speaker', speaker);
    } catch (e) {
      alert(`Couldn't switch speaker: ${e.message || e.name}`);
      spkSel.value = speaker;
    }
  };
  navigator.mediaDevices.addEventListener('devicechange', refresh);
  showMicError();
  refresh();
}

export async function logout() {
  try {
    localStorage.removeItem('rp.login.participant');
    localStorage.removeItem('rp.login.instructor');
  } catch {}
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/';
}

export function nearestLandmark(landmarks, pos) {
  let best = landmarks[0], bestD = Infinity;
  for (const l of landmarks) {
    const d = Math.hypot(l.pos.x - pos.x, l.pos.y - pos.y);
    if (d < bestD) { best = l; bestD = d; }
  }
  return best;
}
