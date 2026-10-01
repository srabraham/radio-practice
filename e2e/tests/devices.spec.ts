import { test, expect, CH, type Radio } from '../lib/fixtures';
import { HZ, concat, decodeUlaw, expectNoTone, expectTone, loudest, now, rmsDb, toneShare } from '../lib/audio';

test.describe('microphone', () => {
  test('the noise gate keeps quiet sound off the air until sensitivity is raised', async ({ openRadio }) => {
    const rx = await openRadio({ ch: CH.tac1 });
    // About -50 dBFS: like another radio's speaker across the room.
    const tx = await openRadio({ ch: CH.tac1, mic: { level: 0.003 } });
    const meter = tx.page.locator('#mic-meter');
    const sens = tx.page.getByLabel('Mic sensitivity');

    await sens.fill('0');
    await expect(meter).not.toHaveClass(/\bopen\b/);
    let t0 = Date.now();
    let rxT0 = await now(rx.page);
    await tx.talk(1000);
    const gated = decodeUlaw(concat(tx.wire.audioSentSince(t0)));
    expect(gated.length).toBeGreaterThan(0);
    expect(rmsDb(gated)).toBeLessThan(-60);
    await expectNoTone(rx.page, HZ.voice, rxT0);

    await sens.fill('1');
    await expect(meter).toHaveClass(/\bopen\b/);
    t0 = Date.now();
    rxT0 = await now(rx.page);
    await tx.talk(1000);
    const open = decodeUlaw(concat(tx.wire.audioSentSince(t0).slice(10)));
    expect(toneShare(open, HZ.voice)).toBeGreaterThan(0.8);
    await expectTone(rx.page, HZ.voice, { since: rxT0 });

    // Remembered for next time.
    expect(await tx.page.evaluate(() => localStorage.getItem('rp.micSens'))).toBe('1');
  });

  test('the level meter tracks the mic against the gate threshold', async ({ openRadio }) => {
    const r = await openRadio();
    const fill = r.page.locator('#mic-meter .meter-fill');
    const width = () => fill.evaluate((e) => parseFloat((e as HTMLElement).style.width));
    await expect.poll(width).toBeGreaterThan(80);
    // About -66 dBFS.
    await r.mic({ level: 0.0005 });
    await expect.poll(width).toBeLessThan(30);
    await expect(r.page.locator('#mic-meter')).not.toHaveClass(/\bopen\b/);
    // The threshold tick moves with the slider.
    const mark = () => r.page.locator('#mic-meter').evaluate((e) => (e as HTMLElement).style.getPropertyValue('--mark'));
    const before = await mark();
    await r.page.getByLabel('Mic sensitivity').fill('0.1');
    await expect.poll(mark).not.toBe(before);
  });

  test('the level meter falls when the mic goes digitally silent', async ({ openRadio }) => {
    // Firefox hands an AudioWorklet zero input channels once its source is
    // silent, as with a muted mic.
    const r = await openRadio();
    const fill = r.page.locator('#mic-meter .meter-fill');
    const width = () => fill.evaluate((e) => parseFloat((e as HTMLElement).style.width));
    await expect.poll(width).toBeGreaterThan(80);
    await r.mic({ level: 0 });
    await expect.poll(width).toBeLessThan(10);
    await expect(r.page.locator('#mic-meter')).not.toHaveClass(/\bopen\b/);
  });

  test('picking another microphone switches capture and is remembered', async ({ openRadio }) => {
    const r = await openRadio();
    const picker = r.page.getByRole('combobox', { name: /^Microphone/ });
    await expect(picker.locator('option')).toHaveText(['System default', 'Fake mic 1', 'Fake mic 2']);
    await picker.selectOption({ label: 'Fake mic 2' });
    await expect.poll(() => r.page.evaluate(() => (window as any).__mic.deviceId)).toBe('fake-mic-2');
    await expect(picker).toHaveValue('fake-mic-2');

    await r.page.reload();
    await r.page.getByRole('button', { name: 'Power on' }).click();
    await r.waitOnline();
    const asked = await r.page.evaluate(() => (window as any).__mic.constraints);
    expect(asked.audio.deviceId).toEqual({ exact: 'fake-mic-2' });
    // Processing that would make radios near each other feed back stays off.
    expect(asked.audio).toMatchObject({ echoCancellation: true, noiseSuppression: true, autoGainControl: false });
  });

  test('unplugging the microphone in use falls back to the default', async ({ openRadio }) => {
    const rx = await openRadio({ ch: CH.tac1 });
    const tx = await openRadio({ ch: CH.tac1 });
    const picker = tx.page.getByRole('combobox', { name: /^Microphone/ });
    await picker.selectOption({ label: 'Fake mic 2' });
    await expect.poll(() => tx.page.evaluate(() => (window as any).__mic.deviceId)).toBe('fake-mic-2');

    await tx.page.evaluate(() => {
      const mic = (window as any).__mic;
      mic.setDevices(mic.devices.filter((d: MediaDeviceInfo) => d.deviceId !== 'fake-mic-2'));
    });
    await expect.poll(() => tx.page.evaluate(() => (window as any).__mic.deviceId)).toBe('fake-mic-1');
    await expect(picker.locator('option')).toHaveText(['System default', 'Fake mic 1']);
    await expect(tx.page.locator('#mic-warn')).toBeHidden();
    const t0 = await now(rx.page);
    await tx.talk(1500);
    await expectTone(rx.page, HZ.voice, { since: t0 });
  });

  test('a saved microphone that is gone falls back on power on', async ({ newUser }) => {
    const page = await newUser({ ch: CH.tac1 });
    await page.addInitScript(() => localStorage.setItem('rp.mic', 'unplugged-last-week'));
    await page.goto('/');
    await page.getByLabel('Callsign').fill('GONEMIC');
    await page.getByLabel('Password').fill('practice');
    await page.getByRole('button', { name: 'Power on' }).click();
    await expect(page.locator('#radio')).toBeVisible();
    await expect(page.locator('#mic-warn')).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).__mic.deviceId)).toBe('fake-mic-1');
  });

  // A radio without a mic still receives; the warning says why it can't transmit.
  async function expectListenOnly(r: Radio, tx: Radio, text: string) {
    const warn = r.page.locator('#mic-warn');
    await expect(warn).toBeVisible();
    await expect(warn).toContainText(text);
    const t0 = await now(r.page);
    await tx.talk(1200);
    await expectTone(r.page, HZ.voice, { since: t0 });
  }

  test('a blocked mic leaves the radio listen-only', async ({ openRadio }) => {
    const r = await openRadio({ ch: CH.tac1, mic: { fail: 'NotAllowedError' } });
    const tx = await openRadio({ ch: CH.tac1 });
    await expectListenOnly(r, tx, 'Microphone access is blocked. You can listen but not transmit.');
  });

  test('no mic at all leaves the radio listen-only', async ({ openRadio }) => {
    const r = await openRadio({ ch: CH.tac1, mic: { fail: 'NotFoundError' } });
    const tx = await openRadio({ ch: CH.tac1 });
    await expectListenOnly(r, tx, 'No microphone found. You can listen but not transmit.');
  });

  test('a mic in use by another app leaves the radio listen-only', async ({ openRadio }) => {
    const r = await openRadio({ ch: CH.tac1, mic: { fail: 'NotReadableError' } });
    const tx = await openRadio({ ch: CH.tac1 });
    await expectListenOnly(r, tx, 'Microphone is in use by another app. You can listen but not transmit.');
  });

  test('a blocked mic can be retried once allowed', async ({ openRadio }) => {
    const r = await openRadio({ ch: CH.tac1, mic: { fail: 'NotAllowedError' } });
    const rx = await openRadio({ ch: CH.tac1 });
    const retry = r.page.getByRole('button', { name: 'Try again' });

    await retry.click();
    await expect(r.page.locator('#mic-msg')).toContainText('Microphone still blocked');
    await expect(retry).toBeEnabled();

    await r.mic({ fail: null });
    await retry.click();
    await expect(r.page.locator('#mic-warn')).toBeHidden();
    const t0 = await now(rx.page);
    await r.talk(1500);
    await expectTone(rx.page, HZ.voice, { since: t0 });
  });
});

