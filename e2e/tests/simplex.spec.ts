import { test, expect, CH } from '../lib/fixtures';
import { HZ, concat, decodeUlaw, expectNoTone, expectTone, firstTone, lastTone, maxFloor, noiseSamples, now, rmsDb, toneSamples, toneShare } from '../lib/audio';

test.describe('analog FM simplex', () => {
  test('a listener hears the talker, then a squelch tail, then silence', async ({ openRadio }) => {
    const rx = await openRadio({ ch: CH.tac1 });
    const tx = await openRadio({ ch: CH.tac1 });
    await expect(rx.chname).toHaveText('tac 1');
    await expect(rx.page.locator('#mode')).toHaveText('FM');

    const t0 = await now(rx.page);
    await tx.hold();
    // Simplex keys instantly: no waiting for a repeater.
    await expect(tx.status).toHaveText(/^TX 0:0\d$/);
    await expect(tx.page.locator('#led-tx')).toHaveClass(/\bon\b/);
    await expectTone(rx.page, HZ.voice, { since: t0 });
    // Analog FM has no caller ID.
    await expect(rx.status).toHaveText('RX');
    await expect(rx.page.locator('#led-rx')).toHaveClass(/\bon\b/);
    await rx.page.waitForTimeout(800);
    await tx.release();

    await expect(rx.status).toHaveText('READY');
    await expect(rx.page.locator('#led-rx')).not.toHaveClass(/\bon\b/);
    await rx.page.waitForTimeout(600);
    const end = (await lastTone(rx.page, HZ.voice, t0))!;
    // The carrier drops before the squelch closes: a burst of noise right
    // after the voice, louder than the open-squelch hiss under it.
    const hissUnderVoice = await maxFloor(rx.page, end - 300, end - 100);
    expect(await maxFloor(rx.page, end, end + 300)).toBeGreaterThan(hissUnderVoice + 5);
    expect(await noiseSamples(rx.page, end + 400)).toBe(0);
  });

  test('what the talker sends is the mic, band-limited and μ-law encoded', async ({ openRadio }) => {
    await openRadio({ ch: CH.tac1 });
    const tx = await openRadio({ ch: CH.tac1 });
    const t0 = Date.now();
    await tx.talk(1000);
    const frames = tx.wire.audioSentSince(t0);
    // 20 ms frames: about 50 a second.
    expect(frames.length).toBeGreaterThan(35);
    expect(frames.length).toBeLessThan(70);
    for (const f of frames) expect(f.length).toBe(160);
    const pcm = decodeUlaw(concat(frames.slice(10)));
    expect(rmsDb(pcm)).toBeGreaterThan(-30);
    expect(toneShare(pcm, HZ.voice)).toBeGreaterThan(0.8);
    // Nothing goes out once PTT is released.
    const after = Date.now();
    await tx.page.waitForTimeout(400);
    expect(tx.wire.audioSentSince(after + 100)).toHaveLength(0);
  });

  test('a transmitting radio hears nothing (half duplex)', async ({ openRadio }) => {
    const a = await openRadio({ ch: CH.tac1 });
    const b = await openRadio({ ch: CH.tac1, mic: { freq: HZ.voice2 } });
    await a.hold();
    await expect(a.status).toHaveText(/^TX/);
    await b.hold({ via: 'key' });
    await expect(b.status).toHaveText(/^TX/);
    const keyed = await now(b.page);
    await b.page.waitForTimeout(1200);
    await b.release();
    await a.release();
    // Frames already queued before the server saw b key can still arrive, but
    // none between b's tx_ok and b letting go (allowing for WebKit reporting a
    // binary frame a little late).
    const ok = b.wire.firstReceived('tx_ok')!;
    const unkey = b.wire.sentJson.find((j) => j.msg.t === 'unkey')!;
    expect(b.wire.rxAudio.filter((f) => f.at > ok.at + 150 && f.at < unkey.at)).toHaveLength(0);
    // Allow for what was already in the jitter buffer when b keyed.
    await expectNoTone(b.page, HZ.voice, keyed + 300, keyed + 1100);
  });

  test('two talkers at once double: the listener hears both, garbled', async ({ openRadio }) => {
    const rx = await openRadio({ ch: CH.tac1 });
    const a = await openRadio({ ch: CH.tac1 });
    const b = await openRadio({ ch: CH.tac1, mic: { freq: HZ.voice2 } });

    const t0 = await now(rx.page);
    await a.hold();
    await expectTone(rx.page, HZ.voice, { since: t0 });
    await rx.page.waitForTimeout(700);
    const single = [await now(rx.page) - 500, await now(rx.page)] as const;

    await b.hold({ via: 'key' });
    await expectTone(rx.page, HZ.voice2, { since: single[1] });
    await rx.page.waitForTimeout(1000);
    const t2 = await now(rx.page);
    await a.release();
    await b.release();

    const both = [t2 - 700, t2] as const;
    expect(await toneSamples(rx.page, HZ.voice, ...both)).toBeGreaterThan(10);
    expect(await toneSamples(rx.page, HZ.voice2, ...both)).toBeGreaterThan(10);
    // Neither carrier captures the receiver: extra hiss and a heterodyne.
    expect(await maxFloor(rx.page, ...both)).toBeGreaterThan((await maxFloor(rx.page, ...single)) + 6);
  });

  test('a radio on another channel hears nothing', async ({ openRadio }) => {
    const other = await openRadio({ ch: CH.tac2 });
    const tx = await openRadio({ ch: CH.tac1 });
    const t0 = await now(other.page);
    const wireT0 = Date.now();
    await tx.talk(1200);
    await other.page.waitForTimeout(300);
    expect(other.wire.audioReceivedSince(wireT0)).toHaveLength(0);
    expect(await firstTone(other.page, HZ.voice, t0)).toBeNull();
    await expect(other.status).toHaveText('READY');
  });

  test('tuning to a channel mid-call joins the call in progress', async ({ openRadio }) => {
    const rx = await openRadio({ ch: CH.tac2 });
    const tx = await openRadio({ ch: CH.tac1 });
    await tx.hold({ via: 'key' });
    await expect(tx.status).toHaveText(/^TX/);
    const t0 = await now(rx.page);
    await rx.page.getByRole('button', { name: 'Channel down' }).click();
    await expect(rx.chname).toHaveText('tac 1');
    await expectTone(rx.page, HZ.voice, { since: t0 });
    await expect(rx.status).toHaveText('RX');
    await tx.release();
  });
});
