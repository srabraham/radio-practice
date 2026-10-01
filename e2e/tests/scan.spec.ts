import { test, expect, CH } from '../lib/fixtures';
import { HZ, expectTone, now } from '../lib/audio';

test.describe('scan', () => {
  test('stops on a busy channel, and PTT during hang time talks back there', async ({ openRadio }) => {
    const scanner = await openRadio({ ch: CH.control1, scan: true, mic: { freq: HZ.voice2 } });
    const other = await openRadio({ ch: CH.tac1 });
    await expect(scanner.status).toHaveText('SCANNING');
    await expect(scanner.page.locator('#scan-ind')).toBeVisible();

    const t0 = await now(scanner.page);
    await other.hold();
    await expectTone(scanner.page, HZ.voice, { since: t0 });
    // The display follows the channel it stopped on.
    await expect(scanner.chnum).toHaveText('CH 6');
    await expect(scanner.chname).toHaveText('tac 1');
    await expect(scanner.status).toHaveText('RX');
    await other.release();
    await expect(scanner.status).toHaveText('READY');

    // Within the 3 s hang time, a reply goes out on tac 1, not Control 1.
    const otherT0 = await now(other.page);
    await scanner.hold();
    await expect(scanner.wire.sentJson.at(-1)?.msg).toMatchObject({ t: 'key', ch: CH.tac1 });
    await expectTone(other.page, HZ.voice2, { since: otherT0 });
    await scanner.release();

    // After the hang time it goes back to scanning from its home channel.
    await expect(scanner.status).toHaveText('SCANNING', { timeout: 6000 });
    await expect(scanner.chname).toHaveText('Control 1');
  });

  test('turning scan off keeps it on its own channel', async ({ openRadio }) => {
    const scanner = await openRadio({ ch: CH.control1, scan: true });
    const other = await openRadio({ ch: CH.tac1 });
    await scanner.page.getByRole('button', { name: 'SCAN' }).click();
    await expect(scanner.page.locator('#scan-ind')).toBeHidden();
    await expect(scanner.status).toHaveText('READY');
    const wireT0 = Date.now();
    await other.talk(1000);
    expect(scanner.wire.audioReceivedSince(wireT0)).toHaveLength(0);
    await expect(scanner.chname).toHaveText('Control 1');
  });
});
