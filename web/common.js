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
    }
    if (who.role === 'instructor' && onInstructor) onInstructor(who);
    else onParticipant(who);
  });
}

export async function logout() {
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
