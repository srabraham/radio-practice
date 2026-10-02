import { test, expect, Radio } from '../lib/fixtures';
import type { WebSocketRoute } from '@playwright/test';

test('a dropped link says so, reconnects, and then says that', async ({ newUser }) => {
  const page = await newUser();
  let down = false;
  let current: WebSocketRoute | undefined;
  await page.routeWebSocket('/ws', (ws) => {
    if (down) {
      ws.close({ code: 1001 });
      return;
    }
    current = ws;
    ws.connectToServer();
  });
  const r = new Radio(page, 'RECON1');
  await r.powerOn();
  const banner = page.locator('#conn');
  await expect(banner).toBeHidden();

  down = true;
  await current!.close({ code: 1001 });
  await expect(banner).toHaveText('Connection lost. Reconnecting…');
  await expect(page.locator('#net')).toHaveText('offline');
  await expect(r.status).toHaveText('NO SIGNAL');
  // It stays up through the failed retries.
  await page.waitForTimeout(1500);
  await expect(banner).toHaveText('Connection lost. Reconnecting…');

  down = false;
  await expect(banner).toHaveText('Reconnected', { timeout: 10_000 });
  await expect(page.locator('#net')).toHaveText('online');
  await r.waitReady();
  await expect(banner).toBeHidden({ timeout: 6000 });
});
