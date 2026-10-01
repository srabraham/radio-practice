import { test, expect, CH, Radio } from '../lib/fixtures';
import { HZ, expectTone, now } from '../lib/audio';

test.describe('power on', () => {
  test('starts audio and the mic from the login click', async ({ openRadio }) => {
    const r = await openRadio();
    // init() doesn't wait for resume(), so the context may still be starting.
    await expect.poll(() => r.audioState()).toBe('running');
    await expect(r.page.locator('#mic-warn')).toBeHidden();
    await expect(r.page.locator('#spk-warn')).toBeHidden();
    await expect(r.page.locator('#me')).toHaveText(r.callsign);
    // A radio with no saved channel starts on the default.
    await expect(r.chname).toHaveText('Control 1');
    await expect(r.status).toHaveText('READY');
  });

  test('a wrong password says so and starts nothing', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Callsign').fill('WRONGPW');
    await page.getByLabel('Password').fill('nope');
    await page.getByRole('button', { name: 'Power on' }).click();
    await expect(page.locator('#login-error')).not.toBeEmpty();
    await expect(page.locator('#radio')).toBeHidden();
    expect(await page.evaluate(() => (window as any).__tap.contexts.length)).toBe(0);
  });

  test('after a reload the session is kept, but sound waits for a click', async ({ openRadio }) => {
    const r = await openRadio({ ch: CH.tac1 });
    await r.page.reload();
    // Browsers only allow audio and the mic after a gesture.
    await expect(r.page.locator('#login')).toBeVisible();
    await expect(r.page.getByLabel('Callsign')).toHaveValue(r.callsign);
    await expect(r.page.locator('#pw-row')).toBeHidden();
    expect(await r.page.evaluate(() => (window as any).__tap.contexts.length)).toBe(0);

    await r.page.getByRole('button', { name: 'Power on' }).click();
    await r.waitOnline();
    await expect.poll(() => r.audioState()).toBe('running');
    // Knobs come back where they were.
    await expect(r.chname).toHaveText('tac 1');
  });

  test('a link with ?p= fills in the password', async ({ page }) => {
    await page.goto('/?p=practice');
    await expect(page.getByLabel('Password')).toHaveValue('practice');
    const r = new Radio(page, 'LINKED');
    await page.getByLabel('Callsign').fill(r.callsign);
    await page.getByRole('button', { name: 'Power on' }).click();
    await r.waitOnline();
  });

  test('a second tab takes the radio over; the first stops receiving', async ({ openRadio }) => {
    const first = await openRadio({ ch: CH.tac1 });
    const second = new Radio(await first.page.context().newPage(), first.callsign);
    await second.page.goto('/');
    await second.page.getByRole('button', { name: 'Power on' }).click();
    await second.waitOnline();
    await expect(first.page.locator('#net')).toContainText('opened in another tab');

    const tx = await openRadio({ ch: CH.tac1 });
    const t0 = await now(second.page);
    const wireT0 = Date.now();
    await tx.talk(1200);
    await expectTone(second.page, HZ.voice, { since: t0 });
    expect(first.wire.audioReceivedSince(wireT0)).toHaveLength(0);
  });

  test('the instructor console needs the instructor password', async ({ page }) => {
    await page.goto('/instructor.html');
    await page.getByLabel('Instructor password').fill('practice');
    await page.getByRole('button', { name: 'Open console' }).click();
    // A participant login just bounces to the radio.
    await expect(page).toHaveURL(/\/$/);
  });
});
