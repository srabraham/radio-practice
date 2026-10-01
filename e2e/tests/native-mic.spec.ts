import { test, expect, CH, grantMic } from '../lib/fixtures';
import { concat, decodeUlaw, expectTone, now, rmsDb, toneShare } from '../lib/audio';
import { TONE_WAV_HZ } from '../global-setup';

// These use the browser's real getUserMedia and its built-in fake capture
// device (configured per engine in playwright.config.ts) instead of the
// synthetic mic, so permission handling and MediaStream plumbing are the
// browser's own.

test('the browser\'s own capture device goes out on the air', async ({ openRadio, browserName }) => {
  const rx = await openRadio({ ch: CH.tac1 });
  const tx = await openRadio({ ch: CH.tac1, mic: { fake: false } });
  await expect(tx.page.locator('#mic-warn')).toBeHidden();
  // Let the gate open on the device's signal.
  await tx.page.getByLabel('Mic sensitivity').fill('1');

  const t0 = Date.now();
  const rxT0 = await now(rx.page);
  await tx.talk(2500);
  // No frame-count check: Firefox's and WebKit's fake devices are clocked by a
  // timer that runs the whole audio graph slow (10% idle, far worse under load).
  const pcm = decodeUlaw(concat(tx.wire.audioSentSince(t0).slice(5)));
  expect(pcm.length).toBeGreaterThan(8000 * 0.25);
  expect(rmsDb(pcm)).toBeGreaterThan(-45);

  // Each engine's fake device makes a different sound.
  if (browserName === 'chromium') {
    expect(toneShare(pcm, TONE_WAV_HZ)).toBeGreaterThan(0.6);
    await expectTone(rx.page, TONE_WAV_HZ, { since: rxT0 });
  } else if (browserName === 'firefox') {
    expect(toneShare(pcm, 1000)).toBeGreaterThan(0.6);
    await expectTone(rx.page, 1000, { since: rxT0 });
  }
  expect(rx.wire.audioReceivedSince(t0).length).toBeGreaterThan(15);
});

test('a mic the browser blocks can be retried after the user allows it', async ({ openRadio, browserName, server }) => {
  // Chromium's and Firefox's fake-device switches also skip the permission
  // prompt, so only WebKit can be made to say no here.
  test.skip(browserName !== 'webkit', 'needs a browser that enforces mic permission under test');
  const rx = await openRadio({ ch: CH.tac1 });
  const r = await openRadio({ ch: CH.tac1, mic: { fake: false }, grantMic: false });
  await expect(r.page.locator('#mic-warn')).toContainText('Microphone access is blocked');

  await grantMic(r.page.context(), browserName, server.url);
  await r.page.getByRole('button', { name: 'Try again' }).click();
  await expect(r.page.locator('#mic-warn')).toBeHidden();
  const t0 = Date.now();
  await r.talk(1200);
  expect(rx.wire.audioReceivedSince(t0).length).toBeGreaterThan(15);
});

test('switching the speaker output keeps sound playing', async ({ openRadio }) => {
  const r = await openRadio({ ch: CH.tac1, mic: { fake: false } });
  const canSwitch = await r.page.evaluate(() => typeof (AudioContext.prototype as any).setSinkId === 'function');
  test.skip(!canSwitch, 'AudioContext.setSinkId is not supported in this browser');

  const picker = r.page.getByRole('combobox', { name: /^Speaker/ });
  // System default plus at least one real output, once enumerateDevices is back.
  await expect.poll(() => picker.locator('option').count()).toBeGreaterThan(1);
  const dialogs: string[] = [];
  r.page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  const target = await picker.locator('option').nth(1).getAttribute('value');
  await picker.selectOption(target!);
  await expect.poll(() => r.page.evaluate(() => (window as any).__tap.ctx().sinkId)).toBe(target);
  expect(dialogs).toEqual([]);
  expect(await r.page.evaluate(() => localStorage.getItem('rp.speaker'))).toBe(target);
  await expect.poll(() => r.audioState()).toBe('running');
});

test('a saved speaker that has gone away falls back to the default output', async ({ newUser }) => {
  const page = await newUser({ mic: { fake: false } });
  const canSwitch = await page.evaluate(() => typeof (AudioContext.prototype as any).setSinkId === 'function');
  test.skip(!canSwitch, 'AudioContext.setSinkId is not supported in this browser');
  // Also what happens when the browser rotates device IDs between visits.
  await page.addInitScript(() => localStorage.setItem('rp.speaker', 'unplugged-headset'));
  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  await page.goto('/');
  await page.getByLabel('Callsign').fill('GONESPK');
  await page.getByLabel('Password').fill('practice');
  await page.getByRole('button', { name: 'Power on' }).click();
  await expect(page.locator('#radio')).toBeVisible();
  await expect(page.locator('#spk-warn')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__tap.ctx().sinkId)).toBe('');
  await expect.poll(() => page.evaluate(() => (window as any).__tap.state())).toBe('running');
  await expect(page.getByRole('combobox', { name: /^Speaker/ })).toHaveValue('');
  expect(dialogs).toEqual([]);
});
