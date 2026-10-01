import { test, expect, CH } from '../lib/fixtures';
import { HZ, expectNoTone, expectTone, lastTone, noiseSamples, now } from '../lib/audio';

test.describe('instructor console', () => {
  test('hears every channel cleanly, with caller ID', async ({ openRadio, openConsole }) => {
    const ctl = await openConsole();
    const tx = await openRadio({ ch: CH.tac1 });
    const t0 = await now(ctl.page);
    await tx.hold();
    await expectTone(ctl.page, HZ.voice, { since: t0 });
    // Even on analog simplex, where radios get no caller ID.
    await expect(ctl.hearing).toContainText(`CH6 tac 1: ${tx.callsign}`);
    await expect(ctl.page.locator('#ch-act-5')).toContainText(tx.callsign);
    await ctl.page.waitForTimeout(800);
    await tx.release();
    await expect(ctl.hearing).toHaveText('');
    await ctl.page.waitForTimeout(500);
    // Clean monitor: no squelch tail.
    const end = (await lastTone(ctl.page, HZ.voice, t0))!;
    expect(await noiseSamples(ctl.page, end + 40, end + 400, -75)).toBeLessThanOrEqual(2);
  });

  test('an unmonitored channel is not heard', async ({ openRadio, openConsole }) => {
    const ctl = await openConsole();
    await ctl.page.locator('#ch-row-5').getByRole('checkbox').uncheck();
    await expect.poll(() => ctl.wire.sentJson.at(-1)?.msg).toMatchObject({ t: 'monitor' });
    const tx = await openRadio({ ch: CH.tac1 });
    const t0 = await now(ctl.page);
    await tx.hold();
    // The activity panel still shows who is talking; it just isn't played.
    await expect(ctl.page.locator('#ch-act-5')).toContainText(tx.callsign);
    await ctl.page.waitForTimeout(1200);
    await tx.release();
    await expectNoTone(ctl.page, HZ.voice, t0);
    await expect(ctl.hearing).toHaveText('');
  });

  test('transmits as Control on a repeater, with the permit chirp', async ({ openRadio, openConsole }) => {
    const rx = await openRadio({ ch: CH.control1 });
    const ctl = await openConsole({ mic: { freq: HZ.voice2 } });
    // The console starts on the radios' default channel.
    await expect(ctl.page.locator('#tx-ch')).toHaveValue(String(CH.control1));
    const ctlT0 = await now(ctl.page);
    const rxT0 = await now(rx.page);
    await ctl.hold();
    await expect(ctl.txStatus).toHaveText('Transmitting');
    await expectTone(ctl.page, HZ.permitHi, { since: ctlT0 });
    await expect(rx.status).toHaveText(`RX ${ctl.callsign}`);
    await expectTone(rx.page, HZ.voice2, { since: rxT0 });
    await ctl.release();
    await expect(ctl.txStatus).toHaveText('Ready');
  });

  test('Voice of God cuts off repeater talkers, who hear Control instead', async ({ openRadio, openConsole }) => {
    const talker = await openRadio({ ch: CH.control1 });
    const elsewhere = await openRadio({ ch: CH.brc911 });
    const simplex = await openRadio({ ch: CH.tac1 });
    const ctl = await openConsole({ mic: { freq: HZ.voice2 } });

    await talker.hold();
    await talker.wire.waitFor('tx_ok');
    const t0 = await now(talker.page);
    const elsewhereT0 = await now(elsewhere.page);
    const simplexT0 = await now(simplex.page);

    await ctl.transmitOn('vog');
    await ctl.hold({ via: 'key' });
    await expect(ctl.txStatus).toHaveText('Voice of God: transmitting on every repeater');
    await talker.wire.waitFor('tx_end', (m) => m.reason === 'vog');
    await expectTone(talker.page, HZ.busyHi, { since: t0, message: 'preempted bonk' });
    // Still holding PTT, but receiving Control.
    await expectTone(talker.page, HZ.voice2, { since: t0 });
    await expect(talker.status).toHaveText(`RX ${ctl.callsign}`);
    await expectTone(elsewhere.page, HZ.voice2, { since: elsewhereT0 });
    await expect(elsewhere.status).toHaveText(`RX ${ctl.callsign}`);

    await ctl.release();
    await expect(talker.status).toHaveText('PREEMPTED');
    await talker.release();
    await expect(talker.status).toHaveText('READY');
    await expectNoTone(simplex.page, HZ.voice2, simplexT0);
    await expect(simplex.status).toHaveText('READY');
  });

  test('force-unkeys a stuck mic', async ({ openRadio, openConsole }) => {
    const stuck = await openRadio({ ch: CH.tac1 });
    const ctl = await openConsole();
    // Latched, as if someone walked away transmitting.
    await stuck.page.getByLabel('Tap to talk / tap to stop').check();
    await stuck.ptt.click();
    await expect(stuck.status).toHaveText(/^TX/);

    const row = ctl.page.locator('#roster tr', { hasText: stuck.callsign });
    await expect(row).toContainText('TX');
    const t0 = await now(stuck.page);
    await row.getByRole('button', { name: 'Cut' }).click();

    await expect(stuck.status).toHaveText('CUT BY CONTROL');
    await expectTone(stuck.page, HZ.tot, { since: t0, message: 'cut alarm' });
    await expect(row).not.toContainText('TX');
    await stuck.page.waitForTimeout(1000);
    // The alarm keeps going until the user acknowledges by pressing PTT.
    expect((await lastTone(stuck.page, HZ.tot, t0))!).toBeGreaterThan((await now(stuck.page)) - 200);
    await stuck.ptt.click();
    await expect(stuck.status).toHaveText('READY');
    const stopped = await now(stuck.page);
    await stuck.page.waitForTimeout(500);
    await expectNoTone(stuck.page, HZ.tot, stopped + 200);
  });

  test('a prompt pops up with a beep on the chosen radio only', async ({ openRadio, openConsole }) => {
    const target = await openRadio();
    const bystander = await openRadio();
    const ctl = await openConsole();
    await ctl.page.locator('#prompt-to').selectOption({ label: target.callsign });
    await ctl.page.locator('#prompt-text').fill('Radio check, please.');
    const t0 = await now(target.page);
    const t1 = await now(bystander.page);
    await ctl.page.getByRole('button', { name: 'Send prompt' }).click();

    const card = target.page.locator('#prompts .prompt');
    await expect(card).toContainText('Radio check, please.');
    await expect(card).toContainText(`From ${ctl.callsign}:`);
    await expectTone(target.page, HZ.prompt, { since: t0 });
    await card.getByRole('button', { name: 'Dismiss' }).click();
    await expect(card).toHaveCount(0);

    await bystander.page.waitForTimeout(500);
    await expect(bystander.page.locator('#prompts .prompt')).toHaveCount(0);
    await expectNoTone(bystander.page, HZ.prompt, t1);
  });

  test('flags two simplex talkers at once as DOUBLED', async ({ openRadio, openConsole }) => {
    const ctl = await openConsole();
    const a = await openRadio({ ch: CH.tac1 });
    const b = await openRadio({ ch: CH.tac1, mic: { freq: HZ.voice2 } });
    await a.hold();
    await b.hold({ via: 'key' });
    await expect(ctl.page.locator('#ch-act-5')).toContainText('DOUBLED');
    await expect(ctl.hearing).toContainText(a.callsign);
    await expect(ctl.hearing).toContainText(b.callsign);
    await b.release();
    await a.release();
    await expect(ctl.page.locator('#ch-act-5')).toHaveText('idle');
  });
});
