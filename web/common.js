import { me } from './net.js';

const $ = (id) => document.getElementById(id);

// Drives the login card. The password decides the role: participants get the
// radio, instructors the console. An existing participant session skips the
// password but still needs a click, since browsers only allow audio after a
// user gesture. An instructor session skips the card entirely and falls back
// to the console's "Turn on sound" banner if the browser blocks audio.
export async function loginForm({ onInstructor, onParticipant }) {
  let who = await me();
  if (who && who.role === 'instructor') {
    onInstructor(who);
    return;
  }
  // Sessions don't survive a server restart, so remember the last login and
  // prefill it. The passwords are shared practice passwords, not real secrets.
  const saved = loadLogin();
  if (saved) {
    $('callsign').value = saved.callsign;
    $('password').value = saved.password;
  }
  const params = new URLSearchParams(location.search);
  // Shareable links like /?p=practice fill in the password.
  if (params.has('p')) $('password').value = params.get('p');
  if (params.has('taken')) {
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
      saveLogin({ callsign: $('callsign').value, password: $('password').value });
    }
    if (who.role === 'instructor') onInstructor(who);
    else onParticipant(who);
  });
}

// Swaps the login card for the radio or console view.
export function mount(view, bodyClass) {
  $('login').hidden = true;
  $('login').after($(view).content.cloneNode(true));
  document.body.className = bodyClass;
}

function loadLogin() {
  try {
    return JSON.parse(localStorage.getItem('rp.login'));
  } catch {
    return null;
  }
}

function saveLogin(login) {
  try {
    localStorage.setItem('rp.login', JSON.stringify(login));
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

const METER_MIN_DB = -80;

// Fills the #mic-sel / #spk-sel pickers and keeps them in sync as devices
// are plugged in or removed.
export function bindDevices(audio) {
  const micSel = $('mic-sel'), spkSel = $('spk-sel');
  let speaker = savedDevices().speaker || '';
  $('spk-row').hidden = !audio.canSetSpeaker();

  // The meter shows the mic level against the gate threshold (the tick), and
  // turns green while the gate is open, i.e. while you would be heard.
  const sens = $('mic-sens');
  const meter = $('mic-meter'), level = meter.querySelector('.meter-fill');
  const pct = (db) => Math.max(0, Math.min(100, (db - METER_MIN_DB) / -METER_MIN_DB * 100)) + '%';
  const setSens = () => meter.style.setProperty('--mark', pct(audio.setMicSensitivity(Number(sens.value))));
  try {
    sens.value = localStorage.getItem('rp.micSens') ?? sens.value;
  } catch {}
  setSens();
  sens.oninput = () => {
    setSens();
    saveDevice('micSens', sens.value);
  };
  audio.onMicLevel = ({ db, open }) => {
    level.style.width = pct(db);
    meter.classList.toggle('open', open);
    const now = String(Math.round(Math.max(METER_MIN_DB, Math.min(0, db))));
    if (meter.getAttribute('aria-valuenow') !== now) {
      meter.setAttribute('aria-valuenow', now);
      meter.setAttribute('aria-valuetext', `${now} dB, ${open ? 'loud enough to be heard' : 'below the gate'}`);
    }
  };

  const showMicError = () => {
    $('mic-warn').hidden = !audio.micError;
    $('mic-msg').textContent = audio.micError ? micErrorText(audio.micError) : '';
  };
  $('mic-retry').onclick = async () => {
    $('mic-retry').disabled = true;
    try {
      await audio.retryMic(savedDevices().mic);
      audio.micError = null;
    } catch (e) {
      audio.micError = e;
      // A blocked mic usually fails again instantly without a prompt.
      if (e.name === 'NotAllowedError') {
        $('mic-msg').textContent = 'Microphone still blocked. Allow it in your browser\'s site settings (the icon by the address bar), then try again.';
        $('mic-retry').disabled = false;
        return;
      }
    }
    $('mic-retry').disabled = false;
    showMicError();
    refresh();
  };

  const showSpeakerWarn = () => ($('spk-warn').hidden = !audio.speakerBlocked());
  audio.onSpeakerState = showSpeakerWarn;
  $('spk-retry').onclick = () => audio.resumeSpeaker().catch(() => {});
  // Any interaction is a gesture the browser accepts, so PTT or a knob turn
  // also brings the sound back without hunting for the button.
  for (const ev of ['pointerdown', 'keydown']) {
    document.addEventListener(ev, () => {
      if (audio.speakerBlocked()) audio.resumeSpeaker().catch(() => {});
    }, true);
  }
  showSpeakerWarn();

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

function micErrorText(e) {
  switch (e.name) {
    case 'NotAllowedError': return 'Microphone access is blocked. You can listen but not transmit.';
    case 'NotFoundError': return 'No microphone found. You can listen but not transmit.';
    case 'NotReadableError': return 'Microphone is in use by another app. You can listen but not transmit.';
    default: return 'Microphone unavailable. You can listen but not transmit.';
  }
}

export async function logout() {
  try {
    localStorage.removeItem('rp.login');
  } catch {}
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/';
}
