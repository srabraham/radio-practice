import { test, expect, CH } from '../lib/fixtures';
import { HZ, expectNoTone, expectTone, now } from '../lib/audio';

test.describe('app controls', () => {
  test('are hidden until asked for, and the choice is remembered', async ({ openRadio }) => {
    const r = await openRadio();
    await expect(r.controls).toBeHidden();
    await r.showControls();
    await r.page.reload();
    await r.waitOnline();
    await expect(r.controls).toBeVisible();
    await r.page.getByLabel('Show app controls').uncheck();
    await expect(r.controls).toBeHidden();
    await expect.poll(() => r.wire.sentJson.at(-1)?.msg).toEqual({ t: 'watch', on: false });
  });

  test('list everyone with their channel and who is transmitting', async ({ openRadio }) => {
    const me = await openRadio({ ch: CH.control1 });
    const other = await openRadio({ ch: CH.tac1 });
    await me.showControls();
    const mine = me.page.locator('#roster tr', { hasText: me.callsign });
    const theirs = me.page.locator('#roster tr', { hasText: other.callsign });
    await expect(mine).toContainText('(you)');
    await expect(mine).toContainText('CH 4 Control 1');
    await expect(theirs).toContainText('CH 6 tac 1');
    await expect(theirs).not.toContainText('TX');

    await other.hold();
    await expect(theirs).toContainText(/TX \ds/);
    await other.release();
    await expect(theirs).not.toContainText('TX');

    await other.page.getByRole('button', { name: 'Channel up' }).click();
    await expect(theirs).toContainText('CH 7 tac 2');
  });

  test('a message goes to everyone: the log, and a pop-up with a beep', async ({ openRadio }) => {
    const sender = await openRadio();
    const rx = await openRadio();
    await sender.showControls();
    const t0 = await now(rx.page);
    const s0 = await now(sender.page);
    await sender.sendMessage('Radio check, please.');

    await expect(sender.page.locator('#msg-log')).toContainText(`${sender.callsign} Radio check, please.`);
    await expect(sender.page.getByLabel('Message to everyone')).toHaveValue('');
    // No pop-up for your own message.
    await expect(sender.page.locator('#popups .popup')).toHaveCount(0);
    await expectNoTone(sender.page, HZ.message, s0);

    const card = rx.page.locator('#popups .popup');
    await expect(card).toContainText(`From ${sender.callsign}:`);
    await expect(card).toContainText('Radio check, please.');
    await expectTone(rx.page, HZ.message, { since: t0 });
    await card.getByRole('button', { name: 'Dismiss' }).click();
    await expect(card).toHaveCount(0);

    // The log filled in while the column was hidden.
    await rx.showControls();
    await expect(rx.page.locator('#msg-log')).toContainText('Radio check, please.');
  });

  test('a radio that connects later sees earlier messages, without pop-ups', async ({ openRadio }) => {
    const sender = await openRadio();
    await sender.showControls();
    await sender.sendMessage('Net opens at 0900.');
    await expect(sender.page.locator('#msg-log')).toContainText('Net opens at 0900.');

    const late = await openRadio();
    await late.showControls();
    await expect(late.page.locator('#msg-log')).toContainText('Net opens at 0900.');
    await expect(late.page.locator('#popups .popup')).toHaveCount(0);
  });
});
