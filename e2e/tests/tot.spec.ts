import { test, expect, CH } from '../lib/fixtures';
import { HZ, expectNoTone, expectTone, firstTone, lastTone, now } from '../lib/audio';

// A short time-out timer so the test doesn't hold PTT for a minute. The radio
// warns 5 s before the cutoff, so 8 s puts the warning 3 s in.
test.use({ tot: '8s' });

test('time-out: a warning beep, then an alarm until PTT is released', async ({ openRadio }) => {
  test.slow();
  const rx = await openRadio({ ch: CH.tac1 });
  const tx = await openRadio({ ch: CH.tac1 });

  const t0 = await now(tx.page);
  await tx.hold();
  await expect(tx.status).toHaveText(/^TX/);
  await expectTone(tx.page, HZ.tot, { since: t0, timeout: 6000, message: 'TOT warning beep' });
  const warnAt = (await firstTone(tx.page, HZ.tot, t0))!;
  expect(warnAt - t0).toBeGreaterThan(2500);
  // The warning is a short beep, not the alarm yet.
  await tx.page.waitForTimeout(500);
  await expect(tx.status).toHaveText(/^TX/);
  expect((await lastTone(tx.page, HZ.tot, t0))! - warnAt).toBeLessThan(250);

  await tx.wire.waitFor('tx_end', (m) => m.reason === 'tot', { timeout: 15_000 });
  await expect(tx.status).toHaveText('TIME-OUT');
  await expect(tx.page.locator('#led-tx')).not.toHaveClass(/\bon\b/);
  await expect(rx.status).toHaveText('READY');
  // The alarm keeps sounding while the button stays down.
  const alarmFrom = await now(tx.page);
  await tx.page.waitForTimeout(1500);
  const alarmTo = await now(tx.page);
  expect((await lastTone(tx.page, HZ.tot, alarmFrom))! - ((await firstTone(tx.page, HZ.tot, alarmFrom)) ?? alarmTo)).toBeGreaterThan(1000);

  await tx.release();
  await expect(tx.status).toHaveText('READY');
  const released = await now(tx.page);
  await tx.page.waitForTimeout(600);
  await expectNoTone(tx.page, HZ.tot, released + 200);
});

test('the listener stops hearing a talker who times out', async ({ openRadio }) => {
  test.slow();
  const rx = await openRadio({ ch: CH.tac1 });
  const tx = await openRadio({ ch: CH.tac1 });
  const t0 = await now(rx.page);
  await tx.hold();
  await expectTone(rx.page, HZ.voice, { since: t0 });
  await tx.wire.waitFor('tx_end', (m) => m.reason === 'tot', { timeout: 15_000 });
  await expect(rx.status).toHaveText('READY');
  const cut = await now(rx.page);
  await rx.page.waitForTimeout(1000);
  await expectNoTone(rx.page, HZ.voice, cut + 400);
  await tx.release();
});
