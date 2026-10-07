import { test, expect, CH } from '../lib/fixtures';
import { HZ, expectNoTone, expectTone, now } from '../lib/audio';

test.describe('Voice of God', () => {
  test('is the last channel on the knob, labelled ALL REPEATERS', async ({ openRadio }) => {
    const r = await openRadio({ ch: CH.voiceOfGod });
    await expect(r.chnum).toHaveText('CH 12');
    await expect(r.chname).toHaveText('Voice of God');
    await expect(r.page.locator('#chsub')).toHaveText('ALL REPEATERS');
    await r.page.getByRole('button', { name: 'Channel up' }).click();
    await expect(r.chnum).toHaveText('CH 1');
    await expect(r.page.locator('#chsub')).toBeHidden();
  });

  test('cuts off repeater talkers, who hear it instead', async ({ openRadio }) => {
    const talker = await openRadio({ ch: CH.control1 });
    const elsewhere = await openRadio({ ch: CH.brc911 });
    const simplex = await openRadio({ ch: CH.tac1 });
    const god = await openRadio({ ch: CH.voiceOfGod, mic: { freq: HZ.voice2 } });

    await talker.hold();
    await talker.wire.waitFor('tx_ok');
    const t0 = await now(talker.page);
    const godT0 = await now(god.page);
    const elsewhereT0 = await now(elsewhere.page);
    const simplexT0 = await now(simplex.page);

    // Firefox shares one mouse across pages, and the talker is holding it.
    await god.hold({ via: 'key' });
    await expectTone(god.page, HZ.permitHi, { since: godT0, message: 'talk-permit chirp' });
    await expect(god.status).toHaveText(/^TX/);
    await talker.wire.waitFor('tx_end', (m) => m.reason === 'vog');
    await expectTone(talker.page, HZ.busyHi, { since: t0, message: 'preempted bonk' });
    // Still holding PTT, but receiving Voice of God.
    await expectTone(talker.page, HZ.voice2, { since: t0 });
    await expect(talker.status).toHaveText(`RX ${god.callsign}`);
    await expectTone(elsewhere.page, HZ.voice2, { since: elsewhereT0 });
    await expect(elsewhere.status).toHaveText(`RX ${god.callsign}`);

    await god.release();
    await expect(talker.status).toHaveText('PREEMPTED');
    await talker.release();
    await expect(talker.status).toHaveText('READY');
    await expectNoTone(simplex.page, HZ.voice2, simplexT0);
    await expect(simplex.status).toHaveText('READY');
  });

  test('listening on it hears every repeater, with caller ID, but not simplex', async ({ openRadio }) => {
    const listener = await openRadio({ ch: CH.voiceOfGod });
    const rptr = await openRadio({ ch: CH.brc911 });
    const simplex = await openRadio({ ch: CH.tac1, mic: { freq: HZ.voice2 } });

    const t0 = await now(listener.page);
    await rptr.hold();
    await expect(listener.status).toHaveText(`RX ${rptr.callsign}`);
    await expectTone(listener.page, HZ.voice, { since: t0 });
    await expect(listener.chname).toHaveText('Voice of God');
    await rptr.release();
    await expect(listener.status).toHaveText('READY');

    const wireT0 = Date.now();
    await simplex.talk(1200);
    expect(listener.wire.audioReceivedSince(wireT0)).toHaveLength(0);
    await expect(listener.status).toHaveText('READY');
  });
});
