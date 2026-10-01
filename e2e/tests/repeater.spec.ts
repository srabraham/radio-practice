import { test, expect, CH } from '../lib/fixtures';
import { HZ, expectNoTone, expectTone, firstTone, lastTone, noiseSamples, now } from '../lib/audio';

test.describe('digital repeater', () => {
  test('keying waits for the talk-permit chirp; audio flows after the repeater delay', async ({ openRadio }) => {
    const rx = await openRadio({ ch: CH.control1 });
    const tx = await openRadio({ ch: CH.control1 });
    await expect(tx.page.locator('#mode')).toHaveText('DIG');

    const txT0 = await now(tx.page);
    const rxT0 = await now(rx.page);
    await tx.hold();
    const keyedAt = Date.now();
    await tx.wire.waitFor('tx_ok');
    await expectTone(tx.page, HZ.permitLo, { since: txT0, message: 'talk-permit chirp, low half' });
    await expectTone(tx.page, HZ.permitHi, { since: txT0, message: 'talk-permit chirp, high half' });
    await expect(tx.status).toHaveText(/^TX 0:0\d$/);

    // Digital radios show who is talking.
    await expect(rx.status).toHaveText(`RX ${tx.callsign}`);
    await expectTone(rx.page, HZ.voice, { since: rxT0 });
    await rx.page.waitForTimeout(600);
    await tx.release();
    await expect(rx.status).toHaveText('READY');

    // The repeater drops the first second (key-up latency), so anything said
    // right after pressing is lost, as on a real repeater.
    const heardAt = (await firstTone(rx.page, HZ.voice, rxT0))!;
    expect(heardAt - keyedAt).toBeGreaterThan(900);
  });

  test('a second talker gets a busy bonk and is not heard', async ({ openRadio }) => {
    const rx = await openRadio({ ch: CH.control1 });
    const a = await openRadio({ ch: CH.control1 });
    const b = await openRadio({ ch: CH.control1, mic: { freq: HZ.voice2 } });

    await a.hold();
    await a.wire.waitFor('tx_ok');
    const bT0 = await now(b.page);
    const rxT0 = await now(rx.page);
    await b.hold({ via: 'key' });
    await b.wire.waitFor('tx_deny');
    await expect(b.status).toHaveText('CHANNEL BUSY');
    await expectTone(b.page, HZ.busyHi, { since: bT0, message: 'busy bonk, first note' });
    await expectTone(b.page, HZ.busyLo, { since: bT0, message: 'busy bonk, second note' });
    await expect(b.page.locator('#led-tx')).not.toHaveClass(/\bon\b/);
    await b.page.waitForTimeout(600);
    // Once PTT is released the denied radio is back to receiving.
    const released = await now(b.page);
    await b.release();
    await expect(b.status).toHaveText(`RX ${a.callsign}`);
    await expectTone(b.page, HZ.voice, { since: released });
    await a.release();

    // The repeater never let b through: no call from b reached the listener.
    expect(rx.wire.received('rx_start').map((m) => m.from)).not.toContain(b.callsign);
    await expectNoTone(rx.page, HZ.voice2, rxT0);
    await expect(b.status).toHaveText('READY');
  });

  test('the floor frees up when the talker lets go', async ({ openRadio }) => {
    const rx = await openRadio({ ch: CH.control1 });
    const a = await openRadio({ ch: CH.control1 });
    const b = await openRadio({ ch: CH.control1, mic: { freq: HZ.voice2 } });
    await a.talk(500);
    await expect(rx.status).toHaveText('READY');
    const t0 = await now(rx.page);
    await b.hold();
    await b.wire.waitFor('tx_ok');
    await expect(rx.status).toHaveText(`RX ${b.callsign}`);
    await expectTone(rx.page, HZ.voice2, { since: t0 });
    await b.release();
  });

  test('no hiss and no squelch tail on a digital channel', async ({ openRadio }) => {
    const rx = await openRadio({ ch: CH.control1 });
    const tx = await openRadio({ ch: CH.control1 });
    const t0 = await now(rx.page);
    await tx.hold();
    await expectTone(rx.page, HZ.voice, { since: t0 });
    await rx.page.waitForTimeout(800);
    await tx.release();
    await expect(rx.status).toHaveText('READY');
    await rx.page.waitForTimeout(500);
    const end = (await lastTone(rx.page, HZ.voice, t0))!;
    // A couple of samples can straddle the end of the tone; a squelch tail
    // would add many more.
    expect(await noiseSamples(rx.page, end + 40, end + 400, -75)).toBeLessThanOrEqual(2);
  });
});
