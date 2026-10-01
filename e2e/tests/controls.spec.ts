import { test, expect, CH } from '../lib/fixtures';
import { HZ, expectTone, now } from '../lib/audio';

test.describe('push to talk', () => {
  test('the space bar keys while held', async ({ openRadio }) => {
    const rx = await openRadio({ ch: CH.tac1 });
    const tx = await openRadio({ ch: CH.tac1 });
    const t0 = await now(rx.page);
    await tx.page.keyboard.down('Space');
    await expect(tx.status).toHaveText(/^TX/);
    await expect(tx.ptt).toHaveClass(/\bactive\b/);
    await expectTone(rx.page, HZ.voice, { since: t0 });
    await tx.page.keyboard.up('Space');
    await expect(tx.status).toHaveText('READY');
    await expect(rx.status).toHaveText('READY');
  });

  test('the space bar does not also press the focused button', async ({ openRadio }) => {
    const tx = await openRadio({ ch: CH.tac1 });
    const scan = tx.page.getByRole('button', { name: 'SCAN' });
    await scan.focus();
    await tx.page.keyboard.down('Space');
    await expect(tx.status).toHaveText(/^TX/);
    await tx.page.keyboard.up('Space');
    await expect(tx.status).toHaveText('READY');
    await expect(tx.page.locator('#scan-ind')).toBeHidden();
  });

  test('typing a space in a text field does not key', async ({ openConsole }) => {
    const ctl = await openConsole();
    await ctl.page.locator('#prompt-text').pressSequentially('two words');
    await expect(ctl.page.locator('#prompt-text')).toHaveValue('two words');
    await expect(ctl.txStatus).toHaveText('Ready');
    expect(ctl.wire.sentJson.filter((j) => j.msg.t === 'key')).toHaveLength(0);
  });

  test('tap to talk latches the transmitter on and off', async ({ openRadio, isMobile }) => {
    const rx = await openRadio({ ch: CH.tac1 });
    const tx = await openRadio({ ch: CH.tac1 });
    await tx.page.getByLabel('Tap to talk / tap to stop').check();
    const t0 = await now(rx.page);
    // On phones this is a real touch tap.
    const tap = () => (isMobile ? tx.ptt.tap() : tx.ptt.click());
    await tap();
    await expect(tx.status).toHaveText(/^TX/);
    await expectTone(rx.page, HZ.voice, { since: t0 });
    await tx.page.waitForTimeout(500);
    await expect(tx.status).toHaveText(/^TX/);
    await tap();
    await expect(tx.status).toHaveText('READY');
    await expect(rx.status).toHaveText('READY');
  });

  test('losing focus unkeys a held button, but not a latched one', async ({ openRadio }) => {
    const tx = await openRadio({ ch: CH.tac1 });
    const blur = () => tx.page.evaluate(() => window.dispatchEvent(new Event('blur')));

    await tx.hold();
    await expect(tx.status).toHaveText(/^TX/);
    await blur();
    await expect(tx.status).toHaveText('READY');
    await tx.release();

    await tx.page.getByLabel('Tap to talk / tap to stop').check();
    await tx.ptt.click();
    await expect(tx.status).toHaveText(/^TX/);
    await blur();
    await tx.page.waitForTimeout(300);
    await expect(tx.status).toHaveText(/^TX/);
    await tx.ptt.click();
    await expect(tx.status).toHaveText('READY');
  });

  test('the channel knob turns with buttons and arrow keys, but not mid-transmission', async ({ openRadio }) => {
    const r = await openRadio({ ch: CH.control1 });
    await expect(r.chnum).toHaveText('CH 4');
    await r.page.getByRole('button', { name: 'Channel up' }).click();
    await expect(r.chname).toHaveText('Control 2');
    await r.page.locator('body').focus();
    await r.page.keyboard.press('ArrowLeft');
    await r.page.keyboard.press('ArrowLeft');
    await expect(r.chname).toHaveText('Ranger Admin');
    await expect.poll(() => r.wire.sentJson.at(-1)?.msg).toEqual({ t: 'tune', ch: CH.rangerAdmin });
    // Wraps around from the first channel to the last.
    await r.page.getByRole('button', { name: 'Channel down' }).click();
    await r.page.getByRole('button', { name: 'Channel down' }).click();
    await r.page.getByRole('button', { name: 'Channel down' }).click();
    await expect(r.chnum).toHaveText('CH 10');

    await r.hold();
    await expect(r.status).toHaveText(/^TX/);
    await expect(r.page.getByRole('button', { name: 'Channel up' })).toBeDisabled();
    await r.release();
    await expect(r.page.getByRole('button', { name: 'Channel up' })).toBeEnabled();
  });
});
