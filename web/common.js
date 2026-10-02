import { me } from './net.js';

const $ = (id) => document.getElementById(id);

// Drives the login card. The password decides the role: participants get the
// radio, instructors the console. The password lives in the URL (?p=) rather
// than in storage, so the address bar is always a link to share; the callsign
// is remembered per browser. With both in hand there's no card at all. Audio
// may then start blocked, which the views' "Turn on sound" banner handles.
export async function loginForm({ onInstructor, onParticipant }) {
  const params = new URLSearchParams(location.search);
  const pw = params.get('p') ?? '';
  const enter = (who) => {
    saveCallsign(who.callsign);
    history.replaceState(null, '', location.pathname + '?' + new URLSearchParams({ p: who.password }));
    if (who.role === 'instructor') onInstructor(who);
    else onParticipant(who);
  };
  const login = async (callsign, password) => {
    $('login-error').textContent = '';
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callsign, password }),
    });
    if (!r.ok) {
      $('login-error').textContent = (await r.text()).trim();
      return;
    }
    enter(await r.json());
  };

  // A link with a different password (say, the instructor's) wins over the
  // session, so the same device can switch roles.
  const who = await me();
  if (who && (!pw || pw === who.password)) {
    enter(who);
    return;
  }

  const callsign = loadCallsign() || who?.callsign || '';
  $('callsign').value = callsign;
  $('password').value = pw;
  $('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    login($('callsign').value, $('password').value);
  });
  if (params.has('taken')) {
    $('login-error').textContent = 'Someone else is on the air with that callsign. Pick another.';
    history.replaceState(null, '', location.pathname + (pw ? '?' + new URLSearchParams({ p: pw }) : ''));
  } else if (callsign && pw) {
    await login(callsign, pw);
  }
}

// Swaps the login card for the radio or console view.
export function mount(view, bodyClass) {
  $('login').hidden = true;
  $('login').after($(view).content.cloneNode(true));
  document.body.className = bodyClass;
}

function loadCallsign() {
  try {
    return localStorage.getItem('rp.callsign') || '';
  } catch {
    return '';
  }
}

function saveCallsign(callsign) {
  try {
    localStorage.setItem('rp.callsign', callsign);
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

  const meter = $('mic-meter'), level = meter.querySelector('.meter-fill');
  const pct = (db) => Math.max(0, Math.min(100, (db - METER_MIN_DB) / -METER_MIN_DB * 100)) + '%';
  audio.onMicLevel = ({ db }) => {
    level.style.width = pct(db);
    const now = String(Math.round(Math.max(METER_MIN_DB, Math.min(0, db))));
    if (meter.getAttribute('aria-valuenow') !== now) {
      meter.setAttribute('aria-valuenow', now);
      meter.setAttribute('aria-valuetext', `${now} dB`);
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

// Keeps ?p= so the card comes back with the password filled in, but forgets
// the callsign, which would otherwise log straight back in.
export async function logout() {
  try {
    localStorage.removeItem('rp.callsign');
  } catch {}
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
}