test.describe('speaker', () => {
  test('volume scales what is heard', async ({ openRadio }) => {
    const rx = await openRadio({ ch: CH.tac1 });
    const tx = await openRadio({ ch: CH.tac1 });
    const vol = rx.page.getByLabel('Volume');

    const level = async (v: string) => {
      await vol.fill(v);
      const t0 = await now(rx.page);
      await tx.talk(1000);
      await rx.page.waitForTimeout(300);
      return loudest(rx.page, HZ.voice, t0 + 300);
    };
    const loud = await level('1.5');
    const quiet = await level('0.2');
    // 20·log10(1.5 / 0.2) ≈ 17.5 dB
    expect(loud - quiet).toBeGreaterThan(12);
    expect(await level('0')).toBeLessThan(-120);
  });

  test('blocked sound shows a warning, and the button turns it back on', async ({ openRadio }) => {
    const r = await openRadio({ ch: CH.tac1 });
    const warn = r.page.locator('#spk-warn');
    await expect(warn).toBeHidden();
    // What autoplay rules, or an iOS interruption, leave behind.
    await r.page.evaluate(() => (window as any).__tap.ctx().suspend());
    await expect(warn).toBeVisible();
    await expect(warn).toContainText('Sound is blocked by the browser.');
    await r.page.getByRole('button', { name: 'Turn on sound' }).click();
    await expect(warn).toBeHidden();
    await expect.poll(() => r.audioState()).toBe('running');
  });

  test('any key or tap also turns blocked sound back on', async ({ openRadio }) => {
    const r = await openRadio({ ch: CH.tac1 });
    await r.page.evaluate(() => (window as any).__tap.ctx().suspend());
    await expect(r.page.locator('#spk-warn')).toBeVisible();
    await r.page.getByRole('button', { name: 'Channel up' }).click();
    await expect(r.page.locator('#spk-warn')).toBeHidden();
    await expect.poll(() => r.audioState()).toBe('running');

    await r.page.evaluate(() => (window as any).__tap.ctx().suspend());
    await expect(r.page.locator('#spk-warn')).toBeVisible();
    await r.page.keyboard.press('Shift');
    await expect(r.page.locator('#spk-warn')).toBeHidden();
  });

  test('the speaker picker only appears where the browser can switch output', async ({ openRadio }) => {
    const r = await openRadio();
    const canSwitch = await r.page.evaluate(() => typeof (AudioContext.prototype as any).setSinkId === 'function');
    await expect(r.page.locator('#spk-row')).toBeVisible({ visible: canSwitch });
  });
});
