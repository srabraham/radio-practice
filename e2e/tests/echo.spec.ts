import { test, expect, CH } from '../lib/fixtures';
import { HZ, expectTone, firstTone, lastTone, maxFloor, now, toneSamples } from '../lib/audio';

test.describe('echo channel', () => {
  test('Echobot plays the transmission back to everyone a second after it ends', async ({ openRadio }) => {
    const rx = await openRadio({ ch: CH.echo });
    const tx = await openRadio({ ch: CH.echo });
    await expect(rx.chname).toHaveText('echo');
    await expect(rx.page.locator('#mode')).toHaveText('FM');

    const t0 = await now(rx.page);
    await tx.talk(1000);
    await expectTone(rx.page, HZ.voice, { since: t0 });
    const released = await now(tx.page);

    // The talker hears itself, after the quiet gap, through the same FM
    // receive path as anyone else.
    await expectTone(tx.page, HZ.voice, { since: released });
    expect((await firstTone(tx.page, HZ.voice, released))!).toBeGreaterThan(released + 800);
    await expect(tx.status).toHaveText('RX');
    await expect(tx.status).toHaveText('READY');

    // The listener hears it twice: live, then the echo.
    const liveEnd = (await lastTone(rx.page, HZ.voice, t0, released + 500))!;
    const echo = (await firstTone(rx.page, HZ.voice, liveEnd + 500))!;
    expect(echo).not.toBeNull();
    await rx.page.waitForTimeout(300);
    expect(await toneSamples(rx.page, HZ.voice, echo, echo + 800)).toBeGreaterThan(10);
  });

  test('a double is echoed as a double', async ({ openRadio }) => {
    const rx = await openRadio({ ch: CH.echo });
    const a = await openRadio({ ch: CH.echo });
    const b = await openRadio({ ch: CH.echo, mic: { freq: HZ.voice2 } });

    const t0 = await now(rx.page);
    await a.hold();
    await expectTone(rx.page, HZ.voice, { since: t0 });
    await rx.page.waitForTimeout(700);
    const bAt = await now(rx.page);
    await b.hold({ via: 'key' });
    await expectTone(rx.page, HZ.voice2, { since: bAt });
    await rx.page.waitForTimeout(1000);
    await a.release();
    await b.release();
    const released = await now(rx.page);

    await expectTone(rx.page, HZ.voice2, { since: released + 500 });
    await rx.page.waitForTimeout(1000);
    // The echo keeps the live timing: ALPHA alone, then both.
    const echo = (await firstTone(rx.page, HZ.voice, released + 500))!;
    const doubleAt = echo + (bAt - (await firstTone(rx.page, HZ.voice, t0))!);
    const single = [echo + 100, doubleAt - 100] as const;
    const both = [doubleAt + 400, doubleAt + 900] as const;
    expect(await toneSamples(rx.page, HZ.voice2, ...single)).toBe(0);
    expect(await toneSamples(rx.page, HZ.voice, ...both)).toBeGreaterThan(10);
    expect(await toneSamples(rx.page, HZ.voice2, ...both)).toBeGreaterThan(10);
    // Garbled the same way: extra hiss and a heterodyne.
    expect(await maxFloor(rx.page, ...both)).toBeGreaterThan((await maxFloor(rx.page, ...single)) + 6);
  });
});
