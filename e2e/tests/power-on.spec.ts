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

  test('after a reload the radio comes straight back', async ({ openRadio }) => {
    const r = await openRadio({ ch: CH.tac1 });
    await r.page.reload();
    await r.waitOnline();
    await expect(r.page.locator('#login')).toBeHidden();
    await expect(r.page).toHaveURL(/\/\?p=practice$/);
    // Knobs come back where they were.
    await expect(r.chname).toHaveText('tac 1');
  });

  test('the address bar shows the password after logging in', async ({ openRadio }) => {
    const r = await openRadio();
    await expect(r.page).toHaveURL(/\/\?p=practice$/);
  });

  test('a link with ?p= fills in the password', async ({ page }) => {
    await page.goto('/?p=practice');
    await expect(page.getByLabel('Password')).toHaveValue('practice');
    await expect(page.getByLabel('Callsign')).toHaveValue('');
    const r = new Radio(page, 'LINKED');
    await page.getByLabel('Callsign').fill(r.callsign);
    await page.getByRole('button', { name: 'Power on' }).click();
    await r.waitOnline();
  });

  test('a link with ?p= and a saved callsign goes right in', async ({ newUser }) => {
    const page = await newUser();
    await page.addInitScript(() => localStorage.setItem('rp.callsign', 'SAVED1'));
    const r = new Radio(page, 'SAVED1');
    await page.goto('/?p=practice');
    await r.waitOnline();
    await expect(page.locator('#me')).toHaveText('SAVED1');
  });

  test('a link with a wrong password and a saved callsign shows the card', async ({ newUser }) => {
    const page = await newUser();
    await page.addInitScript(() => localStorage.setItem('rp.callsign', 'SAVED2'));
    await page.goto('/?p=nope');
    await expect(page.locator('#login-error')).toHaveText('wrong password');
    await expect(page.getByLabel('Callsign')).toHaveValue('SAVED2');
    await expect(page.getByLabel('Password')).toHaveValue('nope');
    await expect(page.locator('#radio')).toBeHidden();
  });

  test('logging out keeps the password but forgets the callsign', async ({ openRadio }) => {
    const r = await openRadio();
    await r.page.getByRole('link', { name: 'Log out' }).click();
    await expect(r.page.getByRole('button', { name: 'Power on' })).toBeVisible();
    await expect(r.page).toHaveURL(/\/\?p=practice$/);
    await expect(r.page.getByLabel('Password')).toHaveValue('practice');
    await expect(r.page.getByLabel('Callsign')).toHaveValue('');
  });


  test('a second tab takes the radio over; the first stops receiving', async ({ openRadio }) => {
    const first = await openRadio({ ch: CH.tac1 });
    const second = new Radio(await first.page.context().newPage(), first.callsign);
    await second.page.goto('/');
    await second.waitOnline();
    await expect(first.page.locator('#net')).toContainText('opened in another tab');
    await expect(first.status).toHaveText('NO SIGNAL');

    const tx = await openRadio({ ch: CH.tac1 });
    const t0 = await now(second.page);
    const wireT0 = Date.now();
    await tx.talk(1200);
    await expectTone(second.page, HZ.voice, { since: t0 });
    expect(first.wire.audioReceivedSince(wireT0)).toHaveLength(0);
  });



  test('the old console URL redirects to the radio page', async ({ page }) => {
    await page.goto('/instructor.html');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('button', { name: 'Power on' })).toBeVisible();
  });
});
